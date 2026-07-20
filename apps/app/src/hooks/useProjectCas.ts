// Full-CAS fetch, against remote-analyzer-service.ts's GET
// /api/projects/:id/cas ("Full-CAS download for the MCP hosted-analysis
// mirror" — this is the SAME whale-sized payload, the browser's only way to
// reach it). FILE DISCIPLINE (LANE-COMMON.md): "size-aware selector hooks —
// pages never hold the whole CAS". This hook still performs one fetch of the
// full payload (there is no scoped/paginated CAS endpoint yet — a gap worth
// raising with a backend lane), but every consumer should go through
// `useProjectCasSelect` below with a narrow selector rather than reading
// `.data.cas` wholesale, so a component only re-renders on the slice it
// actually reads and doesn't hold a second full copy in its own state.
import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { apiRequest } from '../api';
import { useAuth } from '../auth/AuthProvider';

export interface ProjectCasResponse {
  status: 'ready' | 'no_analysis';
  project_id: string;
  analysis_id?: string;
  analysis_timestamp?: string | null;
  cas?: Record<string, unknown>;
  error?: string;
}

export function useProjectCas(projectId: string | undefined) {
  const { token } = useAuth();
  return useQuery({
    queryKey: ['project-cas', projectId],
    queryFn: () => apiRequest<ProjectCasResponse>(`/api/projects/${projectId}/cas`, token!),
    enabled: Boolean(token && projectId),
  });
}

/**
 * Size-aware selector variant: `select` runs against the cached full-CAS
 * response and the hook only re-renders the caller when ITS slice changes
 * (react-query's built-in `select` memoization) — e.g.
 * `useProjectCasSelect(projectId, res => res.cas?.entry_points ?? [])`.
 * Prefer this over `useProjectCas` in any page component.
 */
export function useProjectCasSelect<T>(
  projectId: string | undefined,
  select: (data: ProjectCasResponse) => T,
  options?: Pick<UseQueryOptions<ProjectCasResponse, unknown, T>, 'enabled'>,
) {
  const { token } = useAuth();
  return useQuery({
    queryKey: ['project-cas', projectId],
    queryFn: () => apiRequest<ProjectCasResponse>(`/api/projects/${projectId}/cas`, token!),
    enabled: Boolean(token && projectId) && (options?.enabled ?? true),
    select,
  });
}
