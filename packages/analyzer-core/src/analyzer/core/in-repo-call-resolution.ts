import type { CASEdge, CASExitPoint, CASNode, CASLibrary } from '../../types/cas.types';
import { appendAll, replaceArrayContents } from './bulk-array-ops';
import { TRACEABLE_NODE_TYPES } from './flow-concepts';

/**
 * IN-REPO CALL RESOLUTION — the pass that stops flows from terminating at the
 * first call that leaves the FILE.
 *
 * THE DEFECT THIS FIXES (measured, not hypothesized). Several language
 * analyzers classify a call by its SYNTAX rather than by whether the callee is
 * declared in this repository:
 *   - a path-qualified call (`Type::method(...)`, `mod::fn(...)`) is emitted as
 *     an `sdk` exit point with `target.sdk = "Type"`, unconditionally;
 *   - an imported-symbol call (`helper()` imported from `@/app/x/y`) is emitted
 *     as an `sdk` exit point with `target.sdk = "@/app/x/y"`.
 * Neither emits a `calls` edge to the callee's own node — even when that node
 * EXISTS in the same CAS. Downstream, both halves of that mistake compound:
 *   1. the call-graph/traversal has no edge to follow, so the chain from the
 *      entry point is one node long; and
 *   2. the spurious exit point is a role-`call_external` fact and a terminus
 *      candidate, so the one-node chain is labeled "Calls external service X"
 *      and declared COMPLETE.
 * The observable shape is a population of one-step flows whose modal terminus
 * kind is `sdk` — i.e. "where this flow ends" resolves to an import, not to a
 * persisted entity, a genuinely external service, or a returned response.
 *
 * WHAT THIS PASS DOES. It is a deterministic, evidence-gated normalization over
 * (nodes, edges, exit_points) run once after all analyzers have contributed and
 * node twins are merged, and BEFORE anything consumes the graph (call chains,
 * flow concepts, external services, the index). For each candidate exit point
 * it attempts to resolve the named callee to a REAL in-repo callable node. On
 * success it:
 *   - adds the `calls` edge the analyzer should have emitted (so traversal
 *     continues across file / package / crate boundaries), and
 *   - drops the exit point (an in-repo call does not leave the process, so it
 *     is not an exit — the dropped exit's id is retained on the new edge for
 *     provenance).
 * On failure it does NOTHING. A call that cannot be resolved to an in-repo
 * declaration stays exactly as the analyzer reported it: a genuine third-party
 * SDK call IS a terminus, and this pass must never launder one into an
 * internal hop.
 *
 * HONESTY GUARDS (each one exists because its absence would fabricate an edge):
 *   - POSITIVE RESOLUTION ONLY. An in-repo node named by BOTH the module/type
 *     part and the function part must exist. Name-only guesses are rejected.
 *   - LIBRARY-MAPPED CALLS ARE LEFT ALONE. When an analyzer's own
 *     known-library table renamed the module (metadata.library differs from
 *     metadata.module — e.g. module `Client` categorized as library `reqwest`)
 *     the analyzer has POSITIVE third-party evidence and this pass defers to
 *     it, even if the repo happens to declare a colliding type name.
 *   - DECLARED DEPENDENCIES WIN. A bare module name that matches a dependency
 *     manifest entry which is NOT a workspace-local path is third-party.
 *   - AMBIGUITY ABSTAINS. If more than one in-repo node survives tie-breaking
 *     (same file, then same top-level package/crate), nothing is resolved.
 */

/** Node types that can be the TARGET of a call. Anchored on the SAME set the
 *  flow traversal walks (TRACEABLE_NODE_TYPES) so an edge this pass adds is
 *  always an edge the traversal can actually follow — resolving to a node the
 *  walk would then skip produces a corrected graph and an uncorrected flow.
 *  The extras are declaration shapes some analyzers use for the same thing.
 *  Data/type/import nodes are deliberately absent: resolving to one would be a
 *  fabricated call edge. */
const CALLABLE_NODE_TYPES = new Set<string>([
  ...TRACEABLE_NODE_TYPES,
  'arrow_function', 'function_declaration', 'constructor',
  'interactor', 'command', 'job', 'task',
]);

/** Exit-point kinds whose `target.sdk` names a CODE SYMBOL (a type, module, or
 *  import specifier) rather than a network/storage resource — the only kinds
 *  where "is the callee declared in this repo?" is even a meaningful question.
 *  `api` is included because a mis-categorized in-repo type (a local `Client`
 *  with a `get` method) lands there too; it resolves only via the same
 *  symbol-based path, so real HTTP exits (which carry an endpoint and no
 *  in-repo symbol) are untouched. */
const SYMBOL_BEARING_EXIT_TYPES = new Set(['sdk', 'api', 'database', 'cache', 'message']);

/** Source-file extensions stripped when matching a module specifier against a
 *  real file path. Extension-agnostic on purpose: the specifier `@/a/b` must
 *  match `src/a/b.ts`, `src/a/b.tsx`, `src/a/b/index.ts`, … equally. */
const SOURCE_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.swift', '.cs',
  '.php', '.scala', '.dart', '.vue', '.svelte', '.astro',
];

export interface InternalizeInput {
  nodes: CASNode[];
  edges: CASEdge[];
  exitPoints: CASExitPoint[];
  libraries?: CASLibrary[];
}

export interface InternalizeStats {
  /** Exit points examined (symbol-bearing kinds only). */
  candidates: number;
  /** Exit points resolved to an in-repo callee and removed. */
  internalized: number;
  /** `calls` edges added (fewer than `internalized` when an edge already existed). */
  edges_added: number;
  /** Left alone because the analyzer's library table named a third-party package. */
  skipped_library_mapped: number;
  /** Left alone because the module matches a declared non-workspace dependency. */
  skipped_declared_dependency: number;
  /** Left alone because more than one in-repo node matched. */
  skipped_ambiguous: number;
  /** Left alone because no in-repo declaration carries that symbol (the common,
   *  correct case: a real third-party call). */
  unresolved: number;
  /** internalized, grouped by resolution tier. */
  by_tier: Record<string, number>;
  /** Pre-existing edges whose target was a dropped exit point and which were
   *  repointed at the resolved in-repo callee (keeping their own id/evidence). */
  edges_repointed: number;
  /** Edges that referenced a dropped exit point and could not be repointed
   *  truthfully — the repoint would have been a self-call or a duplicate of a
   *  call pair the graph already asserts — so they were removed rather than
   *  left with an endpoint that resolves nowhere. */
  edges_dropped_orphaned: number;
}

function fileOf(node: CASNode): string | undefined {
  return (node as any).file_path || node.source?.file;
}

/** Strip a source extension and any trailing `/index` so a module specifier and
 *  a real file path compare on the same footing. */
function normalizeModulePath(p: string): string {
  let out = p.replace(/\\/g, '/');
  for (const ext of SOURCE_EXTENSIONS) {
    if (out.endsWith(ext)) { out = out.slice(0, -ext.length); break; }
  }
  if (out.endsWith('/index')) out = out.slice(0, -'/index'.length);
  if (out.endsWith('/mod')) out = out.slice(0, -'/mod'.length); // rust module dir
  return out.replace(/^\.\/+/, '').replace(/^(\.\.\/)+/, '').replace(/^[@~]\//, '').replace(/^\/+/, '');
}

/** Top-level package/workspace directory of a path — the tie-break unit for
 *  "same crate / same package" when several files declare the same symbol. */
function packageRootOf(filePath: string): string {
  const parts = filePath.split('/');
  // `apps/app/src/...` and `bin/coordinator/src/...` both discriminate at 2.
  return parts.slice(0, Math.min(2, parts.length)).join('/');
}

/** The declaring type/impl/class a member node belongs to, from whatever fact
 *  the contributing analyzer recorded. Never guessed from the name. */
function ownerOf(node: CASNode): string | undefined {
  const md: any = node.metadata || {};
  const direct = md.implType || md.class || md.className || md.owner
    || md.attributes?.implType || md.attributes?.class || md.attributes?.className;
  if (typeof direct === 'string' && direct) return direct;
  // Structured member ids (`method:<file>:<Owner>:<name>` — rust/php/c#/kotlin
  // and friends) carry the owner positionally; only trust the form where the
  // trailing segment IS this node's own name.
  const segs = node.id.split(':');
  if (segs.length >= 4 && segs[segs.length - 1] === node.name) return segs[segs.length - 2];
  return undefined;
}

/** The function/member name this exit point is calling, from the analyzer's own
 *  facts. Falls back to the "Call to X" / "Type::x" shapes analyzers emit as
 *  the exit `name`, never to a guess. */
function calleeNameOf(ep: CASExitPoint): string | undefined {
  const md: any = ep.metadata || {};
  if (typeof md.function === 'string' && md.function) return md.function;
  if (typeof ep.target?.endpoint === 'string' && /^[A-Za-z_$][\w$]*$/.test(ep.target.endpoint)) {
    return ep.target.endpoint;
  }
  if (typeof ep.operation?.action === 'string' && /^[A-Za-z_$][\w$]*$/.test(ep.operation.action)) {
    return ep.operation.action;
  }
  const m = /(?:^Call to |::)([A-Za-z_$][\w$]*)$/.exec(ep.name || '');
  return m ? m[1] : undefined;
}

/** The module/type specifier this exit point attributes the call to. */
function moduleOf(ep: CASExitPoint): string | undefined {
  const md: any = ep.metadata || {};
  const raw = (typeof md.module === 'string' && md.module) ? md.module : ep.target?.sdk;
  return typeof raw === 'string' && raw ? raw : undefined;
}

/** Declared third-party package names — dependency manifest entries whose
 *  version is a real version string, not a workspace-local path. A monorepo's
 *  own crates/packages appear in the same list with a path "version"
 *  (`crates/crypto`), and those are emphatically NOT third party. */
function declaredThirdPartyNames(libraries: CASLibrary[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const lib of libraries || []) {
    const version = (lib as any).version;
    const isWorkspacePath = typeof version === 'string' && (version.includes('/') || version.startsWith('.'));
    if (isWorkspacePath) continue;
    if (lib.name) out.add(lib.name);
  }
  return out;
}

interface ResolutionIndex {
  byOwnerName: Map<string, CASNode[]>;
  byFileName: Map<string, CASNode[]>;
  byName: Map<string, CASNode[]>;
  /** normalized extensionless path -> real file paths that end with it. */
  filesByNormalizedTail: Map<string, Set<string>>;
}

function buildResolutionIndex(nodes: CASNode[]): ResolutionIndex {
  const byOwnerName = new Map<string, CASNode[]>();
  const byFileName = new Map<string, CASNode[]>();
  const byName = new Map<string, CASNode[]>();
  const filesByNormalizedTail = new Map<string, Set<string>>();
  const seenFiles = new Set<string>();

  const push = (map: Map<string, CASNode[]>, key: string, node: CASNode) => {
    const list = map.get(key);
    if (list) list.push(node); else map.set(key, [node]);
  };

  for (const node of nodes) {
    const file = fileOf(node);
    if (file && !seenFiles.has(file)) {
      seenFiles.add(file);
      const norm = normalizeModulePath(file);
      // Index every suffix of the normalized path so an alias specifier
      // (`@/app/Codebase/x` -> `apps/app/src/app/Codebase/x`) matches on its
      // tail without needing tsconfig path-alias resolution.
      const segs = norm.split('/');
      for (let i = 0; i < segs.length; i++) {
        const tail = segs.slice(i).join('/');
        let set = filesByNormalizedTail.get(tail);
        if (!set) { set = new Set(); filesByNormalizedTail.set(tail, set); }
        set.add(file);
      }
    }
    if (!CALLABLE_NODE_TYPES.has(node.type)) continue;
    if (!node.name) continue;
    push(byName, node.name, node);
    if (file) push(byFileName, `${file} ${node.name}`, node);
    const owner = ownerOf(node);
    if (owner) push(byOwnerName, `${owner} ${node.name}`, node);
  }
  return { byOwnerName, byFileName, byName, filesByNormalizedTail };
}

/** Narrow several same-name candidates to ONE using locality evidence only:
 *  the caller's own file, then the caller's own package/crate. Returns
 *  undefined when the field is still ambiguous — abstaining is correct. */
function disambiguate(candidates: CASNode[], callerFile: string | undefined): CASNode | undefined {
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  if (!callerFile) return undefined;
  const sameFile = candidates.filter(c => fileOf(c) === callerFile);
  if (sameFile.length === 1) return sameFile[0];
  if (sameFile.length > 1) return undefined;
  const root = packageRootOf(callerFile);
  const samePkg = candidates.filter(c => { const f = fileOf(c); return f !== undefined && packageRootOf(f) === root; });
  if (samePkg.length === 1) return samePkg[0];
  return undefined;
}

/**
 * Resolve one exit point's named callee to an in-repo callable node, or
 * undefined. Tiers are tried most-specific first; each returns only on an
 * unambiguous match.
 */
type Resolution = { node: CASNode; tier: string } | 'ambiguous' | undefined;

function resolveCallee(
  ep: CASExitPoint,
  index: ResolutionIndex,
  callerFile: string | undefined
): Resolution {
  const moduleSpec = moduleOf(ep);
  const callee = calleeNameOf(ep);
  if (!moduleSpec || !callee) return undefined;

  const looksLikePath = moduleSpec.includes('/') || moduleSpec.startsWith('.');

  // TIER 1 — module path -> file -> callable of that name in that file.
  // (imported-symbol calls: `@/app/x/y`, `./util`, `pkg/sub/mod`)
  if (looksLikePath) {
    // PATH ALIASES ARE PROJECT-DEFINED, so a specifier's LEADING segment often
    // appears nowhere on disk (`@stores/x.store`, `~features/y`, `#lib/z`).
    // Rather than parse every build tool's alias config, walk the specifier's
    // own tails longest-first and use the FIRST tail that matches real files;
    // resolution then still requires the callee symbol to be declared in one of
    // those files, unambiguously. Stopping at the first matching tail is what
    // keeps this from wandering: once a longer tail hits, a shorter and more
    // generic one is never consulted.
    const segs = normalizeModulePath(moduleSpec).split('/').filter(Boolean);
    for (let start = 0; start < segs.length; start++) {
      const files = index.filesByNormalizedTail.get(segs.slice(start).join('/'));
      if (!files || files.size === 0) continue;
      const hits: CASNode[] = [];
      for (const file of files) {
        for (const n of index.byFileName.get(`${file} ${callee}`) || []) hits.push(n);
      }
      const hit = disambiguate(hits, callerFile);
      if (hit) return { node: hit, tier: 'module_path' };
      // This tail IS the specifier's target, so abstain rather than fall
      // through to a shorter one. Several same-named symbols behind it is a
      // real ambiguity; none at all just means the symbol lives elsewhere.
      return hits.length > 1 ? 'ambiguous' : undefined;
    }
    return undefined;
  }

  // TIER 2 — `Type::method` / `Type.method`: the owner fact on a member node.
  // The module spec's LAST segment is the declaring type (`crate::a::Coordinator`).
  const ownerSpec = moduleSpec.split(/::|\./).filter(Boolean).pop();
  if (ownerSpec) {
    const owned = index.byOwnerName.get(`${ownerSpec} ${callee}`) || [];
    const hit = disambiguate(owned, callerFile);
    if (hit) return { node: hit, tier: 'type_member' };
    if (owned.length > 1) return 'ambiguous';
  }

  // TIER 3 — module-qualified FREE function (`crate::util::helper`): no owner
  // type exists, so require a globally UNIQUE in-repo callable of that name
  // whose file path contains the module segment. Uniqueness is the whole guard
  // here, so this tier abstains far more often than it fires.
  const segs = moduleSpec.split(/::/).filter(s => s && s !== 'crate' && s !== 'self' && s !== 'super');
  if (segs.length > 0) {
    const byName = index.byName.get(callee) || [];
    const moduleTail = segs[segs.length - 1];
    const withModuleInPath = byName.filter(n => {
      const f = fileOf(n);
      return f !== undefined && normalizeModulePath(f).split('/').includes(moduleTail);
    });
    if (withModuleInPath.length === 1) return { node: withModuleInPath[0], tier: 'module_free_function' };
  }

  return undefined;
}

/**
 * Run the pass. Mutates `edges` (appends resolved `calls` edges, and repoints
 * or removes the edges that referenced a dropped exit point) and `exitPoints`
 * (removes the exit points that were not exits at all), in place.
 *
 * REFERENTIAL INTEGRITY. Dropping an exit point is only half of the
 * correction: the contributing analyzer already emitted a `calls` edge whose
 * TARGET is that exit point's id. Removing the row without reconciling those
 * references leaves the edge pointing at an id that exists in no id-bearing
 * collection — a dangling endpoint the traversal cannot follow and every
 * derived count silently mis-attributes. Measured on a real analysis before
 * this reconciliation existed: 17,245 of 102,354 `calls` edges (16.9% of the
 * whole graph) referenced dropped exit ids, every one of them missing its
 * target and none of them carrying internalization provenance — because the
 * orphans were the ORIGINAL analyzer edges, not the replacements this pass
 * appends. So each reference is repointed at the resolved in-repo callee
 * (the edge is right; only its endpoint row moved), or dropped when
 * repointing would duplicate an existing call edge or name a self-call.
 */
export function internalizeInRepoCalls(input: InternalizeInput): InternalizeStats {
  const { nodes, edges, exitPoints } = input;
  const stats: InternalizeStats = {
    candidates: 0, internalized: 0, edges_added: 0,
    skipped_library_mapped: 0, skipped_declared_dependency: 0,
    skipped_ambiguous: 0, unresolved: 0, by_tier: {},
    edges_repointed: 0, edges_dropped_orphaned: 0,
  };
  if (!Array.isArray(nodes) || !Array.isArray(edges) || !Array.isArray(exitPoints)) return stats;

  const index = buildResolutionIndex(nodes);
  const nodesById = new Map(nodes.map(n => [n.id, n]));
  const thirdParty = declaredThirdPartyNames(input.libraries);

  const existingCallEdges = new Set<string>();
  for (const e of edges) {
    if (e.type === 'calls' || e.type === 'invokes') existingCallEdges.add(`${e.source} ${e.target}`);
  }

  const removed = new Set<CASExitPoint>();
  const added: CASEdge[] = [];
  /** Resolved callee node id, keyed by the id of the exit point being dropped —
   *  the repointing table phase two consumes. */
  const resolvedTargetByExitId = new Map<string, string>();
  const resolutionTierByExitId = new Map<string, string>();
  const declaredModuleByExitId = new Map<string, string>();

  for (const ep of exitPoints) {
    if (!SYMBOL_BEARING_EXIT_TYPES.has(ep.type)) continue;
    const moduleSpec = moduleOf(ep);
    const callee = calleeNameOf(ep);
    if (!moduleSpec || !callee) continue;
    stats.candidates++;

    // GUARD: the contributing analyzer's own known-library table renamed the
    // module (module `Client` -> library `reqwest`). That is positive
    // third-party evidence and outranks any in-repo name collision.
    const library = (ep.metadata as any)?.library;
    if (typeof library === 'string' && library && library !== moduleSpec) {
      stats.skipped_library_mapped++;
      continue;
    }

    // GUARD: the module spec IS a declared non-workspace dependency. Checked
    // for scoped/path-shaped names too (`@mui/material`, `rxjs/operators`),
    // because the alias-tail walk in resolveCallee would otherwise try to match
    // their trailing segment against a same-named file inside this repo.
    if (thirdParty.has(moduleSpec) || thirdParty.has(moduleSpec.split('/').slice(0, 2).join('/'))) {
      stats.skipped_declared_dependency++;
      continue;
    }

    const source = nodesById.get(ep.source_node);
    const callerFile = source ? fileOf(source) : undefined;
    const resolved = resolveCallee(ep, index, callerFile);
    if (resolved === 'ambiguous') {
      stats.skipped_ambiguous++;
      continue;
    }
    if (!resolved) {
      stats.unresolved++;
      continue;
    }
    // A call to the caller itself is not a forward hop.
    if (resolved.node.id === ep.source_node) { stats.unresolved++; continue; }

    stats.internalized++;
    stats.by_tier[resolved.tier] = (stats.by_tier[resolved.tier] || 0) + 1;
    removed.add(ep);
    resolvedTargetByExitId.set(ep.id, resolved.node.id);
    resolutionTierByExitId.set(ep.id, resolved.tier);
    declaredModuleByExitId.set(ep.id, moduleSpec);

    const key = `${ep.source_node} ${resolved.node.id}`;
    if (existingCallEdges.has(key)) continue;
    existingCallEdges.add(key);
    const line = (ep.metadata as any)?.call_line ?? (ep.metadata as any)?.line;
    added.push({
      id: `calls:internalized:${ep.source_node}:${resolved.node.id}${line !== undefined ? `:${line}` : ''}`,
      source: ep.source_node,
      target: resolved.node.id,
      type: 'calls',
      metadata: {
        confidence: 1,
        ...(line !== undefined ? { locations: [{ file: callerFile, line }] } : {}),
        attributes: {
          // Provenance: this edge replaces a mis-classified exit point. The
          // original id is retained so the correction is auditable.
          internalized_from_exit_point: ep.id,
          resolution: resolved.tier,
          declared_module: moduleSpec,
        },
      },
    } as CASEdge);
    stats.edges_added++;
  }

  if (removed.size > 0) {
    replaceArrayContents(exitPoints, exitPoints.filter(ep => !removed.has(ep)));
  }
  // The replacements land BEFORE reconciliation so that phase two sees them as
  // already-asserted call pairs: an original edge whose repointed pair is
  // already covered by a replacement is a duplicate, not a second call.
  if (added.length > 0) appendAll(edges, added);
  if (removed.size > 0) {
    reconcileEdgesToRemovedExitPoints(
      edges,
      { resolvedTargetByExitId, resolutionTierByExitId, declaredModuleByExitId },
      stats
    );
  }

  return stats;
}

/**
 * PHASE TWO — repoint (or drop) every edge that referenced an exit point this
 * pass removed, so no edge survives with an endpoint that resolves in no
 * collection. Runs after the removal so the decision table is complete.
 *
 * An edge is REPOINTED at the resolved in-repo callee, keeping its own id and
 * evidence (call site, confidence) and gaining the same internalization
 * provenance the appended replacement edges carry. It is DROPPED when
 * repointing would name a self-call or duplicate a call edge that already
 * exists for that source/target pair — both of which would trade a dangling
 * endpoint for a false one. An edge whose endpoint was removed but never
 * resolved cannot happen (only resolved exits are removed); the defensive
 * branch drops it rather than leave it dangling.
 */
function reconcileEdgesToRemovedExitPoints(
  edges: CASEdge[],
  tables: {
    resolvedTargetByExitId: Map<string, string>;
    resolutionTierByExitId: Map<string, string>;
    declaredModuleByExitId: Map<string, string>;
  },
  stats: InternalizeStats
): void {
  const { resolvedTargetByExitId, resolutionTierByExitId, declaredModuleByExitId } = tables;

  // Call-edge pairs already present, so repointing never manufactures a second
  // edge for a pair the graph already asserts.
  const callPairs = new Set<string>();
  for (const e of edges) {
    if (e.type !== 'calls' && e.type !== 'invokes') continue;
    if (resolvedTargetByExitId.has(e.target)) continue; // about to move
    callPairs.add(`${e.source} ${e.target}`);
  }

  const survivors: CASEdge[] = [];
  for (const e of edges) {
    const removedEndpoint = resolvedTargetByExitId.has(e.target) || resolvedTargetByExitId.has(e.source);
    if (!removedEndpoint) {
      survivors.push(e);
      continue;
    }
    // An exit point is only ever a call TARGET; an edge originating at one is
    // not something this pass can repoint truthfully.
    if (resolvedTargetByExitId.has(e.source)) {
      stats.edges_dropped_orphaned++;
      continue;
    }

    const exitId = e.target;
    const newTarget = resolvedTargetByExitId.get(exitId)!;
    const pair = `${e.source} ${newTarget}`;
    if (newTarget === e.source || callPairs.has(pair)) {
      stats.edges_dropped_orphaned++;
      continue;
    }

    callPairs.add(pair);
    e.target = newTarget;
    const metadata = (e.metadata || {}) as Record<string, unknown>;
    const attributes = (metadata.attributes || {}) as Record<string, unknown>;
    e.metadata = {
      ...metadata,
      attributes: {
        ...attributes,
        internalized_from_exit_point: exitId,
        resolution: resolutionTierByExitId.get(exitId),
        declared_module: declaredModuleByExitId.get(exitId),
      },
    } as CASEdge['metadata'];
    stats.edges_repointed++;
    survivors.push(e);
  }

  if (survivors.length !== edges.length) {
    replaceArrayContents(edges, survivors);
  }
}
