import { describe, expect, it } from '@jest/globals';
import type { CASExitPoint } from '../../types/cas.types';
import { externalServiceIdentityForExitPoint } from '../../analyzer/core/external-service-identity';

function exitPoint(target: CASExitPoint['target'], name = 'Outbound call'): CASExitPoint {
  return { id: 'exit', source_node: 'source', type: 'api', name, target };
}

describe('externalServiceIdentityForExitPoint', () => {
  it('prefers evidence-derived configured service identities', () => {
    expect(externalServiceIdentityForExitPoint(exitPoint({
      service_id: 'Fleet Portal',
      endpoint: 'https://{param}/api/v1/orders',
    }))).toBe('Fleet Portal');
  });

  it('uses a literal endpoint host when the analyzer reports an unresolved identity', () => {
    expect(externalServiceIdentityForExitPoint(exitPoint({
      service_id: 'external_api',
      endpoint: 'https://billing.example.test/invoices',
    }))).toBe('billing.example.test');
  });

  it('does not promote a transport library when service identity is unresolved', () => {
    expect(externalServiceIdentityForExitPoint(exitPoint({
      service_id: 'soap_service',
      sdk: 'zeep/suds',
      endpoint: 'Ping',
    }))).toBeUndefined();
  });
});
