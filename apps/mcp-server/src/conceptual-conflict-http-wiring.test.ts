import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';

import { createRemoteAnalyzerHttpServer } from './remote-analyzer-service';

/**
 * HTTP mirror of the MCP check_conceptual_conflicts tool: POST
 * /v1/coordination/conceptual-conflicts twice (agent B's caller edit, then
 * agent A's nullability retype) against a workspace with no real CAS
 * (getAnalysis throws -> empty ConflictCas), so this only exercises
 * duplicate-work-shaped detection paths that don't need CAS call edges.
 * Confirms the route is wired, persists reports, and returns conflicts.
 */
test('POST /v1/coordination/conceptual-conflicts persists reports and returns conflicts to later callers', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-conceptual-http-'));
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

  function post(body: unknown): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/v1/coordination/conceptual-conflicts',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
        },
        (res) => {
          let raw = '';
          res.on('data', (chunk) => (raw += chunk));
          res.on('end', () => resolve({ status: res.statusCode || 0, json: JSON.parse(raw) }));
        }
      );
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  try {
    const workspace = 'conceptual-http-smoke-workspace';

    const first = await post({
      workspace,
      agent_id: 'agent-a',
      agent_kind: 'claude',
      intent: 'add retry logic with backoff to billingHandler',
      changes: [{ symbol_id: 'sym:retryBilling', name: 'retryBilling', file: 'src/billing.ts', change_kind: 'add' }],
    });
    assert.equal(first.status, 200);
    assert.equal(first.json.status, 'reported');
    assert.equal(first.json.other_agents_considered, 0);
    assert.equal(first.json.conflicts.length, 0);

    const second = await post({
      workspace,
      agent_id: 'agent-b',
      agent_kind: 'claude',
      intent: 'add retry with exponential backoff to billingHandler for reliability',
      changes: [{ symbol_id: 'sym:retryBilling', name: 'retryBilling', file: 'src/billing-v2.ts', change_kind: 'add' }],
    });
    assert.equal(second.status, 200);
    assert.equal(second.json.other_agents_considered, 1, 'agent-b should see agent-a\'s prior report');
    assert.equal(second.json.conflicts.length, 1);
    assert.equal(second.json.conflicts[0].kind, 'duplicate-work');
    assert.deepEqual([...second.json.conflicts[0].agents].sort(), ['agent-a', 'agent-b']);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousRemoteData === undefined) delete process.env.KLAURO_REMOTE_ANALYZER_DATA;
    else process.env.KLAURO_REMOTE_ANALYZER_DATA = previousRemoteData;
    if (previousCoordDir === undefined) delete process.env.KLAURO_COORD_DIR;
    else process.env.KLAURO_COORD_DIR = previousCoordDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
