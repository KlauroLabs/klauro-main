/**
 * Invariants over the scenario/arm catalogs that the validator + UI depend on.
 * Uses dynamic references (ARMS, SCENARIOS) so it survives catalog growth.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARMS,
  SCENARIOS,
  KLAURO_ARM_ID,
  scenarioById,
  armsForScenario,
  type ScenarioGroup,
  type ScenarioExecution,
} from './report-schema';

const ARM_IDS = new Set(ARMS.map(a => a.id));
const ALLOWED_GROUPS: ScenarioGroup[] = ['single-repo', 'workspace', 'cross-repo', 'incremental', 'analysis'];
const ALLOWED_EXEC: ScenarioExecution[] = ['live', 'projected', 'engine'];

// --- Klauro arm invariants ---------------------------------------------------

test('exactly one arm has kind "klauro"', () => {
  assert.equal(ARMS.filter(a => a.kind === 'klauro').length, 1);
});

test('exactly one arm has isKlauro true and it is the klauro-kind arm', () => {
  const flagged = ARMS.filter(a => a.isKlauro);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].kind, 'klauro');
});

test('the Klauro arm id equals KLAURO_ARM_ID', () => {
  const klauro = ARMS.find(a => a.isKlauro)!;
  assert.equal(klauro.id, KLAURO_ARM_ID);
});

test('KLAURO_ARM_ID resolves to a real arm', () => {
  assert.ok(ARMS.some(a => a.id === KLAURO_ARM_ID));
});

// --- arm catalog integrity ---------------------------------------------------

test('all arm ids are unique', () => {
  assert.equal(ARM_IDS.size, ARMS.length);
});

test('every arm has label, method and a kind from the allowed set', () => {
  const kinds = new Set(['no-tools', 'klauro', 'other-indexer']);
  for (const a of ARMS) {
    assert.ok(a.label && a.label.length > 0, `${a.id} label`);
    assert.ok(a.method && a.method.length > 0, `${a.id} method`);
    assert.ok(kinds.has(a.kind), `${a.id} kind ${a.kind}`);
  }
});

test('only other-indexer arms carry a competitor; canonical arms do not', () => {
  for (const a of ARMS) {
    if (a.kind === 'other-indexer') assert.ok(a.competitor, `${a.id} should name a competitor`);
    else assert.equal(a.competitor, undefined, `${a.id} should not name a competitor`);
  }
});

// --- scenario catalog integrity ---------------------------------------------

test('all scenario ids are unique', () => {
  const ids = SCENARIOS.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('every scenario.arms (when set) is a non-empty subset of ARMS ids', () => {
  for (const s of SCENARIOS) {
    if (!s.arms) continue;
    assert.ok(s.arms.length > 0, `${s.id} arms non-empty`);
    for (const id of s.arms) assert.ok(ARM_IDS.has(id), `${s.id} references unknown arm ${id}`);
  }
});

test('every scenario with an arms list includes the Klauro arm', () => {
  for (const s of SCENARIOS) {
    if (s.arms) assert.ok(s.arms.includes(KLAURO_ARM_ID), `${s.id} must include klauro`);
  }
});

test('every scenario has non-empty label, task, klauroEdge', () => {
  for (const s of SCENARIOS) {
    assert.ok(s.label && s.label.length > 0, `${s.id} label`);
    assert.ok(s.task && s.task.length > 0, `${s.id} task`);
    assert.ok(s.klauroEdge && s.klauroEdge.length > 0, `${s.id} klauroEdge`);
  }
});

test('every scenario group is from the allowed set', () => {
  for (const s of SCENARIOS) assert.ok(ALLOWED_GROUPS.includes(s.group), `${s.id} group ${s.group}`);
});

test('every scenario execution is one of live/projected/engine', () => {
  for (const s of SCENARIOS) assert.ok(ALLOWED_EXEC.includes(s.execution), `${s.id} execution ${s.execution}`);
});

// --- scenarioById round-trip -------------------------------------------------

test('scenarioById round-trips for every scenario', () => {
  for (const s of SCENARIOS) {
    const got = scenarioById(s.id);
    assert.ok(got, `missing ${s.id}`);
    assert.equal(got!.id, s.id);
  }
});

test('scenarioById returns undefined for junk', () => {
  assert.equal(scenarioById('not-a-real-scenario'), undefined);
  assert.equal(scenarioById(''), undefined);
});

// --- armsForScenario ---------------------------------------------------------

test('armsForScenario returns all ARMS when scenario.arms is undefined', () => {
  const spec = SCENARIOS.find(s => !s.arms);
  assert.ok(spec, 'expected at least one scenario with no explicit arms');
  assert.deepEqual(armsForScenario(spec!), ARMS);
});

test('armsForScenario returns the filtered subset when arms set', () => {
  const spec = SCENARIOS.find(s => s.arms && s.arms.length < ARMS.length);
  assert.ok(spec, 'expected a scenario with a narrowed arm set');
  const got = armsForScenario(spec!).map(a => a.id);
  assert.deepEqual(new Set(got), new Set(spec!.arms!));
});

test('armsForScenario preserves ARMS catalog order', () => {
  // Use a scenario whose arms are a subset; result order must follow ARMS, not spec.arms.
  const spec = { ...SCENARIOS[0], arms: [...ARMS].reverse().map(a => a.id) };
  const got = armsForScenario(spec).map(a => a.id);
  assert.deepEqual(got, ARMS.map(a => a.id), 'order follows ARMS, ignoring spec.arms order');
});
