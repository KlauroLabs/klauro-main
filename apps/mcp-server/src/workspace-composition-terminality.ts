import type {
  CASEntryPoint,
  CASOutput,
  CASTerminalityMember,
  SystemCapability,
} from '../../../packages/analyzer-core/src/types/cas.types';
import {
  classifyCompositionChildren,
  type CASCompositionRelation,
} from '../../../packages/analyzer-core/src/analyzer/core/cas-composition';
import type {
  CrossCodebaseInput,
  SystemCodebase,
  SystemLink,
  WorkspaceCapability,
} from './cross-codebase-analysis';
import { workspaceMemberReference } from './workspace-member-reference';

export interface WorkspaceCapabilityProvenance {
  source_child_id: string;
  source_capability_id: string;
  source_node_ids: string[];
  source_flow_ids: string[];
  relation_path: NonNullable<CASTerminalityMember['composition_provenance']>['relation_path'];
  confidence: number;
  abstention_reason?: string;
  disposition: 'promoted' | 'absorbed' | 'abstained';
}

export interface WorkspaceCompositionTerminality {
  links: SystemLink[];
  childrenByCodebase: Map<string, CASOutput>;
  relations: CASCompositionRelation[];
  childTerminalityByCodebase: Map<string, CASTerminalityMember>;
}

export function buildWorkspaceCompositionTerminality(
  repositories: CrossCodebaseInput[],
  codebases: SystemCodebase[],
  allLinks: SystemLink[],
): WorkspaceCompositionTerminality {
  const links = allLinks.filter(link => link.source_codebase_id !== link.target_codebase_id);
  const childrenByCodebase = new Map<string, CASOutput>();
  repositories.forEach((repository, index) => {
    const codebase = codebases[index];
    if (codebase) childrenByCodebase.set(codebase.id, workspaceMemberReference(repository, codebase.id));
  });
  const relations: CASCompositionRelation[] = links.flatMap(link => {
    const source = childrenByCodebase.get(link.source_codebase_id);
    const target = childrenByCodebase.get(link.target_codebase_id);
    if (!source?.id || !target?.id) return [];
    const providerSupportsConsumer = link.kind === 'http-call' || link.kind === 'sdk-install';
    return [{
      id: link.id,
      source_cas_id: source.id,
      target_cas_id: target.id,
      terminality_source_cas_id: providerSupportsConsumer ? target.id : source.id,
      terminality_target_cas_id: providerSupportsConsumer ? source.id : target.id,
      type: link.kind,
      confidence: link.confidence,
      evidence: link.evidence,
      metadata: { mode: link.mode, evidence_quality: link.evidence_quality },
    }];
  });
  const terminalityById = new Map(classifyCompositionChildren(
    [...childrenByCodebase.values()].map(child => child.id!),
    relations,
  ).map(member => [member.id, member]));
  const childTerminalityByCodebase = new Map<string, CASTerminalityMember>();
  for (const [codebaseId, child] of childrenByCodebase) {
    const member = terminalityById.get(child.id!);
    if (member) childTerminalityByCodebase.set(codebaseId, member);
  }
  return { links, childrenByCodebase, relations, childTerminalityByCodebase };
}

export function buildWorkspaceCapabilityProvenance(
  sourceCas: CASOutput,
  sourceChild: CASOutput,
  capability: SystemCapability,
  compositionMember: CASTerminalityMember,
  entryPointsById: Map<string, CASEntryPoint>,
): WorkspaceCapabilityProvenance[] {
  const directFlowIds = (sourceCas.flows || [])
    .filter(flow => flow.capability_id === capability.id
      || (flow.capability_relationships || []).some(relationship => relationship.capability_id === capability.id))
    .map(flow => flow.flow_id);
  const directNodeIds = capability.operations.flatMap(operation => {
    const entryPoint = entryPointsById.get(operation.entry_point_id);
    return [entryPoint?.source_node, entryPoint?.handler?.node_id].filter((id): id is string => Boolean(id));
  });
  const inherited = (capability.composition_provenance || [])
    .filter(provenance => provenance.source_node_ids.length + provenance.source_flow_ids.length > 0);
  const direct = directNodeIds.length + directFlowIds.length > 0 ? [{
    source_child_id: sourceChild.id!,
    source_capability_id: capability.id,
    source_node_ids: [...new Set(directNodeIds)].sort(),
    source_flow_ids: [...new Set(directFlowIds)].sort(),
    relation_path: [],
    confidence: 1,
  }] : [];
  const evidenceLineage = [...inherited, ...direct];
  const boundaryPath = compositionMember.composition_provenance?.relation_path || [];
  if (evidenceLineage.length === 0) {
    return [{
      source_child_id: sourceChild.id!,
      source_capability_id: capability.id,
      source_node_ids: [],
      source_flow_ids: [],
      relation_path: boundaryPath,
      confidence: compositionMember.composition_provenance?.confidence ?? 1,
      abstention_reason: compositionMember.composition_provenance?.abstention_reason || 'missing-source-node-or-flow',
      disposition: 'abstained',
    }];
  }
  return evidenceLineage.map(provenance => ({
    source_child_id: provenance.source_child_id || sourceChild.id!,
    source_capability_id: provenance.source_capability_id || capability.id,
    source_node_ids: [...new Set(provenance.source_node_ids)].sort(),
    source_flow_ids: [...new Set(provenance.source_flow_ids)].sort(),
    relation_path: [...provenance.relation_path, ...boundaryPath],
    confidence: Math.min(provenance.confidence, compositionMember.composition_provenance?.confidence ?? 1),
    disposition: compositionMember.terminal ? 'promoted' : 'absorbed',
  }));
}

export function terminalWorkspaceSystemCapabilities(
  workspaceCapabilities: WorkspaceCapability[],
  _childTerminality: ReadonlyArray<CASTerminalityMember>,
): SystemCapability[] {
  return workspaceCapabilities
    .filter(capability => capability.composition_provenance?.some(provenance => provenance.disposition === 'promoted'))
    .map(capability => ({
      id: capability.id,
      name: capability.name,
      name_source: 'reused',
      description: capability.description,
      description_source: capability.description_source === 'ai' ? 'ai' : 'deterministic',
      category: capability.semantic_role === 'core' ? 'core' : capability.semantic_role === 'infrastructure' ? 'internal' : 'supporting',
      operations: [],
      related_entities: [],
      related_domains: [],
      criticality: capability.criticality,
      criticality_factors: capability.terminal_evidence || [],
      composition_provenance: capability.composition_provenance,
    }));

}
export function mergeWorkspaceCapabilityProvenance(
  left: WorkspaceCapabilityProvenance[] = [],
  right: WorkspaceCapabilityProvenance[] = [],
): WorkspaceCapabilityProvenance[] {
  const byIdentity = new Map<string, WorkspaceCapabilityProvenance>();
  for (const provenance of [...left, ...right]) {
    const identity = [
      provenance.source_child_id,
      provenance.source_capability_id,
      provenance.disposition,
      provenance.source_node_ids.join(','),
      provenance.source_flow_ids.join(','),
      provenance.relation_path.map(relation => relation.relation_id).join(','),
    ].join('\u0000');
    byIdentity.set(identity, provenance);
  }
  return [...byIdentity.values()].sort((a, b) =>
    a.source_child_id.localeCompare(b.source_child_id)
    || a.source_capability_id.localeCompare(b.source_capability_id)
    || a.disposition.localeCompare(b.disposition));
}
