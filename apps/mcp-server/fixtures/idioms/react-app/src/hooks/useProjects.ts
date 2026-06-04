import { useQuery } from '@tanstack/react-query';

export function useProjects(tenantId: string) {
  return useQuery({
    queryKey: ['projects', tenantId],
    queryFn: async () => [],
  });
}
