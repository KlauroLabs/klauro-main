import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CASOutput, CASDatabaseSchema } from '../../../packages/analyzer-core/src/types/cas.types';
import { buildErd, erdToMermaid, getErd } from './query';

// buildErd reshapes cas.database_schema (already produced by the ORM analyzers +
// buildDatabaseSchema in the orchestrator) into a structured ERD + Mermaid. These
// tests feed a database_schema shaped exactly like buildDatabaseSchema emits, so
// they verify the reshape/rendering — never a re-extraction.

function casWithSchema(schema: CASDatabaseSchema): CASOutput {
  return { database_schema: schema } as unknown as CASOutput;
}

const userPostSchema: CASDatabaseSchema = {
  orm: 'MikroORM',
  entities: [
    {
      name: 'User',
      table: 'users',
      source_file: 'src/entities/User.ts',
      fields: [
        { name: 'id', type: 'number', primary: true },
        { name: 'email', type: 'string', unique: true },
        { name: 'bio', type: 'string', nullable: true },
      ],
      relationships: [
        { type: 'OneToMany', target: 'Post', field: 'posts' },
      ],
    },
    {
      name: 'Post',
      table: 'posts',
      source_file: 'src/entities/Post.ts',
      fields: [
        { name: 'id', type: 'number', primary: true },
        { name: 'title', type: 'string' },
        { name: 'authorId', type: 'number' },
        { name: 'userId', type: 'number' },
      ],
      relationships: [
        { type: 'ManyToOne', target: 'User', field: 'author' },
      ],
    },
  ],
  relationships_summary: [],
};

test('buildErd produces entities with PK/FK/constraint flags from the schema', () => {
  const model = buildErd(casWithSchema(userPostSchema));
  assert.equal(model.orm, 'MikroORM');
  assert.equal(model.entities.length, 2);

  const user = model.entities.find(e => e.name === 'User')!;
  assert.equal(user.table, 'users');
  assert.ok(user.fields.find(f => f.name === 'id')!.pk, 'id is PK');
  assert.ok(user.fields.find(f => f.name === 'email')!.unique, 'email unique');
  assert.ok(user.fields.find(f => f.name === 'bio')!.nullable, 'bio nullable');

  const post = model.entities.find(e => e.name === 'Post')!;
  // userId -> guessed target `User` IS a known entity -> labelled fk (heuristic aid only).
  assert.ok(post.fields.find(f => f.name === 'userId')!.fk, 'userId labelled fk (guessed target User is known)');
  // authorId -> guessed target `Author` is NOT a known entity -> NOT labelled fk
  // (evidence-gated: we never invent an fk just from an *_id suffix).
  assert.ok(!post.fields.find(f => f.name === 'authorId')!.fk, 'authorId not fk (Author not a known entity)');
});

test('buildErd emits evidence-gated relationships with correct direction + cardinality', () => {
  const model = buildErd(casWithSchema(userPostSchema));
  // Known FK relationship: User 1--N Post (via posts). Assert direction + cardinality.
  const oneToMany = model.relationships.find(r => r.from === 'User' && r.to === 'Post');
  assert.ok(oneToMany, 'User -> Post edge present');
  assert.equal(oneToMany!.cardinality, 'one-to-many');
  assert.equal(oneToMany!.field, 'posts');
  assert.match(oneToMany!.evidence, /OneToMany/);

  const manyToOne = model.relationships.find(r => r.from === 'Post' && r.to === 'User');
  assert.ok(manyToOne, 'Post -> User edge present');
  assert.equal(manyToOne!.cardinality, 'many-to-one');

  assert.equal(model.cardinality_breakdown['one-to-many'], 1);
  assert.equal(model.cardinality_breakdown['many-to-one'], 1);
});

test('buildErd labels unknown cardinality rather than guessing', () => {
  const schema: CASDatabaseSchema = {
    orm: 'Custom',
    entities: [
      { name: 'A', fields: [], relationships: [{ type: 'Weird' as any, target: 'B', field: 'bs' }] },
      { name: 'B', fields: [], relationships: [] },
    ],
    relationships_summary: [],
  };
  const model = buildErd(casWithSchema(schema));
  const edge = model.relationships.find(r => r.from === 'A' && r.to === 'B')!;
  assert.equal(edge.cardinality, 'unknown');
  assert.equal(model.cardinality_breakdown.unknown, 1);
});

test('erdToMermaid renders a valid erDiagram with fields and crow-foot edges', () => {
  const mermaid = erdToMermaid(buildErd(casWithSchema(userPostSchema)));
  assert.match(mermaid, /^erDiagram/);
  assert.match(mermaid, /User \{/);
  assert.match(mermaid, /number id PK/);
  assert.match(mermaid, /string email.*unique/);
  // one-to-many crow's foot from User to Post.
  assert.match(mermaid, /User \|\|--o\{ Post/);
});

test('empty / no-entity repo yields an empty ERD (no crash, no fabrication)', () => {
  const emptyModel = buildErd({ } as unknown as CASOutput);
  assert.deepEqual(emptyModel.entities, []);
  assert.deepEqual(emptyModel.relationships, []);
  assert.equal(emptyModel.cardinality_breakdown['one-to-many'], 0);

  const emptySchema = buildErd(casWithSchema({ entities: [], relationships_summary: [] }));
  assert.deepEqual(emptySchema.entities, []);

  // Mermaid of an empty model is still a valid (header-only) erDiagram.
  assert.equal(erdToMermaid(emptyModel), 'erDiagram');
});

test('entity filter returns a focused subgraph (entity + direct neighbours only)', () => {
  const schema: CASDatabaseSchema = {
    orm: 'Prisma',
    entities: [
      { name: 'User', fields: [{ name: 'id', type: 'int', primary: true }], relationships: [{ type: 'OneToMany', target: 'Post', field: 'posts' }] },
      { name: 'Post', fields: [{ name: 'id', type: 'int', primary: true }], relationships: [{ type: 'ManyToOne', target: 'User', field: 'author' }] },
      { name: 'Unrelated', fields: [{ name: 'id', type: 'int', primary: true }], relationships: [] },
    ],
    relationships_summary: [],
  };
  const model = buildErd(casWithSchema(schema), { entityName: 'User' });
  const names = model.entities.map(e => e.name).sort();
  assert.deepEqual(names, ['Post', 'User']); // Unrelated excluded.
  assert.ok(model.relationships.every(r => r.from === 'User' || r.to === 'User'));
});

test('cross-repo: entities appearing in >1 repo are annotated shared', () => {
  const model = buildErd(casWithSchema(userPostSchema), {
    workspace: {
      project_ids: ['repo-a', 'repo-b'],
      entities: [
        { name: 'User', project_ids: ['repo-a', 'repo-b'] },
        { name: 'Post', project_ids: ['repo-a'] },
      ],
    },
  });
  const user = model.entities.find(e => e.name === 'User')!;
  assert.ok(user.cross_repo, 'User marked cross_repo');
  assert.deepEqual(user.repos, ['repo-a', 'repo-b']);
  const post = model.entities.find(e => e.name === 'Post')!;
  assert.ok(!post.cross_repo, 'Post not cross_repo');
  assert.ok(model.cross_repo!.shared_entities.includes('user'));
});

test('getErd format switch: mermaid-only vs json-only vs both', () => {
  const cas = casWithSchema(userPostSchema);
  const both = getErd(cas) as any;
  assert.ok(both.mermaid && both.entities, 'both includes mermaid + model');

  const mermaidOnly = getErd(cas, { format: 'mermaid' }) as any;
  assert.ok(mermaidOnly.mermaid && !mermaidOnly.entities, 'mermaid-only');

  const jsonOnly = getErd(cas, { format: 'json' }) as any;
  assert.ok(jsonOnly.entities && !jsonOnly.mermaid, 'json-only');
});
