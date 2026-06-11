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
    const nodes: CASNode[] = [
      node({ id: 'mcp-server-file', name: 'server.ts', type: 'file', source: { file: 'apps/mcp-server/src/server.ts' } }),
      node({ id: 'mcp-tool', name: 'getArchitectureContext', type: 'function', source: { file: 'apps/mcp-server/src/server.ts' } }),
      node({ id: 'analyzer-file', name: 'orchestrator.ts', type: 'file', source: { file: 'packages/analyzer-core/src/analyzer/core/orchestrator.ts' } }),
      node({ id: 'analyzer-class', name: 'AnalyzerOrchestrator', type: 'class', source: { file: 'packages/analyzer-core/src/analyzer/core/orchestrator.ts' } }),
      node({ id: 'legacy-route', name: 'legacyRoute', type: 'function', source: { file: 'legacy/api/routes.ts' } }),
    ];
    const contributions = [
      { analyzer_type: 'framework', analyzer_name: 'Express.js Analyzer', nodes_created: 3, confidence: 1 },
      { analyzer_type: 'framework', analyzer_name: 'NestJS Analyzer', nodes_created: 6, confidence: 1 },
      { analyzer_type: 'language', analyzer_name: 'TypeScript/JavaScript Analyzer', nodes_created: 200 },
    ];

    const summary = orch.buildArchitectureSummary(nodes, [], [], contributions);

    expect(summary.system_type).toBe('MCP analyzer monorepo');
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

  it('uses product-surface capability names and filters helper buckets', () => {
    const nodes: CASNode[] = [
      node({ id: 'agent', name: 'AgentWorkflowService', type: 'service', source: { file: 'src/agent-workflow.ts' } }),
      node({ id: 'runtime', name: 'RuntimeTelemetryService', type: 'service', source: { file: 'src/runtime-simulation.ts' } }),
      node({ id: 'proposal', name: 'ProposalPreviewService', type: 'service', source: { file: 'src/proposal-preview-html.ts' } }),
      node({ id: 'compatible', name: 'PathsCompatibleService', type: 'service', source: { file: 'src/query.ts' } }),
    ];

    const capabilities = orch.buildSystemCapabilities([], [], nodes, []);
    const names = capabilities.map((capability: any) => capability.name);

    expect(names).toEqual(expect.arrayContaining(['Agent Work Packets', 'Runtime Telemetry', 'Proposal Preview']));
    expect(names).not.toContain('Agent Management');
    expect(names).not.toContain('Runtime Management');
    expect(names).not.toContain('Proposal Management');
    expect(names).not.toContain('Compatible Management');
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

  it('prefers broader product data domains over incidental auth/login capabilities', () => {
    const capabilities = [
      { name: 'Login Management', related_domains: ['login'], related_entities: [], operations: [] },
      { name: 'Logout Management', related_domains: ['logout'], related_entities: [], operations: [] },
      { name: 'Product Management', related_domains: ['product'], related_entities: ['ProductConnection'], operations: [] },
      { name: 'Company Source Management', related_domains: ['company', 'source'], related_entities: ['CompanySourceLog'], operations: [] },
      { name: 'Serializers Management', related_domains: ['serializers'], related_entities: [], operations: [] },
    ];
    const concepts = [
      { name: 'product', nodes: [], entry_points: [], data_entities: [], confidence: 0.9 },
      { name: 'company source', nodes: [], entry_points: [], data_entities: [], confidence: 0.8 },
    ];

    expect(orch.inferPrimaryDomainFromCapabilities(capabilities, concepts)).toBe('product-data-management');
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

    expect(cliKey).toBe('invoice');
    expect(messageKey).toBe('invoice');
    expect(orch.inferResourceName({ type: 'cli' } as any, cliKey)).toBe('Invoice Commands');
    expect(orch.inferResourceName({ type: 'message' } as any, messageKey)).toBe('Invoice Handlers');
  });

  it('keeps quick descriptions focused on product capabilities', () => {
    const description = orch.buildQuickDescription(
      { primary_type: 'backend-service' },
      { capabilities: [] },
      ['ProductConnection', 'CompanySourceLog'],
      [{ type: 'http', count: 10 }],
      ['Django'],
      [],
      [
        { name: 'Product Management', category: 'core', criticality: 'medium', operations: [{ action: 'Read' }], related_domains: ['product'], related_entities: ['ProductConnection'] },
        { name: 'Products Management', category: 'core', criticality: 'medium', operations: [{ action: 'Read' }], related_domains: ['products'], related_entities: [] },
        { name: 'Method Management', category: 'supporting', criticality: 'low', operations: [{ action: 'Read' }], related_domains: ['method'], related_entities: [] },
        { name: 'Checkconnectivity Management', category: 'supporting', criticality: 'low', operations: [{ action: 'Validate' }], related_domains: ['connectivity'], related_entities: [] },
        { name: 'Fetch Products Management', category: 'supporting', criticality: 'low', operations: [{ action: 'Read' }], related_domains: ['products'], related_entities: [] },
        { name: 'Generator Management', category: 'supporting', criticality: 'low', operations: [{ action: 'Read' }], related_domains: ['generator'], related_entities: [] },
        { name: 'Select Project Management', category: 'supporting', criticality: 'low', operations: [{ action: 'Read' }], related_domains: ['select', 'project'], related_entities: [] },
        { name: 'Events Handlers', category: 'supporting', criticality: 'medium', operations: [{ action: 'Handle' }], related_domains: ['events'], related_entities: [] },
        { name: 'Company Source Management', category: 'core', criticality: 'medium', operations: [{ action: 'Read' }], related_domains: ['company', 'source'], related_entities: ['CompanySourceLog'] },
      ],
      'product-data-management',
      ['product', 'company-source']
    );

    expect(description).toContain('coordinates product and company workflows');
    expect(description).toContain('Its model centers on product connection and company source log');
    expect(description).toContain('HTTP endpoints');
    expect(description).not.toContain('Key capabilities:');
    expect(description).not.toContain('Data model:');
    expect(description).not.toContain('Entry points:');
    expect(description).not.toContain('products management');
    expect(description).not.toContain('fetch products');
    expect(description).not.toContain('generator management');
    expect(description).not.toContain('select project');
    expect(description).not.toContain('event handling');
    expect(description).not.toContain('events handlers');
    expect(description).not.toContain('method management');
    expect(description).not.toContain('checkconnectivity');
  });

  it('uses a natural article for user-oriented generated descriptions', () => {
    expect(orch.articleFor('user identity management')).toBe('A');
    expect(orch.articleFor('identity management')).toBe('An');
  });

  it('records description generation source when AI interpretation is skipped', async () => {
    const previous = process.env.KLAURO_AI_INTERPRETATION;
    process.env.KLAURO_AI_INTERPRETATION = 'false';
    const purpose: any = {
      primary_type: 'backend-service',
      confidence: 0.8,
      evidence: [],
      primary_domain: 'portfolio-management',
      core_concepts: ['portfolio', 'trade'],
      inferred_description: 'This backend service manages portfolio and trade workflows using detected entry points and domain entities.',
      supporting_workflow_ids: [],
    };

    let callsBeforeRestore = 0;
    try {
      await orch.applyAIInterpretation(purpose, 'portfolio-api', ['NestJS'], [], [], [], { capabilities: [] }, []);
    } finally {
      if (previous === undefined) {
        delete process.env.KLAURO_AI_INTERPRETATION;
      } else {
        process.env.KLAURO_AI_INTERPRETATION = previous;
      }
    }

    expect(purpose.description_source).toBe('deterministic');
    expect(purpose.description_generation).toEqual(expect.objectContaining({
      status: 'ai_skipped',
      attempted: false,
      reason: 'disabled-by-env',
    }));
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
    const previousLocal = process.env.AI_LOCAL_ENABLED;
    const previousElementDescriptions = process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS;
    process.env.AI_LOCAL_ENABLED = 'true';
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
      if (previousLocal === undefined) {
        delete process.env.AI_LOCAL_ENABLED;
      } else {
        process.env.AI_LOCAL_ENABLED = previousLocal;
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

  it('uses curated subject descriptions when AI output is generic or ungrounded', async () => {
    const previousLocal = process.env.AI_LOCAL_ENABLED;
    process.env.AI_LOCAL_ENABLED = 'true';
    const spy = jest.spyOn(aiService, 'generateComponentDescription').mockResolvedValue(JSON.stringify({
      descriptions: [
        { id: 'cap_0', description: 'This crucial component provides robust operations for various application functionality.' },
      ],
    }));
    const capabilities: any[] = [{
      id: 'cap_0',
      name: 'Invoice Settlement',
      description: 'settle operations for invoice settlement',
      description_source: 'deterministic',
      description_generation: { status: 'deterministic_initial', attempted: false },
      category: 'core',
      operations: [],
      related_entities: [],
      related_domains: ['invoice'],
      criticality: 'high',
      criticality_factors: [],
    }];

    try {
      await orch.applyAIElementDescriptions(capabilities, [], { systemName: 'billing-api' });
    } finally {
      spy.mockRestore();
      if (previousLocal === undefined) {
        delete process.env.AI_LOCAL_ENABLED;
      } else {
        process.env.AI_LOCAL_ENABLED = previousLocal;
      }
    }

    expect(capabilities[0].description).toBe('Invoice Management maintains invoice records, workflows, and relationships used by invoice behavior.');
    expect(capabilities[0].description_source).toBe('manual');
    expect(capabilities[0].description_generation).toEqual(expect.objectContaining({
      status: 'deterministic_kept',
      attempted: true,
      reason: 'curated-product-capability-description',
    }));
  });

  it('uses curated infrastructure description when file workflow AI output is generic', async () => {
    const previousLocal = process.env.AI_LOCAL_ENABLED;
    process.env.AI_LOCAL_ENABLED = 'true';
    const spy = jest.spyOn(aiService, 'generateComponentDescription').mockResolvedValue(JSON.stringify({
      descriptions: [
        { id: 'cap_0', description: 'File Workflow covers read and analyze paths for files.' },
      ],
    }));
    const capabilities: any[] = [{
      id: 'cap_0',
      name: 'File Workflow',
      description: 'File Workflow covers read paths; spans main.tf.',
      description_source: 'deterministic',
      description_generation: { status: 'deterministic_initial', attempted: false },
      category: 'core',
      operations: [],
      related_entities: [],
      related_domains: ['file'],
      criticality: 'medium',
      criticality_factors: [],
    }];

    try {
      await orch.applyAIElementDescriptions(capabilities, [], { systemName: 'infrastructure' });
    } finally {
      spy.mockRestore();
      if (previousLocal === undefined) {
        delete process.env.AI_LOCAL_ENABLED;
      } else {
        process.env.AI_LOCAL_ENABLED = previousLocal;
      }
    }

    expect(capabilities[0].description).toBe('Infrastructure Definition captures resource files, variables, modules, and provider relationships so agents can understand what cloud resources the stack manages.');
    expect(capabilities[0].description_source).toBe('manual');
    expect(capabilities[0].description_generation).toEqual(expect.objectContaining({
      status: 'deterministic_kept',
      attempted: true,
      reason: 'curated-product-capability-description',
    }));
  });

  it('repairs rejected AI capability descriptions once before falling back', async () => {
    const previousLocal = process.env.AI_LOCAL_ENABLED;
    const previousElementDescriptions = process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS;
    process.env.AI_LOCAL_ENABLED = 'true';
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
      if (previousLocal === undefined) {
        delete process.env.AI_LOCAL_ENABLED;
      } else {
        process.env.AI_LOCAL_ENABLED = previousLocal;
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

  it('attempts AI interpretation by default instead of keeping deterministic descriptions', () => {
    const previous = process.env.KLAURO_AI_INTERPRETATION_ALLOW_DETERMINISTIC_KEEP;
    delete process.env.KLAURO_AI_INTERPRETATION_ALLOW_DETERMINISTIC_KEEP;
    try {
      expect(orch.shouldKeepDeterministicSystemDescription({
        primary_type: 'backend-service',
        confidence: 0.8,
        evidence: [],
        primary_domain: 'product-data-management',
        core_concepts: ['product', 'company-source'],
        inferred_description: 'A product data management system built with Django that coordinates product and company source workflows. Its model centers on product connection and company source log, it is exercised through HTTP endpoints.',
        supporting_workflow_ids: [],
      })).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.KLAURO_AI_INTERPRETATION_ALLOW_DETERMINISTIC_KEEP;
      } else {
        process.env.KLAURO_AI_INTERPRETATION_ALLOW_DETERMINISTIC_KEEP = previous;
      }
    }
  });

  it('uses project guidance files to infer useful product descriptions', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-purpose-'));
    try {
      fs.writeFileSync(path.join(temp, 'composer.json'), JSON.stringify({
        name: 'truckspy/truckspyapp',
        description: 'TruckSpyApp backend',
      }));
      fs.writeFileSync(path.join(temp, 'CLAUDE.md'), [
        '# CLAUDE.md',
        '## Project Overview',
        'TruckSpy is a comprehensive fleet management system that provides real-time tracking, compliance management, safety monitoring, and operational insights for commercial vehicle fleets.',
        'The platform integrates with 20+ telematics providers and offers multi-tenant SaaS capabilities.',
        'Key domains include ELD compliance, drive alerts, inspections, maintenance, dispatching, fuel management, IFTA reports, and Apache Superset analytics.',
      ].join('\n'));

      const signal = orch.extractProjectTextSignal(temp);

      expect(signal.primaryDomain).toBe('fleet-management');
      expect(signal.concepts).toEqual(expect.arrayContaining(['fleet-management', 'telematics', 'vehicle']));
      expect(signal.summary).toContain('fleet management system');
      expect(signal.summary).toContain('real-time tracking');
      expect(signal.summary).not.toContain('Key concepts:');
      expect(signal.evidence).toContain('CLAUDE.md');
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
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

  it('uses project text signals to override structural frontend noise', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-project-text-'));
    try {
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'website' }));
      fs.mkdirSync(path.join(root, 'src/app'), { recursive: true });
      fs.writeFileSync(path.join(root, 'src/app/page.tsx'), [
        'export const metadata = { title: "Zero Trust Security, Simplified" };',
        'export default function Home() { return <main>Zero trust security for secure network access and continuous verification.</main>; }',
      ].join('\n'));

      const signal = orch.extractProjectTextSignal(root);
      const refined = orch.refinePrimaryDomain('page', 'website', [], [], signal);

      expect(signal.primaryDomain).toBe('zero-trust-security');
      expect(refined).toBe('zero-trust-security');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('lets a grounded structural domain beat the text-keyword catalog', () => {
    const capabilities = [
      {
        name: 'Fleet Management',
        description: 'Coordinates fleet operations',
        category: 'core',
        related_domains: ['fleet'],
        related_entities: ['Vehicle', 'Driver', 'Dispatch'],
        operations: [],
      },
      {
        name: 'Vehicle Management',
        description: 'Tracks vehicles',
        category: 'core',
        related_domains: ['vehicle'],
        related_entities: ['Vehicle'],
        operations: [],
      },
    ];
    const coreConcepts = [{ name: 'Vehicle' }, { name: 'Driver' }, { name: 'Dispatch' }];
    const signal = {
      primaryDomain: 'billing-payments',
      concepts: ['invoice', 'billing'],
      evidence: ['README.md'],
    };

    expect(orch.refinePrimaryDomain('unknown', 'some-app', capabilities, coreConcepts, signal)).toBe('fleet-management');
  });

  it('does not let an ungrounded structural domain beat a specific text domain', () => {
    const capabilities = [
      {
        name: 'Fleet Management',
        description: '',
        category: 'core',
        related_domains: [],
        related_entities: [],
        operations: [],
      },
    ];
    const signal = {
      primaryDomain: 'clinical-testing',
      concepts: ['patient', 'measurement'],
      evidence: ['README.md'],
    };

    expect(orch.refinePrimaryDomain('unknown', 'some-app', capabilities, [], signal)).toBe('clinical-testing');
  });

  it('classifies zero-trust style structure from gateway/access/policy entities without name checks', () => {
    const capabilities = [
      {
        name: 'Gateway Management',
        description: 'Provision and pause gateways',
        category: 'core',
        related_domains: ['gateway'],
        related_entities: ['Gateway', 'InlineGateway'],
        operations: [],
      },
      {
        name: 'Access Request Management',
        description: 'Review access requests against policies',
        category: 'core',
        related_domains: ['access'],
        related_entities: ['AccessRequest', 'AccessBinding', 'Policy'],
        operations: [],
      },
      {
        name: 'Network Management',
        description: 'Manage networks and posture checks',
        category: 'core',
        related_domains: ['network'],
        related_entities: ['Network', 'PostureCheck'],
        operations: [],
      },
    ];
    const coreConcepts = [{ name: 'Gateway' }, { name: 'AccessRequest' }, { name: 'Policy' }, { name: 'Network' }];

    expect(orch.inferPrimaryDomainFromCapabilities(capabilities, coreConcepts)).toBe('network-access-management');
    expect(orch.refinePrimaryDomain('unknown', 'some-platform', capabilities, coreConcepts, { concepts: [], evidence: [] }))
      .toBe('network-access-management');
  });

  it('classifies codebase-analysis structure from analyzer/cas/mcp vocabulary without name checks', () => {
    const capabilities = [
      {
        name: 'Codebase Analysis',
        description: 'Analyze repositories into a graph',
        category: 'core',
        related_domains: ['analysis'],
        related_entities: ['Analysis', 'AnalysisSnapshot'],
        operations: [],
      },
      {
        name: 'Agent Context',
        description: 'Serve MCP work packets from the CAS graph',
        category: 'core',
        related_domains: ['mcp'],
        related_entities: ['WorkPacket'],
        operations: [],
      },
    ];
    const coreConcepts = [{ name: 'Analyzer' }, { name: 'Codebase' }, { name: 'CAS' }];

    expect(orch.inferPrimaryDomainFromCapabilities(capabilities, coreConcepts)).toBe('codebase-analysis');
  });

  it('classifies conflicting top-level areas separately and surfaces secondary domains', () => {
    const nodes: CASNode[] = [
      node({ id: 'order-model', name: 'Order', type: 'entity', source: { file: 'app/models/order.rb' } }),
      node({ id: 'invoice-model', name: 'Invoice', type: 'entity', source: { file: 'app/models/invoice.rb' } }),
      node({ id: 'payment-model', name: 'Payment', type: 'entity', source: { file: 'app/models/payment.rb' } }),
      node({ id: 'orders-controller', name: 'OrdersController', type: 'controller', source: { file: 'app/controllers/orders_controller.rb' } }),
      node({ id: 'invoices-controller', name: 'InvoicesController', type: 'controller', source: { file: 'app/controllers/invoices_controller.rb' } }),
      node({ id: 'payments-service', name: 'PaymentCaptureService', type: 'service', source: { file: 'app/services/payment_capture_service.rb' } }),
      node({ id: 'tf-vpc', name: 'aws_vpc.main', type: 'resource', source: { file: 'terraform/vpc.tf' } }),
      node({ id: 'tf-ecs', name: 'aws_ecs_cluster.app', type: 'resource', source: { file: 'terraform/ecs.tf' } }),
      node({ id: 'tf-rds', name: 'aws_db_instance.primary', type: 'resource', source: { file: 'terraform/rds.tf' } }),
    ];

    const areas = orch.classifyTopLevelAreaDomains(nodes, '/tmp/shop-app');
    expect(areas.map((area: any) => area.area)).toEqual(expect.arrayContaining(['app', 'terraform']));
    expect(areas.find((area: any) => area.area === 'terraform')?.domain).toBe('cloud-infrastructure');
    expect(areas.find((area: any) => area.area === 'app')?.domain).toBe('order-invoice-management');

    const resolution = orch.reconcilePrimaryDomainWithAreas('order-invoice-management', areas);
    expect(resolution.primaryDomain).toBe('order-invoice-management');
    expect(resolution.secondaryDomains).toEqual([
      { domain: 'cloud-infrastructure', areas: ['terraform'], node_share: expect.any(Number) },
    ]);
  });

  it('picks the primary domain by product-node weight when the catalog claims a minority area', () => {
    const nodes: CASNode[] = [
      node({ id: 'order-model', name: 'Order', type: 'entity', source: { file: 'app/models/order.rb' } }),
      node({ id: 'invoice-model', name: 'Invoice', type: 'entity', source: { file: 'app/models/invoice.rb' } }),
      node({ id: 'payment-model', name: 'Payment', type: 'entity', source: { file: 'app/models/payment.rb' } }),
      node({ id: 'orders-controller', name: 'OrdersController', type: 'controller', source: { file: 'app/controllers/orders_controller.rb' } }),
      node({ id: 'invoices-controller', name: 'InvoicesController', type: 'controller', source: { file: 'app/controllers/invoices_controller.rb' } }),
      node({ id: 'payments-service', name: 'PaymentCaptureService', type: 'service', source: { file: 'app/services/payment_capture_service.rb' } }),
      node({ id: 'tf-vpc', name: 'aws_vpc.main', type: 'resource', source: { file: 'terraform/vpc.tf' } }),
      node({ id: 'tf-ecs', name: 'aws_ecs_cluster.app', type: 'resource', source: { file: 'terraform/ecs.tf' } }),
      node({ id: 'tf-rds', name: 'aws_db_instance.primary', type: 'resource', source: { file: 'terraform/rds.tf' } }),
    ];

    const areas = orch.classifyTopLevelAreaDomains(nodes, '/tmp/shop-app');
    const resolution = orch.reconcilePrimaryDomainWithAreas('cloud-infrastructure', areas);

    expect(resolution.primaryDomain).toBe('order-invoice-management');
    expect(resolution.secondaryDomains.map((entry: any) => entry.domain)).toContain('cloud-infrastructure');
  });

  it('does not report secondary domains when a single area disagrees with the primary', () => {
    const resolution = orch.reconcilePrimaryDomainWithAreas('fleet-management', [
      { area: 'src', domain: 'billing-payments', nodeCount: 50, share: 1 },
    ]);

    expect(resolution.primaryDomain).toBe('fleet-management');
    expect(resolution.secondaryDomains).toEqual([]);
  });

  it('does not let infrastructure libraries override explicit zero-trust product domains', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-zero-trust-domain-'));
    try {
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@secure-access/source' }));
      fs.mkdirSync(path.join(root, 'libs/infrastructure/database/src/entities'), { recursive: true });
      fs.mkdirSync(path.join(root, 'apps/admin-api/src/app/gateway'), { recursive: true });
      fs.writeFileSync(path.join(root, 'libs/infrastructure/database/src/entities/accessRequest.entity.ts'), [
        'export class AccessRequest { organizationId: string; resourceId?: string; gatewayId?: string; }',
      ].join('\n'));
      fs.writeFileSync(path.join(root, 'apps/admin-api/src/app/gateway/gateway-web.controller.ts'), [
        'export class GatewayWebController {',
        '  createGateway() { return "Create gateway for secure network access"; }',
        '  createAccessRequest() { return "Access request for protected resource"; }',
        '  pauseAccess() { return "Pause access to a gateway"; }',
        '}',
      ].join('\n'));

      const signal = orch.extractProjectTextSignal(root);

      expect(signal.primaryDomain).toBe('zero-trust-security');
      expect(signal.primaryDomain).not.toBe('cloud-infrastructure');
      expect(signal.concepts).toEqual(expect.arrayContaining(['access-request', 'gateway']));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not let test fixture copy override the project text domain', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-project-text-fixture-'));
    try {
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
        name: '@acme/code-graph',
        description: 'Monorepo for CAS analysis, MCP agent context, hosted analyzers, and incremental codebase analysis.',
      }));
      fs.writeFileSync(path.join(root, 'README.md'), '# Code Graph\n\nCAS analysis and MCP agent context for codebase intelligence.');
      fs.mkdirSync(path.join(root, 'packages/analyzer-core/src/__tests__/fixtures/zero-trust'), { recursive: true });
      fs.writeFileSync(path.join(root, 'packages/analyzer-core/src/__tests__/fixtures/zero-trust/page.tsx'), [
        'export default function Fixture() {',
        '  return <main>Zero trust security for secure network access and continuous verification.</main>;',
        '}',
      ].join('\n'));

      const signal = orch.extractProjectTextSignal(root);

      expect(signal.primaryDomain).toBe('codebase-analysis');
      expect(signal.primaryDomain).not.toBe('zero-trust-security');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('strips agent tooling instructions from guide-file project text so they cannot poison domain inference', () => {
    const guide = [
      '# My Game',
      'A tactical role-playing game with crafting, combat, and quests.',
      'Use Klauro as the architecture brief before broad file reads.',
      'Call get_agent_work_packet for real work so CAS resolves the target.',
      'When an MCP client starts from prompts, use the agent_coding_session prompt.',
      'Players recruit party members and explore dungeons.',
    ].join('\n');

    const stripped = orch.stripAgentToolingInstructionText(guide);

    expect(stripped).toContain('tactical role-playing game');
    expect(stripped).toContain('recruit party members');
    expect(stripped).not.toMatch(/klauro|work packet|mcp/i);
  });

  it('does not derive capability domains from UI or framework mechanics tokens', () => {
    for (const text of ['sortByDate', 'filterColumns', 'getChildren', 'objectKeys', 'iconForStatus', 'ngrxEffects', 'provideStoreNgrx', 'toggleDropdown', 'paginationState']) {
      expect(orch.domainKeyFromText(text)).toBeUndefined();
    }
    expect(orch.domainKeyFromText('evidenceRequest')).toBe('evidence');
    expect(orch.domainKeyFromText('vehicleInspection')).toBe('vehicle');
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

  it('uses the product category as primary domain for clinical platforms instead of the repo name', () => {
    expect(orch.refinePrimaryDomainForPurpose('hoggan', { primary_type: 'clinical-testing-platform' })).toBe('clinical-testing');
  });

  it('does not let hardware or medical purpose labels override stronger product domains', () => {
    expect(orch.refinePrimaryDomainForPurpose('solana-arbitrage', { primary_type: 'hardware-device-software' })).toBe('solana-arbitrage');
    expect(orch.refinePrimaryDomainForPurpose('testing-utilities-net', { primary_type: 'medical-device-software' })).toBe('testing-utilities-net');
    expect(orch.refinePrimaryDomainForPurpose('sensor', { primary_type: 'hardware-device-software' })).toBe('hardware-device');
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

  it('recognizes ecommerce storefront and personal assistant project text domains', () => {
    expect(orch.inferDomainFromProjectText(
      'Dawn is a Shopify theme for Online Store 2.0 storefronts that helps merchants build ecommerce themes.',
      '/tmp/elevate-skincare'
    )).toBe('ecommerce-storefront');

    expect(orch.inferDomainFromProjectText(
      'OpenClaw is a personal AI assistant with a local-first gateway and multi-channel messaging for WhatsApp, Slack, Discord, and other channels.',
      '/tmp/openclaw'
    )).toBe('personal-ai-assistant');
  });

  it('does not classify order/search/account vocabulary as commerce without a cart, checkout, invoice, or billing anchor', () => {
    expect(orch.inferDomainFromProjectText(
      'A voice conversion web UI where users search models, set the sort order of results, manage account settings, and pick output locations for converted audio.',
      '/tmp/rvc-webui'
    )).not.toBe('commerce-operations-portal');

    expect(orch.inferDomainFromProjectText(
      'Customers manage cart handling, checkout, orders, invoices, and billing for the storefront operations team.',
      '/tmp/shop-ops'
    )).toBe('commerce-operations-portal');
  });

  it('accepts AI descriptions grounded in structural facts when the inferred domain seed is wrong', () => {
    const purpose = { primary_domain: 'cloud-infrastructure', core_concepts: ['terraform', 'module'] };
    const description = 'A laundry service booking application where customers schedule pickups, track washing orders, and manage delivery preferences for their household laundry.';

    expect(orch.validateAIInterpretation(description, purpose).reason).toBe('not-grounded-in-domain-or-concepts');
    expect(orch.validateAIInterpretation(description, purpose, {
      structuralTokens: ['laundry', 'booking', 'pickup', 'delivery'],
    }).ok).toBe(true);
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

  it('does not classify an application repo as cloud infrastructure just because it contains terraform files', () => {
    expect(orch.inferDomainFromProjectText(
      'A Rails application for laundry pickup and delivery, with customer billing and invoices. The repo also contains terraform modules describing AWS VPC and ECS deployment resources for the app.',
      '/tmp/clients/washup'
    )).not.toBe('cloud-infrastructure');

    expect(orch.inferDomainFromProjectText(
      'Terraform modules and providers describing AWS VPC, ECS, RDS, and CloudFront deployment resources with variables and outputs.',
      '/tmp/clients/central-server-infra'
    )).toBe('cloud-infrastructure');
  });

  it('rejects technology names and repo-name echoes as primary domains', () => {
    expect(orch.isNonSemanticDomainLabel('jenkins', 'zerac-ci')).toBe(true);
    expect(orch.isNonSemanticDomainLabel('zerac', 'zerac-ui')).toBe(true);
    expect(orch.isNonSemanticDomainLabel('fleet-management', 'truckspyui')).toBe(false);
  });

  it('does not classify generic commerce access copy as zero-trust security', () => {
    expect(orch.inferDomainFromProjectText(
      'Customers manage account access, cart handling, search, checkout, orders, invoices, billing, and locations in an Angular frontend that talks to protected resources through route guards.',
      '/tmp/hercules/portals/frontend'
    )).toBe('commerce-operations-portal');
  });

  it('requires explicit zero-trust evidence instead of generic access and network words', () => {
    expect(orch.inferDomainFromProjectText(
      'The application manages access to network resources, secure gateways, account screens, and verification forms.',
      '/tmp/random-portal'
    )).toBeUndefined();

    expect(orch.inferDomainFromProjectText(
      'The platform provides zero trust access requests, continuous verification, identity provider integration, and protected resource gateways.',
      '/tmp/secure-access-platform'
    )).toBe('zero-trust-security');
  });

  it('classifies codebase analysis from cas/mcp/analyzer vocabulary without product-name hints', () => {
    expect(orch.inferDomainFromProjectText(
      'A codebase analysis engine that turns repositories into a CAS relationship graph, exposes the analysis through an MCP server, and tracks entry points and call graph data with hosted analyzers.',
      '/tmp/some-monorepo'
    )).toBe('codebase-analysis');
  });

  it('uses Hoggan and patient measurement signals as clinical testing domain text', () => {
    expect(orch.inferDomainFromProjectText(
      'Hoggan Scientific desktop software manages patients, protocols, muscle measurement, device force readings, assessments, reports, and clinical testing workflows.',
      '/tmp/HogganScientific-Rebuild'
    )).toBe('clinical-testing');
  });

  it('does not let weak billing/invoice vocabulary claim commerce when fleet signals are present', () => {
    expect(orch.inferDomainFromProjectText(
      'Angular screens manage orders, billing, invoice generation, driver activity, partner records, maintenance, and route access.',
      '/tmp/clients/outcode/truckspy/truckspyui'
    )).not.toBe('commerce-operations-portal');
  });

  it('classifies fleet management from product vocabulary without repo-name hints', () => {
    expect(orch.inferDomainFromProjectText(
      'A fleet management platform for commercial vehicle operations with telematics, driver activity, dispatching, fuel and maintenance reporting, and billing for partner services.',
      '/tmp/clients/some-fleet-product'
    )).toBe('fleet-management');
  });

  it('uses repo and path product signals to classify crypto trading bots', () => {
    expect(orch.inferDomainFromProjectText(
      'A trading bot that watches DEX quotes and submits bundled transactions.',
      '/tmp/reference-bots/Solana-Pumpfun-Sniper-Bot'
    )).toBe('solana-arbitrage');

    expect(orch.inferDomainFromProjectText(
      'Volume automation bot for token launches.',
      '/tmp/reference-bots/Pumpfun-Volume-Bot'
    )).toBe('solana-arbitrage');
  });

  it('rejects AI descriptions that add unsupported crypto-mining claims', () => {
    expect(orch.isUsefulAIInterpretation(
      'The Solana bot is a decentralized application designed for miners to mine tokens on the Solana blockchain.',
      { primary_domain: 'solana-arbitrage', core_concepts: ['solana', 'pumpfun', 'dex', 'trading'] }
    )).toBe(false);
  });

  it('treats helper verbs and generic UI actions as weak capability/domain terms', () => {
    for (const token of ['search', 'render', 'close', 'focus', 'normalize', 'ensure', 'path', 'clamp', 'install', 'modal', 'dialog', 'screen']) {
      expect(orch.isGenericDomainToken(token)).toBe(true);
      expect(orch.isGenericCapabilityToken(token)).toBe(true);
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

  it('rejects AI descriptions that make false framework or runtime-service claims', () => {
    const purpose = { primary_domain: 'hoggan', core_concepts: ['hoggan'] };

    expect(orch.isUsefulAIInterpretation(
      'This Hoggan system leverages WPF for cross-platform UI compatibility and external services including File.Exists.',
      purpose
    )).toBe(false);
  });

  it('rejects AI system descriptions that read like product marketing instead of grounded analysis', () => {
    expect(orch.isUsefulAIInterpretation(
      'The mcp-server is an advanced hub that streamlines code understanding and improves productivity through efficient, scalable analysis.',
      { primary_domain: 'code-analysis', core_concepts: ['code', 'analysis', 'cas'] }
    )).toBe(false);
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

  it('allows marketing-flagged words that are grounded in the system domain or core concepts', () => {
    expect(orch.isUsefulAIInterpretation(
      'The fleet system records driver logs and compliance events for vehicle inspections across the fleet, keeping inspection history tied to each driver and vehicle.',
      { primary_domain: 'fleet-compliance', core_concepts: ['fleet', 'vehicle', 'compliance', 'driver'] }
    )).toBe(true);
  });

  it('repairs rejected AI system descriptions before keeping deterministic text', async () => {
    const previousLocal = process.env.AI_LOCAL_ENABLED;
    const previousForce = process.env.KLAURO_AI_INTERPRETATION_FORCE;
    process.env.AI_LOCAL_ENABLED = 'true';
    process.env.KLAURO_AI_INTERPRETATION_FORCE = '1';

    const spy = jest.spyOn(aiService, 'generateComponentDescription')
      .mockResolvedValueOnce(JSON.stringify({
        system_description: 'The mcp-server is an advanced hub that streamlines productivity through efficient, scalable analysis.',
        domain: '',
        descriptions: [],
      }))
      .mockResolvedValueOnce(JSON.stringify({
        system_description: 'The mcp-server analyzes source repositories into CAS relationship graphs and exposes MCP work packets so coding agents can navigate entry points, tests, and risks before editing.',
        domain: '',
        descriptions: [],
      }));

    const purpose: any = {
      primary_type: 'developer-tool',
      confidence: 0.9,
      evidence: [],
      primary_domain: 'code-analysis',
      core_concepts: ['code', 'analysis', 'cas', 'mcp'],
      inferred_description: 'A code analysis service for MCP agent context.',
      supporting_workflow_ids: [],
    };

    let callsBeforeRestore = 0;
    try {
      await orch.applyAIInterpretation(
        purpose,
        'mcp-server',
        ['TypeScript'],
        [{ type: 'cli', count: 1 }],
        ['Analysis'],
        [],
        {
          capabilities: [{ id: 'cap-analysis', name: 'Code Analysis', signals: { total_score: 10 } }],
          dependencies: [],
          topology: { root_capabilities: [], leaf_capabilities: [], critical_path: [], max_depth: 0 },
          primary_flow: { core_capability_id: 'cap-analysis', value_chain: [], supporting_capabilities: [], infrastructure_capabilities: [] },
          layers: [],
          system_insights: { detected_patterns: [], primary_entry_type: 'cli', data_flow_type: 'graph' },
        },
        [{ id: 'concept-code-analysis', name: 'code-analysis', classification: 'core', frequency: 4 }]
      );
      callsBeforeRestore = spy.mock.calls.length;
    } finally {
      spy.mockRestore();
      if (previousLocal === undefined) {
        delete process.env.AI_LOCAL_ENABLED;
      } else {
        process.env.AI_LOCAL_ENABLED = previousLocal;
      }
      if (previousForce === undefined) {
        delete process.env.KLAURO_AI_INTERPRETATION_FORCE;
      } else {
        process.env.KLAURO_AI_INTERPRETATION_FORCE = previousForce;
      }
    }

    expect(callsBeforeRestore).toBe(2);
    expect(purpose.description_source).toBe('ai');
    expect(purpose.inferred_description).toBe('The mcp-server analyzes source repositories into CAS relationship graphs and exposes MCP work packets so coding agents can navigate entry points, tests, and risks before editing.');
    expect(purpose.primary_domain).toBe('code-analysis');
    expect(purpose.domain_source).toBeUndefined();
  });

  it('sanitizes unsupported hallucinated AI overview sentences before accepting the grounded remainder', async () => {
    const previousLocal = process.env.AI_LOCAL_ENABLED;
    const previousForce = process.env.KLAURO_AI_INTERPRETATION_FORCE;
    process.env.AI_LOCAL_ENABLED = 'true';
    process.env.KLAURO_AI_INTERPRETATION_FORCE = '1';

    const spy = jest.spyOn(aiService, 'generateComponentDescription')
      .mockResolvedValueOnce(JSON.stringify({
        system_description: 'The mcp-server analyzes source repositories into CAS relationship graphs and exposes MCP work packets so coding agents can navigate entry points, tests, and risks before editing. It is built with NestJS and manages user data through a relational database.',
        domain: 'code-analysis-agent',
        descriptions: [],
      }));

    const purpose: any = {
      primary_type: 'developer-tool',
      confidence: 0.9,
      evidence: [],
      primary_domain: 'code-analysis',
      core_concepts: ['code', 'analysis', 'cas', 'mcp'],
      inferred_description: 'A code analysis service for MCP agent context.',
      supporting_workflow_ids: [],
    };

    let callsBeforeRestore = 0;
    try {
      await orch.applyAIInterpretation(
        purpose,
        'mcp-server',
        [],
        [{ type: 'cli', count: 1 }],
        [],
        [],
        {
          capabilities: [{ id: 'cap-analysis', name: 'Code Analysis', signals: { total_score: 10 } }],
          dependencies: [],
          topology: { root_capabilities: [], leaf_capabilities: [], critical_path: [], max_depth: 0 },
          primary_flow: { core_capability_id: 'cap-analysis', value_chain: [], supporting_capabilities: [], infrastructure_capabilities: [] },
          layers: [],
          system_insights: { detected_patterns: [], primary_entry_type: 'cli', data_flow_type: 'graph' },
        },
        [{ id: 'concept-code-analysis', name: 'code-analysis', classification: 'core', frequency: 4 }],
        [{ name: 'Agent Work Packets', related_domains: ['agent'], related_entities: [], operations: [] }]
      );
      callsBeforeRestore = spy.mock.calls.length;
    } finally {
      spy.mockRestore();
      if (previousLocal === undefined) {
        delete process.env.AI_LOCAL_ENABLED;
      } else {
        process.env.AI_LOCAL_ENABLED = previousLocal;
      }
      if (previousForce === undefined) {
        delete process.env.KLAURO_AI_INTERPRETATION_FORCE;
      } else {
        process.env.KLAURO_AI_INTERPRETATION_FORCE = previousForce;
      }
    }

    expect(callsBeforeRestore).toBe(2);
    expect(purpose.description_source).toBe('ai');
    expect(purpose.inferred_description).toBe('The mcp-server analyzes source repositories into CAS relationship graphs and exposes MCP work packets so coding agents can navigate entry points, tests, and risks before editing.');
    expect(purpose.primary_domain).toBe('code-analysis-agent');
    expect(purpose.domain_source).toBe('ai');
  });

  it('passes unanalyzed languages and a coverage instruction to the combined AI prompt', async () => {
    const previousLocal = process.env.AI_LOCAL_ENABLED;
    const previousForce = process.env.KLAURO_AI_INTERPRETATION_FORCE;
    process.env.AI_LOCAL_ENABLED = 'true';
    process.env.KLAURO_AI_INTERPRETATION_FORCE = '1';

    const spy = jest.spyOn(aiService, 'generateComponentDescription')
      .mockResolvedValue(JSON.stringify({
        system_description: 'This analysis covers only the analyzed TypeScript portion of washup; Ruby is the dominant unanalyzed language. The analyzed portion exposes a CLI that prepares asset analysis context for coding agents.',
        domain: 'asset-analysis',
        descriptions: [],
      }));

    const purpose: any = {
      primary_type: 'developer-tool',
      confidence: 0.9,
      evidence: [],
      primary_domain: 'asset-analysis',
      core_concepts: ['asset', 'analysis'],
      inferred_description: 'An asset analysis CLI.',
      supporting_workflow_ids: [],
    };

    try {
      await orch.applyAIInterpretation(
        purpose,
        'washup',
        ['TypeScript'],
        [{ type: 'cli', count: 1 }],
        [],
        [],
        {
          capabilities: [{ id: 'cap-assets', name: 'Asset Analysis', signals: { total_score: 10 } }],
          dependencies: [],
          topology: { root_capabilities: [], leaf_capabilities: [], critical_path: [], max_depth: 0 },
          primary_flow: { core_capability_id: 'cap-assets', value_chain: [], supporting_capabilities: [], infrastructure_capabilities: [] },
          layers: [],
          system_insights: { detected_patterns: [], primary_entry_type: 'cli', data_flow_type: 'graph' },
        },
        [{ id: 'concept-asset-analysis', name: 'asset-analysis', classification: 'core', frequency: 4 }],
        [],
        [{ name: 'Ruby', files: 289, share_of_source: 79 }]
      );

      const context = spy.mock.calls[0][0].additionalContext as any;
      expect(context.unanalyzedLanguages).toEqual([{ name: 'Ruby', files: 289, share_of_source: 79 }]);
      expect(context.languageCoverageInstruction).toContain('covers only the analyzed languages');
      expect(context.languageCoverageInstruction).toContain('Ruby (79% of source files) was not analyzed');
      expect(context.languageCoverageInstruction).toContain('name Ruby as the dominant unanalyzed language');
    } finally {
      spy.mockRestore();
      if (previousLocal === undefined) {
        delete process.env.AI_LOCAL_ENABLED;
      } else {
        process.env.AI_LOCAL_ENABLED = previousLocal;
      }
      if (previousForce === undefined) {
        delete process.env.KLAURO_AI_INTERPRETATION_FORCE;
      } else {
        process.env.KLAURO_AI_INTERPRETATION_FORCE = previousForce;
      }
    }
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
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
