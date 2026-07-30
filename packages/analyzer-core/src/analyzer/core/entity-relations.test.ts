import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractEntityRelations,
  resolveDeclaredTypeShape,
  cardinalityForRelationType,
  parseRelationDeclaration,
} from './entity-relations';
import type { CASNode, CASEdge, CASDataEntity } from '../../types/cas.types';

// The defect these lock: entities were persisted with an EMPTY relation list
// even where the foreign-key evidence was sitting in plain sight — a decorator
// ORM's `@ManyToOne` property rendered as a scalar field, an attribute ORM's
// declared inverse side dropped, a struct field typed as another struct
// unrecorded — while the only thing that DID reach the relation field was an
// entity -> UI-component `implements` edge. Every case below asserts a relation
// is emitted ONLY with citable evidence, and that structural composition never
// stands in for the data model.

let nodeSeq = 0;

function entityNode(name: string, file: string): CASNode {
  return {
    id: `entity_${name}_${nodeSeq++}`,
    name,
    type: 'entity',
    subcategories: ['entity'],
    source: { file, line: 1 },
  };
}

function propertyNode(
  name: string,
  file: string,
  opts: { parent?: string; type?: string; annotations?: string[]; attributes?: Record<string, unknown> } = {},
): CASNode {
  return {
    id: `prop_${name}_${nodeSeq++}`,
    name,
    type: 'property',
    parent: opts.parent,
    source: { file, line: 2 },
    metadata: {
      ...(opts.type ? { type: opts.type } : {}),
      ...(opts.annotations ? { annotations: opts.annotations } : {}),
      ...(opts.attributes ? { attributes: opts.attributes } : {}),
    } as CASNode['metadata'],
  };
}

function dataEntity(name: string, fields: Array<{ name: string; type: string }>): CASDataEntity {
  return {
    id: `de_${name.toLowerCase()}`,
    name,
    fields: fields.map(f => ({ ...f, is_sensitive: false })),
    lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] },
  };
}

function relationsFor(graph: ReturnType<typeof extractEntityRelations>, name: string) {
  return graph.dataByEntityNameLower.get(name.toLowerCase()) || [];
}

// --- decorator ORMs (TS): a @ManyToOne yields ONE directed relation ----------

test('a decorator-ORM @ManyToOne yields one directed relation with cardinality', () => {
  const post = entityNode('Post', 'src/entities/post.entity.ts');
  const user = entityNode('User', 'src/entities/user.entity.ts');
  const graph = extractEntityRelations({
    nodes: [
      post,
      user,
      propertyNode('author', 'src/entities/post.entity.ts', {
        parent: post.id,
        type: 'Ref<User>',
        annotations: ['@ManyToOne(() => User, { nullable: true })'],
      }),
    ],
    dataEntities: [dataEntity('Post', [{ name: 'author', type: 'Ref<User>' }]), dataEntity('User', [])],
  });

  const relations = relationsFor(graph, 'Post');
  assert.equal(relations.length, 1);
  assert.equal(relations[0].targetName, 'User');
  assert.equal(relations[0].relationType, 'ManyToOne');
  assert.equal(relations[0].cardinality, 'N:1');
  assert.equal(relations[0].field, 'author');
  assert.equal(relations[0].kind, 'data');
  assert.equal(relations[0].evidenceSource, 'orm-declaration');
  assert.match(relations[0].evidence, /ManyToOne/);
  // The FK field is marked as a relation so it is not reported as a scalar.
  assert.ok(graph.relationFieldsByEntityNameLower.get('post')?.has('author'));
  // No relation is invented on the inverse side from this declaration alone.
  assert.equal(relationsFor(graph, 'User').length, 0);
});

test('a decorator-ORM collection side is 1:N and names the inverse field', () => {
  const user = entityNode('User', 'src/entities/user.entity.ts');
  const post = entityNode('Post', 'src/entities/post.entity.ts');
  const graph = extractEntityRelations({
    nodes: [
      user,
      post,
      propertyNode('posts', 'src/entities/user.entity.ts', {
        parent: user.id,
        type: 'Collection<Post>',
        annotations: ['@OneToMany(() => Post, post => post.author)'],
      }),
    ],
    dataEntities: [dataEntity('User', [{ name: 'posts', type: 'Collection<Post>' }]), dataEntity('Post', [])],
  });

  const relations = relationsFor(graph, 'User');
  assert.equal(relations.length, 1);
  assert.equal(relations[0].cardinality, '1:N');
  assert.equal(relations[0].targetName, 'Post');
  assert.equal(relations[0].inverseField, 'author');
});

// --- attribute ORMs (PHP): the declared inverse side is recorded -------------

test('an attribute-ORM OneToMany records the declared inverse side', () => {
  const author = entityNode('Author', 'src/Entity/Author.php');
  const book = entityNode('Book', 'src/Entity/Book.php');
  const graph = extractEntityRelations({
    nodes: [
      author,
      book,
      propertyNode('books', 'src/Entity/Author.php', {
        parent: author.id,
        annotations: ["#[ORM\\OneToMany(targetEntity: Book::class, mappedBy: 'author')]"],
      }),
    ],
    dataEntities: [dataEntity('Author', [{ name: 'books', type: 'Collection' }]), dataEntity('Book', [])],
  });

  const relations = relationsFor(graph, 'Author');
  assert.equal(relations.length, 1);
  assert.equal(relations[0].relationType, 'OneToMany');
  assert.equal(relations[0].cardinality, '1:N');
  assert.equal(relations[0].targetName, 'Book');
  assert.equal(relations[0].inverseField, 'author');
  assert.equal(relations[0].owning, false);
});

test('an attribute-ORM pre-parsed relation pair is read from node attributes', () => {
  const invoice = entityNode('Invoice', 'src/Entity/Invoice.php');
  const company = entityNode('Company', 'src/Entity/Company.php');
  const graph = extractEntityRelations({
    nodes: [
      invoice,
      company,
      propertyNode('company', 'src/Entity/Invoice.php', {
        parent: invoice.id,
        attributes: { relation_type: 'ManyToOne', target_entity: 'App\\Entity\\Company' },
      }),
    ],
    dataEntities: [dataEntity('Invoice', [{ name: 'company', type: 'Company' }]), dataEntity('Company', [])],
  });

  const relations = relationsFor(graph, 'Invoice');
  assert.equal(relations.length, 1);
  assert.equal(relations[0].cardinality, 'N:1');
  assert.equal(relations[0].targetName, 'Company');
  assert.equal(relations[0].evidenceSource, 'orm-declaration');
});

// --- Python / Ruby / .NET vocabularies --------------------------------------

test('a Python ORM relationship() and a ForeignKey are both read', () => {
  const order = entityNode('Order', 'app/models.py');
  const customer = entityNode('Customer', 'app/customer.py');
  const graph = extractEntityRelations({
    nodes: [
      order,
      customer,
      propertyNode('customer', 'app/models.py', {
        parent: order.id,
        annotations: ['relationship("Customer", back_populates="orders")'],
      }),
      propertyNode('owner', 'app/models.py', {
        parent: order.id,
        annotations: ['ForeignKey(Customer, on_delete=models.CASCADE)'],
      }),
    ],
    dataEntities: [dataEntity('Order', []), dataEntity('Customer', [])],
  });

  const relations = relationsFor(graph, 'Order');
  assert.equal(relations.length, 2);
  const byField = new Map(relations.map(r => [r.field, r]));
  assert.equal(byField.get('customer')!.targetName, 'Customer');
  assert.equal(byField.get('customer')!.inverseField, 'orders');
  assert.equal(byField.get('owner')!.cardinality, 'N:1');
});

test('a Ruby ORM belongs_to / has_many pair yields N:1 and 1:N', () => {
  const comment = entityNode('Comment', 'app/models/comment.rb');
  const article = entityNode('Article', 'app/models/article.rb');
  const graph = extractEntityRelations({
    nodes: [
      comment,
      article,
      propertyNode('article', 'app/models/comment.rb', {
        parent: comment.id,
        annotations: ['belongs_to :article'],
        type: 'Article',
      }),
      propertyNode('comments', 'app/models/article.rb', {
        parent: article.id,
        annotations: ['has_many :comments, class_name: "Comment"'],
        type: 'Comment',
      }),
    ],
    dataEntities: [dataEntity('Comment', []), dataEntity('Article', [])],
  });

  assert.equal(relationsFor(graph, 'Comment')[0].cardinality, 'N:1');
  assert.equal(relationsFor(graph, 'Article')[0].cardinality, '1:N');
});

test('a .NET navigation collection is read as 1:N from its declared type', () => {
  const blog = entityNode('Blog', 'Models/Blog.cs');
  const postEntity = entityNode('Post', 'Models/Post.cs');
  const graph = extractEntityRelations({
    nodes: [blog, postEntity],
    dataEntities: [
      dataEntity('Blog', [{ name: 'Posts', type: 'ICollection<Post>' }]),
      dataEntity('Post', [{ name: 'Blog', type: 'Blog' }]),
    ],
  });

  const blogRelations = relationsFor(graph, 'Blog');
  assert.equal(blogRelations.length, 1);
  assert.equal(blogRelations[0].cardinality, '1:N');
  assert.equal(blogRelations[0].evidenceSource, 'typed-composition');
  assert.equal(relationsFor(graph, 'Post')[0].cardinality, '1:1');
});

// --- typed composition ------------------------------------------------------

test('a field whose type IS another entity yields a composition relation', () => {
  const graph = extractEntityRelations({
    dataEntities: [
      dataEntity('PacketZeroCopy', [
        { name: 'header', type: 'PacketHeader' },
        { name: 'buf', type: '[u8]' },
      ]),
      dataEntity('PacketHeader', [{ name: 'nonce', type: '[u8; 12]' }]),
    ],
  });

  const relations = relationsFor(graph, 'PacketZeroCopy');
  assert.equal(relations.length, 1);
  assert.equal(relations[0].targetName, 'PacketHeader');
  assert.equal(relations[0].relationType, 'composition');
  assert.equal(relations[0].cardinality, '1:1');
  assert.equal(relations[0].field, 'header');
  assert.equal(relations[0].evidenceSource, 'typed-composition');
  assert.match(relations[0].evidence, /typed `PacketHeader`/);
});

test('composition unwraps single-value and collection containers', () => {
  const graph = extractEntityRelations({
    dataEntities: [
      dataEntity('Session', [
        { name: 'owner', type: 'Option<Box<Account>>' },
        { name: 'devices', type: 'Vec<Device>' },
        { name: 'label', type: 'String' },
      ]),
      dataEntity('Account', []),
      dataEntity('Device', []),
    ],
  });

  const byField = new Map(relationsFor(graph, 'Session').map(r => [r.field, r]));
  assert.equal(byField.size, 2);
  assert.equal(byField.get('owner')!.cardinality, '1:1');
  assert.equal(byField.get('devices')!.cardinality, '1:N');
  assert.equal(byField.get('devices')!.relationType, 'composes_many');
});

// --- the negative gate: NAME shape is never evidence ------------------------

test('an entity-shaped field NAME with no type or declaration evidence yields nothing', () => {
  const graph = extractEntityRelations({
    nodes: [entityNode('AnalysisResult', 'src/entities/a.ts'), entityNode('Project', 'src/entities/p.ts')],
    dataEntities: [
      // `project` NAMES an entity; its type is a scalar and no decorator
      // declares a relation. `projectId`/`project_id` are FK-shaped names with
      // no type evidence either. None of these may produce a relation.
      dataEntity('AnalysisResult', [
        { name: 'project', type: 'string' },
        { name: 'projectId', type: 'number' },
        { name: 'project_id', type: 'unknown' },
        { name: 'notes', type: 'unknown' },
      ]),
      dataEntity('Project', []),
    ],
  });

  assert.equal(relationsFor(graph, 'AnalysisResult').length, 0);
  assert.equal(graph.counts.data, 0);
  assert.equal(graph.relationFieldsByEntityNameLower.size, 0);
});

test('a relation to a name that is not an extracted entity is not emitted', () => {
  const order = entityNode('Order', 'src/entities/order.entity.ts');
  const graph = extractEntityRelations({
    nodes: [
      order,
      propertyNode('gateway', 'src/entities/order.entity.ts', {
        parent: order.id,
        type: 'PaymentGateway',
        annotations: ['@ManyToOne(() => PaymentGateway)'],
      }),
    ],
    dataEntities: [dataEntity('Order', [{ name: 'gateway', type: 'PaymentGateway' }])],
  });

  assert.equal(relationsFor(graph, 'Order').length, 0);
});

// --- data vs structural -----------------------------------------------------

test('implements/uses_trait edges are structural, never data relations', () => {
  const codebase = entityNode('Codebase', 'src/entities/codebase.entity.ts');
  const page: CASNode = { id: 'comp_page', name: 'CodebasePage', type: 'component' };
  const project = entityNode('Project', 'src/entities/project.entity.ts');
  const edges: CASEdge[] = [
    { id: 'e1', source: codebase.id, target: page.id, type: 'implements' } as CASEdge,
    {
      id: 'e2',
      source: codebase.id,
      target: project.id,
      type: 'references',
      metadata: { attributes: { relationType: 'ManyToOne', field: 'project' } },
    } as unknown as CASEdge,
  ];
  const graph = extractEntityRelations({
    nodes: [codebase, page, project],
    edges,
    dataEntities: [dataEntity('Codebase', []), dataEntity('Project', [])],
  });

  const data = relationsFor(graph, 'Codebase');
  assert.equal(data.length, 1);
  assert.equal(data[0].targetName, 'Project');
  assert.equal(data[0].evidenceSource, 'orm-edge');

  const structural = graph.structuralByEntityNameLower.get('codebase') || [];
  assert.equal(structural.length, 1);
  assert.equal(structural[0].targetName, 'CodebasePage');
  assert.equal(structural[0].kind, 'structural');
});

test('an ORM relation edge and its decorator collapse to one relation', () => {
  const post = entityNode('Post', 'src/entities/post.entity.ts');
  const user = entityNode('User', 'src/entities/user.entity.ts');
  const graph = extractEntityRelations({
    nodes: [
      post,
      user,
      propertyNode('author', 'src/entities/post.entity.ts', {
        parent: post.id,
        type: 'User',
        annotations: ['@ManyToOne(() => User)'],
      }),
    ],
    edges: [{
      id: 'e1',
      source: post.id,
      target: user.id,
      type: 'references',
      metadata: { attributes: { relationType: 'ManyToOne', field: 'author' } },
    } as unknown as CASEdge],
    dataEntities: [dataEntity('Post', [{ name: 'author', type: 'User' }]), dataEntity('User', [])],
  });

  const relations = relationsFor(graph, 'Post');
  assert.equal(relations.length, 1);
  // Strongest carrier wins the dedupe.
  assert.equal(relations[0].evidenceSource, 'orm-edge');
});

test('a property in a file declaring two entities does not guess an owner', () => {
  const a = entityNode('Alpha', 'src/models.ts');
  const b = entityNode('Beta', 'src/models.ts');
  const graph = extractEntityRelations({
    nodes: [
      a,
      b,
      // No `parent` link and two candidate owners in the file: ownership is a
      // guess, and a guess is not evidence.
      propertyNode('beta', 'src/models.ts', { type: 'Beta', annotations: ['@ManyToOne(() => Beta)'] }),
    ],
    dataEntities: [dataEntity('Alpha', []), dataEntity('Beta', [])],
  });

  assert.equal(graph.counts.data, 0);
});

// --- primitives -------------------------------------------------------------

test('resolveDeclaredTypeShape unwraps wrappers and refuses ambiguity', () => {
  assert.deepEqual(resolveDeclaredTypeShape('Ref<User>'), { name: 'User', collection: false });
  assert.deepEqual(resolveDeclaredTypeShape('Collection<Post>'), { name: 'Post', collection: true });
  assert.deepEqual(resolveDeclaredTypeShape('Post[]'), { name: 'Post', collection: true });
  assert.deepEqual(resolveDeclaredTypeShape('List<Post>'), { name: 'Post', collection: true });
  assert.deepEqual(resolveDeclaredTypeShape('Optional[Post]'), { name: 'Post', collection: false });
  assert.deepEqual(resolveDeclaredTypeShape('User | null'), { name: 'User', collection: false });
  assert.deepEqual(resolveDeclaredTypeShape('&EncryptedPacketHeader'), {
    name: 'EncryptedPacketHeader', collection: false,
  });
  assert.equal(resolveDeclaredTypeShape('Record<string, number>').name, undefined);
  assert.equal(resolveDeclaredTypeShape('User | Admin').name, undefined);
  assert.equal(resolveDeclaredTypeShape('{ id: number }').name, undefined);
  assert.equal(resolveDeclaredTypeShape('').name, undefined);
});

test('cardinalityForRelationType covers every ecosystem vocabulary', () => {
  assert.equal(cardinalityForRelationType('ManyToOne'), 'N:1');
  assert.equal(cardinalityForRelationType('many_to_many'), 'N:M');
  assert.equal(cardinalityForRelationType('belongs_to'), 'N:1');
  assert.equal(cardinalityForRelationType('hasMany'), '1:N');
  assert.equal(cardinalityForRelationType('ForeignKey'), 'N:1');
  assert.equal(cardinalityForRelationType('ManyToManyField'), 'N:M');
  // `relationship(...)` names no cardinality: only a declared collection is
  // honest evidence, and absent that we stay silent rather than guess.
  assert.equal(cardinalityForRelationType('relationship'), undefined);
  assert.equal(cardinalityForRelationType('relationship', { collection: true }), '1:N');
});

test('parseRelationDeclaration ignores non-relation decorators', () => {
  assert.equal(parseRelationDeclaration('@Property({ type: "varchar" })'), undefined);
  assert.equal(parseRelationDeclaration('@Column()'), undefined);
  assert.equal(parseRelationDeclaration('@Index()'), undefined);
  assert.equal(parseRelationDeclaration(''), undefined);
  assert.equal(parseRelationDeclaration('@ManyToMany(() => Tag, { owner: true })')!.relationType, 'ManyToMany');
});
