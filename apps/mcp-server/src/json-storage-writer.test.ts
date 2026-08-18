import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { writeJsonAtomic } from './json-storage-writer';

test('streamed atomic JSON writes preserve large graph-shaped values', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-json-writer-'));
  const file = path.join(directory, 'analysis.json');
  const value = {
    nodes: Array.from({ length: 12_000 }, (_, index) => ({ id: `node-${index}`, metadata: { index, active: index % 2 === 0 } })),
    edges: Array.from({ length: 12_000 }, (_, index) => ({ source: `node-${index}`, target: `node-${(index + 1) % 12_000}` })),
  };
  try {
    await writeJsonAtomic(file, value, { spaces: 0 });
    assert.deepEqual(await fs.readJson(file), value);
  } finally {
    await fs.remove(directory);
  }
});
