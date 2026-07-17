import test from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { saveAnalysis } from '../storage';
import { appendClaim, announceEdit, recordUnclaimedEdit } from './local-store';
import type { WorkClaim } from './types';
import type { ConflictCas } from './conceptual-conflict';
import {
  getInFlightSemanticDelta,
  getAttributedInFlightState,
  detectConceptualConflictsFromSubstrate,
} from './in-flight-substrate';

/** Fresh KLAURO_STORAGE_PATH (analyses) + KLAURO_COORD_DIR (claims) per test — no cross-test bleed. */
async function freshEnv(): Promise<{ storageDir: string; coordDir: string; cleanup: () => Promise<void> }> {
  const storageDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'klauro-substrate-storage-'));
  const coordDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'klauro-substrate-coord-'));
  process.env.KLAURO_STORAGE_PATH = storageDir;
  process.env.KLAURO_COORD_DIR = coordDir;
  return {
    storageDir,
    coordDir,
    cleanup: async () => {
      await fsp.rm(storageDir, { recursive: true, force: true });
      await fsp.rm(coordDir, { recursive: true, force: true });
    },
  };
}

/** Minimal-but-valid CASOutput fixture. Cast to `any` for the fields this module never reads
 *  (documentation/health/etc.) rather than hand-filling the entire CASOutput surface. */
function makeCas(opts: {
  timestamp: string;
  nodes: Array<{
    id: string;
    name: string;
    type?: string;
    file?: string;
    line?: number;
    return_type?: string;
    params?: Array<{ name: string; type?: string }>;
  }>;
  edges?: Array<{ source: string; target: string; type: string }>;
  entryPoints?: Array<{ id: string; name: string; source_node: string }>;
  callChains?: Array<{ id: string; call_path: string[]; criticality?: string }>;
}): any {
  return {
    cas_version: '1.0.0',
    analysis_timestamp: opts.timestamp,
    analysis_id: `analysis_${opts.timestamp}`,
    system: {
      id: 'sys-1',
      name: 'test-project',
      type: 'application',
      root_path: '/tmp/test-project',
    },
    nodes: opts.nodes.map((n) => ({
      id: n.id,
      name: n.name,
      type: n.type ?? 'function',
      source: { file: n.file, line: n.line },
      signature:
        n.return_type !== undefined || n.params !== undefined
          ? { return_type: n.return_type, parameters: n.params ?? [] }
          : undefined,
    })),
    edges: (opts.edges ?? []).map((e) => ({ id: `${e.source}->${e.target}:${e.type}`, ...e })),
    entry_points: (opts.entryPoints ?? []).map((ep) => ({ ...ep, type: 'http', trigger: {} })),
    exit_points: [],
    call_chains: (opts.callChains ?? []).map((c) => ({
      id: c.id,
      chain_type: 'entry-to-exit',
      entry_point: { node_id: c.call_path[0], method_name: 'x' },
      call_path: c.call_path.map((nodeId, depth) => ({ call_id: `${c.id}:${depth}`, node_id: nodeId, method_name: nodeId, depth })),
      criticality: c.criticality ?? 'medium',
      characteristics: {},
    })),
    system_capabilities: [],
    analyzer_contributions: [],
  };
}

function makeClaim(workspace: string, overrides: Partial<WorkClaim> = {}): Omit<WorkClaim, 'seq'> {
  const now = new Date().toISOString();
  return {
    claim_id: overrides.claim_id ?? `claim-${overrides.agent_id ?? 'a'}`,
    workspace_id: workspace,
    agent_id: 'agent-a',
    agent_kind: 'claude',
    scope: { repo: workspace, paths: [], symbols: [] },
    intent: 'working',
    status: 'active',
    created_at: now,
    ttl_ms: 60_000,
    heartbeat_at: now,
    ...overrides,
  };
}

test('getInFlightSemanticDelta: signature change + added entry point are SEMANTIC, correctly identified', async () => {
  const env = await freshEnv();
  const workspace = path.join(env.storageDir, 'proj-a'); // any stable string works — projectSlug just hashes it

  const main = makeCas({
    timestamp: '2026-01-01T00:00:00.000Z',
    nodes: [{ id: 'sym:getUser', name: 'getUser', file: 'src/auth.ts', return_type: 'User | null' }],
  });
  const inflight = makeCas({
    timestamp: '2026-01-01T00:05:00.000Z',
    nodes: [
      { id: 'sym:getUser', name: 'getUser', file: 'src/auth.ts', return_type: 'User' },
      { id: 'sym:newRoute', name: 'createOrder', file: 'src/routes.ts', return_type: 'void' },
    ],
    entryPoints: [{ id: 'ep:create-order', name: 'POST /orders', source_node: 'sym:newRoute' }],
  });

  await saveAnalysis(workspace, main, 'main');
  await saveAnalysis(workspace, inflight, 'in-flight');

  const delta = await getInFlightSemanticDelta(workspace, 'agent-a');
  assert.equal(delta.available, true);
  assert.equal(delta.inflight_present, true);

  const getUserDelta = delta.symbols.find((s) => s.symbol_id === 'sym:getUser');
  assert.ok(getUserDelta, 'getUser should be in the delta');
  assert.equal(getUserDelta!.kind, 'changed');
  assert.ok(getUserDelta!.fields_changed?.includes('return_type'), 'return_type should be flagged');
  assert.ok(getUserDelta!.fields_changed?.includes('nullability'), 'nullability should be flagged (User|null -> User)');

  const newRouteDelta = delta.symbols.find((s) => s.symbol_id === 'sym:newRoute');
  assert.ok(newRouteDelta, 'createOrder should be in the delta');
  assert.equal(newRouteDelta!.kind, 'added');

  const epDelta = delta.entry_points.find((e) => e.id === 'ep:create-order');
  assert.ok(epDelta, 'the new entry point should be in the delta');
  assert.equal(epDelta!.kind, 'added');

  // changes[] is pre-shaped for detectConceptualConflicts.
  const getUserChange = delta.changes.find((c) => c.symbol_id === 'sym:getUser');
  assert.ok(getUserChange);
  assert.equal(getUserChange!.change_kind, 'return_type');
  assert.equal(getUserChange!.before?.return_type, 'User | null');
  assert.equal(getUserChange!.after?.return_type, 'User');

  await env.cleanup();
});

test('getInFlightSemanticDelta: no in-flight track -> honest unavailable result, never fabricated', async () => {
  const env = await freshEnv();
  const workspace = path.join(env.storageDir, 'proj-clean');
  const main = makeCas({ timestamp: '2026-01-01T00:00:00.000Z', nodes: [{ id: 'sym:a', name: 'a', file: 'src/a.ts' }] });
  await saveAnalysis(workspace, main, 'main');

  const delta = await getInFlightSemanticDelta(workspace, 'agent-a');
  assert.equal(delta.available, false);
  assert.equal(delta.inflight_present, false);
  assert.ok(delta.reason);
  assert.deepEqual(delta.symbols, []);
  assert.deepEqual(delta.changes, []);

  await env.cleanup();
});

test('getAttributedInFlightState: disjoint claims each get only their own slice; unclaimed/overlapping are surfaced, never assigned', async () => {
  const env = await freshEnv();
  const workspace = path.join(env.storageDir, 'proj-b');

  const main = makeCas({
    timestamp: '2026-01-01T00:00:00.000Z',
    nodes: [
      { id: 'sym:getUser', name: 'getUser', file: 'src/auth.ts', return_type: 'User | null' },
      { id: 'sym:render', name: 'render', file: 'src/profile.ts', return_type: 'string' },
    ],
  });
  const inflight = makeCas({
    timestamp: '2026-01-01T00:05:00.000Z',
    nodes: [
      { id: 'sym:getUser', name: 'getUser', file: 'src/auth.ts', return_type: 'User' }, // agent-a's claimed change
      { id: 'sym:render', name: 'render', file: 'src/profile.ts', return_type: 'HtmlString' }, // agent-b's claimed change
      { id: 'sym:mystery', name: 'mystery', file: 'src/unowned.ts', return_type: 'void' }, // added, nobody claims src/unowned.ts
    ],
  });
  await saveAnalysis(workspace, main, 'main');
  await saveAnalysis(workspace, inflight, 'in-flight');

  await appendClaim(workspace, makeClaim(workspace, { claim_id: 'claim-a', agent_id: 'agent-a', scope: { repo: workspace, paths: ['src/auth.ts'], symbols: [] } }));
  await appendClaim(workspace, makeClaim(workspace, { claim_id: 'claim-b', agent_id: 'agent-b', scope: { repo: workspace, paths: ['src/profile.ts'], symbols: [] } }));

  const attributed = await getAttributedInFlightState(workspace);
  assert.equal(attributed.available, true);
  assert.equal(attributed.participants.length, 2);

  const a = attributed.participants.find((p) => p.agent_id === 'agent-a')!;
  const b = attributed.participants.find((p) => p.agent_id === 'agent-b')!;
  assert.deepEqual(a.delta.symbols.map((s) => s.symbol_id), ['sym:getUser']);
  assert.deepEqual(b.delta.symbols.map((s) => s.symbol_id), ['sym:render']);

  // The unowned change is surfaced as unattributed, not silently handed to either agent.
  const unowned = attributed.unattributed.find((u) => u.symbol_id === 'sym:mystery');
  assert.ok(unowned, 'unowned symbol should be in the unattributed bucket');
  assert.equal(unowned!.reason, 'unclaimed');
  assert.ok(!a.delta.symbols.some((s) => s.symbol_id === 'sym:mystery'));
  assert.ok(!b.delta.symbols.some((s) => s.symbol_id === 'sym:mystery'));

  await env.cleanup();
});

test('getAttributedInFlightState: overlapping claims over the SAME change are unattributable, not assigned to whoever asks', async () => {
  const env = await freshEnv();
  const workspace = path.join(env.storageDir, 'proj-c');

  const main = makeCas({
    timestamp: '2026-01-01T00:00:00.000Z',
    nodes: [{ id: 'sym:shared', name: 'shared', file: 'src/shared.ts', return_type: 'A' }],
  });
  const inflight = makeCas({
    timestamp: '2026-01-01T00:05:00.000Z',
    nodes: [{ id: 'sym:shared', name: 'shared', file: 'src/shared.ts', return_type: 'B' }],
  });
  await saveAnalysis(workspace, main, 'main');
  await saveAnalysis(workspace, inflight, 'in-flight');

  // Both claims cover src/shared.ts — a genuinely ambiguous shared-tree case.
  await appendClaim(workspace, makeClaim(workspace, { claim_id: 'claim-a', agent_id: 'agent-a', scope: { repo: workspace, paths: ['src/'], symbols: [] } }));
  await appendClaim(workspace, makeClaim(workspace, { claim_id: 'claim-b', agent_id: 'agent-b', scope: { repo: workspace, paths: ['src/shared.ts'], symbols: [] } }));

  const attributed = await getAttributedInFlightState(workspace);
  const a = attributed.participants.find((p) => p.agent_id === 'agent-a')!;
  const b = attributed.participants.find((p) => p.agent_id === 'agent-b')!;
  assert.deepEqual(a.delta.symbols, []);
  assert.deepEqual(b.delta.symbols, []);

  const shared = attributed.unattributed.find((u) => u.symbol_id === 'sym:shared');
  assert.ok(shared);
  assert.equal(shared!.reason, 'overlapping-claims');
  assert.deepEqual([...shared!.overlapping_agents!].sort(), ['agent-a', 'agent-b']);

  await env.cleanup();
});

test('detectConceptualConflictsFromSubstrate: catches attributed contract-divergence, and stays silent when work is disjoint', async () => {
  const env = await freshEnv();
  const workspace = path.join(env.storageDir, 'proj-d');

  const main = makeCas({
    timestamp: '2026-01-01T00:00:00.000Z',
    nodes: [
      { id: 'sym:getUser', name: 'getUser', file: 'src/auth.ts', return_type: 'User | null' },
      { id: 'sym:renderProfile', name: 'renderProfile', file: 'src/profile.ts', return_type: 'string' },
    ],
    edges: [{ source: 'sym:renderProfile', target: 'sym:getUser', type: 'calls' }],
  });
  const inflight = makeCas({
    timestamp: '2026-01-01T00:05:00.000Z',
    nodes: [
      { id: 'sym:getUser', name: 'getUser', file: 'src/auth.ts', return_type: 'User' }, // agent-a: drops nullability
      { id: 'sym:renderProfile', name: 'renderProfile', file: 'src/profile.ts', return_type: 'string', line: 12 }, // agent-b: touches the caller
    ],
    edges: [{ source: 'sym:renderProfile', target: 'sym:getUser', type: 'calls' }],
  });
  await saveAnalysis(workspace, main, 'main');
  await saveAnalysis(workspace, inflight, 'in-flight');

  await appendClaim(workspace, makeClaim(workspace, {
    claim_id: 'claim-a', agent_id: 'agent-a', intent: 'make getUser non-null',
    scope: { repo: workspace, paths: ['src/auth.ts'], symbols: [] },
  }));
  await appendClaim(workspace, makeClaim(workspace, {
    claim_id: 'claim-b', agent_id: 'agent-b', intent: 'add avatar to renderProfile',
    scope: { repo: workspace, paths: ['src/profile.ts'], symbols: [] },
  }));

  const cas: ConflictCas = {
    nodes: [
      { id: 'sym:getUser', name: 'getUser' },
      { id: 'sym:renderProfile', name: 'renderProfile' },
    ],
    edges: [{ source: 'sym:renderProfile', target: 'sym:getUser', type: 'calls' }],
  };

  const result = await detectConceptualConflictsFromSubstrate(workspace, cas);
  assert.equal(result.attributed.participants.length, 2);
  const contractDivergence = result.conflicts.filter((c) => c.kind === 'contract-divergence');
  assert.equal(contractDivergence.length, 1);
  assert.deepEqual([...contractDivergence[0].agents].sort(), ['agent-a', 'agent-b']);

  await env.cleanup();
});

test('getAttributedInFlightState: unclaimed symbol resolved via write-hook announced-edit event -> tiebroken, not unattributed', async () => {
  const env = await freshEnv();
  const workspace = path.join(env.storageDir, 'proj-f');

  const main = makeCas({
    timestamp: '2026-01-01T00:00:00.000Z',
    nodes: [{ id: 'sym:helper', name: 'helper', file: 'src/helper.ts', return_type: 'void' }],
  });
  const inflight = makeCas({
    timestamp: '2026-01-01T00:05:00.000Z',
    nodes: [{ id: 'sym:helper', name: 'helper', file: 'src/helper.ts', return_type: 'string' }],
  });
  await saveAnalysis(workspace, main, 'main');
  await saveAnalysis(workspace, inflight, 'in-flight');

  // No active claim covers src/helper.ts, but the write-hook auto-announced an
  // edit there for agent-c (announceEdit), and the claim has since expired
  // (ttlMs: 0) -- getActiveClaims won't see it, but the FULL claim log still
  // names agent-c, which is the tiebreaker evidence.
  await announceEdit(workspace, 'agent-c', ['src/helper.ts'], { intent: 'write-hook: refactor helper', ttlMs: 0 });

  const attributed = await getAttributedInFlightState(workspace);
  assert.equal(attributed.unattributed.find((u) => u.symbol_id === 'sym:helper'), undefined, 'should be resolved, not left unattributed');
  const tb = attributed.tiebroken.find((t) => t.symbol_id === 'sym:helper');
  assert.ok(tb, 'sym:helper should be tiebroken via the write-hook event');
  assert.equal(tb!.agent_id, 'agent-c');
  assert.equal(tb!.via, 'announced-edit');
  assert.equal(tb!.change.symbol_id, 'sym:helper');

  await env.cleanup();
});

test('getAttributedInFlightState: unclaimed symbol with NO write-hook event stays honestly unattributed', async () => {
  const env = await freshEnv();
  const workspace = path.join(env.storageDir, 'proj-g');

  const main = makeCas({
    timestamp: '2026-01-01T00:00:00.000Z',
    nodes: [{ id: 'sym:orphan', name: 'orphan', file: 'src/orphan.ts', return_type: 'void' }],
  });
  const inflight = makeCas({
    timestamp: '2026-01-01T00:05:00.000Z',
    nodes: [{ id: 'sym:orphan', name: 'orphan', file: 'src/orphan.ts', return_type: 'string' }],
  });
  await saveAnalysis(workspace, main, 'main');
  await saveAnalysis(workspace, inflight, 'in-flight');
  // Some OTHER active claim exists (so we take the "claims.length > 0" branch), but nothing
  // covers src/orphan.ts, and there is no write-hook event for it at all.
  await appendClaim(workspace, makeClaim(workspace, { claim_id: 'claim-x', agent_id: 'agent-x', scope: { repo: workspace, paths: ['src/unrelated.ts'], symbols: [] } }));

  const attributed = await getAttributedInFlightState(workspace);
  assert.equal(attributed.tiebroken.length, 0);
  const u = attributed.unattributed.find((d) => d.symbol_id === 'sym:orphan');
  assert.ok(u, 'orphan should remain unattributed with no claim and no write-hook event');
  assert.equal(u!.reason, 'unclaimed');

  await env.cleanup();
});

test('getAttributedInFlightState: an anonymous unclaimed-edit event (detectedBy unset) does NOT count as a tiebreaker', async () => {
  const env = await freshEnv();
  const workspace = path.join(env.storageDir, 'proj-h');

  const main = makeCas({
    timestamp: '2026-01-01T00:00:00.000Z',
    nodes: [{ id: 'sym:mystery2', name: 'mystery2', file: 'src/mystery2.ts', return_type: 'void' }],
  });
  const inflight = makeCas({
    timestamp: '2026-01-01T00:05:00.000Z',
    nodes: [{ id: 'sym:mystery2', name: 'mystery2', file: 'src/mystery2.ts', return_type: 'string' }],
  });
  await saveAnalysis(workspace, main, 'main');
  await saveAnalysis(workspace, inflight, 'in-flight');
  // recordUnclaimedEdit with no detectedBy -> agent_id defaults to 'unknown', which must NOT
  // resolve a tiebreak (an anonymous observation names nobody).
  await recordUnclaimedEdit(workspace, 'src/mystery2.ts');

  const attributed = await getAttributedInFlightState(workspace);
  assert.equal(attributed.tiebroken.length, 0);
  const u = attributed.unattributed.find((d) => d.symbol_id === 'sym:mystery2');
  assert.ok(u, 'an anonymous unclaimed-edit event must not silently attribute the symbol');

  await env.cleanup();
});

test('detectConceptualConflictsFromSubstrate: no conflict when participants\' attributed work is disjoint (no shared caller edge)', async () => {
  const env = await freshEnv();
  const workspace = path.join(env.storageDir, 'proj-e');

  const main = makeCas({
    timestamp: '2026-01-01T00:00:00.000Z',
    nodes: [
      { id: 'sym:getUser', name: 'getUser', file: 'src/auth.ts', return_type: 'User | null' },
      { id: 'sym:otherThing', name: 'otherThing', file: 'src/other.ts', return_type: 'number' },
    ],
  });
  const inflight = makeCas({
    timestamp: '2026-01-01T00:05:00.000Z',
    nodes: [
      { id: 'sym:getUser', name: 'getUser', file: 'src/auth.ts', return_type: 'User' },
      { id: 'sym:otherThing', name: 'otherThing', file: 'src/other.ts', return_type: 'string' },
    ],
  });
  await saveAnalysis(workspace, main, 'main');
  await saveAnalysis(workspace, inflight, 'in-flight');

  await appendClaim(workspace, makeClaim(workspace, {
    claim_id: 'claim-a', agent_id: 'agent-a', intent: 'change getUser',
    scope: { repo: workspace, paths: ['src/auth.ts'], symbols: [] },
  }));
  await appendClaim(workspace, makeClaim(workspace, {
    claim_id: 'claim-b', agent_id: 'agent-b', intent: 'unrelated change to otherThing',
    scope: { repo: workspace, paths: ['src/other.ts'], symbols: [] },
  }));

  // No call edge between getUser and otherThing — genuinely disjoint work.
  const cas: ConflictCas = {
    nodes: [
      { id: 'sym:getUser', name: 'getUser' },
      { id: 'sym:otherThing', name: 'otherThing' },
    ],
    edges: [],
  };

  const result = await detectConceptualConflictsFromSubstrate(workspace, cas);
  assert.equal(result.conflicts.length, 0);

  await env.cleanup();
});
