import { scopeCapabilityOperationsToOutcomeName } from '../../analyzer/core/capability-operation-attribution';

const operations = [
  { entry_point_id: 'create', entry_point_type: 'http', action: 'authenticate and create', path_or_command: '/articles', trigger: { method: 'POST', path: '/articles' } },
  { entry_point_id: 'read', entry_point_type: 'http', action: 'authenticate and read', path_or_command: '/articles/:slug', trigger: { method: 'GET', path: '/articles/:slug' } },
  { entry_point_id: 'update', entry_point_type: 'http', action: 'authenticate and update', path_or_command: '/articles/:slug', trigger: { method: 'PUT', path: '/articles/:slug' } },
  { entry_point_id: 'delete', entry_point_type: 'http', action: 'authenticate and delete', path_or_command: '/articles/:slug', trigger: { method: 'DELETE', path: '/articles/:slug' } },
];

describe('capability operation attribution', () => {
  it.each([
    ['Create an article', 'create'],
    ['Read an article', 'read'],
    ['Update an article', 'update'],
    ['Delete an article', 'delete'],
  ])('attributes %s to its exact lifecycle operation', (name, expectedId) => {
    expect(scopeCapabilityOperationsToOutcomeName(name, operations)).toEqual([
      expect.objectContaining({ entry_point_id: expectedId }),
    ]);
  });

  it('retains the complete operation set for a broad outcome', () => {
    expect(scopeCapabilityOperationsToOutcomeName('Organize articles', operations)).toHaveLength(4);
  });

  it('keeps both sides of an inverse-action outcome without inheriting sibling CRUD operations', () => {
    const mixed = [
      ...operations,
      { entry_point_id: 'favorite', entry_point_type: 'http', action: 'Create', path_or_command: '/articles/:slug/favorite', trigger: { method: 'POST', path: '/articles/:slug/favorite' } },
      { entry_point_id: 'unfavorite', entry_point_type: 'http', action: 'Delete', path_or_command: '/articles/:slug/favorite', trigger: { method: 'DELETE', path: '/articles/:slug/favorite' } },
    ];
    expect(scopeCapabilityOperationsToOutcomeName('Favorite and unfavorite articles', mixed)).toEqual([
      expect.objectContaining({ entry_point_id: 'favorite' }),
      expect.objectContaining({ entry_point_id: 'unfavorite' }),
    ]);
  });

});
