// Gin Framework Analyzer - Specialized analysis for Gin framework applications
// Phase 3: Framework Sub-Analyzers - Production-ready Gin analyzer

import { GoAnalyzer } from '../../languages/go-analyzer';
import { ComponentNode, ComponentType, Connection, APIEndpoint, ComponentMetadata } from '../../../types';
import { telemetry } from '../../../telemetry/telemetry-schema';
import * as path from 'path';
import * as fs from 'fs-extra';

export interface GinRoute {
  path: string;
  method: string;
  handler: string;
  middleware: string[];
  group?: string;
}

export interface GinMiddleware {
  name: string;
  filePath: string;
  global: boolean;
  order: number;
}

export interface GinRouterGroup {
  name: string;
  basePath: string;
  routes: GinRoute[];
  middleware: string[];
}

export class GinAnalyzer extends GoAnalyzer {
  private ginVersion: string = '';
  private routes: Map<string, GinRoute> = new Map();
  private middleware: Map<string, GinMiddleware> = new Map();
  private routerGroups: Map<string, GinRouterGroup> = new Map();
  private hasGORM: boolean = false;
  private hasRedis: boolean = false;
  
  getAnalyzerName(): string {
    return 'Gin Framework Analyzer';
  }

  getSupportedFrameworks(): string[] {
    return ['gin', 'gin-gonic', 'gorm', 'go-redis'];
  }

  protected async detectLanguageAndFramework(): Promise<any> {
    const baseDetection = await super.detectLanguageAndFramework();
    
    // Detect Gin version from go.mod
    await this.detectGinVersion();
    
    return {
      ...baseDetection,
      frameworks: [...baseDetection.frameworks.filter(f => !f.name.includes('gin')), {
        name: 'gin',
        version: this.ginVersion,
        confidence: 0.95,
        patterns: ['Gin framework detected'],
        configFiles: ['go.mod', 'go.sum', 'main.go'],
        dependencies: ['github.com/gin-gonic/gin']
      }]
    };
  }

  protected async discoverComponents(): Promise<any> {
    const span = telemetry.createSpan('gin-analyzer.discoverComponents');
    const baseDiscovery = await super.discoverComponents();
    
    // Discover Gin components
    await this.discoverRoutes();
    await this.discoverMiddleware();
    await this.discoverRouterGroups();
    
    // Build component nodes
    const components = new Map<string, ComponentNode>();
    
    // Add routes as components
    for (const [id, route] of this.routes) {
      const node: ComponentNode = {
        id,
        name: `${route.method} ${route.path}`,
        type: 'controller',
        path: route.handler,
        language: 'go',
        framework: 'gin',
        dependencies: route.middleware,
        dependents: [],
        metrics: {
          linesOfCode: 0,
          complexity: route.middleware.length + 1,
          maintainability: 100 - route.middleware.length * 2,
          testCoverage: 0,
          duplicateCode: 0,
          technicalDebt: 0
        },
        metadata: {
          lineCount: 0,
          complexity: route.middleware.length + 1,
          lastModified: new Date(),
          exports: [],
          imports: [],
          httpMethods: [route.method],
          layer: 'presentation',
          responsibilities: [`Handle ${route.method} requests to ${route.path}`],
          frameworkType: 'route',
          method: route.method,
          path: route.path
        } as ComponentMetadata & { frameworkType: string; method: string; path: string }
      };
      components.set(id, node);
    }
    
    // Add middleware as components
    for (const [id, mw] of this.middleware) {
      const node: ComponentNode = {
        id,
        name: mw.name,
        type: 'middleware',
        path: mw.filePath,
        language: 'go',
        framework: 'gin',
        dependencies: [],
        dependents: [],
        metrics: {
          linesOfCode: 0,
          complexity: 2,
          maintainability: 95,
          testCoverage: 0,
          duplicateCode: 0,
          technicalDebt: 0
        },
        metadata: {
          lineCount: 0,
          complexity: 2,
          lastModified: new Date(),
          exports: [],
          imports: [],
          layer: 'infrastructure',
          responsibilities: ['Middleware processing'],
          frameworkType: 'middleware',
          global: mw.global,
          order: mw.order
        } as ComponentMetadata & { frameworkType: string; global: boolean; order: number }
      };
      components.set(id, node);
    }
    
    const connections = await this.buildGinConnections();
    const apiEndpoints = this.extractGinEndpoints();
    
    telemetry.emit({
      type: 'component_discovery_completed',
      source: { analyzer: this.getAnalyzerName() },
      data: {
        totalComponents: components.size,
        routes: this.routes.size,
        middleware: this.middleware.size,
        routerGroups: this.routerGroups.size
      }
    });
    
    span.end();
    return {
      components: Array.from(components.values()),
      entryPoints: ['main.go'],
      connections,
      layers: this.buildGinLayers(),
      apiEndpoints,
      databaseConnections: []
    };
  }

  private async detectGinVersion(): Promise<void> {
    const goModPath = path.join(this.projectPath, 'go.mod');
    if (await fs.pathExists(goModPath)) {
      const content = await fs.readFile(goModPath, 'utf-8');
      const versionMatch = content.match(/github\.com\/gin-gonic\/gin\s+v([\d.]+)/);
      if (versionMatch) {
        this.ginVersion = versionMatch[1];
      }
      
      this.hasGORM = content.includes('gorm.io/gorm');
      this.hasRedis = content.includes('github.com/go-redis/redis');
    }
  }

  private async discoverRoutes(): Promise<void> {
    const goFiles = await this.findFiles(['**/*.go'], this.options.excludePatterns);
    
    for (const file of goFiles) {
      const content = await fs.readFile(file, 'utf-8');
      const routes = this.parseGinRoutes(content, file);
      
      for (const route of routes) {
        const id = `${route.method}_${route.path.replace(/[/:]/g, '_')}`;
        this.routes.set(id, route);
      }
    }
  }

  private parseGinRoutes(content: string, filePath: string): GinRoute[] {
    const routes: GinRoute[] = [];
    const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
    
    for (const method of methods) {
      const regex = new RegExp(`\\w+\\.${method}\\("([^"]+)"\\s*,\\s*(\\w+)`, 'g');
      let match;
      
      while ((match = regex.exec(content)) !== null) {
        routes.push({
          path: match[1],
          method,
          handler: `${filePath}::${match[2]}`,
          middleware: []
        });
      }
    }
    
    // Parse Any routes
    const anyRegex = /\w+\.Any\("([^"]+)"\s*,\s*(\w+)/g;
    let match;
    
    while ((match = anyRegex.exec(content)) !== null) {
      routes.push({
        path: match[1],
        method: '*',
        handler: `${filePath}::${match[2]}`,
        middleware: []
      });
    }
    
    return routes;
  }

  private async discoverMiddleware(): Promise<void> {
    const goFiles = await this.findFiles(['**/*.go'], this.options.excludePatterns);
    let order = 0;
    
    for (const file of goFiles) {
      const content = await fs.readFile(file, 'utf-8');
      
      // Check for middleware usage
      if (content.includes('.Use(') || content.includes('gin.HandlerFunc')) {
        const middlewares = this.parseMiddleware(content, file, order);
        
        for (const mw of middlewares) {
          this.middleware.set(mw.name, mw);
          order++;
        }
      }
    }
  }

  private parseMiddleware(content: string, filePath: string, startOrder: number): GinMiddleware[] {
    const middleware: GinMiddleware[] = [];
    let order = startOrder;
    
    // Match .Use() calls
    const useRegex = /\.Use\((\w+)\)/g;
    let match;
    
    while ((match = useRegex.exec(content)) !== null) {
      middleware.push({
        name: match[1],
        filePath,
        global: content.includes('r.Use(') || content.includes('router.Use('),
        order: order++
      });
    }
    
    return middleware;
  }

  private async discoverRouterGroups(): Promise<void> {
    const goFiles = await this.findFiles(['**/*.go'], this.options.excludePatterns);
    
    for (const file of goFiles) {
      const content = await fs.readFile(file, 'utf-8');
      
      // Check for router groups
      const groups = this.parseRouterGroups(content);
      
      for (const group of groups) {
        this.routerGroups.set(group.name, group);
      }
    }
  }

  private parseRouterGroups(content: string): GinRouterGroup[] {
    const groups: GinRouterGroup[] = [];
    const groupRegex = /(\w+)\s*:=\s*\w+\.Group\("([^"]+)"/g;
    let match;
    let index = 0;
    
    while ((match = groupRegex.exec(content)) !== null) {
      groups.push({
        name: match[1],
        basePath: match[2],
        routes: [],
        middleware: []
      });
      index++;
    }
    
    return groups;
  }

  private async buildGinConnections(): Promise<Connection[]> {
    const connections: Connection[] = [];
    
    // Route to Middleware connections
    for (const [routeId, route] of this.routes) {
      for (const mw of route.middleware) {
        connections.push({
          from: routeId,
          to: mw,
          type: 'uses-middleware',
          protocol: 'gin',
          metadata: {
            callSites: 1,
            middlewareName: mw
          }
        });
      }
    }
    
    // Router Group to Route connections
    for (const [groupId, group] of this.routerGroups) {
      for (const route of group.routes) {
        connections.push({
          from: groupId,
          to: `${route.method}_${route.path}`,
          type: 'contains',
          protocol: 'gin',
          metadata: {
            callSites: 1,
            basePath: group.basePath
          }
        });
      }
    }
    
    return connections;
  }

  private extractGinEndpoints(): APIEndpoint[] {
    const endpoints: APIEndpoint[] = [];
    
    for (const [id, route] of this.routes) {
      endpoints.push({
        id: `gin-${id}`,
        path: route.path,
        method: route.method === '*' ? 'GET' : route.method as APIEndpoint['method'], // Use GET as fallback for '*'
        description: `Gin ${route.method} endpoint for ${route.path}`,
        handler: route.handler,
        parameters: [],
        statusCodes: [{ code: 200, description: 'Success' }],
        middleware: route.middleware,
        authentication: {
          type: route.middleware.some(m => m.toLowerCase().includes('auth')) ? 'jwt' : 'none',
          required: route.middleware.some(m => m.toLowerCase().includes('auth'))
        },
        rateLimit: undefined,
        deprecated: false,
        componentId: id
      });
    }
    
    return endpoints;
  }

  private buildGinLayers(): Record<string, string[]> {
    return {
      'routes': Array.from(this.routes.keys()),
      'middleware': Array.from(this.middleware.keys()),
      'routerGroups': Array.from(this.routerGroups.keys())
    };
  }

  async analyzePerformance(): Promise<any> {
    // Base performance metrics
    
    return {
      gin: {
        routesCount: this.routes.size,
        middlewareCount: this.middleware.size,
        routerGroupsCount: this.routerGroups.size,
        features: {
          hasGORM: this.hasGORM,
          hasRedis: this.hasRedis
        }
      }
    };
  }
}