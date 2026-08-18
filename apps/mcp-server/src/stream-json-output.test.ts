import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Writable } from 'node:stream';
import { writeJsonValue } from './stream-json-output';

test('streams JSON values without constructing one serialized string', async () => {
  const chunks: Buffer[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const value = {
    analysis_id: 'analysis',
    output: {
      nodes: Array.from({ length: 200 }, (_, index) => ({ id: `node-${index}`, description: 'x'.repeat(256) })),
    },
  };

  await writeJsonValue(value, destination);

  assert.equal(chunks.length > 1, true);
  assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString('utf8')), value);
});

test('streams nested CAS-shaped children in bounded chunks', async () => {
  let largestChunk = 0;
  let output = '';
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      largestChunk = Math.max(largestChunk, chunk.length);
      output += chunk.toString('utf8');
      callback();
    },
  });
  const nodes = Array.from({ length: 500 }, (_, index) => ({ id: `node-${index}`, value: 'x'.repeat(512) }));
  const value = { output: { nodes, edges: [], children: [{ nodes, edges: [] }] } };

  await writeJsonValue(value, destination);

  assert.deepEqual(JSON.parse(output), value);
  assert.equal(largestChunk < 128 * 1024, true);
});
