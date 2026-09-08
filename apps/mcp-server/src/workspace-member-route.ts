import * as path from 'node:path';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { AccountHttpError, type AccountStore } from './account-store';
import { CAS_SECTION_PROFILES, parseCasSectionNames, type CasSectionName } from './cas-sections';
import { findCasById } from './recursive-cas-storage';
import { resolveWorkspaceMember, WorkspaceMemberResolutionError } from './workspace-member-resolver';

export async function resolveWorkspaceMemberResponse(
  accounts: AccountStore,
  dataDir: string | undefined,
  workspaceId: string,
  graph: CASOutput,
  casId: string,
  params: URLSearchParams,
): Promise<{ statusCode: number; body: unknown }> {
  if (!dataDir) throw new AccountHttpError(500, 'Analysis storage unavailable');
  const child = findCasById(graph, casId) ?? [...(graph.children || [])].map(candidate => findCasById(candidate, casId)).find(Boolean) ?? null;
  const owner = child ?? (graph.children || []).find(candidate => Boolean(candidate.id) && casId.startsWith(`${candidate.id}:`)) ?? null;
  const ownerId = owner?.id;
  if (!owner || !ownerId) throw new AccountHttpError(404, `CAS ${casId} is not part of workspace ${workspaceId}`);
  const reference = owner.member_reference;
  if (!reference) return { statusCode: 200, body: { status: 'ready', workspace_id: workspaceId, cas_id: casId, member: child, reference: null } };
  const requested = params.get('sections');
  const sections: CasSectionName[] = requested ? parseCasSectionNames(requested) : [...CAS_SECTION_PROFILES.summary];
  const originalCasId = casId === ownerId ? undefined : casId.startsWith(`${ownerId}:`) ? casId.slice(ownerId.length + 1) : undefined;
  if (casId !== ownerId && originalCasId === undefined) throw new AccountHttpError(404, `CAS ${casId} is not addressable under ${ownerId}`);
  try {
    const resolved = await resolveWorkspaceMember(
      { listProjectsForWorkspace: id => accounts.listProjectsForWorkspace(id), workspacePathFor: analysisId => workspaceMemberPath(dataDir, analysisId) },
      workspaceId,
      reference,
      sections,
      originalCasId ? { cas_id: originalCasId } : {},
    );
    return { statusCode: 200, body: { status: 'ready', workspace_id: workspaceId, cas_id: casId, reference: resolved.reference, sections: resolved.sections, identity: resolved.identity, member: resolved.member } };
  } catch (error) {
    if (error instanceof WorkspaceMemberResolutionError) {
      const status = error.code === 'not_authorized' ? 403 : error.code === 'member_missing' || error.code === 'cas_missing' ? 404 : 409;
      throw new AccountHttpError(status, error.message);
    }
    throw error;
  }
}

export function workspaceMemberPath(dataDir: string, analysisId: string): string {
  return path.join(dataDir, 'workspaces', analysisId.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 120));
}
