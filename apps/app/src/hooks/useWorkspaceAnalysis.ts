// CRITICAL ENVELOPE RULE (LANE-COMMON.md): GET /api/workspaces/:id/analysis
// nests the graph under `analysis:` (top level = status/enrichment/
// last_attempt). This hook returns the envelope as-is — destructure
// `.data.analysis` at the call site, never assume graph fields live at the
// response root (a past live incident came from doing exactly that).
import { useQuery } from '@tanstack/react-query';
import { getWorkspaceAnalysis, type WorkspaceAnalysisResponse } from '../api';
import { useAuth } from '../auth/AuthProvider';

export function useWorkspaceAnalysis(workspaceId: string | undefined) {
  const { token } = useAuth();
  return useQuery<WorkspaceAnalysisResponse>({
    queryKey: ['workspace-analysis', workspaceId],
    queryFn: () => getWorkspaceAnalysis(token!, workspaceId!),
    enabled: Boolean(token && workspaceId),
  });
}
