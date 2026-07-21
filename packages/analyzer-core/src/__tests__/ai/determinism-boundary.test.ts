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
        // Must NOT match the Klauro self-project detector (/(^|[@/])klauro([-/.]|$)/),
        // or the self-identity grounding gate applies to this order fixture.
        name: 'order-tracking-determinism-fixture',
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

  // Target model (docs/cas/DETERMINISM-BOUNDARY.md): Camp-B STRUCTURE is
  // deterministic and ships with AI off; COMPREHENSION (domain, overall
  // description, capability descriptions) is AI-only. When comprehension is
  // explicitly OFF the run is structure-only (comprehension fields unset, never a
  // 'deterministic' provenance). When comprehension is ATTEMPTED but the provider
  // fails, the comprehension pass THROWS — there is no deterministic substitute.
  // When AI succeeds, comprehension is written with 'ai' provenance.

  it('ships deterministic structure with comprehension OFF, and never writes a deterministic provenance', async () => {
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
    // Structure is present and deterministic.
    expect(disabledRun.nodes.length).toBeGreaterThan(0);
    // Comprehension is UNSET (no deterministic substitute), never 'deterministic'.
    expect(disabledRun.enhanced_system_purpose?.description_source).not.toBe('deterministic');
    expect(disabledRun.enhanced_system_purpose?.domain_source).not.toBe('deterministic');
    expect(disabledRun.enhanced_system_purpose?.description_generation?.status).toBe('ai_skipped');
    expect(disabledRun.enhanced_system_purpose?.description_generation?.reason).toBe('disabled-by-env');
    for (const capability of disabledRun.system_capabilities || []) {
      expect(capability.description_source).not.toBe('deterministic');
      expect(capability.description_generation?.status).not.toBe('deterministic_initial');
      expect(capability.description_generation?.status).not.toBe('deterministic_kept');
    }
    for (const entity of disabledRun.data_entities || []) {
      expect(entity.description_source).not.toBe('deterministic');
    }
  });

  it('THROWS when comprehension is attempted but the AI provider fails (no deterministic fallback)', async () => {
    const describeSpy = jest.spyOn(aiService, 'generateComponentDescription');

    setAIEnv({
      KLAURO_AI_INTERPRETATION: 'true',
      KLAURO_AI_ELEMENT_DESCRIPTIONS: 'true',
      KLAURO_EMBEDDING_ENABLED: 'false',
      OPENAI_API_KEY: 'test-determinism-key',
    });
    resetAICooldownState();
    describeSpy.mockReset();
    describeSpy.mockRejectedValue(new Error('ai provider unavailable'));
    await expect(createPipelineOrchestrator().orchestrateAnalysis(fixtureDir)).rejects.toThrow(
      /comprehension/i,
    );
  });

  it('writes AI comprehension with an ai provenance and keeps structure identical to the AI-off run', async () => {
    const describeSpy = jest.spyOn(aiService, 'generateComponentDescription');

    // Baseline structure with comprehension off.
    setAIEnv({
      KLAURO_AI_INTERPRETATION: 'false',
      KLAURO_AI_ELEMENT_DESCRIPTIONS: 'false',
      KLAURO_EMBEDDING_ENABLED: 'false',
    });
    resetAICooldownState();
    describeSpy.mockReset();
    describeSpy.mockRejectedValue(new Error('AI must not be called when disabled'));
    const disabledRun = await createPipelineOrchestrator().orchestrateAnalysis(fixtureDir);

    setAIEnv({
      KLAURO_AI_INTERPRETATION: 'true',
      KLAURO_AI_ELEMENT_DESCRIPTIONS: 'true',
      KLAURO_EMBEDDING_ENABLED: 'false',
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
    // Comprehension, when produced, is AI provenance — never deterministic.
    expect(enabledRun.enhanced_system_purpose?.description_source).toBe('ai');
    expect(enabledRun.enhanced_system_purpose?.description_generation?.status).toBe('ai_applied');
    expect(enabledRun.enhanced_system_purpose?.description_source).not.toBe('deterministic');
    expect(enabledRun.enhanced_system_purpose?.domain_source).not.toBe('deterministic');
    if (enabledRun.enhanced_system_purpose?.domain_source === 'ai') {
      expect(enabledRun.enhanced_system_purpose?.primary_domain).toBe('customer-order-tracking');
    }
    for (const capability of enabledRun.system_capabilities || []) {
      expect(capability.description_source).not.toBe('deterministic');
      expect(capability.description_generation?.status).not.toBe('deterministic_initial');
      expect(capability.description_generation?.status).not.toBe('deterministic_kept');
      if (capability.description_source === 'ai') {
        expect(['ai_applied', 'ai_rejected', 'ai_skipped', 'ai_failed']).toContain(
          capability.description_generation?.status,
        );
      }
    }

    // Camp-B structure is identical whether comprehension is off or AI-on.
    expect(structuralView(enabledRun)).toEqual(structuralView(disabledRun));
  });

  it('keeps entity prose out of the required first pass and marks it for explicit lazy enrichment', async () => {
    const describeSpy = jest.spyOn(aiService, 'generateComponentDescription');
    const semanticDatasetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-semantic-dataset-'));

    setAIEnv({
      KLAURO_AI_INTERPRETATION: 'true',
      KLAURO_AI_ELEMENT_DESCRIPTIONS: 'true',
      KLAURO_EMBEDDING_ENABLED: 'false',
      OPENAI_API_KEY: 'test-determinism-key',
    });
    process.env.KLAURO_SEMANTIC_DATASET_DIR = semanticDatasetDir;
    resetAICooldownState();
    describeSpy.mockReset();
    describeSpy.mockImplementation(async (opts: any) => {
      const items = opts?.additionalContext?.items;
      // Entity-description batch: this call's items are DescriptionTarget
      // objects tagged kind:'entity' — reply with an entity-grounded sentence
      // that names the subject and one of its own fields (the same grounding
      // tokens the shared element-description validator checks for).
      if (Array.isArray(items) && items.every((item: any) => item?.kind === 'entity')) {
        return JSON.stringify({
          descriptions: items.map((item: any) => ({
            id: item.id,
            description: `${item.name} is the customer order record this order-tracking service creates, looks up, and lists, carrying fields such as ${item.fields?.[0]?.split(':')[0] || 'its identifying data'}.`,
          })),
        });
      }
      return JSON.stringify({
        system_description:
          'This service is an Express HTTP API for order tracking that records customer orders in an in-memory order store. It exposes endpoints to create a new order, fetch one order by id, and list all stored orders as JSON.',
        domain: 'customer-order-tracking',
        descriptions: [],
      });
    });

    let enabledRun: CASOutput;
    try {
      enabledRun = await createPipelineOrchestrator().orchestrateAnalysis(fixtureDir);
    } finally {
      delete process.env.KLAURO_SEMANTIC_DATASET_DIR;
    }

    const dataEntities = enabledRun.data_entities || [];
    expect(dataEntities.length).toBeGreaterThan(0);
    for (const entity of dataEntities) {
      expect(entity.description_source).toBeUndefined();
      expect(entity.description_generation).toEqual(expect.objectContaining({
        status: 'ai_skipped',
        attempted: false,
        reason: 'manual-trigger-only',
      }));
    }
    expect(describeSpy.mock.calls.some(call => {
      const items = (call[0] as any)?.additionalContext?.items;
      return Array.isArray(items) && items.length > 0 && items.every((item: any) => item?.kind === 'entity');
    })).toBe(false);
    expect(enabledRun.enhanced_system_purpose?.entity_description_coverage).toEqual(expect.objectContaining({
      total: dataEntities.length,
      attempted: 0,
      budget_ms: 0,
      stopped_reason: 'manual-trigger-only',
    }));

    const dayFile = path.join(semanticDatasetDir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    const rows = fs.readFileSync(dayFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const entityDecisions = rows.filter((row: any) => row.decision_type === 'entity_description');
    expect(entityDecisions).toHaveLength(0);
    const systemDecisions = rows.filter((row: any) => row.decision_type === 'system_description');
    expect(systemDecisions.length).toBeGreaterThan(0);

    fs.rmSync(semanticDatasetDir, { recursive: true, force: true });
  });
});
