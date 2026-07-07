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
let refFixtureDir: string;

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

/**
 * Fixture engineered to exercise the KNOWN OPEN DEFECT documented in
 * docs/cas/DETERMINISM-BOUNDARY.md §"Camp B must be run-to-run deterministic":
 * cross-file `references`-edge resolution is not guaranteed deterministic because
 * ambiguous name resolution (findNodeIdByNameIndexed → directMatch[0] when a name
 * is defined in multiple files) depends on file-processing / node-collection order.
 *
 * A `references` edge is emitted for a *plain read* of an imported const/interface/
 * type/class that is never called (typescript-javascript-analyzer.ts ~line 1855).
 * To provoke the ambiguity path we:
 *   1. define the SAME identifier name (`CONFIG`, `Settings`) in multiple modules,
 *   2. import and *read* (not call) those identifiers cross-file in several consumers,
 * so target resolution must pick among multiple same-named declarations. Any
 * run-to-run flip in that selection changes the `references` edge id set.
 */
function writeReferenceFixture(root: string): void {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(
      { name: 'klauro-ref-stability-fixture', version: '1.0.0' },
      null,
      2,
    ),
  );

  // Two modules that each declare an identically-named CONFIG const and Settings
  // interface. This is the ambiguity: `nodesByName.get('CONFIG')` returns >1 node.
  const declModule = (tag: string): string =>
    [
      'export interface Settings {',
      '  region: string;',
      '  retries: number;',
      '}',
      '',
      'export const CONFIG: Settings = {',
      `  region: '${tag}',`,
      '  retries: 3,',
      '};',
      '',
      'export const LIMITS = {',
      `  ${tag}Max: 100,`,
      '};',
      '',
    ].join('\n');

  fs.writeFileSync(path.join(root, 'src', 'config-a.ts'), declModule('alpha'));
  fs.writeFileSync(path.join(root, 'src', 'config-b.ts'), declModule('beta'));

  // Consumers that IMPORT and READ (never call) the ambiguous identifiers. Plain
  // property/identifier reads => `references` edges resolved by name.
  const consumer = (n: number, from: string): string =>
    [
      `import { CONFIG, LIMITS } from './${from}';`,
      `import type { Settings } from './${from}';`,
      '',
      `export function consume${n}(): number {`,
      '  const s: Settings = CONFIG;',
      '  const region = CONFIG.region;',
      `  const cap = LIMITS;`,
      '  return s.retries + region.length + Object.keys(cap).length;',
      '}',
      '',
    ].join('\n');

  fs.writeFileSync(path.join(root, 'src', 'consumer-1.ts'), consumer(1, 'config-a'));
  fs.writeFileSync(path.join(root, 'src', 'consumer-2.ts'), consumer(2, 'config-b'));
  fs.writeFileSync(path.join(root, 'src', 'consumer-3.ts'), consumer(3, 'config-a'));
  fs.writeFileSync(path.join(root, 'src', 'consumer-4.ts'), consumer(4, 'config-b'));
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

/**
 * Canonical, order-independent view of the cross-file `references` edge set.
 * Returns a sorted array of "source|target" pairs so run-to-run comparison is
 * insensitive to edge emission ORDER but sensitive to which edges exist and how
 * they resolved (source→target). A flip in ambiguous name resolution changes a
 * target and therefore this set.
 */
function referenceEdgeSet(output: CASOutput): string[] {
  return output.edges
    .filter((e) => e.type === 'references')
    .map((e) => `${e.source}|${e.target}`)
    .sort();
}

/** Basename of a node's source file, e.g. 'config-b.ts', for readable asserts. */
function nodeFileBase(output: CASOutput, nodeId: string): string | undefined {
  const node = output.nodes.find((n) => n.id === nodeId);
  const file = node?.source?.file;
  return file ? path.basename(file) : undefined;
}

/**
 * For each cross-file `references` edge, report the CONSUMER file the reading
 * function lives in and the MODULE file the resolved declaration lives in, but
 * only for the ambiguous same-named identifiers (CONFIG / LIMITS / Settings).
 * This is what proves *import-source-aware* attribution, not mere determinism.
 */
function ambiguousReferenceAttributions(
  output: CASOutput,
): Array<{ consumer: string; target: string; module: string }> {
  const ambiguous = new Set(['CONFIG', 'LIMITS', 'Settings']);
  const nodeById = new Map(output.nodes.map((n) => [n.id, n]));
  const out: Array<{ consumer: string; target: string; module: string }> = [];
  for (const e of output.edges) {
    if (e.type !== 'references') continue;
    const targetNode = nodeById.get(e.target);
    if (!targetNode || !ambiguous.has(targetNode.name)) continue;
    const consumer = nodeFileBase(output, e.source);
    const module = nodeFileBase(output, e.target);
    if (consumer && module) out.push({ consumer, target: targetNode.name, module });
  }
  return out;
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
    refFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-ref-stability-'));
    writeReferenceFixture(refFixtureDir);
  });

  afterAll(() => {
    for (const key of AI_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    fs.rmSync(fixtureDir, { recursive: true, force: true });
    fs.rmSync(refFixtureDir, { recursive: true, force: true });
  });

  it('produces an identical CAS across repeated analyses, excluding run metadata', async () => {
    const firstRun = await createPipelineOrchestrator().orchestrateAnalysis(fixtureDir);
    const secondRun = await createPipelineOrchestrator().orchestrateAnalysis(fixtureDir);

    expect(firstRun.nodes.length).toBeGreaterThan(0);
    expect(stableView(secondRun)).toEqual(stableView(firstRun));
  });

  // Regression for docs/cas/DETERMINISM-BOUNDARY.md §"Camp B must be run-to-run
  // deterministic (and currently is NOT, in one place)": the cross-file
  // `references`-edge SET (source→target pairs, order-independent) must be
  // byte-identical across independent analysis runs of the same source. If
  // ambiguous name resolution still depends on processing order, one of the N
  // runs will produce a different set and this fails — which is the current
  // documented defect, surfaced deterministically here rather than only on a
  // 24k-node repo.
  it('resolves an identical cross-file `references` edge set across independent runs', async () => {
    const RUNS = 6;
    const sets: string[][] = [];
    for (let i = 0; i < RUNS; i++) {
      const out = await createPipelineOrchestrator().orchestrateAnalysis(refFixtureDir);
      sets.push(referenceEdgeSet(out));
    }

    // Sanity: the fixture must actually produce `references` edges, otherwise the
    // assertion below is vacuous and would silently "pass" while covering nothing.
    expect(sets[0].length).toBeGreaterThan(0);

    const baseline = sets[0];
    for (let i = 1; i < RUNS; i++) {
      // Report the delta explicitly so a flip is legible, not just "not equal".
      const added = sets[i].filter((e) => !baseline.includes(e));
      const removed = baseline.filter((e) => !sets[i].includes(e));
      if (added.length || removed.length) {
        // eslint-disable-next-line no-console
        console.error(
          `[references-edge nondeterminism] run ${i} vs run 0: ` +
            `+${added.length} / -${removed.length} edges. ` +
            `count ${baseline.length} -> ${sets[i].length}. ` +
            `added=${JSON.stringify(added)} removed=${JSON.stringify(removed)}`,
        );
      }
      expect(sets[i]).toEqual(baseline);
    }
  });

  // Correctness (not just determinism): a consumer that imports an ambiguous
  // identifier FROM a specific module must have its `references` edge attributed
  // to THAT module's declaration. consumer-1/consumer-3 import from config-a;
  // consumer-2/consumer-4 import from config-b. Before the import-source-aware
  // fix, every consumer collapsed onto config-a (directMatch[0], config-a sorts
  // first), so consumer-2/4 were MIS-attributed. This asserts the fix: config-b
  // consumers resolve to config-b's nodes.
  it('attributes cross-module references to the imported source module (config-b, not config-a)', async () => {
    const out = await createPipelineOrchestrator().orchestrateAnalysis(refFixtureDir);
    const attributions = ambiguousReferenceAttributions(out);

    // Must actually have resolved edges for the ambiguous names, else vacuous.
    expect(attributions.length).toBeGreaterThan(0);

    // Every attribution must point at the module the consumer imported from.
    const expectedModule: Record<string, string> = {
      'consumer-1.ts': 'config-a.ts',
      'consumer-2.ts': 'config-b.ts',
      'consumer-3.ts': 'config-a.ts',
      'consumer-4.ts': 'config-b.ts',
    };
    const misattributed = attributions.filter(
      (a) => expectedModule[a.consumer] && a.module !== expectedModule[a.consumer],
    );
    expect(misattributed).toEqual([]);

    // Positively assert the previously-broken case is now correct: at least one
    // config-b consumer resolves an ambiguous identifier to config-b.ts.
    const configBHits = attributions.filter(
      (a) =>
        (a.consumer === 'consumer-2.ts' || a.consumer === 'consumer-4.ts') &&
        a.module === 'config-b.ts',
    );
    expect(configBHits.length).toBeGreaterThan(0);
  });
});
