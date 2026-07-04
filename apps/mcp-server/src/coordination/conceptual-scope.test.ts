import test from 'node:test';
import assert from 'node:assert/strict';

import { computeFlowConcepts } from '../../../../packages/analyzer-core/src/analyzer/core/flow-concepts';
import type {
  CASOutput,
  CASNode,
  CASEdge,
  CASEntryPoint,
  CASExitPoint,
  CASEntityLineage,
  CASDataEntity,
  SystemCapability,
} from '../../../../packages/analyzer-core/src/types/cas.types';

import {
  buildConceptIndex,
  deriveConceptualCoordinate,
  deriveConceptualCoordinates,
  compareConceptualCoordinates,
  compareClaimsConceptually,
  withDerivedConcept,
} from './conceptual-scope';
import type { WorkClaim } from './types';

function node(overrides: Partial<CASNode> & { id: string; name: string; type: string }): CASNode {
  return { qualified_name: overrides.name, ...overrides } as CASNode;
}

/**
 * Fixture: a real two-flow CAS (mirrors flow-concepts.test.ts's shape) —
 *   Checkout flow: handleCheckout -> validateCart (guard) -> chargeCard
 *     (external payment call, step "Charge") -> saveOrder (persist, step
 *     "Persist Order") -- entity Order's constraints enforced by validateCart.
 *   Refund flow: handleRefund -> validateRefund (guard) -> issueRefund
 *     (external) -- entity Order's constraints ALSO enforced here (refund
 *     eligibility), giving a real cross-flow same-entity case.
 */
function buildTwoFlowCas(): CASOutput {
  const nodes: CASNode[] = [
    node({ id: 'n_handleCheckout', name: 'handleCheckout', type: 'controller', category: 'entry' }),
    node({
      id: 'n_validateCart',
      name: 'validateCart',
      type: 'function',
      category: 'business',
      source: {
        file: 'src/checkout/validate.ts',
        line: 1,
        end_line: 10,
        raw: [
          'function validateCart(cart) {',
          '  if (!cart.total > 0) {',
          '    throw new Error("total must be positive");',
          '  }',
          '  return true;',
          '}',
        ].join('\n'),
      },
    }),
    node({ id: 'n_chargeCard', name: 'chargeCard', type: 'function', category: 'business' }),
    node({ id: 'n_saveOrder', name: 'saveOrder', type: 'function', category: 'data' }),

    node({ id: 'n_handleRefund', name: 'handleRefund', type: 'controller', category: 'entry' }),
    node({
      id: 'n_validateRefund',
      name: 'validateRefund',
      type: 'function',
      category: 'business',
      source: {
        file: 'src/refund/validate.ts',
        line: 1,
        end_line: 10,
        raw: [
          'function validateRefund(order) {',
          '  if (!order.total > 0) {',
          '    throw new Error("total must be positive");',
          '  }',
          '  return true;',
          '}',
        ].join('\n'),
      },
    }),
    node({ id: 'n_issueRefund', name: 'issueRefund', type: 'function', category: 'business' }),
  ];

  const edges: CASEdge[] = [
    { id: 'e1', source: 'n_handleCheckout', target: 'n_validateCart', type: 'calls' },
    { id: 'e2', source: 'n_validateCart', target: 'n_chargeCard', type: 'calls' },
    { id: 'e3', source: 'n_chargeCard', target: 'n_saveOrder', type: 'calls' },
    { id: 'e4', source: 'n_handleRefund', target: 'n_validateRefund', type: 'calls' },
    { id: 'e5', source: 'n_validateRefund', target: 'n_issueRefund', type: 'calls' },
  ];

  const entry_points: CASEntryPoint[] = [
    {
      id: 'ep_checkout',
      source_node: 'n_handleCheckout',
      type: 'http',
      name: 'checkout',
      trigger: { method: 'POST', path: '/checkout' },
      handler: { node_id: 'n_handleCheckout', method_name: 'handleCheckout' },
      security: { authenticated: true },
    },
    {
      id: 'ep_refund',
      source_node: 'n_handleRefund',
      type: 'http',
      name: 'refund',
      trigger: { method: 'POST', path: '/refund' },
      handler: { node_id: 'n_handleRefund', method_name: 'handleRefund' },
      security: { authenticated: true },
    },
  ];

  const exit_points: CASExitPoint[] = [
    { id: 'xp_chargeCard', source_node: 'n_chargeCard', type: 'api', name: 'chargeCard', target: { service_id: 'payments-service' } } as CASExitPoint,
    { id: 'xp_saveOrder', source_node: 'n_saveOrder', type: 'database', name: 'saveOrder', target: { resource: 'orders_table' } } as CASExitPoint,
    { id: 'xp_issueRefund', source_node: 'n_issueRefund', type: 'api', name: 'issueRefund', target: { service_id: 'payments-service' } } as CASExitPoint,
  ];

  const data_lineage: CASEntityLineage[] = [
    {
      entity_id: 'entity_order',
      entity_name: 'Order',
      sensitive_fields: [],
      writers: [{ node_id: 'n_saveOrder' } as any],
      readers: [{ node_id: 'n_validateCart' } as any, { node_id: 'n_validateRefund' } as any],
      external_recipients: [],
      boundaries_crossed: [],
      journeys_carrying: [],
      exposure: { unguarded_paths: 0, external_transfer: false, sensitive: false },
    },
  ];

  const data_entities: CASDataEntity[] = [
    {
      id: 'entity_order',
      name: 'Order',
      lifecycle: { created_by: ['n_saveOrder'], read_by: ['n_validateCart', 'n_validateRefund'], updated_by: [], deleted_by: [] },
      invariants: [
        { description: 'order total must be positive', enforced_by: ['n_validateCart', 'n_validateRefund'], source: 'validation' },
      ],
    },
  ];

  const system_capabilities: SystemCapability[] = [
    {
      id: 'cap_checkout',
      name: 'Checkout',
      description: 'Process a checkout',
      category: 'core',
      operations: [{ entry_point_id: 'ep_checkout', entry_point_type: 'http', action: 'create' }],
      related_entities: ['Order'],
      related_domains: [],
      criticality: 'high',
      criticality_factors: [],
    },
  ];

  return {
    nodes,
    edges,
    entry_points,
    exit_points,
    data_lineage,
    data_entities,
    system_capabilities,
  } as unknown as CASOutput;
}

test('deriveConceptualCoordinate maps a claimed file/symbol to a real flow step', () => {
  const cas = buildTwoFlowCas();
  const flows = computeFlowConcepts(cas);
  const index = buildConceptIndex(flows);

  const coord = deriveConceptualCoordinate({ scope: { paths: [], symbols: ['n_chargeCard'] } }, index);
  assert.ok(coord, 'expected a derived coordinate for n_chargeCard');
  assert.equal(coord!.flow_id, 'flow::ep_checkout');
  assert.equal(coord!.capability_id, 'cap_checkout');
  assert.equal(coord!.source, 'derived');
  assert.ok(coord!.step_id, 'expected a step_id');
});

test('a claim with no matching file/symbol derives no concept (honest degrade)', () => {
  const cas = buildTwoFlowCas();
  const flows = computeFlowConcepts(cas);
  const index = buildConceptIndex(flows);

  const coord = deriveConceptualCoordinate({ scope: { paths: ['totally/unrelated.ts'], symbols: ['nonexistentFn'] } }, index);
  assert.equal(coord, undefined);
});

test('same flow, different step -> awareness (SAFE, not a conflict)', () => {
  const cas = buildTwoFlowCas();
  const flows = computeFlowConcepts(cas);
  const index = buildConceptIndex(flows);

  const coordA = deriveConceptualCoordinate({ scope: { paths: [], symbols: ['n_chargeCard'] } }, index); // "Charge" step
  const coordB = deriveConceptualCoordinate({ scope: { paths: [], symbols: ['n_saveOrder'] } }, index); // "Persist" step
  assert.ok(coordA && coordB);
  assert.equal(coordA!.flow_id, coordB!.flow_id, 'both should resolve to the checkout flow');
  assert.notEqual(coordA!.step_id, coordB!.step_id, 'should be different steps');

  const cmp = compareConceptualCoordinates(coordA, coordB);
  assert.equal(cmp.verdict, 'awareness');
  assert.equal(cmp.shared_flow_id, coordA!.flow_id);
  assert.match(cmp.reason, /DIFFERENT steps/);
});

test('same flow, SAME step -> conceptual_conflict', () => {
  const cas = buildTwoFlowCas();
  const flows = computeFlowConcepts(cas);
  const index = buildConceptIndex(flows);

  const coordA = deriveConceptualCoordinate({ scope: { paths: [], symbols: ['n_chargeCard'] } }, index);
  // Same step as A: n_validateCart and n_chargeCard segment together only if
  // character/layer match; to guarantee "same step" deterministically, derive
  // both from the SAME symbol.
  const coordB = deriveConceptualCoordinate({ scope: { paths: [], symbols: ['n_chargeCard'] } }, index);
  assert.ok(coordA && coordB);

  const cmp = compareConceptualCoordinates(coordA, coordB);
  assert.equal(cmp.verdict, 'conceptual_conflict');
  assert.equal(cmp.shared_step_id, coordA!.step_id);
  assert.match(cmp.reason, /SAME step/);
});

test('different flows but same entity constraints -> conceptual_conflict (cross-file case)', () => {
  const cas = buildTwoFlowCas();
  const flows = computeFlowConcepts(cas);
  const index = buildConceptIndex(flows);

  // n_validateCart (Checkout flow) and n_validateRefund (Refund flow) both
  // enforce the Order entity's "total must be positive" invariant — different
  // files, different flows, same entity constraint.
  const coordCheckout = deriveConceptualCoordinate({ scope: { paths: [], symbols: ['n_validateCart'] } }, index);
  const coordRefund = deriveConceptualCoordinate({ scope: { paths: [], symbols: ['n_validateRefund'] } }, index);
  assert.ok(coordCheckout && coordRefund);
  assert.notEqual(coordCheckout!.flow_id, coordRefund!.flow_id, 'refund has no capability_id-bearing flow_id match to checkout');
  assert.ok(coordCheckout!.entities?.includes('Order'));
  assert.ok(coordRefund!.entities?.includes('Order'));

  const cmp = compareConceptualCoordinates(coordCheckout, coordRefund);
  assert.equal(cmp.verdict, 'conceptual_conflict');
  assert.deepEqual(cmp.shared_entities, ['Order']);
  assert.match(cmp.reason, /SAME entity/);
});

test('unrelated coordinates (no shared flow, no shared entity) -> unrelated', () => {
  const cmp = compareConceptualCoordinates(
    { flow_id: 'flow::a', step_id: 'a::step0', entities: ['Widget'] },
    { flow_id: 'flow::b', step_id: 'b::step0', entities: ['Gadget'] }
  );
  assert.equal(cmp.verdict, 'unrelated');
});

test('declared coordinate always wins over derived (withDerivedConcept never overrides)', () => {
  const cas = buildTwoFlowCas();
  const flows = computeFlowConcepts(cas);
  const index = buildConceptIndex(flows);

  const claim = {
    scope: {
      paths: [] as string[],
      symbols: ['n_chargeCard'],
      concept: { flow_id: 'flow::hand-declared', step_id: 'declared::step0', source: 'declared' as const },
    },
  };
  const withConcept = withDerivedConcept(claim, index);
  assert.equal(withConcept.scope.concept!.flow_id, 'flow::hand-declared', 'declared concept must not be overridden');
});

test('withDerivedConcept fills in a concept for a claim that declared none', () => {
  const cas = buildTwoFlowCas();
  const flows = computeFlowConcepts(cas);
  const index = buildConceptIndex(flows);

  const claim: { scope: { paths: string[]; symbols: string[]; concept?: import('./types').ConceptualCoordinate } } = {
    scope: { paths: [], symbols: ['n_chargeCard'] },
  };
  const withConcept = withDerivedConcept(claim, index);
  assert.ok(withConcept.scope.concept, 'expected an auto-derived concept');
  assert.equal(withConcept.scope.concept!.source, 'derived');
});

test('compareClaimsConceptually derives on the fly from raw claims + index', () => {
  const cas = buildTwoFlowCas();
  const flows = computeFlowConcepts(cas);
  const index = buildConceptIndex(flows);

  const claimA: Pick<WorkClaim, 'scope'> = { scope: { repo: 'r', paths: [], symbols: ['n_chargeCard'] } as any };
  const claimB: Pick<WorkClaim, 'scope'> = { scope: { repo: 'r', paths: [], symbols: ['n_saveOrder'] } as any };
  const cmp = compareClaimsConceptually(claimA, claimB, index);
  assert.equal(cmp.verdict, 'awareness');
});

test('deriveConceptualCoordinates returns [] when no flows exist at all (empty index)', () => {
  const index = buildConceptIndex([]);
  const coords = deriveConceptualCoordinates({ scope: { paths: ['x.ts'], symbols: ['fn'] } }, index);
  assert.deepEqual(coords, []);
});
