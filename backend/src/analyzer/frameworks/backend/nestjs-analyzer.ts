// NestJS Framework Analyzer - Specialized analysis for NestJS applications
// Phase 3: Framework Sub-Analyzers - Production-ready NestJS analyzer

import { TypeScriptJavaScriptAnalyzer } from '../../languages/typescript-javascript-analyzer';
import { ComponentNode, ComponentType, Connection, APIEndpoint, DatabaseConnection } from '../../../types';
import { telemetry } from '../../../telemetry/telemetry-schema';
import * as path from 'path';
import * as fs from 'fs-extra';

export interface NestModule {
  name: string;
  filePath: string;
  imports: string[];
  controllers: string[];
  providers: string[];
  exports: string[];
  isGlobal: boolean;
  isDynamic: boolean;
}

export interface NestController {
  name: string;
  filePath: string;
  path?: string;
  methods: NestControllerMethod[];
  guards: string[];
  interceptors: string[];
  filters: string[];
  pipes: string[];
}

export interface NestControllerMethod {
  name: string;
  httpMethod: string;
  path: string;
  guards: string[];
  interceptors: string[];
  pipes: string[];
  params: NestParam[];
  returnType?: string;
}

export interface NestParam {
  name: string;
  type: 'body' | 'query' | 'param' | 'headers' | 'request' | 'response';
  dataType?: string;
  required: boolean;
  decorators: string[];
}

export interface NestProvider {
  name: string;
  filePath: string;
  type: 'service' | 'repository' | 'factory' | 'guard' | 'interceptor' | 'pipe' | 'filter';
  scope: 'singleton' | 'request' | 'transient';
  injectable: boolean;
  dependencies: string[];
}

export interface NestGuard {
  name: string;
  filePath: string;
  canActivate: boolean;
  global: boolean;
}

export interface NestInterceptor {
  name: string;
  filePath: string;
  global: boolean;
}

export interface NestPipe {
  name: string;
  filePath: string;
  global: boolean;
  transform: boolean;
}

export interface NestFilter {
  name: string;
  filePath: string;
  exceptionTypes: string[];
  global: boolean;
}

export interface NestEntity {
  name: string;
  filePath: string;
  tableName?: string;
  columns: NestEntityColumn[];
  relations: NestEntityRelation[];
  indexes: string[];
}

export interface NestEntityColumn {
  name: string;
  type: string;
  nullable: boolean;
  unique: boolean;
  primary: boolean;
  generated: boolean;
}

export interface NestEntityRelation {
  name: string;
  type: 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many';
  target: string;
  cascade: boolean;
}

export class NestJSAnalyzer extends TypeScriptJavaScriptAnalyzer {
  private nestVersion: string = '';
  private modules: Map<string, NestModule> = new Map();
  private controllers: Map<string, NestController> = new Map();
  private providers: Map<string, NestProvider> = new Map();
  private guards: Map<string, NestGuard> = new Map();
  private interceptors: Map<string, NestInterceptor> = new Map();
  private pipes: Map<string, NestPipe> = new Map();
  private filters: Map<string, NestFilter> = new Map();
  private entities: Map<string, NestEntity> = new Map();
  private hasTypeORM: boolean = false;
  private hasMikroORM: boolean = false;
  private hasPrisma: boolean = false;
  private hasMongoose: boolean = false;
  private hasGraphQL: boolean = false;
  private hasMicroservices: boolean = false;
  private hasWebSockets: boolean = false;
  private hasSwagger: boolean = false;
  
  getAnalyzerName(): string {
    return 'NestJS Framework Analyzer';
  }

  getSupportedFrameworks(): string[] {
    return ['@nestjs/core', '@nestjs/common', '@nestjs/platform-express', '@nestjs/typeorm', '@nestjs/graphql'];
  }

  protected async detectLanguageAndFramework(): Promise<any> {
    const baseDetection = await super.detectLanguageAndFramework();
    
    // Check for NestJS in package.json
    await this.detectNestVersion();
    
    // Detect NestJS ecosystem
    await this.detectNestPackages();
    
    return {
      ...baseDetection,
      frameworks: [...baseDetection.frameworks.filter(f => !f.name.includes('nest')), {
        name: 'nestjs',
        version: this.nestVersion,
        confidence: 0.98,
        patterns: ['NestJS application detected'],
        configFiles: ['nest-cli.json', 'tsconfig.json', 'main.ts', 'app.module.ts'],
        dependencies: ['@nestjs/core', '@nestjs/common']
      }]
    };
  }

  protected async discoverComponents(): Promise<any> {
    const span = telemetry.createSpan('nestjs-analyzer.discoverComponents');
    const baseDiscovery = await super.discoverComponents();
    
    // Discover NestJS components
    await this.discoverModules();
    await this.discoverControllers();
    await this.discoverProviders();
    await this.discoverGuards();
    await this.discoverInterceptors();
    await this.discoverPipes();
    await this.discoverFilters();
    await this.discoverEntities();
    
    // Build component nodes
    const components = new Map<string, ComponentNode>();
    
    // Add modules as components
    for (const [id, module] of this.modules) {
      const node: ComponentNode = {
        id,
        name: module.name,
        type: ComponentType.MODULE,
        path: module.filePath,
        language: 'typescript',
        framework: 'nestjs',
        dependencies: module.imports,
        metrics: {
          linesOfCode: await this.countLinesOfCode(module.filePath),
          complexity: module.controllers.length + module.providers.length,
          maintainability: 100 - (module.controllers.length + module.providers.length) * 2,
          testCoverage: 0,
          duplicateCode: 0,
          technicalDebt: 0
        },
        relationships: [],
        metadata: {
          frameworkType: 'module',
          imports: module.imports,
          controllers: module.controllers,
          providers: module.providers,
          exports: module.exports,
          isGlobal: module.isGlobal,
          isDynamic: module.isDynamic
        }
      };
      components.set(id, node);
    }
    
    // Add controllers as components
    for (const [id, controller] of this.controllers) {
      const node: ComponentNode = {
        id,
        name: controller.name,
        type: ComponentType.API_HANDLER,
        path: controller.filePath,
        language: 'typescript',
        framework: 'nestjs',
        dependencies: [],
        metrics: {
          linesOfCode: await this.countLinesOfCode(controller.filePath),
          complexity: controller.methods.length + controller.guards.length,
          maintainability: 100 - controller.methods.length * 3,
          testCoverage: 0,
          duplicateCode: 0,
          technicalDebt: 0
        },
        relationships: [],
        metadata: {
          frameworkType: 'controller',
          path: controller.path,
          methods: controller.methods,
          guards: controller.guards,
          interceptors: controller.interceptors,
          filters: controller.filters,
          pipes: controller.pipes
        }
      };
      components.set(id, node);
    }
    
    // Add providers as components
    for (const [id, provider] of this.providers) {
      const node: ComponentNode = {
        id,
        name: provider.name,
        type: provider.type === 'service' ? ComponentType.SERVICE : ComponentType.UTILITY,
        path: provider.filePath,
        language: 'typescript',
        framework: 'nestjs',
        dependencies: provider.dependencies,
        metrics: {
          linesOfCode: await this.countLinesOfCode(provider.filePath),
          complexity: provider.dependencies.length + 2,
          maintainability: 100 - provider.dependencies.length * 2,
          testCoverage: 0,
          duplicateCode: 0,
          technicalDebt: 0
        },
        relationships: [],
        metadata: {
          frameworkType: provider.type,
          scope: provider.scope,
          injectable: provider.injectable,
          dependencies: provider.dependencies
        }
      };
      components.set(id, node);
    }
    
    // Add entities as components
    for (const [id, entity] of this.entities) {
      const node: ComponentNode = {
        id,
        name: entity.name,
        type: ComponentType.DATA_MODEL,
        path: entity.filePath,
        language: 'typescript',
        framework: 'nestjs',
        dependencies: entity.relations.map(r => r.target),
        metrics: {
          linesOfCode: await this.countLinesOfCode(entity.filePath),
          complexity: entity.columns.length + entity.relations.length,
          maintainability: 100 - (entity.columns.length + entity.relations.length) * 1.5,
          testCoverage: 0,
          duplicateCode: 0,
          technicalDebt: 0
        },
        relationships: [],
        metadata: {
          frameworkType: 'entity',
          tableName: entity.tableName,
          columns: entity.columns,
          relations: entity.relations,
          indexes: entity.indexes
        }
      };
      components.set(id, node);
    }
    
    // Build connections
    const connections = await this.buildNestConnections();
    
    // Extract API endpoints
    const apiEndpoints = this.extractNestEndpoints();
    
    // Extract database connections
    const databaseConnections = await this.extractDatabaseConnections();
    
    telemetry.emit({
      type: 'component_discovery_completed',
      source: { analyzer: this.getAnalyzerName() },
      data: {
        totalComponents: components.size,
        modules: this.modules.size,
        controllers: this.controllers.size,
        providers: this.providers.size,
        guards: this.guards.size,
        interceptors: this.interceptors.size,
        pipes: this.pipes.size,
        filters: this.filters.size,
        entities: this.entities.size,
        hasTypeORM: this.hasTypeORM,
        hasGraphQL: this.hasGraphQL
      }
    });
    
    span.end();
    return {
      components: Array.from(components.values()),
      entryPoints: this.findNestEntryPoints(),
      connections,
      layers: this.buildNestLayers(),
      apiEndpoints,
      databaseConnections
    };
  }

  private async detectNestVersion(): Promise<void> {
    const packageJsonPath = path.join(this.projectPath, 'package.json');
    if (await fs.pathExists(packageJsonPath)) {
      const packageJson = await fs.readJson(packageJsonPath);
      const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
      
      if (dependencies['@nestjs/core']) {
        this.nestVersion = dependencies['@nestjs/core'].replace(/[\^~]/, '');
      }
    }
  }

  private async detectNestPackages(): Promise<void> {
    const packageJsonPath = path.join(this.projectPath, 'package.json');
    if (await fs.pathExists(packageJsonPath)) {
      const packageJson = await fs.readJson(packageJsonPath);
      const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
      
      this.hasTypeORM = '@nestjs/typeorm' in dependencies;
      this.hasMikroORM = '@mikro-orm/nestjs' in dependencies;
      this.hasPrisma = '@prisma/client' in dependencies;
      this.hasMongoose = '@nestjs/mongoose' in dependencies;
      this.hasGraphQL = '@nestjs/graphql' in dependencies;
      this.hasMicroservices = '@nestjs/microservices' in dependencies;
      this.hasWebSockets = '@nestjs/websockets' in dependencies || '@nestjs/platform-socket.io' in dependencies;
      this.hasSwagger = '@nestjs/swagger' in dependencies;
    }
  }

  private async discoverModules(): Promise<void> {
    const tsFiles = await this.findFiles(['**/*.module.ts'], this.options.excludePatterns);
    
    for (const file of tsFiles) {
      const content = await fs.readFile(file, 'utf-8');
      const module = this.parseModule(content, file);
      
      if (module) {
        this.modules.set(module.name, module);
      }
    }
  }

  private parseModule(content: string, filePath: string): NestModule | null {
    // Match @Module decorator
    const moduleMatch = content.match(/@Module\s*\(\s*{([^}]+)}\s*\)/s);
    if (!moduleMatch) return null;
    
    const moduleConfig = moduleMatch[1];
    
    // Extract class name
    const classMatch = content.match(/@Module[^}]+}\s*\)\s*export\s+class\s+(\w+)/s);
    if (!classMatch) return null;
    
    const name = classMatch[1];
    
    return {
      name,
      filePath,
      imports: this.extractArrayProperty(moduleConfig, 'imports'),
      controllers: this.extractArrayProperty(moduleConfig, 'controllers'),
      providers: this.extractArrayProperty(moduleConfig, 'providers'),
      exports: this.extractArrayProperty(moduleConfig, 'exports'),
      isGlobal: content.includes('@Global()'),
      isDynamic: content.includes('forRoot') || content.includes('forRootAsync')
    };
  }

  private extractArrayProperty(content: string, property: string): string[] {
    const regex = new RegExp(`${property}\\s*:\\s*\\[([^\\]]+)\\]`, 's');
    const match = content.match(regex);
    
    if (!match) return [];
    
    const items = match[1];
    const identifiers: string[] = [];
    const identifierRegex = /(\w+)(?:\s*,|\s*$)/g;
    let identifierMatch;
    
    while ((identifierMatch = identifierRegex.exec(items)) !== null) {
      identifiers.push(identifierMatch[1]);
    }
    
    return identifiers;
  }

  private async discoverControllers(): Promise<void> {
    const tsFiles = await this.findFiles(['**/*.controller.ts'], this.options.excludePatterns);
    
    for (const file of tsFiles) {
      const content = await fs.readFile(file, 'utf-8');
      const controller = this.parseController(content, file);
      
      if (controller) {
        this.controllers.set(controller.name, controller);
      }
    }
  }

  private parseController(content: string, filePath: string): NestController | null {
    // Match @Controller decorator
    const controllerMatch = content.match(/@Controller\s*\(\s*(?:['"`]([^'"`]+)['"`])?\s*\)/);
    if (!controllerMatch) return null;
    
    const path = controllerMatch[1] || '';
    
    // Extract class name
    const classMatch = content.match(/@Controller[^)]*\)\s*export\s+class\s+(\w+)/s);
    if (!classMatch) return null;
    
    const name = classMatch[1];
    
    // Parse methods
    const methods = this.parseControllerMethods(content);
    
    // Parse decorators
    const guards = this.extractDecorators(content, 'UseGuards');
    const interceptors = this.extractDecorators(content, 'UseInterceptors');
    const filters = this.extractDecorators(content, 'UseFilters');
    const pipes = this.extractDecorators(content, 'UsePipes');
    
    return {
      name,
      filePath,
      path,
      methods,
      guards,
      interceptors,
      filters,
      pipes
    };
  }

  private parseControllerMethods(content: string): NestControllerMethod[] {
    const methods: NestControllerMethod[] = [];
    
    const httpMethods = ['Get', 'Post', 'Put', 'Delete', 'Patch', 'Head', 'Options', 'All'];
    
    for (const httpMethod of httpMethods) {
      const regex = new RegExp(`@${httpMethod}\\s*\\(\\s*(?:['"\`]([^'"\`]+)['"\`])?[^)]*\\)[^{]*(?:async\\s+)?(\\ w+)\\s*\\([^)]*\\)`, 'g');
      let match;
      
      while ((match = regex.exec(content)) !== null) {
        const path = match[1] || '';
        const name = match[2];
        
        // Extract method parameters
        const methodRegex = new RegExp(`${name}\\s*\\(([^)]*)\\)`);
        const methodMatch = content.match(methodRegex);
        const params = methodMatch ? this.parseMethodParams(methodMatch[1]) : [];
        
        methods.push({
          name,
          httpMethod: httpMethod.toUpperCase(),
          path,
          guards: [],
          interceptors: [],
          pipes: [],
          params
        });
      }
    }
    
    return methods;
  }

  private parseMethodParams(paramsString: string): NestParam[] {
    const params: NestParam[] = [];
    
    const decoratorTypes = [
      { decorator: '@Body', type: 'body' as const },
      { decorator: '@Query', type: 'query' as const },
      { decorator: '@Param', type: 'param' as const },
      { decorator: '@Headers', type: 'headers' as const },
      { decorator: '@Req', type: 'request' as const },
      { decorator: '@Res', type: 'response' as const }
    ];
    
    for (const { decorator, type } of decoratorTypes) {
      const regex = new RegExp(`${decorator}\\(\\)\\s*(\\w+)`, 'g');
      let match;
      
      while ((match = regex.exec(paramsString)) !== null) {
        params.push({
          name: match[1],
          type,
          required: type !== 'query',
          decorators: [decorator]
        });
      }
    }
    
    return params;
  }

  private extractDecorators(content: string, decorator: string): string[] {
    const decorators: string[] = [];
    const regex = new RegExp(`@${decorator}\\s*\\(([^)]*)\\)`, 'g');
    let match;
    
    while ((match = regex.exec(content)) !== null) {
      const args = match[1];
      const identifierRegex = /(\w+)/g;
      let identifierMatch;
      
      while ((identifierMatch = identifierRegex.exec(args)) !== null) {
        decorators.push(identifierMatch[1]);
      }
    }
    
    return decorators;
  }

  private async discoverProviders(): Promise<void> {
    const tsFiles = await this.findFiles(['**/*.service.ts', '**/*.repository.ts', '**/*.provider.ts'], this.options.excludePatterns);
    
    for (const file of tsFiles) {
      const content = await fs.readFile(file, 'utf-8');
      const provider = this.parseProvider(content, file);
      
      if (provider) {
        this.providers.set(provider.name, provider);
      }
    }
  }

  private parseProvider(content: string, filePath: string): NestProvider | null {
    // Check for @Injectable decorator
    if (!content.includes('@Injectable')) return null;
    
    // Extract class name
    const classMatch = content.match(/@Injectable[^)]*\)\s*export\s+class\s+(\w+)/s);
    if (!classMatch) return null;
    
    const name = classMatch[1];
    
    // Determine provider type
    let type: NestProvider['type'] = 'service';
    if (filePath.includes('.repository.')) type = 'repository';
    else if (filePath.includes('.guard.')) type = 'guard';
    else if (filePath.includes('.interceptor.')) type = 'interceptor';
    else if (filePath.includes('.pipe.')) type = 'pipe';
    else if (filePath.includes('.filter.')) type = 'filter';
    
    // Extract constructor dependencies
    const constructorMatch = content.match(/constructor\s*\(([^)]*)\)/s);
    const dependencies = constructorMatch ? this.parseConstructorDependencies(constructorMatch[1]) : [];
    
    // Check scope
    const scopeMatch = content.match(/@Injectable\s*\(\s*{\s*scope:\s*Scope\.(\w+)/);
    const scope = scopeMatch ? scopeMatch[1].toLowerCase() as NestProvider['scope'] : 'singleton';
    
    return {
      name,
      filePath,
      type,
      scope,
      injectable: true,
      dependencies
    };
  }

  private parseConstructorDependencies(constructorParams: string): string[] {
    const dependencies: string[] = [];
    const paramRegex = /(?:private|protected|public|readonly)?\s*(\w+)\s*:\s*(\w+)/g;
    let match;
    
    while ((match = paramRegex.exec(constructorParams)) !== null) {
      dependencies.push(match[2]);
    }
    
    return dependencies;
  }

  private async discoverGuards(): Promise<void> {
    const tsFiles = await this.findFiles(['**/*.guard.ts'], this.options.excludePatterns);
    
    for (const file of tsFiles) {
      const content = await fs.readFile(file, 'utf-8');
      const guard = this.parseGuard(content, file);
      
      if (guard) {
        this.guards.set(guard.name, guard);
      }
    }
  }

  private parseGuard(content: string, filePath: string): NestGuard | null {
    const classMatch = content.match(/export\s+class\s+(\w+)\s+implements\s+CanActivate/);
    if (!classMatch) return null;
    
    return {
      name: classMatch[1],
      filePath,
      canActivate: true,
      global: content.includes('APP_GUARD')
    };
  }

  private async discoverInterceptors(): Promise<void> {
    const tsFiles = await this.findFiles(['**/*.interceptor.ts'], this.options.excludePatterns);
    
    for (const file of tsFiles) {
      const content = await fs.readFile(file, 'utf-8');
      const interceptor = this.parseInterceptor(content, file);
      
      if (interceptor) {
        this.interceptors.set(interceptor.name, interceptor);
      }
    }
  }

  private parseInterceptor(content: string, filePath: string): NestInterceptor | null {
    const classMatch = content.match(/export\s+class\s+(\w+)\s+implements\s+NestInterceptor/);
    if (!classMatch) return null;
    
    return {
      name: classMatch[1],
      filePath,
      global: content.includes('APP_INTERCEPTOR')
    };
  }

  private async discoverPipes(): Promise<void> {
    const tsFiles = await this.findFiles(['**/*.pipe.ts'], this.options.excludePatterns);
    
    for (const file of tsFiles) {
      const content = await fs.readFile(file, 'utf-8');
      const pipe = this.parsePipe(content, file);
      
      if (pipe) {
        this.pipes.set(pipe.name, pipe);
      }
    }
  }

  private parsePipe(content: string, filePath: string): NestPipe | null {
    const classMatch = content.match(/export\s+class\s+(\w+)\s+implements\s+PipeTransform/);
    if (!classMatch) return null;
    
    return {
      name: classMatch[1],
      filePath,
      global: content.includes('APP_PIPE'),
      transform: true
    };
  }

  private async discoverFilters(): Promise<void> {
    const tsFiles = await this.findFiles(['**/*.filter.ts'], this.options.excludePatterns);
    
    for (const file of tsFiles) {
      const content = await fs.readFile(file, 'utf-8');
      const filter = this.parseFilter(content, file);
      
      if (filter) {
        this.filters.set(filter.name, filter);
      }
    }
  }

  private parseFilter(content: string, filePath: string): NestFilter | null {
    const classMatch = content.match(/export\s+class\s+(\w+)\s+implements\s+ExceptionFilter/);
    if (!classMatch) return null;
    
    // Extract caught exceptions
    const catchMatch = content.match(/@Catch\s*\(([^)]*)\)/);
    const exceptionTypes = catchMatch ? this.extractIdentifiers(catchMatch[1]) : [];
    
    return {
      name: classMatch[1],
      filePath,
      exceptionTypes,
      global: content.includes('APP_FILTER')
    };
  }

  private extractIdentifiers(content: string): string[] {
    const identifiers: string[] = [];
    const regex = /(\w+)/g;
    let match;
    
    while ((match = regex.exec(content)) !== null) {
      identifiers.push(match[1]);
    }
    
    return identifiers;
  }

  private async discoverEntities(): Promise<void> {
    if (!this.hasTypeORM && !this.hasMikroORM && !this.hasMongoose) return;
    
    const tsFiles = await this.findFiles(['**/*.entity.ts', '**/*.schema.ts'], this.options.excludePatterns);
    
    for (const file of tsFiles) {
      const content = await fs.readFile(file, 'utf-8');
      const entity = this.parseEntity(content, file);
      
      if (entity) {
        this.entities.set(entity.name, entity);
      }
    }
  }

  private parseEntity(content: string, filePath: string): NestEntity | null {
    // TypeORM Entity
    if (content.includes('@Entity')) {
      return this.parseTypeORMEntity(content, filePath);
    }
    
    // Mongoose Schema
    if (content.includes('@Schema')) {
      return this.parseMongooseSchema(content, filePath);
    }
    
    return null;
  }

  private parseTypeORMEntity(content: string, filePath: string): NestEntity | null {
    const entityMatch = content.match(/@Entity\s*\(\s*(?:['"`]([^'"`]+)['"`])?\s*\)/);
    const classMatch = content.match(/@Entity[^}]*export\s+class\s+(\w+)/s);
    
    if (!classMatch) return null;
    
    const name = classMatch[1];
    const tableName = entityMatch?.[1];
    
    // Parse columns
    const columns = this.parseTypeORMColumns(content);
    
    // Parse relations
    const relations = this.parseTypeORMRelations(content);
    
    // Parse indexes
    const indexes = this.parseTypeORMIndexes(content);
    
    return {
      name,
      filePath,
      tableName,
      columns,
      relations,
      indexes
    };
  }

  private parseTypeORMColumns(content: string): NestEntityColumn[] {
    const columns: NestEntityColumn[] = [];
    
    const columnRegex = /@(Column|PrimaryColumn|PrimaryGeneratedColumn)\s*\([^)]*\)\s*(\w+)\s*:\s*(\w+)/g;
    let match;
    
    while ((match = columnRegex.exec(content)) !== null) {
      const decorator = match[1];
      const name = match[2];
      const type = match[3];
      
      columns.push({
        name,
        type,
        nullable: content.includes(`${name}?:`),
        unique: content.includes(`unique: true`),
        primary: decorator.includes('Primary'),
        generated: decorator.includes('Generated')
      });
    }
    
    return columns;
  }

  private parseTypeORMRelations(content: string): NestEntityRelation[] {
    const relations: NestEntityRelation[] = [];
    
    const relationTypes = [
      { decorator: 'OneToOne', type: 'one-to-one' as const },
      { decorator: 'OneToMany', type: 'one-to-many' as const },
      { decorator: 'ManyToOne', type: 'many-to-one' as const },
      { decorator: 'ManyToMany', type: 'many-to-many' as const }
    ];
    
    for (const { decorator, type } of relationTypes) {
      const regex = new RegExp(`@${decorator}\\s*\\([^)]*\\)\\s*(\\w+)`, 'g');
      let match;
      
      while ((match = regex.exec(content)) !== null) {
        relations.push({
          name: match[1],
          type,
          target: '',
          cascade: content.includes('cascade: true')
        });
      }
    }
    
    return relations;
  }

  private parseTypeORMIndexes(content: string): string[] {
    const indexes: string[] = [];
    const indexRegex = /@Index\s*\(\s*['"`]([^'"`]+)['"`]/g;
    let match;
    
    while ((match = indexRegex.exec(content)) !== null) {
      indexes.push(match[1]);
    }
    
    return indexes;
  }

  private parseMongooseSchema(content: string, filePath: string): NestEntity | null {
    const classMatch = content.match(/@Schema[^}]*export\s+class\s+(\w+)/s);
    if (!classMatch) return null;
    
    const name = classMatch[1];
    
    // Parse Prop decorators for columns
    const columns: NestEntityColumn[] = [];
    const propRegex = /@Prop\s*\([^)]*\)\s*(\w+)\s*:\s*(\w+)/g;
    let match;
    
    while ((match = propRegex.exec(content)) !== null) {
      columns.push({
        name: match[1],
        type: match[2],
        nullable: content.includes(`${match[1]}?:`),
        unique: false,
        primary: false,
        generated: false
      });
    }
    
    return {
      name,
      filePath,
      columns,
      relations: [],
      indexes: []
    };
  }

  private async countLinesOfCode(filePath: string): Promise<number> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return content.split('\n').length;
    } catch {
      return 0;
    }
  }

  private async buildNestConnections(): Promise<Connection[]> {
    const connections: Connection[] = [];
    
    // Module dependencies
    for (const [moduleId, module] of this.modules) {
      for (const importedModule of module.imports) {
        connections.push({
          source: moduleId,
          target: importedModule,
          type: 'module-import',
          protocol: 'nestjs',
          metadata: { importType: 'module' }
        });
      }
      
      for (const controller of module.controllers) {
        connections.push({
          source: moduleId,
          target: controller,
          type: 'module-controller',
          protocol: 'nestjs',
          metadata: { relationship: 'contains' }
        });
      }
      
      for (const provider of module.providers) {
        connections.push({
          source: moduleId,
          target: provider,
          type: 'module-provider',
          protocol: 'nestjs',
          metadata: { relationship: 'provides' }
        });
      }
    }
    
    // Provider dependencies
    for (const [providerId, provider] of this.providers) {
      for (const dep of provider.dependencies) {
        connections.push({
          source: providerId,
          target: dep,
          type: 'dependency-injection',
          protocol: 'nestjs',
          metadata: { scope: provider.scope }
        });
      }
    }
    
    // Entity relations
    for (const [entityId, entity] of this.entities) {
      for (const relation of entity.relations) {
        if (relation.target) {
          connections.push({
            source: entityId,
            target: relation.target,
            type: 'data-relationship',
            protocol: 'typeorm',
            metadata: {
              relationType: relation.type,
              cascade: relation.cascade
            }
          });
        }
      }
    }
    
    return connections;
  }

  private extractNestEndpoints(): APIEndpoint[] {
    const endpoints: APIEndpoint[] = [];
    
    for (const [controllerId, controller] of this.controllers) {
      const basePath = controller.path || '';
      
      for (const method of controller.methods) {
        const fullPath = `${basePath}/${method.path}`.replace(/\/+/g, '/');
        
        endpoints.push({
          path: fullPath,
          method: method.httpMethod as APIEndpoint['method'],
          handler: `${controller.name}.${method.name}`,
          parameters: method.params.map(p => ({
            name: p.name,
            in: p.type as any,
            required: p.required,
            type: p.dataType || 'string'
          })),
          responses: [],
          middleware: [...controller.guards, ...controller.interceptors, ...controller.pipes],
          authentication: controller.guards.length > 0,
          rateLimit: undefined,
          deprecated: false
        });
      }
    }
    
    return endpoints;
  }

  private async extractDatabaseConnections(): Promise<DatabaseConnection[]> {
    const connections: DatabaseConnection[] = [];
    
    if (this.hasTypeORM) {
      connections.push({
        name: 'TypeORM',
        type: 'postgresql',
        host: 'localhost',
        port: 5432,
        database: 'nestjs',
        schema: 'public',
        tables: this.entities.size,
        relationships: Array.from(this.entities.values()).reduce((sum, e) => sum + e.relations.length, 0),
        indexes: Array.from(this.entities.values()).reduce((sum, e) => sum + e.indexes.length, 0)
      });
    }
    
    if (this.hasMikroORM) {
      connections.push({
        name: 'MikroORM',
        type: 'postgresql',
        host: 'localhost',
        port: 5432,
        database: 'nestjs',
        schema: 'public',
        tables: this.entities.size,
        relationships: 0,
        indexes: 0
      });
    }
    
    if (this.hasMongoose) {
      connections.push({
        name: 'MongoDB (Mongoose)',
        type: 'mongodb',
        host: 'localhost',
        port: 27017,
        database: 'nestjs',
        schema: '',
        tables: this.entities.size,
        relationships: 0,
        indexes: 0
      });
    }
    
    if (this.hasPrisma) {
      connections.push({
        name: 'Prisma ORM',
        type: 'postgresql',
        host: 'localhost',
        port: 5432,
        database: 'nestjs',
        schema: 'public',
        tables: 0,
        relationships: 0,
        indexes: 0
      });
    }
    
    return connections;
  }

  private findNestEntryPoints(): string[] {
    return ['main.ts', 'src/main.ts', 'app.module.ts', 'src/app.module.ts'];
  }

  private buildNestLayers(): Record<string, string[]> {
    return {
      'modules': Array.from(this.modules.keys()),
      'controllers': Array.from(this.controllers.keys()),
      'providers': Array.from(this.providers.keys()),
      'guards': Array.from(this.guards.keys()),
      'interceptors': Array.from(this.interceptors.keys()),
      'pipes': Array.from(this.pipes.keys()),
      'filters': Array.from(this.filters.keys()),
      'entities': Array.from(this.entities.keys())
    };
  }

  async analyzePerformance(): Promise<any> {
    const performance = await super.analyzePerformance();
    
    return {
      ...performance,
      nestjs: {
        modulesCount: this.modules.size,
        controllersCount: this.controllers.size,
        providersCount: this.providers.size,
        guardsCount: this.guards.size,
        interceptorsCount: this.interceptors.size,
        pipesCount: this.pipes.size,
        filtersCount: this.filters.size,
        entitiesCount: this.entities.size,
        averageMethodsPerController: this.calculateAverageMethodsPerController(),
        averageDependenciesPerProvider: this.calculateAverageDependencies(),
        features: {
          hasTypeORM: this.hasTypeORM,
          hasMikroORM: this.hasMikroORM,
          hasPrisma: this.hasPrisma,
          hasMongoose: this.hasMongoose,
          hasGraphQL: this.hasGraphQL,
          hasMicroservices: this.hasMicroservices,
          hasWebSockets: this.hasWebSockets,
          hasSwagger: this.hasSwagger
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

  private calculateAverageDependencies(): number {
    const providers = Array.from(this.providers.values());
    if (providers.length === 0) return 0;
    
    const totalDeps = providers.reduce((sum, p) => sum + p.dependencies.length, 0);
    return totalDeps / providers.length;
  }
}