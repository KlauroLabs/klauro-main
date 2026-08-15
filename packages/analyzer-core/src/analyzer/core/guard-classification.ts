import type { CASGuardKind } from '../../types/cas.types';









export function classifyGuardKind(guardName: string | undefined): CASGuardKind {
  const name = String(guardName || '').toLowerCase();
  if (!name) return 'unknown';

  if (/throttl|rate[-_]?limit/.test(name)) return 'rate-limiting';

  if (/authoriz|role|permission|policy|policies|acl|rbac|abac|grant|tenant|organization|owner|scope/.test(name)) {
    return 'authorization';
  }

  if (/csrf|xsrf|recaptcha|captcha/.test(name)) return 'validation';

  if (/auth|jwt|session|api[-_]?key|apikey|oauth|sso|login|signin|sign[-_]?in|token|bearer|passport|credential|identity/.test(name)) {
    return 'authentication';
  }

  if (/valid|sanitiz|schema/.test(name)) return 'validation';

  return 'unknown';
}

export function isAuthenticationGuardName(guardName: string | undefined): boolean {
  return classifyGuardKind(guardName) === 'authentication';
}
