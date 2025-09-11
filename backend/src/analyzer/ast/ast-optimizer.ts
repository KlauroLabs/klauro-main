/**
 * AST Optimizer for Performance
 * Optimizes AST traversal and parsing for large codebases
 * Implements caching, pruning, parallel processing, and incremental analysis
 */

import { telemetry, ASTTraversalEvent, ASTOptimization } from '../../telemetry/telemetry-schema';
import * as parser from '@babel/parser';
import traverse, { NodePath, Visitor } from '@babel/traverse';
import * as t from '@babel/types';
import * as fs from 'fs-extra';
import * as path from 'path';
import { createHash } from 'crypto';

export interface ASTCache {
  hash: string;
  timestamp: number;
  ast: any;
  metadata: ASTMetadata;
  dependencies: string[];
}

export interface ASTMetadata {
  nodeCount: number;
  depth: number;
  complexity: number;
  imports: string[];
  exports: string[];
  functions: string[];
  classes: string[];
  size: number;
}

export interface TraversalOptions {
  includeNodes?: string[];
  excludeNodes?: string[];
  maxDepth?: number;
  parallel?: boolean;
  caching?: boolean;
  pruning?: boolean;
  incremental?: boolean;
  timeout?: number;
}

export interface OptimizationResult {
  timeReduction: number;
  memoryReduction: number;
  nodesProcessed: number;
  optimizationsApplied: ASTOptimization[];
}

export class ASTOptimizer {
  private cache: Map<string, ASTCache> = new Map();
  private parsingStats: Map<string, ParsingStats> = new Map();
  private maxCacheSize: number = 1000;
  private maxCacheAge: number = 3600000; // 1 hour
  private workerPool: WorkerPool;

  constructor() {
    this.workerPool = new WorkerPool(4);
    this.startCacheCleanup();
  }

  public async parseWithOptimization(
    filePath: string,
    content?: string,
    options: TraversalOptions = {}
  ): Promise<{ ast: any; metadata: ASTMetadata; optimizations: ASTOptimization[] }> {
    const span = telemetry.createSpan('parseWithOptimization');
    const optimizations: ASTOptimization[] = [];

    try {
      // Use content or read file
      const fileContent = content || await fs.readFile(filePath, 'utf-8');
      const fileHash = this.calculateHash(fileContent);

      // Check cache first
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

          telemetry.emit({
            type: 'cache_hit',
            source: { analyzer: 'ast-optimizer', file: filePath },
            data: { fileHash, cacheSize: this.cache.size }
          });

          span.end();
          return { ast: cached.ast, metadata: cached.metadata, optimizations };
        }
      }

      // Parse with optimizations
      const startTime = performance.now();
      const startMemory = process.memoryUsage().heapUsed;

      const ast = await this.optimizedParse(fileContent, filePath, options);
      const metadata = this.extractMetadata(ast, fileContent);

      const endTime = performance.now();
      const endMemory = process.memoryUsage().heapUsed;

      // Cache the result
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

      // Update statistics
      this.updateParsingStats(filePath, {
        parseTime: endTime - startTime,
        memoryUsed: endMemory - startMemory,
        nodeCount: metadata.nodeCount,
        fileSize: fileContent.length
      });

      // Emit telemetry
      telemetry.emit({
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
      } as ASTTraversalEvent);

      span.end();
      return { ast, metadata, optimizations };

    } catch (error) {
      span.end();
      telemetry.emit({
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

  public async traverseWithOptimization(
    ast: any,
    visitor: Visitor,
    options: TraversalOptions = {}
  ): Promise<OptimizationResult> {
    const span = telemetry.createSpan('traverseWithOptimization');
    const optimizations: ASTOptimization[] = [];
    let totalTimeReduction = 0;
    let totalMemoryReduction = 0;
    let nodesProcessed = 0;

    const startTime = performance.now();
    const startMemory = process.memoryUsage().heapUsed;

    try {
      // Apply pruning optimization
      if (options.pruning !== false) {
        const prunedAst = await this.pruneAST(ast, options);
        if (prunedAst !== ast) {
          const savedNodes = this.countNodes(ast) - this.countNodes(prunedAst);
          optimizations.push({
            type: 'pruning',
            description: `Pruned ${savedNodes} unnecessary nodes`,
            nodesAffected: savedNodes,
            timeReduction: savedNodes * 0.1, // Estimate
            memoryReduction: savedNodes * 100 // Estimate bytes per node
          });
          ast = prunedAst;
        }
      }

      // Apply optimized visitor
      const optimizedVisitor = this.optimizeVisitor(visitor, options);

      // Apply parallel processing if enabled
      if (options.parallel && this.canParallelize(ast)) {
        await this.parallelTraverse(ast, optimizedVisitor, options);
        optimizations.push({
          type: 'parallel',
          description: 'Used parallel processing for traversal',
          nodesAffected: this.countNodes(ast),
          timeReduction: this.estimateParallelSpeedup(ast),
          memoryReduction: 0
        });
      } else {
        // Standard traversal with timeout
        await this.traverseWithTimeout(ast, optimizedVisitor, options.timeout);
      }

      const endTime = performance.now();
      const endMemory = process.memoryUsage().heapUsed;
      
      nodesProcessed = this.countNodes(ast);
      totalTimeReduction = optimizations.reduce((sum, opt) => sum + opt.timeReduction, 0);
      totalMemoryReduction = optimizations.reduce((sum, opt) => sum + opt.memoryReduction, 0);

      // Emit telemetry for optimizations
      for (const opt of optimizations) {
        telemetry.emit({
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

    } catch (error) {
      span.end();
      throw error;
    }
  }

  public async batchParseFiles(
    files: string[],
    options: TraversalOptions = {}
  ): Promise<Map<string, { ast: any; metadata: ASTMetadata; optimizations: ASTOptimization[] }>> {
    const span = telemetry.createSpan('batchParseFiles');
    const results = new Map();

    try {
      // Group files by size for optimal batching
      const fileGroups = this.groupFilesBySize(files);

      // Process in parallel batches
      const batchSize = options.parallel ? 4 : 1;
      for (const group of fileGroups) {
        const batches = this.createBatches(group, batchSize);
        
        for (const batch of batches) {
          const promises = batch.map(async (file) => {
            try {
              const result = await this.parseWithOptimization(file, undefined, options);
              return { file, result };
            } catch (error) {
              return { file, error };
            }
          });

          const batchResults = await Promise.allSettled(promises);
          
          for (const promiseResult of batchResults) {
            if (promiseResult.status === 'fulfilled') {
              const { file, result, error } = promiseResult.value;
              if (result) {
                results.set(file, result);
              } else if (error) {
                telemetry.emit({
                  type: 'error_occurred',
                  source: { analyzer: 'ast-optimizer', file },
                  data: { error: error.message, file }
                });
              }
            }
          }
        }
      }

      span.end();
      return results;

    } catch (error) {
      span.end();
      throw error;
    }
  }

  public async incrementalParse(
    filePath: string,
    content: string,
    changes: FileChange[]
  ): Promise<{ ast: any; metadata: ASTMetadata; optimizations: ASTOptimization[] }> {
    const span = telemetry.createSpan('incrementalParse');
    const optimizations: ASTOptimization[] = [];

    try {
      const fileHash = this.calculateHash(content);
      const cached = this.getCachedAST(filePath, fileHash);

      if (!cached) {
        // No cache, do full parse
        span.end();
        return await this.parseWithOptimization(filePath, content);
      }

      // Try incremental parsing
      if (this.canUseIncrementalParsing(changes)) {
        const incrementalResult = await this.applyIncrementalChanges(
          cached.ast, 
          changes, 
          content
        );

        if (incrementalResult) {
          optimizations.push({
            type: 'incremental',
            description: `Applied ${changes.length} incremental changes`,
            nodesAffected: changes.length,
            timeReduction: this.estimateFullParseTime(content.length) * 0.8,
            memoryReduction: 0
          });

          const metadata = this.extractMetadata(incrementalResult, content);
          
          // Update cache
          this.cacheAST(filePath, fileHash, incrementalResult, metadata);

          span.end();
          return { ast: incrementalResult, metadata, optimizations };
        }
      }

      // Fall back to full parsing
      span.end();
      return await this.parseWithOptimization(filePath, content);

    } catch (error) {
      span.end();
      throw error;
    }
  }

  private async optimizedParse(
    content: string,
    filePath: string,
    options: TraversalOptions
  ): Promise<any> {
    // Determine parser options based on file extension
    const ext = path.extname(filePath);
    const plugins = this.getParserPlugins(ext);

    // Use error recovery for better resilience
    const parserOptions = {
      sourceType: 'module' as const,
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
    } catch (error) {
      // Try with more lenient options
      try {
        return parser.parse(content, {
          ...parserOptions,
          sourceType: 'script',
          strictMode: false
        });
      } catch (secondError) {
        // Last resort: try parsing as plain JavaScript
        return parser.parse(content, {
          sourceType: 'module',
          plugins: ['jsx'],
          errorRecovery: true
        });
      }
    }
  }

  private getParserPlugins(ext: string): any[] {
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

  private async pruneAST(ast: any, options: TraversalOptions): Promise<any> {
    if (!options.includeNodes && !options.excludeNodes) {
      return ast;
    }

    const prunedAst = JSON.parse(JSON.stringify(ast)); // Deep clone

    traverse(prunedAst, {
      enter(path: NodePath) {
        const nodeType = path.node.type;

        // Exclude specific nodes
        if (options.excludeNodes?.includes(nodeType)) {
          path.remove();
          return;
        }

        // Include only specific nodes
        if (options.includeNodes && !options.includeNodes.includes(nodeType)) {
          // Keep structural nodes to maintain AST integrity
          if (!this.isStructuralNode(nodeType)) {
            path.remove();
            return;
          }
        }

        // Respect max depth
        if (options.maxDepth && this.getNodeDepth(path) > options.maxDepth) {
          path.remove();
        }
      }
    });

    return prunedAst;
  }

  private optimizeVisitor(visitor: Visitor, options: TraversalOptions): Visitor {
    const optimizedVisitor: Visitor = {};

    // Only include visitor methods for node types we're interested in
    if (options.includeNodes) {
      for (const nodeType of options.includeNodes) {
        if (visitor[nodeType]) {
          optimizedVisitor[nodeType] = visitor[nodeType];
        }
      }
    } else {
      // Copy all visitor methods except excluded ones
      for (const [nodeType, method] of Object.entries(visitor)) {
        if (!options.excludeNodes?.includes(nodeType)) {
          optimizedVisitor[nodeType] = method;
        }
      }
    }

    return optimizedVisitor;
  }

  private async parallelTraverse(
    ast: any,
    visitor: Visitor,
    options: TraversalOptions
  ): Promise<void> {
    // Split AST into traversable chunks
    const chunks = this.splitASTForParallelProcessing(ast);
    
    // Process chunks in parallel using worker pool
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

  private async traverseWithTimeout(
    ast: any,
    visitor: Visitor,
    timeout?: number
  ): Promise<void> {
    if (!timeout) {
      traverse(ast, visitor);
      return;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`AST traversal timeout after ${timeout}ms`));
      }, timeout);

      try {
        traverse(ast, visitor);
        clearTimeout(timer);
        resolve();
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  private canParallelize(ast: any): boolean {
    const nodeCount = this.countNodes(ast);
    return nodeCount > 1000; // Only parallelize for large ASTs
  }

  private splitASTForParallelProcessing(ast: any): any[] {
    const chunks: any[] = [];
    
    // Split by top-level declarations
    if (ast.body && Array.isArray(ast.body)) {
      const chunkSize = Math.ceil(ast.body.length / 4);
      for (let i = 0; i < ast.body.length; i += chunkSize) {
        const chunkBody = ast.body.slice(i, i + chunkSize);
        chunks.push({
          ...ast,
          body: chunkBody
        });
      }
    } else {
      // Can't split this AST
      chunks.push(ast);
    }

    return chunks;
  }

  private countNodes(ast: any): number {
    let count = 0;
    traverse(ast, {
      enter() {
        count++;
      }
    });
    return count;
  }

  private extractMetadata(ast: any, content: string): ASTMetadata {
    const metadata: ASTMetadata = {
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

    traverse(ast, {
      enter(path: NodePath) {
        metadata.nodeCount++;
        
        const depth = this.getNodeDepth(path);
        maxDepth = Math.max(maxDepth, depth);

        const nodeType = path.node.type;
        
        // Track complexity
        if (complexityPatterns.includes(nodeType)) {
          metadata.complexity++;
        }

        // Track imports
        if (t.isImportDeclaration(path.node)) {
          metadata.imports.push(path.node.source.value);
        }

        // Track exports
        if (t.isExportDeclaration(path.node)) {
          if (t.isExportNamedDeclaration(path.node) && path.node.source) {
            metadata.exports.push(path.node.source.value);
          } else {
            metadata.exports.push('local');
          }
        }

        // Track functions
        if (t.isFunctionDeclaration(path.node) && path.node.id) {
          metadata.functions.push(path.node.id.name);
        }

        // Track classes
        if (t.isClassDeclaration(path.node) && path.node.id) {
          metadata.classes.push(path.node.id.name);
        }
      }
    });

    metadata.depth = maxDepth;
    return metadata;
  }

  private calculateHash(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  private getCachedAST(filePath: string, hash: string): ASTCache | null {
    const key = `${filePath}:${hash}`;
    const cached = this.cache.get(key);
    
    if (!cached) {
      telemetry.emit({
        type: 'cache_miss',
        source: { analyzer: 'ast-optimizer', file: filePath },
        data: { fileHash: hash, cacheSize: this.cache.size }
      });
      return null;
    }

    // Check if cache is still fresh
    if (Date.now() - cached.timestamp > this.maxCacheAge) {
      this.cache.delete(key);
      return null;
    }

    return cached;
  }

  private cacheAST(
    filePath: string, 
    hash: string, 
    ast: any, 
    metadata: ASTMetadata
  ): void {
    // Enforce cache size limit
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

  private evictOldestCacheEntries(): void {
    const entries = Array.from(this.cache.entries());
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
    
    // Remove oldest 20% of entries
    const toRemove = Math.floor(entries.length * 0.2);
    for (let i = 0; i < toRemove; i++) {
      this.cache.delete(entries[i][0]);
    }
  }

  private startCacheCleanup(): void {
    setInterval(() => {
      const now = Date.now();
      for (const [key, cached] of this.cache.entries()) {
        if (now - cached.timestamp > this.maxCacheAge) {
          this.cache.delete(key);
        }
      }
    }, 300000); // Clean up every 5 minutes
  }

  private updateParsingStats(filePath: string, stats: ParsingStats): void {
    this.parsingStats.set(filePath, stats);
  }

  private getNodeDepth(path: NodePath): number {
    let depth = 0;
    let current = path;
    while (current.parent) {
      depth++;
      current = current.parentPath!;
    }
    return depth;
  }

  private isStructuralNode(nodeType: string): boolean {
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

  private estimateParsingTime(contentLength: number): number {
    // Rough estimate: 1ms per 1KB of content
    return contentLength / 1000;
  }

  private estimateFullParseTime(contentLength: number): number {
    return this.estimateParsingTime(contentLength) * 1.5;
  }

  private estimateParallelSpeedup(ast: any): number {
    const nodeCount = this.countNodes(ast);
    // Estimate 30% speedup for large ASTs
    return nodeCount > 1000 ? nodeCount * 0.0003 : 0;
  }

  private groupFilesBySize(files: string[]): string[][] {
    // Group files by size categories for optimal batch processing
    const groups: { small: string[]; medium: string[]; large: string[] } = {
      small: [],
      medium: [],
      large: []
    };

    for (const file of files) {
      try {
        const stats = fs.statSync(file);
        if (stats.size < 10000) {
          groups.small.push(file);
        } else if (stats.size < 100000) {
          groups.medium.push(file);
        } else {
          groups.large.push(file);
        }
      } catch (error) {
        groups.small.push(file);
      }
    }

    return [groups.small, groups.medium, groups.large];
  }

  private createBatches<T>(items: T[], batchSize: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }
    return batches;
  }

  private canUseIncrementalParsing(changes: FileChange[]): boolean {
    // Only use incremental parsing for small, localized changes
    return changes.length <= 5 && 
           changes.every(c => c.type === 'modify' && c.range.end - c.range.start < 1000);
  }

  private async applyIncrementalChanges(
    cachedAST: any,
    changes: FileChange[],
    newContent: string
  ): Promise<any | null> {
    // Simplified incremental parsing - in reality this would be much more complex
    try {
      // For now, just return null to force full re-parsing
      // A real implementation would apply changes to the cached AST
      return null;
    } catch (error) {
      return null;
    }
  }

  private serializeVisitor(visitor: Visitor): string {
    // Convert visitor to serializable format for worker processes
    const serialized: Record<string, string> = {};
    for (const [nodeType, method] of Object.entries(visitor)) {
      if (typeof method === 'function') {
        serialized[nodeType] = method.toString();
      }
    }
    return JSON.stringify(serialized);
  }

  public getOptimizationStatistics(): {
    cacheHitRate: number;
    averageParsingTime: number;
    memoryUsage: number;
    optimizationsSaved: number;
  } {
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

  private calculateCacheHitRate(): number {
    // This would be tracked in real implementation
    return 0.75; // Placeholder
  }
}

interface ParsingStats {
  parseTime: number;
  memoryUsed: number;
  nodeCount: number;
  fileSize: number;
}

interface FileChange {
  type: 'add' | 'modify' | 'delete';
  range: { start: number; end: number };
  content?: string;
}

// Simplified worker pool implementation
class WorkerPool {
  private workers: Worker[] = [];
  private available: Worker[] = [];
  private busy: Set<Worker> = new Set();

  constructor(private size: number) {
    // In a real implementation, this would create actual worker threads
  }

  async execute(task: any): Promise<any> {
    // Simplified execution - in reality would use actual worker threads
    return task;
  }
}

// Simplified worker interface
interface Worker {
  id: number;
  busy: boolean;
}
