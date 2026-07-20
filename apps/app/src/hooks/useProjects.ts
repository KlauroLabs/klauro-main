// Lean project listing for a single workspace (GET
// /api/workspaces/:id/projects). Use this when a page only needs the
// project list for one workspace (nav, workspace page); use `useWorkspaces`
// when you need the full cross-workspace aggregate (dashboard).
import { useQuery } from '@tanstack/react-query';
import { apiRequest, type Project } from '../api';
import { useAuth } from '../auth/AuthProvider';

export function useProjects(workspaceId: string | undefined) {
  const { token } = useAuth();
  return useQuery<Project[]>({
    queryKey: ['projects', workspaceId],
    queryFn: async () => {
      const result = await apiRequest<{ projects: Project[] }>(
        `/api/workspaces/${encodeURIComponent(workspaceId!)}/projects`,
        token!,
      );
      return result.projects.map(project => ({ ...project, workspace_id: workspaceId }));
    },
    enabled: Boolean(token && workspaceId),
  });
}
