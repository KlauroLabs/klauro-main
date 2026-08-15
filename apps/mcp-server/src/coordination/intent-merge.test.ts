import test from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { planIntentMerge, planIntentMergeFromSubstrate, shouldUseSubstratePlan } from './intent-merge';
import type { AgentInFlightState, ConflictCas } from './conceptual-conflict';
import { saveAnalysis } from '../storage';
import { appendClaim, readSurprisesFor } from './local-store';
import type { WorkClaim } from './types';

const cas: ConflictCas = {
  nodes: [
    { id: 'sym:getUser', name: 'getUser' },
    { id: 'sym:renderProfile', name: 'renderProfile' },
    { id: 'sym:processPayment', name: 'processPayment' },
    { id: 'sym:billingHandler', name: 'billingHandler' },
  ],
  edges: [
    { source: 'sym:renderProfile', target: 'sym:getUser', type: 'calls' },
  ],
};

test('orthogonal additive changes to the same function -> auto_mergeable', () => {
  const states: AgentInFlightState[] = [
    {
      agent_id: 'agent-a',
      intent: 'add retry with backoff to processPayment',
      changes: [
        { symbol_id: 'sym:processPayment', name: 'processPayment', file: 'src/pay.ts', change_kind: 'body' },
      ],
    },
    {
      agent_id: 'agent-b',
      intent: 'add structured logging to processPayment',
      changes: [
        { symbol_id: 'sym:processPayment', name: 'processPayment', file: 'src/pay.ts', change_kind: 'body' },
      ],
    },
  ];

  const plan = planIntentMerge(states, cas);
  assert.equal(plan.needs_resolution.length, 0);
  assert.equal(plan.duplicate_work.length, 0);
  assert.equal(plan.auto_mergeable.length, 1);
  const entry = plan.auto_mergeable[0];
  assert.equal(entry.symbol, 'sym:processPayment');
  assert.deepEqual([...entry.agents].sort(), ['agent-a', 'agent-b']);
  assert.match(entry.rationale, /agent-a/);
  assert.match(entry.rationale, /agent-b/);
  assert.match(entry.rationale, /orthogonal|compose/);
});

test('conceptual conflict (contract-divergence) -> needs_resolution, NOT auto-merged', () => {
  const states: AgentInFlightState[] = [
    {
      agent_id: 'agent-a',
      intent: 'make getUser non-null now that auth guarantees a session',
      changes: [
        {
          symbol_id: 'sym:getUser',
          name: 'getUser',
          file: 'src/auth.ts',
          change_kind: 'nullability',
          before: { nullable: true },
          after: { nullable: false },
        },
      ],
    },
    {
      agent_id: 'agent-b',
      intent: 'add profile picture rendering to renderProfile',
      changes: [
        { symbol_id: 'sym:renderProfile', name: 'renderProfile', file: 'src/profile.ts', change_kind: 'body' },
      ],
    },
  ];

  const plan = planIntentMerge(states, cas);
  assert.equal(plan.needs_resolution.length, 1);
  assert.equal(plan.auto_mergeable.some((e) => e.symbol === 'sym:getUser'), false);
  const nr = plan.needs_resolution[0];
  assert.equal(nr.symbol, 'sym:getUser');
  assert.equal(nr.conflict.kind, 'contract-divergence');
  assert.equal(nr.conflict.passes_textual_merge, true);
  // renderProfile itself, however, has no conflict directly on it and should
  // still be reported (as auto_mergeable, trivially, since only agent-b touches it).
  assert.equal(plan.auto_mergeable.some((e) => e.symbol === 'sym:renderProfile'), true);
});

test('duplicate work -> duplicate_work bucket, not auto-merged or needs_resolution', () => {
  const states: AgentInFlightState[] = [
    {
      agent_id: 'agent-a',
      intent: 'add retry logic with backoff to billingHandler',
      changes: [
        { symbol_id: 'sym:retryBilling', name: 'retryBilling', file: 'src/billing.ts', change_kind: 'add' },
      ],
    },
    {
      agent_id: 'agent-b',
      intent: 'add retry with exponential backoff to billingHandler for reliability',
      changes: [
        { symbol_id: 'sym:retryBillingV2', name: 'retryBilling', file: 'src/billing.ts', change_kind: 'add' },
      ],
    },
  ];

  const plan = planIntentMerge(states, cas);
  // Both symbol_ids (one per agent's "add") surface as duplicate_work — the
  // fleet is doing the same work twice under two different symbol_ids, so
  // both sides of the pair are informative to report, not just one.
  assert.equal(plan.duplicate_work.length, 2);
  assert.equal(plan.needs_resolution.length, 0);
  assert.equal(plan.auto_mergeable.length, 0);
  for (const entry of plan.duplicate_work) {
    assert.deepEqual([...entry.agents].sort(), ['agent-a', 'agent-b']);
  }
  assert.deepEqual(
    [...plan.duplicate_work.map((e) => e.symbol)].sort(),
    ['sym:retryBilling', 'sym:retryBillingV2'].sort()
  );
});

test('disjoint edits from different agents -> all auto_mergeable, correct summary counts', () => {
  const states: AgentInFlightState[] = [
    {
      agent_id: 'agent-a',
      intent: 'add caching to billingHandler',
      changes: [
        { symbol_id: 'sym:billingHandler', name: 'billingHandler', file: 'src/billing.ts', change_kind: 'body' },
      ],
    },
    {
      agent_id: 'agent-b',
      intent: 'add profile picture rendering to renderProfile',
      changes: [
        { symbol_id: 'sym:renderProfile', name: 'renderProfile', file: 'src/profile.ts', change_kind: 'body' },
      ],
    },
  ];

  const plan = planIntentMerge(states, cas);
  assert.equal(plan.auto_mergeable.length, 2);
  assert.equal(plan.needs_resolution.length, 0);
  assert.equal(plan.duplicate_work.length, 0);
  assert.deepEqual(plan.summary, { total_symbols: 2, auto: 2, conflicts: 0, duplicates: 0 });
  for (const entry of plan.auto_mergeable) {
    assert.equal(entry.agents.length, 1);
    assert.match(entry.rationale, /nothing to reconcile/);
  }
});

test('symbol touched by a single agent is trivially auto_mergeable', () => {
  const states: AgentInFlightState[] = [
    {
      agent_id: 'agent-solo',
      intent: 'refactor getUser internals',
      changes: [
        { symbol_id: 'sym:getUser', name: 'getUser', file: 'src/auth.ts', change_kind: 'body' },
      ],
    },
  ];

  const plan = planIntentMerge(states, cas);
  assert.equal(plan.summary.total_symbols, 1);
  assert.equal(plan.summary.auto, 1);
  assert.equal(plan.summary.conflicts, 0);
  assert.equal(plan.summary.duplicates, 0);
  assert.equal(plan.auto_mergeable[0].agents.length, 1);
});

// ---------------------------------------------------------------------------
// Mergeless metrics (V3 §5/§9): merge_decisions_required, surprises
// ---------------------------------------------------------------------------

test('mergeless metrics: contract-divergence -> surprises>0 and merge_decisions_required>0', () => {
  const states: AgentInFlightState[] = [
    {
      agent_id: 'agent-a',
      intent: 'make getUser non-null now that auth guarantees a session',
      changes: [
        {
          symbol_id: 'sym:getUser',
          name: 'getUser',
          file: 'src/auth.ts',
          change_kind: 'nullability',
          before: { nullable: true },
          after: { nullable: false },
        },
      ],
    },
    {
      agent_id: 'agent-b',
      intent: 'add profile picture rendering to renderProfile',
      changes: [
        { symbol_id: 'sym:renderProfile', name: 'renderProfile', file: 'src/profile.ts', change_kind: 'body' },
      ],
    },
  ];

  const plan = planIntentMerge(states, cas);
  assert.ok(plan.merge_decisions_required > 0);
  assert.ok(plan.surprises.length > 0);
  assert.equal(plan.surprises[0].symbol, 'sym:getUser');
  assert.deepEqual([...plan.surprises[0].agents].sort(), ['agent-a', 'agent-b']);
});

test('mergeless metrics: fully orthogonal fleet -> merge_decisions_required=0, surprises=[]', () => {
  const states: AgentInFlightState[] = [
    {
      agent_id: 'agent-a',
      intent: 'add caching to billingHandler',
      changes: [
        { symbol_id: 'sym:billingHandler', name: 'billingHandler', file: 'src/billing.ts', change_kind: 'body' },
      ],
    },
    {
      agent_id: 'agent-b',
      intent: 'add profile picture rendering to renderProfile',
      changes: [
        { symbol_id: 'sym:renderProfile', name: 'renderProfile', file: 'src/profile.ts', change_kind: 'body' },
      ],
    },
  ];

  const plan = planIntentMerge(states, cas);
  assert.equal(plan.merge_decisions_required, 0);
  assert.deepEqual(plan.surprises, []);
});

// ---------------------------------------------------------------------------
// shouldUseSubstratePlan — the W4 selection rule
// ---------------------------------------------------------------------------

test('shouldUseSubstratePlan: semantic substrate is the default at every participant count', () => {
  assert.equal(shouldUseSubstratePlan(0), true);
  assert.equal(shouldUseSubstratePlan(1), true);
  assert.equal(shouldUseSubstratePlan(2), true);
  assert.equal(shouldUseSubstratePlan(5), true);
});

test('shouldUseSubstratePlan: explicit flag always wins over the participant count', () => {
  assert.equal(shouldUseSubstratePlan(5, false), false);
  assert.equal(shouldUseSubstratePlan(0, true), true);
});

// ---------------------------------------------------------------------------
// planIntentMergeFromSubstrate — W4 step 1: re-based on the W0 substrate
// ---------------------------------------------------------------------------

async function freshEnv(): Promise<{ storageDir: string; coordDir: string; cleanup: () => Promise<void> }> {
  const storageDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'klauro-intent-merge-storage-'));
  const coordDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'klauro-intent-merge-coord-'));
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

function makeCas(opts: {
  timestamp: string;
  nodes: Array<{ id: string; name: string; file?: string; return_type?: string; line?: number }>;
  edges?: Array<{ source: string; target: string; type: string }>;
}): any {
  return {
    cas_version: '1.0.0',
    analysis_timestamp: opts.timestamp,
    analysis_id: `analysis_${opts.timestamp}`,
    system: { id: 'sys-1', name: 'test-project', type: 'application', root_path: '/tmp/test-project' },
    nodes: opts.nodes.map((n) => ({
      id: n.id,
      name: n.name,
      type: 'function',
      source: { file: n.file, line: n.line },
      signature: n.return_type !== undefined ? { return_type: n.return_type, parameters: [] } : undefined,
    })),
    edges: (opts.edges ?? []).map((e) => ({ id: `${e.source}->${e.target}:${e.type}`, ...e })),
    entry_points: [],
    exit_points: [],
    call_chains: [],
    capabilities: [],
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

test('planIntentMergeFromSubstrate: disjoint claims + distinct deltas -> each attributed correctly, merge_decisions_required=0', async () => {
  const env = await freshEnv();
  const workspace = path.join(env.storageDir, 'proj-im-1');

  const main = makeCas({
    timestamp: '2026-01-01T00:00:00.000Z',
    nodes: [
      { id: 'sym:billingHandler', name: 'billingHandler', file: 'src/billing.ts', return_type: 'void' },
      { id: 'sym:renderProfile', name: 'renderProfile', file: 'src/profile.ts', return_type: 'string' },
    ],
  });
  const inflight = makeCas({
    timestamp: '2026-01-01T00:05:00.000Z',
    nodes: [
      { id: 'sym:billingHandler', name: 'billingHandler', file: 'src/billing.ts', return_type: 'Promise<void>' }, // agent-a
      { id: 'sym:renderProfile', name: 'renderProfile', file: 'src/profile.ts', return_type: 'HtmlString' }, // agent-b
    ],
  });
  await saveAnalysis(workspace, main, 'main');
  await saveAnalysis(workspace, inflight, 'in-flight');

  await appendClaim(workspace, makeClaim(workspace, {
    claim_id: 'claim-a', agent_id: 'agent-a', intent: 'add caching to billingHandler',
    scope: { repo: workspace, paths: ['src/billing.ts'], symbols: [] },
  }));
  await appendClaim(workspace, makeClaim(workspace, {
    claim_id: 'claim-b', agent_id: 'agent-b', intent: 'add avatar to renderProfile',
    scope: { repo: workspace, paths: ['src/profile.ts'], symbols: [] },
  }));

  const substrateCas: ConflictCas = {
    nodes: [
      { id: 'sym:billingHandler', name: 'billingHandler' },
      { id: 'sym:renderProfile', name: 'renderProfile' },
    ],
    edges: [],
  };

  const plan = await planIntentMergeFromSubstrate(workspace, substrateCas);
  assert.equal(plan.attribution.source, 'workspace-semantic-fallback');
  assert.equal(plan.attribution.participants, 2);
  assert.equal(plan.attribution.unattributed, 0);
  assert.equal(plan.merge_decisions_required, 0);
  assert.equal(plan.needs_resolution.length, 0);
  assert.equal(plan.duplicate_work.length, 0);
  assert.equal(plan.auto_mergeable.length, 2);
  // Each symbol's rationale should name only ITS OWN agent, never the other's.
  const billing = plan.auto_mergeable.find((e) => e.symbol === 'sym:billingHandler')!;
  const profile = plan.auto_mergeable.find((e) => e.symbol === 'sym:renderProfile')!;
  assert.deepEqual(billing.agents, ['agent-a']);
  assert.deepEqual(profile.agents, ['agent-b']);

  await env.cleanup();
});

test('planIntentMergeFromSubstrate: SPEC §3.2 regression — a shared-tree delta ambient git would union is split by claim scope, not credited to the wrong agent', async () => {
  const env = await freshEnv();
  const workspace = path.join(env.storageDir, 'proj-im-2');

  // A SINGLE shared working tree with edits from two agents in two different
  // files. Ambient `git diff` run by either agent's process would see BOTH
  // changes (the union) and, per §3.2, `plan_intent_merge`'s old git-ambient
  // path would have credited whichever agent asked with BOTH edits. The
  // substrate path must split this by claim scope instead.
  const main = makeCas({
    timestamp: '2026-01-01T00:00:00.000Z',
    nodes: [
      { id: 'sym:a', name: 'aFn', file: 'src/a.ts', return_type: 'number' },
      { id: 'sym:b', name: 'bFn', file: 'src/b.ts', return_type: 'number' },
    ],
  });
  const inflight = makeCas({
    timestamp: '2026-01-01T00:05:00.000Z',
    nodes: [
      { id: 'sym:a', name: 'aFn', file: 'src/a.ts', return_type: 'string' }, // only agent-a's real edit
      { id: 'sym:b', name: 'bFn', file: 'src/b.ts', return_type: 'string' }, // only agent-b's real edit
    ],
  });
  await saveAnalysis(workspace, main, 'main');
  await saveAnalysis(workspace, inflight, 'in-flight');

  await appendClaim(workspace, makeClaim(workspace, {
    claim_id: 'claim-a', agent_id: 'agent-a', intent: 'edit aFn',
    scope: { repo: workspace, paths: ['src/a.ts'], symbols: [] },
  }));
  await appendClaim(workspace, makeClaim(workspace, {
    claim_id: 'claim-b', agent_id: 'agent-b', intent: 'edit bFn',
    scope: { repo: workspace, paths: ['src/b.ts'], symbols: [] },
  }));

  const substrateCas: ConflictCas = {
    nodes: [{ id: 'sym:a', name: 'aFn' }, { id: 'sym:b', name: 'bFn' }],
    edges: [],
  };

  const plan = await planIntentMergeFromSubstrate(workspace, substrateCas);
  assert.equal(plan.attribution.participants, 2);
  assert.equal(plan.merge_decisions_required, 0, 'genuinely disjoint work must never be reported as a merge decision');

  const aEntry = plan.auto_mergeable.find((e) => e.symbol === 'sym:a')!;
  const bEntry = plan.auto_mergeable.find((e) => e.symbol === 'sym:b')!;
  // The regression itself: agent-a must NOT be credited with sym:b (agent-b's edit), and
  // vice versa — a git-ambient union would have put both agents on both symbols.
  assert.deepEqual(aEntry.agents, ['agent-a']);
  assert.deepEqual(bEntry.agents, ['agent-b']);

  await env.cleanup();
});

// ---------------------------------------------------------------------------
// W4 step 2: surprise push — planIntentMergeFromSubstrate persists each
// contract-divergence surprise to the claim log, addressed to the affected
// agent, deduped on re-plan.
// ---------------------------------------------------------------------------

/** Build a workspace with a genuine contract-divergence: agent-a drops
 *  getUser's nullability, agent-b concurrently edits renderProfile, a real
 *  caller (per the CAS "calls" edge) of getUser. */
async function setupContractDivergenceWorkspace(workspace: string): Promise<ConflictCas> {
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

  return {
    nodes: [
      { id: 'sym:getUser', name: 'getUser' },
      { id: 'sym:renderProfile', name: 'renderProfile' },
    ],
    edges: [{ source: 'sym:renderProfile', target: 'sym:getUser', type: 'calls' }],
  };
}

test('planIntentMergeFromSubstrate: a contract-divergence surprise is persisted once, addressed to the AFFECTED agent, and deduped on re-plan', async () => {
  const env = await freshEnv();
  const workspace = path.join(env.storageDir, 'proj-surprise-1');
  const cas = await setupContractDivergenceWorkspace(workspace);

  const plan = await planIntentMergeFromSubstrate(workspace, cas);
  assert.ok(plan.surprises.length >= 1, 'the contract-divergence finding must surface as a surprise');
  const surprise = plan.surprises.find((s) => s.symbol === 'sym:getUser')!;
  assert.ok(surprise);
  assert.deepEqual([...surprise.agents].sort(), ['agent-a', 'agent-b']);

  // agent-b (the caller-editor) is the one who'd learn of this at merge time —
  // it must be persisted addressed to agent-b, never agent-a (the changer).
  const forChanger = await readSurprisesFor(workspace, 'agent-a');
  const forAffected = await readSurprisesFor(workspace, 'agent-b');
  assert.equal(forChanger.length, 0, 'the surprise must not be addressed to the agent who MADE the contract change');
  assert.equal(forAffected.length, 1);
  assert.equal(forAffected[0].symbol, 'sym:getUser');
  assert.equal(forAffected[0].changer, 'agent-a');
  assert.equal(forAffected[0].affected, 'agent-b');

  // Re-planning the identical scenario must NOT append a second entry for the
  // same (symbol, changer, affected) — dedup, not spam.
  await planIntentMergeFromSubstrate(workspace, cas);
  const afterReplan = await readSurprisesFor(workspace, 'agent-b');
  assert.equal(afterReplan.length, 1, 're-planning the same finding must dedupe, not append a duplicate');

  await env.cleanup();
});

test('readSurprisesFor: returns nothing for an unrelated agent (surprises are addressed, not broadcast)', async () => {
  const env = await freshEnv();
  const workspace = path.join(env.storageDir, 'proj-surprise-2');
  const cas = await setupContractDivergenceWorkspace(workspace);

  await planIntentMergeFromSubstrate(workspace, cas);

  const forBystander = await readSurprisesFor(workspace, 'agent-z');
  assert.deepEqual(forBystander, []);

  await env.cleanup();
});
