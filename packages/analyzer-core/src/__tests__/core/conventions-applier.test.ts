import { applyConventions } from '../../analyzer/core/conventions-applier';
import type { CASNode, CASEdge, CASDecorator } from '../../types/cas.types';

function fn(overrides: Partial<CASNode> & { id: string; name: string }): CASNode {
  return {
    type: 'function',
    qualified_name: overrides.qualified_name ?? overrides.name,
    source: { file: 'src/handlers.ts', line: 1 },
    ...overrides,
  } as CASNode;
}

function cls(overrides: Partial<CASNode> & { id: string; name: string }): CASNode {
  return {
    type: 'class',
    qualified_name: overrides.qualified_name ?? overrides.name,
    source: { file: 'src/entities.ts', line: 1 },
    ...overrides,
  } as CASNode;
}

describe('applyConventions', () => {
  test('no conventions declared returns empty result', () => {
    const result = applyConventions(undefined, [], []);
    expect(result.entry_points).toEqual([]);
    expect(result.data_entities).toEqual([]);
    expect(result.matches).toEqual([]);
  });

  describe('route decorator convention', () => {
    test('matches a function carrying the declared decorator with resolvable arguments and emits an http entry point', () => {
      const node = fn({
        id: 'fn_1',
        name: 'listOrders',
        metadata: { attributes: { decorators: ['Endpoint'] } } as any,
      });
      const decorators: CASDecorator[] = [
        {
          id: 'dec_fn_1_Endpoint',
          target_node: 'fn_1',
          decorator_info: { name: 'Endpoint', type: 'method', framework: 'generic', source_location: { file: 'src/handlers.ts', line: 1, column: 0 } },
          semantic_meaning: { category: 'other', behavior: 'Applies @Endpoint decorator', affects_runtime: false },
          parameters: [
            { name: '0', value: '/orders', type: 'string' },
            { name: '1', value: 'GET', type: 'string' },
          ],
        },
      ];
      const result = applyConventions(
        { routes: [{ decorator: '@Endpoint', path_arg: 0, method_arg: 1 }] },
        [node],
        [],
        decorators,
      );
      expect(result.entry_points).toHaveLength(1);
      expect(result.entry_points[0].type).toBe('http');
      expect(result.entry_points[0].trigger?.path).toBe('/orders');
      expect(result.entry_points[0].trigger?.method).toBe('GET');
      expect(result.entry_points[0].handler?.node_id).toBe('fn_1');
      expect(result.matches[0].matched).toBe(true);
      expect(result.matches[0].matched_node_ids).toEqual(['fn_1']);
    });

    test('decorator present but with no resolvable arguments emits nothing and reports why (never fabricates)', () => {
      const node = fn({
        id: 'fn_1',
        name: 'listOrders',
        metadata: { attributes: { decorators: ['Endpoint'] } } as any,
      });
      // No CASDecorator evidence supplied — mirrors an unrecognized/custom
      // decorator where the analyzer only captured the bare name.
      const result = applyConventions(
        { routes: [{ decorator: '@Endpoint', path_arg: 0 }] },
        [node],
        [],
        [],
      );
      expect(result.entry_points).toHaveLength(0);
      expect(result.matches[0].matched).toBe(false);
      expect(result.matches[0].reason).toMatch(/no argument capture is available/);
    });

    test('declared decorator with no matching node emits nothing and reports why', () => {
      const nodes: CASNode[] = [fn({ id: 'fn_1', name: 'plainFn' })];
      const result = applyConventions(
        { routes: [{ decorator: '@Endpoint', path_arg: 0 }] },
        nodes,
        [],
      );
      expect(result.entry_points).toHaveLength(0);
      expect(result.matches[0].matched).toBe(false);
      expect(result.matches[0].reason).toMatch(/No function\/method node carries decorator/);
    });
  });

  describe('entity suffix convention', () => {
    test('matches classes ending in the declared suffix and emits data entities', () => {
      const nodes: CASNode[] = [
        cls({ id: 'cls_1', name: 'OrderAggregate' }),
        cls({ id: 'cls_2', name: 'CustomerAggregate' }),
        cls({ id: 'cls_3', name: 'PlainHelper' }),
      ];
      const result = applyConventions(
        { entities: [{ name_suffix: 'Aggregate' }] },
        nodes,
        [],
      );
      expect(result.data_entities.map(e => e.name).sort()).toEqual(['CustomerAggregate', 'OrderAggregate']);
      expect(result.matches[0].matched).toBe(true);
      expect(result.matches[0].matched_node_ids.sort()).toEqual(['cls_1', 'cls_2']);
    });

    test('no matching class emits nothing and reports why', () => {
      const nodes: CASNode[] = [cls({ id: 'cls_1', name: 'PlainHelper' })];
      const result = applyConventions({ entities: [{ name_suffix: 'Aggregate' }] }, nodes, []);
      expect(result.data_entities).toHaveLength(0);
      expect(result.matches[0].matched).toBe(false);
    });
  });

  describe('role convention', () => {
    test('tags matching nodes with the declared role', () => {
      const nodes: CASNode[] = [fn({ id: 'fn_1', name: 'PlaceOrderUseCase' })];
      const result = applyConventions(
        { roles: [{ name_suffix: 'UseCase', role: 'use-case' }] },
        nodes,
        [],
      );
      expect(result.role_tags).toEqual([{ node_id: 'fn_1', role: 'use-case' }]);
    });
  });

  describe('declared flow convention', () => {
    test('resolves a Class.method step chain and emits a rooted entry point', () => {
      const controller = cls({ id: 'cls_checkout', name: 'CheckoutController' });
      const validate = fn({ id: 'fn_validate', name: 'validate', parent: 'cls_checkout' });
      const nodes: CASNode[] = [controller, validate];
      const result = applyConventions(
        { flows: [{ name: 'Checkout', steps: ['CheckoutController.validate', 'CheckoutController.charge'] }] },
        nodes,
        [],
      );
      expect(result.entry_points).toHaveLength(1);
      expect(result.entry_points[0].handler?.node_id).toBe('fn_validate');
      expect(result.entry_points[0].metadata?.declared_flow_name).toBe('Checkout');
      // "charge" doesn't resolve to a real node — reported, not fabricated.
      expect(result.matches[0].reason).toMatch(/charge/);
    });

    test('flow whose first step does not resolve emits nothing', () => {
      const result = applyConventions(
        { flows: [{ name: 'Ghost', steps: ['Nothing.here'] }] },
        [],
        [],
      );
      expect(result.entry_points).toHaveLength(0);
      expect(result.matches[0].matched).toBe(false);
    });
  });

  test('call-based route convention finds the call site but does not fabricate a route without arg capture', () => {
    const nodes: CASNode[] = [
      fn({ id: 'fn_1', name: 'registerRoutes', implementation: { uses: ['app.register'] } as any }),
    ];
    const result = applyConventions(
      { routes: [{ kind: 'call', call: 'app.register', method_arg: 0, path_arg: 1, handler_arg: 2 }] },
      nodes,
      [],
    );
    expect(result.entry_points).toHaveLength(0);
    expect(result.matches[0].matched_node_ids).toEqual(['fn_1']);
    expect(result.matches[0].matched).toBe(false);
  });

  describe('entry_points convention', () => {
    test('matches exported symbols in files matching the glob whose name matches the regex', () => {
      const nodes: CASNode[] = [
        fn({ id: 'fn_1', name: 'runNightlyImport', source: { file: 'src/jobs/import.ts', line: 1 }, metadata: { is_exported: true } as any }),
        fn({ id: 'fn_2', name: 'helper', source: { file: 'src/jobs/import.ts', line: 5 }, metadata: { is_exported: true } as any }),
        fn({ id: 'fn_3', name: 'runOtherJob', source: { file: 'src/other/thing.ts', line: 1 }, metadata: { is_exported: true } as any }),
      ];
      const result = applyConventions(
        { entry_points: [{ files: 'src/jobs/**/*.ts', export_matches: '^run', kind: 'cli' }] },
        nodes,
        [],
      );
      expect(result.entry_points).toHaveLength(1);
      expect(result.entry_points[0].type).toBe('cli');
      expect(result.entry_points[0].handler?.node_id).toBe('fn_1');
      expect(result.matches[0].matched).toBe(true);
    });

    test('invalid export_matches regex is reported, not thrown', () => {
      const result = applyConventions(
        { entry_points: [{ files: 'src/**/*.ts', export_matches: '(', kind: 'cli' }] },
        [],
        [],
      );
      expect(result.entry_points).toHaveLength(0);
      expect(result.matches[0].matched).toBe(false);
      expect(result.matches[0].reason).toMatch(/Invalid export_matches regex/);
    });
  });

  describe('di_binding convention', () => {
    test('finds the call site but does not fabricate a binding without arg capture', () => {
      const nodes: CASNode[] = [
        fn({ id: 'fn_1', name: 'configureContainer', implementation: { uses: ['provide'] } as any }),
      ];
      const result = applyConventions(
        { di_bindings: [{ call: 'provide', token_arg: 0, impl_arg: 1 }] },
        nodes,
        [],
      );
      expect(result.matches[0].matched_node_ids).toEqual(['fn_1']);
      expect(result.matches[0].matched).toBe(false);
      expect(result.matches[0].reason).toMatch(/no binding edge emitted/);
    });

    test('no matching call site reports why', () => {
      const result = applyConventions(
        { di_bindings: [{ call: 'provide', token_arg: 0, impl_arg: 1 }] },
        [fn({ id: 'fn_1', name: 'plain' })],
        [],
      );
      expect(result.matches[0].matched).toBe(false);
      expect(result.matches[0].reason).toMatch(/No node calls/);
    });
  });
});
