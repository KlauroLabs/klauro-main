import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  normalizeServerUrl,
  resolveAuthStatus,
  saveStoredConnectorSession,
  warnIfSessionExpiringSoon,
  resetSessionWarningStateForTests,
  SESSION_TOKEN_TTL_DAYS,
  TOKEN_EXPIRY_WARN_DAYS,
} from './connector-auth';
import { DEFAULT_KLAURO_CLOUD_URL } from './defaults';

/**
 * normalizeServerUrl's env-var precedence. KLAURO_URL is what the install
 * script + docs tell users to set as the server override, but the function
 * historically only read KLAURO_API_URL / KLAURO_ANALYZER_URL — silently
 * ignoring KLAURO_URL. This asserts KLAURO_URL is honored as a fallback,
 * without disturbing the existing explicit-arg > KLAURO_API_URL >
 * KLAURO_ANALYZER_URL precedence.
 */
test('normalizeServerUrl env precedence, including KLAURO_URL', async (t) => {
  const keys = ['KLAURO_API_URL', 'KLAURO_ANALYZER_URL', 'KLAURO_URL'] as const;
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  t.after(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  for (const k of keys) delete process.env[k];

  await t.test('falls back to DEFAULT_KLAURO_CLOUD_URL when nothing is set', () => {
    assert.equal(normalizeServerUrl(), DEFAULT_KLAURO_CLOUD_URL.replace(/\/+$/, ''));
  });

  await t.test('honors KLAURO_URL when set (new fallback)', () => {
    process.env.KLAURO_URL = 'https://from-klauro-url.example.com/';
    assert.equal(normalizeServerUrl(), 'https://from-klauro-url.example.com');
    delete process.env.KLAURO_URL;
  });

  await t.test('KLAURO_API_URL still takes precedence over KLAURO_URL', () => {
    process.env.KLAURO_API_URL = 'https://from-api-url.example.com';
    process.env.KLAURO_URL = 'https://from-klauro-url.example.com';
    assert.equal(normalizeServerUrl(), 'https://from-api-url.example.com');
    delete process.env.KLAURO_API_URL;
    delete process.env.KLAURO_URL;
  });

  await t.test('KLAURO_ANALYZER_URL still takes precedence over KLAURO_URL', () => {
    process.env.KLAURO_ANALYZER_URL = 'https://from-analyzer-url.example.com';
    process.env.KLAURO_URL = 'https://from-klauro-url.example.com';
    assert.equal(normalizeServerUrl(), 'https://from-analyzer-url.example.com');
    delete process.env.KLAURO_ANALYZER_URL;
    delete process.env.KLAURO_URL;
  });

  await t.test('explicit argument still takes precedence over all env vars', () => {
    process.env.KLAURO_URL = 'https://from-klauro-url.example.com';
    assert.equal(normalizeServerUrl('https://explicit.example.com'), 'https://explicit.example.com');
    delete process.env.KLAURO_URL;
  });
});

/**
 * Regression guard for the "auth-status / whoami lie" defect: both commands
 * used to answer purely from whether a token FILE existed, never round-
 * tripping to the server — so a stale/expired/dropped token reported
 * "signed_in: true" right up until (and past) the moment every real API call
 * 401'd. resolveAuthStatus is the fix: it must distinguish no-token,
 * signed-in, rejected (a token exists but the server 401s it), and
 * unreachable (offline — report the local token's presence/age, don't
 * guess), and it must never hang past its timeout.
 */
function withIsolatedAuthFile<T>(fn: (authFile: string) => Promise<T> | T): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-auth-test-'));
  const authFile = path.join(dir, 'auth.json');
  const saved = process.env.KLAURO_AUTH_CONFIG_PATH;
  process.env.KLAURO_AUTH_CONFIG_PATH = authFile;
  return Promise.resolve()
    .then(() => fn(authFile))
    .finally(() => {
      if (saved === undefined) delete process.env.KLAURO_AUTH_CONFIG_PATH;
      else process.env.KLAURO_AUTH_CONFIG_PATH = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    });
}

function fakeResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

test('resolveAuthStatus: no-token when nothing is stored for the server', async () => {
  await withIsolatedAuthFile(async () => {
    const result = await resolveAuthStatus({ serverUrl: 'https://example.test', fetchImpl: async () => { throw new Error('must not fetch with no stored token'); } });
    assert.equal(result.state, 'no-token');
    assert.match(result.detail, /klauro login/);
  });
});

test('resolveAuthStatus: signed-in reports days remaining from a server 200', async () => {
  await withIsolatedAuthFile(async () => {
    const serverUrl = 'https://example.test';
    saveStoredConnectorSession({ serverUrl, token: 'fake-token-not-a-real-credential', email: 'dev@example.test' });
    const result = await resolveAuthStatus({
      serverUrl,
      fetchImpl: async () => fakeResponse(200, { user: { email: 'dev@example.test' } }),
    });
    assert.equal(result.state, 'signed-in');
    assert.equal(result.email, 'dev@example.test');
    assert.ok(typeof result.days_remaining === 'number' && result.days_remaining > SESSION_TOKEN_TTL_DAYS - 1);
    assert.match(result.detail, /Signed in to https:\/\/example\.test as dev@example\.test/);
  });
});

test('resolveAuthStatus: rejected when the server 401s a stored token (the exact "lied" case)', async () => {
  await withIsolatedAuthFile(async () => {
    const serverUrl = 'https://example.test';
    saveStoredConnectorSession({ serverUrl, token: 'fake-token-not-a-real-credential', email: 'dev@example.test' });
    const result = await resolveAuthStatus({
      serverUrl,
      fetchImpl: async () => fakeResponse(401, { error: 'Session expired' }),
    });
    assert.equal(result.state, 'rejected');
    assert.notEqual(result.state, 'signed-in' as any); // never report signed-in for a 401
    assert.match(result.detail, /Session expired/);
  });
});

test('resolveAuthStatus: unreachable when the network call throws — reports local token age, does not guess signed-in or rejected', async () => {
  await withIsolatedAuthFile(async () => {
    const serverUrl = 'https://example.test';
    saveStoredConnectorSession({ serverUrl, token: 'fake-token-not-a-real-credential', email: 'dev@example.test' });
    const result = await resolveAuthStatus({
      serverUrl,
      fetchImpl: async () => { throw new Error('fetch failed'); },
    });
    assert.equal(result.state, 'unreachable');
    assert.equal(result.email, 'dev@example.test');
    assert.match(result.detail, /Cannot reach/);
    assert.match(result.detail, /last refreshed/);
  });
});

test('warnIfSessionExpiringSoon: silent when the session is fresh', () => {
  resetSessionWarningStateForTests();
  const writes: string[] = [];
  const stderr = { write: (chunk: string) => { writes.push(chunk); return true; } };
  const now = new Date('2026-08-08T00:00:00Z');
  warnIfSessionExpiringSoon('https://example.test', { token: 't', email: 'a@b.com', updated_at: now.toISOString() }, now, stderr);
  assert.deepEqual(writes, []);
});

test('warnIfSessionExpiringSoon: warns once the session is within TOKEN_EXPIRY_WARN_DAYS of the TTL', () => {
  resetSessionWarningStateForTests();
  const writes: string[] = [];
  const stderr = { write: (chunk: string) => { writes.push(chunk); return true; } };
  const now = new Date('2026-08-08T00:00:00Z');
  const updatedAt = new Date(now.getTime() - (TOKEN_EXPIRY_WARN_DAYS + 0.5) * 24 * 60 * 60 * 1000).toISOString();
  warnIfSessionExpiringSoon('https://example.test', { token: 't', email: 'a@b.com', updated_at: updatedAt }, now, stderr);
  assert.equal(writes.length, 1);
  assert.match(writes[0], /session.*is.*days old/);
  assert.match(writes[0], /klauro login/);
});

test('warnIfSessionExpiringSoon: past the TTL uses "very likely expired" wording, distinct from the approaching-TTL warning', () => {
  resetSessionWarningStateForTests();
  const writes: string[] = [];
  const stderr = { write: (chunk: string) => { writes.push(chunk); return true; } };
  const now = new Date('2026-08-08T00:00:00Z');
  const updatedAt = new Date(now.getTime() - (SESSION_TOKEN_TTL_DAYS + 4) * 24 * 60 * 60 * 1000).toISOString();
  warnIfSessionExpiringSoon('https://example.test', { token: 't', email: 'a@b.com', updated_at: updatedAt }, now, stderr);
  assert.equal(writes.length, 1);
  assert.match(writes[0], /past the .* TTL/);
  assert.match(writes[0], /very likely expired/);
});

test('warnIfSessionExpiringSoon: at most once per process (the latch)', () => {
  resetSessionWarningStateForTests();
  const writes: string[] = [];
  const stderr = { write: (chunk: string) => { writes.push(chunk); return true; } };
  const now = new Date('2026-08-08T00:00:00Z');
  const updatedAt = new Date(now.getTime() - (SESSION_TOKEN_TTL_DAYS + 4) * 24 * 60 * 60 * 1000).toISOString();
  warnIfSessionExpiringSoon('https://example.test', { token: 't', email: 'a@b.com', updated_at: updatedAt }, now, stderr);
  warnIfSessionExpiringSoon('https://example.test', { token: 't', email: 'a@b.com', updated_at: updatedAt }, now, stderr);
  assert.equal(writes.length, 1, 'a second call in the same process must not repeat the warning');
});
