import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getBuildIdentity } from '../../../packages/analyzer-core/src/analyzer/core/build-identity';
import { listActiveSessions } from './session-lock';

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
}

/** The commands the shipped CLI accepts for self-update. Any remediation text
 *  that names a command MUST name one of these — see the regression test in
 *  installed-cli-update-command.test.ts. */
export const SELF_UPDATE_COMMANDS = ['update', 'upgrade', 'self-update'] as const;

/** The install one-liner, used as the remediation of last resort when the
 *  running CLI is too old to have `update` at all. */
export const KLAURO_INSTALL_ONELINER = 'curl -fsSL https://mcp.klauro.com/install.sh | sh';

/**
 * Node support gate shared by `klauro update` (and mirrored in install.sh):
 * the native tree-sitter dependency (0.25.x, no shipped prebuilds, binding.gyp
 * pins -std=c++17) fails to compile against Node 23+ headers (v8config.h:
 * "C++20 or later required" — verified empirically against the 22/23/24/25/26
 * header sets). Failing AFTER download, mid-`npm install -g`, buries that in a
 * node-gyp stack trace; this gate turns it into one actionable sentence BEFORE
 * anything is touched. The hosted manifest's min_node/max_node override the
 * baked-in defaults so a future WASM/prebuild release widens the range without
 * shipping a new CLI.
 */
export const DEFAULT_MIN_NODE = 18;
export const DEFAULT_MAX_NODE = 22;

export function resolveSupportedNodeRange(
  manifest: Pick<ReleaseManifest, 'min_node' | 'max_node'> | null,
): { min: number; max: number; range: string } {
  const min = manifest?.min_node;
  const max = manifest?.max_node;
  if (!Number.isInteger(min) || !Number.isInteger(max) || min! < 1 || max! < min! || max! > 99) {
    return { min: DEFAULT_MIN_NODE, max: DEFAULT_MAX_NODE, range: `${DEFAULT_MIN_NODE}-${DEFAULT_MAX_NODE}` };
  }
  return { min: min!, max: max!, range: `${min}-${max}` };
}

export function checkNodeSupportedForNativeBuild(
  nodeMajor: number,
  manifest: Pick<ReleaseManifest, 'min_node' | 'max_node' | 'supported_node_range'> | null,
): { ok: boolean; min: number; max: number; message?: string } {
  const { min, max, range } = resolveSupportedNodeRange(manifest);
  if (!Number.isInteger(nodeMajor) || nodeMajor < min) {
    return {
      ok: false, min, max,
      message: `Klauro currently supports Node ${range}; you have ${nodeMajor}. Upgrade Node (e.g. \`nvm install ${max} && nvm use ${max}\` or \`volta install node@${max}\`) and re-run.`,
    };
  }
  if (nodeMajor > max) {
    return {
      ok: false, min, max,
      message: `Klauro currently supports Node ${range}; you have ${nodeMajor}. ` +
        `Klauro's native tree-sitter parser does not compile on Node ${max + 1}+ yet. ` +
        `Install a supported Node (e.g. \`nvm install ${max} && nvm use ${max}\` or \`volta install node@${max}\`) and re-run, ` +
        `or set KLAURO_SKIP_NODE_CHECK=1 to bypass at your own risk.`,
    };
  }
  return { ok: true, min, max };
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
    if (latest && latest === current && !options.force) write('You are on the latest version.\n');
    else if (latest && latest !== current) write('A newer version is available. Run: klauro update\n');
    return { status: 'checked', current, latest };
  }

  write(`Current klauro: ${current}\n`);
  write(latest ? `Latest available: ${latest} (${serverUrl})\n` : `Latest available: unknown (could not reach ${serverUrl}/dist/latest.json)\n`);

  if (latest && latest === current && !options.force) {
    write('Already on the latest version. Use --force to reinstall anyway.\n');
    return { status: 'up-to-date', current, latest };
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

  // Node-range gate (same range install.sh enforces, manifest-overridable):
  // node-gyp compiles the native tree-sitter deps against the node that RUNS
  // npm, so gate on that version, before anything downloads.
  const buildNodeVersion = detectBuildNodeVersion(target);
  const buildNodeMajor = Number.parseInt(buildNodeVersion.replace(/^v/, '').split('.')[0], 10);
  const nodeSupport = checkNodeSupportedForNativeBuild(buildNodeMajor, manifest);
  if (!nodeSupport.ok && process.env.KLAURO_SKIP_NODE_CHECK !== '1') {
    throw new Error(`Cannot update: ${nodeSupport.message} (update would build with ${buildNodeVersion} at ${target.nodeBin || process.execPath})`);
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
