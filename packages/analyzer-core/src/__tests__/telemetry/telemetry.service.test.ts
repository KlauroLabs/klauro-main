import { TelemetryService } from '../../telemetry/services/telemetry.service';
import { EventAggregator } from '../../telemetry/services/event-aggregator.service';
import { MetricsCalculator } from '../../telemetry/services/metrics-calculator.service';
import {
  FlowStatus,
  TelemetryBatch,
  TelemetryEventType,
} from '../../telemetry/types/telemetry.types';

describe('TelemetryService runtime store', () => {
  const projectId = '11111111-1111-4111-8111-111111111111';
  const organizationId = '22222222-2222-4222-8222-222222222222';

  function createService() {
    return new TelemetryService(
      null,
      null,
      new EventAggregator(),
      new MetricsCalculator(),
    );
  }

  function createBatch(): TelemetryBatch {
    return {
      projectId,
      organizationId,
      timestamp: 1700000000000,
      metadata: {
        sdkVersion: '1.0.0',
        runtime: 'node',
        hostname: 'localhost',
        environment: 'test',
      },
      events: [
        {
          id: 'event-request',
          type: TelemetryEventType.REQUEST_FLOW,
          timestamp: 1700000000001,
          data: {
            requestFlow: {
              id: '33333333-3333-4333-8333-333333333333',
              traceId: 'trace-1',
              spanId: 'span-1',
              projectId,
              componentId: 'controller:users',
              path: ['controller:users', 'service:users'],
              method: 'GET',
              endpoint: '/users',
              timestamp: 1700000000001,
              duration: 42,
              status: FlowStatus.COMPLETED,
              tags: ['entry:http'],
            },
          },
        },
        {
          id: 'event-performance',
          type: TelemetryEventType.PERFORMANCE_METRICS,
          timestamp: 1700000000002,
          data: {
            performanceMetrics: {
              componentId: 'service:users',
              projectId,
              timestamp: 1700000000002,
              cpu: 25,
              memory: 40,
              heapUsed: 120,
              heapTotal: 256,
              requestsPerSecond: 10,
              averageLatency: 50,
              p50Latency: 40,
              p95Latency: 90,
              p99Latency: 120,
              errorRate: 0,
              throughput: 10,
              activeRequests: 2,
              queuedRequests: 0,
            },
          },
        },
      ],
    };
  }

  it('keeps recent telemetry and aggregates metrics without Redis or database', async () => {
    const service = createService();

    await service.processBatch(createBatch());

    const recent = await service.getRecentTelemetry(projectId, 10);
    const aggregation = await service.getAggregatedMetrics(projectId, '1m');
    const metrics = await service.getProjectMetrics(projectId);

    expect(recent).toHaveLength(2);
    expect(recent.map(event => event.componentId)).toEqual(
      expect.arrayContaining(['controller:users', 'service:users']),
    );
    expect(aggregation?.metrics.requestCount).toBe(1);
    expect(aggregation?.metrics.availability).toBe(100);
    expect(metrics.trace.count).toBe(1);
    expect(metrics.metric.count).toBe(1);
  });

  it('returns telemetry in reverse chronological order with limits applied', async () => {
    const service = createService();

    await service.processBatch(createBatch());

    const recent = await service.getRecentTelemetry(projectId, 1);

    expect(recent).toHaveLength(1);
    expect(recent[0].timestamp.getTime()).toBe(1700000000002);
  });

  it('stores CAS runtime events with queryable correlation fields', async () => {
    const service = createService();

    await service.ingestRuntimeEvent({
      projectId,
      organizationId,
      event: {
        type: 'request',
        timestamp: '2024-01-01T00:00:00.000Z',
        entry_point_id: 'entry-users-index',
        trace_id: 'trace-cas-1',
        span_id: 'span-cas-1',
        method: 'GET',
        route: '/users',
        duration_ms: 15,
        status_code: 200,
      },
    });

    const recent = await service.getRecentTelemetry(projectId, 1);

    expect(recent).toHaveLength(1);
    expect(recent[0].componentId).toBe('entry-users-index');
    expect(recent[0].tags).toEqual(expect.arrayContaining(['cas-runtime', 'entry:entry-users-index']));
    expect(recent[0].attributes).toMatchObject({
      entryPointId: 'entry-users-index',
      traceId: 'trace-cas-1',
      route: '/users',
    });
  });

  it('rejects CAS runtime events without correlation evidence', async () => {
    const service = createService();

    await expect(service.ingestRuntimeEvent({
      projectId,
      organizationId,
      event: {
        type: 'custom',
        timestamp: '2024-01-01T00:00:00.000Z',
      },
    })).rejects.toThrow('Runtime event must include at least one CAS id, signal, route, path, or stack trace.');
  });
});
