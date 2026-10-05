import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tierStackToCas } from './tier-stack-to-cas';
import type { TierStackIndex } from './read-tier-stack';
import { validateCasTree } from '../../types/cas-tree-validation';

const INDEX: TierStackIndex = {
  root: '/tmp/shop',
  files: [{ path: 'src/order.ts', kind: 'source', language: 'typescript', extracted: true }],
  nodes: [
    { id: 'src/order.ts', name: 'order.ts', kind: 'module', file: 0, span: { line: 1 } },
    {
      id: 'src/order.ts:class:Order:4',
      name: 'Order',
      kind: 'class',
      file: 0,
      span: { line: 4, end_line: 9 },
      parent: 'src/order.ts',
      documentation: 'An order a customer placed.',
    },
  ],
  edges: [
    { source: 'src/order.ts', target: 'src/order.ts:class:Order:4', kind: 'contains' },
    { source: 'src/order.ts:class:Order:4', target: 'src/order.ts:field:total:6', kind: 'has_field' },
  ],
  entry_points: [
    {
      id: 'entry:place',
      kind: 'http',
      name: '/orders',
      method: 'POST',
      path: '/orders',
      handler: 'src/order.ts:function:place:12',
      file: 0,
      line: 12,
      registrar: 'router.post',
    },
  ],
  exit_points: [
    { id: 'exit:save', kind: 'database', source: 'src/order.ts:function:place:12', target: 'orders.insert', file: 0, line: 14 },
  ],
  dependencies: { dependencies: [{ name: 'express', role: 'library', imports: 3 }] },
  architecture: { shape: 'single served surface' },
  comprehension: {
    entities: [
      {
        id: 'entity:Order',
        declared_as: 'Order',
        name: 'Order',
        named_fields: [
          { name: 'id', declared_as: 'uuid' },
          { name: 'customerId', declared_as: 'uuid' },
          { name: 'total', declared_as: 'numeric' },
        ],
        fields: 3,
        addressed_by: 2,
        written_by: ['src/order.ts:function:place:12'],
        read_by: [],
        references: [
          { field: 'customerId', entity: 'Customer', declared_by: 'foreign key' },
          { field: 'lines', entity: 'OrderLine', many: true, declared_by: 'type' },
        ],
      },
    ],
    flows: [
      {
        id: 'flow:place',
        entry_point: 'entry:place',
        kind: 'http',
        operation: 'place an order',
        standing: 'terminal',
        writes: ['Order'],
        reads: ['Customer'],
      },
    ],
  },
};

test('the tier stack answers with an analysis the product can read', () => {
  const cas = tierStackToCas(INDEX);
  assert.equal(cas.cas_version, '3.0.0');
  assert.equal(cas.system.name, 'shop');
  assert.equal(cas.system.root_path, '/tmp/shop');
  assert.equal(cas.system.type, 'application');
  assert.ok(cas.analysis_id.length > 0);
  assert.ok(cas.analysis_timestamp.length > 0);
  assert.equal(cas.analyzer_contributions[0].analyzer_id, 'tier-stack');
  assert.equal(cas.analyzer_contributions[0].nodes_created, 2);
});

test('an app that serves nothing but ships to a device is an application, not a library', () => {
  const served = (shape: string, category: 'shipped' | 'library') =>
    tierStackToCas({
      ...INDEX,
      architecture: { shape },
      scope: { deployables: [{ id: 'deployable:app', name: 'app', root: 'app', category, declarations: [] }] },
    }).system.type;
  assert.equal(served('no served surface', 'shipped'), 'application');
  assert.equal(served('no served surface', 'library'), 'library');
});

test('a declaration keeps its kind, its place and what it says of itself', () => {
  const cas = tierStackToCas(INDEX);
  const order = cas.nodes.find(node => node.name === 'Order');
  assert.equal(order?.type, 'class');
  assert.equal(order?.parent, 'src/order.ts');
  assert.equal(order?.source?.file, 'src/order.ts');
  assert.equal(order?.source?.line, 4);
  assert.equal(order?.description, 'An order a customer placed.');
  assert.equal(order?.description_source, 'deterministic');
  assert.equal(order?.metadata?.language, 'typescript');
});

test('a declaration sits at the depth its holders put it', () => {
  const cas = tierStackToCas(INDEX);
  assert.equal(cas.nodes.find(node => node.name === 'order.ts')?.level, 1);
  assert.equal(cas.nodes.find(node => node.name === 'Order')?.level, 2);
  assert.equal(cas.progressive_levels.total_levels, 2);
  assert.deepEqual(
    cas.progressive_levels.level_definitions?.map(held => [held.level, held.node_count]),
    [[1, 1], [2, 1]]
  );
});

test('an edge keeps the relation it stands for', () => {
  const cas = tierStackToCas(INDEX);
  assert.deepEqual(
    cas.edges.map(edge => edge.type),
    ['contains', 'has_property']
  );
});

test('a surface and the call that leaves keep their names', () => {
  const cas = tierStackToCas(INDEX);
  assert.equal(cas.entry_points?.[0].name, '/orders');
  assert.equal(cas.entry_points?.[0].source_node, 'src/order.ts:function:place:12');
  assert.equal(cas.exit_points?.[0].type, 'database');
  assert.equal(cas.exit_points?.[0].name, 'orders.insert');
});

test('a record keeps its fields and the records it points at', () => {
  const cas = tierStackToCas(INDEX);
  const order = cas.entities?.[0];
  assert.equal(order?.name, 'Order');
  assert.deepEqual(order?.fields?.map(field => [field.name, field.type, field.is_relation]), [
    ['id', 'uuid', false],
    ['customerId', 'uuid', true],
    ['total', 'numeric', false],
  ]);
  assert.deepEqual(order?.relations?.map(relation => [
    relation.field,
    relation.target_name,
    relation.cardinality,
    relation.evidence_source,
  ]), [
    ['customerId', 'Customer', 'N:1', 'orm-declaration'],
    ['lines', 'OrderLine', '1:N', 'typed-composition'],
  ]);
  assert.deepEqual(order?.lifecycle.created_by, ['src/order.ts:function:place:12']);
});

test('a flow keeps the surface it starts from and the records it touches', () => {
  const cas = tierStackToCas(INDEX);
  const flow = cas.flows?.[0];
  assert.equal(flow?.flow_id, 'flow:place');
  assert.equal(flow?.name, 'place an order');
  assert.equal(flow?.entry_point, 'entry:place');
  assert.deepEqual(flow?.entities, ['Order', 'Customer']);
  assert.deepEqual(flow?.contract.input, ['Customer']);
  assert.deepEqual(flow?.contract.side_effects.state_changes, ['Order']);
  assert.equal(flow?.contract.logic, 'place an order');
});

test('a declared package is carried across', () => {
  const cas = tierStackToCas(INDEX);
  assert.deepEqual(cas.dependencies?.packages, [{ name: 'express', version: '', direct: true }]);
});

test('a repository of several parts composes a CAS tree that conforms', () => {
  const parted: TierStackIndex = {
    ...INDEX,
    files: [
      { path: 'api/order.ts', kind: 'source', language: 'typescript', extracted: true },
      { path: 'web/cart.ts', kind: 'source', language: 'typescript', extracted: true },
    ],
    nodes: [
      { id: 'api/order.ts', name: 'order.ts', kind: 'module', file: 0, span: { line: 1 }, project: 'subproject:api' },
      { id: 'web/cart.ts', name: 'cart.ts', kind: 'module', file: 1, span: { line: 1 }, project: 'subproject:root' },
    ],
    edges: [],
    partition: {
      sub_projects: [
        { id: 'subproject:api', name: 'api', root: 'api' },
        { id: 'subproject:root', name: 'shop', root: '' },
      ],
    },
  } as TierStackIndex;
  const tree = tierStackToCas(parted, 'shop');
  const seen = validateCasTree(tree);
  assert.deepEqual(seen.issues, [], 'a composed tree carries its ids, its parents and how it was composed');
  assert.equal(seen.valid, true);
  assert.equal(tree.composition_mode, 'derived');
  assert.equal(tree.parent_id, null);
  for (const child of tree.children ?? []) assert.equal(child.parent_id, tree.id);
  const ids = [tree.id, ...(tree.children ?? []).map(child => child.id)];
  assert.equal(new Set(ids).size, ids.length, 'a part rooted at the repository root is not the repository');
});

test('a flow in one part that reaches a flow in another part is a seam between them', () => {
  const linked = {
    ...INDEX,
    partition: {
      sub_projects: [
        { id: 'subproject:orders', name: 'Ordering.API', root: 'orders' },
        { id: 'subproject:payments', name: 'PaymentProcessor', root: 'payments' },
      ],
    },
    comprehension: {
      flows: [
        {
          id: 'flow:confirm',
          entry_point: 'entry:confirm',
          kind: 'event',
          operation: 'OrderStockConfirmed',
          standing: 'terminal',
          project: 'subproject:orders',
          leads_into: ['entry:pay'],
        },
        {
          id: 'flow:pay',
          entry_point: 'entry:pay',
          kind: 'message',
          operation: 'OrderStatusChangedToStockConfirmedIntegrationEvent',
          standing: 'terminal',
          project: 'subproject:payments',
        },
      ],
    },
  } as unknown as TierStackIndex;
  const seams = tierStackToCas(linked, 'shop').communication_seams;
  assert.equal(seams?.seams.length, 1);
  assert.equal(seams?.seams[0].source, 'Ordering.API');
  assert.equal(seams?.seams[0].target, 'PaymentProcessor');
  assert.equal(seams?.seams[0].modality, 'async');
  assert.equal(seams?.inventory.counts.async, 1);
});

test('a part whose flows reach an outside service has a seam to that service', () => {
  const reaching = {
    ...INDEX,
    partition: { sub_projects: [{ id: 'subproject:app', name: 'app', root: 'app' }] },
    comprehension: {
      flows: [
        { id: 'flow:sync', entry_point: 'entry:sync', kind: 'background', operation: 'Sync', standing: 'terminal', project: 'subproject:app', reaches: ['weather'] },
        { id: 'flow:refresh', entry_point: 'entry:refresh', kind: 'ui', operation: 'Refresh', standing: 'terminal', project: 'subproject:app', reaches: ['weather'] },
      ],
    },
  } as unknown as TierStackIndex;
  const seams = tierStackToCas(reaching, 'shop').communication_seams;
  assert.equal(seams?.seams.length, 1);
  assert.equal(seams?.seams[0].source, 'app');
  assert.equal(seams?.seams[0].target, 'weather');
  assert.equal(seams?.seams[0].modality, 'sync');
});

test('a whole-system capability carries the child capabilities it was derived from as composition provenance', () => {
  const derived = {
    ...INDEX,
    partition: {
      sub_projects: [
        { id: 'subproject:api', name: 'api', root: 'api' },
        { id: 'subproject:web', name: 'web', root: 'web' },
      ],
    },
    entry_points: [
      { id: 'entry:place', kind: 'http', name: '/orders', method: 'POST', path: '/orders', handler: 'api/order.ts:function:place:1', file: 0, line: 1, registrar: 'router.post' },
    ],
    comprehension: {
      flows: [
        { id: 'flow:place', entry_point: 'entry:place', kind: 'http', operation: '/orders', standing: 'terminal', project: 'subproject:api' },
      ],
      capabilities: [
        { id: 'capability:place-an-order', name: 'Place an order', project: 'subproject:api', flows: ['flow:place'] },
        {
          id: 'capability:order-goods',
          name: 'Order goods',
          also_in: ['subproject:api'],
          flows: ['flow:place'],
          composition_provenance: [
            { source_child: 'subproject:api', source_capability_id: 'capability:place-an-order', disposition: 'promoted', weight: 0.9 },
          ],
          parent_originated: { kind: 'seam', evidence: ['web to api (http, sync)'] },
        },
      ],
    },
  } as TierStackIndex;
  const tree = tierStackToCas(derived, 'shop');
  const whole = tree.capabilities.find(held => held.id === 'capability:order-goods');
  assert.ok(whole);
  assert.deepEqual(whole.composition_provenance, [
    {
      source_child_id: 'cas:shop:subproject:api',
      source_capability_id: 'capability:place-an-order',
      source_node_ids: ['api/order.ts:function:place:1'],
      source_flow_ids: ['flow:place'],
      relation_path: [],
      confidence: 0.9,
      disposition: 'promoted',
    },
  ]);
  assert.deepEqual(whole.parent_originated, { kind: 'seam', evidence: ['web to api (http, sync)'] });
});

test('signature, exported, edge via and the flow standing reach the stored analysis', () => {
  const index = {
    root: '/tmp/shop',
    files: [{ path: 'src/a.ts', kind: 'source', language: 'typescript', extracted: true }],
    nodes: [
      { id: 'src/a.ts', name: 'a.ts', kind: 'module', file: 0, span: { line: 1 } },
      {
        id: 'src/a.ts:function:f:1', name: 'f', kind: 'function', file: 0, span: { line: 1, end_line: 3 }, parent: 'src/a.ts',
        signature: { parameters: [{ name: 'n', type_annotation: 'number', optional: true }], return_type: 'string' },
        modifiers: { exported: true },
      },
      { id: 'src/a.ts:method:K.m:5', name: 'm', kind: 'method', file: 0, span: { line: 5 }, parent: 'src/a.ts', modifiers: { private_member: true } },
    ],
    edges: [
      { source: 'src/a.ts:function:f:1', target: 'src/a.ts:method:K.m:5', kind: 'calls', via: 'name' },
      { source: 'src/a.ts:method:K.m:5', target: 'src/a.ts:function:f:1', kind: 'calls' },
    ],
    comprehension: {
      flows: [{ id: 'flow:x', entry_point: 'entry:x', kind: 'http', operation: 'GET /x', standing: 'open', open: 2, cut: true }],
    },
  } as unknown as TierStackIndex;
  const cas = tierStackToCas(index, 'shop');
  const held = cas.nodes.find(node => node.id === 'src/a.ts:function:f:1');
  assert.deepEqual(held?.signature, { parameters: [{ name: 'n', type: 'number', optional: true }], return_type: 'string' });
  assert.equal(held?.metadata?.is_exported, true);
  assert.equal(cas.nodes.find(node => node.name === 'm')?.metadata?.access_modifier, 'private');
  assert.equal(cas.edges[0].metadata?.attributes?.via, 'name');
  assert.equal(cas.edges[1].metadata, undefined);
  assert.equal(cas.flows?.[0].standing, 'open');
  assert.equal(cas.flows?.[0].open, 2);
  assert.equal(cas.flows?.[0].cut, true);
});

test('the confidence of a capability or a flow, and an unsettled mark, reach the stored analysis', () => {
  const index = {
    ...INDEX,
    comprehension: {
      flows: [
        { id: 'flow:a', entry_point: 'entry:a', kind: 'http', operation: '/a', standing: 'terminal', confidence: 0.9 },
        { id: 'flow:b', entry_point: 'entry:b', kind: 'http', operation: '/b', standing: 'reading', confidence: 0.35, unsettled: 'ai-unanswered' },
      ],
      capabilities: [
        { id: 'capability:place-an-order', name: 'Place an order', flows: ['flow:a'], confidence: 0.86 },
        { id: 'capability:look-up', name: 'Look up', flows: ['flow:b'], confidence: 0.17, unsettled: 'ai-unanswered' },
      ],
    },
  } as unknown as TierStackIndex;
  const cas = tierStackToCas(index, 'shop');
  assert.deepEqual(cas.flows?.map(flow => [flow.confidence, flow.unsettled]), [[0.9, undefined], [0.35, 'ai-unanswered']]);
  assert.deepEqual(cas.capabilities.map(held => [held.confidence, held.unsettled]), [[0.86, undefined], [0.17, 'ai-unanswered']]);
});

test('the history the engine read becomes the stability of the files it names', () => {
  const index = {
    ...INDEX,
    history: {
      commits: 40,
      fix_commits: 9,
      files: [
        { path: 'src/order.ts', commits: 12, fixes: 6, recent: 2, quarter: 8, recent_authors: 1, last: 1_790_000_000, fix_percentile: 97, churn_percentile: 90 },
        { path: 'src/gone.ts', commits: 5, fixes: 1, recent: 0, quarter: 0, recent_authors: 0, last: 1_780_000_000, fix_percentile: 50, churn_percentile: 50 },
      ],
    },
  } as TierStackIndex;
  const cas = tierStackToCas(index, 'shop');
  assert.equal(cas.temporal_stability?.length, 1);
  const held = cas.temporal_stability?.[0];
  assert.equal(held?.node_id, 'src/order.ts');
  assert.equal(held?.stability_class, 'fragile');
  assert.equal(held?.quality_signals.bug_fix_commits, 6);
  assert.equal(held?.quality_signals.bug_fix_percentile, 97);
  assert.equal(cas.stability_summary?.by_stability_class.fragile, 1);
  assert.equal(tierStackToCas(INDEX, 'shop').temporal_stability, undefined);
});

test('a part carries the owner, system and dependencies its catalog descriptor declared', () => {
  const described = {
    ...INDEX,
    files: [
      { path: 'api/order.ts', kind: 'source', language: 'typescript', extracted: true },
      { path: 'web/cart.ts', kind: 'source', language: 'typescript', extracted: true },
    ],
    nodes: [
      { id: 'api/order.ts', name: 'order.ts', kind: 'module', file: 0, span: { line: 1 }, project: 'subproject:api' },
      { id: 'web/cart.ts', name: 'cart.ts', kind: 'module', file: 1, span: { line: 1 }, project: 'subproject:web' },
    ],
    edges: [],
    partition: {
      sub_projects: [
        { id: 'subproject:api', name: 'api', root: 'api', owner: 'group:default/payments', system: 'checkout', depends_on: ['component:default/web'] },
        { id: 'subproject:web', name: 'web', root: 'web' },
      ],
    },
  } as TierStackIndex;
  const parts = tierStackToCas(described, 'shop').children ?? [];
  const api = parts.find(part => part.system.name === 'api');
  const web = parts.find(part => part.system.name === 'web');
  assert.deepEqual(api?.system.catalog, { owner: 'group:default/payments', system: 'checkout', depends_on: ['component:default/web'] });
  assert.equal(web?.system.catalog, undefined);
});

test('the engine journeys reach the stored analysis with their ordered steps, crossings and effects', () => {
  const index = {
    ...INDEX,
    journeys: [
      {
        id: 'journey:a',
        label: 'Run chat',
        does: 'Run chat through ipc chat:run',
        rank: 1,
        representative: true,
        steps: [
          { file: 'src/order.ts', symbol: 'runChat', does: 'Run chat: sends chat:run over the ipc bridge' },
          { file: 'src/order.ts', symbol: 'spawn', does: 'Spawn: starts an external process', via: 'ipc', effect: 'process:Command::new' },
        ],
      },
    ],
  } as unknown as TierStackIndex;
  const cas = tierStackToCas(index, 'shop');
  assert.equal(cas.causal_journeys?.length, 1);
  assert.equal(cas.causal_journeys?.[0].representative, true);
  assert.deepEqual(cas.causal_journeys?.[0].steps.map(step => step.via), [undefined, 'ipc']);
  assert.equal(cas.causal_journeys?.[0].steps[1].effect, 'process:Command::new');
});
