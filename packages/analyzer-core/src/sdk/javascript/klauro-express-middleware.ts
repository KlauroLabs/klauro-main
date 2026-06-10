import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';

export interface KlauroExpressTelemetryConfig {
  serviceName?: string;
  environment?: string;
  filePath?: string;
  endpoint?: string;
  batchSize?: number;
  flushIntervalMs?: number;
}

export interface KlauroTelemetryEvent {
  kind: 'request' | 'error';
  timestamp: string;
  service_name?: string;
  environment?: string;
  method: string;
  route?: string;
  path?: string;
  status: number;
  duration_ms: number;
  error?: { type: string; message: string; stack_top_frames: string[] };
}

interface RequestLike {
  method: string;
  path?: string;
  baseUrl?: string;
  route?: { path?: string };
  klauroError?: Error;
}

interface ResponseLike {
  statusCode: number;
  on(event: 'finish', listener: () => void): unknown;
}

export interface KlauroExpressTelemetry {
  requestHandler: (req: RequestLike, res: ResponseLike, next: () => void) => void;
  errorHandler: (err: Error, req: RequestLike, res: ResponseLike, next: (err: Error) => void) => void;
  flush: () => void;
  shutdown: () => void;
}

export function createKlauroExpressTelemetry(config: KlauroExpressTelemetryConfig = {}): KlauroExpressTelemetry {
  const batchSize = config.batchSize ?? 20;
  let buffer: KlauroTelemetryEvent[] = [];
  const timer = setInterval(() => flush(), config.flushIntervalMs ?? 5000);
  if (typeof timer.unref === 'function') timer.unref();

  function deliver(events: KlauroTelemetryEvent[]): void {
    if (config.filePath) {
      fs.appendFileSync(config.filePath, events.map(event => JSON.stringify(event)).join('\n') + '\n');
    }
    if (config.endpoint) {
      const url = new URL(config.endpoint);
      const request = (url.protocol === 'https:' ? https : http).request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      request.on('error', () => undefined);
      request.end(JSON.stringify({ events }));
    }
  }

  function flush(): void {
    if (buffer.length === 0) return;
    const events = buffer;
    buffer = [];
    deliver(events);
  }

  function requestHandler(req: RequestLike, res: ResponseLike, next: () => void): void {
    const startedAt = Date.now();
    res.on('finish', () => {
      const error = req.klauroError;
      buffer.push({
        kind: error || res.statusCode >= 500 ? 'error' : 'request',
        timestamp: new Date(startedAt).toISOString(),
        service_name: config.serviceName,
        environment: config.environment,
        method: req.method,
        route: req.route?.path ? `${req.baseUrl || ''}${req.route.path}` : undefined,
        path: req.path,
        status: res.statusCode,
        duration_ms: Date.now() - startedAt,
        ...(error ? {
          error: {
            type: error.name || 'Error',
            message: error.message,
            stack_top_frames: (error.stack || '').split('\n').slice(1, 6).map(line => line.trim()),
          },
        } : {}),
      });
      if (buffer.length >= batchSize) flush();
    });
    next();
  }

  function errorHandler(err: Error, req: RequestLike, _res: ResponseLike, next: (err: Error) => void): void {
    req.klauroError = err;
    next(err);
  }

  return { requestHandler, errorHandler, flush, shutdown: () => { clearInterval(timer); flush(); } };
}
