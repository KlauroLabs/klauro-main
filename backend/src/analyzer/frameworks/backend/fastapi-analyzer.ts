// FastAPI Framework Analyzer - Specialized analysis for FastAPI applications
// Phase 3: Framework Sub-Analyzers - Production-ready FastAPI analyzer

import { PythonAnalyzer } from '../../languages/python-analyzer';
import { ComponentNode, ComponentType, Connection, APIEndpoint, DatabaseConnection } from '../../../types';
import { telemetry } from '../../../telemetry/telemetry-schema';
import * as path from 'path';
import * as fs from 'fs-extra';

export interface FastAPIRoute {
  path: string;
  method: string;
  handler: string;
  tags: string[];
  summary?: string;
  description?: string;
  deprecated: boolean;
  responses: Record<string, any>;
  parameters: FastAPIParameter[];
  requestBody?: FastAPIRequestBody;
  dependencies: string[];
  security: string[];
}

export interface FastAPIParameter {
  name: string;
  location: 'path' | 'query' | 'header' | 'cookie';
  type: string;
  required: boolean;
  default?: any;
  description?: string;
  validators: string[];
}

export interface FastAPIRequestBody {
  model: string;
  required: boolean;
  mediaType: string;
}

export interface FastAPIDependency {
  name: string;
  function: string;
  scope: 'request' | 'session' | 'global';
  cacheable: boolean;
}

export interface PydanticModel {
  name: string;
  filePath: string;
  baseModel: string;
  fields: PydanticField[];
  validators: string[];
  config: Record<string, any>;
  examples: any[];
}

export interface PydanticField {
  name: string;
  type: string;
  required: boolean;
  default?: any;
  alias?: string;
  description?: string;
  validators: string[];
  constraints: Record<string, any>;
}

export interface FastAPIMiddleware {
  name: string;
  type: 'function' | 'class';
  path: string;
  priority: number;
  async: boolean;
}

export interface FastAPIWebSocket {
  path: string;
  handler: string;
  accepts: string[];
  events: string[];
}

export class FastAPIAnalyzer extends PythonAnalyzer {
  private fastAPIVersion: string = '';
  private routes: Map<string, FastAPIRoute> = new Map();
  private models: Map<string, PydanticModel> = new Map();
  private dependencies: Map<string, FastAPIDependency> = new Map();
  private middleware: FastAPIMiddleware[] = [];
  private websockets: FastAPIWebSocket[] = [];
  private routers: Map<string, any> = new Map();
  private hasUvicorn: boolean = false;
  private hasGunicorn: boolean = false;
  private hasSQLAlchemy: boolean = false;
  private hasTortoise: boolean = false;
  private hasRedis: boolean = false;
  private appInstances: string[] = [];
  
  getAnalyzerName(): string {
    return 'FastAPI Framework Analyzer';
  }

  getSupportedFrameworks(): string[] {
    return ['fastapi', 'starlette', 'pydantic', 'uvicorn'];
  }

  protected async detectLanguageAndFramework(): Promise<any> {
    const baseDetection = await super.detectLanguageAndFramework();
    
    // Check for FastAPI in requirements
    await this.detectFastAPIVersion();
    
    // Detect FastAPI ecosystem
    this.hasUvicorn = await this.detectPackage('uvicorn');
    this.hasGunicorn = await this.detectPackage('gunicorn');
    this.hasSQLAlchemy = await this.detectPackage('sqlalchemy');
    this.hasTortoise = await this.detectPackage('tortoise-orm');
    this.hasRedis = await this.detectPackage('redis');
    
    // Find main app files
    await this.findAppInstances();
    
    return {
      ...baseDetection,
      frameworks: [...baseDetection.frameworks.filter(f => f.name !== 'fastapi'), {
        name: 'fastapi',
        version: this.fastAPIVersion,
        confidence: 0.98,
        patterns: ['FastAPI application detected'],
        configFiles: ['main.py', 'app.py', 'api.py'],
        dependencies: ['fastapi', 'pydantic', 'starlette']
      }]
    };
  }

  protected async discoverComponents(): Promise<any> {
    const span = telemetry.createSpan('fastapi-analyzer.discoverComponents');
    const baseDiscovery = await super.discoverComponents();
    
    // Discover FastAPI components
    await this.discoverRoutes();
    await this.discoverPydanticModels();
    await this.discoverDependencies();
    await this.discoverMiddleware();
    await this.discoverWebSockets();
    await this.discoverRouters();
    
    // Build component nodes
    const components = new Map<string, ComponentNode>();
    
    // Add routes as components
    for (const [id, route] of this.routes) {
      const node: ComponentNode = {
        id,
        name: `${route.method} ${route.path}`,
        type: ComponentType.API_HANDLER,
        path: route.handler,
        language: 'python',
        framework: 'fastapi',
        dependencies: route.dependencies,
        metrics: {
          linesOfCode: 0,
          complexity: route.parameters.length + (route.requestBody ? 2 : 0),
          maintainability: 100 - route.parameters.length * 2,
          testCoverage: 0,
          duplicateCode: 0,
          technicalDebt: route.deprecated ? 5 : 0
        },
        relationships: [],
        metadata: {
          frameworkType: 'route',
          method: route.method,
          path: route.path,
          tags: route.tags,
          summary: route.summary,
          deprecated: route.deprecated,
          parameters: route.parameters,
          requestBody: route.requestBody,
          responses: route.responses,
          security: route.security
        }
      };
      components.set(id, node);
    }
    
    // Add Pydantic models as components
    for (const [id, model] of this.models) {
      const node: ComponentNode = {
        id,
        name: model.name,
        type: ComponentType.DATA_MODEL,
        path: model.filePath,
        language: 'python',
        framework: 'fastapi',
        dependencies: [],
        metrics: {
          linesOfCode: await this.countLinesOfCode(model.filePath),
          complexity: model.fields.length + model.validators.length,
          maintainability: 100 - model.fields.length * 1.5,
          testCoverage: 0,
          duplicateCode: 0,
          technicalDebt: 0
        },
        relationships: [],
        metadata: {
          frameworkType: 'pydantic-model',
          baseModel: model.baseModel,
          fields: model.fields,
          validators: model.validators,
          config: model.config
        }
      };
      components.set(id, node);
    }
    
    // Add dependencies as components
    for (const [id, dep] of this.dependencies) {
      const node: ComponentNode = {
        id,
        name: dep.name,
        type: ComponentType.SERVICE,
        path: dep.function,
        language: 'python',
        framework: 'fastapi',
        dependencies: [],
        metrics: {
          linesOfCode: 0,
          complexity: 2,
          maintainability: 90,
          testCoverage: 0,
          duplicateCode: 0,
          technicalDebt: 0
        },
        relationships: [],
        metadata: {
          frameworkType: 'dependency',
          scope: dep.scope,
          cacheable: dep.cacheable
        }
      };
      components.set(id, node);
    }
    
    // Build connections
    const connections = await this.buildFastAPIConnections();
    
    // Extract API endpoints
    const apiEndpoints = this.extractFastAPIEndpoints();
    
    // Extract database connections
    const databaseConnections = await this.extractDatabaseConnections();
    
    telemetry.emit({
      type: 'component_discovery_completed',
      source: { analyzer: this.getAnalyzerName() },
      data: {
        totalComponents: components.size,
        routes: this.routes.size,
        models: this.models.size,
        dependencies: this.dependencies.size,
        middleware: this.middleware.length,
        websockets: this.websockets.length,
        hasUvicorn: this.hasUvicorn,
        hasSQLAlchemy: this.hasSQLAlchemy
      }
    });
    
    span.end();
    return {
      components: Array.from(components.values()),
      entryPoints: this.findFastAPIEntryPoints(),
      connections,
      layers: this.buildFastAPILayers(),
      apiEndpoints,
      databaseConnections
    };
  }

  private async detectFastAPIVersion(): Promise<void> {
    const requirementsPaths = [
      'requirements.txt',
      'requirements/base.txt',
      'Pipfile',
      'pyproject.toml'
    ];
    
    for (const reqPath of requirementsPaths) {
      const fullPath = path.join(this.projectPath, reqPath);
      if (await fs.pathExists(fullPath)) {
        const content = await fs.readFile(fullPath, 'utf-8');
        const versionMatch = content.match(/fastapi(?:==|>=|~=|>)?([\d.]+)/i);
        if (versionMatch) {
          this.fastAPIVersion = versionMatch[1];
          break;
        }
      }
    }
  }

  private async detectPackage(packageName: string): Promise<boolean> {
    const requirementsPaths = [
      'requirements.txt',
      'requirements/base.txt',
      'Pipfile',
      'pyproject.toml'
    ];
    
    for (const reqPath of requirementsPaths) {
      const fullPath = path.join(this.projectPath, reqPath);
      if (await fs.pathExists(fullPath)) {
        const content = await fs.readFile(fullPath, 'utf-8');
        if (content.toLowerCase().includes(packageName.toLowerCase())) {
          return true;
        }
      }
    }
    
    return false;
  }

  private async findAppInstances(): Promise<void> {
    const appFiles = ['main.py', 'app.py', 'api.py', 'server.py'];
    
    for (const appFile of appFiles) {
      const fullPath = path.join(this.projectPath, appFile);
      if (await fs.pathExists(fullPath)) {
        const content = await fs.readFile(fullPath, 'utf-8');
        if (content.includes('FastAPI()')) {
          this.appInstances.push(appFile);
        }
      }
    }
    
    // Search for FastAPI instances in all Python files
    const pythonFiles = await this.findFiles(['**/*.py'], this.options.excludePatterns);
    for (const file of pythonFiles.slice(0, 50)) {
      const content = await fs.readFile(file, 'utf-8');
      if (content.includes('FastAPI()') && !this.appInstances.includes(file)) {
        this.appInstances.push(file);
      }
    }
  }

  private async discoverRoutes(): Promise<void> {
    const pythonFiles = await this.findFiles(['**/*.py'], this.options.excludePatterns);
    
    for (const file of pythonFiles) {
      const content = await fs.readFile(file, 'utf-8');
      const routes = this.parseFastAPIRoutes(content, file);
      
      for (const route of routes) {
        const id = `${route.method}_${route.path.replace(/[/{}/]/g, '_')}`;
        this.routes.set(id, route);
      }
    }
  }

  private parseFastAPIRoutes(content: string, filePath: string): FastAPIRoute[] {
    const routes: FastAPIRoute[] = [];
    
    // Match route decorators
    const routeRegex = /@(?:app|router)\.(get|post|put|delete|patch|head|options)\s*\(\s*["']([^"']+)["']/g;
    const lines = content.split('\n');
    
    let match;
    while ((match = routeRegex.exec(content)) !== null) {
      const method = match[1].toUpperCase();
      const path = match[2];
      
      // Find the function definition after the decorator
      const decoratorIndex = content.substring(0, match.index).split('\n').length;
      let handler = '';
      let summary = '';
      let tags: string[] = [];
      let deprecated = false;
      
      // Look for the function definition
      for (let i = decoratorIndex; i < Math.min(decoratorIndex + 10, lines.length); i++) {
        const line = lines[i];
        const funcMatch = line.match(/^(?:async\s+)?def\s+(\w+)/);
        if (funcMatch) {
          handler = funcMatch[1];
          break;
        }
      }
      
      // Extract decorator parameters
      const decoratorEndIndex = content.indexOf(')', match.index) + 1;
      const decoratorContent = content.substring(match.index, decoratorEndIndex);
      
      // Extract tags
      const tagsMatch = decoratorContent.match(/tags\s*=\s*\[([^\]]+)\]/);
      if (tagsMatch) {
        tags = this.parseStringList(tagsMatch[1]);
      }
      
      // Extract summary
      const summaryMatch = decoratorContent.match(/summary\s*=\s*["']([^"']+)["']/);
      if (summaryMatch) {
        summary = summaryMatch[1];
      }
      
      // Check if deprecated
      deprecated = decoratorContent.includes('deprecated=True');
      
      // Extract parameters from function signature
      const parameters = this.extractRouteParameters(content, handler);
      
      // Extract request body if present
      const requestBody = this.extractRequestBody(content, handler);
      
      // Extract dependencies
      const dependencies = this.extractRouteDependencies(decoratorContent);
      
      routes.push({
        path,
        method,
        handler: `${filePath}::${handler}`,
        tags,
        summary,
        deprecated,
        responses: {},
        parameters,
        requestBody,
        dependencies,
        security: []
      });
    }
    
    return routes;
  }

  private extractRouteParameters(content: string, handler: string): FastAPIParameter[] {
    const parameters: FastAPIParameter[] = [];
    
    // Find function definition
    const funcRegex = new RegExp(`(?:async\\s+)?def\\s+${handler}\\s*\\(([^)]+)\\)`);
    const funcMatch = content.match(funcRegex);
    
    if (funcMatch) {
      const params = funcMatch[1];
      const paramRegex = /(\w+)\s*:\s*([^=,]+)(?:\s*=\s*([^,]+))?/g;
      let match;
      
      while ((match = paramRegex.exec(params)) !== null) {
        const name = match[1];
        const type = match[2].trim();
        const defaultValue = match[3]?.trim();
        
        // Skip common parameters
        if (name === 'request' || name === 'response' || name === 'db') continue;
        
        // Determine parameter location
        let location: FastAPIParameter['location'] = 'query';
        if (type.includes('Path')) location = 'path';
        if (type.includes('Query')) location = 'query';
        if (type.includes('Header')) location = 'header';
        if (type.includes('Cookie')) location = 'cookie';
        
        parameters.push({
          name,
          location,
          type: type.replace(/.*\[(.+)\].*/, '$1'),
          required: !defaultValue || defaultValue === '...',
          default: defaultValue && defaultValue !== '...' ? defaultValue : undefined,
          validators: []
        });
      }
    }
    
    return parameters;
  }

  private extractRequestBody(content: string, handler: string): FastAPIRequestBody | undefined {
    const funcRegex = new RegExp(`(?:async\\s+)?def\\s+${handler}\\s*\\(([^)]+)\\)`);
    const funcMatch = content.match(funcRegex);
    
    if (funcMatch) {
      const params = funcMatch[1];
      
      // Look for Pydantic model parameters
      const modelRegex = /(\w+)\s*:\s*([A-Z]\w+)(?:\s*=|,|\))/;
      const match = params.match(modelRegex);
      
      if (match && !['Request', 'Response', 'Session'].includes(match[2])) {
        return {
          model: match[2],
          required: true,
          mediaType: 'application/json'
        };
      }
    }
    
    return undefined;
  }

  private extractRouteDependencies(decoratorContent: string): string[] {
    const dependencies: string[] = [];
    
    const dependsMatch = decoratorContent.match(/dependencies\s*=\s*\[([^\]]+)\]/);
    if (dependsMatch) {
      const depList = dependsMatch[1];
      const depRegex = /Depends\s*\(\s*(\w+)/g;
      let match;
      
      while ((match = depRegex.exec(depList)) !== null) {
        dependencies.push(match[1]);
      }
    }
    
    return dependencies;
  }

  private async discoverPydanticModels(): Promise<void> {
    const pythonFiles = await this.findFiles(['**/*.py'], this.options.excludePatterns);
    
    for (const file of pythonFiles) {
      const content = await fs.readFile(file, 'utf-8');
      
      // Check if file imports Pydantic
      if (content.includes('from pydantic') || content.includes('import pydantic')) {
        const models = this.parsePydanticModels(content, file);
        
        for (const model of models) {
          this.models.set(model.name, model);
        }
      }
    }
  }

  private parsePydanticModels(content: string, filePath: string): PydanticModel[] {
    const models: PydanticModel[] = [];
    const modelRegex = /class\s+(\w+)\s*\(([^)]*BaseModel[^)]*)\)\s*:/g;
    let match;
    
    while ((match = modelRegex.exec(content)) !== null) {
      const name = match[1];
      const baseModel = match[2].trim();
      
      const model: PydanticModel = {
        name,
        filePath,
        baseModel,
        fields: this.parsePydanticFields(content, name),
        validators: this.parsePydanticValidators(content, name),
        config: this.parsePydanticConfig(content, name),
        examples: []
      };
      
      models.push(model);
    }
    
    return models;
  }

  private parsePydanticFields(content: string, className: string): PydanticField[] {
    const fields: PydanticField[] = [];
    
    // Find class definition
    const classRegex = new RegExp(`class\\s+${className}\\s*\\([^)]+\\)\\s*:([^\\n]*(?:\\n(?!class)[^\\n]*)*)`, 's');
    const classMatch = content.match(classRegex);
    
    if (classMatch) {
      const classContent = classMatch[1];
      const fieldRegex = /(\w+)\s*:\s*([^=\n]+)(?:\s*=\s*([^\n]+))?/g;
      let match;
      
      while ((match = fieldRegex.exec(classContent)) !== null) {
        const name = match[1];
        const type = match[2].trim();
        const defaultValue = match[3]?.trim();
        
        // Skip special attributes
        if (name.startsWith('_') || name === 'Config') continue;
        
        fields.push({
          name,
          type,
          required: !defaultValue || defaultValue === '...',
          default: defaultValue && defaultValue !== '...' ? defaultValue : undefined,
          validators: [],
          constraints: this.extractFieldConstraints(defaultValue)
        });
      }
    }
    
    return fields;
  }

  private extractFieldConstraints(defaultValue?: string): Record<string, any> {
    const constraints: Record<string, any> = {};
    
    if (!defaultValue) return constraints;
    
    // Extract Field constraints
    if (defaultValue.includes('Field(')) {
      const gtMatch = defaultValue.match(/gt\s*=\s*(\d+)/);
      if (gtMatch) constraints.gt = parseInt(gtMatch[1]);
      
      const geMatch = defaultValue.match(/ge\s*=\s*(\d+)/);
      if (geMatch) constraints.ge = parseInt(geMatch[1]);
      
      const ltMatch = defaultValue.match(/lt\s*=\s*(\d+)/);
      if (ltMatch) constraints.lt = parseInt(ltMatch[1]);
      
      const leMatch = defaultValue.match(/le\s*=\s*(\d+)/);
      if (leMatch) constraints.le = parseInt(leMatch[1]);
      
      const minLengthMatch = defaultValue.match(/min_length\s*=\s*(\d+)/);
      if (minLengthMatch) constraints.minLength = parseInt(minLengthMatch[1]);
      
      const maxLengthMatch = defaultValue.match(/max_length\s*=\s*(\d+)/);
      if (maxLengthMatch) constraints.maxLength = parseInt(maxLengthMatch[1]);
      
      const regexMatch = defaultValue.match(/regex\s*=\s*["']([^"']+)["']/);
      if (regexMatch) constraints.regex = regexMatch[1];
    }
    
    return constraints;
  }

  private parsePydanticValidators(content: string, className: string): string[] {
    const validators: string[] = [];
    
    // Find validators in class
    const validatorRegex = new RegExp(`@validator\\(['"]?(\\w+)['"]?`, 'g');
    let match;
    
    while ((match = validatorRegex.exec(content)) !== null) {
      validators.push(match[1]);
    }
    
    // Find root validators
    if (content.includes('@root_validator')) {
      validators.push('root_validator');
    }
    
    return validators;
  }

  private parsePydanticConfig(content: string, className: string): Record<string, any> {
    const config: Record<string, any> = {};
    
    // Find Config class
    const configRegex = new RegExp(`class\\s+${className}[^}]+class\\s+Config\\s*:([^\\n]*(?:\\n(?!\\s*class)[^\\n]*)*)`, 's');
    const configMatch = content.match(configRegex);
    
    if (configMatch) {
      const configContent = configMatch[1];
      
      // Parse common config options
      if (configContent.includes('orm_mode = True')) {
        config.orm_mode = true;
      }
      
      if (configContent.includes('use_enum_values = True')) {
        config.use_enum_values = true;
      }
      
      if (configContent.includes('validate_assignment = True')) {
        config.validate_assignment = true;
      }
      
      const schemaExtraMatch = configContent.match(/schema_extra\s*=\s*({[^}]+})/);
      if (schemaExtraMatch) {
        config.schema_extra = schemaExtraMatch[1];
      }
    }
    
    return config;
  }

  private async discoverDependencies(): Promise<void> {
    const pythonFiles = await this.findFiles(['**/*.py'], this.options.excludePatterns);
    
    for (const file of pythonFiles.slice(0, 50)) {
      const content = await fs.readFile(file, 'utf-8');
      const deps = this.parseDependencies(content, file);
      
      for (const dep of deps) {
        this.dependencies.set(dep.name, dep);
      }
    }
  }

  private parseDependencies(content: string, filePath: string): FastAPIDependency[] {
    const dependencies: FastAPIDependency[] = [];
    
    // Find dependency functions
    const depRegex = /(?:async\s+)?def\s+(\w+)\s*\([^)]*\)\s*(?:->\s*[^:]+)?:/g;
    let match;
    
    while ((match = depRegex.exec(content)) !== null) {
      const name = match[1];
      
      // Check if this function is used with Depends
      if (content.includes(`Depends(${name})`) || content.includes(`Depends(${name},`)) {
        dependencies.push({
          name,
          function: `${filePath}::${name}`,
          scope: 'request',
          cacheable: content.includes(`Depends(${name}, use_cache=True)`)
        });
      }
    }
    
    return dependencies;
  }

  private async discoverMiddleware(): Promise<void> {
    const pythonFiles = await this.findFiles(['**/*.py'], this.options.excludePatterns);
    
    for (const file of pythonFiles) {
      const content = await fs.readFile(file, 'utf-8');
      
      // Check for middleware definitions
      if (content.includes('@app.middleware') || content.includes('app.add_middleware')) {
        const middlewares = this.parseMiddleware(content, file);
        this.middleware.push(...middlewares);
      }
    }
  }

  private parseMiddleware(content: string, filePath: string): FastAPIMiddleware[] {
    const middleware: FastAPIMiddleware[] = [];
    
    // Function middleware
    const funcMiddlewareRegex = /@app\.middleware\(["'](\w+)["']\)\s*(?:async\s+)?def\s+(\w+)/g;
    let match;
    
    while ((match = funcMiddlewareRegex.exec(content)) !== null) {
      middleware.push({
        name: match[2],
        type: 'function',
        path: filePath,
        priority: 50,
        async: content.includes(`async def ${match[2]}`)
      });
    }
    
    // Class middleware
    const classMiddlewareRegex = /app\.add_middleware\((\w+)/g;
    
    while ((match = classMiddlewareRegex.exec(content)) !== null) {
      middleware.push({
        name: match[1],
        type: 'class',
        path: filePath,
        priority: 50,
        async: true
      });
    }
    
    return middleware;
  }

  private async discoverWebSockets(): Promise<void> {
    const pythonFiles = await this.findFiles(['**/*.py'], this.options.excludePatterns);
    
    for (const file of pythonFiles) {
      const content = await fs.readFile(file, 'utf-8');
      
      // Check for WebSocket endpoints
      if (content.includes('@app.websocket') || content.includes('@router.websocket')) {
        const websockets = this.parseWebSockets(content, file);
        this.websockets.push(...websockets);
      }
    }
  }

  private parseWebSockets(content: string, filePath: string): FastAPIWebSocket[] {
    const websockets: FastAPIWebSocket[] = [];
    const wsRegex = /@(?:app|router)\.websocket\(["']([^"']+)["']\)\s*(?:async\s+)?def\s+(\w+)/g;
    let match;
    
    while ((match = wsRegex.exec(content)) !== null) {
      websockets.push({
        path: match[1],
        handler: `${filePath}::${match[2]}`,
        accepts: ['json', 'text', 'bytes'],
        events: []
      });
    }
    
    return websockets;
  }

  private async discoverRouters(): Promise<void> {
    const pythonFiles = await this.findFiles(['**/*.py'], this.options.excludePatterns);
    
    for (const file of pythonFiles) {
      const content = await fs.readFile(file, 'utf-8');
      
      // Check for APIRouter instances
      if (content.includes('APIRouter()')) {
        const routerName = this.extractRouterName(content);
        if (routerName) {
          this.routers.set(routerName, {
            file: filePath,
            prefix: this.extractRouterPrefix(content),
            tags: this.extractRouterTags(content)
          });
        }
      }
    }
  }

  private extractRouterName(content: string): string | null {
    const match = content.match(/(\w+)\s*=\s*APIRouter\(/);
    return match ? match[1] : null;
  }

  private extractRouterPrefix(content: string): string {
    const match = content.match(/prefix\s*=\s*["']([^"']+)["']/);
    return match ? match[1] : '';
  }

  private extractRouterTags(content: string): string[] {
    const match = content.match(/tags\s*=\s*\[([^\]]+)\]/);
    return match ? this.parseStringList(match[1]) : [];
  }

  private parseStringList(content: string): string[] {
    const items: string[] = [];
    const regex = /["']([^"']+)["']/g;
    let match;
    
    while ((match = regex.exec(content)) !== null) {
      items.push(match[1]);
    }
    
    return items;
  }

  private async countLinesOfCode(filePath: string): Promise<number> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return content.split('\n').length;
    } catch {
      return 0;
    }
  }

  private async buildFastAPIConnections(): Promise<Connection[]> {
    const connections: Connection[] = [];
    
    // Route to Model connections
    for (const [routeId, route] of this.routes) {
      if (route.requestBody) {
        connections.push({
          source: routeId,
          target: route.requestBody.model,
          type: 'data-input',
          protocol: 'pydantic',
          metadata: {
            mediaType: route.requestBody.mediaType
          }
        });
      }
      
      // Route to Dependency connections
      for (const dep of route.dependencies) {
        connections.push({
          source: routeId,
          target: dep,
          type: 'dependency-injection',
          protocol: 'fastapi',
          metadata: {
            injectionType: 'function'
          }
        });
      }
    }
    
    // Model relationships
    for (const [modelId, model] of this.models) {
      for (const field of model.fields) {
        // Check if field type references another model
        const fieldType = field.type.replace('Optional[', '').replace(']', '').replace('List[', '').trim();
        if (this.models.has(fieldType)) {
          connections.push({
            source: modelId,
            target: fieldType,
            type: 'data-relationship',
            protocol: 'pydantic',
            metadata: {
              fieldName: field.name,
              fieldType: field.type
            }
          });
        }
      }
    }
    
    return connections;
  }

  private extractFastAPIEndpoints(): APIEndpoint[] {
    const endpoints: APIEndpoint[] = [];
    
    for (const [id, route] of this.routes) {
      endpoints.push({
        path: route.path,
        method: route.method as APIEndpoint['method'],
        handler: route.handler,
        parameters: route.parameters.map(p => ({
          name: p.name,
          in: p.location,
          required: p.required,
          type: p.type,
          description: p.description
        })),
        responses: Object.entries(route.responses).map(([code, desc]) => ({
          statusCode: parseInt(code),
          description: desc
        })),
        middleware: this.middleware.map(m => m.name),
        authentication: route.security.length > 0,
        rateLimit: undefined,
        deprecated: route.deprecated
      });
    }
    
    // Add WebSocket endpoints
    for (const ws of this.websockets) {
      endpoints.push({
        path: ws.path,
        method: 'WS' as any,
        handler: ws.handler,
        parameters: [],
        responses: [],
        middleware: [],
        authentication: false,
        rateLimit: undefined,
        deprecated: false
      });
    }
    
    return endpoints;
  }

  private async extractDatabaseConnections(): Promise<DatabaseConnection[]> {
    const connections: DatabaseConnection[] = [];
    
    // Check for SQLAlchemy
    if (this.hasSQLAlchemy) {
      connections.push({
        name: 'SQLAlchemy',
        type: 'postgresql',
        host: 'localhost',
        port: 5432,
        database: 'app',
        schema: 'public',
        tables: 0,
        relationships: 0,
        indexes: 0
      });
    }
    
    // Check for Tortoise ORM
    if (this.hasTortoise) {
      connections.push({
        name: 'Tortoise ORM',
        type: 'postgresql',
        host: 'localhost',
        port: 5432,
        database: 'app',
        schema: 'public',
        tables: 0,
        relationships: 0,
        indexes: 0
      });
    }
    
    // Check for Redis
    if (this.hasRedis) {
      connections.push({
        name: 'Redis',
        type: 'redis',
        host: 'localhost',
        port: 6379,
        database: '0',
        schema: '',
        tables: 0,
        relationships: 0,
        indexes: 0
      });
    }
    
    return connections;
  }

  private findFastAPIEntryPoints(): string[] {
    const entryPoints: string[] = [];
    
    // Add main app files
    entryPoints.push(...this.appInstances);
    
    // Add uvicorn/gunicorn entry points
    if (this.hasUvicorn) {
      entryPoints.push('uvicorn:app');
    }
    
    if (this.hasGunicorn) {
      entryPoints.push('gunicorn:app');
    }
    
    return entryPoints;
  }

  private buildFastAPILayers(): Record<string, string[]> {
    return {
      'routes': Array.from(this.routes.keys()),
      'models': Array.from(this.models.keys()),
      'dependencies': Array.from(this.dependencies.keys()),
      'middleware': this.middleware.map(m => m.name),
      'websockets': this.websockets.map(ws => ws.path),
      'routers': Array.from(this.routers.keys())
    };
  }

  async analyzePerformance(): Promise<any> {
    const performance = await super.analyzePerformance();
    
    return {
      ...performance,
      fastapi: {
        routesCount: this.routes.size,
        modelsCount: this.models.size,
        dependenciesCount: this.dependencies.size,
        middlewareCount: this.middleware.length,
        websocketsCount: this.websockets.length,
        averageParametersPerRoute: this.calculateAverageParameters(),
        averageFieldsPerModel: this.calculateAverageFields(),
        features: {
          hasUvicorn: this.hasUvicorn,
          hasGunicorn: this.hasGunicorn,
          hasSQLAlchemy: this.hasSQLAlchemy,
          hasTortoise: this.hasTortoise,
          hasRedis: this.hasRedis
        }
      }
    };
  }

  private calculateAverageParameters(): number {
    const routes = Array.from(this.routes.values());
    if (routes.length === 0) return 0;
    
    const totalParams = routes.reduce((sum, r) => sum + r.parameters.length, 0);
    return totalParams / routes.length;
  }

  private calculateAverageFields(): number {
    const models = Array.from(this.models.values());
    if (models.length === 0) return 0;
    
    const totalFields = models.reduce((sum, m) => sum + m.fields.length, 0);
    return totalFields / models.length;
  }
}