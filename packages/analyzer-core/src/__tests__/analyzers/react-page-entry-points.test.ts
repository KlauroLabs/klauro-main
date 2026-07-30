jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import { ReactAnalyzer } from '../../analyzer/frameworks/web/react-analyzer';
import { CASEntryPoint } from '../../types/cas.types';

describe('React page entry point emission', () => {
  const analyzer = () => new ReactAnalyzer() as any;

  const page = (name: string, filePath: string, component = name) => ({
    name,
    filePath,
    route: analyzer().inferRoute(filePath),
    component,
  });

  describe('inferRoute', () => {
    it('strips source extensions from pages-directory routes', () => {
      expect(analyzer().inferRoute('src/pages/ProfitMachine.tsx')).toBe('/profit-machine');
      expect(analyzer().inferRoute('src/pages/activity/decision-list.tsx')).toBe('/activity/decision-list');
    });

    it('maps index files to the parent path', () => {
      expect(analyzer().inferRoute('src/pages/index.tsx')).toBe('/');
      expect(analyzer().inferRoute('src/pages/activity/index.tsx')).toBe('/activity');
    });

    it('converts file-router dynamic segments to route parameters', () => {
      expect(analyzer().inferRoute('src/pages/orders/[id].tsx')).toBe('/orders/:id');
      expect(analyzer().inferRoute('src/pages/docs/[...slug].tsx')).toBe('/docs/*');
    });

    it('kebab-cases the fallback route outside a pages directory', () => {
      expect(analyzer().inferRoute('src/views/CheckoutPage.tsx')).toBe('/checkout');
    });
  });

  describe('createPageEntryPoints', () => {
    it('emits real GET routes for file-router projects', () => {
      const entryPoints: CASEntryPoint[] = [];
      analyzer().createPageEntryPoints(
        [page('ProfitMachine', 'src/pages/ProfitMachine.tsx')],
        [],
        entryPoints,
        true
      );

      expect(entryPoints).toHaveLength(1);
      expect(entryPoints[0].trigger).toEqual({ path: '/profit-machine', method: 'GET' });
      expect(entryPoints[0].trigger?.path).not.toContain('.tsx');
    });

    it('claims NO url for a non-file-router page — the derived route is a filename guess', () => {
      // Outside a file-router project nothing maps this file to a URL, so the
      // component's existence is reported and the address is not. Emitting the
      // filename-derived '/profit-machine' asserted a URL declared nowhere.
      const entryPoints: CASEntryPoint[] = [];
      analyzer().createPageEntryPoints(
        [page('ProfitMachine', 'src/pages/ProfitMachine.tsx')],
        [],
        entryPoints,
        false
      );

      expect(entryPoints).toHaveLength(1);
      expect(entryPoints[0].trigger).toBeUndefined();
      expect(entryPoints[0].metadata?.trigger_kind).toBe('page-component');
      expect(entryPoints[0].metadata?.has_declared_route).toBe(false);
      // The real fact survives: which component, and where it lives.
      expect(entryPoints[0].metadata?.component).toBe('ProfitMachine');
      expect(entryPoints[0].handler?.file).toBe('src/pages/ProfitMachine.tsx');
    });

    it('skips pages already reachable through an extracted router route', () => {
      const entryPoints: CASEntryPoint[] = [];
      analyzer().createPageEntryPoints(
        [
          page('ProfitMachine', 'src/pages/ProfitMachine.tsx'),
          page('Orphan', 'src/pages/Orphan.tsx'),
        ],
        [{ path: '/', component: 'ProfitMachine' }],
        entryPoints,
        false
      );

      expect(entryPoints).toHaveLength(1);
      expect(entryPoints[0].metadata?.component).toBe('Orphan');
    });

    it('matches routed components through nested route children', () => {
      const entryPoints: CASEntryPoint[] = [];
      analyzer().createPageEntryPoints(
        [page('Dashboard', 'src/pages/dashboard.tsx')],
        [{ path: '/', component: 'Layout', children: [{ path: '/dashboard', component: 'Dashboard' }] }],
        entryPoints,
        false
      );

      expect(entryPoints).toHaveLength(0);
    });

    it('never emits a source file path as a trigger path', () => {
      const entryPoints: CASEntryPoint[] = [];
      analyzer().createPageEntryPoints(
        [
          page('decision-list', 'src/views/app/pages/activity/decision-list.tsx', 'DecisionList'),
          page('buy', 'src/views/app/pages/assets/components/buy.tsx', 'Buy'),
        ],
        [],
        entryPoints,
        false
      );

      for (const entry of entryPoints) {
        const trigger = `${entry.trigger?.path || ''}${entry.trigger?.pattern || ''}`;
        expect(trigger).not.toMatch(/\.(tsx|jsx|ts|js)$/);
      }
      // A `pages/` SEGMENT in a project that is not a file router is just a
      // folder name; the URL it suggests is still a guess, so no address is
      // claimed at all — which satisfies the file-path rule above outright.
      expect(entryPoints.map(e => e.trigger)).toEqual([undefined, undefined]);
    });
  });

  describe('routed-page detection by resolved module', () => {
    it('treats a page as routed when the router RENAMES it on import', () => {
      // The router binds a local alias to a module: `CodebaseEntities` is
      // `EntitiesPage`. Name-only matching missed every renamed page, and each
      // one then shipped a second time as an invented URL.
      const entryPoints: CASEntryPoint[] = [];
      analyzer().createPageEntryPoints(
        [page('Entities', 'src/app/Entities/EntitiesPage.tsx', 'EntitiesPage')],
        [{ path: 'entities', component: 'CodebaseEntities', componentModule: '@/app/Entities/EntitiesPage' }],
        entryPoints,
        false
      );

      expect(entryPoints).toHaveLength(0);
    });

    it('treats a page as routed through an INDEX route, which declares no path', () => {
      // `{ index: true, element: <DashboardPage /> }` renders at the parent's
      // path. Every route pattern required a path, so an index route's
      // component looked unrouted and was reported as unreachable.
      const entryPoints: CASEntryPoint[] = [];
      analyzer().createPageEntryPoints(
        [page('Dashboard', 'src/app/Dashboard/DashboardPage.tsx', 'DashboardPage')],
        [{ path: '', component: 'DashboardPage', index: true }],
        entryPoints,
        false
      );

      expect(entryPoints).toHaveLength(0);
    });

    it('still reports a page that no route resolves to', () => {
      const entryPoints: CASEntryPoint[] = [];
      analyzer().createPageEntryPoints(
        [page('Orphan', 'src/app/Orphan/OrphanPage.tsx', 'OrphanPage')],
        [{ path: 'entities', component: 'CodebaseEntities', componentModule: '@/app/Entities/EntitiesPage' }],
        entryPoints,
        false
      );

      expect(entryPoints).toHaveLength(1);
      expect(entryPoints[0].metadata?.component).toBe('OrphanPage');
      expect(entryPoints[0].trigger).toBeUndefined();
    });

    it('does not treat a near-miss module suffix as the same module', () => {
      // `.../Users` must never match `.../SuperUsers`.
      expect(analyzer().moduleTargetsAgree('@/app/Users', 'src/app/SuperUsers.tsx')).toBe(false);
      expect(analyzer().moduleTargetsAgree('@/app/Users', 'src/app/Users.tsx')).toBe(true);
      expect(analyzer().moduleTargetsAgree('@/app/Entities/EntitiesPage', 'src/app/Entities/EntitiesPage.tsx')).toBe(true);
    });
  });

  describe('buildComponentModuleMap', () => {
    it('resolves aliases from imports and from lazily-loaded consts', () => {
      const map = analyzer().buildComponentModuleMap([
        "import { AuthPage } from '@/app/Auth/AuthPage';",
        "import Shell from '@/shared/Shell';",
        "import { EntitiesPage as Renamed } from '@/app/Entities/EntitiesPage';",
        "const Flows = lazy(() => import('@/app/Flows/FlowsListPage'));",
        "const Fns = lazyPage('Functions', () => import('@/app/Functions/FunctionsPage'), 'FunctionsPage');",
      ].join('\n'));

      expect(map.get('AuthPage')).toBe('@/app/Auth/AuthPage');
      expect(map.get('Shell')).toBe('@/shared/Shell');
      // Bound under the LOCAL name, which is what a route element references.
      expect(map.get('Renamed')).toBe('@/app/Entities/EntitiesPage');
      expect(map.get('Flows')).toBe('@/app/Flows/FlowsListPage');
      // The wrapper-function form must resolve too, not just bare lazy().
      expect(map.get('Fns')).toBe('@/app/Functions/FunctionsPage');
    });
  });
});
