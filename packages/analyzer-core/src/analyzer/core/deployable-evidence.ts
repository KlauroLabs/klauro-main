import type { CASEntryPoint, CASExitPoint, CASNode, CASOutput, DeployableEvidence } from '../../types/cas.types';
import { getProviders } from './deployable-evidence/registry';
import type { EvidenceCollectionContext, EvidenceProvider } from './deployable-evidence/types';

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

  const deduped = dedupe(results);
  resolveEvidenceBundling(deduped);
  return deduped;
}

function dedupe(items: DeployableEvidence[]): DeployableEvidence[] {
  const seen = new Set<string>();
  const out: DeployableEvidence[] = [];
  for (const item of items) {
    const key = `${item.tier}::${item.kind}::${item.root_path}::${item.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** Normalizes a bundle-member token for comparison (case/whitespace/separator
 *  only) — mirrors installer.ts's normalizeIdentityToken so a ships_paths
 *  entry like "client-service" matches a candidate named "client_service" or
 *  "Client Service" without over-matching unrelated tokens. */
function normalizeMemberToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '-');
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
