/**
 * CONTEXT-FABRIC — compact, high-signal pointers that weave the newer fact
 * layers (communication seams, runtime infra topology, consistency/CAP posture,
 * bundled ship-units) into the PRIMARY orient/context tools an agent calls first
 * (get_system_overview, get_summary, get_agent_context).
 *
 * Everything here is a PURE READ of already-computed CAS fields:
 *   - cas.communication_seams  (buildCommunicationSeams inventory)
 *   - cas.consistency_model    (CAP / staleness posture)
 *   - cas.product_map.runtime_topology (buildRuntimeTopology infra->code join)
 *   - cas.deployable_evidence  (ship-units, bundled members via ships_paths)
 *   - cas.entry_points
 * NOTHING is recomputed. Every builder is additive and returns `undefined` /
 * empty when the underlying facts are absent, so non-applicable repos are
 * unchanged. Node-level runtime hotspots (which need telemetry observations,
 * an async load) are handled separately in agent-adoption via
 * buildNodeRuntimeMetrics; this module stays synchronous and CAS-only.
 */

import type {
  CASOutput,
  CASProductMapDeployableTopology,
} from '../../../packages/analyzer-core/src/types/cas.types';
import { partitionTasks, type PartitionCas, type PartitionTask } from './coordination/partitioner';
import type { WorkClaim } from './coordination/types';
import type { CrossCodebaseSystemGraph } from './cross-codebase-analysis';

// ---------------------------------------------------------------------------
// Communication seams — one-line modality summary + a couple of top edges
// ---------------------------------------------------------------------------

export interface CommunicationSeamSummary {
  /** N sync / N async / N passive / total. */
  counts: { sync: number; async: number; passive: number; total: number };
  /** Compact "N sync / N async / N passive" line. */
  headline: string;
  /** Level the counts describe: deployable rollup when present, else node. */
  level: 'node' | 'deployable' | 'workspace';
  /** A few busiest component-to-component edges (dominant modality + counts). */
  top_edges: Array<{
    source: string;
    target: string;
    modalities: string[];
    total: number;
  }>;
  detail_tool: 'get_communication_seams' | 'get_product_map';
}

/**
 * Compact seam summary from the already-computed communication_seams inventory.
 * Prefers the deployable-level rollup (component-to-component reads better for
 * orientation) and falls back to the node-level inventory. Returns undefined
 * when no seams were classified.
 */
export function buildCommunicationSeamSummary(
  cas: CASOutput,
  opts: { maxEdges?: number } = {},
): CommunicationSeamSummary | undefined {
  const seams = cas.communication_seams;
  if (!seams) return undefined;
  const inventory = seams.deployable_inventory && seams.deployable_inventory.counts.total > 0
    ? seams.deployable_inventory
    : seams.inventory;
  if (!inventory || inventory.counts.total === 0) return undefined;

  const maxEdges = opts.maxEdges ?? 3;
  const topEdges = [...(inventory.component_seams || [])]
    .sort((a, b) => b.total - a.total)
    .slice(0, maxEdges)
    .map(edge => ({
      source: edge.source,
      target: edge.target,
      modalities: edge.modalities,
      total: edge.total,
    }));

  const { sync, async, passive, total } = inventory.counts;
  return {
    counts: { sync, async, passive, total },
    headline: `${sync} sync / ${async} async / ${passive} passive`,
    level: inventory.level,
    top_edges: topEdges,
    detail_tool: 'get_communication_seams',
  };
}

// ---------------------------------------------------------------------------
// Consistency / CAP — eventual-consistency & staleness risk flags
// ---------------------------------------------------------------------------

export interface ConsistencyFlags {
  /** True when at least one store/seam carries eventual consistency + staleness. */
  eventual_consistency_present: boolean;
  counts: {
    strong_stores: number;
    eventual_stores: number;
    tunable_stores: number;
    passive_replica: number;
    passive_streaming: number;
  };
  /** Compact human-readable risk flags (only staleness-bearing postures). */
  flags: string[];
  detail_tool: 'get_product_map';
}

/**
 * Read the consistency_model result and surface only the staleness-bearing
 * signal (eventual stores, replica reads, streaming). Strong primary reads are
 * deliberately NOT flagged (matching the analyzer's "NOT flagged stale" rule).
 * Returns undefined when the analysis carries no eventual/streaming posture.
 */
export function buildConsistencyFlags(cas: CASOutput): ConsistencyFlags | undefined {
  const model = cas.consistency_model;
  if (!model) return undefined;
  const c = model.counts;
  const eventualPresent =
    c.eventual_stores > 0 || c.tunable_stores > 0 ||
    c.passive_replica > 0 || c.passive_streaming > 0;
  if (!eventualPresent) return undefined;

  const flags: string[] = [];
  if (c.eventual_stores > 0) flags.push(`${c.eventual_stores} eventual store(s) (staleness risk on reads)`);
  if (c.tunable_stores > 0) flags.push(`${c.tunable_stores} tunable store(s) (default consistency may read stale)`);
  if (c.passive_replica > 0) flags.push(`${c.passive_replica} read-replica seam(s) (replica lag)`);
  if (c.passive_streaming > 0) flags.push(`${c.passive_streaming} streaming/CDC seam(s) (async data propagation)`);

  return {
    eventual_consistency_present: true,
    counts: {
      strong_stores: c.strong_stores,
      eventual_stores: c.eventual_stores,
      tunable_stores: c.tunable_stores,
      passive_replica: c.passive_replica,
      passive_streaming: c.passive_streaming,
    },
    flags,
    detail_tool: 'get_product_map',
  };
}

// ---------------------------------------------------------------------------
// Bundled deployables — ship-units with their bundled members
// ---------------------------------------------------------------------------

export interface BundledDeployable {
  name: string;
  kind: string;
  /** Members bundled into this ship unit (e.g. client bundles client-service). */
  bundles: string[];
  /** The primary/ENTRYPOINT member of a multi-member bundle, when known. */
  entrypoint_member?: string;
  ports?: number[];
}

/**
 * Ship units from deployable_evidence, collapsing bundled multi-member units so
 * `client` that packages `client-service` reads as ONE deployable with its
 * members listed (Tier-1 ships_paths). Non-bundled units are included with an
 * empty `bundles` array only when they carry a clear ship kind; the caller can
 * cap. Returns undefined when no deployable evidence exists.
 */
/**
 * ships_paths carries raw evidence tokens; for a docker unit that includes
 * base-image lines (`node:22-alpine`), and for an installer/CI-deploy unit it
 * can include free-text arg tokens. Keep only tokens that read like real bundle
 * MEMBERS (service/bin/crate names) so the "client bundles client-service" signal
 * stays high. Conservative: when nothing survives, the unit shows as un-bundled.
 */
function isPlausibleMember(token: string): boolean {
  const t = token.trim();
  if (t.length < 3) return false;
  // Base images / tagged image refs: `node:22-alpine`, `alpine:3.19`, `library/x`.
  if (/[a-z0-9._-]+:[a-z0-9._-]+/i.test(t)) return false;
  if (/\b(alpine|debian|ubuntu|distroless|scratch|buster|bookworm|slim)\b/i.test(t)) return false;
  if (/^(dumb-init|tini|bash|sh|node|npm|yarn|pnpm|git|curl|wget)$/i.test(t)) return false;
  // Trailing punctuation / prose fragments ("below.", "bastion.") are arg noise.
  if (/[.,;:]$/.test(t)) return false;
  // A component-name suffix is the strongest signal of a real bundle member.
  if (/-(api|service|worker|web|app|server|client|gateway|fn|lambda|job)\b/i.test(t)) return true;
  // A path-shaped token (has a slash, not a bare config-key dot) is a member.
  if (t.includes('/')) return true;
  // Otherwise (bare word, or dotted config key like http.postBuffer) => drop.
  return false;
}

function cleanShipMembers(shipsPaths: string[] | undefined): string[] {
  if (!shipsPaths?.length) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of shipsPaths) {
    if (!isPlausibleMember(p)) continue;
    const key = p.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out.slice(0, 6);
}

export function buildBundledDeployables(
  cas: CASOutput,
  opts: { limit?: number; onlyBundled?: boolean } = {},
): BundledDeployable[] | undefined {
  const evidence = cas.deployable_evidence;
  if (!evidence || evidence.length === 0) return undefined;

  const limit = opts.limit ?? 8;
  const units: BundledDeployable[] = evidence
    .filter(e => (opts.onlyBundled ? (e.ships_paths?.length ?? 0) > 0 : true))
    .map(e => {
      const bundles = cleanShipMembers(e.ships_paths);
      return {
        name: e.name,
        kind: e.kind,
        bundles,
        ...(e.entrypoint_member && isPlausibleMember(e.entrypoint_member) ? { entrypoint_member: e.entrypoint_member } : {}),
        ...(e.ports && e.ports.length ? { ports: e.ports } : {}),
      };
    });

  // Prefer ship-declarations (tier 1) and bundles first for orientation value.
  units.sort((a, b) => (b.bundles.length - a.bundles.length));
  const trimmed = units.slice(0, limit);
  return trimmed.length ? trimmed : undefined;
}

// ---------------------------------------------------------------------------
// Runtime topology — compact per-deployable infra->code summary
// ---------------------------------------------------------------------------

export interface RuntimeTopologySummary {
  edge_count: number;
  deployables: Array<{
    name: string;
    exposes?: string[];
    routes_count?: number;
    databases?: string[];
    channels?: string[];
    depends_on?: string[];
  }>;
  detail_tool: 'get_product_map';
}

function compactTopoDeployable(d: CASProductMapDeployableTopology) {
  const out: RuntimeTopologySummary['deployables'][number] = { name: d.name };
  if (d.exposes?.length) out.exposes = d.exposes.slice(0, 4);
  if (d.routes?.length) out.routes_count = d.routes.length;
  if (d.databases?.length) out.databases = d.databases.slice(0, 4);
  if (d.channels?.length) out.channels = d.channels.slice(0, 4);
  if (d.depends_on?.length) out.depends_on = d.depends_on.slice(0, 6);
  return out;
}

/**
 * Compact view of product_map.runtime_topology (the infra->code join). Present
 * only when the analysis carries infra topology edges. Returns undefined for
 * repos with no infra-as-code.
 */
export function buildRuntimeTopologySummary(
  cas: CASOutput,
  opts: { limit?: number } = {},
): RuntimeTopologySummary | undefined {
  const topo = cas.product_map?.runtime_topology;
  if (!topo || !topo.deployables?.length) return undefined;
  const limit = opts.limit ?? 6;
  return {
    edge_count: topo.edge_count,
    deployables: topo.deployables.slice(0, limit).map(compactTopoDeployable),
    detail_tool: 'get_product_map',
  };
}

// ---------------------------------------------------------------------------
// System fit — the vertical "how it fits" pointer for get_system_overview
// ---------------------------------------------------------------------------

export interface SystemFitSummary {
  /** One-line "how it fits" tying the vertical together. */
  headline: string;
  entry_points: { total: number; by_type: Record<string, number> };
  /** Ship units, bundled members collapsed. */
  deployables?: BundledDeployable[];
  /** Infra->code topology, compacted. */
  topology?: RuntimeTopologySummary;
  /** N sync / N async / N passive. */
  communication_seams?: CommunicationSeamSummary;
  /** Eventual-consistency / CAP staleness flags, when present. */
  consistency?: ConsistencyFlags;
  detail_tools: string[];
}

/**
 * The compact "how it fits" section for get_system_overview: entry points ->
 * deployables (bundled members collapsed) -> infra topology -> communication
 * seam counts + CAP flags. Every sub-section is omitted when its facts are
 * absent; returns undefined only when NONE of the layers are present, so a
 * plain repo with no seams/topology/deployables is unchanged.
 *
 * Role split (see also buildOrientCapsule in query.ts): this is the NARRATIVE —
 * a woven headline plus the compacted content of each layer, so a caller can
 * read how the vertical actually connects. get_summary's orient_capsule is the
 * complementary INDEX — availability + count + the pulling tool per dimension,
 * no narrative and no per-layer content. They are deliberately non-redundant:
 * the capsule tells you WHAT is pullable at near-zero tokens; system_fit tells
 * you the STORY. Keep them that way — do not fold the capsule's per-dimension
 * counts into system_fit prose, and do not add narrative to the capsule.
 */
export function buildSystemFitSummary(cas: CASOutput): SystemFitSummary | undefined {
  const deployables = buildBundledDeployables(cas, { limit: 6 });
  const topology = buildRuntimeTopologySummary(cas);
  const seams = buildCommunicationSeamSummary(cas);
  const consistency = buildConsistencyFlags(cas);

  // Nothing new to surface — leave the overview untouched.
  if (!deployables && !topology && !seams && !consistency) return undefined;

  const entryTotal = cas.entry_points?.length || 0;
  const byType: Record<string, number> = {};
  for (const ep of cas.entry_points || []) byType[ep.type] = (byType[ep.type] || 0) + 1;

  // Build the one-liner from whatever layers exist.
  const parts: string[] = [`${entryTotal} entry point(s)`];
  if (deployables) {
    const bundled = deployables.find(d => d.bundles.length > 0);
    parts.push(bundled
      ? `${deployables.length} deployable(s) (e.g. ${bundled.name} bundles ${bundled.bundles.join(', ')})`
      : `${deployables.length} deployable(s)`);
  }
  if (topology) parts.push(`${topology.deployables.length} in infra topology`);
  if (seams) parts.push(`seams ${seams.headline}`);
  if (consistency) parts.push('eventual-consistency risk present');

  const detailTools = new Set<string>();
  if (seams) detailTools.add('get_communication_seams');
  if (topology || consistency || deployables) detailTools.add('get_product_map');

  return {
    headline: parts.join(' -> '),
    entry_points: { total: entryTotal, by_type: byType },
    ...(deployables ? { deployables } : {}),
    ...(topology ? { topology } : {}),
    ...(seams ? { communication_seams: seams } : {}),
    ...(consistency ? { consistency } : {}),
    detail_tools: [...detailTools],
  };
}

// ---------------------------------------------------------------------------
// CAS-backed advisory overlap — blast-radius + symbol/contract aware
// ---------------------------------------------------------------------------
//
// The advisory fabric surface (fab_claim_work / fab_check_collision) detects
// overlap today with `checkEditLock` (coordination/local-store.ts) — a PURE
// STRING/PATH-PREFIX scan: it compares only the raw `scope.paths` of the
// proposed claim against every active claim's raw `scope.paths`, ignoring
// `scope.symbols` entirely and never consulting the analysis. That misses the
// whole differentiation of Klauro's fabric: two agents editing functions in
// the same CALL CHAIN collide even in DIFFERENT files (call-graph blast
// radius), and two agents changing the same SYMBOL/contract collide
// semantically even when their file paths are disjoint.
//
// The enforced surface (claim_work / check_collision) already sees this via
// coordination/collision.ts's Detector 4 (detectBlastIntersections) and the
// planner (plan_parallel_work) already sees it via coordination/partitioner.ts
// (`partitionTasks` with `includeBlastRadius`, expanding each footprint one hop
// over CAS "calls" edges). The advisory path was the odd one out.
//
// `computeAdvisoryOverlap` closes that gap by REUSING the partitioner — the
// exact same blast-radius machinery plan_parallel_work runs — instead of
// reinventing a call-graph walk here. Each active claim + the proposed claim
// become PartitionTasks; `partitionTasks(..., { includeBlastRadius })` computes
// their symbol/path footprints, expands them by one CAS hop, and reports every
// conflict edge with its reason ('symbol' | 'path' | 'blast-radius'). We keep
// only the edges touching the proposed claim and hand them back as awareness.
//
// STRICTLY ADVISORY: this is a pure function that RETURNS findings — it never
// blocks, queues, gates, or throws. Callers use it exactly like `checkEditLock`
// (surface the findings, proceed regardless).
//
// CROSS-REPO (WAS) LAYER (§4.2/§4.3/§7 SPEC-COORDINATION-FABRIC-V2): CAS
// blast-radius is single-repo. But a fleet works a WORKSPACE: agent A edits a
// shared type/lib in one repo, agent B edits its consumer in ANOTHER repo —
// only the workspace analysis (WAS) sees that cross-deployable link and the
// frozen cross-repo contract surface. CAS-only collision detection is blind to
// exactly the fleet-scale collisions that matter most. When a WAS graph is
// available for the claim's workspace, `computeAdvisoryOverlap` also folds in
// two cross-repo signals, REUSING the WAS machinery (never reinventing it):
//   (a) SHARED-CODE ROLLUP (`was.shared_code_rollup`): a claim touching a
//       shared-library symbol (its `consumed_surface` / per-symbol
//       `blast_radius`) overlaps any other claim touching a CONSUMER deployable
//       of that symbol — the cross-repo shared-code blast radius the WAS builds.
//   (b) FROZEN/SHARED CROSS-REPO CONTRACTS (`was.interfaces` + `was.links`): a
//       claim touching one side of a cross-repo interface link (provided
//       route/message/db surface) overlaps another claim touching the linked
//       counterpart — the contract surface two repos share.
//
// GRACEFULLY DEGRADING (WAS -> CAS -> string, never throw): when no WAS graph
// is passed, the cross-repo layer is simply skipped and the result is the
// CAS-backed set below. When no CAS is available either (`cas` undefined / an
// empty nodes+edges set — the common case for a logical workspace id with no
// analyzable project), `partitionTasks` naturally falls back to raw symbol/path
// overlap (no edges to expand), so this reduces to a SUPERSET of `checkEditLock`
// (adds symbol overlap; never loses the path overlap it had). Every layer is
// wrapped so a failure degrades to fewer findings, never an exception. Safe to
// call unconditionally.

/** One advisory overlap finding against the proposed claim. Superset of
 *  local-store's path-only `EditLockConflict`: it adds the overlapping SYMBOLS,
 *  the overlap REASON, and (for cross-repo overlap) the shared workspace
 *  surface, so callers can distinguish a literal path/symbol clash from a
 *  call-graph blast-radius reach or a cross-repo (WAS) dependency. */
export interface AdvisoryOverlapFinding {
  /** The already-active claim whose footprint overlaps the proposed one. */
  agent_id: string;
  claim_id: string;
  intent: string;
  /** Overlapping raw paths (path-prefix intersection), for parity with the
   *  legacy string scan. Empty when the overlap is symbol/blast-radius only. */
  overlapping_paths: string[];
  /** Overlapping symbols/node-ids. Empty when the overlap is path-only. */
  overlapping_symbols: string[];
  /** Why they overlap:
   *  - 'path'          : raw file-path prefix overlap (what the old scan caught).
   *  - 'symbol'        : the two claims literally name the same symbol/entity.
   *  - 'blast-radius'  : literal footprints are disjoint, but one claim edits a
   *                      CAS caller/callee of the other — the same-repo moat
   *                      signal a file/path-only scan cannot see.
   *  - 'cross-repo-shared-code' : both claims touch a shared library symbol
   *                      (one the lib, the other a cross-repo consumer of it),
   *                      via the WAS shared_code_rollup blast radius.
   *  - 'cross-repo-contract'    : both claims touch two ends of a frozen/shared
   *                      cross-repo interface link (WAS interfaces + links). */
  reason: 'path' | 'symbol' | 'blast-radius' | 'cross-repo-shared-code' | 'cross-repo-contract';
  /** True when the finding came from the CAS (reason 'blast-radius' or 'symbol')
   *  — visible only because the single-repo analysis was consulted. */
  cas_derived: boolean;
  /** True when the finding came from the WAS (a 'cross-repo-*' reason) — visible
   *  only because the WORKSPACE analysis was consulted (cross-repo blindness a
   *  single-repo CAS cannot see). */
  was_derived: boolean;
  /** For cross-repo findings: the shared workspace surface both claims touch —
   *  the shared library name/symbols, or the cross-repo contract id — so the
   *  awareness names WHAT is shared, not just that something is. */
  shared_surface?: string[];
}

/** The proposed (not-yet-appended) advisory claim footprint to check. */
export interface AdvisoryClaimProposal {
  agent_id: string;
  paths?: string[];
  symbols?: string[];
}

export interface AdvisoryOverlapOptions {
  /** Expand footprints by one hop of CAS call-graph edges before intersecting.
   *  Default true — this is the point of the helper. Set false to reduce to a
   *  literal path/symbol overlap check (still a superset of the old path-only
   *  scan). */
  includeBlastRadius?: boolean;
  /** Cap on findings returned (highest-signal first: cross-repo, then symbol,
   *  then blast-radius, then path). Default 25 — advisory awareness, not a full
   *  report. */
  limit?: number;
}

const REASON_RANK: Record<AdvisoryOverlapFinding['reason'], number> = {
  'cross-repo-contract': 0,
  'cross-repo-shared-code': 1,
  symbol: 2,
  'blast-radius': 3,
  path: 4,
};

/**
 * CAS+WAS-backed advisory overlap between a proposed claim and the active
 * claims. Same-repo overlap reuses `partitionTasks`' blast-radius machinery;
 * cross-repo overlap reuses the WAS `shared_code_rollup` + `interfaces`/`links`
 * (see the section header).
 *
 * Pure and non-blocking: returns findings, never throws — any internal failure
 * degrades to fewer findings (awareness is best-effort, never a gate).
 * Degrades WAS -> CAS -> string:
 *  - Pass a real `PartitionCas` (server.ts builds one via `partitionCasForPath`)
 *    for same-repo blast-radius/symbol awareness; `undefined`/empty CAS degrades
 *    to literal symbol/path overlap.
 *  - Pass a WAS graph (server.ts resolves one via `resolveWorkspaceAnalysisForPaths`)
 *    for cross-repo shared-code + contract awareness; omit it to skip that layer.
 */
export function computeAdvisoryOverlap(
  proposal: AdvisoryClaimProposal,
  activeClaims: WorkClaim[],
  cas: PartitionCas | undefined,
  opts: AdvisoryOverlapOptions = {},
  was?: CrossCodebaseSystemGraph | undefined,
): AdvisoryOverlapFinding[] {
  const others = activeClaims.filter(
    (c) => c.status === 'active' && c.agent_id !== proposal.agent_id,
  );
  if (others.length === 0) return [];

  const byClaimId = new Map<string, WorkClaim>();
  for (const claim of others) {
    if (!byClaimId.has(claim.claim_id)) byClaimId.set(claim.claim_id, claim);
  }

  // Each layer is independently guarded: a failure in one degrades to fewer
  // findings, never an exception and never a lost other layer.
  const findingsByClaim = new Map<string, AdvisoryOverlapFinding>();
  const record = (f: AdvisoryOverlapFinding) => {
    // One finding per conflicting claim — keep the highest-signal reason
    // (lowest REASON_RANK) when a claim overlaps on multiple layers, and merge
    // the surfaces so the awareness stays complete.
    const existing = findingsByClaim.get(f.claim_id);
    if (!existing) {
      findingsByClaim.set(f.claim_id, f);
      return;
    }
    const merged: AdvisoryOverlapFinding =
      REASON_RANK[f.reason] < REASON_RANK[existing.reason] ? { ...f } : { ...existing };
    merged.overlapping_paths = [...new Set([...existing.overlapping_paths, ...f.overlapping_paths])];
    merged.overlapping_symbols = [...new Set([...existing.overlapping_symbols, ...f.overlapping_symbols])];
    merged.cas_derived = existing.cas_derived || f.cas_derived;
    merged.was_derived = existing.was_derived || f.was_derived;
    const surface = [...(existing.shared_surface ?? []), ...(f.shared_surface ?? [])];
    if (surface.length) merged.shared_surface = [...new Set(surface)];
    findingsByClaim.set(f.claim_id, merged);
  };

  // ---- Same-repo layer: CAS blast-radius via partitionTasks ----
  try {
    const PROPOSAL_ID = '__advisory_proposal__';
    const tasks: PartitionTask[] = [
      {
        id: PROPOSAL_ID,
        intent: 'advisory overlap probe',
        target_symbols: proposal.symbols ?? [],
        target_paths: proposal.paths ?? [],
      },
    ];
    for (const claim of byClaimId.values()) {
      tasks.push({
        id: claim.claim_id,
        intent: claim.intent,
        target_symbols: claim.scope.symbols ?? [],
        target_paths: claim.scope.paths ?? [],
      });
    }

    // Empty/undefined CAS -> partitionTasks has no edges to expand and reduces
    // to literal symbol/path overlap. Feeding {nodes:[],edges:[]} is the same
    // graceful-degradation path server.ts's partitionCasForPath already yields.
    const partitionCas: PartitionCas = cas ?? { nodes: [], edges: [] };
    const includeBlastRadius = opts.includeBlastRadius ?? true;
    const result = partitionTasks(tasks, partitionCas, { includeBlastRadius });

    for (const edge of result.conflict_edges) {
      const otherId = edge.a === PROPOSAL_ID ? edge.b : edge.b === PROPOSAL_ID ? edge.a : undefined;
      if (!otherId) continue;
      const claim = byClaimId.get(otherId);
      if (!claim) continue;
      record({
        agent_id: claim.agent_id,
        claim_id: claim.claim_id,
        intent: claim.intent,
        overlapping_paths: intersectPaths(proposal.paths ?? [], claim.scope.paths ?? []),
        overlapping_symbols: intersectExact(proposal.symbols ?? [], claim.scope.symbols ?? []),
        reason: edge.reason,
        cas_derived: edge.reason === 'blast-radius' || edge.reason === 'symbol',
        was_derived: false,
      });
    }
  } catch {
    // Same-repo layer failed — cross-repo layer below still runs.
  }

  // ---- Cross-repo layer: WAS shared-code rollup + contract links ----
  if (was) {
    try {
      for (const f of computeCrossRepoOverlap(proposal, [...byClaimId.values()], was)) {
        record(f);
      }
    } catch {
      // Cross-repo layer failed — same-repo findings above are preserved.
    }
  }

  const findings = [...findingsByClaim.values()];
  findings.sort((a, b) => REASON_RANK[a.reason] - REASON_RANK[b.reason]);
  const limit = opts.limit ?? 25;
  return findings.slice(0, limit);
}

/**
 * Cross-repo (WAS) overlap: does the proposed claim share a WORKSPACE surface
 * with any other active claim that a single-repo CAS cannot see? Two signals,
 * both read straight off the persisted WAS graph:
 *
 *  (a) shared_code_rollup — a shared library and its cross-repo consumers. If
 *      the proposed claim touches a shared symbol (or the lib itself) and
 *      another claim touches a CONSUMER of that symbol (or the lib), they
 *      collide across repos. `blast_radius[].symbol -> consumer_deployable_ids`
 *      is exactly the WAS's own cross-deployable dependency index.
 *  (b) interfaces + links — a frozen/shared cross-repo contract. Each `link`
 *      ties a provider interface to a consumer interface across two codebases;
 *      if the proposed claim touches one interface's refs and another claim
 *      touches the linked counterpart's refs, both are editing two ends of the
 *      same cross-repo contract.
 *
 * Matching against a claim's footprint is deliberately tolerant (symbol-name OR
 * path-substring), mirroring the WAS's own evidence granularity — the WAS
 * records symbol names and file/path hints, not CAS node ids.
 */
function computeCrossRepoOverlap(
  proposal: AdvisoryClaimProposal,
  others: WorkClaim[],
  was: CrossCodebaseSystemGraph,
): AdvisoryOverlapFinding[] {
  const out: AdvisoryOverlapFinding[] = [];
  const proposalSyms = new Set(proposal.symbols ?? []);
  const proposalPaths = proposal.paths ?? [];

  // A claim "touches" a surface token when the token matches one of its symbols
  // exactly, or appears as a substring of one of its paths (or vice-versa) —
  // the WAS surface is name/path-shaped, not a CAS node id.
  const claimTouches = (claim: WorkClaim | AdvisoryClaimProposal, token: string): boolean => {
    if (!token) return false;
    const syms = 'symbols' in claim ? (claim.symbols ?? []) : (claim as WorkClaim).scope.symbols ?? [];
    if (syms.includes(token)) return true;
    const paths = 'symbols' in claim ? (claim.paths ?? []) : (claim as WorkClaim).scope.paths ?? [];
    return paths.some((p) => p === token || p.includes(token) || token.includes(p));
  };
  const proposalTouches = (token: string) =>
    proposalSyms.has(token) || proposalPaths.some((p) => p === token || p.includes(token) || token.includes(p));

  // (a) Shared-code rollup: shared library + its cross-repo consumers.
  for (const rollup of was.shared_code_rollup ?? []) {
    // The shared surface: the lib's exported symbols plus per-symbol blast radius.
    const surfaceSymbols = new Set<string>([
      ...(rollup.consumed_surface ?? []),
      ...((rollup.blast_radius ?? []).map((b) => b.symbol)),
    ]);
    const libTokens = [rollup.lib_name, rollup.path_hint].filter(Boolean) as string[];

    // Does the proposal touch this shared lib (a symbol on its surface, or the
    // lib path/name itself)?
    const proposalHitsSymbols = [...surfaceSymbols].filter((s) => proposalTouches(s));
    const proposalHitsLib = libTokens.some((t) => proposalTouches(t));
    if (proposalHitsSymbols.length === 0 && !proposalHitsLib) continue;

    for (const claim of others) {
      // Does this other claim touch the same shared surface / lib (a consumer
      // or the lib itself)?
      const claimHitsSymbols = [...surfaceSymbols].filter((s) => claimTouches(claim, s));
      const claimHitsLib = libTokens.some((t) => claimTouches(claim, t));
      if (claimHitsSymbols.length === 0 && !claimHitsLib) continue;

      const shared = [...new Set([...proposalHitsSymbols, ...claimHitsSymbols, ...(proposalHitsLib || claimHitsLib ? [rollup.lib_name] : [])])].filter(Boolean);
      out.push({
        agent_id: claim.agent_id,
        claim_id: claim.claim_id,
        intent: claim.intent,
        overlapping_paths: [],
        overlapping_symbols: intersectExact(proposalHitsSymbols, claimHitsSymbols),
        reason: 'cross-repo-shared-code',
        cas_derived: false,
        was_derived: true,
        shared_surface: shared,
      });
    }
  }

  // (b) Cross-repo contract links: two ends of the same frozen/shared contract.
  const interfaceById = new Map<string, (typeof was.interfaces)[number]>();
  for (const iface of was.interfaces ?? []) interfaceById.set(iface.id, iface);

  const interfaceTokens = (ifaceId: string): string[] => {
    const iface = interfaceById.get(ifaceId);
    if (!iface) return [];
    const toks: string[] = [];
    for (const r of iface.refs ?? []) {
      if (r.name) toks.push(r.name);
      if (r.file) toks.push(r.file);
    }
    for (const t of [iface.endpoint, iface.topic, iface.resource, iface.name, iface.key]) {
      if (t) toks.push(t);
    }
    return [...new Set(toks)];
  };

  for (const link of was.links ?? []) {
    const srcTokens = interfaceTokens(link.source_interface_id);
    const dstTokens = interfaceTokens(link.target_interface_id);
    if (srcTokens.length === 0 && dstTokens.length === 0) continue;

    const proposalOnSrc = srcTokens.some((t) => proposalTouches(t));
    const proposalOnDst = dstTokens.some((t) => proposalTouches(t));
    if (!proposalOnSrc && !proposalOnDst) continue;

    for (const claim of others) {
      const claimOnSrc = srcTokens.some((t) => claimTouches(claim, t));
      const claimOnDst = dstTokens.some((t) => claimTouches(claim, t));
      // Overlap when the two claims sit on the SAME contract — either both ends,
      // or opposite ends of the same cross-repo link (the fleet-scale case:
      // provider edited in one repo, consumer edited in the other).
      if (!claimOnSrc && !claimOnDst) continue;
      const sameContract = (proposalOnSrc || proposalOnDst) && (claimOnSrc || claimOnDst);
      if (!sameContract) continue;

      const shared = [...new Set([
        ...(proposalOnSrc || claimOnSrc ? srcTokens : []),
        ...(proposalOnDst || claimOnDst ? dstTokens : []),
      ])].slice(0, 8);
      out.push({
        agent_id: claim.agent_id,
        claim_id: claim.claim_id,
        intent: claim.intent,
        overlapping_paths: [],
        overlapping_symbols: [],
        reason: 'cross-repo-contract',
        cas_derived: false,
        was_derived: true,
        shared_surface: [`${link.kind}:${link.id}`, ...shared],
      });
    }
  }

  return out;
}

/** Path-prefix intersection (mirrors partitioner/local-store `pathsOverlap`),
 *  returning the concrete overlapping paths for the finding. */
function intersectPaths(a: string[], b: string[]): string[] {
  const out = new Set<string>();
  for (const p of a) {
    const np = p.replace(/\/+$/, '');
    for (const q of b) {
      const nq = q.replace(/\/+$/, '');
      if (np === nq || np.startsWith(nq + '/') || nq.startsWith(np + '/')) out.add(nq);
    }
  }
  return [...out];
}

/** Exact symbol/name intersection. */
function intersectExact(a: string[], b: string[]): string[] {
  const setB = new Set(b);
  return [...new Set(a.filter((x) => setB.has(x)))];
}
