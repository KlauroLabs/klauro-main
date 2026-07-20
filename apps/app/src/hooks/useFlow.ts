// One flow, by id — a selector over the same shared conceptual query as
// useFlows.ts (see that file's header for why this doesn't issue its own
// fetch). Also resolves the flow's related capabilities (M:N, role on the
// edge) from the same response's `capabilities[].related_flows`.
import { useMemo } from 'react';
import { useProjectConceptual } from './useProjectConceptual';
import type { ConceptualCapability, FlowConcept } from '../api';

export interface FlowCapabilityLink {
  capability: ConceptualCapability;
  role: string;
  rationale: string;
}

export function useFlow(projectId: string | undefined, flowId: string | undefined) {
  const query = useProjectConceptual(projectId);

  const flow = useMemo<FlowConcept | undefined>(
    () => query.data?.flows?.flows.find(f => f.flow_id === flowId),
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
