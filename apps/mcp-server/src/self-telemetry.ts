
























import type * as http from 'node:http';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import * as klauroTelemetry from '../../../packages/klauro-sdk-js/src/index';
import { klauroHttp } from '../../../packages/klauro-sdk-js/src/middleware/http';
import type { CasRuntimeEvent } from '../../../packages/klauro-sdk-js/src/types';
import { ingestTelemetryBatch, type TelemetryEvent } from './telemetry-ingestion';
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
const pendingLocalEvents: Array<{ projectPath: string; event: TelemetryEvent }> = [];









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
  try {
    await klauroTelemetry.shutdown();
    await waitForSelfTelemetryIngest();
  } catch {

  }
  installed = false;
}

export async function waitForSelfTelemetryIngest(): Promise<void> {
  while (localIngestPromise) await localIngestPromise;
}

export function enqueueSelfTelemetryEvents(projectPath: string, events: TelemetryEvent[]): void {
  if (events.length === 0) return;
  pendingLocalEvents.push(...events.map(event => ({ projectPath, event })));
  scheduleLocalIngest();
}

function scheduleLocalIngest(): void {
  if (localIngestPromise) return;
  localIngestPromise = flushSelfTelemetryEvents()
    .catch(err => {
      process.stderr.write(
        `Klauro self-telemetry local ingest failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    })
    .finally(() => {
      localIngestPromise = undefined;
      if (pendingLocalEvents.length > 0) scheduleLocalIngest();
    });
}

async function flushSelfTelemetryEvents(): Promise<void> {
  while (pendingLocalEvents.length > 0) {
    await waitForForegroundAnalysisIdle();
    const queued = pendingLocalEvents.splice(0, pendingLocalEvents.length);
    const batches = new Map<string, TelemetryEvent[]>();
    for (const item of queued) {
      const events = batches.get(item.projectPath) ?? [];
      events.push(item.event);
      batches.set(item.projectPath, events);
    }
    const ingestStartedAt = Date.now();
    const grouped = [...batches].map(([projectPath, events]) => ({ projectPath, events }));
    await persistSelfTelemetryInWorker(grouped, selfCanonicalProjectPath() || undefined);
    const ingestElapsedMs = Date.now() - ingestStartedAt;
    if (ingestElapsedMs >= SLOW_SELF_INGEST_MS) {
      const eventCount = grouped.reduce((sum, batch) => sum + batch.events.length, 0);
      process.stdout.write(
        `Klauro self-telemetry: isolated ingest of ${eventCount} event(s) across ${grouped.length} project(s) took ${ingestElapsedMs}ms.\n`,
      );
    }
  }
}






function localIngestFetch(projectPath: string): typeof fetch {
  const impl = (async (_input: unknown, init?: { body?: unknown }): Promise<unknown> => {
    try {
      const events = parseSdkBatch(init?.body);
      if (events.length > 0) {
        const mapped = events.map(mapSdkEvent);
        enqueueSelfTelemetryEvents(projectPath, mapped);
      }
    } catch (err) {
      process.stderr.write(
        `Klauro self-telemetry local ingest failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }

    return { ok: true, status: 202, statusText: 'Accepted', async text() { return ''; } };
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
