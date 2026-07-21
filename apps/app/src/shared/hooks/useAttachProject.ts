import { useMutation, useQueryClient } from '@tanstack/react-query';
import { attachProjectToWorkspace } from '@/shared/api/index';
import { useAuth } from '@/shared/auth/AuthProvider';

export function useAttachProject() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ workspaceId, projectId }: { workspaceId: string; projectId: string }) =>
      attachProjectToWorkspace(token!, workspaceId, projectId),
    onSuccess: (result, { workspaceId }) => {
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      queryClient.invalidateQueries({ queryKey: ['projects', workspaceId] });
      queryClient.invalidateQueries({ queryKey: ['workspace-analysis', workspaceId] });
      if (result.moved_from_workspace_id) {
        queryClient.invalidateQueries({ queryKey: ['projects', result.moved_from_workspace_id] });
        queryClient.invalidateQueries({ queryKey: ['workspace-analysis', result.moved_from_workspace_id] });
      }
    },
  });
}
