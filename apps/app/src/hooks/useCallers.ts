import { useMemo } from 'react';
import { useCodebaseNodes, type CasNode } from './useFileNodes';

export interface RelatedNode {
  node?: CasNode;
  /** The raw edge target/source id — kept even when the id doesn't resolve
   *  to a loaded node (e.g. it points at an excluded `file` node or an
   *  exit-point synthetic id), so a caller/callee list never silently drops
   *  a real edge just because the endpoint isn't independently browsable. */
  id: string;
  line?: number;
  methodName?: string;
}

/**
 * Everything that calls this node — derived from the CAS `calls` edges
 * (edge.target === nodeId), the same edge shape get_file_nodes/get_node
 * return via the Klauro MCP tools, read here straight out of the CAS
 * payload since apps/app talks to GET /api/projects/:id/cas, not the MCP
 * server. First-class and link-onward: each row is itself a node this
 * hook (or useCallees) can be re-run against — the infinite-drilldown
 * requirement.
 */
export function useCallers(projectId: string | undefined, nodeId: string | undefined) {
  const base = useCodebaseNodes(projectId);

  const callers = useMemo<RelatedNode[]>(() => {
    if (!nodeId) return [];
    return base.edges
      .filter(e => e.type === 'calls' && e.target === nodeId)
      .map(e => ({
        id: e.source,
        node: base.nodesById.get(e.source),
        line: e.metadata?.attributes?.line,
        methodName: e.metadata?.attributes?.method_name,
      }));
  }, [base.edges, base.nodesById, nodeId]);

  return { ...base, callers };
}
