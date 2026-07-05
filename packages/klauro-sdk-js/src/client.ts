import {
  CasRuntimeEvent,
  KlauroConfig,
  ResolvedConfig,
  SCHEMA_VERSION,
  DEFAULT_ENDPOINT,
} from './types';
import { nowMs, elapsedMs } from './clock';

/**
 * A live handle to a running span. `end()` records an `exit` event with the
 * elapsed duration. Safe to call once; subsequent calls are no-ops.
 */
export interface Span {
  readonly spanId: string;
  readonly traceId: string;
  setAttribute(key: string, value: unknown): Span;
  end(extra?: Partial<CasRuntimeEvent>): void;
}

function randomHex(bytes: number): string {
  let out = '';
  for (let i = 0; i < bytes; i += 1) {
    out += Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * The Klauro runtime telemetry client.
 *
 * Non-blocking: `recordEvent` / `captureError` / span end just enqueue and
 * return. Delivery happens on a batch threshold, a flush interval, or process
 * exit. Network failures never crash the host process — failed batches are
 * re-queued (bounded) and `onError` is invoked.
 */
export class KlauroClient {
  private readonly config: ResolvedConfig;
  private queue: CasRuntimeEvent[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private exitHooksInstalled = false;
  private shuttingDown = false;

  constructor(config: KlauroConfig) {
    const projectId = config.projectId;
    if (!projectId) {
      throw new Error(
        '[klauro] init() requires a projectId. e.g. init({ projectId, apiKey, service })',
      );
    }
    this.config = {
      projectId,
      apiKey: config.apiKey,
      endpoint: (config.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, ''),
      service: config.service || config.serviceName,
      environment: config.environment,
      batchSize: config.batchSize ?? 50,
      flushInterval: config.flushInterval ?? 5000,
      maxQueueSize: config.maxQueueSize ?? 10_000,
      fetchImpl: config.fetchImpl,
      onError:
        config.onError ||
        ((err) => {
          if (config.debug) console.error('[klauro] delivery failed:', err);
        }),
      debug: config.debug ?? false,
    };

    if (this.config.flushInterval > 0) {
      this.timer = setInterval(() => {
        void this.flush();
      }, this.config.flushInterval);
      // Do not keep the event loop alive just for telemetry.
      if (typeof this.timer.unref === 'function') this.timer.unref();
    }
    this.installExitHooks();
  }

  /** Record a fully-formed CAS runtime event. Non-blocking. */
  recordEvent(event: CasRuntimeEvent): void {
    if (this.shuttingDown) return;
    this.enqueue(event);
  }

  /**
   * Record a named custom event with arbitrary attributes.
   * Maps to a `custom` CAS event with `signal = name`.
   */
  record(name: string, attributes: Record<string, unknown> = {}): void {
    this.recordEvent({ type: 'custom', signal: name, attributes });
  }

  /** Record a numeric counter increment as a custom metric event. */
  incrementCounter(name: string, value = 1, attributes: Record<string, unknown> = {}): void {
    this.recordEvent({
      type: 'custom',
      signal: name,
      attributes: { ...attributes, metric_type: 'counter', metric_value: value },
    });
  }

  /** Record a gauge reading as a custom metric event. */
  recordGauge(name: string, value: number, attributes: Record<string, unknown> = {}): void {
    this.recordEvent({
      type: 'custom',
      signal: name,
      attributes: { ...attributes, metric_type: 'gauge', metric_value: value },
    });
  }

  /** Capture an error. Non-blocking. */
  captureError(err: unknown, extra: Partial<CasRuntimeEvent> = {}): void {
    const error = err instanceof Error ? err : new Error(String(err));
    this.recordEvent({
      type: 'error',
      error_message: error.message,
      stack: error.stack,
      ...extra,
    });
  }

  /** Start a span. Call `.end()` to record the `exit` event. */
  startSpan(name: string, extra: Partial<CasRuntimeEvent> = {}): Span {
    const startedAt = nowMs();
    const traceId = extra.trace_id || randomHex(16);
    const spanId = randomHex(8);
    const attributes: Record<string, unknown> = { ...(extra.attributes || {}) };
    let ended = false;
    const self = this;
    return {
      spanId,
      traceId,
      setAttribute(key, value) {
        attributes[key] = value;
        return this;
      },
      end(endExtra: Partial<CasRuntimeEvent> = {}) {
        if (ended) return;
        ended = true;
        self.recordEvent({
          type: 'exit',
          signal: name,
          trace_id: traceId,
          span_id: spanId,
          duration_ms: elapsedMs(startedAt),
          ...extra,
          ...endExtra,
          attributes: { ...attributes, ...(endExtra.attributes || {}) },
        });
      },
    };
  }

  /** Number of events waiting to be delivered. */
  get pending(): number {
    return this.queue.length;
  }

  /** Force-deliver queued events. Awaitable; resolves even on failure. */
  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);
    const fetchImpl = this.config.fetchImpl || (globalThis.fetch as typeof fetch | undefined);
    if (!fetchImpl) {
      this.requeue(batch);
      this.config.onError(new Error('[klauro] no fetch implementation available'));
      return;
    }
    try {
      const res = await fetchImpl(this.ingestUrl(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify({ events: batch }),
      });
      if (!res.ok) {
        this.requeue(batch);
        this.config.onError(new Error(`[klauro] ingest returned HTTP ${res.status}`));
      } else if (this.config.debug) {
        console.error(`[klauro] delivered ${batch.length} event(s)`);
      }
    } catch (err) {
      this.requeue(batch);
      this.config.onError(err);
    }
  }

  /** Flush and stop timers/exit hooks. Idempotent. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.flush();
  }

  private enqueue(event: CasRuntimeEvent): void {
    this.queue.push(this.normalize(event));
    if (this.queue.length > this.config.maxQueueSize) {
      // Drop oldest to bound memory; telemetry must never OOM the host.
      this.queue.splice(0, this.queue.length - this.config.maxQueueSize);
    }
    if (this.queue.length >= this.config.batchSize) {
      void this.flush();
    }
  }

  private requeue(batch: CasRuntimeEvent[]): void {
    this.queue.unshift(...batch);
    if (this.queue.length > this.config.maxQueueSize) {
      this.queue.splice(this.config.maxQueueSize);
    }
  }

  private normalize(event: CasRuntimeEvent): CasRuntimeEvent {
    return {
      schema_version: SCHEMA_VERSION,
      timestamp: new Date().toISOString(),
      service_name: this.config.service,
      environment: this.config.environment,
      ...event,
    };
  }

  private ingestUrl(): string {
    return `${this.config.endpoint}/api/telemetry/runtime-events/${encodeURIComponent(
      this.config.projectId,
    )}`;
  }

  private installExitHooks(): void {
    if (this.exitHooksInstalled) return;
    if (typeof process === 'undefined' || typeof process.once !== 'function') return;
    this.exitHooksInstalled = true;
    const finalFlush = () => {
      void this.flush();
    };
    process.once('beforeExit', finalFlush);
    process.once('SIGTERM', finalFlush);
    process.once('SIGINT', finalFlush);
  }
}
