import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import { TerraformAnalyzer } from '../../analyzer/languages/terraform-analyzer';
import { aiService } from '../../ai/ai-service';
import { CASDataEntity, CASEdge, CASExitPoint, CASNode } from '../../types/cas.types';
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

    expect(capabilities.map((capability: any) => capability.name)).toContain('Invoice Settlement');
    expect(capabilities.find((capability: any) => capability.name === 'Invoice Settlement')?.related_entities).toContain('entity-invoice');
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
    const names = capabilities.map((capability: any) => capability.name);
    const relatedDomains = capabilities.map((capability: any) => capability.related_domains).flat();

    expect(names).toContain('Transaction Management');
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
    const names = capabilities.map((capability: any) => capability.name);

    expect(domains).toEqual(expect.arrayContaining(['report', 'portfolio', 'invoice']));
    expect(domains).not.toEqual(expect.arrayContaining(['generate', 'rebalance', 'settle']));
    expect(names).toEqual(expect.arrayContaining(['Report Generation', 'Portfolio Rebalancing', 'Invoice Settlement']));
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
    const names = capabilities.map((capability: any) => capability.name);

    expect(names).toContain('Vehicle Management');
    expect(names).not.toContain('Dto Management');
    expect(names).not.toContain('Constants Capability');
    expect(names).not.toContain('Handling Capability');
    expect(names).not.toContain('Connection Capability');
    expect(names).not.toContain('Support Capability');
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
    const names = capabilities.map((capability: any) => capability.name);
    const domains = capabilities.flatMap((capability: any) => capability.related_domains);

    expect(names).toContain('Location Synchronization');
    expect(domains).toContain('location');
    expect(names).not.toContain('Loc Workflow');
    expect(names).not.toContain('Loc Capability');
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
      expect(names).toContain('Task Management');
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

  it('strips analyzer display-name artifacts so "enhanced rust" never reaches purpose framework names', () => {
    const projectRoot = '/repo/arb_engine';
    const nodes: CASNode[] = [
      node({
        id: 'engine',
        name: 'engine',
        type: 'module',
        source: { file: '/repo/arb_engine/src/engine.rs' },
        metadata: { framework: 'enhanced rust' },
      }),
      node({
        id: 'router',
        name: 'AppRouter',
        type: 'component',
        source: { file: '/repo/arb_engine/ui/src/AppRouter.tsx' },
        metadata: { framework: 'React Router' },
      }),
    ];

    const names = orch.frameworkNamesForPurpose([], nodes, projectRoot);
    expect(names).toContain('rust');
    expect(names).toContain('React Router');
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
    const approvalCapability = capabilities.find((capability: any) => /approval/i.test(capability.name));

    expect(names.some((name: string) => /approval/i.test(name))).toBe(true);
    expect(approvalCapability?.id).toMatch(/^cap_approval/);
    expect(names).not.toContain('Click Management');
    expect(names).not.toContain('Mutation Management');
    expect(names).not.toContain('Query Management');
    expect(names).not.toContain('Latest Management');
    expect(names).not.toContain('Soon Management');
    expect(names.join('\n')).not.toMatch(/\b(click|mutation|query|latest)\s+(management|workflow|capability)\b/i);
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

    expect(names).toContain('Muscle Management');
    expect(names).not.toContain('Next Management');
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
      expect(names).not.toContain('File Workflow');
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
    expect(names).toContain('Wishlist Management');
    expect(names).toContain('Wished Item Management');
    expect(names.some((name: string) => /^Wished Management$/.test(name))).toBe(false);
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
    const names = capabilities.map((capability: { name: string }) => capability.name);
    expect(names).not.toContain('Order Management');
    expect(names).not.toContain('Line Management');
    expect(names).not.toContain('Line Item Management');
    expect(names).toContain('Stock Management');
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
    const names = capabilities.map((capability: { name: string }) => capability.name);

    expect(names).toContain('Order Management');
    expect(names).not.toContain('Bootstrap Management');
    expect(names).not.toContain('Clean Management');
    expect(names).not.toContain('Collect Management');
    expect(names).not.toContain('Materialize Management');
    expect(names).not.toContain('Save Management');
    expect(names).not.toContain('Merge Management');
    expect(names).not.toContain('Thinking Management');
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
    const names = capabilities.map((capability: { name: string }) => capability.name);
    expect(names).not.toContain('Jito Capability');
  });

  it('keeps vendor-token capabilities that carry product evidence', () => {
    const entity: CASDataEntity = {
      id: 'entity_jito_bundle',
      name: 'JitoBundle',
      lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] },
    } as CASDataEntity;

    const capabilities = orch.buildTerminalCapabilities([entity], [], [], new Set<string>());
    const names = capabilities.map((capability: { name: string }) => capability.name);
    expect(names).toContain('Jito Bundle Management');
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
