







import type { RepoRevision } from './revision';
import { getRepoRevision } from './revision';
import { loadKlauroConfig } from './klauro-config';

export type AnalysisTrack = 'main' | 'other-branch' | 'in-flight';










export function revisionToTrack(rev: RepoRevision, mainBranch?: string): AnalysisTrack {
  if (rev.dirty) return 'in-flight';
  const branch = rev.branch;
  if (mainBranch) {
    return branch === mainBranch ? 'main' : 'other-branch';
  }
  return branch === 'main' || branch === 'master' ? 'main' : 'other-branch';
}








export async function resolveCurrentTrack(projectPath: string): Promise<AnalysisTrack | null> {
  const rev = getRepoRevision(projectPath);
  if (!rev) return null;
  let mainBranch: string | undefined;
  try {
    mainBranch = (await loadKlauroConfig(projectPath)).config.project.mainBranch;
  } catch {

  }
  return revisionToTrack(rev, mainBranch);
}





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
