import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';

import { createRemoteAnalyzerHttpServer } from './remote-analyzer-service';

/**
 * §WS-C-transport smoke test — connects to the in-process analyzer server's
 * `GET /v1/coordination/stream`, POSTs a claim to the same workspace, and
 * asserts the claim delta arrives over the open SSE connection. Exercises the
 * broadcast wiring end to end (not just the pub/sub helper in isolation).
 */
test('GET /v1/coordination/stream pushes a claim delta after POST /v1/coordination/claim', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-coord-sse-'));
  const remoteData = path.join(root, 'remote-data');
  const previousRemoteData = process.env.KLAURO_REMOTE_ANALYZER_DATA;
  const previousCoordDir = process.env.KLAURO_COORD_DIR;
  process.env.KLAURO_REMOTE_ANALYZER_DATA = remoteData;
  process.env.KLAURO_COORD_DIR = path.join(root, 'coord');

  const server = createRemoteAnalyzerHttpServer({ dataDir: remoteData });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = (address as { port: number }).port;

  try {
    const workspace = 'sse-smoke-workspace';
    const events: Array<{ event: string; data: any }> = [];

    // Open the SSE stream and start reading it in the background.
    const streamReq = http.get(
      { host: '127.0.0.1', port, path: `/v1/coordination/stream?workspace=${encodeURIComponent(workspace)}` },
      (res) => {
        res.setEncoding('utf8');
        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk;
          const parts = buffer.split('\n\n');
          buffer = parts.pop() ?? '';
          for (const part of parts) {
            const lines = part.split('\n');
            const eventLine = lines.find((l) => l.startsWith('event: '));
            const dataLine = lines.find((l) => l.startsWith('data: '));
            if (eventLine && dataLine) {
              events.push({
                event: eventLine.slice('event: '.length),
                data: JSON.parse(dataLine.slice('data: '.length)),
              });
            }
          }
        });
      }
    );

    // Wait for the initial `state` event so we know the subscriber is registered
    // before posting the claim (otherwise the broadcast could race the connect).
    const deadlineA = Date.now() + 5000;
    while (!events.some((e) => e.event === 'state') && Date.now() < deadlineA) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(events.some((e) => e.event === 'state'), 'should receive an initial state event');

    const claimBody = JSON.stringify({
      workspace,
      agent_id: 'agent-sse-test',
      agent_kind: 'claude',
      intent: 'sse smoke test claim',
      paths: ['src/smoke.ts'],
    });
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/v1/coordination/claim', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(claimBody) } },
        (res) => {
          res.on('data', () => {});
          res.on('end', resolve);
        }
      );
      req.on('error', reject);
      req.end(claimBody);
    });

    const deadlineB = Date.now() + 5000;
    while (!events.some((e) => e.event === 'claim') && Date.now() < deadlineB) {
      await new Promise((r) => setTimeout(r, 20));
    }

    const claimEvent = events.find((e) => e.event === 'claim');
    assert.ok(claimEvent, 'should receive a claim delta over the open SSE stream');
    assert.equal(claimEvent!.data.agent_id, 'agent-sse-test');
    assert.equal(claimEvent!.data.verdict, 'granted');

    const inFlightBody = JSON.stringify({
      workspace,
      agent_id: 'agent-sse-test',
      base_commit: 'base',
      diff_context: '{}',
      attribution_source: 'participant-worktree',
      changes: [{
        symbol_id: 'sym:shared',
        name: 'shared',
        file: 'src/smoke.ts',
        change_kind: 'body',
      }],
    });
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/v1/coordination/in-flight', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(inFlightBody) } },
        (res) => {
          res.on('data', () => {});
          res.on('end', resolve);
        }
      );
      req.on('error', reject);
      req.end(inFlightBody);
    });

    const deadlineC = Date.now() + 5000;
    while (!events.some((event) => event.event === 'in-flight') && Date.now() < deadlineC) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const inFlightEvent = events.find((event) => event.event === 'in-flight');
    assert.equal(inFlightEvent?.data.attribution_source, 'participant-worktree');
    assert.equal(inFlightEvent?.data.changes[0].symbol_id, 'sym:shared');

    streamReq.destroy();
  } finally {
    server.close();
    if (previousRemoteData === undefined) delete process.env.KLAURO_REMOTE_ANALYZER_DATA;
    else process.env.KLAURO_REMOTE_ANALYZER_DATA = previousRemoteData;
    if (previousCoordDir === undefined) delete process.env.KLAURO_COORD_DIR;
    else process.env.KLAURO_COORD_DIR = previousCoordDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
