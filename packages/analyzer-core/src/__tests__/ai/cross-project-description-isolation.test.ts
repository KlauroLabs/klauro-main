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

jest.setTimeout(180000);

const svc = aiService as any;

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

let projectA: string;
let projectB: string;

const SHOPIFY_DESCRIPTION =
  'Shopwave is an ecommerce storefront theme service built on Express where merchants manage Shopify theme development, server-rendered Liquid templates, storefront sections, and online store settings through HTTP endpoints.';
const CMS_DESCRIPTION =
  'PageCraft is a content management service built on Express where editors create pages, publish site content, and manage page revisions through HTTP endpoints.';

function writeExpressFixture(root: string, packageName: string, readme: string, noun: string): void {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: packageName, version: '1.0.0', dependencies: { express: '^4.18.2' } }, null, 2),
  );
  fs.writeFileSync(path.join(root, 'README.md'), readme);
  fs.writeFileSync(
    path.join(root, 'src', 'server.ts'),
    [
      "import express from 'express';",
      '',
      'const app = express();',
      'app.use(express.json());',
      '',
      `const ${noun}s = new Map<string, { id: string; title: string }>();`,
      '',
      `app.get('/${noun}s', (req, res) => {`,
      `  res.json([...${noun}s.values()]);`,
      '});',
      '',
      `app.post('/${noun}s', (req, res) => {`,
      `  ${noun}s.set(req.body.id, req.body);`,
      '  res.status(201).json(req.body);',
      '});',
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

function resetAICooldownState(): void {
  (AnalyzerOrchestrator as any).aiInterpretationTimeouts = 0;
  (AnalyzerOrchestrator as any).aiInterpretationDisabledUntil = 0;
}

describe('cross-project description isolation', () => {
  beforeAll(() => {
    for (const key of AI_ENV_KEYS) savedEnv[key] = process.env[key];

    projectA = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-isolation-a-'));
    projectB = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-isolation-b-'));

    writeExpressFixture(
      projectA,
      'shopwave',
      'Shopwave is a Shopify theme for Online Store 2.0 storefronts. Merchants customize server-rendered Liquid templates, theme sections, and storefront settings for their online store.\n',
      'section',
    );
    writeExpressFixture(
      projectB,
      'pagecraft',
      'PageCraft is a content management system for publishing site content. Editors switch the admin theme between a light theme and a dark theme, preview the theme on draft pages, and publish page revisions.\n',
      'page',
    );
  });

  afterAll(() => {
    for (const key of AI_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    fs.rmSync(projectA, { recursive: true, force: true });
    fs.rmSync(projectB, { recursive: true, force: true });
  });

  it('never leaks project A description text or cache entries into project B', async () => {
    process.env.KLAURO_AI_INTERPRETATION = 'true';
    process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS = 'false';
    process.env.KLAURO_EMBEDDING_ENABLED = 'false';
    process.env.OPENAI_API_KEY = 'test-isolation-key';
    delete process.env.AI_DESCRIPTION_ALLOW_RULE_BASED_FALLBACK;

    const mockProvider = {
      name: 'mock',
      generateDescription: jest.fn(async (context: any) => {
        const serialized = JSON.stringify(context);
        if (/shopwave/i.test(serialized)) {
          return JSON.stringify({ system_description: SHOPIFY_DESCRIPTION, domain: 'ecommerce-storefront-theme', descriptions: [] });
        }
        return JSON.stringify({ system_description: CMS_DESCRIPTION, domain: 'page-content-management', descriptions: [] });
      }),
    };
    const providerSpy = jest.spyOn(svc, 'selectBestProvider').mockResolvedValue(mockProvider);
    const cacheSetSpy = jest.spyOn(svc.cache, 'set');

    // Isolate the cache layers so prior runs on this machine cannot satisfy
    // lookups; both projects in this test must share one in-memory cache.
    svc.cache.fallbackCache.clear();
    svc.cache.diskCacheEnabled = false;
    svc.cache.redis = undefined;

    try {
      resetAICooldownState();
      const runA = await createPipelineOrchestrator().orchestrateAnalysis(projectA);
      const keysAfterA = cacheSetSpy.mock.calls.map(call => call[0] as string);
      const callsAfterA = mockProvider.generateDescription.mock.calls.length;
      expect(callsAfterA).toBeGreaterThan(0);

      resetAICooldownState();
      const runB = await createPipelineOrchestrator().orchestrateAnalysis(projectB);
      const keysAfterB = cacheSetSpy.mock.calls.map(call => call[0] as string).slice(keysAfterA.length);

      // Project B must have triggered its own provider call instead of being
      // served project A's cached description.
      expect(mockProvider.generateDescription.mock.calls.length).toBeGreaterThan(callsAfterA);
      const serializedBCalls = mockProvider.generateDescription.mock.calls
        .slice(callsAfterA)
        .map(call => JSON.stringify(call[0]));
      expect(serializedBCalls.some(call => /pagecraft/i.test(call))).toBe(true);

      // The cache entries for the two projects must be distinct keys.
      expect(keysAfterB.length).toBeGreaterThan(0);
      for (const key of keysAfterB) {
        expect(keysAfterA).not.toContain(key);
      }

      // Project A's identity may mention its own Shopify/Liquid evidence.
      const purposeA = JSON.stringify(runA.enhanced_system_purpose || {});
      expect(purposeA.length).toBeGreaterThan(0);

      // Project B's entire output must not contain project A's text: not the
      // mocked AI sentence, and not any Shopify/Liquid claim from any
      // deterministic summary path.
      const serializedB = JSON.stringify(runB);
      expect(serializedB).not.toContain(SHOPIFY_DESCRIPTION);
      expect(serializedB).not.toMatch(/shopify/i);
      expect(serializedB).not.toMatch(/liquid/i);
      expect(runB.enhanced_system_purpose?.primary_domain).not.toBe('ecommerce-storefront');
    } finally {
      providerSpy.mockRestore();
      cacheSetSpy.mockRestore();
      svc.cache.fallbackCache.clear();
    }
  });
});
