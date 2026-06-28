import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as path from 'path';
import {
  runTelemetryOverlayBench,
  runTelemetryOverlaySuite,
  cbmAvailable,
  deriveFact,
  spanToEvent,
} from './telemetry-overlay-bench';

// TELEMETRY OVERLAY — "how it's running", fused onto static structure.
// Klauro ingests runtime spans and correlates each to the exact static route /
// exit point / function it exercised, derives the hot/error/slow fact, and
// reports a decoy span (no static match) honestly as unmatched. The REAL
// codebase-memory binary ships ingest_traces and gets its strongest attempt;
// when present we assert Klauro never strictly loses on the correlation axis.
const ROOT = path.resolve(__dirname, '../../fixtures/telemetry-overlay');
const fixtures = fs.existsSync(ROOT)
  ? fs.readdirSync(ROOT).filter(d =>
      fs.existsSync(path.join(ROOT, d, 'truth.json')) &&
      fs.existsSync(path.join(ROOT, d, 'traces.json')))
  : [];

test('telemetry-overlay: fact derivation reflects runtime observation, not fabrication', () => {
  assert.equal(deriveFact({ name: 'x', error: true }), 'error');
  assert.equal(deriveFact({ name: 'x', kind: 'error' }), 'error');
  assert.equal(deriveFact({ name: 'x', error_rate: 0.02, duration_ms: 20 }), 'error');
  assert.equal(deriveFact({ name: 'x', p95_ms: 1100, duration_ms: 20 }), 'slow');
  assert.equal(deriveFact({ name: 'x', p99_ms: 2200, duration_ms: 20 }), 'slow');
  assert.equal(deriveFact({ name: 'x', duration_ms: 1500 }), 'slow');
  assert.equal(deriveFact({ name: 'x', rate_per_min: 140 }), 'hot');
  assert.equal(deriveFact({ name: 'x', count: 200 }), 'hot');
  assert.equal(deriveFact({ name: 'x', duration_ms: 10, count: 2 }), 'unused');
});

test('telemetry-overlay: span -> RuntimeEventInput mapping is correct per kind', () => {
  assert.equal(spanToEvent({ name: 'e', kind: 'exit', endpoint: '/x' }).type, 'exit');
  assert.equal(spanToEvent({ name: 'er', kind: 'error', stack: 's' }).type, 'error');
  assert.equal(spanToEvent({ name: 'r', method: 'GET', route: '/x' }).type, 'request');
  // an exit is inferable from an endpoint even without explicit kind
  assert.equal(spanToEvent({ name: 'e2', endpoint: '/y' }).type, 'exit');
  assert.equal(spanToEvent({ name: 'r', method: 'GET', route: '/x', p99_ms: 2200, count: 4 }).attributes?.p99_ms, 2200);
  assert.equal(spanToEvent({ name: 'r', method: 'GET', route: '/x', p99_ms: 2200, count: 4 }).attributes?.volume, 4);
});

for (const fixture of fixtures) {
  test(`telemetry-overlay [${fixture}]: Klauro correlates the runtime facts it claims + handles the decoy honestly`, async () => {
    const r = await runTelemetryOverlayBench(path.join(ROOT, fixture));
    const klauro = r.detail.find(d => d.arm === 'klauro')!;

    // Klauro correlates every claimed span (span -> static node + correct fact)
    // AND reports the decoy span as unmatched — F1 must be perfect.
    assert.equal(klauro.f1, 1, `[${fixture}] Klauro must correlate every runtime fact + reject the decoy, got ${klauro.correct}/${klauro.total}`);
    assert.equal(klauro.can_answer, true);

    // The decoy span (static_node: null) must be reported unmatched, never force-fit.
    assert.equal(r.decoy_handled_honestly, true, `[${fixture}] decoy span must be unmatched, not force-fit`);

    // A real "how it's running" headline must be produced.
    assert.ok(r.how_its_running && r.how_its_running.length > 0, `[${fixture}] must surface a how-it's-running answer`);
  });
}

test('telemetry-overlay aggregate: losses === 0 (Klauro never strictly out-correlated)', async () => {
  if (!cbmAvailable()) {
    // Skip-guard: the head-to-head needs the real codebase-memory binary.
    console.log('codebase-memory binary absent — skipping head-to-head aggregate');
    return;
  }
  const agg = await runTelemetryOverlaySuite(ROOT);
  assert.ok(agg.cases > 0, 'must have telemetry-overlay fixtures');
  assert.equal(agg.losses, 0, `Klauro lost the correlation axis on: ${agg.lossNames.join(', ')}`);
  // Klauro must fully correlate; cbm's ingest_traces does not fuse to static.
  assert.equal(agg.meanKlauroF1, 1, `Klauro mean F1 must be 1, got ${agg.meanKlauroF1}`);
  assert.ok(agg.meanCbmF1 < agg.meanKlauroF1, `cbm must not match Klauro's correlation (cbm=${agg.meanCbmF1}, klauro=${agg.meanKlauroF1})`);
  for (const r of agg.results) {
    assert.equal(r.verdict.klauro_wins, true, r.verdict.violation?.summary || `[${r.fixture}] Klauro must win the overlay axis`);
  }
});
