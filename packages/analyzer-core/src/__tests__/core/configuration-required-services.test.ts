import { describe, expect, it } from '@jest/globals';
import type { CASExitPoint, CASExternalService } from '../../types/cas.types';
import { buildRequiredServices } from '../../analyzer/core/configuration-required-services';

describe('buildRequiredServices', () => {
  it('uses external-service rollups instead of treating SDK methods as deployable services', () => {
    const exitPoints = [
      { id: 'date', source_node: 'n1', type: 'sdk', name: 'Call to datetime.strptime', target: { sdk: 'datetime', endpoint: 'strptime' } },
      { id: 'http', source_node: 'n2', type: 'sdk', name: 'Call to requests.post', target: { sdk: 'requests', endpoint: 'post' } },
    ] as CASExitPoint[];
    const externalServices = [
      { id: 'fleet', name: 'Fleet Portal', type: 'api' },
    ] as CASExternalService[];

    expect(buildRequiredServices(exitPoints, externalServices)).toEqual([
      { service: 'Fleet Portal', optional: false },
    ]);
  });

  it('deduplicates message infrastructure and keeps required evidence dominant', () => {
    const exitPoints = [
      { id: 'm1', source_node: 'n1', type: 'message', name: 'publish', target: { service_id: 'celery' } },
      { id: 'm2', source_node: 'n2', type: 'message', name: 'publish', target: { service_id: 'Celery' } },
      { id: 'm3', source_node: 'n3', type: 'message', name: 'publish' },
    ] as CASExitPoint[];

    expect(buildRequiredServices(exitPoints, [])).toEqual([
      { service: 'celery', optional: false },
      { service: 'message_queue', optional: false },
    ]);
  });
});
