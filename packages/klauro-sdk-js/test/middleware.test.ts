import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { KlauroClient } from '../src/client';
import type { CasRuntimeEvent } from '../src/types';
import { klauroExpress, klauroExpressErrorHandler } from '../src/middleware/express';
import { klauroKoa } from '../src/middleware/koa';
import { klauroFastify } from '../src/middleware/fastify';
import { KlauroInterceptor } from '../src/middleware/nestjs';

function collector() {
  const events: CasRuntimeEvent[] = [];
  const client = new KlauroClient({
    projectId: 'p',
    flushInterval: 0,
    fetchImpl: (async (_u: any, init: any) => {
      JSON.parse(init.body).events.forEach((e: CasRuntimeEvent) => events.push(e));
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch,
  });
  return { events, client };
}

class MockRes extends EventEmitter {
  statusCode = 200;
}

test('express middleware records route, status, duration for a request', async () => {
  const { events, client } = collector();
  const mw = klauroExpress(client);
  const req = { method: 'GET', path: '/items/42', originalUrl: '/items/42', baseUrl: '', route: { path: '/items/:id' } };
  const res = new MockRes();
  res.statusCode = 200;
  mw(req as never, res as never, () => undefined);
  res.emit('finish');
  await client.flush();

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'request');
  assert.equal(events[0].method, 'GET');
  assert.equal(events[0].route, '/items/:id');
  assert.equal(events[0].status_code, 200);
  assert.equal(typeof events[0].duration_ms, 'number');
});

test('express marks 5xx as error and error handler captures the throw', async () => {
  const { events, client } = collector();
  const mw = klauroExpress(client);
  const errMw = klauroExpressErrorHandler(client);
  const req = { method: 'POST', path: '/items', originalUrl: '/items', baseUrl: '', route: { path: '/items' } };
  const res = new MockRes();
  res.statusCode = 500;
  mw(req as never, res as never, () => undefined);
  errMw(new TypeError('kaboom'), req as never, res as never, () => undefined);
  res.emit('finish');
  await client.flush();

  const err = events.find((e) => e.error_message);
  const req5xx = events.find((e) => e.type === 'error' && !e.error_message);
  assert.ok(err, 'error handler emits an error event');
  assert.equal(err!.error_message, 'kaboom');
  assert.ok(req5xx, '5xx request is classified as error');
});

test('express middleware is a no-op passthrough with no client', () => {
  const mw = klauroExpress(undefined);
  let nextCalled = false;
  const res = new MockRes();
  mw({ method: 'GET' } as never, res as never, () => {
    nextCalled = true;
  });
  assert.ok(nextCalled);
});

test('koa middleware records request and captures thrown error', async () => {
  const { events, client } = collector();
  const mw = klauroKoa(client);

  const okCtx: any = { method: 'GET', url: '/ok', status: 200, _matchedRoute: '/ok' };
  await mw(okCtx, async () => undefined);

  const errCtx: any = { method: 'GET', url: '/boom', status: 500, _matchedRoute: '/boom' };
  await assert.rejects(
    mw(errCtx, async () => {
      throw new Error('koa fail');
    }),
  );
  await client.flush();

  assert.ok(events.find((e) => e.path === '/ok' && e.type === 'request'));
  assert.ok(events.find((e) => e.error_message === 'koa fail'));
});

test('fastify plugin registers hooks and emits an event on response', async () => {
  const { events, client } = collector();
  const hooks: Record<string, Function> = {};
  const fakeFastify = {
    addHook(name: string, fn: Function) {
      hooks[name] = fn;
    },
  };
  await new Promise<void>((resolve) => klauroFastify(client)(fakeFastify, {}, resolve));

  const req: any = { method: 'GET', url: '/things/1', routeOptions: { url: '/things/:id' } };
  const reply: any = { statusCode: 200 };
  await new Promise<void>((resolve) => hooks.onRequest(req, reply, resolve));
  await new Promise<void>((resolve) => hooks.onResponse(req, reply, resolve));
  await client.flush();

  assert.equal(events.length, 1);
  assert.equal(events[0].route, '/things/:id');
  assert.equal(events[0].type, 'request');
  assert.equal(typeof events[0].duration_ms, 'number');
});

// Minimal rxjs-Observable stand-in: constructor(subscribeFn), pipe(), subscribe().
class FakeObservable {
  constructor(private readonly subscribeFn: (subscriber: any) => any) {}
  pipe() {
    return this;
  }
  subscribe(observer: any) {
    const teardown = this.subscribeFn(observer);
    return { unsubscribe: () => (typeof teardown === 'function' ? teardown() : undefined) };
  }
}

test('nestjs interceptor emits a request event when the stream completes', async () => {
  const { events, client } = collector();
  const interceptor = new KlauroInterceptor(client);
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ method: 'GET', url: '/nest', route: { path: '/nest' } }),
      getResponse: () => ({ statusCode: 200 }),
    }),
  };
  const source = new FakeObservable((sub: any) => {
    sub.next('payload');
    sub.complete();
    return () => undefined;
  });
  const result = interceptor.intercept(context, { handle: () => source });
  await new Promise<void>((resolve) =>
    result.subscribe({ next: () => undefined, error: () => resolve(), complete: () => resolve() }),
  );
  await client.flush();

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'request');
  assert.equal(events[0].route, '/nest');
});
