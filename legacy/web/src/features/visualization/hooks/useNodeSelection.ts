import { useState, useCallback, useMemo } from 'react';
import { CASNode, CASEdge, ExitPoint } from '../types';

export interface NodeSelectionState {
  selectedNodeId: string | null;
  history: string[];
  historyIndex: number;
}

export interface ExitPointConnection {
  id: string;
  name: string;
  type: string;
  repository?: string;
  method?: string;
  isExitPoint: true;
  linkedNodeId?: string;
  library?: string;
}

function getLibraryFromMetadata(metadata?: Record<string, any>): string | undefined {
  return metadata?.library || metadata?.orm || metadata?.framework;
}

export interface UseNodeSelectionOptions {
  nodes: CASNode[];
  edges: CASEdge[];
  exitPoints?: ExitPoint[];
  onSelectionChange?: (nodeId: string | null) => void;
}

export interface UseNodeSelectionResult {
  selectedNode: CASNode | null;
  selectedNodeId: string | null;
  history: CASNode[];
  canGoBack: boolean;
  canGoForward: boolean;

  selectNode: (nodeId: string | null) => void;
  goBack: () => void;
  goForward: () => void;
  clearHistory: () => void;

  incomingConnections: CASNode[];
  outgoingConnections: CASNode[];
  outgoingExitPoints: ExitPointConnection[];
  allConnections: CASNode[];

  getConnectionsGroupedByType: () => Map<string, { incoming: CASNode[]; outgoing: CASNode[] }>;
}

export function useNodeSelection(options: UseNodeSelectionOptions): UseNodeSelectionResult {
  const { nodes, edges, exitPoints = [], onSelectionChange } = options;

  const [state, setState] = useState<NodeSelectionState>({
    selectedNodeId: null,
    history: [],
    historyIndex: -1,
  });

  const nodeMap = useMemo(() => {
    return new Map(nodes.map(n => [n.id, n]));
  }, [nodes]);

  const nodeByFileAndName = useMemo(() => {
    const map = new Map<string, CASNode>();
    nodes.forEach(n => {
      if (n.source?.file && n.name) {
        const key = `${n.source.file}_${n.name}`;
        map.set(key, n);
      }
    });
    return map;
  }, [nodes]);

  const resolveEdgeIdToNode = useCallback((edgeId: string): CASNode | undefined => {
    const match = edgeId.match(/^function_(.+)_([^_]+)_(\d+)$/);
    if (match) {
      const [, file, methodName] = match;
      const key = `${file}_${methodName}`;
      return nodeByFileAndName.get(key);
    }
    return nodeMap.get(edgeId);
  }, [nodeMap, nodeByFileAndName]);

  const buildEdgeKey = useCallback((node: CASNode): string[] => {
    const keys: string[] = [];
    if (node.source?.file && node.name) {
      for (let i = 0; i < 20; i++) {
        keys.push(`function_${node.source.file}_${node.name}_${i}`);
      }
    }
    keys.push(node.id);
    return keys;
  }, []);

  const callEdges = useMemo(() => {
    return edges.filter(e => e.type === 'calls');
  }, [edges]);

  const edgesBySource = useMemo(() => {
    const map = new Map<string, CASEdge[]>();
    callEdges.forEach(e => {
      const existing = map.get(e.source) || [];
      existing.push(e);
      map.set(e.source, existing);
    });
    return map;
  }, [callEdges]);

  const edgesByTarget = useMemo(() => {
    const map = new Map<string, CASEdge[]>();
    callEdges.forEach(e => {
      const existing = map.get(e.target) || [];
      existing.push(e);
      map.set(e.target, existing);
    });
    return map;
  }, [callEdges]);

  const exitPointsBySourceNode = useMemo(() => {
    const map = new Map<string, ExitPoint[]>();
    exitPoints.forEach(ep => {
      const sourceNode = (ep as any).source_node || ep.source?.node_id;
      if (sourceNode) {
        const existing = map.get(sourceNode) || [];
        existing.push(ep);
        map.set(sourceNode, existing);
      }
    });
    return map;
  }, [exitPoints]);

  const selectedNode = useMemo(() => {
    if (!state.selectedNodeId) return null;
    return nodeMap.get(state.selectedNodeId) || null;
  }, [state.selectedNodeId, nodeMap]);

  const history = useMemo(() => {
    return state.history
      .slice(0, state.historyIndex + 1)
      .map(id => nodeMap.get(id))
      .filter((n): n is CASNode => n !== undefined);
  }, [state.history, state.historyIndex, nodeMap]);

  const incomingConnections = useMemo(() => {
    if (!state.selectedNodeId) return [];
    const node = nodeMap.get(state.selectedNodeId);
    if (!node) return [];

    const possibleKeys = buildEdgeKey(node);
    const allIncomingEdges: CASEdge[] = [];

    possibleKeys.forEach(key => {
      const edges = edgesByTarget.get(key);
      if (edges) allIncomingEdges.push(...edges);
    });

    const seen = new Set<string>();
    const result: CASNode[] = [];

    allIncomingEdges.forEach(e => {
      const sourceNode = resolveEdgeIdToNode(e.source);
      if (sourceNode && !seen.has(sourceNode.id)) {
        seen.add(sourceNode.id);
        result.push(sourceNode);
      }
    });

    return result;
  }, [state.selectedNodeId, nodeMap, buildEdgeKey, edgesByTarget, resolveEdgeIdToNode]);

  const outgoingConnections = useMemo(() => {
    if (!state.selectedNodeId) return [];
    const node = nodeMap.get(state.selectedNodeId);
    if (!node) return [];

    const possibleKeys = buildEdgeKey(node);
    const allOutgoingEdges: CASEdge[] = [];

    possibleKeys.forEach(key => {
      const edges = edgesBySource.get(key);
      if (edges) allOutgoingEdges.push(...edges);
    });

    const seen = new Set<string>();
    const result: CASNode[] = [];

    allOutgoingEdges.forEach(e => {
      const targetNode = resolveEdgeIdToNode(e.target);
      if (targetNode && !seen.has(targetNode.id)) {
        seen.add(targetNode.id);
        result.push(targetNode);
      }
    });

    return result;
  }, [state.selectedNodeId, nodeMap, buildEdgeKey, edgesBySource, resolveEdgeIdToNode]);

  const outgoingExitPoints = useMemo((): ExitPointConnection[] => {
    if (!state.selectedNodeId) return [];
    const node = nodeMap.get(state.selectedNodeId);
    if (!node) return [];

    const possibleKeys = buildEdgeKey(node);
    const result: ExitPointConnection[] = [];
    const seen = new Set<string>();

    possibleKeys.forEach(key => {
      const eps = exitPointsBySourceNode.get(key);
      if (eps) {
        eps.forEach(ep => {
          if (ep.type === 'sdk') return;
          if (!seen.has(ep.id)) {
            seen.add(ep.id);
            const metadata = (ep as any).metadata || {};
            const repoName = metadata.repository;
            const methodName = metadata.method;
            let linkedNodeId: string | undefined;
            if (repoName && methodName) {
              const methodNode = nodes.find(n =>
                n.name === methodName &&
                n.type === 'method' &&
                n.source?.file?.toLowerCase().includes(repoName.replace('Repository', '').toLowerCase())
              );
              if (methodNode) {
                linkedNodeId = methodNode.id;
              }
            }
            const library = getLibraryFromMetadata(metadata);

            result.push({
              id: ep.id,
              name: ep.name,
              type: ep.type,
              repository: repoName,
              method: metadata.method,
              isExitPoint: true,
              linkedNodeId,
              library,
            });
          }
        });
      }
    });

    return result;
  }, [state.selectedNodeId, nodeMap, buildEdgeKey, exitPointsBySourceNode, nodes]);

  const allConnections = useMemo(() => {
    const seen = new Set<string>();
    const result: CASNode[] = [];

    [...incomingConnections, ...outgoingConnections].forEach(n => {
      if (!seen.has(n.id)) {
        seen.add(n.id);
        result.push(n);
      }
    });

    return result;
  }, [incomingConnections, outgoingConnections]);

  const selectNode = useCallback((nodeId: string | null) => {
    setState(prev => {
      if (nodeId === prev.selectedNodeId) return prev;

      const newHistory = nodeId
        ? [...prev.history.slice(0, prev.historyIndex + 1), nodeId]
        : prev.history;

      return {
        selectedNodeId: nodeId,
        history: newHistory,
        historyIndex: nodeId ? newHistory.length - 1 : prev.historyIndex,
      };
    });

    onSelectionChange?.(nodeId);
  }, [onSelectionChange]);

  const goBack = useCallback(() => {
    setState(prev => {
      if (prev.historyIndex <= 0) return prev;

      const newIndex = prev.historyIndex - 1;
      const nodeId = prev.history[newIndex];

      onSelectionChange?.(nodeId);

      return {
        ...prev,
        selectedNodeId: nodeId,
        historyIndex: newIndex,
      };
    });
  }, [onSelectionChange]);

  const goForward = useCallback(() => {
    setState(prev => {
      if (prev.historyIndex >= prev.history.length - 1) return prev;

      const newIndex = prev.historyIndex + 1;
      const nodeId = prev.history[newIndex];

      onSelectionChange?.(nodeId);

      return {
        ...prev,
        selectedNodeId: nodeId,
        historyIndex: newIndex,
      };
    });
  }, [onSelectionChange]);

  const clearHistory = useCallback(() => {
    setState({
      selectedNodeId: null,
      history: [],
      historyIndex: -1,
    });
    onSelectionChange?.(null);
  }, [onSelectionChange]);

  const getConnectionsGroupedByType = useCallback(() => {
    const groups = new Map<string, { incoming: CASNode[]; outgoing: CASNode[] }>();

    incomingConnections.forEach(node => {
      const type = node.type || 'unknown';
      const existing = groups.get(type) || { incoming: [], outgoing: [] };
      existing.incoming.push(node);
      groups.set(type, existing);
    });

    outgoingConnections.forEach(node => {
      const type = node.type || 'unknown';
      const existing = groups.get(type) || { incoming: [], outgoing: [] };
      existing.outgoing.push(node);
      groups.set(type, existing);
    });

    return groups;
  }, [incomingConnections, outgoingConnections]);

  return {
    selectedNode,
    selectedNodeId: state.selectedNodeId,
    history,
    canGoBack: state.historyIndex > 0,
    canGoForward: state.historyIndex < state.history.length - 1,

    selectNode,
    goBack,
    goForward,
    clearHistory,

    incomingConnections,
    outgoingConnections,
    outgoingExitPoints,
    allConnections,

    getConnectionsGroupedByType,
  };
}
