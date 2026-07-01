jest.unmock('fs');
jest.unmock('fs-extra');
jest.unmock('glob');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import { TypeScriptJavaScriptAnalyzer } from '../../analyzer/languages/typescript-javascript-analyzer';
import { ExpressAnalyzer } from '../../analyzer/frameworks/web';
import type { CASOutput } from '../../types/cas.types';

jest.setTimeout(180000);

const AI_ENV_KEYS = [
  'KLAURO_AI_INTERPRETATION',
  'KLAURO_AI_ELEMENT_DESCRIPTIONS',
  'KLAURO_EMBEDDING_ENABLED',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
] as const;

const VOLATILE_KEYS = new Set([
  'analysis_timestamp',
  'analysis_id',
  'generated_at',
  'execution_time_ms',
]);

const savedEnv: Record<string, string | undefined> = {};

let fixtureDir: string;

function writeFixture(root: string): void {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'klauro-run-stability-fixture',
        version: '1.0.0',
        dependencies: { express: '^4.18.2' },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(root, 'README.md'),
    'Order tracking service. Records customer orders and exposes HTTP endpoints to create, fetch, and list orders.\n',
  );
  fs.writeFileSync(
    path.join(root, 'src', 'order-store.ts'),
    [
      "export interface Order {",
      "  id: string;",
      "  customerId: string;",
      "  total: number;",
      "}",
      "",
      "const orders = new Map<string, Order>();",
      "",
      "export function createOrder(order: Order): Order {",
      "  orders.set(order.id, order);",
      "  return order;",
      "}",
      "",
      "export function getOrder(id: string): Order | undefined {",
      "  return orders.get(id);",
      "}",
      "",
      "export function listOrders(): Order[] {",
      "  return [...orders.values()];",
      "}",
      "",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(root, 'src', 'server.ts'),
    [
      "import express from 'express';",
      "import { createOrder, getOrder, listOrders } from './order-store';",
      "",
      "const app = express();",
      "app.use(express.json());",
      "",
      "app.get('/orders', (req, res) => {",
      "  res.json(listOrders());",
      "});",
      "",
      "app.get('/orders/:id', (req, res) => {",
      "  const order = getOrder(req.params.id);",
      "  if (!order) {",
      "    res.status(404).json({ error: 'order not found' });",
      "    return;",
      "  }",
      "  res.json(order);",
      "});",
      "",
      "app.post('/orders', (req, res) => {",
      "  res.status(201).json(createOrder(req.body));",
      "});",
      "",
      "app.listen(3000);",
      "",
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
    detectPatterns: {
      files: ['package.json', 'tsconfig.json'],
      content: [/\.ts$/, /\.js$/],
    },
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

function stripVolatileFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatileFields);
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (VOLATILE_KEYS.has(key)) continue;
      result[key] = stripVolatileFields(entry);
    }
    return result;
  }
  return value;
}

function stableView(output: CASOutput): unknown {
  return stripVolatileFields(JSON.parse(JSON.stringify(output)));
}

describe('run-to-run stability', () => {
  beforeAll(() => {
    for (const key of AI_ENV_KEYS) savedEnv[key] = process.env[key];
    for (const key of AI_ENV_KEYS) delete process.env[key];
    process.env.KLAURO_AI_INTERPRETATION = 'false';
    process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS = 'false';
    process.env.KLAURO_EMBEDDING_ENABLED = 'false';
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-run-stability-'));
    writeFixture(fixtureDir);
  });

  afterAll(() => {
    for (const key of AI_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('produces an identical CAS across repeated analyses, excluding run metadata', async () => {
    const firstRun = await createPipelineOrchestrator().orchestrateAnalysis(fixtureDir);
    const secondRun = await createPipelineOrchestrator().orchestrateAnalysis(fixtureDir);

    expect(firstRun.nodes.length).toBeGreaterThan(0);
    expect(stableView(secondRun)).toEqual(stableView(firstRun));
  });
});
