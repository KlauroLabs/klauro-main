import { useMemo } from 'react';
import { useProjectConceptual } from './useProjectConceptual';
import type { ConceptualCapability, FlowConcept } from '@/shared/api/index';
import { resolveSlug } from '@/shared/lib/slugs';

export interface FlowCapabilityLink {
  capability: ConceptualCapability;
  role: string;
  rationale: string;
}

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
