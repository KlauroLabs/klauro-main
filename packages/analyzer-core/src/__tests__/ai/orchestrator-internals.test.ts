import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import { TerraformAnalyzer } from '../../analyzer/languages/terraform-analyzer';
import { aiService } from '../../ai/ai-service';
import { CASDataEntity, CASEdge, CASEntryPoint, CASExitPoint, CASNode } from '../../types/cas.types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// These exercise internal heuristics of the orchestrator. They are private by
// design (not part of the public CAS contract) so the tests reach them via a
// typed `any` handle rather than widening the class surface.
const orch = new AnalyzerOrchestrator() as any;

function exitPoint(partial: Partial<CASExitPoint>): CASExitPoint {
  return {
    id: partial.id || 'ex_1',
    source_node: partial.source_node || 'node_1',
    type: partial.type || 'sdk',
    name: partial.name || 'Call to thing',
    ...partial,
  } as CASExitPoint;
}

describe('orchestrator exit-point filtering', () => {
  it('keeps a genuine third-party SDK exit point', async () => {
    const ep = exitPoint({
      type: 'sdk',
      name: 'Call to forward',
      target: { sdk: 'ngrok', endpoint: 'ngrok.forward' },
    });
    expect(orch.isValidExitPoint(ep)).toBe(true);
  });

  it('keeps a database exit point', async () => {
    expect(orch.isValidExitPoint(exitPoint({ type: 'database', name: 'SELECT users' }))).toBe(true);
  });

  it('drops a stdlib path.* call mistaken for a file exit point', async () => {
    const ep = exitPoint({ type: 'file', name: 'path.join', target: { resource: 'path.join' } });
    expect(orch.isValidExitPoint(ep)).toBe(false);
  });

  it('drops fs.* stdlib noise', async () => {
    expect(orch.isValidExitPoint(exitPoint({ type: 'file', name: 'fs.readFileSync' }))).toBe(false);
  });

  it('drops an "sdk" exit point that targets a local relative module', async () => {
    const ep = exitPoint({
      type: 'sdk',
      name: 'Call to loadConfig',
      target: { sdk: './config/index.js', endpoint: 'loadConfig' },
      metadata: { library: './config/index.js' },
    });
    expect(orch.isValidExitPoint(ep)).toBe(false);
  });

  it('drops an "sdk" exit point whose library resolution fell back to the call target', async () => {
    const ep = exitPoint({
      type: 'sdk',
      name: 'Call to skillRepository.findByName',
      target: { sdk: 'skillRepository.findByName', endpoint: 'skillRepository.findByName' },
    });
    expect(orch.isValidExitPoint(ep)).toBe(false);
  });

  it('rejects an unknown exit-point type', async () => {
    expect(orch.isValidExitPoint(exitPoint({ type: 'nonsense' as any }))).toBe(false);
  });
});

describe('orchestrator test-suite fallback discovery', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-test-suite-fallback-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const write = (relative: string, content: string) => {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  it('creates CAS test suites from executable source test files when analyzer nodes are missing', async () => {
    write('alpha_engine/tests/unit/test_risk_manager.py', [
      'def test_blocks_oversized_position():',
      '    assert True',
    ].join('\n'));
    write('apps/android/app/src/test/java/ai/openclaw/android/WakeWordsTest.kt', [
      'import org.junit.Test',
      'class WakeWordsTest {',
      '  @Test fun extractsWakeWord() {}',
      '}',
    ].join('\n'));
    write('fixtures/demo/tests/ignored.test.ts', "test('fixture smoke', async () => {});\n");

    const suites = await orch.buildTestSuites([], [], root);

    expect(suites.map((suite: any) => suite.file_path).sort()).toEqual([
      'alpha_engine/tests/unit/test_risk_manager.py',
      'apps/android/app/src/test/java/ai/openclaw/android/WakeWordsTest.kt',
    ]);
    expect(suites.find((suite: any) => suite.file_path.endsWith('test_risk_manager.py')).framework).toBe('pytest');
    expect(suites.find((suite: any) => suite.file_path.endsWith('WakeWordsTest.kt')).framework).toBe('junit');
  });
});

describe('isLocalModuleSpecifier', () => {
  it.each([
    ['./foo', true],
    ['../bar/baz', true],
    ['/abs/path', true],
    ['express', false],
    ['@scope/pkg', false],
    ['ngrok', false],
  ])('classifies %s', (specifier, expected) => {
    expect(orch.isLocalModuleSpecifier(specifier)).toBe(expected);
  });
});

describe('normalizeNodeMetrics', () => {
  it('derives lines_of_code from the source span', async () => {
    const nodes: CASNode[] = [
      { id: 'n1', name: 'f', type: 'function', source: { line: 10, end_line: 30 }, metadata: {} } as CASNode,
    ];
    orch.normalizeNodeMetrics(nodes);
    expect(nodes[0].metadata!.metrics!.lines_of_code).toBe(21);
  });

  it('consolidates attribute-stashed complexity into complexity.cyclomatic', async () => {
    const nodes: CASNode[] = [
      { id: 'n1', name: 'f', type: 'function', metadata: { attributes: { complexity: 7 } } } as CASNode,
    ];
    orch.normalizeNodeMetrics(nodes);
    expect(nodes[0].metadata!.complexity!.cyclomatic).toBe(7);
  });

  it('does not overwrite an existing canonical cyclomatic value', async () => {
    const nodes: CASNode[] = [
      {
        id: 'n1',
        name: 'f',
        type: 'function',
        metadata: { complexity: { cyclomatic: 4 }, attributes: { complexity: 99 } },
      } as CASNode,
    ];
    orch.normalizeNodeMetrics(nodes);
    expect(nodes[0].metadata!.complexity!.cyclomatic).toBe(4);
  });
});

describe('computeMaintainabilityIndex', () => {
  it('returns undefined when no code unit carries metrics', async () => {
    const nodes: CASNode[] = [{ id: 'n1', name: 'f', type: 'function', metadata: {} } as CASNode];
    expect(orch.computeMaintainabilityIndex(nodes)).toBeUndefined();
  });

  it('returns a 0-100 score for function nodes with metrics', async () => {
    const nodes: CASNode[] = [
      {
        id: 'n1',
        name: 'f',
        type: 'function',
        metadata: { metrics: { lines_of_code: 20 }, complexity: { cyclomatic: 3 } },
      } as CASNode,
    ];
    const mi = orch.computeMaintainabilityIndex(nodes);
    expect(typeof mi).toBe('number');
    expect(mi).toBeGreaterThanOrEqual(0);
    expect(mi).toBeLessThanOrEqual(100);
  });

  it('ignores file/module nodes so their line spans do not skew the average', async () => {
    const nodes: CASNode[] = [
      {
        id: 'file1',
        name: 'big.ts',
        type: 'file',
        metadata: { metrics: { lines_of_code: 5000 }, complexity: { cyclomatic: 1 } },
      } as CASNode,
    ];
    expect(orch.computeMaintainabilityIndex(nodes)).toBeUndefined();
  });
});

describe('calculateQualityMetrics', () => {
  it('never fabricates a maintainability index when data is absent', async () => {
    const nodes: CASNode[] = [{ id: 'n1', name: 'f', type: 'function', metadata: {} } as CASNode];
    const q = orch.calculateQualityMetrics(nodes);
    expect(q.maintainability_index).toBeUndefined();
  });

  it('computes documentation coverage', async () => {
    const nodes: CASNode[] = [
      { id: 'n1', name: 'a', type: 'function', description: 'documented', metadata: {} } as CASNode,
      { id: 'n2', name: 'b', type: 'function', metadata: {} } as CASNode,
    ];
    const q = orch.calculateQualityMetrics(nodes);
    expect(q.documentation_coverage).toBe(50);
  });
});

describe('source inventory analyzer detection', () => {
  it('detects language signals from one shared inventory and ignores generated worktrees', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-inventory-'));
    try {
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      fs.writeFileSync(path.join(root, 'src', 'UserService.ts'), 'export class UserService {}');
      fs.writeFileSync(path.join(root, 'src', 'Program.cs'), 'public class Program {}');
      fs.writeFileSync(path.join(root, 'requirements-prod.txt'), 'fastapi==1.0.0');
      fs.mkdirSync(path.join(root, '.claude', 'worktrees', 'stale'), { recursive: true });
      fs.writeFileSync(path.join(root, '.claude', 'worktrees', 'stale', 'ghost.ts'), 'export const ghost = true;');

      const localOrch = new AnalyzerOrchestrator() as any;
      expect(await localOrch.hasLanguageSignal(root, 'typescript-javascript')).toBe(true);
      expect(await localOrch.hasLanguageSignal(root, 'csharp')).toBe(true);

      const manifests = await localOrch.getManifestFiles(root);
      expect(manifests).toContain('requirements-prod.txt');

      const inventory = await localOrch.getSourceFileInventory(root);
      expect(inventory.files).toContain('src/UserService.ts');
      expect(inventory.files).not.toContain('.claude/worktrees/stale/ghost.ts');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('excludes nested fixture and testdata projects without hiding an explicit fixture root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-inventory-fixtures-'));
    try {
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      fs.writeFileSync(path.join(root, 'package.json'), '{"name":"product"}');
      fs.writeFileSync(path.join(root, 'src', 'ProductService.ts'), 'export class ProductService {}');

      const fixtureRoot = path.join(root, 'fixtures', 'sample-app');
      fs.mkdirSync(path.join(fixtureRoot, 'src'), { recursive: true });
      fs.writeFileSync(path.join(fixtureRoot, 'package.json'), '{"name":"fixture"}');
      fs.writeFileSync(path.join(fixtureRoot, 'src', 'FixtureService.ts'), 'export class FixtureService {}');

      fs.mkdirSync(path.join(root, 'testdata', 'synthetic'), { recursive: true });
      fs.writeFileSync(path.join(root, 'testdata', 'synthetic', 'NoiseService.ts'), 'export class NoiseService {}');
      fs.mkdirSync(path.join(root, 'cas-tests'), { recursive: true });
      fs.writeFileSync(path.join(root, 'cas-tests', 'test-hoggan-analysis.ts'), 'export const clinicalNoise = true;');

      const localOrch = new AnalyzerOrchestrator() as any;
      const productInventory = await localOrch.getSourceFileInventory(root);
      expect(productInventory.files).toContain('package.json');
      expect(productInventory.files).toContain('src/ProductService.ts');
      expect(productInventory.files).not.toContain('fixtures/sample-app/package.json');
      expect(productInventory.files).not.toContain('fixtures/sample-app/src/FixtureService.ts');
      expect(productInventory.files).not.toContain('testdata/synthetic/NoiseService.ts');
      expect(productInventory.files).not.toContain('cas-tests/test-hoggan-analysis.ts');

      const explicitFixtureInventory = await localOrch.getSourceFileInventory(fixtureRoot);
      expect(explicitFixtureInventory.files).toContain('package.json');
      expect(explicitFixtureInventory.files).toContain('src/FixtureService.ts');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('excludes root-level legacy reference apps from Klauro self project discovery', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-inventory-legacy-'));
    try {
      fs.writeFileSync(path.join(root, 'package.json'), '{"name":"@klauro/monorepo"}');
      fs.mkdirSync(path.join(root, 'apps', 'mcp-server', 'src'), { recursive: true });
      fs.writeFileSync(path.join(root, 'apps', 'mcp-server', 'package.json'), '{"name":"mcp-server"}');
      fs.writeFileSync(path.join(root, 'apps', 'mcp-server', 'src', 'server.ts'), 'export const server = true;');

      fs.mkdirSync(path.join(root, 'legacy', 'web', 'src'), { recursive: true });
      fs.writeFileSync(path.join(root, 'legacy', 'web', 'package.json'), '{"dependencies":{"react":"18.0.0","next":"14.0.0"}}');
      fs.writeFileSync(path.join(root, 'legacy', 'web', 'src', 'App.tsx'), 'export function App() { return <div />; }');

      const localOrch = new AnalyzerOrchestrator() as any;
      const inventory = await localOrch.getSourceFileInventory(root);
      const roots = await localOrch.discoverProjectRoots(root);

      expect(inventory.files).toContain('apps/mcp-server/package.json');
      expect(inventory.files).not.toContain('legacy/web/package.json');
      expect(inventory.files.some((file: string) => file.startsWith('legacy/'))).toBe(false);
      expect(roots.map((projectRoot: string) => path.relative(root, projectRoot).replace(/\\/g, '/'))).not.toContain('legacy/web');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // Regression for the workspace-glob variant of this exclusion (a repo whose root
  // package.json declares `"workspaces": [..., "legacy/*"]`) lives in
  // workspace-globs.test.ts, which unmocks `glob`/`fs`/`fs-extra` — required because
  // discoverWorkspaceGlobRootsWithoutManifest calls the real `globSync`, which this
  // file's global jest.mock('glob', ...) (see __tests__/setup.ts) stubs out entirely.
});

describe('detectLibrariesFromManifests pyproject.toml parsing', () => {
  let root: string;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  // Regression: a TOML group/extras KEY (`dev`, `test`, `ml`) inside
  // [project.optional-dependencies] or [tool.poetry.group.<name>.dependencies]
  // was mistaken for a package, producing a spurious CASLibrary named "dev".
  it('does not emit a "dev" library from optional-dependencies/poetry group keys, and keeps the real packages', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-pyproject-dev-'));
    fs.writeFileSync(
      path.join(root, 'pyproject.toml'),
      [
        '[project]',
        'name = "sample"',
        '',
        '[project.optional-dependencies]',
        'ml = [',
        '    "torch>=2.5.0",',
        '    "scipy>=1.14.0",',
        ']',
        'dev = [',
        '    "black>=24.1.0",',
        ']',
        '',
        '[tool.poetry.group.dev.dependencies]',
        'pytest = "^8.0"',
        'ruff = "^0.8.0"',
        '',
      ].join('\n'),
    );

    const libs: any[] = orch.detectLibrariesFromManifests(root);
    const names = libs.map((l) => l.name);

    // The group/extras keys must NOT surface as packages.
    expect(names).not.toContain('dev');
    expect(names).not.toContain('ml');
    // The genuine packages inside those sections must still be extracted.
    expect(names).toContain('torch');
    expect(names).toContain('scipy');
    expect(names).toContain('black');
    expect(names).toContain('pytest');
    expect(names).toContain('ruff');
  });
});

describe('architecture and capability inference', () => {
  const node = (partial: Partial<CASNode>): CASNode => ({
    id: partial.id || partial.name || 'node',
    name: partial.name || 'Node',
    type: partial.type || 'class',
    source: partial.source || { file: `src/${partial.name || 'node'}.ts`, line: 1 },
    metadata: partial.metadata || {},
    subcategories: partial.subcategories,
    children: partial.children,
    parent: partial.parent,
    signature: partial.signature,
  } as CASNode);

  it('detects MVC, Repository, Service Layer, and inventory from product source only', async () => {
    const nodes: CASNode[] = [
      node({ id: 'user-controller', name: 'UsersController', type: 'controller', source: { file: 'src/users/users.controller.ts' } }),
      node({ id: 'user-service', name: 'UsersService', type: 'service', source: { file: 'src/users/users.service.ts' } }),
      node({ id: 'user-repository', name: 'UsersRepository', type: 'repository', source: { file: 'src/users/users.repository.ts' } }),
      node({ id: 'user-entity', name: 'UserEntity', type: 'entity', source: { file: 'src/users/user.entity.ts' } }),
      node({ id: 'users-view', name: 'UsersPage', type: 'component', source: { file: 'src/users/UsersPage.tsx' } }),
      node({ id: 'fixture-controller', name: 'MobileScreenController', type: 'controller', source: { file: 'fixtures/flutter/lib/screen.dart' } }),
      node({ id: 'fixture-module', name: 'fixtures.idioms.python-api.tests.test_users', type: 'module' }),
      node({ id: 'using-node', name: 'System.Collections.Generic', type: 'using', source: { file: 'src/users/users.service.cs' } }),
    ];

    const summary = orch.buildArchitectureSummary(nodes, [], [], []);

    expect(summary.architectural_inventory?.controllers).toContain('user-controller');
    expect(summary.architectural_inventory?.controllers).not.toContain('fixture-controller');
    expect(summary.architectural_inventory?.packages).not.toContain('fixture-module');
    expect(summary.architectural_inventory?.packages).not.toContain('using-node');
    for (const pattern of summary.architectural_patterns || []) {
      expect(pattern.node_ids).not.toContain('fixture-module');
      expect(pattern.node_ids).not.toContain('using-node');
    }
    expect(summary.architectural_patterns?.map((pattern: any) => pattern.name)).toEqual(
      expect.arrayContaining(['MVC', 'Repository', 'Service Layer'])
    );
    expect(summary.pattern_balance?.status).toBe('balanced');
  });

  it('identifies an MCP analyzer monorepo ahead of incidental legacy framework analyzers', async () => {
    // A real MCP tool server exposes its capability as MCP tool registrations: 'mcp_tool' nodes
    // plus 'message' entry points (produced by the mcp-tool-registration-analyzer). This dominant
    // MCP entry surface — not a mere dependency on the SDK or an "Analyzer"-named class — is what
    // qualifies a repo as an MCP analyzer.
    const nodes: CASNode[] = [
      node({ id: 'mcp-server-file', name: 'server.ts', type: 'file', source: { file: 'apps/mcp-server/src/server.ts' } }),
      node({ id: 'mcp-tool-1', name: 'getArchitectureContext', type: 'mcp_tool', source: { file: 'apps/mcp-server/src/server.ts' } }),
      node({ id: 'mcp-tool-2', name: 'getCallers', type: 'mcp_tool', source: { file: 'apps/mcp-server/src/server.ts' } }),
      node({ id: 'mcp-tool-3', name: 'getSummary', type: 'mcp_tool', source: { file: 'apps/mcp-server/src/server.ts' } }),
      node({ id: 'mcp-tool-4', name: 'searchNodes', type: 'mcp_tool', source: { file: 'apps/mcp-server/src/server.ts' } }),
      node({ id: 'mcp-tool-5', name: 'getRouteTable', type: 'mcp_tool', source: { file: 'apps/mcp-server/src/server.ts' } }),
      node({ id: 'analyzer-file', name: 'orchestrator.ts', type: 'file', source: { file: 'packages/analyzer-core/src/analyzer/core/orchestrator.ts' } }),
      node({ id: 'analyzer-class', name: 'AnalyzerOrchestrator', type: 'class', source: { file: 'packages/analyzer-core/src/analyzer/core/orchestrator.ts' } }),
      node({ id: 'legacy-route', name: 'legacyRoute', type: 'function', source: { file: 'legacy/api/routes.ts' } }),
    ];
    const entryPoints = ['mcp-tool-1', 'mcp-tool-2', 'mcp-tool-3', 'mcp-tool-4', 'mcp-tool-5'].map((sourceNode, index) => ({
      id: `entry-mcp-${index}`,
      type: 'message',
      name: sourceNode,
      source_node: sourceNode,
      trigger: { method: 'registerTool', path: sourceNode },
    }));
    const contributions = [
      { analyzer_type: 'framework', analyzer_name: 'Express.js Analyzer', nodes_created: 3, confidence: 1 },
      { analyzer_type: 'framework', analyzer_name: 'NestJS Analyzer', nodes_created: 6, confidence: 1 },
      { analyzer_type: 'language', analyzer_name: 'TypeScript/JavaScript Analyzer', nodes_created: 200 },
    ];

    const summary = orch.buildArchitectureSummary(nodes, entryPoints as any, [], contributions);

    expect(summary.system_type).toBe('MCP analyzer monorepo');
  });

  it('classifies a crypto/NestJS API that merely imports the MCP SDK as an API service, not an MCP analyzer', async () => {
    // Regression: soon-lens is a NestJS crypto-market API that depends on @modelcontextprotocol/sdk
    // (a few agent-preflight endpoints) and ships "Analyzer"-named service classes, yet its dominant
    // entry surface is HUNDREDS of HTTP routes. It must classify as the API service it is — the
    // incidental MCP surface must never leak Klauro's own "MCP analyzer service" identity onto it.
    const nodes: CASNode[] = [
      ...Array.from({ length: 4 }, (_v, index) => node({
        id: `controller-${index}`,
        name: `Market${index}Controller`,
        type: 'controller',
        source: { file: `src/market/market-${index}.controller.ts` },
      })),
      node({ id: 'risk-analyzer', name: 'RiskAnalyzer', type: 'service', source: { file: 'src/risk/risk-analyzer.service.ts' } }),
      node({ id: 'mcp-tool-1', name: 'preflight', type: 'mcp_tool', source: { file: 'src/agent/preflight.controller.ts' } }),
      node({ id: 'ohlcv-entity', name: 'OhlcvCandle', type: 'entity', source: { file: 'src/market/ohlcv.entity.ts' } }),
    ];
    const httpEntryPoints = Array.from({ length: 12 }, (_v, index) => ({
      id: `entry-http-${index}`,
      type: 'http',
      name: `GET /market/${index}`,
      source_node: `controller-${index % 4}`,
      handler: { node_id: `controller-${index % 4}`, file: `src/market/market-${index % 4}.controller.ts` },
      trigger: { method: 'GET', path: `/market/${index}` },
    }));
    const mcpEntryPoint = {
      id: 'entry-mcp-0',
      type: 'message',
      name: 'preflight',
      source_node: 'mcp-tool-1',
      trigger: { method: 'registerTool', path: 'preflight' },
    };
    const contributions = [
      { analyzer_type: 'framework', analyzer_name: 'NestJS Analyzer', nodes_created: 50, confidence: 1 },
    ];

    const summary = orch.buildArchitectureSummary(nodes, [...httpEntryPoints, mcpEntryPoint] as any, [], contributions);

    expect(summary.system_type).not.toBe('MCP analyzer service');
    expect(summary.system_type).not.toBe('MCP analyzer monorepo');
    // A NestJS API with data entities resolves to a backend/API service — the exact label depends
    // on framework/data signals, but it must be one of the dominant-API-surface classifications,
    // never the incidental MCP-analyzer one.
    expect(['API service', 'Backend service']).toContain(summary.system_type);
  });

  it('uses dominant product shape instead of tiny framework contributions for API services', async () => {
    const nodes: CASNode[] = [
      node({ id: 'orders-controller', name: 'OrdersController', type: 'controller', source: { file: 'src/orders/orders.controller.ts' } }),
      node({ id: 'orders-service', name: 'OrdersService', type: 'service', source: { file: 'src/orders/orders.service.ts' } }),
      node({ id: 'orders-repository', name: 'OrdersRepository', type: 'repository', source: { file: 'src/orders/orders.repository.ts' } }),
      node({ id: 'order-entity', name: 'OrderEntity', type: 'entity', source: { file: 'src/orders/order.entity.ts' } }),
    ];
    const entryPoints = [{
      id: 'ep-orders',
      type: 'http',
      name: 'GET /orders',
      source_node: 'orders-controller',
      handler: { node_id: 'orders-controller', file: 'src/orders/orders.controller.ts' },
      trigger: { method: 'GET', path: '/orders' },
    }];
    const contributions = [
      { analyzer_type: 'framework', analyzer_name: 'Express.js Analyzer', nodes_created: 2, confidence: 1 },
    ];

    const summary = orch.buildArchitectureSummary(nodes, entryPoints, [], contributions);

    expect(summary.system_type).toBe('API service');
  });

  it('classifies Symfony backend apps with template view-models as backend services, not desktop apps', async () => {
    const nodes: CASNode[] = [
      node({ id: 'webhook-controller', name: 'WebhookController', type: 'controller', source: { file: 'src/Controller/WebhookController.php' } }),
      node({ id: 'invoice-service', name: 'InvoiceService', type: 'service', source: { file: 'src/Service/BillingSystem/InvoiceService.php' } }),
      node({ id: 'vehicle-entity', name: 'Vehicle', type: 'entity', source: { file: 'src/Entity/Vehicle.php' } }),
      node({ id: 'email-view-model', name: 'EmailInvoiceCreatedTemplateViewModel', type: 'class', source: { file: 'src/NotificationSystem/Service/Topics/InvoiceCreated/ViewModel/EmailInvoiceCreatedTemplateViewModel.php' } }),
      node({ id: 'twig-template', name: 'invoice_created.html.twig', type: 'component', source: { file: 'templates/invoice_created.html.twig' } }),
    ];
    const entryPoints = [{
      id: 'webhook',
      type: 'http',
      name: 'GET /webhook',
      source_node: 'webhook-controller',
      handler: { node_id: 'webhook-controller', file: 'src/Controller/WebhookController.php' },
      trigger: { method: 'GET', path: '/webhook' },
    }];
    const contributions = [
      { analyzer_type: 'framework', analyzer_name: 'Symfony Analyzer', nodes_created: 50, confidence: 1 },
    ];

    const summary = orch.buildArchitectureSummary(nodes, entryPoints as any, [], contributions);

    expect(summary.system_type).toBe('Backend service');
    expect(summary.system_type).not.toBe('Desktop application');
  });

  it('identifies infrastructure and desktop product shapes before falling back to CLI entry points', async () => {
    const infrastructureSummary = orch.buildArchitectureSummary([
      node({ id: 'tf-main', name: 'main.tf', type: 'infrastructure_file', source: { file: 'main.tf' } }),
      node({ id: 'tf-vpc', name: 'aws_vpc.main', type: 'infrastructure_resource', source: { file: 'main.tf' } }),
    ], [], [], [
      { analyzer_type: 'framework', analyzer_name: 'Terraform Analyzer', nodes_created: 2, confidence: 1 },
    ]);

    const desktopSummary = orch.buildArchitectureSummary([
      node({ id: 'main-window', name: 'MainWindow', type: 'class', source: { file: 'src/Presentation/MainWindow.xaml.cs' } }),
      node({ id: 'app-xaml', name: 'App', type: 'file', source: { file: 'src/Presentation/App.xaml' } }),
    ], [{
      id: 'desktop-start',
      type: 'cli',
      name: 'Program.Main',
      source_node: 'main-window',
      handler: { node_id: 'main-window', file: 'src/Presentation/MainWindow.xaml.cs' },
    }], [], [
      { analyzer_type: 'framework', analyzer_name: 'WPF Analyzer', nodes_created: 8, confidence: 1 },
    ]);

    expect(infrastructureSummary.system_type).toBe('Cloud infrastructure');
    expect(desktopSummary.system_type).toBe('Desktop application');
  });

  it('identifies Electron desktop apps even when they embed local HTTP services', async () => {
    const summary = orch.buildArchitectureSummary([
      node({ id: 'electron-config', name: 'electron.vite.config.ts', type: 'file', source: { file: 'electron.vite.config.ts' } }),
      node({ id: 'main', name: 'ElectronMain', type: 'class', source: { file: 'src/main/index.ts' } }),
      node({ id: 'local-controller', name: 'LocalController', type: 'controller', source: { file: 'src/main/local-server.ts' } }),
    ], [{
      id: 'health',
      type: 'http',
      name: 'GET /health',
      source_node: 'local-controller',
      handler: { node_id: 'local-controller', file: 'src/main/local-server.ts' },
    }], [], [
      { analyzer_type: 'framework', analyzer_name: 'Express.js Analyzer', nodes_created: 2, confidence: 1 },
    ]);

    expect(summary.system_type).toBe('Desktop application');
  });

  it('classifies a Go net/http server with an incidental "views/" template dir as a server, not desktop (real miniflux gap)', async () => {
    // REGRESSION (real miniflux CAS): 60+ HTTP routes, Caddy/Traefik reverse-proxy
    // configs, Dockerfiles, and systemd/.deb/.rpm packaging in-tree still resolved
    // to 'Desktop application'. Root cause: hasDesktopSurface's file heuristic
    // `/(^|\/)(views|windows|viewmodels)\//` matched miniflux's plain HTML template
    // folder `internal/template/templates/views/*.html` — a generic web-template
    // convention, not desktop-specific — and installer/systemd packaging was read
    // as desktop evidence. A server that SHIPS installers is still a server: a
    // real HTTP entry surface (>= a handful of routes) plus backend/controller
    // evidence must outrank that.
    const controllerNodes: CASNode[] = Array.from({ length: 6 }, (_, i) => node({
      id: `handler-${i}`, name: `ShowFeed${i}Handler`, type: 'controller',
      source: { file: `internal/ui/handler.go` },
    }));
    const modelNode = node({
      id: 'model-feed', name: 'Feed', type: 'entity',
      source: { file: 'internal/model/feed.go' },
    });
    const viewNode = node({
      id: 'view-feeds', name: 'feeds.html', type: 'component',
      source: { file: 'internal/template/templates/views/feeds.html' },
    });
    const httpEntryPoints = Array.from({ length: 10 }, (_, i) => ({
      id: `entry-http-${i}`,
      type: 'http',
      name: `GET /feed/${i}`,
      source_node: `handler-${i % 6}`,
      handler: { node_id: `handler-${i % 6}`, file: 'internal/ui/handler.go' },
      trigger: { method: 'GET', path: `/feed/${i}` },
    }));

    const summary = orch.buildArchitectureSummary(
      [...controllerNodes, modelNode, viewNode],
      httpEntryPoints as any,
      [],
      [],
    );

    expect(summary.system_type).not.toBe('Desktop application');
  });

  it('identifies Flutter mobile apps before generic view folder desktop heuristics', async () => {
    const summary = orch.buildArchitectureSummary([
      node({ id: 'main-dart', name: 'main.dart', type: 'file', source: { file: 'lib/main.dart' }, metadata: { language: 'dart' } }),
      node({ id: 'settings-screen', name: 'SettingsScreen', type: 'mobile_screen', source: { file: 'lib/views/settings_screen.dart' }, metadata: { language: 'dart' } }),
      node({ id: 'macos-window', name: 'MainFlutterWindow', type: 'class', source: { file: 'macos/Runner/MainFlutterWindow.swift' } }),
    ], [{
      id: 'app-start',
      type: 'lifecycle',
      name: 'Flutter app start',
      source_node: 'main-dart',
      handler: { node_id: 'main-dart', file: 'lib/main.dart' },
    }], [], [
      { analyzer_type: 'framework', analyzer_name: 'Flutter Analyzer', nodes_created: 8, confidence: 1 },
    ]);

    expect(summary.system_type).toBe('Mobile application');
  });

  it('identifies mobile plus API repos without falling through to desktop platform runners', async () => {
    const summary = orch.buildArchitectureSummary([
      node({ id: 'main-dart', name: 'main.dart', type: 'file', source: { file: 'app/lib/main.dart' }, metadata: { language: 'dart' } }),
      node({ id: 'home-screen', name: 'HomeScreen', type: 'mobile_screen', source: { file: 'app/lib/views/home_screen.dart' }, metadata: { language: 'dart' } }),
      node({ id: 'macos-window', name: 'MainFlutterWindow', type: 'class', source: { file: 'app/macos/Runner/MainFlutterWindow.swift' } }),
      node({ id: 'api-controller', name: 'JobsController', type: 'controller', source: { file: 'backend/app/main.py' } }),
    ], [{
      id: 'api-health',
      type: 'http',
      name: 'GET /health',
      source_node: 'api-controller',
      handler: { node_id: 'api-controller', file: 'backend/app/main.py' },
    }], [], [
      { analyzer_type: 'framework', analyzer_name: 'Flutter Analyzer', nodes_created: 8, confidence: 1 },
      { analyzer_type: 'framework', analyzer_name: 'FastAPI Analyzer', nodes_created: 4, confidence: 1 },
    ]);

    expect(summary.system_type).toBe('Mobile + API application');
  });

  it('classifies a SwiftPM macOS/AppKit menu-bar app as Desktop application, with SwiftUI/AppKit in frameworks', async () => {
    const nodes: CASNode[] = [
      node({ id: 'app-entry', name: 'MenuBarApp', type: 'class', source: { file: 'Sources/App/MenuBarApp.swift' } }),
      node({ id: 'status-item', name: 'StatusItemController', type: 'class', source: { file: 'Sources/App/StatusItemController.swift' } }),
    ];
    const contributions = [
      {
        analyzer_type: 'framework',
        analyzer_name: 'Swift Platform Analyzer',
        nodes_created: 0,
        confidence: 1,
        framework_specific: {
          swiftui: true,
          appkit: true,
          'apple-platform-macos': true,
        },
      },
    ];

    const summary = orch.buildArchitectureSummary(nodes, [], [], contributions);

    expect(summary.system_type).toBe('Desktop application');
    expect(summary.system_type).not.toBe('Mobile application');
    expect(summary.system_type).not.toBe('Mobile + API application');

    // system.frameworks: a framework-type contribution's boolean
    // framework_specific facts (swiftui/appkit) must surface as their own
    // technology-inventory entries, not be folded into one generic
    // "Swift Platform Analyzer" bucket.
    const technologies = orch.extractTechnologies(contributions, []);
    const frameworkNames = (technologies.frameworks || []).map((f: any) => f.name);
    expect(frameworkNames).toContain('swiftui');
    expect(frameworkNames).toContain('appkit');
  });

  it('classifies a SwiftPM iOS/UIKit app as Mobile application, not Desktop', async () => {
    const nodes: CASNode[] = [
      node({ id: 'app-delegate', name: 'AppDelegate', type: 'class', source: { file: 'Sources/App/AppDelegate.swift' } }),
      node({ id: 'root-screen', name: 'RootScreen', type: 'class', source: { file: 'Sources/App/RootScreen.swift' } }),
    ];
    const contributions = [
      {
        analyzer_type: 'framework',
        analyzer_name: 'Swift Platform Analyzer',
        nodes_created: 0,
        confidence: 1,
        framework_specific: {
          uikit: true,
          'apple-platform-ios': true,
        },
      },
    ];

    const summary = orch.buildArchitectureSummary(nodes, [], [], contributions);

    expect(summary.system_type).toBe('Mobile application');
    expect(summary.system_type).not.toBe('Desktop application');
  });

  it('does not classify multi-app API monorepos as MCP servers just because one app is mcp-api', async () => {
    const summary = orch.buildArchitectureSummary([
      node({ id: 'admin-controller', name: 'AdminController', type: 'controller', source: { file: 'apps/admin-api/src/app/admin.controller.ts' } }),
      node({ id: 'user-controller', name: 'UserController', type: 'controller', source: { file: 'apps/user-api/src/app/user.controller.ts' } }),
      node({ id: 'mcp-controller', name: 'McpController', type: 'controller', source: { file: 'apps/mcp-api/src/app/app.controller.ts' } }),
      node({ id: 'auth-lib', name: 'AuthModule', type: 'module', source: { file: 'libs/auth/src/auth.module.ts' } }),
    ], [{
      id: 'admin-health',
      type: 'http',
      name: 'GET /health',
      source_node: 'admin-controller',
      handler: { node_id: 'admin-controller', file: 'apps/admin-api/src/app/admin.controller.ts' },
    }], [], [
      { analyzer_type: 'framework', analyzer_name: 'NestJS Analyzer', nodes_created: 4, confidence: 1 },
    ]);

    expect(summary.system_type).toBe('API monorepo');
  });

  it('does not classify ordinary src/infrastructure folders as cloud infrastructure', async () => {
    const summary = orch.buildArchitectureSummary([
      node({ id: 'main', name: 'main.rs', type: 'file', source: { file: 'src/main.rs' } }),
      node({ id: 'client', name: 'ZeroSlotClient', type: 'service', source: { file: 'src/infrastructure/services/zeroslot.rs' } }),
      node({ id: 'registry', name: 'DexRegistry', type: 'struct', source: { file: 'src/infrastructure/dex/dex_registry.rs' } }),
      node({ id: 'token', name: 'TokenModel', type: 'model', source: { file: 'src/domain/token.rs' } }),
    ], [{
      id: 'cli',
      type: 'cli',
      name: 'main',
      source_node: 'main',
      handler: { node_id: 'main', file: 'src/main.rs' },
    }], [], []);

    expect(summary.system_type).toBe('CLI application');
  });

  it('identifies tiny script-entry repos as CLI applications even without explicit entry point extraction', async () => {
    const summary = orch.buildArchitectureSummary([
      node({ id: 'main', name: 'main.js', type: 'file', source: { file: 'main.js' } }),
      node({ id: 'strategy', name: 'TradeStrategy', type: 'class', source: { file: 'strategy.js' } }),
    ], [], [], []);

    expect(summary.system_type).toBe('CLI application');
  });

  it('identifies TSX entry files as frontend surface before script-entry CLI fallback', async () => {
    const summary = orch.buildArchitectureSummary([
      node({ id: 'main', name: 'main.tsx', type: 'file', source: { file: 'src/main.tsx' } }),
      node({ id: 'wallet-page', name: 'WalletsPage', type: 'function', source: { file: 'src/pages/WalletsPage.tsx' } }),
    ], [], [], []);

    expect(summary.system_type).toBe('Frontend application');
  });

  it('infers CLI command contracts as behavior-level invariants', async () => {
    const invariants = (orch as any).buildBehavioralInvariants([
      node({ id: 'main-command', name: 'run', type: 'command', source: { file: 'src/index.ts' } }),
    ], [], [{
      id: 'cli-run',
      type: 'cli',
      name: 'run',
      source_node: 'main-command',
      handler: { node_id: 'main-command', file: 'src/index.ts' },
      trigger: { command: 'run' },
    }], { entities: [], relationships: [] }, [], [], [], '/tmp/cli-app');

    expect(invariants.map((invariant: any) => invariant.id)).toContain('invariant_cli_entrypoint_contracts');
    expect(invariants.find((invariant: any) => invariant.id === 'invariant_cli_entrypoint_contracts')?.scope.entry_point_ids).toContain('cli-run');
  });

  it('infers script entry file contracts when a tiny repo has no explicit entry point', async () => {
    const invariants = (orch as any).buildBehavioralInvariants([
      node({ id: 'main-file', name: 'main.js', type: 'file', source: { file: 'main.js' } }),
    ], [], [], { entities: [], relationships: [] }, [], [], [], '/tmp/script-app');

    const cliInvariant = invariants.find((invariant: any) => invariant.id === 'invariant_cli_entrypoint_contracts');
    expect(cliInvariant).toBeDefined();
    expect(cliInvariant.scope.file_paths).toContain('main.js');
  });

  it('infers UI route contracts as behavior-level invariants for frontend apps', async () => {
    const invariants = (orch as any).buildBehavioralInvariants([
      node({ id: 'page-file', name: 'page.tsx', type: 'file', source: { file: 'src/app/contact/page.tsx' } }),
      node({ id: 'contact-page', name: 'ContactPage', type: 'function', source: { file: 'src/app/contact/page.tsx' } }),
    ], [], [{
      id: 'entry-contact-page',
      type: 'page',
      name: 'PAGE /contact',
      source_node: 'page-file',
      trigger: { method: 'GET', path: '/contact' },
      metadata: { pageFile: 'src/app/contact/page.tsx' },
    }], { entities: [], relationships: [] }, [], [], [], '/tmp/frontend-app');

    const uiInvariant = invariants.find((invariant: any) => invariant.id === 'invariant_ui_entrypoint_contracts');
    expect(uiInvariant).toBeDefined();
    expect(uiInvariant.scope.entry_point_ids).toContain('entry-contact-page');
    expect(uiInvariant.scope.file_paths).toContain('src/app/contact/page.tsx');
  });

  it('does not treat normal layered concept families as duplicate implementations', async () => {
    const nodes: CASNode[] = [
      node({ id: 'user-controller', name: 'UsersController', type: 'controller', source: { file: 'src/users/users.controller.ts' } }),
      node({ id: 'user-service', name: 'UsersService', type: 'service', source: { file: 'src/users/users.service.ts' } }),
      node({ id: 'user-repository', name: 'UsersRepository', type: 'repository', source: { file: 'src/users/users.repository.ts' } }),
      node({ id: 'user-entity', name: 'UserEntity', type: 'entity', source: { file: 'src/users/user.entity.ts' } }),
      node({ id: 'users-view', name: 'UsersPage', type: 'component', source: { file: 'src/users/UsersPage.tsx' } }),
    ];

    expect(orch.detectDuplicateConceptSignals(nodes)).toEqual([]);
  });

  it('flags same-role duplicate concept owners without penalizing adjacent layers', async () => {
    const nodes: CASNode[] = [
      node({ id: 'billing-service', name: 'BillingService', type: 'service', source: { file: 'src/billing/billing.service.ts' } }),
      node({ id: 'billing-manager', name: 'BillingManager', type: 'service', source: { file: 'src/payments/billing.manager.ts' } }),
      node({ id: 'billing-repository', name: 'BillingRepository', type: 'repository', source: { file: 'src/billing/billing.repository.ts' } }),
    ];

    expect(orch.detectDuplicateConceptSignals(nodes)).toEqual([{
      concept: 'billing',
      role: 'business-logic',
      count: 2,
      node_ids: ['billing-service', 'billing-manager'],
      files: ['src/billing/billing.service.ts', 'src/payments/billing.manager.ts'],
    }]);
  });

  it('infers capabilities from terminal business nodes and entities without routes', async () => {
    const nodes: CASNode[] = [
      node({ id: 'invoice-entity', name: 'Invoice', type: 'entity', source: { file: 'src/billing/invoice.entity.ts' } }),
      node({ id: 'invoice-service', name: 'InvoiceSettlementService', type: 'service', source: { file: 'src/billing/invoice-settlement.service.ts' } }),
      node({ id: 'settle', name: 'settleInvoice', type: 'method', source: { file: 'src/billing/invoice-settlement.service.ts' } }),
      node({ id: 'fixture-entry', name: 'FlutterHomePage', type: 'component', source: { file: 'packages/analyzer-core/src/__tests__/fixtures/flutter/lib/home.dart' } }),
    ];
    const edges: CASEdge[] = [
      { id: 'e1', source: 'invoice-service', target: 'settle', type: 'calls' },
      { id: 'e2', source: 'settle', target: 'invoice-entity', type: 'uses' },
    ];
    const entities: CASDataEntity[] = [{
      id: 'entity-invoice',
      name: 'Invoice',
      type: 'entity',
      fields: [],
      lifecycle: { created_by: ['settle'], read_by: ['settle'], updated_by: ['settle'], deleted_by: [] },
      relationships: [],
    } as any];

    const { capabilities } = await orch.buildSystemCapabilities([], entities, nodes, edges);

    // The deterministic structural_label carries the "<Domain> Settlement"
    // grammar; the display name is the terminal-grounded subject ("Invoice")
    // awaiting the AI naming pass (comprehension is AI-only, not a template).
    const labels = capabilities.map((capability: any) => capability.structural_label);
    expect(labels).toContain('Invoice Settlement');
    expect(capabilities.find((capability: any) => capability.structural_label === 'Invoice Settlement')?.name).toBe('Invoice');
    expect(capabilities.find((capability: any) => capability.structural_label === 'Invoice Settlement')?.name_source).toBeUndefined();
    expect(capabilities.find((capability: any) => capability.structural_label === 'Invoice Settlement')?.related_entities).toContain('entity-invoice');
    expect(capabilities.map((capability: any) => capability.related_domains).flat()).not.toContain('flutter');
  });

  it('prefers terminal business names over absolute path noise when inferring capabilities', async () => {
    const nodes: CASNode[] = [
      node({
        id: 'transaction-service',
        name: 'WsTransactionService',
        type: 'service',
        source: { file: '/Users/michaelshattuck/dev/clients/outcode/truckspy/wex-client-php/src/WsTransactionService.php' },
      }),
      node({
        id: 'transaction-method',
        name: 'createTransaction',
        type: 'method',
        source: { file: '/Users/michaelshattuck/dev/clients/outcode/truckspy/wex-client-php/src/WsTransactionService.php' },
      }),
    ];
    const edges: CASEdge[] = [
      { id: 'e1', source: 'transaction-service', target: 'transaction-method', type: 'calls' },
    ];

    const { capabilities } = await orch.buildSystemCapabilities([], [], nodes, edges);
    const labels = capabilities.map((capability: any) => capability.structural_label);
    const names = capabilities.map((capability: any) => capability.name);
    const relatedDomains = capabilities.map((capability: any) => capability.related_domains).flat();

    // Structural label keeps the "<Domain> Management" grammar; display name is
    // the terminal-grounded subject.
    expect(labels).toContain('Transaction Management');
    expect(names).toContain('Transaction');
    expect(relatedDomains).toContain('transaction');
    expect(relatedDomains).not.toContain('users');
    expect(relatedDomains).not.toContain('dev');
    expect(relatedDomains).not.toContain('clients');
  });

  it('anchors terminal capabilities on business objects instead of action verbs', async () => {
    const nodes: CASNode[] = [
      node({ id: 'report-handler', name: 'GenerateReportHandler', type: 'handler', source: { file: 'src/reports/generate-report.handler.ts' } }),
      node({ id: 'portfolio-use-case', name: 'RebalancePortfolioUseCase', type: 'usecase', source: { file: 'src/portfolio/rebalance-portfolio.use-case.ts' } }),
      node({ id: 'invoice-service', name: 'InvoiceSettlementService', type: 'service', source: { file: 'src/billing/invoice-settlement.service.ts' } }),
      node({ id: 'invoice-method', name: 'settleInvoice', type: 'method', source: { file: 'src/billing/invoice-settlement.service.ts' } }),
    ];
    const edges: CASEdge[] = [
      { id: 'e1', source: 'invoice-service', target: 'invoice-method', type: 'calls' },
    ];

    const { capabilities } = await orch.buildSystemCapabilities([], [], nodes, edges);
    const domains = capabilities.map((capability: any) => capability.related_domains).flat();
    const labels = capabilities.map((capability: any) => capability.structural_label);
    const names = capabilities.map((capability: any) => capability.name);

    expect(domains).toEqual(expect.arrayContaining(['report', 'portfolio', 'invoice']));
    expect(domains).not.toEqual(expect.arrayContaining(['generate', 'rebalance', 'settle']));
    // Capabilities are anchored on the business object (structural label), and
    // the display name is that object, not the verb — no "Generate"/"Rebalance"
    // action-verb subject leaks in either.
    expect(labels).toEqual(expect.arrayContaining(['Report Generation', 'Portfolio Rebalancing', 'Invoice Settlement']));
    expect(names).toEqual(expect.arrayContaining(['Report', 'Portfolio', 'Invoice']));
    expect(names.some((name: string) => /^(Generate|Rebalance|Settle)\b/.test(name))).toBe(false);
  });

  it('does not treat blockchain token domains as identity authentication', async () => {
    const nodes: CASNode[] = [
      node({ id: 'balance', name: 'getAssociatedTokenAddress', type: 'function', source: { file: 'src/solana/token-accounts.ts' } }),
      node({ id: 'wallet', name: 'readTokenBalance', type: 'function', source: { file: 'src/solana/token-accounts.ts' } }),
    ];
    const edges: CASEdge[] = [
      { id: 'e1', source: 'wallet', target: 'balance', type: 'calls' },
    ];

    const { capabilities } = await orch.buildSystemCapabilities([], [], nodes, edges);
    const names = capabilities.map((capability: any) => capability.name);

    expect(names).toContain('Token Balance Discovery');
    expect(names.some((name: string) => /Authentication/.test(name))).toBe(false);
  });

  it('filters DTO and source-support terminal buckets out of primary capabilities', async () => {
    const nodes: CASNode[] = [
      node({ id: 'dto', name: 'CreateVehicleDto', type: 'class', source: { file: 'src/vehicles/dto/create-vehicle.dto.ts' } }),
      node({ id: 'constants', name: 'Constants', type: 'object', source: { file: 'src/config/constants.ts' } }),
      node({ id: 'handling', name: 'ErrorHandling', type: 'function', source: { file: 'src/support/error-handling.ts' } }),
      node({ id: 'connection', name: 'Connection', type: 'class', source: { file: 'src/support/connection.ts' } }),
      node({ id: 'support', name: 'Support', type: 'class', source: { file: 'src/support/index.ts' } }),
      node({ id: 'vehicle', name: 'Vehicle', type: 'entity', source: { file: 'src/vehicles/vehicle.entity.ts' } }),
      node({ id: 'vehicle-service', name: 'VehicleMaintenanceService', type: 'service', source: { file: 'src/vehicles/vehicle-maintenance.service.ts' } }),
      node({ id: 'schedule', name: 'scheduleVehicleMaintenance', type: 'method', source: { file: 'src/vehicles/vehicle-maintenance.service.ts' } }),
    ];
    const edges: CASEdge[] = [
      { id: 'e1', source: 'vehicle-service', target: 'schedule', type: 'calls' },
      { id: 'e2', source: 'schedule', target: 'vehicle', type: 'uses' },
    ];
    const entities: CASDataEntity[] = [{
      id: 'entity-vehicle',
      name: 'Vehicle',
      type: 'entity',
      fields: [],
      lifecycle: { created_by: [], read_by: ['schedule'], updated_by: ['schedule'], deleted_by: [] },
      relationships: [],
    } as any];

    const { capabilities } = await orch.buildSystemCapabilities([], entities, nodes, edges);
    const labels = capabilities.map((capability: any) => capability.structural_label);
    const names = capabilities.map((capability: any) => capability.name);

    // The Vehicle capability survives (structural label "Vehicle Management",
    // display name "Vehicle"); DTO/support helper buckets are filtered out.
    expect(labels).toContain('Vehicle Management');
    expect(names).toContain('Vehicle');
    expect(labels).not.toContain('Dto Management');
    expect(labels).not.toContain('Constants Capability');
    expect(labels).not.toContain('Handling Capability');
    expect(labels).not.toContain('Connection Capability');
    expect(labels).not.toContain('Support Capability');
  });

  it('expands common source abbreviations before naming capabilities', async () => {
    const nodes: CASNode[] = [
      node({ id: 'loc-service', name: 'LocService', type: 'service', source: { file: 'src/locations/loc.service.php' } }),
      node({ id: 'loc-method', name: 'syncLoc', type: 'method', source: { file: 'src/locations/loc.service.php' } }),
    ];
    const edges: CASEdge[] = [
      { id: 'e1', source: 'loc-service', target: 'loc-method', type: 'calls' },
    ];

    const { capabilities } = await orch.buildSystemCapabilities([], [], nodes, edges);
    const labels = capabilities.map((capability: any) => capability.structural_label);
    const names = capabilities.map((capability: any) => capability.name);
    const domains = capabilities.flatMap((capability: any) => capability.related_domains);

    // "loc" is expanded to "location" before labeling; structural label carries
    // the "Synchronization" grammar, display name is the expanded subject.
    expect(labels).toContain('Location Synchronization');
    expect(names).toContain('Location');
    expect(domains).toContain('location');
    expect(labels).not.toContain('Loc Workflow');
    expect(labels).not.toContain('Loc Capability');
  });

  it('uses product-surface capability names and filters helper buckets when analyzing Klauro itself', async () => {
    const klauroRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-self-naming-'));
    fs.writeFileSync(
      path.join(klauroRoot, 'package.json'),
      JSON.stringify({ name: '@klauro/monorepo', version: '1.0.0' }),
    );
    const nodes: CASNode[] = [
      node({ id: 'agent', name: 'AgentWorkflowService', type: 'service', source: { file: 'src/agent-workflow.ts' } }),
      node({ id: 'runtime', name: 'RuntimeTelemetryService', type: 'service', source: { file: 'src/runtime-simulation.ts' } }),
      node({ id: 'proposal', name: 'ProposalPreviewService', type: 'service', source: { file: 'src/proposal-preview-html.ts' } }),
      node({ id: 'compatible', name: 'PathsCompatibleService', type: 'service', source: { file: 'src/query.ts' } }),
    ];

    try {
      const { capabilities } = await orch.buildSystemCapabilities([], [], nodes, [], klauroRoot);
      const names = capabilities.map((capability: any) => capability.name);

      expect(names).toEqual(expect.arrayContaining(['Agent Context', 'Runtime Telemetry', 'Proposal Preview']));
      expect(names).not.toContain('Agent Management');
      expect(names).not.toContain('Runtime Management');
      expect(names).not.toContain('Proposal Management');
      expect(names).not.toContain('Compatible Management');
    } finally {
      fs.rmSync(klauroRoot, { recursive: true, force: true });
    }
  });

  it('never applies Klauro product capability names to a foreign repository', async () => {
    const foreignRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-foreign-naming-'));
    fs.writeFileSync(
      path.join(foreignRoot, 'package.json'),
      JSON.stringify({ name: 'wagtail-admin', version: '1.0.0' }),
    );
    const nodes: CASNode[] = [
      node({ id: 'task-model', name: 'Task', type: 'entity', source: { file: 'wagtail/models/tasks.py' } }),
      node({ id: 'task-state-model', name: 'TaskState', type: 'entity', source: { file: 'wagtail/models/tasks.py' } }),
      node({ id: 'workflow-task-model', name: 'WorkflowTask', type: 'entity', source: { file: 'wagtail/models/tasks.py' } }),
      node({ id: 'task-view', name: 'TaskChooserView', type: 'service', source: { file: 'wagtail/admin/views/workflows.py' } }),
      node({ id: 'task-method', name: 'createTask', type: 'method', source: { file: 'wagtail/admin/views/workflows.py' } }),
    ];
    const edges: CASEdge[] = [
      { id: 'e1', source: 'task-view', target: 'task-method', type: 'calls' },
      { id: 'e2', source: 'task-method', target: 'task-model', type: 'uses' },
    ];
    const entities: CASDataEntity[] = [
      {
        id: 'entity-task',
        name: 'Task',
        type: 'entity',
        fields: [],
        lifecycle: { created_by: ['task-method'], read_by: ['task-view'], updated_by: [], deleted_by: [] },
        relationships: [],
      } as any,
    ];

    try {
      const { capabilities } = await orch.buildSystemCapabilities([], entities, nodes, edges, foreignRoot);
      const names = capabilities.map((capability: any) => capability.name);

      expect(names.length).toBeGreaterThan(0);
      const klauroVocabulary = [
        'Agent Task Proof',
        'Agent Context',
        'Agent Continuation',
        'Codebase Analysis',
        'Codebase Idiom Guidance',
        'CAS Contract Validation',
        'Answer Packs',
        'Machine Repo Gauntlet',
        'Greenfield Planning',
        'Proposal Preview',
        'Klauro Runtime SDK',
        'Analysis Storage',
      ];
      for (const name of klauroVocabulary) {
        expect(names).not.toContain(name);
      }
      // Foreign repo: real domain capability derived structurally ("Task
      // Management" label), display name is the terminal-grounded subject.
      const labels = capabilities.map((capability: any) => capability.structural_label);
      expect(labels).toContain('Task Management');
      expect(names).toContain('Task');
    } finally {
      fs.rmSync(foreignRoot, { recursive: true, force: true });
    }
  });

  it('derives route-backed rails capabilities when projectPath scopes the product checks', async () => {
    const projectRoot = '/repo/apps/mcp-server/fixtures/analysis-truth/rails-work-orders';
    const routesFile = `${projectRoot}/config/routes.rb`;
    const controllerFile = 'app/controllers/work_orders_controller.rb';
    const routeSpecs = [
      { id: 'route-index', method: 'GET', path: '/work_orders' },
      { id: 'route-create', method: 'POST', path: '/work_orders' },
      { id: 'route-update', method: 'PATCH', path: '/work_orders/:id' },
      { id: 'route-destroy', method: 'DELETE', path: '/work_orders/:id' },
    ];
    const nodes: CASNode[] = [
      ...routeSpecs.map(spec => node({
        id: spec.id,
        name: `${spec.method} ${spec.path}`,
        type: 'rails_route',
        source: { file: routesFile, line: 1 },
      })),
      node({
        id: 'work-order-model',
        name: 'WorkOrder',
        type: 'rails_model',
        subcategories: ['rails', 'activerecord', 'database', 'entity'],
        source: { file: `${projectRoot}/app/models/work_order.rb`, line: 1 },
      }),
      node({
        id: 'work-orders-create-action',
        name: 'create',
        type: 'controller_method',
        source: { file: `${projectRoot}/${controllerFile}`, line: 10 },
      }),
    ];
    const entryPoints: any[] = routeSpecs.map(spec => ({
      id: `entry_${spec.id}`,
      type: 'http',
      name: `${spec.method} ${spec.path}`,
      source_node: spec.id,
      trigger: { method: spec.method, path: spec.path },
      handler: { file: controllerFile },
    }));
    const entities: CASDataEntity[] = [{
      id: 'entity_workorder',
      name: 'WorkOrder',
      schema_source: `${projectRoot}/app/models/work_order.rb`,
      lifecycle: { created_by: ['work-orders-create-action'], read_by: [], updated_by: [], deleted_by: [] },
    } as any];

    const { capabilities: withoutProject } = await orch.buildSystemCapabilities(entryPoints, entities, nodes, []);
    expect(withoutProject.flatMap((capability: any) => capability.operations.map((op: any) => op.entry_point_type))).not.toContain('http');

    const { capabilities } = await orch.buildSystemCapabilities(entryPoints, entities, nodes, [], projectRoot);
    const routeCapability = capabilities.find((capability: any) =>
      capability.operations.some((op: any) => op.entry_point_type === 'http')
    );
    expect(routeCapability).toBeDefined();
    const actions = routeCapability!.operations.map((op: any) => op.action);
    expect(actions).toEqual(expect.arrayContaining(['List', 'Create', 'Update', 'Delete']));
  });

  it('filters parser and framework utility labels out of key capability summaries', async () => {
    expect(orch.isGenericCapabilityDisplayName('Has Management')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('Serializers Management')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('Manage Capability')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('Queryset Management')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('Ld Management')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('For Management')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('Allow Management')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('Services Management')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('Generated Management')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('Generator Management')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('Select Project Management')).toBe(false);
    expect(orch.isGenericCapabilityDisplayName('Graphql Management')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('Authenticated Capability')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('Method Management')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('Authenticate Capability')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('Put Management')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('Checkconnectivity Management')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('Verify Management')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('External Management')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('Accounts Management')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('Autenticacion Management')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('Links Management')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('Flutter Management')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('Lifecycle Management')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('Setup Management')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('New Management')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('Foreach Management')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('All Management')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('Response Management')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('Configure Management')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('Script Capability')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('Bin/console Commands')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('Events Handlers')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('Message Handlers')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('Should Management')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('Help Management')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('Report Reporting')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('From Management')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('Count Management')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('Slugify Management')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('With Management')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('Matches Management')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('<int:pk> Management')).toBe(true);
    expect(orch.isGenericCapabilityDisplayName("swagger', schema view.with ui('swagger Management")).toBe(true);
    expect(orch.isGenericCapabilityDisplayName('Product Management')).toBe(false);
  });

  it('infers CLI and message capability domains from command names instead of transport labels', async () => {
    const cliKey = orch.inferResourceKey({
      id: 'entry-cli',
      type: 'cli',
      name: 'bin/console app:invoice:settle',
      source_node: 'node-command',
      handler: { node_id: 'node-command', method_name: 'settleInvoice' },
    });
    const messageKey = orch.inferResourceKey({
      id: 'entry-message',
      type: 'message',
      name: 'InvoiceSettlementRequestedHandler',
      source_node: 'node-handler',
      trigger: { event: 'invoice.settlement.requested' },
      handler: { node_id: 'node-handler', method_name: 'handleInvoiceSettlement' },
    });

    // Resource keys preserve the FULL meaningful phrase rather than
    // truncating to a single leading word: dropping "settlement"/"requested"
    // would collapse multi-word subjects like "Monte Carlo" or "Profit And
    // Loss" into a single mid-word token and produce malformed downstream
    // capability names (e.g. "Monte Management" instead of "Monte Carlo
    // Analysis"). "invoice" alone would also be a lossier, less specific key.
    // "settlement" is filtered as a generic capability/action token, so the
    // preserved phrase is "invoice-requested" (not "invoice-settlement-requested").
    expect(cliKey).toBe('invoice');
    expect(messageKey).toBe('invoice-requested');
    expect(orch.inferResourceName({ type: 'cli' } as any, cliKey)).toBe('Invoice Commands');
    expect(orch.inferResourceName({ type: 'message' } as any, messageKey)).toBe('Invoice Requested Handlers');
  });

  it('does not auto-generate entity descriptions during the default analysis pass', async () => {
    const nodes: CASNode[] = [
      node({ id: 'driver-entity', name: 'Driver', type: 'entity', source: { file: 'src/fleet/driver.entity.ts' } }),
      node({ id: 'driver-name', name: 'licenseNumber', type: 'property', parent: 'driver-entity', signature: { return_type: 'string' } as any }),
      node({ id: 'driver-service', name: 'createDriver', type: 'method', source: { file: 'src/fleet/driver.service.ts' } }),
    ];
    const edges: CASEdge[] = [
      { id: 'e1', source: 'driver-service', target: 'driver-entity', type: 'uses' },
    ];

    const entities = orch.buildDataEntities(nodes, edges);
    expect(entities[0]).toEqual(expect.objectContaining({
      name: 'Driver',
    }));
    expect(entities[0].description).toBeUndefined();
    expect(entities[0].description_source).toBeUndefined();
    expect(entities[0].description_generation).toBeUndefined();
  });

  it('excludes nested fixture entities from product data entities while preserving fixture-root analysis', async () => {
    const projectRoot = '/repo/apps/mcp-server';
    const nodes: CASNode[] = [
      node({
        id: 'product-analysis',
        name: 'AnalysisRecord',
        type: 'entity',
        source: { file: '/repo/apps/mcp-server/src/analysis/analysis-record.entity.ts' },
      }),
      node({
        id: 'fixture-user',
        name: 'User',
        type: 'entity',
        source: { file: '/repo/apps/mcp-server/fixtures/analysis-truth/prisma-schema-heavy/prisma/schema.prisma' },
      }),
    ];

    const appEntities = orch.buildDataEntities(nodes, [], projectRoot);
    expect(appEntities.map((entity: any) => entity.name)).toEqual(['AnalysisRecord']);

    const fixtureEntities = orch.buildDataEntities(nodes, [], '/repo/apps/mcp-server/fixtures/analysis-truth/prisma-schema-heavy');
    expect(fixtureEntities.map((entity: any) => entity.name)).toEqual(['User']);
  });

  it('scopes high-level purpose facts to product entry points and frameworks', async () => {
    const projectRoot = '/repo/apps/mcp-server';
    const nodes: CASNode[] = [
      node({
        id: 'cli',
        name: 'cli.ts',
        type: 'file',
        source: { file: '/repo/apps/mcp-server/src/cli.ts' },
      }),
      node({
        id: 'fixture-api',
        name: 'FastApiFixture',
        type: 'controller',
        source: { file: '/repo/apps/mcp-server/fixtures/analysis-truth/fastapi-sqlalchemy/app/main.py' },
        metadata: { framework: 'FastAPI' },
      }),
    ];
    const entryPoints: any[] = [
      { id: 'cli-entry', type: 'cli', name: 'klauro', source_node: 'cli', handler: { file: '/repo/apps/mcp-server/src/cli.ts' } },
      { id: 'fixture-http', type: 'http', name: 'GET /users', source_node: 'fixture-api', handler: { file: '/repo/apps/mcp-server/fixtures/analysis-truth/fastapi-sqlalchemy/app/main.py' } },
    ];
    const contributions = [
      { analyzer_type: 'framework', analyzer_name: 'FastAPI Analyzer', nodes_created: 19 },
      { analyzer_type: 'framework', analyzer_name: 'React Analyzer', nodes_created: 1 },
    ];

    expect(orch.filterPrimaryProductEntryPoints(entryPoints, nodes, projectRoot).map((entry: any) => entry.id)).toEqual(['cli-entry']);
    expect(orch.frameworkNamesForPurpose(contributions, nodes, projectRoot)).toEqual([]);
  });

  it('strips analyzer display-name artifacts and admits only framework-analyzer application surfaces', async () => {
    const projectRoot = '/repo/arb_engine';
    const contributions = [
      { analyzer_id: 'rust', analyzer_type: 'language', analyzer_name: 'Rust Analyzer' },
      { analyzer_id: 'react', analyzer_type: 'framework', analyzer_name: 'React Analyzer' },
    ];
    const nodes: CASNode[] = [
      // Language-analyzer tag on a rust module — a LANGUAGE, not a framework the
      // system is "built with"; excluded from the comprehension framework list.
      {
        id: 'engine', name: 'engine', type: 'module',
        source: { file: '/repo/arb_engine/src/engine.rs' },
        metadata: { framework: 'enhanced rust' }, analyzers: ['rust'],
      } as CASNode,
      // Framework-analyzer node with a real application surface (component) → kept,
      // with the "enhanced" analyzer-display artifact stripped.
      {
        id: 'router', name: 'AppRouter', type: 'component',
        source: { file: '/repo/arb_engine/ui/src/AppRouter.tsx' },
        metadata: { framework: 'enhanced React Router' }, analyzers: ['react'],
      } as CASNode,
    ];

    const names = orch.frameworkNamesForPurpose(contributions, nodes, projectRoot);
    expect(names).toContain('React Router');
    expect(names).not.toContain('rust');
    expect(names.join(' ')).not.toMatch(/enhanced/i);
  });

  it('uses AI to replace capability descriptions when configured without auto-enriching every entity', async () => {
    const previousOpenAI = process.env.OPENAI_API_KEY;
    const previousElementDescriptions = process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS;
    process.env.OPENAI_API_KEY = 'test-openai-key';
    delete process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS;

    const spy = jest.spyOn(aiService, 'generateComponentDescription').mockResolvedValue(JSON.stringify({
      descriptions: [
        { id: 'cap_0', description: 'Driver management maintains driver records and links them to fleet workflows used by the operations team.' },
        { id: 'entity_driver', description: 'Driver stores the fleet operator identity and license attributes used by dispatch workflows.' },
      ],
    }));

    const capabilities: any[] = [{
      id: 'cap_0',
      name: 'Driver Management',
      description: 'read operations for driver management',
      description_source: 'deterministic',
      description_generation: { status: 'deterministic_initial', attempted: false },
      category: 'core',
      operations: [{ entry_point_id: 'ep_1', entry_point_type: 'http', action: 'Read', path_or_command: '/drivers' }],
      related_entities: ['entity_driver'],
      related_domains: ['driver'],
      criticality: 'medium',
      criticality_factors: [],
    }];
    const entities: CASDataEntity[] = [{
      id: 'entity_driver',
      name: 'Driver',
      fields: [{ name: 'licenseNumber', type: 'string', is_sensitive: false }],
      lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] },
    }];

    try {
      await orch.applyAIElementDescriptions(capabilities, entities, {
        systemName: 'fleet-api',
        enhancedSystemPurpose: {
          primary_type: 'backend-service',
          confidence: 0.9,
          evidence: [],
          primary_domain: 'fleet-management',
          core_concepts: ['driver', 'fleet'],
          inferred_description: 'A fleet management backend for driver workflows.',
          supporting_workflow_ids: [],
        },
        frameworks: ['NestJS'],
      });
    } finally {
      spy.mockRestore();
      if (previousOpenAI === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAI;
      }
      if (previousElementDescriptions === undefined) {
        delete process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS;
      } else {
        process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS = previousElementDescriptions;
      }
    }

    expect(capabilities[0].description).toBe('Driver management maintains driver records and links them to fleet workflows used by the operations team.');
    expect(capabilities[0].description_source).toBe('ai');
    expect(capabilities[0].description_generation).toEqual(expect.objectContaining({ status: 'ai_applied', attempted: true }));
    expect(entities[0].description).toBeUndefined();
    expect(entities[0].description_source).toBeUndefined();
  });

  it('repairs rejected AI capability descriptions once before falling back', async () => {
    const previousOpenAI = process.env.OPENAI_API_KEY;
    const previousElementDescriptions = process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS;
    process.env.OPENAI_API_KEY = 'test-openai-key';
    delete process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS;
    const spy = jest.spyOn(aiService, 'generateComponentDescription')
      .mockResolvedValueOnce(JSON.stringify({
        descriptions: [
          { id: 'cap_0', description: 'This robust capability manages various driver functionality for efficient fleet operations.' },
        ],
      }))
      .mockResolvedValueOnce(JSON.stringify({
        descriptions: [
          { id: 'cap_0', description: 'Driver management maintains driver records and vehicle assignments in the fleet backend.' },
        ],
      }));

    const capabilities: any[] = [{
      id: 'cap_0',
      name: 'Driver Management',
      description: 'read operations for driver management',
      description_source: 'deterministic',
      description_generation: { status: 'deterministic_initial', attempted: false },
      category: 'core',
      operations: [{ entry_point_id: 'ep_1', entry_point_type: 'http', action: 'Read', path_or_command: '/drivers' }],
      related_entities: ['entity_driver'],
      related_domains: ['driver', 'fleet'],
      criticality: 'medium',
      criticality_factors: [],
    }];

    let callsBeforeRestore = 0;
    try {
      await orch.applyAIElementDescriptions(capabilities, [], {
        systemName: 'fleet-api',
        enhancedSystemPurpose: {
          primary_type: 'backend-service',
          confidence: 0.9,
          evidence: [],
          primary_domain: 'fleet-management',
          core_concepts: ['driver', 'fleet'],
          inferred_description: 'A fleet management backend for driver workflows.',
          supporting_workflow_ids: [],
        },
        frameworks: ['NestJS'],
      });
      callsBeforeRestore = spy.mock.calls.length;
    } finally {
      spy.mockRestore();
      if (previousOpenAI === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAI;
      }
      if (previousElementDescriptions === undefined) {
        delete process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS;
      } else {
        process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS = previousElementDescriptions;
      }
    }

    expect(callsBeforeRestore).toBe(2);
    expect(capabilities[0].description).toBe('Driver management maintains driver records and vehicle assignments in the fleet backend.');
    expect(capabilities[0].description_source).toBe('ai');
    expect(capabilities[0].description_generation).toEqual(expect.objectContaining({
      status: 'ai_applied',
      attempted: true,
    }));
  });

  it('entity description pass batches evidence-richest entities FIRST (priority ordering), not catalog order', async () => {
    const previousOpenAI = process.env.OPENAI_API_KEY;
    const previousElementDescriptions = process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS;
    const previousBatchSize = process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BATCH_SIZE;
    process.env.OPENAI_API_KEY = 'test-openai-key';
    delete process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS;
    process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BATCH_SIZE = '4';

    // aiService.generateComponentDescription returns a JSON string the
    // orchestrator parses — match the real contract.
    const spy = jest.spyOn(aiService, 'generateComponentDescription').mockImplementation(async (args: any) => JSON.stringify({
      descriptions: args.additionalContext.items.map((item: any) => ({
        id: item.id,
        description: `${item.name} tracks fleet identity records referenced across dispatch, billing, and safety workflows.`,
      })),
    }));

    // Catalog order deliberately puts the LEAST-connected entities first and
    // the most domain-central one (DriveAlert-equivalent: capability member +
    // journey participant + ORM-related + lineage-heavy) last, mirroring the
    // real truckspyapp bug (AdminFunction got described, domain-central
    // DriveAlert did not, because the pass walked catalog order).
    const entities: CASDataEntity[] = [
      { id: 'entity_admin', name: 'AdminFunction', lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } },
      { id: 'entity_lookup_a', name: 'LookupA', lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } },
      { id: 'entity_lookup_b', name: 'LookupB', lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } },
      { id: 'entity_lookup_c', name: 'LookupC', lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } },
      {
        id: 'entity_alert',
        name: 'DriveAlert',
        lifecycle: { created_by: ['svc_a', 'svc_b'], read_by: ['svc_c'], updated_by: ['svc_a'], deleted_by: [] },
      },
    ];
    const nodes: any[] = [
      { id: 'entity_doctrine_drivealert', name: 'DriveAlert', type: 'entity', level: 3 },
      { id: 'entity_doctrine_driver', name: 'Driver', type: 'entity', level: 3 },
    ];
    const edges: any[] = [{
      id: 'rel_1', source: 'entity_doctrine_drivealert', target: 'entity_doctrine_driver',
      type: 'references', metadata: { attributes: { relationType: 'ManyToOne', field: 'driver' } },
    }];
    const allCapabilitiesForEvidence: any[] = [{
      id: 'cap_alerts', name: 'Alert Monitoring', related_entities: ['entity_alert'], related_domains: [], operations: [],
    }];
    const userJourneys: any[] = [{
      id: 'journey_alert', name: 'Driver Alert Journey',
      terminal_effects: { entities_written: ['DriveAlert'], entities_read: [] },
    }];

    let firstBatchIds: string[] = [];
    try {
      await orch.applyAIElementDescriptions([], entities, {
        systemName: 'fleet-api',
        enhancedSystemPurpose: {
          primary_type: 'backend-service', confidence: 0.9, evidence: [],
          primary_domain: 'fleet-management', core_concepts: ['driver', 'fleet'],
          inferred_description: 'A fleet management backend for driver workflows.',
          supporting_workflow_ids: [],
        },
        frameworks: ['NestJS'],
        includeEntities: true,
        nodes, edges, allCapabilitiesForEvidence, userJourneys,
      });
      // The FIRST provider call's batch (call order == cursor order for
      // concurrency >= batch count, see runWithConcurrency) must lead with
      // the richest-evidence entity, not the catalog-order entity. Read
      // before mockRestore() below, which clears mock.calls.
      firstBatchIds = (spy.mock.calls[0][0] as any).additionalContext.items.map((item: any) => item.id);
    } finally {
      spy.mockRestore();
      if (previousOpenAI === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousOpenAI;
      if (previousElementDescriptions === undefined) delete process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS; else process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS = previousElementDescriptions;
      if (previousBatchSize === undefined) delete process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BATCH_SIZE; else process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BATCH_SIZE = previousBatchSize;
    }

    expect(firstBatchIds[0]).toBe('entity_alert');
    expect(entities.find(e => e.id === 'entity_alert')!.description_source).toBe('ai');
  });

  it('records honest entity_description_coverage (described/total + stopped_reason) when the wall-clock budget cuts the pass short', async () => {
    const previousOpenAI = process.env.OPENAI_API_KEY;
    const previousElementDescriptions = process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS;
    const previousBatchSize = process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BATCH_SIZE;
    const previousConcurrency = process.env.KLAURO_AI_CONCURRENCY;
    const previousBudget = process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BUDGET_MS;
    process.env.OPENAI_API_KEY = 'test-openai-key';
    delete process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS;
    process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BATCH_SIZE = '1';
    process.env.KLAURO_AI_CONCURRENCY = '1';
    process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BUDGET_MS = '50';

    const spy = jest.spyOn(aiService, 'generateComponentDescription').mockImplementation(async (args: any) => {
      await new Promise(resolve => setTimeout(resolve, 30));
      return JSON.stringify({
        descriptions: args.additionalContext.items.map((item: any) => ({
          id: item.id,
          description: `${item.name} tracks fleet identity records referenced across dispatch, billing, and safety workflows.`,
        })),
      });
    });

    const entities: CASDataEntity[] = Array.from({ length: 5 }, (_, i) => ({
      id: `entity_${i}`,
      name: `Fixture${i}`,
      lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] },
    }));
    const enhancedSystemPurpose: any = {
      primary_type: 'backend-service', confidence: 0.9, evidence: [],
      primary_domain: 'fleet-management', core_concepts: ['fleet'],
      inferred_description: 'A fleet management backend.',
      supporting_workflow_ids: [],
    };

    try {
      await orch.applyAIElementDescriptions([], entities, {
        systemName: 'fleet-api',
        enhancedSystemPurpose,
        frameworks: ['NestJS'],
        includeEntities: true,
      });
    } finally {
      spy.mockRestore();
      if (previousOpenAI === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousOpenAI;
      if (previousElementDescriptions === undefined) delete process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS; else process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS = previousElementDescriptions;
      if (previousBatchSize === undefined) delete process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BATCH_SIZE; else process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BATCH_SIZE = previousBatchSize;
      if (previousConcurrency === undefined) delete process.env.KLAURO_AI_CONCURRENCY; else process.env.KLAURO_AI_CONCURRENCY = previousConcurrency;
      if (previousBudget === undefined) delete process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BUDGET_MS; else process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BUDGET_MS = previousBudget;
    }

    const coverage = enhancedSystemPurpose.entity_description_coverage;
    expect(coverage).toBeDefined();
    expect(coverage.total).toBe(5);
    expect(coverage.described).toBeGreaterThan(0);
    expect(coverage.described).toBeLessThan(5);
    expect(coverage.stopped_reason).toBe('budget-exhausted');
    expect(coverage.priority_ordered).toBe(true);
  });

  it('rejects AI element descriptions that add unsupported business or compliance claims', async () => {
    expect(orch.isUsefulElementDescription(
      'Driver Management handles driver assignments and improves operational efficiency while ensuring compliant fleet workflows.',
      {
        id: 'cap_0',
        name: 'Driver Management',
        relatedDomains: ['driver', 'fleet'],
        fields: [],
      }
    )).toBe(false);
  });

  it('uses page route segments instead of grouping every frontend route under pages', async () => {
    const productPage = {
      id: 'entry-product',
      type: 'page',
      name: 'ProductPage',
      source_node: 'product-page',
      handler: { node_id: 'product-page', method_name: 'ProductPage', file: 'src/app/product/page.tsx' },
    };
    const companyPage = {
      id: 'entry-company',
      type: 'page',
      name: 'CompanyPage',
      source_node: 'company-page',
      handler: { node_id: 'company-page', method_name: 'CompanyPage', file: 'src/app/company/page.tsx' },
    };

    const nodes = [
      node({ id: 'product-page', name: 'ProductPage', type: 'component', source: { file: 'src/app/product/page.tsx' } }),
      node({ id: 'company-page', name: 'CompanyPage', type: 'component', source: { file: 'src/app/company/page.tsx' } }),
    ];
    const { capabilities } = await orch.buildSystemCapabilities([productPage, companyPage] as any, [], nodes, []);
    const domains = capabilities.map((capability: any) => capability.related_domains).flat();

    expect(domains).toEqual(expect.arrayContaining(['product', 'company']));
    expect(domains).not.toContain('pages');
  });

  it('strips agent tooling instructions from guide-file project text so they cannot poison domain inference', async () => {
    const guide = [
      '# My Game',
      'A tactical role-playing game with crafting, combat, and quests.',
      'Use Klauro as the architecture brief before broad file reads.',
      'Call get_agent_context for real work so CAS resolves the target.',
      'When an MCP client starts from prompts, use the agent_coding_session prompt.',
      'Players recruit party members and explore dungeons.',
    ].join('\n');

    const stripped = orch.stripAgentToolingInstructionText(guide);

    expect(stripped).toContain('tactical role-playing game');
    expect(stripped).toContain('recruit party members');
    expect(stripped).not.toMatch(/klauro|agent context|mcp/i);
  });

  it('does not derive capability domains from UI or framework mechanics tokens', async () => {
    for (const text of ['sortByDate', 'filterColumns', 'getChildren', 'objectKeys', 'iconForStatus', 'ngrxEffects', 'provideStoreNgrx', 'toggleDropdown', 'paginationState']) {
      expect(orch.domainKeyFromText(text)).toBeUndefined();
    }
    // Keys preserve the full meaningful phrase instead of truncating to a
    // single leading word — dropping "inspection" here is exactly the class
    // of bug that produced malformed capability names elsewhere (e.g.
    // "Monte Management" from "Monte Carlo"). "request" is filtered as a
    // generic token, so "evidenceRequest" still reduces to "evidence".
    expect(orch.domainKeyFromText('evidenceRequest')).toBe('evidence');
    expect(orch.domainKeyFromText('vehicleInspection')).toBe('vehicle-inspection');
  });

  it('does not promote UI interaction and data-fetching mechanics into product capabilities', async () => {
    const nodes = [
      node({ id: 'approval-page', name: 'ApprovalPage', type: 'component', source: { file: 'src/views/app/pages/approvals/index.tsx' } }),
      node({ id: 'click-handler', name: 'handleClick', type: 'function', source: { file: 'src/views/app/pages/approvals/index.tsx' } }),
      node({ id: 'mutation-fn', name: 'mutationFn', type: 'function', source: { file: 'src/views/app/pages/approvals/index.tsx' } }),
      node({ id: 'latest-hook', name: 'useLatest', type: 'function', source: { file: 'src/hooks/useLatest.ts' } }),
    ];
    const entryPoints = [
      {
        id: 'entry-approval-page',
        type: 'page',
        name: 'ApprovalPage',
        source_node: 'approval-page',
        handler: { node_id: 'approval-page', method_name: 'ApprovalPage', file: 'src/views/app/pages/approvals/index.tsx' },
      },
      {
        id: 'entry-click',
        type: 'click',
        name: 'Click',
        source_node: 'click-handler',
        handler: { node_id: 'click-handler', method_name: 'handleClick', file: 'src/views/app/pages/approvals/index.tsx' },
      },
      {
        id: 'entry-mutation',
        type: 'mutation',
        name: 'Mutation',
        source_node: 'mutation-fn',
        handler: { node_id: 'mutation-fn', method_name: 'mutationFn', file: 'src/views/app/pages/approvals/index.tsx' },
      },
      {
        id: 'entry-latest',
        type: 'graphql',
        name: 'Latest',
        source_node: 'latest-hook',
        handler: { node_id: 'latest-hook', method_name: 'useLatest', file: 'src/hooks/useLatest.ts' },
      },
    ];

    const { capabilities } = await orch.buildSystemCapabilities(entryPoints as any, [], nodes, [], '/tmp/soon-ui');
    const names = capabilities.map((capability: any) => capability.name);
    const labels = capabilities.map((capability: any) => capability.structural_label);
    const approvalCapability = capabilities.find((capability: any) => /approval/i.test(capability.name));

    expect(names.some((name: string) => /approval/i.test(name))).toBe(true);
    expect(approvalCapability?.id).toMatch(/^cap_approval/);
    // Noise domains never become capabilities — assert on the structural label,
    // which retains the "<Domain> Management" grammar the filters key off.
    expect(labels).not.toContain('Click Management');
    expect(labels).not.toContain('Mutation Management');
    expect(labels).not.toContain('Query Management');
    expect(labels).not.toContain('Latest Management');
    expect(labels).not.toContain('Soon Management');
    expect(labels.join('\n')).not.toMatch(/\b(click|mutation|query|latest)\s+(management|workflow|capability)\b/i);
  });

  it('does not classify marketing UI cards and video players as a gaming platform', async () => {
    const nodes: CASNode[] = [
      node({ id: 'video-player', name: 'VideoPlayer', type: 'component', source: { file: 'src/app/video-player.tsx' } }),
      node({ id: 'stats-card', name: 'StatsCard', type: 'component', source: { file: 'src/app/stats-section.tsx' } }),
      node({ id: 'feature-card', name: 'FeatureCard', type: 'component', source: { file: 'src/app/product/feature-stack.tsx' } }),
    ];
    const purpose = await orch.inferSystemPurpose([], [], [], nodes);

    expect(purpose.primary_type).not.toBe('gaming-platform');
  });

  it('does not classify generic preview or invariant names as developer tooling', async () => {
    const nodes: CASNode[] = [
      node({ id: 'preview-window', name: 'PreviewWindow', type: 'component', source: { file: 'src/PreviewWindow.xaml.cs' } }),
      node({ id: 'patient-invariant', name: 'PatientInvariantCheck', type: 'service', source: { file: 'src/PatientInvariantCheck.cs' } }),
      node({ id: 'patient', name: 'Patient', type: 'entity', source: { file: 'src/Patient.cs' } }),
    ];
    const purpose = await orch.inferSystemPurpose([], [], [], nodes);

    expect(purpose.primary_type).not.toBe('devtools-platform');
  });

  it('classifies page-only React/Next style surfaces as frontend applications', async () => {
    const entryPoints = [{
      id: 'entry-home',
      type: 'page',
      name: 'Home',
      source_node: 'home-page',
      handler: { node_id: 'home-page', method_name: 'Home', file: 'src/app/page.tsx' },
    }];
    const nodes: CASNode[] = [
      node({ id: 'home-page', name: 'Home', type: 'component', source: { file: 'src/app/page.tsx' } }),
      node({ id: 'content-card', name: 'ContentCard', type: 'component', source: { file: 'src/app/content-card.tsx' } }),
    ];
    const purpose = await orch.inferSystemPurpose(entryPoints as any, [], [], nodes);

    expect(purpose.primary_type).toBe('frontend-application');
  });

  it('does not classify desktop GUI apps as CLI tools only because they have Main entry points', async () => {
    const entryPoints = [{
      id: 'entry-main',
      type: 'cli',
      name: 'Program.Main',
      source_node: 'program-main',
      handler: { node_id: 'program-main', method_name: 'Main', file: 'src/Program.cs' },
    }];
    const nodes: CASNode[] = [
      node({ id: 'program-main', name: 'Program', type: 'class', source: { file: 'src/Program.cs' } }),
      node({ id: 'main-window', name: 'MainWindow', type: 'class', source: { file: 'src/MainWindow.xaml.cs' } }),
      node({ id: 'patient-window', name: 'PatientWindow', type: 'class', source: { file: 'src/PatientWindow.xaml.cs' } }),
      node({ id: 'muscle-viewmodel', name: 'MuscleTestViewModel', type: 'class', source: { file: 'src/ViewModels/MuscleTestViewModel.cs' } }),
      node({ id: 'patient-viewmodel', name: 'PatientViewModel', type: 'class', source: { file: 'src/ViewModels/PatientViewModel.cs' } }),
      node({ id: 'report-modal', name: 'ReportModal', type: 'class', source: { file: 'src/Modals/ReportModal.xaml.cs' } }),
    ];
    const purpose = await orch.inferSystemPurpose(entryPoints as any, [], [], nodes);

    expect(purpose.primary_type).not.toBe('cli-tool');
  });

  it('prefers clinical desktop signals over incidental help/tutorial content', async () => {
    const nodes: CASNode[] = [
      node({ id: 'lesson-help', name: 'TutorialHelpWindow', type: 'class', source: { file: 'src/Help/TutorialHelpWindow.xaml.cs' } }),
      node({ id: 'patient-window', name: 'PatientWindow', type: 'class', source: { file: 'src/PatientWindow.xaml.cs' } }),
      node({ id: 'muscle-viewmodel', name: 'MuscleMeasurementViewModel', type: 'class', source: { file: 'src/ViewModels/MuscleMeasurementViewModel.cs' } }),
      node({ id: 'device-modal', name: 'DeviceForceModal', type: 'class', source: { file: 'src/Modals/DeviceForceModal.xaml.cs' } }),
    ];
    const purpose = await orch.inferSystemPurpose([], [], [], nodes);

    expect(purpose.primary_type).toBe('clinical-testing-platform');
  });

  it('prioritizes clinical capabilities in clinical testing summaries', async () => {
    expect(orch.capabilityPurposeBias('clinical-testing', { name: 'Patient Report Management', related_domains: [], related_entities: [] })).toBe(0);
    expect(orch.capabilityPurposeBias('clinical-testing', { name: 'Snack Management', related_domains: [], related_entities: [] })).toBe(1);
    expect(orch.purposeCapabilitySummary('clinical-testing', [
      { name: 'Patient Management', related_domains: ['patient'], related_entities: [], operations: [] },
      { name: 'Device Management', related_domains: ['device'], related_entities: [], operations: [] },
      { name: 'Report Management', related_domains: ['report'], related_entities: [], operations: [] },
    ])).toEqual(['patient records', 'device connectivity', 'clinical reporting']);
  });

  it('uses fleet-management project text to override incidental multiplayer vocabulary', async () => {
    expect(orch.refinePurposeTypeForDomain(
      'multiplayer-application',
      'fleet-management',
      ['Symfony'],
      [{ type: 'http', count: 8 }, { type: 'message', count: 31 }, { type: 'event', count: 37 }]
    )).toBe('backend-service');
  });

  it('adds readable titles and descriptions to test gaps', async () => {
    const gaps = orch.buildTestGaps([], [
      node({
        id: 'driver-service',
        name: 'DriverAssignmentService',
        type: 'service',
        source: { file: 'src/Service/DriverAssignmentService.php' },
        metadata: { access_modifier: 'public' },
      }),
    ]);

    expect(gaps[0]).toEqual(expect.objectContaining({
      gap_type: 'untested-flow',
      title: 'Missing tests for Driver Assignment Service',
      description: 'Driver Assignment Service is a public service without detected direct test coverage.',
      recommendation: 'Add tests for DriverAssignmentService',
    }));
  });

  it('builds static change risks when git metrics are unavailable', async () => {
    const nodes: CASNode[] = [
      node({
        id: 'invoice-controller',
        name: 'InvoiceController',
        type: 'controller',
        source: { file: 'src/Controller/InvoiceController.php' },
      }),
      node({
        id: 'invoice-service',
        name: 'InvoiceBillingService',
        type: 'service',
        source: { file: 'src/Service/Billing/InvoiceBillingService.php' },
        metadata: { complexity: { cyclomatic: 18 } },
      }),
      node({
        id: 'invoice-entity',
        name: 'Invoice',
        type: 'entity',
        source: { file: 'src/Entity/Invoice.php' },
      }),
      node({
        id: 'invoice-getter',
        name: 'getReportPeriod',
        type: 'method',
        source: { file: 'src/Entity/Invoice.php' },
      }),
    ];
    const edges: CASEdge[] = [
      { id: 'e1', source: 'invoice-controller', target: 'invoice-service', type: 'calls' },
      { id: 'e2', source: 'invoice-service', target: 'invoice-entity', type: 'uses' },
    ];
    const entryPoints = [{
      id: 'invoice-http',
      type: 'http',
      name: 'POST /invoices',
      source_node: 'invoice-controller',
      handler: { node_id: 'invoice-controller', file: 'src/Controller/InvoiceController.php' },
      trigger: { method: 'POST', path: '/invoices' },
    }];

    const risks = orch.buildChangeRisks(nodes, edges, entryPoints as any);
    const summary = orch.buildChangeRiskSummary(risks);

    expect(risks.length).toBeGreaterThan(0);
    expect(risks.map((risk: any) => risk.node_id)).toEqual(expect.arrayContaining(['invoice-controller', 'invoice-service', 'invoice-entity']));
    expect(risks.map((risk: any) => risk.node_id)).not.toContain('invoice-getter');
    expect(risks.find((risk: any) => risk.node_id === 'invoice-controller')?.risk_factors.map((factor: any) => factor.factor)).toContain('critical-path');
    expect(risks.find((risk: any) => risk.node_id === 'invoice-service')?.risk_factors.map((factor: any) => factor.factor)).toEqual(expect.arrayContaining(['complex-logic', 'no-tests']));
    expect(summary.high_risk_nodes.length).toBeGreaterThan(0);
  });

  it('recognizes mediator, unit-of-work, singleton, and MVVM patterns', async () => {
    const nodes: CASNode[] = [
      node({ id: 'view', name: 'CheckoutView', type: 'component', source: { file: 'src/checkout/CheckoutView.tsx' } }),
      node({ id: 'vm', name: 'CheckoutViewModel', type: 'class', source: { file: 'src/checkout/CheckoutViewModel.ts' } }),
      node({ id: 'handler', name: 'SubmitOrderCommandHandler', type: 'class', source: { file: 'src/checkout/handlers/SubmitOrderCommandHandler.ts' } }),
      node({ id: 'uow', name: 'UnitOfWork', type: 'class', source: { file: 'src/data/UnitOfWork.ts' } }),
      node({ id: 'registry', name: 'ServiceRegistry', type: 'class', source: { file: 'src/core/ServiceRegistry.ts' } }),
    ];

    const summary = orch.buildArchitectureSummary(nodes, [], [], []);
    const names = summary.architectural_patterns?.map((pattern: any) => pattern.name);

    expect(names).toEqual(expect.arrayContaining(['MVVM', 'Mediator / Handler', 'Unit of Work', 'Singleton / Registry']));
  });

  it('filters low-level runtime calls out of external service summaries', async () => {
    const exitPoints: CASExitPoint[] = [
      exitPoint({ id: 'file-exists', type: 'sdk', name: 'File.Exists', target: { sdk: 'File.Exists' } }),
      exitPoint({ id: 'string-empty', type: 'sdk', name: 'String.IsNullOrEmpty', target: { sdk: 'String.IsNullOrEmpty' } }),
      exitPoint({ id: 'rxjs', type: 'sdk', name: 'rxjs/operators', target: { sdk: 'rxjs/operators' } }),
      exitPoint({ id: 'internal-alias', type: 'sdk', name: '@app/shared/utils/generic', target: { sdk: '@app/shared/utils/generic' } }),
      exitPoint({ id: 'node-http', type: 'sdk', name: 'node:http', target: { sdk: 'node:http' } }),
      exitPoint({ id: 'cart-service', type: 'sdk', name: 'CartService.upsert', target: { sdk: 'CartService.upsert' } }),
      exitPoint({ id: 'db-update', type: 'sdk', name: 'Db.update', target: { sdk: 'Db.update' } }),
      exitPoint({ id: 'dbcontext-assets', type: 'sdk', name: 'YisdaDbContext.Assets', target: { sdk: 'YisdaDbContext.Assets' } }),
      exitPoint({ id: 'ctx-query', type: 'sdk', name: '_ctx.refreshtokens.Where(r => r.subject == token.subject)', target: { sdk: '_ctx.refreshtokens.Where(r => r.subject == token.subject)' } }),
      exitPoint({ id: 'ctx-set', type: 'sdk', name: '_ctx.refreshtokens', target: { sdk: '_ctx.refreshtokens' } }),
      exitPoint({ id: 'property-access', type: 'sdk', name: 'entry.Name', target: { sdk: 'entry.Name' } }),
      exitPoint({ id: 'property-chain', type: 'sdk', name: 'x.lastUpdateOn.Value', target: { sdk: 'x.lastUpdateOn.Value' } }),
      exitPoint({ id: 'xml-query', type: 'sdk', name: 'entryXDoc.Descendants(relNs + "Relationship")', target: { sdk: 'entryXDoc.Descendants(relNs + "Relationship")' } }),
      exitPoint({ id: 'protractor', type: 'sdk', name: 'protractor', target: { sdk: 'protractor' } }),
      exitPoint({ id: 'external-file', type: 'sdk', name: 'External call: File.Exists' }),
      exitPoint({ id: 'object-assign', type: 'sdk', name: 'Object.assign', target: { sdk: 'Object.assign' } }),
      exitPoint({ id: 'linq-where', type: 'sdk', name: 'LINQ operation: Where' }),
      exitPoint({ id: 'streamwriter', type: 'sdk', name: 'External call: StreamWriter.ctor' }),
      exitPoint({ id: 'relative-fetch', type: 'api', name: 'FETCH ${routes.cart_update_url}', target: { sdk: 'FETCH ${routes.cart_update_url}' } }),
      exitPoint({ id: 'stripe', type: 'sdk', name: 'Stripe', target: { sdk: 'Stripe' } }),
    ];

    const services = orch.buildExternalServices([], exitPoints, []);

    expect(services.map((service: any) => service.name)).toEqual(['Stripe']);
  });

  it('uses React feature page folders before hook/library vocabulary for page capability keys', async () => {
    // The full folder-name phrase is preserved rather than truncated to its
    // first word — "portfolio-analysis" is a more specific, correct key than
    // "portfolio" alone (dropping "analysis" is the truncation bug that also
    // produced malformed names like "Monte Management" from "Monte Carlo").
    expect(orch.inferResourceKey({
      type: 'page',
      name: 'PortfolioAnalysisPage',
      handler: { file: 'src/views/app/pages/portfolio-analysis/index.tsx' },
    })).toBe('portfolio-analysis');
    expect(orch.inferResourceKey({
      type: 'page',
      name: 'VerifyEmailView',
      handler: { file: 'src/views/auth/verify-email.tsx' },
    })).toBe('auth');
  });

  it('prioritizes product capabilities over cross-cutting auth and billing cards', async () => {
    const ordered = [
      { name: 'User Management', category: 'supporting', criticality: 'high', operations: [], related_domains: ['user'], related_entities: [] },
      { name: 'Checkout Management', category: 'supporting', criticality: 'medium', operations: [], related_domains: ['checkout'], related_entities: [] },
      { name: 'Portfolio Management', category: 'supporting', criticality: 'medium', operations: [], related_domains: ['portfolio'], related_entities: [] },
      { name: 'Token Balance Discovery', category: 'core', criticality: 'medium', operations: [], related_domains: ['token-balance'], related_entities: [] },
    ].sort((a: any, b: any) => orch.systemCapabilityProductPriority(a) - orch.systemCapabilityProductPriority(b));

    expect(ordered.map((capability: any) => capability.name)).toEqual([
      'Token Balance Discovery',
      'Portfolio Management',
      'Checkout Management',
      'User Management',
    ]);
  });

  it('does not summarize the repo name as a product capability or core concept', async () => {
    expect(orch.isProjectNameCapabilityName('Soon Management', '/tmp/soon-ui')).toBe(true);
    expect(orch.isProjectNameConcept('soon', '/tmp/soon-ui')).toBe(true);
    expect(orch.isProjectNameCapabilityName('Portfolio Management', '/tmp/soon-ui')).toBe(false);
  });

  it('treats UI-control vocabulary as capability noise', async () => {
    for (const token of ['buttons', 'changed', 'circular', 'color', 'combo', 'contents', 'current', 'custom', 'dispose', 'image', 'bar', 'box', 'middle', 'name', 'action', 'flow', 'runtime', 'mode', 'record', 'extract', 'assistant', 'operator', 'seed', 'dedupe', 'drawer', 'string']) {
      expect(orch.isGenericCapabilityToken(token)).toBe(true);
    }
  });

  it('treats CAS harness files as non-product source', async () => {
    expect(orch.isPrimaryProductPath('packages/analyzer-core/cas-tests/test-hoggan-analysis.ts')).toBe(false);
    expect(orch.isPrimaryProductPath('src/test-hoggan-analysis.ts')).toBe(false);
    expect(orch.isPrimaryProductPath('packages/analyzer-core/src/analyzer/core/orchestrator.ts')).toBe(true);
  });

  it('uses product subfolders instead of generic api/source areas in terminal descriptions', async () => {
    expect(orch.capabilitySourceAreas([], [
      { action: 'Read', path_or_command: 'src/api/sync/automation/useAutomationConfig.ts' },
      { action: 'Read', path_or_command: 'src/views/app/pages/portfolio-analysis/index.tsx' },
      { action: 'Read', path_or_command: 'src/views/auth/verify-email.tsx' },
      { action: 'Read', path_or_command: 'src/1.Domain/Identity.Domain.Actions/RegisterNewToken.cs' },
    ])).toEqual(['automation', 'portfolio analysis', 'auth']);
  });

  it('accepts AI descriptions grounded in structural facts when the inferred domain seed is wrong', async () => {
    const purpose = { primary_domain: 'cloud-infrastructure', core_concepts: ['terraform', 'module'] };
    const description = 'A laundry service booking application where customers schedule pickups, track washing orders, and manage delivery preferences for their household laundry.';

    expect(orch.validateAIInterpretation(description, purpose).reason).toBe('not-grounded-in-domain-or-concepts');
    expect(orch.validateAIInterpretation(description, purpose, {
      structuralTokens: ['laundry', 'booking', 'pickup', 'delivery'],
    }).ok).toBe(true);
  });

  it('requires generated AI overviews to be paragraph-style, not a single compressed sentence', async () => {
    const purpose = { primary_domain: 'portfolio-management', core_concepts: ['portfolio', 'automation', 'market'] };
    const oneSentence = 'soon-ui is a portfolio management system that coordinates portfolio data, market discovery, and automation workflows using React and TanStack Query.';
    const paragraph = 'soon-ui is a portfolio management system that presents account holdings, market data, and automation settings through a React interface. It connects portfolio analysis, exchange setup, and recurring investment workflows so agents can understand where product behavior lives before editing.';

    expect(orch.validateAIInterpretation(oneSentence, purpose, { frameworks: ['React'], libraries: ['@tanstack/react-query'] }).ok).toBe(true);
    expect(orch.validateGeneratedAIInterpretation(oneSentence, purpose, { frameworks: ['React'], libraries: ['@tanstack/react-query'] }).reason).toBe('too-short-for-ai-paragraph');
    expect(orch.validateGeneratedAIInterpretation(paragraph, purpose, { frameworks: ['React'], libraries: ['@tanstack/react-query'] }).ok).toBe(true);
  });

  it('rejects AI overviews that leak the repo name as a capability concept', async () => {
    const purpose = { primary_domain: 'portfolio-management', core_concepts: ['portfolio', 'automation', 'market data'] };
    const leaked = 'soon-ui is a portfolio management system that coordinates portfolio, soon, market data discovery, and automation workflows using React. It presents assets, activity, and payments through portfolio screens.';

    expect(orch.validateGeneratedAIInterpretation(leaked, purpose, {
      systemName: 'soon-ui',
      frameworks: ['React'],
      structuralTokens: ['portfolio', 'market', 'automation', 'asset'],
    }).reason).toBe('project-name-as-concept');
  });

  it('selects distinctive domain entities ahead of generic Portfolio/Strategy/User CRUD', async () => {
    const dataEntities = [
      { id: 'e1', name: 'Portfolio', lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } },
      { id: 'e2', name: 'Strategy', lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } },
      { id: 'e3', name: 'UsageStats', lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } },
      { id: 'e4', name: 'UserPreferences', lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } },
      { id: 'e5', name: 'DexTrade', lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } },
      { id: 'e6', name: 'WhaleTransaction', lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } },
      { id: 'e7', name: 'OhlcvCandle', lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } },
      { id: 'e8', name: 'PreflightDecision', lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } },
    ];
    const selected = orch.selectDistinctiveEntityNames(dataEntities as any);
    // Distinctive crypto entities rank ahead of the generic ones.
    expect(selected.slice(0, 4)).toEqual(['DexTrade', 'WhaleTransaction', 'OhlcvCandle', 'PreflightDecision']);
    expect(selected.indexOf('DexTrade')).toBeLessThan(selected.indexOf('Portfolio'));
    expect(selected.indexOf('WhaleTransaction')).toBeLessThan(selected.indexOf('UsageStats'));
  });

  it('surfaces the DISTINCTIVE crypto grounding (ccxt, DexTrade, manifest description) to the comprehension prompt for a soon-lens-shaped repo', async () => {
    // The narrow ORM/@Entity view is the generic Strategy CRUD; the real
    // 202-entity catalog holds the crypto truth. The prompt facts must ground on
    // the distinctive entities + full dependency manifest + manifest description,
    // NOT the generic ORM list.
    const databaseEntities = ['Strategy', 'StrategyExecution', 'StrategyAlert'];
    const libraryNames = ['@nestjs/core', 'ccxt', '@triton-one/yellowstone-grpc', 'web3', 'mikro-orm'];
    const dataEntities = [
      { id: 'e1', name: 'Strategy', lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } },
      { id: 'e2', name: 'DexTrade', lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } },
      { id: 'e3', name: 'DexPoolInfo', lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } },
      { id: 'e4', name: 'OhlcvCandle', lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } },
      { id: 'e5', name: 'WhaleTransaction', lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } },
      { id: 'e6', name: 'PoolState', lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } },
      { id: 'e7', name: 'PreflightDecision', lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } },
    ];
    const projectTextSignal = {
      concepts: ['dex', 'whale', 'ohlcv'],
      evidence: ['package.json description'],
      manifestDescription: 'Soon Lens crypto intelligence and agent preflight API',
    };

    const facts = orch.buildAIInterpretationFacts(
      'soon-lens',
      ['nestjs'],
      [{ type: 'http', count: 45 }],
      databaseEntities,
      [],
      orch.emptyFlowGraph(),
      [],
      [],
      libraryNames,
      projectTextSignal,
      dataEntities as any,
      projectTextSignal.manifestDescription,
    );

    // Full dependency manifest reaches the prompt (ccxt/yellowstone/web3).
    expect(facts.libraries).toContain('ccxt');
    expect(facts.libraries).toContain('@triton-one/yellowstone-grpc');
    expect(facts.libraries).toContain('web3');
    // Distinctive crypto entities reach the prompt as an explicit fact.
    expect(facts.distinctiveEntities).toContain('DexTrade');
    expect(facts.distinctiveEntities).toContain('WhaleTransaction');
    expect(facts.distinctiveEntities).toContain('PreflightDecision');
    // The entity grounding fed to base facts is the distinctive set, NOT the
    // generic 3-entity ORM view.
    expect(facts.databaseEntities).toContain('DexTrade');
    // The raw manifest self-description reaches the prompt verbatim.
    expect(facts.manifestDescription).toBe('Soon Lens crypto intelligence and agent preflight API');
  });

  it('feeds the terminal signal (ranked terminal entities/capabilities + domain seed) into the comprehension prompt as primary grounding', async () => {
    // The terminal signal is what journeys ultimately produce — the strongest
    // "what is this product" evidence. It must reach the prompt facts.
    const localOrch = new AnalyzerOrchestrator() as any;
    localOrch.activeTerminalSignal = {
      ranked_entities: [
        { name: 'DexTrade', score: 9, journey_count: 4, write_journeys: 4, read_journeys: 0, user_facing_journeys: 2 },
        { name: 'WhaleTransaction', score: 8, journey_count: 3, write_journeys: 3, read_journeys: 0, user_facing_journeys: 1 },
        { name: 'OhlcvCandle', score: 7, journey_count: 3, write_journeys: 2, read_journeys: 1, user_facing_journeys: 1 },
      ],
      ranked_stages: [{ name: 'DexPricingService', score: 6, journey_count: 3, min_distance_from_terminal: 1 }],
      ranked_capabilities: [{ name: 'DEX market pricing', score: 9, matched_terminal_entities: ['DexTrade', 'OhlcvCandle'] }],
      domain_seed_text: 'DexTrade WhaleTransaction OhlcvCandle DexTrade DexPricingService',
    };
    const facts = localOrch.buildAIInterpretationFacts(
      'soon-lens', ['nestjs'], [{ type: 'http', count: 45 }],
      ['Strategy', 'Portfolio'], [], localOrch.emptyFlowGraph(), [], [],
      ['ccxt', '@triton-one/yellowstone-grpc'],
      { concepts: [], evidence: [] }, [], '',
    );
    expect(facts.terminalOutputs.some((o: string) => o.startsWith('DexTrade'))).toBe(true);
    expect(facts.terminalCapabilities).toContain('DEX market pricing');
    expect(String(facts.terminalDomainSeed)).toContain('DexTrade');
    expect(facts.nearTerminalStages).toContain('DexPricingService');
    // And the gate can ground a crypto/DEX description on the terminal tokens
    // (camelCase entity names are split, so "OhlcvCandle" -> ohlcv/candle etc.).
    const tokens = localOrch.structuralGroundingTokens(facts, ['Strategy', 'Portfolio']);
    expect(tokens).toEqual(expect.arrayContaining(['ohlcv', 'candle', 'whale', 'pricing']));
  });

  it('rejects a fabricated system-type with no supporting evidence but accepts one grounded in dependencies', async () => {
    const purpose = { primary_domain: 'crypto-market-intelligence', core_concepts: ['dex', 'ohlcv', 'whale', 'pool'] };
    const grounding = {
      systemName: 'soon-lens',
      frameworks: ['nestjs'],
      libraries: ['ccxt', '@triton-one/yellowstone-grpc', 'web3'],
      databaseEntities: ['DexTrade', 'WhaleTransaction', 'OhlcvCandle', 'PreflightDecision'],
      structuralTokens: ['dextrade', 'whale', 'ohlcv', 'pool', 'preflight'],
      projectTextSummary: 'Soon Lens crypto intelligence and agent preflight API',
    };

    // FABRICATION: "security-scanning tool" with zero security/scanning evidence.
    const fabricated = 'soon-lens is a security-scanning tool built with NestJS that manages portfolio holdings and strategy configuration. It tracks DexTrade and OhlcvCandle records for market analysis.';
    const fabricatedVerdict = orch.validateGeneratedAIInterpretation(fabricated, purpose, grounding);
    expect(fabricatedVerdict.ok).toBe(false);
    expect(String(fabricatedVerdict.reason)).toMatch(/ungrounded-system-type/);

    // GROUNDED: "crypto market-intelligence API" — every distinctive modifier
    // traces to a supplied fact (ccxt dep / crypto concepts).
    const grounded = 'soon-lens is a crypto market-intelligence API built with NestJS that aggregates DexTrade and OhlcvCandle market data across exchanges. It surfaces WhaleTransaction signals and PreflightDecision risk attestations for trading agents.';
    expect(orch.validateGeneratedAIInterpretation(grounded, purpose, grounding).ok).toBe(true);
  });

  it('does not reject a description because a gerund/participle lands in the system-type modifier window (prod: ungrounded-system-type: incorporating)', async () => {
    // Klauro-self-shaped facts: monorepo/MCP/analyzer are all real evidence.
    const purpose = { primary_domain: 'code-analysis', core_concepts: ['monorepo', 'mcp', 'analyzer', 'parser'] };
    const grounding = {
      systemName: 'klauro',
      frameworks: ['nestjs'],
      libraries: ['tree-sitter', '@nestjs/core', '@modelcontextprotocol/sdk'],
      databaseEntities: ['AnalysisSnapshot', 'CapabilityNode'],
      structuralTokens: ['monorepo', 'analyzer', 'parser', 'capability'],
      projectTextSummary: 'MCP analyzer monorepo for codebase analysis',
    };

    // "incorporating" is a verbal participle linking a clause, NOT a
    // system-type claim. Before the fix, the modifier-window extraction
    // crossed the clause boundary ("platform incorporating the core
    // services"), every other window token was filtered as stopword/generic,
    // and the gate rejected the whole paragraph with
    // 'ungrounded-system-type: incorporating'.
    const description = 'klauro is an MCP analyzer monorepo built with NestJS, an internal platform incorporating the core services that parse repositories with tree-sitter and expose analysis results over MCP. Capability and parser records are stored as AnalysisSnapshot data for downstream agents.';
    expect(orch.validateGeneratedAIInterpretation(description, purpose, grounding)).toEqual({ ok: true });

    // A genuinely ungrounded system-type claim must still fail: zero solana/
    // arbitrage evidence anywhere in the supplied facts.
    const fabricated = 'klauro is a solana arbitrage-trading platform built with NestJS that scans monorepo analyzer output and parser records for price gaps. It streams capability data as AnalysisSnapshot rows and settles the resulting trades automatically for downstream agents.';
    const fabricatedVerdict = orch.validateGeneratedAIInterpretation(fabricated, purpose, grounding);
    expect(fabricatedVerdict.ok).toBe(false);
    expect(String(fabricatedVerdict.reason)).toMatch(/ungrounded-system-type/);
  });

  describe('mechanical repair-not-reject for fixable gate rejections', () => {
    const purpose = { primary_domain: 'crypto-market-intelligence', core_concepts: ['dex', 'ohlcv', 'whale', 'pool'] };
    const grounding = {
      systemName: 'soon-lens',
      frameworks: ['nestjs'],
      libraries: ['ccxt', '@triton-one/yellowstone-grpc', 'web3'],
      databaseEntities: ['DexTrade', 'WhaleTransaction', 'OhlcvCandle', 'PreflightDecision'],
      structuralTokens: ['dextrade', 'whale', 'ohlcv', 'pool', 'preflight'],
      projectTextSummary: 'Soon Lens crypto intelligence and agent preflight API',
    };
    // A grounded paragraph proven valid by the fabricated-vs-grounded test above.
    const groundedParagraph = 'soon-lens is a crypto market-intelligence API built with NestJS that aggregates DexTrade and OhlcvCandle market data across exchanges. It surfaces WhaleTransaction signals and PreflightDecision risk attestations for trading agents.';

    it('heals a too-long paragraph by trimming to a sentence boundary instead of rejecting (prod: hercules)', async () => {
      // Build an over-budget (>2000 chars) paragraph out of individually valid
      // grounded sentences.
      const filler = ' It aggregates DexTrade and OhlcvCandle market data for trading agents across venues.';
      let long = groundedParagraph;
      while (long.length <= 2100) long += filler;
      expect(orch.validateGeneratedAIInterpretation(long, purpose, grounding).reason).toBe('too-long');

      const trimmed = orch.mechanicallyRepairAIInterpretation(long, 'too-long');
      expect(trimmed).toBeDefined();
      expect(trimmed.length).toBeLessThanOrEqual(2000);
      expect(trimmed.endsWith('.')).toBe(true);

      const outcome = orch.acceptAIInterpretationCandidate(long, purpose, grounding);
      expect(outcome.validation).toEqual({ ok: true });
      expect(outcome.text.length).toBeLessThanOrEqual(2000);
      expect(outcome.text.startsWith('soon-lens is a crypto market-intelligence API')).toBe(true);
    });

    it('heals a single ungrounded marketing word by stripping it instead of rejecting the paragraph (prod: electripure "efficient")', async () => {
      const oneWord = groundedParagraph.replace('is a crypto market-intelligence API', 'is an efficient crypto market-intelligence API');
      const verdict = orch.validateGeneratedAIInterpretation(oneWord, purpose, grounding);
      expect(verdict.reason).toBe('unsupported-marketing-language: efficient');

      // Reason-driven mechanical strip: exactly the flagged word is removed.
      const stripped = orch.mechanicallyRepairAIInterpretation(oneWord, verdict.reason);
      expect(stripped).toBeDefined();
      expect(stripped).not.toMatch(/\befficient\b/i);
      expect(stripped).toMatch(/crypto market-intelligence API/);

      const outcome = orch.acceptAIInterpretationCandidate(oneWord, purpose, grounding);
      expect(outcome.validation.ok).toBe(true);
      expect(outcome.text).not.toMatch(/\befficient\b/i);
      expect(outcome.text).toMatch(/DexTrade/);
    });

    it('heals a HYPHENATED single ungrounded modifier ("third-party") instead of misparsing it as a two-token fabrication (prod: Qwen3 on rpg-server hard-failed enrichment)', async () => {
      // The reason payload joins multi-token phrases with '-', so a hyphenated
      // single word is ambiguous by splitting alone. It appears VERBATIM in the
      // description — that evidence marks it as ONE modifier to strip.
      const stripped = orch.mechanicallyRepairAIInterpretation(
        'soon-lens is a third-party crypto market-intelligence API aggregating DexTrade market data for trading agents.',
        'ungrounded-system-type: third-party'
      );
      expect(stripped).toBeDefined();
      expect(stripped).not.toMatch(/third-party/i);
      expect(stripped).toMatch(/crypto market-intelligence API/);
    });

    it('still treats a joined multi-token fabrication as NOT mechanically fixable when the hyphenated form is absent from the text', async () => {
      // 'solana-arbitrage' as a payload for a description that never contains
      // the literal hyphenated word = two joined tokens = wholesale
      // fabrication = semantic re-prompt, exactly as before.
      expect(orch.mechanicallyRepairAIInterpretation(
        'soon-lens is a solana arbitrage engine aggregating market data.',
        'ungrounded-system-type: solana-arbitrage'
      )).toBeUndefined();
    });

    it('still rejects a paragraph SATURATED with marketing language (word-deletion would gut it)', async () => {
      const saturated = 'soon-lens is a seamless crypto market-intelligence API built with NestJS that seamlessly boosts productivity and business value while aggregating DexTrade and OhlcvCandle market data. It surfaces user-friendly WhaleTransaction signals, improving operational productivity and business value with a seamless PreflightDecision workflow for trading agents.';
      const verdict = orch.validateGeneratedAIInterpretation(saturated, purpose, grounding);
      expect(String(verdict.reason)).toMatch(/^unsupported-marketing-language:/);

      // 4+ distinct flagged phrases → NOT mechanically fixable.
      expect(orch.mechanicallyRepairAIInterpretation(saturated, verdict.reason)).toBeUndefined();
      const outcome = orch.acceptAIInterpretationCandidate(saturated, purpose, grounding);
      expect(outcome.validation.ok).toBe(false);
      expect(String(outcome.validation.reason)).toMatch(/^unsupported-marketing-language:/);
    });

    it('chains mechanical repairs: a too-long trim followed by a marketing-word strip', async () => {
      const withWord = groundedParagraph.replace('is a crypto market-intelligence API', 'is an efficient crypto market-intelligence API');
      const filler = ' It aggregates DexTrade and OhlcvCandle market data for trading agents across venues.';
      let longAndMarketing = withWord;
      while (longAndMarketing.length <= 2100) longAndMarketing += filler;
      // First rejection is too-long (checked before marketing in the gate).
      expect(orch.validateGeneratedAIInterpretation(longAndMarketing, purpose, grounding).reason).toBe('too-long');

      const outcome = orch.acceptAIInterpretationCandidate(longAndMarketing, purpose, grounding);
      expect(outcome.validation.ok).toBe(true);
      expect(outcome.text.length).toBeLessThanOrEqual(2000);
      expect(outcome.text).not.toMatch(/\befficient\b/i);
    });

    it('does not mechanically repair semantic rejection reasons (they go to the AI re-prompt)', async () => {
      expect(orch.mechanicallyRepairAIInterpretation(groundedParagraph, 'source-bucket-restatement')).toBeUndefined();
      // Multi-token ungrounded-system-type = wholesale fabrication, NOT a
      // word-level cleanup — stays semantic.
      expect(orch.mechanicallyRepairAIInterpretation(groundedParagraph, 'ungrounded-system-type: solana-arbitrage')).toBeUndefined();
      // Single-token strip only edits text that actually contains the token.
      expect(orch.mechanicallyRepairAIInterpretation(groundedParagraph, 'ungrounded-system-type: detected')).toBeUndefined();
      expect(orch.mechanicallyRepairAIInterpretation(groundedParagraph, undefined)).toBeUndefined();
    });

    it('heals a SINGLE ungrounded system-type modifier by stripping it and keeping the grounded type head (prod: hercules "commerce")', async () => {
      const purpose = { primary_domain: 'crew-dispatch', core_concepts: ['crew', 'dispatch', 'job'] };
      const grounding = {
        systemName: 'fieldapp',
        frameworks: [],
        libraries: [],
        databaseEntities: ['Crew', 'Job'],
        structuralTokens: ['crew', 'dispatch', 'job'],
        projectTextSummary: 'Crew dispatch and job tracking',
      };
      const description = 'fieldapp is a logistics platform that coordinates crew and dispatch assignments for every job in the field. It records Crew and Job entities, links each dispatch to its crew, and tracks job completion for dispatch supervisors.';
      const verdict = orch.validateGeneratedAIInterpretation(description, purpose, grounding);
      expect(verdict.reason).toBe('ungrounded-system-type: logistics');

      const stripped = orch.mechanicallyRepairAIInterpretation(description, verdict.reason);
      expect(stripped).toBeDefined();
      expect(stripped).not.toMatch(/\blogistics\b/i);
      expect(stripped).toMatch(/\bplatform\b/i);

      const outcome = orch.acceptAIInterpretationCandidate(description, purpose, grounding);
      expect(outcome.validation).toEqual({ ok: true });
      expect(outcome.text).not.toMatch(/\blogistics\b/i);
      expect(outcome.text).toMatch(/^fieldapp is a platform/i);
    });
  });

  it('never enforces bare verb forms as system-type claims (prod: ungrounded-system-type: allowed)', async () => {
    const purpose = { primary_domain: 'code-analysis', core_concepts: ['monorepo', 'mcp', 'analyzer', 'parser'] };
    const grounding = {
      systemName: 'klauro',
      frameworks: ['nestjs'],
      libraries: ['tree-sitter', '@nestjs/core', '@modelcontextprotocol/sdk'],
      databaseEntities: ['AnalysisSnapshot', 'CapabilityNode'],
      structuralTokens: ['monorepo', 'analyzer', 'parser', 'capability'],
      projectTextSummary: 'MCP analyzer monorepo for codebase analysis',
    };
    // "allowed" is a past participle inside a verb phrase ("access is allowed
    // through the API") — grammatically it can never be a TYPE claim, but the
    // modifier window used to cross the verb and enforce it (prod: Klauro
    // proof-of-concept rejected with 'ungrounded-system-type: allowed').
    const description = 'klauro is an MCP analyzer monorepo built with NestJS that parses repositories with tree-sitter and exposes analysis results over MCP. Cross-origin access is allowed through the API so downstream agents can read capability and parser records stored as AnalysisSnapshot data.';
    expect(orch.validateGeneratedAIInterpretation(description, purpose, grounding)).toEqual({ ok: true });
  });

  it('grounds an umbrella domain modifier through synonym-cluster evidence (prod: hercules "commerce" with orders/invoices/deliveries)', async () => {
    const purpose = { primary_domain: 'order-management', core_concepts: ['order', 'invoice', 'delivery', 'warehouse'] };
    const grounding = {
      systemName: 'hercules',
      frameworks: ['django'],
      libraries: ['django', 'celery'],
      databaseEntities: ['Order', 'Invoice', 'Delivery', 'Warehouse'],
      structuralTokens: ['order', 'invoice', 'delivery', 'warehouse'],
      projectTextSummary: 'Orders, invoices and warehouse management',
    };
    // "commerce" never appears literally in the evidence, but orders +
    // invoices + deliveries make the claim evidence-consistent — the model
    // kept re-emitting the natural word and the repair loop never converged.
    const description = 'hercules is a commerce platform built with Django that manages order, invoice, and delivery records across warehouse locations. It links each invoice to its order, schedules delivery for warehouse staff, and answers order lookups for operators.';
    expect(orch.validateGeneratedAIInterpretation(description, purpose, grounding)).toEqual({ ok: true });

    // The slack is grounding, not a free pass: with NO cluster evidence the
    // same claim still fails.
    const bareGrounding = {
      systemName: 'hercules',
      frameworks: ['django'],
      libraries: ['django'],
      databaseEntities: ['Widget'],
      structuralTokens: ['widget'],
      projectTextSummary: 'Widget tooling',
    };
    const barePurpose = { primary_domain: 'widget-tooling', core_concepts: ['widget'] };
    const bareDescription = 'hercules is a commerce platform built with Django that manages widget records for teams. It links each widget to its owner, schedules widget refreshes for staff, and answers widget lookups for operators across the deployment.';
    const bareVerdict = orch.validateGeneratedAIInterpretation(bareDescription, barePurpose, bareGrounding);
    expect(bareVerdict.ok).toBe(false);
    expect(String(bareVerdict.reason)).toMatch(/ungrounded-system-type: commerce/);
  });

  it('sentence-level sanitization never drops the OPENING sentence (prod: openclaw accepted description starting "It produces...")', async () => {
    const purpose = { primary_domain: 'game-management', core_concepts: ['game', 'tournament', 'card', 'deck'] };
    // First sentence trips a sentence-drop rule (unsupported framework claim
    // with frameworks: []) — sanitize must NOT return a paragraph whose
    // subject sentence is gone.
    const description = 'openclaw is built with React and Prisma for its tournament screens. It produces game, tournament, card, and deck records for organizers and tracks deck construction and tournament pairings for players across events.';
    const sanitized = orch.sanitizeAIInterpretation(description, purpose, { frameworks: [] });
    expect(sanitized).not.toMatch(/^It\b/);
    expect(sanitized).toMatch(/^openclaw\b/i);

    // Dropping a NON-opening sentence still works.
    const midBad = 'openclaw is a game management system that coordinates game, tournament, card, and deck workflows. It is built with React and Prisma for the pairing screens. It tracks deck construction and tournament pairings for players across events.';
    const midSanitized = orch.sanitizeAIInterpretation(midBad, purpose, { frameworks: [] });
    expect(midSanitized).not.toMatch(/react/i);
    expect(midSanitized).toMatch(/^openclaw is a game management system/i);
  });

  it('accepts framework mentions backed by detected libraries instead of framework analyzers', async () => {
    const purpose = { primary_domain: 'game-management', core_concepts: ['game', 'tournament', 'card', 'deck'] };
    const description = 'A game management system built with React and Prisma that coordinates game, tournament, card, and deck workflows, tracking deck construction and tournament pairings for players.';

    expect(orch.validateAIInterpretation(description, purpose, { frameworks: [] }).reason).toBe('unsupported-framework-claim');
    expect(orch.validateAIInterpretation(description, purpose, {
      frameworks: [],
      libraries: ['react', 'zustand', '@prisma/client'],
    }).ok).toBe(true);
    expect(orch.validateAIInterpretation(description, purpose, {
      frameworks: [],
      libraries: ['preact', 'zustand'],
    }).reason).toBe('unsupported-framework-claim');
  });

  it('matches scoped and suffixed package names against framework claim keys', async () => {
    const purpose = { primary_domain: 'order-management', core_concepts: ['order', 'shipment'] };
    const description = 'An order management service built with Express and NestJS that records orders and shipments, links shipment updates to each order, and answers order lookups for dispatch operators.';

    expect(orch.validateAIInterpretation(description, purpose, {
      libraries: ['express', '@nestjs/swagger'],
    }).ok).toBe(true);
    expect(orch.validateAIInterpretation(description, purpose, {
      libraries: ['express-rate-limit'],
    }).reason).toBe('unsupported-framework-claim');
  });

  it('keeps library-backed framework sentences when sanitizing rejected descriptions', async () => {
    const purpose = { primary_domain: 'game-management', core_concepts: ['game', 'tournament', 'card', 'deck'] };
    const description = 'A game management system that coordinates game, tournament, card, and deck workflows. It is built with React and Prisma for deck construction and tournament pairing screens.';

    expect(orch.sanitizeAIInterpretation(description, purpose, { frameworks: [] })).not.toMatch(/react/i);
    expect(orch.sanitizeAIInterpretation(description, purpose, {
      frameworks: [],
      libraries: ['react', '@prisma/client'],
    })).toMatch(/built with React and Prisma/);
  });

  it('treats helper verbs and generic UI actions as weak capability/domain terms', async () => {
    for (const token of ['search', 'render', 'close', 'focus', 'normalize', 'ensure', 'path', 'clamp', 'install', 'modal', 'dialog', 'screen']) {
      expect(orch.isGenericDomainToken(token)).toBe(true);
      expect(orch.isGenericCapabilityToken(token)).toBe(true);
    }
  });

  it('rejects hash/id-shaped tokens as domain vocabulary so near-empty repos never compose a "<hash>-management" domain', async () => {
    for (const token of [
      'a1b2c3d4e5f6', // long pure hex, content-hash shaped
      '9f86d081884c7d659a2feaa0c55ad015', // sha256-ish hex digest
      '550e8400-e29b-41d4-a716-446655440000', // canonical uuid
      '550e8400e29b41d4a716446655440000', // uuid without dashes
      '8f3k29xz1q', // random base36 id: no vowels, has a digit
    ]) {
      expect(orch.isGenericDomainToken(token)).toBe(true);
    }
    // Sanity: real short domain words must NOT be caught by the guard.
    for (const token of ['fleet', 'invoice', 'portfolio', 'clinical']) {
      expect(orch.isGenericDomainToken(token)).toBe(false);
    }
  });

  it('does not infer core capabilities from vendored help-library JavaScript', async () => {
    const nodes: CASNode[] = [
      node({
        id: 'vendor-next',
        name: 'next',
        type: 'function',
        source: { file: 'Hoggan Scientific/hoggan.windows.presentation/hooganscientifichelp/lib/owlcarousel/owl.carousel.min.js' },
      }),
      node({
        id: 'muscle-service',
        name: 'MuscleTestService',
        type: 'service',
        source: { file: 'Hoggan Scientific/hoggan.BLL/Services/MuscleTestService.cs' },
      }),
    ];
    const entities: CASDataEntity[] = [{
      id: 'entity-muscle-test',
      name: 'MuscleTest',
      type: 'entity',
      fields: [],
      lifecycle: { created_by: ['muscle-service'], read_by: ['muscle-service'], updated_by: [], deleted_by: [] },
      relationships: [],
    } as any];

    const { capabilities } = await orch.buildSystemCapabilities([], entities, nodes, []);
    const names = capabilities.map((capability: any) => capability.name);
    const labels = capabilities.map((capability: any) => capability.structural_label);

    expect(labels).toContain('Muscle Management');
    expect(names).toContain('Muscle');
    expect(labels).not.toContain('Next Management');
  });

  it('rejects AI system descriptions that end in generic concept lists', async () => {
    const result = orch.validateAIInterpretation(
      'An order management system built with Angular that coordinates company, offer, suggestion, and upload workflows. It connects to HTTP API Connection and apollo-angular to manage user, portal, and company data.',
      { primary_domain: 'order-management', core_concepts: ['company', 'offer', 'suggestion'] },
      { frameworks: ['Angular'], externalServices: ['HTTP API Connection', 'apollo-angular'] }
    );

    expect(result).toEqual({ ok: false, reason: 'generic-concept-ending' });
  });

  it('allows generic-looking words when they are part of a grounded multiword concept', async () => {
    const result = orch.validateAIInterpretation(
      'A Solana arbitrage system that checks SPL token balances before submitting buy and sell transactions. It uses @solana/web3.js for Solana network access and focuses its decisions on trade execution and market data.',
      { primary_domain: 'solana-arbitrage', core_concepts: ['trade execution', 'token balance', 'market data'] },
      { externalServices: ['@solana/web3.js'] }
    );

    expect(result.ok).toBe(true);
  });

  it('names the offending marketing terms in the rejection reason so repair prompts can target them', async () => {
    const result = orch.validateAIInterpretation(
      'The fleet system seamlessly tracks vehicles and improves productivity for dispatchers across fleet operations, covering trip assignment and vehicle status updates.',
      { primary_domain: 'fleet-management', core_concepts: ['fleet', 'vehicle', 'dispatch'] }
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('unsupported-marketing-language');
    expect(result.reason).toContain('seamlessly');
    expect(result.reason).toContain('productivity');
  });

  it('allows integration claims that the deterministic project-text overview itself makes', async () => {
    expect(orch.validateAIInterpretation(
      'A fleet management system for commercial vehicle operations that tracks vehicles, dispatch, and maintenance, with integrations with telematics providers.',
      {
        primary_domain: 'fleet-management',
        core_concepts: ['fleet', 'vehicle', 'dispatch'],
        inferred_description: 'A fleet management system. Project documentation describes dispatch operations and integrations with telematics and business-service providers.',
      }
    ).ok).toBe(true);

    expect(orch.validateAIInterpretation(
      'A fleet management system for commercial vehicle operations that tracks vehicles, dispatch, and maintenance, with integrations with telematics providers.',
      {
        primary_domain: 'fleet-management',
        core_concepts: ['fleet', 'vehicle', 'dispatch'],
        inferred_description: 'A fleet management system for dispatch and vehicle maintenance workflows.',
      }
    ).reason).toBe('unsupported-external-service-claim');
  });

});

describe('Terraform infrastructure analysis', () => {
  it('emits infrastructure nodes, dependencies, and provider exit points', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-terraform-analysis-'));
    fs.writeFileSync(path.join(root, 'main.tf'), `
provider "aws" {
  region = "us-east-1"
}

resource "aws_s3_bucket" "analysis_artifacts" {
  bucket = "klauro-analysis-artifacts"
}

resource "aws_s3_bucket_policy" "analysis_artifacts" {
  bucket = aws_s3_bucket.analysis_artifacts.id
  depends_on = [aws_s3_bucket.analysis_artifacts]
}

variable "location" { type = string }
variable "admin_username" { type = string }
variable "admin_password" { type = string }
variable "retention_days" { type = number }
variable "allowed_ip_range" { type = string }
`);

    try {
      const analyzer = new TerraformAnalyzer();
      const contribution = await analyzer.analyze({ projectPath: root, config: {} } as any);
      const nodes = contribution.nodes || [];
      const edges = contribution.edges || [];
      const exitPoints = contribution.exit_points || [];
      const nodeTypes = nodes.map(node => node.type);
      const addresses = nodes.map(node => node.qualified_name || node.name);

      expect(nodeTypes).toEqual(expect.arrayContaining([
        'infrastructure_file',
        'infrastructure_provider',
        'infrastructure_resource',
      ]));
      expect(addresses).toEqual(expect.arrayContaining([
        'resource.aws_s3_bucket.analysis_artifacts',
        'resource.aws_s3_bucket_policy.analysis_artifacts',
      ]));
      expect(edges.some(edge => edge.type === 'depends_on')).toBe(true);
      expect(exitPoints.map(exit => exit.target?.resource)).toEqual(expect.arrayContaining([
        'aws_s3_bucket',
        'aws_s3_bucket_policy',
      ]));

      const { capabilities } = await orch.buildSystemCapabilities(contribution.entry_points || [], [], nodes, edges, root);
      expect(capabilities.map((capability: any) => capability.name)).toEqual(expect.arrayContaining([
        'Object Storage',
      ]));
      expect(capabilities.some((capability: any) => capability.name === 'File Workflow')).toBe(false);
      expect(capabilities[0].operations.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('infers capabilities for variable-heavy Terraform modules with few resources', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-terraform-sparse-resource-analysis-'));
    fs.mkdirSync(path.join(root, 'modules/postgres'), { recursive: true });
    fs.writeFileSync(path.join(root, 'main.tf'), `
resource "azurerm_resource_group" "soon_rg" {
  name     = "soon-rg"
  location = var.location
}
`);
    fs.writeFileSync(path.join(root, 'modules/postgres/main.tf'), `
resource "azurerm_postgresql_server" "postgres" {
  name                = var.postgres_server_name
  resource_group_name = var.resource_group_name
  location            = var.location
}

resource "azurerm_postgresql_firewall_rule" "allow_access" {
  name                = "allow-access"
  resource_group_name = var.resource_group_name
  server_name         = azurerm_postgresql_server.postgres.name
  start_ip_address    = var.allowable_ip_range
  end_ip_address      = var.allowable_ip_range
}
`);
    fs.writeFileSync(path.join(root, 'modules/postgres/variables.tf'), `
variable "location" { type = string }
variable "resource_group_name" { type = string }
variable "postgres_server_name" { type = string }
variable "postgres_admin_username" { type = string }
variable "postgres_admin_password" { type = string }
variable "postgres_version" { type = string }
variable "environment" { type = string }
variable "postgres_storage_mb" { type = number }
variable "backup_retention_days" { type = number }
variable "allowable_ip_range" { type = string }
`);

    try {
      const analyzer = new TerraformAnalyzer();
      const contribution = await analyzer.analyze({ projectPath: root, config: {} } as any);
      const { capabilities } = await orch.buildSystemCapabilities(contribution.entry_points || [], [], contribution.nodes || [], contribution.edges || [], root);
      const names = capabilities.map((capability: any) => capability.name);

      expect(names).toEqual(expect.arrayContaining([
        'Database Infrastructure',
      ]));
      expect(capabilities.map((capability: any) => capability.structural_label)).not.toContain('File Workflow');
      expect(capabilities.every((capability: any) => capability.operations.length > 0)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('domain and security classification robustness (out-of-distribution repos)', () => {
  const node = (partial: Partial<CASNode>): CASNode => ({
    id: partial.id || partial.name || 'node',
    name: partial.name || 'Node',
    type: partial.type || 'class',
    source: partial.source || { file: `src/${partial.name || 'node'}.ts`, line: 1 },
    metadata: partial.metadata || {},
    subcategories: partial.subcategories,
  } as CASNode);

  it('matches whole identifier tokens only, never substrings of compound identifiers', async () => {
    expect(orch.matchesSignalPattern(orch.signalTokens('credit_card'), 'card')).toBe(false);
    expect(orch.matchesSignalPattern(orch.signalTokens('gift_card'), 'card')).toBe(false);
    expect(orch.matchesSignalPattern(orch.signalTokens('CreditCard'), 'card')).toBe(false);
    expect(orch.matchesSignalPattern(orch.signalTokens('dashboard'), 'board')).toBe(false);
    expect(orch.matchesSignalPattern(orch.signalTokens('return_authorization'), 'turn')).toBe(false);
    expect(orch.matchesSignalPattern(orch.signalTokens('return_authorization'), 'auth')).toBe(false);
    expect(orch.matchesSignalPattern(orch.signalTokens('ReturnAuthorization'), 'auth')).toBe(false);

    expect(orch.matchesSignalPattern(orch.signalTokens('CardGame'), 'game')).toBe(true);
    expect(orch.matchesSignalPattern(orch.signalTokens('game_board'), 'board')).toBe(true);
    expect(orch.matchesSignalPattern(orch.signalTokens('carts'), 'cart')).toBe(true);
    expect(orch.matchesSignalPattern(orch.signalTokens('CartsController'), 'cart')).toBe(true);
    expect(orch.matchesSignalPattern(orch.signalTokens('MuscleTestViewModel'), 'viewmodel')).toBe(true);
    expect(orch.matchesSignalPattern(orch.signalTokens('static-analysis runner'), 'static analysis')).toBe(true);
  });

  it('does not classify commerce vocabulary (credit_card, gift_card, dashboard, return_authorization) as a gaming platform', async () => {
    const nodes: CASNode[] = [
      node({ id: 'cc', name: 'CreditCard', source: { file: 'app/models/spree/credit_card.rb' } }),
      node({ id: 'gc', name: 'GiftCard', source: { file: 'app/models/spree/gift_card.rb' } }),
      node({ id: 'ra', name: 'ReturnAuthorization', source: { file: 'app/models/spree/return_authorization.rb' } }),
      node({ id: 'dash', name: 'DashboardsController', type: 'controller', source: { file: 'app/controllers/spree/admin/dashboards_controller.rb' } }),
      node({ id: 'order', name: 'Order', source: { file: 'app/models/spree/order.rb' } }),
      node({ id: 'payment', name: 'Payment', source: { file: 'app/models/spree/payment.rb' } }),
      node({ id: 'cart', name: 'CartsController', type: 'controller', source: { file: 'app/controllers/spree/carts_controller.rb' } }),
      node({ id: 'checkout', name: 'CheckoutController', type: 'controller', source: { file: 'app/controllers/spree/checkout_controller.rb' } }),
      node({ id: 'product', name: 'Product', source: { file: 'app/models/spree/product.rb' } }),
      node({ id: 'shipment', name: 'Shipment', source: { file: 'app/models/spree/shipment.rb' } }),
    ];

    const purpose = await orch.inferSystemPurpose([], [], [], nodes);

    expect(purpose.primary_type).not.toBe('gaming-platform');
    expect(purpose.secondary_types || []).not.toContain('gaming-platform');
  });

  it('still recognizes a real card game as a gaming platform with whole-token evidence', async () => {
    const nodes: CASNode[] = [
      node({ id: 'game', name: 'Game', source: { file: 'src/game/game.ts' } }),
      node({ id: 'deck', name: 'Deck', source: { file: 'src/game/deck.ts' } }),
      node({ id: 'card', name: 'Card', source: { file: 'src/game/card.ts' } }),
      node({ id: 'player', name: 'Player', source: { file: 'src/game/player.ts' } }),
      node({ id: 'lobby', name: 'GameLobby', source: { file: 'src/game/lobby.ts' } }),
      node({ id: 'board', name: 'GameBoard', source: { file: 'src/game/board.ts' } }),
    ];

    const purpose = await orch.inferSystemPurpose([], [], [], nodes);

    expect(purpose.primary_type).toBe('gaming-platform');
  });

  it('does not treat ReturnAuthorization domain models as authentication or authorization enforcement points', async () => {
    const nodes: CASNode[] = [
      node({ id: 'ra1', name: 'ReturnAuthorization', source: { file: 'app/models/spree/return_authorization.rb' }, subcategories: ['model'] }),
      node({ id: 'ra2', name: 'ReturnAuthorizationReason', source: { file: 'app/models/spree/return_authorization_reason.rb' } }),
      node({ id: 'pa', name: 'PaymentAuthorization', source: { file: 'app/models/payment_authorization.rb' } }),
      node({ id: 'ra-filter', name: 'load_return_authorization', type: 'method', subcategories: ['before_action'], source: { file: 'app/controllers/spree/admin/return_authorizations_controller.rb' } }),
      node({ id: 'policies-crud', name: 'PoliciesController', type: 'controller', subcategories: ['before_action'], source: { file: 'app/controllers/spree/admin/policies_controller.rb' } }),
      node({ id: 'auth-mw', name: 'AuthenticationMiddleware', type: 'middleware', source: { file: 'app/middleware/authentication_middleware.rb' } }),
      node({ id: 'ability', name: 'Ability', source: { file: 'app/models/spree/ability.rb' } }),
    ];

    const boundaries = orch.buildSecurityBoundaries(nodes, []);
    const enforcementIds = boundaries.flatMap((boundary: any) =>
      boundary.enforcement_points.map((point: any) => point.node_id));

    expect(enforcementIds).not.toContain('ra1');
    expect(enforcementIds).not.toContain('ra2');
    expect(enforcementIds).not.toContain('pa');
    expect(enforcementIds).not.toContain('ra-filter');
    expect(enforcementIds).not.toContain('policies-crud');
    expect(enforcementIds).toContain('auth-mw');
    expect(enforcementIds).toContain('ability');
  });

  it('keeps genuine auth actors as enforcement points under token matching', async () => {
    const nodes: CASNode[] = [
      node({ id: 'guard', name: 'JwtAuthGuard', type: 'guard', source: { file: 'src/auth/jwt-auth.guard.ts' } }),
      node({ id: 'authorizer', name: 'AuthorizationService', type: 'service', source: { file: 'src/auth/authorization.service.ts' } }),
      node({ id: 'policy', name: 'OrderPolicy', source: { file: 'app/policies/order_policy.rb' } }),
    ];

    const boundaries = orch.buildSecurityBoundaries(nodes, []);
    const enforcementIds = boundaries.flatMap((boundary: any) =>
      boundary.enforcement_points.map((point: any) => point.node_id));

    expect(enforcementIds).toContain('guard');
    expect(enforcementIds).toContain('authorizer');
    expect(enforcementIds).toContain('policy');
  });

  it('filters rails-ecosystem framework noise out of capability naming', async () => {
    for (const token of ['turbo', 'stimulus', 'sprockets', 'actiontext', 'activestorage', 'activerecord', 'devise', 'sidekiq', 'hotwire', 'importmap']) {
      expect(orch.isGenericCapabilityToken(token)).toBe(true);
    }
    expect(orch.domainKeyFromText('TurboStreamsController')).not.toBe('turbo');
    expect(orch.domainKeyFromText('TurboController')).toBeUndefined();
    expect(orch.domainKeyFromText('PaymentController')).toBe('payment');
  });
});

describe('capability noise floor and terminal capability labels', () => {
  it('suppresses error, notice, and framework-plumbing capability names', async () => {
    for (const name of [
      'Forbidden Workflow',
      'General Workflow',
      'Errors Management',
      'Getting Started Workflow',
      'Dismiss_enterprise_edition_notice Workflow',
      'Dismiss_updater_notice Workflow',
      'Json_previews Workflow',
      'Job Workflow',
      'Action_text Management',
      'Legacy Management',
    ]) {
      expect(orch.isGenericCapabilityDisplayName(name)).toBe(true);
    }
  });

  it('keeps genuine commerce capability names', async () => {
    for (const name of [
      'Orders Management',
      'Gift_cards Management',
      'Stock Management',
      'Product_translations Workflow',
      'Payment_links Workflow',
      'Jobs Management',
      'Proposal Preview',
    ]) {
      expect(orch.isGenericCapabilityDisplayName(name)).toBe(false);
    }
  });

  it('labels terminal capabilities with the full domain phrase instead of a truncated first token', async () => {
    const entity = (name: string): CASDataEntity => ({
      id: `entity_${name.toLowerCase()}`,
      name,
      lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] },
    } as CASDataEntity);

    const capabilities = await orch.buildTerminalCapabilities(
      [entity('Wishlist'), entity('WishedItem')],
      [],
      [],
      new Set<string>()
    );
    const names = capabilities.map((capability: { name: string }) => capability.name);
    const labels = capabilities.map((capability: any) => capability.structural_label);
    // The FULL domain phrase is preserved (not truncated to "Wished"); the
    // structural label carries the grammar, the display name is the subject.
    expect(labels).toContain('Wishlist Management');
    expect(labels).toContain('Wished Item Management');
    expect(names).toContain('Wishlist');
    expect(names).toContain('Wished Item');
    expect(labels.some((label: string) => /^Wished Management$/.test(label))).toBe(false);
    expect(names.some((name: string) => /^Wished$/.test(name))).toBe(false);
  });

  it('skips terminal capabilities whose domain duplicates an existing route domain in singular or plural form', async () => {
    const entity = (name: string): CASDataEntity => ({
      id: `entity_${name.toLowerCase()}`,
      name,
      lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] },
    } as CASDataEntity);

    const capabilities = await orch.buildTerminalCapabilities(
      [entity('Order'), entity('LineItem'), entity('StockItem'), entity('Stock')],
      [],
      [],
      new Set<string>(['orders', 'line_items', 'stock_items'])
    );
    const labels = capabilities.map((capability: any) => capability.structural_label);
    const names = capabilities.map((capability: { name: string }) => capability.name);
    // Duplicate route domains are skipped; assert on the structural label which
    // retains the "<Domain> Management" grammar the dedup keys off.
    expect(labels).not.toContain('Order Management');
    expect(labels).not.toContain('Line Management');
    expect(labels).not.toContain('Line Item Management');
    expect(labels).toContain('Stock Management');
    expect(names).toContain('Stock');
  });

  it('suppresses terminal helper clusters that have no entity or entry-point evidence', async () => {
    const helperNode = (name: string, file: string): CASNode => ({
      id: `node_${name}`,
      name,
      type: 'function',
      source: { file },
      metadata: {},
    } as CASNode);
    const nodes = [
      { id: 'owner', name: 'AgentService', type: 'service', source: { file: 'src/agents/service.ts' }, metadata: {} } as CASNode,
      helperNode('bootstrapFiles', 'src/agents/bootstrap-files.ts'),
      helperNode('cleanPayload', 'src/agents/schema/clean-for-gemini.ts'),
      helperNode('collectTargets', 'src/channels/channel.ts'),
      helperNode('materializeArtifacts', 'src/operating-artifacts.ts'),
      helperNode('saveConfig', 'src/infra/json-file.ts'),
      helperNode('mergeAccountIds', 'src/accounts/store.ts'),
      helperNode('thinkingBudget', 'src/auto-reply/thinking.ts'),
      { id: 'order-service', name: 'OrderService', type: 'service', source: { file: 'src/orders/service.ts' }, metadata: {} } as CASNode,
    ];
    const edges: CASEdge[] = [
      { id: 'e1', source: 'owner', target: 'node_bootstrapFiles', type: 'calls' },
      { id: 'e2', source: 'owner', target: 'node_cleanPayload', type: 'calls' },
      { id: 'e3', source: 'owner', target: 'node_collectTargets', type: 'calls' },
      { id: 'e4', source: 'owner', target: 'node_materializeArtifacts', type: 'calls' },
      { id: 'e5', source: 'owner', target: 'node_saveConfig', type: 'calls' },
      { id: 'e6', source: 'owner', target: 'node_mergeAccountIds', type: 'calls' },
      { id: 'e7', source: 'owner', target: 'node_thinkingBudget', type: 'calls' },
      { id: 'e8', source: 'owner', target: 'order-service', type: 'calls' },
    ] as any;
    const orderEntity: CASDataEntity = {
      id: 'entity_order',
      name: 'Order',
      lifecycle: { created_by: ['order-service'], read_by: ['order-service'], updated_by: [], deleted_by: [] },
      fields: [],
      relationships: [],
    } as any;

    const capabilities = await orch.buildTerminalCapabilities([orderEntity], nodes, edges, new Set<string>());
    const labels = capabilities.map((capability: any) => capability.structural_label);
    const names = capabilities.map((capability: { name: string }) => capability.name);

    expect(labels).toContain('Order Management');
    expect(names).toContain('Order');
    // Helper clusters with no evidence never become capabilities — assert on the
    // structural label (retains the grammar the noise filter keys off).
    expect(labels).not.toContain('Bootstrap Management');
    expect(labels).not.toContain('Clean Management');
    expect(labels).not.toContain('Collect Management');
    expect(labels).not.toContain('Materialize Management');
    expect(labels).not.toContain('Save Management');
    expect(labels).not.toContain('Merge Management');
    expect(labels).not.toContain('Thinking Management');
  });
});

describe('evidence-driven security boundaries and summary', () => {
  const node = (partial: Partial<CASNode>): CASNode => ({
    id: partial.id || partial.name || 'node',
    name: partial.name || 'Node',
    type: partial.type || 'class',
    source: partial.source || { file: `src/${partial.name || 'node'}.ts`, line: 1 },
    metadata: partial.metadata || {},
    subcategories: partial.subcategories,
  } as CASNode);

  const httpEntry = (partial: any) => ({
    id: partial.id,
    source_node: partial.source_node || partial.id,
    type: 'http',
    name: partial.name || `${partial.method} ${partial.path}`,
    trigger: { method: partial.method, path: partial.path },
    security: partial.security,
    handler: partial.handler,
  });

  it('emits a tenant-isolation boundary only when tenant scoping evidence exists', async () => {
    const tenantNodes = [
      node({ id: 'tenant-scope', name: 'set_current_tenant', type: 'method' }),
      node({ id: 'org-scope', name: 'organization_scope', type: 'method' }),
    ];
    const withTenant = orch.buildSecurityBoundaries(tenantNodes, []);
    expect(withTenant.map((b: any) => b.boundary_type)).toContain('tenant-isolation');

    const withoutTenant = orch.buildSecurityBoundaries([
      node({ id: 'org-model', name: 'Organization', type: 'model' }),
    ], []);
    expect(withoutTenant.map((b: any) => b.boundary_type)).not.toContain('tenant-isolation');
  });

  it('does not treat Organization domain models as tenant isolation evidence', async () => {
    const boundaries = orch.buildSecurityBoundaries([
      node({ id: 'org', name: 'Organization', type: 'entity' }),
      node({ id: 'account', name: 'Account', type: 'model' }),
    ], []);
    expect(boundaries.map((b: any) => b.boundary_type)).not.toContain('tenant-isolation');
  });

  it('emits a rate-limiting boundary from throttle middleware evidence', async () => {
    const boundaries = orch.buildSecurityBoundaries([
      node({ id: 'throttle', name: 'RequestThrottleMiddleware', type: 'middleware' }),
    ], []);
    const rateBoundary = boundaries.find((b: any) => b.boundary_type === 'rate-limiting');
    expect(rateBoundary).toBeDefined();
    expect(rateBoundary.enforcement_points[0].confidence).toBe('enforced');
  });

  it('marks unresolved entry-point guards as assumed enforcement', async () => {
    const nodes = [node({ id: 'auth-guard', name: 'JwtAuthGuard', type: 'guard' })];
    const entryPoints = [
      httpEntry({
        id: 'ep1', method: 'POST', path: '/orders',
        security: { authenticated: true, guards: ['require_mystery_role'] },
      }),
    ];
    const boundaries = orch.buildSecurityBoundaries(nodes, entryPoints);
    const auth = boundaries.find((b: any) => b.boundary_type === 'authentication');
    const confidences = auth.enforcement_points.map((p: any) => p.confidence);
    expect(confidences).toContain('enforced');
    expect(confidences).toContain('assumed');
  });

  it('does not mark guards as assumed when they resolve to enforcement nodes', async () => {
    const nodes = [node({ id: 'auth-guard', name: 'JwtAuthGuard', type: 'guard' })];
    const entryPoints = [
      httpEntry({
        id: 'ep1', method: 'POST', path: '/orders',
        security: { authenticated: true, guards: ['JwtAuthGuard'] },
      }),
    ];
    const boundaries = orch.buildSecurityBoundaries(nodes, entryPoints);
    const auth = boundaries.find((b: any) => b.boundary_type === 'authentication');
    expect(auth.enforcement_points.every((p: any) => p.confidence === 'enforced')).toBe(true);
  });

  it('reports unguarded mutating entry points as missing enforcement and unprotected sensitive ops', async () => {
    const nodes = [node({ id: 'auth-guard', name: 'JwtAuthGuard', type: 'guard' })];
    const entryPoints = [
      httpEntry({ id: 'ep-protected', method: 'POST', path: '/orders', security: { authenticated: true } }),
      httpEntry({ id: 'ep-open', source_node: 'open-handler', method: 'DELETE', path: '/admin/users/{id}' }),
      httpEntry({ id: 'ep-read', source_node: 'read-handler', method: 'GET', path: '/orders' }),
    ];
    const boundaries = orch.buildSecurityBoundaries(nodes, entryPoints);
    const auth = boundaries.find((b: any) => b.boundary_type === 'authentication');
    expect(auth.enforcement_points.some((p: any) => p.confidence === 'missing')).toBe(true);

    const summary = orch.buildSecuritySummary(boundaries, nodes, entryPoints);
    expect(summary.unprotected_sensitive_ops).toEqual(['open-handler']);
    expect(summary.assumed_vs_enforced.missing).toBeGreaterThanOrEqual(1);
    expect(summary.assumed_vs_enforced.enforced).toBeGreaterThanOrEqual(1);
  });

  it('does not classify public auth bootstrap mutations as missing auth', async () => {
    const nodes = [node({ id: 'auth-guard', name: 'JwtAuthGuard', type: 'guard' })];
    const entryPoints = [
      httpEntry({ id: 'ep-login', source_node: 'login-handler', method: 'POST', path: '/auth/login' }),
      httpEntry({ id: 'ep-register', source_node: 'register-handler', method: 'POST', path: '/auth/register' }),
      httpEntry({ id: 'ep-sso', source_node: 'sso-handler', method: 'POST', path: '/auth/sso/discover' }),
      httpEntry({ id: 'ep-setup', source_node: 'setup-handler', method: 'POST', path: '/initial-setup' }),
      httpEntry({ id: 'ep-open', source_node: 'open-handler', method: 'POST', path: '/orders' }),
    ];

    const boundaries = orch.buildSecurityBoundaries(nodes, entryPoints);
    const auth = boundaries.find((b: any) => b.boundary_type === 'authentication');
    const missingMechanisms = auth.enforcement_points
      .filter((point: any) => point.confidence === 'missing')
      .map((point: any) => point.mechanism);
    expect(missingMechanisms).toEqual(['No authentication detected on sensitive operation POST /orders']);

    const summary = orch.buildSecuritySummary(boundaries, nodes, entryPoints);
    expect(summary.unprotected_sensitive_ops).toEqual(['open-handler']);
  });

  it('reports zero unprotected sensitive ops when every mutating entry is guarded', async () => {
    const nodes = [node({ id: 'auth-guard', name: 'JwtAuthGuard', type: 'guard' })];
    const entryPoints = [
      httpEntry({ id: 'ep1', method: 'POST', path: '/orders', security: { authenticated: true } }),
      httpEntry({ id: 'ep2', method: 'GET', path: '/orders' }),
    ];
    const boundaries = orch.buildSecurityBoundaries(nodes, entryPoints);
    const summary = orch.buildSecuritySummary(boundaries, nodes, entryPoints);
    expect(summary.unprotected_sensitive_ops).toEqual([]);
    expect(summary.assumed_vs_enforced.missing).toBe(0);
  });

  it('lifts a route behind auth middleware onto the boundary via the guards edge (the real route-surface bridge), while an unprotected route stays out', async () => {
    // Mirrors auth-analyzer.ts's actual output shape: a mechanism node, a
    // route/handler node it protects, and a `guards` edge (category
    // 'security') from mechanism -> route with `metadata.target_entry_point`
    // pointing at the entry point id — exactly what entry-point-security.ts
    // needs to join against `ep.handler.node_id`.
    const nodes = [
      node({ id: 'auth_passport_mechanism', name: 'Passport strategy', type: 'auth_strategy' as any }),
    ];
    const protectedEntry = httpEntry({
      id: 'entry_protected_route',
      source_node: 'protected_route_handler',
      method: 'GET',
      path: '/oauth/callback',
      handler: { node_id: 'protected_route_handler', method_name: 'GET /oauth/callback' },
    });
    const openEntry = httpEntry({
      id: 'entry_open_route',
      source_node: 'open_route_handler',
      method: 'GET',
      path: '/public/health',
      handler: { node_id: 'open_route_handler', method_name: 'GET /public/health' },
    });
    const edges = [
      {
        id: 'edge_guards_1',
        source: 'auth_passport_mechanism',
        target: 'protected_route_handler',
        type: 'guards',
        category: 'security',
        metadata: { library: 'passport', mechanism: 'Passport strategy', target_entry_point: 'entry_protected_route' },
      },
    ] as any;

    const boundaries = orch.buildSecurityBoundaries(nodes, [protectedEntry, openEntry], undefined, edges);
    const auth = boundaries.find((b: any) => b.boundary_type === 'authentication');
    const enforcementIds = auth.enforcement_points.map((p: any) => p.node_id);
    const enforcedIds = auth.enforcement_points
      .filter((p: any) => p.confidence === 'enforced')
      .map((p: any) => p.node_id);

    // The protected route's own handler node is now an enforcement point —
    // this is the join entry-point-security.ts matches on.
    expect(enforcedIds).toContain('protected_route_handler');
    // The unprotected route's handler was never touched by a guards edge or
    // an authenticated entry point, so it must never show up as protected.
    expect(enforcementIds).not.toContain('open_route_handler');

    const contexts = orch.buildSecurityContexts(nodes, [protectedEntry, openEntry], edges);
    const authContext = contexts.find((c: any) => c.id === 'security_ctx_authentication');
    expect(authContext.scope.node_ids).toContain('protected_route_handler');
    expect(authContext.scope.entry_points).toContain('entry_protected_route');
    expect(authContext.scope.node_ids).not.toContain('open_route_handler');
    expect(authContext.scope.entry_points).not.toContain('entry_open_route');
  });
});

describe('calibrated system health scoring', () => {
  const node = (partial: Partial<CASNode>): CASNode => ({
    id: partial.id || partial.name || 'node',
    name: partial.name || 'Node',
    type: partial.type || 'class',
    source: partial.source || { file: `src/${partial.name || 'node'}.ts`, line: 1 },
    metadata: partial.metadata || {},
  } as CASNode);

  const emptyArchitecture = { architectural_patterns: [], pattern_balance: undefined } as any;
  const healthyImplementation = {
    complete_implementations: 100, partial_implementations: 0, stubs: 0,
    not_implemented: 0, deprecated: 0, experimental: 0, health_score: 1, risk_areas: [],
  } as any;
  const emptyIdioms = { idioms: [], examples: [], violations: [], summary: {} } as any;
  const emptyRuntime = { instrumentation: { missing_runtime_coverage: [] } } as any;

  const buildHealth = (overrides: any = {}) => orch.buildSystemHealth(
    overrides.architecture || emptyArchitecture,
    overrides.implementation || healthyImplementation,
    overrides.changeRisk || { high_risk_nodes: [], untested_critical_paths: [], recent_hotspots: [] },
    overrides.idioms || emptyIdioms,
    overrides.nodes || [],
    overrides.callChains || [],
    overrides.runtime || emptyRuntime
  );

  it('scores a clean repo healthy', async () => {
    const health = buildHealth();
    expect(health.score).toBe(100);
    expect(health.status).toBe('healthy');
  });

  it('keeps a production repo with small bounded risks out of critical', async () => {
    const nodes = Array.from({ length: 500 }, (_, i) => node({ id: `n${i}`, name: `Node${i}` }));
    const complex = node({ id: 'hot', name: 'HotSpot', metadata: { complexity: { cyclomatic: 25 } } as any });
    const health = buildHealth({
      nodes: [...nodes, complex],
      changeRisk: {
        high_risk_nodes: Array.from({ length: 40 }, (_, i) => `risk${i}`),
        untested_critical_paths: ['risk0', 'risk1', 'risk2'],
        recent_hotspots: [],
      },
      runtime: { instrumentation: { missing_runtime_coverage: ['ep1', 'ep2', 'ep3'] } },
    });
    expect(health.status).not.toBe('critical');
    expect(health.score).toBeGreaterThanOrEqual(50);
  });

  it('penalizes extensive untested critical paths more than sparse ones', async () => {
    const sparse = buildHealth({
      changeRisk: {
        high_risk_nodes: Array.from({ length: 100 }, (_, i) => `r${i}`),
        untested_critical_paths: ['r0', 'r1'],
        recent_hotspots: [],
      },
    });
    const extensive = buildHealth({
      changeRisk: {
        high_risk_nodes: Array.from({ length: 100 }, (_, i) => `r${i}`),
        untested_critical_paths: Array.from({ length: 100 }, (_, i) => `r${i}`),
        recent_hotspots: [],
      },
    });
    expect(extensive.score).toBeLessThan(sparse.score);
  });

  it('weighs incomplete implementation by its measured ratio', async () => {
    const partial = buildHealth({
      implementation: {
        ...{ complete_implementations: 50, partial_implementations: 50, stubs: 0, not_implemented: 0, deprecated: 0, experimental: 0 },
        health_score: 0.5,
        risk_areas: [{ node_id: 'x', node_name: 'X', risk_type: 'incomplete', risk_level: 'high', recommendation: 'finish' }],
      },
    });
    const nearComplete = buildHealth({
      implementation: {
        ...{ complete_implementations: 95, partial_implementations: 5, stubs: 0, not_implemented: 0, deprecated: 0, experimental: 0 },
        health_score: 0.95,
        risk_areas: [{ node_id: 'x', node_name: 'X', risk_type: 'incomplete', risk_level: 'high', recommendation: 'finish' }],
      },
    });
    expect(partial.score).toBeLessThan(nearComplete.score);
  });

  it('treats missing runtime telemetry as informational, not health-defining', async () => {
    const health = buildHealth({
      runtime: { instrumentation: { missing_runtime_coverage: Array.from({ length: 100 }, (_, i) => `ep${i}`) } },
    });
    expect(health.score).toBeGreaterThanOrEqual(95);
  });
});

describe('language builtin exit-point exclusion from external services', () => {
  it('drops PHP builtin External call exits from external services', async () => {
    const services = orch.buildExternalServices([], [
      exitPoint({ id: 'arr-filter', type: 'sdk', name: 'External call: array_filter' }),
      exitPoint({ id: 'arr-map', type: 'sdk', name: 'External call: array_map' }),
      exitPoint({ id: 'isset', type: 'sdk', name: 'External call: isset' }),
      exitPoint({ id: 'io', type: 'sdk', name: 'io', target: { sdk: 'io' } }),
      exitPoint({ id: 'stripe', type: 'sdk', name: 'Stripe', target: { sdk: 'Stripe' } }),
    ], []);
    expect(services.map((service: any) => service.name)).toEqual(['Stripe']);
  });
});

describe('content-management domain anchor (inferSystemPurpose)', () => {
  const entity = (name: string): CASDataEntity => ({
    id: `entity_${name.toLowerCase()}`,
    name,
    lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] },
  } as CASDataEntity);

  const httpEntry = (id: string, pathValue: string) => ({
    id,
    type: 'http',
    name: `GET ${pathValue}`,
    source_node: undefined,
    trigger: { method: 'GET', path: pathValue },
  });

  const capability = (name: string) => ({
    id: `cap_${name.toLowerCase().replace(/\s+/g, '_')}`,
    name,
    category: 'core',
    operations: [],
  });

  it('classifies a page-tree CMS with revision and publishing vocabulary as content-management', async () => {
    const purpose = await orch.inferSystemPurpose(
      [
        httpEntry('e1', '/pages/1/unpublish/'),
        httpEntry('e2', '/pages/1/revisions/'),
        httpEntry('e3', '/pages/1/edit/preview/'),
        httpEntry('e4', '/pages/1/view_draft/'),
        httpEntry('e5', '/pages/workflow/preview/1/2/'),
      ],
      [
        entity('Page'), entity('Revision'), entity('Document'), entity('Rendition'),
        entity('Collection'), entity('Redirect'), entity('Locale'), entity('Site'),
        entity('Workflow'), entity('Task'), entity('TaskState'), entity('WorkflowState'),
      ],
      [
        capability('Revision Management'), capability('Document Management'),
        capability('Task Management'), capability('Image Management'),
      ],
      []
    );
    expect(purpose.primary_type).toBe('content-management');
    expect(purpose.confidence).toBeGreaterThanOrEqual(0.8);
    expect(purpose.evidence.join(' ')).toContain('revision');
  });

  it('does not classify a workflow engine without content entities as content-management', async () => {
    const purpose = await orch.inferSystemPurpose(
      [
        httpEntry('e1', '/workflows/1/approve/'),
        httpEntry('e2', '/tasks/1/submit/'),
      ],
      [entity('Workflow'), entity('Task'), entity('Approval'), entity('Assignee')],
      [capability('Task Management'), capability('Workflow Management')],
      []
    );
    expect(purpose.primary_type).not.toBe('content-management');
  });

  it('does not classify a commerce system without revision vocabulary as content-management', async () => {
    const purpose = await orch.inferSystemPurpose(
      [
        httpEntry('e1', '/cart'),
        httpEntry('e2', '/checkout'),
        httpEntry('e3', '/orders/1'),
      ],
      [entity('Order'), entity('Cart'), entity('Payment'), entity('Product'), entity('Customer'), entity('Site'), entity('Page')],
      [capability('Checkout Management'), capability('Cart Management')],
      []
    );
    expect(purpose.primary_type).not.toBe('content-management');
  });

});

describe('extractProjectTextSignal: bulk content corpora do not feed domain evidence', () => {
  it('ignores fleet vocabulary inside content/*.md articles of a learning platform', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-content-corpus-'));
    try {
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'knowledgebase' }));
      fs.mkdirSync(path.join(root, 'content/automotive-security'), { recursive: true });
      fs.writeFileSync(path.join(root, 'content/automotive-security/fleet-telematics.md'), [
        '# Fleet Telematics Security',
        'Fleet management systems track vehicles and drivers through telematics units.',
        'Attackers target dispatch servers, vehicle gateways, and driver apps across commercial vehicle fleets.',
      ].join('\n'));
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      fs.writeFileSync(path.join(root, 'src/deviceManager.ts'), [
        'export const messages = [',
        '  "Install the audio driver to continue",',
        '  "The display driver was updated successfully",',
        '  "Roll back the network driver from device manager",',
        '];',
      ].join('\n'));

      const signal = orch.extractProjectTextSignal(root);

      expect(signal.primaryDomain).not.toBe('fleet-management');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('vendor-lib terminal capabilities require product evidence', () => {
  const vendorNode = (partial: Partial<CASNode>): CASNode => ({
    id: partial.id || partial.name || 'node',
    name: partial.name || 'Node',
    type: partial.type || 'service',
    source: partial.source || { file: `src/${partial.name || 'node'}.rs`, line: 1 },
    metadata: partial.metadata || {},
  } as CASNode);

  it('drops an evidence-free Jito Capability seeded from a vendor SDK wrapper', async () => {
    const nodes: CASNode[] = [
      vendorNode({ id: 'jito-service', name: 'JitoService', type: 'service', source: { file: 'src/jito.rs' } }),
      vendorNode({ id: 'caller', name: 'BotRunnerHelper', type: 'class', source: { file: 'src/runner.rs' } }),
    ];
    const edges: CASEdge[] = [
      { id: 'e1', source: 'caller', target: 'jito-service', type: 'calls' },
    ] as CASEdge[];

    const capabilities = await orch.buildTerminalCapabilities([], nodes, edges, new Set<string>());
    const labels = capabilities.map((capability: any) => capability.structural_label);
    // The vendor-SDK drop keys off the "Capability" structural label; assert it
    // never survives as a capability at all.
    expect(labels).not.toContain('Jito Capability');
  });

  it('keeps vendor-token capabilities that carry product evidence', async () => {
    const entity: CASDataEntity = {
      id: 'entity_jito_bundle',
      name: 'JitoBundle',
      lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] },
    } as CASDataEntity;

    const capabilities = await orch.buildTerminalCapabilities([entity], [], [], new Set<string>());
    const labels = capabilities.map((capability: any) => capability.structural_label);
    const names = capabilities.map((capability: { name: string }) => capability.name);
    expect(labels).toContain('Jito Bundle Management');
    expect(names).toContain('Jito Bundle');
  });

  it('keeps non-vendor evidence-free capabilities untouched', async () => {
    const nodes: CASNode[] = [
      vendorNode({ id: 'pricing-service', name: 'PricingService', type: 'service', source: { file: 'src/pricing.rs' } }),
      vendorNode({ id: 'caller2', name: 'BotRunnerHelper', type: 'class', source: { file: 'src/runner.rs' } }),
    ];
    const edges: CASEdge[] = [
      { id: 'e1', source: 'caller2', target: 'pricing-service', type: 'calls' },
    ] as CASEdge[];

    const capabilities = await orch.buildTerminalCapabilities([], nodes, edges, new Set<string>());
    const names = capabilities.map((capability: { name: string }) => capability.name);
    expect(names.some((name: string) => name.startsWith('Pricing'))).toBe(true);
  });

  it('drops terminal single-token leftovers already covered by composed capabilities', async () => {
    const nodes: CASNode[] = [
      vendorNode({ id: 'balance-service', name: 'BalanceService', type: 'service', source: { file: 'src/balance.ts' } }),
      vendorNode({ id: 'balance-caller', name: 'TokenBalanceDiscovery', type: 'service', source: { file: 'src/token-balance.ts' } }),
    ];
    const edges: CASEdge[] = [
      { id: 'e1', source: 'balance-caller', target: 'balance-service', type: 'calls' },
    ] as CASEdge[];

    const capabilities = await orch.buildTerminalCapabilities([], nodes, edges, new Set<string>(['token-balance']));
    const names = capabilities.map((capability: { name: string }) => capability.name);
    expect(names).not.toContain('Balance Capability');
  });

  it('drops entrypoint single-token leftovers already covered by composed capabilities', async () => {
    const covered = {
      name: 'Token Balance Discovery',
      related_domains: ['token-balance'],
      operations: [{ entry_point_id: 'entry-token-balance', entry_point_type: 'file', action: 'Process' }],
    };
    const redundant = {
      name: 'Balance Capability',
      related_domains: ['balance'],
      operations: [{ entry_point_id: 'entry-balance', entry_point_type: 'file', action: 'Process' }],
    };

    expect(orch.isRedundantCoveredCapability(redundant, [covered, redundant])).toBe(true);
    expect(orch.isRedundantCoveredCapability(covered, [covered, redundant])).toBe(false);
  });
});

describe('linkRouteHandlers: handlerCallCandidates fallback for inline registration handlers', () => {
  // Registration-style entry points (MCP tool registration, decorators, etc.)
  // frequently wrap their real logic in an inline arrow/function, so
  // `handler.method_name` has nothing to exact/fuzzy match against. The
  // analyzer that owns the callsite can still surface candidate callee names
  // scraped from the handler body (`ep.metadata.handlerCallCandidates`);
  // linkRouteHandlers should resolve those against real function/method nodes
  // and emit a `calls` edge — but only when the candidate resolves uniquely.

  function functionNode(id: string, name: string, file: string): CASNode {
    return {
      id,
      name,
      type: 'function',
      source: { file, line: 1, end_line: 1 },
    } as unknown as CASNode;
  }

  it('links an entry point to the function named in handlerCallCandidates when no direct handler match exists', async () => {
    const nodes: CASNode[] = [
      { id: 'entry_mcp_tool_get_summary', name: 'get_summary', type: 'mcp_tool', source: { file: 'src/server.ts', line: 10, end_line: 10 } } as unknown as CASNode,
      functionNode('fn_buildSummary', 'buildSummary', 'src/query.ts'),
    ];
    const edges: CASEdge[] = [];
    const entryPoints = [{
      id: 'entry_1',
      name: 'get_summary',
      type: 'message',
      source_node: 'entry_mcp_tool_get_summary',
      source_analyzer: 'mcp-tool-registration',
      trigger: { method: 'registerTool', path: 'get_summary' },
      handler: { node_id: 'entry_mcp_tool_get_summary', method_name: 'get_summary', file: 'src/server.ts' },
      metadata: {
        registrationKind: 'registerTool',
        receiver: 'server',
        file: 'src/server.ts',
        line: 10,
        handlerCallCandidates: ['query.buildSummary', 'buildSummary'],
      },
    }] as any;

    orch.linkRouteHandlers(nodes, edges, entryPoints);

    const edge = edges.find(e => e.target === 'fn_buildSummary');
    expect(edge).toBeTruthy();
    expect(edge!.source).toBe('entry_mcp_tool_get_summary');
    expect(edge!.type).toBe('calls');
    expect((edge!.metadata as any)?.attributes?.resolution).toBe('handler_call_candidate');
  });

  it('does not fabricate an edge when a candidate name is ambiguous across multiple functions', async () => {
    const nodes: CASNode[] = [
      { id: 'entry_mcp_tool_do_thing', name: 'do_thing', type: 'mcp_tool', source: { file: 'src/server.ts', line: 20, end_line: 20 } } as unknown as CASNode,
      functionNode('fn_helper_a', 'helper', 'src/a.ts'),
      functionNode('fn_helper_b', 'helper', 'src/b.ts'),
    ];
    const edges: CASEdge[] = [];
    const entryPoints = [{
      id: 'entry_2',
      name: 'do_thing',
      type: 'message',
      source_node: 'entry_mcp_tool_do_thing',
      source_analyzer: 'mcp-tool-registration',
      trigger: { method: 'registerTool', path: 'do_thing' },
      handler: { node_id: 'entry_mcp_tool_do_thing', method_name: 'do_thing', file: 'src/server.ts' },
      metadata: {
        registrationKind: 'registerTool',
        receiver: 'server',
        file: 'src/server.ts',
        line: 20,
        handlerCallCandidates: ['helper'],
      },
    }] as any;

    orch.linkRouteHandlers(nodes, edges, entryPoints);

    expect(edges.length).toBe(0);
  });

  it('does not add an edge when handlerCallCandidates is absent (no fabrication without evidence)', async () => {
    const nodes: CASNode[] = [
      { id: 'entry_mcp_tool_unresolvable', name: 'unresolvable', type: 'mcp_tool', source: { file: 'src/server.ts', line: 30, end_line: 30 } } as unknown as CASNode,
      functionNode('fn_unrelated', 'unrelated', 'src/z.ts'),
    ];
    const edges: CASEdge[] = [];
    const entryPoints = [{
      id: 'entry_3',
      name: 'unresolvable',
      type: 'message',
      source_node: 'entry_mcp_tool_unresolvable',
      source_analyzer: 'mcp-tool-registration',
      trigger: { method: 'registerTool', path: 'unresolvable' },
      handler: { node_id: 'entry_mcp_tool_unresolvable', method_name: 'unresolvable', file: 'src/server.ts' },
      metadata: {
        registrationKind: 'registerTool',
        receiver: 'server',
        file: 'src/server.ts',
        line: 30,
      },
    }] as any;

    orch.linkRouteHandlers(nodes, edges, entryPoints);

    expect(edges.length).toBe(0);
  });
});

describe('orchestrator technologies.languages[].files (real file count, not AST-node count)', () => {
  // Regression test for the bug where `files` reported result.nodes.length
  // (an AST-node count) mislabeled as a file count, overstating real file
  // counts by 5.9x-15.7x on every analyzed repo.

  function nodeInFile(id: string, file: string): CASNode {
    return { id, name: id, type: 'function', source: { file, line: 1, end_line: 2 } } as unknown as CASNode;
  }

  it('countDistinctSourceFiles dedupes many nodes down to the real file count', async () => {
    // 3 files, but 12 nodes total (4 nodes per file) - files must be 3, not 12.
    const nodes: CASNode[] = [
      nodeInFile('n1', 'src/a.ts'), nodeInFile('n2', 'src/a.ts'), nodeInFile('n3', 'src/a.ts'), nodeInFile('n4', 'src/a.ts'),
      nodeInFile('n5', 'src/b.ts'), nodeInFile('n6', 'src/b.ts'), nodeInFile('n7', 'src/b.ts'), nodeInFile('n8', 'src/b.ts'),
      nodeInFile('n9', 'src/c.ts'), nodeInFile('n10', 'src/c.ts'), nodeInFile('n11', 'src/c.ts'), nodeInFile('n12', 'src/c.ts'),
    ];

    expect(orch.countDistinctSourceFiles(nodes)).toBe(3);
    expect(nodes.length).toBe(12);
  });

  it('ignores nodes without a source file rather than fabricating a count for them', async () => {
    const nodes: CASNode[] = [
      nodeInFile('n1', 'src/a.ts'),
      { id: 'n2', name: 'synthetic', type: 'function' } as unknown as CASNode, // no source.file
    ];
    expect(orch.countDistinctSourceFiles(nodes)).toBe(1);
  });

  it('returns 0 for an empty or undefined node list', async () => {
    expect(orch.countDistinctSourceFiles([])).toBe(0);
    expect(orch.countDistinctSourceFiles(undefined)).toBe(0);
  });

  it('extractTechnologies reports files_created (distinct files), not nodes_created (AST nodes)', async () => {
    // Simulates a language contribution with 100 AST nodes spread across 7 files.
    const contributions = [{
      analyzer_id: 'typescript-javascript',
      analyzer_name: 'TypeScript/JavaScript Analyzer',
      analyzer_type: 'language',
      contribution_type: 'language',
      nodes_created: 100,
      files_created: 7,
      edges_created: 0,
    }];

    const result = orch.extractTechnologies(contributions, []);

    expect(result.languages).toHaveLength(1);
    expect(result.languages[0].name).toBe('TypeScript/JavaScript');
    expect(result.languages[0].files).toBe(7);
    expect(result.languages[0].files).not.toBe(100);
  });

  it('falls back to nodes_created only when files_created is absent (legacy-contribution safety net)', async () => {
    const contributions = [{
      analyzer_id: 'legacy',
      analyzer_name: 'Legacy Analyzer',
      analyzer_type: 'language',
      contribution_type: 'language',
      nodes_created: 42,
      edges_created: 0,
    }];

    const result = orch.extractTechnologies(contributions, []);
    expect(result.languages[0].files).toBe(42);
  });
});

// Regression coverage for the 2026-07-04 references-idshapes bug: react-analyzer.ts's
// analyzeUtils/extractUtils emits a `*_util` node (via generateNodeId('util', ...)) for
// EVERY FunctionDeclaration/VariableDeclarator in any file whose path merely looks
// util-ish (/services/, /api/, .util., .service., ...), completely independent of
// typescript-javascript-analyzer.ts's own canonical node for the same declaration. The
// two nodes have different ID SHAPES and react-analyzer.ts's node carries an ABSOLUTE
// source.file (built via path.join(projectPath, file)) while the TS analyzer's node
// carries a workspace-RELATIVE source.file — so a naive (file, name) key would miss the
// match too. Real-world symptom: get_callers on an exported const in a service/util file
// (e.g. API_CONFIG in ui/src/services/api.config.ts) returned 0 consumers when a caller
// happened to land on the util-shaped duplicate, even though the TS-analyzer's real node
// for the same declaration had the correct incoming reference edges all along.
describe('orchestrator dedupeUtilNodeDuplicates (2026-07-04 references-idshapes)', () => {
  function node(partial: Partial<CASNode>): CASNode {
    return {
      id: partial.id || 'node_1',
      name: partial.name || 'thing',
      type: partial.type || 'variable',
      source: partial.source,
      ...partial,
    } as CASNode;
  }

  it('drops a util-shaped duplicate node and redirects its edges onto the canonical node, matching across absolute vs relative source.file', async () => {
    const canonical = node({
      id: 'variable_src_services_api_config_ts_API_CONFIG_0',
      name: 'API_CONFIG',
      type: 'variable',
      source: { file: 'src/services/api.config.ts', line: 1 },
    });
    const utilDup = node({
      id: 'util_src_services_api_config_ts_API_CONFIG_6b657974',
      name: 'API_CONFIG',
      type: 'constant_util',
      // react-analyzer.ts's real-world shape: ABSOLUTE path with a project-root prefix.
      source: { file: '/Users/dev/project/ui/src/services/api.config.ts', line: 1 },
    });
    const consumerCallsUtil: CASEdge = {
      id: 'reference_consumer_util',
      source: 'method_consumer_0',
      target: utilDup.id,
      type: 'references',
    } as CASEdge;

    const nodes = [canonical, utilDup];
    const edges = [consumerCallsUtil];

    orch.dedupeUtilNodeDuplicates(nodes, edges);

    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe(canonical.id);
    // The edge that used to target the dropped util node must be redirected onto the
    // canonical node — evidence is preserved, not dropped.
    expect(edges[0].target).toBe(canonical.id);
  });

  it('leaves distinct util nodes for genuinely different declarations untouched', async () => {
    const a = node({ id: 'variable_a', name: 'FOO', source: { file: 'src/a.ts' } });
    const b = node({
      id: 'util_b',
      name: 'BAR',
      type: 'function_util',
      source: { file: '/abs/project/src/b.ts' },
    });
    const nodes = [a, b];
    const edges: CASEdge[] = [];

    orch.dedupeUtilNodeDuplicates(nodes, edges);

    expect(nodes).toHaveLength(2);
    expect(nodes.map((n: CASNode) => n.id).sort()).toEqual(['util_b', 'variable_a']);
  });

  it('collapses two util-only nodes for the same (file, name) with no canonical twin, keeping the first as survivor', async () => {
    const utilA = node({
      id: 'util_first',
      name: 'HELPER',
      type: 'function_util',
      source: { file: 'src/helpers.ts' },
    });
    const utilB = node({
      id: 'util_second',
      name: 'HELPER',
      type: 'function_util',
      source: { file: '/abs/project/src/helpers.ts' },
    });
    const edgeIntoSecond: CASEdge = {
      id: 'edge_1',
      source: 'caller_1',
      target: utilB.id,
      type: 'references',
    } as CASEdge;

    const nodes = [utilA, utilB];
    const edges = [edgeIntoSecond];

    orch.dedupeUtilNodeDuplicates(nodes, edges);

    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe(utilA.id);
    expect(edges[0].target).toBe(utilA.id);
  });
});

describe('orchestrator resolveNodeTwins (task #27: analyzer twin nodes/entries)', () => {
  function node(partial: Partial<CASNode>): CASNode {
    return {
      id: partial.id || 'node_1',
      name: partial.name || 'thing',
      type: partial.type || 'variable',
      source: partial.source,
      ...partial,
    } as CASNode;
  }

  it('merges an Angular-twin method and a TS-twin method for the SAME class+method, reunifying the exit point and the calls edge onto ONE node', () => {
    // Angular analyzer's own id scheme (generateId('method', file, `${service}_${method}`)).
    const angularService = node({
      id: 'service_ui_src_fuel_fuel_service_ts_FuelService_a1b2c3d4',
      name: 'FuelService',
      type: 'angular_service',
      source: { file: 'ui/src/fuel/fuel.service.ts', line: 1 },
    });
    const angularMethod = node({
      id: 'method_ui_src_fuel_fuel_service_ts_FuelService_getFuelStationsArray_e5f6a7b8',
      name: 'getFuelStationsArray',
      type: 'method',
      parent: angularService.id,
      source: { file: 'ui/src/fuel/fuel.service.ts', line: 1 },
    });
    // TS analyzer's independent id scheme (method_${classId}_${name}_${index}).
    const tsClass = node({
      id: 'class_ui_src_fuel_fuel_service_ts_FuelService_0',
      name: 'FuelService',
      type: 'class',
      source: { file: 'ui/src/fuel/fuel.service.ts', line: 1 },
    });
    const tsMethod = node({
      id: 'method_class_ui_src_fuel_fuel_service_ts_FuelService_0_getFuelStationsArray_3',
      name: 'getFuelStationsArray',
      type: 'method',
      parent: tsClass.id,
      source: { file: 'ui/src/fuel/fuel.service.ts', line: 42 },
    });

    const nodes = [angularService, angularMethod, tsClass, tsMethod];
    // DI `calls` edges land on the TS twin (8983dff7).
    const callsEdge: CASEdge = {
      id: 'injection_caller_0_ts_method',
      source: 'caller_0',
      target: tsMethod.id,
      type: 'calls',
    } as CASEdge;
    const edges = [callsEdge];
    // The per-call API exit point hangs off the ANGULAR twin (9d4181bb).
    const exitPoints: CASExitPoint[] = [
      exitPoint({ id: 'exit_1', source_node: angularMethod.id, type: 'api' as any }),
    ];
    const entryPoints: CASEntryPoint[] = [];

    orch.resolveNodeTwins(nodes, edges, entryPoints, exitPoints);

    // Both container twins AND both method twins collapse to one node each.
    expect(nodes.filter((n: CASNode) => n.type === 'method')).toHaveLength(1);
    expect(nodes.filter((n: CASNode) => n.type === 'class' || n.type === 'angular_service')).toHaveLength(1);

    const survivingMethod = nodes.find((n: CASNode) => n.type === 'method')!;
    // The survivor is the twin that owned the calls edge (the TS twin) —
    // flow tracing follows calls edges, so it must win.
    expect(survivingMethod.id).toBe(tsMethod.id);
    // The exit point that used to hang off the angular twin now hangs off
    // the SAME node the calls edge targets.
    expect(exitPoints[0].source_node).toBe(survivingMethod.id);
    expect(callsEdge.target).toBe(survivingMethod.id);
  });

  it('does NOT merge two methods with the same name in genuinely different classes (identity requires file+class+member, not name alone)', () => {
    const classA = node({ id: 'class_a', name: 'FuelService', type: 'class', source: { file: 'src/a/fuel.service.ts' } });
    const methodA = node({ id: 'method_a', name: 'getFuelStationsArray', type: 'method', parent: classA.id, source: { file: 'src/a/fuel.service.ts' } });
    const classB = node({ id: 'class_b', name: 'FuelService', type: 'class', source: { file: 'src/b/fuel.service.ts' } });
    const methodB = node({ id: 'method_b', name: 'getFuelStationsArray', type: 'method', parent: classB.id, source: { file: 'src/b/fuel.service.ts' } });

    const nodes = [classA, methodA, classB, methodB];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    orch.resolveNodeTwins(nodes, edges, entryPoints, exitPoints);

    expect(nodes).toHaveLength(4);
  });

  it('does NOT merge two methods with different names in the same class+file', () => {
    const cls = node({ id: 'class_a', name: 'FuelService', type: 'class', source: { file: 'src/fuel.service.ts' } });
    const m1 = node({ id: 'method_a', name: 'getFuelStationsArray', type: 'method', parent: cls.id, source: { file: 'src/fuel.service.ts' } });
    const m2 = node({ id: 'method_b', name: 'getFuelPrices', type: 'method', parent: cls.id, source: { file: 'src/fuel.service.ts' } });

    const nodes = [cls, m1, m2];
    const edges: CASEdge[] = [];

    orch.resolveNodeTwins(nodes, edges, [], []);

    expect(nodes).toHaveLength(3);
  });
});

describe('orchestrator dedupeEntryPointTwins (task #27: entry-point twins)', () => {
  it('collapses a php-analyzer generic-class CLI entry and a symfony-analyzer command CLI entry for the SAME (now-unified) source_node, keeping the richer record', () => {
    // After resolveNodeTwins unifies the php-analyzer `class` node and the
    // symfony-analyzer `command` node for the same class, both twin entry
    // points share one source_node.
    const sharedSourceNode = 'command_survivor_0';
    const entryA: CASEntryPoint = {
      id: 'entry_cli_class_id',
      source_node: sharedSourceNode,
      type: 'cli',
      name: 'Console command: ImportOrdersCommand',
      trigger: { pattern: 'app:import-orders' },
      metadata: { framework: 'symfony', kind: 'command' },
    } as CASEntryPoint;
    const entryB: CASEntryPoint = {
      id: 'entry_cli_app_import_orders',
      source_node: sharedSourceNode,
      type: 'cli',
      name: 'bin/console app:import-orders',
      description: 'Console command: app:import-orders',
      trigger: { pattern: 'app:import-orders' },
      handler: { node_id: 'method_execute_0', method_name: 'execute' },
      metadata: { command_name: 'app:import-orders' },
    } as CASEntryPoint;

    const entryPoints = [entryA, entryB];
    orch.dedupeEntryPointTwins(entryPoints);

    expect(entryPoints).toHaveLength(1);
    // The richer record (resolved handler + description) survives.
    expect(entryPoints[0].handler?.node_id).toBe('method_execute_0');
    // Evidence from the dropped twin (framework/kind attributes) is folded in.
    expect(entryPoints[0].metadata?.framework).toBe('symfony');
    expect(entryPoints[0].metadata?.command_name).toBe('app:import-orders');
  });

  it('keeps two entries for the same source_node when they are genuinely different triggers (e.g. a subscriber handling two distinct events)', () => {
    const shared = 'event_subscriber_0';
    const entryA: CASEntryPoint = {
      id: 'entry_event_a',
      source_node: shared,
      type: 'event',
      name: 'Event: order.created',
      trigger: { event: 'order.created' },
    } as CASEntryPoint;
    const entryB: CASEntryPoint = {
      id: 'entry_event_b',
      source_node: shared,
      type: 'event',
      name: 'Event: order.cancelled',
      trigger: { event: 'order.cancelled' },
    } as CASEntryPoint;

    const entryPoints = [entryA, entryB];
    orch.dedupeEntryPointTwins(entryPoints);

    expect(entryPoints).toHaveLength(2);
  });
});

describe('entity-extraction gaps from real-repo onboarding (mtg/openclaw/hercules)', () => {
  const node = (partial: Partial<CASNode>): CASNode => ({
    id: partial.id || partial.name || 'node',
    name: partial.name || 'Node',
    type: partial.type || 'class',
    source: partial.source || { file: `src/${partial.name || 'node'}.ts`, line: 1 },
    metadata: partial.metadata || {},
    subcategories: partial.subcategories,
    parent: partial.parent,
    signature: partial.signature,
  } as CASNode);

  describe('bundled-frontend roots require a product outside them (mtg gap)', () => {
    let root: string;

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-bundled-frontend-'));
    });

    afterEach(() => {
      fs.rmSync(root, { recursive: true, force: true });
      orch.bundledFrontendRootsCache.clear();
    });

    const writeFrontendManifest = (dir: string) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name: 'webapp',
        dependencies: { react: '^18.0.0', next: '^14.0.0' },
      }));
    };

    it('does not exclude the frontend dir when it IS the whole product (docs-only root)', async () => {
      writeFrontendManifest(path.join(root, 'app'));
      fs.writeFileSync(path.join(root, 'README.md'), '# docs only');

      expect(orch.getBundledFrontendRoots(root)).toEqual([]);
      // The Prisma schema inside the app must therefore stay a primary product path.
      expect(orch.isPrimaryProductPathForProject('app/prisma/schema.prisma', root)).toBe(true);
    });

    it('still excludes a frontend dir bundled into a root-manifest product', async () => {
      writeFrontendManifest(path.join(root, 'web'));
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'backend', dependencies: { express: '^4.0.0' } }));

      expect(orch.getBundledFrontendRoots(root)).toEqual([path.join(root, 'web')]);
    });

    it('still excludes a frontend dir when a sibling backend package exists', async () => {
      writeFrontendManifest(path.join(root, 'web'));
      fs.mkdirSync(path.join(root, 'server'), { recursive: true });
      fs.writeFileSync(path.join(root, 'server', 'go.mod'), 'module example.com/server');

      expect(orch.getBundledFrontendRoots(root)).toEqual([path.join(root, 'web')]);
    });
  });

  it('surfaces Prisma schema models as persisted data entities with analyzer-parsed fields', async () => {
    const nodes: CASNode[] = [
      node({
        id: 'entity_prisma_deck',
        name: 'Deck',
        type: 'entity',
        source: { file: 'app/prisma/schema.prisma', line: 1 },
        metadata: {
          attributes: {
            orm: 'Prisma',
            source: 'prisma_schema',
            fields: [
              { name: 'id', type: 'String', primary: true },
              { name: 'name', type: 'String' },
              { name: 'ownerId', type: 'String' },
            ],
          },
        },
        subcategories: ['entity', 'prisma'],
      }),
    ];

    const entities = orch.buildDataEntities(nodes, []);
    expect(entities).toHaveLength(1);
    expect(entities[0].name).toBe('Deck');
    expect(entities[0].kind).toBe('persisted-entity');
    expect((entities[0].fields || []).map((field: any) => field.name)).toEqual(['id', 'name', 'ownerId']);
  });

  it('surfaces a hand-rolled POCO domain entity (C# DAL, capitalized Entities namespace, property-dominant) — real Hoggan ERD gap', () => {
    // REGRESSION (real Hoggan C# CAS, v1.0.85): /entities returned 0 despite 18
    // POCO classes in `hoggan.DAL.Entities` (Patient, Protocols, ...). The gate
    // matched a case-SENSITIVE '/entities/' path literal and never read the
    // namespace, so C#'s conventional capitalized `Entities` folder was missed.
    const nodes: CASNode[] = [
      node({
        id: 'class_hoggan_dal_entities_protocols', name: 'Protocols', type: 'class',
        source: { file: 'hoggan.DAL/Entities/Protocols.cs', line: 1 },
        metadata: { attributes: { namespace: 'hoggan.DAL.Entities', propertyCount: 2, methodCount: 0 } },
      }),
      node({ id: 'prop_id', name: 'Id', type: 'property', parent: 'class_hoggan_dal_entities_protocols', source: { file: 'hoggan.DAL/Entities/Protocols.cs', line: 2 } }),
      node({ id: 'prop_name', name: 'Name', type: 'property', parent: 'class_hoggan_dal_entities_protocols', source: { file: 'hoggan.DAL/Entities/Protocols.cs', line: 3 } }),
      // GUARD 1 (wrong location): a Service in a non-entity namespace must NOT be an entity.
      node({
        id: 'class_hoggan_bll_patientservice', name: 'PatientService', type: 'class',
        source: { file: 'hoggan.BLL/Services/PatientService.cs', line: 1 },
        metadata: { attributes: { namespace: 'hoggan.BLL.Services', propertyCount: 0, methodCount: 8 } },
      }),
      // GUARD 2 (right location, wrong shape): a method-dominant helper IN the
      // Entities namespace must NOT be an entity (behavior, not data).
      node({
        id: 'class_hoggan_dal_entities_protocolbuilder', name: 'ProtocolBuilder', type: 'class',
        source: { file: 'hoggan.DAL/Entities/ProtocolBuilder.cs', line: 1 },
        metadata: { attributes: { namespace: 'hoggan.DAL.Entities', propertyCount: 1, methodCount: 9 } },
      }),
    ];
    const entities = orch.buildDataEntities(nodes, []);
    const names = entities.map((e: any) => e.name);
    expect(names).toContain('Protocols');
    expect(names).not.toContain('PatientService');
    expect(names).not.toContain('ProtocolBuilder');
    const protocols = entities.find((e: any) => e.name === 'Protocols');
    expect((protocols.fields || []).map((f: any) => f.name)).toEqual(expect.arrayContaining(['Id', 'Name']));
  });

  it('surfaces a plain Go struct in internal/model as a domain data entity with fields (real miniflux gap)', () => {
    // REGRESSION (real miniflux CAS): database_entities was [] despite 339 Go
    // struct nodes, because Go has no class/decorator ORM convention — a
    // domain record is `type Feed struct { ID int64; UserID int64; Title
    // string }` in internal/model/feed.go, and every entity gate only
    // recognized 'entity'/'model' node types, /entities/ path classes, or
    // isPocoEntityClassNode (type === 'class' only). 'struct' never qualified.
    const nodes: CASNode[] = [
      node({
        id: 'struct_model_feed', name: 'Feed', type: 'struct',
        source: { file: 'internal/model/feed.go', line: 10 },
        metadata: { language: 'go', attributes: { packageName: 'model', fieldCount: 3, methodCount: 0 } },
      }),
      node({ id: 'field_struct_model_feed_id', name: 'ID', type: 'field', parent: 'struct_model_feed', source: { file: 'internal/model/feed.go', line: 11 }, metadata: { attributes: { type: 'int64' } } }),
      node({ id: 'field_struct_model_feed_userid', name: 'UserID', type: 'field', parent: 'struct_model_feed', source: { file: 'internal/model/feed.go', line: 12 }, metadata: { attributes: { type: 'int64' } } }),
      node({ id: 'field_struct_model_feed_title', name: 'Title', type: 'field', parent: 'struct_model_feed', source: { file: 'internal/model/feed.go', line: 13 }, metadata: { attributes: { type: 'string' } } }),
      // GUARD 1 (wrong location): a struct in a handler package must NOT be an entity,
      // even though it has fields and no methods (e.g. a request/response wrapper
      // struct local to a handler file).
      node({
        id: 'struct_ui_loginform', name: 'loginForm', type: 'struct',
        source: { file: 'internal/ui/handler.go', line: 40 },
        metadata: { language: 'go', attributes: { packageName: 'ui', fieldCount: 2, methodCount: 0 } },
      }),
      // GUARD 2 (right location, wrong shape): a method-dominant struct in the
      // model-ish dir (e.g. a small client/service wrapper struct) must NOT be
      // promoted — behavior, not data.
      node({
        id: 'struct_model_storeclient', name: 'storeClient', type: 'struct',
        source: { file: 'internal/model/client.go', line: 5 },
        metadata: { language: 'go', attributes: { packageName: 'model', fieldCount: 1, methodCount: 6 } },
      }),
    ];

    const entities = orch.buildDataEntities(nodes, []);
    const names = entities.map((e: any) => e.name);
    expect(names).toContain('Feed');
    expect(names).not.toContain('loginForm');
    expect(names).not.toContain('storeClient');
    const feed = entities.find((e: any) => e.name === 'Feed');
    expect((feed.fields || []).map((f: any) => f.name)).toEqual(expect.arrayContaining(['ID', 'UserID', 'Title']));
  });

  describe('operation-shaped and format-token shapes stay out of the entity set (openclaw gap)', () => {
    it('excludes a params shape whose core noun is a callable in the graph', async () => {
      const nodes: CASNode[] = [
        node({
          id: 'type_handle_commands_params',
          name: 'HandleCommandsParams',
          type: 'interface',
          source: { file: 'src/auto-reply/reply/commands-types.ts', line: 1 },
        }),
        node({ id: 'prop_command_body', name: 'commandBody', type: 'property', parent: 'type_handle_commands_params', source: { file: 'src/auto-reply/reply/commands-types.ts', line: 2 } }),
        node({ id: 'fn_handle_commands', name: 'handleCommands', type: 'function', source: { file: 'src/auto-reply/reply/commands-core.ts', line: 1 } }),
        // A genuine domain shape with the same structure must survive.
        node({
          id: 'type_payment_dto',
          name: 'PaymentDto',
          type: 'dto',
          source: { file: 'src/payments/payment.dto.ts', line: 1 },
        }),
        node({ id: 'prop_amount', name: 'amount', type: 'property', parent: 'type_payment_dto', source: { file: 'src/payments/payment.dto.ts', line: 2 } }),
      ];

      const entities = orch.buildDataEntities(nodes, []);
      const names = entities.map((entity: any) => entity.name);
      expect(names).toContain('Payment');
      expect(names).not.toContain('HandleCommands');
    });

    it('excludes serialization-format tokens left over from suffix stripping', async () => {
      const nodes: CASNode[] = [
        node({
          id: 'type_json_schema',
          name: 'JsonSchema',
          type: 'interface',
          source: { file: 'src/agents/schema/types.ts', line: 1 },
        }),
        node({ id: 'prop_type', name: 'type', type: 'property', parent: 'type_json_schema', source: { file: 'src/agents/schema/types.ts', line: 2 } }),
      ];

      const entities = orch.buildDataEntities(nodes, []);
      expect(entities.map((entity: any) => entity.name)).not.toContain('Json');
    });

    // DEFECT-2: infrastructure/runtime/lifecycle-shaped concepts leaked into
    // database_entities via the DTO-only FALLBACK (a repo with zero persisted/
    // api-response shapes surfaces its full DTO set — openclaw). The capability
    // purpose gate already recognized these shapes; the same recognition now runs
    // at the entity-surfacing layer, gated on entity KIND + name shape.
    it('drops infra/runtime/lifecycle-shaped non-persisted DTOs but keeps domain DTOs (openclaw fallback)', async () => {
      const nodes: CASNode[] = [
        // Runtime/lifecycle plumbing shapes — value-object DTOs, no persisted /
        // api-response evidence → must NOT surface as domain data entities.
        node({ id: 'dto_daemon', name: 'DaemonAction', type: 'dto', source: { file: 'src/runtime/daemon.ts', line: 1 } }),
        node({ id: 'p_daemon', name: 'signal', type: 'property', parent: 'dto_daemon', source: { file: 'src/runtime/daemon.ts', line: 2 } }),
        node({ id: 'dto_spawn', name: 'SpawnBase', type: 'dto', source: { file: 'src/runtime/spawn.ts', line: 1 } }),
        node({ id: 'p_spawn', name: 'pid', type: 'property', parent: 'dto_spawn', source: { file: 'src/runtime/spawn.ts', line: 2 } }),
        node({ id: 'dto_usage', name: 'ZaiUsage', type: 'dto', source: { file: 'src/providers/zai.ts', line: 1 } }),
        node({ id: 'p_usage', name: 'tokens', type: 'property', parent: 'dto_usage', source: { file: 'src/providers/zai.ts', line: 2 } }),
        node({ id: 'dto_hook', name: 'HookAgent', type: 'dto', source: { file: 'src/runtime/hooks.ts', line: 1 } }),
        node({ id: 'p_hook', name: 'agent', type: 'property', parent: 'dto_hook', source: { file: 'src/runtime/hooks.ts', line: 2 } }),
        // Genuine product shapes with the SAME kind (value-object DTO) → kept.
        node({ id: 'dto_voice', name: 'VoiceMessage', type: 'dto', source: { file: 'src/voice/voice.ts', line: 1 } }),
        node({ id: 'p_voice', name: 'transcript', type: 'property', parent: 'dto_voice', source: { file: 'src/voice/voice.ts', line: 2 } }),
        node({ id: 'dto_profile', name: 'Profile', type: 'dto', source: { file: 'src/profile/profile.ts', line: 1 } }),
        node({ id: 'p_profile', name: 'handle', type: 'property', parent: 'dto_profile', source: { file: 'src/profile/profile.ts', line: 2 } }),
      ];
      const names = orch.buildDataEntities(nodes, []).map((e: any) => e.name);
      // infra-shaped shapes gone
      for (const infra of ['DaemonAction', 'SpawnBase', 'ZaiUsage', 'HookAgent']) {
        expect(names).not.toContain(infra);
      }
      // real domain shapes kept
      expect(names).toContain('VoiceMessage');
      expect(names).toContain('Profile');
    });

    it('keeps an infra-NAMED shape when it carries persisted-entity evidence (kind exemption)', async () => {
      const nodes: CASNode[] = [
        // A persisted ORM entity that happens to be named with an infra token —
        // the gate is KIND + shape, so durable-state evidence overrides the name.
        node({ id: 'entity_worker', name: 'WorkerRegistry', type: 'entity', source: { file: 'src/entities/worker-registry.ts', line: 1 }, subcategories: ['entity'] }),
        node({ id: 'p_wr_id', name: 'id', type: 'property', parent: 'entity_worker', source: { file: 'src/entities/worker-registry.ts', line: 2 } }),
      ];
      const entities = orch.buildDataEntities(nodes, []);
      expect(entities.map((e: any) => e.name)).toContain('WorkerRegistry');
      expect(entities.find((e: any) => e.name === 'WorkerRegistry')!.kind).toBe('persisted-entity');
    });

    it('never blanks the entity model when EVERY shape reads as infrastructure', async () => {
      const nodes: CASNode[] = [
        node({ id: 'dto_daemon2', name: 'DaemonAction', type: 'dto', source: { file: 'src/runtime/daemon.ts', line: 1 } }),
        node({ id: 'p_d2', name: 'signal', type: 'property', parent: 'dto_daemon2', source: { file: 'src/runtime/daemon.ts', line: 2 } }),
        node({ id: 'dto_spawn2', name: 'SpawnBase', type: 'dto', source: { file: 'src/runtime/spawn.ts', line: 1 } }),
        node({ id: 'p_s2', name: 'pid', type: 'property', parent: 'dto_spawn2', source: { file: 'src/runtime/spawn.ts', line: 2 } }),
      ];
      const entities = orch.buildDataEntities(nodes, []);
      // The guard keeps the surfaced set rather than returning an empty model.
      expect(entities.length).toBeGreaterThan(0);
    });
  });

  it('dedupes same-named ORM entities into one richest-evidence entry with merged lifecycle (hercules gap)', async () => {
    const nodes: CASNode[] = [
      node({
        id: 'model_fleet_user',
        name: 'User',
        type: 'model',
        source: { file: 'modules/fleet/models.py', line: 1 },
        subcategories: ['data', 'entity'],
      }),
      node({ id: 'prop_fleet_azure_id', name: 'azure_id', type: 'field', parent: 'model_fleet_user', source: { file: 'modules/fleet/models.py', line: 2 } }),
      node({
        id: 'model_users_user',
        name: 'User',
        type: 'model',
        source: { file: 'modules/users/models.py', line: 1 },
        subcategories: ['data', 'entity'],
      }),
      node({ id: 'prop_users_email', name: 'email', type: 'field', parent: 'model_users_user', source: { file: 'modules/users/models.py', line: 2 } }),
      node({ id: 'prop_users_username', name: 'username', type: 'field', parent: 'model_users_user', source: { file: 'modules/users/models.py', line: 3 } }),
    ];
    const edges: CASEdge[] = [
      { id: 'edge_creates_fleet', source: 'svc_create_fleet_user', target: 'model_fleet_user', type: 'creates' } as CASEdge,
      { id: 'edge_reads_users', source: 'svc_get_user', target: 'model_users_user', type: 'reads' } as CASEdge,
    ];

    const entities = orch.buildDataEntities(nodes, edges);
    const users = entities.filter((entity: any) => entity.id === 'entity_user');
    expect(users).toHaveLength(1);
    // Richest-evidence copy wins (two fields beats one)...
    expect((users[0].fields || []).map((field: any) => field.name).sort()).toEqual(['email', 'username']);
    expect(users[0].schema_source).toBe('modules/users/models.py');
    // ...and lifecycle evidence from BOTH anchors is preserved.
    expect(users[0].lifecycle.created_by).toContain('svc_create_fleet_user');
    expect(users[0].lifecycle.read_by).toContain('svc_get_user');
  });
});

describe('dedupePluralSingularEntities (plural/singular phantom entity dedupe)', () => {
  const node = (partial: Partial<CASNode>): CASNode => ({
    id: partial.id || partial.name || 'node',
    name: partial.name || 'Node',
    type: partial.type || 'class',
    source: partial.source || { file: `src/${partial.name || 'node'}.ts`, line: 1 },
    metadata: partial.metadata || {},
    subcategories: partial.subcategories,
    parent: partial.parent,
    signature: partial.signature,
  } as CASNode);

  const emptyLifecycle = (): CASDataEntity['lifecycle'] => ({ created_by: [], read_by: [], updated_by: [], deleted_by: [] });

  it('merges a plural/singular pair that shares the SAME schema/class source file', () => {
    const device = {
      id: 'entity_device', name: 'Device', schema_source: 'src/entities/device.ts',
      fields: [{ name: 'id', type: 'string', is_sensitive: false }, { name: 'serial', type: 'string', is_sensitive: false }],
      lifecycle: emptyLifecycle(),
    } as CASDataEntity;
    const devices = {
      id: 'entity_devices', name: 'Devices', schema_source: 'src/entities/device.ts',
      fields: [{ name: 'items', type: 'array', is_sensitive: false }],
      lifecycle: { ...emptyLifecycle(), read_by: ['svc_list_devices'] },
    } as CASDataEntity;

    const merged: CASDataEntity[] = orch.dedupePluralSingularEntities([device, devices]);
    expect(merged).toHaveLength(1);
    // Richer copy (more fields: 2 vs 1) survives.
    expect(merged[0].name).toBe('Device');
    // Lifecycle from the dropped duplicate is unioned in, not lost.
    expect(merged[0].lifecycle.read_by).toContain('svc_list_devices');
  });

  it('merges a plural/singular pair that shares an overlapping LIFECYCLE ACCESSOR (lineage cluster) despite different source files', () => {
    const vehicle = {
      id: 'entity_vehicle', name: 'Vehicle', schema_source: 'src/entities/vehicle.ts',
      fields: [{ name: 'id', type: 'string', is_sensitive: false }],
      lifecycle: { ...emptyLifecycle(), created_by: ['svc_fleet'] },
    } as CASDataEntity;
    const vehicles = {
      id: 'entity_vehicles', name: 'Vehicles', schema_source: 'src/dto/vehicles-response.dto.ts',
      fields: [{ name: 'plate', type: 'string', is_sensitive: false }, { name: 'vin', type: 'string', is_sensitive: false }],
      // Same accessor node id as `vehicle` above — same reader/writer touches both.
      lifecycle: { ...emptyLifecycle(), created_by: ['svc_fleet'] },
    } as CASDataEntity;

    const merged: CASDataEntity[] = orch.dedupePluralSingularEntities([vehicle, vehicles]);
    expect(merged).toHaveLength(1);
    // Richer copy (2 fields vs 1) survives — the DTO-derived shape this time.
    expect(merged[0].name).toBe('Vehicles');
    expect(merged[0].schema_source).toBe('src/dto/vehicles-response.dto.ts');
  });

  it('does NOT merge a plural/singular pair with no shared backing evidence (stem match alone is insufficient)', () => {
    const trailer = {
      id: 'entity_trailer', name: 'Trailer', schema_source: 'src/entities/trailer.ts',
      fields: [{ name: 'id', type: 'string', is_sensitive: false }],
      lifecycle: { ...emptyLifecycle(), created_by: ['svc_fleet_ops'] },
    } as CASDataEntity;
    const trailers = {
      id: 'entity_trailers', name: 'Trailers', schema_source: 'src/dto/trailers-summary.dto.ts',
      fields: [{ name: 'count', type: 'number', is_sensitive: false }],
      // Disjoint accessor evidence — different reader/writer, no schema overlap.
      lifecycle: { ...emptyLifecycle(), read_by: ['svc_analytics_export'] },
    } as CASDataEntity;

    const result: CASDataEntity[] = orch.dedupePluralSingularEntities([trailer, trailers]);
    expect(result).toHaveLength(2);
    expect(result.map((e: any) => e.name).sort()).toEqual(['Trailer', 'Trailers']);
  });

  it('leaves entities with no stem collision untouched', () => {
    const invoice = { id: 'entity_invoice', name: 'Invoice', lifecycle: emptyLifecycle() } as CASDataEntity;
    const client = { id: 'entity_client', name: 'Client', lifecycle: emptyLifecycle() } as CASDataEntity;
    const result: CASDataEntity[] = orch.dedupePluralSingularEntities([invoice, client]);
    expect(result).toHaveLength(2);
  });

  it('end-to-end via buildDataEntities: an ORM Device entity and a DevicesResponseDto-derived shape collapse to one entity when they share a lifecycle accessor', () => {
    const nodes: CASNode[] = [
      node({ id: 'entity_orm_device', name: 'Device', type: 'entity', source: { file: 'src/entities/device.ts', line: 1 }, subcategories: ['entity'] }),
      node({ id: 'prop_device_id', name: 'id', type: 'property', parent: 'entity_orm_device', source: { file: 'src/entities/device.ts', line: 2 } }),
      node({ id: 'prop_device_serial', name: 'serial', type: 'property', parent: 'entity_orm_device', source: { file: 'src/entities/device.ts', line: 3 } }),
      // Tagged api-response subcategory so the derived shape survives the
      // domain-KIND filter regardless of dedupe — otherwise this fixture would
      // pass even without the dedupe fix (a plain value-object shape is
      // already dropped by the kind filter, masking the phantom).
      node({
        id: 'dto_devices_response', name: 'DevicesResponseDto', type: 'dto',
        source: { file: 'src/devices/devices-response.dto.ts', line: 1 },
        subcategories: ['api-response'],
      }),
      node({ id: 'prop_devices_items', name: 'items', type: 'property', parent: 'dto_devices_response', source: { file: 'src/devices/devices-response.dto.ts', line: 2 } }),
      // A CRUD-verbed accessor whose object noun ("Devices") singularizes to the
      // SAME stem ("device") as both surfaced shapes — buildEntityAccessorIndexByNoun
      // attributes it to both, giving the two shapes a shared lifecycle accessor.
      node({ id: 'svc_list_devices', name: 'listDevices', type: 'method', source: { file: 'src/devices/devices.controller.ts', line: 1 } }),
    ];

    const names = (orch.buildDataEntities(nodes, []) as CASDataEntity[]).map(e => e.name.toLowerCase());
    // Exactly one surfaced shape for the "device" stem — the plural DTO-derived
    // phantom must not survive alongside the real ORM entity.
    const deviceShaped = names.filter(name => name === 'device' || name === 'devices');
    expect(deviceShaped).toHaveLength(1);
  });
});

describe('entity description evidence bundle (entity descriptions authored LAST)', () => {
  const node = (partial: Partial<CASNode>): CASNode => ({
    id: partial.id || partial.name || 'node',
    name: partial.name || 'Node',
    type: partial.type || 'class',
    source: partial.source || { file: `src/${partial.name || 'node'}.ts`, line: 1 },
    metadata: partial.metadata || {},
    subcategories: partial.subcategories,
    parent: partial.parent,
    signature: partial.signature,
  } as CASNode);

  const emptyLifecycle = (): CASDataEntity['lifecycle'] => ({ created_by: [], read_by: [], updated_by: [], deleted_by: [] });

  it('buildEntityRelationsByName resolves references edges to real entity names, keyed by SOURCE name', () => {
    const nodes: CASNode[] = [
      node({ id: 'entity_doctrine_deviceconnectionbind', name: 'DeviceConnectionBind', type: 'entity' }),
      node({ id: 'entity_doctrine_device', name: 'Device', type: 'entity' }),
      node({ id: 'entity_doctrine_connection', name: 'Connection', type: 'entity' }),
    ];
    const edges: CASEdge[] = [
      {
        id: 'rel_1', source: 'entity_doctrine_deviceconnectionbind', target: 'entity_doctrine_device', type: 'references',
        metadata: { attributes: { relationType: 'ManyToOne', field: 'entity' } },
      } as unknown as CASEdge,
      {
        id: 'rel_2', source: 'entity_doctrine_deviceconnectionbind', target: 'entity_doctrine_connection', type: 'references',
        metadata: { attributes: { relationType: 'ManyToOne', field: 'connection' } },
      } as unknown as CASEdge,
    ];

    const byName = orch.buildEntityRelationsByName(nodes, edges) as Map<string, Array<{ targetName: string; relationType: string; field?: string }>>;
    const relations = byName.get('deviceconnectionbind');
    expect(relations).toHaveLength(2);
    expect(relations!.map(r => r.targetName).sort()).toEqual(['Connection', 'Device']);
    expect(relations!.find(r => r.targetName === 'Device')?.field).toBe('entity');
  });

  it('buildCapabilitiesByEntityId maps each entity id to the names of capabilities that reference it', () => {
    const capabilities = [
      { id: 'cap_billing', name: 'Billing Management', related_entities: ['entity_invoice', 'entity_customer'] },
      { id: 'cap_dispatch', name: 'Dispatch Management', related_entities: ['entity_customer'] },
    ] as any[];
    const byEntityId = orch.buildCapabilitiesByEntityId(capabilities) as Map<string, string[]>;
    expect(byEntityId.get('entity_invoice')).toEqual(['Billing Management']);
    expect(byEntityId.get('entity_customer')?.sort()).toEqual(['Billing Management', 'Dispatch Management']);
  });

  it('buildJourneysByEntityName maps each entity name to the journeys that write/read/terminate on it', () => {
    const journeys = [
      {
        id: 'journey_1', name: 'Create Booking', journey_kind: 'user-facing', entry_point_id: 'ep_1',
        entry: { type: 'http', name: 'POST /bookings' }, steps: [],
        terminal_effects: { entities_written: ['Booking'], entities_read: [], external_services: [], messages_emitted: [] },
        terminal_entities: [{ name: 'Booking', access: 'created', terminal_kind: 'entity' }],
        security_boundaries: [],
      },
      {
        id: 'journey_2', name: 'View Booking', journey_kind: 'user-facing', entry_point_id: 'ep_2',
        entry: { type: 'http', name: 'GET /bookings/:id' }, steps: [],
        terminal_effects: { entities_written: [], entities_read: ['Booking'], external_services: [], messages_emitted: [] },
        terminal_entities: [],
        security_boundaries: [],
      },
    ] as any[];
    const byEntityName = orch.buildJourneysByEntityName(journeys) as Map<string, string[]>;
    expect(byEntityName.get('booking')?.sort()).toEqual(['Create Booking', 'View Booking']);
  });

  it('entityDescriptionTarget assembles the FULL evidence bundle: fields, ORM relations, lifecycle, serving capabilities, journeys', () => {
    const entity = {
      id: 'entity_doctrine_deviceconnectionbind',
      name: 'DeviceConnectionBind',
      schema_source: 'src/Entity/DeviceConnectionBind.php',
      fields: [{ name: 'remoteId', type: 'string', is_sensitive: false }],
      lifecycle: { ...emptyLifecycle(), created_by: ['sync_worker'], read_by: ['sync_worker', 'admin_ui'] },
    } as CASDataEntity;

    const relationsByName = new Map([
      ['deviceconnectionbind', [
        { targetName: 'Device', relationType: 'ManyToOne', field: 'entity' },
        { targetName: 'Connection', relationType: 'ManyToOne', field: 'connection' },
      ]],
    ]);
    const capabilitiesByEntityId = new Map([['entity_doctrine_deviceconnectionbind', ['Integration Sync Management']]]);
    const journeysByEntityName = new Map([['deviceconnectionbind', ['Sync Device From Provider']]]);

    const target = orch.entityDescriptionTarget(entity, { relationsByName, capabilitiesByEntityId, journeysByEntityName });

    expect(target.kind).toBe('entity');
    expect(target.fields).toEqual(['remoteId:string']);
    expect(target.lifecycle).toEqual({ creates: 1, reads: 2, updates: 0, deletes: 0 });
    expect(target.evidenceSummary).toEqual(expect.arrayContaining([
      expect.stringContaining('relates to Device (ManyToOne via entity)'),
      expect.stringContaining('relates to Connection (ManyToOne via connection)'),
      expect.stringContaining('serves capability: Integration Sync Management'),
      expect.stringContaining('appears in journey: Sync Device From Provider'),
    ]));
    expect(target.relatedEntities?.sort()).toEqual(['Connection', 'Device']);
    expect(target.relatedDomains).toEqual(['Integration Sync Management']);
  });

  it('entityDescriptionTarget degrades gracefully with no context (fields/lifecycle only, no evidence fabricated)', () => {
    const entity = {
      id: 'entity_plain', name: 'PlainEntity', lifecycle: emptyLifecycle(),
    } as CASDataEntity;
    const target = orch.entityDescriptionTarget(entity);
    expect(target.kind).toBe('entity');
    expect(target.evidenceSummary).toEqual([]);
    expect(target.relatedEntities).toEqual([]);
    expect(target.relatedDomains).toEqual([]);
  });
});

describe('repairDanglingSentenceEndings', () => {
  it('strips a trailing dangling preposition left by a truncated clause (the accepted Klauro description class)', async () => {
    const text = 'Klauro is a codebase analysis platform built as a monorepo. It stores telemetry data and graph evidence for.';
    expect(orch.repairDanglingSentenceEndings(text)).toBe(
      'Klauro is a codebase analysis platform built as a monorepo. It stores telemetry data and graph evidence.'
    );
  });

  it('strips stacked dangling function words back to the last content word', async () => {
    expect(orch.repairDanglingSentenceEndings('The service records analysis runs and exposes them to agents with the.'))
      .toBe('The service records analysis runs and exposes them to agents.');
  });

  it('drops a sentence gutted by the repair when other sentences remain', async () => {
    expect(orch.repairDanglingSentenceEndings('The service runs scheduled analysis jobs across every repository. Built for and with the.'))
      .toBe('The service runs scheduled analysis jobs across every repository.');
  });

  it('leaves clean prose untouched', async () => {
    const clean = 'The service records analysis runs. Agents query the resulting graph to plan changes.';
    expect(orch.repairDanglingSentenceEndings(clean)).toBe(clean);
  });
});

describe('evidence-based capability category and criticality (no keyword doctrine)', () => {
  // DOCTRINE (docs/cas/DETERMINISM-BOUNDARY.md + the capability cardinal rule):
  // core = what the app was BUILT FOR, proven by produced evidence (api-response /
  // persisted entities, lifecycle breadth) — never by a domain-token keyword list.
  // Identity/session/telemetry plumbing is supporting on non-auth/non-observability
  // products; the exception is itself evidence-based (repo-wide analyzer-tag share).
  const capNode = (partial: Partial<CASNode>): CASNode => ({
    id: partial.id || partial.name || 'node',
    name: partial.name || 'Node',
    type: partial.type || 'service',
    source: partial.source || { file: 'src/a.ts', line: 1 },
    metadata: partial.metadata || {},
    ...partial,
  } as CASNode);

  const capEntity = (partial: Partial<CASDataEntity>): CASDataEntity => ({
    id: partial.id || partial.name || 'entity',
    name: partial.name || 'Entity',
    lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] },
    ...partial,
  } as CASDataEntity);

  // Auth-analyzer-shaped evidence: mechanism node types + the analyzer's
  // stamped subcategories (auth-analyzer.ts:255) — NOT auth-looking names.
  const authMechanismNodes = [
    capNode({ id: 'g1', name: 'requireSession', type: 'guard' }),
    capNode({ id: 'g2', name: 'credentialsStrategy', type: 'auth_strategy' }),
    capNode({ id: 'g3', name: 'serializeMember', type: 'function', metadata: { subcategories: ['auth', 'auth_strategy'] } as any }),
  ];

  it('identity-mechanism capability on a NON-auth repo is supporting, never core/high', async () => {
    const userEntity = capEntity({ name: 'User' });
    const category = orch.inferTerminalCapabilityCategory(
      'user', authMechanismNodes, [userEntity], { identityShare: 0.02, observabilityShare: 0 });
    expect(category).toBe('supporting');
    const criticality = orch.inferTerminalCriticality(authMechanismNodes, [userEntity]);
    expect(criticality).not.toBe('high');
    expect(criticality).not.toBe('critical');
  });

  it('the same identity shape on an auth PRODUCT (auth-analyzer-heavy repo evidence) may be core', async () => {
    const sessionResponse = capEntity({ name: 'SessionToken', kind: 'api-response', kind_source: 'framework-evidence' });
    const category = orch.inferTerminalCapabilityCategory(
      'user', authMechanismNodes, [sessionResponse], { identityShare: 0.4, observabilityShare: 0 });
    expect(category).toBe('core');
  });

  it("categorizes a pricing capability by evidence, not the retired 'price' keyword", async () => {
    // Bare 'price' key with one thin helper node: the retired keyword list
    // forced core (why a Django pharma portal shipped 12/12 core).
    const thin = orch.inferTerminalCapabilityCategory(
      'price', [capNode({ name: 'PriceHelper', type: 'function' })], [],
      { identityShare: 0, observabilityShare: 0 });
    expect(thin).toBe('supporting');
    // Same key WITH produced evidence (persisted entity + lifecycle breadth) → core.
    const priced = orch.inferTerminalCapabilityCategory(
      'price',
      [capNode({ id: 'svc', name: 'PricingService', type: 'service' }), capNode({ id: 'repo', name: 'PriceRepository', type: 'class' })],
      [capEntity({ name: 'PriceList', kind: 'persisted-entity', kind_source: 'framework-evidence' })],
      { identityShare: 0, observabilityShare: 0 });
    expect(priced).toBe('core');
  });

  it('observability-instrumentation groups are supporting on non-observability products', async () => {
    const otelNodes = [
      capNode({ id: 'o1', name: 'span: analyze', type: 'function', metadata: { subcategories: ['observability-instrumentation', 'span', 'otel'] } as any }),
      capNode({ id: 'o2', name: 'traces.ts observability surface', type: 'module', metadata: { subcategories: ['observability-module'] } as any }),
    ];
    expect(orch.inferTerminalCapabilityCategory(
      'trace', otelNodes, [], { identityShare: 0, observabilityShare: 0.01 })).toBe('supporting');
  });

  it('bare entity possession without lifecycle breadth is not core (honest distributions)', async () => {
    // The retired rule was "any group with entities → core", which produced
    // 100%-core capability sets. A dangling DTO with no operating nodes is
    // not proof of product value.
    expect(orch.inferTerminalCapabilityCategory(
      'preference', [], [capEntity({ name: 'CustomerPreference' })],
      { identityShare: 0, observabilityShare: 0 })).toBe('supporting');
  });

  it('no hardcoded category keyword list or name-based criticality boost remains (grep)', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../../analyzer/core/orchestrator.ts'), 'utf8');
    // The crypto-benchmark leftover core list (trade|…|bundler|price|sol → core).
    expect(source).not.toContain('trade|token-balance|market-data');
    expect(source).not.toContain('bundler|bundle|price|prices|sol');
    // The identity/finance NAME boost that shipped plumbing as high-criticality.
    expect(source).not.toContain('auth|tenant|permission|payment|billing|invoice|order|security|user|account');
  });
});

describe('capability hygiene: entity-set dedup', () => {
  const capFixture = (over: Partial<SystemCapabilityLike>): any => ({
    id: 'cap_x',
    name: 'Cap',
    description: 'desc',
    category: 'supporting',
    operations: [],
    related_entities: [],
    related_domains: [],
    criticality: 'medium',
    criticality_factors: [],
    ...over,
  });
  type SystemCapabilityLike = {
    id: string; name: string; description: string; category: string;
    operations: Array<{ entry_point_id: string; entry_point_type: string; action: string; path_or_command?: string }>;
    related_entities: string[]; related_domains: string[];
    criticality: string; criticality_factors: string[];
  };

  it('merges verb-variant capabilities over the identical entity set, keeping the core-most copy and merging evidence', async () => {
    // kontinuum live case: "Tracks task reports" (core) + "Provides task
    // reports" (supporting), both anchored on the single entity TaskReport.
    // Entity refs deliberately differ in representation (id vs name) to prove
    // canonicalization.
    const merged = orch.dedupeSystemCapabilitiesByName([
      capFixture({
        name: 'Tracks task reports', category: 'core',
        related_entities: ['entity_taskreport'], related_domains: ['task'],
        operations: [{ entry_point_id: 'ep1', entry_point_type: 'http', action: 'track' }],
      }),
      capFixture({
        name: 'Provides task reports', category: 'supporting',
        related_entities: ['TaskReport'], related_domains: ['report'],
        operations: [{ entry_point_id: 'ep2', entry_point_type: 'http', action: 'provide' }],
      }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe('Tracks task reports');
    expect(merged[0].category).toBe('core');
    // Evidence merged from both copies.
    expect(merged[0].operations).toHaveLength(2);
    expect(merged[0].related_domains.sort()).toEqual(['report', 'task']);
  });

  it('keeps two DIFFERENT purposes over the SAME entity set (rung-5 washup: exact-set dedupe collapsed 6 purpose caps to 3), while still merging a CRUD verb-variant pair', async () => {
    const merged = orch.dedupeSystemCapabilitiesByName([
      // Same entity set {Task, TaskList}, DIFFERENT purpose subjects — both live.
      capFixture({
        name: 'Lets users manage tasks and task lists', category: 'core',
        related_entities: ['entity_task', 'entity_tasklist'], related_domains: ['task'],
        operations: [{ entry_point_id: 'ep1', entry_point_type: 'http', action: 'manage' }],
      }),
      capFixture({
        name: 'Lets users manage duplicate routine tasks', category: 'core',
        related_entities: ['entity_task', 'entity_tasklist'], related_domains: ['task'],
        operations: [{ entry_point_id: 'ep2', entry_point_type: 'http', action: 'duplicate' }],
      }),
      // Same entity set {LocationEvent}, SAME subject after CRUD-verb strip — merged.
      capFixture({
        name: 'Create location event', category: 'core',
        related_entities: ['entity_locationevent'], related_domains: ['event'],
        operations: [{ entry_point_id: 'ep3', entry_point_type: 'http', action: 'create' }],
      }),
      capFixture({
        name: 'Update location event', category: 'supporting',
        related_entities: ['entity_locationevent'], related_domains: ['event'],
        operations: [{ entry_point_id: 'ep4', entry_point_type: 'http', action: 'update' }],
      }),
    ]);
    const names = merged.map((c: any) => c.name).sort();
    expect(names).toHaveLength(3);
    expect(names).toContain('Lets users manage tasks and task lists');
    expect(names).toContain('Lets users manage duplicate routine tasks');
    // The CRUD pair merged into one (the core copy wins), evidence unioned.
    const locationEvent = merged.find((c: any) => /location event/i.test(c.name));
    expect(locationEvent.operations).toHaveLength(2);
  });

  it('merges a subset-entity capability with no distinct operations into the superset', async () => {
    const merged = orch.dedupeSystemCapabilitiesByName([
      capFixture({
        name: 'Manages user economy transactions',
        related_entities: ['EconomyTransaction', 'EconomyReward'],
        operations: [{ entry_point_id: 'ep1', entry_point_type: 'http', action: 'update' }],
      }),
      capFixture({ name: 'Manages user economy rewards', related_entities: ['EconomyReward'] }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe('Manages user economy transactions');
  });

  it('keeps a subset-entity capability that carries distinct operations', async () => {
    const merged = orch.dedupeSystemCapabilitiesByName([
      capFixture({ name: 'Manages orders', related_entities: ['Order', 'OrderLine'] }),
      capFixture({
        name: 'Exports order lines', related_entities: ['OrderLine'],
        operations: [{ entry_point_id: 'ep_export', entry_point_type: 'cli', action: 'export' }],
      }),
    ]);
    expect(merged).toHaveLength(2);
  });

  it('never set-merges capabilities with no related entities', async () => {
    const merged = orch.dedupeSystemCapabilitiesByName([
      capFixture({ name: 'Health checks' }),
      capFixture({ name: 'Log rotation' }),
    ]);
    expect(merged).toHaveLength(2);
  });
});

describe('capability hygiene: code-artifact entity filter (evidence-first)', () => {
  it('flags infra-role head nouns only', async () => {
    expect(orch.isCodeArtifactRoleName('RegisterTelegramHandler')).toBe(true);
    expect(orch.isCodeArtifactRoleName('ChannelHandler')).toBe(true);
    expect(orch.isCodeArtifactRoleName('InMemoryMemoryGraphAdapter')).toBe(true);
    expect(orch.isCodeArtifactRoleName('PluginRegistry')).toBe(true);
    expect(orch.isCodeArtifactRoleName('NodePairingPending')).toBe(true);
    expect(orch.isCodeArtifactRoleName('TaskReport')).toBe(false);
    expect(orch.isCodeArtifactRoleName('EconomyTransaction')).toBe(false);
    // Substring must not trigger: role token must be the TAIL noun.
    expect(orch.isCodeArtifactRoleName('HandlerMetrics')).toBe(false);
  });

  it('flags the widened suffix + verb-callable + internal-role artifact shapes (live openclaw/kontinuum)', async () => {
    // Suffix roles widened beyond the original set.
    expect(orch.isCodeArtifactRoleName('HandleDirectiveOnlyCore')).toBe(true); // Core (also Handle-prefixed)
    expect(orch.isCodeArtifactRoleName('AckReactionGate')).toBe(true);        // Gate
    expect(orch.isCodeArtifactRoleName('FeishuReplyDispatcher')).toBe(true);  // Dispatcher
    expect(orch.isCodeArtifactRoleName('BrowserDispatch')).toBe(true);        // Dispatch
    expect(orch.isCodeArtifactRoleName('ExecApprovalContainer')).toBe(true);  // Container
    expect(orch.isCodeArtifactRoleName('ProjectCommandCenterView')).toBe(true); // View
    // Verb-named callables (leading Send/Handle/Register + a capitalized word).
    expect(orch.isCodeArtifactRoleName('SendMSTeamsMessage')).toBe(true);
    expect(orch.isCodeArtifactRoleName('SendFeishuMessage')).toBe(true);
    expect(orch.isCodeArtifactRoleName('SendGroup')).toBe(true);
    // Internal (non-leading) role word buried mid-name.
    expect(orch.isCodeArtifactRoleName('MentionGateWithBypass')).toBe(true);  // Gate at index 1
    // Guards: leading qualifier is NOT the head noun; product nouns survive.
    expect(orch.isCodeArtifactRoleName('HandlerMetrics')).toBe(false);
    expect(orch.isCodeArtifactRoleName('PaymentGateway')).toBe(false); // "Gateway" != "Gate"
    expect(orch.isCodeArtifactRoleName('Interview')).toBe(false);      // ends "view" lowercase
    expect(orch.isCodeArtifactRoleName('Sender')).toBe(false);         // "Send" not followed by [A-Z]
    expect(orch.isCodeArtifactRoleName('OrderContainer')).toBe(true);  // flagged by name; kind-gate keeps a persisted OrderContainer at the call site
  });

  it('derive path drops an artifact shape without persistence evidence, keeps one WITH ORM evidence', async () => {
    const shape = (name: string, id: string, extra: Record<string, unknown> = {}): CASNode => ({
      id, name, type: 'interface',
      source: { file: `src/types/${name.toLowerCase()}.ts`, line: 1 },
      metadata: {}, ...extra,
    } as CASNode);
    const prop = (parent: string, name: string): CASNode => ({
      id: `${parent}.${name}`, name, type: 'property', parent,
      source: { file: `src/types/shapes.ts`, line: 2 }, metadata: {},
    } as CASNode);
    const nodes: CASNode[] = [
      shape('ChannelHandler', 'n_ch'), prop('n_ch', 'channelId'),
      shape('OrderHandler', 'n_oh', { subcategories: ['orm-entity'] }), prop('n_oh', 'orderId'),
      shape('TaskReport', 'n_tr'), prop('n_tr', 'taskId'),
    ];
    const derived = orch.deriveEntitiesFromDataShapeNodes(
      nodes, new Map(), new Map(nodes.map(n => [n.id, n])),
      orch.buildEntityPropertyIndex(nodes), new Set<string>()
    );
    const names = derived.map((entity: { name: string }) => entity.name);
    expect(names).not.toContain('ChannelHandler'); // artifact, no persistence evidence
    expect(names).toContain('OrderHandler'); // role-suffixed but framework-proven persisted
    expect(names).toContain('TaskReport'); // ordinary domain shape untouched
  });

  it('a code-artifact entity without persistence evidence never seeds a terminal capability', async () => {
    const artifactEntity: CASDataEntity = {
      id: 'entity_registertelegramhandler', name: 'RegisterTelegramHandler',
      kind: 'value-object', kind_source: 'framework-evidence',
      lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] },
    } as CASDataEntity;
    const capabilities = await orch.buildTerminalCapabilities([artifactEntity], [], [], new Set<string>());
    expect(capabilities).toHaveLength(0);
  });

  it('a role-suffixed entity WITH persistence evidence still anchors a capability', async () => {
    const persistedEntity: CASDataEntity = {
      id: 'entity_orderhandler', name: 'OrderHandler',
      kind: 'persisted-entity', kind_source: 'framework-evidence',
      lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] },
    } as CASDataEntity;
    const capabilities = await orch.buildTerminalCapabilities([persistedEntity], [], [], new Set<string>());
    expect(capabilities.length).toBeGreaterThan(0);
  });
});

describe('capability hygiene: post-AI-catalog reconciliation (real hosted-CAS defects)', () => {
  // These reproduce the three defects that survived on the hosted (AI-on) output
  // because the AI catalog REPLACES the deterministic system_capabilities and
  // bypasses all deterministic post-processing. reconcileCatalogedCapabilities
  // re-applies dedup + the purpose gate and re-injects flagship behavior surfaces.
  const cap = (over: Record<string, unknown>): any => ({
    id: 'c', name: 'Cap', description: 'x'.repeat(30), description_source: 'ai',
    category: 'supporting', operations: [], related_entities: [], related_domains: [],
    criticality: 'medium', criticality_factors: [], ...over,
  });
  const entity = (name: string, kind: string): any => ({
    id: name, name, kind,
    lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] },
  });

  it('SURFACES ARE NOT CAPABILITIES: a behavior-surface candidate is never re-injected into the ranked catalog, even if the AI dropped it', async () => {
    // Prior to the behavior_surfaces navigation tier, reconcile used to
    // re-inject a dropped surface as a 'core' capability (the "flagship"
    // countermeasure) — that inflated criticality/operation counts crowded
    // out real domain capabilities in top_capabilities (the truckspy bug:
    // "Command Surface" / "Event Subscriber Surface" outranking "Manage
    // trips"). Surfaces now live exclusively in `behavior_surfaces`
    // (buildSystemCapabilities), never in the candidate snapshot fed here —
    // this test guards the defense-in-depth filter for a caller that hands
    // one in anyway.
    const cataloged = [
      cap({ name: 'Surfaces codebase analysis results', category: 'core', criticality: 'high', related_entities: ['Codebase'] }),
      cap({ name: 'Provides codebase analysis results', category: 'core', criticality: 'high', related_entities: ['AnalysisResult'] }),
    ];
    const behaviorCandidate = cap({
      name: 'Mcp Tool Surface', structural_label: 'Mcp Tool Surface',
      category: 'core', criticality: 'critical', evidence_kind: 'behavior-surface',
      related_entities: ['Codebase', 'Component', 'Project', 'User', 'Workspace'],
      related_domains: ['mcp-tool'], description_source: undefined,
    });
    const out = orch.reconcileCatalogedCapabilities(cataloged, [behaviorCandidate], []);
    expect(out.some((c: any) => c.evidence_kind === 'behavior-surface')).toBe(false);
    expect(out.some((c: any) => c.name === 'Mcp Tool Surface')).toBe(false);
    // The real entity-anchored domain capabilities are untouched.
    expect(out.some((c: any) => c.name === 'Surfaces codebase analysis results')).toBe(true);
    expect(out.some((c: any) => c.name === 'Provides codebase analysis results')).toBe(true);
  });

  it('SURFACES ARE NOT CAPABILITIES: a behavior-surface entry in `cataloged` itself is filtered out, not merely left alone', async () => {
    const cataloged = [
      cap({ name: 'Mcp Tool Surface', category: 'core', criticality: 'critical', evidence_kind: 'behavior-surface', related_domains: ['mcp-tool'] }),
      cap({ name: 'Exposes MCP tools to agents', category: 'core', related_entities: ['Codebase'], related_domains: ['mcp-tool'] }),
    ];
    const out = orch.reconcileCatalogedCapabilities(cataloged, [], []);
    expect(out.some((c: any) => c.evidence_kind === 'behavior-surface')).toBe(false);
    expect(out.filter((c: any) => /mcp/i.test(c.name))).toHaveLength(1);
  });

  it('PURPOSE GATE: drops infra/runtime-only capabilities, keeps product ones (openclaw)', async () => {
    const dataEntities = [
      entity('RestartSentinel', 'request-dto'), entity('RuntimeInfo', 'request-dto'),
      entity('DaemonAction', 'request-dto'), entity('SpawnBase', 'request-dto'),
      entity('SystemPresence', 'request-dto'),
      entity('Voice', 'request-dto'), entity('ChannelSetup', 'request-dto'),
      entity('ExecApproval', 'request-dto'), entity('OrderRecord', 'persisted-entity'),
    ];
    const cataloged = [
      cap({ name: 'Manages Voice interactions', category: 'core', related_entities: ['ChannelSetup', 'Voice'] }),
      cap({ name: 'Manages Exec approvals', related_entities: ['ExecApproval'] }),
      cap({ name: 'Manages Restart sentinels', related_entities: ['RestartSentinel'] }),
      cap({ name: 'Manages Runtime info', related_entities: ['RuntimeInfo'] }),
      cap({ name: 'Manages Daemon actions', related_entities: ['DaemonAction'] }),
      cap({ name: 'Manages Spawn bases', related_entities: ['SpawnBase'] }),
      cap({ name: 'Manages System presence', related_entities: ['SystemPresence'] }),
    ];
    const out = orch.reconcileCatalogedCapabilities(cataloged, [], dataEntities);
    const names = out.map((c: any) => c.name);
    expect(names).toContain('Manages Voice interactions');
    expect(names).toContain('Manages Exec approvals');
    expect(names).not.toContain('Manages Restart sentinels');
    expect(names).not.toContain('Manages Runtime info');
    expect(names).not.toContain('Manages Daemon actions');
    expect(names).not.toContain('Manages Spawn bases');
    expect(names).not.toContain('Manages System presence');
  });

  it('PURPOSE GATE: an infra-shaped name with PERSISTED evidence is kept (product record)', async () => {
    const dataEntities = [entity('RuntimeConfig', 'persisted-entity')];
    const cataloged = [cap({ name: 'Manages runtime config', category: 'core', related_entities: ['RuntimeConfig'] })];
    const out = orch.reconcileCatalogedCapabilities(cataloged, [], dataEntities);
    expect(out.map((c: any) => c.name)).toContain('Manages runtime config');
  });

  it('DEDUP: collapses verb-variant near-dups on the same entity set (Klauro telemetry/connections)', async () => {
    const cataloged = [
      cap({ name: 'Monitors codebase telemetry', related_entities: ['TelemetryData'] }),
      cap({ name: 'Manages codebase telemetry', related_entities: ['TelemetryData'] }),
      cap({ name: 'Tracks codebase connections', related_entities: ['CodebaseConnection'] }),
      cap({ name: 'Exposes codebase connections', related_entities: ['CodebaseConnection'] }),
    ];
    const out = orch.reconcileCatalogedCapabilities(cataloged, [], []);
    expect(out.filter((c: any) => /telemetry/i.test(c.name))).toHaveLength(1);
    expect(out.filter((c: any) => /connections/i.test(c.name))).toHaveLength(1);
  });

  // R8-B: distribution/CI infra-echo capabilities (zerac/poc, a Rust ZTNA
  // product, v1.0.104 — 47 distribution_shell_script + 11 release-script + 10
  // installer nodes anchored two AI-catalog capabilities: "Manage shell
  // scripts" and "Deploy and manage binaries"). These have NO entity anchors
  // at all (the purpose gate's original entity-only path never applies to
  // them), so the gate must also see the OPERATION anchors' underlying node
  // evidence (distribution_*/ci_* node types), not just entry_point_type
  // (which a real product 'cli'/'pipeline' entry point shares).
  const distNode = (id: string, type: string): CASNode =>
    ({ id, name: id, type, source: { file: `scripts/${id}` } } as unknown as CASNode);
  const realNode = (id: string): CASNode =>
    ({ id, name: id, type: 'function', source: { file: `src/${id}.rs` } } as unknown as CASNode);
  const entryPoint = (id: string, sourceNode: string, type: string): CASEntryPoint =>
    ({ id, source_node: sourceNode, type, name: id } as unknown as CASEntryPoint);

  it('PURPOSE GATE (R8-B): a capability anchored ONLY on distribution/CI operations is demoted, even with no entity anchor', async () => {
    const nodes = [
      distNode('dist_release_sh', 'distribution_shell_script'),
      distNode('ci_deploy_job', 'ci_job'),
    ];
    const entryPoints = [
      entryPoint('entry_dist_release', 'dist_release_sh', 'cli'),
      entryPoint('entry_ci_deploy', 'ci_deploy_job', 'pipeline'),
    ];
    const cataloged = [
      cap({
        name: 'Manage shell scripts', category: 'core',
        operations: [
          { entry_point_id: 'entry_dist_release', entry_point_type: 'cli', action: 'runs' },
          { entry_point_id: 'entry_ci_deploy', entry_point_type: 'pipeline', action: 'runs' },
        ],
      }),
      // A real product capability alongside it, so the "never let the gate
      // empty the catalog" safeguard doesn't restore the demoted one.
      cap({ name: 'Manages Voice interactions', category: 'core', related_entities: ['ChannelSetup'] }),
    ];
    const out = orch.reconcileCatalogedCapabilities(cataloged, [], [], entryPoints, nodes);
    expect(out.map((c: any) => c.name)).not.toContain('Manage shell scripts');
    expect(out.map((c: any) => c.name)).toContain('Manages Voice interactions');
  });

  it('PURPOSE GATE (R8-B): a deployment-tool product capability with a REAL cli/http anchor is kept, despite an infra-sounding name', async () => {
    const nodes = [
      distNode('dist_release_sh', 'distribution_shell_script'),
      realNode('deploy_cmd'),
    ];
    const entryPoints = [
      entryPoint('entry_dist_release', 'dist_release_sh', 'cli'),
      // The product's OWN "deploy" command — ordinary code, not a
      // distribution/CI artifact — is a real product entry point.
      entryPoint('entry_deploy_cmd', 'deploy_cmd', 'cli'),
    ];
    const cataloged = [
      cap({
        name: 'Deploy and manage binaries', category: 'core',
        operations: [
          { entry_point_id: 'entry_dist_release', entry_point_type: 'cli', action: 'runs' },
          { entry_point_id: 'entry_deploy_cmd', entry_point_type: 'cli', action: 'runs' },
        ],
      }),
    ];
    const out = orch.reconcileCatalogedCapabilities(cataloged, [], [], entryPoints, nodes);
    expect(out.map((c: any) => c.name)).toContain('Deploy and manage binaries');
  });

  it('PURPOSE GATE (R8-B): name fallback only applies when there is no resolvable entity OR operation anchor at all', async () => {
    // No entities, no entry-point/node maps supplied at all (operations
    // reference an entry_point_id but there's nothing to resolve it against)
    // -> falls back to the name-as-machinery-subject signal.
    const cataloged = [
      cap({ name: 'Manage shell scripts', category: 'core', operations: [] }),
      cap({ name: 'Run CI pipeline', category: 'core', operations: [] }),
      cap({ name: 'Manages Voice interactions', category: 'core', operations: [] }),
    ];
    const out = orch.reconcileCatalogedCapabilities(cataloged, [], []);
    const names = out.map((c: any) => c.name);
    expect(names).not.toContain('Manage shell scripts');
    expect(names).not.toContain('Run CI pipeline');
    expect(names).toContain('Manages Voice interactions');
  });
});

describe('comprehension-input gates: test/fixture sources never seed meaning (live Klauro-self leak)', () => {
  // Live defect: journeys from `*.integration.test.ts` and a NestJS-fixture
  // scheduled job surfaced in the live capability list, and a hallucinated
  // capability was sourced from a fixture journey. Structural facts KEEP test
  // nodes/journeys (get_test_summary depends on them); comprehension inputs
  // must exclude them.
  const gateNode = (partial: Partial<CASNode>): CASNode => ({
    id: partial.id || partial.name || 'node',
    name: partial.name || 'Node',
    type: partial.type || 'function',
    source: partial.source || { file: `src/${partial.name || 'node'}.ts`, line: 1 },
    metadata: partial.metadata || {},
    analyzers: partial.analyzers,
  } as CASNode);

  const entryPoint = (id: string, file: string, nodeId: string): any => ({
    id,
    source_node: nodeId,
    type: 'http',
    name: id,
    handler: { node_id: nodeId, method_name: 'handle', file },
  });

  const journey = (id: string, entryPointId: string, handlerNodeId?: string): any => ({
    id,
    name: id,
    journey_kind: 'user-facing',
    entry_point_id: entryPointId,
    entry: { type: 'http', name: id, handler_node_id: handlerNodeId },
    steps: [],
    terminal_effects: { entities_written: [], entities_read: [], external_services: [], messages_emitted: [] },
    terminal_entities: [],
    security_boundaries: [],
    tests_covering: [],
    criticality: 'high',
    call_chain_ids: [],
    exit_point_ids: [],
  });

  const projectPath = '/repo';
  const nodes: CASNode[] = [
    gateNode({ id: 'product-handler', name: 'createOrder', source: { file: 'src/orders/orders.controller.ts', line: 1 } }),
    gateNode({ id: 'test-handler', name: 'doThing', source: { file: 'src/tools/do-thing.integration.test.ts', line: 1 } }),
    gateNode({ id: 'fixture-handler', name: 'scheduledScan', source: { file: 'apps/mcp-server/fixtures/nestjs-schedule/scan.service.ts', line: 1 } }),
  ];
  const entryPoints = [
    entryPoint('ep_product', 'src/orders/orders.controller.ts', 'product-handler'),
    entryPoint('ep_test', 'src/tools/do-thing.integration.test.ts', 'test-handler'),
    entryPoint('ep_fixture', 'apps/mcp-server/fixtures/nestjs-schedule/scan.service.ts', 'fixture-handler'),
  ];

  it('excludes fixture/test-path journeys from comprehension inputs while the journey list itself is untouched', async () => {
    const journeys = [
      journey('journey_product', 'ep_product', 'product-handler'),
      journey('journey_entry_mcp_tool_do_thing_integration_test_ts', 'ep_test', 'test-handler'),
      journey('journey_entry_scheduled_job_nestjs_schedule_scheduledScan_0', 'ep_fixture', 'fixture-handler'),
    ];
    const filtered = orch.filterPrimaryProductJourneys(journeys, entryPoints, nodes, projectPath);
    expect(filtered.map((j: any) => j.id)).toEqual(['journey_product']);
    // Structural facts keep every journey: the input array is not mutated.
    expect(journeys).toHaveLength(3);
  });

  it('falls back to the handler node path when the entry point is unknown, and keeps journeys with no source evidence', async () => {
    const journeys = [
      journey('journey_orphan_test', 'ep_unknown', 'test-handler'),
      journey('journey_orphan_product', 'ep_unknown', 'product-handler'),
      journey('journey_no_evidence', 'ep_unknown', undefined),
    ];
    const filtered = orch.filterPrimaryProductJourneys(journeys, entryPoints, nodes, projectPath);
    expect(filtered.map((j: any) => j.id)).toEqual(['journey_orphan_product', 'journey_no_evidence']);
  });

  it('excludes fixture-sourced data entities from comprehension entity seeds', async () => {
    const entities = [
      {
        id: 'entity_order', name: 'Order', schema_source: 'src/orders/order.entity.ts',
        lifecycle: { created_by: ['product-handler'], read_by: [], updated_by: [], deleted_by: [] },
      },
      {
        id: 'entity_fixture', name: 'ScanResult', schema_source: 'apps/mcp-server/fixtures/nestjs-schedule/scan-result.entity.ts',
        lifecycle: { created_by: ['fixture-handler'], read_by: [], updated_by: [], deleted_by: [] },
      },
      {
        id: 'entity_test_lifecycle_only', name: 'Widget', schema_source: undefined,
        lifecycle: { created_by: ['test-handler'], read_by: [], updated_by: [], deleted_by: [] },
      },
    ] as unknown as CASDataEntity[];
    const filtered = orch.filterPrimaryProductDataEntities(entities, nodes, projectPath);
    expect(filtered.map((e: any) => e.id)).toEqual(['entity_order']);
  });

  it('framework list for the narrative excludes fixture-sourced, adapter-shim, and library-category frameworks', async () => {
    // Only framework-type analyzers contribute a framework NAME (drops library
    // category labels); the evidence must be product-path (drops fixture apps and
    // test files); and it must be a real application surface (drops adapter shims —
    // a lone middleware/module node the way klauro-sdk-py's telemetry adapters look).
    const contributions = [
      { analyzer_id: 'nestjs', analyzer_type: 'framework', analyzer_name: 'NestJS Framework Analyzer' },
      { analyzer_id: 'django', analyzer_type: 'framework', analyzer_name: 'Django Framework Analyzer' },
      { analyzer_id: 'fastapi', analyzer_type: 'framework', analyzer_name: 'FastAPI Framework Analyzer' },
      { analyzer_id: 'auth', analyzer_type: 'library', analyzer_name: 'Auth Library Analyzer' },
    ];
    const frameworkNodes: CASNode[] = [
      // Real product surface (controller) contributed by a framework analyzer → kept.
      gateNode({ id: 'nest-ctrl', name: 'UsersController', type: 'controller', metadata: { framework: 'NestJS' }, source: { file: 'src/users/users.controller.ts', line: 1 }, analyzers: ['nestjs'] }),
      // Fixture-sourced django app → gated by product path.
      gateNode({ id: 'django-fixture', name: 'urls', type: 'route', metadata: { framework: 'Django' }, source: { file: 'apps/mcp-server/fixtures/framework-bench/django-app/urls.py', line: 1 }, analyzers: ['django'] }),
      // Product-path fastapi evidence but only an ADAPTER-SHIM middleware node (no
      // route/app surface) — the exact klauro-sdk-py false positive → excluded.
      gateNode({ id: 'fastapi-shim', name: 'KlauroASGIMiddleware', type: 'middleware', metadata: { framework: 'FastAPI' }, source: { file: 'packages/klauro-sdk-py/src/klauro_telemetry/middleware.py', line: 1 }, analyzers: ['fastapi'] }),
      // Library-analyzer CATEGORY label stamped onto a product route → excluded (not a framework).
      gateNode({ id: 'auth-route', name: 'login', type: 'route', metadata: { framework: 'authentication and authorization' }, source: { file: 'src/auth/auth.controller.ts', line: 1 }, analyzers: ['auth'] }),
    ];
    const frameworks = orch.frameworkNamesForPurpose(contributions, frameworkNodes, projectPath);
    expect(frameworks).toContain('NestJS');
    expect(frameworks).not.toContain('Django');
    expect(frameworks).not.toContain('FastAPI');
    expect(frameworks).not.toContain('authentication and authorization');
  });
});

describe('terminal-outputs prompt fact is kind-filtered (no raw node names as outputs)', () => {
  // Live defect: descriptions cited UI pages/adapter classes (GraphExplorer,
  // InMemoryMemoryGraphAdapter) as "terminal outputs". The prompt list must
  // come from api-response/persisted-kind entities.
  const flowGraph = { capabilities: [], flows: [] } as any;

  const factsWith = (dataEntities: CASDataEntity[]): Record<string, unknown> => {
    orch.activeTerminalSignal = {
      ranked_entities: [
        { name: 'AssetAnalysis', score: 9, journey_count: 4, write_journeys: 3, read_journeys: 1, user_facing_journeys: 3 },
        { name: 'GraphExplorer', score: 7, journey_count: 2, write_journeys: 0, read_journeys: 2, user_facing_journeys: 2 },
        { name: 'InMemoryMemoryGraphAdapter', score: 5, journey_count: 1, write_journeys: 1, read_journeys: 0, user_facing_journeys: 0 },
        { name: 'OrderQuery', score: 4, journey_count: 1, write_journeys: 0, read_journeys: 1, user_facing_journeys: 1 },
      ],
      ranked_stages: [],
      ranked_capabilities: [],
      domain_seed_text: 'AssetAnalysis',
    };
    try {
      return orch.buildAIInterpretationFacts(
        'sys', [], [], [], [], flowGraph, [], [], [], { concepts: [], evidence: [] }, dataEntities, ''
      );
    } finally {
      orch.activeTerminalSignal = undefined;
    }
  };

  const entity = (name: string, kind?: string): CASDataEntity => ({
    id: `entity_${name}`,
    name,
    kind,
    lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] },
  } as unknown as CASDataEntity);

  it('keeps api-response/persisted entities and drops raw node names and non-output kinds', async () => {
    const facts = factsWith([
      entity('AssetAnalysis', 'api-response'),
      entity('OrderQuery', 'request-dto'),
    ]);
    const outputs = (facts.terminalOutputs as string[]) || [];
    expect(outputs.some(o => o.startsWith('AssetAnalysis'))).toBe(true);
    expect(outputs.some(o => o.startsWith('GraphExplorer'))).toBe(false);
    expect(outputs.some(o => o.startsWith('InMemoryMemoryGraphAdapter'))).toBe(false);
    expect(outputs.some(o => o.startsWith('OrderQuery'))).toBe(false);
  });

  it('gives an entity with unknown kind the benefit of the doubt, but never an unresolved node name', async () => {
    const facts = factsWith([entity('AssetAnalysis', undefined)]);
    const outputs = (facts.terminalOutputs as string[]) || [];
    expect(outputs.some(o => o.startsWith('AssetAnalysis'))).toBe(true);
    expect(outputs.some(o => o.startsWith('GraphExplorer'))).toBe(false);
  });

  it('passes the ranked list through unchanged when no entity catalog exists to resolve against', async () => {
    const facts = factsWith([]);
    const outputs = (facts.terminalOutputs as string[]) || [];
    expect(outputs.some(o => o.startsWith('AssetAnalysis'))).toBe(true);
    expect(outputs.some(o => o.startsWith('GraphExplorer'))).toBe(true);
  });
});

describe('stripped-sentence grammar guard and repetition collapse (live mtg/hercules defects)', () => {
  it('repairs the live dangling-clause stump "...graph evidence for."', async () => {
    expect(orch.repairStrippedSentenceGrammar('It works by providing telemetry data and graph evidence for.'))
      .toBe('It works by providing telemetry data and graph evidence.');
  });

  it('repairs the live broken-coordination stump "a robust and solution"', async () => {
    expect(orch.repairStrippedSentenceGrammar('The service offers a robust and solution.'))
      .toBe('The service offers a robust solution.');
  });

  it('drops a sentence that cannot be restored to clause shape when other sentences remain', async () => {
    const text = 'The service records analysis runs for agents. Providing a the and.';
    expect(orch.repairStrippedSentenceGrammar(text)).toBe('The service records analysis runs for agents.');
  });

  it('sanitizeAIInterpretation no longer manufactures a dangling "for" from a bare "insights"', async () => {
    const purpose = { primary_domain: 'order-management', core_concepts: ['orders'] } as any;
    const sanitized = orch.sanitizeAIInterpretation(
      'The platform manages customer orders and produces insights.',
      purpose,
      {}
    );
    expect(sanitized.endsWith('for.')).toBe(false);
    expect(sanitized).toContain('graph evidence');
  });

  it('collapses the same domain-justification sentence restated 3x to one sentence', async () => {
    const text = 'The system\'s domain is inferred from its dependencies and entities. ' +
      'The system\'s domain is clearly inferred from its dependencies and entities. ' +
      'The domain of the system is inferred from its entities and dependencies.';
    const collapsed = orch.collapseNearDuplicateSentences(text);
    expect(collapsed.split(/(?<=[.!?])\s+/)).toHaveLength(1);
  });

  it('keeps genuinely distinct sentences intact', async () => {
    const text = 'Klauro analyzes codebases into a relationship graph. Agents query the graph through MCP tools. Telemetry correlates runtime events with static structure.';
    expect(orch.collapseNearDuplicateSentences(text)).toBe(text);
  });

  it('collapses the hercules-style duplicated focus clause across two sentences', async () => {
    const text = 'Hercules is an order platform with a focus on managing customer data and orders. ' +
      'It is built with a focus on managing customer data and orders.';
    const collapsed = orch.collapseNearDuplicateSentences(text);
    expect(collapsed).toBe('Hercules is an order platform with a focus on managing customer data and orders.');
  });
});

describe('behavior-anchored capability derivation (buildBehaviorCapabilities)', () => {
  const localOrch = new AnalyzerOrchestrator() as any;

  const bNode = (partial: Partial<CASNode>): CASNode => ({
    id: 'node',
    name: 'node',
    type: 'function',
    ...partial,
  } as CASNode);

  const mcpToolEntry = (name: string, index: number): { node: CASNode; entry: CASEntryPoint } => {
    const nodeId = `mcp_tool_${name}_${index}`;
    return {
      node: bNode({ id: nodeId, name, type: 'mcp_tool' as any, source: { file: `src/tools/${name}.ts` } as any }),
      entry: {
        id: `entry_${nodeId}`,
        source_node: nodeId,
        type: 'message',
        name,
        trigger: { method: 'registerTool', path: name },
        handler: { node_id: nodeId, method_name: name, file: `src/tools/${name}.ts` },
      } as CASEntryPoint,
    };
  };

  const socketEntry = (event: string, index: number): { node: CASNode; entry: CASEntryPoint } => {
    const nodeId = `socket_file_${index}`;
    return {
      node: bNode({ id: nodeId, name: 'socket.ts', type: 'file', source: { file: 'src/server/socket.ts' } as any }),
      entry: {
        id: `entry_socket_${event.replace(/[^a-zA-Z0-9]/g, '_')}`,
        source_node: nodeId,
        type: 'event',
        name: `SOCKET ${event}`,
        trigger: { event },
        metadata: { framework: 'socket.io' },
      } as CASEntryPoint,
    };
  };

  it('derives ONE surface capability from a large diverse mcp_tool registration family', async () => {
    // 14 tools, diverse names (no dominant prefix family) — the registration
    // surface itself is the capability, exactly one.
    const toolNames = [
      'get_summary', 'get_call_chain', 'search_nodes', 'semantic_search',
      'analyze_codebase', 'get_route_table', 'get_entry_points', 'get_data_entities',
      'assess_change_risk', 'plan_parallel_work', 'get_coding_context', 'get_erd',
      'validate_agent_change', 'preflight_agent_change',
    ];
    const fixtures = toolNames.map((name, index) => mcpToolEntry(name, index));
    const capabilities = await localOrch.buildBehaviorCapabilities(
      fixtures.map(fixture => fixture.entry),
      fixtures.map(fixture => fixture.node),
      [],
      []
    );

    expect(capabilities).toHaveLength(1);
    const capability = capabilities[0];
    expect(capability.structural_label).toMatch(/Mcp Tool.*Surface/i);
    // Awaiting-AI naming contract: placeholder name, no name_source yet.
    expect(capability.name_source).toBeUndefined();
    expect(capability.name_generation?.reason).toBe('awaiting-ai-comprehension');
    // SURFACES ARE NOT CAPABILITIES: buildBehaviorCapabilities output is
    // never 'core' and criticality is capped at 'medium' — it is routed into
    // the separate behavior_surfaces navigation tier by buildSystemCapabilities,
    // never system_capabilities/top_capabilities, so it can never outrank or
    // out-criticality a real domain capability.
    expect(capability.category).toBe('internal');
    expect(capability.criticality).toBe('medium');
    expect(capability.operations.length).toBeGreaterThan(0);
    expect(capability.operations.every((operation: any) => operation.entry_point_type === 'message')).toBe(true);
  });

  it('derives shared-prefix socket event families (game_*) as capabilities, ignoring DOM click/change noise', async () => {
    const events = [
      'game:action', 'game:pass-priority', 'game:pass-turn', 'game:concede',
      'game:mulligan-keep', 'game:reconnect',
      'lobby:create', 'lobby:join', 'lobby:leave', 'lobby:start',
      'chat:send', 'chat:quick',
    ];
    const fixtures = events.map((event, index) => socketEntry(event, index));
    // DOM interaction handlers must never form or pollute a behavior family.
    const domEntries: CASEntryPoint[] = Array.from({ length: 20 }, (_, index) => ({
      id: `entry_dom_${index}`,
      source_node: 'dom_node',
      type: 'event',
      name: `HomePage click`,
      trigger: { event: 'click' },
    } as CASEntryPoint));

    const capabilities = await localOrch.buildBehaviorCapabilities(
      [...fixtures.map(fixture => fixture.entry), ...domEntries],
      [...fixtures.map(fixture => fixture.node), bNode({ id: 'dom_node', name: 'HomePage', type: 'component' })],
      [],
      []
    );

    const labels = capabilities.map((capability: any) => capability.structural_label);
    expect(labels).toContain('Game Event Surface');
    expect(labels).toContain('Lobby Event Surface');
    // chat has only 2 events — below the family threshold, no capability.
    expect(labels.join(' ')).not.toMatch(/\bChat\b/);
    // No surface-level "Event Surface" from the generic event type, and no
    // DOM-noise capability.
    expect(labels).not.toContain('Event Surface');
    expect(labels.join(' ')).not.toMatch(/click/i);
    const game = capabilities.find((capability: any) => capability.structural_label === 'Game Event Surface');
    expect(game.criticality_factors.join(' ')).toContain("family ('game')");
    expect(game.criticality_factors.join(' ')).toContain('socket.io');
  });

  it('merges a behavior cluster into an overlapping entity-anchored capability instead of duplicating', async () => {
    // Socket game family whose handlers reach the Game entity, while an
    // entity-anchored "Game" capability already exists → MERGE, not duplicate.
    const events = ['game:action', 'game:concede', 'game:pass-turn', 'game:reconnect'];
    const fixtures = events.map((event, index) => socketEntry(event, index));
    const handlerToEngine: CASEdge[] = fixtures.map((fixture, index) => ({
      id: `edge_${index}`,
      source: fixture.node.id,
      target: 'game-engine',
      type: 'calls',
    } as CASEdge));
    const engineNode = bNode({ id: 'game-engine', name: 'GameEngine', type: 'class', source: { file: 'src/server/game/GameEngine.ts' } as any });
    const gameEntity = {
      id: 'entity-game',
      name: 'Game',
      type: 'entity',
      fields: [],
      lifecycle: { created_by: ['game-engine'], read_by: ['game-engine'], updated_by: ['game-engine'], deleted_by: [] },
      relationships: [],
    } as any;

    const entityCapability = {
      id: 'cap_game',
      name: 'Game',
      description: '',
      category: 'supporting',
      operations: [],
      related_entities: ['entity-game'],
      related_domains: ['game'],
      criticality: 'low',
      criticality_factors: [],
    } as any;
    const capabilities = [entityCapability];

    const candidates = await localOrch.buildBehaviorCapabilities(
      fixtures.map(fixture => fixture.entry),
      [...fixtures.map(fixture => fixture.node), engineNode],
      handlerToEngine,
      [gameEntity]
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].related_entities).toContain('entity-game');

    const merged = localOrch.mergeBehaviorCapabilityIntoExisting(candidates[0], capabilities);
    expect(merged).toBe(true);
    expect(capabilities).toHaveLength(1);
    expect(entityCapability.operations.length).toBeGreaterThan(0);
    // CRITICALITY/CATEGORY ARE NEVER BOOSTED BY A MERGED SURFACE (docs/
    // SEMANTIC-MODEL.md purpose test + the criticality invariant): the
    // merged-in surface candidate contributes operations/entities/domains
    // ONLY. entityCapability's own criticality/category — its real evidence —
    // is unchanged by absorbing a surface whose handlers happen to reach the
    // same records.
    expect(entityCapability.criticality).toBe('low');
    expect(entityCapability.category).toBe('supporting');
  });

  it('exercises count restraint: no behavior capability from small or prefix-less surfaces, hard cap overall', async () => {
    // 3 cli commands (below family threshold) + 5 diverse cli commands with
    // action-verb prefixes only → nothing.
    const cliEntries: CASEntryPoint[] = [
      'deploy:web', 'deploy:api', 'deploy:docs',
      'get_thing', 'run_thing', 'list_thing', 'create_thing', 'update_thing',
    ].map((name, index) => ({
      id: `entry_cli_${index}`,
      source_node: `cli_${index}`,
      type: 'cli',
      name,
    } as CASEntryPoint));
    const cliNodes = cliEntries.map((entry, index) => bNode({ id: `cli_${index}`, name: entry.name, type: 'function' }));

    const capabilities = await localOrch.buildBehaviorCapabilities(cliEntries, cliNodes, [], []);
    expect(capabilities).toHaveLength(0);
  });

  it('R8-C: enum_variant-backed cli entries (Rust clap #[derive(Subcommand)] variants) never form their own "Enum Variant Surface" — they fall in with the real cli family', async () => {
    // Reproduces the zerac/poc CAS (Rust ZTNA product, v1.0.104): rust-analyzer.ts
    // emits each clap Subcommand enum variant as its own 'enum_variant' node
    // PLUS a real 'cli' entry point rooted on it. Before the fix, 'enum_variant'
    // wasn't in genericNodeTypes, so the family key picked the NODE type over
    // the entry TYPE and these 12 diverse subcommands formed a bogus "Enum
    // Variant Surface" standing next to the real "...Cli...Surface" family
    // built from ordinary-function-backed cli commands sharing the 'policy'
    // prefix.
    const enumVariantNames = [
      'connect', 'disconnect', 'login', 'logout', 'enroll', 'revoke',
      'diagnose', 'upgrade', 'version', 'reload', 'inspect', 'quarantine',
    ];
    const enumVariantEntries: CASEntryPoint[] = enumVariantNames.map((name, index) => ({
      id: `entry_variant_${index}`,
      source_node: `variant_${index}`,
      type: 'cli',
      name,
    } as CASEntryPoint));
    const enumVariantNodes = enumVariantNames.map((name, index) =>
      bNode({ id: `variant_${index}`, name, type: 'enum_variant' as any }));

    const policyEntries: CASEntryPoint[] = ['policy_get', 'policy_set', 'policy_list', 'policy_delete']
      .map((name, index) => ({
        id: `entry_policy_${index}`,
        source_node: `policy_fn_${index}`,
        type: 'cli',
        name,
      } as CASEntryPoint));
    const policyNodes = policyEntries.map((entry, index) =>
      bNode({ id: `policy_fn_${index}`, name: entry.name, type: 'function' }));

    const capabilities = await localOrch.buildBehaviorCapabilities(
      [...enumVariantEntries, ...policyEntries],
      [...enumVariantNodes, ...policyNodes],
      [],
      []
    );

    const labels = capabilities.map((capability: any) => capability.structural_label);
    // No enum_variant-keyed family/surface ever forms.
    expect(labels.join(' ')).not.toMatch(/enum.?variant/i);
    // The real cli family (shared 'policy' prefix, ordinary function nodes)
    // still forms its cli-kind surface.
    expect(labels.some((label: string) => /cli/i.test(label) && /policy/i.test(label))).toBe(true);
    // Every operation on every surviving capability is a genuine cli entry —
    // none is anchored on the enum_variant node family.
    for (const capability of capabilities) {
      for (const operation of capability.operations) {
        expect(operation.entry_point_type).toBe('cli');
      }
    }
  });

  it('surfaces behavior capabilities into behavior_surfaces (not system_capabilities) through buildSystemCapabilities end-to-end', async () => {
    const toolNames = [
      'get_summary', 'get_call_chain', 'search_nodes', 'semantic_search',
      'analyze_codebase', 'get_route_table', 'get_entry_points', 'get_data_entities',
      'assess_change_risk', 'plan_parallel_work', 'get_coding_context', 'get_erd',
    ];
    const fixtures = toolNames.map((name, index) => mcpToolEntry(name, index));
    const { capabilities, behaviorSurfaces } = await localOrch.buildSystemCapabilities(
      fixtures.map(fixture => fixture.entry),
      [],
      fixtures.map(fixture => fixture.node),
      []
    );
    // SURFACES ARE NOT CAPABILITIES: the standalone (unmerged) MCP-tool
    // registration surface lands in behaviorSurfaces, never in the ranked
    // `capabilities` list — this is what keeps it out of top_capabilities.
    const domainLabels = capabilities.map((capability: any) => capability.structural_label || capability.name);
    expect(domainLabels.some((label: string) => /Mcp Tool.*Surface/i.test(label))).toBe(false);
    const surfaceLabels = behaviorSurfaces.map((surface: any) => surface.structural_label || surface.name);
    expect(surfaceLabels.some((label: string) => /Mcp Tool.*Surface/i.test(label))).toBe(true);
    const surface = behaviorSurfaces.find((s: any) => /Mcp Tool.*Surface/i.test(s.structural_label || s.name));
    expect(surface.category).toBe('internal');
    expect(['medium', 'low']).toContain(surface.criticality);
  });
});

describe('top-down capability evidence (C2)', () => {
  it('extracts verbatim product framing from a README (title + opening paragraph)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-topdown-readme-'));
    try {
      fs.writeFileSync(
        path.join(root, 'README.md'),
        '# Arcane Table\n\n![build](https://img.shields.io/badge/x)\n\nArcane Table is a private web-based Magic: The Gathering Commander platform for real-time multiplayer games.\n\n## Setup\n\n- run npm install\n'
      );
      const signal = orch.extractProjectTextSignal(root);
      expect(signal.productDocTitle).toBe('Arcane Table');
      expect(signal.productDocSummary).toMatch(/Commander platform/);
      // Badge line and the "Setup" list must not leak into the product summary.
      expect(signal.productDocSummary).not.toMatch(/shields\.io|npm install/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to a PRD/product doc when no README states the product, skipping bold metadata', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-topdown-prd-'));
    try {
      fs.writeFileSync(
        path.join(root, 'PRD.md'),
        '# Arcane Table - MTG Commander Platform\n## Product Requirements Document (PRD)\n\n**Version:** 1.1\n**Status:** Draft\n\n---\n\n## 1. Executive Summary\n\nArcane Table is a private, web-based Magic: The Gathering Commander platform designed for friends and family to play the full Commander experience digitally.\n'
      );
      const signal = orch.extractProjectTextSignal(root);
      expect(signal.productDocTitle).toBe('Arcane Table - MTG Commander Platform');
      expect(signal.productDocSummary).toMatch(/Commander platform designed for friends/);
      expect(signal.productDocSummary).not.toMatch(/Version|Status|Draft/);
      expect(signal.evidence).toContain('PRD.md');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT treat an agent-tooling CLAUDE.md as product framing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-topdown-noproductdoc-'));
    try {
      fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Instructions\n\nDo not take shortcuts. Fix things properly.\n');
      const signal = orch.extractProjectTextSignal(root);
      expect(signal.productDocTitle).toBeUndefined();
      expect(signal.productDocSummary).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('partitions candidate operations per capability instead of broadcasting one pool (task #17)', async () => {
    // Reproduces the degenerate shape from a stored real CAS (autonomous-klauro):
    // every capability name shares a repo-dominant token ("codebase"), so token
    // matching alone cross-wired ALL candidates to ALL items and every capability
    // shipped the IDENTICAL operations list — which made every capability
    // 'primary' for every anchored flow downstream. Entities + best-match
    // assignment must partition the pools.
    const original = (aiService as any).generateComponentDescription;
    (aiService as any).generateComponentDescription = async () => JSON.stringify({
      capabilities: [
        { name: 'Exposes codebase analysis', description: 'Analyzes source repositories and produces structural analysis output for agent consumption.', category: 'core', entities: ['Analysis'], journeys: [] },
        { name: 'Tracks codebase changes', description: 'Tracks change reports across repository revisions so agents can diff behavior over time.', category: 'supporting', entities: ['ChangeReport'], journeys: [] },
        { name: 'Secures codebase access', description: 'Maintains security contexts governing which accounts may read a given analysis.', category: 'supporting', entities: ['SecurityContext'], journeys: [] },
      ],
    });
    try {
      const dataEntities = [
        { id: 'entity_analysis', name: 'Analysis' },
        { id: 'entity_changereport', name: 'ChangeReport' },
        { id: 'entity_securitycontext', name: 'SecurityContext' },
      ];
      const mkOps = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => ({
        entry_point_id: `node:${prefix}_${i}`, entry_point_type: 'internal', action: 'Coordinate', path_or_command: `src/${prefix}.ts`,
      }));
      const catalog = await orch.aiExtractCapabilityCatalog({
        systemName: 'ak',
        enhancedSystemPurpose: { primary_domain: 'analysis', core_concepts: [] },
        frameworks: [], userJourneys: [],
        dataEntities,
        candidateCapabilities: [
          { name: 'Analysis Management', related_entities: ['entity_analysis'], operations: mkOps('analysis', 4) },
          { name: 'Change Report Management', related_entities: ['entity_changereport'], operations: mkOps('change', 3) },
          { name: 'Security Context Management', related_entities: ['entity_securitycontext'], operations: mkOps('security', 2) },
        ],
        externalServices: [], flowGraph: { capabilities: [] },
        projectTextSignal: { concepts: [], evidence: [] }, budgetMs: 30000,
      });
      expect(catalog.length).toBe(3);
      const opSets = catalog.map((cap: any) => JSON.stringify((cap.operations || []).map((op: any) => op.entry_point_id).sort()));
      // The defect: distinct op sets == 1. The fix: each capability owns its own.
      expect(new Set(opSets).size).toBe(3);
      const byName = new Map(catalog.map((cap: any) => [cap.name, cap]));
      expect((byName.get('Exposes codebase analysis') as any).operations.every((op: any) => op.entry_point_id.startsWith('node:analysis_'))).toBe(true);
      expect((byName.get('Tracks codebase changes') as any).operations.every((op: any) => op.entry_point_id.startsWith('node:change_'))).toBe(true);
      expect((byName.get('Secures codebase access') as any).operations.every((op: any) => op.entry_point_id.startsWith('node:security_'))).toBe(true);
    } finally {
      (aiService as any).generateComponentDescription = original;
    }
  });

  it('feeds top_down_signals + the purpose test into the catalog prompt, and omits the block when absent', async () => {
    const captured: any[] = [];
    const original = (aiService as any).generateComponentDescription;
    (aiService as any).generateComponentDescription = async (arg: any) => {
      captured.push(arg);
      return JSON.stringify({ capabilities: [{ name: 'Play Commander matches', description: 'Lets friends play full Magic Commander games together in real time online.', category: 'core', entities: [], journeys: [] }] });
    };
    try {
      const withSignal = {
        concepts: [],
        evidence: ['PRD.md'],
        productDocTitle: 'Arcane Table - MTG Commander Platform',
        productDocSummary: 'A web-based Magic: The Gathering Commander platform with real-time multiplayer and AI opponents.',
      };
      await orch.aiExtractCapabilityCatalog({
        systemName: 'mtg',
        enhancedSystemPurpose: { primary_domain: 'games', core_concepts: [] },
        frameworks: [], userJourneys: [], dataEntities: [],
        candidateCapabilities: [{ name: 'Game session', related_entities: [], operations: [] }],
        externalServices: [], flowGraph: { capabilities: [] },
        projectTextSignal: withSignal, budgetMs: 30000,
      });
      const withCtx = captured[captured.length - 1].additionalContext;
      expect(withCtx.facts.top_down_signals.product_title).toMatch(/Arcane Table/);
      expect(withCtx.facts.top_down_signals.product_overview).toMatch(/Commander/);
      expect(withCtx.task).toMatch(/PURPOSE TEST/);
      expect(withCtx.task).toMatch(/access control/i);

      // No product doc => the block is omitted entirely (evidence-gated, no fabrication).
      await orch.aiExtractCapabilityCatalog({
        systemName: 'bare',
        enhancedSystemPurpose: { primary_domain: 'x', core_concepts: [] },
        frameworks: [], userJourneys: [], dataEntities: [],
        candidateCapabilities: [], externalServices: [], flowGraph: { capabilities: [] },
        projectTextSignal: { concepts: [], evidence: [] }, budgetMs: 30000,
      });
      const bareCtx = captured[captured.length - 1].additionalContext;
      expect(bareCtx.facts.top_down_signals).toBeUndefined();
    } finally {
      (aiService as any).generateComponentDescription = original;
    }
  });

  it('THE CUT: entity-rich domain candidates outrank entity-less high-volume anchors in the bounded prompt window', () => {
    // Live truckspy: 186 candidates -> a 24-name window taken in criticality-
    // sorted order, so entity-less runtime anchors (huge operation counts)
    // monopolized the window and dispatch/safety/fuel-style entity-rich route
    // areas never reached the AI catalog at all.
    const mkOps = (n: number) => Array.from({ length: n }, (_, i) => ({
      entry_point_id: `ep_${i}`, entry_point_type: 'http', action: 'Handle', path_or_command: `/x/${i}`,
    }));
    const internalOps = (n: number) => Array.from({ length: n }, (_, i) => ({
      entry_point_id: `node:n_${i}`, entry_point_type: 'internal', action: 'Coordinate', path_or_command: `src/n_${i}.ts`,
    }));
    const entityRich = { name: 'Dispatch Resource Management', related_entities: ['entity_booking', 'entity_stop', 'entity_trip'], related_domains: ['dispatch'], operations: mkOps(4) };
    const journeyCorroborated = { name: 'Inspection Resource Management', related_entities: [], related_domains: ['inspection'], operations: mkOps(2) };
    const entitylessAnchor = { name: 'Runtime Coordination', related_entities: [], related_domains: ['runtime'], operations: internalOps(200) };
    const journeys = [{ name: 'Create inspection report' }] as any[];
    const ranked = orch.rankCatalogPromptCandidates(
      [entitylessAnchor, journeyCorroborated, entityRich] as any[],
      journeys
    ).map((candidate: any) => candidate.name);
    // Grounded candidates (entities or journey-terminology corroboration)
    // strictly precede the entity-less anchor, whatever its operation volume.
    expect(ranked.indexOf('Dispatch Resource Management')).toBeLessThan(ranked.indexOf('Runtime Coordination'));
    expect(ranked.indexOf('Inspection Resource Management')).toBeLessThan(ranked.indexOf('Runtime Coordination'));
    // Entity grounding outranks journey-only grounding.
    expect(ranked.indexOf('Dispatch Resource Management')).toBeLessThan(ranked.indexOf('Inspection Resource Management'));
  });

  it('UNGROUNDED-FILLER GATE: an AI-asserted "core" item with 0 entities, 0 operations, and 0 real journeys is dropped ("Manage pricing"), while a top-down-corroborated one survives', async () => {
    const original = (aiService as any).generateComponentDescription;
    (aiService as any).generateComponentDescription = async () => JSON.stringify({
      capabilities: [
        // The live truckspy escape: category:'core' used to bypass the gate entirely.
        { name: 'Manage pricing', description: 'Maintains pricing records, rate decisions, and billing adjustments for operators.', category: 'core', entities: [], journeys: [] },
        // Fabricated journey strings must not count as journey grounding.
        { name: 'Coordinate partners', description: 'Coordinates partner onboarding workflows and partner account decisions end to end.', category: 'core', entities: [], journeys: ['Totally invented journey'] },
        // Entity-grounded core item survives as before.
        { name: 'Manage trips', description: 'Tracks Trip records from booking through completion for dispatch operators.', category: 'core', entities: ['Trip'], journeys: [] },
        // 0-entity/0-op core item whose SUBJECT is corroborated by a real
        // journey's vocabulary (top-down terminology) survives — the RAISE force.
        { name: 'Manage inspections', description: 'Owns inspection reports and their review workflow decisions for fleet compliance.', category: 'core', entities: [], journeys: [] },
      ],
    });
    try {
      const catalog = await orch.aiExtractCapabilityCatalog({
        systemName: 'fleet',
        enhancedSystemPurpose: { primary_domain: 'fleet', core_concepts: [] },
        frameworks: [],
        userJourneys: [{ name: 'Create inspection report' }] as any[],
        dataEntities: [{ id: 'entity_trip', name: 'Trip' }] as any[],
        candidateCapabilities: [],
        externalServices: [], flowGraph: { capabilities: [] } as any,
        projectTextSignal: { concepts: [], evidence: [] } as any, budgetMs: 30000,
      });
      const names = catalog.map((capability: any) => capability.name);
      expect(names).not.toContain('Manage pricing');
      expect(names).not.toContain('Coordinate partners');
      expect(names).toContain('Manage trips');
      expect(names).toContain('Manage inspections');
    } finally {
      (aiService as any).generateComponentDescription = original;
    }
  });
});

describe('thin-catalog nudge (defect #33 — catalog VARIANCE: v1.0.83 returned 1 item, v1.0.84 returned 6 on the SAME 45k-node CAS)', () => {
  const dataEntities = [
    { id: 'entity_widget', name: 'Widget' },
    { id: 'entity_gadget', name: 'Gadget' },
    { id: 'entity_gizmo', name: 'Gizmo' },
  ];
  // Raw deterministic candidate labels — these are the "families" the nudge
  // must enumerate. Deliberately worded DIFFERENTLY from the AI-authored
  // output names below: an AI item whose name verbatim-echoes one of these
  // is rejected by isRawCandidateLabelName (see that guard), so the fixture
  // must exercise the nudge without tripping it.
  const candidateCapabilities = [
    { name: 'Widget route area', related_entities: ['entity_widget'], operations: [{ entry_point_id: 'ep_w_1', entry_point_type: 'http', action: 'Manage' }] },
    { name: 'Gadget route area', related_entities: ['entity_gadget'], operations: [{ entry_point_id: 'ep_g_1', entry_point_type: 'http', action: 'Manage' }] },
    { name: 'Gizmo route area', related_entities: ['entity_gizmo'], operations: [{ entry_point_id: 'ep_z_1', entry_point_type: 'http', action: 'Manage' }] },
  ];
  const baseInput = {
    systemName: 'thin-catalog-fixture',
    enhancedSystemPurpose: { primary_domain: 'widgets', core_concepts: [] },
    frameworks: [], userJourneys: [],
    dataEntities,
    candidateCapabilities,
    externalServices: [], flowGraph: { capabilities: [] } as any,
    projectTextSignal: { concepts: [], evidence: [] } as any, budgetMs: 30000,
  };

  it('spends one extra targeted attempt when the catalog collapses to a single item, enumerating the distinct deterministic families, and keeps the richer result', async () => {
    const original = (aiService as any).generateComponentDescription;
    const captured: any[] = [];
    let callCount = 0;
    (aiService as any).generateComponentDescription = async (arg: any) => {
      callCount++;
      captured.push(arg);
      if (callCount <= 2) {
        // Both regular attempts collapse everything into one merged item —
        // exactly the measured v1.0.83 shape.
        return JSON.stringify({
          capabilities: [
            { name: 'Manage all product records', description: 'Owns Widget, Gadget, and Gizmo records across the whole platform.', category: 'core', entities: ['Widget'], journeys: [] },
          ],
        });
      }
      // Third call = the thin-catalog nudge. It must be told the distinct
      // families by name, and this time returns one grounded capability PER
      // family — the measured v1.0.84 shape.
      return JSON.stringify({
        capabilities: [
          { name: 'Manage widgets', description: 'Tracks Widget records from creation through retirement for operators.', category: 'core', entities: ['Widget'], journeys: [] },
          { name: 'Manage gadgets', description: 'Tracks Gadget records and their configuration state for operators.', category: 'core', entities: ['Gadget'], journeys: [] },
          { name: 'Manage gizmos', description: 'Tracks Gizmo records and their assembly status for operators.', category: 'core', entities: ['Gizmo'], journeys: [] },
        ],
      });
    };
    try {
      const catalog = await orch.aiExtractCapabilityCatalog(baseInput);
      expect(callCount).toBe(3);
      // The nudge call's retry_hint enumerates the real distinct families by
      // name (evidence already computed deterministically, not invented).
      const nudgeHint = captured[2]?.additionalContext?.retry_hint;
      expect(nudgeHint).toMatch(/Widget route area/);
      expect(nudgeHint).toMatch(/Gadget route area/);
      expect(nudgeHint).toMatch(/Gizmo route area/);
      expect(nudgeHint).toMatch(/only 1 distinct capability/i);
      // The richer (3-item) nudge result replaces the thin 1-item result.
      expect(catalog.length).toBe(3);
      expect(catalog.map((c: any) => c.name).sort()).toEqual(['Manage gadgets', 'Manage gizmos', 'Manage widgets']);
    } finally {
      (aiService as any).generateComponentDescription = original;
    }
  });

  it('scales the nudge ceiling with family evidence (#33 margin: a 5-cap result on a 16-family repo is the same collapse as 3-on-9)', async () => {
    const nouns = ['Widget', 'Gadget', 'Gizmo', 'Sprocket', 'Flange', 'Rotor', 'Stator', 'Bearing', 'Camshaft', 'Piston', 'Valve', 'Gasket', 'Pulley', 'Spindle', 'Bracket', 'Housing'];
    const sixteenFamilies = nouns.map((noun, index) => ({
      name: `${noun} route area`,
      related_entities: [`entity_${noun.toLowerCase()}`],
      operations: [{ entry_point_id: `ep_${index}`, entry_point_type: 'http', action: 'Manage' }],
    }));
    const fiveCaps = nouns.slice(0, 5).map(noun => ({
      name: `Manage ${noun.toLowerCase()}s`,
      description: `Tracks ${noun} records from creation through retirement for operators.`,
      category: 'core', entities: [noun], journeys: [],
    }));
    const original = (aiService as any).generateComponentDescription;
    const captured: any[] = [];
    (aiService as any).generateComponentDescription = async (arg: any) => {
      captured.push(arg);
      // Both regular attempts return FIVE caps (five distinct entity sets —
      // effectively 5, above the old fixed <=3 cutoff). With 16 families the
      // scaled ceiling is max(3, floor(16/3)=5) = 5, so the nudge fires; the
      // nudge attempt returns one purpose cap per family.
      if (captured.length <= 2) return JSON.stringify({ capabilities: fiveCaps });
      return JSON.stringify({
        capabilities: nouns.map(noun => ({
          name: `Manage ${noun.toLowerCase()}s`,
          description: `Tracks ${noun} records and their operating state for teams.`,
          category: 'core', entities: [noun], journeys: [],
        })),
      });
    };
    try {
      const catalog = await orch.aiExtractCapabilityCatalog({
        ...baseInput,
        candidateCapabilities: sixteenFamilies,
        dataEntities: nouns.map(noun => ({ id: `entity_${noun.toLowerCase()}`, name: noun })),
      });
      expect(captured.length).toBe(3); // scaled ceiling admitted the 5-cap undercount
      const hint = String(captured[2]?.additionalContext?.retry_hint || '');
      expect(hint).toContain('16 DISTINCT candidate route-area families');
      expect(hint).toContain('(top 10 listed)');
      expect(catalog.length).toBe(16);
    } finally {
      (aiService as any).generateComponentDescription = original;
    }
  });

  it('does NOT spend the extra attempt when the catalog is already rich (control: healthy multi-item result is left untouched)', async () => {
    const original = (aiService as any).generateComponentDescription;
    let callCount = 0;
    (aiService as any).generateComponentDescription = async () => {
      callCount++;
      return JSON.stringify({
        capabilities: [
          { name: 'Manage widgets', description: 'Tracks Widget records from creation through retirement for operators.', category: 'core', entities: ['Widget'], journeys: [] },
          { name: 'Manage gadgets', description: 'Tracks Gadget records and their configuration state for operators.', category: 'core', entities: ['Gadget'], journeys: [] },
          { name: 'Manage gizmos', description: 'Tracks Gizmo records and their assembly status for operators.', category: 'core', entities: ['Gizmo'], journeys: [] },
        ],
      });
    };
    try {
      const catalog = await orch.aiExtractCapabilityCatalog(baseInput);
      // catalogCountMin floors at 6 here, so both regular attempts run (2
      // calls) — the point under test is that catalog.length (3) !== 1, so
      // the thin-catalog nudge must NOT fire a 3rd call.
      expect(callCount).toBe(2);
      expect(catalog.length).toBe(3);
    } finally {
      (aiService as any).generateComponentDescription = original;
    }
  });

  it('does NOT spend the extra attempt on a genuine 1-family repo (nothing to nudge toward)', async () => {
    const original = (aiService as any).generateComponentDescription;
    let callCount = 0;
    (aiService as any).generateComponentDescription = async () => {
      callCount++;
      return JSON.stringify({
        capabilities: [
          { name: 'Manage widgets', description: 'Tracks Widget records from creation through retirement for operators.', category: 'core', entities: ['Widget'], journeys: [] },
        ],
      });
    };
    try {
      const catalog = await orch.aiExtractCapabilityCatalog({
        ...baseInput,
        // Only ONE distinct deterministic family — the nudge has nothing
        // evidence-backed to enumerate, so it must not fire.
        candidateCapabilities: [candidateCapabilities[0]],
        dataEntities: [dataEntities[0]],
      });
      expect(callCount).toBe(2); // the two regular attempts only, no nudge call
      expect(catalog.length).toBe(1);
    } finally {
      (aiService as any).generateComponentDescription = original;
    }
  });

  it('nudges a SEVERE undercount too: 3 thin caps against 9+ distinct families (rung-5 washup: 3 caps on a 34-entity/309-route Rails app)', async () => {
    // Nine distinct deterministic families — the washup shape in miniature.
    const nouns = ['Widget', 'Gadget', 'Gizmo', 'Sprocket', 'Flange', 'Rotor', 'Stator', 'Bearing', 'Camshaft'];
    const manyFamilies = nouns.map((noun, index) => ({
      name: `${noun} route area`,
      related_entities: [`entity_${noun.toLowerCase()}`],
      operations: [{ entry_point_id: `ep_${index}`, entry_point_type: 'http', action: 'Manage' }],
    }));
    const original = (aiService as any).generateComponentDescription;
    const captured: any[] = [];
    (aiService as any).generateComponentDescription = async (arg: any) => {
      captured.push(arg);
      // First two attempts collapse to 3 thin items; the nudge attempt returns 9.
      if (captured.length <= 2) {
        return JSON.stringify({
          capabilities: [
            { name: 'Create record', description: 'Creates a record in the system for operators to review later.', category: 'core', entities: ['Widget'], journeys: [] },
            { name: 'Update item', description: 'Updates an item in the system when operators change details.', category: 'core', entities: ['Gadget'], journeys: [] },
            { name: 'List things', description: 'Lists things stored in the system so operators can browse them.', category: 'supporting', entities: ['Gizmo'], journeys: [] },
          ],
        });
      }
      return JSON.stringify({
        capabilities: nouns.map(noun => ({
          name: `Manage ${noun.toLowerCase()}s`,
          description: `Tracks ${noun} records from creation through retirement for operators.`,
          category: 'core', entities: [noun], journeys: [],
        })),
      });
    };
    try {
      const catalog = await orch.aiExtractCapabilityCatalog({
        ...baseInput,
        candidateCapabilities: manyFamilies,
        dataEntities: nouns.map(noun => ({ id: `entity_${noun.toLowerCase()}`, name: noun })),
      });
      expect(captured.length).toBe(3); // two regular attempts + the severe-undercount nudge
      const nudgeArg = captured[2];
      const hint = String(nudgeArg?.additionalContext?.retry_hint || JSON.stringify(nudgeArg));
      expect(hint).toContain('only 3 distinct capabilities');
      expect(catalog.length).toBe(9);
    } finally {
      (aiService as any).generateComponentDescription = original;
    }
  });

  it('nudges a CRUD-per-route collapse: 9 raw items over 3 entity sets is EFFECTIVELY 3 (rung-5 washup: entity-set dedupe ran after the count check, so 9 sailed through and persisted as 3)', async () => {
    const nouns = ['Widget', 'Gadget', 'Gizmo', 'Sprocket', 'Flange', 'Rotor', 'Stator', 'Bearing', 'Camshaft'];
    const manyFamilies = nouns.map((noun, index) => ({
      name: `${noun} route area`,
      related_entities: [`entity_${noun.toLowerCase()}`],
      operations: [{ entry_point_id: `ep_${index}`, entry_point_type: 'http', action: 'Manage' }],
    }));
    const crudTrio = (noun: string) => (['Create', 'Update', 'Delete'].map(verb => ({
      name: `${verb} ${noun.toLowerCase()}`,
      description: `Lets users ${verb.toLowerCase()} ${noun.toLowerCase()} records in the system for later review.`,
      category: 'core', entities: [noun], journeys: [],
    })));
    const original = (aiService as any).generateComponentDescription;
    const captured: any[] = [];
    (aiService as any).generateComponentDescription = async (arg: any) => {
      captured.push(arg);
      // First attempt: NINE items but only THREE distinct entity sets (a CRUD
      // trio per entity) — raw count (9) satisfies the minimum so the regular
      // retry loop stops after ONE call; only the effective count (3) reveals
      // the collapse. The nudge attempt returns one purpose cap per family —
      // note its RAW length equals the first attempt's (9 vs 9): only the
      // effective-size comparison accepts it.
      if (captured.length === 1) {
        return JSON.stringify({ capabilities: [...crudTrio('Widget'), ...crudTrio('Gadget'), ...crudTrio('Gizmo')] });
      }
      return JSON.stringify({
        capabilities: nouns.map(noun => ({
          name: `Manage ${noun.toLowerCase()}s`,
          description: `Tracks ${noun} records from creation through retirement for operators.`,
          category: 'core', entities: [noun], journeys: [],
        })),
      });
    };
    try {
      const catalog = await orch.aiExtractCapabilityCatalog({
        ...baseInput,
        candidateCapabilities: manyFamilies,
        dataEntities: nouns.map(noun => ({ id: `entity_${noun.toLowerCase()}`, name: noun })),
      });
      expect(captured.length).toBe(2); // one satisfying regular attempt + the effective-count nudge
      const hint = String(captured[1]?.additionalContext?.retry_hint || '');
      expect(hint).toContain('only 3 distinct capabilities');
      expect(hint).toMatch(/per-route CRUD/);
      // The nudge result REPLACED the CRUD catalog (equal raw length — only
      // the effective-size acceptance makes this true).
      expect(catalog.length).toBe(9);
      expect(catalog.every((item: any) => String(item.name).startsWith('Manage '))).toBe(true);
    } finally {
      (aiService as any).generateComponentDescription = original;
    }
  });
});

describe('splitLargeBehaviorSurfaceByModule (defect #33 — catalog VARIANCE, single-large-surface fallback split)', () => {
  const mkEntry = (name: string, file: string, index: number): CASEntryPoint => ({
    id: `entry_${name}_${index}`,
    source_node: `node_${name}_${index}`,
    type: 'message',
    name,
    trigger: { event: name },
    handler: { node_id: `node_${name}_${index}`, method_name: name, file },
  } as CASEntryPoint);

  const mkSurface = (total: number, opsSource: CASEntryPoint[]): any => ({
    id: 'cap_mcp_tool_surface',
    name: 'Mcp Tool Surface',
    description: `Behavior surface: ${total} mcp tool entry points`,
    category: 'internal',
    operations: opsSource.slice(0, 12).map(ep => ({ entry_point_id: ep.id, entry_point_type: 'message', action: 'Process' })),
    related_entities: [],
    related_domains: ['mcp_tool'],
    criticality: 'medium',
    criticality_factors: [`${total} message entry points form one cohesive behavior surface`],
  });

  it('splits one merged blob into multiple module-grounded capabilities when handlers span distinct modules (Klauro-self shape: tools/ graph/ analysis/)', () => {
    const toolsEntries = Array.from({ length: 6 }, (_, i) => mkEntry(`tool_${i}`, 'src/tools/registry.ts', i));
    const graphEntries = Array.from({ length: 5 }, (_, i) => mkEntry(`graph_${i}`, 'src/graph/api.ts', i));
    const analysisEntries = Array.from({ length: 4 }, (_, i) => mkEntry(`analysis_${i}`, 'src/analysis/engine.ts', i));
    const entryPoints = [...toolsEntries, ...graphEntries, ...analysisEntries];
    const surface = mkSurface(entryPoints.length, entryPoints);

    const result = orch.splitLargeBehaviorSurfaceByModule(surface, entryPoints, []);

    expect(result.length).toBe(3);
    const names = result.map((r: any) => r.name);
    expect(names.some((n: string) => /tools/i.test(n))).toBe(true);
    expect(names.some((n: string) => /graph/i.test(n))).toBe(true);
    expect(names.some((n: string) => /analysis/i.test(n))).toBe(true);
    // Each split capability's operations only reference ITS OWN module's
    // entry points — no cross-module bleed.
    for (const capability of result) {
      const ids = capability.operations.map((operation: any) => operation.entry_point_id);
      const modulesTouched = new Set(ids.map((id: string) => id.replace(/^entry_/, '').split('_')[0]));
      expect(modulesTouched.size).toBe(1);
    }
  });

  it('leaves a genuinely single-module surface unsplit rather than manufacturing groups', () => {
    const entries = Array.from({ length: 15 }, (_, i) => mkEntry(`tool_${i}`, 'src/tools/registry.ts', i));
    const surface = mkSurface(entries.length, entries);

    const result = orch.splitLargeBehaviorSurfaceByModule(surface, entries, []);

    expect(result.length).toBe(1);
    expect(result[0]).toBe(surface); // unchanged reference — no fabricated split
  });

  it('no-ops (returns the surface unchanged) when raw entry points are unavailable', () => {
    const entries = Array.from({ length: 6 }, (_, i) => mkEntry(`tool_${i}`, 'src/tools/registry.ts', i));
    const surface = mkSurface(15, entries);
    const result = orch.splitLargeBehaviorSurfaceByModule(surface, [], []);
    expect(result).toEqual([surface]);
  });
});

describe('capability catalog validity guard + MCP-tool-family merge (Klauro rung-2: caps:1 + product-name collapse)', () => {
  it('drops a description-less raw candidate-label item instead of shipping it as the sole capability', async () => {
    // Reproduces the live Klauro-self defect: the AI catalog stage returned a
    // single malformed item that just echoed a deterministic candidate label
    // back verbatim, with no description field, but WITH entities — which is
    // what let it survive the pre-existing entity-grounded description
    // synthesis fallback. Before the validity guard this then shipped as the
    // sole capability and, because the caller only skips the splice when
    // `extracted.length === 0`, it replaced every real deterministic
    // capability with this one accidental leftover.
    const original = (aiService as any).generateComponentDescription;
    (aiService as any).generateComponentDescription = async () => JSON.stringify({
      capabilities: [
        { name: 'run_shell_script_release_sh_docker_read_2_more', entities: ['ReleaseConfig'] },
      ],
    });
    try {
      const catalog = await orch.aiExtractCapabilityCatalog({
        systemName: 'proof-of-concept',
        enhancedSystemPurpose: { primary_domain: 'dev-tool', core_concepts: [] },
        frameworks: [], userJourneys: [],
        dataEntities: [{ id: 'entity_releaseconfig', name: 'ReleaseConfig' }],
        candidateCapabilities: [
          { name: 'run_shell_script_release_sh_docker_read_2_more', related_entities: [], operations: [] },
        ],
        externalServices: [], flowGraph: { capabilities: [] },
        projectTextSignal: { concepts: [], evidence: [] }, budgetMs: 30000,
      });
      expect(catalog.length).toBe(0);
    } finally {
      (aiService as any).generateComponentDescription = original;
    }
  });

  it('rejects a raw candidate-label name even when entities let a description synthesize', async () => {
    // The name-shape signal must catch the defect even when the item HAD
    // entities (so the entity-grounded description fallback would otherwise
    // paper over the missing description and let it through).
    const original = (aiService as any).generateComponentDescription;
    (aiService as any).generateComponentDescription = async () => JSON.stringify({
      capabilities: [
        { name: 'deploy.sh docker build 3 more', entities: ['ReleaseConfig'] },
      ],
    });
    try {
      const catalog = await orch.aiExtractCapabilityCatalog({
        systemName: 'proof-of-concept',
        enhancedSystemPurpose: { primary_domain: 'dev-tool', core_concepts: [] },
        frameworks: [], userJourneys: [],
        dataEntities: [{ id: 'entity_releaseconfig', name: 'ReleaseConfig' }],
        candidateCapabilities: [],
        externalServices: [], flowGraph: { capabilities: [] },
        projectTextSignal: { concepts: [], evidence: [] }, budgetMs: 30000,
      });
      expect(catalog.length).toBe(0);
    } finally {
      (aiService as any).generateComponentDescription = original;
    }
  });

  it('rejects a raw candidate-label name EVEN WHEN the model supplies a real description for it (real hosted-CAS defect, v1.0.81-dev)', async () => {
    // Measured live on the real prod CAS (Klauro-self, 45k nodes, 2026-07-15):
    // the model paired a verbatim candidateAreas echo — "Run Shell script:
    // release.sh -> Docker read (+2 more)" — with a real, non-empty
    // description ("Triggers a Docker read for release.sh and other
    // scripts."), which let it slip past the old `!rawItemDescription &&
    // isRawCandidateLabelName(...)` guard (that guard only fired when NO
    // description was supplied) and ship as the SOLE system_capabilities
    // entry on the real deployed system. A raw-label-shaped name is never a
    // real capability regardless of whether a description was attached — the
    // guard must run unconditionally so this collapses to catalog.length===0
    // and routes the caller into the near-empty fallback (deterministic
    // candidates, then the merged large-behavior-surface re-derivation)
    // instead of shipping the bad single item.
    const original = (aiService as any).generateComponentDescription;
    (aiService as any).generateComponentDescription = async () => JSON.stringify({
      capabilities: [
        {
          name: 'Run Shell script: release.sh -> Docker read (+2 more)',
          description: 'Triggers a Docker read for release.sh and other scripts.',
          category: 'core',
          entities: ['ReleaseConfig'],
        },
      ],
    });
    try {
      const catalog = await orch.aiExtractCapabilityCatalog({
        systemName: 'proof-of-concept',
        enhancedSystemPurpose: { primary_domain: 'dev-tool', core_concepts: [] },
        frameworks: [], userJourneys: [],
        dataEntities: [{ id: 'entity_releaseconfig', name: 'ReleaseConfig' }],
        candidateCapabilities: [
          { name: 'Run Shell script: release.sh -> Docker read (+2 more)', related_entities: [], operations: [] },
        ],
        externalServices: [], flowGraph: { capabilities: [] },
        projectTextSignal: { concepts: [], evidence: [] }, budgetMs: 30000,
      });
      expect(catalog.length).toBe(0);
    } finally {
      (aiService as any).generateComponentDescription = original;
    }
  });

  it('rejects a raw call-graph chain label ("Run main -> detect_frameworks") shipped as a capability (real hosted-CAS defect, v1.0.83)', async () => {
    // Measured live on the real prod CAS (Klauro-self, v1.0.83, 2026-07-15):
    // after the v1.0.82 guard-decouple, the SOLE system_capabilities entry
    // became "Run main -> detect_frameworks" — a raw entry-point call-graph
    // traversal ("Run <symbol> -> <function>"), not a domain purpose. The
    // v1.0.82 guard only matched file-extension / "shell script" / "+N more"
    // shapes, so this call-chain slipped through. isRawCandidateLabelName now
    // also matches a "Run <symbol> ->" head and any arrow joined to a
    // snake_case code identifier, collapsing the catalog to 0 so the caller
    // routes into the near-empty fallback instead of shipping the traversal.
    const original = (aiService as any).generateComponentDescription;
    (aiService as any).generateComponentDescription = async () => JSON.stringify({
      capabilities: [
        {
          name: 'Run main -> detect_frameworks',
          description: 'Runs the main entry and detects frameworks.',
          category: 'core',
          entities: [],
        },
      ],
    });
    try {
      const catalog = await orch.aiExtractCapabilityCatalog({
        systemName: 'proof-of-concept',
        enhancedSystemPurpose: { primary_domain: 'dev-tool', core_concepts: [] },
        frameworks: [], userJourneys: [],
        dataEntities: [],
        candidateCapabilities: [
          { name: 'Run main -> detect_frameworks', related_entities: [], operations: [] },
        ],
        externalServices: [], flowGraph: { capabilities: [] },
        projectTextSignal: { concepts: [], evidence: [] }, budgetMs: 30000,
      });
      expect(catalog.length).toBe(0);
    } finally {
      (aiService as any).generateComponentDescription = original;
    }
  });

  it('rejects a mechanical program-entry label ("Run .NET Main entry point") shipped as a capability (real Hoggan C# CAS, v1.0.85)', async () => {
    // Measured live on the real prod CAS (Hoggan C#/WPF desktop, v1.0.85,
    // 2026-07-16): "Run .NET Main entry point" shipped as 1 of 5 caps. Naming
    // the runtime entry point is a structural fact, never a user purpose — a
    // real capability says what the program DOES once it starts. Same class as
    // the call-chain labels above; isRawCandidateLabelName now also matches a
    // "Run/Execute/Start ... entry point / main method" mechanical head.
    const original = (aiService as any).generateComponentDescription;
    (aiService as any).generateComponentDescription = async () => JSON.stringify({
      capabilities: [
        { name: 'Run .NET Main entry point', description: 'Runs the .NET Main entry point of the application.', category: 'core', entities: [] },
      ],
    });
    try {
      const catalog = await orch.aiExtractCapabilityCatalog({
        systemName: 'Hoggan Scientific',
        enhancedSystemPurpose: { primary_domain: 'medical-device', core_concepts: [] },
        frameworks: ['WPF'], userJourneys: [],
        dataEntities: [],
        candidateCapabilities: [
          { name: 'Run .NET Main entry point', related_entities: [], operations: [] },
        ],
        externalServices: [], flowGraph: { capabilities: [] },
        projectTextSignal: { concepts: [], evidence: [] }, budgetMs: 30000,
      });
      expect(catalog.length).toBe(0);
    } finally {
      (aiService as any).generateComponentDescription = original;
    }
  });

  it('sanitizes arrow-chain journey echoes to their purpose head instead of shipping the trace (real rpg/server Python CAS, v1.0.96)', async () => {
    // Measured live: the model echoed JOURNEY names verbatim as capability
    // names — all six caps were "action -> outcome" traces ("Create attack ->
    // Currency created"). The head is a genuine purpose phrase; the arrow tail
    // is trace noise. Rejecting outright would collapse the catalog (the
    // deterministic fallback candidates are the same journey names) — so the
    // head is KEPT and the tail dropped. A head that is not a purpose phrase
    // (single word / code-shaped) still rejects the item.
    const original = (aiService as any).generateComponentDescription;
    (aiService as any).generateComponentDescription = async () => JSON.stringify({
      capabilities: [
        { name: 'Create attack -> Currency created', description: 'Players create attacks which generate currency rewards for combat.', category: 'core', entities: ['Currency'] },
        { name: 'Update quest objective -> Quest updated', description: 'Players progress quests by completing objectives across the world.', category: 'core', entities: ['Quest'] },
        { name: 'x -> y', description: 'A meaningless single-letter trace that has no purpose head at all.', category: 'core', entities: [] },
      ],
    });
    try {
      const catalog = await orch.aiExtractCapabilityCatalog({
        systemName: 'Sundered World',
        enhancedSystemPurpose: { primary_domain: 'game-automation', core_concepts: [] },
        frameworks: ['fastapi'], userJourneys: [],
        dataEntities: [
          { id: 'entity_currency', name: 'Currency' },
          { id: 'entity_quest', name: 'Quest' },
        ],
        candidateCapabilities: [
          { name: 'Create attack -> Currency created', related_entities: ['entity_currency'], operations: [] },
          { name: 'Update quest objective -> Quest updated', related_entities: ['entity_quest'], operations: [] },
        ],
        externalServices: [], flowGraph: { capabilities: [] },
        projectTextSignal: { concepts: [], evidence: [] }, budgetMs: 30000,
      });
      const names = catalog.map((c: any) => c.name);
      expect(names).toContain('Create attack');
      expect(names).toContain('Update quest objective');
      expect(names.some((n: string) => /->|→/.test(n))).toBe(false);
      expect(names.some((n: string) => n === 'x' || n === 'x -> y')).toBe(false);
    } finally {
      (aiService as any).generateComponentDescription = original;
    }
  });

  it('keeps a real AI-authored capability whose description was genuinely supplied', async () => {
    // Control: the guard must not reject legitimate output.
    const original = (aiService as any).generateComponentDescription;
    (aiService as any).generateComponentDescription = async () => JSON.stringify({
      capabilities: [
        { name: 'Automate release packaging', description: 'Packages and publishes versioned release artifacts so operators can ship builds.', category: 'core', entities: ['ReleaseConfig'], journeys: [] },
      ],
    });
    try {
      const catalog = await orch.aiExtractCapabilityCatalog({
        systemName: 'proof-of-concept',
        enhancedSystemPurpose: { primary_domain: 'dev-tool', core_concepts: [] },
        frameworks: [], userJourneys: [],
        dataEntities: [{ id: 'entity_releaseconfig', name: 'ReleaseConfig' }],
        candidateCapabilities: [
          { name: 'Release Management', related_entities: ['entity_releaseconfig'], operations: [] },
        ],
        externalServices: [], flowGraph: { capabilities: [] },
        projectTextSignal: { concepts: [], evidence: [] }, budgetMs: 30000,
      });
      expect(catalog.length).toBe(1);
      expect(catalog[0].name).toBe('Automate release packaging');
    } finally {
      (aiService as any).generateComponentDescription = original;
    }
  });

  it('folds a LARGE behavior-surface family into the ranked candidate window as one coarse candidate', async () => {
    // Reproduces the live Klauro-self defect: 207 mcp_tool entry points are
    // ALREADY one merged behaviorSurfaces candidate (buildBehaviorCapabilities
    // clusters by registration kind), but the AI catalog previously never saw
    // it at all — behavior surfaces never reached `candidateCapabilities`, so
    // the platform's actual flagship value could never be named as a
    // capability, no matter the window size.
    const captured: any[] = [];
    const original = (aiService as any).generateComponentDescription;
    (aiService as any).generateComponentDescription = async (opts: any) => {
      captured.push(opts);
      return JSON.stringify({
        capabilities: [
          { name: 'Provide MCP tool surface to agents', description: 'Exposes MCP tools that let coding agents query the CAS graph before editing.', category: 'core', entities: [], journeys: [] },
        ],
      });
    };
    try {
      // REAL evidence shape: buildBehaviorCapabilities CAPS the operations array
      // at 12 (entries.slice(0, 12)) for CAS size, so a 207-tool surface arrives
      // here with operations.length === 12 but criticality_factors[0] carrying
      // the TRUE count ("207 mcp_tool entry points form one cohesive behavior
      // surface"). The merge gate must read the true count from that evidence,
      // NOT operations.length — otherwise it can never fire on real data.
      const cappedOps = Array.from({ length: 12 }, (_, i) => ({
        entry_point_id: `mcp_tool_${i}`, entry_point_type: 'mcp_tool', action: 'Call', path_or_command: `tool_${i}`,
      }));
      const catalog = await orch.aiExtractCapabilityCatalog({
        systemName: 'klauro',
        enhancedSystemPurpose: { primary_domain: 'dev-tool', core_concepts: [] },
        frameworks: [], userJourneys: [],
        dataEntities: [],
        candidateCapabilities: [],
        behaviorSurfaces: [
          {
            id: 'cap_mcp_tool_surface', name: 'Mcp Tool Surface',
            description: 'Behavior surface: 207 mcp tool entry points; handlers reach 5 data entities.',
            related_domains: ['mcp_tool'], related_entities: [], operations: cappedOps,
            criticality_factors: ['207 mcp_tool entry points form one cohesive behavior surface'],
          },
        ],
        externalServices: [], flowGraph: { capabilities: [] },
        projectTextSignal: { concepts: [], evidence: [] }, budgetMs: 30000,
      });
      expect(catalog.length).toBe(1);
      expect(catalog[0].name).toBe('Provide MCP tool surface to agents');
      // Reached the prompt as a real candidate route area (evidence the ranker
      // actually surfaced it, not just that the AI happened to name it) — proving
      // the gate keyed on the TRUE 207 count, not the capped-at-12 operations.
      const facts = captured[0]?.additionalContext?.facts;
      expect(facts?.candidate_route_areas).toContain('Mcp Tool Surface');
      // Operations link back so the resulting capability stays navigable.
      expect(catalog[0].operations.length).toBeGreaterThan(0);
    } finally {
      (aiService as any).generateComponentDescription = original;
    }
  });

  it('excludes a SMALL behavior surface from the ranked window (below the operation-count threshold)', async () => {
    const captured: any[] = [];
    const original = (aiService as any).generateComponentDescription;
    (aiService as any).generateComponentDescription = async (opts: any) => {
      captured.push(opts);
      return JSON.stringify({ capabilities: [] });
    };
    try {
      const fewOps = Array.from({ length: 3 }, (_, i) => ({
        entry_point_id: `cli_${i}`, entry_point_type: 'cli', action: 'Run', path_or_command: `cmd_${i}`,
      }));
      await orch.aiExtractCapabilityCatalog({
        systemName: 'small-tool',
        enhancedSystemPurpose: { primary_domain: 'dev-tool', core_concepts: [] },
        frameworks: [], userJourneys: [],
        dataEntities: [],
        candidateCapabilities: [],
        behaviorSurfaces: [
          {
            id: 'cap_cli_surface', name: 'Cli Surface',
            description: 'Behavior surface: 3 command entry points; handlers form a behavior engine with no persisted-entity surface.',
            related_domains: ['commands'], related_entities: [], operations: fewOps,
            criticality_factors: ['3 command entry points form one cohesive behavior surface'],
          },
        ],
        externalServices: [], flowGraph: { capabilities: [] },
        projectTextSignal: { concepts: [], evidence: [] }, budgetMs: 30000,
      });
      const facts = captured[0]?.additionalContext?.facts;
      expect(facts?.candidate_route_areas || []).not.toContain('Cli Surface');
    } finally {
      (aiService as any).generateComponentDescription = original;
    }
  });

  it('behaviorSurfaceEntryCount reads the TRUE count from evidence, not the capped operations array', () => {
    // The exact real-data bug: operations capped at 12, true count 207 in the
    // evidence strings. The gate must see 207.
    const surface: any = {
      id: 'cap_mcp_tool_surface', name: 'Mcp Tool Surface',
      description: 'Behavior surface: 207 mcp tool entry points; handlers reach 5 data entities.',
      operations: Array.from({ length: 12 }, (_, i) => ({ entry_point_id: `t_${i}` })),
      criticality_factors: ['207 mcp_tool entry points form one cohesive behavior surface'],
    };
    expect(orch.behaviorSurfaceEntryCount(surface)).toBe(207);
    // Falls back to operations.length when no evidence string carries the count.
    expect(orch.behaviorSurfaceEntryCount({ operations: [{ entry_point_id: 'a' }, { entry_point_id: 'b' }], criticality_factors: [] })).toBe(2);
  });

  it('near-empty AI fallback re-derives from the merged LARGE surface instead of shipping zero/one accidental capability', async () => {
    const envKeys = ['OPENAI_API_KEY', 'KLAURO_AI_INTERPRETATION', 'KLAURO_AI_INTERPRETATION_FORCE', 'KLAURO_AI_INTERPRETATION_BUDGET_MS'];
    const saved: Record<string, string | undefined> = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.KLAURO_AI_INTERPRETATION = 'true';
    process.env.KLAURO_AI_INTERPRETATION_FORCE = '1';
    delete process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS;
    const spy = jest.spyOn(aiService, 'generateComponentDescription').mockResolvedValue(JSON.stringify({
      system_description: 'Klauro builds CAS relationship graphs from source repositories so coding agents can reason about a codebase before touching it. It parses code into structural facts and layers comprehension over them, grounding every description in the evidence bundle it gathered. It hands this analysis context to agents over MCP.',
      domain: '',
      descriptions: [],
      capabilities: [],
    }));
    try {
      const purpose: any = {
        primary_type: 'developer-tool', confidence: 0.9, evidence: [],
        primary_domain: 'code-analysis', core_concepts: ['code', 'analysis'],
        inferred_description: 'A code analysis service.', supporting_workflow_ids: [],
      };
      const cappedOps = Array.from({ length: 12 }, (_, i) => ({
        entry_point_id: `mcp_tool_${i}`, entry_point_type: 'mcp_tool', action: 'Call', path_or_command: `tool_${i}`,
      }));
      const behaviorSurfaces: any[] = [
        {
          id: 'cap_mcp_tool_surface', name: 'Mcp Tool Surface',
          description: 'Behavior surface: 207 mcp tool entry points; handlers reach 5 data entities.',
          related_domains: ['mcp_tool'], related_entities: [], operations: cappedOps,
          criticality_factors: ['207 mcp_tool entry points form one cohesive behavior surface'],
        },
      ];
      const systemCapabilities: any[] = []; // no deterministic domain candidates at all
      const userJourneys: any[] = [{ name: 'Analyze a codebase' }];
      await orch.applyAIInterpretation(
        purpose, 'klauro', [], [], [], [], orch.emptyFlowGraph(), [],
        systemCapabilities, [], [], [], { concepts: [], evidence: [] }, userJourneys,
        undefined, [], [], behaviorSurfaces
      );
      expect(systemCapabilities.length).toBeGreaterThan(0);
      expect(systemCapabilities.some((capability: any) => capability.id === 'cap_mcp_tool_surface')).toBe(true);
    } finally {
      spy.mockRestore();
      for (const key of envKeys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });

  it('bare-noun capability names: repairs a grounded single-noun label, drops an ungrounded noun phrase, and keeps verb-headed labels untouched', async () => {
    // Reproduces the live defect measured on a real analyzed Swift macOS repo
    // (v1.0.116): 24 of the system_capabilities entries were single/two-word
    // module-or-type nouns ("Gateway", "Wizard", "Exec", ...) with no leading
    // purpose verb at all — the AI catalog attached SOME description to each,
    // so the pre-existing raw-echo guard (isRawCandidateLabelName) never
    // caught them; they are not an echo of a candidateAreas string, just a
    // bare noun the model itself chose as the "capability name".
    const original = (aiService as any).generateComponentDescription;
    (aiService as any).generateComponentDescription = async () => JSON.stringify({
      capabilities: [
        // Bare single noun, but grounded in a real entity -> repaired to a
        // purpose-headed "Manage <noun>" name instead of shipping as-is.
        { name: 'Gateway', entities: ['Gateway'] },
        // Bare two-word noun phrase (both nouns, no leading verb) with NO
        // anchor evidence at all -> demoted (dropped), not invented a purpose
        // for with nothing behind it. Explicit description so it is the
        // bare-noun guard doing the dropping, not the empty-description gate.
        { name: 'Exec Approval', description: 'Handles gateway related exec approval processing tasks for the system.', entities: [] },
        // Verb-headed two-word label (verb + object) -> never flagged, kept verbatim.
        { name: 'Detect patterns', entities: ['Pattern'] },
        // "Manage Sessions" is verb-headed ("manage") -> never flagged, kept verbatim.
        { name: 'Manage Sessions', entities: ['Session'] },
      ],
    });
    try {
      const catalog = await orch.aiExtractCapabilityCatalog({
        systemName: 'proof-of-concept',
        enhancedSystemPurpose: { primary_domain: 'dev-tool', core_concepts: [] },
        frameworks: [], userJourneys: [],
        dataEntities: [
          { id: 'entity_gateway', name: 'Gateway' },
          { id: 'entity_pattern', name: 'Pattern' },
          { id: 'entity_session', name: 'Session' },
        ],
        candidateCapabilities: [],
        externalServices: [], flowGraph: { capabilities: [] },
        projectTextSignal: { concepts: [], evidence: [] }, budgetMs: 30000,
      });
      const names = catalog.map((capability: any) => capability.name);
      expect(names).toContain('Manage Gateway');
      expect(names).not.toContain('Gateway');
      expect(names).not.toContain('Exec Approval');
      expect(names).toContain('Detect patterns');
      expect(names).toContain('Manage Sessions');
      expect(catalog.find((capability: any) => capability.name === 'Manage Gateway')?.criticality_factors)
        .toEqual(expect.arrayContaining(['bare-noun-purpose-repaired']));
    } finally {
      (aiService as any).generateComponentDescription = original;
    }
  });

  it('isBareNounCapabilityLabel / deriveManagePurposeLabel: unit behavior', () => {
    // Single bare token -> always flagged, regardless of whether it happens
    // to be verb-shaped ("Connect", "Poll") — a lone word with no object is
    // not a purpose statement.
    expect(orch.isBareNounCapabilityLabel('Gateway')).toBe(true);
    expect(orch.isBareNounCapabilityLabel('Connect')).toBe(true);
    expect(orch.isBareNounCapabilityLabel('Session')).toBe(true);
    // Two bare nouns, no leading verb -> flagged.
    expect(orch.isBareNounCapabilityLabel('Exec Approval')).toBe(true);
    // Verb-headed two-word label -> never flagged.
    expect(orch.isBareNounCapabilityLabel('Detect patterns')).toBe(false);
    expect(orch.isBareNounCapabilityLabel('Manage Sessions')).toBe(false);
    // 3+ word phrases are out of scope for this narrow guard even with no
    // obvious leading verb (conservative: avoid false positives there).
    expect(orch.isBareNounCapabilityLabel('Data Export Wizard')).toBe(false);

    expect(orch.deriveManagePurposeLabel('Gateway', true)).toBe('Manage Gateway');
    expect(orch.deriveManagePurposeLabel('Gateway', false)).toBeUndefined();
  });

  it('recordComprehensionSkipped (structure-only path, no AI pass coming): repairs a grounded bare-noun capability name in place', () => {
    const purpose: any = { description_generation: undefined };
    const systemCapabilities: any[] = [
      { id: 'cap_gateway', name: 'Gateway', related_entities: ['entity_gateway'], operations: [], criticality_factors: ['x'] },
      { id: 'cap_exec', name: 'Exec', related_entities: [], operations: [], criticality_factors: [] },
      { id: 'cap_detect', name: 'Detect patterns', related_entities: [], operations: [], criticality_factors: [] },
      { id: 'cap_ai_named', name: 'Wizard', name_source: 'ai', related_entities: ['e1'], operations: [], criticality_factors: [] },
    ];
    orch.recordComprehensionSkipped(purpose, systemCapabilities, [], 'disabled-by-env');

    expect(systemCapabilities.find(c => c.id === 'cap_gateway')?.name).toBe('Manage Gateway');
    expect(systemCapabilities.find(c => c.id === 'cap_gateway')?.criticality_factors).toEqual(expect.arrayContaining(['bare-noun-purpose-repaired']));
    // No anchor evidence at all (no related entities, no operations) -> left as-is, never invented a purpose with nothing behind it.
    expect(systemCapabilities.find(c => c.id === 'cap_exec')?.name).toBe('Exec');
    // Verb-headed label -> untouched.
    expect(systemCapabilities.find(c => c.id === 'cap_detect')?.name).toBe('Detect patterns');
    // Already AI-named -> never touched by the structure-only repair pass.
    expect(systemCapabilities.find(c => c.id === 'cap_ai_named')?.name).toBe('Wizard');
  });

  it('applyDeterministicCapabilityFallback: repairs a grounded bare-noun deterministic candidate instead of shipping it verbatim', () => {
    const candidateSnapshot: any[] = [
      { id: 'cap_gateway', name: 'Gateway', related_entities: ['entity_gateway'], operations: [], criticality_factors: [] },
      { id: 'cap_wizard', name: 'Wizard', related_entities: [], operations: [], criticality_factors: [] },
    ];
    const systemCapabilities: any[] = [];
    orch.applyDeterministicCapabilityFallback(candidateSnapshot, [], [], [], systemCapabilities);

    const names = systemCapabilities.map((capability: any) => capability.name);
    expect(names).toContain('Manage Gateway');
    // "Wizard" has zero related_entities and zero operations — no anchor
    // evidence to ground a repair — so it is dropped rather than shipped
    // bare or given an invented purpose.
    expect(names).not.toContain('Wizard');
  });
});

describe('resolveSystemDisplayName (Klauro rung-2: system name = directory basename defect)', () => {
  it('falls back to a scope-stripped, humanized manifest name when no doc title is supplied', () => {
    // The caller (analyzeProject) only invokes this helper when
    // options.displayName is ABSENT — an explicit displayName short-circuits
    // before resolveSystemDisplayName is ever called, so that priority is a
    // call-site contract, not something this helper itself needs to encode.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-sysname-display-'));
    try {
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@acme/widgets' }));
      expect(orch.resolveSystemDisplayName(root, undefined)).toBe('Widgets');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('prefers the product doc title (README H1) over the manifest name', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-sysname-doctitle-'));
    try {
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@klauro/monorepo' }));
      expect(orch.resolveSystemDisplayName(root, 'Klauro Proof Of Concept')).toBe('Klauro Proof Of Concept');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to a scope-stripped, humanized manifest name when no doc title exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-sysname-manifest-'));
    try {
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@acme/widget-tracker' }));
      expect(orch.resolveSystemDisplayName(root, undefined)).toBe('Widget Tracker');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns undefined (caller keeps the basename fallback) when neither doc title nor manifest name exist', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-sysname-none-'));
    try {
      expect(orch.resolveSystemDisplayName(root, undefined)).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves the real Klauro repo to a Klauro-grounded name, not the "proof-of-concept" directory basename', () => {
    const repoRoot = path.resolve(__dirname, '../../../../..');
    const signal = orch.extractProjectTextSignal(repoRoot);
    const resolved = orch.resolveSystemDisplayName(repoRoot, signal.productDocTitle);
    expect(resolved).toBeDefined();
    expect(resolved).not.toBe('proof-of-concept');
    expect(String(resolved)).toMatch(/^Klauro/i);
  });

  // COMMON-PACKAGE-SCOPE FALLBACK: the uploaded prod snapshot for
  // prj_wbW33m-wfETn1N41 (the real hosted Klauro-self analysis) genuinely has
  // NO root package.json and NO README — the ONLY package.json node in that
  // CAS is apps/app/package.json (name "@klauro/app") — yet the repo's nested
  // manifests (apps/app, apps/api, packages/analyzer-core, ...) all declare
  // the SAME "@klauro" scope, which is itself real, evidence-based top-down
  // naming signal even without a root file. This is what let the real
  // deployed system.name regress to the bare directory basename
  // "proof-of-concept" instead of "Klauro".
  it('falls back to the common npm scope when no root manifest/README exists but nested manifests share one scope', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-sysname-scope-'));
    try {
      fs.mkdirSync(path.join(root, 'apps', 'app'), { recursive: true });
      fs.mkdirSync(path.join(root, 'apps', 'api'), { recursive: true });
      fs.mkdirSync(path.join(root, 'packages', 'analyzer-core'), { recursive: true });
      fs.writeFileSync(path.join(root, 'apps', 'app', 'package.json'), JSON.stringify({ name: '@klauro/app' }));
      fs.writeFileSync(path.join(root, 'apps', 'api', 'package.json'), JSON.stringify({ name: '@klauro/api' }));
      fs.writeFileSync(path.join(root, 'packages', 'analyzer-core', 'package.json'), JSON.stringify({ name: '@klauro/analyzer-core' }));
      // No root package.json, no README — mirrors the real uploaded snapshot.
      expect(orch.resolveSystemDisplayName(root, undefined)).toBe('Klauro');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // REAL PROD REGRESSION (v1.0.83): the reanalyze workspace for
  // prj_wbW33m-wfETn1N41 DOES have a root package.json — named
  // "@klauro/monorepo" — so the manifest-name branch fired and humanized the
  // scope-stripped word to "Monorepo", the observed live system.name. But
  // "monorepo" is a structural descriptor of the repo shape, not the product;
  // the SCOPE "@klauro" is the identity. A scoped generic-structural root name
  // must prefer the scope.
  it('prefers the scope over a generic structural root manifest name (@klauro/monorepo -> Klauro, not Monorepo)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-sysname-monorepo-'));
    try {
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@klauro/monorepo' }));
      expect(orch.resolveSystemDisplayName(root, undefined)).toBe('Klauro');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves a genuinely product-named scoped root manifest untouched (@acme/checkout-service -> Checkout Service)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-sysname-realname-'));
    try {
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@acme/checkout-service' }));
      expect(orch.resolveSystemDisplayName(root, undefined)).toBe('Checkout Service');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('abstains (falls through to basename) when nested manifests span multiple unrelated scopes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-sysname-multiscope-'));
    try {
      fs.mkdirSync(path.join(root, 'vendor-a'), { recursive: true });
      fs.mkdirSync(path.join(root, 'vendor-b'), { recursive: true });
      fs.writeFileSync(path.join(root, 'vendor-a', 'package.json'), JSON.stringify({ name: '@acme/left-pad' }));
      fs.writeFileSync(path.join(root, 'vendor-b', 'package.json'), JSON.stringify({ name: '@totally-unrelated-org/right-pad' }));
      expect(orch.resolveSystemDisplayName(root, undefined)).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('abstains when nested manifests exist but none are scoped', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-sysname-unscoped-'));
    try {
      fs.mkdirSync(path.join(root, 'apps', 'app'), { recursive: true });
      fs.writeFileSync(path.join(root, 'apps', 'app', 'package.json'), JSON.stringify({ name: 'app' }));
      expect(orch.resolveSystemDisplayName(root, undefined)).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('prefers the ROOT manifest name over the common-scope fallback when a root package.json exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-sysname-root-wins-'));
    try {
      // A genuinely product-named root manifest (NOT a generic structural word
      // like "monorepo" — that case correctly defers to the scope; see the
      // "@klauro/monorepo -> Klauro" test above). Root name wins outright,
      // never overridden by the nested scope fallback.
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@klauro/checkout-service' }));
      fs.mkdirSync(path.join(root, 'apps', 'app'), { recursive: true });
      fs.writeFileSync(path.join(root, 'apps', 'app', 'package.json'), JSON.stringify({ name: '@different-scope/app' }));
      expect(orch.resolveSystemDisplayName(root, undefined)).toBe('Checkout Service');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reproduces the real prod snapshot shape (only a nested apps/app/package.json, no root files) and resolves to Klauro', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-sysname-prod-shape-'));
    try {
      fs.mkdirSync(path.join(root, 'apps', 'app'), { recursive: true });
      fs.writeFileSync(path.join(root, 'apps', 'app', 'package.json'), JSON.stringify({ name: '@klauro/app' }));
      const signal = orch.extractProjectTextSignal(root);
      expect(signal.productDocTitle).toBeUndefined();
      expect(orch.resolveSystemDisplayName(root, signal.productDocTitle)).toBe('Klauro');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('systemDisplayNameIsBareBasename (caller-supplied displayName that is itself just the folder name)', () => {
  it('treats an absent displayName as bare', () => {
    expect(orch.systemDisplayNameIsBareBasename(undefined, '/tmp/proof-of-concept')).toBe(true);
  });

  it('treats a displayName equal to the projectPath basename as bare (case-insensitive)', () => {
    expect(orch.systemDisplayNameIsBareBasename('proof-of-concept', '/tmp/proof-of-concept')).toBe(true);
    expect(orch.systemDisplayNameIsBareBasename('Proof-Of-Concept', '/tmp/proof-of-concept')).toBe(true);
    expect(orch.systemDisplayNameIsBareBasename('proof-of-concept', '/tmp/proof-of-concept/')).toBe(true);
  });

  it('treats a displayName that differs from the basename as a deliberate explicit name (not bare)', () => {
    expect(orch.systemDisplayNameIsBareBasename('Klauro', '/tmp/proof-of-concept')).toBe(false);
    expect(orch.systemDisplayNameIsBareBasename('My Custom Project Name', '/data/workspaces/prj_abc123')).toBe(false);
  });
});

describe('architecture-shape claim gate (live truckspy: "microservices" shipped for a one-backend compose repo)', () => {
  const purpose = { primary_domain: 'fleet-management', core_concepts: ['vehicle', 'driver', 'trip'] };
  const base = 'A fleet management platform that tracks vehicles, drivers, and trips for dispatch operators. It records trip assignments and produces driver activity reports for fleet managers.';

  it('rejects a microservices claim when the deterministic topology is a single deployable', async () => {
    const description = `${base} It is built with a microservices architecture serving the dispatch workflows.`;
    const result = orch.validateAIInterpretation(description, purpose, { deployableCount: 1 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('ungrounded-architecture-claim: microservices');
  });

  it('rejects a microservices claim when the topology is UNKNOWN (no deployable facts = no corroboration)', async () => {
    const description = `${base} It is built with a microservices architecture serving the dispatch workflows.`;
    const result = orch.validateAIInterpretation(description, purpose, {});
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('ungrounded-architecture-claim: microservices');
  });

  it('keeps a microservices claim corroborated by a multi-deployable topology', async () => {
    const description = `${base} It is built with a microservices architecture serving the dispatch workflows.`;
    expect(orch.validateAIInterpretation(description, purpose, { deployableCount: 4 }).ok).toBe(true);
  });

  it('gates monolith claims on a KNOWN small topology and event-driven claims on messaging evidence', async () => {
    const monolith = `${base} It ships as a monolithic backend behind one deployment.`;
    expect(orch.validateAIInterpretation(monolith, purpose, { deployableCount: 1 }).ok).toBe(true);
    expect(orch.validateAIInterpretation(monolith, purpose, {}).reason).toBe('ungrounded-architecture-claim: monolith');
    expect(orch.validateAIInterpretation(monolith, purpose, { deployableCount: 5 }).reason).toBe('ungrounded-architecture-claim: monolith');

    const eventDriven = `${base} Trip updates flow through an event-driven pipeline before reports are produced.`;
    expect(orch.validateAIInterpretation(eventDriven, purpose, { deployableCount: 1, libraries: ['kafkajs'] }).ok).toBe(true);
    expect(orch.validateAIInterpretation(eventDriven, purpose, { deployableCount: 1, libraries: ['lodash'] }).reason).toBe('ungrounded-architecture-claim: event-driven');
  });

  it('sanitize STRIPS the ungrounded architecture clause (repair of AI text, never a rewrite) and grammar survives', async () => {
    const description = `${base} It is built with a microservices architecture, integrating trip records with driver activity reporting.`;
    const sanitized = orch.sanitizeAIInterpretation(description, purpose, { deployableCount: 1 });
    expect(sanitized).not.toMatch(/micro-?services/i);
    expect(sanitized).toMatch(/^A fleet management platform/);
    // No grammatical stump left behind by the clause strip.
    expect(sanitized).not.toMatch(/\b(?:with|a|an|the)\s*[.,]/i);
    // Grounded topology keeps the clause untouched.
    expect(orch.sanitizeAIInterpretation(description, purpose, { deployableCount: 4 })).toMatch(/microservices/i);
  });

  it('acceptAIInterpretationCandidate heals an otherwise-grounded paragraph by stripping the ungrounded shape claim', async () => {
    const description = `${base} It is built with a microservices architecture for the dispatch workflows.`;
    const outcome = orch.acceptAIInterpretationCandidate(description, purpose, { deployableCount: 1 });
    expect(outcome.validation.ok).toBe(true);
    expect(outcome.text).not.toMatch(/micro-?services/i);
  });
});

describe('domain-claim gate (replaces descriptionContradictsPurposeFamily\'s hardcoded six-family table with a generic evidence gate)', () => {
  it('keeps "fleet management platform" grounded via entity/route evidence, not just a literal domain label match (truckspy regression)', () => {
    const description = 'A fleet management platform that tracks vehicles, drivers, and trips for dispatch operators. It records trip assignments and produces driver activity reports for fleet managers.';
    // primary_domain is deliberately generic (not "fleet-management") — grounding
    // comes from route/structural evidence, same corpus systemTypeIsGrounded uses.
    const purpose = { primary_domain: 'backend-service', core_concepts: ['vehicle', 'driver', 'dispatch'] };
    expect(orch.validateAIInterpretation(description, purpose, { structuralTokens: ['fleet'] }).ok).toBe(true);
  });

  it('rejects "fleet management platform" with zero fleet evidence (ported family: fleet)', () => {
    const description = 'A fleet management platform that tracks vehicles, drivers, and trips for dispatch operators. It records trip assignments and produces driver activity reports for fleet managers.';
    const result = orch.validateAIInterpretation(description, { primary_domain: 'unknown', core_concepts: [] }, {});
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('ungrounded-domain-claim: fleet management platform');
  });

  it('grounds/rejects the bare "<X> operations"/"<X> tracking" claim shape with no type-head noun (ported family: fleet — "vehicle operations", "fuel tracking")', () => {
    const description = 'A depot tool that manages fuel tracking and vehicle operations for regional fleets. It captures route telemetry and produces daily utilization summaries for depot managers.';
    const purpose = { primary_domain: 'unknown', core_concepts: [] };
    expect(orch.validateAIInterpretation(description, purpose, { structuralTokens: ['fuel', 'vehicle', 'depot'] }).ok).toBe(true);
    const rejected = orch.validateAIInterpretation(description, purpose, { structuralTokens: ['depot'] });
    expect(rejected.ok).toBe(false);
    expect(rejected.reason).toBe('ungrounded-domain-claim: fuel tracking, vehicle operations');
  });

  it('grounds/rejects "portfolio management system" via evidence, not a solana/trading vocabulary allow-list (ported family: portfolio/trading)', () => {
    const description = 'soon-ui is a portfolio management system that coordinates portfolio data, market discovery, and automation workflows using React. It presents assets, activity, and payments through portfolio screens.';
    expect(orch.validateAIInterpretation(description, { primary_domain: 'portfolio-management', core_concepts: ['portfolio'] }, { frameworks: ['React'] }).ok).toBe(true);
    const rejected = orch.validateAIInterpretation(description, { primary_domain: 'unknown', core_concepts: [] }, { frameworks: ['React'] });
    expect(rejected.ok).toBe(false);
    expect(rejected.reason).toBe('ungrounded-domain-claim: portfolio management system');
  });

  it('grounds/rejects "network access management system" via evidence, not a zero-trust vocabulary allow-list (ported family: zero-trust)', () => {
    const description = 'A network access management system that verifies device posture before granting VPN sessions. It logs each access decision and produces audit reports for security teams.';
    expect(orch.validateAIInterpretation(description, { primary_domain: 'zero-trust-security', core_concepts: ['network', 'access'] }, {}).ok).toBe(true);
    const rejected = orch.validateAIInterpretation(description, { primary_domain: 'unknown', core_concepts: [] }, {});
    expect(rejected.ok).toBe(false);
    expect(rejected.reason).toBe('ungrounded-domain-claim: network access management system');
  });

  it('grounds/rejects "clinical testing system"/"patient testing"/"clinical measurements" via evidence (ported family: clinical)', () => {
    const description = 'A lab tool that runs clinical testing system workflows and patient testing for hospital staff. It records clinical measurements and produces result summaries for physicians.';
    expect(orch.validateAIInterpretation(description, { primary_domain: 'clinical-testing', core_concepts: ['patient', 'clinical'] }, {}).ok).toBe(true);
    const rejected = orch.validateAIInterpretation(description, { primary_domain: 'unknown', core_concepts: [] }, {});
    expect(rejected.ok).toBe(false);
    expect(rejected.reason).toBe('ungrounded-domain-claim: runs clinical testing system, patient testing, clinical measurements');
  });

  it('the sixth family (codebase-analysis / "cas graph" / "agent contexts") stays covered by the pre-existing, already-generic Klauro-self-identity checks — not folded into this frame, since those terms are internal analyzer vocabulary (a sanctioned self-identity exception), not a business-domain claim any other repo should ever legitimately make', () => {
    const description = 'A codebase analysis system that builds a CAS graph of every module and produces agent contexts for downstream tools. It tracks relationships between files and exposes them through an MCP server.';
    // Non-Klauro project claiming the Klauro-specific domain is rejected by the
    // untouched, already-generic codebase-analysis-domain-without-klauro-evidence
    // gate — no hardcoded "cas graph"/"agent contexts" vocabulary was reintroduced.
    const result = orch.validateAIInterpretation(description, { primary_domain: 'codebase-analysis', core_concepts: [] }, { isKlauroSelfProject: false });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('codebase-analysis-domain-without-klauro-evidence');
  });

  it('gates a domain the old six-family table NEVER covered ("restaurant order management system") — proving this is a generic evidence gate, not an expanded vocabulary list', () => {
    const description = 'A restaurant order management system that lets diners browse menus and place table-side orders. It routes tickets to the kitchen and prints receipts for guests.';
    const rejected = orch.validateAIInterpretation(description, { primary_domain: 'unknown', core_concepts: [] }, {});
    expect(rejected.ok).toBe(false);
    expect(rejected.reason).toBe('ungrounded-domain-claim: restaurant order management system');
    const accepted = orch.validateAIInterpretation(
      description,
      { primary_domain: 'restaurant-ordering', core_concepts: ['restaurant', 'order', 'menu'] },
      {}
    );
    expect(accepted.ok).toBe(true);
  });

  it('sanitize STRIPS the ungrounded domain-claim clause (repair of AI text, never a rewrite) and grammar survives', () => {
    const description = 'A depot tool that manages fuel tracking and vehicle operations for regional fleets, integrating route telemetry with daily summaries.';
    const sanitized = orch.sanitizeAIInterpretation(description, { primary_domain: 'unknown', core_concepts: [] }, {});
    expect(sanitized).not.toMatch(/fuel tracking/i);
    expect(sanitized).not.toMatch(/vehicle operations/i);
    // No grammatical stump left behind by the clause strip.
    expect(sanitized).not.toMatch(/\b(?:with|a|an|the)\s*[.,]/i);
    // Grounded evidence keeps the clause untouched.
    expect(orch.sanitizeAIInterpretation(description, { primary_domain: 'unknown', core_concepts: [] }, { structuralTokens: ['fuel', 'vehicle'] })).toMatch(/vehicle operations/i);
  });
});

describe('description prompt contract: how-it-works is dataflow, never a package inventory (live truckspy: "leveraging ... @angular/core and @google-cloud/storage")', () => {
  const purpose = { primary_domain: 'fleet-management', core_concepts: ['vehicle', 'driver'], primary_type: 'platform' };

  it('the contract requires dataflow in HOW IT WORKS and forbids package names there', async () => {
    const contract = orch.buildAIDescriptionPromptContract(purpose, 'truckspy', { concepts: [], evidence: [] });
    expect(contract.version).toContain('v12-dataflow-how-it-works');
    const shape: string[] = contract.system_description_shape;
    const howItWorks = shape.find(line => line.startsWith('HOW IT WORKS'))!;
    expect(howItWorks).toMatch(/DATAFLOW/);
    expect(howItWorks).toMatch(/do not name any package, library, or dependency identifier/i);
    // The old contract literally REQUIRED naming "a package from libraries" as
    // the mechanism slot — that requirement must be gone from the whole contract.
    expect(JSON.stringify(contract)).not.toContain('a package from libraries');
  });

  it('the contract confines framework names to product-shaping context and gates architecture shapes on topology facts', async () => {
    const contract = orch.buildAIDescriptionPromptContract(purpose, 'truckspy', { concepts: [], evidence: [] });
    const built = (contract.system_description_shape as string[]).find(line => line.startsWith('HOW IT IS BUILT'))!;
    expect(built).toMatch(/product-shaping context/);
    expect(built).toMatch(/never claim microservices/i);
    const forbidden = (contract.forbidden_claims as string[]).join(' ');
    expect(forbidden).toMatch(/leveraging the framework and libraries such as/i);
    expect(forbidden).toMatch(/architecture shape/i);
  });
});

describe('system-description code-symbol lint (live kontinuum: "coordinating internal src/api/auth.ts ... conceptNode, extractReviewItems, saveEdge")', () => {
  const purpose = { primary_domain: 'personal-intelligence', core_concepts: ['concept', 'memory', 'agent'] };

  it('rejects relative source-file tokens the leading-slash path lint missed', async () => {
    const description = 'kontinuum is a personal intelligence system that organizes concepts and memory for its users. It works by coordinating src/api/auth.ts and src/api/remote-tools.ts to produce concept records.';
    expect(orch.validateAIInterpretation(description, purpose, {}).reason).toBe('source-file-restatement');
  });

  it('rejects lowerCamelCase identifier lists as implementation restatement', async () => {
    const description = 'kontinuum is a personal intelligence system that organizes concepts and memory for its users. It produces terminal records such as conceptNode, extractReviewItems, and saveEdge for agents.';
    expect(orch.validateAIInterpretation(description, purpose, {}).reason).toBe('implementation-identifier-restatement');
  });

  it('sanitize drops a non-opening code-symbol sentence and keeps the product prose', async () => {
    const description = 'kontinuum is a personal intelligence system that organizes concepts, memory, and agent workflows for its users. It works by coordinating src/api/auth.ts and src/api/remote-tools.ts to produce concept records. It maintains concept and memory records that agents review before acting.';
    const sanitized = orch.sanitizeAIInterpretation(description, purpose, {});
    expect(sanitized).not.toMatch(/src\/api/);
    expect(sanitized).toMatch(/^kontinuum is a personal intelligence system/);
    expect(sanitized).toMatch(/concept and memory records/);
  });
});

describe('architecture-strip grammar + fact-list vocabulary echo (live kontinuum round-3 residuals)', () => {
  const purpose = { primary_domain: 'personal-intelligence', core_concepts: ['memory', 'concept', 'agent'] };

  it('excises the gutted copula clause after stripping an ungrounded shape word', async () => {
    const description = 'Kontinuum is a personal intelligence substrate that manages memory, concepts, and agent workflows. Kontinuum is built with Node.js and React, and its architecture is microservices, with 11 separately deployable units.';
    const sanitized = orch.sanitizeAIInterpretation(description, purpose, { frameworks: ['React'], libraries: ['react'], deployableCount: 2 });
    expect(sanitized).not.toMatch(/micro-?services/i);
    expect(sanitized).not.toMatch(/\bis\s*,/);
    expect(sanitized).toMatch(/deployable units/);
  });

  it('rejects the "produces terminal outputs such as" fact-list echo and sanitize heals it', async () => {
    const description = 'Kontinuum is a personal intelligence substrate that manages memory, concepts, and agent workflows for its users. It produces terminal outputs such as memory intake summaries, concept catalogs, and graph explorer views.';
    expect(orch.validateAIInterpretation(description, purpose, {}).reason).toBe('fact-list-vocabulary-echo');
    const sanitized = orch.sanitizeAIInterpretation(description, purpose, {});
    expect(sanitized).not.toMatch(/terminal outputs/i);
    expect(sanitized).toMatch(/produces outputs such as memory intake/);
    expect(orch.validateAIInterpretation(sanitized, purpose, {}).ok).toBe(true);
  });
});

describe('catalog completeness (live truckspy: fuel/safety/ELD rich evidence, 9-capability catalog)', () => {
  it('http resource key skips generic audience/version tiers to reach the real resource segment', () => {
    const ep = (path: string) => ({ type: 'http', trigger: { path }, name: `GET ${path}` });
    // Live truckspy: EVERY route sits under /api/web|mobile|pub/..., so
    // first-segment grouping keyed 800+ routes under the audience tier and the
    // generic-key filter then dropped them wholesale — ELD's 30+ routes
    // produced NO route-area capability at all.
    expect(orch.inferResourceKey(ep('/api/web/eld/dailies'))).toBe('eld');
    expect(orch.inferResourceKey(ep('/api/web/drive-alerts/{id}/coachable'))).toBe('drive-alerts');
    expect(orch.inferResourceKey(ep('/api/web/fuel-card-transactions/missing-miles'))).toBe('fuel-card-transactions');
    expect(orch.inferResourceKey(ep('/api/v2/orders'))).toBe('orders');
    // A real first-segment resource is untouched — deeper segments never win
    // over a non-generic first segment.
    expect(orch.inferResourceKey(ep('/api/orders/items'))).toBe('orders');
    expect(orch.inferResourceKey(ep('/api/users'))).toBe('users');
  });

  it('compound entity nouns attribute accessors (paginateAllDriveAlerts -> drivealert read lineage)', () => {
    const nodes = [
      { id: 'm_paginate', type: 'method', name: 'paginateAllDriveAlerts' },
      { id: 'm_create', type: 'method', name: 'createFuelStationPrice' },
    ];
    const index = orch.buildEntityAccessorIndexByNoun(nodes);
    // Compound noun joined-token key: the entity lookup uses the WHOLE compact
    // name ('drivealert'), which single-token attribution never produced.
    expect([...(index.get('drivealert')?.read || [])]).toContain('m_paginate');
    expect([...(index.get('fuelstationprice')?.create || [])]).toContain('m_create');
    // Single-token attribution unchanged.
    expect([...(index.get('alert')?.read || [])]).toContain('m_paginate');
  });

  it('read-shaped repository verbs (paginate/retrieve/browse) bucket as read accessors', () => {
    expect(orch.crudBucketFromAccessorName('paginateAllDriveAlerts')).toBe('read');
    expect(orch.crudBucketFromAccessorName('retrieveOrders')).toBe('read');
    expect(orch.crudBucketFromAccessorName('browseCatalog')).toBe('read');
  });

  it('prompt-window ranking: own deterministic category breaks evidence ties before name order', () => {
    const ops12 = Array.from({ length: 12 }, (_, i) => ({
      entry_point_id: `node:n_${i}`, entry_point_type: 'internal', action: 'Handle', path_or_command: `src/${i}.php`,
    }));
    // Live truckspy: 'Cleanup' (supporting) and 'Drive Alert' (core) tied on
    // every evidence axis; alphabetical order then put the supporting plumbing
    // group ahead of the core one in the window.
    const cleanup = { name: 'Cleanup', category: 'supporting', related_entities: [], related_domains: ['cleanup'], operations: ops12 };
    const driveAlert = { name: 'Drive Alert', category: 'core', related_entities: [], related_domains: ['drive-alert'], operations: ops12 };
    const ranked = orch.rankCatalogPromptCandidates([cleanup, driveAlert] as any[], [])
      .map((candidate: any) => candidate.name);
    expect(ranked.indexOf('Drive Alert')).toBeLessThan(ranked.indexOf('Cleanup'));
  });

  it('catalog size guidance and window scale with the candidate pool; candidates_considered surfaces in the decision digest', async () => {
    const captured: any[] = [];
    const original = (aiService as any).generateComponentDescription;
    (aiService as any).generateComponentDescription = async (args: any) => {
      captured.push(args);
      return JSON.stringify({ capabilities: [
        { name: 'Manage trips', description: 'Tracks Trip records from booking through completion for dispatch operators.', category: 'core', entities: ['Trip'], journeys: [] },
      ] });
    };
    try {
      // 180-candidate pool (live truckspy scale) -> window widens past 24 and
      // the prompt asks for proportionally more capabilities than the 6-12
      // small-repo default.
      const bigPool = Array.from({ length: 180 }, (_, i) => ({
        name: `Area ${i}`, category: 'supporting', related_entities: [], related_domains: [`area-${i}`],
        operations: [{ entry_point_id: `ep_${i}`, entry_point_type: 'http', action: 'Handle', path_or_command: `/a/${i}` }],
      }));
      await orch.aiExtractCapabilityCatalog({
        systemName: 'big',
        enhancedSystemPurpose: { primary_domain: 'fleet', core_concepts: [] },
        frameworks: [], userJourneys: [], dataEntities: [{ id: 'entity_trip', name: 'Trip' }] as any[],
        candidateCapabilities: bigPool as any[],
        externalServices: [], flowGraph: { capabilities: [] } as any,
        projectTextSignal: { concepts: [], evidence: [] } as any, budgetMs: 30000,
      });
      const bigCtx = captured[captured.length - 1].additionalContext;
      expect(bigCtx.facts.candidate_route_areas.length).toBe(30); // ceil(180/6)
      expect(bigCtx.task).toMatch(/Return 5 to 12 capabilities|Return \d+ to \d+ capabilities/);
      const bigCounts = bigCtx.task.match(/Return (\d+) to (\d+) capabilities/);
      expect(Number(bigCounts[2])).toBeGreaterThan(12);

      // Small pool keeps the original 6-12 guidance and 24-name window bound.
      const smallPool = bigPool.slice(0, 10);
      await orch.aiExtractCapabilityCatalog({
        systemName: 'small',
        enhancedSystemPurpose: { primary_domain: 'fleet', core_concepts: [] },
        frameworks: [], userJourneys: [], dataEntities: [{ id: 'entity_trip', name: 'Trip' }] as any[],
        candidateCapabilities: smallPool as any[],
        externalServices: [], flowGraph: { capabilities: [] } as any,
        projectTextSignal: { concepts: [], evidence: [] } as any, budgetMs: 30000,
      });
      const smallCtx = captured[captured.length - 1].additionalContext;
      expect(smallCtx.facts.candidate_route_areas.length).toBe(10);
      const smallCounts = smallCtx.task.match(/Return (\d+) to (\d+) capabilities/);
      expect(Number(smallCounts[1])).toBe(6);
      expect(Number(smallCounts[2])).toBe(12);
    } finally {
      (aiService as any).generateComponentDescription = original;
    }
  });
});
