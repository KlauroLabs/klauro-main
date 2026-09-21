import test from 'node:test';
import assert from 'node:assert/strict';
import type { CASOutput, EnhancedSystemPurpose } from '../../types/cas.types';
import { comprehensionAiPhaseStatus, comprehensionNarrativeFailure, applyComprehensionNarrativeStatus } from './comprehension-status';

const acceptedNarrative = {
  inferred_description: 'Patients schedule appointments with available clinicians.',
  description_source: 'ai' as const,
  description_generation: { status: 'ai_applied' as const, attempted: true },
};
const purpose = (overrides: Record<string, unknown> = {}): EnhancedSystemPurpose => ({
  ...acceptedNarrative,
  capability_catalog_coverage: { status: 'accepted', evidence_families: 1, published_capabilities: 1 },
  ...overrides,
} as EnhancedSystemPurpose);

test('a catalog and a validated narrative are both required for complete comprehension', () => {
  assert.equal(comprehensionAiPhaseStatus(purpose()), 'complete');
  assert.equal(comprehensionAiPhaseStatus(purpose({ inferred_description: '  ' })), 'degraded');
  assert.equal(comprehensionAiPhaseStatus(purpose({ capability_catalog_coverage: undefined })), 'degraded');
  assert.equal(comprehensionAiPhaseStatus(purpose({ capability_description_degradations: [{ id: 'cap', reason: 'missing' }] })), 'degraded');
});

test('rejected and failed narratives retain their concrete reason even with stale text', () => {
  for (const status of ['ai_rejected', 'ai_failed'] as const) {
    const input = purpose({ description_generation: { status, attempted: true, reason: 'omits-core-capability' } });
    assert.match(comprehensionNarrativeFailure(input) || '', /omits-core-capability/);
    assert.equal(comprehensionAiPhaseStatus(input), 'degraded');
  }
});

test('accepted manual and reused narrative origins remain valid; deterministic or unknown text does not become AI', () => {
  assert.equal(comprehensionNarrativeFailure(purpose({ description_source: 'manual', description_generation: undefined })), undefined);
  assert.equal(comprehensionNarrativeFailure(purpose({ description_source: 'reused',
    description_generation: { status: 'reused_previous', attempted: false, origin_source: 'ai' } })), undefined);
  for (const source of ['deterministic', undefined]) {
    assert.ok(comprehensionNarrativeFailure(purpose({ description_source: source, description_generation: undefined })));
  }
  assert.ok(comprehensionNarrativeFailure(purpose({ description_source: 'reused',
    description_generation: { status: 'reused_previous', attempted: false, origin_source: 'deterministic' } })));
});

test('canonical settlement records self-analysis narrative failure without deleting capabilities or failing other phases', () => {
  const cas = {
    layers_ready: { layers: [{ layer: 'L5', name: 'comprehension', status: 'ready' }] } as never,
    capabilities: [{ id: 'cap', name: 'Understand what a codebase actually built' }],
    enhanced_system_purpose: purpose({ ai_phase_status: 'complete', inferred_description: '',
      description_generation: { status: 'ai_rejected', attempted: true, reason: 'omits-core-capability' } }),
    analysis_phases: [{ id: 'core-graph', status: 'complete' }, { id: 'agent-context', status: 'complete' },
      { id: 'ai-system-narrative', status: 'complete' }],
  } as CASOutput;
  const capabilities = structuredClone(cas.capabilities);
  applyComprehensionNarrativeStatus(cas);
  applyComprehensionNarrativeStatus(cas);
  assert.equal(cas.enhanced_system_purpose?.ai_phase_status, 'degraded');
  assert.equal(cas.analysis_errors?.length, 1);
  assert.equal(cas.analysis_errors?.[0].code, 'SYSTEM_NARRATIVE_REJECTED');
  assert.match(cas.analysis_errors?.[0].message || '', /omits-core-capability/);
  assert.deepEqual(cas.capabilities, capabilities);
  assert.equal(cas.analysis_phases?.[0].status, 'complete');
  assert.equal(cas.analysis_phases?.[1].status, 'complete');
  assert.equal(cas.analysis_phases?.[2].status, 'failed');

  Object.assign(cas.enhanced_system_purpose!, acceptedNarrative);
  applyComprehensionNarrativeStatus(cas);
  assert.equal(cas.enhanced_system_purpose?.ai_phase_status, 'complete');
  assert.deepEqual(cas.analysis_errors, []);
  assert.equal(cas.analysis_phases?.[2].status, 'complete');
});

test('pending work is not rejected before it has had a chance to generate a narrative', () => {
  const cas = { layers_ready: { layers: [{ layer: 'L5', name: 'comprehension', status: 'pending' }] }, enhanced_system_purpose: purpose({ inferred_description: '' }) } as unknown as CASOutput;
  applyComprehensionNarrativeStatus(cas);
  assert.equal(cas.analysis_errors, undefined);
});
