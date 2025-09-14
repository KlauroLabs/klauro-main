
import { TypeScriptJavaScriptAnalyzer } from '../../languages/typescript-javascript-analyzer';
import { ComponentNode, ComponentType, Connection, APIEndpoint, DatabaseConnection, ComponentMetadata } from '../../../types';
import { telemetry } from '../../../telemetry/telemetry-schema';
import * as path from 'path';
import * as fs from 'fs-extra';

export interface ExpressRoute {
  path: string;
  method: string;
  handler: string;
  middleware: string[];
  router?: string;
  params: string[];
  query: string[];
  body?: any;
}

export interface ExpressMiddleware {
  name: string;
  type: 'application' | 'router' | 'error' | 'custom';
  path?: string;
  order: number;
  global: boolean;
  errorHandler: boolean;
}

export interface ExpressRouter {
  name: string;
  filePath: string;
  basePath?: string;
  routes: ExpressRoute[];
  middleware: string[];
  subRouters: string[];
}

export interface ExpressStaticServe {
  path: string;
  directory: string;
  options: Record<string, any>;
}

export interface ExpressErrorHandler {
  name: string;
  filePath: string;
  statusCodes: number[];
  global: boolean;
}

export interface ExpressWebSocket {
  path: string;
  handler: string;
  events: string[];
  namespace?: string;
}

export class ExpressAnalyzer extends TypeScriptJavaScriptAnalyzer {
  private expressVersion: string = '';
  private routes: Map<string, ExpressRoute> = new Map();
  private routers: Map<string, ExpressRouter> = new Map();
  private middleware: Map<string, ExpressMiddleware> = new Map();
  private staticServes: ExpressStaticServe[] = [];
  private errorHandlers: Map<string, ExpressErrorHandler> = new Map();
  private websockets: Map<string, ExpressWebSocket> = new Map();
  private appInstances: string[] = [];
  private hasBodyParser: boolean = false;
  private hasCors: boolean = false;
  private hasHelmet: boolean = false;
  private hasCompression: boolean = false;
  private hasSession: boolean = false;
  private hasPassport: boolean = false;
  private hasSocketIO: boolean = false;
  private hasMongoose: boolean = false;
  private hasSequelize: boolean = false;
  private hasPrisma: boolean = false;
  
  getAnalyzerName(): string {
    return 'Express Framework Analyzer';
  }

  getSupportedFrameworks(): string[] {
    return ['express', 'body-parser', 'cors', 'helmet', 'compression', 'express-session', 'passport', 'socket.io'];
  }

  protected async detectLanguageAndFramework(): Promise<any> {
    const baseDetection = await super.detectLanguageAndFramework();
    
    await this.detectExpressVersion();
    
    if (!this.expressVersion) {
      return { ...baseDetection, confidence: 0 };
    }
    
    await this.detectExpressPackages();
    await this.findAppInstances();
    
    let confidence = 0;
    const patterns: string[] = [];
    
    if (this.expressVersion) {
      confidence += 0.3;
      patterns.push('Express in dependencies');
    }
    
    if (this.appInstances.length > 0) {
      confidence += 0.4;
      patterns.push(`${this.appInstances.length} Express app instance(s) found`);
    }
    
    const expressFiles = await this.findFiles(['**/*.{js,ts}'], this.options.excludePatterns || ['node_modules/**', 'dist/**', 'build/**']);
    let hasExpressRoutes = false;
    const samplesToCheck = expressFiles.slice(0, 20);
    
    for (const file of samplesToCheck) {
      try {
        const content = await fs.readFile(file, 'utf-8');
        if (content.includes('app.get(') || content.includes('app.post(') || 
            content.includes('app.put(') || content.includes('app.delete(') ||
            content.includes('router.get(') || content.includes('router.post(')) {
          hasExpressRoutes = true;
          break;
        }
      } catch {}
    }
    
    if (hasExpressRoutes) {
      confidence += 0.3;
      patterns.push('Express routes detected');
    }
    
    if (this.hasCors || this.hasHelmet || this.hasBodyParser) {
      confidence += 0.1;
      patterns.push('Express middleware packages detected');
    }
    
    return {
      ...baseDetection,
      confidence: Math.min(confidence, 1),
      frameworks: [...baseDetection.frameworks.filter(f => f.name !== 'express'), {
        name: 'express',
        version: this.expressVersion,
        confidence: Math.min(confidence, 1),
        patterns,
        configFiles: this.appInstances,
        dependencies: ['express']
      }]
    };
  }

  protected async discoverComponents(): Promise<any> {
    const span = telemetry.createSpan('express-analyzer.discoverComponents');
    const baseDiscovery = await super.discoverComponents();
    
    // Discover Express components
    await this.discoverRoutes();
    await this.discoverRouters();
    await this.discoverMiddleware();
    await this.discoverStaticServes();
    await this.discoverErrorHandlers();
    await this.discoverWebSockets();
    
    // Build component nodes
    const components = new Map<string, ComponentNode>();
    
    // Add routes as components
    for (const [id, route] of this.routes) {
      const node: ComponentNode = {
        id,
        name: `${route.method} ${route.path}`,
        type: 'route',
        path: route.handler,
        dependencies: route.middleware,
        dependents: [],
        metrics: {
          linesOfCode: 0,
          complexity: route.middleware.length + (route.params.length * 2),
          maintainability: 100 - route.middleware.length * 3,
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
          path: route.path
        } as ComponentMetadata & { path: string }
      };
      components.set(id, node);
    }
    
    // Add routers as components
    for (const [id, router] of this.routers) {
      const node: ComponentNode = {
        id,
        name: router.name,
        type: 'service',
        path: router.filePath,
        dependencies: router.subRouters,
        dependents: [],
        metrics: {
          linesOfCode: await this.countLinesOfCode(router.filePath),
          complexity: router.routes.length + router.middleware.length,
          maintainability: 100 - router.routes.length * 2,
          testCoverage: 0,
          duplicateCode: 0,
          technicalDebt: 0
        },
        metadata: {
          lineCount: 0,
          complexity: router.routes.length + router.middleware.length,
          lastModified: new Date(),
          exports: [],
          imports: [],
          layer: 'infrastructure',
          responsibilities: ['Route handling and middleware management'],
          basePath: router.basePath
        } as ComponentMetadata & { basePath: string }
      };
      components.set(id, node);
    }
    
    // Add middleware as components
    for (const [id, mw] of this.middleware) {
      const node: ComponentNode = {
        id,
        name: mw.name,
        type: 'middleware',
        path: mw.path || '',
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
          exports: [mw.name],
          imports: [],
          layer: 'infrastructure',
          responsibilities: ['Express middleware processing'],
          order: mw.order,
          global: mw.global
        } as ComponentMetadata & { order: number; global: boolean }
      };
      components.set(id, node);
    }
    
    // Build connections
    const connections = await this.buildExpressConnections();
    
    // Extract API endpoints
    const apiEndpoints = this.extractExpressEndpoints();
    
    // Extract database connections
    const databaseConnections = await this.extractDatabaseConnections();
    
    telemetry.emit({
      type: 'component_discovered',
      source: { analyzer: this.getAnalyzerName() },
      data: {
        totalComponents: components.size,
        routes: this.routes.size,
        routers: this.routers.size,
        middleware: this.middleware.size,
        staticServes: this.staticServes.length,
        errorHandlers: this.errorHandlers.size,
        websockets: this.websockets.size,
        hasBodyParser: this.hasBodyParser,
        hasCors: this.hasCors
      }
    });
    
    span.end();
    return {
      components: Array.from(components.values()),
      entryPoints: this.findExpressEntryPoints(),
      connections,
      layers: this.buildExpressLayers(),
      apiEndpoints,
      databaseConnections
    };
  }

  private async detectExpressVersion(): Promise<void> {
    // First, try the current directory
    const packageJsonPath = path.join(this.projectPath, 'package.json');
    if (await fs.pathExists(packageJsonPath)) {
      const packageJson = await fs.readJson(packageJsonPath);
      const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
      
      if (dependencies.express) {
        this.expressVersion = dependencies.express.replace(/[\^~]/, '');
        return;
      }
    }

    // If not found, search in subdirectories (common in monorepos)
    try {
      const items = await fs.readdir(this.projectPath);
      const subdirs = await Promise.all(
        items.map(async (item) => {
          const itemPath = path.join(this.projectPath, item);
          const isDir = (await fs.stat(itemPath)).isDirectory();
          return isDir ? item : null;
        })
      );

      for (const subdir of subdirs.filter(Boolean)) {
        const subPackageJsonPath = path.join(this.projectPath, subdir!, 'package.json');
        if (await fs.pathExists(subPackageJsonPath)) {
          const packageJson = await fs.readJson(subPackageJsonPath);
          const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
          
          if (dependencies.express) {
            this.expressVersion = dependencies.express.replace(/[\^~]/, '');
            // Update projectPath to the subdirectory for more accurate analysis
            this.projectPath = path.join(this.projectPath, subdir!);
            return;
          }
        }
      }
    } catch (error) {
      // Ignore errors when scanning subdirectories
    }
  }

  private async detectExpressPackages(): Promise<void> {
    const packageJsonPath = path.join(this.projectPath, 'package.json');
    if (await fs.pathExists(packageJsonPath)) {
      const packageJson = await fs.readJson(packageJsonPath);
      const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
      
      this.hasBodyParser = 'body-parser' in dependencies || 'express' in dependencies;
      this.hasCors = 'cors' in dependencies;
      this.hasHelmet = 'helmet' in dependencies;
      this.hasCompression = 'compression' in dependencies;
      this.hasSession = 'express-session' in dependencies;
      this.hasPassport = 'passport' in dependencies;
      this.hasSocketIO = 'socket.io' in dependencies;
      this.hasMongoose = 'mongoose' in dependencies;
      this.hasSequelize = 'sequelize' in dependencies;
      this.hasPrisma = '@prisma/client' in dependencies;
    }
  }

  private async findAppInstances(): Promise<void> {
    const appFiles = ['app.js', 'app.ts', 'server.js', 'server.ts', 'index.js', 'index.ts', 'main.js', 'main.ts'];
    
    for (const appFile of appFiles) {
      const fullPath = path.join(this.projectPath, appFile);
      if (await fs.pathExists(fullPath)) {
        const content = await fs.readFile(fullPath, 'utf-8');
        if (content.includes('express()') || content.includes('require("express")') || content.includes("require('express')") || content.includes('from "express"') || content.includes("from 'express'")) {
          this.appInstances.push(appFile);
        }
      }
    }
    
    // Search for Express instances in source files
    const srcFiles = await this.findFiles(['src/**/*.{js,ts}', 'lib/**/*.{js,ts}'], this.options.excludePatterns);
    for (const file of srcFiles.slice(0, 30)) {
      const content = await fs.readFile(file, 'utf-8');
      if (content.includes('express()') && !this.appInstances.includes(file)) {
        this.appInstances.push(file);
      }
    }
  }

  private async discoverRoutes(): Promise<void> {
    const jsFiles = await this.findFiles(['**/*.{js,jsx,ts,tsx}'], this.options.excludePatterns);
    
    for (const file of jsFiles) {
      const content = await fs.readFile(file, 'utf-8');
      const routes = this.parseExpressRoutes(content, file);
      
      for (const route of routes) {
        const id = `${route.method}_${route.path.replace(/[/:]/g, '_')}`;
        this.routes.set(id, route);
      }
    }
  }

  private parseExpressRoutes(content: string, filePath: string): ExpressRoute[] {
    const routes: ExpressRoute[] = [];
    
    // Match route definitions: app.get(), app.post(), etc.
    const routeRegex = /(?:app|router)\.(get|post|put|delete|patch|head|options|all)\s*\(\s*['"`]([^'"`]+)['"`]/g;
    let match;
    
    while ((match = routeRegex.exec(content)) !== null) {
      const method = match[1].toUpperCase();
      const path = match[2];
      
      // Extract middleware and handler
      const routeEndIndex = this.findClosingParen(content, match.index);
      const routeContent = content.substring(match.index, routeEndIndex);
      const middleware = this.extractMiddleware(routeContent);
      
      // Extract params from path
      const params = this.extractPathParams(path);
      
      routes.push({
        path,
        method: method === 'ALL' ? '*' : method,
        handler: `${filePath}::route_${method}_${path}`,
        middleware,
        params,
        query: []
      });
    }
    
    // Match route definitions with use() for all methods
    const useRegex = /(?:app|router)\.use\s*\(\s*['"`]([^'"`]+)['"`]/g;
    
    while ((match = useRegex.exec(content)) !== null) {
      const path = match[1];
      
      routes.push({
        path,
        method: '*',
        handler: `${filePath}::use_${path}`,
        middleware: [],
        params: this.extractPathParams(path),
        query: []
      });
    }
    
    return routes;
  }

  private findClosingParen(content: string, startIndex: number): number {
    let depth = 0;
    let inString = false;
    let stringChar = '';
    
    for (let i = startIndex; i < content.length; i++) {
      const char = content[i];
      
      if (!inString) {
        if (char === '"' || char === "'" || char === '`') {
          inString = true;
          stringChar = char;
        } else if (char === '(') {
          depth++;
        } else if (char === ')') {
          depth--;
          if (depth === 0) {
            return i + 1;
          }
        }
      } else {
        if (char === stringChar && content[i - 1] !== '\\') {
          inString = false;
        }
      }
    }
    
    return startIndex + 100; // Default fallback
  }

  private extractMiddleware(routeContent: string): string[] {
    const middleware: string[] = [];
    
    // Extract function names between commas
    const funcRegex = /,\s*(\w+)\s*[,)]/g;
    let match;
    
    while ((match = funcRegex.exec(routeContent)) !== null) {
      middleware.push(match[1]);
    }
    
    return middleware;
  }

  private extractPathParams(path: string): string[] {
    const params: string[] = [];
    const paramRegex = /:(\w+)/g;
    let match;
    
    while ((match = paramRegex.exec(path)) !== null) {
      params.push(match[1]);
    }
    
    return params;
  }

  private async discoverRouters(): Promise<void> {
    const jsFiles = await this.findFiles(['**/*.{js,jsx,ts,tsx}'], this.options.excludePatterns);
    
    for (const file of jsFiles) {
      const content = await fs.readFile(file, 'utf-8');
      
      // Check for Router instances
      if (content.includes('express.Router()') || content.includes('Router()')) {
        const routers = this.parseRouters(content, file);
        
        for (const router of routers) {
          this.routers.set(router.name, router);
        }
      }
    }
  }

  private parseRouters(content: string, filePath: string): ExpressRouter[] {
    const routers: ExpressRouter[] = [];
    
    // Match Router instantiation
    const routerRegex = /(?:const|let|var)\s+(\w+)\s*=\s*(?:express\.)?Router\s*\(/g;
    let match;
    
    while ((match = routerRegex.exec(content)) !== null) {
      const name = match[1];
      
      const router: ExpressRouter = {
        name,
        filePath,
        routes: [],
        middleware: [],
        subRouters: []
      };
      
      // Find routes defined on this router
      const routerRouteRegex = new RegExp(`${name}\\.(get|post|put|delete|patch|head|options|all)\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]`, 'g');
      let routeMatch;
      
      while ((routeMatch = routerRouteRegex.exec(content)) !== null) {
        router.routes.push({
          path: routeMatch[2],
          method: routeMatch[1].toUpperCase(),
          handler: `${filePath}::${name}_${routeMatch[1]}_${routeMatch[2]}`,
          middleware: [],
          router: name,
          params: this.extractPathParams(routeMatch[2]),
          query: []
        });
      }
      
      routers.push(router);
    }
    
    return routers;
  }

  private async discoverMiddleware(): Promise<void> {
    const jsFiles = await this.findFiles(['**/*.{js,jsx,ts,tsx}'], this.options.excludePatterns);
    
    let order = 0;
    for (const file of jsFiles) {
      const content = await fs.readFile(file, 'utf-8');
      
      // Check for middleware definitions
      const middlewares = this.parseMiddleware(content, file, order);
      
      for (const mw of middlewares) {
        this.middleware.set(mw.name, mw);
        order++;
      }
    }
  }

  private parseMiddleware(content: string, filePath: string, startOrder: number): ExpressMiddleware[] {
    const middleware: ExpressMiddleware[] = [];
    let order = startOrder;
    
    // Match app.use() middleware
    const useRegex = /app\.use\s*\(\s*([^)]+)\s*\)/g;
    let match;
    
    while ((match = useRegex.exec(content)) !== null) {
      const middlewareContent = match[1];
      
      // Check for known middleware
      if (middlewareContent.includes('bodyParser') || middlewareContent.includes('express.json')) {
        middleware.push({
          name: 'body-parser',
          type: 'application',
          path: filePath,
          order: order++,
          global: true,
          errorHandler: false
        });
      }
      
      if (middlewareContent.includes('cors')) {
        middleware.push({
          name: 'cors',
          type: 'application',
          path: filePath,
          order: order++,
          global: true,
          errorHandler: false
        });
      }
      
      if (middlewareContent.includes('helmet')) {
        middleware.push({
          name: 'helmet',
          type: 'application',
          path: filePath,
          order: order++,
          global: true,
          errorHandler: false
        });
      }
      
      if (middlewareContent.includes('compression')) {
        middleware.push({
          name: 'compression',
          type: 'application',
          path: filePath,
          order: order++,
          global: true,
          errorHandler: false
        });
      }
      
      // Check for error handling middleware (4 parameters)
      if (middlewareContent.includes('err,') || middlewareContent.includes('error,')) {
        middleware.push({
          name: 'error-handler',
          type: 'error',
          path: filePath,
          order: order++,
          global: true,
          errorHandler: true
        });
      }
    }
    
    return middleware;
  }

  private async discoverStaticServes(): Promise<void> {
    const jsFiles = await this.findFiles(['**/*.{js,jsx,ts,tsx}'], this.options.excludePatterns);
    
    for (const file of jsFiles.slice(0, 20)) {
      const content = await fs.readFile(file, 'utf-8');
      const statics = this.parseStaticServes(content);
      this.staticServes.push(...statics);
    }
  }

  private parseStaticServes(content: string): ExpressStaticServe[] {
    const statics: ExpressStaticServe[] = [];
    
    // Match express.static() calls
    const staticRegex = /app\.use\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*express\.static\s*\(\s*['"`]([^'"`]+)['"`]/g;
    let match;
    
    while ((match = staticRegex.exec(content)) !== null) {
      statics.push({
        path: match[1],
        directory: match[2],
        options: {}
      });
    }
    
    // Match express.static() without path
    const staticNoPrefixRegex = /app\.use\s*\(\s*express\.static\s*\(\s*['"`]([^'"`]+)['"`]/g;
    
    while ((match = staticNoPrefixRegex.exec(content)) !== null) {
      statics.push({
        path: '/',
        directory: match[1],
        options: {}
      });
    }
    
    return statics;
  }

  private async discoverErrorHandlers(): Promise<void> {
    const jsFiles = await this.findFiles(['**/*.{js,jsx,ts,tsx}'], this.options.excludePatterns);
    
    for (const file of jsFiles) {
      const content = await fs.readFile(file, 'utf-8');
      const handlers = this.parseErrorHandlers(content, file);
      
      for (const handler of handlers) {
        this.errorHandlers.set(handler.name, handler);
      }
    }
  }

  private parseErrorHandlers(content: string, filePath: string): ExpressErrorHandler[] {
    const handlers: ExpressErrorHandler[] = [];
    
    // Match error handling middleware (4 parameters)
    const errorHandlerRegex = /(?:app|router)\.use\s*\(\s*(?:async\s+)?(?:function\s*)?\s*\(\s*err/g;
    let match;
    let index = 0;
    
    while ((match = errorHandlerRegex.exec(content)) !== null) {
      handlers.push({
        name: `error_handler_${index++}`,
        filePath,
        statusCodes: [500],
        global: content.includes('app.use')
      });
    }
    
    // Match specific error handlers
    const specificErrorRegex = /app\.use\s*\(\s*\(\s*err[^)]+\)\s*=>\s*{[^}]*res\.status\s*\(\s*(\d+)\s*\)/g;
    
    while ((match = specificErrorRegex.exec(content)) !== null) {
      handlers.push({
        name: `error_handler_${match[1]}`,
        filePath,
        statusCodes: [parseInt(match[1])],
        global: true
      });
    }
    
    return handlers;
  }

  private async discoverWebSockets(): Promise<void> {
    if (!this.hasSocketIO) return;
    
    const jsFiles = await this.findFiles(['**/*.{js,jsx,ts,tsx}'], this.options.excludePatterns);
    
    for (const file of jsFiles) {
      const content = await fs.readFile(file, 'utf-8');
      
      if (content.includes('socket.io') || content.includes('io.on')) {
        const websockets = this.parseWebSockets(content, file);
        
        for (const ws of websockets) {
          this.websockets.set(ws.path, ws);
        }
      }
    }
  }

  private parseWebSockets(content: string, filePath: string): ExpressWebSocket[] {
    const websockets: ExpressWebSocket[] = [];
    
    // Match Socket.IO event handlers
    const eventRegex = /(?:io|socket)\.on\s*\(\s*['"`]([^'"`]+)['"`]/g;
    const events: string[] = [];
    let match;
    
    while ((match = eventRegex.exec(content)) !== null) {
      events.push(match[1]);
    }
    
    if (events.length > 0) {
      websockets.push({
        path: '/socket.io',
        handler: filePath,
        events,
        namespace: '/'
      });
    }
    
    // Match namespaces
    const namespaceRegex = /io\.of\s*\(\s*['"`]([^'"`]+)['"`]\)/g;
    
    while ((match = namespaceRegex.exec(content)) !== null) {
      websockets.push({
        path: match[1],
        handler: filePath,
        events: [],
        namespace: match[1]
      });
    }
    
    return websockets;
  }

  private async countLinesOfCode(filePath: string): Promise<number> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return content.split('\n').length;
    } catch {
      return 0;
    }
  }

  private async buildExpressConnections(): Promise<Connection[]> {
    const connections: Connection[] = [];
    
    // Router to Route connections
    for (const [routeId, route] of this.routes) {
      if (route.router) {
        connections.push({
          from: route.router,
          to: routeId,
          type: 'middleware_chain',
          weight: 1,
          metadata: {
            callSites: 1,
            httpMethod: route.method
          }
        });
      }
      
      // Route to Middleware connections
      for (const mw of route.middleware) {
        connections.push({
          from: routeId,
          to: mw,
          type: 'middleware_chain',
          weight: 1,
          metadata: {
            callSites: 1
          }
        });
      }
    }
    
    // Static serve connections
    for (const staticServe of this.staticServes) {
      connections.push({
        from: 'express-app',
        to: staticServe.directory,
        type: 'http_call',
        weight: 1,
        metadata: {
          callSites: 1
        }
      });
    }
    
    // WebSocket connections
    for (const [wsId, ws] of this.websockets) {
      connections.push({
        from: 'express-app',
        to: wsId,
        type: 'http_call',
        weight: 1,
        metadata: {
          callSites: 1
        }
      });
    }
    
    return connections;
  }

  private extractExpressEndpoints(): APIEndpoint[] {
    const endpoints: APIEndpoint[] = [];
    
    for (const [id, route] of this.routes) {
      endpoints.push({
        id,
        path: route.path,
        method: route.method === '*' ? 'GET' : route.method as APIEndpoint['method'],
        description: `${route.method} ${route.path}`,
        handler: route.handler,
        parameters: route.params.map(p => ({
          name: p,
          type: 'path',
          dataType: 'string',
          required: true
        })),
        statusCodes: [{ code: 200, description: 'Success' }],
        middleware: route.middleware,
        authentication: (route.middleware.includes('authenticate') || route.middleware.includes('auth') || this.hasPassport) ? { type: 'bearer', required: true } : { type: 'none', required: false },
        rateLimit: route.middleware.includes('rateLimit') ? { requests: 100, window: '1m', strategy: 'fixed-window' } : undefined,
        deprecated: false,
        componentId: id
      });
    }
    
    // Add WebSocket endpoints
    for (const [wsId, ws] of this.websockets) {
      endpoints.push({
        id: wsId,
        path: ws.path,
        method: 'WS' as any,
        description: `WebSocket ${ws.path}`,
        handler: ws.handler,
        parameters: [],
        statusCodes: [{ code: 101, description: 'Switching Protocols' }],
        middleware: [],
        authentication: { type: 'none', required: false },
        rateLimit: undefined,
        deprecated: false,
        componentId: wsId
      });
    }
    
    return endpoints;
  }

  private async extractDatabaseConnections(): Promise<DatabaseConnection[]> {
    const connections: DatabaseConnection[] = [];
    
    // Check for Mongoose (MongoDB)
    if (this.hasMongoose) {
      connections.push({
        id: 'mongoose',
        name: 'MongoDB (Mongoose)',
        type: 'mongodb',
        host: 'localhost',
        port: 27017,
        database: 'app',
        usage: [{ componentId: 'express-models', operations: [{ type: 'read', tables: [], complexity: 1, optimized: true }], frequency: 1, critical: true }],
        componentIds: ['express-models']
      });
    }
    
    // Check for Sequelize (SQL)
    if (this.hasSequelize) {
      connections.push({
        id: 'sequelize',
        name: 'SQL (Sequelize)',
        type: 'postgresql',
        host: 'localhost',
        port: 5432,
        database: 'app',
        usage: [{ componentId: 'express-models', operations: [{ type: 'read', tables: [], complexity: 1, optimized: true }], frequency: 1, critical: true }],
        componentIds: ['express-models']
      });
    }
    
    // Check for Prisma
    if (this.hasPrisma) {
      connections.push({
        id: 'prisma',
        name: 'Prisma ORM',
        type: 'postgresql',
        host: 'localhost',
        port: 5432,
        database: 'app',
        usage: [{ componentId: 'express-models', operations: [{ type: 'read', tables: [], complexity: 1, optimized: true }], frequency: 1, critical: true }],
        componentIds: ['express-models']
      });
    }
    
    return connections;
  }

  private findExpressEntryPoints(): string[] {
    const entryPoints: string[] = [];
    
    // Add main app files
    entryPoints.push(...this.appInstances);
    
    // Add common Express patterns
    entryPoints.push('bin/www', 'server.js', 'app.js', 'index.js');
    
    return [...new Set(entryPoints)];
  }

  private buildExpressLayers(): Record<string, string[]> {
    return {
      'routes': Array.from(this.routes.keys()),
      'routers': Array.from(this.routers.keys()),
      'middleware': Array.from(this.middleware.keys()),
      'errorHandlers': Array.from(this.errorHandlers.keys()),
      'staticServes': this.staticServes.map(s => s.path),
      'websockets': Array.from(this.websockets.keys())
    };
  }

  async analyzePerformance(): Promise<any> {
    // Base performance metrics
    
    return {
      express: {
        routesCount: this.routes.size,
        routersCount: this.routers.size,
        middlewareCount: this.middleware.size,
        staticServesCount: this.staticServes.length,
        errorHandlersCount: this.errorHandlers.size,
        websocketsCount: this.websockets.size,
        averageMiddlewarePerRoute: this.calculateAverageMiddleware(),
        features: {
          hasBodyParser: this.hasBodyParser,
          hasCors: this.hasCors,
          hasHelmet: this.hasHelmet,
          hasCompression: this.hasCompression,
          hasSession: this.hasSession,
          hasPassport: this.hasPassport,
          hasSocketIO: this.hasSocketIO,
          hasMongoose: this.hasMongoose,
          hasSequelize: this.hasSequelize,
          hasPrisma: this.hasPrisma
        }
      }
    };
  }

  private calculateAverageMiddleware(): number {
    const routes = Array.from(this.routes.values());
    if (routes.length === 0) return 0;
    
    const totalMiddleware = routes.reduce((sum, r) => sum + r.middleware.length, 0);
    return totalMiddleware / routes.length;
  }
}