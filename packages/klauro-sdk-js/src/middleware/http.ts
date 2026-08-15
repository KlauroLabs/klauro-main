import { KlauroClient } from '../client';
import { getClient } from '../index';
import { nowMs, elapsedMs } from '../clock';

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

        }
      });
    } catch {

    }
    handler(req, res);
  };
}

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
