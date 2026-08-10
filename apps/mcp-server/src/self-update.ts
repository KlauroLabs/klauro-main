import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getBuildIdentity } from '../../../packages/analyzer-core/src/analyzer/core/build-identity';
import { listActiveSessions } from './session-lock';
import { isNewerVersion } from './stale-client-hint';

/**
 * `klauro update` lives HERE, not in cli.ts, because cli.ts is the DEVELOPER
 * entry point — it is never bundled into the customer tarball. The shipped
 * `klauro` binary is built from installed-cli.ts (see scripts/build-bundle.mjs:
 * entryPoints: ['src/installed-cli.ts'] -> dist/cli.cjs), which for every
 * release up to 1.0.127 had NO `update` command at all: it fell through to the
 * usage block and exited 0.
 *
 * That turned the server's protocol-mismatch remediation ("Run klauro update
 * and restart the MCP client") into a dead end — the command printed help and
 * changed nothing, so every installed CLI stayed on the old protocol and had to
 * be reinstalled by hand. Keeping the implementation in a module BOTH entry
 * points import is the structural fix: the customer CLI can never again lack a
 * command the product tells customers to run.
 */

export interface ReleaseManifest {
  version: string | null;
  tarball?: string;
  tarball_path?: string;
  min_node?: number;
  max_node?: number;
  supported_node_range?: string;
  published_at?: string | null;
  /** Self-contained per-platform binaries (Node SEA) — see
   *  scripts/build-sea-binaries.mjs. Keyed by the same platform id
   *  `resolveSeaPlatformId()` computes client-side (e.g. "macos-arm64").
   *  Server-relative paths, resolved against serverUrl the same way
   *  tarball_path is. Absent on a manifest from a server that has not
   *  published binaries yet — callers must fall back to the npm tarball. */
  binaries?: Record<string, { path: string; sha256: string }>;
}

/** The commands the shipped CLI accepts for self-update. Any remediation text
 *  that names a command MUST name one of these — see the regression test in
 *  installed-cli-update-command.test.ts. */
export const SELF_UPDATE_COMMANDS = ['update', 'upgrade', 'self-update'] as const;

/** The install one-liner, used as the remediation of last resort when the
 *  running CLI is too old to have `update` at all. */
export const KLAURO_INSTALL_ONELINER = 'curl -fsSL https://mcp.klauro.com/install.sh | sh';

/**
 * §NODE-GATE-PHANTOM (2026-08-09) — There used to be an upper Node-version
 * refusal here (and its twin in install.sh), justified by "the native
 * tree-sitter dependency doesn't compile past Node 22". That reasoning is
 * real for the HOSTED analyzer/server image, where tree-sitter genuinely
 * gets compiled — it is NOT real here: `klauro update` (like install.sh)
 * only ever `npm install`s the published customer tarball, and that
 * tarball's package.json has `dependencies: {}` and
 * `optionalDependencies: {}` — inspected directly, zero `.node` binaries,
 * zero native compile step, ever, on any Node version. The upper bound was
 * refusing installs for a compile that was never going to happen on this
 * code path. Verified empirically: v1.0.131's tarball runs unmodified on
 * Node 26 (`node package/dist/cli.cjs version` succeeds).
 *
 * So: no upper bound, and no KLAURO_SKIP_NODE_CHECK escape hatch — a switch
 * that exists only to bypass a refusal that should not exist is two defects,
 * not a feature. A floor is kept (package.json declares `engines: {"node":
 * ">=18"}`) but as a WARNING, not a refusal: nothing in this codebase has
 * verified Node <18 actually fails to run the bundle, and a refusal is for
 * "this cannot work", never "this is unproven" (see also
 * self-contained-binary self-update below, which sidesteps this entirely —
 * it never runs npm install and so never reaches this check at all).
 */
export const DEFAULT_MIN_NODE = 18;

export function checkNodeVersionForUpdate(nodeMajor: number): { ok: boolean; min: number; message?: string } {
  if (!Number.isInteger(nodeMajor) || nodeMajor < DEFAULT_MIN_NODE) {
    return {
      ok: false,
      min: DEFAULT_MIN_NODE,
      message: `klauro's package.json declares Node ${DEFAULT_MIN_NODE}+ (you have ${nodeMajor}); this has not been verified to fail below that, but it also has not been tested. Upgrading is the supported path: nvm install ${DEFAULT_MIN_NODE} && nvm use ${DEFAULT_MIN_NODE}, or volta install node@${DEFAULT_MIN_NODE}.`,
    };
  }
  return { ok: true, min: DEFAULT_MIN_NODE };
}

export async function fetchReleaseManifest(serverUrl: string): Promise<ReleaseManifest | null> {
  try {
    const response = await fetch(`${serverUrl}/dist/latest.json`, { headers: { 'cache-control': 'no-cache' } });
    if (!response.ok) return null;
    return (await response.json()) as ReleaseManifest;
  } catch {
    return null;
  }
}

/**
 * The tarball a `klauro update` must download. The hosted manifest publishes a
 * server-relative `tarball_path` (`/dist/klauro-latest.tgz`); older code read a
 * non-existent absolute `tarball` key and always silently fell back to the
 * hardcoded default, so a manifest that relocated the tarball was ignored.
 */
export function resolveTarballUrl(serverUrl: string, manifest: ReleaseManifest | null): string {
  const base = serverUrl.replace(/\/+$/, '');
  const explicit = manifest?.tarball?.trim();
  if (explicit) return /^https?:\/\//i.test(explicit) ? explicit : `${base}${explicit.startsWith('/') ? '' : '/'}${explicit}`;
  const relative = manifest?.tarball_path?.trim();
  if (relative) return /^https?:\/\//i.test(relative) ? relative : `${base}${relative.startsWith('/') ? '' : '/'}${relative}`;
  return `${base}/dist/klauro-latest.tgz`;
}

// Lines that are routine npm dependency-tree noise during `npm install -g`,
// not signal a `klauro update` caller needs. Conservative: only drops lines
// matching npm's own well-known prefixes/patterns for warnings/notices that
// are not actionable errors. Anything else (including "npm ERR!") passes
// through untouched so real problems are never hidden.
const NPM_NOISE_PATTERNS: RegExp[] = [
  /^npm warn deprecated\b/i,
  /^npm warn config\b/i,
  /^npm warn tar\b/i,
  /^npm warn skipping integrity check\b/i,
  /^npm warn engine\b/i,
  /^npm notice\b/i,
  /^npm fund\b/i,
  /^\d+ packages? (is|are) looking for funding$/i,
  /^\s*run `npm fund` for details$/i,
  /^added \d+ packages?.*in\s/i,
  /^changed \d+ packages?.*in\s/i,
];

export function filterNpmNoise(output: string): string {
  return output
    .split('\n')
    .filter(line => !NPM_NOISE_PATTERNS.some(pattern => pattern.test(line.trim())))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Must resolve `klauro update`'s target to the installation actually running
 * this process, never whatever npm is first on PATH — a machine with several
 * node installs can have the CLI under one global prefix while PATH's npm
 * belongs to another, silently reinstalling into the wrong tree. Derivation:
 * (1) the running CLI script's realpath, (2) fallback to the running node's
 * own prefix. npm must be run with the node from the same detected prefix —
 * node-gyp compiles native addons against whichever node runs npm, so a
 * mismatched node can build tree-sitter for the wrong ABI or fail outright.
 * Exported so the resolution is unit-testable.
 */
export function resolveSelfUpdateTarget(options: {
  execPath?: string;
  scriptPath?: string;
  platform?: NodeJS.Platform;
  realpath?: (p: string) => string;
  exists?: (p: string) => boolean;
} = {}): { npmBin: string; nodeBin?: string; prefix: string; prefixSource: 'cli-realpath' | 'exec-path' } {
  const execPath = options.execPath ?? process.execPath;
  const platform = options.platform ?? process.platform;
  const realpath = options.realpath ?? ((p: string) => fs.realpathSync(p));
  const exists = options.exists ?? ((p: string) => fs.existsSync(p));
  const p = platform === 'win32' ? path.win32 : path.posix;

  let prefix: string | undefined;
  let prefixSource: 'cli-realpath' | 'exec-path' = 'exec-path';
  const script = options.scriptPath ?? process.argv[1];
  if (script) {
    try {
      const real = realpath(script);
      const marker = platform === 'win32' ? `${p.sep}node_modules${p.sep}` : `${p.sep}lib${p.sep}node_modules${p.sep}`;
      const index = real.lastIndexOf(marker);
      if (index > 0) {
        prefix = real.slice(0, index);
        prefixSource = 'cli-realpath';
      }
    } catch {
      // Not resolvable (dev run, deleted bin) — fall through to execPath.
    }
  }
  if (!prefix) {
    prefix = platform === 'win32' ? p.dirname(execPath) : p.resolve(p.dirname(execPath), '..');
  }

  // Prefer the prefix's OWN npm + node (right ABI for the tree being
  // updated), then the npm beside the running node, then PATH npm.
  const prefixBinDir = platform === 'win32' ? prefix : p.join(prefix, 'bin');
  const prefixNpm = p.join(prefixBinDir, platform === 'win32' ? 'npm.cmd' : 'npm');
  const prefixNode = p.join(prefixBinDir, platform === 'win32' ? 'node.exe' : 'node');
  if (exists(prefixNpm)) {
    return {
      npmBin: prefixNpm,
      // npm's shebang is `env node`, which would resolve back to PATH's
      // (possibly wrong) node — so when the prefix carries its own node, the
      // caller must launch npm THROUGH it.
      nodeBin: exists(prefixNode) ? prefixNode : undefined,
      prefix,
      prefixSource,
    };
  }
  const execNpm = p.join(p.dirname(execPath), platform === 'win32' ? 'npm.cmd' : 'npm');
  return { npmBin: exists(execNpm) ? execNpm : 'npm', prefix, prefixSource };
}

/**
 * Which node ACTUALLY drives the native build: target.nodeBin when the
 * resolved prefix carries its own node, else this process's node. Exported
 * so the node-range gate is unit-testable against a real fake-node shim on
 * disk, the same way install.sh's gate is tested.
 */
export function detectBuildNodeVersion(
  target: { nodeBin?: string },
  options: { processVersion?: string } = {},
): string {
  const fallback = options.processVersion ?? process.version;
  if (!target.nodeBin) return fallback;
  const out = (spawnSync(target.nodeBin, ['-v'], { encoding: 'utf8', timeout: 10000 }).stdout || '').trim();
  return out || fallback;
}

/**
 * Field bug (2026-07, #59): pinning npm's OWN argv0 to target.nodeBin is not
 * enough. npm still spawns node-gyp (and other lifecycle scripts) as a CHILD
 * process, and those children resolve `node` via `#!/usr/bin/env node` against
 * inherited PATH — on a multi-node machine (homebrew node 26 first in PATH,
 * nvm node 22 owning the actual install) the top-level npm process correctly
 * ran under node 22 while the COMPILE (node-gyp) still resolved PATH's node
 * 26, so the build failed even though the gate above had already judged the
 * install "supported". Fix: when the prefix carries its own node, prepend
 * that node's directory to PATH for the whole npm install so every `env node`
 * resolution downstream — not just npm's own argv0 — finds the right binary.
 * Exported for unit testing.
 */
export function buildUpdateSpawnEnv(
  target: { nodeBin?: string },
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!target.nodeBin) return baseEnv;
  const dir = path.dirname(target.nodeBin);
  const existingPath = baseEnv.PATH ?? '';
  return { ...baseEnv, PATH: existingPath ? `${dir}${path.delimiter}${existingPath}` : dir };
}

export interface SelfUpdateOptions {
  /** Resolved server URL (already normalized by the caller). */
  serverUrl: string;
  /** --check: report current/latest without installing. */
  checkOnly?: boolean;
  /** --force: reinstall even when already on the latest version. */
  force?: boolean;
  /** --json: machine-readable output. */
  json?: boolean;
  write?: (text: string) => void;
}

export interface SelfUpdateResult {
  status: 'checked' | 'up-to-date' | 'updated';
  current: string;
  latest: string | null;
  prefix?: string;
}

/**
 * Download + install the hosted tarball over the RUNNING installation and
 * report old -> new. Shared by the developer CLI (cli.ts) and the shipped
 * customer CLI (installed-cli.ts).
 */
export async function runSelfUpdate(options: SelfUpdateOptions): Promise<SelfUpdateResult> {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const serverUrl = options.serverUrl.replace(/\/+$/, '');
  const current = getBuildIdentity().base_version;
  const manifest = await fetchReleaseManifest(serverUrl);
  const latest = manifest?.version || null;

  if (options.checkOnly) {
    if (options.json) {
      write(`${JSON.stringify({ current, latest, server_url: serverUrl, up_to_date: latest ? latest === current : null }, null, 2)}\n`);
      return { status: 'checked', current, latest };
    }
    write(`Current klauro: ${current}\n`);
    write(latest ? `Latest available: ${latest} (${serverUrl})\n` : `Latest available: unknown (could not reach ${serverUrl}/dist/latest.json)\n`);
    // #142: `latest !== current` fired in BOTH directions, so a server whose
    // advertised /dist/latest.json trailed this client (a stalled/partial
    // deploy) was reported as "a newer version is available" — backwards.
    // isNewerVersion() is the direction-aware comparator this file's own
    // caller (stale-client-hint.ts) already relies on.
    if (latest && !isNewerVersion(latest, current)) write('You are on the latest version.\n');
    else if (latest && isNewerVersion(latest, current)) write('A newer version is available. Run: klauro update\n');
    return { status: 'checked', current, latest };
  }

  write(`Current klauro: ${current}\n`);
  write(latest ? `Latest available: ${latest} (${serverUrl})\n` : `Latest available: unknown (could not reach ${serverUrl}/dist/latest.json)\n`);

  if (latest && !isNewerVersion(latest, current) && !options.force) {
    // Covers both the real up-to-date case (latest === current) AND #142's
    // case (the server's advertised version trails this client, e.g. a
    // stalled deploy) — neither should install anything. `--force` still
    // reinstalls/downgrades explicitly, matching the flag's documented
    // meaning ("reinstall anyway") for the equal case, and now also gates
    // the trailing-server case behind the same explicit opt-in instead of
    // downgrading silently.
    write(latest === current ? 'Already on the latest version. Use --force to reinstall anyway.\n' : `This client (${current}) is already ahead of what ${serverUrl} advertises (${latest}) — not downgrading. Use --force to install it anyway.\n`);
    return { status: 'up-to-date', current, latest };
  }

  // Self-contained (Node SEA) binary: replace the running executable
  // directly, no npm/node/node-gyp involved at all. Checked FIRST — a binary
  // install has no dist/ to `npm install -g` over, and none of the
  // npm-target-resolution logic below applies to it.
  if (isRunningAsSeaBinary()) {
    return runBinarySelfUpdate({ serverUrl, manifest, current, latest, write, json: options.json });
  }

  // Detect running MCP sessions BEFORE installing: this is a best-effort
  // announcement (session-lock.ts), not a lock — it never blocks the update,
  // it only changes what we print afterward so the human gets an explicit
  // "you need to restart N sessions" signal instead of updating silently.
  const sessionsBeforeUpdate = listActiveSessions();
  const tarballUrl = resolveTarballUrl(serverUrl, manifest);
  // Upgrade the installation that is actually RUNNING, not whatever npm is
  // first on PATH.
  const target = resolveSelfUpdateTarget();

  // Node-floor check only (see §NODE-GATE-PHANTOM above) — a warning on
  // stderr, never a refusal; nothing here has verified below-18 fails.
  const buildNodeVersion = detectBuildNodeVersion(target);
  const buildNodeMajor = Number.parseInt(buildNodeVersion.replace(/^v/, '').split('.')[0], 10);
  const nodeCheck = checkNodeVersionForUpdate(buildNodeMajor);
  if (!nodeCheck.ok) {
    process.stderr.write(`Warning: ${nodeCheck.message} Continuing anyway — this is a floor that has not been proven to matter, not a known-broken combination.\n`);
  }

  write(`\nInstalling ${tarballUrl} ...\n`);
  write(
    `Target: the running CLI's own installation at prefix ${target.prefix} ` +
    `(${target.prefixSource === 'cli-realpath' ? 'resolved from the installed bin realpath' : 'resolved from the running node'}; npm: ${target.npmBin}${target.nodeBin ? ` run with ${target.nodeBin}` : ''})\n`,
  );
  write('(this may take a minute -- native tree-sitter deps compile)\n\n');
  const installArgs = ['install', '-g', tarballUrl, '--force', '--prefix', target.prefix];
  const installEnv = buildUpdateSpawnEnv(target);
  const result = target.nodeBin
    ? spawnSync(target.nodeBin, [target.npmBin, ...installArgs], {
      stdio: ['inherit', 'pipe', 'pipe'],
      encoding: 'utf8',
      env: installEnv,
    })
    : spawnSync(target.npmBin, installArgs, {
      stdio: ['inherit', 'pipe', 'pipe'],
      encoding: 'utf8',
      shell: process.platform === 'win32',
      env: installEnv,
    });
  const npmOutput = filterNpmNoise(`${result.stdout || ''}${result.stderr || ''}`);
  if (npmOutput) write(npmOutput.endsWith('\n') ? npmOutput : `${npmOutput}\n`);
  if (result.status !== 0) {
    throw new Error(
      `npm install failed (exit ${result.status ?? 'unknown'}) while updating prefix ${target.prefix}. See output above. ` +
      `If this keeps failing, reinstall from scratch: ${KLAURO_INSTALL_ONELINER}`,
    );
  }

  if (options.json) {
    write(`${JSON.stringify({
      status: 'updated',
      previous_version: current,
      version: latest,
      prefix: target.prefix,
      prefix_source: target.prefixSource,
      npm: target.npmBin,
      running_sessions_detected: sessionsBeforeUpdate.length,
      running_session_pids: sessionsBeforeUpdate.map(s => s.pid),
      restart_required: sessionsBeforeUpdate.length > 0,
    }, null, 2)}\n`);
    return { status: 'updated', current, latest, prefix: target.prefix };
  }

  const transition = `${current} -> ${latest ?? 'the latest version'}`;
  if (sessionsBeforeUpdate.length > 0) {
    const plural = sessionsBeforeUpdate.length === 1 ? 'session' : 'sessions';
    write(
      `\nklauro updated ${transition} (installation at ${target.prefix}).\n` +
      `Detected ${sessionsBeforeUpdate.length} running MCP ${plural} (pid ${sessionsBeforeUpdate.map(s => s.pid).join(', ')}) still on the OLD build ` +
      `(${sessionsBeforeUpdate.map(s => s.version).join(', ')}) — they will keep running the old code silently until restarted.\n` +
      `RESTART Claude Code (or your MCP client) now to load the new server.\n`
    );
  } else {
    write(`\nklauro updated ${transition} (installation at ${target.prefix}). No running MCP sessions were detected on this machine, but restart Claude Code (or your MCP client) before your next session to load the new server.\n`);
  }
  return { status: 'updated', current, latest, prefix: target.prefix };
}

// ---------------------------------------------------------------------------
// Self-contained (Node SEA) binary self-update.
//
// `klauro update` for the npm-installed client is "run npm install -g over
// the running prefix" (above). A binary install has no npm, no prefix, no
// node_modules — the binary IS the install. Updating it means: download the
// new platform binary, verify its checksum, and atomically swap it in for
// the file that is currently running. This is the same pattern rustup,
// deno upgrade, and nvm's binary installs use.
// ---------------------------------------------------------------------------

/** True when this process is itself a Node SEA binary — see
 *  installed-cli.ts's resolveMcpRegistrationCommand for the other place this
 *  same detection matters (what `klauro install` registers). */
export function isRunningAsSeaBinary(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require('node:sea') as { isSea(): boolean }).isSea();
  } catch {
    return false;
  }
}

/** Maps this process's OS/arch to the platform id used in the release
 *  manifest's `binaries` map and in the built filenames
 *  (scripts/build-sea-binaries.mjs's TARGETS[].id) — must stay in sync with
 *  both. */
export function resolveSeaPlatformId(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | null {
  const archId = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : null;
  if (!archId) return null;
  if (platform === 'darwin') return `macos-${archId}`;
  if (platform === 'linux') return `linux-${archId}`;
  if (platform === 'win32' && archId === 'x64') return 'win-x64';
  return null;
}

async function runBinarySelfUpdate(options: {
  serverUrl: string;
  manifest: ReleaseManifest | null;
  current: string;
  latest: string | null;
  write: (text: string) => void;
  json?: boolean;
}): Promise<SelfUpdateResult> {
  const { serverUrl, manifest, current, latest, write, json } = options;
  const platformId = resolveSeaPlatformId();
  const runningPath = process.execPath;

  if (!platformId) {
    throw new Error(
      `Cannot self-update: no self-contained binary is published for ${process.platform}/${process.arch}. ` +
      `Reinstall manually from ${serverUrl}, or if a native npm/Node toolchain is available on this machine, ` +
      `install the npm-distributed client instead: npm install -g ${resolveTarballUrl(serverUrl, manifest)}`,
    );
  }
  const binaryEntry = manifest?.binaries?.[platformId];
  if (!binaryEntry) {
    throw new Error(
      `Cannot self-update: the release manifest at ${serverUrl}/dist/latest.json does not list a binary for ${platformId} ` +
      `(server may predate the self-contained binary release, or the current release manifest omitted it — check with support-bundle / doctor).`,
    );
  }

  const binaryUrl = /^https?:\/\//i.test(binaryEntry.path) ? binaryEntry.path : `${serverUrl.replace(/\/+$/, '')}${binaryEntry.path.startsWith('/') ? '' : '/'}${binaryEntry.path}`;
  write(`\nDownloading ${binaryUrl} ...\n`);

  const response = await fetch(binaryUrl);
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status} for ${binaryUrl}`);
  const bytes = new Uint8Array(await response.arrayBuffer());

  const crypto = await import('node:crypto');
  const actualSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actualSha256 !== binaryEntry.sha256) {
    throw new Error(`Checksum mismatch for ${binaryUrl}: expected ${binaryEntry.sha256}, got ${actualSha256}. Refusing to install — try again, and if this persists, reinstall from scratch: ${KLAURO_INSTALL_ONELINER}`);
  }
  write(`Checksum verified (sha256=${actualSha256}).\n`);

  const dir = path.dirname(runningPath);
  const tmpPath = path.join(dir, `.klauro-update-${process.pid}.tmp`);
  fs.writeFileSync(tmpPath, bytes, { mode: 0o755 });
  fs.chmodSync(tmpPath, 0o755);

  const sessionsBeforeUpdate = listActiveSessions();

  if (process.platform === 'win32') {
    // Windows will not let a running .exe be overwritten or deleted while
    // it is the running image — verified against how nvm-windows/rustup
    // solve this, NOT tested against this specific binary (no Windows
    // available in the environment that built this). Move the running
    // binary aside first (Windows DOES allow renaming a running exe, just
    // not deleting/overwriting it), then place the new one at the original
    // path; the old file is cleaned up as best-effort and, if that fails,
    // is simply orphaned beside the new binary rather than blocking the
    // update.
    const oldAside = `${runningPath}.old-${process.pid}`;
    fs.renameSync(runningPath, oldAside);
    fs.renameSync(tmpPath, runningPath);
    try { fs.unlinkSync(oldAside); } catch { /* best-effort; a stray .old-<pid> file is harmless */ }
  } else {
    // POSIX: renaming over a running executable's path is safe — the
    // process currently executing keeps running against the OLD inode
    // (already mapped into memory / held open), and the new file takes the
    // name for the NEXT invocation. No "stop the presses" step needed.
    fs.renameSync(tmpPath, runningPath);
  }

  if (json) {
    write(`${JSON.stringify({
      status: 'updated',
      previous_version: current,
      version: latest,
      binary: runningPath,
      platform: platformId,
      running_sessions_detected: sessionsBeforeUpdate.length,
      running_session_pids: sessionsBeforeUpdate.map(s => s.pid),
      restart_required: true,
    }, null, 2)}\n`);
    return { status: 'updated', current, latest, prefix: dir };
  }

  const transition = `${current} -> ${latest ?? 'the latest version'}`;
  write(
    `\nklauro updated ${transition} (binary at ${runningPath}).\n` +
    (sessionsBeforeUpdate.length > 0
      ? `Detected ${sessionsBeforeUpdate.length} running MCP session(s) still on the OLD build — restart Claude Code (or your MCP client) now to load the new server.\n`
      : `Restart Claude Code (or your MCP client) before your next session to load the new server.\n`),
  );
  return { status: 'updated', current, latest, prefix: dir };
}
