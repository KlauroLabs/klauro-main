import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { loadKlauroConfig, resolveAnalyzerUrl } from './klauro-config';
import { connectorToken, normalizeServerUrl } from './connector-auth';
import { loadAnalysis } from './storage';
import { selectCasSections, type CasSectionName } from './cas-sections';
import { scopeCasToSubCasNode } from './deployable-analysis';































export interface HostedProjectBinding {
  projectPath: string;
  projectId: string;
  serverUrl: string;
  token: string;
  preferLocalCache: boolean;
}

export interface HostedAnalysisStateSummary {
  name?: string | null;
  analysis_timestamp?: string | null;
  [key: string]: unknown;
}


export interface HostedAnalysisState {























  status: 'ready' | 'queryable' | 'populating' | 'degraded' | 'failed' | 'no_analysis';
  project_id?: string;
  analysis_id?: string;
  summary?: HostedAnalysisStateSummary;

  analysis_error?: string;
  failed_layers?: string[];
  error?: string;
}

export type BoundAnalysisSource =
  | 'hosted'
  | 'local-mirror'
  | 'local-cache-degraded';

export interface BoundAnalysisResolution {
  cas: CASOutput;
  source: BoundAnalysisSource;
  hosted_timestamp?: string;

  note?: string;
}

export interface BoundAnalysisOptions {
  sections?: readonly CasSectionName[];
  sub_cas_node_id?: string;
}

export interface AnalysisSourceStamp {
  path: string;
  origin: BoundAnalysisSource;
  project_id: string;
  server_url: string;
  hosted_timestamp?: string;
  note?: string;
  resolved_at: string;
}

export function hostedResolutionEnabled(): boolean {
  return true;
}

function hostedFetchTimeoutMs(): number {
  const parsed = Number(process.env.KLAURO_HOSTED_FETCH_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10_000;
}

function hostedStateTtlMs(): number {
  const parsed = Number(process.env.KLAURO_HOSTED_STATE_TTL_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 20_000;
}







export async function resolveHostedProjectBinding(projectPath: string): Promise<HostedProjectBinding | null> {
  if (!hostedResolutionEnabled()) return null;
  const root = path.resolve(projectPath);
  let loaded;
  try {
    loaded = await loadKlauroConfig(root);
  } catch {
    return null;
  }
  if (!loaded.configPath) return null;
  const projectId = loaded.config.project.id;
  if (!projectId || !/^prj_/.test(projectId)) return null;
  const serverUrl = normalizeServerUrl(resolveAnalyzerUrl(loaded));
  const token = connectorToken(undefined, serverUrl);
  if (!token) return null;
  return {
    projectPath: root,
    projectId,
    serverUrl,
    token,


    preferLocalCache: loaded.config.mcp?.preferLocalCache !== false,
  };
}

interface StateCacheEntry {
  fetched_at: number;
  state: HostedAnalysisState;
}

const hostedStateCache = new Map<string, StateCacheEntry>();

interface SectionCacheEntry {
  cas: Partial<CASOutput>;
  bytes: number;
}

const hostedSectionCache = new Map<string, SectionCacheEntry>();

function hostedSectionCacheMaxEntries(): number {
  const value = Number(process.env.KLAURO_HOSTED_SECTION_CACHE_MAX_ENTRIES);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 24;
}

function hostedSectionCacheMaxBytes(): number {
  const value = Number(process.env.KLAURO_HOSTED_SECTION_CACHE_MAX_BYTES);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 64 * 1024 * 1024;
}

function rememberHostedSections(key: string, entry: SectionCacheEntry): void {
  const retainedEntry = { ...entry, bytes: entry.bytes * 7 };
  hostedSectionCache.delete(key);
  if (retainedEntry.bytes > hostedSectionCacheMaxBytes()) return;
  hostedSectionCache.set(key, retainedEntry);
  let bytes = [...hostedSectionCache.values()].reduce((sum, current) => sum + current.bytes, 0);
  while (hostedSectionCache.size > hostedSectionCacheMaxEntries() || bytes > hostedSectionCacheMaxBytes()) {
    const oldest = hostedSectionCache.keys().next().value as string | undefined;
    if (!oldest) break;
    const removed = hostedSectionCache.get(oldest);
    hostedSectionCache.delete(oldest);
    bytes -= removed?.bytes || 0;
  }
}

export function getHostedSectionCacheStats(): { entries: number; bytes: number; max_entries: number; max_bytes: number } {
  return {
    entries: hostedSectionCache.size,
    bytes: [...hostedSectionCache.values()].reduce((sum, entry) => sum + entry.bytes, 0),
    max_entries: hostedSectionCacheMaxEntries(),
    max_bytes: hostedSectionCacheMaxBytes(),
  };
}

export function clearHostedAnalysisCaches(): void {
  hostedStateCache.clear();
  hostedSectionCache.clear();
  lastResolutionStamp = undefined;
}

async function fetchJson<T>(binding: HostedProjectBinding, route: string): Promise<{ status: number; payload: T | null }> {
  const response = await fetch(`${binding.serverUrl}${route}`, {
    headers: { authorization: `Bearer ${binding.token}` },
    signal: AbortSignal.timeout(hostedFetchTimeoutMs()),
  });
  const payload = await response.json().catch(() => null) as T | null;
  return { status: response.status, payload };
}







export async function fetchHostedAnalysisState(binding: HostedProjectBinding): Promise<HostedAnalysisState> {
  const cacheKey = `${binding.serverUrl}|${binding.projectId}`;
  const cached = hostedStateCache.get(cacheKey);
  if (cached && Date.now() - cached.fetched_at < hostedStateTtlMs()) return cached.state;

  const { status, payload } = await fetchJson<HostedAnalysisState>(
    binding, `/api/projects/${encodeURIComponent(binding.projectId)}/analysis`);
  if (status === 401) throw new Error(`Klauro session for ${binding.serverUrl} is signed out or expired (HTTP 401)`);
  if (status === 404) throw new Error(`Hosted project ${binding.projectId} not found on ${binding.serverUrl} (HTTP 404)`);
  if (status >= 400 || !payload || typeof payload.status !== 'string') {
    throw new Error(`Hosted analysis state request failed (HTTP ${status})`);
  }
  hostedStateCache.set(cacheKey, { fetched_at: Date.now(), state: payload });
  return payload;
}






async function downloadHostedCas(binding: HostedProjectBinding): Promise<
  { kind: 'cas'; cas: CASOutput } | { kind: 'unsupported' } | { kind: 'no_analysis'; detail?: string }
> {
  const response = await fetch(
    `${binding.serverUrl}/api/projects/${encodeURIComponent(binding.projectId)}/cas/export`,
    { headers: { authorization: `Bearer ${binding.token}` }, signal: AbortSignal.timeout(hostedFetchTimeoutMs()) },
  );
  if (response.status === 404 || response.status === 410) return { kind: 'unsupported' };
  if (response.status >= 400) throw new Error(`Hosted CAS export failed (HTTP ${response.status})`);
  const codec = response.headers.get('x-klauro-cas-codec') || 'none';
  const raw = Buffer.from(await response.arrayBuffer());
  let json = raw;
  if (codec === 'zstd') {
    const result = spawnSync('zstd', ['-q', '-d', '-c'], { input: raw, maxBuffer: 1024 * 1024 * 1024 });
    if (result.status !== 0) throw new Error('Hosted CAS export uses zstd but the local zstd decoder is unavailable');
    json = result.stdout;
  }
  try {
    return { kind: 'cas', cas: JSON.parse(json.toString('utf8')) as CASOutput };
  } catch {
    return { kind: 'no_analysis', detail: 'compressed CAS export was not valid JSON' };
  }
}

async function fetchHostedCasSections(
  binding: HostedProjectBinding,
  analysisTimestamp: string | undefined,
  sections: readonly CasSectionName[],
  subCasNodeId?: string,
): Promise<Partial<CASOutput>> {
  const normalized = [...new Set(sections)].sort();
  const cacheKey = `${binding.serverUrl}|${binding.projectId}|${analysisTimestamp || 'unknown'}|${subCasNodeId || 'root'}|${normalized.join(',')}`;
  const cached = hostedSectionCache.get(cacheKey);
  if (cached) {
    hostedSectionCache.delete(cacheKey);
    hostedSectionCache.set(cacheKey, cached);
    return cached.cas;
  }
  const route = `/api/projects/${encodeURIComponent(binding.projectId)}/cas/sections?sections=${encodeURIComponent(normalized.join(','))}${subCasNodeId ? `&sub_cas_node_id=${encodeURIComponent(subCasNodeId)}` : ''}`;
  const response = await fetch(`${binding.serverUrl}${route}`, {
    headers: { authorization: `Bearer ${binding.token}` },
    signal: AbortSignal.timeout(hostedFetchTimeoutMs()),
  });
  const text = await response.text();
  if (response.status >= 400) throw new Error(`Hosted CAS section request failed (HTTP ${response.status})`);
  const payload = JSON.parse(text) as { status?: string; cas?: Partial<CASOutput>; error?: string };
  if (payload.status !== 'ready' || !payload.cas) throw new Error(payload.error || 'Hosted CAS sections are unavailable');
  rememberHostedSections(cacheKey, { cas: payload.cas, bytes: Buffer.byteLength(text) });
  return payload.cas;
}

function timestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: { code?: string } }).cause;
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return 'request timed out';
    return cause?.code ? `${error.message} (${cause.code})` : error.message;
  }
  return String(error);
}

let lastResolutionStamp: AnalysisSourceStamp | undefined;

function stampResolution(binding: HostedProjectBinding, resolution: BoundAnalysisResolution): BoundAnalysisResolution {
  lastResolutionStamp = {
    path: binding.projectPath,
    origin: resolution.source,
    project_id: binding.projectId,
    server_url: binding.serverUrl,
    ...(resolution.hosted_timestamp ? { hosted_timestamp: resolution.hosted_timestamp } : {}),
    ...(resolution.note ? { note: resolution.note } : {}),
    resolved_at: new Date().toISOString(),
  };


  (resolution.cas as CASOutput & { analysis_source?: AnalysisSourceStamp }).analysis_source = lastResolutionStamp;
  return resolution;
}







export function currentAnalysisSourceStamp(): { analysis_source?: AnalysisSourceStamp } {
  if (!lastResolutionStamp) return {};
  const age = Date.now() - Date.parse(lastResolutionStamp.resolved_at);
  if (!Number.isFinite(age) || age > 15_000) return {};
  return { analysis_source: lastResolutionStamp };
}

function sameAnalysis(left: CASOutput, right: CASOutput): boolean {
  return left === right || (left.analysis_id === right.analysis_id && left.analysis_timestamp === right.analysis_timestamp);
}

async function loadLocalCandidates(projectPath: string): Promise<{ preferred: CASOutput | null; main: CASOutput | null }> {



  const preferred = await loadAnalysis(projectPath, { preferCache: true }).catch(() => null);
  const main = await loadAnalysis(projectPath, { preferCache: true, track: 'main' }).catch(() => null);
  return { preferred, main };
}





export async function resolveBoundAnalysis(
  binding: HostedProjectBinding,
  options: BoundAnalysisOptions = {},
): Promise<BoundAnalysisResolution> {
  if (options.sections?.length) {
    try {
      const state = await fetchHostedAnalysisState(binding);
      if (state.status === 'no_analysis') {
        throw new Error(`Hosted project ${binding.projectId} has no analysis yet`);
      }
      const hostedTimestamp = state.summary?.analysis_timestamp || undefined;
      const cas = await fetchHostedCasSections(binding, hostedTimestamp, options.sections, options.sub_cas_node_id);
      return stampResolution(binding, {
        cas: cas as CASOutput,
        source: 'hosted',
        hosted_timestamp: hostedTimestamp || cas.analysis_timestamp,
      });
    } catch (error) {
      const { preferred, main } = await loadLocalCandidates(binding.projectPath);
      const local = preferred || main;
      if (local) {
        const scoped = options.sub_cas_node_id
          ? scopeCasToSubCasNode(local, { sub_cas_node_id: options.sub_cas_node_id })
          : local;
        return stampResolution(binding, {
          cas: selectCasSections(scoped, options.sections) as CASOutput,
          source: 'local-cache-degraded',
          note: `hosted CAS sections unavailable (${describeError(error)}); serving the same sections from local cache ${local.analysis_timestamp || 'unknown date'}`,
        });
      }
      throw new Error(
        `Hosted CAS sections for project ${binding.projectId} are unavailable (${describeError(error)}) and no local cache exists. ` +
        `Refusing to download or reconstruct the full CAS for a section-scoped MCP query.`,
      );
    }
  }

  const { preferred, main } = await loadLocalCandidates(binding.projectPath);
  const local = preferred || main;

  let state: HostedAnalysisState;
  try {
    state = await fetchHostedAnalysisState(binding);
  } catch (error) {
    const reason = describeError(error);
    if (local) {
      return stampResolution(binding, {
        cas: local,
        source: 'local-cache-degraded',
        note: `hosted analysis unavailable (${reason}); serving local cache from ${local.analysis_timestamp || 'unknown date'}`,
      });
    }
    throw new Error(
      `This repo is bound to hosted project ${binding.projectId} but the hosted analysis is unavailable (${reason}) ` +
      `and no local cache exists. Refusing to silently run a local analysis for a project-bound repo — ` +
      `retry when ${binding.serverUrl} is reachable, or run analyze_codebase explicitly to (re)analyze.`
    );
  }

  if (state.status === 'no_analysis') {
    if (local) {
      return stampResolution(binding, {
        cas: local,
        source: 'local-cache-degraded',
        note: `hosted project ${binding.projectId} has no analysis yet; serving local cache from ${local.analysis_timestamp || 'unknown date'} — run analyze_codebase to publish one`,
      });
    }
    throw new Error(
      `Hosted project ${binding.projectId} has no analysis yet and there is no local cache. ` +
      `Run analyze_codebase (or \`klauro analyze .\`) to create one.`
    );
  }

  const hostedTimestamp = state.summary?.analysis_timestamp || undefined;
  const hostedMs = timestampMs(hostedTimestamp);






  if (local && hostedMs !== null) {
    const localMs = timestampMs(local.analysis_timestamp);
    if (localMs !== null) {
      const notOlder = localMs >= hostedMs;
      const exactMirror = localMs === hostedMs;
      if ((binding.preferLocalCache && notOlder) || exactMirror) {
        return stampResolution(binding, {
          cas: local,
          source: 'local-mirror',
          hosted_timestamp: hostedTimestamp,
        });
      }
    }
  }

  if (main && local && !sameAnalysis(main, local) && hostedMs !== null) {
    const mainMs = timestampMs(main.analysis_timestamp);
    if (mainMs !== null && mainMs >= hostedMs) {
      return stampResolution(binding, {
        cas: main,
        source: 'local-mirror',
        hosted_timestamp: hostedTimestamp,
      });
    }
  }

  let download: Awaited<ReturnType<typeof downloadHostedCas>>;
  try {
    download = await downloadHostedCas(binding);
  } catch (error) {
    const reason = describeError(error);
    if (local) {
      return stampResolution(binding, {
        cas: local,
        source: 'local-cache-degraded',
        note: `hosted analysis from ${hostedTimestamp || 'server'} could not be downloaded (${reason}); serving local cache from ${local.analysis_timestamp || 'unknown date'}`,
      });
    }
    throw new Error(
      `Hosted analysis for project ${binding.projectId} exists (${hostedTimestamp || 'timestamp unknown'}) but could not be downloaded (${reason}), ` +
      `and no local cache exists. Refusing to silently run a local analysis for a project-bound repo.`
    );
  }

  if (download.kind === 'unsupported') {
    if (local) {
      return stampResolution(binding, {
        cas: local,
        source: 'local-cache-degraded',
        hosted_timestamp: hostedTimestamp,
        note: `hosted analysis is newer (${hostedTimestamp || 'timestamp unknown'}) but the deployed Klauro server does not expose full-CAS compressed export yet; ` +
          `serving local cache from ${local.analysis_timestamp || 'unknown date'} — update the server or re-run analyze_codebase to refresh`,
      });
    }
    throw new Error(
      `Hosted analysis for project ${binding.projectId} exists (${hostedTimestamp || 'timestamp unknown'}) but the deployed Klauro server ` +
      `does not expose full-CAS compressed export and no local cache exists. ` +
      `Update the server, or run analyze_codebase explicitly.`
    );
  }

  if (download.kind === 'no_analysis') {
    if (local) {
      return stampResolution(binding, {
        cas: local,
        source: 'local-cache-degraded',
        note: `hosted analysis could not be loaded${download.detail ? ` (${download.detail})` : ''}; serving local cache from ${local.analysis_timestamp || 'unknown date'}`,
      });
    }
    throw new Error(`Hosted analysis for project ${binding.projectId} could not be loaded${download.detail ? ` (${download.detail})` : ''} and no local cache exists.`);
  }

  return stampResolution(binding, {
    cas: download.cas,
    source: 'hosted',
    hosted_timestamp: hostedTimestamp || download.cas.analysis_timestamp,
  });
}






export function resolutionIsStaleDegraded(resolution: BoundAnalysisResolution): boolean {
  if (resolution.source !== 'local-cache-degraded') return false;
  if (!resolution.hosted_timestamp) return true;
  const localMs = timestampMs(resolution.cas.analysis_timestamp);
  const hostedMs = timestampMs(resolution.hosted_timestamp);
  if (localMs === null || hostedMs === null) return true;
  return localMs < hostedMs;
}









export async function hostedSummaryPayload(binding: HostedProjectBinding): Promise<Record<string, unknown> | null> {
  try {
    const state = await fetchHostedAnalysisState(binding);
    if (state.status === 'no_analysis' || !state.summary) return null;





    return { ...state.summary, hosted_status: state.status };
  } catch {
    return null;
  }
}

export interface HostedFreshnessComparison {
  bound: true;
  project_id: string;
  server_url: string;
  reachable: boolean;
  hosted_status?: HostedAnalysisState['status'];
  hosted_analysis_timestamp?: string | null;
  local_analysis_timestamp?: string | null;

  status?: 'fresh' | 'stale' | 'no-local-cache';
  reason?: string;
}







export async function compareHostedFreshness(binding: HostedProjectBinding): Promise<HostedFreshnessComparison> {
  const { preferred, main } = await loadLocalCandidates(binding.projectPath);
  const local = preferred || main;
  const localTimestamp = local?.analysis_timestamp || null;
  try {
    const state = await fetchHostedAnalysisState(binding);
    const hostedTimestamp = state.summary?.analysis_timestamp || null;
    const hostedMs = timestampMs(hostedTimestamp);
    const localMs = timestampMs(localTimestamp);
    let status: HostedFreshnessComparison['status'];
    if (state.status === 'no_analysis') status = local ? 'fresh' : 'no-local-cache';
    else if (localMs === null) status = 'no-local-cache';
    else if (hostedMs === null) status = 'fresh';
    else status = localMs >= hostedMs ? 'fresh' : 'stale';
    return {
      bound: true,
      project_id: binding.projectId,
      server_url: binding.serverUrl,
      reachable: true,
      hosted_status: state.status,
      hosted_analysis_timestamp: hostedTimestamp,
      local_analysis_timestamp: localTimestamp,
      status,
    };
  } catch (error) {
    return {
      bound: true,
      project_id: binding.projectId,
      server_url: binding.serverUrl,
      reachable: false,
      local_analysis_timestamp: localTimestamp,
      reason: describeError(error),
    };
  }
}
