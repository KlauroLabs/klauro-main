import type { DeployableEvidence } from '../deployable/dasTypes';
import { KIND_LABEL } from '../deployable/dasLabels';
import { buildDasIndex, normalizePath } from '../deployable/dasIndex';
import type { RawCallEdge } from '../../hooks/useArchitectureConcepts';
import type { GraphNode } from '../../components/diagram/graphLayout';
import type { DiagramEdge } from '../../components/diagram/GraphCanvas';

// ---------------------------------------------------------------------------
// CONCEPTS lens (default) — framework concepts, not raw evidence rows. See
// useArchitectureConcepts.ts for where the data comes from and why it's real
// (architecture_summary.architectural_inventory's arrays are node ids).
// ---------------------------------------------------------------------------

/** Plain-language labels for the fixed architectural_inventory categories
 *  (packages/analyzer-core/src/types/cas.types.ts CASArchitecturalInventory —
 *  a closed, server-defined set, never a UI-invented one). */
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

/** Categories broad enough to catch most of the codebase (e.g. "packages" —
 *  matches src/lib/module by file path alone) are still real concept GROUPS
 *  (their count is honest) but are excluded as call-edge endpoints: every
 *  other group would appear to "call" them, which is membership noise, not
 *  a relationship. */
const EDGE_EXCLUDED_CONCEPTS = new Set(['packages']);

/** Edge types that represent an actual call/use relationship in the CAS call
 *  graph (see orchestrator.ts CALLEE_EDGE_TYPES / callEdgeTypes constants) —
 *  the only edges grouped-and-counted between concept groups. */
const CALL_EDGE_TYPES = new Set(['calls', 'invokes', 'method_call', 'delegates_to', 'uses', 'queries']);

const MAX_CONCEPT_GROUPS = 20;

export interface ConceptGroup {
  /** The architectural_inventory category key (e.g. 'services'). */
  id: string;
  label: string;
  count: number;
  /** Node ids in this category — used for edge aggregation and for the
   *  functions-page click-through, never rendered directly. */
  nodeIds: string[];
}

function titleCase(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/** Builds 5-20 concept groups from architecture_summary.architectural_inventory,
 *  sorted by size, tail-aggregated into 'Other (n)' past MAX_CONCEPT_GROUPS.
 *  Empty/zero-count categories are dropped rather than shown as empty boxes —
 *  an honest count of what evidence exists can land under 5 for a very small
 *  or non-layered codebase; never padded to hit a floor. */
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

/** Edges = aggregated call-graph relationships BETWEEN groups (counted, not
 *  drawn node-to-node) — cheaply derivable from the same CAS payload's
 *  `edges` array. A node may belong to more than one concept (the inventory
 *  predicates aren't mutually exclusive — e.g. a class can read as both a
 *  "service" and a "singleton"), so one call edge can fan out to more than
 *  one group pair; that is real ambiguity in the source classification, not
 *  a bug. Self-pairs (both endpoints in the same group) are dropped — they'd
 *  just be a self-loop on one box. */
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

// ---------------------------------------------------------------------------
// DEPLOYABLES lens (secondary) — every deployable_evidence row (real,
// evidence-backed ship/runnable artifacts), unchanged from the prior single-
// lens implementation. See docs/briefs/diagrams.md.
// ---------------------------------------------------------------------------

export type ArchitectureDiagramPerspectiveId = 'structural' | 'exposure';

/** A stable-enough id for a raw evidence row (deployable_evidence carries no
 *  id of its own on the HTTP payload) — same construction dasIndex.ts uses
 *  for its `dep:...` ids, kept local since this diagram draws EVERY
 *  evidence row (including bundled, non-promoted members), not just the
 *  qualified ship units dasIndex promotes. */
function evidenceKey(e: DeployableEvidence, index: number): string {
  return `${e.kind}:${e.name}:${index}`;
}

/** Nodes = every deployable_evidence row. */
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
