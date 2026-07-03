import test from 'node:test';
import assert from 'node:assert/strict';

import { planIntentMerge } from './intent-merge';
import type { AgentInFlightState, ConflictCas } from './conceptual-conflict';

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
