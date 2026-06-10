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
import type { CASOutput } from '../../types/cas.types';

jest.setTimeout(180000);

const AI_ENV_KEYS = [
  'KLAURO_AI_INTERPRETATION',
  'KLAURO_AI_INTERPRETATION_FORCE',
  'KLAURO_AI_INTERPRETATION_ALLOW_DETERMINISTIC_KEEP',
  'KLAURO_AI_ELEMENT_DESCRIPTIONS',
  'KLAURO_EMBEDDING_ENABLED',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'AI_LOCAL_ENABLED',
  'AI_DESCRIPTION_ALLOW_RULE_BASED_FALLBACK',
] as const;

const savedEnv: Record<string, string | undefined> = {};

let fixtureDir: string;

function writeFixture(root: string): void {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'klauro-determinism-fixture',
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

function structuralView(output: CASOutput) {
  return {
    nodes: output.nodes,
    edges: output.edges,
    entry_points: output.entry_points,
    exit_points: output.exit_points,
    capabilities: (output.system_capabilities || []).map(capability => ({
      id: capability.id,
      category: capability.category,
      criticality: capability.criticality,
      operations: capability.operations,
    })),
  };
}

describe('deterministic/AI boundary', () => {
  beforeAll(() => {
    for (const key of AI_ENV_KEYS) savedEnv[key] = process.env[key];
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-determinism-'));
    writeFixture(fixtureDir);
  });

  afterAll(() => {
    for (const key of AI_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('produces identical structure whether AI is off, broken, or on', async () => {
    const describeSpy = jest.spyOn(aiService, 'generateComponentDescription');

    setAIEnv({
      KLAURO_AI_INTERPRETATION: 'false',
      KLAURO_AI_ELEMENT_DESCRIPTIONS: 'false',
      KLAURO_EMBEDDING_ENABLED: 'false',
    });
    resetAICooldownState();
    describeSpy.mockReset();
    describeSpy.mockRejectedValue(new Error('AI must not be called when disabled'));
    const disabledRun = await createPipelineOrchestrator().orchestrateAnalysis(fixtureDir);
    expect(describeSpy).not.toHaveBeenCalled();
    expect(disabledRun.enhanced_system_purpose?.description_source).toBe('deterministic');
    expect(disabledRun.enhanced_system_purpose?.description_generation?.status).toBe('ai_skipped');
    expect(disabledRun.enhanced_system_purpose?.description_generation?.reason).toBe('disabled-by-env');
    expect(disabledRun.enhanced_system_purpose?.domain_source).not.toBe('ai');

    setAIEnv({
      KLAURO_AI_INTERPRETATION: 'true',
      KLAURO_AI_ELEMENT_DESCRIPTIONS: 'true',
      KLAURO_EMBEDDING_ENABLED: 'true',
      OPENAI_API_KEY: 'test-determinism-key',
    });
    resetAICooldownState();
    describeSpy.mockReset();
    describeSpy.mockRejectedValue(new Error('ai provider unavailable'));
    const brokenRun = await createPipelineOrchestrator().orchestrateAnalysis(fixtureDir);
    expect(describeSpy).toHaveBeenCalled();
    expect(brokenRun.enhanced_system_purpose?.description_source).toBe('deterministic');
    expect(brokenRun.enhanced_system_purpose?.description_generation?.status).toBe('ai_failed');
    expect(brokenRun.enhanced_system_purpose?.domain_source).not.toBe('ai');
    for (const capability of brokenRun.system_capabilities || []) {
      expect(capability.description_source === undefined || capability.description_source === 'deterministic').toBe(true);
    }

    setAIEnv({
      KLAURO_AI_INTERPRETATION: 'true',
      KLAURO_AI_ELEMENT_DESCRIPTIONS: 'true',
      KLAURO_EMBEDDING_ENABLED: 'true',
      OPENAI_API_KEY: 'test-determinism-key',
    });
    resetAICooldownState();
    describeSpy.mockReset();
    describeSpy.mockResolvedValue(
      JSON.stringify({
        system_description:
          'This service is an Express HTTP API for order tracking that records customer orders in an in-memory order store. It exposes endpoints to create a new order, fetch one order by id, and list all stored orders as JSON.',
        domain: 'customer-order-tracking',
        descriptions: [],
      }),
    );
    const enabledRun = await createPipelineOrchestrator().orchestrateAnalysis(fixtureDir);
    expect(describeSpy).toHaveBeenCalled();
    const enabledStatus = enabledRun.enhanced_system_purpose?.description_generation?.status;
    expect(['ai_applied', 'ai_rejected']).toContain(enabledStatus);
    if (enabledStatus === 'ai_applied') {
      expect(enabledRun.enhanced_system_purpose?.description_source).toBe('ai');
    } else {
      expect(enabledRun.enhanced_system_purpose?.description_source).toBe('deterministic');
    }
    if (enabledRun.enhanced_system_purpose?.domain_source === 'ai') {
      expect(enabledRun.enhanced_system_purpose?.primary_domain).toBe('customer-order-tracking');
    }
    for (const capability of enabledRun.system_capabilities || []) {
      if (capability.description_source === 'ai') {
        expect(capability.description_generation?.status).toBe('ai_applied');
      }
    }

    const disabledStructure = structuralView(disabledRun);
    expect(structuralView(brokenRun)).toEqual(disabledStructure);
    expect(structuralView(enabledRun)).toEqual(disabledStructure);
  });
});
