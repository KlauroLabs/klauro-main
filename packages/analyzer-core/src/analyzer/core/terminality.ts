import type {
  CASOutput,
  CASTerminality,
  CASTerminalityEdge,
  CASTerminalityMember,
  FlowConcept,
} from '../../types/cas.types';

function uniqueIds(ids: Iterable<string>): string[] {
  return [...new Set([...ids].filter(Boolean))].sort();
}

function normalizedEdges(ids: Set<string>, edges: CASTerminalityEdge[]): CASTerminalityEdge[] {
  const seen = new Set<string>();
  const result: CASTerminalityEdge[] = [];
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target) || edge.source === edge.target) continue;
    const key = `${edge.source}\u0000${edge.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(edge);
  }
  return result;
}

function postOrder(ids: string[], adjacency: Map<string, string[]>): string[] {
  const visited = new Set<string>();
  const order: string[] = [];
  for (const start of ids) {
    if (visited.has(start)) continue;
    visited.add(start);
    const stack: Array<{ id: string; next: number }> = [{ id: start, next: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const neighbors = adjacency.get(frame.id) || [];
      if (frame.next < neighbors.length) {
        const neighbor = neighbors[frame.next++];
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          stack.push({ id: neighbor, next: 0 });
        }
        continue;
      }
      order.push(frame.id);
      stack.pop();
    }
  }
  return order;
}

export function analyzeTerminality(idsInput: Iterable<string>, edgeInput: CASTerminalityEdge[]): CASTerminalityMember[] {
  const ids = uniqueIds(idsInput);
  const idSet = new Set(ids);
  const edges = normalizedEdges(idSet, edgeInput);
  const adjacency = new Map(ids.map(id => [id, [] as string[]]));
  const reverse = new Map(ids.map(id => [id, [] as string[]]));
  for (const edge of edges) {
    adjacency.get(edge.source)!.push(edge.target);
    reverse.get(edge.target)!.push(edge.source);
  }
  for (const neighbors of adjacency.values()) neighbors.sort();
  for (const neighbors of reverse.values()) neighbors.sort();

  const order = postOrder(ids, adjacency);
  const componentById = new Map<string, number>();
  const componentMembers: string[][] = [];
  for (let index = order.length - 1; index >= 0; index--) {
    const start = order[index];
    if (componentById.has(start)) continue;
    const componentId = componentMembers.length;
    const members: string[] = [];
    const stack = [start];
    componentById.set(start, componentId);
    while (stack.length > 0) {
      const current = stack.pop()!;
      members.push(current);
      for (const neighbor of reverse.get(current) || []) {
        if (componentById.has(neighbor)) continue;
        componentById.set(neighbor, componentId);
        stack.push(neighbor);
      }
    }
    members.sort();
    componentMembers.push(members);
  }

  const componentOutgoing = new Map<number, Set<number>>();
  const componentIncoming = new Map<number, Set<number>>();
  for (let componentId = 0; componentId < componentMembers.length; componentId++) {
    componentOutgoing.set(componentId, new Set());
    componentIncoming.set(componentId, new Set());
  }
  for (const edge of edges) {
    const source = componentById.get(edge.source)!;
    const target = componentById.get(edge.target)!;
    if (source === target) continue;
    componentOutgoing.get(source)!.add(target);
    componentIncoming.get(target)!.add(source);
  }

  const distance = new Map<number, number>();
  const queue: number[] = [];
  for (let componentId = 0; componentId < componentMembers.length; componentId++) {
    if (componentOutgoing.get(componentId)!.size === 0) {
      distance.set(componentId, 0);
      queue.push(componentId);
    }
  }
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const componentId = queue[cursor];
    const nextDistance = distance.get(componentId)! + 1;
    for (const predecessor of componentIncoming.get(componentId) || []) {
      const current = distance.get(predecessor);
      if (current !== undefined && current <= nextDistance) continue;
      distance.set(predecessor, nextDistance);
      queue.push(predecessor);
    }
  }

  return ids.map(id => {
    const componentId = componentById.get(id)!;
    const distanceToTerminal = distance.get(componentId) ?? 0;
    return {
      id,
      terminal: distanceToTerminal === 0,
      proximal_terminal: distanceToTerminal === 1,
      distance_to_terminal: distanceToTerminal,
      incoming: reverse.get(id)!.length,
      outgoing: adjacency.get(id)!.length,
      strongly_connected_size: componentMembers[componentId].length,
    };
  }).sort((left, right) =>
    left.distance_to_terminal - right.distance_to_terminal ||
    left.outgoing - right.outgoing ||
    right.incoming - left.incoming ||
    left.id.localeCompare(right.id));
}

function flowEdges(flows: FlowConcept[]): CASTerminalityEdge[] {
  const flowIds = new Set(flows.map(flow => flow.flow_id));
  const edges: CASTerminalityEdge[] = [];
  for (const flow of flows) {
    for (const continuation of flow.continuations || []) {
      if (flowIds.has(continuation)) edges.push({ source: flow.flow_id, target: continuation });
    }
    for (const trigger of flow.triggers || []) {
      if (flowIds.has(trigger)) edges.push({ source: flow.flow_id, target: trigger });
    }
  }
  return edges;
}

function entityEdges(flows: FlowConcept[]): CASTerminalityEdge[] {
  const edges: CASTerminalityEdge[] = [];
  for (const flow of flows) {
    for (let index = 1; index < flow.steps.length; index++) {
      for (const source of flow.steps[index - 1].entities) {
        for (const target of flow.steps[index].entities) {
          edges.push({ source, target });
        }
      }
    }
  }
  return edges;
}

export function buildCasTerminality(cas: CASOutput): CASTerminality {
  const flows = cas.flows || [];
  const capabilityEdges: CASTerminalityEdge[] = [];
  for (const capability of cas.capabilities || []) {
    for (const dependency of capability.depends_on || []) {
      capabilityEdges.push({ source: dependency.to_capability, target: dependency.from_capability });
    }
  }
  return {
    nodes: analyzeTerminality(
      cas.nodes.map(node => node.id),
      cas.edges.map(edge => ({ source: edge.source, target: edge.target })),
    ),
    entities: analyzeTerminality(
      (cas.entities || []).map(entity => entity.id),
      entityEdges(flows),
    ),
    flows: analyzeTerminality(
      flows.map(flow => flow.flow_id),
      flowEdges(flows),
    ),
    capabilities: analyzeTerminality(
      (cas.capabilities || []).map(capability => capability.id),
      capabilityEdges,
    ),
  };
}
