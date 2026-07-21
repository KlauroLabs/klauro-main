// One flow, by id — a selector over the same shared conceptual query as
// useFlows.ts (see that file's header for why this doesn't issue its own
// fetch). Also resolves the flow's related capabilities (M:N, role on the
// edge) from the same response's `capabilities[].related_flows`.
import { useMemo } from 'react';
import { useProjectConceptual } from './useProjectConceptual';
import type { ConceptualCapability, FlowConcept } from '../api';
import { resolveSlug } from '../lib/slugs';

export interface FlowCapabilityLink {
  capability: ConceptualCapability;
  role: string;
  rationale: string;
}

/** `flowId` is a `name~suffix` slug (src/lib/slugs.ts) or a legacy raw
 *  `flow_id` — resolved against this fetch's own flow list, so the
 *  `/flows/flow::chain:entry_event_...`-class raw-id URL never has to leak
 *  past this hook. FlowDetailPage redirects to the canonical slug once this
 *  resolves. */
export function useFlow(projectId: string | undefined, flowId: string | undefined) {
  const query = useProjectConceptual(projectId);

  const flow = useMemo<FlowConcept | undefined>(
    () => resolveSlug(flowId, (query.data?.flows?.flows ?? []).map(f => ({ ...f, id: f.flow_id }))),
    [query.data, flowId],
  );

  const capabilityLinks = useMemo<FlowCapabilityLink[]>(() => {
    if (!flow) return [];
    const capabilities = query.data?.capabilities ?? [];
    const links: FlowCapabilityLink[] = [];
    for (const capability of capabilities) {
      const edge = capability.related_flows?.find(r => r.flow_id === flow.flow_id);
      if (edge) links.push({ capability, role: edge.role, rationale: edge.rationale });
    }
    return links;
  }, [flow, query.data]);

  return { ...query, flow, capabilityLinks };
}
