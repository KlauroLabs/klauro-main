import { useQuery } from '@tanstack/react-query';
import { apiRequest, type Project } from '@/shared/api/index';
import { useAuth } from '@/shared/auth/AuthProvider';

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
