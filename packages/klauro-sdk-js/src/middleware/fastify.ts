import { KlauroClient } from '../client';
import { getClient } from '../index';
import { nowMs, elapsedMs } from '../clock';

interface FastifyReqLike {
  method: string;
  routeOptions?: { url?: string };
  routerPath?: string;
  url?: string;
}
interface FastifyReplyLike {
  statusCode: number;
}
type HookDone = (err?: Error) => void;

const START = Symbol('klauro.start');

function routeOf(req: FastifyReqLike): string | undefined {
  return req.routeOptions?.url || req.routerPath;
}

export function klauroFastify(client?: KlauroClient) {
  const plugin = (fastify: any, _opts: unknown, done: HookDone): void => {
    const c = client || getClient();
    if (!c) {
      done();
      return;
    }
    fastify.addHook('onRequest', (req: any, _reply: FastifyReplyLike, hookDone: HookDone) => {
      req[START] = nowMs();
      hookDone();
    });
    fastify.addHook('onResponse', (req: any, reply: FastifyReplyLike, hookDone: HookDone) => {
      const startedAt = req[START] ?? nowMs();
      c.recordEvent({
        type: reply.statusCode >= 500 ? 'error' : 'request',
        method: req.method,
        route: routeOf(req),
        path: req.url,
        status_code: reply.statusCode,
        duration_ms: elapsedMs(startedAt),
      });
      hookDone();
    });
    fastify.addHook('onError', (req: any, _reply: FastifyReplyLike, err: Error, hookDone: HookDone) => {
      c.captureError(err, { method: req.method, route: routeOf(req), path: req.url });
      hookDone();
    });
    done();
  };

  (plugin as any)[Symbol.for('skip-override')] = true;
  return plugin;
}
