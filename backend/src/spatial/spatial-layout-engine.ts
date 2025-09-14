import {
  ArchitectureBlueprint,
  ComponentNode,
  Connection,
  CallGraph,
  ComponentType,
  ArchitecturalLayer
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
import { PatternDetectionResult, DetectedPattern, DetectedAntiPattern, PerformanceHotspot } from '../analyzer/patterns/pattern-detector';
import { HierarchicalNavigationService, NavigationHierarchy } from './hierarchical-navigation';

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
  private hierarchicalNav: HierarchicalNavigationService | null = null;
  private patternResults: PatternDetectionResult | null = null;

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
    this.hierarchicalNav = new HierarchicalNavigationService();
    
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

      // Build hierarchical navigation
      if (this.hierarchicalNav) {
        await this.hierarchicalNav.buildHierarchy(
          optimizedBlueprint.components,
          optimizedBlueprint.connections,
          spatialBlueprint
        );
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

    // Create virtual components for external references and validate connections
    const componentIds = new Set(blueprint.components.map(c => c.id));
    const externalRefs = new Set<string>();
    const validConnections: Connection[] = [];
    
    // First pass: identify external references from connections
    for (const connection of blueprint.connections) {
      if (!componentIds.has(connection.from) && this.isExternalComponent(connection.from)) {
        externalRefs.add(connection.from);
      }
      if (!componentIds.has(connection.to) && this.isExternalComponent(connection.to)) {
        externalRefs.add(connection.to);
      }
    }

    // Create virtual components for external references
    for (const externalRef of externalRefs) {
      const virtualComponent = this.createVirtualComponent(externalRef);
      blueprint.components.push(virtualComponent);
      componentIds.add(externalRef);
      console.log(`✅ Created virtual component for external reference: ${externalRef}`);
    }

    // Second pass: filter connections to only include valid ones
    for (const connection of blueprint.connections) {
      if (componentIds.has(connection.from) && componentIds.has(connection.to)) {
        validConnections.push(connection);
      } else {
        console.warn(`⚠️ Filtering invalid connection: ${connection.from} -> ${connection.to}`);
      }
    }

    // Update blueprint with only valid connections
    blueprint.connections = validConnections;
    
    console.log(`📊 Validation complete: ${blueprint.components.length} components, ${blueprint.connections.length} valid connections`);
  }

  private isExternalComponent(componentId: string): boolean {
    // Check if component ID represents an external/virtual component
    const externalPrefixes = ['external_', 'virtual_', 'third_party_', 'system_'];
    const externalTypes = ['external_http', 'external_api', 'external_database', 'external_service', 'filesystem', 'network'];
    
    // Also include common external service patterns
    const commonExternalPatterns = [
      'http_client', 'api_client', 'rest_client', 'web_service',
      'database', 'cache', 'queue', 'pubsub', 'storage'
    ];
    
    return externalPrefixes.some(prefix => componentId.startsWith(prefix)) ||
           externalTypes.includes(componentId) ||
           commonExternalPatterns.some(pattern => componentId.toLowerCase().includes(pattern));
  }

  private createVirtualComponent(externalRef: string): ComponentNode {
    // Map external reference types to component metadata
    const externalComponentMap: Record<string, any> = {
      'external_http': {
        name: 'External HTTP Service',
        type: 'external_api' as ComponentType,
        layer: 'external' as ArchitecturalLayer,
        responsibilities: ['External HTTP communication']
      },
      'external_api': {
        name: 'External API Service',
        type: 'external_api' as ComponentType,
        layer: 'external' as ArchitecturalLayer,
        responsibilities: ['External API integration']
      },
      'external_database': {
        name: 'External Database',
        type: 'database' as ComponentType,
        layer: 'data' as ArchitecturalLayer,
        responsibilities: ['External data storage']
      },
      'filesystem': {
        name: 'File System',
        type: 'external_api' as ComponentType,
        layer: 'external' as ArchitecturalLayer,
        responsibilities: ['File system operations']
      },
      'network': {
        name: 'Network Services',
        type: 'external_api' as ComponentType,
        layer: 'external' as ArchitecturalLayer,
        responsibilities: ['Network communication']
      }
    };

    const config = externalComponentMap[externalRef] || {
      name: `External: ${externalRef}`,
      type: 'external_api' as ComponentType,
      layer: 'external' as ArchitecturalLayer,
      responsibilities: [`External ${externalRef} integration`]
    };

    return {
      id: externalRef,
      name: config.name,
      type: config.type,
      path: `virtual://external/${externalRef}`,
      dependencies: [],
      dependents: [],
      metadata: {
        lineCount: 0,
        complexity: 1,
        lastModified: new Date(),
        exports: [],
        imports: [],
        layer: config.layer,
        responsibilities: config.responsibilities
      },
      metrics: {
        linesOfCode: 0,
        complexity: 1,
        maintainability: 1,
        testCoverage: 0,
        technicalDebt: 0
      }
    };
  }

  private optimizeBlueprint(blueprint: ArchitectureBlueprint): ArchitectureBlueprint {
    if (this.options.optimizationLevel === 'low') {
      return blueprint;
    }

    const optimized = { ...blueprint };

    // Remove duplicate connections (validation already filtered invalid ones)
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

    console.log(`🚀 Optimization complete: ${optimized.components.length} components, ${optimized.connections.length} connections`);
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

  // Pattern Detection Integration

  /**
   * Integrate pattern detection results with spatial visualization
   */
  integratePatternResults(patternResults: PatternDetectionResult): void {
    this.patternResults = patternResults;
    
    if (this.currentBlueprint) {
      this.applyPatternVisualization(patternResults);
    }
  }

  /**
   * Apply pattern detection results to spatial visualization
   */
  private applyPatternVisualization(patternResults: PatternDetectionResult): void {
    if (!this.currentBlueprint) return;

    console.log('🎯 Applying pattern visualization to spatial layout...');

    // Apply detected patterns
    this.visualizeDetectedPatterns(patternResults.patterns);
    
    // Apply anti-patterns with warning indicators
    this.visualizeAntiPatterns(patternResults.antiPatterns);
    
    // Apply architecture type styling
    this.applyArchitectureTypeVisualization(patternResults.architectureType);
    
    console.log(`✅ Applied ${patternResults.patterns.length} patterns and ${patternResults.antiPatterns.length} anti-patterns`);
  }

  /**
   * Visualize detected patterns in spatial layout
   */
  private visualizeDetectedPatterns(patterns: DetectedPattern[]): void {
    for (const pattern of patterns) {
      const patternComponents = this.findRoomsByComponentIds(pattern.components);
      
      if (patternComponents.length > 0) {
        // Add pattern indicators to rooms
        for (const room of patternComponents) {
          if (!room.metadata.patterns) {
            room.metadata.patterns = [];
          }
          
          room.metadata.patterns.push({
            type: pattern.type,
            confidence: pattern.confidence,
            description: pattern.description,
            metadata: pattern.metadata
          });

          // Apply visual styling based on pattern type
          this.applyPatternStyling(room, pattern);
        }

        // Create pattern connections if multiple components
        if (patternComponents.length > 1) {
          this.createPatternConnections(patternComponents, pattern);
        }
      }
    }
  }

  /**
   * Visualize anti-patterns with warning indicators
   */
  private visualizeAntiPatterns(antiPatterns: DetectedAntiPattern[]): void {
    for (const antiPattern of antiPatterns) {
      const affectedComponents = this.findRoomsByComponentIds(antiPattern.components);
      
      for (const room of affectedComponents) {
        // Add anti-pattern alerts
        const alert: Alert = {
          id: `antipattern_${antiPattern.type}_${room.id}`,
          severity: antiPattern.severity === 'critical' ? 'critical' : 
                   antiPattern.severity === 'high' ? 'error' : 
                   antiPattern.severity === 'medium' ? 'warning' : 'info',
          message: antiPattern.description,
          timestamp: new Date(),
          location: room.position,
          roomId: room.id,
          antiPattern: {
            type: antiPattern.type,
            recommendation: antiPattern.recommendation,
            impact: antiPattern.impact
          }
        };

        if (!room.metadata.alerts) {
          room.metadata.alerts = [];
        }
        room.metadata.alerts.push(alert);

        // Apply visual warning styling
        this.applyAntiPatternStyling(room, antiPattern);
      }
    }
  }

  /**
   * Apply architecture type visualization
   */
  private applyArchitectureTypeVisualization(architectureType: string): void {
    if (!this.currentBlueprint) return;

    // Apply global architecture styling
    this.currentBlueprint.metadata.architectureType = architectureType;
    
    // Apply building-level styling based on architecture
    for (const building of this.currentBlueprint.buildings) {
      building.metadata.architectureStyle = architectureType;
      
      // Apply specific styling based on architecture type
      switch (architectureType) {
        case 'microservices':
          building.metadata.style = 'modern-distributed';
          break;
        case 'layered':
          building.metadata.style = 'traditional-layered';
          break;
        case 'event_driven':
          building.metadata.style = 'dynamic-flow';
          break;
        default:
          building.metadata.style = 'standard';
      }
    }
  }

  /**
   * Apply pattern-specific styling to rooms
   */
  private applyPatternStyling(room: Room, pattern: DetectedPattern): void {
    const patternStyles: Record<string, any> = {
      microservices: { 
        borderColor: '#2196F3', 
        backgroundColor: '#E3F2FD',
        icon: '🏗️'
      },
      layered: { 
        borderColor: '#4CAF50', 
        backgroundColor: '#E8F5E8',
        icon: '📚'
      },
      event_driven: { 
        borderColor: '#FF9800', 
        backgroundColor: '#FFF3E0',
        icon: '⚡'
      },
      mvc: { 
        borderColor: '#9C27B0', 
        backgroundColor: '#F3E5F5',
        icon: '🏛️'
      },
      repository: { 
        borderColor: '#607D8B', 
        backgroundColor: '#ECEFF1',
        icon: '🗄️'
      },
      factory: { 
        borderColor: '#795548', 
        backgroundColor: '#EFEBE9',
        icon: '🏭'
      },
      singleton: { 
        borderColor: '#FF5722', 
        backgroundColor: '#FBE9E7',
        icon: '👑'
      },
      observer: { 
        borderColor: '#3F51B5', 
        backgroundColor: '#E8EAF6',
        icon: '👁️'
      },
      strategy: { 
        borderColor: '#009688', 
        backgroundColor: '#E0F2F1',
        icon: '🎯'
      },
      dependency_injection: { 
        borderColor: '#8BC34A', 
        backgroundColor: '#F1F8E9',
        icon: '💉'
      }
    };

    const style = patternStyles[pattern.type] || patternStyles['factory'];
    
    room.metadata.styling = {
      ...room.metadata.styling,
      ...style,
      patternConfidence: pattern.confidence
    };
  }

  /**
   * Apply anti-pattern warning styling to rooms
   */
  private applyAntiPatternStyling(room: Room, antiPattern: DetectedAntiPattern): void {
    const severityStyles = {
      critical: { 
        borderColor: '#D32F2F', 
        backgroundColor: '#FFEBEE',
        pulseAnimation: true,
        icon: '🚨'
      },
      high: { 
        borderColor: '#F57C00', 
        backgroundColor: '#FFF3E0',
        icon: '⚠️'
      },
      medium: { 
        borderColor: '#FBC02D', 
        backgroundColor: '#FFFDE7',
        icon: '⚠️'
      },
      low: { 
        borderColor: '#689F38', 
        backgroundColor: '#F1F8E9',
        icon: '💡'
      }
    };

    const style = severityStyles[antiPattern.severity];
    
    room.metadata.styling = {
      ...room.metadata.styling,
      ...style,
      antiPatternSeverity: antiPattern.severity,
      hasAntiPattern: true
    };

    // Add pulsing animation for critical issues
    if (antiPattern.severity === 'critical') {
      const animation: Animation = {
        id: `antipattern_pulse_${room.id}`,
        type: 'pulse',
        targetId: room.id,
        duration: 2000,
        iterations: -1, // infinite
        properties: {
          scale: { from: 1, to: 1.1 },
          opacity: { from: 0.7, to: 1 }
        },
        easing: 'ease-in-out',
        metadata: {
          reason: 'critical-antipattern',
          antiPatternType: antiPattern.type
        }
      };

      this.animations.push(animation);
    }
  }

  /**
   * Create visual connections between pattern components
   */
  private createPatternConnections(rooms: Room[], pattern: DetectedPattern): void {
    if (rooms.length < 2) return;

    // Create connections between all pattern components
    for (let i = 0; i < rooms.length - 1; i++) {
      for (let j = i + 1; j < rooms.length; j++) {
        const connectionId = `pattern_${pattern.type}_${rooms[i].id}_${rooms[j].id}`;
        
        // Check if connection already exists in hallways
        const existingConnection = this.currentBlueprint!.hallways.find(h => 
          (h.sourceRoom === rooms[i].id && h.targetRoom === rooms[j].id) ||
          (h.sourceRoom === rooms[j].id && h.targetRoom === rooms[i].id)
        );

        if (existingConnection) {
          // Enhance existing connection
          existingConnection.metadata.patterns = existingConnection.metadata.patterns || [];
          existingConnection.metadata.patterns.push({
            type: pattern.type,
            confidence: pattern.confidence
          });
          
          // Apply pattern styling to hallway
          existingConnection.metadata.styling = {
            ...existingConnection.metadata.styling,
            patternHighlight: true,
            patternType: pattern.type,
            lineStyle: 'dashed',
            color: this.getPatternColor(pattern.type)
          };
        } else {
          // Create new pattern connection
          this.currentBlueprint!.hallways.push({
            id: connectionId,
            sourceRoom: rooms[i].id,
            targetRoom: rooms[j].id,
            path: [rooms[i].position, rooms[j].position],
            width: 2,
            metadata: {
              patterns: [{
                type: pattern.type,
                confidence: pattern.confidence
              }],
              styling: {
                patternHighlight: true,
                patternType: pattern.type,
                lineStyle: 'dashed',
                color: this.getPatternColor(pattern.type),
                opacity: pattern.confidence
              },
              virtual: true, // Indicates this is a pattern connection, not architectural
              patternConnection: true
            }
          });
        }
      }
    }
  }

  /**
   * Find rooms by component IDs
   */
  private findRoomsByComponentIds(componentIds: string[]): Room[] {
    if (!this.currentBlueprint) return [];

    return this.currentBlueprint.rooms.filter(room =>
      componentIds.some(componentId => 
        room.id === componentId || 
        room.metadata.componentIds?.includes(componentId) ||
        room.id.includes(componentId)
      )
    );
  }

  /**
   * Get color for pattern type
   */
  private getPatternColor(patternType: string): string {
    const patternColors: Record<string, string> = {
      microservices: '#2196F3',
      layered: '#4CAF50',
      event_driven: '#FF9800',
      mvc: '#9C27B0',
      repository: '#607D8B',
      factory: '#795548',
      singleton: '#FF5722',
      observer: '#3F51B5',
      strategy: '#009688',
      dependency_injection: '#8BC34A'
    };

    return patternColors[patternType] || '#757575';
  }

  // Hierarchical Navigation Integration

  /**
   * Get hierarchical navigation context
   */
  getNavigationContext(nodeId?: string) {
    if (!this.hierarchicalNav) return null;
    
    const rootNode = nodeId || 'system_root';
    return this.hierarchicalNav.getNavigationContext(rootNode);
  }

  /**
   * Navigate to specific hierarchy node
   */
  navigateToNode(nodeId: string) {
    if (!this.hierarchicalNav) return null;
    
    return this.hierarchicalNav.navigateToNode(nodeId);
  }

  /**
   * Search navigation hierarchy
   */
  searchNavigation(query: string, filter?: any) {
    if (!this.hierarchicalNav) return [];
    
    return this.hierarchicalNav.searchNodes(query, filter);
  }

  /**
   * Get navigation paths between nodes
   */
  getNavigationPaths(fromNodeId: string, toNodeId: string) {
    if (!this.hierarchicalNav) return [];
    
    return this.hierarchicalNav.getNavigationPaths(fromNodeId, toNodeId);
  }

  /**
   * Get pattern detection results
   */
  getPatternResults(): PatternDetectionResult | null {
    return this.patternResults;
  }

  /**
   * Get enhanced spatial blueprint with pattern and navigation data
   */
  getEnhancedBlueprint(): SpatialBlueprint | null {
    if (!this.currentBlueprint) return null;

    // Create enhanced copy with pattern and navigation data
    const enhanced = { ...this.currentBlueprint };
    
    // Add pattern detection summary
    if (this.patternResults) {
      enhanced.metadata.patternDetection = {
        totalPatterns: this.patternResults.patterns.length,
        totalAntiPatterns: this.patternResults.antiPatterns.length,
        architectureType: this.patternResults.architectureType,
        confidenceScore: this.patternResults.confidenceScore,
        recommendations: this.patternResults.recommendations
      };
    }

    // Add navigation statistics
    if (this.hierarchicalNav) {
      enhanced.metadata.navigation = this.hierarchicalNav.getHierarchyStats();
    }

    return enhanced;
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