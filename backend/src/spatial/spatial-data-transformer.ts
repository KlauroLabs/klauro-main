import {
  ArchitectureBlueprint,
  ComponentNode,
  Connection,
  EntryPoint,
  ExitPoint,
  CallGraph
} from '../types';
import {
  SpatialBlueprint,
  Building,
  Room,
  Hallway,
  Pathway,
  NavigationPath,
  TrafficFlow,
  Vehicle,
  SpatialPosition,
  SpatialBounds,
  SpatialMetadata,
  LayoutInfo,
  RenderingHints,
  Viewpoint,
  Campus,
  District,
  Waypoint,
  TrafficPattern,
  Visitor,
  Alert,
  ComponentToSpatialMapping,
  Animation
} from './spatial-types';
import { MetaphorMapper } from './metaphor-mapper';
import { LayoutAlgorithmFactory } from './layout-algorithms';

export class SpatialDataTransformer {
  private metaphorMapper: MetaphorMapper;
  private componentMappings: Map<string, ComponentToSpatialMapping>;
  private spatialIndex: Map<string, any>;
  private idCounter: number = 0;

  constructor() {
    this.metaphorMapper = new MetaphorMapper();
    this.componentMappings = new Map();
    this.spatialIndex = new Map();
  }

  async transformBlueprint(blueprint: ArchitectureBlueprint): Promise<SpatialBlueprint> {
    console.log('🏗️ Transforming architecture blueprint to spatial layout...');

    // Detect project type and select appropriate layout algorithm
    const projectType = LayoutAlgorithmFactory.detectProjectType(blueprint.components);
    const layoutAlgorithm = LayoutAlgorithmFactory.createAlgorithm(projectType);

    console.log(`📐 Using ${projectType} layout algorithm`);

    // Generate base spatial layout
    const layout = layoutAlgorithm.generateLayout(
      blueprint.components,
      blueprint.connections
    );

    // Enhance rooms with metaphor mapping
    const enhancedRooms = this.enhanceRooms(layout.rooms, blueprint.components);

    // Generate navigation paths for user journeys
    const navigationPaths = this.generateNavigationPaths(
      blueprint.entryPoints,
      blueprint.exitPoints,
      enhancedRooms,
      layout.hallways
    );

    // Create traffic flows from real-time data
    const trafficFlows = this.generateTrafficFlows(
      blueprint.connections,
      layout.hallways,
      layout.pathways
    );

    // Create campus if multiple buildings
    const campus = layout.buildings.length > 1 
      ? this.createCampus(layout.buildings, layout.pathways)
      : undefined;

    // Generate viewpoints for optimal viewing angles
    const viewpoints = this.generateViewpoints(layout.bounds, layout.buildings);

    // Create spatial metadata
    const metadata = this.generateSpatialMetadata(
      blueprint,
      layout,
      projectType
    );

    // Create layout info
    const layoutInfo = this.generateLayoutInfo(
      projectType,
      layout.buildings,
      layout.rooms
    );

    // Create the spatial blueprint
    const spatialBlueprint: SpatialBlueprint = {
      id: this.generateId('blueprint'),
      projectName: blueprint.projectName,
      timestamp: new Date(),
      campus,
      buildings: layout.buildings,
      rooms: enhancedRooms,
      hallways: layout.hallways,
      pathways: layout.pathways,
      navigationPaths,
      trafficFlows,
      bounds: layout.bounds,
      metadata,
      layout: layoutInfo,
      viewpoints
    };

    // Store component mappings for future reference
    this.storeComponentMappings(blueprint.components, spatialBlueprint);

    // Build spatial index for efficient queries
    this.buildSpatialIndex(spatialBlueprint);

    console.log(`✅ Spatial transformation complete: ${spatialBlueprint.buildings.length} buildings, ${spatialBlueprint.rooms.length} rooms`);

    return spatialBlueprint;
  }

  private enhanceRooms(rooms: Room[], components: ComponentNode[]): Room[] {
    return rooms.map(room => {
      const component = components.find(c => c.id === room.componentId);
      if (!component) return room;

      // Map component to room type using metaphor mapper
      room.type = this.metaphorMapper.mapComponentToRoomType(component);

      // Calculate room importance and adjust style
      const importance = this.metaphorMapper.calculateRoomImportance(component);
      room.style.color = this.metaphorMapper.suggestRoomColor(room.type, importance);

      // Add activity heat based on component metrics
      if (component.metrics) {
        room.metadata.temperature = this.calculateActivityHeat(component.metrics);
      }

      // Generate room description
      const description = this.metaphorMapper.generateRoomDescription(component, room.type);
      room.metadata.tags = room.metadata.tags || [];
      room.metadata.tags.push(description);

      // Add alerts for high-risk components
      if (component.metadata.complexity > 8) {
        room.metadata.alerts = room.metadata.alerts || [];
        room.metadata.alerts.push({
          id: this.generateId('alert'),
          severity: 'warning',
          message: 'High complexity detected',
          timestamp: new Date(),
          location: room.position,
          roomId: room.id
        });
      }

      return room;
    });
  }

  private generateNavigationPaths(
    entryPoints: EntryPoint[],
    exitPoints: ExitPoint[],
    rooms: Room[],
    hallways: Hallway[]
  ): NavigationPath[] {
    const paths: NavigationPath[] = [];

    // Create main user journeys from entry to exit points
    for (const entry of entryPoints) {
      for (const exit of exitPoints) {
        const entryRoom = rooms.find(r => r.componentId === entry.componentId);
        const exitRoom = rooms.find(r => r.componentId === exit.componentId);

        if (entryRoom && exitRoom) {
          const path = this.findPathBetweenRooms(entryRoom, exitRoom, rooms, hallways);
          if (path) {
            paths.push({
              id: this.generateId('nav_path'),
              name: `${entry.description} → ${exit.description}`,
              description: `Journey from ${entry.type} to ${exit.type}`,
              waypoints: path,
              totalDistance: this.calculatePathDistance(path),
              estimatedTime: this.estimatePathTime(path),
              difficulty: this.assessPathComplexity(path),
              type: 'user-journey'
            });
          }
        }
      }
    }

    // Create data flow paths
    const dataFlowPaths = this.generateDataFlowPaths(rooms, hallways);
    paths.push(...dataFlowPaths);

    return paths;
  }

  private findPathBetweenRooms(
    startRoom: Room,
    endRoom: Room,
    allRooms: Room[],
    hallways: Hallway[]
  ): Waypoint[] | null {
    // Simple pathfinding using hallway connections
    const visited = new Set<string>();
    const queue: Array<{ room: Room; path: Waypoint[] }> = [{
      room: startRoom,
      path: [{
        position: startRoom.position,
        roomId: startRoom.id,
        floor: startRoom.floor,
        label: startRoom.name
      }]
    }];

    while (queue.length > 0) {
      const { room, path } = queue.shift()!;
      
      if (room.id === endRoom.id) {
        return path;
      }

      if (visited.has(room.id)) continue;
      visited.add(room.id);

      // Find connected rooms via hallways
      const connections = hallways.filter(h => 
        h.sourceRoom === room.id || h.targetRoom === room.id
      );

      for (const hallway of connections) {
        const nextRoomId = hallway.sourceRoom === room.id 
          ? hallway.targetRoom 
          : hallway.sourceRoom;
        
        const nextRoom = allRooms.find(r => r.id === nextRoomId);
        if (nextRoom && !visited.has(nextRoom.id)) {
          const waypoint: Waypoint = {
            position: nextRoom.position,
            roomId: nextRoom.id,
            floor: nextRoom.floor,
            label: nextRoom.name
          };
          queue.push({
            room: nextRoom,
            path: [...path, waypoint]
          });
        }
      }
    }

    return null;
  }

  private calculatePathDistance(waypoints: Waypoint[]): number {
    let distance = 0;
    for (let i = 1; i < waypoints.length; i++) {
      const prev = waypoints[i - 1].position;
      const curr = waypoints[i].position;
      distance += Math.sqrt(
        Math.pow(curr.x - prev.x, 2) +
        Math.pow(curr.y - prev.y, 2) +
        Math.pow(curr.z - prev.z, 2)
      );
    }
    return distance;
  }

  private estimatePathTime(waypoints: Waypoint[]): number {
    // Estimate time based on distance and floor changes
    const distance = this.calculatePathDistance(waypoints);
    let floorChanges = 0;
    
    for (let i = 1; i < waypoints.length; i++) {
      if (waypoints[i].floor !== waypoints[i - 1].floor) {
        floorChanges++;
      }
    }

    // Base speed + penalty for floor changes
    return distance / 10 + floorChanges * 5;
  }

  private assessPathComplexity(waypoints: Waypoint[]): 'easy' | 'moderate' | 'complex' {
    if (waypoints.length <= 3) return 'easy';
    if (waypoints.length <= 7) return 'moderate';
    return 'complex';
  }

  private generateDataFlowPaths(rooms: Room[], hallways: Hallway[]): NavigationPath[] {
    const paths: NavigationPath[] = [];

    // Find rooms involved in data operations
    const dataRooms = rooms.filter(r => 
      r.type === 'storage' || r.type === 'processing'
    );

    // Create paths between data rooms
    for (let i = 0; i < dataRooms.length - 1; i++) {
      for (let j = i + 1; j < dataRooms.length; j++) {
        const path = this.findPathBetweenRooms(
          dataRooms[i],
          dataRooms[j],
          rooms,
          hallways
        );

        if (path && path.length > 0) {
          paths.push({
            id: this.generateId('data_flow'),
            name: `Data: ${dataRooms[i].name} ↔ ${dataRooms[j].name}`,
            description: 'Data flow path',
            waypoints: path,
            totalDistance: this.calculatePathDistance(path),
            type: 'data-flow'
          });
        }
      }
    }

    return paths;
  }

  private generateTrafficFlows(
    connections: Connection[],
    hallways: Hallway[],
    pathways: Pathway[]
  ): TrafficFlow[] {
    const flows: TrafficFlow[] = [];

    // Generate traffic for hallways
    for (const hallway of hallways) {
      const relatedConnections = connections.filter(c =>
        (c.from === hallway.sourceRoom || c.to === hallway.targetRoom)
      );

      const intensity = this.metaphorMapper.determineTrafficIntensity(
        relatedConnections.length
      );

      const vehicles = this.generateVehicles(relatedConnections, hallway.path);

      flows.push({
        id: this.generateId('traffic'),
        intensity,
        direction: 'bidirectional',
        vehicles,
        congestion: intensity > 70 ? (intensity - 70) / 30 : 0,
        avgSpeed: 100 - intensity,
        pattern: this.detectTrafficPattern(relatedConnections)
      });

      hallway.traffic = flows[flows.length - 1];
    }

    // Generate traffic for pathways
    for (const pathway of pathways) {
      const intensity = Math.random() * 50 + 25; // Simulate inter-building traffic

      flows.push({
        id: this.generateId('traffic'),
        intensity,
        direction: pathway.bidirectional ? 'bidirectional' : 'unidirectional',
        vehicles: [],
        avgSpeed: 80,
        pattern: {
          type: 'periodic',
          averageVolume: intensity,
          maxVolume: intensity * 1.5
        }
      });

      pathway.traffic = flows[flows.length - 1];
    }

    return flows;
  }

  private generateVehicles(connections: Connection[], path: SpatialPosition[]): Vehicle[] {
    const vehicles: Vehicle[] = [];

    for (const connection of connections.slice(0, 5)) { // Limit vehicles for performance
      vehicles.push({
        id: this.generateId('vehicle'),
        type: this.mapConnectionToVehicleType(connection),
        position: path[0],
        destination: path[path.length - 1],
        path,
        speed: Math.random() * 50 + 50,
        status: 'moving',
        payload: {
          connectionType: connection.type,
          metadata: connection.metadata
        }
      });
    }

    return vehicles;
  }

  private mapConnectionToVehicleType(connection: Connection): Vehicle['type'] {
    const typeMap: Record<string, Vehicle['type']> = {
      'http_call': 'request',
      'database': 'data-packet',
      'message_queue': 'message',
      'function_call': 'process',
      'api-call': 'request',
      'data_flow': 'data-packet'
    };
    return typeMap[connection.type] || 'process';
  }

  private detectTrafficPattern(connections: Connection[]): TrafficPattern {
    const totalWeight = connections.reduce((sum, c) => sum + (c.weight || 1), 0);
    const avgWeight = totalWeight / connections.length;

    return {
      type: avgWeight > 50 ? 'constant' : 'burst',
      averageVolume: avgWeight,
      maxVolume: Math.max(...connections.map(c => c.weight || 1))
    };
  }

  private createCampus(buildings: Building[], pathways: Pathway[]): Campus {
    // Group buildings into districts
    const districts = this.createDistricts(buildings);

    const bounds = this.calculateCampusBounds(buildings);

    return {
      id: this.generateId('campus'),
      name: 'System Campus',
      type: buildings.length > 5 ? 'microservices' : 'hybrid',
      buildings: buildings.map(b => b.id),
      districts,
      roads: pathways,
      bounds,
      metadata: {
        totalBuildings: buildings.length,
        totalRooms: buildings.reduce((sum, b) => sum + b.rooms.length, 0),
        totalConnections: pathways.length,
        technology: [...new Set(buildings.map(b => b.metadata.technology))],
        health: this.assessCampusHealth(buildings)
      }
    };
  }

  private createDistricts(buildings: Building[]): District[] {
    const districts: District[] = [];
    
    // Group buildings by type
    const buildingsByType = new Map<string, Building[]>();
    for (const building of buildings) {
      const type = building.type;
      if (!buildingsByType.has(type)) {
        buildingsByType.set(type, []);
      }
      buildingsByType.get(type)!.push(building);
    }

    // Create district for each type
    for (const [type, districtBuildings] of buildingsByType.entries()) {
      const bounds = this.calculateCampusBounds(districtBuildings);
      
      districts.push({
        id: this.generateId('district'),
        name: `${type} District`,
        type: this.mapBuildingTypeToDistrictType(type as any),
        buildings: districtBuildings.map(b => b.id),
        bounds,
        zoning: {
          maxBuildingHeight: 50,
          minSpacing: 5,
          allowedBuildingTypes: [type as any]
        }
      });
    }

    return districts;
  }

  private mapBuildingTypeToDistrictType(buildingType: string): District['type'] {
    const mapping: Record<string, District['type']> = {
      'web-app': 'business',
      'api-service': 'business',
      'microservice': 'business',
      'database': 'data',
      'library': 'infrastructure',
      'gateway': 'external',
      'message-broker': 'infrastructure',
      'cache-store': 'data'
    };
    return mapping[buildingType] || 'infrastructure';
  }

  private calculateCampusBounds(buildings: Building[]): SpatialBounds {
    if (buildings.length === 0) {
      return {
        min: { x: 0, y: 0, z: 0 },
        max: { x: 0, y: 0, z: 0 }
      };
    }

    const positions: SpatialPosition[] = [];
    for (const building of buildings) {
      positions.push(building.position);
      positions.push({
        x: building.position.x + building.dimensions.width,
        y: building.position.y + building.dimensions.height,
        z: building.position.z + building.dimensions.depth
      });
    }

    const min = { ...positions[0] };
    const max = { ...positions[0] };

    for (const pos of positions) {
      min.x = Math.min(min.x, pos.x);
      min.y = Math.min(min.y, pos.y);
      min.z = Math.min(min.z, pos.z);
      max.x = Math.max(max.x, pos.x);
      max.y = Math.max(max.y, pos.y);
      max.z = Math.max(max.z, pos.z);
    }

    return { min, max };
  }

  private assessCampusHealth(buildings: Building[]): Campus['metadata']['health'] {
    const healthScores = buildings.map(b => {
      switch (b.metadata.health) {
        case 'healthy': return 3;
        case 'degraded': return 2;
        case 'critical': return 1;
        case 'offline': return 0;
        default: return 2;
      }
    });

    const avgScore = healthScores.reduce((a: number, b: number) => a + b, 0) / healthScores.length;
    
    if (avgScore >= 2.5) return 'healthy';
    if (avgScore >= 1.5) return 'degraded';
    return 'critical';
  }

  private generateViewpoints(bounds: SpatialBounds, buildings: Building[]): Viewpoint[] {
    const viewpoints: Viewpoint[] = [];

    // Overview viewpoint
    const center = {
      x: (bounds.min.x + bounds.max.x) / 2,
      y: (bounds.min.y + bounds.max.y) / 2,
      z: (bounds.min.z + bounds.max.z) / 2
    };

    const distance = Math.max(
      bounds.max.x - bounds.min.x,
      bounds.max.y - bounds.min.y,
      bounds.max.z - bounds.min.z
    ) * 1.5;

    viewpoints.push({
      id: this.generateId('viewpoint'),
      name: 'Overview',
      position: {
        x: center.x + distance,
        y: center.y + distance,
        z: center.z + distance
      },
      target: center,
      fov: 60,
      type: 'overview'
    });

    // Building detail viewpoints
    for (const building of buildings.slice(0, 5)) { // Limit to first 5 buildings
      viewpoints.push({
        id: this.generateId('viewpoint'),
        name: `${building.name} View`,
        position: {
          x: building.position.x + building.dimensions.width * 1.5,
          y: building.position.y + building.dimensions.height * 0.7,
          z: building.position.z + building.dimensions.depth * 1.5
        },
        target: {
          x: building.position.x + building.dimensions.width / 2,
          y: building.position.y + building.dimensions.height / 2,
          z: building.position.z + building.dimensions.depth / 2
        },
        fov: 45,
        type: 'detail'
      });
    }

    return viewpoints;
  }

  private generateSpatialMetadata(
    blueprint: ArchitectureBlueprint,
    layout: any,
    projectType: string
  ): SpatialMetadata {
    const totalConnections = layout.hallways.length + layout.pathways.length;
    const avgConnectivity = totalConnections / Math.max(layout.rooms.length, 1);

    return {
      totalComponents: blueprint.components.length,
      spatialComplexity: this.calculateSpatialComplexity(layout),
      averageConnectivity: avgConnectivity,
      layoutAlgorithm: projectType,
      renderingHints: {
        defaultView: 'isometric',
        lighting: 'day',
        detailLevel: layout.rooms.length > 100 ? 'medium' : 'high',
        enableShadows: true,
        enableReflections: layout.buildings.some((b: Building) => b.style.material === 'glass'),
        enableParticles: true
      }
    };
  }

  private calculateSpatialComplexity(layout: any): number {
    // Calculate complexity based on number of elements and connections
    const roomComplexity = layout.rooms.length * 1;
    const buildingComplexity = layout.buildings.length * 5;
    const connectionComplexity = (layout.hallways.length + layout.pathways.length) * 0.5;
    
    return Math.min(100, roomComplexity + buildingComplexity + connectionComplexity);
  }

  private generateLayoutInfo(
    projectType: string,
    buildings: Building[],
    rooms: Room[]
  ): LayoutInfo {
    const bounds = this.calculateCampusBounds(buildings);
    const width = bounds.max.x - bounds.min.x;
    const depth = bounds.max.z - bounds.min.z;
    const height = bounds.max.y - bounds.min.y;

    return {
      type: buildings.length > 1 ? 'campus' : 'building',
      algorithm: projectType,
      spacing: {
        width: 5,
        height: 3,
        depth: 5
      },
      grid: {
        cellSize: 10,
        columns: Math.ceil(width / 10),
        rows: Math.ceil(depth / 10),
        layers: Math.ceil(height / 10)
      }
    };
  }

  private calculateActivityHeat(metrics: any): number {
    // Calculate heat based on various metrics
    const complexityHeat = (metrics.complexity || 0) * 10;
    const debtHeat = (metrics.technicalDebt || 0) * 5;
    const duplicateHeat = (metrics.duplicateCode || 0) * 2;
    
    return Math.min(100, complexityHeat + debtHeat + duplicateHeat);
  }

  private storeComponentMappings(
    components: ComponentNode[],
    spatialBlueprint: SpatialBlueprint
  ): void {
    for (const component of components) {
      const room = spatialBlueprint.rooms.find(r => r.componentId === component.id);
      if (room) {
        this.componentMappings.set(component.id, {
          componentId: component.id,
          spatialId: room.id,
          spatialType: 'room',
          transformations: []
        });
      }
    }
  }

  private buildSpatialIndex(spatialBlueprint: SpatialBlueprint): void {
    // Index all spatial elements for efficient queries
    for (const room of spatialBlueprint.rooms) {
      this.spatialIndex.set(room.id, {
        type: 'room',
        element: room,
        bounds: {
          min: room.position,
          max: {
            x: room.position.x + room.dimensions.width,
            y: room.position.y + room.dimensions.height,
            z: room.position.z + room.dimensions.depth
          }
        }
      });
    }

    for (const building of spatialBlueprint.buildings) {
      this.spatialIndex.set(building.id, {
        type: 'building',
        element: building,
        bounds: {
          min: building.position,
          max: {
            x: building.position.x + building.dimensions.width,
            y: building.position.y + building.dimensions.height,
            z: building.position.z + building.dimensions.depth
          }
        }
      });
    }
  }

  private generateId(prefix: string): string {
    return `${prefix}_${Date.now()}_${this.idCounter++}`;
  }

  // Public methods for querying spatial data

  findElementAtPosition(position: SpatialPosition): any {
    for (const [id, indexEntry] of this.spatialIndex.entries()) {
      const bounds = indexEntry.bounds;
      if (position.x >= bounds.min.x && position.x <= bounds.max.x &&
          position.y >= bounds.min.y && position.y <= bounds.max.y &&
          position.z >= bounds.min.z && position.z <= bounds.max.z) {
        return indexEntry.element;
      }
    }
    return null;
  }

  getComponentSpatialMapping(componentId: string): ComponentToSpatialMapping | undefined {
    return this.componentMappings.get(componentId);
  }

  generateAnimations(spatialBlueprint: SpatialBlueprint): Animation[] {
    const animations: Animation[] = [];

    // Animate traffic vehicles
    for (const flow of spatialBlueprint.trafficFlows) {
      for (const vehicle of flow.vehicles) {
        animations.push({
          id: this.generateId('animation'),
          targetId: vehicle.id,
          property: 'position',
          from: vehicle.path[0],
          to: vehicle.path[vehicle.path.length - 1],
          duration: 5000,
          easing: 'linear',
          loop: true
        });
      }
    }

    // Pulse effect for critical rooms
    for (const room of spatialBlueprint.rooms) {
      if (room.metadata.criticality === 'critical') {
        animations.push({
          id: this.generateId('animation'),
          targetId: room.id,
          property: 'opacity',
          from: 0.8,
          to: 1.0,
          duration: 2000,
          easing: 'ease-in-out',
          loop: true,
          autoReverse: true
        });
      }
    }

    return animations;
  }

  updateTrafficFlow(
    spatialBlueprint: SpatialBlueprint,
    realTimeData: any
  ): void {
    // Update traffic flows with real-time data
    for (const flow of spatialBlueprint.trafficFlows) {
      if (realTimeData[flow.id]) {
        flow.intensity = realTimeData[flow.id].intensity || flow.intensity;
        flow.congestion = realTimeData[flow.id].congestion || flow.congestion;
        
        // Update vehicle positions
        for (const vehicle of flow.vehicles) {
          if (realTimeData[flow.id].vehicles?.[vehicle.id]) {
            vehicle.position = realTimeData[flow.id].vehicles[vehicle.id].position;
            vehicle.status = realTimeData[flow.id].vehicles[vehicle.id].status;
          }
        }
      }
    }
  }
}