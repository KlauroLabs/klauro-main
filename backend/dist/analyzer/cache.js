"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.CacheManager = void 0;
const fs = __importStar(require("fs-extra"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
class CacheManager {
    constructor() {
        this.cache = new Map();
        this.statistics = {
            hits: 0,
            misses: 0,
            evictions: 0,
            size: 0,
            entries: 0,
            hitRate: 0
        };
        this.cacheDirectory = '';
        this.options = {
            maxSize: 100 * 1024 * 1024,
            maxEntries: 10000,
            ttl: 60 * 60 * 1000,
            persistToDisk: true,
            compressionEnabled: true
        };
        this.cleanupInterval = null;
    }
    async initialize(cacheDirectory, options) {
        this.cacheDirectory = cacheDirectory;
        this.options = { ...this.options, ...options };
        if (this.options.persistToDisk) {
            await fs.ensureDir(cacheDirectory);
            await this.loadPersistedCache();
        }
        this.cleanupInterval = setInterval(() => {
            this.cleanup();
        }, 60000);
    }
    async get(key) {
        const entry = this.cache.get(key);
        if (!entry) {
            this.statistics.misses++;
            this.updateHitRate();
            return null;
        }
        if (entry.expiresAt && entry.expiresAt < new Date()) {
            this.cache.delete(key);
            this.statistics.misses++;
            this.updateHitRate();
            return null;
        }
        this.statistics.hits++;
        this.updateHitRate();
        return entry.value;
    }
    async set(key, value, ttl, metadata) {
        const expiresAt = ttl || this.options.ttl
            ? new Date(Date.now() + (ttl || this.options.ttl))
            : undefined;
        const entry = {
            key,
            value,
            timestamp: new Date(),
            expiresAt,
            metadata,
            hash: this.calculateHash(value)
        };
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
        if (this.options.persistToDisk) {
            await this.persistEntry(key, entry);
        }
    }
    async delete(key) {
        const entry = this.cache.get(key);
        if (!entry)
            return false;
        this.cache.delete(key);
        this.statistics.size -= this.estimateSize(entry);
        this.statistics.entries = this.cache.size;
        if (this.options.persistToDisk) {
            await this.deletePersistedEntry(key);
        }
        return true;
    }
    async clear() {
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
    async getFileContent(filePath, mtime) {
        const key = this.generateFileKey(filePath, mtime);
        return this.get(key);
    }
    async saveFileContent(filePath, content, mtime) {
        const key = this.generateFileKey(filePath, mtime);
        await this.set(key, content, undefined, {
            filePath,
            mtime: mtime.toISOString(),
            size: content.length
        });
    }
    async getBlueprint(analysisId) {
        const key = `blueprint:${analysisId}`;
        return this.get(key);
    }
    async saveBlueprint(analysisId, blueprint) {
        const key = `blueprint:${analysisId}`;
        await this.set(key, blueprint, 24 * 60 * 60 * 1000, {
            analysisId,
            projectName: blueprint.projectName,
            componentCount: blueprint.components.length,
            timestamp: new Date().toISOString()
        });
    }
    async getAnalysisResult(projectPath, optionsHash) {
        const key = `analysis:${projectPath}:${optionsHash}`;
        return this.get(key);
    }
    async saveAnalysisResult(projectPath, optionsHash, result) {
        const key = `analysis:${projectPath}:${optionsHash}`;
        await this.set(key, result, 60 * 60 * 1000);
    }
    async cleanup() {
        const now = new Date();
        const keysToDelete = [];
        for (const [key, entry] of this.cache) {
            if (entry.expiresAt && entry.expiresAt < now) {
                keysToDelete.push(key);
            }
        }
        for (const key of keysToDelete) {
            await this.delete(key);
        }
    }
    async evictLRU() {
        let oldestKey = null;
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
    async loadPersistedCache() {
        if (!this.cacheDirectory)
            return;
        try {
            const indexPath = path.join(this.cacheDirectory, 'index.json');
            if (await fs.pathExists(indexPath)) {
                const index = await fs.readJson(indexPath);
                for (const entry of index.entries) {
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
        }
        catch (error) {
            console.warn('Failed to load persisted cache:', error);
        }
    }
    async persistEntry(key, entry) {
        if (!this.cacheDirectory)
            return;
        try {
            const dataPath = path.join(this.cacheDirectory, `${this.sanitizeKey(key)}.json`);
            await fs.writeJson(dataPath, entry.value, { spaces: 2 });
            await this.updatePersistedIndex();
        }
        catch (error) {
            console.warn('Failed to persist cache entry:', error);
        }
    }
    async deletePersistedEntry(key) {
        if (!this.cacheDirectory)
            return;
        try {
            const dataPath = path.join(this.cacheDirectory, `${this.sanitizeKey(key)}.json`);
            await fs.remove(dataPath);
            await this.updatePersistedIndex();
        }
        catch (error) {
            console.warn('Failed to delete persisted cache entry:', error);
        }
    }
    async updatePersistedIndex() {
        if (!this.cacheDirectory)
            return;
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
        }
        catch (error) {
            console.warn('Failed to update cache index:', error);
        }
    }
    generateFileKey(filePath, mtime) {
        return `file:${filePath}:${mtime.getTime()}`;
    }
    sanitizeKey(key) {
        return key.replace(/[^a-zA-Z0-9-_]/g, '_');
    }
    calculateHash(value) {
        const str = typeof value === 'string' ? value : JSON.stringify(value);
        return crypto.createHash('md5').update(str).digest('hex');
    }
    estimateSize(entry) {
        const str = JSON.stringify(entry);
        return Buffer.byteLength(str, 'utf8');
    }
    updateHitRate() {
        const total = this.statistics.hits + this.statistics.misses;
        this.statistics.hitRate = total > 0 ? this.statistics.hits / total : 0;
    }
    getStatistics() {
        return { ...this.statistics };
    }
    printStatistics() {
        console.log('\n--- Cache Statistics ---');
        console.log(`Entries: ${this.statistics.entries}`);
        console.log(`Size: ${this.formatBytes(this.statistics.size)}`);
        console.log(`Hits: ${this.statistics.hits}`);
        console.log(`Misses: ${this.statistics.misses}`);
        console.log(`Hit Rate: ${(this.statistics.hitRate * 100).toFixed(2)}%`);
        console.log(`Evictions: ${this.statistics.evictions}`);
    }
    formatBytes(bytes) {
        const units = ['B', 'KB', 'MB', 'GB'];
        let unitIndex = 0;
        let value = bytes;
        while (value >= 1024 && unitIndex < units.length - 1) {
            value /= 1024;
            unitIndex++;
        }
        return `${value.toFixed(2)} ${units[unitIndex]}`;
    }
    destroy() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }
}
exports.CacheManager = CacheManager;
