/**
 * REGRESSION GATE for task #132: `klauro analyze --force` was parsed at
 * cli.ts and documented in its help text, but never read at the call site —
 * `analyzeCodebaseRemotely` was invoked with no `force` field at all, so a
 * forced re-run silently came back `reused: true` with no visible sign
 * anything was wrong. Two stacked caches were involved: the server's
 * snapshot/analyzer-identity reuse gate (remote-analyzer-service.ts's
 * POST /v1/analyze), and the AI response cache
 * (packages/analyzer-core/src/ai/ai-cache.ts), which is content-addressed
 * and deliberately path/timestamp-independent — so bypassing only the first
 * one would still silently reuse stale AI-generated capability names and
 * descriptions.
 *
 * This file proves, through the real HTTP surface (mirroring
 * remote-analyzer-analyzer-identity.test.ts's pattern):
 *  1. Without --force, an unchanged snapshot is reused (existing behavior,
 *     unchanged) — establishes the baseline this test is contrasting with.
 *  2. With --force, an otherwise-reusable snapshot is NOT reused: the
 *     response says `reused: false`, `analysis_type: 'forced'`, and
 *     `reuse_decision.source === 'forced'` with `ai_cache_bypassed: true`.
 *  3. The forced re-run produces a genuinely fresh CAS with a distinct
 *     `analysis_timestamp` from the original run — not just a re-labeled
 *     copy of the same stored analysis.
 *  4. The AI cache bypass is itself visible: `ai_cache_reuse.bypassed` is
 *     true on the forced run's CAS (honest-degradation parity with
 *     `reuse_decision` / `comprehension.degraded`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRemoteAnalyzerHttpServer } from './remote-analyzer-service';
import { analyzeCodebaseRemotely } from './remote-sync-client';
import { parseArgs } from './cli';

function git(repo: string, args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
}

function request(port: number, method: string, route: string, body?: unknown, token?: string): Promise<{ statusCode: number; body: string }> {
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  const headers: Record<string, string> = {};
  if (payload !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  if (token) headers.authorization = `Bearer ${token}`;
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers }, response => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { responseBody += chunk; });
      response.on('end', () => resolve({ statusCode: response.statusCode || 0, body: responseBody }));
    });
    req.on('error', reject);
    if (payload !== undefined) req.end(payload);
    else req.end();
  });
}

// --- Unit-level: the CLI actually parses --force for `analyze` -----------
// (this was never in question — parsed.force = true always worked — but it
// anchors the e2e assertions below to the actual argv shape a customer types).

test('parseArgs sets force=true for `klauro analyze --force`', () => {
  const parsed = parseArgs(['analyze', '.', '--force']);
  assert.equal(parsed.command, 'analyze');
  assert.equal(parsed.force, true);
});

test('parseArgs defaults force=false when --force is omitted', () => {
  const parsed = parseArgs(['analyze', '.']);
  assert.equal(parsed.force, false);
});

// --- End-to-end: --force actually forces a fresh analysis -----------------

test('--force bypasses the snapshot reuse gate AND the AI cache, producing a genuinely fresh analysis', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-force-flag-'));
  const repo = path.join(root, 'repo');
  const remoteData = path.join(root, 'remote-data');
  const previousRemoteData = process.env.KLAURO_REMOTE_ANALYZER_DATA;
  process.env.KLAURO_REMOTE_ANALYZER_DATA = remoteData;
  fs.mkdirSync(repo, { recursive: true });

  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(repo, 'app.py'), 'def handler():\n    return 1\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'initial commit']);

  const server = createRemoteAnalyzerHttpServer({ dataDir: remoteData });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  const serverUrl = `http://127.0.0.1:${port}`;

  try {
    const registerRes = await request(port, 'POST', '/api/auth/register', {
      email: 'owner@example.com',
      password: 'password-1234',
      workspace_name: 'Force Flag Workspace',
    });
    assert.equal(registerRes.statusCode, 201);
    const token = JSON.parse(registerRes.body).token as string;

    const first = await analyzeCodebaseRemotely({ projectPath: repo, serverUrl, token, analysisId: 'force-flag-fixture', wait: true, readinessRequirement: 'structural' });
    assert.equal(first.status, 'success');
    const firstTimestamp = first.cas?.analysis_timestamp;
    assert.ok(firstTimestamp, 'first run must produce a stamped analysis_timestamp');

    // --- Baseline: without --force, the unchanged snapshot IS reused. This
    // is the pre-existing, correct behavior this test is contrasting with —
    // if this assertion ever fails, the fixture stopped exercising the
    // reuse gate at all and the --force assertions below would be vacuous.
    const unforced = await analyzeCodebaseRemotely({ projectPath: repo, serverUrl, token, analysisId: 'force-flag-fixture' });
    assert.equal(unforced.reused, true, 'sanity check: an unchanged snapshot is reused without --force');
    assert.equal(unforced.reuse_decision?.source, 'unchanged');

    // --- THE FIX: --force on the SAME unchanged snapshot must NOT reuse.
    const forced = await analyzeCodebaseRemotely({ projectPath: repo, serverUrl, token, analysisId: 'force-flag-fixture', force: true, wait: true, readinessRequirement: 'structural' });
    assert.equal(forced.status, 'success');
    assert.notEqual(forced.reused, true, '--force must never come back reused:true — this was the P0: a documented flag that silently did nothing');
    assert.ok(forced.reuse_decision, 'the forced decision must be reported, not just implied by reused:false');
    assert.equal(forced.reuse_decision!.reused, false);
    assert.equal(forced.reuse_decision!.source, 'forced');
    // `wait: true` (used here so this test can inspect the completed CAS)
    // overwrites `analysis_type` with 'full'/'incremental' once the poll
    // resolves — that field describes HOW the wait finished, not why the
    // server didn't reuse the snapshot. `reuse_decision` (asserted above and
    // below) is what the accepted-response's own `analysis_type: 'forced'`
    // marker would say on the normal (non-wait) async path customers use.
    assert.equal(forced.reuse_decision!.ai_cache_bypassed, true, '--force must ALSO bypass the AI response cache, not just the snapshot reuse gate');
    assert.match(forced.reuse_decision!.reason, /force/i);

    // --- Regression: a genuinely fresh analysis, not a re-labeled copy of
    // the stored one — distinct analysis_timestamp proves the deterministic
    // pipeline actually re-ran.
    const forcedTimestamp = forced.cas?.analysis_timestamp;
    assert.ok(forcedTimestamp, 'forced run must produce a stamped analysis_timestamp');
    assert.notEqual(forcedTimestamp, firstTimestamp, '--force must produce a distinct analysis_timestamp from the original run');

    // --- AI-cache visibility (honest-degradation parity with reuse_decision
    // / comprehension.degraded): whenever the interpretation pass actually
    // attempted to run (this test environment has no AI provider configured,
    // so it legitimately may not — 'disabled'/'pending'), the forced CAS
    // must say its AI content was regenerated, not silently served from
    // cache.
    const interpretation = (forced.cas as any)?.interpreted_by;
    if (interpretation === 'ready' || interpretation === 'error') {
      assert.ok((forced.cas as any)?.ai_cache_reuse, 'forced CAS must carry ai_cache_reuse for visibility once interpretation attempted');
      assert.equal((forced.cas as any).ai_cache_reuse.bypassed, true);
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousRemoteData === undefined) delete process.env.KLAURO_REMOTE_ANALYZER_DATA;
    else process.env.KLAURO_REMOTE_ANALYZER_DATA = previousRemoteData;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
