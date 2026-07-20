import { useMemo } from 'react';
import { useCodebaseNodes, type CasNode } from './useFileNodes';

/**
 * One node's full detail plus everything a drilldown needs about its
 * neighborhood: change risk and temporal stability (both keyed by node_id
 * on SIBLING arrays in the CAS payload, not nested on the node itself — see
 * CASChangeRisk/CASTemporalStability in cas.types.ts) and the containing
 * file's other nodes (the "what else lives here" list from get_file_nodes'
 * shape, derived client-side from the same file path).
 */
export function useNode(projectId: string | undefined, nodeId: string | undefined) {
  const base = useCodebaseNodes(projectId);

  const node = useMemo<CasNode | undefined>(
    () => (nodeId ? base.nodesById.get(nodeId) : undefined),
    [base.nodesById, nodeId],
  );

  const risk = useMemo(() => (nodeId ? base.changeRiskById.get(nodeId) : undefined), [base.changeRiskById, nodeId]);
  const stability = useMemo(() => (nodeId ? base.stabilityById.get(nodeId) : undefined), [base.stabilityById, nodeId]);

  const fileSiblings = useMemo<CasNode[]>(() => {
    const file = node?.source?.file;
    if (!file) return [];
    return base.allNodes.filter(n => n.source?.file === file && n.id !== node?.id);
  }, [base.allNodes, node]);

  return { ...base, node, risk, stability, fileSiblings };
}
