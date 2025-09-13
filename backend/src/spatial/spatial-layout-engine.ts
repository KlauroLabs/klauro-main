import {
  ArchitectureBlueprint,
  ComponentNode,
  Connection,
  CallGraph
} from '../types';
import {
  SpatialBlueprint,
  SpatialPosition,
  SpatialDimensions,
  SpatialBounds,
  Room,
  Building,
  Hallway,
  Pathway,
  SpatialIndex,
  SpatialNode,
  SpatialItem,
  Animation,
  TrafficFlow,
  Vehicle,
  Alert,
  NavigationPath
} from './spatial-types';
import { SpatialDataTransformer } from './spatial-data-transformer';
import { MetaphorMapper } from './metaphor-mapper';
import { LayoutAlgorithmFactory } from './layout-algorithms';

export interface SpatialEngineOptions {
  enableRealTimeUpdates?: boolean;
  enableSpatialIndex?: boolean;
  enableAnimations?: boolean;
  maxRooms?: number;
  maxBuildings?: number;
  collisionDetection?: boolean;
  optimizationLevel?: 'low' | 'medium' | 'high';
  renderingQuality?: 'low' | 'medium' | 'high' | 'ultra';
}

export interface SpatialEngineMetrics {
  transformationTime: number;
  totalElements: number;
  spatialComplexity: number;
  indexSize: number;
  memoryUsage: number;
}

export interface RealTimeUpdate {
  type: 'traffic' | 'alert' | 'metric' | 'position';
  targetId: string;
  data: any;
  timestamp: Date;
}

export interface CollisionResult {
  hasCollision: boolean;
  collidingElements: Array<{ id: string; type: string }>;
  suggestedPosition?: SpatialPosition;
}

export class SpatialLayoutEngine {
  private transformer: SpatialDataTransformer;
  private metaphorMapper: MetaphorMapper;
  private spatialIndex: RTreeIndex | null = null;
  private currentBlueprint: SpatialBlueprint | null = null;
  private animations: Animation[] = [];
  private updateQueue: RealTimeUpdate[] = [];
  private metrics: SpatialEngineMetrics;
  private options: SpatialEngineOptions;
  private webSocketHandlers: Map<string, (data: any) => void> = new Map();

  constructor(options: SpatialEngineOptions = {}) {
    this.options = {
      enableRealTimeUpdates: true,
      enableSpatialIndex: true,
      enableAnimations: true,
      maxRooms: 1000,
      maxBuildings: 50,
      collisionDetection: true,
      optimizationLevel: 'medium',
      renderingQuality: 'high',
      ...options
    };

    this.transformer = new SpatialDataTransformer();
    this.metaphorMapper = new MetaphorMapper();
    
    this.metrics = {
      transformationTime: 0,
      totalElements: 0,
      spatialComplexity: 0,
      indexSize: 0,
      memoryUsage: 0
    };

    if (this.options.enableSpatialIndex) {
      this.spatialIndex = new RTreeIndex();
    }
  }

  async generateSpatialLayout(blueprint: ArchitectureBlueprint): Promise<SpatialBlueprint> {
    const startTime = Date.now();
    console.log('🚀 Starting spatial layout generation...');

    try {
      // Validate and optimize input
      this.validateBlueprint(blueprint);
      const optimizedBlueprint = this.optimizeBlueprint(blueprint);

      // Transform to spatial representation
      const spatialBlueprint = await this.transformer.transformBlueprint(optimizedBlueprint);

      // Optimize spatial layout
      if (this.options.optimizationLevel !== 'low') {
        this.optimizeSpatialLayout(spatialBlueprint);
      }

      // Detect and resolve collisions
      if (this.options.collisionDetection) {
        this.resolveCollisions(spatialBlueprint);
      }

      // Build spatial index
      if (this.options.enableSpatialIndex && this.spatialIndex) {
        this.buildSpatialIndex(spatialBlueprint);
      }

      // Generate animations
      if (this.options.enableAnimations) {
        this.animations = this.transformer.generateAnimations(spatialBlueprint);
      }

      // Store current blueprint
      this.currentBlueprint = spatialBlueprint;

      // Update metrics
      this.updateMetrics(spatialBlueprint, Date.now() - startTime);

      console.log(`✅ Spatial layout generated in ${this.metrics.transformationTime}ms`);
      console.log(`📊 Total elements: ${this.metrics.totalElements}, Complexity: ${this.metrics.spatialComplexity}`);

      return spatialBlueprint;

    } catch (error) {
      console.error('❌ Failed to generate spatial layout:', error);
      throw new Error(`Spatial layout generation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private validateBlueprint(blueprint: ArchitectureBlueprint): void {
    if (!blueprint.components || blueprint.components.length === 0) {
      throw new Error('Blueprint must contain at least one component');
    }

    if (blueprint.components.length > this.options.maxRooms!) {
      throw new Error(`Blueprint exceeds maximum room limit (${this.options.maxRooms})`);
    }

    // Validate component IDs are unique
    const ids = new Set<string>();
    for (const component of blueprint.components) {
      if (ids.has(component.id)) {
        throw new Error(`Duplicate component ID found: ${component.id}`);
      }
      ids.add(component.id);
    }

    // Validate connections reference existing components
    const componentIds = new Set(blueprint.components.map(c => c.id));
    for (const connection of blueprint.connections) {
      if (!componentIds.has(connection.from) || !componentIds.has(connection.to)) {
        throw new Error(`Connection references non-existent component: ${connection.from} -> ${connection.to}`);
      }
    }
  }

  private optimizeBlueprint(blueprint: ArchitectureBlueprint): ArchitectureBlueprint {
    if (this.options.optimizationLevel === 'low') {
      return blueprint;
    }

    const optimized = { ...blueprint };

    // Remove duplicate connections
    const connectionSet = new Set<string>();
    optimized.connections = blueprint.connections.filter(conn => {
      const key = `${conn.from}-${conn.to}-${conn.type}`;
      if (connectionSet.has(key)) {
        return false;
      }
      connectionSet.add(key);
      return true;
    });

    // Merge similar components if optimization is high
    if (this.options.optimizationLevel === 'high') {
      optimized.components = this.mergeSimilarComponents(blueprint.components);
    }

    return optimized;
  }

  private mergeSimilarComponents(components: ComponentNode[]): ComponentNode[] {
    // Group components by type and similar characteristics
    const groups = new Map<string, ComponentNode[]>();
    
    for (const component of components) {
      const key = `${component.type}_${component.metadata.layer}_${Math.floor(component.metadata.complexity / 2)}`;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(component);
    }

    // Merge small similar components
    const merged: ComponentNode[] = [];
    for (const [key, group] of groups.entries()) {
      if (group.length > 5 && this.options.optimizationLevel === 'high') {
        // Create a merged component representing the group
        const mergedComponent: ComponentNode = {
          ...group[0],
          id: `merged_${key}`,
          name: `${group[0].type} Group (${group.length} components)`,
          metadata: {
            ...group[0].metadata,
            lineCount: group.reduce((sum, c) => sum + c.metadata.lineCount, 0),
            complexity: Math.round(group.reduce((sum, c) => sum + c.metadata.complexity, 0) / group.length)
          }
        };
        merged.push(mergedComponent);
      } else {
        merged.push(...group);
      }
    }

    return merged;
  }

  private optimizeSpatialLayout(blueprint: SpatialBlueprint): void {
    // Optimize room positions to minimize hallway lengths
    this.optimizeRoomPositions(blueprint);

    // Optimize building positions for better campus layout
    if (blueprint.buildings.length > 1) {
      this.optimizeBuildingPositions(blueprint);
    }

    // Simplify paths
    this.simplifyPaths(blueprint);
  }

  private optimizeRoomPositions(blueprint: SpatialBlueprint): void {
    // Use force-directed layout to optimize room positions
    const iterations = this.options.optimizationLevel === 'high' ? 100 : 50;
    
    for (let i = 0; i < iterations; i++) {
      for (const room of blueprint.rooms) {
        const forces = this.calculateRoomForces(room, blueprint);
        
        // Apply forces with damping
        const damping = 0.1;
        room.position.x += forces.x * damping;
        room.position.y += forces.y * damping;
        room.position.z += forces.z * damping;
        
        // Snap to grid
        room.position = this.snapToGrid(room.position);
      }
    }
  }

  private calculateRoomForces(room: Room, blueprint: SpatialBlueprint): SpatialPosition {
    const forces = { x: 0, y: 0, z: 0 };
    
    // Attraction forces from connected rooms
    const connectedRooms = this.findConnectedRooms(room, blueprint);
    for (const connected of connectedRooms) {
      const dx = connected.position.x - room.position.x;
      const dy = connected.position.y - room.position.y;
      const dz = connected.position.z - room.position.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      
      if (distance > 0) {
        const force = 0.1 / distance;
        forces.x += dx * force;
        forces.y += dy * force;
        forces.z += dz * force;
      }
    }
    
    // Repulsion forces from nearby rooms
    for (const other of blueprint.rooms) {
      if (other.id === room.id) continue;
      
      const dx = other.position.x - room.position.x;
      const dy = other.position.y - room.position.y;
      const dz = other.position.z - room.position.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      
      if (distance < 20 && distance > 0) {
        const force = -1 / (distance * distance);
        forces.x += dx * force;
        forces.y += dy * force;
        forces.z += dz * force;
      }
    }
    
    return forces;
  }

  private findConnectedRooms(room: Room, blueprint: SpatialBlueprint): Room[] {
    const connected: Room[] = [];
    
    for (const hallway of blueprint.hallways) {
      if (hallway.sourceRoom === room.id) {
        const target = blueprint.rooms.find(r => r.id === hallway.targetRoom);
        if (target) connected.push(target);
      } else if (hallway.targetRoom === room.id) {
        const source = blueprint.rooms.find(r => r.id === hallway.sourceRoom);
        if (source) connected.push(source);
      }
    }
    
    return connected;
  }

  private optimizeBuildingPositions(blueprint: SpatialBlueprint): void {
    // Arrange buildings in a grid or circular pattern
    const buildingCount = blueprint.buildings.length;
    const gridSize = Math.ceil(Math.sqrt(buildingCount));
    
    blueprint.buildings.forEach((building, index) => {
      const row = Math.floor(index / gridSize);
      const col = index % gridSize;
      
      building.position = {
        x: col * 80,
        y: 0,
        z: row * 80
      };
    });
  }

  private simplifyPaths(blueprint: SpatialBlueprint): void {
    // Simplify hallway paths using Douglas-Peucker algorithm
    for (const hallway of blueprint.hallways) {
      hallway.path = this.simplifyPath(hallway.path, 2.0);
    }
    
    for (const pathway of blueprint.pathways) {
      const simplifiedNodes = this.simplifyPath(
        pathway.nodes.map(n => n.position),
        3.0
      );
      pathway.nodes = simplifiedNodes.map(pos => ({ position: pos }));
    }
  }

  private simplifyPath(path: SpatialPosition[], epsilon: number): SpatialPosition[] {
    if (path.length <= 2) return path;
    
    // Find the point with maximum distance from the line
    let maxDist = 0;
    let maxIndex = 0;
    const start = path[0];
    const end = path[path.length - 1];
    
    for (let i = 1; i < path.length - 1; i++) {
      const dist = this.pointToLineDistance(path[i], start, end);
      if (dist > maxDist) {
        maxDist = dist;
        maxIndex = i;
      }
    }
    
    // If max distance is greater than epsilon, recursively simplify
    if (maxDist > epsilon) {
      const left = this.simplifyPath(path.slice(0, maxIndex + 1), epsilon);
      const right = this.simplifyPath(path.slice(maxIndex), epsilon);
      return [...left.slice(0, -1), ...right];
    } else {
      return [start, end];
    }
  }

  private pointToLineDistance(point: SpatialPosition, lineStart: SpatialPosition, lineEnd: SpatialPosition): number {
    const dx = lineEnd.x - lineStart.x;
    const dy = lineEnd.y - lineStart.y;
    const dz = lineEnd.z - lineStart.z;
    const lengthSquared = dx * dx + dy * dy + dz * dz;
    
    if (lengthSquared === 0) {
      return Math.sqrt(
        Math.pow(point.x - lineStart.x, 2) +
        Math.pow(point.y - lineStart.y, 2) +
        Math.pow(point.z - lineStart.z, 2)
      );
    }
    
    const t = Math.max(0, Math.min(1, (
      (point.x - lineStart.x) * dx +
      (point.y - lineStart.y) * dy +
      (point.z - lineStart.z) * dz
    ) / lengthSquared));
    
    const projection = {
      x: lineStart.x + t * dx,
      y: lineStart.y + t * dy,
      z: lineStart.z + t * dz
    };
    
    return Math.sqrt(
      Math.pow(point.x - projection.x, 2) +
      Math.pow(point.y - projection.y, 2) +
      Math.pow(point.z - projection.z, 2)
    );
  }

  private resolveCollisions(blueprint: SpatialBlueprint): void {
    const resolved = new Set<string>();
    
    // Check room collisions
    for (let i = 0; i < blueprint.rooms.length; i++) {
      for (let j = i + 1; j < blueprint.rooms.length; j++) {
        const room1 = blueprint.rooms[i];
        const room2 = blueprint.rooms[j];
        
        if (this.checkCollision(room1, room2)) {
          // Move rooms apart
          const separation = this.calculateSeparation(room1, room2);
          room2.position.x += separation.x;
          room2.position.y += separation.y;
          room2.position.z += separation.z;
          resolved.add(room2.id);
        }
      }
    }
    
    if (resolved.size > 0) {
      console.log(`🔧 Resolved ${resolved.size} collisions`);
    }
  }

  private checkCollision(room1: Room, room2: Room): boolean {
    // Check if rooms are on the same floor
    if (Math.abs(room1.floor - room2.floor) > 0) {
      return false;
    }
    
    // AABB collision detection
    return !(
      room1.position.x + room1.dimensions.width < room2.position.x ||
      room2.position.x + room2.dimensions.width < room1.position.x ||
      room1.position.y + room1.dimensions.height < room2.position.y ||
      room2.position.y + room2.dimensions.height < room1.position.y ||
      room1.position.z + room1.dimensions.depth < room2.position.z ||
      room2.position.z + room2.dimensions.depth < room1.position.z
    );
  }

  private calculateSeparation(room1: Room, room2: Room): SpatialPosition {
    const center1 = {
      x: room1.position.x + room1.dimensions.width / 2,
      y: room1.position.y + room1.dimensions.height / 2,
      z: room1.position.z + room1.dimensions.depth / 2
    };
    
    const center2 = {
      x: room2.position.x + room2.dimensions.width / 2,
      y: room2.position.y + room2.dimensions.height / 2,
      z: room2.position.z + room2.dimensions.depth / 2
    };
    
    const dx = center2.x - center1.x;
    const dy = center2.y - center1.y;
    const dz = center2.z - center1.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    
    if (distance === 0) {
      // Rooms are at the same position, move randomly
      return { x: 10, y: 0, z: 10 };
    }
    
    const minDistance = Math.max(
      room1.dimensions.width + room2.dimensions.width,
      room1.dimensions.depth + room2.dimensions.depth
    ) / 2 + 2; // Add spacing
    
    const scale = (minDistance - distance) / distance;
    
    return {
      x: dx * scale,
      y: dy * scale,
      z: dz * scale
    };
  }

  private buildSpatialIndex(blueprint: SpatialBlueprint): void {
    if (!this.spatialIndex) return;
    
    // Index all rooms
    for (const room of blueprint.rooms) {
      this.spatialIndex.insert({
        id: room.id,
        type: 'room',
        bounds: {
          min: room.position,
          max: {
            x: room.position.x + room.dimensions.width,
            y: room.position.y + room.dimensions.height,
            z: room.position.z + room.dimensions.depth
          }
        },
        data: room
      });
    }
    
    // Index all buildings
    for (const building of blueprint.buildings) {
      this.spatialIndex.insert({
        id: building.id,
        type: 'building',
        bounds: {
          min: building.position,
          max: {
            x: building.position.x + building.dimensions.width,
            y: building.position.y + building.dimensions.height,
            z: building.position.z + building.dimensions.depth
          }
        },
        data: building
      });
    }
    
    this.metrics.indexSize = this.spatialIndex.size();
  }

  private snapToGrid(position: SpatialPosition, gridSize: number = 1): SpatialPosition {
    return {
      x: Math.round(position.x / gridSize) * gridSize,
      y: Math.round(position.y / gridSize) * gridSize,
      z: Math.round(position.z / gridSize) * gridSize
    };
  }

  private updateMetrics(blueprint: SpatialBlueprint, transformationTime: number): void {
    this.metrics.transformationTime = transformationTime;
    this.metrics.totalElements = 
      blueprint.rooms.length + 
      blueprint.buildings.length + 
      blueprint.hallways.length + 
      blueprint.pathways.length;
    this.metrics.spatialComplexity = blueprint.metadata.spatialComplexity;
    this.metrics.memoryUsage = this.estimateMemoryUsage(blueprint);
  }

  private estimateMemoryUsage(blueprint: SpatialBlueprint): number {
    // Rough estimation of memory usage in KB
    const roomSize = 200; // bytes per room
    const buildingSize = 500; // bytes per building
    const pathSize = 100; // bytes per path
    
    return Math.round(
      (blueprint.rooms.length * roomSize +
       blueprint.buildings.length * buildingSize +
       (blueprint.hallways.length + blueprint.pathways.length) * pathSize) / 1024
    );
  }

  // Public API methods

  getCurrentBlueprint(): SpatialBlueprint | null {
    return this.currentBlueprint;
  }

  getMetrics(): SpatialEngineMetrics {
    return { ...this.metrics };
  }

  getAnimations(): Animation[] {
    return [...this.animations];
  }

  applyRealTimeUpdate(update: RealTimeUpdate): void {
    if (!this.currentBlueprint || !this.options.enableRealTimeUpdates) {
      return;
    }

    switch (update.type) {
      case 'traffic':
        this.updateTrafficFlow(update.targetId, update.data);
        break;
      case 'alert':
        this.addAlert(update.targetId, update.data);
        break;
      case 'metric':
        this.updateMetric(update.targetId, update.data);
        break;
      case 'position':
        this.updatePosition(update.targetId, update.data);
        break;
    }
  }

  private updateTrafficFlow(flowId: string, data: any): void {
    if (!this.currentBlueprint) return;
    
    const flow = this.currentBlueprint.trafficFlows.find(f => f.id === flowId);
    if (flow) {
      flow.intensity = data.intensity || flow.intensity;
      flow.congestion = data.congestion || flow.congestion;
      flow.avgSpeed = data.avgSpeed || flow.avgSpeed;
    }
  }

  private addAlert(targetId: string, alertData: any): void {
    if (!this.currentBlueprint) return;
    
    const room = this.currentBlueprint.rooms.find(r => r.id === targetId);
    if (room) {
      const alert: Alert = {
        id: `alert_${Date.now()}`,
        severity: alertData.severity || 'info',
        message: alertData.message,
        timestamp: new Date(),
        location: room.position,
        roomId: room.id
      };
      
      room.metadata.alerts = room.metadata.alerts || [];
      room.metadata.alerts.push(alert);
    }
  }

  private updateMetric(targetId: string, metricData: any): void {
    if (!this.currentBlueprint) return;
    
    const room = this.currentBlueprint.rooms.find(r => r.id === targetId);
    if (room) {
      room.metadata.temperature = metricData.temperature || room.metadata.temperature;
      room.metadata.complexity = metricData.complexity || room.metadata.complexity;
    }
  }

  private updatePosition(targetId: string, position: SpatialPosition): void {
    if (!this.currentBlueprint) return;
    
    // Find and update vehicle position
    for (const flow of this.currentBlueprint.trafficFlows) {
      const vehicle = flow.vehicles.find(v => v.id === targetId);
      if (vehicle) {
        vehicle.position = position;
        break;
      }
    }
  }

  queryElementsInRegion(bounds: SpatialBounds): Array<Room | Building> {
    if (!this.spatialIndex || !this.currentBlueprint) {
      return [];
    }
    
    const items = this.spatialIndex.query(bounds);
    return items.map(item => item.data);
  }

  findNearestElement(position: SpatialPosition, type?: 'room' | 'building'): any {
    if (!this.spatialIndex || !this.currentBlueprint) {
      return null;
    }
    
    const searchRadius = 100;
    const searchBounds: SpatialBounds = {
      min: {
        x: position.x - searchRadius,
        y: position.y - searchRadius,
        z: position.z - searchRadius
      },
      max: {
        x: position.x + searchRadius,
        y: position.y + searchRadius,
        z: position.z + searchRadius
      }
    };
    
    const items = this.spatialIndex.query(searchBounds);
    let nearest = null;
    let minDistance = Infinity;
    
    for (const item of items) {
      if (type && item.type !== type) continue;
      
      const distance = this.calculateDistance(position, item.data.position);
      if (distance < minDistance) {
        minDistance = distance;
        nearest = item.data;
      }
    }
    
    return nearest;
  }

  private calculateDistance(pos1: SpatialPosition, pos2: SpatialPosition): number {
    return Math.sqrt(
      Math.pow(pos2.x - pos1.x, 2) +
      Math.pow(pos2.y - pos1.y, 2) +
      Math.pow(pos2.z - pos1.z, 2)
    );
  }

  getNavigationPath(fromId: string, toId: string): NavigationPath | null {
    if (!this.currentBlueprint) return null;
    
    return this.currentBlueprint.navigationPaths.find(path => {
      const waypoints = path.waypoints;
      if (waypoints.length < 2) return false;
      
      const start = waypoints[0];
      const end = waypoints[waypoints.length - 1];
      
      return (start.roomId === fromId && end.roomId === toId) ||
             (start.roomId === toId && end.roomId === fromId);
    }) || null;
  }

  registerWebSocketHandler(event: string, handler: (data: any) => void): void {
    this.webSocketHandlers.set(event, handler);
  }

  processWebSocketMessage(event: string, data: any): void {
    const handler = this.webSocketHandlers.get(event);
    if (handler) {
      handler(data);
      
      // Apply real-time updates if applicable
      if (event.startsWith('traffic.')) {
        this.applyRealTimeUpdate({
          type: 'traffic',
          targetId: data.id,
          data,
          timestamp: new Date()
        });
      } else if (event.startsWith('alert.')) {
        this.applyRealTimeUpdate({
          type: 'alert',
          targetId: data.targetId,
          data,
          timestamp: new Date()
        });
      }
    }
  }

  exportToGLTF(): any {
    // Export spatial blueprint to GLTF format for 3D rendering
    // This would be implemented with actual GLTF generation logic
    if (!this.currentBlueprint) return null;
    
    return {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [] }],
      nodes: [],
      meshes: [],
      materials: [],
      textures: []
    };
  }

  dispose(): void {
    this.currentBlueprint = null;
    this.animations = [];
    this.updateQueue = [];
    this.webSocketHandlers.clear();
    if (this.spatialIndex) {
      this.spatialIndex.clear();
    }
  }
}

// Simple R-tree implementation for spatial indexing
class RTreeIndex {
  private root: SpatialNode;
  private items: Map<string, SpatialItem>;
  private maxItems: number = 9;
  private minItems: number = 4;

  constructor() {
    this.root = this.createNode();
    this.items = new Map();
  }

  insert(item: SpatialItem): void {
    this.items.set(item.id, item);
    this.insertIntoNode(this.root, item);
  }

  query(bounds: SpatialBounds): SpatialItem[] {
    return this.queryNode(this.root, bounds);
  }

  size(): number {
    return this.items.size;
  }

  clear(): void {
    this.root = this.createNode();
    this.items.clear();
  }

  private createNode(): SpatialNode {
    return {
      bounds: {
        min: { x: Infinity, y: Infinity, z: Infinity },
        max: { x: -Infinity, y: -Infinity, z: -Infinity }
      },
      items: [],
      children: undefined,
      leaf: true
    };
  }

  private insertIntoNode(node: SpatialNode, item: SpatialItem): void {
    this.expandBounds(node.bounds, item.bounds);

    if (node.leaf) {
      node.items.push(item);
      
      if (node.items.length > this.maxItems) {
        this.splitNode(node);
      }
    } else {
      // Insert into best child
      let bestChild = node.children![0];
      let minExpansion = Infinity;
      
      for (const child of node.children!) {
        const expansion = this.calculateExpansion(child.bounds, item.bounds);
        if (expansion < minExpansion) {
          minExpansion = expansion;
          bestChild = child;
        }
      }
      
      this.insertIntoNode(bestChild, item);
    }
  }

  private splitNode(node: SpatialNode): void {
    if (node.items.length <= this.maxItems) return;

    // Convert to non-leaf node
    node.leaf = false;
    node.children = [];

    // Sort items by x-coordinate and split
    const sorted = [...node.items].sort((a, b) => 
      a.bounds.min.x - b.bounds.min.x
    );

    const mid = Math.floor(sorted.length / 2);
    
    const child1 = this.createNode();
    const child2 = this.createNode();
    
    child1.items = sorted.slice(0, mid);
    child2.items = sorted.slice(mid);
    
    // Recalculate bounds
    for (const item of child1.items) {
      this.expandBounds(child1.bounds, item.bounds);
    }
    for (const item of child2.items) {
      this.expandBounds(child2.bounds, item.bounds);
    }
    
    node.children = [child1, child2];
    node.items = [];
  }

  private queryNode(node: SpatialNode, bounds: SpatialBounds): SpatialItem[] {
    const results: SpatialItem[] = [];

    if (!this.boundsIntersect(node.bounds, bounds)) {
      return results;
    }

    if (node.leaf) {
      for (const item of node.items) {
        if (this.boundsIntersect(item.bounds, bounds)) {
          results.push(item);
        }
      }
    } else if (node.children) {
      for (const child of node.children) {
        results.push(...this.queryNode(child, bounds));
      }
    }

    return results;
  }

  private expandBounds(target: SpatialBounds, source: SpatialBounds): void {
    target.min.x = Math.min(target.min.x, source.min.x);
    target.min.y = Math.min(target.min.y, source.min.y);
    target.min.z = Math.min(target.min.z, source.min.z);
    target.max.x = Math.max(target.max.x, source.max.x);
    target.max.y = Math.max(target.max.y, source.max.y);
    target.max.z = Math.max(target.max.z, source.max.z);
  }

  private boundsIntersect(a: SpatialBounds, b: SpatialBounds): boolean {
    return !(
      a.max.x < b.min.x || a.min.x > b.max.x ||
      a.max.y < b.min.y || a.min.y > b.max.y ||
      a.max.z < b.min.z || a.min.z > b.max.z
    );
  }

  private calculateExpansion(existing: SpatialBounds, newBounds: SpatialBounds): number {
    const expandedVolume = 
      Math.max(existing.max.x, newBounds.max.x) - Math.min(existing.min.x, newBounds.min.x) *
      Math.max(existing.max.y, newBounds.max.y) - Math.min(existing.min.y, newBounds.min.y) *
      Math.max(existing.max.z, newBounds.max.z) - Math.min(existing.min.z, newBounds.min.z);
    
    const existingVolume = 
      (existing.max.x - existing.min.x) *
      (existing.max.y - existing.min.y) *
      (existing.max.z - existing.min.z);
    
    return expandedVolume - existingVolume;
  }
}

// Export main class and types
export {
  SpatialLayoutEngine as default,
  SpatialBlueprint,
  Room,
  Building,
  NavigationPath,
  TrafficFlow,
  Animation
};