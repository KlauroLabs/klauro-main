import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { FocusPathResolution } from './agent-start-focus';

type LocalGitStatus = 'tracked' | 'untracked' | 'ignored' | 'missing-on-disk' | 'unknown';

const GIT_TIMEOUT_MS = 4000;

const STATUS_NOTE: Record<Exclude<LocalGitStatus, 'unknown'>, string> = {
  tracked: 'Tracked in your git repository but absent from the analyzed snapshot: it was added after the analyzed commit or sits outside the analysis scope. Re-sync to include it, or read it directly from disk.',
  untracked: 'Untracked in your git repository, so the committed-snapshot upload excluded it and the hosted analysis has no nodes for it. Read it directly from disk; it enters the analysis once committed and synced.',
  ignored: 'Ignored by your git configuration, so the committed-snapshot upload excluded it and the hosted analysis has no nodes for it. Read it directly from disk.',
  'missing-on-disk': 'Not present in your working tree and not in the analyzed snapshot; check the path.',
};

function listed(projectPath: string, args: string[]): boolean {
  const out = execFileSync('git', args, { cwd: projectPath, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
  return out.trim().length > 0;
}

function localGitStatus(projectPath: string, relativePath: string): LocalGitStatus {
  try {
    if (!fs.existsSync(path.resolve(projectPath, relativePath))) return 'missing-on-disk';
    if (listed(projectPath, ['ls-files', '--', relativePath])) return 'tracked';
    if (listed(projectPath, ['ls-files', '--others', '--exclude-standard', '--', relativePath])) return 'untracked';
    return 'ignored';
  } catch {
    return 'unknown';
  }
}

function overlayPath(projectPath: string, item: FocusPathResolution): FocusPathResolution {
  if (item.status !== 'not-in-analysis') return item;
  const status = localGitStatus(projectPath, item.path);
  if (status === 'unknown') return item;
  return { ...item, note: STATUS_NOTE[status], local_git_status: status };
}

export function overlayLocalPathStatus<T>(result: T, projectPath: string): T {
  const focus = (result as { focus?: { related_paths?: FocusPathResolution[]; gaps?: string[] } } | null)?.focus;
  if (!focus?.related_paths?.some(item => item.status === 'not-in-analysis')) return result;
  const related = focus.related_paths.map(item => overlayPath(projectPath, item));
  const gaps = related
    .filter(item => item.status === 'not-in-analysis')
    .map(item => `${item.path}: ${item.note}`);
  const kept = (focus.gaps || []).filter(gap => !related.some(item => item.status === 'not-in-analysis' && gap.startsWith(`${item.path}: `)));
  return { ...(result as object), focus: { ...focus, related_paths: related, gaps: [...gaps, ...kept] } } as T;
}
