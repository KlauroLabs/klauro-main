// Cache management for analyzer performance optimization
// Production-ready caching with TTL, invalidation, and persistence

import * as fs from 'fs-extra';
import * as path from 'path';
import * as crypto from 'crypto';
import { ArchitectureBlueprint } from '../types';

export interface CacheEntry<T = any> {
  key: string;
  value: T;
  timestamp: Date;
  expiresAt?: Date;
  metadata?: Record<string, any>;
  hash?: string;
}

export interface CacheStatistics {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
  entries: number;
  hitRate: number;
}

export interface CacheOptions {
  maxSize?: number; // Maximum cache size in bytes
  maxEntries?: number; // Maximum number of entries
  ttl?: number; // Time to live in milliseconds
  persistToDisk?: boolean; // Whether to persist cache to disk
  compressionEnabled?: boolean; // Enable compression for large entries
}

export class CacheManager {
  private cache: Map<string, CacheEntry> = new Map();
  private statistics: CacheStatistics = {
    hits: 0,
    misses: 0,
    evictions: 0,
    size: 0,
    entries: 0,
    hitRate: 0
  };
  private cacheDirectory: string = '';
  private options: CacheOptions = {
    maxSize: 100 * 1024 * 1024, // 100MB default
    maxEntries: 10000,
    ttl: 60 * 60 * 1000, // 1 hour default
    persistToDisk: true,
    compressionEnabled: true
  };
  private cleanupInterval: NodeJS.Timeout | null = null;

  async initialize(cacheDirectory: string, options?: CacheOptions): Promise<void> {
    this.cacheDirectory = cacheDirectory;
    this.options = { ...this.options, ...options };

    if (this.options.persistToDisk) {
      await fs.ensureDir(cacheDirectory);
      await this.loadPersistedCache();
    }

    // Start cleanup interval
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60000); // Cleanup every minute
  }

  async get<T = any>(key: string): Promise<T | null> {
    const entry = this.cache.get(key);

    if (!entry) {
      this.statistics.misses++;
      this.updateHitRate();
      return null;
    }

    // Check expiration
    if (entry.expiresAt && entry.expiresAt < new Date()) {
      this.cache.delete(key);
      this.statistics.misses++;
      this.updateHitRate();
      return null;
    }

    this.statistics.hits++;
    this.updateHitRate();
    return entry.value as T;
  }

  async set<T = any>(
    key: string,
    value: T,
    ttl?: number,
    metadata?: Record<string, any>
  ): Promise<void> {
    const expiresAt = ttl || this.options.ttl
      ? new Date(Date.now() + (ttl || this.options.ttl!))
      : undefined;

    const entry: CacheEntry<T> = {
      key,
      value,
      timestamp: new Date(),
      expiresAt,
      metadata,
      hash: this.calculateHash(value)
    };

    // Check size constraints
    const entrySize = this.estimateSize(entry);
    
    if (this.options.maxSize && this.statistics.size + entrySize > this.options.maxSize) {
      await this.evictLRU();
    }

    if (this.options.maxEntries && this.cache.size >= this.options.maxEntries) {
      await this.evictLRU();
    }

    this.cache.set(key, entry);
    this.statistics.size += entrySize;
    this.statistics.entries = this.cache.size;

    // Persist to disk if enabled
    if (this.options.persistToDisk) {
      await this.persistEntry(key, entry);
    }
  }

  async delete(key: string): Promise<boolean> {
    const entry = this.cache.get(key);
    if (!entry) return false;

    this.cache.delete(key);
    this.statistics.size -= this.estimateSize(entry);
    this.statistics.entries = this.cache.size;

    if (this.options.persistToDisk) {
      await this.deletePersistedEntry(key);
    }

    return true;
  }

  async clear(): Promise<void> {
    this.cache.clear();
    this.statistics = {
      hits: 0,
      misses: 0,
      evictions: 0,
      size: 0,
      entries: 0,
      hitRate: 0
    };

    if (this.options.persistToDisk && this.cacheDirectory) {
      await fs.emptyDir(this.cacheDirectory);
    }
  }

  // Specialized methods for analyzer caching
  
  async getFileContent(filePath: string, mtime: Date): Promise<string | null> {
    const key = this.generateFileKey(filePath, mtime);
    return this.get<string>(key);
  }

  async saveFileContent(filePath: string, content: string, mtime: Date): Promise<void> {
    const key = this.generateFileKey(filePath, mtime);
    await this.set(key, content, undefined, {
      filePath,
      mtime: mtime.toISOString(),
      size: content.length
    });
  }

  async getBlueprint(analysisId: string): Promise<ArchitectureBlueprint | null> {
    const key = `blueprint:${analysisId}`;
    return this.get<ArchitectureBlueprint>(key);
  }

  async saveBlueprint(analysisId: string, blueprint: ArchitectureBlueprint): Promise<void> {
    const key = `blueprint:${analysisId}`;
    await this.set(key, blueprint, 24 * 60 * 60 * 1000, { // Cache for 24 hours
      analysisId,
      projectName: blueprint.projectName,
      componentCount: blueprint.components.length,
      timestamp: new Date().toISOString()
    });
  }

  async getAnalysisResult(projectPath: string, optionsHash: string): Promise<any | null> {
    const key = `analysis:${projectPath}:${optionsHash}`;
    return this.get(key);
  }

  async saveAnalysisResult(
    projectPath: string,
    optionsHash: string,
    result: any
  ): Promise<void> {
    const key = `analysis:${projectPath}:${optionsHash}`;
    await this.set(key, result, 60 * 60 * 1000); // Cache for 1 hour
  }

  // Cache maintenance methods

  private async cleanup(): Promise<void> {
    const now = new Date();
    const keysToDelete: string[] = [];

    for (const [key, entry] of this.cache) {
      if (entry.expiresAt && entry.expiresAt < now) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      await this.delete(key);
    }
  }

  private async evictLRU(): Promise<void> {
    // Find oldest entry based on timestamp
    let oldestKey: string | null = null;
    let oldestTime = new Date();

    for (const [key, entry] of this.cache) {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      await this.delete(oldestKey);
      this.statistics.evictions++;
    }
  }

  // Persistence methods

  private async loadPersistedCache(): Promise<void> {
    if (!this.cacheDirectory) return;

    try {
      const indexPath = path.join(this.cacheDirectory, 'index.json');
      if (await fs.pathExists(indexPath)) {
        const index = await fs.readJson(indexPath);
        
        for (const entry of index.entries) {
          // Check if entry is still valid
          if (!entry.expiresAt || new Date(entry.expiresAt) > new Date()) {
            const dataPath = path.join(this.cacheDirectory, `${entry.key}.json`);
            if (await fs.pathExists(dataPath)) {
              const data = await fs.readJson(dataPath);
              this.cache.set(entry.key, {
                ...entry,
                value: data,
                timestamp: new Date(entry.timestamp),
                expiresAt: entry.expiresAt ? new Date(entry.expiresAt) : undefined
              });
            }
          }
        }

        this.statistics.entries = this.cache.size;
      }
    } catch (error) {
      console.warn('Failed to load persisted cache:', error);
    }
  }

  private async persistEntry(key: string, entry: CacheEntry): Promise<void> {
    if (!this.cacheDirectory) return;

    try {
      // Save entry data
      const dataPath = path.join(this.cacheDirectory, `${this.sanitizeKey(key)}.json`);
      await fs.writeJson(dataPath, entry.value, { spaces: 2 });

      // Update index
      await this.updatePersistedIndex();
    } catch (error) {
      console.warn('Failed to persist cache entry:', error);
    }
  }

  private async deletePersistedEntry(key: string): Promise<void> {
    if (!this.cacheDirectory) return;

    try {
      const dataPath = path.join(this.cacheDirectory, `${this.sanitizeKey(key)}.json`);
      await fs.remove(dataPath);
      await this.updatePersistedIndex();
    } catch (error) {
      console.warn('Failed to delete persisted cache entry:', error);
    }
  }

  private async updatePersistedIndex(): Promise<void> {
    if (!this.cacheDirectory) return;

    try {
      const index = {
        version: '1.0.0',
        updated: new Date().toISOString(),
        entries: Array.from(this.cache.entries()).map(([key, entry]) => ({
          key,
          timestamp: entry.timestamp.toISOString(),
          expiresAt: entry.expiresAt?.toISOString(),
          metadata: entry.metadata,
          hash: entry.hash
        }))
      };

      const indexPath = path.join(this.cacheDirectory, 'index.json');
      await fs.writeJson(indexPath, index, { spaces: 2 });
    } catch (error) {
      console.warn('Failed to update cache index:', error);
    }
  }

  // Utility methods

  private generateFileKey(filePath: string, mtime: Date): string {
    return `file:${filePath}:${mtime.getTime()}`;
  }

  private sanitizeKey(key: string): string {
    // Replace characters that might be problematic in filenames
    return key.replace(/[^a-zA-Z0-9-_]/g, '_');
  }

  private calculateHash(value: any): string {
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    return crypto.createHash('md5').update(str).digest('hex');
  }

  private estimateSize(entry: CacheEntry): number {
    // Rough estimation of entry size in bytes
    const str = JSON.stringify(entry);
    return Buffer.byteLength(str, 'utf8');
  }

  private updateHitRate(): void {
    const total = this.statistics.hits + this.statistics.misses;
    this.statistics.hitRate = total > 0 ? this.statistics.hits / total : 0;
  }

  // Public statistics methods

  getStatistics(): CacheStatistics {
    return { ...this.statistics };
  }

  printStatistics(): void {
    console.log('\n--- Cache Statistics ---');
    console.log(`Entries: ${this.statistics.entries}`);
    console.log(`Size: ${this.formatBytes(this.statistics.size)}`);
    console.log(`Hits: ${this.statistics.hits}`);
    console.log(`Misses: ${this.statistics.misses}`);
    console.log(`Hit Rate: ${(this.statistics.hitRate * 100).toFixed(2)}%`);
    console.log(`Evictions: ${this.statistics.evictions}`);
  }

  private formatBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB'];
    let unitIndex = 0;
    let value = bytes;

    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex++;
    }

    return `${value.toFixed(2)} ${units[unitIndex]}`;
  }

  // Cleanup on destroy
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}