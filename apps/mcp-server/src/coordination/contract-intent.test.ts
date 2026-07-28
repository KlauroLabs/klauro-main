import test from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { detectDeclaredContractDrift } from './collision';
import {
  attributeChangesToClaim,
  contractIdentity,
  deriveObservedConsumes,
  deriveObservedProduces,
  derivePhase,
  derivePhaseFromClaim,
  isExplorationClaim,
  matchContract,
  mergeContracts,
  MAX_CONTRACT_TEXT,
} from './contract-intent';
import {
  __clearCachesForTests,
  appendClaim,
  extendClaim,
  getActiveClaims,
  persistContractDriftSurprises,
  readSurprisesFor,
  recordDerivedContracts,
} from './local-store';
import type { SymbolChange } from './conceptual-conflict';
import type { DeclaredContract, WorkClaim } from './types';

async function freshCoordDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'klauro-contract-test-'));
  process.env.KLAURO_COORD_DIR = dir;
  __clearCachesForTests?.();
  return dir;
}

function claim(overrides: Partial<WorkClaim> = {}): Omit<WorkClaim, 'seq'> {
  const now = new Date().toISOString();
  return {
    claim_id: 'ws:a',
    workspace_id: 'ws',
    agent_id: 'a',
    agent_kind: 'claude',
    scope: { repo: 'ws', paths: ['src/'], symbols: [] },
    intent: 'work',
    status: 'active',
    created_at: now,
    ttl_ms: 60_000,
    heartbeat_at: now,
    ...overrides,
  };
}

function change(overrides: Partial<SymbolChange> = {}): SymbolChange {
  return {
    symbol_id: 'sym:src/user.ts:getUser',
    name: 'getUser',
    file: 'src/user.ts',
    change_kind: 'signature',
    after: { signature: '(id: string) => User' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Identity + matching (§3: identity is (kind, name, path?))
// ---------------------------------------------------------------------------

test('contract identity is (kind, name, path?) and path-qualified matching beats name-only', () => {
  const a: DeclaredContract = { kind: 'export', name: 'getUser', path: 'src/user.ts' };
  const b: DeclaredContract = { kind: 'export', name: 'getUser', path: 'src/legacy/user.ts' };
  assert.notEqual(contractIdentity(a), contractIdentity(b));

  const qualified = matchContract({ name: 'getUser', path: 'src/user.ts' }, [a, b]);
  assert.equal(qualified.length, 1);
  assert.equal(qualified[0].confidence, 'path_qualified');

  const nameOnly = matchContract({ name: 'getUser' }, [a, b]);
  assert.equal(nameOnly.length, 2);
  assert.ok(nameOnly.every((m) => m.confidence === 'name_only' && m.ambiguous));
});

test('explicit declaration wins over observation for the same identity, both stay labeled', () => {
  const declared: DeclaredContract = { kind: 'export', name: 'getUser', path: 'src/user.ts', notes: 'throws on empty' };
  const observed: DeclaredContract = {
    kind: 'export',
    name: 'getUser',
    path: 'src/user.ts',
    signature: '(id: string) => User',
    status: 'observed',
  };
  const merged = mergeContracts([declared], [observed]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, 'declared', 'declaration is intent and must win');
  assert.equal(merged[0].notes, 'throws on empty');
  assert.equal(merged[0].signature, '(id: string) => User', 'the observed shape fills the gap the declaration left');

  const onlyObserved = mergeContracts([], [{ kind: 'type', name: 'User', status: 'observed' }]);
  assert.equal(onlyObserved[0].status, 'observed');
});

test('oversized signatures are truncated with a marker, never silently (§14 per-entry caps)', () => {
  const huge = 'x'.repeat(MAX_CONTRACT_TEXT * 3);
  const [merged] = mergeContracts([{ kind: 'signature', name: 'big', signature: huge }]);
  assert.ok(merged.signature!.length <= MAX_CONTRACT_TEXT);
  assert.ok(merged.signature!.includes('truncated'));
});

// ---------------------------------------------------------------------------
// Auto-derivation (§3 — the adoption fix)
// ---------------------------------------------------------------------------

test('observed produces are auto-lifted from ambient SymbolChange[]; body edits and unparsed files are not', () => {
  const produces = deriveObservedProduces([
    change(),
    change({ symbol_id: 'sym:src/x.ts:helper', name: 'helper', file: 'src/x.ts', change_kind: 'body' }),
    change({ symbol_id: 'sym:src/x.rb:__file__', name: 'x.rb', file: 'src/x.rb', change_kind: 'body' }),
    change({ symbol_id: 'sym:src/new.ts:makeThing', name: 'makeThing', file: 'src/new.ts', change_kind: 'add' }),
  ]);
  const names = produces.map((p) => p.name).sort();
  assert.deepEqual(names, ['getUser', 'makeThing']);
  assert.ok(produces.every((p) => p.status === 'observed'));
  assert.equal(produces.find((p) => p.name === 'getUser')!.signature, '(id: string) => User');
});

test('observed consumes are auto-recorded when a diff references a peer contract, excluding self-produced', () => {
  const peers = [
    {
      agent_id: 'b',
      claim_id: 'ws:b',
      contracts: [
        { kind: 'export' as const, name: 'getUser', path: 'src/user.ts' },
        { kind: 'export' as const, name: 'unrelated', path: 'src/other.ts' },
      ],
    },
  ];
  const result = deriveObservedConsumes(
    {
      changes: [change({ symbol_id: 'sym:src/page.ts:render', name: 'render', file: 'src/page.ts', change_kind: 'body' })],
      addedTextByFile: { 'src/page.ts': "import { getUser } from './user';\nconst u = getUser(id);" },
    },
    peers
  );
  assert.deepEqual(result.names, ['getUser']);
  assert.equal(result.edges[0].producer_agent_id, 'b');

  const selfProduced = deriveObservedConsumes(
    { changes: [change()], addedTextByFile: { 'src/user.ts': 'getUser(id)' } },
    peers,
    [{ kind: 'export', name: 'getUser', path: 'src/user.ts' }]
  );
  assert.deepEqual(selfProduced.names, [], 'a lane does not consume what it produces');
});

test('consumes matching is token-bounded (getUser does not match getUserProfile)', () => {
  const peers = [{ agent_id: 'b', claim_id: 'ws:b', contracts: [{ kind: 'export' as const, name: 'getUser' }] }];
  const result = deriveObservedConsumes(
    { changes: [change({ change_kind: 'body' })], addedTextByFile: { 'src/user.ts': 'getUserProfile(id)' } },
    peers
  );
  assert.deepEqual(result.names, []);
});

test('§13: a change two active claims both cover is attributed to NOBODY (shared-tree degradation)', () => {
  const mine = { scope: { paths: ['src/'], symbols: [] } };
  const other = { scope: { paths: ['src/user.ts'], symbols: [] } };
  const contested = change();
  const solo = change({ symbol_id: 'sym:src/only.ts:f', name: 'f', file: 'src/only.ts' });

  const { mine: attributed, shared } = attributeChangesToClaim([contested, solo], mine, [other]);
  assert.deepEqual(attributed.map((c) => c.name), ['f']);
  assert.deepEqual(shared.map((c) => c.name), ['getUser']);

  const pathless = attributeChangesToClaim([contested], { scope: { paths: [], symbols: [] } }, []);
  assert.deepEqual(pathless.mine, [], 'a path-less claim is credited with nothing');
});

test('recordDerivedContracts writes observed contracts onto the active claim and no-ops when nothing is new', async () => {
  await freshCoordDir();
  await appendClaim('ws', claim());
  const observed: DeclaredContract[] = [
    { kind: 'export', name: 'getUser', path: 'src/user.ts', signature: '(id: string) => User', status: 'observed' },
  ];

  const first = await recordDerivedContracts('ws', 'a', { produces: observed, consumes: ['peerThing'] });
  assert.ok(first, 'first observation appends');
  const [active] = await getActiveClaims('ws');
  assert.equal(active.produces?.length, 1);
  assert.equal(active.produces?.[0].status, 'observed');
  assert.deepEqual(active.consumes, ['peerThing']);
  assert.equal(active.claim_id, 'ws:a', 'claim identity is preserved, not replaced');

  const second = await recordDerivedContracts('ws', 'a', { produces: observed, consumes: ['peerThing'] });
  assert.equal(second, null, 're-observing the same facts must not spam the log');

  const noClaim = await recordDerivedContracts('ws', 'ghost', { produces: observed });
  assert.equal(noClaim, null, 'observation attaches to a claim or not at all');
});

test('extendClaim preserves the contract board and merges additions', async () => {
  await freshCoordDir();
  await appendClaim(
    'ws',
    claim({ produces: [{ kind: 'export', name: 'getUser', path: 'src/user.ts', status: 'declared' }], consumes: ['x'] })
  );
  const { claim: extended } = await extendClaim('ws', 'ws:a', ['src/new/'], [], {
    produces: [{ kind: 'type', name: 'User', path: 'src/types.ts', status: 'declared' }],
    consumes: ['y'],
  });
  assert.deepEqual(extended.produces?.map((p) => p.name).sort(), ['User', 'getUser']);
  assert.deepEqual(extended.consumes?.sort(), ['x', 'y']);
  assert.ok(extended.scope.paths.includes('src/new/'));
});

// ---------------------------------------------------------------------------
// Drift (§3 — divergence auto-fires a surprise at the recorded consumers)
// ---------------------------------------------------------------------------

test('declared-contract drift fires only at claims that recorded a consumes edge', () => {
  const producer = claim({
    claim_id: 'ws:a',
    agent_id: 'a',
    produces: [{ kind: 'export', name: 'getUser', path: 'src/user.ts', signature: '(id: string) => User' }],
  }) as WorkClaim;
  const consumer = claim({ claim_id: 'ws:b', agent_id: 'b', consumes: ['getUser'] }) as WorkClaim;
  const bystander = claim({ claim_id: 'ws:c', agent_id: 'c' }) as WorkClaim;

  const drifted = detectDeclaredContractDrift(
    producer,
    [producer, consumer, bystander],
    [change({ after: { signature: '(id: string, opts: Opts) => User | null' } })]
  );
  assert.equal(drifted.length, 1);
  assert.equal(drifted[0].consumer_agent_id, 'b');
  assert.equal(drifted[0].reason, 'declared_contract_drift');
  assert.equal(drifted[0].confidence, 'path_qualified');

  const honored = detectDeclaredContractDrift(producer, [producer, consumer], [change()]);
  assert.deepEqual(honored, [], 'a diff matching the declaration is not drift');
});

test('drift is signature-shaped only: a body-only edit behind an unchanged signature fires nothing', () => {
  const producer = claim({
    produces: [{ kind: 'export', name: 'getUser', path: 'src/user.ts', signature: '(id: string) => User' }],
  }) as WorkClaim;
  const consumer = claim({ claim_id: 'ws:b', agent_id: 'b', consumes: ['getUser'] }) as WorkClaim;
  const bodyOnly = change({ change_kind: 'body', after: { signature: '(id: string) => User' } });
  assert.deepEqual(detectDeclaredContractDrift(producer, [producer, consumer], [bodyOnly]), []);
});

test('a declared contract never produced is only a finding once the producer RELEASES', () => {
  const consumer = claim({ claim_id: 'ws:b', agent_id: 'b', consumes: ['buildOutcome'] }) as WorkClaim;
  const declaring = claim({ produces: [{ kind: 'export', name: 'buildOutcome', path: 'src/o.ts' }] }) as WorkClaim;
  assert.deepEqual(
    detectDeclaredContractDrift(declaring, [declaring, consumer], []),
    [],
    'mid-flight, "not written yet" is the normal state of a declaration'
  );

  const released = { ...declaring, status: 'released' as const };
  const findings = detectDeclaredContractDrift(released, [released, consumer], []);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].reason, 'declared_contract_missing');
});

test('name-only drift matches are delivered but explicitly labeled lower confidence', () => {
  const producer = claim({
    produces: [{ kind: 'export', name: 'getUser', path: 'src/user.ts', signature: '(id: string) => User' }],
  }) as WorkClaim;
  const consumer = claim({ claim_id: 'ws:b', agent_id: 'b', consumes: ['getUser'] }) as WorkClaim;
  const elsewhere = change({ file: 'src/other/user.ts', after: { signature: '() => void' } });
  const [finding] = detectDeclaredContractDrift(producer, [producer, consumer], [elsewhere]);
  assert.equal(finding.confidence, 'name_only');
  assert.match(finding.explanation, /LOWER CONFIDENCE/);
});

test('a drift surprise reaches the recorded consumer through the claim log, and dedupes', async () => {
  await freshCoordDir();
  const producer = claim({
    produces: [{ kind: 'export', name: 'getUser', path: 'src/user.ts', signature: '(id: string) => User' }],
  }) as WorkClaim;
  const consumer = claim({ claim_id: 'ws:b', agent_id: 'b', consumes: ['getUser'] }) as WorkClaim;
  await appendClaim('ws', producer);
  await appendClaim('ws', consumer);

  const findings = detectDeclaredContractDrift(
    producer,
    [producer, consumer],
    [change({ after: { signature: '(id: number) => User' } })]
  );
  const persisted = await persistContractDriftSurprises('ws', findings);
  assert.equal(persisted.length, 1);

  const delivered = await readSurprisesFor('ws', 'b');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].contract, 'getUser');
  assert.equal(delivered[0].reason, 'declared_contract_drift');
  assert.equal(delivered[0].changer, 'a');
  assert.deepEqual(await readSurprisesFor('ws', 'c'), [], 'non-consumers are not spammed');

  await persistContractDriftSurprises('ws', findings);
  assert.equal((await readSurprisesFor('ws', 'b')).length, 1, 're-detecting the same fact must dedupe');
});

// ---------------------------------------------------------------------------
// Derived phase + path-less claims
// ---------------------------------------------------------------------------

test('phase is derived from evidence, never declared', () => {
  assert.equal(derivePhase({ changes: [] }), 'exploring');
  assert.equal(derivePhase({ changes: [change()] }), 'building');
  assert.equal(
    derivePhase({ changes: [change({ file: 'src/user.test.ts' })] }),
    'verifying'
  );

  assert.equal(derivePhaseFromClaim({}), 'exploring');
  assert.equal(
    derivePhaseFromClaim({ produces: [{ kind: 'export', name: 'x', path: 'src/x.ts' }] }),
    'exploring',
    'a declaration is intent, not an edit'
  );
  assert.equal(
    derivePhaseFromClaim({ produces: [{ kind: 'export', name: 'x', path: 'src/x.ts', status: 'observed' }] }),
    'building'
  );
  assert.equal(
    derivePhaseFromClaim({ produces: [{ kind: 'export', name: 'x', path: 'src/x.test.ts', status: 'observed' }] }),
    'verifying'
  );
});

test('a path-less claim is representable, visible, and distinguishable from a localized one', async () => {
  await freshCoordDir();
  const arriving = claim({ claim_id: 'ws:explorer', agent_id: 'explorer', scope: { repo: 'ws', paths: [], symbols: [] } });
  await appendClaim('ws', arriving);

  const active = await getActiveClaims('ws');
  assert.equal(active.length, 1, 'a path-less claim must not fall out of the board');
  assert.ok(isExplorationClaim(active[0]));

  // Declaring a contract without a path is enough to stop being "exploring":
  // the lane has said what it is making, even before it knows where.
  assert.equal(
    isExplorationClaim({ scope: { paths: [], symbols: [] }, produces: [{ kind: 'export', name: 'thing' }] }),
    false
  );

  const { claim: localized } = await extendClaim('ws', 'ws:explorer', ['src/area/']);
  assert.ok(!isExplorationClaim(localized), 'extending with paths localizes the claim');
  assert.deepEqual(localized.scope.paths, ['src/area/']);
});
