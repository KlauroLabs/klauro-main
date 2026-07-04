import test from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  announceEdit,
  appendClaim,
  attributeChange,
  checkEditLock,
  getActiveClaims,
  getPresence,
  readClaimLog,
  releaseAgent,
  releaseEdit,
  watch,
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

  const overlapPrefix = await checkEditLock('ws-test', ['src/auth']);
  assert.equal(overlapPrefix.length, 1);

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
