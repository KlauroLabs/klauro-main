import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type { CASNode, CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { encodeCompactCASGraph } from '../../../packages/analyzer-core/src/analyzer/core/compact-cas-graph';
import {
  compactCASPostingShard,
  encodeCompactCASSearchIndex,
  searchCompactCAS,
} from '../../../packages/analyzer-core/src/analyzer/core/compact-cas-search';
import { searchNodes } from './query';
import { buildCompactCASPostingArtifacts, decodeCompactCASPostingShard } from './compact-cas-search-storage';

const nodes: CASNode[] = [
  { id: 'z-last', name: 'PaymentService', type: 'service', description: 'Qx boundary', source: { file: 'src/payment.ts', line: 2 } },
  { id: 'a-first', name: 'PaymentService', type: 'service', documentation: { raw: 'Retention policy coordinator', location: { start_line: 1, end_line: 1 } }, source: { file: 'src/first.ts', line: 1 } },
  {
    id: 'm-comment', name: 'CleanupJob', type: 'function', tags: ['scheduled'],
    comments: [{ id: 'comment', type: 'single-line', style: '//', text: 'Applies retention policy', location: { file: 'src/job.ts', line: 1 } }],
  },
  { id: 'd-description', name: 'Worker', type: 'function', description: 'Handles xy transitions' },
];
const cas = { nodes, edges: [] } as unknown as CASOutput;

function searchIndex() {
  const graph = encodeCompactCASGraph(cas);
  const encoded = encodeCompactCASSearchIndex(cas, graph);
  assert.ok(encoded.postings.size > 0);
  const decoder = new TextDecoder();
  return {
    graph,
    hot: {
      textChunkNodes: encoded.textChunkNodes,
      descriptionOffsets: encoded.descriptionOffsets,
      auxiliaryTextOffsets: encoded.auxiliaryTextOffsets,
    },
    readPostings: async (keys: readonly string[]) => new Map(keys.flatMap(key => encoded.postings.has(key) ? [[key, encoded.postings.get(key)!] as const] : [])),
    readSearchText: async (denseIds: readonly number[]) => new Map(denseIds.map(denseId => [
      denseId,
      {
        description: decoder.decode(encoded.descriptionBytes.subarray(
          encoded.descriptionOffsets[denseId],
          encoded.descriptionOffsets[denseId + 1],
        )),
        auxiliaryText: decoder.decode(encoded.auxiliaryTextBytes.subarray(
          encoded.auxiliaryTextOffsets[denseId],
          encoded.auxiliaryTextOffsets[denseId + 1],
        )),
      },
    ])),
  };
}

for (const [query, options] of [
  ['q', {}],
  ['xy', {}],
  ['payment service', {}],
  ['retention', {}],
  ['payment', { file: 'src/first.ts' }],
  ['policy', { type: 'function' }],
] as const) {
  test(`compact search preserves canonical results for ${query}`, async () => {
    const { graph, hot, readPostings, readSearchText } = searchIndex();
    assert.deepEqual(
      await searchCompactCAS(graph, hot, query, readPostings, readSearchText, options),
      searchNodes(cas, query, options),
    );
  });
}

test('compact postings preserve a pathological long description without embedding it in graph columns', () => {
  const description = Array.from({ length: 20_000 }, (_, index) => `unique${index.toString(36)}`).join(' ');
  const longCas = {
    nodes: [{ id: 'long', name: 'LongNode', type: 'function', description }],
    edges: [],
  } as unknown as CASOutput;
  const encoded = encodeCompactCASSearchIndex(longCas, encodeCompactCASGraph(longCas));
  assert.equal(encoded.descriptionBytes.byteLength, Buffer.byteLength(description));
});

test('binary posting runs deduplicate repeated text across run boundaries', async () => {
  const repeatedCas = {
    nodes: [
      { id: 'first', name: 'RepeatedRepeated', type: 'function', description: 'résumé résumé repeated repeated' },
      { id: 'second', name: 'Repeated', type: 'function', description: 'résumé repeated' },
    ],
    edges: [],
  } as unknown as CASOutput;
  const graph = encodeCompactCASGraph(repeatedCas);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-postings-'));
  try {
    const artifacts = await buildCompactCASPostingArtifacts(repeatedCas, graph, directory, 4, 2);
    assert.ok(artifacts.runCount > 1);
    const key = 't:repeated';
    const shard = compactCASPostingShard(key, artifacts.shardCount);
    const descriptor = artifacts.columns[`postings.shard.${shard}`];
    const decoded = decodeCompactCASPostingShard(
      await fs.readFile(path.join(directory, descriptor.file)),
      new Set([key]),
      graph.nodeCount,
    );
    assert.deepEqual([...decoded.get(key)!], [0, 1]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
