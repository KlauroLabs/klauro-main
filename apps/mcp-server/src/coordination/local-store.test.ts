import test from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  __clearCachesForTests,
  announceEdit,
  appendClaim,
  attributeChange,
  checkCoordDirDurability,
  checkEditLock,
  describeCursorGap,
  findAgentInOtherWorkspaces,
  getActiveClaims,
  getBoardInfo,
  getPresence,
  readClaimLog,
  recordUnclaimedEdit,
  releaseAgent,
  releaseAgentWithReason,
  releaseEdit,
  warnIfEphemeralCoordDir,
  watch,
  withWorkspaceLock,
} from './local-store';
import type { WorkClaim } from './types';

/** Point KLAURO_COORD_DIR at a fresh temp dir per test so tests don't collide. */
async function freshCoordDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'klauro-coord-test-'));
  process.env.KLAURO_COORD_DIR = dir;
  return dir;
}

function makeClaim(overrides: Partial<WorkClaim> = {}): Omit<WorkClaim, 'seq'> {
  const now = new Date().toISOString();
  return {
    claim_id: 'claim-1',
    workspace_id: 'ws-test',
    agent_id: 'agent-a',
    agent_kind: 'claude',
    scope: { repo: 'proof-of-concept', paths: ['src/foo.ts'], symbols: ['fooHandler'] },
    intent: 'refactor foo',
    status: 'active',
    created_at: now,
    ttl_ms: 60_000,
    heartbeat_at: now,
    ...overrides,
  };
}

test('appendClaim -> readClaimLog round-trip', async () => {
  const dir = await freshCoordDir();
  const entry = await appendClaim('ws-test', makeClaim());
  assert.equal(entry.seq, 1);
  assert.ok(entry.logged_at);

  const log = await readClaimLog('ws-test');
  assert.equal(log.length, 1);
  assert.equal(log[0].claim_id, 'claim-1');
  assert.equal(log[0].agent_id, 'agent-a');

  await fsp.rm(dir, { recursive: true, force: true });
});

test('two agents appending are both visible in active claims + presence', async () => {
  const dir = await freshCoordDir();
  await appendClaim(
    'ws-test',
    makeClaim({ claim_id: 'claim-a', agent_id: 'agent-a', scope: { repo: 'r', paths: ['a.ts'], symbols: [] } })
  );
  await appendClaim(
    'ws-test',
    makeClaim({ claim_id: 'claim-b', agent_id: 'agent-b', scope: { repo: 'r', paths: ['b.ts'], symbols: [] } })
  );

  const active = await getActiveClaims('ws-test');
  assert.equal(active.length, 2);
  const agentIds = active.map((c) => c.agent_id).sort();
  assert.deepEqual(agentIds, ['agent-a', 'agent-b']);

  const presence = await getPresence('ws-test');
  assert.equal(presence.length, 2);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('edit-lock overlap detected via path-prefix; disjoint path not flagged', async () => {
  const dir = await freshCoordDir();
  await announceEdit('ws-test', 'agent-a', ['src/auth/auth.ts'], { agentKind: 'claude' });

  // Overlapping path (exact + prefix) -> flagged.
  const overlapExact = await checkEditLock('ws-test', ['src/auth/auth.ts']);
  assert.equal(overlapExact.length, 1);
  assert.equal(overlapExact[0].agent_id, 'agent-a');
  // `paths` is the HOLDER's (agent-a's) claimed scope, never the proposing
  // caller's own input paths — a fleet must see what the OTHER agent claims.
  assert.deepEqual(overlapExact[0].paths, ['src/auth/auth.ts']);

  const overlapPrefix = await checkEditLock('ws-test', ['src/auth']);
  assert.equal(overlapPrefix.length, 1);
  // Proposer's input ('src/auth') differs from the holder's actual claim
  // ('src/auth/auth.ts') — `paths` must reflect the holder, not the proposer.
  assert.deepEqual(overlapPrefix[0].paths, ['src/auth/auth.ts']);
  assert.notDeepEqual(overlapPrefix[0].paths, ['src/auth']);

  // Disjoint path -> not flagged.
  const disjoint = await checkEditLock('ws-test', ['src/billing/billing.ts']);
  assert.equal(disjoint.length, 0);

  // excludeAgent hides the announcing agent's own lock.
  const excluded = await checkEditLock('ws-test', ['src/auth/auth.ts'], 'agent-a');
  assert.equal(excluded.length, 0);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('attributeChange returns the right agent + intent', async () => {
  const dir = await freshCoordDir();
  await announceEdit('ws-test', 'agent-a', ['src/payments/checkout.ts'], {
    agentKind: 'cursor',
    intent: 'fix checkout bug',
  });

  const attribution = await attributeChange('ws-test', 'src/payments/checkout.ts');
  assert.equal(attribution.attributions.length, 1);
  assert.equal(attribution.attributions[0].agent_id, 'agent-a');
  assert.equal(attribution.attributions[0].intent, 'fix checkout bug');
  assert.equal(attribution.attributions[0].status, 'active');

  const noAttribution = await attributeChange('ws-test', 'src/unrelated/file.ts');
  assert.equal(noAttribution.attributions.length, 0);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('releaseEdit clears the edit-lock so checkEditLock no longer flags it', async () => {
  const dir = await freshCoordDir();
  await announceEdit('ws-test', 'agent-a', ['src/foo.ts']);
  assert.equal((await checkEditLock('ws-test', ['src/foo.ts'])).length, 1);

  await releaseEdit('ws-test', 'agent-a');
  assert.equal((await checkEditLock('ws-test', ['src/foo.ts'])).length, 0);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('TTL expiry honored (reuse presence.isExpired via deriveActiveClaims)', async () => {
  const dir = await freshCoordDir();
  const past = new Date(Date.now() - 10_000).toISOString();
  await appendClaim(
    'ws-test',
    makeClaim({
      claim_id: 'claim-stale',
      agent_id: 'agent-stale',
      ttl_ms: 1000, // expires 1s after heartbeat
      heartbeat_at: past,
      created_at: past,
    })
  );

  const active = await getActiveClaims('ws-test');
  assert.equal(active.length, 0, 'stale claim past its TTL should not be active');

  await fsp.rm(dir, { recursive: true, force: true });
});

test('concurrent interleaved appends from two "processes" get distinct monotonic seq and both persist', async () => {
  const dir = await freshCoordDir();

  // Simulate two agents racing to append via Promise.all (interleaved I/O).
  const results = await Promise.all([
    appendClaim('ws-test', makeClaim({ claim_id: 'race-a', agent_id: 'agent-a' })),
    appendClaim('ws-test', makeClaim({ claim_id: 'race-b', agent_id: 'agent-b' })),
    appendClaim('ws-test', makeClaim({ claim_id: 'race-c', agent_id: 'agent-c' })),
    appendClaim('ws-test', makeClaim({ claim_id: 'race-d', agent_id: 'agent-d' })),
  ]);

  const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
  assert.deepEqual(seqs, [1, 2, 3, 4], 'each concurrent append gets a distinct monotonic seq');

  const log = await readClaimLog('ws-test');
  assert.equal(log.length, 4);
  const claimIds = log.map((e) => e.claim_id).sort();
  assert.deepEqual(claimIds, ['race-a', 'race-b', 'race-c', 'race-d']);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('watch fires on a new append (sub-second local peer awareness)', async () => {
  const dir = await freshCoordDir();
  // Prime the file so fs.watch has a stable target before we start watching.
  await appendClaim('ws-test', makeClaim({ claim_id: 'seed' }));

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unwatch();
      reject(new Error('watch callback did not fire within timeout'));
    }, 5000);
    const unwatch = watch('ws-test', () => {
      clearTimeout(timeout);
      unwatch();
      resolve();
    });
    // Trigger a change after the watcher is attached.
    void appendClaim('ws-test', makeClaim({ claim_id: 'trigger', agent_id: 'agent-watch' }));
  });

  await fsp.rm(dir, { recursive: true, force: true });
});

test('releaseAgent clears ALL of an agent\'s active claims regardless of claim_id scheme', async () => {
  const dir = await freshCoordDir();
  // Same agent holds a `claim`-style work-claim AND an `announce`-style edit-lock,
  // under two different claim_id schemes — the exact fab.ts claim/release mismatch.
  await appendClaim('ws-test', makeClaim({ claim_id: 'ws-test:agent-a', agent_id: 'agent-a' }));
  await announceEdit('ws-test', 'agent-a', ['src/bar.ts']);
  // A second, unrelated agent must be untouched.
  await appendClaim('ws-test', makeClaim({ claim_id: 'ws-test:agent-b', agent_id: 'agent-b' }));

  const before = await getActiveClaims('ws-test');
  assert.equal(before.filter((c) => c.agent_id === 'agent-a').length, 2);

  const released = await releaseAgent('ws-test', 'agent-a');
  assert.equal(released.length, 2, 'both of agent-a\'s active claims are released');
  assert.ok(released.every((e) => e.status === 'released'));

  const after = await getActiveClaims('ws-test');
  assert.equal(after.filter((c) => c.agent_id === 'agent-a').length, 0, 'agent-a fully cleared');
  assert.equal(after.filter((c) => c.agent_id === 'agent-b').length, 1, 'agent-b untouched');

  // Idempotent: releasing again frees nothing.
  const again = await releaseAgent('ws-test', 'agent-a');
  assert.equal(again.length, 0);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('releaseAgent is race-safe against a concurrent appendClaim for the same agent (real bug repro)', async () => {
  // Reported field bug: a subagent's `fab.ts release <agent>` reported
  // success, yet the claim lingered `[active]`. Root cause: reading "my
  // active claims" and appending the "released" records were NOT one atomic
  // critical section — `releaseAgent` used to take an unlocked snapshot via
  // `getActiveClaims`, so a concurrent `appendClaim` for the same claim_id
  // that hadn't yet landed on disk was invisible to it, and the append could
  // complete AFTER release had already finished (having released nothing).
  // This reproduces that exact concurrent claim -> release -> read sequence:
  // both operations are started in the same tick with no ordering constraint
  // between them (mirrors two independent OS processes racing).
  const dir = await freshCoordDir();
  const now = new Date().toISOString();
  let sawUnserializedResult = false;
  for (let i = 0; i < 50; i++) {
    await fsp.rm(dir, { recursive: true, force: true });
    process.env.KLAURO_COORD_DIR = dir;
    const claimP = appendClaim('ws-test', {
      claim_id: 'ws-test:agent-race',
      workspace_id: 'ws-test',
      agent_id: 'agent-race',
      agent_kind: 'claude',
      scope: { repo: 'ws-test', paths: ['x'], symbols: [] },
      intent: 'work',
      status: 'active',
      created_at: now,
      ttl_ms: 60_000,
      heartbeat_at: now,
    });
    const releaseP = releaseAgent('ws-test', 'agent-race');
    await Promise.all([claimP, releaseP]);

    const log = await readClaimLog('ws-test');
    const active = await getActiveClaims('ws-test');

    // The invariant that must ALWAYS hold, regardless of which side wins the
    // race: the final state is never "a claim landed active with no active
    // claim present, yet a later independent read would show it lingering
    // forever with no release event ever having seen it." Concretely: EITHER
    // the claim ends up released (release ran after/observed it), OR the
    // claim is active but ONLY because release legitimately ran first with
    // nothing yet to release (in which case the log has exactly 1 entry: the
    // still-active claim, seq 1) — there is no valid interleaving where a
    // release call can observe zero claims for an agent that has ALREADY
    // appended (same-tick ordering aside, this asserts no torn/duplicate
    // state and no silent data loss).
    assert.ok(
      log.length === 1 || log.length === 2,
      `expected 1 or 2 log entries, got ${log.length}: ${JSON.stringify(log)}`
    );
    if (log.length === 2) {
      // release ran after observing the claim: must be fully collapsed to released.
      assert.equal(active.length, 0, 'claim seen by release must end up released, never lingering');
      sawUnserializedResult = true;
    } else {
      // release ran first (legitimately nothing to release yet); the claim
      // that lands afterward is correctly active — a subsequent release call
      // (as a real caller would issue once it learns release reported 0) is
      // what would clear it. This is not the bug; the bug was silent data
      // loss where the count didn't match the log.
      assert.equal(active.length, 1);
      assert.equal(active[0].status, 'active');
    }
  }
  // Sanity: the race actually produced both interleavings across 50 trials
  // (otherwise this test isn't exercising concurrency at all).
  assert.ok(sawUnserializedResult, 'expected at least one trial where release observed the concurrent claim');

  await fsp.rm(dir, { recursive: true, force: true });
});

test('findAgentInOtherWorkspaces catches the wrong-FAB_WS silent-failure mode', async () => {
  // Second real-world failure mode behind "release reported success but claim
  // lingered": the release call ran against a DIFFERENT workspace_id (e.g.
  // FAB_WS unset in a fresh shell/tool-call, defaulting elsewhere) than the
  // claim. `releaseAgent` correctly reports 0 released for that (wrong)
  // workspace — by design, since workspaces are isolated — but the CLI must
  // be able to detect the agent is active elsewhere so it can warn instead of
  // silently "succeeding".
  const dir = await freshCoordDir();
  const now = new Date().toISOString();
  await appendClaim('poc', {
    claim_id: 'poc:agent-z',
    workspace_id: 'poc',
    agent_id: 'agent-z',
    agent_kind: 'claude',
    scope: { repo: 'poc', paths: ['src/foo.ts'], symbols: [] },
    intent: 'work',
    status: 'active',
    created_at: now,
    ttl_ms: 60_000,
    heartbeat_at: now,
  });

  // Simulate: caller mistakenly releases against the default workspace, not 'poc'.
  const releasedWrong = await releaseAgent('deployable-detection-build', 'agent-z');
  assert.equal(releasedWrong.length, 0, 'nothing to release under the wrong workspace');

  const elsewhere = await findAgentInOtherWorkspaces('agent-z', 'deployable-detection-build');
  assert.deepEqual(elsewhere, ['poc'], 'the claim is found under its real workspace');

  // Claim is still active and undisturbed under its real workspace.
  const stillActive = await getActiveClaims('poc');
  assert.equal(stillActive.length, 1);
  assert.equal(stillActive[0].agent_id, 'agent-z');

  await fsp.rm(dir, { recursive: true, force: true });
});

test('appendClaim recovers after a torn trailing line left by a mid-write crash', async () => {
  // Real failure mode: a process dies mid `fsp.appendFile` write, leaving the
  // final line in claims.jsonl truncated (no trailing '\n', invalid JSON).
  // readClaimLog already tolerates this (skips the unparseable line) — but
  // appendClaimLocked previously wrote `JSON.stringify(entry) + '\n'` with NO
  // leading newline, so the NEXT append's bytes landed glued onto the tail of
  // the torn fragment, merging them into ONE unparseable line and silently
  // swallowing the new claim too (readClaimLog skips the whole merged line).
  // A single crash could cascade into losing every subsequent append until
  // someone manually truncated the file. Fixed: appendClaimLocked now checks
  // whether the log's last byte is already '\n' and prefixes its own write
  // with one if not, isolating the torn fragment on its own line.
  const dir = await freshCoordDir();
  const storeDir = path.join(dir, 'ws-torn');
  await fsp.mkdir(storeDir, { recursive: true });
  const logPath = path.join(storeDir, 'claims.jsonl');

  const good = makeClaim({ claim_id: 'claim-a', agent_id: 'agent-a', workspace_id: 'ws-torn' });
  const goodEntry = { ...good, seq: 1, logged_at: new Date().toISOString() };
  const tornEntry = JSON.stringify({ ...good, claim_id: 'claim-b', seq: 2, logged_at: new Date().toISOString() });
  // Write one complete line, then a TRUNCATED (torn) second line with no
  // trailing newline — simulating a crash mid-`appendFile`.
  await fsp.writeFile(logPath, JSON.stringify(goodEntry) + '\n' + tornEntry.slice(0, Math.floor(tornEntry.length / 2)), 'utf8');

  const beforeLog = await readClaimLog('ws-torn');
  assert.deepEqual(beforeLog.map((e) => e.claim_id), ['claim-a'], 'torn line is skipped, prior valid line intact');

  // A fresh agent appends after the crash — this must NOT be swallowed.
  await appendClaim('ws-torn', makeClaim({ claim_id: 'claim-c', agent_id: 'agent-c', workspace_id: 'ws-torn' }));

  const afterLog = await readClaimLog('ws-torn');
  const ids = afterLog.map((e) => e.claim_id).sort();
  assert.deepEqual(ids, ['claim-a', 'claim-c'], 'new claim survives and is readable despite the preceding torn line');

  const active = await getActiveClaims('ws-torn');
  assert.deepEqual(active.map((c) => c.agent_id).sort(), ['agent-a', 'agent-c']);

  await fsp.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// W5 (SPEC-COORDINATION-FABRIC-V3 §6.3/§8): release/complete semantics —
// released_count must be truthful and NEVER silent when it is 0.
// ---------------------------------------------------------------------------

test('releaseAgentWithReason: claim then release through the SAME path fab_release_work uses reports released_count 1, no reason', async () => {
  // Mirrors exactly what server.ts's `fab_claim_work` / `fab_release_work`
  // tools do: appendClaim with claim_id `${ws}:${agent_id}`, then release.
  const dir = await freshCoordDir();
  const now = new Date().toISOString();
  await appendClaim('ws-test', {
    claim_id: 'ws-test:agent-x',
    workspace_id: 'ws-test',
    agent_id: 'agent-x',
    agent_kind: 'claude',
    scope: { repo: 'ws-test', paths: ['src/foo.ts'], symbols: [] },
    intent: 'W5 repro',
    status: 'active',
    created_at: now,
    ttl_ms: 60_000,
    heartbeat_at: now,
  });

  const outcome = await releaseAgentWithReason('ws-test', 'agent-x');
  assert.equal(outcome.released.length, 1, 'the claim that was definitely made is definitely released');
  assert.equal(outcome.reason, undefined, 'a genuine release never carries a reason');

  await fsp.rm(dir, { recursive: true, force: true });
});

test('releaseAgentWithReason: double-release reports 0 + an explicit no-op reason (never silent)', async () => {
  const dir = await freshCoordDir();
  await appendClaim('ws-test', makeClaim({ claim_id: 'ws-test:agent-a', agent_id: 'agent-a' }));

  const first = await releaseAgentWithReason('ws-test', 'agent-a');
  assert.equal(first.released.length, 1);
  assert.equal(first.reason, undefined);

  const second = await releaseAgentWithReason('ws-test', 'agent-a');
  assert.equal(second.released.length, 0);
  assert.match(second.reason ?? '', /no-op, not an error/, 'double-release explains itself as a legitimate no-op');

  await fsp.rm(dir, { recursive: true, force: true });
});

test('releaseAgentWithReason: an agent that never claimed anything gets an explicit reason, not a bare 0', async () => {
  const dir = await freshCoordDir();
  await fsp.mkdir(path.join(dir, 'ws-test'), { recursive: true });

  const outcome = await releaseAgentWithReason('ws-test', 'agent-never-existed');
  assert.equal(outcome.released.length, 0);
  assert.match(outcome.reason ?? '', /No claim was ever recorded/);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('releaseAgentWithReason: wrong-workspace release surfaces WHERE the real claim is active', async () => {
  const dir = await freshCoordDir();
  const now = new Date().toISOString();
  await appendClaim('poc', {
    claim_id: 'poc:agent-z',
    workspace_id: 'poc',
    agent_id: 'agent-z',
    agent_kind: 'claude',
    scope: { repo: 'poc', paths: ['src/foo.ts'], symbols: [] },
    intent: 'work',
    status: 'active',
    created_at: now,
    ttl_ms: 60_000,
    heartbeat_at: now,
  });

  const outcome = await releaseAgentWithReason('deployable-detection-build', 'agent-z');
  assert.equal(outcome.released.length, 0);
  assert.match(outcome.reason ?? '', /workspace-id mismatch/);
  assert.match(outcome.reason ?? '', /poc/);

  // The real claim is untouched by the failed release attempt.
  const stillActive = await getActiveClaims('poc');
  assert.equal(stillActive.length, 1);

  await fsp.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// recordUnclaimedEdit (W5): additive jsonl format, never enters active-claim views.
// ---------------------------------------------------------------------------

test('recordUnclaimedEdit logs an event that reduceClaimLog/deriveActiveClaims/derivePresence never surface as active', async () => {
  const dir = await freshCoordDir();
  const entry = await recordUnclaimedEdit('ws-test', 'src/surprise.ts', { detectedBy: 'write-hook' });
  assert.equal(entry.kind, 'unclaimed-edit');
  assert.equal(entry.status, 'released');

  const active = await getActiveClaims('ws-test');
  assert.equal(active.length, 0, 'an unclaimed-edit event is never an active claim');

  const presence = await getPresence('ws-test');
  assert.equal(presence.length, 0, 'an unclaimed-edit event never appears in the presence roster');

  // But it IS visible in the raw log for anyone building an awareness/audit view.
  const log = await readClaimLog('ws-test');
  assert.equal(log.filter((e) => e.kind === 'unclaimed-edit').length, 1);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('recordUnclaimedEdit: existing readers tolerate the new field (jsonl format compatibility)', async () => {
  // A "reader that doesn't know about `kind`" is simulated by re-parsing the
  // raw log through JSON.parse and feeding it straight into reduceClaimLog —
  // exactly what every pre-W5 consumer of claims.jsonl does. It must not
  // throw, and must not misclassify the unclaimed-edit line as an active claim.
  const dir = await freshCoordDir();
  await appendClaim('ws-test', makeClaim({ claim_id: 'ws-test:agent-a', agent_id: 'agent-a' }));
  await recordUnclaimedEdit('ws-test', 'src/mystery.ts');

  const log = await readClaimLog('ws-test');
  assert.equal(log.length, 2);
  const active = await getActiveClaims('ws-test');
  assert.deepEqual(active.map((c) => c.agent_id), ['agent-a']);

  await fsp.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Coordination Engine wave 1 — durable board (epoch + boot sweep), writer-owned
// versions, released_count defect, lockfile hardening.
// ---------------------------------------------------------------------------

test('board epoch: minted once, stable across appends, and atomic under two racing first-writers', async () => {
  const dir = await freshCoordDir();

  // Two racing first-writers on a fresh board — epoch minting happens under
  // the workspace lock, so exactly ONE epoch may exist afterwards.
  await Promise.all([
    appendClaim('ws-test', makeClaim({ claim_id: 'race-a', agent_id: 'agent-a' })),
    appendClaim('ws-test', makeClaim({ claim_id: 'race-b', agent_id: 'agent-b' })),
  ]);
  const first = await getBoardInfo('ws-test');
  assert.ok(first.epoch.length > 0, 'a board mints an epoch at creation');
  assert.equal(first.min_retained_seq, 1, 'a board that never evicted anything retains from seq 1');

  await appendClaim('ws-test', makeClaim({ claim_id: 'later', agent_id: 'agent-c' }));
  const second = await getBoardInfo('ws-test');
  assert.equal(second.epoch, first.epoch, 'epoch is board identity — stable across writes');

  await fsp.rm(dir, { recursive: true, force: true });
});

test('boot sweep: a server restart over a populated board preserves claims, seq, and epoch', async () => {
  const dir = await freshCoordDir();
  await appendClaim('ws-test', makeClaim({ claim_id: 'survivor-1', agent_id: 'agent-a' }));
  await appendClaim('ws-test', makeClaim({ claim_id: 'survivor-2', agent_id: 'agent-b' }));
  const beforeEpoch = (await getBoardInfo('ws-test')).epoch;
  const beforeLog = await readClaimLog('ws-test');
  const beforeMaxSeq = beforeLog.reduce((m, e) => Math.max(m, e.seq), 0);

  // "Restart": drop every in-memory cache so the next reads come purely from disk.
  __clearCachesForTests();

  const afterLog = await readClaimLog('ws-test');
  assert.equal(afterLog.length, beforeLog.length, 'restart must not lose log entries');
  const active = await getActiveClaims('ws-test');
  assert.deepEqual(active.map((c) => c.claim_id).sort(), ['survivor-1', 'survivor-2'], 'claims survive a restart');
  assert.equal((await getBoardInfo('ws-test')).epoch, beforeEpoch, 'epoch survives a restart — clients keep their cursors');

  // seq keeps counting from where it was — never resets to 1 (the 2026-07-21 failure mode).
  const next = await appendClaim('ws-test', makeClaim({ claim_id: 'post-restart', agent_id: 'agent-c' }));
  assert.equal(next.seq, beforeMaxSeq + 1, 'seq continues monotonically across a restart');

  await fsp.rm(dir, { recursive: true, force: true });
});

test('writer-owned version: appendClaim mints a monotonic per-claim version; a supplied version is preserved verbatim', async () => {
  const dir = await freshCoordDir();
  const v1 = await appendClaim('ws-test', makeClaim({ claim_id: 'versioned' }));
  const v2 = await appendClaim('ws-test', makeClaim({ claim_id: 'versioned', intent: 'updated' }));
  const other = await appendClaim('ws-test', makeClaim({ claim_id: 'different', agent_id: 'agent-b' }));
  assert.equal(v1.version, 1);
  assert.equal(v2.version, 2, 'same claim_id increments its own version');
  assert.equal(other.version, 1, 'versions are PER-CLAIM, not per-board');

  const echoed = await appendClaim('ws-test', { ...makeClaim({ claim_id: 'replicated' }), version: 7 });
  assert.equal(echoed.version, 7, 'a replicated entry keeps its writer-owned version — receivers never re-assign');

  await fsp.rm(dir, { recursive: true, force: true });
});

test('appendClaim returns the original entry when an operation id is retried', async () => {
  const dir = await freshCoordDir();
  const first = await appendClaim('ws-test', makeClaim({ claim_id: 'operation-claim', operation_id: 'operation-a' }));
  const replay = await appendClaim('ws-test', makeClaim({ claim_id: 'operation-claim', operation_id: 'operation-a' }));
  assert.equal(replay.seq, first.seq);
  assert.equal((await readClaimLog('ws-test')).length, 1);
  const released = await releaseAgent('ws-test', 'agent-a');
  assert.equal(released.length, 1);
  assert.equal((await getActiveClaims('ws-test')).length, 0);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('releaseAgent releases a TTL-expired claim (v3 §6.3 released_count:0 defect)', async () => {
  const dir = await freshCoordDir();
  // A claim that was definitely made, whose TTL lapsed before the agent released.
  await appendClaim('ws-test', makeClaim({ claim_id: 'ws-test:agent-a', agent_id: 'agent-a', ttl_ms: 1 }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((await getActiveClaims('ws-test')).length, 0, 'precondition: the claim is TTL-expired');

  const outcome = await releaseAgentWithReason('ws-test', 'agent-a');
  assert.equal(outcome.released.length, 1, 'release must close out the expired-but-still-latest-active claim, not report 0');
  assert.equal(outcome.reason, undefined, 'a real release carries no zero-explanation');
  assert.equal(outcome.released[0].status, 'released');

  // Double-release is now the legitimate no-op with an explanation.
  const again = await releaseAgentWithReason('ws-test', 'agent-a');
  assert.equal(again.released.length, 0);
  assert.ok(again.reason, 'a zero release always says why');

  await fsp.rm(dir, { recursive: true, force: true });
});

test('lockfile hardening: a critical section longer than the old stale window is not stolen (no duplicate seq)', async (t) => {
  const dir = await freshCoordDir();
  // Hold the workspace lock ~6.5s — longer than the pre-hardening 5s stale
  // window. The heartbeat must keep the lockfile fresh so a concurrent writer
  // WAITS instead of reclaiming the lock and double-assigning seq.
  const slowHolder = withWorkspaceLock('ws-test', async ({ append }) => {
    await new Promise((r) => setTimeout(r, 6_500));
    return append(makeClaim({ claim_id: 'slow-writer', agent_id: 'agent-slow' }));
  });
  await new Promise((r) => setTimeout(r, 100)); // let the holder acquire first.
  const contender = appendClaim('ws-test', makeClaim({ claim_id: 'contender', agent_id: 'agent-fast' }));

  const [slowEntry, fastEntry] = await Promise.all([slowHolder, contender]);
  assert.notEqual(slowEntry.seq, fastEntry.seq, 'two writers must never share a seq');
  const log = await readClaimLog('ws-test');
  const seqs = log.map((e) => e.seq);
  assert.equal(new Set(seqs).size, seqs.length, 'every seq in the log is unique');

  await fsp.rm(dir, { recursive: true, force: true });
});

test('coord-dir durability guard: flags a containerized coord dir outside the data root; quiet on a bare host', async () => {
  const dir = await freshCoordDir(); // KLAURO_COORD_DIR now points at a tmp dir.
  const badInContainer = checkCoordDirDurability({ dataRoot: '/data', isContainer: true });
  assert.equal(badInContainer.durable, false);
  assert.ok(badInContainer.warning && badInContainer.warning.includes('KLAURO_COORD_DIR'));

  const okOnHost = checkCoordDirDurability({ dataRoot: '/data', isContainer: false });
  assert.equal(okOnHost.durable, true, 'a host-side home-dir store is persistent — no false alarm');

  const goodInContainer = checkCoordDirDurability({ dataRoot: path.dirname(dir), isContainer: true });
  assert.equal(goodInContainer.durable, true, 'coord dir under the data root is fine in a container');

  const printed: string[] = [];
  warnIfEphemeralCoordDir({ dataRoot: '/data', isContainer: true, print: (m) => printed.push(m) });
  assert.equal(printed.length, 1, 'the guard warns loudly when the board is ephemeral');

  await fsp.rm(dir, { recursive: true, force: true });
});

test('describeCursorGap: explicit notice below the retention floor, silence at/above it', () => {
  assert.ok(describeCursorGap(3, { min_retained_seq: 10 }), 'a cursor below the floor gets an explicit gap notice');
  assert.equal(describeCursorGap(9, { min_retained_seq: 10 }), undefined, 'cursor at floor-1 is complete');
  assert.equal(describeCursorGap(15, { min_retained_seq: 10 }), undefined);
});
