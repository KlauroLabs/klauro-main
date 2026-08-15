import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

declare const __KLAURO_GIT_SHA__: string | undefined;
declare const __KLAURO_BUILD_TIME__: string | undefined;
declare const __KLAURO_VERSION__: string | undefined;

export interface BuildIdentity {
  version: string;
  base_version: string;



  git_sha: string;
  build_time?: string;
  channel: 'bundle' | 'dev';



  dirty?: boolean;


  head_sha?: string;
}

const FALLBACK_BASE_VERSION = '1.0.0';

let cached: BuildIdentity | undefined;

function bundledValue(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function resolveDevBaseVersion(): string {


  const manifestPath = path.resolve(__dirname, '..', '..', '..', '..', '..', 'apps', 'mcp-server', 'package.json');
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (typeof manifest.version === 'string' && manifest.version.length > 0) return manifest.version;
  } catch {

  }
  return FALLBACK_BASE_VERSION;
}









export interface DevBuildStamp {
  git_sha?: string;
  build_time?: string;

  dirty?: boolean;



  snapshot_sha?: string;
}

function resolveBuildStampPath(): string {
  return path.resolve(__dirname, '..', '..', '..', '..', '..', 'apps', 'mcp-server', '.klauro-build-stamp.json');
}


export function readDevBuildStamp(stampPath: string): DevBuildStamp | null {
  try {
    const raw = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
    if (raw && typeof raw === 'object') return raw as DevBuildStamp;
  } catch {


  }
  return null;
}
















export function resolveDevGitSha(stamp: DevBuildStamp | null): string {



  if (stamp?.dirty && stamp.snapshot_sha && /^[0-9a-f]{7,40}$/.test(stamp.snapshot_sha)) return stamp.snapshot_sha;
  if (stamp?.git_sha && /^[0-9a-f]{7,40}$/.test(stamp.git_sha)) return stamp.git_sha;
  const result = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], {
    cwd: __dirname,
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.status !== 0) return 'unknown';
  const sha = String(result.stdout || '').trim();
  return /^[0-9a-f]{7,40}$/.test(sha) ? sha : 'unknown';
}

export function getBuildIdentity(): BuildIdentity {
  if (cached) return cached;

  const bundledSha = bundledValue(typeof __KLAURO_GIT_SHA__ === 'string' ? __KLAURO_GIT_SHA__ : undefined);
  const bundledTime = bundledValue(typeof __KLAURO_BUILD_TIME__ === 'string' ? __KLAURO_BUILD_TIME__ : undefined);
  const bundledVersion = bundledValue(typeof __KLAURO_VERSION__ === 'string' ? __KLAURO_VERSION__ : undefined);

  if (bundledSha) {
    const baseVersion = bundledVersion || FALLBACK_BASE_VERSION;
    cached = {
      version: `${baseVersion}+${bundledSha}`,
      base_version: baseVersion,
      git_sha: bundledSha,
      build_time: bundledTime,
      channel: 'bundle',
    };
    return cached;
  }

  const stamp = readDevBuildStamp(resolveBuildStampPath());
  const baseVersion = resolveDevBaseVersion();
  const gitSha = resolveDevGitSha(stamp);
  const dirty = stamp?.dirty === true;
  cached = {
    version: `${baseVersion}-dev+${gitSha}${dirty ? '-dirty' : ''}`,
    base_version: baseVersion,
    git_sha: gitSha,
    build_time: stamp?.build_time,
    channel: 'dev',
    ...(dirty ? { dirty: true, head_sha: stamp?.git_sha } : {}),
  };
  return cached;
}


export function resetBuildIdentityCacheForTests(): void {
  cached = undefined;
}

export function formatBuildIdentity(): string {
  const identity = getBuildIdentity();
  if (identity.channel === 'bundle') {
    return `${identity.version} (bundle, built ${identity.build_time || 'unknown time'})`;
  }
  if (identity.dirty) {
    return `${identity.version} (dev checkout, UNCOMMITTED tree snapshotted as ${identity.git_sha}, on top of ${identity.head_sha || 'unknown'})`;
  }
  return `${identity.version} (dev checkout, git ${identity.git_sha})`;
}




















export interface StalenessCheck {

  running_version: string;

  installed_version: string | null;

  running_stale: boolean;

  latest_version: string | null;

  update_available: boolean;
  note: string | null;
}

function resolveInstalledVersion(): string | null {





  const candidates = [
    path.resolve(__dirname, '..', 'package.json'),
    path.resolve(__dirname, '..', '..', 'package.json'),
  ];
  for (const candidatePath of candidates) {
    try {
      const manifest = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
      if (typeof manifest.version === 'string' && manifest.version.length > 0
        && (manifest.name === '@klauro/mcp-server' || manifest.name === 'klauro')) {
        return manifest.version;
      }
    } catch {

    }
  }
  return null;
}

let cachedStaleness: { at: number; result: StalenessCheck } | undefined;
const STALENESS_CHECK_TTL_MS = 10 * 60 * 1000;













export async function checkServerStaleness(options: {
  serverUrl?: string;
  forceRefresh?: boolean;
  __test?: { runningBaseVersion?: string; installedVersion?: string | null };
} = {}): Promise<StalenessCheck> {
  const now = Date.now();
  if (!options.forceRefresh && cachedStaleness && now - cachedStaleness.at < STALENESS_CHECK_TTL_MS) {
    return cachedStaleness.result;
  }

  const identity = getBuildIdentity();




  const runningBaseVersion = options.__test?.runningBaseVersion ?? identity.base_version;
  const runningVersion = options.__test?.runningBaseVersion ?? identity.version;
  const installedVersion = options.__test ? (options.__test.installedVersion ?? null) : resolveInstalledVersion();
  const runningStale = Boolean(installedVersion && installedVersion !== runningBaseVersion);

  let latestVersion: string | null = null;
  if (options.serverUrl) {
    try {
      const response = await fetch(`${options.serverUrl}/dist/latest.json`, { headers: { 'cache-control': 'no-cache' } });
      if (response.ok) {
        const manifest = await response.json().catch(() => null) as { version?: string } | null;
        latestVersion = manifest?.version || null;
      }
    } catch {
      latestVersion = null;
    }
  }

  const effectiveInstalled = installedVersion || runningBaseVersion;
  const updateAvailable = Boolean(latestVersion && latestVersion !== effectiveInstalled);

  let note: string | null = null;
  if (runningStale) {
    note = `This MCP server process is running ${runningVersion} but ${installedVersion} is installed on disk (an update landed after this session started). RESTART the MCP client (Claude Code / IDE) now to load ${installedVersion} — the running process will keep serving the old build until then.`;
  } else if (updateAvailable) {
    note = `${latestVersion} is available (installed: ${effectiveInstalled}). Run \`klauro update\`, then restart the MCP client to load it.`;
  }

  const result: StalenessCheck = {
    running_version: runningVersion,
    installed_version: installedVersion,
    running_stale: runningStale,
    latest_version: latestVersion,
    update_available: updateAvailable,
    note,
  };
  cachedStaleness = { at: now, result };
  return result;
}


export function resetStalenessCacheForTests(): void {
  cachedStaleness = undefined;
}
