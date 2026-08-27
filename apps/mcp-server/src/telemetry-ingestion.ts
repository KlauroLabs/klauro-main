import * as fs from 'fs-extra';
import * as path from 'path';
import { createHash } from 'crypto';
import { open } from 'node:fs/promises';
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
import { writeCompressedChunksAtomic, writeJsonAtomic } from './json-storage-writer';

export const TELEMETRY_SCHEMA_VERSION = 'ingested-1';
export const MAX_TELEMETRY_BATCH_SIZE = 1000;
const MAX_OBSERVATIONS_PER_DAY = 5000;
const RETENTION_DAYS = 14;
const INGESTED_DIR = 'ingested-telemetry';

export interface TelemetryStackFrame {
  file: string;
  line?: number;
  function?: string;
}

export interface TelemetryEvent {
  event_id?: string;
  kind: 'request' | 'error' | 'log' | 'metric';
  timestamp?: string;
  name?: string;
  service_name?: string;
  environment?: string;
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string;











  static_id?: string;
  node_id?: string;
  entry_point_id?: string;
  exit_point_id?: string;
  call_chain_id?: string;
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











function emptyCasStub(): CASOutput {
  return { nodes: [], edges: [] } as unknown as CASOutput;
}











export async function ingestTelemetryBatch(
  cas: CASOutput | null,
  projectPath: string,
  events: TelemetryEvent[],
  options: { persist?: boolean } = {},
): Promise<TelemetryIngestionResult> {
  const persisted = options.persist !== false;
  const receivedAt = new Date().toISOString();
  const accepted = events || [];
  if (accepted.length > MAX_TELEMETRY_BATCH_SIZE) {
    throw new RangeError(`Telemetry batches are limited to ${MAX_TELEMETRY_BATCH_SIZE} events`);
  }
  const ingestionId = `ingest_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const observations: RuntimeObservation[] = [];
  const correlationCas = cas ?? emptyCasStub();

  for (let index = 0; index < accepted.length; index += 1) {
    const event = normalizeTelemetryEvent(correlationCas, accepted[index]);
    const eventId = accepted[index].event_id;
    observations.push({
      id: eventId ? stableObservationId(projectPath, eventId) : `${ingestionId}_${index + 1}`,
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
    static_id: event.static_id,



    node_id: event.node_id || hintNode?.id,
    entry_point_id: event.entry_point_id,
    exit_point_id: event.exit_point_id,
    call_chain_id: event.call_chain_id,
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
      ...(event.event_id ? { telemetry_event_id: event.event_id } : {}),
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

function stableObservationId(projectPath: string, eventId: string): string {
  return `ingested_${createHash('sha256').update(projectPath).update('\0').update(eventId).digest('hex').slice(0, 32)}`;
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




















const KNOWN_MOUNT_ROOT_PATTERNS: RegExp[] = [
  /^\/app\//,
  /^\/data\/workspaces\/[^/]+\//,
];

function stripKnownMountRoot(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  for (const pattern of KNOWN_MOUNT_ROOT_PATTERNS) {
    if (pattern.test(normalized)) return normalized.replace(pattern, '');
  }
  return normalized;
}

function pathSegments(value: string): string[] {
  return value.replace(/\\/g, '/').split('/').filter(Boolean);
}










function sharesDeepPathTail(left: string, right: string): boolean {
  const leftSegments = pathSegments(left);
  const rightSegments = pathSegments(right);
  const minDepth = Math.min(leftSegments.length, rightSegments.length);
  if (minDepth === 0) return false;
  let common = 0;
  while (
    common < minDepth &&
    leftSegments[leftSegments.length - 1 - common] === rightSegments[rightSegments.length - 1 - common]
  ) {
    common += 1;
  }
  return common >= 3 && common >= Math.ceil(minDepth / 2);
}










function filesLikelySameSource(left: string, right: string): boolean {
  if (pathsCompatible(left, right)) return true;
  const strippedLeft = stripKnownMountRoot(left);
  const strippedRight = stripKnownMountRoot(right);
  if (strippedLeft !== left || strippedRight !== right) {
    if (strippedLeft === strippedRight) return true;
    if (pathsCompatible(strippedLeft, strippedRight)) return true;
  }
  return sharesDeepPathTail(left, right);
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
      node.source?.file && filesLikelySameSource(node.source.file, file));
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







const DAY_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.jsonl?$/;

function dayFromFileName(name: string): string {
  return name.replace(/\.jsonl?$/, '');
}

async function readDayObservations(filePath: string): Promise<RuntimeObservation[]> {
  try {
    if (filePath.endsWith('.jsonl')) {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed: RuntimeObservation[] = [];
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          parsed.push(JSON.parse(trimmed) as RuntimeObservation);
        } catch {



        }
      }

      return parsed.reverse();
    }
    const array = await fs.readJson(filePath);
    return Array.isArray(array) ? array : [];
  } catch {
    return [];
  }
}















export async function appendIngestedTelemetry(projectPath: string, observations: RuntimeObservation[]): Promise<void> {
  if (observations.length === 0) return;
  await serializeTelemetryMutation(projectPath, async () => {
    const dir = ingestedTelemetryDir(projectPath);
    await fs.ensureDir(dir);
    const byDay = new Map<string, RuntimeObservation[]>();
    for (const observation of observations) {
      const key = dayKey(observation.recorded_at);
      byDay.set(key, [...(byDay.get(key) || []), observation]);
    }
    for (const [day, dayObservations] of byDay) {
      const filePath = path.join(dir, `${day}.jsonl`);
      await appendObservationDay(filePath, dayObservations);
    }
    await removeExpiredIngestedTelemetryDays(dir, RETENTION_DAYS);
  });
}

async function appendObservationDay(filePath: string, observations: RuntimeObservation[]): Promise<void> {
  let separatesIncompleteRecord = false;
  try {
    const handle = await open(filePath, 'r');
    try {
      const { size } = await handle.stat();
      if (size > 0) {
        const lastByte = Buffer.allocUnsafe(1);
        await handle.read(lastByte, 0, 1, size - 1);
        separatesIncompleteRecord = lastByte[0] !== 0x0a;
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const lines = observations.map(observation => `${JSON.stringify(observation)}\n`).join('');
  await fs.appendFile(filePath, `${separatesIncompleteRecord ? '\n' : ''}${lines}`, 'utf8');
}

const telemetryMutations = new Map<string, Promise<unknown>>();

async function serializeTelemetryMutation<T>(projectPath: string, operation: () => Promise<T>): Promise<T> {
  const prior = telemetryMutations.get(projectPath) || Promise.resolve();
  const pending = prior.catch(() => undefined).then(operation);
  telemetryMutations.set(projectPath, pending);
  try {
    return await pending;
  } finally {
    if (telemetryMutations.get(projectPath) === pending) telemetryMutations.delete(projectPath);
  }
}

function mergeObservations(existing: RuntimeObservation[], incoming: RuntimeObservation[]): RuntimeObservation[] {
  return dedupeObservations([...incoming, ...existing]).slice(0, MAX_OBSERVATIONS_PER_DAY);
}

function dedupeObservations(observations: RuntimeObservation[]): RuntimeObservation[] {
  const byId = new Map<string, RuntimeObservation>();
  for (const observation of observations) {
    const eventId = observation.event.attributes?.telemetry_event_id;
    const key = typeof eventId === 'string' && eventId ? `event:${eventId}` : `observation:${observation.id}`;
    if (!byId.has(key)) byId.set(key, observation);
  }
  return [...byId.values()]
    .sort((left, right) => right.recorded_at.localeCompare(left.recorded_at));
}

export async function migrateIngestedTelemetryProject(fromProjectPath: string, toProjectPath: string): Promise<number> {
  if (!fromProjectPath || fromProjectPath === toProjectPath) return 0;
  return serializeTelemetryMutation(fromProjectPath, async () => {
    const observations = await loadIngestedTelemetry(fromProjectPath);
    if (observations.length === 0) return 0;
    const migrated = observations.map(observation => ({ ...observation, project_path: toProjectPath }));
    await appendIngestedTelemetry(toProjectPath, migrated);
    await fs.remove(ingestedTelemetryDir(fromProjectPath));
    return migrated.length;
  });
}

async function writeObservationDay(filePath: string, newestFirst: RuntimeObservation[]): Promise<void> {
  const chronological = [...newestFirst].reverse();
  async function* lines(): AsyncGenerator<string> {
    for (const observation of chronological) yield `${JSON.stringify(observation)}\n`;
  }
  await writeCompressedChunksAtomic(filePath, lines());
}

async function removeExpiredIngestedTelemetryDays(dir: string, retentionDays: number): Promise<string[]> {
  if (!(await fs.pathExists(dir))) return [];
  const cutoff = dayKey(new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString());
  const expired = (await fs.readdir(dir))
    .filter(name => DAY_FILE_PATTERN.test(name) && dayFromFileName(name) < cutoff);
  await Promise.all(expired.map(name => fs.remove(path.join(dir, name))));
  return expired.map(dayFromFileName).sort();
}

export async function compactIngestedTelemetry(projectPath: string, retentionDays = RETENTION_DAYS): Promise<{ removed_days: string[] }> {
  return serializeTelemetryMutation(projectPath, async () => {
    const dir = ingestedTelemetryDir(projectPath);
    if (!(await fs.pathExists(dir))) return { removed_days: [] };
    const removedDays = await removeExpiredIngestedTelemetryDays(dir, retentionDays);
    const allDayFiles = (await fs.readdir(dir)).filter(name => DAY_FILE_PATTERN.test(name));
    for (const name of allDayFiles) {
      if (!name.endsWith('.jsonl')) continue;
      const filePath = path.join(dir, name);
      const observations = await readDayObservations(filePath);
      const compacted = mergeObservations([], observations);
      if (compacted.length === observations.length) continue;
      await writeObservationDay(filePath, compacted);
    }
    return { removed_days: removedDays };
  });
}


const BACKFILL_MAX_DAYS = 30;

export interface TelemetryBackfillResult {
  scanned: number;
  upgraded: number;
  days_rewritten: string[];
}








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


















export async function backfillIngestedTelemetry(
  cas: CASOutput | null,
  projectPath: string,
): Promise<TelemetryBackfillResult> {
  return serializeTelemetryMutation(projectPath, () => backfillIngestedTelemetryLocked(cas, projectPath));
}

async function backfillIngestedTelemetryLocked(
  cas: CASOutput | null,
  projectPath: string,
): Promise<TelemetryBackfillResult> {
  const result: TelemetryBackfillResult = { scanned: 0, upgraded: 0, days_rewritten: [] };
  if (!cas || (cas.nodes || []).length === 0) return result;

  const dir = ingestedTelemetryDir(projectPath);
  if (!(await fs.pathExists(dir))) return result;

  const dayFiles = (await fs.readdir(dir))
    .filter(name => DAY_FILE_PATTERN.test(name))
    .sort()
    .reverse()
    .slice(0, BACKFILL_MAX_DAYS);

  for (const name of dayFiles) {
    const filePath = path.join(dir, name);
    let observations: RuntimeObservation[];
    try {
      observations = await readDayObservations(filePath);
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


      observation.correlation = correlation;
      if (hintNode && !observation.event.node_id) observation.event.node_id = hintNode.id;
      result.upgraded += 1;
      dayUpgraded = true;
    }

    if (dayUpgraded) {





      if (filePath.endsWith('.jsonl')) {
        await writeObservationDay(filePath, observations);
      } else {
        await writeJsonAtomic(filePath, observations);
      }
      result.days_rewritten.push(dayFromFileName(name));
    }
  }

  result.days_rewritten.sort();
  return result;
}

export async function loadIngestedTelemetry(projectPath: string, options: TelemetryLoadOptions = {}): Promise<RuntimeObservation[]> {
  const dir = ingestedTelemetryDir(projectPath);
  if (!(await fs.pathExists(dir))) return [];

  const dayFiles = (await fs.readdir(dir))
    .filter(name => DAY_FILE_PATTERN.test(name))
    .sort()
    .reverse();

  let observations: RuntimeObservation[] = [];
  for (const name of dayFiles) {
    try {
      const dayObservations = await readDayObservations(path.join(dir, name));
      observations.push(...dayObservations);
    } catch {
      continue;
    }
    if (options.limit && !options.since && !options.type && !options.staticId && !options.traceId && !options.spanId && observations.length >= options.limit) {
      break;
    }
  }

  observations = filterObservations(dedupeObservations(observations), options);
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
