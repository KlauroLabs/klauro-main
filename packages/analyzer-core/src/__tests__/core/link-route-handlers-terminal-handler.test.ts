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
