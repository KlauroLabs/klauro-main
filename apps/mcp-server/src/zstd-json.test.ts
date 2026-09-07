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
  const longValue = 'value\\n\\t\\u0000\\u00e9\\ud834\\udd1e"\\\\'.repeat(12_000);
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

async function zstdAvailable(): Promise<boolean> {
  return execFileAsync('zstd', ['--version']).then(() => true, () => false);
}
