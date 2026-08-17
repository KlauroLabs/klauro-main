import type { CASExitPoint } from '../../types/cas.types';
import { serviceNameFromEndpoint } from './service-identity';

const UNRESOLVED_SERVICE_IDENTITIES = new Set([
  'api',
  'externalapi',
  'service',
  'soapservice',
  'sdk',
  'unknown',
]);

function resolvedIdentity(value: string | undefined): string | undefined {
  const candidate = String(value || '').trim();
  if (!candidate) return undefined;
  const normalized = candidate.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return UNRESOLVED_SERVICE_IDENTITIES.has(normalized) ? undefined : candidate;
}

export function externalServiceIdentityForExitPoint(exitPoint: CASExitPoint): string | undefined {
  if (exitPoint.target?.service_id) {
    return resolvedIdentity(exitPoint.target.service_id)
      || serviceNameFromEndpoint(String(exitPoint.target.endpoint || ''));
  }
  return resolvedIdentity(exitPoint.target?.sdk)
    || serviceNameFromEndpoint(String(exitPoint.target?.endpoint || ''))
    || resolvedIdentity(exitPoint.name);
}
