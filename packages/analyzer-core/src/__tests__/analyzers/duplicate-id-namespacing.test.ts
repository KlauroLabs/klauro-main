jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JestAnalyzer } from '../../analyzer/frameworks/testing/jest-analyzer';
import { FastAPIAnalyzer } from '../../analyzer/frameworks/web/fastapi-analyzer';
import { ReactAnalyzer } from '../../analyzer/frameworks/web/react-analyzer';
import { ReactRouterAnalyzer } from '../../analyzer/libraries/routing/react-router-analyzer';
import type { CASEdge, CASEntryPoint, CASNode } from '../../types/cas.types';

describe('duplicate id namespacing across files', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-id-namespacing-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const write = (relative: string, content: string) => {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  describe('jest analyzer', () => {
    const suiteFile = (suiteName: string) => [
      "import { AppService } from './app.service';",
      `describe('${suiteName}', () => {`,
      "  it('works', () => {",
      '    expect(true).toBe(true);',
      '  });',
      "  it('also works', () => {",
      '    expect(1).toBe(1);',
      '  });',
      '});',
    ].join('\n');

    it('produces distinct suite/test entry ids for same-named suites in two files', async () => {
      write('apps/user-api/src/app/app.service.spec.ts', suiteFile('AppService'));
      write('apps/admin-api/src/app/app.service.spec.ts', suiteFile('AppService'));

      const analyzer = new JestAnalyzer() as any;
      const nodes: CASNode[] = [];
      const edges: CASEdge[] = [];
      const entryPoints: CASEntryPoint[] = [];
      await analyzer.analyzeTestSuites(
        ['apps/user-api/src/app/app.service.spec.ts', 'apps/admin-api/src/app/app.service.spec.ts'],
        root,
        nodes,
        edges,
        entryPoints
      );

      const ids = entryPoints.map(entry => entry.id);
      expect(new Set(ids).size).toBe(ids.length);

      const suiteEntries = ids.filter(id => id.startsWith('entry_test_suite_'));
      expect(suiteEntries.sort()).toEqual([
        'entry_test_suite_apps_admin_api_src_app_app_service_spec_ts_AppService',
        'entry_test_suite_apps_user_api_src_app_app_service_spec_ts_AppService',
      ]);

      // Per-test entries are namespaced through the suite id.
      const testEntries = ids.filter(id => id.startsWith('entry_test_test_suite_'));
      expect(testEntries.length).toBe(4);
      expect(new Set(testEntries).size).toBe(4);

      // Suite nodes are distinct too, and entry source_node points at them.
      const suiteNodes = nodes.filter(node => node.id.startsWith('test_suite_'));
      expect(new Set(suiteNodes.map(node => node.id)).size).toBe(2);
      for (const entry of entryPoints.filter(e => e.id.startsWith('entry_test_suite_'))) {
        expect(suiteNodes.some(node => node.id === entry.source_node)).toBe(true);
      }
    });

    it('is deterministic across repeated analyses', async () => {
      write('a/sample.spec.ts', suiteFile('Sample'));
      write('b/sample.spec.ts', suiteFile('Sample'));
      const files = ['a/sample.spec.ts', 'b/sample.spec.ts'];

      const run = async () => {
        const analyzer = new JestAnalyzer() as any;
        const entryPoints: CASEntryPoint[] = [];
        await analyzer.analyzeTestSuites(files, root, [], [], entryPoints);
        return entryPoints.map(entry => entry.id);
      };

      expect(await run()).toEqual(await run());
    });

    it('does not ignore source test files whose filename starts with environment or env-', async () => {
      write('src/environment-checks.test.ts', [
        "import { test } from 'node:test';",
        "import assert from 'node:assert/strict';",
        '',
        "test('checks the runtime environment', () => {",
        '  assert.equal(1, 1);',
        '});',
      ].join('\n'));
      write('src/config/env-preserve.test.ts', [
        // Jest-flavored globals import — a vitest import here would (correctly)
        // make JestAnalyzer skip the file as vitest-owned, which is not what
        // this test guards (env-* filename glob behavior).
        "import { describe, it, expect } from '@jest/globals';",
        '',
        "describe('env preserve', () => {",
        "  it('keeps env refs', () => {",
        '    expect(true).toBe(true);',
        '  });',
        '});',
      ].join('\n'));

      const analyzer = new JestAnalyzer() as any;
      const result = await analyzer.analyze({ projectPath: root });
      const environmentSuite = result.nodes.find((node: CASNode) =>
        node.type === 'test' &&
        node.subcategories?.includes('suite') &&
        node.source?.file?.endsWith('src/environment-checks.test.ts')
      );
      const envHyphenSuite = result.nodes.find((node: CASNode) =>
        node.type === 'test' &&
        node.subcategories?.includes('suite') &&
        node.source?.file?.endsWith('src/config/env-preserve.test.ts')
      );

      expect(environmentSuite).toBeDefined();
      expect(envHyphenSuite).toBeDefined();
    });
  });

  describe('fastapi analyzer', () => {
    const apiFile = (resource: string) => [
      'from fastapi import APIRouter',
      '',
      `router = APIRouter(prefix="/${resource}")`,
      '',
      '@router.get("/")',
      `async def list_${resource}():`,
      '    return []',
      '',
      '@router.post("/")',
      `async def create_${resource}():`,
      '    return {}',
    ].join('\n');

    it('produces distinct route entry ids for routers named "router" in two files', async () => {
      write('app/api/tracks.py', apiFile('tracks'));
      write('app/api/referrals.py', apiFile('referrals'));

      const analyzer = new FastAPIAnalyzer() as any;
      const nodes: CASNode[] = [];
      const edges: CASEdge[] = [];
      const entryPoints: CASEntryPoint[] = [];
      await analyzer.analyzeRouters(
        ['app/api/tracks.py', 'app/api/referrals.py'],
        root,
        nodes,
        edges,
        entryPoints
      );

      const ids = entryPoints.map(entry => entry.id);
      // All four routes survive: 2 files x 2 routes, no shared ids.
      expect(ids.length).toBe(4);
      expect(new Set(ids).size).toBe(4);
      expect(ids.sort()).toEqual([
        'entry_route_router_app_api_referrals_py_router_0',
        'entry_route_router_app_api_referrals_py_router_1',
        'entry_route_router_app_api_tracks_py_router_0',
        'entry_route_router_app_api_tracks_py_router_1',
      ]);

      // Router and route nodes are file-namespaced and unique.
      const routerNodes = nodes.filter(node => node.id.startsWith('router_'));
      expect(new Set(routerNodes.map(node => node.id)).size).toBe(2);
      const routeNodes = nodes.filter(node => node.id.startsWith('route_router_'));
      expect(new Set(routeNodes.map(node => node.id)).size).toBe(4);
    });

    it('marks FastAPI routes protected by Depends(get_current_user) as authenticated', async () => {
      write('app/api/auth.py', [
        'from fastapi import APIRouter, Depends',
        '',
        'router = APIRouter(prefix="/children")',
        '',
        'def get_current_user():',
        '    return {}',
        '',
        '@router.post("/")',
        'async def create_child(',
        '    payload: dict,',
        '    user: dict = Depends(get_current_user),',
        '):',
        '    return payload',
      ].join('\n'));

      const analyzer = new FastAPIAnalyzer() as any;
      const nodes: CASNode[] = [];
      const edges: CASEdge[] = [];
      const entryPoints: CASEntryPoint[] = [];
      await analyzer.analyzeRouters(
        ['app/api/auth.py'],
        root,
        nodes,
        edges,
        entryPoints
      );

      const createChild = entryPoints.find(entry => entry.name === 'POST /children/');
      expect(createChild?.security?.authenticated).toBe(true);
      expect(createChild?.security?.guards).toContain('get_current_user');
    });
  });

  describe('react-router analyzer', () => {
    const routesFile = (component: string) => [
      "import { Route } from 'react-router-dom';",
      `export const AppRoutes = () => <Route path="/" element={<${component} />} />;`,
    ].join('\n');

    it('produces distinct entry ids for the same route path defined in two files', () => {
      const analyzer = new ReactRouterAnalyzer() as any;
      const nodes: CASNode[] = [];
      const edges: CASEdge[] = [];
      const entryPoints: CASEntryPoint[] = [];
      const seenRoutes = new Set<string>();

      for (const relativePath of ['apps/user/src/routes.tsx', 'apps/admin/src/routes.tsx']) {
        const sanitizedPath = relativePath.replace(/[^a-zA-Z0-9]/g, '_');
        analyzer.extractRouteDefinitions(
          routesFile(relativePath.includes('admin') ? 'AdminHome' : 'UserHome'),
          relativePath,
          sanitizedPath,
          undefined,
          { existingAnalysis: [] },
          nodes,
          edges,
          entryPoints,
          seenRoutes
        );
      }

      const ids = entryPoints.map(entry => entry.id);
      expect(ids.length).toBe(2);
      expect(new Set(ids).size).toBe(2);
      expect(ids.sort()).toEqual([
        'entry_route_apps_admin_src_routes_tsx__',
        'entry_route_apps_user_src_routes_tsx__',
      ]);

      const routeNodes = nodes.filter(node => node.id.startsWith('route_react_'));
      expect(new Set(routeNodes.map(node => node.id)).size).toBe(2);
    });

    it('disambiguates distinct paths that sanitize identically within one file ("/" vs "*")', () => {
      const analyzer = new ReactRouterAnalyzer() as any;
      const nodes: CASNode[] = [];
      const edges: CASEdge[] = [];
      const entryPoints: CASEntryPoint[] = [];

      const content = [
        "import { Route } from 'react-router-dom';",
        'export const App = () => (',
        '  <>',
        '    <Route path="/" element={<Dashboard />} />',
        '    <Route path="*" element={<NotFound />} />',
        '  </>',
        ');',
      ].join('\n');

      analyzer.extractRouteDefinitions(
        content,
        'src/App.tsx',
        'src_App_tsx',
        undefined,
        { existingAnalysis: [] },
        nodes,
        edges,
        entryPoints,
        new Set<string>()
      );

      const ids = entryPoints.map(entry => entry.id);
      expect(ids.length).toBe(2);
      expect(new Set(ids).size).toBe(2);
      expect(ids.sort()).toEqual([
        'entry_route_src_App_tsx__',
        'entry_route_src_App_tsx___2',
      ]);
      expect(new Set(nodes.filter(n => n.id.startsWith('route_react_')).map(n => n.id)).size).toBe(2);
    });
  });

  describe('react analyzer renders edges', () => {
    const makeComponent = (
      name: string,
      filePath: string,
      renderedComponents: Array<{ name: string; line: number; props: string[] }>
    ) => ({
      name,
      filePath,
      type: 'functional',
      isDefaultExport: false,
      props: [],
      state: [],
      hooks: [],
      lifecycle: [],
      children: [],
      imports: [],
      exports: [],
      jsx: true,
      renderedComponents,
    });

    const buildEdges = (components: any[]) => {
      const analyzer = new ReactAnalyzer() as any;
      const nodes: CASNode[] = [];
      const edges: CASEdge[] = [];
      analyzer.buildReactRelationships(components, [], [], [], [], [], [], nodes, edges);
      return edges.filter(edge => edge.type === 'renders');
    };

    it('keeps distinct edge ids when the same parent renders the same child at multiple JSX sites', () => {
      const components = [
        makeComponent('Card', 'src/Card.tsx', []),
        makeComponent('Dashboard', 'src/Dashboard.tsx', [
          { name: 'Card', line: 5, props: ['title'] },
          { name: 'Card', line: 12, props: ['footer'] },
        ]),
      ];

      const rendersEdges = buildEdges(components);
      expect(rendersEdges.length).toBe(2);
      expect(new Set(rendersEdges.map(edge => edge.id)).size).toBe(2);
      // Both edges connect the same pair but carry their own jsx_line.
      expect(rendersEdges.map(edge => (edge.metadata as any)?.jsx_line).sort((a, b) => a - b)).toEqual([5, 12]);
      for (const edge of rendersEdges) {
        expect(edge.id).toMatch(/^edge_renders_[0-9a-f]{8}$/);
      }
    });

    it('does not collide renders edges across parents in different files', () => {
      const components = [
        makeComponent('Card', 'src/Card.tsx', []),
        makeComponent('Home', 'src/pages/Home.tsx', [{ name: 'Card', line: 3, props: [] }]),
        makeComponent('About', 'src/pages/About.tsx', [{ name: 'Card', line: 3, props: [] }]),
      ];

      const rendersEdges = buildEdges(components);
      expect(rendersEdges.length).toBe(2);
      expect(new Set(rendersEdges.map(edge => edge.id)).size).toBe(2);
    });

    it('is deterministic across repeated builds', () => {
      const components = [
        makeComponent('Card', 'src/Card.tsx', []),
        makeComponent('Dashboard', 'src/Dashboard.tsx', [
          { name: 'Card', line: 5, props: [] },
          { name: 'Card', line: 12, props: [] },
        ]),
      ];

      const first = buildEdges(components).map(edge => edge.id);
      const second = buildEdges(components).map(edge => edge.id);
      expect(second).toEqual(first);
    });
  });
});
