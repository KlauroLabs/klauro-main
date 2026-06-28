import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { createOrchestrator } from '../analyzer';
import { getCommunities, getClones, getDeadCode } from '../query';

// Structural-parity capabilities made QUERYABLE (not just tested algorithms):
// Louvain communities and MinHash near-clones, derived from the final CAS graph
// — the layer codebase-memory exposes, now exposed by Klauro too.

const FIXTURE = path.resolve(__dirname, '../../fixtures/pattern-bench/layered-di');

test('getCommunities derives functional modules from the final CAS call graph', async () => {
  const cas: any = await createOrchestrator().orchestrateAnalysis(FIXTURE);
  const r = getCommunities(cas);
  assert.ok(r.total >= 1, `expected at least one community, got ${r.total}`);
  assert.ok(r.communities.every(c => c.size >= 1 && Array.isArray(c.members)), 'each community has members');
});

test('getClones returns a valid near-clone structure', async () => {
  const cas: any = await createOrchestrator().orchestrateAnalysis(FIXTURE);
  const r = getClones(cas);
  assert.equal(typeof r.total, 'number');
  assert.ok(Array.isArray(r.clones));
  assert.ok(r.clones.every(c => typeof c.similarity === 'number' && c.a && c.b), 'clone pairs are well-formed');
});

test('getDeadCode flags zero-caller functions, excluding entry points', async () => {
  const dir = path.resolve(__dirname, '../../fixtures/primitive-bench/callers-ts');
  const cas: any = await createOrchestrator().orchestrateAnalysis(dir);
  const r = getDeadCode(cas);
  assert.ok(r.total >= 1, `expected dead-code candidates, got ${r.total}`);
  // describeAccountPersistence in unrelated.ts has no callers — must be flagged.
  assert.ok(r.functions.some(f => f.name === 'describeAccountPersistence'), 'uncalled function must be flagged');
  // Account.save IS called (by persist/archive) — must NOT be flagged.
  assert.ok(!r.functions.some(f => f.name === 'save'), 'a called method must not be flagged dead');
});
