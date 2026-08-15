import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { readStreamingGzipJson, writeStreamingGzipJson } from './streaming-gzip-json';

test('streaming gzip JSON round-trips graph-shaped values without whole-document serialization', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-streaming-gzip-'));
  const file = path.join(directory, 'graph.json.gz');
  const value = {
    nodes: Array.from({ length: 12_000 }, (_, index) => ({ id: `node-${index}`, metadata: { index } })),
    edges: Array.from({ length: 12_000 }, (_, index) => ({ source: `node-${index}`, target: `node-${(index + 1) % 12_000}` })),
  };
  try {
    await writeStreamingGzipJson(file, value);
    assert.deepEqual(await readStreamingGzipJson(file), value);
  } finally {
    await fs.remove(directory);
  }
});

test('streaming gzip JSON reports a cache file removed before its read begins', async () => {
  const missing = path.join(os.tmpdir(), `klauro-missing-gzip-${process.pid}-${Date.now()}.json.gz`);
  await assert.rejects(readStreamingGzipJson(missing), /ENOENT/);
});
