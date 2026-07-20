// page-codebase lane hook (unclaimed by any other lane). Wraps
// GET /api/projects/:id/conceptual (api.ts's getProjectConceptual /
// ConceptualResponse) — the source for capability<->flow relationships
// (related_flows with role), architectural conflicts/paradigms/perspectives,
// and the flow list itself. The Capabilities/Critical-Flows/Architecture
// sections on the CAS home all read from this one call.
import { useQuery } from '@tanstack/react-query';
import { getProjectConceptual, type ConceptualResponse } from '../api';
import { useAuth } from '../auth/AuthProvider';

export function useProjectConceptual(projectId: string | undefined) {
  const { token } = useAuth();
  return useQuery<ConceptualResponse>({
    queryKey: ['project-conceptual', projectId],
    queryFn: () => getProjectConceptual(token!, projectId!),
    enabled: Boolean(token && projectId),
  });
}
