import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import {
  createKlauroExpressTelemetry,
  type KlauroTelemetryEvent,
} from '../../../packages/analyzer-core/src/sdk/javascript/klauro-express-middleware';

class MockResponse extends EventEmitter {
  statusCode = 200;
}

function mockRequest(method: string, routePath: string, requestPath: string) {
  return { method, path: requestPath, baseUrl: '', route: { path: routePath } } as {
    method: string;
    path: string;
    baseUrl: string;
    route?: { path?: string };
    klauroError?: Error;
  };
}

async function withTelemetryFile(run: (filePath: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-express-sdk-'));
  try {
    await run(path.join(dir, 'telemetry.ndjson'));
  } finally {
    await fs.remove(dir);
  }
}

async function readEvents(filePath: string): Promise<KlauroTelemetryEvent[]> {
  if (!(await fs.pathExists(filePath))) return [];
  const content = await fs.readFile(filePath, 'utf8');
  return content.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function simulateRequest(
  telemetry: ReturnType<typeof createKlauroExpressTelemetry>,
  options: { method?: string; route?: string; path?: string; status?: number; error?: Error } = {},
): void {
  const req = mockRequest(options.method || 'GET', options.route || '/items', options.path || '/items');
  const res = new MockResponse();
  res.statusCode = options.status ?? 200;
  telemetry.requestHandler(req, res as never, () => undefined);
  if (options.error) {
    telemetry.errorHandler(options.error, req, res as never, () => undefined);
  }
  res.emit('finish');
}

test('express middleware captures route pattern, status, and duration', async () => {
  await withTelemetryFile(async filePath => {
    const telemetry = createKlauroExpressTelemetry({
      filePath,
      serviceName: 'items-api',
      environment: 'test',
    });
    simulateRequest(telemetry, { method: 'GET', route: '/items/:id', path: '/items/42', status: 200 });
    telemetry.shutdown();

    const events = await readEvents(filePath);
    assert.equal(events.length, 1);
    const event = events[0];
    assert.equal(event.kind, 'request');
    assert.equal(event.method, 'GET');
    assert.equal(event.route, '/items/:id');
    assert.equal(event.path, '/items/42');
    assert.equal(event.status, 200);
    assert.equal(event.service_name, 'items-api');
    assert.equal(event.environment, 'test');
    assert.equal(typeof event.duration_ms, 'number');
    assert.ok(event.duration_ms >= 0);
    assert.ok(!Number.isNaN(new Date(event.timestamp).getTime()));
    assert.equal(event.error, undefined);
  });
});

test('express middleware records handler errors with type, message, and top stack frames', async () => {
  await withTelemetryFile(async filePath => {
    const telemetry = createKlauroExpressTelemetry({ filePath });
    const error = new TypeError('items collection is not iterable');
    simulateRequest(telemetry, { method: 'POST', route: '/items', path: '/items', status: 500, error });
    telemetry.shutdown();

    const events = await readEvents(filePath);
    assert.equal(events.length, 1);
    const event = events[0];
    assert.equal(event.kind, 'error');
    assert.equal(event.status, 500);
    assert.ok(event.error);
    assert.equal(event.error.type, 'TypeError');
    assert.equal(event.error.message, 'items collection is not iterable');
    assert.ok(event.error.stack_top_frames.length >= 1);
    assert.ok(event.error.stack_top_frames.length <= 5);
    assert.match(event.error.stack_top_frames[0], /at .*express-middleware-sdk\.test\.ts:\d+/);
  });
});

test('express middleware marks 5xx responses as errors without a thrown error', async () => {
  await withTelemetryFile(async filePath => {
    const telemetry = createKlauroExpressTelemetry({ filePath });
    simulateRequest(telemetry, { status: 503 });
    telemetry.shutdown();

    const events = await readEvents(filePath);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'error');
    assert.equal(events[0].error, undefined);
  });
});

test('express middleware batches events and flushes at the batch size', async () => {
  await withTelemetryFile(async filePath => {
    const telemetry = createKlauroExpressTelemetry({ filePath, batchSize: 20, flushIntervalMs: 60_000 });
    for (let index = 0; index < 19; index += 1) {
      simulateRequest(telemetry, { route: '/items', path: '/items' });
    }
    assert.equal((await readEvents(filePath)).length, 0, 'buffer below batch size must not flush');

    simulateRequest(telemetry, { route: '/items', path: '/items' });
    assert.equal((await readEvents(filePath)).length, 20, 'reaching batch size must flush the batch');

    simulateRequest(telemetry, { route: '/items', path: '/items' });
    assert.equal((await readEvents(filePath)).length, 20, 'next event starts a new buffer');
    telemetry.shutdown();
    assert.equal((await readEvents(filePath)).length, 21, 'shutdown flushes remaining events');
  });
});

test('express middleware uses raw path without a matched route', async () => {
  await withTelemetryFile(async filePath => {
    const telemetry = createKlauroExpressTelemetry({ filePath });
    const req = { method: 'GET', path: '/missing', baseUrl: '' } as {
      method: string;
      path: string;
      baseUrl: string;
      route?: { path?: string };
    };
    const res = new MockResponse();
    res.statusCode = 404;
    telemetry.requestHandler(req, res as never, () => undefined);
    res.emit('finish');
    telemetry.shutdown();

    const events = await readEvents(filePath);
    assert.equal(events.length, 1);
    assert.equal(events[0].route, undefined);
    assert.equal(events[0].path, '/missing');
    assert.equal(events[0].kind, 'request');
  });
});
