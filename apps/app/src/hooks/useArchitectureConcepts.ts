// Concept-grade data source for the architecture diagram's DEFAULT lens
// (arch-concepts lane). Reads the same full-CAS payload useDasIndex already
// fetches (GET /api/projects/:id/cas via useProjectCasSelect below — same
// query key, so this is cache-shared, not a second download) but selects two
// fields the deployable-evidence lens never touched:
//
// - architecture_summary.architectural_inventory: per-category arrays keyed
//   by models/views/controllers/view_models/services/repositories/clients/
//   mediators/unit_of_work/singletons/scripts/packages. The CAS type says
//   `string[]` but orchestrator.ts's buildArchitecturalInventory actually
//   fills each array with NODE IDS (`.map(node => node.id)`, see
//   packages/analyzer-core/src/analyzer/core/orchestrator.ts ~line 7077) —
//   real, evidence-backed framework-concept groups, not names. This is the
//   "5-20 things: Services, Controllers, Repositories" shape the user asked
//   for; it already exists on the wire, just never consumed by the app.
// - edges: the raw call graph (source/target/type), used ONLY to aggregate
//   grouped call-edge counts between concept groups (architectureDiagramData.ts
//   buildConceptDiagramEdges) — never drawn node-to-node.
//
// Both fields are absent from AnalysisSummary/casSummary.ts (the compact
// `architectural_inventory_counts` there is numbers-only, already counts,
// with no node ids to aggregate edges from) — hence a fresh hook straight
// against the CAS payload rather than extending useProjectSummary.
import { useMemo } from 'react';
import { useProjectCasSelect } from './useProjectCas';

/** Minimal shape of a CASEdge (packages/analyzer-core/src/types/cas.types.ts)
 *  — only the fields concept-edge aggregation reads. */
export interface RawCallEdge {
  source: string;
  target: string;
  type: string;
}

export interface ArchitectureConceptsData {
  /** category key -> array of node ids in that category (see file header). */
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
  // useProjectCasSelect already memoizes via react-query's `select`; this
  // local useMemo only guards the `undefined`-while-loading default so
  // callers get a stable empty shape instead of undefined-checking everywhere.
  const data = useMemo<ArchitectureConceptsData>(
    () => query.data ?? { inventory: {}, edges: [] },
    [query.data],
  );
  return { ...query, ...data };
}
