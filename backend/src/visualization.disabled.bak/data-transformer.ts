import { 
  ArchitectureBlueprint, 
  ComponentNode, 
  Connection,
  EntryPoint,
  ExitPoint,
  RiskArea,
  APIEndpoint
} from '../types';
import { VisualizationOptions } from './visualization-engine';

export interface TransformedData {
  nodes: TransformedNode[];
  edges: TransformedEdge[];
  metadata: TransformMetadata;
}

export interface TransformedNode {
  id: string;
  name: string;
  type: string;
  path: string;
  dependencies: string[];
  dependents: string[];
  metadata: Record<string, any>;
  framework?: string;
  language?: string;
  metrics?: Record<string, any>;
  risk?: RiskInfo;
  apis?: APIInfo[];
  cluster?: string;
  importance?: number;
  visibility?: 'visible' | 'hidden' | 'dimmed';
}

export interface TransformedEdge {
  from: string;
  to: string;
  type: string;
  weight?: number;
  metadata?: Record<string, any>;
  critical?: boolean;
  visibility?: 'visible' | 'hidden' | 'dimmed';
}

export interface TransformMetadata {
  totalNodes: number;
  totalEdges: number;
  transformations: string[];
  filters: string[];
  aggregations: Record<string, any>;
  statistics: TransformStatistics;
}

export interface TransformStatistics {
  avgComplexity: number;
  avgDependencies: number;
  maxComplexity: number;
  maxDependencies: number;
  orphanedRatio: number;
  testCoverageAvg: number;
  riskDistribution: Record<string, number>;
}

export interface RiskInfo {
  level: string;
  reasons: string[];
  score: number;
}

export interface APIInfo {
  method: string;
  path: string;
  authenticated: boolean;
}

export class DataTransformer {
  private transformCache: Map<string, TransformedData>;
  private aggregationCache: Map<string, any>;

  constructor() {
    this.transformCache = new Map();
    this.aggregationCache = new Map();
  }

  transform(
    blueprint: ArchitectureBlueprint,
    options: VisualizationOptions
  ): TransformedData {
    // Start with base transformation
    let data = this.baseTransform(blueprint);

    // Apply transformations based on options
    const transformations: string[] = [];

    // Performance mode transformations
    if (options.performanceMode) {
      data = this.applyPerformanceOptimizations(data);
      transformations.push('performance-optimization');
    }

    // Node limit transformations
    if (options.maxNodes && data.nodes.length > options.maxNodes) {
      data = this.limitNodes(data, options.maxNodes);
      transformations.push(`node-limit-${options.maxNodes}`);
    }

    // Risk highlighting
    data = this.highlightRisks(data, blueprint.riskAreas);
    transformations.push('risk-highlighting');

    // API endpoint enrichment
    data = this.enrichWithAPIEndpoints(data, blueprint.apiEndpoints);
    transformations.push('api-enrichment');

    // Entry/Exit point marking
    data = this.markEntryExitPoints(data, blueprint.entryPoints, blueprint.exitPoints);
    transformations.push('entry-exit-marking');

    // Calculate importance scores
    data = this.calculateImportance(data);
    transformations.push('importance-calculation');

    // Apply clustering preparation if needed
    if (options.clustering) {
      data = this.prepareForClustering(data);
      transformations.push('clustering-preparation');
    }

    // Calculate metadata
    const metadata = this.calculateMetadata(data, transformations, options);

    return {
      nodes: data.nodes,
      edges: data.edges,
      metadata
    };
  }

  private baseTransform(blueprint: ArchitectureBlueprint): TransformedData {
    const nodes: TransformedNode[] = blueprint.components.map(component => ({
      id: component.id,
      name: component.name,
      type: component.type,
      path: component.path,
      dependencies: component.dependencies,
      dependents: component.dependents,
      metadata: {
        ...component.metadata,
        metrics: component.metrics
      },
      framework: component.framework,
      language: component.language,
      metrics: component.metrics,
      visibility: 'visible'
    }));

    const edges: TransformedEdge[] = blueprint.connections.map(connection => ({
      from: connection.from,
      to: connection.to,
      type: connection.type,
      weight: connection.weight,
      metadata: connection.metadata,
      visibility: 'visible'
    }));

    return { nodes, edges, metadata: {} as TransformMetadata };
  }

  private applyPerformanceOptimizations(
    data: TransformedData
  ): TransformedData {
    // Merge parallel edges
    const edgeMap = new Map<string, TransformedEdge>();
    
    data.edges.forEach(edge => {
      const key = `${edge.from}-${edge.to}`;
      if (edgeMap.has(key)) {
        const existing = edgeMap.get(key)!;
        existing.weight = (existing.weight || 1) + (edge.weight || 1);
        if (edge.metadata) {
          existing.metadata = {
            ...existing.metadata,
            ...edge.metadata,
            merged: true,
            mergeCount: ((existing.metadata?.mergeCount as number) || 1) + 1
          };
        }
      } else {
        edgeMap.set(key, { ...edge });
      }
    });

    // Simplify node metadata for performance
    const simplifiedNodes = data.nodes.map(node => ({
      ...node,
      metadata: {
        complexity: node.metadata.complexity,
        lineCount: node.metadata.lineCount,
        layer: node.metadata.layer,
        isEntry: node.metadata.isEntry,
        isOrphaned: node.metadata.isOrphaned
      }
    }));

    return {
      nodes: simplifiedNodes,
      edges: Array.from(edgeMap.values()),
      metadata: data.metadata
    };
  }

  private limitNodes(
    data: TransformedData,
    maxNodes: number
  ): TransformedData {
    // Calculate node importance
    const nodeScores = new Map<string, number>();
    
    data.nodes.forEach(node => {
      let score = 0;
      
      // Entry points are important
      if (node.metadata.isEntry) score += 100;
      
      // High complexity nodes
      score += node.metadata.complexity * 10;
      
      // Highly connected nodes
      score += (node.dependencies.length + node.dependents.length) * 5;
      
      // Risk nodes
      if (node.risk) {
        score += node.risk.score * 20;
      }
      
      nodeScores.set(node.id, score);
    });

    // Sort nodes by importance
    const sortedNodes = [...data.nodes].sort((a, b) => 
      (nodeScores.get(b.id) || 0) - (nodeScores.get(a.id) || 0)
    );

    // Keep top N nodes
    const keptNodes = sortedNodes.slice(0, maxNodes);
    const keptNodeIds = new Set(keptNodes.map(n => n.id));

    // Filter edges
    const keptEdges = data.edges.filter(edge => 
      keptNodeIds.has(edge.from) && keptNodeIds.has(edge.to)
    );

    // Mark removed nodes in metadata
    const removedCount = data.nodes.length - maxNodes;
    
    return {
      nodes: keptNodes,
      edges: keptEdges,
      metadata: {
        ...data.metadata,
        nodesRemoved: removedCount,
        originalNodeCount: data.nodes.length
      } as TransformMetadata
    };
  }

  private highlightRisks(
    data: TransformedData,
    riskAreas: RiskArea[]
  ): TransformedData {
    const riskMap = new Map(riskAreas.map(r => [r.componentId, r]));
    
    const nodes = data.nodes.map(node => {
      const risk = riskMap.get(node.id);
      if (risk) {
        return {
          ...node,
          risk: {
            level: risk.riskLevel,
            reasons: risk.reasons,
            score: this.calculateRiskScore(risk.riskLevel)
          }
        };
      }
      return node;
    });

    // Mark critical paths
    const criticalNodes = new Set(
      riskAreas
        .filter(r => r.riskLevel === 'critical' || r.riskLevel === 'high')
        .map(r => r.componentId)
    );

    const edges = data.edges.map(edge => {
      const isCritical = criticalNodes.has(edge.from) || criticalNodes.has(edge.to);
      return {
        ...edge,
        critical: isCritical
      };
    });

    return { nodes, edges, metadata: data.metadata };
  }

  private calculateRiskScore(level: string): number {
    const scores: Record<string, number> = {
      'critical': 10,
      'high': 7,
      'medium': 4,
      'low': 1
    };
    return scores[level] || 0;
  }

  private enrichWithAPIEndpoints(
    data: TransformedData,
    endpoints: APIEndpoint[]
  ): TransformedData {
    // Group endpoints by component
    const endpointMap = new Map<string, APIInfo[]>();
    
    endpoints.forEach(endpoint => {
      const apis = endpointMap.get(endpoint.componentId) || [];
      apis.push({
        method: endpoint.method,
        path: endpoint.path,
        authenticated: endpoint.authentication.required
      });
      endpointMap.set(endpoint.componentId, apis);
    });

    // Add API info to nodes
    const nodes = data.nodes.map(node => {
      const apis = endpointMap.get(node.id);
      if (apis) {
        return {
          ...node,
          apis,
          metadata: {
            ...node.metadata,
            apiCount: apis.length,
            hasAuthentication: apis.some(a => a.authenticated)
          }
        };
      }
      return node;
    });

    return { nodes, edges: data.edges, metadata: data.metadata };
  }

  private markEntryExitPoints(
    data: TransformedData,
    entryPoints: EntryPoint[],
    exitPoints: ExitPoint[]
  ): TransformedData {
    const entryIds = new Set(entryPoints.map(e => e.componentId));
    const exitIds = new Set(exitPoints.map(e => e.componentId));

    const nodes = data.nodes.map(node => {
      const updates: Partial<TransformedNode> = {};
      
      if (entryIds.has(node.id)) {
        updates.metadata = {
          ...node.metadata,
          isEntry: true,
          entryType: entryPoints.find(e => e.componentId === node.id)?.type
        };
      }
      
      if (exitIds.has(node.id)) {
        updates.metadata = {
          ...node.metadata,
          isExit: true,
          exitType: exitPoints.find(e => e.componentId === node.id)?.type
        };
      }
      
      return { ...node, ...updates };
    });

    return { nodes, edges: data.edges, metadata: data.metadata };
  }

  private calculateImportance(data: TransformedData): TransformedData {
    const nodes = data.nodes.map(node => {
      let importance = 0;
      
      // Connectivity score
      const degree = node.dependencies.length + node.dependents.length;
      importance += Math.min(degree / 10, 3);
      
      // Complexity score
      importance += Math.min(node.metadata.complexity / 5, 2);
      
      // Entry/Exit point bonus
      if (node.metadata.isEntry) importance += 3;
      if (node.metadata.isExit) importance += 2;
      
      // Risk bonus
      if (node.risk) importance += node.risk.score / 2;
      
      // API endpoint bonus
      if (node.apis?.length) importance += Math.min(node.apis.length / 5, 2);
      
      return {
        ...node,
        importance: Math.min(importance, 10)
      };
    });

    return { nodes, edges: data.edges, metadata: data.metadata };
  }

  private prepareForClustering(data: TransformedData): TransformedData {
    // Add clustering hints based on various factors
    const clusterHints = this.detectClusterHints(data);
    
    const nodes = data.nodes.map(node => {
      const hint = clusterHints.get(node.id);
      if (hint) {
        return {
          ...node,
          cluster: hint,
          metadata: {
            ...node.metadata,
            suggestedCluster: hint
          }
        };
      }
      return node;
    });

    return { nodes, edges: data.edges, metadata: data.metadata };
  }

  private detectClusterHints(data: TransformedData): Map<string, string> {
    const hints = new Map<string, string>();
    
    // Cluster by layer
    data.nodes.forEach(node => {
      const layer = node.metadata.layer;
      if (layer) {
        hints.set(node.id, `layer-${layer}`);
      }
    });
    
    // Override with framework-specific clusters
    data.nodes.forEach(node => {
      if (node.framework) {
        const frameworkCluster = `framework-${node.framework}`;
        
        // Only override if it makes sense
        const connectedFrameworks = new Set<string>();
        node.dependencies.forEach(depId => {
          const dep = data.nodes.find(n => n.id === depId);
          if (dep?.framework) connectedFrameworks.add(dep.framework);
        });
        
        if (connectedFrameworks.size <= 1) {
          hints.set(node.id, frameworkCluster);
        }
      }
    });
    
    return hints;
  }

  private calculateMetadata(
    data: TransformedData,
    transformations: string[],
    options: VisualizationOptions
  ): TransformMetadata {
    const statistics = this.calculateStatistics(data);
    
    return {
      totalNodes: data.nodes.length,
      totalEdges: data.edges.length,
      transformations,
      filters: this.getAppliedFilters(options),
      aggregations: this.calculateAggregations(data),
      statistics
    };
  }

  private calculateStatistics(data: TransformedData): TransformStatistics {
    const complexities = data.nodes.map(n => n.metadata.complexity || 0);
    const dependencies = data.nodes.map(n => n.dependencies.length);
    const orphaned = data.nodes.filter(n => n.metadata.isOrphaned).length;
    const coverages = data.nodes
      .map(n => n.metadata.testCoverage)
      .filter(c => c !== undefined) as number[];
    
    const riskDistribution: Record<string, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      none: 0
    };
    
    data.nodes.forEach(node => {
      const level = node.risk?.level || 'none';
      riskDistribution[level]++;
    });
    
    return {
      avgComplexity: this.average(complexities),
      avgDependencies: this.average(dependencies),
      maxComplexity: Math.max(...complexities, 0),
      maxDependencies: Math.max(...dependencies, 0),
      orphanedRatio: data.nodes.length > 0 ? orphaned / data.nodes.length : 0,
      testCoverageAvg: this.average(coverages),
      riskDistribution
    };
  }

  private average(numbers: number[]): number {
    if (numbers.length === 0) return 0;
    return numbers.reduce((a, b) => a + b, 0) / numbers.length;
  }

  private getAppliedFilters(options: VisualizationOptions): string[] {
    const filters: string[] = [];
    
    if (options.filters?.componentTypes?.length) {
      filters.push(`types:${options.filters.componentTypes.join(',')}`);}
    
    if (options.filters?.layers?.length) {
      filters.push(`layers:${options.filters.layers.join(',')}`);
    }
    
    if (options.filters?.complexity) {
      filters.push(`complexity:${options.filters.complexity.min}-${options.filters.complexity.max}`);
    }
    
    if (options.filters?.searchQuery) {
      filters.push(`search:${options.filters.searchQuery}`);
    }
    
    if (options.filters?.orphaned !== undefined) {
      filters.push(`orphaned:${options.filters.orphaned}`);
    }
    
    if (options.filters?.entryPoints !== undefined) {
      filters.push(`entryPoints:${options.filters.entryPoints}`);
    }
    
    return filters;
  }

  private calculateAggregations(data: TransformedData): Record<string, any> {
    const aggregations: Record<string, any> = {};
    
    // Type distribution
    const typeCount: Record<string, number> = {};
    data.nodes.forEach(node => {
      typeCount[node.type] = (typeCount[node.type] || 0) + 1;
    });
    aggregations.typeDistribution = typeCount;
    
    // Layer distribution
    const layerCount: Record<string, number> = {};
    data.nodes.forEach(node => {
      const layer = node.metadata.layer || 'unknown';
      layerCount[layer] = (layerCount[layer] || 0) + 1;
    });
    aggregations.layerDistribution = layerCount;
    
    // Edge type distribution
    const edgeTypeCount: Record<string, number> = {};
    data.edges.forEach(edge => {
      edgeTypeCount[edge.type] = (edgeTypeCount[edge.type] || 0) + 1;
    });
    aggregations.edgeTypeDistribution = edgeTypeCount;
    
    // Framework distribution
    const frameworkCount: Record<string, number> = {};
    data.nodes.forEach(node => {
      if (node.framework) {
        frameworkCount[node.framework] = (frameworkCount[node.framework] || 0) + 1;
      }
    });
    aggregations.frameworkDistribution = frameworkCount;
    
    // Language distribution
    const languageCount: Record<string, number> = {};
    data.nodes.forEach(node => {
      if (node.language) {
        languageCount[node.language] = (languageCount[node.language] || 0) + 1;
      }
    });
    aggregations.languageDistribution = languageCount;
    
    return aggregations;
  }

  aggregateByLayer(data: TransformedData): Map<string, TransformedNode[]> {
    const layers = new Map<string, TransformedNode[]>();
    
    data.nodes.forEach(node => {
      const layer = node.metadata.layer || 'unknown';
      if (!layers.has(layer)) {
        layers.set(layer, []);
      }
      layers.get(layer)!.push(node);
    });
    
    return layers;
  }

  aggregateByType(data: TransformedData): Map<string, TransformedNode[]> {
    const types = new Map<string, TransformedNode[]>();
    
    data.nodes.forEach(node => {
      if (!types.has(node.type)) {
        types.set(node.type, []);
      }
      types.get(node.type)!.push(node);
    });
    
    return types;
  }

  findCriticalPaths(data: TransformedData): string[][] {
    const paths: string[][] = [];
    const entryNodes = data.nodes.filter(n => n.metadata.isEntry);
    const exitNodes = data.nodes.filter(n => n.metadata.isExit);
    
    // Build adjacency list
    const adjacency = new Map<string, string[]>();
    data.nodes.forEach(node => adjacency.set(node.id, []));
    data.edges.forEach(edge => {
      adjacency.get(edge.from)?.push(edge.to);
    });
    
    // Find all paths from entries to exits
    entryNodes.forEach(entry => {
      exitNodes.forEach(exit => {
        const entryPaths = this.findPaths(entry.id, exit.id, adjacency);
        paths.push(...entryPaths);
      });
    });
    
    // Sort by importance (shorter paths are often more critical)
    paths.sort((a, b) => a.length - b.length);
    
    // Return top 10 critical paths
    return paths.slice(0, 10);
  }

  private findPaths(
    start: string,
    end: string,
    adjacency: Map<string, string[]>,
    visited: Set<string> = new Set(),
    path: string[] = []
  ): string[][] {
    path = [...path, start];
    
    if (start === end) {
      return [path];
    }
    
    visited.add(start);
    const paths: string[][] = [];
    
    const neighbors = adjacency.get(start) || [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        const newPaths = this.findPaths(
          neighbor,
          end,
          adjacency,
          new Set(visited),
          path
        );
        paths.push(...newPaths);
      }
    }
    
    return paths;
  }

  detectBottlenecks(data: TransformedData): string[] {
    // Find nodes with high betweenness centrality
    const betweenness = new Map<string, number>();
    data.nodes.forEach(node => betweenness.set(node.id, 0));
    
    // Simplified betweenness calculation
    const paths = this.findCriticalPaths(data);
    
    paths.forEach(path => {
      // Nodes in the middle of paths are potential bottlenecks
      path.slice(1, -1).forEach(nodeId => {
        betweenness.set(nodeId, (betweenness.get(nodeId) || 0) + 1);
      });
    });
    
    // Sort by betweenness and return top bottlenecks
    const sorted = Array.from(betweenness.entries())
      .sort(([,a], [,b]) => b - a)
      .filter(([,score]) => score > 0)
      .slice(0, 10)
      .map(([id]) => id);
    
    return sorted;
  }

  identifyModules(data: TransformedData): Map<string, string[]> {
    // Use community detection to identify modules
    const modules = new Map<string, string[]>();
    const visited = new Set<string>();
    let moduleId = 0;
    
    // Build adjacency list
    const adjacency = new Map<string, Set<string>>();
    data.nodes.forEach(node => adjacency.set(node.id, new Set()));
    data.edges.forEach(edge => {
      adjacency.get(edge.from)?.add(edge.to);
      adjacency.get(edge.to)?.add(edge.from);
    });
    
    // Find strongly connected components
    data.nodes.forEach(node => {
      if (!visited.has(node.id)) {
        const module: string[] = [];
        const queue = [node.id];
        
        while (queue.length > 0) {
          const current = queue.shift()!;
          if (visited.has(current)) continue;
          
          visited.add(current);
          module.push(current);
          
          // Add neighbors with high connectivity
          const neighbors = adjacency.get(current) || new Set();
          const currentNode = data.nodes.find(n => n.id === current);
          
          neighbors.forEach(neighbor => {
            if (!visited.has(neighbor)) {
              // Check if neighbor is strongly connected
              const neighborNode = data.nodes.find(n => n.id === neighbor);
              if (neighborNode && this.areStronglyConnected(
                currentNode!,
                neighborNode,
                data
              )) {
                queue.push(neighbor);
              }
            }
          });
        }
        
        if (module.length > 1) {
          modules.set(`module-${moduleId++}`, module);
        }
      }
    });
    
    return modules;
  }

  private areStronglyConnected(
    node1: TransformedNode,
    node2: TransformedNode,
    data: TransformedData
  ): boolean {
    // Check various connection strengths
    const sameLayer = node1.metadata.layer === node2.metadata.layer;
    const sameType = node1.type === node2.type;
    const sameFramework = node1.framework === node2.framework;
    
    // Count edges between them
    const edgeCount = data.edges.filter(e => 
      (e.from === node1.id && e.to === node2.id) ||
      (e.from === node2.id && e.to === node1.id)
    ).length;
    
    // Strong connection if multiple criteria match
    let score = 0;
    if (sameLayer) score += 2;
    if (sameType) score += 1;
    if (sameFramework) score += 1;
    if (edgeCount > 0) score += edgeCount;
    
    return score >= 3;
  }

  clearCache(): void {
    this.transformCache.clear();
    this.aggregationCache.clear();
  }
}