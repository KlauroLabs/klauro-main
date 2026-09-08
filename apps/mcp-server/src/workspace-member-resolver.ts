import type { CASMemberReference, CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import type { CasSectionName } from './cas-sections';
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

export function pinnedIdentityTree(segmented: ResolvedSegmentedAnalysis, fallbackId: string): WorkspaceMemberIdentityTree {
  const projection = segmented.manifest.tree_projection;
  if (projection?.format === 'recursive-cas-section-references') {
    return { root_id: projection.root_id, nodes: projection.nodes.map(node => ({ id: node.id, parent_id: node.parent_id, child_ids: [...node.child_ids] })) };
  }
  return { root_id: fallbackId, nodes: [{ id: fallbackId, parent_id: null, child_ids: [] }] };
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
    const identity = pinnedIdentityTree(lease.segmented, `cas:${reference.analysis_id}`);
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
