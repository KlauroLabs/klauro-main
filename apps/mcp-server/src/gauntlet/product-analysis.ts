
















import { execFileSync, spawn, type ChildProcess } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs-extra';
import { open } from 'fs/promises';
import * as http from 'http';
import { request as httpsRequest } from 'https';
import * as net from 'node:net';
import * as os from 'os';
import * as path from 'path';
import { devDataRoot, reportDevDataDirSizeOnExit } from './dev-data';
import { buildSourceSnapshot, matchExcludedDirectoryName, sourceSnapshotDigest } from '../remote-source';
import { getAnalysisEntry, saveAnalysis } from '../storage';
import type { CASOutput } from '../../../../packages/analyzer-core/src/types/cas.types';
import { getStageFingerprints } from '../../../../packages/analyzer-core/src/analyzer/core/stage-fingerprint';
import { REMOTE_ANALYSIS_PROTOCOL_VERSION } from '../remote-analyzer-protocol';
import { waitForRemoteAnalysis } from '../remote-sync-client';
import { CAS_SECTION_NAMES } from '../cas-sections';
import { benchCasCacheRuntimeFingerprint, readBenchCasCache, writeBenchCasCache } from './bench-cas-cache';
import {
  deriveLocalPackageImportContext,
  LOCAL_PACKAGE_IMPORT_CONTEXT_PATH,
} from '../../../../packages/analyzer-core/src/analyzer/core/local-package-import-context';
import { appendStoredLocalPackageContext } from '../source-snapshot-package-context';

let localServerUrl: string | null = null;
let localServerProcess: ChildProcess | null = null;
let localHttpServer: http.Server | null = null;
let localServerStart: Promise<string> | null = null;
let benchDataDirCleanupRegistered = false;
let benchStoreScoped = false;
let benchProcessStorageDir: string | null = null;
type BenchReadinessRequirement = 'structural' | 'complete';

export interface AnalyzeForBenchOptions {
  readinessRequirement?: BenchReadinessRequirement;
}

const inFlightAnalyses = new Map<string, Promise<CASOutput>>();
const MINIMUM_BENCH_ANALYSIS_TIMEOUT_MS = 180_000;
const DEFAULT_BENCH_ANALYSIS_TIMEOUT_MS = 30 * 60_000;

export function benchAnalysisTimeoutMs(value = process.env.KLAURO_BENCH_ANALYSIS_TIMEOUT_MS): number {
  const configured = Number(value || '');
  return Number.isFinite(configured) && configured >= MINIMUM_BENCH_ANALYSIS_TIMEOUT_MS
    ? configured
    : DEFAULT_BENCH_ANALYSIS_TIMEOUT_MS;
}

export function benchAnalyzerToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.KLAURO_BENCH_ANALYZER_TOKEN || env.KLAURO_ANALYZER_TOKEN;
}











function scopeBenchProcessToDevStore(): void {
  if (benchStoreScoped) return;
  benchStoreScoped = true;
  if (process.env.KLAURO_STORAGE_PATH) return;
  benchProcessStorageDir = path.join(os.tmpdir(), `klauro-bench-storage-${process.pid}`);
  process.env.KLAURO_STORAGE_PATH = path.join(benchProcessStorageDir, 'analyses');
  process.once('exit', () => {
    if (!benchProcessStorageDir) return;
    try { fs.removeSync(benchProcessStorageDir); } catch { }
  });
  reportDevDataDirSizeOnExit();
}

async function ensureProductServer(): Promise<string> {
  const override = process.env.KLAURO_BENCH_ANALYZER_URL;
  if (override) return override.replace(/\/$/, '');
  if (localServerUrl) return localServerUrl;
  if (localServerStart) return localServerStart;

  localServerStart = startProductServer();
  try {
    return await localServerStart;
  } catch (error) {
    localServerStart = null;
    throw error;
  }
}

async function startProductServer(): Promise<string> {

  scopeBenchProcessToDevStore();
  const dataDir = benchProcessStorageDir || path.join(os.tmpdir(), `klauro-bench-storage-${process.pid}`);
  if (!process.env.KLAURO_COORD_DIR) {
    process.env.KLAURO_COORD_DIR = path.join(dataDir, 'coordination');
  }
  const port = await availableLoopbackPort();
  if (process.env.KLAURO_ANALYSIS_IN_PROCESS === '1' || process.env.KLAURO_ANALYSIS_IN_PROCESS === 'true') {
    const serviceModule = await import('../remote-analyzer-service.js');
    const service = (serviceModule as any).default || serviceModule;
    const server = service.createRemoteAnalyzerHttpServer({ dataDir });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
    server.unref();
    localHttpServer = server;
    localServerUrl = `http://127.0.0.1:${port}`;
    registerBenchServerCleanup(dataDir);
    return localServerUrl;
  }
  const entry = path.resolve(__dirname, '..', 'remote-analyzer-service.ts');
  const child = spawn(process.execPath, ['--import', 'tsx', entry], {
    env: {
      ...process.env,
      PORT: String(port),
      KLAURO_REMOTE_ANALYZER_DATA: dataDir,
      KLAURO_STORAGE_PATH: path.join(dataDir, 'analyses'),
      KLAURO_COORD_DIR: path.join(dataDir, 'coordination'),
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  localServerProcess = child;
  child.unref();
  const serverUrl = `http://127.0.0.1:${port}`;
  await waitForLocalServer(serverUrl, child);
  localServerUrl = serverUrl;
  registerBenchServerCleanup(dataDir);
  return localServerUrl;
}

function registerBenchServerCleanup(dataDir: string): void {
  if (benchDataDirCleanupRegistered) return;
  benchDataDirCleanupRegistered = true;
  process.once('exit', () => {
    localServerProcess?.kill('SIGTERM');
    localHttpServer?.close();
    try { fs.removeSync(dataDir); } catch { }
  });
}

async function availableLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (!port) throw new Error('Could not allocate a local analyzer port');
  return port;
}

async function waitForLocalServer(serverUrl: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError = 'server did not answer';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Local analyzer exited with code ${child.exitCode}`);
    try {
      await getJson(`${serverUrl}/health`);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  child.kill('SIGTERM');
  throw new Error(`Local analyzer did not become ready: ${lastError}`);
}

function postJson(url: string, body: unknown): Promise<any> {
  const payload = Buffer.from(JSON.stringify(body));
  const u = new URL(url);



  const token = benchAnalyzerToken();
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









          const buf = Buffer.concat(chunks!);
          chunks = null;
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
  const token = benchAnalyzerToken();
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






export async function analyzeForBench(
  dir: string,
  options: AnalyzeForBenchOptions = {},
): Promise<CASOutput> {
  const readinessRequirement = options.readinessRequirement || 'structural';
  const key = `${path.resolve(dir)}:\0${readinessRequirement}`;
  const existing = inFlightAnalyses.get(key);
  if (existing) return existing;
  const analysis = analyzeForBenchOnce(dir, readinessRequirement);
  inFlightAnalyses.set(key, analysis);
  try {
    return await analysis;
  } finally {
    if (inFlightAnalyses.get(key) === analysis) inFlightAnalyses.delete(key);
  }
}

async function analyzeForBenchOnce(
  dir: string,
  readinessRequirement: BenchReadinessRequirement,
): Promise<CASOutput> {
  scopeBenchProcessToDevStore();



  const staged = await stageAsGitRepo(dir);
  let cacheLock: string | undefined;
  try {
    const snapshot = await buildSourceSnapshot(staged);
    await appendStoredLocalPackageContext(
      staged,
      snapshot.files,
      content => crypto.createHash('sha256').update(content).digest('hex')
    );
    snapshot.files.sort((left, right) => left.path.localeCompare(right.path));
    snapshot.manifest.file_count = snapshot.files.length;
    snapshot.manifest.total_bytes = snapshot.files.reduce((sum, file) => sum + Buffer.byteLength(file.content, 'utf8'), 0);
    snapshot.manifest.snapshot_digest = sourceSnapshotDigest(snapshot.files);
    const cache = readinessRequirement === 'structural'
      ? benchCacheLocation(dir, snapshot.manifest.snapshot_digest)
      : undefined;
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



      project_id: crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 16),
      project_path: dir,
      snapshot,
      async: true,
      force: process.env.KLAURO_BENCH_FORCE_ANALYSIS === '1',
    });
    const immediateCas = response.cas as CASOutput | undefined;
    const cas = readinessRequirement === 'structural' && immediateCas
      ? immediateCas
      : await waitForBenchAnalysis(serverUrl, response, readinessRequirement);














    cas.system.name = path.basename(dir);
    cas.system.id = `system_${cas.system.name}`;
    cas.system.root_path = dir;












    await seedBenchAnalysisIfAbsent(dir, cas);
    if (cache) await writeBenchCache(cache.file, cas);
    return cas;
  } finally {
    if (cacheLock) await fs.remove(cacheLock).catch(() => undefined);
    if (staged !== dir) await fs.remove(staged).catch(() => undefined);
  }
}

async function waitForBenchAnalysis(
  serverUrl: string,
  response: any,
  readinessRequirement: BenchReadinessRequirement,
): Promise<CASOutput> {
  return await waitForRemoteAnalysis(
    serverUrl,
    response.analysis_id,
    benchAnalyzerToken(),
    response.analysis_revision,
    benchAnalysisTimeoutMs(),
    CAS_SECTION_NAMES.filter(section => section !== 'tree'),
    readinessRequirement,
  ) as CASOutput;
}

async function seedBenchAnalysisIfAbsent(dir: string, cas: CASOutput): Promise<void> {
  const existing = await getAnalysisEntry(dir).catch(() => null);
  if (!existing) {
    await saveAnalysis(dir, cas, 'main', { writeSegmentedAnalysis: false }).catch(() => undefined);
  }
}

function benchCacheLocation(dir: string, snapshotDigest: string | undefined): { file: string; lock: string } | undefined {
  if (!snapshotDigest || process.env.KLAURO_BENCH_ANALYZER_URL || process.env.KLAURO_BENCH_DISABLE_CAS_CACHE === '1') return undefined;
  const root = process.env.KLAURO_BENCH_CAS_CACHE_DIR || path.join(devDataRoot(), 'bench-cas-cache');
  const stageFingerprints = getStageFingerprints();
  const key = crypto.createHash('sha256')
    .update(path.resolve(dir))
    .update('\0')
    .update(snapshotDigest)
    .update('\0')
    .update(stageFingerprints.parser_fingerprint)
    .update('\0')
    .update(stageFingerprints.derived_fingerprint)
    .update('\0')
    .update(benchCasCacheRuntimeFingerprint())
    .digest('hex');
  const file = path.join(root, `${key}.cas.v8`);
  return { file, lock: `${file}.lock` };
}

async function readBenchCache(file: string): Promise<CASOutput | undefined> {
  return readBenchCasCache(file);
}

async function writeBenchCache(file: string, cas: CASOutput): Promise<void> {
  await writeBenchCasCache(file, cas);
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
      } catch {   }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  return undefined;
}

export function acceptedBenchCasReady(cas: CASOutput): boolean {
  return cas.layers_ready?.complete === true;
}








function isStagingExcluded(relPath: string): boolean {
  if (!relPath) return false;
  const normalized = relPath.split(path.sep).join('/');
  return normalized.split('/').some((segment) => matchExcludedDirectoryName(segment).excluded);
}


export async function stageAsGitRepo(dir: string): Promise<string> {
  const tmp = path.join(os.tmpdir(), `klauro-bench-src-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const root = path.resolve(dir);
  await fs.copy(dir, tmp, {
    filter: (src) => {
      const rel = path.relative(root, src);
      if (!rel || rel.startsWith('..')) return true;
      return !isStagingExcluded(rel);
    },
  });
  const stagedSnapshot = await buildSourceSnapshot(tmp);
  const context = await deriveLocalPackageImportContext(
    root,
    stagedSnapshot.files.filter(file => file.path !== LOCAL_PACKAGE_IMPORT_CONTEXT_PATH)
  );
  if (context.imports.length > 0) {
    await fs.outputJson(path.join(tmp, LOCAL_PACKAGE_IMPORT_CONTEXT_PATH), context, { spaces: 2 });
  }
  const git = (args: string[]) => execFileSync('git', args, { cwd: tmp, stdio: 'ignore' });
  git(['init', '-q']);
  git(['add', '-A']);
  git(['-c', 'user.email=bench@klauro', '-c', 'user.name=bench', 'commit', '-qm', 'bench fixture']);
  return tmp;
}


export function benchProductMode(): boolean {
  return Boolean(process.env.KLAURO_BENCH_ANALYZER_URL);
}
