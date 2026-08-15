jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import { assignNodeRoles } from '../../analyzer/core/node-roles';
import { GoAnalyzer } from '../../analyzer/languages/go-analyzer';
import { CASNode, CASEdge, CASEntryPoint, CASExitPoint, NODE_ROLES } from '../../types/cas.types';

function node(partial: Partial<CASNode> & { id: string; name: string }): CASNode {
  return { type: 'function', ...partial } as CASNode;
}

describe('node-roles: closed vocabulary', () => {
  it('NODE_ROLES excludes route-handler and persisted-entity (they already have a home)', () => {
    expect(NODE_ROLES).not.toContain('route-handler');
    expect(NODE_ROLES).not.toContain('persisted-entity');
    expect(NODE_ROLES).toEqual([
      'controller', 'middleware', 'guard', 'gateway', 'resolver',
      'migration', 'scheduled-job', 'event-listener',
    ]);
  });
});

describe('node-roles: migration', () => {
  it('cites framework evidence for an already-typed Rails migration node', () => {
    const migrationNode = node({
      id: 'n1', name: 'AddEmailToUsers', type: 'rails_migration', category: 'migration',
      metadata: { attributes: { table: 'users', action: 'add_column' } },
    });
    const nodes = [migrationNode];
    assignNodeRoles({ nodes, edges: [] });
    expect(migrationNode.role).toBe('migration');
    expect(migrationNode.role_source).toBe('framework-evidence');
    expect(migrationNode.role_evidence).toMatch(/table=users/);
  });

  it('cites framework evidence for an already-typed Laravel migration node', () => {
    const migrationNode = node({
      id: 'n1', name: '2024_01_01_create_orders_table', type: 'laravel_migration', category: 'migration',
      metadata: { attributes: { table: 'orders', action: 'create' } },
    });
    const nodes = [migrationNode];
    assignNodeRoles({ nodes, edges: [] });
    expect(migrationNode.role).toBe('migration');
    expect(migrationNode.role_source).toBe('framework-evidence');
  });

  it('FRAMEWORK-LESS: a plain SQL file under a migrations/ directory with a version-prefixed name gets role=migration from directory+filename convention alone', () => {
    const genericFileNode = node({
      id: 'n1', name: '0007_add_index_to_widgets.sql', type: 'file', category: 'code',
      source: { file: 'db/migrations/0007_add_index_to_widgets.sql' },
    });
    const nodes = [genericFileNode];
    assignNodeRoles({ nodes, edges: [] });
    expect(genericFileNode.role).toBe('migration');
    expect(genericFileNode.role_source).toBe('structural-evidence');
    expect(genericFileNode.role_evidence).toMatch(/migration directory\+version-prefixed-filename convention/);
  });

  it('does NOT assign migration for a file merely named "migrations" without a version-prefixed filename (directory alone is not evidence)', () => {
    const readmeNode = node({
      id: 'n1', name: 'README.md', type: 'file',
      source: { file: 'db/migrations/README.md' },
    });
    const nodes = [readmeNode];
    assignNodeRoles({ nodes, edges: [] });
    expect(readmeNode.role).toBeUndefined();
  });
});

describe('node-roles: scheduled-job and event-listener (generic entry-point-type facts)', () => {
  it('assigns scheduled-job to the handler of a `schedule`-type entry point, citing the entry point and cron expression', () => {
    const handler = node({ id: 'fn1', name: 'reconcileNightlyBalances' });
    const entryPoints: CASEntryPoint[] = [{
      id: 'entry_cron_1', source_node: 'fn1', type: 'schedule', name: 'nightly-reconcile',
      trigger: { schedule: '0 2 * * *' }, handler: { node_id: 'fn1', method_name: 'reconcileNightlyBalances' },
    } as CASEntryPoint];
    const nodes = [handler];
    assignNodeRoles({ nodes, edges: [], entry_points: entryPoints });
    expect(handler.role).toBe('scheduled-job');
    expect(handler.role_evidence).toMatch(/entry_cron_1/);
    expect(handler.role_evidence).toMatch(/0 2 \* \* \*/);
  });

  it('assigns event-listener to the handler of an `event`-type entry point', () => {
    const handler = node({ id: 'fn1', name: 'onOrderPlaced' });
    const entryPoints: CASEntryPoint[] = [{
      id: 'entry_evt_1', source_node: 'fn1', type: 'event', name: 'order.placed',
      trigger: { event: 'order.placed' },
    } as CASEntryPoint];
    assignNodeRoles({ nodes: [handler], edges: [], entry_points: entryPoints });
    expect(handler.role).toBe('event-listener');
    expect(handler.role_evidence).toMatch(/order\.placed/);
  });

  it('assigns resolver to the handler of a `graphql`-type entry point, OVERRIDING a coarse controller tag some analyzers fold GraphQL resolvers into', () => {
    const handler = node({ id: 'fn1', name: 'widgetsResolver', type: 'controller' });
    const entryPoints: CASEntryPoint[] = [{
      id: 'entry_gql_1', source_node: 'fn1', type: 'graphql', name: 'Query.widgets',
    } as CASEntryPoint];
    assignNodeRoles({ nodes: [handler], edges: [], entry_points: entryPoints });
    expect(handler.role).toBe('resolver');
    expect(handler.role_evidence).toMatch(/entry_gql_1/);
  });
});

describe('node-roles: guard vs middleware, from wrapping-chain evidence (guard-classification.ts — already cross-ecosystem)', () => {
  it('classifies an authentication-named wrapper as guard', () => {
    const handler = node({ id: 'fn1', name: 'getOrders', source: { file: 'routes.go' } });
    const authFn = node({ id: 'fn2', name: 'requireApiKey', source: { file: 'routes.go' } });
    const entryPoints: CASEntryPoint[] = [{
      id: 'entry_http_1', source_node: 'fn1', type: 'http', name: 'GET /orders',
      handler: { node_id: 'fn1', method_name: 'getOrders' },
      security: { authenticated: true, guards: ['requireApiKey'] },
    } as CASEntryPoint];
    assignNodeRoles({ nodes: [handler, authFn], edges: [], entry_points: entryPoints });
    expect(authFn.role).toBe('guard');
    expect(authFn.role_evidence).toMatch(/entry_http_1/);
    expect(authFn.role_evidence).toMatch(/authentication/);
  });

  it('classifies a rate-limiting-named wrapper as middleware, not guard (it wraps but does not gate on identity)', () => {
    const handler = node({ id: 'fn1', name: 'getOrders', source: { file: 'routes.go' } });
    const throttleFn = node({ id: 'fn2', name: 'rateLimiter', source: { file: 'routes.go' } });
    const entryPoints: CASEntryPoint[] = [{
      id: 'entry_http_1', source_node: 'fn1', type: 'http', name: 'GET /orders',
      handler: { node_id: 'fn1', method_name: 'getOrders' },
      security: { guards: ['rateLimiter'] },
    } as CASEntryPoint];
    assignNodeRoles({ nodes: [handler, throttleFn], edges: [], entry_points: entryPoints });
    expect(throttleFn.role).toBe('middleware');
  });
});

describe('node-roles: gateway from proxy shape (framework-less)', () => {
  it('assigns gateway to a route handler whose only exit point forwards to another API, with no database/file/cache exit of its own', () => {
    const handler = node({ id: 'fn1', name: 'proxyToBillingService' });
    const entryPoints: CASEntryPoint[] = [{
      id: 'entry_http_1', source_node: 'fn1', type: 'http', name: 'ANY /billing/*',
      handler: { node_id: 'fn1', method_name: 'proxyToBillingService' },
    } as CASEntryPoint];
    const exitPoints: CASExitPoint[] = [{
      id: 'exit_api_1', source_node: 'fn1', type: 'api', name: 'billing-service',
    } as CASExitPoint];
    assignNodeRoles({ nodes: [handler], edges: [], entry_points: entryPoints, exit_points: exitPoints });
    expect(handler.role).toBe('gateway');
  });

  it('does NOT assign gateway when the handler also does its own database work (it is not pure forwarding)', () => {
    const handler = node({ id: 'fn1', name: 'getOrder' });
    const entryPoints: CASEntryPoint[] = [{
      id: 'entry_http_1', source_node: 'fn1', type: 'http', name: 'GET /orders/:id',
      handler: { node_id: 'fn1', method_name: 'getOrder' },
    } as CASEntryPoint];
    const exitPoints: CASExitPoint[] = [
      { id: 'exit_api_1', source_node: 'fn1', type: 'api', name: 'inventory-service' } as CASExitPoint,
      { id: 'exit_db_1', source_node: 'fn1', type: 'database', name: 'orders table' } as CASExitPoint,
    ];
    assignNodeRoles({ nodes: [handler], edges: [], entry_points: entryPoints, exit_points: exitPoints });
    expect(handler.role).toBeUndefined();
  });
});

describe('node-roles: controller from entry-point grouping — framework-conferred AND framework-less', () => {
  it('recomputes derived roles when incremental topology changes', () => {
    const formerController = node({
      id: 'owner',
      name: 'Operations',
      role: 'controller',
      role_source: 'structural-evidence',
      role_evidence: 'owns route entry points',
    });
    assignNodeRoles({ nodes: [formerController], edges: [], resetDerivedRoles: true });
    expect(formerController.role).toBeUndefined();
    expect(formerController.role_source).toBeUndefined();
    expect(formerController.role_evidence).toBeUndefined();
  });

  it('framework-conferred: an already node.type=controller Spring/Express class is normalized to role=controller', () => {
    const controllerNode = node({
      id: 'c1', name: 'OrderController', type: 'controller',
      metadata: { annotations: ['@RestController'] },
    });
    assignNodeRoles({ nodes: [controllerNode], edges: [] });
    expect(controllerNode.role).toBe('controller');
    expect(controllerNode.role_source).toBe('framework-evidence');
  });

  it('FRAMEWORK-LESS (real GoAnalyzer): a plain net/http file with several deliberately non-conventionally-named handlers is grouped into role=controller via containment, with NO "Controller"-suffixed name anywhere', async () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-go-node-roles-'));
    try {
      const goSource = `package main

import "net/http"

func fetchWidgetSummary(w http.ResponseWriter, r *http.Request) {}
func dumpWidgetRows(w http.ResponseWriter, r *http.Request) {}
func listWidgetOrders(w http.ResponseWriter, r *http.Request) {}

func main() {
	http.HandleFunc("GET /widgets/summary", fetchWidgetSummary)
	http.HandleFunc("GET /widgets/dump", dumpWidgetRows)
	http.HandleFunc("GET /widgets/orders", listWidgetOrders)
	http.ListenAndServe(":8080", nil)
}
`;
      fs.writeFileSync(path.join(root, 'main.go'), goSource);

      const analyzer = new GoAnalyzer();
      const context = { projectPath: root, existingAnalysis: [] } as any;
      const contribution = await analyzer.analyze(context);

      const nodes: CASNode[] = contribution.nodes || [];
      const edges: CASEdge[] = contribution.edges || [];
      const httpEntryPoints = (contribution.entry_points || []).filter(ep => ep.type === 'http');
      expect(httpEntryPoints.length).toBeGreaterThanOrEqual(3);
      // Sanity: none of the real extracted handler functions are named with
      // a "Controller" suffix — the framework-less case this rule exists for.
      const functionNodesByName = new Map(nodes.filter(n => n.type === 'function').map(n => [n.name, n]));
      expect([...functionNodesByName.keys()].some(n => /controller/i.test(n))).toBe(false);

      // GoAnalyzer's own route extraction attaches each entry point's
      // handler.node_id to the FILE node (per-function resolution is the
      // orchestrator's separate linkRouteHandlers pass) — resolve that here
      // against the REAL function nodes, exactly like the paradigm-
      // conformance framework-less-Go regression test does.
      const handlerByPath: Record<string, string> = {
        '/widgets/summary': 'fetchWidgetSummary',
        '/widgets/dump': 'dumpWidgetRows',
        '/widgets/orders': 'listWidgetOrders',
      };
      const fileNode = nodes.find(n => n.type === 'file');
      expect(fileNode).toBeDefined();

      const resolvedEntryPoints: CASEntryPoint[] = (contribution.entry_points || []).map(ep => {
        if (ep.type !== 'http' || !ep.trigger?.path) return ep as CASEntryPoint;
        const handlerName = handlerByPath[ep.trigger.path];
        const handlerNode = handlerName ? functionNodesByName.get(handlerName) : undefined;
        if (!handlerNode) return ep as CASEntryPoint;
        return { ...ep, source_node: handlerNode.id, handler: { ...(ep as any).handler, node_id: handlerNode.id } } as CASEntryPoint;
      });

      // Real 'contains' edges from GoAnalyzer already link the file node to
      // each function node — no synthetic edges added here.
      const containsFileToHandlers = edges.filter(
        e => e.type === 'contains' && e.source === fileNode!.id &&
          Object.values(handlerByPath).some(hn => functionNodesByName.get(hn)?.id === e.target),
      );
      expect(containsFileToHandlers.length).toBeGreaterThanOrEqual(3);

      assignNodeRoles({ nodes, edges, entry_points: resolvedEntryPoints, exit_points: contribution.exit_points || [] });

      expect(fileNode!.role).toBe('controller');
      expect(fileNode!.role_source).toBe('structural-evidence');
      expect(fileNode!.role_evidence).toMatch(/route\/API entry points/);
      // The individual handler functions themselves are NOT tagged
      // controller — the grouping owner is, matching "@Controller and Go's
      // http.HandleFunc must resolve to the same role" (route-handler is the
      // per-function role, already homed at CASEntryPoint.type — controller
      // is the group).
      for (const name of Object.values(handlerByPath)) {
        expect(functionNodesByName.get(name)!.role).not.toBe('controller');
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('node-roles: tier discipline — input surface is tier-1 only', () => {
  it('assignNodeRoles accepts ONLY nodes/edges/entry_points/exit_points — no capabilities/flows/entities on its input type', () => {
    // Compile-time check: this call must type-check with exactly the tier-1
    // slice and nothing from comprehension. If a future edit widens
    // NodeRolesInput to accept system_capabilities/flows/data_entities, this
    // still compiles (structural typing) — the real guard is the omission
    // itself: node-roles.ts imports nothing from capability/flow/entity
    // builder modules. Grep-checked in review; this test documents the
    // contract.
    const nodes: CASNode[] = [node({ id: 'n1', name: 'x' })];
    expect(() => assignNodeRoles({ nodes, edges: [] })).not.toThrow();
  });
});
