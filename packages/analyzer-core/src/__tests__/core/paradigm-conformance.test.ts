import { buildParadigmConformance } from '../../analyzer/core/paradigm-conformance';
import {
  CASNode,
  CASEdge,
  CASEntryPoint,
  CASExitPoint
} from '../../types/cas.types';

function node(id: string, name: string, type: string, file: string): CASNode {
  return { id, name, type, source: { file } } as CASNode;
}

function edge(id: string, source: string, target: string, type: string): CASEdge {
  return { id, source, target, type };
}

function httpEntry(id: string, sourceNode: string, name: string, path: string, authenticated: boolean): CASEntryPoint {
  return {
    id,
    source_node: sourceNode,
    type: 'http',
    name,
    trigger: { method: 'POST', path },
    handler: { node_id: sourceNode, method_name: 'create' },
    security: { authenticated },
  } as CASEntryPoint;
}

function dbExit(id: string, sourceNode: string, name: string): CASExitPoint {
  return {
    id,
    source_node: sourceNode,
    type: 'database',
    name,
    operation: { action: 'insert' },
  } as CASExitPoint;
}

describe('buildParadigmConformance', () => {
  describe('graph with established norms', () => {
    const domains = ['orders', 'users', 'invoices', 'shipments', 'reports'];

    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    domains.forEach((domain, i) => {
      const controllerId = `n_${domain}_controller`;
      const serviceId = `n_${domain}_service`;
      const repoId = `n_${domain}_repo`;
      nodes.push(node(controllerId, `${domain}Controller`, 'controller', `src/${domain}/${domain}.controller.ts`));
      nodes.push(node(serviceId, `${domain}Service`, 'service', `src/${domain}/${domain}.service.ts`));
      nodes.push(node(repoId, `${domain}Repository`, 'repository', `src/${domain}/${domain}.repository.ts`));
      edges.push(edge(`e_${domain}_cs`, controllerId, serviceId, 'calls'));
      edges.push(edge(`e_${domain}_sr`, serviceId, repoId, 'calls'));
      exitPoints.push(dbExit(`exit_${domain}_db`, repoId, `${domain} insert`));
      entryPoints.push(httpEntry(`entry_${domain}`, controllerId, `POST /${domain}`, `/${domain}`, i < 4));
    });

    const rogueId = 'n_billing_controller';
    nodes.push(node(rogueId, 'BillingController', 'controller', 'src/billing/billing.controller.ts'));
    edges.push(edge('e_billing_helper', rogueId, 'n_orders_repo', 'calls'));
    exitPoints.push(dbExit('exit_billing_db', rogueId, 'billing insert'));

    const result = buildParadigmConformance({ nodes, edges, entryPoints, exitPoints });

    it('detects the service-mediated data access norm with the direct-to-db controller as deviation', () => {
      const paradigm = result.find(item => item.paradigm === 'service-mediated-data-access');
      expect(paradigm).toBeDefined();
      expect(paradigm!.adoption.following_count).toBe(5);
      expect(paradigm!.adoption.comparable_count).toBe(6);
      expect(paradigm!.adoption.adoption_rate).toBeGreaterThanOrEqual(0.7);
      expect(paradigm!.adoption.evidence_files).toContain('src/orders/orders.controller.ts');
      expect(paradigm!.deviations).toHaveLength(1);
      const deviation = paradigm!.deviations[0];
      expect(deviation.node_id).toBe(rogueId);
      expect(deviation.kind).toBe('direct-data-access');
      expect(deviation.file).toBe('src/billing/billing.controller.ts');
      expect(deviation.detail).toContain('billing insert');
    });

    it('detects the service-layer hop norm with the repository-calling controller as deviation', () => {
      const paradigm = result.find(item => item.paradigm === 'entry-service-repository-layering');
      expect(paradigm).toBeDefined();
      expect(paradigm!.adoption.following_count).toBe(5);
      expect(paradigm!.adoption.comparable_count).toBe(6);
      expect(paradigm!.deviations).toHaveLength(1);
      const deviation = paradigm!.deviations[0];
      expect(deviation.node_id).toBe(rogueId);
      expect(deviation.kind).toBe('layer-skipping-call');
      expect(deviation.detail).toContain('ordersRepository');
    });

    it('detects the guarded entry norm with the unguarded route as a high-severity deviation', () => {
      const paradigm = result.find(item => item.paradigm === 'guarded-http-entry-points');
      expect(paradigm).toBeDefined();
      expect(paradigm!.adoption.following_count).toBe(4);
      expect(paradigm!.adoption.comparable_count).toBe(5);
      expect(paradigm!.deviations).toHaveLength(1);
      const deviation = paradigm!.deviations[0];
      expect(deviation.kind).toBe('unguarded-entry-point');
      expect(deviation.severity).toBe('error');
      expect(deviation.node_id).toBe('n_reports_controller');
      expect(deviation.file).toBe('src/reports/reports.controller.ts');
    });
  });

  describe('graph without norms', () => {
    const nodes: CASNode[] = [
      node('n_a', 'AlphaController', 'controller', 'src/alpha/alpha.controller.ts'),
      node('n_b', 'BetaController', 'controller', 'src/beta/beta.controller.ts'),
      node('n_a_repo', 'AlphaRepository', 'repository', 'src/alpha/alpha.repository.ts'),
      node('n_b_service', 'BetaService', 'service', 'src/beta/beta.service.ts'),
    ];
    const edges: CASEdge[] = [
      edge('e1', 'n_a', 'n_a_repo', 'calls'),
      edge('e2', 'n_b', 'n_b_service', 'calls'),
    ];
    const entryPoints: CASEntryPoint[] = [
      httpEntry('entry_a', 'n_a', 'POST /alpha', '/alpha', true),
      httpEntry('entry_b', 'n_b', 'POST /beta', '/beta', false),
    ];
    const exitPoints: CASExitPoint[] = [dbExit('exit_a', 'n_a_repo', 'alpha insert')];

    it('produces zero paradigms and zero deviations when no statistical norm exists', () => {
      const result = buildParadigmConformance({ nodes, edges, entryPoints, exitPoints });
      expect(result).toHaveLength(0);
    });
  });

  describe('single-owner entity writes', () => {
    const nodes: CASNode[] = [
      node('n_order_entity', 'Order', 'entity', 'src/orders/entities/order.entity.ts'),
      node('n_user_entity', 'User', 'entity', 'src/users/entities/user.entity.ts'),
      node('n_invoice_entity', 'Invoice', 'entity', 'src/invoices/entities/invoice.entity.ts'),
      node('n_order_service', 'OrderService', 'service', 'src/orders/order.service.ts'),
      node('n_user_service', 'UserService', 'service', 'src/users/user.service.ts'),
      node('n_invoice_service', 'InvoiceService', 'service', 'src/invoices/invoice.service.ts'),
      node('n_report_service', 'ReportService', 'service', 'src/reports/report.service.ts'),
    ];
    const edges: CASEdge[] = [
      edge('w1', 'n_order_service', 'n_order_entity', 'writes'),
      edge('w2', 'n_user_service', 'n_user_entity', 'writes'),
      edge('w3', 'n_invoice_service', 'n_invoice_entity', 'writes'),
    ];

    it('detects the single-owner norm with no deviations when every entity is module-owned', () => {
      const result = buildParadigmConformance({ nodes, edges, entryPoints: [], exitPoints: [] });
      const paradigm = result.find(item => item.paradigm === 'single-owner-entity-writes');
      expect(paradigm).toBeDefined();
      expect(paradigm!.adoption.following_count).toBe(3);
      expect(paradigm!.adoption.comparable_count).toBe(3);
      expect(paradigm!.deviations).toHaveLength(0);
    });

    it('emits deviations once enough entities establish the single-owner norm', () => {
      const extendedNodes = [
        ...nodes,
        node('n_shipment_entity', 'Shipment', 'entity', 'src/shipments/entities/shipment.entity.ts'),
        node('n_shipment_service', 'ShipmentService', 'service', 'src/shipments/shipment.service.ts'),
      ];
      const extendedEdges = [
        ...edges,
        edge('w5', 'n_shipment_service', 'n_shipment_entity', 'writes'),
        edge('w6', 'n_report_service', 'n_shipment_entity', 'writes'),
      ];
      const result = buildParadigmConformance({ nodes: extendedNodes, edges: extendedEdges, entryPoints: [], exitPoints: [] });
      const paradigm = result.find(item => item.paradigm === 'single-owner-entity-writes');
      expect(paradigm).toBeDefined();
      expect(paradigm!.adoption.comparable_count).toBe(4);
      expect(paradigm!.adoption.following_count).toBe(3);
      expect(paradigm!.deviations).toHaveLength(1);
      const deviation = paradigm!.deviations[0];
      expect(deviation.kind).toBe('parallel-implementation');
      expect(deviation.node_id).toBe('n_report_service');
      expect(deviation.file).toBe('src/reports/report.service.ts');
      expect(deviation.detail).toContain('Shipment');
    });
  });
});
