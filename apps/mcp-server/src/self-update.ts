import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { getBuildIdentity } from '../../../packages/analyzer-core/src/analyzer/core/build-identity';
import { listActiveSessions } from './session-lock';
import { isNewerVersion } from './stale-client-hint';

















export interface ReleaseManifest {
  version: string | null;
  tarball_sha256?: string;
  tarball?: string;
  tarball_path?: string;
  min_node?: number;
  max_node?: number;
  supported_node_range?: string;
  published_at?: string | null;






  binaries?: Record<string, { path: string; sha256: string }>;
}




export const SELF_UPDATE_COMMANDS = ['update', 'upgrade', 'self-update'] as const;



export const KLAURO_INSTALL_ONELINER = 'curl -fsSL https://mcp.klauro.com/install.sh | sh';
























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







export function resolveTarballUrl(serverUrl: string, manifest: ReleaseManifest | null): string {
  const base = serverUrl.replace(/\/+$/, '');
  const explicit = manifest?.tarball?.trim();
  if (explicit) return /^https?:\/\//i.test(explicit) ? explicit : `${base}${explicit.startsWith('/') ? '' : '/'}${explicit}`;
  const relative = manifest?.tarball_path?.trim();
  if (relative) return /^https?:\/\//i.test(relative) ? relative : `${base}${relative.startsWith('/') ? '' : '/'}${relative}`;
  return `${base}/dist/klauro-latest.tgz`;
}


export async function downloadVerifiedTarball(
  tarballUrl: string,
  expectedSha256: string | undefined,
): Promise<{ directory: string; file: string }> {
  if (!/^[0-9a-f]{64}$/i.test(String(expectedSha256 || ''))) {
    throw new Error('The release manifest has no valid npm tarball SHA-256 digest; refusing an unverified update.');
  }
  const response = await fetch(tarballUrl, { headers: { 'cache-control': 'no-cache' } });
  if (!response.ok) throw new Error(`Failed to download the update tarball (HTTP ${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actualSha256 = createHash('sha256').update(bytes).digest('hex');
  if (actualSha256 !== expectedSha256!.toLowerCase()) {
    throw new Error('The downloaded npm tarball checksum does not match the release manifest; the existing installation was left unchanged.');
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-update-'));
  const file = path.join(directory, 'klauro.tgz');
  try {
    fs.writeFileSync(file, bytes, { flag: 'wx' });
    return { directory, file };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}





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

    }
  }
  if (!prefix) {
    prefix = platform === 'win32' ? p.dirname(execPath) : p.resolve(p.dirname(execPath), '..');
  }



  const prefixBinDir = platform === 'win32' ? prefix : p.join(prefix, 'bin');
  const prefixNpm = p.join(prefixBinDir, platform === 'win32' ? 'npm.cmd' : 'npm');
  const prefixNode = p.join(prefixBinDir, platform === 'win32' ? 'node.exe' : 'node');
  if (exists(prefixNpm)) {
    return {
      npmBin: prefixNpm,



      nodeBin: exists(prefixNode) ? prefixNode : undefined,
      prefix,
      prefixSource,
    };
  }
  const execNpm = p.join(p.dirname(execPath), platform === 'win32' ? 'npm.cmd' : 'npm');
  return { npmBin: exists(execNpm) ? execNpm : 'npm', prefix, prefixSource };
}







export function detectBuildNodeVersion(
  target: { nodeBin?: string },
  options: { processVersion?: string } = {},
): string {
  const fallback = options.processVersion ?? process.version;
  if (!target.nodeBin) return fallback;
  const out = (spawnSync(target.nodeBin, ['-v'], { encoding: 'utf8', timeout: 10000 }).stdout || '').trim();
  return out || fallback;
}














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

  serverUrl: string;

  checkOnly?: boolean;

  force?: boolean;

  json?: boolean;
  write?: (text: string) => void;
}

export interface SelfUpdateResult {
  status: 'checked' | 'up-to-date' | 'updated';
  current: string;
  latest: string | null;
  prefix?: string;
}






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





    if (latest && !isNewerVersion(latest, current)) write('You are on the latest version.\n');
    else if (latest && isNewerVersion(latest, current)) write('A newer version is available. Run: klauro update\n');
    return { status: 'checked', current, latest };
  }

  write(`Current klauro: ${current}\n`);
  write(latest ? `Latest available: ${latest} (${serverUrl})\n` : `Latest available: unknown (could not reach ${serverUrl}/dist/latest.json)\n`);

  if (latest && !isNewerVersion(latest, current) && !options.force) {







    write(latest === current ? 'Already on the latest version. Use --force to reinstall anyway.\n' : `This client (${current}) is already ahead of what ${serverUrl} advertises (${latest}) — not downgrading. Use --force to install it anyway.\n`);
    return { status: 'up-to-date', current, latest };
  }





  if (isRunningAsSeaBinary()) {
    return runBinarySelfUpdate({ serverUrl, manifest, current, latest, write, json: options.json });
  }





  const sessionsBeforeUpdate = listActiveSessions();
  const tarballUrl = resolveTarballUrl(serverUrl, manifest);


  const target = resolveSelfUpdateTarget();



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
  const verifiedTarball = await downloadVerifiedTarball(tarballUrl, manifest?.tarball_sha256);
  const installArgs = ['install', '-g', verifiedTarball.file, '--force', '--prefix', target.prefix];
  const installEnv = buildUpdateSpawnEnv(target);
  let result;
  try {
    result = target.nodeBin
      ? spawnSync(target.nodeBin, [target.npmBin, ...installArgs], {
        stdio: ['inherit', 'pipe', 'pipe'], encoding: 'utf8', env: installEnv,
      })
      : spawnSync(target.npmBin, installArgs, {
        stdio: ['inherit', 'pipe', 'pipe'], encoding: 'utf8', shell: process.platform === 'win32', env: installEnv,
      });
  } finally {
    fs.rmSync(verifiedTarball.directory, { recursive: true, force: true });
  }
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















export function isRunningAsSeaBinary(): boolean {
  try {

    return (require('node:sea') as { isSea(): boolean }).isSea();
  } catch {
    return false;
  }
}





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









    const oldAside = `${runningPath}.old-${process.pid}`;
    fs.renameSync(runningPath, oldAside);
    fs.renameSync(tmpPath, runningPath);
    try { fs.unlinkSync(oldAside); } catch {   }
  } else {




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
