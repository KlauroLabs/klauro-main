import test from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildEventsBlock, claimFootprint, drainEventsForClaim, DEFAULT_EVENTS_CAP } from './event-drain';
import {
  __clearCachesForTests,
  appendClaim,
  getActiveClaims,
  getBoardInfo,
  persistSurprise,
  readClaimLog,
} from './local-store';
import type { ClaimLogEntry } from './local-store';
import type { WorkClaim } from './types';

async function freshCoordDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'klauro-drain-test-'));
  process.env.KLAURO_COORD_DIR = dir;
  __clearCachesForTests?.();
  return dir;
}

const META = { epoch: 'epoch_test', min_retained_seq: 1 };

function claim(overrides: Partial<WorkClaim> = {}): WorkClaim {
  const now = new Date().toISOString();
  return {
    claim_id: 'ws:me',
    seq: 1,
    workspace_id: 'ws',
    agent_id: 'me',
    agent_kind: 'claude',
    scope: { repo: 'ws', paths: ['src/mine/'], symbols: [] },
    intent: 'my work',
    status: 'active',
    created_at: now,
    ttl_ms: 60_000,
    heartbeat_at: now,
    ...overrides,
  };
}

function entry(overrides: Partial<ClaimLogEntry> = {}): ClaimLogEntry {
  const now = new Date().toISOString();
  return {
    claim_id: 'ws:other',
    seq: 2,
    workspace_id: 'ws',
    agent_id: 'other',
    agent_kind: 'claude',
    scope: { repo: 'ws', paths: ['src/mine/thing.ts'], symbols: [] },
    intent: 'their work',
    status: 'active',
    created_at: now,
    ttl_ms: 60_000,
    heartbeat_at: now,
    logged_at: now,
    ...overrides,
  };
}

test('events block is ABSENT when there is nothing to say', () => {
  const block = buildEventsBlock({ log: [], claim: claim(), meta: META, since_seq: 0 });
  assert.equal(block, undefined);
});

test('an active claim auto-subscribes to footprint-overlap events with no registration step', () => {
  const block = buildEventsBlock({ log: [entry()], claim: claim(), meta: META, since_seq: 0 })!;
  assert.equal(block.entries.length, 1);
  assert.equal(block.entries[0].reason, 'footprint_overlap');
  assert.equal(block.epoch, META.epoch);
  assert.equal(block.truncated, false);
});

test('a claim never drains its own writes, nor events outside its footprint', () => {
  const mine = entry({ claim_id: 'ws:me', agent_id: 'me', seq: 3 });
  const elsewhere = entry({ claim_id: 'ws:far', agent_id: 'far', seq: 4, scope: { repo: 'ws', paths: ['docs/'], symbols: [] } });
  assert.equal(buildEventsBlock({ log: [mine, elsewhere], claim: claim(), meta: META, since_seq: 0 }), undefined);
});

test('contracts are footprint: an event naming a contract I produce or consume reaches me', () => {
  const me = claim({
    scope: { repo: 'ws', paths: [], symbols: [] },
    produces: [{ kind: 'export', name: 'getUser', path: 'src/user.ts' }],
    consumes: ['buildOutcome'],
  });
  const fp = claimFootprint(me);
  assert.ok(fp.tokens.has('getUser') && fp.tokens.has('buildOutcome'));
  assert.ok(fp.paths.includes('src/user.ts'));

  const peer = entry({ scope: { repo: 'ws', paths: [], symbols: ['buildOutcome'] } });
  const block = buildEventsBlock({ log: [peer], claim: me, meta: META, since_seq: 0 })!;
  assert.equal(block.entries.length, 1);
});

test('addressed surprises outrank overlap events and survive the cap', () => {
  const overlaps = Array.from({ length: DEFAULT_EVENTS_CAP + 5 }, (_, i) =>
    entry({ claim_id: `ws:other${i}`, agent_id: `other${i}`, seq: 10 + i })
  );
  const surprise = entry({
    claim_id: 'surprise:1',
    agent_id: 'me',
    seq: 99,
    kind: 'surprise',
    status: 'released',
    surprise: { symbol: 'getUser', changer: 'other', affected: 'me', explanation: 'drifted' },
  });
  const block = buildEventsBlock({ log: [...overlaps, surprise], claim: claim(), meta: META, since_seq: 0 })!;
  assert.equal(block.entries.length, DEFAULT_EVENTS_CAP);
  assert.equal(block.entries[0].reason, 'addressed');
  assert.equal(block.entries[0].surprise?.explanation, 'drifted');
});

test('a burst is strictly capped and resumable — nothing skipped for the cap is lost', () => {
  const log = Array.from({ length: 25 }, (_, i) => entry({ claim_id: `ws:o${i}`, agent_id: `o${i}`, seq: i + 1 }));
  const first = buildEventsBlock({ log, claim: claim({ seq: 0 }), meta: META, since_seq: 0, cap: 10 })!;
  assert.equal(first.entries.length, 10);
  assert.equal(first.truncated, true);
  assert.equal(first.resume_seq, 10, 'resume just below the lowest undelivered match');

  const second = buildEventsBlock({ log, claim: claim({ seq: 0 }), meta: META, since_seq: first.resume_seq, cap: 10 })!;
  assert.equal(second.entries[0].seq, 11, 'the next drain continues exactly where the first stopped');

  const third = buildEventsBlock({ log, claim: claim({ seq: 0 }), meta: META, since_seq: second.resume_seq, cap: 10 })!;
  assert.equal(third.truncated, false);
  assert.equal(third.entries.length, 5);
  assert.equal(third.resume_seq, 25, 'a drained board resumes at max_seq, not at the last match');
  assert.equal(buildEventsBlock({ log, claim: claim({ seq: 0 }), meta: META, since_seq: third.resume_seq }), undefined);
});

test('§7.2a: a cursor below the retention floor gets an explicit gap notice, never silence', () => {
  const block = buildEventsBlock({
    log: [],
    claim: claim(),
    meta: { epoch: 'epoch_test', min_retained_seq: 500 },
    since_seq: 10,
  })!;
  assert.ok(block, 'a gap must produce a block even with zero deliverable entries');
  assert.match(block.gap_notice!, /missed events|no longer be replayed/i);
  assert.equal(block.entries.length, 0);
});

test('§7: a cursor from another epoch is a gap, not a silently-wrong replay', () => {
  const log = [entry({ seq: 7 })];
  const block = buildEventsBlock({
    log,
    claim: claim({ seq: 100 }),
    meta: META,
    since_seq: 100,
    since_epoch: 'epoch_from_a_restored_backup',
  })!;
  assert.match(block.gap_notice!, /epoch/);
  assert.equal(block.entries.length, 1, 'delivery restarts from the retention floor rather than trusting a dead cursor');
  assert.equal(block.epoch, META.epoch);
});

test('drainEventsForClaim delivers a real surprise off a real board, and no claim means no drain', async () => {
  await freshCoordDir();
  const now = new Date().toISOString();
  await appendClaim('ws', {
    claim_id: 'ws:me',
    workspace_id: 'ws',
    agent_id: 'me',
    agent_kind: 'claude',
    scope: { repo: 'ws', paths: ['src/mine/'], symbols: [] },
    intent: 'mine',
    status: 'active',
    created_at: now,
    ttl_ms: 60_000,
    heartbeat_at: now,
  });
  const [mine] = await getActiveClaims('ws');
  await persistSurprise('ws', {
    symbol: 'getUser',
    changer: 'other',
    affected: 'me',
    explanation: 'declared (id: string) => User, observed (id: number) => User',
    contract: 'getUser',
    reason: 'declared_contract_drift',
  });

  const block = await drainEventsForClaim('ws', mine, { since_seq: mine.seq });
  assert.ok(block, 'the surprise reaches its addressee with no subscription registered');
  assert.equal(block!.entries[0].reason, 'addressed');
  assert.equal(block!.entries[0].surprise?.contract, 'getUser');
  const board = await getBoardInfo('ws');
  assert.equal(block!.epoch, board.epoch);

  // Idempotent re-read at the same cursor; advancing the cursor drains it.
  const again = await drainEventsForClaim('ws', mine, { since_seq: block!.resume_seq });
  assert.equal(again, undefined);
  assert.ok((await readClaimLog('ws')).some((e) => e.kind === 'surprise'));
});
