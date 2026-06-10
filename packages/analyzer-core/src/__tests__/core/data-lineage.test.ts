import { buildDataLineage } from '../../analyzer/core/data-lineage';
import {
  CASNode,
  CASEdge,
  CASEntryPoint,
  CASExitPoint,
  CASDataEntity,
  CASUserJourney
} from '../../types/cas.types';

function node(id: string, name: string, type: string, file: string): CASNode {
  return { id, name, type, source: { file } } as CASNode;
}

function edge(id: string, source: string, target: string, type: string): CASEdge {
  return { id, source, target, type };
}

const nodes: CASNode[] = [
  node('n_payment_entity', 'Payment', 'entity', 'src/payments/payment.entity.ts'),
  node('n_payments_service', 'PaymentsService', 'service', 'src/payments/payments.service.ts'),
  node('n_payments_service_create', 'createPayment', 'method', 'src/payments/payments.service.ts'),
  node('n_reports_controller', 'ReportsController', 'controller', 'src/reports/reports.controller.ts'),
  node('n_reports_controller_index', 'index', 'method', 'src/reports/reports.controller.ts'),
  node('n_audit_log_entity', 'AuditLog', 'entity', 'src/audit/audit-log.entity.ts'),
  node('n_audit_service', 'AuditService', 'service', 'src/audit/audit.service.ts'),
];

const edges: CASEdge[] = [
  edge('e_contains_create', 'n_payments_service', 'n_payments_service_create', 'has_method'),
  edge('e_contains_index', 'n_reports_controller', 'n_reports_controller_index', 'has_method'),
  edge('e_reads_payment', 'n_reports_controller_index', 'n_payment_entity', 'reads'),
];

const paymentEntity: CASDataEntity = {
  id: 'entity_payment',
  name: 'Payment',
  fields: [
    { name: 'card_number', type: 'string', is_sensitive: true },
    { name: 'amount', type: 'number', is_sensitive: false },
  ],
  lifecycle: {
    created_by: ['n_payments_service_create'],
    read_by: [],
    updated_by: [],
    deleted_by: [],
  },
};

const auditLogEntity: CASDataEntity = {
  id: 'entity_audit_log',
  name: 'AuditLog',
  fields: [{ name: 'message', type: 'string', is_sensitive: false }],
  lifecycle: {
    created_by: [],
    read_by: ['n_audit_service'],
    updated_by: [],
    deleted_by: [],
  },
};

const stripeExit: CASExitPoint = {
  id: 'exit_stripe_charge',
  source_node: 'n_payments_service_create',
  type: 'sdk',
  name: 'stripe.charges.create',
  target: { service_id: 'stripe', sdk: 'stripe' },
} as CASExitPoint;

const entryPoints: CASEntryPoint[] = [
  {
    id: 'entry_create_payment',
    source_node: 'n_payments_service',
    type: 'http',
    name: 'POST /payments',
    trigger: { method: 'POST', path: '/payments' },
    handler: { node_id: 'n_payments_service_create', method_name: 'createPayment' },
    security: { authenticated: true, guards: ['AuthGuard'] },
  } as CASEntryPoint,
  {
    id: 'entry_list_reports',
    source_node: 'n_reports_controller',
    type: 'http',
    name: 'GET /reports',
    trigger: { method: 'GET', path: '/reports' },
    handler: { node_id: 'n_reports_controller_index', method_name: 'index' },
  } as CASEntryPoint,
];

const journeys: CASUserJourney[] = [
  {
    id: 'journey_entry_create_payment',
    name: 'Create payment -> Payment created',
    journey_kind: 'user-facing',
    entry_point_id: 'entry_create_payment',
    entry: { type: 'http', name: 'POST /payments', method: 'POST', path_or_trigger: '/payments' },
    steps: [],
    terminal_effects: {
      entities_written: ['Payment'],
      entities_read: [],
      external_services: ['stripe'],
      messages_emitted: [],
    },
    terminal_entities: [
      { entity_id: 'entity_payment', name: 'Payment', access: 'created', terminal_kind: 'entity' },
    ],
    security_boundaries: [{ name: 'AuthGuard', mechanism: 'entry-guard' }],
    tests_covering: [],
    criticality: 'high',
    call_chain_ids: [],
    exit_point_ids: ['exit_stripe_charge'],
  },
  {
    id: 'journey_entry_list_reports',
    name: 'List reports -> Payment read',
    journey_kind: 'user-facing',
    entry_point_id: 'entry_list_reports',
    entry: { type: 'http', name: 'GET /reports', method: 'GET', path_or_trigger: '/reports' },
    steps: [],
    terminal_effects: {
      entities_written: [],
      entities_read: ['Payment'],
      external_services: [],
      messages_emitted: [],
    },
    terminal_entities: [
      { entity_id: 'entity_payment', name: 'Payment', access: 'read', terminal_kind: 'entity' },
    ],
    security_boundaries: [],
    tests_covering: [],
    criticality: 'medium',
    call_chain_ids: [],
    exit_point_ids: [],
  },
];

describe('buildDataLineage', () => {
  const lineage = buildDataLineage({
    nodes,
    edges,
    dataEntities: [auditLogEntity, paymentEntity],
    exitPoints: [stripeExit],
    entryPoints,
    userJourneys: journeys,
  });

  const payment = lineage.find(item => item.entity_id === 'entity_payment')!;
  const auditLog = lineage.find(item => item.entity_id === 'entity_audit_log')!;

  it('produces a lineage entry per data entity', () => {
    expect(lineage).toHaveLength(2);
    expect(payment).toBeDefined();
    expect(auditLog).toBeDefined();
  });

  it('ranks the sensitive externally transferred entity above the inert one', () => {
    expect(lineage[0].entity_id).toBe('entity_payment');
  });

  it('extracts sensitive field names', () => {
    expect(payment.sensitive_fields).toEqual(['card_number']);
    expect(auditLog.sensitive_fields).toEqual([]);
  });

  it('collects writers from entity lifecycle with file attribution', () => {
    expect(payment.writers).toHaveLength(1);
    expect(payment.writers[0]).toEqual({
      node_id: 'n_payments_service_create',
      file: 'src/payments/payments.service.ts',
      via: 'lifecycle:created',
    });
  });

  it('collects readers from read edges targeting the entity node', () => {
    expect(payment.readers).toHaveLength(1);
    expect(payment.readers[0]).toEqual({
      node_id: 'n_reports_controller_index',
      file: 'src/reports/reports.controller.ts',
      via: 'edge:reads',
    });
  });

  it('finds external recipients through exit points reachable from accessors and journeys', () => {
    expect(payment.external_recipients).toHaveLength(1);
    expect(payment.external_recipients[0]).toEqual({
      exit_point_id: 'exit_stripe_charge',
      service: 'stripe',
      via_node: 'n_payments_service_create',
    });
  });

  it('reports crossed boundaries with guard status per entry', () => {
    expect(payment.boundaries_crossed).toEqual([
      { boundary: 'GET /reports', guarded: false },
      { boundary: 'POST /payments', guarded: true },
    ]);
  });

  it('links carrying journeys and scores exposure from unguarded paths and external transfer', () => {
    expect(payment.journeys_carrying).toEqual([
      'journey_entry_create_payment',
      'journey_entry_list_reports',
    ]);
    expect(payment.exposure).toEqual({
      unguarded_paths: 1,
      external_transfer: true,
      sensitive: true,
    });
  });

  it('keeps the inert entity at low exposure', () => {
    expect(auditLog.writers).toHaveLength(0);
    expect(auditLog.readers).toHaveLength(1);
    expect(auditLog.readers[0].via).toBe('lifecycle:read');
    expect(auditLog.external_recipients).toHaveLength(0);
    expect(auditLog.boundaries_crossed).toHaveLength(0);
    expect(auditLog.journeys_carrying).toHaveLength(0);
    expect(auditLog.exposure).toEqual({
      unguarded_paths: 0,
      external_transfer: false,
      sensitive: false,
    });
  });

  it('returns an empty result when no entities exist', () => {
    expect(buildDataLineage({
      nodes,
      edges,
      dataEntities: [],
      exitPoints: [stripeExit],
      entryPoints,
      userJourneys: journeys,
    })).toEqual([]);
  });
});
