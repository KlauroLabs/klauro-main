import { Injectable, Logger } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import { Redis } from 'ioredis';

interface ConnectionInfo {
  userId: string;
  organizationId: string;
  connectedAt: number;
  remoteAddress: string;
  lastActivity?: number;
  metadata?: Record<string, any>;
}

interface ConnectionStats {
  total: number;
  byProject: Record<string, number>;
  byOrganization: Record<string, number>;
  byUser: Record<string, number>;
  averageConnectionTime: number;
  peakConnections: number;
  timestamp: number;
}

@Injectable()
export class ConnectionPool {
  private readonly logger = new Logger(ConnectionPool.name);
  private readonly connections: Map<string, ConnectionInfo> = new Map();
  private readonly projectConnections: Map<string, Set<string>> = new Map();
  private readonly orgConnections: Map<string, Set<string>> = new Map();
  private readonly userConnections: Map<string, Set<string>> = new Map();
  private peakConnections = 0;
  private readonly INACTIVE_TIMEOUT = 5 * 60 * 1000; // 5 minutes

  constructor(@InjectRedis() private readonly redis: Redis) {
    this.initializeCleanup();
    this.initializeMetrics();
  }

  private initializeCleanup() {
    // Clean up inactive connections every minute
    setInterval(() => {
      this.cleanupInactiveConnections();
    }, 60000);
  }

  private initializeMetrics() {
    // Update connection metrics every 10 seconds
    setInterval(async () => {
      await this.updateConnectionMetrics();
    }, 10000);
  }

  async addConnection(
    connectionId: string,
    projectId: string,
    info: Partial<ConnectionInfo>,
  ): Promise<number> {
    try {
      // Store connection info
      const connectionInfo: ConnectionInfo = {
        userId: info.userId || 'anonymous',
        organizationId: info.organizationId || 'default',
        connectedAt: info.connectedAt || Date.now(),
        remoteAddress: info.remoteAddress || 'unknown',
        lastActivity: Date.now(),
        metadata: info.metadata,
      };

      this.connections.set(connectionId, connectionInfo);

      // Update project connections
      if (!this.projectConnections.has(projectId)) {
        this.projectConnections.set(projectId, new Set());
      }
      this.projectConnections.get(projectId)!.add(connectionId);

      // Update organization connections
      if (!this.orgConnections.has(connectionInfo.organizationId)) {
        this.orgConnections.set(connectionInfo.organizationId, new Set());
      }
      this.orgConnections.get(connectionInfo.organizationId)!.add(connectionId);

      // Update user connections
      if (!this.userConnections.has(connectionInfo.userId)) {
        this.userConnections.set(connectionInfo.userId, new Set());
      }
      this.userConnections.get(connectionInfo.userId)!.add(connectionId);

      // Update peak connections
      const totalConnections = this.connections.size;
      if (totalConnections > this.peakConnections) {
        this.peakConnections = totalConnections;
      }

      // Store in Redis for distributed access
      await this.storeConnectionInRedis(connectionId, projectId, connectionInfo);

      // Return the number of connections for this project
      return this.projectConnections.get(projectId)!.size;
    } catch (error) {
      this.logger.error(`Failed to add connection: ${error instanceof Error ? error.message : String(error)}`, error instanceof Error ? error.stack : undefined);
      throw error;
    }
  }

  async removeConnection(connectionId: string): Promise<void> {
    try {
      const connectionInfo = this.connections.get(connectionId);
      if (!connectionInfo) {
        return;
      }

      // Remove from all tracking maps
      this.connections.delete(connectionId);

      // Remove from project connections
      for (const [projectId, connections] of this.projectConnections.entries()) {
        if (connections.has(connectionId)) {
          connections.delete(connectionId);
          if (connections.size === 0) {
            this.projectConnections.delete(projectId);
          }
          break;
        }
      }

      // Remove from organization connections
      const orgConnections = this.orgConnections.get(connectionInfo.organizationId);
      if (orgConnections) {
        orgConnections.delete(connectionId);
        if (orgConnections.size === 0) {
          this.orgConnections.delete(connectionInfo.organizationId);
        }
      }

      // Remove from user connections
      const userConnections = this.userConnections.get(connectionInfo.userId);
      if (userConnections) {
        userConnections.delete(connectionId);
        if (userConnections.size === 0) {
          this.userConnections.delete(connectionInfo.userId);
        }
      }

      // Remove from Redis
      await this.removeConnectionFromRedis(connectionId);
    } catch (error) {
      this.logger.error(`Failed to remove connection: ${error instanceof Error ? error.message : String(error)}`, error instanceof Error ? error.stack : undefined);
    }
  }

  async updateActivity(connectionId: string): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (connection) {
      connection.lastActivity = Date.now();
      await this.redis.hset(
        `connection:${connectionId}`,
        'lastActivity',
        connection.lastActivity
      );
    }
  }

  async getConnectionInfo(connectionId: string): Promise<ConnectionInfo | null> {
    // Try local cache first
    let info = this.connections.get(connectionId);
    if (info) {
      return info;
    }

    // Try Redis
    const redisData = await this.redis.hgetall(`connection:${connectionId}`);
    if (redisData && Object.keys(redisData).length > 0) {
      return {
        userId: redisData.userId,
        organizationId: redisData.organizationId,
        connectedAt: parseInt(redisData.connectedAt, 10),
        remoteAddress: redisData.remoteAddress,
        lastActivity: redisData.lastActivity ? parseInt(redisData.lastActivity, 10) : undefined,
        metadata: redisData.metadata ? JSON.parse(redisData.metadata) : undefined,
      };
    }

    return null;
  }

  async getProjectConnections(projectId: string): Promise<string[]> {
    const connections = this.projectConnections.get(projectId);
    if (connections) {
      return Array.from(connections);
    }

    // Try Redis for distributed setup
    const redisConnections = await this.redis.smembers(`project:connections:${projectId}`);
    return redisConnections;
  }

  async getConnectionStats(): Promise<ConnectionStats> {
    const stats: ConnectionStats = {
      total: this.connections.size,
      byProject: {},
      byOrganization: {},
      byUser: {},
      averageConnectionTime: 0,
      peakConnections: this.peakConnections,
      timestamp: Date.now(),
    };

    // Calculate stats by project
    for (const [projectId, connections] of this.projectConnections.entries()) {
      stats.byProject[projectId] = connections.size;
    }

    // Calculate stats by organization
    for (const [orgId, connections] of this.orgConnections.entries()) {
      stats.byOrganization[orgId] = connections.size;
    }

    // Calculate stats by user
    for (const [userId, connections] of this.userConnections.entries()) {
      stats.byUser[userId] = connections.size;
    }

    // Calculate average connection time
    let totalConnectionTime = 0;
    const now = Date.now();
    for (const connection of this.connections.values()) {
      totalConnectionTime += now - connection.connectedAt;
    }
    stats.averageConnectionTime = 
      this.connections.size > 0 ? totalConnectionTime / this.connections.size : 0;

    return stats;
  }

  private async cleanupInactiveConnections(): Promise<void> {
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [connectionId, info] of this.connections.entries()) {
      if (info.lastActivity && now - info.lastActivity > this.INACTIVE_TIMEOUT) {
        toRemove.push(connectionId);
      }
    }

    if (toRemove.length > 0) {
      this.logger.debug(`Cleaning up ${toRemove.length} inactive connections`);
      for (const connectionId of toRemove) {
        await this.removeConnection(connectionId);
      }
    }
  }

  private async storeConnectionInRedis(
    connectionId: string,
    projectId: string,
    info: ConnectionInfo,
  ): Promise<void> {
    const pipeline = this.redis.pipeline();

    // Store connection info
    pipeline.hset(`connection:${connectionId}`, {
      userId: info.userId,
      organizationId: info.organizationId,
      connectedAt: info.connectedAt,
      remoteAddress: info.remoteAddress,
      lastActivity: info.lastActivity || Date.now(),
      metadata: info.metadata ? JSON.stringify(info.metadata) : '',
    });
    pipeline.expire(`connection:${connectionId}`, 3600); // 1 hour TTL

    // Add to project set
    pipeline.sadd(`project:connections:${projectId}`, connectionId);
    pipeline.expire(`project:connections:${projectId}`, 3600);

    // Add to organization set
    pipeline.sadd(`org:connections:${info.organizationId}`, connectionId);
    pipeline.expire(`org:connections:${info.organizationId}`, 3600);

    // Add to user set
    pipeline.sadd(`user:connections:${info.userId}`, connectionId);
    pipeline.expire(`user:connections:${info.userId}`, 3600);

    await pipeline.exec();
  }

  private async removeConnectionFromRedis(connectionId: string): Promise<void> {
    const info = await this.redis.hgetall(`connection:${connectionId}`);
    if (!info || Object.keys(info).length === 0) {
      return;
    }

    const pipeline = this.redis.pipeline();

    // Remove connection info
    pipeline.del(`connection:${connectionId}`);

    // Remove from all sets (we need to scan for the project ID)
    const projectKeys = await this.redis.keys('project:connections:*');
    for (const key of projectKeys) {
      pipeline.srem(key, connectionId);
    }

    // Remove from organization set
    if (info.organizationId) {
      pipeline.srem(`org:connections:${info.organizationId}`, connectionId);
    }

    // Remove from user set
    if (info.userId) {
      pipeline.srem(`user:connections:${info.userId}`, connectionId);
    }

    await pipeline.exec();
  }

  private async updateConnectionMetrics(): Promise<void> {
    const stats = await this.getConnectionStats();
    
    // Store metrics in Redis
    await this.redis.setex(
      'connection:stats',
      60, // 1 minute TTL
      JSON.stringify(stats)
    );

    // Log if connections are high
    if (stats.total > 1000) {
      this.logger.warn(`High connection count: ${stats.total} active connections`);
    }
  }

  async isConnectionActive(connectionId: string): Promise<boolean> {
    const info = await this.getConnectionInfo(connectionId);
    if (!info) {
      return false;
    }

    const now = Date.now();
    const inactive = info.lastActivity && now - info.lastActivity > this.INACTIVE_TIMEOUT;
    return !inactive;
  }

  async getActiveConnectionCount(projectId?: string): Promise<number> {
    if (projectId) {
      const connections = this.projectConnections.get(projectId);
      return connections ? connections.size : 0;
    }
    return this.connections.size;
  }
}