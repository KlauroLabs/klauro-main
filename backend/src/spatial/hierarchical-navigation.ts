import { Injectable, Logger } from '@nestjs/common';
import { ComponentNode, Connection, ArchitecturalLayer } from '../types';
import { 
  SpatialBlueprint, 
  Room, 
  Building, 
  SpatialPosition, 
  NavigationPath 
} from './spatial-types';

export interface NavigationHierarchy {
  id: string;
  name: string;
  type: NavigationNodeType;
  level: HierarchyLevel;
  parent?: string;
  children: string[];
  componentIds: string[];
  spatialBounds?: {
    position: SpatialPosition;
    width: number;
    height: number;
    depth: number;
  };
  metadata: {
    complexity: number;
    componentCount: number;
    connectionCount: number;
    layer: ArchitecturalLayer;
    framework?: string;
    description: string;
    tags: string[];
  };
}

export enum NavigationNodeType {
  SYSTEM = 'system',
  BUILDING = 'building', 
  FLOOR = 'floor',
  ROOM = 'room',
  ZONE = 'zone',
  COMPONENT = 'component',
  FUNCTION = 'function'
}

export enum HierarchyLevel {
  SYSTEM = 0,     // Entire application
  SERVICE = 1,    // Microservices/modules
  LAYER = 2,      // Architectural layers
  MODULE = 3,     // Feature modules
  COMPONENT = 4,  // Individual components
  FUNCTION = 5    // Functions/methods
}

export interface BreadcrumbItem {
  id: string;
  name: string;
  type: NavigationNodeType;
  level: HierarchyLevel;
  path: string;
  active: boolean;
}

export interface NavigationContext {
  currentNode: NavigationHierarchy;
  breadcrumbs: BreadcrumbItem[];
  siblings: NavigationHierarchy[];
  children: NavigationHierarchy[];
  availableActions: NavigationAction[];
  spatialContext?: {
    currentRoom?: Room;
    currentBuilding?: Building;
    visibleRooms: Room[];
    navigationPaths: NavigationPath[];
  };
}

export interface NavigationAction {
  id: string;
  type: 'drill-down' | 'drill-up' | 'navigate' | 'zoom' | 'filter' | 'search';
  label: string;
  icon: string;
  enabled: boolean;
  targetId?: string;
  metadata?: Record<string, any>;
}

export interface NavigationFilter {
  framework?: string[];
  layer?: ArchitecturalLayer[];
  complexity?: { min: number; max: number };
  tags?: string[];
  pattern?: string;
  antiPattern?: string;
  performanceHotspot?: boolean;
}

@Injectable()
export class HierarchicalNavigationService {
  private readonly logger = new Logger(HierarchicalNavigationService.name);
  private hierarchyCache: Map<string, NavigationHierarchy> = new Map();
  private breadcrumbCache: Map<string, BreadcrumbItem[]> = new Map();
  
  /**
   * Build hierarchical navigation structure from components and spatial data
   */
  async buildHierarchy(
    components: ComponentNode[],
    connections: Connection[],
    spatialBlueprint?: SpatialBlueprint
  ): Promise<NavigationHierarchy> {
    this.logger.log('Building hierarchical navigation structure...');
    
    // Clear existing cache
    this.hierarchyCache.clear();
    this.breadcrumbCache.clear();

    // Build system-level hierarchy
    const systemNode = this.createSystemNode(components, connections);
    this.hierarchyCache.set(systemNode.id, systemNode);

    // Build service-level hierarchy (microservices, major modules)
    const serviceNodes = this.buildServiceNodes(components, connections);
    for (const node of serviceNodes) {
      this.hierarchyCache.set(node.id, node);
      systemNode.children.push(node.id);
    }

    // Build layer-level hierarchy (presentation, business, data)
    const layerNodes = this.buildLayerNodes(components, connections, serviceNodes);
    for (const node of layerNodes) {
      this.hierarchyCache.set(node.id, node);
    }

    // Build module-level hierarchy (feature modules, controllers)
    const moduleNodes = this.buildModuleNodes(components, connections, layerNodes);
    for (const node of moduleNodes) {
      this.hierarchyCache.set(node.id, node);
    }

    // Build component-level hierarchy
    const componentNodes = this.buildComponentNodes(components, connections, moduleNodes);
    for (const node of componentNodes) {
      this.hierarchyCache.set(node.id, node);
    }

    // Build function-level hierarchy
    const functionNodes = this.buildFunctionNodes(components, componentNodes);
    for (const node of functionNodes) {
      this.hierarchyCache.set(node.id, node);
    }

    // Integrate spatial data if available
    if (spatialBlueprint) {
      this.integrateSpatialData(spatialBlueprint);
    }

    this.logger.log(`✅ Built hierarchy with ${this.hierarchyCache.size} nodes`);
    return systemNode;
  }

  /**
   * Get navigation context for a specific node
   */
  getNavigationContext(nodeId: string, filter?: NavigationFilter): NavigationContext {
    const currentNode = this.hierarchyCache.get(nodeId);
    if (!currentNode) {
      throw new Error(`Navigation node not found: ${nodeId}`);
    }

    const breadcrumbs = this.buildBreadcrumbs(nodeId);
    const siblings = this.getSiblings(currentNode);
    const children = this.getChildren(currentNode, filter);
    const actions = this.getAvailableActions(currentNode);

    return {
      currentNode,
      breadcrumbs,
      siblings: siblings.filter(s => this.matchesFilter(s, filter)),
      children,
      availableActions: actions,
      spatialContext: this.getSpatialContext(currentNode)
    };
  }

  /**
   * Navigate to a specific node and return updated context
   */
  navigateToNode(nodeId: string, filter?: NavigationFilter): NavigationContext {
    return this.getNavigationContext(nodeId, filter);
  }

  /**
   * Drill down into a child node
   */
  drillDown(parentId: string, childId: string, filter?: NavigationFilter): NavigationContext {
    const parent = this.hierarchyCache.get(parentId);
    const child = this.hierarchyCache.get(childId);

    if (!parent || !child) {
      throw new Error(`Invalid drill-down: parent ${parentId} or child ${childId} not found`);
    }

    if (!parent.children.includes(childId)) {
      throw new Error(`${childId} is not a child of ${parentId}`);
    }

    return this.getNavigationContext(childId, filter);
  }

  /**
   * Drill up to parent node
   */
  drillUp(nodeId: string, filter?: NavigationFilter): NavigationContext {
    const currentNode = this.hierarchyCache.get(nodeId);
    if (!currentNode || !currentNode.parent) {
      throw new Error(`Cannot drill up from ${nodeId}: no parent found`);
    }

    return this.getNavigationContext(currentNode.parent, filter);
  }

  /**
   * Search for nodes matching criteria
   */
  searchNodes(
    query: string, 
    filter?: NavigationFilter, 
    rootNodeId?: string
  ): NavigationHierarchy[] {
    const searchRoot = rootNodeId ? this.hierarchyCache.get(rootNodeId) : null;
    const results: NavigationHierarchy[] = [];
    
    const searchRecursive = (nodeId: string): void => {
      const node = this.hierarchyCache.get(nodeId);
      if (!node) return;

      // Check if node matches search criteria
      const matchesQuery = query === '' || 
        node.name.toLowerCase().includes(query.toLowerCase()) ||
        node.metadata.description.toLowerCase().includes(query.toLowerCase()) ||
        node.metadata.tags.some(tag => tag.toLowerCase().includes(query.toLowerCase()));

      if (matchesQuery && this.matchesFilter(node, filter)) {
        results.push(node);
      }

      // Search children
      for (const childId of node.children) {
        searchRecursive(childId);
      }
    };

    // Start search from root or search all nodes
    if (searchRoot) {
      searchRecursive(searchRoot.id);
    } else {
      for (const [nodeId] of this.hierarchyCache) {
        if (this.hierarchyCache.get(nodeId)?.level === HierarchyLevel.SYSTEM) {
          searchRecursive(nodeId);
          break;
        }
      }
    }

    return results.sort((a, b) => {
      // Sort by relevance (exact matches first, then by level)
      const aExact = a.name.toLowerCase() === query.toLowerCase();
      const bExact = b.name.toLowerCase() === query.toLowerCase();
      
      if (aExact !== bExact) return aExact ? -1 : 1;
      return a.level - b.level;
    });
  }

  /**
   * Get available navigation paths between two nodes
   */
  getNavigationPaths(fromNodeId: string, toNodeId: string): NavigationPath[] {
    const fromNode = this.hierarchyCache.get(fromNodeId);
    const toNode = this.hierarchyCache.get(toNodeId);

    if (!fromNode || !toNode) {
      return [];
    }

    // Find common ancestor
    const fromPath = this.getPathToRoot(fromNodeId);
    const toPath = this.getPathToRoot(toNodeId);
    
    let commonAncestorIndex = -1;
    for (let i = 0; i < Math.min(fromPath.length, toPath.length); i++) {
      if (fromPath[i] === toPath[i]) {
        commonAncestorIndex = i;
      } else {
        break;
      }
    }

    if (commonAncestorIndex === -1) {
      return []; // No common ancestor found
    }

    // Build navigation path
    const waypoints = [
      ...fromPath.slice(commonAncestorIndex + 1).reverse(),
      fromPath[commonAncestorIndex], // Common ancestor
      ...toPath.slice(commonAncestorIndex + 1)
    ];

    return [{
      id: `path_${fromNodeId}_to_${toNodeId}`,
      waypoints: waypoints.map(nodeId => {
        const node = this.hierarchyCache.get(nodeId)!;
        return {
          id: nodeId,
          position: node.spatialBounds?.position || { x: 0, y: 0, z: 0 },
          roomId: nodeId,
          buildingId: this.findBuildingForNode(nodeId) || '',
          metadata: {
            name: node.name,
            type: node.type,
            level: node.level
          }
        };
      }),
      distance: waypoints.length - 1,
      estimatedTime: waypoints.length * 500, // 500ms per step
      difficulty: this.calculatePathDifficulty(waypoints),
      metadata: {
        fromNode: fromNode.name,
        toNode: toNode.name,
        pathType: 'hierarchical'
      }
    }];
  }

  // Private helper methods

  private createSystemNode(components: ComponentNode[], connections: Connection[]): NavigationHierarchy {
    const frameworks = [...new Set(components.map(c => c.framework).filter(Boolean))];
    const layers = [...new Set(components.map(c => c.metadata.layer).filter(Boolean))];

    return {
      id: 'system_root',
      name: 'Application System',
      type: NavigationNodeType.SYSTEM,
      level: HierarchyLevel.SYSTEM,
      children: [],
      componentIds: components.map(c => c.id),
      metadata: {
        complexity: components.reduce((sum, c) => sum + c.metadata.complexity, 0),
        componentCount: components.length,
        connectionCount: connections.length,
        layer: 'infrastructure' as ArchitecturalLayer,
        description: `Complete application system with ${components.length} components across ${frameworks.length} frameworks`,
        tags: ['system', ...frameworks, ...layers]
      }
    };
  }

  private buildServiceNodes(components: ComponentNode[], connections: Connection[]): NavigationHierarchy[] {
    const serviceNodes: NavigationHierarchy[] = [];
    
    // Group by framework first (microservice-like grouping)
    const frameworkGroups = this.groupComponentsByFramework(components);
    
    for (const [framework, frameworkComponents] of frameworkGroups.entries()) {
      const serviceId = `service_${framework}`;
      
      serviceNodes.push({
        id: serviceId,
        name: `${framework.charAt(0).toUpperCase() + framework.slice(1)} Service`,
        type: NavigationNodeType.BUILDING,
        level: HierarchyLevel.SERVICE,
        parent: 'system_root',
        children: [],
        componentIds: frameworkComponents.map(c => c.id),
        metadata: {
          complexity: frameworkComponents.reduce((sum, c) => sum + c.metadata.complexity, 0),
          componentCount: frameworkComponents.length,
          connectionCount: connections.filter(c => 
            frameworkComponents.some(comp => comp.id === c.from || comp.id === c.to)
          ).length,
          layer: 'infrastructure' as ArchitecturalLayer,
          framework,
          description: `${framework} service with ${frameworkComponents.length} components`,
          tags: [framework, 'service']
        }
      });
    }

    return serviceNodes;
  }

  private buildLayerNodes(
    components: ComponentNode[], 
    connections: Connection[], 
    parentNodes: NavigationHierarchy[]
  ): NavigationHierarchy[] {
    const layerNodes: NavigationHierarchy[] = [];
    
    for (const parent of parentNodes) {
      const parentComponents = components.filter(c => parent.componentIds.includes(c.id));
      const layerGroups = this.groupComponentsByLayer(parentComponents);
      
      for (const [layer, layerComponents] of layerGroups.entries()) {
        const layerId = `layer_${parent.id}_${layer}`;
        
        const layerNode: NavigationHierarchy = {
          id: layerId,
          name: `${layer.charAt(0).toUpperCase() + layer.slice(1)} Layer`,
          type: NavigationNodeType.FLOOR,
          level: HierarchyLevel.LAYER,
          parent: parent.id,
          children: [],
          componentIds: layerComponents.map(c => c.id),
          metadata: {
            complexity: layerComponents.reduce((sum, c) => sum + c.metadata.complexity, 0),
            componentCount: layerComponents.length,
            connectionCount: connections.filter(c => 
              layerComponents.some(comp => comp.id === c.from || comp.id === c.to)
            ).length,
            layer: layer as ArchitecturalLayer,
            framework: parent.metadata.framework,
            description: `${layer} layer with ${layerComponents.length} components`,
            tags: [layer, 'layer', parent.metadata.framework || '']
          }
        };

        layerNodes.push(layerNode);
        parent.children.push(layerId);
      }
    }

    return layerNodes;
  }

  private buildModuleNodes(
    components: ComponentNode[], 
    connections: Connection[], 
    parentNodes: NavigationHierarchy[]
  ): NavigationHierarchy[] {
    const moduleNodes: NavigationHierarchy[] = [];
    
    for (const parent of parentNodes) {
      const parentComponents = components.filter(c => parent.componentIds.includes(c.id));
      const moduleGroups = this.groupComponentsByModule(parentComponents);
      
      for (const [moduleName, moduleComponents] of moduleGroups.entries()) {
        const moduleId = `module_${parent.id}_${moduleName}`;
        
        const moduleNode: NavigationHierarchy = {
          id: moduleId,
          name: moduleName,
          type: NavigationNodeType.ZONE,
          level: HierarchyLevel.MODULE,
          parent: parent.id,
          children: [],
          componentIds: moduleComponents.map(c => c.id),
          metadata: {
            complexity: moduleComponents.reduce((sum, c) => sum + c.metadata.complexity, 0),
            componentCount: moduleComponents.length,
            connectionCount: connections.filter(c => 
              moduleComponents.some(comp => comp.id === c.from || comp.id === c.to)
            ).length,
            layer: parent.metadata.layer,
            framework: parent.metadata.framework,
            description: `${moduleName} module with ${moduleComponents.length} components`,
            tags: ['module', moduleName, parent.metadata.layer, parent.metadata.framework || '']
          }
        };

        moduleNodes.push(moduleNode);
        parent.children.push(moduleId);
      }
    }

    return moduleNodes;
  }

  private buildComponentNodes(
    components: ComponentNode[], 
    connections: Connection[], 
    parentNodes: NavigationHierarchy[]
  ): NavigationHierarchy[] {
    const componentNodes: NavigationHierarchy[] = [];
    
    for (const parent of parentNodes) {
      const parentComponents = components.filter(c => parent.componentIds.includes(c.id));
      
      for (const component of parentComponents) {
        const componentId = `nav_${component.id}`;
        
        const componentNode: NavigationHierarchy = {
          id: componentId,
          name: component.name,
          type: NavigationNodeType.ROOM,
          level: HierarchyLevel.COMPONENT,
          parent: parent.id,
          children: [],
          componentIds: [component.id],
          metadata: {
            complexity: component.metadata.complexity,
            componentCount: 1,
            connectionCount: component.dependencies.length + component.dependents.length,
            layer: component.metadata.layer,
            framework: component.framework,
            description: component.metadata.responsibilities?.join(', ') || `${component.type} component`,
            tags: [
              component.type, 
              component.metadata.layer, 
              component.framework || '', 
              ...component.metadata.tags || []
            ].filter(Boolean)
          }
        };

        componentNodes.push(componentNode);
        parent.children.push(componentId);
      }
    }

    return componentNodes;
  }

  private buildFunctionNodes(
    components: ComponentNode[], 
    parentNodes: NavigationHierarchy[]
  ): NavigationHierarchy[] {
    const functionNodes: NavigationHierarchy[] = [];
    
    for (const parent of parentNodes) {
      const component = components.find(c => parent.componentIds.includes(c.id));
      if (!component || !component.metadata.functions) continue;
      
      const functions = component.metadata.functions as any[];
      for (const func of functions) {
        const functionId = `function_${parent.id}_${func.name}`;
        
        const functionNode: NavigationHierarchy = {
          id: functionId,
          name: func.name,
          type: NavigationNodeType.FUNCTION,
          level: HierarchyLevel.FUNCTION,
          parent: parent.id,
          children: [],
          componentIds: [component.id],
          metadata: {
            complexity: func.complexity || 1,
            componentCount: 0,
            connectionCount: (func.calls?.length || 0) + (func.calledBy?.length || 0),
            layer: component.metadata.layer,
            framework: component.framework,
            description: `Function: ${func.name}`,
            tags: ['function', func.type || 'method', component.framework || ''].filter(Boolean)
          }
        };

        functionNodes.push(functionNode);
        parent.children.push(functionId);
      }
    }

    return functionNodes;
  }

  private groupComponentsByFramework(components: ComponentNode[]): Map<string, ComponentNode[]> {
    const groups = new Map<string, ComponentNode[]>();
    
    for (const component of components) {
      const framework = component.framework || 'unknown';
      if (!groups.has(framework)) {
        groups.set(framework, []);
      }
      groups.get(framework)!.push(component);
    }
    
    return groups;
  }

  private groupComponentsByLayer(components: ComponentNode[]): Map<string, ComponentNode[]> {
    const groups = new Map<string, ComponentNode[]>();
    
    for (const component of components) {
      const layer = component.metadata.layer || 'unknown';
      if (!groups.has(layer)) {
        groups.set(layer, []);
      }
      groups.get(layer)!.push(component);
    }
    
    return groups;
  }

  private groupComponentsByModule(components: ComponentNode[]): Map<string, ComponentNode[]> {
    const groups = new Map<string, ComponentNode[]>();
    
    for (const component of components) {
      // Try to extract module name from path or type
      const moduleName = this.extractModuleName(component);
      
      if (!groups.has(moduleName)) {
        groups.set(moduleName, []);
      }
      groups.get(moduleName)!.push(component);
    }
    
    return groups;
  }

  private extractModuleName(component: ComponentNode): string {
    // Extract module name from path or naming conventions
    if (component.path) {
      const pathParts = component.path.split('/').filter(p => p.length > 0);
      
      // Look for common module patterns
      for (let i = 0; i < pathParts.length - 1; i++) {
        const part = pathParts[i];
        if (['src', 'lib', 'components', 'services', 'controllers', 'modules'].includes(part)) {
          return pathParts[i + 1] || 'default';
        }
      }
      
      // Use directory name
      if (pathParts.length > 1) {
        return pathParts[pathParts.length - 2];
      }
    }
    
    // Fall back to component type or name
    if (component.type === 'controller' && component.name.includes('Controller')) {
      return component.name.replace('Controller', '');
    }
    
    if (component.type === 'service' && component.name.includes('Service')) {
      return component.name.replace('Service', '');
    }
    
    return component.type || 'default';
  }

  private integrateSpatialData(spatialBlueprint: SpatialBlueprint): void {
    // Map spatial rooms to hierarchy nodes
    for (const room of spatialBlueprint.rooms) {
      const navNode = this.hierarchyCache.get(room.id);
      if (navNode) {
        navNode.spatialBounds = {
          position: room.position,
          width: room.dimensions.width,
          height: room.dimensions.height,
          depth: room.dimensions.depth
        };
      }
    }

    // Map spatial buildings to service nodes
    for (const building of spatialBlueprint.buildings) {
      const navNode = this.hierarchyCache.get(building.id);
      if (navNode) {
        navNode.spatialBounds = {
          position: building.position,
          width: building.dimensions.width,
          height: building.dimensions.height,
          depth: building.dimensions.depth
        };
      }
    }
  }

  private buildBreadcrumbs(nodeId: string): BreadcrumbItem[] {
    if (this.breadcrumbCache.has(nodeId)) {
      return this.breadcrumbCache.get(nodeId)!;
    }

    const breadcrumbs: BreadcrumbItem[] = [];
    const path = this.getPathToRoot(nodeId);

    for (let i = 0; i < path.length; i++) {
      const currentNodeId = path[i];
      const node = this.hierarchyCache.get(currentNodeId);
      
      if (node) {
        breadcrumbs.push({
          id: currentNodeId,
          name: node.name,
          type: node.type,
          level: node.level,
          path: path.slice(0, i + 1).join('/'),
          active: i === path.length - 1
        });
      }
    }

    this.breadcrumbCache.set(nodeId, breadcrumbs);
    return breadcrumbs;
  }

  private getPathToRoot(nodeId: string): string[] {
    const path: string[] = [];
    let currentNodeId: string | undefined = nodeId;

    while (currentNodeId) {
      path.unshift(currentNodeId);
      const node = this.hierarchyCache.get(currentNodeId);
      currentNodeId = node?.parent;
    }

    return path;
  }

  private getSiblings(node: NavigationHierarchy): NavigationHierarchy[] {
    if (!node.parent) return [];

    const parent = this.hierarchyCache.get(node.parent);
    if (!parent) return [];

    return parent.children
      .filter(childId => childId !== node.id)
      .map(childId => this.hierarchyCache.get(childId)!)
      .filter(Boolean);
  }

  private getChildren(node: NavigationHierarchy, filter?: NavigationFilter): NavigationHierarchy[] {
    return node.children
      .map(childId => this.hierarchyCache.get(childId)!)
      .filter(Boolean)
      .filter(child => this.matchesFilter(child, filter))
      .sort((a, b) => {
        // Sort by complexity (descending) then by name
        const complexityDiff = b.metadata.complexity - a.metadata.complexity;
        return complexityDiff !== 0 ? complexityDiff : a.name.localeCompare(b.name);
      });
  }

  private getAvailableActions(node: NavigationHierarchy): NavigationAction[] {
    const actions: NavigationAction[] = [];

    // Drill down action
    if (node.children.length > 0) {
      actions.push({
        id: 'drill-down',
        type: 'drill-down',
        label: `Explore ${node.children.length} ${node.children.length === 1 ? 'item' : 'items'}`,
        icon: 'arrow-down',
        enabled: true,
        metadata: { childCount: node.children.length }
      });
    }

    // Drill up action
    if (node.parent) {
      actions.push({
        id: 'drill-up',
        type: 'drill-up',
        label: 'Go up',
        icon: 'arrow-up',
        enabled: true,
        targetId: node.parent
      });
    }

    // Zoom action (for components with spatial bounds)
    if (node.spatialBounds) {
      actions.push({
        id: 'zoom-to-fit',
        type: 'zoom',
        label: 'Zoom to fit',
        icon: 'zoom-in',
        enabled: true,
        metadata: { bounds: node.spatialBounds }
      });
    }

    // Filter action (for nodes with children)
    if (node.children.length > 5) {
      actions.push({
        id: 'filter',
        type: 'filter',
        label: 'Filter items',
        icon: 'filter',
        enabled: true
      });
    }

    return actions;
  }

  private getSpatialContext(node: NavigationHierarchy): NavigationContext['spatialContext'] {
    if (!node.spatialBounds) return undefined;

    return {
      currentRoom: {
        id: node.id,
        name: node.name,
        position: node.spatialBounds.position,
        dimensions: {
          width: node.spatialBounds.width,
          height: node.spatialBounds.height,
          depth: node.spatialBounds.depth
        },
        floor: node.level,
        metadata: {
          temperature: 20,
          complexity: node.metadata.complexity,
          framework: node.metadata.framework || '',
          layer: node.metadata.layer,
          tags: node.metadata.tags
        }
      },
      visibleRooms: [], // Would be populated based on spatial queries
      navigationPaths: [] // Would be populated based on connections
    };
  }

  private matchesFilter(node: NavigationHierarchy, filter?: NavigationFilter): boolean {
    if (!filter) return true;

    // Framework filter
    if (filter.framework && filter.framework.length > 0) {
      if (!node.metadata.framework || !filter.framework.includes(node.metadata.framework)) {
        return false;
      }
    }

    // Layer filter
    if (filter.layer && filter.layer.length > 0) {
      if (!filter.layer.includes(node.metadata.layer)) {
        return false;
      }
    }

    // Complexity filter
    if (filter.complexity) {
      const complexity = node.metadata.complexity;
      if (complexity < filter.complexity.min || complexity > filter.complexity.max) {
        return false;
      }
    }

    // Tags filter
    if (filter.tags && filter.tags.length > 0) {
      if (!filter.tags.some(tag => node.metadata.tags.includes(tag))) {
        return false;
      }
    }

    // Pattern filter
    if (filter.pattern) {
      if (!node.metadata.tags.some(tag => tag.includes(filter.pattern!))) {
        return false;
      }
    }

    return true;
  }

  private findBuildingForNode(nodeId: string): string | null {
    let current = this.hierarchyCache.get(nodeId);
    
    while (current) {
      if (current.type === NavigationNodeType.BUILDING) {
        return current.id;
      }
      if (!current.parent) break;
      current = this.hierarchyCache.get(current.parent);
    }
    
    return null;
  }

  private calculatePathDifficulty(waypoints: string[]): number {
    // Calculate difficulty based on level changes and hierarchy depth
    let difficulty = 1;
    
    for (let i = 1; i < waypoints.length; i++) {
      const current = this.hierarchyCache.get(waypoints[i]);
      const previous = this.hierarchyCache.get(waypoints[i - 1]);
      
      if (current && previous) {
        const levelDiff = Math.abs(current.level - previous.level);
        difficulty += levelDiff * 0.5;
      }
    }
    
    return Math.min(difficulty, 5); // Cap at 5
  }

  /**
   * Get all nodes at a specific hierarchy level
   */
  getNodesByLevel(level: HierarchyLevel, filter?: NavigationFilter): NavigationHierarchy[] {
    const nodes: NavigationHierarchy[] = [];
    
    for (const [, node] of this.hierarchyCache) {
      if (node.level === level && this.matchesFilter(node, filter)) {
        nodes.push(node);
      }
    }
    
    return nodes.sort((a, b) => {
      // Sort by component count (descending) then by name
      const countDiff = b.metadata.componentCount - a.metadata.componentCount;
      return countDiff !== 0 ? countDiff : a.name.localeCompare(b.name);
    });
  }

  /**
   * Get statistics for the current hierarchy
   */
  getHierarchyStats(): Record<string, number> {
    const stats: Record<string, number> = {
      totalNodes: this.hierarchyCache.size,
      systemNodes: 0,
      serviceNodes: 0,
      layerNodes: 0,
      moduleNodes: 0,
      componentNodes: 0,
      functionNodes: 0
    };

    for (const [, node] of this.hierarchyCache) {
      switch (node.level) {
        case HierarchyLevel.SYSTEM:
          stats.systemNodes++;
          break;
        case HierarchyLevel.SERVICE:
          stats.serviceNodes++;
          break;
        case HierarchyLevel.LAYER:
          stats.layerNodes++;
          break;
        case HierarchyLevel.MODULE:
          stats.moduleNodes++;
          break;
        case HierarchyLevel.COMPONENT:
          stats.componentNodes++;
          break;
        case HierarchyLevel.FUNCTION:
          stats.functionNodes++;
          break;
      }
    }

    return stats;
  }
}