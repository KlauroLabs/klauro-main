import { useQuery } from '@tanstack/react-query';
import { loadAppData, type AppStateData } from '@/shared/api/index';
import { useAuth } from '@/shared/auth/AuthProvider';

export function useWorkspaces() {
  const { token } = useAuth();
  return useQuery<AppStateData>({
    queryKey: ['workspaces'],
    queryFn: () => loadAppData(token!),
    enabled: Boolean(token),
  });
}
