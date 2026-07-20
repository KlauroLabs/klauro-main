// Attach an EXISTING project to a workspace (POST
// /api/workspaces/:id/projects {project_id}) — api.ts's attachProjectToWorkspace
// documents this as always a MOVE (AccountProject.workspace_id is a single FK,
// not a join table). Invalidates both the source and destination workspace's
// aggregate + analysis queries since a move can trigger a WAS rebuild on
// either side.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { attachProjectToWorkspace } from '../api';
import { useAuth } from '../auth/AuthProvider';

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
