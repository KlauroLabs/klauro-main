import type { WorkspaceAnalysisResponse, WorkspaceApplication, WorkspaceRuntimeComponent, WorkspaceRuntimeLink } from '@/shared/api/index';
import type { GraphNode } from '@/shared/components/diagram/graphLayout';
import type { DiagramEdge } from '@/shared/components/diagram/GraphCanvas';

export type WorkspaceMapPerspectiveId = 'structural' | 'domain' | 'exposure';

type WorkspaceGraph = NonNullable<WorkspaceAnalysisResponse['analysis']>;

export function liveApplications(applications: WorkspaceApplication[]): WorkspaceApplication[] {
  return applications.filter(app => !app.merged_into);
}

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
