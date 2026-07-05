/**
 * ============================================================================
 * Klauro self-telemetry (dogfooding) — OFF BY DEFAULT, env-gated, crash-proof.
 * ============================================================================
 *
 * Purpose: instrument the Klauro HTTP service so it emits ITS OWN runtime
 * telemetry via the @klauro/telemetry SDK, self-ingesting into Klauro's own
 * runtime-observation store and correlating against Klauro's own static
 * analysis (CAS). This lets us dogfood the telemetry product on Klauro itself.
 *
 * ---------------------------------------------------------------------------
 * ENABLE (all knobs are env, nothing changes unless the gate is truthy):
 *
 *   KLAURO_SELF_TELEMETRY=1
 *       Master gate. Unset/empty/"0"/"false" => this module is a total no-op:
 *       no SDK init, no middleware, zero behavior/perf change. Safe to ship
 *       dormant and flip on live.
 *
 *   KLAURO_SELF_TELEMETRY_PROJECT=<path>
 *       Klauro repo path the events attach to. This is the projectId of the
 *       self-loop: it is the SAME path `get_runtime_observations(path=...)`
 *       reads back, and the path whose CAS the events are correlated against.
 *       Defaults to the HTTP service's process.cwd() (the Klauro repo root when
 *       run in-tree). Logical name of the loop: "klauro-self".
 *
 *   KLAURO_SELF_TELEMETRY_ENDPOINT=<origin>
 *       Optional HTTP override. When set, events are POSTed over the wire to
 *       <origin>/api/telemetry/runtime-events/<projectId> via the SDK's normal
 *       transport (real network round-trip). When UNSET (default), events are
 *       routed IN-PROCESS straight into the local ingest store — no network,
 *       no external dependency — so the self-loop is verifiable on one box.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT CAPTURES: one runtime event per completed inbound HTTP request on the
 * remote-analyzer HTTP service — method, normalized route, status code, and
 * duration. 5xx responses are emitted as `error` events; everything else as
 * `request`. Events carry service_name="klauro-mcp-server" and the current
 * NODE_ENV. They correlate onto CAS route/handler nodes via the ingest path.
 *
 * SAFETY: every entry point here is wrapped so a telemetry failure can never
 * affect server boot or request handling. The SDK itself is a no-op before
 * init and never throws into the host; this module adds a second belt.
 * ============================================================================
 */

import type * as http from 'node:http';
import * as klauroTelemetry from '../../../packages/klauro-sdk-js/src/index';
import type { CasRuntimeEvent } from '../../../packages/klauro-sdk-js/src/types';
import { getAnalysis } from './analyzer';
import { ingestTelemetryBatch, type TelemetryEvent } from './telemetry-ingestion';

const SERVICE_NAME = 'klauro-mcp-server';
const SELF_LOOP_NAME = 'klauro-self';

/** True when the master env gate is truthy. Anything else = disabled. */
export function selfTelemetryEnabled(): boolean {
  const raw = (process.env.KLAURO_SELF_TELEMETRY || '').trim().toLowerCase();
  return raw !== '' && raw !== '0' && raw !== 'false' && raw !== 'off' && raw !== 'no';
}

/** The Klauro repo path the self-loop attaches events to (also the read key). */
function selfProjectPath(): string {
  return process.env.KLAURO_SELF_TELEMETRY_PROJECT?.trim() || process.cwd();
}

let installed = false;

/**
 * Initialize the self-telemetry SDK client. No-op (and returns false) when the
 * gate is unset or when init fails for any reason. Never throws.
 *
 * When KLAURO_SELF_TELEMETRY_ENDPOINT is set the SDK's default HTTP transport
 * is used (global fetch). When it is unset, a custom fetchImpl intercepts the
 * SDK's POST to /api/telemetry/runtime-events/:projectId and routes the batched
 * events straight into the local ingest store, giving an in-process round-trip.
 */
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
      // In-process transport: only used when no HTTP endpoint override is set.
      fetchImpl: endpointOverride ? undefined : localIngestFetch(projectPath),
      onError: () => {
        /* swallow — telemetry must never surface into the host */
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

/**
 * Wrap a raw Node http request handler with SDK request instrumentation. The
 * remote-analyzer service is a raw http.createServer (not Express), so instead
 * of the SDK's Express middleware we replicate its finish-hook contract here:
 * one event per completed response with method, path, status, and duration.
 *
 * When the gate is unset this returns the ORIGINAL handler unchanged — zero
 * wrapping, zero overhead, identical behavior to before.
 */
export function instrumentHttpHandler(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  if (!selfTelemetryEnabled()) return handler;
  return (req, res) => {
    try {
      const startedAt = Date.now();
      res.on('finish', () => {
        try {
          const statusCode = res.statusCode || 0;
          klauroTelemetry.recordEvent({
            type: statusCode >= 500 ? 'error' : 'request',
            method: req.method,
            path: req.url,
            status_code: statusCode,
            duration_ms: Date.now() - startedAt,
          });
        } catch {
          /* never let telemetry break a served request */
        }
      });
    } catch {
      /* never let telemetry break request handling */
    }
    handler(req, res);
  };
}

/** Flush and stop the self-telemetry client. Safe to call always. */
export async function shutdownSelfTelemetry(): Promise<void> {
  try {
    await klauroTelemetry.shutdown();
  } catch {
    /* ignore */
  }
  installed = false;
}

/**
 * Build a fetch-compatible function that intercepts the SDK's ingest POST and
 * writes the batch into the local runtime-observation store, correlated to the
 * project's CAS. This is the in-process transport for the self-loop.
 */
function localIngestFetch(projectPath: string): typeof fetch {
  const impl = (async (_input: unknown, init?: { body?: unknown }): Promise<unknown> => {
    try {
      const events = parseSdkBatch(init?.body);
      if (events.length > 0) {
        // Raw observations MUST persist regardless of analysis state. Try to load
        // the CAS for correlation, but a missing analysis is NOT a drop reason:
        // fall back to `null` so ingestTelemetryBatch stores the raw events
        // (route/status/duration/error/timestamp) as `unmatched`. Correlation
        // happens lazily once an analysis exists — telemetry is never lost.
        let cas: Awaited<ReturnType<typeof getAnalysis>> | null = null;
        try {
          cas = await getAnalysis(projectPath);
        } catch {
          cas = null;
        }
        await ingestTelemetryBatch(cas, projectPath, events.map(mapSdkEvent), { persist: true });
      }
    } catch (err) {
      process.stderr.write(
        `Klauro self-telemetry local ingest failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    // Minimal Response-like object the SDK treats as success (res.ok === true).
    return { ok: true, status: 202, statusText: 'Accepted', async text() { return ''; } };
  }) as unknown as typeof fetch;
  return impl;
}

/** The SDK POSTs `{ schema_version, events: CasRuntimeEvent[] }` as a JSON string. */
function parseSdkBatch(body: unknown): CasRuntimeEvent[] {
  if (typeof body !== 'string' || body.length === 0) return [];
  const parsed = JSON.parse(body) as { events?: CasRuntimeEvent[] };
  return Array.isArray(parsed.events) ? parsed.events : [];
}

/**
 * Map the SDK's CasRuntimeEvent onto the local ingest TelemetryEvent shape.
 * Exported so the remote-analyzer HTTP `/api/telemetry/runtime-events/:projectId`
 * ingest-reconcile route (the path a customer-installed SDK POSTs to) maps SDK
 * batches with the EXACT same field mapping as the in-process self-loop, rather
 * than duplicating the translation.
 */
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
