import { useMemo } from 'react';
import { useWorkspaces } from './useWorkspaces';
import { resolveSlug } from '@/shared/lib/slugs';

export function useResolvedWorkspaceId(routeParam: string | undefined): string | undefined {
  const workspacesQuery = useWorkspaces();
  const workspaces = workspacesQuery.data?.workspaces ?? [];
  return useMemo(() => resolveSlug(routeParam, workspaces)?.id, [routeParam, workspaces]);
}
