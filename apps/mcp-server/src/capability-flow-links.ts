import type { CapabilityFlowRole } from '../../../packages/analyzer-core/src/types/cas.types';

export interface CapabilityFlowEdge {
  flow_id: string;
  role: CapabilityFlowRole;
  rationale: string;
}

interface LinkedFlow {
  flow_id: string;
  capability_relationships?: Array<{ capability_id: string; role: CapabilityFlowRole; rationale: string }>;
}

export function flowEdgesByCapability(flows: readonly LinkedFlow[]): Map<string, CapabilityFlowEdge[]> {
  const edges = new Map<string, CapabilityFlowEdge[]>();
  for (const flow of flows) {
    for (const rel of flow.capability_relationships || []) {
      const list = edges.get(rel.capability_id) || [];
      list.push({ flow_id: flow.flow_id, role: rel.role, rationale: rel.rationale });
      edges.set(rel.capability_id, list);
    }
  }
  return edges;
}

export function flowTotalsByCapability(flows: readonly LinkedFlow[]): Map<string, number> {
  return new Map([...flowEdgesByCapability(flows)].map(([capability, edges]) => [capability, edges.length]));
}
