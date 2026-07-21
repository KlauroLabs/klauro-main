// Resolves the `:projectId` ROUTE PARAM (a `name~suffix` slug per
// src/lib/slugs.ts, or a legacy raw id for back-compat) to the real backend
// project id every data hook needs. Backed by `useWorkspaces()` — the SAME
// aggregate fetch AppShell/DashboardPage already make, so this adds no new
// network call, just a client-side lookup once that data lands.
//
// Falls back to the raw param itself when resolution hasn't landed yet (or
// the param already IS the real id, e.g. a page under test with a mocked
// project id and no workspaces fetched at all) — so a caller can always do
// `useProjectSummary(useResolvedProjectId(routeParam) ?? routeParam)` and
// get correct behavior whether resolution succeeded, is still pending, or
// isn't needed at all.
import { useMemo } from 'react';
import { useWorkspaces } from './useWorkspaces';
import { resolveSlug } from '../lib/slugs';

export function useResolvedProjectId(routeParam: string | undefined): string | undefined {
  const workspacesQuery = useWorkspaces();
  const allProjects = useMemo(
    () => Object.values(workspacesQuery.data?.projectsByWorkspace ?? {}).flat(),
    [workspacesQuery.data],
  );
  return useMemo(() => resolveSlug(routeParam, allProjects)?.id, [routeParam, allProjects]);
}
