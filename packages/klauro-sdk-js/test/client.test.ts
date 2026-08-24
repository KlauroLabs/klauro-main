import test from 'node:test';
import assert from 'node:assert/strict';
import { KlauroClient } from '../src/client';
import type { CasRuntimeEvent } from '../src/types';

interface Capture {
  url: string;
  body: { events: CasRuntimeEvent[] };
  auth?: string;
}

function makeFetch(
  captures: Capture[],
  opts: { fail?: boolean; status?: number } = {},
): typeof fetch {
  return (async (url: any, init: any) => {
    captures.push({
      url: String(url),
      body: JSON.parse(init.body),
      auth: init.headers?.authorization,
    });
    if (opts.fail) throw new Error('network down');
    const status = opts.status ?? 200;
    return { ok: status >= 200 && status < 300, status } as Response;
  }) as unknown as typeof fetch;
}

test('normalizes events with schema_version, timestamp, service, environment', async () => {
  const captures: Capture[] = [];
  const c = new KlauroClient({
    projectId: 'p1',
    apiKey: 'secret',
    service: 'items-api',
    environment: 'test',
    flushInterval: 0,
    fetchImpl: makeFetch(captures),
  });
  c.record('cache.hit', { key: 'x' });
  await c.flush();

  assert.equal(captures.length, 1);
  const ev = captures[0].body.events[0];
  assert.equal(ev.type, 'custom');
  assert.equal(ev.signal, 'cache.hit');
  assert.equal(ev.schema_version, '1.0.0');
  assert.equal(ev.service_name, 'items-api');
  assert.equal(ev.environment, 'test');
  assert.ok(!Number.isNaN(new Date(ev.timestamp!).getTime()));
  assert.deepEqual(ev.attributes, { key: 'x' });
});

test('posts to the CAS runtime-events ingest URL with bearer auth', async () => {
  const captures: Capture[] = [];
  const c = new KlauroClient({
    projectId: 'proj id',
    apiKey: 'k',
    endpoint: 'https://example.test/',
    flushInterval: 0,
    fetchImpl: makeFetch(captures),
  });
  c.record('x');
  await c.flush();
  assert.equal(captures[0].url, 'https://example.test/api/telemetry/runtime-events/proj%20id');
  assert.equal(captures[0].auth, 'Bearer k');
});

test('flushes automatically at batchSize and empties the queue', async () => {
  const captures: Capture[] = [];
  const c = new KlauroClient({
    projectId: 'p',
    batchSize: 3,
    flushInterval: 0,
    fetchImpl: makeFetch(captures),
  });
  c.record('a');
  c.record('b');
  assert.equal(c.pending, 2, 'below batch size stays queued');
  c.record('c');
  await new Promise((r) => setImmediate(r));
  assert.equal(captures.length, 1, 'reaching batch size triggers a flush');
  assert.equal(captures[0].body.events.length, 3);
});

test('re-queues the batch on network failure and never throws', async () => {
  const captures: Capture[] = [];
  const errors: unknown[] = [];
  const c = new KlauroClient({
    projectId: 'p',
    flushInterval: 0,
    onError: (e) => errors.push(e),
    fetchImpl: makeFetch(captures, { fail: true }),
  });
  c.record('a');
  await c.flush();
  assert.equal(c.pending, 1, 'failed events are retained');
  assert.equal(errors.length, 1);
});

test('re-queues on non-2xx and reports the status', async () => {
  const captures: Capture[] = [];
  const errors: unknown[] = [];
  const c = new KlauroClient({
    projectId: 'p',
    flushInterval: 0,
    onError: (e) => errors.push(e),
    fetchImpl: makeFetch(captures, { status: 503 }),
  });
  c.record('a');
  await c.flush();
  assert.equal(c.pending, 1);
  assert.match(String(errors[0]), /HTTP 503/);
});

test('captureError produces an error event with message and stack', async () => {
  const captures: Capture[] = [];
  const c = new KlauroClient({ projectId: 'p', flushInterval: 0, fetchImpl: makeFetch(captures) });
  c.captureError(new TypeError('boom'), { route: '/x' });
  await c.flush();
  const ev = captures[0].body.events[0];
  assert.equal(ev.type, 'error');
  assert.equal(ev.error_message, 'boom');
  assert.equal(ev.route, '/x');
  assert.match(ev.stack || '', /TypeError: boom/);
});

test('startSpan records an exit event with duration and correlated ids', async () => {
  const captures: Capture[] = [];
  const c = new KlauroClient({ projectId: 'p', flushInterval: 0, fetchImpl: makeFetch(captures) });
  const span = c.startSpan('db.query', { node_id: 'n1' });
  span.setAttribute('table', 'items');
  span.end();
  span.end(); // idempotent
  await c.flush();
  assert.equal(captures[0].body.events.length, 1, 'second end() is a no-op');
  const ev = captures[0].body.events[0];
  assert.equal(ev.type, 'exit');
  assert.equal(ev.signal, 'db.query');
  assert.equal(ev.node_id, 'n1');
  assert.equal(ev.attributes?.table, 'items');
  assert.equal(typeof ev.duration_ms, 'number');
  assert.ok(ev.span_id && ev.trace_id);
});

test('counters and gauges carry metric attributes', async () => {
  const captures: Capture[] = [];
  const c = new KlauroClient({ projectId: 'p', flushInterval: 0, fetchImpl: makeFetch(captures) });
  c.incrementCounter('orders', 2);
  c.recordGauge('queue_depth', 17);
  await c.flush();
  const [counter, gauge] = captures[0].body.events;
  assert.equal(counter.attributes?.metric_type, 'counter');
  assert.equal(counter.attributes?.metric_value, 2);
  assert.equal(gauge.attributes?.metric_type, 'gauge');
  assert.equal(gauge.attributes?.metric_value, 17);
});

test('bounds the queue at maxQueueSize', async () => {
  const c = new KlauroClient({ projectId: 'p', flushInterval: 0, batchSize: 1_000_000, maxQueueSize: 5 });
  for (let i = 0; i < 20; i += 1) c.record(`e${i}`);
  assert.equal(c.pending, 5);
});

test('flush is a no-op with an empty queue', async () => {
  const captures: Capture[] = [];
  const c = new KlauroClient({ projectId: 'p', flushInterval: 0, fetchImpl: makeFetch(captures) });
  await c.flush();
  assert.equal(captures.length, 0);
});

test('many clients share one lifecycle hook and never intercept process signals', async () => {
  const beforeExitCount = process.listenerCount('beforeExit');
  const sigintCount = process.listenerCount('SIGINT');
  const sigtermCount = process.listenerCount('SIGTERM');
  const clients = Array.from({ length: 25 }, () => new KlauroClient({ projectId: 'p', flushInterval: 0 }));
  assert.ok(process.listenerCount('beforeExit') <= beforeExitCount + 1);
  assert.equal(process.listenerCount('SIGINT'), sigintCount);
  assert.equal(process.listenerCount('SIGTERM'), sigtermCount);
  await Promise.all(clients.map((client) => client.shutdown()));
});

test('concurrent flush requests serialize delivery', async () => {
  let activeDeliveries = 0;
  let maximumConcurrentDeliveries = 0;
  const fetchImpl = (async () => {
    activeDeliveries += 1;
    maximumConcurrentDeliveries = Math.max(maximumConcurrentDeliveries, activeDeliveries);
    await new Promise((resolve) => setImmediate(resolve));
    activeDeliveries -= 1;
    return { ok: true, status: 200 } as Response;
  }) as typeof fetch;
  const client = new KlauroClient({ projectId: 'p', flushInterval: 0, fetchImpl });
  client.record('first');
  const first = client.flush();
  client.record('second');
  const second = client.flush();
  await Promise.all([first, second]);
  assert.equal(maximumConcurrentDeliveries, 1);
  assert.equal(client.pending, 0);
  await client.shutdown();
});

test('chunks large queues and preserves stable event ids across retries', async () => {
  const captures: Capture[] = [];
  let attempt = 0;
  const fetchImpl = (async (url: any, init: any) => {
    const body = JSON.parse(init.body) as { events: CasRuntimeEvent[] };
    captures.push({ url: String(url), body });
    attempt += 1;
    if (attempt === 1) throw new Error('ambiguous network failure');
    return {
      ok: true,
      status: 200,
      json: async () => ({ event_count: body.events.length }),
    } as unknown as Response;
  }) as typeof fetch;
  const client = new KlauroClient({
    projectId: 'p',
    flushInterval: 0,
    batchSize: 10_000,
    retryAttempts: 2,
    retryBaseDelay: 0,
    fetchImpl,
  });
  for (let i = 0; i < 1_205; i += 1) client.record(`event-${i}`);
  await client.flush();
  assert.deepEqual(captures.map(item => item.body.events.length), [1000, 1000, 205]);
  assert.deepEqual(
    captures[0].body.events.map(event => event.event_id),
    captures[1].body.events.map(event => event.event_id),
  );
  assert.equal(new Set(captures.flatMap(item => item.body.events.map(event => event.event_id))).size, 1_205);
  assert.equal(client.pending, 0);
});

test('requeues a chunk when the server acknowledges a partial batch', async () => {
  const errors: unknown[] = [];
  const client = new KlauroClient({
    projectId: 'p',
    flushInterval: 0,
    retryAttempts: 1,
    onError: error => errors.push(error),
    fetchImpl: (async (_url: any, init: any) => ({
      ok: true,
      status: 200,
      json: async () => ({ event_count: JSON.parse(init.body).events.length - 1 }),
    })) as typeof fetch,
  });
  client.record('one');
  client.record('two');
  await client.flush();
  assert.equal(client.pending, 2);
  assert.match(String(errors[0]), /acknowledged 1\/2/);
});
