














































import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadKlauroConfig } from './klauro-config';

export interface AnalysisScope {

  mode: 'workspace' | 'machine';

  workspaceId?: string;
  workspaceName?: string;

  reason: string;
}

const CONFIG_FILES = ['.klaurorc', '.klaurorc.json'];


function findNearestConfigRoot(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  for (;;) {
    for (const name of CONFIG_FILES) {
      if (fs.existsSync(path.join(dir, name))) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

















async function findWorkspaceIdForPath(dir: string): Promise<string | undefined> {
  const resolved = path.resolve(dir);
  const hasOwnConfig = CONFIG_FILES.some(name => fs.existsSync(path.join(resolved, name)));
  if (!hasOwnConfig) return undefined;
  try {
    const loaded = await loadKlauroConfig(resolved);
    return loaded.config.project.workspaceId;
  } catch {
    return undefined;
  }
}


function memoizedWorkspaceIdLookup(): (dir: string) => Promise<string | undefined> {
  const cache = new Map<string, Promise<string | undefined>>();
  return (dir: string) => {
    const key = path.resolve(dir);
    let hit = cache.get(key);
    if (!hit) {
      hit = findWorkspaceIdForPath(key);
      cache.set(key, hit);
    }
    return hit;
  };
}










async function findWorkspaceDisplayName(startDir: string, workspaceId: string, fallbackName: string | undefined): Promise<string | undefined> {
  let dir = path.dirname(startDir);
  let name = fallbackName;
  for (;;) {
    const configured = findNearestConfigRoot(dir);
    if (!configured) break;
    let loaded;
    try {
      loaded = await loadKlauroConfig(configured);
    } catch {
      break;
    }
    if (loaded.config.project.workspaceId !== workspaceId) break;
    if (loaded.config.kind === 'workspace') name = loaded.config.project.name;
    const parent = path.dirname(configured);
    if (parent === configured) break;
    dir = parent;
  }
  return name;
}

export interface ResolveScopeOptions {

  cwd?: string;
}







export async function resolveAnalysisScope(options: ResolveScopeOptions = {}): Promise<AnalysisScope> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const configRoot = findNearestConfigRoot(cwd);
  if (!configRoot) {
    return { mode: 'machine', reason: 'No .klaurorc found; machine-wide view (unscoped, legacy behavior).' };
  }

  let loaded;
  try {
    loaded = await loadKlauroConfig(configRoot);
  } catch {
    return { mode: 'machine', reason: '.klaurorc could not be read; machine-wide view (unscoped, legacy behavior).' };
  }

  const workspaceId = loaded.config.project.workspaceId;
  if (!workspaceId) {
    return { mode: 'machine', reason: 'No project.workspaceId bound in .klaurorc; machine-wide view (unscoped, legacy behavior).' };
  }

  if (loaded.config.scope?.mode === 'machine') {
    return {
      mode: 'machine',
      workspaceId,
      reason: 'scope.mode="machine" in .klaurorc explicitly opts out of workspace isolation.',
    };
  }

  const workspaceName = await findWorkspaceDisplayName(configRoot, workspaceId, loaded.config.project.name);
  return {
    mode: 'workspace',
    workspaceId,
    workspaceName,
    reason: workspaceName
      ? `Scoped to workspace "${workspaceName}" (project.workspaceId bound in .klaurorc).`
      : 'Scoped to the bound workspace (project.workspaceId set in .klaurorc).',
  };
}


export function isPathUnderRoot(entryPath: string, root: string): boolean {
  const normalizedEntry = path.resolve(entryPath);
  const normalizedRoot = path.resolve(root);
  if (normalizedEntry === normalizedRoot) return true;
  const rootWithSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep;
  return normalizedEntry.startsWith(rootWithSep);
}













export async function filterEntriesToScope<T extends { path: string }>(entries: T[], scope: AnalysisScope): Promise<T[]> {
  if (scope.mode === 'machine' || !scope.workspaceId) return entries;
  const workspaceId = scope.workspaceId;
  const lookup = memoizedWorkspaceIdLookup();
  const kept: T[] = [];
  for (const entry of entries) {
    const boundId = await lookup(entry.path);
    if (boundId === workspaceId) kept.push(entry);
  }
  return kept;
}
























export async function excludeForeignWorkspaceEntries<T extends { path: string }>(entries: T[], scope: AnalysisScope): Promise<T[]> {
  const lookup = memoizedWorkspaceIdLookup();
  const kept: T[] = [];
  for (const entry of entries) {
    const boundId = await lookup(entry.path);
    if (boundId !== undefined && boundId !== scope.workspaceId) continue;
    kept.push(entry);
  }
  return kept;
}












export async function filterWorkspaceGraphsToScope<T extends { inputs?: Array<{ repo_path?: string; path?: string }> }>(
  entries: T[],
  scope: AnalysisScope,
): Promise<T[]> {
  if (scope.mode === 'machine' || !scope.workspaceId) return entries;
  const workspaceId = scope.workspaceId;
  const lookup = memoizedWorkspaceIdLookup();
  const kept: T[] = [];
  for (const entry of entries) {
    const inputs = entry.inputs || [];
    let matched = false;
    for (const input of inputs) {
      const candidate = input.repo_path || input.path;
      if (!candidate) continue;
      if ((await lookup(candidate)) === workspaceId) { matched = true; break; }
    }
    if (matched) kept.push(entry);
  }
  return kept;
}
