import { Injectable } from '@nestjs/common';
import { BaseAnalyzer } from '../analyzer/base-analyzer';

export interface SpatialNode {
  id: string;
  type: 'system' | 'service' | 'component' | 'class' | 'function' | 'variable';
  name: string;
  description: string;
  level: number;
  position: { x: number; y: number };
  size: { width: number; height: number };
  metrics: {
    complexity: number;
    dependencies: number;
    calls: number;
    lines: number;
  };
  children: string[];
  parent?: string;
  connections: Connection[];
  entryPoints: EntryPoint[];
  exitPoints: ExitPoint[];
  metadata: Record<string, any>;
}

export interface Connection {
  id: string;
  source: string;
  target: string;
  type: 'data-flow' | 'dependency' | 'event' | 'api-call' | 'database';
  label: string;
  strength: number;
  metadata: {
    frequency?: number;
    latency?: number;
    dataType?: string;
    protocol?: string;
  };
}

export interface EntryPoint {
  id: string;
  type: 'http' | 'websocket' | 'message-queue' | 'scheduled' | 'cli' | 'ui';
  path?: string;
  method?: string;
  description: string;
  authentication?: string;
  parameters?: any[];
}

export interface ExitPoint {
  id: string;
  type: 'database' | 'api' | 'file' | 'message' | 'email' | 'cache';
  target: string;
  operation?: string;
  description: string;
}

export interface SpatialManifest {
  nodes: Map<string, SpatialNode>;
  rootNodes: string[];
  connections: Connection[];
  layout: LayoutConfig;
  telemetryPoints: TelemetryPoint[];
}

export interface LayoutConfig {
  type: 'hierarchical' | 'force-directed' | 'grid' | 'custom';
  spacing: { x: number; y: number };
  cardSize: { min: number; max: number };
}

export interface TelemetryPoint {
  nodeId: string;
  metric: string;
  threshold: number;
  severity: 'info' | 'warning' | 'error';
}

@Injectable()
export class SpatialAnalyzer {
  async analyzeSpatialStructure(analysisResult: any): Promise<SpatialManifest> {
    const nodes = new Map<string, SpatialNode>();
    const connections: Connection[] = [];
    const rootNodes: string[] = [];

    // Build spatial hierarchy
    this.buildSystemNode(analysisResult, nodes, rootNodes);
    this.buildServiceNodes(analysisResult, nodes);
    this.buildComponentNodes(analysisResult, nodes);
    this.extractConnections(analysisResult, connections);
    this.identifyEntryExitPoints(analysisResult, nodes);

    // Calculate optimal layout
    const layout = this.calculateLayout(nodes, connections);

    // Identify telemetry points
    const telemetryPoints = this.identifyTelemetryPoints(nodes);

    return {
      nodes,
      rootNodes,
      connections,
      layout,
      telemetryPoints,
    };
  }

  private buildSystemNode(
    analysis: any,
    nodes: Map<string, SpatialNode>,
    rootNodes: string[]
  ): void {
    const systemId = 'system-root';
    const systemNode: SpatialNode = {
      id: systemId,
      type: 'system',
      name: analysis.projectName || 'System',
      description: 'Top-level system overview',
      level: 0,
      position: { x: 0, y: 0 },
      size: { width: 1200, height: 800 },
      metrics: {
        complexity: 0,
        dependencies: 0,
        calls: 0,
        lines: analysis.totalLines || 0,
      },
      children: [],
      connections: [],
      entryPoints: [],
      exitPoints: [],
      metadata: {
        language: analysis.language,
        framework: analysis.framework,
        pattern: analysis.pattern,
      },
    };

    nodes.set(systemId, systemNode);
    rootNodes.push(systemId);
  }

  private buildServiceNodes(analysis: any, nodes: Map<string, SpatialNode>): void {
    const systemNode = nodes.get('system-root');
    if (!systemNode) return;

    // Extract services/modules
    const services = this.extractServices(analysis);
    services.forEach((service, index) => {
      const serviceId = `service-${service.name}`;
      const serviceNode: SpatialNode = {
        id: serviceId,
        type: 'service',
        name: service.name,
        description: service.description || `${service.name} service`,
        level: 1,
        position: this.calculateCardPosition(index, services.length, 1),
        size: { width: 300, height: 200 },
        metrics: {
          complexity: service.complexity || 0,
          dependencies: service.dependencies?.length || 0,
          calls: service.calls || 0,
          lines: service.lines || 0,
        },
        children: [],
        parent: 'system-root',
        connections: [],
        entryPoints: [],
        exitPoints: [],
        metadata: service.metadata || {},
      };

      nodes.set(serviceId, serviceNode);
      systemNode.children.push(serviceId);
    });
  }

  private buildComponentNodes(analysis: any, nodes: Map<string, SpatialNode>): void {
    // Extract components for each service
    nodes.forEach(node => {
      if (node.type === 'service') {
        const components = this.extractComponents(analysis, node.name);
        components.forEach((component, index) => {
          const componentId = `component-${node.id}-${component.name}`;
          const componentNode: SpatialNode = {
            id: componentId,
            type: 'component',
            name: component.name,
            description: component.description || `${component.name} component`,
            level: 2,
            position: this.calculateCardPosition(index, components.length, 2),
            size: { width: 250, height: 150 },
            metrics: {
              complexity: component.complexity || 0,
              dependencies: component.dependencies?.length || 0,
              calls: component.calls || 0,
              lines: component.lines || 0,
            },
            children: [],
            parent: node.id,
            connections: [],
            entryPoints: [],
            exitPoints: [],
            metadata: component.metadata || {},
          };

          nodes.set(componentId, componentNode);
          node.children.push(componentId);

          // Add classes and functions
          this.buildClassNodes(component, componentNode, nodes);
        });
      }
    });
  }

  private buildClassNodes(
    component: any,
    parentNode: SpatialNode,
    nodes: Map<string, SpatialNode>
  ): void {
    if (component.classes) {
      component.classes.forEach((cls: any, index: number) => {
        const classId = `class-${parentNode.id}-${cls.name}`;
        const classNode: SpatialNode = {
          id: classId,
          type: 'class',
          name: cls.name,
          description: cls.description || `${cls.name} class`,
          level: 3,
          position: this.calculateCardPosition(index, component.classes.length, 3),
          size: { width: 200, height: 120 },
          metrics: {
            complexity: cls.complexity || 0,
            dependencies: cls.dependencies?.length || 0,
            calls: cls.methods?.length || 0,
            lines: cls.lines || 0,
          },
          children: [],
          parent: parentNode.id,
          connections: [],
          entryPoints: [],
          exitPoints: [],
          metadata: {
            methods: cls.methods,
            properties: cls.properties,
          },
        };

        nodes.set(classId, classNode);
        parentNode.children.push(classId);

        // Add methods as function nodes
        if (cls.methods) {
          cls.methods.forEach((method: any, methodIndex: number) => {
            const functionId = `function-${classId}-${method.name}`;
            const functionNode: SpatialNode = {
              id: functionId,
              type: 'function',
              name: method.name,
              description: method.description || `${method.name} method`,
              level: 4,
              position: this.calculateCardPosition(methodIndex, cls.methods.length, 4),
              size: { width: 150, height: 100 },
              metrics: {
                complexity: method.complexity || 0,
                dependencies: method.dependencies?.length || 0,
                calls: method.calls || 0,
                lines: method.lines || 0,
              },
              children: [],
              parent: classId,
              connections: [],
              entryPoints: [],
              exitPoints: [],
              metadata: {
                parameters: method.parameters,
                returnType: method.returnType,
                async: method.async,
              },
            };

            nodes.set(functionId, functionNode);
            classNode.children.push(functionId);
          });
        }
      });
    }
  }

  private extractServices(analysis: any): any[] {
    // Extract services based on project structure
    const services = [];
    
    if (analysis.modules) {
      services.push(...analysis.modules);
    }
    
    if (analysis.controllers) {
      services.push(...analysis.controllers.map((c: any) => ({
        name: c.name,
        type: 'controller',
        ...c
      })));
    }
    
    if (analysis.services) {
      services.push(...analysis.services);
    }

    // If no explicit services, create from file structure
    if (services.length === 0 && analysis.files) {
      const serviceMap = new Map();
      analysis.files.forEach((file: any) => {
        const serviceName = this.extractServiceName(file.path);
        if (!serviceMap.has(serviceName)) {
          serviceMap.set(serviceName, {
            name: serviceName,
            files: [],
            lines: 0,
          });
        }
        const service = serviceMap.get(serviceName);
        service.files.push(file);
        service.lines += file.lines || 0;
      });
      services.push(...Array.from(serviceMap.values()));
    }

    return services;
  }

  private extractComponents(analysis: any, serviceName: string): any[] {
    const components = [];
    
    // Extract components based on service
    if (analysis.components) {
      components.push(...analysis.components.filter((c: any) => 
        c.service === serviceName || c.module === serviceName
      ));
    }

    // Extract from classes
    if (analysis.classes) {
      const serviceClasses = analysis.classes.filter((c: any) =>
        c.path?.includes(serviceName) || c.module === serviceName
      );
      components.push(...serviceClasses.map((c: any) => ({
        name: c.name,
        type: 'class',
        classes: [c],
        ...c
      })));
    }

    return components;
  }

  private extractServiceName(filePath: string): string {
    const parts = filePath.split('/');
    // Look for common service indicators
    const serviceIndicators = ['services', 'modules', 'controllers', 'routes', 'api'];
    
    for (let i = 0; i < parts.length; i++) {
      if (serviceIndicators.includes(parts[i]) && i + 1 < parts.length) {
        return parts[i + 1];
      }
    }
    
    // Fallback to first meaningful directory
    return parts.find(p => p && p !== 'src' && p !== 'app') || 'default';
  }

  private extractConnections(analysis: any, connections: Connection[]): void {
    // Extract imports as dependencies
    if (analysis.imports) {
      analysis.imports.forEach((imp: any) => {
        connections.push({
          id: `conn-${imp.from}-${imp.to}`,
          source: imp.from,
          target: imp.to,
          type: 'dependency',
          label: imp.name || 'imports',
          strength: 1,
          metadata: {
            dataType: imp.type,
          },
        });
      });
    }

    // Extract API calls
    if (analysis.apiCalls) {
      analysis.apiCalls.forEach((call: any) => {
        connections.push({
          id: `api-${call.from}-${call.to}`,
          source: call.from,
          target: call.to,
          type: 'api-call',
          label: call.endpoint || 'API call',
          strength: call.frequency || 1,
          metadata: {
            frequency: call.frequency,
            latency: call.latency,
            protocol: call.protocol || 'http',
          },
        });
      });
    }

    // Extract database connections
    if (analysis.databaseCalls) {
      analysis.databaseCalls.forEach((db: any) => {
        connections.push({
          id: `db-${db.from}-${db.table}`,
          source: db.from,
          target: `db-${db.table}`,
          type: 'database',
          label: db.operation || 'query',
          strength: db.frequency || 1,
          metadata: {
            frequency: db.frequency,
            dataType: db.table,
          },
        });
      });
    }
  }

  private identifyEntryExitPoints(analysis: any, nodes: Map<string, SpatialNode>): void {
    // Identify HTTP endpoints
    if (analysis.endpoints) {
      analysis.endpoints.forEach((endpoint: any) => {
        const node = this.findNodeForEndpoint(endpoint, nodes);
        if (node) {
          node.entryPoints.push({
            id: `entry-${endpoint.path}`,
            type: 'http',
            path: endpoint.path,
            method: endpoint.method,
            description: endpoint.description || `${endpoint.method} ${endpoint.path}`,
            authentication: endpoint.auth,
            parameters: endpoint.parameters,
          });
        }
      });
    }

    // Identify database operations
    if (analysis.databaseOperations) {
      analysis.databaseOperations.forEach((op: any) => {
        const node = this.findNodeForOperation(op, nodes);
        if (node) {
          node.exitPoints.push({
            id: `exit-db-${op.table}`,
            type: 'database',
            target: op.table,
            operation: op.type,
            description: `${op.type} ${op.table}`,
          });
        }
      });
    }

    // Identify external API calls
    if (analysis.externalApis) {
      analysis.externalApis.forEach((api: any) => {
        const node = this.findNodeForApi(api, nodes);
        if (node) {
          node.exitPoints.push({
            id: `exit-api-${api.url}`,
            type: 'api',
            target: api.url,
            operation: api.method,
            description: `${api.method} ${api.url}`,
          });
        }
      });
    }
  }

  private findNodeForEndpoint(endpoint: any, nodes: Map<string, SpatialNode>): SpatialNode | null {
    // Find the node that contains this endpoint
    for (const node of nodes.values()) {
      if (node.metadata?.endpoints?.includes(endpoint.path)) {
        return node;
      }
    }
    return nodes.get('system-root') || null;
  }

  private findNodeForOperation(op: any, nodes: Map<string, SpatialNode>): SpatialNode | null {
    // Find the node that performs this operation
    for (const node of nodes.values()) {
      if (node.name === op.source || node.metadata?.file === op.file) {
        return node;
      }
    }
    return null;
  }

  private findNodeForApi(api: any, nodes: Map<string, SpatialNode>): SpatialNode | null {
    // Find the node that makes this API call
    for (const node of nodes.values()) {
      if (node.name === api.source || node.metadata?.file === api.file) {
        return node;
      }
    }
    return null;
  }

  private calculateCardPosition(
    index: number,
    total: number,
    level: number
  ): { x: number; y: number } {
    const baseSpacing = 350;
    const levelOffset = 250;
    const rowSize = Math.ceil(Math.sqrt(total));
    const row = Math.floor(index / rowSize);
    const col = index % rowSize;

    return {
      x: col * baseSpacing + (level * 50),
      y: row * levelOffset + (level * levelOffset),
    };
  }

  private calculateLayout(
    nodes: Map<string, SpatialNode>,
    connections: Connection[]
  ): LayoutConfig {
    const nodeCount = nodes.size;
    const connectionCount = connections.length;

    // Determine best layout based on complexity
    let layoutType: 'hierarchical' | 'force-directed' | 'grid' | 'custom' = 'hierarchical';
    
    if (connectionCount > nodeCount * 2) {
      layoutType = 'force-directed';
    } else if (nodeCount > 50) {
      layoutType = 'grid';
    }

    return {
      type: layoutType,
      spacing: {
        x: 300,
        y: 200,
      },
      cardSize: {
        min: 100,
        max: 400,
      },
    };
  }

  private identifyTelemetryPoints(nodes: Map<string, SpatialNode>): TelemetryPoint[] {
    const telemetryPoints: TelemetryPoint[] = [];

    nodes.forEach(node => {
      // Add complexity monitoring
      if (node.metrics.complexity > 10) {
        telemetryPoints.push({
          nodeId: node.id,
          metric: 'complexity',
          threshold: 10,
          severity: node.metrics.complexity > 20 ? 'error' : 'warning',
        });
      }

      // Add performance monitoring for functions
      if (node.type === 'function') {
        telemetryPoints.push({
          nodeId: node.id,
          metric: 'execution_time',
          threshold: 1000,
          severity: 'warning',
        });
      }

      // Add error rate monitoring for entry points
      if (node.entryPoints.length > 0) {
        telemetryPoints.push({
          nodeId: node.id,
          metric: 'error_rate',
          threshold: 0.05,
          severity: 'error',
        });
      }
    });

    return telemetryPoints;
  }

  async generateVisualizationData(manifest: SpatialManifest): Promise<any> {
    return {
      nodes: Array.from(manifest.nodes.values()),
      connections: manifest.connections,
      layout: manifest.layout,
      telemetryPoints: manifest.telemetryPoints,
      metadata: {
        totalNodes: manifest.nodes.size,
        totalConnections: manifest.connections.length,
        maxDepth: Math.max(...Array.from(manifest.nodes.values()).map(n => n.level)),
      },
    };
  }
}