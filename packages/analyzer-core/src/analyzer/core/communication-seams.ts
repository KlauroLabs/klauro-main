import type {
  CASOutput,
  CASExitPoint,
  CASEntryPoint,
  CASEntityLineage,
  CASEntityLineageAccessor,
  DeployableEvidence,
} from '../../types/cas.types';

/**
 * COMMUNICATION-SEAMS CLASSIFIER — the enrichment pass that takes the raw seams
 * Klauro already extracts (exit points, entry points, messaging edges, data
 * lineage) and assigns each one a single unified MODALITY:
 *
 *   - SYNC    request/response, the caller awaits a reply (HTTP/REST, gRPC unary,
 *             GraphQL query/mutation, RPC, a DB read that returns data).
 *   - ASYNC   fire-and-forget / event-driven, no blocking reply (message
 *             publish/consume, queue enqueue, webhook, event emit, async task
 *             dispatch — BullMQ/Celery/Sidekiq/SQS/Kafka/…).
 *   - PASSIVE communication via SHARED STATE, no direct call: two components that
 *             both touch the same database entity / cache key / bucket. The
 *             subtle one nobody models — derived from data-lineage writer/reader
 *             ownership where >1 component touches the same entity.
 *
 * It runs AFTER exit/entry/messaging/data-entity extraction, over the already-
 * assembled CASOutput, and is ADDITIVE — it derives from existing facts and
 * emits a new lightweight `communication_seams` record plus a system-level
 * inventory. It NEVER re-detects seams and never mutates existing facts.
 *
 * Deliberately NOT AI — deterministic classification over deterministic facts,
 * mirroring conventions-applier.ts / infra-topology-linker.ts (additive,
 * non-blocking, pure, evidence-carrying). Every seam records the fact that drove
 * its modality on `evidence` so the classification is verifiable, not a guess.
 */

export type SeamModality = 'sync' | 'async' | 'passive';
export type SeamLevel = 'node' | 'deployable' | 'workspace';

/** One classified communication seam. `source`/`target` are component identifiers
 *  at the requested level (a module root, a deployable name, or a repo). */
export interface CommunicationSeam {
  id: string;
  modality: SeamModality;
  /** 0..1 — how sure we are of the modality, from the driving fact. */
  confidence: number;
  /** The kind of fact this seam derives from. */
  kind: 'exit_point' | 'messaging' | 'passive_state' | 'cross_repo_contract';
  /** Component that initiates / writes. */
  source: string;
  /** Component that serves / reads / the external target. */
  target: string;
  /** The concrete fact that drove the modality (exit-point id, entity name, …). */
  evidence: string;
  /** Human-readable one-liner. */
  summary: string;
  /** For passive seams: the shared entity/resource both components touch. */
  shared_resource?: string;
  metadata?: Record<string, unknown>;
}

export interface CommunicationSeamInventory {
  level: SeamLevel;
  counts: { sync: number; async: number; passive: number; total: number };
  /** Component-to-component edges with their dominant modality and per-modality
   *  seam counts, so "all seams between components" reads at a glance. */
  component_seams: Array<{
    source: string;
    target: string;
    modalities: SeamModality[];
    sync: number;
    async: number;
    passive: number;
    total: number;
  }>;
}

export interface CommunicationSeamsResult {
  seams: CommunicationSeam[];
  /** Node-level inventory (module-to-module in-process seams). */
  inventory: CommunicationSeamInventory;
  /** Deployable-level rollup (deployable-to-deployable). Present when deployables exist. */
  deployable_inventory?: CommunicationSeamInventory;
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `seam_${prefix}_${seq}`;
}

/** A deployable that represents a real SHIP/RUN boundary worth naming a
 *  component after. Excludes tier-2 `server-entry` route-entries whose `name`
 *  is an HTTP path — those are entry points, not deployment units, and rooted at
 *  a per-route sub-dir. A container/compose/k8s/installer/bin at a concrete root
 *  is a true boundary; a `.`-rooted compose service still names the whole tree. */
function isShipBoundary(d: DeployableEvidence): boolean {
  if (d.kind === 'server-entry') return false;
  return d.tier === 1 || d.kind === 'container' || d.kind === 'compose-service' ||
    d.kind === 'k8s' || d.kind === 'serverless' || d.kind === 'installer' || d.kind === 'bin';
}

/**
 * Modality of an EXIT POINT, from its type + async operation flag.
 * `api`/`database`(returning read) => sync; `message`/`event`/`webhook` => async;
 * `sdk` follows its declared async flag; `cache`/`file` are one-way stores that
 * become PASSIVE only when a peer reads the same resource (handled separately) —
 * as a direct exit they are treated as sync side-effects.
 */
function exitModality(exit: CASExitPoint): { modality: SeamModality; confidence: number } | null {
  switch (exit.type) {
    case 'api':
      // A REST/GraphQL/gRPC call the caller awaits.
      return { modality: 'sync', confidence: 0.9 };
    case 'database':
      // A DB read/write. Reads that return rows are request/response; ORM/query
      // access is synchronous by default. (Cross-component SHARED writes are the
      // separate passive-seam pass — this classifies the direct DB egress.)
      return { modality: 'sync', confidence: 0.75 };
    case 'message':
    case 'event':
      // publish / enqueue / emit — fire-and-forget.
      return { modality: 'async', confidence: 0.9 };
    case 'webhook':
      // outbound webhook — no awaited reply.
      return { modality: 'async', confidence: 0.85 };
    case 'sdk':
      // An SDK call: honor the declared async flag; most are awaited RPCs.
      return exit.operation?.async === false
        ? { modality: 'sync', confidence: 0.7 }
        : { modality: 'sync', confidence: 0.6 };
    case 'cache':
    case 'file':
      // A direct read/write to a store — sync side-effect at the egress; only a
      // PEER touching the SAME store makes it a passive inter-component seam.
      return { modality: 'sync', confidence: 0.55 };
    default:
      // navigation / client_storage / analytics — not inter-component comms.
      return null;
  }
}

/** Top-level component key for a file path — the deployable that owns it when
 *  one exists, else the two-segment module root (apps/foo, libs/bar/…) so nodes
 *  in a monorepo group meaningfully rather than by leaf file. Mirrors
 *  infra-topology-linker's underRoot ownership. */
function componentForFile(
  file: string | undefined,
  deployableRoots: Array<{ root: string; name: string }>,
): string {
  if (!file) return 'unknown';
  let f = file.replace(/\\/g, '/');
  // Defensive: some accessors carry an ABSOLUTE staged/temp path (e.g. a
  // throwaway git repo under /var/folders/...) rather than a repo-relative file.
  // Recover the repo-relative tail at the first real source segment so the
  // component is the module, not the temp mount. If no such segment exists we
  // can't attribute it — return 'unknown' rather than a garbage prefix.
  if (f.startsWith('/')) {
    const m = f.match(/\/((?:apps|libs|packages|src)\/.*)$/);
    if (m) f = m[1];
    else return 'unknown';
  }
  f = f.replace(/^\/+/, '');
  // Longest matching deployable root wins (most specific ownership).
  let best: { root: string; name: string } | undefined;
  for (const d of deployableRoots) {
    if (d.root === '' || d.root === '.') continue;
    if (f === d.root || f.startsWith(`${d.root}/`)) {
      if (!best || d.root.length > best.root.length) best = d;
    }
  }
  if (best) return best.name;
  // Fallback: the leading module segments. apps/admin-api/... => apps/admin-api;
  // libs/business/agent/... => libs/business/agent; src/foo/... => src/foo.
  const parts = f.split('/');
  if (parts.length >= 3 && (parts[0] === 'libs' || parts[0] === 'packages')) {
    return parts.slice(0, 3).join('/');
  }
  if (parts.length >= 2) return parts.slice(0, 2).join('/');
  return parts[0] || 'root';
}

/** Node-id -> owning file, from the graph. */
function fileForNode(nodeId: string, nodeFile: Map<string, string>): string | undefined {
  return nodeFile.get(nodeId);
}

/** Resolve the code-side file a lineage accessor lives in. */
function accessorFile(acc: CASEntityLineageAccessor): string | undefined {
  return acc.file;
}

/**
 * Classify all communication seams from the already-extracted facts. Pure and
 * additive: returns the seam records + node/deployable inventories.
 */
export function classifyCommunicationSeams(
  output: Pick<
    CASOutput,
    'nodes' | 'exit_points' | 'entry_points' | 'data_lineage' | 'data_entities' | 'deployable_evidence'
  >,
): CommunicationSeamsResult {
  seq = 0;
  const seams: CommunicationSeam[] = [];

  const deployables: DeployableEvidence[] = output.deployable_evidence || [];
  // Only REAL deployment boundaries name a component — tier-1 ship declarations
  // (containers / compose-services / k8s / installers) and other bin/server/
  // package artifacts with a specific root. Tier-2 `server-entry` deployables are
  // per-ROUTE entries whose `name` is an HTTP path ("PUT /groups/:id/..."); using
  // them would label every file with a route string and fragment one app into
  // dozens of pseudo-components. We skip them and fall back to the module root so
  // the component is a clean `apps/<app>` / `libs/<area>` instead.
  const deployableRoots = deployables
    .filter(d => isShipBoundary(d))
    .map(d => ({
      root: d.root_path.replace(/\\/g, '/').replace(/\/+$/, '').replace(/^\/+/, ''),
      name: d.name,
    }));

  // node-id -> file, so an exit point's source_node resolves to a component.
  const nodeFile = new Map<string, string>();
  for (const n of output.nodes || []) {
    if (n.source?.file) nodeFile.set(n.id, n.source.file);
  }

  const componentOf = (file: string | undefined) => componentForFile(file, deployableRoots);

  // (1) EXIT-POINT seams: each external interaction, classified sync/async, from
  // the owning component to the named external target.
  for (const exit of output.exit_points || []) {
    const verdict = exitModality(exit);
    if (!verdict) continue;
    const file = (exit.metadata as any)?.file || fileForNode(exit.source_node, nodeFile);
    const source = componentOf(file);
    const target =
      exit.target?.service_id ||
      exit.target?.resource ||
      exit.target?.endpoint ||
      exit.name ||
      'external';
    seams.push({
      id: nextId(exit.type),
      modality: verdict.modality,
      confidence: verdict.confidence,
      kind: exit.type === 'message' || exit.type === 'event' ? 'messaging' : 'exit_point',
      source,
      target: String(target),
      evidence: `exit:${exit.id} type=${exit.type} async=${exit.operation?.async ?? 'n/a'}`,
      summary: `${source} --${verdict.modality}--> ${String(target)} (${exit.type})`,
      metadata: { exit_type: exit.type, exit_point: exit.id },
    });
  }

  // (2) MESSAGING consumer seams: entry points of type message/event are the
  // consume side of an async seam. They complete a producer's fire-and-forget.
  for (const ep of output.entry_points || []) {
    if (ep.type !== 'message' && ep.type !== 'event') continue;
    const file = ep.handler?.file || fileForNode(ep.source_node, nodeFile);
    const consumer = componentOf(file);
    const channel = ep.trigger?.event || ep.name || 'channel';
    seams.push({
      id: nextId('consume'),
      modality: 'async',
      confidence: 0.9,
      kind: 'messaging',
      source: String(channel),
      target: consumer,
      evidence: `entry:${ep.id} type=${ep.type}`,
      summary: `${String(channel)} --async--> ${consumer} (consume)`,
      metadata: { entry_type: ep.type, entry_point: ep.id },
    });
  }

  // (3) PASSIVE seams — the shared-state one. For each data entity, group its
  // writers and readers by COMPONENT. A passive seam exists between component A
  // and component B when A WRITES the entity and B READS it and A !== B: they
  // communicate through the shared table without ever calling each other.
  //
  // FALSE-POSITIVE GUARD: a single component that both writes and reads its own
  // entity is NOT a seam (no inter-component sharing). We only emit when a
  // distinct writer-component and reader-component exist for the SAME entity.
  // We also require a real writer set — an entity only ever READ (a view/lookup
  // owned elsewhere) yields no passive seam here.
  const lineage: CASEntityLineage[] = output.data_lineage || [];
  const passiveSeen = new Set<string>();
  for (const entity of lineage) {
    const writerComponents = new Set<string>();
    const readerComponents = new Set<string>();
    for (const w of entity.writers || []) {
      const c = componentOf(accessorFile(w));
      if (c && c !== 'unknown') writerComponents.add(c);
    }
    for (const r of entity.readers || []) {
      const c = componentOf(accessorFile(r));
      if (c && c !== 'unknown') readerComponents.add(c);
    }
    if (writerComponents.size === 0) continue; // read-only-here entity: no passive seam
    for (const writer of writerComponents) {
      for (const reader of readerComponents) {
        if (writer === reader) continue; // guard: same component isn't a seam
        // A passive (shared-state) seam is UNDIRECTED: A writes+B reads the same
        // entity is the same coupling as B writes+A reads. Key on the unordered
        // pair so we emit each component-pair/entity coupling ONCE, not twice.
        const [a, b] = writer < reader ? [writer, reader] : [reader, writer];
        const key = `${a}|${b}|${entity.entity_name}`;
        if (passiveSeen.has(key)) continue;
        passiveSeen.add(key);
        seams.push({
          id: nextId('passive'),
          modality: 'passive',
          confidence: 0.7,
          kind: 'passive_state',
          source: writer,
          target: reader,
          evidence: `entity:${entity.entity_id} writer=${writer} reader=${reader}`,
          summary: `${writer} --passive(${entity.entity_name})--> ${reader} (shared state)`,
          shared_resource: entity.entity_name,
          metadata: { entity_id: entity.entity_id },
        });
      }
    }
  }

  const inventory = buildInventory(seams, 'node');

  const result: CommunicationSeamsResult = { seams, inventory };

  // Deployable-level rollup: re-key each node-level seam's source/target from
  // module component to the owning deployable name, then re-aggregate. Reuses
  // the same deployable ownership as the node pass — components already ARE
  // deployable names when a deployable owns the file, so this collapses the
  // remaining libs/apps module keys onto deployables where a mapping exists.
  if (deployables.length > 0) {
    result.deployable_inventory = buildInventory(seams, 'deployable');
  }

  return result;
}

/**
 * Fold EXTRA seams (e.g. the consistency-model's broadened passive seams:
 * read-replica / streaming / CDC / materialized) into an existing seams result,
 * returning a NEW result whose inventories are rebuilt from the union. One
 * helper so passive-seam extensions merge through a single code path instead of
 * duplicated inline inventory-bumping in the orchestrator.
 *
 * Order-independent and dedup-aware: seams are de-duplicated by `id` (a seam
 * already present in `base` is not counted twice), and every inventory is
 * recomputed from scratch via `buildInventory` — a pure fold whose output
 * depends only on the SET of seams, not their insertion order. Merging the same
 * extras twice, or in any order, yields the same inventories. A deployable-level
 * inventory is (re)produced whenever either side already carried one.
 */
export function mergeSeams(
  base: CommunicationSeamsResult,
  extra: CommunicationSeam[],
): CommunicationSeamsResult {
  const seen = new Set(base.seams.map(s => s.id));
  const merged = [...base.seams];
  for (const s of extra) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    merged.push(s);
  }
  const result: CommunicationSeamsResult = {
    seams: merged,
    inventory: buildInventory(merged, base.inventory.level),
  };
  if (base.deployable_inventory) {
    result.deployable_inventory = buildInventory(merged, base.deployable_inventory.level);
  }
  return result;
}

/** Aggregate seams into a component-to-component inventory at the given level.
 *  At node level, source/target are used as-is (module components). At
 *  deployable level they are already deployable names for deployable-owned
 *  files; module/external keys pass through so nothing is dropped. */
function buildInventory(seams: CommunicationSeam[], level: SeamLevel): CommunicationSeamInventory {
  const counts = { sync: 0, async: 0, passive: 0, total: 0 };
  const byEdge = new Map<
    string,
    { source: string; target: string; sync: number; async: number; passive: number }
  >();
  for (const s of seams) {
    counts[s.modality] += 1;
    counts.total += 1;
    const key = `${s.source}=>${s.target}`;
    let edge = byEdge.get(key);
    if (!edge) {
      edge = { source: s.source, target: s.target, sync: 0, async: 0, passive: 0 };
      byEdge.set(key, edge);
    }
    edge[s.modality] += 1;
  }
  const component_seams = Array.from(byEdge.values())
    .map(e => {
      const modalities: SeamModality[] = [];
      if (e.sync > 0) modalities.push('sync');
      if (e.async > 0) modalities.push('async');
      if (e.passive > 0) modalities.push('passive');
      return { ...e, modalities, total: e.sync + e.async + e.passive };
    })
    .sort((a, b) => b.total - a.total || a.source.localeCompare(b.source));
  return { level, counts, component_seams };
}
