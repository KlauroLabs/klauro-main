import { useState, useEffect, useMemo, useCallback } from 'react';
import { useRouter } from 'next/router';
import { getApiUrl } from '../../../config/api';
import {
  CASOutput,
  CASNode,
  CASEdge,
  CASPattern,
  EntryPoint,
  ExitPoint,
  ExternalService,
  CASCallChain,
  CASMethodCall,
  FilterState,
  DEFAULT_FILTER_STATE,
} from '../types';

export interface UseCASVisualizationOptions {
  workspaceId?: string;
  codebaseId?: string;
  autoFetch?: boolean;
}

export interface UseCASVisualizationResult {
  cas: CASOutput | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;

  nodes: CASNode[];
  edges: CASEdge[];

  nodesByType: Map<string, CASNode[]>;
  nodesByLevel: Map<number, CASNode[]>;
  edgesBySource: Map<string, CASEdge[]>;
  edgesByTarget: Map<string, CASEdge[]>;

  entryPoints: EntryPoint[];
  exitPoints: ExitPoint[];
  externalServices: ExternalService[];

  httpEndpoints: EntryPoint[];
  databaseExits: ExitPoint[];
  apiExits: ExitPoint[];

  callChains: CASCallChain[];
  methodCalls: CASMethodCall[];
  criticalPaths: CASCallChain[];
  hotPaths: CASCallChain[];

  patterns: CASPattern[];

  filters: FilterState;
  setFilters: (filters: Partial<FilterState>) => void;
  resetFilters: () => void;
  filteredNodes: CASNode[];

  availableTypes: string[];
  availableLevels: number[];
  availablePerspectives: string[];

  getNodeById: (id: string) => CASNode | undefined;
  getNodeConnections: (nodeId: string) => { incoming: CASNode[]; outgoing: CASNode[] };
  getEdgesBetween: (sourceId: string, targetId: string) => CASEdge[];
  getCallChainsForNode: (nodeId: string) => CASCallChain[];

  stats: {
    totalNodes: number;
    totalEdges: number;
    totalEntryPoints: number;
    totalExitPoints: number;
    totalCallChains: number;
    totalPatterns: number;
    authenticatedEndpoints: number;
    publicEndpoints: number;
  };
}

export function useCASVisualization(options: UseCASVisualizationOptions = {}): UseCASVisualizationResult {
  const router = useRouter();
  const workspaceId = options.workspaceId || (router.query.id as string);
  const codebaseId = options.codebaseId || (router.query.codebaseId as string);
  const autoFetch = options.autoFetch ?? true;

  const [cas, setCas] = useState<CASOutput | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFiltersState] = useState<FilterState>(DEFAULT_FILTER_STATE);

  const fetchData = useCallback(async () => {
    if (!workspaceId || !codebaseId) return;

    try {
      setLoading(true);
      setError(null);

      const token = localStorage.getItem('accessToken');
      if (!token) {
        router.push('/login');
        return;
      }

      const response = await fetch(
        getApiUrl(`/api/workspaces/${workspaceId}/codebases/${codebaseId}/blueprint`),
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to fetch blueprint: ${response.statusText}`);
      }

      const data = await response.json();
      const blueprint = data.blueprint as CASOutput;

      if (!blueprint) {
        throw new Error('No blueprint data available');
      }

      setCas(blueprint);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load visualization data';
      setError(message);
      console.error('Failed to fetch CAS data:', err);
    } finally {
      setLoading(false);
    }
  }, [workspaceId, codebaseId, router]);

  useEffect(() => {
    if (autoFetch && workspaceId && codebaseId) {
      fetchData();
    }
  }, [autoFetch, workspaceId, codebaseId, fetchData]);

  const nodes = cas?.nodes || [];
  const edges = cas?.edges || [];

  const nodeMap = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes]);

  const nodesByType = useMemo(() => {
    const map = new Map<string, CASNode[]>();
    nodes.forEach(n => {
      const type = n.type || 'unknown';
      const existing = map.get(type) || [];
      existing.push(n);
      map.set(type, existing);
    });
    return map;
  }, [nodes]);

  const nodesByLevel = useMemo(() => {
    const map = new Map<number, CASNode[]>();
    nodes.forEach(n => {
      const level = n.level ?? 0;
      const existing = map.get(level) || [];
      existing.push(n);
      map.set(level, existing);
    });
    return map;
  }, [nodes]);

  const edgesBySource = useMemo(() => {
    const map = new Map<string, CASEdge[]>();
    edges.forEach(e => {
      const existing = map.get(e.source) || [];
      existing.push(e);
      map.set(e.source, existing);
    });
    return map;
  }, [edges]);

  const edgesByTarget = useMemo(() => {
    const map = new Map<string, CASEdge[]>();
    edges.forEach(e => {
      const existing = map.get(e.target) || [];
      existing.push(e);
      map.set(e.target, existing);
    });
    return map;
  }, [edges]);

  const entryPoints = cas?.entry_points || [];
  const exitPoints = cas?.exit_points || [];
  const externalServices = cas?.external_services || [];
  const callChains = cas?.call_chains || [];
  const methodCalls = cas?.method_calls || [];
  const patterns = cas?.patterns || [];

  const httpEndpoints = useMemo(
    () => entryPoints.filter(ep => ep.type === 'http'),
    [entryPoints]
  );

  const databaseExits = useMemo(
    () => exitPoints.filter(ep => ep.type === 'database'),
    [exitPoints]
  );

  const apiExits = useMemo(
    () => exitPoints.filter(ep => ep.type === 'api'),
    [exitPoints]
  );

  const criticalPaths = useMemo(
    () => callChains.filter(c => c.chain_type === 'critical-path' || c.risk_analysis.risk_level === 'critical'),
    [callChains]
  );

  const hotPaths = useMemo(
    () => callChains.filter(c => c.chain_type === 'hot-path'),
    [callChains]
  );

  const availableTypes = useMemo(() => Array.from(nodesByType.keys()).sort(), [nodesByType]);
  const availableLevels = useMemo(() => Array.from(nodesByLevel.keys()).sort((a, b) => a - b), [nodesByLevel]);

  const availablePerspectives = useMemo(() => {
    const perspectives = new Set<string>(['all']);
    cas?.analyzer_contributions?.forEach(contrib => {
      const type = contrib.analyzer_name.toLowerCase();
      if (type.includes('typescript')) perspectives.add('typescript');
      if (type.includes('nestjs')) perspectives.add('nestjs');
      if (type.includes('react')) perspectives.add('react');
      if (type.includes('express')) perspectives.add('express');
      if (type.includes('django')) perspectives.add('django');
      if (type.includes('flask')) perspectives.add('flask');
    });
    return Array.from(perspectives);
  }, [cas?.analyzer_contributions]);

  const filteredNodes = useMemo(() => {
    let result = nodes;

    if (filters.types.length > 0) {
      result = result.filter(n => filters.types.includes(n.type));
    }

    if (filters.levels.length > 0) {
      result = result.filter(n => filters.levels.includes(n.level ?? 0));
    }

    if (filters.showOrphaned) {
      result = result.filter(n => {
        const hasIncoming = edgesByTarget.has(n.id);
        const hasOutgoing = edgesBySource.has(n.id);
        return !hasIncoming && !hasOutgoing;
      });
    }

    if (filters.showEntryPoints) {
      const entryNodeIds = new Set(entryPoints.map(ep => ep.handler.node_id));
      result = result.filter(n => entryNodeIds.has(n.id));
    }

    if (filters.searchQuery) {
      const query = filters.searchQuery.toLowerCase();
      result = result.filter(n =>
        n.name.toLowerCase().includes(query) ||
        n.type.toLowerCase().includes(query) ||
        n.source?.file.toLowerCase().includes(query)
      );
    }

    return result;
  }, [nodes, filters, edgesByTarget, edgesBySource, entryPoints]);

  const setFilters = useCallback((newFilters: Partial<FilterState>) => {
    setFiltersState(prev => ({ ...prev, ...newFilters }));
  }, []);

  const resetFilters = useCallback(() => {
    setFiltersState(DEFAULT_FILTER_STATE);
  }, []);

  const getNodeById = useCallback((id: string) => nodeMap.get(id), [nodeMap]);

  const getNodeConnections = useCallback(
    (nodeId: string) => {
      const outgoingEdges = edgesBySource.get(nodeId) || [];
      const incomingEdges = edgesByTarget.get(nodeId) || [];

      return {
        outgoing: outgoingEdges
          .map(e => nodeMap.get(e.target))
          .filter((n): n is CASNode => n !== undefined),
        incoming: incomingEdges
          .map(e => nodeMap.get(e.source))
          .filter((n): n is CASNode => n !== undefined),
      };
    },
    [edgesBySource, edgesByTarget, nodeMap]
  );

  const getEdgesBetween = useCallback(
    (sourceId: string, targetId: string) => {
      const sourceEdges = edgesBySource.get(sourceId) || [];
      return sourceEdges.filter(e => e.target === targetId);
    },
    [edgesBySource]
  );

  const getCallChainsForNode = useCallback(
    (nodeId: string) => {
      return callChains.filter(
        chain =>
          chain.entry_point.node_id === nodeId ||
          chain.exit_point?.node_id === nodeId ||
          chain.call_path.some(p => p.node_id === nodeId)
      );
    },
    [callChains]
  );

  const stats = useMemo(() => {
    const authenticatedEndpoints = httpEndpoints.filter(ep => ep.authentication?.required).length;
    return {
      totalNodes: nodes.length,
      totalEdges: edges.length,
      totalEntryPoints: entryPoints.length,
      totalExitPoints: exitPoints.length,
      totalCallChains: callChains.length,
      totalPatterns: patterns.length,
      authenticatedEndpoints,
      publicEndpoints: httpEndpoints.length - authenticatedEndpoints,
    };
  }, [nodes.length, edges.length, entryPoints.length, exitPoints.length, callChains.length, patterns.length, httpEndpoints]);

  return {
    cas,
    loading,
    error,
    refetch: fetchData,

    nodes,
    edges,

    nodesByType,
    nodesByLevel,
    edgesBySource,
    edgesByTarget,

    entryPoints,
    exitPoints,
    externalServices,

    httpEndpoints,
    databaseExits,
    apiExits,

    callChains,
    methodCalls,
    criticalPaths,
    hotPaths,

    patterns,

    filters,
    setFilters,
    resetFilters,
    filteredNodes,

    availableTypes,
    availableLevels,
    availablePerspectives,

    getNodeById,
    getNodeConnections,
    getEdgesBetween,
    getCallChainsForNode,

    stats,
  };
}
