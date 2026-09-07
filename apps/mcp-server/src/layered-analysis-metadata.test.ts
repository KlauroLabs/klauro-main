import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { CASLayerStatus, CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { resolveLayeredEnrichmentPhase } from './layered-analysis-metadata';

function output(state: CASOutput['ai_enrichment'], layers: CASLayerStatus[]): Pick<CASOutput, 'ai_enrichment' | 'layers_ready'> {
  return { ai_enrichment: state, layers_ready: { complete: layers.every(layer => layer.status === 'ready'), generated_at: '2026-09-07T00:00:00Z', layers } };
}

function layer(id: CASLayerStatus['layer'], status: CASLayerStatus['status'], error?: string): CASLayerStatus {
  return { layer: id, name: id, status, fields: [], ...(error ? { error } : {}) };
}

test('finished AI work cannot hide rejected L4 and L5 comprehension', () => {
  const rejected = output('ready', [
    layer('L4', 'error', 'Catalog omits two grounded outcomes.'),
    layer('L5', 'error', 'Catalog omits two grounded outcomes.'),
  ]);
  const before = JSON.stringify(rejected);
  const result = resolveLayeredEnrichmentPhase(rejected);
  assert.equal(result.status, 'failed');
  assert.match(result.error!, /L4: Catalog omits/);
  assert.match(result.error!, /L5: Catalog omits/);
  assert.equal(JSON.stringify(rejected), before);
});

test('valid synchronous and asynchronous enrichment still succeeds', () => {
  for (const state of ['ready', 'synchronous'] as const) {
    assert.deepEqual(resolveLayeredEnrichmentPhase(output(state, [layer('L4', 'ready'), layer('L5', 'ready')])), { status: 'succeeded' });
  }
});

test('disabled enrichment respects an explicit layer failure', () => {
  assert.equal(resolveLayeredEnrichmentPhase(output('disabled', [layer('L5', 'error', 'AI enrichment is disabled.')])).status, 'failed');
  assert.deepEqual(resolveLayeredEnrichmentPhase({ ai_enrichment: 'disabled' }), { status: 'succeeded' });
});

test('pending work is not a successful terminal phase', () => {
  assert.match(resolveLayeredEnrichmentPhase(output('ready', [layer('L5', 'pending')])).error!, /remains pending/);
  assert.match(resolveLayeredEnrichmentPhase(output('pending', [layer('L5', 'ready')])).error!, /remains pending/);
});

test('provider errors retain their diagnostic and missing terminal state fails', () => {
  assert.deepEqual(resolveLayeredEnrichmentPhase({ ai_enrichment: 'error', ai_enrichment_error: 'Provider request failed.' }), {
    status: 'failed', error: 'Provider request failed.',
  });
  assert.match(resolveLayeredEnrichmentPhase({}).error!, /no terminal status/);
});

test('legacy explicit L5 readiness is usable without an AI operation state', () => {
  assert.deepEqual(resolveLayeredEnrichmentPhase(output(undefined, [layer('L5', 'ready')])), { status: 'succeeded' });
});

test('an earlier layer failure does not falsely relabel a successful enrichment phase', () => {
  assert.deepEqual(resolveLayeredEnrichmentPhase(output('ready', [layer('L2', 'error'), layer('L4', 'ready'), layer('L5', 'ready')])), { status: 'succeeded' });
});
