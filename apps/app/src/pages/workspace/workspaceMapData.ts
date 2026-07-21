import type { WorkspaceAnalysisResponse, WorkspaceApplication, WorkspaceRuntimeComponent, WorkspaceRuntimeLink } from '../../api';
import type { GraphNode } from '../../components/diagram/graphLayout';
import type { DiagramEdge } from '../../components/diagram/GraphCanvas';

export type WorkspaceMapPerspectiveId = 'structural' | 'domain' | 'exposure';

type WorkspaceGraph = NonNullable<WorkspaceAnalysisResponse['analysis']>;

/** Live (non-duplicate) applications — `merged_into` marks a cross-member
 *  duplicate whose identity folded into another member's row; drawing both
 *  would double-count the same real deployable. */
export function liveApplications(applications: WorkspaceApplication[]): WorkspaceApplication[] {
  return applications.filter(app => !app.merged_into);
}

/** Each perspective clusters the SAME application nodes by a different real
 *  field — never a second data source. 'domain' and 'exposure' are the two
 *  lenses this payload can honestly back (see docs/briefs/diagrams.md for
 *  what's NOT derivable — capability/data/runtime facets — and why). */
export function buildWorkspaceMapNodes(
  applications: WorkspaceApplication[],
  codebases: WorkspaceGraph['codebases'],
  perspective: WorkspaceMapPerspectiveId,
): GraphNode[] {
  const domainByCodebaseId = new Map((codebases ?? []).map(c => [c.id, c.primary_domain]));
  const apps = liveApplications(applications);

  return apps.map(app => {
    const domain = domainByCodebaseId.get(app.codebase_id);
    const exposed = (app.ports?.length ?? 0) > 0;
    const cluster =
      perspective === 'domain' ? domain || 'unclassified'
      : perspective === 'exposure' ? (exposed ? 'Publicly reachable (has ports)' : 'Internal only')
      : app.kind || 'unspecified kind';
    return {
      id: app.id,
      label: app.name,
      cluster,
      subtitle: app.kind ?? undefined,
    };
  });
}

/** Edges: application-to-application runtime links. `runtime_links` are
 *  component-scoped (source_component_id/target_component_id) — joined here
 *  through `runtime_components[].application_id` to get to application ids,
 *  since that's the join the live WAS payload actually offers (no direct
 *  application-to-application link with per-edge evidence). Falls back to
 *  `application_links` (already application-scoped, but with no `evidence`
 *  array) only when the component/link join produces nothing — both are
 *  real WAS fields, never fabricated. */
export function buildWorkspaceMapEdges(graph: WorkspaceGraph, liveAppIds: ReadonlySet<string>): DiagramEdge[] {
  const components = graph.runtime_components ?? [];
  const links = graph.runtime_links ?? [];
  const appIdByComponentId = new Map(components.map((c: WorkspaceRuntimeComponent) => [c.id, c.application_id]));

  const seen = new Map<string, DiagramEdge>();
  for (const link of links as WorkspaceRuntimeLink[]) {
    const sourceApp = appIdByComponentId.get(link.source_component_id);
    const targetApp = appIdByComponentId.get(link.target_component_id);
    if (!sourceApp || !targetApp || sourceApp === targetApp) continue;
    if (!liveAppIds.has(sourceApp) || !liveAppIds.has(targetApp)) continue;
    const key = `${sourceApp}->${targetApp}`;
    const hasEvidence = (link.evidence?.length ?? 0) > 0;
    const existing = seen.get(key);
    if (existing) {
      if (hasEvidence) existing.muted = false;
      continue;
    }
    seen.set(key, { id: key, source: sourceApp, target: targetApp, label: link.kind, muted: !hasEvidence });
  }

  if (seen.size > 0) return Array.from(seen.values());

  const appLinks = graph.application_links ?? [];
  for (const link of appLinks) {
    const sourceApp = link.source_application_id;
    const targetApp = link.target_application_id;
    if (!sourceApp || !targetApp || sourceApp === targetApp) continue;
    if (!liveAppIds.has(sourceApp) || !liveAppIds.has(targetApp)) continue;
    const key = `${sourceApp}->${targetApp}`;
    if (seen.has(key)) continue;
    seen.set(key, { id: key, source: sourceApp, target: targetApp, label: link.kind });
  }
  return Array.from(seen.values());
}
