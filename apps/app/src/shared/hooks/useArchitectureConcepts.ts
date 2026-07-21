import { useMemo } from 'react';
import { useProjectCasSelect } from './useProjectCas';

export interface RawCallEdge {
  source: string;
  target: string;
  type: string;
}

export interface ArchitectureConceptsData {

  inventory: Record<string, string[]>;
  edges: RawCallEdge[];
}

function selectConcepts(res: { cas?: Record<string, unknown> }): ArchitectureConceptsData {
  const cas = res.cas;
  const architectureSummary = cas?.architecture_summary as { architectural_inventory?: Record<string, string[]> } | undefined;
  const inventory = architectureSummary?.architectural_inventory ?? {};
  const edges = Array.isArray(cas?.edges) ? (cas!.edges as RawCallEdge[]) : [];
  return { inventory, edges };
}

export function useArchitectureConcepts(projectId: string | undefined) {
  const query = useProjectCasSelect(projectId, selectConcepts);

  const data = useMemo<ArchitectureConceptsData>(
    () => query.data ?? { inventory: {}, edges: [] },
    [query.data],
  );
  return { ...query, ...data };
}
