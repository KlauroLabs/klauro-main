import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint,
  CASDocumentation, CASComment, CASTodo, CASImplementationStatus
} from "../../../types/cas.types";
import { AnalyzerError } from '../../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';

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
  methods: Array<{ name: string; visibility: string; parameters: any[]; returnType?: string; line: number }>;
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
  relations: Array<{ name: string; type: string; model: string; foreignKey?: string; line: number }>;
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
  methods: Array<{ name: string; visibility: string; parameters: any[]; line: number }>;
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
  private todoCounter = 0;
  private commentCounter = 0;

  constructor() {
    super(
      'laravel',
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
        ignore: [...this.getIgnorePatterns({ projectPath }), '**/storage/framework/**', '**/bootstrap/cache/**'],
        nodir: true
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
        ignore: [...this.getIgnorePatterns(context), '**/storage/framework/**', '**/bootstrap/cache/**', '**/tests/**', '**/test/**'],
        nodir: true
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
      const bladeTemplates = await this.analyzeBladeTemplates(context.projectPath, nodes, edges);
      const events = await this.analyzeEvents(phpFiles, context.projectPath, nodes, edges);
      const listeners = await this.analyzeListeners(phpFiles, context.projectPath, nodes, edges);
      const formRequests = await this.analyzeFormRequests(phpFiles, context.projectPath, nodes, edges);
      const resources = await this.analyzeResources(phpFiles, context.projectPath, nodes, edges);

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
          jobs_detected: jobs.length,
          blade_templates_detected: bladeTemplates.length,
          events_detected: events.length,
          listeners_detected: listeners.length,
          form_requests_detected: formRequests.length,
          resources_detected: resources.length
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
      'dependency-injection-mapping',
      'blade-template-analysis',
      'event-listener-analysis',
      'form-request-analysis',
      'api-resource-analysis'
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
      const documentation = this.extractDocumentation('', path.join(projectPath, 'composer.json'));
      const comments = this.extractComments('', path.join(projectPath, 'composer.json'));
      const todos = this.extractTodos(comments);
      const implementationStatus = this.determineImplementationStatus('', comments);

      const appNode = this.createNodeBuilder(appId, application.name, 'laravel_app')
        .withLevel(1, 'system')
        .withCategory('backend', ['laravel', 'php', 'application'])
        .withSource({ file: path.join(projectPath, 'composer.json'), line: 1, end_line: 1 })
        .withDescription(`Laravel application: ${application.name}`)
        .withDocumentation(documentation)
        .withComments(comments)
        .withTodos(todos)
        .withImplementationStatus(implementationStatus)
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
            const controllerDocumentation = this.extractDocumentation(content, fullPath);
            const controllerComments = this.extractComments(content, fullPath);
            const controllerTodos = this.extractTodos(controllerComments);
            const controllerImplementationStatus = this.determineImplementationStatus(content, controllerComments);

            const controllerNode = this.createNodeBuilder(controllerId, controller.name, 'laravel_controller')
              .withLevel(2, 'architectural')
              .withCategory('controller', ['laravel', 'mvc', 'http'])
              .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
              .withDescription(`Laravel controller: ${controller.name}`)
              .withDocumentation(controllerDocumentation)
              .withComments(controllerComments)
              .withTodos(controllerTodos)
              .withImplementationStatus(controllerImplementationStatus)
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
              const nextMethodLine = index < controller.methods.length - 1 ? controller.methods[index + 1].line - 1 : content.split('\n').length;
              const methodNode = this.createNodeBuilder(methodId, method.name, 'controller_method')
                .withLevel(4, 'member')
                .withCategory('method', ['laravel', 'action'])
                .withSource({ file: fullPath, line: method.line, end_line: nextMethodLine })
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
            const modelDocumentation = this.extractDocumentation(content, fullPath);
            const modelComments = this.extractComments(content, fullPath);
            const modelTodos = this.extractTodos(modelComments);
            const modelImplementationStatus = this.determineImplementationStatus(content, modelComments);

            const modelNode = this.createNodeBuilder(modelId, model.name, 'laravel_model')
              .withLevel(2, 'architectural')
              .withCategory('model', ['laravel', 'eloquent', 'database'])
              .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
              .withDescription(`Laravel Eloquent model: ${model.name}`)
              .withDocumentation(modelDocumentation)
              .withComments(modelComments)
              .withTodos(modelTodos)
              .withImplementationStatus(modelImplementationStatus)
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
              const nextRelationLine = index < model.relations.length - 1 ? model.relations[index + 1].line - 1 : content.split('\n').length;
              const relationNode = this.createNodeBuilder(relationId, relation.name, 'eloquent_relation')
                .withLevel(4, 'member')
                .withCategory('relation', ['laravel', 'eloquent'])
                .withSource({ file: fullPath, line: relation.line, end_line: nextRelationLine })
                .withDescription(`Eloquent relationship in ${model.name}: ${relation.name}`)
                .withParent(modelId)
                .withMetadata({
                  framework: 'laravel',
                  attributes: {
                    relation_type: relation.type,
                    related_model: relation.model,
                    owner_model: model.name,
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
            const middlewareDocumentation = this.extractDocumentation(content, fullPath);
            const middlewareComments = this.extractComments(content, fullPath);
            const middlewareTodos = this.extractTodos(middlewareComments);
            const middlewareImplementationStatus = this.determineImplementationStatus(content, middlewareComments);

            const middlewareNode = this.createNodeBuilder(middlewareId, mw.name, 'laravel_middleware')
              .withLevel(3, 'code')
              .withCategory('middleware', ['laravel', 'http', 'filter'])
              .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
              .withDescription(`Laravel middleware: ${mw.name}`)
              .withDocumentation(middlewareDocumentation)
              .withComments(middlewareComments)
              .withTodos(middlewareTodos)
              .withImplementationStatus(middlewareImplementationStatus)
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

  private async analyzeBladeTemplates(
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<string[]> {
    const bladeFiles = await glob(['resources/views/**/*.blade.php'], {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true
    });

    for (const file of bladeFiles) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');
      const templateName = file
        .replace('resources/views/', '')
        .replace('.blade.php', '')
        .replace(/\//g, '.');

      const templateId = this.generateId('blade', file, templateName);

      const sections: string[] = [];
      const sectionPattern = /@section\(\s*['"`]([^'"`]+)['"`]/g;
      let match;
      while ((match = sectionPattern.exec(content)) !== null) {
        sections.push(match[1]);
      }

      const yields: string[] = [];
      const yieldPattern = /@yield\(\s*['"`]([^'"`]+)['"`]/g;
      while ((match = yieldPattern.exec(content)) !== null) {
        yields.push(match[1]);
      }

      const templateNode = this.createNodeBuilder(templateId, templateName, 'laravel_blade_template')
        .withLevel(3, 'code')
        .withCategory('view', ['laravel', 'blade', 'template'])
        .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
        .withDescription(`Blade template: ${templateName}`)
        .withMetadata({
          framework: 'laravel',
          attributes: {
            sections,
            yields,
            template_name: templateName
          }
        })
        .build();
      nodes.push(templateNode);

      const extendsPattern = /@extends\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
      while ((match = extendsPattern.exec(content)) !== null) {
        const parentTemplate = match[1];
        const parentId = this.generateId('blade', '', parentTemplate);
        edges.push(this.createEdge(
          this.generateEdgeId(templateId, parentId, 'extends'),
          templateId,
          parentId,
          'extends',
          'structural',
          { parent_template: parentTemplate }
        ));
      }

      const includePattern = /@include\(\s*['"`]([^'"`]+)['"`]/g;
      while ((match = includePattern.exec(content)) !== null) {
        const includedTemplate = match[1];
        const includedId = this.generateId('blade', '', includedTemplate);
        edges.push(this.createEdge(
          this.generateEdgeId(templateId, includedId, 'includes'),
          templateId,
          includedId,
          'includes',
          'structural',
          { included_template: includedTemplate }
        ));
      }
    }

    return bladeFiles;
  }

  private async analyzeEvents(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<string[]> {
    const eventFiles = files.filter(f => f.includes('/Events/'));
    const events: string[] = [];

    for (const file of eventFiles) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('class ') && (content.includes('extends Event') || content.includes('Dispatchable'))) {
        const classMatch = content.match(/class\s+(\w+)/);
        if (!classMatch) continue;

        const className = classMatch[1];
        events.push(className);

        const eventId = this.generateId('event', file, className);
        const eventNode = this.createNodeBuilder(eventId, className, 'laravel_event')
          .withLevel(3, 'code')
          .withCategory('event', ['laravel', 'event', 'async'])
          .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
          .withDescription(`Laravel event: ${className}`)
          .withMetadata({
            framework: 'laravel',
            attributes: {
              has_broadcast: content.includes('ShouldBroadcast'),
              traits: this.extractTraits(content)
            }
          })
          .build();
        nodes.push(eventNode);
      }
    }

    return events;
  }

  private async analyzeListeners(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<string[]> {
    const listenerFiles = files.filter(f => f.includes('/Listeners/'));
    const listeners: string[] = [];

    for (const file of listenerFiles) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('class ') && content.includes('handle')) {
        const classMatch = content.match(/class\s+(\w+)/);
        if (!classMatch) continue;

        const className = classMatch[1];
        listeners.push(className);

        const listenerId = this.generateId('listener', file, className);
        const listenerNode = this.createNodeBuilder(listenerId, className, 'laravel_listener')
          .withLevel(3, 'code')
          .withCategory('listener', ['laravel', 'event', 'handler'])
          .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
          .withDescription(`Laravel listener: ${className}`)
          .withMetadata({
            framework: 'laravel',
            attributes: {
              should_queue: content.includes('ShouldQueue')
            }
          })
          .build();
        nodes.push(listenerNode);

        const handlePattern = /function\s+handle\(\s*(\w+)\s+/;
        const handleMatch = content.match(handlePattern);
        if (handleMatch) {
          const eventClass = handleMatch[1];
          const eventId = this.generateId('event', '', eventClass);
          edges.push(this.createEdge(
            this.generateEdgeId(listenerId, eventId, 'handles'),
            listenerId,
            eventId,
            'handles',
            'behavioral',
            { event: eventClass }
          ));
        }
      }
    }

    const eventServiceProviderFiles = files.filter(f => f.includes('EventServiceProvider'));
    for (const file of eventServiceProviderFiles) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      const listenPropertyPattern = /\$listen\s*=\s*\[([\s\S]*?)\];/;
      const listenMatch = content.match(listenPropertyPattern);
      if (listenMatch) {
        const listenBody = listenMatch[1];
        const mappingPattern = /(\w+)::class\s*=>\s*\[([\s\S]*?)\]/g;
        let mappingMatch;
        while ((mappingMatch = mappingPattern.exec(listenBody)) !== null) {
          const eventClass = mappingMatch[1];
          const listenersBlock = mappingMatch[2];
          const listenerClassPattern = /(\w+)::class/g;
          let listenerMatch;
          while ((listenerMatch = listenerClassPattern.exec(listenersBlock)) !== null) {
            const listenerClass = listenerMatch[1];
            const listenerId = this.generateId('listener', '', listenerClass);
            const eventId = this.generateId('event', '', eventClass);
            edges.push(this.createEdge(
              this.generateEdgeId(listenerId, eventId, 'handles'),
              listenerId,
              eventId,
              'handles',
              'behavioral',
              { event: eventClass, listener: listenerClass }
            ));
          }
        }
      }
    }

    return listeners;
  }

  private async analyzeFormRequests(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<string[]> {
    const formRequests: string[] = [];
    const requestFiles = files.filter(f =>
      f.includes('/Requests/') || f.includes('Request.php')
    );

    for (const file of requestFiles) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('class ') && (content.includes('extends FormRequest') || content.includes('FormRequest'))) {
        const classMatch = content.match(/class\s+(\w+)/);
        if (!classMatch) continue;

        const className = classMatch[1];
        if (className === 'FormRequest') continue;

        formRequests.push(className);

        const rules: Record<string, string> = {};
        const rulesBlockPattern = /function\s+rules\s*\(\s*\)[^{]*\{([\s\S]*?)\}/;
        const rulesMatch = content.match(rulesBlockPattern);
        if (rulesMatch) {
          const rulesBody = rulesMatch[1];
          const rulePattern = /['"`]([^'"`]+)['"`]\s*=>\s*['"`]([^'"`]+)['"`]/g;
          let ruleMatch;
          while ((ruleMatch = rulePattern.exec(rulesBody)) !== null) {
            rules[ruleMatch[1]] = ruleMatch[2];
          }

          const ruleArrayPattern = /['"`]([^'"`]+)['"`]\s*=>\s*\[([^\]]+)\]/g;
          while ((ruleMatch = ruleArrayPattern.exec(rulesBody)) !== null) {
            const ruleValues = ruleMatch[2].match(/['"`]([^'"`]+)['"`]/g);
            if (ruleValues) {
              rules[ruleMatch[1]] = ruleValues.map(v => v.slice(1, -1)).join('|');
            }
          }
        }

        const authorizePattern = /function\s+authorize\s*\(\s*\)[^{]*\{([\s\S]*?)\}/;
        const authorizeMatch = content.match(authorizePattern);
        const hasAuthorize = !!authorizeMatch;
        let authorizesAlways = false;
        if (authorizeMatch) {
          authorizesAlways = authorizeMatch[1].includes('return true');
        }

        const requestId = this.generateId('form_request', file, className);
        const requestNode = this.createNodeBuilder(requestId, className, 'laravel_form_request')
          .withLevel(3, 'code')
          .withCategory('validation', ['laravel', 'request', 'form'])
          .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
          .withDescription(`Laravel form request: ${className}`)
          .withMetadata({
            framework: 'laravel',
            attributes: {
              rules,
              rules_count: Object.keys(rules).length,
              has_authorize: hasAuthorize,
              authorizes_always: authorizesAlways
            }
          })
          .build();
        nodes.push(requestNode);
      }
    }

    return formRequests;
  }

  private async analyzeResources(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<string[]> {
    const resources: string[] = [];
    const resourceFiles = files.filter(f =>
      f.includes('/Resources/') || f.includes('Resource.php')
    );

    for (const file of resourceFiles) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('class ') && (
        content.includes('extends JsonResource') ||
        content.includes('extends ResourceCollection') ||
        content.includes('JsonResource') ||
        content.includes('ResourceCollection')
      )) {
        const classMatch = content.match(/class\s+(\w+)/);
        if (!classMatch) continue;

        const className = classMatch[1];
        if (className === 'JsonResource' || className === 'ResourceCollection') continue;

        resources.push(className);

        const isCollection = content.includes('ResourceCollection') || content.includes('AnonymousResourceCollection');

        const resourceId = this.generateId('resource', file, className);
        const resourceNode = this.createNodeBuilder(resourceId, className, 'laravel_resource')
          .withLevel(3, 'code')
          .withCategory('transformer', ['laravel', 'api', 'resource'])
          .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
          .withDescription(`Laravel API resource: ${className}`)
          .withMetadata({
            framework: 'laravel',
            attributes: {
              is_collection: isCollection,
              has_additional: content.includes('additional'),
              has_conditional: content.includes('when(') || content.includes('mergeWhen(')
            }
          })
          .build();
        nodes.push(resourceNode);
      }
    }

    return resources;
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
        middleware: this.extractRouteMiddleware(content, uri, method),
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

  private extractMethods(content: string): Array<{ name: string; visibility: string; parameters: any[]; returnType?: string; line: number }> {
    const methods: Array<{ name: string; visibility: string; parameters: any[]; returnType?: string; line: number }> = [];
    const methodPattern = /(public|private|protected)?\s*function\s+(\w+)\s*\(/g;

    let match;
    while ((match = methodPattern.exec(content)) !== null) {
      const visibility = match[1] || 'public';
      const name = match[2];
      const line = content.substring(0, match.index).split('\n').length;

      methods.push({
        name,
        visibility,
        parameters: [],
        line
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
    const guardedMatch = content.match(/\$guarded\s*=\s*\[([^\]]*)\]/);
    if (!guardedMatch) return [];

    const fields = guardedMatch[1].match(/['"`]([^'"`]+)['"`]/g);
    return fields ? fields.map(field => field.slice(1, -1)) : [];
  }

  private extractHidden(content: string): string[] {
    const hiddenMatch = content.match(/\$hidden\s*=\s*\[([^\]]*)\]/);
    if (!hiddenMatch) return [];

    const fields = hiddenMatch[1].match(/['"`]([^'"`]+)['"`]/g);
    return fields ? fields.map(field => field.slice(1, -1)) : [];
  }

  private extractCasts(content: string): Record<string, string> {
    const castsMatch = content.match(/\$casts\s*=\s*\[([^\]]*)\]/s);
    if (!castsMatch) return {};

    const casts: Record<string, string> = {};
    const pairPattern = /['"`]([^'"`]+)['"`]\s*=>\s*['"`]([^'"`]+)['"`]/g;
    let pairMatch;
    while ((pairMatch = pairPattern.exec(castsMatch[1])) !== null) {
      casts[pairMatch[1]] = pairMatch[2];
    }
    return casts;
  }

  private extractRelations(content: string): Array<{ name: string; type: string; model: string; foreignKey?: string; line: number }> {
    const relations: Array<{ name: string; type: string; model: string; foreignKey?: string; line: number }> = [];
    const relationPattern = /function\s+(\w+)\(\)[^{]*{\s*return\s+\$this->(\w+)\(([^)]+)\)/g;

    let match;
    while ((match = relationPattern.exec(content)) !== null) {
      const name = match[1];
      const type = match[2];
      const model = match[3];
      const line = content.substring(0, match.index).split('\n').length;

      relations.push({
        name,
        type,
        model: model.replace(/['"]/g, '').split(',')[0].trim(),
        line
      });
    }

    return relations;
  }

  private extractScopes(content: string): string[] {
    const scopes: string[] = [];
    const scopePattern = /function\s+(scope[A-Z]\w*)\s*\(/g;
    let match;
    while ((match = scopePattern.exec(content)) !== null) {
      scopes.push(match[1].replace(/^scope/, ''));
    }
    return scopes;
  }

  private extractMutators(content: string): string[] {
    const mutators: string[] = [];

    const oldStylePattern = /function\s+set([A-Z]\w*)Attribute\s*\(/g;
    let match;
    while ((match = oldStylePattern.exec(content)) !== null) {
      mutators.push(match[1]);
    }

    const newStylePattern = /function\s+(\w+)\s*\(\s*\)[^{]*{\s*return\s+Attribute::make\s*\([^)]*set\s*:/gs;
    while ((match = newStylePattern.exec(content)) !== null) {
      mutators.push(match[1]);
    }

    const setOnlyPattern = /function\s+(\w+)\s*\(\s*\)[^{]*{\s*return\s+Attribute::set\s*\(/gs;
    while ((match = setOnlyPattern.exec(content)) !== null) {
      mutators.push(match[1]);
    }

    return mutators;
  }

  private extractAccessors(content: string): string[] {
    const accessors: string[] = [];

    const oldStylePattern = /function\s+get([A-Z]\w*)Attribute\s*\(/g;
    let match;
    while ((match = oldStylePattern.exec(content)) !== null) {
      accessors.push(match[1]);
    }

    const newStylePattern = /function\s+(\w+)\s*\(\s*\)[^{]*{\s*return\s+Attribute::make\s*\([^)]*get\s*:/gs;
    while ((match = newStylePattern.exec(content)) !== null) {
      accessors.push(match[1]);
    }

    const getOnlyPattern = /function\s+(\w+)\s*\(\s*\)[^{]*{\s*return\s+Attribute::get\s*\(/gs;
    while ((match = getOnlyPattern.exec(content)) !== null) {
      accessors.push(match[1]);
    }

    return accessors;
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
    const columns: Array<{ name: string; type: string; modifiers: string[] }> = [];
    const columnPattern = /\$table->(\w+)\(\s*['"`]([^'"`]+)['"`]([^;]*)\)/g;

    const columnTypes = new Set([
      'bigIncrements', 'bigInteger', 'binary', 'boolean', 'char', 'date', 'dateTime',
      'dateTimeTz', 'decimal', 'double', 'enum', 'float', 'foreignId', 'foreignUuid',
      'id', 'increments', 'integer', 'ipAddress', 'json', 'jsonb', 'longText',
      'macAddress', 'mediumIncrements', 'mediumInteger', 'mediumText', 'morphs',
      'nullableMorphs', 'nullableTimestamps', 'rememberToken', 'set', 'smallIncrements',
      'smallInteger', 'softDeletes', 'softDeletesTz', 'string', 'text', 'time',
      'timeTz', 'timestamp', 'timestampTz', 'timestamps', 'timestampsTz',
      'tinyIncrements', 'tinyInteger', 'tinyText', 'unsignedBigInteger',
      'unsignedDecimal', 'unsignedInteger', 'unsignedMediumInteger',
      'unsignedSmallInteger', 'unsignedTinyInteger', 'uuid', 'year'
    ]);

    let match;
    while ((match = columnPattern.exec(content)) !== null) {
      const type = match[1];
      if (!columnTypes.has(type)) continue;

      const name = match[2];
      const modifierChain = match[3];
      const modifiers: string[] = [];

      const modifierPattern = /->(\w+)\(/g;
      let modMatch;
      while ((modMatch = modifierPattern.exec(modifierChain)) !== null) {
        modifiers.push(modMatch[1]);
      }

      columns.push({ name, type, modifiers });
    }

    const noArgPattern = /\$table->(timestamps|softDeletes|softDeletesTz|rememberToken|nullableTimestamps|id)\(\s*\)/g;
    while ((match = noArgPattern.exec(content)) !== null) {
      columns.push({ name: match[1], type: match[1], modifiers: [] });
    }

    return columns;
  }

  private extractMigrationIndexes(content: string): Array<{ type: string; columns: string[] }> {
    const indexes: Array<{ type: string; columns: string[] }> = [];
    const indexPattern = /\$table->(index|unique|primary)\(\s*\[([^\]]*)\]\s*\)/g;

    let match;
    while ((match = indexPattern.exec(content)) !== null) {
      const type = match[1];
      const columnsRaw = match[2];
      const cols = columnsRaw.match(/['"`]([^'"`]+)['"`]/g);
      if (cols) {
        indexes.push({ type, columns: cols.map(c => c.slice(1, -1)) });
      }
    }

    const singleIndexPattern = /\$table->(index|unique|primary)\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
    while ((match = singleIndexPattern.exec(content)) !== null) {
      indexes.push({ type: match[1], columns: [match[2]] });
    }

    return indexes;
  }

  private extractMigrationForeignKeys(content: string): Array<{ column: string; references: string; on: string }> {
    const foreignKeys: Array<{ column: string; references: string; on: string }> = [];
    const fkPattern = /\$table->foreign\(\s*['"`]([^'"`]+)['"`]\s*\)\s*->references\(\s*['"`]([^'"`]+)['"`]\s*\)\s*->on\(\s*['"`]([^'"`]+)['"`]\s*\)/g;

    let match;
    while ((match = fkPattern.exec(content)) !== null) {
      foreignKeys.push({
        column: match[1],
        references: match[2],
        on: match[3]
      });
    }

    const foreignIdPattern = /\$table->foreignId\(\s*['"`]([^'"`]+)['"`]\s*\)\s*->constrained\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
    while ((match = foreignIdPattern.exec(content)) !== null) {
      foreignKeys.push({
        column: match[1],
        references: 'id',
        on: match[2]
      });
    }

    const foreignIdDefaultPattern = /\$table->foreignId\(\s*['"`]([^'"`]+)['"`]\s*\)\s*->constrained\(\s*\)/g;
    while ((match = foreignIdDefaultPattern.exec(content)) !== null) {
      const column = match[1];
      const table = column.replace(/_id$/, '') + 's';
      foreignKeys.push({
        column,
        references: 'id',
        on: table
      });
    }

    return foreignKeys;
  }

  private extractRouteMiddleware(content: string, uri: string, method?: string): string[] {
    const middleware: string[] = [];
    const escapedUri = uri.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Constrain to THIS route's verb: GET /users and POST /users share a URI, so a
    // URI-only match leaked POST's ->middleware('auth') onto the open GET route.
    const verb = method ? method.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '\\w+';
    const routeBlockPattern = new RegExp(
      `Route::${verb}\\(\\s*['"\`]${escapedUri}['"\`][^;]*->middleware\\(([^)]+)\\)`,
      'g'
    );

    let match;
    while ((match = routeBlockPattern.exec(content)) !== null) {
      const middlewareArg = match[1];
      const arrayItems = middlewareArg.match(/['"`]([^'"`]+)['"`]/g);
      if (arrayItems) {
        middleware.push(...arrayItems.map(item => item.slice(1, -1)));
      }
    }

    const groupPattern = /Route::(?:middleware|group)\(\s*\[([^\]]*)\][^{]*\{([^}]*)\}/gs;
    let groupMatch;
    while ((groupMatch = groupPattern.exec(content)) !== null) {
      const groupMiddleware = groupMatch[1];
      const groupBody = groupMatch[2];
      if (groupBody.includes(uri)) {
        const items = groupMiddleware.match(/['"`]([^'"`]+)['"`]/g);
        if (items) {
          middleware.push(...items.map(item => item.slice(1, -1)));
        }
      }
    }

    return [...new Set(middleware)];
  }

  private extractRouteWhere(content: string, uri: string): Record<string, string> {
    const constraints: Record<string, string> = {};
    const escapedUri = uri.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const wherePattern = new RegExp(
      `Route::\\w+\\(\\s*['"\`]${escapedUri}['"\`][^;]*->where\\(\\s*['"\`](\\w+)['"\`]\\s*,\\s*['"\`]([^'"\`]+)['"\`]\\s*\\)`,
      'g'
    );

    let match;
    while ((match = wherePattern.exec(content)) !== null) {
      constraints[match[1]] = match[2];
    }

    const whereArrayPattern = new RegExp(
      `Route::\\w+\\(\\s*['"\`]${escapedUri}['"\`][^;]*->where\\(\\s*\\[([^\\]]+)\\]\\s*\\)`,
      'g'
    );

    while ((match = whereArrayPattern.exec(content)) !== null) {
      const pairPattern = /['"`](\w+)['"`]\s*=>\s*['"`]([^'"`]+)['"`]/g;
      let pairMatch;
      while ((pairMatch = pairPattern.exec(match[1])) !== null) {
        constraints[pairMatch[1]] = pairMatch[2];
      }
    }

    return constraints;
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
    const escapedUri = uri.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const namePattern = new RegExp(
      `Route::\\w+\\(\\s*['"\`]${escapedUri}['"\`][^;]*->name\\(\\s*['"\`]([^'"\`]+)['"\`]\\s*\\)`,
      'g'
    );

    const match = namePattern.exec(content);
    return match ? match[1] : undefined;
  }

  private extractServiceBindings(content: string): Array<{ abstract: string; concrete: string; singleton: boolean }> {
    const bindings: Array<{ abstract: string; concrete: string; singleton: boolean }> = [];

    const bindPattern = /\$this->app->bind\(\s*([^,]+),\s*([^)]+)\)/g;
    let match;
    while ((match = bindPattern.exec(content)) !== null) {
      bindings.push({
        abstract: match[1].replace(/['"`\s]/g, '').replace(/::class/, ''),
        concrete: match[2].replace(/['"`\s]/g, '').replace(/::class/, ''),
        singleton: false
      });
    }

    const singletonPattern = /\$this->app->singleton\(\s*([^,]+),\s*([^)]+)\)/g;
    while ((match = singletonPattern.exec(content)) !== null) {
      bindings.push({
        abstract: match[1].replace(/['"`\s]/g, '').replace(/::class/, ''),
        concrete: match[2].replace(/['"`\s]/g, '').replace(/::class/, ''),
        singleton: true
      });
    }

    return bindings;
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
    const args: Array<{ name: string; required: boolean; description?: string }> = [];
    const signatureMatch = content.match(/\$signature\s*=\s*['"`]([^'"`]+)['"`]/);
    if (!signatureMatch) return args;

    const signature = signatureMatch[1];
    const argPattern = /\{(\w+)(\?)?\s*(?::([^}]*))?\}/g;

    let match;
    while ((match = argPattern.exec(signature)) !== null) {
      if (match[1].startsWith('--')) continue;
      args.push({
        name: match[1],
        required: !match[2],
        description: match[3]?.trim() || undefined
      });
    }

    return args;
  }

  private extractCommandOptions(content: string): Array<{ name: string; shortcut?: string; mode: string; description?: string }> {
    const options: Array<{ name: string; shortcut?: string; mode: string; description?: string }> = [];
    const signatureMatch = content.match(/\$signature\s*=\s*['"`]([^'"`]+)['"`]/);
    if (!signatureMatch) return options;

    const signature = signatureMatch[1];
    const optionPattern = /\{--([A-Za-z|]+)(=\*?|=?)?\s*(?::([^}]*))?\}/g;

    let match;
    while ((match = optionPattern.exec(signature)) !== null) {
      const nameAndShortcut = match[1];
      const valueModifier = match[2] || '';
      const description = match[3]?.trim() || undefined;

      let name = nameAndShortcut;
      let shortcut: string | undefined;

      if (nameAndShortcut.includes('|')) {
        const parts = nameAndShortcut.split('|');
        shortcut = parts[0];
        name = parts[1];
      }

      let mode = 'none';
      if (valueModifier === '=*') {
        mode = 'array';
      } else if (valueModifier === '=') {
        mode = 'required';
      }

      options.push({ name, shortcut, mode, description });
    }

    return options;
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

  // CAS v1.4.0 Documentation and Comment extraction methods
  private extractDocumentation(content: string, filePath: string): CASDocumentation | undefined {
    if (!content || content.trim().length === 0) return undefined;

    const lines = content.split('\n');

    // Look for Laravel-specific documentation patterns

    // 1. Eloquent model PHPDoc
    const modelDocMatches = content.matchAll(/\/\*\*\s*\n[^*]*\*\s*([^@\n][^\n]*)\n[^*]*\*\//g);
    const modelDocs = [];
    for (const match of modelDocMatches) {
      modelDocs.push(match[1].trim());
    }

    // 2. Controller method documentation
    const controllerDocMatches = content.matchAll(/\/\*\*\s*\n[^*]*\*\s*([^@\n][^\n]*)\n[^*]*\*\/\s*public\s+function/g);
    const controllerDocs = [];
    for (const match of controllerDocMatches) {
      controllerDocs.push(match[1].trim());
    }

    // 3. Blade template comments
    const bladeCommentMatches = content.matchAll(/{{--\s*([^-]*?)\s*--}}/g);
    const bladeDocs = [];
    for (const match of bladeCommentMatches) {
      bladeDocs.push(match[1].trim());
    }

    // 4. Migration and seeder docs
    const migrationDocMatches = content.matchAll(/\/\*\*\s*\n[^*]*\*\s*([^@\n][^\n]*)\n[^*]*\*\/\s*(?:public\s+)?function\s+(?:up|down|run)/g);
    const migrationDocs = [];
    for (const match of migrationDocMatches) {
      migrationDocs.push(match[1].trim());
    }

    if (modelDocs.length > 0 || controllerDocs.length > 0 || bladeDocs.length > 0 || migrationDocs.length > 0) {
      const doc: CASDocumentation = {
        type: 'laravel_documentation',
        raw: content,
        location: { start_line: 1, end_line: lines.length }
      };

      if (modelDocs.length > 0) {
        doc.summary = modelDocs[0].split('\n')[0].trim();
        doc.description = modelDocs[0].trim();
      } else if (controllerDocs.length > 0) {
        doc.summary = controllerDocs[0].split('\n')[0].trim();
      }

      doc.framework_docs = {
        laravel: {}
      };

      return doc;
    }

    return undefined;
  }

  private extractComments(content: string, filePath: string): CASComment[] {
    if (!content || content.trim().length === 0) return [];

    const comments: CASComment[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();

      // PHP single-line comments
      if (trimmedLine.startsWith('//') || trimmedLine.startsWith('#')) {
        const commentText = trimmedLine.substring(trimmedLine.startsWith('//') ? 2 : 1).trim();
        if (commentText.length > 0) {
          const comment: CASComment = {
            id: `comment_${++this.commentCounter}`,
            type: 'single-line',
            style: trimmedLine.startsWith('//') ? '//' : '#',
            text: commentText,
            purpose: this.classifyCommentPurpose(commentText),
            location: {
              file: filePath,
              line: i + 1
            },
            markers: {
              is_todo: commentText.toUpperCase().includes('TODO'),
              is_fixme: commentText.toUpperCase().includes('FIXME'),
              is_hack: commentText.toUpperCase().includes('HACK'),
              is_warning: commentText.toUpperCase().includes('WARNING'),
              is_note: commentText.toUpperCase().includes('NOTE')
            }
          };
          comments.push(comment);
        }
      }

      // Multi-line comments /* */
      if (trimmedLine.includes('/*') && !trimmedLine.includes('/**')) {
        let commentText = '';
        let j = i;
        let foundEnd = false;

        while (j < lines.length && !foundEnd) {
          const currentLine = lines[j].trim();
          if (currentLine.includes('*/')) {
            commentText += currentLine.replace('*/', '').replace('/*', '').trim();
            foundEnd = true;
          } else {
            commentText += currentLine.replace('/*', '').replace(/^\s*\*\s?/, '').trim() + ' ';
          }
          j++;
        }

        if (commentText.trim().length > 0) {
          const comment: CASComment = {
            id: `comment_${++this.commentCounter}`,
            type: 'multi-line',
            style: '/* */',
            text: commentText.trim(),
            purpose: this.classifyCommentPurpose(commentText.trim()),
            location: {
              file: filePath,
              line: i + 1
            },
            markers: {
              is_todo: commentText.toUpperCase().includes('TODO'),
              is_fixme: commentText.toUpperCase().includes('FIXME'),
              is_hack: commentText.toUpperCase().includes('HACK'),
              is_warning: commentText.toUpperCase().includes('WARNING'),
              is_note: commentText.toUpperCase().includes('NOTE')
            }
          };
          comments.push(comment);
        }

        i = j - 1; // Skip processed lines
      }

      // Blade template comments {{-- --}}
      const bladeCommentMatch = line.match(/{{--\s*([^-]*?)\s*--}}/);
      if (bladeCommentMatch) {
        const commentText = bladeCommentMatch[1].trim();
        if (commentText.length > 0) {
          const comment: CASComment = {
            id: `comment_${++this.commentCounter}`,
            type: 'blade-comment',
            style: '{{-- --}}',
            text: commentText,
            purpose: this.classifyCommentPurpose(commentText),
            location: {
              file: filePath,
              line: i + 1
            },
            markers: {
              is_todo: commentText.toUpperCase().includes('TODO'),
              is_fixme: commentText.toUpperCase().includes('FIXME'),
              is_hack: commentText.toUpperCase().includes('HACK'),
              is_warning: commentText.toUpperCase().includes('WARNING'),
              is_note: commentText.toUpperCase().includes('NOTE')
            }
          };
          comments.push(comment);
        }
      }
    }

    return comments;
  }

  private extractTodos(comments: CASComment[]): CASTodo[] {
    const todos: CASTodo[] = [];

    for (const comment of comments) {
      if (comment.markers?.is_todo || comment.markers?.is_fixme || comment.markers?.is_hack) {
        const text = comment.text;
        const typeMatch = text.match(/(TODO|FIXME|HACK|NOTE|WARNING|XXX)/i);
        const type = typeMatch ? typeMatch[0].toUpperCase() as CASTodo['type'] : 'TODO';

        // Extract assignee from patterns like "TODO(username):"
        const assigneeMatch = text.match(/TODO\s*\(\s*([^)]+)\s*\)/i);
        const assignee = assigneeMatch ? assigneeMatch[1].trim() : undefined;

        // Extract priority from patterns like "TODO [HIGH]:" or "TODO: [CRITICAL]"
        const priorityMatch = text.match(/\[(CRITICAL|HIGH|MEDIUM|LOW)\]/i);
        let priority: CASTodo['priority'] = 'medium';
        if (priorityMatch) {
          priority = priorityMatch[1].toLowerCase() as CASTodo['priority'];
        }

        const todo: CASTodo = {
          id: `todo_${++this.todoCounter}`,
          type,
          text: text.replace(/^(TODO|FIXME|HACK|NOTE|WARNING|XXX)\s*(\([^)]+\))?\s*:?\s*/i, '').trim(),
          priority,
          location: {
            file: comment.location.file,
            line: comment.location.line
          },
          assignee,
          classification: {
            category: this.classifyTodoCategory(text),
            technical_debt: type === 'TODO' || type === 'FIXME' || type === 'HACK'
          }
        };

        todos.push(todo);
      }
    }

    return todos;
  }

  private determineImplementationStatus(content: string, comments: CASComment[]): CASImplementationStatus {
    const indicators = {
      has_todo_markers: comments.some(c => c.markers?.is_todo),
      has_not_implemented_exceptions: content.includes('throw new NotImplementedException') || content.includes('// TODO: implement'),
      has_stub_returns: content.includes('return null;') || content.includes('return [];') || content.includes('return \'\';'),
      has_placeholder_code: content.includes('// TODO') || content.includes('// FIXME') || content.includes('// PLACEHOLDER'),
      has_hardcoded_values: /['\"](localhost|127\.0\.0\.1|test|example|demo|placeholder)['\"]/.test(content),
      has_commented_out_code: comments.some(c => c.text.includes('function ') || c.text.includes('public ') || c.text.includes('class '))
    };

    const indicatorCount = Object.values(indicators).filter(Boolean).length;
    let status: CASImplementationStatus['status'];
    let confidence = 0.8;

    if (content.includes('throw new NotImplementedException')) {
      status = 'not-implemented';
      confidence = 0.95;
    } else if (indicatorCount >= 3) {
      status = 'stub';
      confidence = 0.7;
    } else if (indicatorCount >= 1) {
      status = 'partial';
      confidence = 0.6;
    } else if (content.includes('@deprecated') || content.includes('// deprecated')) {
      status = 'deprecated';
      confidence = 0.9;
    } else if (content.includes('experimental') || content.includes('beta')) {
      status = 'experimental';
      confidence = 0.8;
    } else {
      status = 'complete';
      confidence = 0.7;
    }

    const missingFeatures = [];
    if (indicators.has_not_implemented_exceptions) missingFeatures.push('Core implementation');
    if (indicators.has_todo_markers) missingFeatures.push('TODO items');
    if (indicators.has_stub_returns) missingFeatures.push('Method implementations');

    return {
      status,
      indicators,
      confidence,
      completeness: {
        estimated_percentage: status === 'complete' ? 90 : status === 'partial' ? 60 : status === 'stub' ? 30 : 10,
        missing_features: missingFeatures,
        implemented_features: status === 'complete' ? ['Core functionality'] : []
      }
    };
  }

  private classifyCommentPurpose(text: string): CASComment['purpose'] {
    const upperText = text.toUpperCase();
    if (upperText.includes('TODO') || upperText.includes('FIXME')) return 'todo';
    if (upperText.includes('WARNING') || upperText.includes('WARN')) return 'warning';
    if (upperText.includes('HACK') || upperText.includes('WORKAROUND')) return 'hack';
    if (upperText.includes('NOTE') || upperText.includes('INFO')) return 'note';
    if (upperText.includes('DISABLED') || upperText.includes('COMMENTED')) return 'disabled-code';
    return 'explanation';
  }

  private classifyTodoCategory(text: string): 'bug' | 'feature' | 'refactor' | 'performance' | 'security' | 'documentation' | 'test' | undefined {
    const lowerText = text.toLowerCase();
    if (lowerText.includes('bug') || lowerText.includes('fix') || lowerText.includes('error')) return 'bug';
    if (lowerText.includes('security') || lowerText.includes('auth') || lowerText.includes('permission')) return 'security';
    if (lowerText.includes('performance') || lowerText.includes('optimize') || lowerText.includes('slow')) return 'performance';
    if (lowerText.includes('test') || lowerText.includes('spec') || lowerText.includes('coverage')) return 'test';
    if (lowerText.includes('refactor') || lowerText.includes('cleanup') || lowerText.includes('reorganize')) return 'refactor';
    if (lowerText.includes('doc') || lowerText.includes('comment') || lowerText.includes('explain')) return 'documentation';
    return 'feature';
  }
}
