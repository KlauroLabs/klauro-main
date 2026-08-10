import test from 'node:test';
import assert from 'node:assert/strict';

import { arbitrate } from './arbiter';
import { detectCollisions } from './collision';
import { deriveActiveClaims, derivePresence, isExpired, reduceClaimLog } from './presence';
import type { CasEdgeRef, InFlightSnapshot, WorkspaceCapabilityRef, WorkClaim } from './types';

function makeClaim(overrides: Partial<WorkClaim> = {}): WorkClaim {
  return {
    claim_id: 'claim-1',
    seq: 1,
    workspace_id: 'ws-1',
    agent_id: 'agent-a',
    agent_kind: 'claude',
    scope: {
      repo: 'proof-of-concept',
      paths: ['apps/mcp-server/src/foo.ts'],
      symbols: ['fooHandler'],
      capability: undefined,
    },
    intent: 'refactor foo',
    status: 'active',
    created_at: '2026-07-01T00:00:00.000Z',
    ttl_ms: 60_000,
    heartbeat_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

const casEdges: CasEdgeRef[] = [
  { id: 'e1', source: 'fooHandler', target: 'sharedUtil', type: 'calls' },
  { id: 'e2', source: 'barHandler', target: 'sharedUtil', type: 'calls' },
];

const workspaceCapabilities: WorkspaceCapabilityRef[] = [
  { id: 'cap-1', name: 'user-onboarding', project_ids: ['proof-of-concept'] },
];

test('arbitrate: duplicate on same-capability claims', () => {
  const active = [
    makeClaim({
      claim_id: 'claim-existing',
      agent_id: 'agent-a',
      scope: {
        repo: 'proof-of-concept',
        paths: ['apps/mcp-server/src/onboarding.ts'],
        symbols: [],
        capability: 'user-onboarding',
      },
    }),
  ];
  const newClaim = makeClaim({
    claim_id: 'claim-new',
    agent_id: 'agent-b',
    scope: {
      repo: 'proof-of-concept',
      paths: ['apps/mcp-server/src/onboarding-v2.ts'],
      symbols: [],
      capability: 'user-onboarding',
    },
  });

  const result = arbitrate(newClaim, active, casEdges, workspaceCapabilities);
  assert.equal(result.verdict, 'duplicate');
  assert.equal(result.with_claim?.claim_id, 'claim-existing');
  assert.equal(result.kind, 'capability');
});

test('arbitrate: conflict on path overlap', () => {
  const active = [
    makeClaim({
      claim_id: 'claim-existing',
      agent_id: 'agent-a',
      scope: { repo: 'proof-of-concept', paths: ['apps/mcp-server/src/coordination'], symbols: [], capability: undefined },
    }),
  ];
  const newClaim = makeClaim({
    claim_id: 'claim-new',
    agent_id: 'agent-b',
    scope: {
      repo: 'proof-of-concept',
      paths: ['apps/mcp-server/src/coordination/arbiter.ts'],
      symbols: [],
      capability: undefined,
    },
  });

  const result = arbitrate(newClaim, active, casEdges, workspaceCapabilities);
  assert.equal(result.verdict, 'conflict');
  assert.equal(result.kind, 'path');
  assert.equal(result.with_claim?.claim_id, 'claim-existing');
});

test('arbitrate: conflict on symbol overlap', () => {
  const active = [
    makeClaim({
      claim_id: 'claim-existing',
      agent_id: 'agent-a',
      scope: { repo: 'proof-of-concept', paths: ['apps/mcp-server/src/other.ts'], symbols: ['sharedSymbol'], capability: undefined },
    }),
  ];
  const newClaim = makeClaim({
    claim_id: 'claim-new',
    agent_id: 'agent-b',
    scope: { repo: 'proof-of-concept', paths: ['apps/mcp-server/src/unrelated.ts'], symbols: ['sharedSymbol'], capability: undefined },
  });

  const result = arbitrate(newClaim, active, casEdges, workspaceCapabilities);
  assert.equal(result.verdict, 'conflict');
  assert.equal(result.kind, 'symbol');
});

test('arbitrate: conflict on blast-radius overlap via CAS edges', () => {
  const active = [
    makeClaim({
      claim_id: 'claim-existing',
      agent_id: 'agent-a',
      scope: { repo: 'proof-of-concept', paths: ['apps/mcp-server/src/foo.ts'], symbols: ['fooHandler'], capability: undefined },
    }),
  ];
  const newClaim = makeClaim({
    claim_id: 'claim-new',
    agent_id: 'agent-b',
    scope: { repo: 'proof-of-concept', paths: ['apps/mcp-server/src/bar.ts'], symbols: ['barHandler'], capability: undefined },
  });

  // fooHandler and barHandler are disjoint symbols but both reach sharedUtil
  // one hop away via CAS edges -> blast radii intersect.
  const result = arbitrate(newClaim, active, casEdges, workspaceCapabilities);
  assert.equal(result.verdict, 'conflict');
  assert.equal(result.kind, 'blast_radius');
});

test('arbitrate: granted on a disjoint decoy claim', () => {
  const active = [
    makeClaim({
      claim_id: 'claim-existing',
      agent_id: 'agent-a',
      scope: {
        repo: 'proof-of-concept',
        paths: ['apps/mcp-server/src/coordination/arbiter.ts'],
        symbols: ['arbitrate'],
        capability: 'coordination-write-side',
      },
    }),
  ];
  const newClaim = makeClaim({
    claim_id: 'claim-decoy',
    agent_id: 'agent-b',
    scope: {
      // Adjacent directory (shares the 'src' prefix loosely) but NOT a
      // path-prefix of the other claim's path — must not trip path overlap.
      repo: 'proof-of-concept',
      paths: ['apps/mcp-server/src/unrelated-feature/widget.ts'],
      symbols: ['renderWidget'],
      capability: 'widget-rendering',
    },
  });

  const result = arbitrate(newClaim, active, casEdges, workspaceCapabilities);
  assert.equal(result.verdict, 'granted');
});

test('detectCollisions: flags planted duplicate, overlap, drift; silent on disjoint decoy', () => {
  const duplicateA = makeClaim({
    claim_id: 'dup-a',
    agent_id: 'agent-a',
    scope: { repo: 'proof-of-concept', paths: ['apps/mcp-server/src/onboarding.ts'], symbols: [], capability: 'user-onboarding' },
  });
  const duplicateB = makeClaim({
    claim_id: 'dup-b',
    agent_id: 'agent-b',
    scope: { repo: 'proof-of-concept', paths: ['apps/mcp-server/src/onboarding-v2.ts'], symbols: [], capability: 'user-onboarding' },
  });
  const overlapA = makeClaim({
    claim_id: 'ov-a',
    agent_id: 'agent-c',
    scope: { repo: 'proof-of-concept', paths: ['apps/mcp-server/src/shared/'], symbols: ['sharedThing'], capability: undefined },
  });
  const overlapB = makeClaim({
    claim_id: 'ov-b',
    agent_id: 'agent-d',
    scope: { repo: 'proof-of-concept', paths: ['apps/mcp-server/src/shared/util.ts'], symbols: ['sharedThing'], capability: undefined },
  });
  const driftClaimant = makeClaim({
    claim_id: 'drift-b',
    agent_id: 'agent-f',
    scope: { repo: 'proof-of-concept', paths: ['apps/mcp-server/src/api-consumer.ts'], symbols: ['UserDTO'], capability: undefined },
  });
  const decoy = makeClaim({
    claim_id: 'decoy',
    agent_id: 'agent-e',
    scope: { repo: 'proof-of-concept', paths: ['apps/mcp-server/src/totally-unrelated/'], symbols: ['unrelatedFn'], capability: 'unrelated-capability' },
  });

  const activeClaims = [duplicateA, duplicateB, overlapA, overlapB, driftClaimant, decoy];

  const inFlightSnapshots: InFlightSnapshot[] = [
    {
      workspace: 'ws-1',
      agent_id: 'agent-g',
      base_commit: 'abc123',
      diff_context: 'changed UserDTO shape',
      touched: { entities: ['User'], routes: [], contracts: ['UserDTO'], symbols: ['UserDTO'] },
      updated_at: '2026-07-01T00:00:00.000Z',
    },
  ];

  const report = detectCollisions(activeClaims, inFlightSnapshots, casEdges, workspaceCapabilities);

  assert.equal(report.duplicates.length, 1);
  assert.deepEqual(
    [report.duplicates[0].claim_id, report.duplicates[0].with_claim_id].sort(),
    ['dup-a', 'dup-b']
  );

  assert.equal(report.overlaps.length, 1);
  assert.deepEqual(
    [report.overlaps[0].claim_id, report.overlaps[0].with_claim_id].sort(),
    ['ov-a', 'ov-b']
  );

  assert.equal(report.drifts.length, 1);
  assert.equal(report.drifts[0].with_agent_id, 'agent-f');
  assert.deepEqual(report.drifts[0].contracts, ['UserDTO']);

  // The decoy must not appear anywhere in the report.
  const allClaimIds = [
    ...report.duplicates.flatMap((d) => [d.claim_id, d.with_claim_id]),
    ...report.overlaps.flatMap((d) => [d.claim_id, d.with_claim_id]),
    ...report.blast_intersections.flatMap((d) => [d.claim_id, d.with_claim_id]),
  ];
  assert.ok(!allClaimIds.includes('decoy'));
  const allAgentIds = report.drifts.flatMap((d) => [d.agent_id, d.with_agent_id]);
  assert.ok(!allAgentIds.includes('agent-e'));
});

test('detectCollisions: cross-agent blast-radius intersection is flagged', () => {
  const claimA = makeClaim({
    claim_id: 'blast-a',
    agent_id: 'agent-a',
    scope: { repo: 'proof-of-concept', paths: ['apps/mcp-server/src/foo.ts'], symbols: ['fooHandler'], capability: undefined },
  });
  const claimB = makeClaim({
    claim_id: 'blast-b',
    agent_id: 'agent-b',
    scope: { repo: 'proof-of-concept', paths: ['apps/mcp-server/src/util.ts'], symbols: ['sharedUtil'], capability: undefined },
  });

  const report = detectCollisions([claimA, claimB], [], casEdges, workspaceCapabilities);
  assert.ok(report.blast_intersections.length >= 1);
  const hit = report.blast_intersections.find(
    (b) => b.claim_id === 'blast-a' && b.with_claim_id === 'blast-b'
  );
  assert.ok(hit);
  assert.ok(hit!.symbols.includes('sharedUtil'));
});

test('presence: isExpired respects TTL', () => {
  const claim = makeClaim({ heartbeat_at: '2026-07-01T00:00:00.000Z', ttl_ms: 60_000 });
  const withinTtl = Date.parse('2026-07-01T00:00:30.000Z');
  const pastTtl = Date.parse('2026-07-01T00:02:00.000Z');
  assert.equal(isExpired(claim, withinTtl), false);
  assert.equal(isExpired(claim, pastTtl), true);
});

test('presence: reduceClaimLog applies last-writer-wins per claim_id by seq', () => {
  const log = [
    makeClaim({ claim_id: 'c1', seq: 1, status: 'active' }),
    makeClaim({ claim_id: 'c1', seq: 3, status: 'released' }),
    makeClaim({ claim_id: 'c1', seq: 2, status: 'active' }),
    makeClaim({ claim_id: 'c2', seq: 1, status: 'active' }),
  ];
  const reduced = reduceClaimLog(log);
  assert.equal(reduced.length, 2);
  const c1 = reduced.find((c) => c.claim_id === 'c1');
  assert.equal(c1?.seq, 3);
  assert.equal(c1?.status, 'released');
});

test('presence: deriveActiveClaims filters released and expired claims', () => {
  const now = Date.parse('2026-07-01T00:05:00.000Z');
  const log = [
    makeClaim({ claim_id: 'active-fresh', heartbeat_at: '2026-07-01T00:04:50.000Z', ttl_ms: 60_000 }),
    makeClaim({ claim_id: 'active-stale', heartbeat_at: '2026-07-01T00:00:00.000Z', ttl_ms: 60_000 }),
    makeClaim({ claim_id: 'released', status: 'released' }),
  ];
  const active = deriveActiveClaims(log, now);
  assert.deepEqual(
    active.map((c) => c.claim_id).sort(),
    ['active-fresh']
  );
});

test('presence: derivePresence returns one entry per live agent scoped to workspace', () => {
  const now = Date.parse('2026-07-01T00:00:30.000Z');
  const log = [
    makeClaim({ claim_id: 'c1', agent_id: 'agent-a', workspace_id: 'ws-1', heartbeat_at: '2026-07-01T00:00:00.000Z' }),
    makeClaim({ claim_id: 'c2', agent_id: 'agent-b', workspace_id: 'ws-2', heartbeat_at: '2026-07-01T00:00:00.000Z' }),
  ];
  const presence = derivePresence(log, 'ws-1', now);
  assert.equal(presence.length, 1);
  assert.equal(presence[0].agent_id, 'agent-a');
  assert.equal(presence[0].workspace, 'ws-1');
});
