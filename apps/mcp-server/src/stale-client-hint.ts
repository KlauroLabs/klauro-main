

































import * as fs from 'node:fs';
import * as path from 'node:path';
import { authConfigPath } from './connector-auth';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 1_200;
const FALLBACK_INSTALL_COMMAND = 'curl -fsSL https://mcp.klauro.com/install.sh | sh';

interface UpdateCheckCache {
  checked_at: number;
  latest_version: string | null;
  install_command: string | null;
}




export function updateCheckCachePath(): string {
  return path.join(path.dirname(authConfigPath()), 'update-check-cache.json');
}

function readCache(): UpdateCheckCache | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(updateCheckCachePath(), 'utf8'));
    if (parsed && typeof parsed.checked_at === 'number') return parsed as UpdateCheckCache;
  } catch {


  }
  return null;
}

function writeCache(cache: UpdateCheckCache): void {
  try {
    fs.mkdirSync(path.dirname(updateCheckCachePath()), { recursive: true });
    fs.writeFileSync(updateCheckCachePath(), JSON.stringify(cache), 'utf8');
  } catch {



  }
}






export function isNewerVersion(candidate: string | null | undefined, current: string | null | undefined): boolean {
  const parse = (value: string | null | undefined): [number, number, number] | null => {
    const match = typeof value === 'string' ? value.trim().match(/^(\d+)\.(\d+)\.(\d+)/) : null;
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

async function fetchLatestManifest(
  serverUrl: string,
  timeoutMs: number,
): Promise<{ version: string | null; install_command: string | null } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${serverUrl.replace(/\/+$/, '')}/dist/latest.json`, { signal: controller.signal });
    if (!response.ok) return null;
    const payload = (await response.json()) as { version?: string; install_command?: string };
    return {
      version: typeof payload.version === 'string' ? payload.version : null,
      install_command: typeof payload.install_command === 'string' ? payload.install_command : null,
    };
  } catch {



    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface StaleClientHintOptions {
  serverUrl: string;

  currentVersion: string;
  now?: number;
  timeoutMs?: number;
}







export async function getStaleClientUpdateHint(options: StaleClientHintOptions): Promise<string | null> {
  const now = options.now ?? Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  try {
    let cache = readCache();
    const cacheIsFresh = Boolean(cache) && now - (cache as UpdateCheckCache).checked_at <= CACHE_TTL_MS;
    if (!cacheIsFresh) {
      const fetched = await fetchLatestManifest(options.serverUrl, timeoutMs);
      if (fetched) {
        cache = { checked_at: now, latest_version: fetched.version, install_command: fetched.install_command };
        writeCache(cache);
      } else if (!cache) {


        return null;
      }


    }
    if (!cache?.latest_version) return null;
    if (!isNewerVersion(cache.latest_version, options.currentVersion)) return null;
    const install = cache.install_command || FALLBACK_INSTALL_COMMAND;
    return (
      `Note: this klauro client is ${options.currentVersion}, older than the current release (${cache.latest_version}). ` +
      `Run \`klauro update\` to update. If that command does not work on this build, reinstall: ${install}`
    );
  } catch {
    return null;
  }
}






export function extractServerUrlFlag(argv: string[]): string | undefined {
  const index = argv.indexOf('--server-url');
  return index >= 0 ? argv[index + 1] : undefined;
}
