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
