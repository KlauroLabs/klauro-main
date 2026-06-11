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

    it('marks non-file-router pages as component references without an HTTP-looking GET path', () => {
      const entryPoints: CASEntryPoint[] = [];
      analyzer().createPageEntryPoints(
        [page('ProfitMachine', 'src/pages/ProfitMachine.tsx')],
        [],
        entryPoints,
        false
      );

      expect(entryPoints).toHaveLength(1);
      expect(entryPoints[0].trigger?.method).toBeUndefined();
      expect(entryPoints[0].trigger?.path).toBeUndefined();
      expect(entryPoints[0].trigger?.pattern).toBe('/profit-machine');
      expect(entryPoints[0].metadata?.trigger_kind).toBe('page-component');
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
      expect(entryPoints.map(e => e.trigger?.pattern)).toEqual([
        '/activity/decision-list',
        '/assets/components/buy',
      ]);
    });
  });
});
