// CRITICAL ENVELOPE RULE: GET /api/workspaces/:id/analysis nests the graph
// under `analysis:` (top level = status/enrichment/last_attempt) — destructure
// `.data.analysis` at the call site, never assume graph fields live at the
// response root.
import { useQuery } from '@tanstack/react-query';
import { getWorkspaceAnalysis, type WorkspaceAnalysisResponse } from '@/shared/api/index';
import { useAuth } from '@/shared/auth/AuthProvider';

export function useWorkspaceAnalysis(workspaceId: string | undefined) {
  const { token } = useAuth();
  return useQuery<WorkspaceAnalysisResponse>({
    queryKey: ['workspace-analysis', workspaceId],
    queryFn: () => getWorkspaceAnalysis(token!, workspaceId!),
    enabled: Boolean(token && workspaceId),
  });
}
