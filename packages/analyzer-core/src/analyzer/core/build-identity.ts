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
}

const FALLBACK_BASE_VERSION = '1.0.0';

let cached: BuildIdentity | undefined;

function bundledValue(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function resolveDevBaseVersion(): string {
  // In a dev checkout this file lives at packages/analyzer-core/src/analyzer/core,
  // so the served package manifest is apps/mcp-server/package.json at the repo root.
  const manifestPath = path.resolve(__dirname, '..', '..', '..', '..', '..', 'apps', 'mcp-server', 'package.json');
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (typeof manifest.version === 'string' && manifest.version.length > 0) return manifest.version;
  } catch {
    // fall through to the static fallback
  }
  return FALLBACK_BASE_VERSION;
}

function resolveDevGitSha(): string {
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

  const baseVersion = resolveDevBaseVersion();
  const gitSha = resolveDevGitSha();
  cached = {
    version: `${baseVersion}-dev+${gitSha}`,
    base_version: baseVersion,
    git_sha: gitSha,
    channel: 'dev',
  };
  return cached;
}

export function formatBuildIdentity(): string {
  const identity = getBuildIdentity();
  if (identity.channel === 'bundle') {
    return `${identity.version} (bundle, built ${identity.build_time || 'unknown time'})`;
  }
  return `${identity.version} (dev checkout, git ${identity.git_sha})`;
}
