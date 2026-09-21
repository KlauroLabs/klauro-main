import type { CASOutput, EnhancedSystemPurpose } from '../../types/cas.types';

export function comprehensionSettled(output: CASOutput): boolean {
  const comprehension = output.layers_ready?.layers
    ?.filter(layer => layer.layer === 'L4' || layer.layer === 'L5') || [];
  return comprehension.length > 0 && comprehension.every(layer => layer.status !== 'pending');
}

export function applyComprehensionNarrativeStatus(output: CASOutput): void {
  if (!comprehensionSettled(output)) return;
  const purpose = output.enhanced_system_purpose;
  if (purpose) purpose.ai_phase_status = comprehensionAiPhaseStatus(purpose);
  const failure = comprehensionNarrativeFailure(purpose);
  const code = 'SYSTEM_NARRATIVE_REJECTED';
  const previous = output.analysis_errors?.find(error => error.code === code);
  const phase = output.analysis_phases?.find(item => item.id === 'ai-system-narrative');
  if (!failure) {
    if (previous) output.analysis_errors = output.analysis_errors?.filter(error => error.code !== code);
    if (previous && phase?.status === 'failed' && phase.notes?.includes(previous.message)) {
      phase.status = 'complete';
      phase.notes = phase.notes.filter(note => note !== previous.message);
    }
    return;
  }
  output.analysis_errors ||= [];
  if (previous) previous.message = failure;
  else output.analysis_errors.push({
    severity: 'error', code, message: failure, analyzer: 'comprehension',
    recoverable: true, suggestion: 'Retry system narrative comprehension; accepted capabilities and structural evidence remain available.',
  });
  if (phase) {
    phase.status = 'failed';
    phase.notes = [failure];
  }
}

type NarrativeStatus = Partial<Pick<EnhancedSystemPurpose,
  'inferred_description' | 'description_source' | 'description_generation'>>;

export function comprehensionNarrativeFailure(purpose?: NarrativeStatus): string | undefined {
  const generation = purpose?.description_generation;
  if (generation?.status === 'ai_rejected' || generation?.status === 'ai_failed') {
    return `AI system narrative ${generation.status}: ${generation.reason || 'required narrative did not pass'}`;
  }
  if (!purpose?.inferred_description?.trim()) return 'AI system narrative is missing';
  if (purpose.description_source === 'manual') return undefined;
  if (generation?.status === 'ai_skipped' || generation?.status === 'deterministic_initial' ||
    generation?.status === 'deterministic_kept' || purpose.description_source === 'deterministic' ||
    generation?.origin_source === 'deterministic') return 'System narrative has no accepted AI or manual interpretation';
  if (purpose.description_source === 'ai' || generation?.status === 'ai_applied' ||
    (purpose.description_source === 'reused' && (generation?.origin_source === 'ai' || generation?.origin_source === 'manual'))) return undefined;
  return 'System narrative provenance is unreported';
}

export function comprehensionAiPhaseStatus(
  purpose: NarrativeStatus & {
    capability_catalog_coverage?: { evidence_families: number; status: 'accepted' | 'partial' | 'rejected' | 'unavailable' };
    capability_description_degradations?: EnhancedSystemPurpose['capability_description_degradations'];
  },
): 'complete' | 'degraded' {
  return purpose.capability_catalog_coverage?.status !== 'accepted' ||
    comprehensionNarrativeFailure(purpose) || purpose.capability_description_degradations?.length
    ? 'degraded' : 'complete';
}

export function synchronizeCapabilityCatalogCoverage(
  purpose: EnhancedSystemPurpose,
  publishedCapabilities: number,
  excludedCapabilities: number,
): void {
  const coverage = purpose.capability_catalog_coverage;
  if (coverage) {
    const preserveRejectedCandidates = coverage.status === 'rejected' && coverage.published_capabilities === 0;
    coverage.actual_publishable_capabilities = preserveRejectedCandidates ? Math.max(coverage.actual_publishable_capabilities || 0, publishedCapabilities) : publishedCapabilities;
    coverage.published_capabilities = publishedCapabilities;
    if (excludedCapabilities > 0 && coverage.status === 'accepted') {
      coverage.status = 'rejected';
      coverage.reason = `${excludedCapabilities} catalog capability ${excludedCapabilities === 1 ? 'was' : 'were'} excluded during final publishability validation`;
    }
  }
  purpose.ai_phase_status = comprehensionAiPhaseStatus(purpose);
}
