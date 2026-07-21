/**
 * Perspective lenses for the full-diagram views (workspace system map,
 * codebase architecture) — user-directed scope addition, spec'd by
 * docs/SPEC-CONCEPTUAL-LAYER.md / docs/UNDERSTANDING-MODEL.md and
 * get_unified_perspectives' facet shape (apps/mcp-server/src/query.ts
 * getUnifiedPerspectives — MCP-only over `behavioral`/`structural`, not
 * exposed on GET /api/projects/:id/cas or the workspace analysis envelope
 * today). Rather than fabricate the full five-facet set the spec names
 * (structural, conceptual/capability, data/entity, runtime/telemetry,
 * security), each diagram only exposes the lenses its OWN payload can back
 * with real fields — same node/edge set, re-clustered/re-styled, never a
 * second data source. See apps/app/docs/briefs/diagrams.md for the mapping
 * and apps/app/docs/DESIGN-NOTES.md for the lenses left out and why.
 */
export interface DiagramPerspective {
  id: string;
  label: string;
  /** One line shown under the switcher — what this lens groups/colors by
   *  and which field backs it, so the honesty of the lens is visible in the
   *  UI itself, not just in docs. */
  description: string;
}

export const STRUCTURAL_PERSPECTIVE: DiagramPerspective = {
  id: 'structural',
  label: 'Structural',
  description: 'Default view — nodes as the system is composed, edges as the relationships that were detected.',
};

/** The codebase architecture diagram's two lenses (arch-concepts lane —
 *  see apps/app/src/pages/codebase/architectureDiagramData.ts). CONCEPTS is
 *  the default: framework concepts (Services, Controllers, Repositories…)
 *  from architecture_summary.architectural_inventory, not raw evidence rows.
 *  DEPLOYABLES is the prior single lens, kept as the second option. */
export const ARCHITECTURE_CONCEPTS_PERSPECTIVE: DiagramPerspective = {
  id: 'concepts',
  label: 'Concepts',
  description: 'Default view — grouped by framework concept (Services, Controllers, Repositories…); edges are aggregated call-graph relationships between groups where cheaply derivable.',
};

export const ARCHITECTURE_DEPLOYABLES_PERSPECTIVE: DiagramPerspective = {
  id: 'deployables',
  label: 'Deployables',
  description: 'Grouped by real ship/runnable artifact (deployable_evidence); edges are bundled-into relationships.',
};
