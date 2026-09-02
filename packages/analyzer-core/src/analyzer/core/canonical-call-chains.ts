import * as crypto from 'crypto';
import type {
  CASCallChain,
  CASEdge,
  CASEntryPoint,
  CASExitPoint,
  CASNode,
} from '../../types/cas.types';

const CHAIN_EDGE_TYPES = new Set([
  'calls',
  'uses',
  'depends_on',
  'queries',
  'reads',
  'writes',
  'publishes',
  'subscribes',
  'emits',
  'handles',
  'routes_to',
  'implements',
  'implemented_by',
  'triggers',
]);

const CHAIN_EDGE_RANK: Record<string, number> = {
  calls: 0,
  routes_to: 1,
  handles: 2,
  queries: 3,
  writes: 4,
  reads: 5,
  publishes: 6,
  emits: 7,
  depends_on: 8,
  uses: 9,
  implements: 10,
  implemented_by: 11,
  subscribes: 12,
};

const CHAIN_EXIT_RANK: Record<string, number> = {
  database: 0,
  api: 1,
  sdk: 2,
  webhook: 3,
  message: 4,
  event: 5,
  file: 6,
  cache: 7,
  client_storage: 8,
  navigation: 9,
  analytics: 10,
};

interface PathStep {
  nodeId: string;
  edge?: CASEdge;
}

interface ChainCandidate {
  path: PathStep[];
  exit?: CASExitPoint;
  circular: boolean;
  recursive: boolean;
  signature: string;
}

function chainExitRank(exitPoint: CASExitPoint): number {
  return CHAIN_EXIT_RANK[exitPoint.type] ?? 99;
}

function materializeChain(
  nodeById: Map<string, CASNode>,
  entryPoint: CASEntryPoint,
  startNode: CASNode,
  candidate: ChainCandidate,
  id: string
): CASCallChain {
  const pathNodes = candidate.path
    .map(step => nodeById.get(step.nodeId))
    .filter((node): node is CASNode => Boolean(node));
  const hasDatabaseCalls = candidate.exit?.type === 'database' ||
    pathNodes.some(node => ['repository', 'entity', 'database', 'model'].includes(node.type));
  const hasExternalCalls = Boolean(candidate.exit);
  const hasAsyncCalls = pathNodes.some(node => Boolean(node.metadata?.is_async || node.metadata?.attributes?.isAsync));
  const maxPathDepth = Math.max(1, candidate.path.length - 1);
  const riskLevel = hasDatabaseCalls || hasExternalCalls || entryPoint.type === 'http' ? 'medium' : 'low';

  return {
    id,
    chain_type: candidate.exit ? 'entry-to-exit' : 'dead-end',
    entry_point: {
      node_id: startNode.id,
      method_name: entryPoint.handler?.method_name || startNode.name,
      entry_point_id: entryPoint.id,
    },
    exit_point: candidate.exit ? {
      node_id: candidate.exit.source_node,
      method_name: candidate.exit.operation?.action || candidate.exit.name,
      exit_point_id: candidate.exit.id,
    } : undefined,
    call_path: candidate.path.map((step, index) => {
      const node = nodeById.get(step.nodeId);
      return {
        call_id: step.edge?.id || `entry:${entryPoint.id}`,
        node_id: step.nodeId,
        method_name: node?.name || step.nodeId,
        depth: index,
      };
    }),
    characteristics: {
      total_calls: Math.max(0, candidate.path.length - 1),
      max_depth: maxPathDepth,
      has_external_calls: hasExternalCalls,
      has_database_calls: hasDatabaseCalls,
      has_async_calls: hasAsyncCalls,
      is_circular: candidate.circular,
      is_recursive: candidate.recursive,
      complexity_score: maxPathDepth + (hasDatabaseCalls ? 2 : 0) + (hasExternalCalls ? 2 : 0),
    },
    risk_analysis: {
      risk_level: riskLevel,
      risk_factors: [
        ...(hasDatabaseCalls ? ['data-access'] : []),
        ...(hasExternalCalls ? ['external-boundary'] : []),
        ...(candidate.path.length === 1 ? ['unexpanded-entry-point'] : []),
      ],
    },
    criticality: entryPoint.type === 'http' ? 'medium' : 'low',
    criticality_factors: [entryPoint.type],
  };
}

export function buildCanonicalCallChains(
  nodes: CASNode[],
  edges: CASEdge[],
  entryPoints: CASEntryPoint[],
  exitPoints: CASExitPoint[]
): CASCallChain[] {
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const exitBySource = new Map<string, CASExitPoint[]>();
  for (const exitPoint of exitPoints) {
    const exits = exitBySource.get(exitPoint.source_node) || [];
    exits.push(exitPoint);
    exitBySource.set(exitPoint.source_node, exits);
  }

  const adjacency = new Map<string, CASEdge[]>();
  for (const edge of edges) {
    if (!CHAIN_EDGE_TYPES.has(edge.type)) continue;
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) continue;
    const outgoing = adjacency.get(edge.source) || [];
    outgoing.push(edge);
    adjacency.set(edge.source, outgoing);
  }
  for (const outgoing of adjacency.values()) {
    outgoing.sort((a, b) =>
      ((CHAIN_EDGE_RANK[a.type] ?? 99) - (CHAIN_EDGE_RANK[b.type] ?? 99)) ||
      a.target.localeCompare(b.target) ||
      (a.id || '').localeCompare(b.id || '')
    );
  }

  const chains: CASCallChain[] = [];
  for (const entryPoint of entryPoints) {
    const startNodeId = entryPoint.handler?.node_id || entryPoint.source_node;
    const startNode = nodeById.get(startNodeId);
    if (!startNode) continue;

    const exitCandidates: ChainCandidate[] = [];
    const deadEndCandidates: ChainCandidate[] = [];
    const stack: Array<{
      nodeId: string;
      path: PathStep[];
      pathNodeIds: Set<string>;
      circular: boolean;
      recursive: boolean;
    }> = [{
      nodeId: startNode.id,
      path: [{ nodeId: startNode.id }],
      pathNodeIds: new Set([startNode.id]),
      circular: false,
      recursive: false,
    }];

    while (stack.length > 0) {
      const state = stack.pop()!;
      const exits = [...(exitBySource.get(state.nodeId) || [])].sort((a, b) =>
        (chainExitRank(a) - chainExitRank(b)) || a.id.localeCompare(b.id)
      );
      const onwardEdges = adjacency.get(state.nodeId) || [];
      const cycleEdges = onwardEdges.filter(edge => state.pathNodeIds.has(edge.target));
      const circular = state.circular || cycleEdges.length > 0;
      const recursive = state.recursive || cycleEdges.some(edge => edge.target === state.nodeId);
      const signature = state.path
        .map(step => `${step.edge?.id || 'entry'}:${step.nodeId}`)
        .join('>');

      for (const exitPoint of exits) {
        exitCandidates.push({
          path: state.path,
          exit: exitPoint,
          circular,
          recursive,
          signature: `${signature}>exit:${exitPoint.id}`,
        });
      }

      const traversableEdges = onwardEdges.filter(edge => !state.pathNodeIds.has(edge.target));
      if (traversableEdges.length === 0 && exits.length === 0) {
        deadEndCandidates.push({ path: state.path, circular, recursive, signature });
        continue;
      }

      for (let index = traversableEdges.length - 1; index >= 0; index--) {
        const edge = traversableEdges[index];
        const nextPathNodeIds = new Set(state.pathNodeIds);
        nextPathNodeIds.add(edge.target);
        stack.push({
          nodeId: edge.target,
          path: [...state.path, { nodeId: edge.target, edge }],
          pathNodeIds: nextPathNodeIds,
          circular,
          recursive,
        });
      }
    }

    const candidates = exitCandidates.length > 0 ? exitCandidates : deadEndCandidates;
    candidates.sort((a, b) =>
      ((a.exit ? chainExitRank(a.exit) : Number.MAX_SAFE_INTEGER) -
        (b.exit ? chainExitRank(b.exit) : Number.MAX_SAFE_INTEGER)) ||
      (b.path.length - a.path.length) ||
      (a.exit?.id || '').localeCompare(b.exit?.id || '') ||
      a.signature.localeCompare(b.signature)
    );

    for (const candidate of candidates) {
      const digest = crypto.createHash('sha256').update(candidate.signature).digest('hex').substring(0, 12);
      const id = candidates.length === 1
        ? `chain:${entryPoint.id}`
        : `chain:${entryPoint.id}:${candidate.exit?.id || 'dead'}:${digest}`;
      chains.push(materializeChain(nodeById, entryPoint, startNode, candidate, id));
    }
  }
  return chains;
}
