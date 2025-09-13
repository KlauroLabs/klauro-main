import { ArchitectureBlueprint, ComponentNode, Connection } from '../types';

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  metadata: GraphMetadata;
}

export interface GraphNode {
  id: string;
  label: string;
  type: string;
  group?: string;
  properties: Record<string, any>;
  position?: { x: number; y: number; z?: number };
  style?: NodeStyle;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  weight?: number;
  properties?: Record<string, any>;
  style?: EdgeStyle;
}

export interface NodeStyle {
  shape?: 'circle' | 'rectangle' | 'diamond' | 'hexagon' | 'star';
  size?: number;
  color?: string;
  borderColor?: string;
  borderWidth?: number;
  opacity?: number;
  icon?: string;
  fontSize?: number;
  fontColor?: string;
}

export interface EdgeStyle {
  width?: number;
  color?: string;
  opacity?: number;
  lineStyle?: 'solid' | 'dashed' | 'dotted';
  arrow?: boolean;
  arrowSize?: number;
  curvature?: number;
  labelColor?: string;
  labelSize?: number;
}

export interface GraphMetadata {
  totalNodes: number;
  totalEdges: number;
  nodeTypes: Record<string, number>;
  edgeTypes: Record<string, number>;
  density: number;
  avgDegree: number;
  maxDegree: number;
  components: number;
  diameter?: number;
  clustering?: number;
}

export interface RenderOptions {
  format?: 'cytoscape' | 'd3' | 'vis' | 'graphviz' | 'custom';
  style?: 'default' | 'minimal' | 'detailed' | 'blueprint';
  nodeSize?: 'uniform' | 'by-degree' | 'by-complexity' | 'by-importance';
  edgeWeight?: 'uniform' | 'by-usage' | 'by-type';
  labelVisibility?: 'all' | 'selected' | 'none' | 'smart';
  aggregateEdges?: boolean;
  showMetrics?: boolean;
  highlight?: HighlightOptions;
}

export interface HighlightOptions {
  nodes?: string[];
  edges?: string[];
  paths?: string[][];
  clusters?: string[];
  fadeOpacity?: number;
}

export class GraphRenderer {
  private nodeStyleCache: Map<string, NodeStyle>;
  private edgeStyleCache: Map<string, EdgeStyle>;
  private metricsCache: Map<string, any>;

  constructor() {
    this.nodeStyleCache = new Map();
    this.edgeStyleCache = new Map();
    this.metricsCache = new Map();
  }

  render(
    blueprint: ArchitectureBlueprint,
    options: RenderOptions = {}
  ): GraphData {
    const nodes = this.renderNodes(blueprint.components, options);
    const edges = this.renderEdges(blueprint.connections, blueprint.components, options);
    const metadata = this.calculateMetadata(nodes, edges, blueprint);

    // Apply highlighting if specified
    if (options.highlight) {
      this.applyHighlighting(nodes, edges, options.highlight);
    }

    // Aggregate edges if requested
    if (options.aggregateEdges) {
      const aggregated = this.aggregateEdges(edges);
      return { nodes, edges: aggregated, metadata };
    }

    return { nodes, edges, metadata };
  }

  private renderNodes(
    components: ComponentNode[],
    options: RenderOptions
  ): GraphNode[] {
    return components.map(component => {
      const style = this.getNodeStyle(component, options);
      
      return {
        id: component.id,
        label: this.getNodeLabel(component, options),
        type: component.type,
        group: component.metadata.layer,
        properties: {
          path: component.path,
          complexity: component.metadata.complexity,
          lineCount: component.metadata.lineCount,
          dependencies: component.dependencies.length,
          dependents: component.dependents.length,
          isEntry: component.metadata.isEntry,
          isOrphaned: component.metadata.isOrphaned,
          framework: component.framework,
          language: component.language,
          metrics: component.metrics,
          functions: component.metadata.functions?.length || 0,
          testCoverage: component.metadata.testCoverage
        },
        position: component.position,
        style
      };
    });
  }

  private renderEdges(
    connections: Connection[],
    components: ComponentNode[],
    options: RenderOptions
  ): GraphEdge[] {
    const componentMap = new Map(components.map(c => [c.id, c]));
    
    return connections.map((connection, index) => {
      const source = componentMap.get(connection.from);
      const target = componentMap.get(connection.to);
      const style = this.getEdgeStyle(connection, options);
      
      return {
        id: `edge-${index}`,
        source: connection.from,
        target: connection.to,
        type: connection.type,
        weight: this.calculateEdgeWeight(connection, source, target, options),
        properties: {
          protocol: connection.protocol,
          callSites: connection.metadata?.callSites,
          httpMethod: connection.metadata?.httpMethod,
          dataFlow: connection.metadata?.dataFlow,
          relationship: connection.metadata?.relationship,
          ...connection.metadata
        },
        style
      };
    });
  }

  private getNodeStyle(
    component: ComponentNode,
    options: RenderOptions
  ): NodeStyle {
    const cacheKey = `${component.type}-${options.style}`;
    
    if (this.nodeStyleCache.has(cacheKey)) {
      const cached = this.nodeStyleCache.get(cacheKey)!;
      return {
        ...cached,
        size: this.calculateNodeSize(component, options)
      };
    }

    const style: NodeStyle = {
      shape: this.getNodeShape(component.type),
      size: this.calculateNodeSize(component, options),
      color: this.getNodeColor(component),
      borderColor: this.getNodeBorderColor(component),
      borderWidth: component.metadata.isEntry ? 3 : 1,
      opacity: 1,
      icon: this.getNodeIcon(component.type),
      fontSize: 12,
      fontColor: '#333333'
    };

    this.nodeStyleCache.set(cacheKey, style);
    return style;
  }

  private getNodeShape(type: string): NodeStyle['shape'] {
    const shapeMap: Record<string, NodeStyle['shape']> = {
      'route': 'hexagon',
      'controller': 'rectangle',
      'service': 'circle',
      'model': 'diamond',
      'middleware': 'star',
      'database': 'rectangle',
      'external_api': 'hexagon',
      'config': 'circle',
      'utility': 'circle'
    };
    return shapeMap[type] || 'circle';
  }

  private calculateNodeSize(
    component: ComponentNode,
    options: RenderOptions
  ): number {
    const baseSize = 30;
    
    switch (options.nodeSize) {
      case 'uniform':
        return baseSize;
      
      case 'by-degree': {
        const degree = component.dependencies.length + component.dependents.length;
        return baseSize + Math.min(degree * 2, 40);
      }
      
      case 'by-complexity':
        return baseSize + Math.min(component.metadata.complexity * 3, 50);
      
      case 'by-importance': {
        const importance = this.calculateImportance(component);
        return baseSize + importance * 10;
      }
      
      default:
        return baseSize;
    }
  }

  private calculateImportance(component: ComponentNode): number {
    let score = 0;
    
    // Entry points are important
    if (component.metadata.isEntry) score += 3;
    
    // High fan-out (many dependents)
    score += Math.min(component.dependents.length / 5, 3);
    
    // Complex components
    score += Math.min(component.metadata.complexity / 3, 2);
    
    // Framework-specific components
    if (component.type === 'controller' || component.type === 'route') score += 2;
    
    return Math.min(score, 10);
  }

  private getNodeColor(component: ComponentNode): string {
    const colorMap: Record<string, string> = {
      'presentation': '#4CAF50',
      'business': '#2196F3',
      'data': '#9C27B0',
      'infrastructure': '#FF9800',
      'external': '#F44336'
    };
    
    const layer = component.metadata.layer;
    return colorMap[layer] || '#757575';
  }

  private getNodeBorderColor(component: ComponentNode): string {
    if (component.metadata.isOrphaned) return '#F44336';
    if (component.metadata.isEntry) return '#4CAF50';
    if (component.metadata.testCoverage && component.metadata.testCoverage < 50) {
      return '#FF9800';
    }
    return '#CCCCCC';
  }

  private getNodeIcon(type: string): string {
    const iconMap: Record<string, string> = {
      'route': '🛣️',
      'controller': '🎮',
      'service': '⚙️',
      'model': '💾',
      'middleware': '🔀',
      'database': '🗄️',
      'external_api': '☁️',
      'config': '⚙️',
      'utility': '🔧',
      'orphaned': '❓'
    };
    return iconMap[type] || '📦';
  }

  private getNodeLabel(
    component: ComponentNode,
    options: RenderOptions
  ): string {
    if (options.labelVisibility === 'none') return '';
    
    const name = component.name;
    const truncateLength = options.style === 'minimal' ? 20 : 50;
    
    if (name.length > truncateLength) {
      return name.substring(0, truncateLength - 3) + '...';
    }
    
    return name;
  }

  private getEdgeStyle(
    connection: Connection,
    options: RenderOptions
  ): EdgeStyle {
    const cacheKey = `${connection.type}-${options.style}`;
    
    if (this.edgeStyleCache.has(cacheKey)) {
      return this.edgeStyleCache.get(cacheKey)!;
    }

    const style: EdgeStyle = {
      width: this.getEdgeWidth(connection.type, connection.weight),
      color: this.getEdgeColor(connection.type),
      opacity: 0.6,
      lineStyle: this.getEdgeLineStyle(connection.type),
      arrow: true,
      arrowSize: 10,
      curvature: connection.type === 'data_flow' ? 0.3 : 0,
      labelColor: '#666666',
      labelSize: 10
    };

    this.edgeStyleCache.set(cacheKey, style);
    return style;
  }

  private getEdgeWidth(type: string, weight?: number): number {
    const baseWidth = 1;
    const typeMultiplier = type === 'http_call' || type === 'database' ? 2 : 1;
    const weightMultiplier = weight ? Math.min(weight / 10, 3) : 1;
    
    return baseWidth * typeMultiplier * weightMultiplier;
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
    return colorMap[type] || '#CCCCCC';
  }

  private getEdgeLineStyle(type: string): EdgeStyle['lineStyle'] {
    if (type === 'dependency-injection' || type === 'dependency') {
      return 'dashed';
    }
    if (type === 'data_flow' || type === 'data-relationship') {
      return 'dotted';
    }
    return 'solid';
  }

  private calculateEdgeWeight(
    connection: Connection,
    source?: ComponentNode,
    target?: ComponentNode,
    options?: RenderOptions
  ): number {
    if (options?.edgeWeight === 'uniform') return 1;
    
    let weight = connection.weight || 1;
    
    // Increase weight for critical paths
    if (source?.metadata.isEntry) weight *= 2;
    if (target?.metadata.layer === 'data') weight *= 1.5;
    
    // Adjust by call sites
    if (connection.metadata?.callSites) {
      weight *= Math.min(connection.metadata.callSites / 5, 3);
    }
    
    return weight;
  }

  private applyHighlighting(
    nodes: GraphNode[],
    edges: GraphEdge[],
    highlight: HighlightOptions
  ): void {
    const fadeOpacity = highlight.fadeOpacity || 0.2;
    const highlightedNodes = new Set(highlight.nodes || []);
    const highlightedEdges = new Set(highlight.edges || []);
    
    // Add path nodes to highlighted set
    if (highlight.paths) {
      for (const path of highlight.paths) {
        path.forEach(nodeId => highlightedNodes.add(nodeId));
      }
    }
    
    // Apply fading to non-highlighted elements
    for (const node of nodes) {
      if (highlightedNodes.size > 0 && !highlightedNodes.has(node.id)) {
        node.style = {
          ...node.style,
          opacity: fadeOpacity
        };
      }
    }
    
    for (const edge of edges) {
      const isHighlighted = highlightedEdges.has(edge.id) ||
        (highlightedNodes.has(edge.source) && highlightedNodes.has(edge.target));
      
      if (highlightedNodes.size > 0 && !isHighlighted) {
        edge.style = {
          ...edge.style,
          opacity: fadeOpacity
        };
      }
    }
  }

  private aggregateEdges(edges: GraphEdge[]): GraphEdge[] {
    const edgeMap = new Map<string, GraphEdge>();
    
    for (const edge of edges) {
      const key = `${edge.source}-${edge.target}-${edge.type}`;
      
      if (edgeMap.has(key)) {
        const existing = edgeMap.get(key)!;
        existing.weight = (existing.weight || 1) + (edge.weight || 1);
        
        // Merge properties
        if (edge.properties) {
          existing.properties = {
            ...existing.properties,
            ...edge.properties,
            aggregatedCount: ((existing.properties?.aggregatedCount as number) || 1) + 1
          };
        }
      } else {
        edgeMap.set(key, { ...edge });
      }
    }
    
    return Array.from(edgeMap.values());
  }

  private calculateMetadata(
    nodes: GraphNode[],
    edges: GraphEdge[],
    blueprint: ArchitectureBlueprint
  ): GraphMetadata {
    const nodeTypes: Record<string, number> = {};
    const edgeTypes: Record<string, number> = {};
    const degrees = new Map<string, number>();
    
    // Count node types
    for (const node of nodes) {
      nodeTypes[node.type] = (nodeTypes[node.type] || 0) + 1;
      degrees.set(node.id, 0);
    }
    
    // Count edge types and calculate degrees
    for (const edge of edges) {
      edgeTypes[edge.type] = (edgeTypes[edge.type] || 0) + 1;
      degrees.set(edge.source, (degrees.get(edge.source) || 0) + 1);
      degrees.set(edge.target, (degrees.get(edge.target) || 0) + 1);
    }
    
    const degreeValues = Array.from(degrees.values());
    const avgDegree = degreeValues.reduce((a, b) => a + b, 0) / degreeValues.length || 0;
    const maxDegree = Math.max(...degreeValues, 0);
    
    const density = nodes.length > 1 
      ? edges.length / (nodes.length * (nodes.length - 1))
      : 0;
    
    return {
      totalNodes: nodes.length,
      totalEdges: edges.length,
      nodeTypes,
      edgeTypes,
      density,
      avgDegree,
      maxDegree,
      components: this.countComponents(nodes, edges),
      diameter: this.calculateDiameter(nodes, edges),
      clustering: this.calculateClustering(nodes, edges)
    };
  }

  private countComponents(nodes: GraphNode[], edges: GraphEdge[]): number {
    const adjacency = new Map<string, Set<string>>();
    
    // Build adjacency list
    for (const node of nodes) {
      adjacency.set(node.id, new Set());
    }
    
    for (const edge of edges) {
      adjacency.get(edge.source)?.add(edge.target);
      adjacency.get(edge.target)?.add(edge.source);
    }
    
    // Count connected components using DFS
    const visited = new Set<string>();
    let components = 0;
    
    for (const node of nodes) {
      if (!visited.has(node.id)) {
        components++;
        this.dfs(node.id, adjacency, visited);
      }
    }
    
    return components;
  }

  private dfs(
    nodeId: string,
    adjacency: Map<string, Set<string>>,
    visited: Set<string>
  ): void {
    visited.add(nodeId);
    const neighbors = adjacency.get(nodeId) || new Set();
    
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        this.dfs(neighbor, adjacency, visited);
      }
    }
  }

  private calculateDiameter(nodes: GraphNode[], edges: GraphEdge[]): number {
    if (nodes.length === 0) return 0;
    if (nodes.length === 1) return 0;
    
    // Build adjacency list
    const adjacency = new Map<string, Set<string>>();
    for (const node of nodes) {
      adjacency.set(node.id, new Set());
    }
    for (const edge of edges) {
      adjacency.get(edge.source)?.add(edge.target);
      adjacency.get(edge.target)?.add(edge.source);
    }
    
    // Calculate diameter using BFS from each node
    let diameter = 0;
    
    for (const startNode of nodes) {
      const distances = this.bfsDistances(startNode.id, adjacency);
      const maxDistance = Math.max(...distances.values(), 0);
      diameter = Math.max(diameter, maxDistance);
    }
    
    return diameter;
  }

  private bfsDistances(
    start: string,
    adjacency: Map<string, Set<string>>
  ): Map<string, number> {
    const distances = new Map<string, number>();
    const queue: string[] = [start];
    distances.set(start, 0);
    
    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentDistance = distances.get(current)!;
      const neighbors = adjacency.get(current) || new Set();
      
      for (const neighbor of neighbors) {
        if (!distances.has(neighbor)) {
          distances.set(neighbor, currentDistance + 1);
          queue.push(neighbor);
        }
      }
    }
    
    return distances;
  }

  private calculateClustering(nodes: GraphNode[], edges: GraphEdge[]): number {
    if (nodes.length < 3) return 0;
    
    // Build adjacency list
    const adjacency = new Map<string, Set<string>>();
    for (const node of nodes) {
      adjacency.set(node.id, new Set());
    }
    for (const edge of edges) {
      adjacency.get(edge.source)?.add(edge.target);
      adjacency.get(edge.target)?.add(edge.source);
    }
    
    // Calculate clustering coefficient
    let totalCoefficient = 0;
    let validNodes = 0;
    
    for (const node of nodes) {
      const neighbors = Array.from(adjacency.get(node.id) || []);
      const k = neighbors.length;
      
      if (k < 2) continue;
      
      // Count edges between neighbors
      let neighborEdges = 0;
      for (let i = 0; i < neighbors.length; i++) {
        for (let j = i + 1; j < neighbors.length; j++) {
          if (adjacency.get(neighbors[i])?.has(neighbors[j])) {
            neighborEdges++;
          }
        }
      }
      
      const possibleEdges = (k * (k - 1)) / 2;
      const coefficient = neighborEdges / possibleEdges;
      totalCoefficient += coefficient;
      validNodes++;
    }
    
    return validNodes > 0 ? totalCoefficient / validNodes : 0;
  }

  exportToFormat(
    graphData: GraphData,
    format: 'cytoscape' | 'd3' | 'vis' | 'graphviz'
  ): any {
    switch (format) {
      case 'cytoscape':
        return this.toCytoscape(graphData);
      case 'd3':
        return this.toD3(graphData);
      case 'vis':
        return this.toVis(graphData);
      case 'graphviz':
        return this.toGraphviz(graphData);
      default:
        return graphData;
    }
  }

  private toCytoscape(graphData: GraphData): any {
    return {
      elements: {
        nodes: graphData.nodes.map(node => ({
          data: {
            id: node.id,
            label: node.label,
            type: node.type,
            ...node.properties
          },
          position: node.position,
          style: this.nodeStyleToCytoscape(node.style)
        })),
        edges: graphData.edges.map(edge => ({
          data: {
            id: edge.id,
            source: edge.source,
            target: edge.target,
            type: edge.type,
            weight: edge.weight,
            ...edge.properties
          },
          style: this.edgeStyleToCytoscape(edge.style)
        }))
      }
    };
  }

  private nodeStyleToCytoscape(style?: NodeStyle): any {
    if (!style) return {};
    
    return {
      'background-color': style.color,
      'border-color': style.borderColor,
      'border-width': style.borderWidth,
      'opacity': style.opacity,
      'font-size': style.fontSize,
      'color': style.fontColor,
      'width': style.size,
      'height': style.size,
      'shape': style.shape === 'star' ? 'star' : style.shape
    };
  }

  private edgeStyleToCytoscape(style?: EdgeStyle): any {
    if (!style) return {};
    
    return {
      'line-color': style.color,
      'line-style': style.lineStyle,
      'width': style.width,
      'opacity': style.opacity,
      'target-arrow-shape': style.arrow ? 'triangle' : 'none',
      'target-arrow-color': style.color,
      'curve-style': style.curvature ? 'bezier' : 'straight',
      'control-point-step-size': style.curvature ? style.curvature * 100 : 0
    };
  }

  private toD3(graphData: GraphData): any {
    return {
      nodes: graphData.nodes.map(node => ({
        id: node.id,
        label: node.label,
        type: node.type,
        x: node.position?.x,
        y: node.position?.y,
        ...node.properties,
        style: node.style
      })),
      links: graphData.edges.map(edge => ({
        source: edge.source,
        target: edge.target,
        type: edge.type,
        value: edge.weight || 1,
        ...edge.properties,
        style: edge.style
      }))
    };
  }

  private toVis(graphData: GraphData): any {
    return {
      nodes: graphData.nodes.map(node => ({
        id: node.id,
        label: node.label,
        group: node.group,
        x: node.position?.x,
        y: node.position?.y,
        size: node.style?.size,
        color: {
          background: node.style?.color,
          border: node.style?.borderColor
        },
        font: {
          size: node.style?.fontSize,
          color: node.style?.fontColor
        },
        ...node.properties
      })),
      edges: graphData.edges.map(edge => ({
        from: edge.source,
        to: edge.target,
        label: edge.type,
        value: edge.weight,
        color: edge.style?.color,
        width: edge.style?.width,
        dashes: edge.style?.lineStyle === 'dashed',
        arrows: edge.style?.arrow ? 'to' : undefined,
        ...edge.properties
      }))
    };
  }

  private toGraphviz(graphData: GraphData): string {
    const lines: string[] = ['digraph G {'];
    lines.push('  rankdir=TB;');
    lines.push('  node [shape=box];');
    lines.push('');
    
    // Add nodes
    for (const node of graphData.nodes) {
      const attrs: string[] = [];
      attrs.push(`label="${node.label}"`);
      if (node.style?.color) attrs.push(`fillcolor="${node.style.color}"`);
      if (node.style?.shape) attrs.push(`shape="${node.style.shape}"`);
      
      lines.push(`  "${node.id}" [${attrs.join(', ')}];`);
    }
    
    lines.push('');
    
    // Add edges
    for (const edge of graphData.edges) {
      const attrs: string[] = [];
      if (edge.type) attrs.push(`label="${edge.type}"`);
      if (edge.style?.color) attrs.push(`color="${edge.style.color}"`);
      if (edge.style?.lineStyle === 'dashed') attrs.push('style="dashed"');
      
      lines.push(`  "${edge.source}" -> "${edge.target}" [${attrs.join(', ')}];`);
    }
    
    lines.push('}');
    return lines.join('\n');
  }

  clearCache(): void {
    this.nodeStyleCache.clear();
    this.edgeStyleCache.clear();
    this.metricsCache.clear();
  }
}