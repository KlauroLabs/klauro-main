import { KlauroClient } from '../client';
import { getClient } from '../index';
import { nowMs, elapsedMs } from '../clock';

interface ExpressReqLike {
  method: string;
  path?: string;
  originalUrl?: string;
  url?: string;
  baseUrl?: string;
  route?: { path?: string };
}
interface ExpressResLike {
  statusCode: number;
  on(event: 'finish', listener: () => void): unknown;
}

function resolveRoute(req: ExpressReqLike): string | undefined {
  if (req.route?.path) return `${req.baseUrl || ''}${req.route.path}`;
  return undefined;
}

export function klauroExpress(client?: KlauroClient) {
  return (req: ExpressReqLike, res: ExpressResLike, next: () => void): void => {
    const c = client || getClient();
    if (!c) {
      next();
      return;
    }
    const startedAt = nowMs();
    res.on('finish', () => {
      const isError = res.statusCode >= 500;
      c.recordEvent({
        type: isError ? 'error' : 'request',
        method: req.method,
        route: resolveRoute(req),
        path: req.originalUrl || req.path || req.url,
        status_code: res.statusCode,
        duration_ms: elapsedMs(startedAt),
      });
    });
    next();
  };
}

export function klauroExpressErrorHandler(client?: KlauroClient) {
  return (err: Error, req: ExpressReqLike, _res: ExpressResLike, next: (err: Error) => void): void => {
    const c = client || getClient();
    c?.captureError(err, {
      method: req.method,
      route: resolveRoute(req),
      path: req.originalUrl || req.path || req.url,
    });
    next(err);
  };
}
