import type { CASExitPoint, CASNode, CASOutput, DeployableEvidence } from '../../../types/cas.types';

/**
 * Context passed to every EvidenceProvider.
 *
 * `cas` is `Partial<CASOutput>` rather than `CASOutput` because
 * collectDeployableEvidence() runs mid-assembly inside the orchestrator,
 * before a complete CASOutput exists — callers pass in only the
 * nodes/entryPoints/exitPoints assembled so far. `nodes` and `exitPoints`
 * are included directly on the context as a convenience (they mirror
 * `cas.nodes` / `cas.exit_points`) since every existing provider consumes
 * them directly.
 */
export interface EvidenceCollectionContext {
  cas: Partial<CASOutput>; // the (possibly partial) analyzed CAS
  projectPath: string; // repo root for file reads (glob/fs)
  nodes: CASNode[]; // convenience: cas.nodes
  exitPoints: CASExitPoint[]; // convenience: cas.exit_points
  /**
   * Real display name for this project, distinct from `projectPath`'s basename
   * when the workspace directory is a hash (e.g. remote-analyzer-service writes
   * snapshots to a sha256-derived workspace dir). Providers should prefer this
   * over `path.basename(projectPath)` when falling back to a directory-derived
   * name, so deployable/system names never leak the hash workspace basename.
   * Manifest-derived names (package.json `name`, etc.) still take precedence.
   */
  displayName?: string;
}

/** A pluggable source of deployable evidence for one ecosystem/concern. */
export interface EvidenceProvider {
  id: string; // e.g. 'container', 'installer', 'ci-deploy', 'cargo', 'node', 'go'
  tier: 1 | 2 | 3; // dominant tier (informational)
  collect(ctx: EvidenceCollectionContext): DeployableEvidence[]; // pure, no throw (swallow+log internally)
}

export type { DeployableEvidence };
