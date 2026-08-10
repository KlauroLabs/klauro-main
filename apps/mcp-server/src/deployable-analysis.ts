import type {
  CASOutput,
  CASNode,
  CASEntryPoint,
  CASExitPoint,
  CASDataEntity,
  CASEntityLineage,
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
import {
  ReachabilityIndex,
  reachabilityEdgePairs,
} from '../../../packages/analyzer-core/src/analyzer/core/reachability-index';

/**
 * SUB-CAS-NODE (DEPLOYABLE-LEVEL) SLICING
 *
 * Implements docs/cas/SPECIFICATION.md §0.4 + §0.7: the promotion rule,
 * per-deployable slicing, and retrieval-by-scope, for the case where a CAS's
 * sub-CAS nodes are the deployables inside one repo. Per the user's verbatim
 * constraint ("as long as the [unit] is effectively the same data as the CAS
 * we're good"), a sub-CAS-node unit is NOT a new object model — it is a
 * CASOutput-SHAPED object, scoped to one deployable's reachability closure,
 * built from the SAME fields a repo-level CAS already carries. No new types
 * are introduced for nodes/edges/entry-exit-points/entities/capabilities;
 * this module only ever DERIVES a subgraph + a thin index, never re-parses
 * source and never invents a second semantic algorithm.
 *
 * STORAGE (phase 1): recompute-on-request. A sub-CAS-node unit is a VIEW over
 * its parent CAS, not a persisted analysis artifact — cheapest honest
 * starting point; see the phase-2 open items at the bottom of
 * this file for the persistence tradeoff.
 *
 * THREE DECISIONS THIS MODULE MAKES, each stated once where it is implemented:
 *  - WHAT QUALIFIES as a unit — ship evidence, never cardinality
 *    (isBuildTargetDeclaration / tierQualifiedShipUnits).
 *  - WHAT A UNIT CONTAINS — a reachability-index closure seeded from the
 *    unit's own declared entry files and discriminating roots, completed by
 *    file; never a path-prefix match (seedsForUnit / closureForSeeds).
 *  - HOW SHARED CODE IS REPRESENTED — in every unit that reaches it, tagged,
 *    with one canonical owner, and with the multiplicity reported in numbers
 *    rather than hidden inside per-unit totals (DAS_COUNTS_NOTE).
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
 * THE QUALIFICATION PREDICATE, stated plainly: a DeployableEvidence row is a
 * sub-CAS-node unit when it is standalone (no `bundled_into`) AND its own evidence
 * declares a ship-or-build artifact — a Tier-1 ship declaration (Dockerfile
 * ENTRYPOINT/CMD, compose service, k8s/serverless manifest, installer
 * manifest, CI deploy job) or a Tier-2 `bin` row (a build target a manifest or
 * toolchain convention declares: cargo `[[bin]]`, a package manifest `bin`
 * field, a go `package main`, a `src/bin/*` entry). HOW MANY OTHER RUNNABLES
 * EXIST IN THE REPO IS NOT PART OF THE PREDICATE.
 *
 * This replaces a cardinality gate ("a Tier-2/3 row counts only if it is the
 * sole runnable candidate in the repo") that was written to suppress noise
 * from stray scripts but instead suppressed the answer on exactly the repos
 * where the question matters: in a workspace repo declaring a dozen build
 * targets, every one of them was rejected FOR EXISTING ALONGSIDE THE OTHERS,
 * so most of the repo's code belonged to no unit at all (measured: 59.9% of
 * nodes orphaned on a 12-build-target workspace repo). Ship evidence is the
 * discriminator; cardinality is not.
 *
 * Noise is still excluded, by the same predicate rather than by counting: a
 * row with no ship/build artifact of its own never qualifies — a
 * 'server-entry' (a port-binding route handler: an entry point INTO a
 * deployable, not a build target), a 'package' identity (publishable, not
 * runnable), a 'build-image' (plumbing for other units, see
 * deployable-evidence.ts's classifyBuildStageContainers). Tier-4
 * folder-heuristic evidence never reaches deployable_evidence at all
 * (DeployableEvidence.tier is typed 1|2|3).
 */
function isBuildTargetDeclaration(e: DeployableEvidence): boolean {
  return e.tier === 2 && e.kind === 'bin';
}

/**
 * Matching-purposes-only token normalization mirroring deployable-evidence.ts's
 * normalizeMemberToken (private to that module) — separators/case/a trailing
 * ship-artifact extension stripped, never used for a display name.
 */
function normalizeShipToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.(exe|msi|dmg|pkg|deb|rpm|appimage)$/i, '')
    .replace(/[\s_-]+/g, '');
}

/**
 * Collapse build-target rows that declare THE SAME binary twice. A toolchain
 * can declare one target through two conventions at once — cargo emits a
 * `[[bin]] name = "x"` row (root_path = the manifest dir) AND, for the same
 * target, a `src/bin/x.rs` row (root_path = that crate's `src`) — and shipping
 * both as units would double-count a single shipped artifact. Grouped by
 * normalized name among build-target rows only (never across Tier-1 ship
 * declarations, whose identity joins are already resolved upstream by
 * deployable-evidence.ts's joinComposeAndContainerUnits /
 * mergeDuplicateNamedInstallerLeaves).
 *
 * The survivor is the row whose evidence names a concrete ENTRY FILE (the
 * strongest evidence, and the one that can seed a closure without borrowing
 * from a sibling — see unitDeclaredFiles), then the longer root_path, then
 * declaration order. Rows are SELECTED, never synthesized: every returned row
 * is an element of the input array, so callers that resolve a row's identity
 * by `indexOf` keep working. The dropped twin's evidence is still consulted
 * for seeding via its identity group (see unitDeclaredFiles).
 */
function dedupeBuildTargetIdentities(units: DeployableEvidence[]): DeployableEvidence[] {
  const groups = new Map<string, DeployableEvidence[]>();
  const out: DeployableEvidence[] = [];
  for (const unit of units) {
    if (!isBuildTargetDeclaration(unit)) {
      out.push(unit);
      continue;
    }
    const key = normalizeShipToken(unit.name);
    if (!key) {
      out.push(unit);
      continue;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(unit);
  }
  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }
    const ranked = [...group].sort((a, b) => {
      const aFile = evidenceDeclaredFiles(a).length > 0 ? 0 : 1;
      const bFile = evidenceDeclaredFiles(b).length > 0 ? 0 : 1;
      if (aFile !== bFile) return aFile - bFile;
      const aRoot = (a.root_path || '').length;
      const bRoot = (b.root_path || '').length;
      if (aRoot !== bRoot) return bRoot - aRoot;
      return units.indexOf(a) - units.indexOf(b);
    });
    out.push(ranked[0]);
  }
  // Restore declaration order so unit ordering (and every tie-break that
  // depends on it) stays a pure function of the evidence list.
  return out.sort((a, b) => units.indexOf(a) - units.indexOf(b));
}

/**
 * The set of DeployableEvidence rows that count toward the promotion
 * threshold — "tier-qualified ship units" (spec §1). A CAS-scoped counterpart
 * to cross-codebase-analysis.ts's buildApplications/applyShippedGate. See
 * isBuildTargetDeclaration above for the predicate itself.
 */
export function tierQualifiedShipUnits(evidence: DeployableEvidence[] | undefined): DeployableEvidence[] {
  const items = evidence || [];
  const standalone = items.filter(e => !e.bundled_into);
  const qualified = standalone.filter(e => isTier1ShipDeclaration(e) || isBuildTargetDeclaration(e));
  return dedupeBuildTargetIdentities(qualified);
}

/**
 * The promotion gate itself (spec §1): a CAS promotes to a Deployable-
 * Analysis Workspace when it resolves >= 2 tier-qualified ship units. A
 * single-deployable CAS (the overwhelming common case, spec §7 "single-
 * deployable CAS is a valid, common, terminal state") MUST NOT promote —
 * this function returns false for 0 or 1 qualified units, never emitting a
 * one-entry sub-CAS-node list masquerading as a rollup.
 */
const PROMOTION_THRESHOLD = 2;

export function shouldPromote(cas: Pick<CASOutput, 'deployable_evidence'>): boolean {
  return tierQualifiedShipUnits(cas.deployable_evidence).length >= PROMOTION_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Stable sub-CAS-node identity (spec §7 "no phantom units")
// ---------------------------------------------------------------------------

/**
 * Deterministic id for a DeployableEvidence row, reusing the same
 * identity-collision-guarded construction buildDeployableRoots applies to
 * derive deployable_id — a pure function of evidence content, never of array
 * position, so re-analyzing an unchanged repo re-derives the same id.
 */
function subCasNodeIds(evidence: DeployableEvidence[]): string[] {
  return buildDeployableRoots(evidence).map(root => `das:${root.deployable_id.replace(/^dep:/, '')}`);
}

// ---------------------------------------------------------------------------
// §2.1 — Slicing: seed set + reachability closure
// ---------------------------------------------------------------------------

/** Non-call edges (imports, contains, extends, ...) are NOT part of the
 *  closure walk — see sliceContextFor for the exact call-graph edge set the
 *  reachability index is built over — but a surviving node's full induced edge
 *  set (of every type) is still projected into the slice afterward, so a
 *  slice's own edges are complete; only the MEMBERSHIP decision is
 *  call-graph-scoped. */

function bundledMembersOf(unit: DeployableEvidence, allEvidence: DeployableEvidence[]): DeployableEvidence[] {
  return allEvidence.filter(e => e !== unit && e.bundled_into === unit.name);
}

/**
 * Concrete roots for every name this unit's OWN ships_paths declares it
 * builds/bundles, resolved against the full evidence set BY NAME — not via
 * `bundled_into` linkage. A unit's `ships_paths` (Dockerfile
 * COPY/cargo-build-arg targets, installer bundle manifest entries) is
 * positive evidence of membership independent of which single unit a
 * candidate's `bundled_into` pointer happened to land on (a Tier-2/3 row can
 * only carry ONE `bundled_into`, so when the SAME binary is named by more
 * than one Tier-1 row's ships_paths — e.g. a repo-root "dispatch" container
 * whose entrypoint can run any of several services, alongside each service's
 * OWN dedicated compose-service row — the bin's `bundled_into` lands on
 * exactly one of them, but ships_paths still correctly names it as shipped
 * evidence for the others too). Used as a closure-seeding signal only, never
 * mutates `bundled_into` or the reported member_root_paths.
 */
function shipsPathMembers(
  unit: DeployableEvidence,
  allEvidence: DeployableEvidence[],
  allRoots: DeployableRoot[],
): Array<{ row: DeployableEvidence; root: DeployableRoot }> {
  // entrypoint_member is folded into the same token set as ships_paths: a
  // Tier-1 row that ships no COPY/cargo-build-arg evidence of its own but
  // whose Dockerfile ENTRYPOINT/CMD names a real bin (e.g. a "gateway"
  // service — no ships_paths, but `entrypoint/cmd: ["/bin/agent", "run"]`,
  // the SAME binary "agent"'s own compose-service row ships) is still
  // concretely identified by that name, just via a different evidence field.
  // Without this, "gateway" had zero concrete roots anywhere and fell back to
  // the degenerate '.' blanket match — the one unit that stayed
  // matching the entire codebase after the ships_paths fix landed.
  const tokens = [...(unit.ships_paths || []), ...(unit.entrypoint_member ? [unit.entrypoint_member] : [])]
    .map(normalizeShipToken)
    .filter(Boolean);
  if (!tokens.length) return [];
  const tokenSet = new Set(tokens);
  const members: Array<{ row: DeployableEvidence; root: DeployableRoot }> = [];
  allEvidence.forEach((candidate, idx) => {
    if (candidate === unit || candidate.tier === 1) return;
    const root = allRoots[idx];
    if (!root || !root.rootPath || root.rootPath === '.') return;
    const nameMatches = tokenSet.has(normalizeShipToken(candidate.name));
    const rootBase = root.rootPath.split('/').filter(Boolean).pop() || '';
    const rootBaseMatches = rootBase && tokenSet.has(normalizeShipToken(rootBase));
    if (nameMatches || rootBaseMatches) members.push({ row: candidate, root });
  });
  return members;
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

  // A degenerate own root ('.' — a monorepo-root Dockerfile/compose-service/
  // installer whose build context or script lives at the repo root) names no
  // narrower region than "the repo", and seedsForUnit drops it from the seed
  // roots for that reason. When concrete (non-'.') bundled-member or
  // ships_paths-resolved roots exist (the real bin/crate subdirectory a
  // compose service or installer actually ships), THOSE are the narrowing
  // signal and the degenerate own root is dropped here too so it cannot
  // dominate the longest-prefix ownership pass either.
  // Fallback for the redundant-multi-service-dispatch shape (real hosted
  // case, an "unnamed-service" root container): its own ships_paths
  // names 5 binaries, every one of which ALSO has its own dedicated
  // compose-service Tier-1 row that wins the `bundled_into` pointer, so
  // bundledMembersOf returns nothing for this row even though its ships_paths
  // evidence is real. Resolving ships_paths by name (not by bundled_into)
  // recovers those same concrete roots as an additional narrowing signal
  // without touching bundled_into or member_root_paths (still bundled_into-
  // derived, per spec §2.1 step 1) — see shipsPathRoots's own doc comment.
  const shipsRoots = shipsPathMembers(unit, allEvidence, allRoots).map(m => m.root);
  const concreteMemberRoots = [...memberRoots, ...shipsRoots].filter(r => r.rootPath && r.rootPath !== '.');
  if (own && own.rootPath === '.' && concreteMemberRoots.length > 0) {
    return concreteMemberRoots;
  }
  return own ? [own, ...memberRoots] : memberRoots;
}

function exitPointFile(exit: CASExitPoint, nodesById: Map<string, CASNode>): string | undefined {
  return (exit.metadata as any)?.file || nodesById.get(exit.source_node)?.source?.file;
}

function normalizeEvidencePath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
}

/**
 * The evidence-string grammar in which a provider names a build target's own
 * ENTRY FILE. A whitelist of the exact shapes deployable-evidence's providers
 * emit (bin-targets.ts's four bin conventions + the HTTP-entry shape), never a
 * "find something path-shaped in the text" guess: a row's evidence also cites
 * manifests, Dockerfiles and route paths, none of which are the target's
 * source entry.
 */
const DECLARED_ENTRY_FILE_PATTERNS: RegExp[] = [
  /^src\/bin entry:\s*(\S.*)$/,
  /^src\/main\.rs present, no \[\[bin\]\] override\s*\((.+)\)$/,
  /^package main entry:\s*(\S.*)$/,
  /^HTTP entry point:.*\(([^()]+?)(?::\d+)?\)$/,
];

/** Entry-file paths this row's OWN evidence declares (may be empty). */
function evidenceDeclaredFiles(unit: DeployableEvidence): string[] {
  const out: string[] = [];
  for (const line of unit.evidence || []) {
    for (const pattern of DECLARED_ENTRY_FILE_PATTERNS) {
      const match = line.match(pattern);
      if (match?.[1]) {
        out.push(normalizeEvidencePath(match[1]));
        break;
      }
    }
  }
  return [...new Set(out)];
}

/**
 * Rows that declare THE SAME artifact as `unit` (see
 * dedupeBuildTargetIdentities): only one of them is a sub-CAS node, but the
 * dropped twin's evidence still describes the same binary, so its declared
 * entry file is legitimate seeding evidence for the surviving unit.
 */
function identityTwins(unit: DeployableEvidence, allEvidence: DeployableEvidence[]): DeployableEvidence[] {
  const key = normalizeShipToken(unit.name);
  if (!key) return [];
  return allEvidence.filter(e => e !== unit && e.tier !== 1 && normalizeShipToken(e.name) === key);
}

/** Nodes belonging to each source file, and the file-key set — derived once
 *  per CAS (see sliceContextFor) rather than re-scanned per unit. */
interface CasSliceContext {
  nodesById: Map<string, CASNode>;
  nodeIdsByFile: Map<string, string[]>;
  /** Suffix lookup for a declared path recorded relative to a sub-package scan
   *  root instead of the repo root (the same prefix-drift
   *  extractEntryPointFilePath corrects) — keyed on the declared path, so a
   *  lookup is O(1) instead of a scan over every file. */
  filesBySuffixKey: Map<string, string[]>;
  reach: ReachabilityIndex;
}

const sliceContexts = new WeakMap<CASOutput, CasSliceContext>();

/**
 * Sub-CAS-node closures are computed with the REACHABILITY INDEX
 * (analyzer-core/core/reachability-index.ts): one Tarjan+PLL build per CAS,
 * then O(answer) `affectedSet` enumeration per unit — instead of the previous
 * per-unit re-scan of the whole edge list, which is the exhaustive-scan defect
 * class that index exists to retire.
 *
 * The sub-CAS-node closure needs the call graph `callEdgePairs` defines ('calls' edges
 * + resolved method_calls) PLUS 'invokes' edges, which some analyzers emit
 * for a dispatch/registration call — a closure that stopped at 'calls' would
 * silently lose that dispatch-reached code from a unit's own contents. The
 * persisted `cas.reachability_index` (built by buildReachabilityIndexFromCas)
 * is built over exactly that same edge set (`reachabilityEdgePairs`), so when
 * the CAS carries one this rehydrates it (`ReachabilityIndex.from`) instead of
 * rebuilding — the whole reason a second Tarjan+PLL pass existed was that the
 * persisted index used to be missing 'invokes'; now that it isn't, sub-CAS-node
 * slicing reuses it like every other reachability consumer.
 *
 * Reuse is gated on `includes_invokes_edges`, NOT on presence alone: an
 * analysis stored before that flag existed carries a persisted index built
 * over 'calls' + method_calls only, and sub-CAS-node slicing used to ALWAYS rebuild its own
 * (invokes-inclusive) index regardless of what was persisted — trusting an
 * old index just because it exists would silently hand such a unit a
 * narrower closure than it used to get, which is exactly the kind of
 * regression this function must never introduce. The rebuild path covers
 * that case, plus CAS objects with no persisted index at all (in-memory test
 * fixtures, proposal previews), so this function degrades to "build it"
 * rather than throwing or under-reporting.
 */
function sliceContextFor(cas: CASOutput): CasSliceContext {
  const cached = sliceContexts.get(cas);
  if (cached) return cached;

  const nodes = cas.nodes || [];
  const nodesById = new Map(nodes.map(n => [n.id, n]));
  const nodeIdsByFile = new Map<string, string[]>();
  for (const n of nodes) {
    const file = n.source?.file ? normalizeEvidencePath(n.source.file) : undefined;
    if (!file) continue;
    if (!nodeIdsByFile.has(file)) nodeIdsByFile.set(file, []);
    nodeIdsByFile.get(file)!.push(n.id);
  }
  const filesBySuffixKey = new Map<string, string[]>();
  for (const file of nodeIdsByFile.keys()) {
    const segments = file.split('/');
    // Every path-segment suffix of the file, so a declared 'src/main.rs'
    // resolves to 'crates/agent/src/main.rs' only when the drift is a missing
    // PREFIX (never an unrelated same-basename file elsewhere: the suffix must
    // still match segment-for-segment).
    for (let i = 1; i < segments.length; i++) {
      const key = segments.slice(i).join('/');
      if (!filesBySuffixKey.has(key)) filesBySuffixKey.set(key, []);
      filesBySuffixKey.get(key)!.push(file);
    }
  }

  const reach = cas.reachability_index?.includes_invokes_edges
    ? ReachabilityIndex.from(cas.reachability_index)
    : ReachabilityIndex.build(nodes.map(n => n.id), reachabilityEdgePairs(cas as any));

  const context: CasSliceContext = { nodesById, nodeIdsByFile, filesBySuffixKey, reach };
  sliceContexts.set(cas, context);
  return context;
}

interface UnitSeed {
  seedNodeIds: Set<string>;
  /** Human-readable, evidence-citing account of WHERE this unit's seed came
   *  from — so a 0-node or an unexpectedly-large unit is diagnosable from the
   *  index alone instead of by re-deriving the slice. */
  basis: string[];
}

/** Every entry file a unit's own evidence — or the evidence of a row that
 *  declares the SAME artifact (an identity twin), a bundled member, or a
 *  ships_paths-named member — names for it. A Tier-1 ship declaration cites a
 *  Dockerfile/compose file, never a source entry, so its entry files come from
 *  the build targets it ships. */
function unitDeclaredFiles(
  unit: DeployableEvidence,
  allEvidence: DeployableEvidence[],
  allRoots: DeployableRoot[],
): string[] {
  return [...new Set([
    ...evidenceDeclaredFiles(unit),
    ...identityTwins(unit, allEvidence).flatMap(evidenceDeclaredFiles),
    ...bundledMembersOf(unit, allEvidence).flatMap(evidenceDeclaredFiles),
    ...shipsPathMembers(unit, allEvidence, allRoots).map(m => m.row).flatMap(evidenceDeclaredFiles),
  ])];
}

/** Resolve a declared path against the CAS's real node files: exact match, or
 *  a path-segment-suffix match for a path recorded relative to a sub-package
 *  scan root instead of the repo root. Never a basename guess. */
function resolveDeclaredFile(declared: string, ctx: CasSliceContext): string[] {
  if (ctx.nodeIdsByFile.has(declared)) return [declared];
  return ctx.filesBySuffixKey.get(declared) || [];
}

/**
 * The seed set for a unit's closure. Two kinds of evidence contribute, and
 * PATH PREFIXES ALONE ARE NOT A SEED RULE — seeding by root prefix produced
 * both observed failure modes: a root_path of '.' (a repo-root compose
 * `build: .` or installer script, completely normal) matched every file in the
 * repo so every unit's "slice" was the whole codebase; and a root_path
 * pointing at a deploy-time or build-context directory rather than source
 * matched almost nothing, so a repo's real products came out as a handful of
 * nodes.
 *
 *  1. DECLARED ENTRY FILES — the file a build target's own evidence names
 *     (cargo `src/bin/x.rs` / `src/main.rs`, a go `package main` file). The
 *     only signal that can tell two build targets in the SAME crate apart.
 *  2. CONCRETE ROOTS — its own root_path plus bundled-member and
 *     ships_paths-resolved roots, with '.' dropped, and with any root SHARED
 *     WITH A SIBLING UNIT'S ENTRY FILE dropped as well. A directory that
 *     contains two sibling build targets' entry files cannot discriminate
 *     between them (a workspace `src/` holding `src/bin/a.rs` and
 *     `src/bin/b.rs`; a crate whose `src/bin/` holds four targets), so for
 *     those units only their own entry file seeds the closure. A root that
 *     contains exactly this unit's target IS its build input and seeds it
 *     whole — that is what a compose service building `bin/agent` ships.
 *
 * A unit with no resolvable seed reports zero nodes with its basis saying so,
 * rather than silently claiming the repo.
 */
function seedsForUnit(
  unit: DeployableEvidence,
  allEvidence: DeployableEvidence[],
  roots: DeployableRoot[],
  allRoots: DeployableRoot[],
  ctx: CasSliceContext,
): UnitSeed {
  const seedNodeIds = new Set<string>();
  const basis: string[] = [];

  const ownFiles = new Set<string>();
  for (const declared of unitDeclaredFiles(unit, allEvidence, allRoots)) {
    const resolved = resolveDeclaredFile(declared, ctx);
    if (resolved.length === 0) continue;
    for (const file of resolved) {
      ownFiles.add(file);
      for (const id of ctx.nodeIdsByFile.get(file) || []) seedNodeIds.add(id);
    }
    basis.push(`entry-file:${declared}`);
  }

  const siblingFiles: string[] = [];
  for (const sibling of tierQualifiedShipUnits(allEvidence)) {
    if (sibling === unit) continue;
    for (const declared of unitDeclaredFiles(sibling, allEvidence, allRoots)) {
      for (const file of resolveDeclaredFile(declared, ctx)) {
        if (!ownFiles.has(file)) siblingFiles.push(file);
      }
    }
  }

  const concreteRoots = roots.filter(r => r.rootPath && r.rootPath !== '.');
  // The sibling-sharing exclusion applies only when this unit HAS an entry file
  // of its own to fall back on. A unit whose only evidence is a root (a cargo
  // `[[bin]]` row that names a target but no path) keeps that root even when a
  // sibling target lives under it — dropping it would leave the unit with no
  // seed at all, which reports a real build target as zero nodes.
  const discriminatingRoots = ownFiles.size === 0
    ? concreteRoots
    : concreteRoots.filter(root => !siblingFiles.some(file => matchDeployableRoot(file, [root])));

  // THE REPO ROOT AS A SEED. '.' is a prefix of every file, so admitting it
  // freely is the blanket match that made nine units of one workspace repo
  // identical. It is admitted in exactly two evidence-backed cases:
  //  (a) the unit's own entry file sits DIRECTLY at the repo root — a go
  //      `package main` in `main.go`, an npm bin at the top level: the module
  //      root IS its build input, and refusing it reports a whole
  //      single-binary repo as orphans (measured: 99% orphaned);
  //  (b) the unit has no narrower evidence at all — a repo-root Dockerfile or
  //      compose service whose context is '.' and which ships nothing
  //      separately identifiable. Its build context is the repo, and the
  //      alternative is a 0-node unit for a real ship declaration.
  // A unit with narrower evidence never gets '.', which is why the workspace
  // case stays narrow: every one of those services names a bin/crate.
  const ownRootIsRepoRoot = roots.some(r => !r.rootPath || r.rootPath === '.');
  const entryFileAtRepoRoot = [...ownFiles].some(file => !file.includes('/'));
  const admitRepoRoot = ownRootIsRepoRoot
    && discriminatingRoots.length === 0
    && (entryFileAtRepoRoot || ownFiles.size === 0);

  const seedRoots = admitRepoRoot
    ? [...discriminatingRoots, { deployable_id: '', deployable_name: '', rootPath: '.' }]
    : discriminatingRoots;
  if (seedRoots.length > 0) {
    for (const [file, ids] of ctx.nodeIdsByFile) {
      if (!matchDeployableRoot(file, seedRoots)) continue;
      for (const id of ids) seedNodeIds.add(id);
    }
    for (const root of seedRoots) basis.push(`root:${root.rootPath}`);
  }

  if (seedNodeIds.size === 0) basis.push('no-resolvable-seed');
  return { seedNodeIds, basis };
}

/**
 * The unit's node closure: its seeds, everything they transitively CALL, and —
 * because a source FILE is a compilation unit, not a menu — every node in
 * every file the closure touches.
 *
 * Two rules, applied in this order and ONCE each:
 *  1. CALL-DOWNSTREAM (`affectedSet` direction 'downstream'): what does this
 *     artifact's code call? Downstream-only is the containment question a
 *     deployable asks, so it follows callees into shared libraries but never
 *     turns around and walks BACKWARD from a shared library into a sibling
 *     unit's callers, which would merge every unit touching a common util into
 *     one blob.
 *  2. FILE COMPLETION: if any node of a file is in the closure, the whole file
 *     is — you cannot ship half a module. Without this, counts collapse on
 *     exactly the languages whose call graph is sparsest (a Rust binary whose
 *     `main` resolves two call edges came out as a 2-node "deployable" while
 *     its crate sat in the orphan pile).
 *
 * Deliberately NOT iterated to a fixpoint. Alternating the two rules until
 * stable measures ~77% of a workspace repo into EVERY unit: file completion
 * admits functions this binary never calls, and walking THOSE functions'
 * callees invents membership one hop at a time until every unit contains
 * everything. Completion is a statement about the files already established as
 * members, not a new frontier.
 *
 * Seeds are unioned back in explicitly: `affectedSet` only enumerates nodes
 * the index covers, and a node with no incident call edge is deliberately
 * absent from the index (see reachability-index.ts) — it still belongs to the
 * unit that declares it.
 */
function closureForSeeds(seedNodeIds: Set<string>, ctx: CasSliceContext): Set<string> {
  if (seedNodeIds.size === 0) return new Set();
  const closure = new Set(seedNodeIds);
  const { affected } = ctx.reach.affectedSet(seedNodeIds, { direction: 'downstream', includeSeeds: false });
  for (const id of affected) closure.add(id);

  const files = new Set<string>();
  for (const id of closure) {
    const file = ctx.nodesById.get(id)?.source?.file;
    if (file) files.add(normalizeEvidencePath(file));
  }
  for (const file of files) {
    for (const sibling of ctx.nodeIdsByFile.get(file) || []) closure.add(sibling);
  }
  return closure;
}

// ---------------------------------------------------------------------------
// §2.2 — Shared-code attribution
// ---------------------------------------------------------------------------

export type SubCasNodeAttribution = 'exclusive' | 'owned' | 'shared';

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
    // '.' is a prefix of every file (isPathPrefix) and therefore says nothing
    // about ownership — a repo-root-context unit must not become the canonical
    // owner of every shared node in the repo by default.
    if (!root.rootPath || root.rootPath === '.') continue;
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

/**
 * SLICE-LOCAL REFERENTIAL INTEGRITY (spec §3): every `flow_id` a slice's
 * capabilities/surfaces point at must resolve to a flow PRESENT IN THAT SLICE.
 * A capability that survives into unit A can carry `related_flows` naming
 * flows rooted in unit B's entry points; leaving those references in place is
 * how a scoped comprehension payload came to name other deployables' flows
 * (a scoped query returned flows whose own ids identify a different binary).
 * Operations are also narrowed to the slice's own entry points, so a
 * capability shared by two units describes only the operations THIS unit
 * exposes.
 */
function scopeCapabilitiesToSlice<T extends SystemCapability>(
  caps: T[],
  includedEntryPointIds: Set<string>,
  survivingFlowIds: Set<string>,
): T[] {
  return caps.map(cap => {
    const operations = (cap.operations || []).filter(op => includedEntryPointIds.has(op.entry_point_id));
    const related = (cap.related_flows || []).filter(ref => survivingFlowIds.has(ref.flow_id));
    return {
      ...cap,
      operations,
      ...(cap.related_flows ? { related_flows: related } : {}),
    };
  });
}

function filterUserJourneys(journeys: CASUserJourney[] | undefined, includedEntryPointIds: Set<string>): CASUserJourney[] {
  return (journeys || []).filter(j => includedEntryPointIds.has(j.entry_point_id));
}

/**
 * The flows that belong to a unit: a flow is IN the slice when its own root —
 * `entry_point`, which is either an entry-point id or the root node id of a
 * chain-anchored flow — is in the slice. Nothing else qualifies a flow.
 *
 * The previous rule also admitted any flow sharing a capability with a
 * surviving capability, which is how a scoped payload came to contain flows
 * whose own ids name a DIFFERENT deployable: capabilities are cross-cutting by
 * construction (one capability's operations can span several binaries), so
 * "shares a capability" is not containment. Membership is now decided by the
 * flow's own root only; `capability_ids` are then narrowed to the capabilities
 * that survive here, and dangling `related_flows` references are pruned in
 * scopeCapabilitiesToSlice.
 */
function scopeFlows(
  flows: CASFlowGraph['flows'],
  includedEntryPointIds: Set<string>,
  reachable: Set<string>,
  survivingCapabilityIds: Set<string>,
): NonNullable<CASFlowGraph['flows']> {
  return (flows || [])
    .filter(flow => includedEntryPointIds.has(flow.entry_point) || reachable.has(flow.entry_point))
    .map(flow => ({
      ...flow,
      ...(flow.capability_ids
        ? { capability_ids: flow.capability_ids.filter(id => survivingCapabilityIds.has(id)) }
        : {}),
    }));
}

/** The slice's flow graph plus the flow ids it contains — the id set every
 *  other layer's flow references are pruned against (scopeCapabilitiesToSlice),
 *  so "a slice's related_flows resolve to flows present in that slice" holds by
 *  construction instead of by convention. */
interface ScopedFlowGraph {
  graph: CASFlowGraph | undefined;
  flowIds: Set<string>;
}

function filterFlowGraph(
  flowGraph: CASFlowGraph | undefined,
  includedEntryPointIds: Set<string>,
  reachable: Set<string>,
): ScopedFlowGraph {
  if (!flowGraph) return { graph: undefined, flowIds: new Set() };
  const survivingCaps = (flowGraph.capabilities || []).filter(cap =>
    (cap.entry_points || []).some(id => includedEntryPointIds.has(id)));
  const scopedFlows = scopeFlows(
    flowGraph.flows,
    includedEntryPointIds,
    reachable,
    new Set(survivingCaps.map(c => c.id)),
  );
  const scopedFlowIds = new Set(scopedFlows.map(f => f.flow_id));
  if (survivingCaps.length === 0) return { graph: undefined, flowIds: scopedFlowIds };
  const survivingIds = new Set(survivingCaps.map(c => c.id));
  const graph: CASFlowGraph = {
    // A capability's own `entry_points` list is narrowed to this unit's, so a
    // cross-cutting capability describes only the surface THIS deployable
    // exposes (CASCapability carries no related_flows of its own — that
    // reference lives on SystemCapability and is pruned in
    // scopeCapabilitiesToSlice).
    capabilities: survivingCaps.map(cap => ({
      ...cap,
      entry_points: cap.entry_points.filter(id => includedEntryPointIds.has(id)),
    })),
    ...(flowGraph.flows ? { flows: scopedFlows } : {}),
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
  return { graph, flowIds: scopedFlowIds };
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

export interface SubCasNodeIndexEntry {
  /** Stable id, spec §7 (derived from the owning DeployableEvidence's
   *  identity — same construction as buildDeployableRoots' deployable_id). */
  id: string;
  name: string;
  root_path: string;
  member_root_paths: string[];
  tier: 1 | 2 | 3;
  kind: DeployableEvidence['kind'];
  /** Every node in this unit's closure — INCLUDING code it shares with other
   *  units. Unit node_counts therefore do not partition the graph; see
   *  SubCasNodeIndex.counts_note. */
  node_count: number;
  /** The part of node_count no other unit reaches. */
  exclusive_node_count: number;
  /** The part of node_count at least one other unit also reaches (a workspace
   *  crate five binaries link is SHARED five times, not duplicated). */
  shared_node_count: number;
  /** Of `shared_node_count`, the nodes for which THIS unit is the canonical
   *  owner (spec §2.2 — exactly one owner per shared node, never zero, never
   *  two). Summing exclusive_node_count + owned_shared_node_count across units
   *  gives covered_node_count exactly. */
  owned_shared_node_count: number;
  entry_point_count: number;
  exit_point_count: number;
  /** Nodes the unit's own evidence put in the closure before reachability
   *  expansion, and the evidence that produced them (`entry-file:<path>` /
   *  `root:<path>` / `no-resolvable-seed`) — so an empty or an unexpectedly
   *  large unit is diagnosable from the index alone. */
  seed_node_count: number;
  seed_basis: string[];
  boundary_evidence: string[];
}

export interface SubCasNodeIndex {
  promoted: boolean;
  units: SubCasNodeIndexEntry[];
  /** How many tier-qualified ship units this CAS resolves, and the threshold
   *  promotion needs — reported ALWAYS, including when `promoted` is false.
   *  "1 qualified unit, below the threshold of 2" and "no ship evidence at
   *  all" are different answers and a caller must be able to tell them apart;
   *  before this, both surfaced as an empty unit list. */
  qualified_unit_count: number;
  promotion_threshold: number;
  /** One sentence saying why this CAS is or is not promoted, in the same terms
   *  as qualified_unit_count. */
  reason: string;
  /** Total nodes in the parent CAS's graph — the denominator for coverage. */
  graph_node_count: number;
  /** Nodes in at least one unit's closure (the union, counted once). */
  covered_node_count: number;
  /** covered_node_count / graph_node_count, 0-1, rounded to 4 dp. */
  coverage_ratio: number;
  /** Nodes reached by exactly one unit / by more than one. These two plus
   *  orphan_node_count partition graph_node_count exactly. */
  exclusive_node_count: number;
  shared_node_count: number;
  /** Sum of every unit's node_count. Exceeds covered_node_count by exactly the
   *  multiplicity of shared code — stated explicitly so a reader never has to
   *  infer whether unit counts overlap. */
  sum_of_unit_node_counts: number;
  /** Nodes reached by NO unit at all (spec asks these be reported, not
   *  silently dropped, so counts stay honest — "no node in zero slices
   *  unless genuinely unreachable"). Empty when every node is claimed by at
   *  least one unit's closure. */
  orphan_node_count: number;
  orphan_node_ids: string[];
  counts_note: string;
  /** INVARIANT (spec §7 addendum): distinct qualified units whose reachability
   *  closures overlap almost entirely (>= DUPLICATE_CLOSURE_OVERLAP_RATIO of
   *  the smaller closure) are describing the SAME shipped artifact reached via
   *  two different evidence rows, not two artifacts — e.g. a compose-service
   *  row and an unrelated bin row that both close over the whole repo. The
   *  richer-evidence unit survives; the rest are dropped from `units` before
   *  slicing/counting and logged here so a caller can tell "we collapsed a
   *  real duplicate" apart from "there really is only one unit". This is the
   *  backstop the counts_note invariant (exclusive+shared+orphan===graph)
   *  does NOT catch: that identity held even while three units each claimed
   *  ~the whole graph, because it sums exclusive/shared correctly regardless
   *  of how many *units* point at the same nodes. */
  duplicate_units_collapsed: Array<{ dropped_id: string; dropped_name: string; kept_id: string; kept_name: string; overlap_ratio: number }>;
  /** Raw node ids repeated more than once in orphan_node_ids before
   *  deduplication — a non-zero count means the parent CAS's node graph
   *  itself contains two+ node objects sharing one id (a graph-construction
   *  bug upstream, most often two un-merged deployable-evidence rows each
   *  emitting a `deployable:<name>` summary node keyed only by name). The
   *  list below is already deduplicated; this count is the tripwire. */
  orphan_node_id_duplicate_count: number;
}

/** HOW SHARED CODE IS REPRESENTED (spec §2.2, decided here and stated once):
 *  a node reached by N units appears in ALL N slices — a workspace crate that
 *  five binaries link really is part of all five shipped artifacts, and a slice
 *  that omitted it would describe a binary that cannot run. It is tagged in
 *  each slice (`metadata.attribution` = 'owned' on its single canonical owner,
 *  'shared' elsewhere, with `canonical_owner_sub_cas_node_id` pointing home), and
 *  the index reports the multiplicity in numbers rather than leaving it to be
 *  inferred: exclusive/shared/orphan partition the graph, while
 *  sum_of_unit_node_counts is allowed to exceed the graph and says by how
 *  much. */
const DAS_COUNTS_NOTE =
  'Unit node_counts include shared code and so may sum to more than graph_node_count; '
  + 'exclusive_node_count + shared_node_count + orphan_node_count === graph_node_count, and '
  + 'each shared node has exactly one canonical owner (owned_shared_node_count).';

export interface SubCasNodeSlice {
  sub_cas_node_id: string;
  das_unit_name: string;
  root_path: string;
  member_root_paths: string[];
  /** See SubCasNodeIndexEntry.seed_node_count / seed_basis. */
  seed_node_count: number;
  seed_basis: string[];
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
    | 'user_journeys'
    | 'communication_seams'
  > & { deployable_evidence: DeployableEvidence[] };
}

export interface BuildDeployableAnalysesResult {
  promoted: boolean;
  sub_cas_nodes: SubCasNodeIndex;
  units: SubCasNodeSlice[];
}

// ---------------------------------------------------------------------------
// §2.1 + §2.2 — sliceDeployableAnalysis (single unit)
// ---------------------------------------------------------------------------

/**
 * Slice one tier-qualified deployable's sub-CAS node out of the repo's own CAS.
 * Pure/derived-only: reads `cas`'s already-extracted facts, walks the
 * already-extracted call graph, and projects the already-extracted
 * capability/flow/entity/seam layers onto the resulting node subset. Never
 * reads source, never invents a second capability/flow algorithm.
 */
export function sliceDeployableAnalysis(cas: CASOutput, deployable: DeployableEvidence): SubCasNodeSlice {
  const allEvidence = cas.deployable_evidence || [];
  const allRoots = buildDeployableRoots(allEvidence);
  const ctx = sliceContextFor(cas);
  const nodesById = ctx.nodesById;

  const roots = unitRoots(deployable, allEvidence, allRoots);
  const { seedNodeIds, basis } = seedsForUnit(deployable, allEvidence, roots, allRoots, ctx);
  const reachable = closureForSeeds(seedNodeIds, ctx);

  const idx = allEvidence.indexOf(deployable);
  const unitId = subCasNodeIds(allEvidence)[idx] ?? `das:${deployable.kind}:${deployable.name}`;

  const nodes = cas.nodes.filter(n => reachable.has(n.id));
  const edges = (cas.edges || []).filter(e => reachable.has(e.source) && reachable.has(e.target));
  const reachableFiles = new Set(nodes.map(n => n.source?.file).filter((f): f is string => Boolean(f)));

  // Entry/exit points belong to the unit whose closure contains their handler
  // node — not to whichever unit's root_path happens to be a prefix of their
  // file. Path-prefix attribution is what gave every unit of a repo-root-context
  // workspace the same 341 entry points; a handler node is in a closure only
  // because the unit declares it or reaches it by a call edge.
  const inClosure = (nodeId: string | undefined): boolean => Boolean(nodeId && reachable.has(nodeId));
  const seedEntryPoints = (cas.entry_points || []).filter(ep => {
    if (inClosure(ep.handler?.node_id) || inClosure(ep.source_node)) return true;
    const file = extractEntryPointFilePath(ep, nodesById);
    return Boolean(file && reachableFiles.has(file));
  });
  const seedExitPoints = (cas.exit_points || []).filter(exit => {
    if (inClosure(exit.source_node)) return true;
    const file = exitPointFile(exit, nodesById);
    return Boolean(file && reachableFiles.has(file));
  });

  const includedEntryPointIds = new Set(seedEntryPoints.map(e => e.id));
  const includedExitPointIds = new Set(seedExitPoints.map(e => e.id));
  const dataEntities = filterDataEntities(cas.data_entities, reachable);
  const includedEntityIds = new Set(dataEntities.map(e => e.id));
  const scopedFlowGraph = filterFlowGraph(cas.flow_graph, includedEntryPointIds, reachable);

  return {
    sub_cas_node_id: unitId,
    das_unit_name: deployable.name,
    root_path: deployable.root_path,
    member_root_paths: bundledMembersOf(deployable, allEvidence).map(m => m.root_path),
    seed_node_count: seedNodeIds.size,
    seed_basis: basis,
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
      system_capabilities: scopeCapabilitiesToSlice(
        filterCapabilities(cas.system_capabilities, includedEntryPointIds),
        includedEntryPointIds,
        scopedFlowGraph.flowIds,
      ),
      behavior_surfaces: scopeCapabilitiesToSlice(
        filterCapabilities(cas.behavior_surfaces, includedEntryPointIds),
        includedEntryPointIds,
        scopedFlowGraph.flowIds,
      ),
      flow_graph: scopedFlowGraph.graph,
      user_journeys: filterUserJourneys(cas.user_journeys, includedEntryPointIds),
      communication_seams: filterCommunicationSeams(cas.communication_seams, includedEntryPointIds, includedExitPointIds, includedEntityIds),
      deployable_evidence: [deployable, ...bundledMembersOf(deployable, allEvidence)],
    },
  };
}

// ---------------------------------------------------------------------------
// Duplicate-closure invariant (spec §7 addendum)
// ---------------------------------------------------------------------------

/** Two qualified units whose reachability closures overlap at least this much
 *  (intersection / smaller-closure-size) are treated as the same shipped
 *  artifact reached through two different evidence rows, never two distinct
 *  ones — evidence-based on measured graph overlap, not on name or kind, so
 *  it also catches a kind MISMATCH (e.g. a compose-service row and an
 *  unrelated bin row both closing over ~the whole repo) that a same-kind or
 *  same-root-path check alone would miss. 0.95 leaves room for the small
 *  asymmetry two independently-seeded closures of the same artifact can have
 *  (a couple of files reached via one unit's seed but not the other's) while
 *  still being far above anything two genuinely different services would
 *  share by accident. */
const DUPLICATE_CLOSURE_OVERLAP_RATIO = 0.95;

/**
 * Evidence-richness ranking for which of two overlapping units survives: a
 * concrete (non-'.') root beats a degenerate repo-root match, then more
 * boundary evidence lines, then original evidence-array order (deterministic
 * across re-runs of the same evidence list).
 */
function richerUnit(a: DeployableEvidence, b: DeployableEvidence, allEvidence: DeployableEvidence[]): DeployableEvidence {
  const aConcrete = a.root_path && a.root_path !== '.' ? 1 : 0;
  const bConcrete = b.root_path && b.root_path !== '.' ? 1 : 0;
  if (aConcrete !== bConcrete) return aConcrete > bConcrete ? a : b;
  if (a.evidence.length !== b.evidence.length) return a.evidence.length > b.evidence.length ? a : b;
  return allEvidence.indexOf(a) <= allEvidence.indexOf(b) ? a : b;
}

/**
 * The invariant the plain exclusive+shared+orphan===graph_node_count check
 * (DAS_COUNTS_NOTE) does NOT catch: it holds even when N qualified units all
 * point at ~the same nodes, because it only ever sums per-NODE attribution,
 * never counts how many *units* independently claim a node as their seed
 * basis. This pass measures pairwise closure overlap directly and collapses
 * near-total overlaps before any per-unit count is computed, so
 * qualified_unit_count and sum_of_unit_node_counts are never inflated by the
 * same artifact being counted twice (or three times) over.
 */
function collapseDuplicateClosureUnits(
  qualified: DeployableEvidence[],
  rawSlices: SubCasNodeSlice[],
): {
  qualified: DeployableEvidence[];
  rawSlices: SubCasNodeSlice[];
  duplicatesCollapsed: Array<{ dropped_id: string; dropped_name: string; kept_id: string; kept_name: string; overlap_ratio: number }>;
} {
  const closures = rawSlices.map(s => new Set(s.slice.nodes.map(n => n.id)));
  const dropped = new Set<number>();
  const duplicatesCollapsed: Array<{ dropped_id: string; dropped_name: string; kept_id: string; kept_name: string; overlap_ratio: number }> = [];

  for (let i = 0; i < qualified.length; i++) {
    if (dropped.has(i)) continue;
    for (let j = i + 1; j < qualified.length; j++) {
      if (dropped.has(j)) continue;
      const a = closures[i];
      const b = closures[j];
      const smaller = Math.min(a.size, b.size);
      if (smaller === 0) continue;
      let intersection = 0;
      const [small, large] = a.size <= b.size ? [a, b] : [b, a];
      for (const id of small) if (large.has(id)) intersection++;
      const overlapRatio = intersection / smaller;
      if (overlapRatio < DUPLICATE_CLOSURE_OVERLAP_RATIO) continue;

      const survivor = richerUnit(qualified[i], qualified[j], qualified);
      const loserIdx = survivor === qualified[i] ? j : i;
      const keptIdx = survivor === qualified[i] ? i : j;
      dropped.add(loserIdx);
      duplicatesCollapsed.push({
        dropped_id: rawSlices[loserIdx].sub_cas_node_id,
        dropped_name: qualified[loserIdx].name,
        kept_id: rawSlices[keptIdx].sub_cas_node_id,
        kept_name: qualified[keptIdx].name,
        overlap_ratio: Math.round(overlapRatio * 10000) / 10000,
      });
      if (loserIdx === i) break; // i itself was dropped; move to next i
    }
  }

  if (!dropped.size) return { qualified, rawSlices, duplicatesCollapsed: [] };

  const keptIndices = qualified.map((_, idx) => idx).filter(idx => !dropped.has(idx));
  return {
    qualified: keptIndices.map(idx => qualified[idx]),
    rawSlices: keptIndices.map(idx => rawSlices[idx]),
    duplicatesCollapsed,
  };
}

// ---------------------------------------------------------------------------
// buildDeployableAnalyses (all units + sub_cas_nodes + shared-code attribution)
// ---------------------------------------------------------------------------

/**
 * Top-level entry point: evaluate the promotion rule, and if it fires, slice
 * every tier-qualified unit plus tag cross-unit shared code (spec §2.2) and
 * build the rollup `sub_cas_nodes` (spec §3's "the list of sub-CAS-node
 * ids/names/tiers/boundary evidence itself"). Returns `promoted: false` with
 * empty arrays for the common single-deployable case — never a synthesized
 * one-entry unit list.
 */
export function buildDeployableAnalyses(cas: CASOutput): BuildDeployableAnalysesResult {
  const allEvidence = cas.deployable_evidence || [];
  let qualified = tierQualifiedShipUnits(allEvidence);

  if (qualified.length < PROMOTION_THRESHOLD) {
    return {
      promoted: false,
      sub_cas_nodes: {
        promoted: false,
        units: [],
        qualified_unit_count: qualified.length,
        promotion_threshold: PROMOTION_THRESHOLD,
        reason: qualified.length === 0
          ? 'No tier-qualified ship unit found: no deployable_evidence row declares a ship or build artifact of its own.'
          : `${qualified.length} tier-qualified ship unit found (${qualified.map(u => u.name).join(', ')}) — below the promotion threshold of ${PROMOTION_THRESHOLD}, so this CAS is its own single deployable and needs no per-unit slicing. Coverage and orphan counts describe slices and are therefore zero here, not "nothing found".`,
        graph_node_count: (cas.nodes || []).length,
        covered_node_count: 0,
        coverage_ratio: 0,
        exclusive_node_count: 0,
        shared_node_count: 0,
        sum_of_unit_node_counts: 0,
        orphan_node_count: 0,
        orphan_node_ids: [],
        counts_note: DAS_COUNTS_NOTE,
        duplicate_units_collapsed: [],
        orphan_node_id_duplicate_count: 0,
      },
      units: [],
    };
  }

  const allRoots = buildDeployableRoots(allEvidence);

  // Slice every unit once (reachability closure), then compute shared
  // attribution across all of them, then re-tag each slice's nodes.
  const rawSlicesBeforeDedup = qualified.map(unit => sliceDeployableAnalysis(cas, unit));

  const { qualified: qualifiedDeduped, rawSlices, duplicatesCollapsed } =
    collapseDuplicateClosureUnits(qualified, rawSlicesBeforeDedup);
  qualified = qualifiedDeduped;

  // The dedup pass can itself take a CAS below the promotion threshold (three
  // evidence rows all describing one artifact collapse to one unit) — spec §1
  // still applies after collapsing: a single real deployable must not promote,
  // even though the RAW evidence count looked like >= 2 before dedup.
  if (qualified.length < PROMOTION_THRESHOLD) {
    const collapsedNote = duplicatesCollapsed.length
      ? ` (collapsed ${duplicatesCollapsed.length} duplicate-closure unit(s) that were the same shipped artifact counted more than once: ${duplicatesCollapsed.map(d => `"${d.dropped_name}" -> "${d.kept_name}"`).join(', ')})`
      : '';
    return {
      promoted: false,
      sub_cas_nodes: {
        promoted: false,
        units: [],
        qualified_unit_count: qualified.length,
        promotion_threshold: PROMOTION_THRESHOLD,
        reason: `${qualified.length} tier-qualified ship unit found after duplicate-closure collapse — below the promotion threshold of ${PROMOTION_THRESHOLD}, so this CAS is its own single deployable and needs no per-unit slicing.${collapsedNote}`,
        graph_node_count: (cas.nodes || []).length,
        covered_node_count: 0,
        coverage_ratio: 0,
        exclusive_node_count: 0,
        shared_node_count: 0,
        sum_of_unit_node_counts: 0,
        orphan_node_count: 0,
        orphan_node_ids: [],
        counts_note: DAS_COUNTS_NOTE,
        duplicate_units_collapsed: duplicatesCollapsed,
        orphan_node_id_duplicate_count: 0,
      },
      units: [],
    };
  }

  const unitsReachability: UnitReachability[] = qualified.map((unit, i) => ({
    index: i,
    id: rawSlices[i].sub_cas_node_id,
    name: unit.name,
    reachable: new Set(rawSlices[i].slice.nodes.map(n => n.id)),
  }));

  const rootsWithOwner = qualified.map((unit, i) => {
    const idx = allEvidence.indexOf(unit);
    return { root: allRoots[idx], unitIndex: i };
  }).filter((r): r is { root: DeployableRoot; unitIndex: number } => Boolean(r.root));

  const attribution = computeAttribution(cas.nodes, unitsReachability, rootsWithOwner);

  const units: SubCasNodeSlice[] = rawSlices.map((raw, i) => {
    const thisUnitId = unitsReachability[i].id;
    const nodes = raw.slice.nodes.map(n => {
      const info = attribution.get(n.id);
      if (!info || info.attribution !== 'shared') return n;
      const isOwner = info.canonicalOwnerId === thisUnitId;
      const taggedMetadata: Record<string, unknown> = {
        ...n.metadata,
        attribution: (isOwner ? 'owned' : 'shared') as SubCasNodeAttribution,
        ...(isOwner
          ? { also_used_by: info.alsoUsedBy }
          : { canonical_owner_sub_cas_node_id: info.canonicalOwnerId }),
      };
      return {
        ...n,
        metadata: taggedMetadata as unknown as CASNode['metadata'],
      };
    });
    return { ...raw, slice: { ...raw.slice, nodes } };
  });

  // Honest counts (spec §7): every node reached by no unit at all is an
  // orphan — reported, never silently dropped from the total — and the overlap
  // between units is reported as overlap instead of being left implicit in
  // per-unit totals that sum past the graph.
  const reachedAnywhere = new Set<string>();
  for (const u of unitsReachability) for (const id of u.reachable) reachedAnywhere.add(id);
  const rawOrphanIds = (cas.nodes || []).filter(n => !reachedAnywhere.has(n.id)).map(n => n.id);
  const orphanIds = [...new Set(rawOrphanIds)];
  // A non-zero gap here means the parent CAS's node list itself contains two+
  // node objects sharing one id — the underlying bug is upstream (graph
  // construction), not in this counting pass, but it must not be allowed to
  // silently disappear as "the same orphan id reported three times".
  const orphanNodeIdDuplicateCount = rawOrphanIds.length - orphanIds.length;

  const perUnitCounts = unitsReachability.map(() => ({ exclusive: 0, shared: 0, ownedShared: 0 }));
  let exclusiveTotal = 0;
  let sharedTotal = 0;
  for (const [, info] of attribution) {
    if (info.attribution === 'exclusive') {
      exclusiveTotal += 1;
      perUnitCounts[info.canonicalOwnerIndex].exclusive += 1;
      continue;
    }
    sharedTotal += 1;
    perUnitCounts[info.canonicalOwnerIndex].ownedShared += 1;
  }
  for (const u of unitsReachability) {
    for (const id of u.reachable) {
      if (attribution.get(id)?.attribution === 'shared') perUnitCounts[u.index].shared += 1;
    }
  }

  const graphNodeCount = (cas.nodes || []).length;
  const coveredNodeCount = reachedAnywhere.size;
  const sumOfUnitNodeCounts = units.reduce((sum, u) => sum + u.slice.nodes.length, 0);

  const sub_cas_nodes: SubCasNodeIndex = {
    promoted: true,
    units: qualified.map((unit, i) => ({
      id: unitsReachability[i].id,
      name: unit.name,
      root_path: unit.root_path,
      member_root_paths: bundledMembersOf(unit, allEvidence).map(m => m.root_path),
      tier: unit.tier,
      kind: unit.kind,
      node_count: units[i].slice.nodes.length,
      exclusive_node_count: perUnitCounts[i].exclusive,
      shared_node_count: perUnitCounts[i].shared,
      owned_shared_node_count: perUnitCounts[i].ownedShared,
      entry_point_count: (units[i].slice.entry_points || []).length,
      exit_point_count: (units[i].slice.exit_points || []).length,
      seed_node_count: units[i].seed_node_count,
      seed_basis: units[i].seed_basis,
      boundary_evidence: unit.evidence,
    })),
    qualified_unit_count: qualified.length,
    promotion_threshold: PROMOTION_THRESHOLD,
    reason: `${qualified.length} tier-qualified ship units resolved (>= ${PROMOTION_THRESHOLD}), so this CAS has promoted sub-CAS nodes.`
      + (duplicatesCollapsed.length
        ? ` (collapsed ${duplicatesCollapsed.length} duplicate-closure unit(s) before counting: ${duplicatesCollapsed.map(d => `"${d.dropped_name}" -> "${d.kept_name}"`).join(', ')})`
        : ''),
    graph_node_count: graphNodeCount,
    covered_node_count: coveredNodeCount,
    coverage_ratio: graphNodeCount === 0 ? 0 : Math.round((coveredNodeCount / graphNodeCount) * 10000) / 10000,
    exclusive_node_count: exclusiveTotal,
    shared_node_count: sharedTotal,
    sum_of_unit_node_counts: sumOfUnitNodeCounts,
    orphan_node_count: orphanIds.length,
    orphan_node_ids: orphanIds.slice(0, 50),
    counts_note: DAS_COUNTS_NOTE,
    duplicate_units_collapsed: duplicatesCollapsed,
    orphan_node_id_duplicate_count: orphanNodeIdDuplicateCount,
  };

  return { promoted: true, sub_cas_nodes, units };
}

// ---------------------------------------------------------------------------
// §6 — Retrieval
// ---------------------------------------------------------------------------

/**
 * Resolve a `{ sub_cas_node_id }` scope against a CAS: recomputes
 * `buildDeployableAnalyses` (phase-1 recompute-on-request storage posture,
 * see the module doc comment) and returns the matching unit's slice, or
 * `undefined` when the CAS hasn't promoted or the id doesn't match any
 * current unit (a caller should treat that as "this scope no longer exists",
 * e.g. after a demotion — spec §5/§7's reportable-demotion rule, surfaced by
 * the caller comparing against the previous sub_cas_nodes, not by this
 * function, which is a pure lookup).
 */
export function resolveSubCasNodeScope(cas: CASOutput, subCasNodeId: string): SubCasNodeSlice | undefined {
  const { units } = buildDeployableAnalyses(cas);
  return units.find(u => u.sub_cas_node_id === subCasNodeId);
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
 * lifetime cheap without introducing a stored sub-CAS-node artifact. Keyed on
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

export interface SubCasNodeScopeParam {
  sub_cas_node_id: string;
}

/**
 * Resolves an optional scope: { sub_cas_node_id } against a repo-level CAS (spec
 * §6). Returns the parent cas unchanged when scope is omitted. When given,
 * returns a CASOutput-shaped object with the sub-CAS node's sliced fields
 * overlaid on the parent CAS — repo-rollup-only facts with no unit-scoped
 * meaning pass through unchanged, so counts/nodes/entries reflect the unit,
 * never the rollup. Throws (never a silent empty result) when the CAS hasn't
 * promoted, or when sub_cas_node_id doesn't match any current unit — naming the
 * ids that do exist.
 */
export function scopeCasToSubCasNode(cas: CASOutput, scope: SubCasNodeScopeParam | undefined): CASOutput {
  if (!scope) return cas;
  const { promoted, sub_cas_nodes, units } = getCachedDeployableAnalyses(cas);
  if (!promoted) {
    throw new Error(
      'This analysis has not promoted any sub-CAS nodes (it resolves fewer than 2 tier-qualified ship units), so scope.sub_cas_node_id does not apply. Omit scope to query the whole repo.'
    );
  }
  const unit = units.find(u => u.sub_cas_node_id === scope.sub_cas_node_id);
  if (!unit) {
    const available = sub_cas_nodes.units.map(u => `${u.id} (${u.name})`).join(', ') || 'none';
    throw new Error(`Unknown scope.sub_cas_node_id '${scope.sub_cas_node_id}'. Available sub-CAS-node units for this analysis: ${available}.`);
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
