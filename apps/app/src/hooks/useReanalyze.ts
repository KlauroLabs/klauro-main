// Mutations for the two re-analyze surfaces: a single project (server reads
// the project's local_path and re-runs analysis, POST
// /api/projects/:id/reanalyze) and a workspace-level rebuild from already-
// stored member analyses (POST /api/workspaces/:id/reanalyze, 202 + poll).
// Both invalidate the query keys the read hooks above use, so a mutation
// success automatically refreshes anything on screen reading that data.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { reanalyzeProject, reanalyzeWorkspace, type Project } from '../api';
import { useAuth } from '../auth/AuthProvider';

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
