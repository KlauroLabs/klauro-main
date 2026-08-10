import * as path from 'path';
import type { CASEntryPoint, CASExitPoint, CASNode, CASOutput, DeployableEvidence } from '../../types/cas.types';
import { getProviders } from './deployable-evidence/registry';
import type { EvidenceCollectionContext, EvidenceProvider } from './deployable-evidence/types';
import { UNNAMED_SERVICE_PLACEHOLDER } from './deployable-evidence/util';

export type { EvidenceCollectionContext, EvidenceProvider };
export type { DeployableEvidence };

/**
 * Deployable Evidence Collector
 *
 * Composes a per-artifact "what can actually be deployed/run/shipped" fact
 * list from evidence ALREADY extracted by other analyzers (container topology,
 * distribution artifacts) plus a small amount of direct manifest/CI reading
 * that no existing analyzer covers. It does not re-parse Dockerfiles, compose
 * files, or k8s manifests — it reads the CASNode/CASEntryPoint/CASExitPoint
 * metadata those analyzers already produced.
 *
 * Extensible via a pluggable EvidenceProvider registry
 * (./deployable-evidence/registry.ts) — each provider owns one ecosystem or
 * concern (container topology, installers, CI deploy jobs, bin targets,
 * package manifests, ...). To add a new ecosystem, drop a new
 * `providers/<eco>.ts` exporting an EvidenceProvider and register it via
 * registerProvider() (or add it to BUILTIN_PROVIDERS for built-in status).
 *
 * Tiers:
 *  1. ship declaration    - Dockerfiles, compose services, k8s manifests,
 *                           installers/desktop-entries/service-units, CI
 *                           deploy jobs. These declare "this gets shipped".
 *  2. runnable entry      - bin targets (Cargo [[bin]], package.json bin,
 *                           go main packages, src/bin/*) and server-bootstrap
 *                           / port-binding entry points already flagged by the
 *                           framework analyzers (CASEntryPoint type === 'http').
 *  3. package identity    - package.json / Cargo.toml / go.mod as the
 *                           publishable/installable unit identity.
 *
 * Consumed downstream via CASOutput.deployable_evidence (see cas.types.ts).
 */

export interface CollectDeployableEvidenceInput {
  projectPath: string;
  nodes: CASNode[];
  entryPoints: CASEntryPoint[];
  exitPoints: CASExitPoint[];
  /** Real display name distinct from a hash workspace basename (see EvidenceCollectionContext.displayName). */
  displayName?: string;
}

export function collectDeployableEvidence(input: CollectDeployableEvidenceInput): DeployableEvidence[] {
  const { projectPath, nodes, entryPoints, exitPoints, displayName } = input;

  const cas: Partial<CASOutput> = {
    nodes,
    entry_points: entryPoints,
    exit_points: exitPoints,
  };
  const ctx: EvidenceCollectionContext = { cas, projectPath, nodes, exitPoints, displayName };

  const results: DeployableEvidence[] = [];
  for (const provider of getProviders()) {
    try {
      results.push(...provider.collect(ctx));
    } catch (error) {
      // Providers must be pure and swallow their own errors; this catch is a
      // last-resort safety net so one broken/future ecosystem provider can
      // never take down the whole collection pass.
      // eslint-disable-next-line no-console
      console.error(`[deployable-evidence] provider "${provider.id}" threw:`, error);
    }
  }

  const deduped = dedupe(results, projectPath);
  const consolidated = mergeDuplicateNamedInstallerLeaves(deduped);
  // Compose<->container identity join must run BEFORE the ships_paths
  // bundling pass: a real service is currently three unmerged rows (compose-
  // service, container, bin), and folding compose+container into ONE Tier-1
  // row first gives the bin-bundling pass below a single strong unit to
  // match against, instead of two weaker/duplicate ones.
  const composeAndContainerJoined = joinComposeAndContainerUnits(consolidated);
  // Same-kind Tier-1 rows declaring the identical service name (a dev/prod
  // compose split, an override manifest, a duplicated k8s file) are the same
  // logical ship unit, not two — collapse them before build-stage
  // classification so neither survivor nor `qualified_unit_count` double-count.
  const joined = mergeSameNamedTier1Rows(composeAndContainerJoined);
  // Build-infra Dockerfiles (base images other Dockerfiles FROM, and
  // multi-stage "build only" builder images) are demoted/excluded next, so
  // their ships_paths never participate in the bundling pass below as if
  // they were a real ship unit.
  const classified = classifyBuildStageContainers(joined);
  // Same-binary packaging variants (e.g. an alpine-base and a distroless-base
  // Dockerfile both shipping the identical entrypoint binary) collapse to one
  // Tier-1 unit before bundling resolution runs, so downstream consumers
  // (tierQualifiedShipUnits, determineSystemType's topLevelShipUnits) never
  // see them as distinct deployables.
  const collapsed = collapseWholeRepoPackagingVariants(collapseContainerVariants(classified));
  resolveEvidenceBundling(collapsed);
  // Re-point any bin/server-entry candidate at a REAL joined service unit
  // (compose-service/container/k8s) when one matches by identity, even when
  // resolveEvidenceBundling already bundled it into a weaker installer unit
  // (e.g. an installer whose product-name resolution failed and fell back
  // to "unnamed-service") — real service identity always wins.
  rebundleBinsIntoServiceUnits(collapsed);
  return collapsed;
}

function canonicalEvidenceRoot(projectPath: string, rootPath: string): string {
  const normalized = rootPath.replace(/\\/g, '/').replace(/\/$/, '') || '.';
  if (!path.isAbsolute(normalized)) return normalized.replace(/^\.\//, '') || '.';
  const relative = path.relative(projectPath, normalized).replace(/\\/g, '/');
  return relative && !relative.startsWith('../') && !path.isAbsolute(relative) ? relative : normalized;
}

function dedupe(items: DeployableEvidence[], projectPath: string): DeployableEvidence[] {
  const byIdentity = new Map<string, DeployableEvidence>();
  const out: DeployableEvidence[] = [];
  for (const item of items) {
    const canonicalRoot = canonicalEvidenceRoot(projectPath, item.root_path);
    const key = `${item.tier}::${item.kind}::${canonicalRoot}::${item.name}`;
    const existing = byIdentity.get(key);
    if (existing) {
      existing.evidence = [...new Set([...existing.evidence, ...item.evidence])];
      existing.ships_paths = unionOptional(existing.ships_paths, item.ships_paths);
      existing.ports = unionOptional(existing.ports, item.ports);
      existing.base_images = unionOptional(existing.base_images, item.base_images);
      existing.entrypoint_member ||= item.entrypoint_member;
      existing.bundled_into ||= item.bundled_into;
      continue;
    }
    item.root_path = canonicalRoot;
    byIdentity.set(key, item);
    out.push(item);
  }
  return out;
}

function unionOptional<T>(left: T[] | undefined, right: T[] | undefined): T[] | undefined {
  const values = [...new Set([...(left || []), ...(right || [])])];
  return values.length > 0 ? values : undefined;
}

/** Normalizes a bundle-member token for comparison (case/whitespace/separator/
 *  extension only — MATCHING purposes only, never used for a display name).
 *  Separators are stripped entirely (not just canonicalized to one form) so a
 *  ships_paths entry like "client-service" matches a candidate named
 *  "client_service", "Client Service", OR the squashed "clientservice" — real
 *  packaging scripts and installer manifests frequently rewrite a crate/bin's
 *  hyphenated name into a squashed identifier (env var / NSIS section name /
 *  shell-safe token) with no separator at all, and a normalization that only
 *  canonicalizes separators (case/whitespace/hyphen/underscore -> one form)
 *  still fails that squashed-vs-hyphenated comparison (2026-07 hosted defect:
 *  a Cargo bin named "drop-server" and an installer-declared binary name
 *  "dropserver" never matched, so the same logical service surfaced twice —
 *  once via bin-targets, once as an unbundled installer/script-derived twin).
 *  A trailing ship-artifact extension (.exe/.msi/.dmg/...) is stripped too:
 *  it identifies which PLATFORM artifact ships (kept in installer.ts's own
 *  identity key), not which BINARY/service it is, so it must never block a
 *  member-name match. */
function normalizeMemberToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.(exe|msi|dmg|pkg|deb|rpm|appimage)$/i, '')
    .replace(/[\s_-]+/g, '');
}

/** Does a Tier-1 `ships_paths` entry (a bin/crate/service name a
 *  Dockerfile/installer/CI-deploy artifact actually builds/COPYs/bundles)
 *  name this Tier-2/3 candidate? Matched by the candidate's resolved `name`
 *  OR its root folder's basename — a Cargo bin CRATE's folder name and its
 *  compiled BINARY name frequently differ (e.g. folder `bin/client-service`,
 *  `[[bin]] name = "daemon"`), and ships_paths always names the real
 *  compiled artifact, so both must be checked. */
function evidenceNameMatchesShippedToken(shipped: string, candidate: DeployableEvidence): boolean {
  const norm = normalizeMemberToken(shipped);
  if (!norm) return false;
  if (normalizeMemberToken(candidate.name) === norm) return true;
  const rootBase = (candidate.root_path || '').split(/[\\/]/).filter(Boolean).pop() || '';
  if (rootBase && normalizeMemberToken(rootBase) === norm) return true;
  return false;
}

/**
 * A Tier-1 "installer" row is a genuine multi-service ship-unit HEAD only
 * when its `ships_paths` names two or more distinct members — that's real
 * positive bundling evidence (SPEC-DEPLOYABLE-DETECTION.md §3/§4). A Tier-1
 * installer row with zero or one `ships_paths` entries is instead a "leaf"
 * identity declaration (a per-component installer-script node, an NSIS
 * Section/File directive, a single-binary artifact record) that names
 * exactly ONE thing — the same thing another provider (bin-targets, most
 * commonly) already produced a concrete row for. Real repos never need two
 * top-level rows for one crate/service; the leaf is redundant, not additive.
 */
function isInstallerBundleHead(item: DeployableEvidence): boolean {
  return item.tier === 1 && item.kind === 'installer' && (item.ships_paths?.length ?? 0) >= 2;
}

/**
 * Merges duplicate-named Tier-1 installer LEAVES (see isInstallerBundleHead)
 * into whichever OTHER row already names the exact same identity (matched via
 * normalizeMemberToken — case/separator/extension-insensitive), rather than
 * letting both stand as separate top-level rows. This is the fix for a real
 * hosted defect (2026-07, Rust cargo-workspace repo with shell + NSIS
 * installers): a crate compiled via Cargo `[[bin]]` (e.g. "drop-server")
 * surfaced TWICE — once as the concrete bin-targets row, once as an unbundled
 * installer-derived row naming the identical service under a squashed/
 * hyphen-stripped variant ("dropserver") or, for names with no hyphen at all,
 * an EXACT duplicate ("client" appearing as both a `kind: 'bin'` row and a
 * `kind: 'installer'` row).
 *
 * Evidence-gated, never name-similarity-gated: the merge fires ONLY on an
 * exact normalized-identity match between the leaf and another row — never on
 * fuzzy/partial name similarity — and a leaf that matches nothing keeps
 * standing alone (the SPEC's "never merge on absence of evidence" rule
 * applies here too: no match found means no merge performed).
 *
 * Survivor selection prefers concrete runnable-entry evidence over an
 * installer leaf's identity-only evidence ("the cargo/bin evidence — the
 * strongest tier — wins as the surviving row"): a `kind: 'bin'` or
 * `kind: 'server-entry'` row always wins over a `kind: 'installer'` leaf;
 * between two installer leaves, the one with more accumulated evidence wins
 * (a tie-break only, since both name the same thing either way). The merged
 * survivor keeps its own tier/kind/name — only the leaf's evidence and
 * ships_paths are unioned in — so downstream consumers see one row per
 * logical service, still eligible to `bundled_into` a real multi-member
 * installer head via the normal resolveEvidenceBundling pass below.
 */
function mergeDuplicateNamedInstallerLeaves(items: DeployableEvidence[]): DeployableEvidence[] {
  const heads = new Set(items.filter(isInstallerBundleHead));
  const leaves = items.filter(item => item.tier === 1 && item.kind === 'installer' && !heads.has(item));
  if (!leaves.length) return items;

  const removed = new Set<DeployableEvidence>();

  const survivorRank = (item: DeployableEvidence): number => {
    if (item.kind === 'bin') return 0;
    if (item.kind === 'server-entry') return 1;
    return 2; // another installer leaf — tie-break by evidence richness only
  };

  for (const leaf of leaves) {
    if (removed.has(leaf)) continue;
    const leafKey = normalizeMemberToken(leaf.name);
    if (!leafKey) continue;

    let bestMatch: DeployableEvidence | undefined;
    for (const other of items) {
      if (other === leaf || removed.has(other) || heads.has(other)) continue;
      if (normalizeMemberToken(other.name) !== leafKey) continue;
      if (!bestMatch) { bestMatch = other; continue; }
      const otherRank = survivorRank(other);
      const bestRank = survivorRank(bestMatch);
      if (otherRank < bestRank) { bestMatch = other; continue; }
      if (otherRank === bestRank && other.evidence.length > bestMatch.evidence.length) bestMatch = other;
    }
    if (!bestMatch) continue; // matches nothing — never merge on absence of evidence

    // The leaf itself may outrank the match it found (e.g. two installer
    // leaves, this one richer) — merge into whichever of the two survives.
    const survivor = survivorRank(bestMatch) <= survivorRank(leaf) ? bestMatch : leaf;
    const loser = survivor === bestMatch ? leaf : bestMatch;

    survivor.evidence = [...new Set([...survivor.evidence, ...loser.evidence, `merged-duplicate-identity:${loser.kind}:${loser.name}`])];
    survivor.ships_paths = [...new Set([...(survivor.ships_paths || []), ...(loser.ships_paths || [])])];
    removed.add(loser);
  }

  return removed.size ? items.filter(item => !removed.has(item)) : items;
}

/**
 * Evidence-gated bundling resolution (SPEC-DEPLOYABLE-DETECTION.md §3/§4:
 * "multiple runnable entries can be MEMBERS of one ship unit... evidence-
 * gated merge... never merge on absence alone"). Cross-references every
 * Tier-1 row's `ships_paths` (positive bundling evidence: what a
 * Dockerfile/installer-script/CI-deploy artifact actually builds/COPYs/
 * bundles — populated by container.ts's parseDockerfileMembers and
 * installer.ts's cargo/cp-target parsing) against every OTHER Tier-2/3 row.
 * A match sets `bundled_into` on the Tier-2/3 row to the Tier-1 unit's
 * `name`, so a single-codebase `deployable_evidence` result already carries
 * membership without requiring the multi-repo workspace resolver
 * (apps/mcp-server/src/cross-codebase-analysis.ts's resolveDeployables
 * performs the equivalent resolution again downstream on SystemApplication,
 * for the cross-codebase/workspace case — this is the analyzer-core-level
 * counterpart so a plain single-project analysis carries the same signal).
 * Never merges on absence of evidence: a Tier-2/3 row with no ships_paths
 * entry referencing it keeps `bundled_into` unset and stays a standalone
 * candidate, exactly per the spec's negative acceptance case.
 */
function resolveEvidenceBundling(items: DeployableEvidence[]): void {
  const tier1WithMembers = items.filter(item => item.tier === 1 && (item.ships_paths?.length ?? 0) > 0);
  if (!tier1WithMembers.length) return;

  for (const candidate of items) {
    if (candidate.tier === 1) continue; // only Tier-2/3 candidates merge into a ship unit
    if (candidate.bundled_into) continue;

    for (const unit of tier1WithMembers) {
      if (unit === candidate) continue;
      const hit = (unit.ships_paths || []).find(shipped => evidenceNameMatchesShippedToken(shipped, candidate));
      if (!hit) continue;
      candidate.bundled_into = unit.name;
      candidate.evidence = [
        ...new Set([...candidate.evidence, `bundled-into:${unit.name}`, `positive-bundling-evidence:ships_paths:${hit}`]),
      ];
      break;
    }
  }
}

/** Strips a registry host + tag/digest off an image reference and returns
 *  just the final path segment — `registry.example.com/team/acme-base:1.2`
 *  -> `acme-base`. Matching input for normalizeMemberToken, never a display
 *  name. */
function stripImageTagAndRegistry(ref: string): string {
  const withoutDigest = ref.split('@')[0];
  const withoutTag = withoutDigest.includes(':') ? withoutDigest.split(':')[0] : withoutDigest;
  const segments = withoutTag.split('/').filter(Boolean);
  return segments[segments.length - 1] || withoutTag;
}

/** Does this Tier-1 unit's ENTRYPOINT/CMD-derived member name agree with
 *  `name`? Real corroboration signal for the compose<->container join and
 *  the bin->service rebundling pass below — not name-similarity, an actual
 *  extracted runtime fact (container.ts's parseDockerfileMembers). */
function entrypointTokenMatchesName(entrypointMember: string | undefined, name: string): boolean {
  if (!entrypointMember || !name) return false;
  return normalizeMemberToken(path.basename(entrypointMember)) === normalizeMemberToken(name);
}

/** Does `containerRootPath` live inside (or at) `composeRootPath`? A compose
 *  service's `build:` context is the operator-facing boundary; a Dockerfile
 *  the compose file actually builds commonly lives in a subdirectory of that
 *  context (e.g. `docker/Client.Dockerfile` under a root build context) —
 *  real structural corroboration for the identity join below, independent of
 *  naming. `path.relative` starting with `..` means containerRootPath is
 *  OUTSIDE composeRootPath's tree. */
function isDockerfileWithinBuildContext(composeRootPath: string, containerRootPath: string): boolean {
  const rel = path.relative(composeRootPath || '.', containerRootPath || '.');
  return !path.isAbsolute(rel) && !rel.startsWith('..');
}

/**
 * Joins a compose-service Tier-1 row with the container Tier-1 row for the
 * SAME Dockerfile it builds. Real hosted defect (2026-07, compose-based Rust
 * workspace, v1.0.112): every service surfaced as an UNMERGED trio — a
 * `compose-service` row, a `container` row (from the Dockerfile the service
 * builds), and a `bin` row (the Cargo crate it runs) — instead of one Tier-1
 * ship unit. This join folds the first two together (the bin join is
 * `rebundleBinsIntoServiceUnits` below).
 *
 * Evidence-gated, never name-only: normalized-name equality between the
 * compose service name and the container's derived name (via
 * `normalizeMemberToken` — hyphen/case/separator-insensitive, so
 * `drop-server` <-> `dropserver` still match) is REQUIRED, but two unrelated
 * services could coincidentally share a name, so a second, structural
 * corroboration signal must ALSO agree: either the Dockerfile physically
 * lives inside the compose service's own build-context directory
 * (`isDockerfileWithinBuildContext`), or the Dockerfile's own ENTRYPOINT/CMD
 * names the same service (`entrypointTokenMatchesName`). Neither signal
 * alone is name-similarity — both are facts already extracted elsewhere
 * (compose `build:` context, container.ts's Dockerfile ENTRYPOINT/CMD
 * parse).
 *
 * Survivor is the compose-service row — the operator-facing name/definition
 * — with the container's evidence, ships_paths, ports, entrypoint_member and
 * base_images folded in; the container row is removed. A compose service
 * with no matching container (or a container matching nothing) is left
 * untouched (never merge on absence of evidence).
 */
function joinComposeAndContainerUnits(items: DeployableEvidence[]): DeployableEvidence[] {
  const composeRows = items.filter(item => item.tier === 1 && item.kind === 'compose-service');
  const containerRows = items.filter(item => item.tier === 1 && item.kind === 'container');
  if (!composeRows.length || !containerRows.length) return items;

  const merged = new Set<DeployableEvidence>();

  for (const compose of composeRows) {
    const composeKey = normalizeMemberToken(compose.name);
    if (!composeKey) continue;

    const match = containerRows.find(container => {
      if (merged.has(container)) return false;
      const pathAgrees = isDockerfileWithinBuildContext(compose.root_path, container.root_path);
      const entrypointAgrees = entrypointTokenMatchesName(container.entrypoint_member, compose.name);
      // A container row carrying the UNNAMED_SERVICE_PLACEHOLDER has, by
      // construction, no name evidence at all (safeDeployableName emits it
      // precisely when every real naming signal — dir basename, service
      // alias, display name — was unavailable or hash-shaped). Requiring
      // name-equality against a sentinel that carries zero identity is
      // vacuous and blocks the join on exactly the repos where a root
      // Dockerfile's own name resolution is weakest but a sibling
      // compose-service row already names the real service — structural
      // corroboration (build-context containment or entrypoint identity)
      // alone is sufficient evidence in that case.
      if (container.name === UNNAMED_SERVICE_PLACEHOLDER) {
        return pathAgrees || entrypointAgrees;
      }
      if (normalizeMemberToken(container.name) !== composeKey) return false;
      return pathAgrees || entrypointAgrees;
    });
    if (!match) continue;

    compose.evidence = [...new Set([...compose.evidence, ...match.evidence, `merged-container-identity:${match.name}`])];
    const unionShipsPaths = [...new Set([...(compose.ships_paths || []), ...(match.ships_paths || [])])];
    compose.ships_paths = unionShipsPaths.length ? unionShipsPaths : undefined;
    if (!compose.entrypoint_member && match.entrypoint_member) compose.entrypoint_member = match.entrypoint_member;
    const unionBaseImages = [...new Set([...(compose.base_images || []), ...(match.base_images || [])])];
    compose.base_images = unionBaseImages.length ? unionBaseImages : undefined;
    const unionPorts = [...new Set([...(compose.ports || []), ...(match.ports || [])])];
    compose.ports = unionPorts.length ? unionPorts : undefined;
    merged.add(match);
  }

  return merged.size ? items.filter(item => !merged.has(item)) : items;
}

/**
 * Collapses Tier-1 rows of the SAME kind that declare the IDENTICAL service
 * name into one ship unit. Real hosted defect (2026-08): a repo with two
 * compose files (a root `docker-compose.yml` and a
 * `infra/deploy/docker-compose.yml` override/deploy manifest) each declaring
 * a `build:`-carrying service named "kontinuum" produced TWO Tier-1
 * compose-service rows — `das:compose-service:root:kontinuum` and
 * `das:compose-service:deploy:kontinuum` — because dedupe() keys on
 * `tier::kind::root_path::name` and the two manifests resolve different
 * root_paths for the same logical service. Two independently-built Tier-1
 * ship declarations of the SAME kind sharing the exact same declared service
 * name is not realistic evidence of two distinct deployables (a repo does not
 * ship two unrelated services both named "kontinuum") — it is the same
 * service declared more than once (a dev/prod compose split, an override
 * file, a duplicated k8s manifest). Runs once per kind, keeping the richest
 * row (most ships_paths union already applied via evidence, then most
 * evidence lines, then array order for determinism) as the survivor and
 * unioning the rest's evidence/ships_paths/ports/base_images into it — same
 * merge shape as `dedupeBuildTargetIdentities` below, generalized to Tier-1.
 */
function mergeSameNamedTier1Rows(items: DeployableEvidence[]): DeployableEvidence[] {
  const groups = new Map<string, DeployableEvidence[]>();
  const passthrough: DeployableEvidence[] = [];
  for (const item of items) {
    if (item.tier !== 1 || item.name === UNNAMED_SERVICE_PLACEHOLDER) {
      passthrough.push(item);
      continue;
    }
    const key = `${item.kind}::${normalizeMemberToken(item.name)}`;
    if (!key || normalizeMemberToken(item.name) === '') {
      passthrough.push(item);
      continue;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }

  const out: DeployableEvidence[] = [...passthrough];
  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }
    const ranked = [...group].sort((a, b) => {
      const evidenceDiff = b.evidence.length - a.evidence.length;
      if (evidenceDiff !== 0) return evidenceDiff;
      return items.indexOf(a) - items.indexOf(b);
    });
    const [survivor, ...rest] = ranked;
    for (const dupe of rest) {
      survivor.evidence = [...new Set([...survivor.evidence, ...dupe.evidence, `merged-same-name-tier1:${dupe.kind}:${dupe.root_path}`])];
      survivor.ships_paths = unionOptional(survivor.ships_paths, dupe.ships_paths);
      survivor.ports = unionOptional(survivor.ports, dupe.ports);
      survivor.base_images = unionOptional(survivor.base_images, dupe.base_images);
      survivor.entrypoint_member ||= dupe.entrypoint_member;
    }
    out.push(survivor);
  }
  return out.sort((a, b) => items.indexOf(a) - items.indexOf(b));
}

/**
 * Demotes/excludes BUILD-INFRA Dockerfiles from the Tier-1 ship-unit list. A
 * Dockerfile that never runs anything itself (no ENTRYPOINT/CMD evidence —
 * `hasRuntimeEntrypoint` below) and is either:
 *  (a) the FROM base another Dockerfile in this same repo builds on top of
 *      (`usedAsBaseElsewhere` — cross-references every OTHER container row's
 *      structured `base_images` field, never a keyword/name heuristic), or
 *  (b) a multi-stage "build only, copy the binaries out" builder image
 *      (`isBuilderShape` — multiple FROM stages AND multiple built/copied
 *      members AND no primary entrypoint of its own)
 * is plumbing FOR other ship units, never an independent one of its own
 * (SPEC-DEPLOYABLE-DETECTION.md: "a deployable is an independent SHIP/RUN
 * artifact"). Real hosted shape (2026-07): a `Base.Dockerfile` (FROM debian,
 * no entrypoint, every other service Dockerfile FROMs it) and a
 * `BuildBinaries.Dockerfile` (FROM rust + scratch, builds/copies multiple
 * services' binaries, no runtime entrypoint) both surfaced as junk Tier-1
 * "deployables" alongside the real services.
 *
 * A container WITH its own entrypoint/cmd is NEVER touched by either
 * check — only the plumbing-shaped rows above. When demoted, the row is
 * kept at Tier-3 kind `build-image` (a citation, not a ship unit) IF its own
 * evidence positively names the unit(s) it builds for (its `ships_paths`);
 * a bare FROM-base row with no build output of its own names nothing beyond
 * itself and is dropped outright rather than kept as an unexplained row.
 */
function classifyBuildStageContainers(items: DeployableEvidence[]): DeployableEvidence[] {
  const containers = items.filter(item => item.tier === 1 && item.kind === 'container');
  if (!containers.length) return items;

  // Cross-reference set for "is this a FROM base for something else": every
  // Tier-1 row carrying `base_images`, not just rows still shaped `kind:
  // 'container'` — joinComposeAndContainerUnits (above) already folded a
  // real service's own container row into its compose-service row by this
  // point, moving that base_images evidence onto the compose-service-kind
  // survivor. Restricting this lookup to `containers` would blind the check
  // to every already-joined service, since none of them are `kind:
  // 'container'` anymore.
  const baseImageSources = items.filter(item => item.tier === 1 && (item.base_images?.length ?? 0) > 0);

  // A "runtime entrypoint" means the Dockerfile's own ENTRYPOINT/CMD resolves
  // to a REAL shipped product binary (`entrypoint_member` — see
  // parseDockerfileMembers/isRealMemberToken in container.ts, which already
  // excludes scripts/manifests/data files from that resolution). The former
  // second disjunct here — "any evidence line merely starts with
  // 'entrypoint/cmd:'" — accepted ANY ENTRYPOINT/CMD text verbatim, script or
  // not, which defeated that filtering: a packaging Dockerfile whose
  // `CMD ["/path/to/build.sh"]` invokes a build script (produces a .deb/.rpm
  // as a side effect, never runs the product) still had an "entrypoint/cmd:"
  // evidence line and so read as a genuine runtime container. Real hosted
  // defect: a Debian-packaging Dockerfile surfaced as an independent
  // deployable purely because it had SOME CMD directive, script or not.
  const hasRuntimeEntrypoint = (item: DeployableEvidence): boolean =>
    Boolean(item.entrypoint_member);

  const usedAsBaseElsewhere = (candidate: DeployableEvidence): boolean => {
    const candidateKey = normalizeMemberToken(candidate.name);
    if (!candidateKey || candidateKey.length < 3) return false;
    return baseImageSources.some(other => {
      if (other === candidate) return false;
      return (other.base_images || []).some(ref => {
        const token = normalizeMemberToken(stripImageTagAndRegistry(ref));
        if (!token) return false;
        return token === candidateKey || token.includes(candidateKey) || candidateKey.includes(token);
      });
    });
  };

  // A build-only container: no runtime entrypoint of its own, and a
  // multi-stage build (>= 2 FROM stages) that copies >= 2 OTHER services'
  // binaries out — the shape this check targets: a builder image that
  // assembles several artifacts and runs none of them. Deliberately NOT
  // broadened to "no port declared" alone: an ordinary single-stage runtime
  // Dockerfile with no EXPOSE and no ships_paths evidence (common — many real
  // services don't declare EXPOSE, or a test fixture that never wrote ports
  // metadata) is structurally indistinguishable from a build-only container
  // on port/ships_paths evidence alone, and demoting on that basis produced a
  // false positive on a plain single-Dockerfile service with no sibling
  // variant. Packaging-only containers with no distinguishing ships_paths of
  // their own (a Debian/RPM packaging Dockerfile whose CMD is a build script,
  // or whose COPY destinations are a packaging tool's staging directory) are
  // instead folded into their sibling runtime container by
  // collapseWholeRepoPackagingVariants below, which only activates when a
  // genuine runtime sibling exists to attribute them to — never on a lone
  // Dockerfile.
  const isBuilderShape = (candidate: DeployableEvidence): boolean =>
    !hasRuntimeEntrypoint(candidate) &&
    (candidate.ships_paths?.length ?? 0) >= 2 &&
    (candidate.base_images?.length ?? 0) >= 2;

  const out: DeployableEvidence[] = [];
  for (const item of items) {
    const isBuildInfra =
      item.tier === 1 &&
      item.kind === 'container' &&
      !hasRuntimeEntrypoint(item) &&
      (usedAsBaseElsewhere(item) || isBuilderShape(item));

    if (!isBuildInfra) {
      out.push(item);
      continue;
    }

    const namedTargets = item.ships_paths || [];
    if (!namedTargets.length) continue; // names nothing beyond itself — drop outright

    out.push({
      ...item,
      tier: 3,
      kind: 'build-image',
      bundled_into: namedTargets.length === 1 ? namedTargets[0] : item.bundled_into,
      evidence: [
        ...item.evidence,
        namedTargets.length === 1
          ? `build-infra: excluded from ship-unit tier (builds for ${namedTargets[0]})`
          : `build-infra: excluded from ship-unit tier (builds for ${namedTargets.join(', ')})`,
      ],
    });
  }
  return out;
}

/**
 * Collapses distinct Tier-1 `container` rows that ship THE SAME product
 * binary — packaging VARIANTS of one deployable, not distinct deployables.
 * The rule (evidence-based, never a name/keyword match): rows whose own
 * `entrypoint_member` (the real, script/data-file-excluded binary name their
 * ENTRYPOINT/CMD resolves to — see container.ts's isRealMemberToken) is the
 * SAME normalized token are running the identical shipped artifact, just
 * packaged from a different base image (e.g. an `alpine`-base and a
 * `distroless`-base Dockerfile that both `COPY --from=build .../miniflux
 * /usr/bin/miniflux` and `CMD ["/usr/bin/miniflux"]`). Only one survives as
 * the Tier-1 unit; the rest are marked `bundled_into` it, the same
 * mechanism `bundledMembersOf`/`member_root_paths` already read for any
 * other bundle membership — so a collapsed variant's own root_path still
 * shows up on the survivor rather than silently vanishing.
 *
 * Survivor selection: the row with an EXPOSEd port wins first (the stronger
 * "this one actually serves traffic" signal — a genuinely equivalent variant
 * either both or neither expose a port, so this rarely decides anything);
 * ties broken by declaration order, so re-analyzing an unchanged repo picks
 * the same survivor every time.
 *
 * Runs AFTER classifyBuildStageContainers so a demoted build-only packaging
 * container (already `kind: 'build-image'`, `tier: 3`) is never a candidate
 * here — this collapse only ever applies to rows that already independently
 * qualify as a genuine runtime container.
 */
function collapseContainerVariants(items: DeployableEvidence[]): DeployableEvidence[] {
  const groups = new Map<string, DeployableEvidence[]>();
  for (const item of items) {
    if (item.tier !== 1 || item.kind !== 'container' || item.bundled_into) continue;
    const key = normalizeMemberToken(item.entrypoint_member || '');
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ranked = [...group].sort((a, b) => {
      const aPort = (a.ports?.length ?? 0) > 0 ? 0 : 1;
      const bPort = (b.ports?.length ?? 0) > 0 ? 0 : 1;
      if (aPort !== bPort) return aPort - bPort;
      return items.indexOf(a) - items.indexOf(b);
    });
    const survivor = ranked[0];
    for (const variant of ranked.slice(1)) {
      variant.bundled_into = survivor.name;
      variant.evidence = [
        ...new Set([
          ...variant.evidence,
          `packaging-variant-of:${survivor.name}`,
          `same entrypoint binary '${survivor.entrypoint_member}' as '${survivor.name}' — build variant, not a distinct deployable`,
        ]),
      ];
    }
  }
  return items;
}

/**
 * Collapses PACKAGING-ONLY Tier-1 `container` rows — no runtime entrypoint
 * of their own (a build script, or nothing at all: see the
 * `hasRuntimeEntrypoint`/`isBuilderShape` fixes above and their doc comments
 * for why those checks alone can't safely demote these) — into a genuine
 * runtime sibling, when BOTH build from the identical whole-repo source tree
 * (`build-context: repo-root` evidence — see container.ts's
 * hasWholeRepoBuildContext: an `ADD .`/`COPY .` of the entire local build
 * context, not a scoped subdirectory).
 *
 * THE RULE (spec: "distinct artefacts sharing an entrypoint and source root
 * are BUILD VARIANTS of one unit"): among the whole-repo-context group,
 * `collapseContainerVariants` above has already resolved every row WITH a
 * real entrypoint down to at most one canonical entrypoint identity per
 * source tree. When that resolves to EXACTLY ONE surviving product identity,
 * every OTHER whole-repo-context row with NO entrypoint of its own —
 * evidence it never runs the product, only builds/packages it (a Debian
 * packaging Dockerfile whose CMD is a build script; an RPM packaging
 * Dockerfile with no ENTRYPOINT/CMD at all, only `rpmbuild`) — is a
 * packaging variant of that same identity and folds into it.
 *
 * Deliberately inert when the whole-repo-context group resolves to ZERO or
 * MORE THAN ONE distinct entrypoint identity: with no runtime sibling to
 * attribute to, or with more than one genuinely different product built from
 * the same repo root, there is no single answer to fold into, and this never
 * guesses — an unresolved packaging-only row is left exactly where
 * classifyBuildStageContainers/isBuilderShape already leaves it (still its
 * own Tier-1 row, or already-demoted tier-3 build-image if it separately
 * qualified there).
 */
function collapseWholeRepoPackagingVariants(items: DeployableEvidence[]): DeployableEvidence[] {
  const hasRepoRootContext = (item: DeployableEvidence): boolean =>
    item.evidence.includes('build-context: repo-root');

  const wholeRepoContainers = items.filter(
    item => item.tier === 1 && item.kind === 'container' && hasRepoRootContext(item),
  );
  if (wholeRepoContainers.length < 2) return items;

  const runtimeSurvivors = wholeRepoContainers.filter(
    item => !item.bundled_into && item.entrypoint_member,
  );
  const distinctIdentities = new Set(runtimeSurvivors.map(r => normalizeMemberToken(r.entrypoint_member!)));
  if (distinctIdentities.size !== 1) return items; // no sibling, or ambiguous — never guess.
  const survivor = runtimeSurvivors[0];

  for (const item of wholeRepoContainers) {
    if (item === survivor || item.bundled_into || item.entrypoint_member) continue;
    item.bundled_into = survivor.name;
    item.evidence = [
      ...new Set([
        ...item.evidence,
        `packaging-variant-of:${survivor.name}`,
        `same repo-root build source as '${survivor.name}' (which ships entrypoint binary '${survivor.entrypoint_member}'), no runtime entrypoint of its own — packaging variant, not a distinct deployable`,
      ]),
    ];
  }
  return items;
}

/**
 * Bin -> service bundling: a Tier-2 `bin`/`server-entry` candidate whose
 * normalized name matches a joined ship unit's own name, or whose token
 * agrees with that unit's ENTRYPOINT/CMD member (e.g. a Cargo bin
 * `drop-server` compiled into a Dockerfile `ENTRYPOINT ["/bin/drop-server"]`),
 * belongs to THAT unit — real, evidence-grounded service identity — and this
 * must WIN over the weaker "swept into an installer whose product-name
 * resolution failed" (`unnamed-service`) bundling `resolveEvidenceBundling`
 * may already have set purely from a positive-but-generic `ships_paths` hit.
 * Only re-points an EXISTING `bundled_into` when a stronger service-identity
 * match is found; a candidate matching no service unit at all is left
 * exactly as resolveEvidenceBundling set it (never merge on absence).
 */
function rebundleBinsIntoServiceUnits(items: DeployableEvidence[]): void {
  const serviceUnits = items.filter(
    item => item.tier === 1 && (item.kind === 'compose-service' || item.kind === 'container' || item.kind === 'k8s'),
  );
  if (!serviceUnits.length) return;

  for (const candidate of items) {
    if (candidate.tier === 1) continue;
    const candidateKey = normalizeMemberToken(candidate.name);
    if (!candidateKey) continue;

    // Exact identity (candidate's own name equals the service unit's own
    // name) is unambiguous and must win over an ENTRYPOINT/CMD-token
    // coincidence, regardless of array order. Real hosted defect (2026-07,
    // multi-binary workspace repos): a monorepo-root container whose
    // entrypoint dispatches between several binaries (`entrypoint_member:
    // "coordinator"`, one of the names it can run) sorted BEFORE the
    // "coordinator" compose-service row that names the exact same bin — a
    // single .find() over both signals together stopped at the coincidental
    // entrypoint-token hit first and never reached the exact-name row, so
    // the bin never got repointed away from the generic multi-service
    // container. Trying every unit for an exact-name match FIRST, and only
    // falling back to the (weaker, coincidence-prone) entrypoint-token
    // signal when no exact-name match exists anywhere, removes the ordering
    // dependency entirely.
    const unit =
      serviceUnits.find(u => normalizeMemberToken(u.name) === candidateKey) ||
      serviceUnits.find(u => entrypointTokenMatchesName(u.entrypoint_member, candidate.name));
    if (!unit || unit.name === candidate.bundled_into) continue;

    candidate.bundled_into = unit.name;
    candidate.evidence = [
      ...new Set([...candidate.evidence, `bundled-into:${unit.name}`, 'positive-bundling-evidence:service-identity-match']),
    ];
  }
}
