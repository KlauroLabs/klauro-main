import assert from 'node:assert/strict';
import test from 'node:test';
import type { CASDatabaseEntity } from '../../types/cas.types';
import {
  databaseFieldsFromAttributes,
  normalizeDatabaseEntities,
  type DatabaseEntityEvidence,
} from './database-schema-normalization';

function evidence(
  entity: Partial<CASDatabaseEntity> & Pick<CASDatabaseEntity, 'name'>,
  sourceKind: DatabaseEntityEvidence['sourceKind'],
): DatabaseEntityEvidence {
  return {
    sourceKind,
    entity: {
      fields: [],
      relationships: [],
      ...entity,
    },
  };
}

test('merges repeated analyzer contributions from the same logical model', () => {
  const entities = normalizeDatabaseEntities([
    evidence({ name: 'Visit', source_file: 'src/Visit.java' }, 'model'),
    evidence({
      name: 'Visit',
      source_file: 'src/Visit.java',
      fields: [
        { name: 'id', type: 'Integer' },
        { name: 'id', type: 'Integer' },
        { name: 'petId', type: 'int' },
      ],
    }, 'model'),
  ]);

  assert.equal(entities.length, 1);
  assert.deepEqual(entities[0].fields.map(field => field.name), ['id', 'petId']);
});

test('joins one logical model to dialect-specific definitions of the same table', () => {
  const entities = normalizeDatabaseEntities([
    evidence({
      name: 'Visit',
      source_file: 'src/Visit.java',
      fields: [
        { name: 'id', type: 'Integer' },
        { name: 'date', type: 'Date', column: 'visit_date' },
      ],
    }, 'model'),
    evidence({
      name: 'Visit',
      table: 'visits',
      source_file: 'db/hsqldb/schema.sql',
      fields: [
        { name: 'id', type: 'INTEGER', primary: true },
        { name: 'visit_date', type: 'DATE', nullable: false },
      ],
    }, 'ddl'),
    evidence({
      name: 'Visit',
      table: 'visits',
      source_file: 'db/mysql/schema.sql',
      fields: [{ name: 'id', type: 'INT', primary: true }],
    }, 'ddl'),
  ]);

  assert.equal(entities.length, 1);
  assert.equal(entities[0].name, 'Visit');
  assert.equal(entities[0].table, 'visits');
  assert.equal(entities[0].source_file, 'src/Visit.java');
  assert.deepEqual(entities[0].source_files, [
    'src/Visit.java',
    'db/hsqldb/schema.sql',
    'db/mysql/schema.sql',
  ]);
  assert.deepEqual(entities[0].fields, [{
    name: 'id',
    type: 'Integer',
    primary: true,
    type_variants: ['Integer', 'INTEGER', 'INT'],
  }, {
    name: 'date',
    type: 'Date',
    nullable: false,
    column: 'visit_date',
    type_variants: ['Date', 'DATE'],
  }]);
});

test('keeps same-named models separate when persistence evidence is ambiguous', () => {
  const entities = normalizeDatabaseEntities([
    evidence({ name: 'Session', source_file: 'billing/Session.java' }, 'model'),
    evidence({ name: 'Session', source_file: 'identity/Session.java' }, 'model'),
    evidence({ name: 'Session', table: 'sessions', source_file: 'db/schema.sql' }, 'ddl'),
  ]);

  assert.equal(entities.length, 3);
});

test('extracts analyzer-provided fields and columns without fabricating absent attributes', () => {
  assert.deepEqual(databaseFieldsFromAttributes({
    columns: [
      { name: 'id', type: 'BIGINT', primary_key: true, nullable: false },
      { name: 'description', type: 'VARCHAR(8192)', nullable: true },
    ],
  }), [
    { name: 'id', type: 'BIGINT', primary: true, nullable: false },
    { name: 'description', type: 'VARCHAR(8192)', nullable: true },
  ]);
});
