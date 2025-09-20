import { Injectable, Logger } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import { Redis } from 'ioredis';
import { EventEmitter2 } from '@nestjs/event-emitter';

export interface ComponentActivity {
  componentId: string;
  projectId: string;
  isActive: boolean;
  requestCount: number;
  errorCount: number;
  avgResponseTime: number;
  lastActivity: number;
  currentLoad: number;
  memoryUsage?: number;
  cpuUsage?: number;
  activeConnections: number;
  queueDepth?: number;
  status: 'healthy' | 'degraded' | 'critical' | 'offline';
}

export interface ActivitySnapshot {
  projectId: string;
  timestamp: number;
  components: Map<string, ComponentActivity>;
  totalRequests: number;
  activeComponents: number;
  errorRate: number;
  averageResponseTime: number;
}

@Injectable()
export class ComponentActivityService {
  private readonly logger = new Logger(ComponentActivityService.name);
  private readonly ACTIVITY_TTL = 300; // 5 minutes
  private readonly ACTIVITY_WINDOW = 60000; // 1 minute window for activity detection
  private readonly activityCache = new Map<string, Map<string, ComponentActivity>>();

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async trackComponentActivity(data: {
    projectId: string;
    componentId: string;
    event: 'request' | 'response' | 'error' | 'timeout';
    responseTime?: number;
    errorDetails?: any;
    metadata?: Record<string, any>;
  }): Promise<void> {
    try {
      const key = `activity:${data.projectId}:${data.componentId}`;
      const timestamp = Date.now();

      let projectCache = this.activityCache.get(data.projectId);
      if (!projectCache) {
        projectCache = new Map();
        this.activityCache.set(data.projectId, projectCache);
      }

      let activity = projectCache.get(data.componentId) || this.createDefaultActivity(data.componentId, data.projectId);

      switch (data.event) {
        case 'request':
          activity.requestCount++;
          activity.activeConnections++;
          activity.isActive = true;
          activity.lastActivity = timestamp;
          break;

        case 'response':
          if (data.responseTime) {
            activity.avgResponseTime = this.calculateMovingAverage(
              activity.avgResponseTime,
              data.responseTime,
              activity.requestCount
            );
          }
          activity.activeConnections = Math.max(0, activity.activeConnections - 1);
          activity.lastActivity = timestamp;
          break;

        case 'error':
        case 'timeout':
          activity.errorCount++;
          activity.activeConnections = Math.max(0, activity.activeConnections - 1);
          activity.status = this.determineStatus(activity);
          break;
      }

      activity.currentLoad = this.calculateLoad(activity);
      projectCache.set(data.componentId, activity);

      await this.persistActivity(activity);

      if (this.shouldEmitUpdate(data.event)) {
        this.eventEmitter.emit('component.activity.updated', {
          projectId: data.projectId,
          componentId: data.componentId,
          activity,
        });
      }

    } catch (error) {
      this.logger.error(`Failed to track component activity: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async updateResourceMetrics(data: {
    projectId: string;
    componentId: string;
    cpuUsage: number;
    memoryUsage: number;
    queueDepth?: number;
  }): Promise<void> {
    try {
      let projectCache = this.activityCache.get(data.projectId);
      if (!projectCache) {
        projectCache = new Map();
        this.activityCache.set(data.projectId, projectCache);
      }

      let activity = projectCache.get(data.componentId) || this.createDefaultActivity(data.componentId, data.projectId);

      activity.cpuUsage = data.cpuUsage;
      activity.memoryUsage = data.memoryUsage;
      if (data.queueDepth !== undefined) {
        activity.queueDepth = data.queueDepth;
      }

      activity.status = this.determineStatus(activity);
      activity.currentLoad = this.calculateLoad(activity);

      projectCache.set(data.componentId, activity);
      await this.persistActivity(activity);

    } catch (error) {
      this.logger.error(`Failed to update resource metrics: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async getComponentActivity(projectId: string, componentId: string): Promise<ComponentActivity | null> {
    const projectCache = this.activityCache.get(projectId);
    if (projectCache) {
      const cachedActivity = projectCache.get(componentId);
      if (cachedActivity) {
        return cachedActivity;
      }
    }

    const key = `activity:${projectId}:${componentId}`;
    const data = await this.redis.get(key);
    return data ? JSON.parse(data) : null;
  }

  async getProjectSnapshot(projectId: string): Promise<ActivitySnapshot> {
    let projectCache = this.activityCache.get(projectId);

    if (!projectCache) {
      projectCache = await this.loadProjectActivities(projectId);
      this.activityCache.set(projectId, projectCache);
    }

    const timestamp = Date.now();
    const activeThreshold = timestamp - this.ACTIVITY_WINDOW;

    let totalRequests = 0;
    let totalResponseTime = 0;
    let totalErrors = 0;
    let activeComponents = 0;
    let componentCount = 0;

    for (const activity of projectCache.values()) {
      if (activity.lastActivity > activeThreshold) {
        activity.isActive = true;
        activeComponents++;
      } else {
        activity.isActive = false;
      }

      totalRequests += activity.requestCount;
      totalErrors += activity.errorCount;
      totalResponseTime += activity.avgResponseTime * activity.requestCount;
      componentCount++;
    }

    return {
      projectId,
      timestamp,
      components: projectCache,
      totalRequests,
      activeComponents,
      errorRate: totalRequests > 0 ? (totalErrors / totalRequests) * 100 : 0,
      averageResponseTime: totalRequests > 0 ? totalResponseTime / totalRequests : 0,
    };
  }

  async detectBottlenecks(projectId: string): Promise<Array<{
    componentId: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    reason: string;
    metrics: Partial<ComponentActivity>;
  }>> {
    const snapshot = await this.getProjectSnapshot(projectId);
    const bottlenecks: any[] = [];

    for (const [componentId, activity] of snapshot.components) {
      const issues: string[] = [];
      let severity: 'low' | 'medium' | 'high' | 'critical' = 'low';

      if (activity.avgResponseTime > 5000) {
        issues.push('High response time');
        severity = 'high';
      }

      if (activity.errorCount > 0 && activity.requestCount > 0) {
        const errorRate = (activity.errorCount / activity.requestCount) * 100;
        if (errorRate > 10) {
          issues.push(`High error rate: ${errorRate.toFixed(1)}%`);
          severity = 'critical';
        } else if (errorRate > 5) {
          issues.push(`Elevated error rate: ${errorRate.toFixed(1)}%`);
          severity = severity === 'critical' ? 'critical' : 'high';
        }
      }

      if (activity.cpuUsage && activity.cpuUsage > 80) {
        issues.push(`High CPU usage: ${activity.cpuUsage}%`);
        severity = severity === 'critical' ? 'critical' : 'high';
      }

      if (activity.memoryUsage && activity.memoryUsage > 85) {
        issues.push(`High memory usage: ${activity.memoryUsage}%`);
        severity = severity === 'critical' ? 'critical' : 'high';
      }

      if (activity.queueDepth && activity.queueDepth > 100) {
        issues.push(`Large queue depth: ${activity.queueDepth}`);
        severity = severity === 'low' ? 'medium' : severity;
      }

      if (activity.activeConnections > 100) {
        issues.push(`High connection count: ${activity.activeConnections}`);
        severity = severity === 'low' ? 'medium' : severity;
      }

      if (issues.length > 0) {
        bottlenecks.push({
          componentId,
          severity,
          reason: issues.join(', '),
          metrics: {
            avgResponseTime: activity.avgResponseTime,
            errorCount: activity.errorCount,
            requestCount: activity.requestCount,
            cpuUsage: activity.cpuUsage,
            memoryUsage: activity.memoryUsage,
            queueDepth: activity.queueDepth,
            activeConnections: activity.activeConnections,
          },
        });
      }
    }

    return bottlenecks.sort((a, b) => {
      const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      return severityOrder[a.severity] - severityOrder[b.severity];
    });
  }

  async clearInactiveComponents(projectId: string): Promise<number> {
    const snapshot = await this.getProjectSnapshot(projectId);
    const inactiveThreshold = Date.now() - (this.ACTIVITY_WINDOW * 5);
    let cleared = 0;

    for (const [componentId, activity] of snapshot.components) {
      if (activity.lastActivity < inactiveThreshold) {
        snapshot.components.delete(componentId);
        await this.redis.del(`activity:${projectId}:${componentId}`);
        cleared++;
      }
    }

    return cleared;
  }

  private createDefaultActivity(componentId: string, projectId: string): ComponentActivity {
    return {
      componentId,
      projectId,
      isActive: false,
      requestCount: 0,
      errorCount: 0,
      avgResponseTime: 0,
      lastActivity: Date.now(),
      currentLoad: 0,
      activeConnections: 0,
      status: 'healthy',
    };
  }

  private calculateMovingAverage(current: number, newValue: number, count: number): number {
    if (count === 0) return newValue;
    return (current * (count - 1) + newValue) / count;
  }

  private calculateLoad(activity: ComponentActivity): number {
    let load = 0;

    const connectionLoad = Math.min(100, (activity.activeConnections / 50) * 100);
    load += connectionLoad * 0.3;

    if (activity.cpuUsage) {
      load += activity.cpuUsage * 0.3;
    }

    if (activity.memoryUsage) {
      load += activity.memoryUsage * 0.2;
    }

    const responseTimeLoad = Math.min(100, (activity.avgResponseTime / 5000) * 100);
    load += responseTimeLoad * 0.2;

    return Math.round(load);
  }

  private determineStatus(activity: ComponentActivity): 'healthy' | 'degraded' | 'critical' | 'offline' {
    const now = Date.now();

    if (now - activity.lastActivity > 300000) {
      return 'offline';
    }

    const errorRate = activity.requestCount > 0
      ? (activity.errorCount / activity.requestCount) * 100
      : 0;

    if (errorRate > 10 || activity.currentLoad > 90) {
      return 'critical';
    }

    if (errorRate > 5 || activity.currentLoad > 70 || activity.avgResponseTime > 3000) {
      return 'degraded';
    }

    return 'healthy';
  }

  private shouldEmitUpdate(event: string): boolean {
    return ['error', 'timeout'].includes(event) || Math.random() < 0.1;
  }

  private async persistActivity(activity: ComponentActivity): Promise<void> {
    const key = `activity:${activity.projectId}:${activity.componentId}`;
    await this.redis.setex(key, this.ACTIVITY_TTL, JSON.stringify(activity));
  }

  private async loadProjectActivities(projectId: string): Promise<Map<string, ComponentActivity>> {
    const pattern = `activity:${projectId}:*`;
    const keys = await this.redis.keys(pattern);
    const activities = new Map<string, ComponentActivity>();

    if (keys.length > 0) {
      const values = await this.redis.mget(...keys);
      for (let i = 0; i < keys.length; i++) {
        if (values[i]) {
          const activity: ComponentActivity = JSON.parse(values[i]);
          activities.set(activity.componentId, activity);
        }
      }
    }

    return activities;
  }
}