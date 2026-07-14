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
