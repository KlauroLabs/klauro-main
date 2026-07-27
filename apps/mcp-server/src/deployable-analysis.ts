import type {
  CASOutput,
  CASNode,
  CASEdge,
  CASEntryPoint,
  CASExitPoint,
  CASDataEntity,
  CASEntityLineage,
  CASWorkflow,
  CASUserJourney,
  CASFlowGraph,
  SystemCapability,
  DeployableEvidence,
} from '../../../packages/analyzer-core/src/types/cas.types';
import {
  buildDeployableRoots,
  matchDeployableRoot,
  extractEntryPointFilePath,
  type DeployableRoot,
} from '../../../packages/analyzer-core/src/analyzer/core/entry-point-deployable';

/**
 * DEPLOYABLE ANALYSIS SPECIFICATION (DAS) — PHASE 1
 *
 * Implements docs/SPEC-DEPLOYABLE-ANALYSIS.md §1-§3 + §6-§7: the promotion
 * rule, per-deployable slicing, and retrieval-by-scope. Per the user's
 * verbatim constraint ("as long as the DAS is effectively the same data as
 * the CAS we're good"), a DAS unit is NOT a new object model — it is a
 * CASOutput-SHAPED object, scoped to one deployable's reachability closure,
 * built from the SAME fields a repo-level CAS already carries. No new types
 * are introduced for nodes/edges/entry-exit-points/entities/capabilities;
 * this module only ever DERIVES a subgraph + a thin index, never re-parses
 * source and never invents a second semantic algorithm (§2.1 step 4).
 *
 * STORAGE (phase 1, per spec §9 open question 2): recompute-on-request. A
 * DAS unit is a VIEW over its parent CAS, not a persisted analysis artifact —
 * cheapest honest starting point; see the phase-2 open items at the bottom of
 * this file for the persistence tradeoff.
 */

// ---------------------------------------------------------------------------
// §1 — Promotion rule
// ---------------------------------------------------------------------------

/**
 * A Tier-1 row (container / compose-service / k8s / serverless / installer /
 * ci-deploy) is always a ship declaration by construction — DeployableEvidence
 * never assigns tier 1 to a 'server-entry' or 'package' kind (see
 * cas.types.ts's DeployableEvidence.tier/kind pairing), so no extra kind check
 * is needed here the way communication-seams.ts's isShipBoundary needs one
 * for the general SystemApplication case.
 */
function isTier1ShipDeclaration(e: DeployableEvidence): boolean {
  return e.tier === 1;
}

/**
 * The set of DeployableEvidence rows that count toward the promotion
 * threshold — "tier-qualified ship units" (spec §1). A CAS-scoped counterpart
 * to cross-codebase-analysis.ts's buildApplications/applyShippedGate. Rule:
 *  - A row with bundled_into set never counts on its own.
 *  - Every standalone Tier-1 row counts.
 *  - A standalone Tier-2/3 row counts only if it's the sole runnable candidate
 *    in the repo and not a server-entry row (a per-route entry is an entry
 *    point, not a ship unit). Otherwise it fails the shipped-gate.
 *  - Tier-4 folder-heuristic evidence never appears in deployable_evidence at
 *    all (DeployableEvidence.tier is typed 1|2|3), so no explicit exclusion is needed here.
 */
export function tierQualifiedShipUnits(evidence: DeployableEvidence[] | undefined): DeployableEvidence[] {
  const items = evidence || [];
  const standalone = items.filter(e => !e.bundled_into);
  const tier1Units = standalone.filter(isTier1ShipDeclaration);

  const allRunnable = items.filter(e => e.tier === 2 || e.tier === 3);
  const soleRunnable = allRunnable.length <= 1;
  const tier23Units = standalone.filter(e =>
    (e.tier === 2 || e.tier === 3) &&
    e.kind !== 'server-entry' &&
    soleRunnable,
  );

  return [...tier1Units, ...tier23Units];
}

/**
 * The promotion gate itself (spec §1): a CAS promotes to a Deployable-
 * Analysis Workspace when it resolves >= 2 tier-qualified ship units. A
 * single-deployable CAS (the overwhelming common case, spec §7 "single-
 * deployable CAS is a valid, common, terminal state") MUST NOT promote —
 * this function returns false for 0 or 1 qualified units, never emitting a
 * one-entry DAS-unit list masquerading as a rollup.
 */
export function shouldPromote(cas: Pick<CASOutput, 'deployable_evidence'>): boolean {
  return tierQualifiedShipUnits(cas.deployable_evidence).length >= 2;
}

// ---------------------------------------------------------------------------
// Stable DAS unit identity (spec §7 "no phantom units")
// ---------------------------------------------------------------------------

/**
 * Deterministic id for a DeployableEvidence row, reusing the same
 * identity-collision-guarded construction buildDeployableRoots applies to
 * derive deployable_id — a pure function of evidence content, never of array
 * position, so re-analyzing an unchanged repo re-derives the same id.
 */
function dasUnitIds(evidence: DeployableEvidence[]): string[] {
  return buildDeployableRoots(evidence).map(root => `das:${root.deployable_id.replace(/^dep:/, '')}`);
}

// ---------------------------------------------------------------------------
// §2.1 — Slicing: seed set + reachability closure
// ---------------------------------------------------------------------------

/** Call-graph edge types the reachability closure walks (spec §2.1 step 2:
 *  "walk the CAS call graph"). Non-call edges (imports, contains, extends,
 *  ...) are NOT part of the closure walk, but a survives-node's full induced
 *  edge set (of every type) is still projected into the slice afterward —
 *  see projectSlice below — so the slice's own edges are complete, only the
 *  MEMBERSHIP decision is call-graph-scoped. */
const CALL_GRAPH_EDGE_TYPES = new Set(['calls', 'invokes']);

function bundledMembersOf(unit: DeployableEvidence, allEvidence: DeployableEvidence[]): DeployableEvidence[] {
  return allEvidence.filter(e => e !== unit && e.bundled_into === unit.name);
}

/** A's own root plus every bundled member's root (spec §2.1 step 1: "A's own
 *  ships_paths — its own root plus any bundled member roots"). Bundled-member
 *  roots are read from their OWN `root_path` (the real filesystem root a
 *  Tier-2/3 provider recorded), not re-parsed from the Tier-1 row's
 *  `ships_paths` string list, which names artifacts, not paths. */
function unitRoots(
  unit: DeployableEvidence,
  allEvidence: DeployableEvidence[],
  allRoots: DeployableRoot[],
): DeployableRoot[] {
  const idx = allEvidence.indexOf(unit);
  const own = allRoots[idx];
  const members = bundledMembersOf(unit, allEvidence);
  const memberRoots = members.map(m => allRoots[allEvidence.indexOf(m)]).filter(Boolean) as DeployableRoot[];
  return own ? [own, ...memberRoots] : memberRoots;
}

function exitPointFile(exit: CASExitPoint, nodesById: Map<string, CASNode>): string | undefined {
  return (exit.metadata as any)?.file || nodesById.get(exit.source_node)?.source?.file;
}

interface SeedSet {
  seedNodeIds: Set<string>;
  seedEntryPoints: CASEntryPoint[];
  seedExitPoints: CASExitPoint[];
}

/** Spec §2.1 step 1: the seed set is every node physically under the unit's
 *  own roots, plus the entry/exit points whose file falls under those same
 *  roots (and their handler/source nodes, defensively, in case an
 *  entry/exit's handler node lives in a differently-recorded file). */
function seedsForUnit(cas: CASOutput, roots: DeployableRoot[], nodesById: Map<string, CASNode>): SeedSet {
  const seedNodeIds = new Set<string>();
  for (const n of cas.nodes) {
    const file = n.source?.file;
    if (file && matchDeployableRoot(file, roots)) seedNodeIds.add(n.id);
  }

  const seedEntryPoints = (cas.entry_points || []).filter(ep => {
    const file = extractEntryPointFilePath(ep, nodesById);
    return Boolean(file && matchDeployableRoot(file, roots));
  });
  const seedExitPoints = (cas.exit_points || []).filter(exit => {
    const file = exitPointFile(exit, nodesById);
    return Boolean(file && matchDeployableRoot(file, roots));
  });

  for (const ep of seedEntryPoints) {
    if (ep.handler?.node_id) seedNodeIds.add(ep.handler.node_id);
    else if (ep.source_node) seedNodeIds.add(ep.source_node);
  }
  for (const exit of seedExitPoints) {
    if (exit.source_node) seedNodeIds.add(exit.source_node);
  }

  return { seedNodeIds, seedEntryPoints, seedExitPoints };
}

/**
 * Spec §2.1 step 2: expand the seed node set by call-graph reachability —
 * "forward from the seed entry points... backward from the seed exit
 * points". Deliberately TWO INDEPENDENT one-directional walks from the SAME
 * seed set, not one undirected walk: a forward walk from a seed may pass
 * THROUGH a shared node (e.g. a common util both this unit and a sibling
 * unit call) on its way to that shared node's own callees, but must NOT then
 * turn around and walk BACKWARD from that shared node to pick up the
 * sibling's OTHER callers — that would merge two independent units' closures
 * into one connected blob through any shared dependency, which is exactly
 * the false-positive shared-code contour identity crisis point 2.2's
 * canonical-ownership pass exists to prevent bleeding into the more basic
 * reachability step. Each direction only ever propagates FROM the seed set,
 * never re-seeds itself from a node discovered by the other direction. */
function reachabilityClosure(edges: CASEdge[], seed: Set<string>): Set<string> {
  const forward = new Map<string, string[]>();
  const backward = new Map<string, string[]>();
  for (const e of edges) {
    if (!CALL_GRAPH_EDGE_TYPES.has(e.type)) continue;
    if (!forward.has(e.source)) forward.set(e.source, []);
    forward.get(e.source)!.push(e.target);
    if (!backward.has(e.target)) backward.set(e.target, []);
    backward.get(e.target)!.push(e.source);
  }

  const walk = (adj: Map<string, string[]>): Set<string> => {
    const visited = new Set(seed);
    const queue: string[] = [...seed];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const next of adj.get(cur) || []) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
    return visited;
  };

  const forwardReached = walk(forward);
  const backwardReached = walk(backward);
  const combined = new Set(seed);
  for (const id of forwardReached) combined.add(id);
  for (const id of backwardReached) combined.add(id);
  return combined;
}

// ---------------------------------------------------------------------------
// §2.2 — Shared-code attribution
// ---------------------------------------------------------------------------

export type DasAttribution = 'exclusive' | 'owned' | 'shared';

interface NodeAttribution {
  attribution: 'exclusive' | 'shared';
  canonicalOwnerIndex: number;
  canonicalOwnerId: string;
  alsoUsedBy: string[];
}

/** Longest-prefix DIRECT ownership: does this file live under one of the
 *  qualified units' own (non-shared) roots? Used as the primary canonical-
 *  owner signal (spec §2.2: "the ship unit whose evidence most directly
 *  identifies it — e.g. the libs/* package a Dockerfile's build context
 *  explicitly copies"). */
function directOwnerIndex(
  file: string,
  rootsWithOwner: Array<{ root: DeployableRoot; unitIndex: number }>,
): number | undefined {
  let best: { len: number; unitIndex: number } | undefined;
  for (const { root, unitIndex } of rootsWithOwner) {
    if (matchDeployableRoot(file, [root]) && root.rootPath.length > (best?.len ?? -1)) {
      best = { len: root.rootPath.length, unitIndex };
    }
  }
  return best?.unitIndex;
}

interface UnitReachability {
  index: number;
  id: string;
  name: string;
  reachable: Set<string>;
}

/**
 * Determine, for every node reached by MORE THAN ONE unit's closure, a single
 * canonical owner (spec §2.2: "never zero, never more than one"). Direct
 * physical containment under a unit's own root wins when it resolves to one
 * of the units actually reaching the node; otherwise falls back to "the unit
 * that imports the largest reachable share of it" (approximated per-FILE:
 * whichever reaching unit's closure includes the most nodes from that same
 * file), ties broken by declaration order (array index) for determinism.
 * Nodes reached by exactly one unit are 'exclusive' — not shared code at all.
 */
function computeAttribution(
  nodes: CASNode[],
  units: UnitReachability[],
  rootsWithOwner: Array<{ root: DeployableRoot; unitIndex: number }>,
): Map<string, NodeAttribution> {
  const nodesById = new Map(nodes.map(n => [n.id, n]));
  const reachingUnits = new Map<string, number[]>();
  for (const u of units) {
    for (const id of u.reachable) {
      if (!reachingUnits.has(id)) reachingUnits.set(id, []);
      reachingUnits.get(id)!.push(u.index);
    }
  }

  const fileUnitCounts = new Map<string, Map<number, number>>();
  for (const u of units) {
    for (const id of u.reachable) {
      const file = nodesById.get(id)?.source?.file;
      if (!file) continue;
      if (!fileUnitCounts.has(file)) fileUnitCounts.set(file, new Map());
      const m = fileUnitCounts.get(file)!;
      m.set(u.index, (m.get(u.index) || 0) + 1);
    }
  }

  const out = new Map<string, NodeAttribution>();
  for (const [nodeId, unitIdxs] of reachingUnits) {
    if (unitIdxs.length <= 1) {
      const idx = unitIdxs[0];
      out.set(nodeId, { attribution: 'exclusive', canonicalOwnerIndex: idx, canonicalOwnerId: units[idx].id, alsoUsedBy: [] });
      continue;
    }

    const file = nodesById.get(nodeId)?.source?.file;
    let ownerIdx = file ? directOwnerIndex(file, rootsWithOwner) : undefined;
    if (ownerIdx === undefined || !unitIdxs.includes(ownerIdx)) {
      const counts = file ? fileUnitCounts.get(file) : undefined;
      let best = unitIdxs[0];
      let bestCount = -1;
      for (const idx of unitIdxs) {
        const c = counts?.get(idx) ?? 0;
        if (c > bestCount) {
          bestCount = c;
          best = idx;
        }
      }
      ownerIdx = best;
    }

    out.set(nodeId, {
      attribution: 'shared',
      canonicalOwnerIndex: ownerIdx,
      canonicalOwnerId: units[ownerIdx].id,
      alsoUsedBy: unitIdxs.filter(i => i !== ownerIdx).map(i => units[i].id),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// §3 — Derived-layer projection (capabilities/flows/entities/seams)
// ---------------------------------------------------------------------------

function filterCapabilities(caps: SystemCapability[] | undefined, includedEntryPointIds: Set<string>): SystemCapability[] {
  return (caps || []).filter(cap => (cap.operations || []).some(op => includedEntryPointIds.has(op.entry_point_id)));
}

function filterWorkflows(workflows: CASWorkflow[] | undefined, includedEntryPointIds: Set<string>): CASWorkflow[] {
  return (workflows || []).filter(w => (w.entry_points || []).some(id => includedEntryPointIds.has(id)));
}

function filterUserJourneys(journeys: CASUserJourney[] | undefined, includedEntryPointIds: Set<string>): CASUserJourney[] {
  return (journeys || []).filter(j => includedEntryPointIds.has(j.entry_point_id));
}

function filterFlowGraph(flowGraph: CASFlowGraph | undefined, includedEntryPointIds: Set<string>): CASFlowGraph | undefined {
  if (!flowGraph) return undefined;
  const survivingCaps = (flowGraph.capabilities || []).filter(cap =>
    (cap.entry_points || []).some(id => includedEntryPointIds.has(id)));
  if (survivingCaps.length === 0) return undefined;
  const survivingIds = new Set(survivingCaps.map(c => c.id));
  return {
    capabilities: survivingCaps,
    // Flows are narrowed to the surviving entry points so the deployable-scoped
    // slice keeps referential integrity: every flow_id still reachable from a
    // surviving capability's related_flows must resolve here too.
    ...(flowGraph.flows
      ? {
          flows: flowGraph.flows.filter(flow =>
            includedEntryPointIds.has(flow.entry_point) ||
            (flow.capability_ids || []).some(id => survivingIds.has(id)) ||
            (flow.capability_id ? survivingIds.has(flow.capability_id) : false)),
        }
      : {}),
    dependencies: (flowGraph.dependencies || []).filter(d => survivingIds.has(d.from_capability) && survivingIds.has(d.to_capability)),
    topology: {
      root_capabilities: (flowGraph.topology?.root_capabilities || []).filter(id => survivingIds.has(id)),
      leaf_capabilities: (flowGraph.topology?.leaf_capabilities || []).filter(id => survivingIds.has(id)),
      critical_path: (flowGraph.topology?.critical_path || []).filter(id => survivingIds.has(id)),
      max_depth: flowGraph.topology?.max_depth ?? 0,
    },
    primary_flow: {
      core_capability_id: flowGraph.primary_flow?.core_capability_id ?? '',
      value_chain: (flowGraph.primary_flow?.value_chain || []).filter(id => survivingIds.has(id)),
      supporting_capabilities: (flowGraph.primary_flow?.supporting_capabilities || []).filter(id => survivingIds.has(id)),
      infrastructure_capabilities: (flowGraph.primary_flow?.infrastructure_capabilities || []).filter(id => survivingIds.has(id)),
    },
    layers: (flowGraph.layers || [])
      .map(layer => ({ ...layer, capabilities: layer.capabilities.filter(id => survivingIds.has(id)) }))
      .filter(layer => layer.capabilities.length > 0),
    system_insights: flowGraph.system_insights,
  };
}

function filterDataEntities(entities: CASDataEntity[] | undefined, reachable: Set<string>): CASDataEntity[] {
  return (entities || []).filter(e => {
    const lc = e.lifecycle || { created_by: [], read_by: [], updated_by: [], deleted_by: [] };
    return [...lc.created_by, ...lc.read_by, ...lc.updated_by, ...lc.deleted_by].some(id => reachable.has(id));
  });
}

function filterDataLineage(lineage: CASEntityLineage[] | undefined, reachableFiles: Set<string>): CASEntityLineage[] {
  return (lineage || []).filter(entity =>
    (entity.writers || []).some(w => w.file && reachableFiles.has(w.file)) ||
    (entity.readers || []).some(r => r.file && reachableFiles.has(r.file)));
}

/** Local re-aggregation of communication_seams into this unit's slice —
 *  mirrors communication-seams.ts's buildInventory shape but is NOT imported
 *  from it (that function is private to the module); filtering here is by
 *  membership of the seam's driving evidence id in this unit's included
 *  entry/exit/entity ids, so a seam only appears in a slice when its OWN
 *  evidence is inside the slice — never re-classified. */
function filterCommunicationSeams(
  seams: CASOutput['communication_seams'],
  includedEntryPointIds: Set<string>,
  includedExitPointIds: Set<string>,
  includedEntityIds: Set<string>,
): CASOutput['communication_seams'] {
  if (!seams) return undefined;
  const kept = seams.seams.filter(s => {
    const meta = s.metadata || {};
    if (typeof meta.exit_point === 'string') return includedExitPointIds.has(meta.exit_point);
    if (typeof meta.entry_point === 'string') return includedEntryPointIds.has(meta.entry_point);
    if (typeof meta.entity_id === 'string') return includedEntityIds.has(meta.entity_id);
    return false;
  });
  if (kept.length === 0) return undefined;

  const counts = { sync: 0, async: 0, passive: 0, total: 0 };
  const byEdge = new Map<string, { source: string; target: string; sync: number; async: number; passive: number }>();
  for (const s of kept) {
    counts[s.modality] += 1;
    counts.total += 1;
    const key = `${s.source}=>${s.target}`;
    if (!byEdge.has(key)) byEdge.set(key, { source: s.source, target: s.target, sync: 0, async: 0, passive: 0 });
    byEdge.get(key)![s.modality] += 1;
  }
  const component_seams = Array.from(byEdge.values())
    .map(e => {
      const modalities: Array<'sync' | 'async' | 'passive'> = [];
      if (e.sync > 0) modalities.push('sync');
      if (e.async > 0) modalities.push('async');
      if (e.passive > 0) modalities.push('passive');
      return { ...e, modalities, total: e.sync + e.async + e.passive };
    })
    .sort((a, b) => b.total - a.total || a.source.localeCompare(b.source));

  return { seams: kept, inventory: { level: 'node', counts, component_seams } };
}

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface DasUnitIndexEntry {
  /** Stable id, spec §7 (derived from the owning DeployableEvidence's
   *  identity — same construction as buildDeployableRoots' deployable_id). */
  id: string;
  name: string;
  root_path: string;
  member_root_paths: string[];
  tier: 1 | 2 | 3;
  kind: DeployableEvidence['kind'];
  node_count: number;
  entry_point_count: number;
  exit_point_count: number;
  boundary_evidence: string[];
}

export interface DasIndex {
  promoted: boolean;
  units: DasUnitIndexEntry[];
  /** Nodes reached by NO unit at all (spec asks these be reported, not
   *  silently dropped, so counts stay honest — "no node in zero slices
   *  unless genuinely unreachable"). Empty when every node is claimed by at
   *  least one unit's closure. */
  orphan_node_count: number;
  orphan_node_ids: string[];
}

export interface DasUnitSlice {
  das_unit_id: string;
  das_unit_name: string;
  root_path: string;
  member_root_paths: string[];
  /** CASOutput-SHAPED slice — same field names/types a repo-level CAS uses,
   *  restricted to this unit's reachability closure. Deliberately Partial:
   *  fields with no unit-scoped meaning (system, cas_version, ...) are filled
   *  from the parent CAS as-is; repo-rollup-only fields per spec §3
   *  (codebase_idioms, conventions_applied, test_summary, ...) are simply
   *  absent — they stay on the parent CAS, not duplicated here. */
  slice: Pick<
    CASOutput,
    | 'cas_version'
    | 'analyzer_build'
    | 'analysis_timestamp'
    | 'analysis_id'
    | 'system'
    | 'nodes'
    | 'edges'
    | 'entry_points'
    | 'exit_points'
    | 'data_entities'
    | 'data_lineage'
    | 'system_capabilities'
    | 'behavior_surfaces'
    | 'flow_graph'
    | 'workflows'
    | 'user_journeys'
    | 'communication_seams'
  > & { deployable_evidence: DeployableEvidence[] };
}

export interface BuildDeployableAnalysesResult {
  promoted: boolean;
  das_index: DasIndex;
  units: DasUnitSlice[];
}

// ---------------------------------------------------------------------------
// §2.1 + §2.2 — sliceDeployableAnalysis (single unit)
// ---------------------------------------------------------------------------

/**
 * Slice one tier-qualified deployable's DAS unit out of the repo's own CAS.
 * Pure/derived-only: reads `cas`'s already-extracted facts, walks the
 * already-extracted call graph, and projects the already-extracted
 * capability/flow/entity/seam layers onto the resulting node subset. Never
 * reads source, never invents a second capability/flow algorithm.
 */
export function sliceDeployableAnalysis(cas: CASOutput, deployable: DeployableEvidence): DasUnitSlice {
  const allEvidence = cas.deployable_evidence || [];
  const allRoots = buildDeployableRoots(allEvidence);
  const nodesById = new Map(cas.nodes.map(n => [n.id, n]));

  const roots = unitRoots(deployable, allEvidence, allRoots);
  const { seedNodeIds, seedEntryPoints, seedExitPoints } = seedsForUnit(cas, roots, nodesById);
  const reachable = reachabilityClosure(cas.edges || [], seedNodeIds);

  const idx = allEvidence.indexOf(deployable);
  const unitId = dasUnitIds(allEvidence)[idx] ?? `das:${deployable.kind}:${deployable.name}`;

  const nodes = cas.nodes.filter(n => reachable.has(n.id));
  const edges = (cas.edges || []).filter(e => reachable.has(e.source) && reachable.has(e.target));
  const reachableFiles = new Set(nodes.map(n => n.source?.file).filter((f): f is string => Boolean(f)));

  const includedEntryPointIds = new Set(seedEntryPoints.map(e => e.id));
  const includedExitPointIds = new Set(seedExitPoints.map(e => e.id));
  const dataEntities = filterDataEntities(cas.data_entities, reachable);
  const includedEntityIds = new Set(dataEntities.map(e => e.id));

  return {
    das_unit_id: unitId,
    das_unit_name: deployable.name,
    root_path: deployable.root_path,
    member_root_paths: bundledMembersOf(deployable, allEvidence).map(m => m.root_path),
    slice: {
      cas_version: cas.cas_version,
      analyzer_build: cas.analyzer_build,
      analysis_timestamp: cas.analysis_timestamp,
      analysis_id: cas.analysis_id,
      system: cas.system,
      nodes,
      edges,
      entry_points: seedEntryPoints,
      exit_points: seedExitPoints,
      data_entities: dataEntities,
      data_lineage: filterDataLineage(cas.data_lineage, reachableFiles),
      system_capabilities: filterCapabilities(cas.system_capabilities, includedEntryPointIds),
      behavior_surfaces: filterCapabilities(cas.behavior_surfaces, includedEntryPointIds),
      flow_graph: filterFlowGraph(cas.flow_graph, includedEntryPointIds),
      workflows: filterWorkflows(cas.workflows, includedEntryPointIds),
      user_journeys: filterUserJourneys(cas.user_journeys, includedEntryPointIds),
      communication_seams: filterCommunicationSeams(cas.communication_seams, includedEntryPointIds, includedExitPointIds, includedEntityIds),
      deployable_evidence: [deployable, ...bundledMembersOf(deployable, allEvidence)],
    },
  };
}

// ---------------------------------------------------------------------------
// buildDeployableAnalyses (all units + das_index + shared-code attribution)
// ---------------------------------------------------------------------------

/**
 * Top-level entry point: evaluate the promotion rule, and if it fires, slice
 * every tier-qualified unit plus tag cross-unit shared code (spec §2.2) and
 * build the rollup `das_index` (spec §3's "the list of DAS unit
 * ids/names/tiers/boundary evidence itself"). Returns `promoted: false` with
 * empty arrays for the common single-deployable case — never a synthesized
 * one-entry unit list.
 */
export function buildDeployableAnalyses(cas: CASOutput): BuildDeployableAnalysesResult {
  const allEvidence = cas.deployable_evidence || [];
  const qualified = tierQualifiedShipUnits(allEvidence);

  if (qualified.length < 2) {
    return { promoted: false, das_index: { promoted: false, units: [], orphan_node_count: 0, orphan_node_ids: [] }, units: [] };
  }

  const allRoots = buildDeployableRoots(allEvidence);
  const unitIdByEvidence = dasUnitIds(allEvidence);

  // Slice every unit once (reachability closure), then compute shared
  // attribution across all of them, then re-tag each slice's nodes.
  const rawSlices = qualified.map(unit => sliceDeployableAnalysis(cas, unit));

  const unitsReachability: UnitReachability[] = qualified.map((unit, i) => ({
    index: i,
    id: rawSlices[i].das_unit_id,
    name: unit.name,
    reachable: new Set(rawSlices[i].slice.nodes.map(n => n.id)),
  }));

  const rootsWithOwner = qualified.map((unit, i) => {
    const idx = allEvidence.indexOf(unit);
    return { root: allRoots[idx], unitIndex: i };
  }).filter((r): r is { root: DeployableRoot; unitIndex: number } => Boolean(r.root));

  const attribution = computeAttribution(cas.nodes, unitsReachability, rootsWithOwner);

  const units: DasUnitSlice[] = rawSlices.map((raw, i) => {
    const thisUnitId = unitsReachability[i].id;
    const nodes = raw.slice.nodes.map(n => {
      const info = attribution.get(n.id);
      if (!info || info.attribution !== 'shared') return n;
      const isOwner = info.canonicalOwnerId === thisUnitId;
      const taggedMetadata: Record<string, unknown> = {
        ...n.metadata,
        attribution: (isOwner ? 'owned' : 'shared') as DasAttribution,
        ...(isOwner
          ? { also_used_by: info.alsoUsedBy }
          : { canonical_owner_das_unit_id: info.canonicalOwnerId }),
      };
      return {
        ...n,
        metadata: taggedMetadata as unknown as CASNode['metadata'],
      };
    });
    return { ...raw, slice: { ...raw.slice, nodes } };
  });

  // Honest counts (spec §7): every node reached by no unit at all is an
  // orphan — reported, never silently dropped from the total.
  const reachedAnywhere = new Set<string>();
  for (const u of unitsReachability) for (const id of u.reachable) reachedAnywhere.add(id);
  const orphanIds = cas.nodes.filter(n => !reachedAnywhere.has(n.id)).map(n => n.id);

  const das_index: DasIndex = {
    promoted: true,
    units: qualified.map((unit, i) => ({
      id: unitsReachability[i].id,
      name: unit.name,
      root_path: unit.root_path,
      member_root_paths: bundledMembersOf(unit, allEvidence).map(m => m.root_path),
      tier: unit.tier,
      kind: unit.kind,
      node_count: units[i].slice.nodes.length,
      entry_point_count: (units[i].slice.entry_points || []).length,
      exit_point_count: (units[i].slice.exit_points || []).length,
      boundary_evidence: unit.evidence,
    })),
    orphan_node_count: orphanIds.length,
    orphan_node_ids: orphanIds.slice(0, 50),
  };

  return { promoted: true, das_index, units };
}

// ---------------------------------------------------------------------------
// §6 — Retrieval
// ---------------------------------------------------------------------------

/**
 * Resolve a `{ das_unit_id }` scope against a CAS: recomputes
 * `buildDeployableAnalyses` (phase-1 recompute-on-request storage posture,
 * see the module doc comment) and returns the matching unit's slice, or
 * `undefined` when the CAS hasn't promoted or the id doesn't match any
 * current unit (a caller should treat that as "this scope no longer exists",
 * e.g. after a demotion — spec §5/§7's reportable-demotion rule, surfaced by
 * the caller comparing against the previous das_index, not by this
 * function, which is a pure lookup).
 */
export function resolveDasScope(cas: CASOutput, dasUnitId: string): DasUnitSlice | undefined {
  const { units } = buildDeployableAnalyses(cas);
  return units.find(u => u.das_unit_id === dasUnitId);
}

// ---------------------------------------------------------------------------
// PHASE 2 — in-process cache + product-surface scope resolution
// ---------------------------------------------------------------------------

/**
 * `buildDeployableAnalyses` is pure over `cas` (spec §2.1 step 4: "MUST be
 * reproducible from its parent CAS's own facts") but re-derives the full
 * reachability closure + shared-code attribution pass on every call. Repeated
 * MCP calls against the SAME analysis (get_summary, then get_entry_points,
 * then a scoped get_file_nodes, ...) would otherwise pay that cost once per
 * tool call instead of once per analysis. A tiny recency-ordered LRU (not a
 * persistence layer — phase-1's "recompute-on-request" posture is unchanged,
 * see the module doc comment) makes repeat calls within one analysis's
 * lifetime cheap without introducing a stored DAS artifact. Keyed on
 * `analysis_id` (stable per stored analysis) with a content-shaped fallback
 * for CAS objects built in-memory without one (e.g. test fixtures, proposal
 * previews) so the cache degrades to "no reuse" instead of throwing.
 */
const DAS_CACHE_LIMIT = 32;
const dasAnalysisCache = new Map<string, BuildDeployableAnalysesResult>();

function dasCacheKey(cas: CASOutput): string {
  if (cas.analysis_id) return cas.analysis_id;
  return `${cas.system?.name || 'unknown'}:${cas.analysis_timestamp || ''}:${cas.nodes?.length ?? 0}:${(cas.edges || []).length}`;
}

export function getCachedDeployableAnalyses(cas: CASOutput): BuildDeployableAnalysesResult {
  const key = dasCacheKey(cas);
  const cached = dasAnalysisCache.get(key);
  if (cached) {
    // Touch recency: delete+re-set moves this key to the Map's MRU end
    // (insertion order is iteration order), so eviction below stays LRU.
    dasAnalysisCache.delete(key);
    dasAnalysisCache.set(key, cached);
    return cached;
  }
  const result = buildDeployableAnalyses(cas);
  dasAnalysisCache.set(key, result);
  if (dasAnalysisCache.size > DAS_CACHE_LIMIT) {
    const oldestKey = dasAnalysisCache.keys().next().value;
    if (oldestKey !== undefined) dasAnalysisCache.delete(oldestKey);
  }
  return result;
}

export interface DasScopeParam {
  das_unit_id: string;
}

/**
 * Resolves an optional scope: { das_unit_id } against a repo-level CAS (spec
 * §6). Returns the parent cas unchanged when scope is omitted. When given,
 * returns a CASOutput-shaped object with the DAS unit's sliced fields
 * overlaid on the parent CAS — repo-rollup-only facts with no unit-scoped
 * meaning pass through unchanged, so counts/nodes/entries reflect the unit,
 * never the rollup. Throws (never a silent empty result) when the CAS hasn't
 * promoted, or when das_unit_id doesn't match any current unit — naming the
 * ids that do exist.
 */
export function scopeCasToDasUnit(cas: CASOutput, scope: DasScopeParam | undefined): CASOutput {
  if (!scope) return cas;
  const { promoted, das_index, units } = getCachedDeployableAnalyses(cas);
  if (!promoted) {
    throw new Error(
      'This analysis has not promoted to a Deployable-Analysis Workspace (it resolves fewer than 2 tier-qualified ship units), so scope.das_unit_id does not apply. Omit scope to query the whole repo.'
    );
  }
  const unit = units.find(u => u.das_unit_id === scope.das_unit_id);
  if (!unit) {
    const available = das_index.units.map(u => `${u.id} (${u.name})`).join(', ') || 'none';
    throw new Error(`Unknown scope.das_unit_id '${scope.das_unit_id}'. Available DAS units for this analysis: ${available}.`);
  }
  return { ...cas, ...unit.slice } as CASOutput;
}

/*
 * TODO (phase-3, deliberately out of scope here):
 *  1. Persistence — true incremental re-slicing (spec §5) needs a stored
 *     per-unit node-id-set to diff against, which this module doesn't build.
 *  2. Deeper per-unit layers not yet projected (behavioral invariants,
 *     security boundaries, flow_coverage/test_gaps, idiom violations scoped to
 *     a unit) — structurally sliceable by the same technique used here, just
 *     not wired yet; `scope` currently reaches only get_summary,
 *     get_entry_points, get_file_nodes, get_data_entities, search_nodes.
 *  3. True flow/capability re-derivation over the sliced subgraph (spec §2.1
 *     step 3's ideal) vs. this phase's cheaper filter-down approximation,
 *     which can under/over-scope a capability whose entry points and entities
 *     span unit boundaries differently.
 */
