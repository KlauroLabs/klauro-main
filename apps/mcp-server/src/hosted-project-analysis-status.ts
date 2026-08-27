import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { isStructuralAnalysisLayer, unavailableComprehensionResponse } from './analysis-response-readiness';
import { getCachedDeployableAnalyses, type SubCasNodeIndex } from './deployable-analysis';
import { buildSummary, getProductMap } from './query';

export function buildHostedProjectAnalysisStatus(
  cas: CASOutput,
  projectId: string,
  analysisId: string,
  subCasNodes?: SubCasNodeIndex,
): Record<string, unknown> {
  const summary = buildSummary(cas, { detail: 'compact' }) as Record<string, unknown>;
  summary.sub_cas_nodes = subCasNodes || getCachedDeployableAnalyses(cas).sub_cas_nodes;
  const layers = cas.layers_ready?.layers || [];
  const pending = layers.some(layer => layer.status === 'pending');
  const errors = layers.filter(layer => layer.status === 'error');
  const structuralErrors = errors.filter(layer => isStructuralAnalysisLayer(layer.layer));
  const aiDegraded = cas.ai_enrichment === 'error' || (errors.some(layer => layer.layer === 'L4' || layer.layer === 'L5') && !pending);
  const naming = cas.enhanced_system_purpose?.capability_naming_coverage;
  const nameDegradations = cas.enhanced_system_purpose?.capability_name_degradations || [];
  const descriptionDegradations = cas.enhanced_system_purpose?.capability_description_degradations || [];
  const comprehensionAttempted = ['ready', 'synchronous', 'error'].includes(cas.ai_enrichment || '');
  const namingTotal = naming?.total || 0;
  const namingAuthored = naming?.authored || 0;
  const comprehensionFailed = aiDegraded;
  const comprehensionPartial = !aiDegraded && (
    (comprehensionAttempted && namingTotal > 0 && namingAuthored < namingTotal)
    || nameDegradations.length > 0
    || descriptionDegradations.length > 0
  );
  const enriched = (source: string | undefined): boolean => ['ai', 'manual', 'reused'].includes(source || '');
  const unenriched = comprehensionPartial ? (cas.capabilities || []).flatMap(capability => {
    const nameShort = !enriched(capability.name_source);
    const descriptionShort = !enriched(capability.description_source);
    if (!nameShort && !descriptionShort) return [];
    const missing = nameShort && descriptionShort ? 'name and description' : nameShort ? 'name' : 'description';
    return capability.name ? [{ name: capability.name, missing }] : [];
  }) : [];
  const status = structuralErrors.length > 0
    ? 'failed'
    : cas.layers_ready && !cas.layers_ready.complete && pending
      ? 'populating'
      : comprehensionFailed ? 'degraded' : 'ready';
  const unavailable = unavailableComprehensionResponse(cas, { project_id: projectId, analysis_id: analysisId });

  return {
    status,
    ...(structuralErrors.length > 0 ? {
      analysis_error: structuralErrors.find(layer => layer.error)?.error || 'The analysis failed before structure could be produced.',
      failed_layers: structuralErrors.map(layer => layer.layer),
    } : {}),
    ...(comprehensionFailed ? {
      ai_enrichment: 'error',
      ai_enrichment_error: cas.ai_enrichment_error || errors.find(layer => layer.layer === 'L5' && layer.error)?.error || 'AI comprehension pass failed; comprehension is AI-only (no deterministic fallback)',
    } : {}),
    ...(comprehensionFailed || comprehensionPartial ? {
      comprehension: {
        degraded: comprehensionFailed,
        partial: comprehensionPartial,
        ...(naming ? { capability_naming_coverage: naming } : {}),
        capability_name_degradations: nameDegradations.length,
        capability_description_degradations: descriptionDegradations.length,
        ...(unenriched.length > 0 ? { unenriched_capabilities: unenriched } : {}),
        detail: comprehensionFailed
          ? 'The AI comprehension pass failed; capability names and descriptions are un-enriched deterministic facts.'
          : unenriched.length > 0
            ? `${unenriched.length} of ${naming?.total ?? '?'} capabilities fell short of full AI enrichment (${unenriched.map(entry => `${entry.name}: ${entry.missing}`).join('; ')}); those fields carry deterministic evidence text, not authored comprehension. The analysis is otherwise complete and fully queryable.`
            : 'Part of the capability catalog could not be AI-enriched; those entries carry deterministic evidence text, not authored comprehension.',
      },
    } : {}),
    project_id: projectId,
    analysis_id: analysisId,
    summary,
    ...(!unavailable ? { product_map: getProductMap(cas) } : {}),
  };
}
