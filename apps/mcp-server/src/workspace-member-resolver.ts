import * as path from 'node:path';
import type { CASMemberReference, CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import type { CasSectionName } from './cas-sections';
import { acquireCurrentSegmentedAnalysisLease, loadAnalysisSections, resolveAnalysisForLoad } from './storage';
import type { ResolvedSegmentedAnalysis } from './segmented-analysis-storage';
import { acquireSegmentedGenerationLease, SegmentedGenerationMissingError } from './segmented-generation-lease';

export type WorkspaceMemberResolutionCode = 'not_authorized' | 'member_missing' | 'generation_missing' | 'generation_mismatch';

export class WorkspaceMemberResolutionError extends Error {
  constructor(readonly code: WorkspaceMemberResolutionCode, message: string) {
    super(message);
  }
}

export interface WorkspaceMemberResolverContext {
  listProjectsForWorkspace(workspaceId: string): Promise<Array<{ id: string; analysis_id?: string }>>;
  workspacePathFor(analysisId: string): string;
}

export interface ResolvedWorkspaceMember {
  reference: CASMemberReference;
  sections: CasSectionName[];
  member: Partial<CASOutput>;
}

export async function resolveWorkspaceMember(
  context: WorkspaceMemberResolverContext,
  workspaceId: string,
  reference: CASMemberReference,
  sections: readonly CasSectionName[],
): Promise<ResolvedWorkspaceMember> {
  if (reference.format !== 'workspace-member-reference') throw new WorkspaceMemberResolutionError('member_missing', 'Unsupported member reference format');
  const projects = await context.listProjectsForWorkspace(workspaceId);
  const project = projects.find(candidate => candidate.id === reference.project_id);
  if (!project) throw new WorkspaceMemberResolutionError('not_authorized', `Project ${reference.project_id} is not a member of workspace ${workspaceId}`);
  if (!project.analysis_id) throw new WorkspaceMemberResolutionError('member_missing', `Project ${reference.project_id} has no analysis`);
  const memberWorkspace = context.workspacePathFor(project.analysis_id);
  const resolved = await resolveAnalysisForLoad(memberWorkspace);
  if (!resolved) throw new WorkspaceMemberResolutionError('member_missing', `Project ${reference.project_id} has no readable analysis`);
  const lease = await acquirePinnedLease(resolved, reference);
  try {
    const member = await loadAnalysisSections(memberWorkspace, sections, { pinned: { filePath: resolved.filePath, segmented: lease.segmented } });
    if (!member) throw new WorkspaceMemberResolutionError('member_missing', `Project ${reference.project_id} has no readable analysis sections`);
    if (member.analysis_id && member.analysis_id !== reference.analysis_id) {
      throw new WorkspaceMemberResolutionError('generation_mismatch', `Generation ${reference.generation} carries analysis ${member.analysis_id}, reference expects ${reference.analysis_id}`);
    }
    return { reference, sections: [...sections], member };
  } finally {
    await lease.release();
  }
}

async function acquirePinnedLease(
  resolved: Awaited<ReturnType<typeof resolveAnalysisForLoad>> & object,
  reference: CASMemberReference,
): Promise<{ segmented: ResolvedSegmentedAnalysis; release: () => Promise<void> }> {
  const current = await acquireCurrentSegmentedAnalysisLease(resolved);
  if (current && path.basename(current.segmented.directory) === reference.generation) return current;
  if (current) await current.release();
  try {
    return await acquireSegmentedGenerationLease(resolved.filePath, reference.generation);
  } catch (error) {
    if (error instanceof SegmentedGenerationMissingError) {
      throw new WorkspaceMemberResolutionError('generation_missing', `${error.message}; the workspace record references a member generation that no longer exists — re-run the workspace analysis`);
    }
    throw error;
  }
}
