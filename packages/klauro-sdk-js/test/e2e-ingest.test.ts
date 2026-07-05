import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { KlauroClient } from '../src/client';
import type { CasRuntimeEvent } from '../src/types';

/**
 * Stands up a real HTTP server that implements the exact CAS ingest contract:
 *   POST /api/telemetry/runtime-events/:projectId
 *   body: { events: CasRuntimeEvent[] }
 * and asserts events round-trip end to end over the wire.
 */
test('events round-trip over the wire to a contract-shaped ingest endpoint', async () => {
  const received: { projectId: string; events: CasRuntimeEvent[]; auth?: string }[] = [];

  const server = http.createServer((req, res) => {
    const match = /^\/api\/telemetry\/runtime-events\/(.+)$/.exec(req.url || '');
    if (req.method !== 'POST' || !match) {
      res.statusCode = 404;
      res.end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const parsed = JSON.parse(body) as { events: CasRuntimeEvent[] };
      received.push({
        projectId: decodeURIComponent(match[1]),
        events: parsed.events,
        auth: req.headers.authorization,
      });
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ matched: parsed.events.length, unmatched: 0 }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const client = new KlauroClient({
      projectId: 'proof-of-concept',
      apiKey: 'test-key',
      endpoint: `http://127.0.0.1:${port}`,
      service: 'items-api',
      environment: 'e2e',
      flushInterval: 0,
    });

    // Emit a representative mix: a request, an error, and a span exit.
    client.recordEvent({
      type: 'request',
      signal: 'registerTool analyze_codebase',
      entry_point_id: 'entry_mcp_tool_analyze_codebase_src_server_ts_891',
      method: 'registerTool',
      route: 'analyze_codebase',
      status_code: 200,
      duration_ms: 12,
    });
    client.captureError(new Error('downstream timeout'), { route: '/items/:id' });
    const span = client.startSpan('db.query', { node_id: 'n42' });
    span.end();

    await client.flush();

    assert.equal(received.length, 1, 'one batch delivered');
    assert.equal(received[0].projectId, 'proof-of-concept');
    assert.equal(received[0].auth, 'Bearer test-key');
    assert.equal(received[0].events.length, 3);

    const byType = Object.fromEntries(received[0].events.map((e) => [e.type, e]));
    assert.ok(byType.request);
    assert.equal(byType.request.entry_point_id, 'entry_mcp_tool_analyze_codebase_src_server_ts_891');
    assert.equal(byType.request.schema_version, '1.0.0');
    assert.equal(byType.request.service_name, 'items-api');
    assert.equal(byType.error.error_message, 'downstream timeout');
    assert.equal(byType.exit.node_id, 'n42');
    assert.equal(client.pending, 0, 'queue drained after successful delivery');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
