import test from 'node:test';
import assert from 'node:assert/strict';
import type { CASOutput, CASNode } from '../../../packages/analyzer-core/src/types/cas.types';
import type { ScoredNodeId } from '../../../packages/analyzer-core/src/analyzer/embedding/types';
import { fuseAndRank } from './semantic-search';
import { searchNodes } from './query';

function makeNode(id: string, name: string, type = 'function', file?: string): CASNode {
  return {
    id,
    name,
    type,
    qualified_name: `mod.${name}`,
    ...(file ? { source: { file } } : {}),
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

  const first = fuseAndRank(cas, query, vectorHits, lexicalHits, { detail: 'full' }, 10, RERANK);
  const second = fuseAndRank(cas, query, vectorHits, lexicalHits, { detail: 'full' }, 10, RERANK);

  assert.deepEqual(
    first.map(r => r.node_id),
    second.map(r => r.node_id),
  );
  assert.deepEqual(
    first.map(r => r.scores!.final),
    second.map(r => r.scores!.final),
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

  const fused = fuseAndRank(cas, query, vectorHits, lexicalHits, { detail: 'full' }, 10, RERANK);
  assert.equal(fused[0].node_id, lexicalHits[0].id);
  assert.ok(fused[0].scores!.final >= fused[fused.length - 1].scores!.final);
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
  const results = fuseAndRank(cas, query, vectorHits, lexicalHits, { detail: 'full' }, limit, RERANK);
  assert.equal(results.length, limit);
  assert.ok(
    results.some(r => r.node_id === 'exact'),
    'exact name match must be lifted into the top-K window',
  );
});

// Regression for the retrieval blind spot where a multi-word INTENT query
// ("orchestrate incremental analysis") failed to surface the production
// control-flow method literally named for it, because the name-match boost was
// gated to single-token symbol queries and the hash embedding gave the method
// a near-random semantic score below generic files and test-file namesakes.
// The name-token-coverage boost must lift the production orchestration method
// above an identically-worded test helper and generic file for the intent
// query. See ~/.klauro/agent-feedback/2026-07-06-retrieval-gap.md.
test('intent query surfaces production orchestration method over test-file namesake', () => {
  const nodes: CASNode[] = [
    makeNode(
      'prod',
      'orchestrateIncrementalAnalysis',
      'method',
      'packages/analyzer-core/src/analyzer/core/orchestrator.ts',
    ),
    makeNode(
      'testhelper',
      'orchestrateIncrementalAnalysis',
      'function',
      'packages/analyzer-core/src/__tests__/core/orchestrator.test.ts',
    ),
    makeNode('genericFile', 'analyzer.ts', 'file', 'apps/mcp-server/src/analyzer.ts'),
  ];
  for (let i = 0; i < 30; i += 1) {
    nodes.push(makeNode(`noise-${i}`, `unrelatedHelper${i}`));
  }
  const cas = makeCas(nodes);
  const query = 'orchestrate incremental analysis';

  const lexicalHits = searchNodes(cas, query, { limit: 90 });
  // Hash-embedding-style noise: the target method scores LOW, generic + noise
  // nodes score high — the exact failure mode observed on the real repo.
  const vectorHits: ScoredNodeId[] = [
    { nodeId: 'genericFile', score: 0.95 },
    { nodeId: 'testhelper', score: 0.9 },
  ];
  for (let i = 0; i < 20; i += 1) vectorHits.push({ nodeId: `noise-${i}`, score: 0.85 - i * 0.01 });
  vectorHits.push({ nodeId: 'prod', score: 0.1 });

  const results = fuseAndRank(cas, query, vectorHits, lexicalHits, { detail: 'full' }, 5, RERANK);
  assert.equal(
    results[0].node_id,
    'prod',
    'production orchestration method must rank #1 for the intent query',
  );
  const prodRank = results.findIndex(r => r.node_id === 'prod');
  const testRank = results.findIndex(r => r.node_id === 'testhelper');
  assert.ok(
    prodRank !== -1 && (testRank === -1 || prodRank < testRank),
    'production method must outrank its test-file namesake',
  );
});

// Regression for the decision-gate case: "full rebuild reason" must surface
// fullRebuildReasonForPreviousOutput (the real rebuild-decision gate) at the
// top, not a test-file fullRebuildReason helper.
test('intent query surfaces the decision-gate method by name coverage', () => {
  const nodes: CASNode[] = [
    makeNode(
      'gate',
      'fullRebuildReasonForPreviousOutput',
      'method',
      'packages/analyzer-core/src/analyzer/core/orchestrator.ts',
    ),
    makeNode(
      'testfn',
      'fullRebuildReason',
      'function',
      'packages/analyzer-core/src/__tests__/core/analyzer-build-invalidation.test.ts',
    ),
  ];
  for (let i = 0; i < 25; i += 1) {
    nodes.push(makeNode(`x-${i}`, `somethingElse${i}`));
  }
  const cas = makeCas(nodes);
  const query = 'full rebuild reason';

  const lexicalHits = searchNodes(cas, query, { limit: 90 });
  const vectorHits: ScoredNodeId[] = [
    { nodeId: 'testfn', score: 0.9 },
    { nodeId: 'gate', score: 0.2 },
  ];

  const results = fuseAndRank(cas, query, vectorHits, lexicalHits, { detail: 'full' }, 5, RERANK);
  const gateRank = results.findIndex(r => r.node_id === 'gate');
  const testRank = results.findIndex(r => r.node_id === 'testfn');
  assert.ok(gateRank !== -1, 'decision-gate method must appear in the top-K window');
  assert.ok(
    gateRank < testRank || testRank === -1,
    'production decision-gate method must outrank its test-file namesake',
  );
});

test('plain natural-language concept query is not hijacked by control-flow names', () => {
  // A concept query that shares NO name tokens with an unrelated orchestration
  // function must not pull that function up. Guards against the control-flow
  // nudge over-boosting.
  const nodes: CASNode[] = [
    makeNode('cf', 'orchestrateRebuildDecision', 'method', 'src/core/orchestrator.ts'),
    makeNode('match', 'validateUserEmail', 'function', 'src/auth/validate.ts'),
  ];
  const cas = makeCas(nodes);
  const query = 'validate user email';
  const lexicalHits = searchNodes(cas, query, { limit: 30 });
  const vectorHits: ScoredNodeId[] = [{ nodeId: 'match', score: 0.9 }];
  const results = fuseAndRank(cas, query, vectorHits, lexicalHits, { detail: 'full' }, 5, RERANK);
  assert.equal(results[0].node_id, 'match', 'name-matching node wins; control-flow name is not lifted');
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

  const a = fuseAndRank(cas, query, vectorHits, lexicalHits, { detail: 'full' }, 3, RERANK);
  const b = fuseAndRank(cas, query, vectorHits, lexicalHits, { detail: 'full' }, 3, RERANK);
  assert.deepEqual(a.map(r => r.node_id), b.map(r => r.node_id));
  assert.ok(a.some(r => r.node_id === 'exact'));
});
