jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import { ReactAnalyzer } from '../../analyzer/frameworks/web/react-analyzer';
import { CASEdge, CASNode } from '../../types/cas.types';

/**
 * Coverage for the registration/hook -> real-handler edge-linking gap on the
 * React side: a `useQuery`/`useMutation` hook_usage node previously had zero
 * outgoing edges to the fetcher function it actually invokes. These tests
 * exercise the analyzer's private extraction + resolution helpers directly
 * (the established pattern in this test suite — `analyzer() as any` — since
 * the resolution logic lives in private methods not on the public CAS
 * contract).
 */
describe('ReactAnalyzer: data-fetching hook -> fetcher call edges', () => {
  const analyzer = () => new ReactAnalyzer() as any;

  describe('extractComponentHooks: candidate extraction', () => {
    it('captures the queryFn callee for an inline-arrow useQuery call', () => {
      const content = [
        'function OrganizationsList() {',
        '  const { data } = useQuery({',
        "    queryKey: ['organizations'],",
        '    queryFn: () => apiGet(`/organizations`),',
        '  });',
        '  return null;',
        '}',
      ].join('\n');

      const hooks = analyzer().extractComponentHooks(null, content);
      const useQueryHook = hooks.find((h: any) => h.name === 'useQuery');
      expect(useQueryHook).toBeTruthy();
      expect(useQueryHook.dependencies).toEqual(expect.arrayContaining(['apiGet']));
    });

    it('captures the mutationFn callee for useMutation', () => {
      const content = [
        'function DeleteButton() {',
        '  const mutation = useMutation({',
        '    mutationFn: (id) => apiDelete(`/employees/${id}`),',
        '  });',
        '  return null;',
        '}',
      ].join('\n');

      const hooks = analyzer().extractComponentHooks(null, content);
      const useMutationHook = hooks.find((h: any) => h.name === 'useMutation');
      expect(useMutationHook).toBeTruthy();
      expect(useMutationHook.dependencies).toEqual(expect.arrayContaining(['apiDelete']));
    });

    it('captures the callee through a generic type-argument list, even with nested object/array types', () => {
      // Regression test: `apiGet<{ items: Foo[] }>(...)` — a very common
      // real-world shape for a typed fetch client — was previously missed
      // entirely because a naive `<[^<>(){}]*>` regex class rejects nested
      // braces/brackets inside the generic, causing the scan to silently
      // fall through to a LATER, unrelated call in the same hook options
      // object (e.g. an `enabled: hasRole(...)` guard) instead.
      const content = [
        'function UsersTab({ id, tab }) {',
        '  const { data: users } = useQuery({',
        "    queryKey: ['organization', id, 'users'],",
        '    queryFn: () => apiGet<{ items: UserItem[] }>(`/organizations/${id}/users`),',
        '    enabled: !!id && tab === 3 && hasRole(\'support\'),',
        '  });',
        '  return null;',
        '}',
      ].join('\n');

      const hooks = analyzer().extractComponentHooks(null, content);
      const useQueryHook = hooks.find((h: any) => h.name === 'useQuery');
      expect(useQueryHook).toBeTruthy();
      // apiGet must be captured (previously missing)...
      expect(useQueryHook.dependencies).toEqual(expect.arrayContaining(['apiGet']));
      // ...and must come before the unrelated enabled-guard call so
      // resolution (which takes the first uniquely-resolved candidate)
      // prefers the real fetcher over incidental noise.
      expect(useQueryHook.dependencies.indexOf('apiGet')).toBeLessThan(
        useQueryHook.dependencies.includes('hasRole') ? useQueryHook.dependencies.indexOf('hasRole') : Infinity
      );
    });

    it('records no candidates when the hook body has no call expression', () => {
      const content = [
        'function Counter() {',
        '  const [count, setCount] = useState(0);',
        '  return null;',
        '}',
      ].join('\n');

      const hooks = analyzer().extractComponentHooks(null, content);
      const useState = hooks.find((h: any) => h.name === 'useState');
      expect(useState).toBeTruthy();
      expect(useState.dependencies).toBeUndefined();
    });
  });

  describe('buildReactRelationships: hook_usage -> fetcher edge emission', () => {
    function util(name: string, filePath: string) {
      return { name, filePath, type: 'function' as const, exports: [name], dependencies: [] };
    }

    it('emits a calls edge from the hook_usage node to the uniquely-resolved fetcher util', () => {
      const a = analyzer();
      const hookUsageId = 'hook_usage_1';
      const components = [{
        name: 'OrganizationsList',
        filePath: 'src/app/Organizations/index.tsx',
        type: 'functional',
        isDefaultExport: true,
        props: [],
        state: [],
        hooks: [{ name: 'useQuery', type: 'built-in', dependencies: ['apiGet'], hookUsageId }],
        lifecycle: [],
        children: [],
        imports: [],
        exports: [],
        jsx: true,
        renderedComponents: [],
        eventHandlers: [],
      }];
      const utils = [util('apiGet', 'src/shared/api/fetch.ts')];

      const nodes: CASNode[] = [];
      const edges: CASEdge[] = [];
      a.buildReactRelationships(components, [], [], [], [], [], utils, nodes, edges);

      const utilId = a.generateId('util', 'src/shared/api/fetch.ts', 'apiGet');
      const edge = edges.find((e: CASEdge) => e.source === hookUsageId && e.target === utilId);
      expect(edge).toBeTruthy();
      expect(edge!.type).toBe('calls');
      expect((edge!.metadata as any)?.resolution).toBe('fetcher_call_candidate');
    });

    it('does not fabricate an edge when the fetcher name is ambiguous across two util declarations', () => {
      const a = analyzer();
      const hookUsageId = 'hook_usage_2';
      const components = [{
        name: 'Widget',
        filePath: 'src/app/Widget/index.tsx',
        type: 'functional',
        isDefaultExport: true,
        props: [],
        state: [],
        hooks: [{ name: 'useQuery', type: 'built-in', dependencies: ['fetchData'], hookUsageId }],
        lifecycle: [],
        children: [],
        imports: [],
        exports: [],
        jsx: true,
        renderedComponents: [],
        eventHandlers: [],
      }];
      const utils = [
        util('fetchData', 'src/moduleA/fetch.ts'),
        util('fetchData', 'src/moduleB/fetch.ts'),
      ];

      const nodes: CASNode[] = [];
      const edges: CASEdge[] = [];
      a.buildReactRelationships(components, [], [], [], [], [], utils, nodes, edges);

      const fetcherEdges = edges.filter((e: CASEdge) => e.source === hookUsageId);
      expect(fetcherEdges).toHaveLength(0);
    });

    it('does not add an edge when the hook has no fetcher dependencies (e.g. useState)', () => {
      const a = analyzer();
      const components = [{
        name: 'Counter',
        filePath: 'src/app/Counter/index.tsx',
        type: 'functional',
        isDefaultExport: true,
        props: [],
        state: [],
        hooks: [{ name: 'useState', type: 'built-in', hookUsageId: 'hook_usage_3' }],
        lifecycle: [],
        children: [],
        imports: [],
        exports: [],
        jsx: true,
        renderedComponents: [],
        eventHandlers: [],
      }];

      const nodes: CASNode[] = [];
      const edges: CASEdge[] = [];
      a.buildReactRelationships(components, [], [], [], [], [], [], nodes, edges);

      expect(edges.filter((e: CASEdge) => e.source === 'hook_usage_3')).toHaveLength(0);
    });
  });
});
