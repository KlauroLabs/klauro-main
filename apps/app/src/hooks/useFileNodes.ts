import { useMemo } from 'react';
import { useProjectCas } from './useProjectCas';

/**
 * Local mirror of CASNode/CASEdge (packages/analyzer-core/src/types/cas.types.ts)
 * — apps/app does not depend on the analyzer-core package (see api.ts and
 * useEntryPoints.ts's own mirrored interfaces for the same convention), so
 * only the fields this drilldown actually reads are redeclared here.
 * `id`/`qualified_name` are raw code-token-shaped analyzer output (e.g.
 * `function_apps/app/src/api.ts_apiRequest_0`) — never shown as the primary
 * label; `name` is the clean identifier for that. See docs/briefs/functions.md.
 */
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

/**
 * Reads the node/edge graph out of the full CAS payload (`useProjectCas`, an
 * ui-scaffold-lane hook — in-flight reuse per LANE-COMMON.md's fabric
 * protocol). This is the ONE place that pays the cost of the whale-sized
 * GET /api/projects/:id/cas fetch for this lane; every other hook here reads
 * from this hook's memoized indices instead of re-deriving from raw CAS.
 *
 * Data reality (docs/briefs/functions.md): a codebase carries 800 to 47,000+
 * nodes. There is no server-side node search/filter endpoint yet (confirmed
 * against apps/mcp-server/src/remote-analyzer-service.ts — GET .../cas is
 * the only route, and it returns the entire analysis). Until one exists,
 * every "selector" below (types, files, byId, edges-by-node) is a client-side
 * derivation over the one cached payload, computed once via useMemo rather
 * than per-render. `type: 'file'` nodes are excluded from the general node
 * set — they're containers, browsed via the dedicated file view instead.
 */
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

/**
 * Client-side selector over `useCodebaseNodes`' cached node set — the shape
 * a server-side `/nodes?search=&type=&file=` endpoint can slot into later
 * without changing this hook's signature (swap the body for a fetch, keep
 * the return shape). Paging itself lives in the page/table component
 * (matches the entry-points lane's `EntryPointTable` precedent) so this hook
 * stays a pure filter.
 */
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

/** Nodes defined in one file, for the file view — naturally bounded (a file's
 *  node count runs dozens to low hundreds, unlike the whole-codebase set). */
export function useNodesForFile(projectId: string | undefined, filePath: string | undefined) {
  const base = useCodebaseNodes(projectId);
  const nodes = useMemo(() => {
    if (!filePath) return [];
    return base.allNodes.filter(n => n.source?.file === filePath);
  }, [base.allNodes, filePath]);
  return { ...base, nodes };
}
