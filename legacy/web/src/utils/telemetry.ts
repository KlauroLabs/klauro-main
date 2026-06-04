import { AggregatedTelemetryResponse, TelemetryEventRecord } from '../services/api';

export type RuntimeHealth = 'healthy' | 'warning' | 'error';

export interface RuntimeTelemetryData {
  nodeId: string;
  metrics: TelemetryEventRecord[];
  health: RuntimeHealth;
}

export function buildTelemetryMap(events: TelemetryEventRecord[]): Map<string, RuntimeTelemetryData> {
  const result = new Map<string, RuntimeTelemetryData>();

  for (const event of events) {
    const nodeId = getEventComponentId(event);
    if (!nodeId) continue;

    const current = result.get(nodeId) || {
      nodeId,
      metrics: [],
      health: 'healthy' as RuntimeHealth,
    };

    current.metrics.push(event);
    current.health = maxHealth(current.health, getEventHealth(event));
    result.set(nodeId, current);
  }

  return result;
}

export function summarizeSystemHealth(aggregation: AggregatedTelemetryResponse | null) {
  if (!aggregation) return null;

  const { metrics } = aggregation;
  const health: RuntimeHealth = metrics.availability < 95 || metrics.errorCount > 0
    ? 'error'
    : metrics.avgLatency > 1000 || metrics.avgCpu > 80 || metrics.avgMemory > 85
      ? 'warning'
      : 'healthy';

  return {
    health,
    requestCount: metrics.requestCount,
    errorCount: metrics.errorCount,
    avgLatency: metrics.avgLatency,
    avgCpu: metrics.avgCpu,
    avgMemory: metrics.avgMemory,
    availability: metrics.availability,
    timestamp: aggregation.timestamp,
  };
}

function getEventComponentId(event: TelemetryEventRecord): string | undefined {
  return event.componentId ||
    event.data?.performanceMetrics?.componentId ||
    event.data?.requestFlow?.componentId ||
    event.data?.componentStatus?.componentId ||
    event.data?.issues?.[0]?.componentId ||
    event.data?.databaseQuery?.componentId ||
    event.data?.messageQueue?.componentId;
}

function getEventHealth(event: TelemetryEventRecord): RuntimeHealth {
  const performance = event.data?.performanceMetrics;
  if (performance) {
    if (performance.errorRate > 5 || performance.cpu > 95 || performance.memory > 95) return 'error';
    if (performance.errorRate > 0 || performance.cpu > 80 || performance.memory > 85 || performance.averageLatency > 1000) return 'warning';
  }

  const status = event.data?.componentStatus;
  if (status) {
    if (status.status === 'critical' || status.status === 'offline' || status.health < 50) return 'error';
    if (status.status === 'degraded' || status.health < 80) return 'warning';
  }

  const issues = event.data?.issues || [];
  if (issues.some((issue: any) => issue.severity === 'critical' || issue.type === 'error')) return 'error';
  if (issues.length > 0) return 'warning';

  const requestFlow = event.data?.requestFlow;
  if (requestFlow) {
    if (requestFlow.status === 'failed' || requestFlow.status === 'timeout') return 'error';
    if (requestFlow.duration > 1000) return 'warning';
  }

  return 'healthy';
}

function maxHealth(a: RuntimeHealth, b: RuntimeHealth): RuntimeHealth {
  const order: Record<RuntimeHealth, number> = {
    healthy: 0,
    warning: 1,
    error: 2,
  };

  return order[b] > order[a] ? b : a;
}
