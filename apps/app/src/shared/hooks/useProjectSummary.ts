// GET /api/projects/:id/analysis has no envelope — the response body IS the
// top-level shape (unlike the workspace-analysis envelope rule).
import { useQuery } from '@tanstack/react-query';
import { getProjectAnalysis, type ProjectAnalysisResponse } from '@/shared/api/index';
import { useAuth } from '@/shared/auth/AuthProvider';

export function useProjectSummary(projectId: string | undefined) {
  const { token } = useAuth();
  return useQuery<ProjectAnalysisResponse>({
    queryKey: ['project-summary', projectId],
    queryFn: () => getProjectAnalysis(token!, projectId!),
    enabled: Boolean(token && projectId),
  });
}
