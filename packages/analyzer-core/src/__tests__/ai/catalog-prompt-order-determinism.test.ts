jest.unmock('fs');
jest.unmock('fs-extra');
jest.unmock('glob');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import { TypeScriptJavaScriptAnalyzer } from '../../analyzer/languages/typescript-javascript-analyzer';
import { ExpressAnalyzer } from '../../analyzer/frameworks/web';
import { aiService } from '../../ai/ai-service';

/**
 * TASK #33 (catalog variance) — root-cause work item 1: at temperature 0,
 * identical input yields identical output, so if the CANDIDATE LIST fed into
 * the capability-catalog prompt varies in order or content between two
 * otherwise-identical runs, the prompt itself varies and the catalog can vary
 * with it even though sampling never ran twice.
 *
 * This fixture is deliberately built with a TIE the deterministic candidate
 * pipeline must break explicitly rather than accidentally:
 *   - `Customer` and `Order` are both plain 2-field entities (equal
 *     `fields.length`), so `aiExtractCapabilityCatalog`'s entities sort
 *     (orchestrator.ts, sorts by field count) can only separate them via an
 *     explicit secondary key. Before this task, that key did not exist —
 *     ties fell through to array-insertion order, a real (if today
 *     incidentally stable) dependency on upstream iteration order rather
 *     than a proven invariant of the prompt-building function itself.
 *   - Two resource route areas (`/customers`, `/orders`) with the same
 *     operation shape give `rankCatalogPromptCandidates` / the deterministic
 *     candidate pool a similar tie to break.
 *
 * Regression contract asserted here: the exact JSON facts bundle handed to
 * the capability-catalog AI call (`candidate_route_areas`, `entry_point_flows`,
 * `data_entities`) is BYTE-IDENTICAL across two independent, from-scratch
 * analyses of the same unchanged source — proving the prompt input is a
 * total, stable function of the CAS, not an accident of one process's
 * internal Map/Set/array iteration order.
 */

jest.setTimeout(180000);

const AI_ENV_KEYS = [
  'KLAURO_AI_INTERPRETATION',
  'KLAURO_AI_ELEMENT_DESCRIPTIONS',
  'KLAURO_EMBEDDING_ENABLED',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
] as const;

const savedEnv: Record<string, string | undefined> = {};
let fixtureDir: string;

function writeFixture(root: string): void {
  fs.mkdirSync(path.join(root, 'src', 'entities'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'catalog-prompt-order-determinism-fixture',
        version: '1.0.0',
        dependencies: { express: '^4.18.2', '@mikro-orm/core': '^5.9.0' },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(root, 'README.md'),
    'Storefront order-tracking service. Records customers and the orders they place.\n',
  );
  // Two ORM entities with the SAME field count (2) — a genuine tie for the
  // fields.length comparator in aiExtractCapabilityCatalog's entities sort.
  // Filenames are DELIBERATELY in the OPPOSITE order from their entity names
  // ('a-order' < 'z-customer' alphabetically/on-disk) so that a regression
  // back to relying on upstream file-discovery/insertion order (instead of
  // the explicit name tiebreak) would surface Order before Customer here —
  // this is what makes the literal-order assertion below a real regression
  // guard rather than a coincidence of matching file and entity name order.
  fs.writeFileSync(
    path.join(root, 'src', 'entities', 'a-order.entity.ts'),
    [
      "import { Entity, PrimaryKey, Property } from '@mikro-orm/core';",
      '',
      '@Entity()',
      'export class Order {',
      '  @PrimaryKey()',
      '  id!: string;',
      '',
      '  @Property()',
      '  total!: number;',
      '}',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(root, 'src', 'entities', 'z-customer.entity.ts'),
    [
      "import { Entity, PrimaryKey, Property } from '@mikro-orm/core';",
      '',
      '@Entity()',
      'export class Customer {',
      '  @PrimaryKey()',
      '  id!: string;',
      '',
      '  @Property()',
      '  name!: string;',
      '}',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(root, 'src', 'store.ts'),
    [
      "import { Customer } from './entities/z-customer.entity';",
      "import { Order } from './entities/a-order.entity';",
      '',
      'const customers = new Map<string, Customer>();',
      'const orders = new Map<string, Order>();',
      '',
      'export function createCustomer(customer: Customer): Customer {',
      '  customers.set(customer.id, customer);',
      '  return customer;',
      '}',
      'export function listCustomers(): Customer[] {',
      '  return [...customers.values()];',
      '}',
      'export function createOrder(order: Order): Order {',
      '  orders.set(order.id, order);',
      '  return order;',
      '}',
      'export function listOrders(): Order[] {',
      '  return [...orders.values()];',
      '}',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(root, 'src', 'server.ts'),
    [
      "import express from 'express';",
      "import { createCustomer, listCustomers, createOrder, listOrders } from './store';",
      '',
      'const app = express();',
      'app.use(express.json());',
      '',
      "app.get('/customers', (req, res) => { res.json(listCustomers()); });",
      "app.post('/customers', (req, res) => { res.status(201).json(createCustomer(req.body)); });",
      "app.get('/orders', (req, res) => { res.json(listOrders()); });",
      "app.post('/orders', (req, res) => { res.status(201).json(createOrder(req.body)); });",
      '',
      'app.listen(3000);',
      '',
    ].join('\n'),
  );
}

function createPipelineOrchestrator(): AnalyzerOrchestrator {
  const orchestrator = new AnalyzerOrchestrator();
  orchestrator.registerAnalyzer({
    id: 'typescript-javascript',
    name: 'TypeScript/JavaScript Analyzer',
    type: 'language',
    version: '1.0.0',
    detectPatterns: { files: ['package.json', 'tsconfig.json'], content: [/\.ts$/, /\.js$/] },
    analyzer: new TypeScriptJavaScriptAnalyzer(),
  });
  orchestrator.registerAnalyzer({
    id: 'express',
    name: 'Express.js Analyzer',
    type: 'framework',
    version: '1.0.0',
    detectPatterns: { dependencies: ['express'], files: ['package.json'] },
    requires: ['typescript-javascript'],
    analyzer: new ExpressAnalyzer(),
  });
  return orchestrator;
}

function setAIEnv(env: Partial<Record<(typeof AI_ENV_KEYS)[number], string>>): void {
  for (const key of AI_ENV_KEYS) {
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function resetAICooldownState(): void {
  (AnalyzerOrchestrator as any).aiInterpretationTimeouts = 0;
  (AnalyzerOrchestrator as any).aiInterpretationDisabledUntil = 0;
}

/** Captures the exact `facts` bundle sent to the capability-catalog call —
 *  identified by `candidate_route_areas` being present, which only the
 *  catalog prompt (aiExtractCapabilityCatalog) sets. */
async function captureCatalogFacts(): Promise<any> {
  const describeSpy = jest.spyOn(aiService, 'generateComponentDescription');
  let capturedFacts: any;
  describeSpy.mockImplementation(async (opts: any) => {
    const facts = opts?.additionalContext?.facts;
    if (facts && Array.isArray(facts.candidate_route_areas) && capturedFacts === undefined) {
      capturedFacts = facts;
    }
    const items = opts?.additionalContext?.items;
    if (Array.isArray(items) && items.some((item: any) => item?.kind === 'capability')) {
      return JSON.stringify({ descriptions: items.map((item: any) => ({ id: item.id, description: `${item.name} handles a real product concern with grounded evidence.` })) });
    }
    if (facts && Array.isArray(facts.candidate_route_areas)) {
      expect(opts.additionalContext.responseFormat).toBe('json');
      expect(opts.additionalContext.maxTokens).toBeGreaterThanOrEqual(600);
      expect(opts.additionalContext.maxTokens).toBeLessThanOrEqual(1800);
      expect(opts.additionalContext.requestTimeoutMs).toBe(65000);
      expect(opts.additionalContext.requestRetries).toBe(0);
      expect(Array.isArray(facts.required_behavior_candidate_ids)).toBe(true);
      expect(facts.required_behavior_candidate_ids.every((id: string) => facts.candidate_route_areas.some((area: any) => area.candidate_id === id))).toBe(true);
      return JSON.stringify({
        capabilities: [
          { name: 'Manage customer orders', description: 'Tracks customer identities and the orders each customer places.', category: 'core', entities: ['Customer', 'Order'], journeys: [] },
        ],
      });
    }
    return JSON.stringify({
      system_description:
        'This service is an Express HTTP API for order tracking that records customers and the orders they place in an in-memory store. '
        + 'It exposes endpoints to create and list customers, and to create and list orders.',
      domain: 'customer-order-tracking',
      descriptions: [],
    });
  });

  setAIEnv({
    KLAURO_AI_INTERPRETATION: 'true',
    KLAURO_AI_ELEMENT_DESCRIPTIONS: 'true',
    KLAURO_EMBEDDING_ENABLED: 'false',
    OPENAI_API_KEY: 'test-catalog-order-key',
  });
  resetAICooldownState();
  try {
    await createPipelineOrchestrator().orchestrateAnalysis(fixtureDir);
  } finally {
    describeSpy.mockRestore();
  }
  return capturedFacts;
}

describe('capability-catalog prompt input ordering is a total, stable function of the CAS', () => {
  beforeAll(() => {
    for (const key of AI_ENV_KEYS) savedEnv[key] = process.env[key];
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-catalog-order-'));
    writeFixture(fixtureDir);
  });

  afterAll(() => {
    for (const key of AI_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('sends byte-identical candidate_route_areas / entry_point_flows / entities across two independent from-scratch analyses', async () => {
    const first = await captureCatalogFacts();
    const second = await captureCatalogFacts();

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(Array.isArray(first.candidate_route_areas)).toBe(true);
    expect(first.candidate_route_areas.length).toBeGreaterThan(0);
    expect(Array.isArray(first.entities)).toBe(true);
    expect(first.entities.length).toBeGreaterThanOrEqual(2);
    // Customer and Order both carry exactly 2 fields (a genuine tie for the
    // fields.length comparator), so a correct TOTAL order must fall back to
    // name and put Customer ('C' < 'O') first — this fails if the sort ever
    // regresses to relying on upstream insertion order instead of an
    // explicit tiebreak.
    expect(first.entities.map((entity: any) => entity.name)).toEqual(['Customer', 'Order']);

    expect(JSON.stringify(second.candidate_route_areas)).toBe(JSON.stringify(first.candidate_route_areas));
    expect(JSON.stringify(second.entry_point_flows)).toBe(JSON.stringify(first.entry_point_flows));
    expect(JSON.stringify(second.entities)).toBe(JSON.stringify(first.entities));
    expect(JSON.stringify(second.external_services)).toBe(JSON.stringify(first.external_services));

    // The tie is real: Customer and Order both carry 2 fields, so a name
    // tiebreak (not upstream insertion order) is what makes this assertion
    // meaningful rather than incidentally true.
    const entityNames = first.entities.map((entity: any) => entity.name);
    expect(new Set(entityNames.map((name: string) => name.toLowerCase())).size).toBe(entityNames.length);
    const sortedByNameAmongTiedFieldCounts = [...first.entities]
      .sort((a: any, b: any) => (b.fields?.length || 0) - (a.fields?.length || 0) || a.name.localeCompare(b.name))
      .map((entity: any) => entity.name);
    expect(entityNames).toEqual(sortedByNameAmongTiedFieldCounts);
  });
});
