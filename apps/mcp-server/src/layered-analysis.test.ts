import test from 'node:test';
import assert from 'node:assert/strict';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { buildCompletedAnalysisLayersReady } from './layered-analysis';

function outputWithCatalog(
  status: 'accepted' | 'partial' | 'rejected' | 'unavailable',
  publishedCapabilities: number,
  aiPhaseStatus: 'complete' | 'degraded' = status === 'accepted' ? 'complete' : 'degraded',
): CASOutput {
  return {
    analysis_timestamp: '2026-08-20T00:00:00.000Z',
    ai_enrichment: 'ready',
    enhanced_system_purpose: {
      ai_phase_status: aiPhaseStatus,
      capability_catalog_coverage: {
        evidence_families: 35,
        published_capabilities: publishedCapabilities,
        minimum_published_capabilities: 6,
        status,
        ...(status === 'accepted' ? {} : { reason: 'catalog quality gate did not pass' }),
      },
    },
  } as CASOutput;
}

function layer(output: CASOutput, id: 'L4' | 'L5') {
  return buildCompletedAnalysisLayersReady(output).layers.find(candidate => candidate.layer === id);
}

test('marks L4 and L5 ready only when required capability comprehension is accepted', () => {
  const output = outputWithCatalog('accepted', 8);
  const readiness = buildCompletedAnalysisLayersReady(output);

  assert.equal(layer(output, 'L4')?.status, 'ready');
  assert.equal(layer(output, 'L5')?.status, 'ready');
  assert.equal(readiness.complete, true);
});

test('rejects false L4 and L5 readiness when an AI catalog publishes no capabilities', () => {
  const output = outputWithCatalog('rejected', 0);
  const readiness = buildCompletedAnalysisLayersReady(output);

  assert.equal(layer(output, 'L4')?.status, 'error');
  assert.match(layer(output, 'L4')?.error || '', /catalog quality gate did not pass/);
  assert.equal(layer(output, 'L5')?.status, 'error');
  assert.equal(readiness.complete, false);
});

test('keeps a grounded partial catalog queryable without claiming its layers are complete', () => {
  const output = outputWithCatalog('partial', 5);

  assert.equal(layer(output, 'L4')?.status, 'error');
  assert.equal(layer(output, 'L5')?.status, 'error');
  assert.equal(output.enhanced_system_purpose?.capability_catalog_coverage?.published_capabilities, 5);
});

test('reports disabled required AI comprehension as an L5 error', () => {
  const output = {
    analysis_timestamp: '2026-08-20T00:00:00.000Z',
    ai_enrichment: 'disabled',
  } as CASOutput;

  assert.equal(layer(output, 'L5')?.status, 'error');
  assert.match(layer(output, 'L5')?.error || '', /disabled/);
});
