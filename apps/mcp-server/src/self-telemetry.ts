
























import type * as http from 'node:http';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import * as klauroTelemetry from '../../../packages/klauro-sdk-js/src/index';
import { klauroHttp } from '../../../packages/klauro-sdk-js/src/middleware/http';
import type { CasRuntimeEvent } from '../../../packages/klauro-sdk-js/src/types';
import { ingestTelemetryBatch, MAX_TELEMETRY_BATCH_SIZE, type TelemetryEvent } from './telemetry-ingestion';
import { waitForForegroundAnalysisIdle } from './foreground-analysis';
import { persistSelfTelemetryInWorker } from './self-telemetry-process';

const SERVICE_NAME = 'klauro-mcp-server';
const SELF_LOOP_NAME = 'klauro-self';



const SLOW_SELF_INGEST_MS = 1_000;


















export function selfTelemetryEnabled(): boolean {
  const raw = (process.env.KLAURO_SELF_TELEMETRY || '').trim().toLowerCase();
  return raw !== '' && raw !== '0' && raw !== 'false' && raw !== 'off' && raw !== 'no';
}








export function resolveSelfSourceDir(): string | null {
  try {
    let dir = __dirname;
    for (let hops = 0; hops < 8; hops++) {
      if (nodePath.basename(dir) === 'src' && nodePath.basename(nodePath.dirname(dir)) === 'mcp-server') {
        return dir;
      }
      const parent = nodePath.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    const guess = nodePath.join(process.cwd(), 'apps', 'mcp-server', 'src');
    if (nodeFs.existsSync(guess)) return guess;
  } catch {

  }
  return null;
}











export function selfProjectPath(): string {
  const override = process.env.KLAURO_SELF_TELEMETRY_PROJECT?.trim();
  if (override) return override;
  return resolveSelfSourceDir() || process.cwd();
}








export function selfCanonicalProjectPath(): string | null {
  const raw = process.env.KLAURO_SELF_TELEMETRY_CANONICAL_PROJECT?.trim();
  return raw ? raw : null;
}










export async function mirrorToCanonicalBucket(
  primaryProjectPath: string,
  events: TelemetryEvent[],
): Promise<void> {
  try {
    if (events.length === 0) return;
    const canonicalPath = selfCanonicalProjectPath();
    if (!canonicalPath || canonicalPath === primaryProjectPath) return;

    const mirrorStartedAt = Date.now();
    await ingestTelemetryBatch(null, canonicalPath, events, { persist: true });
    const mirrorElapsedMs = Date.now() - mirrorStartedAt;
    if (mirrorElapsedMs >= SLOW_SELF_INGEST_MS) {
      process.stdout.write(
        `Klauro self-telemetry: canonical mirror of ${events.length} event(s) into ${canonicalPath} took ${mirrorElapsedMs}ms.\n`,
      );
    }
  } catch (err) {
    process.stderr.write(
      `Klauro self-telemetry canonical mirror failed (primary ingest unaffected): ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

let installed = false;
let localIngestPromise: Promise<void> | undefined;
let pendingEvents: Array<{ projectPath: string; event: TelemetryEvent }> = [];
let pendingDrain: { promise: Promise<void>; start: () => void } | undefined;
let shuttingDown = false;

const DEFAULT_INGEST_COALESCE_MS = 30_000;

export function selfTelemetryIngestCoalesceMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.KLAURO_SELF_TELEMETRY_COALESCE_MS);
  return Number.isFinite(configured) && configured >= 0 ? Math.floor(configured) : DEFAULT_INGEST_COALESCE_MS;
}









export function initSelfTelemetry(): boolean {
  if (!selfTelemetryEnabled()) return false;
  if (installed) return true;
  try {
    const projectPath = selfProjectPath();
    const endpointOverride = process.env.KLAURO_SELF_TELEMETRY_ENDPOINT?.trim();

    klauroTelemetry.init({
      projectId: projectPath,
      endpoint: endpointOverride || undefined,
      service: SERVICE_NAME,
      environment: process.env.NODE_ENV || 'production',

      fetchImpl: endpointOverride ? undefined : localIngestFetch(projectPath),
      onError: () => {

      },
    });

    installed = true;
    process.stderr.write(
      `Klauro self-telemetry ENABLED (service=${SERVICE_NAME}, loop=${SELF_LOOP_NAME}, ` +
        `project=${projectPath}, transport=${endpointOverride ? `http:${endpointOverride}` : 'in-process'}).\n`,
    );

    return true;
  } catch (err) {
    process.stderr.write(
      `Klauro self-telemetry init failed (continuing without it): ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return false;
  }
}













export function instrumentHttpHandler(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  if (!selfTelemetryEnabled()) return handler;
  return klauroHttp(handler);
}


export async function shutdownSelfTelemetry(): Promise<void> {
  shuttingDown = true;
  try {
    pendingDrain?.start();
    await klauroTelemetry.shutdown();
    await waitForSelfTelemetryIngest();
  } catch {

  }
  installed = false;
  shuttingDown = false;
}

export async function waitForSelfTelemetryIngest(): Promise<void> {
  while (pendingDrain || localIngestPromise) {
    const drain = pendingDrain;
    if (drain) {
      drain.start();
      await drain.promise.catch(() => {});
    } else {
      await localIngestPromise?.catch(() => {});
    }
  }
}

export function enqueueSelfTelemetryEvents(projectPath: string, events: TelemetryEvent[]): Promise<void> {
  if (events.length === 0) return Promise.resolve();
  pendingEvents.push(...events.map(event => ({ projectPath, event })));
  if (!pendingDrain) {
    let start: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { start = resolve; });
    const timer = setTimeout(start, shuttingDown ? 0 : selfTelemetryIngestCoalesceMs());
    timer.unref();
    const promise = gate.then(() => {
      clearTimeout(timer);
      const queued = pendingEvents;
      pendingEvents = [];
      pendingDrain = undefined;
      return ingestQueuedSelfTelemetry(queued);
    });
    pendingDrain = { promise, start };
  }
  return pendingDrain.promise;
}

function ingestQueuedSelfTelemetry(queued: Array<{ projectPath: string; event: TelemetryEvent }>): Promise<void> {
  const operation = (localIngestPromise || Promise.resolve())
    .catch(() => {})
    .then(() => flushSelfTelemetryEvents(queued));
  localIngestPromise = operation;
  const clear = (): void => {
    if (localIngestPromise === operation) localIngestPromise = undefined;
  };
  void operation.then(clear, err => {
    clear();
    process.stderr.write(
      `Klauro self-telemetry local ingest failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  });
  return operation;
}

export function selfTelemetryWorkerRequests(
  queued: ReadonlyArray<{ projectPath: string; event: TelemetryEvent }>,
): Array<Array<{ projectPath: string; events: TelemetryEvent[] }>> {
  const eventsByProject = new Map<string, TelemetryEvent[]>();
  for (const item of queued) {
    const events = eventsByProject.get(item.projectPath) ?? [];
    events.push(item.event);
    eventsByProject.set(item.projectPath, events);
  }

  const requests: Array<Array<{ projectPath: string; events: TelemetryEvent[] }>> = [];
  let request: Array<{ projectPath: string; events: TelemetryEvent[] }> = [];
  let requestSize = 0;
  for (const [projectPath, events] of eventsByProject) {
    for (let offset = 0; offset < events.length; offset += MAX_TELEMETRY_BATCH_SIZE) {
      const batch = events.slice(offset, offset + MAX_TELEMETRY_BATCH_SIZE);
      if (requestSize + batch.length > MAX_TELEMETRY_BATCH_SIZE && request.length > 0) {
        requests.push(request);
        request = [];
        requestSize = 0;
      }
      request.push({ projectPath, events: batch });
      requestSize += batch.length;
    }
  }
  if (request.length > 0) requests.push(request);
  return requests;
}

async function flushSelfTelemetryEvents(
  queued: ReadonlyArray<{ projectPath: string; event: TelemetryEvent }>,
): Promise<void> {
  await waitForForegroundAnalysisIdle();
  const ingestStartedAt = Date.now();
  const requests = selfTelemetryWorkerRequests(queued);
  for (const request of requests) {
    await persistSelfTelemetryInWorker(request, selfCanonicalProjectPath() || undefined);
  }
  const ingestElapsedMs = Date.now() - ingestStartedAt;
  if (ingestElapsedMs >= SLOW_SELF_INGEST_MS) {
    const projectCount = new Set(queued.map(item => item.projectPath)).size;
    process.stdout.write(
      `Klauro self-telemetry: isolated ingest of ${queued.length} event(s) across ${projectCount} project(s) took ${ingestElapsedMs}ms.\n`,
    );
  }
}






function localIngestFetch(projectPath: string): typeof fetch {
  const impl = (async (_input: unknown, init?: { body?: unknown }): Promise<unknown> => {
    const events = parseSdkBatch(init?.body);
    if (events.length > 0) {
      await enqueueSelfTelemetryEvents(projectPath, events.map(mapSdkEvent));
    }
    return new Response(JSON.stringify({ event_count: events.length }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return impl;
}


function parseSdkBatch(body: unknown): CasRuntimeEvent[] {
  if (typeof body !== 'string' || body.length === 0) return [];
  const parsed = JSON.parse(body) as { events?: CasRuntimeEvent[] };
  return Array.isArray(parsed.events) ? parsed.events : [];
}








export function mapSdkEvent(event: CasRuntimeEvent): TelemetryEvent {
  const kind: TelemetryEvent['kind'] =
    event.type === 'error' ? 'error' :
    event.type === 'log' ? 'log' :
    event.type === 'request' ? 'request' : 'metric';
  return {
    kind,
    event_id: event.event_id,
    timestamp: event.timestamp,
    name: event.signal,
    service_name: event.service_name || SERVICE_NAME,
    environment: event.environment,





    static_id: event.static_id,
    node_id: event.node_id,
    entry_point_id: event.entry_point_id,
    exit_point_id: event.exit_point_id,
    call_chain_id: event.call_chain_id,
    trace_id: event.trace_id,
    span_id: event.span_id,
    parent_span_id: event.parent_span_id,
    method: event.method,
    route: event.route,
    path: event.path,
    status: event.status_code,
    duration_ms: event.duration_ms,
    error: event.error_message
      ? { message: event.error_message, stack_top_frames: event.stack ? [event.stack] : undefined }
      : undefined,
    attributes: event.attributes,
  };
}
