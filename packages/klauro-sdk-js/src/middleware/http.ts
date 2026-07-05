import { KlauroClient } from '../client';
import { getClient } from '../index';
import { nowMs, elapsedMs } from '../clock';

/**
 * Minimal structural stand-ins for Node's `http.IncomingMessage` /
 * `http.ServerResponse`. Kept local so `@klauro/telemetry` has no hard
 * dependency on `@types/node` — any object with these fields works, which also
 * makes the middleware trivially testable with a plain EventEmitter.
 */
interface HttpReqLike {
  method?: string;
  url?: string;
}
interface HttpResLike {
  statusCode?: number;
  on(event: 'finish', listener: () => void): unknown;
}

type RawHttpHandler<Req extends HttpReqLike, Res extends HttpResLike> = (
  req: Req,
  res: Res,
) => void;

/** Emit the completed-request event once, guarding against throws into the host. */
function recordCompletion(
  c: KlauroClient,
  method: string | undefined,
  path: string | undefined,
  statusCode: number,
  startedAt: number,
): void {
  c.recordEvent({
    type: statusCode >= 500 ? 'error' : 'request',
    method,
    path,
    status_code: statusCode,
    duration_ms: elapsedMs(startedAt),
  });
}

/**
 * Wrap a raw Node `http` request handler (the function passed to
 * `http.createServer`) with request instrumentation. Records one `request` (or
 * `error` for 5xx) event per completed response — method, path, status, and
 * high-res duration — using the SDK's monotonic clock, matching the framework
 * middleware exactly.
 *
 *   import { klauroHttp } from '@klauro/telemetry/http';
 *   const server = http.createServer(klauroHttp(requestHandler));
 *
 * When no client is initialized (init() never called) this returns the ORIGINAL
 * handler unchanged — zero wrapping, zero overhead. Telemetry failures are
 * swallowed and can never affect request handling.
 */
export function klauroHttp<Req extends HttpReqLike, Res extends HttpResLike>(
  handler: RawHttpHandler<Req, Res>,
  client?: KlauroClient,
): RawHttpHandler<Req, Res> {
  const explicit = client;
  return (req: Req, res: Res): void => {
    const c = explicit || getClient();
    if (!c) {
      handler(req, res);
      return;
    }
    try {
      const startedAt = nowMs();
      res.on('finish', () => {
        try {
          recordCompletion(c, req.method, req.url, res.statusCode || 0, startedAt);
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

/**
 * Wrap an existing `http.Server`-like object in place by intercepting its
 * `'request'` listeners. Handlers registered BEFORE this call are wrapped; use
 * `klauroHttp` on the handler directly when you control server construction.
 *
 *   import { instrumentHttpServer } from '@klauro/telemetry/http';
 *   instrumentHttpServer(server);
 */
export function instrumentHttpServer<
  Req extends HttpReqLike,
  Res extends HttpResLike,
  Server extends {
    listeners(event: 'request'): Array<RawHttpHandler<Req, Res>>;
    removeListener(event: 'request', listener: RawHttpHandler<Req, Res>): unknown;
    on(event: 'request', listener: RawHttpHandler<Req, Res>): unknown;
  },
>(server: Server, client?: KlauroClient): Server {
  const existing = server.listeners('request');
  for (const listener of existing) {
    server.removeListener('request', listener);
    server.on('request', klauroHttp<Req, Res>(listener, client));
  }
  return server;
}
