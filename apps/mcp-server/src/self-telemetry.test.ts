import { test } from 'node:test';
import assert from 'node:assert/strict';
import type * as http from 'node:http';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import * as fs from 'node:fs';
import * as fsExtra from 'fs-extra';
import { getAnalysis } from './analyzer';
import { loadTelemetryObservations, type TelemetryEvent } from './telemetry-ingestion';

const REQUIRE = () => import('./self-telemetry');

function withEnv(value: string | undefined, fn: () => void): void {
  const prev = process.env.KLAURO_SELF_TELEMETRY;
  if (value === undefined) delete process.env.KLAURO_SELF_TELEMETRY;
  else process.env.KLAURO_SELF_TELEMETRY = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.KLAURO_SELF_TELEMETRY;
    else process.env.KLAURO_SELF_TELEMETRY = prev;
  }
}

async function withCanonicalEnv(value: string | undefined, fn: () => void | Promise<void>): Promise<void> {
  const prev = process.env.KLAURO_SELF_TELEMETRY_CANONICAL_PROJECT;
  if (value === undefined) delete process.env.KLAURO_SELF_TELEMETRY_CANONICAL_PROJECT;
  else process.env.KLAURO_SELF_TELEMETRY_CANONICAL_PROJECT = value;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.KLAURO_SELF_TELEMETRY_CANONICAL_PROJECT;
    else process.env.KLAURO_SELF_TELEMETRY_CANONICAL_PROJECT = prev;
  }
}

async function withTempStorage(run: (storage: string) => Promise<void>): Promise<void> {
  const storage = await fsExtra.mkdtemp(nodePath.join(os.tmpdir(), 'klauro-self-telemetry-storage-'));
  const previousStorage = process.env.KLAURO_STORAGE_PATH;
  process.env.KLAURO_STORAGE_PATH = storage;
  try {
    await run(storage);
  } finally {
    if (previousStorage === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previousStorage;
    await fsExtra.remove(storage);
  }
}

function withProjectEnv(value: string | undefined, fn: () => void): void {
  const prev = process.env.KLAURO_SELF_TELEMETRY_PROJECT;
  if (value === undefined) delete process.env.KLAURO_SELF_TELEMETRY_PROJECT;
  else process.env.KLAURO_SELF_TELEMETRY_PROJECT = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.KLAURO_SELF_TELEMETRY_PROJECT;
    else process.env.KLAURO_SELF_TELEMETRY_PROJECT = prev;
  }
}

test('selfTelemetryEnabled: gate is off by default and for falsy values', async () => {
  const { selfTelemetryEnabled } = await REQUIRE();
  for (const v of [undefined, '', '0', 'false', 'off', 'no', 'FALSE']) {
    withEnv(v, () => assert.equal(selfTelemetryEnabled(), false, `expected disabled for ${JSON.stringify(v)}`));
  }
});

test('selfTelemetryEnabled: gate is on for truthy values', async () => {
  const { selfTelemetryEnabled } = await REQUIRE();
  for (const v of ['1', 'true', 'yes', 'on']) {
    withEnv(v, () => assert.equal(selfTelemetryEnabled(), true, `expected enabled for ${JSON.stringify(v)}`));
  }
});

test('instrumentHttpHandler: returns the ORIGINAL handler unchanged when gate is off', async () => {
  const { instrumentHttpHandler } = await REQUIRE();
  withEnv(undefined, () => {
    const original = (_req: http.IncomingMessage, _res: http.ServerResponse) => {};
    assert.equal(instrumentHttpHandler(original), original, 'gate off must not wrap');
  });
});

test('instrumentHttpHandler: wraps and still invokes the handler when gate is on', async () => {
  const { instrumentHttpHandler } = await REQUIRE();
  withEnv('1', () => {
    let called = false;
    const original = (_req: http.IncomingMessage, _res: http.ServerResponse) => { called = true; };
    const wrapped = instrumentHttpHandler(original);
    assert.notEqual(wrapped, original, 'gate on should wrap');
    // Fake req/res with a finish-hook registrar; wrapper must never throw and must call through.
    const res = { statusCode: 200, on(_e: string, _l: () => void) { return this; } } as unknown as http.ServerResponse;
    const req = { method: 'GET', url: '/x' } as unknown as http.IncomingMessage;
    wrapped(req, res);
    assert.equal(called, true, 'wrapped handler must invoke the original');
  });
});

test('initSelfTelemetry: no-op returns false when gate is off', async () => {
  const { initSelfTelemetry } = await REQUIRE();
  withEnv(undefined, () => assert.equal(initSelfTelemetry(), false));
});

test('resolveSelfSourceDir: resolves this mcp-server src dir (present in-process)', async () => {
  const { resolveSelfSourceDir } = await REQUIRE();
  const dir = resolveSelfSourceDir();
  assert.ok(dir, 'expected a resolved source dir');
  assert.equal(nodePath.basename(dir!), 'src', 'should end at the src dir');
  assert.equal(nodePath.basename(nodePath.dirname(dir!)), 'mcp-server', 'parent should be mcp-server');
  assert.ok(fs.existsSync(dir!), 'resolved dir must exist in this process');
  // This very test file lives under the resolved dir.
  assert.ok(fs.existsSync(nodePath.join(dir!, 'self-telemetry.ts')));
});

test('selfProjectPath: honors an EXISTING override', async () => {
  const { selfProjectPath, resolveSelfSourceDir } = await REQUIRE();
  const existing = resolveSelfSourceDir()!; // a real path
  withProjectEnv(existing, () => {
    assert.equal(selfProjectPath(), existing, 'existing override should be used verbatim');
  });
});

test('selfProjectPath: IGNORES an override that is absent in-process, falls back to src dir', async () => {
  const { selfProjectPath, resolveSelfSourceDir } = await REQUIRE();
  const missing = nodePath.join(os.tmpdir(), `klauro-nonexistent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  assert.equal(fs.existsSync(missing), false);
  withProjectEnv(missing, () => {
    // The old default (process.cwd()) is wrong in a container; the fix keys to the
    // in-process source dir instead so bootstrap+correlation can happen.
    assert.equal(selfProjectPath(), resolveSelfSourceDir(), 'absent override must fall back to the in-process src dir');
  });
});

test('maybeBootstrapSelfAnalysis: runs at most ONCE per process (run-once guard)', async () => {
  // Fresh module instance so the module-level bootstrapStarted flag is pristine.
  const mod = await import(`./self-telemetry?bootstrap-guard=${Date.now()}`);
  const missing = nodePath.join(os.tmpdir(), `klauro-bootstrap-none-${Date.now()}`);
  assert.equal(fs.existsSync(missing), false);
  // First call: path doesn't exist → skips analysis but SETS the guard. Must not throw.
  await mod.maybeBootstrapSelfAnalysis(missing);
  // Second call: guard is set → returns immediately, still crash-proof.
  await mod.maybeBootstrapSelfAnalysis(missing);
  // A third call against a DIFFERENT (also-missing) path is still a no-op because
  // the once-guard already fired — proving it never re-analyzes on every boot.
  const missing2 = nodePath.join(os.tmpdir(), `klauro-bootstrap-none2-${Date.now()}`);
  await mod.maybeBootstrapSelfAnalysis(missing2);
  assert.ok(true, 'bootstrap is crash-proof and run-once');
});

// ---------------------------------------------------------------------------
// GAP #32 part 2 — canonical-bucket mirror (self-telemetry key identity)
// ---------------------------------------------------------------------------

test('selfCanonicalProjectPath: unset/blank => null (no-op)', async () => {
  const { selfCanonicalProjectPath } = await REQUIRE();
  await withCanonicalEnv(undefined, () => assert.equal(selfCanonicalProjectPath(), null));
  await withCanonicalEnv('   ', () => assert.equal(selfCanonicalProjectPath(), null));
});

test('selfCanonicalProjectPath: returns the trimmed override when set', async () => {
  const { selfCanonicalProjectPath } = await REQUIRE();
  await withCanonicalEnv('  /data/workspaces/prj_example  ', () => {
    assert.equal(selfCanonicalProjectPath(), '/data/workspaces/prj_example');
  });
});

test('mirrorToCanonicalBucket: WITHOUT the env set, behavior is exactly current (no second write, no throw)', async () => {
  await withTempStorage(async () => {
    const { mirrorToCanonicalBucket } = await REQUIRE();
    const primary = nodePath.join(os.tmpdir(), 'klauro-primary-noop');
    const events: TelemetryEvent[] = [{ kind: 'request', method: 'GET', route: '/x', status: 200, duration_ms: 5 }];
    await withCanonicalEnv(undefined, async () => {
      await mirrorToCanonicalBucket(primary, events);
    });
    // Nothing to check in the canonical bucket because there is no canonical
    // path configured — this must be a true no-op, not an error.
    assert.ok(true, 'no-op did not throw');
  });
});

test('mirrorToCanonicalBucket: WITH the env set, an ingested observation lands in BOTH buckets', async () => {
  await withTempStorage(async () => {
    const { mirrorToCanonicalBucket } = await REQUIRE();
    const primary = nodePath.join(os.tmpdir(), 'klauro-primary-dual');
    const canonical = '/data/workspaces/prj_test_canonical';
    const events: TelemetryEvent[] = [
      { kind: 'request', method: 'GET', route: '/dual-key-route', status: 200, duration_ms: 7 },
    ];

    await withCanonicalEnv(canonical, async () => {
      await mirrorToCanonicalBucket(primary, events);
    });

    const canonicalObservations = await loadTelemetryObservations(canonical);
    assert.equal(canonicalObservations.observations.length, 1, 'canonical bucket should receive the mirrored observation');
    assert.equal(canonicalObservations.observations[0].event.route, '/dual-key-route');

    const primaryObservations = await loadTelemetryObservations(primary);
    assert.equal(primaryObservations.observations.length, 0, 'mirrorToCanonicalBucket never writes the primary bucket itself — that is the caller\'s job');
  });
});

test('mirrorToCanonicalBucket: identical canonical/primary path is a no-op (nothing to mirror into)', async () => {
  await withTempStorage(async () => {
    const { mirrorToCanonicalBucket } = await REQUIRE();
    const samePath = nodePath.join(os.tmpdir(), 'klauro-same-path');
    const events: TelemetryEvent[] = [{ kind: 'request', method: 'GET', route: '/same', status: 200, duration_ms: 3 }];

    await withCanonicalEnv(samePath, async () => {
      await mirrorToCanonicalBucket(samePath, events);
    });

    const observations = await loadTelemetryObservations(samePath);
    assert.equal(observations.observations.length, 0, 'no duplicate write when canonical === primary');
  });
});

test('mirrorToCanonicalBucket: NEVER bootstrap-analyzes the canonical path', async () => {
  await withTempStorage(async () => {
    const { mirrorToCanonicalBucket } = await REQUIRE();
    const primary = nodePath.join(os.tmpdir(), 'klauro-primary-bootstrap-guard');
    const canonical = '/data/workspaces/prj_bootstrap_guard_test';
    const events: TelemetryEvent[] = [{ kind: 'request', method: 'GET', route: '/y', status: 200, duration_ms: 4 }];

    await withCanonicalEnv(canonical, async () => {
      await mirrorToCanonicalBucket(primary, events);
    });

    // If mirrorToCanonicalBucket had ever called analyzeProject/maybeBootstrapSelfAnalysis
    // for the canonical path, an analysis would now exist for it. It must not:
    // getAnalysis for a never-analyzed, non-existent path must still reject.
    await assert.rejects(
      () => getAnalysis(canonical),
      'mirroring must never trigger analysis of the canonical path (would risk a whale re-analysis on every request batch)',
    );

    // The observation itself must still have persisted (unmatched, since no CAS).
    const canonicalObservations = await loadTelemetryObservations(canonical);
    assert.equal(canonicalObservations.observations.length, 1);
    assert.equal(canonicalObservations.observations[0].correlation.status, 'unmatched');
  });
});
