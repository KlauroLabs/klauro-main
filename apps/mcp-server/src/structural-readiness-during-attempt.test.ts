/**
 * Latency finding (2026-08-10 latency-lever session): GET
 * /api/projects/:id/analysis-status and GET /api/projects/:id/analysis both
 * report bare 'populating' for the ENTIRE duration of an in-progress attempt
 * — including the L5 (AI enrichment) tail, which a live quiet-box
 * measurement on the 418-file/11,890-node Go benchmark repo showed taking
 * ~63s of an ~88s total, while L0-L4 (the deterministic core-graph/
 * agent-context ladder) land and are durably saved around the ~20s mark
 * (analyzer.ts's layered pipeline calls `saveAnalysis` right after the
 * 'rest' phase succeeds, well before awaiting `deferred.enrichment`).
 *
 * `structuralReadinessDuringAttempt` (remote-analyzer-service.ts) is the
 * fix: while an attempt is in-progress, if the already-landed entry's
 * `layers_ready.generated_at` is at or after the attempt's own `started_at`
 * (i.e. it is THIS attempt's own fresh output, not a stale leftover — the
 * exact case task #129 correctly guards against), and L0-L4 are all
 * 'ready' with L5 specifically 'pending' (not yet landed, not errored),
 * the routes now report a distinct 'queryable' status (TASK #143: renamed
 * from 'structurally_ready' once this was wired through get_summary,
 * resolve_agent_analysis and `klauro status` — see hosted-analysis.ts and
 * status-report.ts) carrying the real summary, instead of hiding genuinely
 * fresh, queryable data behind 'populating' for the whole AI tail. No
 * completeness is traded: L5 is
 * unchanged and still lands on its own schedule: `layers_ready` in the
 * response says exactly what is and is not ready, per this repo's existing
 * honesty vocabulary (comprehension.degraded / capability_description_
 * degradations follow the identical pattern).
 *
 * This is a pure-function unit test of the gating logic in isolation
 * (no HTTP/engine harness needed): remote-analyzer-status-freshness.test.ts
 * already proves end-to-end, over the real HTTP surface, that the #129
 * stale-entry case is completely unaffected by this change.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { structuralReadinessDuringAttempt } from './remote-analyzer-service';

function layers(overrides: Partial<Record<'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5', string>> = {}) {
  const base: Record<'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5', string> = {
    L0: 'ready', L1: 'ready', L2: 'ready', L3: 'ready', L4: 'ready', L5: 'pending',
  };
  const merged = { ...base, ...overrides };
  return (Object.keys(merged) as Array<keyof typeof merged>).map(layer => ({ layer, status: merged[layer] }));
}

test('reports structural readiness when L0-L4 landed after the attempt started and only L5 is pending', () => {
  const startedAt = '2026-08-10T06:55:12.690Z';
  const generatedAt = '2026-08-10T06:55:33.063Z'; // after startedAt — this attempt's own output
  const result = structuralReadinessDuringAttempt(
    { layers_ready: { layers: layers(), generated_at: generatedAt } },
    { started_at: startedAt },
  );
  assert.ok(result, 'expected structural readiness to be reported');
  assert.equal(result!.generatedAt, generatedAt);
  assert.equal(result!.layers.length, 6);
});

test('stays null (populating) when the landed entry predates the in-progress attempt — the #129 stale case', () => {
  const startedAt = '2026-08-10T06:55:12.690Z';
  const generatedAt = '2026-08-10T06:50:00.000Z'; // BEFORE startedAt — a prior run's leftover
  const result = structuralReadinessDuringAttempt(
    { layers_ready: { layers: layers(), generated_at: generatedAt } },
    { started_at: startedAt },
  );
  assert.equal(result, null);
});

test('stays null while any structural (L0-L4) layer is still pending', () => {
  const startedAt = '2026-08-10T06:55:12.690Z';
  const generatedAt = '2026-08-10T06:55:33.063Z';
  const result = structuralReadinessDuringAttempt(
    { layers_ready: { layers: layers({ L3: 'pending' }), generated_at: generatedAt } },
    { started_at: startedAt },
  );
  assert.equal(result, null);
});

test('stays null when a structural layer errored — callers must not paper over a real failure', () => {
  const startedAt = '2026-08-10T06:55:12.690Z';
  const generatedAt = '2026-08-10T06:55:33.063Z';
  const result = structuralReadinessDuringAttempt(
    { layers_ready: { layers: layers({ L2: 'error' }), generated_at: generatedAt } },
    { started_at: startedAt },
  );
  assert.equal(result, null);
});

test('stays null once L5 has already resolved (ready or error) — that is the callers\' normal landed path, not this overlay', () => {
  const startedAt = '2026-08-10T06:55:12.690Z';
  const generatedAt = '2026-08-10T06:55:33.063Z';
  const readyResult = structuralReadinessDuringAttempt(
    { layers_ready: { layers: layers({ L5: 'ready' }), generated_at: generatedAt } },
    { started_at: startedAt },
  );
  assert.equal(readyResult, null);
  const erroredResult = structuralReadinessDuringAttempt(
    { layers_ready: { layers: layers({ L5: 'error' }), generated_at: generatedAt } },
    { started_at: startedAt },
  );
  assert.equal(erroredResult, null);
});

test('stays null when timestamps or layers_ready are missing entirely', () => {
  assert.equal(structuralReadinessDuringAttempt(null, { started_at: '2026-08-10T06:55:12.690Z' }), null);
  assert.equal(structuralReadinessDuringAttempt({ layers_ready: { layers: layers(), generated_at: undefined } }, { started_at: '2026-08-10T06:55:12.690Z' }), null);
  assert.equal(structuralReadinessDuringAttempt({ layers_ready: { layers: layers(), generated_at: '2026-08-10T06:55:33.063Z' } }, { started_at: undefined }), null);
});
