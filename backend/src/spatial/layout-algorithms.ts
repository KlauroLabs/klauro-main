import {
  SpatialPosition,
  SpatialDimensions,
  SpatialBounds,
  Room,
  Building,
  Floor,
  Hallway,
  Pathway,
  Campus,
  District,
  GridInfo,
  BuildingType,
  FloorType,
  RoomType
} from './spatial-types';
import { ComponentNode, Connection } from '../types';

export abstract class BaseLayoutAlgorithm {
  protected gridSize: number = 10; // Base grid unit
  protected spacing: number = 5; // Minimum spacing between elements
  protected maxBuildingHeight: number = 50;
  protected roomHeight: number = 3;

  abstract generateLayout(components: ComponentNode[], connections: Connection[]): {
    buildings: Building[];
    rooms: Room[];
    hallways: Hallway[];
    pathways: Pathway[];
    bounds: SpatialBounds;
  };

  protected calculateBounds(positions: SpatialPosition[]): SpatialBounds {
    if (positions.length === 0) {
      return {
        min: { x: 0, y: 0, z: 0 },
        max: { x: 0, y: 0, z: 0 }
      };
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

  protected snapToGrid(position: SpatialPosition): SpatialPosition {
    return {
      x: Math.round(position.x / this.gridSize) * this.gridSize,
      y: Math.round(position.y / this.gridSize) * this.gridSize,
      z: Math.round(position.z / this.gridSize) * this.gridSize
    };
  }

  protected checkCollision(
    pos1: SpatialPosition,
    dim1: SpatialDimensions,
    pos2: SpatialPosition,
    dim2: SpatialDimensions
  ): boolean {
    const box1Min = pos1;
    const box1Max = {
      x: pos1.x + dim1.width,
      y: pos1.y + dim1.height,
      z: pos1.z + dim1.depth
    };

    const box2Min = pos2;
    const box2Max = {
      x: pos2.x + dim2.width,
      y: pos2.y + dim2.height,
      z: pos2.z + dim2.depth
    };

    return !(
      box1Max.x < box2Min.x || box1Min.x > box2Max.x ||
      box1Max.y < box2Min.y || box1Min.y > box2Max.y ||
      box1Max.z < box2Min.z || box1Min.z > box2Max.z
    );
  }

  protected generatePathBetweenPoints(
    start: SpatialPosition,
    end: SpatialPosition,
    obstacles: Array<{ position: SpatialPosition; dimensions: SpatialDimensions }>
  ): SpatialPosition[] {
    // Simple A* pathfinding implementation
    const path: SpatialPosition[] = [];
    
    // For now, use simple straight line with waypoints to avoid obstacles
    const segments = 10;
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const point: SpatialPosition = {
        x: start.x + (end.x - start.x) * t,
        y: start.y + (end.y - start.y) * t,
        z: start.z + (end.z - start.z) * t
      };
      
      // Check for collisions and adjust if needed
      for (const obstacle of obstacles) {
        if (this.pointNearObstacle(point, obstacle)) {
          // Route around obstacle
          point.y += obstacle.dimensions.height + this.spacing;
        }
      }
      
      path.push(this.snapToGrid(point));
    }

    return this.smoothPath(path);
  }

  private pointNearObstacle(
    point: SpatialPosition,
    obstacle: { position: SpatialPosition; dimensions: SpatialDimensions }
  ): boolean {
    const margin = this.spacing;
    return (
      point.x >= obstacle.position.x - margin &&
      point.x <= obstacle.position.x + obstacle.dimensions.width + margin &&
      point.y >= obstacle.position.y - margin &&
      point.y <= obstacle.position.y + obstacle.dimensions.height + margin &&
      point.z >= obstacle.position.z - margin &&
      point.z <= obstacle.position.z + obstacle.dimensions.depth + margin
    );
  }

  private smoothPath(path: SpatialPosition[]): SpatialPosition[] {
    if (path.length <= 2) return path;

    const smoothed: SpatialPosition[] = [path[0]];
    
    for (let i = 1; i < path.length - 1; i++) {
      const prev = path[i - 1];
      const curr = path[i];
      const next = path[i + 1];
      
      // Check if point is necessary (not in straight line)
      const dx1 = curr.x - prev.x;
      const dy1 = curr.y - prev.y;
      const dz1 = curr.z - prev.z;
      const dx2 = next.x - curr.x;
      const dy2 = next.y - curr.y;
      const dz2 = next.z - curr.z;
      
      const crossProduct = Math.abs(dx1 * dy2 - dy1 * dx2) + 
                          Math.abs(dy1 * dz2 - dz1 * dy2) + 
                          Math.abs(dz1 * dx2 - dx1 * dz2);
      
      if (crossProduct > 0.01) {
        smoothed.push(curr);
      }
    }
    
    smoothed.push(path[path.length - 1]);
    return smoothed;
  }
}

export class WebAppLayout extends BaseLayoutAlgorithm {
  private floorsPerBuilding: number = 5;
  private roomsPerFloor: number = 20;
  private buildingWidth: number = 60;
  private buildingDepth: number = 40;

  generateLayout(components: ComponentNode[], connections: Connection[]) {
    const buildings: Building[] = [];
    const rooms: Room[] = [];
    const hallways: Hallway[] = [];
    const pathways: Pathway[] = [];

    // Group components by layer for floor assignment
    const componentsByLayer = this.groupComponentsByLayer(components);
    
    // Create main building
    const mainBuilding = this.createMainBuilding(components);
    buildings.push(mainBuilding);

    // Create floors and distribute rooms
    let currentFloor = 0;
    let roomsOnCurrentFloor = 0;
    let currentX = this.spacing;
    let currentZ = this.spacing;

    for (const [layer, layerComponents] of componentsByLayer.entries()) {
      const floor: Floor = {
        level: currentFloor,
        name: `${layer} Floor`,
        rooms: [],
        height: this.roomHeight,
        type: this.mapLayerToFloorType(layer),
        accessibility: 'public'
      };

      mainBuilding.floors.push(floor);

      for (const component of layerComponents) {
        const room = this.createRoomFromComponent(
          component,
          { x: currentX, y: currentFloor * this.roomHeight, z: currentZ },
          currentFloor,
          mainBuilding.id
        );

        rooms.push(room);
        floor.rooms.push(room.id);
        mainBuilding.rooms.push(room.id);

        // Update position for next room
        currentX += room.dimensions.width + this.spacing;
        roomsOnCurrentFloor++;

        if (roomsOnCurrentFloor >= this.roomsPerFloor || 
            currentX + 10 > this.buildingWidth) {
          currentX = this.spacing;
          currentZ += 10 + this.spacing;
          
          if (currentZ + 10 > this.buildingDepth) {
            currentFloor++;
            currentX = this.spacing;
            currentZ = this.spacing;
            roomsOnCurrentFloor = 0;
          }
        }
      }

      currentFloor++;
    }

    // Create hallways for connections
    for (const connection of connections) {
      const sourceRoom = rooms.find(r => r.componentId === connection.from);
      const targetRoom = rooms.find(r => r.componentId === connection.to);

      if (sourceRoom && targetRoom) {
        const hallway = this.createHallway(sourceRoom, targetRoom, rooms);
        hallways.push(hallway);
      }
    }

    const bounds = this.calculateBounds([...buildings.map(b => b.position), ...rooms.map(r => r.position)]);

    return { buildings, rooms, hallways, pathways, bounds };
  }

  private groupComponentsByLayer(components: ComponentNode[]): Map<string, ComponentNode[]> {
    const groups = new Map<string, ComponentNode[]>();

    for (const component of components) {
      const layer = component.metadata.layer || 'infrastructure';
      if (!groups.has(layer)) {
        groups.set(layer, []);
      }
      groups.get(layer)!.push(component);
    }

    // Sort layers by hierarchy
    const sortedGroups = new Map<string, ComponentNode[]>();
    const layerOrder = ['presentation', 'business', 'data', 'infrastructure', 'external'];
    
    for (const layer of layerOrder) {
      if (groups.has(layer)) {
        sortedGroups.set(layer, groups.get(layer)!);
      }
    }

    return sortedGroups;
  }

  private createMainBuilding(components: ComponentNode[]): Building {
    return {
      id: `building_main`,
      name: 'Main Application Building',
      type: 'web-app',
      position: { x: 0, y: 0, z: 0 },
      dimensions: {
        width: this.buildingWidth,
        height: this.floorsPerBuilding * this.roomHeight,
        depth: this.buildingDepth
      },
      floors: [],
      rooms: [],
      entrances: [
        {
          id: 'main_entrance',
          floor: 0,
          position: { x: this.buildingWidth / 2, y: 0, z: 0 },
          type: 'main',
          width: 4,
          height: 3
        }
      ],
      metadata: {
        componentCount: components.length,
        totalLinesOfCode: components.reduce((sum, c) => sum + c.metadata.lineCount, 0),
        technology: 'Web Application',
        health: 'healthy'
      },
      style: {
        material: 'glass',
        color: '#2196F3',
        height: this.floorsPerBuilding * this.roomHeight,
        modernness: 0.8
      }
    };
  }

  private createRoomFromComponent(
    component: ComponentNode,
    position: SpatialPosition,
    floor: number,
    buildingId: string
  ): Room {
    const complexity = component.metadata.complexity || 1;
    const dimensions = this.calculateRoomDimensions(component);

    return {
      id: `room_${component.id}`,
      componentId: component.id,
      name: component.name,
      type: 'processing', // Would be mapped properly
      position: this.snapToGrid(position),
      dimensions,
      floor,
      building: buildingId,
      entrances: [{
        id: `entrance_${component.id}`,
        position: { x: position.x, y: position.y, z: position.z },
        width: 1.5,
        type: 'main',
        accessibility: 'public'
      }],
      exits: [{
        id: `exit_${component.id}`,
        position: { x: position.x + dimensions.width, y: position.y, z: position.z },
        width: 1.5,
        type: 'normal'
      }],
      metadata: {
        complexity,
        linesOfCode: component.metadata.lineCount,
        lastModified: component.metadata.lastModified,
        criticality: this.calculateCriticality(component)
      },
      style: {
        color: this.getComponentColor(component),
        opacity: 0.8
      }
    };
  }

  private calculateRoomDimensions(component: ComponentNode): SpatialDimensions {
    const baseSize = 8;
    const scale = Math.log10(component.metadata.lineCount + 10) / 2;
    
    return {
      width: Math.min(baseSize * scale, 15),
      height: this.roomHeight,
      depth: Math.min(baseSize * scale, 15)
    };
  }

  private calculateCriticality(component: ComponentNode): 'low' | 'medium' | 'high' | 'critical' {
    const score = component.metadata.complexity * 10 + 
                 component.dependents.length * 5 +
                 (component.metadata.isEntry ? 20 : 0);

    if (score > 50) return 'critical';
    if (score > 30) return 'high';
    if (score > 15) return 'medium';
    return 'low';
  }

  private getComponentColor(component: ComponentNode): string {
    const colors: Record<string, string> = {
      'presentation': '#E91E63',
      'business': '#2196F3',
      'data': '#9C27B0',
      'infrastructure': '#607D8B',
      'external': '#00BCD4'
    };
    return colors[component.metadata.layer] || '#9E9E9E';
  }

  private mapLayerToFloorType(layer: string): FloorType {
    const mapping: Record<string, FloorType> = {
      'presentation': 'penthouse',
      'business': 'business',
      'data': 'data',
      'infrastructure': 'infrastructure',
      'external': 'ground'
    };
    return mapping[layer] || 'ground';
  }

  private createHallway(sourceRoom: Room, targetRoom: Room, allRooms: Room[]): Hallway {
    const obstacles = allRooms.map(r => ({
      position: r.position,
      dimensions: r.dimensions
    }));

    const path = this.generatePathBetweenPoints(
      sourceRoom.position,
      targetRoom.position,
      obstacles
    );

    return {
      id: `hallway_${sourceRoom.id}_${targetRoom.id}`,
      type: 'main-corridor',
      path,
      width: 1.5,
      sourceRoom: sourceRoom.id,
      targetRoom: targetRoom.id,
      floor: sourceRoom.floor,
      style: {
        color: '#CCCCCC',
        pattern: 'solid'
      }
    };
  }

  private calculateLayoutBounds(buildings: Building[], rooms: Room[]): SpatialBounds {
    const positions: SpatialPosition[] = [];

    for (const building of buildings) {
      positions.push(building.position);
      positions.push({
        x: building.position.x + building.dimensions.width,
        y: building.position.y + building.dimensions.height,
        z: building.position.z + building.dimensions.depth
      });
    }

    for (const room of rooms) {
      positions.push(room.position);
      positions.push({
        x: room.position.x + room.dimensions.width,
        y: room.position.y + room.dimensions.height,
        z: room.position.z + room.dimensions.depth
      });
    }

    return this.calculateBounds(positions);
  }
}

export class APILayout extends BaseLayoutAlgorithm {
  private entranceHallWidth: number = 30;
  private corridorLength: number = 50;
  private processingRoomSize: number = 12;

  generateLayout(components: ComponentNode[], connections: Connection[]) {
    const buildings: Building[] = [];
    const rooms: Room[] = [];
    const hallways: Hallway[] = [];
    const pathways: Pathway[] = [];

    // Create API Gateway building
    const gatewayBuilding = this.createGatewayBuilding(components);
    buildings.push(gatewayBuilding);

    // Create entrance hall for endpoints
    const entryPoints = components.filter(c => c.metadata.isEntry);
    const entryHall = this.createEntryHall(entryPoints, gatewayBuilding.id);
    rooms.push(entryHall);

    // Create processing corridors
    const processors = components.filter(c => 
      c.type === 'service' || c.type === 'controller'
    );

    let corridorIndex = 0;
    for (const processor of processors) {
      const room = this.createProcessingRoom(
        processor,
        corridorIndex,
        gatewayBuilding.id
      );
      rooms.push(room);

      // Create hallway from entry hall to processing room
      const hallway = this.createProcessingCorridor(
        entryHall,
        room,
        corridorIndex
      );
      hallways.push(hallway);

      corridorIndex++;
    }

    // Create data vaults for storage
    const dataComponents = components.filter(c => 
      c.type === 'model' || c.type === 'database'
    );

    for (const dataComponent of dataComponents) {
      const vault = this.createDataVault(dataComponent, gatewayBuilding.id);
      rooms.push(vault);
    }

    const bounds = this.calculateBounds([...buildings.map(b => b.position), ...rooms.map(r => r.position)]);

    return { buildings, rooms, hallways, pathways, bounds };
  }

  private createGatewayBuilding(components: ComponentNode[]): Building {
    return {
      id: 'api_gateway',
      name: 'API Gateway',
      type: 'gateway',
      position: { x: 0, y: 0, z: 0 },
      dimensions: {
        width: this.entranceHallWidth + this.corridorLength,
        height: 20,
        depth: 40
      },
      floors: [{
        level: 0,
        name: 'Main Floor',
        rooms: [],
        height: 20,
        type: 'ground',
        accessibility: 'public'
      }],
      rooms: [],
      entrances: [{
        id: 'api_main_entrance',
        floor: 0,
        position: { x: 0, y: 0, z: 20 },
        type: 'main',
        width: 8,
        height: 5
      }],
      metadata: {
        componentCount: components.length,
        totalLinesOfCode: components.reduce((sum, c) => sum + c.metadata.lineCount, 0),
        technology: 'API Service',
        health: 'healthy'
      },
      style: {
        material: 'steel',
        color: '#FF9800',
        height: 20,
        modernness: 0.9
      }
    };
  }

  private createEntryHall(entryPoints: ComponentNode[], buildingId: string): Room {
    return {
      id: 'entry_hall',
      componentId: entryPoints[0]?.id || 'main',
      name: 'API Entry Hall',
      type: 'entry-hall',
      position: { x: 0, y: 0, z: 0 },
      dimensions: {
        width: this.entranceHallWidth,
        height: 15,
        depth: 30
      },
      floor: 0,
      building: buildingId,
      entrances: entryPoints.map((ep, i) => ({
        id: `entrance_${ep.id}`,
        position: { x: i * 5, y: 0, z: 0 },
        width: 3,
        type: 'main' as const,
        accessibility: 'public' as const
      })),
      exits: [{
        id: 'hall_exit',
        position: { x: this.entranceHallWidth, y: 0, z: 15 },
        width: 5,
        type: 'normal'
      }],
      metadata: {
        complexity: 1,
        linesOfCode: entryPoints.reduce((sum, ep) => sum + ep.metadata.lineCount, 0),
        lastModified: new Date(),
        criticality: 'critical'
      },
      style: {
        color: '#4CAF50',
        opacity: 0.9,
        emissive: true
      }
    };
  }

  private createProcessingRoom(
    component: ComponentNode,
    index: number,
    buildingId: string
  ): Room {
    const x = this.entranceHallWidth + 10;
    const z = index * (this.processingRoomSize + this.spacing);

    return {
      id: `processing_${component.id}`,
      componentId: component.id,
      name: component.name,
      type: 'processing',
      position: { x, y: 0, z },
      dimensions: {
        width: this.processingRoomSize,
        height: 10,
        depth: this.processingRoomSize
      },
      floor: 0,
      building: buildingId,
      entrances: [{
        id: `proc_entrance_${component.id}`,
        position: { x, y: 0, z: z + this.processingRoomSize / 2 },
        width: 2,
        type: 'service',
        accessibility: 'private'
      }],
      exits: [{
        id: `proc_exit_${component.id}`,
        position: { x: x + this.processingRoomSize, y: 0, z: z + this.processingRoomSize / 2 },
        width: 2,
        type: 'service'
      }],
      metadata: {
        complexity: component.metadata.complexity,
        linesOfCode: component.metadata.lineCount,
        lastModified: component.metadata.lastModified,
        criticality: 'high'
      },
      style: {
        color: '#2196F3',
        opacity: 0.8
      }
    };
  }

  private createProcessingCorridor(
    entryHall: Room,
    processingRoom: Room,
    index: number
  ): Hallway {
    const startPos = {
      x: entryHall.position.x + entryHall.dimensions.width,
      y: 0,
      z: entryHall.position.z + entryHall.dimensions.depth / 2
    };

    const endPos = {
      x: processingRoom.position.x,
      y: 0,
      z: processingRoom.position.z + processingRoom.dimensions.depth / 2
    };

    return {
      id: `corridor_${index}`,
      type: 'main-corridor',
      path: [startPos, endPos],
      width: 2,
      sourceRoom: entryHall.id,
      targetRoom: processingRoom.id,
      floor: 0,
      style: {
        color: '#FFA726',
        pattern: 'solid',
        glowing: true
      }
    };
  }

  private createDataVault(component: ComponentNode, buildingId: string): Room {
    return {
      id: `vault_${component.id}`,
      componentId: component.id,
      name: `${component.name} Vault`,
      type: 'storage',
      position: { x: 60, y: -5, z: 10 },
      dimensions: {
        width: 15,
        height: 8,
        depth: 15
      },
      floor: -1,
      building: buildingId,
      entrances: [{
        id: `vault_entrance_${component.id}`,
        position: { x: 60, y: -5, z: 10 },
        width: 2,
        type: 'service',
        accessibility: 'restricted'
      }],
      exits: [],
      metadata: {
        complexity: component.metadata.complexity,
        linesOfCode: component.metadata.lineCount,
        lastModified: component.metadata.lastModified,
        criticality: 'critical'
      },
      style: {
        color: '#9C27B0',
        opacity: 0.9,
        pattern: 'vault'
      }
    };
  }
}

export class MicroserviceLayout extends BaseLayoutAlgorithm {
  private campusWidth: number = 200;
  private campusDepth: number = 200;
  private buildingSize: number = 30;
  private roadWidth: number = 5;

  generateLayout(components: ComponentNode[], connections: Connection[]) {
    const buildings: Building[] = [];
    const rooms: Room[] = [];
    const hallways: Hallway[] = [];
    const pathways: Pathway[] = [];

    // Group components by service/module
    const services = this.groupComponentsByService(components);
    
    // Create campus layout with districts
    const districts = this.createDistricts(services);
    
    // Place buildings in districts
    let buildingIndex = 0;
    for (const [serviceName, serviceComponents] of services.entries()) {
      const district = districts[buildingIndex % districts.length];
      const building = this.createServiceBuilding(
        serviceName,
        serviceComponents,
        district,
        buildingIndex
      );
      buildings.push(building);

      // Create rooms within building
      const serviceRooms = this.createServiceRooms(serviceComponents, building);
      rooms.push(...serviceRooms);

      buildingIndex++;
    }

    // Create inter-service pathways
    for (const connection of connections) {
      const sourceBuilding = this.findBuildingForComponent(connection.from, buildings, rooms);
      const targetBuilding = this.findBuildingForComponent(connection.to, buildings, rooms);

      if (sourceBuilding && targetBuilding && sourceBuilding.id !== targetBuilding.id) {
        const pathway = this.createInterServicePath(sourceBuilding, targetBuilding);
        pathways.push(pathway);
      }
    }

    const bounds = this.calculateBounds([...buildings.map(b => b.position), ...rooms.map(r => r.position)]);

    return { buildings, rooms, hallways, pathways, bounds };
  }

  private groupComponentsByService(components: ComponentNode[]): Map<string, ComponentNode[]> {
    const services = new Map<string, ComponentNode[]>();

    for (const component of components) {
      // Group by module/service name or path prefix
      const serviceName = this.extractServiceName(component);
      if (!services.has(serviceName)) {
        services.set(serviceName, []);
      }
      services.get(serviceName)!.push(component);
    }

    return services;
  }

  private extractServiceName(component: ComponentNode): string {
    // Extract service name from path or metadata
    const pathParts = component.path.split('/');
    if (pathParts.length > 2) {
      return pathParts[1]; // Assume second part is service name
    }
    return 'default-service';
  }

  private createDistricts(services: Map<string, ComponentNode[]>): District[] {
    return [
      {
        id: 'business-district',
        name: 'Business District',
        type: 'business',
        buildings: [],
        bounds: {
          min: { x: 0, y: 0, z: 0 },
          max: { x: this.campusWidth / 2, y: 50, z: this.campusDepth / 2 }
        }
      },
      {
        id: 'data-district',
        name: 'Data District',
        type: 'data',
        buildings: [],
        bounds: {
          min: { x: this.campusWidth / 2, y: 0, z: 0 },
          max: { x: this.campusWidth, y: 50, z: this.campusDepth / 2 }
        }
      },
      {
        id: 'infrastructure-district',
        name: 'Infrastructure District',
        type: 'infrastructure',
        buildings: [],
        bounds: {
          min: { x: 0, y: 0, z: this.campusDepth / 2 },
          max: { x: this.campusWidth / 2, y: 50, z: this.campusDepth }
        }
      },
      {
        id: 'external-district',
        name: 'External District',
        type: 'external',
        buildings: [],
        bounds: {
          min: { x: this.campusWidth / 2, y: 0, z: this.campusDepth / 2 },
          max: { x: this.campusWidth, y: 50, z: this.campusDepth }
        }
      }
    ];
  }

  private createServiceBuilding(
    serviceName: string,
    components: ComponentNode[],
    district: District,
    index: number
  ): Building {
    const gridX = index % 4;
    const gridZ = Math.floor(index / 4);
    
    const position = {
      x: district.bounds.min.x + gridX * (this.buildingSize + this.roadWidth),
      y: 0,
      z: district.bounds.min.z + gridZ * (this.buildingSize + this.roadWidth)
    };

    return {
      id: `service_${serviceName}`,
      name: serviceName,
      type: 'microservice',
      position,
      dimensions: {
        width: this.buildingSize,
        height: Math.min(15 + components.length * 2, this.maxBuildingHeight),
        depth: this.buildingSize
      },
      floors: this.createServiceFloors(components),
      rooms: [],
      entrances: [{
        id: `entrance_${serviceName}`,
        floor: 0,
        position: { 
          x: position.x + this.buildingSize / 2, 
          y: 0, 
          z: position.z 
        },
        type: 'main',
        width: 3,
        height: 3
      }],
      metadata: {
        componentCount: components.length,
        totalLinesOfCode: components.reduce((sum, c) => sum + c.metadata.lineCount, 0),
        technology: this.detectServiceTechnology(components),
        health: 'healthy'
      },
      style: {
        material: 'concrete',
        color: this.getDistrictColor(district.type),
        height: 15 + components.length * 2,
        modernness: 0.7
      }
    };
  }

  private createServiceFloors(components: ComponentNode[]): Floor[] {
    const floors: Floor[] = [];
    const componentsPerFloor = 5;
    
    for (let i = 0; i < Math.ceil(components.length / componentsPerFloor); i++) {
      floors.push({
        level: i,
        name: `Level ${i + 1}`,
        rooms: [],
        height: this.roomHeight,
        type: i === 0 ? 'ground' : 'business',
        accessibility: 'private'
      });
    }

    return floors;
  }

  private createServiceRooms(components: ComponentNode[], building: Building): Room[] {
    const rooms: Room[] = [];
    const roomsPerFloor = 5;
    
    components.forEach((component, index) => {
      const floor = Math.floor(index / roomsPerFloor);
      const positionInFloor = index % roomsPerFloor;
      
      const room: Room = {
        id: `room_${component.id}`,
        componentId: component.id,
        name: component.name,
        type: 'processing',
        position: {
          x: building.position.x + (positionInFloor % 3) * 10,
          y: floor * this.roomHeight,
          z: building.position.z + Math.floor(positionInFloor / 3) * 10
        },
        dimensions: {
          width: 8,
          height: this.roomHeight,
          depth: 8
        },
        floor,
        building: building.id,
        entrances: [{
          id: `entrance_${component.id}`,
          position: { x: 0, y: 0, z: 0 },
          width: 1.5,
          type: 'main',
          accessibility: 'private'
        }],
        exits: [{
          id: `exit_${component.id}`,
          position: { x: 8, y: 0, z: 0 },
          width: 1.5,
          type: 'normal'
        }],
        metadata: {
          complexity: component.metadata.complexity,
          linesOfCode: component.metadata.lineCount,
          lastModified: component.metadata.lastModified,
          criticality: 'medium'
        },
        style: {
          color: this.getComponentTypeColor(component.type),
          opacity: 0.8
        }
      };

      rooms.push(room);
      building.rooms.push(room.id);
      building.floors[floor].rooms.push(room.id);
    });

    return rooms;
  }

  private createInterServicePath(source: Building, target: Building): Pathway {
    const startPos = {
      x: source.position.x + source.dimensions.width / 2,
      y: 0,
      z: source.position.z + source.dimensions.depth
    };

    const endPos = {
      x: target.position.x + target.dimensions.width / 2,
      y: 0,
      z: target.position.z
    };

    // Create road-like path between buildings
    const path: SpatialPosition[] = [startPos];

    // Add intermediate points for realistic road routing
    if (Math.abs(startPos.x - endPos.x) > this.buildingSize) {
      path.push({
        x: startPos.x,
        y: 0,
        z: startPos.z + this.roadWidth
      });
      path.push({
        x: endPos.x,
        y: 0,
        z: startPos.z + this.roadWidth
      });
    }

    path.push(endPos);

    return {
      id: `path_${source.id}_${target.id}`,
      type: 'road',
      nodes: path.map(p => ({ position: p })),
      width: this.roadWidth,
      bidirectional: true,
      sourceBuilding: source.id,
      targetBuilding: target.id,
      style: {
        color: '#757575',
        pattern: 'solid',
        opacity: 0.8
      }
    };
  }

  private findBuildingForComponent(
    componentId: string,
    buildings: Building[],
    rooms: Room[]
  ): Building | undefined {
    const room = rooms.find(r => r.componentId === componentId);
    if (room && room.building) {
      return buildings.find(b => b.id === room.building);
    }
    return undefined;
  }

  private detectServiceTechnology(components: ComponentNode[]): string {
    // Detect primary technology from components
    const frameworks = components
      .map(c => c.framework)
      .filter(f => f)
      .reduce((acc, f) => {
        acc[f!] = (acc[f!] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

    const topFramework = Object.entries(frameworks)
      .sort(([, a], [, b]) => b - a)[0];

    return topFramework ? topFramework[0] : 'Unknown';
  }

  private getDistrictColor(districtType: string): string {
    const colors: Record<string, string> = {
      'business': '#2196F3',
      'data': '#9C27B0',
      'infrastructure': '#607D8B',
      'external': '#00BCD4'
    };
    return colors[districtType] || '#9E9E9E';
  }

  private getComponentTypeColor(type: string): string {
    const colors: Record<string, string> = {
      'route': '#4CAF50',
      'controller': '#FF9800',
      'service': '#2196F3',
      'model': '#9C27B0',
      'utility': '#607D8B'
    };
    return colors[type] || '#9E9E9E';
  }
}

export class MobileAppLayout extends BaseLayoutAlgorithm {
  private towerWidth: number = 40;
  private towerDepth: number = 40;
  private screenHeight: number = 5;

  generateLayout(components: ComponentNode[], connections: Connection[]) {
    const buildings: Building[] = [];
    const rooms: Room[] = [];
    const hallways: Hallway[] = [];
    const pathways: Pathway[] = [];

    // Create mobile app tower
    const tower = this.createAppTower(components);
    buildings.push(tower);

    // Group components by screen/view hierarchy
    const screens = this.groupComponentsByScreen(components);
    
    // Create floors for each major screen
    let currentFloor = 0;
    for (const [screenName, screenComponents] of screens.entries()) {
      const floor: Floor = {
        level: currentFloor,
        name: screenName,
        rooms: [],
        height: this.screenHeight,
        type: currentFloor === 0 ? 'ground' : 'business',
        accessibility: 'public'
      };

      tower.floors.push(floor);

      // Create rooms for screen components
      const screenRooms = this.createScreenRooms(
        screenComponents,
        currentFloor,
        tower.id
      );
      
      rooms.push(...screenRooms);
      floor.rooms = screenRooms.map(r => r.id);
      tower.rooms.push(...floor.rooms);

      currentFloor++;
    }

    // Create navigation elevators (vertical connections)
    for (const connection of connections) {
      const sourceRoom = rooms.find(r => r.componentId === connection.from);
      const targetRoom = rooms.find(r => r.componentId === connection.to);

      if (sourceRoom && targetRoom && sourceRoom.floor !== targetRoom.floor) {
        // Create elevator shaft representation
        const elevator = this.createElevatorShaft(sourceRoom, targetRoom);
        hallways.push(elevator);
      } else if (sourceRoom && targetRoom) {
        // Same floor navigation
        const corridor = this.createFloorCorridor(sourceRoom, targetRoom);
        hallways.push(corridor);
      }
    }

    const bounds = this.calculateBounds([...buildings.map(b => b.position), ...rooms.map(r => r.position)]);

    return { buildings, rooms, hallways, pathways, bounds };
  }

  private createAppTower(components: ComponentNode[]): Building {
    const screenCount = this.countUniqueScreens(components);
    
    return {
      id: 'mobile_app_tower',
      name: 'Mobile Application Tower',
      type: 'web-app',
      position: { x: 0, y: 0, z: 0 },
      dimensions: {
        width: this.towerWidth,
        height: screenCount * this.screenHeight,
        depth: this.towerDepth
      },
      floors: [],
      rooms: [],
      entrances: [{
        id: 'app_entrance',
        floor: 0,
        position: { x: this.towerWidth / 2, y: 0, z: 0 },
        type: 'main',
        width: 5,
        height: 4
      }],
      metadata: {
        componentCount: components.length,
        totalLinesOfCode: components.reduce((sum, c) => sum + c.metadata.lineCount, 0),
        technology: 'Mobile Application',
        health: 'healthy'
      },
      style: {
        material: 'glass',
        color: '#00BCD4',
        height: screenCount * this.screenHeight,
        modernness: 0.9
      }
    };
  }

  private groupComponentsByScreen(components: ComponentNode[]): Map<string, ComponentNode[]> {
    const screens = new Map<string, ComponentNode[]>();

    for (const component of components) {
      // Extract screen name from component path or metadata
      const screenName = this.extractScreenName(component);
      if (!screens.has(screenName)) {
        screens.set(screenName, []);
      }
      screens.get(screenName)!.push(component);
    }

    return screens;
  }

  private extractScreenName(component: ComponentNode): string {
    // Logic to extract screen name from component
    if (component.metadata.reactType === 'page') {
      return component.name;
    }
    
    const pathParts = component.path.split('/');
    for (const part of pathParts) {
      if (part.includes('screen') || part.includes('view') || part.includes('page')) {
        return part;
      }
    }
    
    return 'MainScreen';
  }

  private countUniqueScreens(components: ComponentNode[]): number {
    const screens = new Set<string>();
    for (const component of components) {
      screens.add(this.extractScreenName(component));
    }
    return Math.max(screens.size, 3);
  }

  private createScreenRooms(
    components: ComponentNode[],
    floor: number,
    buildingId: string
  ): Room[] {
    const rooms: Room[] = [];
    const gridSize = Math.ceil(Math.sqrt(components.length));
    
    components.forEach((component, index) => {
      const gridX = index % gridSize;
      const gridZ = Math.floor(index / gridSize);
      
      const room: Room = {
        id: `screen_room_${component.id}`,
        componentId: component.id,
        name: component.name,
        type: 'display',
        position: {
          x: 5 + gridX * 10,
          y: floor * this.screenHeight,
          z: 5 + gridZ * 10
        },
        dimensions: {
          width: 8,
          height: this.screenHeight - 0.5,
          depth: 8
        },
        floor,
        building: buildingId,
        entrances: [{
          id: `entrance_${component.id}`,
          position: { x: 0, y: 0, z: 0 },
          width: 2,
          type: 'main',
          accessibility: 'public'
        }],
        exits: [{
          id: `exit_${component.id}`,
          position: { x: 8, y: 0, z: 0 },
          width: 2,
          type: 'normal'
        }],
        metadata: {
          complexity: component.metadata.complexity,
          linesOfCode: component.metadata.lineCount,
          lastModified: component.metadata.lastModified,
          criticality: component.metadata.isEntry ? 'high' : 'medium'
        },
        style: {
          color: '#E91E63',
          opacity: 0.85,
          emissive: component.metadata.isEntry
        }
      };

      rooms.push(room);
    });

    return rooms;
  }

  private createElevatorShaft(sourceRoom: Room, targetRoom: Room): Hallway {
    const lowerFloor = Math.min(sourceRoom.floor, targetRoom.floor);
    const upperFloor = Math.max(sourceRoom.floor, targetRoom.floor);
    
    const path: SpatialPosition[] = [
      {
        x: sourceRoom.position.x + sourceRoom.dimensions.width / 2,
        y: lowerFloor * this.screenHeight,
        z: sourceRoom.position.z + sourceRoom.dimensions.depth / 2
      },
      {
        x: targetRoom.position.x + targetRoom.dimensions.width / 2,
        y: upperFloor * this.screenHeight,
        z: targetRoom.position.z + targetRoom.dimensions.depth / 2
      }
    ];

    return {
      id: `elevator_${sourceRoom.id}_${targetRoom.id}`,
      type: 'main-corridor',
      path,
      width: 2,
      sourceRoom: sourceRoom.id,
      targetRoom: targetRoom.id,
      floor: lowerFloor,
      style: {
        color: '#FFC107',
        pattern: 'animated',
        glowing: true
      }
    };
  }

  private createFloorCorridor(sourceRoom: Room, targetRoom: Room): Hallway {
    const path = this.generatePathBetweenPoints(
      sourceRoom.position,
      targetRoom.position,
      []
    );

    return {
      id: `corridor_${sourceRoom.id}_${targetRoom.id}`,
      type: 'main-corridor',
      path,
      width: 1.5,
      sourceRoom: sourceRoom.id,
      targetRoom: targetRoom.id,
      floor: sourceRoom.floor,
      style: {
        color: '#BBBBBB',
        pattern: 'solid'
      }
    };
  }
}

export class FirmwareLayout extends BaseLayoutAlgorithm {
  private memoryMapWidth: number = 100;
  private memoryMapDepth: number = 80;
  private sectorSize: number = 10;

  generateLayout(components: ComponentNode[], connections: Connection[]) {
    const buildings: Building[] = [];
    const rooms: Room[] = [];
    const hallways: Hallway[] = [];
    const pathways: Pathway[] = [];

    // Create firmware memory map building
    const memoryBuilding = this.createMemoryBuilding(components);
    buildings.push(memoryBuilding);

    // Group components by memory sections
    const memorySections = this.groupComponentsByMemorySection(components);
    
    // Create memory sectors as rooms
    let sectorIndex = 0;
    for (const [sectionName, sectionComponents] of memorySections.entries()) {
      const sectorRooms = this.createMemorySectors(
        sectionName,
        sectionComponents,
        sectorIndex,
        memoryBuilding.id
      );
      
      rooms.push(...sectorRooms);
      memoryBuilding.rooms.push(...sectorRooms.map(r => r.id));
      
      sectorIndex++;
    }

    // Create execution paths as corridors
    for (const connection of connections) {
      const sourceRoom = rooms.find(r => r.componentId === connection.from);
      const targetRoom = rooms.find(r => r.componentId === connection.to);

      if (sourceRoom && targetRoom) {
        const executionPath = this.createExecutionPath(sourceRoom, targetRoom);
        hallways.push(executionPath);
      }
    }

    const bounds = this.calculateBounds([...buildings.map(b => b.position), ...rooms.map(r => r.position)]);

    return { buildings, rooms, hallways, pathways, bounds };
  }

  private createMemoryBuilding(components: ComponentNode[]): Building {
    return {
      id: 'firmware_memory',
      name: 'Firmware Memory Map',
      type: 'library',
      position: { x: 0, y: 0, z: 0 },
      dimensions: {
        width: this.memoryMapWidth,
        height: 10,
        depth: this.memoryMapDepth
      },
      floors: [{
        level: 0,
        name: 'Memory Layout',
        rooms: [],
        height: 10,
        type: 'basement',
        accessibility: 'restricted'
      }],
      rooms: [],
      entrances: [{
        id: 'boot_entrance',
        floor: 0,
        position: { x: 0, y: 0, z: this.memoryMapDepth / 2 },
        type: 'main',
        width: 3,
        height: 3
      }],
      metadata: {
        componentCount: components.length,
        totalLinesOfCode: components.reduce((sum, c) => sum + c.metadata.lineCount, 0),
        technology: 'Firmware',
        health: 'healthy'
      },
      style: {
        material: 'steel',
        color: '#37474F',
        height: 10,
        modernness: 0.3
      }
    };
  }

  private groupComponentsByMemorySection(components: ComponentNode[]): Map<string, ComponentNode[]> {
    const sections = new Map<string, ComponentNode[]>();
    
    const sectionNames = ['bootloader', 'kernel', 'drivers', 'application', 'data'];
    
    for (const component of components) {
      let section = 'application'; // default
      
      for (const sectionName of sectionNames) {
        if (component.path.toLowerCase().includes(sectionName) ||
            component.name.toLowerCase().includes(sectionName)) {
          section = sectionName;
          break;
        }
      }
      
      if (!sections.has(section)) {
        sections.set(section, []);
      }
      sections.get(section)!.push(component);
    }

    return sections;
  }

  private createMemorySectors(
    sectionName: string,
    components: ComponentNode[],
    sectionIndex: number,
    buildingId: string
  ): Room[] {
    const rooms: Room[] = [];
    const sectorsPerRow = Math.ceil(this.memoryMapWidth / this.sectorSize);
    
    const baseX = (sectionIndex % 2) * (this.memoryMapWidth / 2);
    const baseZ = Math.floor(sectionIndex / 2) * (this.memoryMapDepth / 2);
    
    components.forEach((component, index) => {
      const gridX = index % sectorsPerRow;
      const gridZ = Math.floor(index / sectorsPerRow);
      
      const room: Room = {
        id: `sector_${component.id}`,
        componentId: component.id,
        name: `${sectionName}: ${component.name}`,
        type: this.mapSectionToRoomType(sectionName),
        position: {
          x: baseX + gridX * this.sectorSize,
          y: 0,
          z: baseZ + gridZ * this.sectorSize
        },
        dimensions: {
          width: this.sectorSize - 1,
          height: 8,
          depth: this.sectorSize - 1
        },
        floor: 0,
        building: buildingId,
        entrances: [{
          id: `sector_entrance_${component.id}`,
          position: { x: 0, y: 0, z: 0 },
          width: 1,
          type: 'service',
          accessibility: 'restricted'
        }],
        exits: [{
          id: `sector_exit_${component.id}`,
          position: { x: this.sectorSize - 1, y: 0, z: 0 },
          width: 1,
          type: 'service'
        }],
        metadata: {
          complexity: component.metadata.complexity,
          linesOfCode: component.metadata.lineCount,
          lastModified: component.metadata.lastModified,
          criticality: sectionName === 'bootloader' || sectionName === 'kernel' ? 'critical' : 'high',
          temperature: this.calculateMemoryHeat(component)
        },
        style: {
          color: this.getSectionColor(sectionName),
          opacity: 0.7,
          pattern: 'grid'
        }
      };

      rooms.push(room);
    });

    return rooms;
  }

  private mapSectionToRoomType(section: string): RoomType {
    const mapping: Record<string, RoomType> = {
      'bootloader': 'entry-hall',
      'kernel': 'control',
      'drivers': 'communication',
      'application': 'processing',
      'data': 'storage'
    };
    return mapping[section] || 'utility';
  }

  private getSectionColor(section: string): string {
    const colors: Record<string, string> = {
      'bootloader': '#D32F2F',
      'kernel': '#7B1FA2',
      'drivers': '#388E3C',
      'application': '#1976D2',
      'data': '#F57C00'
    };
    return colors[section] || '#616161';
  }

  private calculateMemoryHeat(component: ComponentNode): number {
    // Simulate memory access heat based on component activity
    const baseHeat = component.metadata.complexity * 10;
    const connectionHeat = component.dependencies.length * 5;
    return Math.min(baseHeat + connectionHeat, 100);
  }

  private createExecutionPath(sourceRoom: Room, targetRoom: Room): Hallway {
    // Create straight-line execution paths (firmware is deterministic)
    const path: SpatialPosition[] = [
      {
        x: sourceRoom.position.x + sourceRoom.dimensions.width,
        y: sourceRoom.position.y + sourceRoom.dimensions.height / 2,
        z: sourceRoom.position.z + sourceRoom.dimensions.depth / 2
      },
      {
        x: targetRoom.position.x,
        y: targetRoom.position.y + targetRoom.dimensions.height / 2,
        z: targetRoom.position.z + targetRoom.dimensions.depth / 2
      }
    ];

    return {
      id: `exec_path_${sourceRoom.id}_${targetRoom.id}`,
      type: 'data-pipeline',
      path,
      width: 0.5,
      sourceRoom: sourceRoom.id,
      targetRoom: targetRoom.id,
      floor: 0,
      style: {
        color: '#00E676',
        pattern: 'animated',
        glowing: true,
        opacity: 0.6
      }
    };
  }
}

// Layout Algorithm Factory
export class LayoutAlgorithmFactory {
  static createAlgorithm(projectType: string): BaseLayoutAlgorithm {
    switch (projectType.toLowerCase()) {
      case 'web-app':
      case 'react':
      case 'angular':
      case 'vue':
        return new WebAppLayout();
      
      case 'api':
      case 'rest':
      case 'graphql':
      case 'express':
      case 'nestjs':
        return new APILayout();
      
      case 'microservices':
      case 'kubernetes':
      case 'docker':
        return new MicroserviceLayout();
      
      case 'mobile':
      case 'ios':
      case 'android':
      case 'react-native':
        return new MobileAppLayout();
      
      case 'firmware':
      case 'embedded':
      case 'iot':
        return new FirmwareLayout();
      
      default:
        // Default to web app layout
        return new WebAppLayout();
    }
  }

  static detectProjectType(components: ComponentNode[]): string {
    // Analyze components to determine project type
    const hasWebComponents = components.some(c => 
      c.metadata.reactType || c.metadata.vueType || c.metadata.angularType
    );
    
    const hasAPIComponents = components.some(c =>
      (c.metadata.httpMethods && c.metadata.httpMethods.length > 0) || c.type === 'route'
    );
    
    const hasMicroservices = components.filter(c =>
      c.path.includes('service') || c.path.includes('microservice')
    ).length > 5;
    
    const hasMobileComponents = components.some(c =>
      c.path.includes('screens') || c.path.includes('views') ||
      c.metadata.reactType === 'screen'
    );
    
    const hasFirmwareComponents = components.some(c =>
      c.path.includes('drivers') || c.path.includes('hal') ||
      c.path.includes('bootloader')
    );

    if (hasFirmwareComponents) return 'firmware';
    if (hasMicroservices) return 'microservices';
    if (hasMobileComponents) return 'mobile';
    if (hasWebComponents) return 'web-app';
    if (hasAPIComponents) return 'api';
    
    return 'web-app'; // default
  }
}