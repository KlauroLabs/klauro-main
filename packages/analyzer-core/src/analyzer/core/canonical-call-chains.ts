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
  'queries',
  'reads',
  'writes',
  'publishes',
  'subscribes',
  'emits',
  'handles',
  'routes_to',
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
  subscribes: 8,
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

    const parents = new Map<string, { parentId?: string; edge?: CASEdge; depth: number }>();
    const visited = new Set<string>([startNode.id]);
    const stack = [startNode.id];
    const exitNodeById = new Map<string, { nodeId: string; exit: CASExitPoint }>();
    let deepestNodeId = startNode.id;
    const circularSourceNodeIds = new Set<string>();
    const recursiveSourceNodeIds = new Set<string>();
    parents.set(startNode.id, { depth: 0 });

    const isAncestor = (candidateId: string, nodeId: string): boolean => {
      let current: string | undefined = nodeId;
      while (current) {
        if (current === candidateId) return true;
        current = parents.get(current)?.parentId;
      }
      return false;
    };

    while (stack.length > 0) {
      const nodeId = stack.pop()!;
      const nodeDepth = parents.get(nodeId)?.depth || 0;
      if (nodeDepth > (parents.get(deepestNodeId)?.depth || 0)) deepestNodeId = nodeId;

      const exits = [...(exitBySource.get(nodeId) || [])].sort((a, b) =>
        (chainExitRank(a) - chainExitRank(b)) || a.id.localeCompare(b.id)
      );
      for (const exitPoint of exits) {
        if (!exitNodeById.has(exitPoint.id)) exitNodeById.set(exitPoint.id, { nodeId, exit: exitPoint });
      }

      const traversableEdges = adjacency.get(nodeId) || [];
      for (let index = traversableEdges.length - 1; index >= 0; index--) {
        const edge = traversableEdges[index];
        if (edge.target === nodeId) recursiveSourceNodeIds.add(nodeId);
        if (visited.has(edge.target)) {
          if (isAncestor(edge.target, nodeId)) circularSourceNodeIds.add(nodeId);
          continue;
        }
        visited.add(edge.target);
        parents.set(edge.target, { parentId: nodeId, edge, depth: nodeDepth + 1 });
        stack.push(edge.target);
      }
    }

    const pathTo = (nodeId: string): PathStep[] => {
      const reversed: PathStep[] = [];
      let current: string | undefined = nodeId;
      while (current) {
        const parent = parents.get(current);
        reversed.push({ nodeId: current, edge: parent?.edge });
        current = parent?.parentId;
      }
      return reversed.reverse();
    };
    const candidateFor = (nodeId: string, exit?: CASExitPoint): ChainCandidate => {
      const path = pathTo(nodeId);
      const pathNodeIds = new Set(path.map(step => step.nodeId));
      const signature = path.map(step => `${step.edge?.id || 'entry'}:${step.nodeId}`).join('>');
      return {
        path,
        exit,
        circular: [...circularSourceNodeIds].some(sourceId => pathNodeIds.has(sourceId)),
        recursive: [...recursiveSourceNodeIds].some(sourceId => pathNodeIds.has(sourceId)),
        signature: exit ? `${signature}>exit:${exit.id}` : signature,
      };
    };
    const candidates = exitNodeById.size > 0
      ? [...exitNodeById.values()].map(({ nodeId, exit }) => candidateFor(nodeId, exit))
      : [candidateFor(deepestNodeId)];
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
