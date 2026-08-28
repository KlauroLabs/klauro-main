import { classifyCompositionChildren, type CASCompositionRelation } from '../../../../packages/analyzer-core/src/analyzer/core/cas-composition';
import type { CASComposedClaimProvenance } from '../../../../packages/analyzer-core/src/types/cas.types';

export interface RepoCapabilityFact {
  id: string;
  name: string;
  sourceNodeIds: string[];
  sourceFlowIds: string[];
}

export interface RepoCapabilityFacts {
  repoId: string;
  knownNodeIds: string[];
  knownFlowIds: string[];
  capabilities: RepoCapabilityFact[];
}

export interface ComposedCapability {
  id: string;
  name: string;
  fromRepoId: string;
  provenance: CASComposedClaimProvenance;
}

export interface TerminalCapabilityGateResult {
  pass: boolean;
  substrateRepoIds: string[];
  terminalRepoIds: string[];
  composedCapabilities: ComposedCapability[];
  absorbedCapabilities: ComposedCapability[];
  violations: string[];
}

export function runTerminalCapabilityGate(
  repos: RepoCapabilityFacts[],
  relations: CASCompositionRelation[],
): TerminalCapabilityGateResult {
  const repoById = new Map(repos.map(repo => [repo.repoId, repo]));
  const members = classifyCompositionChildren(repos.map(repo => repo.repoId), relations);
  const terminalRepoIds = members.filter(member => member.terminal).map(member => member.id);
  const substrateRepoIds = members.filter(member => !member.terminal).map(member => member.id);
  const composedCapabilities: ComposedCapability[] = [];
  const absorbedCapabilities: ComposedCapability[] = [];
  const violations: string[] = relations
    .filter(relation => !repoById.has(relation.source_cas_id) || !repoById.has(relation.target_cas_id))
    .map(relation => `composition relation ${relation.id || relation.type} references an unknown child`);

  for (const member of members) {
    const repo = repoById.get(member.id);
    if (!repo) {
      violations.push(`terminality member ${member.id} has no source repository`);
      continue;
    }
    const knownNodes = new Set(repo.knownNodeIds);
    const knownFlows = new Set(repo.knownFlowIds);
    for (const capability of repo.capabilities) {
      const fabricatedNodes = capability.sourceNodeIds.filter(id => !knownNodes.has(id));
      const fabricatedFlows = capability.sourceFlowIds.filter(id => !knownFlows.has(id));
      const relationPath = member.composition_provenance?.relation_path || [];
      if (capability.sourceNodeIds.length + capability.sourceFlowIds.length === 0) {
        violations.push(`${repo.repoId}:${capability.id} has no source node or flow evidence`);
        continue;
      }
      if (fabricatedNodes.length + fabricatedFlows.length > 0) {
        violations.push(`${repo.repoId}:${capability.id} cites evidence outside its source CAS or composition relations`);
        continue;
      }
      const claim: ComposedCapability = {
        id: capability.id,
        name: capability.name,
        fromRepoId: repo.repoId,
        provenance: {
          source_child_id: repo.repoId,
          source_capability_id: capability.id,
          source_node_ids: [...new Set(capability.sourceNodeIds)].sort(),
          source_flow_ids: [...new Set(capability.sourceFlowIds)].sort(),
          relation_path: relationPath,
          confidence: member.composition_provenance?.confidence ?? 1,
          disposition: member.terminal ? 'promoted' : 'absorbed',
          ...(member.composition_provenance?.abstention_reason
            ? { abstention_reason: member.composition_provenance.abstention_reason }
            : {}),
        },
      };
      (member.terminal ? composedCapabilities : absorbedCapabilities).push(claim);
    }
  }

  return {
    pass: violations.length === 0,
    substrateRepoIds,
    terminalRepoIds,
    composedCapabilities,
    absorbedCapabilities,
    violations,
  };
}
