import test from 'node:test';
import assert from 'node:assert/strict';
import type { CASOutput, CASNode } from '../../backend/src/types/cas.types';
import type { ScoredNodeId } from '../../backend/src/analyzer/embedding/types';
import { fuseAndRank } from './semantic-search';
import { searchNodes } from './query';

function makeNode(id: string, name: string, type = 'function'): CASNode {
  return {
    id,
    name,
    type,
    qualified_name: `mod.${name}`,
  } as CASNode;
}

function makeCas(nodes: CASNode[]): CASOutput {
  return {
    cas_version: '1.10.0',
    analysis_timestamp: '2026-01-01T00:00:00.000Z',
    analysis_id: 'semantic-search-test',
    system: {
      id: 'semantic-search-test',
      name: 'semantic-search-test',
      type: 'application',
      root_path: '/tmp/sst',
    },
    nodes,
    edges: [],
    analyzer_contributions: [],
    progressive_levels: { total_levels: 1 },
  } as unknown as CASOutput;
}

const RERANK = { alpha: 0.7, beta: 0.3 };

test('reciprocal-rank fusion is deterministic for identical inputs', () => {
  const nodes = [
    makeNode('n1', 'parseToken'),
    makeNode('n2', 'parseHeader'),
    makeNode('n3', 'parseBody'),
    makeNode('n4', 'serialize'),
    makeNode('n5', 'validate'),
  ];
  const cas = makeCas(nodes);
  const query = 'parse';
  const lexicalHits = searchNodes(cas, query, { limit: 30 });
  const vectorHits: ScoredNodeId[] = [
    { nodeId: 'n3', score: 0.91 },
    { nodeId: 'n1', score: 0.82 },
    { nodeId: 'n5', score: 0.40 },
  ];

  const first = fuseAndRank(cas, query, vectorHits, lexicalHits, {}, 10, RERANK);
  const second = fuseAndRank(cas, query, vectorHits, lexicalHits, {}, 10, RERANK);

  assert.deepEqual(
    first.map(r => r.node_id),
    second.map(r => r.node_id),
  );
  assert.deepEqual(
    first.map(r => r.scores.final),
    second.map(r => r.scores.final),
  );
  assert.ok(first.length > 0);
});

test('fusion rewards nodes ranked highly by both lexical and vector signals', () => {
  const nodes = [
    makeNode('n1', 'parseToken'),
    makeNode('n2', 'parseHeader'),
    makeNode('n3', 'parseBody'),
    makeNode('n4', 'serialize'),
  ];
  const cas = makeCas(nodes);
  const query = 'parse';
  const lexicalHits = searchNodes(cas, query, { limit: 30 });
  const vectorHits: ScoredNodeId[] = [
    { nodeId: lexicalHits[0].id, score: 0.95 },
    { nodeId: 'n4', score: 0.10 },
  ];

  const fused = fuseAndRank(cas, query, vectorHits, lexicalHits, {}, 10, RERANK);
  assert.equal(fused[0].node_id, lexicalHits[0].id);
  assert.ok(fused[0].scores.final >= fused[fused.length - 1].scores.final);
});

test('exact name match lands inside the top-K window even with weak signals', () => {
  const nodes: CASNode[] = [makeNode('exact', 'widget')];
  for (let i = 0; i < 40; i += 1) {
    nodes.push(makeNode(`filler-${i}`, `widgetHelper${i}`));
  }
  const cas = makeCas(nodes);
  const query = 'widget';

  const lexicalHits = searchNodes(cas, query, { limit: 120 });
  const vectorHits: ScoredNodeId[] = [];
  for (let i = 0; i < 30; i += 1) {
    vectorHits.push({ nodeId: `filler-${i}`, score: 0.9 - i * 0.01 });
  }

  const limit = 5;
  const results = fuseAndRank(cas, query, vectorHits, lexicalHits, {}, limit, RERANK);
  assert.equal(results.length, limit);
  assert.ok(
    results.some(r => r.node_id === 'exact'),
    'exact name match must be lifted into the top-K window',
  );
});

test('exact-match floor preserves determinism across repeated runs', () => {
  const nodes: CASNode[] = [makeNode('exact', 'router')];
  for (let i = 0; i < 20; i += 1) {
    nodes.push(makeNode(`r-${i}`, `routerExtension${i}`));
  }
  const cas = makeCas(nodes);
  const query = 'router';
  const lexicalHits = searchNodes(cas, query, { limit: 80 });
  const vectorHits: ScoredNodeId[] = nodes
    .filter(n => n.id !== 'exact')
    .slice(0, 15)
    .map((n, i) => ({ nodeId: n.id, score: 0.8 - i * 0.02 }));

  const a = fuseAndRank(cas, query, vectorHits, lexicalHits, {}, 3, RERANK);
  const b = fuseAndRank(cas, query, vectorHits, lexicalHits, {}, 3, RERANK);
  assert.deepEqual(a.map(r => r.node_id), b.map(r => r.node_id));
  assert.ok(a.some(r => r.node_id === 'exact'));
});
