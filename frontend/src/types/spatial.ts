export interface SpatialPosition {
  x: number;
  y: number;
  z: number;
}

export interface SpatialDimensions {
  width: number;
  height: number;
  depth: number;
}

export interface Room {
  id: string;
  name: string;
  type: 'screen' | 'component' | 'service' | 'database' | 'api' | 'function';
  position: SpatialPosition;
  dimensions: SpatialDimensions;
  floor: number;
  buildingId?: string;
  metadata: {
    componentId: string;
    complexity: number;
    linesOfCode: number;
    importance: number;
    activityLevel: number;
  };
  doors: Door[];
  windows: Window[];
  color: string;
  material: 'glass' | 'concrete' | 'steel' | 'wood';
  glowing: boolean;
}

export interface Door {
  id: string;
  position: 'north' | 'south' | 'east' | 'west';
  targetRoomId: string;
  isOpen: boolean;
  width: number;
}

export interface Window {
  id: string;
  position: 'north' | 'south' | 'east' | 'west';
  width: number;
  height: number;
}

export interface Building {
  id: string;
  name: string;
  type: 'service' | 'module' | 'library' | 'api';
  position: SpatialPosition;
  dimensions: SpatialDimensions;
  floors: Floor[];
  entrances: Entrance[];
  metadata: {
    serviceId: string;
    importance: number;
    activityLevel: number;
  };
  material: 'glass' | 'concrete' | 'steel' | 'brick';
  color: string;
}

export interface Floor {
  id: string;
  level: number;
  height: number;
  rooms: string[];
  hallways: string[];
}

export interface Entrance {
  id: string;
  position: SpatialPosition;
  type: 'main' | 'service' | 'emergency';
  width: number;
  height: number;
}

export interface Hallway {
  id: string;
  path: SpatialPosition[];
  width: number;
  height: number;
  connectsRooms: [string, string];
  traffic: number;
  material: 'marble' | 'concrete' | 'carpet';
}

export interface Vehicle {
  id: string;
  type: 'request' | 'response' | 'event' | 'data';
  position: SpatialPosition;
  destination: SpatialPosition;
  speed: number;
  color: string;
  size: number;
  pathIndex: number;
  path: SpatialPosition[];
}

export interface SpatialBlueprint {
  id: string;
  projectId: string;
  campus: Campus;
  rooms: Room[];
  buildings: Building[];
  hallways: Hallway[];
  vehicles: Vehicle[];
  metadata: {
    totalComponents: number;
    totalConnections: number;
    layoutType: string;
    timestamp: Date;
  };
  viewpoints: Viewpoint[];
}

export interface Campus {
  bounds: {
    min: SpatialPosition;
    max: SpatialPosition;
  };
  districts: District[];
  mainPaths: Path[];
}

export interface District {
  id: string;
  name: string;
  type: 'frontend' | 'backend' | 'database' | 'infrastructure';
  bounds: {
    min: SpatialPosition;
    max: SpatialPosition;
  };
  buildingIds: string[];
  color: string;
}

export interface Path {
  id: string;
  points: SpatialPosition[];
  width: number;
  type: 'main' | 'secondary' | 'service';
}

export interface Viewpoint {
  id: string;
  name: string;
  position: SpatialPosition;
  lookAt: SpatialPosition;
  fov: number;
  description: string;
}