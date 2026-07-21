import { useMemo } from 'react';
import { useProjectCas } from './useProjectCas';

export interface CasNode {
  id: string;
  name: string;
  type: string;
  qualified_name?: string;
  category?: string;
  level?: number;
  level_name?: string;
  description?: string;
  description_source?: 'deterministic' | 'ai' | 'manual' | 'reused';
  tags?: string[];
  source?: { file?: string; line?: number; end_line?: number; column?: number };
  signature?: {
    parameters?: Array<{ name: string; type?: string; optional?: boolean; default_value?: string }>;
    return_type?: string;
    throws?: string[];
  };
  metadata?: {
    is_exported?: boolean;
    is_async?: boolean;
    is_static?: boolean;
    access_modifier?: string;
    [key: string]: unknown;
  };
  parent?: string;
}

export interface CasEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  metadata?: { attributes?: { method_name?: string; line?: number; call_type?: string }; [key: string]: unknown };
}

export interface CasChangeRisk {
  node_id: string;
  risk_level: 'critical' | 'high' | 'medium' | 'low';
  risk_factors?: Array<{ factor: string; severity: string; details: string }>;
}

export interface CasStability {
  node_id: string;
  stability_score: number;
  stability_class: 'stable' | 'evolving' | 'volatile' | 'fragile';
}

export interface FacetCount {
  value: string;
  count: number;
}

export function useCodebaseNodes(projectId: string | undefined) {
  const casQuery = useProjectCas(projectId);

  const cas = useMemo(() => {
    return casQuery.data?.status === 'ready' ? (casQuery.data.cas as Record<string, unknown> | undefined) : undefined;
  }, [casQuery.data]);

  const allNodes = useMemo<CasNode[]>(() => {
    const raw = (cas?.nodes as CasNode[] | undefined) ?? [];
    return raw.filter(n => n.type !== 'file');
  }, [cas]);

  const edges = useMemo<CasEdge[]>(() => (cas?.edges as CasEdge[] | undefined) ?? [], [cas]);
  const changeRisks = useMemo<CasChangeRisk[]>(() => (cas?.change_risks as CasChangeRisk[] | undefined) ?? [], [cas]);
  const stability = useMemo<CasStability[]>(() => (cas?.temporal_stability as CasStability[] | undefined) ?? [], [cas]);

  const nodesById = useMemo(() => {
    const map = new Map<string, CasNode>();
    for (const n of allNodes) map.set(n.id, n);
    return map;
  }, [allNodes]);

  const changeRiskById = useMemo(() => {
    const map = new Map<string, CasChangeRisk>();
    for (const r of changeRisks) map.set(r.node_id, r);
    return map;
  }, [changeRisks]);

  const stabilityById = useMemo(() => {
    const map = new Map<string, CasStability>();
    for (const s of stability) map.set(s.node_id, s);
    return map;
  }, [stability]);

  const types = useMemo<FacetCount[]>(() => {
    const tally = new Map<string, number>();
    for (const n of allNodes) tally.set(n.type, (tally.get(n.type) ?? 0) + 1);
    return Array.from(tally, ([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
  }, [allNodes]);

  const files = useMemo<FacetCount[]>(() => {
    const tally = new Map<string, number>();
    for (const n of allNodes) {
      const file = n.source?.file;
      if (file) tally.set(file, (tally.get(file) ?? 0) + 1);
    }
    return Array.from(tally, ([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
  }, [allNodes]);

  return { ...casQuery, allNodes, edges, nodesById, changeRiskById, stabilityById, types, files };
}

export interface NodeFilter {
  search?: string;
  type?: string;
  file?: string;
}

export function useFilteredNodes(projectId: string | undefined, filter: NodeFilter) {
  const base = useCodebaseNodes(projectId);
  const { search, type, file } = filter;

  const filtered = useMemo(() => {
    let rows = base.allNodes;
    if (type) rows = rows.filter(n => n.type === type);
    if (file) rows = rows.filter(n => n.source?.file === file);
    const term = search?.trim().toLowerCase();
    if (term) {
      rows = rows.filter(n =>
        n.name.toLowerCase().includes(term) ||
        (n.qualified_name ?? '').toLowerCase().includes(term) ||
        (n.source?.file ?? '').toLowerCase().includes(term),
      );
    }
    return rows;
  }, [base.allNodes, search, type, file]);

  return { ...base, filteredNodes: filtered };
}

export function useNodesForFile(projectId: string | undefined, filePath: string | undefined) {
  const base = useCodebaseNodes(projectId);
  const nodes = useMemo(() => {
    if (!filePath) return [];
    return base.allNodes.filter(n => n.source?.file === filePath);
  }, [base.allNodes, filePath]);
  return { ...base, nodes };
}
