import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import type { CASOutput, CASNode } from '../../../packages/analyzer-core/src/types/cas.types';
import {
  correlateRuntimeEvent,
  pathsCompatible,
  runtimeImpactStats,
  runtimeObservationSource,
  type RuntimeEventInput,
  type RuntimeObservation,
  type RuntimeObservationSource,
} from './product';
import { getProjectStorageDir, loadRuntimeObservations } from './storage';

export const TELEMETRY_SCHEMA_VERSION = 'ingested-1';
const MAX_BATCH_SIZE = 1000;
const MAX_OBSERVATIONS_PER_DAY = 5000;
const RETENTION_DAYS = 14;
const INGESTED_DIR = 'ingested-telemetry';

export interface TelemetryStackFrame {
  file: string;
  line?: number;
  function?: string;
}

export interface TelemetryEvent {
  kind: 'request' | 'error' | 'log' | 'metric';
  timestamp?: string;
  name?: string;
  service_name?: string;
  environment?: string;
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string;
  method?: string;
  route?: string;
  path?: string;
  status?: number;
  duration_ms?: number;
  p95_ms?: number;
  p99_ms?: number;
  function_hint?: string;
  file_hint?: string;
  error?: {
    type?: string;
    message?: string;
    stack_top_frames?: Array<TelemetryStackFrame | string>;
  };
  volume?: number;
  rate_per_min?: number;
  window_ms?: number;
  attributes?: Record<string, unknown>;
}

export interface TelemetryIngestionResult {
  ingestion_id: string;
  received_at: string;
  source: 'ingested';
  event_count: number;
  persisted: boolean;
  correlation_summary: {
    matched: number;
    partial: number;
    unmatched: number;
  };
  matched_targets: Array<{
    id: string;
    label: string;
    type: string;
    file?: string;
    observations: number;
    errors: number;
    slow_events: number;
    estimated_volume: number;
    latency: {
      avg_ms?: number;
      max_ms?: number;
      p95_ms?: number;
      p99_ms?: number;
    };
    rates: {
      error_rate: number;
      throughput_per_min?: number;
    };
  }>;
  unmatched: {
    count: number;
    top_hints: Array<{ hint: string; count: number }>;
  };
  observations: RuntimeObservation[];
  guidance: string[];
}

export interface TelemetryLoadOptions {
  since?: string;
  type?: string;
  staticId?: string;
  traceId?: string;
  spanId?: string;
  limit?: number;
}

/**
 * Empty CAS stub used when a batch arrives for a project that has NO analysis
 * yet. Every correlation helper the ingest path reaches (`resolveHintNode`,
 * `correlateRuntimeEvent` and its `match*`/`staticRefForId` helpers) reads CAS
 * collections via `.find`/`.filter`, so `nodes: []` + empty arrays make them all
 * resolve to `unmatched` without any code duplication. The raw observation —
 * route, method, status, duration, error, timestamp — is still normalized and
 * persisted verbatim; only the CAS correlation is skipped (to be redone lazily
 * once an analysis exists). This is why telemetry is never dropped pre-analysis.
 */
function emptyCasStub(): CASOutput {
  return { nodes: [], edges: [] } as unknown as CASOutput;
}

/**
 * Ingest a batch of runtime events, persisting raw observations regardless of
 * whether the project has been analyzed.
 *
 * `cas` may be `null` — when it is (no analysis found for the project yet), the
 * events are STILL normalized and persisted to the same runtime-observation
 * store `loadTelemetryObservations` reads from, marked `unmatched`. Correlation
 * against a CAS happens lazily: now if an analysis exists, later if one appears.
 * Telemetry must never be silently lost just because analysis hasn't run.
 */
export async function ingestTelemetryBatch(
  cas: CASOutput | null,
  projectPath: string,
  events: TelemetryEvent[],
  options: { persist?: boolean } = {},
): Promise<TelemetryIngestionResult> {
  const persisted = options.persist !== false;
  const receivedAt = new Date().toISOString();
  const accepted = (events || []).slice(0, MAX_BATCH_SIZE);
  const ingestionId = `ingest_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const observations: RuntimeObservation[] = [];
  const correlationCas = cas ?? emptyCasStub();

  for (let index = 0; index < accepted.length; index += 1) {
    const event = normalizeTelemetryEvent(correlationCas, accepted[index]);
    observations.push({
      id: `${ingestionId}_${index + 1}`,
      project_path: projectPath,
      recorded_at: receivedAt,
      source: 'ingested',
      event,
      correlation: correlateRuntimeEvent(correlationCas, event),
    });
  }

  if (persisted && observations.length > 0) {
    await appendIngestedTelemetry(projectPath, observations);
  }

  const unmatchedObservations = observations.filter(observation => observation.correlation.status === 'unmatched');

  return {
    ingestion_id: ingestionId,
    received_at: receivedAt,
    source: 'ingested',
    event_count: observations.length,
    persisted,
    correlation_summary: {
      matched: observations.filter(observation => observation.correlation.status === 'matched').length,
      partial: observations.filter(observation => observation.correlation.status === 'partial').length,
      unmatched: unmatchedObservations.length,
    },
    matched_targets: summarizeMatchedTargets(observations),
    unmatched: {
      count: unmatchedObservations.length,
      top_hints: topUnmatchedHints(unmatchedObservations),
    },
    observations: observations.slice(0, 25),
    guidance: [
      'Ingested telemetry is stored with source "ingested" and drives get_runtime_observations and get_operational_priorities by default.',
      'Unmatched events are stored, not dropped; use their hints plus get_runtime_instrumentation_plan to improve correlation.',
      'Use get_agent_context with a matched static_target.file before editing the implicated code.',
    ],
  };
}

export function normalizeTelemetryEvent(cas: CASOutput, event: TelemetryEvent): RuntimeEventInput & { timestamp: string } {
  const timestamp = validTimestamp(event.timestamp) || new Date().toISOString();
  const type: RuntimeEventInput['type'] =
    event.kind === 'request' ? 'request' :
    event.kind === 'error' ? 'error' :
    event.kind === 'log' ? 'log' : 'custom';
  const route = event.route || event.path;
  const signal = event.name || (event.method && route ? `http:${event.method.toUpperCase()}:${route}` : undefined);
  const hintNode = resolveHintNode(cas, event);
  const errorMessage = event.error
    ? [event.error.type, event.error.message].filter(Boolean).join(': ') || undefined
    : undefined;

  return {
    type,
    timestamp,
    schema_version: TELEMETRY_SCHEMA_VERSION,
    service_name: event.service_name,
    environment: event.environment,
    signal,
    node_id: hintNode?.id,
    trace_id: event.trace_id,
    span_id: event.span_id,
    parent_span_id: event.parent_span_id,
    method: event.method,
    route: event.route,
    path: event.path,
    status_code: typeof event.status === 'number' ? event.status : undefined,
    duration_ms: event.duration_ms,
    error_message: errorMessage,
    stack: stackFromFrames(event.error),
    attributes: {
      ...event.attributes,
      volume: volumeFor(event),
      ...(typeof event.p95_ms === 'number' ? { p95_ms: event.p95_ms } : {}),
      ...(typeof event.p99_ms === 'number' ? { p99_ms: event.p99_ms } : {}),
      ...(typeof event.rate_per_min === 'number' ? { rate_per_min: event.rate_per_min } : {}),
      ...(typeof event.window_ms === 'number' ? { window_ms: event.window_ms } : {}),
      ...(event.file_hint ? { file_hint: event.file_hint } : {}),
      ...(event.function_hint ? { function_hint: event.function_hint } : {}),
    },
  };
}

function validTimestamp(value?: string): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function volumeFor(event: TelemetryEvent): number {
  if (typeof event.volume === 'number' && event.volume > 0) return Math.round(event.volume);
  const attributeVolume = Number(event.attributes?.volume || event.attributes?.count || 0);
  return attributeVolume > 0 ? Math.round(attributeVolume) : 1;
}

function resolveHintNode(cas: CASOutput, event: TelemetryEvent): CASNode | undefined {
  const frames = stackFramesOf(event);
  const fileHints = [
    event.file_hint,
    ...frames.map(frame => frame.file),
  ].filter((file): file is string => Boolean(file));

  for (const file of fileHints) {
    const frame = frames.find(candidate => candidate.file === file);
    const candidates = (cas.nodes || []).filter(node =>
      node.source?.file && pathsCompatible(node.source.file, file));
    if (candidates.length === 0) continue;

    const functionHint = frame?.function || event.function_hint;
    if (functionHint) {
      const named = candidates.find(node => node.name === functionHint || node.name.endsWith(`.${functionHint}`));
      if (named) return named;
    }
    if (frame?.line) {
      const byLine = candidates.find(node =>
        node.source?.line && node.source?.end_line &&
        node.source.line <= frame.line! && node.source.end_line >= frame.line!);
      if (byLine) return byLine;
    }
    return candidates[0];
  }

  if (event.function_hint) {
    const named = (cas.nodes || []).filter(node => node.name === event.function_hint);
    if (named.length === 1) return named[0];
  }
  return undefined;
}

function stackFramesOf(event: TelemetryEvent): TelemetryStackFrame[] {
  return (event.error?.stack_top_frames || []).map(frame => {
    if (typeof frame !== 'string') return frame;
    const match = frame.match(/(?:at\s+(?:([^\s(]+)\s+)?\()?([^\s():]+):(\d+)(?::\d+)?\)?/);
    if (!match) return { file: frame.trim() };
    return { file: match[2], line: Number(match[3]), function: match[1] };
  }).filter(frame => Boolean(frame.file));
}

function stackFromFrames(error?: TelemetryEvent['error']): string | undefined {
  const frames = error?.stack_top_frames || [];
  if (frames.length === 0) return undefined;
  const header = `${error?.type || 'Error'}: ${error?.message || ''}`.trimEnd();
  const lines = frames.map(frame => {
    if (typeof frame === 'string') return frame.startsWith('    at ') ? frame : `    at ${frame}`;
    return `    at ${frame.function || '<anonymous>'} (${frame.file}:${frame.line || 1}:1)`;
  });
  return [header, ...lines].join('\n');
}

function summarizeMatchedTargets(observations: RuntimeObservation[]): TelemetryIngestionResult['matched_targets'] {
  const groups = new Map<string, RuntimeObservation[]>();
  for (const observation of observations) {
    const best = observation.correlation.best_match;
    if (!best) continue;
    groups.set(best.id, [...(groups.get(best.id) || []), observation]);
  }

  return [...groups.entries()].map(([id, items]) => {
    const best = items[0].correlation.best_match!;
    const stats = runtimeImpactStats(items);
    return {
      id,
      label: best.label,
      type: best.type,
      file: best.file,
      observations: items.length,
      errors: stats.errors,
      slow_events: stats.slow_events,
      estimated_volume: stats.estimated_volume,
      latency: stats.latency,
      rates: stats.rates,
    };
  }).sort((left, right) => right.errors - left.errors || right.estimated_volume - left.estimated_volume);
}

function topUnmatchedHints(observations: RuntimeObservation[]): Array<{ hint: string; count: number }> {
  const counts = new Map<string, number>();
  for (const observation of observations) {
    const event = observation.event;
    const route = event.route || event.path;
    const hint =
      (event.method && route ? `${event.method.toUpperCase()} ${route}` : route) ||
      String(event.attributes?.file_hint || '') ||
      String(event.attributes?.function_hint || '') ||
      event.signal ||
      event.error_message ||
      event.type;
    if (!hint) continue;
    counts.set(hint, (counts.get(hint) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([hint, count]) => ({ hint, count }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 10);
}

export function ingestedTelemetryDir(projectPath: string): string {
  return path.join(getProjectStorageDir(projectPath), INGESTED_DIR);
}

function dayKey(timestamp: string): string {
  const parsed = new Date(timestamp);
  const safe = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  return safe.toISOString().slice(0, 10);
}

export async function appendIngestedTelemetry(projectPath: string, observations: RuntimeObservation[]): Promise<void> {
  const dir = ingestedTelemetryDir(projectPath);
  await fs.ensureDir(dir);

  const byDay = new Map<string, RuntimeObservation[]>();
  for (const observation of observations) {
    const key = dayKey(observation.recorded_at);
    byDay.set(key, [...(byDay.get(key) || []), observation]);
  }

  for (const [day, dayObservations] of byDay) {
    const filePath = path.join(dir, `${day}.json`);
    let existing: RuntimeObservation[] = [];
    if (await fs.pathExists(filePath)) {
      try {
        existing = await fs.readJson(filePath);
      } catch {
        existing = [];
      }
    }
    const merged = [...dayObservations, ...existing].slice(0, MAX_OBSERVATIONS_PER_DAY);
    await writeJsonAtomic(filePath, merged);
  }

  await compactIngestedTelemetry(projectPath);
}

export async function compactIngestedTelemetry(projectPath: string, retentionDays = RETENTION_DAYS): Promise<{ removed_days: string[] }> {
  const dir = ingestedTelemetryDir(projectPath);
  if (!(await fs.pathExists(dir))) return { removed_days: [] };

  const cutoff = dayKey(new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString());
  const expired = (await fs.readdir(dir))
    .filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .filter(name => name.replace(/\.json$/, '') < cutoff);
  for (const name of expired) {
    await fs.remove(path.join(dir, name));
  }
  return { removed_days: expired.map(name => name.replace(/\.json$/, '')).sort() };
}

/** Bounded number of persisted day-files a single backfill pass will rewrite. */
const BACKFILL_MAX_DAYS = 30;

export interface TelemetryBackfillResult {
  scanned: number;
  upgraded: number;
  days_rewritten: string[];
}

/**
 * Rebuild the `TelemetryEvent`-shaped hint fields `resolveHintNode` reads
 * (file/function hints + stack frames) from an ALREADY-normalized, persisted
 * observation event, so a backfill pass can re-resolve a CAS node hint without
 * the original raw batch. Factual fields (route/status/duration) are never
 * touched — this only reconstructs the correlation inputs.
 */
function hintEventFromObservation(event: RuntimeObservation['event']): TelemetryEvent {
  const fileHint = event.attributes?.file_hint;
  const functionHint = event.attributes?.function_hint;
  const frames = parseStackFrames(event.stack);
  return {
    kind: 'log',
    file_hint: typeof fileHint === 'string' ? fileHint : undefined,
    function_hint: typeof functionHint === 'string' ? functionHint : undefined,
    ...(frames.length ? { error: { stack_top_frames: frames } } : {}),
  };
}

function parseStackFrames(stack?: string): TelemetryStackFrame[] {
  if (!stack) return [];
  return stack
    .split('\n')
    .filter(line => line.trimStart().startsWith('at '))
    .map(line => stackFrameFromLine(line))
    .filter((frame): frame is TelemetryStackFrame => Boolean(frame && frame.file));
}

function stackFrameFromLine(line: string): TelemetryStackFrame | undefined {
  const match = line.match(/at\s+(?:([^\s(]+)\s+)?\(?([^\s():]+):(\d+)(?::\d+)?\)?/);
  if (!match) return undefined;
  return { file: match[2], line: Number(match[3]), ...(match[1] ? { function: match[1] } : {}) };
}

/**
 * BACKFILL — re-correlate persisted `unmatched` observations against a
 * now-available CAS and upgrade the ones that now bind to a static node.
 *
 * Runtime observations are persisted verbatim even when a project has no
 * analysis (see `ingestTelemetryBatch` + `emptyCasStub`), landing as
 * `unmatched`. Once an analysis first appears, those pre-analysis observations
 * would otherwise stay `unmatched` forever, leaving node-level metrics empty.
 * This pass loads each day-file, re-runs the SAME vetted `correlateRuntimeEvent`
 * (plus `resolveHintNode`) over its `unmatched` records, and rewrites only the
 * ones that now match — mutating solely `correlation` and the derived
 * `event.node_id`. Route/method/status/duration/timestamp are never altered.
 *
 * Idempotent (already-matched records are skipped; re-running finds nothing new),
 * bounded (at most `BACKFILL_MAX_DAYS` files), and safe to call opportunistically.
 * A day-file is only rewritten when at least one observation in it upgraded.
 */
export async function backfillIngestedTelemetry(
  cas: CASOutput | null,
  projectPath: string,
): Promise<TelemetryBackfillResult> {
  const result: TelemetryBackfillResult = { scanned: 0, upgraded: 0, days_rewritten: [] };
  if (!cas || (cas.nodes || []).length === 0) return result;

  const dir = ingestedTelemetryDir(projectPath);
  if (!(await fs.pathExists(dir))) return result;

  const dayFiles = (await fs.readdir(dir))
    .filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort()
    .reverse()
    .slice(0, BACKFILL_MAX_DAYS);

  for (const name of dayFiles) {
    const filePath = path.join(dir, name);
    let observations: RuntimeObservation[];
    try {
      observations = await fs.readJson(filePath);
    } catch {
      continue;
    }
    if (!Array.isArray(observations)) continue;

    let dayUpgraded = false;
    for (const observation of observations) {
      if (observation?.correlation?.status !== 'unmatched') continue;
      result.scanned += 1;

      const hintNode = resolveHintNode(cas, hintEventFromObservation(observation.event));
      const eventForCorrelation = hintNode
        ? { ...observation.event, node_id: observation.event.node_id ?? hintNode.id }
        : observation.event;
      const correlation = correlateRuntimeEvent(cas, eventForCorrelation);
      if (correlation.status === 'unmatched') continue;

      // Upgrade in place: only correlation + the derived node hint change.
      observation.correlation = correlation;
      if (hintNode && !observation.event.node_id) observation.event.node_id = hintNode.id;
      result.upgraded += 1;
      dayUpgraded = true;
    }

    if (dayUpgraded) {
      await writeJsonAtomic(filePath, observations);
      result.days_rewritten.push(name.replace(/\.json$/, ''));
    }
  }

  result.days_rewritten.sort();
  return result;
}

export async function loadIngestedTelemetry(projectPath: string, options: TelemetryLoadOptions = {}): Promise<RuntimeObservation[]> {
  const dir = ingestedTelemetryDir(projectPath);
  if (!(await fs.pathExists(dir))) return [];

  const dayFiles = (await fs.readdir(dir))
    .filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort()
    .reverse();

  let observations: RuntimeObservation[] = [];
  for (const name of dayFiles) {
    try {
      const dayObservations: RuntimeObservation[] = await fs.readJson(path.join(dir, name));
      observations.push(...dayObservations);
    } catch {
      continue;
    }
    if (options.limit && !options.since && !options.type && !options.staticId && !options.traceId && !options.spanId && observations.length >= options.limit) {
      break;
    }
  }

  observations = filterObservations(observations, options);
  if (options.limit && options.limit > 0) {
    observations = observations.slice(0, options.limit);
  }
  return observations;
}

function filterObservations(observations: RuntimeObservation[], options: TelemetryLoadOptions): RuntimeObservation[] {
  let filtered = observations;
  if (options.since) {
    const sinceDate = new Date(options.since);
    filtered = filtered.filter(observation => new Date(observation.event.timestamp) >= sinceDate);
  }
  if (options.type) {
    filtered = filtered.filter(observation => observation.event.type === options.type);
  }
  if (options.staticId) {
    filtered = filtered.filter(observation =>
      observation.correlation.matches.some(match => match.id === options.staticId) ||
      observation.event.static_id === options.staticId ||
      observation.event.node_id === options.staticId ||
      observation.event.entry_point_id === options.staticId ||
      observation.event.exit_point_id === options.staticId ||
      observation.event.call_chain_id === options.staticId
    );
  }
  if (options.traceId) {
    filtered = filtered.filter(observation => observation.event.trace_id === options.traceId);
  }
  if (options.spanId) {
    filtered = filtered.filter(observation =>
      observation.event.span_id === options.spanId || observation.event.parent_span_id === options.spanId);
  }
  return filtered;
}

export interface TelemetryObservationSet {
  source: RuntimeObservationSource | 'all';
  ingested_count: number;
  simulated_count: number;
  observations: RuntimeObservation[];
}

/** Per route+method traffic/latency, aggregated from RAW observations (no CAS). */
export interface RouteRuntimeMetrics {
  route: string;
  method?: string;
  request_count: number;
  error_count: number;
  error_rate: number;
  status_code_distribution: Record<string, number>;
  latency: { p50_ms?: number; p95_ms?: number; p99_ms?: number; max_ms?: number };
}

function percentile(sortedAsc: number[], p: number): number | undefined {
  if (sortedAsc.length === 0) return undefined;
  const rank = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, rank)];
}

/**
 * Aggregate raw runtime observations into per-route+method metrics
 * (request_count / error_rate / p50 / p95 / p99 / max latency). CAS-free: works
 * purely off the persisted observation records, so traffic and latency are
 * visible even before the project has any analysis. Additive read-side helper.
 */
export function summarizeRouteMetrics(observations: RuntimeObservation[]): RouteRuntimeMetrics[] {
  const groups = new Map<string, { route: string; method?: string; durations: number[]; errors: number; total: number; statuses: Record<string, number> }>();

  for (const observation of observations) {
    const event = observation.event;
    const route = event.route || event.path;
    if (!route) continue;
    const method = event.method ? event.method.toUpperCase() : undefined;
    const key = `${method || ''} ${route}`;
    let group = groups.get(key);
    if (!group) {
      group = { route, method, durations: [], errors: 0, total: 0, statuses: {} };
      groups.set(key, group);
    }
    group.total += 1;
    if (typeof event.duration_ms === 'number' && Number.isFinite(event.duration_ms)) {
      group.durations.push(event.duration_ms);
    }
    const status = event.status_code;
    if (typeof status === 'number') {
      group.statuses[String(status)] = (group.statuses[String(status)] || 0) + 1;
    }
    if (event.type === 'error' || (typeof status === 'number' && status >= 500)) {
      group.errors += 1;
    }
  }

  return [...groups.values()].map(group => {
    const sorted = [...group.durations].sort((a, b) => a - b);
    return {
      route: group.route,
      ...(group.method ? { method: group.method } : {}),
      request_count: group.total,
      error_count: group.errors,
      error_rate: group.total > 0 ? Math.round((group.errors / group.total) * 1000) / 1000 : 0,
      status_code_distribution: group.statuses,
      latency: {
        ...(percentile(sorted, 50) !== undefined ? { p50_ms: percentile(sorted, 50) } : {}),
        ...(percentile(sorted, 95) !== undefined ? { p95_ms: percentile(sorted, 95) } : {}),
        ...(percentile(sorted, 99) !== undefined ? { p99_ms: percentile(sorted, 99) } : {}),
        ...(sorted.length ? { max_ms: sorted[sorted.length - 1] } : {}),
      },
    };
  }).sort((left, right) => right.error_count - left.error_count || right.request_count - left.request_count);
}

export async function loadTelemetryObservations(
  projectPath: string,
  options: TelemetryLoadOptions & { source?: RuntimeObservationSource | 'all' } = {},
): Promise<TelemetryObservationSet> {
  const source = options.source || 'ingested';
  const loadOptions: TelemetryLoadOptions = {
    since: options.since,
    type: options.type,
    staticId: options.staticId,
    traceId: options.traceId,
    spanId: options.spanId,
  };

  const legacy = await loadRuntimeObservations(projectPath, loadOptions);
  const legacyIngested = legacy.filter(observation => runtimeObservationSource(observation) === 'ingested');
  const simulated = legacy.filter(observation => runtimeObservationSource(observation) === 'simulated');
  const ingested = [...await loadIngestedTelemetry(projectPath, loadOptions), ...legacyIngested]
    .sort((left, right) => right.recorded_at.localeCompare(left.recorded_at));

  let observations =
    source === 'ingested' ? ingested :
    source === 'simulated' ? simulated :
    [...ingested, ...simulated].sort((left, right) => right.recorded_at.localeCompare(left.recorded_at));
  if (options.limit && options.limit > 0) {
    observations = observations.slice(0, options.limit);
  }

  return {
    source,
    ingested_count: ingested.length,
    simulated_count: simulated.length,
    observations,
  };
}

export async function loadTelemetryTrace(
  projectPath: string,
  traceId: string,
  options: { source?: RuntimeObservationSource | 'all' } = {},
): Promise<{
  trace_id: string;
  source: RuntimeObservationSource | 'all';
  ingested_count: number;
  simulated_count: number;
  observations: RuntimeObservation[];
  matched: number;
  unmatched: number;
  static_ids: string[];
}> {
  const set = await loadTelemetryObservations(projectPath, { traceId, source: options.source });
  const staticIds = new Set<string>();
  for (const observation of set.observations) {
    for (const match of observation.correlation.matches) {
      staticIds.add(match.id);
    }
    for (const id of [
      observation.event.static_id,
      observation.event.node_id,
      observation.event.entry_point_id,
      observation.event.exit_point_id,
      observation.event.call_chain_id,
    ]) {
      if (id) staticIds.add(id);
    }
  }
  return {
    trace_id: traceId,
    source: set.source,
    ingested_count: set.ingested_count,
    simulated_count: set.simulated_count,
    observations: set.observations,
    matched: set.observations.filter(observation => observation.correlation.status !== 'unmatched').length,
    unmatched: set.observations.filter(observation => observation.correlation.status === 'unmatched').length,
    static_ids: [...staticIds],
  };
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  // Ensure the destination directory exists BEFORE writing/moving. On a fresh
  // project's first self-telemetry ingest the day-file's parent dir
  // (…/ingested-telemetry/) may not exist yet, and `fs.move`'s internal
  // rename/chmod then races to ENOENT ("chmod '…/<day>.json'"). mkdir -p is
  // idempotent — once the dir exists this is a no-op with zero behavior change.
  await fs.mkdirp(path.dirname(filePath));
  const tmpPath = path.join(os.tmpdir(), `klauro-telemetry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  await fs.writeJson(tmpPath, value, { spaces: 2 });
  await fs.move(tmpPath, filePath, { overwrite: true });
}
