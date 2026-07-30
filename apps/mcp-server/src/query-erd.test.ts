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

// ---------------------------------------------------------------------------
// The defect these lock: the ERD only ever read `database_schema.entities[]
// .relationships`, so an ORM whose analyzer models relations as EDGES rendered
// a set of disconnected boxes (its associations lived in the string-only
// `relationships_summary`), and a typed-composition data model rendered no
// edges at all. Relations from the shared extractor are now merged in, which
// also means an analysis stored BEFORE relations were persisted still renders.
// ---------------------------------------------------------------------------

test('buildErd renders relations an ORM emitted as EDGES, not property decorators', () => {
  const cas = {
    database_schema: {
      orm: 'Doctrine',
      entities: [
        { name: 'Booking', fields: [{ name: 'id', type: 'int', primary: true }], relationships: [] },
        { name: 'Company', fields: [{ name: 'id', type: 'int', primary: true }], relationships: [] },
      ],
      relationships_summary: ['Booking N:1 Company (via company)'],
    },
    nodes: [
      { id: 'e_booking', name: 'Booking', type: 'entity' },
      { id: 'e_company', name: 'Company', type: 'entity' },
    ],
    edges: [{
      id: 'rel_1',
      source: 'e_booking',
      target: 'e_company',
      type: 'references',
      metadata: { attributes: { relationType: 'ManyToOne', field: 'company' } },
    }],
    data_entities: [
      { id: 'de_booking', name: 'Booking', fields: [], lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } },
      { id: 'de_company', name: 'Company', fields: [], lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } },
    ],
  } as unknown as CASOutput;

  const model = buildErd(cas);
  const edge = model.relationships.find(r => r.from === 'Booking' && r.to === 'Company');
  assert.ok(edge, 'edge-declared relation reaches the ERD');
  assert.equal(edge!.cardinality, 'many-to-one');
  assert.equal(edge!.field, 'company');
  assert.equal(model.cardinality_breakdown['many-to-one'], 1);
  assert.match(erdToMermaid(model), /Booking \}o--\|\| Company/);
});

test('buildErd renders typed-composition relations and never invents one from a field NAME', () => {
  const cas = {
    database_schema: {
      entities: [
        {
          name: 'PacketZeroCopy',
          fields: [{ name: 'header', type: 'PacketHeader' }, { name: 'buf', type: '[u8]' }],
          relationships: [],
        },
        { name: 'PacketHeader', fields: [{ name: 'nonce', type: '[u8; 12]' }], relationships: [] },
        // `header` here is a plain string — an entity-shaped NAME with no type
        // evidence, which must produce NO edge.
        { name: 'Envelope', fields: [{ name: 'header', type: 'String' }], relationships: [] },
      ],
      relationships_summary: [],
    },
    nodes: [],
    edges: [],
    data_entities: [
      {
        id: 'de_pzc', name: 'PacketZeroCopy',
        fields: [
          { name: 'header', type: 'PacketHeader', is_sensitive: false },
          { name: 'buf', type: '[u8]', is_sensitive: false },
        ],
        lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] },
      },
      {
        id: 'de_ph', name: 'PacketHeader',
        fields: [{ name: 'nonce', type: '[u8; 12]', is_sensitive: false }],
        lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] },
      },
      {
        id: 'de_env', name: 'Envelope',
        fields: [{ name: 'header', type: 'String', is_sensitive: false }],
        lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] },
      },
    ],
  } as unknown as CASOutput;

  const model = buildErd(cas);
  assert.equal(model.relationships.length, 1);
  assert.equal(model.relationships[0].from, 'PacketZeroCopy');
  assert.equal(model.relationships[0].to, 'PacketHeader');
  assert.equal(model.relationships[0].cardinality, 'one-to-one');
  assert.match(model.relationships[0].evidence, /typed `PacketHeader`/);
  // The composed field is labelled fk in the diagram, not a bare scalar.
  const pzc = model.entities.find(e => e.name === 'PacketZeroCopy')!;
  assert.ok(pzc.fields.find(f => f.name === 'header')!.fk);
  assert.ok(erdToMermaid(model).includes('PacketZeroCopy ||--|| PacketHeader'));
});

test('buildErd draws ONE edge per relation field even when two carriers read it differently', () => {
  // The decorator carrier (via database_schema) proves `AnalysisRun.codebase`
  // is `ManyToOne`; the typed-composition carrier reads the same field as a
  // `1:1` composition because its declared type IS `Codebase`. One field, one
  // relation — drawing both would render every association twice.
  const cas = {
    database_schema: {
      orm: 'MikroORM',
      entities: [
        {
          name: 'AnalysisRun',
          fields: [{ name: 'codebase', type: 'Codebase' }],
          relationships: [{ type: 'ManyToOne', target: 'Codebase', field: 'codebase' }],
        },
        { name: 'Codebase', fields: [{ name: 'id', type: 'number', primary: true }], relationships: [] },
      ],
      relationships_summary: [],
    },
    nodes: [],
    edges: [],
    data_entities: [
      {
        id: 'de_run', name: 'AnalysisRun',
        fields: [{ name: 'codebase', type: 'Codebase', is_sensitive: false }],
        lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] },
      },
      { id: 'de_cb', name: 'Codebase', fields: [], lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } },
    ],
  } as unknown as CASOutput;

  const model = buildErd(cas);
  const edges = model.relationships.filter(r => r.from === 'AnalysisRun' && r.to === 'Codebase');
  assert.equal(edges.length, 1);
  assert.equal(edges[0].cardinality, 'many-to-one', 'the stronger declared cardinality wins');
  assert.equal(model.cardinality_breakdown['one-to-one'], 0);
});

test('a non-persisted shape is excluded from the ERD, and its edges go with it', () => {
  // REGRESSION: a UI viewer's own geometry types reached the ERD with
  // impeccably-extracted edges between them (a layout composing its node and
  // edge shapes 1:N). The relations were right; the BOXES were wrong. `kind`
  // now carries the verdict, and the ERD reads it: a shape explicitly
  // classified non-persisted draws no table, so its relationships cannot draw
  // either. A shape with NO kind at all is untouched — absence is not evidence.
  const cas = {
    database_schema: {
      entities: [
        { name: 'ErdLayout', fields: [{ name: 'nodes', type: 'ErdNode[]' }], relationships: [] },
        { name: 'ErdNode', fields: [{ name: 'width', type: 'number' }], relationships: [] },
        { name: 'Codebase', table: 'codebases', fields: [{ name: 'id', type: 'number', primary: true }], relationships: [] },
        { name: 'Unclassified', fields: [{ name: 'id', type: 'number', primary: true }], relationships: [] },
      ],
      relationships_summary: [],
    },
    nodes: [],
    edges: [],
    data_entities: [
      {
        id: 'de_layout', name: 'ErdLayout', kind: 'domain-shape', kind_source: 'shape-inference',
        fields: [{ name: 'nodes', type: 'ErdNode[]', is_sensitive: false }],
        lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] },
        relations: [{
          target_name: 'ErdNode', relation_type: 'composes_many', kind: 'data', cardinality: '1:N',
          field: 'nodes', evidence_source: 'typed-composition',
          evidence: 'field ErdLayout.nodes is typed `ErdNode[]`',
        }],
      },
      {
        id: 'de_node', name: 'ErdNode', kind: 'domain-shape', kind_source: 'shape-inference',
        fields: [{ name: 'width', type: 'number', is_sensitive: false }],
        lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] },
      },
      {
        id: 'de_codebase', name: 'Codebase', kind: 'persisted-entity', kind_source: 'framework-evidence',
        kind_evidence: 'analyzer subcategory `orm-entity` on Codebase',
        fields: [{ name: 'id', type: 'number', is_sensitive: false }],
        lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] },
      },
    ],
  } as unknown as CASOutput;

  const model = buildErd(cas);
  const names = model.entities.map(e => e.name);
  assert.deepEqual(names.sort(), ['Codebase', 'Unclassified']);
  assert.equal(model.relationships.length, 0);
  assert.equal(model.cardinality_breakdown['one-to-many'], 0);
});
