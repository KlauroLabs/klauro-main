/**
 * Compaction delivery floor (Coordination Engine wave 1, item 3) — lives in
 * its own test FILE because COMPACT_THRESHOLD_ENTRIES / COMPACT_KEEP_RELEASED
 * are read from the environment at module load, and node:test runs each test
 * file in its own process: setting the env BEFORE the dynamic import below is
 * the only way to exercise compaction without appending 500+ entries.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { WorkClaim } from './types';

process.env.KLAURO_COORD_COMPACT_THRESHOLD = '20';
process.env.KLAURO_COORD_COMPACT_KEEP_RELEASED = '3';

// Dynamic import AFTER the env is set (the constants are read at module load).
// A promise rather than top-level await because tsx compiles this file as CJS.
const storePromise = import('./local-store');

async function freshCoordDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'klauro-coord-compact-test-'));
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
    scope: { repo: 'proof-of-concept', paths: ['src/foo.ts'], symbols: [] },
    intent: 'work',
    status: 'active',
    created_at: now,
    ttl_ms: 60_000,
    heartbeat_at: now,
    ...overrides,
  };
}

/** Append `n` claim+release pairs under distinct claim_ids (pure churn fodder). */
async function churn(n: number, prefix: string): Promise<void> {
  const store = await storePromise;
  for (let i = 0; i < n; i++) {
    const id = `${prefix}-${i}`;
    await store.appendClaim('ws-test', makeClaim({ claim_id: id, agent_id: `churn-${prefix}-${i}` }));
    await store.appendClaim('ws-test', makeClaim({ claim_id: id, agent_id: `churn-${prefix}-${i}`, status: 'released' }));
  }
}

test('compaction floor: min_retained_seq advances past evicted entries and stale cursors get a gap notice', async () => {
  const store = await storePromise;
  const dir = await freshCoordDir();

  await churn(15, 'wave1'); // 30 entries > threshold 20 → next locked write compacts.
  await store.appendClaim('ws-test', makeClaim({ claim_id: 'trigger', agent_id: 'agent-live' }));

  const board = await store.getBoardInfo('ws-test');
  assert.ok(board.min_retained_seq > 1, `compaction must raise the retention floor (got ${board.min_retained_seq})`);

  const log = await store.readClaimLog('ws-test');
  const maxSeq = log.reduce((m, e) => Math.max(m, e.seq), 0);
  // The floor never overpromises: the entry AT the floor (if the floor is not
  // past the whole log) is genuinely present, and the floor is never beyond
  // max_seq + 1.
  assert.ok(board.min_retained_seq <= maxSeq + 1, 'floor stays within the log');
  assert.ok(
    log.some((e) => e.seq >= board.min_retained_seq),
    'entries at/above the floor are actually retained'
  );

  // A reader resuming from a pre-compaction cursor is TOLD it missed events — never silence.
  const gap = store.describeCursorGap(1, board);
  assert.ok(gap && gap.includes('missed events'), 'stale cursor gets an explicit gap notice');
  assert.equal(store.describeCursorGap(board.min_retained_seq, board), undefined, 'a cursor at the floor is safe');

  await fsp.rm(dir, { recursive: true, force: true });
});

test('compaction protects surprises addressed to agents with active claims, bounded by claim TTL', async () => {
  const store = await storePromise;
  const dir = await freshCoordDir();

  // The addressee holds a live claim → its surprise must survive compaction.
  await store.appendClaim('ws-test', makeClaim({ claim_id: 'ws-test:addressee', agent_id: 'addressee', ttl_ms: 60_000 }));
  const detail = { symbol: 'fooHandler', changer: 'agent-x', affected: 'addressee', explanation: 'contract changed under you' };
  const persisted = await store.persistSurprise('ws-test', detail);
  assert.ok(persisted, 'surprise persists');

  await churn(15, 'waveA');
  await store.appendClaim('ws-test', makeClaim({ claim_id: 'trigger-a', agent_id: 'agent-live' }));

  let surprises = await store.readSurprisesFor('ws-test', 'addressee');
  assert.equal(surprises.length, 1, 'an addressed, undelivered-in-the-worst-case surprise is compaction-protected while the addressee is active');

  // Protection is BOUNDED BY CLAIM TTL: once the addressee's claims are gone,
  // the surprise becomes evictable churn again.
  await store.releaseAgent('ws-test', 'addressee');
  await store.appendClaim('ws-test', makeClaim({ claim_id: 'trigger-b', agent_id: 'agent-live-2' }));
  await churn(15, 'waveB');
  await store.appendClaim('ws-test', makeClaim({ claim_id: 'trigger-c', agent_id: 'agent-live-3' }));

  surprises = await store.readSurprisesFor('ws-test', 'addressee');
  assert.equal(surprises.length, 0, 'once the addressee has no active claim, the surprise is evictable');

  // DEDUP CONSISTENT WITH THE FLOOR: re-persisting the SAME evicted finding is
  // a no-op — eviction must not cause an append→evict→re-append loop.
  const reAppend = await store.persistSurprise('ws-test', detail);
  assert.equal(reAppend, null, 'an evicted surprise still dedupes via the board meta, never re-appended');

  await fsp.rm(dir, { recursive: true, force: true });
});
