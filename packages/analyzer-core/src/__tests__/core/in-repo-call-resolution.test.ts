import { internalizeInRepoCalls } from '../../analyzer/core/in-repo-call-resolution';
import { computeFlowConcepts } from '../../analyzer/core/flow-concepts';
import type { CASEdge, CASEntryPoint, CASExitPoint, CASNode, CASOutput } from '../../types/cas.types';

/**
 * THE DEFECT UNDER TEST: an entry point in one package calls a function
 * declared in ANOTHER package of the same repository, and the contributing
 * analyzer records that call as an `sdk` exit point (its module/type spec) with
 * no `calls` edge. Downstream the flow terminated there and reported the
 * in-repo callee as an external service.
 *
 * The contract: an in-repo callee is FOLLOWED (edge materialized, exit dropped)
 * and the flow reaches the real terminal; a genuinely third-party callee is
 * left exactly as reported, and still terminates the flow.
 */

function node(over: Partial<CASNode> & { id: string; name: string; type: string }): CASNode {
  return { level: 2, level_name: 'member', analyzers: ['x'], ...over } as CASNode;
}

describe('in-repo call resolution', () => {
  describe('cross-package call resolution', () => {
    /** entry in `bin/app`, callee declared in `crates/engine` — the shape the
     *  Rust/systems analyzers emit as `Type::method` sdk exits. */
    const nodes: CASNode[] = [
      node({
        id: 'function:bin/app/src/main.rs:main', name: 'main', type: 'function',
        source: { file: 'bin/app/src/main.rs', line: 1, end_line: 5 } as any,
      }),
      node({
        id: 'method:crates/engine/src/lib.rs:Engine:run', name: 'run', type: 'method',
        source: { file: 'crates/engine/src/lib.rs', line: 10, end_line: 40 } as any,
        metadata: { implType: 'Engine' } as any,
      }),
      node({
        id: 'method:crates/store/src/lib.rs:Store:insert', name: 'insert', type: 'method',
        source: { file: 'crates/store/src/lib.rs', line: 8, end_line: 20 } as any,
        metadata: { implType: 'Store' } as any,
      }),
    ];

    const inRepoExit: CASExitPoint = {
      id: 'ext_call:bin/app/src/main.rs:3:Engine::run',
      source_node: 'function:bin/app/src/main.rs:main',
      type: 'sdk',
      name: 'Engine::run',
      target: { sdk: 'Engine' },
      metadata: { library: 'Engine', module: 'Engine', function: 'run', call_line: 3 },
    } as CASExitPoint;

    const terminalExit: CASExitPoint = {
      id: 'ext_call:crates/store/src/lib.rs:12:store::insert',
      source_node: 'method:crates/store/src/lib.rs:Store:insert',
      type: 'database',
      name: 'store::insert',
      target: { resource: 'sessions' },
      metadata: { library: 'store', module: 'store', function: 'insert', call_line: 12 },
    } as CASExitPoint;

    function freshInput() {
      return {
        nodes: nodes.map(n => ({ ...n })),
        // Engine::run -> Store::insert IS already a resolved edge; the missing
        // one is main -> Engine::run, which the sdk exit stood in for.
        edges: [{
          id: 'e1', source: 'method:crates/engine/src/lib.rs:Engine:run',
          target: 'method:crates/store/src/lib.rs:Store:insert', type: 'calls',
        }] as CASEdge[],
        exitPoints: [{ ...inRepoExit }, { ...terminalExit }] as CASExitPoint[],
        libraries: [],
      };
    }

    test('materializes the missing calls edge across the package boundary and drops the phantom exit', () => {
      const input = freshInput();
      const stats = internalizeInRepoCalls(input);

      expect(stats.internalized).toBe(1);
      expect(stats.edges_added).toBe(1);
      expect(stats.by_tier.type_member).toBe(1);

      const added = input.edges.find(e => e.source === 'function:bin/app/src/main.rs:main');
      expect(added).toBeDefined();
      expect(added!.type).toBe('calls');
      expect(added!.target).toBe('method:crates/engine/src/lib.rs:Engine:run');
      // the correction stays auditable back to the exit point it replaced.
      expect((added!.metadata as any).attributes.internalized_from_exit_point).toBe(inRepoExit.id);

      // an in-repo call is not an exit.
      expect(input.exitPoints.map(e => e.id)).toEqual([terminalExit.id]);
    });

    test('THE REGRESSION: the flow does NOT terminate at the in-repo callee — it reaches the real terminal', () => {
      const input = freshInput();
      internalizeInRepoCalls(input);

      const entry_points: CASEntryPoint[] = [{
        id: 'ep_main', source_node: 'function:bin/app/src/main.rs:main', type: 'cli', name: 'main',
        handler: { node_id: 'function:bin/app/src/main.rs:main', method_name: 'main' },
      } as CASEntryPoint];

      const cas = {
        cas_version: '1.0.0', analysis_timestamp: new Date().toISOString(), analysis_id: 'test-crosspkg',
        system: { name: 'test-system' } as any,
        nodes: input.nodes, edges: input.edges, entry_points, exit_points: input.exitPoints,
        data_lineage: [], entities: [], capabilities: [], analyzer_contributions: [],
      } as unknown as CASOutput;

      const flow = computeFlowConcepts(cas)[0];
      expect(flow).toBeDefined();

      const reached = flow.steps.flatMap(s => s.functions.map(f => f.function_id));
      // it walked THROUGH the other package's function...
      expect(reached).toContain('method:crates/engine/src/lib.rs:Engine:run');
      // ...and on to the terminal one.
      expect(reached).toContain('method:crates/store/src/lib.rs:Store:insert');
      // a truncated flow would have been one step named after the "SDK".
      expect(flow.steps.length).toBeGreaterThan(1);
      expect(flow.steps.map(s => s.name).join(' ')).not.toMatch(/Engine/);
    });
  });

  describe('honesty at genuine boundaries', () => {
    const caller = node({
      id: 'fn:src/pay.ts:charge', name: 'charge', type: 'function',
      source: { file: 'src/pay.ts', line: 1, end_line: 9 } as any,
    });

    test('a third-party SDK call with no in-repo declaration is left untouched', () => {
      const input = {
        nodes: [caller],
        edges: [] as CASEdge[],
        exitPoints: [{
          id: 'x1', source_node: caller.id, type: 'sdk', name: 'stripe.charges.create',
          target: { sdk: 'stripe' },
          metadata: { library: 'stripe', module: 'stripe', function: 'create' },
        }] as CASExitPoint[],
        libraries: [],
      };
      const stats = internalizeInRepoCalls(input);
      expect(stats.internalized).toBe(0);
      expect(stats.unresolved).toBe(1);
      expect(input.exitPoints).toHaveLength(1);
      expect(input.edges).toHaveLength(0);
    });

    test('a library-mapped module defers to the analyzer even when the repo declares a colliding type', () => {
      // The repo has its own `Client.get`, but the analyzer already resolved
      // this call's module `Client` to the third-party library `reqwest` — that
      // is positive external evidence and outranks the name collision.
      const input = {
        nodes: [
          caller,
          node({
            id: 'method:src/http/client.ts:Client:get', name: 'get', type: 'method',
            source: { file: 'src/http/client.ts', line: 3, end_line: 6 } as any,
            metadata: { className: 'Client' } as any,
          }),
        ],
        edges: [] as CASEdge[],
        exitPoints: [{
          id: 'x2', source_node: caller.id, type: 'sdk', name: 'Client::get',
          target: { sdk: 'reqwest' },
          metadata: { library: 'reqwest', module: 'Client', function: 'get' },
        }] as CASExitPoint[],
        libraries: [],
      };
      const stats = internalizeInRepoCalls(input);
      expect(stats.skipped_library_mapped).toBe(1);
      expect(stats.internalized).toBe(0);
      expect(input.exitPoints).toHaveLength(1);
    });

    test('a declared non-workspace dependency wins over an in-repo name collision', () => {
      const input = {
        nodes: [
          caller,
          node({
            id: 'method:src/redis.ts:redis:get', name: 'get', type: 'method',
            source: { file: 'src/redis.ts', line: 3, end_line: 6 } as any,
            metadata: { className: 'redis' } as any,
          }),
        ],
        edges: [] as CASEdge[],
        exitPoints: [{
          id: 'x3', source_node: caller.id, type: 'cache', name: 'redis::get',
          target: { sdk: 'redis' }, metadata: { library: 'redis', module: 'redis', function: 'get' },
        }] as CASExitPoint[],
        libraries: [{ id: 'lib_redis', name: 'redis', version: '4.6.0' }] as any,
      };
      const stats = internalizeInRepoCalls(input);
      expect(stats.skipped_declared_dependency).toBe(1);
      expect(input.exitPoints).toHaveLength(1);
    });

    test('a workspace-local package in the manifest is NOT treated as third party', () => {
      // Monorepo crates/packages appear in the dependency manifest with a PATH
      // where a version would be. Those are in-repo and must stay resolvable.
      const input = {
        nodes: [
          caller,
          node({
            id: 'method:crates/engine/src/lib.rs:Engine:run', name: 'run', type: 'method',
            source: { file: 'crates/engine/src/lib.rs', line: 3, end_line: 6 } as any,
            metadata: { implType: 'Engine' } as any,
          }),
        ],
        edges: [] as CASEdge[],
        exitPoints: [{
          id: 'x4', source_node: caller.id, type: 'sdk', name: 'Engine::run',
          target: { sdk: 'Engine' }, metadata: { library: 'Engine', module: 'Engine', function: 'run' },
        }] as CASExitPoint[],
        libraries: [{ id: 'lib_engine', name: 'Engine', version: 'crates/engine' }] as any,
      };
      const stats = internalizeInRepoCalls(input);
      expect(stats.skipped_declared_dependency).toBe(0);
      expect(stats.internalized).toBe(1);
    });

    test('ambiguity abstains: two same-named callees in unrelated packages resolve to neither', () => {
      const input = {
        nodes: [
          caller,
          node({
            id: 'method:packages/a/src/x.ts:Thing:go', name: 'go', type: 'method',
            source: { file: 'packages/a/src/x.ts', line: 1, end_line: 3 } as any,
            metadata: { className: 'Thing' } as any,
          }),
          node({
            id: 'method:packages/b/src/y.ts:Thing:go', name: 'go', type: 'method',
            source: { file: 'packages/b/src/y.ts', line: 1, end_line: 3 } as any,
            metadata: { className: 'Thing' } as any,
          }),
        ],
        edges: [] as CASEdge[],
        exitPoints: [{
          id: 'x5', source_node: caller.id, type: 'sdk', name: 'Thing::go',
          target: { sdk: 'Thing' }, metadata: { library: 'Thing', module: 'Thing', function: 'go' },
        }] as CASExitPoint[],
        libraries: [],
      };
      const stats = internalizeInRepoCalls(input);
      expect(stats.internalized).toBe(0);
      expect(stats.skipped_ambiguous).toBe(1);
      expect(input.edges).toHaveLength(0);
    });
  });

  describe('aliased module-path imports (the TypeScript/bundler shape)', () => {
    test('resolves a path-alias specifier to the real file and its exported function', () => {
      const input = {
        nodes: [
          node({
            id: 'fn:apps/app/src/app/Page.tsx:Page', name: 'Page', type: 'component',
            source: { file: 'apps/app/src/app/Page.tsx', line: 1, end_line: 30 } as any,
          }),
          node({
            id: 'fn:apps/app/src/shared/lib/slugs.ts:toSlug', name: 'toSlug', type: 'function',
            source: { file: 'apps/app/src/shared/lib/slugs.ts', line: 4, end_line: 8 } as any,
          }),
        ],
        edges: [] as CASEdge[],
        exitPoints: [{
          id: 'x6', source_node: 'fn:apps/app/src/app/Page.tsx:Page', type: 'sdk',
          name: 'Call to toSlug',
          target: { sdk: '@/shared/lib/slugs', endpoint: 'toSlug' },
          metadata: { library: '@/shared/lib/slugs', line: 12 },
        }] as CASExitPoint[],
        libraries: [],
      };
      const stats = internalizeInRepoCalls(input);
      expect(stats.internalized).toBe(1);
      expect(stats.by_tier.module_path).toBe(1);
      expect(input.edges[0].target).toBe('fn:apps/app/src/shared/lib/slugs.ts:toSlug');
      expect(input.exitPoints).toHaveLength(0);
    });

    test('resolves a NON-"@/" project alias by walking the specifier tail', () => {
      // `@stores/...`, `~features/...`, `#lib/...` are all legal alias prefixes
      // and none of them appear on disk. The specifier's tail does.
      const input = {
        nodes: [
          node({
            id: 'fn:src/pages/Billing.tsx:Billing', name: 'Billing', type: 'component',
            source: { file: 'src/pages/Billing.tsx', line: 1, end_line: 40 } as any,
          }),
          node({
            id: 'fn:src/stores/subscription.store.ts:useSubscription', name: 'useSubscription', type: 'function',
            source: { file: 'src/stores/subscription.store.ts', line: 9, end_line: 30 } as any,
          }),
        ],
        edges: [] as CASEdge[],
        exitPoints: [{
          id: 'x8', source_node: 'fn:src/pages/Billing.tsx:Billing', type: 'sdk',
          name: 'Call to useSubscription',
          target: { sdk: '@stores/subscription.store', endpoint: 'useSubscription' },
          metadata: { library: '@stores/subscription.store' },
        }] as CASExitPoint[],
        libraries: [],
      };
      const stats = internalizeInRepoCalls(input);
      expect(stats.internalized).toBe(1);
      expect(input.edges[0].target).toBe('fn:src/stores/subscription.store.ts:useSubscription');
    });

    test('a SCOPED npm package is not mistaken for an alias even when its tail matches a repo file', () => {
      // `@mui/material` must never resolve to a repo file called `material.ts`.
      const input = {
        nodes: [
          node({
            id: 'fn:src/pages/P.tsx:P', name: 'P', type: 'component',
            source: { file: 'src/pages/P.tsx', line: 1, end_line: 10 } as any,
          }),
          node({
            id: 'fn:src/theme/material.ts:Box', name: 'Box', type: 'function',
            source: { file: 'src/theme/material.ts', line: 2, end_line: 4 } as any,
          }),
        ],
        edges: [] as CASEdge[],
        exitPoints: [{
          id: 'x9', source_node: 'fn:src/pages/P.tsx:P', type: 'sdk', name: 'Call to Box',
          target: { sdk: '@mui/material', endpoint: 'Box' },
          metadata: { library: '@mui/material' },
        }] as CASExitPoint[],
        libraries: [{ id: 'lib_mui', name: '@mui/material', version: '5.15.0' }] as any,
      };
      const stats = internalizeInRepoCalls(input);
      expect(stats.skipped_declared_dependency).toBe(1);
      expect(stats.internalized).toBe(0);
      expect(input.exitPoints).toHaveLength(1);
    });

    test('a bare npm specifier that happens to share a tail with a repo path is not resolved', () => {
      const input = {
        nodes: [
          node({
            id: 'fn:src/a.ts:go', name: 'go', type: 'function',
            source: { file: 'src/a.ts', line: 1, end_line: 3 } as any,
          }),
        ],
        edges: [] as CASEdge[],
        exitPoints: [{
          id: 'x7', source_node: 'fn:src/a.ts:go', type: 'sdk', name: 'Call to useQuery',
          target: { sdk: '@tanstack/react-query', endpoint: 'useQuery' },
          metadata: { library: '@tanstack/react-query' },
        }] as CASExitPoint[],
        libraries: [],
      };
      const stats = internalizeInRepoCalls(input);
      expect(stats.internalized).toBe(0);
      expect(input.exitPoints).toHaveLength(1);
    });
  });

  test('is idempotent — a second run resolves nothing new and adds no duplicate edge', () => {
    const mk = () => ({
      nodes: [
        node({ id: 'a', name: 'main', type: 'function', source: { file: 'bin/x/main.rs', line: 1, end_line: 4 } as any }),
        node({
          id: 'b', name: 'run', type: 'method',
          source: { file: 'crates/e/lib.rs', line: 1, end_line: 4 } as any,
          metadata: { implType: 'Engine' } as any,
        }),
      ],
      edges: [] as CASEdge[],
      exitPoints: [{
        id: 'x', source_node: 'a', type: 'sdk', name: 'Engine::run',
        target: { sdk: 'Engine' }, metadata: { library: 'Engine', module: 'Engine', function: 'run' },
      }] as CASExitPoint[],
      libraries: [],
    });
    const input = mk();
    expect(internalizeInRepoCalls(input).internalized).toBe(1);
    const second = internalizeInRepoCalls(input);
    expect(second.candidates).toBe(0);
    expect(input.edges).toHaveLength(1);
  });
});

/**
 * REGRESSION — dropping an exit point must not leave the edges that referenced
 * it pointing at an id present in no collection.
 *
 * Measured before this held: 17,245 `calls` edges in one stored analysis (16.9%
 * of the whole graph) targeted exit ids this pass had removed. The orphans were
 * the analyzers' ORIGINAL edges, not the replacements this pass appends — which
 * is why none of them carried internalization provenance and the cause looked
 * like a persistence cap rather than an unreconciled removal.
 */
describe('exit-point removal reconciles the edges that referenced it', () => {
  function scenario() {
    return {
      nodes: [
        node({
          id: 'caller', name: 'handle', type: 'function',
          source: { file: 'apps/web/src/page.tsx', line: 1, end_line: 9 } as any,
        }),
        node({
          id: 'callee', name: 'useThing', type: 'function',
          source: { file: 'apps/web/src/hooks/thing.ts', line: 2, end_line: 8 } as any,
        }),
      ] as CASNode[],
      // The edge the analyzer emitted alongside its (mis-classified) exit point.
      edges: [{
        id: 'call_caller_exit_sdk_handle_useThing_4',
        source: 'caller',
        target: 'exit_sdk_handle_useThing_4',
        type: 'calls',
        metadata: { confidence: 0.9, locations: [{ file: 'apps/web/src/page.tsx', line: 4 }] },
      }] as CASEdge[],
      exitPoints: [{
        id: 'exit_sdk_handle_useThing_4',
        source_node: 'caller',
        type: 'sdk',
        name: 'useThing',
        target: { sdk: '@/hooks/thing' },
        metadata: { module: '@/hooks/thing', function: 'useThing', call_line: 4 },
      }] as CASExitPoint[],
      libraries: [],
    };
  }

  it('leaves no edge referencing the removed exit point', () => {
    const input = scenario();
    const stats = internalizeInRepoCalls(input);
    expect(stats.internalized).toBe(1);
    expect(input.exitPoints).toHaveLength(0);

    const endpointIds = new Set([
      ...input.nodes.map(n => n.id),
      ...input.exitPoints.map(e => e.id),
    ]);
    const dangling = input.edges.filter(e => !endpointIds.has(e.source) || !endpointIds.has(e.target));
    expect(dangling).toEqual([]);
  });

  it('asserts exactly one call for the pair, not a duplicate per reference', () => {
    const input = scenario();
    internalizeInRepoCalls(input);
    const pairs = input.edges.filter(e => e.type === 'calls').map(e => `${e.source}->${e.target}`);
    expect(pairs).toEqual(['caller->callee']);
  });

  it('keeps the correction auditable — the surviving edge names the exit it replaced', () => {
    const input = scenario();
    internalizeInRepoCalls(input);
    const attributes = (input.edges[0].metadata as any)?.attributes;
    expect(attributes?.internalized_from_exit_point).toBe('exit_sdk_handle_useThing_4');
  });

  it('repoints a referencing edge whose source is not the exit point owner', () => {
    const input = scenario();
    // A second caller recorded a call to the SAME exit id; the appended
    // replacement (from `caller`) cannot cover it, so it must be repointed.
    input.nodes.push(node({
      id: 'other', name: 'render', type: 'function',
      source: { file: 'apps/web/src/other.tsx', line: 1, end_line: 3 } as any,
    }));
    input.edges.push({
      id: 'call_other_exit_sdk_handle_useThing_4',
      source: 'other',
      target: 'exit_sdk_handle_useThing_4',
      type: 'calls',
    } as CASEdge);

    const stats = internalizeInRepoCalls(input);
    expect(stats.edges_repointed).toBe(1);
    const repointed = input.edges.find(e => e.id === 'call_other_exit_sdk_handle_useThing_4');
    expect(repointed?.target).toBe('callee');
    const endpointIds = new Set(input.nodes.map(n => n.id));
    expect(input.edges.filter(e => !endpointIds.has(e.target))).toEqual([]);
  });

  it('drops rather than repoints when the repoint would be a self-call', () => {
    const input = scenario();
    input.edges.push({
      id: 'call_callee_exit_sdk_handle_useThing_4',
      source: 'callee',
      target: 'exit_sdk_handle_useThing_4',
      type: 'calls',
    } as CASEdge);

    const stats = internalizeInRepoCalls(input);
    expect(stats.edges_dropped_orphaned).toBeGreaterThanOrEqual(1);
    expect(input.edges.some(e => e.source === 'callee' && e.target === 'callee')).toBe(false);
    const endpointIds = new Set(input.nodes.map(n => n.id));
    expect(input.edges.filter(e => !endpointIds.has(e.target))).toEqual([]);
  });

  it('leaves edges to exit points it did NOT remove untouched', () => {
    const input = scenario();
    input.exitPoints.push({
      id: 'exit_api_handle_post_7',
      source_node: 'caller',
      type: 'api',
      name: 'POST /v1/things',
      target: { endpoint: 'https://api.example.com/v1/things' },
      metadata: { call_line: 7 },
    } as CASExitPoint);
    input.edges.push({
      id: 'call_caller_exit_api_handle_post_7',
      source: 'caller',
      target: 'exit_api_handle_post_7',
      type: 'calls',
    } as CASEdge);

    internalizeInRepoCalls(input);
    const kept = input.edges.find(e => e.id === 'call_caller_exit_api_handle_post_7');
    expect(kept?.target).toBe('exit_api_handle_post_7');
    expect(input.exitPoints.map(e => e.id)).toContain('exit_api_handle_post_7');
  });
});
