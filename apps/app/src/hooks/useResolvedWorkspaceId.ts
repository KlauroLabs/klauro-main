// Resolves the `:workspaceId` ROUTE PARAM (a `name~suffix` slug per
// src/lib/slugs.ts, or a legacy raw id for back-compat) to the real backend
// workspace id — same pattern as useResolvedProjectId.ts, backed by the same
// cached `useWorkspaces()` fetch. Falls back to the raw param when
// resolution hasn't landed yet (or isn't needed, e.g. a test that passes the
// real id directly with no workspaces mocked).
import { useMemo } from 'react';
import { useWorkspaces } from './useWorkspaces';
import { resolveSlug } from '../lib/slugs';

export function useResolvedWorkspaceId(routeParam: string | undefined): string | undefined {
  const workspacesQuery = useWorkspaces();
  const workspaces = workspacesQuery.data?.workspaces ?? [];
  return useMemo(() => resolveSlug(routeParam, workspaces)?.id, [routeParam, workspaces]);
}
