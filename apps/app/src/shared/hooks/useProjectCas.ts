import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { apiRequest } from '@/shared/api/index';
import { useAuth } from '@/shared/auth/AuthProvider';

export interface ProjectCasResponse {
  status: 'ready' | 'no_analysis';
  project_id: string;
  analysis_id?: string;
  analysis_timestamp?: string | null;
  cas?: Record<string, unknown>;
  error?: string;
}

export function useProjectCas(projectId: string | undefined) {
  const { token } = useAuth();
  return useQuery({
    queryKey: ['project-cas', projectId],
    queryFn: () => apiRequest<ProjectCasResponse>(`/api/projects/${projectId}/cas`, token!),
    enabled: Boolean(token && projectId),
  });
}

export function useProjectCasSelect<T>(
  projectId: string | undefined,
  select: (data: ProjectCasResponse) => T,
  options?: Pick<UseQueryOptions<ProjectCasResponse, unknown, T>, 'enabled'>,
) {
  const { token } = useAuth();
  return useQuery({
    queryKey: ['project-cas', projectId],
    queryFn: () => apiRequest<ProjectCasResponse>(`/api/projects/${projectId}/cas`, token!),
    enabled: Boolean(token && projectId) && (options?.enabled ?? true),
    select,
  });
}
