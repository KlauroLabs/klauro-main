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
