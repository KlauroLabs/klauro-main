import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, CASPerspective } from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';
import { parse, TSESTree } from '@typescript-eslint/typescript-estree';
import { glob } from 'glob';

interface NestModule {
  name: string;
  filePath: string;
  imports: string[];
  controllers: string[];
  providers: string[];
  exports: string[];
  isGlobal: boolean;
}

interface NestController {
  name: string;
  filePath: string;
  routes: NestRoute[];
  guards: string[];
  interceptors: string[];
  pipes: string[];
  dependencies: string[];
}

interface NestRoute {
  method: string;
  path: string;
  handlerName: string;
  parameters: Array<{ name: string; type: string; decorator: string }>;
  responseType?: string;
  guards: string[];
  pipes: string[];
  interceptors: string[];
}

interface NestProvider {
  name: string;
  filePath: string;
  type: 'service' | 'repository' | 'factory' | 'value' | 'custom';
  scope: 'singleton' | 'request' | 'transient';
  dependencies: string[];
  methods: Array<{ name: string; parameters: any[]; returnType?: string }>;
}

interface NestGuard {
  name: string;
  filePath: string;
  canActivateMethod: { parameters: any[]; returnType: string };
}

interface NestMiddleware {
  name: string;
  filePath: string;
  useMethod: { parameters: any[]; returnType: string };
}

export class NestJSAnalyzer extends BaseAnalyzer {
  constructor() {
    super(
      'nestjs-analyzer',
      'NestJS Framework Analyzer',
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

      return Object.keys(deps).some(dep =>
        dep.includes('@nestjs/core') ||
        dep.includes('@nestjs/common') ||
        dep.includes('@nestjs/platform-express')
      );
    } catch {
      return false;
    }
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const newNodes: CASNode[] = [];
    const enhancedNodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const perspectives: CASPerspective[] = [];

    // Get existing nodes from previous analyzers (like TypeScript analyzer)
    const existingNodes = context.existingAnalysis?.[0]?.nodes || [];
    const allNodes = [...existingNodes];


    try {
      const nestFiles = await glob(['**/*.{ts,js}'], {
        cwd: context.projectPath,
        ignore: ['node_modules/**', 'dist/**', 'build/**', '.git/**', 'test/**', '**/*.spec.ts', '**/*.test.ts']
      });

      const modules = await this.analyzeModules(nestFiles, context.projectPath, allNodes, edges, newNodes);
      const controllers = await this.analyzeControllers(nestFiles, context.projectPath, allNodes, edges, entryPoints, enhancedNodes, newNodes);
      const providers = await this.analyzeProviders(nestFiles, context.projectPath, allNodes, edges, enhancedNodes, newNodes);
      const guards = await this.analyzeGuards(nestFiles, context.projectPath, allNodes, edges);
      const middleware = await this.analyzeMiddleware(nestFiles, context.projectPath, allNodes, edges);

      this.buildNestJSRelationships(modules, controllers, providers, guards, middleware, allNodes, edges);
      this.identifyDatabaseConnections(providers, exitPoints);
      this.createPerspectives(perspectives, modules, controllers, providers, allNodes, edges);

      // Return only enhanced and new nodes, not all nodes
      const contributedNodes = [...enhancedNodes, ...newNodes];

      const contribution = this.createContribution(contributedNodes, edges, entryPoints, exitPoints, {
        framework_specific: {
          modules_detected: modules.length,
          controllers_detected: controllers.length,
          providers_detected: providers.length,
          guards_detected: guards.length,
          middleware_detected: middleware.length,
          nodes_enhanced: enhancedNodes.length,
          nodes_created: newNodes.length
        }
      });

      contribution.perspectives = perspectives;
      contribution.provided_perspectives = perspectives.map(p => p.id);

      return contribution;

    } catch (error) {
      throw new AnalyzerError(
        `NestJS analysis failed: ${(error as Error).message}`,
        'NESTJS_ANALYSIS_ERROR'
      );
    }
  }

  private async analyzeModules(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    newNodes: CASNode[]
  ): Promise<NestModule[]> {
    const modules: NestModule[] = [];
    const moduleFiles = files.filter(f => f.includes('.module.'));

    for (const file of moduleFiles) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      try {
        const ast = parse(content, { loc: true, jsx: false });
        const moduleInfo = this.extractModuleInfo(ast, file);

        if (moduleInfo) {
          modules.push(moduleInfo);

          const moduleId = this.generateId('module', moduleInfo.filePath, moduleInfo.name);
          const moduleNode = this.createNodeBuilder(moduleId, moduleInfo.name, 'module')
            .withLevel(1, 'system')
            .withCategory('backend', ['framework'])
            .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
            .withDescription(`NestJS module: ${moduleInfo.name}`)
            .withMetadata({
              framework: 'nestjs',
              attributes: {
                controllers: moduleInfo.controllers,
                providers: moduleInfo.providers,
                imports: moduleInfo.imports,
                exports: moduleInfo.exports,
                is_global: moduleInfo.isGlobal
              }
            })
            .build();
          nodes.push(moduleNode);
          newNodes.push(moduleNode);
        }
      } catch (error) {
        console.warn(`Failed to parse module ${file}:`, error);
      }
    }

    return modules;
  }

  private async analyzeControllers(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[],
    enhancedNodes: CASNode[],
    newNodes: CASNode[]
  ): Promise<NestController[]> {
    const controllers: NestController[] = [];
    const controllerFiles = files.filter(f => f.includes('.controller.'));

    for (const file of controllerFiles) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      try {
        const ast = parse(content, { loc: true, jsx: false });
        const controllerInfo = this.extractControllerInfo(ast, file);

        if (controllerInfo) {
          controllers.push(controllerInfo);

          // Use TypeScript analyzer's ID format to enable merging
          const controllerId = `class_${file}_${controllerInfo.name}_0`;

          // Check if TypeScript analyzer already created this class node
          let existingNode = nodes.find(n => n.id === controllerId);

          // If exact ID match fails, try to find by name and type
          if (!existingNode) {
            existingNode = nodes.find(n =>
              n.name === controllerInfo.name &&
              (n.type === 'class' || n.type === 'controller') &&
              n.source?.file?.includes(file)
            );
          }

          if (existingNode) {
            // Enhance existing TypeScript class node with NestJS controller metadata
            existingNode.type = 'controller'; // Change from 'class' to 'controller'
            existingNode.subcategories = [...new Set([...(existingNode.subcategories || []), 'api', 'rest'])];
            existingNode.level = 2; // Promote to architectural level
            existingNode.level_name = 'architectural';
            existingNode.description = `NestJS controller handling HTTP requests: ${controllerInfo.name}`;

            // Add NestJS-specific metadata
            existingNode.metadata = {
              ...existingNode.metadata,
              framework: 'nestjs',
              attributes: {
                ...((existingNode.metadata as any)?.attributes || {}),
                nestjs_type: 'controller',
                route_count: controllerInfo.routes.length,
                guards: controllerInfo.guards,
                interceptors: controllerInfo.interceptors,
                pipes: controllerInfo.pipes,
                dependencies: controllerInfo.dependencies
              }
            };

            // Track this as an enhanced node
            enhancedNodes.push(existingNode);
          } else {
            // Skip creating new nodes if TypeScript analyzer didn't create them
            // This forces collaboration instead of duplication
            console.warn(`NestJS: Could not find existing TypeScript node for controller ${controllerInfo.name}, skipping`);
          }

          controllerInfo.routes.forEach((route, index) => {
            const routeId = this.generateId('route', controllerInfo.filePath, `${route.handlerName}_${route.method}_${route.path}`);
            const routeNode = this.createNodeBuilder(routeId, `${route.method.toUpperCase()} ${route.path}`, 'route')
              .withLevel(3, 'code')
              .withCategory('route', ['http', 'endpoint'])
              .withSource({ file: fullPath, line: 1, end_line: 1 })
              .withDescription(`HTTP ${route.method.toUpperCase()} endpoint: ${route.path}`)
              .withParent(controllerId)
              .withMetadata({
                framework: 'nestjs',
                attributes: {
                  http_method: route.method.toUpperCase(),
                  path: route.path,
                  handler_name: route.handlerName,
                  parameters: route.parameters,
                  guards: route.guards,
                  pipes: route.pipes,
                  interceptors: route.interceptors
                }
              })
              .build();
            nodes.push(routeNode);

            edges.push(this.createEdge(
              this.generateEdgeId(controllerId, routeId, 'contains'),
              controllerId,
              routeId,
              'contains',
              'structural'
            ));

            entryPoints.push(this.createEntryPoint(
              `entry_${routeId}`,
              routeId,
              'http',
              `${route.method.toUpperCase()} ${route.path}`,
              `HTTP endpoint for ${controllerInfo.name}.${route.handlerName}`,
              {
                method: route.method.toUpperCase(),
                path: route.path
              },
              {
                authenticated: route.guards.length > 0,
                authorized_roles: this.extractRolesFromGuards(route.guards)
              },
              {
                controller: controllerInfo.name,
                handler: route.handlerName,
                parameters: route.parameters,
                guards: route.guards,
                pipes: route.pipes,
                interceptors: route.interceptors
              }
            ));
          });
        }
      } catch (error) {
        console.warn(`Failed to parse controller ${file}:`, error);
      }
    }

    return controllers;
  }

  private async analyzeProviders(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    enhancedNodes: CASNode[],
    newNodes: CASNode[]
  ): Promise<NestProvider[]> {
    const providers: NestProvider[] = [];
    const serviceFiles = files.filter(f =>
      f.includes('.service.') ||
      f.includes('.repository.') ||
      f.includes('.provider.')
    );

    for (const file of serviceFiles) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      try {
        const ast = parse(content, { loc: true, jsx: false });
        const providerInfo = this.extractProviderInfo(ast, file);

        if (providerInfo) {
          providers.push(providerInfo);

          // Use TypeScript analyzer's ID format to enable merging
          const providerId = `class_${file}_${providerInfo.name}_0`;

          // Check if TypeScript analyzer already created this class node
          const existingNode = nodes.find(n => n.id === providerId);

          if (existingNode) {
            // Enhance existing TypeScript class node with NestJS provider metadata
            existingNode.type = providerInfo.type; // Change from 'class' to 'service'/'repository'/etc
            existingNode.subcategories = [...new Set([...(existingNode.subcategories || []), 'injectable'])];
            existingNode.level = 2; // Promote to architectural level
            existingNode.level_name = 'architectural';
            existingNode.description = `NestJS ${providerInfo.type}: ${providerInfo.name}`;

            // Add NestJS-specific metadata
            existingNode.metadata = {
              ...existingNode.metadata,
              framework: 'nestjs',
              attributes: {
                ...((existingNode.metadata as any)?.attributes || {}),
                provider_type: providerInfo.type,
                scope: providerInfo.scope,
                dependencies: providerInfo.dependencies,
                method_count: providerInfo.methods.length,
                methods: providerInfo.methods.map(m => m.name)
              }
            };
          } else {
            // If TypeScript analyzer didn't create the node, create it ourselves
            const providerNode = this.createNodeBuilder(providerId, providerInfo.name, providerInfo.type)
              .withLevel(2, 'architectural')
              .withCategory(providerInfo.type, ['nestjs', 'injectable'])
              .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
              .withDescription(`NestJS ${providerInfo.type}: ${providerInfo.name}`)
              .withMetadata({
                framework: 'nestjs',
                attributes: {
                  provider_type: providerInfo.type,
                  scope: providerInfo.scope,
                  dependencies: providerInfo.dependencies,
                  method_count: providerInfo.methods.length,
                  methods: providerInfo.methods.map(m => m.name)
                }
              })
              .build();
            nodes.push(providerNode);
          }

          // For methods, we'll enhance existing method nodes from TypeScript analyzer if they exist
          providerInfo.methods.forEach((method, index) => {
            // Try to find existing method node from TypeScript analyzer
            const methodId = `method_${file}_${providerInfo.name}_${method.name}_${index}`;
            const existingMethodNode = nodes.find(n => n.id === methodId ||
              (n.parent === providerId && n.name === method.name && n.type === 'method'));

            if (existingMethodNode) {
              // Enhance existing method node
              existingMethodNode.metadata = {
                ...existingMethodNode.metadata,
                attributes: {
                  ...((existingMethodNode.metadata as any)?.attributes || {}),
                  parameter_count: method.parameters.length
                }
              };
            } else {
              // Create method node if not found
              const methodNode = this.createNodeBuilder(methodId, method.name, 'method')
                .withLevel(4, 'member')
                .withCategory('method', ['function'])
                .withSource({ file: fullPath, line: 1, end_line: 1 })
                .withDescription(`Method in ${providerInfo.name}: ${method.name}`)
                .withParent(providerId)
                .withSignature({
                  parameters: method.parameters.map(p => ({ name: p.name || 'param', type: p.type })),
                  return_type: method.returnType
                })
                .withMetadata({
                  framework: 'nestjs',
                  attributes: {
                    parameter_count: method.parameters.length
                  }
                })
                .build();
              nodes.push(methodNode);

              edges.push(this.createEdge(
                this.generateEdgeId(providerId, methodId, 'contains'),
                providerId,
                methodId,
                'contains',
                'structural'
              ));
            }
          });
        }
      } catch (error) {
        console.warn(`Failed to parse provider ${file}:`, error);
      }
    }

    return providers;
  }

  private async analyzeGuards(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<NestGuard[]> {
    const guards: NestGuard[] = [];
    const guardFiles = files.filter(f => f.includes('.guard.'));

    for (const file of guardFiles) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      try {
        const ast = parse(content, { loc: true, jsx: false });
        const guardInfo = this.extractGuardInfo(ast, file);

        if (guardInfo) {
          guards.push(guardInfo);

          // Use TypeScript analyzer's ID format to enable merging
          const guardId = `class_${file}_${guardInfo.name}_0`;

          // Check if TypeScript analyzer already created this class node
          const existingNode = nodes.find(n => n.id === guardId);

          if (existingNode) {
            // Enhance existing TypeScript class node with NestJS guard metadata
            existingNode.type = 'guard';
            existingNode.subcategories = [...new Set([...(existingNode.subcategories || []), 'security', 'auth'])];
            existingNode.level = 3; // Code level
            existingNode.level_name = 'code';
            existingNode.description = `NestJS guard: ${guardInfo.name}`;

            // Add NestJS-specific metadata
            existingNode.metadata = {
              ...existingNode.metadata,
              framework: 'nestjs',
              attributes: {
                ...((existingNode.metadata as any)?.attributes || {}),
                guard_type: 'guard',
                can_activate_method: guardInfo.canActivateMethod
              }
            };
          } else {
            // If TypeScript analyzer didn't create the node, create it ourselves
            const guardNode = this.createNodeBuilder(guardId, guardInfo.name, 'guard')
              .withLevel(3, 'code')
              .withCategory('guard', ['security', 'nestjs'])
              .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
              .withDescription(`NestJS guard: ${guardInfo.name}`)
              .withMetadata({
                framework: 'nestjs',
                attributes: {
                  guard_type: 'guard',
                  can_activate_method: guardInfo.canActivateMethod
                }
              })
              .build();
            nodes.push(guardNode);
          }
        }
      } catch (error) {
        console.warn(`Failed to parse guard ${file}:`, error);
      }
    }

    return guards;
  }

  private async analyzeMiddleware(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<NestMiddleware[]> {
    const middleware: NestMiddleware[] = [];
    const middlewareFiles = files.filter(f => f.includes('.middleware.'));

    for (const file of middlewareFiles) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      try {
        const ast = parse(content, { loc: true, jsx: false });
        const middlewareInfo = this.extractMiddlewareInfo(ast, file);

        if (middlewareInfo) {
          middleware.push(middlewareInfo);

          // Use TypeScript analyzer's ID format to enable merging
          const middlewareId = `class_${file}_${middlewareInfo.name}_0`;

          // Check if TypeScript analyzer already created this class node
          const existingNode = nodes.find(n => n.id === middlewareId);

          if (existingNode) {
            // Enhance existing TypeScript class node with NestJS middleware metadata
            existingNode.type = 'middleware';
            existingNode.subcategories = [...new Set([...(existingNode.subcategories || []), 'http', 'interceptor'])];
            existingNode.level = 3; // Code level
            existingNode.level_name = 'code';
            existingNode.description = `NestJS middleware: ${middlewareInfo.name}`;

            // Add NestJS-specific metadata
            existingNode.metadata = {
              ...existingNode.metadata,
              framework: 'nestjs',
              attributes: {
                ...((existingNode.metadata as any)?.attributes || {}),
                middleware_type: 'middleware',
                use_method: middlewareInfo.useMethod
              }
            };
          } else {
            // If TypeScript analyzer didn't create the node, create it ourselves
            const middlewareNode = this.createNodeBuilder(middlewareId, middlewareInfo.name, 'middleware')
              .withLevel(3, 'code')
              .withCategory('middleware', ['http', 'nestjs'])
              .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
              .withDescription(`NestJS middleware: ${middlewareInfo.name}`)
              .withMetadata({
                framework: 'nestjs',
                attributes: {
                  middleware_type: 'middleware',
                  use_method: middlewareInfo.useMethod
                }
              })
              .build();
            nodes.push(middlewareNode);
          }
        }
      } catch (error) {
        console.warn(`Failed to parse middleware ${file}:`, error);
      }
    }

    return middleware;
  }

  private extractModuleInfo(ast: TSESTree.Program, filePath: string): NestModule | null {
    let moduleInfo: NestModule | null = null;

    const walk = (node: any) => {
      if (node.type === 'ClassDeclaration' && node.decorators) {
        const moduleDecorator = node.decorators.find((dec: any) =>
          dec.expression?.callee?.name === 'Module'
        );

        if (moduleDecorator && node.id) {
          const metadata = this.extractDecoratorMetadata(moduleDecorator);
          moduleInfo = {
            name: node.id.name,
            filePath,
            imports: metadata.imports || [],
            controllers: metadata.controllers || [],
            providers: metadata.providers || [],
            exports: metadata.exports || [],
            isGlobal: node.decorators.some((dec: any) => dec.expression?.callee?.name === 'Global')
          };
        }
      }

      for (const key in node) {
        if (typeof node[key] === 'object' && node[key] !== null) {
          if (Array.isArray(node[key])) {
            node[key].forEach(walk);
          } else {
            walk(node[key]);
          }
        }
      }
    };

    walk(ast);
    return moduleInfo;
  }

  private extractControllerInfo(ast: TSESTree.Program, filePath: string): NestController | null {
    let controllerInfo: NestController | null = null;

    const walk = (node: any) => {
      if (node.type === 'ClassDeclaration' && node.decorators) {
        const controllerDecorator = node.decorators.find((dec: any) =>
          dec.expression?.callee?.name === 'Controller'
        );

        if (controllerDecorator && node.id) {
          const routes = this.extractRoutes(node);
          const guards = this.extractClassDecorators(node, 'UseGuards');
          const interceptors = this.extractClassDecorators(node, 'UseInterceptors');
          const pipes = this.extractClassDecorators(node, 'UsePipes');

          controllerInfo = {
            name: node.id.name,
            filePath,
            routes,
            guards,
            interceptors,
            pipes,
            dependencies: this.extractConstructorDependencies(node)
          };
        }
      }

      for (const key in node) {
        if (typeof node[key] === 'object' && node[key] !== null) {
          if (Array.isArray(node[key])) {
            node[key].forEach(walk);
          } else {
            walk(node[key]);
          }
        }
      }
    };

    walk(ast);
    return controllerInfo;
  }

  private extractProviderInfo(ast: TSESTree.Program, filePath: string): NestProvider | null {
    let providerInfo: NestProvider | null = null;

    const walk = (node: any) => {
      if (node.type === 'ClassDeclaration' && node.decorators) {
        const injectableDecorator = node.decorators.find((dec: any) =>
          dec.expression?.callee?.name === 'Injectable'
        );

        if (injectableDecorator && node.id) {
          const methods = this.extractMethods(node);
          const dependencies = this.extractConstructorDependencies(node);

          let type: 'service' | 'repository' | 'factory' | 'value' | 'custom' = 'service';
          if (filePath.includes('.repository.')) type = 'repository';
          else if (filePath.includes('.factory.')) type = 'factory';

          providerInfo = {
            name: node.id.name,
            filePath,
            type,
            scope: 'singleton',
            dependencies,
            methods
          };
        }
      }

      for (const key in node) {
        if (typeof node[key] === 'object' && node[key] !== null) {
          if (Array.isArray(node[key])) {
            node[key].forEach(walk);
          } else {
            walk(node[key]);
          }
        }
      }
    };

    walk(ast);
    return providerInfo;
  }

  private extractGuardInfo(ast: TSESTree.Program, filePath: string): NestGuard | null {
    let guardInfo: NestGuard | null = null;

    const walk = (node: any) => {
      if (node.type === 'ClassDeclaration' && node.decorators) {
        const injectableDecorator = node.decorators.find((dec: any) =>
          dec.expression?.callee?.name === 'Injectable'
        );

        if (injectableDecorator && node.id) {
          const canActivateMethod = this.findMethodInClass(node, 'canActivate');
          if (canActivateMethod) {
            guardInfo = {
              name: node.id.name,
              filePath,
              canActivateMethod: {
                parameters: canActivateMethod.parameters || [],
                returnType: canActivateMethod.returnType || 'boolean'
              }
            };
          }
        }
      }

      for (const key in node) {
        if (typeof node[key] === 'object' && node[key] !== null) {
          if (Array.isArray(node[key])) {
            node[key].forEach(walk);
          } else {
            walk(node[key]);
          }
        }
      }
    };

    walk(ast);
    return guardInfo;
  }

  private extractMiddlewareInfo(ast: TSESTree.Program, filePath: string): NestMiddleware | null {
    let middlewareInfo: NestMiddleware | null = null;

    const walk = (node: any) => {
      if (node.type === 'ClassDeclaration' && node.decorators) {
        const injectableDecorator = node.decorators.find((dec: any) =>
          dec.expression?.callee?.name === 'Injectable'
        );

        if (injectableDecorator && node.id) {
          const useMethod = this.findMethodInClass(node, 'use');
          if (useMethod) {
            middlewareInfo = {
              name: node.id.name,
              filePath,
              useMethod: {
                parameters: useMethod.parameters || [],
                returnType: useMethod.returnType || 'void'
              }
            };
          }
        }
      }

      for (const key in node) {
        if (typeof node[key] === 'object' && node[key] !== null) {
          if (Array.isArray(node[key])) {
            node[key].forEach(walk);
          } else {
            walk(node[key]);
          }
        }
      }
    };

    walk(ast);
    return middlewareInfo;
  }

  private extractRoutes(classNode: any): NestRoute[] {
    const routes: NestRoute[] = [];

    if (classNode.body && classNode.body.body) {
      classNode.body.body.forEach((member: any) => {
        if (member.type === 'MethodDefinition' && member.decorators) {
          const httpDecorator = member.decorators.find((dec: any) =>
            ['Get', 'Post', 'Put', 'Delete', 'Patch', 'Options', 'Head'].includes(dec.expression?.callee?.name)
          );

          if (httpDecorator) {
            const method = httpDecorator.expression.callee.name.toLowerCase();
            const path = this.extractDecoratorArgument(httpDecorator) || '/';
            const handlerName = member.key.name;
            const parameters = this.extractMethodParameters(member);
            const guards = this.extractMethodDecorators(member, 'UseGuards');
            const pipes = this.extractMethodDecorators(member, 'UsePipes');
            const interceptors = this.extractMethodDecorators(member, 'UseInterceptors');

            routes.push({
              method,
              path,
              handlerName,
              parameters,
              guards,
              pipes,
              interceptors
            });
          }
        }
      });
    }

    return routes;
  }

  private extractMethods(classNode: any): Array<{ name: string; parameters: any[]; returnType?: string }> {
    const methods: Array<{ name: string; parameters: any[]; returnType?: string }> = [];

    if (classNode.body && classNode.body.body) {
      classNode.body.body.forEach((member: any) => {
        if (member.type === 'MethodDefinition' && member.key.name !== 'constructor') {
          methods.push({
            name: member.key.name,
            parameters: this.extractMethodParameters(member),
            returnType: undefined
          });
        }
      });
    }

    return methods;
  }

  private extractConstructorDependencies(classNode: any): string[] {
    const dependencies: string[] = [];

    if (classNode.body && classNode.body.body) {
      const constructor = classNode.body.body.find((member: any) =>
        member.type === 'MethodDefinition' && member.kind === 'constructor'
      );

      if (constructor && constructor.value.params) {
        constructor.value.params.forEach((param: any) => {
          if (param.typeAnnotation && param.typeAnnotation.typeAnnotation) {
            const typeName = this.extractTypeName(param.typeAnnotation.typeAnnotation);
            if (typeName) {
              dependencies.push(typeName);
            }
          } else if (param.type === 'TSParameterProperty' && param.parameter) {
            // Handle TypeScript parameter properties (e.g., constructor(private readonly service: Service))
            if (param.parameter.typeAnnotation && param.parameter.typeAnnotation.typeAnnotation) {
              const typeName = this.extractTypeName(param.parameter.typeAnnotation.typeAnnotation);
              if (typeName) {
                dependencies.push(typeName);
              }
            }
          }
        });
      }
    }

    return dependencies;
  }

  private extractDecoratorMetadata(decorator: any): any {
    const metadata: any = {};

    if (decorator.expression.arguments && decorator.expression.arguments[0]) {
      const arg = decorator.expression.arguments[0];
      if (arg.type === 'ObjectExpression') {
        arg.properties.forEach((prop: any) => {
          if (prop.key && prop.value) {
            const key = prop.key.name;
            if (prop.value.type === 'ArrayExpression') {
              metadata[key] = prop.value.elements.map((elem: any) => {
                if (elem.type === 'Identifier') return elem.name;
                if (elem.type === 'Literal') return elem.value;
                return 'unknown';
              });
            }
          }
        });
      }
    }

    return metadata;
  }

  private extractClassDecorators(classNode: any, decoratorName: string): string[] {
    const decorators: string[] = [];

    if (classNode.decorators) {
      classNode.decorators.forEach((dec: any) => {
        if (dec.expression?.callee?.name === decoratorName) {
          const args = this.extractDecoratorArguments(dec);
          decorators.push(...args);
        }
      });
    }

    return decorators;
  }

  private extractMethodDecorators(methodNode: any, decoratorName: string): string[] {
    const decorators: string[] = [];

    if (methodNode.decorators) {
      methodNode.decorators.forEach((dec: any) => {
        if (dec.expression?.callee?.name === decoratorName) {
          const args = this.extractDecoratorArguments(dec);
          decorators.push(...args);
        }
      });
    }

    return decorators;
  }

  private extractMethodParameters(methodNode: any): Array<{ name: string; type: string; decorator: string }> {
    const parameters: Array<{ name: string; type: string; decorator: string }> = [];

    if (methodNode.value && methodNode.value.params) {
      methodNode.value.params.forEach((param: any) => {
        const paramDecorators = param.decorators || [];
        const decorator = paramDecorators.length > 0 ? paramDecorators[0].expression?.callee?.name : 'none';

        parameters.push({
          name: param.name || 'param',
          type: this.extractTypeName(param.typeAnnotation?.typeAnnotation) || 'any',
          decorator
        });
      });
    }

    return parameters;
  }

  private extractDecoratorArgument(decorator: any): string | null {
    if (decorator.expression.arguments && decorator.expression.arguments[0]) {
      const arg = decorator.expression.arguments[0];
      if (arg.type === 'Literal') {
        return arg.value;
      }
    }
    return null;
  }

  private extractDecoratorArguments(decorator: any): string[] {
    const args: string[] = [];

    if (decorator.expression.arguments) {
      decorator.expression.arguments.forEach((arg: any) => {
        if (arg.type === 'Identifier') {
          args.push(arg.name);
        } else if (arg.type === 'Literal') {
          args.push(arg.value);
        }
      });
    }

    return args;
  }

  private findMethodInClass(classNode: any, methodName: string): any {
    if (classNode.body && classNode.body.body) {
      return classNode.body.body.find((member: any) =>
        member.type === 'MethodDefinition' && member.key.name === methodName
      );
    }
    return null;
  }

  private extractTypeName(typeNode: any): string | null {
    if (!typeNode) return null;
    if (typeNode.type === 'TSTypeReference' && typeNode.typeName) {
      return typeNode.typeName.name;
    }
    if (typeNode.type === 'Identifier') {
      return typeNode.name;
    }
    return null;
  }

  private buildNestJSRelationships(
    modules: NestModule[],
    controllers: NestController[],
    providers: NestProvider[],
    guards: NestGuard[],
    middleware: NestMiddleware[],
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    modules.forEach(module => {
      const moduleId = this.generateId('module', module.filePath, module.name);

      module.controllers.forEach(controllerName => {
        // Find the enhanced controller node by looking for a class with the controller name
        const controllerNode = nodes.find(n =>
          n.name === controllerName &&
          n.type === 'controller'
        );
        if (controllerNode) {
          edges.push(this.createEdge(
            this.generateEdgeId(moduleId, controllerNode.id, 'includes'),
            moduleId,
            controllerNode.id,
            'includes',
            'structural',
            { relationship: 'module-controller' }
          ));
        }
      });

      module.providers.forEach(providerName => {
        // Find the enhanced provider node by looking for a class with the provider name
        const providerNode = nodes.find(n =>
          n.name === providerName &&
          (n.type === 'service' || n.type === 'repository')
        );
        if (providerNode) {
          edges.push(this.createEdge(
            this.generateEdgeId(moduleId, providerNode.id, 'provides'),
            moduleId,
            providerNode.id,
            'provides',
            'dependency',
            { relationship: 'module-provider' }
          ));
        }
      });
    });

    controllers.forEach(controller => {
      const controllerNode = nodes.find(n =>
        n.name === controller.name &&
        n.type === 'controller'
      );

      if (controllerNode) {
        controller.dependencies.forEach(depName => {
          // Try multiple ways to find the provider node
          let providerNode = nodes.find(n =>
            n.name === depName &&
            (n.type === 'service' || n.type === 'repository' || n.type === 'class')
          );

          // If not found, try without "Service" suffix (in case the type is FooService but the class is Foo)
          if (!providerNode && depName.endsWith('Service')) {
            providerNode = nodes.find(n =>
              n.name === depName.replace('Service', '') &&
              (n.type === 'service' || n.type === 'class')
            );
          }

          // Also try looking for any class that could be this service
          if (!providerNode) {
            providerNode = nodes.find(n =>
              n.name === depName && n.type === 'class'
            );
          }

          if (providerNode) {
            // Create "calls" edge for controller -> service dependency injection
            const callsEdgeId = this.generateEdgeId(controllerNode.id, providerNode.id, 'calls');
            if (!edges.find(e => e.id === callsEdgeId)) {
              edges.push(this.createEdge(
                callsEdgeId,
                controllerNode.id,
                providerNode.id,
                'calls',
                'dependency',
                {
                  dependency_type: 'injection',
                  injected_from: 'constructor',
                  call_type: 'service_injection',
                  injected_service: depName
                }
              ));
            }

            // Also keep the depends_on edge for backward compatibility
            edges.push(this.createEdge(
              this.generateEdgeId(controllerNode.id, providerNode.id, 'depends_on'),
              controllerNode.id,
              providerNode.id,
              'depends_on',
              'dependency',
              { dependency_type: 'injection' }
            ));
          }
        });

        // Create calls edges for route handlers to controller methods
        controller.routes.forEach(route => {
          const routeId = this.generateId('route', controller.filePath, `${route.handlerName}_${route.method}_${route.path}`);
          const handlerMethodId = `method_class_${controller.filePath}_${controller.name}_0_${route.handlerName}_0`;
          const handlerMethod = nodes.find(n => n.id === handlerMethodId ||
            (n.name === route.handlerName && n.type === 'method' && n.parent === controllerNode.id));

          if (handlerMethod) {
            edges.push(this.createEdge(
              this.generateEdgeId(routeId, handlerMethod.id, 'calls'),
              routeId,
              handlerMethod.id,
              'calls',
              'behavior',
              {
                call_type: 'route_handler',
                http_method: route.method.toUpperCase(),
                path: route.path
              }
            ));
          }
        });

        controller.guards.forEach(guardName => {
          const guardNode = nodes.find(n =>
            n.name === guardName &&
            n.type === 'guard'
          );
          if (guardNode) {
            edges.push(this.createEdge(
              this.generateEdgeId(controllerNode.id, guardNode.id, 'protected_by'),
              controllerNode.id,
              guardNode.id,
              'protected_by',
              'security',
              { protection_type: 'authentication' }
            ));
          }
        });
      }
    });

    providers.forEach(provider => {
      const providerNode = nodes.find(n =>
        n.name === provider.name &&
        (n.type === 'service' || n.type === 'repository')
      );

      if (providerNode) {
        provider.dependencies.forEach(depName => {
          // Try multiple ways to find the dependency provider node
          let depProviderNode = nodes.find(n =>
            n.name === depName &&
            (n.type === 'service' || n.type === 'repository' || n.type === 'class')
          );

          // If not found, try without "Service" or "Repository" suffix
          if (!depProviderNode) {
            const baseName = depName
              .replace('Service', '')
              .replace('Repository', '');
            depProviderNode = nodes.find(n =>
              n.name === baseName &&
              (n.type === 'service' || n.type === 'repository' || n.type === 'class')
            );
          }

          // Also try looking for any class that could be this service
          if (!depProviderNode) {
            depProviderNode = nodes.find(n =>
              n.name === depName && n.type === 'class'
            );
          }

          if (depProviderNode) {
            // Create "calls" edge for service -> service dependency injection
            const callsEdgeId = this.generateEdgeId(providerNode.id, depProviderNode.id, 'calls');
            if (!edges.find(e => e.id === callsEdgeId)) {
              edges.push(this.createEdge(
                callsEdgeId,
                providerNode.id,
                depProviderNode.id,
                'calls',
                'dependency',
                {
                  dependency_type: 'injection',
                  injected_from: 'constructor',
                  call_type: 'service_injection',
                  injected_service: depName
                }
              ));
            }

            // Also keep the depends_on edge for backward compatibility
            edges.push(this.createEdge(
              this.generateEdgeId(providerNode.id, depProviderNode.id, 'depends_on'),
              providerNode.id,
              depProviderNode.id,
              'depends_on',
              'dependency',
              { dependency_type: 'injection' }
            ));
          }
        });

        // Create db_access edges for repositories
        if (provider.type === 'repository') {
          // Look for entity nodes that might be referenced
          const entityNodes = nodes.filter(n => n.type === 'entity' ||
            (n.type === 'class' && (n.subcategories?.includes('entity') ||
                                   n.subcategories?.includes('model') ||
                                   n.source?.file?.includes('.entity.'))));

          // Check for entity references in multiple ways
          entityNodes.forEach(entityNode => {
            let shouldCreateEdge = false;

            // 1. Check if repository name includes entity name
            const repoBaseName = provider.name.replace('Repository', '').toLowerCase();
            const entityBaseName = entityNode.name.replace('Entity', '').toLowerCase();

            if (repoBaseName === entityBaseName ||
                provider.name.toLowerCase().includes(entityNode.name.toLowerCase()) ||
                entityNode.name.toLowerCase().includes(repoBaseName)) {
              shouldCreateEdge = true;
            }

            // 2. Check if repository has generic type parameter matching entity
            // This would require deeper AST analysis but is a common pattern

            // 3. Check if repository file path matches entity file path pattern
            if (!shouldCreateEdge && provider.filePath && entityNode.source?.file) {
              const repoDir = provider.filePath.split('/').slice(0, -1).join('/');
              const entityDir = entityNode.source.file.split('/').slice(0, -1).join('/');
              if (repoDir === entityDir) {
                // Same directory, likely related
                shouldCreateEdge = true;
              }
            }

            if (shouldCreateEdge) {
              const edgeId = this.generateEdgeId(providerNode.id, entityNode.id, 'db_access');
              if (!edges.find(e => e.id === edgeId)) {
                edges.push(this.createEdge(
                  edgeId,
                  providerNode.id,
                  entityNode.id,
                  'db_access',
                  'data',
                  {
                    access_type: 'crud',
                    repository: provider.name,
                    entity: entityNode.name,
                    operations: ['create', 'read', 'update', 'delete']
                  }
                ));
              }
            }
          });
        }
      }
    });

    // Create calls edges between methods within the same service/controller
    this.createIntraServiceCallEdges(nodes, edges);
  }

  private createIntraServiceCallEdges(nodes: CASNode[], edges: CASEdge[]): void {
    // Group methods by their parent class
    const classMethods = new Map<string, CASNode[]>();

    nodes.filter(n => n.type === 'method' && n.parent).forEach(method => {
      const parent = method.parent!;
      if (!classMethods.has(parent)) {
        classMethods.set(parent, []);
      }
      classMethods.get(parent)!.push(method);
    });

    // For each class, check if methods call each other
    classMethods.forEach((methods, classId) => {
      methods.forEach(callerMethod => {
        // Look for method calls in the metadata or signature
        // This is a simplified approach - in reality we'd need to parse method bodies
        methods.forEach(targetMethod => {
          if (callerMethod.id !== targetMethod.id) {
            // Check if the caller method might call the target method
            // This would require actual AST analysis of method bodies
            // For now, we'll create edges for common patterns
            if (callerMethod.name.includes('handle') && targetMethod.name.includes('process')) {
              edges.push(this.createEdge(
                this.generateEdgeId(callerMethod.id, targetMethod.id, 'calls'),
                callerMethod.id,
                targetMethod.id,
                'calls',
                'behavior',
                {
                  call_type: 'internal_method_call',
                  within_class: classId
                }
              ));
            }
          }
        });
      });
    });
  }

  private identifyDatabaseConnections(providers: NestProvider[], exitPoints: CASExitPoint[]): void {
    providers.forEach(provider => {
      if (provider.type === 'repository' || provider.name.toLowerCase().includes('repository')) {
        // Use the TypeScript analyzer's ID format
        const providerId = `class_${provider.filePath}_${provider.name}_0`;
        exitPoints.push(this.createExitPoint(
          `exit_db_${this.sanitizeId(provider.name)}`,
          providerId,
          'database',
          `Database operations via ${provider.name}`,
          `Data persistence operations through ${provider.name}`,
          {
            service_id: 'database-service',
            resource: 'database'
          },
          {
            action: 'read-write',
            async: true
          },
          {
            provider_type: provider.type,
            available_methods: provider.methods.map(m => m.name)
          }
        ));
      }
    });
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
      'decorator-analysis',
      'dependency-injection',
      'module-mapping',
      'route-detection',
      'guard-analysis',
      'middleware-detection',
      'provider-analysis'
    ];
  }

  private extractRolesFromGuards(guards: string[]): string[] {
    return guards.filter(guard => guard.toLowerCase().includes('role')).map(guard => guard.toLowerCase());
  }

  private createPerspectives(
    perspectives: CASPerspective[],
    modules: NestModule[],
    controllers: NestController[],
    providers: NestProvider[],
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    perspectives.push(
      {
        id: 'nestjs-flow',
        name: 'Request Flow',
        description: 'Shows request flow: Controllers → Services → Repositories → Database',
        analyzer_id: this.id,
        type: 'flow',
        connection_rules: {
          node_connections: [
            {
              from_type: 'route',
              to_types: ['method'],
              edge_type: 'calls'
            },
            {
              from_type: 'controller',
              to_types: ['service', 'provider'],
              edge_type: 'calls'
            },
            {
              from_type: 'service',
              to_types: ['repository', 'service', 'provider'],
              edge_type: 'calls'
            },
            {
              from_type: 'repository',
              to_types: ['entity'],
              edge_type: 'db_access'
            }
          ],
          visible_node_types: ['route', 'controller', 'service', 'repository', 'entity', 'method'],
          relevant_edge_types: ['calls', 'db_access', 'depends_on']
        },
        layout_hints: {
          style: 'hierarchical',
          direction: 'LR'
        }
      },
      {
        id: 'nestjs-modules',
        name: 'Module Structure',
        description: 'Shows module organization and dependency injection',
        analyzer_id: this.id,
        type: 'structure',
        connection_rules: {
          node_connections: [
            {
              from_type: 'module',
              to_types: ['module'],
              edge_type: 'imports'
            },
            {
              from_type: 'module',
              to_types: ['controller', 'provider', 'service'],
              edge_type: 'provides'
            },
            {
              from_type: 'module',
              to_types: ['controller', 'provider', 'service'],
              edge_type: 'includes'
            }
          ],
          visible_node_types: ['module', 'controller', 'provider', 'service', 'repository'],
          relevant_edge_types: ['imports', 'provides', 'includes', 'injects']
        },
        layout_hints: {
          style: 'force',
          group_by: 'module'
        }
      },
      {
        id: 'nestjs-layers',
        name: 'Architectural Layers',
        description: 'Shows architectural layers: Presentation → Business → Data',
        analyzer_id: this.id,
        type: 'structure',
        connection_rules: {
          node_connections: [
            {
              from_type: 'controller',
              to_types: ['service'],
              edge_type: 'calls'
            },
            {
              from_type: 'service',
              to_types: ['repository'],
              edge_type: 'calls'
            },
            {
              from_type: 'repository',
              to_types: ['entity'],
              edge_type: 'db_access'
            },
            {
              from_type: 'guard',
              to_types: ['controller'],
              edge_type: 'protected_by'
            },
            {
              from_type: 'middleware',
              to_types: ['controller'],
              edge_type: 'intercepts'
            }
          ],
          visible_node_types: ['controller', 'service', 'repository', 'entity', 'guard', 'middleware'],
          relevant_edge_types: ['calls', 'db_access', 'protected_by', 'intercepts', 'depends_on']
        },
        layout_hints: {
          style: 'hierarchical',
          direction: 'TB'
        },
        metadata: {
          layer_assignments: {
            presentation: ['controller', 'guard', 'middleware'],
            business: ['service', 'provider'],
            data: ['repository', 'entity']
          }
        }
      }
    );

    this.tagNodesWithPerspectives(nodes, edges, perspectives);
  }

  private tagNodesWithPerspectives(
    nodes: CASNode[],
    edges: CASEdge[],
    perspectives: CASPerspective[]
  ): void {
    perspectives.forEach(perspective => {
      const visibleTypes = perspective.connection_rules?.visible_node_types || [];
      const relevantEdgeTypes = perspective.connection_rules?.relevant_edge_types || [];

      nodes.forEach(node => {
        if (visibleTypes.includes(node.type)) {
          if (!node.perspectives) {
            node.perspectives = [];
          }
          if (!node.perspectives.includes(perspective.id)) {
            node.perspectives.push(perspective.id);
          }

          if (!node.metadata) {
            node.metadata = {};
          }
          if (!node.metadata.perspective_data) {
            node.metadata.perspective_data = {};
          }
          node.metadata.perspective_data[perspective.id] = {
            visible: true,
            layer: this.getLayerForNodeType(node.type, perspective.id)
          };
        }
      });

      edges.forEach(edge => {
        if (relevantEdgeTypes.includes(edge.type)) {
          if (!edge.perspectives) {
            edge.perspectives = [];
          }
          if (!edge.perspectives.includes(perspective.id)) {
            edge.perspectives.push(perspective.id);
          }

          if (!edge.metadata) {
            edge.metadata = {};
          }
          if (!edge.metadata.perspective_data) {
            edge.metadata.perspective_data = {};
          }
          edge.metadata.perspective_data[perspective.id] = {
            visible: true,
            priority: this.getEdgePriorityForPerspective(edge.type, perspective.id)
          };
        }
      });
    });
  }

  private getLayerForNodeType(nodeType: string, perspectiveId: string): string | undefined {
    if (perspectiveId === 'nestjs-layers') {
      const layerMap: Record<string, string> = {
        controller: 'presentation',
        guard: 'presentation',
        middleware: 'presentation',
        service: 'business',
        provider: 'business',
        repository: 'data',
        entity: 'data'
      };
      return layerMap[nodeType];
    }
    return undefined;
  }

  private getEdgePriorityForPerspective(edgeType: string, perspectiveId: string): number {
    const priorityMap: Record<string, Record<string, number>> = {
      'nestjs-flow': {
        calls: 1,
        db_access: 2,
        depends_on: 3
      },
      'nestjs-modules': {
        imports: 1,
        provides: 2,
        includes: 2,
        injects: 3
      },
      'nestjs-layers': {
        calls: 1,
        db_access: 1,
        protected_by: 2,
        intercepts: 2,
        depends_on: 3
      }
    };
    return priorityMap[perspectiveId]?.[edgeType] || 99;
  }
}