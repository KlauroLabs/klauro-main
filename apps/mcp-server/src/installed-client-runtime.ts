import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

declare const __KLAURO_GIT_SHA__: string | undefined;
declare const __KLAURO_BUILD_TIME__: string | undefined;
declare const __KLAURO_VERSION__: string | undefined;

export const RISKABLE_NODE_TYPES: readonly string[] = [
  'function', 'method', 'service', 'controller', 'serializer', 'entity', 'model',
  'route', 'handler', 'resolver', 'mutation', 'repository',
];

export function getBuildIdentity() {
  const base = typeof __KLAURO_VERSION__ === 'string' ? __KLAURO_VERSION__ : '1.0.0';
  const sha = typeof __KLAURO_GIT_SHA__ === 'string' ? __KLAURO_GIT_SHA__ : 'unknown';
  const buildTime = typeof __KLAURO_BUILD_TIME__ === 'string' ? __KLAURO_BUILD_TIME__ : undefined;
  return { version: `${base}+${sha}`, base_version: base, git_sha: sha, build_time: buildTime, channel: 'bundle' as const };
}

export function formatBuildIdentity(): string {
  const identity = getBuildIdentity();
  return `${identity.version} (bundle, built ${identity.build_time || 'unknown time'})`;
}

export async function checkServerStaleness(options: { serverUrl?: string } = {}) {
  const identity = getBuildIdentity();
  let latestVersion: string | null = null;
  if (options.serverUrl) {
    try {
      const response = await fetch(`${options.serverUrl.replace(/\/+$/, '')}/dist/latest.json`);
      if (response.ok) latestVersion = String((await response.json() as { version?: string }).version || '') || null;
    } catch {}
  }
  const installedVersion = readInstalledVersion();
  const runningStale = Boolean(installedVersion && installedVersion !== identity.base_version);
  const updateAvailable = Boolean(latestVersion && latestVersion !== (installedVersion || identity.base_version));
  return {
    running_version: identity.version,
    installed_version: installedVersion,
    running_stale: runningStale,
    latest_version: latestVersion,
    update_available: updateAvailable,
    note: runningStale
      ? `This MCP server is running ${identity.version} but ${installedVersion} is installed. Restart the MCP client.`
      : updateAvailable ? `${latestVersion} is available. Run \`klauro update\`, then restart the MCP client.` : null,
  };
}

function readInstalledVersion(): string | null {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch { return null; }
}

export function getAnalysisLogDir(): string {
  return process.env.KLAURO_LOG_DIR || path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), '.klauro', 'logs');
}

export function getAnalysisRunLogPath(): string {
  return path.join(getAnalysisLogDir(), 'analysis-runs.jsonl');
}

export function readRecentRunRecords(limit = 50): unknown[] {
  try {
    return fs.readFileSync(getAnalysisRunLogPath(), 'utf8').split('\n').filter(Boolean).slice(-limit).map(line => JSON.parse(line));
  } catch { return []; }
}

export function resolveManifestProjectName(projectPath: string, fallback: string): string {
  for (const file of ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod']) {
    try {
      const text = fs.readFileSync(path.join(projectPath, file), 'utf8');
      if (file === 'package.json') {
        const name = JSON.parse(text).name;
        if (typeof name === 'string' && name.trim()) return name.replace(/^@[^/]+\//, '');
      }
      const match = text.match(file === 'go.mod' ? /^module\s+([^\s]+)/m : /^name\s*=\s*["']([^"']+)/m);
      if (match?.[1]) return match[1].split('/').pop() || fallback;
    } catch {}
  }
  return fallback || path.basename(projectPath);
}

export async function mirrorArtifactsToS3(): Promise<Record<string, string>> { return {}; }

export function resolveDevGitSha(): string {
  const result = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8', timeout: 5000 });
  return result.status === 0 ? String(result.stdout).trim() : 'unknown';
}

