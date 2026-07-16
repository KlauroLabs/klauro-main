import {
  attachEntryPointSecurity,
  deriveAuthMethod,
} from '../../analyzer/core/entry-point-security';
import type {
  CASEntryPoint,
  CASSecurityBoundary,
  CASSecurityContext,
} from '../../types/cas.types';

function makeEntryPoint(overrides: Partial<CASEntryPoint>): CASEntryPoint {
  return {
    id: 'entry_default',
    source_node: 'node_default',
    type: 'http',
    name: 'default entry',
    ...overrides,
  };
}

describe('deriveAuthMethod', () => {
  it('maps Passport mechanism strings to passport', () => {
    expect(deriveAuthMethod('Passport/Auth Middleware')).toBe('passport');
  });

  it('maps JWT mechanism strings to jwt', () => {
    expect(deriveAuthMethod('JSON Web Token verification')).toBe('jwt');
  });

  it('maps OAuth mechanism strings to oauth (before the jwt fallback)', () => {
    expect(deriveAuthMethod('OAuth2/JWT Bridge')).toBe('oauth');
  });

  it('maps api key mechanism strings to api-key', () => {
    expect(deriveAuthMethod('API-Key header check')).toBe('api-key');
  });

  it('falls back to middleware for unrecognized mechanisms', () => {
    expect(deriveAuthMethod('Custom Gatekeeper Widget')).toBe('middleware');
  });

  it('falls back to middleware for empty/undefined mechanisms', () => {
    expect(deriveAuthMethod(undefined)).toBe('middleware');
    expect(deriveAuthMethod('')).toBe('middleware');
  });
});

describe('attachEntryPointSecurity', () => {
  it('marks an entry point protected when its handler node is an enforcement point', () => {
    const entryPoint = makeEntryPoint({
      id: 'entry_protected_via_handler',
      source_node: 'node_source_1',
      handler: { node_id: 'node_handler_1', method_name: 'handle' },
    });
    const boundaries: CASSecurityBoundary[] = [
      {
        id: 'boundary_auth',
        name: 'Authentication Boundary',
        boundary_type: 'authentication',
        enforcement_points: [
          {
            node_id: 'node_handler_1',
            mechanism: 'Passport/Auth Middleware',
            confidence: 'enforced',
          },
        ],
        trust_transition: { from_trust_level: 'untrusted', to_trust_level: 'trusted' },
        sensitive_operations: [],
      },
    ];

    const [result] = attachEntryPointSecurity([entryPoint], boundaries, []);

    expect(result.security?.authenticated).toBe(true);
    expect(result.security?.enforcement).toBe('enforced');
    expect(result.security?.guards).toEqual(
      expect.arrayContaining(['Passport/Auth Middleware', 'passport']),
    );
  });

  it('marks an entry point protected when matched via a security_context scope', () => {
    const entryPoint = makeEntryPoint({
      id: 'entry_protected_via_context',
      source_node: 'node_source_2',
      connected_nodes: ['node_connected_2'],
    });
    const contexts: CASSecurityContext[] = [
      {
        id: 'security_ctx_authentication',
        name: 'Authentication',
        type: 'authentication',
        scope: { node_ids: ['node_connected_2'] },
        requirements: {
          authentication: { required: true, methods: ['jwt'] },
          authorization: { roles: ['admin'], permissions: ['read:orders'] },
        },
      },
    ];

    const [result] = attachEntryPointSecurity([entryPoint], [], contexts);

    expect(result.security?.authenticated).toBe(true);
    expect(result.security?.enforcement).toBe('assumed');
    expect(result.security?.guards).toEqual(expect.arrayContaining(['jwt']));
    expect(result.security?.roles).toEqual(['admin']);
    expect(result.security?.permissions).toEqual(['read:orders']);
    expect(result.security?.authorized_roles).toEqual(['admin']);
  });

  it('matches directly via security_context scope.entry_points (no shared node id needed)', () => {
    const entryPoint = makeEntryPoint({
      id: 'entry_auth_route_src_routes_auth_ts_198',
      source_node: 'node_unrelated',
    });
    const contexts: CASSecurityContext[] = [
      {
        id: 'security_ctx_authentication',
        name: 'Authentication',
        type: 'authentication',
        scope: {
          node_ids: ['some_other_node'],
          entry_points: ['entry_auth_route_src_routes_auth_ts_198'],
        },
        requirements: { authentication: { required: true, methods: ['passport', 'jwt'] } },
      },
    ];

    const [result] = attachEntryPointSecurity([entryPoint], [], contexts);

    expect(result.security?.authenticated).toBe(true);
    expect(result.security?.guards).toEqual(expect.arrayContaining(['passport', 'jwt']));
  });

  it('leaves security unset when there is no matching evidence at all', () => {
    const entryPoint = makeEntryPoint({
      id: 'entry_no_evidence',
      source_node: 'node_isolated',
    });
    const boundaries: CASSecurityBoundary[] = [
      {
        id: 'boundary_auth',
        name: 'Authentication Boundary',
        boundary_type: 'authentication',
        enforcement_points: [
          { node_id: 'node_totally_unrelated', mechanism: 'Passport/Auth Middleware', confidence: 'enforced' },
        ],
        trust_transition: { from_trust_level: 'untrusted', to_trust_level: 'trusted' },
        sensitive_operations: [],
      },
    ];
    const contexts: CASSecurityContext[] = [
      {
        id: 'security_ctx_authentication',
        name: 'Authentication',
        scope: { node_ids: ['node_also_unrelated'] },
      },
    ];

    const [result] = attachEntryPointSecurity([entryPoint], boundaries, contexts);

    expect(result.security).toBeUndefined();
  });

  it('does not flip authenticated true for a confidence:"missing" enforcement point', () => {
    const entryPoint = makeEntryPoint({
      id: 'entry_gap',
      source_node: 'node_gap',
    });
    const boundaries: CASSecurityBoundary[] = [
      {
        id: 'boundary_auth',
        name: 'Authentication Boundary',
        boundary_type: 'authentication',
        enforcement_points: [
          { node_id: 'node_gap', mechanism: 'Expected Auth Middleware', confidence: 'missing' },
        ],
        trust_transition: { from_trust_level: 'untrusted', to_trust_level: 'trusted' },
        sensitive_operations: [],
      },
    ];

    const [result] = attachEntryPointSecurity([entryPoint], boundaries, []);

    expect(result.security?.authenticated).not.toBe(true);
    expect(result.security?.enforcement).toBeUndefined();
  });

  it('preserves and merges pre-existing security fields rather than clobbering them', () => {
    const entryPoint = makeEntryPoint({
      id: 'entry_preexisting',
      source_node: 'node_preexisting',
      security: {
        authenticated: true,
        guards: ['CustomGuard'],
        rate_limit: '100/min',
      },
    });
    const boundaries: CASSecurityBoundary[] = [
      {
        id: 'boundary_auth',
        name: 'Authentication Boundary',
        boundary_type: 'authentication',
        enforcement_points: [
          { node_id: 'node_preexisting', mechanism: 'Passport/Auth Middleware', confidence: 'enforced' },
        ],
        trust_transition: { from_trust_level: 'untrusted', to_trust_level: 'trusted' },
        sensitive_operations: [],
      },
    ];

    const [result] = attachEntryPointSecurity([entryPoint], boundaries, []);

    expect(result.security?.authenticated).toBe(true);
    expect(result.security?.rate_limit).toBe('100/min');
    expect(result.security?.guards).toEqual(
      expect.arrayContaining(['CustomGuard', 'Passport/Auth Middleware', 'passport']),
    );
  });

  it('does not mutate the input entry points array', () => {
    const entryPoint = makeEntryPoint({
      id: 'entry_immutable',
      source_node: 'node_immutable',
    });
    const boundaries: CASSecurityBoundary[] = [
      {
        id: 'boundary_auth',
        name: 'Authentication Boundary',
        boundary_type: 'authentication',
        enforcement_points: [
          { node_id: 'node_immutable', mechanism: 'Passport/Auth Middleware', confidence: 'enforced' },
        ],
        trust_transition: { from_trust_level: 'untrusted', to_trust_level: 'trusted' },
        sensitive_operations: [],
      },
    ];

    attachEntryPointSecurity([entryPoint], boundaries, []);

    expect(entryPoint.security).toBeUndefined();
  });
});
