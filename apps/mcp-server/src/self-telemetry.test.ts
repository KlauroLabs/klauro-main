import { test } from 'node:test';
import assert from 'node:assert/strict';
import type * as http from 'node:http';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import * as fs from 'node:fs';
import * as fsExtra from 'fs-extra';
import { getAnalysis } from './analyzer';
import { beginForegroundAnalysis } from './foreground-analysis';
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

test('selfProjectPath preserves canonical project identity even before its CAS exists', async () => {
  const { selfProjectPath } = await REQUIRE();
  const missing = nodePath.join(os.tmpdir(), `klauro-nonexistent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  assert.equal(fs.existsSync(missing), false);
  withProjectEnv(missing, () => {
    assert.equal(selfProjectPath(), missing, 'telemetry stays keyed to the configured project and persists unmatched until CAS backfill');
  });
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

test('self telemetry waits for foreground analysis before persisting', async () => {
  await withTempStorage(async () => {
    const { enqueueSelfTelemetryEvents, waitForSelfTelemetryIngest } = await REQUIRE();
    const project = nodePath.join(os.tmpdir(), `klauro-self-deferred-${Date.now()}`);
    const endAnalysis = beginForegroundAnalysis();
    enqueueSelfTelemetryEvents(project, [{
      kind: 'request',
      method: 'POST',
      route: '/v1/analyze',
      status: 202,
      duration_ms: 20,
    }]);

    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal((await loadTelemetryObservations(project)).observations.length, 0);
    } finally {
      endAnalysis();
    }
    await waitForSelfTelemetryIngest();
    const observations = await loadTelemetryObservations(project);
    assert.equal(observations.observations.length, 1);
    assert.equal(observations.observations[0].event.route, '/v1/analyze');
  });
});

test('self telemetry persistence runs outside the API event loop', async () => {
  await withTempStorage(async () => {
    const root = await fsExtra.mkdtemp(nodePath.join(os.tmpdir(), 'klauro-self-worker-'));
    const entry = nodePath.join(root, 'worker.cjs');
    const previousEntry = process.env.KLAURO_SELF_TELEMETRY_WORKER_ENTRY;
    fs.writeFileSync(entry, `
process.once('message', () => {
  const started = Date.now();
  while (Date.now() - started < 300) {}
  process.send({ type: 'result' });
});
`);
    process.env.KLAURO_SELF_TELEMETRY_WORKER_ENTRY = entry;
    const { enqueueSelfTelemetryEvents, waitForSelfTelemetryIngest } = await REQUIRE();
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 10);
    try {
      enqueueSelfTelemetryEvents('/tmp/klauro-self-isolated', [{ kind: 'request', route: '/health', status: 200 }]);
      await waitForSelfTelemetryIngest();
      assert.ok(ticks >= 10, `API event loop advanced only ${ticks} times during isolated telemetry work`);
    } finally {
      clearInterval(timer);
      if (previousEntry === undefined) delete process.env.KLAURO_SELF_TELEMETRY_WORKER_ENTRY;
      else process.env.KLAURO_SELF_TELEMETRY_WORKER_ENTRY = previousEntry;
      await fsExtra.remove(root);
    }
  });
});

// ---------------------------------------------------------------------------
// mapSdkEvent — direct CAS-id passthrough (Tier 4 join input boundary).
//
// getRuntimeEventContract (runtime-contract.ts) advertises `correlation_order:
// ['static_id', 'entry_point_id', 'exit_point_id', 'call_chain_id', 'node_id',
// 'signal', 'route', 'path', 'stack']` to every SDK integrator, and
// correlateRuntimeEvent (product.ts) genuinely checks those fields FIRST.
// Found live against the deployed product (POST /api/telemetry/runtime-
// events/:projectId with static_id+node_id set): the ingested observation
// echoed back with BOTH fields absent and correlation status "unmatched" —
// mapSdkEvent was silently dropping the exact keys the product's own contract
// told the caller to send, forcing every real SDK-reported event through
// route/path/stack fuzzy matching only, regardless of what the caller knew.
// This locks the fix in: every one of CasRuntimeEvent's direct-id fields must
// survive the SDK-event -> TelemetryEvent translation unchanged.
// ---------------------------------------------------------------------------
test('mapSdkEvent forwards every direct CAS-id field (static_id/node_id/entry_point_id/exit_point_id/call_chain_id) unchanged', async () => {
  const { mapSdkEvent } = await REQUIRE();
  const mapped = mapSdkEvent({
    type: 'request',
    static_id: 'node:handleCreateOrder',
    node_id: 'n_handleCreateOrder',
    entry_point_id: 'ep_createOrder',
    exit_point_id: 'ex_notifyWarehouse',
    call_chain_id: 'chain_createOrder',
    method: 'POST',
    route: '/orders',
    status_code: 201,
    duration_ms: 12,
  });
  assert.equal(mapped.static_id, 'node:handleCreateOrder');
  assert.equal(mapped.node_id, 'n_handleCreateOrder');
  assert.equal(mapped.entry_point_id, 'ep_createOrder');
  assert.equal(mapped.exit_point_id, 'ex_notifyWarehouse');
  assert.equal(mapped.call_chain_id, 'chain_createOrder');
});

test('mapSdkEvent leaves direct CAS-id fields undefined (not fabricated) when the SDK event carries none', async () => {
  const { mapSdkEvent } = await REQUIRE();
  const mapped = mapSdkEvent({ type: 'request', method: 'GET', route: '/health', status_code: 200 });
  assert.equal(mapped.static_id, undefined);
  assert.equal(mapped.node_id, undefined);
  assert.equal(mapped.entry_point_id, undefined);
  assert.equal(mapped.exit_point_id, undefined);
  assert.equal(mapped.call_chain_id, undefined);
});
