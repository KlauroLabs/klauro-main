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
  it('keeps a genuine third-party SDK exit point', () => {
    const ep = exitPoint({
      type: 'sdk',
      name: 'Call to forward',
      target: { sdk: 'ngrok', endpoint: 'ngrok.forward' },
    });
    expect(orch.isValidExitPoint(ep)).toBe(true);
  });

  it('keeps a database exit point', () => {
    expect(orch.isValidExitPoint(exitPoint({ type: 'database', name: 'SELECT users' }))).toBe(true);
  });

  it('drops a stdlib path.* call mistaken for a file exit point', () => {
    const ep = exitPoint({ type: 'file', name: 'path.join', target: { resource: 'path.join' } });
    expect(orch.isValidExitPoint(ep)).toBe(false);
  });

  it('drops fs.* stdlib noise', () => {
    expect(orch.isValidExitPoint(exitPoint({ type: 'file', name: 'fs.readFileSync' }))).toBe(false);
  });

  it('drops an "sdk" exit point that targets a local relative module', () => {
    const ep = exitPoint({
      type: 'sdk',
      name: 'Call to loadConfig',
      target: { sdk: './config/index.js', endpoint: 'loadConfig' },
      metadata: { library: './config/index.js' },
    });
    expect(orch.isValidExitPoint(ep)).toBe(false);
  });

  it('drops an "sdk" exit point whose library resolution fell back to the call target', () => {
    const ep = exitPoint({
      type: 'sdk',
      name: 'Call to skillRepository.findByName',
      target: { sdk: 'skillRepository.findByName', endpoint: 'skillRepository.findByName' },
    });
    expect(orch.isValidExitPoint(ep)).toBe(false);
  });

  it('rejects an unknown exit-point type', () => {
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

  it('creates CAS test suites from executable source test files when analyzer nodes are missing', () => {
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
    write('fixtures/demo/tests/ignored.test.ts', "test('fixture smoke', () => {});\n");

    const suites = orch.buildTestSuites([], [], root);

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
  it('derives lines_of_code from the source span', () => {
    const nodes: CASNode[] = [
      { id: 'n1', name: 'f', type: 'function', source: { line: 10, end_line: 30 }, metadata: {} } as CASNode,
    ];
    orch.normalizeNodeMetrics(nodes);
    expect(nodes[0].metadata!.metrics!.lines_of_code).toBe(21);
  });

  it('consolidates attribute-stashed complexity into complexity.cyclomatic', () => {
    const nodes: CASNode[] = [
      { id: 'n1', name: 'f', type: 'function', metadata: { attributes: { complexity: 7 } } } as CASNode,
    ];
    orch.normalizeNodeMetrics(nodes);
    expect(nodes[0].metadata!.complexity!.cyclomatic).toBe(7);
  });

  it('does not overwrite an existing canonical cyclomatic value', () => {
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
  it('returns undefined when no code unit carries metrics', () => {
    const nodes: CASNode[] = [{ id: 'n1', name: 'f', type: 'function', metadata: {} } as CASNode];
    expect(orch.computeMaintainabilityIndex(nodes)).toBeUndefined();
  });

  it('returns a 0-100 score for function nodes with metrics', () => {
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

  it('ignores file/module nodes so their line spans do not skew the average', () => {
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
  it('never fabricates a maintainability index when data is absent', () => {
    const nodes: CASNode[] = [{ id: 'n1', name: 'f', type: 'function', metadata: {} } as CASNode];
    const q = orch.calculateQualityMetrics(nodes);
    expect(q.maintainability_index).toBeUndefined();
  });

  it('computes documentation coverage', () => {
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
  it('does not emit a "dev" library from optional-dependencies/poetry group keys, and keeps the real packages', () => {
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

  it('detects MVC, Repository, Service Layer, and inventory from product source only', () => {
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

  it('identifies an MCP analyzer monorepo ahead of incidental legacy framework analyzers', () => {
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

  it('classifies a crypto/NestJS API that merely imports the MCP SDK as an API service, not an MCP analyzer', () => {
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

  it('uses dominant product shape instead of tiny framework contributions for API services', () => {
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

  it('classifies Symfony backend apps with template view-models as backend services, not desktop apps', () => {
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

  it('identifies infrastructure and desktop product shapes before falling back to CLI entry points', () => {
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

  it('identifies Electron desktop apps even when they embed local HTTP services', () => {
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

  it('identifies Flutter mobile apps before generic view folder desktop heuristics', () => {
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

  it('identifies mobile plus API repos without falling through to desktop platform runners', () => {
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

  it('does not classify multi-app API monorepos as MCP servers just because one app is mcp-api', () => {
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

  it('does not classify ordinary src/infrastructure folders as cloud infrastructure', () => {
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

  it('identifies tiny script-entry repos as CLI applications even without explicit entry point extraction', () => {
    const summary = orch.buildArchitectureSummary([
      node({ id: 'main', name: 'main.js', type: 'file', source: { file: 'main.js' } }),
      node({ id: 'strategy', name: 'TradeStrategy', type: 'class', source: { file: 'strategy.js' } }),
    ], [], [], []);

    expect(summary.system_type).toBe('CLI application');
  });

  it('identifies TSX entry files as frontend surface before script-entry CLI fallback', () => {
    const summary = orch.buildArchitectureSummary([
      node({ id: 'main', name: 'main.tsx', type: 'file', source: { file: 'src/main.tsx' } }),
      node({ id: 'wallet-page', name: 'WalletsPage', type: 'function', source: { file: 'src/pages/WalletsPage.tsx' } }),
    ], [], [], []);

    expect(summary.system_type).toBe('Frontend application');
  });

  it('infers CLI command contracts as behavior-level invariants', () => {
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

  it('infers script entry file contracts when a tiny repo has no explicit entry point', () => {
    const invariants = (orch as any).buildBehavioralInvariants([
      node({ id: 'main-file', name: 'main.js', type: 'file', source: { file: 'main.js' } }),
    ], [], [], { entities: [], relationships: [] }, [], [], [], '/tmp/script-app');

    const cliInvariant = invariants.find((invariant: any) => invariant.id === 'invariant_cli_entrypoint_contracts');
    expect(cliInvariant).toBeDefined();
    expect(cliInvariant.scope.file_paths).toContain('main.js');
  });

  it('infers UI route contracts as behavior-level invariants for frontend apps', () => {
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

  it('does not treat normal layered concept families as duplicate implementations', () => {
    const nodes: CASNode[] = [
      node({ id: 'user-controller', name: 'UsersController', type: 'controller', source: { file: 'src/users/users.controller.ts' } }),
      node({ id: 'user-service', name: 'UsersService', type: 'service', source: { file: 'src/users/users.service.ts' } }),
      node({ id: 'user-repository', name: 'UsersRepository', type: 'repository', source: { file: 'src/users/users.repository.ts' } }),
      node({ id: 'user-entity', name: 'UserEntity', type: 'entity', source: { file: 'src/users/user.entity.ts' } }),
      node({ id: 'users-view', name: 'UsersPage', type: 'component', source: { file: 'src/users/UsersPage.tsx' } }),
    ];

    expect(orch.detectDuplicateConceptSignals(nodes)).toEqual([]);
  });

  it('flags same-role duplicate concept owners without penalizing adjacent layers', () => {
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

  it('infers capabilities from terminal business nodes and entities without routes', () => {
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

    const capabilities = orch.buildSystemCapabilities([], entities, nodes, edges);

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

  it('prefers terminal business names over absolute path noise when inferring capabilities', () => {
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

    const capabilities = orch.buildSystemCapabilities([], [], nodes, edges);
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

  it('anchors terminal capabilities on business objects instead of action verbs', () => {
    const nodes: CASNode[] = [
      node({ id: 'report-handler', name: 'GenerateReportHandler', type: 'handler', source: { file: 'src/reports/generate-report.handler.ts' } }),
      node({ id: 'portfolio-use-case', name: 'RebalancePortfolioUseCase', type: 'usecase', source: { file: 'src/portfolio/rebalance-portfolio.use-case.ts' } }),
      node({ id: 'invoice-service', name: 'InvoiceSettlementService', type: 'service', source: { file: 'src/billing/invoice-settlement.service.ts' } }),
      node({ id: 'invoice-method', name: 'settleInvoice', type: 'method', source: { file: 'src/billing/invoice-settlement.service.ts' } }),
    ];
    const edges: CASEdge[] = [
      { id: 'e1', source: 'invoice-service', target: 'invoice-method', type: 'calls' },
    ];

    const capabilities = orch.buildSystemCapabilities([], [], nodes, edges);
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

  it('does not treat blockchain token domains as identity authentication', () => {
    const nodes: CASNode[] = [
      node({ id: 'balance', name: 'getAssociatedTokenAddress', type: 'function', source: { file: 'src/solana/token-accounts.ts' } }),
      node({ id: 'wallet', name: 'readTokenBalance', type: 'function', source: { file: 'src/solana/token-accounts.ts' } }),
    ];
    const edges: CASEdge[] = [
      { id: 'e1', source: 'wallet', target: 'balance', type: 'calls' },
    ];

    const capabilities = orch.buildSystemCapabilities([], [], nodes, edges);
    const names = capabilities.map((capability: any) => capability.name);

    expect(names).toContain('Token Balance Discovery');
    expect(names.some((name: string) => /Authentication/.test(name))).toBe(false);
  });

  it('filters DTO and source-support terminal buckets out of primary capabilities', () => {
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

    const capabilities = orch.buildSystemCapabilities([], entities, nodes, edges);
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

  it('expands common source abbreviations before naming capabilities', () => {
    const nodes: CASNode[] = [
      node({ id: 'loc-service', name: 'LocService', type: 'service', source: { file: 'src/locations/loc.service.php' } }),
      node({ id: 'loc-method', name: 'syncLoc', type: 'method', source: { file: 'src/locations/loc.service.php' } }),
    ];
    const edges: CASEdge[] = [
      { id: 'e1', source: 'loc-service', target: 'loc-method', type: 'calls' },
    ];

    const capabilities = orch.buildSystemCapabilities([], [], nodes, edges);
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

  it('uses product-surface capability names and filters helper buckets when analyzing Klauro itself', () => {
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
      const capabilities = orch.buildSystemCapabilities([], [], nodes, [], klauroRoot);
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

  it('never applies Klauro product capability names to a foreign repository', () => {
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
      const capabilities = orch.buildSystemCapabilities([], entities, nodes, edges, foreignRoot);
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

  it('derives route-backed rails capabilities when projectPath scopes the product checks', () => {
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

    const withoutProject = orch.buildSystemCapabilities(entryPoints, entities, nodes, []);
    expect(withoutProject.flatMap((capability: any) => capability.operations.map((op: any) => op.entry_point_type))).not.toContain('http');

    const capabilities = orch.buildSystemCapabilities(entryPoints, entities, nodes, [], projectRoot);
    const routeCapability = capabilities.find((capability: any) =>
      capability.operations.some((op: any) => op.entry_point_type === 'http')
    );
    expect(routeCapability).toBeDefined();
    const actions = routeCapability!.operations.map((op: any) => op.action);
    expect(actions).toEqual(expect.arrayContaining(['List', 'Create', 'Update', 'Delete']));
  });

  it('filters parser and framework utility labels out of key capability summaries', () => {
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

  it('infers CLI and message capability domains from command names instead of transport labels', () => {
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

  it('does not auto-generate entity descriptions during the default analysis pass', () => {
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

  it('excludes nested fixture entities from product data entities while preserving fixture-root analysis', () => {
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

  it('scopes high-level purpose facts to product entry points and frameworks', () => {
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

  it('strips analyzer display-name artifacts and admits only framework-analyzer application surfaces', () => {
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

  it('rejects AI element descriptions that add unsupported business or compliance claims', () => {
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

  it('uses page route segments instead of grouping every frontend route under pages', () => {
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
    const capabilities = orch.buildSystemCapabilities([productPage, companyPage] as any, [], nodes, []);
    const domains = capabilities.map((capability: any) => capability.related_domains).flat();

    expect(domains).toEqual(expect.arrayContaining(['product', 'company']));
    expect(domains).not.toContain('pages');
  });

  it('strips agent tooling instructions from guide-file project text so they cannot poison domain inference', () => {
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

  it('does not derive capability domains from UI or framework mechanics tokens', () => {
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

  it('does not promote UI interaction and data-fetching mechanics into product capabilities', () => {
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

    const capabilities = orch.buildSystemCapabilities(entryPoints as any, [], nodes, [], '/tmp/soon-ui');
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

  it('does not classify marketing UI cards and video players as a gaming platform', () => {
    const nodes: CASNode[] = [
      node({ id: 'video-player', name: 'VideoPlayer', type: 'component', source: { file: 'src/app/video-player.tsx' } }),
      node({ id: 'stats-card', name: 'StatsCard', type: 'component', source: { file: 'src/app/stats-section.tsx' } }),
      node({ id: 'feature-card', name: 'FeatureCard', type: 'component', source: { file: 'src/app/product/feature-stack.tsx' } }),
    ];
    const purpose = orch.inferSystemPurpose([], [], [], nodes);

    expect(purpose.primary_type).not.toBe('gaming-platform');
  });

  it('does not classify generic preview or invariant names as developer tooling', () => {
    const nodes: CASNode[] = [
      node({ id: 'preview-window', name: 'PreviewWindow', type: 'component', source: { file: 'src/PreviewWindow.xaml.cs' } }),
      node({ id: 'patient-invariant', name: 'PatientInvariantCheck', type: 'service', source: { file: 'src/PatientInvariantCheck.cs' } }),
      node({ id: 'patient', name: 'Patient', type: 'entity', source: { file: 'src/Patient.cs' } }),
    ];
    const purpose = orch.inferSystemPurpose([], [], [], nodes);

    expect(purpose.primary_type).not.toBe('devtools-platform');
  });

  it('classifies page-only React/Next style surfaces as frontend applications', () => {
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
    const purpose = orch.inferSystemPurpose(entryPoints as any, [], [], nodes);

    expect(purpose.primary_type).toBe('frontend-application');
  });

  it('does not classify desktop GUI apps as CLI tools only because they have Main entry points', () => {
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
    const purpose = orch.inferSystemPurpose(entryPoints as any, [], [], nodes);

    expect(purpose.primary_type).not.toBe('cli-tool');
  });

  it('prefers clinical desktop signals over incidental help/tutorial content', () => {
    const nodes: CASNode[] = [
      node({ id: 'lesson-help', name: 'TutorialHelpWindow', type: 'class', source: { file: 'src/Help/TutorialHelpWindow.xaml.cs' } }),
      node({ id: 'patient-window', name: 'PatientWindow', type: 'class', source: { file: 'src/PatientWindow.xaml.cs' } }),
      node({ id: 'muscle-viewmodel', name: 'MuscleMeasurementViewModel', type: 'class', source: { file: 'src/ViewModels/MuscleMeasurementViewModel.cs' } }),
      node({ id: 'device-modal', name: 'DeviceForceModal', type: 'class', source: { file: 'src/Modals/DeviceForceModal.xaml.cs' } }),
    ];
    const purpose = orch.inferSystemPurpose([], [], [], nodes);

    expect(purpose.primary_type).toBe('clinical-testing-platform');
  });

  it('prioritizes clinical capabilities in clinical testing summaries', () => {
    expect(orch.capabilityPurposeBias('clinical-testing', { name: 'Patient Report Management', related_domains: [], related_entities: [] })).toBe(0);
    expect(orch.capabilityPurposeBias('clinical-testing', { name: 'Snack Management', related_domains: [], related_entities: [] })).toBe(1);
    expect(orch.purposeCapabilitySummary('clinical-testing', [
      { name: 'Patient Management', related_domains: ['patient'], related_entities: [], operations: [] },
      { name: 'Device Management', related_domains: ['device'], related_entities: [], operations: [] },
      { name: 'Report Management', related_domains: ['report'], related_entities: [], operations: [] },
    ])).toEqual(['patient records', 'device connectivity', 'clinical reporting']);
  });

  it('uses fleet-management project text to override incidental multiplayer vocabulary', () => {
    expect(orch.refinePurposeTypeForDomain(
      'multiplayer-application',
      'fleet-management',
      ['Symfony'],
      [{ type: 'http', count: 8 }, { type: 'message', count: 31 }, { type: 'event', count: 37 }]
    )).toBe('backend-service');
  });

  it('adds readable titles and descriptions to test gaps', () => {
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

  it('builds static change risks when git metrics are unavailable', () => {
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

  it('recognizes mediator, unit-of-work, singleton, and MVVM patterns', () => {
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

  it('filters low-level runtime calls out of external service summaries', () => {
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

  it('uses React feature page folders before hook/library vocabulary for page capability keys', () => {
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

  it('prioritizes product capabilities over cross-cutting auth and billing cards', () => {
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

  it('does not summarize the repo name as a product capability or core concept', () => {
    expect(orch.isProjectNameCapabilityName('Soon Management', '/tmp/soon-ui')).toBe(true);
    expect(orch.isProjectNameConcept('soon', '/tmp/soon-ui')).toBe(true);
    expect(orch.isProjectNameCapabilityName('Portfolio Management', '/tmp/soon-ui')).toBe(false);
  });

  it('treats UI-control vocabulary as capability noise', () => {
    for (const token of ['buttons', 'changed', 'circular', 'color', 'combo', 'contents', 'current', 'custom', 'dispose', 'image', 'bar', 'box', 'middle', 'name', 'action', 'flow', 'runtime', 'mode', 'record', 'extract', 'assistant', 'operator', 'seed', 'dedupe', 'drawer', 'string']) {
      expect(orch.isGenericCapabilityToken(token)).toBe(true);
    }
  });

  it('treats CAS harness files as non-product source', () => {
    expect(orch.isPrimaryProductPath('packages/analyzer-core/cas-tests/test-hoggan-analysis.ts')).toBe(false);
    expect(orch.isPrimaryProductPath('src/test-hoggan-analysis.ts')).toBe(false);
    expect(orch.isPrimaryProductPath('packages/analyzer-core/src/analyzer/core/orchestrator.ts')).toBe(true);
  });

  it('uses product subfolders instead of generic api/source areas in terminal descriptions', () => {
    expect(orch.capabilitySourceAreas([], [
      { action: 'Read', path_or_command: 'src/api/sync/automation/useAutomationConfig.ts' },
      { action: 'Read', path_or_command: 'src/views/app/pages/portfolio-analysis/index.tsx' },
      { action: 'Read', path_or_command: 'src/views/auth/verify-email.tsx' },
      { action: 'Read', path_or_command: 'src/1.Domain/Identity.Domain.Actions/RegisterNewToken.cs' },
    ])).toEqual(['automation', 'portfolio analysis', 'auth']);
  });

  it('accepts AI descriptions grounded in structural facts when the inferred domain seed is wrong', () => {
    const purpose = { primary_domain: 'cloud-infrastructure', core_concepts: ['terraform', 'module'] };
    const description = 'A laundry service booking application where customers schedule pickups, track washing orders, and manage delivery preferences for their household laundry.';

    expect(orch.validateAIInterpretation(description, purpose).reason).toBe('not-grounded-in-domain-or-concepts');
    expect(orch.validateAIInterpretation(description, purpose, {
      structuralTokens: ['laundry', 'booking', 'pickup', 'delivery'],
    }).ok).toBe(true);
  });

  it('requires generated AI overviews to be paragraph-style, not a single compressed sentence', () => {
    const purpose = { primary_domain: 'portfolio-management', core_concepts: ['portfolio', 'automation', 'market'] };
    const oneSentence = 'soon-ui is a portfolio management system that coordinates portfolio data, market discovery, and automation workflows using React and TanStack Query.';
    const paragraph = 'soon-ui is a portfolio management system that presents account holdings, market data, and automation settings through a React interface. It connects portfolio analysis, exchange setup, and recurring investment workflows so agents can understand where product behavior lives before editing.';

    expect(orch.validateAIInterpretation(oneSentence, purpose, { frameworks: ['React'], libraries: ['@tanstack/react-query'] }).ok).toBe(true);
    expect(orch.validateGeneratedAIInterpretation(oneSentence, purpose, { frameworks: ['React'], libraries: ['@tanstack/react-query'] }).reason).toBe('too-short-for-ai-paragraph');
    expect(orch.validateGeneratedAIInterpretation(paragraph, purpose, { frameworks: ['React'], libraries: ['@tanstack/react-query'] }).ok).toBe(true);
  });

  it('rejects AI overviews that leak the repo name as a capability concept', () => {
    const purpose = { primary_domain: 'portfolio-management', core_concepts: ['portfolio', 'automation', 'market data'] };
    const leaked = 'soon-ui is a portfolio management system that coordinates portfolio, soon, market data discovery, and automation workflows using React. It presents assets, activity, and payments through portfolio screens.';

    expect(orch.validateGeneratedAIInterpretation(leaked, purpose, {
      systemName: 'soon-ui',
      frameworks: ['React'],
      structuralTokens: ['portfolio', 'market', 'automation', 'asset'],
    }).reason).toBe('project-name-as-concept');
  });

  it('selects distinctive domain entities ahead of generic Portfolio/Strategy/User CRUD', () => {
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

  it('surfaces the DISTINCTIVE crypto grounding (ccxt, DexTrade, manifest description) to the comprehension prompt for a soon-lens-shaped repo', () => {
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

  it('feeds the terminal signal (ranked terminal entities/capabilities + domain seed) into the comprehension prompt as primary grounding', () => {
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

  it('rejects a fabricated system-type with no supporting evidence but accepts one grounded in dependencies', () => {
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

  it('does not reject a description because a gerund/participle lands in the system-type modifier window (prod: ungrounded-system-type: incorporating)', () => {
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

    it('heals a too-long paragraph by trimming to a sentence boundary instead of rejecting (prod: hercules)', () => {
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

    it('heals a single ungrounded marketing word by stripping it instead of rejecting the paragraph (prod: electripure "efficient")', () => {
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

    it('still rejects a paragraph SATURATED with marketing language (word-deletion would gut it)', () => {
      const saturated = 'soon-lens is a seamless crypto market-intelligence API built with NestJS that seamlessly boosts productivity and business value while aggregating DexTrade and OhlcvCandle market data. It surfaces user-friendly WhaleTransaction signals, improving operational productivity and business value with a seamless PreflightDecision workflow for trading agents.';
      const verdict = orch.validateGeneratedAIInterpretation(saturated, purpose, grounding);
      expect(String(verdict.reason)).toMatch(/^unsupported-marketing-language:/);

      // 4+ distinct flagged phrases → NOT mechanically fixable.
      expect(orch.mechanicallyRepairAIInterpretation(saturated, verdict.reason)).toBeUndefined();
      const outcome = orch.acceptAIInterpretationCandidate(saturated, purpose, grounding);
      expect(outcome.validation.ok).toBe(false);
      expect(String(outcome.validation.reason)).toMatch(/^unsupported-marketing-language:/);
    });

    it('chains mechanical repairs: a too-long trim followed by a marketing-word strip', () => {
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

    it('does not mechanically repair semantic rejection reasons (they go to the AI re-prompt)', () => {
      expect(orch.mechanicallyRepairAIInterpretation(groundedParagraph, 'source-bucket-restatement')).toBeUndefined();
      // Multi-token ungrounded-system-type = wholesale fabrication, NOT a
      // word-level cleanup — stays semantic.
      expect(orch.mechanicallyRepairAIInterpretation(groundedParagraph, 'ungrounded-system-type: solana-arbitrage')).toBeUndefined();
      // Single-token strip only edits text that actually contains the token.
      expect(orch.mechanicallyRepairAIInterpretation(groundedParagraph, 'ungrounded-system-type: detected')).toBeUndefined();
      expect(orch.mechanicallyRepairAIInterpretation(groundedParagraph, undefined)).toBeUndefined();
    });

    it('heals a SINGLE ungrounded system-type modifier by stripping it and keeping the grounded type head (prod: hercules "commerce")', () => {
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

  it('never enforces bare verb forms as system-type claims (prod: ungrounded-system-type: allowed)', () => {
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

  it('grounds an umbrella domain modifier through synonym-cluster evidence (prod: hercules "commerce" with orders/invoices/deliveries)', () => {
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

  it('sentence-level sanitization never drops the OPENING sentence (prod: openclaw accepted description starting "It produces...")', () => {
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

  it('accepts framework mentions backed by detected libraries instead of framework analyzers', () => {
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

  it('matches scoped and suffixed package names against framework claim keys', () => {
    const purpose = { primary_domain: 'order-management', core_concepts: ['order', 'shipment'] };
    const description = 'An order management service built with Express and NestJS that records orders and shipments, links shipment updates to each order, and answers order lookups for dispatch operators.';

    expect(orch.validateAIInterpretation(description, purpose, {
      libraries: ['express', '@nestjs/swagger'],
    }).ok).toBe(true);
    expect(orch.validateAIInterpretation(description, purpose, {
      libraries: ['express-rate-limit'],
    }).reason).toBe('unsupported-framework-claim');
  });

  it('keeps library-backed framework sentences when sanitizing rejected descriptions', () => {
    const purpose = { primary_domain: 'game-management', core_concepts: ['game', 'tournament', 'card', 'deck'] };
    const description = 'A game management system that coordinates game, tournament, card, and deck workflows. It is built with React and Prisma for deck construction and tournament pairing screens.';

    expect(orch.sanitizeAIInterpretation(description, purpose, { frameworks: [] })).not.toMatch(/react/i);
    expect(orch.sanitizeAIInterpretation(description, purpose, {
      frameworks: [],
      libraries: ['react', '@prisma/client'],
    })).toMatch(/built with React and Prisma/);
  });

  it('treats helper verbs and generic UI actions as weak capability/domain terms', () => {
    for (const token of ['search', 'render', 'close', 'focus', 'normalize', 'ensure', 'path', 'clamp', 'install', 'modal', 'dialog', 'screen']) {
      expect(orch.isGenericDomainToken(token)).toBe(true);
      expect(orch.isGenericCapabilityToken(token)).toBe(true);
    }
  });

  it('rejects hash/id-shaped tokens as domain vocabulary so near-empty repos never compose a "<hash>-management" domain', () => {
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

  it('does not infer core capabilities from vendored help-library JavaScript', () => {
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

    const capabilities = orch.buildSystemCapabilities([], entities, nodes, []);
    const names = capabilities.map((capability: any) => capability.name);
    const labels = capabilities.map((capability: any) => capability.structural_label);

    expect(labels).toContain('Muscle Management');
    expect(names).toContain('Muscle');
    expect(labels).not.toContain('Next Management');
  });

  it('rejects AI system descriptions that end in generic concept lists', () => {
    const result = orch.validateAIInterpretation(
      'An order management system built with Angular that coordinates company, offer, suggestion, and upload workflows. It connects to HTTP API Connection and apollo-angular to manage user, portal, and company data.',
      { primary_domain: 'order-management', core_concepts: ['company', 'offer', 'suggestion'] },
      { frameworks: ['Angular'], externalServices: ['HTTP API Connection', 'apollo-angular'] }
    );

    expect(result).toEqual({ ok: false, reason: 'generic-concept-ending' });
  });

  it('allows generic-looking words when they are part of a grounded multiword concept', () => {
    const result = orch.validateAIInterpretation(
      'A Solana arbitrage system that checks SPL token balances before submitting buy and sell transactions. It uses @solana/web3.js for Solana network access and focuses its decisions on trade execution and market data.',
      { primary_domain: 'solana-arbitrage', core_concepts: ['trade execution', 'token balance', 'market data'] },
      { externalServices: ['@solana/web3.js'] }
    );

    expect(result.ok).toBe(true);
  });

  it('names the offending marketing terms in the rejection reason so repair prompts can target them', () => {
    const result = orch.validateAIInterpretation(
      'The fleet system seamlessly tracks vehicles and improves productivity for dispatchers across fleet operations, covering trip assignment and vehicle status updates.',
      { primary_domain: 'fleet-management', core_concepts: ['fleet', 'vehicle', 'dispatch'] }
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('unsupported-marketing-language');
    expect(result.reason).toContain('seamlessly');
    expect(result.reason).toContain('productivity');
  });

  it('allows integration claims that the deterministic project-text overview itself makes', () => {
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

      const capabilities = orch.buildSystemCapabilities(contribution.entry_points || [], [], nodes, edges, root);
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
      const capabilities = orch.buildSystemCapabilities(contribution.entry_points || [], [], contribution.nodes || [], contribution.edges || [], root);
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

  it('matches whole identifier tokens only, never substrings of compound identifiers', () => {
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

  it('does not classify commerce vocabulary (credit_card, gift_card, dashboard, return_authorization) as a gaming platform', () => {
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

    const purpose = orch.inferSystemPurpose([], [], [], nodes);

    expect(purpose.primary_type).not.toBe('gaming-platform');
    expect(purpose.secondary_types || []).not.toContain('gaming-platform');
  });

  it('still recognizes a real card game as a gaming platform with whole-token evidence', () => {
    const nodes: CASNode[] = [
      node({ id: 'game', name: 'Game', source: { file: 'src/game/game.ts' } }),
      node({ id: 'deck', name: 'Deck', source: { file: 'src/game/deck.ts' } }),
      node({ id: 'card', name: 'Card', source: { file: 'src/game/card.ts' } }),
      node({ id: 'player', name: 'Player', source: { file: 'src/game/player.ts' } }),
      node({ id: 'lobby', name: 'GameLobby', source: { file: 'src/game/lobby.ts' } }),
      node({ id: 'board', name: 'GameBoard', source: { file: 'src/game/board.ts' } }),
    ];

    const purpose = orch.inferSystemPurpose([], [], [], nodes);

    expect(purpose.primary_type).toBe('gaming-platform');
  });

  it('does not treat ReturnAuthorization domain models as authentication or authorization enforcement points', () => {
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

  it('keeps genuine auth actors as enforcement points under token matching', () => {
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

  it('filters rails-ecosystem framework noise out of capability naming', () => {
    for (const token of ['turbo', 'stimulus', 'sprockets', 'actiontext', 'activestorage', 'activerecord', 'devise', 'sidekiq', 'hotwire', 'importmap']) {
      expect(orch.isGenericCapabilityToken(token)).toBe(true);
    }
    expect(orch.domainKeyFromText('TurboStreamsController')).not.toBe('turbo');
    expect(orch.domainKeyFromText('TurboController')).toBeUndefined();
    expect(orch.domainKeyFromText('PaymentController')).toBe('payment');
  });
});

describe('capability noise floor and terminal capability labels', () => {
  it('suppresses error, notice, and framework-plumbing capability names', () => {
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

  it('keeps genuine commerce capability names', () => {
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

  it('labels terminal capabilities with the full domain phrase instead of a truncated first token', () => {
    const entity = (name: string): CASDataEntity => ({
      id: `entity_${name.toLowerCase()}`,
      name,
      lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] },
    } as CASDataEntity);

    const capabilities = orch.buildTerminalCapabilities(
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

  it('skips terminal capabilities whose domain duplicates an existing route domain in singular or plural form', () => {
    const entity = (name: string): CASDataEntity => ({
      id: `entity_${name.toLowerCase()}`,
      name,
      lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] },
    } as CASDataEntity);

    const capabilities = orch.buildTerminalCapabilities(
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

  it('suppresses terminal helper clusters that have no entity or entry-point evidence', () => {
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

    const capabilities = orch.buildTerminalCapabilities([orderEntity], nodes, edges, new Set<string>());
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

  it('emits a tenant-isolation boundary only when tenant scoping evidence exists', () => {
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

  it('does not treat Organization domain models as tenant isolation evidence', () => {
    const boundaries = orch.buildSecurityBoundaries([
      node({ id: 'org', name: 'Organization', type: 'entity' }),
      node({ id: 'account', name: 'Account', type: 'model' }),
    ], []);
    expect(boundaries.map((b: any) => b.boundary_type)).not.toContain('tenant-isolation');
  });

  it('emits a rate-limiting boundary from throttle middleware evidence', () => {
    const boundaries = orch.buildSecurityBoundaries([
      node({ id: 'throttle', name: 'RequestThrottleMiddleware', type: 'middleware' }),
    ], []);
    const rateBoundary = boundaries.find((b: any) => b.boundary_type === 'rate-limiting');
    expect(rateBoundary).toBeDefined();
    expect(rateBoundary.enforcement_points[0].confidence).toBe('enforced');
  });

  it('marks unresolved entry-point guards as assumed enforcement', () => {
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

  it('does not mark guards as assumed when they resolve to enforcement nodes', () => {
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

  it('reports unguarded mutating entry points as missing enforcement and unprotected sensitive ops', () => {
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

  it('does not classify public auth bootstrap mutations as missing auth', () => {
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

  it('reports zero unprotected sensitive ops when every mutating entry is guarded', () => {
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

  it('scores a clean repo healthy', () => {
    const health = buildHealth();
    expect(health.score).toBe(100);
    expect(health.status).toBe('healthy');
  });

  it('keeps a production repo with small bounded risks out of critical', () => {
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

  it('penalizes extensive untested critical paths more than sparse ones', () => {
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

  it('weighs incomplete implementation by its measured ratio', () => {
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

  it('treats missing runtime telemetry as informational, not health-defining', () => {
    const health = buildHealth({
      runtime: { instrumentation: { missing_runtime_coverage: Array.from({ length: 100 }, (_, i) => `ep${i}`) } },
    });
    expect(health.score).toBeGreaterThanOrEqual(95);
  });
});

describe('language builtin exit-point exclusion from external services', () => {
  it('drops PHP builtin External call exits from external services', () => {
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

  it('classifies a page-tree CMS with revision and publishing vocabulary as content-management', () => {
    const purpose = orch.inferSystemPurpose(
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

  it('does not classify a workflow engine without content entities as content-management', () => {
    const purpose = orch.inferSystemPurpose(
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

  it('does not classify a commerce system without revision vocabulary as content-management', () => {
    const purpose = orch.inferSystemPurpose(
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
  it('ignores fleet vocabulary inside content/*.md articles of a learning platform', () => {
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

  it('drops an evidence-free Jito Capability seeded from a vendor SDK wrapper', () => {
    const nodes: CASNode[] = [
      vendorNode({ id: 'jito-service', name: 'JitoService', type: 'service', source: { file: 'src/jito.rs' } }),
      vendorNode({ id: 'caller', name: 'BotRunnerHelper', type: 'class', source: { file: 'src/runner.rs' } }),
    ];
    const edges: CASEdge[] = [
      { id: 'e1', source: 'caller', target: 'jito-service', type: 'calls' },
    ] as CASEdge[];

    const capabilities = orch.buildTerminalCapabilities([], nodes, edges, new Set<string>());
    const labels = capabilities.map((capability: any) => capability.structural_label);
    // The vendor-SDK drop keys off the "Capability" structural label; assert it
    // never survives as a capability at all.
    expect(labels).not.toContain('Jito Capability');
  });

  it('keeps vendor-token capabilities that carry product evidence', () => {
    const entity: CASDataEntity = {
      id: 'entity_jito_bundle',
      name: 'JitoBundle',
      lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] },
    } as CASDataEntity;

    const capabilities = orch.buildTerminalCapabilities([entity], [], [], new Set<string>());
    const labels = capabilities.map((capability: any) => capability.structural_label);
    const names = capabilities.map((capability: { name: string }) => capability.name);
    expect(labels).toContain('Jito Bundle Management');
    expect(names).toContain('Jito Bundle');
  });

  it('keeps non-vendor evidence-free capabilities untouched', () => {
    const nodes: CASNode[] = [
      vendorNode({ id: 'pricing-service', name: 'PricingService', type: 'service', source: { file: 'src/pricing.rs' } }),
      vendorNode({ id: 'caller2', name: 'BotRunnerHelper', type: 'class', source: { file: 'src/runner.rs' } }),
    ];
    const edges: CASEdge[] = [
      { id: 'e1', source: 'caller2', target: 'pricing-service', type: 'calls' },
    ] as CASEdge[];

    const capabilities = orch.buildTerminalCapabilities([], nodes, edges, new Set<string>());
    const names = capabilities.map((capability: { name: string }) => capability.name);
    expect(names.some((name: string) => name.startsWith('Pricing'))).toBe(true);
  });

  it('drops terminal single-token leftovers already covered by composed capabilities', () => {
    const nodes: CASNode[] = [
      vendorNode({ id: 'balance-service', name: 'BalanceService', type: 'service', source: { file: 'src/balance.ts' } }),
      vendorNode({ id: 'balance-caller', name: 'TokenBalanceDiscovery', type: 'service', source: { file: 'src/token-balance.ts' } }),
    ];
    const edges: CASEdge[] = [
      { id: 'e1', source: 'balance-caller', target: 'balance-service', type: 'calls' },
    ] as CASEdge[];

    const capabilities = orch.buildTerminalCapabilities([], nodes, edges, new Set<string>(['token-balance']));
    const names = capabilities.map((capability: { name: string }) => capability.name);
    expect(names).not.toContain('Balance Capability');
  });

  it('drops entrypoint single-token leftovers already covered by composed capabilities', () => {
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

  it('links an entry point to the function named in handlerCallCandidates when no direct handler match exists', () => {
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

  it('does not fabricate an edge when a candidate name is ambiguous across multiple functions', () => {
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

  it('does not add an edge when handlerCallCandidates is absent (no fabrication without evidence)', () => {
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

  it('countDistinctSourceFiles dedupes many nodes down to the real file count', () => {
    // 3 files, but 12 nodes total (4 nodes per file) - files must be 3, not 12.
    const nodes: CASNode[] = [
      nodeInFile('n1', 'src/a.ts'), nodeInFile('n2', 'src/a.ts'), nodeInFile('n3', 'src/a.ts'), nodeInFile('n4', 'src/a.ts'),
      nodeInFile('n5', 'src/b.ts'), nodeInFile('n6', 'src/b.ts'), nodeInFile('n7', 'src/b.ts'), nodeInFile('n8', 'src/b.ts'),
      nodeInFile('n9', 'src/c.ts'), nodeInFile('n10', 'src/c.ts'), nodeInFile('n11', 'src/c.ts'), nodeInFile('n12', 'src/c.ts'),
    ];

    expect(orch.countDistinctSourceFiles(nodes)).toBe(3);
    expect(nodes.length).toBe(12);
  });

  it('ignores nodes without a source file rather than fabricating a count for them', () => {
    const nodes: CASNode[] = [
      nodeInFile('n1', 'src/a.ts'),
      { id: 'n2', name: 'synthetic', type: 'function' } as unknown as CASNode, // no source.file
    ];
    expect(orch.countDistinctSourceFiles(nodes)).toBe(1);
  });

  it('returns 0 for an empty or undefined node list', () => {
    expect(orch.countDistinctSourceFiles([])).toBe(0);
    expect(orch.countDistinctSourceFiles(undefined)).toBe(0);
  });

  it('extractTechnologies reports files_created (distinct files), not nodes_created (AST nodes)', () => {
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

  it('falls back to nodes_created only when files_created is absent (legacy-contribution safety net)', () => {
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

  it('drops a util-shaped duplicate node and redirects its edges onto the canonical node, matching across absolute vs relative source.file', () => {
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

  it('leaves distinct util nodes for genuinely different declarations untouched', () => {
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

  it('collapses two util-only nodes for the same (file, name) with no canonical twin, keeping the first as survivor', () => {
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

    it('does not exclude the frontend dir when it IS the whole product (docs-only root)', () => {
      writeFrontendManifest(path.join(root, 'app'));
      fs.writeFileSync(path.join(root, 'README.md'), '# docs only');

      expect(orch.getBundledFrontendRoots(root)).toEqual([]);
      // The Prisma schema inside the app must therefore stay a primary product path.
      expect(orch.isPrimaryProductPathForProject('app/prisma/schema.prisma', root)).toBe(true);
    });

    it('still excludes a frontend dir bundled into a root-manifest product', () => {
      writeFrontendManifest(path.join(root, 'web'));
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'backend', dependencies: { express: '^4.0.0' } }));

      expect(orch.getBundledFrontendRoots(root)).toEqual([path.join(root, 'web')]);
    });

    it('still excludes a frontend dir when a sibling backend package exists', () => {
      writeFrontendManifest(path.join(root, 'web'));
      fs.mkdirSync(path.join(root, 'server'), { recursive: true });
      fs.writeFileSync(path.join(root, 'server', 'go.mod'), 'module example.com/server');

      expect(orch.getBundledFrontendRoots(root)).toEqual([path.join(root, 'web')]);
    });
  });

  it('surfaces Prisma schema models as persisted data entities with analyzer-parsed fields', () => {
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

  describe('operation-shaped and format-token shapes stay out of the entity set (openclaw gap)', () => {
    it('excludes a params shape whose core noun is a callable in the graph', () => {
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

    it('excludes serialization-format tokens left over from suffix stripping', () => {
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
    it('drops infra/runtime/lifecycle-shaped non-persisted DTOs but keeps domain DTOs (openclaw fallback)', () => {
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

    it('keeps an infra-NAMED shape when it carries persisted-entity evidence (kind exemption)', () => {
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

    it('never blanks the entity model when EVERY shape reads as infrastructure', () => {
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

  it('dedupes same-named ORM entities into one richest-evidence entry with merged lifecycle (hercules gap)', () => {
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

describe('repairDanglingSentenceEndings', () => {
  it('strips a trailing dangling preposition left by a truncated clause (the accepted Klauro description class)', () => {
    const text = 'Klauro is a codebase analysis platform built as a monorepo. It stores telemetry data and graph evidence for.';
    expect(orch.repairDanglingSentenceEndings(text)).toBe(
      'Klauro is a codebase analysis platform built as a monorepo. It stores telemetry data and graph evidence.'
    );
  });

  it('strips stacked dangling function words back to the last content word', () => {
    expect(orch.repairDanglingSentenceEndings('The service records analysis runs and exposes them to agents with the.'))
      .toBe('The service records analysis runs and exposes them to agents.');
  });

  it('drops a sentence gutted by the repair when other sentences remain', () => {
    expect(orch.repairDanglingSentenceEndings('The service runs scheduled analysis jobs across every repository. Built for and with the.'))
      .toBe('The service runs scheduled analysis jobs across every repository.');
  });

  it('leaves clean prose untouched', () => {
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

  it('identity-mechanism capability on a NON-auth repo is supporting, never core/high', () => {
    const userEntity = capEntity({ name: 'User' });
    const category = orch.inferTerminalCapabilityCategory(
      'user', authMechanismNodes, [userEntity], { identityShare: 0.02, observabilityShare: 0 });
    expect(category).toBe('supporting');
    const criticality = orch.inferTerminalCriticality(authMechanismNodes, [userEntity]);
    expect(criticality).not.toBe('high');
    expect(criticality).not.toBe('critical');
  });

  it('the same identity shape on an auth PRODUCT (auth-analyzer-heavy repo evidence) may be core', () => {
    const sessionResponse = capEntity({ name: 'SessionToken', kind: 'api-response', kind_source: 'framework-evidence' });
    const category = orch.inferTerminalCapabilityCategory(
      'user', authMechanismNodes, [sessionResponse], { identityShare: 0.4, observabilityShare: 0 });
    expect(category).toBe('core');
  });

  it("categorizes a pricing capability by evidence, not the retired 'price' keyword", () => {
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

  it('observability-instrumentation groups are supporting on non-observability products', () => {
    const otelNodes = [
      capNode({ id: 'o1', name: 'span: analyze', type: 'function', metadata: { subcategories: ['observability-instrumentation', 'span', 'otel'] } as any }),
      capNode({ id: 'o2', name: 'traces.ts observability surface', type: 'module', metadata: { subcategories: ['observability-module'] } as any }),
    ];
    expect(orch.inferTerminalCapabilityCategory(
      'trace', otelNodes, [], { identityShare: 0, observabilityShare: 0.01 })).toBe('supporting');
  });

  it('bare entity possession without lifecycle breadth is not core (honest distributions)', () => {
    // The retired rule was "any group with entities → core", which produced
    // 100%-core capability sets. A dangling DTO with no operating nodes is
    // not proof of product value.
    expect(orch.inferTerminalCapabilityCategory(
      'preference', [], [capEntity({ name: 'CustomerPreference' })],
      { identityShare: 0, observabilityShare: 0 })).toBe('supporting');
  });

  it('no hardcoded category keyword list or name-based criticality boost remains (grep)', () => {
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

  it('merges verb-variant capabilities over the identical entity set, keeping the core-most copy and merging evidence', () => {
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

  it('merges a subset-entity capability with no distinct operations into the superset', () => {
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

  it('keeps a subset-entity capability that carries distinct operations', () => {
    const merged = orch.dedupeSystemCapabilitiesByName([
      capFixture({ name: 'Manages orders', related_entities: ['Order', 'OrderLine'] }),
      capFixture({
        name: 'Exports order lines', related_entities: ['OrderLine'],
        operations: [{ entry_point_id: 'ep_export', entry_point_type: 'cli', action: 'export' }],
      }),
    ]);
    expect(merged).toHaveLength(2);
  });

  it('never set-merges capabilities with no related entities', () => {
    const merged = orch.dedupeSystemCapabilitiesByName([
      capFixture({ name: 'Health checks' }),
      capFixture({ name: 'Log rotation' }),
    ]);
    expect(merged).toHaveLength(2);
  });
});

describe('capability hygiene: code-artifact entity filter (evidence-first)', () => {
  it('flags infra-role head nouns only', () => {
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

  it('flags the widened suffix + verb-callable + internal-role artifact shapes (live openclaw/kontinuum)', () => {
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

  it('derive path drops an artifact shape without persistence evidence, keeps one WITH ORM evidence', () => {
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

  it('a code-artifact entity without persistence evidence never seeds a terminal capability', () => {
    const artifactEntity: CASDataEntity = {
      id: 'entity_registertelegramhandler', name: 'RegisterTelegramHandler',
      kind: 'value-object', kind_source: 'framework-evidence',
      lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] },
    } as CASDataEntity;
    const capabilities = orch.buildTerminalCapabilities([artifactEntity], [], [], new Set<string>());
    expect(capabilities).toHaveLength(0);
  });

  it('a role-suffixed entity WITH persistence evidence still anchors a capability', () => {
    const persistedEntity: CASDataEntity = {
      id: 'entity_orderhandler', name: 'OrderHandler',
      kind: 'persisted-entity', kind_source: 'framework-evidence',
      lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] },
    } as CASDataEntity;
    const capabilities = orch.buildTerminalCapabilities([persistedEntity], [], [], new Set<string>());
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

  it('FLAGSHIP: re-injects a behavior-surface candidate the AI catalog dropped (Klauro 207-tool MCP surface)', () => {
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
    const surface = out.find((c: any) => c.evidence_kind === 'behavior-surface');
    expect(surface).toBeDefined();
    expect(surface.name).toBe('Mcp Tool Surface');
    // The surface must NOT swallow the entity-anchored Codebase capability whose
    // records its handlers incidentally reach.
    expect(out.some((c: any) => c.name === 'Surfaces codebase analysis results')).toBe(true);
  });

  it('FLAGSHIP: does NOT re-inject when the catalog already covers that surface subject', () => {
    const cataloged = [cap({ name: 'Exposes MCP tools to agents', category: 'core', related_entities: ['Codebase'], related_domains: ['mcp-tool'] })];
    const behaviorCandidate = cap({
      name: 'Mcp Tool Surface', structural_label: 'Mcp Tool Surface',
      category: 'core', evidence_kind: 'behavior-surface', related_domains: ['mcp-tool'],
    });
    const out = orch.reconcileCatalogedCapabilities(cataloged, [behaviorCandidate], []);
    expect(out.filter((c: any) => /mcp/i.test(c.name))).toHaveLength(1); // no duplicate surface
  });

  it('PURPOSE GATE: drops infra/runtime-only capabilities, keeps product ones (openclaw)', () => {
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

  it('PURPOSE GATE: an infra-shaped name with PERSISTED evidence is kept (product record)', () => {
    const dataEntities = [entity('RuntimeConfig', 'persisted-entity')];
    const cataloged = [cap({ name: 'Manages runtime config', category: 'core', related_entities: ['RuntimeConfig'] })];
    const out = orch.reconcileCatalogedCapabilities(cataloged, [], dataEntities);
    expect(out.map((c: any) => c.name)).toContain('Manages runtime config');
  });

  it('DEDUP: collapses verb-variant near-dups on the same entity set (Klauro telemetry/connections)', () => {
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

  it('excludes fixture/test-path journeys from comprehension inputs while the journey list itself is untouched', () => {
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

  it('falls back to the handler node path when the entry point is unknown, and keeps journeys with no source evidence', () => {
    const journeys = [
      journey('journey_orphan_test', 'ep_unknown', 'test-handler'),
      journey('journey_orphan_product', 'ep_unknown', 'product-handler'),
      journey('journey_no_evidence', 'ep_unknown', undefined),
    ];
    const filtered = orch.filterPrimaryProductJourneys(journeys, entryPoints, nodes, projectPath);
    expect(filtered.map((j: any) => j.id)).toEqual(['journey_orphan_product', 'journey_no_evidence']);
  });

  it('excludes fixture-sourced data entities from comprehension entity seeds', () => {
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

  it('framework list for the narrative excludes fixture-sourced, adapter-shim, and library-category frameworks', () => {
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

  it('keeps api-response/persisted entities and drops raw node names and non-output kinds', () => {
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

  it('gives an entity with unknown kind the benefit of the doubt, but never an unresolved node name', () => {
    const facts = factsWith([entity('AssetAnalysis', undefined)]);
    const outputs = (facts.terminalOutputs as string[]) || [];
    expect(outputs.some(o => o.startsWith('AssetAnalysis'))).toBe(true);
    expect(outputs.some(o => o.startsWith('GraphExplorer'))).toBe(false);
  });

  it('passes the ranked list through unchanged when no entity catalog exists to resolve against', () => {
    const facts = factsWith([]);
    const outputs = (facts.terminalOutputs as string[]) || [];
    expect(outputs.some(o => o.startsWith('AssetAnalysis'))).toBe(true);
    expect(outputs.some(o => o.startsWith('GraphExplorer'))).toBe(true);
  });
});

describe('stripped-sentence grammar guard and repetition collapse (live mtg/hercules defects)', () => {
  it('repairs the live dangling-clause stump "...graph evidence for."', () => {
    expect(orch.repairStrippedSentenceGrammar('It works by providing telemetry data and graph evidence for.'))
      .toBe('It works by providing telemetry data and graph evidence.');
  });

  it('repairs the live broken-coordination stump "a robust and solution"', () => {
    expect(orch.repairStrippedSentenceGrammar('The service offers a robust and solution.'))
      .toBe('The service offers a robust solution.');
  });

  it('drops a sentence that cannot be restored to clause shape when other sentences remain', () => {
    const text = 'The service records analysis runs for agents. Providing a the and.';
    expect(orch.repairStrippedSentenceGrammar(text)).toBe('The service records analysis runs for agents.');
  });

  it('sanitizeAIInterpretation no longer manufactures a dangling "for" from a bare "insights"', () => {
    const purpose = { primary_domain: 'order-management', core_concepts: ['orders'] } as any;
    const sanitized = orch.sanitizeAIInterpretation(
      'The platform manages customer orders and produces insights.',
      purpose,
      {}
    );
    expect(sanitized.endsWith('for.')).toBe(false);
    expect(sanitized).toContain('graph evidence');
  });

  it('collapses the same domain-justification sentence restated 3x to one sentence', () => {
    const text = 'The system\'s domain is inferred from its dependencies and entities. ' +
      'The system\'s domain is clearly inferred from its dependencies and entities. ' +
      'The domain of the system is inferred from its entities and dependencies.';
    const collapsed = orch.collapseNearDuplicateSentences(text);
    expect(collapsed.split(/(?<=[.!?])\s+/)).toHaveLength(1);
  });

  it('keeps genuinely distinct sentences intact', () => {
    const text = 'Klauro analyzes codebases into a relationship graph. Agents query the graph through MCP tools. Telemetry correlates runtime events with static structure.';
    expect(orch.collapseNearDuplicateSentences(text)).toBe(text);
  });

  it('collapses the hercules-style duplicated focus clause across two sentences', () => {
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

  it('derives ONE surface capability from a large diverse mcp_tool registration family', () => {
    // 14 tools, diverse names (no dominant prefix family) — the registration
    // surface itself is the capability, exactly one.
    const toolNames = [
      'get_summary', 'get_call_chain', 'search_nodes', 'semantic_search',
      'analyze_codebase', 'get_route_table', 'get_entry_points', 'get_data_entities',
      'assess_change_risk', 'plan_parallel_work', 'get_coding_context', 'get_erd',
      'validate_agent_change', 'preflight_agent_change',
    ];
    const fixtures = toolNames.map((name, index) => mcpToolEntry(name, index));
    const capabilities = localOrch.buildBehaviorCapabilities(
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
    expect(capability.category).toBe('core');
    expect(capability.criticality).toBe('high');
    expect(capability.operations.length).toBeGreaterThan(0);
    expect(capability.operations.every((operation: any) => operation.entry_point_type === 'message')).toBe(true);
  });

  it('derives shared-prefix socket event families (game_*) as capabilities, ignoring DOM click/change noise', () => {
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

    const capabilities = localOrch.buildBehaviorCapabilities(
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

  it('merges a behavior cluster into an overlapping entity-anchored capability instead of duplicating', () => {
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

    const candidates = localOrch.buildBehaviorCapabilities(
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
    expect(entityCapability.criticality).toBe('medium');
    expect(entityCapability.category).toBe('core');
  });

  it('exercises count restraint: no behavior capability from small or prefix-less surfaces, hard cap overall', () => {
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

    const capabilities = localOrch.buildBehaviorCapabilities(cliEntries, cliNodes, [], []);
    expect(capabilities).toHaveLength(0);
  });

  it('surfaces behavior capabilities through buildSystemCapabilities end-to-end', () => {
    const toolNames = [
      'get_summary', 'get_call_chain', 'search_nodes', 'semantic_search',
      'analyze_codebase', 'get_route_table', 'get_entry_points', 'get_data_entities',
      'assess_change_risk', 'plan_parallel_work', 'get_coding_context', 'get_erd',
    ];
    const fixtures = toolNames.map((name, index) => mcpToolEntry(name, index));
    const capabilities = localOrch.buildSystemCapabilities(
      fixtures.map(fixture => fixture.entry),
      [],
      fixtures.map(fixture => fixture.node),
      []
    );
    const labels = capabilities.map((capability: any) => capability.structural_label || capability.name);
    expect(labels.some((label: string) => /Mcp Tool.*Surface/i.test(label))).toBe(true);
  });
});
