









import { execFileSync } from 'child_process';
import * as crypto from 'crypto';

export interface RepoRevision {
  branch: string | null;
  head_sha: string | null;
  dirty: boolean;

  dirty_hash: string | null;
}

function git(projectPath: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: projectPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
}


export function getRepoRevision(projectPath: string): RepoRevision | null {
  const head = git(projectPath, ['rev-parse', 'HEAD']);
  if (head === null) return null;
  const branch = git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = git(projectPath, ['status', '--porcelain']) ?? '';
  const dirty = status.length > 0;
  let dirty_hash: string | null = null;
  if (dirty) {
    const diff = git(projectPath, ['diff', 'HEAD']) ?? '';
    dirty_hash = crypto.createHash('sha256').update(`${status}\0${diff}`).digest('hex').slice(0, 16);
  }
  return { branch: branch || null, head_sha: head, dirty, dirty_hash };
}





export function revisionCacheKey(projectId: string, rev: RepoRevision): string {
  const base = `${projectId}@${rev.branch || 'detached'}@${rev.head_sha || 'none'}`;
  return rev.dirty && rev.dirty_hash ? `${base}+wip-${rev.dirty_hash}` : base;
}

export type RevisionMatch =
  | 'committed-current'
  | 'in-flight'
  | 'behind'
  | 'unknown';


export function compareRevision(
  analyzedSha: string | null | undefined,
  current: RepoRevision | null,
): RevisionMatch {
  if (!current || !current.head_sha || !analyzedSha) return 'unknown';
  if (current.head_sha === analyzedSha) return current.dirty ? 'in-flight' : 'committed-current';
  return 'behind';
}
