import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import { Redis } from 'ioredis';
import { TelemetryGateway } from '../gateways/telemetry.gateway';
import { TelemetryService } from './telemetry.service';
import { TelemetryMessage, TelemetryStream } from '../types/telemetry.types';

export interface TelemetryRealtimeData {
  nodeActivity: Record<string, number>;
  edgeFlow: Record<string, number>;
  errors: Array<{ nodeId: string; count: number; message: string }>;
  performance: {
    latency: Record<string, number>;
    throughput: Record<string, number>;
  };
  timestamp: Date;
}

@Injectable()
export class TelemetryRealtimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelemetryRealtimeService.name);
  private subscriber: Redis;
  private readonly TELEMETRY_CHANNEL_PATTERN = 'telemetry:*';
  private readonly BATCH_CHANNEL_PATTERN = 'telemetry:batch:processed:*';
  
  // Cache for real-time data aggregation
  private realtimeCache = new Map<string, TelemetryRealtimeData>();
  private updateInterval?: NodeJS.Timer;

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly telemetryGateway: TelemetryGateway,
    private readonly telemetryService: TelemetryService,
  ) {
    // Create separate Redis connection for subscriptions
    this.subscriber = this.redis.duplicate();
  }

  async onModuleInit() {
    try {
      await this.initializeRealtimeStreaming();
      this.startPeriodicUpdates();
      this.logger.log('Telemetry real-time service initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize real-time service:', error);
    }
  }

  async onModuleDestroy() {
    try {
      if (this.updateInterval) {
        clearInterval(this.updateInterval as any);
      }
      await this.subscriber.disconnect();
      this.logger.log('Telemetry real-time service stopped');
    } catch (error) {
      this.logger.error('Error stopping real-time service:', error);
    }
  }

  private async initializeRealtimeStreaming() {
    // Subscribe to all telemetry channels
    await this.subscriber.psubscribe(this.TELEMETRY_CHANNEL_PATTERN);
    await this.subscriber.psubscribe(this.BATCH_CHANNEL_PATTERN);

    // Handle individual telemetry messages
    this.subscriber.on('pmessage', async (pattern, channel, message) => {
      try {
        if (pattern === this.TELEMETRY_CHANNEL_PATTERN) {
          await this.handleTelemetryMessage(channel, message);
        } else if (pattern === this.BATCH_CHANNEL_PATTERN) {
          await this.handleBatchProcessed(channel, message);
        }
      } catch (error) {
        this.logger.error(`Error processing Redis message: ${error instanceof Error ? error.message : String(error)}`, error instanceof Error ? error.stack : undefined);
      }
    });

    this.logger.log('Subscribed to Redis telemetry channels');
  }

  private async handleTelemetryMessage(channel: string, message: string) {
    try {
      const telemetryMessage: TelemetryMessage = JSON.parse(message);
      const projectId = telemetryMessage.projectId;

      // Update real-time cache
      await this.updateRealtimeCache(projectId, telemetryMessage);

      // Broadcast to WebSocket clients immediately for high-frequency events
      if (this.shouldBroadcastImmediately(telemetryMessage)) {
        await this.broadcastTelemetryUpdate(projectId);
      }

    } catch (error) {
      this.logger.error(`Error handling telemetry message: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async handleBatchProcessed(channel: string, message: string) {
    try {
      const batchData = JSON.parse(message);
      const projectId = batchData.projectId;

      // Fetch latest aggregated metrics and broadcast
      const metrics = await this.telemetryService.getAggregatedMetrics(projectId, '1m');
      if (metrics) {
        await this.broadcastTelemetryUpdate(projectId, metrics);
      }
    } catch (error) {
      this.logger.error(`Error handling batch processed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async updateRealtimeCache(projectId: string, message: TelemetryMessage) {
    let cacheData = this.realtimeCache.get(projectId);
    
    if (!cacheData) {
      cacheData = {
        nodeActivity: {},
        edgeFlow: {},
        errors: [],
        performance: {
          latency: {},
          throughput: {},
        },
        timestamp: new Date(),
      };
      this.realtimeCache.set(projectId, cacheData);
    }

    // Update based on message type and payload
    const payload = message.payload;
    
    if (message.type === 'metric' && payload.data.performanceMetrics) {
      const metrics = payload.data.performanceMetrics;
      const componentId = metrics.componentId;
      
      cacheData.performance.latency[componentId] = metrics.responseTime || 0;
      cacheData.performance.throughput[componentId] = metrics.throughput || 0;
      cacheData.nodeActivity[componentId] = (cacheData.nodeActivity[componentId] || 0) + 1;
    }

    if (message.type === 'trace' && payload.data.requestFlow) {
      const flow = payload.data.requestFlow;
      const fromComponent = flow.sourceComponent;
      const toComponent = flow.targetComponent;
      const edgeKey = `${fromComponent}->${toComponent}`;
      
      cacheData.edgeFlow[edgeKey] = (cacheData.edgeFlow[edgeKey] || 0) + 1;
      cacheData.nodeActivity[fromComponent] = (cacheData.nodeActivity[fromComponent] || 0) + 1;
      cacheData.nodeActivity[toComponent] = (cacheData.nodeActivity[toComponent] || 0) + 1;
    }

    if (message.type === 'event' && payload.data.issues) {
      const issues = payload.data.issues;
      for (const issue of issues) {
        const existingError = cacheData.errors.find(e => 
          e.nodeId === issue.componentId && e.message === issue.title
        );
        
        if (existingError) {
          existingError.count += 1;
        } else {
          cacheData.errors.push({
            nodeId: issue.componentId,
            count: 1,
            message: issue.title,
          });
        }
      }
    }

    cacheData.timestamp = new Date();
  }

  private shouldBroadcastImmediately(message: TelemetryMessage): boolean {
    // Broadcast immediately for critical events
    const criticalTypes = ['error', 'alert', 'performance_degradation'];
    return criticalTypes.includes(message.type);
  }

  private startPeriodicUpdates() {
    // Send periodic updates every 2 seconds for smooth real-time visualization
    this.updateInterval = setInterval(async () => {
      try {
        for (const [projectId, data] of this.realtimeCache.entries()) {
          await this.broadcastTelemetryUpdate(projectId, null, data);
        }
        
        // Clean up old cache entries (older than 5 minutes)
        this.cleanupCache();
      } catch (error) {
        this.logger.error(`Error in periodic updates: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, 2000); // 2 second intervals
  }

  private async broadcastTelemetryUpdate(
    projectId: string, 
    aggregatedMetrics?: any,
    realtimeData?: TelemetryRealtimeData
  ) {
    try {
      const cacheData = realtimeData || this.realtimeCache.get(projectId);
      if (!cacheData && !aggregatedMetrics) return;

      const updateData = {
        data: cacheData || {
          nodeActivity: {},
          edgeFlow: {},
          errors: [],
          performance: { latency: {}, throughput: {} },
          timestamp: new Date(),
        },
        aggregatedMetrics: aggregatedMetrics || null,
        timestamp: new Date(),
      };

      // Emit the event that frontend expects
      await this.telemetryGateway.broadcastToProject(
        projectId,
        'telemetry-update',
        updateData
      );

      this.logger.debug(`Broadcast telemetry update for project ${projectId}`);
    } catch (error) {
      this.logger.error(`Error broadcasting telemetry update: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private cleanupCache() {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    
    for (const [projectId, data] of this.realtimeCache.entries()) {
      if (data.timestamp < fiveMinutesAgo) {
        this.realtimeCache.delete(projectId);
      }
    }
  }

  // Public methods for manual triggering
  async triggerUpdate(projectId: string) {
    await this.broadcastTelemetryUpdate(projectId);
  }

  async getRealtimeData(projectId: string): Promise<TelemetryRealtimeData | null> {
    return this.realtimeCache.get(projectId) || null;
  }

  async clearCache(projectId?: string) {
    if (projectId) {
      this.realtimeCache.delete(projectId);
    } else {
      this.realtimeCache.clear();
    }
  }

  getConnectionStats() {
    return {
      cacheSize: this.realtimeCache.size,
      cachedProjects: Array.from(this.realtimeCache.keys()),
      isSubscriberConnected: this.subscriber.status === 'ready',
      timestamp: new Date(),
    };
  }
}