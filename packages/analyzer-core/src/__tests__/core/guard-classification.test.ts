import { classifyGuardKind, isAuthenticationGuardName } from '../../analyzer/core/guard-classification';

describe('classifyGuardKind', () => {
  it('classifies authentication guards', () => {
    for (const name of [
      'AuthGuard', 'JwtAuthGuard', 'JwtGuard', 'GlobalAuthGuard', 'WebAuthGuard',
      'InternalAuthGuard', 'LocalAuthGuard', 'SessionGuard', 'ApiKeyGuard',
      'api_key_guard', 'OAuthGuard', 'BearerTokenGuard', 'PassportGuard',
      'require_auth', 'LoginGuard', 'SignInGuard',
    ]) {
      expect(classifyGuardKind(name)).toBe('authentication');
    }
  });

  it('classifies rate-limiting guards, never as authentication', () => {
    for (const name of ['ThrottlerGuard', 'RateLimitGuard', 'rate_limit_middleware', 'ThrottleGuard', 'rate-limiter']) {
      expect(classifyGuardKind(name)).toBe('rate-limiting');
    }
  });

  it('classifies authorization guards even when their names contain auth', () => {
    for (const name of ['RolesGuard', 'PermissionsGuard', 'PolicyGuard', 'AclGuard', 'RbacGuard', 'AuthorizationGuard', 'OrganizationGuard', 'TenantGuard', 'IsGranted', 'ScopesGuard']) {
      expect(classifyGuardKind(name)).toBe('authorization');
    }
  });

  it('classifies validation guards', () => {
    for (const name of ['ValidationGuard', 'CsrfGuard', 'XsrfTokenGuard', 'RecaptchaGuard', 'SchemaGuard']) {
      expect(classifyGuardKind(name)).toBe('validation');
    }
  });

  it('returns unknown for unrecognized names and empty input', () => {
    expect(classifyGuardKind('MysteryGuard')).toBe('unknown');
    expect(classifyGuardKind('')).toBe('unknown');
    expect(classifyGuardKind(undefined)).toBe('unknown');
  });

  it('isAuthenticationGuardName only accepts authentication-kind guards', () => {
    expect(isAuthenticationGuardName('GlobalAuthGuard')).toBe(true);
    expect(isAuthenticationGuardName('ApiKeyGuard')).toBe(true);
    expect(isAuthenticationGuardName('ThrottlerGuard')).toBe(false);
    expect(isAuthenticationGuardName('RolesGuard')).toBe(false);
    expect(isAuthenticationGuardName('AuthorizationGuard')).toBe(false);
  });
});
