import Redis from 'ioredis';
import crypto from 'crypto';
import { aiConfig } from '../config/ai.config';
import { AIRequest, AIResponse } from './providers/openai-provider';

export interface CacheEntry {
  response: AIResponse;
  timestamp: number;
  hits: number;
  provider: string;
  model: string;
}

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  oldestEntry: Date | null;
  newestEntry: Date | null;
  providers: Record<string, number>;
  costSaved: number;
}

export class AICache {
  private redis: Redis | null = null;
  private memoryCache: Map<string, CacheEntry> = new Map();
  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    size: 0,
    oldestEntry: null,
    newestEntry: null,
    providers: {},
    costSaved: 0,
  };
  
  constructor(private config = aiConfig.cache) {
    if (config.enabled && config.redis) {
      try {
        this.redis = new Redis({
          host: config.redis.host,
          port: config.redis.port,
          password: config.redis.password,
          db: config.redis.db,
          retryStrategy: (times) => {
            if (times > 3) {
              console.error('Redis connection failed, falling back to memory cache');
              this.redis = null;
              return null;
            }
            return Math.min(times * 100, 3000);
          },
        });
        
        this.redis.on('error', (err) => {
          console.error('Redis error:', err);
        });
        
        this.redis.on('connect', () => {
          console.log('Connected to Redis for AI caching');
        });
      } catch (error) {
        console.error('Failed to initialize Redis:', error);
        this.redis = null;
      }
    }
    
    // Periodic cleanup of expired entries
    setInterval(() => this.cleanupExpired(), 60000); // Every minute
  }
  
  private generateCacheKey(request: AIRequest, context?: string): string {
    const normalized = {
      prompt: request.prompt.trim(),
      systemPrompt: request.systemPrompt?.trim() || '',
      responseFormat: request.responseFormat || 'text',
      context: context || '',
    };
    
    const hash = crypto
      .createHash('sha256')
      .update(JSON.stringify(normalized))
      .digest('hex');
    
    return `${this.config.redis?.keyPrefix || 'ai:'}${hash}`;
  }
  
  async get(request: AIRequest, context?: string): Promise<AIResponse | null> {
    if (!this.config.enabled) {
      return null;
    }
    
    const key = this.generateCacheKey(request, context);
    
    try {
      // Try Redis first
      if (this.redis) {
        const cached = await this.redis.get(key);
        if (cached) {
          const entry: CacheEntry = JSON.parse(cached);
          
          // Check if entry is expired
          if (Date.now() - entry.timestamp > this.config.ttl * 1000) {
            await this.redis.del(key);
            return null;
          }
          
          // Update stats
          this.stats.hits++;
          this.stats.costSaved += entry.response.cost;
          entry.hits++;
          
          // Update hit count in Redis
          await this.redis.set(key, JSON.stringify(entry), 'EX', this.config.ttl);
          
          return {
            ...entry.response,
            cached: true,
          };
        }
      }
      
      // Try memory cache
      const memEntry = this.memoryCache.get(key);
      if (memEntry) {
        // Check if entry is expired
        if (Date.now() - memEntry.timestamp > this.config.ttl * 1000) {
          this.memoryCache.delete(key);
          return null;
        }
        
        this.stats.hits++;
        this.stats.costSaved += memEntry.response.cost;
        memEntry.hits++;
        
        return {
          ...memEntry.response,
          cached: true,
        };
      }
    } catch (error) {
      console.error('Cache get error:', error);
    }
    
    this.stats.misses++;
    return null;
  }
  
  async set(request: AIRequest, response: AIResponse, context?: string): Promise<void> {
    if (!this.config.enabled) {
      return;
    }
    
    const key = this.generateCacheKey(request, context);
    const entry: CacheEntry = {
      response,
      timestamp: Date.now(),
      hits: 0,
      provider: response.provider,
      model: response.model,
    };
    
    try {
      // Store in Redis if available
      if (this.redis) {
        await this.redis.set(
          key,
          JSON.stringify(entry),
          'EX',
          this.config.ttl
        );
      }
      
      // Also store in memory cache with size limit
      if (this.memoryCache.size >= this.config.maxSize) {
        // Remove oldest entry
        const oldestKey = Array.from(this.memoryCache.entries())
          .sort((a, b) => a[1].timestamp - b[1].timestamp)[0]?.[0];
        
        if (oldestKey) {
          this.memoryCache.delete(oldestKey);
        }
      }
      
      this.memoryCache.set(key, entry);
      
      // Update stats
      this.stats.size = this.memoryCache.size;
      this.stats.newestEntry = new Date(entry.timestamp);
      
      if (!this.stats.oldestEntry) {
        this.stats.oldestEntry = new Date(entry.timestamp);
      }
      
      this.stats.providers[response.provider] = (this.stats.providers[response.provider] || 0) + 1;
    } catch (error) {
      console.error('Cache set error:', error);
    }
  }
  
  async invalidate(pattern?: string): Promise<number> {
    let count = 0;
    
    try {
      if (pattern) {
        // Invalidate by pattern
        if (this.redis) {
          const keys = await this.redis.keys(`${this.config.redis?.keyPrefix || 'ai:'}*${pattern}*`);
          if (keys.length > 0) {
            count += await this.redis.del(...keys);
          }
        }
        
        // Memory cache
        for (const key of this.memoryCache.keys()) {
          if (key.includes(pattern)) {
            this.memoryCache.delete(key);
            count++;
          }
        }
      } else {
        // Clear all
        if (this.redis) {
          const keys = await this.redis.keys(`${this.config.redis?.keyPrefix || 'ai:'}*`);
          if (keys.length > 0) {
            count += await this.redis.del(...keys);
          }
        }
        
        count += this.memoryCache.size;
        this.memoryCache.clear();
      }
      
      this.stats.size = this.memoryCache.size;
    } catch (error) {
      console.error('Cache invalidation error:', error);
    }
    
    return count;
  }
  
  private async cleanupExpired(): Promise<void> {
    const now = Date.now();
    const ttlMs = this.config.ttl * 1000;
    
    // Clean memory cache
    for (const [key, entry] of this.memoryCache.entries()) {
      if (now - entry.timestamp > ttlMs) {
        this.memoryCache.delete(key);
      }
    }
    
    this.stats.size = this.memoryCache.size;
    
    // Redis handles TTL automatically
  }
  
  async warmup(requests: Array<{ request: AIRequest; response: AIResponse; context?: string }>): Promise<void> {
    console.log(`Warming up cache with ${requests.length} entries...`);
    
    for (const { request, response, context } of requests) {
      await this.set(request, response, context);
    }
    
    console.log(`Cache warmup complete. Size: ${this.stats.size}`);
  }
  
  getStats(): CacheStats {
    return {
      ...this.stats,
      hitRate: this.stats.hits / Math.max(1, this.stats.hits + this.stats.misses),
    } as CacheStats & { hitRate: number };
  }
  
  async exportCache(): Promise<Array<{ key: string; entry: CacheEntry }>> {
    const entries: Array<{ key: string; entry: CacheEntry }> = [];
    
    // Export from memory cache
    for (const [key, entry] of this.memoryCache.entries()) {
      entries.push({ key, entry });
    }
    
    // Export from Redis if available
    if (this.redis) {
      try {
        const keys = await this.redis.keys(`${this.config.redis?.keyPrefix || 'ai:'}*`);
        for (const key of keys) {
          const value = await this.redis.get(key);
          if (value) {
            entries.push({
              key,
              entry: JSON.parse(value),
            });
          }
        }
      } catch (error) {
        console.error('Failed to export from Redis:', error);
      }
    }
    
    return entries;
  }
  
  async importCache(entries: Array<{ key: string; entry: CacheEntry }>): Promise<void> {
    console.log(`Importing ${entries.length} cache entries...`);
    
    for (const { key, entry } of entries) {
      // Only import non-expired entries
      if (Date.now() - entry.timestamp <= this.config.ttl * 1000) {
        this.memoryCache.set(key, entry);
        
        if (this.redis) {
          const remainingTtl = Math.floor(
            (this.config.ttl * 1000 - (Date.now() - entry.timestamp)) / 1000
          );
          
          if (remainingTtl > 0) {
            await this.redis.set(key, JSON.stringify(entry), 'EX', remainingTtl);
          }
        }
      }
    }
    
    this.stats.size = this.memoryCache.size;
    console.log(`Cache import complete. Size: ${this.stats.size}`);
  }
  
  async close(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
    }
    
    this.memoryCache.clear();
  }
}