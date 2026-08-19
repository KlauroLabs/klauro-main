import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint,
  CASDocumentation, CASComment, CASTodo, CASImplementationStatus, CASPerspective
} from "../../../types/cas.types";
import { AnalyzerError } from '../../core/errors';
import { classifyGuardKind, isAuthenticationGuardName } from '../../core/guard-classification';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';
import { createYieldBudget } from '../../core/event-loop-yield';
import { loadSourceFiles, type LoadedSourceFile } from '../../core/source-file-loader';
import { extractFiniteControllerRouters } from './finite-controller-routes';
import { importsLocalPackage } from '../../core/local-package-import-context';

interface ExpressApplication {
  name: string;
  filePath: string;
  appVariable: string;
  port?: number;
  middleware: string[];
  routers: string[];
  staticDirectories: string[];
  viewEngine?: string;
  environment: string;
}

interface ExpressRoute {
  method: string;
  path: string;
  handler: string;
  middleware: string[];
  parameters: Array<{ name: string; type: string; source: string }>;
  description?: string;
  handlerFile?: string;
}

interface ExpressRouter {
  name: string;
  filePath: string;
  prefix?: string;
  routes: ExpressRoute[];
  middleware: string[];
  subRouters: string[];
}

interface ExpressMiddleware {
  name: string;
  filePath: string;
  type: 'function' | 'class' | 'external';
  order?: number;
  global: boolean;
  route?: string;
  methods: string[];
  errorHandler: boolean;
}

interface ExpressController {
  name: string;
  filePath: string;
  type: 'class' | 'object' | 'module';
  methods: Array<{ name: string; route?: string; httpMethod?: string; middleware?: string[] }>;
  dependencies: string[];
}

interface ExpressView {
  name: string;
  filePath: string;
  engine: string;
  layout?: string;
  partials: string[];
  variables: string[];
}

interface ExpressModel {
  name: string;
  filePath: string;
  type: 'mongoose' | 'sequelize' | 'typeorm' | 'custom';
  schema?: Record<string, any>;
  methods: string[];
  relationships: Array<{ type: string; target: string; field: string }>;
}

interface ExpressService {
  name: string;
  filePath: string;
  methods: Array<{ name: string; parameters: string[]; returnType?: string }>;
  dependencies: string[];
  database: boolean;
  external: boolean;
}

export class ExpressAnalyzer extends BaseAnalyzer {

  constructor() {
    super(
      'express',
      'Express.js Framework Analyzer',
      '1.0.0',
      'framework'
    );
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const packageJsonPath = path.join(projectPath, 'package.json');
      const packageJson = await fs.pathExists(packageJsonPath) ? await fs.readJson(packageJsonPath) : {};
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      const hasNestJS = Object.keys(deps).some(dep =>
        dep.includes('@nestjs/core') ||
        dep.includes('@nestjs/common') ||
        dep.includes('@nestjs/platform-express')
      );

      if (hasNestJS) {
        return false;
      }

      const jsFiles = await glob(['**/*.{js,ts}'], {
        cwd: projectPath,
        ignore: [
          ...this.getIgnorePatterns({ projectPath }),
          '**/*.test.*',
          '**/*.spec.*',
          '**/__tests__/**'
        ],
        nodir: true
      });

      for (const file of jsFiles) {
        const fullPath = path.join(projectPath, file);
        const content = await fs.readFile(fullPath, 'utf-8');







        const importsExpress =
          /^\s*import\s+(?:\*\s+as\s+)?\w+\b.*\bfrom\s+['"]express['"]/m.test(content) ||
          /^\s*import\s*\{[^}]*\}\s*from\s+['"]express['"]/m.test(content) ||
          /^\s*(?:const|let|var)\s+\w+\s*=\s*require\(\s*['"]express['"]\s*\)/m.test(content) ||
          await importsLocalPackage(projectPath, fullPath, content, 'express');




        if (importsExpress && /\bexpress\s*\(\s*\)|\bexpress\s*\.\s*Router\s*\(|\bRouter\s*\(\s*\)/.test(content)) {
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
    const perspectives: CASPerspective[] = [];

    try {
      const jsFiles = await glob(['**/*.{js,ts}'], {
        cwd: context.projectPath,
        ignore: [...this.getIgnorePatterns(context), '**/*.test.*', '**/*.spec.*'],
        nodir: true
      });

      const viewFiles = await glob(['**/views/**/*.{ejs,pug,hbs,handlebars,html}'], {
        cwd: context.projectPath,
        ignore: this.getIgnorePatterns(context),
        nodir: true
      });
      const [sourceFiles, sourceViews] = await Promise.all([
        loadSourceFiles(jsFiles, context.projectPath),
        loadSourceFiles(viewFiles, context.projectPath),
      ]);

      const application = await this.analyzeApplication(sourceFiles, nodes);
      const routers = await this.analyzeRouters(sourceFiles, nodes, edges, entryPoints);
      const middleware = await this.analyzeMiddleware(sourceFiles, nodes, edges);
      const controllers = await this.analyzeControllers(sourceFiles, nodes, edges);
      const models = await this.analyzeModels(sourceFiles, nodes, edges, exitPoints);
      const services = await this.analyzeServices(sourceFiles, nodes, edges);
      const views = await this.analyzeViews(sourceViews, nodes, edges);

      this.buildExpressRelationships(application, routers, middleware, controllers, models, services, nodes, edges);
      this.identifyDatabaseConnections(models, exitPoints);

      this.tagNodesWithPerspectives(nodes, edges);
      this.createPerspectives(perspectives);

      const contribution = this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework: 'express',
        version: await this.detectExpressVersion(context.projectPath),
        applicationFound: application !== null,
        routersFound: routers.length,
        middlewareFound: middleware.length,
        controllersFound: controllers.length,
        modelsFound: models.length,
        servicesFound: services.length,
        viewsFound: views.length,
        totalRoutes: routers.reduce((sum, router) => sum + router.routes.length, 0)
      });

      contribution.perspectives = perspectives;
      contribution.provided_perspectives = perspectives.map(p => p.id);

      return contribution;

    } catch (error) {
      throw new AnalyzerError(
        `Express analysis failed: ${(error as Error).message}`,
        'EXPRESS_ANALYSIS_ERROR'
      );
    }
  }

  private async analyzeApplication(
    files: LoadedSourceFile[],
    nodes: CASNode[]
  ): Promise<ExpressApplication | null> {


    const maybeYield = createYieldBudget();
    for (const file of files) {
      await maybeYield();
      const { relativePath, fullPath, content } = file;

      if (this.looksLikeMainExpressFile(content)) {
        const appVariable = this.extractAppVariable(content);
        if (appVariable) {
          const port = this.extractPort(content);
          const middleware = this.extractGlobalMiddleware(content);
          const routers = this.extractRouterUsage(content);
          const staticDirectories = this.extractStaticDirectories(content);
          const viewEngine = this.extractViewEngine(content);
          const environment = this.extractEnvironment(content);

          const application: ExpressApplication = {
            name: path.basename(relativePath, path.extname(relativePath)),
            filePath: relativePath,
            appVariable,
            port,
            middleware,
            routers,
            staticDirectories,
            viewEngine,
            environment
          };

          const appId = `app_${this.sanitizeId(application.name)}`;
          const documentation = this.extractDocumentation(content, fullPath);
          const comments = this.extractComments(content, fullPath);
          const todos = this.extractTodos(comments);
          const implementationStatus = this.determineImplementationStatus(content, comments);

          const appNode = this.createNodeBuilder(appId, application.name, 'application')
            .withLevel(1, 'system')
            .withCategory('application', ['framework', 'express'])
            .withSource({ file: relativePath, line: 1, end_line: content.split('\n').length })
            .withDescription(`Express.js application: ${application.name}`)
            .withDocumentation(documentation)
            .withComments(comments)
            .withTodos(todos)
            .withImplementationStatus(implementationStatus)
            .withMetadata({
              framework: 'express',
              attributes: {
                appVariable,
                port,
                middleware: middleware.length,
                routers: routers.length,
                staticDirectories: staticDirectories.length,
                viewEngine,
                environment
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
    files: LoadedSourceFile[],
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[]
  ): Promise<ExpressRouter[]> {
    const routers: ExpressRouter[] = [];
    const generatedRouters = new Map(
      extractFiniteControllerRouters(files).map(router => [router.filePath, router])
    );



    const maybeYield = createYieldBudget();
    for (const file of files) {
      await maybeYield();
      const { relativePath, fullPath, content } = file;
      const generatedRouter = generatedRouters.get(relativePath);

      if (this.isRouterFile(content) || generatedRouter) {
        try {
          const routerName = generatedRouter?.name || this.extractRouterName(content, relativePath);
          const prefix = generatedRouter?.prefix || this.extractRouterPrefix(content, relativePath);
          const routes: ExpressRoute[] = generatedRouter?.routes.map(route => ({
            ...route,
            parameters: this.extractRouteParameters(route.path),
            description: undefined,
          })) || this.extractRoutes(content);
          const middleware = generatedRouter ? [] : this.extractRouterMiddleware(content);
          const subRouters = generatedRouter ? [] : this.extractSubRouters(content);

          const router: ExpressRouter = {
            name: routerName,
            filePath: relativePath,
            prefix,
            routes,
            middleware,
            subRouters
          };

          routers.push(router);

          const routerId = `router_${this.sanitizeId(routerName)}`;
          const routerDocumentation = this.extractDocumentation(content, fullPath);
          const routerComments = this.extractComments(content, fullPath);
          const routerTodos = this.extractTodos(routerComments);
          const routerImplementationStatus = this.determineImplementationStatus(content, routerComments);

          const routerNode = this.createNodeBuilder(routerId, routerName, 'router')
            .withLevel(2, 'architectural')
            .withCategory('router', ['framework', 'express'])
            .withSource({ file: relativePath, line: 1, end_line: content.split('\n').length })
            .withDescription(`Express.js router: ${routerName}`)
            .withDocumentation(routerDocumentation)
            .withComments(routerComments)
            .withTodos(routerTodos)
            .withImplementationStatus(routerImplementationStatus)
            .withMetadata({
              framework: 'express',
              attributes: {
                prefix,
                routes: routes.length,
                middleware: middleware.length,
                subRouters: subRouters.length
              }
            })
            .build();
          nodes.push(routerNode);

          routes.forEach((route, index) => {
            const routeId = `route_${routerId}_${route.method}_${index}`;
            const fullPath = `${prefix || ''}${route.path}`.replace('//', '/');

            const routeNode = this.createNodeBuilder(routeId, `${route.method.toUpperCase()} ${fullPath}`, 'route')
              .withLevel(3, 'code')
              .withCategory('route', ['http', 'endpoint'])
              .withSource({ file: route.handlerFile || router.filePath, line: 1, end_line: 1 })
              .withDescription(`Express.js HTTP endpoint: ${route.method.toUpperCase()} ${fullPath}`)
              .withMetadata({
                framework: 'express',
                attributes: {
                  method: route.method,
                  path: route.path,
                  handler: route.handler,
                  middleware: route.middleware,
                  parameters: route.parameters.length,
                  description: route.description
                }
              })
              .build();
            nodes.push(routeNode);

            edges.push(this.createEdge(
              `${routerId}_exposes_${routeId}`,
              routerId,
              routeId,
              'exposes'
            ));






            const allMiddleware = [...new Set([...(router.middleware || []), ...(route.middleware || [])])]
              .map(name => name.trim())
              .filter(name => /^[\w$.]+(\(.*\))?$/.test(name));
            const authMiddleware = allMiddleware.filter(name => isAuthenticationGuardName(name) || classifyGuardKind(name) === 'authorization');
            const guards = allMiddleware.filter(name => classifyGuardKind(name) !== 'unknown');

            entryPoints.push({
              id: `entry_${routeId}`,
              name: `${route.method.toUpperCase()} ${fullPath}`,
              type: 'http',
              source_node: routeId,
              trigger: {
                method: route.method.toUpperCase(),
                path: fullPath
              },


              handler: {
                node_id: routeId,
                method_name: route.handler,
                file: route.handlerFile || router.filePath
              },
              security: {
                authenticated: authMiddleware.length > 0,
                guards,
                authorized_roles: []
              },
              metadata: {
                method: route.method.toUpperCase(),
                path: fullPath,
                handler: route.handler,
                handler_file: route.handlerFile || router.filePath,
                middleware: route.middleware,
                router: routerName
              }
            });
          });
        } catch (error) {
          console.warn(`Failed to parse Express router ${relativePath}:`, error);
        }
      }
    }

    return routers;
  }

  private async analyzeMiddleware(
    files: LoadedSourceFile[],
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<ExpressMiddleware[]> {
    const middleware: ExpressMiddleware[] = [];



    const maybeYield = createYieldBudget();
    for (const file of files) {
      await maybeYield();
      const { relativePath, fullPath, content } = file;

      if (this.isMiddlewareFile(content)) {
        const extractedMiddleware = this.extractMiddleware(content, relativePath);
        middleware.push(...extractedMiddleware);

        extractedMiddleware.forEach(mw => {
          const middlewareId = `middleware_${this.sanitizeId(mw.name)}`;
          const middlewareDocumentation = this.extractDocumentation(content, fullPath);
          const middlewareComments = this.extractComments(content, fullPath);
          const middlewareTodos = this.extractTodos(middlewareComments);
          const middlewareImplementationStatus = this.determineImplementationStatus(content, middlewareComments);

          const middlewareNode = this.createNodeBuilder(middlewareId, mw.name, 'middleware')
            .withLevel(3, 'code')
            .withCategory('middleware', ['framework', 'express'])
            .withSource({ file: relativePath, line: 1, end_line: content.split('\n').length })
            .withDescription(`Express.js middleware: ${mw.name}`)
            .withDocumentation(middlewareDocumentation)
            .withComments(middlewareComments)
            .withTodos(middlewareTodos)
            .withImplementationStatus(middlewareImplementationStatus)
            .withMetadata({
              framework: 'express',
              attributes: {
                type: mw.type,
                global: mw.global,
                route: mw.route,
                methods: mw.methods,
                errorHandler: mw.errorHandler
              }
            })
            .build();
          nodes.push(middlewareNode);
        });
      }
    }

    return middleware;
  }

  private async analyzeControllers(
    files: LoadedSourceFile[],
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<ExpressController[]> {
    const controllers: ExpressController[] = [];



    const maybeYield = createYieldBudget();
    for (const file of files) {
      await maybeYield();
      const { relativePath, fullPath, content } = file;

      if (this.isControllerFile(content, relativePath)) {
        const extractedControllers = this.extractControllers(content, relativePath);
        controllers.push(...extractedControllers);

        extractedControllers.forEach(controller => {
          const controllerId = `controller_${this.sanitizeId(controller.name)}`;
          const controllerDocumentation = this.extractDocumentation(content, fullPath);
          const controllerComments = this.extractComments(content, fullPath);
          const controllerTodos = this.extractTodos(controllerComments);
          const controllerImplementationStatus = this.determineImplementationStatus(content, controllerComments);

          const controllerNode = this.createNodeBuilder(controllerId, controller.name, 'controller')
            .withLevel(2, 'architectural')
            .withCategory('controller', ['api', 'rest'])
            .withSource({ file: relativePath, line: 1, end_line: content.split('\n').length })
            .withDescription(`Express.js controller: ${controller.name}`)
            .withDocumentation(controllerDocumentation)
            .withComments(controllerComments)
            .withTodos(controllerTodos)
            .withImplementationStatus(controllerImplementationStatus)
            .withMetadata({
              framework: 'express',
              attributes: {
                type: controller.type,
                methods: controller.methods.length,
                dependencies: controller.dependencies.length
              }
            })
            .build();
          nodes.push(controllerNode);

          controller.methods.forEach((method, index) => {
            const methodId = `method_${controllerId}_${method.name}_${index}`;
            const methodNode = this.createNodeBuilder(methodId, method.name, 'method')
              .withLevel(4, 'member')
              .withCategory('method', ['function'])
              .withSource({ file: relativePath, line: 1, end_line: 1 })
              .withDescription(`Controller method: ${method.name}`)
              .withParent(controllerId)
              .withMetadata({
                attributes: {
                  route: method.route,
                  httpMethod: method.httpMethod,
                  middleware: method.middleware
                }
              })
              .build();
            nodes.push(methodNode);

            edges.push(this.createEdge(
              `${controllerId}_contains_${methodId}`,
              controllerId,
              methodId,
              'contains'
            ));
          });
        });
      }
    }

    return controllers;
  }

  private async analyzeModels(
    files: LoadedSourceFile[],
    nodes: CASNode[],
    edges: CASEdge[],
    exitPoints: any[]
  ): Promise<ExpressModel[]> {
    const models: ExpressModel[] = [];



    const maybeYield = createYieldBudget();
    for (const file of files) {
      await maybeYield();
      const { relativePath, fullPath, content } = file;

      if (this.isModelFile(content, relativePath)) {
        const extractedModels = this.extractModels(content, relativePath);
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
            .withSource({ file: relativePath, line: 1, end_line: content.split('\n').length })
            .withDescription(`Express.js data model: ${model.name}`)
            .withDocumentation(modelDocumentation)
            .withComments(modelComments)
            .withTodos(modelTodos)
            .withImplementationStatus(modelImplementationStatus)
            .withMetadata({
              framework: 'express',
              attributes: {
                type: model.type,
                methods: model.methods.length,
                relationships: model.relationships.length,
                schema: model.schema ? Object.keys(model.schema).length : 0
              }
            })
            .build();
          nodes.push(modelNode);

          exitPoints.push({
            id: `exit_db_${modelId}`,
            name: `Database model: ${model.name}`,
            type: 'database_model',
            source_node: modelId,
            metadata: {
              model: model.name,
              type: model.type,
              methods: model.methods
            }
          });
        });
      }
    }

    return models;
  }

  private async analyzeServices(
    files: LoadedSourceFile[],
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<ExpressService[]> {
    const services: ExpressService[] = [];



    const maybeYield = createYieldBudget();
    for (const file of files) {
      await maybeYield();
      const { relativePath, fullPath, content } = file;

      if (this.isServiceFile(content, relativePath)) {
        const extractedServices = this.extractServices(content, relativePath);
        services.push(...extractedServices);

        extractedServices.forEach(service => {
          const serviceId = `service_${this.sanitizeId(service.name)}`;
          const serviceDocumentation = this.extractDocumentation(content, fullPath);
          const serviceComments = this.extractComments(content, fullPath);
          const serviceTodos = this.extractTodos(serviceComments);
          const serviceImplementationStatus = this.determineImplementationStatus(content, serviceComments);

          const serviceNode = this.createNodeBuilder(serviceId, service.name, 'service')
            .withLevel(3, 'code')
            .withCategory('service', ['business-logic'])
            .withSource({ file: relativePath, line: 1, end_line: content.split('\n').length })
            .withDescription(`Express.js service: ${service.name}`)
            .withDocumentation(serviceDocumentation)
            .withComments(serviceComments)
            .withTodos(serviceTodos)
            .withImplementationStatus(serviceImplementationStatus)
            .withMetadata({
              framework: 'express',
              attributes: {
                methods: service.methods.length,
                dependencies: service.dependencies.length,
                database: service.database,
                external: service.external
              }
            })
            .build();
          nodes.push(serviceNode);
        });
      }
    }

    return services;
  }

  private async analyzeViews(
    files: LoadedSourceFile[],
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<ExpressView[]> {
    const views: ExpressView[] = [];



    const maybeYield = createYieldBudget();
    for (const file of files) {
      await maybeYield();
      const { relativePath, content } = file;

      const viewName = path.basename(relativePath, path.extname(relativePath));
      const engine = path.extname(relativePath).substring(1);
      const layout = this.extractViewLayout(content, engine);
      const partials = this.extractViewPartials(content, engine);
      const variables = this.extractViewVariables(content, engine);

      const view: ExpressView = {
        name: viewName,
        filePath: relativePath,
        engine,
        layout,
        partials,
        variables
      };

      views.push(view);

      const viewId = `view_${this.sanitizeId(viewName)}`;
      const viewNode = this.createNodeBuilder(viewId, viewName, 'view')
        .withLevel(4, 'member')
        .withCategory('view', ['ui', 'template'])
        .withSource({ file: relativePath, line: 1, end_line: content.split('\n').length })
        .withDescription(`Express view template: ${viewName}`)
        .withMetadata({
          attributes: {
            engine,
            layout,
            partials: partials.length,
            variables: variables.length
          }
        })
        .build();
      nodes.push(viewNode);
    }

    return views;
  }

  private looksLikeMainExpressFile(content: string): boolean {
    return (content.includes('express()') || content.includes('new express')) &&
           (content.includes('.listen(') || content.includes('app.use') || content.includes('app.get'));
  }

  private isRouterFile(content: string): boolean {
    const hasRoute = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'].some(method =>
      content.includes(`.${method}(`)
    );
    return content.includes('express.Router()') ||
           content.includes('Router()') ||
           hasRoute;
  }

  private isMiddlewareFile(content: string): boolean {
    return content.includes('function(req, res, next)') ||
           content.includes('(req, res, next) =>') ||
           content.includes('next()');
  }

  private isControllerFile(content: string, filePath: string): boolean {
    return filePath.includes('/controllers/') ||
           filePath.includes('controller.') ||
           (content.includes('exports.') && content.includes('req') && content.includes('res'));
  }

  private isModelFile(content: string, filePath: string): boolean {
    return filePath.includes('/models/') ||
           filePath.includes('model.') ||
           content.includes('mongoose.Schema') ||
           content.includes('sequelize.define') ||
           content.includes('@Entity');
  }

  private isServiceFile(content: string, filePath: string): boolean {
    return filePath.includes('/services/') ||
           filePath.includes('service.') ||
           (content.includes('class') && content.includes('Service')) ||
           (content.includes('exports.') && !content.includes('req') && !content.includes('res'));
  }

  private extractAppVariable(content: string): string | null {
    const patterns = [
      /const\s+(\w+)\s*=\s*(?:module\.exports\s*=\s*)?express\(\)/,
      /var\s+(\w+)\s*=\s*(?:module\.exports\s*=\s*)?express\(\)/,
      /let\s+(\w+)\s*=\s*(?:module\.exports\s*=\s*)?express\(\)/
    ];

    for (const pattern of patterns) {
      const match = pattern.exec(content);
      if (match) return match[1];
    }

    return null;
  }

  private extractPort(content: string): number | undefined {
    const portPattern = /(?:listen|port)\s*\(\s*(?:process\.env\.PORT\s*\|\|\s*)?(\d+)/;
    const match = portPattern.exec(content);
    return match ? parseInt(match[1], 10) : undefined;
  }

  private extractGlobalMiddleware(content: string): string[] {
    const middleware: string[] = [];
    const patterns = [
      /app\.use\s*\(\s*([^,)]+)\s*\)/g,
      /app\.use\s*\(\s*['"]([^'"]+)['"],\s*([^,)]+)\s*\)/g
    ];

    patterns.forEach(pattern => {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const mw = match[1] || match[2];
        if (mw && !mw.includes('/')) {
          middleware.push(mw.trim());
        }
      }
    });

    return middleware;
  }

  private extractRouterUsage(content: string): string[] {
    const routers: string[] = [];
    const routerPattern = /app\.use\s*\(\s*(?:['"][^'"]*['"],\s*)?(\w+)\s*\)/g;

    let match;
    while ((match = routerPattern.exec(content)) !== null) {
      routers.push(match[1]);
    }

    return routers;
  }

  private extractStaticDirectories(content: string): string[] {
    const directories: string[] = [];
    const staticPattern = /express\.static\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

    let match;
    while ((match = staticPattern.exec(content)) !== null) {
      directories.push(match[1]);
    }

    return directories;
  }

  private extractViewEngine(content: string): string | undefined {
    const enginePattern = /app\.set\s*\(\s*['"]view engine['"],\s*['"]([^'"]+)['"]\s*\)/;
    const match = enginePattern.exec(content);
    return match ? match[1] : undefined;
  }

  private extractEnvironment(content: string): string {
    if (content.includes('process.env.NODE_ENV')) return 'configurable';
    if (content.includes('development')) return 'development';
    if (content.includes('production')) return 'production';
    return 'default';
  }

  private extractRouterName(content: string, filePath: string): string {
    const routerPattern = /(?:const|var|let)\s+(\w+)\s*=\s*express\.Router\(\)/;
    const match = routerPattern.exec(content);
    return match ? match[1] : path.basename(filePath, path.extname(filePath));
  }

  private extractRouterPrefix(content: string, filePath: string): string | undefined {
    const prefixPattern = /router\.use\s*\(\s*['"]([^'"]+)['"]/;
    const match = prefixPattern.exec(content);

    if (match) return match[1];


    const segments = filePath.split('/');
    if (segments.includes('routes') || segments.includes('routers')) {
      const routeIndex = segments.findIndex(s => s === 'routes' || s === 'routers');
      if (routeIndex + 1 < segments.length) {
        return '/' + path.basename(segments[routeIndex + 1], path.extname(segments[routeIndex + 1]));
      }
    }

    return undefined;
  }

  private extractRoutes(content: string): ExpressRoute[] {
    const routes: ExpressRoute[] = [];





    const head = /(?:router|app)\.(get|post|put|delete|patch|head|options)\s*\(\s*(['"`])([^'"`]+)\2\s*/g;

    let match;
    while ((match = head.exec(content)) !== null) {
      const method = match[1];
      const path = this.normalizeTemplateLiteralRoutePath(match[3]);
      const args = this.parseRemainingCallArgs(content, head.lastIndex);



      const middleware = args
        .slice(0, -1)
        .map(a => a.trim())
        .filter(a => this.isMiddlewareIdentifier(a));
      const handler = (args[args.length - 1] || '').trim();

      routes.push({
        method,
        path,
        handler,
        middleware,
        parameters: this.extractRouteParameters(path)
      });
    }

    return routes;
  }















  private normalizeTemplateLiteralRoutePath(path: string): string {
    if (!path.includes('${')) return path;
    return path.replace(/\$\{\s*([^}]*?)\s*\}/g, (_match, expr: string) => {
      const token = (expr || '').replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
      return `:${token || 'param'}`;
    });
  }







  private parseRemainingCallArgs(content: string, pos: number): string[] {
    const args: string[] = [];
    let depth = 1;
    let cur = '';
    let inStr: string | null = null;
    for (let i = pos; i < content.length; i++) {
      const ch = content[i];
      if (inStr) {
        cur += ch;
        if (ch === inStr && content[i - 1] !== '\\') inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; cur += ch; continue; }
      if (ch === '(' || ch === '[' || ch === '{') { depth++; cur += ch; continue; }
      if (ch === ')' || ch === ']' || ch === '}') {
        depth--;
        if (depth === 0) { if (cur.trim()) args.push(cur.trim()); break; }
        cur += ch;
        continue;
      }
      if (ch === ',' && depth === 1) { if (cur.trim()) args.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    return args;
  }



  private isMiddlewareIdentifier(arg: string): boolean {
    if (!arg || /=>/.test(arg)) return false;
    if (/^(async\s+)?function\b/.test(arg)) return false;

    return /^[A-Za-z_$][\w$.]*(\s*\([^)]*\))?$/.test(arg);
  }

  private extractRouteParameters(path: string): Array<{ name: string; type: string; source: string }> {
    const parameters: Array<{ name: string; type: string; source: string }> = [];
    const paramPattern = /:(\w+)/g;

    let match;
    while ((match = paramPattern.exec(path)) !== null) {
      parameters.push({
        name: match[1],
        type: 'string',
        source: 'path'
      });
    }

    return parameters;
  }

  private extractRouterMiddleware(content: string): string[] {
    const middleware: string[] = [];
    const middlewarePattern = /router\.use\s*\(\s*([^,)]+)\s*\)/g;

    let match;
    while ((match = middlewarePattern.exec(content)) !== null) {
      middleware.push(match[1].trim());
    }

    return middleware;
  }

  private extractSubRouters(content: string): string[] {
    const subRouters: string[] = [];
    const subRouterPattern = /router\.use\s*\(\s*['"][^'"]*['"],\s*(\w+)\s*\)/g;

    let match;
    while ((match = subRouterPattern.exec(content)) !== null) {
      subRouters.push(match[1]);
    }

    return subRouters;
  }

  private extractMiddleware(content: string, filePath: string): ExpressMiddleware[] {
    const middleware: ExpressMiddleware[] = [];

    const functionPattern = /(?:function\s+(\w+)|const\s+(\w+)\s*=.*?function|exports\.(\w+)\s*=.*?function)/g;
    let match;

    while ((match = functionPattern.exec(content)) !== null) {
      const name = match[1] || match[2] || match[3];
      if (name) {
        const isErrorHandler = content.includes('err') && content.includes('next(err)');
        const methods = this.extractMiddlewareMethods(content, name);

        middleware.push({
          name,
          filePath,
          type: 'function',
          global: false,
          methods,
          errorHandler: isErrorHandler
        });
      }
    }

    return middleware;
  }

  private extractControllers(content: string, filePath: string): ExpressController[] {
    const controllers: ExpressController[] = [];

    const className = this.extractClassName(content);
    if (className) {
      const methods = this.extractControllerMethods(content);
      const dependencies = this.extractControllerDependencies(content);

      controllers.push({
        name: className,
        filePath,
        type: 'class',
        methods,
        dependencies
      });
    } else {
      const moduleName = path.basename(filePath, path.extname(filePath));
      const methods = this.extractExportedMethods(content);
      const dependencies = this.extractRequires(content);

      if (methods.length > 0) {
        controllers.push({
          name: moduleName,
          filePath,
          type: 'module',
          methods,
          dependencies
        });
      }
    }

    return controllers;
  }

  private extractModels(content: string, filePath: string): ExpressModel[] {
    const models: ExpressModel[] = [];

    if (content.includes('mongoose.Schema')) {
      const mongooseModels = this.extractMongooseModels(content, filePath);
      models.push(...mongooseModels);
    }

    if (content.includes('sequelize.define')) {
      const sequelizeModels = this.extractSequelizeModels(content, filePath);
      models.push(...sequelizeModels);
    }

    if (content.includes('@Entity')) {
      const typeormModels = this.extractTypeOrmModels(content, filePath);
      models.push(...typeormModels);
    }

    return models;
  }

  private extractServices(content: string, filePath: string): ExpressService[] {
    const services: ExpressService[] = [];

    const serviceName = this.extractServiceName(content, filePath);
    const methods = this.extractServiceMethods(content);
    const dependencies = this.extractRequires(content);
    const database = this.hasDatabase(content);
    const external = this.hasExternalCalls(content);

    if (methods.length > 0) {
      services.push({
        name: serviceName,
        filePath,
        methods,
        dependencies,
        database,
        external
      });
    }

    return services;
  }

  private extractClassName(content: string): string | null {
    const classPattern = /class\s+(\w+)/;
    const match = classPattern.exec(content);
    return match ? match[1] : null;
  }

  private extractControllerMethods(content: string): Array<{ name: string; route?: string; httpMethod?: string; middleware?: string[] }> {
    const methods: Array<{ name: string; route?: string; httpMethod?: string; middleware?: string[] }> = [];
    const methodPattern = /(\w+)\s*(?:\(|:)/g;

    let match;
    while ((match = methodPattern.exec(content)) !== null) {
      const name = match[1];
      if (name !== 'constructor' && name !== 'class') {
        methods.push({ name });
      }
    }

    return methods;
  }

  private extractControllerDependencies(content: string): string[] {
    return this.extractRequires(content);
  }

  private extractExportedMethods(content: string): Array<{ name: string; route?: string; httpMethod?: string; middleware?: string[] }> {
    const methods: Array<{ name: string; route?: string; httpMethod?: string; middleware?: string[] }> = [];
    const exportPattern = /exports\.(\w+)\s*=/g;

    let match;
    while ((match = exportPattern.exec(content)) !== null) {
      methods.push({ name: match[1] });
    }

    return methods;
  }

  private extractRequires(content: string): string[] {
    const requires: string[] = [];
    const requirePattern = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

    let match;
    while ((match = requirePattern.exec(content)) !== null) {
      requires.push(match[1]);
    }

    return requires;
  }

  private extractMongooseModels(content: string, filePath: string): ExpressModel[] {
    const models: ExpressModel[] = [];
    const modelPattern = /mongoose\.model\s*\(\s*['"](\w+)['"]/g;

    let match;
    while ((match = modelPattern.exec(content)) !== null) {
      const name = match[1];
      const schema = this.extractMongooseSchema(content);
      const methods = this.extractModelMethods(content);

      models.push({
        name,
        filePath,
        type: 'mongoose',
        schema,
        methods,
        relationships: []
      });
    }

    return models;
  }

  private extractSequelizeModels(content: string, filePath: string): ExpressModel[] {
    const models: ExpressModel[] = [];
    const modelPattern = /sequelize\.define\s*\(\s*['"](\w+)['"]/g;

    let match;
    while ((match = modelPattern.exec(content)) !== null) {
      const name = match[1];
      const methods = this.extractModelMethods(content);

      models.push({
        name,
        filePath,
        type: 'sequelize',
        methods,
        relationships: []
      });
    }

    return models;
  }

  private extractTypeOrmModels(content: string, filePath: string): ExpressModel[] {
    const models: ExpressModel[] = [];
    const entityPattern = /@Entity\s*\(\s*['"]?(\w+)?['"]?\s*\)\s*(?:export\s+)?class\s+(\w+)/g;

    let match;
    while ((match = entityPattern.exec(content)) !== null) {
      const name = match[2];
      const methods = this.extractModelMethods(content);

      models.push({
        name,
        filePath,
        type: 'typeorm',
        methods,
        relationships: []
      });
    }

    return models;
  }

  private extractServiceName(content: string, filePath: string): string {
    const className = this.extractClassName(content);
    return className || path.basename(filePath, path.extname(filePath));
  }

  private extractServiceMethods(content: string): Array<{ name: string; parameters: string[]; returnType?: string }> {
    const methods: Array<{ name: string; parameters: string[]; returnType?: string }> = [];
    const methodPattern = /(?:function\s+(\w+)|(\w+)\s*:\s*(?:function|async)|exports\.(\w+)\s*=)/g;

    let match;
    while ((match = methodPattern.exec(content)) !== null) {
      const name = match[1] || match[2] || match[3];
      if (name) {
        methods.push({
          name,
          parameters: []
        });
      }
    }

    return methods;
  }

  private extractModelMethods(content: string): string[] {
    const methods: string[] = [];
    const methodPattern = /(\w+)\s*:\s*function/g;

    let match;
    while ((match = methodPattern.exec(content)) !== null) {
      methods.push(match[1]);
    }

    return methods;
  }

  private extractMongooseSchema(content: string): Record<string, any> {
    const schema: Record<string, any> = {};
    const schemaPattern = /new\s+mongoose\.Schema\s*\(\s*\{([^}]+)\}/;
    const match = schemaPattern.exec(content);

    if (match) {
      const schemaContent = match[1];
      const fieldPattern = /(\w+)\s*:\s*\{[^}]*\}/g;

      let fieldMatch;
      while ((fieldMatch = fieldPattern.exec(schemaContent)) !== null) {
        schema[fieldMatch[1]] = 'field';
      }
    }

    return schema;
  }

  private extractMiddlewareMethods(content: string, middlewareName: string): string[] {
    return [middlewareName];
  }

  private hasDatabase(content: string): boolean {
    return content.includes('mongoose') ||
           content.includes('sequelize') ||
           content.includes('mysql') ||
           content.includes('pg') ||
           content.includes('mongodb');
  }

  private hasExternalCalls(content: string): boolean {
    return content.includes('axios') ||
           content.includes('fetch') ||
           content.includes('request') ||
           content.includes('http.get') ||
           content.includes('https.get');
  }

  private extractViewLayout(content: string, engine: string): string | undefined {
    if (engine === 'ejs' || engine === 'html') {
      const layoutPattern = /<%\s*layout\s*\(\s*['"]([^'"]+)['"]\s*\)\s*%>/;
      const match = layoutPattern.exec(content);
      return match ? match[1] : undefined;
    }

    if (engine === 'pug') {
      const extendsPattern = /extends\s+(\w+)/;
      const match = extendsPattern.exec(content);
      return match ? match[1] : undefined;
    }

    if (engine === 'hbs' || engine === 'handlebars') {
      const layoutPattern = /\{\{>\s*(\w+)\s*\}\}/;
      const match = layoutPattern.exec(content);
      return match ? match[1] : undefined;
    }

    return undefined;
  }

  private extractViewPartials(content: string, engine: string): string[] {
    const partials: string[] = [];

    if (engine === 'ejs') {
      const partialPattern = /<%\s*include\s+['"]([^'"]+)['"]\s*%>/g;
      let match;
      while ((match = partialPattern.exec(content)) !== null) {
        partials.push(match[1]);
      }
    }

    if (engine === 'pug') {
      const includePattern = /include\s+(\w+)/g;
      let match;
      while ((match = includePattern.exec(content)) !== null) {
        partials.push(match[1]);
      }
    }

    if (engine === 'hbs' || engine === 'handlebars') {
      const partialPattern = /\{\{>\s*(\w+)\s*\}\}/g;
      let match;
      while ((match = partialPattern.exec(content)) !== null) {
        partials.push(match[1]);
      }
    }

    return partials;
  }

  private extractViewVariables(content: string, engine: string): string[] {
    const variables: string[] = [];

    if (engine === 'ejs') {
      const variablePattern = /<%=\s*(\w+)(?:\.\w+)*\s*%>/g;
      let match;
      while ((match = variablePattern.exec(content)) !== null) {
        if (!variables.includes(match[1])) {
          variables.push(match[1]);
        }
      }
    }

    if (engine === 'pug') {
      const variablePattern = /#{(\w+)}/g;
      let match;
      while ((match = variablePattern.exec(content)) !== null) {
        if (!variables.includes(match[1])) {
          variables.push(match[1]);
        }
      }
    }

    if (engine === 'hbs' || engine === 'handlebars') {
      const variablePattern = /\{\{\s*(\w+)(?:\.\w+)*\s*\}\}/g;
      let match;
      while ((match = variablePattern.exec(content)) !== null) {
        if (!variables.includes(match[1])) {
          variables.push(match[1]);
        }
      }
    }

    return variables;
  }

  private async detectExpressVersion(projectPath: string): Promise<string> {
    try {
      const packageJson = await fs.readJson(path.join(projectPath, 'package.json'));
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      return deps.express || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private buildExpressRelationships(
    application: ExpressApplication | null,
    routers: ExpressRouter[],
    middleware: ExpressMiddleware[],
    controllers: ExpressController[],
    models: ExpressModel[],
    services: ExpressService[],
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    if (!application) return;

    const appId = `app_${this.sanitizeId(application.name)}`;

    routers.forEach(router => {
      const routerId = `router_${this.sanitizeId(router.name)}`;
      edges.push(this.createEdge(
        `${appId}_uses_${routerId}`,
        appId,
        routerId,
        'uses'
      ));
    });

    middleware.forEach(mw => {
      const middlewareId = `middleware_${this.sanitizeId(mw.name)}`;
      if (mw.global) {
        edges.push(this.createEdge(
          `${appId}_uses_${middlewareId}`,
          appId,
          middlewareId,
          'uses'
        ));
      }
    });

    controllers.forEach(controller => {
      const controllerId = `controller_${this.sanitizeId(controller.name)}`;

      controller.dependencies.forEach(dep => {
        const serviceId = `service_${this.sanitizeId(dep)}`;
        edges.push(this.createEdge(
          `${controllerId}_depends_on_${serviceId}`,
          controllerId,
          serviceId,
          'depends_on'
        ));
      });
    });

    services.forEach(service => {
      const serviceId = `service_${this.sanitizeId(service.name)}`;

      service.dependencies.forEach(dep => {
        if (models.some(m => m.name === dep)) {
          const modelId = `model_${this.sanitizeId(dep)}`;
          edges.push(this.createEdge(
            `${serviceId}_uses_${modelId}`,
            serviceId,
            modelId,
            'uses'
          ));
        }
      });
    });
  }

  private identifyDatabaseConnections(models: ExpressModel[], exitPoints: any[]): void {
    if (models.length > 0) {
      const dbTypes = [...new Set(models.map(m => m.type))];

      dbTypes.forEach(dbType => {
        exitPoints.push({
          id: `exit_express_${dbType}`,
          name: `${dbType.charAt(0).toUpperCase() + dbType.slice(1)} Database Connection`,
          type: 'database_connection',
          source_node: `express_${dbType}`,
          metadata: {
            orm: dbType,
            models: models.filter(m => m.type === dbType).map(m => m.name)
          }
        });
      });
    }
  }

  protected getCapabilities(): string[] {
    return [
      'express-analysis',
      'router-extraction',
      'middleware-detection',
      'controller-analysis',
      'model-discovery',
      'service-detection',
      'route-mapping',
      'view-engine-analysis'
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

  private createPerspectives(perspectives: CASPerspective[]): void {
    perspectives.push({
      id: 'express-routes',
      name: 'Express API Routes',
      description: 'API routes and middleware chain showing request processing flow',
      analyzer_id: this.analyzerId,
      type: 'flow',
      connection_rules: {
        visible_node_types: ['express_app', 'express_router', 'express_route', 'express_middleware'],
        relevant_edge_types: ['contains', 'uses', 'processes'],
        node_connections: [
          {
            from_type: 'express_app',
            to_types: ['express_router', 'express_middleware'],
            edge_type: 'uses'
          },
          {
            from_type: 'express_router',
            to_types: ['express_route'],
            edge_type: 'contains'
          },
          {
            from_type: 'express_route',
            to_types: ['express_middleware'],
            edge_type: 'uses'
          }
        ]
      },
      layout_hints: {
        style: 'hierarchical',
        direction: 'TB',
        group_by: 'http_method'
      },
      metadata: {
        show_http_methods: true,
        show_middleware_order: true
      }
    });

    perspectives.push({
      id: 'express-layers',
      name: 'Express Request Processing Layers',
      description: 'Request processing layers: Middleware → Routes → Handlers',
      analyzer_id: this.analyzerId,
      type: 'structure',
      connection_rules: {
        visible_node_types: ['express_middleware', 'express_route', 'express_controller', 'express_service'],
        relevant_edge_types: ['processes', 'delegates_to', 'calls'],
        node_connections: [
          {
            from_type: 'express_middleware',
            to_types: ['express_route'],
            edge_type: 'processes'
          },
          {
            from_type: 'express_route',
            to_types: ['express_controller'],
            edge_type: 'delegates_to'
          },
          {
            from_type: 'express_controller',
            to_types: ['express_service'],
            edge_type: 'calls'
          }
        ]
      },
      layout_hints: {
        style: 'hierarchical',
        direction: 'LR'
      },
      metadata: {
        show_processing_order: true,
        layer_separation: true
      }
    });
  }

  private tagNodesWithPerspectives(nodes: CASNode[], edges: CASEdge[]): void {
    nodes.forEach(node => {
      if (!node || typeof node !== 'object') return;

      if (!node.perspectives) {
        node.perspectives = {};
      }

      if (node.type === 'express_app' || node.type === 'express_router' ||
          node.type === 'express_route' || node.type === 'express_middleware') {
        node.perspectives['express-routes'] = {
          hierarchy: ['express', 'routes'],
          level: node.level || 1,
          priority: 1
        };
      }

      if (node.type === 'express_middleware' || node.type === 'express_route' ||
          node.type === 'express_controller' || node.type === 'express_service') {
        node.perspectives['express-layers'] = {
          hierarchy: ['express', 'layers'],
          level: node.level || 1,
          priority: 2
        };
      }

      if (!node.metadata) {
        node.metadata = {};
      }
      node.metadata.perspective_data = {
        'express-routes': {
          route_type: node.type,
          http_method: node.metadata?.attributes?.method || 'GET',
          middleware_position: node.metadata?.attributes?.order || 0
        },
        'express-layers': {
          processing_layer: this.getProcessingLayer(node.type),
          layer_order: this.getLayerOrder(node.type)
        }
      };
    });

    edges.forEach(edge => {
      edge.perspectives = [];

      if (edge.type === 'contains' || edge.type === 'uses' || edge.type === 'processes') {
        edge.perspectives.push('express-routes');
      }

      if (edge.type === 'processes' || edge.type === 'delegates_to' || edge.type === 'calls') {
        edge.perspectives.push('express-layers');
      }

      if (!edge.metadata) {
        edge.metadata = {};
      }
      edge.metadata.perspective_data = {
        'express-routes': {
          relationship_type: edge.type,
          is_middleware_chain: edge.type === 'processes'
        },
        'express-layers': {
          layer_transition: edge.type,
          processing_direction: 'inbound'
        }
      };
    });
  }

  private getProcessingLayer(nodeType: string): string {
    switch (nodeType) {
      case 'express_middleware': return 'middleware';
      case 'express_route': return 'routing';
      case 'express_controller': return 'controller';
      case 'express_service': return 'business';
      default: return 'unknown';
    }
  }

  private getLayerOrder(nodeType: string): number {
    switch (nodeType) {
      case 'express_middleware': return 1;
      case 'express_route': return 2;
      case 'express_controller': return 3;
      case 'express_service': return 4;
      default: return 5;
    }
  }


  private extractDocumentation(content: string, filePath: string): CASDocumentation | undefined {
    if (!content || content.trim().length === 0) return undefined;

    const lines = content.split('\n');




    const jsdocMatches = content.matchAll(/\/\*\*([\s\S]*?)\*\//g);
    const jsdocDocs = [];
    for (const match of jsdocMatches) {
      jsdocDocs.push(match[1].trim());
    }


    const routeDocMatches = content.matchAll(/\/\/ @route\s+([^\n]+)/g);
    const routeDocs = [];
    for (const match of routeDocMatches) {
      routeDocs.push(match[1].trim());
    }


    const middlewareDocMatches = content.matchAll(/\/\/ @middleware\s+([^\n]+)/g);
    const middlewareDocs = [];
    for (const match of middlewareDocMatches) {
      middlewareDocs.push(match[1].trim());
    }


    const apiDocMatches = content.matchAll(/\/\/ @api\s+([^\n]+)/g);
    const apiDocs = [];
    for (const match of apiDocMatches) {
      apiDocs.push(match[1].trim());
    }

    if (jsdocDocs.length > 0 || routeDocs.length > 0 || middlewareDocs.length > 0 || apiDocs.length > 0) {
      const doc: CASDocumentation = {
        type: 'express_documentation',
        raw: content,
        location: { start_line: 1, end_line: lines.length }
      };

      if (jsdocDocs.length > 0) {
        doc.summary = jsdocDocs[0].split('\n')[0].replace(/\*/g, '').trim();
        doc.description = jsdocDocs[0].replace(/\*/g, '').trim();
      }

      if (routeDocs.length > 0 || middlewareDocs.length > 0 || apiDocs.length > 0) {
        doc.framework_docs = {
          express: {
            routes: routeDocs,
            middleware: middlewareDocs
          }
        };
      }

      return doc;
    }

    return undefined;
  }

  private extractComments(content: string, filePath: string): CASComment[] {
    if (!content || content.trim().length === 0) return [];

    const comments: CASComment[] = [];
    let commentSeq = 0;
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();


      if (trimmedLine.startsWith('//')) {
        const commentText = trimmedLine.substring(2).trim();
        if (commentText.length > 0) {
          const comment: CASComment = {
            id: `comment_${filePath}_${++commentSeq}`,
            type: 'single-line',
            style: '//',
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


      if (trimmedLine.startsWith('/*') && !trimmedLine.startsWith('/**')) {
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
            id: `comment_${filePath}_${++commentSeq}`,
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

        i = j - 1;
      }
    }

    return comments;
  }

  private extractTodos(comments: CASComment[]): CASTodo[] {
    const todos: CASTodo[] = [];
    let todoSeq = 0;

    for (const comment of comments) {
      if (comment.markers?.is_todo || comment.markers?.is_fixme || comment.markers?.is_hack) {
        const text = comment.text;
        const typeMatch = text.match(/(TODO|FIXME|HACK|NOTE|WARNING|XXX)/i);
        const type = typeMatch ? typeMatch[0].toUpperCase() as CASTodo['type'] : 'TODO';


        const assigneeMatch = text.match(/TODO\s*\(\s*([^)]+)\s*\)/i);
        const assignee = assigneeMatch ? assigneeMatch[1].trim() : undefined;


        const priorityMatch = text.match(/\[(CRITICAL|HIGH|MEDIUM|LOW)\]/i);
        let priority: CASTodo['priority'] = 'medium';
        if (priorityMatch) {
          priority = priorityMatch[1].toLowerCase() as CASTodo['priority'];
        }

        const todo: CASTodo = {
          id: `todo_${comment.location.file}_${comment.location.line}_${++todoSeq}`,
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
      has_not_implemented_exceptions: content.includes('throw new Error("Not implemented")') || content.includes('TODO: implement'),
      has_stub_returns: content.includes('return null;') || content.includes('return undefined;') || content.includes('return {};'),
      has_placeholder_code: content.includes('// TODO') || content.includes('// FIXME') || content.includes('// PLACEHOLDER'),
      has_hardcoded_values: /['"](localhost|127\.0\.0\.1|test|example|demo|placeholder)['"]/.test(content),
      has_commented_out_code: comments.some(c => c.text.includes('function ') || c.text.includes('app.') || c.text.includes('router.'))
    };

    const indicatorCount = Object.values(indicators).filter(Boolean).length;
    let status: CASImplementationStatus['status'];
    let confidence = 0.8;

    if (content.includes('throw new Error("Not implemented")')) {
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
