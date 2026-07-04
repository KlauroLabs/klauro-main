jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { SymfonyAnalyzer } from '../../analyzer/frameworks/web/symfony-analyzer';

describe('SymfonyAnalyzer', () => {
  let analyzer: SymfonyAnalyzer;
  let projectPath: string;

  beforeEach(async () => {
    analyzer = new SymfonyAnalyzer();
    projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'symfony-analyzer-test-'));
  });

  afterEach(async () => {
    await fs.remove(projectPath);
  });

  const writeFile = async (relative: string, content: string) => {
    const fullPath = path.join(projectPath, relative);
    await fs.ensureDir(path.dirname(fullPath));
    await fs.writeFile(fullPath, content);
  };

  const analyze = () => analyzer.analyze({ projectPath } as any);

  const httpEntries = (contribution: any) =>
    contribution.entry_points.filter((e: any) => e.type === 'http');

  describe('attribute routes', () => {
    it('composes class-level prefix with method-level paths and methods option', async () => {
      await writeFile('src/Controller/OrderController.php', [
        '<?php',
        'namespace App\\Controller;',
        'use Symfony\\Component\\Routing\\Attribute\\Route;',
        '',
        "#[Route('/orders')]",
        'class OrderController extends AbstractController',
        '{',
        "    #[Route('', name: 'order_list', methods: ['GET'])]",
        '    public function list(): Response',
        '    {',
        '    }',
        '',
        "    #[Route('/{id}', name: 'order_update', methods: ['PUT', 'PATCH'])]",
        '    public function update(int $id): Response',
        '    {',
        '    }',
        '}',
      ].join('\n'));

      const contribution = await analyze();
      const entries = httpEntries(contribution);

      expect(entries).toHaveLength(3);
      expect(entries.map((e: any) => `${e.trigger.method} ${e.trigger.path}`).sort()).toEqual([
        'GET /orders',
        'PATCH /orders/{id}',
        'PUT /orders/{id}',
      ]);
      const update = entries.find((e: any) => e.trigger.method === 'PUT');
      expect(update.handler.method_name).toBe('update');
      expect(update.metadata.controller).toBe('OrderController');
      expect(update.metadata.route_name).toBe('order_update');
    });
  });

  describe('FOSRestBundle attribute routes', () => {
    it('extracts Rest verb shortcuts under a class-level Rest\\Route prefix', async () => {
      await writeFile('src/Controller/Api/Web/DeviceController.php', [
        '<?php',
        'namespace App\\Controller\\Api\\Web;',
        'use FOS\\RestBundle\\Controller\\Annotations as Rest;',
        '',
        "#[Rest\\Route('/devices')]",
        'class DeviceController',
        '{',
        '    #[Rest\\Get("/types"), Rest\\View]',
        '    public function types(): array',
        '    {',
        '    }',
        '',
        '    #[Rest\\Post("")]',
        '    public function create(): Response',
        '    {',
        '    }',
        '',
        '    #[Rest\\Patch("/{id}")]',
        '    public function update(string $id): void',
        '    {',
        '    }',
        '}',
      ].join('\n'));

      const contribution = await analyze();
      const entries = httpEntries(contribution);

      expect(entries.map((e: any) => `${e.trigger.method} ${e.trigger.path}`).sort()).toEqual([
        'GET /devices/types',
        'PATCH /devices/{id}',
        'POST /devices',
      ]);
    });

    it('composes the full path purely from routes.yaml prefix when the controller has no class-level route attribute', async () => {
      // Regression: FOSRestBundle convention controllers often carry no class-level
      // #[Rest\Route(...)] at all — the full mount path comes entirely from the
      // routes.yaml resource/prefix mapping. Confirmed against a real repo
      // (truckspy's CustomerApiTokenController), which has only method-level
      // #[Rest\Get("/{id}/api-token")] attributes and is mounted at /api/customer
      // solely via config/routes.yaml.
      await writeFile('config/routes.yaml', [
        'Customer:',
        '  resource:',
        '    path: ../src/Controller/Api/Customer',
        '    namespace: App\\Controller\\Api\\Customer',
        '  type: attribute',
        '  prefix: /api/customer',
      ].join('\n'));

      await writeFile('src/Controller/Api/Customer/CustomerApiTokenController.php', [
        '<?php',
        'namespace App\\Controller\\Api\\Customer;',
        'use FOS\\RestBundle\\Controller\\Annotations as Rest;',
        '',
        'class CustomerApiTokenController',
        '{',
        '    #[Rest\\Get("/{id}/api-token")]',
        '    public function detail(): array',
        '    {',
        '    }',
        '}',
      ].join('\n'));

      const contribution = await analyze();
      const entries = httpEntries(contribution);

      expect(entries).toHaveLength(1);
      expect(entries[0].trigger.method).toBe('GET');
      expect(entries[0].trigger.path).toBe('/api/customer/{id}/api-token');
      expect(entries[0].handler.method_name).toBe('detail');
    });

    it('applies YAML resource prefixes from routes.yaml to attribute controllers', async () => {
      await writeFile('config/routes.yaml', [
        'Web:',
        '  resource:',
        '    path: ../src/Controller/Api/Web',
        '    namespace: App\\Controller\\Api\\Web',
        '  type: attribute',
        '  prefix: /api/web',
        '',
        'Controller:',
        '  resource:',
        '    path: ../src/Controller',
        '    namespace: App\\Controller',
        '  type: attribute',
        '  prefix: /',
      ].join('\n'));

      await writeFile('src/Controller/Api/Web/ReportController.php', [
        '<?php',
        'namespace App\\Controller\\Api\\Web;',
        'use FOS\\RestBundle\\Controller\\Annotations as Rest;',
        '',
        "#[Rest\\Route('/reports')]",
        'class ReportController',
        '{',
        '    #[Rest\\Get("/{id}")]',
        '    public function show(string $id): Response',
        '    {',
        '    }',
        '}',
      ].join('\n'));

      const contribution = await analyze();
      const entries = httpEntries(contribution);

      expect(entries).toHaveLength(1);
      expect(entries[0].trigger.method).toBe('GET');
      expect(entries[0].trigger.path).toBe('/api/web/reports/{id}');
      expect(entries[0].handler.method_name).toBe('show');
    });
  });

  describe('annotation routes', () => {
    it('extracts @Route annotations with methods option', async () => {
      await writeFile('src/Controller/LegacyController.php', [
        '<?php',
        'namespace App\\Controller;',
        'use Symfony\\Component\\Routing\\Annotation\\Route;',
        '',
        '/**',
        ' * @Route("/legacy")',
        ' */',
        'class LegacyController extends AbstractController',
        '{',
        '    /**',
        '     * @Route("/items", name="legacy_items", methods={"GET", "POST"})',
        '     */',
        '    public function items(): Response',
        '    {',
        '    }',
        '}',
      ].join('\n'));

      const contribution = await analyze();
      const entries = httpEntries(contribution);

      expect(entries.map((e: any) => `${e.trigger.method} ${e.trigger.path}`).sort()).toEqual([
        'GET /legacy/items',
        'POST /legacy/items',
      ]);
      expect(entries[0].metadata.route_name).toBe('legacy_items');
    });
  });

  describe('YAML routes', () => {
    it('emits entry points for path routes and binds controller::action handlers', async () => {
      await writeFile('config/routes.yaml', [
        'app_login:',
        '  path: /login',
        '  controller: App\\Controller\\SecurityController::login',
        '  methods: [POST]',
        '',
        'logout:',
        '  path: /logout',
        '  defaults:',
        '    _format: json',
      ].join('\n'));

      await writeFile('src/Controller/SecurityController.php', [
        '<?php',
        'namespace App\\Controller;',
        '',
        'class SecurityController extends AbstractController',
        '{',
        '    public function login(): Response',
        '    {',
        '    }',
        '}',
      ].join('\n'));

      const contribution = await analyze();
      const entries = httpEntries(contribution);
      const login = entries.find((e: any) => e.trigger.path === '/login');
      const logout = entries.find((e: any) => e.trigger.path === '/logout');

      expect(login).toBeDefined();
      expect(login.trigger.method).toBe('POST');
      expect(login.handler.method_name).toBe('login');
      expect(login.handler.node_id).toContain('SecurityController');
      expect(logout).toBeDefined();
      expect(logout.trigger.method).toBe('GET');
    });

    it('skips resource imports and when@ blocks in routes.yaml', async () => {
      await writeFile('config/routes.yaml', [
        'fos_oauth_server_token:',
        '  resource: "@FOSOAuthServerBundle/Resources/config/routing/token.xml"',
        '',
        'when@dev:',
        '  web_profiler_wdt:',
        "    resource: '@WebProfilerBundle/Resources/config/routing/wdt.xml'",
        '    prefix: /_wdt',
      ].join('\n'));

      const contribution = await analyze();

      expect(httpEntries(contribution)).toHaveLength(0);
    });
  });

  describe('method-level dependency edges', () => {
    it('emits calls edges from controller actions to the services they use', async () => {
      await writeFile('src/Service/InvoiceService.php', [
        '<?php',
        'namespace App\\Service;',
        '',
        'class InvoiceService',
        '{',
        '    public function send(string $id): void',
        '    {',
        '    }',
        '}',
      ].join('\n'));

      await writeFile('src/Controller/InvoiceController.php', [
        '<?php',
        'namespace App\\Controller;',
        'use App\\Service\\InvoiceService;',
        'use FOS\\RestBundle\\Controller\\Annotations as Rest;',
        '',
        "#[Rest\\Route('/invoices')]",
        'class InvoiceController',
        '{',
        '    public function __construct(private readonly InvoiceService $invoiceService)',
        '    {',
        '    }',
        '',
        '    #[Rest\\Post("/{id}/send")]',
        '    public function send(string $id): void',
        '    {',
        '        $this->invoiceService->send($id);',
        '    }',
        '',
        '    #[Rest\\Get("/by-service")]',
        '    public function byService(InvoiceServiceInterface $service): array',
        '    {',
        '        return $service->all();',
        '    }',
        '',
        '    #[Rest\\Get("")]',
        '    public function plain(): array',
        '    {',
        '        return [];',
        '    }',
        '}',
      ].join('\n'));

      const contribution = await analyze();
      const nodes: any[] = contribution.nodes ?? [];
      const edges: any[] = contribution.edges ?? [];
      const serviceNode = nodes.find(n => n.name === 'InvoiceService' && n.id.includes('service'));

      expect(serviceNode).toBeDefined();
      const callEdges = edges.filter(e =>
        e.type === 'calls' && e.target === serviceNode!.id && e.source.includes('InvoiceController')
      );

      expect(callEdges.map(e => e.source).sort()).toEqual([
        expect.stringContaining('InvoiceController_byService'),
        expect.stringContaining('InvoiceController_send'),
      ]);
      const plainEdge = edges.find(e =>
        e.type === 'calls' && e.source.includes('InvoiceController_plain')
      );
      expect(plainEdge).toBeUndefined();
    });
  });

  describe('guard detection', () => {
    it('binds IsGranted attributes and security.yaml access_control to entry points', async () => {
      await writeFile('config/routes.yaml', [
        'Admin:',
        '  resource:',
        '    path: ../src/Controller/Api/Admin',
        '    namespace: App\\Controller\\Api\\Admin',
        '  type: attribute',
        '  prefix: /api/web/admin',
      ].join('\n'));

      await writeFile('config/packages/security.yaml', [
        'security:',
        '  access_control:',
        '    - { path: ^/api/web/public/, roles: [ PUBLIC_ACCESS ] }',
        '    - { path: ^/api/web/admin/, roles: ROLE_ADMIN }',
      ].join('\n'));

      await writeFile('src/Controller/Api/Admin/UserController.php', [
        '<?php',
        'namespace App\\Controller\\Api\\Admin;',
        'use FOS\\RestBundle\\Controller\\Annotations as Rest;',
        'use Symfony\\Component\\Security\\Http\\Attribute\\IsGranted;',
        '',
        "#[Rest\\Route('/users')]",
        '#[IsGranted("ROLE_SUPER_ADMIN")]',
        'class UserController',
        '{',
        '    #[Rest\\Delete("/{id}")]',
        '    #[IsGranted("ROLE_USER_DELETE", message: "Permissions denied")]',
        '    public function remove(string $id): void',
        '    {',
        '    }',
        '',
        '    #[Rest\\Get("")]',
        '    public function list(): array',
        '    {',
        '    }',
        '}',
      ].join('\n'));

      const contribution = await analyze();
      const entries = httpEntries(contribution);

      const remove = entries.find((e: any) => e.trigger.method === 'DELETE');
      expect(remove.trigger.path).toBe('/api/web/admin/users/{id}');
      expect(remove.security.authenticated).toBe(true);
      expect(remove.security.guards).toEqual(['IsGranted']);
      expect(remove.security.authorized_roles.sort()).toEqual([
        'ROLE_ADMIN',
        'ROLE_SUPER_ADMIN',
        'ROLE_USER_DELETE',
      ]);

      const list = entries.find((e: any) => e.trigger.method === 'GET');
      expect(list.security.authenticated).toBe(true);
      expect(list.security.authorized_roles).toContain('ROLE_ADMIN');
      expect(list.security.authorized_roles).toContain('ROLE_SUPER_ADMIN');
    });

    it('marks access_control PUBLIC_ACCESS routes as unauthenticated', async () => {
      await writeFile('config/routes.yaml', [
        'Pub:',
        '  resource:',
        '    path: ../src/Controller/Api/Pub',
        '    namespace: App\\Controller\\Api\\Pub',
        '  type: attribute',
        '  prefix: /api/web/public',
      ].join('\n'));

      await writeFile('config/packages/security.yaml', [
        'security:',
        '  access_control:',
        '    - { path: ^/api/web/public/, roles: [ PUBLIC_ACCESS ] }',
      ].join('\n'));

      await writeFile('src/Controller/Api/Pub/BrandingController.php', [
        '<?php',
        'namespace App\\Controller\\Api\\Pub;',
        'use FOS\\RestBundle\\Controller\\Annotations as Rest;',
        '',
        "#[Rest\\Route('/branding')]",
        'class BrandingController',
        '{',
        '    #[Rest\\Get("")]',
        '    public function show(): array',
        '    {',
        '    }',
        '}',
      ].join('\n'));

      const contribution = await analyze();
      const entries = httpEntries(contribution);

      expect(entries).toHaveLength(1);
      expect(entries[0].trigger.path).toBe('/api/web/public/branding');
      expect(entries[0].security.authenticated).toBe(false);
      expect(entries[0].security.roles).toEqual(['PUBLIC_ACCESS']);
    });
  });
});
