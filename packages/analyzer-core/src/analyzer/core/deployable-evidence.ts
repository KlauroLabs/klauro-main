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
}

export function collectDeployableEvidence(input: CollectDeployableEvidenceInput): DeployableEvidence[] {
  const { projectPath, nodes, entryPoints, exitPoints } = input;

  const cas: Partial<CASOutput> = {
    nodes,
    entry_points: entryPoints,
    exit_points: exitPoints,
  };
  const ctx: EvidenceCollectionContext = { cas, projectPath, nodes, exitPoints };

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

  return dedupe(results);
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
