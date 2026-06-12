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
      { boundary: 'POST /payments', guarded: true, guard_kinds: ['authentication'] },
    ]);
  });

  it('links carrying journeys and scores exposure from unguarded paths and external transfer', () => {
    expect(payment.journeys_carrying).toEqual([
      'journey_entry_create_payment',
      'journey_entry_list_reports',
    ]);
    expect(payment.exposure).toEqual({
      unguarded_paths: 1,
      non_auth_guarded_paths: 0,
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
      non_auth_guarded_paths: 0,
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

describe('buildDataLineage auth-aware exposure', () => {
  function journeyWithBoundaries(
    id: string,
    boundaries: Array<{ name: string; mechanism: string; kind?: 'authentication' | 'authorization' | 'rate-limiting' | 'validation' | 'unknown' }>,
    path: string,
  ): CASUserJourney {
    return {
      id,
      name: `${id} -> Payment created`,
      journey_kind: 'user-facing',
      entry_point_id: `entry_${id}`,
      entry: { type: 'http', name: `POST ${path}`, method: 'POST', path_or_trigger: path },
      steps: [],
      terminal_effects: { entities_written: ['Payment'], entities_read: [], external_services: [], messages_emitted: [] },
      terminal_entities: [
        { entity_id: 'entity_payment', name: 'Payment', access: 'created', terminal_kind: 'entity' },
      ],
      security_boundaries: boundaries,
      tests_covering: [],
      criticality: 'high',
      call_chain_ids: [],
      exit_point_ids: [],
    };
  }

  function lineageFor(testJourneys: CASUserJourney[]) {
    const lineage = buildDataLineage({
      nodes,
      edges,
      dataEntities: [paymentEntity],
      exitPoints: [],
      entryPoints,
      userJourneys: testJourneys,
    });
    return lineage.find(item => item.entity_id === 'entity_payment')!;
  }

  it('treats a throttle-only path as exposed, counted as non-auth guarded', () => {
    const result = lineageFor([
      journeyWithBoundaries('journey_throttled', [{ name: 'ThrottlerGuard', mechanism: 'entry-guard', kind: 'rate-limiting' }], '/throttled'),
    ]);
    expect(result.exposure.unguarded_paths).toBe(1);
    expect(result.exposure.non_auth_guarded_paths).toBe(1);
    expect(result.boundaries_crossed).toEqual([
      { boundary: 'POST /throttled', guarded: false, guard_kinds: ['rate-limiting'] },
    ]);
  });

  it('treats an authentication-guarded path as protected', () => {
    const result = lineageFor([
      journeyWithBoundaries('journey_auth', [{ name: 'GlobalAuthGuard', mechanism: 'entry-guard', kind: 'authentication' }], '/auth'),
    ]);
    expect(result.exposure.unguarded_paths).toBe(0);
    expect(result.exposure.non_auth_guarded_paths).toBe(0);
    expect(result.boundaries_crossed).toEqual([
      { boundary: 'POST /auth', guarded: true, guard_kinds: ['authentication'] },
    ]);
  });

  it('treats an authorization-guarded path as protected', () => {
    const result = lineageFor([
      journeyWithBoundaries('journey_authz', [{ name: 'OrganizationGuard', mechanism: 'entry-guard', kind: 'authorization' }], '/authz'),
    ]);
    expect(result.exposure.unguarded_paths).toBe(0);
    expect(result.exposure.non_auth_guarded_paths).toBe(0);
  });

  it('treats a mixed throttle plus auth path as protected', () => {
    const result = lineageFor([
      journeyWithBoundaries('journey_mixed', [
        { name: 'ThrottlerGuard', mechanism: 'entry-guard', kind: 'rate-limiting' },
        { name: 'ApiKeyGuard', mechanism: 'entry-guard', kind: 'authentication' },
      ], '/mixed'),
    ]);
    expect(result.exposure.unguarded_paths).toBe(0);
    expect(result.exposure.non_auth_guarded_paths).toBe(0);
    expect(result.boundaries_crossed).toEqual([
      { boundary: 'POST /mixed', guarded: true, guard_kinds: ['authentication', 'rate-limiting'] },
    ]);
  });

  it('falls back to name-based classification when a stored boundary has no kind', () => {
    const result = lineageFor([
      journeyWithBoundaries('journey_legacy_throttle', [{ name: 'ThrottlerGuard', mechanism: 'entry-guard' }], '/legacy-throttle'),
      journeyWithBoundaries('journey_legacy_auth', [{ name: 'JwtAuthGuard', mechanism: 'entry-guard' }], '/legacy-auth'),
    ]);
    expect(result.exposure.unguarded_paths).toBe(1);
    expect(result.exposure.non_auth_guarded_paths).toBe(1);
    expect(result.boundaries_crossed).toEqual([
      { boundary: 'POST /legacy-auth', guarded: true, guard_kinds: ['authentication'] },
      { boundary: 'POST /legacy-throttle', guarded: false, guard_kinds: ['rate-limiting'] },
    ]);
  });

  it('prefers a stored kind over the boundary name', () => {
    const result = lineageFor([
      journeyWithBoundaries('journey_stored_kind', [{ name: 'AuthGuard', mechanism: 'entry-guard', kind: 'rate-limiting' }], '/stored-kind'),
    ]);
    expect(result.exposure.unguarded_paths).toBe(1);
    expect(result.exposure.non_auth_guarded_paths).toBe(1);
  });
});

describe('buildDataLineage language-builtin exit filtering', () => {
  const arrayFilterExit: CASExitPoint = {
    id: 'exit_array_filter',
    source_node: 'n_payments_service_create',
    type: 'sdk',
    name: 'External call: array_filter',
  } as CASExitPoint;
  const issetExit: CASExitPoint = {
    id: 'exit_isset',
    source_node: 'n_payments_service_create',
    type: 'sdk',
    name: 'External call: isset',
  } as CASExitPoint;
  const ioExit: CASExitPoint = {
    id: 'exit_io',
    source_node: 'n_payments_service_create',
    type: 'sdk',
    name: 'io',
    target: { sdk: 'io' },
  } as CASExitPoint;
  const mathAbsExit: CASExitPoint = {
    id: 'exit_math_abs',
    source_node: 'n_payments_service_create',
    type: 'sdk',
    name: 'External call: Math::abs',
  } as CASExitPoint;

  const lineage = buildDataLineage({
    nodes,
    edges,
    dataEntities: [paymentEntity],
    exitPoints: [stripeExit, arrayFilterExit, issetExit, ioExit, mathAbsExit],
    entryPoints,
    userJourneys: journeys,
  });
  const payment = lineage.find(item => item.entity_id === 'entity_payment')!;

  it('excludes stdlib/builtin calls from external recipients', () => {
    const services = payment.external_recipients.map(recipient => recipient.service);
    expect(services).toEqual(['stripe']);
  });

  it('keeps external transfer exposure from genuine external services only', () => {
    expect(payment.exposure.external_transfer).toBe(true);
  });
});
