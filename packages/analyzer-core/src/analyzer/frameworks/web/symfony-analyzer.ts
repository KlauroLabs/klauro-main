import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint,
  CASDocumentation, CASComment, CASTodo, CASImplementationStatus
} from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as yaml from 'js-yaml';
import { glob } from 'glob';

interface SymfonyRoute {
  path: string;
  methods: string[];
  name?: string;
  line: number;
  classLevel?: boolean;
}

interface SymfonySecurityGuard {
  attribute: string;
  roles: string[];
  line: number;
  classLevel?: boolean;
}

interface SymfonyResourcePrefix {
  dir: string;
  prefix: string;
}

interface SymfonyAccessControlRule {
  pattern: RegExp;
  roles: string[];
}

interface SymfonyRoutingConfig {
  resourcePrefixes: SymfonyResourcePrefix[];
  accessControl: SymfonyAccessControlRule[];
}

interface SymfonyController {
  name: string;
  filePath: string;
  namespace: string;
  methods: Array<{ name: string; visibility: string; parameters: any[]; returnType?: string; line: number; usedDependencies?: string[] }>;
  routes: SymfonyRoute[];
  dependencies: string[];
  isAbstract: boolean;
}

interface SymfonyEntity {
  name: string;
  filePath: string;
  table?: string;
  repositoryClass?: string;
  fields: Array<{ name: string; type: string; nullable: boolean; unique: boolean; line: number }>;
  relations: Array<{ name: string; type: string; targetEntity: string; inversedBy?: string; mappedBy?: string; line: number }>;
  lifecycle: string[];
}

interface SymfonyRepository {
  name: string;
  filePath: string;
  entityClass?: string;
  methods: Array<{ name: string; visibility: string; parameters: any[]; returnType?: string; line: number }>;
  dependencies: string[];
}

interface SymfonyService {
  name: string;
  filePath: string;
  namespace: string;
  dependencies: string[];
  methods: Array<{ name: string; visibility: string; parameters: any[]; returnType?: string; line: number }>;
  tags: string[];
  isAutowired: boolean;
}

interface SymfonyCommand {
  name: string;
  filePath: string;
  commandName: string;
  description: string;
  arguments: Array<{ name: string; mode: string; description?: string }>;
  options: Array<{ name: string; shortcut?: string; mode: string; description?: string }>;
}

interface SymfonyEventSubscriber {
  name: string;
  filePath: string;
  subscribedEvents: Array<{ event: string; method: string; priority?: number }>;
  dependencies: string[];
}

interface SymfonyForm {
  name: string;
  filePath: string;
  dataClass?: string;
  fields: Array<{ name: string; type: string; options: Record<string, any> }>;
  parent?: string;
}

interface SymfonyTemplate {
  name: string;
  filePath: string;
  extends?: string;
  includes: string[];
  blocks: string[];
  variables: string[];
}

interface SymfonyMigration {
  name: string;
  filePath: string;
  version: string;
  sqlStatements: string[];
}

interface SymfonyMessageHandler {
  name: string;
  filePath: string;
  handlesMessage: string;
  dependencies: string[];
}

interface SymfonyVoter {
  name: string;
  filePath: string;
  attributes: string[];
  subjectClass?: string;
}

function timeSync<T>(label: string, timings: Record<string, number>, fn: () => T): T {
  const startedAt = Date.now();
  try {
    return fn();
  } finally {
    timings[label] = Date.now() - startedAt;
  }
}

export class SymfonyAnalyzer extends BaseAnalyzer {
  private fileContentCache = new Map<string, string>();
  private lineIndexCache = new Map<string, number[]>();
  private todoCounter = 0;
  private commentCounter = 0;

  constructor() {
    super(
      'symfony',
      'Symfony Framework Analyzer',
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

        if (deps['symfony/framework-bundle'] || deps['symfony/symfony']) {
          return true;
        }
      }

      const binConsole = await fs.pathExists(path.join(projectPath, 'bin/console'));
      if (binConsole) return true;

      const configDir = await fs.pathExists(path.join(projectPath, 'config/bundles.php'));
      if (configDir) return true;

      return false;
    } catch {
      return false;
    }
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const timings: Record<string, number> = {};
    const time = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
      const startedAt = Date.now();
      try {
        return await fn();
      } finally {
        timings[label] = Date.now() - startedAt;
      }
    };
    this.fileContentCache.clear();
    this.lineIndexCache.clear();
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    try {
      const phpFiles = await time('glob_php', () => glob(['**/*.php'], {
        cwd: context.projectPath,
        ignore: [...this.getIgnorePatterns(context), '**/var/**', '**/tests/**', '**/test/**'],
        nodir: true
      }));

      const twigFiles = await time('glob_twig', () => glob(['**/*.twig'], {
        cwd: context.projectPath,
        ignore: [...this.getIgnorePatterns(context), '**/var/**'],
        nodir: true
      }));

      const routingConfig = await time('routing_config', () => this.loadRoutingConfig(context.projectPath));
      const controllers = await time('controllers', () => this.analyzeControllers(phpFiles, context.projectPath, nodes, edges, entryPoints, routingConfig));
      const entities = await time('entities', () => this.analyzeEntities(phpFiles, context.projectPath, nodes, edges));
      const repositories = await time('repositories', () => this.analyzeRepositories(phpFiles, context.projectPath, nodes, edges));
      const services = await time('services', () => this.analyzeServices(phpFiles, context.projectPath, nodes, edges));
      const commands = await time('commands', () => this.analyzeCommands(phpFiles, context.projectPath, nodes, edges, entryPoints));
      const subscribers = await time('event_subscribers', () => this.analyzeEventSubscribers(phpFiles, context.projectPath, nodes, edges, entryPoints));
      const forms = await time('forms', () => this.analyzeForms(phpFiles, context.projectPath, nodes, edges));
      const templates = await time('templates', () => this.analyzeTemplates(twigFiles, context.projectPath, nodes, edges));
      const migrations = await time('migrations', () => this.analyzeMigrations(phpFiles, context.projectPath, nodes, edges));
      const messageHandlers = await time('message_handlers', () => this.analyzeMessageHandlers(phpFiles, context.projectPath, nodes, edges, entryPoints));
      const voters = await time('voters', () => this.analyzeVoters(phpFiles, context.projectPath, nodes, edges));
      await time('config_routes', () => this.analyzeConfigRoutes(context.projectPath, nodes, edges, entryPoints, routingConfig));

      timeSync('relationships', timings, () => this.buildRelationships(controllers, entities, repositories, services, forms, subscribers, migrations, templates, nodes, edges));
      await time('exit_points', () => this.identifyExitPoints(entities, repositories, services, messageHandlers, phpFiles, context.projectPath, exitPoints));
      if (process.env.KLAURO_DEBUG_ANALYSIS_TIMINGS === '1') {
        console.error('[Klauro] Symfony breakdown:', JSON.stringify(timings, null, 2));
      }

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework_specific: {
          analysis_timings: timings,
          symfony_version: await this.detectSymfonyVersion(context.projectPath),
          controllers_detected: controllers.length,
          entities_detected: entities.length,
          repositories_detected: repositories.length,
          services_detected: services.length,
          commands_detected: commands.length,
          event_subscribers_detected: subscribers.length,
          forms_detected: forms.length,
          templates_detected: templates.length,
          migrations_detected: migrations.length,
          message_handlers_detected: messageHandlers.length,
          voters_detected: voters.length
        }
      });

    } catch (error) {
      throw new AnalyzerError(
        `Symfony analysis failed: ${(error as Error).message}`,
        'SYMFONY_ANALYSIS_ERROR'
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
      'controller-route-analysis',
      'doctrine-entity-mapping',
      'repository-detection',
      'service-container-analysis',
      'console-command-detection',
      'event-subscriber-analysis',
      'form-type-analysis',
      'twig-template-analysis',
      'doctrine-migration-parsing',
      'messenger-handler-detection',
      'security-voter-analysis',
      'dependency-injection-mapping'
    ];
  }

  private async readProjectFile(projectPath: string, file: string): Promise<string> {
    const fullPath = path.join(projectPath, file);
    const cached = this.fileContentCache.get(fullPath);
    if (cached !== undefined) return cached;
    const content = await fs.readFile(fullPath, 'utf-8');
    this.fileContentCache.set(fullPath, content);
    return content;
  }

  private async analyzeControllers(
    phpFiles: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    routingConfig?: SymfonyRoutingConfig
  ): Promise<SymfonyController[]> {
    const controllers: SymfonyController[] = [];
    const controllerFiles = phpFiles.filter(f =>
      f.includes('Controller') && f.endsWith('.php') &&
      !f.includes('Abstract') && !f.includes('Interface')
    );

    for (const file of controllerFiles) {
      try {
        const content = await this.readProjectFile(projectPath, file);

        if (!this.isSymfonyController(content)) continue;

        const nameMatch = content.match(/class\s+(\w+)\s+(?:extends\s+\w+)?/);
        if (!nameMatch) continue;

        const name = nameMatch[1];
        const namespace = this.extractNamespace(content);
        const isAbstract = /abstract\s+class/.test(content);
        const dependencies = this.extractDependencies(content);
        const methods = this.extractMethods(content, file);
        this.attachMethodDependencyUsage(content, methods);
        const routes = this.extractControllerRoutes(content, file);
        const guards = this.extractSecurityGuards(content);
        const resourcePrefix = this.findResourcePrefix(file, routingConfig?.resourcePrefixes ?? []);
        const comments = this.extractComments(content, file);
        const todos = this.extractTodos(comments);
        const documentation = this.extractDocumentation(content);

        const controller: SymfonyController = {
          name,
          filePath: file,
          namespace,
          methods,
          routes,
          dependencies,
          isAbstract
        };

        if (!isAbstract) {
          const controllerId = this.generateId('controller', file, name);

          nodes.push(
            this.createNodeBuilder(controllerId, name, 'controller')
              .withLevel(2, 'architectural')
              .withCategory('symfony-controller')
              .withSource({ file, line: this.findClassLine(content), end_line: this.lineCount(content) })
              .withMetadata({
                framework: 'symfony',
                attributes: {
                  namespace,
                  route_count: routes.length,
                  method_count: methods.length,
                  dependencies: dependencies.map(d => d.split('\\').pop())
                }
              })
              .withDocumentation(documentation)
              .withComments(comments)
              .withTodos(todos)
              .withImplementationStatus(this.determineImplementationStatus(content, comments))
              .build()
          );

          const classRoute = routes.find(r => r.classLevel);
          const classGuards = guards.filter(g => g.classLevel);
          const orderedMethodLines = methods.map(m => m.line).sort((a, b) => a - b);

          for (const method of methods) {
            const methodId = this.generateId('method', file, `${name}.${method.name}`);
            const previousMethodLine = orderedMethodLines
              .filter(l => l < method.line)
              .pop() ?? 0;
            const methodRoutes = routes.filter(r =>
              !r.classLevel && r.line <= method.line && r.line > previousMethodLine
            );
            const matchingRoute = methodRoutes[0];

            nodes.push(
              this.createNodeBuilder(methodId, method.name, 'method')
                .withLevel(4, 'member')
                .withCategory('controller-action')
                .withSource({ file, line: method.line })
                .withMetadata({
                  framework: 'symfony',
                  access_modifier: method.visibility as any,
                  attributes: {
                    parameters: method.parameters,
                    return_type: method.returnType,
                    route: matchingRoute
                      ? {
                          path: this.joinRoutePaths(resourcePrefix, classRoute?.path, matchingRoute.path),
                          methods: matchingRoute.methods
                        }
                      : undefined
                  }
                })
                .withParent(controllerId)
                .withSignature({
                  parameters: method.parameters.map((p: any) => ({
                    name: p.name,
                    type: p.type
                  })),
                  return_type: method.returnType
                })
                .build()
            );

            edges.push(this.createEdge(
              this.generateEdgeId(controllerId, methodId, 'contains'),
              controllerId,
              methodId,
              'contains',
              'structural'
            ));

            const methodGuards = guards.filter(g =>
              !g.classLevel && g.line <= method.line && g.line > previousMethodLine
            );

            for (const route of methodRoutes) {
              const fullPath = this.joinRoutePaths(resourcePrefix, classRoute?.path, route.path);
              const httpMethods = route.methods.length > 0 ? route.methods : ['GET'];
              const security = this.resolveRouteSecurity(
                fullPath,
                [...classGuards, ...methodGuards],
                routingConfig?.accessControl ?? []
              );
              for (const httpMethod of httpMethods) {
                entryPoints.push(this.createEntryPoint(
                  `entry_${httpMethod.toLowerCase()}_${this.sanitizeId(fullPath)}_${this.sanitizeId(method.name)}`,
                  methodId,
                  'http',
                  `${httpMethod} ${fullPath}`,
                  `HTTP ${httpMethod} endpoint handled by ${name}::${method.name}`,
                  {
                    method: httpMethod,
                    path: fullPath
                  },
                  security,
                  {
                    controller: name,
                    action: method.name,
                    route_name: route.name
                  },
                  {
                    node_id: methodId,
                    method_name: method.name,
                    file,
                    line: method.line
                  }
                ));
              }
            }
          }

          controllers.push(controller);
        }
      } catch {
        continue;
      }
    }

    return controllers;
  }

  private async analyzeEntities(
    phpFiles: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<SymfonyEntity[]> {
    const entities: SymfonyEntity[] = [];
    const entityFiles = phpFiles.filter(f =>
      f.includes('Entity') && f.endsWith('.php') && !f.includes('Repository')
    );

    for (const file of entityFiles) {
      try {
        const content = await this.readProjectFile(projectPath, file);

        if (!this.isDoctrineEntity(content)) continue;

        const nameMatch = content.match(/class\s+(\w+)/);
        if (!nameMatch) continue;

        const name = nameMatch[1];
        const table = this.extractEntityTable(content);
        const repositoryClass = this.extractRepositoryClass(content);
        const fields = this.extractEntityFields(content, file);
        const relations = this.extractEntityRelations(content, file);
        const lifecycle = this.extractLifecycleCallbacks(content);
        const comments = this.extractComments(content, file);
        const todos = this.extractTodos(comments);
        const documentation = this.extractDocumentation(content);

        const entity: SymfonyEntity = {
          name,
          filePath: file,
          table,
          repositoryClass,
          fields,
          relations,
          lifecycle
        };

        const entityId = this.generateId('entity', file, name);

        nodes.push(
          this.createNodeBuilder(entityId, name, 'entity')
            .withLevel(3, 'code')
            .withCategory('doctrine-entity')
            .withSource({ file, line: this.findClassLine(content), end_line: this.lineCount(content) })
            .withMetadata({
              framework: 'symfony',
              attributes: {
                table: table || name.toLowerCase(),
                field_count: fields.length,
                relation_count: relations.length,
                lifecycle_callbacks: lifecycle,
                repository_class: repositoryClass
              }
            })
            .withDocumentation(documentation)
            .withComments(comments)
            .withTodos(todos)
            .build()
        );

        for (const field of fields) {
          const fieldId = this.generateId('property', file, `${name}.${field.name}`);

          nodes.push(
            this.createNodeBuilder(fieldId, field.name, 'property')
              .withLevel(4, 'member')
              .withCategory('entity-field')
              .withSource({ file, line: field.line })
              .withMetadata({
                framework: 'symfony',
                attributes: {
                  column_type: field.type,
                  nullable: field.nullable,
                  unique: field.unique
                }
              })
              .withParent(entityId)
              .build()
          );

          edges.push(this.createEdge(
            this.generateEdgeId(entityId, fieldId, 'contains'),
            entityId,
            fieldId,
            'contains',
            'structural'
          ));
        }

        for (const relation of relations) {
          const relationId = this.generateId('property', file, `${name}.${relation.name}`);

          nodes.push(
            this.createNodeBuilder(relationId, relation.name, 'property')
              .withLevel(4, 'member')
              .withCategory('entity-relation')
              .withSource({ file, line: relation.line })
              .withMetadata({
                framework: 'symfony',
                attributes: {
                  relation_type: relation.type,
                  target_entity: relation.targetEntity,
                  inversed_by: relation.inversedBy,
                  mapped_by: relation.mappedBy
                }
              })
              .withParent(entityId)
              .build()
          );

          edges.push(this.createEdge(
            this.generateEdgeId(entityId, relationId, 'contains'),
            entityId,
            relationId,
            'contains',
            'structural'
          ));
        }

        entities.push(entity);
      } catch {
        continue;
      }
    }

    return entities;
  }

  private async analyzeRepositories(
    phpFiles: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<SymfonyRepository[]> {
    const repositories: SymfonyRepository[] = [];
    const repoFiles = phpFiles.filter(f => f.includes('Repository') && f.endsWith('.php'));

    for (const file of repoFiles) {
      try {
        const content = await this.readProjectFile(projectPath, file);

        if (!this.isDoctrineRepository(content)) continue;

        const nameMatch = content.match(/class\s+(\w+)/);
        if (!nameMatch) continue;

        const name = nameMatch[1];
        const entityClass = this.extractRepositoryEntityClass(content);
        const methods = this.extractMethods(content, file);
        const dependencies = this.extractDependencies(content);
        const comments = this.extractComments(content, file);
        const todos = this.extractTodos(comments);
        const documentation = this.extractDocumentation(content);

        const repository: SymfonyRepository = {
          name,
          filePath: file,
          entityClass,
          methods,
          dependencies
        };

        const repoId = this.generateId('repository', file, name);

        nodes.push(
          this.createNodeBuilder(repoId, name, 'repository')
            .withLevel(3, 'code')
            .withCategory('doctrine-repository')
            .withSource({ file, line: this.findClassLine(content), end_line: this.lineCount(content) })
            .withMetadata({
              framework: 'symfony',
              attributes: {
                entity_class: entityClass,
                method_count: methods.length,
                custom_queries: methods.filter(m => m.name.startsWith('find') || m.name.startsWith('query')).length
              }
            })
            .withDocumentation(documentation)
            .withComments(comments)
            .withTodos(todos)
            .withImplementationStatus(this.determineImplementationStatus(content, comments))
            .build()
        );

        for (const method of methods) {
          const methodId = this.generateId('method', file, `${name}.${method.name}`);

          nodes.push(
            this.createNodeBuilder(methodId, method.name, 'method')
              .withLevel(4, 'member')
              .withCategory('repository-method')
              .withSource({ file, line: method.line })
              .withMetadata({
                framework: 'symfony',
                access_modifier: method.visibility as any,
                attributes: {
                  parameters: method.parameters,
                  return_type: method.returnType
                }
              })
              .withParent(repoId)
              .withSignature({
                parameters: method.parameters.map((p: any) => ({
                  name: p.name,
                  type: p.type
                })),
                return_type: method.returnType
              })
              .build()
          );

          edges.push(this.createEdge(
            this.generateEdgeId(repoId, methodId, 'contains'),
            repoId,
            methodId,
            'contains',
            'structural'
          ));
        }

        repositories.push(repository);
      } catch {
        continue;
      }
    }

    return repositories;
  }

  private async analyzeServices(
    phpFiles: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<SymfonyService[]> {
    const services: SymfonyService[] = [];
    const serviceFiles = phpFiles.filter(f => {
      const basename = path.basename(f, '.php');
      return (
        (basename.includes('Service') || basename.includes('Handler') || basename.includes('Manager') || basename.includes('Provider')) &&
        !basename.includes('Controller') && !basename.includes('Repository') && !basename.includes('Entity') &&
        !basename.includes('Command') && !basename.includes('Subscriber') && !basename.includes('Listener') &&
        !basename.includes('Request') && !basename.includes('Response') && !basename.includes('Exception') &&
        !basename.includes('Event') && !basename.includes('Model') && !basename.includes('Dto') && !basename.includes('DTO')
      );
    });

    for (const file of serviceFiles) {
      try {
        const content = await this.readProjectFile(projectPath, file);

        const nameMatch = content.match(/class\s+(\w+)/);
        if (!nameMatch) continue;
        if (/abstract\s+class/.test(content)) continue;
        if (/interface\s+\w+/.test(content) && !content.includes('class ')) continue;

        const name = nameMatch[1];
        const namespace = this.extractNamespace(content);
        const dependencies = this.extractDependencies(content);
        const methods = this.extractMethods(content, file);
        const tags = this.extractServiceTags(content);
        const isAutowired = content.includes('#[Autoconfigure') || content.includes('#[AsService');
        const comments = this.extractComments(content, file);
        const todos = this.extractTodos(comments);
        const documentation = this.extractDocumentation(content);

        const service: SymfonyService = {
          name,
          filePath: file,
          namespace,
          dependencies,
          methods,
          tags,
          isAutowired
        };

        const serviceId = this.generateId('service', file, name);

        nodes.push(
          this.createNodeBuilder(serviceId, name, 'service')
            .withLevel(3, 'code')
            .withCategory('symfony-service')
            .withSource({ file, line: this.findClassLine(content), end_line: this.lineCount(content) })
            .withMetadata({
              framework: 'symfony',
              attributes: {
                namespace,
                dependency_count: dependencies.length,
                method_count: methods.length,
                tags,
                autowired: isAutowired
              }
            })
            .withDocumentation(documentation)
            .withComments(comments)
            .withTodos(todos)
            .withImplementationStatus(this.determineImplementationStatus(content, comments))
            .build()
        );

        for (const method of methods.filter(m => m.visibility === 'public')) {
          const methodId = this.generateId('method', file, `${name}.${method.name}`);

          nodes.push(
            this.createNodeBuilder(methodId, method.name, 'method')
              .withLevel(4, 'member')
              .withCategory('service-method')
              .withSource({ file, line: method.line })
              .withMetadata({
                framework: 'symfony',
                access_modifier: method.visibility as any,
                attributes: {
                  parameters: method.parameters,
                  return_type: method.returnType
                }
              })
              .withParent(serviceId)
              .withSignature({
                parameters: method.parameters.map((p: any) => ({
                  name: p.name,
                  type: p.type
                })),
                return_type: method.returnType
              })
              .build()
          );

          edges.push(this.createEdge(
            this.generateEdgeId(serviceId, methodId, 'contains'),
            serviceId,
            methodId,
            'contains',
            'structural'
          ));
        }

        services.push(service);
      } catch {
        continue;
      }
    }

    return services;
  }

  private async analyzeCommands(
    phpFiles: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): Promise<SymfonyCommand[]> {
    const commands: SymfonyCommand[] = [];
    const commandFiles = phpFiles.filter(f => f.includes('Command') && f.endsWith('.php'));

    for (const file of commandFiles) {
      try {
        const content = await this.readProjectFile(projectPath, file);

        if (!this.isSymfonyCommand(content)) continue;

        const nameMatch = content.match(/class\s+(\w+)/);
        if (!nameMatch) continue;

        const name = nameMatch[1];
        const commandName = this.extractCommandName(content);
        const description = this.extractCommandDescription(content);
        const args = this.extractCommandArguments(content);
        const options = this.extractCommandOptions(content);
        const comments = this.extractComments(content, file);
        const todos = this.extractTodos(comments);
        const documentation = this.extractDocumentation(content);

        const command: SymfonyCommand = {
          name,
          filePath: file,
          commandName: commandName || name,
          description: description || '',
          arguments: args,
          options
        };

        const commandId = this.generateId('command', file, name);

        nodes.push(
          this.createNodeBuilder(commandId, name, 'command')
            .withLevel(3, 'code')
            .withCategory('symfony-command')
            .withSource({ file, line: this.findClassLine(content), end_line: this.lineCount(content) })
            .withMetadata({
              framework: 'symfony',
              attributes: {
                command_name: commandName,
                description,
                argument_count: args.length,
                option_count: options.length
              }
            })
            .withDocumentation(documentation)
            .withComments(comments)
            .withTodos(todos)
            .withImplementationStatus(this.determineImplementationStatus(content, comments))
            .build()
        );

        entryPoints.push(this.createEntryPoint(
          `entry_cli_${this.sanitizeId(commandName || name)}`,
          commandId,
          'cli',
          `bin/console ${commandName || name}`,
          description || `Console command: ${commandName || name}`,
          {
            pattern: commandName || name
          },
          undefined,
          {
            command_name: commandName || name,
            arguments: args.map(a => a.name),
            options: options.map(o => o.name)
          }
        ));

        commands.push(command);
      } catch {
        continue;
      }
    }

    return commands;
  }

  private async analyzeEventSubscribers(
    phpFiles: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): Promise<SymfonyEventSubscriber[]> {
    const subscribers: SymfonyEventSubscriber[] = [];
    const subscriberFiles = phpFiles.filter(f =>
      (f.includes('Subscriber') || f.includes('Listener') || f.includes('EventHandler')) && f.endsWith('.php')
    );

    for (const file of subscriberFiles) {
      try {
        const content = await this.readProjectFile(projectPath, file);

        const isSubscriber = content.includes('EventSubscriberInterface') || content.includes('#[AsEventListener');
        if (!isSubscriber) continue;

        const nameMatch = content.match(/class\s+(\w+)/);
        if (!nameMatch) continue;

        const name = nameMatch[1];
        const subscribedEvents = this.extractSubscribedEvents(content);
        const dependencies = this.extractDependencies(content);
        const comments = this.extractComments(content, file);
        const todos = this.extractTodos(comments);
        const documentation = this.extractDocumentation(content);

        const subscriber: SymfonyEventSubscriber = {
          name,
          filePath: file,
          subscribedEvents,
          dependencies
        };

        const subscriberId = this.generateId('event_subscriber', file, name);

        nodes.push(
          this.createNodeBuilder(subscriberId, name, 'event_subscriber')
            .withLevel(3, 'code')
            .withCategory('symfony-event-subscriber')
            .withSource({ file, line: this.findClassLine(content), end_line: this.lineCount(content) })
            .withMetadata({
              framework: 'symfony',
              attributes: {
                subscribed_event_count: subscribedEvents.length,
                events: subscribedEvents.map(e => e.event)
              }
            })
            .withDocumentation(documentation)
            .withComments(comments)
            .withTodos(todos)
            .withImplementationStatus(this.determineImplementationStatus(content, comments))
            .build()
        );

        for (const se of subscribedEvents) {
          entryPoints.push(this.createEntryPoint(
            `entry_event_${this.sanitizeId(se.event)}_${this.sanitizeId(name)}`,
            subscriberId,
            'event',
            `Event: ${se.event}`,
            `Handles ${se.event} via ${name}::${se.method}`,
            {
              event: se.event
            },
            undefined,
            {
              handler_method: se.method,
              priority: se.priority
            }
          ));
        }

        subscribers.push(subscriber);
      } catch {
        continue;
      }
    }

    return subscribers;
  }

  private async analyzeForms(
    phpFiles: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<SymfonyForm[]> {
    const forms: SymfonyForm[] = [];
    const formFiles = phpFiles.filter(f =>
      (f.includes('Form') || f.includes('Type')) && f.endsWith('.php') &&
      !f.includes('Entity') && !f.includes('Controller')
    );

    for (const file of formFiles) {
      try {
        const content = await this.readProjectFile(projectPath, file);

        if (!content.includes('AbstractType') && !content.includes('FormTypeInterface')) continue;

        const nameMatch = content.match(/class\s+(\w+)/);
        if (!nameMatch) continue;

        const name = nameMatch[1];
        const dataClass = this.extractFormDataClass(content);
        const fields = this.extractFormFields(content);
        const parent = this.extractFormParent(content);
        const comments = this.extractComments(content, file);
        const todos = this.extractTodos(comments);
        const documentation = this.extractDocumentation(content);

        const form: SymfonyForm = {
          name,
          filePath: file,
          dataClass,
          fields,
          parent
        };

        const formId = this.generateId('form', file, name);

        nodes.push(
          this.createNodeBuilder(formId, name, 'form')
            .withLevel(3, 'code')
            .withCategory('symfony-form')
            .withSource({ file, line: this.findClassLine(content), end_line: this.lineCount(content) })
            .withMetadata({
              framework: 'symfony',
              attributes: {
                data_class: dataClass,
                field_count: fields.length,
                parent_type: parent,
                fields: fields.map(f => ({ name: f.name, type: f.type }))
              }
            })
            .withDocumentation(documentation)
            .withComments(comments)
            .withTodos(todos)
            .build()
        );

        if (dataClass) {
          const entityId = this.sanitizeId(`entity_${dataClass}`);
          edges.push(this.createEdge(
            this.generateEdgeId(formId, entityId, 'maps_to'),
            formId,
            entityId,
            'maps_to',
            'data'
          ));
        }

        forms.push(form);
      } catch {
        continue;
      }
    }

    return forms;
  }

  private async analyzeTemplates(
    twigFiles: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<SymfonyTemplate[]> {
    const templates: SymfonyTemplate[] = [];

    for (const file of twigFiles) {
      try {
        const content = await this.readProjectFile(projectPath, file);
        const name = path.basename(file, '.html.twig') || path.basename(file, '.twig');
        const extendsMatch = content.match(/\{%\s*extends\s+['"]([^'"]+)['"]\s*%\}/);
        const includePattern = /\{[%{]\s*(?:include|embed)\s+['"]([^'"]+)['"]/g;
        const blockPattern = /\{%\s*block\s+(\w+)\s*%\}/g;
        const varPattern = /\{\{\s*(\w+)/g;

        const includes: string[] = [];
        let match;
        while ((match = includePattern.exec(content)) !== null) {
          includes.push(match[1]);
        }

        const blocks: string[] = [];
        while ((match = blockPattern.exec(content)) !== null) {
          blocks.push(match[1]);
        }

        const variables = new Set<string>();
        while ((match = varPattern.exec(content)) !== null) {
          const varName = match[1];
          if (!['block', 'parent', 'loop', 'app', 'dump'].includes(varName)) {
            variables.add(varName);
          }
        }

        const template: SymfonyTemplate = {
          name,
          filePath: file,
          extends: extendsMatch ? extendsMatch[1] : undefined,
          includes,
          blocks,
          variables: [...variables]
        };

        const templateId = this.generateId('template', file, name);
        const comments = this.extractTwigComments(content, file);
        const todos = this.extractTodos(comments);

        nodes.push(
          this.createNodeBuilder(templateId, name, 'template')
            .withLevel(3, 'code')
            .withCategory('twig-template')
            .withSource({ file, line: 1, end_line: this.lineCount(content) })
            .withMetadata({
              framework: 'symfony',
              attributes: {
                extends: template.extends,
                block_count: blocks.length,
                include_count: includes.length,
                variable_count: variables.size,
                blocks
              }
            })
            .withComments(comments)
            .withTodos(todos)
            .build()
        );

        templates.push(template);
      } catch {
        continue;
      }
    }

    return templates;
  }

  private async analyzeMigrations(
    phpFiles: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<SymfonyMigration[]> {
    const migrations: SymfonyMigration[] = [];
    const migrationFiles = phpFiles.filter(f =>
      (f.includes('Migration') || f.includes('Version')) && f.endsWith('.php') &&
      (f.includes('migrations') || f.includes('Migrations'))
    );

    for (const file of migrationFiles) {
      try {
        const content = await this.readProjectFile(projectPath, file);

        if (!content.includes('AbstractMigration') && !content.includes('Migration')) continue;

        const nameMatch = content.match(/class\s+(\w+)/);
        if (!nameMatch) continue;

        const name = nameMatch[1];
        const versionMatch = name.match(/Version(\d+)/);
        const version = versionMatch ? versionMatch[1] : name;
        const sqlStatements = this.extractMigrationSql(content);

        const migration: SymfonyMigration = {
          name,
          filePath: file,
          version,
          sqlStatements
        };

        const migrationId = this.generateId('migration', file, name);

        nodes.push(
          this.createNodeBuilder(migrationId, name, 'migration')
            .withLevel(3, 'code')
            .withCategory('doctrine-migration')
            .withSource({ file, line: this.findClassLine(content), end_line: this.lineCount(content) })
            .withMetadata({
              framework: 'symfony',
              attributes: {
                version,
                sql_statement_count: sqlStatements.length,
                tables_affected: this.extractAffectedTables(sqlStatements)
              }
            })
            .build()
        );

        migrations.push(migration);
      } catch {
        continue;
      }
    }

    return migrations;
  }

  private async analyzeMessageHandlers(
    phpFiles: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): Promise<SymfonyMessageHandler[]> {
    const handlers: SymfonyMessageHandler[] = [];
    const handlerFiles = phpFiles.filter(f => {
      const basename = path.basename(f, '.php');
      return (basename.includes('Handler') || basename.includes('MessageHandler')) && !basename.includes('EventHandler');
    });

    for (const file of handlerFiles) {
      try {
        const content = await this.readProjectFile(projectPath, file);

        const isHandler = content.includes('#[AsMessageHandler') || content.includes('MessageHandlerInterface');
        if (!isHandler) continue;

        const nameMatch = content.match(/class\s+(\w+)/);
        if (!nameMatch) continue;

        const name = nameMatch[1];
        const handlesMessage = this.extractHandledMessage(content);
        const dependencies = this.extractDependencies(content);
        const comments = this.extractComments(content, file);
        const todos = this.extractTodos(comments);
        const documentation = this.extractDocumentation(content);

        const handler: SymfonyMessageHandler = {
          name,
          filePath: file,
          handlesMessage: handlesMessage || 'unknown',
          dependencies
        };

        const handlerId = this.generateId('message_handler', file, name);

        nodes.push(
          this.createNodeBuilder(handlerId, name, 'message_handler')
            .withLevel(3, 'code')
            .withCategory('symfony-messenger')
            .withSource({ file, line: this.findClassLine(content), end_line: this.lineCount(content) })
            .withMetadata({
              framework: 'symfony',
              attributes: {
                handles_message: handlesMessage,
                dependency_count: dependencies.length
              }
            })
            .withDocumentation(documentation)
            .withComments(comments)
            .withTodos(todos)
            .withImplementationStatus(this.determineImplementationStatus(content, comments))
            .build()
        );

        entryPoints.push(this.createEntryPoint(
          `entry_message_${this.sanitizeId(handlesMessage || name)}`,
          handlerId,
          'message',
          `Message: ${handlesMessage || name}`,
          `Handles message ${handlesMessage} via ${name}`,
          {
            pattern: handlesMessage || name
          },
          undefined,
          {
            message_class: handlesMessage,
            handler: name
          }
        ));

        handlers.push(handler);
      } catch {
        continue;
      }
    }

    return handlers;
  }

  private async analyzeVoters(
    phpFiles: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<SymfonyVoter[]> {
    const voters: SymfonyVoter[] = [];
    const voterFiles = phpFiles.filter(f => f.includes('Voter') && f.endsWith('.php'));

    for (const file of voterFiles) {
      try {
        const content = await this.readProjectFile(projectPath, file);

        if (!content.includes('extends Voter') && !content.includes('VoterInterface')) continue;

        const nameMatch = content.match(/class\s+(\w+)/);
        if (!nameMatch) continue;

        const name = nameMatch[1];
        const attributes = this.extractVoterAttributes(content);
        const subjectClass = this.extractVoterSubject(content);
        const comments = this.extractComments(content, file);
        const todos = this.extractTodos(comments);

        const voter: SymfonyVoter = {
          name,
          filePath: file,
          attributes,
          subjectClass
        };

        const voterId = this.generateId('voter', file, name);

        nodes.push(
          this.createNodeBuilder(voterId, name, 'voter')
            .withLevel(3, 'code')
            .withCategory('symfony-security')
            .withSource({ file, line: this.findClassLine(content), end_line: this.lineCount(content) })
            .withMetadata({
              framework: 'symfony',
              attributes: {
                voter_attributes: attributes,
                subject_class: subjectClass
              }
            })
            .withComments(comments)
            .withTodos(todos)
            .build()
        );

        voters.push(voter);
      } catch {
        continue;
      }
    }

    return voters;
  }

  private async analyzeConfigRoutes(
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    routingConfig?: SymfonyRoutingConfig
  ): Promise<void> {
    const yamlRouteFiles = await glob(['config/routes*.yaml', 'config/routes*.yml', 'config/routes/**/*.yaml', 'config/routes/**/*.yml'], {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true
    });

    for (const file of yamlRouteFiles) {
      try {
        const content = await this.readProjectFile(projectPath, file);
        const parsed = yaml.load(content) as Record<string, any> | undefined;
        if (!parsed || typeof parsed !== 'object') continue;

        for (const [routeName, value] of Object.entries(parsed)) {
          if (routeName.startsWith('when@') || !value || typeof value !== 'object') continue;
          if (typeof value.path !== 'string') continue;

          const routePath = value.path;
          const controller = typeof value.controller === 'string'
            ? value.controller
            : typeof value.defaults?._controller === 'string' ? value.defaults._controller : undefined;
          const rawMethods = value.methods;
          const methods = (Array.isArray(rawMethods)
            ? rawMethods
            : typeof rawMethods === 'string' ? rawMethods.split('|') : ['GET'])
            .map((m: string) => String(m).trim().toUpperCase())
            .filter(Boolean);

          const routeId = this.generateId('route', file, routeName);
          const handler = this.findControllerActionHandler(controller, nodes);
          const security = this.resolveRouteSecurity(routePath, [], routingConfig?.accessControl ?? []);

          nodes.push(
            this.createNodeBuilder(routeId, routeName, 'route')
              .withLevel(3, 'code')
              .withCategory('symfony-route')
              .withSource({ file, line: this.lineNumberAt(content, content.indexOf(`${routeName}:`)) })
              .withMetadata({
                framework: 'symfony',
                attributes: {
                  path: routePath,
                  methods,
                  controller,
                  source: 'yaml'
                }
              })
              .build()
          );

          for (const method of methods) {
            entryPoints.push(this.createEntryPoint(
              `entry_yaml_${method.toLowerCase()}_${this.sanitizeId(routePath)}`,
              handler?.node_id ?? routeId,
              'http',
              `${method} ${routePath}`,
              `YAML-defined route: ${routeName}`,
              {
                method,
                path: routePath
              },
              security,
              {
                route_name: routeName,
                controller,
                source: 'yaml'
              },
              handler
            ));
          }
        }
      } catch {
        continue;
      }
    }
  }

  private findControllerActionHandler(
    controller: string | undefined,
    nodes: CASNode[]
  ): CASEntryPoint['handler'] | undefined {
    if (!controller) return undefined;
    const [classPath, action] = controller.split('::');
    if (!classPath) return undefined;
    const className = classPath.split('\\').pop();
    if (!className) return undefined;

    const controllerNode = nodes.find(n =>
      n.name === className && n.category === 'symfony-controller'
    );
    if (!controllerNode) return undefined;

    if (!action) {
      return {
        node_id: controllerNode.id,
        method_name: '__invoke',
        file: controllerNode.source?.file,
        line: controllerNode.source?.line
      };
    }

    const methodNode = nodes.find(n =>
      n.name === action &&
      n.category === 'controller-action' &&
      n.source?.file === controllerNode.source?.file
    );
    if (!methodNode) {
      return {
        node_id: controllerNode.id,
        method_name: action,
        file: controllerNode.source?.file
      };
    }

    return {
      node_id: methodNode.id,
      method_name: action,
      file: methodNode.source?.file,
      line: methodNode.source?.line
    };
  }

  private isSymfonyController(content: string): boolean {
    return (
      content.includes('AbstractController') ||
      content.includes('ControllerInterface') ||
      content.includes('#[Route') ||
      content.includes('@Route') ||
      content.includes('FOS\\RestBundle') ||
      /#\[\s*(?:[A-Za-z_]\w*\\)+(?:Route|Get|Post|Put|Patch|Delete|Head|Options)\b/.test(content) ||
      (content.includes('Response') && content.includes('function ') && content.includes('Controller'))
    );
  }

  private isDoctrineEntity(content: string): boolean {
    return (
      content.includes('#[ORM\\Entity') ||
      content.includes('#[Entity') ||
      content.includes('@ORM\\Entity') ||
      content.includes('@Entity')
    );
  }

  private isDoctrineRepository(content: string): boolean {
    return (
      content.includes('ServiceEntityRepository') ||
      content.includes('EntityRepository') ||
      content.includes('extends ObjectRepository')
    );
  }

  private isSymfonyCommand(content: string): boolean {
    return (
      content.includes('extends Command') ||
      content.includes('#[AsCommand') ||
      content.includes('Symfony\\Component\\Console\\Command')
    );
  }

  private extractNamespace(content: string): string {
    const match = content.match(/namespace\s+([^;]+);/);
    return match ? match[1].trim() : 'global';
  }

  private extractDependencies(content: string): string[] {
    const deps: string[] = [];
    const usePattern = /use\s+([^;]+);/g;

    let match;
    while ((match = usePattern.exec(content)) !== null) {
      const dep = match[1].trim();
      if (dep.includes('\\') && !dep.includes(' as ')) {
        deps.push(dep);
      }
    }

    const constructorMatch = content.match(/function\s+__construct\s*\(([^)]*)\)/s);
    if (constructorMatch) {
      const paramPattern = /(?:private|protected|public|readonly)\s+(?:\??(\w+(?:\\\w+)*))\s+\$/g;
      let paramMatch: RegExpExecArray | null;
      while ((paramMatch = paramPattern.exec(constructorMatch[1])) !== null) {
        if (paramMatch[1] && !deps.some(d => d.endsWith(paramMatch![1]))) {
          deps.push(paramMatch[1]);
        }
      }
    }

    return deps;
  }

  private extractMethods(content: string, filePath: string): Array<{ name: string; visibility: string; parameters: any[]; returnType?: string; line: number }> {
    const methods: Array<{ name: string; visibility: string; parameters: any[]; returnType?: string; line: number }> = [];
    const methodPattern = /(public|private|protected)\s+function\s+(\w+)\s*\(([^)]*)\)(?:\s*:\s*(\??\w+(?:\\\w+)*))?/g;

    let match;
    while ((match = methodPattern.exec(content)) !== null) {
      const visibility = match[1];
      const name = match[2];
      if (name === '__construct') continue;

      const line = this.lineNumberAt(content, match.index);
      const parameters = this.parseMethodParameters(match[3]);
      const returnType = match[4];

      methods.push({ name, visibility, parameters, returnType, line });
    }

    return methods;
  }

  private attachMethodDependencyUsage(
    content: string,
    methods: Array<{ name: string; visibility: string; parameters: any[]; returnType?: string; line: number; usedDependencies?: string[] }>
  ): void {
    const propertyTypes = new Map<string, string>();

    const promotedPattern = /(?:private|protected|public)\s+(?:readonly\s+)?\??([\w\\]+)\s+\$(\w+)/g;
    let match: RegExpExecArray | null;
    while ((match = promotedPattern.exec(content)) !== null) {
      const shortType = match[1].split('\\').pop();
      if (shortType && /^[A-Z]/.test(shortType)) {
        propertyTypes.set(match[2], shortType);
      }
    }

    const constructorMatch = content.match(/function\s+__construct\s*\(([^)]*)\)/s);
    if (constructorMatch) {
      const paramTypes = new Map<string, string>();
      const paramPattern = /\??([\w\\]+)\s+\$(\w+)/g;
      while ((match = paramPattern.exec(constructorMatch[1])) !== null) {
        const shortType = match[1].split('\\').pop();
        if (shortType && /^[A-Z]/.test(shortType)) {
          paramTypes.set(match[2], shortType);
        }
      }
      const assignmentPattern = /\$this->(\w+)\s*=\s*\$(\w+)/g;
      while ((match = assignmentPattern.exec(content)) !== null) {
        const type = paramTypes.get(match[2]);
        if (type && !propertyTypes.has(match[1])) {
          propertyTypes.set(match[1], type);
        }
      }
    }

    const lines = content.split('\n');
    const sortedLines = methods.map(m => m.line).sort((a, b) => a - b);

    for (const method of methods) {
      const nextLine = sortedLines.find(l => l > method.line);
      const body = lines.slice(method.line - 1, nextLine ? nextLine - 1 : lines.length).join('\n');
      const used = new Set<string>();

      for (const param of method.parameters) {
        const shortType = typeof param.type === 'string' ? param.type.split('\\').pop() : undefined;
        if (shortType && /^[A-Z]/.test(shortType)) {
          used.add(shortType);
        }
      }

      const propertyUsePattern = /\$this->(\w+)\s*->/g;
      while ((match = propertyUsePattern.exec(body)) !== null) {
        const type = propertyTypes.get(match[1]);
        if (type) used.add(type);
      }

      method.usedDependencies = Array.from(used);
    }
  }

  private parseMethodParameters(paramStr: string): Array<{ name: string; type?: string }> {
    const params: Array<{ name: string; type?: string }> = [];
    if (!paramStr.trim()) return params;

    const paramPattern = /(?:(\??\w+(?:\\\w+)*)\s+)?\$(\w+)/g;
    let match;
    while ((match = paramPattern.exec(paramStr)) !== null) {
      params.push({
        name: match[2],
        type: match[1]
      });
    }

    return params;
  }

  private extractControllerRoutes(content: string, filePath: string): SymfonyRoute[] {
    const routes: SymfonyRoute[] = [];
    const classDeclIndex = content.search(/^\s*(?:final\s+|abstract\s+|readonly\s+)*class\s+\w+/m);
    const isClassLevel = (index: number) => classDeclIndex >= 0 && index < classDeclIndex;
    const hasFosRest = content.includes('FOS\\RestBundle');

    const attributeNamePattern = /(?:#\[|,)\s*((?:[A-Za-z_]\w*\\)*)(Route|Get|Post|Put|Patch|Delete|Head|Options)\s*(?=[(,\]])/g;
    let match: RegExpExecArray | null;
    while ((match = attributeNamePattern.exec(content)) !== null) {
      const prefix = match[1];
      const attributeName = match[2];
      const isVerb = attributeName !== 'Route';

      if (isVerb) {
        if (!hasFosRest) continue;
        if (/^(OA|OpenApi|Nelmio|SWG)\\/i.test(prefix)) continue;
      }

      const argsStart = match.index + match[0].length;
      const args = content[argsStart] === '('
        ? this.extractBalancedParens(content, argsStart)
        : '';

      const pathMatch = args.match(/^\(\s*(?:path\s*[:=]\s*)?['"]([^'"]*)['"]/) ||
        args.match(/[(,]\s*path\s*[:=]\s*['"]([^'"]*)['"]/);
      const routePath = pathMatch ? pathMatch[1] : '';
      const nameMatch = args.match(/[(,]\s*name\s*[:=]\s*['"]([^'"]+)['"]/);
      const methodsMatch = args.match(/methods\s*[:=]\s*(?:\[([^\]]*)\]|\{([^}]*)\}|['"](\w+)['"])/);
      const methodsStr = methodsMatch ? (methodsMatch[1] ?? methodsMatch[2] ?? methodsMatch[3]) : undefined;
      const methods = isVerb
        ? [attributeName.toUpperCase()]
        : methodsStr
          ? methodsStr.split(',').map((m: string) => m.trim().replace(/['"]/g, '')).filter(Boolean)
          : [];

      const line = this.lineNumberAt(content, match.index);
      routes.push({
        path: routePath,
        methods,
        name: nameMatch ? nameMatch[1] : undefined,
        line,
        classLevel: isClassLevel(match.index)
      });
    }

    const annotationRoutePattern = /@(?:(\w+)\\)?(Route|Get|Post|Put|Patch|Delete|Head|Options)\s*\(\s*["']([^"']*)["']([^)]*)\)/g;
    while ((match = annotationRoutePattern.exec(content)) !== null) {
      const attributeName = match[2];
      const isVerb = attributeName !== 'Route';
      if (isVerb && !hasFosRest) continue;

      const routePath = match[3];
      const rest = match[4] || '';
      const nameMatch = rest.match(/name\s*=\s*["']([^"']+)["']/);
      const methodsMatch = rest.match(/methods\s*=\s*\{([^}]*)\}/);
      const methods = isVerb
        ? [attributeName.toUpperCase()]
        : methodsMatch
          ? methodsMatch[1].split(',').map((m: string) => m.trim().replace(/["']/g, '')).filter(Boolean)
          : [];
      const line = this.lineNumberAt(content, match.index);

      routes.push({
        path: routePath,
        methods,
        name: nameMatch ? nameMatch[1] : undefined,
        line,
        classLevel: isClassLevel(match.index)
      });
    }

    return routes;
  }

  private extractBalancedParens(content: string, openIndex: number): string {
    let depth = 0;
    let inString: string | null = null;
    for (let i = openIndex; i < content.length; i++) {
      const ch = content[i];
      if (inString) {
        if (ch === '\\') {
          i++;
        } else if (ch === inString) {
          inString = null;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = ch;
      } else if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth--;
        if (depth === 0) return content.slice(openIndex, i + 1);
      }
    }
    return content.slice(openIndex);
  }

  private extractSecurityGuards(content: string): SymfonySecurityGuard[] {
    const guards: SymfonySecurityGuard[] = [];
    const classDeclIndex = content.search(/^\s*(?:final\s+|abstract\s+|readonly\s+)*class\s+\w+/m);
    const guardPattern = /(?:#\[|,|@)\s*(IsGranted|Security)\s*(?=\()/g;

    let match: RegExpExecArray | null;
    while ((match = guardPattern.exec(content)) !== null) {
      const argsStart = match.index + match[0].length;
      const args = this.extractBalancedParens(content, argsStart);
      const roles = Array.from(new Set(
        args.match(/ROLE_\w+|IS_AUTHENTICATED_\w+|PUBLIC_ACCESS/g) ?? []
      ));

      guards.push({
        attribute: match[1],
        roles,
        line: this.lineNumberAt(content, match.index),
        classLevel: classDeclIndex >= 0 && match.index < classDeclIndex
      });
    }

    return guards;
  }

  private joinRoutePaths(...segments: Array<string | undefined>): string {
    const parts = segments
      .filter((s): s is string => s !== undefined && s !== '' && s !== '/')
      .map(s => s.replace(/^\/+|\/+$/g, ''))
      .filter(Boolean);
    return `/${parts.join('/')}`;
  }

  private findResourcePrefix(controllerFile: string, resourcePrefixes: SymfonyResourcePrefix[]): string | undefined {
    const normalized = controllerFile.split(path.sep).join('/');
    let best: SymfonyResourcePrefix | undefined;
    for (const candidate of resourcePrefixes) {
      if (!normalized.startsWith(`${candidate.dir}/`)) continue;
      if (!best || candidate.dir.length > best.dir.length) {
        best = candidate;
      }
    }
    return best?.prefix;
  }

  private resolveRouteSecurity(
    fullPath: string,
    guards: SymfonySecurityGuard[],
    accessControl: SymfonyAccessControlRule[]
  ): CASEntryPoint['security'] | undefined {
    const guardNames = Array.from(new Set(guards.map(g => g.attribute)));
    const guardRoles = Array.from(new Set(guards.flatMap(g => g.roles)));

    const matchedRule = accessControl.find(rule => rule.pattern.test(fullPath));
    const ruleRoles = matchedRule?.roles ?? [];

    if (guardNames.length === 0 && !matchedRule) return undefined;

    const allRoles = Array.from(new Set([...guardRoles, ...ruleRoles]));
    const restrictedRoles = allRoles.filter(r => r !== 'PUBLIC_ACCESS');
    const isPublic = guardNames.length === 0 && ruleRoles.length > 0 && restrictedRoles.length === 0;

    return {
      authenticated: !isPublic,
      authorized_roles: restrictedRoles,
      guards: guardNames,
      roles: allRoles
    };
  }

  private async loadRoutingConfig(projectPath: string): Promise<SymfonyRoutingConfig> {
    const config: SymfonyRoutingConfig = { resourcePrefixes: [], accessControl: [] };

    const routeFiles = await glob(['config/routes*.yaml', 'config/routes*.yml', 'config/routes/**/*.yaml', 'config/routes/**/*.yml'], {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true
    });

    for (const file of routeFiles) {
      try {
        const content = await this.readProjectFile(projectPath, file);
        const parsed = yaml.load(content) as Record<string, any> | undefined;
        if (!parsed || typeof parsed !== 'object') continue;

        for (const [key, value] of Object.entries(parsed)) {
          if (key.startsWith('when@') || !value || typeof value !== 'object') continue;
          const resource = value.resource;
          const resourcePath = typeof resource === 'object' && resource !== null
            ? resource.path
            : typeof resource === 'string' ? resource : undefined;
          const prefix = typeof value.prefix === 'string' ? value.prefix : undefined;
          if (!resourcePath || !prefix || typeof resourcePath !== 'string') continue;
          if (resourcePath.startsWith('@')) continue;

          const dir = path.posix.normalize(
            path.posix.join(path.posix.dirname(file.split(path.sep).join('/')), resourcePath)
          );
          config.resourcePrefixes.push({ dir, prefix });
        }
      } catch {
        continue;
      }
    }

    const securityFiles = await glob(['config/packages/security.yaml', 'config/packages/security.yml', 'config/security.yaml', 'config/security.yml'], {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true
    });

    for (const file of securityFiles) {
      try {
        const content = await this.readProjectFile(projectPath, file);
        const parsed = yaml.load(content) as Record<string, any> | undefined;
        const accessControl = parsed?.security?.access_control;
        if (!Array.isArray(accessControl)) continue;

        for (const rule of accessControl) {
          if (!rule || typeof rule !== 'object' || typeof rule.path !== 'string') continue;
          const rawRoles = rule.roles ?? rule.role;
          const roles = (Array.isArray(rawRoles) ? rawRoles : rawRoles !== undefined ? [rawRoles] : [])
            .filter((r: unknown): r is string => typeof r === 'string');
          if (roles.length === 0) continue;
          try {
            config.accessControl.push({ pattern: new RegExp(rule.path), roles });
          } catch {
            continue;
          }
        }
      } catch {
        continue;
      }
    }

    return config;
  }

  private extractEntityTable(content: string): string | undefined {
    const attrMatch = content.match(/#\[ORM\\Table\s*\(\s*name:\s*['"](\w+)['"]/);
    if (attrMatch) return attrMatch[1];

    const annotationMatch = content.match(/@ORM\\Table\s*\(\s*name\s*=\s*["'](\w+)["']/);
    if (annotationMatch) return annotationMatch[1];

    const entityAttr = content.match(/#\[ORM\\Entity[^)]*\]/);
    if (entityAttr) {
      const tableInEntity = entityAttr[0].match(/table:\s*['"](\w+)['"]/);
      if (tableInEntity) return tableInEntity[1];
    }

    return undefined;
  }

  private extractRepositoryClass(content: string): string | undefined {
    const match = content.match(/repositoryClass:\s*(\w+)::class/);
    if (match) return match[1];

    const annotationMatch = content.match(/repositoryClass\s*=\s*["']([^"']+)["']/);
    if (annotationMatch) return annotationMatch[1].split('\\').pop();

    return undefined;
  }

  private extractEntityFields(content: string, filePath: string): Array<{ name: string; type: string; nullable: boolean; unique: boolean; line: number }> {
    const fields: Array<{ name: string; type: string; nullable: boolean; unique: boolean; line: number }> = [];

    const columnPattern = /#\[ORM\\Column\s*\(([^)]*)\)\]\s*(?:private|protected|public)\s+(?:\??\w+\s+)?\$(\w+)/g;
    let match;
    while ((match = columnPattern.exec(content)) !== null) {
      const options = match[1];
      const name = match[2];
      const line = this.lineNumberAt(content, match.index);

      const typeMatch = options.match(/type:\s*['"](\w+)['"]/);
      const type = typeMatch ? typeMatch[1] : 'string';
      const nullable = options.includes('nullable: true') || options.includes('nullable=true');
      const unique = options.includes('unique: true') || options.includes('unique=true');

      fields.push({ name, type, nullable, unique, line });
    }

    const annotationColumnPattern = /@ORM\\Column\s*\(([^)]*)\)\s*\*\/\s*(?:private|protected|public)\s+(?:\??\w+\s+)?\$(\w+)/g;
    while ((match = annotationColumnPattern.exec(content)) !== null) {
      const options = match[1];
      const name = match[2];
      const line = this.lineNumberAt(content, match.index);

      const typeMatch = options.match(/type\s*=\s*["'](\w+)["']/);
      const type = typeMatch ? typeMatch[1] : 'string';
      const nullable = options.includes('nullable=true');
      const unique = options.includes('unique=true');

      fields.push({ name, type, nullable, unique, line });
    }

    return fields;
  }

  private extractEntityRelations(content: string, filePath: string): Array<{ name: string; type: string; targetEntity: string; inversedBy?: string; mappedBy?: string; line: number }> {
    const relations: Array<{ name: string; type: string; targetEntity: string; inversedBy?: string; mappedBy?: string; line: number }> = [];

    const relationTypes = ['OneToMany', 'ManyToOne', 'OneToOne', 'ManyToMany'];

    for (const relType of relationTypes) {
      const attrPattern = new RegExp(`#\\[ORM\\\\${relType}\\s*\\(([^)]+)\\)\\]\\s*(?:private|protected|public)\\s+(?:\\??[\\w\\\\|]+\\s+)?\\$(\\w+)`, 'g');
      let match;
      while ((match = attrPattern.exec(content)) !== null) {
        const options = match[1];
        const name = match[2];
        const line = this.lineNumberAt(content, match.index);

        const targetMatch = options.match(/targetEntity:\s*(\w+)::class/);
        const targetEntity = targetMatch ? targetMatch[1] : 'unknown';
        const inversedByMatch = options.match(/inversedBy:\s*['"](\w+)['"]/);
        const mappedByMatch = options.match(/mappedBy:\s*['"](\w+)['"]/);

        relations.push({
          name,
          type: relType,
          targetEntity,
          inversedBy: inversedByMatch ? inversedByMatch[1] : undefined,
          mappedBy: mappedByMatch ? mappedByMatch[1] : undefined,
          line
        });
      }

      const annotPattern = new RegExp(`@ORM\\\\${relType}\\s*\\(([^)]+)\\).*?\\$(\w+)`, 'gs');
      while ((match = annotPattern.exec(content)) !== null) {
        const options = match[1];
        const name = match[2];
        const line = this.lineNumberAt(content, match.index);

        const targetMatch = options.match(/targetEntity\s*=\s*["']?([^"',\s]+)/);
        const targetEntity = targetMatch ? targetMatch[1].replace('::class', '').split('\\').pop() || 'unknown' : 'unknown';
        const inversedByMatch = options.match(/inversedBy\s*=\s*["'](\w+)["']/);
        const mappedByMatch = options.match(/mappedBy\s*=\s*["'](\w+)["']/);

        relations.push({
          name,
          type: relType,
          targetEntity,
          inversedBy: inversedByMatch ? inversedByMatch[1] : undefined,
          mappedBy: mappedByMatch ? mappedByMatch[1] : undefined,
          line
        });
      }
    }

    return relations;
  }

  private extractLifecycleCallbacks(content: string): string[] {
    const callbacks: string[] = [];
    const lifecycleEvents = ['PrePersist', 'PostPersist', 'PreUpdate', 'PostUpdate', 'PreRemove', 'PostRemove', 'PostLoad', 'PreFlush'];

    for (const event of lifecycleEvents) {
      if (content.includes(`#[ORM\\${event}`) || content.includes(`@ORM\\${event}`)) {
        callbacks.push(event);
      }
    }

    return callbacks;
  }

  private extractRepositoryEntityClass(content: string): string | undefined {
    const parentMatch = content.match(/ServiceEntityRepository\s*\{/);
    if (parentMatch) {
      const constructorMatch = content.match(/parent::__construct\s*\(\s*\$\w+\s*,\s*(\w+)::class\s*\)/);
      if (constructorMatch) return constructorMatch[1];
    }

    const genericMatch = content.match(/extends\s+ServiceEntityRepository\s*<\s*(\w+)\s*>/);
    if (genericMatch) return genericMatch[1];

    return undefined;
  }

  private extractCommandName(content: string): string | undefined {
    const attrMatch = content.match(/#\[AsCommand\s*\(\s*(?:name:\s*)?['"]([^'"]+)['"]/);
    if (attrMatch) return attrMatch[1];

    const nameMatch = content.match(/protected\s+static\s+\$defaultName\s*=\s*['"]([^'"]+)['"]/);
    if (nameMatch) return nameMatch[1];

    const configMatch = content.match(/->setName\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (configMatch) return configMatch[1];

    return undefined;
  }

  private extractCommandDescription(content: string): string | undefined {
    const attrMatch = content.match(/#\[AsCommand\s*\([^)]*description:\s*['"]([^'"]+)['"]/);
    if (attrMatch) return attrMatch[1];

    const descMatch = content.match(/protected\s+static\s+\$defaultDescription\s*=\s*['"]([^'"]+)['"]/);
    if (descMatch) return descMatch[1];

    const configMatch = content.match(/->setDescription\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (configMatch) return configMatch[1];

    return undefined;
  }

  private extractCommandArguments(content: string): Array<{ name: string; mode: string; description?: string }> {
    const args: Array<{ name: string; mode: string; description?: string }> = [];
    const argPattern = /->addArgument\s*\(\s*['"](\w+)['"](?:\s*,\s*InputArgument::(\w+))?(?:\s*,\s*['"]([^'"]*)['"]\s*)?\)/g;

    let match;
    while ((match = argPattern.exec(content)) !== null) {
      args.push({
        name: match[1],
        mode: match[2] || 'OPTIONAL',
        description: match[3]
      });
    }

    return args;
  }

  private extractCommandOptions(content: string): Array<{ name: string; shortcut?: string; mode: string; description?: string }> {
    const options: Array<{ name: string; shortcut?: string; mode: string; description?: string }> = [];
    const optPattern = /->addOption\s*\(\s*['"](\w+)['"](?:\s*,\s*['"]?(\w)?['"]?)?(?:\s*,\s*InputOption::(\w+))?(?:\s*,\s*['"]([^'"]*)['"]\s*)?\)/g;

    let match;
    while ((match = optPattern.exec(content)) !== null) {
      options.push({
        name: match[1],
        shortcut: match[2],
        mode: match[3] || 'VALUE_NONE',
        description: match[4]
      });
    }

    return options;
  }

  private extractSubscribedEvents(content: string): Array<{ event: string; method: string; priority?: number }> {
    const events: Array<{ event: string; method: string; priority?: number }> = [];

    const staticMethodMatch = content.match(/function\s+getSubscribedEvents\s*\(\s*\)[^{]*\{([\s\S]*?)\}/);
    if (staticMethodMatch) {
      const body = staticMethodMatch[1];
      const eventPattern = /['"]([^'"]+)['"]\s*=>\s*(?:\[\s*\[\s*['"](\w+)['"](?:\s*,\s*(-?\d+))?\s*\]|['"](\w+)['"])/g;

      let match;
      while ((match = eventPattern.exec(body)) !== null) {
        events.push({
          event: match[1],
          method: match[2] || match[4],
          priority: match[3] ? parseInt(match[3]) : undefined
        });
      }

      const simplePattern = /(\w+)::class\s*=>\s*['"](\w+)['"]/g;
      while ((match = simplePattern.exec(body)) !== null) {
        events.push({
          event: match[1],
          method: match[2]
        });
      }
    }

    const attrPattern = /#\[AsEventListener\s*\(\s*(?:event:\s*)?['"]?([^'")\s,]+)['"]?(?:\s*,\s*method:\s*['"](\w+)['"])?(?:\s*,\s*priority:\s*(-?\d+))?\s*\)/g;
    let attrMatch;
    while ((attrMatch = attrPattern.exec(content)) !== null) {
      events.push({
        event: attrMatch[1].replace('::class', ''),
        method: attrMatch[2] || '__invoke',
        priority: attrMatch[3] ? parseInt(attrMatch[3]) : undefined
      });
    }

    return events;
  }

  private extractFormDataClass(content: string): string | undefined {
    const match = content.match(/['"]data_class['"]\s*=>\s*(\w+)::class/);
    if (match) return match[1];

    const strMatch = content.match(/['"]data_class['"]\s*=>\s*['"]([^'"]+)['"]/);
    if (strMatch) return strMatch[1].split('\\').pop();

    return undefined;
  }

  private extractFormFields(content: string): Array<{ name: string; type: string; options: Record<string, any> }> {
    const fields: Array<{ name: string; type: string; options: Record<string, any> }> = [];
    const fieldPattern = /->add\s*\(\s*['"](\w+)['"](?:\s*,\s*(\w+)Type::class)?/g;

    let match;
    while ((match = fieldPattern.exec(content)) !== null) {
      fields.push({
        name: match[1],
        type: match[2] || 'Text',
        options: {}
      });
    }

    return fields;
  }

  private extractFormParent(content: string): string | undefined {
    const match = content.match(/function\s+getParent\s*\(\s*\)[^{]*\{\s*return\s+(\w+)Type::class/);
    return match ? match[1] + 'Type' : undefined;
  }

  private extractHandledMessage(content: string): string | undefined {
    const attrMatch = content.match(/#\[AsMessageHandler\s*\(\s*handles:\s*(\w+)::class/);
    if (attrMatch) return attrMatch[1];

    const invokeMatch = content.match(/function\s+__invoke\s*\(\s*(\w+)\s+\$/);
    if (invokeMatch) return invokeMatch[1];

    const handleMatch = content.match(/function\s+handle\s*\(\s*(\w+)\s+\$/);
    if (handleMatch) return handleMatch[1];

    return undefined;
  }

  private extractVoterAttributes(content: string): string[] {
    const attributes: string[] = [];
    const constPattern = /(?:const|=)\s*['"](\w+)['"]/g;
    const supportsMatch = content.match(/function\s+supports\s*\([^)]*\)[^{]*\{([\s\S]*?)\}/);

    if (supportsMatch) {
      let match;
      while ((match = constPattern.exec(supportsMatch[1])) !== null) {
        if (!['true', 'false', 'null'].includes(match[1])) {
          attributes.push(match[1]);
        }
      }
    }

    const constDefs = content.match(/const\s+(\w+)\s*=\s*['"](\w+)['"]/g);
    if (constDefs) {
      for (const def of constDefs) {
        const nameMatch = def.match(/const\s+(\w+)/);
        if (nameMatch) attributes.push(nameMatch[1]);
      }
    }

    return [...new Set(attributes)];
  }

  private extractVoterSubject(content: string): string | undefined {
    const supportsMatch = content.match(/function\s+supports\s*\([^)]*\)[^{]*\{([\s\S]*?)\}/);
    if (supportsMatch) {
      const instanceofMatch = supportsMatch[1].match(/instanceof\s+(\w+)/);
      if (instanceofMatch) return instanceofMatch[1];
    }

    const voteMatch = content.match(/function\s+voteOnAttribute\s*\([^,]+,\s*(?:\??\s*(\w+)\s+)?\$/);
    if (voteMatch && voteMatch[1]) return voteMatch[1];

    return undefined;
  }

  private extractServiceTags(content: string): string[] {
    const tags: string[] = [];

    if (content.includes('#[Autoconfigure')) tags.push('autoconfigure');
    if (content.includes('#[AsService')) tags.push('service');
    if (content.includes('#[AsDecorator')) tags.push('decorator');
    if (content.includes('#[AsTaggedItem')) tags.push('tagged');

    return tags;
  }

  private extractMigrationSql(content: string): string[] {
    const statements: string[] = [];
    const sqlPattern = /\$this->addSql\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

    let match;
    while ((match = sqlPattern.exec(content)) !== null) {
      statements.push(match[1]);
    }

    const schemaPattern = /\$schema->createTable\s*\(\s*['"](\w+)['"]\s*\)/g;
    while ((match = schemaPattern.exec(content)) !== null) {
      statements.push(`CREATE TABLE ${match[1]}`);
    }

    return statements;
  }

  private extractAffectedTables(sqlStatements: string[]): string[] {
    const tables = new Set<string>();

    for (const sql of sqlStatements) {
      const tableMatch = sql.match(/(?:CREATE|ALTER|DROP)\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(\w+)/i);
      if (tableMatch) tables.add(tableMatch[1]);
    }

    return [...tables];
  }

  private findClassLine(content: string): number {
    const match = content.match(/class\s+\w+/);
    if (match && match.index !== undefined) {
      return this.lineNumberAt(content, match.index);
    }
    return 1;
  }

  private lineCount(content: string): number {
    return this.lineIndexes(content).length + 1;
  }

  private lineNumberAt(content: string, index: number | undefined): number {
    if (!index || index <= 0) return 1;
    const indexes = this.lineIndexes(content);
    let low = 0;
    let high = indexes.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (indexes[mid] < index) low = mid + 1;
      else high = mid;
    }
    return low + 1;
  }

  private lineIndexes(content: string): number[] {
    const cached = this.lineIndexCache.get(content);
    if (cached) return cached;
    const indexes: number[] = [];
    for (let index = content.indexOf('\n'); index !== -1; index = content.indexOf('\n', index + 1)) {
      indexes.push(index);
    }
    this.lineIndexCache.set(content, indexes);
    return indexes;
  }

  private async detectSymfonyVersion(projectPath: string): Promise<string> {
    try {
      const composerJson = await fs.readJson(path.join(projectPath, 'composer.json'));
      const deps = { ...composerJson.require, ...composerJson['require-dev'] };
      return deps['symfony/framework-bundle'] || deps['symfony/symfony'] || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private buildRelationships(
    controllers: SymfonyController[],
    entities: SymfonyEntity[],
    repositories: SymfonyRepository[],
    services: SymfonyService[],
    forms: SymfonyForm[],
    subscribers: SymfonyEventSubscriber[],
    migrations: SymfonyMigration[],
    templates: SymfonyTemplate[],
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    for (const controller of controllers) {
      const controllerId = this.generateId('controller', controller.filePath, controller.name);

      for (const service of services) {
        if (controller.dependencies.some(dep => dep.includes(service.name))) {
          const serviceId = this.generateId('service', service.filePath, service.name);
          edges.push(this.createEdge(
            this.generateEdgeId(controllerId, serviceId, 'depends_on'),
            controllerId,
            serviceId,
            'depends_on',
            'structural',
            { attributes: { injection_type: 'constructor' } }
          ));
        }
      }

      for (const repo of repositories) {
        if (controller.dependencies.some(dep => dep.includes(repo.name))) {
          const repoId = this.generateId('repository', repo.filePath, repo.name);
          edges.push(this.createEdge(
            this.generateEdgeId(controllerId, repoId, 'depends_on'),
            controllerId,
            repoId,
            'depends_on',
            'structural'
          ));
        }
      }

      for (const form of forms) {
        if (controller.dependencies.some(dep => dep.includes(form.name))) {
          const formId = this.generateId('form', form.filePath, form.name);
          edges.push(this.createEdge(
            this.generateEdgeId(controllerId, formId, 'uses'),
            controllerId,
            formId,
            'uses',
            'behavioral'
          ));
        }
      }

      for (const method of controller.methods) {
        const usedDependencies = method.usedDependencies ?? [];
        if (usedDependencies.length === 0) continue;
        const methodId = this.generateId('method', controller.filePath, `${controller.name}.${method.name}`);

        for (const service of services) {
          if (usedDependencies.some(dep => dep.includes(service.name))) {
            const serviceId = this.generateId('service', service.filePath, service.name);
            edges.push(this.createEdge(
              this.generateEdgeId(methodId, serviceId, 'calls'),
              methodId,
              serviceId,
              'calls',
              'behavioral'
            ));
          }
        }

        for (const repo of repositories) {
          if (usedDependencies.some(dep => dep.includes(repo.name))) {
            const repoId = this.generateId('repository', repo.filePath, repo.name);
            edges.push(this.createEdge(
              this.generateEdgeId(methodId, repoId, 'calls'),
              methodId,
              repoId,
              'calls',
              'behavioral'
            ));
          }
        }
      }
    }

    for (const service of services) {
      const serviceId = this.generateId('service', service.filePath, service.name);

      for (const repo of repositories) {
        if (service.dependencies.some(dep => dep.includes(repo.name))) {
          const repoId = this.generateId('repository', repo.filePath, repo.name);
          edges.push(this.createEdge(
            this.generateEdgeId(serviceId, repoId, 'depends_on'),
            serviceId,
            repoId,
            'depends_on',
            'structural'
          ));
        }
      }
    }

    for (const repo of repositories) {
      if (repo.entityClass) {
        const repoId = this.generateId('repository', repo.filePath, repo.name);
        const matchingEntity = entities.find(e => e.name === repo.entityClass);
        if (matchingEntity) {
          const entityId = this.generateId('entity', matchingEntity.filePath, matchingEntity.name);
          edges.push(this.createEdge(
            this.generateEdgeId(repoId, entityId, 'manages'),
            repoId,
            entityId,
            'manages',
            'data'
          ));
        }
      }
    }

    for (const entity of entities) {
      const entityId = this.generateId('entity', entity.filePath, entity.name);

      for (const relation of entity.relations) {
        const relatedEntity = entities.find(e => e.name === relation.targetEntity);
        if (relatedEntity) {
          const relatedEntityId = this.generateId('entity', relatedEntity.filePath, relatedEntity.name);
          edges.push(this.createEdge(
            this.generateEdgeId(entityId, relatedEntityId, 'relates_to'),
            entityId,
            relatedEntityId,
            'relates_to',
            'data',
            {
              attributes: {
                relation_type: relation.type,
                inversed_by: relation.inversedBy,
                mapped_by: relation.mappedBy
              }
            }
          ));
        }
      }
    }

    for (const subscriber of subscribers) {
      const subscriberId = this.generateId('event_subscriber', subscriber.filePath, subscriber.name);
      for (const se of subscriber.subscribedEvents) {
        const eventShortName = String(se.event || '').split('\\').pop() || '';
        if (eventShortName.length < 4 || /^(method|methods|event|events|priority)$/i.test(eventShortName)) continue;
        const existingNode = nodes.find(node => node.name === eventShortName || node.name === se.event);
        let eventNodeId = existingNode?.id;
        if (!eventNodeId) {
          eventNodeId = this.sanitizeId(se.event);
          if (!nodes.some(node => node.id === eventNodeId)) {
            nodes.push(this.createNode(
              eventNodeId,
              eventShortName,
              'event',
              undefined,
              subscriber.filePath,
              1,
              undefined,
              { attributes: { event_class: se.event, inferred_from: 'event-subscriber' } }
            ));
          }
        }
        edges.push(this.createEdge(
          this.generateEdgeId(subscriberId, eventNodeId, 'listens_to'),
          subscriberId,
          eventNodeId,
          'listens_to',
          'behavioral',
          { attributes: { event: se.event, method: se.method, priority: se.priority } }
        ));
      }
    }

    for (const migration of migrations) {
      const migrationId = this.generateId('migration', migration.filePath, migration.name);
      for (const sql of migration.sqlStatements) {
        const tableMatch = sql.match(/(?:CREATE|ALTER|DROP)\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(\w+)/i);
        if (tableMatch) {
          const tableName = tableMatch[1];
          const matchingEntity = entities.find(e =>
            (e.table && e.table === tableName) ||
            e.name.toLowerCase() === tableName.toLowerCase()
          );
          if (matchingEntity) {
            const entityId = this.generateId('entity', matchingEntity.filePath, matchingEntity.name);
            edges.push(this.createEdge(
              this.generateEdgeId(migrationId, entityId, 'modifies'),
              migrationId,
              entityId,
              'modifies',
              'data'
            ));
          }
        }
      }
    }

    for (const template of templates) {
      const templateId = this.generateId('template', template.filePath, template.name);

      if (template.extends) {
        const parentTemplate = templates.find(t =>
          t.filePath.endsWith(template.extends!) || t.name === template.extends
        );
        if (parentTemplate) {
          const parentId = this.generateId('template', parentTemplate.filePath, parentTemplate.name);
          edges.push(this.createEdge(
            this.generateEdgeId(templateId, parentId, 'extends'),
            templateId,
            parentId,
            'extends',
            'structural'
          ));
        }
      }

      for (const includePath of template.includes) {
        const includedTemplate = templates.find(t =>
          t.filePath.endsWith(includePath) || t.name === includePath
        );
        if (includedTemplate) {
          const includeId = this.generateId('template', includedTemplate.filePath, includedTemplate.name);
          edges.push(this.createEdge(
            this.generateEdgeId(templateId, includeId, 'includes'),
            templateId,
            includeId,
            'includes',
            'structural'
          ));
        }
      }
    }
  }

  private async identifyExitPoints(
    entities: SymfonyEntity[],
    repositories: SymfonyRepository[],
    services: SymfonyService[],
    messageHandlers: SymfonyMessageHandler[],
    phpFiles: string[],
    projectPath: string,
    exitPoints: CASExitPoint[]
  ): Promise<void> {
    if (entities.length > 0 || repositories.length > 0) {
      exitPoints.push(this.createExitPoint(
        'exit_symfony_database',
        'symfony_app',
        'database',
        'Database Connection',
        'Database operations through Doctrine ORM',
        { service_id: 'database-service', resource: 'database' },
        { action: 'read-write', async: false },
        { type: 'Doctrine ORM', entities: entities.map(e => e.name) }
      ));
    }

    let hasHttpClient = false;
    let hasCacheUsage = false;
    let hasMailer = false;

    for (const file of phpFiles) {
      try {
        const content = await this.readProjectFile(projectPath, file);

        if (content.includes('HttpClientInterface') || content.includes('Symfony\\Component\\HttpClient')) {
          hasHttpClient = true;
        }
        if (content.includes('CacheInterface') || content.includes('Symfony\\Contracts\\Cache')) {
          hasCacheUsage = true;
        }
        if (content.includes('MailerInterface') || content.includes('Symfony\\Component\\Mailer')) {
          hasMailer = true;
        }

        if (hasHttpClient && hasCacheUsage && hasMailer) break;
      } catch {
        continue;
      }
    }

    if (hasHttpClient) {
      exitPoints.push(this.createExitPoint(
        'exit_symfony_http_client',
        'symfony_app',
        'api',
        'HTTP Client',
        'External HTTP API connections via Symfony HttpClient',
        { service_id: 'external-api', endpoint: 'various' },
        { action: 'read-write', async: true },
        { type: 'Symfony HttpClient' }
      ));
    }

    if (messageHandlers.length > 0) {
      exitPoints.push(this.createExitPoint(
        'exit_symfony_messenger',
        'symfony_app',
        'message',
        'Message Bus',
        'Async message processing through Symfony Messenger',
        { service_id: 'message-bus', resource: 'messenger' },
        { action: 'write', async: true },
        { type: 'Symfony Messenger', handlers: messageHandlers.map(h => h.name) }
      ));
    }

    if (hasCacheUsage) {
      exitPoints.push(this.createExitPoint(
        'exit_symfony_cache',
        'symfony_app',
        'cache',
        'Cache',
        'Cache operations through Symfony Cache',
        { service_id: 'cache-service', resource: 'cache' },
        { action: 'read-write', async: false },
        { type: 'Symfony Cache' }
      ));
    }

    if (hasMailer) {
      exitPoints.push(this.createExitPoint(
        'exit_symfony_mailer',
        'symfony_app',
        'api',
        'Mailer',
        'Email sending through Symfony Mailer',
        { service_id: 'mailer-service', resource: 'mailer' },
        { action: 'write', async: true },
        { type: 'Symfony Mailer' }
      ));
    }
  }

  private extractDocumentation(content: string): CASDocumentation | undefined {
    const docBlockPattern = /\/\*\*\s*\n([\s\S]*?)\*\//;
    const match = content.match(docBlockPattern);
    if (!match) return undefined;

    const raw = match[0];
    const lines = match[1].split('\n').map(l => l.replace(/^\s*\*\s?/, '').trim()).filter(l => l.length > 0);

    const summaryLines = lines.filter(l => !l.startsWith('@'));
    const summary = summaryLines[0] || undefined;
    const description = summaryLines.length > 1 ? summaryLines.join('\n') : summary;

    if (!summary) return undefined;

    const startLine = this.lineNumberAt(content, match.index || 0);
    const endLine = startLine + raw.split('\n').length - 1;

    return {
      type: 'phpdoc',
      raw,
      summary,
      description,
      location: { start_line: startLine, end_line: endLine },
      framework_docs: {}
    };
  }

  private extractComments(content: string, filePath: string): CASComment[] {
    const comments: CASComment[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();

      if (trimmed.startsWith('//') || trimmed.startsWith('#')) {
        const text = trimmed.substring(trimmed.startsWith('//') ? 2 : 1).trim();
        if (text.length > 0) {
          comments.push({
            id: `comment_${++this.commentCounter}`,
            type: 'single-line',
            style: trimmed.startsWith('//') ? '//' : '#',
            text,
            purpose: this.classifyCommentPurpose(text),
            location: { file: filePath, line: i + 1 },
            markers: {
              is_todo: text.toUpperCase().includes('TODO'),
              is_fixme: text.toUpperCase().includes('FIXME'),
              is_hack: text.toUpperCase().includes('HACK'),
              is_warning: text.toUpperCase().includes('WARNING'),
              is_note: text.toUpperCase().includes('NOTE')
            }
          });
        }
      }

      if (trimmed.includes('/*') && !trimmed.includes('/**')) {
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
          comments.push({
            id: `comment_${++this.commentCounter}`,
            type: 'multi-line',
            style: '/* */',
            text: commentText.trim(),
            purpose: this.classifyCommentPurpose(commentText.trim()),
            location: { file: filePath, line: i + 1 },
            markers: {
              is_todo: commentText.toUpperCase().includes('TODO'),
              is_fixme: commentText.toUpperCase().includes('FIXME'),
              is_hack: commentText.toUpperCase().includes('HACK'),
              is_warning: commentText.toUpperCase().includes('WARNING'),
              is_note: commentText.toUpperCase().includes('NOTE')
            }
          });
        }

        i = j - 1;
      }
    }

    return comments;
  }

  private extractTwigComments(content: string, filePath: string): CASComment[] {
    const comments: CASComment[] = [];
    const twigCommentPattern = /\{#\s*([\s\S]*?)\s*#\}/g;

    let match;
    while ((match = twigCommentPattern.exec(content)) !== null) {
      const text = match[1].trim();
      if (text.length > 0) {
        const line = this.lineNumberAt(content, match.index);
        comments.push({
          id: `comment_${++this.commentCounter}`,
          type: 'single-line',
          style: 'other',
          text,
          purpose: this.classifyCommentPurpose(text),
          location: { file: filePath, line },
          markers: {
            is_todo: text.toUpperCase().includes('TODO'),
            is_fixme: text.toUpperCase().includes('FIXME'),
            is_hack: text.toUpperCase().includes('HACK'),
            is_warning: text.toUpperCase().includes('WARNING'),
            is_note: text.toUpperCase().includes('NOTE')
          }
        });
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

        const assigneeMatch = text.match(/TODO\s*\(\s*([^)]+)\s*\)/i);
        const assignee = assigneeMatch ? assigneeMatch[1].trim() : undefined;

        const priorityMatch = text.match(/\[(CRITICAL|HIGH|MEDIUM|LOW)\]/i);
        const priority: CASTodo['priority'] = priorityMatch
          ? priorityMatch[1].toLowerCase() as CASTodo['priority']
          : 'medium';

        todos.push({
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
        });
      }
    }

    return todos;
  }

  private determineImplementationStatus(content: string, comments: CASComment[]): CASImplementationStatus {
    const indicators = {
      has_todo_markers: comments.some(c => c.markers?.is_todo),
      has_not_implemented_exceptions: content.includes('throw new NotImplementedException') || content.includes('// TODO: implement'),
      has_stub_returns: content.includes('return null;') || content.includes('return [];') || content.includes("return '';"),
      has_placeholder_code: content.includes('// TODO') || content.includes('// FIXME') || content.includes('// PLACEHOLDER'),
      has_hardcoded_values: /['"](localhost|127\.0\.0\.1|test|example|demo|placeholder)['"]/.test(content),
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

    const missingFeatures: string[] = [];
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
    const upper = text.toUpperCase();
    if (upper.includes('TODO') || upper.includes('FIXME')) return 'todo';
    if (upper.includes('WARNING') || upper.includes('WARN')) return 'warning';
    if (upper.includes('HACK') || upper.includes('WORKAROUND')) return 'hack';
    if (upper.includes('NOTE') || upper.includes('INFO')) return 'note';
    if (upper.includes('DISABLED') || upper.includes('COMMENTED')) return 'disabled-code';
    return 'explanation';
  }

  private classifyTodoCategory(text: string): 'bug' | 'feature' | 'refactor' | 'performance' | 'security' | 'documentation' | 'test' | undefined {
    const lower = text.toLowerCase();
    if (lower.includes('bug') || lower.includes('fix') || lower.includes('error')) return 'bug';
    if (lower.includes('security') || lower.includes('auth') || lower.includes('permission')) return 'security';
    if (lower.includes('performance') || lower.includes('optimize') || lower.includes('slow')) return 'performance';
    if (lower.includes('test') || lower.includes('spec') || lower.includes('coverage')) return 'test';
    if (lower.includes('refactor') || lower.includes('cleanup') || lower.includes('reorganize')) return 'refactor';
    if (lower.includes('doc') || lower.includes('comment') || lower.includes('explain')) return 'documentation';
    return 'feature';
  }
}
