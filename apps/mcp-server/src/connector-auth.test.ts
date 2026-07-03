import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeServerUrl } from './connector-auth';
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
