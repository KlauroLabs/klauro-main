import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { createOrchestrator } from '../analyzer';
import { queryGraph, parseQuery } from '../graph-query';

const FIXTURE = path.resolve(__dirname, '../../fixtures/primitive-bench/callers-ts');

test('parseQuery handles single-node, one-hop, and WHERE', () => {
  const p = parseQuery("MATCH (a)-[:CALLS]->(b) WHERE b.name = 'save' RETURN a");
  assert.equal(p?.aVar, 'a');
  assert.equal(p?.relType, 'CALLS');
  assert.equal(p?.bVar, 'b');
  assert.deepEqual(p?.where, { var: 'b', field: 'name', value: 'save' });
  assert.deepEqual(p?.returnVars, ['a']);
});

test('queryGraph: one-hop relationship + WHERE returns callers of save', async () => {
  const cas: any = await createOrchestrator().orchestrateAnalysis(FIXTURE);
  const r = queryGraph(cas, "MATCH (a)-[:CALLS]->(b) WHERE b.name = 'save' RETURN a");
  const names = (( r.results as any)?.a || []).map((n: any) => n.name).sort();
  assert.ok(names.includes('persist') && names.includes('archive'), `callers of save, got ${JSON.stringify(names)}`);
});

test('queryGraph: node filter by type', async () => {
  const cas: any = await createOrchestrator().orchestrateAnalysis(FIXTURE);
  const r = queryGraph(cas, "MATCH (n) WHERE n.type = 'function' RETURN n");
  assert.ok(((r.results as any)?.n || []).length >= 1, 'must return functions');
  assert.ok(((r.results as any)?.n || []).every((x: any) => x.type === 'function'), 'all returned are functions');
});

test('queryGraph: unsupported query reports an error', async () => {
  const cas: any = await createOrchestrator().orchestrateAnalysis(FIXTURE);
  const r: any = queryGraph(cas, 'DROP TABLE nodes');
  assert.ok(r.error, 'malformed query returns an error, not a crash');
});
