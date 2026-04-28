import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import { Redis } from 'ioredis';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { TelemetryData, TelemetryPayloadType as EntityTelemetryPayloadType } from '../../database/entities/telemetry-data.entity';
import { 
  CASRuntimeEvent,
  TelemetryMessage, 
  TelemetryBatch, 
  TelemetrySubscription,
  TelemetryAggregation,
  TelemetryStream,
  TelemetryEvent,
  TelemetryEventType,
  FlowStatus,
  IssueType
} from '../types/telemetry.types';
import { EventAggregator } from './event-aggregator.service';
import { MetricsCalculator } from './metrics-calculator.service';

@Injectable()
export class TelemetryService {
  private readonly logger = new Logger(TelemetryService.name);
  private readonly BATCH_INTERVAL = 100; // 100ms batching
  private readonly MAX_BATCH_SIZE = 1000;
  private readonly REDIS_TTL = 3600; // 1 hour cache TTL
  private batchQueue: Map<string, TelemetryMessage[]> = new Map();
  private batchTimers: Map<string, NodeJS.Timeout> = new Map();
  private inMemoryEvents: Map<string, TelemetryData[]> = new Map();
  private inMemoryAggregations: Map<string, TelemetryAggregation> = new Map();

  constructor(
    @Optional() @InjectRedis() private readonly redis: Redis | null,
    @Optional() @InjectRepository(TelemetryData)
    private readonly telemetryRepo: EntityRepository<TelemetryData> | null,
    private readonly eventAggregator: EventAggregator,
    private readonly metricsCalculator: MetricsCalculator,
  ) {
    this.initializeBatchProcessing();
  }

  private initializeBatchProcessing() {
    const interval = setInterval(() => {
      this.flushAllBatches();
    }, this.BATCH_INTERVAL * 10);
    interval.unref?.();
  }

  async ingestTelemetry(message: TelemetryMessage): Promise<void> {
    try {
      if (message.version !== '1.0') {
        throw new Error(`Unsupported telemetry version: ${message.version}`);
      }

      const projectId = message.projectId;
      if (!this.batchQueue.has(projectId)) {
        this.batchQueue.set(projectId, []);
      }

      const batch = this.batchQueue.get(projectId)!;
      batch.push(message);

      if (batch.length >= this.MAX_BATCH_SIZE) {
        await this.flushBatch(projectId);
      } else if (!this.batchTimers.has(projectId)) {
        const timer = setTimeout(() => {
          this.flushBatch(projectId);
          this.batchTimers.delete(projectId);
        }, this.BATCH_INTERVAL);
        timer.unref?.();
        this.batchTimers.set(projectId, timer);
      }

      await this.publishToRedis(message);
      await this.updateMetrics(message);
    } catch (error) {
      this.logger.error(`Failed to ingest telemetry: ${error instanceof Error ? error.message : String(error)}`, error instanceof Error ? error.stack : undefined);
      throw error;
    }
  }

  async processBatch(batch: TelemetryBatch): Promise<void> {
    try {
      const aggregatedEvents = await this.eventAggregator.aggregate(batch.events);

      const telemetryRows = aggregatedEvents.map(event => this.toTelemetryData(batch, event));
      this.storeInMemory(batch.projectId, telemetryRows);

      if (this.telemetryRepo) {
        for (const telemetryData of telemetryRows) {
          await this.telemetryRepo.getEntityManager().persistAndFlush(telemetryData);
        }
      }

      await this.updateAggregatedMetrics(batch);

      if (this.redis) {
        await this.redis.publish(
          `telemetry:batch:processed:${batch.projectId}`,
          JSON.stringify({
            projectId: batch.projectId,
            eventCount: batch.events.length,
            timestamp: Date.now(),
          })
        );
      }
    } catch (error) {
      this.logger.error(`Failed to process batch: ${error instanceof Error ? error.message : String(error)}`, error instanceof Error ? error.stack : undefined);
      throw error;
    }
  }

  async ingestRuntimeEvent(data: {
    projectId: string;
    organizationId: string;
    event: CASRuntimeEvent;
  }): Promise<{ eventId: string; timestamp: string }> {
    const normalized = this.normalizeRuntimeEvent(data.event);
    const timestamp = new Date(normalized.timestamp).getTime();
    const eventId = `${normalized.type}-${timestamp}-${Math.random().toString(36).slice(2, 10)}`;
    const batch: TelemetryBatch = {
      projectId: data.projectId,
      organizationId: data.organizationId,
      timestamp,
      metadata: {
        sdkVersion: String(normalized.attributes?.sdk_version || ''),
        runtime: String(normalized.attributes?.runtime || normalized.service_name || ''),
        hostname: String(normalized.attributes?.hostname || ''),
        environment: normalized.environment || '',
      },
      events: [{
        id: eventId,
        type: this.runtimeEventTypeToTelemetryType(normalized),
        timestamp,
        data: this.runtimeEventToTelemetryStream(data.projectId, normalized),
      }],
    };

    await this.processBatch(batch);
    return { eventId, timestamp: normalized.timestamp };
  }

  private async flushBatch(projectId: string): Promise<void> {
    const batch = this.batchQueue.get(projectId);
    if (!batch || batch.length === 0) {
      return;
    }

    try {
      this.batchQueue.set(projectId, []);

      const telemetryBatch: TelemetryBatch = {
        projectId,
        organizationId: batch[0].metadata?.environment || 'default',
        timestamp: Date.now(),
        events: batch.map((msg, index) => ({
          id: `${msg.timestamp}-${index}`,
          type: this.payloadTypeToEventType(msg.type, msg.payload.data as TelemetryStream),
          timestamp: msg.timestamp,
          data: msg.payload.data as TelemetryStream,
        })),
        metadata: {
          sdkVersion: batch[0].metadata?.sdkVersion || '',
          runtime: batch[0].metadata?.runtime || '',
          hostname: batch[0].metadata?.hostname || '',
          environment: batch[0].metadata?.environment || '',
        },
      };

      await this.processBatch(telemetryBatch);
    } catch (error) {
      this.logger.error(`Failed to flush batch for project ${projectId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async flushAllBatches(): Promise<void> {
    const promises = Array.from(this.batchQueue.keys()).map(projectId => 
      this.flushBatch(projectId)
    );
    await Promise.allSettled(promises);
  }

  private async publishToRedis(message: TelemetryMessage): Promise<void> {
    if (!this.redis) {
      return;
    }
    
    const channel = `telemetry:${message.projectId}:${message.type}`;
    await this.redis.publish(channel, JSON.stringify(message));

    await this.redis.publish(
      `telemetry:${message.projectId}:all`,
      JSON.stringify(message)
    );
  }

  private async updateMetrics(message: TelemetryMessage): Promise<void> {
    if (!this.redis) {
      return;
    }
    
    const key = `metrics:${message.projectId}:${message.type}`;
    await this.redis.hincrby(key, 'count', 1);
    await this.redis.hset(key, 'lastUpdate', Date.now());
    await this.redis.expire(key, this.REDIS_TTL);

    const rateLimitKey = `ratelimit:${message.projectId}`;
    await this.redis.incr(rateLimitKey);
    await this.redis.expire(rateLimitKey, 1);
  }

  private async updateAggregatedMetrics(batch: TelemetryBatch): Promise<void> {
    const metrics = await this.metricsCalculator.calculate(batch);
    
    const aggregation: TelemetryAggregation = {
      projectId: batch.projectId,
      componentId: 'system',
      window: '1m',
      metrics: {
        requestCount: metrics.requestCount,
        errorCount: metrics.errorCount,
        avgLatency: metrics.avgLatency,
        avgCpu: metrics.avgCpu,
        avgMemory: metrics.avgMemory,
        availability: metrics.availability,
      },
      timestamp: Date.now(),
    };
    this.inMemoryAggregations.set(`${batch.projectId}:1m`, aggregation);

    if (this.redis) {
      const key = `aggregation:${batch.projectId}:1m`;
      await this.redis.setex(
        key,
        60, // 1 minute TTL
        JSON.stringify(aggregation)
      );
    }
  }

  async registerSubscription(clientId: string, subscription: TelemetrySubscription): Promise<void> {
    if (!this.redis) {
      return;
    }
    
    const key = `subscription:${clientId}`;
    await this.redis.hset(key, subscription.projectId, JSON.stringify(subscription));
    await this.redis.expire(key, 3600); // 1 hour TTL
  }

  async removeSubscription(clientId: string, subscriptionId: string): Promise<void> {
    if (!this.redis) {
      return;
    }
    
    const key = `subscription:${clientId}`;
    await this.redis.hdel(key, subscriptionId);
  }

  async trackConnection(data: {
    projectId: string;
    event: 'connect' | 'disconnect';
    clientId: string;
    metadata?: any;
  }): Promise<void> {
    if (!this.redis) {
      return;
    }
    
    const key = `connections:${data.projectId}`;
    
    if (data.event === 'connect') {
      await this.redis.hset(key, data.clientId, JSON.stringify({
        ...data.metadata,
        connectedAt: Date.now(),
      }));
    } else {
      await this.redis.hdel(key, data.clientId);
    }

    // Update connection count
    const connections = await this.redis.hkeys(key);
    await this.redis.set(`connection_count:${data.projectId}`, connections.length);
  }

  async getProjectMetrics(projectId: string): Promise<any> {
    if (!this.redis) {
      const events = this.inMemoryEvents.get(projectId) || [];
      return events.reduce((metrics, event) => {
        metrics[event.type] = metrics[event.type] || { count: 0, lastUpdate: 0 };
        metrics[event.type].count++;
        metrics[event.type].lastUpdate = Math.max(metrics[event.type].lastUpdate, event.timestamp.getTime());
        return metrics;
      }, {} as Record<string, { count: number; lastUpdate: number }>);
    }
    
    const keys = await this.redis.keys(`metrics:${projectId}:*`);
    const metrics: Record<string, any> = {};

    for (const key of keys) {
      const type = key.split(':').pop();
      const data = await this.redis.hgetall(key);
      if (type) {
        metrics[type] = data;
      }
    }

    return metrics;
  }

  async getRecentTelemetry(
    projectId: string,
    limit: number = 100,
  ): Promise<TelemetryData[]> {
    if (!this.telemetryRepo) {
      return (this.inMemoryEvents.get(projectId) || [])
        .slice()
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
        .slice(0, limit);
    }
    
    return this.telemetryRepo.find(
      { projectId },
      {
        orderBy: { timestamp: 'DESC' },
        limit,
      }
    );
  }

  async getAggregatedMetrics(
    projectId: string,
    window: '1m' | '5m' | '15m' | '1h' | '24h',
  ): Promise<TelemetryAggregation | null> {
    if (!this.redis) {
      return this.inMemoryAggregations.get(`${projectId}:${window}`) || null;
    }
    
    const key = `aggregation:${projectId}:${window}`;
    const data = await this.redis.get(key);
    return data ? JSON.parse(data) : null;
  }

  async getConnectionCount(projectId: string): Promise<number> {
    if (!this.redis) {
      const events = this.inMemoryEvents.get(projectId) || [];
      const clientIds = new Set<string>();
      for (const event of events) {
        const connections = event.data?.activeConnections || [];
        for (const connection of connections) {
          clientIds.add(`${connection.from}:${connection.to}`);
        }
      }
      return clientIds.size;
    }
    
    const count = await this.redis.get(`connection_count:${projectId}`);
    return count ? parseInt(count, 10) : 0;
  }

  async getRateLimitStatus(projectId: string): Promise<{
    current: number;
    limit: number;
    remaining: number;
  }> {
    const limit = 10000; // 10k events/sec
    
    if (!this.redis) {
      return {
        current: 0,
        limit,
        remaining: limit,
      };
    }
    
    const current = await this.redis.get(`ratelimit:${projectId}`);
    const currentCount = current ? parseInt(current, 10) : 0;

    return {
      current: currentCount,
      limit,
      remaining: Math.max(0, limit - currentCount),
    };
  }

  private toTelemetryData(batch: TelemetryBatch, event: TelemetryEvent): TelemetryData {
    return new TelemetryData({
      projectId: batch.projectId,
      organizationId: batch.organizationId,
      type: this.mapEventTypeToPayloadType(event.type),
      timestamp: new Date(event.timestamp),
      data: event.data,
      metadata: batch.metadata ? {
        sdkVersion: batch.metadata.sdkVersion,
        runtime: batch.metadata.runtime,
        hostname: batch.metadata.hostname,
        environment: batch.metadata.environment,
      } : undefined,
      componentId: this.extractComponentId(event.data),
      tags: this.extractTags(event.data),
      attributes: this.extractAttributes(event.data),
      processed: true,
      processedAt: new Date(),
    });
  }

  private storeInMemory(projectId: string, events: TelemetryData[]): void {
    const existing = this.inMemoryEvents.get(projectId) || [];
    const merged = [...events, ...existing]
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, 5000);
    this.inMemoryEvents.set(projectId, merged);
  }

  private payloadTypeToEventType(type: string, stream: TelemetryStream): TelemetryEventType {
    if (stream.requestFlow) return TelemetryEventType.REQUEST_FLOW;
    if (stream.performanceMetrics) return TelemetryEventType.PERFORMANCE_METRICS;
    if (stream.activeConnections) return TelemetryEventType.ACTIVE_CONNECTIONS;
    if (stream.issues) return TelemetryEventType.ISSUES;
    if (stream.componentStatus) return TelemetryEventType.COMPONENT_STATUS;
    if (stream.databaseQuery) return TelemetryEventType.DATABASE_QUERY;
    if (stream.messageQueue) return TelemetryEventType.MESSAGE_QUEUE;
    if (type === 'heartbeat') return TelemetryEventType.COMPONENT_STATUS;
    return TelemetryEventType.CUSTOM;
  }

  private normalizeRuntimeEvent(event: CASRuntimeEvent): CASRuntimeEvent & { timestamp: string } {
    const timestamp = event.timestamp || new Date().toISOString();
    if (Number.isNaN(new Date(timestamp).getTime())) {
      throw new Error(`Invalid runtime event timestamp: ${timestamp}`);
    }

    const hasCorrelation =
      event.static_id ||
      event.node_id ||
      event.entry_point_id ||
      event.exit_point_id ||
      event.call_chain_id ||
      event.signal ||
      event.route ||
      event.path ||
      event.stack;

    if (!hasCorrelation) {
      throw new Error('Runtime event must include at least one CAS id, signal, route, path, or stack trace.');
    }

    if (typeof event.duration_ms === 'number' && event.duration_ms < 0) {
      throw new Error('Runtime event duration_ms must be greater than or equal to zero.');
    }

    return {
      ...event,
      timestamp,
      schema_version: event.schema_version || '1.0.0',
    };
  }

  private runtimeEventTypeToTelemetryType(event: CASRuntimeEvent): TelemetryEventType {
    if (event.type === 'request') return TelemetryEventType.REQUEST_FLOW;
    if (event.type === 'exit') return TelemetryEventType.CUSTOM;
    if (event.type === 'error') return TelemetryEventType.ISSUES;
    return TelemetryEventType.CUSTOM;
  }

  private runtimeEventToTelemetryStream(projectId: string, event: CASRuntimeEvent & { timestamp: string }): TelemetryStream {
    const timestamp = new Date(event.timestamp).getTime();
    const componentId = event.node_id || event.static_id || event.entry_point_id || event.exit_point_id || event.call_chain_id || event.signal || 'cas-runtime-event';
    const endpoint = event.route || event.path || event.signal || componentId;

    if (event.type === 'request') {
      return {
        requestFlow: {
          id: event.trace_id || `${componentId}:${timestamp}`,
          traceId: event.trace_id || `${componentId}:${timestamp}`,
          spanId: event.span_id || `${componentId}:span`,
          parentSpanId: event.parent_span_id,
          projectId,
          componentId,
          path: [componentId],
          method: event.method || 'EVENT',
          endpoint,
          timestamp,
          duration: event.duration_ms,
          status: event.status_code && event.status_code >= 500 ? FlowStatus.FAILED : FlowStatus.COMPLETED,
          metadata: { casRuntimeEvent: event },
          tags: this.runtimeEventTags(event),
        },
      };
    }

    if (event.type === 'error') {
      return {
        issues: [{
          id: `${componentId}:${timestamp}`,
          componentId,
          projectId,
          type: IssueType.ERROR,
          severity: 'critical',
          message: event.error_message || 'Runtime error event',
          details: { casRuntimeEvent: event },
          stackTrace: event.stack,
          count: 1,
          firstOccurrence: timestamp,
          lastOccurrence: timestamp,
          timestamp,
          resolved: false,
        }],
      };
    }

    return {
      casRuntimeEvent: event,
    } as TelemetryStream;
  }

  private runtimeEventTags(event: CASRuntimeEvent): string[] {
    return [
      'cas-runtime',
      event.type ? `type:${event.type}` : undefined,
      event.static_id ? `static:${event.static_id}` : undefined,
      event.entry_point_id ? `entry:${event.entry_point_id}` : undefined,
      event.exit_point_id ? `exit:${event.exit_point_id}` : undefined,
      event.call_chain_id ? `chain:${event.call_chain_id}` : undefined,
    ].filter((tag): tag is string => Boolean(tag));
  }

  private mapEventTypeToPayloadType(type: TelemetryEventType): EntityTelemetryPayloadType {
    switch (type) {
      case TelemetryEventType.REQUEST_FLOW:
      case TelemetryEventType.DATABASE_QUERY:
      case TelemetryEventType.MESSAGE_QUEUE:
        return EntityTelemetryPayloadType.TRACE;
      case TelemetryEventType.PERFORMANCE_METRICS:
        return EntityTelemetryPayloadType.METRIC;
      case TelemetryEventType.COMPONENT_STATUS:
        return EntityTelemetryPayloadType.HEARTBEAT;
      default:
        return EntityTelemetryPayloadType.EVENT;
    }
  }

  private extractComponentId(stream: TelemetryStream): string | undefined {
    const runtimeEvent = this.extractRuntimeEvent(stream);
    return stream.performanceMetrics?.componentId ||
      stream.requestFlow?.componentId ||
      stream.componentStatus?.componentId ||
      stream.issues?.[0]?.componentId ||
      stream.databaseQuery?.componentId ||
      stream.messageQueue?.componentId ||
      runtimeEvent?.node_id ||
      runtimeEvent?.static_id ||
      runtimeEvent?.entry_point_id ||
      runtimeEvent?.exit_point_id ||
      runtimeEvent?.call_chain_id ||
      runtimeEvent?.signal;
  }

  private extractTags(stream: TelemetryStream): string[] | undefined {
    const tags = new Set<string>();
    for (const tag of stream.requestFlow?.tags || []) tags.add(tag);
    if (stream.databaseQuery?.table) tags.add(`table:${stream.databaseQuery.table}`);
    if (stream.messageQueue?.queue) tags.add(`queue:${stream.messageQueue.queue}`);
    const runtimeEvent = this.extractRuntimeEvent(stream);
    for (const tag of runtimeEvent ? this.runtimeEventTags(runtimeEvent) : []) tags.add(tag);
    return tags.size > 0 ? Array.from(tags) : undefined;
  }

  private extractAttributes(stream: TelemetryStream): Record<string, any> | undefined {
    const attributes: Record<string, any> = {};
    if (stream.requestFlow?.endpoint) attributes.endpoint = stream.requestFlow.endpoint;
    if (stream.requestFlow?.method) attributes.method = stream.requestFlow.method;
    if (stream.databaseQuery?.operation) attributes.databaseOperation = stream.databaseQuery.operation;
    if (stream.messageQueue?.action) attributes.queueAction = stream.messageQueue.action;
    const runtimeEvent = this.extractRuntimeEvent(stream);
    if (runtimeEvent) {
      attributes.runtimeEventType = runtimeEvent.type;
      attributes.staticId = runtimeEvent.static_id;
      attributes.nodeId = runtimeEvent.node_id;
      attributes.entryPointId = runtimeEvent.entry_point_id;
      attributes.exitPointId = runtimeEvent.exit_point_id;
      attributes.callChainId = runtimeEvent.call_chain_id;
      attributes.traceId = runtimeEvent.trace_id;
      attributes.spanId = runtimeEvent.span_id;
      attributes.signal = runtimeEvent.signal;
      attributes.route = runtimeEvent.route;
      attributes.path = runtimeEvent.path;
    }
    return Object.keys(attributes).length > 0 ? attributes : undefined;
  }

  private extractRuntimeEvent(stream: TelemetryStream): CASRuntimeEvent | undefined {
    return (stream as any).casRuntimeEvent ||
      stream.requestFlow?.metadata?.casRuntimeEvent ||
      stream.issues?.[0]?.details?.casRuntimeEvent;
  }
}
