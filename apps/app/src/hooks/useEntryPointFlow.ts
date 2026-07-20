import { useQuery } from '@tanstack/react-query';
import { getProjectConceptual, type FlowConcept } from '../api';
import { useAuth } from '../auth/AuthProvider';
import type { EntryPoint } from './useEntryPoints';

/**
 * Best-effort join from an entry point to the flow it opens (the brief's
 * "every entry point opens into a flow" pairing — see
 * apps/app/docs/DESIGN-NOTES.md, "Flow linking is best-effort", for why this
 * isn't a direct foreign key today). Uses the existing, already-shipped
 * getProjectConceptual (src/api.ts) rather than adding a new endpoint.
 */
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
