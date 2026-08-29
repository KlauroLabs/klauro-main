import { capabilityGroundedEntityIds } from '../../analyzer/core/capability-entity-grounding';

const entity = (id: string, name: string, targets: string[] = []) => ({
  id,
  name,
  kind: 'persisted-entity' as const,
  fields: [],
  lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] },
  relations: targets.map(target_name => ({
    target_name,
    relation_type: 'ManyToOne',
    kind: 'data' as const,
    evidence_source: 'orm-declaration' as const,
    evidence: `${name}.${target_name}`,
  })),
});

const operation = (id: string, method: string, path: string) => ({
  entry_point_id: id,
  entry_point_type: 'http',
  action: method === 'GET' ? 'List' : method === 'POST' ? 'Create' : 'Delete',
  path_or_command: path,
  trigger: { method, path },
});

const entryPoint = (id: string, method: string, path: string) => ({
  id,
  source_node: `node-${id}`,
  type: 'http' as const,
  name: id,
  trigger: { method, path },
});

test('adds only a directly related parent proven by every exact nested operation', () => {
  const operations = [
    operation('comments-list', 'GET', '/article/articles/:slug/comments'),
    operation('comments-delete', 'DELETE', '/article/articles/:slug/comments/:id'),
  ];
  const capability = {
    id: 'comments', name: 'Manage comments', description: '', category: 'core' as const,
    operations, related_entities: ['comment'], related_domains: [], criticality: 'high' as const, criticality_factors: [],
  };
  const entities = [
    entity('comment', 'Comment', ['Article']),
    entity('article', 'Article', ['Comment', 'Author']),
    entity('author', 'Author', ['Article']),
  ];
  const entries = operations.map(value => entryPoint(value.entry_point_id, value.trigger.method, value.trigger.path));

  expect([...capabilityGroundedEntityIds(capability, entities, entries)].sort()).toEqual(['article', 'comment']);
  expect(capability.related_entities).toEqual(['comment']);
});

test('fails closed for missing relation, mismatched entry point, sibling, and transitive entities', () => {
  const followOperation = operation('follow', 'POST', '/profiles/:username/follow');
  const capability = {
    id: 'follow', name: 'Follow profiles', description: '', category: 'core' as const,
    operations: [followOperation], related_entities: ['profile'], related_domains: [], criticality: 'high' as const, criticality_factors: [],
  };
  const entities = [
    entity('profile', 'Profile', ['User']),
    entity('user', 'User', ['Profile', 'Article']),
    entity('article', 'Article', ['User']),
  ];
  expect([...capabilityGroundedEntityIds(capability, entities, [
    entryPoint('follow', 'POST', '/profiles/:username/follow'),
  ])]).toEqual(['profile']);
  expect([...capabilityGroundedEntityIds(capability, entities, [
    entryPoint('follow', 'DELETE', '/profiles/:username/follow'),
  ])]).toEqual(['profile']);

  const comments = { ...capability, id: 'comments', related_entities: ['profile'], operations: [
    operation('comments', 'POST', '/articles/:slug/comments'),
  ] };
  expect([...capabilityGroundedEntityIds(comments, [
    entity('profile', 'Profile'),
    entity('article', 'Article'),
  ], [entryPoint('comments', 'POST', '/articles/:slug/comments')])]).toEqual(['profile']);
});
