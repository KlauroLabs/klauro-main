import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRemoteAnalyzerHttpServer } from './remote-analyzer-service';

async function withServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-device-auth-'));
  const previousCoordination = process.env.KLAURO_COORD_DIR;
  process.env.KLAURO_COORD_DIR = path.join(root, 'data', 'coordination');
  const server = createRemoteAnalyzerHttpServer({ dataDir: path.join(root, 'data') });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : 0;
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousCoordination === undefined) delete process.env.KLAURO_COORD_DIR;
    else process.env.KLAURO_COORD_DIR = previousCoordination;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function registerUser(baseUrl: string, email: string): Promise<{ token: string }> {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery staple' }),
  });
  assert.equal(response.status, 201);
  return response.json() as Promise<{ token: string }>;
}

test('the full device-code flow: issue, pending, approve, token, one-time use', async () => {
  await withServer(async (baseUrl) => {
    const { token } = await registerUser(baseUrl, 'device-flow@example.com');

    const codeResponse = await fetch(`${baseUrl}/api/auth/device/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: 'agent-desktop' }),
    });
    assert.equal(codeResponse.status, 200);
    const issued = await codeResponse.json() as { device_code: string; user_code: string; verification_uri: string; verification_uri_complete: string; expires_in: number; interval: number };
    assert.match(issued.user_code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.ok(issued.verification_uri_complete.includes(issued.user_code));

    // Approve before the first poll: a poll immediately beforehand would set
    // the per-device interval clock and make the poll below a spurious
    // slow_down — see device-auth.test.ts for dedicated pending/slow_down coverage.
    const approveResponse = await fetch(`${baseUrl}/api/auth/device/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ user_code: issued.user_code }),
    });
    assert.equal(approveResponse.status, 200);

    const tokenResponse = await fetch(`${baseUrl}/api/auth/device/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_code: issued.device_code, client_id: 'agent-desktop' }),
    });
    assert.equal(tokenResponse.status, 200);
    const approved = await tokenResponse.json() as { access_token: string; email: string; server_url: string };
    assert.equal(approved.email, 'device-flow@example.com');
    assert.equal(approved.server_url, baseUrl);
    assert.notEqual(approved.access_token, token, 'the device gets its own fresh session, not the web session token');

    const meResponse = await fetch(`${baseUrl}/api/me`, { headers: { authorization: `Bearer ${approved.access_token}` } });
    assert.equal(meResponse.status, 200);

    const reuseResponse = await fetch(`${baseUrl}/api/auth/device/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_code: issued.device_code, client_id: 'agent-desktop' }),
    });
    assert.equal(reuseResponse.status, 400);
    assert.equal((await reuseResponse.json() as { error: string }).error, 'expired_token');
  });
});

test('polling before approval reports authorization_pending over HTTP', async () => {
  await withServer(async (baseUrl) => {
    const codeResponse = await fetch(`${baseUrl}/api/auth/device/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: 'agent-desktop' }),
    });
    const issued = await codeResponse.json() as { device_code: string };
    const response = await fetch(`${baseUrl}/api/auth/device/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_code: issued.device_code, client_id: 'agent-desktop' }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { error: string }).error, 'authorization_pending');
  });
});

test('denying a device code makes the next poll report access_denied', async () => {
  await withServer(async (baseUrl) => {
    const { token } = await registerUser(baseUrl, 'device-deny@example.com');
    const codeResponse = await fetch(`${baseUrl}/api/auth/device/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: 'agent-desktop' }),
    });
    const issued = await codeResponse.json() as { device_code: string; user_code: string };

    const denyResponse = await fetch(`${baseUrl}/api/auth/device/deny`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ user_code: issued.user_code }),
    });
    assert.equal(denyResponse.status, 200);

    const pollResponse = await fetch(`${baseUrl}/api/auth/device/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_code: issued.device_code, client_id: 'agent-desktop' }),
    });
    assert.equal(pollResponse.status, 400);
    assert.equal((await pollResponse.json() as { error: string }).error, 'access_denied');
  });
});

test('approving an unauthenticated request is rejected', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/device/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_code: 'AAAA-BBBB' }),
    });
    assert.equal(response.status, 401);
  });
});

test('approving an unknown or already-used code returns 404', async () => {
  await withServer(async (baseUrl) => {
    const { token } = await registerUser(baseUrl, 'device-unknown@example.com');
    const response = await fetch(`${baseUrl}/api/auth/device/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ user_code: 'ZZZZ-ZZZZ' }),
    });
    assert.equal(response.status, 404);
  });
});

test('polling with the wrong client_id never reveals the code is valid', async () => {
  await withServer(async (baseUrl) => {
    const codeResponse = await fetch(`${baseUrl}/api/auth/device/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: 'agent-desktop' }),
    });
    const issued = await codeResponse.json() as { device_code: string };
    const response = await fetch(`${baseUrl}/api/auth/device/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_code: issued.device_code, client_id: 'someone-elses-client' }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { error: string }).error, 'expired_token');
  });
});
