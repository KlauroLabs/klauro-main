import test from 'node:test';
import assert from 'node:assert/strict';
import type { CASOutput, CASDataEntity, CASDomainConcept, CASNode, CASEdge } from '../../../packages/analyzer-core/src/types/cas.types';
import {
  buildDomainConceptIndex,
  buildEntityRelationIndex,
  classifyEntityRole,
  classifyIntegrationSyncEntity,
  classifyFlowRole,
  roleFromName,
  isEntityFlowInfrastructureName,
  strongerRole,
} from './semantic-roles';
import { getDataEntities } from './query';

function concept(name: string, classification: CASDomainConcept['classification'], appearsIn: Partial<CASDomainConcept['appears_in']>): CASDomainConcept {
  return {
    id: `concept_${name}`,
    name,
    frequency: 10,
    classification,
    appears_in: { entry_points: [], entities: [], nodes: [], ...appearsIn },
  };
}

function entity(name: string, lifecycle?: Partial<CASDataEntity['lifecycle']>): CASDataEntity {
  return {
    id: `entity_${name.toLowerCase()}`,
    name,
    lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [], ...lifecycle },
  } as CASDataEntity;
}

// ---------------------------------------------------------------------------
// Name primitives (shared with the workspace item classifier)
// ---------------------------------------------------------------------------

test('roleFromName: business noun -> core, plumbing noun -> infrastructure, auth noun -> supporting', () => {
  assert.equal(roleFromName('Invoice').role, 'core');
  assert.equal(roleFromName('Client').role, 'core');
  assert.equal(roleFromName('schema migration').role, 'infrastructure');
  assert.equal(roleFromName('AuditLog').role, 'supporting'); // audit is a supporting concern per the role vocabulary
  assert.equal(roleFromName('request logging').role, 'infrastructure'); // logging plumbing
  assert.equal(roleFromName('Session').role, 'supporting');
  assert.equal(roleFromName('ApiKey').role, 'supporting');
});

test('isEntityFlowInfrastructureName catches migration/telemetry/health beyond the workspace gate', () => {
  assert.ok(isEntityFlowInfrastructureName('schema migration'));
  assert.ok(isEntityFlowInfrastructureName('telemetry span'));
  assert.ok(isEntityFlowInfrastructureName('healthcheck'));
  assert.ok(!isEntityFlowInfrastructureName('invoice'));
});

test('strongerRole picks the more-core of two judgements', () => {
  assert.equal(strongerRole('supporting', 'core'), 'core');
  assert.equal(strongerRole('infrastructure', 'supporting'), 'supporting');
  assert.equal(strongerRole(undefined, 'infrastructure'), 'infrastructure');
});

// ---------------------------------------------------------------------------
// Entity classification — domain-concept signal is authoritative
// ---------------------------------------------------------------------------

test('classifyEntityRole: domain-concept classification is authoritative', () => {
  const index = buildDomainConceptIndex([
    concept('Invoice', 'core', { entities: ['Invoice'] }),
    concept('AuditTrail', 'infrastructure', { entities: ['AuditLog'] }),
  ]);

  const invoice = classifyEntityRole(entity('Invoice', { created_by: ['n1'] }), index);
  assert.equal(invoice.role, 'core');
  assert.ok(invoice.role_evidence.some(e => /domain concept/i.test(e)));

  const audit = classifyEntityRole(entity('AuditLog', { read_by: ['n1', 'n2'] }), index);
  assert.equal(audit.role, 'infrastructure');
});

test('classifyEntityRole: no concept -> name + lifecycle fallback', () => {
  const index = buildDomainConceptIndex([]);
  // Migration table: infra by name.
  assert.equal(classifyEntityRole(entity('SchemaMigrations', { read_by: ['n1'] }), index).role, 'infrastructure');
  // Business noun with a single owning writer: core.
  assert.equal(classifyEntityRole(entity('Client', { created_by: ['svc'] }), index).role, 'core');
  // Read-only reference table, no product vocab: leans infrastructure plumbing.
  assert.equal(classifyEntityRole(entity('CountryLookup', { read_by: ['a', 'b'] }), index).role, 'infrastructure');
  // Ambiguous supporting noun (session): supporting.
  assert.equal(classifyEntityRole(entity('Session', { created_by: ['n1'] }), index).role, 'supporting');
});

// ---------------------------------------------------------------------------
// Entity classification — ConnectionBind-shaped integration-sync records
// ---------------------------------------------------------------------------

function entityNode(name: string): CASNode {
  return { id: `entity_doctrine_${name.toLowerCase()}`, name, type: 'entity', level: 3 } as CASNode;
}

function relationEdge(sourceId: string, targetId: string, relationType: string, field: string): CASEdge {
  return {
    id: `rel_${sourceId}_${field}`,
    source: sourceId,
    target: targetId,
    type: 'references',
    category: 'database',
    metadata: { attributes: { relationType, field } },
  } as unknown as CASEdge;
}

/** `implements`/`uses_trait` edge — no `relationType` metadata at all, the
 *  shape trait-composed relations actually arrive in (see
 *  STRUCTURAL_COMPOSITION_EDGE_TYPES in semantic-roles.ts). */
function structuralEdge(sourceId: string, targetId: string, type: 'implements' | 'uses_trait'): CASEdge {
  return {
    id: `${type}_${sourceId}_${targetId}`,
    source: sourceId,
    target: targetId,
    type,
  } as unknown as CASEdge;
}

test('classifyIntegrationSyncEntity: relation pairing a domain entity + a connection entity -> integration-sync', () => {
  const nodes = [entityNode('DeviceConnectionBind'), entityNode('Device'), entityNode('Connection')];
  const edges = [
    relationEdge('entity_doctrine_deviceconnectionbind', 'entity_doctrine_device', 'ManyToOne', 'entity'),
    relationEdge('entity_doctrine_deviceconnectionbind', 'entity_doctrine_connection', 'ManyToOne', 'connection'),
  ];
  const relations = buildEntityRelationIndex({ nodes, edges });
  const domainNames = new Set(['deviceconnectionbind', 'device', 'connection']);

  const result = classifyIntegrationSyncEntity('DeviceConnectionBind', relations, domainNames);
  assert.equal(result.isIntegrationSync, true);
  assert.ok(result.evidence.some(e => /domain entity "Device"/.test(e)));
  assert.ok(result.evidence.some(e => /connection\/integration entity "Connection"/.test(e)));
});

test('classifyIntegrationSyncEntity: trait/interface-composed connection relation (no ORM references edge to the hub at all) still demotes — real truckspyapp shape', () => {
  // Real truckspyapp shape (BookingConnectionBind and 15 siblings): the class
  // implements a *ConnectionBindInterface and uses a *ConnectionBindTrait —
  // the trait is what actually contributes the `connection` association —
  // but the Doctrine analyzer never re-emits that trait-contributed field as
  // its own `references` edge with relationType metadata. Only ONE ORM
  // `references` edge exists (to the real domain entity, Booking). Relying on
  // `references` edges alone (own.length < 2 gate) would always read this as
  // "single relation, not integration-sync" and leave every one of these 16
  // entities classified core. The `implements`/`uses_trait` edges — which the
  // analyzer DOES always emit — must be enough evidence on their own.
  const nodes = [
    entityNode('BookingConnectionBind'),
    entityNode('Booking'),
    { id: 'interface_connectionbindinterface', name: 'ConnectionBindInterface', type: 'interface', level: 3 } as CASNode,
    { id: 'trait_connectionbindtrait', name: 'ConnectionBindTrait', type: 'trait', level: 3 } as CASNode,
  ];
  const edges = [
    relationEdge('entity_doctrine_bookingconnectionbind', 'entity_doctrine_booking', 'ManyToOne', 'entity'),
    structuralEdge('entity_doctrine_bookingconnectionbind', 'interface_connectionbindinterface', 'implements'),
    structuralEdge('entity_doctrine_bookingconnectionbind', 'trait_connectionbindtrait', 'uses_trait'),
  ];
  const relations = buildEntityRelationIndex({ nodes, edges });
  const domainNames = new Set(['bookingconnectionbind', 'booking']);

  const result = classifyIntegrationSyncEntity('BookingConnectionBind', relations, domainNames);
  assert.equal(result.isIntegrationSync, true);
  assert.ok(result.evidence.some(e => /domain entity "Booking"/.test(e)));
  assert.ok(result.evidence.some(e => /connection\/integration entity "ConnectionBind(Interface|Trait)"/.test(e)));
});

test('classifyIntegrationSyncEntity: connection target identified by credential FIELD shape, not just name', () => {
  // Target entity is named "ExternalAccount" (no "connection"/"integration"
  // substring) but carries auth/token-shaped fields — structural corroboration
  // instead of a name match.
  const nodes = [entityNode('DriverExternalBind'), entityNode('Driver'), entityNode('ExternalAccount')];
  const edges = [
    relationEdge('entity_doctrine_driverexternalbind', 'entity_doctrine_driver', 'ManyToOne', 'entity'),
    relationEdge('entity_doctrine_driverexternalbind', 'entity_doctrine_externalaccount', 'ManyToOne', 'account'),
  ];
  const relations = buildEntityRelationIndex({ nodes, edges });
  const domainNames = new Set(['driverexternalbind', 'driver', 'externalaccount']);
  const fieldsByNameLower = new Map<string, CASDataEntity['fields']>([
    ['externalaccount', [{ name: 'authToken', type: 'string', is_sensitive: true }]],
  ]);

  const result = classifyIntegrationSyncEntity('DriverExternalBind', relations, domainNames, fieldsByNameLower);
  assert.equal(result.isIntegrationSync, true);
});

test('classifyIntegrationSyncEntity: a single relation (no pairing) is NOT integration-sync', () => {
  const nodes = [entityNode('Booking'), entityNode('Customer')];
  const edges = [relationEdge('entity_doctrine_booking', 'entity_doctrine_customer', 'ManyToOne', 'customer')];
  const relations = buildEntityRelationIndex({ nodes, edges });
  const domainNames = new Set(['booking', 'customer']);

  const result = classifyIntegrationSyncEntity('Booking', relations, domainNames);
  assert.equal(result.isIntegrationSync, false);
});

test('classifyIntegrationSyncEntity: two relations to plain domain entities (no connection pairing) stays false', () => {
  // A stem match alone (both targets are ordinary domain nouns) must not
  // trigger the integration-sync classification — neither target is a
  // connection/integration hub by name OR field shape.
  const nodes = [entityNode('Shipment'), entityNode('Vehicle'), entityNode('Driver')];
  const edges = [
    relationEdge('entity_doctrine_shipment', 'entity_doctrine_vehicle', 'ManyToOne', 'vehicle'),
    relationEdge('entity_doctrine_shipment', 'entity_doctrine_driver', 'ManyToOne', 'driver'),
  ];
  const relations = buildEntityRelationIndex({ nodes, edges });
  const domainNames = new Set(['shipment', 'vehicle', 'driver']);

  const result = classifyIntegrationSyncEntity('Shipment', relations, domainNames);
  assert.equal(result.isIntegrationSync, false);
});

test('classifyEntityRole: integration-sync relation evidence demotes a *ConnectionBind entity even though its lifecycle looks core (single-owner writer)', () => {
  const nodes = [entityNode('DeviceConnectionBind'), entityNode('Device'), entityNode('Connection')];
  const edges = [
    relationEdge('entity_doctrine_deviceconnectionbind', 'entity_doctrine_device', 'ManyToOne', 'entity'),
    relationEdge('entity_doctrine_deviceconnectionbind', 'entity_doctrine_connection', 'ManyToOne', 'connection'),
  ];
  const relations = buildEntityRelationIndex({ nodes, edges });
  const domainEntityNamesLower = new Set(['deviceconnectionbind', 'device', 'connection']);
  const index = buildDomainConceptIndex([]);

  // Single-owner writer would normally read as a core-entity lifecycle signal
  // (see semantic-roles.ts line ~261) — the relation-pairing evidence must
  // win regardless.
  const bind = entity('DeviceConnectionBind', { created_by: ['syncWorker'], updated_by: ['syncWorker'] });
  const result = classifyEntityRole(bind, index, { relations, domainEntityNamesLower });
  assert.equal(result.role, 'infrastructure');
  assert.ok(result.role_evidence.some(e => /integration-sync/.test(e)));
});

// ---------------------------------------------------------------------------
// Flow classification
// ---------------------------------------------------------------------------

test('classifyFlowRole: entry-point-anchored core concept, entity-anchored, name fallback', () => {
  const index = buildDomainConceptIndex([
    concept('Invoice', 'core', { entry_points: ['ep:createInvoice'], entities: ['Invoice'] }),
    concept('Health', 'infrastructure', { entry_points: ['ep:health'] }),
  ]);

  const invoiceFlow = classifyFlowRole({ name: 'Handle createInvoice', entry_point: 'ep:createInvoice', entities: ['Invoice'] }, index);
  assert.equal(invoiceFlow.role, 'core');

  // Concept-core entry point but an unambiguous infra name -> pulled down to infra.
  const healthFlow = classifyFlowRole({ name: 'GET /health', entry_point: 'ep:health' }, index);
  assert.equal(healthFlow.role, 'infrastructure');

  // No concept anchor -> name of touched entity drives it.
  const orderFlow = classifyFlowRole({ name: 'Handle POST /orders', entities: ['Order'] }, index);
  assert.equal(orderFlow.role, 'core');
});

// ---------------------------------------------------------------------------
// Query integration: role surfaced + filter + breakdown
// ---------------------------------------------------------------------------

function casWith(entities: CASDataEntity[], concepts: CASDomainConcept[]): CASOutput {
  return {
    cas_version: '1.11.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'analysis-role-test',
    system: { id: 'system-test', name: 'role-test', type: 'service', root_path: '/tmp/role' },
    nodes: [],
    edges: [],
    data_entities: entities,
    domain_concepts: concepts,
    analyzer_contributions: [],
  } as unknown as CASOutput;
}

test('getDataEntities surfaces role, role_evidence, role_breakdown and supports the role filter', () => {
  const cas = casWith(
    [
      entity('Invoice', { created_by: ['n1'] }),
      entity('Client', { created_by: ['n2'] }),
      entity('SchemaMigrations', { read_by: ['n3'] }),
    ],
    [
      concept('Invoice', 'core', { entities: ['Invoice'] }),
      concept('Client', 'core', { entities: ['Client'] }),
    ]
  );

  const all: any = getDataEntities(cas);
  const byName = new Map(all.entities.map((e: any) => [e.name, e]));
  assert.equal((byName.get('Invoice') as any).role, 'core');
  assert.equal((byName.get('SchemaMigrations') as any).role, 'infrastructure');
  assert.ok((byName.get('Invoice') as any).role_evidence.length > 0);
  assert.equal(all.role_breakdown.core, 2);
  assert.equal(all.role_breakdown.infrastructure, 1);

  const coreOnly: any = getDataEntities(cas, { role: 'core' });
  assert.equal(coreOnly.total, 2);
  assert.ok(coreOnly.entities.every((e: any) => e.role === 'core'));
});

test('getDataEntities: a *ConnectionBind entity (trait/interface-composed, no ORM references edge to the connection hub) reads infrastructure end-to-end, not core — the live /entities path', () => {
  // Reproduces the real truckspyapp CAS shape end to end: BookingConnectionBind
  // has product vocabulary in its name ("booking" -> productDomainSignal > 0)
  // so the name-fallback classifier alone would call it core, and the ORM
  // relation graph carries only one `references` edge (to the domain entity
  // Booking) — the second (to Connection) only exists as `implements`/
  // `uses_trait` structural edges. Before the semantic-roles.ts fix this
  // entity read role:"core" on the live /entities surface; the assertion
  // below is what GET /api/projects/{id}/entities actually serves.
  const cas = casWith(
    [
      entity('BookingConnectionBind', { created_by: ['method_createConnectionBind'] }),
      entity('Booking', { created_by: ['method_createBooking'], read_by: ['n1'] }),
    ],
    []
  );
  cas.nodes = [
    entityNode('BookingConnectionBind'),
    entityNode('Booking'),
    { id: 'interface_connectionbindinterface', name: 'ConnectionBindInterface', type: 'interface', level: 3 } as CASNode,
    { id: 'trait_connectionbindtrait', name: 'ConnectionBindTrait', type: 'trait', level: 3 } as CASNode,
  ];
  cas.edges = [
    relationEdge('entity_doctrine_bookingconnectionbind', 'entity_doctrine_booking', 'ManyToOne', 'entity'),
    structuralEdge('entity_doctrine_bookingconnectionbind', 'interface_connectionbindinterface', 'implements'),
    structuralEdge('entity_doctrine_bookingconnectionbind', 'trait_connectionbindtrait', 'uses_trait'),
  ];

  const result: any = getDataEntities(cas);
  const byName = new Map(result.entities.map((e: any) => [e.name, e]));
  assert.equal((byName.get('BookingConnectionBind') as any).role, 'infrastructure');
  assert.ok((byName.get('BookingConnectionBind') as any).role_evidence.some((e: string) => /integration-sync/.test(e)));
  // Booking itself is unaffected — it keeps its own (name-fallback) role.
  assert.notEqual((byName.get('Booking') as any).role, 'infrastructure');
});
