import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as path from 'path';
import { analyzeForBench } from './product-analysis';

const ROOT = path.resolve(__dirname, '../../fixtures/orm-bench');

// The defect this gates, from an audit of three production analyses: relations
// existed only as PROSE in `database_schema.relationships_summary` and never
// reached the entity itself, so `data_entities[].relations` was empty on every
// persisted entity and the FK properties were reported as plain scalar fields.
// orm-bench already proves the summary is right; this proves the relation lands
// ON the entity, with cardinality and citable evidence, through the real product
// path (analyzeForBench is a blackbox client — it never imports the engine).

const ECOSYSTEM_EXPECTATIONS: Record<string, { cardinality: string; target: string }> = {
  // decorator ORM (TS)
  'mikroorm-rel': { cardinality: 'N:1', target: 'User' },
  // attribute ORM (PHP)
  'doctrine-rel': { cardinality: 'N:1', target: 'User' },
  // decorator ORM (TS, second dialect)
  'typeorm-rel': { cardinality: 'N:1', target: 'User' },
  // Python
  'sqlalchemy-rel': { cardinality: 'N:1', target: 'User' },
  // Ruby
  'activerecord-rel': { cardinality: 'N:1', target: 'User' },
};

for (const [fixture, expected] of Object.entries(ECOSYSTEM_EXPECTATIONS)) {
  const dir = path.join(ROOT, fixture);
  if (!fs.existsSync(dir)) continue;

  test(`entity relations persist on the entity for ${fixture}`, async () => {
    const cas: any = await analyzeForBench(dir);
    const entities: any[] = cas.data_entities || [];
    assert.ok(entities.length > 0, 'entities were extracted');

    // Every relation on every entity must be evidence-cited and kind-tagged.
    for (const entity of entities) {
      for (const relation of entity.relations || []) {
        assert.ok(relation.evidence, `${entity.name}.${relation.field} cites its evidence`);
        assert.ok(
          ['orm-edge', 'orm-declaration', 'typed-composition', 'structural-edge'].includes(relation.evidence_source),
          `${entity.name} relation names a known evidence source, got ${relation.evidence_source}`,
        );
        assert.ok(['data', 'structural'].includes(relation.kind), 'every relation is kind-tagged');
      }
    }

    const owning = entities.find(entity =>
      (entity.relations || []).some((relation: any) => relation.kind === 'data'));
    assert.ok(owning, `${fixture}: at least one entity carries a DATA relation`);

    const many = entities
      .flatMap((entity: any) => entity.relations || [])
      .find((relation: any) => relation.kind === 'data' && relation.cardinality === expected.cardinality);
    assert.ok(
      many,
      `${fixture}: the owning side is recorded as ${expected.cardinality}, got ${JSON.stringify(
        entities.map((e: any) => (e.relations || []).map((r: any) => `${r.relation_type}/${r.cardinality}`)),
      )}`,
    );
    assert.equal(many.target_name, expected.target);

    // ONE relation per (entity, field): two carriers reading the same field
    // (a decorator's N:1 and a typed-composition 1:1) must not both land.
    for (const entity of entities) {
      const fields = (entity.relations || [])
        .filter((relation: any) => relation.kind === 'data' && relation.field)
        .map((relation: any) => relation.field);
      assert.equal(new Set(fields).size, fields.length,
        `${entity.name}: one data relation per field, got ${JSON.stringify(fields)}`);
    }
  });
}
