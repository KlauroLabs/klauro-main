import type {
  CASOutput,
  CASNode,
  CASEdge,
  CASEntryPoint,
  CASExitPoint,
  CASEntityLineage,
  CASEntityLineageAccessor,
  CASChangeRisk,
  DeployableEvidence,
} from '../../types/cas.types';
import type { CommunicationSeamsResult } from './communication-seams';
import { CONTRACT_MODEL_NAME } from './flow-concepts';

/**
 * ENTRENCHMENT — how deeply woven-in / hard-to-change-or-remove a unit is,
 * computed at EVERY level (function/node -> file -> module -> repo). High
 * entrenchment = changing it ripples widely (a load-bearing wall); low = a
 * safe leaf you can rewrite or delete in isolation.
 *
 * The concept a change-risk score does NOT capture: change-risk asks "is this
 * dangerous to touch given tests/churn". Entrenchment asks the orthogonal
 * structural question "how much of the system LEANS ON this" — a well-tested,
 * never-churned file can still be bedrock because 200 things depend on it, and
 * that is exactly what an agent needs to know before an "understand-before-edit".
 *
 * DERIVED, NEVER RE-DETECTED. This is an additive, deterministic, non-AI pass
 * over the already-assembled CASOutput, mirroring conventions-applier.ts /
 * infra-topology-linker.ts / communication-seams.ts (pure, non-blocking,
 * evidence-carrying). It reuses signals other passes already produced:
 *
 *   STRUCTURAL
 *     - fan_in           : # direct callers/dependents (call_graph.called_by /
 *                          reverse edges).
 *     - blast_radius     : transitive dependent count (change_risks downstream
 *                          impact when present, else BFS over reverse edges).
 *     - centrality       : share of the graph that can reach this node.
 *     - flow_participation: # flows/capabilities/journeys the unit sits in.
 *
 *   ICELOT-FACET ENTRENCHMENT (the novel part — how widely each contract facet
 *   is depended upon; see flow-concepts.ts CONTRACT_MODEL_NAME):
 *     - Output   : consumed by N callers (an output nothing reads isn't load-bearing).
 *     - State-changes read by OTHER modules/deployables — shared-state coupling
 *       via PASSIVE seams. THE one nobody measures: if this unit writes an entity
 *       that a different component reads, changing the write shape silently breaks
 *       a peer that never calls it. Read straight off communication_seams passive
 *       seams + data_lineage cross-component writer/reader ownership.
 *     - Constraints : an invariant/guard others depend on (this unit enforces a
 *       rule that gates callers/entities).
 *     - Integrations: others route through this unit's outbound calls.
 *     - Logic    : callers that depend on this unit's computed behavior.
 *
 *   CROSS-BOUNDARY
 *     - contract consumed across repos / across deployables -> higher entrenchment.
 *
 *   RUNTIME (when present)
 *     - telemetry traffic: a hot path is load-bearing (per-node request volume).
 *
 * Every signal is EVIDENCE-GATED: a true leaf (no callers, no shared state, in no
 * flow, no traffic) scores low and is labelled `leaf`. Nothing is fabricated; a
 * unit with no dependents cannot be inflated to bedrock.
 */

/** Which contract-model facets this pass computes dependency-weight for. Kept in
 *  lockstep with flow-concepts.ts's UNDERSTANDING_CONTRACT_FACETS via the shared
 *  CONTRACT_MODEL_NAME constant (see below) — entrenchment is the "how widely is
 *  each facet depended on" companion to the "what is each facet" contract. */
export const ENTRENCHMENT_CONTRACT_MODEL = CONTRACT_MODEL_NAME;

/** A clean 6-tier scale, low -> high woven-in-ness. */
export type EntrenchmentLevel =
  | 'leaf'         // nothing depends on it — safe to change/remove in isolation
  | 'peripheral'   // a couple of dependents, no shared state, no traffic
  | 'connected'    // several dependents or in a flow — changes have local ripple
  | 'load-bearing' // many dependents / shared-state / hot path — wide ripple
  | 'foundational' // deep blast radius + cross-cutting facet dependence
  | 'bedrock';     // the system leans on it — cross-boundary + high centrality

const LEVEL_ORDER: EntrenchmentLevel[] = [
  'leaf',
  'peripheral',
  'connected',
  'load-bearing',
  'foundational',
  'bedrock',
];

/** Per-facet dependency weight (0..1) — how widely this unit's contract facet is
 *  relied upon. Absent facets are simply 0; never fabricated. */
export interface FacetEntrenchment {
  /** Output consumed by callers (fan-in on this unit's returns). */
  output: number;
  /** State-changes this unit writes that OTHER components read (passive/shared-state). */
  state_changes: number;
  /** Invariants/guards this unit enforces that others depend on. */
  constraints: number;
  /** Outbound integrations others route through this unit to reach. */
  integrations: number;
  /** Callers depending on this unit's computed logic/behavior. */
  logic: number;
}

/** The full entrenchment record stored on a node. */
export interface NodeEntrenchment {
  node_id: string;
  /** 0..1 combined weight. */
  score: number;
  level: EntrenchmentLevel;
  /** Component-decomposed sub-scores (each 0..1) so the score is explainable. */
  signals: {
    fan_in: number;
    blast_radius: number;
    centrality: number;
    flow_participation: number;
    facets: FacetEntrenchment;
    cross_boundary: number;
    runtime: number;
  };
  /** Raw counts behind the signals, for verifiable evidence lines. */
  raw: {
    direct_dependents: number;
    transitive_dependents: number;
    flows: number;
    /** distinct OTHER components that read state this unit writes. */
    shared_state_readers: number;
    /** distinct entities whose write shape this unit owns and a peer reads. */
    shared_state_entities: string[];
    cross_repo: boolean;
    cross_deployable_readers: number;
    request_count?: number;
  };
  /** Short human-legible evidence list, e.g.
   *  ["47 dependents", "writes Client read by 4 modules", "in 3 flows", "1.9k req/day"]. */
  evidence: string[];
}

export interface FileEntrenchment {
  file: string;
  score: number;
  level: EntrenchmentLevel;
  /** # nodes in the file, and how many are load-bearing+. */
  node_count: number;
  bedrock_nodes: number;
  top_node?: string;
}

export interface ModuleEntrenchment {
  module: string;
  score: number;
  level: EntrenchmentLevel;
  file_count: number;
}

export interface EntrenchmentSummary {
  contract_model: string;
  /** Repo-level distribution across the tier scale. */
  distribution: Record<EntrenchmentLevel, number>;
  /** Repo entrenchment = weighted blend of the distribution (0..1). */
  repo_score: number;
  repo_level: EntrenchmentLevel;
  /** The bedrock set: the highest-entrenchment nodes (load-bearing and above),
   *  ranked — "change these and the system ripples". */
  bedrock: Array<{
    node_id: string;
    name: string;
    file?: string;
    score: number;
    level: EntrenchmentLevel;
    evidence: string[];
  }>;
  /** File- and module-level rollups. */
  files: FileEntrenchment[];
  modules: ModuleEntrenchment[];
  counts: { nodes_scored: number; files: number; modules: number };
}

export interface EntrenchmentResult {
  /** Per-node entrenchment keyed by node id (only nodes with a real score). */
  nodes: Record<string, NodeEntrenchment>;
  summary: EntrenchmentSummary;
}

/** Node types that are real "units" whose entrenchment is meaningful. We skip
 *  pure leaf attributes/params/imports — they inflate the distribution and are
 *  never edit targets on their own. */
const UNIT_NODE_TYPES = new Set([
  'function', 'method', 'controller', 'handler', 'route', 'resolver', 'gateway',
  'service', 'usecase', 'repository', 'dao', 'class', 'module', 'file',
  'component', 'functional_component', 'class_component', 'hook', 'custom_hook',
  'interface', 'type', 'entity', 'model', 'schema',
]);

function isUnitNode(node: CASNode): boolean {
  if (UNIT_NODE_TYPES.has(node.type)) return true;
  // A node with a call graph (callers/callees) is a real unit regardless of its
  // exact type label.
  const cg = node.call_graph;
  return Boolean(cg && ((cg.called_by?.length || 0) > 0 || (cg.calls?.length || 0) > 0));
}

/** Squash a raw count to 0..1 with a soft saturation — the first dependents
 *  matter most, and a unit with 200 vs 400 dependents is "very entrenched"
 *  either way. `k` sets the count at which we reach ~0.5. */
function saturate(count: number, k: number): number {
  if (count <= 0) return 0;
  return count / (count + k);
}

/** Two-segment (or deployable) component key for a file — the same ownership
 *  notion communication-seams uses, so shared-state readers group by component. */
function componentForFile(
  file: string | undefined,
  deployableRoots: Array<{ root: string; name: string }>,
): string {
  if (!file) return 'unknown';
  let f = file.replace(/\\/g, '/');
  if (f.startsWith('/')) {
    const m = f.match(/\/((?:apps|libs|packages|src)\/.*)$/);
    if (m) f = m[1];
    else return 'unknown';
  }
  f = f.replace(/^\/+/, '');
  let best: { root: string; name: string } | undefined;
  for (const d of deployableRoots) {
    if (d.root === '' || d.root === '.') continue;
    if (f === d.root || f.startsWith(`${d.root}/`)) {
      if (!best || d.root.length > best.root.length) best = d;
    }
  }
  if (best) return best.name;
  const parts = f.split('/');
  if (parts.length >= 3 && (parts[0] === 'libs' || parts[0] === 'packages')) {
    return parts.slice(0, 3).join('/');
  }
  if (parts.length >= 2) return parts.slice(0, 2).join('/');
  return parts[0] || 'root';
}

/** Two-segment module key for file rollup. */
function moduleForFile(file: string): string {
  const f = file.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = f.split('/');
  if (parts.length >= 3 && (parts[0] === 'libs' || parts[0] === 'packages')) {
    return parts.slice(0, 3).join('/');
  }
  if (parts.length >= 2) return parts.slice(0, 2).join('/');
  return parts[0] || 'root';
}

function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

/**
 * Compute entrenchment for every unit node, plus file/module/repo rollups.
 * Pure and additive: takes a read-only slice of the CASOutput and returns the
 * result; the caller stamps `entrenchment` onto nodes and stores the summary.
 */
export function computeEntrenchment(
  output: { nodes: CASNode[] } & Partial<
    Pick<
      CASOutput,
      | 'edges'
      | 'entry_points'
      | 'exit_points'
      | 'data_lineage'
      | 'change_risks'
      | 'communication_seams'
      | 'deployable_evidence'
      | 'call_chains'
      | 'user_journeys'
      | 'repository_links'
      | 'cross_repository_links'
    >
  > & { runtimeMetrics?: Array<{ static_id?: string; node_id?: string; request_count?: number }> },
): EntrenchmentResult {
  const nodes = output.nodes || [];
  const emptyResult: EntrenchmentResult = {
    nodes: {},
    summary: {
      contract_model: ENTRENCHMENT_CONTRACT_MODEL,
      distribution: emptyDistribution(),
      repo_score: 0,
      repo_level: 'leaf',
      bedrock: [],
      files: [],
      modules: [],
      counts: { nodes_scored: 0, files: 0, modules: 0 },
    },
  };
  if (nodes.length === 0) return emptyResult;

  const byId = new Map<string, CASNode>();
  for (const n of nodes) byId.set(n.id, n);

  const deployables: DeployableEvidence[] = output.deployable_evidence || [];
  const deployableRoots = deployables
    .filter(d => d.kind !== 'server-entry')
    .map(d => ({
      root: d.root_path.replace(/\\/g, '/').replace(/\/+$/, '').replace(/^\/+/, ''),
      name: d.name,
    }));
  const nodeFile = new Map<string, string>();
  for (const n of nodes) if (n.source?.file) nodeFile.set(n.id, n.source.file);

  // ---- STRUCTURAL: fan-in + reverse-dependent graph -----------------------
  // Reverse adjacency (dependent -> unit) from BOTH the call_graph.called_by
  // facts and the graph edges (CALLS/USES/DEPENDS_ON/RENDERS...). We union so a
  // node with edge-only or called_by-only evidence is still covered.
  const dependents = new Map<string, Set<string>>(); // unit id -> set of dependent ids
  const addDependent = (unit: string, dep: string) => {
    if (!unit || !dep || unit === dep) return;
    let set = dependents.get(unit);
    if (!set) { set = new Set(); dependents.set(unit, set); }
    set.add(dep);
  };
  for (const n of nodes) {
    for (const cb of n.call_graph?.called_by || []) {
      if (cb.source_id) addDependent(n.id, cb.source_id);
    }
  }
  const DEPENDENCY_EDGE_TYPES = new Set([
    'CALLS', 'USES', 'DEPENDS_ON', 'RENDERS', 'IMPORTS', 'REFERENCES',
    'INSTANTIATES', 'EXTENDS', 'IMPLEMENTS', 'INJECTS',
  ]);
  for (const e of output.edges || []) {
    const type = String(e.type || '').toUpperCase();
    if (!DEPENDENCY_EDGE_TYPES.has(type)) continue;
    // source depends on target -> target has source as a dependent.
    if (byId.has(e.source) && byId.has(e.target)) addDependent(e.target, e.source);
  }

  // Transitive dependents (blast radius) via reverse BFS, bounded so a giant
  // graph never blows up. change_risks provides an authoritative count when
  // present; we prefer it and fall back to the BFS.
  const changeRiskById = new Map<string, CASChangeRisk>();
  for (const cr of output.change_risks || []) changeRiskById.set(cr.node_id, cr);

  const transitiveCache = new Map<string, number>();
  const MAX_BFS_NODES = 4000;
  function transitiveDependentCount(unit: string): number {
    const cached = transitiveCache.get(unit);
    if (cached !== undefined) return cached;
    const cr = changeRiskById.get(unit);
    if (cr) {
      const n =
        (cr.downstream_impact.transitive_callers?.length || 0) +
        (cr.downstream_impact.direct_callers?.length || 0);
      // dedupe direct vs transitive by using the larger, they overlap in some producers
      const count = Math.max(
        cr.downstream_impact.transitive_callers?.length || 0,
        (cr.downstream_impact.direct_callers?.length || 0),
        n === 0 ? 0 : n - (cr.downstream_impact.direct_callers?.length || 0),
      );
      transitiveCache.set(unit, count);
      return count;
    }
    const seen = new Set<string>([unit]);
    const queue = [unit];
    let visited = 0;
    while (queue.length && visited < MAX_BFS_NODES) {
      const cur = queue.shift()!;
      visited++;
      for (const dep of dependents.get(cur) || []) {
        if (!seen.has(dep)) { seen.add(dep); queue.push(dep); }
      }
    }
    const count = seen.size - 1; // exclude self
    transitiveCache.set(unit, count);
    return count;
  }

  // Centrality proxy: share of ALL unit nodes that can (transitively) reach this
  // node = transitive dependents / total units. Cheap, monotone, and it is
  // exactly "how much of the system leans on this".
  const totalUnits = nodes.filter(isUnitNode).length || 1;

  // ---- FLOW PARTICIPATION -------------------------------------------------
  // A node's flow participation = the number of DISTINCT execution flows it sits
  // in. Sourced from the call graph's chains (each is one entry->exit flow) and
  // user journeys (each a named end-to-end flow). A node on many flows is a
  // junction the system routes through — entrenched.
  const flowMembership = new Map<string, Set<string>>(); // node id -> flow ids it appears in
  const joinFlow = (nodeId: string | undefined, flowId: string) => {
    if (!nodeId) return;
    let set = flowMembership.get(nodeId);
    if (!set) { set = new Set(); flowMembership.set(nodeId, set); }
    set.add(flowId);
  };
  for (const chain of output.call_chains || []) {
    joinFlow(chain.entry_point?.node_id, chain.id);
    if (chain.exit_point?.node_id) joinFlow(chain.exit_point.node_id, chain.id);
    for (const step of chain.call_path || []) joinFlow(step.node_id, chain.id);
  }
  for (const j of output.user_journeys || []) {
    joinFlow(j.entry?.handler_node_id, j.id);
    for (const step of j.steps || []) joinFlow(step.node_id, j.id);
  }
  const flowCount = new Map<string, number>();
  for (const [id, set] of flowMembership) flowCount.set(id, set.size);

  // ---- ICELOT FACET: state-changes read across components (passive seams) --
  // From communication_seams passive seams + data_lineage cross-component
  // writer/reader ownership. For each entity a unit writes that a DIFFERENT
  // component reads, that's a shared-state dependency on this unit's write shape.
  const seams: CommunicationSeamsResult | undefined = output.communication_seams;
  // The set of entities that are ACTUALLY shared-state seams (a distinct writer
  // component AND reader component both touch them) — sourced straight from the
  // communication_seams passive-seam classification so entrenchment agrees with
  // the seam pass, never re-detecting. When the seams pass ran, we gate on this;
  // when it did not (older store), we fall back to the raw lineage below.
  const passiveEntities = new Set<string>();
  for (const s of seams?.seams || []) {
    if (s.modality === 'passive' && s.shared_resource) passiveEntities.add(s.shared_resource);
  }
  const gateOnSeams = Boolean(seams && seams.seams.length > 0);

  const lineage: CASEntityLineage[] = output.data_lineage || [];
  // For each unit that WRITES an entity, count distinct OTHER components reading it.
  const sharedStateReaders = new Map<string, { readers: Set<string>; entities: Set<string>; crossDeployable: Set<string> }>();
  const deployableNames = new Set(deployableRoots.map(d => d.name));
  for (const entity of lineage) {
    // Gate on the seam pass's verdict: only entities it classified as a passive
    // (shared-state) seam count as cross-component coupling. This keeps the novel
    // state-changes facet consistent with communication_seams rather than a
    // second, independently-derived shared-state notion.
    if (gateOnSeams && !passiveEntities.has(entity.entity_name)) continue;
    const readerComponents = new Set<string>();
    for (const r of entity.readers || []) {
      const c = componentForFile((r as CASEntityLineageAccessor).file, deployableRoots);
      if (c && c !== 'unknown') readerComponents.add(c);
    }
    for (const w of entity.writers || []) {
      const writerId = (w as CASEntityLineageAccessor).node_id;
      if (!writerId) continue;
      const writerComponent = componentForFile((w as CASEntityLineageAccessor).file, deployableRoots);
      // OTHER components that read what this writer writes.
      const others = new Set<string>();
      for (const rc of readerComponents) if (rc !== writerComponent) others.add(rc);
      if (others.size === 0) continue;
      let rec = sharedStateReaders.get(writerId);
      if (!rec) { rec = { readers: new Set(), entities: new Set(), crossDeployable: new Set() }; sharedStateReaders.set(writerId, rec); }
      for (const o of others) {
        rec.readers.add(o);
        if (deployableNames.has(o) && deployableNames.has(writerComponent) && o !== writerComponent) rec.crossDeployable.add(o);
      }
      rec.entities.add(entity.entity_name);
    }
  }

  // ---- ICELOT FACET: integrations (outbound calls others route through) ---
  // A unit that owns exit points is an integration seam; entrenchment on that
  // facet = how many callers reach the integration THROUGH this unit (its fan-in).
  const exitOwners = new Set<string>();
  for (const ex of output.exit_points || []) if (ex.source_node) exitOwners.add(ex.source_node);

  // ---- ICELOT FACET: constraints (guards/invariants others depend on) -----
  // A unit that guards an entry point (auth/validation) enforces a constraint
  // that its callers rely on. entry_points carry handler/guard node ids.
  const constraintOwners = new Map<string, number>();
  for (const ep of output.entry_points || []) {
    // An entry point whose handler enforces auth/guards is a unit its callers
    // rely on to uphold that constraint — count the guards it carries as the
    // strength of the constraint others depend on. The handler node is the
    // constraint owner (source_node falls back to it).
    const guardCount =
      (ep.security?.guards?.length || 0) + (ep.security?.authenticated ? 1 : 0);
    if (guardCount === 0) continue;
    const ownerId = ep.handler?.node_id || ep.source_node;
    if (!ownerId) continue;
    constraintOwners.set(ownerId, (constraintOwners.get(ownerId) || 0) + guardCount);
  }

  // ---- CROSS-BOUNDARY: contracts consumed across repos ---------------------
  const crossRepoNodes = new Set<string>();
  for (const link of [...(output.repository_links || []), ...(output.cross_repository_links || [])]) {
    for (const nid of link.source_repository?.node_ids || []) crossRepoNodes.add(String(nid));
    for (const nid of link.target_repository?.node_ids || []) crossRepoNodes.add(String(nid));
  }

  // ---- RUNTIME: per-node request volume ------------------------------------
  const runtimeByNode = new Map<string, number>();
  for (const m of output.runtimeMetrics || []) {
    const id = m.node_id || m.static_id;
    if (id && typeof m.request_count === 'number') {
      runtimeByNode.set(id, Math.max(runtimeByNode.get(id) || 0, m.request_count));
    }
  }

  // ---- CENTRALITY as a scale-free PERCENTILE -------------------------------
  // Raw "transitive dependents / total units" collapses to ~0 on a big repo, so
  // a genuinely central unit reads the same as a leaf. Instead, centrality is
  // the node's PERCENTILE rank of blast radius across all units: "this unit is
  // in the top X% of the codebase by reach" — scale-free and monotone, so the
  // most-depended-on units score near 1 regardless of repo size.
  const unitNodes = nodes.filter(isUnitNode);
  const blastValues: number[] = unitNodes.map(n => transitiveDependentCount(n.id));
  const sortedBlast = [...blastValues].sort((a, b) => a - b);
  const percentileOf = (value: number): number => {
    if (sortedBlast.length === 0 || value <= 0) return 0;
    // fraction of units with a STRICTLY smaller blast radius (rank percentile).
    let lo = 0, hi = sortedBlast.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sortedBlast[mid] < value) lo = mid + 1; else hi = mid;
    }
    return lo / sortedBlast.length;
  };

  // ---- COMBINE per node ----------------------------------------------------
  const nodeResults: Record<string, NodeEntrenchment> = {};
  for (const node of nodes) {
    if (!isUnitNode(node)) continue;
    const id = node.id;

    const directDeps = dependents.get(id)?.size ?? (node.call_graph?.called_by?.length || 0);
    const transitiveDeps = transitiveDependentCount(id);
    const flows = flowCount.get(id) || 0;
    const shared = sharedStateReaders.get(id);
    const sharedReaderCount = shared?.readers.size || 0;
    const sharedEntities = shared ? Array.from(shared.entities) : [];
    const crossDeployableReaders = shared?.crossDeployable.size || 0;
    const isCrossRepo = crossRepoNodes.has(id);
    const reqCount = runtimeByNode.get(id);

    // --- component signals (each 0..1) ---
    // Saturation constants are calibrated so the FIRST few dependents move the
    // needle and genuinely system-wide units (dozens of direct dependents, big
    // blast radius, many flows) approach 1 — the load-bearing walls should be
    // able to reach the top tiers on structure alone.
    const fanInSig = saturate(directDeps, 4);
    const blastSig = saturate(transitiveDeps, 12);
    const centralitySig = percentileOf(transitiveDeps);
    const flowSig = saturate(flows, 3);

    // ICELOT facet weights — how widely each contract facet is depended upon.
    const outputSig = saturate(directDeps, 6); // output consumed by callers
    const stateSig = saturate(sharedReaderCount, 2); // shared-state readers (the novel one)
    const constraintSig = saturate(constraintOwners.get(id) || 0, 2);
    const integrationSig = exitOwners.has(id) ? saturate(directDeps + 1, 6) : 0;
    const logicSig = saturate(directDeps, 8);
    const facets: FacetEntrenchment = {
      output: round(outputSig),
      state_changes: round(stateSig),
      constraints: round(constraintSig),
      integrations: round(integrationSig),
      logic: round(logicSig),
    };

    const crossBoundarySig = Math.max(
      isCrossRepo ? 0.9 : 0,
      crossDeployableReaders > 0 ? saturate(crossDeployableReaders, 1) : 0,
    );
    const runtimeSig = reqCount ? saturate(reqCount, 500) : 0;

    // Weighted blend. Structural fan-in/blast/centrality dominate (that IS
    // entrenchment — how much of the system leans on this), the shared-state
    // facet is up-weighted because it is the coupling nobody else measures, and
    // cross-boundary + runtime add load-bearing evidence. Weights sum to 1.
    const score = clamp01(
      fanInSig * 0.27 +
      blastSig * 0.24 +
      centralitySig * 0.13 +
      flowSig * 0.11 +
      stateSig * 0.11 +          // shared-state coupling (novel, up-weighted)
      constraintSig * 0.02 +
      integrationSig * 0.02 +
      crossBoundarySig * 0.06 +
      runtimeSig * 0.04,
    );

    // Evidence — only lines with real facts behind them.
    const evidence: string[] = [];
    if (directDeps > 0) evidence.push(`${formatCount(directDeps)} dependent${directDeps === 1 ? '' : 's'}`);
    if (transitiveDeps > directDeps) evidence.push(`${formatCount(transitiveDeps)} in blast radius`);
    if (sharedReaderCount > 0) {
      const ent = sharedEntities.slice(0, 2).join(', ');
      evidence.push(`writes ${ent}${sharedEntities.length > 2 ? '…' : ''} read by ${sharedReaderCount} module${sharedReaderCount === 1 ? '' : 's'}`);
    }
    if (flows > 0) evidence.push(`in ${flows} flow${flows === 1 ? '' : 's'}`);
    if (exitOwners.has(id)) evidence.push('integration seam');
    if ((constraintOwners.get(id) || 0) > 0) evidence.push('enforces a guard/constraint');
    if (isCrossRepo) evidence.push('contract consumed cross-repo');
    if (crossDeployableReaders > 0) evidence.push(`shared state across ${crossDeployableReaders} deployable${crossDeployableReaders === 1 ? '' : 's'}`);
    if (reqCount) evidence.push(`${formatCount(reqCount)} req observed`);
    if (evidence.length === 0) evidence.push('no dependents — leaf');

    const level = scoreToLevel(score, {
      isCrossRepo,
      transitiveDeps,
      sharedReaderCount,
      totalUnits,
    });

    nodeResults[id] = {
      node_id: id,
      score: round(score),
      level,
      signals: {
        fan_in: round(fanInSig),
        blast_radius: round(blastSig),
        centrality: round(centralitySig),
        flow_participation: round(flowSig),
        facets,
        cross_boundary: round(crossBoundarySig),
        runtime: round(runtimeSig),
      },
      raw: {
        direct_dependents: directDeps,
        transitive_dependents: transitiveDeps,
        flows,
        shared_state_readers: sharedReaderCount,
        shared_state_entities: sharedEntities,
        cross_repo: isCrossRepo,
        cross_deployable_readers: crossDeployableReaders,
        ...(reqCount !== undefined ? { request_count: reqCount } : {}),
      },
      evidence,
    };
  }

  const summary = buildSummary(nodeResults, byId, nodeFile);
  return { nodes: nodeResults, summary };
}

/** Map a 0..1 score + a few hard gates to a tier. The gates ensure the label
 *  never OVER-states: bedrock requires either cross-repo consumption or genuinely
 *  system-wide centrality, so a merely-popular local helper stays load-bearing. */
function scoreToLevel(
  score: number,
  ctx: { isCrossRepo: boolean; transitiveDeps: number; sharedReaderCount: number; totalUnits: number },
): EntrenchmentLevel {
  // "System-wide" = a blast radius large in absolute terms (hundreds of units
  // transitively depend on it) OR a meaningful fraction of a small repo. This is
  // the gate that separates a merely-popular local helper (foundational) from a
  // true bedrock unit the whole system leans on.
  const systemWide = ctx.transitiveDeps >= Math.min(150, Math.max(20, ctx.totalUnits * 0.02));
  if (score >= 0.75 && (ctx.isCrossRepo || systemWide)) return 'bedrock';
  if (score >= 0.6) return 'foundational';
  if (score >= 0.4) return 'load-bearing';
  if (score >= 0.2) return 'connected';
  if (score > 0.05) return 'peripheral';
  return 'leaf';
}

function buildSummary(
  nodeResults: Record<string, NodeEntrenchment>,
  byId: Map<string, CASNode>,
  nodeFile: Map<string, string>,
): EntrenchmentSummary {
  const all = Object.values(nodeResults);
  const distribution = emptyDistribution();
  for (const n of all) distribution[n.level]++;

  // Repo score = mean of node scores weighted toward the top (the bedrock set is
  // what defines whether a repo is "highly entrenched"), computed as a blend of
  // the average and the 90th-percentile score.
  const scores = all.map(n => n.score).sort((a, b) => a - b);
  const avg = scores.length ? scores.reduce((s, v) => s + v, 0) / scores.length : 0;
  const p90 = scores.length ? scores[Math.floor(scores.length * 0.9)] : 0;
  const repoScore = round(avg * 0.5 + p90 * 0.5);
  const repoLevel = scoreToLevel(repoScore, { isCrossRepo: false, transitiveDeps: 0, sharedReaderCount: 0, totalUnits: 1 });

  // Bedrock set: load-bearing and above, ranked by score desc.
  const bedrock = all
    .filter(n => LEVEL_ORDER.indexOf(n.level) >= LEVEL_ORDER.indexOf('load-bearing'))
    .sort((a, b) => b.score - a.score)
    .slice(0, 25)
    .map(n => {
      const node = byId.get(n.node_id);
      return {
        node_id: n.node_id,
        name: node?.name || n.node_id,
        file: node?.source?.file,
        score: n.score,
        level: n.level,
        evidence: n.evidence,
      };
    });

  // File rollup: file = f(its nodes) = max-with-density blend.
  const byFile = new Map<string, NodeEntrenchment[]>();
  for (const n of all) {
    const f = nodeFile.get(n.node_id);
    if (!f) continue;
    (byFile.get(f) || byFile.set(f, []).get(f)!).push(n);
  }
  const files: FileEntrenchment[] = Array.from(byFile.entries()).map(([file, ns]) => {
    const top = ns.reduce((a, b) => (b.score > a.score ? b : a));
    const avgF = ns.reduce((s, v) => s + v.score, 0) / ns.length;
    // File entrenchment = its most-entrenched node, lifted a little by density of
    // other entrenched nodes (a file full of load-bearing units is itself bedrock).
    const fscore = round(Math.min(1, top.score * 0.7 + avgF * 0.3 + Math.min(0.1, (ns.filter(x => x.score >= 0.4).length - 1) * 0.02)));
    return {
      file,
      score: fscore,
      level: scoreToLevel(fscore, { isCrossRepo: false, transitiveDeps: 0, sharedReaderCount: 0, totalUnits: 1 }),
      node_count: ns.length,
      bedrock_nodes: ns.filter(x => LEVEL_ORDER.indexOf(x.level) >= LEVEL_ORDER.indexOf('load-bearing')).length,
      top_node: top.node_id,
    };
  }).sort((a, b) => b.score - a.score);

  // Module rollup: module = f(its files).
  const byModule = new Map<string, FileEntrenchment[]>();
  for (const f of files) {
    const m = moduleForFile(f.file);
    (byModule.get(m) || byModule.set(m, []).get(m)!).push(f);
  }
  const modules: ModuleEntrenchment[] = Array.from(byModule.entries()).map(([module, fs]) => {
    const top = fs.reduce((a, b) => (b.score > a.score ? b : a));
    const avgM = fs.reduce((s, v) => s + v.score, 0) / fs.length;
    const mscore = round(Math.min(1, top.score * 0.6 + avgM * 0.4));
    return {
      module,
      score: mscore,
      level: scoreToLevel(mscore, { isCrossRepo: false, transitiveDeps: 0, sharedReaderCount: 0, totalUnits: 1 }),
      file_count: fs.length,
    };
  }).sort((a, b) => b.score - a.score);

  return {
    contract_model: ENTRENCHMENT_CONTRACT_MODEL,
    distribution,
    repo_score: repoScore,
    repo_level: repoLevel,
    bedrock,
    files: files.slice(0, 100),
    modules: modules.slice(0, 50),
    counts: { nodes_scored: all.length, files: byFile.size, modules: byModule.size },
  };
}

function emptyDistribution(): Record<EntrenchmentLevel, number> {
  return { leaf: 0, peripheral: 0, connected: 0, 'load-bearing': 0, foundational: 0, bedrock: 0 };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
