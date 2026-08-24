import {
  CasRuntimeEvent,
  KlauroConfig,
  ResolvedConfig,
  SCHEMA_VERSION,
  DEFAULT_ENDPOINT,
} from './types';
import { nowMs, elapsedMs } from './clock';

const activeClients = new Set<KlauroClient>();
const MAX_INGEST_BATCH_SIZE = 1000;
let lifecycleHookInstalled = false;

function flushActiveClients(): void {
  if (typeof process !== 'undefined') process.removeListener('beforeExit', flushActiveClients);
  lifecycleHookInstalled = false;
  for (const client of activeClients) void client.flush();
}

function registerActiveClient(client: KlauroClient): void {
  activeClients.add(client);
  if (lifecycleHookInstalled || typeof process === 'undefined' || typeof process.on !== 'function') return;
  process.on('beforeExit', flushActiveClients);
  lifecycleHookInstalled = true;
}

function unregisterActiveClient(client: KlauroClient): void {
  activeClients.delete(client);
  if (activeClients.size > 0 || !lifecycleHookInstalled || typeof process === 'undefined') return;
  process.removeListener('beforeExit', flushActiveClients);
  lifecycleHookInstalled = false;
}

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

export class KlauroClient {
  private readonly config: ResolvedConfig;
  private queue: CasRuntimeEvent[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private shuttingDown = false;
  private flushChain: Promise<void> = Promise.resolve();

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
      retryAttempts: Math.max(1, config.retryAttempts ?? 3),
      retryBaseDelay: Math.max(0, config.retryBaseDelay ?? 100),
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

      if (typeof this.timer.unref === 'function') this.timer.unref();
    }
    registerActiveClient(this);
  }

  recordEvent(event: CasRuntimeEvent): void {
    if (this.shuttingDown) return;
    this.enqueue(event);
  }

  record(name: string, attributes: Record<string, unknown> = {}): void {
    this.recordEvent({ type: 'custom', signal: name, attributes });
  }

  incrementCounter(name: string, value = 1, attributes: Record<string, unknown> = {}): void {
    this.recordEvent({
      type: 'custom',
      signal: name,
      attributes: { ...attributes, metric_type: 'counter', metric_value: value },
    });
  }

  recordGauge(name: string, value: number, attributes: Record<string, unknown> = {}): void {
    this.recordEvent({
      type: 'custom',
      signal: name,
      attributes: { ...attributes, metric_type: 'gauge', metric_value: value },
    });
  }

  captureError(err: unknown, extra: Partial<CasRuntimeEvent> = {}): void {
    const error = err instanceof Error ? err : new Error(String(err));
    this.recordEvent({
      type: 'error',
      error_message: error.message,
      stack: error.stack,
      ...extra,
    });
  }

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

  get pending(): number {
    return this.queue.length;
  }

  async flush(): Promise<void> {
    const operation = this.flushChain.then(() => this.deliverQueuedEvents());
    this.flushChain = operation.catch(() => {});
    await operation;
  }

  private async deliverQueuedEvents(): Promise<void> {
    const fetchImpl = this.config.fetchImpl || (globalThis.fetch as typeof fetch | undefined);
    if (!fetchImpl) {
      this.config.onError(new Error('[klauro] no fetch implementation available'));
      return;
    }

    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, MAX_INGEST_BATCH_SIZE);
      let delivered = false;
      let lastError: unknown;
      for (let attempt = 0; attempt < this.config.retryAttempts; attempt += 1) {
        try {
          const res = await fetchImpl(this.ingestUrl(), {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
            },
            body: JSON.stringify({ events: batch }),
          });
          if (!res.ok) throw new Error(`[klauro] ingest returned HTTP ${res.status}`);
          const acknowledgement = await responseAcknowledgement(res);
          if (acknowledgement !== undefined && acknowledgement !== batch.length) {
            throw new Error(`[klauro] ingest acknowledged ${acknowledgement}/${batch.length} event(s)`);
          }
          delivered = true;
          if (this.config.debug) console.error(`[klauro] delivered ${batch.length} event(s)`);
          break;
        } catch (error) {
          lastError = error;
          if (attempt + 1 < this.config.retryAttempts && this.config.retryBaseDelay > 0) {
            await delay(this.config.retryBaseDelay * (2 ** attempt));
          }
        }
      }
      if (!delivered) {
        this.requeue(batch);
        this.config.onError(lastError);
        return;
      }
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    unregisterActiveClient(this);
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.flush();
  }

  private enqueue(event: CasRuntimeEvent): void {
    this.queue.push(this.normalize(event));
    if (this.queue.length > this.config.maxQueueSize) {

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
      event_id: event.event_id || randomHex(16),
    };
  }

  private ingestUrl(): string {
    return `${this.config.endpoint}/api/telemetry/runtime-events/${encodeURIComponent(
      this.config.projectId,
    )}`;
  }

}

async function responseAcknowledgement(response: Response): Promise<number | undefined> {
  if (typeof response.json !== 'function') return undefined;
  try {
    const body = await response.json() as { event_count?: unknown };
    return typeof body?.event_count === 'number' ? body.event_count : undefined;
  } catch {
    return undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
