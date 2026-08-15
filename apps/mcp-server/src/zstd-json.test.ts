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

async function zstdAvailable(): Promise<boolean> {
  return execFileAsync('zstd', ['--version']).then(() => true, () => false);
}
