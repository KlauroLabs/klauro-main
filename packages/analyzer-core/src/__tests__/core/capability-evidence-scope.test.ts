import { classifyCapabilityEvidence } from '../../analyzer/core/capability-catalog-evidence';
import type { CASDataEntity, CASEntryPoint, SystemCapability } from '../../types/cas.types';

const authCandidate = (): SystemCapability => ({
  id: 'cap_auth_management',
  name: 'Authenticate users',
  structural_label: 'Authentication',
  description: 'Users authenticate with registered credentials before accessing the application.',
  category: 'core',
  operations: [
    { entry_point_id: 'login', entry_point_type: 'http', action: 'login', path_or_command: '/api/users/login' },
    { entry_point_id: 'register', entry_point_type: 'http', action: 'register', path_or_command: '/api/users' },
  ],
  related_entities: ['entity_user'],
  related_domains: ['identity'],
  criticality: 'high',
  criticality_factors: [],
  evidence_kind: 'behavior-surface',
});

const downstreamCandidate = (prerequisiteId = 'cap_auth_management'): SystemCapability => ({
  id: 'cap_publish_articles',
  name: 'Publish articles',
  description: 'Readers publish articles for others to read and discuss.',
  category: 'core',
  operations: [{ entry_point_id: 'publish', entry_point_type: 'http', action: 'publish', path_or_command: '/api/articles' }],
  related_entities: ['entity_article'],
  related_domains: ['publishing'],
  criticality: 'high',
  criticality_factors: [],
  depends_on: [{
    from_capability: 'cap_publish_articles', to_capability: prerequisiteId,
    dependency_type: 'requires', strength: 'required',
    evidence: { shared_services: [], shared_nodes: [] },
    description: 'Publishing requires authenticated access',
  }],
});

const entryPoints = [
  {
    id: 'login', source_node: 'login-handler', type: 'http', name: 'POST /api/users/login',
    trigger: { method: 'POST', path: '/api/users/login' },
    handler: { node_id: 'login-handler', method_name: 'login' },
    interaction_reach: 'external',
  },
  {
    id: 'register', source_node: 'register-handler', type: 'http', name: 'POST /api/users',
    trigger: { method: 'POST', path: '/api/users' },
    handler: { node_id: 'register-handler', method_name: 'register' },
    interaction_reach: 'external',
  },
] as CASEntryPoint[];

const entities = [{
  id: 'entity_user',
  name: 'User',
  kind: 'persisted-entity',
  fields: [],
  lifecycle: {
    created_by: ['register-handler'],
    read_by: ['login-handler'],
    updated_by: [],
    deleted_by: [],
  },
}] as CASDataEntity[];

describe('scope-relative capability evidence', () => {
  it('keeps authentication as visible upstream substrate in an ordinary product', () => {
    const [classified] = classifyCapabilityEvidence(
      [authCandidate(), downstreamCandidate()],
      entities,
      { productDocTitle: 'Article publishing', productDocSummary: 'Readers publish and discuss articles.' },
      { entryPoints },
    );

    expect(classified.evidence_role).toBe('supporting-mechanism');
    expect(classified.evidence_role_reasons).toContain('upstream-prerequisite-outside-product-purpose');
  });

  it('recognizes generated service-class identity labels as substrate', () => {
    const generatedService = {
      ...authCandidate(),
      id: 'cap_memos_v1_authservice_management',
      name: 'AuthService Management',
      structural_label: 'AuthService Management',
      operations: [
        { entry_point_id: 'login', entry_point_type: 'http', action: 'SignIn', path_or_command: '/memos.api.v1.AuthService/SignIn' },
        { entry_point_id: 'register', entry_point_type: 'http', action: 'SignOut', path_or_command: '/memos.api.v1.AuthService/SignOut' },
      ],
    };
    const [classified] = classifyCapabilityEvidence(
      [generatedService, downstreamCandidate(generatedService.id)],
      entities,
      { productDocTitle: 'Memos', productDocSummary: 'A self-hosted home for daily notes and short-form thinking.' },
      { entryPoints },
    );

    expect(classified.evidence_role).toBe('supporting-mechanism');
    expect(classified.evidence_role_reasons).toContain('upstream-prerequisite-outside-product-purpose');
  });

  it('allows authentication to be product purpose for an identity system', () => {
    const [classified] = classifyCapabilityEvidence(
      [authCandidate()],
      entities,
      {
        productDocTitle: 'Identity service',
        productDocSummary: 'An identity platform that authenticates users and provides access control.',
      },
      { entryPoints },
    );

    expect(classified.evidence_role).toBe('product-outcome');
    expect(classified.evidence_role_reasons).toContain('first-party-product-text');
  });

  it('classifies logging by graph position and product purpose rather than vocabulary', () => {
    const logs: SystemCapability = {
      id: 'cap_search_logs', name: 'Search application logs', structural_label: 'Application logs',
      description: 'Operators search application logs to investigate behavior over time.', category: 'core',
      operations: [{ entry_point_id: 'search-logs', entry_point_type: 'http', action: 'search', path_or_command: '/logs' }],
      related_entities: [], related_domains: ['logs'], criticality: 'high', criticality_factors: [],
    };
    const [storeLogs] = classifyCapabilityEvidence(
      [logs, downstreamCandidate(logs.id)], [],
      { productDocTitle: 'Article publishing', productDocSummary: 'Readers publish and discuss articles.' },
    );
    const [observabilityLogs] = classifyCapabilityEvidence(
      [logs], [],
      { productDocTitle: 'Log observability', productDocSummary: 'Operators search application logs to investigate service behavior.' },
    );

    expect(storeLogs.evidence_role).toBe('supporting-mechanism');
    expect(storeLogs.evidence_role_reasons).toContain('upstream-prerequisite-outside-product-purpose');
    expect(observabilityLogs.evidence_role).toBe('product-outcome');
    expect(observabilityLogs.evidence_role_reasons).toContain('first-party-product-text');
  });

  it('recognizes a technical developer outcome when that is what the library offers', () => {
    const dependencyInjection: SystemCapability = {
      id: 'cap_dependency_injection', name: 'Register and resolve services', structural_label: 'Service registration and resolution',
      description: 'Developers register service implementations and resolve them through the library container.', category: 'core',
      operations: [
        { entry_point_id: 'register-service', entry_point_type: 'public-api', action: 'register', path_or_command: 'register' },
        { entry_point_id: 'resolve-service', entry_point_type: 'public-api', action: 'resolve', path_or_command: 'resolve' },
      ],
      related_entities: [], related_domains: ['dependency injection'], criticality: 'high', criticality_factors: [],
    };
    const [classified] = classifyCapabilityEvidence(
      [dependencyInjection], [],
      {
        productDocTitle: 'Dependency injection library',
        productDocSummary: 'Developers register and resolve services through a dependency injection container.',
      },
    );

    expect(classified.evidence_role).toBe('product-outcome');
    expect(classified.evidence_role_reasons).toContain('first-party-product-text');
  });
});
