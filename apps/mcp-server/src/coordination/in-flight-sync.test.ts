import test from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { InFlightPublishError, publishInFlight, startInFlightWatcher } from './in-flight-sync';
import type { InFlightDiffFile } from './security';

async function freshProjectDir(withIgnore?: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'klauro-inflight-test-'));
  if (withIgnore !== undefined) {
    await fsp.writeFile(path.join(dir, '.klauroignore'), withIgnore, 'utf8');
  }
  return dir;
}

/** A tiny throwaway HTTP server standing in for POST /v1/coordination/in-flight. */
async function startThrowawayServer(
  handler: (req: http.IncomingMessage, body: any) => { status: number; body: unknown }
): Promise<{ baseUrl: string; close: () => Promise<void>; requests: Array<{ url: string; rawBody: string; body: any }> }> {
  const requests: Array<{ url: string; rawBody: string; body: any }> = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const body = rawBody ? JSON.parse(rawBody) : undefined;
    requests.push({ url: req.url || '', rawBody, body });
    const result = handler(req, body);
    res.writeHead(result.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    requests,
  };
}

test('publishInFlight POSTs the redacted diff to /v1/coordination/in-flight', async () => {
  const projectDir = await freshProjectDir();
  const server = await startThrowawayServer((req, body) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/coordination/in-flight');
    assert.equal(body.workspace, 'ws-test');
    assert.equal(body.agent_id, 'agent-a');
    return { status: 200, body: { status: 'success' } };
  });

  const files: InFlightDiffFile[] = [{ path: 'src/foo.ts', patch: '+ added a line', content: 'full file body' }];
  const result = await publishInFlight(server.baseUrl, 'tok', 'ws-test', 'agent-a', projectDir, files);

  assert.equal(result.status, 'success');
  assert.equal(result.kept_files, 1);
  assert.equal(result.dropped_files, 0);
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].body.workspace, 'ws-test');

  await server.close();
  await fsp.rm(projectDir, { recursive: true, force: true });
});

test('publishInFlight drops a .env file via redaction — the secret content never appears in the request body', async () => {
  const projectDir = await freshProjectDir();
  const server = await startThrowawayServer(() => ({ status: 200, body: { status: 'success' } }));

  const secretValue = 'SUPER_SECRET_DB_PASSWORD=hunter2-do-not-leak';
  const files: InFlightDiffFile[] = [
    { path: '.env', content: secretValue, patch: `+ ${secretValue}` },
    { path: 'src/safe.ts', content: 'export const x = 1;' },
  ];

  const result = await publishInFlight(server.baseUrl, undefined, 'ws-test', 'agent-a', projectDir, files);

  assert.equal(result.kept_files, 1);
  assert.equal(result.dropped_files, 1);

  // Assert the secret literally never appears anywhere in what was sent over the wire.
  const rawBodySent = server.requests[0].rawBody;
  assert.ok(!rawBodySent.includes(secretValue), 'secret value must not appear in the raw HTTP request body');
  assert.ok(!rawBodySent.includes('.env'), '.env path should not even be named in the published payload');
  assert.ok(rawBodySent.includes('src/safe.ts'), 'the non-secret file should still be published');

  await server.close();
  await fsp.rm(projectDir, { recursive: true, force: true });
});

test('publishInFlight also drops files matched by a project .klauroignore glob', async () => {
  const projectDir = await freshProjectDir('build/**\n*.local.json\n');
  const server = await startThrowawayServer(() => ({ status: 200, body: { status: 'success' } }));

  const files: InFlightDiffFile[] = [
    { path: 'build/output.js', content: 'generated' },
    { path: 'config.local.json', content: '{"token":"abc"}' },
    { path: 'src/keep.ts', content: 'kept' },
  ];

  const result = await publishInFlight(server.baseUrl, undefined, 'ws-test', 'agent-a', projectDir, files);
  assert.equal(result.kept_files, 1);
  assert.equal(result.dropped_files, 2);

  const rawBodySent = server.requests[0].rawBody;
  assert.ok(!rawBodySent.includes('generated'));
  assert.ok(!rawBodySent.includes('"token":"abc"'));
  assert.ok(rawBodySent.includes('src/keep.ts'));

  await server.close();
  await fsp.rm(projectDir, { recursive: true, force: true });
});

test('publishInFlight in diffOnly mode strips full file content, keeping only patch text', async () => {
  const projectDir = await freshProjectDir();
  const server = await startThrowawayServer(() => ({ status: 200, body: { status: 'success' } }));

  const files: InFlightDiffFile[] = [{ path: 'src/foo.ts', patch: '+ added a line', content: 'FULL FILE BODY SHOULD NOT LEAVE' }];
  await publishInFlight(server.baseUrl, undefined, 'ws-test', 'agent-a', projectDir, files, { diffOnly: true });

  const rawBodySent = server.requests[0].rawBody;
  assert.ok(!rawBodySent.includes('FULL FILE BODY SHOULD NOT LEAVE'), 'diffOnly must strip full file content');
  assert.ok(rawBodySent.includes('added a line'), 'patch text should still be present');

  await server.close();
  await fsp.rm(projectDir, { recursive: true, force: true });
});

test('publishInFlight throws InFlightPublishError on non-2xx response', async () => {
  const projectDir = await freshProjectDir();
  const server = await startThrowawayServer(() => ({ status: 500, body: { error: 'boom' } }));

  await assert.rejects(
    () => publishInFlight(server.baseUrl, undefined, 'ws-test', 'agent-a', projectDir, [{ path: 'a.ts', content: 'x' }]),
    InFlightPublishError
  );

  await server.close();
  await fsp.rm(projectDir, { recursive: true, force: true });
});

test('publishInFlight throws InFlightPublishError on network failure', async () => {
  const projectDir = await freshProjectDir();
  await assert.rejects(
    () => publishInFlight('http://127.0.0.1:1', undefined, 'ws-test', 'agent-a', projectDir, [{ path: 'a.ts', content: 'x' }]),
    InFlightPublishError
  );
  await fsp.rm(projectDir, { recursive: true, force: true });
});

test('startInFlightWatcher debounces filesystem changes into a single publish call', async () => {
  const projectDir = await freshProjectDir();
  const server = await startThrowawayServer(() => ({ status: 200, body: { status: 'success' } }));

  let buildDiffCalls = 0;
  const published: unknown[] = [];
  const { stop } = startInFlightWatcher(
    projectDir,
    server.baseUrl,
    undefined,
    'ws-test',
    'agent-a',
    () => {
      buildDiffCalls += 1;
      return [{ path: 'src/foo.ts', content: 'v' + buildDiffCalls }];
    },
    { debounceMs: 100, onPublished: (r) => published.push(r) }
  );

  try {
    // Burst of writes should coalesce into one publish after the debounce window.
    await fsp.writeFile(path.join(projectDir, 'a.txt'), '1');
    await new Promise((r) => setTimeout(r, 20));
    await fsp.writeFile(path.join(projectDir, 'a.txt'), '2');
    await new Promise((r) => setTimeout(r, 20));
    await fsp.writeFile(path.join(projectDir, 'a.txt'), '3');

    await new Promise((r) => setTimeout(r, 400));

    assert.equal(published.length, 1, 'a burst of changes within the debounce window should yield exactly one publish');
    assert.equal(server.requests.length, 1);
  } finally {
    stop();
    await server.close();
    await fsp.rm(projectDir, { recursive: true, force: true });
  }
});
