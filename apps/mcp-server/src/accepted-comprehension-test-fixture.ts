import type { CASOutput, EnhancedSystemPurpose } from '../../../packages/analyzer-core/src/types/cas.types';
import { buildCompletedAnalysisLayersReady } from './layered-analysis';

export function acceptedComprehensionFixture(cas: CASOutput): CASOutput {
  const existingCapabilities = cas.capabilities || [];
  const analyzerCandidates = cas.behavior_surfaces || [];
  const entryPoint = cas.entry_points?.[0];
  const canonicalCapabilities = existingCapabilities.length > 0
    ? existingCapabilities
    : analyzerCandidates.length > 0
      ? analyzerCandidates
      : entryPoint
        ? [{
            id: `fixture-capability-${entryPoint.id}`,
            name: entryPoint.name,
            description: `${entryPoint.type} behavior exposed by ${entryPoint.name}`,
            category: 'core' as const,
            operations: [{ entry_point_id: entryPoint.id, entry_point_type: entryPoint.type, action: entryPoint.name }],
            related_entities: [],
            related_domains: [],
            criticality: 'medium' as const,
            criticality_factors: ['analyzer-derived entry point'],
          }]
        : [];
  if (canonicalCapabilities.length === 0) throw new Error('Accepted comprehension fixture requires analyzer-derived capability evidence');
  const enhanced = cas.enhanced_system_purpose || {
    primary_type: cas.system.type,
    primary_domain: cas.system.type,
    confidence: 1,
    evidence: ['analyzer-derived capability catalog'],
    core_concepts: [],
    inferred_description: cas.system.name,
    supporting_workflow_ids: [],
  } as EnhancedSystemPurpose;
  const accepted: CASOutput = {
    ...cas,
    capabilities: canonicalCapabilities,
    ai_enrichment: 'ready',
    ai_enrichment_error: undefined,
    enhanced_system_purpose: {
      ...enhanced,
      ai_phase_status: 'complete',
      inferred_description: enhanced.inferred_description || cas.system.name,
      description_source: 'ai',
      description_generation: { status: 'ai_applied', attempted: true },
      capability_description_degradations: undefined,
      capability_catalog_coverage: {
        evidence_families: Math.max(1, enhanced.capability_catalog_coverage?.evidence_families || 0),
        published_capabilities: canonicalCapabilities.length,
        status: 'accepted',
      },
    },
  };
  accepted.layers_ready = buildCompletedAnalysisLayersReady(accepted);
  return accepted;
}
