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

/**
 * Deploy-time stamp for a deployed-but-unbundled ("dev channel") process —
 * `infrastructure/vps/deploy.sh` writes this next to apps/mcp-server/
 * package.json (see resolveDevBaseVersion's manifestPath) right after
 * rsyncing source and BEFORE `docker compose build`, since the prod
 * Dockerfile runs the source directly via `tsx` rather than the esbuild
 * bundle that would otherwise embed __KLAURO_GIT_SHA__/__KLAURO_BUILD_TIME__.
 */
export interface DevBuildStamp {
  git_sha?: string;
  build_time?: string;
}

function resolveBuildStampPath(): string {
  return path.resolve(__dirname, '..', '..', '..', '..', '..', 'apps', 'mcp-server', '.klauro-build-stamp.json');
}

/** Exported for direct unit-testing against a fixture path — never called with an untrusted path in production. */
export function readDevBuildStamp(stampPath: string): DevBuildStamp | null {
  try {
    const raw = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
    if (raw && typeof raw === 'object') return raw as DevBuildStamp;
  } catch {
    // absent/unreadable (a real dev checkout with no deploy stamp, or a
    // torn/partial write) — fall through to the git-derived path below.
  }
  return null;
}

/**
 * PRODUCTION BUG (v1.0.126 fresh self-analysis): the deployed api container
 * runs raw TS via `tsx src/index.ts`, never the esbuild bundle — see
 * apps/api/Dockerfile's CMD and infrastructure/vps/deploy.sh's own comment
 * ("the api container runs raw TS via tsx"). That deploy path ALSO
 * `rsync --exclude .git`s the source tree to the VPS (deploy.sh's "Syncing
 * source" step), so this function's `git rev-parse` always ran with no
 * `.git` directory in reach on prod and silently fell back to 'unknown' —
 * hence every hosted build reporting "1.0.126-dev+unknown" instead of a real
 * commit. Fix: prefer deploy.sh's stamped git_sha (written straight from the
 * clean, guaranteed-git-checkout HOST tree that IS what got shipped) before
 * ever falling back to a local git invocation — a genuine dev checkout with
 * .git still resolves correctly since it has no stamp file and hits the
 * fallback exactly as before.
 */
export function resolveDevGitSha(stamp: DevBuildStamp | null): string {
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
  cached = {
    version: `${baseVersion}-dev+${gitSha}`,
    base_version: baseVersion,
    git_sha: gitSha,
    build_time: stamp?.build_time,
    channel: 'dev',
  };
  return cached;
}

/** Test-only: clear the module-level identity cache so tests can re-derive against a fresh stamp/env. */
export function resetBuildIdentityCacheForTests(): void {
  cached = undefined;
}

export function formatBuildIdentity(): string {
  const identity = getBuildIdentity();
  if (identity.channel === 'bundle') {
    return `${identity.version} (bundle, built ${identity.build_time || 'unknown time'})`;
  }
  return `${identity.version} (dev checkout, git ${identity.git_sha})`;
}

// --- Running-vs-installed staleness detection ------------------------------
//
// The customer bug this exists for: `klauro update` overwrites the globally
// installed package (npm install -g <tarball>) IN PLACE, on disk, while an
// already-running MCP server process keeps executing the module it loaded
// into memory at startup (Node does not hot-reload). getBuildIdentity() above
// is cached for the lifetime of the process — it reports the RUNNING build.
// This section re-reads the installed package.json from disk on every
// (throttled) check, so a `klauro update` that lands after the server started
// is detectable without requiring a restart to observe it.
//
// "Installed" is resolved relative to __dirname at call time, not the cached
// build identity: in the shipped bundle, this module is esbuild-bundled into
// dist/server.cjs, so __dirname at runtime is the real, current dist/
// directory of whatever is installed on disk right now — a fresh fs.readFileSync
// of dist/../package.json therefore reflects any update that happened after
// this process booted, exactly like `klauro update`'s `npm install -g --force`
// leaves it.

export interface StalenessCheck {
  /** The running process's own build identity (frozen at startup). */
  running_version: string;
  /** package.json version found on disk right now, next to this running module (null if unresolvable — e.g. dev checkout with no installed package.json sibling). */
  installed_version: string | null;
  /** true when installed_version differs from the running build's base_version — i.e. `klauro update` landed after this process started and a restart would pick up new code. */
  running_stale: boolean;
  /** hosted latest.json version, when reachable. */
  latest_version: string | null;
  /** true when installed_version (or running, if installed is unknown) is behind latest_version. */
  update_available: boolean;
  note: string | null;
}

function resolveInstalledVersion(): string | null {
  // Walk up from this module's real on-disk directory (see comment above) to
  // find the nearest package.json — one or two levels up covers both the
  // bundled layout (dist/server.cjs -> ../package.json) and a dev checkout
  // (packages/analyzer-core/src/analyzer/core -> no installed manifest here,
  // handled by the caller via base_version fallback instead).
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
      // try the next candidate
    }
  }
  return null;
}

let cachedStaleness: { at: number; result: StalenessCheck } | undefined;
const STALENESS_CHECK_TTL_MS = 10 * 60 * 1000; // throttle to ~once per 10min (SPEC ask); cheap disk read, but no reason to hammer it per tool call.

/**
 * Compare the RUNNING build against the INSTALLED-on-disk package and the
 * hosted latest.json. Throttled to STALENESS_CHECK_TTL_MS — cheap (one
 * fs.readFileSync + one fetch) but no reason to redo it on every tool call.
 * Never throws: a failed/unreachable manifest degrades to null fields rather
 * than breaking the caller.
 *
 * Test-only overrides (`__test`): production call sites never pass these —
 * they let unit tests simulate "running old / installed new" and "up to
 * date" without needing a real dist/ layout or a second installed package.json
 * on disk.
 */
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
  // In tests, __test.runningBaseVersion stands in for BOTH the displayed
  // running_version and the base_version used for the stale comparison — real
  // callers never set this, so identity.version/base_version (frozen at
  // process startup) are used untouched.
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

/** Test-only: clear the throttle cache so tests don't leak state across cases. */
export function resetStalenessCacheForTests(): void {
  cachedStaleness = undefined;
}
