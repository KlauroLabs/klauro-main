
































import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadKlauroConfig, type KlauroFabricConfig } from '../klauro-config';
import { connectorToken } from '../connector-auth';
import { getRemoteFabConfig, type RemoteFabConfig } from './remote-transport';

const CONFIG_FILES = ['.klaurorc', '.klaurorc.json'];


export const DEFAULT_FABRIC_WORKSPACE = 'poc';

export interface FabricProjectRoot {
  root: string;
  configPath: string;
}






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

  cwd?: string;








  searchDirs?: string[];

  explicitUrl?: string;

  explicitToken?: string;

  explicitWorkspace?: string;

  env?: NodeJS.ProcessEnv;
}

export interface ResolvedFabricSettings {

  remote?: RemoteFabConfig;
  remoteSource?: FabricSettingSource;
  workspace: string;
  workspaceSource: FabricSettingSource;

  configPath?: string;

  fabric?: KlauroFabricConfig;







  localReason?: string;

  searchedDirs?: string[];
}






export async function resolveFabricSettings(options: ResolveFabricOptions = {}): Promise<ResolvedFabricSettings> {
  const env = options.env ?? process.env;




  const searchRoots = [
    ...(options.searchDirs ?? []),
    ...(env.KLAURO_FABRIC_CWD ? [env.KLAURO_FABRIC_CWD] : []),
    options.cwd ?? process.cwd(),
  ].filter((d): d is string => Boolean(d && d.trim()));
  const searchedDirs = [...new Set(searchRoots.map((d) => path.resolve(d)))];
  let found: FabricProjectRoot | undefined;
  for (const dir of searchedDirs) {
    found = findFabricProjectRoot(dir);
    if (found) break;
  }
  let fabric: KlauroFabricConfig | undefined;
  let analyzerServerUrl: string | undefined;
  let configLoadError: string | undefined;
  if (found) {
    try {
      const loaded = await loadKlauroConfig(found.root);
      fabric = loaded.config.fabric;
      analyzerServerUrl = loaded.config.analyzer.serverUrl;
    } catch (err) {

      configLoadError = err instanceof Error ? err.message : String(err);
    }
  }


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



  if (options.explicitUrl && options.explicitUrl.trim()) {
    const baseUrl = options.explicitUrl.trim();
    return {
      remote: { baseUrl, token: resolveFabricToken(baseUrl, env, options.explicitToken) },
      remoteSource: 'explicit',
      workspace,
      workspaceSource,
      configPath: found?.configPath,
      fabric,
      searchedDirs,
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
          searchedDirs,
        };
      }


      return {
        workspace,
        workspaceSource,
        configPath: found?.configPath,
        fabric,
        searchedDirs,
        localReason: `fabric.enabled is true in ${found?.configPath ?? '.klaurorc'} but no endpoint could be resolved (set fabric.endpoint or analyzer.serverUrl) — staying LOCAL.`,
      };
    }

    return {
      workspace,
      workspaceSource,
      configPath: found?.configPath,
      fabric,
      searchedDirs,
      localReason: `fabric is disabled in ${found?.configPath ?? '.klaurorc'} (klauro fabric off) — LOCAL by design; run \`klauro fabric on\` to coordinate cross-machine.`,
    };
  }
  const envRemote = getRemoteFabConfig(env);
  if (envRemote) {
    return { remote: envRemote, remoteSource: 'env', workspace, workspaceSource, configPath: found?.configPath, searchedDirs };
  }



  const localReason = configLoadError
    ? `.klaurorc found (${found?.configPath}) but could not be parsed (${configLoadError}) — LOCAL fabric only.`
    : `no .klaurorc fabric config found from ${searchedDirs.join(', ') || 'the server working directory'} — LOCAL fabric only (remote not configured). Run \`klauro fabric on\` in the repo, or ensure the server can reach the repo root (KLAURO_FABRIC_CWD).`;
  return { workspace, workspaceSource, configPath: found?.configPath, searchedDirs, localReason };
}









export function resolveFabricToken(endpoint: string, env: NodeJS.ProcessEnv = process.env, explicitToken?: string): string | undefined {
  if (explicitToken) return explicitToken;
  if (env.FAB_REMOTE_TOKEN) return env.FAB_REMOTE_TOKEN;
  return connectorToken(undefined, endpoint);
}








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
