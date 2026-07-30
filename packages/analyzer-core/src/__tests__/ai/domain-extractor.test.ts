import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DomainExtractor } from '../../analyzer/core/domain-extractor';
import { CASNode, CASEntryPoint, CASDataEntity } from '../../types/cas.types';

function node(id: string, name: string, extra: Partial<CASNode> = {}): CASNode {
  return { id, name, type: 'function', ...extra } as CASNode;
}

function entryPoint(id: string, name: string, path?: string): CASEntryPoint {
  return {
    id,
    name,
    type: 'http',
    trigger: path ? { path } : undefined,
  } as CASEntryPoint;
}

function entity(id: string, name: string, fields: string[] = []): CASDataEntity {
  return {
    id,
    name,
    fields: fields.map(f => ({ name: f })),
  } as CASDataEntity;
}

function nodesNamed(name: string, count: number, prefix = 'n'): CASNode[] {
  return Array.from({ length: count }, (_, i) => node(`${prefix}_${i}`, name));
}

describe('DomainExtractor', () => {
  const extractor = new DomainExtractor();

  it('classifies infrastructure terms as infrastructure', () => {
    const concepts = extractor.extract(nodesNamed('cache', 6), [], []);
    const cache = concepts.find(c => c.name === 'cache');
    expect(cache).toBeDefined();
    expect(cache!.classification).toBe('infrastructure');
  });

  it('excludes concepts that appear fewer than twice', () => {
    const concepts = extractor.extract([node('n1', 'payment')], [], []);
    expect(concepts.find(c => c.name === 'payment')).toBeUndefined();
  });

  it('classifies a boundary-anchored concept as core', () => {
    // "invoice" appears in both an entry point and a data entity.
    const concepts = extractor.extract(
      [node('n1', 'invoice'), node('n2', 'invoice')],
      [entryPoint('e1', 'invoice', '/invoice')],
      [entity('ent1', 'invoice', ['amount'])],
    );
    const invoice = concepts.find(c => c.name === 'invoice');
    expect(invoice).toBeDefined();
    expect(invoice!.classification).toBe('core');
  });

  it('classifies a prominence-dominant concept as core without any boundary', () => {
    // "payment" pervades the codebase but touches no entry point or entity.
    const concepts = extractor.extract(
      [...nodesNamed('payment', 8), ...nodesNamed('audit', 2, 'a')],
      [],
      [],
    );
    const payment = concepts.find(c => c.name === 'payment');
    expect(payment).toBeDefined();
    expect(payment!.classification).toBe('core');
  });

  it('lets prominence override the cross-cutting hint (token in a token system)', () => {
    // `token` is normally a supporting cross-cutting concern, but here it
    // dominates the codebase and must be core.
    const concepts = extractor.extract(nodesNamed('token', 12), [], []);
    const token = concepts.find(c => c.name === 'token');
    expect(token).toBeDefined();
    expect(token!.classification).toBe('core');
  });

  it('filters programming-noise and framework names', () => {
    const concepts = extractor.extract(
      [
        ...nodesNamed('self', 5, 's'),
        ...nodesNamed('dummy', 5, 'd'),
        ...nodesNamed('react', 5, 'r'),
        ...nodesNamed('express', 5, 'e'),
        ...nodesNamed('constructor', 5, 'c'),
      ],
      [],
      [],
    );
    const names = concepts.map(c => c.name);
    expect(names).not.toContain('self');
    expect(names).not.toContain('dummy');
    expect(names).not.toContain('react');
    expect(names).not.toContain('express');
    expect(names).not.toContain('constructor');
  });

  it('tokenizes qualified names and route templates without punctuation artifacts', () => {
    const concepts = extractor.extract(
      [
        ...nodesNamed('EnterpriseOrder', 3, 'order'),
        ...nodesNamed('Microsoft.AspNetCore.Mvc', 3, 'dotnet'),
        ...nodesNamed('Illuminate\\Support\\Facades\\Route', 3, 'php'),
      ],
      [entryPoint('route_1', 'GET /orders/{id}', '/orders/{id}'), entryPoint('route_2', 'GET /orders/:id', '/orders/:id')],
      [entity('entity_order', 'EnterpriseOrder')],
    );
    const names = concepts.map(concept => concept.name);
    expect(names).toContain('enterprise');
    expect(names).toContain('order');
    expect(names).not.toEqual(expect.arrayContaining(['{id}', ':id', 'dotnet', 'microsoft', 'aspnet', 'mvc', 'illuminate']));
    expect(names.every(name => !/[{}:\\]/.test(name))).toBe(true);
  });

  it('does not promote supporting concepts merely to fill a fixed core quota', () => {
    const concepts = extractor.extract(
      [
        ...nodesNamed('EnterpriseOrder', 8, 'order'),
        ...nodesNamed('PeripheralAudit', 3, 'audit'),
        ...nodesNamed('PeripheralExport', 3, 'export'),
      ],
      [entryPoint('route_1', 'Enterprise Orders', '/orders')],
      [entity('entity_order', 'EnterpriseOrder')],
    );
    const core = concepts.filter(concept => concept.classification === 'core').map(concept => concept.name);
    expect(core).toEqual(expect.arrayContaining(['enterprise', 'order']));
    expect(core).not.toEqual(expect.arrayContaining(['peripheral', 'audit', 'export']));
  });

  it('promotes prominent concepts to core when a repo has no boundary anchors', () => {
    // A CLI/bot-style repo: no entry points, no entities. Every concept is
    // structurally "supporting" by the strict rules — the promotion net must
    // still surface a core set.
    const concepts = extractor.extract(
      [
        ...nodesNamed('wallet', 3, 'w'),
        ...nodesNamed('liquidity', 3, 'l'),
        ...nodesNamed('swap', 3, 's'),
        ...nodesNamed('arbitrage', 3, 'a'),
      ],
      [],
      [],
    );
    const core = concepts.filter(c => c.classification === 'core');
    expect(core.length).toBeGreaterThan(0);
  });

  it('ignores embedded SDK examples and docs snippets when inferring product domain', () => {
    const concepts = extractor.extract(
      [
        node('src_flag_client', 'FeatureFlagClient', {
          type: 'class',
          source: { file: 'src/feature-flags/feature-flag-client.ts' },
        }),
        node('src_rollout_engine', 'RolloutEngine', {
          type: 'class',
          source: { file: 'src/rollouts/rollout-engine.ts' },
        }),
        node('src_segment_rules', 'SegmentRuleEvaluator', {
          type: 'class',
          source: { file: 'src/segments/segment-rule-evaluator.ts' },
        }),
        node('src_flag_eval', 'FeatureFlagEvaluator', {
          type: 'class',
          source: { file: 'src/feature-flags/feature-flag-evaluator.ts' },
        }),
        ...nodesNamed('PetstoreOrderClient', 8, 'example').map((n, index) => ({
          ...n,
          source: { file: `examples/petstore/order-example-${index}.ts` },
        }) as CASNode),
        ...nodesNamed('InvoicePaymentSnippet', 6, 'doc').map((n, index) => ({
          ...n,
          source: { file: `docs/snippets/payment-snippet-${index}.ts` },
        }) as CASNode),
      ],
      [],
      [],
    );

    const coreNames = concepts.filter(c => c.classification === 'core').map(c => c.name);
    expect(coreNames).toContain('feature');
    expect(coreNames).toContain('flag');
    expect(concepts.map(c => c.name)).toContain('rollout');
    expect(coreNames).not.toContain('petstore');
    expect(coreNames).not.toContain('invoice');
    expect(concepts.find(c => c.name === 'petstore')).toBeUndefined();
    expect(concepts.find(c => c.name === 'invoice')).toBeUndefined();
  });

  it('returns concepts sorted by frequency descending', () => {
    const concepts = extractor.extract(
      [...nodesNamed('payment', 9, 'p'), ...nodesNamed('refund', 3, 'r')],
      [],
      [],
    );
    for (let i = 1; i < concepts.length; i++) {
      expect(concepts[i - 1].frequency).toBeGreaterThanOrEqual(concepts[i].frequency);
    }
  });
});

describe('DomainExtractor distinctiveness gate', () => {
  const extractor = new DomainExtractor();

  const typeNode = (id: string, name: string, file = 'src/domain/model.ts'): CASNode =>
    node(id, name, { type: 'interface', source: { file, line: 1 } as any });

  it('a frequent but generic English word is not a concept', () => {
    // REGRESSION: a production analysis emitted 599 "concepts" whose tail was
    // ordinary English (`triggered`, `acknowledged`, `locale`, `reproduction`).
    // Those words occur — that was the whole of their qualification.
    const nodes: CASNode[] = [
      // The generic verb is the MOST frequent token in the graph, spread over
      // more code units than the domain term, and named by nothing.
      ...nodesNamed('markShipmentTriggered', 12, 'fn'),
      // The domain term is named by the entity model.
      ...nodesNamed('shipment', 3, 's'),
      typeNode('t1', 'ShipmentRoute'), typeNode('t2', 'ShipmentLeg'), typeNode('t3', 'ShipmentManifest'),
    ];
    const concepts = extractor.extract(nodes, [], [entity('ent_shipment', 'Shipment', ['triggered'])], []);
    const names = concepts.map(concept => concept.name);

    expect(names).toContain('shipment');
    expect(names).not.toContain('triggered');
    // ... and the term that IS retained cites why.
    const shipment = concepts.find(concept => concept.name === 'shipment')!;
    expect(shipment.distinctiveness_evidence?.join(' ')).toMatch(/entity name: Shipment/);
    // Ranking is by distinctiveness, so the cited term outranks the frequent one.
    expect(names[0]).toBe('shipment');
  });

  it('an entity FIELD name alone is not distinctiveness evidence', () => {
    // A field list is where a record's incidental attributes live. Crediting it
    // as an entity anchor is how generic words rode in on an entity's coat-tails.
    const concepts = extractor.extract(
      [...nodesNamed('applyTimezone', 4, 'tz')],
      [],
      [entity('ent_booking', 'Booking', ['timezone', 'locale'])],
      [],
    );
    const timezone = concepts.find(concept => concept.name === 'timezone');
    expect(timezone?.distinctiveness_evidence?.join(' ') || '').not.toMatch(/entity name/);
  });

  it('recurrence across the declared-type vocabulary is evidence; one type is not', () => {
    const nodes: CASNode[] = [
      typeNode('t1', 'LedgerEntry'), typeNode('t2', 'LedgerAccount'), typeNode('t3', 'LedgerPosting'),
      typeNode('t4', 'CarouselState'),
      ...nodesNamed('ledger', 2, 'l'), ...nodesNamed('mascot', 2, 'm'),
    ];
    const concepts = extractor.extract(nodes, [], [], []);
    const ledger = concepts.find(concept => concept.name === 'ledger');
    expect(ledger?.distinctiveness_evidence?.join(' ')).toMatch(/declared type \(3\)/);
    const mascot = concepts.find(concept => concept.name === 'mascot');
    expect(mascot?.distinctiveness_evidence?.join(' ') || '').not.toMatch(/declared type/);
  });

  it('a capability subject is a concept even when the code spells it only in identifiers', () => {
    const concepts = extractor.extract(
      [...nodesNamed('reconcileSettlement', 3, 'r')],
      [],
      [],
      [],
      undefined,
      { capabilityNames: ['Reconcile settlement batches', 'Report settlement variance'] },
    );
    const settlement = concepts.find(concept => concept.name === 'settlement')!;
    expect(settlement).toBeDefined();
    expect(settlement.distinctiveness_evidence?.join(' ')).toMatch(/capability subject/);
  });

  it('frequency counts DISTINCT usage sites, not token occurrences', () => {
    // Four code units, one term. The old counter recorded the same node up to
    // three times and reported the product of its own weighting.
    const concepts = extractor.extract(nodesNamed('warehouse', 4, 'w'), [], [], []);
    const warehouse = concepts.find(concept => concept.name === 'warehouse')!;
    expect(warehouse.frequency).toBe(4);
    expect(warehouse.description).toMatch(/4 distinct usage sites/);
  });

  it('caps the emitted vocabulary rather than shipping hundreds of terms', () => {
    const nodes: CASNode[] = [];
    const entities: CASDataEntity[] = [];
    for (let index = 0; index < 120; index++) {
      const term = `zeta${index}kappa`;
      entities.push(entity(`ent_${index}`, term));
      nodes.push(node(`n_${index}_a`, term), node(`n_${index}_b`, term));
    }
    const concepts = extractor.extract(nodes, [], entities, []);
    expect(concepts.length).toBeLessThanOrEqual(40);
    expect(concepts.every(concept => (concept.distinctiveness_evidence || []).length > 0)).toBe(true);
  });
});

describe('DomainExtractor authored compounds', () => {
  const extractor = new DomainExtractor();
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-compound-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps an authored hyphenated compound as ONE concept, not two words', () => {
    // REGRESSION: a compound the authors write as one term shipped as two
    // separate concepts because tokenization split every non-alphanumeric
    // boundary. Both halves then looked like independent domain vocabulary.
    fs.writeFileSync(
      path.join(root, 'README.md'),
      '# Parser toolkit\n\nGrammars are compiled with cross-parser support for every language.\n',
    );
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'toolkit', dependencies: { 'cross-parser': '1.0.0' } }),
    );
    const nodes: CASNode[] = [
      node('n1', 'CrossParserRegistry', { type: 'class', source: { file: 'src/cross-parser/registry.ts' } as any }),
      node('n2', 'crossParserFor', { type: 'function', source: { file: 'src/cross-parser/resolve.ts' } as any }),
      node('n3', 'loadCrossParser', { type: 'function', source: { file: 'src/cross-parser/load.ts' } as any }),
    ];

    const names = extractor.extract(nodes, [], [], [], root).map(concept => concept.name);
    expect(names).toContain('cross-parser');
    expect(names).not.toContain('cross');
    // The compound is cited to the authors' own text, not to its frequency.
    const compound = extractor
      .extract(nodes, [], [], [], root)
      .find(concept => concept.name === 'cross-parser')!;
    expect(compound.distinctiveness_evidence?.join(' ')).toMatch(/authored prose/);
  });

  it('never fuses a kebab-case FILE NAME into one concept', () => {
    // File names are not authored terms. Sourcing the lexicon from prose and
    // manifests only is what keeps `analysis-usefulness-review.ts` from
    // becoming a single concept.
    fs.writeFileSync(path.join(root, 'README.md'), '# Toolkit\n\nA toolkit for warehouse logistics.\n');
    const nodes: CASNode[] = [
      node('n1', 'WarehouseSlotPlanner', { type: 'class', source: { file: 'src/warehouse-slot-planner.ts' } as any }),
      node('n2', 'planWarehouseSlot', { type: 'function', source: { file: 'src/warehouse-slot-planner.ts' } as any }),
    ];
    const names = extractor.extract(nodes, [], [], [], root).map(concept => concept.name);
    expect(names).not.toContain('warehouse-slot-planner');
    expect(names).toContain('warehouse');
  });
});

describe('DomainExtractor path hygiene', () => {
  const extractor = new DomainExtractor();

  const classNode = (id: string, name: string, file: string): CASNode =>
    node(id, name, { type: 'class', source: { file, line: 1 } as any });

  it('never promotes clone-path segments above the repo root into domain concepts', () => {
    const projectPath = '/tmp/klauro-oss-blind/spree';
    const nodes = [
      classNode('n1', 'CreditCard', '/tmp/klauro-oss-blind/spree/core/app/models/spree/credit_card.rb'),
      classNode('n2', 'GiftCard', '/tmp/klauro-oss-blind/spree/core/app/models/spree/gift_card.rb'),
      classNode('n3', 'Order', '/tmp/klauro-oss-blind/spree/core/app/models/spree/order.rb'),
      classNode('n4', 'Payment', '/tmp/klauro-oss-blind/spree/core/app/models/spree/payment.rb'),
    ];

    const concepts = extractor.extract(nodes, [], [], [], projectPath);
    const names = concepts.map(c => c.name);

    expect(names).not.toContain('klauro');
    expect(names).not.toContain('oss');
    expect(names).not.toContain('blind');
    expect(names).not.toContain('tmp');
    expect(names).toContain('spree');
  });

  it('skips absolute file paths entirely when the project root is unknown', () => {
    const nodes = [
      classNode('n1', 'Order', '/tmp/klauro-oss-blind/spree/core/app/models/spree/order.rb'),
      classNode('n2', 'Payment', '/tmp/klauro-oss-blind/spree/core/app/models/spree/payment.rb'),
    ];

    const concepts = extractor.extract(nodes, [], [], []);
    const names = concepts.map(c => c.name);

    expect(names).not.toContain('klauro');
    expect(names).not.toContain('blind');
    expect(names).not.toContain('tmp');
  });

  it('still extracts repo-relative path concepts', () => {
    const nodes = [
      classNode('n1', 'OrdersController', 'app/controllers/orders_controller.rb'),
      classNode('n2', 'Order', 'app/models/order.rb'),
    ];

    const concepts = extractor.extract(nodes, [], [], []);
    expect(concepts.map(c => c.name)).toContain('order');
  });
});
