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
  it('keeps authentication as visible substrate in an ordinary product', () => {
    const [classified] = classifyCapabilityEvidence(
      [authCandidate()],
      entities,
      { productDocTitle: 'Article publishing', productDocSummary: 'Readers publish and discuss articles.' },
      { entryPoints },
    );

    expect(classified.evidence_role).toBe('supporting-mechanism');
    expect(classified.evidence_role_reasons).toContain('identity-is-upstream-substrate-outside-an-identity-product');
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
      [generatedService],
      entities,
      { productDocTitle: 'Memos', productDocSummary: 'A self-hosted home for daily notes and short-form thinking.' },
      { entryPoints },
    );

    expect(classified.evidence_role).toBe('supporting-mechanism');
    expect(classified.evidence_role_reasons).toContain('identity-is-upstream-substrate-outside-an-identity-product');
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
});
