import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, CASPerspective
} from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';
import { glob } from 'glob';

interface AspNetController {
  name: string;
  filePath: string;
  basePath: string;
  routes: AspNetRoute[];
  filters: string[];
  dependencies: string[];
  isApiController: boolean;
}

interface AspNetRoute {
  method: string;
  path: string;
  handlerName: string;
  parameters: Array<{ name: string; source: string; type: string }>;
  returnType?: string;
  attributes: string[];
  produces?: string;
  consumes?: string;
}

interface AspNetMiddleware {
  name: string;
  filePath: string;
  order: number;
  invokesNext: boolean;
}

interface AspNetService {
  name: string;
  filePath: string;
  interfaces: string[];
  lifetime: 'singleton' | 'scoped' | 'transient' | 'unknown';
  methods: Array<{ name: string; returnType?: string; parameters: string[] }>;
}

interface AspNetDbContext {
  name: string;
  filePath: string;
  dbSets: Array<{ name: string; entityType: string }>;
  connectionString?: string;
}

interface AspNetHub {
  name: string;
  filePath: string;
  methods: Array<{ name: string; parameters: string[] }>;
  route?: string;
}

interface AspNetMinimalEndpoint {
  method: string;
  path: string;
  filePath: string;
  line: number;
  handlerType: 'inline' | 'method-group' | 'delegate';
}

export class AspNetCoreAnalyzer extends BaseAnalyzer {
  constructor() {
    super(
      'aspnet-core',
      'ASP.NET Core Framework Analyzer',
      '1.0.0',
      'framework'
    );
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const csprojFiles = await glob(['**/*.csproj'], {
        cwd: projectPath,
        ignore: ['**/bin/**', '**/obj/**', '**/.git/**', '**/packages/**', '**/node_modules/**']
      });

      for (const csproj of csprojFiles) {
        const content = await fs.readFile(path.join(projectPath, csproj), 'utf-8');
        if (this.detectAspNetProject(content)) {
          return true;
        }
      }

      const csFiles = await glob(['**/*.cs'], {
        cwd: projectPath,
        ignore: ['**/bin/**', '**/obj/**', '**/.git/**', '**/packages/**', '**/node_modules/**']
      });

      for (const csFile of csFiles.slice(0, 20)) {
        const content = await fs.readFile(path.join(projectPath, csFile), 'utf-8');
        if (/using\s+Microsoft\.AspNetCore/.test(content) ||
            /\[ApiController\]/.test(content) ||
            /WebApplication\.Create/.test(content)) {
          return true;
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  private detectAspNetProject(csprojContent: string): boolean {
    const aspnetIndicators = [
      /Microsoft\.AspNetCore/,
      /Microsoft\.NET\.Sdk\.Web/,
      /<Project\s+Sdk="Microsoft\.NET\.Sdk\.Web"/,
      /Swashbuckle\.AspNetCore/,
      /Microsoft\.EntityFrameworkCore/,
      /Microsoft\.AspNetCore\.Mvc/,
      /Microsoft\.AspNetCore\.SignalR/
    ];

    return aspnetIndicators.some(pattern => pattern.test(csprojContent));
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const newNodes: CASNode[] = [];
    const enhancedNodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const perspectives: CASPerspective[] = [];

    const existingNodes = context.existingAnalysis?.[0]?.nodes || [];

    try {
      const ignorePatterns = [
        '**/bin/**', '**/obj/**', '**/.git/**', '**/packages/**',
        '**/node_modules/**', '**/Migrations/**', '**/TestResults/**'
      ];

      const csFiles = await glob(['**/*.cs'], {
        cwd: context.projectPath,
        ignore: ignorePatterns
      });

      const controllers = await this.analyzeControllers(csFiles, context.projectPath, existingNodes, newNodes, enhancedNodes, edges, entryPoints);
      const minimalEndpoints = await this.analyzeMinimalApis(csFiles, context.projectPath, newNodes, edges, entryPoints);
      const middleware = await this.analyzeMiddleware(csFiles, context.projectPath, existingNodes, newNodes, enhancedNodes, edges);
      const services = await this.analyzeServices(csFiles, context.projectPath, existingNodes, newNodes, enhancedNodes, edges);
      const dbContexts = await this.analyzeDbContexts(csFiles, context.projectPath, existingNodes, newNodes, enhancedNodes, edges, exitPoints);
      const hubs = await this.analyzeSignalRHubs(csFiles, context.projectPath, existingNodes, newNodes, enhancedNodes, edges, entryPoints);

      this.buildDependencyInjectionRelationships(controllers, services, dbContexts, edges);
      this.buildMiddlewarePipeline(middleware, edges);
      this.analyzeStartupConfiguration(csFiles, context.projectPath, services);

      this.createPerspectives(perspectives, controllers, services, dbContexts, middleware, hubs, minimalEndpoints);

      const contributedNodes = [...enhancedNodes, ...newNodes];

      const contribution = this.createContribution(contributedNodes, edges, entryPoints, exitPoints, {
        framework_specific: {
          controllers_detected: controllers.length,
          minimal_endpoints: minimalEndpoints.length,
          middleware_detected: middleware.length,
          services_detected: services.length,
          db_contexts_detected: dbContexts.length,
          signalr_hubs: hubs.length,
          total_routes: controllers.reduce((acc, c) => acc + c.routes.length, 0) + minimalEndpoints.length,
          nodes_enhanced: enhancedNodes.length,
          nodes_created: newNodes.length
        }
      });

      contribution.perspectives = perspectives;
      contribution.provided_perspectives = perspectives.map(p => p.id);

      return contribution;
    } catch (error) {
      throw new AnalyzerError(
        `ASP.NET Core analysis failed: ${(error as Error).message}`,
        'ASPNET_CORE_ANALYSIS_ERROR'
      );
    }
  }

  private async analyzeControllers(
    csFiles: string[],
    projectPath: string,
    existingNodes: CASNode[],
    newNodes: CASNode[],
    enhancedNodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): Promise<AspNetController[]> {
    const controllers: AspNetController[] = [];

    for (const file of csFiles) {
      const fullPath = path.join(projectPath, file);
      try {
        const content = await fs.readFile(fullPath, 'utf-8');

        const isApiController = /\[ApiController\]/.test(content);
        const controllerPattern = /(?:\[(?:Route|ApiController|Controller)\([^\)]*\)\]\s*)*(?:public\s+)?class\s+(\w+Controller)\s*:\s*([\w.<>,\s]+)/g;
        let match;

        while ((match = controllerPattern.exec(content)) !== null) {
          const controllerName = match[1];
          const baseTypes = match[2];

          const isControllerBase = /Controller(?:Base)?/.test(baseTypes);
          if (!isControllerBase) continue;

          const basePath = this.extractRoutePrefix(content, controllerName);
          const routes = this.extractRoutes(content, basePath);
          const filters = this.extractFilters(content);
          const dependencies = this.extractConstructorDependencies(content, controllerName);

          const controllerInfo: AspNetController = {
            name: controllerName,
            filePath: file,
            basePath,
            routes,
            filters,
            dependencies,
            isApiController
          };

          controllers.push(controllerInfo);

          const controllerId = this.generateId('controller', file, controllerName);

          const existingNode = existingNodes.find(n =>
            n.name === controllerName && n.type === 'class'
          );

          if (existingNode) {
            existingNode.type = 'controller';
            if (!existingNode.metadata) existingNode.metadata = {};
            existingNode.metadata.attributes = {
              ...existingNode.metadata.attributes,
              framework: 'aspnet-core',
              is_api_controller: isApiController,
              base_path: basePath,
              route_count: routes.length,
              filter_count: filters.length,
              dependency_count: dependencies.length,
              dependencies
            };
            if (!existingNode.analyzers) existingNode.analyzers = [];
            if (!existingNode.analyzers.includes(this.analyzerId)) {
              existingNode.analyzers.push(this.analyzerId);
            }
            enhancedNodes.push(existingNode);
          } else {
            const node = this.createNodeBuilder(controllerId, controllerName, 'controller')
              .withLevel(2, this.getLevelName(2))
              .withSource({ file: fullPath, line: this.findLineNumber(content, match[0]) })
              .withMetadata({
                framework: 'aspnet-core',
                attributes: {
                  is_api_controller: isApiController,
                  base_path: basePath,
                  route_count: routes.length,
                  filter_count: filters.length,
                  dependency_count: dependencies.length,
                  dependencies
                }
              })
              .withAnalyzers([this.analyzerId], this.analyzerId)
              .build();
            newNodes.push(node);
          }

          for (const route of routes) {
            const routeId = this.generateId('route', file, `${controllerName}_${route.method}_${route.handlerName}`);
            const routeNode = this.createNodeBuilder(routeId, `${route.method.toUpperCase()} ${route.path}`, 'route')
              .withLevel(3, this.getLevelName(3))
              .withSource({ file: fullPath })
              .withParent(controllerId)
              .withMetadata({
                framework: 'aspnet-core',
                attributes: {
                  http_method: route.method,
                  path: route.path,
                  handler: route.handlerName,
                  parameters: route.parameters,
                  return_type: route.returnType,
                  attributes: route.attributes
                }
              })
              .withAnalyzers([this.analyzerId], this.analyzerId)
              .build();
            newNodes.push(routeNode);

            edges.push(this.createEdgeBuilder(
              this.generateEdgeId(controllerId, routeId, 'has-route'),
              controllerId, routeId, 'has-route'
            ).build());

            entryPoints.push(this.createEntryPoint(
              this.generateId('entry', file, `${route.method}_${route.path}`),
              routeId,
              'http',
              `${route.method.toUpperCase()} ${route.path}`,
              `${controllerName}.${route.handlerName}`,
              { method: route.method.toUpperCase(), path: route.path },
              undefined,
              {
                framework: 'aspnet-core',
                http_method: route.method,
                path: route.path,
                controller: controllerName,
                handler: route.handlerName,
                parameters: route.parameters
              }
            ));
          }
        }
      } catch {}
    }

    return controllers;
  }

  private async analyzeMinimalApis(
    csFiles: string[],
    projectPath: string,
    newNodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): Promise<AspNetMinimalEndpoint[]> {
    const endpoints: AspNetMinimalEndpoint[] = [];

    for (const file of csFiles) {
      const fullPath = path.join(projectPath, file);
      try {
        const content = await fs.readFile(fullPath, 'utf-8');

        const minimalPattern = /app\.Map(Get|Post|Put|Delete|Patch)\s*\(\s*"([^"]+)"/g;
        let match;

        while ((match = minimalPattern.exec(content)) !== null) {
          const method = match[1].toLowerCase();
          const routePath = match[2];
          const line = this.findLineNumber(content, match[0]);

          const afterMatch = content.substring(match.index + match[0].length, match.index + match[0].length + 200);
          const handlerType: 'inline' | 'method-group' | 'delegate' =
            afterMatch.includes('=>') ? 'inline' :
            afterMatch.match(/,\s*\w+\.\w+/) ? 'method-group' : 'delegate';

          endpoints.push({
            method,
            path: routePath,
            filePath: file,
            line,
            handlerType
          });

          const endpointId = this.generateId('endpoint', file, `minimal_${method}_${routePath}`);
          const endpointNode = this.createNodeBuilder(endpointId, `${method.toUpperCase()} ${routePath}`, 'route')
            .withLevel(3, this.getLevelName(3))
            .withSource({ file: fullPath, line })
            .withMetadata({
              framework: 'aspnet-core',
              attributes: {
                api_style: 'minimal',
                http_method: method,
                path: routePath,
                handler_type: handlerType
              }
            })
            .withAnalyzers([this.analyzerId], this.analyzerId)
            .build();
          newNodes.push(endpointNode);

          entryPoints.push(this.createEntryPoint(
            this.generateId('entry', file, `minimal_${method}_${routePath}`),
            endpointId,
            'http',
            `${method.toUpperCase()} ${routePath}`,
            `Minimal API endpoint`,
            { method: method.toUpperCase(), path: routePath },
            undefined,
            {
              framework: 'aspnet-core',
              api_style: 'minimal',
              http_method: method,
              path: routePath
            }
          ));
        }
      } catch {}
    }

    return endpoints;
  }

  private async analyzeMiddleware(
    csFiles: string[],
    projectPath: string,
    existingNodes: CASNode[],
    newNodes: CASNode[],
    enhancedNodes: CASNode[],
    edges: CASEdge[]
  ): Promise<AspNetMiddleware[]> {
    const middlewareList: AspNetMiddleware[] = [];
    let order = 0;

    for (const file of csFiles) {
      const fullPath = path.join(projectPath, file);
      try {
        const content = await fs.readFile(fullPath, 'utf-8');

        const middlewarePattern = /class\s+(\w+(?:Middleware)?)\s*(?::\s*[\w.<>,\s]+)?\s*\{[^]*?(?:Invoke|InvokeAsync)\s*\(/g;
        let match;

        while ((match = middlewarePattern.exec(content)) !== null) {
          const middlewareName = match[1];
          const invokesNext = /(?:_next|next)\s*\.?\s*(?:Invoke|InvokeAsync|\()/.test(content);

          const middlewareInfo: AspNetMiddleware = {
            name: middlewareName,
            filePath: file,
            order: order++,
            invokesNext
          };

          middlewareList.push(middlewareInfo);

          const middlewareId = this.generateId('middleware', file, middlewareName);

          const existingNode = existingNodes.find(n =>
            n.name === middlewareName && n.type === 'class'
          );

          if (existingNode) {
            existingNode.type = 'middleware';
            if (!existingNode.metadata) existingNode.metadata = {};
            existingNode.metadata.attributes = {
              ...existingNode.metadata.attributes,
              framework: 'aspnet-core',
              pipeline_order: middlewareInfo.order,
              invokes_next: invokesNext
            };
            if (!existingNode.analyzers) existingNode.analyzers = [];
            if (!existingNode.analyzers.includes(this.analyzerId)) {
              existingNode.analyzers.push(this.analyzerId);
            }
            enhancedNodes.push(existingNode);
          } else {
            const node = this.createNodeBuilder(middlewareId, middlewareName, 'middleware')
              .withLevel(2, this.getLevelName(2))
              .withSource({ file: fullPath, line: this.findLineNumber(content, match[0]) })
              .withMetadata({
                framework: 'aspnet-core',
                attributes: {
                  pipeline_order: middlewareInfo.order,
                  invokes_next: invokesNext
                }
              })
              .withAnalyzers([this.analyzerId], this.analyzerId)
              .build();
            newNodes.push(node);
          }
        }
      } catch {}
    }

    return middlewareList;
  }

  private async analyzeServices(
    csFiles: string[],
    projectPath: string,
    existingNodes: CASNode[],
    newNodes: CASNode[],
    enhancedNodes: CASNode[],
    edges: CASEdge[]
  ): Promise<AspNetService[]> {
    const services: AspNetService[] = [];

    for (const file of csFiles) {
      const fullPath = path.join(projectPath, file);
      try {
        const content = await fs.readFile(fullPath, 'utf-8');

        const servicePattern = /class\s+(\w+(?:Service|Repository|Handler|Manager|Provider))\s*:\s*([\w.,\s<>]+)/g;
        let match;

        while ((match = servicePattern.exec(content)) !== null) {
          const serviceName = match[1];
          const baseTypes = match[2].split(',').map(t => t.trim());
          const interfaces = baseTypes.filter(t => t.startsWith('I'));
          const methods = this.extractServiceMethods(content, serviceName);

          const serviceInfo: AspNetService = {
            name: serviceName,
            filePath: file,
            interfaces,
            lifetime: 'unknown',
            methods
          };

          services.push(serviceInfo);

          const serviceId = this.generateId('service', file, serviceName);

          const existingNode = existingNodes.find(n =>
            n.name === serviceName && n.type === 'class'
          );

          if (existingNode) {
            existingNode.type = 'service';
            if (!existingNode.metadata) existingNode.metadata = {};
            existingNode.metadata.attributes = {
              ...existingNode.metadata.attributes,
              framework: 'aspnet-core',
              service_type: this.classifyServiceType(serviceName),
              interfaces,
              method_count: methods.length
            };
            if (!existingNode.analyzers) existingNode.analyzers = [];
            if (!existingNode.analyzers.includes(this.analyzerId)) {
              existingNode.analyzers.push(this.analyzerId);
            }
            enhancedNodes.push(existingNode);
          } else {
            const node = this.createNodeBuilder(serviceId, serviceName, 'service')
              .withLevel(2, this.getLevelName(2))
              .withSource({ file: fullPath, line: this.findLineNumber(content, match[0]) })
              .withMetadata({
                framework: 'aspnet-core',
                attributes: {
                  service_type: this.classifyServiceType(serviceName),
                  interfaces,
                  method_count: methods.length,
                  methods: methods.map(m => m.name)
                }
              })
              .withAnalyzers([this.analyzerId], this.analyzerId)
              .build();
            newNodes.push(node);
          }
        }
      } catch {}
    }

    return services;
  }

  private async analyzeDbContexts(
    csFiles: string[],
    projectPath: string,
    existingNodes: CASNode[],
    newNodes: CASNode[],
    enhancedNodes: CASNode[],
    edges: CASEdge[],
    exitPoints: CASExitPoint[]
  ): Promise<AspNetDbContext[]> {
    const dbContexts: AspNetDbContext[] = [];

    for (const file of csFiles) {
      const fullPath = path.join(projectPath, file);
      try {
        const content = await fs.readFile(fullPath, 'utf-8');

        const dbContextPattern = /class\s+(\w+)\s*:\s*(?:Microsoft\.EntityFrameworkCore\.)?DbContext\b/g;
        let match;

        while ((match = dbContextPattern.exec(content)) !== null) {
          const contextName = match[1];

          const dbSetPattern = /DbSet<(\w+)>\s+(\w+)/g;
          const dbSets: Array<{ name: string; entityType: string }> = [];
          let dbSetMatch;

          while ((dbSetMatch = dbSetPattern.exec(content)) !== null) {
            dbSets.push({
              entityType: dbSetMatch[1],
              name: dbSetMatch[2]
            });
          }

          const dbContextInfo: AspNetDbContext = {
            name: contextName,
            filePath: file,
            dbSets
          };

          dbContexts.push(dbContextInfo);

          const contextId = this.generateId('dbcontext', file, contextName);

          const existingNode = existingNodes.find(n =>
            n.name === contextName && n.type === 'class'
          );

          if (existingNode) {
            existingNode.type = 'database_context';
            if (!existingNode.metadata) existingNode.metadata = {};
            existingNode.metadata.attributes = {
              ...existingNode.metadata.attributes,
              framework: 'aspnet-core',
              orm: 'entity-framework-core',
              entity_count: dbSets.length,
              entities: dbSets.map(d => d.entityType)
            };
            if (!existingNode.analyzers) existingNode.analyzers = [];
            if (!existingNode.analyzers.includes(this.analyzerId)) {
              existingNode.analyzers.push(this.analyzerId);
            }
            enhancedNodes.push(existingNode);
          } else {
            const node = this.createNodeBuilder(contextId, contextName, 'database_context')
              .withLevel(2, this.getLevelName(2))
              .withSource({ file: fullPath, line: this.findLineNumber(content, match[0]) })
              .withMetadata({
                framework: 'aspnet-core',
                attributes: {
                  orm: 'entity-framework-core',
                  entity_count: dbSets.length,
                  entities: dbSets.map(d => ({ name: d.name, type: d.entityType }))
                }
              })
              .withAnalyzers([this.analyzerId], this.analyzerId)
              .build();
            newNodes.push(node);
          }

          for (const dbSet of dbSets) {
            exitPoints.push(this.createExitPoint(
              this.generateId('exit', file, `${contextName}_${dbSet.name}`),
              contextId,
              'database',
              `${contextName}.${dbSet.name}`,
              `Entity Framework DbSet<${dbSet.entityType}>`,
              { service_id: 'database', resource: dbSet.name },
              { action: 'crud', method: `DbSet<${dbSet.entityType}>` },
              {
                framework: 'aspnet-core',
                orm: 'entity-framework-core',
                entity: dbSet.entityType,
                db_set: dbSet.name
              }
            ));
          }

          for (const dbSet of dbSets) {
            const entityFile = csFiles.find(f => {
              const baseName = path.basename(f, '.cs');
              return baseName === dbSet.entityType || baseName === `${dbSet.entityType}Entity` || baseName === `${dbSet.entityType}Model`;
            });

            if (entityFile) {
              const entityFullPath = path.join(projectPath, entityFile);
              try {
                const entityContent = await fs.readFile(entityFullPath, 'utf-8');
                const relationships = this.extractEntityRelationships(entityContent, dbSet.entityType, dbSets);

                for (const rel of relationships) {
                  const sourceEntityId = this.generateId('entity', file, `${contextName}_${dbSet.name}`);
                  const targetDbSet = dbSets.find(d => d.entityType === rel.targetEntity);
                  if (targetDbSet) {
                    const targetEntityId = this.generateId('entity', file, `${contextName}_${targetDbSet.name}`);
                    edges.push(this.createEdgeBuilder(
                      this.generateEdgeId(sourceEntityId, targetEntityId, `fk-${rel.propertyName}`),
                      contextId, contextId, 'entity-relationship'
                    ).withMetadata({
                      attributes: {
                        relationship_type: rel.type,
                        source_entity: dbSet.entityType,
                        target_entity: rel.targetEntity,
                        property_name: rel.propertyName,
                        inverse_property: rel.inverseProperty,
                        is_collection: rel.isCollection
                      }
                    }).build());
                  }
                }
              } catch {}
            }
          }
        }
      } catch {}
    }

    return dbContexts;
  }

  private async analyzeSignalRHubs(
    csFiles: string[],
    projectPath: string,
    existingNodes: CASNode[],
    newNodes: CASNode[],
    enhancedNodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): Promise<AspNetHub[]> {
    const hubs: AspNetHub[] = [];

    for (const file of csFiles) {
      const fullPath = path.join(projectPath, file);
      try {
        const content = await fs.readFile(fullPath, 'utf-8');

        const hubPattern = /class\s+(\w+)\s*:\s*Hub(?:<\w+>)?\b/g;
        let match;

        while ((match = hubPattern.exec(content)) !== null) {
          const hubName = match[1];
          const methods = this.extractHubMethods(content);

          const hubInfo: AspNetHub = {
            name: hubName,
            filePath: file,
            methods
          };

          hubs.push(hubInfo);

          const hubId = this.generateId('hub', file, hubName);

          const existingNode = existingNodes.find(n =>
            n.name === hubName && n.type === 'class'
          );

          if (existingNode) {
            existingNode.type = 'websocket_hub';
            if (!existingNode.metadata) existingNode.metadata = {};
            existingNode.metadata.attributes = {
              ...existingNode.metadata.attributes,
              framework: 'aspnet-core',
              technology: 'signalr',
              method_count: methods.length,
              methods: methods.map(m => m.name)
            };
            if (!existingNode.analyzers) existingNode.analyzers = [];
            if (!existingNode.analyzers.includes(this.analyzerId)) {
              existingNode.analyzers.push(this.analyzerId);
            }
            enhancedNodes.push(existingNode);
          } else {
            const node = this.createNodeBuilder(hubId, hubName, 'websocket_hub')
              .withLevel(2, this.getLevelName(2))
              .withSource({ file: fullPath, line: this.findLineNumber(content, match[0]) })
              .withMetadata({
                framework: 'aspnet-core',
                attributes: {
                  technology: 'signalr',
                  method_count: methods.length,
                  methods: methods.map(m => m.name)
                }
              })
              .withAnalyzers([this.analyzerId], this.analyzerId)
              .build();
            newNodes.push(node);
          }

          for (const method of methods) {
            entryPoints.push(this.createEntryPoint(
              this.generateId('entry', file, `hub_${hubName}_${method.name}`),
              hubId,
              'websocket',
              `${hubName}.${method.name}`,
              `SignalR Hub method`,
              { event: 'websocket-message', method: method.name },
              undefined,
              {
                framework: 'aspnet-core',
                technology: 'signalr',
                hub: hubName,
                method: method.name
              }
            ));
          }
        }
      } catch {}
    }

    return hubs;
  }

  private buildDependencyInjectionRelationships(
    controllers: AspNetController[],
    services: AspNetService[],
    dbContexts: AspNetDbContext[],
    edges: CASEdge[]
  ): void {
    for (const controller of controllers) {
      const controllerId = this.generateId('controller', controller.filePath, controller.name);

      for (const dep of controller.dependencies) {
        const service = services.find(s =>
          s.name === dep || s.interfaces.includes(dep)
        );

        if (service) {
          const serviceId = this.generateId('service', service.filePath, service.name);
          edges.push(this.createEdgeBuilder(
            this.generateEdgeId(controllerId, serviceId, 'injects'),
            controllerId, serviceId, 'injects'
          ).withMetadata({ attributes: { relationship: 'dependency-injection', injected_type: dep } }).build());
        }

        const dbContext = dbContexts.find(d => d.name === dep);
        if (dbContext) {
          const contextId = this.generateId('dbcontext', dbContext.filePath, dbContext.name);
          edges.push(this.createEdgeBuilder(
            this.generateEdgeId(controllerId, contextId, 'injects'),
            controllerId, contextId, 'injects'
          ).withMetadata({ attributes: { relationship: 'dependency-injection', injected_type: dep } }).build());
        }
      }
    }

    for (const service of services) {
      const serviceId = this.generateId('service', service.filePath, service.name);

      for (const dbContext of dbContexts) {
        const contextId = this.generateId('dbcontext', dbContext.filePath, dbContext.name);
        const serviceNameLower = service.name.toLowerCase();

        if (serviceNameLower.includes('repository') || serviceNameLower.includes('data')) {
          edges.push(this.createEdgeBuilder(
            this.generateEdgeId(serviceId, contextId, 'uses'),
            serviceId, contextId, 'uses'
          ).withMetadata({ attributes: { relationship: 'data-access' } }).build());
        }
      }
    }
  }

  private buildMiddlewarePipeline(middleware: AspNetMiddleware[], edges: CASEdge[]): void {
    const sorted = [...middleware].sort((a, b) => a.order - b.order);

    for (let i = 0; i < sorted.length - 1; i++) {
      const current = sorted[i];
      const next = sorted[i + 1];

      if (current.invokesNext) {
        const currentId = this.generateId('middleware', current.filePath, current.name);
        const nextId = this.generateId('middleware', next.filePath, next.name);

        edges.push(this.createEdgeBuilder(
          this.generateEdgeId(currentId, nextId, 'pipeline-next'),
          currentId, nextId, 'pipeline-next'
        ).withMetadata({ attributes: { pipeline_order: current.order } }).build());
      }
    }
  }

  private async analyzeStartupConfiguration(
    csFiles: string[],
    projectPath: string,
    services: AspNetService[]
  ): Promise<void> {
    for (const file of csFiles) {
      const fullPath = path.join(projectPath, file);
      try {
        const content = await fs.readFile(fullPath, 'utf-8');

        const singletonPattern = /AddSingleton<(\w+)(?:,\s*(\w+))?>/g;
        const scopedPattern = /AddScoped<(\w+)(?:,\s*(\w+))?>/g;
        const transientPattern = /AddTransient<(\w+)(?:,\s*(\w+))?>/g;

        let match;
        while ((match = singletonPattern.exec(content)) !== null) {
          const implName = match[2] || match[1];
          const svc = services.find(s => s.name === implName);
          if (svc) svc.lifetime = 'singleton';
        }
        while ((match = scopedPattern.exec(content)) !== null) {
          const implName = match[2] || match[1];
          const svc = services.find(s => s.name === implName);
          if (svc) svc.lifetime = 'scoped';
        }
        while ((match = transientPattern.exec(content)) !== null) {
          const implName = match[2] || match[1];
          const svc = services.find(s => s.name === implName);
          if (svc) svc.lifetime = 'transient';
        }
      } catch {}
    }
  }

  private createPerspectives(
    perspectives: CASPerspective[],
    controllers: AspNetController[],
    services: AspNetService[],
    dbContexts: AspNetDbContext[],
    middleware: AspNetMiddleware[],
    hubs: AspNetHub[],
    minimalEndpoints: AspNetMinimalEndpoint[]
  ): void {
    perspectives.push({
      id: 'aspnet-core-mvc',
      name: 'ASP.NET Core MVC Architecture',
      description: 'Controllers, services, and data access layer',
      analyzer_id: this.analyzerId,
      type: 'structure',
      connection_rules: {
        visible_node_types: ['controller', 'route', 'service', 'database_context', 'middleware', 'websocket_hub']
      },
      layout_hints: {
        style: 'hierarchical',
        direction: 'TB',
        group_by: 'layer'
      }
    });

    if (controllers.length > 0 || minimalEndpoints.length > 0) {
      perspectives.push({
        id: 'aspnet-core-api',
        name: 'ASP.NET Core API Endpoints',
        description: 'HTTP endpoints and their handlers',
        analyzer_id: this.analyzerId,
        type: 'flow',
        connection_rules: {
          visible_node_types: ['controller', 'route']
        },
        layout_hints: {
          style: 'hierarchical',
          direction: 'LR',
          group_by: 'type'
        }
      });
    }

    if (middleware.length > 0) {
      perspectives.push({
        id: 'aspnet-core-pipeline',
        name: 'ASP.NET Core Request Pipeline',
        description: 'Middleware pipeline and request processing',
        analyzer_id: this.analyzerId,
        type: 'flow',
        connection_rules: {
          visible_node_types: ['middleware']
        },
        layout_hints: {
          style: 'hierarchical',
          direction: 'LR',
          group_by: 'order'
        }
      });
    }
  }

  private extractRoutePrefix(content: string, controllerName: string): string {
    const routeAttrPattern = /\[Route\("([^"]+)"\)\]\s*(?:\[.*?\]\s*)*(?:public\s+)?class\s+/;
    const match = routeAttrPattern.exec(content);
    if (match) {
      return match[1].replace('[controller]', controllerName.replace(/Controller$/, '').toLowerCase());
    }
    return `/${controllerName.replace(/Controller$/, '').toLowerCase()}`;
  }

  private extractRoutes(content: string, basePath: string): AspNetRoute[] {
    const routes: AspNetRoute[] = [];

    const methodPattern = /\[(Http(?:Get|Post|Put|Delete|Patch|Options|Head))(?:\("([^"]*)"\))?\]\s*(?:\[.*?\]\s*)*(?:public\s+)?(?:async\s+)?(\w+(?:<[\w,\s]+>)?)\s+(\w+)\s*\(([^)]*)\)/g;
    let match;

    while ((match = methodPattern.exec(content)) !== null) {
      const httpAttr = match[1];
      const routeTemplate = match[2] || '';
      const returnType = match[3];
      const handlerName = match[4];
      const params = match[5];

      const method = httpAttr.replace('Http', '').toLowerCase();
      const fullPath = routeTemplate
        ? `${basePath}/${routeTemplate}`.replace(/\/+/g, '/')
        : basePath;

      const parameters = this.extractRouteParameters(params);
      const attributes = this.extractMethodAttributes(content, handlerName);

      routes.push({
        method,
        path: fullPath,
        handlerName,
        parameters,
        returnType,
        attributes
      });
    }

    return routes;
  }

  private extractRouteParameters(params: string): Array<{ name: string; source: string; type: string }> {
    const parameters: Array<{ name: string; source: string; type: string }> = [];
    if (!params.trim()) return parameters;

    const paramParts = params.split(',').map(p => p.trim()).filter(Boolean);

    for (const part of paramParts) {
      const fromBodyMatch = /\[FromBody\]\s*(\w+)\s+(\w+)/.exec(part);
      const fromQueryMatch = /\[FromQuery\]\s*(\w+)\s+(\w+)/.exec(part);
      const fromRouteMatch = /\[FromRoute\]\s*(\w+)\s+(\w+)/.exec(part);
      const simpleMatch = /(\w+)\s+(\w+)/.exec(part);

      if (fromBodyMatch) {
        parameters.push({ name: fromBodyMatch[2], source: 'body', type: fromBodyMatch[1] });
      } else if (fromQueryMatch) {
        parameters.push({ name: fromQueryMatch[2], source: 'query', type: fromQueryMatch[1] });
      } else if (fromRouteMatch) {
        parameters.push({ name: fromRouteMatch[2], source: 'route', type: fromRouteMatch[1] });
      } else if (simpleMatch) {
        parameters.push({ name: simpleMatch[2], source: 'auto', type: simpleMatch[1] });
      }
    }

    return parameters;
  }

  private extractMethodAttributes(content: string, methodName: string): string[] {
    const attributes: string[] = [];
    const attrPattern = new RegExp(`((?:\\[\\w+(?:\\([^)]*\\))?\\]\\s*)+)(?:public|private|protected|internal)\\s+(?:async\\s+)?\\w+\\s+${methodName}\\s*\\(`);
    const match = attrPattern.exec(content);

    if (match) {
      const attrBlock = match[1];
      const singleAttrPattern = /\[(\w+)/g;
      let attrMatch;
      while ((attrMatch = singleAttrPattern.exec(attrBlock)) !== null) {
        if (!attrMatch[1].startsWith('Http')) {
          attributes.push(attrMatch[1]);
        }
      }
    }

    return attributes;
  }

  private extractFilters(content: string): string[] {
    const filters: string[] = [];

    const filterPattern = /\[(?:ServiceFilter|TypeFilter)\(typeof\((\w+)\)\)\]/g;
    let match;
    while ((match = filterPattern.exec(content)) !== null) {
      filters.push(match[1]);
    }

    const authPattern = /\[Authorize(?:\(.*?\))?\]/g;
    while ((match = authPattern.exec(content)) !== null) {
      filters.push('Authorize');
    }

    return [...new Set(filters)];
  }

  private extractConstructorDependencies(content: string, className: string): string[] {
    const dependencies: string[] = [];

    const ctorPattern = new RegExp(`${className}\\s*\\(([^)]*)\\)`);
    const match = ctorPattern.exec(content);
    if (!match) return dependencies;

    const params = match[1].split(',').map(p => p.trim()).filter(Boolean);
    for (const param of params) {
      const typeMatch = /(?:I\w+|\w+)\s+\w+/.exec(param);
      if (typeMatch) {
        const typeName = param.split(/\s+/)[0];
        dependencies.push(typeName);
      }
    }

    return dependencies;
  }

  private extractHubMethods(content: string): Array<{ name: string; parameters: string[] }> {
    const methods: Array<{ name: string; parameters: string[] }> = [];

    const methodPattern = /public\s+(?:async\s+)?(?:Task|void)\s+(\w+)\s*\(([^)]*)\)/g;
    let match;

    while ((match = methodPattern.exec(content)) !== null) {
      const name = match[1];
      if (name === 'OnConnectedAsync' || name === 'OnDisconnectedAsync') continue;

      const params = match[2].trim();
      methods.push({
        name,
        parameters: params ? params.split(',').map(p => p.trim()) : []
      });
    }

    return methods;
  }

  private extractServiceMethods(content: string, className: string): Array<{ name: string; returnType?: string; parameters: string[] }> {
    const methods: Array<{ name: string; returnType?: string; parameters: string[] }> = [];

    const methodPattern = /(?:public|protected|internal)\s+(?:virtual\s+|override\s+|async\s+|static\s+)*(\w+(?:<[\w,\s]+>)?)\s+(\w+)\s*\(([^)]*)\)/g;
    let match;

    while ((match = methodPattern.exec(content)) !== null) {
      const returnType = match[1];
      const methodName = match[2];
      const params = match[3].trim();

      if (methodName === className || methodName === 'Dispose' || methodName === 'ToString') continue;

      methods.push({
        name: methodName,
        returnType,
        parameters: params ? params.split(',').map(p => p.trim()) : []
      });
    }

    return methods;
  }

  private extractEntityRelationships(
    content: string,
    entityName: string,
    dbSets: Array<{ name: string; entityType: string }>
  ): Array<{
    type: 'OneToOne' | 'OneToMany' | 'ManyToOne' | 'ManyToMany';
    targetEntity: string;
    propertyName: string;
    inverseProperty?: string;
    isCollection: boolean;
  }> {
    const relationships: Array<{
      type: 'OneToOne' | 'OneToMany' | 'ManyToOne' | 'ManyToMany';
      targetEntity: string;
      propertyName: string;
      inverseProperty?: string;
      isCollection: boolean;
    }> = [];

    const knownEntities = dbSets.map(d => d.entityType);

    const collectionPattern = /(?:public\s+)?(?:virtual\s+)?(?:ICollection|IList|List|IEnumerable|HashSet)<(\w+)>\s+(\w+)/g;
    let match;
    while ((match = collectionPattern.exec(content)) !== null) {
      const targetType = match[1];
      const propName = match[2];
      if (knownEntities.includes(targetType)) {
        relationships.push({
          type: 'OneToMany',
          targetEntity: targetType,
          propertyName: propName,
          isCollection: true
        });
      }
    }

    const navPropertyPattern = /(?:public\s+)?(?:virtual\s+)?(\w+)\s+(\w+)\s*\{\s*get\s*;\s*set\s*;\s*\}/g;
    while ((match = navPropertyPattern.exec(content)) !== null) {
      const targetType = match[1];
      const propName = match[2];
      if (knownEntities.includes(targetType) && !relationships.some(r => r.propertyName === propName)) {
        const hasFkAttribute = new RegExp(`\\[ForeignKey\\("${propName}"\\)\\]|\\[ForeignKey\\(nameof\\(${propName}\\)\\)\\]`).test(content);
        const hasFkProperty = new RegExp(`(?:public\\s+)?(?:int|long|Guid|string)\\??\\s+${propName}Id\\s`).test(content);

        relationships.push({
          type: (hasFkAttribute || hasFkProperty) ? 'ManyToOne' : 'OneToOne',
          targetEntity: targetType,
          propertyName: propName,
          isCollection: false
        });
      }
    }

    const inversePattern = /\[InverseProperty\("(\w+)"\)\]\s*(?:public\s+)?(?:virtual\s+)?(?:\w+<)?(\w+)>?\s+(\w+)/g;
    while ((match = inversePattern.exec(content)) !== null) {
      const inverseProp = match[1];
      const targetType = match[2];
      const propName = match[3];
      const existing = relationships.find(r => r.propertyName === propName);
      if (existing) {
        existing.inverseProperty = inverseProp;
      }
    }

    return relationships;
  }

  private extractFluentApiRelationships(
    content: string,
    dbSets: Array<{ name: string; entityType: string }>
  ): Array<{
    type: 'OneToOne' | 'OneToMany' | 'ManyToOne' | 'ManyToMany';
    sourceEntity: string;
    targetEntity: string;
    propertyName: string;
    isCollection: boolean;
  }> {
    const relationships: Array<{
      type: 'OneToOne' | 'OneToMany' | 'ManyToOne' | 'ManyToMany';
      sourceEntity: string;
      targetEntity: string;
      propertyName: string;
      isCollection: boolean;
    }> = [];

    const hasOnePattern = /\.HasOne<(\w+)>\s*\(\s*(?:\w+\s*=>\s*\w+\.(\w+))?\)/g;
    const hasManyPattern = /\.HasMany<(\w+)>\s*\(\s*(?:\w+\s*=>\s*\w+\.(\w+))?\)/g;

    let match;
    while ((match = hasOnePattern.exec(content)) !== null) {
      relationships.push({
        type: 'ManyToOne',
        sourceEntity: '',
        targetEntity: match[1],
        propertyName: match[2] || match[1],
        isCollection: false
      });
    }
    while ((match = hasManyPattern.exec(content)) !== null) {
      relationships.push({
        type: 'OneToMany',
        sourceEntity: '',
        targetEntity: match[1],
        propertyName: match[2] || match[1],
        isCollection: true
      });
    }

    return relationships;
  }

  private classifyServiceType(name: string): string {
    const lower = name.toLowerCase();
    if (lower.includes('repository') || lower.includes('repo')) return 'repository';
    if (lower.includes('handler')) return 'handler';
    if (lower.includes('manager')) return 'manager';
    if (lower.includes('provider')) return 'provider';
    return 'service';
  }

  private findLineNumber(content: string, searchStr: string): number {
    const index = content.indexOf(searchStr);
    if (index === -1) return 1;
    return content.substring(0, index).split('\n').length;
  }

  protected getCapabilities(): string[] {
    return [
      'controller-analysis',
      'route-detection',
      'minimal-api-detection',
      'middleware-analysis',
      'dependency-injection-detection',
      'entity-framework-detection',
      'signalr-hub-detection',
      'filter-analysis',
      'startup-configuration-analysis'
    ];
  }

  protected getLevelName(level: number): string {
    const levels: Record<number, string> = {
      1: 'system',
      2: 'architectural',
      3: 'code',
      4: 'member',
      5: 'implementation'
    };
    return levels[level] || 'unknown';
  }
}
