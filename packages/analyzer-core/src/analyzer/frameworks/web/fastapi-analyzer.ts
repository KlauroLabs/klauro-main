import { BaseAnalyzer, CASAnalysisResult, CASNode, CASEdge, AnalysisContext, FileAnalysisContext, FileAnalysisResult } from '../../core/base-analyzer';
import { maskPythonTripleQuotedStrings } from './python-source-text';
import {
  CASEntryPoint, CASExitPoint,
  CASPerspective
} from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';
import { fastApiDependencyNodeId, planFastAPIDependencyLinks } from './fastapi-dependency-resolver';
import { FastAPIAnalysisMetadata } from './fastapi-analysis-metadata';

interface FastAPIApplication {
  name: string;
  filePath: string;
  appVariable: string;
  title?: string;
  version?: string;
  description?: string;
  routers: string[];
  middleware: string[];
  dependencies: string[];
}

interface FastAPIRouter {
  name: string;
  filePath: string;
  prefix?: string;
  tags?: string[];
  dependencies: string[];
  routes: FastAPIRoute[];
}

interface FastAPIRouterMount {
  parentFile: string;
  childFile: string;
  prefix: string;
  prefixResolved: boolean;
}

interface FastAPIRoute {
  method: string;
  path: string;
  handlerName: string;
  handlerLine: number;
  handlerEndLine: number;
  isAsync: boolean;
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  dependencies: string[];
  parameters: Array<{ name: string; type: string; location: string; required: boolean; description?: string }>;
  requestBody?: { type: string; required: boolean; description?: string };
  responses: Array<{ status: number; type: string; description?: string }>;
  security?: string[];
}

interface HandlerCall {
  callee: string;
  callType: 'function' | 'method' | 'await' | 'dependency';
  line: number;
  isAsync: boolean;
  objectName?: string;
}

interface PydanticModel {
  name: string;
  filePath: string;
  baseClass: string;
  fields: Array<{ name: string; type: string; required: boolean; default?: any; description?: string; validators?: string[] }>;
  validators: Array<{ name: string; type: string; field?: string }>;
  config: Record<string, any>;
}

interface FastAPIDependency {
  name: string;
  filePath: string;
  type: 'function' | 'class';
  scope: 'singleton' | 'request' | 'call';
  dependencies: string[];
  returnType?: string;
}

interface FastAPIMiddleware {
  name: string;
  filePath: string;
  type: 'function' | 'class';
  order: number;
  methods: Array<{ name: string; parameters: string[]; returnType?: string }>;
}

interface FastAPIBackgroundTask {
  name: string;
  filePath: string;
  parameters: Array<{ name: string; type: string }>;
  description?: string;
}

interface FastAPIWebSocket {
  path: string;
  endpoint: string;
  dependencies: string[];
  description?: string;
}

export class FastAPIAnalyzer extends BaseAnalyzer {

  private readonly analysisMetadata: FastAPIAnalysisMetadata;

  constructor() {
    super(
      'fastapi',
      'FastAPI Framework Analyzer',
      '1.0.0',
      'framework'
    );
    this.analysisMetadata = new FastAPIAnalysisMetadata(this.analyzerId);
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const requirementsPath = path.join(projectPath, 'requirements.txt');
      const pipfilePath = path.join(projectPath, 'Pipfile');
      const pyprojectPath = path.join(projectPath, 'pyproject.toml');

      if (await fs.pathExists(requirementsPath)) {
        const requirements = await fs.readFile(requirementsPath, 'utf-8');
        if (requirements.includes('fastapi') || requirements.includes('FastAPI')) return true;
      }

      if (await fs.pathExists(pipfilePath)) {
        const pipfile = await fs.readFile(pipfilePath, 'utf-8');
        if (pipfile.includes('fastapi') || pipfile.includes('FastAPI')) return true;
      }

      if (await fs.pathExists(pyprojectPath)) {
        const pyproject = await fs.readFile(pyprojectPath, 'utf-8');



        if (this.pyprojectHasRealDependency(pyproject, 'fastapi')) return true;
      }

      const pythonFiles = await glob(['**/*.py'], {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true
      });

      for (const file of pythonFiles) {
        const content = await fs.readFile(path.join(projectPath, file), 'utf-8');





        if (
          /\bFastAPI\s*\(/.test(content) ||
          /\bAPIRouter\s*\(/.test(content) ||
          /@\s*(?:app|router)\.(?:get|post|put|delete|patch|options|head)\s*\(/.test(content)
        ) {
          return true;
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    return glob(['**/*.py'], {
      cwd: projectPath,
      ignore: [
        ...this.getIgnorePatterns({ projectPath }),
        '**/venv/**',
        '**/.venv/**',
        '**/env/**',
        '**/__pycache__/**'
      ],
      nodir: true
    });
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const file = context.relativePath;
    const content = await fs.readFile(context.filePath, 'utf-8');
    const stat = await fs.stat(context.filePath);

    const application = await this.analyzeApplication([file], context.projectPath, nodes);
    const routers = await this.analyzeRouters([file], context.projectPath, nodes, edges, entryPoints);
    const models = await this.analyzeModels([file], context.projectPath, nodes, edges);
    const dependencies = await this.analyzeDependencies([file], context.projectPath, nodes, edges);
    const middleware = await this.analyzeMiddleware([file], context.projectPath, nodes, edges);
    await this.analyzeBackgroundTasks([file], context.projectPath, nodes);
    await this.analyzeWebSockets([file], context.projectPath, nodes, entryPoints);

    this.buildFastAPIRelationships(application, routers, models, dependencies, middleware, nodes, edges);
    this.identifyDatabaseConnections(models, exitPoints);
    this.analysisMetadata.tagNodesWithPerspectives(nodes, edges);

    return this.createFileAnalysisResult(
      context.filePath,
      file,
      context.contentHash || this.computeContentHash(content),
      stat.mtimeMs,
      nodes,
      edges,
      entryPoints,
      exitPoints,
      this.extractPythonImports(content),
      [...new Set(nodes.map(node => node.name))]
    );
  }

  async analyze(context: AnalysisContext): Promise<CASAnalysisResult> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: any[] = [];
    const exitPoints: any[] = [];

    try {
      const pythonFiles = await glob(['**/*.py'], {
        cwd: context.projectPath,
        ignore: this.getIgnorePatterns(context),
        nodir: true
      });

      const application = await this.analyzeApplication(pythonFiles, context.projectPath, nodes);
      const routers = await this.analyzeRouters(pythonFiles, context.projectPath, nodes, edges, entryPoints);
      const models = await this.analyzeModels(pythonFiles, context.projectPath, nodes, edges);
      const dependencies = await this.analyzeDependencies(pythonFiles, context.projectPath, nodes, edges);
      const middleware = await this.analyzeMiddleware(pythonFiles, context.projectPath, nodes, edges);
      const backgroundTasks = await this.analyzeBackgroundTasks(pythonFiles, context.projectPath, nodes);
      const websockets = await this.analyzeWebSockets(pythonFiles, context.projectPath, nodes, entryPoints);

      this.buildFastAPIRelationships(application, routers, models, dependencies, middleware, nodes, edges);
      this.identifyDatabaseConnections(models, exitPoints);

      const perspectives: CASPerspective[] = [];
      this.analysisMetadata.createPerspectives(perspectives);
      this.analysisMetadata.tagNodesWithPerspectives(nodes, edges);

      const contribution = this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework: 'fastapi',
        version: await this.detectFastAPIVersion(context.projectPath),
        applicationFound: application !== null,
        routersFound: routers.length,
        modelsFound: models.length,
        dependenciesFound: dependencies.length,
        middlewareFound: middleware.length,
        backgroundTasksFound: backgroundTasks.length,
        websocketsFound: websockets.length,
        totalRoutes: routers.reduce((sum, router) => sum + router.routes.length, 0)
      });

      contribution.perspectives = perspectives;
      contribution.provided_perspectives = perspectives.map(p => p.id);

      return contribution;

    } catch (error) {
      throw new AnalyzerError(
        `FastAPI analysis failed: ${(error as Error).message}`,
        'FASTAPI_ANALYSIS_ERROR'
      );
    }
  }

  private async analyzeApplication(
    files: string[],
    projectPath: string,
    nodes: CASNode[]
  ): Promise<FastAPIApplication | null> {
    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('FastAPI(')) {
        const appVariable = this.extractAppVariable(content);
        if (appVariable) {
          const appInfo = this.extractAppInfo(content);
          const routers = this.extractRouterInclusions(content);
          const middleware = this.extractMiddlewareRegistrations(content);
          const dependencies = this.extractAppDependencies(content);

          const application: FastAPIApplication = {
            name: path.basename(file, '.py'),
            filePath: file,
            appVariable,
            title: appInfo.title,
            version: appInfo.version,
            description: appInfo.description,
            routers,
            middleware,
            dependencies
          };

          const appId = `app_${this.sanitizeId(application.name)}`;
          const documentation = this.analysisMetadata.extractDocumentation(content, fullPath);
          const comments = this.analysisMetadata.extractComments(content, fullPath);
          const todos = this.analysisMetadata.extractTodos(comments);
          const implementationStatus = this.analysisMetadata.determineImplementationStatus(content, comments);

          const appNode = this.createNodeBuilder(appId, application.name, 'application')
            .withLevel(1, 'system')
            .withCategory('application', ['framework', 'fastapi'])
            .withSource({ file: file, line: 1, end_line: content.split('\n').length })
            .withDescription(`FastAPI application: ${application.name}`)
            .withDocumentation(documentation)
            .withComments(comments)
            .withTodos(todos)
            .withImplementationStatus(implementationStatus)
            .withMetadata({
              framework: 'fastapi',
              attributes: {
                appVariable,
                title: appInfo.title,
                version: appInfo.version,
                description: appInfo.description,
                routers: routers.length,
                middleware: middleware.length,
                dependencies: dependencies.length
              }
            })
            .withAnalyzers([this.analyzerId], this.analyzerId)
            .build();
          nodes.push(appNode);

          return application;
        }
      }
    }
    return null;
  }

  private async analyzeRouters(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[]
  ): Promise<FastAPIRouter[]> {
    const routers: FastAPIRouter[] = [];
    const mountedPrefixesByFile = await this.resolveRouterMountPrefixes(files, projectPath);

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      const hasRouter = content.includes('APIRouter(') || content.includes('router = ');
      const hasAppRoutes = content.includes('FastAPI(') && /@\w+\.(get|post|put|delete|patch)\s*\(/i.test(content);

      if (hasRouter || hasAppRoutes) {
        const routerName = hasRouter ? this.extractRouterName(content, file) : this.extractAppName(content, file);
        const prefix = hasRouter ? this.extractRouterPrefix(content) : '';
        const mountedPrefixes = mountedPrefixesByFile.get(this.normalizePythonFile(file)) || [''];
        const exposedPrefixes = [...new Set(mountedPrefixes.map(mountedPrefix =>
          this.joinRoutePaths(mountedPrefix, prefix || '')))];
        const tags = this.extractRouterTags(content);
        const dependencies = this.extractRouterDependencies(content);
        const routes = this.extractRoutes(content);

        const router: FastAPIRouter = {
          name: routerName,
          filePath: file,
          prefix,
          tags,
          dependencies,
          routes
        };

        routers.push(router);

        const routerId = this.routerNodeId(routerName, file);
        const routerDocumentation = this.analysisMetadata.extractDocumentation(content, fullPath);
        const routerComments = this.analysisMetadata.extractComments(content, fullPath);
        const routerTodos = this.analysisMetadata.extractTodos(routerComments);
        const routerImplementationStatus = this.analysisMetadata.determineImplementationStatus(content, routerComments);

        const routerNode = this.createNodeBuilder(routerId, routerName, 'router')
          .withLevel(2, 'architectural')
          .withCategory('module', ['router'])
          .withSource({ file: file, line: 1, end_line: content.split('\n').length })
          .withDescription(`FastAPI router: ${routerName}`)
          .withDocumentation(routerDocumentation)
          .withComments(routerComments)
          .withTodos(routerTodos)
          .withImplementationStatus(routerImplementationStatus)
          .withMetadata({
            framework: 'fastapi',
            attributes: {
              prefix,
              mounted_prefixes: mountedPrefixes,
              exposed_prefixes: exposedPrefixes,
              tags,
              routes: routes.length,
              dependencies: dependencies.length
            }
          })
          .withAnalyzers([this.analyzerId], this.analyzerId)
          .build();
        nodes.push(routerNode);

        routes.forEach((route, index) => {
          const routeId = `route_${routerId}_${index}`;
          const handlerId = `handler_${routerId}_${this.sanitizeId(route.handlerName)}_${route.handlerLine}`;
          const fullRoutePaths = exposedPrefixes.map(exposedPrefix =>
            this.joinRoutePaths(exposedPrefix, route.path));
          const fullRoutePath = fullRoutePaths[0];

          const routeNode = this.createNodeBuilder(routeId, `${route.method.toUpperCase()} ${fullRoutePath}`, 'route')
            .withLevel(3, 'code')
            .withCategory('route', ['http', 'endpoint'])
            .withSource({ file: file, line: route.handlerLine - 1, end_line: route.handlerLine })
            .withDescription(`FastAPI HTTP endpoint: ${route.method.toUpperCase()} ${fullRoutePath}`)
            .withMetadata({
              framework: 'fastapi',
              attributes: {
                method: route.method,
                path: route.path,
                operationId: route.operationId,
                summary: route.summary,
                description: route.description,
                tags: route.tags,
                parameters: route.parameters.length,
                requestBody: route.requestBody,
                responses: route.responses.length,
                security: route.security,
                handlerName: route.handlerName
              }
            })
            .withAnalyzers([this.analyzerId], this.analyzerId)
            .build();
          nodes.push(routeNode);

          const handlerNode = this.createNodeBuilder(handlerId, route.handlerName, 'function')
            .withLevel(3, 'code')
            .withCategory('function', ['handler', 'endpoint'])
            .withSource({ file: file, line: route.handlerLine, end_line: route.handlerEndLine })
            .withDescription(`FastAPI route handler: ${route.handlerName}`)
            .withMetadata({
              framework: 'fastapi',
              attributes: {
                is_async: route.isAsync,
                route_method: route.method,
                route_path: fullRoutePath,
                parameters: route.parameters
              }
            })
            .withAnalyzers([this.analyzerId], this.analyzerId)
            .build();
          nodes.push(handlerNode);

          const lines = content.split('\n');
          const handlerCalls = this.extractHandlerCalls(lines, route.handlerLine - 1, route.handlerEndLine);

          const createdCalleeNodes = new Set<string>();
          for (const call of handlerCalls) {
            const calleeId = call.objectName
              ? `callee_${this.sanitizeId(call.objectName)}_${this.sanitizeId(call.callee)}`
              : `callee_${this.sanitizeId(call.callee)}`;

            if (!createdCalleeNodes.has(calleeId)) {
              createdCalleeNodes.add(calleeId);

              const calleeName = call.objectName ? `${call.objectName}.${call.callee}` : call.callee;
              const calleeNode = this.createNodeBuilder(calleeId, calleeName, 'function')
                .withLevel(4, 'member')
                .withCategory('function', call.callType === 'dependency' ? ['dependency'] : ['callee'])
                .withSource({ file: file, line: call.line })
                .withDescription(`Called by handler: ${route.handlerName}`)
                .withMetadata({
                  framework: 'fastapi',
                  attributes: {
                    is_async: call.isAsync,
                    call_type: call.callType,
                    object_name: call.objectName
                  }
                })
                .withAnalyzers([this.analyzerId], this.analyzerId)
                .build();
              nodes.push(calleeNode);
            }

            const isInjection = call.callType === 'dependency';
            const edgeType = isInjection ? 'depends_on' : 'calls';
            edges.push(this.createEdge(
              `${handlerId}_${edgeType}_${calleeId}_${call.line}`,
              handlerId,
              calleeId,
              edgeType,
              isInjection ? 'data' : undefined,


              isInjection ? { dependency_type: 'injection' } : undefined
            ));
          }

          edges.push(this.createEdge(
            `${routerId}_exposes_${routeId}`,
            routerId,
            routeId,
            'exposes'
          ));

          edges.push(this.createEdge(
            `${routeId}_calls_${handlerId}`,
            routeId,
            handlerId,
            'calls'
          ));

          entryPoints.push({
            id: `entry_${routeId}`,
            name: `${route.method.toUpperCase()} ${fullRoutePath}`,
            type: 'http',
            source_node: routeId,
            trigger: {
              method: route.method.toUpperCase(),
              path: fullRoutePath,
              parameters: route.parameters.map(p => ({
                name: p.name,
                type: p.location,
                required: p.required,
                location: p.location
              }))
            },
            handler: {
              node_id: handlerId,
              method_name: route.handlerName,
              file: file,
              line: route.handlerLine
            },
            security: {
              authenticated: route.security && route.security.length > 0,
              guards: route.security || [],
              roles: [],
              permissions: []
            },
            metadata: {
              framework: 'fastapi',
              router: routerName,
              operationId: route.operationId,
              summary: route.summary,
              tags: route.tags
            }
          });
          fullRoutePaths.slice(1).forEach((additionalPath, exposureIndex) => {
            const exposedRouteId = `${routeId}_mount_${exposureIndex + 1}`;
            nodes.push(this.createNodeBuilder(exposedRouteId, `${route.method.toUpperCase()} ${additionalPath}`, 'route')
              .withLevel(3, 'code')
              .withCategory('route', ['http', 'endpoint'])
              .withSource({ file, line: route.handlerLine - 1, end_line: route.handlerLine })
              .withDescription(`FastAPI HTTP endpoint: ${route.method.toUpperCase()} ${additionalPath}`)
              .withMetadata({
                framework: 'fastapi',
                attributes: {
                  method: route.method,
                  path: route.path,
                  operationId: route.operationId,
                  summary: route.summary,
                  description: route.description,
                  tags: route.tags,
                  parameters: route.parameters.length,
                  requestBody: route.requestBody,
                  responses: route.responses.length,
                  security: route.security,
                  handlerName: route.handlerName,
                  mountedPath: additionalPath
                }
              })
              .withAnalyzers([this.analyzerId], this.analyzerId)
              .build());
            edges.push(this.createEdge(
              `${routerId}_exposes_${exposedRouteId}`,
              routerId,
              exposedRouteId,
              'exposes'
            ));
            edges.push(this.createEdge(
              `${exposedRouteId}_calls_${handlerId}`,
              exposedRouteId,
              handlerId,
              'calls'
            ));
            entryPoints.push({
              id: `entry_${exposedRouteId}`,
              name: `${route.method.toUpperCase()} ${additionalPath}`,
              type: 'http',
              source_node: exposedRouteId,
              trigger: {
                method: route.method.toUpperCase(),
                path: additionalPath,
                parameters: route.parameters.map(parameter => ({
                  name: parameter.name,
                  type: parameter.location,
                  required: parameter.required,
                  location: parameter.location
                }))
              },
              handler: {
                node_id: handlerId,
                method_name: route.handlerName,
                file,
                line: route.handlerLine
              },
              security: {
                authenticated: route.security && route.security.length > 0,
                guards: route.security || [],
                roles: [],
                permissions: []
              },
              metadata: {
                framework: 'fastapi',
                router: routerName,
                operationId: route.operationId,
                summary: route.summary,
                tags: route.tags,
                mountedPath: additionalPath
              }
            });
          });
        });
      }
    }

    return routers;
  }

  private async analyzeModels(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<PydanticModel[]> {
    const models: PydanticModel[] = [];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('BaseModel') || content.includes('pydantic')) {
        const extractedModels = this.extractPydanticModels(content, file);
        models.push(...extractedModels);

        extractedModels.forEach(model => {
          const modelId = `model_${this.sanitizeId(model.name)}`;
          const modelDocumentation = this.analysisMetadata.extractDocumentation(content, fullPath);
          const modelComments = this.analysisMetadata.extractComments(content, fullPath);
          const modelTodos = this.analysisMetadata.extractTodos(modelComments);
          const modelImplementationStatus = this.analysisMetadata.determineImplementationStatus(content, modelComments);

          const modelNode = this.createNodeBuilder(modelId, model.name, 'model')
            .withLevel(3, 'code')
            .withCategory('model', ['data', 'entity'])
            .withSource({ file: file, line: 1, end_line: 1 })
            .withDescription(`Pydantic model: ${model.name}`)
            .withDocumentation(modelDocumentation)
            .withComments(modelComments)
            .withTodos(modelTodos)
            .withImplementationStatus(modelImplementationStatus)
            .withMetadata({
              framework: 'fastapi',
              attributes: {
                baseClass: model.baseClass,
                fields: model.fields.length,
                validators: model.validators.length,
                config: Object.keys(model.config).length
              }
            })
            .withAnalyzers([this.analyzerId], this.analyzerId)
            .build();
          nodes.push(modelNode);
        });
      }
    }

    return models;
  }

  private async analyzeDependencies(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<FastAPIDependency[]> {
    const dependencies: FastAPIDependency[] = [];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('Depends(') || content.includes('dependency')) {
        const extractedDeps = this.extractDependencies(content, file);
        dependencies.push(...extractedDeps);

        extractedDeps.forEach(dep => {
          const depId = fastApiDependencyNodeId(dep.filePath, dep.name);
          const depDocumentation = this.analysisMetadata.extractDocumentation(content, fullPath);
          const depComments = this.analysisMetadata.extractComments(content, fullPath);
          const depTodos = this.analysisMetadata.extractTodos(depComments);
          const depImplementationStatus = this.analysisMetadata.determineImplementationStatus(content, depComments);

          const dependencyNode = this.createNodeBuilder(depId, dep.name, 'service')
            .withLevel(3, 'code')
            .withCategory('service', ['injectable'])
            .withSource({ file: file, line: 1, end_line: 1 })
            .withDescription(`FastAPI dependency: ${dep.name}`)
            .withDocumentation(depDocumentation)
            .withComments(depComments)
            .withTodos(depTodos)
            .withImplementationStatus(depImplementationStatus)
            .withMetadata({
              framework: 'fastapi',
              attributes: {
                type: dep.type,
                scope: dep.scope,
                dependencies: dep.dependencies.length,
                returnType: dep.returnType
              }
            })
            .withAnalyzers([this.analyzerId], this.analyzerId)
            .build();
          nodes.push(dependencyNode);
        });
      }
    }

    return dependencies;
  }

  private async analyzeMiddleware(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<FastAPIMiddleware[]> {
    const middleware: FastAPIMiddleware[] = [];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('add_middleware') || content.includes('@middleware')) {
        const extractedMiddleware = this.extractMiddleware(content, file);
        middleware.push(...extractedMiddleware);

        extractedMiddleware.forEach(mw => {
          const middlewareId = `middleware_${this.sanitizeId(mw.name)}`;
          const middlewareDocumentation = this.analysisMetadata.extractDocumentation(content, fullPath);
          const middlewareComments = this.analysisMetadata.extractComments(content, fullPath);
          const middlewareTodos = this.analysisMetadata.extractTodos(middlewareComments);
          const middlewareImplementationStatus = this.analysisMetadata.determineImplementationStatus(content, middlewareComments);

          const middlewareNode = this.createNodeBuilder(middlewareId, mw.name, 'middleware')
            .withLevel(3, 'code')
            .withCategory('middleware', ['interceptor'])
            .withSource({ file: file, line: 1, end_line: 1 })
            .withDescription(`FastAPI middleware: ${mw.name}`)
            .withDocumentation(middlewareDocumentation)
            .withComments(middlewareComments)
            .withTodos(middlewareTodos)
            .withImplementationStatus(middlewareImplementationStatus)
            .withMetadata({
              framework: 'fastapi',
              attributes: {
                type: mw.type,
                order: mw.order,
                methods: mw.methods.map(m => m.name)
              }
            })
            .withAnalyzers([this.analyzerId], this.analyzerId)
            .build();
          nodes.push(middlewareNode);
        });
      }
    }

    return middleware;
  }

  private async analyzeBackgroundTasks(
    files: string[],
    projectPath: string,
    nodes: CASNode[]
  ): Promise<FastAPIBackgroundTask[]> {
    const backgroundTasks: FastAPIBackgroundTask[] = [];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('BackgroundTasks') || content.includes('background_task')) {
        const extractedTasks = this.extractBackgroundTasks(content, file);
        backgroundTasks.push(...extractedTasks);

        extractedTasks.forEach(task => {
          const taskId = `background_task_${this.sanitizeId(task.name)}`;
          const taskNode = this.createNodeBuilder(taskId, task.name, 'service')
            .withLevel(4, 'member')
            .withCategory('service', ['background'])
            .withSource({ file: file, line: 1, end_line: 1 })
            .withDescription(`FastAPI background task: ${task.name}`)
            .withMetadata({
              framework: 'fastapi',
              attributes: {
                parameters: task.parameters.length,
                description: task.description
              }
            })
            .withAnalyzers([this.analyzerId], this.analyzerId)
            .build();
          nodes.push(taskNode);
        });
      }
    }

    return backgroundTasks;
  }

  private async analyzeWebSockets(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    entryPoints: any[]
  ): Promise<FastAPIWebSocket[]> {
    const websockets: FastAPIWebSocket[] = [];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('@websocket') || content.includes('WebSocket')) {
        const extractedWebSockets = this.extractWebSockets(content);
        websockets.push(...extractedWebSockets);

        extractedWebSockets.forEach((ws, index) => {
          const wsId = `websocket_${this.sanitizeId(ws.endpoint)}_${index}`;
          const websocketNode = this.createNodeBuilder(wsId, `WebSocket ${ws.path}`, 'route')
            .withLevel(3, 'code')
            .withCategory('route', ['websocket', 'realtime'])
            .withSource({ file: file, line: 1, end_line: 1 })
            .withDescription(`FastAPI WebSocket endpoint: ${ws.path}`)
            .withMetadata({
              framework: 'fastapi',
              attributes: {
                path: ws.path,
                endpoint: ws.endpoint,
                dependencies: ws.dependencies.length,
                description: ws.description
              }
            })
            .withAnalyzers([this.analyzerId], this.analyzerId)
            .build();
          nodes.push(websocketNode);

          entryPoints.push({
            id: `entry_${wsId}`,
            name: `WebSocket ${ws.path}`,
            type: 'websocket',
            source_node: wsId,
            trigger: {
              protocol: 'websocket',
              path: ws.path,
              parameters: []
            },
            handler: {
              node_id: wsId,
              method_name: ws.endpoint,
              file: file,
              line: 0
            },
            security: {
              authenticated: false,
              guards: [],
              roles: [],
              permissions: []
            },
            metadata: {
              framework: 'fastapi',
              endpoint: ws.endpoint,
              dependencies: ws.dependencies
            }
          });
        });
      }
    }

    return websockets;
  }

  private extractAppVariable(content: string): string | null {
    const appPattern = /(\w+)\s*=\s*FastAPI\s*\(/;
    const match = appPattern.exec(content);
    return match ? match[1] : null;
  }

  private extractAppInfo(content: string): { title?: string; version?: string; description?: string } {
    const info: { title?: string; version?: string; description?: string } = {};

    const titleMatch = content.match(/title\s*=\s*['"]([^'"]+)['"]/);
    if (titleMatch) info.title = titleMatch[1];

    const versionMatch = content.match(/version\s*=\s*['"]([^'"]+)['"]/);
    if (versionMatch) info.version = versionMatch[1];

    const descriptionMatch = content.match(/description\s*=\s*['"]([^'"]+)['"]/);
    if (descriptionMatch) info.description = descriptionMatch[1];

    return info;
  }

  private extractRouterInclusions(content: string): string[] {
    const routers: string[] = [];
    const includePattern = /\.include_router\s*\(\s*(\w+)/g;

    let match;
    while ((match = includePattern.exec(content)) !== null) {
      routers.push(match[1]);
    }

    return routers;
  }

  private extractMiddlewareRegistrations(content: string): string[] {
    const middleware: string[] = [];
    const middlewarePattern = /\.add_middleware\s*\(\s*(\w+)/g;

    let match;
    while ((match = middlewarePattern.exec(content)) !== null) {
      middleware.push(match[1]);
    }

    return middleware;
  }

  private extractAppDependencies(content: string): string[] {
    const dependencies: string[] = [];
    const depPattern = /dependencies\s*=\s*\[([^\]]+)\]/;
    const match = depPattern.exec(content);

    if (match) {
      const deps = match[1].split(',').map(dep => dep.trim().replace(/Depends\s*\(\s*(\w+)\s*\)/, '$1'));
      dependencies.push(...deps);
    }

    return dependencies;
  }






  private routerNodeId(routerName: string, filePath: string): string {
    return `router_${this.sanitizeId(filePath)}_${this.sanitizeId(routerName)}`;
  }

  private extractRouterName(content: string, filePath: string): string {
    const routerPattern = /(\w+)\s*=\s*APIRouter\s*\(/;
    const match = routerPattern.exec(content);
    return match ? match[1] : path.basename(filePath, '.py');
  }

  private extractAppName(content: string, filePath: string): string {
    const appPattern = /(\w+)\s*=\s*FastAPI\s*\(/;
    const match = appPattern.exec(content);
    return match ? match[1] : path.basename(filePath, '.py');
  }

  private normalizePythonFile(filePath: string): string {
    return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  }

  private joinRoutePaths(...parts: Array<string | undefined>): string {
    const lastPart = [...parts].reverse().find((part): part is string => Boolean(part));
    const preserveTrailingSlash = Boolean(lastPart && /\/$/.test(lastPart));
    const joined = parts
      .filter((part): part is string => Boolean(part))
      .join('/')
      .replace(/\/{2,}/g, '/');
    if (!joined || joined === '/') return '/';
    const normalized = `/${joined.replace(/^\/+|\/+$/g, '')}`;
    return preserveTrailingSlash ? `${normalized}/` : normalized;
  }

  private extractBalancedCalls(rawContent: string, methodName: string): string[] { const content = maskPythonTripleQuotedStrings(rawContent);
    const calls: string[] = [];
    const pattern = new RegExp(`\\.\\s*${methodName}\\s*\\(`, 'g');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const opening = content.indexOf('(', match.index);
      let depth = 0;
      let quote = '';
      let escaped = false;
      for (let index = opening; index < content.length; index++) {
        const character = content[index];
        if (quote) {
          if (escaped) {
            escaped = false;
          } else if (character === '\\') {
            escaped = true;
          } else if (character === quote) {
            quote = '';
          }
          continue;
        }
        if (character === '"' || character === "'") {
          quote = character;
          continue;
        }
        if (character === '(') depth++;
        if (character === ')') {
          depth--;
          if (depth === 0) {
            calls.push(content.slice(match.index, index + 1));
            pattern.lastIndex = index + 1;
            break;
          }
        }
      }
    }
    return calls;
  }

  private resolvePythonModuleFile(
    importerFile: string,
    moduleName: string,
    importedName: string | undefined,
    knownFiles: Set<string>,
  ): string | undefined {
    const importerDirectory = path.posix.dirname(this.normalizePythonFile(importerFile));
    const relativePrefix = moduleName.match(/^\.+/)?.[0] || '';
    const remainingModule = moduleName.slice(relativePrefix.length);
    const baseSegments = relativePrefix
      ? importerDirectory.split('/').filter(Boolean).slice(0, Math.max(0, importerDirectory.split('/').filter(Boolean).length - Math.max(0, relativePrefix.length - 1)))
      : [];
    const moduleSegments = remainingModule.split('.').filter(Boolean);
    const absoluteSegments = [...baseSegments, ...moduleSegments];
    const candidates: string[] = [];
    if (importedName) {
      candidates.push(
        [...absoluteSegments, importedName].join('/') + '.py',
        [...absoluteSegments, importedName, '__init__.py'].join('/'),
      );
    }
    candidates.push(
      absoluteSegments.join('/') + '.py',
      [...absoluteSegments, '__init__.py'].join('/'),
    );

    for (const candidate of candidates.map(value => this.normalizePythonFile(value))) {
      if (knownFiles.has(candidate)) return candidate;
      const suffixMatches = [...knownFiles].filter(file => file.endsWith(`/${candidate}`));
      if (suffixMatches.length === 1) return suffixMatches[0];
    }
    return undefined;
  }

  private extractPythonImportAliases(
    content: string,
    importerFile: string,
    knownFiles: Set<string>,
  ): Map<string, string> {
    const aliases = new Map<string, string>();
    const flattened = content.replace(
      /^\s*from\s+([\w.]+)\s+import\s*\(([\s\S]*?)\)/gm,
      (_match, moduleName: string, imports: string) =>
        `from ${moduleName} import ${imports.replace(/\s+/g, ' ')}`,
    );
    const fromPattern = /^\s*from\s+([\w.]+)\s+import\s+([^\n#]+)/gm;
    let fromMatch: RegExpExecArray | null;
    while ((fromMatch = fromPattern.exec(flattened)) !== null) {
      for (const imported of fromMatch[2].split(',')) {
        const importMatch = imported.trim().match(/^([A-Za-z_][\w]*)(?:\s+as\s+([A-Za-z_][\w]*))?$/);
        if (!importMatch) continue;
        const importedName = importMatch[1];
        const alias = importMatch[2] || importedName;
        const resolved = this.resolvePythonModuleFile(importerFile, fromMatch[1], importedName, knownFiles);
        if (resolved) aliases.set(alias, resolved);
      }
    }
    const importPattern = /^\s*import\s+([\w.]+)(?:\s+as\s+([A-Za-z_][\w]*))?/gm;
    let importMatch: RegExpExecArray | null;
    while ((importMatch = importPattern.exec(flattened)) !== null) {
      const alias = importMatch[2] || importMatch[1].split('.')[0];
      const resolved = this.resolvePythonModuleFile(importerFile, importMatch[1], undefined, knownFiles);
      if (resolved) aliases.set(alias, resolved);
    }
    return aliases;
  }

  private extractLiteralPythonSettings(contents: Iterable<string>): Map<string, string> {
    const values = new Map<string, Set<string>>();
    const assignmentPattern = /^\s*([A-Za-z_][\w]*)(?:\s*:\s*[^=\n]+)?\s*=\s*(['"])([^'"]*)\2\s*(?:#.*)?$/gm;
    for (const content of contents) {
      let match: RegExpExecArray | null;
      while ((match = assignmentPattern.exec(content)) !== null) {
        const candidates = values.get(match[1]) || new Set<string>();
        candidates.add(match[3]);
        values.set(match[1], candidates);
      }
    }
    return new Map([...values.entries()]
      .filter(([, candidates]) => candidates.size === 1)
      .map(([name, candidates]) => [name, [...candidates][0]]));
  }

  private extractRouterMounts(
    file: string,
    content: string,
    knownFiles: Set<string>,
    literalSettings: Map<string, string>,
  ): FastAPIRouterMount[] {
    const aliases = this.extractPythonImportAliases(content, file, knownFiles);
    const mounts: FastAPIRouterMount[] = [];
    for (const call of this.extractBalancedCalls(content, 'include_router')) {
      const routerReference = call.match(/include_router\s*\(\s*([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)/)?.[1];
      if (!routerReference) continue;
      const alias = routerReference.split('.')[0];
      const childFile = aliases.get(alias);
      if (!childFile) continue;
      const literalPrefix = call.match(/\bprefix\s*=\s*(['"])([^'"]*)\1/)?.[2];
      const expressionPrefix = call.match(/\bprefix\s*=\s*([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)/)?.[1];
      const settingName = expressionPrefix?.split('.').pop();
      const resolvedSetting = settingName ? literalSettings.get(settingName) : undefined;
      mounts.push({
        parentFile: this.normalizePythonFile(file),
        childFile,
        prefix: literalPrefix ?? resolvedSetting ?? '',
        prefixResolved: literalPrefix !== undefined || resolvedSetting !== undefined || !/\bprefix\s*=/.test(call),
      });
    }
    return mounts;
  }

  private async resolveRouterMountPrefixes(
    files: string[],
    projectPath: string,
  ): Promise<Map<string, string[]>> {
    const normalizedFiles = files.map(file => this.normalizePythonFile(file));
    const knownFiles = new Set(normalizedFiles);
    const contentByFile = new Map<string, string>();
    for (const file of normalizedFiles) {
      contentByFile.set(file, await fs.readFile(path.join(projectPath, file), 'utf-8'));
    }
    const literalSettings = this.extractLiteralPythonSettings(contentByFile.values());
    const mounts = normalizedFiles.flatMap(file =>
      this.extractRouterMounts(file, contentByFile.get(file) || '', knownFiles, literalSettings));
    const children = new Set(mounts.map(mount => mount.childFile));
    const roots = normalizedFiles.filter(file =>
      !children.has(file) || /\bFastAPI\s*\(/.test(contentByFile.get(file) || ''));
    const mountsByParent = new Map<string, FastAPIRouterMount[]>();
    for (const mount of mounts) {
      const childrenForParent = mountsByParent.get(mount.parentFile) || [];
      childrenForParent.push(mount);
      mountsByParent.set(mount.parentFile, childrenForParent);
    }

    const prefixes = new Map<string, Set<string>>();
    const queue = roots.map(file => ({ file, prefix: '' }));
    const visited = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift()!;
      const visitKey = `${current.file}\0${current.prefix}`;
      if (visited.has(visitKey)) continue;
      visited.add(visitKey);
      const currentPrefixes = prefixes.get(current.file) || new Set<string>();
      currentPrefixes.add(current.prefix);
      prefixes.set(current.file, currentPrefixes);
      for (const mount of mountsByParent.get(current.file) || []) {
        queue.push({
          file: mount.childFile,
          prefix: this.joinRoutePaths(current.prefix, mount.prefix),
        });
      }
    }
    for (const file of normalizedFiles) {
      if (!prefixes.has(file)) prefixes.set(file, new Set(['']));
    }
    return new Map([...prefixes.entries()].map(([file, values]) => [file, [...values].sort()]));
  }

  private extractRouterPrefix(content: string): string | undefined {
    const constructorMatch = /\bAPIRouter\s*\(/.exec(content);
    if (!constructorMatch) return undefined;
    const opening = content.indexOf('(', constructorMatch.index);
    let depth = 0;
    let end = opening;
    for (; end < content.length; end++) {
      if (content[end] === '(') depth++;
      if (content[end] === ')' && --depth === 0) break;
    }
    const constructor = content.slice(constructorMatch.index, end + 1);
    return constructor.match(/\bprefix\s*=\s*(['"])([^'"]*)\1/)?.[2];
  }

  private extractRouterTags(content: string): string[] {
    const tags: string[] = [];
    const tagsPattern = /tags\s*=\s*\[([^\]]+)\]/;
    const match = tagsPattern.exec(content);

    if (match) {
      const tagsList = match[1].split(',').map(tag => tag.trim().replace(/['"]/g, ''));
      tags.push(...tagsList);
    }

    return tags;
  }

  private extractRouterDependencies(content: string): string[] {
    const dependencies: string[] = [];
    const depPattern = /dependencies\s*=\s*\[([^\]]+)\]/;
    const match = depPattern.exec(content);

    if (match) {
      const deps = match[1].split(',').map(dep => dep.trim().replace(/Depends\s*\(\s*(\w+)\s*\)/, '$1'));
      dependencies.push(...deps);
    }

    return dependencies;
  }

  private extractRoutes(rawContent: string): FastAPIRoute[] {
    const routes: FastAPIRoute[] = [];
    const content = maskPythonTripleQuotedStrings(rawContent); const lines = content.split('\n');
    const lineOffsets: number[] = [];
    let offset = 0;
    for (const line of lines) {
      lineOffsets.push(offset);
      offset += line.length + 1;
    }
    const parenthesisDelta = (value: string): number => [...value].reduce((depth, character) => depth + (character === '(' ? 1 : character === ')' ? -1 : 0), 0);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();

      const decoratorMatch = trimmedLine.match(/^@(\w+)\.(get|post|put|delete|patch|head|options|websocket)\s*\(/i);
      if (!decoratorMatch) continue;

      const method = decoratorMatch[2].toLowerCase();

      const decoratorLines = [trimmedLine];
      let decoratorEndLine = i;
      let decoratorDepth = parenthesisDelta(trimmedLine);
      while (decoratorDepth > 0 && decoratorEndLine + 1 < Math.min(i + 40, lines.length)) {
        decoratorEndLine++;
        decoratorLines.push(lines[decoratorEndLine].trim());
        decoratorDepth += parenthesisDelta(lines[decoratorEndLine]);
      }
      const decoratorText = decoratorLines.join(' ');
      let pathMatch = decoratorText.match(/@\w+\.\w+\s*\(\s*["']([^"']+)["']/);
      if (!pathMatch) {
        pathMatch = decoratorText.match(/@\w+\.\w+\s*\(\s*["']([^"']*)/);
      }
      const routePath = pathMatch ? pathMatch[1] : '/';

      let functionName = '';
      let handlerLine = 0;
      let handlerEndLine = 0;
      let isAsync = false;
      let functionIndent = 0;

      for (let j = decoratorEndLine + 1; j < Math.min(i + 40, lines.length); j++) {
        const nextLine = lines[j].trim();
        if (nextLine.startsWith('@')) {
          let stackedDepth = parenthesisDelta(nextLine);
          while (stackedDepth > 0 && j + 1 < Math.min(i + 40, lines.length)) {
            j++;
            stackedDepth += parenthesisDelta(lines[j]);
          }
          continue;
        }
        const funcMatch = nextLine.match(/^(async\s+)?def\s+(\w+)\s*\(/);
        if (funcMatch) {
          isAsync = !!funcMatch[1];
          functionName = funcMatch[2];
          handlerLine = j + 1;
          functionIndent = lines[j].length - lines[j].trimStart().length;

          handlerEndLine = this.findHandlerEndLine(lines, j, functionIndent);
          break;
        }
        if (nextLine.length > 0 && !nextLine.startsWith('#')) break;
      }

      if (!functionName) continue;

      const routeInfo = this.extractRouteInfo(content, lineOffsets[i], functionName);
      const functionDependencies = this.extractFunctionDependencies(lines, handlerLine - 1);
      const dependencies = [...new Set([
        ...(routeInfo.dependencies || []),
        ...functionDependencies,
      ])];
      const security = [...new Set([
        ...(routeInfo.security || []),
        ...dependencies.filter(dependency => this.isSecurityDependency(dependency)),
      ])];
      const routeParams = this.extractPathParameters(routePath);

      routes.push({
        method,
        path: routePath,
        handlerName: functionName,
        handlerLine,
        handlerEndLine,
        isAsync,
        operationId: routeInfo.operationId || functionName,
        summary: routeInfo.summary,
        description: routeInfo.description,
        tags: routeInfo.tags,
        dependencies,
        parameters: [...routeParams, ...routeInfo.parameters],
        requestBody: routeInfo.requestBody,
        responses: routeInfo.responses,
        security
      });
    }

    return routes;
  }

  private extractFunctionDependencies(lines: string[], functionLineIndex: number): string[] {
    const dependencies: string[] = [];
    const signatureLines: string[] = [];
    let parenDepth = 0;

    for (let i = functionLineIndex; i < Math.min(lines.length, functionLineIndex + 25); i++) {
      const line = lines[i];
      signatureLines.push(line);
      for (const char of line) {
        if (char === '(') parenDepth++;
        else if (char === ')') parenDepth--;
      }
      if (parenDepth <= 0 && line.trim().endsWith(':')) break;
    }

    const signature = signatureLines.join('\n');
    const dependsPattern = /Depends\s*\(\s*([A-Za-z_][A-Za-z0-9_\.]*)\s*\)/g;
    let match;
    while ((match = dependsPattern.exec(signature)) !== null) {
      dependencies.push(match[1].split('.').pop() || match[1]);
    }
    return dependencies;
  }

  private isSecurityDependency(dependency: string): boolean {
    const normalized = dependency
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toLowerCase();
    return /\b(auth|authenticate|authenticated|authorization|bearer|jwt|oauth|oidc|sso|token|api_key|apikey|current_user|require_user|require_login|require_session|verify_user|verify_token)\b/.test(normalized) ||
      /^get_current_(user|account|tenant|organization|organisation|session)$/.test(normalized);
  }

  private findHandlerEndLine(lines: string[], startLine: number, functionIndent: number): number {
    for (let k = startLine + 1; k < lines.length; k++) {
      const bodyLine = lines[k];
      if (bodyLine.trim().length === 0) continue;

      const currentIndent = bodyLine.length - bodyLine.trimStart().length;
      if (currentIndent <= functionIndent && bodyLine.trim().length > 0) {
        return k;
      }
    }
    return lines.length;
  }

  private extractHandlerCalls(lines: string[], startLine: number, endLine: number): HandlerCall[] {
    const calls: HandlerCall[] = [];
    const builtins = new Set([
      'print', 'len', 'str', 'int', 'float', 'bool', 'list', 'dict', 'set', 'tuple',
      'range', 'enumerate', 'zip', 'map', 'filter', 'sorted', 'reversed', 'min', 'max',
      'sum', 'abs', 'round', 'type', 'isinstance', 'hasattr', 'getattr', 'setattr',
      'open', 'format', 'repr', 'id', 'hash', 'input', 'any', 'all', 'next', 'iter'
    ]);

    for (let i = startLine; i < Math.min(endLine, lines.length); i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (trimmed.startsWith('#')) continue;
      if (trimmed.length === 0) continue;

      const isAwaitCall = trimmed.includes('await ');

      const methodCallPattern = /(\w+)\.(\w+)\s*\(/g;
      let match;
      while ((match = methodCallPattern.exec(line)) !== null) {
        const objectName = match[1];
        const methodName = match[2];

        if (objectName === 'self') continue;
        if (['str', 'int', 'list', 'dict', 'set'].includes(objectName)) continue;
        if (methodName.startsWith('_')) continue;

        calls.push({
          callee: methodName,
          callType: 'method',
          line: i + 1,
          isAsync: isAwaitCall && line.indexOf('await') < match.index,
          objectName
        });
      }

      const funcCallPattern = /(?<![\w.])(\w+)\s*\(/g;
      while ((match = funcCallPattern.exec(line)) !== null) {
        const funcName = match[1];

        if (builtins.has(funcName)) continue;
        if (funcName.startsWith('_')) continue;
        if (['if', 'while', 'for', 'with', 'except', 'assert', 'return', 'yield', 'raise', 'lambda', 'class', 'def', 'async'].includes(funcName)) continue;

        const alreadyMethod = calls.some(c =>
          c.line === i + 1 &&
          c.callType === 'method' &&
          c.callee === funcName
        );
        if (alreadyMethod) continue;

        calls.push({
          callee: funcName,
          callType: isAwaitCall && line.indexOf('await') < match.index ? 'await' : 'function',
          line: i + 1,
          isAsync: isAwaitCall && line.indexOf('await') < match.index
        });
      }

      const dependsPattern = /Depends\s*\(\s*(\w+)\s*\)/g;
      while ((match = dependsPattern.exec(line)) !== null) {
        calls.push({
          callee: match[1],
          callType: 'dependency',
          line: i + 1,
          isAsync: false
        });
      }
    }

    return calls;
  }

  private extractPathParameters(routePath: string): Array<{ name: string; type: string; location: string; required: boolean; description?: string }> {
    const params: Array<{ name: string; type: string; location: string; required: boolean }> = [];
    const paramPattern = /\{(\w+)(?::([^}]+))?\}/g;
    let match;
    while ((match = paramPattern.exec(routePath)) !== null) {
      params.push({
        name: match[1],
        type: match[2] || 'str',
        location: 'path',
        required: true
      });
    }
    return params;
  }

  private extractRouteInfo(content: string, routeStart: number, functionName: string): any {
    const routeInfo: any = {
      dependencies: [],
      parameters: [],
      responses: [],
      tags: []
    };

    const functionEnd = this.findFunctionEnd(content, routeStart);
    const routeContent = content.substring(routeStart, functionEnd);

    const summaryMatch = routeContent.match(/summary\s*=\s*['"]([^'"]+)['"]/);
    if (summaryMatch) routeInfo.summary = summaryMatch[1];

    const descriptionMatch = routeContent.match(/description\s*=\s*['"]([^'"]+)['"]/);
    if (descriptionMatch) routeInfo.description = descriptionMatch[1];

    const operationIdMatch = routeContent.match(/operation_id\s*=\s*['"]([^'"]+)['"]/);
    if (operationIdMatch) routeInfo.operationId = operationIdMatch[1];

    const tagsMatch = routeContent.match(/tags\s*=\s*\[([^\]]+)\]/);
    if (tagsMatch) {
      routeInfo.tags = tagsMatch[1].split(',').map((tag: string) => tag.trim().replace(/['"]/g, ''));
    }

    return routeInfo;
  }

  private extractPydanticModels(content: string, filePath: string): PydanticModel[] {
    const models: PydanticModel[] = [];
    const modelPattern = /class\s+(\w+)\s*\(\s*(BaseModel|BaseSettings)\s*\):/g;

    let match;
    while ((match = modelPattern.exec(content)) !== null) {
      const modelName = match[1];
      const baseClass = match[2];
      const classStart = match.index;
      const classEnd = this.findClassEnd(content, classStart);
      const classContent = content.substring(classStart, classEnd);

      const fields = this.extractModelFields(classContent);
      const validators = this.extractModelValidators(classContent);
      const config = this.extractModelConfig(classContent);

      models.push({
        name: modelName,
        filePath,
        baseClass,
        fields,
        validators,
        config
      });
    }

    return models;
  }

  private extractModelFields(content: string): Array<{ name: string; type: string; required: boolean; default?: any; description?: string; validators?: string[] }> {
    const fields: Array<{ name: string; type: string; required: boolean; default?: any; description?: string; validators?: string[] }> = [];
    const fieldPattern = /(\w+)\s*:\s*([^=\n]+)(?:\s*=\s*([^\n]+))?/g;

    let match;
    while ((match = fieldPattern.exec(content)) !== null) {
      const name = match[1];
      const type = match[2].trim();
      const defaultValue = match[3];

      if (name !== 'Config' && !name.startsWith('__')) {
        fields.push({
          name,
          type,
          required: !defaultValue || !defaultValue.includes('None'),
          default: defaultValue
        });
      }
    }

    return fields;
  }

  private extractModelValidators(content: string): Array<{ name: string; type: string; field?: string }> {
    const validators: Array<{ name: string; type: string; field?: string }> = [];
    const validatorPattern = /@validator\s*\(\s*['"]([^'"]+)['"]\s*\)[\s\S]*?def\s+(\w+)\s*\(/g;

    let match;
    while ((match = validatorPattern.exec(content)) !== null) {
      const field = match[1];
      const name = match[2];

      validators.push({
        name,
        type: 'validator',
        field
      });
    }

    return validators;
  }

  private extractModelConfig(content: string): Record<string, any> {
    const config: Record<string, any> = {};
    const configPattern = /class\s+Config\s*:([^}]*?)(?=class|\Z)/;
    const configMatch = configPattern.exec(content);

    if (configMatch) {
      const configContent = configMatch[1];
      const settingPattern = /(\w+)\s*=\s*([^\n]+)/g;

      let match;
      while ((match = settingPattern.exec(configContent)) !== null) {
        const key = match[1];
        const value = match[2].trim();
        config[key] = value;
      }
    }

    return config;
  }

  private extractDependencies(content: string, filePath: string): FastAPIDependency[] {
    const dependencies: FastAPIDependency[] = [];
    const depPattern = /(?:async\s+)?def\s+(\w+)\s*\([^)]*\)(?:\s*->\s*([^:]+))?:/g;

    let match;
    while ((match = depPattern.exec(content)) !== null) {
      const name = match[1];
      const returnType = match[2]?.trim();

      if (content.includes(`Depends(${name})`)) {
        dependencies.push({
          name,
          filePath,
          type: 'function',
          scope: 'call',
          dependencies: [],
          returnType
        });
      }
    }

    return dependencies;
  }

  private extractMiddleware(content: string, filePath: string): FastAPIMiddleware[] {
    const middleware: FastAPIMiddleware[] = [];
    const middlewarePattern = /class\s+(\w+)(?:\s*\([^)]*\))?:|@(\w+\.)?middleware\s*\(\s*['"]([^'"]+)['"]\s*\)[\s\S]*?(?:async\s+)?def\s+(\w+)/g;

    let match;
    while ((match = middlewarePattern.exec(content)) !== null) {
      const className = match[1];
      const functionName = match[4];
      const name = className || functionName;

      if (name) {
        const methods = this.extractMiddlewareMethods(content, name);

        middleware.push({
          name,
          filePath,
          type: className ? 'class' : 'function',
          order: 0,
          methods
        });
      }
    }

    return middleware;
  }

  private extractBackgroundTasks(content: string, filePath: string): FastAPIBackgroundTask[] {
    const tasks: FastAPIBackgroundTask[] = [];
    const taskPattern = /(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\):/g;

    let match;
    while ((match = taskPattern.exec(content)) !== null) {
      const name = match[1];
      const params = match[2];

      if (content.includes(`background_tasks.add_task(${name})`) ||
          content.includes(`BackgroundTask(${name})`)) {

        const parameters = this.extractFunctionParameters(params);

        tasks.push({
          name,
          filePath,
          parameters
        });
      }
    }

    return tasks;
  }

  private extractWebSockets(content: string): FastAPIWebSocket[] {
    const websockets: FastAPIWebSocket[] = [];
    const wsPattern = /@(?:\w+\.)?websocket\s*\(\s*['"]([^'"]+)['"]\s*\)[\s\S]*?(?:async\s+)?def\s+(\w+)\s*\(/g;

    let match;
    while ((match = wsPattern.exec(content)) !== null) {
      const path = match[1];
      const endpoint = match[2];

      websockets.push({
        path,
        endpoint,
        dependencies: []
      });
    }

    return websockets;
  }

  private extractMiddlewareMethods(content: string, middlewareName: string): Array<{ name: string; parameters: string[]; returnType?: string }> {
    const methods: Array<{ name: string; parameters: string[]; returnType?: string }> = [];
    const methodPattern = /def\s+(dispatch|__call__)\s*\(([^)]*)\)(?:\s*->\s*([^:]+))?:/g;

    let match;
    while ((match = methodPattern.exec(content)) !== null) {
      const name = match[1];
      const params = match[2];
      const returnType = match[3]?.trim();

      methods.push({
        name,
        parameters: params.split(',').map(p => p.trim()),
        returnType
      });
    }

    return methods;
  }

  private extractFunctionParameters(params: string): Array<{ name: string; type: string }> {
    const parameters: Array<{ name: string; type: string }> = [];

    if (params.trim()) {
      const paramList = params.split(',').map(p => p.trim());

      paramList.forEach(param => {
        const [name, type] = param.split(':').map(p => p.trim());
        parameters.push({
          name: name || param,
          type: type || 'Any'
        });
      });
    }

    return parameters;
  }

  private findClassEnd(content: string, classStart: number): number {
    const lines = content.substring(classStart).split('\n');
    let indentLevel = 0;
    let found = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith('class ') && !found) {
        indentLevel = line.length - line.trimLeft().length;
        found = true;
        continue;
      }

      if (found && line.trim() && line.length - line.trimLeft().length <= indentLevel && !line.trimLeft().startsWith('#')) {
        return classStart + lines.slice(0, i).join('\n').length;
      }
    }

    return content.length;
  }

  private findFunctionEnd(content: string, functionStart: number): number {
    const lines = content.substring(functionStart).split('\n');
    let indentLevel = 0;
    let found = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if ((line.trim().startsWith('def ') || line.trim().startsWith('async def ')) && !found) {
        indentLevel = line.length - line.trimLeft().length;
        found = true;
        continue;
      }

      if (found && line.trim() && line.length - line.trimLeft().length <= indentLevel && !line.trimLeft().startsWith('#')) {
        return functionStart + lines.slice(0, i).join('\n').length;
      }
    }

    return content.length;
  }

  private async detectFastAPIVersion(projectPath: string): Promise<string> {
    try {
      const requirementsPath = path.join(projectPath, 'requirements.txt');
      if (await fs.pathExists(requirementsPath)) {
        const requirements = await fs.readFile(requirementsPath, 'utf-8');
        const versionMatch = requirements.match(/fastapi==([^\s\n]+)/i);
        if (versionMatch) return versionMatch[1];
      }
    } catch {

    }

    return 'unknown';
  }

  private extractPythonImports(content: string): string[] {
    const imports: string[] = [];
    const importPattern = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm;
    let match;

    while ((match = importPattern.exec(content)) !== null) {
      imports.push(match[1] || match[2]);
    }

    return imports;
  }

  private buildFastAPIRelationships(
    application: FastAPIApplication | null,
    routers: FastAPIRouter[],
    models: PydanticModel[],
    dependencies: FastAPIDependency[],
    middleware: FastAPIMiddleware[],
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    if (!application) return;

    const appId = `app_${this.sanitizeId(application.name)}`;

    routers.forEach(router => {
      const routerId = this.routerNodeId(router.name, router.filePath);
      edges.push(this.createEdge(
        `${appId}_includes_${routerId}`,
        appId,
        routerId,
        'includes'
      ));
    });
    const definitions = dependencies.map(dependency => ({
      ...dependency, nodeId: fastApiDependencyNodeId(dependency.filePath, dependency.name)
    }));
    const sources = [
      ...routers.map(router => ({ nodeId: this.routerNodeId(router.name, router.filePath), filePath: router.filePath, dependencies: router.dependencies })),
      ...definitions
    ];
    const nodeIds = new Set(nodes.map(node => node.id));
    for (const link of planFastAPIDependencyLinks(sources, definitions)) {
      if (!link.resolved && !nodeIds.has(link.targetId)) {
        nodes.push(this.createNodeBuilder(link.targetId, link.targetName, 'service')
          .withLevel(3, 'code').withCategory('service', ['injectable', 'unresolved-reference'])
          .withSource({ file: link.targetFile, line: 1, end_line: 1 })
          .withDescription(`FastAPI dependency reference: ${link.targetName}`)
          .withMetadata({ framework: 'fastapi', attributes: { resolution: 'unresolved-reference' } }).build());
        nodeIds.add(link.targetId);
      }
      edges.push(this.createEdge(
        this.generateEdgeId(link.sourceId, link.targetId, 'depends_on'), link.sourceId, link.targetId, 'depends_on'
      ));
    }

    middleware.forEach(mw => {
      const middlewareId = `middleware_${this.sanitizeId(mw.name)}`;
      edges.push(this.createEdge(
        `${appId}_uses_${middlewareId}`,
        appId,
        middlewareId,
        'uses'
      ));
    });
  }

  private identifyDatabaseConnections(models: PydanticModel[], exitPoints: any[]): void {
    if (models.length > 0) {
      exitPoints.push({
        id: 'exit_fastapi_database',
        name: 'FastAPI Database Connection',
        type: 'database_connection',
        source_node: 'fastapi_orm',
        metadata: {
          models: models.map(m => m.name),
          orm: 'SQLAlchemy/Tortoise/Other',
          validationFramework: 'Pydantic'
        }
      });
    }
  }

  protected getCapabilities(): string[] {
    return [
      'fastapi-analysis',
      'router-extraction',
      'pydantic-model-detection',
      'dependency-injection-analysis',
      'middleware-detection',
      'background-task-analysis',
      'websocket-detection',
      'openapi-schema-analysis'
    ];
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


}
