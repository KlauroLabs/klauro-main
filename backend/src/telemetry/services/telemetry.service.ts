import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import { Redis } from 'ioredis';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { TelemetryData } from '../../database/entities/telemetry-data.entity';
import { 
  TelemetryMessage, 
  TelemetryBatch, 
  TelemetrySubscription,
  TelemetryAggregation,
  TelemetryStream,
  PerformanceMetrics 
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

  constructor(
    @InjectRedis() private readonly redis: Redis,
    @Optional() @InjectRepository(TelemetryData)
    private readonly telemetryRepo: EntityRepository<TelemetryData> | null,
    private readonly eventAggregator: EventAggregator,
    private readonly metricsCalculator: MetricsCalculator,
  ) {
    this.initializeBatchProcessing();
  }

  private initializeBatchProcessing() {
    setInterval(() => {
      this.flushAllBatches();
    }, this.BATCH_INTERVAL * 10);
  }

  async ingestTelemetry(message: TelemetryMessage): Promise<void> {
    try {
      // Validate message version
      if (message.version !== '1.0') {
        throw new Error(`Unsupported telemetry version: ${message.version}`);
      }

      // Add to batch queue
      const projectId = message.projectId;
      if (!this.batchQueue.has(projectId)) {
        this.batchQueue.set(projectId, []);
      }

      const batch = this.batchQueue.get(projectId);
      batch.push(message);

      // Check if batch should be flushed
      if (batch.length >= this.MAX_BATCH_SIZE) {
        await this.flushBatch(projectId);
      } else if (!this.batchTimers.has(projectId)) {
        // Set timer for automatic flush
        const timer = setTimeout(() => {
          this.flushBatch(projectId);
          this.batchTimers.delete(projectId);
        }, this.BATCH_INTERVAL);
        this.batchTimers.set(projectId, timer);
      }

      // Publish to Redis for real-time subscribers
      await this.publishToRedis(message);

      // Update metrics
      await this.updateMetrics(message);
    } catch (error) {
      this.logger.error(`Failed to ingest telemetry: ${error.message}`, error.stack);
      throw error;
    }
  }

  async processBatch(batch: TelemetryBatch): Promise<void> {
    try {
      const aggregatedEvents = await this.eventAggregator.aggregate(batch.events);
      
      // Only persist to database if available
      if (this.telemetryRepo) {
        for (const event of aggregatedEvents) {
          const telemetryData = this.telemetryRepo.create({
            projectId: batch.projectId,
            organizationId: batch.organizationId,
            type: event.type,
            timestamp: new Date(event.timestamp),
            data: event.data,
            metadata: batch.metadata,
          });

          await this.telemetryRepo.persistAndFlush(telemetryData);
        }
      }

      // Update aggregated metrics
      await this.updateAggregatedMetrics(batch);
      
      // Publish batch processed event
      await this.redis.publish(
        `telemetry:batch:processed:${batch.projectId}`,
        JSON.stringify({
          projectId: batch.projectId,
          eventCount: batch.events.length,
          timestamp: Date.now(),
        })
      );
    } catch (error) {
      this.logger.error(`Failed to process batch: ${error.message}`, error.stack);
      throw error;
    }
  }

  private async flushBatch(projectId: string): Promise<void> {
    const batch = this.batchQueue.get(projectId);
    if (!batch || batch.length === 0) {
      return;
    }

    try {
      // Clear the batch immediately to avoid duplicate processing
      this.batchQueue.set(projectId, []);

      // Process batch in background
      const telemetryBatch: TelemetryBatch = {
        projectId,
        organizationId: batch[0].metadata?.environment || 'default',
        timestamp: Date.now(),
        events: batch.map(msg => ({
          id: `${msg.timestamp}-${Math.random()}`,
          type: msg.type as any,
          timestamp: msg.timestamp,
          data: msg.payload.data as TelemetryStream,
        })),
        metadata: batch[0].metadata,
      };

      await this.processBatch(telemetryBatch);
    } catch (error) {
      this.logger.error(`Failed to flush batch for project ${projectId}: ${error.message}`);
    }
  }

  private async flushAllBatches(): Promise<void> {
    const promises = Array.from(this.batchQueue.keys()).map(projectId => 
      this.flushBatch(projectId)
    );
    await Promise.allSettled(promises);
  }

  private async publishToRedis(message: TelemetryMessage): Promise<void> {
    const channel = `telemetry:${message.projectId}:${message.type}`;
    await this.redis.publish(channel, JSON.stringify(message));

    // Also publish to a general channel for project-wide subscribers
    await this.redis.publish(
      `telemetry:${message.projectId}:all`,
      JSON.stringify(message)
    );
  }

  private async updateMetrics(message: TelemetryMessage): Promise<void> {
    const key = `metrics:${message.projectId}:${message.type}`;
    await this.redis.hincrby(key, 'count', 1);
    await this.redis.hset(key, 'lastUpdate', Date.now());
    await this.redis.expire(key, this.REDIS_TTL);

    // Update rate limiting counters
    const rateLimitKey = `ratelimit:${message.projectId}`;
    await this.redis.incr(rateLimitKey);
    await this.redis.expire(rateLimitKey, 1); // 1 second window
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

    // Store in Redis for quick access
    const key = `aggregation:${batch.projectId}:1m`;
    await this.redis.setex(
      key,
      60, // 1 minute TTL
      JSON.stringify(aggregation)
    );
  }

  async registerSubscription(clientId: string, subscription: TelemetrySubscription): Promise<void> {
    const key = `subscription:${clientId}`;
    await this.redis.hset(key, subscription.projectId, JSON.stringify(subscription));
    await this.redis.expire(key, 3600); // 1 hour TTL
  }

  async removeSubscription(clientId: string, subscriptionId: string): Promise<void> {
    const key = `subscription:${clientId}`;
    await this.redis.hdel(key, subscriptionId);
  }

  async trackConnection(data: {
    projectId: string;
    event: 'connect' | 'disconnect';
    clientId: string;
    metadata?: any;
  }): Promise<void> {
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
    const keys = await this.redis.keys(`metrics:${projectId}:*`);
    const metrics: Record<string, any> = {};

    for (const key of keys) {
      const type = key.split(':').pop();
      const data = await this.redis.hgetall(key);
      metrics[type] = data;
    }

    return metrics;
  }

  async getRecentTelemetry(
    projectId: string,
    limit: number = 100,
  ): Promise<TelemetryData[]> {
    if (!this.telemetryRepo) {
      // Return empty array if no database
      return [];
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
    const key = `aggregation:${projectId}:${window}`;
    const data = await this.redis.get(key);
    return data ? JSON.parse(data) : null;
  }

  async getConnectionCount(projectId: string): Promise<number> {
    const count = await this.redis.get(`connection_count:${projectId}`);
    return count ? parseInt(count, 10) : 0;
  }

  async getRateLimitStatus(projectId: string): Promise<{
    current: number;
    limit: number;
    remaining: number;
  }> {
    const current = await this.redis.get(`ratelimit:${projectId}`);
    const limit = 10000; // 10k events/sec
    const currentCount = current ? parseInt(current, 10) : 0;

    return {
      current: currentCount,
      limit,
      remaining: Math.max(0, limit - currentCount),
    };
  }
}