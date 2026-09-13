import type { CASEdge, CASEntryPoint, FlowConcept } from '../../types/cas.types';
import { isInvocationEdge } from './terminality-scope';

interface FlowChainInput {
  flows: readonly FlowConcept[];
  entryPoints: readonly CASEntryPoint[];
  edges: readonly CASEdge[];
}

function memberNodeIds(flow: FlowConcept): string[] {
  const ids: string[] = [];
  for (const step of flow.steps || []) {
    for (const reference of step.functions || []) {
      if (reference.function_id) ids.push(reference.function_id);
    }
  }
  return ids;
}

function entryNodeIdByFlow(
  flows: readonly FlowConcept[],
  entryPoints: readonly CASEntryPoint[]
): Map<string, string> {
  const handlerByEntryPoint = new Map<string, string>();
  for (const entryPoint of entryPoints) {
    const nodeId = entryPoint.handler?.node_id;
    if (nodeId) handlerByEntryPoint.set(entryPoint.id, nodeId);
  }
  const byFlow = new Map<string, string>();
  for (const flow of flows) {
    const handler = flow.entry_point ? handlerByEntryPoint.get(flow.entry_point) : undefined;
    const fallback = memberNodeIds(flow)[0];
    const entryNode = handler || fallback;
    if (entryNode) byFlow.set(flow.flow_id, entryNode);
  }
  return byFlow;
}

export function callDerivedFlowEdges(
  input: FlowChainInput
): Array<{ source: string; target: string }> {
  const { flows, entryPoints, edges } = input;
  if (flows.length === 0) return [];

  const entryNodeByFlow = entryNodeIdByFlow(flows, entryPoints);
  const flowsByEntryNode = new Map<string, string[]>();
  for (const [flowId, nodeId] of entryNodeByFlow) {
    const bucket = flowsByEntryNode.get(nodeId);
    if (bucket) bucket.push(flowId);
    else flowsByEntryNode.set(nodeId, [flowId]);
  }

  const flowsByMemberNode = new Map<string, string[]>();
  for (const flow of flows) {
    for (const nodeId of memberNodeIds(flow)) {
      const bucket = flowsByMemberNode.get(nodeId);
      if (bucket) bucket.push(flow.flow_id);
      else flowsByMemberNode.set(nodeId, [flow.flow_id]);
    }
  }

  const seen = new Set<string>();
  const derived: Array<{ source: string; target: string }> = [];
  for (const edge of edges) {
    if (!isInvocationEdge(edge)) continue;
    const calledFlows = flowsByEntryNode.get(edge.target);
    if (!calledFlows) continue;
    const callingFlows = flowsByMemberNode.get(edge.source);
    if (!callingFlows) continue;
    for (const source of callingFlows) {
      for (const target of calledFlows) {
        if (source === target) continue;
        const key = `${source} ${target}`;
        if (seen.has(key)) continue;
        seen.add(key);
        derived.push({ source, target });
      }
    }
  }
  return derived;
}
