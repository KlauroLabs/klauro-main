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

function comprehensionIntegrityFailures(cas: CASOutput): string[] {
  const capabilities = (cas.capabilities || []).length > 0 ? cas.capabilities || [] : cas.product_map?.capabilities || [];
  const capabilityIds = new Set(capabilities.map(capability => 'id' in capability ? capability.id : '').filter(Boolean));
  const failures: string[] = [];
  const normalizedNames = new Set<string>();
  for (const capability of capabilities) {
    const normalizedName = String(capability.name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ');
    if (normalizedName && normalizedNames.has(normalizedName)) failures.push(`duplicate capability name: ${capability.name}`);
    if (normalizedName) normalizedNames.add(normalizedName);
  }
  const reconciliation = cas.enhanced_system_purpose?.capability_reconciliation;
  for (const proposal of reconciliation?.proposals || []) {
    const resolvedIds = proposal.capability_ids.filter(capabilityId => capabilityIds.has(capabilityId));
    if (proposal.disposition === 'grounded' && (proposal.capability_ids.length === 0 || resolvedIds.length !== proposal.capability_ids.length)) {
      failures.push(`grounded proposal has unresolved capability references: ${proposal.requirement_id}`);
    }
    if (proposal.disposition === 'intent-gap' && proposal.capability_ids.length > 0) {
      failures.push(`intent-gap proposal retains capability references: ${proposal.requirement_id}`);
    }
  }
  for (const undocumented of reconciliation?.undocumented_capabilities || []) {
    if (!capabilityIds.has(undocumented.capability_id)) failures.push(`undocumented capability reference does not resolve: ${undocumented.capability_id}`);
  }
  const flowIds = new Set((cas.flows || []).map(flow => flow.flow_id));
  const flowRelationshipTargetIds = new Set([
    ...capabilityIds,
    ...(cas.behavior_surfaces || []).map(surface => surface.id),
  ]);
  if (flowIds.size > 0) {
    for (const capability of cas.capabilities || []) {
      for (const relationship of capability.related_flows || []) {
        if (!flowIds.has(relationship.flow_id)) failures.push(`capability flow reference does not resolve: ${capability.id} -> ${relationship.flow_id}`);
      }
    }
    for (const flow of cas.flows || []) {
      if (flow.capability_id && !flowRelationshipTargetIds.has(flow.capability_id)) {
        failures.push(`flow capability reference does not resolve: ${flow.flow_id} -> ${flow.capability_id}`);
      }
      for (const relationship of flow.capability_relationships || []) {
        if (!flowRelationshipTargetIds.has(relationship.capability_id)) {
          failures.push(`flow capability relationship does not resolve: ${flow.flow_id} -> ${relationship.capability_id}`);
        }
      }
    }
  }
  const entryPointIds = new Set((cas.entry_points || []).map(entryPoint => entryPoint.id));
  const nodeIds = new Set((cas.nodes || []).map(node => node.id));
  if (entryPointIds.size > 0) {
    for (const capability of cas.capabilities || []) {
      for (const operation of capability.operations || []) {
        const nodeAnchor = operation.entry_point_id.startsWith('node:')
          ? operation.entry_point_id.slice('node:'.length) : undefined;
        if (operation.entry_point_id && !entryPointIds.has(operation.entry_point_id) && !(nodeAnchor && nodeIds.has(nodeAnchor))) {
          failures.push(`capability entry-point reference does not resolve: ${capability.id} -> ${operation.entry_point_id}`);
        }
      }
    }
  }
  return failures;
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
  const integrityFailures = comprehensionIntegrityFailures(cas);
  const ready = settled && accepted && canonicalCapabilities >= minimum && integrityFailures.length === 0;

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
  if (integrityFailures.length > 0) {
    return {
      status: 'error',
      ready: false,
      canonical_capabilities: canonicalCapabilities,
      structural_candidates: structuralCandidates,
      catalog_coverage: coverageStatus,
      reason: `Comprehension integrity failed: ${integrityFailures.join('; ')}`,
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
