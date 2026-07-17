import test from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  appendClaim,
  extendClaim,
  getActiveClaims,
  planScopedGitOp,
  warnIfTreeGlobalOp,
} from './local-store';
import type { WorkClaim } from './types';

/**
 * W6/W7 tests (SPEC-COORDINATION-FABRIC-V3 §6.3/§8): scoped git-op primitives
 * (`planScopedGitOp`, `warnIfTreeGlobalOp`) and mid-task claim extension
 * (`extendClaim`). Direct answer to two real incidents in §6.3: a tree-global
 * `git stash` sweeping a peer's uncommitted work, and an agent needing to touch
 * files outside its declared claim with no affordance to say so.
 */
async function freshCoordDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'klauro-coord-scoped-test-'));
  process.env.KLAURO_COORD_DIR = dir;
  return dir;
}

function makeClaim(overrides: Partial<WorkClaim> = {}): Omit<WorkClaim, 'seq'> {
  const now = new Date().toISOString();
  return {
    claim_id: 'claim-a',
    workspace_id: 'ws-scoped',
    agent_id: 'agent-a',
    agent_kind: 'claude',
    scope: { repo: 'poc', paths: ['src/a.ts'], symbols: ['aHandler'] },
    intent: 'work on a',
    status: 'active',
    created_at: now,
    ttl_ms: 60_000,
    heartbeat_at: now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// planScopedGitOp
// ---------------------------------------------------------------------------

test('planScopedGitOp returns only the calling agent own claim paths', async () => {
  const dir = await freshCoordDir();
  await appendClaim('ws-scoped', makeClaim({ claim_id: 'claim-a', agent_id: 'agent-a', scope: { repo: 'poc', paths: ['src/a.ts', 'src/a2.ts'], symbols: [] } }));
  await appendClaim('ws-scoped', makeClaim({ claim_id: 'claim-b', agent_id: 'agent-b', scope: { repo: 'poc', paths: ['src/b.ts'], symbols: [] } }));

  const plan = await planScopedGitOp('ws-scoped', 'agent-a');
  assert.deepEqual([...plan.paths].sort(), ['src/a.ts', 'src/a2.ts']);
  assert.equal(plan.peers.length, 1);
  assert.equal(plan.peers[0].agent_id, 'agent-b');

  await fsp.rm(dir, { recursive: true, force: true });
});

test('planScopedGitOp is empty for an agent with no active claim, and still reports peers', async () => {
  const dir = await freshCoordDir();
  await appendClaim('ws-scoped', makeClaim({ claim_id: 'claim-b', agent_id: 'agent-b', scope: { repo: 'poc', paths: ['src/b.ts'], symbols: [] } }));

  const plan = await planScopedGitOp('ws-scoped', 'agent-a');
  assert.deepEqual(plan.paths, []);
  assert.equal(plan.peers.length, 1);
  assert.equal(plan.peers[0].agent_id, 'agent-b');

  await fsp.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// warnIfTreeGlobalOp
// ---------------------------------------------------------------------------

test('warnIfTreeGlobalOp does not fire when no other agent is active', async () => {
  const dir = await freshCoordDir();
  await appendClaim('ws-scoped', makeClaim({ agent_id: 'agent-a' }));

  const messages: string[] = [];
  const result = await warnIfTreeGlobalOp('ws-scoped', 'agent-a', { print: (m) => messages.push(m) });
  assert.deepEqual(result.peers, []);
  assert.equal(messages.length, 0);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('warnIfTreeGlobalOp fires and names the peer when another agent is active', async () => {
  const dir = await freshCoordDir();
  await appendClaim('ws-scoped', makeClaim({ claim_id: 'claim-a', agent_id: 'agent-a' }));
  await appendClaim('ws-scoped', makeClaim({ claim_id: 'claim-b', agent_id: 'agent-b', scope: { repo: 'poc', paths: ['src/b.ts'], symbols: [] }, intent: 'fix bug' }));

  const messages: string[] = [];
  const result = await warnIfTreeGlobalOp('ws-scoped', 'agent-a', { print: (m) => messages.push(m) });
  assert.equal(result.peers.length, 1);
  assert.equal(result.peers[0].agent_id, 'agent-b');
  assert.equal(messages.length, 1);
  assert.match(messages[0], /agent-b/);
  assert.match(messages[0], /fix bug/);
  assert.match(messages[0], /src\/b\.ts/);

  await fsp.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// extendClaim
// ---------------------------------------------------------------------------

test('extendClaim unions scope and preserves claim identity', async () => {
  const dir = await freshCoordDir();
  const initial = await appendClaim('ws-scoped', makeClaim({ claim_id: 'claim-a', agent_id: 'agent-a', intent: 'fix the bug' }));

  const outcome = await extendClaim('ws-scoped', 'claim-a', ['src/extra.ts'], ['extraFn']);
  assert.equal(outcome.claim.claim_id, 'claim-a'); // same claim_id — identity preserved, not a new claim
  assert.equal(outcome.claim.agent_id, 'agent-a');
  assert.equal(outcome.claim.intent, 'fix the bug'); // intent carried over verbatim
  assert.equal(outcome.claim.created_at, initial.created_at); // original creation time preserved
  assert.ok(outcome.claim.seq > initial.seq); // a NEW log entry (LWW-supersedes), not a mutation
  assert.deepEqual([...outcome.claim.scope.paths].sort(), ['src/a.ts', 'src/extra.ts']); // union, old scope kept
  assert.deepEqual(outcome.claim.scope.symbols, ['aHandler', 'extraFn']);
  assert.deepEqual(outcome.conflicts, []);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('extendClaim surfaces (never denies) an overlap conflict on the newly added scope', async () => {
  const dir = await freshCoordDir();
  await appendClaim('ws-scoped', makeClaim({ claim_id: 'claim-a', agent_id: 'agent-a' }));
  await appendClaim('ws-scoped', makeClaim({ claim_id: 'claim-b', agent_id: 'agent-b', scope: { repo: 'poc', paths: ['src/shared.ts'], symbols: [] } }));

  const outcome = await extendClaim('ws-scoped', 'claim-a', ['src/shared.ts'], []);
  // The extension always succeeds — the new path IS in scope now.
  assert.ok(outcome.claim.scope.paths.includes('src/shared.ts'));
  // But the overlap is surfaced, not silently absorbed.
  assert.equal(outcome.conflicts.length, 1);
  assert.equal(outcome.conflicts[0].agent_id, 'agent-b');
  assert.deepEqual(outcome.conflicts[0].overlapping_paths, ['src/shared.ts']);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('extendClaim does not re-flag the PRIOR scope as a conflict, only newly added paths', async () => {
  const dir = await freshCoordDir();
  await appendClaim('ws-scoped', makeClaim({ claim_id: 'claim-a', agent_id: 'agent-a', scope: { repo: 'poc', paths: ['src/a.ts'], symbols: [] } }));
  // agent-b overlaps agent-a's ORIGINAL scope (src/a.ts), not the new path.
  await appendClaim('ws-scoped', makeClaim({ claim_id: 'claim-b', agent_id: 'agent-b', scope: { repo: 'poc', paths: ['src/a.ts'], symbols: [] } }));

  const outcome = await extendClaim('ws-scoped', 'claim-a', ['src/new-only.ts'], []);
  assert.deepEqual(outcome.conflicts, []); // the added scope (src/new-only.ts) doesn't overlap anyone

  await fsp.rm(dir, { recursive: true, force: true });
});

test('extendClaim throws a clear error for a claim_id with no ACTIVE claim', async () => {
  const dir = await freshCoordDir();
  await assert.rejects(
    () => extendClaim('ws-scoped', 'claim-nonexistent', ['src/x.ts'], []),
    /no ACTIVE claim "claim-nonexistent"/
  );

  await fsp.rm(dir, { recursive: true, force: true });
});

test('extendClaim throws for a claim that was already released', async () => {
  const dir = await freshCoordDir();
  const now = new Date().toISOString();
  await appendClaim('ws-scoped', makeClaim({ claim_id: 'claim-a', agent_id: 'agent-a' }));
  await appendClaim('ws-scoped', makeClaim({ claim_id: 'claim-a', agent_id: 'agent-a', status: 'released', heartbeat_at: now }));

  await assert.rejects(
    () => extendClaim('ws-scoped', 'claim-a', ['src/x.ts'], []),
    /no ACTIVE claim "claim-a"/
  );

  await fsp.rm(dir, { recursive: true, force: true });
});

test('extendClaim is race-safe: two concurrent extends on the same claim_id both take effect, neither silently drops', async () => {
  const dir = await freshCoordDir();
  await appendClaim('ws-scoped', makeClaim({ claim_id: 'claim-a', agent_id: 'agent-a', scope: { repo: 'poc', paths: ['src/a.ts'], symbols: [] } }));

  const [r1, r2] = await Promise.all([
    extendClaim('ws-scoped', 'claim-a', ['src/x.ts'], []),
    extendClaim('ws-scoped', 'claim-a', ['src/y.ts'], []),
  ]);
  // Both calls succeed (never denied) and get distinct monotonic seqs — the
  // per-workspace lock serializes them into a strict order, it never merges
  // two concurrent appends into one lost update.
  assert.notEqual(r1.claim.seq, r2.claim.seq);
  // Because each extend re-reads the log fresh under the lock, the SECOND to
  // actually acquire the lock sees the FIRST's already-applied extension —
  // so the final active claim (highest seq in the log) must carry the union
  // of the original scope AND both concurrent additions. Nothing is lost.
  const [active] = await getActiveClaims('ws-scoped');
  assert.ok(active.scope.paths.includes('src/a.ts'));
  assert.ok(active.scope.paths.includes('src/x.ts'));
  assert.ok(active.scope.paths.includes('src/y.ts'));

  await fsp.rm(dir, { recursive: true, force: true });
});
