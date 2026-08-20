import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';

import { createRemoteAnalyzerHttpServer } from './remote-analyzer-service';
import {
  getRemoteFabConfig,
  remoteActive,
  remoteCheck,
  remoteClaim,
  remoteExtend,
  remoteRelease,
  RemoteFabricError,
} from './coordination/remote-transport';

/**
 * Cross-machine coordination API (docs/FABRIC-REMOTE.md): the advisory
 * claim/check/release/active routes on remote-analyzer-service.ts plus the
 * remote-transport client, exercised end to end over loopback HTTP with the
 * analyzer Bearer token gate ON — i.e. exactly what a second machine pointed
 * at mcp.klauro.com does, minus the WAN in the middle.
 */

const TOKEN = 'test-fabric-token';

interface Booted {
  server: http.Server;
  baseUrl: string;
  restoreEnv: () => void;
}

async function bootService(options: { rateLimitPerMinute?: number; fabricRateLimitPerMinute?: number; coordinationOnly?: boolean } = {}): Promise<Booted> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-remote-coord-'));
  const previousRemoteData = process.env.KLAURO_REMOTE_ANALYZER_DATA;
  const previousCoordDir = process.env.KLAURO_COORD_DIR;
  const previousCoordinationOnly = process.env.KLAURO_COORDINATION_ONLY;
  process.env.KLAURO_REMOTE_ANALYZER_DATA = path.join(root, 'remote-data');
  process.env.KLAURO_COORD_DIR = path.join(root, 'remote-data', 'coordination');
  if (options.coordinationOnly) process.env.KLAURO_COORDINATION_ONLY = '1';
  else delete process.env.KLAURO_COORDINATION_ONLY;

  const server = createRemoteAnalyzerHttpServer({
    dataDir: path.join(root, 'remote-data'),
    token: TOKEN,
    rateLimitPerMinute: options.rateLimitPerMinute,
    fabricRateLimitPerMinute: options.fabricRateLimitPerMinute,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    restoreEnv: () => {
      if (previousRemoteData === undefined) delete process.env.KLAURO_REMOTE_ANALYZER_DATA;
      else process.env.KLAURO_REMOTE_ANALYZER_DATA = previousRemoteData;
      if (previousCoordDir === undefined) delete process.env.KLAURO_COORD_DIR;
      else process.env.KLAURO_COORD_DIR = previousCoordDir;
      if (previousCoordinationOnly === undefined) delete process.env.KLAURO_COORDINATION_ONLY;
      else process.env.KLAURO_COORDINATION_ONLY = previousCoordinationOnly;
    },
  };
}

test('coordination-only service keeps health and Fabric routes but rejects analyzer/API work', async () => {
  const boot = await bootService({ coordinationOnly: true });
  try {
    const health = await fetch(`${boot.baseUrl}/health`);
    assert.equal(health.status, 200);

    const analyzer = await fetch(`${boot.baseUrl}/api/workspaces`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(analyzer.status, 404);

    const active = await fetch(`${boot.baseUrl}/v1/coordination/active?workspace=isolated`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(active.status, 200);
  } finally {
    boot.server.close();
    boot.restoreEnv();
  }
});

test('coordination routes require the analyzer Bearer token', async () => {
  const boot = await bootService();
  try {
    const res = await fetch(`${boot.baseUrl}/v1/coordination/active?workspace=ws-auth`, { method: 'GET' });
    assert.equal(res.status, 401);

    const post = await fetch(`${boot.baseUrl}/v1/coordination/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-token' },
      body: JSON.stringify({ mode: 'advisory', workspace: 'ws-auth', agent_id: 'a', intent: 'x' }),
    });
    assert.equal(post.status, 401);
  } finally {
    boot.server.close();
    boot.restoreEnv();
  }
});

test('Fabric uses a separately bounded mutation budget sized for fleet bursts', async () => {
  const boot = await bootService({ rateLimitPerMinute: 1, fabricRateLimitPerMinute: 2 });
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };
  const publish = (agentId: string) => fetch(`${boot.baseUrl}/v1/coordination/in-flight`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      workspace: 'ws-rate-budget',
      agent_id: agentId,
      base_commit: 'base',
      diff_context: '{}',
      attribution_source: 'participant-worktree',
      changes: [],
    }),
  });
  try {
    assert.equal((await publish('agent-1')).status, 200);
    assert.equal((await publish('agent-2')).status, 200);
    const limited = await publish('agent-3');
    assert.equal(limited.status, 429);
    assert.equal((await limited.json() as { error: string }).error, 'Fabric update rate limit exceeded');
  } finally {
    boot.server.close();
    boot.restoreEnv();
  }
});

test('two-machine advisory flow: A claims -> B check sees conflict -> B claim warns -> A releases -> B clears', async () => {
  const boot = await bootService();
  const config = { baseUrl: boot.baseUrl, token: TOKEN };
  const ws = 'ws-two-machines';
  try {
    // "Machine A" claims a path. Server assigns the authoritative seq.
    const a = await remoteClaim(config, {
      workspace: ws,
      agentId: 'agent-A',
      intent: 'refactor auth',
      paths: ['src/auth/login.ts'],
    });
    assert.equal(a.verdict, 'granted');
    assert.equal(a.mode, 'advisory');
    assert.ok(a.seq >= 1);
    assert.equal(a.conflicts.length, 0);
    assert.equal(a.ttl_ms, 30 * 60 * 1000, 'remote advisory claims default to the WAN 30m TTL');

    // "Machine B" preflights the same path — must see A's claim.
    const check = await remoteCheck(config, { workspace: ws, agentId: 'agent-B', paths: ['src/auth/login.ts'] });
    assert.equal(check.ok, false);
    assert.equal(check.conflicts.length, 1);
    assert.equal(check.conflicts[0].agent_id, 'agent-A');
    assert.deepEqual(check.conflicts[0].overlapping_paths, ['src/auth/login.ts']);

    // B claims anyway (advisory: always succeeds) — but gets the warning inline.
    const b = await remoteClaim(config, {
      workspace: ws,
      agentId: 'agent-B',
      intent: 'fix login bug',
      paths: ['src/auth/login.ts'],
    });
    assert.equal(b.verdict, 'granted');
    assert.ok(b.warning && b.warning.includes('agent-A'), `claim warning should name the holder, got: ${b.warning}`);
    assert.ok(b.seq > a.seq, 'server seq is monotonic across machines');

    // The shared awareness surface shows both.
    const active = await remoteActive(config, ws);
    assert.equal(active.count, 2);
    assert.deepEqual(new Set(active.active.map((c) => c.agent_id)), new Set(['agent-A', 'agent-B']));

    // A releases; B's next check comes back clean (only B's own claim remains,
    // and check excludes the caller's own claims).
    const released = await remoteRelease(config, { workspace: ws, agentId: 'agent-A' });
    assert.equal(released.released_count, 1);
    const recheck = await remoteCheck(config, { workspace: ws, agentId: 'agent-B', paths: ['src/auth/login.ts'] });
    assert.equal(recheck.ok, true);

    const after = await remoteActive(config, ws);
    assert.equal(after.count, 1);
    assert.equal(after.active[0].agent_id, 'agent-B');
  } finally {
    boot.server.close();
    boot.restoreEnv();
  }
});

test('two machines retain distinct semantic streams while editing the same symbol', async () => {
  const boot = await bootService();
  const config = { baseUrl: boot.baseUrl, token: TOKEN };
  const workspace = 'ws-overlapping-semantic-streams';
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };
  try {
    await remoteClaim(config, {
      workspace,
      agentId: 'agent-A',
      intent: 'refine shared result',
      paths: ['src/shared.ts'],
    });
    await remoteClaim(config, {
      workspace,
      agentId: 'agent-B',
      intent: 'refine shared result',
      paths: ['src/shared.ts'],
    });
    const publish = (agentId: string, returnType: string) => fetch(`${boot.baseUrl}/v1/coordination/in-flight`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        workspace,
        agent_id: agentId,
        base_commit: 'base',
        diff_context: '{}',
        attribution_source: 'participant-worktree',
        changes: [{
          symbol_id: 'sym:shared',
          name: 'shared',
          file: 'src/shared.ts',
          change_kind: 'return_type',
          before: { return_type: 'A' },
          after: { return_type: returnType },
        }],
      }),
    });
    const [publishedA, publishedB] = await Promise.all([publish('agent-A', 'B'), publish('agent-B', 'C')]);
    assert.equal(publishedA.status, 200);
    assert.equal(publishedB.status, 200);

    const stateResponse = await fetch(`${boot.baseUrl}/v1/coordination/state?workspace=${workspace}`, { headers });
    assert.equal(stateResponse.status, 200);
    const state = await stateResponse.json() as {
      in_flight: Array<{ agent_id: string; attribution_source: string; changes_count: number }>;
    };
    assert.deepEqual(state.in_flight.map((snapshot) => snapshot.agent_id).sort(), ['agent-A', 'agent-B']);
    assert.ok(state.in_flight.every((snapshot) => snapshot.attribution_source === 'participant-worktree'));
    assert.ok(state.in_flight.every((snapshot) => snapshot.changes_count === 1));
    const active = await remoteActive(config, workspace);
    assert.deepEqual(active.in_flight?.map((snapshot) => snapshot.agent_id).sort(), ['agent-A', 'agent-B']);

    const conflictsResponse = await fetch(`${boot.baseUrl}/v1/coordination/conceptual-conflicts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ workspace, agent_id: 'agent-A', intent: 'refine shared result', changes: [] }),
    });
    assert.equal(conflictsResponse.status, 200);
    const conflicts = await conflictsResponse.json() as {
      substrate: { participants: number; unattributed: number };
      conflicts: Array<{ kind: string; agents: string[] }>;
    };
    assert.deepEqual(conflicts.substrate, { participants: 2, unattributed: 0 });
    assert.ok(conflicts.conflicts.some((conflict) => conflict.kind === 'duplicate-work'));

    const planResponse = await fetch(`${boot.baseUrl}/v1/coordination/intent-merge`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ workspace, agent_id: 'agent-A' }),
    });
    assert.equal(planResponse.status, 200);
    const metricsResponse = await fetch(`${boot.baseUrl}/v1/coordination/metrics?workspace=${workspace}`, { headers });
    assert.equal(metricsResponse.status, 200);
    const metrics = await metricsResponse.json() as {
      observation_count: number;
      merge_decisions_required: number;
      merge_decision_rate: number;
    };
    assert.equal(metrics.observation_count, 1);
    assert.equal(metrics.merge_decisions_required, 1);
    assert.equal(metrics.merge_decision_rate, 1);
  } finally {
    boot.server.close();
    boot.restoreEnv();
  }
});

test('cross-machine advisory claims surface conceptual overlap across disjoint files', async () => {
  const boot = await bootService();
  const config = { baseUrl: boot.baseUrl, token: TOKEN };
  const workspace = 'ws-conceptual-overlap';
  try {
    await remoteClaim(config, {
      workspace,
      agentId: 'agent-A',
      intent: 'tighten record constraints',
      paths: ['src/write.ts'],
      concept: { flow_id: 'flow-write', step_id: 'persist', entities: ['Record'], source: 'declared' },
    });
    const second = await remoteClaim(config, {
      workspace,
      agentId: 'agent-B',
      intent: 'change record validation',
      paths: ['src/validate.ts'],
      concept: { flow_id: 'flow-read', step_id: 'validate', entities: ['Record'], source: 'declared' },
    });

    assert.equal(second.conflicts.length, 0);
    assert.equal(second.conceptual_awareness?.length, 1);
    assert.equal(second.conceptual_awareness?.[0].agent_id, 'agent-A');
    assert.equal(second.conceptual_awareness?.[0].verdict, 'conceptual_conflict');
    assert.deepEqual(second.conceptual_awareness?.[0].shared_entities, ['Record']);
    const active = await remoteActive(config, workspace);
    assert.deepEqual(active.active.map((claim) => claim.concept?.entities?.[0]), ['Record', 'Record']);
  } finally {
    boot.server.close();
    boot.restoreEnv();
  }
});

test('#57 regression: releasing an ADVISORY claim by its echoed claim_id actually releases it (not a false "released")', async () => {
  const boot = await bootService();
  const config = { baseUrl: boot.baseUrl, token: TOKEN };
  const ws = 'ws-issue-57';
  try {
    const claimed = await remoteClaim(config, {
      workspace: ws,
      agentId: 'agent-57',
      intent: 'repro #57',
      paths: ['src/x.ts'],
    });
    assert.equal(claimed.verdict, 'granted');
    assert.ok(claimed.claim_id, 'advisory claim response must carry a claim_id');

    const releaseRes = await fetch(`${boot.baseUrl}/v1/coordination/release`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ workspace: ws, agent_id: 'agent-57', claim_id: claimed.claim_id }),
    });
    assert.equal(releaseRes.status, 200);
    const releaseBody = (await releaseRes.json()) as { status: string; mode?: string; tier?: string };
    assert.equal(releaseBody.status, 'released', 'must actually release, not silently no-op');
    assert.equal(releaseBody.mode, 'advisory', 'must match the tier the claim actually lives in');
    assert.equal(releaseBody.tier, 'claim-log');

    // The proof that matters: the claim must be GONE from the active set, not
    // just reported gone.
    const active = await remoteActive(config, ws);
    assert.equal(active.count, 0, 'the advisory claim must no longer be active after release');
  } finally {
    boot.server.close();
    boot.restoreEnv();
  }
});

test('release with an unknown claim_id is reported honestly, never as a false "released"', async () => {
  const boot = await bootService();
  const ws = 'ws-issue-57-not-found';
  try {
    const releaseRes = await fetch(`${boot.baseUrl}/v1/coordination/release`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ workspace: ws, agent_id: 'agent-ghost', claim_id: 'no-such-claim' }),
    });
    assert.equal(releaseRes.status, 200);
    const body = (await releaseRes.json()) as { status: string; reason?: string };
    assert.equal(body.status, 'not_found');
    assert.ok(body.reason && body.reason.length > 0, 'a not_found response must explain why, never a silent zero');
  } finally {
    boot.server.close();
    boot.restoreEnv();
  }
});

test('re-claiming the same agent refreshes (heartbeat) rather than duplicating', async () => {
  const boot = await bootService();
  const config = { baseUrl: boot.baseUrl, token: TOKEN };
  const ws = 'ws-heartbeat';
  try {
    const first = await remoteClaim(config, { workspace: ws, agentId: 'agent-hb', intent: 'work', paths: ['a.ts'] });
    const second = await remoteClaim(config, { workspace: ws, agentId: 'agent-hb', intent: 'work', paths: ['a.ts'] });
    assert.ok(second.seq > first.seq);
    const active = await remoteActive(config, ws);
    assert.equal(active.count, 1, 'same claim_id LWW-supersedes; no duplicate');
    assert.equal(active.active[0].seq, second.seq);
  } finally {
    boot.server.close();
    boot.restoreEnv();
  }
});

test('expired remote claims drop out of /active and /check (dead-agent TTL)', async () => {
  const boot = await bootService();
  const config = { baseUrl: boot.baseUrl, token: TOKEN };
  const ws = 'ws-ttl';
  try {
    await remoteClaim(config, { workspace: ws, agentId: 'agent-dead', intent: 'crashes soon', paths: ['x.ts'], ttlMs: 50 });
    await new Promise((r) => setTimeout(r, 80));
    const active = await remoteActive(config, ws);
    assert.equal(active.count, 0, 'a claim past heartbeat_at + ttl_ms is expired');
    const check = await remoteCheck(config, { workspace: ws, agentId: 'agent-B', paths: ['x.ts'] });
    assert.equal(check.ok, true);
  } finally {
    boot.server.close();
    boot.restoreEnv();
  }
});

test('20 concurrent remote claims across 2 simulated machines: none lost, distinct seq', async () => {
  const boot = await bootService();
  const config = { baseUrl: boot.baseUrl, token: TOKEN };
  const ws = 'ws-stress';
  try {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        remoteClaim(config, {
          workspace: ws,
          agentId: `machine-${i % 2 === 0 ? 'A' : 'B'}-agent-${i}`,
          intent: `task ${i}`,
          paths: [`src/task-${i}.ts`],
        })
      )
    );
    assert.equal(results.length, 20);
    const seqs = new Set(results.map((r) => r.seq));
    assert.equal(seqs.size, 20, 'every concurrent claim got a distinct server seq (no lost/clobbered writes)');

    const active = await remoteActive(config, ws);
    assert.equal(active.count, 20, 'all 20 claims are visible in the shared awareness view');
  } finally {
    boot.server.close();
    boot.restoreEnv();
  }
});

test('100 mixed participants sustain attributed semantic work with zero merge decisions or surprises', async () => {
  const boot = await bootService();
  const config = { baseUrl: boot.baseUrl, token: TOKEN };
  const workspace = 'ws-hundred-participant-proof';
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };
  const participants = Array.from({ length: 100 }, (_, index) => ({
    agentId: `${index % 2 === 0 ? 'human' : 'agent'}-${index}`,
    path: `src/area-${index}.ts`,
    symbol: `sym:area-${index}`,
  }));
  const startedAt = performance.now();
  try {
    const claims = await Promise.all(participants.map((participant) => remoteClaim(config, {
      workspace,
      agentId: participant.agentId,
      intent: `improve area ${participant.symbol}`,
      paths: [participant.path],
      concept: { entities: [`entity-${participant.symbol}`], source: 'declared' },
    })));
    assert.equal(new Set(claims.map((claim) => claim.seq)).size, participants.length);

    const publications = await Promise.all(participants.map((participant) => fetch(`${boot.baseUrl}/v1/coordination/in-flight`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        workspace,
        agent_id: participant.agentId,
        base_commit: 'base',
        diff_context: '{}',
        attribution_source: 'participant-worktree',
        changes: [{
          symbol_id: participant.symbol,
          name: participant.symbol,
          file: participant.path,
          change_kind: 'body',
          after: { semantic_hash: participant.symbol },
        }],
      }),
    })));
    const publicationStatuses = publications.reduce<Record<number, number>>((counts, response) => {
      counts[response.status] = (counts[response.status] || 0) + 1;
      return counts;
    }, {});
    assert.deepEqual(publicationStatuses, { 200: participants.length });

    const active = await remoteActive(config, workspace);
    assert.equal(active.count, participants.length);
    assert.equal(active.in_flight?.length, participants.length);

    for (let round = 0; round < 5; round += 1) {
      const response = await fetch(`${boot.baseUrl}/v1/coordination/intent-merge`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ workspace, agent_id: `observer-${round}` }),
      });
      assert.equal(response.status, 200);
      const result = await response.json() as {
        plan: {
          summary: { total_symbols: number; auto: number; conflicts: number; duplicates: number };
          merge_decisions_required: number;
          surprises: unknown[];
        };
      };
      const plan = result.plan;
      assert.deepEqual(plan.summary, { total_symbols: 100, auto: 100, conflicts: 0, duplicates: 0 });
      assert.equal(plan.merge_decisions_required, 0);
      assert.equal(plan.surprises.length, 0);
    }

    const metricsResponse = await fetch(`${boot.baseUrl}/v1/coordination/metrics?workspace=${workspace}`, { headers });
    assert.equal(metricsResponse.status, 200);
    const metrics = await metricsResponse.json() as {
      observation_count: number;
      participant_observations: number;
      changed_symbol_observations: number;
      merge_decision_rate: number;
      surprise_rate: number;
      unattributed_changes: number;
    };
    assert.equal(metrics.observation_count, 5);
    assert.equal(metrics.participant_observations, 500);
    assert.equal(metrics.changed_symbol_observations, 500);
    assert.equal(metrics.merge_decision_rate, 0);
    assert.equal(metrics.surprise_rate, 0);
    assert.equal(metrics.unattributed_changes, 0);
    assert.ok(performance.now() - startedAt < 30_000);
  } finally {
    boot.server.close();
    boot.restoreEnv();
  }
});

test('transport surfaces RemoteFabricError on unreachable host and bad token (degrade signal for callers)', async () => {
  // Unreachable: nothing listens on this port.
  await assert.rejects(
    remoteCheck({ baseUrl: 'http://127.0.0.1:1' }, { workspace: 'ws', paths: ['a.ts'] }),
    (err: unknown) => err instanceof RemoteFabricError && /unreachable/.test((err as Error).message)
  );

  const boot = await bootService();
  try {
    await assert.rejects(
      remoteActive({ baseUrl: boot.baseUrl, token: 'wrong' }, 'ws'),
      (err: unknown) => err instanceof RemoteFabricError && /401/.test((err as Error).message)
    );
  } finally {
    boot.server.close();
    boot.restoreEnv();
  }
});

test('getRemoteFabConfig: unset FAB_REMOTE_URL means local mode (zero breaking change)', () => {
  assert.equal(getRemoteFabConfig({}), undefined);
  assert.equal(getRemoteFabConfig({ FAB_REMOTE_URL: '  ' }), undefined);
  assert.deepEqual(getRemoteFabConfig({ FAB_REMOTE_URL: 'https://mcp.klauro.com', FAB_REMOTE_TOKEN: 't' }), {
    baseUrl: 'https://mcp.klauro.com',
    token: 't',
  });
});

/**
 * Coordination Engine §3 wire compatibility (§16 migration): the advisory
 * claim route accepts `produces`/`consumes` ADDITIVELY and stores them on the
 * server's board, so a cross-machine fleet sees the same contract board a
 * same-machine one does. Old clients send neither and are unaffected.
 */
test('advisory claim route carries produces/consumes additively onto the server board', async () => {
  const boot = await bootService();
  try {
    const config = { baseUrl: boot.baseUrl, token: TOKEN };
    const res = await remoteClaim(config, {
      workspace: 'ws-contracts',
      agentId: 'producer',
      intent: 'build the outcome record',
      paths: ['src/outcomes.ts'],
      produces: [{ kind: 'export', name: 'buildOutcomeRecord', path: 'src/outcomes.ts', signature: '(ws: string) => OutcomeRecord[]' }],
      consumes: ['getBoardInfo'],
    });
    assert.equal(res.verdict, 'granted');

    const { getActiveClaims } = await import('./coordination/local-store');
    const [claim] = await getActiveClaims('ws-contracts');
    assert.equal(claim.produces?.[0].name, 'buildOutcomeRecord');
    assert.deepEqual(claim.consumes, ['getBoardInfo']);

    const extended = await remoteExtend(config, {
      workspace: 'ws-contracts',
      claimId: res.claim_id,
      addPaths: ['src/records.ts'],
      addProduces: [{ kind: 'type', name: 'OutcomeRecord', path: 'src/records.ts' }],
      addConsumes: ['loadWorkspace'],
    });
    assert.deepEqual(extended.paths, ['src/outcomes.ts', 'src/records.ts']);
    assert.deepEqual(extended.produces.map((contract) => contract.name).sort(), ['OutcomeRecord', 'buildOutcomeRecord']);
    assert.deepEqual(extended.consumes.sort(), ['getBoardInfo', 'loadWorkspace']);
    const active = await remoteActive(config, 'ws-contracts');
    const producer = active.active.find((entry) => entry.agent_id === 'producer');
    assert.deepEqual(producer?.produces?.map((contract) => contract.name).sort(), ['OutcomeRecord', 'buildOutcomeRecord']);

    // A legacy client sending neither is byte-identical to before: no empty
    // arrays materialize on the board.
    const legacy = await fetch(`${boot.baseUrl}/v1/coordination/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ mode: 'advisory', workspace: 'ws-contracts', agent_id: 'legacy', intent: 'old client' }),
    });
    assert.equal(legacy.status, 200);
    const claims = await getActiveClaims('ws-contracts');
    const old = claims.find((c) => c.agent_id === 'legacy')!;
    assert.equal(old.produces, undefined);
    assert.equal(old.consumes, undefined);
  } finally {
    boot.server.close();
    boot.restoreEnv();
  }
});
