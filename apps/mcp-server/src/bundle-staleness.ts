


















import * as fs from 'node:fs';
import * as path from 'node:path';

export interface BundleStaleness {
  stale: boolean;


  note: string | null;
  built_at?: string;
  newest_source_at?: string;
  newest_source_file?: string;
}




const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.git', 'fixtures', '__fixtures__']);



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
      } catch {   }
    }
  };
  walk(sourceRoot);
  return newest;
}



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





const runningStalenessCache = new Map<string, BundleStaleness>();



export function checkRunningBundleStaleness(moduleDir: string, now = Date.now()): BundleStaleness {
  const cached = runningStalenessCache.get(moduleDir);
  if (cached) return cached;
  const distDir = moduleDir;
  const packageRoot = path.resolve(distDir, '..');
  const result = checkBundleStaleness({ distDir, sourceRoot: path.join(packageRoot, 'src'), now });
  runningStalenessCache.set(moduleDir, result);
  return result;
}
