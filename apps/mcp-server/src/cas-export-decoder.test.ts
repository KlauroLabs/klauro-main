import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import * as zlib from 'node:zlib';
import { decodeCasExport, decodeCasExportStream } from './cas-export-decoder';

test('decodes zstd CAS exports without an external binary when Node provides the codec', () => {
  const payload = Buffer.from(JSON.stringify({ nodes: [{ id: 'node-1' }] }));
  const compressed = zlib.zstdCompressSync(payload);
  assert.deepEqual(decodeCasExport(compressed, 'zstd'), payload);
});

test('leaves uncompressed CAS exports unchanged', () => {
  const payload = Buffer.from(JSON.stringify({ nodes: [] }));
  assert.equal(decodeCasExport(payload, 'none'), payload);
});

test('streams zstd CAS exports into structured values without materializing one JSON string', async () => {
  const expected = { nodes: Array.from({ length: 10_000 }, (_, index) => ({ id: `node-${index}` })) };
  const compressed = zlib.zstdCompressSync(Buffer.from(JSON.stringify(expected)));
  const chunks = Array.from({ length: Math.ceil(compressed.length / 127) }, (_, index) =>
    compressed.subarray(index * 127, (index + 1) * 127));
  const decoded = await decodeCasExportStream<typeof expected>(Readable.from(chunks), 'zstd');
  assert.deepEqual(decoded, expected);
});

test('streams uncompressed CAS exports into structured values', async () => {
  const expected = { nodes: [{ id: 'node-1' }], edges: [] };
  const decoded = await decodeCasExportStream<typeof expected>(Readable.from([JSON.stringify(expected)]), 'none');
  assert.deepEqual(decoded, expected);
});

test('retains streaming assembly beyond the bounded JSON buffer', async () => {
  const expected = { nodes: Array.from({ length: 100 }, (_, index) => ({ id: `node-${index}` })) };
  const decoded = await decodeCasExportStream<typeof expected>(
    Readable.from([JSON.stringify(expected)]),
    'none',
    { bufferedJsonLimitBytes: 32 },
  );
  assert.deepEqual(decoded, expected);
});

test('turns a dropped compressed response into a handled decode rejection', async () => {
  const compressed = zlib.zstdCompressSync(Buffer.from(JSON.stringify({ nodes: [{ id: 'node-1' }] })));
  const source = Readable.from((async function* () {
    yield compressed.subarray(0, Math.max(1, Math.floor(compressed.length / 2)));
    throw new Error('socket closed mid-export');
  })());

  await assert.rejects(decodeCasExportStream(source, 'zstd'), /socket closed mid-export/);
});
