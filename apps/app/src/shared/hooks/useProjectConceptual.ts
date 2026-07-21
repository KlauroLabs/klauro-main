import { useQuery } from '@tanstack/react-query';
import { getProjectConceptual, type ConceptualResponse } from '@/shared/api/index';
import { useAuth } from '@/shared/auth/AuthProvider';

export function useProjectConceptual(projectId: string | undefined) {
  const { token } = useAuth();
  return useQuery<ConceptualResponse>({
    queryKey: ['project-conceptual', projectId],
    queryFn: () => getProjectConceptual(token!, projectId!),
    enabled: Boolean(token && projectId),
  });
}
