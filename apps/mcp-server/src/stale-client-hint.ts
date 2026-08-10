/**
 * Staleness-on-failure hint for the CLI entry points.
 *
 * The 2026-08-09 first-run incident: a customer on an old installed client
 * ran `klauro login --register`, hit a flag-validation error for a flag that
 * works fine in the current release, and had no way to know their CLIENT —
 * not their command — was the problem. The client already knows how to
 * detect its own staleness against a RUNNING MCP server
 * (bundle-staleness.ts's checkRunningBundleStaleness, surfaced by `klauro
 * status`), but nothing said anything when a plain CLI command failed. The
 * owner was stuck on 1.0.127 for weeks with no hint that 1.0.134 existed and
 * fixed the exact thing they hit.
 *
 * This module is deliberately narrow in when it runs: ONLY from a command's
 * top-level failure handler (see main().catch in cli.ts / installed-cli.ts),
 * never before or during a command, and never on success. That keeps the
 * cost off the product's hot path entirely — a customer who runs `klauro
 * analyze` a hundred times a day pays nothing for this, ever. On failure it
 * is still cheap and safe:
 *  - A cached result within CACHE_TTL_MS is reused with zero network I/O, so
 *    a run of failing commands (e.g. a broken CI job retried in a loop)
 *    still only checks the network once per TTL window, not once per
 *    failure.
 *  - A cache miss makes exactly one network request, bounded by
 *    FETCH_TIMEOUT_MS via AbortController, so an offline machine or a
 *    firewalled CI runner can never hang here — the request always resolves
 *    (or aborts) well before a human would notice, and any failure
 *    (offline, DNS, timeout, non-200, malformed JSON) is swallowed into "no
 *    hint" rather than surfaced as a second error.
 *  - The ORIGINAL error is always printed first and always printed
 *    regardless of what this returns; this is an addition to that output,
 *    never a replacement, and a failure inside this module must never mask
 *    or replace the real error.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { authConfigPath } from './connector-auth';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — a failing CLI shouldn't hammer the network, but staleness is also not urgent to re-check every minute.
const DEFAULT_FETCH_TIMEOUT_MS = 1_200;
const FALLBACK_INSTALL_COMMAND = 'curl -fsSL https://mcp.klauro.com/install.sh | sh';

interface UpdateCheckCache {
  checked_at: number;
  latest_version: string | null;
  install_command: string | null;
}

/** Lives beside auth.json (respects KLAURO_AUTH_CONFIG_PATH so tests never
 *  touch the real ~/.klauro), not inside it — this is disposable derived
 *  data, not credentials, and must never be mixed with the account store. */
export function updateCheckCachePath(): string {
  return path.join(path.dirname(authConfigPath()), 'update-check-cache.json');
}

function readCache(): UpdateCheckCache | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(updateCheckCachePath(), 'utf8'));
    if (parsed && typeof parsed.checked_at === 'number') return parsed as UpdateCheckCache;
  } catch {
    // Missing, corrupt, or unreadable: treated as "never checked", which
    // just costs one extra bounded network attempt — never an error.
  }
  return null;
}

function writeCache(cache: UpdateCheckCache): void {
  try {
    fs.mkdirSync(path.dirname(updateCheckCachePath()), { recursive: true });
    fs.writeFileSync(updateCheckCachePath(), JSON.stringify(cache), 'utf8');
  } catch {
    // Best-effort: a machine with a read-only home directory just re-checks
    // (bounded) on every failure instead of caching. Not this module's job
    // to surface that as an error.
  }
}

/** Parses a leading `MAJOR.MINOR.PATCH` and compares numerically — good
 *  enough for this product's version scheme (`1.0.NNN`, no pre-release
 *  suffixes on published releases) without pulling in a semver dependency
 *  for one comparison. Unparseable input on either side means "cannot tell",
 *  never "newer" — silence beats a false positive nag. */
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
    // Offline, DNS failure, connection refused, aborted timeout, or
    // malformed JSON — all indistinguishable from "cannot check right now"
    // to this caller, and all handled the same way: no hint this time.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface StaleClientHintOptions {
  serverUrl: string;
  /** This client's own base version, e.g. "1.0.127" — no `+gitsha` suffix. */
  currentVersion: string;
  now?: number;
  timeoutMs?: number;
}

/**
 * Returns a one-line note to append after a failed command's error, or null
 * when there is nothing worth saying (client is current, or staleness could
 * not be determined). Never throws — every failure path inside resolves to
 * null so this can never turn a working error report into a crash.
 */
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
        // Never successfully checked before, and unreachable right now
        // (e.g. fully offline): say nothing rather than guess.
        return null;
      }
      // else: fetch failed but a stale cache exists — better signal than
      // nothing, and still cheap (no repeated network attempts per failure).
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

/** Reads `--server-url VALUE` straight from argv — used only in the
 *  top-level failure handler, which runs outside each entry point's own
 *  flag-parsing/validation (a parse failure is itself one of the errors
 *  this hint should still be able to attach to), so it cannot depend on
 *  parsed args existing. */
export function extractServerUrlFlag(argv: string[]): string | undefined {
  const index = argv.indexOf('--server-url');
  return index >= 0 ? argv[index + 1] : undefined;
}
