import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Observable, Subject, interval } from 'rxjs';
import { map, filter } from 'rxjs/operators';

export interface TelemetryData {
  nodeId: string;
  metric: string;
  value: number;
  timestamp: number;
  status: 'healthy' | 'warning' | 'error';
  metadata?: Record<string, any>;
}

export interface TelemetryStream {
  nodeId: string;
  metrics: {
    cpu?: number;
    memory?: number;
    requestCount?: number;
    errorRate?: number;
    responseTime?: number;
    throughput?: number;
  };
  connections: {
    connectionId: string;
    dataFlow: number;
    latency: number;
  }[];
  alerts: {
    type: string;
    severity: 'info' | 'warning' | 'error';
    message: string;
  }[];
}

@Injectable()
export class TelemetryOverlayService {
  private telemetrySubject = new Subject<TelemetryData>();
  private streamSubject = new Subject<TelemetryStream>();
  private metricsCache = new Map<string, TelemetryData[]>();
  private thresholds = new Map<string, { warning: number; error: number }>();

  constructor(private eventEmitter: EventEmitter2) {
    this.initializeThresholds();
    this.startMetricsCollection();
  }

  private initializeThresholds(): void {
    // Default thresholds for various metrics
    this.thresholds.set('cpu', { warning: 70, error: 90 });
    this.thresholds.set('memory', { warning: 75, error: 90 });
    this.thresholds.set('errorRate', { warning: 0.05, error: 0.1 });
    this.thresholds.set('responseTime', { warning: 1000, error: 3000 });
    this.thresholds.set('throughput', { warning: 100, error: 50 });
  }

  private startMetricsCollection(): void {
    // Simulate real-time metrics collection
    interval(1000).subscribe(() => {
      this.collectSystemMetrics();
    });

    // Listen for actual telemetry events
    this.eventEmitter.on('telemetry.metric', (data: TelemetryData) => {
      this.processTelemetryData(data);
    });

    this.eventEmitter.on('telemetry.trace', (trace: any) => {
      this.processTraceData(trace);
    });
  }

  private collectSystemMetrics(): void {
    // This would connect to actual monitoring systems
    // For now, simulating with realistic patterns
  }

  processTelemetryData(data: TelemetryData): void {
    // Determine status based on thresholds
    const threshold = this.thresholds.get(data.metric);
    if (threshold) {
      if (data.value >= threshold.error) {
        data.status = 'error';
      } else if (data.value >= threshold.warning) {
        data.status = 'warning';
      } else {
        data.status = 'healthy';
      }
    }

    // Cache the data
    if (!this.metricsCache.has(data.nodeId)) {
      this.metricsCache.set(data.nodeId, []);
    }
    const cache = this.metricsCache.get(data.nodeId)!;
    cache.push(data);
    
    // Keep only last 100 entries per node
    if (cache.length > 100) {
      cache.shift();
    }

    // Emit to subscribers
    this.telemetrySubject.next(data);

    // Check for anomalies
    this.detectAnomalies(data);
  }

  private processTraceData(trace: any): void {
    // Process distributed trace data
    if (trace.spans) {
      trace.spans.forEach((span: any) => {
        const telemetryData: TelemetryData = {
          nodeId: span.service || span.component,
          metric: 'latency',
          value: span.duration,
          timestamp: span.timestamp,
          status: span.duration > 1000 ? 'warning' : 'healthy',
          metadata: {
            spanId: span.id,
            traceId: trace.id,
            operation: span.operation,
          },
        };
        this.processTelemetryData(telemetryData);
      });
    }
  }

  private detectAnomalies(data: TelemetryData): void {
    const cache = this.metricsCache.get(data.nodeId);
    if (!cache || cache.length < 10) return;

    // Simple anomaly detection using statistical methods
    const recentValues = cache.slice(-10).map(d => d.value);
    const mean = recentValues.reduce((a, b) => a + b) / recentValues.length;
    const variance = recentValues.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / recentValues.length;
    const stdDev = Math.sqrt(variance);

    // Check if current value is an anomaly (> 3 standard deviations)
    if (Math.abs(data.value - mean) > 3 * stdDev) {
      this.eventEmitter.emit('telemetry.anomaly', {
        nodeId: data.nodeId,
        metric: data.metric,
        value: data.value,
        mean,
        stdDev,
        severity: Math.abs(data.value - mean) > 4 * stdDev ? 'error' : 'warning',
      });
    }
  }

  getTelemetryStream(): Observable<TelemetryData> {
    return this.telemetrySubject.asObservable();
  }

  getNodeMetrics(nodeId: string): TelemetryData[] {
    return this.metricsCache.get(nodeId) || [];
  }

  getSystemHealth(): Map<string, 'healthy' | 'warning' | 'error'> {
    const health = new Map<string, 'healthy' | 'warning' | 'error'>();
    
    this.metricsCache.forEach((metrics, nodeId) => {
      if (metrics.length === 0) {
        health.set(nodeId, 'healthy');
        return;
      }

      const latestMetric = metrics[metrics.length - 1];
      health.set(nodeId, latestMetric.status);
    });

    return health;
  }

  simulateTraffic(connectionId: string, source: string, target: string): void {
    // Simulate data flowing through a connection
    const trafficData: TelemetryData = {
      nodeId: source,
      metric: 'outbound_traffic',
      value: Math.random() * 1000,
      timestamp: Date.now(),
      status: 'healthy',
      metadata: {
        connectionId,
        target,
        protocol: 'http',
        dataSize: Math.floor(Math.random() * 10000),
      },
    };

    this.processTelemetryData(trafficData);

    // Also update target node
    const targetData: TelemetryData = {
      nodeId: target,
      metric: 'inbound_traffic',
      value: trafficData.value,
      timestamp: Date.now(),
      status: 'healthy',
      metadata: {
        connectionId,
        source,
        protocol: 'http',
        dataSize: trafficData.metadata?.dataSize,
      },
    };

    this.processTelemetryData(targetData);
  }

  generateHeatMap(metric: string): Map<string, number> {
    const heatMap = new Map<string, number>();
    
    this.metricsCache.forEach((metrics, nodeId) => {
      const relevantMetrics = metrics.filter(m => m.metric === metric);
      if (relevantMetrics.length > 0) {
        const avgValue = relevantMetrics.reduce((sum, m) => sum + m.value, 0) / relevantMetrics.length;
        heatMap.set(nodeId, avgValue);
      }
    });

    return heatMap;
  }

  getBottlenecks(): Array<{ nodeId: string; metric: string; severity: number }> {
    const bottlenecks: Array<{ nodeId: string; metric: string; severity: number }> = [];

    this.metricsCache.forEach((metrics, nodeId) => {
      // Check for high response times
      const responseTimeMetrics = metrics.filter(m => m.metric === 'responseTime');
      if (responseTimeMetrics.length > 0) {
        const avgResponseTime = responseTimeMetrics.reduce((sum, m) => sum + m.value, 0) / responseTimeMetrics.length;
        if (avgResponseTime > 1000) {
          bottlenecks.push({
            nodeId,
            metric: 'responseTime',
            severity: avgResponseTime / 1000,
          });
        }
      }

      // Check for high error rates
      const errorRateMetrics = metrics.filter(m => m.metric === 'errorRate');
      if (errorRateMetrics.length > 0) {
        const avgErrorRate = errorRateMetrics.reduce((sum, m) => sum + m.value, 0) / errorRateMetrics.length;
        if (avgErrorRate > 0.05) {
          bottlenecks.push({
            nodeId,
            metric: 'errorRate',
            severity: avgErrorRate * 100,
          });
        }
      }

      // Check for high CPU usage
      const cpuMetrics = metrics.filter(m => m.metric === 'cpu');
      if (cpuMetrics.length > 0) {
        const avgCpu = cpuMetrics.reduce((sum, m) => sum + m.value, 0) / cpuMetrics.length;
        if (avgCpu > 70) {
          bottlenecks.push({
            nodeId,
            metric: 'cpu',
            severity: avgCpu / 100,
          });
        }
      }
    });

    return bottlenecks.sort((a, b) => b.severity - a.severity);
  }

  identifyUnusedComponents(): string[] {
    const unusedNodes: string[] = [];
    const now = Date.now();

    this.metricsCache.forEach((metrics, nodeId) => {
      if (metrics.length === 0) {
        unusedNodes.push(nodeId);
      } else {
        const lastActivity = metrics[metrics.length - 1].timestamp;
        // Consider unused if no activity in last hour
        if (now - lastActivity > 3600000) {
          unusedNodes.push(nodeId);
        }
      }
    });

    return unusedNodes;
  }

  trackUserJourney(sessionId: string, path: string[]): void {
    // Track user journey through the system
    path.forEach((nodeId, index) => {
      const journeyData: TelemetryData = {
        nodeId,
        metric: 'user_journey',
        value: index,
        timestamp: Date.now(),
        status: 'healthy',
        metadata: {
          sessionId,
          step: index,
          totalSteps: path.length,
          nextNode: index < path.length - 1 ? path[index + 1] : null,
        },
      };

      this.processTelemetryData(journeyData);
    });
  }

  getActiveFlows(): Array<{ from: string; to: string; volume: number }> {
    const flows: Array<{ from: string; to: string; volume: number }> = [];
    const flowMap = new Map<string, number>();

    this.metricsCache.forEach((metrics, nodeId) => {
      metrics
        .filter(m => m.metadata?.connectionId)
        .forEach(m => {
          const key = `${nodeId}-${m.metadata.target || m.metadata.source}`;
          flowMap.set(key, (flowMap.get(key) || 0) + 1);
        });
    });

    flowMap.forEach((volume, key) => {
      const [from, to] = key.split('-');
      if (from && to) {
        flows.push({ from, to, volume });
      }
    });

    return flows.sort((a, b) => b.volume - a.volume);
  }

  clearMetrics(nodeId?: string): void {
    if (nodeId) {
      this.metricsCache.delete(nodeId);
    } else {
      this.metricsCache.clear();
    }
  }

  setThreshold(metric: string, warning: number, error: number): void {
    this.thresholds.set(metric, { warning, error });
  }

  exportMetrics(): any {
    const exportData: any = {
      timestamp: Date.now(),
      nodes: {},
    };

    this.metricsCache.forEach((metrics, nodeId) => {
      exportData.nodes[nodeId] = {
        metrics: metrics.slice(-50), // Last 50 metrics per node
        health: this.getNodeHealth(nodeId),
        summary: this.getNodeSummary(nodeId),
      };
    });

    return exportData;
  }

  private getNodeHealth(nodeId: string): 'healthy' | 'warning' | 'error' {
    const metrics = this.metricsCache.get(nodeId);
    if (!metrics || metrics.length === 0) return 'healthy';

    const recentMetrics = metrics.slice(-10);
    const hasError = recentMetrics.some(m => m.status === 'error');
    const hasWarning = recentMetrics.some(m => m.status === 'warning');

    if (hasError) return 'error';
    if (hasWarning) return 'warning';
    return 'healthy';
  }

  private getNodeSummary(nodeId: string): any {
    const metrics = this.metricsCache.get(nodeId);
    if (!metrics || metrics.length === 0) return null;

    const summary: any = {};
    const metricTypes = new Set(metrics.map(m => m.metric));

    metricTypes.forEach(metricType => {
      const typeMetrics = metrics.filter(m => m.metric === metricType);
      const values = typeMetrics.map(m => m.value);
      
      summary[metricType] = {
        min: Math.min(...values),
        max: Math.max(...values),
        avg: values.reduce((a, b) => a + b) / values.length,
        last: values[values.length - 1],
        count: values.length,
      };
    });

    return summary;
  }
}