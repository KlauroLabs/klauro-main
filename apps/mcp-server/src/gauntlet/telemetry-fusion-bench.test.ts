import test from 'node:test';
import assert from 'node:assert/strict';
import { runTelemetryFusionBench, buildFixture } from './telemetry-fusion-bench';

// BLACKBOX bench: fuseTelemetry() over a fixture CAS + span batch. No engine
// import, no AI/model env — deterministic structural correlation only.

test('telemetry-fusion-bench: correlates hot/slow/error facts onto the right CAS nodes', () => {
  const result = runTelemetryFusionBench();
  assert.equal(result.f1, 1, `expected perfect fusion, mismatches: ${result.mismatches.join('; ')}`);
  assert.equal(result.correct, result.total);
});

test('telemetry-fusion-bench: decoy span (no static match) is rejected honestly, never force-fit', () => {
  const result = runTelemetryFusionBench();
  assert.equal(result.decoy_handled_honestly, true);
});

test('telemetry-fusion-bench: fixture shape sanity (one entry point, one exit point, one decoy)', () => {
  const fixture = buildFixture();
  assert.equal(fixture.cas.entry_points?.length, 1);
  assert.equal(fixture.cas.exit_points?.length, 1);
  assert.equal(fixture.expected_unmatched.length, 1);
});
