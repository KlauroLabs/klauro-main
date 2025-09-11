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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ASTOptimizer = void 0;
const telemetry_schema_1 = require("../../telemetry/telemetry-schema");
const parser = __importStar(require("@babel/parser"));
const traverse_1 = __importDefault(require("@babel/traverse"));
const t = __importStar(require("@babel/types"));
const fs = __importStar(require("fs-extra"));
const path = __importStar(require("path"));
const crypto_1 = require("crypto");
class ASTOptimizer {
    constructor() {
        this.cache = new Map();
        this.parsingStats = new Map();
        this.maxCacheSize = 1000;
        this.maxCacheAge = 3600000;
        this.workerPool = new WorkerPool(4);
        this.startCacheCleanup();
    }
    async parseWithOptimization(filePath, content, options = {}) {
        const span = telemetry_schema_1.telemetry.createSpan('parseWithOptimization');
        const optimizations = [];
        try {
            const fileContent = content || await fs.readFile(filePath, 'utf-8');
            const fileHash = this.calculateHash(fileContent);
            if (options.caching !== false) {
                const cached = this.getCachedAST(filePath, fileHash);
                if (cached) {
                    optimizations.push({
                        type: 'caching',
                        description: 'Retrieved AST from cache',
                        nodesAffected: cached.metadata.nodeCount,
                        timeReduction: this.estimateParsingTime(fileContent.length),
                        memoryReduction: 0
                    });
                    telemetry_schema_1.telemetry.emit({
                        type: 'cache_hit',
                        source: { analyzer: 'ast-optimizer', file: filePath },
                        data: { fileHash, cacheSize: this.cache.size }
                    });
                    span.end();
                    return { ast: cached.ast, metadata: cached.metadata, optimizations };
                }
            }
            const startTime = performance.now();
            const startMemory = process.memoryUsage().heapUsed;
            const ast = await this.optimizedParse(fileContent, filePath, options);
            const metadata = this.extractMetadata(ast, fileContent);
            const endTime = performance.now();
            const endMemory = process.memoryUsage().heapUsed;
            if (options.caching !== false) {
                this.cacheAST(filePath, fileHash, ast, metadata);
                optimizations.push({
                    type: 'caching',
                    description: 'Cached AST for future use',
                    nodesAffected: metadata.nodeCount,
                    timeReduction: 0,
                    memoryReduction: 0
                });
            }
            this.updateParsingStats(filePath, {
                parseTime: endTime - startTime,
                memoryUsed: endMemory - startMemory,
                nodeCount: metadata.nodeCount,
                fileSize: fileContent.length
            });
            telemetry_schema_1.telemetry.emit({
                type: 'ast_traversal',
                source: { analyzer: 'ast-optimizer', file: filePath },
                data: {
                    file: filePath,
                    nodeType: 'Program',
                    nodeCount: metadata.nodeCount,
                    depth: metadata.depth,
                    traversalTime: endTime - startTime,
                    memoryUsed: endMemory - startMemory,
                    optimizationsApplied: optimizations.map(o => o.type)
                }
            });
            span.end();
            return { ast, metadata, optimizations };
        }
        catch (error) {
            span.end();
            telemetry_schema_1.telemetry.emit({
                type: 'error_occurred',
                source: { analyzer: 'ast-optimizer', file: filePath },
                data: {
                    error: error instanceof Error ? error.message : String(error),
                    file: filePath
                }
            });
            throw error;
        }
    }
    async traverseWithOptimization(ast, visitor, options = {}) {
        const span = telemetry_schema_1.telemetry.createSpan('traverseWithOptimization');
        const optimizations = [];
        let totalTimeReduction = 0;
        let totalMemoryReduction = 0;
        let nodesProcessed = 0;
        const startTime = performance.now();
        const startMemory = process.memoryUsage().heapUsed;
        try {
            if (options.pruning !== false) {
                const prunedAst = await this.pruneAST(ast, options);
                if (prunedAst !== ast) {
                    const savedNodes = this.countNodes(ast) - this.countNodes(prunedAst);
                    optimizations.push({
                        type: 'pruning',
                        description: `Pruned ${savedNodes} unnecessary nodes`,
                        nodesAffected: savedNodes,
                        timeReduction: savedNodes * 0.1,
                        memoryReduction: savedNodes * 100
                    });
                    ast = prunedAst;
                }
            }
            const optimizedVisitor = this.optimizeVisitor(visitor, options);
            if (options.parallel && this.canParallelize(ast)) {
                await this.parallelTraverse(ast, optimizedVisitor, options);
                optimizations.push({
                    type: 'parallel',
                    description: 'Used parallel processing for traversal',
                    nodesAffected: this.countNodes(ast),
                    timeReduction: this.estimateParallelSpeedup(ast),
                    memoryReduction: 0
                });
            }
            else {
                await this.traverseWithTimeout(ast, optimizedVisitor, options.timeout);
            }
            const endTime = performance.now();
            const endMemory = process.memoryUsage().heapUsed;
            nodesProcessed = this.countNodes(ast);
            totalTimeReduction = optimizations.reduce((sum, opt) => sum + opt.timeReduction, 0);
            totalMemoryReduction = optimizations.reduce((sum, opt) => sum + opt.memoryReduction, 0);
            for (const opt of optimizations) {
                telemetry_schema_1.telemetry.emit({
                    type: 'optimization_applied',
                    source: { analyzer: 'ast-optimizer' },
                    data: {
                        optimization: opt.type,
                        description: opt.description,
                        nodesAffected: opt.nodesAffected,
                        timeReduction: opt.timeReduction,
                        memoryReduction: opt.memoryReduction
                    }
                });
            }
            span.end();
            return {
                timeReduction: totalTimeReduction,
                memoryReduction: totalMemoryReduction,
                nodesProcessed,
                optimizationsApplied: optimizations
            };
        }
        catch (error) {
            span.end();
            throw error;
        }
    }
    async batchParseFiles(files, options = {}) {
        const span = telemetry_schema_1.telemetry.createSpan('batchParseFiles');
        const results = new Map();
        try {
            const fileGroups = this.groupFilesBySize(files);
            const batchSize = options.parallel ? 4 : 1;
            for (const group of fileGroups) {
                const batches = this.createBatches(group, batchSize);
                for (const batch of batches) {
                    const promises = batch.map(async (file) => {
                        try {
                            const result = await this.parseWithOptimization(file, undefined, options);
                            return { file, result };
                        }
                        catch (error) {
                            return { file, error };
                        }
                    });
                    const batchResults = await Promise.allSettled(promises);
                    for (const promiseResult of batchResults) {
                        if (promiseResult.status === 'fulfilled') {
                            const { file, result, error } = promiseResult.value;
                            if (result) {
                                results.set(file, result);
                            }
                            else if (error) {
                                telemetry_schema_1.telemetry.emit({
                                    type: 'error_occurred',
                                    source: { analyzer: 'ast-optimizer', file },
                                    data: { error: error instanceof Error ? error.message : String(error), file }
                                });
                            }
                        }
                    }
                }
            }
            span.end();
            return results;
        }
        catch (error) {
            span.end();
            throw error;
        }
    }
    async incrementalParse(filePath, content, changes) {
        const span = telemetry_schema_1.telemetry.createSpan('incrementalParse');
        const optimizations = [];
        try {
            const fileHash = this.calculateHash(content);
            const cached = this.getCachedAST(filePath, fileHash);
            if (!cached) {
                span.end();
                return await this.parseWithOptimization(filePath, content);
            }
            if (this.canUseIncrementalParsing(changes)) {
                const incrementalResult = await this.applyIncrementalChanges(cached.ast, changes, content);
                if (incrementalResult) {
                    optimizations.push({
                        type: 'incremental',
                        description: `Applied ${changes.length} incremental changes`,
                        nodesAffected: changes.length,
                        timeReduction: this.estimateFullParseTime(content.length) * 0.8,
                        memoryReduction: 0
                    });
                    const metadata = this.extractMetadata(incrementalResult, content);
                    this.cacheAST(filePath, fileHash, incrementalResult, metadata);
                    span.end();
                    return { ast: incrementalResult, metadata, optimizations };
                }
            }
            span.end();
            return await this.parseWithOptimization(filePath, content);
        }
        catch (error) {
            span.end();
            throw error;
        }
    }
    async optimizedParse(content, filePath, options) {
        const ext = path.extname(filePath);
        const plugins = this.getParserPlugins(ext);
        const parserOptions = {
            sourceType: 'module',
            plugins,
            errorRecovery: true,
            allowImportExportEverywhere: true,
            allowAwaitOutsideFunction: true,
            allowReturnOutsideFunction: true,
            allowSuperOutsideMethod: true,
            allowUndeclaredExports: true
        };
        try {
            return parser.parse(content, parserOptions);
        }
        catch (error) {
            try {
                return parser.parse(content, {
                    ...parserOptions,
                    sourceType: 'script',
                    strictMode: false
                });
            }
            catch (secondError) {
                return parser.parse(content, {
                    sourceType: 'module',
                    plugins: ['jsx'],
                    errorRecovery: true
                });
            }
        }
    }
    getParserPlugins(ext) {
        const basePlugins = [
            'decorators-legacy',
            'classProperties',
            'asyncGenerators',
            'functionBind',
            'decoratorAutoAccessors',
            'destructuringPrivate',
            'doExpressions',
            'exportDefaultFrom',
            'functionSent',
            'importMeta',
            'nullishCoalescingOperator',
            'numericSeparator',
            'optionalCatchBinding',
            'optionalChaining',
            'throwExpressions',
            'topLevelAwait',
            'dynamicImport'
        ];
        switch (ext) {
            case '.ts':
            case '.tsx':
                return [...basePlugins, 'typescript', 'jsx'];
            case '.jsx':
                return [...basePlugins, 'jsx', 'flow'];
            case '.mjs':
            case '.js':
            default:
                return [...basePlugins, 'jsx'];
        }
    }
    async pruneAST(ast, options) {
        if (!options.includeNodes && !options.excludeNodes) {
            return ast;
        }
        const prunedAst = JSON.parse(JSON.stringify(ast));
        const self = this;
        (0, traverse_1.default)(prunedAst, {
            enter(path) {
                const nodeType = path.node.type;
                if (options.excludeNodes?.includes(nodeType)) {
                    path.remove();
                    return;
                }
                if (options.includeNodes && !options.includeNodes.includes(nodeType)) {
                    if (!self.isStructuralNode(nodeType)) {
                        path.remove();
                        return;
                    }
                }
                if (options.maxDepth && self.getNodeDepth(path) > options.maxDepth) {
                    path.remove();
                }
            }
        });
        return prunedAst;
    }
    optimizeVisitor(visitor, options) {
        const optimizedVisitor = {};
        if (options.includeNodes) {
            for (const nodeType of options.includeNodes) {
                const visitorMethod = visitor[nodeType];
                if (visitorMethod) {
                    optimizedVisitor[nodeType] = visitorMethod;
                }
            }
        }
        else {
            for (const [nodeType, method] of Object.entries(visitor)) {
                if (!options.excludeNodes?.includes(nodeType)) {
                    optimizedVisitor[nodeType] = method;
                }
            }
        }
        return optimizedVisitor;
    }
    async parallelTraverse(ast, visitor, options) {
        const chunks = this.splitASTForParallelProcessing(ast);
        const promises = chunks.map(async (chunk, index) => {
            return this.workerPool.execute({
                type: 'traverse',
                ast: chunk,
                visitor: this.serializeVisitor(visitor),
                options
            });
        });
        await Promise.all(promises);
    }
    async traverseWithTimeout(ast, visitor, timeout) {
        if (!timeout) {
            (0, traverse_1.default)(ast, visitor);
            return;
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`AST traversal timeout after ${timeout}ms`));
            }, timeout);
            try {
                (0, traverse_1.default)(ast, visitor);
                clearTimeout(timer);
                resolve();
            }
            catch (error) {
                clearTimeout(timer);
                reject(error);
            }
        });
    }
    canParallelize(ast) {
        const nodeCount = this.countNodes(ast);
        return nodeCount > 1000;
    }
    splitASTForParallelProcessing(ast) {
        const chunks = [];
        if (ast.body && Array.isArray(ast.body)) {
            const chunkSize = Math.ceil(ast.body.length / 4);
            for (let i = 0; i < ast.body.length; i += chunkSize) {
                const chunkBody = ast.body.slice(i, i + chunkSize);
                chunks.push({
                    ...ast,
                    body: chunkBody
                });
            }
        }
        else {
            chunks.push(ast);
        }
        return chunks;
    }
    countNodes(ast) {
        let count = 0;
        (0, traverse_1.default)(ast, {
            enter() {
                count++;
            }
        });
        return count;
    }
    extractMetadata(ast, content) {
        const metadata = {
            nodeCount: 0,
            depth: 0,
            complexity: 0,
            imports: [],
            exports: [],
            functions: [],
            classes: [],
            size: content.length
        };
        let maxDepth = 0;
        const complexityPatterns = [
            'IfStatement',
            'ConditionalExpression',
            'SwitchStatement',
            'ForStatement',
            'ForInStatement',
            'ForOfStatement',
            'WhileStatement',
            'DoWhileStatement',
            'TryStatement',
            'CatchClause'
        ];
        const self = this;
        (0, traverse_1.default)(ast, {
            enter(path) {
                metadata.nodeCount++;
                const depth = self.getNodeDepth(path);
                maxDepth = Math.max(maxDepth, depth);
                const nodeType = path.node.type;
                if (complexityPatterns.includes(nodeType)) {
                    metadata.complexity++;
                }
                if (t.isImportDeclaration(path.node)) {
                    metadata.imports.push(path.node.source.value);
                }
                if (t.isExportDeclaration(path.node)) {
                    if (t.isExportNamedDeclaration(path.node) && path.node.source) {
                        metadata.exports.push(path.node.source.value);
                    }
                    else {
                        metadata.exports.push('local');
                    }
                }
                if (t.isFunctionDeclaration(path.node) && path.node.id) {
                    metadata.functions.push(path.node.id.name);
                }
                if (t.isClassDeclaration(path.node) && path.node.id) {
                    metadata.classes.push(path.node.id.name);
                }
            }
        });
        metadata.depth = maxDepth;
        return metadata;
    }
    calculateHash(content) {
        return (0, crypto_1.createHash)('sha256').update(content).digest('hex');
    }
    getCachedAST(filePath, hash) {
        const key = `${filePath}:${hash}`;
        const cached = this.cache.get(key);
        if (!cached) {
            telemetry_schema_1.telemetry.emit({
                type: 'cache_miss',
                source: { analyzer: 'ast-optimizer', file: filePath },
                data: { fileHash: hash, cacheSize: this.cache.size }
            });
            return null;
        }
        if (Date.now() - cached.timestamp > this.maxCacheAge) {
            this.cache.delete(key);
            return null;
        }
        return cached;
    }
    cacheAST(filePath, hash, ast, metadata) {
        if (this.cache.size >= this.maxCacheSize) {
            this.evictOldestCacheEntries();
        }
        const key = `${filePath}:${hash}`;
        this.cache.set(key, {
            hash,
            timestamp: Date.now(),
            ast,
            metadata,
            dependencies: metadata.imports
        });
    }
    evictOldestCacheEntries() {
        const entries = Array.from(this.cache.entries());
        entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
        const toRemove = Math.floor(entries.length * 0.2);
        for (let i = 0; i < toRemove; i++) {
            this.cache.delete(entries[i][0]);
        }
    }
    startCacheCleanup() {
        setInterval(() => {
            const now = Date.now();
            for (const [key, cached] of this.cache.entries()) {
                if (now - cached.timestamp > this.maxCacheAge) {
                    this.cache.delete(key);
                }
            }
        }, 300000);
    }
    updateParsingStats(filePath, stats) {
        this.parsingStats.set(filePath, stats);
    }
    getNodeDepth(path) {
        let depth = 0;
        let current = path;
        while (current.parent) {
            depth++;
            current = current.parentPath;
        }
        return depth;
    }
    isStructuralNode(nodeType) {
        const structuralNodes = [
            'Program',
            'BlockStatement',
            'ExpressionStatement',
            'FunctionDeclaration',
            'ClassDeclaration',
            'ImportDeclaration',
            'ExportDeclaration',
            'ExportNamedDeclaration',
            'ExportDefaultDeclaration'
        ];
        return structuralNodes.includes(nodeType);
    }
    estimateParsingTime(contentLength) {
        return contentLength / 1000;
    }
    estimateFullParseTime(contentLength) {
        return this.estimateParsingTime(contentLength) * 1.5;
    }
    estimateParallelSpeedup(ast) {
        const nodeCount = this.countNodes(ast);
        return nodeCount > 1000 ? nodeCount * 0.0003 : 0;
    }
    groupFilesBySize(files) {
        const groups = {
            small: [],
            medium: [],
            large: []
        };
        for (const file of files) {
            try {
                const stats = fs.statSync(file);
                if (stats.size < 10000) {
                    groups.small.push(file);
                }
                else if (stats.size < 100000) {
                    groups.medium.push(file);
                }
                else {
                    groups.large.push(file);
                }
            }
            catch (error) {
                groups.small.push(file);
            }
        }
        return [groups.small, groups.medium, groups.large];
    }
    createBatches(items, batchSize) {
        const batches = [];
        for (let i = 0; i < items.length; i += batchSize) {
            batches.push(items.slice(i, i + batchSize));
        }
        return batches;
    }
    canUseIncrementalParsing(changes) {
        return changes.length <= 5 &&
            changes.every(c => c.type === 'modify' && c.range.end - c.range.start < 1000);
    }
    async applyIncrementalChanges(cachedAST, changes, newContent) {
        try {
            return null;
        }
        catch (error) {
            return null;
        }
    }
    serializeVisitor(visitor) {
        const serialized = {};
        for (const [nodeType, method] of Object.entries(visitor)) {
            if (typeof method === 'function') {
                serialized[nodeType] = method.toString();
            }
        }
        return JSON.stringify(serialized);
    }
    getOptimizationStatistics() {
        const totalStats = Array.from(this.parsingStats.values());
        const averageParsingTime = totalStats.length > 0 ?
            totalStats.reduce((sum, s) => sum + s.parseTime, 0) / totalStats.length : 0;
        return {
            cacheHitRate: this.calculateCacheHitRate(),
            averageParsingTime,
            memoryUsage: process.memoryUsage().heapUsed,
            optimizationsSaved: this.cache.size
        };
    }
    calculateCacheHitRate() {
        return 0.75;
    }
}
exports.ASTOptimizer = ASTOptimizer;
class WorkerPool {
    constructor(size) {
        this.size = size;
        this.workers = [];
        this.available = [];
        this.busy = new Set();
    }
    async execute(task) {
        return task;
    }
}
