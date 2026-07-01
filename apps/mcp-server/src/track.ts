/**
 * Analysis tracks — keep an in-flight (dirty working tree) analysis from
 * overwriting the committed default-branch ("main") analysis. Three tracks:
 * the committed default branch, a committed non-default branch, and the dirty
 * working tree. The 'main' track keeps the exact legacy filename (empty suffix)
 * for backward compatibility. See revision.ts for RepoRevision.
 */

import type { RepoRevision } from './revision';
import { getRepoRevision } from './revision';
import { loadKlauroConfig } from './klauro-config';

export type AnalysisTrack = 'main' | 'other-branch' | 'in-flight';

/**
 * Classify a repo revision into an analysis track.
 * - dirty working tree → 'in-flight'
 * - clean tree on the default branch → 'main'
 * - clean tree on any other branch → 'other-branch'
 *
 * When `mainBranch` is unset, both 'main' and 'master' are treated as the
 * default branch.
 */
export function revisionToTrack(rev: RepoRevision, mainBranch?: string): AnalysisTrack {
  if (rev.dirty) return 'in-flight';
  const branch = rev.branch;
  if (mainBranch) {
    return branch === mainBranch ? 'main' : 'other-branch';
  }
  return branch === 'main' || branch === 'master' ? 'main' : 'other-branch';
}

/**
 * Resolve the current analysis track for a project, honoring the configured
 * default branch. Reads the repo's current revision and the project's
 * `.klaurorc` `project.mainBranch` (when present) so a repo whose default
 * branch isn't main/master is still classified as 'main'. Returns null when the
 * path is not a git repo (no revision to classify).
 */
export async function resolveCurrentTrack(projectPath: string): Promise<AnalysisTrack | null> {
  const rev = getRepoRevision(projectPath);
  if (!rev) return null;
  let mainBranch: string | undefined;
  try {
    mainBranch = (await loadKlauroConfig(projectPath)).config.project.mainBranch;
  } catch {
    // No/invalid .klaurorc → fall back to main/master default classification.
  }
  return revisionToTrack(rev, mainBranch);
}

/**
 * Filename suffix for a track. 'main' is EMPTY so the committed default-branch
 * analysis keeps the exact current filename (backward compatible).
 */
export function trackSuffix(track: AnalysisTrack): string {
  switch (track) {
    case 'other-branch':
      return '.branch';
    case 'in-flight':
      return '.inflight';
    case 'main':
    default:
      return '';
  }
}
