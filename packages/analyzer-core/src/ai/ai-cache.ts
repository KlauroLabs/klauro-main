import Redis from 'ioredis';
import { aiConfig } from '../config/ai.config';
import * as winston from 'winston';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface CacheEntry<T = any> {
  data: T;
  timestamp: number;
  ttl: number;
  version: string;
  contentHash?: string;
}

export interface CacheStats {
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
  size: number;
  hitRate: number;
  totalRequests: number;
}

export class AICache {
  private redis?: Redis;
  private fallbackCache: Map<string, CacheEntry> = new Map();
  private logger: winston.Logger;
  private stats: CacheStats;
  private readonly CACHE_VERSION = '1.0.0';
  private readonly MAX_FALLBACK_SIZE = 1000;
  private readonly diskCacheDir: string =
    path.join(os.homedir() || os.tmpdir(), '.klauro', 'ai-cache');
  private diskCacheEnabled = true;

  constructor() {
    this.logger = winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      defaultMeta: { component: 'ai-cache' },
      transports: [
        new winston.transports.Console({
          stderrLevels: ['error', 'warn', 'info', 'verbose', 'debug', 'silly'],
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
          )
        })
      ]
    });

    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      deletes: 0,
      size: 0,
      hitRate: 0,
      totalRequests: 0
    };

    this.initializeRedis();
    this.initializeDiskCache();
  }

  private initializeDiskCache(): void {
    if (!aiConfig.cache.enabled) {
      this.diskCacheEnabled = false;
      return;
    }
    try {
      fs.mkdirSync(this.diskCacheDir, { recursive: true });
    } catch (error) {
      this.diskCacheEnabled = false;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Disk cache unavailable (${message})`);
    }
  }

  private initializeRedis(): void {
    if (!aiConfig.cache.enabled) {
      this.logger.info('AI cache disabled, using in-memory fallback only');
      return;
    }

    try {
      this.redis = new Redis({
        host: aiConfig.cache.redis.host,
        port: aiConfig.cache.redis.port,
        password: aiConfig.cache.redis.password,
        db: aiConfig.cache.redis.db,
        keyPrefix: aiConfig.cache.redis.keyPrefix,
        maxRetriesPerRequest: 1,
        lazyConnect: true,
        enableOfflineQueue: false,
        // Give up after 2 attempts instead of reconnecting forever. When
        // Redis is absent (the common case for CLI analysis runs) this
        // keeps the in-memory fallback quiet rather than spamming logs.
        retryStrategy: (times: number) => (times > 2 ? null : 200),
      });

      this.redis.on('connect', () => {
        this.logger.info('Connected to Redis for AI caching');
      });

      // Log the failure exactly once, then permanently fall back to the
      // in-memory cache so we don't emit an error per reconnection attempt.
      this.redis.on('error', (error) => {
        this.disableRedis(error);
      });

      this.redis.on('end', () => {
        this.disableRedis();
      });

    } catch (error) {
      this.logger.error('Failed to initialize Redis:', error);
      this.logger.warn('Using in-memory fallback cache only');
      this.redis = undefined;
    }
  }

  private disableRedis(error?: unknown): void {
    if (!this.redis) return;
    const client = this.redis;
    this.redis = undefined;
    if (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Redis unavailable (${message}); using in-memory cache`);
    } else {
      this.logger.warn('Redis connection ended; using in-memory cache');
    }
    try {
      client.disconnect();
    } catch {
      // already disconnected
    }
  }

  async get<T = any>(key: string): Promise<T | null> {
    this.stats.totalRequests++;

    try {
      const fullKey = this.generateKey(key);
      
      // Try Redis first
      if (this.redis && await this.isRedisAvailable()) {
        const cached = await this.getFromRedis<T>(fullKey);
        if (cached !== null) {
          this.stats.hits++;
          this.updateHitRate();
          this.logger.debug(`Cache hit for key: ${key}`);
          return cached;
        }
      }

      // Fallback to in-memory cache
      const fallbackResult = this.getFromFallback<T>(fullKey);
      if (fallbackResult !== null) {
        this.stats.hits++;
        this.updateHitRate();
        this.logger.debug(`Fallback cache hit for key: ${key}`);
        return fallbackResult;
      }

      // Disk cache — persists across processes when Redis is unavailable.
      const diskResult = this.getFromDisk<T>(fullKey);
      if (diskResult !== null) {
        // Promote into the in-memory tier for fast subsequent access.
        this.setInFallback(fullKey, diskResult.entry);
        this.stats.hits++;
        this.updateHitRate();
        this.logger.debug(`Disk cache hit for key: ${key}`);
        return diskResult.value;
      }

      this.stats.misses++;
      this.updateHitRate();
      this.logger.debug(`Cache miss for key: ${key}`);
      return null;

    } catch (error) {
      this.logger.error(`Cache get error for key ${key}:`, error);
      this.stats.misses++;
      this.updateHitRate();
      return null;
    }
  }

  async set<T = any>(key: string, value: T, ttl?: number): Promise<void> {
    try {
      const fullKey = this.generateKey(key);
      const cacheTtl = ttl || aiConfig.cache.ttl;
      const entry: CacheEntry<T> = {
        data: value,
        timestamp: Date.now(),
        ttl: cacheTtl,
        version: this.CACHE_VERSION,
        contentHash: this.generateContentHash(value)
      };

      // Try Redis first
      if (this.redis && await this.isRedisAvailable()) {
        await this.setInRedis(fullKey, entry, cacheTtl);
      } else {
        // Fallback to in-memory cache, plus disk for cross-process persistence.
        this.setInFallback(fullKey, entry);
        this.setOnDisk(fullKey, entry);
      }

      this.stats.sets++;
      this.stats.size++;
      this.logger.debug(`Cached value for key: ${key} (TTL: ${cacheTtl}s)`);

    } catch (error) {
      this.logger.error(`Cache set error for key ${key}:`, error);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      const fullKey = this.generateKey(key);

      // Delete from Redis
      if (this.redis && await this.isRedisAvailable()) {
        await this.redis.del(fullKey);
      }

      // Delete from fallback cache
      const deleted = this.fallbackCache.delete(fullKey);
      
      if (deleted) {
        this.stats.deletes++;
        this.stats.size = Math.max(0, this.stats.size - 1);
      }

      this.logger.debug(`Deleted cache entry for key: ${key}`);

    } catch (error) {
      this.logger.error(`Cache delete error for key ${key}:`, error);
    }
  }

  async clear(): Promise<void> {
    try {
      // Clear Redis cache
      if (this.redis && await this.isRedisAvailable()) {
        const pattern = aiConfig.cache.redis.keyPrefix + '*';
        const keys = await this.redis.keys(pattern);
        if (keys.length > 0) {
          await this.redis.del(...keys);
        }
      }

      // Clear fallback cache
      this.fallbackCache.clear();

      // Reset stats
      this.stats.size = 0;
      this.logger.info('AI cache cleared');

    } catch (error) {
      this.logger.error('Cache clear error:', error);
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      const fullKey = this.generateKey(key);

      // Check Redis first
      if (this.redis && await this.isRedisAvailable()) {
        const exists = await this.redis.exists(fullKey);
        if (exists) return true;
      }

      // Check fallback cache
      return this.fallbackCache.has(fullKey) && !this.isExpired(this.fallbackCache.get(fullKey)!);

    } catch (error) {
      this.logger.error(`Cache exists check error for key ${key}:`, error);
      return false;
    }
  }

  getStats(): CacheStats {
    return { ...this.stats };
  }

  async getSize(): Promise<number> {
    try {
      let size = this.fallbackCache.size;

      if (this.redis && await this.isRedisAvailable()) {
        const pattern = aiConfig.cache.redis.keyPrefix + '*';
        const keys = await this.redis.keys(pattern);
        size += keys.length;
      }

      return size;
    } catch (error) {
      this.logger.error('Error getting cache size:', error);
      return this.fallbackCache.size;
    }
  }

  async invalidatePattern(pattern: string): Promise<number> {
    let deletedCount = 0;

    try {
      // Invalidate in Redis
      if (this.redis && await this.isRedisAvailable()) {
        const searchPattern = aiConfig.cache.redis.keyPrefix + pattern;
        const keys = await this.redis.keys(searchPattern);
        if (keys.length > 0) {
          await this.redis.del(...keys);
          deletedCount += keys.length;
        }
      }

      // Invalidate in fallback cache
      for (const [key] of this.fallbackCache.entries()) {
        if (key.includes(pattern)) {
          this.fallbackCache.delete(key);
          deletedCount++;
        }
      }

      this.stats.deletes += deletedCount;
      this.stats.size = Math.max(0, this.stats.size - deletedCount);
      
      this.logger.info(`Invalidated ${deletedCount} cache entries matching pattern: ${pattern}`);
      return deletedCount;

    } catch (error) {
      this.logger.error(`Error invalidating pattern ${pattern}:`, error);
      return 0;
    }
  }

  // Cleanup expired entries from fallback cache
  async cleanup(): Promise<number> {
    let cleanedCount = 0;

    try {
      const now = Date.now();
      
      for (const [key, entry] of this.fallbackCache.entries()) {
        if (this.isExpired(entry)) {
          this.fallbackCache.delete(key);
          cleanedCount++;
        }
      }

      if (cleanedCount > 0) {
        this.stats.size = Math.max(0, this.stats.size - cleanedCount);
        this.logger.debug(`Cleaned up ${cleanedCount} expired cache entries`);
      }

      return cleanedCount;

    } catch (error) {
      this.logger.error('Error during cache cleanup:', error);
      return 0;
    }
  }

  private async getFromRedis<T>(key: string): Promise<T | null> {
    try {
      if (!this.redis) return null;

      const cached = await this.redis.get(key);
      if (!cached) return null;

      const entry: CacheEntry<T> = JSON.parse(cached);
      
      // Validate cache entry
      if (this.isExpired(entry) || entry.version !== this.CACHE_VERSION) {
        await this.redis.del(key);
        return null;
      }

      return entry.data;

    } catch (error) {
      this.logger.error('Redis get error:', error);
      return null;
    }
  }

  private async setInRedis<T>(key: string, entry: CacheEntry<T>, ttl: number): Promise<void> {
    try {
      if (!this.redis) return;

      const serialized = JSON.stringify(entry);
      await this.redis.setex(key, ttl, serialized);

    } catch (error) {
      this.logger.error('Redis set error:', error);
      throw error;
    }
  }

  private getFromFallback<T>(key: string): T | null {
    const entry = this.fallbackCache.get(key);
    if (!entry) return null;

    if (this.isExpired(entry) || entry.version !== this.CACHE_VERSION) {
      this.fallbackCache.delete(key);
      return null;
    }

    return entry.data as T;
  }

  private setInFallback<T>(key: string, entry: CacheEntry<T>): void {
    // Implement simple LRU eviction if cache is too large
    if (this.fallbackCache.size >= this.MAX_FALLBACK_SIZE) {
      const oldestKey = this.fallbackCache.keys().next().value;
      if (oldestKey) {
        this.fallbackCache.delete(oldestKey);
      }
    }

    this.fallbackCache.set(key, entry);
  }

  private diskPath(fullKey: string): string {
    // Hash the key so the filename is always filesystem-safe and bounded.
    const hash = crypto.createHash('sha1').update(fullKey).digest('hex');
    return path.join(this.diskCacheDir, `${hash}.json`);
  }

  private getFromDisk<T>(fullKey: string): { value: T; entry: CacheEntry<T> } | null {
    if (!this.diskCacheEnabled) return null;
    const file = this.diskPath(fullKey);
    try {
      if (!fs.existsSync(file)) return null;
      const entry: CacheEntry<T> = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (this.isExpired(entry) || entry.version !== this.CACHE_VERSION) {
        try { fs.unlinkSync(file); } catch { /* ignore */ }
        return null;
      }
      return { value: entry.data, entry };
    } catch (error) {
      // Corrupt or unreadable entry — drop it and miss.
      try { fs.unlinkSync(file); } catch { /* ignore */ }
      return null;
    }
  }

  private setOnDisk<T>(fullKey: string, entry: CacheEntry<T>): void {
    if (!this.diskCacheEnabled) return;
    const file = this.diskPath(fullKey);
    try {
      // Atomic write: write to a temp file then rename.
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(entry), 'utf8');
      fs.renameSync(tmp, file);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.debug(`Disk cache write failed: ${message}`);
    }
  }

  private generateKey(key: string): string {
    // Ensure key is safe for Redis and consistent
    const safeKey = key.replace(/[^a-zA-Z0-9:_-]/g, '_');
    return `ai:${safeKey}`;
  }

  private generateContentHash(content: any): string {
    try {
      const serialized = JSON.stringify(content);
      return crypto.createHash('md5').update(serialized).digest('hex').substring(0, 8);
    } catch (error) {
      return 'unknown';
    }
  }

  private isExpired(entry: CacheEntry): boolean {
    const now = Date.now();
    const expirationTime = entry.timestamp + (entry.ttl * 1000);
    return now > expirationTime;
  }

  private async isRedisAvailable(): Promise<boolean> {
    if (!this.redis) return false;

    try {
      await this.redis.ping();
      return true;
    } catch (error) {
      return false;
    }
  }

  private updateHitRate(): void {
    this.stats.hitRate = this.stats.totalRequests > 0 
      ? this.stats.hits / this.stats.totalRequests 
      : 0;
  }

  // Utility methods for cache warming and optimization
  async warm(keys: Array<{ key: string; generator: () => Promise<any> }>): Promise<void> {
    this.logger.info(`Warming cache with ${keys.length} entries`);

    const promises = keys.map(async ({ key, generator }) => {
      try {
        const exists = await this.exists(key);
        if (!exists) {
          const value = await generator();
          await this.set(key, value);
          this.logger.debug(`Cache warmed for key: ${key}`);
        }
      } catch (error) {
        this.logger.error(`Failed to warm cache for key ${key}:`, error);
      }
    });

    await Promise.allSettled(promises);
    this.logger.info('Cache warming completed');
  }

  async getOrSet<T>(
    key: string, 
    generator: () => Promise<T>, 
    ttl?: number
  ): Promise<T> {
    // Try to get from cache first
    const cached = await this.get<T>(key);
    if (cached !== null) {
      return cached;
    }

    // Generate new value
    try {
      const value = await generator();
      await this.set(key, value, ttl);
      return value;
    } catch (error) {
      this.logger.error(`Error generating value for key ${key}:`, error);
      throw error;
    }
  }

  async mget<T>(keys: string[]): Promise<(T | null)[]> {
    const promises = keys.map(key => this.get<T>(key));
    return Promise.all(promises);
  }

  async mset<T>(entries: Array<{ key: string; value: T; ttl?: number }>): Promise<void> {
    const promises = entries.map(({ key, value, ttl }) => this.set(key, value, ttl));
    await Promise.allSettled(promises);
  }

  // Start periodic cleanup
  startCleanup(intervalMs: number = 300000): NodeJS.Timeout { // Default 5 minutes
    return setInterval(async () => {
      await this.cleanup();
    }, intervalMs);
  }

  async close(): Promise<void> {
    if (this.redis) {
      const client = this.redis;
      this.redis = undefined;
      try {
        // disconnect() tears down the socket without sending a QUIT command,
        // so it works even when the connection was never established.
        client.disconnect();
        this.logger.info('Redis connection closed');
      } catch (error) {
        this.logger.debug('Redis already disconnected');
      }
    }
    this.fallbackCache.clear();
  }
}
