import { Injectable, Logger } from '@nestjs/common';
import { TelemetryEvent, TelemetryEventType, PerformanceMetrics } from '../types/telemetry.types';

interface AggregationWindow {
  startTime: number;
  endTime: number;
  events: TelemetryEvent[];
  aggregated?: any;
}

@Injectable()
export class EventAggregator {
  private readonly logger = new Logger(EventAggregator.name);
  private readonly AGGREGATION_WINDOW = 100; // 100ms window
  private readonly MAX_EVENTS_PER_WINDOW = 1000;
  private windows: Map<string, AggregationWindow> = new Map();

  async aggregate(events: TelemetryEvent[]): Promise<TelemetryEvent[]> {
    if (!events || events.length === 0) {
      return [];
    }

    // Group events by type for efficient aggregation
    const eventsByType = this.groupEventsByType(events);
    const aggregatedEvents: TelemetryEvent[] = [];

    for (const [type, typeEvents] of eventsByType.entries()) {
      switch (type) {
        case TelemetryEventType.PERFORMANCE_METRICS:
          aggregatedEvents.push(...this.aggregatePerformanceMetrics(typeEvents));
          break;
        case TelemetryEventType.REQUEST_FLOW:
          aggregatedEvents.push(...this.aggregateRequestFlows(typeEvents));
          break;
        case TelemetryEventType.DATABASE_QUERY:
          aggregatedEvents.push(...this.aggregateDatabaseQueries(typeEvents));
          break;
        case TelemetryEventType.MESSAGE_QUEUE:
          aggregatedEvents.push(...this.aggregateMessageQueues(typeEvents));
          break;
        default:
          // For other types, apply basic deduplication
          aggregatedEvents.push(...this.deduplicateEvents(typeEvents));
      }
    }

    return aggregatedEvents;
  }

  private groupEventsByType(events: TelemetryEvent[]): Map<TelemetryEventType, TelemetryEvent[]> {
    const grouped = new Map<TelemetryEventType, TelemetryEvent[]>();
    
    for (const event of events) {
      const type = event.type as TelemetryEventType;
      if (!grouped.has(type)) {
        grouped.set(type, []);
      }
      grouped.get(type).push(event);
    }

    return grouped;
  }

  private aggregatePerformanceMetrics(events: TelemetryEvent[]): TelemetryEvent[] {
    if (events.length === 0) return [];

    // Group by component and time window
    const windows = new Map<string, TelemetryEvent[]>();
    
    for (const event of events) {
      const metrics = event.data.performanceMetrics;
      if (!metrics) continue;

      const windowKey = `${metrics.componentId}:${Math.floor(event.timestamp / this.AGGREGATION_WINDOW)}`;
      if (!windows.has(windowKey)) {
        windows.set(windowKey, []);
      }
      windows.get(windowKey).push(event);
    }

    // Aggregate each window
    const aggregated: TelemetryEvent[] = [];
    for (const [windowKey, windowEvents] of windows.entries()) {
      const [componentId] = windowKey.split(':');
      const aggregatedMetrics = this.calculateAggregatedMetrics(windowEvents);
      
      aggregated.push({
        id: `agg-${windowKey}-${Date.now()}`,
        type: TelemetryEventType.PERFORMANCE_METRICS,
        timestamp: windowEvents[0].timestamp,
        data: {
          performanceMetrics: {
            ...aggregatedMetrics,
            componentId,
            projectId: windowEvents[0].data.performanceMetrics.projectId,
            timestamp: windowEvents[0].timestamp,
          },
        },
      });
    }

    return aggregated;
  }

  private calculateAggregatedMetrics(events: TelemetryEvent[]): Partial<PerformanceMetrics> {
    const metrics: number[][] = [];
    
    // Extract all metrics
    for (const event of events) {
      const m = event.data.performanceMetrics;
      if (m) {
        metrics.push([
          m.cpu,
          m.memory,
          m.requestsPerSecond,
          m.averageLatency,
          m.p50Latency,
          m.p95Latency,
          m.p99Latency,
          m.errorRate,
          m.throughput,
        ]);
      }
    }

    if (metrics.length === 0) {
      return {};
    }

    // Calculate averages
    const avgMetrics = metrics[0].map((_, i) => {
      const values = metrics.map(m => m[i]).filter(v => !isNaN(v));
      return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    });

    return {
      cpu: avgMetrics[0],
      memory: avgMetrics[1],
      requestsPerSecond: avgMetrics[2],
      averageLatency: avgMetrics[3],
      p50Latency: avgMetrics[4],
      p95Latency: avgMetrics[5],
      p99Latency: avgMetrics[6],
      errorRate: avgMetrics[7],
      throughput: avgMetrics[8],
    };
  }

  private aggregateRequestFlows(events: TelemetryEvent[]): TelemetryEvent[] {
    // Group by trace ID to maintain request context
    const traceGroups = new Map<string, TelemetryEvent[]>();
    
    for (const event of events) {
      const flow = event.data.requestFlow;
      if (!flow) continue;

      if (!traceGroups.has(flow.traceId)) {
        traceGroups.set(flow.traceId, []);
      }
      traceGroups.get(flow.traceId).push(event);
    }

    // Keep only the most recent event for each trace
    const aggregated: TelemetryEvent[] = [];
    for (const traceEvents of traceGroups.values()) {
      // Sort by timestamp and keep the latest
      traceEvents.sort((a, b) => b.timestamp - a.timestamp);
      aggregated.push(traceEvents[0]);
    }

    return aggregated;
  }

  private aggregateDatabaseQueries(events: TelemetryEvent[]): TelemetryEvent[] {
    // Group similar queries
    const queryGroups = new Map<string, TelemetryEvent[]>();
    
    for (const event of events) {
      const query = event.data.databaseQuery;
      if (!query) continue;

      // Create a key based on operation and table
      const key = `${query.operation}:${query.table}`;
      if (!queryGroups.has(key)) {
        queryGroups.set(key, []);
      }
      queryGroups.get(key).push(event);
    }

    // Aggregate each group
    const aggregated: TelemetryEvent[] = [];
    for (const [key, groupEvents] of queryGroups.entries()) {
      if (groupEvents.length === 1) {
        aggregated.push(groupEvents[0]);
        continue;
      }

      // Calculate aggregate stats
      const durations = groupEvents.map(e => e.data.databaseQuery.duration);
      const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
      const totalRows = groupEvents.reduce((sum, e) => 
        sum + (e.data.databaseQuery.rowsAffected || 0), 0
      );

      const firstEvent = groupEvents[0];
      aggregated.push({
        id: `agg-db-${key}-${Date.now()}`,
        type: TelemetryEventType.DATABASE_QUERY,
        timestamp: firstEvent.timestamp,
        data: {
          databaseQuery: {
            ...firstEvent.data.databaseQuery,
            duration: avgDuration,
            rowsAffected: totalRows,
            query: `[Aggregated ${groupEvents.length} queries]`,
          },
        },
      });
    }

    return aggregated;
  }

  private aggregateMessageQueues(events: TelemetryEvent[]): TelemetryEvent[] {
    // Group by queue and action
    const queueGroups = new Map<string, TelemetryEvent[]>();
    
    for (const event of events) {
      const mq = event.data.messageQueue;
      if (!mq) continue;

      const key = `${mq.queue}:${mq.action}`;
      if (!queueGroups.has(key)) {
        queueGroups.set(key, []);
      }
      queueGroups.get(key).push(event);
    }

    // Aggregate each group
    const aggregated: TelemetryEvent[] = [];
    for (const [key, groupEvents] of queueGroups.entries()) {
      if (groupEvents.length === 1) {
        aggregated.push(groupEvents[0]);
        continue;
      }

      const totalSize = groupEvents.reduce((sum, e) => 
        sum + (e.data.messageQueue.messageSize || 0), 0
      );
      const successCount = groupEvents.filter(e => 
        e.data.messageQueue.success
      ).length;

      const firstEvent = groupEvents[0];
      aggregated.push({
        id: `agg-mq-${key}-${Date.now()}`,
        type: TelemetryEventType.MESSAGE_QUEUE,
        timestamp: firstEvent.timestamp,
        data: {
          messageQueue: {
            ...firstEvent.data.messageQueue,
            messageSize: totalSize,
            success: successCount === groupEvents.length,
            attributes: {
              ...firstEvent.data.messageQueue.attributes,
              aggregatedCount: groupEvents.length,
              successRate: successCount / groupEvents.length,
            },
          },
        },
      });
    }

    return aggregated;
  }

  private deduplicateEvents(events: TelemetryEvent[]): TelemetryEvent[] {
    const seen = new Set<string>();
    const deduplicated: TelemetryEvent[] = [];

    for (const event of events) {
      // Create a hash of the event for deduplication
      const hash = this.createEventHash(event);
      if (!seen.has(hash)) {
        seen.add(hash);
        deduplicated.push(event);
      }
    }

    return deduplicated;
  }

  private createEventHash(event: TelemetryEvent): string {
    // Create a simple hash based on event properties
    const data = JSON.stringify({
      type: event.type,
      timestamp: Math.floor(event.timestamp / 1000), // 1 second resolution
      data: this.extractKeyData(event.data),
    });
    
    // Simple hash function
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    
    return hash.toString();
  }

  private extractKeyData(data: any): any {
    // Extract only key fields for hashing
    if (data.requestFlow) {
      return {
        traceId: data.requestFlow.traceId,
        spanId: data.requestFlow.spanId,
      };
    }
    if (data.performanceMetrics) {
      return {
        componentId: data.performanceMetrics.componentId,
      };
    }
    if (data.databaseQuery) {
      return {
        operation: data.databaseQuery.operation,
        table: data.databaseQuery.table,
      };
    }
    return data;
  }

  clearWindows(): void {
    this.windows.clear();
  }
}