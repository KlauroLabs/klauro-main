import { useMemo } from 'react';
import { useWorkspaces } from './useWorkspaces';
import { resolveSlug } from '@/shared/lib/slugs';

export function useResolvedProjectId(routeParam: string | undefined): string | undefined {
  const workspacesQuery = useWorkspaces();
  const allProjects = useMemo(
    () => Object.values(workspacesQuery.data?.projectsByWorkspace ?? {}).flat(),
    [workspacesQuery.data],
  );
  return useMemo(() => resolveSlug(routeParam, allProjects)?.id, [routeParam, allProjects]);
}
