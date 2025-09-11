// ActixWeb Framework Analyzer - Specialized analysis for Actix-web applications
// Phase 3: Framework Sub-Analyzers - Production-ready ActixWeb analyzer

import { RustAnalyzer } from '../../languages/rust-analyzer';
import { ComponentNode, ComponentType, Connection, APIEndpoint } from '../../../types';
import { telemetry } from '../../../telemetry/telemetry-schema';
import * as path from 'path';
import * as fs from 'fs-extra';

export interface ActixRoute {
  path: string;
  method: string;
  handler: string;
  guards: string[];
  extractors: string[];
}

export interface ActixHandler {
  name: string;
  filePath: string;
  async: boolean;
  returnType?: string;
  extractors: string[];
}

export interface ActixMiddleware {
  name: string;
  filePath: string;
  wrapsApp: boolean;
  order: number;
}

export interface ActixState {
  name: string;
  type: string;
  shared: boolean;
}

export class ActixWebAnalyzer extends RustAnalyzer {
  private actixVersion: string = '';
  private routes: Map<string, ActixRoute> = new Map();
  private handlers: Map<string, ActixHandler> = new Map();
  private middleware: Map<string, ActixMiddleware> = new Map();
  private appStates: Map<string, ActixState> = new Map();
  private hasDiesel: boolean = false;
  private hasSQLx: boolean = false;
  private hasWebSocket: boolean = false;
  
  getAnalyzerName(): string {
    return 'Actix-web Framework Analyzer';
  }

  getSupportedFrameworks(): string[] {
    return ['actix-web', 'actix-rt', 'diesel', 'sqlx', 'tokio'];
  }

  protected async detectLanguageAndFramework(): Promise<any> {
    const baseDetection = await super.detectLanguageAndFramework();
    
    // Detect Actix-web version from Cargo.toml
    await this.detectActixVersion();
    
    return {
      ...baseDetection,
      frameworks: [...baseDetection.frameworks.filter(f => !f.name.includes('actix')), {
        name: 'actix-web',
        version: this.actixVersion,
        confidence: 0.95,
        patterns: ['Actix-web framework detected'],
        configFiles: ['Cargo.toml', 'Cargo.lock', 'main.rs'],
        dependencies: ['actix-web']
      }]
    };
  }

  protected async discoverComponents(): Promise<any> {
    const span = telemetry.createSpan('actixweb-analyzer.discoverComponents');
    const baseDiscovery = await super.discoverComponents();
    
    // Discover Actix components
    await this.discoverRoutes();
    await this.discoverHandlers();
    await this.discoverMiddleware();
    await this.discoverAppStates();
    
    // Build component nodes
    const components = new Map<string, ComponentNode>();
    
    // Add routes as components
    for (const [id, route] of this.routes) {
      const node: ComponentNode = {
        id,
        name: `${route.method} ${route.path}`,
        type: ComponentType.API_HANDLER,
        path: route.handler,
        language: 'rust',
        framework: 'actix-web',
        dependencies: [...route.guards, ...route.extractors],
        metrics: {
          linesOfCode: 0,
          complexity: route.guards.length + route.extractors.length,
          maintainability: 100 - (route.guards.length + route.extractors.length) * 2,
          testCoverage: 0,
          duplicateCode: 0,
          technicalDebt: 0
        },
        relationships: [],
        metadata: {
          frameworkType: 'route',
          method: route.method,
          path: route.path,
          guards: route.guards,
          extractors: route.extractors
        }
      };
      components.set(id, node);
    }
    
    // Add handlers as components
    for (const [id, handler] of this.handlers) {
      const node: ComponentNode = {
        id,
        name: handler.name,
        type: ComponentType.SERVICE,
        path: handler.filePath,
        language: 'rust',
        framework: 'actix-web',
        dependencies: handler.extractors,
        metrics: {
          linesOfCode: 0,
          complexity: handler.extractors.length + 1,
          maintainability: 100 - handler.extractors.length * 2,
          testCoverage: 0,
          duplicateCode: 0,
          technicalDebt: 0
        },
        relationships: [],
        metadata: {
          frameworkType: 'handler',
          async: handler.async,
          returnType: handler.returnType,
          extractors: handler.extractors
        }
      };
      components.set(id, node);
    }
    
    // Add middleware as components
    for (const [id, mw] of this.middleware) {
      const node: ComponentNode = {
        id,
        name: mw.name,
        type: ComponentType.MIDDLEWARE,
        path: mw.filePath,
        language: 'rust',
        framework: 'actix-web',
        dependencies: [],
        metrics: {
          linesOfCode: 0,
          complexity: 2,
          maintainability: 95,
          testCoverage: 0,
          duplicateCode: 0,
          technicalDebt: 0
        },
        relationships: [],
        metadata: {
          frameworkType: 'middleware',
          wrapsApp: mw.wrapsApp,
          order: mw.order
        }
      };
      components.set(id, node);
    }
    
    const connections = await this.buildActixConnections();
    const apiEndpoints = this.extractActixEndpoints();
    
    telemetry.emit({
      type: 'component_discovery_completed',
      source: { analyzer: this.getAnalyzerName() },
      data: {
        totalComponents: components.size,
        routes: this.routes.size,
        handlers: this.handlers.size,
        middleware: this.middleware.size,
        appStates: this.appStates.size
      }
    });
    
    span.end();
    return {
      components: Array.from(components.values()),
      entryPoints: ['main.rs', 'src/main.rs', 'lib.rs', 'src/lib.rs'],
      connections,
      layers: this.buildActixLayers(),
      apiEndpoints,
      databaseConnections: []
    };
  }

  private async detectActixVersion(): Promise<void> {
    const cargoPath = path.join(this.projectPath, 'Cargo.toml');
    if (await fs.pathExists(cargoPath)) {
      const content = await fs.readFile(cargoPath, 'utf-8');
      const versionMatch = content.match(/actix-web\s*=\s*"([\d.]+)"/);
      if (versionMatch) {
        this.actixVersion = versionMatch[1];
      }
      
      this.hasDiesel = content.includes('diesel');
      this.hasSQLx = content.includes('sqlx');
      this.hasWebSocket = content.includes('actix-ws') || content.includes('actix-web-actors');
    }
  }

  private async discoverRoutes(): Promise<void> {
    const rustFiles = await this.findFiles(['**/*.rs'], this.options.excludePatterns);
    
    for (const file of rustFiles) {
      const content = await fs.readFile(file, 'utf-8');
      const routes = this.parseActixRoutes(content, file);
      
      for (const route of routes) {
        const id = `${route.method}_${route.path.replace(/[/{}/]/g, '_')}`;
        this.routes.set(id, route);
      }
    }
  }

  private parseActixRoutes(content: string, filePath: string): ActixRoute[] {
    const routes: ActixRoute[] = [];
    
    // Match route macros: #[get("/path")], #[post("/path")], etc.
    const macroRegex = /#\[(get|post|put|delete|patch|head)\("([^"]+)"\)\]/g;
    let match;
    
    while ((match = macroRegex.exec(content)) !== null) {
      const method = match[1].toUpperCase();
      const path = match[2];
      
      // Find the handler function after the macro
      const handlerRegex = new RegExp(`#\\[${match[1]}[^\\n]*\\n(?:pub\\s+)?(?:async\\s+)?fn\\s+(\\w+)`);
      const handlerMatch = content.match(handlerRegex);
      
      routes.push({
        path,
        method,
        handler: handlerMatch ? `${filePath}::${handlerMatch[1]}` : `${filePath}::handler`,
        guards: [],
        extractors: []
      });
    }
    
    // Match web::route() patterns
    const routeRegex = /web::route\(\)\.to\((\w+)\)/g;
    
    while ((match = routeRegex.exec(content)) !== null) {
      routes.push({
        path: '/',
        method: '*',
        handler: `${filePath}::${match[1]}`,
        guards: [],
        extractors: []
      });
    }
    
    return routes;
  }

  private async discoverHandlers(): Promise<void> {
    const rustFiles = await this.findFiles(['**/*.rs'], this.options.excludePatterns);
    
    for (const file of rustFiles) {
      const content = await fs.readFile(file, 'utf-8');
      const handlers = this.parseHandlers(content, file);
      
      for (const handler of handlers) {
        this.handlers.set(handler.name, handler);
      }
    }
  }

  private parseHandlers(content: string, filePath: string): ActixHandler[] {
    const handlers: ActixHandler[] = [];
    
    // Match handler functions with Actix extractors
    const handlerRegex = /(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*([^{]+))?\s*\{/g;
    let match;
    
    while ((match = handlerRegex.exec(content)) !== null) {
      const name = match[1];
      const params = match[2];
      const returnType = match[3]?.trim();
      
      // Check if it's an Actix handler by looking for extractors
      if (params.includes('HttpRequest') || params.includes('HttpResponse') || 
          params.includes('web::') || params.includes('Json<') || params.includes('Path<')) {
        
        const extractors = this.parseExtractors(params);
        
        handlers.push({
          name,
          filePath,
          async: content.includes(`async fn ${name}`),
          returnType,
          extractors
        });
      }
    }
    
    return handlers;
  }

  private parseExtractors(params: string): string[] {
    const extractors: string[] = [];
    
    const extractorTypes = ['HttpRequest', 'HttpResponse', 'web::Path', 'web::Query', 
                           'web::Json', 'web::Data', 'web::Header', 'web::Form'];
    
    for (const extractor of extractorTypes) {
      if (params.includes(extractor)) {
        extractors.push(extractor);
      }
    }
    
    return extractors;
  }

  private async discoverMiddleware(): Promise<void> {
    const rustFiles = await this.findFiles(['**/*.rs'], this.options.excludePatterns);
    let order = 0;
    
    for (const file of rustFiles) {
      const content = await fs.readFile(file, 'utf-8');
      
      // Check for middleware implementations
      if (content.includes('impl Transform') || content.includes('.wrap(')) {
        const middlewares = this.parseMiddleware(content, file, order);
        
        for (const mw of middlewares) {
          this.middleware.set(mw.name, mw);
          order++;
        }
      }
    }
  }

  private parseMiddleware(content: string, filePath: string, startOrder: number): ActixMiddleware[] {
    const middleware: ActixMiddleware[] = [];
    let order = startOrder;
    
    // Match middleware structs
    const structRegex = /struct\s+(\w+Middleware|\w+Guard)/g;
    let match;
    
    while ((match = structRegex.exec(content)) !== null) {
      middleware.push({
        name: match[1],
        filePath,
        wrapsApp: content.includes(`.wrap(${match[1]}`),
        order: order++
      });
    }
    
    // Match wrap calls
    const wrapRegex = /\.wrap\((\w+)/g;
    
    while ((match = wrapRegex.exec(content)) !== null) {
      if (!middleware.find(m => m.name === match[1])) {
        middleware.push({
          name: match[1],
          filePath,
          wrapsApp: true,
          order: order++
        });
      }
    }
    
    return middleware;
  }

  private async discoverAppStates(): Promise<void> {
    const rustFiles = await this.findFiles(['**/*.rs'], this.options.excludePatterns);
    
    for (const file of rustFiles) {
      const content = await fs.readFile(file, 'utf-8');
      
      // Check for app state usage
      if (content.includes('web::Data<') || content.includes('app_data(')) {
        const states = this.parseAppStates(content);
        
        for (const state of states) {
          this.appStates.set(state.name, state);
        }
      }
    }
  }

  private parseAppStates(content: string): ActixState[] {
    const states: ActixState[] = [];
    
    // Match web::Data<Type> patterns
    const dataRegex = /web::Data<(\w+)>/g;
    let match;
    
    while ((match = dataRegex.exec(content)) !== null) {
      states.push({
        name: match[1],
        type: match[1],
        shared: true
      });
    }
    
    return states;
  }

  private async buildActixConnections(): Promise<Connection[]> {
    const connections: Connection[] = [];
    
    // Route to Handler connections
    for (const [routeId, route] of this.routes) {
      const handlerName = route.handler.split('::').pop() || '';
      if (this.handlers.has(handlerName)) {
        connections.push({
          source: routeId,
          target: handlerName,
          type: 'route-handler',
          protocol: 'actix',
          metadata: {
            method: route.method,
            path: route.path
          }
        });
      }
    }
    
    // Middleware connections
    for (const [mwId, mw] of this.middleware) {
      if (mw.wrapsApp) {
        connections.push({
          source: 'actix-app',
          target: mwId,
          type: 'middleware-wrap',
          protocol: 'actix',
          metadata: {
            order: mw.order
          }
        });
      }
    }
    
    return connections;
  }

  private extractActixEndpoints(): APIEndpoint[] {
    const endpoints: APIEndpoint[] = [];
    
    for (const [id, route] of this.routes) {
      endpoints.push({
        path: route.path,
        method: route.method === '*' ? 'ALL' : route.method as APIEndpoint['method'],
        handler: route.handler,
        parameters: [],
        responses: [],
        middleware: route.guards,
        authentication: route.guards.length > 0,
        rateLimit: undefined,
        deprecated: false
      });
    }
    
    return endpoints;
  }

  private buildActixLayers(): Record<string, string[]> {
    return {
      'routes': Array.from(this.routes.keys()),
      'handlers': Array.from(this.handlers.keys()),
      'middleware': Array.from(this.middleware.keys()),
      'appStates': Array.from(this.appStates.keys())
    };
  }

  async analyzePerformance(): Promise<any> {
    const performance = await super.analyzePerformance();
    
    return {
      ...performance,
      actixweb: {
        routesCount: this.routes.size,
        handlersCount: this.handlers.size,
        middlewareCount: this.middleware.size,
        appStatesCount: this.appStates.size,
        features: {
          hasDiesel: this.hasDiesel,
          hasSQLx: this.hasSQLx,
          hasWebSocket: this.hasWebSocket
        }
      }
    };
  }
}