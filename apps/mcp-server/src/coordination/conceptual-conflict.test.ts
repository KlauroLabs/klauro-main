import test from 'node:test';
import assert from 'node:assert/strict';

import { detectConceptualConflicts } from './conceptual-conflict';
import type { AgentInFlightState, ConflictCas, InvariantInterpreter } from './conceptual-conflict';

const cas: ConflictCas = {
  nodes: [
    { id: 'sym:getUser', name: 'getUser' },
    { id: 'sym:renderProfile', name: 'renderProfile' },
    { id: 'sym:billingHandler', name: 'billingHandler' },
    { id: 'sym:render', name: 'render' },
    { id: 'sym:otherModule', name: 'otherModule' },
  ],
  edges: [
    { source: 'sym:renderProfile', target: 'sym:getUser', type: 'calls' },
  ],
};

test('contract-divergence: nullability retype + concurrent caller edit', () => {
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
        {
          symbol_id: 'sym:renderProfile',
          name: 'renderProfile',
          file: 'src/profile.ts',
          change_kind: 'body',
          before: {},
          after: {},
        },
      ],
    },
  ];

  const conflicts = detectConceptualConflicts(states, cas);
  const found = conflicts.filter((c) => c.kind === 'contract-divergence');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'high');
  assert.equal(found[0].passes_textual_merge, true);
  assert.deepEqual([...found[0].agents].sort(), ['agent-a', 'agent-b']);
});

test('duplicate-work: two agents add the same symbol with overlapping intent', () => {
  const states: AgentInFlightState[] = [
    {
      agent_id: 'agent-a',
      intent: 'add retry logic with backoff to billingHandler',
      changes: [
        {
          symbol_id: 'sym:retryBilling',
          name: 'retryBilling',
          file: 'src/billing.ts',
          change_kind: 'add',
        },
      ],
    },
    {
      agent_id: 'agent-b',
      intent: 'add retry with exponential backoff to billingHandler for reliability',
      changes: [
        {
          symbol_id: 'sym:retryBillingV2',
          name: 'retryBilling',
          file: 'src/billing-v2.ts',
          change_kind: 'add',
        },
      ],
    },
  ];

  const conflicts = detectConceptualConflicts(states, cas);
  const found = conflicts.filter((c) => c.kind === 'duplicate-work');
  assert.equal(found.length, 1);
  assert.equal(found[0].passes_textual_merge, true);
});

test('structural-divergence: split render while a new caller references the old form', () => {
  const states: AgentInFlightState[] = [
    {
      agent_id: 'agent-a',
      intent: 'split render into render + renderHeader for reuse',
      changes: [
        {
          symbol_id: 'sym:render',
          name: 'render',
          file: 'src/view.ts',
          change_kind: 'split',
          before: { name: 'render' },
          after: { split_into: ['sym:render2', 'sym:renderHeader'] },
        },
      ],
    },
    {
      agent_id: 'agent-b',
      intent: 'add a new widget that calls render() directly',
      changes: [
        {
          symbol_id: 'sym:newWidget',
          name: 'newWidget',
          file: 'src/widget.ts',
          change_kind: 'add',
          after: { signature: 'function newWidget() { return render(); }' },
        },
      ],
    },
  ];

  const conflicts = detectConceptualConflicts(states, cas);
  const found = conflicts.filter((c) => c.kind === 'structural-divergence');
  assert.equal(found.length, 1);
  assert.equal(found[0].passes_textual_merge, true);
});

test('behavior-drift: guard added by A, appended code by B on same symbol body', () => {
  const states: AgentInFlightState[] = [
    {
      agent_id: 'agent-a',
      intent: 'add early-return guard to billingHandler for invalid input',
      changes: [
        {
          symbol_id: 'sym:billingHandler',
          name: 'billingHandler',
          file: 'src/billing.ts',
          change_kind: 'body',
          after: { body_tags: ['early-return'] },
        },
      ],
    },
    {
      agent_id: 'agent-b',
      intent: 'append audit logging to billingHandler',
      changes: [
        {
          symbol_id: 'sym:billingHandler',
          name: 'billingHandler',
          file: 'src/billing.ts',
          change_kind: 'body',
          after: { body_tags: ['appends-after'] },
        },
      ],
    },
  ];

  const conflicts = detectConceptualConflicts(states, cas);
  const found = conflicts.filter((c) => c.kind === 'behavior-drift');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'medium');
  assert.match(found[0].explanation, /HEURISTIC/);
});

test('non-conflict control: two disjoint, unrelated changes yield zero conflicts', () => {
  const states: AgentInFlightState[] = [
    {
      agent_id: 'agent-a',
      intent: 'fix typo in otherModule docs comment',
      changes: [
        {
          symbol_id: 'sym:otherModule',
          name: 'otherModule',
          file: 'src/other.ts',
          change_kind: 'body',
          after: {},
        },
      ],
    },
    {
      agent_id: 'agent-b',
      intent: 'add a brand new unrelated utility function',
      changes: [
        {
          symbol_id: 'sym:formatCurrency',
          name: 'formatCurrency',
          file: 'src/format.ts',
          change_kind: 'add',
        },
      ],
    },
  ];

  const conflicts = detectConceptualConflicts(states, cas);
  assert.equal(conflicts.length, 0);
});

test('invariant-conflict: off by default (no interpreter supplied) — deterministic detectors unaffected', () => {
  const states: AgentInFlightState[] = [
    {
      agent_id: 'agent-a',
      intent: 'make billingHandler idempotent',
      changes: [
        { symbol_id: 'sym:billingHandler', name: 'billingHandler', file: 'src/billing.ts', change_kind: 'body' },
      ],
    },
    {
      agent_id: 'agent-b',
      intent: 'add a side effect to billingHandler',
      changes: [
        { symbol_id: 'sym:billingHandler', name: 'billingHandler', file: 'src/billing.ts', change_kind: 'body' },
      ],
    },
  ];

  const withoutInterpreter = detectConceptualConflicts(states, cas);
  assert.equal(withoutInterpreter.filter((c) => c.kind === 'invariant-conflict').length, 0);

  const interpreter: InvariantInterpreter = (intent) =>
    /idempotent/.test(intent) ? [{ symbol: 'billingHandler', invariant: 'idempotent' }] : [];

  const withInterpreter = detectConceptualConflicts(states, cas, { invariantInterpreter: interpreter });
  const found = withInterpreter.filter((c) => c.kind === 'invariant-conflict');
  assert.equal(found.length, 1);
  assert.equal(found[0].passes_textual_merge, true);
});
