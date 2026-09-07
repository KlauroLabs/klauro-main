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
      inferred_description: 'Patients schedule appointments with available clinicians.',
      description_source: 'ai',
      capability_catalog_coverage: {
        evidence_families: 35,
        published_capabilities: publishedCapabilities,
        status,
        ...(status === 'accepted' ? {} : { reason: 'catalog quality gate did not pass' }),
      },
    },
  } as unknown as CASOutput;
}

function layer(output: CASOutput, id: 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5') {
  return buildCompletedAnalysisLayersReady(output).layers.find(candidate => candidate.layer === id);
}

test('marks L4 and L5 ready only when required capability comprehension is accepted', () => {
  const output = outputWithCatalog('accepted', 8);
  const readiness = buildCompletedAnalysisLayersReady(output);

  assert.equal(layer(output, 'L4')?.status, 'ready');
  assert.equal(layer(output, 'L5')?.status, 'ready');
  assert.equal(readiness.complete, true);
});

test('does not trust complete metadata over a rejected or missing narrative in an accepted catalog', () => {
  const output = outputWithCatalog('accepted', 6);
  Object.assign(output.enhanced_system_purpose!, {
    inferred_description: '',
    description_generation: { status: 'ai_rejected', attempted: true, reason: 'omits-core-capability' },
  });
  assert.equal(layer(output, 'L4')?.status, 'ready');
  assert.equal(layer(output, 'L5')?.status, 'error');
  assert.match(layer(output, 'L5')?.error || '', /omits-core-capability/);
  assert.equal(output.capabilities?.length, 6);
  assert.equal(buildCompletedAnalysisLayersReady(output).complete, false);

  output.enhanced_system_purpose!.description_generation = { status: 'ai_applied', attempted: true };
  assert.equal(layer(output, 'L5')?.status, 'error');
  assert.match(layer(output, 'L5')?.error || '', /missing/i);
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

test('incomplete source coverage degrades the structural layers to ready-with-warning, never to error', () => {
  // One oversized or partially parsed file must not zero a product that was
  // otherwise fully extracted: confidence degrades, existence does not.
  const scopes = [
    { files_eligible: 3, files_analyzed: 2, files_skipped: 0, complete: true },
    { files_eligible: 3, files_analyzed: 3, files_skipped: 1, complete: true },
    { files_eligible: 3, files_analyzed: 3, files_skipped: 0, complete: false },
    { files_eligible: 3, files_analyzed: 3, files_skipped: 0, files_partial: 1, complete: false },
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

    assert.equal(readiness.complete, true);
    for (const candidate of readiness.layers) {
      assert.equal(candidate.status, 'ready');
      assert.equal(candidate.error, undefined);
    }
    for (const structural of ['L0', 'L1', 'L2', 'L3'] as const) {
      assert.match(layer(output, structural)?.warning || '', /Canonical source extraction is partial.*partial-analyzer/);
    }
  }
  const partialOnly = outputWithCatalog('accepted', 8);
  partialOnly.analyzer_contributions = [{
    analyzer_id: 'typescript-javascript',
    analyzer_name: 'TypeScript',
    contribution_type: 'language',
    analysis_scope: { files_eligible: 400, files_analyzed: 400, files_skipped: 0, files_partial: 1, complete: false },
  }];
  assert.match(layer(partialOnly, 'L0')?.warning || '', /analyzed 400 of 400, 1 partially parsed/);
});

test('fails every derived layer only when nothing was extracted from eligible source at all', () => {
  const output = outputWithCatalog('accepted', 8);
  output.analyzer_contributions = [{
    analyzer_id: 'typescript-javascript',
    analyzer_name: 'TypeScript',
    contribution_type: 'language',
    analysis_scope: { files_eligible: 12, files_analyzed: 0, files_skipped: 12, complete: false },
  }];
  const readiness = buildCompletedAnalysisLayersReady(output);

  assert.equal(readiness.complete, false);
  for (const candidate of readiness.layers) {
    assert.equal(candidate.status, 'error');
    assert.match(candidate.error || '', /no eligible source file was analyzed \(12 eligible\)/);
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

test('accepts an explicitly valid empty catalog when no outcomes are grounded', () => {
  const output = outputWithCatalog('accepted', 0);

  assert.equal(layer(output, 'L4')?.status, 'ready');
  assert.equal(layer(output, 'L5')?.status, 'ready');
});

test('fails when accepted coverage disagrees with the canonical catalog count', () => {
  const output = outputWithCatalog('accepted', 0);
  output.enhanced_system_purpose!.capability_catalog_coverage!.published_capabilities = 1;

  assert.equal(layer(output, 'L4')?.status, 'error');
  assert.match(layer(output, 'L4')?.error || '', /reports 1 published capabilities.*contains 0/);
  assert.equal(layer(output, 'L5')?.status, 'error');
});
