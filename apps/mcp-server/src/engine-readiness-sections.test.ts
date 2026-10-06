import test from 'node:test';
import assert from 'node:assert/strict';
import { tierStackToCas } from '../../../packages/analyzer-core/src/analyzer/tier-stack/tier-stack-to-cas';
import type { TierStackIndex } from '../../../packages/analyzer-core/src/analyzer/tier-stack/read-tier-stack';
import { evaluateAgentReadiness } from './agent-adoption';

const INDEX: TierStackIndex = {
  root: '/tmp/desk',
  files: [{ path: 'src/main.ts', kind: 'source', language: 'typescript', extracted: true }],
  nodes: [
    { id: 'src/main.ts', name: 'main.ts', kind: 'module', file: 0, span: { line: 1 } },
    { id: 'src/main.ts:function:start:3', name: 'start', kind: 'function', file: 0, span: { line: 3 }, parent: 'src/main.ts' },
  ],
  edges: [{ source: 'src/main.ts', target: 'src/main.ts:function:start:3', kind: 'contains' }],
  entry_points: [{ id: 'entry:start', kind: 'ui', name: 'start', handler: 'src/main.ts:function:start:3', file: 0, line: 3, registrar: 'main' }],
  exit_points: [],
};

function gateOf(readiness: any, id: string) {
  return readiness.gates.find((candidate: any) => candidate.id === id);
}

test('an engine analysis passes graph integrity and explains each section it has no data for', () => {
  const readiness = evaluateAgentReadiness(tierStackToCas(INDEX), '/tmp/desk') as any;
  const integrity = gateOf(readiness, 'graph-integrity');
  assert.notEqual(integrity.detail, 'Missing validation.graph_integrity');
  assert.ok(gateOf(readiness, 'evidence').detail.startsWith('1 analysis facts') || /^\d+ analysis facts/.test(gateOf(readiness, 'evidence').detail));
  assert.match(gateOf(readiness, 'codebase-idioms').detail, /engine analysis: no convention had enough comparable sites/);
  assert.match(gateOf(readiness, 'behavioral-invariants').detail, /engine analysis: no guarded request surfaces/);
});
