import { EventEmitter } from 'events';
import { ArchitectureBlueprint, ComponentNode, Connection } from '../types';
import { GraphRenderer } from './graph-renderer';
import { LayoutAlgorithms } from './layout-algorithms';
import { DataTransformer } from './data-transformer';
import { WebSocketManager } from './websocket-manager';
import { ExportService } from './export-service';
import Redis from 'ioredis';
import crypto from 'crypto';
import { Pool } from 'pg';

export interface VisualizationOptions {
  layout?: 'force' | 'hierarchical' | 'circular' | 'grid' | 'dagre' | 'radial';
  clustering?: boolean;
  performanceMode?: boolean;
  maxNodes?: number;
  filters?: VisualizationFilters;
  theme?: 'light' | 'dark' | 'blueprint';
  dimensions?: { width: number; height: number };
  animations?: boolean;
  physics?: boolean;
}

export interface VisualizationFilters {
  componentTypes?: string[];
  complexity?: { min: number; max: number };
  layers?: string[];
  searchQuery?: string;
  orphaned?: boolean;
  entryPoints?: boolean;
  riskLevel?: string[];
  dateRange?: { start: Date; end: Date };
}

export interface VisualizationMetrics {
  nodeCount: number;
  edgeCount: number;
  density: number;
  modularity: number;
  centralNodes: string[];
  clusters: ClusterInfo[];
  renderTime: number;
  cacheHitRate: number;
}

export interface ClusterInfo {
  id: string;
  nodes: string[];
  label: string;
  type: string;
  cohesion: number;
  coupling: number;
}

export interface RenderResult {
  data: VisualizationData;
  metrics: VisualizationMetrics;
  cacheKey: string;
  timestamp: Date;
}

export interface VisualizationData {
  nodes: VisualizationNode[];
  edges: VisualizationEdge[];
  clusters?: ClusterInfo[];
  layout: string;
  viewport?: ViewportConfig;
  interactions?: InteractionConfig;
}

export interface VisualizationNode {
  id: string;
  label: string;
  type: string;
  x?: number;
  y?: number;
  size?: number;
  color?: string;
  icon?: string;
  metadata: Record<string, any>;
  cluster?: string;
  level?: number;
  importance?: number;
  hidden?: boolean;
}

export interface VisualizationEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  weight?: number;
  label?: string;
  color?: string;
  style?: 'solid' | 'dashed' | 'dotted';
  animated?: boolean;
  metadata?: Record<string, any>;
  hidden?: boolean;
}

export interface ViewportConfig {
  center: { x: number; y: number };
  zoom: number;
  bounds?: { minX: number; minY: number; maxX: number; maxY: number };
}

export interface InteractionConfig {
  clickable: boolean;
  draggable: boolean;
  hoverable: boolean;
  zoomable: boolean;
  pannable: boolean;
  selectable: boolean;
}

export interface TelemetryUpdate {
  nodeId: string;
  metrics: {
    requestRate?: number;
    errorRate?: number;
    responseTime?: number;
    memoryUsage?: number;
    cpuUsage?: number;
  };
  timestamp: Date;
}

export class VisualizationEngine extends EventEmitter {
  private redis: Redis;
  private graphRenderer: GraphRenderer;
  private layoutAlgorithms: LayoutAlgorithms;
  private dataTransformer: DataTransformer;
  private wsManager: WebSocketManager;
  private exportService: ExportService;
  private cache: Map<string, RenderResult>;
  private cacheTimeout: number = 300000; // 5 minutes

  constructor(
    pool: Pool,
    redisConfig?: { host: string; port: number; password?: string }
  ) {
    super();
    this.redis = new Redis(redisConfig || { host: 'localhost', port: 6379 });
    this.graphRenderer = new GraphRenderer();
    this.layoutAlgorithms = new LayoutAlgorithms();
    this.dataTransformer = new DataTransformer();
    this.wsManager = new WebSocketManager(pool, redisConfig);
    this.exportService = new ExportService();
    this.cache = new Map();

    this.initializeEventHandlers();
    this.startCacheCleanup();
  }

  private initializeEventHandlers(): void {
    this.wsManager.on('telemetry', (update: TelemetryUpdate) => {
      this.handleTelemetryUpdate(update);
    });

    this.wsManager.on('client-filter', (clientId: string, filters: VisualizationFilters) => {
      this.emit('filter-update', { clientId, filters });
    });
  }

  private startCacheCleanup(): void {
    setInterval(() => {
      const now = Date.now();
      for (const [key, value] of this.cache.entries()) {
        if (now - value.timestamp.getTime() > this.cacheTimeout) {
          this.cache.delete(key);
        }
      }
    }, 60000); // Clean every minute
  }

  async renderVisualization(
    blueprint: ArchitectureBlueprint,
    options: VisualizationOptions = {}
  ): Promise<RenderResult> {
    const startTime = Date.now();
    const cacheKey = this.generateCacheKey(blueprint, options);

    // Check cache
    const cached = await this.getCached(cacheKey);
    if (cached) {
      return {
        ...cached,
        metrics: {
          ...cached.metrics,
          cacheHitRate: 1
        }
      };
    }

    // Transform data
    const transformedData = this.dataTransformer.transform(blueprint, options);

    // Apply filters
    const filteredData = this.applyFilters(transformedData, options.filters);

    // Detect clusters if enabled
    let clusters: ClusterInfo[] = [];
    if (options.clustering) {
      clusters = this.detectClusters(filteredData);
    }

    // Calculate layout
    const layout = options.layout || 'force';
    const layoutData = await this.layoutAlgorithms.calculate(
      filteredData,
      layout,
      options.dimensions
    );

    // Prepare visualization data
    const visualizationData: VisualizationData = {
      nodes: layoutData.nodes.map(node => this.prepareNode(node, options)),
      edges: layoutData.edges.map(edge => this.prepareEdge(edge, options)),
      clusters,
      layout,
      viewport: this.calculateViewport(layoutData.nodes),
      interactions: this.getInteractionConfig(options)
    };

    // Calculate metrics
    const metrics = this.calculateMetrics(visualizationData, Date.now() - startTime);

    // Prepare result
    const result: RenderResult = {
      data: visualizationData,
      metrics,
      cacheKey,
      timestamp: new Date()
    };

    // Cache result
    await this.cacheResult(cacheKey, result);

    return result;
  }

  private prepareNode(node: any, options: VisualizationOptions): VisualizationNode {
    const theme = options.theme || 'light';
    const colors = this.getThemeColors(theme);
    
    return {
      id: node.id,
      label: node.name,
      type: node.type,
      x: node.x,
      y: node.y,
      size: this.calculateNodeSize(node),
      color: colors[node.type] || colors.default,
      icon: this.getNodeIcon(node.type),
      metadata: {
        complexity: node.metadata?.complexity,
        lineCount: node.metadata?.lineCount,
        dependencies: node.dependencies?.length,
        layer: node.metadata?.layer,
        framework: node.framework,
        language: node.language
      },
      cluster: node.cluster,
      level: node.level,
      importance: this.calculateImportance(node),
      hidden: false
    };
  }

  private prepareEdge(edge: any, options: VisualizationOptions): VisualizationEdge {
    return {
      id: `${edge.from}-${edge.to}`,
      source: edge.from,
      target: edge.to,
      type: edge.type,
      weight: edge.weight,
      label: edge.metadata?.httpMethod || edge.type,
      color: this.getEdgeColor(edge.type),
      style: this.getEdgeStyle(edge.type),
      animated: options.animations && edge.type === 'data_flow',
      metadata: edge.metadata,
      hidden: false
    };
  }

  private calculateNodeSize(node: any): number {
    const baseSize = 10;
    const complexity = node.metadata?.complexity || 1;
    const dependencies = node.dependencies?.length || 0;
    return baseSize + Math.log(complexity * 10) + Math.sqrt(dependencies) * 2;
  }

  private calculateImportance(node: any): number {
    const inDegree = node.dependents?.length || 0;
    const outDegree = node.dependencies?.length || 0;
    const complexity = node.metadata?.complexity || 1;
    const isEntry = node.metadata?.isEntry ? 10 : 0;
    
    return (inDegree * 2 + outDegree + complexity + isEntry) / 10;
  }

  private getNodeIcon(type: string): string {
    const iconMap: Record<string, string> = {
      'route': 'mdi-routes',
      'controller': 'mdi-application',
      'service': 'mdi-cog',
      'model': 'mdi-database',
      'middleware': 'mdi-filter',
      'utility': 'mdi-tools',
      'config': 'mdi-settings',
      'database': 'mdi-database-outline',
      'external_api': 'mdi-cloud-outline',
      'orphaned': 'mdi-alert'
    };
    return iconMap[type] || 'mdi-circle';
  }

  private getThemeColors(theme: string): Record<string, string> {
    const themes: Record<string, Record<string, string>> = {
      light: {
        route: '#4CAF50',
        controller: '#2196F3',
        service: '#FF9800',
        model: '#9C27B0',
        middleware: '#00BCD4',
        utility: '#607D8B',
        config: '#795548',
        database: '#3F51B5',
        external_api: '#F44336',
        orphaned: '#9E9E9E',
        default: '#757575'
      },
      dark: {
        route: '#66BB6A',
        controller: '#42A5F5',
        service: '#FFA726',
        model: '#AB47BC',
        middleware: '#26C6DA',
        utility: '#78909C',
        config: '#8D6E63',
        database: '#5C6BC0',
        external_api: '#EF5350',
        orphaned: '#BDBDBD',
        default: '#9E9E9E'
      },
      blueprint: {
        route: '#00E5FF',
        controller: '#00B0FF',
        service: '#FFD740',
        model: '#E040FB',
        middleware: '#40C4FF',
        utility: '#B0BEC5',
        config: '#BCAAA4',
        database: '#536DFE',
        external_api: '#FF5252',
        orphaned: '#455A64',
        default: '#90A4AE'
      }
    };
    return themes[theme] || themes.light;
  }

  private getEdgeColor(type: string): string {
    const colorMap: Record<string, string> = {
      'import': '#90A4AE',
      'http_call': '#4CAF50',
      'database': '#9C27B0',
      'middleware_chain': '#00BCD4',
      'function_call': '#607D8B',
      'data_flow': '#FF9800',
      'dependency-injection': '#2196F3',
      'api-call': '#F44336'
    };
    return colorMap[type] || '#BDBDBD';
  }

  private getEdgeStyle(type: string): 'solid' | 'dashed' | 'dotted' {
    if (type.includes('injection') || type.includes('dependency')) {
      return 'dashed';
    }
    if (type.includes('data') || type.includes('flow')) {
      return 'dotted';
    }
    return 'solid';
  }

  private calculateViewport(nodes: any[]): ViewportConfig {
    if (!nodes.length) {
      return { center: { x: 0, y: 0 }, zoom: 1 };
    }

    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;

    nodes.forEach(node => {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x);
      maxY = Math.max(maxY, node.y);
    });

    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const width = maxX - minX;
    const height = maxY - minY;
    const zoom = Math.min(1, 1000 / Math.max(width, height));

    return {
      center: { x: centerX, y: centerY },
      zoom,
      bounds: { minX, minY, maxX, maxY }
    };
  }

  private getInteractionConfig(options: VisualizationOptions): InteractionConfig {
    return {
      clickable: true,
      draggable: !options.performanceMode,
      hoverable: true,
      zoomable: true,
      pannable: true,
      selectable: true
    };
  }

  private applyFilters(
    data: any,
    filters?: VisualizationFilters
  ): any {
    if (!filters) return data;

    let filteredNodes = [...data.nodes];
    let filteredEdges = [...data.edges];

    // Filter by component types
    if (filters.componentTypes?.length) {
      filteredNodes = filteredNodes.filter(node => 
        filters.componentTypes!.includes(node.type)
      );
    }

    // Filter by complexity
    if (filters.complexity) {
      filteredNodes = filteredNodes.filter(node => {
        const complexity = node.metadata?.complexity || 0;
        return complexity >= filters.complexity!.min && 
               complexity <= filters.complexity!.max;
      });
    }

    // Filter by layers
    if (filters.layers?.length) {
      filteredNodes = filteredNodes.filter(node => 
        filters.layers!.includes(node.metadata?.layer)
      );
    }

    // Search filter
    if (filters.searchQuery) {
      const query = filters.searchQuery.toLowerCase();
      filteredNodes = filteredNodes.filter(node => 
        node.name.toLowerCase().includes(query) ||
        node.path?.toLowerCase().includes(query)
      );
    }

    // Filter orphaned
    if (filters.orphaned !== undefined) {
      filteredNodes = filteredNodes.filter(node => 
        node.metadata?.isOrphaned === filters.orphaned
      );
    }

    // Filter entry points
    if (filters.entryPoints !== undefined) {
      filteredNodes = filteredNodes.filter(node => 
        node.metadata?.isEntry === filters.entryPoints
      );
    }

    // Update edges based on filtered nodes
    const nodeIds = new Set(filteredNodes.map(n => n.id));
    filteredEdges = filteredEdges.filter(edge => 
      nodeIds.has(edge.from) && nodeIds.has(edge.to)
    );

    return {
      ...data,
      nodes: filteredNodes,
      edges: filteredEdges
    };
  }

  private detectClusters(data: any): ClusterInfo[] {
    // Implement community detection algorithm (e.g., Louvain)
    const clusters: ClusterInfo[] = [];
    const visited = new Set<string>();
    let clusterId = 0;

    // Simple clustering based on strongly connected components
    for (const node of data.nodes) {
      if (!visited.has(node.id)) {
        const cluster = this.findCluster(node, data, visited);
        if (cluster.length > 1) {
          clusters.push({
            id: `cluster-${clusterId++}`,
            nodes: cluster,
            label: this.generateClusterLabel(cluster, data),
            type: this.detectClusterType(cluster, data),
            cohesion: this.calculateCohesion(cluster, data),
            coupling: this.calculateCoupling(cluster, data)
          });
        }
      }
    }

    return clusters;
  }

  private findCluster(
    startNode: any,
    data: any,
    visited: Set<string>
  ): string[] {
    const cluster: string[] = [];
    const queue = [startNode.id];
    const localVisited = new Set<string>();

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      if (localVisited.has(nodeId)) continue;
      
      localVisited.add(nodeId);
      visited.add(nodeId);
      cluster.push(nodeId);

      // Find connected nodes
      const node = data.nodes.find((n: any) => n.id === nodeId);
      if (node) {
        // Add dependencies and dependents
        const connected = [
          ...(node.dependencies || []),
          ...(node.dependents || [])
        ];
        
        for (const connId of connected) {
          if (!localVisited.has(connId) && !visited.has(connId)) {
            queue.push(connId);
          }
        }
      }
    }

    return cluster;
  }

  private generateClusterLabel(nodeIds: string[], data: any): string {
    const nodes = nodeIds.map(id => data.nodes.find((n: any) => n.id === id));
    const types = new Set(nodes.map(n => n?.metadata?.layer || n?.type));
    
    if (types.size === 1) {
      return Array.from(types)[0];
    }
    return `Mixed (${types.size} types)`;
  }

  private detectClusterType(nodeIds: string[], data: any): string {
    const nodes = nodeIds.map(id => data.nodes.find((n: any) => n.id === id));
    const layers = nodes.map(n => n?.metadata?.layer).filter(Boolean);
    
    if (!layers.length) return 'unknown';
    
    const layerCounts = layers.reduce((acc, layer) => {
      acc[layer] = (acc[layer] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    const dominantLayer = Object.entries(layerCounts)
      .sort(([,a], [,b]) => Number(b) - Number(a))[0][0];
    
    return dominantLayer;
  }

  private calculateCohesion(nodeIds: string[], data: any): number {
    // Calculate internal connections vs total possible
    let internalConnections = 0;
    const possibleConnections = nodeIds.length * (nodeIds.length - 1);
    
    if (possibleConnections === 0) return 0;
    
    const nodeSet = new Set(nodeIds);
    
    for (const edge of data.edges) {
      if (nodeSet.has(edge.from) && nodeSet.has(edge.to)) {
        internalConnections++;
      }
    }
    
    return internalConnections / possibleConnections;
  }

  private calculateCoupling(nodeIds: string[], data: any): number {
    // Calculate external connections
    let externalConnections = 0;
    const nodeSet = new Set(nodeIds);
    
    for (const edge of data.edges) {
      const fromInternal = nodeSet.has(edge.from);
      const toInternal = nodeSet.has(edge.to);
      
      if (fromInternal !== toInternal) {
        externalConnections++;
      }
    }
    
    return externalConnections / nodeIds.length;
  }

  private calculateMetrics(
    data: VisualizationData,
    renderTime: number
  ): VisualizationMetrics {
    const nodeCount = data.nodes.length;
    const edgeCount = data.edges.length;
    const possibleEdges = nodeCount * (nodeCount - 1);
    const density = possibleEdges > 0 ? edgeCount / possibleEdges : 0;
    
    // Find central nodes (highest degree)
    const degrees = new Map<string, number>();
    data.edges.forEach(edge => {
      degrees.set(edge.source, (degrees.get(edge.source) || 0) + 1);
      degrees.set(edge.target, (degrees.get(edge.target) || 0) + 1);
    });
    
    const sortedNodes = Array.from(degrees.entries())
      .sort(([,a], [,b]) => b - a)
      .slice(0, 5)
      .map(([id]) => id);
    
    return {
      nodeCount,
      edgeCount,
      density,
      modularity: this.calculateModularity(data),
      centralNodes: sortedNodes,
      clusters: data.clusters || [],
      renderTime,
      cacheHitRate: 0
    };
  }

  private calculateModularity(data: VisualizationData): number {
    // Simplified modularity calculation
    if (!data.clusters || data.clusters.length === 0) return 0;
    
    let modularity = 0;
    const m = data.edges.length;
    
    if (m === 0) return 0;
    
    for (const cluster of data.clusters) {
      const nodeSet = new Set(cluster.nodes);
      let internalEdges = 0;
      let degreeSum = 0;
      
      for (const edge of data.edges) {
        if (nodeSet.has(edge.source) && nodeSet.has(edge.target)) {
          internalEdges++;
        }
        if (nodeSet.has(edge.source)) degreeSum++;
        if (nodeSet.has(edge.target)) degreeSum++;
      }
      
      modularity += (internalEdges / m) - Math.pow(degreeSum / (2 * m), 2);
    }
    
    return Math.max(0, Math.min(1, modularity));
  }

  private generateCacheKey(
    blueprint: ArchitectureBlueprint,
    options: VisualizationOptions
  ): string {
    const data = {
      projectName: blueprint.projectName,
      componentCount: blueprint.components.length,
      connectionCount: blueprint.connections.length,
      options
    };
    return crypto.createHash('md5').update(JSON.stringify(data)).digest('hex');
  }

  private async getCached(key: string): Promise<RenderResult | null> {
    // Check memory cache first
    if (this.cache.has(key)) {
      return this.cache.get(key)!;
    }
    
    // Check Redis cache
    try {
      const cached = await this.redis.get(`viz:${key}`);
      if (cached) {
        const result = JSON.parse(cached);
        result.timestamp = new Date(result.timestamp);
        this.cache.set(key, result);
        return result;
      }
    } catch (error) {
      console.error('Cache retrieval error:', error);
    }
    
    return null;
  }

  private async cacheResult(key: string, result: RenderResult): Promise<void> {
    // Memory cache
    this.cache.set(key, result);
    
    // Redis cache
    try {
      await this.redis.setex(
        `viz:${key}`,
        300, // 5 minutes TTL
        JSON.stringify(result)
      );
    } catch (error) {
      console.error('Cache storage error:', error);
    }
  }

  async searchComponents(
    blueprint: ArchitectureBlueprint,
    query: string
  ): Promise<ComponentNode[]> {
    const lowerQuery = query.toLowerCase();
    return blueprint.components.filter(component => 
      component.name.toLowerCase().includes(lowerQuery) ||
      component.path.toLowerCase().includes(lowerQuery) ||
      component.type.toLowerCase().includes(lowerQuery) ||
      component.metadata.exports?.some(exp => 
        exp.toLowerCase().includes(lowerQuery)
      ) ||
      component.metadata.imports?.some(imp => 
        imp.toLowerCase().includes(lowerQuery)
      )
    );
  }

  async exportVisualization(
    data: VisualizationData,
    format: 'svg' | 'pdf' | 'png',
    options?: any
  ): Promise<Buffer> {
    return this.exportService.export(data, format, options);
  }

  streamTelemetry(projectId: string, clientId: string): void {
    this.wsManager.subscribeToTelemetry(projectId, clientId);
  }

  stopTelemetry(clientId: string): void {
    this.wsManager.unsubscribeFromTelemetry(clientId);
  }

  private handleTelemetryUpdate(update: TelemetryUpdate): void {
    // Update visualization with real-time metrics
    this.emit('telemetry-update', update);
    
    // Broadcast to connected clients
    this.wsManager.broadcastTelemetry(update);
  }

  async getPerformanceRecommendations(
    blueprint: ArchitectureBlueprint
  ): Promise<string[]> {
    const recommendations: string[] = [];
    const nodeCount = blueprint.components.length;
    const edgeCount = blueprint.connections.length;
    
    if (nodeCount > 500) {
      recommendations.push('Enable clustering for better performance with large graphs');
      recommendations.push('Consider using hierarchical layout for better organization');
    }
    
    if (edgeCount > nodeCount * 5) {
      recommendations.push('High edge density detected - consider filtering by component type');
      recommendations.push('Enable performance mode to disable animations');
    }
    
    const orphanedCount = blueprint.orphanedComponents.length;
    if (orphanedCount > nodeCount * 0.1) {
      recommendations.push(`${orphanedCount} orphaned components detected - consider filtering them out`);
    }
    
    return recommendations;
  }

  dispose(): void {
    this.wsManager.dispose();
    this.redis.disconnect();
    this.cache.clear();
    this.removeAllListeners();
  }
}