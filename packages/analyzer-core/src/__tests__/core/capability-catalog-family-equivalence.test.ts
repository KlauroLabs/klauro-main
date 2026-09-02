import { groupCapabilityCatalogFamilies } from '../../analyzer/core/capability-catalog-family-equivalence';

const semantics = {
  normalizeToken: (token: string) => token.length > 4 && token.endsWith('s') ? token.slice(0, -1) : token,
  isGenericToken: (token: string) => ['capability', 'management'].includes(token),
};
const operation = (id: string, action: string, path: string) => ({
  entry_point_id: id, entry_point_type: 'http' as const, action, path_or_command: path,
});

describe('capability catalog family equivalence', () => {
  it('keeps action-distinct outcomes on one entity in separate families', () => {
    const families = groupCapabilityCatalogFamilies([
      { id: 'articles', name: 'Article', category: 'core', criticality: 'high', description: "", criticality_factors: [], related_domains: [], related_entities: ['entity_article'], operations: [operation('create-article', 'Create', '/articles')] },
      { id: 'favorites', name: 'Favorite Article', category: 'core', criticality: 'high', description: "", criticality_factors: [], related_domains: [], related_entities: ['entity_article'], operations: [operation('favorite-article', 'Favorite', '/articles/:slug/favorite')] },
    ], semantics);
    expect(families.map(family => family.map(candidate => candidate.id))).toEqual([['articles'], ['favorites']]);
  });

  it('groups aliases that share concrete operations', () => {
    const shared = operation('create-article', 'Create', '/articles');
    const families = groupCapabilityCatalogFamilies([
      { id: 'articles', name: 'Publish Articles', category: 'core', criticality: 'high', description: "", criticality_factors: [], related_domains: [], related_entities: ['entity_article'], operations: [shared] },
      { id: 'publishing', name: 'Article Publishing', category: 'core', criticality: 'high', description: "", criticality_factors: [], related_domains: [], related_entities: ['entity_article'], operations: [shared] },
    ], semantics);
    expect(families.map(family => family.map(candidate => candidate.id))).toEqual([['articles', 'publishing']]);
  });

  it('groups disjoint resource lifecycle operations anchored to the same distinctive entity', () => {
    const families = groupCapabilityCatalogFamilies([
      { id: 'sessions', name: 'Sessions', category: 'core', criticality: 'high', description: "", criticality_factors: [], related_domains: [], related_entities: ['entity_session'], operations: [operation('read-session', 'read', '/sessions/:id')] },
      { id: 'session-management', name: 'Session Management', category: 'core', criticality: 'high', description: "", criticality_factors: [], related_domains: [], related_entities: ['entity_session'], operations: [operation('update-session', 'update', '/sessions/:id')] },
    ], semantics);
    expect(families.map(family => family.map(candidate => candidate.id))).toEqual([['sessions', 'session-management']]);
  });

  it('does not group disjoint operations without a shared distinctive entity', () => {
    const families = groupCapabilityCatalogFamilies([
      { id: 'settings', name: 'Settings', category: 'core', criticality: 'high', description: "", criticality_factors: [], related_domains: [], related_entities: [], operations: [operation('read-settings', 'read', '/settings')] },
      { id: 'profiles', name: 'Profiles', category: 'core', criticality: 'high', description: "", criticality_factors: [], related_domains: [], related_entities: [], operations: [operation('update-profile', 'update', '/profiles/:id')] },
    ], semantics);
    expect(families.map(family => family.map(candidate => candidate.id))).toEqual([['settings'], ['profiles']]);
  });

  it('groups a namespaced resource lifecycle with its parent subject', () => {
    const families = groupCapabilityCatalogFamilies([
      { id: 'imports', name: 'Imports', category: 'core', criticality: 'high', description: "", criticality_factors: [], related_domains: ['imports'], related_entities: ['entity_import'], operations: [operation('create-import', 'create', '/imports')] },
      { id: 'import-upload', name: 'Import Upload', category: 'supporting', criticality: 'high', description: "", criticality_factors: [], related_domains: ['import-upload'], related_entities: [], operations: [operation('update-upload', 'update', '/upload')] },
    ], semantics);
    expect(families.map(family => family.map(candidate => candidate.id))).toEqual([['imports', 'import-upload']]);
  });

  it('is invariant to candidate order', () => {
    const candidates = [
      { id: 'articles', name: 'Article', category: 'core' as const, criticality: 'high' as const, description: "", criticality_factors: [], related_domains: [], related_entities: ['entity_article'], operations: [operation('create-article', 'Create', '/articles')] },
      { id: 'favorites', name: 'Favorite Article', category: 'core' as const, criticality: 'high' as const, description: "", criticality_factors: [], related_domains: [], related_entities: ['entity_article'], operations: [operation('favorite-article', 'Favorite', '/articles/:slug/favorite')] },
      { id: 'comments', name: 'Comments', category: 'core' as const, criticality: 'high' as const, description: "", criticality_factors: [], related_domains: [], related_entities: ['entity_comment'], operations: [operation('create-comment', 'Create', '/articles/:slug/comments')] },
    ];
    const normalize = (families: ReturnType<typeof groupCapabilityCatalogFamilies>) => families.map(family => family.map(candidate => candidate.id).sort()).sort();
    expect(normalize(groupCapabilityCatalogFamilies(candidates, semantics)))
      .toEqual(normalize(groupCapabilityCatalogFamilies([...candidates].reverse(), semantics)));
  });
});
