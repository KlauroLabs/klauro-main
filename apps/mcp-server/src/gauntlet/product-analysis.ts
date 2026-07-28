/**
 * The ONE way the gauntlet/harness gets a Klauro analysis — through the product,
 * as a blackbox client. The harness never imports the analyzer engine, never knows
 * AI exists, never sets a model. It asks the product to analyze and reads the result.
 *
 * Transport: the product's analyzer-server over HTTP.
 *   - Default (offline/CI): an in-process analyzer-server on localhost (the product's
 *     own server, which internally decides what runs where — that seam is invisible
 *     here). Started once, reused.
 *   - KLAURO_BENCH_ANALYZER_URL set: route to that server instead (e.g. the live VPS
 *     for a real product run).
 *
 * Whatever AI the product does happens inside the server with the server's own config;
 * if it degrades, the product still returns an analysis and the harness simply measures
 * what it got. See docs/KLAURO-PRODUCT-MODEL.md and the blackbox-testing principle.
 */

import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs-extra';
import { open } from 'fs/promises';
import * as http from 'http';
import { request as httpsRequest } from 'https';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { gzip, gunzip } from 'zlib';
import { createRemoteAnalyzerHttpServer } from '../remote-analyzer-service';
import { devDataRoot, reportDevDataDirSizeOnExit } from './dev-data';
import { buildSourceSnapshot, EXCLUDED_DIRECTORIES } from '../remote-source';
import { getAnalysisEntry, saveAnalysis } from '../storage';
import { getAnalysis } from '../analyzer';
import type { CASOutput } from '../../../../packages/analyzer-core/src/types/cas.types';
import { getStageFingerprints } from '../../../../packages/analyzer-core/src/analyzer/core/stage-fingerprint';
import { REMOTE_ANALYSIS_PROTOCOL_VERSION } from '../remote-analyzer-protocol';

let localServerUrl: string | null = null;
let localServerDataDir: string | null = null;
let benchDataDirCleanupRegistered = false;
let benchStoreScoped = false;
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/**
 * Dev-tooling hygiene: bench/corpus runs previously seeded every analyzed
 * repo's FULL CAS into the user's real local store (~/.klauro/analyses grew to
 * 29GB from corpus sweeps). A process that calls analyzeForBench is by
 * definition a dev/bench process, so scope its ENTIRE analysis store to the
 * one explicit dev-data dir instead — unless the caller already pointed
 * KLAURO_STORAGE_PATH somewhere on purpose (tests, VPS). The real store is
 * never written by a bench run. The dir's size is printed at process exit so
 * growth is visible, and it is safe to delete wholesale at any time.
 */
function scopeBenchProcessToDevStore(): void {
  if (benchStoreScoped) return;
  benchStoreScoped = true;
  if (process.env.KLAURO_STORAGE_PATH) return; // explicit store — respect it
  process.env.KLAURO_STORAGE_PATH = path.join(devDataRoot(), 'analyses');
  reportDevDataDirSizeOnExit();
}

async function ensureProductServer(): Promise<string> {
  const override = process.env.KLAURO_BENCH_ANALYZER_URL;
  if (override) return override.replace(/\/$/, '');
  if (localServerUrl) return localServerUrl;
  // The product's own analyzer-server, in-process, no shared token (open) — the
  // harness talks to it over HTTP exactly like any client. It is the product, not
  // the engine: the harness does not reach inside it.
  const dataDir = path.join(os.tmpdir(), `klauro-bench-analyzer-${process.pid}`);
  localServerDataDir = dataDir;
  if (!process.env.KLAURO_COORD_DIR) {
    process.env.KLAURO_COORD_DIR = path.join(dataDir, 'coordination');
  }
  // Scratch hygiene: the in-process bench server's data dir (uploaded source
  // snapshots + intermediate CASes) is tmpdir-scoped AND removed on process
  // exit, so repeated bench runs never accumulate durable source mirrors.
  if (!benchDataDirCleanupRegistered) {
    benchDataDirCleanupRegistered = true;
    process.once('exit', () => {
      try { fs.removeSync(dataDir); } catch { /* best-effort */ }
    });
  }
  const server = createRemoteAnalyzerHttpServer({ dataDir });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  server.unref?.();
  localServerUrl = `http://127.0.0.1:${port}`;
  return localServerUrl;
}

function postJson(url: string, body: unknown): Promise<any> {
  const payload = Buffer.from(JSON.stringify(body));
  const u = new URL(url);
  // When pointed at the deployed product (KLAURO_BENCH_ANALYZER_URL), authenticate
  // exactly like a real client: the hosted analyzer requires a bearer token. The
  // in-process bench server is open (no token), so this header is simply absent there.
  const token = process.env.KLAURO_BENCH_ANALYZER_TOKEN;
  const headers: Record<string, string | number> = { 'content-type': 'application/json', 'content-length': payload.length };
  if (token) headers['authorization'] = `Bearer ${token}`;
  const isHttps = u.protocol === 'https:';
  const transport = isHttps ? httpsRequest : http.request;
  return new Promise((resolve, reject) => {
    const req = transport(
      { hostname: u.hostname, port: u.port || (isHttps ? 443 : 80), path: u.pathname, method: 'POST', headers },
      (res: any) => {
        let chunks: Buffer[] | null = [];
        res.on('data', (c: Buffer) => chunks!.push(c));
        res.on('end', () => {
          // Large CAS payloads (huge repos, e.g. Klauro's own 14GB self-repo) can
          // make chunks+concatenated-buffer+utf8-string+parsed-object all live at
          // once, tripling/quadrupling peak memory over the wire size and risking
          // a V8 OOM that a try/catch cannot recover from (fatal allocation
          // failure, not a JS exception). Drop each intermediate reference as soon
          // as the next stage is built so only one large representation is ever
          // live at a time; the driver process is also started with a raised
          // --max-old-space-size (see run() below) so a single oversized repo
          // can't take the whole sweep down.
          const buf = Buffer.concat(chunks!);
          chunks = null; // release the chunk array before building the string
          const text = buf.toString('utf8');
          const statusCode = res.statusCode || 0;
          if (statusCode >= 400) return reject(new Error(`analyze ${statusCode}: ${text.slice(0, 200)}`));
          try {
            const parsed = JSON.parse(text);
            resolve(parsed);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function getJson(url: string): Promise<any> {
  const u = new URL(url);
  const isHttps = u.protocol === 'https:';
  const transport = isHttps ? httpsRequest : http.request;
  const token = process.env.KLAURO_BENCH_ANALYZER_TOKEN;
  return new Promise((resolve, reject) => {
    const req = transport({
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      method: 'GET',
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }, (res: any) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if ((res.statusCode || 0) >= 400) {
          reject(new Error(`status ${res.statusCode}: ${text.slice(0, 200)}`));
          return;
        }
        try { resolve(text ? JSON.parse(text) : {}); } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Ask the product to analyze a directory and return its CAS. Blackbox: builds the
 * source snapshot the product client would send, posts it to the product's analyzer
 * server, and returns what comes back. No engine, no AI, no model — ever.
 */
export async function analyzeForBench(dir: string): Promise<CASOutput> {
  scopeBenchProcessToDevStore();
  // The product analyzes committed source. Fixtures aren't standalone git repos, so
  // stage them in a throwaway git repo first (the customer always has a git repo);
  // the checked-in fixture is never mutated.
  const staged = await stageAsGitRepo(dir);
  let cacheLock: string | undefined;
  try {
    const snapshot = await buildSourceSnapshot(staged);
    const cache = benchCacheLocation(dir, snapshot.manifest.snapshot_digest);
    if (cache) {
      const cached = await readBenchCache(cache.file);
      if (cached) {
        await seedBenchAnalysisIfAbsent(dir, cached);
        return cached;
      }
      cacheLock = await acquireBenchCacheLock(cache.lock, cache.file);
      if (!cacheLock) {
        const filledWhileWaiting = await readBenchCache(cache.file);
        if (filledWhileWaiting) {
          await seedBenchAnalysisIfAbsent(dir, filledWhileWaiting);
          return filledWhileWaiting;
        }
      }
    }

    const serverUrl = await ensureProductServer();
    const response = await postJson(`${serverUrl}/v1/analyze`, {
      protocol_version: REMOTE_ANALYSIS_PROTOCOL_VERSION,
      // Unique per source dir: the shared in-process server keys its incremental
      // cache/workspace on project_id, so sibling repos with the same basename
      // (was-bench ui/api/worker) must NOT collide, or one poisons the other's CAS.
      project_id: crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 16),
      project_path: dir,
      snapshot,
      async: true,
    });
    const cas = response.cas as CASOutput || await waitForAcceptedBenchAnalysis(response.analysis_id);
    // The analyzer server names/identifies the system from the STAGED copy's own
    // path (a throwaway git repo under a temp dir, e.g.
    // `.../klauro-bench-analyzer-<pid>/workspaces/<hash>`), since that's the only
    // path it ever sees — it has no idea `dir` is the caller's real, original
    // path. Left uncorrected, `system.name`/`system.id`/`system.root_path` are
    // hash-shaped garbage (the staged dir's basename) instead of the real
    // project's name, and that WRONG identity gets persisted into the real
    // project's on-disk analysis entry below (keyed by `dir`) — so any agent
    // later resolving an analysis for `dir` sees a fabricated hash name instead
    // of its own project. Same defect class + same fix as
    // remote-sync-client.ts's `rewriteCasProjectName` (remote analyzer, same
    // "server only knows the uploaded path" root cause). Repro: analyze a real
    // repo through this harness, then `get_summary`/`resolve_agent_analysis` on
    // `dir` shows `name: "<hash>"` instead of `path.basename(dir)`.
    cas.system.name = path.basename(dir);
    cas.system.id = `system_${cas.system.name}`;
    cas.system.root_path = dir;
    // Seed the local cache keyed by the ORIGINAL dir so getAnalysis(dir)/the MCP
    // find it — but ONLY when no analysis is already stored for that dir. The
    // harness is a blackbox READ-side consumer: it must never downgrade the real
    // store. This bench run analyzes a staged throwaway copy, with the server's
    // own (often AI-less) config, so overwriting an existing analysis would stamp
    // fresh `description_generation: ai_skipped/no-ai-provider-configured`
    // provenance + a new analysis_timestamp over a previously enriched analysis
    // (observed clobbering soon-bos/soon-decrypter/Finance-Context via the
    // usefulness-review sweep). Writes to the stored CAS belong to explicit
    // analyze/enrichment entry points (analyzeProject/runAnalysis) only; the
    // seed-if-absent below cannot destroy any provenance because the slot is
    // empty. Callers always get the fresh `cas` in-memory regardless.
    await seedBenchAnalysisIfAbsent(dir, cas);
    if (cache) await writeBenchCache(cache.file, cas);
    return cas;
  } finally {
    if (cacheLock) await fs.remove(cacheLock).catch(() => undefined);
    if (staged !== dir) await fs.remove(staged).catch(() => undefined);
  }
}

async function seedBenchAnalysisIfAbsent(dir: string, cas: CASOutput): Promise<void> {
  const existing = await getAnalysisEntry(dir).catch(() => null);
  if (!existing) await saveAnalysis(dir, cas).catch(() => undefined);
}

function benchCacheLocation(dir: string, snapshotDigest: string | undefined): { file: string; lock: string } | undefined {
  const root = process.env.KLAURO_BENCH_CAS_CACHE_DIR;
  if (!root || !snapshotDigest || process.env.KLAURO_BENCH_ANALYZER_URL) return undefined;
  const stageFingerprints = getStageFingerprints();
  const key = crypto.createHash('sha256')
    .update(path.resolve(dir))
    .update('\0')
    .update(snapshotDigest)
    .update('\0')
    .update(stageFingerprints.parser_fingerprint)
    .update('\0')
    .update(stageFingerprints.derived_fingerprint)
    .digest('hex');
  const file = path.join(root, `${key}.cas.json.gz`);
  return { file, lock: `${file}.lock` };
}

async function readBenchCache(file: string): Promise<CASOutput | undefined> {
  try {
    return JSON.parse((await gunzipAsync(await fs.readFile(file))).toString('utf8')) as CASOutput;
  } catch {
    return undefined;
  }
}

async function writeBenchCache(file: string, cas: CASOutput): Promise<void> {
  await fs.mkdirp(path.dirname(file));
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, await gzipAsync(Buffer.from(JSON.stringify(cas), 'utf8')));
    await fs.rename(temporary, file);
  } finally {
    await fs.remove(temporary).catch(() => undefined);
  }
}

async function acquireBenchCacheLock(lock: string, cacheFile: string): Promise<string | undefined> {
  await fs.mkdirp(path.dirname(lock));
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (await fs.pathExists(cacheFile)) return undefined;
    try {
      const handle = await open(lock, 'wx');
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      return lock;
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      if (await fs.pathExists(cacheFile)) return undefined;
      try {
        const lockStat = await fs.stat(lock);
        if (Date.now() - lockStat.mtimeMs > 300_000) await fs.remove(lock);
      } catch { /* another process completed or refreshed the lock */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  return undefined;
}

async function waitForAcceptedBenchAnalysis(analysisId: string): Promise<CASOutput> {
  if (!analysisId) throw new Error('Klauro analyzer accepted the benchmark source without returning an analysis_id');
  if (!localServerDataDir) {
    throw new Error('Hosted benchmark analysis was accepted asynchronously; configure the hosted project query path before reading its CAS');
  }
  const workspace = path.join(localServerDataDir, 'workspaces', analysisId);
  const deadline = Date.now() + 180_000;
  let lastError = 'analysis has not been persisted yet';
  while (Date.now() < deadline) {
    try {
      const status = await getJson(`${localServerUrl}/v1/analyses/${encodeURIComponent(analysisId)}/status`);
      if (status.status === 'failed') {
        throw new Error(`analysis failed: ${JSON.stringify(status.failed_layers || status)}`);
      }
      if (status.status !== 'ready') {
        lastError = `analysis status is ${status.status || 'unknown'}`;
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }
      const cas = await getAnalysis(workspace);
      const failedLayer = cas.layers_ready?.layers?.find(layer => layer.status === 'error');
      if (failedLayer) {
        throw new Error(`Klauro benchmark analysis failed at ${failedLayer.layer}: ${failedLayer.error || cas.ai_enrichment_error || 'unknown error'}`);
      }
      if (cas.layers_ready?.complete === true && cas.nodes?.length > 0) return cas;
      lastError = 'analysis is still populating';
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for accepted Klauro benchmark analysis ${analysisId}: ${lastError}`);
}

// Directory basenames never worth staging into the throwaway bench repo: VCS
// metadata plus build-artifact/dependency dirs (node_modules, target, dist, ...).
// Reuses remote-source.ts's EXCLUDED_DIRECTORIES — the same list that determines
// what the product's own source snapshot would exclude anyway — so the copy filter
// can't drop anything the snapshot walk would have kept, and can't diverge from it
// over time. `.git` is added on top since EXCLUDED_DIRECTORIES already has it, but
// we keep the explicit check below for clarity/safety even if that list changes.
const STAGING_EXCLUDED_DIR_NAMES = new Set([...EXCLUDED_DIRECTORIES, '.git']);

/**
 * True when `relPath` (relative to the repo root being staged, using forward
 * slashes) falls inside a directory we should never copy. Checks every path
 * segment, not just the basename, so `foo/node_modules/bar` is excluded too.
 */
function isStagingExcluded(relPath: string): boolean {
  if (!relPath) return false;
  const normalized = relPath.split(path.sep).join('/');
  return normalized.split('/').some((segment) => STAGING_EXCLUDED_DIR_NAMES.has(segment));
}

/** If dir is already a clean git repo, use it; else copy to a temp git repo + commit. */
async function stageAsGitRepo(dir: string): Promise<string> {
  const tmp = path.join(os.tmpdir(), `klauro-bench-src-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const root = path.resolve(dir);
  await fs.copy(dir, tmp, {
    filter: (src) => {
      const rel = path.relative(root, src);
      if (!rel || rel.startsWith('..')) return true; // root itself
      return !isStagingExcluded(rel);
    },
  });
  const git = (args: string[]) => execFileSync('git', args, { cwd: tmp, stdio: 'ignore' });
  git(['init', '-q']);
  git(['add', '-A']);
  git(['-c', 'user.email=bench@klauro', '-c', 'user.name=bench', 'commit', '-qm', 'bench fixture']);
  return tmp;
}

/** True when the harness is pointed at an external product server (e.g. the live VPS). */
export function benchProductMode(): boolean {
  return Boolean(process.env.KLAURO_BENCH_ANALYZER_URL);
}
