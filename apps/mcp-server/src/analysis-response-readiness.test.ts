import assert from 'node:assert/strict';
import test from 'node:test';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import {
  comprehensionResponseReadiness,
  hostedQueryResponseReadiness,
  paginateConceptualCatalog,
  parseConceptualCatalogPage,
  unavailableComprehensionResponse,
} from './analysis-response-readiness';

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
