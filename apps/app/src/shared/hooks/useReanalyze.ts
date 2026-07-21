import { useMutation, useQueryClient } from '@tanstack/react-query';
import { reanalyzeProject, reanalyzeWorkspace, type Project } from '@/shared/api/index';
import { useAuth } from '@/shared/auth/AuthProvider';

export function useReanalyzeProject() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (project: Project) => reanalyzeProject(token!, project),
    onSuccess: (_result, project) => {
      queryClient.invalidateQueries({ queryKey: ['project-summary', project.id] });
      queryClient.invalidateQueries({ queryKey: ['project-cas', project.id] });
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
    },
  });
}

export function useReanalyzeWorkspace() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (workspaceId: string) => reanalyzeWorkspace(token!, workspaceId),
    onSuccess: (_result, workspaceId) => {
      queryClient.invalidateQueries({ queryKey: ['workspace-analysis', workspaceId] });
    },
  });
}
