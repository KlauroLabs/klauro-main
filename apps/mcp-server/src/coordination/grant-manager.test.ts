/**
 * Tests for the ENFORCED, symbol-level grant arbitration core (grant-manager.ts).
 * Uses real time with short TTLs (per mission guidance) rather than mocking
 * `Date.now`. Each test gets an isolated `workspace_id` under a temp
 * `KLAURO_COORD_DIR` so nothing touches real `~/.klauro` state, and the temp
 * dir is removed in `after()`.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  getGrants,
  heartbeatGrant,
  releaseGrant,
  requestGrant,
  type GrantRequest,
} from './grant-manager';

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-grant-manager-test-'));
  process.env.KLAURO_COORD_DIR = tmpDir;
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.KLAURO_COORD_DIR;
});

let wsCounter = 0;
function freshWorkspaceId(): string {
  wsCounter += 1;
  return `ws-${Date.now()}-${wsCounter}`;
}

function req(overrides: Partial<GrantRequest> & { workspace_id: string }): GrantRequest {
  return {
    agent_id: 'agent-a',
    agent_kind: 'claude',
    scope: { repo: 'r', paths: [], symbols: ['sym:Foo'] },
    intent: 'edit Foo',
    ...overrides,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Assert the core invariant: no two ACTIVE grants share a symbol or path. */
async function assertNoActiveOverlap(workspaceId: string): Promise<void> {
  const { active } = await getGrants(workspaceId);
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];
      const sharedSymbols = a.scope.symbols.filter((s) => b.scope.symbols.includes(s));
      const sharedPaths = a.scope.paths.filter((p) =>
        b.scope.paths.some((q) => p === q || p.startsWith(q + '/') || q.startsWith(p + '/'))
      );
      assert.equal(
        sharedSymbols.length,
        0,
        `invariant violated: grants ${a.grant_id} and ${b.grant_id} share symbols ${JSON.stringify(sharedSymbols)}`
      );
      assert.equal(
        sharedPaths.length,
        0,
        `invariant violated: grants ${a.grant_id} and ${b.grant_id} share paths ${JSON.stringify(sharedPaths)}`
      );
    }
  }
}

describe('grant-manager', () => {
  it('1. two agents request the same symbol: one granted, one queued', async () => {
    const ws = freshWorkspaceId();
    const r1 = await requestGrant(req({ workspace_id: ws, agent_id: 'agent-a' }));
    const r2 = await requestGrant(req({ workspace_id: ws, agent_id: 'agent-b' }));

    assert.equal(r1.verdict, 'granted');
    assert.ok(r1.grant_id);
    assert.ok(r1.lease_expires_at);

    assert.equal(r2.verdict, 'queued');
    assert.equal(r2.queue_position, 1);
    assert.ok(r2.conflict);
    assert.equal(r2.conflict?.holder_agent_id, 'agent-a');
    assert.deepEqual(r2.conflict?.overlapping_symbols, ['sym:Foo']);
    assert.equal(r2.conflict?.kind, 'symbol');

    await assertNoActiveOverlap(ws);
  });

  it('2. holder releases -> queued request is auto-granted', async () => {
    const ws = freshWorkspaceId();
    const r1 = await requestGrant(req({ workspace_id: ws, agent_id: 'agent-a' }));
    const r2 = await requestGrant(req({ workspace_id: ws, agent_id: 'agent-b' }));
    assert.equal(r1.verdict, 'granted');
    assert.equal(r2.verdict, 'queued');

    await releaseGrant(ws, 'agent-a', r1.grant_id!);

    const { active, queued } = await getGrants(ws);
    assert.equal(active.length, 1);
    assert.equal(active[0].agent_id, 'agent-b');
    assert.equal(queued.length, 0);

    await assertNoActiveOverlap(ws);
  });

  it('3. lease expiry -> queued request is auto-granted (no heartbeat)', async () => {
    const ws = freshWorkspaceId();
    const shortTtl = 150;
    const r1 = await requestGrant(
      req({ workspace_id: ws, agent_id: 'agent-a', ttl_ms: shortTtl })
    );
    const r2 = await requestGrant(req({ workspace_id: ws, agent_id: 'agent-b' }));
    assert.equal(r1.verdict, 'granted');
    assert.equal(r2.verdict, 'queued');

    // Wait past the holder's lease without heartbeating it.
    await sleep(shortTtl + 100);

    // Reading now should show agent-a's grant expired (excluded from active).
    const afterExpiry = await getGrants(ws);
    assert.ok(!afterExpiry.active.some((g) => g.agent_id === 'agent-a'));

    // A fresh request call triggers queue advancement past the freed scope.
    const r3 = await requestGrant(
      req({ workspace_id: ws, agent_id: 'agent-c', scope: { repo: 'r', paths: [], symbols: ['sym:Unrelated'] } })
    );
    assert.equal(r3.verdict, 'granted');

    const { active } = await getGrants(ws);
    assert.ok(active.some((g) => g.agent_id === 'agent-b'), 'queued agent-b should now be active');
    assert.ok(!active.some((g) => g.agent_id === 'agent-a'), 'expired agent-a must not still be active');

    await assertNoActiveOverlap(ws);
  });

  it('4. heartbeat extends the lease and blocks a same-scope takeover', async () => {
    const ws = freshWorkspaceId();
    const shortTtl = 200;
    const r1 = await requestGrant(
      req({ workspace_id: ws, agent_id: 'agent-a', ttl_ms: shortTtl })
    );
    assert.equal(r1.verdict, 'granted');

    // Heartbeat partway through, before expiry.
    await sleep(shortTtl / 2);
    const hb = await heartbeatGrant(ws, r1.grant_id!);
    assert.equal(hb.ok, true);
    assert.ok(hb.lease_expires_at);

    // Now wait past the ORIGINAL expiry time (but within the extended lease).
    await sleep(shortTtl / 2 + 20);

    const { active } = await getGrants(ws);
    assert.ok(
      active.some((g) => g.agent_id === 'agent-a'),
      'heartbeated grant must still be active past its original TTL window'
    );

    // A conflicting request must still queue, not steal the lease.
    const r2 = await requestGrant(req({ workspace_id: ws, agent_id: 'agent-b' }));
    assert.equal(r2.verdict, 'queued');

    // Heartbeat on an unknown/expired grant reports not-ok.
    const hbMissing = await heartbeatGrant(ws, 'grant_does_not_exist');
    assert.equal(hbMissing.ok, false);

    await assertNoActiveOverlap(ws);
  });

  it('5. duplicate request (same agent, same scope) is idempotent', async () => {
    const ws = freshWorkspaceId();
    const r1 = await requestGrant(req({ workspace_id: ws, agent_id: 'agent-a' }));
    const r2 = await requestGrant(req({ workspace_id: ws, agent_id: 'agent-a' }));

    assert.equal(r1.verdict, 'granted');
    assert.equal(r2.verdict, 'granted');
    assert.equal(r2.grant_id, r1.grant_id);

    const { active } = await getGrants(ws);
    assert.equal(active.length, 1);

    await assertNoActiveOverlap(ws);
  });

  it('6. disjoint symbols/paths: both requests granted concurrently', async () => {
    const ws = freshWorkspaceId();
    const r1 = await requestGrant(
      req({ workspace_id: ws, agent_id: 'agent-a', scope: { repo: 'r', paths: ['src/a.ts'], symbols: ['sym:A'] } })
    );
    const r2 = await requestGrant(
      req({ workspace_id: ws, agent_id: 'agent-b', scope: { repo: 'r', paths: ['src/b.ts'], symbols: ['sym:B'] } })
    );

    assert.equal(r1.verdict, 'granted');
    assert.equal(r2.verdict, 'granted');
    assert.notEqual(r1.grant_id, r2.grant_id);

    const { active, queued } = await getGrants(ws);
    assert.equal(active.length, 2);
    assert.equal(queued.length, 0);

    await assertNoActiveOverlap(ws);
  });

  it('8. concurrent requestGrant for overlapping scope never double-grants (real bug repro)', async () => {
    // Real bug: requestGrant's read-active-set -> decide -> append sequence
    // used to take its own `withLock` per internal step (advanceQueue's read,
    // the conflict-check read, the final append), NOT one atomic critical
    // section. Two concurrent requestGrant calls for overlapping scope could
    // each pass the conflict check (both seeing "no conflict yet") before
    // either had appended — both got granted, violating the module's core
    // invariant. Reproduced 100/100 before the fix (unlocked
    // read-decide-append); this asserts it can no longer happen across many
    // trials of a genuine concurrent race (both requests started in the same
    // tick, no ordering constraint between them).
    for (let i = 0; i < 25; i++) {
      const ws = freshWorkspaceId();
      const scope = { repo: 'r', paths: ['src/shared.ts'], symbols: ['sym:Shared'] };
      const [r1, r2] = await Promise.all([
        requestGrant(req({ workspace_id: ws, agent_id: 'agent-race-1', scope, intent: 'race1' })),
        requestGrant(req({ workspace_id: ws, agent_id: 'agent-race-2', scope, intent: 'race2' })),
      ]);
      // Exactly one of the two racing requests must be granted; the other queued.
      const verdicts = [r1.verdict, r2.verdict].sort();
      assert.deepEqual(
        verdicts,
        ['granted', 'queued'],
        `trial ${i}: expected exactly one granted + one queued, got ${JSON.stringify(verdicts)}`
      );
      await assertNoActiveOverlap(ws);
    }
  });

  it('9. releaseGrant is race-safe against a concurrent requestGrant for the same agent', async () => {
    // Second real-world angle on the same root cause: an agent's OWN release
    // racing a fresh claim for a DIFFERENT scope must never corrupt the log
    // (lost update / torn append) — the invariant must hold after every trial.
    for (let i = 0; i < 20; i++) {
      const ws = freshWorkspaceId();
      const r1 = await requestGrant(
        req({ workspace_id: ws, agent_id: 'agent-a', scope: { repo: 'r', paths: [], symbols: ['sym:Foo'] } })
      );
      assert.equal(r1.verdict, 'granted');

      await Promise.all([
        releaseGrant(ws, 'agent-a', r1.grant_id!),
        requestGrant(
          req({ workspace_id: ws, agent_id: 'agent-b', scope: { repo: 'r', paths: [], symbols: ['sym:Bar'] } })
        ),
      ]);

      await assertNoActiveOverlap(ws);
      const { active } = await getGrants(ws);
      // agent-a released; agent-b's disjoint-scope request must have landed granted
      // regardless of interleaving (never lost).
      assert.ok(active.some((g) => g.agent_id === 'agent-b'), `trial ${i}: agent-b's grant must not be lost`);
    }
  });

  it('7. fuzz: interleaved requests/releases never violate the invariant', async () => {
    const ws = freshWorkspaceId();
    const agents = ['agent-a', 'agent-b', 'agent-c', 'agent-d', 'agent-e'];
    const symbolPool = ['sym:X', 'sym:Y', 'sym:Z']; // small pool forces frequent overlap.
    const heldGrants = new Map<string, string>(); // agent_id -> grant_id (their own last grant)

    let seed = 42;
    function rand(): number {
      // deterministic LCG so failures are reproducible.
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    }

    for (let i = 0; i < 60; i++) {
      const agent = agents[Math.floor(rand() * agents.length)];
      const action = rand();

      if (action < 0.6 || !heldGrants.has(agent)) {
        // Request 1-2 symbols from the small pool.
        const nSymbols = 1 + Math.floor(rand() * 2);
        const symbols = Array.from(
          { length: nSymbols },
          () => symbolPool[Math.floor(rand() * symbolPool.length)]
        );
        const result = await requestGrant(
          req({
            workspace_id: ws,
            agent_id: agent,
            scope: { repo: 'r', paths: [], symbols: [...new Set(symbols)] },
            ttl_ms: 60_000,
          })
        );
        if (result.verdict === 'granted' && result.grant_id) {
          heldGrants.set(agent, result.grant_id);
        }
      } else {
        const grantId = heldGrants.get(agent);
        if (grantId) {
          await releaseGrant(ws, agent, grantId);
          heldGrants.delete(agent);
        }
      }

      // The invariant must hold after every single operation.
      await assertNoActiveOverlap(ws);
    }
  });
});
