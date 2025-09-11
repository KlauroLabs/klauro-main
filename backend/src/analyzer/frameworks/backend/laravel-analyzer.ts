// Laravel Framework Analyzer - Specialized analysis for Laravel applications
// Phase 3: Framework Sub-Analyzers - Production-ready Laravel analyzer

import { PHPAnalyzer } from '../../languages/php-analyzer';
import { ComponentNode, ComponentType, Connection, APIEndpoint, DatabaseConnection } from '../../../types';
import { telemetry } from '../../../telemetry/telemetry-schema';
import * as path from 'path';
import * as fs from 'fs-extra';

export interface LaravelController {
  name: string;
  filePath: string;
  namespace?: string;
  methods: LaravelControllerMethod[];
  middleware: string[];
  resourceful: boolean;
}

export interface LaravelControllerMethod {
  name: string;
  httpMethod?: string;
  route?: string;
  parameters: string[];
  middleware: string[];
}

export interface LaravelModel {
  name: string;
  filePath: string;
  table?: string;
  fillable: string[];
  guarded: string[];
  hidden: string[];
  casts: Record<string, string>;
  relationships: LaravelRelationship[];
}

export interface LaravelRelationship {
  name: string;
  type: 'hasOne' | 'hasMany' | 'belongsTo' | 'belongsToMany' | 'morphTo' | 'morphMany';
  relatedModel: string;
  foreignKey?: string;
  localKey?: string;
}

export interface LaravelRoute {
  uri: string;
  methods: string[];
  controller?: string;
  action?: string;
  name?: string;
  middleware: string[];
  prefix?: string;
}

export interface LaravelMigration {
  name: string;
  filePath: string;
  tableName?: string;
  operations: string[];
  timestamp: string;
}

export interface LaravelService {
  name: string;
  filePath: string;
  bindings: string[];
  provides: string[];
}

export interface LaravelCommand {
  name: string;
  signature: string;
  description?: string;
  filePath: string;
}

export class LaravelAnalyzer extends PHPAnalyzer {
  private laravelVersion: string = '';
  private controllers: Map<string, LaravelController> = new Map();
  private models: Map<string, LaravelModel> = new Map();
  private routes: Map<string, LaravelRoute> = new Map();
  private migrations: Map<string, LaravelMigration> = new Map();
  private services: Map<string, LaravelService> = new Map();
  private commands: Map<string, LaravelCommand> = new Map();
  private hasEloquent: boolean = true;
  private hasHorizon: boolean = false;
  private hasSanctum: boolean = false;
  private hasPassport: boolean = false;
  private hasBroadcasting: boolean = false;
  
  getAnalyzerName(): string {
    return 'Laravel Framework Analyzer';
  }

  getSupportedFrameworks(): string[] {
    return ['laravel', 'eloquent', 'blade', 'horizon', 'sanctum', 'passport'];
  }

  protected async detectLanguageAndFramework(): Promise<any> {
    const baseDetection = await super.detectLanguageAndFramework();
    
    // Detect Laravel version from composer.json
    await this.detectLaravelVersion();
    
    return {
      ...baseDetection,
      frameworks: [...baseDetection.frameworks.filter(f => !f.name.includes('laravel')), {
        name: 'laravel',
        version: this.laravelVersion,
        confidence: 0.95,
        patterns: ['Laravel application detected'],
        configFiles: ['composer.json', 'artisan', 'config/app.php', '.env'],
        dependencies: ['laravel/framework']
      }]
    };
  }

  protected async discoverComponents(): Promise<any> {
    const span = telemetry.createSpan('laravel-analyzer.discoverComponents');
    const baseDiscovery = await super.discoverComponents();
    
    // Discover Laravel components
    await this.discoverControllers();
    await this.discoverModels();
    await this.discoverRoutes();
    await this.discoverMigrations();
    await this.discoverServices();
    await this.discoverCommands();
    
    // Build component nodes
    const components = new Map<string, ComponentNode>();
    
    // Add controllers as components
    for (const [id, controller] of this.controllers) {
      const node: ComponentNode = {
        id,
        name: controller.name,
        type: ComponentType.API_HANDLER,
        path: controller.filePath,
        language: 'php',
        framework: 'laravel',
        dependencies: controller.middleware,
        metrics: {
          linesOfCode: 0,
          complexity: controller.methods.length + controller.middleware.length,
          maintainability: 100 - controller.methods.length * 2,
          testCoverage: 0,
          duplicateCode: 0,
          technicalDebt: 0
        },
        relationships: [],
        metadata: {
          frameworkType: 'controller',
          namespace: controller.namespace,
          methods: controller.methods,
          middleware: controller.middleware,
          resourceful: controller.resourceful
        }
      };
      components.set(id, node);
    }
    
    // Add models as components
    for (const [id, model] of this.models) {
      const node: ComponentNode = {
        id,
        name: model.name,
        type: ComponentType.DATA_MODEL,
        path: model.filePath,
        language: 'php',
        framework: 'laravel',
        dependencies: model.relationships.map(r => r.relatedModel),
        metrics: {
          linesOfCode: 0,
          complexity: model.fillable.length + model.relationships.length,
          maintainability: 100 - (model.fillable.length + model.relationships.length) * 1.5,
          testCoverage: 0,
          duplicateCode: 0,
          technicalDebt: 0
        },
        relationships: [],
        metadata: {
          frameworkType: 'model',
          table: model.table,
          fillable: model.fillable,
          guarded: model.guarded,
          hidden: model.hidden,
          casts: model.casts,
          relationships: model.relationships
        }
      };
      components.set(id, node);
    }
    
    // Add services as components
    for (const [id, service] of this.services) {
      const node: ComponentNode = {
        id,
        name: service.name,
        type: ComponentType.SERVICE,
        path: service.filePath,
        language: 'php',
        framework: 'laravel',
        dependencies: service.bindings,
        metrics: {
          linesOfCode: 0,
          complexity: service.bindings.length + service.provides.length,
          maintainability: 100 - service.bindings.length * 2,
          testCoverage: 0,
          duplicateCode: 0,
          technicalDebt: 0
        },
        relationships: [],
        metadata: {
          frameworkType: 'service-provider',
          bindings: service.bindings,
          provides: service.provides
        }
      };
      components.set(id, node);
    }
    
    const connections = await this.buildLaravelConnections();
    const apiEndpoints = this.extractLaravelEndpoints();
    const databaseConnections = await this.extractDatabaseConnections();
    
    telemetry.emit({
      type: 'component_discovery_completed',
      source: { analyzer: this.getAnalyzerName() },
      data: {
        totalComponents: components.size,
        controllers: this.controllers.size,
        models: this.models.size,
        routes: this.routes.size,
        migrations: this.migrations.size,
        services: this.services.size,
        commands: this.commands.size
      }
    });
    
    span.end();
    return {
      components: Array.from(components.values()),
      entryPoints: ['public/index.php', 'artisan'],
      connections,
      layers: this.buildLaravelLayers(),
      apiEndpoints,
      databaseConnections
    };
  }

  private async detectLaravelVersion(): Promise<void> {
    const composerPath = path.join(this.projectPath, 'composer.json');
    if (await fs.pathExists(composerPath)) {
      const content = await fs.readFile(composerPath, 'utf-8');
      try {
        const composer = JSON.parse(content);
        const laravelPackage = composer.require?.['laravel/framework'];
        if (laravelPackage) {
          this.laravelVersion = laravelPackage.replace(/[\^~]/, '');
        }
        
        // Detect Laravel packages
        this.hasHorizon = 'laravel/horizon' in (composer.require || {});
        this.hasSanctum = 'laravel/sanctum' in (composer.require || {});
        this.hasPassport = 'laravel/passport' in (composer.require || {});
      } catch (e) {
        // Invalid JSON
      }
    }
  }

  private async discoverControllers(): Promise<void> {
    const controllerPath = path.join(this.projectPath, 'app/Http/Controllers');
    if (await fs.pathExists(controllerPath)) {
      const phpFiles = await this.findFiles(['app/Http/Controllers/**/*.php'], []);
      
      for (const file of phpFiles) {
        const content = await fs.readFile(file, 'utf-8');
        const controller = this.parseController(content, file);
        if (controller) {
          this.controllers.set(controller.name, controller);
        }
      }
    }
  }

  private parseController(content: string, filePath: string): LaravelController | null {
    const classMatch = content.match(/class\s+(\w+)\s+extends\s+Controller/);
    if (!classMatch) return null;
    
    const name = classMatch[1];
    const namespaceMatch = content.match(/namespace\s+([^;]+);/);
    
    return {
      name,
      filePath,
      namespace: namespaceMatch?.[1],
      methods: this.parseControllerMethods(content),
      middleware: this.parseControllerMiddleware(content),
      resourceful: this.isResourceController(content)
    };
  }

  private parseControllerMethods(content: string): LaravelControllerMethod[] {
    const methods: LaravelControllerMethod[] = [];
    const methodRegex = /public\s+function\s+(\w+)\s*\(([^)]*)\)/g;
    let match;
    
    while ((match = methodRegex.exec(content)) !== null) {
      const name = match[1];
      const params = match[2];
      
      methods.push({
        name,
        parameters: this.parseMethodParameters(params),
        middleware: []
      });
    }
    
    return methods;
  }

  private parseMethodParameters(params: string): string[] {
    if (!params.trim()) return [];
    
    return params.split(',').map(p => {
      const paramMatch = p.match(/\$(\w+)/);
      return paramMatch ? paramMatch[1] : '';
    }).filter(Boolean);
  }

  private parseControllerMiddleware(content: string): string[] {
    const middleware: string[] = [];
    const constructorMatch = content.match(/public\s+function\s+__construct[^{]*\{([^}]+)\}/s);
    
    if (constructorMatch) {
      const constructorBody = constructorMatch[1];
      const middlewareRegex = /\$this->middleware\(['"]([^'"]+)['"]/g;
      let match;
      
      while ((match = middlewareRegex.exec(constructorBody)) !== null) {
        middleware.push(match[1]);
      }
    }
    
    return middleware;
  }

  private isResourceController(content: string): boolean {
    const resourceMethods = ['index', 'create', 'store', 'show', 'edit', 'update', 'destroy'];
    let count = 0;
    
    for (const method of resourceMethods) {
      if (content.includes(`public function ${method}(`)) {
        count++;
      }
    }
    
    return count >= 5;
  }

  private async discoverModels(): Promise<void> {
    const modelsPath = path.join(this.projectPath, 'app/Models');
    const legacyModelsPath = path.join(this.projectPath, 'app');
    
    let phpFiles: string[] = [];
    
    if (await fs.pathExists(modelsPath)) {
      phpFiles = await this.findFiles(['app/Models/**/*.php'], []);
    } else if (await fs.pathExists(legacyModelsPath)) {
      phpFiles = await this.findFiles(['app/*.php'], []);
    }
    
    for (const file of phpFiles) {
      const content = await fs.readFile(file, 'utf-8');
      if (content.includes('extends Model')) {
        const model = this.parseModel(content, file);
        if (model) {
          this.models.set(model.name, model);
        }
      }
    }
  }

  private parseModel(content: string, filePath: string): LaravelModel | null {
    const classMatch = content.match(/class\s+(\w+)\s+extends\s+Model/);
    if (!classMatch) return null;
    
    const name = classMatch[1];
    const tableMatch = content.match(/protected\s+\$table\s*=\s*['"]([^'"]+)['"]/);
    
    return {
      name,
      filePath,
      table: tableMatch?.[1],
      fillable: this.parseArrayProperty(content, 'fillable'),
      guarded: this.parseArrayProperty(content, 'guarded'),
      hidden: this.parseArrayProperty(content, 'hidden'),
      casts: this.parseCastsProperty(content),
      relationships: this.parseModelRelationships(content)
    };
  }

  private parseArrayProperty(content: string, propertyName: string): string[] {
    const regex = new RegExp(`protected\\s+\\$${propertyName}\\s*=\\s*\\[([^\\]]+)\\]`, 's');
    const match = content.match(regex);
    
    if (!match) return [];
    
    const items = match[1];
    const itemRegex = /['"]([^'"]+)['"]/g;
    const result: string[] = [];
    let itemMatch;
    
    while ((itemMatch = itemRegex.exec(items)) !== null) {
      result.push(itemMatch[1]);
    }
    
    return result;
  }

  private parseCastsProperty(content: string): Record<string, string> {
    const casts: Record<string, string> = {};
    const castsMatch = content.match(/protected\s+\$casts\s*=\s*\[([^\]]+)\]/s);
    
    if (castsMatch) {
      const castsContent = castsMatch[1];
      const castRegex = /['"](\w+)['"]\s*=>\s*['"]([^'"]+)['"]/g;
      let match;
      
      while ((match = castRegex.exec(castsContent)) !== null) {
        casts[match[1]] = match[2];
      }
    }
    
    return casts;
  }

  private parseModelRelationships(content: string): LaravelRelationship[] {
    const relationships: LaravelRelationship[] = [];
    const relationTypes = ['hasOne', 'hasMany', 'belongsTo', 'belongsToMany', 'morphTo', 'morphMany'];
    
    for (const relationType of relationTypes) {
      const regex = new RegExp(`public\\s+function\\s+(\\w+)\\s*\\([^)]*\\)[^{]*\\{[^}]*return\\s+\\$this->${relationType}\\(([^)]+)\\)`, 'g');
      let match;
      
      while ((match = regex.exec(content)) !== null) {
        const name = match[1];
        const params = match[2];
        const modelMatch = params.match(/(\w+)::class/);
        
        relationships.push({
          name,
          type: relationType as LaravelRelationship['type'],
          relatedModel: modelMatch ? modelMatch[1] : ''
        });
      }
    }
    
    return relationships;
  }

  private async discoverRoutes(): Promise<void> {
    const routeFiles = [
      'routes/web.php',
      'routes/api.php',
      'routes/channels.php',
      'routes/console.php'
    ];
    
    for (const routeFile of routeFiles) {
      const fullPath = path.join(this.projectPath, routeFile);
      if (await fs.pathExists(fullPath)) {
        const content = await fs.readFile(fullPath, 'utf-8');
        const routes = this.parseRoutes(content, routeFile);
        
        for (const route of routes) {
          const id = `${route.methods.join('_')}_${route.uri.replace(/[/{}/]/g, '_')}`;
          this.routes.set(id, route);
        }
      }
    }
  }

  private parseRoutes(content: string, filePath: string): LaravelRoute[] {
    const routes: LaravelRoute[] = [];
    
    // Parse Route:: definitions
    const routeRegex = /Route::(get|post|put|patch|delete|any|match)\s*\(\s*['"]([^'"]+)['"]/g;
    let match;
    
    while ((match = routeRegex.exec(content)) !== null) {
      const method = match[1];
      const uri = match[2];
      
      routes.push({
        uri,
        methods: method === 'any' ? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] : [method.toUpperCase()],
        middleware: []
      });
    }
    
    // Parse Route::resource definitions
    const resourceRegex = /Route::resource\s*\(\s*['"]([^'"]+)['"],\s*['"]?(\w+)/g;
    
    while ((match = resourceRegex.exec(content)) !== null) {
      const uri = match[1];
      const controller = match[2];
      
      routes.push({
        uri,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
        controller,
        middleware: []
      });
    }
    
    return routes;
  }

  private async discoverMigrations(): Promise<void> {
    const migrationsPath = path.join(this.projectPath, 'database/migrations');
    if (await fs.pathExists(migrationsPath)) {
      const phpFiles = await this.findFiles(['database/migrations/**/*.php'], []);
      
      for (const file of phpFiles) {
        const content = await fs.readFile(file, 'utf-8');
        const migration = this.parseMigration(content, file);
        if (migration) {
          this.migrations.set(migration.name, migration);
        }
      }
    }
  }

  private parseMigration(content: string, filePath: string): LaravelMigration | null {
    const classMatch = content.match(/class\s+(\w+)\s+extends\s+Migration/);
    if (!classMatch) return null;
    
    const name = classMatch[1];
    const fileName = path.basename(filePath);
    const timestampMatch = fileName.match(/^(\d{4}_\d{2}_\d{2}_\d{6})/);
    
    return {
      name,
      filePath,
      operations: this.parseMigrationOperations(content),
      timestamp: timestampMatch ? timestampMatch[1] : ''
    };
  }

  private parseMigrationOperations(content: string): string[] {
    const operations: string[] = [];
    const operationTypes = ['create', 'table', 'dropIfExists', 'drop', 'rename', 'addColumn', 'dropColumn'];
    
    for (const op of operationTypes) {
      if (content.includes(`Schema::${op}`)) {
        operations.push(op);
      }
    }
    
    return operations;
  }

  private async discoverServices(): Promise<void> {
    const providersPath = path.join(this.projectPath, 'app/Providers');
    if (await fs.pathExists(providersPath)) {
      const phpFiles = await this.findFiles(['app/Providers/**/*.php'], []);
      
      for (const file of phpFiles) {
        const content = await fs.readFile(file, 'utf-8');
        const service = this.parseServiceProvider(content, file);
        if (service) {
          this.services.set(service.name, service);
        }
      }
    }
  }

  private parseServiceProvider(content: string, filePath: string): LaravelService | null {
    const classMatch = content.match(/class\s+(\w+)\s+extends\s+ServiceProvider/);
    if (!classMatch) return null;
    
    return {
      name: classMatch[1],
      filePath,
      bindings: [],
      provides: []
    };
  }

  private async discoverCommands(): Promise<void> {
    const commandsPath = path.join(this.projectPath, 'app/Console/Commands');
    if (await fs.pathExists(commandsPath)) {
      const phpFiles = await this.findFiles(['app/Console/Commands/**/*.php'], []);
      
      for (const file of phpFiles) {
        const content = await fs.readFile(file, 'utf-8');
        const command = this.parseCommand(content, file);
        if (command) {
          this.commands.set(command.name, command);
        }
      }
    }
  }

  private parseCommand(content: string, filePath: string): LaravelCommand | null {
    const classMatch = content.match(/class\s+(\w+)\s+extends\s+Command/);
    if (!classMatch) return null;
    
    const name = classMatch[1];
    const signatureMatch = content.match(/protected\s+\$signature\s*=\s*['"]([^'"]+)['"]/);
    const descriptionMatch = content.match(/protected\s+\$description\s*=\s*['"]([^'"]+)['"]/);
    
    return {
      name,
      signature: signatureMatch?.[1] || '',
      description: descriptionMatch?.[1],
      filePath
    };
  }

  private async buildLaravelConnections(): Promise<Connection[]> {
    const connections: Connection[] = [];
    
    // Controller to Model connections
    for (const [controllerId] of this.controllers) {
      for (const [modelId] of this.models) {
        connections.push({
          source: controllerId,
          target: modelId,
          type: 'uses-model',
          protocol: 'laravel',
          metadata: { relationship: 'controller-model' }
        });
      }
    }
    
    // Model relationships
    for (const [modelId, model] of this.models) {
      for (const rel of model.relationships) {
        if (rel.relatedModel) {
          connections.push({
            source: modelId,
            target: rel.relatedModel,
            type: 'data-relationship',
            protocol: 'eloquent',
            metadata: { relationType: rel.type }
          });
        }
      }
    }
    
    // Route to Controller connections
    for (const [routeId, route] of this.routes) {
      if (route.controller) {
        connections.push({
          source: routeId,
          target: route.controller,
          type: 'route-controller',
          protocol: 'laravel',
          metadata: { methods: route.methods }
        });
      }
    }
    
    return connections;
  }

  private extractLaravelEndpoints(): APIEndpoint[] {
    const endpoints: APIEndpoint[] = [];
    
    for (const [id, route] of this.routes) {
      for (const method of route.methods) {
        endpoints.push({
          path: route.uri,
          method: method as APIEndpoint['method'],
          handler: route.controller || route.action || 'Closure',
          parameters: [],
          responses: [],
          middleware: route.middleware,
          authentication: route.middleware.includes('auth') || this.hasSanctum || this.hasPassport,
          rateLimit: undefined,
          deprecated: false
        });
      }
    }
    
    return endpoints;
  }

  private async extractDatabaseConnections(): Promise<DatabaseConnection[]> {
    return [{
      name: 'Laravel Eloquent ORM',
      type: 'mysql',
      host: 'localhost',
      port: 3306,
      database: 'laravel',
      schema: '',
      tables: this.models.size,
      relationships: Array.from(this.models.values()).reduce((sum, m) => sum + m.relationships.length, 0),
      indexes: 0
    }];
  }

  private buildLaravelLayers(): Record<string, string[]> {
    return {
      'controllers': Array.from(this.controllers.keys()),
      'models': Array.from(this.models.keys()),
      'routes': Array.from(this.routes.keys()),
      'migrations': Array.from(this.migrations.keys()),
      'services': Array.from(this.services.keys()),
      'commands': Array.from(this.commands.keys())
    };
  }

  async analyzePerformance(): Promise<any> {
    const performance = await super.analyzePerformance();
    
    return {
      ...performance,
      laravel: {
        controllersCount: this.controllers.size,
        modelsCount: this.models.size,
        routesCount: this.routes.size,
        migrationsCount: this.migrations.size,
        servicesCount: this.services.size,
        commandsCount: this.commands.size,
        averageMethodsPerController: this.calculateAverageMethodsPerController(),
        averageRelationshipsPerModel: this.calculateAverageRelationshipsPerModel(),
        features: {
          hasEloquent: this.hasEloquent,
          hasHorizon: this.hasHorizon,
          hasSanctum: this.hasSanctum,
          hasPassport: this.hasPassport,
          hasBroadcasting: this.hasBroadcasting
        }
      }
    };
  }

  private calculateAverageMethodsPerController(): number {
    const controllers = Array.from(this.controllers.values());
    if (controllers.length === 0) return 0;
    
    const totalMethods = controllers.reduce((sum, c) => sum + c.methods.length, 0);
    return totalMethods / controllers.length;
  }

  private calculateAverageRelationshipsPerModel(): number {
    const models = Array.from(this.models.values());
    if (models.length === 0) return 0;
    
    const totalRelationships = models.reduce((sum, m) => sum + m.relationships.length, 0);
    return totalRelationships / models.length;
  }
}