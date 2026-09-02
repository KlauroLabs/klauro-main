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
    capabilities: Array.from({ length: publishedCapabilities }, (_, index) => ({
      id: `capability-${index}`,
      name: `Manage record ${index}`,
      operations: [],
      criticality_factors: [],
    })),
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
  } as unknown as CASOutput;
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

test('fails every derived layer when an analyzer reports incomplete source coverage', () => {
  const scopes = [
    { files_eligible: 3, files_analyzed: 2, files_skipped: 0, complete: true },
    { files_eligible: 3, files_analyzed: 3, files_skipped: 1, complete: true },
    { files_eligible: 3, files_analyzed: 3, files_skipped: 0, complete: false },
  ];

  for (const analysisScope of scopes) {
    const output = outputWithCatalog('accepted', 8);
    output.analyzer_contributions = [{
      analyzer_id: 'partial-analyzer',
      analyzer_name: 'Partial Analyzer',
      contribution_type: 'language',
      analysis_scope: analysisScope,
    }];
    const readiness = buildCompletedAnalysisLayersReady(output);

    assert.equal(readiness.complete, false);
    for (const candidate of readiness.layers) {
      assert.equal(candidate.status, 'error');
      assert.match(candidate.error || '', /Canonical source extraction is incomplete/);
    }
  }
});

test('fails structural readiness when a file-producing analyzer omits scope metadata', () => {
  const output = outputWithCatalog('accepted', 8);
  output.analyzer_contributions = [{
    analyzer_id: 'go',
    analyzer_name: 'Go Analyzer',
    contribution_type: 'language',
    files_created: 452,
  }];

  const readiness = buildCompletedAnalysisLayersReady(output);

  assert.equal(readiness.complete, false);
  for (const candidate of readiness.layers) {
    assert.equal(candidate.status, 'error');
    assert.match(candidate.error || '', /scope unreported.*go/);
  }
});

test('requires an explicit not-applicable scope from analyzers without file inputs', () => {
  const output = outputWithCatalog('accepted', 8);
  output.analyzer_contributions = [{
    analyzer_id: 'optional-library',
    analyzer_name: 'Optional Library Analyzer',
    contribution_type: 'library',
    files_created: 0,
  }];

  assert.equal(buildCompletedAnalysisLayersReady(output).complete, false);

  output.analyzer_contributions![0].analysis_scope = {
    applicability: 'not-applicable',
    files_eligible: 0,
    files_analyzed: 0,
    files_skipped: 0,
    complete: true,
  };
  assert.equal(buildCompletedAnalysisLayersReady(output).complete, true);
});

test('fails L4 and L5 when catalog coverage is absent', () => {
  const output = outputWithCatalog('accepted', 8);
  delete output.enhanced_system_purpose!.capability_catalog_coverage;

  assert.equal(layer(output, 'L4')?.status, 'error');
  assert.match(layer(output, 'L4')?.error || '', /coverage was not reported/);
  assert.equal(layer(output, 'L5')?.status, 'error');
});

test('accepts an explicitly valid empty catalog when no minimum outcome is required', () => {
  const output = outputWithCatalog('accepted', 0);
  output.enhanced_system_purpose!.capability_catalog_coverage!.minimum_published_capabilities = 0;

  assert.equal(layer(output, 'L4')?.status, 'ready');
  assert.equal(layer(output, 'L5')?.status, 'ready');
});

test('fails inconsistent accepted coverage below its declared minimum', () => {
  const output = outputWithCatalog('accepted', 0);

  assert.equal(layer(output, 'L4')?.status, 'error');
  assert.match(layer(output, 'L4')?.error || '', /0 of at least 6/);
  assert.equal(layer(output, 'L5')?.status, 'error');
});
