// Thin wrap of GET /api/projects/:id/analysis (api.ts's getProjectAnalysis /
// ProjectAnalysisResponse) — no envelope surprises here since this route's
// body IS the top-level shape (unlike the workspace-analysis envelope rule).
import { useQuery } from '@tanstack/react-query';
import { getProjectAnalysis, type ProjectAnalysisResponse } from '../api';
import { useAuth } from '../auth/AuthProvider';

export function useProjectSummary(projectId: string | undefined) {
  const { token } = useAuth();
  return useQuery<ProjectAnalysisResponse>({
    queryKey: ['project-summary', projectId],
    queryFn: () => getProjectAnalysis(token!, projectId!),
    enabled: Boolean(token && projectId),
  });
}
