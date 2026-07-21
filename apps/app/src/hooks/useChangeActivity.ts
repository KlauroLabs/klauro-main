// GET /api/account/activity + GET /api/workspaces/:id/activity — the Change
// Activity feed shipped in e9490b69 (remote-analyzer-service.ts;
// AccountActivityEvent in remote-analyzer-protocol.ts). Both routes return
// the SAME event shape/envelope (`{ events, next_cursor }`), so one hook
// covers both call sites (dashboard = account-wide, workspace page = scoped)
// keyed separately so they don't collide in the query cache.
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '../api';
import { useAuth } from '../auth/AuthProvider';

export interface ChangeActivityEvent {
  type:
    | 'analysis_completed'
    | 'analysis_failed'
    | 'workspace_rebuilt'
    | 'workspace_enrichment_degraded'
    | 'workspace_rebuild_failed'
    | 'project_created'
    | 'project_moved';
  at: string;
  workspace_id?: string;
  project_id?: string;
  title: string;
  detail?: string;
  deltas?: { nodes: number; edges: number };
  duration_ms?: number;
}

export interface ChangeActivityResponse {
  events: ChangeActivityEvent[];
  next_cursor: null;
}

export function useAccountActivity(limit = 20) {
  const { token } = useAuth();
  return useQuery<ChangeActivityResponse>({
    queryKey: ['account-activity', limit],
    queryFn: () => apiRequest<ChangeActivityResponse>(`/api/account/activity?limit=${limit}`, token!),
    enabled: Boolean(token),
  });
}

export function useWorkspaceActivity(workspaceId: string | undefined, limit = 20) {
  const { token } = useAuth();
  return useQuery<ChangeActivityResponse>({
    queryKey: ['workspace-activity', workspaceId, limit],
    queryFn: () => apiRequest<ChangeActivityResponse>(`/api/workspaces/${encodeURIComponent(workspaceId!)}/activity?limit=${limit}`, token!),
    enabled: Boolean(token && workspaceId),
  });
}
