/**
 * Workspace isolation scope for multi-analysis MCP surfaces.
 *
 * THE BUG THIS FIXES: `~/.klauro/analyses` accumulates every analysis ever run
 * on this machine — every client repo, every side project, every gauntlet
 * fixture (tens of thousands of entries on a real machine). Tools that
 * enumerate across analyses (list_analyses, list_workspace_analyses,
 * resolve_agent_analysis, get_agent_project_map) had NO workspace boundary:
 * an agent working inside one customer's workspace could see — and an AI
 * summary could casually mention — every other customer's repo names. That is
 * a privacy/isolation failure, not a feature.
 *
 * THE FIX: a single choke point. `filterEntriesToScope` / `resolveAnalysisScope`
 * are called once, inside the universal loaders in storage.ts
 * (`listAnalyses`, `listCrossCodebaseSystemGraphs`), so every MCP tool built on
 * top of them (list_analyses, list_workspace_analyses,
 * list_cross_codebase_analyses, resolve_agent_analysis, get_agent_project_map,
 * and any future caller) is scoped for free — no per-tool edits.
 *
 * THE MECHANISM (config-driven, no new env var): mirrors the existing
 * fabric-config precedent (apps/mcp-server/src/coordination/fabric-config.ts,
 * findFabricProjectRoot / resolveFabricSettings). We walk up from the current
 * working directory looking for a `.klaurorc`. `klauro init` writes
 * `project.workspaceId` when a repo is connected to a hosted account
 * workspace, and a `kind: "workspace"` .klaurorc at a workspace ROOT directory
 * (e.g. `~/dev/soon/.klaurorc`) marks the directory every project of that
 * workspace lives under.
 *
 * MEMBERSHIP IS PER-DIRECTORY, NOT PATH-PREFIX: an early version of this
 * scope filtered by "analysis path is under the workspace root directory" —
 * that is UNSOUND. A real `~/dev/soon` root directory also holds unrelated
 * sibling folders (a finance project, an unrelated `alphaclaw` repo, client
 * work) that happen to live on disk next to the real workspace members but
 * carry NO .klaurorc at all. Path-prefix matching would have let every one of
 * those leak into the "Soon" workspace view — the exact class of bug this
 * module exists to close. The correct test is per-candidate: an analysis is
 * IN SCOPE iff walking up from ITS OWN stored path finds a `.klaurorc` whose
 * `project.workspaceId` equals the caller's bound workspaceId (or the
 * analysis path IS the workspace root itself). See findWorkspaceIdForPath.
 *
 * DEFAULT: when a workspace binding is found, scope is "workspace" (isolated)
 * — this is the safe default the bug report demanded. Explicit opt-out via
 * `.klaurorc` `scope.mode: "machine"` restores the old all-local view (for the
 * product operator's own cross-repo dogfooding). No binding found at all
 * (unset project.workspaceId, no .klaurorc) => unscoped, byte-for-byte the
 * pre-isolation behavior — nothing changes for repos that never opted in.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadKlauroConfig } from './klauro-config';

export interface AnalysisScope {
  /** 'workspace' = filtered to the bound workspace; 'machine' = unscoped (explicit opt-out or no binding). */
  mode: 'workspace' | 'machine';
  /** Present when mode === 'workspace': the bound workspace's identity. */
  workspaceId?: string;
  workspaceName?: string;
  /** Why this scope was chosen — surfaced in tool responses, never leaks other analyses' names. */
  reason: string;
}

const CONFIG_FILES = ['.klaurorc', '.klaurorc.json'];

/** Walk up from `startDir` to find the nearest .klaurorc, mirroring findFabricProjectRoot. */
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

/**
 * Read the workspaceId (if any) bound to a directory's OWN .klaurorc —
 * per-candidate membership, not a shared root prefix and NOT inherited from
 * an ancestor. Every analyzed project that is genuinely a member of a
 * workspace carries its own `.klaurorc` (written by `klauro init`) with
 * `project.workspaceId` set to that workspace. A directory with no
 * `.klaurorc` of its own is NOT a member — it must not inherit the binding of
 * whatever ancestor directory happens to have one, because that ancestor's
 * config describes ITS OWN project/workspace boundary, not an implicit claim
 * over every subdirectory beneath it. (An earlier version of this function
 * walked up looking for the nearest .klaurorc; that let an unrelated sibling
 * folder with no .klaurorc of its own — e.g. a stray repo nested next to real
 * workspace members under the same parent directory — silently inherit the
 * parent's workspaceId and leak into the scoped view. Exact-directory lookup
 * only; see analysis-scope.test.ts's leak-proof test.)
 */
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

/** Small per-call memo: many entries share the same directory tree, so avoid re-reading the same .klaurorc repeatedly. */
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

/**
 * Find the human-readable workspace name for display. The nearest .klaurorc
 * to the caller's cwd is usually a `kind: "project"` config (its `name` is
 * the PROJECT's name, e.g. "soon-ui" — not the workspace's, e.g. "Soon").
 * Walk up while the workspaceId keeps matching and prefer the highest
 * ancestor's `kind: "workspace"` config name; fall back to the nearest
 * config's name if no workspace-kind ancestor is found (e.g. a lone project
 * bound directly to a workspace with no separate workspace-root .klaurorc).
 */
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
  /** Directory to resolve from. Defaults to process.cwd(). */
  cwd?: string;
}

/**
 * Resolve the isolation scope for the current MCP server process. Cheap
 * (a handful of fs.existsSync + JSON reads bounded by directory depth); safe
 * to call per-request rather than caching, since a repo's .klaurorc can
 * change between calls (e.g. `klauro init` runs mid-session).
 */
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

/** True iff `entryPath` equals or is nested under `root` (path-boundary safe, no partial-segment matches). Exported for tests and any caller that legitimately wants a plain prefix check. */
export function isPathUnderRoot(entryPath: string, root: string): boolean {
  const normalizedEntry = path.resolve(entryPath);
  const normalizedRoot = path.resolve(root);
  if (normalizedEntry === normalizedRoot) return true;
  const rootWithSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep;
  return normalizedEntry.startsWith(rootWithSep);
}

/**
 * Filter a list of analysis-like entries (anything with a `path`) down to
 * those bound to the scoped workspace. When scope.mode is 'machine' this is a
 * no-op (returns `entries` unchanged) — the choke point is inert until a
 * workspace binding exists, so nothing changes for repos that never opted in.
 *
 * Membership is per-entry: each entry's OWN path is walked up looking for its
 * nearest `.klaurorc`, and it is in scope only if that config's
 * `project.workspaceId` matches. This is deliberately NOT a directory-prefix
 * check — see the module doc for why prefix matching is unsound (unrelated
 * sibling folders under a workspace root directory are not members).
 */
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

/**
 * Same filter for workspace-analysis / cross-codebase graphs, which don't
 * have a single top-level `path` but do carry `inputs[].repo_path|path`
 * (member repo paths). In scope iff at least one member repo's own
 * `.klaurorc` binds it to the scoped workspaceId — a graph mixing in-scope
 * and out-of-scope repos is still considered relevant (the agent already has
 * legitimate reason to see it), but a graph with ZERO members bound to this
 * workspace (e.g. a stale gauntlet/benchmark artifact that scanned an
 * arbitrary local folder and was never a real workspace) is dropped, so it
 * can never surface another workspace's name.
 */
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
