export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
  level?: number;
  cluster?: string;
  [key: string]: any;
}

export interface LayoutEdge {
  source: string;
  target: string;
  weight?: number;
  [key: string]: any;
}

export interface LayoutData {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
}

export interface LayoutOptions {
  width?: number;
  height?: number;
  padding?: number;
  nodeSpacing?: number;
  levelSpacing?: number;
  iterations?: number;
  temperature?: number;
  gravity?: number;
  repulsion?: number;
  attraction?: number;
  edgeLength?: number;
}

export type LayoutType = 
  | 'force'
  | 'hierarchical'
  | 'circular'
  | 'grid'
  | 'dagre'
  | 'radial'
  | 'tree'
  | 'spectral'
  | 'random';

export class LayoutAlgorithms {
  private defaultOptions: LayoutOptions = {
    width: 1200,
    height: 800,
    padding: 50,
    nodeSpacing: 100,
    levelSpacing: 150,
    iterations: 300,
    temperature: 1000,
    gravity: 0.1,
    repulsion: 1000,
    attraction: 0.001,
    edgeLength: 100
  };

  async calculate(
    data: any,
    layout: string,
    dimensions?: { width: number; height: number }
  ): Promise<LayoutData> {
    const options: LayoutOptions = {
      ...this.defaultOptions,
      ...dimensions
    };

    // Convert input data to layout format
    const layoutData = this.prepareLayoutData(data);

    switch (layout) {
      case 'force':
        return this.forceDirectedLayout(layoutData, options);
      case 'hierarchical':
        return this.hierarchicalLayout(layoutData, options);
      case 'circular':
        return this.circularLayout(layoutData, options);
      case 'grid':
        return this.gridLayout(layoutData, options);
      case 'dagre':
        return this.dagreLayout(layoutData, options);
      case 'radial':
        return this.radialLayout(layoutData, options);
      case 'tree':
        return this.treeLayout(layoutData, options);
      case 'spectral':
        return this.spectralLayout(layoutData, options);
      case 'random':
        return this.randomLayout(layoutData, options);
      default:
        return this.forceDirectedLayout(layoutData, options);
    }
  }

  private prepareLayoutData(data: any): LayoutData {
    const nodes: LayoutNode[] = data.nodes.map((node: any) => ({
      id: node.id,
      x: node.x || 0,
      y: node.y || 0,
      ...node
    }));

    const edges: LayoutEdge[] = data.edges.map((edge: any) => ({
      source: edge.from || edge.source,
      target: edge.to || edge.target,
      weight: edge.weight || 1,
      ...edge
    }));

    return { nodes, edges };
  }

  private forceDirectedLayout(
    data: LayoutData,
    options: LayoutOptions
  ): LayoutData {
    const { nodes, edges } = data;
    const { width = 1200, height = 800, iterations = 300 } = options;

    // Initialize positions randomly if not set
    nodes.forEach(node => {
      if (!node.x || !node.y) {
        node.x = Math.random() * width;
        node.y = Math.random() * height;
      }
      node.vx = 0;
      node.vy = 0;
    });

    // Create node index for edge lookups
    const nodeIndex = new Map(nodes.map(n => [n.id, n]));

    // Simulation loop
    for (let iter = 0; iter < iterations; iter++) {
      const alpha = 1 - iter / iterations; // Cooling factor
      const temperature = options.temperature! * alpha;

      // Apply forces
      this.applyRepulsionForce(nodes, options.repulsion!, alpha);
      this.applyAttractionForce(nodes, edges, nodeIndex, options.attraction!, alpha);
      this.applyGravityForce(nodes, width / 2, height / 2, options.gravity!, alpha);

      // Update positions
      nodes.forEach(node => {
        if (node.fx !== null && node.fx !== undefined) {
          node.x = node.fx;
        } else {
          node.vx = (node.vx || 0) * 0.9; // Damping
          node.x += node.vx * alpha;
          node.x = Math.max(options.padding!, Math.min(width - options.padding!, node.x));
        }

        if (node.fy !== null && node.fy !== undefined) {
          node.y = node.fy;
        } else {
          node.vy = (node.vy || 0) * 0.9; // Damping
          node.y += node.vy * alpha;
          node.y = Math.max(options.padding!, Math.min(height - options.padding!, node.y));
        }
      });
    }

    return { nodes, edges };
  }

  private applyRepulsionForce(
    nodes: LayoutNode[],
    repulsion: number,
    alpha: number
  ): void {
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[j].x - nodes[i].x;
        const dy = nodes[j].y - nodes[i].y;
        const distance = Math.sqrt(dx * dx + dy * dy) || 1;
        
        const force = (repulsion * alpha) / (distance * distance);
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;

        nodes[i].vx! -= fx;
        nodes[i].vy! -= fy;
        nodes[j].vx! += fx;
        nodes[j].vy! += fy;
      }
    }
  }

  private applyAttractionForce(
    nodes: LayoutNode[],
    edges: LayoutEdge[],
    nodeIndex: Map<string, LayoutNode>,
    attraction: number,
    alpha: number
  ): void {
    edges.forEach(edge => {
      const source = nodeIndex.get(edge.source);
      const target = nodeIndex.get(edge.target);
      
      if (!source || !target) return;

      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const distance = Math.sqrt(dx * dx + dy * dy) || 1;
      
      const force = distance * attraction * alpha * (edge.weight || 1);
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;

      source.vx! += fx;
      source.vy! += fy;
      target.vx! -= fx;
      target.vy! -= fy;
    });
  }

  private applyGravityForce(
    nodes: LayoutNode[],
    centerX: number,
    centerY: number,
    gravity: number,
    alpha: number
  ): void {
    nodes.forEach(node => {
      const dx = centerX - node.x;
      const dy = centerY - node.y;
      const distance = Math.sqrt(dx * dx + dy * dy) || 1;
      
      const force = gravity * alpha;
      node.vx! += (dx / distance) * force;
      node.vy! += (dy / distance) * force;
    });
  }

  private hierarchicalLayout(
    data: LayoutData,
    options: LayoutOptions
  ): LayoutData {
    const { nodes, edges } = data;
    const { width = 1200, height = 800, levelSpacing = 150, nodeSpacing = 100 } = options;

    // Calculate node levels using topological sort
    const levels = this.calculateLevels(nodes, edges);
    const maxLevel = Math.max(...Array.from(levels.values()));

    // Group nodes by level
    const levelGroups = new Map<number, LayoutNode[]>();
    nodes.forEach(node => {
      const level = levels.get(node.id) || 0;
      node.level = level;
      if (!levelGroups.has(level)) {
        levelGroups.set(level, []);
      }
      levelGroups.get(level)!.push(node);
    });

    // Position nodes
    levelGroups.forEach((levelNodes, level) => {
      const y = options.padding! + level * levelSpacing;
      const totalWidth = (levelNodes.length - 1) * nodeSpacing;
      const startX = (width - totalWidth) / 2;

      levelNodes.forEach((node, index) => {
        node.x = startX + index * nodeSpacing;
        node.y = y;
      });
    });

    // Minimize edge crossings
    this.minimizeCrossings(nodes, edges, levelGroups);

    return { nodes, edges };
  }

  private calculateLevels(
    nodes: LayoutNode[],
    edges: LayoutEdge[]
  ): Map<string, number> {
    const levels = new Map<string, number>();
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();

    // Initialize
    nodes.forEach(node => {
      inDegree.set(node.id, 0);
      adjacency.set(node.id, []);
      levels.set(node.id, 0);
    });

    // Build adjacency list and calculate in-degrees
    edges.forEach(edge => {
      adjacency.get(edge.source)?.push(edge.target);
      inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
    });

    // Topological sort with level assignment
    const queue: string[] = [];
    inDegree.forEach((degree, nodeId) => {
      if (degree === 0) {
        queue.push(nodeId);
      }
    });

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      const currentLevel = levels.get(nodeId) || 0;

      adjacency.get(nodeId)?.forEach(targetId => {
        levels.set(targetId, Math.max(levels.get(targetId) || 0, currentLevel + 1));
        inDegree.set(targetId, (inDegree.get(targetId) || 0) - 1);
        
        if (inDegree.get(targetId) === 0) {
          queue.push(targetId);
        }
      });
    }

    return levels;
  }

  private minimizeCrossings(
    nodes: LayoutNode[],
    edges: LayoutEdge[],
    levelGroups: Map<number, LayoutNode[]>
  ): void {
    // Simple barycentric method for minimizing crossings
    const maxIterations = 10;
    
    for (let iter = 0; iter < maxIterations; iter++) {
      let improved = false;

      levelGroups.forEach((levelNodes, level) => {
        if (levelNodes.length <= 1) return;

        // Calculate barycentric positions
        const positions = new Map<string, number>();
        
        levelNodes.forEach(node => {
          let sumPos = 0;
          let count = 0;

          edges.forEach(edge => {
            if (edge.source === node.id || edge.target === node.id) {
              const otherId = edge.source === node.id ? edge.target : edge.source;
              const other = nodes.find(n => n.id === otherId);
              if (other && other.level !== level) {
                sumPos += other.x;
                count++;
              }
            }
          });

          if (count > 0) {
            positions.set(node.id, sumPos / count);
          } else {
            positions.set(node.id, node.x);
          }
        });

        // Sort nodes by barycentric position
        levelNodes.sort((a, b) => 
          (positions.get(a.id) || 0) - (positions.get(b.id) || 0)
        );

        // Reassign x positions
        const nodeSpacing = 100;
        const totalWidth = (levelNodes.length - 1) * nodeSpacing;
        const startX = (1200 - totalWidth) / 2;

        levelNodes.forEach((node, index) => {
          const newX = startX + index * nodeSpacing;
          if (Math.abs(newX - node.x) > 1) {
            improved = true;
            node.x = newX;
          }
        });
      });

      if (!improved) break;
    }
  }

  private circularLayout(
    data: LayoutData,
    options: LayoutOptions
  ): LayoutData {
    const { nodes, edges } = data;
    const { width = 1200, height = 800, padding = 50 } = options;

    const centerX = width / 2;
    const centerY = height / 2;
    const radius = Math.min(width, height) / 2 - padding;
    const angleStep = (2 * Math.PI) / nodes.length;

    nodes.forEach((node, index) => {
      const angle = index * angleStep;
      node.x = centerX + radius * Math.cos(angle);
      node.y = centerY + radius * Math.sin(angle);
    });

    // Order nodes to minimize edge crossings
    this.optimizeCircularOrder(nodes, edges);

    return { nodes, edges };
  }

  private optimizeCircularOrder(
    nodes: LayoutNode[],
    edges: LayoutEdge[]
  ): void {
    // Simple heuristic: place connected nodes close to each other
    const adjacency = new Map<string, Set<string>>();
    
    nodes.forEach(node => {
      adjacency.set(node.id, new Set());
    });

    edges.forEach(edge => {
      adjacency.get(edge.source)?.add(edge.target);
      adjacency.get(edge.target)?.add(edge.source);
    });

    // Greedy placement
    const placed = new Set<string>();
    const ordered: LayoutNode[] = [];

    // Start with node with most connections
    const startNode = nodes.reduce((max, node) => 
      (adjacency.get(node.id)?.size || 0) > (adjacency.get(max.id)?.size || 0) ? node : max
    );

    ordered.push(startNode);
    placed.add(startNode.id);

    // Place remaining nodes
    while (ordered.length < nodes.length) {
      let bestNode: LayoutNode | null = null;
      let bestScore = -1;

      for (const node of nodes) {
        if (placed.has(node.id)) continue;

        // Score based on connections to already placed nodes
        let score = 0;
        for (const placedId of placed) {
          if (adjacency.get(node.id)?.has(placedId)) {
            score++;
          }
        }

        if (score > bestScore) {
          bestScore = score;
          bestNode = node;
        }
      }

      if (bestNode) {
        ordered.push(bestNode);
        placed.add(bestNode.id);
      } else {
        // Add any remaining unconnected nodes
        const remaining = nodes.find(n => !placed.has(n.id));
        if (remaining) {
          ordered.push(remaining);
          placed.add(remaining.id);
        }
      }
    }

    // Update positions based on new order
    const centerX = 600;
    const centerY = 400;
    const radius = 350;
    const angleStep = (2 * Math.PI) / ordered.length;

    ordered.forEach((node, index) => {
      const angle = index * angleStep;
      node.x = centerX + radius * Math.cos(angle);
      node.y = centerY + radius * Math.sin(angle);
    });
  }

  private gridLayout(
    data: LayoutData,
    options: LayoutOptions
  ): LayoutData {
    const { nodes, edges } = data;
    const { width = 1200, height = 800, padding = 50, nodeSpacing = 100 } = options;

    const cols = Math.ceil(Math.sqrt(nodes.length));
    const rows = Math.ceil(nodes.length / cols);
    const cellWidth = (width - 2 * padding) / cols;
    const cellHeight = (height - 2 * padding) / rows;

    nodes.forEach((node, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      node.x = padding + col * cellWidth + cellWidth / 2;
      node.y = padding + row * cellHeight + cellHeight / 2;
    });

    return { nodes, edges };
  }

  private dagreLayout(
    data: LayoutData,
    options: LayoutOptions
  ): LayoutData {
    // Simplified Dagre-like layout (Sugiyama algorithm)
    const { nodes, edges } = data;
    const { width = 1200, height = 800 } = options;

    // Step 1: Assign layers (already done in hierarchical)
    const levels = this.calculateLevels(nodes, edges);
    
    // Step 2: Create proper hierarchy
    const layers = new Map<number, LayoutNode[]>();
    let maxLayer = 0;
    
    nodes.forEach(node => {
      const layer = levels.get(node.id) || 0;
      maxLayer = Math.max(maxLayer, layer);
      if (!layers.has(layer)) {
        layers.set(layer, []);
      }
      layers.get(layer)!.push(node);
    });

    // Step 3: Position nodes with proper spacing
    const layerHeight = (height - 100) / (maxLayer + 1);
    
    layers.forEach((layerNodes, layer) => {
      const y = 50 + layer * layerHeight;
      
      // Sort nodes in layer by median position of connected nodes
      layerNodes.sort((a, b) => {
        const aMedian = this.getMedianPosition(a.id, edges, nodes);
        const bMedian = this.getMedianPosition(b.id, edges, nodes);
        return aMedian - bMedian;
      });
      
      const layerWidth = layerNodes.length * 150;
      const startX = (width - layerWidth) / 2;
      
      layerNodes.forEach((node, index) => {
        node.x = startX + index * 150;
        node.y = y;
        node.level = layer;
      });
    });

    // Step 4: Minimize crossings
    for (let i = 0; i < 5; i++) {
      this.reduceCrossings(layers, edges);
    }

    return { nodes, edges };
  }

  private getMedianPosition(
    nodeId: string,
    edges: LayoutEdge[],
    nodes: LayoutNode[]
  ): number {
    const positions: number[] = [];
    
    edges.forEach(edge => {
      if (edge.source === nodeId || edge.target === nodeId) {
        const otherId = edge.source === nodeId ? edge.target : edge.source;
        const otherNode = nodes.find(n => n.id === otherId);
        if (otherNode && otherNode.x) {
          positions.push(otherNode.x);
        }
      }
    });
    
    if (positions.length === 0) return 0;
    
    positions.sort((a, b) => a - b);
    const mid = Math.floor(positions.length / 2);
    
    if (positions.length % 2 === 0) {
      return (positions[mid - 1] + positions[mid]) / 2;
    }
    return positions[mid];
  }

  private reduceCrossings(
    layers: Map<number, LayoutNode[]>,
    edges: LayoutEdge[]
  ): void {
    layers.forEach((layer, level) => {
      if (layer.length <= 1) return;
      
      // Use median heuristic
      const positions = new Map<string, number>();
      
      layer.forEach(node => {
        const median = this.getMedianPosition(node.id, edges, Array.from(layers.values()).flat());
        positions.set(node.id, median || node.x);
      });
      
      // Sort by median position
      layer.sort((a, b) => 
        (positions.get(a.id) || 0) - (positions.get(b.id) || 0)
      );
      
      // Update x positions
      const startX = (1200 - layer.length * 150) / 2;
      layer.forEach((node, index) => {
        node.x = startX + index * 150;
      });
    });
  }

  private radialLayout(
    data: LayoutData,
    options: LayoutOptions
  ): LayoutData {
    const { nodes, edges } = data;
    const { width = 1200, height = 800 } = options;

    const centerX = width / 2;
    const centerY = height / 2;

    // Find central node (highest degree)
    const degrees = new Map<string, number>();
    nodes.forEach(node => degrees.set(node.id, 0));
    
    edges.forEach(edge => {
      degrees.set(edge.source, (degrees.get(edge.source) || 0) + 1);
      degrees.set(edge.target, (degrees.get(edge.target) || 0) + 1);
    });

    let centralNode = nodes[0];
    let maxDegree = 0;
    
    nodes.forEach(node => {
      const degree = degrees.get(node.id) || 0;
      if (degree > maxDegree) {
        maxDegree = degree;
        centralNode = node;
      }
    });

    // Place central node
    centralNode.x = centerX;
    centralNode.y = centerY;

    // Calculate distances from central node
    const distances = this.calculateDistances(centralNode.id, nodes, edges);
    const maxDistance = Math.max(...Array.from(distances.values()));

    // Group nodes by distance
    const rings = new Map<number, LayoutNode[]>();
    nodes.forEach(node => {
      if (node.id === centralNode.id) return;
      
      const distance = distances.get(node.id) || maxDistance;
      if (!rings.has(distance)) {
        rings.set(distance, []);
      }
      rings.get(distance)!.push(node);
    });

    // Place nodes in rings
    rings.forEach((ringNodes, distance) => {
      const radius = (distance / maxDistance) * Math.min(width, height) / 2 * 0.8;
      const angleStep = (2 * Math.PI) / ringNodes.length;
      
      ringNodes.forEach((node, index) => {
        const angle = index * angleStep;
        node.x = centerX + radius * Math.cos(angle);
        node.y = centerY + radius * Math.sin(angle);
      });
    });

    return { nodes, edges };
  }

  private calculateDistances(
    startId: string,
    nodes: LayoutNode[],
    edges: LayoutEdge[]
  ): Map<string, number> {
    const distances = new Map<string, number>();
    const adjacency = new Map<string, Set<string>>();
    
    // Build adjacency list
    nodes.forEach(node => {
      adjacency.set(node.id, new Set());
      distances.set(node.id, Infinity);
    });
    
    edges.forEach(edge => {
      adjacency.get(edge.source)?.add(edge.target);
      adjacency.get(edge.target)?.add(edge.source);
    });
    
    // BFS to calculate distances
    const queue = [startId];
    distances.set(startId, 0);
    
    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentDist = distances.get(current)!;
      
      adjacency.get(current)?.forEach(neighbor => {
        if (distances.get(neighbor) === Infinity) {
          distances.set(neighbor, currentDist + 1);
          queue.push(neighbor);
        }
      });
    }
    
    // Set unreachable nodes to max distance + 1
    const maxReachable = Math.max(
      ...Array.from(distances.values()).filter(d => d !== Infinity)
    );
    
    distances.forEach((dist, nodeId) => {
      if (dist === Infinity) {
        distances.set(nodeId, maxReachable + 1);
      }
    });
    
    return distances;
  }

  private treeLayout(
    data: LayoutData,
    options: LayoutOptions
  ): LayoutData {
    const { nodes, edges } = data;
    const { width = 1200, height = 800 } = options;

    // Find root nodes (no incoming edges)
    const hasIncoming = new Set<string>();
    edges.forEach(edge => hasIncoming.add(edge.target));
    
    const roots = nodes.filter(node => !hasIncoming.has(node.id));
    if (roots.length === 0) {
      // If no clear root, use node with highest out-degree
      const outDegree = new Map<string, number>();
      nodes.forEach(node => outDegree.set(node.id, 0));
      edges.forEach(edge => {
        outDegree.set(edge.source, (outDegree.get(edge.source) || 0) + 1);
      });
      
      const maxOutDegree = Math.max(...Array.from(outDegree.values()));
      const root = nodes.find(n => outDegree.get(n.id) === maxOutDegree);
      if (root) roots.push(root);
    }

    // Build tree structure
    const children = new Map<string, LayoutNode[]>();
    nodes.forEach(node => children.set(node.id, []));
    
    edges.forEach(edge => {
      const childNode = nodes.find(n => n.id === edge.target);
      if (childNode) {
        children.get(edge.source)?.push(childNode);
      }
    });

    // Layout each tree
    const treeWidth = width / roots.length;
    roots.forEach((root, index) => {
      const treeX = index * treeWidth + treeWidth / 2;
      this.layoutSubtree(root, children, treeX, 50, treeWidth, height - 100);
    });

    return { nodes, edges };
  }

  private layoutSubtree(
    node: LayoutNode,
    children: Map<string, LayoutNode[]>,
    x: number,
    y: number,
    width: number,
    height: number
  ): void {
    node.x = x;
    node.y = y;

    const nodeChildren = children.get(node.id) || [];
    if (nodeChildren.length === 0) return;

    const childWidth = width / nodeChildren.length;
    const childY = y + 100;
    
    nodeChildren.forEach((child, index) => {
      const childX = x - width / 2 + childWidth * index + childWidth / 2;
      this.layoutSubtree(child, children, childX, childY, childWidth, height - 100);
    });
  }

  private spectralLayout(
    data: LayoutData,
    options: LayoutOptions
  ): LayoutData {
    const { nodes, edges } = data;
    const { width = 1200, height = 800 } = options;

    // Create adjacency matrix
    const n = nodes.length;
    const nodeIndex = new Map(nodes.map((node, i) => [node.id, i]));
    const adjacency = Array(n).fill(0).map(() => Array(n).fill(0));
    
    edges.forEach(edge => {
      const i = nodeIndex.get(edge.source);
      const j = nodeIndex.get(edge.target);
      if (i !== undefined && j !== undefined) {
        adjacency[i][j] = 1;
        adjacency[j][i] = 1;
      }
    });

    // Calculate degree matrix
    const degree = Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      degree[i] = adjacency[i].reduce((sum, val) => sum + val, 0);
    }

    // Calculate Laplacian matrix (L = D - A)
    const laplacian = Array(n).fill(0).map(() => Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) {
          laplacian[i][j] = degree[i];
        } else {
          laplacian[i][j] = -adjacency[i][j];
        }
      }
    }

    // Simple spectral embedding using power iteration
    // (In production, would use proper eigendecomposition)
    const coords = this.powerIteration(laplacian, 2);
    
    // Map to layout coordinates
    const xCoords = coords[0];
    const yCoords = coords[1] || coords[0].map(() => Math.random());
    
    const xMin = Math.min(...xCoords);
    const xMax = Math.max(...xCoords);
    const yMin = Math.min(...yCoords);
    const yMax = Math.max(...yCoords);
    
    nodes.forEach((node, i) => {
      node.x = 50 + ((xCoords[i] - xMin) / (xMax - xMin || 1)) * (width - 100);
      node.y = 50 + ((yCoords[i] - yMin) / (yMax - yMin || 1)) * (height - 100);
    });

    return { nodes, edges };
  }

  private powerIteration(matrix: number[][], numVectors: number): number[][] {
    const n = matrix.length;
    const vectors: number[][] = [];
    
    for (let v = 0; v < numVectors; v++) {
      // Initialize random vector
      let vector = Array(n).fill(0).map(() => Math.random() - 0.5);
      
      // Power iteration
      for (let iter = 0; iter < 100; iter++) {
        const newVector = Array(n).fill(0);
        
        for (let i = 0; i < n; i++) {
          for (let j = 0; j < n; j++) {
            newVector[i] += matrix[i][j] * vector[j];
          }
        }
        
        // Normalize
        const norm = Math.sqrt(newVector.reduce((sum, val) => sum + val * val, 0));
        vector = newVector.map(val => val / (norm || 1));
      }
      
      vectors.push(vector);
    }
    
    return vectors;
  }

  private randomLayout(
    data: LayoutData,
    options: LayoutOptions
  ): LayoutData {
    const { nodes, edges } = data;
    const { width = 1200, height = 800, padding = 50 } = options;

    nodes.forEach(node => {
      node.x = padding + Math.random() * (width - 2 * padding);
      node.y = padding + Math.random() * (height - 2 * padding);
    });

    return { nodes, edges };
  }

  async optimizeForLargeGraphs(
    data: LayoutData,
    layout: LayoutType,
    options: LayoutOptions
  ): Promise<LayoutData> {
    const nodeCount = data.nodes.length;
    
    // Use simplified algorithms for very large graphs
    if (nodeCount > 1000) {
      options.iterations = Math.min(options.iterations || 300, 100);
      
      // Use grid or circular for very large graphs
      if (nodeCount > 5000 && layout === 'force') {
        return this.gridLayout(data, options);
      }
    }
    
    // For medium and large graphs, just use the basic calculate method
    return await this.calculate(data, layout, { width: options.width || 1200, height: options.height || 800 });
  }

  // Removed complex clustering method for now - can be re-added later when needed

  private detectClusters(data: LayoutData): Array<{ id: string; nodes: string[] }> {
    const visited = new Set<string>();
    const clusters: Array<{ id: string; nodes: string[] }> = [];
    const adjacency = new Map<string, Set<string>>();
    
    // Build adjacency list
    data.nodes.forEach(node => adjacency.set(node.id, new Set()));
    data.edges.forEach(edge => {
      adjacency.get(edge.source)?.add(edge.target);
      adjacency.get(edge.target)?.add(edge.source);
    });
    
    // Find connected components
    data.nodes.forEach(node => {
      if (!visited.has(node.id)) {
        const cluster: string[] = [];
        const queue = [node.id];
        
        while (queue.length > 0) {
          const current = queue.shift()!;
          if (visited.has(current)) continue;
          
          visited.add(current);
          cluster.push(current);
          
          adjacency.get(current)?.forEach(neighbor => {
            if (!visited.has(neighbor)) {
              queue.push(neighbor);
            }
          });
        }
        
        clusters.push({
          id: `cluster-${clusters.length}`,
          nodes: cluster
        });
      }
    });
    
    return clusters;
  }

  private getClusterEdges(
    clusters: Array<{ id: string; nodes: string[] }>,
    edges: LayoutEdge[]
  ): LayoutEdge[] {
    const clusterMap = new Map<string, string>();
    clusters.forEach(cluster => {
      cluster.nodes.forEach(nodeId => {
        clusterMap.set(nodeId, cluster.id);
      });
    });
    
    const clusterEdges = new Map<string, number>();
    
    edges.forEach(edge => {
      const sourceCluster = clusterMap.get(edge.source);
      const targetCluster = clusterMap.get(edge.target);
      
      if (sourceCluster && targetCluster && sourceCluster !== targetCluster) {
        const key = `${sourceCluster}-${targetCluster}`;
        clusterEdges.set(key, (clusterEdges.get(key) || 0) + 1);
      }
    });
    
    return Array.from(clusterEdges.entries()).map(([key, weight]) => {
      const [source, target] = key.split('-');
      return { source, target, weight };
    });
  }
}