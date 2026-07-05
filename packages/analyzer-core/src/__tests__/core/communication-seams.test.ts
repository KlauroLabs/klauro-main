import { classifyCommunicationSeams } from '../../analyzer/core/communication-seams';
import type {
  CASNode,
  CASExitPoint,
  CASEntryPoint,
  CASEntityLineage,
  DeployableEvidence,
} from '../../types/cas.types';

function node(id: string, file: string): CASNode {
  return { id, name: id, type: 'function', source: { file, line: 1 } } as CASNode;
}

function apiExit(sourceNode: string, file: string): CASExitPoint {
  return {
    id: 'exit_api_1',
    source_node: sourceNode,
    type: 'api',
    name: 'FETCH https://payments/charge',
    target: { service_id: 'payments', endpoint: 'https://payments/charge' },
    operation: { method: 'POST', action: 'fetch', async: true },
    metadata: { file },
  } as CASExitPoint;
}

function queueExit(sourceNode: string, file: string): CASExitPoint {
  return {
    id: 'exit_msg_1',
    source_node: sourceNode,
    type: 'message',
    name: 'BullMQ: job producer',
    target: { service_id: 'bullmq', resource: 'email-queue' },
    operation: { action: 'enqueue', async: true },
    metadata: { file },
  } as CASExitPoint;
}

function queueConsumer(sourceNode: string, file: string): CASEntryPoint {
  return {
    id: 'entry_msg_1',
    source_node: sourceNode,
    type: 'message',
    name: 'email-queue',
    trigger: { event: 'email-queue' },
    handler: { node_id: sourceNode, method_name: 'process', file },
  } as CASEntryPoint;
}

/** An entity written by module A and read by module B => a passive seam. */
function sharedEntity(): CASEntityLineage {
  return {
    entity_id: 'entity_order',
    entity_name: 'Order',
    sensitive_fields: [],
    writers: [{ node_id: 'w1', file: 'apps/checkout/order.service.ts', via: 'lifecycle:created' }],
    readers: [{ node_id: 'r1', file: 'apps/reporting/report.service.ts', via: 'lifecycle:read' }],
    external_recipients: [],
    boundaries_crossed: [],
    journeys_carrying: [],
    exposure: { unguarded_paths: 0, external_transfer: false, sensitive: false },
  } as CASEntityLineage;
}

/** An entity written AND read by the SAME module => NOT a passive seam. */
function selfOwnedEntity(): CASEntityLineage {
  return {
    entity_id: 'entity_cart',
    entity_name: 'Cart',
    sensitive_fields: [],
    writers: [{ node_id: 'w2', file: 'apps/checkout/cart.service.ts', via: 'lifecycle:created' }],
    readers: [{ node_id: 'r2', file: 'apps/checkout/cart.controller.ts', via: 'lifecycle:read' }],
    external_recipients: [],
    boundaries_crossed: [],
    journeys_carrying: [],
    exposure: { unguarded_paths: 0, external_transfer: false, sensitive: false },
  } as CASEntityLineage;
}

const deployables: DeployableEvidence[] = [
  // Real ship boundaries (tier-1 containers) — server-entry per-route deployables
  // are intentionally NOT used to name components.
  { root_path: 'apps/checkout', name: 'checkout', tier: 1, kind: 'container', evidence: [] },
  { root_path: 'apps/reporting', name: 'reporting', tier: 1, kind: 'container', evidence: [] },
];

describe('communication-seams classifier', () => {
  const result = classifyCommunicationSeams({
    nodes: [
      node('fn_charge', 'apps/checkout/payment.service.ts'),
      node('fn_enqueue', 'apps/checkout/email.service.ts'),
      node('fn_process', 'apps/reporting/email.worker.ts'),
    ],
    exit_points: [apiExit('fn_charge', 'apps/checkout/payment.service.ts'), queueExit('fn_enqueue', 'apps/checkout/email.service.ts')],
    entry_points: [queueConsumer('fn_process', 'apps/reporting/email.worker.ts')],
    data_lineage: [sharedEntity(), selfOwnedEntity()],
    data_entities: [],
    deployable_evidence: deployables,
  });

  it('classifies an awaited HTTP/api exit as SYNC', () => {
    const sync = result.seams.filter(s => s.modality === 'sync');
    expect(sync.some(s => s.evidence.includes('exit_api_1'))).toBe(true);
    expect(sync[0].source).toBe('checkout');
    expect(sync[0].target).toBe('payments');
  });

  it('classifies a queue publish AND its consumer as ASYNC', () => {
    const async = result.seams.filter(s => s.modality === 'async');
    // producer (message exit) + consumer (message entry)
    expect(async.some(s => s.evidence.includes('exit_msg_1'))).toBe(true);
    expect(async.some(s => s.evidence.includes('entry_msg_1'))).toBe(true);
  });

  it('classifies a shared entity written by one module and read by another as PASSIVE', () => {
    const passive = result.seams.filter(s => s.modality === 'passive');
    expect(passive).toHaveLength(1);
    expect(passive[0].source).toBe('checkout');
    expect(passive[0].target).toBe('reporting');
    expect(passive[0].shared_resource).toBe('Order');
  });

  it('does NOT emit a passive seam for an entity a single module both writes and reads (false-positive guard)', () => {
    const passive = result.seams.filter(s => s.modality === 'passive');
    expect(passive.some(s => s.shared_resource === 'Cart')).toBe(false);
  });

  it('produces a system-level inventory with sync/async/passive counts', () => {
    const c = result.inventory.counts;
    expect(c.sync).toBeGreaterThanOrEqual(1);
    expect(c.async).toBeGreaterThanOrEqual(2);
    expect(c.passive).toBe(1);
    expect(c.total).toBe(result.seams.length);
    expect(result.inventory.component_seams.length).toBeGreaterThan(0);
  });

  it('ignores tier-2 server-entry (per-route) deployables when naming components', () => {
    // A route-named server-entry deployable rooted at a sub-dir must NOT become a
    // component name — files fall back to the module root instead.
    const routeDeployables: DeployableEvidence[] = [
      { root_path: 'apps/checkout/src/pay', name: 'POST /pay/charge', tier: 2, kind: 'server-entry', evidence: [] },
    ];
    const r = classifyCommunicationSeams({
      nodes: [node('fn_charge', 'apps/checkout/src/pay/payment.service.ts')],
      exit_points: [apiExit('fn_charge', 'apps/checkout/src/pay/payment.service.ts')],
      entry_points: [],
      data_lineage: [],
      data_entities: [],
      deployable_evidence: routeDeployables,
    });
    const sync = r.seams.find(s => s.modality === 'sync')!;
    expect(sync.source).not.toBe('POST /pay/charge');
    expect(sync.source).toBe('apps/checkout'); // clean module root, not the route label
  });

  it('rolls up to a deployable-level inventory when deployables exist', () => {
    expect(result.deployable_inventory).toBeDefined();
    const checkoutToReporting = result.deployable_inventory!.component_seams.find(
      e => e.source === 'checkout' && e.target === 'reporting',
    );
    expect(checkoutToReporting).toBeDefined();
    expect(checkoutToReporting!.passive).toBe(1);
    expect(checkoutToReporting!.modalities).toContain('passive');
  });
});
