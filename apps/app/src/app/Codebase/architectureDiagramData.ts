import type { DeployableEvidence } from '@/app/Deployable/dasTypes';
import { KIND_LABEL } from '@/app/Deployable/dasLabels';
import { buildDasIndex, normalizePath } from '@/app/Deployable/dasIndex';
import type { RawCallEdge } from '@/shared/hooks/useArchitectureConcepts';
import type { GraphNode } from '@/shared/components/diagram/graphLayout';
import type { DiagramEdge } from '@/shared/components/diagram/GraphCanvas';

const CONCEPT_LABELS: Record<string, string> = {
  models: 'Models',
  views: 'Views',
  controllers: 'Controllers',
  view_models: 'View Models',
  services: 'Services',
  repositories: 'Repositories',
  clients: 'Clients',
  mediators: 'Mediators',
  unit_of_work: 'Unit of Work',
  singletons: 'Singletons',
  scripts: 'Scripts',
  packages: 'Packages',
};

const EDGE_EXCLUDED_CONCEPTS = new Set(['packages']);

const CALL_EDGE_TYPES = new Set(['calls', 'invokes', 'method_call', 'delegates_to', 'uses', 'queries']);

const MAX_CONCEPT_GROUPS = 20;

export interface ConceptGroup {

  id: string;
  label: string;
  count: number;

  nodeIds: string[];
}

function titleCase(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export function buildConceptGroups(inventory: Record<string, string[]> | undefined): ConceptGroup[] {
  if (!inventory) return [];
  const groups = Object.entries(inventory)
    .filter(([, ids]) => Array.isArray(ids) && ids.length > 0)
    .map(([id, ids]) => ({ id, label: CONCEPT_LABELS[id] ?? titleCase(id), count: ids.length, nodeIds: ids }))
    .sort((a, b) => b.count - a.count);

  if (groups.length <= MAX_CONCEPT_GROUPS) return groups;
  const head = groups.slice(0, MAX_CONCEPT_GROUPS - 1);
  const tail = groups.slice(MAX_CONCEPT_GROUPS - 1);
  return [
    ...head,
    { id: 'other', label: 'Other', count: tail.reduce((sum, g) => sum + g.count, 0), nodeIds: tail.flatMap(g => g.nodeIds) },
  ];
}

export function conceptNodeId(groupId: string): string {
  return `concept:${groupId}`;
}

export function buildConceptDiagramNodes(groups: ConceptGroup[]): GraphNode[] {
  return groups.map(g => ({ id: conceptNodeId(g.id), label: `${g.label} (${g.count})`, weight: g.count }));
}

export function buildConceptDiagramEdges(groups: ConceptGroup[], edges: RawCallEdge[]): DiagramEdge[] {
  const nodeToGroups = new Map<string, string[]>();
  for (const group of groups) {
    if (EDGE_EXCLUDED_CONCEPTS.has(group.id)) continue;
    for (const nodeId of group.nodeIds) {
      const list = nodeToGroups.get(nodeId);
      if (list) list.push(group.id);
      else nodeToGroups.set(nodeId, [group.id]);
    }
  }

  const pairCounts = new Map<string, number>();
  for (const edge of edges) {
    if (!CALL_EDGE_TYPES.has(edge.type)) continue;
    const sourceGroups = nodeToGroups.get(edge.source);
    const targetGroups = nodeToGroups.get(edge.target);
    if (!sourceGroups || !targetGroups) continue;
    for (const sourceGroup of sourceGroups) {
      for (const targetGroup of targetGroups) {
        if (sourceGroup === targetGroup) continue;
        const key = `${sourceGroup}->${targetGroup}`;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }

  return Array.from(pairCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => {
      const [sourceGroup, targetGroup] = key.split('->');
      return {
        id: `concept-edge:${key}`,
        source: conceptNodeId(sourceGroup),
        target: conceptNodeId(targetGroup),
        label: `${count} call${count === 1 ? '' : 's'}`,
      };
    });
}

export type ArchitectureDiagramPerspectiveId = 'structural' | 'exposure';

function evidenceKey(e: DeployableEvidence, index: number): string {
  return `${e.kind}:${e.name}:${index}`;
}

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

export function promotedUnitIdForEvidence(evidence: DeployableEvidence[], nodeId: string): string | undefined {
  const index = buildDasIndex(evidence);
  const match = evidence.findIndex((e, i) => evidenceKey(e, i) === nodeId);
  if (match < 0) return undefined;
  const target = evidence[match];
  return index.units.find(u => u.name === target.name && u.root_path === normalizePath(target.root_path))?.id;
}
