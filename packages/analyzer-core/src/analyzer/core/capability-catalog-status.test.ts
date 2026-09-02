import test from 'node:test';
import assert from 'node:assert/strict';
import type { CASOutput } from '../../types/cas.types';
import { applyCapabilityCatalogStatus, capabilityCatalogErrorCode } from './capability-catalog-status';

function output(status: 'accepted' | 'rejected', capabilities: number): CASOutput {
  return {
    ai_enrichment: 'synchronous',
    capabilities: Array.from({ length: capabilities }, (_, index) => ({ id: `cap-${index}`, name: `Capability ${index}` })),
    enhanced_system_purpose: {
      ai_phase_status: status === 'accepted' ? 'complete' : 'degraded',
      capability_catalog_coverage: {
        evidence_families: 12,
        published_capabilities: capabilities,
        minimum_published_capabilities: 4,
        status,
        ...(status === 'rejected' ? { reason: 'catalog omitted required operation obligations' } : {}),
      },
    },
    analysis_phases: [
      { id: 'agent-context', name: 'Agent context', priority: 2, status: 'partial', purpose: 'agent-development', default_phase: true, description: '', outputs: [], agent_value: '', visualization_value: '', can_run_later: false },
      { id: 'ai-system-narrative', name: 'AI narrative', priority: 3, status: 'complete', purpose: 'ai-enrichment', default_phase: true, description: '', outputs: [], agent_value: '', visualization_value: '', can_run_later: true },
    ],
    analysis_errors: [],
  } as unknown as CASOutput;
}

test('rejected catalog records one hard error and fails agent context without failing the narrative phase', () => {
  const cas = output('rejected', 0);
  applyCapabilityCatalogStatus(cas);
  applyCapabilityCatalogStatus(cas);

  assert.equal(cas.analysis_errors?.length, 1);
  assert.equal(cas.analysis_errors?.[0].code, capabilityCatalogErrorCode());
  assert.match(cas.analysis_errors?.[0].message || '', /omitted required operation obligations/);
  assert.equal(cas.analysis_phases?.find(phase => phase.id === 'agent-context')?.status, 'failed');
  assert.match(cas.analysis_phases?.find(phase => phase.id === 'agent-context')?.notes?.[0] || '', /catalog was rejected/i);
  assert.equal(cas.analysis_phases?.find(phase => phase.id === 'ai-system-narrative')?.status, 'complete');
  assert.equal(cas.ai_enrichment, 'synchronous');
});

test('accepted non-empty catalog does not create an analysis error or alter phase status', () => {
  const cas = output('accepted', 2);
  cas.analysis_phases![0].status = 'complete';
  applyCapabilityCatalogStatus(cas);


  assert.deepEqual(cas.analysis_errors, []);
  assert.equal(cas.analysis_phases?.[0].status, 'complete');
  assert.equal(cas.analysis_phases?.[1].status, 'complete');
});

test('accepted empty catalog is valid when no audience outcome is grounded', () => {
  const cas = output('accepted', 0);
  cas.analysis_phases![0].status = 'complete';
  applyCapabilityCatalogStatus(cas);

  assert.deepEqual(cas.analysis_errors, []);
  assert.equal(cas.analysis_phases?.[0].status, 'complete');
});
