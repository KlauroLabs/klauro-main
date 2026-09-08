import * as path from 'node:path';
import type { CASMemberReference, CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { selectCasSections, validateCasTreeProjection, type CasSectionName } from './cas-sections';
import { CasMemberResolutionRequiredError, findCasById } from './recursive-cas-storage';
import { remapCasIdentities } from '../../../packages/analyzer-core/src/analyzer/core/recursive-cas';
import { loadAnalysisSections, resolveAnalysisForLoad } from './storage';
import type { ResolvedSegmentedAnalysis } from './segmented-analysis-storage';
import { acquireSegmentedGenerationLease, SegmentedGenerationMissingError } from './segmented-generation-lease';

export type WorkspaceMemberResolutionCode = 'not_authorized' | 'member_missing' | 'generation_missing' | 'generation_mismatch' | 'cas_missing';

export class WorkspaceMemberResolutionError extends Error {
  constructor(readonly code: WorkspaceMemberResolutionCode, message: string) {
    super(message);
  }
}

export interface WorkspaceMemberResolverContext {
  listProjectsForWorkspace(workspaceId: string): Promise<Array<{ id: string; analysis_id?: string }>>;
  workspacePathFor(analysisId: string): string;
}

export interface WorkspaceMemberIdentityTree {
  root_id: string;
  nodes: Array<{ id: string; parent_id: string | null; child_ids: string[] }>;
}

export interface ResolvedWorkspaceMember {
  reference: CASMemberReference;
  sections: CasSectionName[];
  cas_id: string | null;
  identity: WorkspaceMemberIdentityTree;
  member: Partial<CASOutput>;
}

export function pinnedIdentityTree(segmented: ResolvedSegmentedAnalysis, identity: Partial<CASOutput> | null): WorkspaceMemberIdentityTree {
  const projection = segmented.manifest.tree_projection;
  if (projection?.format === 'recursive-cas-section-references') {
    return { root_id: projection.root_id, nodes: projection.nodes.map(node => ({ id: node.id, parent_id: node.parent_id, child_ids: [...node.child_ids] })) };
  }
  const rootId = identity?.id ?? (identity?.analysis_id ? `cas:${identity.analysis_id}` : null);
  if (!rootId) throw new WorkspaceMemberResolutionError('member_missing', `Generation ${path.basename(segmented.directory)} has no readable identity section`);
  return { root_id: rootId, nodes: [{ id: rootId, parent_id: null, child_ids: [] }] };
}

export async function resolveWorkspaceMember(
  context: WorkspaceMemberResolverContext,
  workspaceId: string,
  reference: CASMemberReference,
  sections: readonly CasSectionName[],
  options: { cas_id?: string } = {},
): Promise<ResolvedWorkspaceMember> {
  if (reference?.format !== 'workspace-member-reference') throw new WorkspaceMemberResolutionError('member_missing', 'Unsupported member reference format');
  const projects = await context.listProjectsForWorkspace(workspaceId);
  const project = projects.find(candidate => candidate.id === reference.project_id);
  if (!project) throw new WorkspaceMemberResolutionError('not_authorized', `Project ${reference.project_id} is not a member of workspace ${workspaceId}`);
  if (!project.analysis_id) throw new WorkspaceMemberResolutionError('member_missing', `Project ${reference.project_id} has no analysis`);
  const memberWorkspace = context.workspacePathFor(project.analysis_id);
  const resolved = await resolveAnalysisForLoad(memberWorkspace);
  if (!resolved) throw new WorkspaceMemberResolutionError('member_missing', `Project ${reference.project_id} has no readable analysis`);
  let lease: { segmented: ResolvedSegmentedAnalysis; release: () => Promise<void> };
  try {
    lease = await acquireSegmentedGenerationLease(resolved.filePath, reference.generation);
  } catch (error) {
    if (error instanceof SegmentedGenerationMissingError) {
      throw new WorkspaceMemberResolutionError('generation_missing', `${error.message}; the workspace record references a member generation that no longer exists, re-run the workspace analysis`);
    }
    throw error;
  }
  try {
    const manifestAnalysisId = lease.segmented.manifest.analysis_id;
    if (manifestAnalysisId && manifestAnalysisId !== reference.analysis_id) {
      throw new WorkspaceMemberResolutionError('generation_mismatch', `Generation ${reference.generation} carries analysis ${manifestAnalysisId}, reference expects ${reference.analysis_id}`);
    }
    const identitySection = await loadAnalysisSections(memberWorkspace, ['identity'], { pinned: { filePath: resolved.filePath, segmented: lease.segmented } });
    const identity = pinnedIdentityTree(lease.segmented, identitySection);
    const casId = options.cas_id ?? null;
    if (casId && !identity.nodes.some(node => node.id === casId)) {
      throw new WorkspaceMemberResolutionError('cas_missing', `CAS ${casId} is not part of generation ${reference.generation}`);
    }
    let member: Partial<CASOutput> | null;
    try {
      member = await loadAnalysisSections(memberWorkspace, sections, { pinned: { filePath: resolved.filePath, segmented: lease.segmented }, ...(casId ? { cas_id: casId } : {}) });
    } catch (error) {
      if (casId && error instanceof Error && error.message.startsWith('Unknown CAS id')) throw new WorkspaceMemberResolutionError('cas_missing', error.message);
      throw error;
    }
    if (!member) throw new WorkspaceMemberResolutionError('member_missing', `Project ${reference.project_id} has no readable analysis sections`);
    return { reference, sections: [...sections], cas_id: casId, identity, member };
  } finally {
    await lease.release();
  }
}

export interface CasMemberReadOptions {
  sections: readonly CasSectionName[];
  resolveMember: (
    reference: CASMemberReference,
    sections: readonly CasSectionName[],
    options: { cas_id?: string },
  ) => Promise<ResolvedWorkspaceMember>;
}

export async function findWorkspaceCasById(
  root: CASOutput, casId: string, options: CasMemberReadOptions,
): Promise<Partial<CASOutput> | null> {
  try {
    const selected = findCasById(root, casId);
    return selected ? selectCasSections(selected, options.sections) : null;
  } catch (error) {
    if (!(error instanceof CasMemberResolutionRequiredError)) throw error;
    return resolveReferencedCas(error.owner, casId, options);
  }
}

export function composeMemberIdentityTree(
  reference: CASMemberReference, identity: WorkspaceMemberIdentityTree, parentId: string | null = null,
): WorkspaceMemberIdentityTree {
  const remap = (id: string): string => id === identity.root_id ? reference.composed_id : `${reference.composed_id}:${id}`;
  return {
    root_id: reference.composed_id,
    nodes: identity.nodes.map(node => ({
      id: remap(node.id),
      parent_id: node.parent_id === null ? parentId : remap(node.parent_id),
      child_ids: node.child_ids.map(remap),
    })),
  };
}

async function resolveReferencedCas(
  owner: CasMemberResolutionRequiredError['owner'], casId: string, options: CasMemberReadOptions,
): Promise<Partial<CASOutput>> {
  const reference = owner.member_reference!;
  if (owner.id !== reference.composed_id) throw new Error('Workspace member reference identity does not match its containing CAS');
  const originalId = casId === owner.id ? undefined : casId.slice(reference.composed_id.length + 1);
  const resolved = await options.resolveMember(reference, options.sections, originalId ? { cas_id: originalId } : {});
  if (resolved.reference.generation !== reference.generation || resolved.reference.project_id !== reference.project_id
    || resolved.reference.analysis_id !== reference.analysis_id) throw new Error('Resolved member identity does not match the requested generation');
  validateCasTreeProjection({
    ...resolved.identity, format: 'recursive-cas-section-references', version: 2,
    nodes: resolved.identity.nodes.map(node => ({ ...node, logical_fields: [], sections: [] })),
  });
  const selectedId = originalId || resolved.identity.root_id;
  const selected = resolved.identity.nodes.find(node => node.id === selectedId);
  const memberId = resolved.member.id || (resolved.member.analysis_id ? `cas:${resolved.member.analysis_id}` : undefined);
  if (!selected || memberId !== selectedId) throw new Error('Resolved member identity does not match the selected CAS');
  const composed = composeMemberIdentityTree(reference, resolved.identity, owner.parent_id ?? null);
  const idMap = new Map(resolved.identity.nodes.map((node, index) => [node.id, composed.nodes[index].id]));
  const member = remapCasIdentities({ ...resolved.member, id: memberId }, idMap);
  return {
    ...member,
    parent_id: selectedId === resolved.identity.root_id ? owner.parent_id ?? null : idMap.get(selected.parent_id!)!,
    ...(selectedId === resolved.identity.root_id && owner.label !== undefined ? { label: owner.label } : {}),
  };
}
