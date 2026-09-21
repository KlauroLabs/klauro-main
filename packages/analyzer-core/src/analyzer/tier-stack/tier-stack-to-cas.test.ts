import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tierStackToCas } from './tier-stack-to-cas';
import { tierStackRequested } from './index';
import { READABLE_BYTES, tooLarge, type TierStackIndex } from './read-tier-stack';

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
        named_fields: ['id', 'customerId', 'total'],
        fields: 3,
        addressed_by: 2,
        written_by: ['src/order.ts:function:place:12'],
        read_by: [],
        references: [
          { field: 'customerId', entity: 'Customer' },
          { field: 'lines', entity: 'OrderLine', many: true },
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
  const order = cas.entities?.[0] as unknown as {
    name: string;
    fields: Array<{ name: string }>;
    relationships: Array<{ field: string; entity: string; cardinality: string }>;
  };
  assert.equal(order.name, 'Order');
  assert.deepEqual(order.fields.map(field => field.name), ['id', 'customerId', 'total']);
  assert.deepEqual(order.relationships, [
    { field: 'customerId', entity: 'Customer', cardinality: 'one' },
    { field: 'lines', entity: 'OrderLine', cardinality: 'many' },
  ]);
});

test('a flow keeps the surface it starts from and the records it touches', () => {
  const cas = tierStackToCas(INDEX);
  const flow = cas.flows?.[0];
  assert.equal(flow?.flow_id, 'flow:place');
  assert.equal(flow?.name, 'place an order');
  assert.equal(flow?.entry_point, 'entry:place');
  assert.deepEqual(flow?.entities, ['Order', 'Customer']);
});

test('a declared package is carried across', () => {
  const cas = tierStackToCas(INDEX);
  assert.deepEqual(cas.dependencies?.packages, [{ name: 'express', version: '', direct: true }]);
});

test('an index too large to read as text says so plainly', () => {
  const said = tooLarge('/tmp/vast', 2_655_095_873);
  assert.match(said, /2\.66 GB of JSON/);
  assert.match(said, /binary form/);
  assert.ok(READABLE_BYTES > 0);
});

test('the tier stack is asked for only when it is asked for', () => {
  const held = process.env.KLAURO_TIER_STACK;
  delete process.env.KLAURO_TIER_STACK;
  assert.equal(tierStackRequested(), false);
  process.env.KLAURO_TIER_STACK = '1';
  assert.equal(tierStackRequested(), true);
  if (held === undefined) delete process.env.KLAURO_TIER_STACK;
  else process.env.KLAURO_TIER_STACK = held;
});
