import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, CASPerspective } from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';
import { glob } from 'glob';
import { parse } from '@typescript-eslint/typescript-estree';

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
      'express-analyzer',
      'Express.js Framework Analyzer',
      '1.0.0',
      'framework'
    );
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const packageJsonPath = path.join(projectPath, 'package.json');
      if (!await fs.pathExists(packageJsonPath)) return false;

      const packageJson = await fs.readJson(packageJsonPath);
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };

      // Skip Express analysis if NestJS is present - NestJS analyzer should handle it
      const hasNestJS = Object.keys(deps).some(dep =>
        dep.includes('@nestjs/core') ||
        dep.includes('@nestjs/common') ||
        dep.includes('@nestjs/platform-express')
      );

      if (hasNestJS) {
        return false; // Defer to NestJS analyzer
      }

      if (Object.keys(deps).includes('express')) {
        return true;
      }

      const jsFiles = await glob(['**/*.{js,ts}'], {
        cwd: projectPath,
        ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**', '**/coverage/**', '**/.nyc_output/**']
      });

      for (const file of jsFiles) {
        const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
        if (content.includes('require(\'express\')') ||
            content.includes('from \'express\'') ||
            content.includes('import express')) {
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
        ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**', '**/coverage/**', '**/.nyc_output/**', '**/*.test.*', '**/*.spec.*']
      });

      const viewFiles = await glob(['**/views/**/*.{ejs,pug,hbs,handlebars,html}'], {
        cwd: context.projectPath
      });

      const application = await this.analyzeApplication(jsFiles, context.projectPath, nodes);
      const routers = await this.analyzeRouters(jsFiles, context.projectPath, nodes, edges, entryPoints);
      const middleware = await this.analyzeMiddleware(jsFiles, context.projectPath, nodes, edges);
      const controllers = await this.analyzeControllers(jsFiles, context.projectPath, nodes, edges);
      const models = await this.analyzeModels(jsFiles, context.projectPath, nodes, edges, exitPoints);
      const services = await this.analyzeServices(jsFiles, context.projectPath, nodes, edges);
      const views = await this.analyzeViews(viewFiles, context.projectPath, nodes, edges);

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
    files: string[],
    projectPath: string,
    nodes: CASNode[]
  ): Promise<ExpressApplication | null> {
    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

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
            name: path.basename(file, path.extname(file)),
            filePath: file,
            appVariable,
            port,
            middleware,
            routers,
            staticDirectories,
            viewEngine,
            environment
          };

          const appId = `app_${this.sanitizeId(application.name)}`;
          const appNode = this.createNodeBuilder(appId, application.name, 'application')
            .withLevel(1, 'system')
            .withCategory('application', ['framework', 'express'])
            .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
            .withDescription(`Express.js application: ${application.name}`)
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
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[]
  ): Promise<ExpressRouter[]> {
    const routers: ExpressRouter[] = [];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (this.isRouterFile(content)) {
        try {
          const routerName = this.extractRouterName(content, file);
          const prefix = this.extractRouterPrefix(content, file);
          const routes = this.extractRoutes(content);
          const middleware = this.extractRouterMiddleware(content);
          const subRouters = this.extractSubRouters(content);

          const router: ExpressRouter = {
            name: routerName,
            filePath: file,
            prefix,
            routes,
            middleware,
            subRouters
          };

          routers.push(router);

          const routerId = `router_${this.sanitizeId(routerName)}`;
          const routerNode = this.createNodeBuilder(routerId, routerName, 'router')
            .withLevel(2, 'architectural')
            .withCategory('router', ['framework', 'express'])
            .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
            .withDescription(`Express.js router: ${routerName}`)
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
              .withSource({ file: fullPath, line: 1, end_line: 1 })
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

            entryPoints.push({
              id: `entry_${routeId}`,
              name: `${route.method.toUpperCase()} ${fullPath}`,
              type: 'express_endpoint',
              source_node: routeId,
              metadata: {
                method: route.method.toUpperCase(),
                path: fullPath,
                handler: route.handler,
                middleware: route.middleware,
                router: routerName
              }
            });
          });
        } catch (error) {
          console.warn(`Failed to parse Express router ${file}:`, error);
        }
      }
    }

    return routers;
  }

  private async analyzeMiddleware(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<ExpressMiddleware[]> {
    const middleware: ExpressMiddleware[] = [];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (this.isMiddlewareFile(content)) {
        const extractedMiddleware = this.extractMiddleware(content, file);
        middleware.push(...extractedMiddleware);

        extractedMiddleware.forEach(mw => {
          const middlewareId = `middleware_${this.sanitizeId(mw.name)}`;
          const middlewareNode = this.createNodeBuilder(middlewareId, mw.name, 'middleware')
            .withLevel(3, 'code')
            .withCategory('middleware', ['framework', 'express'])
            .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
            .withDescription(`Express.js middleware: ${mw.name}`)
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
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<ExpressController[]> {
    const controllers: ExpressController[] = [];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (this.isControllerFile(content, file)) {
        const extractedControllers = this.extractControllers(content, file);
        controllers.push(...extractedControllers);

        extractedControllers.forEach(controller => {
          const controllerId = `controller_${this.sanitizeId(controller.name)}`;
          const controllerNode = this.createNodeBuilder(controllerId, controller.name, 'controller')
            .withLevel(2, 'architectural')
            .withCategory('controller', ['api', 'rest'])
            .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
            .withDescription(`Express.js controller: ${controller.name}`)
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
              .withSource({ file: fullPath, line: 1, end_line: 1 })
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
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    exitPoints: any[]
  ): Promise<ExpressModel[]> {
    const models: ExpressModel[] = [];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (this.isModelFile(content, file)) {
        const extractedModels = this.extractModels(content, file);
        models.push(...extractedModels);

        extractedModels.forEach(model => {
          const modelId = `model_${this.sanitizeId(model.name)}`;
          const modelNode = this.createNodeBuilder(modelId, model.name, 'model')
            .withLevel(3, 'code')
            .withCategory('model', ['data', 'entity'])
            .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
            .withDescription(`Express.js data model: ${model.name}`)
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
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<ExpressService[]> {
    const services: ExpressService[] = [];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (this.isServiceFile(content, file)) {
        const extractedServices = this.extractServices(content, file);
        services.push(...extractedServices);

        extractedServices.forEach(service => {
          const serviceId = `service_${this.sanitizeId(service.name)}`;
          const serviceNode = this.createNodeBuilder(serviceId, service.name, 'service')
            .withLevel(3, 'code')
            .withCategory('service', ['business-logic'])
            .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
            .withDescription(`Express.js service: ${service.name}`)
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
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<ExpressView[]> {
    const views: ExpressView[] = [];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      const viewName = path.basename(file, path.extname(file));
      const engine = path.extname(file).substring(1);
      const layout = this.extractViewLayout(content, engine);
      const partials = this.extractViewPartials(content, engine);
      const variables = this.extractViewVariables(content, engine);

      const view: ExpressView = {
        name: viewName,
        filePath: file,
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
        .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
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
    return content.includes('express.Router()') ||
           content.includes('Router()') ||
           (content.includes('.get(') && content.includes('.post('));
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
      /const\s+(\w+)\s*=\s*express\(\)/,
      /var\s+(\w+)\s*=\s*express\(\)/,
      /let\s+(\w+)\s*=\s*express\(\)/
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

    // Infer from file path
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
    const routePattern = /(?:router|app)\.(\w+)\s*\(\s*['"]([^'"]+)['"](?:,\s*([^,)]+))*,\s*([^,)]+)\s*\)/g;

    let match;
    while ((match = routePattern.exec(content)) !== null) {
      const method = match[1];
      const path = match[2];
      const middleware = match[3] ? [match[3].trim()] : [];
      const handler = match[4];

      if (['get', 'post', 'put', 'delete', 'patch', 'head', 'options'].includes(method)) {
        const parameters = this.extractRouteParameters(path);

        routes.push({
          method,
          path,
          handler: handler.trim(),
          middleware,
          parameters
        });
      }
    }

    return routes;
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
      node.perspectives = [];

      if (node.type === 'express_app' || node.type === 'express_router' ||
          node.type === 'express_route' || node.type === 'express_middleware') {
        node.perspectives.push('express-routes');
      }

      if (node.type === 'express_middleware' || node.type === 'express_route' ||
          node.type === 'express_controller' || node.type === 'express_service') {
        node.perspectives.push('express-layers');
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
}