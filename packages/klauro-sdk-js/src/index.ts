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

export function init(config: KlauroConfig): KlauroClient {
  if (singleton) {
    void singleton.shutdown();
  }
  singleton = new KlauroClient(config);
  return singleton;
}

export function getClient(): KlauroClient | undefined {
  return singleton;
}

export function recordEvent(event: CasRuntimeEvent): void {
  singleton?.recordEvent(event);
}

export function record(name: string, attributes?: Record<string, unknown>): void {
  singleton?.record(name, attributes);
}

export function incrementCounter(
  name: string,
  value?: number,
  attributes?: Record<string, unknown>,
): void {
  singleton?.incrementCounter(name, value, attributes);
}

export function recordGauge(
  name: string,
  value: number,
  attributes?: Record<string, unknown>,
): void {
  singleton?.recordGauge(name, value, attributes);
}

export function captureError(err: unknown, extra?: Partial<CasRuntimeEvent>): void {
  singleton?.captureError(err, extra);
}

export function startSpan(name: string, extra?: Partial<CasRuntimeEvent>): Span {
  if (singleton) return singleton.startSpan(name, extra);
  return {
    spanId: '',
    traceId: '',
    setAttribute() {
      return this;
    },
    end() {

    },
  };
}

export async function flush(): Promise<void> {
  await singleton?.flush();
}

export async function shutdown(): Promise<void> {
  await singleton?.shutdown();
  singleton = undefined;
}
