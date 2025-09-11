/**
 * Dependency Mapper
 * Advanced dependency analysis and relationship mapping
 * Detects direct, transitive, circular dependencies and more
 */

import { ComponentNode, Connection, ConnectionType, CallGraph, CallGraphNode, 
         CallGraphEdge, CallGraphLayer, HotPath, FunctionInfo, FunctionCall } from '../../types';
import { telemetry, TelemetryEvent, DependencyDetectedEvent } from '../../telemetry/telemetry-schema';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as parser from '@babel/parser';
import traverse from '@babel/traverse';
import * as t from '@babel/types';

export interface DependencyGraph {
  nodes: Map<string, DependencyNode>;
  edges: Map<string, DependencyEdge[]>;
  layers: DependencyLayer[];
  cycles: string[][];
  transitiveDepth: Map<string, number>;
  criticalPaths: CriticalPath[];
  clusters: DependencyCluster[];
}

export interface DependencyNode {
  id: string;
  path: string;
  type: 'module' | 'package' | 'class' | 'function' | 'interface';
  imports: ImportInfo[];
  exports: ExportInfo[];
  dependencies: string[];
  dependents: string[];
  depth: number;
  layer: number;
  critical: boolean;
  metrics: DependencyMetrics;
}

export interface DependencyEdge {
  from: string;
  to: string;
  type: ConnectionType;
  weight: number;
  importPath: string;
  isCircular: boolean;
  isTransitive: boolean;
  isDynamic: boolean;
  isConditional: boolean;
  isAsync: boolean;
  metadata: EdgeMetadata;
}

export interface ImportInfo {
  source: string;
  specifiers: ImportSpecifier[];
  type: 'named' | 'default' | 'namespace' | 'side-effect';
  isLazy: boolean;
  isDynamic: boolean;
  location: CodeLocation;
}

export interface ExportInfo {
  name: string;
  type: 'named' | 'default' | 'namespace' | 're-export';
  source?: string;
  isAsync: boolean;
  location: CodeLocation;
}

export interface ImportSpecifier {
  imported: string;
  local: string;
  type: 'named' | 'default' | 'namespace';
}

export interface CodeLocation {
  line: number;
  column: number;
  file: string;
}

export interface DependencyMetrics {
  fanIn: number;  // Number of modules that depend on this
  fanOut: number; // Number of modules this depends on
  coupling: number; // Coupling metric
  cohesion: number; // Cohesion metric
  instability: number; // I = fanOut / (fanIn + fanOut)
  abstractness: number; // Ratio of abstract types
  distance: number; // Distance from main sequence
}

export interface DependencyLayer {
  level: number;
  name: string;
  nodes: string[];
  description: string;
  metrics: LayerMetrics;
}

export interface LayerMetrics {
  nodeCount: number;
  edgeCount: number;
  averageFanIn: number;
  averageFanOut: number;
  cohesion: number;
  coupling: number;
}

export interface CriticalPath {
  path: string[];
  weight: number;
  type: 'import' | 'runtime' | 'build';
  bottlenecks: string[];
  optimizations: string[];
}

export interface DependencyCluster {
  id: string;
  nodes: string[];
  type: 'feature' | 'layer' | 'component' | 'utility';
  cohesion: number;
  coupling: number;
  description: string;
}

export interface EdgeMetadata {
  usageCount: number;
  callSites: CallSite[];
  dataFlow: DataFlowInfo[];
  sideEffects: SideEffect[];
}

export interface CallSite {
  function: string;
  line: number;
  column: number;
  type: 'direct' | 'indirect' | 'dynamic';
}

export interface DataFlowInfo {
  variable: string;
  type: string;
  direction: 'in' | 'out' | 'inout';
  transforms: string[];
}

export interface SideEffect {
  type: 'mutation' | 'io' | 'network' | 'global';
  target: string;
  description: string;
}

export class DependencyMapper {
  private graph: DependencyGraph;
  private componentMap: Map<string, ComponentNode> = new Map();
  private fileContentCache: Map<string, string> = new Map();
  private astCache: Map<string, any> = new Map();
  private projectPath: string = '';

  constructor() {
    this.graph = {
      nodes: new Map(),
      edges: new Map(),
      layers: [],
      cycles: [],
      transitiveDepth: new Map(),
      criticalPaths: [],
      clusters: []
    };
  }

  public async mapDependencies(
    components: ComponentNode[],
    projectPath: string
  ): Promise<DependencyGraph> {
    const span = telemetry.createSpan('mapDependencies');
    this.projectPath = projectPath;

    // Build component map
    for (const component of components) {
      this.componentMap.set(component.path, component);
    }

    // Phase 1: Parse all files and build initial dependency nodes
    await this.buildDependencyNodes(components);

    // Phase 2: Analyze dependencies and build edges
    await this.analyzeDependencies();

    // Phase 3: Calculate layers using topological sort
    this.calculateLayers();

    // Phase 4: Detect circular dependencies
    this.detectCycles();

    // Phase 5: Calculate transitive dependencies
    this.calculateTransitiveDependencies();

    // Phase 6: Identify critical paths
    this.identifyCriticalPaths();

    // Phase 7: Cluster analysis
    this.performClusterAnalysis();

    // Phase 8: Calculate metrics
    this.calculateMetrics();

    // Emit telemetry
    telemetry.emit({
      type: 'dependency_detected',
      source: { analyzer: 'dependency-mapper' },
      data: {
        nodeCount: this.graph.nodes.size,
        edgeCount: Array.from(this.graph.edges.values()).flat().length,
        cycleCount: this.graph.cycles.length,
        layerCount: this.graph.layers.length,
        criticalPathCount: this.graph.criticalPaths.length
      }
    });

    span.end();
    return this.graph;
  }

  private async buildDependencyNodes(components: ComponentNode[]): Promise<void> {
    for (const component of components) {
      try {
        const fullPath = path.join(this.projectPath, component.path);
        const content = await this.readFileContent(fullPath);
        const ast = await this.parseFile(content, component.path);

        const imports = this.extractImports(ast, component.path);
        const exports = this.extractExports(ast, component.path);

        const node: DependencyNode = {
          id: component.id,
          path: component.path,
          type: this.determineNodeType(ast),
          imports,
          exports,
          dependencies: [],
          dependents: [],
          depth: 0,
          layer: 0,
          critical: false,
          metrics: this.initializeMetrics()
        };

        this.graph.nodes.set(component.id, node);
      } catch (error) {
        telemetry.emit({
          type: 'error_occurred',
          source: { 
            analyzer: 'dependency-mapper',
            component: component.path 
          },
          data: {
            error: error instanceof Error ? error.message : String(error),
            component: component.path
          }
        });
      }
    }
  }

  private async analyzeDependencies(): Promise<void> {
    for (const [nodeId, node] of this.graph.nodes) {
      const edges: DependencyEdge[] = [];

      for (const importInfo of node.imports) {
        const targetPath = this.resolveImportPath(importInfo.source, node.path);
        const targetNode = this.findNodeByPath(targetPath);

        if (targetNode) {
          const edge: DependencyEdge = {
            from: nodeId,
            to: targetNode.id,
            type: this.determineConnectionType(importInfo),
            weight: this.calculateEdgeWeight(importInfo),
            importPath: importInfo.source,
            isCircular: false,
            isTransitive: false,
            isDynamic: importInfo.isDynamic,
            isConditional: await this.isConditionalImport(node.path, importInfo),
            isAsync: importInfo.isLazy,
            metadata: await this.extractEdgeMetadata(node.path, importInfo)
          };

          edges.push(edge);
          node.dependencies.push(targetNode.id);
          targetNode.dependents.push(nodeId);
        }
      }

      this.graph.edges.set(nodeId, edges);
    }
  }

  private calculateLayers(): void {
    const visited = new Set<string>();
    const layers: Map<number, string[]> = new Map();
    let maxLayer = 0;

    // Find nodes with no dependencies (layer 0)
    const queue: string[] = [];
    for (const [nodeId, node] of this.graph.nodes) {
      if (node.dependencies.length === 0) {
        queue.push(nodeId);
        node.layer = 0;
        if (!layers.has(0)) layers.set(0, []);
        layers.get(0)!.push(nodeId);
      }
    }

    // BFS to assign layers
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      if (visited.has(currentId)) continue;
      visited.add(currentId);

      const currentNode = this.graph.nodes.get(currentId)!;
      
      for (const dependentId of currentNode.dependents) {
        const dependentNode = this.graph.nodes.get(dependentId)!;
        const newLayer = currentNode.layer + 1;
        
        if (newLayer > dependentNode.layer) {
          dependentNode.layer = newLayer;
          maxLayer = Math.max(maxLayer, newLayer);
          
          if (!layers.has(newLayer)) layers.set(newLayer, []);
          layers.get(newLayer)!.push(dependentId);
          
          queue.push(dependentId);
        }
      }
    }

    // Create layer objects
    for (let i = 0; i <= maxLayer; i++) {
      const nodeIds = layers.get(i) || [];
      this.graph.layers.push({
        level: i,
        name: this.getLayerName(i, maxLayer),
        nodes: nodeIds,
        description: this.getLayerDescription(i, maxLayer),
        metrics: this.calculateLayerMetrics(nodeIds)
      });
    }
  }

  private detectCycles(): void {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const cycles: string[][] = [];

    const dfs = (nodeId: string, path: string[] = []): void => {
      visited.add(nodeId);
      recursionStack.add(nodeId);
      path.push(nodeId);

      const edges = this.graph.edges.get(nodeId) || [];
      for (const edge of edges) {
        if (!visited.has(edge.to)) {
          dfs(edge.to, [...path]);
        } else if (recursionStack.has(edge.to)) {
          // Found a cycle
          const cycleStart = path.indexOf(edge.to);
          if (cycleStart !== -1) {
            const cycle = path.slice(cycleStart);
            cycle.push(edge.to); // Complete the cycle
            cycles.push(cycle);
            
            // Mark edges as circular
            edge.isCircular = true;
          }
        }
      }

      recursionStack.delete(nodeId);
    };

    // Run DFS from each unvisited node
    for (const nodeId of this.graph.nodes.keys()) {
      if (!visited.has(nodeId)) {
        dfs(nodeId);
      }
    }

    this.graph.cycles = cycles;

    // Mark nodes in cycles as potentially critical
    for (const cycle of cycles) {
      for (const nodeId of cycle) {
        const node = this.graph.nodes.get(nodeId);
        if (node) {
          node.critical = true;
        }
      }
    }
  }

  private calculateTransitiveDependencies(): void {
    // Floyd-Warshall algorithm to find all transitive dependencies
    const nodes = Array.from(this.graph.nodes.keys());
    const n = nodes.length;
    const dist: number[][] = Array(n).fill(null).map(() => Array(n).fill(Infinity));
    const nodeIndex = new Map(nodes.map((id, i) => [id, i]));

    // Initialize direct dependencies
    for (let i = 0; i < n; i++) {
      dist[i][i] = 0;
    }

    for (const [fromId, edges] of this.graph.edges) {
      const fromIdx = nodeIndex.get(fromId)!;
      for (const edge of edges) {
        const toIdx = nodeIndex.get(edge.to)!;
        dist[fromIdx][toIdx] = 1;
      }
    }

    // Calculate transitive closure
    for (let k = 0; k < n; k++) {
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          if (dist[i][k] + dist[k][j] < dist[i][j]) {
            dist[i][j] = dist[i][k] + dist[k][j];
          }
        }
      }
    }

    // Store transitive depth for each node
    for (let i = 0; i < n; i++) {
      let maxDepth = 0;
      for (let j = 0; j < n; j++) {
        if (i !== j && dist[i][j] !== Infinity) {
          maxDepth = Math.max(maxDepth, dist[i][j]);
        }
      }
      this.graph.transitiveDepth.set(nodes[i], maxDepth);

      // Mark transitive edges
      const nodeId = nodes[i];
      const edges = this.graph.edges.get(nodeId) || [];
      for (const edge of edges) {
        const toIdx = nodeIndex.get(edge.to)!;
        if (dist[i][toIdx] > 1) {
          edge.isTransitive = true;
        }
      }
    }
  }

  private identifyCriticalPaths(): void {
    // Find paths from entry points to critical resources
    const entryNodes = Array.from(this.graph.nodes.values())
      .filter(node => node.dependents.length === 0 || node.critical);

    for (const entryNode of entryNodes) {
      const paths = this.findAllPaths(entryNode.id, null, 5); // Max depth 5
      
      for (const path of paths) {
        const weight = this.calculatePathWeight(path);
        const bottlenecks = this.identifyBottlenecks(path);
        
        if (weight > 0.7 || bottlenecks.length > 0) { // Threshold for critical
          this.graph.criticalPaths.push({
            path,
            weight,
            type: 'import',
            bottlenecks,
            optimizations: this.suggestOptimizations(path, bottlenecks)
          });
        }
      }
    }

    // Sort by weight
    this.graph.criticalPaths.sort((a, b) => b.weight - a.weight);
  }

  private performClusterAnalysis(): void {
    // Identify strongly connected components as clusters
    const clusters = this.findStronglyConnectedComponents();
    
    for (const cluster of clusters) {
      if (cluster.length > 1) {
        const cohesion = this.calculateClusterCohesion(cluster);
        const coupling = this.calculateClusterCoupling(cluster);
        
        this.graph.clusters.push({
          id: `cluster_${this.graph.clusters.length}`,
          nodes: cluster,
          type: this.determineClusterType(cluster),
          cohesion,
          coupling,
          description: this.describeCluster(cluster)
        });
      }
    }
  }

  private calculateMetrics(): void {
    for (const [nodeId, node] of this.graph.nodes) {
      const fanIn = node.dependents.length;
      const fanOut = node.dependencies.length;
      const instability = fanOut > 0 || fanIn > 0 ? fanOut / (fanIn + fanOut) : 0;
      
      node.metrics = {
        fanIn,
        fanOut,
        coupling: this.calculateCoupling(nodeId),
        cohesion: this.calculateCohesion(nodeId),
        instability,
        abstractness: this.calculateAbstractness(node),
        distance: Math.abs(instability + this.calculateAbstractness(node) - 1)
      };
    }
  }

  // Helper methods

  private async readFileContent(filePath: string): Promise<string> {
    if (this.fileContentCache.has(filePath)) {
      return this.fileContentCache.get(filePath)!;
    }
    const content = await fs.readFile(filePath, 'utf-8');
    this.fileContentCache.set(filePath, content);
    return content;
  }

  private async parseFile(content: string, filePath: string): Promise<any> {
    if (this.astCache.has(filePath)) {
      return this.astCache.get(filePath);
    }

    try {
      const ast = parser.parse(content, {
        sourceType: 'module',
        plugins: [
          'typescript',
          'jsx',
          'decorators-legacy',
          'classProperties',
          'asyncGenerators',
          'dynamicImport',
          'optionalChaining',
          'nullishCoalescingOperator'
        ],
        errorRecovery: true
      });
      
      this.astCache.set(filePath, ast);
      return ast;
    } catch (error) {
      // Fallback for non-JS/TS files
      return null;
    }
  }

  private extractImports(ast: any, filePath: string): ImportInfo[] {
    const imports: ImportInfo[] = [];
    
    if (!ast) return imports;

    traverse(ast, {
      ImportDeclaration(path) {
        const source = path.node.source.value;
        const specifiers: ImportSpecifier[] = [];
        
        path.node.specifiers.forEach((spec: any) => {
          if (t.isImportDefaultSpecifier(spec)) {
            specifiers.push({
              imported: 'default',
              local: spec.local.name,
              type: 'default'
            });
          } else if (t.isImportNamespaceSpecifier(spec)) {
            specifiers.push({
              imported: '*',
              local: spec.local.name,
              type: 'namespace'
            });
          } else if (t.isImportSpecifier(spec)) {
            specifiers.push({
              imported: spec.imported.name,
              local: spec.local.name,
              type: 'named'
            });
          }
        });

        imports.push({
          source,
          specifiers,
          type: specifiers.length === 0 ? 'side-effect' : 
                specifiers[0].type === 'default' ? 'default' : 
                specifiers[0].type === 'namespace' ? 'namespace' : 'named',
          isLazy: false,
          isDynamic: false,
          location: {
            line: path.node.loc?.start.line || 0,
            column: path.node.loc?.start.column || 0,
            file: filePath
          }
        });
      },
      
      CallExpression(path) {
        // Detect dynamic imports
        if (t.isImport(path.node.callee) && path.node.arguments.length > 0) {
          const arg = path.node.arguments[0];
          if (t.isStringLiteral(arg)) {
            imports.push({
              source: arg.value,
              specifiers: [],
              type: 'namespace',
              isLazy: true,
              isDynamic: true,
              location: {
                line: path.node.loc?.start.line || 0,
                column: path.node.loc?.start.column || 0,
                file: filePath
              }
            });
          }
        }
        
        // Detect require() calls
        if (t.isIdentifier(path.node.callee, { name: 'require' }) && 
            path.node.arguments.length > 0) {
          const arg = path.node.arguments[0];
          if (t.isStringLiteral(arg)) {
            imports.push({
              source: arg.value,
              specifiers: [],
              type: 'namespace',
              isLazy: false,
              isDynamic: false,
              location: {
                line: path.node.loc?.start.line || 0,
                column: path.node.loc?.start.column || 0,
                file: filePath
              }
            });
          }
        }
      }
    });

    return imports;
  }

  private extractExports(ast: any, filePath: string): ExportInfo[] {
    const exports: ExportInfo[] = [];
    
    if (!ast) return exports;

    traverse(ast, {
      ExportNamedDeclaration(path) {
        if (path.node.declaration) {
          // export const/let/function/class
          if (t.isFunctionDeclaration(path.node.declaration) || 
              t.isClassDeclaration(path.node.declaration)) {
            exports.push({
              name: path.node.declaration.id?.name || 'anonymous',
              type: 'named',
              isAsync: t.isFunctionDeclaration(path.node.declaration) && 
                       path.node.declaration.async || false,
              location: {
                line: path.node.loc?.start.line || 0,
                column: path.node.loc?.start.column || 0,
                file: filePath
              }
            });
          } else if (t.isVariableDeclaration(path.node.declaration)) {
            path.node.declaration.declarations.forEach((decl: any) => {
              if (t.isIdentifier(decl.id)) {
                exports.push({
                  name: decl.id.name,
                  type: 'named',
                  isAsync: false,
                  location: {
                    line: path.node.loc?.start.line || 0,
                    column: path.node.loc?.start.column || 0,
                    file: filePath
                  }
                });
              }
            });
          }
        } else if (path.node.specifiers) {
          // export { ... }
          path.node.specifiers.forEach((spec: any) => {
            exports.push({
              name: spec.exported.name,
              type: 'named',
              source: path.node.source?.value,
              isAsync: false,
              location: {
                line: path.node.loc?.start.line || 0,
                column: path.node.loc?.start.column || 0,
                file: filePath
              }
            });
          });
        }
      },
      
      ExportDefaultDeclaration(path) {
        exports.push({
          name: 'default',
          type: 'default',
          isAsync: t.isFunctionDeclaration(path.node.declaration) && 
                   path.node.declaration.async || false,
          location: {
            line: path.node.loc?.start.line || 0,
            column: path.node.loc?.start.column || 0,
            file: filePath
          }
        });
      },
      
      ExportAllDeclaration(path) {
        exports.push({
          name: '*',
          type: 're-export',
          source: path.node.source.value,
          isAsync: false,
          location: {
            line: path.node.loc?.start.line || 0,
            column: path.node.loc?.start.column || 0,
            file: filePath
          }
        });
      }
    });

    return exports;
  }

  private determineNodeType(ast: any): DependencyNode['type'] {
    if (!ast) return 'module';
    
    let hasClass = false;
    let hasFunction = false;
    let hasInterface = false;
    
    traverse(ast, {
      ClassDeclaration() { hasClass = true; },
      FunctionDeclaration() { hasFunction = true; },
      TSInterfaceDeclaration() { hasInterface = true; }
    });
    
    if (hasInterface) return 'interface';
    if (hasClass) return 'class';
    if (hasFunction) return 'function';
    return 'module';
  }

  private resolveImportPath(importPath: string, currentFile: string): string | null {
    // Handle relative imports
    if (importPath.startsWith('.')) {
      const currentDir = path.dirname(currentFile);
      const resolved = path.join(currentDir, importPath);
      
      // Try with various extensions
      const extensions = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js'];
      for (const ext of extensions) {
        const testPath = resolved.includes('.') ? resolved : resolved + ext;
        const normalizedPath = path.normalize(testPath).replace(/\\/g, '/');
        
        // Check if this path exists in our component map
        for (const [componentPath] of this.componentMap) {
          if (componentPath === normalizedPath || 
              componentPath.startsWith(normalizedPath.replace(/\.[^.]+$/, ''))) {
            return componentPath;
          }
        }
      }
    }
    
    // Handle absolute imports
    if (!importPath.startsWith('.') && !importPath.includes('node_modules')) {
      // Check common source directories
      const sourceDirs = ['src/', 'lib/', 'app/', ''];
      for (const dir of sourceDirs) {
        const testPath = path.join(dir, importPath);
        for (const [componentPath] of this.componentMap) {
          if (componentPath.startsWith(testPath)) {
            return componentPath;
          }
        }
      }
    }
    
    return null;
  }

  private findNodeByPath(filePath: string | null): DependencyNode | null {
    if (!filePath) return null;
    
    for (const node of this.graph.nodes.values()) {
      if (node.path === filePath) {
        return node;
      }
    }
    return null;
  }

  private determineConnectionType(importInfo: ImportInfo): ConnectionType {
    if (importInfo.isDynamic) return 'function_call';
    if (importInfo.type === 'side-effect') return 'data_flow';
    return 'import';
  }

  private calculateEdgeWeight(importInfo: ImportInfo): number {
    let weight = 1;
    
    // Increase weight for various factors
    if (importInfo.type === 'namespace') weight += 2;
    if (importInfo.isDynamic) weight += 1;
    if (importInfo.specifiers.length > 3) weight += 1;
    
    return Math.min(weight, 5);
  }

  private async isConditionalImport(filePath: string, importInfo: ImportInfo): Promise<boolean> {
    try {
      const fullPath = path.join(this.projectPath, filePath);
      const content = await this.readFileContent(fullPath);
      
      // Check if import is inside a conditional block
      const lines = content.split('\n');
      const importLine = lines[importInfo.location.line - 1];
      
      // Look for conditional patterns before the import
      const beforeLines = lines.slice(Math.max(0, importInfo.location.line - 5), importInfo.location.line);
      const beforeText = beforeLines.join('\n');
      
      return beforeText.includes('if') || 
             beforeText.includes('switch') || 
             beforeText.includes('? ') ||
             importInfo.isDynamic;
    } catch {
      return false;
    }
  }

  private async extractEdgeMetadata(filePath: string, importInfo: ImportInfo): Promise<EdgeMetadata> {
    const callSites: CallSite[] = [];
    const dataFlow: DataFlowInfo[] = [];
    const sideEffects: SideEffect[] = [];
    
    try {
      const fullPath = path.join(this.projectPath, filePath);
      const content = await this.readFileContent(fullPath);
      const ast = await this.parseFile(content, filePath);
      
      if (ast) {
        // Find usage of imported symbols
        for (const spec of importInfo.specifiers) {
          const usage = this.findSymbolUsage(ast, spec.local);
          callSites.push(...usage.callSites);
          dataFlow.push(...usage.dataFlow);
          sideEffects.push(...usage.sideEffects);
        }
      }
    } catch (error) {
      // Ignore errors in metadata extraction
    }
    
    return {
      usageCount: callSites.length,
      callSites,
      dataFlow,
      sideEffects
    };
  }

  private findSymbolUsage(ast: any, symbol: string): {
    callSites: CallSite[];
    dataFlow: DataFlowInfo[];
    sideEffects: SideEffect[];
  } {
    const callSites: CallSite[] = [];
    const dataFlow: DataFlowInfo[] = [];
    const sideEffects: SideEffect[] = [];
    
    traverse(ast, {
      CallExpression(path) {
        if (t.isIdentifier(path.node.callee, { name: symbol }) ||
            (t.isMemberExpression(path.node.callee) && 
             t.isIdentifier(path.node.callee.object, { name: symbol }))) {
          callSites.push({
            function: symbol,
            line: path.node.loc?.start.line || 0,
            column: path.node.loc?.start.column || 0,
            type: 'direct'
          });
        }
      },
      
      VariableDeclarator(path) {
        if (t.isIdentifier(path.node.init, { name: symbol })) {
          dataFlow.push({
            variable: t.isIdentifier(path.node.id) ? path.node.id.name : 'unknown',
            type: 'assignment',
            direction: 'out',
            transforms: []
          });
        }
      },
      
      AssignmentExpression(path) {
        if (t.isIdentifier(path.node.right, { name: symbol })) {
          dataFlow.push({
            variable: path.node.left.toString(),
            type: 'assignment',
            direction: 'out',
            transforms: []
          });
        }
      }
    });
    
    return { callSites, dataFlow, sideEffects };
  }

  private initializeMetrics(): DependencyMetrics {
    return {
      fanIn: 0,
      fanOut: 0,
      coupling: 0,
      cohesion: 0,
      instability: 0,
      abstractness: 0,
      distance: 0
    };
  }

  private getLayerName(level: number, maxLevel: number): string {
    if (level === 0) return 'Foundation';
    if (level === maxLevel) return 'Application';
    if (level <= maxLevel / 3) return 'Infrastructure';
    if (level <= 2 * maxLevel / 3) return 'Domain';
    return 'Presentation';
  }

  private getLayerDescription(level: number, maxLevel: number): string {
    if (level === 0) return 'Core utilities and libraries with no dependencies';
    if (level === maxLevel) return 'Top-level application components';
    if (level <= maxLevel / 3) return 'Infrastructure and framework components';
    if (level <= 2 * maxLevel / 3) return 'Business logic and domain models';
    return 'User interface and API components';
  }

  private calculateLayerMetrics(nodeIds: string[]): LayerMetrics {
    let totalFanIn = 0;
    let totalFanOut = 0;
    let edgeCount = 0;
    
    for (const nodeId of nodeIds) {
      const node = this.graph.nodes.get(nodeId);
      if (node) {
        totalFanIn += node.metrics.fanIn;
        totalFanOut += node.metrics.fanOut;
      }
      const edges = this.graph.edges.get(nodeId) || [];
      edgeCount += edges.length;
    }
    
    return {
      nodeCount: nodeIds.length,
      edgeCount,
      averageFanIn: nodeIds.length > 0 ? totalFanIn / nodeIds.length : 0,
      averageFanOut: nodeIds.length > 0 ? totalFanOut / nodeIds.length : 0,
      cohesion: this.calculateLayerCohesion(nodeIds),
      coupling: this.calculateLayerCoupling(nodeIds)
    };
  }

  private calculateLayerCohesion(nodeIds: string[]): number {
    // Calculate how well nodes in this layer work together
    let internalEdges = 0;
    let totalEdges = 0;
    
    for (const nodeId of nodeIds) {
      const edges = this.graph.edges.get(nodeId) || [];
      for (const edge of edges) {
        totalEdges++;
        if (nodeIds.includes(edge.to)) {
          internalEdges++;
        }
      }
    }
    
    return totalEdges > 0 ? internalEdges / totalEdges : 0;
  }

  private calculateLayerCoupling(nodeIds: string[]): number {
    // Calculate how much this layer depends on others
    let externalEdges = 0;
    let totalEdges = 0;
    
    for (const nodeId of nodeIds) {
      const edges = this.graph.edges.get(nodeId) || [];
      for (const edge of edges) {
        totalEdges++;
        if (!nodeIds.includes(edge.to)) {
          externalEdges++;
        }
      }
    }
    
    return totalEdges > 0 ? externalEdges / totalEdges : 0;
  }

  private findAllPaths(
    startId: string, 
    endId: string | null, 
    maxDepth: number
  ): string[][] {
    const paths: string[][] = [];
    const visited = new Set<string>();
    
    const dfs = (currentId: string, path: string[], depth: number): void => {
      if (depth > maxDepth) return;
      if (visited.has(currentId)) return;
      
      path.push(currentId);
      visited.add(currentId);
      
      if (endId === null || currentId === endId) {
        paths.push([...path]);
      } else {
        const edges = this.graph.edges.get(currentId) || [];
        for (const edge of edges) {
          dfs(edge.to, path, depth + 1);
        }
      }
      
      path.pop();
      visited.delete(currentId);
    };
    
    dfs(startId, [], 0);
    return paths;
  }

  private calculatePathWeight(path: string[]): number {
    let weight = 0;
    
    for (let i = 0; i < path.length - 1; i++) {
      const edges = this.graph.edges.get(path[i]) || [];
      const edge = edges.find(e => e.to === path[i + 1]);
      if (edge) {
        weight += edge.weight;
      }
    }
    
    return weight / (path.length - 1);
  }

  private identifyBottlenecks(path: string[]): string[] {
    const bottlenecks: string[] = [];
    
    for (const nodeId of path) {
      const node = this.graph.nodes.get(nodeId);
      if (node) {
        // High fan-in indicates potential bottleneck
        if (node.metrics.fanIn > 5) {
          bottlenecks.push(nodeId);
        }
        // High coupling also indicates bottleneck
        if (node.metrics.coupling > 0.7) {
          bottlenecks.push(nodeId);
        }
      }
    }
    
    return [...new Set(bottlenecks)];
  }

  private suggestOptimizations(path: string[], bottlenecks: string[]): string[] {
    const optimizations: string[] = [];
    
    for (const bottleneck of bottlenecks) {
      const node = this.graph.nodes.get(bottleneck);
      if (node) {
        if (node.metrics.fanIn > 5) {
          optimizations.push(`Consider splitting ${node.path} into smaller modules`);
        }
        if (node.metrics.coupling > 0.7) {
          optimizations.push(`Reduce coupling in ${node.path} by using dependency injection`);
        }
        if (node.imports.some(i => i.isDynamic)) {
          optimizations.push(`Consider static imports in ${node.path} for better tree-shaking`);
        }
      }
    }
    
    return optimizations;
  }

  private findStronglyConnectedComponents(): string[][] {
    const components: string[][] = [];
    const visited = new Set<string>();
    const stack: string[] = [];
    const lowlinks = new Map<string, number>();
    const indices = new Map<string, number>();
    const onStack = new Set<string>();
    let index = 0;
    
    const strongconnect = (v: string): void => {
      indices.set(v, index);
      lowlinks.set(v, index);
      index++;
      stack.push(v);
      onStack.add(v);
      
      const edges = this.graph.edges.get(v) || [];
      for (const edge of edges) {
        const w = edge.to;
        if (!indices.has(w)) {
          strongconnect(w);
          lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
        } else if (onStack.has(w)) {
          lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
        }
      }
      
      if (lowlinks.get(v) === indices.get(v)) {
        const component: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          component.push(w);
        } while (w !== v);
        components.push(component);
      }
    };
    
    for (const nodeId of this.graph.nodes.keys()) {
      if (!indices.has(nodeId)) {
        strongconnect(nodeId);
      }
    }
    
    return components;
  }

  private calculateClusterCohesion(nodeIds: string[]): number {
    return this.calculateLayerCohesion(nodeIds);
  }

  private calculateClusterCoupling(nodeIds: string[]): number {
    return this.calculateLayerCoupling(nodeIds);
  }

  private determineClusterType(nodeIds: string[]): DependencyCluster['type'] {
    const nodes = nodeIds.map(id => this.graph.nodes.get(id)!).filter(n => n);
    
    // Check if all nodes are in the same directory
    const directories = new Set(nodes.map(n => path.dirname(n.path)));
    if (directories.size === 1) {
      const dir = Array.from(directories)[0];
      if (dir.includes('component')) return 'component';
      if (dir.includes('feature')) return 'feature';
      if (dir.includes('util') || dir.includes('helper')) return 'utility';
    }
    
    // Check node types
    const types = new Set(nodes.map(n => n.type));
    if (types.size === 1 && types.has('interface')) return 'component';
    
    return 'feature';
  }

  private describeCluster(nodeIds: string[]): string {
    const nodes = nodeIds.map(id => this.graph.nodes.get(id)!).filter(n => n);
    const directories = new Set(nodes.map(n => path.dirname(n.path)));
    const types = new Set(nodes.map(n => n.type));
    
    return `Cluster of ${nodes.length} ${Array.from(types).join('/')} modules in ${directories.size} directories`;
  }

  private calculateCoupling(nodeId: string): number {
    const node = this.graph.nodes.get(nodeId);
    if (!node) return 0;
    
    const edges = this.graph.edges.get(nodeId) || [];
    const uniqueTargets = new Set(edges.map(e => e.to));
    
    return uniqueTargets.size / Math.max(1, this.graph.nodes.size - 1);
  }

  private calculateCohesion(nodeId: string): number {
    const node = this.graph.nodes.get(nodeId);
    if (!node) return 0;
    
    // Calculate based on how well the exports match imports
    const exportNames = new Set(node.exports.map(e => e.name));
    let usedExports = 0;
    
    for (const dependentId of node.dependents) {
      const dependent = this.graph.nodes.get(dependentId);
      if (dependent) {
        for (const imp of dependent.imports) {
          if (imp.specifiers.some(s => exportNames.has(s.imported))) {
            usedExports++;
          }
        }
      }
    }
    
    return exportNames.size > 0 ? usedExports / exportNames.size : 0;
  }

  private calculateAbstractness(node: DependencyNode): number {
    // Ratio of abstract elements (interfaces, abstract classes) to total
    if (node.type === 'interface') return 1;
    
    // Check exports for abstract patterns
    const abstractExports = node.exports.filter(e => 
      e.name.startsWith('I') || // Interface naming convention
      e.name.includes('Abstract') ||
      e.name.includes('Base')
    );
    
    return node.exports.length > 0 ? abstractExports.length / node.exports.length : 0;
  }

  public generateCallGraph(components: ComponentNode[]): CallGraph {
    const nodes: CallGraphNode[] = [];
    const edges: CallGraphEdge[] = [];
    
    // Convert dependency nodes to call graph nodes
    for (const [nodeId, depNode] of this.graph.nodes) {
      const component = components.find(c => c.id === nodeId);
      if (component) {
        nodes.push({
          id: nodeId,
          name: component.name,
          type: 'module',
          file: component.path,
          complexity: component.metadata.complexity,
          fanIn: depNode.metrics.fanIn,
          fanOut: depNode.metrics.fanOut,
          depth: depNode.depth,
          critical: depNode.critical
        });
      }
    }
    
    // Convert dependency edges to call graph edges
    for (const [fromId, depEdges] of this.graph.edges) {
      for (const depEdge of depEdges) {
        edges.push({
          from: fromId,
          to: depEdge.to,
          count: depEdge.weight,
          type: depEdge.isTransitive ? 'indirect' : 'direct',
          async: depEdge.isAsync,
          conditional: depEdge.isConditional
        });
      }
    }
    
    // Convert layers
    const layers: CallGraphLayer[] = this.graph.layers.map(layer => ({
      level: layer.level,
      nodes: layer.nodes,
      description: layer.description
    }));
    
    // Convert critical paths to hot paths
    const hotPaths: HotPath[] = this.graph.criticalPaths.map(cp => ({
      path: cp.path,
      frequency: cp.weight,
      critical: true,
      description: `Critical path with ${cp.bottlenecks.length} bottlenecks`
    }));
    
    // Identify dead code
    const deadCode = Array.from(this.graph.nodes.entries())
      .filter(([_, node]) => node.dependents.length === 0 && node.dependencies.length === 0)
      .map(([id]) => id);
    
    return {
      nodes,
      edges,
      entryPoints: nodes.filter(n => n.fanIn === 0).map(n => n.id),
      cycles: this.graph.cycles,
      layers,
      hotPaths,
      deadCode
    };
  }
}
