import { Injectable, Logger } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import { Redis } from 'ioredis';

interface BackpressureState {
  projectId: string;
  eventsPerSecond: number;
  queueDepth: number;
  memoryUsage: number;
  cpuUsage: number;
  capacity: number;
  timestamp: number;
}

@Injectable()
export class BackpressureManager {
  private readonly logger = new Logger(BackpressureManager.name);
  private readonly MAX_EVENTS_PER_SECOND = 10000; // Token bucket size
  private readonly REFILL_RATE = 10000; // Tokens per second
  private readonly CAPACITY_THRESHOLD = 0.8; // 80% capacity
  private readonly SAMPLE_RATE = 0.1; // Sample 10% when throttling
  private readonly WINDOW_SIZE = 1000; // 1 second window in ms

  private tokenBuckets: Map<string, {
    tokens: number;
    lastRefill: number;
  }> = new Map();

  private projectStates: Map<string, BackpressureState> = new Map();

  constructor(@InjectRedis() private readonly redis: Redis) {
    this.initializeTokenRefill();
    this.initializeMetricsCollection();
  }

  private initializeTokenRefill() {
    // Refill token buckets every 100ms
    setInterval(() => {
      const now = Date.now();
      for (const [projectId, bucket] of this.tokenBuckets.entries()) {
        const timePassed = (now - bucket.lastRefill) / 1000;
        const tokensToAdd = Math.floor(timePassed * this.REFILL_RATE);
        
        bucket.tokens = Math.min(
          this.MAX_EVENTS_PER_SECOND,
          bucket.tokens + tokensToAdd
        );
        bucket.lastRefill = now;
      }
    }, 100);
  }

  private initializeMetricsCollection() {
    // Collect system metrics every second
    setInterval(async () => {
      await this.collectSystemMetrics();
    }, 1000);
  }

  async checkBackpressure(
    projectId: string,
    eventCount: number,
  ): Promise<boolean> {
    // Get or create token bucket for project
    if (!this.tokenBuckets.has(projectId)) {
      this.tokenBuckets.set(projectId, {
        tokens: this.MAX_EVENTS_PER_SECOND,
        lastRefill: Date.now(),
      });
    }

    const bucket = this.tokenBuckets.get(projectId);
    if (!bucket) {
      return false;
    }

    // Check if we have enough tokens
    if (bucket.tokens < eventCount) {
      this.logger.warn(
        `Rate limit exceeded for project ${projectId}: ${eventCount} events requested, ${bucket.tokens} tokens available`
      );
      
      // Update Redis with rate limit status
      await this.updateRateLimitStatus(projectId, 'exceeded');
      
      return false;
    }

    // Check system capacity
    const capacity = await this.getSystemCapacity();
    if (capacity > this.CAPACITY_THRESHOLD) {
      this.logger.warn(
        `System at ${(capacity * 100).toFixed(1)}% capacity, applying backpressure for project ${projectId}`
      );
      
      // Apply backpressure based on capacity
      const acceptanceRate = 1 - (capacity - this.CAPACITY_THRESHOLD) / (1 - this.CAPACITY_THRESHOLD);
      if (Math.random() > acceptanceRate) {
        await this.updateBackpressureStatus(projectId, 'throttled');
        return false;
      }
    }

    // Consume tokens
    bucket.tokens -= eventCount;

    // Update metrics
    await this.updateProjectMetrics(projectId, eventCount);

    return true;
  }

  async shouldThrottle(
    projectId: string,
    clientCount: number,
  ): Promise<boolean> {
    const state = this.projectStates.get(projectId);
    if (!state) {
      return false;
    }

    // Throttle if:
    // 1. Too many events per second
    // 2. System capacity is high
    // 3. Too many clients for the project
    const eventsPerClient = state.eventsPerSecond / Math.max(1, clientCount);
    const shouldThrottle = 
      state.eventsPerSecond > this.MAX_EVENTS_PER_SECOND * 0.9 ||
      state.capacity > this.CAPACITY_THRESHOLD ||
      eventsPerClient > 100; // More than 100 events/sec per client

    if (shouldThrottle) {
      this.logger.debug(
        `Throttling enabled for project ${projectId}: ` +
        `${state.eventsPerSecond} events/sec, ` +
        `${(state.capacity * 100).toFixed(1)}% capacity, ` +
        `${clientCount} clients`
      );
    }

    return shouldThrottle;
  }

  sampleData<T>(data: T): T {
    // When throttling, only return a sample of the data
    if (Array.isArray(data)) {
      const sampleSize = Math.ceil(data.length * this.SAMPLE_RATE);
      const step = Math.floor(data.length / sampleSize);
      return data.filter((_, index) => index % step === 0) as T;
    }
    
    // For non-array data, return as-is with a probability
    if (Math.random() < this.SAMPLE_RATE) {
      return data;
    }
    
    return null as unknown as T;
  }

  private async getSystemCapacity(): Promise<number> {
    // Get system metrics from Redis or calculate
    const metrics = await this.getSystemMetrics();
    
    // Calculate capacity based on multiple factors
    const cpuCapacity = metrics.cpu / 100;
    const memoryCapacity = metrics.memory / 100;
    const queueCapacity = Math.min(1, metrics.queueDepth / 10000);
    
    // Weighted average
    return cpuCapacity * 0.4 + memoryCapacity * 0.4 + queueCapacity * 0.2;
  }

  private async getSystemMetrics(): Promise<{
    cpu: number;
    memory: number;
    queueDepth: number;
  }> {
    // Get from Redis cache
    const cached = await this.redis.get('system:metrics');
    if (cached) {
      return JSON.parse(cached);
    }

    // Default values if not available
    return {
      cpu: process.cpuUsage().user / 1000000, // Convert to percentage
      memory: (process.memoryUsage().heapUsed / process.memoryUsage().heapTotal) * 100,
      queueDepth: 0,
    };
  }

  private async collectSystemMetrics(): Promise<void> {
    const cpuUsage = process.cpuUsage();
    const memUsage = process.memoryUsage();
    
    const metrics = {
      cpu: (cpuUsage.user + cpuUsage.system) / 1000000, // microseconds to percentage
      memory: (memUsage.heapUsed / memUsage.heapTotal) * 100,
      queueDepth: this.calculateTotalQueueDepth(),
      timestamp: Date.now(),
    };

    // Store in Redis with 5 second TTL
    await this.redis.setex('system:metrics', 5, JSON.stringify(metrics));

    // Update project states
    for (const [projectId, state] of this.projectStates.entries()) {
      state.cpuUsage = metrics.cpu;
      state.memoryUsage = metrics.memory;
      state.queueDepth = metrics.queueDepth;
      state.capacity = await this.getSystemCapacity();
      state.timestamp = Date.now();
    }
  }

  private calculateTotalQueueDepth(): number {
    let total = 0;
    for (const state of this.projectStates.values()) {
      total += state.queueDepth || 0;
    }
    return total;
  }

  private async updateProjectMetrics(
    projectId: string,
    eventCount: number,
  ): Promise<void> {
    if (!this.projectStates.has(projectId)) {
      this.projectStates.set(projectId, {
        projectId,
        eventsPerSecond: 0,
        queueDepth: 0,
        memoryUsage: 0,
        cpuUsage: 0,
        capacity: 0,
        timestamp: Date.now(),
      });
    }

    const state = this.projectStates.get(projectId)!;
    
    // Update events per second using sliding window
    const now = Date.now();
    const timeDiff = now - state.timestamp;
    if (timeDiff >= this.WINDOW_SIZE) {
      state.eventsPerSecond = eventCount * (1000 / timeDiff);
      state.timestamp = now;
    } else {
      // Accumulate within window
      state.eventsPerSecond += eventCount;
    }

    // Store in Redis for distributed access
    await this.redis.setex(
      `backpressure:${projectId}`,
      5,
      JSON.stringify(state)
    );
  }

  private async updateRateLimitStatus(
    projectId: string,
    status: 'exceeded' | 'ok',
  ): Promise<void> {
    await this.redis.setex(
      `ratelimit:status:${projectId}`,
      60,
      JSON.stringify({
        status,
        timestamp: Date.now(),
        limit: this.MAX_EVENTS_PER_SECOND,
      })
    );
  }

  private async updateBackpressureStatus(
    projectId: string,
    status: 'throttled' | 'normal',
  ): Promise<void> {
    await this.redis.setex(
      `backpressure:status:${projectId}`,
      60,
      JSON.stringify({
        status,
        timestamp: Date.now(),
        capacity: await this.getSystemCapacity(),
      })
    );
  }

  async getProjectBackpressureState(projectId: string): Promise<BackpressureState | null> {
    const cached = await this.redis.get(`backpressure:${projectId}`);
    if (cached) {
      return JSON.parse(cached);
    }
    return this.projectStates.get(projectId) || null;
  }

  async resetProjectLimits(projectId: string): Promise<void> {
    this.tokenBuckets.delete(projectId);
    this.projectStates.delete(projectId);
    await this.redis.del(
      `backpressure:${projectId}`,
      `ratelimit:status:${projectId}`,
      `backpressure:status:${projectId}`
    );
  }
}