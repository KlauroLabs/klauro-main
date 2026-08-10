/**
 * Klauro self-telemetry (dogfooding) — off by default, env-gated, crash-proof.
 * Instruments the HTTP service to emit its own runtime telemetry via the
 * @klauro/telemetry SDK, self-ingesting and correlating against Klauro's own CAS.
 *
 * Env knobs (all off unless truthy):
 *   KLAURO_SELF_TELEMETRY=1                    master gate; unset = total no-op.
 *   KLAURO_SELF_TELEMETRY_PROJECT=<path>       projectId events attach to;
 *       defaults to this module's own src dir. An override absent at runtime
 *       is ignored in favor of the in-process dir (an absent path can never be analyzed).
 *   KLAURO_SELF_TELEMETRY_ENDPOINT=<origin>    optional; when set, events POST
 *       over HTTP instead of routing in-process into the local ingest store.
 *   KLAURO_SELF_TELEMETRY_CANONICAL_PROJECT=<path>  optional; mirrors every
 *       observation into this bucket too (never triggers source analysis).
 *
 * Telemetry never triggers analysis. It correlates against the existing
 * canonical uploaded CAS, or persists honestly unmatched until that CAS exists.
 *
 * Captures one event per completed inbound HTTP request (method, normalized
 * route, status, duration); 5xx as 'error', else 'request'.
 *
 * Safety: every entry point is wrapped so a telemetry failure can never affect
 * server boot or request handling.
 */

import type * as http from 'node:http';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import * as klauroTelemetry from '../../../packages/klauro-sdk-js/src/index';
import { klauroHttp } from '../../../packages/klauro-sdk-js/src/middleware/http';
import type { CasRuntimeEvent } from '../../../packages/klauro-sdk-js/src/types';
import { ingestTelemetryBatch, type TelemetryEvent } from './telemetry-ingestion';

const SERVICE_NAME = 'klauro-mcp-server';
const SELF_LOOP_NAME = 'klauro-self';

/** Any single ingest/CAS-load step slower than this logs to stdout — a recurring
 * slow step must be VISIBLE in `docker logs`, never a silent CPU burn. */
const SLOW_SELF_INGEST_MS = 1_000;

/**
 * Correlation-time CAS load for the self-loop — MUST be the cached read.
 *
 * This runs on every SDK flush (default every 5s, for as long as the process
 * lives), so it must never pay a full decompress+parse of the stored CAS per
 * call: on a large self/canonical analysis that costs multiple seconds of CPU
 * and GB of GC churn per flush, which pins the main thread forever (observed
 * live: readJsonMaybeCompressed + brotli slice + GC at ~100% CPU for hours).
 * `loadAnalysis(..., { preferCache: true })` reuses the in-memory copy behind
 * an mtime/size fingerprint check, so steady-state flushes cost one fs.stat.
 *
 * Correlation is best-effort: a missing/unreadable analysis returns null and
 * the events persist as `unmatched` (never a drop, never a bootstrap). Unlike
 * getAnalysis this skips stored-element-description application — correlation
 * only reads structural facts, not prose.
 */
/** True when the master env gate is truthy. Anything else = disabled. */
export function selfTelemetryEnabled(): boolean {
  const raw = (process.env.KLAURO_SELF_TELEMETRY || '').trim().toLowerCase();
  return raw !== '' && raw !== '0' && raw !== 'false' && raw !== 'off' && raw !== 'no';
}

/**
 * Resolve the mcp-server package's own `src` directory for development-only
 * self-telemetry when no canonical project key was configured. Production must
 * set KLAURO_SELF_TELEMETRY_PROJECT to the uploaded project identity. This
 * helper never authorizes or starts analysis; unmatched observations remain
 * durable until an existing CAS can correlate them.
 */
export function resolveSelfSourceDir(): string | null {
  try {
    let dir = __dirname; // this file lives in .../apps/mcp-server/src
    for (let hops = 0; hops < 8; hops++) {
      if (nodePath.basename(dir) === 'src' && nodePath.basename(nodePath.dirname(dir)) === 'mcp-server') {
        return dir;
      }
      const parent = nodePath.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    // Fallback for a bundled layout: probe the conventional path off cwd.
    const guess = nodePath.join(process.cwd(), 'apps', 'mcp-server', 'src');
    if (nodeFs.existsSync(guess)) return guess;
  } catch {
    /* ignore — caller falls back to cwd */
  }
  return null;
}

/**
 * The Klauro source path the self-loop attaches events to (also the read key for
 * `get_runtime_observations` / node-metrics). Precedence:
 *   1. KLAURO_SELF_TELEMETRY_PROJECT, retained as the canonical project key
 *      even before its CAS exists so unmatched events can be backfilled later.
 *   2. the mcp-server's own `src` dir, discovered from this module's location.
 *   3. process.cwd() as a last resort.
 * Production sets the override to the uploaded project path; source discovery
 * remains a development fallback only and never triggers analysis.
 */
export function selfProjectPath(): string {
  const override = process.env.KLAURO_SELF_TELEMETRY_PROJECT?.trim();
  if (override) return override;
  return resolveSelfSourceDir() || process.cwd();
}

/**
 * Storage buckets are keyed by literal project path, so observations ingested
 * under KLAURO_SELF_TELEMETRY_PROJECT are invisible to a facet-6 query
 * resolving the canonical hosted project at a different workspace path.
 * KLAURO_SELF_TELEMETRY_CANONICAL_PROJECT closes that gap by mirroring every
 * self-loop observation into a second bucket, in addition to the primary one.
 */
export function selfCanonicalProjectPath(): string | null {
  const raw = process.env.KLAURO_SELF_TELEMETRY_CANONICAL_PROJECT?.trim();
  return raw ? raw : null;
}

/**
 * Mirrors an already-ingested self-telemetry batch into the canonical bucket
 * so a facet-6 query against the canonical hosted project surfaces these
 * observations too. Mirror only, never a move — the primary bucket is
 * unaffected. No-op when the canonical env is unset/blank/identical to
 * primary. Must never trigger source analysis for the canonical path —
 * read-only best-effort correlation, falling back to unmatched. Fire-and-forget:
 * every failure is swallowed, must never affect the primary ingest's result.
 */
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
 * of the SDK's framework middleware we use the SDK's own raw-`http` adapter
 * (`@klauro/telemetry/http`): one event per completed response with method,
 * path, status, and high-res duration — identical field-for-field to the
 * framework middleware (and to the previous hand-rolled wrapper), now sharing
 * the SDK's monotonic `performance.now()` clock for sub-ms accuracy.
 *
 * When the gate is unset this returns the ORIGINAL handler unchanged — zero
 * wrapping, zero overhead, identical behavior to before.
 */
export function instrumentHttpHandler(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  if (!selfTelemetryEnabled()) return handler;
  return klauroHttp(handler);
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
        // Ingest is deliberately CAS-free. Loading a large CAS on the HTTP
        // process blocks health/status traffic and duplicates the analyzer
        // worker's memory. Raw observations are durable immediately and the
        // existing read/backfill path correlates them after analysis lands.
        const ingestStartedAt = Date.now();
        const mapped = events.map(mapSdkEvent);
        await ingestTelemetryBatch(null, projectPath, mapped, { persist: true });
        const ingestElapsedMs = Date.now() - ingestStartedAt;
        if (ingestElapsedMs >= SLOW_SELF_INGEST_MS) {
          process.stdout.write(
            `Klauro self-telemetry: local ingest of ${mapped.length} event(s) for ${projectPath} took ${ingestElapsedMs}ms.\n`,
          );
        }
        // Fire-and-forget mirror into the canonical hosted bucket (GAP #32 part 2),
        // decoupled from the primary ingest above: never awaited, never allowed to
        // affect this transport's own success/failure.
        void mirrorToCanonicalBucket(projectPath, mapped);
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
    // Direct CAS correlation ids, when the SDK caller supplied them, were
    // previously dropped here — every event fell back to route/path fuzzy
    // matching in correlateRuntimeEvent even though it checks these first
    // (product.ts) and getRuntimeEventContract's own correlation_order tells
    // integrators to send static_id as the primary key.
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
