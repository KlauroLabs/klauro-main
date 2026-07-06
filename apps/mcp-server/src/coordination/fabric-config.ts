/**
 * fabric-config.ts — config-file + CLI-driven settings resolution for the
 * remote coordination fabric (docs/FABRIC-REMOTE.md).
 *
 * The DevX contract (no per-shell env setup): `klauro fabric on` persists
 * `{fabric: {enabled, endpoint, workspace}}` into the project's .klaurorc,
 * and every fab.ts command / fab_* MCP tool run inside that repo resolves its
 * transport from that file automatically. Precedence, highest first:
 *
 *   1. explicit args (a `--workspace` flag / a tool's `workspace` param)
 *   2. .klaurorc `fabric` section (found by walking UP from cwd, like git):
 *      - enabled:true  -> remote via fabric.endpoint
 *      - enabled:false -> explicitly LOCAL (a deliberate `klauro fabric off`
 *        beats any lingering env vars)
 *   3. FAB_REMOTE_URL / FAB_REMOTE_TOKEN / FAB_WS env vars — kept ONLY as a
 *      low-priority escape hatch for CI / ephemeral containers where writing
 *      a config file is awkward. Not the documented happy path.
 *   4. local-only fabric, workspace 'poc' (the original behavior, unchanged).
 *
 * The Bearer token is NEVER persisted in .klaurorc (repo files get committed;
 * tokens must not). It is resolved at call time: FAB_REMOTE_TOKEN env (CI) >
 * the credential store `klauro init` / `klauro login` already maintain
 * (~/.klauro/auth.json via connector-auth.ts) — one credential store, reused.
 *
 * Workspace identity autodetection (for `klauro fabric on`), most stable first:
 *   1. `--workspace <name>` (explicit override)
 *   2. .klaurorc project.id — the hosted Klauro project identity from
 *      `klauro init`; identical on every machine linked to the same project
 *   3. the git remote URL, normalized, as `<repo>-<8-hex sha256>` — identical
 *      on every clone of the same remote even without a hosted project link
 *   4. the repo directory basename — same-machine fallback only
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadKlauroConfig, type KlauroFabricConfig } from '../klauro-config';
import { connectorToken } from '../connector-auth';
import { getRemoteFabConfig, type RemoteFabConfig } from './remote-transport';

const CONFIG_FILES = ['.klaurorc', '.klaurorc.json'];

/** Default workspace when nothing configures one (the original fab.ts fallback). */
export const DEFAULT_FABRIC_WORKSPACE = 'poc';

export interface FabricProjectRoot {
  root: string;
  configPath: string;
}

/**
 * Walk up from `startDir` (like git does for .git) to the first directory
 * containing a .klaurorc / .klaurorc.json. Undefined when none exists — the
 * caller is not inside a Klauro-initialized project.
 */
export function findFabricProjectRoot(startDir: string): FabricProjectRoot | undefined {
  let dir = path.resolve(startDir);
  for (;;) {
    for (const name of CONFIG_FILES) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return { root: dir, configPath: candidate };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export type WorkspaceIdentitySource = 'explicit' | 'project-id' | 'git-remote' | 'repo-basename';

export interface WorkspaceIdentity {
  workspace: string;
  source: WorkspaceIdentitySource;
}

/**
 * Autodetect the stable workspace identity for a repo (precedence documented
 * in the module header). `projectId` should come from the loaded .klaurorc.
 */
export function detectWorkspaceIdentity(root: string, projectId?: string): WorkspaceIdentity {
  if (projectId && projectId.trim()) {
    return { workspace: projectId.trim(), source: 'project-id' };
  }
  const remote = gitRemoteUrl(root);
  if (remote) {
    const normalized = normalizeGitRemote(remote);
    const repoName = normalized.split('/').filter(Boolean).pop() || 'repo';
    const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 8);
    return { workspace: `${repoName}-${hash}`, source: 'git-remote' };
  }
  return { workspace: path.basename(path.resolve(root)), source: 'repo-basename' };
}

function gitRemoteUrl(root: string): string | undefined {
  try {
    const out = execFileSync('git', ['-C', root, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Normalize a git remote URL so every clone of the same repo derives the same
 * workspace id: ssh (`git@host:owner/repo.git`) and https forms converge on
 * `host/owner/repo`, lowercased, `.git` stripped.
 */
export function normalizeGitRemote(url: string): string {
  let value = url.trim().toLowerCase().replace(/\.git$/, '');
  const sshMatch = value.match(/^(?:ssh:\/\/)?(?:[\w.-]+@)?([\w.-]+)[:/](.+)$/);
  try {
    const parsed = new URL(value);
    return `${parsed.host}${parsed.pathname}`.replace(/\/+$/, '');
  } catch {
    if (sshMatch) return `${sshMatch[1]}/${sshMatch[2]}`.replace(/\/+$/, '');
    return value;
  }
}

export type FabricSettingSource = 'explicit' | 'config' | 'env' | 'default';

export interface ResolveFabricOptions {
  /** Directory to resolve the project config from (walks up). Default process.cwd(). */
  cwd?: string;
  /** Explicit remote endpoint — beats config and env. */
  explicitUrl?: string;
  /** Explicit token — beats env and the credential store. */
  explicitToken?: string;
  /** Explicit workspace — beats config and env. */
  explicitWorkspace?: string;
  /** Environment (injectable for tests). Default process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface ResolvedFabricSettings {
  /** Remote transport config; undefined = LOCAL fabric (original behavior). */
  remote?: RemoteFabConfig;
  remoteSource?: FabricSettingSource;
  workspace: string;
  workspaceSource: FabricSettingSource;
  /** The .klaurorc that supplied the fabric section, when one was found. */
  configPath?: string;
  /** The raw fabric section from that config, when present. */
  fabric?: KlauroFabricConfig;
}

/**
 * Resolve the fabric transport settings for a call. See the module header for
 * the full precedence. Never throws: an unreadable/absent config degrades to
 * the env-then-local chain (the advisory fabric must never crash a caller).
 */
export async function resolveFabricSettings(options: ResolveFabricOptions = {}): Promise<ResolvedFabricSettings> {
  const env = options.env ?? process.env;
  const found = findFabricProjectRoot(options.cwd ?? process.cwd());
  let fabric: KlauroFabricConfig | undefined;
  let analyzerServerUrl: string | undefined;
  if (found) {
    try {
      const loaded = await loadKlauroConfig(found.root);
      fabric = loaded.config.fabric;
      analyzerServerUrl = loaded.config.analyzer.serverUrl;
    } catch {
      // Malformed .klaurorc: behave as if absent (env chain still applies).
    }
  }

  // Workspace: explicit > config fabric.workspace > FAB_WS env > default.
  let workspace: string;
  let workspaceSource: FabricSettingSource;
  if (options.explicitWorkspace && options.explicitWorkspace.trim()) {
    workspace = options.explicitWorkspace.trim();
    workspaceSource = 'explicit';
  } else if (fabric?.workspace) {
    workspace = fabric.workspace;
    workspaceSource = 'config';
  } else if (env.FAB_WS && env.FAB_WS.trim()) {
    workspace = env.FAB_WS.trim();
    workspaceSource = 'env';
  } else {
    workspace = DEFAULT_FABRIC_WORKSPACE;
    workspaceSource = 'default';
  }

  // Remote: explicit > config (enabled routes remote; a present-but-disabled
  // section is an explicit `fabric off` and beats env) > env escape hatch.
  if (options.explicitUrl && options.explicitUrl.trim()) {
    const baseUrl = options.explicitUrl.trim();
    return {
      remote: { baseUrl, token: resolveFabricToken(baseUrl, env, options.explicitToken) },
      remoteSource: 'explicit',
      workspace,
      workspaceSource,
      configPath: found?.configPath,
      fabric,
    };
  }
  if (fabric) {
    if (fabric.enabled) {
      const baseUrl = (fabric.endpoint || analyzerServerUrl || '').trim();
      if (baseUrl) {
        return {
          remote: { baseUrl, token: resolveFabricToken(baseUrl, env, options.explicitToken) },
          remoteSource: 'config',
          workspace,
          workspaceSource,
          configPath: found?.configPath,
          fabric,
        };
      }
    }
    // fabric section present but disabled (or enabled with no resolvable
    // endpoint): stay LOCAL, deliberately ignoring FAB_REMOTE_URL.
    return { workspace, workspaceSource, configPath: found?.configPath, fabric };
  }
  const envRemote = getRemoteFabConfig(env);
  if (envRemote) {
    return { remote: envRemote, remoteSource: 'env', workspace, workspaceSource, configPath: found?.configPath };
  }
  return { workspace, workspaceSource, configPath: found?.configPath };
}

/**
 * Resolve the Bearer token for a fabric endpoint WITHOUT ever reading it from
 * .klaurorc: explicit > FAB_REMOTE_TOKEN (CI escape hatch) > the same stored
 * credentials `klauro init`/`klauro login` persist (~/.klauro/auth.json,
 * including the KLAURO_ACCOUNT_TOKEN/KLAURO_ANALYZER_TOKEN env fallbacks that
 * connector-auth already honors). Undefined = unauthenticated (the service
 * will 401 and the caller degrades loudly).
 */
export function resolveFabricToken(endpoint: string, env: NodeJS.ProcessEnv = process.env, explicitToken?: string): string | undefined {
  if (explicitToken) return explicitToken;
  if (env.FAB_REMOTE_TOKEN) return env.FAB_REMOTE_TOKEN;
  return connectorToken(undefined, endpoint);
}

/**
 * Persist the fabric section into the project's .klaurorc, additively: the
 * raw file is read as-is and ONLY the `fabric` key is replaced, so a
 * hand-tuned config is never rewritten/expanded. When no .klaurorc exists a
 * minimal one is created (version + project.name + fabric) — `klauro init`
 * remains the full setup path.
 */
export function writeFabricSection(root: string, section: KlauroFabricConfig): { configPath: string; created: boolean } {
  const resolvedRoot = path.resolve(root);
  const existing = CONFIG_FILES
    .map((name) => path.join(resolvedRoot, name))
    .find((candidate) => fs.existsSync(candidate));
  const configPath = existing || path.join(resolvedRoot, '.klaurorc');
  let raw: Record<string, unknown> = {};
  if (existing) {
    raw = JSON.parse(fs.readFileSync(existing, 'utf8'));
  } else {
    raw = { version: 1, project: { name: path.basename(resolvedRoot) } };
  }
  raw.fabric = section;
  fs.writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  return { configPath, created: !existing };
}
