import { Injectable, Logger } from '@nestjs/common';
import { TelemetryBatch, TelemetryEvent, TelemetryEventType } from '../types/telemetry.types';

export interface CalculatedMetrics {
  requestCount: number;
  errorCount: number;
  avgLatency: number;
  avgCpu: number;
  avgMemory: number;
  availability: number;
  p95Latency: number;
  p99Latency: number;
  throughput: number;
  errorRate: number;
}

interface HotspotInfo {
  componentId: string;
  cpuScore: number;
  memoryScore: number;
  latencyScore: number;
  overallScore: number;
  indicators: string[];
}

@Injectable()
export class MetricsCalculator {
  private readonly logger = new Logger(MetricsCalculator.name);
  private readonly historicalData: Map<string, number[]> = new Map();
  private readonly HISTORY_SIZE = 100;
  
  // Thresholds for anomaly detection (μ + 2σ)
  private readonly LATENCY_THRESHOLD_MULTIPLIER = 2;
  private readonly CPU_THRESHOLD = 80;
  private readonly MEMORY_THRESHOLD = 85;
  private readonly ERROR_RATE_THRESHOLD = 0.05; // 5%

  async calculate(batch: TelemetryBatch): Promise<CalculatedMetrics> {
    const metrics: CalculatedMetrics = {
      requestCount: 0,
      errorCount: 0,
      avgLatency: 0,
      avgCpu: 0,
      avgMemory: 0,
      availability: 100,
      p95Latency: 0,
      p99Latency: 0,
      throughput: 0,
      errorRate: 0,
    };

    const latencies: number[] = [];
    const cpuValues: number[] = [];
    const memoryValues: number[] = [];
    let successCount = 0;
    let totalCount = 0;

    for (const event of batch.events) {
      // Process request flow events
      if (event.data.requestFlow) {
        totalCount++;
        const flow = event.data.requestFlow;
        
        if (flow.duration) {
          latencies.push(flow.duration);
        }
        
        if (flow.status === 'completed') {
          successCount++;
        } else if (flow.status === 'failed') {
          metrics.errorCount++;
        }
        
        metrics.requestCount++;
      }

      // Process performance metrics
      if (event.data.performanceMetrics) {
        const perf = event.data.performanceMetrics;
        cpuValues.push(perf.cpu);
        memoryValues.push(perf.memory);
        
        if (perf.averageLatency) {
          latencies.push(perf.averageLatency);
        }
        if (perf.errorRate) {
          metrics.errorRate = Math.max(metrics.errorRate, perf.errorRate);
        }
      }

      // Process issues
      if (event.data.issues) {
        for (const issue of event.data.issues) {
          if (issue.type === 'error' || issue.severity === 'critical') {
            metrics.errorCount++;
          }
        }
      }
    }

    // Calculate aggregated metrics
    if (latencies.length > 0) {
      metrics.avgLatency = this.calculateAverage(latencies);
      metrics.p95Latency = this.calculatePercentile(latencies, 95);
      metrics.p99Latency = this.calculatePercentile(latencies, 99);
    }

    if (cpuValues.length > 0) {
      metrics.avgCpu = this.calculateAverage(cpuValues);
    }

    if (memoryValues.length > 0) {
      metrics.avgMemory = this.calculateAverage(memoryValues);
    }

    if (totalCount > 0) {
      metrics.availability = (successCount / totalCount) * 100;
      metrics.errorRate = metrics.errorCount / totalCount;
    }

    // Calculate throughput (requests per second)
    const timeRange = this.getTimeRange(batch.events);
    if (timeRange > 0) {
      metrics.throughput = (metrics.requestCount / timeRange) * 1000; // Convert to per second
    }

    // Store historical data for anomaly detection
    this.updateHistoricalData(batch.projectId, metrics);

    return metrics;
  }

  async detectHotspots(events: TelemetryEvent[]): Promise<HotspotInfo[]> {
    const componentMetrics = new Map<string, {
      cpu: number[];
      memory: number[];
      latency: number[];
      errors: number;
      requests: number;
    }>();

    // Collect metrics by component
    for (const event of events) {
      let componentId: string | null = null;

      if (event.data.performanceMetrics) {
        componentId = event.data.performanceMetrics.componentId;
        if (!componentMetrics.has(componentId)) {
          componentMetrics.set(componentId, {
            cpu: [],
            memory: [],
            latency: [],
            errors: 0,
            requests: 0,
          });
        }

        const metrics = componentMetrics.get(componentId)!;
        const perf = event.data.performanceMetrics;
        
        metrics.cpu.push(perf.cpu);
        metrics.memory.push(perf.memory);
        metrics.latency.push(perf.averageLatency);
        metrics.errors += perf.errorRate * perf.activeRequests;
        metrics.requests += perf.activeRequests;
      }

      if (event.data.requestFlow) {
        componentId = event.data.requestFlow.componentId;
        if (!componentMetrics.has(componentId)) {
          componentMetrics.set(componentId, {
            cpu: [],
            memory: [],
            latency: [],
            errors: 0,
            requests: 0,
          });
        }

        const metrics = componentMetrics.get(componentId)!;
        metrics.requests++;
        
        if (event.data.requestFlow.duration) {
          metrics.latency.push(event.data.requestFlow.duration);
        }
        
        if (event.data.requestFlow.status === 'failed') {
          metrics.errors++;
        }
      }
    }

    // Calculate hotspot scores
    const hotspots: HotspotInfo[] = [];
    
    for (const [componentId, metrics] of componentMetrics.entries()) {
      const cpuScore = this.calculateHotspotScore(
        metrics.cpu,
        this.CPU_THRESHOLD,
        'CPU'
      );
      
      const memoryScore = this.calculateHotspotScore(
        metrics.memory,
        this.MEMORY_THRESHOLD,
        'Memory'
      );
      
      const latencyScore = this.calculateLatencyScore(metrics.latency);
      
      const errorRate = metrics.requests > 0 ? metrics.errors / metrics.requests : 0;
      const errorScore = errorRate > this.ERROR_RATE_THRESHOLD ? 1 : errorRate / this.ERROR_RATE_THRESHOLD;
      
      const overallScore = (cpuScore + memoryScore + latencyScore + errorScore) / 4;
      
      if (overallScore > 0.5) { // Threshold for considering as hotspot
        const indicators: string[] = [];
        
        if (cpuScore > 0.7) indicators.push(`High CPU: ${this.calculateAverage(metrics.cpu).toFixed(1)}%`);
        if (memoryScore > 0.7) indicators.push(`High Memory: ${this.calculateAverage(metrics.memory).toFixed(1)}%`);
        if (latencyScore > 0.7) indicators.push(`High Latency: ${this.calculateAverage(metrics.latency).toFixed(0)}ms`);
        if (errorScore > 0.7) indicators.push(`High Error Rate: ${(errorRate * 100).toFixed(2)}%`);
        
        hotspots.push({
          componentId,
          cpuScore,
          memoryScore,
          latencyScore,
          overallScore,
          indicators,
        });
      }
    }

    // Sort by overall score
    hotspots.sort((a, b) => b.overallScore - a.overallScore);
    
    return hotspots;
  }

  async detectBottlenecks(events: TelemetryEvent[]): Promise<any[]> {
    const bottlenecks: any[] = [];
    const queueDepths = new Map<string, number[]>();
    const waitTimes = new Map<string, number[]>();

    for (const event of events) {
      if (event.data.performanceMetrics) {
        const perf = event.data.performanceMetrics;
        const componentId = perf.componentId;

        // Check for queue buildup (using Little's Law)
        if (perf.queuedRequests > 0) {
          if (!queueDepths.has(componentId)) {
            queueDepths.set(componentId, []);
          }
          queueDepths.get(componentId)!.push(perf.queuedRequests);

          // Calculate wait time using Little's Law: W = L/λ
          const arrivalRate = perf.requestsPerSecond;
          if (arrivalRate > 0) {
            const waitTime = perf.queuedRequests / arrivalRate;
            if (!waitTimes.has(componentId)) {
              waitTimes.set(componentId, []);
            }
            waitTimes.get(componentId)!.push(waitTime * 1000); // Convert to ms
          }
        }

        // Check for saturation
        if (perf.cpu > 90 || perf.memory > 90) {
          bottlenecks.push({
            type: 'resource_saturation',
            componentId,
            severity: 'high',
            details: {
              cpu: perf.cpu,
              memory: perf.memory,
              timestamp: perf.timestamp,
            },
          });
        }
      }

      // Check database query bottlenecks
      if (event.data.databaseQuery) {
        const query = event.data.databaseQuery;
        if (query.duration > 1000) { // Queries taking more than 1 second
          bottlenecks.push({
            type: 'slow_query',
            componentId: query.componentId,
            severity: query.duration > 5000 ? 'high' : 'medium',
            details: {
              operation: query.operation,
              table: query.table,
              duration: query.duration,
              timestamp: query.timestamp,
            },
          });
        }
      }
    }

    // Analyze queue depths for bottlenecks
    for (const [componentId, depths] of queueDepths.entries()) {
      const avgQueueDepth = this.calculateAverage(depths);
      const maxQueueDepth = Math.max(...depths);
      
      if (avgQueueDepth > 10 || maxQueueDepth > 50) {
        const avgWaitTime = waitTimes.has(componentId) 
          ? this.calculateAverage(waitTimes.get(componentId)!)
          : 0;

        bottlenecks.push({
          type: 'queue_buildup',
          componentId,
          severity: maxQueueDepth > 100 ? 'high' : 'medium',
          details: {
            avgQueueDepth,
            maxQueueDepth,
            avgWaitTime,
            samples: depths.length,
          },
        });
      }
    }

    return bottlenecks;
  }

  private calculateHotspotScore(values: number[], threshold: number, type: string): number {
    if (values.length === 0) return 0;

    const avg = this.calculateAverage(values);
    const stdDev = this.calculateStandardDeviation(values, avg);
    const dynamicThreshold = avg + (this.LATENCY_THRESHOLD_MULTIPLIER * stdDev);

    // Score based on how much the average exceeds the threshold
    if (avg >= threshold) {
      return Math.min(1, avg / 100); // Normalize to 0-1
    }

    // Check for anomalies
    const anomalies = values.filter(v => v > dynamicThreshold).length;
    const anomalyRate = anomalies / values.length;

    return anomalyRate;
  }

  private calculateLatencyScore(latencies: number[]): number {
    if (latencies.length === 0) return 0;

    const avg = this.calculateAverage(latencies);
    const stdDev = this.calculateStandardDeviation(latencies, avg);
    const dynamicThreshold = avg + (this.LATENCY_THRESHOLD_MULTIPLIER * stdDev);

    // Score based on percentiles and variance
    const p95 = this.calculatePercentile(latencies, 95);
    const p99 = this.calculatePercentile(latencies, 99);

    let score = 0;
    if (p99 > 1000) score += 0.5; // Over 1 second at p99
    if (p95 > 500) score += 0.3; // Over 500ms at p95
    if (avg > 200) score += 0.2; // Over 200ms average

    // Check for high variance (unstable performance)
    const coefficientOfVariation = stdDev / avg;
    if (coefficientOfVariation > 1) {
      score = Math.min(1, score + 0.3);
    }

    return Math.min(1, score);
  }

  private calculateAverage(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  private calculateStandardDeviation(values: number[], mean?: number): number {
    if (values.length === 0) return 0;
    
    const avg = mean ?? this.calculateAverage(values);
    const squaredDiffs = values.map(v => Math.pow(v - avg, 2));
    const variance = this.calculateAverage(squaredDiffs);
    
    return Math.sqrt(variance);
  }

  private calculatePercentile(values: number[], percentile: number): number {
    if (values.length === 0) return 0;
    
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    
    return sorted[Math.max(0, index)];
  }

  private getTimeRange(events: TelemetryEvent[]): number {
    if (events.length === 0) return 0;
    
    const timestamps = events.map(e => e.timestamp);
    const min = Math.min(...timestamps);
    const max = Math.max(...timestamps);
    
    return max - min;
  }

  private updateHistoricalData(projectId: string, metrics: CalculatedMetrics): void {
    const key = `${projectId}:latency`;
    if (!this.historicalData.has(key)) {
      this.historicalData.set(key, []);
    }

    const history = this.historicalData.get(key)!;
    history.push(metrics.avgLatency);

    // Keep only recent history
    if (history.length > this.HISTORY_SIZE) {
      history.shift();
    }
  }

  detectMemoryLeak(events: TelemetryEvent[]): boolean {
    const memoryReadings: { timestamp: number; value: number }[] = [];

    for (const event of events) {
      if (event.data.performanceMetrics) {
        memoryReadings.push({
          timestamp: event.timestamp,
          value: event.data.performanceMetrics.heapUsed,
        });
      }
    }

    if (memoryReadings.length < 10) return false;

    // Sort by timestamp
    memoryReadings.sort((a, b) => a.timestamp - b.timestamp);

    // Calculate linear regression to detect upward trend
    const n = memoryReadings.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;

    for (let i = 0; i < n; i++) {
      const x = i; // Use index as x for simplicity
      const y = memoryReadings[i].value;
      
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumX2 += x * x;
    }

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const avgMemory = sumY / n;

    // If slope is positive and significant (> 1% of average per reading), likely a leak
    return slope > avgMemory * 0.01;
  }
}