import type { CASNode, CASEdge, CASEntryPoint } from '../../types/cas.types';
import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';

// REGRESSION GUARD for the exact structural fact investigated in task #next:
// a `router.METHOD(path, guardMiddleware, terminalHandler)` registration —
// the near-universal middleware-then-handler chain shape (Express/Koa/
// Fastify/NestJS guards, Django/Rails/Laravel before-filters, Go handler
// wrapping) — must resolve the entry point's `calls` edge (and
// `handler.node_id`) to the TERMINAL handler function, not stall on the
// route-registration node or on a guard/middleware node.
//
// This was investigated as a hypothesized "second root cause" behind a
// flows_to_capabilities coverage-gate failure on the express-mongoose
// analysis-truth fixture. Direct reproduction against the real orchestrator
// (linkRouteHandlers, private method exercised the same way
// orchestrator-entry-point-contract-capability.test.ts exercises its
// sibling private methods) shows the resolution already correct and has
// been since 2026-02-01 (git blame): the route/guard/terminal-handler chain
// below is the exact shape express-analyzer.ts emits for
// `router.get('/users/:id', requireAuth, getUser)`, and it resolves to
// `getUser`, never to `requireAuth` or the route node itself. This test
// locks that fact in — deterministically, no AI, no full-fixture pipeline —
// so a future change to linkRouteHandlers cannot silently regress it back
// to the symptom that prompted the investigation (empty flow.entities /
// zero-operation capability candidates because the derivation never got
// past the guard step).
describe('linkRouteHandlers: terminal-handler resolution through a middleware chain', () => {
  const orch = new AnalyzerOrchestrator() as any;

  it('resolves the calls edge and handler.node_id to the TERMINAL handler, not the guard middleware or the route node itself', () => {
    const routeNode: CASNode = {
      id: 'route_router_server_get_0',
      name: 'GET /users/:id',
      type: 'route',
      qualified_name: 'GET /users/:id',
    } as CASNode;

    // The guard/middleware node — same shape express-analyzer.ts emits for
    // `requireAuth`. Deliberately given type 'middleware' (not
    // 'function'/'method') so it is NOT eligible for functionNodesByFile —
    // mirroring how a real middleware node is categorized, structurally,
    // never by matching its name.
    const guardNode: CASNode = {
      id: 'middleware_requireAuth',
      name: 'requireAuth',
      type: 'middleware',
      qualified_name: 'requireAuth',
      source: { file: 'src/server.ts', line: 13, end_line: 19 },
    } as CASNode;

    // A same-named decoy in a DIFFERENT file — proves the resolution is
    // file-scoped, not a bare name lookup.
    const decoyHandlerNode: CASNode = {
      id: 'function_src/other.ts_getUser_0',
      name: 'getUser',
      type: 'function',
      qualified_name: 'getUser',
      source: { file: 'src/other.ts', line: 1, end_line: 3 },
    } as CASNode;

    // The TERMINAL handler — last positional arg in the registration call,
    // the one that actually reads the User entity.
    const terminalHandlerNode: CASNode = {
      id: 'function_src/server.ts_getUser_1',
      name: 'getUser',
      type: 'function',
      qualified_name: 'getUser',
      source: { file: 'src/server.ts', line: 22, end_line: 25 },
    } as CASNode;

    const nodes: CASNode[] = [routeNode, guardNode, decoyHandlerNode, terminalHandlerNode];
    const edges: CASEdge[] = [];

    const entryPoint: CASEntryPoint = {
      id: 'entry_route_router_server_get_0',
      name: 'GET /users/:id',
      type: 'http',
      source_node: routeNode.id,
      trigger: { method: 'GET', path: '/users/:id' },
      // Structural fact express-analyzer.ts already produces correctly: the
      // LAST arg of the registration call, resolved by position — never by
      // matching a name like "requireAuth"/"authenticate" against a
      // vocabulary table.
      handler: { node_id: routeNode.id, method_name: 'getUser', file: 'src/server.ts' },
      security: { authenticated: true, guards: ['requireAuth'], authorized_roles: [] },
    } as CASEntryPoint;

    orch.linkRouteHandlers(nodes, edges, [entryPoint]);

    expect(entryPoint.handler!.node_id).toBe(terminalHandlerNode.id);

    const callsEdges = edges.filter(e => e.type === 'calls' && e.source === routeNode.id);
    expect(callsEdges).toHaveLength(1);
    expect(callsEdges[0].target).toBe(terminalHandlerNode.id);
    expect((callsEdges[0].metadata as any)?.attributes?.relationship).toBe('route_handler');

    // Never lands on the guard or the cross-file decoy.
    expect(entryPoint.handler!.node_id).not.toBe(guardNode.id);
    expect(entryPoint.handler!.node_id).not.toBe(decoyHandlerNode.id);
    expect(edges.some(e => e.target === guardNode.id)).toBe(false);
    expect(edges.some(e => e.target === decoyHandlerNode.id)).toBe(false);
  });
});

// REGRESSION GUARD for the defect measured live (task/#131, miniflux VPS
// analysis): a Go entry point's `handler.file` is stamped with the file that
// REGISTERS the route (e.g. internal/api/api.go), never the file that
// IMPLEMENTS the handler — Go's idiomatic shape registers every route in one
// file while each struct-method handler is defined in a sibling file in the
// same package (internal/api/entries.go, feeds.go, users.go, ...). Because
// `handlerFile` always self-matches linkRouteHandlers' own file-scoping
// filter (a file path always "includes" itself), the narrowed search never
// falls back to "search every file" even though the real handler lives
// entirely outside the narrowed set — leaving `handler.node_id` unset,
// `source_node` pointed at a FILE node with no outgoing calls, and
// journey-builder's chain walk dead-ending at depth 0. Of 151 real HTTP
// routes on that analysis, exactly one journey survived. This test locks in
// the fix: an unambiguous EXACT project-wide name match resolves even when
// it lives outside handlerFile's narrowed scope.
describe('linkRouteHandlers: cross-file same-package handler resolution (Go struct-method shape)', () => {
  const orch = new AnalyzerOrchestrator() as any;

  it('resolves handler.node_id to the implementation file when it differs from the route-registration file', () => {
    const routeFileNode: CASNode = {
      id: 'file_internal_api_api_go',
      name: 'api.go',
      type: 'file',
      qualified_name: 'internal/api/api.go',
      source: { file: 'internal/api/api.go' },
    } as CASNode;

    // api.go itself declares an unrelated function (e.g. NewHandler) — so
    // it's a real key in functionNodesByFile and the narrowed search is NOT
    // empty (which would already hit the pre-existing "search everything"
    // fallback and mask this bug). This is what forces the file-scoped
    // search to find nothing relevant and rely on the new global fallback.
    const unrelatedSameFileFn: CASNode = {
      id: 'function_internal_api_api_go_NewHandler',
      name: 'NewHandler',
      type: 'function',
      qualified_name: 'NewHandler',
      source: { file: 'internal/api/api.go', line: 5, end_line: 8 },
    } as CASNode;

    // The real handler, implemented in a DIFFERENT file in the same package —
    // never referenced by api.go's own file path.
    const handlerNode: CASNode = {
      id: 'method_handler_getFeeds_42',
      name: 'getFeeds',
      type: 'method',
      qualified_name: 'getFeeds',
      source: { file: 'internal/api/feeds.go', line: 42, end_line: 60 },
    } as CASNode;

    const nodes: CASNode[] = [routeFileNode, unrelatedSameFileFn, handlerNode];
    const edges: CASEdge[] = [];

    const entryPoint: CASEntryPoint = {
      id: 'entry_go_route_internal_api_api_go_GET__v1_feeds',
      name: 'GET /v1/feeds',
      type: 'http',
      source_node: routeFileNode.id,
      trigger: { method: 'GET', path: '/v1/feeds' },
      // Structural fact go-analyzer.ts already produces correctly:
      // resolveGoHandlerMethodName('handler.getFeeds') -> 'getFeeds', file
      // stamped as the REGISTRATION file (api.go), not feeds.go.
      handler: { method_name: 'getFeeds', file: 'internal/api/api.go' },
      security: { authenticated: false },
    } as CASEntryPoint;

    orch.linkRouteHandlers(nodes, edges, [entryPoint]);

    expect(entryPoint.handler!.node_id).toBe(handlerNode.id);

    const callsEdges = edges.filter(e => e.type === 'calls' && e.source === routeFileNode.id);
    expect(callsEdges).toHaveLength(1);
    expect(callsEdges[0].target).toBe(handlerNode.id);
  });

  it('stays honest (no node_id) when the exact name is ambiguous project-wide and neither candidate owns call edges', () => {
    const routeFileNode: CASNode = {
      id: 'file_internal_api_api_go',
      name: 'api.go',
      type: 'file',
      qualified_name: 'internal/api/api.go',
      source: { file: 'internal/api/api.go' },
    } as CASNode;

    const unrelatedSameFileFn: CASNode = {
      id: 'function_internal_api_api_go_NewHandler',
      name: 'NewHandler',
      type: 'function',
      qualified_name: 'NewHandler',
      source: { file: 'internal/api/api.go', line: 5, end_line: 8 },
    } as CASNode;

    const handlerA: CASNode = {
      id: 'method_handler_a_getEntries',
      name: 'getEntries',
      type: 'method',
      qualified_name: 'getEntries',
      source: { file: 'internal/api/entries.go', line: 10, end_line: 20 },
    } as CASNode;

    // A genuinely unrelated same-named method on a different struct —
    // ambiguous, no call-edge tiebreaker available.
    const handlerB: CASNode = {
      id: 'method_handler_b_getEntries',
      name: 'getEntries',
      type: 'method',
      qualified_name: 'getEntries',
      source: { file: 'internal/other/entries.go', line: 5, end_line: 15 },
    } as CASNode;

    const nodes: CASNode[] = [routeFileNode, unrelatedSameFileFn, handlerA, handlerB];
    const edges: CASEdge[] = [];

    const entryPoint: CASEntryPoint = {
      id: 'entry_go_route_internal_api_api_go_GET__v1_entries',
      name: 'GET /v1/entries',
      type: 'http',
      source_node: routeFileNode.id,
      trigger: { method: 'GET', path: '/v1/entries' },
      handler: { method_name: 'getEntries', file: 'internal/api/api.go' },
      security: { authenticated: false },
    } as CASEntryPoint;

    orch.linkRouteHandlers(nodes, edges, [entryPoint]);

    expect(entryPoint.handler!.node_id).toBeUndefined();
    expect(edges.filter(e => e.type === 'calls' && e.source === routeFileNode.id)).toHaveLength(0);
  });
});
