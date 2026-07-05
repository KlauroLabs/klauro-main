import { KlauroClient } from '../client';
import { getClient } from '../index';
import { nowMs, elapsedMs } from '../clock';

/**
 * NestJS interceptor.
 *
 * Implemented without a hard dependency on `@nestjs/common` or `rxjs` so the
 * package installs cleanly in non-Nest projects. It is structurally a
 * `NestInterceptor`: Nest calls `intercept(context, next)` and expects an
 * Observable back, which we produce by wrapping `next.handle()`'s stream.
 *
 *   import { KlauroInterceptor } from '@klauro/telemetry/nestjs';
 *   app.useGlobalInterceptors(new KlauroInterceptor());
 */
export class KlauroInterceptor {
  constructor(private readonly client?: KlauroClient) {}

  intercept(context: any, next: { handle: () => any }): any {
    const c = this.client || getClient();
    const stream$ = next.handle();
    if (!c) return stream$;

    const http = context?.switchToHttp?.();
    const req = http?.getRequest?.() || {};
    const res = http?.getResponse?.() || {};
    const method: string = req.method || 'GET';
    const route: string | undefined =
      req.route?.path || req.routeOptions?.url || req.url;
    const path: string | undefined = req.originalUrl || req.url;
    const startedAt = nowMs();

    // rxjs Observable is thenable-free; use the `tap`-style subscribe wrapper
    // via `pipe` if available, else fall back to `.subscribe` book-ending.
    const emit = (isError: boolean, status: number, err?: unknown) => {
      if (err) {
        c.captureError(err, {
          method,
          route,
          path,
          status_code: status,
          duration_ms: elapsedMs(startedAt),
        });
      }
      c.recordEvent({
        type: isError ? 'error' : 'request',
        method,
        route,
        path,
        status_code: status,
        duration_ms: Date.now() - startedAt,
      });
    };

    if (typeof stream$?.pipe === 'function' && typeof stream$?.subscribe === 'function') {
      // Wrap without importing rxjs operators: subscribe once to book-end.
      return new stream$.constructor((subscriber: any) => {
        const sub = stream$.subscribe({
          next: (v: unknown) => subscriber.next(v),
          error: (e: unknown) => {
            emit(true, res.statusCode || 500, e);
            subscriber.error(e);
          },
          complete: () => {
            emit((res.statusCode || 200) >= 500, res.statusCode || 200);
            subscriber.complete();
          },
        });
        return () => sub.unsubscribe();
      });
    }

    return stream$;
  }
}
