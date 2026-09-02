import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';

export type ComprehensionReadinessStatus = 'ready' | 'partial' | 'pending' | 'unavailable' | 'error';

export interface ComprehensionReadiness {
  status: ComprehensionReadinessStatus;
  ready: boolean;
  canonical_capabilities: number;
  structural_candidates: number;
  catalog_coverage: string;
  reason: string;
}

export interface ComprehensionGateResult {
  status: 'pass' | 'warn' | 'fail';
  score: number;
  detail: string;
}

function canonicalCapabilityCount(cas: CASOutput): number {
  const canonicalCatalog = (cas.capabilities || []).length > 0
    ? cas.capabilities || []
    : cas.product_map?.capabilities || [];
  const identities = new Set<string>();
  for (const capability of canonicalCatalog) {
    const identity = String(('id' in capability ? capability.id : undefined) || capability.name || '').trim().toLowerCase();
    if (identity) identities.add(identity);
  }
  return identities.size;
}

export function evaluateComprehensionReadiness(cas: CASOutput): ComprehensionReadiness {
  const canonicalCapabilities = canonicalCapabilityCount(cas);
  const structuralCandidates = Math.max(
    cas.structural_capability_candidates?.length || 0,
    cas.flow_graph?.capability_candidates?.length || 0,
  );
  const coverage = cas.enhanced_system_purpose?.capability_catalog_coverage;
  const coverageStatus = coverage?.status || 'unreported';
  const l5 = cas.layers_ready?.layers?.find(layer => layer.layer === 'L5');
  const failed = cas.ai_enrichment === 'error' || l5?.status === 'error';
  const pending = cas.ai_enrichment === 'pending' || l5?.status === 'pending';
  const settled = cas.ai_enrichment === 'ready' || cas.ai_enrichment === 'synchronous' || l5?.status === 'ready';
  const accepted = coverageStatus === 'accepted';
  const minimum = coverage?.minimum_published_capabilities ?? 0;
  const ready = settled && accepted && canonicalCapabilities >= minimum;

  if (ready) {
    return {
      status: 'ready',
      ready: true,
      canonical_capabilities: canonicalCapabilities,
      structural_candidates: structuralCandidates,
      catalog_coverage: coverageStatus,
      reason: `${canonicalCapabilities} canonical product capabilities passed catalog coverage`,
    };
  }
  if (failed) {
    return {
      status: 'error',
      ready: false,
      canonical_capabilities: canonicalCapabilities,
      structural_candidates: structuralCandidates,
      catalog_coverage: coverageStatus,
      reason: cas.ai_enrichment_error || l5?.error || 'AI comprehension failed',
    };
  }
  if (pending) {
    return {
      status: 'pending',
      ready: false,
      canonical_capabilities: canonicalCapabilities,
      structural_candidates: structuralCandidates,
      catalog_coverage: coverageStatus,
      reason: 'AI comprehension has not settled',
    };
  }
  if (canonicalCapabilities > 0) {
    return {
      status: 'partial',
      ready: false,
      canonical_capabilities: canonicalCapabilities,
      structural_candidates: structuralCandidates,
      catalog_coverage: coverageStatus,
      reason: accepted
        ? `${canonicalCapabilities}/${minimum} required canonical capabilities were published`
        : `${canonicalCapabilities} canonical capabilities exist without accepted catalog coverage`,
    };
  }
  return {
    status: 'unavailable',
    ready: false,
    canonical_capabilities: 0,
    structural_candidates: structuralCandidates,
    catalog_coverage: coverageStatus,
    reason: cas.ai_enrichment === 'disabled'
      ? 'AI comprehension is disabled; structural candidates are not canonical product capabilities'
      : coverage?.reason || 'No canonical product capabilities are available',
  };
}

export function buildComprehensionGate(cas: CASOutput, readiness: ComprehensionReadiness): ComprehensionGateResult {
  const invalidCatalog = cas.enhanced_system_purpose?.capability_catalog_coverage === undefined;
  const rejectedCatalog = cas.enhanced_system_purpose?.capability_catalog_coverage?.status === 'rejected';
  const status = readiness.ready
    ? 'pass'
    : readiness.status === 'error' || invalidCatalog || rejectedCatalog ? 'fail' : 'warn';
  const score = readiness.ready ? 100 : readiness.status === 'partial' ? 80 : status === 'fail' ? 0 : 65;
  return { status, score, detail: readiness.reason };
}
