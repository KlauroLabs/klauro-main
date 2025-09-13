import {
  ComponentNode,
  ComponentType,
  Connection,
  ConnectionType,
  EntryPoint,
  ExitPoint
} from '../types';
import {
  RoomType,
  BuildingType,
  FloorType,
  HallwayType,
  PathwayType,
  VehicleType
} from './spatial-types';

export class MetaphorMapper {
  private componentTypeToRoom: Map<ComponentType, RoomType> = new Map();
  private connectionTypeToPath: Map<ConnectionType, HallwayType | PathwayType> = new Map();
  private frameworkToBuilding: Map<string, BuildingType> = new Map();
  private layerToFloor: Map<string, FloorType> = new Map();

  constructor() {
    this.initializeMappings();
  }

  private initializeMappings(): void {
    // Component type to room type mappings
    this.componentTypeToRoom = new Map([
      ['route', 'entry-hall'],
      ['controller', 'control'],
      ['middleware', 'security'],
      ['model', 'storage'],
      ['service', 'processing'],
      ['utility', 'utility'],
      ['config', 'configuration'],
      ['database', 'storage'],
      ['external_api', 'communication'],
      ['orphaned', 'utility']
    ]);

    // Connection type to pathway type mappings
    this.connectionTypeToPath = new Map([
      ['import', 'service-tunnel'],
      ['http_call', 'main-corridor'],
      ['database', 'data-pipeline'],
      ['middleware_chain', 'main-corridor'],
      ['function_call', 'shortcut'],
      ['data_flow', 'data-pipeline'],
      ['dependency-injection', 'service-tunnel'],
      ['data-relationship', 'data-pipeline'],
      ['contains', 'main-corridor'],
      ['form-handling', 'main-corridor'],
      ['template-inheritance', 'service-tunnel'],
      ['template-include', 'shortcut'],
      ['uses-middleware', 'service-tunnel'],
      ['uses-model', 'data-pipeline'],
      ['route-controller', 'main-corridor'],
      ['module-import', 'service-tunnel'],
      ['module-controller', 'main-corridor'],
      ['module-provider', 'service-tunnel'],
      ['dependency', 'service-tunnel'],
      ['navigation', 'main-corridor'],
      ['guards', 'service-tunnel'],
      ['intercepts', 'service-tunnel'],
      ['api-call', 'main-corridor']
    ]);

    // Framework to building type mappings
    this.frameworkToBuilding = new Map([
      ['Express', 'api-service'],
      ['NestJS', 'api-service'],
      ['Django', 'web-app'],
      ['React', 'web-app'],
      ['Vue', 'web-app'],
      ['Angular', 'web-app'],
      ['Spring Boot', 'api-service'],
      ['FastAPI', 'api-service'],
      ['Flask', 'api-service'],
      ['Laravel', 'web-app'],
      ['Next.js', 'web-app'],
      ['Ruby on Rails', 'web-app'],
      ['ASP.NET', 'api-service'],
      ['Gin', 'api-service'],
      ['Actix', 'api-service'],
      ['Phoenix', 'web-app']
    ]);

    // Architectural layer to floor type mappings
    this.layerToFloor = new Map([
      ['presentation', 'penthouse'],
      ['business', 'business'],
      ['data', 'data'],
      ['infrastructure', 'infrastructure'],
      ['external', 'ground']
    ]);
  }

  mapComponentToRoomType(component: ComponentNode): RoomType {
    // First check for specific patterns in metadata
    if (component.metadata.isEntry) {
      return 'entry-hall';
    }

    if (component.metadata.isTest) {
      return 'testing';
    }

    // Check for API endpoints
    if (component.metadata.httpMethods && component.metadata.httpMethods.length > 0) {
      return 'communication';
    }

    // Check for database operations
    if (component.metadata.dbQueries && component.metadata.dbQueries.length > 0) {
      return 'storage';
    }

    // Check for external calls
    if (component.metadata.externalCalls && component.metadata.externalCalls.length > 0) {
      return 'communication';
    }

    // Check framework-specific types
    if (component.metadata.djangoType) {
      return this.mapDjangoComponentToRoom(component.metadata.djangoType);
    }

    if (component.metadata.nestjsType) {
      return this.mapNestJSComponentToRoom(component.metadata.nestjsType);
    }

    if (component.metadata.springType) {
      return this.mapSpringComponentToRoom(component.metadata.springType);
    }

    if (component.metadata.reactType) {
      return this.mapReactComponentToRoom(component.metadata.reactType);
    }

    // Default mapping based on component type
    return this.componentTypeToRoom.get(component.type) || 'utility';
  }

  private mapDjangoComponentToRoom(djangoType: string): RoomType {
    const mappings: Record<string, RoomType> = {
      'view': 'control',
      'model': 'storage',
      'serializer': 'processing',
      'middleware': 'security',
      'template': 'display',
      'form': 'processing',
      'admin': 'control',
      'signal': 'communication',
      'task': 'processing'
    };
    return mappings[djangoType] || 'utility';
  }

  private mapNestJSComponentToRoom(nestjsType: string): RoomType {
    const mappings: Record<string, RoomType> = {
      'controller': 'control',
      'service': 'processing',
      'module': 'configuration',
      'guard': 'security',
      'interceptor': 'processing',
      'pipe': 'processing',
      'filter': 'security',
      'gateway': 'communication',
      'resolver': 'control'
    };
    return mappings[nestjsType] || 'utility';
  }

  private mapSpringComponentToRoom(springType: string): RoomType {
    const mappings: Record<string, RoomType> = {
      'RestController': 'control',
      'Controller': 'control',
      'Service': 'processing',
      'Repository': 'storage',
      'Component': 'utility',
      'Configuration': 'configuration',
      'Bean': 'utility',
      'Entity': 'storage',
      'Filter': 'security'
    };
    return mappings[springType] || 'utility';
  }

  private mapReactComponentToRoom(reactType: string): RoomType {
    const mappings: Record<string, RoomType> = {
      'component': 'display',
      'page': 'display',
      'layout': 'display',
      'hook': 'processing',
      'context': 'configuration',
      'reducer': 'processing',
      'action': 'processing',
      'selector': 'processing',
      'service': 'communication'
    };
    return mappings[reactType] || 'display';
  }

  mapConnectionToPathType(connection: Connection): HallwayType | PathwayType {
    // Check for high-traffic connections
    if (connection.weight && connection.weight > 10) {
      return 'highway' as PathwayType;
    }

    // Check for secure connections
    if (connection.metadata?.injectionType === 'private') {
      return 'tunnel' as PathwayType;
    }

    // Check for error paths
    if (connection.type === 'function_call' && connection.metadata?.methods?.includes('catch')) {
      return 'emergency-exit';
    }

    // Default mapping based on connection type
    return this.connectionTypeToPath.get(connection.type) || 'service-tunnel';
  }

  mapFrameworkToBuilding(framework: string): BuildingType {
    return this.frameworkToBuilding.get(framework) || 'library';
  }

  mapLayerToFloor(layer: string): FloorType {
    return this.layerToFloor.get(layer) || 'ground';
  }

  mapEntryPointToVehicle(entryPoint: EntryPoint): VehicleType {
    const typeMap: Record<string, VehicleType> = {
      'http_endpoint': 'request',
      'websocket': 'message',
      'cli_command': 'process',
      'event_handler': 'message',
      'scheduler': 'process',
      'queue_consumer': 'message',
      'webhook': 'request',
      'grpc_service': 'request'
    };
    return typeMap[entryPoint.type] || 'request';
  }

  mapExitPointToDestination(exitPoint: ExitPoint): string {
    const destinationMap: Record<string, string> = {
      'database_query': 'Database Vault',
      'external_api': 'External Gateway',
      'message_publish': 'Message Hub',
      'file_operation': 'File Storage',
      'cache_operation': 'Cache Store',
      'email_send': 'Mail Server',
      'sms_send': 'SMS Gateway',
      'webhook_call': 'Webhook Target',
      'log_write': 'Log Archive'
    };
    return destinationMap[exitPoint.type] || 'External System';
  }

  generateRoomDescription(component: ComponentNode, roomType: RoomType): string {
    const descriptions: Record<RoomType, string> = {
      'entry-hall': `Main entrance handling ${component.metadata.httpMethods?.join(', ') || 'requests'}`,
      'processing': `Processing center for ${component.name}`,
      'storage': `Data storage for ${component.metadata.tableName || component.name}`,
      'control': `Control room managing ${component.metadata.responsibilities?.join(', ') || 'operations'}`,
      'utility': `Utility room providing helper functions`,
      'security': `Security checkpoint enforcing ${component.metadata.middleware?.join(', ') || 'policies'}`,
      'communication': `Communication hub for ${component.metadata.externalCalls?.length || 0} external connections`,
      'display': `Display room showing ${component.name} interface`,
      'testing': `Testing laboratory for ${component.name}`,
      'configuration': `Configuration center managing settings`
    };
    return descriptions[roomType] || `Room for ${component.name}`;
  }

  calculateRoomImportance(component: ComponentNode): number {
    let importance = 0;

    // Entry points are very important
    if (component.metadata.isEntry) importance += 30;

    // Components with many dependencies are important
    importance += Math.min(component.dependents.length * 5, 30);

    // Components with external calls are important
    if (component.metadata.externalCalls && component.metadata.externalCalls.length > 0) importance += 20;

    // Database components are important
    if (component.metadata.dbQueries && component.metadata.dbQueries.length > 0) importance += 15;

    // High complexity adds importance
    importance += Math.min(component.metadata.complexity * 3, 15);

    // Orphaned components are less important
    if (component.metadata.isOrphaned) importance -= 20;

    return Math.max(0, Math.min(100, importance));
  }

  suggestRoomColor(roomType: RoomType, importance: number): string {
    const baseColors: Record<RoomType, string> = {
      'entry-hall': '#4CAF50',      // Green - welcoming
      'processing': '#2196F3',       // Blue - logic
      'storage': '#9C27B0',          // Purple - data
      'control': '#FF9800',          // Orange - management
      'utility': '#607D8B',          // Blue-grey - support
      'security': '#F44336',         // Red - protection
      'communication': '#00BCD4',    // Cyan - connectivity
      'display': '#E91E63',          // Pink - UI
      'testing': '#8BC34A',          // Light green - validation
      'configuration': '#795548'     // Brown - settings
    };

    const baseColor = baseColors[roomType] || '#9E9E9E';
    
    // Adjust brightness based on importance
    const brightness = 0.5 + (importance / 100) * 0.5;
    return this.adjustColorBrightness(baseColor, brightness);
  }

  private adjustColorBrightness(color: string, brightness: number): string {
    // Simple brightness adjustment (would need proper implementation)
    return color;
  }

  suggestBuildingMaterial(buildingType: BuildingType): 'glass' | 'concrete' | 'steel' | 'brick' | 'wood' {
    const materials: Record<BuildingType, 'glass' | 'concrete' | 'steel' | 'brick' | 'wood'> = {
      'web-app': 'glass',
      'api-service': 'steel',
      'microservice': 'concrete',
      'database': 'concrete',
      'library': 'brick',
      'gateway': 'steel',
      'message-broker': 'steel',
      'cache-store': 'concrete'
    };
    return materials[buildingType] || 'brick';
  }

  determineFloorHeight(floorType: FloorType): number {
    const heights: Record<FloorType, number> = {
      'ground': 4.5,        // Tall for main entrances
      'business': 3.5,      // Standard office height
      'data': 3.0,          // Compact for storage
      'infrastructure': 3.0, // Compact for utilities
      'basement': 2.5,      // Low ceiling
      'penthouse': 5.0      // Luxurious height
    };
    return heights[floorType] || 3.5;
  }

  calculatePathWidth(connectionWeight: number = 1): number {
    // Width based on traffic volume
    if (connectionWeight > 100) return 4.0;
    if (connectionWeight > 50) return 3.0;
    if (connectionWeight > 20) return 2.0;
    if (connectionWeight > 10) return 1.5;
    return 1.0;
  }

  determineTrafficIntensity(callCount: number): number {
    // Convert call count to 0-100 intensity scale
    if (callCount === 0) return 0;
    if (callCount < 10) return 10;
    if (callCount < 50) return 30;
    if (callCount < 100) return 50;
    if (callCount < 500) return 70;
    if (callCount < 1000) return 85;
    return 95;
  }

  getMetaphorDescription(componentType: ComponentType): string {
    const descriptions: Record<ComponentType, string> = {
      'route': 'Entry hall where visitors arrive',
      'controller': 'Control room managing operations',
      'middleware': 'Security checkpoint filtering access',
      'model': 'Storage vault containing data',
      'service': 'Processing facility handling business logic',
      'utility': 'Utility closet with helper tools',
      'config': 'Configuration room with settings panels',
      'database': 'Secure data fortress',
      'external_api': 'Communication tower reaching external systems',
      'orphaned': 'Abandoned room awaiting renovation'
    };
    return descriptions[componentType] || 'Functional space';
  }
}