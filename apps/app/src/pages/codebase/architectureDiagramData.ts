import type { DeployableEvidence } from '../deployable/dasTypes';
import { KIND_LABEL } from '../deployable/dasLabels';
import { buildDasIndex, normalizePath } from '../deployable/dasIndex';
import type { GraphNode } from '../../components/diagram/graphLayout';
import type { DiagramEdge } from '../../components/diagram/GraphCanvas';

export type ArchitectureDiagramPerspectiveId = 'structural' | 'exposure';

/** A stable-enough id for a raw evidence row (deployable_evidence carries no
 *  id of its own on the HTTP payload) — same construction dasIndex.ts uses
 *  for its `dep:...` ids, kept local since this diagram draws EVERY
 *  evidence row (including bundled, non-promoted members), not just the
 *  qualified ship units dasIndex promotes. */
function evidenceKey(e: DeployableEvidence, index: number): string {
  return `${e.kind}:${e.name}:${index}`;
}

/** Nodes = every deployable_evidence row (real, evidence-backed ship/runnable
 *  artifacts) — not the derived "architectural_inventory" counts (layers,
 *  interfaces...), which have no known relationships to each other and would
 *  be fabricated edges if drawn as a graph. See docs/briefs/diagrams.md. */
export function buildArchitectureDiagramNodes(
  evidence: DeployableEvidence[],
  perspective: ArchitectureDiagramPerspectiveId,
): GraphNode[] {
  return evidence.map((e, i) => {
    const exposed = (e.ports?.length ?? 0) > 0;
    return {
      id: evidenceKey(e, i),
      label: e.name,
      cluster: perspective === 'exposure' ? (exposed ? 'Publicly reachable (has ports)' : 'Internal only') : KIND_LABEL[e.kind],
      subtitle: e.bundled_into ? `bundled into ${e.bundled_into}` : undefined,
    };
  });
}

/** Edges = `bundled_into` relationships — the one real composition link this
 *  evidence array carries (e.g. a client bundles a client-service via an
 *  installer). True communication-seam edges (service A calls service B)
 *  are computed server-side (get_communication_seams) but not on GET
 *  /api/projects/:id/cas today — see DESIGN-NOTES.md. */
export function buildArchitectureDiagramEdges(evidence: DeployableEvidence[]): DiagramEdge[] {
  const idByName = new Map<string, string>();
  evidence.forEach((e, i) => {
    if (!idByName.has(e.name)) idByName.set(e.name, evidenceKey(e, i));
  });

  const edges: DiagramEdge[] = [];
  evidence.forEach((e, i) => {
    if (!e.bundled_into) return;
    const targetId = idByName.get(e.bundled_into);
    if (!targetId) return;
    edges.push({ id: `${evidenceKey(e, i)}->${targetId}`, source: evidenceKey(e, i), target: targetId, label: 'bundled into' });
  });
  return edges;
}

/** Whether a node corresponds to a promoted DAS unit — only those have a
 *  real drilldown route (/codebases/:projectId/deployables/:dasUnitId).
 *  A bundled member or a single, non-promoted deployable is a real node
 *  with no detail page to open (DAS promotion needs 2+ qualified ship
 *  units) — decorative in that case, not a dead link. */
export function promotedUnitIdForEvidence(evidence: DeployableEvidence[], nodeId: string): string | undefined {
  const index = buildDasIndex(evidence);
  const match = evidence.findIndex((e, i) => evidenceKey(e, i) === nodeId);
  if (match < 0) return undefined;
  const target = evidence[match];
  return index.units.find(u => u.name === target.name && u.root_path === normalizePath(target.root_path))?.id;
}
