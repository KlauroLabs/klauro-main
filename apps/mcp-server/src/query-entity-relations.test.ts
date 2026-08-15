import test from 'node:test';
import assert from 'node:assert/strict';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { getDataEntities } from './query';

// ---------------------------------------------------------------------------
// The defect these lock, measured live across three production analyses: 3
// relation records across 169 entities, all three the same useless shape —
// entity -> UI page component, `implements`. Zero data relations, so no ERD and
// no blast radius. The foreign keys were sitting unread: a persisted entity's
// relation-declaring properties were rendered as plain scalar fields.
//
// Guarantees asserted here, on the get_data_entities surface an agent actually
// calls:
//   1. DATA relations (ORM associations + typed composition) populate
//      `relations`, with direction, cardinality, and citable evidence.
//   2. STRUCTURAL edges (implements / uses_trait) go to
//      `structural_relations` — they may never be the content of `relations`.
//   3. A field that IS a relation is flagged `is_relation`, not reported as a
//      plain scalar column, and the column itself stays visible.
//   4. An entity-shaped field NAME with no type or declaration evidence yields
//      NOTHING.
// ---------------------------------------------------------------------------

function lifecycle() {
  return { created_by: [], read_by: [], updated_by: [], deleted_by: [] };
}

test('get_data_entities: persisted ORM relations populate relations with cardinality and evidence', () => {
  const cas = {
    nodes: [],
    edges: [],
    entities: [
      {
        id: 'de_analysisrun',
        name: 'AnalysisRun',
        kind: 'persisted-entity',
        fields: [
          { name: 'codebase', type: 'Codebase', is_sensitive: false },
          { name: 'triggeredBy', type: 'User', is_sensitive: false },
          { name: 'branch', type: 'string', is_sensitive: false },
        ],
        relations: [
          {
            target_name: 'Codebase', relation_type: 'ManyToOne', kind: 'data', cardinality: 'N:1',
            field: 'codebase', evidence_source: 'orm-declaration',
            evidence: 'ORM relation ManyToOne declared on AnalysisRun.codebase',
          },
          {
            target_name: 'User', relation_type: 'ManyToOne', kind: 'data', cardinality: 'N:1',
            field: 'triggeredBy', evidence_source: 'orm-declaration',
            evidence: 'ORM relation ManyToOne declared on AnalysisRun.triggeredBy',
          },
        ],
        lifecycle: lifecycle(),
      },
      { id: 'de_codebase', name: 'Codebase', fields: [], lifecycle: lifecycle() },
      { id: 'de_user', name: 'User', fields: [], lifecycle: lifecycle() },
    ],
  } as unknown as CASOutput;

  const result: any = getDataEntities(cas, { entityName: 'AnalysisRun' });
  const run = result.entities[0];
  assert.equal(run.relation_count, 2);
  assert.equal(run.structural_relation_count, 0);
  const byField = new Map<string, any>(run.relations.map((r: any) => [r.field, r]));
  assert.equal(byField.get('codebase').targetName, 'Codebase');
  assert.equal(byField.get('codebase').cardinality, 'N:1');
  assert.equal(byField.get('codebase').kind, 'data');
  assert.match(byField.get('codebase').evidence, /ManyToOne/);

  // The FK columns stay listed, but flagged — not silently scalar.
  const fields = new Map<string, any>(run.fields.map((f: any) => [f.name, f]));
  assert.equal(fields.get('codebase').is_relation, true);
  assert.equal(fields.get('triggeredBy').is_relation, true);
  assert.ok(!fields.get('branch').is_relation, 'a real scalar column is not flagged');
  assert.deepEqual([...run.relation_field_names].sort(), ['codebase', 'triggeredBy']);
});

test('get_data_entities: a UI implements edge lands in structural_relations, never in relations', () => {
  const cas = {
    nodes: [
      { id: 'e_codebase', name: 'Codebase', type: 'entity' },
      { id: 'comp_page', name: 'CodebasePage', type: 'component' },
      { id: 'e_project', name: 'Project', type: 'entity' },
    ],
    edges: [
      { id: 'x1', source: 'e_codebase', target: 'comp_page', type: 'implements' },
      {
        id: 'x2', source: 'e_codebase', target: 'e_project', type: 'references',
        metadata: { attributes: { relationType: 'ManyToOne', field: 'project' } },
      },
    ],
    entities: [
      { id: 'de_codebase', name: 'Codebase', fields: [], lifecycle: lifecycle() },
      { id: 'de_project', name: 'Project', fields: [], lifecycle: lifecycle() },
    ],
  } as unknown as CASOutput;

  const result: any = getDataEntities(cas, { entityName: 'Codebase' });
  const codebase = result.entities[0];
  assert.equal(codebase.relations.length, 1);
  assert.equal(codebase.relations[0].targetName, 'Project');
  assert.equal(codebase.relations[0].kind, 'data');
  assert.equal(codebase.structural_relations.length, 1);
  assert.equal(codebase.structural_relations[0].targetName, 'CodebasePage');
  assert.equal(codebase.structural_relations[0].kind, 'structural');
});

test('get_data_entities: a field typed as another entity yields a composition relation', () => {
  const cas = {
    nodes: [],
    edges: [],
    entities: [
      {
        id: 'de_pzc', name: 'EncryptedPacketZeroCopy',
        fields: [
          { name: 'header', type: 'EncryptedPacketHeader', is_sensitive: false },
          { name: 'buf', type: '[u8]', is_sensitive: false },
        ],
        lifecycle: lifecycle(),
      },
      {
        id: 'de_hdr', name: 'EncryptedPacketHeader',
        fields: [{ name: 'nonce', type: '[u8; 12]', is_sensitive: false }],
        lifecycle: lifecycle(),
      },
    ],
  } as unknown as CASOutput;

  const result: any = getDataEntities(cas, { entityName: 'EncryptedPacketZeroCopy' });
  const packet = result.entities[0];
  assert.equal(packet.relations.length, 1);
  assert.equal(packet.relations[0].targetName, 'EncryptedPacketHeader');
  assert.equal(packet.relations[0].relationType, 'composition');
  assert.equal(packet.relations[0].cardinality, '1:1');
  assert.equal(packet.relations[0].evidenceSource, 'typed-composition');
  assert.equal(new Map<string, any>(packet.fields.map((f: any) => [f.name, f])).get('header').is_relation, true);
});

test('get_data_entities: an entity-shaped field NAME alone produces no relation', () => {
  const cas = {
    nodes: [],
    edges: [],
    entities: [
      {
        id: 'de_ar', name: 'AnalysisResult',
        fields: [
          { name: 'project', type: 'string', is_sensitive: false },
          { name: 'projectId', type: 'number', is_sensitive: false },
        ],
        lifecycle: lifecycle(),
      },
      { id: 'de_project', name: 'Project', fields: [], lifecycle: lifecycle() },
    ],
  } as unknown as CASOutput;

  const result: any = getDataEntities(cas, { entityName: 'AnalysisResult' });
  const record = result.entities[0];
  assert.equal(record.relation_count, 0);
  assert.equal(record.structural_relation_count, 0);
  assert.deepEqual(record.relation_field_names, []);
  assert.ok(record.fields.every((f: any) => !f.is_relation));
});
