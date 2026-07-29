/**
 * Stale-bundle guard for the MCP entry point.
 *
 * MCP clients are registered against the BUILT bundle (dist/index.cjs), not
 * the sources. A developer checkout therefore has two versions of the product
 * on disk at once, and nothing forces them to agree: sources can change, the
 * server contract with them, and the registered client keeps serving whatever
 * was last built — silently, because a bundle that is merely old still starts,
 * still answers `initialize`, and still lists tools.
 *
 * This makes that divergence say so. It is deliberately a warning and not a
 * refusal: refusing to start would leave the client with no tools at all and
 * no way to report why, which is worse than a stale-but-working client that
 * announces its own staleness.
 *
 * Sources are absent from a customer install, so the check no-ops there;
 * customer-side version drift is covered separately by the installed-version
 * comparison in installed-client-runtime.ts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface BundleStaleness {
  stale: boolean;
  /** Human-readable note, or null when the bundle is current or the check
   *  does not apply (no sources on disk — a customer install). */
  note: string | null;
  built_at?: string;
  newest_source_at?: string;
  newest_source_file?: string;
}

/** Extensions that change what the server does. Fixtures, docs, and build
 *  artifacts are excluded so ordinary repo churn cannot produce a permanent
 *  false "stale" that trains everyone to ignore the warning. */
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.git', 'fixtures', '__fixtures__']);

/** Newest modification time across the source tree, ignoring tests: a test
 *  edit does not change the contract the bundle serves. */
export function newestSourceMtime(sourceRoot: string): { mtimeMs: number; file: string } | null {
  let newest: { mtimeMs: number; file: string } | null = null;
  const walk = (directory: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.integration.ts')) continue;
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
      try {
        const stats = fs.statSync(absolute);
        if (!newest || stats.mtimeMs > newest.mtimeMs) newest = { mtimeMs: stats.mtimeMs, file: absolute };
      } catch { /* a file that vanished mid-walk cannot make the bundle stale */ }
    }
  };
  walk(sourceRoot);
  return newest;
}

/** Grace period before a newer source counts as staleness. Absorbs the
 *  ordinary case of a file touched seconds after the build finished. */
const STALENESS_GRACE_MS = 60_000;

export function checkBundleStaleness(options: {
  distDir: string;
  sourceRoot: string;
  now?: number;
}): BundleStaleness {
  const stampPath = path.join(options.distDir, 'build-stamp.json');
  let stamp: { build_time?: string; git_sha?: string; version?: string };
  try {
    stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
  } catch {
    // No stamp: either a bundle predating this guard or a partial build.
    // Both are exactly the condition worth reporting, but only where sources
    // exist to compare against.
    if (!fs.existsSync(options.sourceRoot)) return { stale: false, note: null };
    return {
      stale: true,
      note: `This Klauro MCP server was built without a build stamp (${stampPath} is missing or unreadable), so its age cannot be verified against the sources beside it. Rebuild with \`npm --prefix apps/mcp-server run build\` and restart the MCP client.`,
    };
  }

  if (!fs.existsSync(options.sourceRoot)) return { stale: false, note: null, built_at: stamp.build_time };

  const builtAtMs = stamp.build_time ? Date.parse(stamp.build_time) : NaN;
  if (!Number.isFinite(builtAtMs)) {
    return {
      stale: true,
      note: `This Klauro MCP server's build stamp has no usable build time, so its age cannot be verified. Rebuild with \`npm --prefix apps/mcp-server run build\` and restart the MCP client.`,
    };
  }

  const newest = newestSourceMtime(options.sourceRoot);
  if (!newest) return { stale: false, note: null, built_at: stamp.build_time };
  if (newest.mtimeMs <= builtAtMs + STALENESS_GRACE_MS) {
    return { stale: false, note: null, built_at: stamp.build_time, newest_source_at: new Date(newest.mtimeMs).toISOString() };
  }

  const ageHours = Math.round((newest.mtimeMs - builtAtMs) / 3_600_000 * 10) / 10;
  return {
    stale: true,
    built_at: stamp.build_time,
    newest_source_at: new Date(newest.mtimeMs).toISOString(),
    newest_source_file: path.relative(path.dirname(options.sourceRoot), newest.file),
    note:
      `This Klauro MCP server is running a bundle built at ${stamp.build_time}` +
      `${stamp.git_sha ? ` (${stamp.git_sha})` : ''}, but its sources changed ${ageHours}h later ` +
      `(most recently ${path.basename(newest.file)}). The running client may not match the server contract it was built against. ` +
      `Rebuild with \`npm --prefix apps/mcp-server run build\` and restart the MCP client.`,
  };
}

/** Cached per module directory. The check walks the source tree, and it is
 *  read on an agent's orientation path — a bundle cannot become current while
 *  the process built from it keeps running, so recomputing it per call would
 *  buy nothing and spend latency. */
const runningStalenessCache = new Map<string, BundleStaleness>();

/** Resolve the check for the running bundle: dist/ is where this module was
 *  bundled to, and src/ is its sibling in a developer checkout. */
export function checkRunningBundleStaleness(moduleDir: string, now = Date.now()): BundleStaleness {
  const cached = runningStalenessCache.get(moduleDir);
  if (cached) return cached;
  const distDir = moduleDir;
  const packageRoot = path.resolve(distDir, '..');
  const result = checkBundleStaleness({ distDir, sourceRoot: path.join(packageRoot, 'src'), now });
  runningStalenessCache.set(moduleDir, result);
  return result;
}
