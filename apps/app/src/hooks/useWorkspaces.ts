// Aggregate workspace + project + member + revision data for the signed-in
// account (loadAppData already does one coordinated round trip across
// /api/workspaces, each workspace's /projects and /users, and each
// project's /v1/projects/:id/revisions). Consumed by DashboardPage (workspace
// cards, jump-back-in) — keep the AppStateData shape stable, it's the
// dashboard lane's established contract.
import { useQuery } from '@tanstack/react-query';
import { loadAppData, type AppStateData } from '../api';
import { useAuth } from '../auth/AuthProvider';

export function useWorkspaces() {
  const { token } = useAuth();
  return useQuery<AppStateData>({
    queryKey: ['workspaces'],
    queryFn: () => loadAppData(token!),
    enabled: Boolean(token),
  });
}
