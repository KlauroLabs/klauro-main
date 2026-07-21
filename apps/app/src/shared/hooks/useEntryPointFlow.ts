import { useQuery } from '@tanstack/react-query';
import { getProjectConceptual, type FlowConcept } from '@/shared/api/index';
import { useAuth } from '@/shared/auth/AuthProvider';
import type { EntryPoint } from './useEntryPoints';

export function useEntryPointFlow(projectId: string | undefined, entryPoint: EntryPoint | undefined) {
  const { token } = useAuth();

  const query = useQuery({
    queryKey: ['project-conceptual-flows', projectId],
    queryFn: () => getProjectConceptual(token!, projectId!),
    enabled: Boolean(token && projectId),
  });

  const flow: FlowConcept | undefined = entryPoint
    ? query.data?.flows?.flows.find(
        f => f.entry_point === entryPoint.id || f.entry_point === entryPoint.source_node || f.entry_point === entryPoint.name,
      )
    : undefined;

  return { ...query, flow };
}
