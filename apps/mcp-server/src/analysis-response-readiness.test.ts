import assert from 'node:assert/strict';
import test from 'node:test';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import {
  comprehensionResponseReadiness,
  hostedQueryResponseReadiness,
  paginateConceptualCatalog,
  parseConceptualCatalogPage,
  unavailableComprehensionResponse,
  failedAttemptHasQueryableAnalysis,
  unavailableLatestAnalyzeAttempt,
  unavailableStructuralQueryResponse,
} from './analysis-response-readiness';
import { evaluateComprehensionReadiness } from './comprehension-readiness';

function cas(overrides: Record<string, unknown> = {}): CASOutput {
  return {
    cas_version: '3.0.0',
    analysis_id: 'analysis-readiness-fixture',
    analysis_timestamp: '2026-08-20T00:00:00.000Z',
    system: { id: 'fixture', name: 'Fixture', type: 'application', root_path: '/fixture' },
    nodes: [],
    edges: [],
    analyzer_contributions: [],
    ...overrides,
  } as unknown as CASOutput;
}

test('comprehension responses fail closed when L4 or L5 failed', () => {
  const result = comprehensionResponseReadiness(cas({
    layers_ready: {
      complete: false,
      layers: [
        { layer: 'L4', name: 'Flows, capabilities, contracts', status: 'error', error: 'Capability catalog is partial', fields: ['capabilities'] },
        { layer: 'L5', name: 'AI enrichment', status: 'error', error: 'Capability catalog is partial', fields: ['enhanced_system_purpose'] },
      ],
    },
    capabilities: [{ id: 'partial', name: 'Partial result' }],
  }));

  assert.equal(result.status, 'failed');
  assert.equal(result.ready, false);
  assert.deepEqual(result.failed_layers, ['L4', 'L5']);
  assert.match(String(result.error), /partial/);
});

test('settled but unaccepted comprehension is partial, never ready', () => {
  const result = comprehensionResponseReadiness(cas({
    ai_enrichment: 'ready',
    layers_ready: {
      complete: true,
      layers: [
        { layer: 'L4', name: 'Flows, capabilities, contracts', status: 'ready', fields: ['capabilities'] },
        { layer: 'L5', name: 'AI enrichment', status: 'ready', fields: ['enhanced_system_purpose'] },
      ],
    },
    capabilities: [{ id: 'cap-partial', name: 'Partial capability' }],
    enhanced_system_purpose: { capability_catalog_coverage: { status: 'partial', minimum_published_capabilities: 1 } },
  }));

  assert.equal(result.status, 'partial');
  assert.equal(result.ready, false);
});

test('readiness gating is scoped to comprehension-dependent hosted queries', () => {
  const failed = cas({
    layers_ready: {
      complete: false,
      layers: [{ layer: 'L4', name: 'Flows', status: 'error', error: 'failed', fields: ['flows'] }],
    },
  });
  assert.equal(hostedQueryResponseReadiness(failed, 'run_answer_pack').status, 'failed');
  assert.equal(hostedQueryResponseReadiness(failed, 'get_product_map').status, 'failed');
  assert.equal(hostedQueryResponseReadiness(failed, 'search_nodes').status, 'ready');
});

test('an L4-only failure does not block structural hosted queries', () => {
  const layers = [
    { layer: 'L0', status: 'ready' },
    { layer: 'L1', status: 'ready' },
    { layer: 'L2', status: 'ready' },
    { layer: 'L3', status: 'ready' },
    { layer: 'L4', status: 'error', error: 'catalog failed' },
  ];
  assert.equal(unavailableStructuralQueryResponse(layers, {
    project_id: 'project', analysis_id: 'analysis', tool: 'search_nodes',
  }), undefined);
  assert.equal(unavailableStructuralQueryResponse(layers, {
    project_id: 'project', analysis_id: 'analysis', tool: 'run_answer_pack',
  })?.status, undefined, 'L4 remains governed by the comprehension readiness response, not structural failure handling');
});

test('a failed attempt cannot degrade onto a current entry whose structural layers are still pending', () => {
  const attempt = { state: 'failed', started_at: '2026-08-27T10:00:00.000Z' };
  const entry = {
    analyzed_at: '2026-08-27T10:00:01.000Z',
    layers_ready: { layers: [
      { layer: 'L0', status: 'ready' }, { layer: 'L1', status: 'ready' },
      { layer: 'L2', status: 'pending' }, { layer: 'L3', status: 'ready' },
      { layer: 'L4', status: 'pending' }, { layer: 'L5', status: 'pending' },
    ] },
  };
  assert.equal(failedAttemptHasQueryableAnalysis(entry, attempt), false);
});

test('failed hosted queries include a compact legacy-client result without partial analysis data', () => {
  const failed = cas({
    layers_ready: {
      complete: false,
      layers: [{ layer: 'L4', name: 'Flows', status: 'error', error: 'catalog partial', fields: ['flows'] }],
    },
    product_map: { capabilities: [{ id: 'must-not-leak' }] },
  });
  const response = unavailableComprehensionResponse(failed, {
    project_id: 'project', analysis_id: 'analysis', tool: 'run_answer_pack',
  }, 'run_answer_pack');
  assert.deepEqual(response, {
    status: 'failed',
    project_id: 'project',
    analysis_id: 'analysis',
    tool: 'run_answer_pack',
    failed_layers: ['L4'],
    error: 'catalog partial',
    result: { status: 'failed', failed_layers: ['L4'], error: 'catalog partial' },
  });
  assert.equal('product_map' in (response || {}), false);
  assert.doesNotThrow(() => JSON.stringify(response?.result).length, 'published clients must receive a serializable result');
});

test('a failed latest committed-source attempt cannot expose a prior ready generation as current', () => {
  const response = unavailableLatestAnalyzeAttempt(
    { state: 'failed', trigger: 'analyze', reason: 'capability catalog omitted cap_history' },
    { project_id: 'project', analysis_id: 'analysis', tool: 'get_product_map' },
  );
  assert.equal(response?.status, 'failed');
  assert.equal(response?.result?.status, 'failed');
  assert.match(response?.error || '', /cap_history/);
  assert.equal(unavailableLatestAnalyzeAttempt(
    { state: 'failed', trigger: 'reanalyze', reason: 'retry failed' },
    { project_id: 'project', analysis_id: 'analysis' },
  )?.status, 'failed', 'a failed reanalysis must not expose the prior generation as current');
});

test('legacy CAS without a layer manifest remains queryable', () => {
  assert.deepEqual(comprehensionResponseReadiness(cas()), { status: 'ready', ready: true });
});

test('conceptual catalog pages are bounded and disclose exact continuation offsets', () => {
  const requested = parseConceptualCatalogPage(new URLSearchParams('capability_limit=1000&capability_offset=100'));
  assert.deepEqual(requested, { limit: 100, offset: 100 });
  const catalog = paginateConceptualCatalog(
    Array.from({ length: 205 }, (_, index) => `cap-${index}`),
    Array.from({ length: 101 }, (_, index) => `surface-${index}`),
    requested,
  );
  assert.equal(catalog.capabilities.values.length, 100);
  assert.deepEqual(catalog.capabilities.page, {
    total: 205, offset: 100, limit: 100, returned: 100, has_more: true, next_offset: 200,
  });
  assert.deepEqual(catalog.behavior_surfaces.page, {
    total: 101, offset: 100, limit: 100, returned: 1, has_more: false, next_offset: null,
  });
});

test('conceptual catalog paging accepts explicit names while preserving legacy aliases', () => {
  assert.deepEqual(parseConceptualCatalogPage(new URLSearchParams()), { limit: 5, offset: 0 });
  assert.deepEqual(
    parseConceptualCatalogPage(new URLSearchParams('catalog_limit=7&catalog_offset=14')),
    { limit: 7, offset: 14 },
  );
  assert.deepEqual(
    parseConceptualCatalogPage(new URLSearchParams('capability_limit=8&capability_offset=16')),
    { limit: 8, offset: 16 },
  );
});

test('readiness counts the authoritative capability catalog instead of summing duplicate views', () => {
  const capabilities = Array.from({ length: 15 }, (_, index) => ({
    id: `capability_${index}`,
    name: `Capability ${index}`,
  }));
  const readiness = evaluateComprehensionReadiness(cas({
    capabilities,
    product_map: {
      capabilities: capabilities.map((capability, index) => ({
        ...capability,
        id: `product_${index}`,
      })),
    },
    ai_enrichment: 'ready',
    enhanced_system_purpose: {
      capability_catalog_coverage: { status: 'accepted', minimum_published_capabilities: 1 },
    },
  }));

  assert.equal(readiness.canonical_capabilities, 15);
  assert.equal(readiness.reason, '15 canonical product capabilities passed catalog coverage');
});
