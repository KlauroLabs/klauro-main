import { BaseAnalyzer, CASAnalysisResult, CASNode, CASEdge, AnalysisContext } from '../../core/base-analyzer';
import {
  CASContribution, CASEntryPoint, CASExitPoint,
  CASDocumentation, CASComment, CASTodo, CASImplementationStatus
} from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';
import { glob } from 'glob';

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
  private todoCounter = 0;
  private commentCounter = 0;

  constructor() {
    super(
      'fastapi-analyzer',
      'FastAPI Framework Analyzer',
      '1.0.0',
      'framework'
    );
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
        if (pyproject.includes('fastapi') || pyproject.includes('FastAPI')) return true;
      }

      const pythonFiles = await glob(['**/*.py'], {
        cwd: projectPath,
        ignore: ['**/venv/**', '**/.venv/**', '**/env/**', '**/__pycache__/**', '**/.git/**', '**/node_modules/**', '**/dist/**', '**/build/**']
      });

      for (const file of pythonFiles) {
        const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
        if (content.includes('from fastapi') || content.includes('import fastapi') || content.includes('FastAPI(')) {
          return true;
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  async analyze(context: AnalysisContext): Promise<CASAnalysisResult> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: any[] = [];
    const exitPoints: any[] = [];

    try {
      const pythonFiles = await glob(['**/*.py'], {
        cwd: context.projectPath,
        ignore: ['**/venv/**', '**/.venv/**', '**/env/**', '**/__pycache__/**', '**/.git/**', '**/node_modules/**', '**/dist/**', '**/build/**']
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

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
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
          const documentation = this.extractDocumentation(content, fullPath);
          const comments = this.extractComments(content, fullPath);
          const todos = this.extractTodos(comments);
          const implementationStatus = this.determineImplementationStatus(content, comments);

          const appNode = this.createNodeBuilder(appId, application.name, 'application')
            .withLevel(1, 'system')
            .withCategory('application', ['framework', 'fastapi'])
            .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
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

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      const hasRouter = content.includes('APIRouter(') || content.includes('router = ');
      const hasAppRoutes = content.includes('FastAPI(') && /@\w+\.(get|post|put|delete|patch)\s*\(/i.test(content);

      if (hasRouter || hasAppRoutes) {
        const routerName = hasRouter ? this.extractRouterName(content, file) : this.extractAppName(content, file);
        const prefix = hasRouter ? this.extractRouterPrefix(content) : '';
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

        const routerId = `router_${this.sanitizeId(routerName)}`;
        const routerDocumentation = this.extractDocumentation(content, fullPath);
        const routerComments = this.extractComments(content, fullPath);
        const routerTodos = this.extractTodos(routerComments);
        const routerImplementationStatus = this.determineImplementationStatus(content, routerComments);

        const routerNode = this.createNodeBuilder(routerId, routerName, 'router')
          .withLevel(2, 'architectural')
          .withCategory('module', ['router'])
          .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
          .withDescription(`FastAPI router: ${routerName}`)
          .withDocumentation(routerDocumentation)
          .withComments(routerComments)
          .withTodos(routerTodos)
          .withImplementationStatus(routerImplementationStatus)
          .withMetadata({
            framework: 'fastapi',
            attributes: {
              prefix,
              tags,
              routes: routes.length,
              dependencies: dependencies.length
            }
          })
          .build();
        nodes.push(routerNode);

        routes.forEach((route, index) => {
          const routeId = `route_${routerId}_${index}`;
          const handlerId = `handler_${routerId}_${this.sanitizeId(route.handlerName)}_${route.handlerLine}`;
          const fullRoutePath = `${prefix || ''}${route.path}`.replace('//', '/');

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
            .build();
          nodes.push(routeNode);

          const handlerNode = this.createNodeBuilder(handlerId, route.handlerName, 'function')
            .withLevel(3, 'code')
            .withCategory('function', ['handler', 'endpoint'])
            .withSource({ file: fullPath, line: route.handlerLine, end_line: route.handlerEndLine })
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
                .withSource({ file: fullPath, line: call.line })
                .withDescription(`Called by handler: ${route.handlerName}`)
                .withMetadata({
                  framework: 'fastapi',
                  attributes: {
                    is_async: call.isAsync,
                    call_type: call.callType,
                    object_name: call.objectName
                  }
                })
                .build();
              nodes.push(calleeNode);
            }

            const edgeType = call.callType === 'dependency' ? 'depends_on' : 'calls';
            edges.push(this.createEdge(
              `${handlerId}_${edgeType}_${calleeId}_${call.line}`,
              handlerId,
              calleeId,
              edgeType
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
          const modelDocumentation = this.extractDocumentation(content, fullPath);
          const modelComments = this.extractComments(content, fullPath);
          const modelTodos = this.extractTodos(modelComments);
          const modelImplementationStatus = this.determineImplementationStatus(content, modelComments);

          const modelNode = this.createNodeBuilder(modelId, model.name, 'model')
            .withLevel(3, 'code')
            .withCategory('model', ['data', 'entity'])
            .withSource({ file: fullPath, line: 1, end_line: 1 })
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
          const depId = `dependency_${this.sanitizeId(dep.name)}`;
          const depDocumentation = this.extractDocumentation(content, fullPath);
          const depComments = this.extractComments(content, fullPath);
          const depTodos = this.extractTodos(depComments);
          const depImplementationStatus = this.determineImplementationStatus(content, depComments);

          const dependencyNode = this.createNodeBuilder(depId, dep.name, 'service')
            .withLevel(3, 'code')
            .withCategory('service', ['injectable'])
            .withSource({ file: fullPath, line: 1, end_line: 1 })
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
          const middlewareDocumentation = this.extractDocumentation(content, fullPath);
          const middlewareComments = this.extractComments(content, fullPath);
          const middlewareTodos = this.extractTodos(middlewareComments);
          const middlewareImplementationStatus = this.determineImplementationStatus(content, middlewareComments);

          const middlewareNode = this.createNodeBuilder(middlewareId, mw.name, 'middleware')
            .withLevel(3, 'code')
            .withCategory('middleware', ['interceptor'])
            .withSource({ file: fullPath, line: 1, end_line: 1 })
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
            .withSource({ file: fullPath, line: 1, end_line: 1 })
            .withDescription(`FastAPI background task: ${task.name}`)
            .withMetadata({
              framework: 'fastapi',
              attributes: {
                parameters: task.parameters.length,
                description: task.description
              }
            })
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
            .withSource({ file: fullPath, line: 1, end_line: 1 })
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
              file: fullPath,
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

  private extractRouterPrefix(content: string): string | undefined {
    const prefixPattern = /prefix\s*=\s*['"]([^'"]+)['"]/;
    const match = prefixPattern.exec(content);
    return match ? match[1] : undefined;
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

  private extractRoutes(content: string): FastAPIRoute[] {
    const routes: FastAPIRoute[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();

      const decoratorMatch = trimmedLine.match(/^@(\w+)\.(get|post|put|delete|patch|head|options|websocket)\s*\(/i);
      if (!decoratorMatch) continue;

      const method = decoratorMatch[2].toLowerCase();

      let pathMatch = trimmedLine.match(/@\w+\.\w+\s*\(\s*["']([^"']+)["']/);
      if (!pathMatch) {
        pathMatch = trimmedLine.match(/@\w+\.\w+\s*\(\s*["']([^"']*)/);
      }
      const routePath = pathMatch ? pathMatch[1] : '/';

      let functionName = '';
      let handlerLine = 0;
      let handlerEndLine = 0;
      let isAsync = false;
      let functionIndent = 0;

      for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
        const nextLine = lines[j].trim();
        const funcMatch = nextLine.match(/^(async\s+)?def\s+(\w+)\s*\(/);
        if (funcMatch) {
          isAsync = !!funcMatch[1];
          functionName = funcMatch[2];
          handlerLine = j + 1;
          functionIndent = lines[j].length - lines[j].trimStart().length;

          handlerEndLine = this.findHandlerEndLine(lines, j, functionIndent);
          break;
        }
        if (nextLine.startsWith('@')) continue;
        if (nextLine.length > 0 && !nextLine.startsWith('#')) break;
      }

      if (!functionName) continue;

      const routeInfo = this.extractRouteInfo(content, 0, functionName);
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
        dependencies: routeInfo.dependencies,
        parameters: [...routeParams, ...routeInfo.parameters],
        requestBody: routeInfo.requestBody,
        responses: routeInfo.responses,
        security: routeInfo.security
      });
    }

    return routes;
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
      // Continue with other methods
    }

    return 'unknown';
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
      const routerId = `router_${this.sanitizeId(router.name)}`;
      edges.push(this.createEdge(
        `${appId}_includes_${routerId}`,
        appId,
        routerId,
        'includes'
      ));

      router.dependencies.forEach(depName => {
        const depId = `dependency_${this.sanitizeId(depName)}`;
        edges.push(this.createEdge(
          `${routerId}_depends_on_${depId}`,
          routerId,
          depId,
          'depends_on'
        ));
      });
    });

    dependencies.forEach(dependency => {
      const depId = `dependency_${this.sanitizeId(dependency.name)}`;

      dependency.dependencies.forEach(subDepName => {
        const subDepId = `dependency_${this.sanitizeId(subDepName)}`;
        edges.push(this.createEdge(
          `${depId}_depends_on_${subDepId}`,
          depId,
          subDepId,
          'depends_on'
        ));
      });
    });

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

  // CAS v1.4.0 Documentation and Comment extraction methods
  private extractDocumentation(content: string, filePath: string): CASDocumentation | undefined {
    if (!content || content.trim().length === 0) return undefined;

    const lines = content.split('\n');

    // Look for FastAPI-specific documentation patterns

    // 1. Pydantic field descriptions
    const fieldDescMatches = content.matchAll(/Field\([^)]*description\s*=\s*['"]([^'"]+)['"]/g);
    const fieldDescriptions = [];
    for (const match of fieldDescMatches) {
      fieldDescriptions.push(match[1]);
    }

    // 2. Route operation descriptions and summaries
    const routeDocMatches = content.matchAll(/@app\.(get|post|put|delete|patch)\([^)]*summary\s*=\s*['"]([^'"]+)['"]/g);
    const routeDocs = [];
    for (const match of routeDocMatches) {
      routeDocs.push(`${match[1].toUpperCase()}: ${match[2]}`);
    }

    // 3. Pydantic model docstrings
    const modelDocMatches = content.matchAll(/class\s+\w+\([^)]*BaseModel[^)]*\):\s*['"""]([^'"]*?)['"""]/g);
    const modelDocs = [];
    for (const match of modelDocMatches) {
      modelDocs.push(match[1].trim());
    }

    // 4. Function docstrings
    const functionDocStrings = [];
    const functionMatches = content.matchAll(/def\s+\w+[^:]*:\s*['"""]([^'"]*?)['"""]/g);
    for (const match of functionMatches) {
      functionDocStrings.push(match[1].trim());
    }

    if (fieldDescriptions.length > 0 || routeDocs.length > 0 || modelDocs.length > 0 || functionDocStrings.length > 0) {
      const doc: CASDocumentation = {
        type: 'fastapi_documentation',
        raw: content,
        location: { start_line: 1, end_line: lines.length }
      };

      if (functionDocStrings.length > 0) {
        doc.summary = functionDocStrings[0].split('\n')[0].trim();
        doc.description = functionDocStrings[0].trim();
      } else if (modelDocs.length > 0) {
        doc.summary = modelDocs[0].split('\n')[0].trim();
      }

      doc.framework_docs = {
        fastapi: {
          field_descriptions: fieldDescriptions
        }
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

      // Python single-line comments
      if (trimmedLine.startsWith('#')) {
        const commentText = trimmedLine.substring(1).trim();
        if (commentText.length > 0) {
          const comment: CASComment = {
            id: `comment_${++this.commentCounter}`,
            type: 'single-line',
            style: '#',
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

      // Multi-line string comments (docstrings used as comments)
      const docstringMatch = line.match(/^\s*['"]{3}([^'"]*?)['"]{3}/);
      if (docstringMatch && !line.includes('def ') && !line.includes('class ')) {
        const commentText = docstringMatch[1].trim();
        if (commentText.length > 0) {
          const comment: CASComment = {
            id: `comment_${++this.commentCounter}`,
            type: 'docstring',
            style: '"""',
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
      has_not_implemented_exceptions: content.includes('NotImplementedError') || content.includes('raise NotImplemented'),
      has_stub_returns: content.includes('pass') && (content.includes('def ') || content.includes('class ')),
      has_placeholder_code: content.includes('# TODO') || content.includes('# FIXME') || content.includes('# PLACEHOLDER'),
      has_hardcoded_values: /['\"](localhost|127\.0\.0\.1|test|example|demo|placeholder)['\"]/.test(content),
      has_commented_out_code: comments.some(c => c.text.includes('def ') || c.text.includes('class ') || c.text.includes('import '))
    };

    const indicatorCount = Object.values(indicators).filter(Boolean).length;
    let status: CASImplementationStatus['status'];
    let confidence = 0.8;

    if (content.includes('NotImplementedError') || content.includes('raise NotImplemented')) {
      status = 'not-implemented';
      confidence = 0.95;
    } else if (indicatorCount >= 3) {
      status = 'stub';
      confidence = 0.7;
    } else if (indicatorCount >= 1) {
      status = 'partial';
      confidence = 0.6;
    } else if (content.includes('@deprecated') || content.includes('# deprecated')) {
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
