import * as path from 'node:path';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { AccountHttpError, type AccountStore } from './account-store';
import { CAS_SECTION_PROFILES, parseCasSectionNames, type CasSectionName } from './cas-sections';
import { composeMemberIdentityTree, findCasById } from './recursive-cas-storage';
import { resolveWorkspaceMember, WorkspaceMemberResolutionError, type ResolvedWorkspaceMember } from './workspace-member-resolver';

export async function resolveWorkspaceMemberResponse(
  accounts: AccountStore,
  dataDir: string | undefined,
  workspaceId: string,
  graph: CASOutput,
  casId: string,
  params: URLSearchParams,
): Promise<{ statusCode: number; body: unknown }> {
  if (!dataDir) throw new AccountHttpError(500, 'Analysis storage unavailable');
  const requested = params.get('sections');
  const sections: CasSectionName[] = requested ? parseCasSectionNames(requested) : [...CAS_SECTION_PROFILES.summary];
  const resolution: { value?: ResolvedWorkspaceMember } = {};
  try {
    const member = await findCasById(graph, casId, {
      sections,
      resolveMember: async (reference, requestedSections, options) => {
        const resolved = await resolveWorkspaceMember(
          { listProjectsForWorkspace: id => accounts.listProjectsForWorkspace(id), workspacePathFor: analysisId => workspaceMemberPath(dataDir, analysisId) },
          workspaceId, reference, requestedSections, options,
        );
        resolution.value = resolved;
        return resolved;
      },
    });
    if (!member) throw new AccountHttpError(404, `CAS ${casId} is not part of workspace ${workspaceId}`);
    const resolved = resolution.value;
    const identity = resolved ? composeMemberIdentityTree(resolved.reference, resolved.identity) : undefined;
    return { statusCode: 200, body: {
      status: 'ready', workspace_id: workspaceId, cas_id: casId,
      reference: resolved?.reference ?? null, sections, identity, member,
    } };
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
