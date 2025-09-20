import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint } from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';
import { glob } from 'glob';

interface LaravelApplication {
  name: string;
  version: string;
  type: 'laravel' | 'lumen' | 'custom';
  hasEnvConfig: boolean;
  database: string[];
  cache: string[];
  queue: string[];
  session: string;
  mail: string;
}

interface LaravelController {
  name: string;
  filePath: string;
  namespace: string;
  methods: Array<{ name: string; visibility: string; parameters: any[]; returnType?: string }>;
  middleware: string[];
  resourceController: boolean;
  apiController: boolean;
  traits: string[];
  dependencies: string[];
}

interface LaravelModel {
  name: string;
  filePath: string;
  table?: string;
  primaryKey: string;
  fillable: string[];
  guarded: string[];
  hidden: string[];
  casts: Record<string, string>;
  relations: Array<{ name: string; type: string; model: string; foreignKey?: string }>;
  scopes: string[];
  mutators: string[];
  accessors: string[];
  traits: string[];
}

interface LaravelMigration {
  name: string;
  filePath: string;
  table: string;
  action: 'create' | 'modify' | 'drop';
  columns: Array<{ name: string; type: string; modifiers: string[] }>;
  indexes: Array<{ type: string; columns: string[] }>;
  foreignKeys: Array<{ column: string; references: string; on: string }>;
}

interface LaravelRoute {
  method: string | string[];
  uri: string;
  name?: string;
  controller?: string;
  action?: string;
  middleware: string[];
  where: Record<string, string>;
  parameters: string[];
  group?: string;
}

interface LaravelMiddleware {
  name: string;
  filePath: string;
  handle: { parameters: any[]; returnType?: string };
  terminate?: { parameters: any[]; returnType?: string };
  global: boolean;
  routeMiddleware: boolean;
  middlewareGroups: string[];
}

interface LaravelService {
  name: string;
  filePath: string;
  bindings: Array<{ abstract: string; concrete: string; singleton: boolean }>;
  dependencies: string[];
  methods: Array<{ name: string; visibility: string; parameters: any[] }>;
}

interface LaravelCommand {
  name: string;
  filePath: string;
  signature: string;
  description: string;
  handle: { parameters: any[]; returnType?: string };
  arguments: Array<{ name: string; required: boolean; description?: string }>;
  options: Array<{ name: string; shortcut?: string; mode: string; description?: string }>;
}

interface LaravelJob {
  name: string;
  filePath: string;
  queue?: string;
  connection?: string;
  tries?: number;
  timeout?: number;
  handle: { parameters: any[]; returnType?: string };
  failed?: { parameters: any[]; returnType?: string };
  shouldQueue: boolean;
}

export class LaravelAnalyzer extends BaseAnalyzer {
  constructor() {
    super(
      'laravel-analyzer',
      'Laravel Framework Analyzer',
      '1.0.0',
      'framework'
    );
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const composerJsonPath = path.join(projectPath, 'composer.json');
      if (await fs.pathExists(composerJsonPath)) {
        const composerJson = await fs.readJson(composerJsonPath);
        const deps = { ...composerJson.require, ...composerJson['require-dev'] };

        if (Object.keys(deps).some(dep =>
          dep === 'laravel/framework' ||
          dep === 'laravel/laravel' ||
          dep === 'laravel/lumen-framework'
        )) {
          return true;
        }
      }

      const artisanExists = await fs.pathExists(path.join(projectPath, 'artisan'));
      if (artisanExists) return true;

      const phpFiles = await glob(['**/*.php'], {
        cwd: projectPath,
        ignore: ['**/vendor/**', '**/node_modules/**', '**/.git/**', '**/storage/framework/**', '**/bootstrap/cache/**']
      });

      for (const file of phpFiles) {
        const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
        if (content.includes('Illuminate\\') || content.includes('use Laravel\\')) {
          return true;
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    try {
      const phpFiles = await glob(['**/*.php'], {
        cwd: context.projectPath,
        ignore: ['**/vendor/**', '**/node_modules/**', '**/.git/**', '**/storage/framework/**', '**/bootstrap/cache/**', '**/tests/**', '**/test/**']
      });

      const application = await this.analyzeApplication(context.projectPath, nodes);
      const controllers = await this.analyzeControllers(phpFiles, context.projectPath, nodes, edges);
      const models = await this.analyzeModels(phpFiles, context.projectPath, nodes, edges);
      const migrations = await this.analyzeMigrations(phpFiles, context.projectPath, nodes, edges);
      const routes = await this.analyzeRoutes(context.projectPath, nodes, edges, entryPoints);
      const middleware = await this.analyzeMiddleware(phpFiles, context.projectPath, nodes, edges);
      const services = await this.analyzeServices(phpFiles, context.projectPath, nodes, edges);
      const commands = await this.analyzeCommands(phpFiles, context.projectPath, nodes, edges);
      const jobs = await this.analyzeJobs(phpFiles, context.projectPath, nodes, edges);

      this.buildLaravelRelationships(controllers, models, migrations, routes, middleware, services, commands, jobs, nodes, edges);
      this.identifyDatabaseConnections(models, migrations, exitPoints);
      this.identifyExternalConnections(controllers, services, jobs, exitPoints);

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework_specific: {
          laravel_version: await this.detectLaravelVersion(context.projectPath),
          application_type: application?.type || 'custom',
          database_drivers: application?.database || [],
          cache_drivers: application?.cache || [],
          queue_drivers: application?.queue || [],
          controllers_detected: controllers.length,
          models_detected: models.length,
          migrations_detected: migrations.length,
          routes_detected: routes.length,
          middleware_detected: middleware.length,
          services_detected: services.length,
          commands_detected: commands.length,
          jobs_detected: jobs.length
        }
      });

    } catch (error) {
      throw new AnalyzerError(
        `Laravel analysis failed: ${(error as Error).message}`,
        'LARAVEL_ANALYSIS_ERROR'
      );
    }
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'system';
      case 2: return 'architectural';
      case 3: return 'code';
      case 4: return 'member';
      case 5: return 'implementation';
      default: return `level_${level}`;
    }
  }

  protected getCapabilities(): string[] {
    return [
      'mvc-pattern-analysis',
      'eloquent-model-mapping',
      'route-detection',
      'middleware-analysis',
      'migration-parsing',
      'artisan-command-detection',
      'job-queue-analysis',
      'service-provider-detection',
      'dependency-injection-mapping'
    ];
  }

  private async analyzeApplication(projectPath: string, nodes: CASNode[]): Promise<LaravelApplication | null> {
    try {
      const composerJson = await fs.readJson(path.join(projectPath, 'composer.json'));
      const deps = { ...composerJson.require, ...composerJson['require-dev'] };

      let type: 'laravel' | 'lumen' | 'custom' = 'custom';
      if (deps['laravel/framework']) type = 'laravel';
      else if (deps['laravel/lumen-framework']) type = 'lumen';

      const hasEnvConfig = await fs.pathExists(path.join(projectPath, '.env'));
      const database = this.detectDatabaseDrivers(deps);
      const cache = this.detectCacheDrivers(deps);
      const queue = this.detectQueueDrivers(deps);
      const session = this.detectSessionDriver(deps);
      const mail = this.detectMailDriver(deps);
      const version = deps['laravel/framework'] || deps['laravel/lumen-framework'] || 'unknown';

      const application: LaravelApplication = {
        name: composerJson.name || 'laravel-app',
        version,
        type,
        hasEnvConfig,
        database,
        cache,
        queue,
        session,
        mail
      };

      const appId = this.generateId('app', path.join(projectPath, 'composer.json'), application.name);
      const appNode = this.createNodeBuilder(appId, application.name, 'laravel_app')
        .withLevel(1, 'system')
        .withCategory('backend', ['laravel', 'php', 'application'])
        .withSource({ file: path.join(projectPath, 'composer.json'), line: 1, end_line: 1 })
        .withDescription(`Laravel application: ${application.name}`)
        .withMetadata({
          framework: 'laravel',
          attributes: {
            type,
            version,
            has_env_config: hasEnvConfig,
            database_drivers: database,
            cache_drivers: cache,
            queue_drivers: queue,
            session_driver: session,
            mail_driver: mail
          }
        })
        .build();
      nodes.push(appNode);

      return application;
    } catch {
      return null;
    }
  }

  private async analyzeControllers(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<LaravelController[]> {
    const controllers: LaravelController[] = [];
    const controllerFiles = files.filter(f => f.includes('/Controllers/') || f.includes('Controller.php'));

    for (const file of controllerFiles) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('class ') && (content.includes('Controller') || content.includes('extends Controller'))) {
        try {
          const controller = this.extractController(content, file);
          if (controller) {
            controllers.push(controller);

            const controllerId = this.generateId('controller', controller.filePath, controller.name);
            const controllerNode = this.createNodeBuilder(controllerId, controller.name, 'laravel_controller')
              .withLevel(2, 'architectural')
              .withCategory('controller', ['laravel', 'mvc', 'http'])
              .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
              .withDescription(`Laravel controller: ${controller.name}`)
              .withMetadata({
                framework: 'laravel',
                attributes: {
                  namespace: controller.namespace,
                  methods_count: controller.methods.length,
                  middleware_count: controller.middleware.length,
                  resource_controller: controller.resourceController,
                  api_controller: controller.apiController,
                  traits_count: controller.traits.length,
                  dependencies_count: controller.dependencies.length
                }
              })
              .build();
            nodes.push(controllerNode);

            controller.methods.forEach((method, index) => {
              const methodId = this.generateId('method', controller.filePath, `${controller.name}_${method.name}`);
              const methodNode = this.createNodeBuilder(methodId, method.name, 'controller_method')
                .withLevel(4, 'member')
                .withCategory('method', ['laravel', 'action'])
                .withSource({ file: fullPath, line: 1, end_line: 1 })
                .withDescription(`Controller method in ${controller.name}: ${method.name}`)
                .withParent(controllerId)
                .withSignature({
                  parameters: method.parameters.map(p => ({ name: p.name || 'param', type: p.type || 'mixed' })),
                  return_type: method.returnType
                })
                .withMetadata({
                  framework: 'laravel',
                  attributes: {
                    visibility: method.visibility
                  }
                })
                .build();
              nodes.push(methodNode);

              edges.push(this.createEdge(
                this.generateEdgeId(controllerId, methodId, 'contains'),
                controllerId,
                methodId,
                'contains',
                'structural'
              ));
            });
          }
        } catch (error) {
          console.warn(`Failed to parse Laravel controller ${file}:`, error);
        }
      }
    }

    return controllers;
  }

  private async analyzeModels(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<LaravelModel[]> {
    const models: LaravelModel[] = [];
    const modelFiles = files.filter(f =>
      f.includes('/Models/') ||
      (f.includes('/app/') && !f.includes('Controller') && !f.includes('Middleware'))
    );

    for (const file of modelFiles) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('class ') && (content.includes('extends Model') || content.includes('use HasFactory'))) {
        try {
          const model = this.extractModel(content, file);
          if (model) {
            models.push(model);

            const modelId = this.generateId('model', model.filePath, model.name);
            const modelNode = this.createNodeBuilder(modelId, model.name, 'laravel_model')
              .withLevel(2, 'architectural')
              .withCategory('model', ['laravel', 'eloquent', 'database'])
              .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
              .withDescription(`Laravel Eloquent model: ${model.name}`)
              .withMetadata({
                framework: 'laravel',
                attributes: {
                  table: model.table,
                  primary_key: model.primaryKey,
                  fillable_count: model.fillable.length,
                  guarded_count: model.guarded.length,
                  hidden_count: model.hidden.length,
                  casts_count: Object.keys(model.casts).length,
                  relations_count: model.relations.length,
                  scopes_count: model.scopes.length,
                  mutators_count: model.mutators.length,
                  accessors_count: model.accessors.length,
                  traits_count: model.traits.length
                }
              })
              .build();
            nodes.push(modelNode);

            model.relations.forEach((relation, index) => {
              const relationId = this.generateId('relation', model.filePath, `${model.name}_${relation.name}`);
              const relationNode = this.createNodeBuilder(relationId, relation.name, 'eloquent_relation')
                .withLevel(4, 'member')
                .withCategory('relation', ['laravel', 'eloquent'])
                .withSource({ file: fullPath, line: 1, end_line: 1 })
                .withDescription(`Eloquent relationship in ${model.name}: ${relation.name}`)
                .withParent(modelId)
                .withMetadata({
                  framework: 'laravel',
                  attributes: {
                    relation_type: relation.type,
                    related_model: relation.model,
                    foreign_key: relation.foreignKey
                  }
                })
                .build();
              nodes.push(relationNode);

              edges.push(this.createEdge(
                this.generateEdgeId(modelId, relationId, 'contains'),
                modelId,
                relationId,
                'contains',
                'structural'
              ));
            });
          }
        } catch (error) {
          console.warn(`Failed to parse Laravel model ${file}:`, error);
        }
      }
    }

    return models;
  }

  private async analyzeMigrations(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<LaravelMigration[]> {
    const migrations: LaravelMigration[] = [];
    const migrationFiles = files.filter(f => f.includes('database/migrations/'));

    for (const file of migrationFiles) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('class ') && content.includes('extends Migration')) {
        try {
          const migration = this.extractMigration(content, file);
          if (migration) {
            migrations.push(migration);

            const migrationId = this.generateId('migration', migration.filePath, migration.name);
            const migrationNode = this.createNodeBuilder(migrationId, migration.name, 'laravel_migration')
              .withLevel(3, 'code')
              .withCategory('migration', ['laravel', 'database', 'schema'])
              .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
              .withDescription(`Laravel migration: ${migration.name}`)
              .withMetadata({
                framework: 'laravel',
                attributes: {
                  table: migration.table,
                  action: migration.action,
                  columns_count: migration.columns.length,
                  indexes_count: migration.indexes.length,
                  foreign_keys_count: migration.foreignKeys.length
                }
              })
              .build();
            nodes.push(migrationNode);
          }
        } catch (error) {
          console.warn(`Failed to parse Laravel migration ${file}:`, error);
        }
      }
    }

    return migrations;
  }

  private async analyzeRoutes(
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): Promise<LaravelRoute[]> {
    const routes: LaravelRoute[] = [];

    const routeFiles = [
      'routes/web.php',
      'routes/api.php',
      'routes/console.php',
      'routes/channels.php'
    ];

    for (const routeFile of routeFiles) {
      const fullPath = path.join(projectPath, routeFile);
      if (await fs.pathExists(fullPath)) {
        try {
          const content = await fs.readFile(fullPath, 'utf-8');
          const extractedRoutes = this.extractRoutes(content, routeFile);
          routes.push(...extractedRoutes);

          extractedRoutes.forEach((route, index) => {
            const routeId = this.generateId('route', routeFile, `${route.method}_${route.uri}_${index}`);
            const routeNode = this.createNodeBuilder(routeId, `${route.method} ${route.uri}`, 'laravel_route')
              .withLevel(3, 'code')
              .withCategory('route', ['laravel', 'http'])
              .withSource({ file: fullPath, line: 1, end_line: 1 })
              .withDescription(`Laravel route: ${route.method} ${route.uri}`)
              .withMetadata({
                framework: 'laravel',
                attributes: {
                  method: route.method,
                  uri: route.uri,
                  name: route.name,
                  controller: route.controller,
                  action: route.action,
                  middleware: route.middleware,
                  where: route.where,
                  parameters: route.parameters,
                  group: route.group
                }
              })
              .build();
            nodes.push(routeNode);

            const methods = Array.isArray(route.method) ? route.method : [route.method];
            methods.forEach(method => {
              entryPoints.push(this.createEntryPoint(
                `entry_${routeId}_${method}`,
                routeId,
                'http',
                `${method.toUpperCase()} ${route.uri}`,
                `Laravel HTTP endpoint: ${method.toUpperCase()} ${route.uri}`,
                {
                  method: method.toUpperCase(),
                  path: route.uri
                },
                {
                  authenticated: route.middleware.some(m => m.includes('auth')),
                  authorized_roles: route.middleware.filter(m => m.includes('role') || m.includes('permission'))
                },
                {
                  controller: route.controller,
                  action: route.action,
                  name: route.name,
                  middleware: route.middleware
                }
              ));
            });
          });
        } catch (error) {
          console.warn(`Failed to parse Laravel routes ${routeFile}:`, error);
        }
      }
    }

    return routes;
  }

  private async analyzeMiddleware(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<LaravelMiddleware[]> {
    const middleware: LaravelMiddleware[] = [];
    const middlewareFiles = files.filter(f =>
      f.includes('/Middleware/') ||
      f.includes('Middleware.php')
    );

    for (const file of middlewareFiles) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('class ') && content.includes('handle')) {
        try {
          const mw = this.extractMiddleware(content, file);
          if (mw) {
            middleware.push(mw);

            const middlewareId = this.generateId('middleware', mw.filePath, mw.name);
            const middlewareNode = this.createNodeBuilder(middlewareId, mw.name, 'laravel_middleware')
              .withLevel(3, 'code')
              .withCategory('middleware', ['laravel', 'http', 'filter'])
              .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
              .withDescription(`Laravel middleware: ${mw.name}`)
              .withMetadata({
                framework: 'laravel',
                attributes: {
                  global: mw.global,
                  route_middleware: mw.routeMiddleware,
                  middleware_groups: mw.middlewareGroups,
                  has_terminate: !!mw.terminate
                }
              })
              .build();
            nodes.push(middlewareNode);
          }
        } catch (error) {
          console.warn(`Failed to parse Laravel middleware ${file}:`, error);
        }
      }
    }

    return middleware;
  }

  private async analyzeServices(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<LaravelService[]> {
    const services: LaravelService[] = [];
    const serviceFiles = files.filter(f =>
      f.includes('/Providers/') ||
      f.includes('ServiceProvider.php') ||
      f.includes('/Services/')
    );

    for (const file of serviceFiles) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('class ') && (content.includes('ServiceProvider') || content.includes('/Services/'))) {
        try {
          const service = this.extractService(content, file);
          if (service) {
            services.push(service);

            const serviceId = this.generateId('service', service.filePath, service.name);
            const serviceNode = this.createNodeBuilder(serviceId, service.name, 'laravel_service')
              .withLevel(2, 'architectural')
              .withCategory('service', ['laravel', 'provider'])
              .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
              .withDescription(`Laravel service: ${service.name}`)
              .withMetadata({
                framework: 'laravel',
                attributes: {
                  bindings_count: service.bindings.length,
                  dependencies_count: service.dependencies.length,
                  methods_count: service.methods.length
                }
              })
              .build();
            nodes.push(serviceNode);
          }
        } catch (error) {
          console.warn(`Failed to parse Laravel service ${file}:`, error);
        }
      }
    }

    return services;
  }

  private async analyzeCommands(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<LaravelCommand[]> {
    const commands: LaravelCommand[] = [];
    const commandFiles = files.filter(f =>
      f.includes('/Console/Commands/') ||
      f.includes('Command.php')
    );

    for (const file of commandFiles) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('class ') && content.includes('extends Command')) {
        try {
          const command = this.extractCommand(content, file);
          if (command) {
            commands.push(command);

            const commandId = this.generateId('command', command.filePath, command.name);
            const commandNode = this.createNodeBuilder(commandId, command.name, 'laravel_command')
              .withLevel(3, 'code')
              .withCategory('command', ['laravel', 'artisan', 'cli'])
              .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
              .withDescription(`Laravel Artisan command: ${command.name}`)
              .withMetadata({
                framework: 'laravel',
                attributes: {
                  signature: command.signature,
                  description: command.description,
                  arguments_count: command.arguments.length,
                  options_count: command.options.length
                }
              })
              .build();
            nodes.push(commandNode);
          }
        } catch (error) {
          console.warn(`Failed to parse Laravel command ${file}:`, error);
        }
      }
    }

    return commands;
  }

  private async analyzeJobs(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<LaravelJob[]> {
    const jobs: LaravelJob[] = [];
    const jobFiles = files.filter(f =>
      f.includes('/Jobs/') ||
      f.includes('Job.php')
    );

    for (const file of jobFiles) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('class ') && (content.includes('ShouldQueue') || content.includes('handle'))) {
        try {
          const job = this.extractJob(content, file);
          if (job) {
            jobs.push(job);

            const jobId = this.generateId('job', job.filePath, job.name);
            const jobNode = this.createNodeBuilder(jobId, job.name, 'laravel_job')
              .withLevel(3, 'code')
              .withCategory('job', ['laravel', 'queue', 'async'])
              .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
              .withDescription(`Laravel job: ${job.name}`)
              .withMetadata({
                framework: 'laravel',
                attributes: {
                  queue: job.queue,
                  connection: job.connection,
                  tries: job.tries,
                  timeout: job.timeout,
                  should_queue: job.shouldQueue,
                  has_failed: !!job.failed
                }
              })
              .build();
            nodes.push(jobNode);
          }
        } catch (error) {
          console.warn(`Failed to parse Laravel job ${file}:`, error);
        }
      }
    }

    return jobs;
  }

  private detectDatabaseDrivers(deps: Record<string, any>): string[] {
    const drivers: string[] = [];
    if (deps['doctrine/dbal']) drivers.push('mysql', 'postgresql', 'sqlite');
    return drivers;
  }

  private detectCacheDrivers(deps: Record<string, any>): string[] {
    const drivers: string[] = [];
    if (deps['predis/predis']) drivers.push('redis');
    if (deps['aws/aws-sdk-php']) drivers.push('dynamodb');
    return drivers;
  }

  private detectQueueDrivers(deps: Record<string, any>): string[] {
    const drivers: string[] = [];
    if (deps['predis/predis']) drivers.push('redis');
    if (deps['aws/aws-sdk-php']) drivers.push('sqs');
    return drivers;
  }

  private detectSessionDriver(deps: Record<string, any>): string {
    if (deps['predis/predis']) return 'redis';
    return 'file';
  }

  private detectMailDriver(deps: Record<string, any>): string {
    if (deps['aws/aws-sdk-php']) return 'ses';
    return 'smtp';
  }

  private extractController(content: string, filePath: string): LaravelController | null {
    const classMatch = content.match(/class\s+(\w+)/);
    if (!classMatch) return null;

    const className = classMatch[1];
    const namespaceMatch = content.match(/namespace\s+([^;]+);/);
    const namespace = namespaceMatch ? namespaceMatch[1] : '';

    return {
      name: className,
      filePath,
      namespace,
      methods: this.extractMethods(content),
      middleware: this.extractControllerMiddleware(content),
      resourceController: content.includes('Resource'),
      apiController: content.includes('ApiController') || content.includes('/Api/'),
      traits: this.extractTraits(content),
      dependencies: this.extractDependencies(content)
    };
  }

  private extractModel(content: string, filePath: string): LaravelModel | null {
    const classMatch = content.match(/class\s+(\w+)/);
    if (!classMatch) return null;

    const className = classMatch[1];

    return {
      name: className,
      filePath,
      table: this.extractTable(content),
      primaryKey: this.extractPrimaryKey(content),
      fillable: this.extractFillable(content),
      guarded: this.extractGuarded(content),
      hidden: this.extractHidden(content),
      casts: this.extractCasts(content),
      relations: this.extractRelations(content),
      scopes: this.extractScopes(content),
      mutators: this.extractMutators(content),
      accessors: this.extractAccessors(content),
      traits: this.extractTraits(content)
    };
  }

  private extractMigration(content: string, filePath: string): LaravelMigration | null {
    const classMatch = content.match(/class\s+(\w+)/);
    if (!classMatch) return null;

    const className = classMatch[1];
    const fileName = path.basename(filePath, '.php');

    return {
      name: className,
      filePath,
      table: this.extractMigrationTable(content, fileName),
      action: this.extractMigrationAction(content, fileName),
      columns: this.extractMigrationColumns(content),
      indexes: this.extractMigrationIndexes(content),
      foreignKeys: this.extractMigrationForeignKeys(content)
    };
  }

  private extractRoutes(content: string, filePath: string): LaravelRoute[] {
    const routes: LaravelRoute[] = [];
    const routePattern = /Route::(\w+)\(\s*['"`]([^'"`]+)['"`]\s*,\s*([^)]+)\)/g;

    let match;
    while ((match = routePattern.exec(content)) !== null) {
      const method = match[1];
      const uri = match[2];
      const controller = match[3];

      routes.push({
        method,
        uri,
        controller: controller.includes('@') ? controller : undefined,
        middleware: this.extractRouteMiddleware(content, uri),
        where: this.extractRouteWhere(content, uri),
        parameters: this.extractRouteParameters(uri),
        name: this.extractRouteName(content, uri)
      });
    }

    return routes;
  }

  private extractMiddleware(content: string, filePath: string): LaravelMiddleware | null {
    const classMatch = content.match(/class\s+(\w+)/);
    if (!classMatch) return null;

    const className = classMatch[1];

    return {
      name: className,
      filePath,
      handle: { parameters: [] },
      terminate: content.includes('terminate') ? { parameters: [] } : undefined,
      global: false,
      routeMiddleware: false,
      middlewareGroups: []
    };
  }

  private extractService(content: string, filePath: string): LaravelService | null {
    const classMatch = content.match(/class\s+(\w+)/);
    if (!classMatch) return null;

    const className = classMatch[1];

    return {
      name: className,
      filePath,
      bindings: this.extractServiceBindings(content),
      dependencies: this.extractDependencies(content),
      methods: this.extractMethods(content)
    };
  }

  private extractCommand(content: string, filePath: string): LaravelCommand | null {
    const classMatch = content.match(/class\s+(\w+)/);
    if (!classMatch) return null;

    const className = classMatch[1];

    return {
      name: className,
      filePath,
      signature: this.extractCommandSignature(content),
      description: this.extractCommandDescription(content),
      handle: { parameters: [] },
      arguments: this.extractCommandArguments(content),
      options: this.extractCommandOptions(content)
    };
  }

  private extractJob(content: string, filePath: string): LaravelJob | null {
    const classMatch = content.match(/class\s+(\w+)/);
    if (!classMatch) return null;

    const className = classMatch[1];

    return {
      name: className,
      filePath,
      queue: this.extractJobQueue(content),
      connection: this.extractJobConnection(content),
      tries: this.extractJobTries(content),
      timeout: this.extractJobTimeout(content),
      handle: { parameters: [] },
      failed: content.includes('failed') ? { parameters: [] } : undefined,
      shouldQueue: content.includes('ShouldQueue')
    };
  }

  private extractMethods(content: string): Array<{ name: string; visibility: string; parameters: any[]; returnType?: string }> {
    const methods: Array<{ name: string; visibility: string; parameters: any[]; returnType?: string }> = [];
    const methodPattern = /(public|private|protected)?\s*function\s+(\w+)\s*\(/g;

    let match;
    while ((match = methodPattern.exec(content)) !== null) {
      const visibility = match[1] || 'public';
      const name = match[2];

      methods.push({
        name,
        visibility,
        parameters: []
      });
    }

    return methods;
  }

  private extractControllerMiddleware(content: string): string[] {
    const middleware: string[] = [];
    const middlewarePattern = /middleware\(['"`]([^'"`]+)['"`]\)/g;

    let match;
    while ((match = middlewarePattern.exec(content)) !== null) {
      middleware.push(match[1]);
    }

    return middleware;
  }

  private extractTraits(content: string): string[] {
    const traits: string[] = [];
    const traitPattern = /use\s+([A-Z]\w+(?:,\s*[A-Z]\w+)*);/g;

    let match;
    while ((match = traitPattern.exec(content)) !== null) {
      const traitNames = match[1].split(',').map(t => t.trim());
      traits.push(...traitNames);
    }

    return traits;
  }

  private extractDependencies(content: string): string[] {
    const dependencies: string[] = [];
    const usePattern = /use\s+([^;]+);/g;

    let match;
    while ((match = usePattern.exec(content)) !== null) {
      const useName = match[1].trim();
      if (useName.includes('\\')) {
        dependencies.push(useName);
      }
    }

    return dependencies;
  }

  private extractTable(content: string): string | undefined {
    const tableMatch = content.match(/\$table\s*=\s*['"`]([^'"`]+)['"`]/);
    return tableMatch ? tableMatch[1] : undefined;
  }

  private extractPrimaryKey(content: string): string {
    const pkMatch = content.match(/\$primaryKey\s*=\s*['"`]([^'"`]+)['"`]/);
    return pkMatch ? pkMatch[1] : 'id';
  }

  private extractFillable(content: string): string[] {
    const fillableMatch = content.match(/\$fillable\s*=\s*\[([^\]]+)\]/);
    if (!fillableMatch) return [];

    const fillableContent = fillableMatch[1];
    const fields = fillableContent.match(/['"`]([^'"`]+)['"`]/g);
    return fields ? fields.map(field => field.slice(1, -1)) : [];
  }

  private extractGuarded(content: string): string[] {
    return [];
  }

  private extractHidden(content: string): string[] {
    return [];
  }

  private extractCasts(content: string): Record<string, string> {
    return {};
  }

  private extractRelations(content: string): Array<{ name: string; type: string; model: string; foreignKey?: string }> {
    const relations: Array<{ name: string; type: string; model: string; foreignKey?: string }> = [];
    const relationPattern = /function\s+(\w+)\(\)[^{]*{\s*return\s+\$this->(\w+)\(([^)]+)\)/g;

    let match;
    while ((match = relationPattern.exec(content)) !== null) {
      const name = match[1];
      const type = match[2];
      const model = match[3];

      relations.push({
        name,
        type,
        model: model.replace(/['"]/g, '').split(',')[0].trim()
      });
    }

    return relations;
  }

  private extractScopes(content: string): string[] {
    return [];
  }

  private extractMutators(content: string): string[] {
    return [];
  }

  private extractAccessors(content: string): string[] {
    return [];
  }

  private extractMigrationTable(content: string, fileName: string): string {
    const tableMatch = content.match(/Schema::\w+\(['"`]([^'"`]+)['"`]/);
    if (tableMatch) return tableMatch[1];

    const fileTableMatch = fileName.match(/_create_(\w+)_table/);
    return fileTableMatch ? fileTableMatch[1] : 'unknown';
  }

  private extractMigrationAction(content: string, fileName: string): 'create' | 'modify' | 'drop' {
    if (content.includes('Schema::create')) return 'create';
    if (content.includes('Schema::drop')) return 'drop';
    return 'modify';
  }

  private extractMigrationColumns(content: string): Array<{ name: string; type: string; modifiers: string[] }> {
    return [];
  }

  private extractMigrationIndexes(content: string): Array<{ type: string; columns: string[] }> {
    return [];
  }

  private extractMigrationForeignKeys(content: string): Array<{ column: string; references: string; on: string }> {
    return [];
  }

  private extractRouteMiddleware(content: string, uri: string): string[] {
    return [];
  }

  private extractRouteWhere(content: string, uri: string): Record<string, string> {
    return {};
  }

  private extractRouteParameters(uri: string): string[] {
    const paramPattern = /\{(\w+)\??}/g;
    const params: string[] = [];
    let match;

    while ((match = paramPattern.exec(uri)) !== null) {
      params.push(match[1]);
    }

    return params;
  }

  private extractRouteName(content: string, uri: string): string | undefined {
    return undefined;
  }

  private extractServiceBindings(content: string): Array<{ abstract: string; concrete: string; singleton: boolean }> {
    return [];
  }

  private extractCommandSignature(content: string): string {
    const signatureMatch = content.match(/\$signature\s*=\s*['"`]([^'"`]+)['"`]/);
    return signatureMatch ? signatureMatch[1] : '';
  }

  private extractCommandDescription(content: string): string {
    const descriptionMatch = content.match(/\$description\s*=\s*['"`]([^'"`]+)['"`]/);
    return descriptionMatch ? descriptionMatch[1] : '';
  }

  private extractCommandArguments(content: string): Array<{ name: string; required: boolean; description?: string }> {
    return [];
  }

  private extractCommandOptions(content: string): Array<{ name: string; shortcut?: string; mode: string; description?: string }> {
    return [];
  }

  private extractJobQueue(content: string): string | undefined {
    const queueMatch = content.match(/\$queue\s*=\s*['"`]([^'"`]+)['"`]/);
    return queueMatch ? queueMatch[1] : undefined;
  }

  private extractJobConnection(content: string): string | undefined {
    return undefined;
  }

  private extractJobTries(content: string): number | undefined {
    const triesMatch = content.match(/\$tries\s*=\s*(\d+)/);
    return triesMatch ? parseInt(triesMatch[1]) : undefined;
  }

  private extractJobTimeout(content: string): number | undefined {
    const timeoutMatch = content.match(/\$timeout\s*=\s*(\d+)/);
    return timeoutMatch ? parseInt(timeoutMatch[1]) : undefined;
  }

  private async detectLaravelVersion(projectPath: string): Promise<string> {
    try {
      const composerJson = await fs.readJson(path.join(projectPath, 'composer.json'));
      const deps = { ...composerJson.require, ...composerJson['require-dev'] };
      return deps['laravel/framework'] || deps['laravel/lumen-framework'] || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private buildLaravelRelationships(
    controllers: LaravelController[],
    models: LaravelModel[],
    migrations: LaravelMigration[],
    routes: LaravelRoute[],
    middleware: LaravelMiddleware[],
    services: LaravelService[],
    commands: LaravelCommand[],
    jobs: LaravelJob[],
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    routes.forEach((route, index) => {
      if (route.controller) {
        const routeId = this.generateId('route', '', `${route.method}_${route.uri}_${index}`);
        const controllerId = this.generateId('controller', '', route.controller.split('@')[0]);

        edges.push(this.createEdge(
          this.generateEdgeId(routeId, controllerId, 'calls'),
          routeId,
          controllerId,
          'calls',
          'behavioral',
          {
            method: route.method,
            uri: route.uri,
            action: route.action
          }
        ));
      }
    });

    models.forEach(model => {
      const modelId = this.generateId('model', model.filePath, model.name);

      model.relations.forEach(relation => {
        const relatedModelId = this.generateId('model', '', relation.model);
        edges.push(this.createEdge(
          this.generateEdgeId(modelId, relatedModelId, 'relates_to'),
          modelId,
          relatedModelId,
          'relates_to',
          'data',
          {
            relation_type: relation.type,
            foreign_key: relation.foreignKey
          }
        ));
      });
    });
  }

  private identifyDatabaseConnections(models: LaravelModel[], migrations: LaravelMigration[], exitPoints: CASExitPoint[]): void {
    if (models.length > 0 || migrations.length > 0) {
      exitPoints.push(this.createExitPoint(
        'exit_laravel_database',
        'laravel_app',
        'database',
        'Database Connection',
        'Database operations through Eloquent ORM',
        {
          service_id: 'database-service',
          resource: 'database'
        },
        {
          action: 'read-write',
          async: false
        },
        {
          type: 'MySQL/PostgreSQL/SQLite',
          models: models.map(m => m.name),
          tables: migrations.map(m => m.table)
        }
      ));
    }
  }

  private identifyExternalConnections(
    controllers: LaravelController[],
    services: LaravelService[],
    jobs: LaravelJob[],
    exitPoints: CASExitPoint[]
  ): void {
    const hasHTTPConnection = controllers.some(c =>
      c.dependencies.some(dep => dep.includes('GuzzleHttp') || dep.includes('Http'))
    ) || services.some(s =>
      s.dependencies.some(dep => dep.includes('GuzzleHttp') || dep.includes('Http'))
    );

    if (hasHTTPConnection) {
      exitPoints.push(this.createExitPoint(
        'exit_laravel_http',
        'laravel_app',
        'api',
        'HTTP API Connection',
        'External HTTP API connections',
        {
          service_id: 'external-api',
          endpoint: 'various'
        },
        {
          action: 'read-write',
          async: true
        },
        {
          type: 'REST/SOAP API'
        }
      ));
    }

    if (jobs.length > 0) {
      exitPoints.push(this.createExitPoint(
        'exit_laravel_queue',
        'laravel_app',
        'message',
        'Queue System Connection',
        'Background job processing through Laravel queues',
        {
          service_id: 'queue-service',
          resource: 'queue'
        },
        {
          action: 'write',
          async: true
        },
        {
          type: 'Redis/SQS/Database Queue',
          jobs: jobs.map(j => j.name)
        }
      ));
    }
  }
}