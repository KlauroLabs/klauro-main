import assert from 'node:assert/strict';
import { execFile } from 'child_process';
import { test } from 'node:test';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'util';
import { readZstdJson } from './zstd-json';

const execFileAsync = promisify(execFile);

test('readZstdJson reconstructs compressed JSON through buffered and streaming parsers', async t => {
  if (!(await zstdAvailable())) return t.skip('zstd is unavailable');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-zstd-json-'));
  const source = path.join(root, 'source.json');
  const compressed = path.join(root, 'source.json.zst');
  const value = { rows: Array.from({ length: 20_000 }, (_, index) => ({ index, value: `row-${index}` })) };
  try {
    await fs.writeJson(source, value);
    await execFileAsync('zstd', ['-q', '-f', source, '-o', compressed]);
    assert.deepEqual(await readZstdJson(compressed, { maxBufferedCompressedBytes: Number.MAX_SAFE_INTEGER }), value);
    assert.deepEqual(await readZstdJson(compressed, { maxBufferedCompressedBytes: 0 }), value);
    assert.deepEqual(await readZstdJson(compressed), value);
  } finally {
    await fs.remove(root);
  }
});

test('streaming JSON preserves packed values across chunk boundaries', async t => {
  if (!(await zstdAvailable())) return t.skip('zstd is unavailable');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-zstd-values-'));
  const source = path.join(root, 'source.json');
  const compressed = path.join(root, 'source.json.zst');
  const longKey = 'key'.repeat(24_000);
  const longValue = ('value"\\' + String.fromCodePoint(0, 9, 10, 0xe9, 0x1d11e)).repeat(12_000);
  const values = [
    { [longKey]: longValue, empty: '', nullable: null, enabled: false, rows: [[], {}, [1, -2.5, 1e100, 1e-100]] },
    longValue,
    '',
    false,
    true,
    0,
    -123.456,
    [],
    {},
  ];
  try {
    for (const value of values) {
      await fs.writeJson(source, value);
      await execFileAsync('zstd', ['-q', '-f', source, '-o', compressed]);
      const buffered = await readZstdJson(compressed, { maxBufferedCompressedBytes: Number.MAX_SAFE_INTEGER });
      const streamed = await readZstdJson(compressed, { maxBufferedCompressedBytes: 0 });
      assert.deepEqual(buffered, value);
      assert.deepEqual(streamed, buffered);
    }
  } finally {
    await fs.remove(root);
  }
});

test('streaming JSON rejects incomplete packed values', async t => {
  if (!(await zstdAvailable())) return t.skip('zstd is unavailable');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-zstd-invalid-'));
  const source = path.join(root, 'source.json');
  const compressed = path.join(root, 'source.json.zst');
  try {
    for (const value of ['{"key":"unfinished', '{"key":1e', '[true,', '{"key":}']) {
      await fs.writeFile(source, value);
      await execFileAsync('zstd', ['-q', '-f', source, '-o', compressed]);
      await assert.rejects(readZstdJson(compressed, { maxBufferedCompressedBytes: Number.MAX_SAFE_INTEGER }));
      await assert.rejects(readZstdJson(compressed, { maxBufferedCompressedBytes: 0 }));
    }
  } finally {
    await fs.remove(root);
  }
});

test('topLevelKeys projection streams only the requested top-level subtrees', async t => {
  if (!(await zstdAvailable())) return t.skip('zstd is unavailable');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-zstd-project-'));
  const source = path.join(root, 'source.json');
  const compressed = path.join(root, 'source.json.zst');
  const value = {
    zeta: { entities: [{ id: 'nested-entities-inside-dropped-key' }], rows: Array.from({ length: 5_000 }, (_, index) => index) },
    entities: [{ id: 'entity', nested: { intents: ['kept-nested-key-inside-kept-subtree'] } }],
    intents: Array.from({ length: 5_000 }, (_, index) => ({ index })),
    alpha: 'first-declared-after-projection',
    system: { name: 'member', flows: [{ id: 'flow-inside-system' }] },
    empty: {},
  };
  try {
    await fs.writeJson(source, value);
    await execFileAsync('zstd', ['-q', '-f', source, '-o', compressed]);
    const projected = await readZstdJson(compressed, { topLevelKeys: ['entities', 'system', 'alpha', 'absent'] });
    assert.deepEqual(Object.keys(projected), ['entities', 'alpha', 'system']);
    assert.deepEqual(projected.entities, value.entities);
    assert.deepEqual(projected.system, value.system);
    assert.equal(projected.alpha, value.alpha);
    assert.equal('zeta' in projected, false);
    assert.equal('intents' in projected, false);
    assert.equal('absent' in projected, false);
    assert.deepEqual(await readZstdJson(compressed, { topLevelKeys: [] }), {});
    assert.deepEqual(await readZstdJson(compressed), value);
    assert.deepEqual(await readZstdJson(compressed, { maxBufferedCompressedBytes: 0 }), value);
    await fs.writeJson(source, [1, 2, 3]);
    await execFileAsync('zstd', ['-q', '-f', source, '-o', compressed]);
    assert.deepEqual(await readZstdJson(compressed, { topLevelKeys: ['entities'] }), []);
    for (const truncated of ['{"entities":[{"id":"x"}],"intents":[1,2', '{"entities":[{"id":"x"', '{"entities":}']) {
      await fs.writeFile(source, truncated);
      await execFileAsync('zstd', ['-q', '-f', source, '-o', compressed]);
      await assert.rejects(readZstdJson(compressed, { topLevelKeys: ['entities'] }));
    }
  } finally {
    await fs.remove(root);
  }
});

async function zstdAvailable(): Promise<boolean> {
  return execFileAsync('zstd', ['--version']).then(() => true, () => false);
}
