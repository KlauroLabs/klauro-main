import { KlauroClient, Span } from './client';
import { CasRuntimeEvent, KlauroConfig } from './types';

export { KlauroClient } from './client';
export type { Span } from './client';
export type {
  CasRuntimeEvent,
  CasRuntimeEventType,
  KlauroConfig,
} from './types';
export { SCHEMA_VERSION, DEFAULT_ENDPOINT } from './types';

let singleton: KlauroClient | undefined;

/**
 * Initialize the global Klauro telemetry client.
 *
 *   import { init } from '@klauro/telemetry';
 *   init({ apiKey: process.env.KLAURO_API_KEY, projectId: 'my-project', service: 'items-api', environment: 'production' });
 *
 * Returns the client. Safe to call once at boot. A second call replaces the
 * client after flushing the previous one.
 */
export function init(config: KlauroConfig): KlauroClient {
  if (singleton) {
    void singleton.shutdown();
  }
  singleton = new KlauroClient(config);
  return singleton;
}

/** Access the initialized client, or `undefined` if `init()` was never called. */
export function getClient(): KlauroClient | undefined {
  return singleton;
}

/** Record a fully-formed CAS runtime event via the global client. No-op if uninitialized. */
export function recordEvent(event: CasRuntimeEvent): void {
  singleton?.recordEvent(event);
}

/** Record a named custom event. No-op if uninitialized. */
export function record(name: string, attributes?: Record<string, unknown>): void {
  singleton?.record(name, attributes);
}

/** Increment a counter. No-op if uninitialized. */
export function incrementCounter(
  name: string,
  value?: number,
  attributes?: Record<string, unknown>,
): void {
  singleton?.incrementCounter(name, value, attributes);
}

/** Record a gauge reading. No-op if uninitialized. */
export function recordGauge(
  name: string,
  value: number,
  attributes?: Record<string, unknown>,
): void {
  singleton?.recordGauge(name, value, attributes);
}

/** Capture an error. No-op if uninitialized. */
export function captureError(err: unknown, extra?: Partial<CasRuntimeEvent>): void {
  singleton?.captureError(err, extra);
}

/**
 * Start a span. If uninitialized, returns a no-op span so call sites never
 * need to null-check.
 */
export function startSpan(name: string, extra?: Partial<CasRuntimeEvent>): Span {
  if (singleton) return singleton.startSpan(name, extra);
  return {
    spanId: '',
    traceId: '',
    setAttribute() {
      return this;
    },
    end() {
      /* no-op */
    },
  };
}

/** Flush the global client. No-op if uninitialized. */
export async function flush(): Promise<void> {
  await singleton?.flush();
}

/** Flush and stop the global client. No-op if uninitialized. */
export async function shutdown(): Promise<void> {
  await singleton?.shutdown();
  singleton = undefined;
}
