import { ComponentNode, Connection, ArchitectureBlueprint } from '../types';

// ===== CORE SPATIAL TYPES =====

export interface SpatialPosition {
  x: number;
  y: number;
  z: number; // Floor/level for multi-story structures
}

export interface SpatialDimensions {
  width: number;
  height: number;
  depth: number;
}

export interface SpatialBounds {
  min: SpatialPosition;
  max: SpatialPosition;
}

// ===== ROOM & BUILDING STRUCTURES =====

export interface Room {
  id: string;
  componentId: string; // Links to ComponentNode
  name: string;
  type: RoomType;
  position: SpatialPosition;
  dimensions: SpatialDimensions;
  floor: number;
  building?: string; // Building ID if part of a building
  entrances: Entrance[];
  exits: Exit[];
  metadata: RoomMetadata;
  style: RoomStyle;
  occupancy?: Occupancy; // Real-time occupancy for traffic visualization
}

export type RoomType = 
  | 'entry-hall'      // Main entry points
  | 'processing'      // Business logic processing
  | 'storage'         // Database/cache storage
  | 'control'         // Controllers/handlers
  | 'utility'         // Helper functions
  | 'security'        // Auth/security components
  | 'communication'   // API/messaging components
  | 'display'         // UI components
  | 'testing'         // Test suites
  | 'configuration';  // Config rooms

export interface RoomMetadata {
  complexity: number;
  linesOfCode: number;
  lastModified: Date;
  criticality: 'low' | 'medium' | 'high' | 'critical';
  temperature?: number; // Activity heat (0-100)
  alerts?: Alert[];
  tags?: string[];
}

export interface RoomStyle {
  color: string;
  texture?: string;
  opacity?: number;
  emissive?: boolean; // Glowing effect for active rooms
  pattern?: string;
}

export interface Entrance {
  id: string;
  position: SpatialPosition;
  width: number;
  type: 'main' | 'service' | 'emergency';
  accessibility: 'public' | 'private' | 'restricted';
}

export interface Exit {
  id: string;
  position: SpatialPosition;
  width: number;
  targetRoom?: string;
  targetBuilding?: string;
  type: 'normal' | 'emergency' | 'service';
}

// ===== BUILDING STRUCTURES =====

export interface Building {
  id: string;
  name: string;
  type: BuildingType;
  position: SpatialPosition;
  dimensions: SpatialDimensions;
  floors: Floor[];
  rooms: string[]; // Room IDs
  entrances: BuildingEntrance[];
  metadata: BuildingMetadata;
  style: BuildingStyle;
  campus?: string; // Campus ID for microservices
}

export type BuildingType = 
  | 'web-app'         // Multi-floor web application
  | 'api-service'     // API service building
  | 'microservice'    // Individual microservice
  | 'database'        // Database fortress
  | 'library'         // Shared library building
  | 'gateway'         // API gateway building
  | 'message-broker'  // Message queue hub
  | 'cache-store';    // Cache storage facility

export interface Floor {
  level: number;
  name: string;
  rooms: string[]; // Room IDs on this floor
  height: number;
  type: FloorType;
  accessibility: 'public' | 'private' | 'restricted';
}

export type FloorType = 
  | 'ground'          // Entry level
  | 'business'        // Business logic
  | 'data'            // Data layer
  | 'infrastructure'  // Infrastructure components
  | 'basement'        // Low-level utilities
  | 'penthouse';      // High-level orchestration

export interface BuildingEntrance {
  id: string;
  floor: number;
  position: SpatialPosition;
  type: 'main' | 'service' | 'loading' | 'emergency';
  width: number;
  height: number;
}

export interface BuildingMetadata {
  componentCount: number;
  totalLinesOfCode: number;
  technology: string;
  version?: string;
  health: 'healthy' | 'degraded' | 'critical' | 'offline';
  metrics?: BuildingMetrics;
}

export interface BuildingMetrics {
  requestsPerMinute?: number;
  errorRate?: number;
  responseTime?: number;
  cpuUsage?: number;
  memoryUsage?: number;
}

export interface BuildingStyle {
  material: 'glass' | 'concrete' | 'steel' | 'brick' | 'wood';
  color: string;
  height: number;
  modernness: number; // 0-1 scale for visual style
}

// ===== PATHWAYS & CONNECTIONS =====

export interface Hallway {
  id: string;
  type: HallwayType;
  path: SpatialPosition[];
  width: number;
  sourceRoom: string;
  targetRoom: string;
  floor: number;
  style: PathwayStyle;
  traffic?: TrafficFlow;
}

export type HallwayType = 
  | 'main-corridor'   // Primary navigation paths
  | 'service-tunnel'  // Background service connections
  | 'data-pipeline'   // Data flow connections
  | 'emergency-exit'  // Error/exception paths
  | 'shortcut';       // Optimized paths

export interface Pathway {
  id: string;
  type: PathwayType;
  nodes: PathNode[];
  width: number;
  bidirectional: boolean;
  sourceBuilding: string;
  targetBuilding: string;
  style: PathwayStyle;
  traffic?: TrafficFlow;
}

export type PathwayType = 
  | 'road'            // Normal inter-service communication
  | 'highway'         // High-throughput connections
  | 'tunnel'          // Secure/private connections
  | 'bridge'          // Cross-domain connections
  | 'ferry';          // Async/queue-based connections

export interface PathNode {
  position: SpatialPosition;
  elevation?: number;
  checkpoint?: boolean;
  metadata?: any;
}

export interface PathwayStyle {
  color: string;
  pattern?: 'solid' | 'dashed' | 'dotted' | 'animated';
  glowing?: boolean;
  opacity?: number;
  width?: number;
}

// ===== NAVIGATION & ROUTING =====

export interface NavigationPath {
  id: string;
  name: string;
  description?: string;
  waypoints: Waypoint[];
  totalDistance: number;
  estimatedTime?: number;
  difficulty?: 'easy' | 'moderate' | 'complex';
  type: 'user-journey' | 'data-flow' | 'control-flow' | 'error-path';
}

export interface Waypoint {
  position: SpatialPosition;
  roomId?: string;
  buildingId?: string;
  floor?: number;
  label?: string;
  action?: string;
  metadata?: any;
}

// ===== TRAFFIC & FLOW =====

export interface TrafficFlow {
  id: string;
  intensity: number; // 0-100
  direction: 'unidirectional' | 'bidirectional';
  vehicles: Vehicle[];
  congestion?: number; // 0-1 scale
  avgSpeed?: number;
  pattern?: TrafficPattern;
}

export interface Vehicle {
  id: string;
  type: VehicleType;
  position: SpatialPosition;
  destination: SpatialPosition;
  path: SpatialPosition[];
  speed: number;
  payload?: any;
  status: 'moving' | 'stopped' | 'loading' | 'error';
}

export type VehicleType = 
  | 'request'         // HTTP requests
  | 'response'        // API responses
  | 'message'         // Queue messages
  | 'data-packet'     // Data transfers
  | 'user'            // User sessions
  | 'process'         // Background processes
  | 'error';          // Error propagation

export interface TrafficPattern {
  type: 'constant' | 'burst' | 'periodic' | 'random';
  peakTimes?: string[];
  averageVolume: number;
  maxVolume: number;
}

// ===== OCCUPANCY & ACTIVITY =====

export interface Occupancy {
  current: number;
  capacity: number;
  trend: 'increasing' | 'decreasing' | 'stable';
  visitors: Visitor[];
  heatLevel?: number; // 0-100 activity heat
}

export interface Visitor {
  id: string;
  type: 'user' | 'system' | 'bot' | 'monitor';
  entryTime: Date;
  currentPosition: SpatialPosition;
  path: SpatialPosition[];
  purpose?: string;
}

// ===== ALERTS & MONITORING =====

export interface Alert {
  id: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  message: string;
  timestamp: Date;
  location: SpatialPosition;
  roomId?: string;
  buildingId?: string;
  resolved?: boolean;
}

// ===== CAMPUS & DISTRICTS =====

export interface Campus {
  id: string;
  name: string;
  type: 'microservices' | 'monolith' | 'hybrid';
  buildings: string[]; // Building IDs
  districts: District[];
  roads: Pathway[];
  bounds: SpatialBounds;
  metadata: CampusMetadata;
}

export interface District {
  id: string;
  name: string;
  type: 'business' | 'data' | 'infrastructure' | 'external';
  buildings: string[];
  bounds: SpatialBounds;
  zoning?: ZoningRules;
}

export interface ZoningRules {
  maxBuildingHeight?: number;
  minSpacing?: number;
  allowedBuildingTypes?: BuildingType[];
  restricted?: boolean;
}

export interface CampusMetadata {
  totalBuildings: number;
  totalRooms: number;
  totalConnections: number;
  technology: string[];
  health: 'healthy' | 'degraded' | 'critical';
}

// ===== SPATIAL BLUEPRINT =====

export interface SpatialBlueprint {
  id: string;
  projectName: string;
  timestamp: Date;
  campus?: Campus;
  buildings: Building[];
  rooms: Room[];
  hallways: Hallway[];
  pathways: Pathway[];
  navigationPaths: NavigationPath[];
  trafficFlows: TrafficFlow[];
  bounds: SpatialBounds;
  metadata: SpatialMetadata;
  layout: LayoutInfo;
  viewpoints: Viewpoint[];
}

export interface SpatialMetadata {
  totalComponents: number;
  spatialComplexity: number;
  averageConnectivity: number;
  layoutAlgorithm: string;
  renderingHints: RenderingHints;
}

export interface LayoutInfo {
  type: 'campus' | 'building' | 'floor' | 'room';
  algorithm: string;
  spacing: SpatialDimensions;
  grid?: GridInfo;
}

export interface GridInfo {
  cellSize: number;
  columns: number;
  rows: number;
  layers: number;
}

export interface RenderingHints {
  defaultView: 'isometric' | 'top-down' | 'first-person' | 'side';
  lighting: 'day' | 'night' | 'dynamic';
  detailLevel: 'low' | 'medium' | 'high' | 'ultra';
  enableShadows?: boolean;
  enableReflections?: boolean;
  enableParticles?: boolean;
}

export interface Viewpoint {
  id: string;
  name: string;
  position: SpatialPosition;
  target: SpatialPosition;
  fov?: number;
  type: 'overview' | 'detail' | 'tour-stop' | 'debug';
}

// ===== SPATIAL INDEXING =====

export interface SpatialIndex {
  type: 'rtree' | 'quadtree' | 'octree' | 'grid';
  root: SpatialNode;
  itemCount: number;
  depth: number;
}

export interface SpatialNode {
  bounds: SpatialBounds;
  items: SpatialItem[];
  children?: SpatialNode[];
  leaf: boolean;
}

export interface SpatialItem {
  id: string;
  type: 'room' | 'building' | 'hallway' | 'pathway';
  bounds: SpatialBounds;
  data: any;
}

// ===== TRANSFORMATION MAPPINGS =====

export interface ComponentToSpatialMapping {
  componentId: string;
  spatialId: string;
  spatialType: 'room' | 'building' | 'floor';
  transformations: Transformation[];
}

export interface Transformation {
  type: 'position' | 'scale' | 'rotation' | 'color';
  from: any;
  to: any;
  duration?: number;
  easing?: string;
}

// ===== ANIMATION & DYNAMICS =====

export interface Animation {
  id: string;
  targetId: string;
  property: string;
  from: any;
  to: any;
  duration: number;
  easing: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';
  loop?: boolean;
  autoReverse?: boolean;
}

export interface DynamicElement {
  id: string;
  type: 'particle' | 'light' | 'effect';
  position: SpatialPosition;
  lifetime?: number;
  behavior?: ElementBehavior;
}

export interface ElementBehavior {
  movement?: MovementPattern;
  interaction?: InteractionType;
  trigger?: TriggerCondition;
}

export interface MovementPattern {
  type: 'orbit' | 'linear' | 'random' | 'follow-path';
  speed: number;
  path?: SpatialPosition[];
}

export type InteractionType = 'none' | 'hover' | 'click' | 'proximity';

export interface TriggerCondition {
  type: 'time' | 'event' | 'proximity' | 'threshold';
  value: any;
  action: string;
}