import { KlauroClient } from '../client';
import { getClient } from '../index';
import { nowMs, elapsedMs } from '../clock';

interface KoaCtxLike {
  method: string;
  path?: string;
  url?: string;
  status: number;

  _matchedRoute?: string;
  routePath?: string;
}

function routeOf(ctx: KoaCtxLike): string | undefined {
  return ctx._matchedRoute || ctx.routePath;
}

export function klauroKoa(client?: KlauroClient) {
  return async (ctx: KoaCtxLike, next: () => Promise<void>): Promise<void> => {
    const c = client || getClient();
    if (!c) {
      await next();
      return;
    }
    const startedAt = nowMs();
    try {
      await next();
    } catch (err) {
      c.captureError(err, {
        method: ctx.method,
        route: routeOf(ctx),
        path: ctx.url || ctx.path,
        duration_ms: elapsedMs(startedAt),
      });
      throw err;
    } finally {
      c.recordEvent({
        type: ctx.status >= 500 ? 'error' : 'request',
        method: ctx.method,
        route: routeOf(ctx),
        path: ctx.url || ctx.path,
        status_code: ctx.status,
        duration_ms: elapsedMs(startedAt),
      });
    }
  };
}
