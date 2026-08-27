import { BaseAnalyzer, AnalysisContext, FileAnalysisContext, FileAnalysisResult } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, CASPerspective,
  CASDocumentation, CASComment, CASTodo, CASImplementationStatus} from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import { isAuthenticationGuardName } from '../../core/guard-classification';
import * as path from 'path';
import * as fs from 'fs-extra';
import { TSESTree } from '@typescript-eslint/typescript-estree';
import { cachedEstreeParse as parse } from '../../core/estree-parse-cache';
import { cachedGlob as glob } from '../../core/glob-cache';

const HTTP_DECORATOR_PATTERNS = [
  /^(Get|Post|Put|Delete|Patch|Options|Head)$/,
  /^Api(Get|Post|Put|Delete|Patch|Options|Head)$/i,
  /^Service(Get|Post|Put|Delete|Patch|Options|Head)$/i,
  /^M2M(Get|Post|Put|Delete|Patch|Options|Head)$/i,
  /^(Get|Post|Put|Delete|Patch)Route$/i,
  /^(Get|Post|Put|Delete|Patch)Endpoint$/i,
  /^Http(Get|Post|Put|Delete|Patch)$/i
];

const CONTROLLER_PATTERNS = [
  /^Controller$/,
  /^ApiController$/i,
  /^RestController$/i,
  /^HttpController$/i,
  /^BaseController$/i
];

const HTTP_METHOD_MAP: Record<string, string> = {
  'get': 'get', 'apiget': 'get', 'serviceget': 'get', 'm2mget': 'get',
  'post': 'post', 'apipost': 'post', 'servicepost': 'post', 'm2mpost': 'post',
  'put': 'put', 'apiput': 'put', 'serviceput': 'put', 'm2mput': 'put',
  'delete': 'delete', 'apidelete': 'delete', 'servicedelete': 'delete', 'm2mdelete': 'delete',
  'patch': 'patch', 'apipatch': 'patch', 'servicepatch': 'patch', 'm2mpatch': 'patch',
  'options': 'options', 'head': 'head'
};

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
  basePath: string;
  routes: NestRoute[];
  guards: string[];
  interceptors: string[];
  pipes: string[];
  dependencies: string[];
  decorators: string[];
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
  decorators: string[];
}

interface NestGlobalGuardRegistration {
  guardName: string;
  file: string;
  appScope: string | null;
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
  private globalGuardCache = new Map<string, NestGlobalGuardRegistration[]>();

  constructor() {
    super(
      'nestjs',
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

  supportsIncrementalAnalysis(): boolean { return false; }
  incrementalSourceInvariantContributionFields(): readonly (keyof CASContribution)[] { return ['perspectives']; }
  async getRelevantFiles(projectPath: string): Promise<string[]> {
    return glob(['**/*.{ts,js}'], {
      cwd: projectPath,
      ignore: [
        ...this.getIgnorePatterns({ projectPath }),
        '**/test/**',
        '**/*.spec.ts',
        '**/*.test.ts'
      ],
      nodir: true
    });
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const newNodes: CASNode[] = [];
    const enhancedNodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const file = context.relativePath;
    const content = await fs.readFile(context.filePath, 'utf-8');
    const stat = await fs.stat(context.filePath);
    const existingNodes = context.existingAnalysis?.flatMap(contribution => contribution.nodes || []) || [];
    const allNodes = [...existingNodes];

    const modules = await this.analyzeModules([file], context.projectPath, allNodes, edges, newNodes);
    const incrementalGlobalGuards = await this.detectGlobalGuardRegistrations([file], context.projectPath);
    const controllers = await this.analyzeControllers([file], context.projectPath, allNodes, edges, entryPoints, enhancedNodes, newNodes, incrementalGlobalGuards);
    const providers = await this.analyzeProviders([file], context.projectPath, allNodes, edges, enhancedNodes, newNodes);
    const guards = await this.analyzeGuards([file], context.projectPath, allNodes, edges, enhancedNodes, newNodes);
    const middleware = await this.analyzeMiddleware([file], context.projectPath, allNodes, edges, enhancedNodes, newNodes);
    await this.analyzeEntryPoints([file], context.projectPath, allNodes, edges, entryPoints, newNodes);
    this.buildNestJSRelationships(modules, controllers, providers, guards, middleware, allNodes, newNodes, edges, exitPoints);
    this.identifyDatabaseConnections(providers, allNodes, exitPoints);
    this.createPerspectives([], modules, controllers, providers, guards, middleware, allNodes, edges);

    const contributedNodes = [...enhancedNodes, ...newNodes].filter(node => {
      const nodeFile = node.source?.file;
      if (!nodeFile) return true;
      return nodeFile === file || nodeFile.endsWith(`/${file}`);
    });

    return this.createFileAnalysisResult(
      context.filePath,
      file,
      context.contentHash || this.computeContentHash(content),
      stat.mtimeMs,
      contributedNodes,
      edges,
      entryPoints,
      exitPoints,
      this.extractImportsForIncremental(content),
      [...new Set(contributedNodes.map(node => node.name))]
    );
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const newNodes: CASNode[] = [];
    const enhancedNodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const perspectives: CASPerspective[] = [];
    const timings: Record<string, number> = {};
    let t = Date.now();

    const existingNodes = context.existingAnalysis?.[0]?.nodes || [];
    const allNodes = [...existingNodes];

    try {

      const ignorePatterns = [
        ...this.getIgnorePatterns(context),
        '**/test/**',
        '**/*.spec.ts',
        '**/*.test.ts'
      ];

      const nestFiles = this.capAndPrioritizeSourceFiles(await glob(['**/*.{ts,js}'], {
        cwd: context.projectPath,
        ignore: ignorePatterns,
        nodir: true
      }), 'NestJS source files');
      timings['glob'] = Date.now() - t;

      t = Date.now();
      const modules = await this.analyzeModules(nestFiles, context.projectPath, allNodes, edges, newNodes);
      timings['modules'] = Date.now() - t;

      t = Date.now();
      const globalGuards = await this.detectGlobalGuardRegistrations(nestFiles, context.projectPath);
      const controllers = await this.analyzeControllers(nestFiles, context.projectPath, allNodes, edges, entryPoints, enhancedNodes, newNodes, globalGuards);
      timings['controllers'] = Date.now() - t;

      t = Date.now();
      const providers = await this.analyzeProviders(nestFiles, context.projectPath, allNodes, edges, enhancedNodes, newNodes);
      timings['providers'] = Date.now() - t;

      t = Date.now();
      const guards = await this.analyzeGuards(nestFiles, context.projectPath, allNodes, edges, enhancedNodes, newNodes);
      timings['guards'] = Date.now() - t;

      t = Date.now();
      const middleware = await this.analyzeMiddleware(nestFiles, context.projectPath, allNodes, edges, enhancedNodes, newNodes);
      timings['middleware'] = Date.now() - t;

      t = Date.now();
      await this.analyzeEntryPoints(nestFiles, context.projectPath, allNodes, edges, entryPoints, newNodes);
      timings['entryPoints'] = Date.now() - t;

      timings['callGraph'] = 0;

      t = Date.now();
      this.buildNestJSRelationships(modules, controllers, providers, guards, middleware, allNodes, newNodes, edges, exitPoints);
      this.identifyDatabaseConnections(providers, allNodes, exitPoints);
      this.createPerspectives(perspectives, modules, controllers, providers, guards, middleware, allNodes, edges);
      timings['relationships'] = Date.now() - t;

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

      try {
        const stat = await fs.stat(fullPath);
        if (!stat.isFile()) continue;

        const content = await fs.readFile(fullPath, 'utf-8');
        const ast = parse(content, { loc: true, jsx: false });
        const moduleInfo = this.extractModuleInfo(ast, file);

        if (moduleInfo) {
          modules.push(moduleInfo);

          const moduleId = this.generateId('module', moduleInfo.filePath, moduleInfo.name);

          const moduleClassNode = this.findModuleClassNode(ast);
          const moduleDocumentation = moduleClassNode ? this.extractDocumentation(moduleClassNode, content) : undefined;
          const moduleComments = moduleClassNode ? this.extractComments(moduleClassNode, content, fullPath) : [];
          const moduleTodos = this.extractTodos(moduleComments);
          const moduleImplementationStatus = moduleClassNode ? this.detectImplementationStatus(moduleClassNode, content) : undefined;

          const moduleNode = this.createNodeBuilder(moduleId, moduleInfo.name, 'module')
            .withLevel(1, 'system')
            .withCategory('backend', ['framework'])
            .withSource({ file: file, line: 1, end_line: content.split('\n').length })
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
            .withDocumentation(moduleDocumentation)
            .withComments(moduleComments.length > 0 ? moduleComments : undefined)
            .withTodos(moduleTodos.length > 0 ? moduleTodos : undefined)
            .withImplementationStatus(moduleImplementationStatus)
            .withAnalyzers([this.analyzerId], this.analyzerId)
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

  private async detectGlobalGuardRegistrations(
    files: string[],
    projectPath: string
  ): Promise<NestGlobalGuardRegistration[]> {
    const cached = this.globalGuardCache.get(projectPath);
    if (cached) return cached;

    const registrations: NestGlobalGuardRegistration[] = [];

    let projectWideCandidates: string[] = [];
    try {
      projectWideCandidates = await glob(['**/*{module,main,bootstrap}*.{ts,js}'], {
        cwd: projectPath,
        ignore: [
          'node_modules/**', '**/node_modules/**',
          'dist/**', '**/dist/**',
          'build/**', '**/build/**',
          'vendor/**', '**/vendor/**',
          'coverage/**', '**/coverage/**',
          '**/*.spec.ts', '**/*.test.ts', '**/test/**',
        ],
        nodir: true,
      });
    } catch {
      projectWideCandidates = [];
    }
    const candidateFiles = Array.from(new Set([
      ...files.filter(file => /(\bmodule\b|\.module\.|\bmain\b|\.main\.|bootstrap)/i.test(file)),
      ...projectWideCandidates,
    ]));
    for (const file of candidateFiles) {
      try {
        const fullPath = path.join(projectPath, file);
        const stat = await fs.stat(fullPath);
        if (!stat.isFile()) continue;
        const content = await fs.readFile(fullPath, 'utf-8');
        if (!content.includes('APP_GUARD') && !content.includes('useGlobalGuards')) continue;

        const appScope = this.appScopeForFile(file);
        const providerBlocks = content.match(/\{[^{}]*APP_GUARD[^{}]*\}/g) || [];
        for (const block of providerBlocks) {
          const target = block.match(/use(?:Class|Existing)\s*:\s*([A-Za-z0-9_]+)/);
          if (target) registrations.push({ guardName: target[1], file, appScope });
        }
        const globalCalls = content.match(/useGlobalGuards\(([^)]*)\)/g) || [];
        for (const call of globalCalls) {
          const args = call.slice(call.indexOf('(') + 1, -1);
          const constructed = [...args.matchAll(/new\s+([A-Za-z0-9_]+)/g)].map(match => match[1]);
          const bare = constructed.length > 0
            ? []
            : args.split(',').map(token => token.trim()).filter(token => /^[A-Za-z_][A-Za-z0-9_]*$/.test(token));
          for (const guardName of [...constructed, ...bare]) {
            registrations.push({ guardName, file, appScope });
          }
        }
      } catch {
        continue;
      }
    }
    const deduped = registrations.filter((registration, index) =>
      registrations.findIndex(other => other.guardName === registration.guardName && other.appScope === registration.appScope) === index);
    this.globalGuardCache.set(projectPath, deduped);
    return deduped;
  }

  private appScopeForFile(file: string): string | null {
    const normalized = file.replace(/\\/g, '/');
    const match = normalized.match(/^(apps\/[^/]+\/)/);
    return match ? match[1] : null;
  }

  private isAnonymousOptOutDecorator(name: string): boolean {
    return /^(Public|IsPublic|AllowAnonymous|AllowAnonymousRequest|SkipAuth|SkipAuthGuard|SkipJwtAuth|NoAuth|Anonymous|Unprotected|AllowUnauthorized(Request)?)$/i.test(name);
  }

  private async findControllerCandidateFiles(files: string[], projectPath: string): Promise<string[]> {
    const filenameMatches = files.filter(f => f.includes('.controller.'));
    const filenameSet = new Set(filenameMatches);
    const remaining = files.filter(f => !filenameSet.has(f) && /\.[cm]?[tj]sx?$/.test(f));

    const decoratorMatches: string[] = [];
    for (const file of remaining) {
      try {
        const fullPath = path.join(projectPath, file);
        const stat = await fs.stat(fullPath);
        if (!stat.isFile()) continue;
        const content = await fs.readFile(fullPath, 'utf-8');
        if (/@Controller\s*\(/.test(content)) {
          decoratorMatches.push(file);
        }
      } catch {
        continue;
      }
    }

    return [...filenameMatches, ...decoratorMatches];
  }

  private async analyzeControllers(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[],
    enhancedNodes: CASNode[],
    newNodes: CASNode[],
    globalGuards: NestGlobalGuardRegistration[] = []
  ): Promise<NestController[]> {
    const controllers: NestController[] = [];
    const controllerFiles = await this.findControllerCandidateFiles(files, projectPath);

    for (const file of controllerFiles) {
      const fullPath = path.join(projectPath, file);

      try {
        const stat = await fs.stat(fullPath);
        if (!stat.isFile()) continue;

        const content = await fs.readFile(fullPath, 'utf-8');
        const ast = parse(content, { loc: true, jsx: false });
        const controllerInfo = this.extractControllerInfo(ast, file);

        if (controllerInfo) {
          controllers.push(controllerInfo);

          const controllerId = `class_${file}_${controllerInfo.name}_0`;
          let controllerNodeId = controllerId;
          let existingNode = this.findNestClassNode(nodes, controllerInfo.name, file, ['class', 'controller']);

          if (existingNode) {

            existingNode.type = 'controller';
            existingNode.subcategories = [...new Set([...(existingNode.subcategories || []), 'api', 'rest'])];
            existingNode.level = 2;
            existingNode.level_name = 'architectural';
            existingNode.description = `NestJS controller handling HTTP requests: ${controllerInfo.name}`;

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

            enhancedNodes.push(existingNode);
            controllerNodeId = existingNode.id;
          } else {
            const controllerNode = this.createNodeBuilder(controllerId, controllerInfo.name, 'controller')
              .withLevel(2, 'architectural')
              .withCategory('controller', ['api', 'rest', 'nestjs'])
              .withSource({ file: file, line: 1, end_line: content.split('\n').length })
              .withDescription(`NestJS controller handling HTTP requests: ${controllerInfo.name}`)
              .withMetadata({
                framework: 'nestjs',
                attributes: {
                  nestjs_type: 'controller',
                  route_count: controllerInfo.routes.length,
                  guards: controllerInfo.guards,
                  interceptors: controllerInfo.interceptors,
                  pipes: controllerInfo.pipes,
                  dependencies: controllerInfo.dependencies
                }
              })
              .withAnalyzers([this.analyzerId], this.analyzerId)
              .build();
            nodes.push(controllerNode);
            newNodes.push(controllerNode);
          }

          controllerInfo.routes.forEach((route, index) => {
            const fullPath = this.combinePaths(controllerInfo.basePath, route.path);
            const routeId = this.generateId('route', controllerInfo.filePath, `${route.handlerName}_${route.method}_${route.path}`);

            const handlerNode = this.findControllerHandlerMethod(ast, route.handlerName);
            const routeDocumentation = handlerNode ? this.extractDocumentation(handlerNode, content) : undefined;
            const routeComments = handlerNode ? this.extractComments(handlerNode, content, controllerInfo.filePath) : [];
            const routeTodos = this.extractTodos(routeComments);
            const routeImplementationStatus = handlerNode ? this.detectImplementationStatus(handlerNode, content) : undefined;

            const routeNode = this.createNodeBuilder(routeId, `${route.method.toUpperCase()} ${fullPath}`, 'route')
              .withLevel(3, 'code')
              .withCategory('route', ['http', 'endpoint'])
              .withSource({ file: controllerInfo.filePath, line: handlerNode?.loc?.start?.line || 1, end_line: handlerNode?.loc?.end?.line || 1 })
              .withDescription(`HTTP ${route.method.toUpperCase()} endpoint: ${fullPath}`)
              .withParent(controllerNodeId)
              .withMetadata({
                framework: 'nestjs',
                attributes: {
                  http_method: route.method.toUpperCase(),
                  path: fullPath,
                  handler_name: route.handlerName,
                  parameters: route.parameters,
                  guards: route.guards,
                  pipes: route.pipes,
                  interceptors: route.interceptors
                }
              })
              .withDocumentation(routeDocumentation)
              .withComments(routeComments.length > 0 ? routeComments : undefined)
              .withTodos(routeTodos.length > 0 ? routeTodos : undefined)
              .withImplementationStatus(routeImplementationStatus)
              .withAnalyzers([this.analyzerId], this.analyzerId)
              .build();
            nodes.push(routeNode);
            newNodes.push(routeNode);

            edges.push(this.createEdge(
              this.generateEdgeId(controllerNodeId, routeId, 'contains'),
              controllerNodeId,
              routeId,
              'contains',
              'structural'
            ));

            const optedOutOfGlobalGuards = [...route.decorators, ...controllerInfo.decorators]
              .some(decorator => this.isAnonymousOptOutDecorator(decorator));
            const controllerFile = controllerInfo.filePath.replace(/\\/g, '/');
            const applicableGlobalGuards = optedOutOfGlobalGuards
              ? []
              : globalGuards
                .filter(registration => !registration.appScope || controllerFile.startsWith(registration.appScope))
                .map(registration => registration.guardName);
            const allGuards = [...new Set([...controllerInfo.guards, ...route.guards, ...applicableGlobalGuards])];

            const methodNodeId = nodes.find(n =>
              n.name === route.handlerName &&
              n.type === 'method' &&
              n.parent === controllerNodeId
            )?.id;

            entryPoints.push(this.createEntryPoint(
              `entry_${routeId}`,
              routeId,
              'http',
              `${route.method.toUpperCase()} ${fullPath}`,
              `HTTP endpoint for ${controllerInfo.name}.${route.handlerName}`,
              {
                method: route.method.toUpperCase(),
                path: fullPath
              },
              {
                authenticated: allGuards.some(g => this.isAuthGuard(g)),
                authorized_roles: this.extractRolesFromGuards(allGuards),
                guards: allGuards
              },
              {
                controller: controllerInfo.name,
                handler: route.handlerName,
                parameters: route.parameters,
                guards: allGuards,
                global_guards: applicableGlobalGuards,
                pipes: route.pipes,
                interceptors: route.interceptors
              },
              {
                node_id: methodNodeId || routeId,
                method_name: route.handlerName,
                file: controllerInfo.filePath,
                line: handlerNode?.loc?.start?.line
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
      f.includes('.provider.') ||
      f.includes('-repository.') ||
      f.includes('-repo.') ||
      f.includes('.repo.') ||
      f.includes('/repositories/') ||
      f.includes('/repos/') ||
      f.includes('-dao.') ||
      f.includes('.dao.') ||
      f.includes('/daos/')
    );

    for (const file of serviceFiles) {
      const fullPath = path.join(projectPath, file);

      try {
        const stat = await fs.stat(fullPath);
        if (!stat.isFile()) continue;

        const content = await fs.readFile(fullPath, 'utf-8');
        const ast = parse(content, { loc: true, jsx: false });
        const providerInfo = this.extractProviderInfo(ast, file);

        if (providerInfo) {
          providers.push(providerInfo);

          const providerId = `class_${file}_${providerInfo.name}_0`;
          let providerNodeId = providerId;
          const existingNode = this.findNestClassNode(nodes, providerInfo.name, file, ['class', 'service', 'repository', 'provider']);

          if (existingNode) {

            existingNode.type = providerInfo.type;
            existingNode.subcategories = [...new Set([...(existingNode.subcategories || []), 'injectable'])];
            existingNode.level = 2;
            existingNode.level_name = 'architectural';
            existingNode.description = `NestJS ${providerInfo.type}: ${providerInfo.name}`;

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
            enhancedNodes.push(existingNode);
            providerNodeId = existingNode.id;
          } else {

            const providerNode = this.createNodeBuilder(providerId, providerInfo.name, providerInfo.type)
              .withLevel(2, 'architectural')
              .withCategory(providerInfo.type, ['nestjs', 'injectable'])
              .withSource({ file: file, line: 1, end_line: content.split('\n').length })
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
              .withAnalyzers([this.analyzerId], this.analyzerId)
              .build();
            nodes.push(providerNode);
            newNodes.push(providerNode);
          }

          providerInfo.methods.forEach((method, index) => {

            const methodId = `method_${providerNodeId}_${method.name}_${index}`;
            const existingMethodNode = nodes.find(n => n.id === methodId ||
              (n.parent === providerNodeId && n.name === method.name && n.type === 'method'));

            if (existingMethodNode) {

              existingMethodNode.metadata = {
                ...existingMethodNode.metadata,
                attributes: {
                  ...((existingMethodNode.metadata as any)?.attributes || {}),
                  parameter_count: method.parameters.length
                }
              };
            } else {

              const methodNode = this.createNodeBuilder(methodId, method.name, 'method')
                .withLevel(4, 'member')
                .withCategory('method', ['function'])
                .withSource({ file: file, line: 1, end_line: 1 })
                .withDescription(`Method in ${providerInfo.name}: ${method.name}`)
                .withParent(providerNodeId)
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
                .withAnalyzers([this.analyzerId], this.analyzerId)
                .build();
              nodes.push(methodNode);
              newNodes.push(methodNode);

              edges.push(this.createEdge(
                this.generateEdgeId(providerNodeId, methodId, 'contains'),
                providerNodeId,
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
    edges: CASEdge[],
    enhancedNodes: CASNode[],
    newNodes: CASNode[]
  ): Promise<NestGuard[]> {
    const guards: NestGuard[] = [];
    const guardFiles = files.filter(f => f.includes('.guard.'));

    for (const file of guardFiles) {
      const fullPath = path.join(projectPath, file);

      try {
        const stat = await fs.stat(fullPath);
        if (!stat.isFile()) continue;

        const content = await fs.readFile(fullPath, 'utf-8');
        const ast = parse(content, { loc: true, jsx: false });
        const guardInfo = this.extractGuardInfo(ast, file);

        if (guardInfo) {
          guards.push(guardInfo);

          const guardId = `class_${file}_${guardInfo.name}_0`;
          const existingNode = this.findNestClassNode(nodes, guardInfo.name, file, ['class', 'guard']);

          if (existingNode) {

            existingNode.type = 'guard';
            existingNode.subcategories = [...new Set([...(existingNode.subcategories || []), 'security', 'auth'])];
            existingNode.level = 3;
            existingNode.level_name = 'code';
            existingNode.description = `NestJS guard: ${guardInfo.name}`;

            existingNode.metadata = {
              ...existingNode.metadata,
              framework: 'nestjs',
              attributes: {
                ...((existingNode.metadata as any)?.attributes || {}),
                guard_type: 'guard',
                can_activate_method: guardInfo.canActivateMethod
              }
            };
            enhancedNodes.push(existingNode);
          } else {

            const guardNode = this.createNodeBuilder(guardId, guardInfo.name, 'guard')
              .withLevel(3, 'code')
              .withCategory('guard', ['security', 'nestjs'])
              .withSource({ file: file, line: 1, end_line: content.split('\n').length })
              .withDescription(`NestJS guard: ${guardInfo.name}`)
              .withMetadata({
                framework: 'nestjs',
                attributes: {
                  guard_type: 'guard',
                  can_activate_method: guardInfo.canActivateMethod
                }
                })
              .withAnalyzers([this.analyzerId], this.analyzerId)
              .build();
            nodes.push(guardNode);
            newNodes.push(guardNode);
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
    edges: CASEdge[],
    enhancedNodes: CASNode[],
    newNodes: CASNode[]
  ): Promise<NestMiddleware[]> {
    const middleware: NestMiddleware[] = [];
    const middlewareFiles = files.filter(f => f.includes('.middleware.'));

    for (const file of middlewareFiles) {
      const fullPath = path.join(projectPath, file);

      try {
        const stat = await fs.stat(fullPath);
        if (!stat.isFile()) continue;

        const content = await fs.readFile(fullPath, 'utf-8');
        const ast = parse(content, { loc: true, jsx: false });
        const middlewareInfo = this.extractMiddlewareInfo(ast, file);

        if (middlewareInfo) {
          middleware.push(middlewareInfo);

          const middlewareId = `class_${file}_${middlewareInfo.name}_0`;
          const existingNode = this.findNestClassNode(nodes, middlewareInfo.name, file, ['class', 'middleware']);

          if (existingNode) {

            existingNode.type = 'middleware';
            existingNode.subcategories = [...new Set([...(existingNode.subcategories || []), 'http', 'interceptor'])];
            existingNode.level = 3;
            existingNode.level_name = 'code';
            existingNode.description = `NestJS middleware: ${middlewareInfo.name}`;

            existingNode.metadata = {
              ...existingNode.metadata,
              framework: 'nestjs',
              attributes: {
                ...((existingNode.metadata as any)?.attributes || {}),
                middleware_type: 'middleware',
                use_method: middlewareInfo.useMethod
              }
            };
            enhancedNodes.push(existingNode);
          } else {

            const middlewareNode = this.createNodeBuilder(middlewareId, middlewareInfo.name, 'middleware')
              .withLevel(3, 'code')
              .withCategory('middleware', ['http', 'nestjs'])
              .withSource({ file: file, line: 1, end_line: content.split('\n').length })
              .withDescription(`NestJS middleware: ${middlewareInfo.name}`)
              .withMetadata({
                framework: 'nestjs',
                attributes: {
                  middleware_type: 'middleware',
                  use_method: middlewareInfo.useMethod
                }
                })
              .withAnalyzers([this.analyzerId], this.analyzerId)
              .build();
            nodes.push(middlewareNode);
            newNodes.push(middlewareNode);
          }
        }
      } catch (error) {
        console.warn(`Failed to parse middleware ${file}:`, error);
      }
    }

    return middleware;
  }

  private async analyzeEntryPoints(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    newNodes: CASNode[]
  ): Promise<void> {
    for (const file of files) {
      const fullPath = path.join(projectPath, file);

      try {
        const stat = await fs.stat(fullPath);
        if (!stat.isFile()) continue;

        const content = await fs.readFile(fullPath, 'utf-8');
        const ast = parse(content, { loc: true, jsx: false });

        this.analyzeWebSocketGateways(ast, file, fullPath, content, nodes, edges, entryPoints, newNodes);

        this.analyzeEventListeners(ast, file, fullPath, nodes, entryPoints);

        this.analyzeScheduledTasks(ast, file, fullPath, nodes, entryPoints);

        this.analyzeQueueProcessors(ast, file, fullPath, nodes, entryPoints);

        this.analyzeMicroservicePatterns(ast, file, fullPath, nodes, entryPoints);

        if (file.endsWith('main.ts')) {
          this.analyzeApplicationBootstrap(ast, file, fullPath, nodes, entryPoints, newNodes);
        }

        this.analyzeCliCommands(ast, file, fullPath, nodes, entryPoints);
      } catch (error) {
        console.warn(`Failed to analyze entry points in ${file}:`, error);
      }
    }
  }

  private buildImportAliasMap(ast: TSESTree.Program): Map<string, string> {
    const aliases = new Map<string, string>();
    for (const statement of ast.body || []) {
      if ((statement as any).type !== 'ImportDeclaration') continue;
      for (const specifier of (statement as any).specifiers || []) {
        if (specifier.type !== 'ImportSpecifier') continue;
        const exported = specifier.imported?.name;
        const local = specifier.local?.name;
        if (exported && local && exported !== local) aliases.set(local, exported);
      }
    }
    return aliases;
  }

  private resolveDecoratorName(dec: any, aliases?: Map<string, string>): string | undefined {

    const local = dec?.expression?.callee?.name ?? dec?.expression?.name;
    if (typeof local !== 'string') return undefined;
    return aliases?.get(local) ?? local;
  }

  private isDecorator(dec: any, exportedName: string, aliases?: Map<string, string>): boolean {
    return this.resolveDecoratorName(dec, aliases) === exportedName;
  }

  private analyzeWebSocketGateways(
    ast: TSESTree.Program,
    filePath: string,
    fullPath: string,
    content: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    newNodes: CASNode[]
  ): void {
    const aliases = this.buildImportAliasMap(ast);
    const walk = (node: any) => {
      if (!node || typeof node !== 'object') return;

      if (node.type === 'ClassDeclaration' && node.decorators) {
        const gatewayDecorator = node.decorators.find((dec: any) =>
          this.isDecorator(dec, 'WebSocketGateway', aliases)
        );

        if (gatewayDecorator && node.id) {
          const className = node.id.name;
          const gatewayOptions = this.extractGatewayOptions(gatewayDecorator);

          const gatewayId = `class_${filePath}_${className}_0`;
          let gatewayNode = nodes.find(n => n.id === gatewayId);

          if (!gatewayNode) {
            gatewayNode = this.createNodeBuilder(gatewayId, className, 'gateway')
              .withLevel(2, 'architectural')
              .withCategory('gateway', ['websocket', 'nestjs', 'realtime'])
              .withSource({ file: filePath, line: 1, end_line: content.split('\n').length })
              .withDescription(`WebSocket Gateway: ${className}`)
              .withMetadata({
                framework: 'nestjs',
                attributes: {
                  gateway_type: 'websocket',
                  namespace: gatewayOptions.namespace,
                  port: gatewayOptions.port,
                  cors: gatewayOptions.cors
                }
              })
              .withAnalyzers([this.analyzerId], this.analyzerId)
              .build();
            nodes.push(gatewayNode);
            newNodes.push(gatewayNode);
          } else {
            gatewayNode.type = 'gateway';
            gatewayNode.subcategories = [...new Set([...(gatewayNode.subcategories || []), 'websocket', 'realtime'])];
            gatewayNode.metadata = {
              ...gatewayNode.metadata,
              attributes: {
                ...((gatewayNode.metadata as any)?.attributes || {}),
                gateway_type: 'websocket',
                namespace: gatewayOptions.namespace,
                port: gatewayOptions.port
              }
            };
          }

          const wsEntryId = `entry_ws_${this.sanitizeId(className)}`;
          entryPoints.push(this.createEntryPoint(
            wsEntryId,
            gatewayId,
            'websocket',
            `WebSocket Gateway: ${className}`,
            `WebSocket server listening on ${gatewayOptions.port || 'default port'} with namespace: ${gatewayOptions.namespace || '/'}`,
            {},
            {
              authenticated: false
            },
            {
              gateway_class: className,
              file: filePath,
              port: gatewayOptions.port,
              namespace: gatewayOptions.namespace || '/',
              transport: 'websocket',
              cors_enabled: gatewayOptions.cors !== undefined
            }
          ));

          if (node.body && node.body.body) {
            node.body.body.forEach((member: any) => {
              if (member.type === 'MethodDefinition' && member.decorators) {
                const subscribeDecorator = member.decorators.find((dec: any) =>
                  this.isDecorator(dec, 'SubscribeMessage', aliases)
                );

                if (subscribeDecorator) {
                  const eventName = this.extractDecoratorArgument(subscribeDecorator) || 'message';
                  const handlerName = member.key.name;
                  const registrationLine = (subscribeDecorator as any).loc?.start.line
                    ?? member.loc?.start.line ?? 1;
                  const handlerId = `ws_handler_${this.sanitizeId(`${className}_${handlerName}`)}`;

                  const handlerNode = this.createNodeBuilder(handlerId, `${eventName} handler`, 'ws_handler')
                    .withLevel(3, 'code')
                    .withCategory('handler', ['websocket', 'event'])
                    .withSource({ file: filePath, line: member.loc?.start.line || 1 })
                    .withDescription(`WebSocket message handler for '${eventName}' event`)
                    .withParent(gatewayId)
                    .withMetadata({
                      framework: 'nestjs',
                      attributes: {
                        event_name: eventName,
                        handler_method: handlerName,
                        gateway: className
                      }
                    })
                    .withAnalyzers([this.analyzerId], this.analyzerId)
                    .build();
                  nodes.push(handlerNode);
                  newNodes.push(handlerNode);

                  edges.push(this.createEdge(
                    this.generateEdgeId(gatewayId, handlerId, 'contains'),
                    gatewayId,
                    handlerId,
                    'contains',
                    'structural'
                  ));

                  entryPoints.push(this.createEntryPoint(
                    `entry_ws_msg_${this.sanitizeId(`${className}_${eventName}`)}`,
                    handlerId,
                    'message',
                    `WS Message: ${eventName}`,
                    `WebSocket message handler for '${eventName}' event in ${className}`,
                    {
                      event: eventName
                    },
                    {
                      authenticated: false
                    },
                    {
                      handler_method: handlerName,
                      gateway_class: className,

                      message: eventName,
                      declaredAt: `${filePath}:${registrationLine}`
                    },

                    {
                      node_id: handlerId,
                      method_name: handlerName,
                      file: filePath,
                      line: registrationLine
                    }
                  ));
                }
              }
            });
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
  }

  private analyzeEventListeners(
    ast: TSESTree.Program,
    filePath: string,
    fullPath: string,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[]
  ): void {
    const aliases = this.buildImportAliasMap(ast);
    const walk = (node: any, currentClass?: any) => {
      if (!node || typeof node !== 'object') return;

      const activeClass = node.type === 'ClassDeclaration' ? node : currentClass;

      if (node.type === 'MethodDefinition' && node.decorators) {
        const onEventDecorator = node.decorators.find((dec: any) =>
          this.isDecorator(dec, 'OnEvent', aliases)
        );

        if (onEventDecorator) {
          const eventName = this.extractDecoratorArgument(onEventDecorator) || 'event';
          const methodName = node.key?.name || 'handleEvent';

          const className = activeClass?.id?.name || 'UnknownClass';

          const parentId = `class_${filePath}_${className}_0`;

          const parentNode = nodes.find(n => n.id === parentId);
          if (parentNode) {
            entryPoints.push(this.createEntryPoint(
              `entry_event_${this.sanitizeId(`${className}_${eventName}`)}`,
              parentId,
              'event',
              `Event: ${eventName}`,
              `Event listener for '${eventName}' event in ${className}.${methodName}`,
              {
                event: eventName
              },
              {},
              {
                handler_class: className,
                handler_method: methodName,
                file: filePath
              }
            ));
          }
        }
      }

      for (const key in node) {
        if (key === 'parent') continue;
        if (typeof node[key] === 'object' && node[key] !== null) {
          if (Array.isArray(node[key])) {
            node[key].forEach((child: any) => walk(child, activeClass));
          } else {
            walk(node[key], activeClass);
          }
        }
      }
    };

    walk(ast);
  }

  private analyzeScheduledTasks(
    ast: TSESTree.Program,
    filePath: string,
    fullPath: string,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[]
  ): void {
    const aliases = this.buildImportAliasMap(ast);
    const walk = (node: any, currentClass?: any) => {
      if (!node || typeof node !== 'object') return;
      const activeClass = node.type === 'ClassDeclaration' ? node : currentClass;

      if (node.type === 'MethodDefinition' && node.decorators) {
        const schedulerDecorators = ['Cron', 'Interval', 'Timeout'];

        node.decorators.forEach((decorator: any) => {
          const decoratorName = this.resolveDecoratorName(decorator, aliases);

          if (decoratorName && schedulerDecorators.includes(decoratorName)) {
            const methodName = node.key?.name || 'scheduledTask';

            const className = activeClass?.id?.name || 'UnknownClass';

            const parentId = `class_${filePath}_${className}_0`;
            const parentNode = nodes.find(n => n.id === parentId);

            if (parentNode) {
              let schedule = '';

              if (decoratorName === 'Cron') {
                const cronExpression = this.extractDecoratorArgument(decorator);
                schedule = cronExpression || '* * * * *';
              } else if (decoratorName === 'Interval') {
                const interval = this.extractDecoratorArgument(decorator);
                schedule = `every ${interval}ms`;
              } else if (decoratorName === 'Timeout') {
                const timeout = this.extractDecoratorArgument(decorator);
                schedule = `after ${timeout}ms`;
              }

              entryPoints.push(this.createEntryPoint(
                `entry_schedule_${this.sanitizeId(`${className}_${methodName}`)}`,
                parentId,
                'schedule',
                `${decoratorName}: ${methodName}`,
                `Scheduled task ${methodName} in ${className}: ${schedule}`,
                {
                  schedule: schedule
                },
                {},
                {
                  handler_class: className,
                  handler_method: methodName,
                  decorator: decoratorName,
                  file: filePath
                }
              ));
            }
          }
        });
      }

      for (const key in node) {
        if (key === 'parent') continue;
        if (typeof node[key] === 'object' && node[key] !== null) {
          if (Array.isArray(node[key])) {
            node[key].forEach((child: any) => walk(child, activeClass));
          } else {
            walk(node[key], activeClass);
          }
        }
      }
    };

    walk(ast);
  }

  private analyzeQueueProcessors(
    ast: TSESTree.Program,
    filePath: string,
    fullPath: string,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[]
  ): void {
    const aliases = this.buildImportAliasMap(ast);
    const walk = (node: any) => {

      if (!node || typeof node !== 'object') return;

      if (node.type === 'ClassDeclaration' && node.decorators) {
        const processorDecorator = node.decorators.find((dec: any) =>
          this.isDecorator(dec, 'Processor', aliases)
        );

        if (processorDecorator && node.id) {
          const queueName = this.extractDecoratorArgument(processorDecorator) || 'default';
          const className = node.id.name;
          const classId = `class_${filePath}_${className}_0`;

          if (node.body && node.body.body) {
            node.body.body.forEach((member: any) => {
              if (member.type === 'MethodDefinition' && member.decorators) {
                const processDecorator = member.decorators.find((dec: any) =>
                  this.isDecorator(dec, 'Process', aliases)
                );

                if (processDecorator) {
                  const jobName = this.extractDecoratorArgument(processDecorator) || 'default';
                  const methodName = member.key.name;

                  entryPoints.push(this.createEntryPoint(
                    `entry_queue_${this.sanitizeId(`${queueName}_${jobName}`)}`,
                    classId,
                    'message',
                    `Queue: ${queueName}/${jobName}`,
                    `Queue processor for '${jobName}' jobs in queue '${queueName}'`,
                    {
                      pattern: `${queueName}.${jobName}`
                    },
                    {},
                    {
                      processor_class: className,
                      handler_method: methodName,
                      file: filePath
                    }
                  ));
                }
              }
            });
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
  }

  private analyzeMicroservicePatterns(
    ast: TSESTree.Program,
    filePath: string,
    fullPath: string,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[]
  ): void {
    const aliases = this.buildImportAliasMap(ast);
    const walk = (node: any, currentClass?: any) => {
      if (!node || typeof node !== 'object') return;
      const activeClass = node.type === 'ClassDeclaration' ? node : currentClass;

      if (node.type === 'MethodDefinition' && node.decorators) {
        const messagePatternDecorator = node.decorators.find((dec: any) =>
          this.isDecorator(dec, 'MessagePattern', aliases)
        );
        const eventPatternDecorator = node.decorators.find((dec: any) =>
          this.isDecorator(dec, 'EventPattern', aliases)
        );

        if (messagePatternDecorator || eventPatternDecorator) {
          const decorator = messagePatternDecorator || eventPatternDecorator;
          const decoratorType = messagePatternDecorator ? 'message' : 'event';
          const pattern = this.extractDecoratorArgument(decorator) || 'unknown';
          const methodName = node.key?.name || 'handleMessage';

          const className = activeClass?.id?.name || 'UnknownClass';
          const parentId = `class_${filePath}_${className}_0`;

          entryPoints.push(this.createEntryPoint(
            `entry_microservice_${decoratorType}_${this.sanitizeId(pattern.toString())}`,
            parentId,
            'message',
            `${decoratorType === 'message' ? 'Message' : 'Event'}: ${pattern}`,
            `Microservice ${decoratorType} handler for pattern '${pattern}'`,
            {
              pattern: pattern.toString()
            },
            {},
            {
              handler_class: className,
              handler_method: methodName,
              decorator: decoratorType === 'message' ? 'MessagePattern' : 'EventPattern',
              file: filePath
            }
          ));
        }
      }

      for (const key in node) {
        if (key === 'parent') continue;
        if (typeof node[key] === 'object' && node[key] !== null) {
          if (Array.isArray(node[key])) {
            node[key].forEach((child: any) => walk(child, activeClass));
          } else {
            walk(node[key], activeClass);
          }
        }
      }
    };

    walk(ast);
  }

  private analyzeApplicationBootstrap(
    ast: TSESTree.Program,
    filePath: string,
    fullPath: string,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    newNodes: CASNode[]
  ): void {
    const appQualifier = this.sanitizeId(filePath.replace(/\.[cm]?[tj]sx?$/, ''));
    const bootstrapId = `bootstrap_main_${appQualifier}`;
    let httpServerCount = 0;

    const walk = (node: any) => {

      if (!node || typeof node !== 'object') return;

      if (node.type === 'CallExpression') {
        if (node.callee?.type === 'MemberExpression' &&
            node.callee.object?.name === 'NestFactory' &&
            ['create', 'createMicroservice', 'createApplicationContext'].includes(node.callee.property?.name)) {
          const bootstrapMethod = `NestFactory.${node.callee.property.name}`;
          const bootstrapNode = this.createNodeBuilder(bootstrapId, 'Application Bootstrap', 'bootstrap')
            .withLevel(1, 'system')
            .withCategory('bootstrap', ['initialization', 'nestjs'])
            .withSource({ file: filePath, line: node.loc?.start.line || 1 })
            .withDescription('NestJS application bootstrap and initialization')
            .withMetadata({
              framework: 'nestjs',
              attributes: {
                bootstrap_type: 'main',
                file: filePath
              }
            })
            .withAnalyzers([this.analyzerId], this.analyzerId)
            .build();

          if (!nodes.find(n => n.id === bootstrapId)) {
            nodes.push(bootstrapNode);
            newNodes.push(bootstrapNode);
          }

          entryPoints.push(this.createEntryPoint(
            `entry_bootstrap_${appQualifier}`,
            bootstrapId,
            'file',
            'Application Start',
            `NestJS application bootstrap via ${bootstrapMethod}()`,
            {},
            {},
            {
              file: filePath,
              line: node.loc?.start.line,
              entry_file: filePath,
              bootstrap_method: bootstrapMethod
            },

            {
              node_id: bootstrapId,
              method_name: bootstrapMethod,
              file: filePath,
              ...(node.loc?.start.line !== undefined ? { line: node.loc.start.line } : {})
            }
          ));
        }

        if (node.callee?.type === 'MemberExpression' &&
            node.callee.property?.name === 'listen') {
          const port = node.arguments?.[0]?.value || 3000;
          httpServerCount += 1;

          entryPoints.push(this.createEntryPoint(
            httpServerCount === 1
              ? `entry_http_server_${appQualifier}`
              : `entry_http_server_${appQualifier}_${httpServerCount}`,
            bootstrapId,
            'http',
            `HTTP Server: port ${port}`,
            `HTTP server listening on port ${port}`,
            {},
            {},
            {
              file: filePath,
              line: node.loc?.start.line,
              port: port,
              protocol: 'http'
            },

            {
              node_id: bootstrapId,
              method_name: 'listen',
              file: filePath,
              ...(node.loc?.start.line !== undefined ? { line: node.loc.start.line } : {})
            }
          ));
        }

        if (node.callee?.type === 'MemberExpression' &&
            node.callee.property?.name === 'connectMicroservice') {
          entryPoints.push(this.createEntryPoint(
            `entry_microservice_${this.generateId('ms', filePath, '')}`,
            bootstrapId,
            'message',
            'Microservice Connection',
            'NestJS microservice transport layer initialization',
            {},
            {},
            {
              file: filePath,
              line: node.loc?.start.line,
              transport: 'tcp'
            }
          ));
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
  }

  private analyzeCliCommands(
    ast: TSESTree.Program,
    filePath: string,
    fullPath: string,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[]
  ): void {
    const aliases = this.buildImportAliasMap(ast);
    const walk = (node: any, currentClass?: any) => {

      if (!node || typeof node !== 'object') return;
      const activeClass = node.type === 'ClassDeclaration' ? node : currentClass;

      if (node.type === 'ClassDeclaration' && node.decorators) {
        const commandDecorator = node.decorators.find((dec: any) =>
          this.isDecorator(dec, 'Command', aliases)
        );

        if (commandDecorator && node.id) {
          const commandOptions = this.extractCommandOptions(commandDecorator);
          const className = node.id.name;
          const classId = `class_${filePath}_${className}_0`;

          entryPoints.push(this.createEntryPoint(
            `entry_cli_${this.sanitizeId(commandOptions.name || className)}`,
            classId,
            'cli',
            `CLI: ${commandOptions.name || className}`,
            `CLI command: ${commandOptions.description || 'Command handler'}`,
            {},
            {},
            {
              command_class: className,
              file: filePath
            }
          ));
        }
      }

      if (!node || typeof node !== 'object') return;

      if (node.type === 'MethodDefinition' && node.decorators) {
        const subCommandDecorator = node.decorators.find((dec: any) =>
          this.isDecorator(dec, 'SubCommand', aliases)
        );

        if (subCommandDecorator) {
          const subCommandName = this.extractDecoratorArgument(subCommandDecorator);
          const methodName = node.key?.name || 'handleCommand';

          const className = activeClass?.id?.name || 'UnknownClass';
          const parentId = `class_${filePath}_${className}_0`;

          entryPoints.push(this.createEntryPoint(
            `entry_cli_sub_${this.sanitizeId(`${className}_${subCommandName}`)}`,
            parentId,
            'cli',
            `CLI SubCommand: ${subCommandName}`,
            `CLI subcommand handler for '${subCommandName}'`,
            {},
            {},
            {
              command_class: className,
              handler_method: methodName,
              file: filePath
            }
          ));
        }
      }

      for (const key in node) {
        if (key === 'parent') continue;
        if (typeof node[key] === 'object' && node[key] !== null) {
          if (Array.isArray(node[key])) {
            node[key].forEach((child: any) => walk(child, activeClass));
          } else {
            walk(node[key], activeClass);
          }
        }
      }
    };

    walk(ast);
  }

  private extractGatewayOptions(decorator: any): any {
    const options: any = {
      namespace: '/',
      port: undefined,
      cors: undefined
    };

    if (decorator.expression.arguments && decorator.expression.arguments[0]) {
      const arg = decorator.expression.arguments[0];

      if (arg.type === 'ObjectExpression') {
        arg.properties.forEach((prop: any) => {
          if (prop.key?.name === 'namespace' && prop.value?.type === 'Literal') {
            options.namespace = prop.value.value;
          }
          if (prop.key?.name === 'port' && prop.value?.type === 'Literal') {
            options.port = prop.value.value;
          }
          if (prop.key?.name === 'cors') {
            options.cors = true;
          }
        });
      } else if (arg.type === 'Literal') {

        if (typeof arg.value === 'number') {
          options.port = arg.value;
        }
      }
    }

    return options;
  }

  private extractCommandOptions(decorator: any): any {
    const options: any = {
      name: undefined,
      description: undefined,
      arguments: [],
      options: []
    };

    if (decorator.expression.arguments && decorator.expression.arguments[0]) {
      const arg = decorator.expression.arguments[0];

      if (arg.type === 'ObjectExpression') {
        arg.properties.forEach((prop: any) => {
          if (prop.key?.name === 'name' && prop.value?.type === 'Literal') {
            options.name = prop.value.value;
          }
          if (prop.key?.name === 'description' && prop.value?.type === 'Literal') {
            options.description = prop.value.value;
          }
          if (prop.key?.name === 'arguments' && prop.value?.type === 'ArrayExpression') {
            options.arguments = prop.value.elements.map((elem: any) =>
              elem.type === 'Literal' ? elem.value : 'arg'
            );
          }
          if (prop.key?.name === 'options' && prop.value?.type === 'ArrayExpression') {
            options.options = prop.value.elements.map((elem: any) =>
              elem.type === 'Literal' ? elem.value : 'option'
            );
          }
        });
      }
    }

    return options;
  }

  private extractModuleInfo(ast: TSESTree.Program, filePath: string): NestModule | null {
    const aliases = this.buildImportAliasMap(ast);
    let moduleInfo: NestModule | null = null;

    const walk = (node: any) => {
      if (!node || typeof node !== 'object') return;

      if (node.type === 'ClassDeclaration' && node.decorators) {
        const moduleDecorator = node.decorators.find((dec: any) =>
          this.isDecorator(dec, 'Module', aliases)
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
            isGlobal: node.decorators.some((dec: any) => this.isDecorator(dec, 'Global', aliases))
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
    const aliases = this.buildImportAliasMap(ast);
    let controllerInfo: NestController | null = null;
    const isControllerFile = this.isControllerFile(filePath);

    const walk = (node: any) => {
      if (!node || typeof node !== 'object') return;

      if (node.type === 'ClassDeclaration' && node.decorators) {
        const controllerDecorator = node.decorators.find((dec: any) => {
          const name = this.resolveDecoratorName(dec, aliases);
          return name && CONTROLLER_PATTERNS.some(pattern => pattern.test(name));
        });

        const hasAnyDecorator = node.decorators.length > 0;
        const className = node.id?.name || '';
        const controllerFileClassMatch = isControllerFile &&
          hasAnyDecorator &&
          this.isControllerLikeClassName(className) &&
          !this.isDtoLikeClassName(className);

        if ((controllerDecorator || controllerFileClassMatch) && node.id) {
          const basePath = controllerDecorator
            ? (this.extractDecoratorArgument(controllerDecorator) || '')
            : '';
          const routes = this.extractRoutes(node, aliases);
          const guards = this.extractClassDecorators(node, 'UseGuards', aliases);
          const interceptors = this.extractClassDecorators(node, 'UseInterceptors', aliases);
          const pipes = this.extractClassDecorators(node, 'UsePipes', aliases);

          controllerInfo = {
            name: node.id.name,
            filePath,
            basePath,
            routes,
            guards,
            interceptors,
            pipes,
            dependencies: this.extractConstructorDependencies(node),
            decorators: this.extractAllDecoratorNames(node.decorators, aliases)
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

  private isControllerFile(filePath: string): boolean {
    const normalized = filePath.toLowerCase();
    return normalized.includes('.controller.') ||
           normalized.includes('-controller.') ||
           normalized.includes('/controllers/');
  }

  private isControllerLikeClassName(className: string): boolean {
    return /controller$/i.test(className);
  }

  private isDtoLikeClassName(className: string): boolean {
    return /(dto|input|output|request|response|payload|params|query|body|schema)$/i.test(className);
  }

  private extractProviderInfo(ast: TSESTree.Program, filePath: string): NestProvider | null {
    const aliases = this.buildImportAliasMap(ast);
    let providerInfo: NestProvider | null = null;

    const isDataAccessLayerFile = (path: string): boolean => {
      return path.includes('.repository.') ||
        path.includes('-repository.') ||
        path.includes('.repo.') ||
        path.includes('-repo.') ||
        path.includes('/repositories/') ||
        path.includes('/repos/') ||
        path.includes('.dao.') ||
        path.includes('-dao.') ||
        path.includes('/daos/');
    };

    const isDataAccessLayerClass = (className: string): boolean => {
      return className.endsWith('Repository') ||
        className.endsWith('Repo') ||
        className.endsWith('DAO');
    };

    const walk = (node: any) => {
      if (!node || typeof node !== 'object') return;

      if (node.type === 'ClassDeclaration' && node.id) {
        const hasDecorators = node.decorators && node.decorators.length > 0;
        const injectableDecorator = hasDecorators && node.decorators.find((dec: any) =>
          this.isDecorator(dec, 'Injectable', aliases)
        );

        const className = node.id.name;
        const isDataAccessLayer = isDataAccessLayerFile(filePath) || isDataAccessLayerClass(className);

        if (injectableDecorator || isDataAccessLayer) {
          const methods = this.extractMethods(node);
          const dependencies = this.extractConstructorDependencies(node);

          let type: 'service' | 'repository' | 'factory' | 'value' | 'custom' = 'service';
          if (isDataAccessLayer) type = 'repository';
          else if (filePath.includes('.factory.')) type = 'factory';

          providerInfo = {
            name: className,
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
    const aliases = this.buildImportAliasMap(ast);
    let guardInfo: NestGuard | null = null;

    const walk = (node: any) => {
      if (!node || typeof node !== 'object') return;

      if (node.type === 'ClassDeclaration' && node.decorators) {
        const injectableDecorator = node.decorators.find((dec: any) =>
          this.isDecorator(dec, 'Injectable', aliases)
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
    const aliases = this.buildImportAliasMap(ast);
    let middlewareInfo: NestMiddleware | null = null;

    const walk = (node: any) => {
      if (!node || typeof node !== 'object') return;

      if (node.type === 'ClassDeclaration' && node.decorators) {
        const injectableDecorator = node.decorators.find((dec: any) =>
          this.isDecorator(dec, 'Injectable', aliases)
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

  private extractRoutes(classNode: any, aliases?: Map<string, string>): NestRoute[] {
    const routes: NestRoute[] = [];

    if (classNode.body && classNode.body.body) {
      classNode.body.body.forEach((member: any) => {
        if (member.type === 'MethodDefinition' && member.decorators) {
          const httpDecorator = member.decorators.find((dec: any) => {
            const name = this.resolveDecoratorName(dec, aliases);
            return name && HTTP_DECORATOR_PATTERNS.some(pattern => pattern.test(name));
          });

          if (httpDecorator) {
            const decoratorName = (this.resolveDecoratorName(httpDecorator, aliases) || '').toLowerCase();
            const method = HTTP_METHOD_MAP[decoratorName] || this.extractMethodFromName(decoratorName);
            const path = this.extractDecoratorArgument(httpDecorator) || '/';
            const handlerName = member.key.name;
            const parameters = this.extractMethodParameters(member);
            const guards = this.extractMethodDecorators(member, 'UseGuards', aliases);
            const pipes = this.extractMethodDecorators(member, 'UsePipes', aliases);
            const interceptors = this.extractMethodDecorators(member, 'UseInterceptors', aliases);

            routes.push({
              method,
              path,
              handlerName,
              parameters,
              guards,
              pipes,
              interceptors,
              decorators: this.extractAllDecoratorNames(member.decorators, aliases)
            });
          }
        }
      });
    }

    return routes;
  }

  private extractMethodFromName(decoratorName: string): string {
    const lower = decoratorName.toLowerCase();
    if (lower.includes('get')) return 'get';
    if (lower.includes('post')) return 'post';
    if (lower.includes('put')) return 'put';
    if (lower.includes('delete')) return 'delete';
    if (lower.includes('patch')) return 'patch';
    if (lower.includes('options')) return 'options';
    if (lower.includes('head')) return 'head';
    return 'get';
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

  private extractAllDecoratorNames(decorators: any[] | undefined, aliases?: Map<string, string>): string[] {
    return (decorators || [])
      .map((dec: any) => this.resolveDecoratorName(dec, aliases))
      .filter((name: any): name is string => typeof name === 'string');
  }

  private extractClassDecorators(classNode: any, decoratorName: string, aliases?: Map<string, string>): string[] {
    const decorators: string[] = [];

    if (classNode.decorators) {
      classNode.decorators.forEach((dec: any) => {
        if (this.isDecorator(dec, decoratorName, aliases)) {
          const args = this.extractDecoratorArguments(dec);
          decorators.push(...args);
        }
      });
    }

    return decorators;
  }

  private extractMethodDecorators(methodNode: any, decoratorName: string, aliases?: Map<string, string>): string[] {
    const decorators: string[] = [];

    if (methodNode.decorators) {
      methodNode.decorators.forEach((dec: any) => {
        if (this.isDecorator(dec, decoratorName, aliases)) {
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

  private combinePaths(basePath: string, routePath: string): string {
    const cleanBase = basePath.replace(/^\/|\/$/g, '');
    const cleanRoute = routePath.replace(/^\/|\/$/g, '');
    if (!cleanBase) return '/' + cleanRoute;
    if (!cleanRoute || cleanRoute === '/') return '/' + cleanBase;
    return '/' + cleanBase + '/' + cleanRoute;
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
      const baseName = typeNode.typeName.name;
      if (typeNode.typeParameters?.params?.length > 0) {
        const genericParam = this.extractTypeName(typeNode.typeParameters.params[0]);
        if (genericParam && (baseName === 'EntityRepository' || baseName === 'Repository')) {
          return `EntityRepository<${genericParam}>`;
        }
      }
      return baseName;
    }
    if (typeNode.type === 'Identifier') {
      return typeNode.name;
    }
    return null;
  }

  private resolveNestDependencyNode(depName: string, nodes: CASNode[], newNodes: CASNode[]): CASNode {
    const dependencyTypes = new Set([
      'service',
      'repository',
      'provider',
      'factory',
      'value',
      'custom',
      'class',
      'controller',
      'guard',
      'middleware',
      'gateway',
      'injection_token',
      'database_client',
      'cache_client',
      'event_bus',
      'framework_service'
    ]);

    const exactNode = nodes.find(n => n.name === depName && dependencyTypes.has(n.type));
    if (exactNode) return exactNode;

    const baseName = depName
      .replace(/Service$/, '')
      .replace(/Repository$/, '')
      .replace(/^EntityRepository<(.+)>$/, '$1');

    const baseNode = nodes.find(n => n.name === baseName && dependencyTypes.has(n.type));
    if (baseNode) return baseNode;

    if (depName.includes('Repository')) {
      const repositoryBase = depName
        .replace(/^EntityRepository<(.+)>$/, '$1')
        .replace(/Repository$/, '');

      const repositoryNode = nodes.find(n => {
        const isRepositoryNode = n.type === 'repository' || n.type === 'class';
        return isRepositoryNode && (
          n.name === depName ||
          n.name === repositoryBase ||
          n.name.includes(repositoryBase)
        );
      });

      if (repositoryNode) return repositoryNode;
    }

    return this.ensureNestInjectionNode(depName, nodes, newNodes);
  }

  private ensureNestInjectionNode(depName: string, nodes: CASNode[], newNodes: CASNode[]): CASNode {
    const classification = this.classifyNestDependency(depName);
    const nodeId = `nestjs_dependency_${this.sanitizeId(depName)}`;
    const existingNode = nodes.find(n => n.id === nodeId);
    if (existingNode) return existingNode;

    const node = this.createNodeBuilder(nodeId, depName, classification.nodeType)
      .withLevel(2, 'architectural')
      .withCategory(classification.category, classification.subcategories)
      .withDescription(`${classification.label}: ${depName}`)
      .withMetadata({
        framework: 'nestjs',
        attributes: {
          dependency_name: depName,
          dependency_origin: classification.origin,
          resolved_from: 'constructor_injection',
          external: classification.external
        }
      })
      .withAnalyzers([this.analyzerId], this.analyzerId)
      .build();

    nodes.push(node);
    newNodes.push(node);
    return node;
  }

  private addDependencyExitPoint(
    depName: string,
    sourceNodeId: string,
    exitPoints: CASExitPoint[],
    ownerName: string
  ): void {
    const classification = this.classifyNestDependency(depName);
    if (!classification.exitType) return;

    const exitId = `exit_nest_dependency_${this.sanitizeId(sourceNodeId)}_${this.sanitizeId(depName)}`;
    if (exitPoints.some(exitPoint => exitPoint.id === exitId)) return;

    exitPoints.push(this.createExitPoint(
      exitId,
      sourceNodeId,
      classification.exitType,
      classification.exitName,
      `${depName} injected into ${ownerName}`,
      classification.target,
      {
        action: classification.action,
        async: classification.async
      },
      {
        framework: 'nestjs',
        dependency: depName,
        injected_into: ownerName,
        origin: classification.origin
      }
    ));
  }

  private classifyNestDependency(depName: string): {
    nodeType: string;
    category: string;
    subcategories: string[];
    label: string;
    origin: string;
    external: boolean;
    exitType?: CASExitPoint['type'];
    exitName: string;
    target?: CASExitPoint['target'];
    action?: string;
    async?: boolean;
  } {
    const entityMatch = depName.match(/^(?:EntityRepository|Repository)<([^>]+)>$/);
    const entityName = entityMatch?.[1];

    if (entityName || depName === 'EntityRepository' || depName === 'Repository') {
      const resource = entityName || 'Entity';
      return {
        nodeType: 'database_client',
        category: 'database',
        subcategories: ['nestjs', 'mikroorm', 'repository'],
        label: 'NestJS database repository dependency',
        origin: 'mikroorm',
        external: true,
        exitType: 'database',
        exitName: `${resource} Repository (MikroORM)`,
        target: {
          service_id: 'database',
          resource
        },
        action: 'crud',
        async: true
      };
    }

    if (['EntityManager', 'PostgresEntityManager', 'MikroORM', 'Pool'].includes(depName)) {
      return {
        nodeType: 'database_client',
        category: 'database',
        subcategories: ['nestjs', 'orm', 'database-client'],
        label: 'NestJS database client dependency',
        origin: 'database',
        external: true,
        exitType: 'database',
        exitName: `${depName} Database Access`,
        target: {
          service_id: 'database',
          resource: depName
        },
        action: 'query',
        async: true
      };
    }

    if (['Redis', 'Cache', 'CacheManager'].includes(depName)) {
      return {
        nodeType: 'cache_client',
        category: 'cache',
        subcategories: ['nestjs', 'cache'],
        label: 'NestJS cache dependency',
        origin: 'cache',
        external: true,
        exitType: 'cache',
        exitName: `${depName} Cache Access`,
        target: {
          service_id: 'cache',
          resource: depName
        },
        action: 'read_write',
        async: true
      };
    }

    if (depName === 'EventEmitter2') {
      return {
        nodeType: 'event_bus',
        category: 'events',
        subcategories: ['nestjs', 'event-emitter'],
        label: 'NestJS event bus dependency',
        origin: 'event-emitter',
        external: true,
        exitType: 'event',
        exitName: 'EventEmitter2 Event Bus',
        target: {
          service_id: 'event-bus',
          resource: depName
        },
        action: 'publish',
        async: true
      };
    }

    if (['JwtService', 'ConfigService', 'ModuleRef'].includes(depName)) {
      return {
        nodeType: 'framework_service',
        category: 'framework',
        subcategories: ['nestjs', 'sdk'],
        label: 'NestJS framework service dependency',
        origin: 'nestjs',
        external: true,
        exitType: 'sdk',
        exitName: `${depName} SDK Access`,
        target: {
          service_id: 'nestjs',
          sdk: depName
        },
        action: depName === 'ConfigService' ? 'read_config' : 'invoke',
        async: false
      };
    }

    return {
      nodeType: 'injection_token',
      category: 'dependency',
      subcategories: ['nestjs', 'injection-token'],
      label: 'NestJS injection token',
      origin: 'application',
      external: false,
      exitName: `${depName} Dependency`
    };
  }

  private buildNestJSRelationships(
    modules: NestModule[],
    controllers: NestController[],
    providers: NestProvider[],
    guards: NestGuard[],
    middleware: NestMiddleware[],
    nodes: CASNode[],
    newNodes: CASNode[],
    edges: CASEdge[],
    exitPoints: CASExitPoint[]
  ): void {
    modules.forEach(module => {
      const moduleId = this.generateId('module', module.filePath, module.name);

      module.controllers.forEach(controllerName => {

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
          const providerNode = this.resolveNestDependencyNode(depName, nodes, newNodes);

          if (providerNode) {

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

            edges.push(this.createEdge(
              this.generateEdgeId(controllerNode.id, providerNode.id, 'depends_on'),
              controllerNode.id,
              providerNode.id,
              'depends_on',
              'dependency',
              { dependency_type: 'injection' }
            ));

            this.addDependencyExitPoint(depName, controllerNode.id, exitPoints, controller.name);
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
          const depProviderNode = this.resolveNestDependencyNode(depName, nodes, newNodes);

          if (depProviderNode) {

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

            edges.push(this.createEdge(
              this.generateEdgeId(providerNode.id, depProviderNode.id, 'depends_on'),
              providerNode.id,
              depProviderNode.id,
              'depends_on',
              'dependency',
              { dependency_type: 'injection' }
            ));

            if (depProviderNode.type === 'repository' && provider.methods.length > 0) {

              provider.methods.forEach(method => {
                const serviceMethodId = `method_${provider.filePath}_${provider.name}_${method.name}_0`;
                const serviceMethod = nodes.find(n => n.id === serviceMethodId ||
                  (n.name === method.name && n.type === 'method' && n.parent === providerNode.id));

                if (serviceMethod) {

                  const commonRepoMethods = ['find', 'findOne', 'create', 'save', 'update', 'delete', 'remove'];
                  commonRepoMethods.forEach(repoMethodName => {
                    const repoMethodId = `method_${depProviderNode.source?.file}_${depProviderNode.name}_${repoMethodName}_0`;
                    const repoMethod = nodes.find(n => n.id === repoMethodId ||
                      (n.name === repoMethodName && n.type === 'method' && n.parent === depProviderNode.id));

                    if (repoMethod) {
                      edges.push(this.createEdge(
                        this.generateEdgeId(serviceMethod.id, repoMethod.id, 'calls'),
                        serviceMethod.id,
                        repoMethod.id,
                        'calls',
                        'behavior',
                        {
                          call_type: 'repository_method_call',
                          from_service: provider.name,
                          to_repository: depName
                        }
                      ));
                    }
                  });
                }
              });
            }

            this.addDependencyExitPoint(depName, providerNode.id, exitPoints, provider.name);
          }
        });

        if (provider.type === 'repository') {

          const entityNodes = nodes.filter(n => n.type === 'entity' ||
            (n.type === 'class' && (n.subcategories?.includes('entity') ||
                                   n.subcategories?.includes('model') ||
                                   n.source?.file?.includes('.entity.'))));

          entityNodes.forEach(entityNode => {
            let shouldCreateEdge = false;

            const repoBaseName = provider.name.replace('Repository', '').toLowerCase();
            const entityBaseName = entityNode.name.replace('Entity', '').toLowerCase();

            if (repoBaseName === entityBaseName ||
                provider.name.toLowerCase().includes(entityNode.name.toLowerCase()) ||
                entityNode.name.toLowerCase().includes(repoBaseName)) {
              shouldCreateEdge = true;
            }

            if (!shouldCreateEdge && provider.filePath && entityNode.source?.file) {
              const repoDir = provider.filePath.split('/').slice(0, -1).join('/');
              const entityDir = entityNode.source.file.split('/').slice(0, -1).join('/');
              if (repoDir === entityDir) {

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

    this.createIntraServiceCallEdges(nodes, edges);
  }

  private createIntraServiceCallEdges(nodes: CASNode[], edges: CASEdge[]): void {

    const classMethods = new Map<string, CASNode[]>();

    nodes.filter(n => n.type === 'method' && n.parent).forEach(method => {
      const parent = method.parent!;
      if (!classMethods.has(parent)) {
        classMethods.set(parent, []);
      }
      classMethods.get(parent)!.push(method);
    });

    classMethods.forEach((methods, classId) => {
      methods.forEach(callerMethod => {

        methods.forEach(targetMethod => {
          if (callerMethod.id !== targetMethod.id) {

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

  private identifyDatabaseConnections(providers: NestProvider[], nodes: CASNode[], exitPoints: CASExitPoint[]): void {
    providers.forEach(provider => {
      const providerNode = this.findNestClassNode(nodes, provider.name, provider.filePath, ['class', 'service', 'repository', 'provider']);
      const providerId = providerNode?.id || `class_${provider.filePath}_${provider.name}_0`;

      if (provider.type === 'repository' || provider.name.toLowerCase().includes('repository')) {
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

        if (provider.dependencies.some(dep => dep.includes('EntityRepository'))) {
          exitPoints.push(this.createExitPoint(
            `exit_mikroorm_${this.sanitizeId(provider.name)}`,
            providerId,
            'sdk',
            `MikroORM EntityRepository via ${provider.name}`,
            `External library calls to MikroORM EntityRepository`,
            {
              service_id: 'mikroorm',
              resource: 'EntityRepository'
            },
            {
              action: 'call',
              async: true
            },
            {
              library: 'mikroorm',
              external_dependency: 'EntityRepository',
              methods: ['find', 'findOne', 'create', 'persist', 'flush', 'remove']
          }
          ));
        }
      }

      provider.dependencies.forEach(dep => {

        const externalLibraries = [
          { pattern: /HttpService|HttpClient/, name: 'http', desc: 'HTTP client operations' },
          { pattern: /Logger/, name: 'logging', desc: 'Logging operations' },
          { pattern: /RedisService|Redis/, name: 'redis', desc: 'Redis cache operations' },
          { pattern: /ElasticsearchService/, name: 'elasticsearch', desc: 'Elasticsearch operations' },
          { pattern: /MailService|Mailer/, name: 'mail', desc: 'Email service operations' },
          { pattern: /S3Service|StorageService/, name: 's3', desc: 'S3 storage operations' },
          { pattern: /QueueService|BullQueue/, name: 'queue', desc: 'Queue operations' },
          { pattern: /EventEmitter/, name: 'events', desc: 'Event emitter operations' }
        ];

        externalLibraries.forEach(lib => {
          if (lib.pattern.test(dep)) {
            exitPoints.push(this.createExitPoint(
              `exit_${lib.name}_${this.sanitizeId(provider.name)}`,
              providerId,
              'sdk',
              `${lib.desc} via ${provider.name}`,
              `External library calls to ${dep}`,
              {
                service_id: lib.name,
                resource: dep
              },
              {
                action: 'call',
                async: true
              },
              {
                provider_type: provider.type,
                external_dependency: dep,
                library: lib.name
              }
            ));
          }
        });
      });
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

  private extractImportsForIncremental(content: string): string[] {
    const imports: string[] = [];
    const importPattern = /import\s+(?:\{[^}]*\}|\w+|\*\s+as\s+\w+)\s+from\s+['"]([^'"]+)['"]/g;
    let match;

    while ((match = importPattern.exec(content)) !== null) {
      imports.push(match[1]);
    }

    return imports;
  }

  private extractRolesFromGuards(guards: string[]): string[] {
    return guards.filter(guard => guard.toLowerCase().includes('role')).map(guard => guard.toLowerCase());
  }

  private isAuthGuard(guard: string): boolean {
    return isAuthenticationGuardName(guard);
  }

  private createPerspectives(
    perspectives: CASPerspective[], modules: NestModule[], controllers: NestController[],
    providers: NestProvider[], guards: NestGuard[], middleware: NestMiddleware[],
    nodes: CASNode[], edges: CASEdge[]
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

    const nestFiles = new Set([...modules, ...controllers, ...providers, ...guards, ...middleware]
      .map(item => item.filePath));
    const nestNodes = nodes.filter(node => Boolean(node.source?.file && nestFiles.has(node.source.file)));
    const nestNodeIds = new Set(nestNodes.map(node => node.id));
    const nestEdges = edges.filter(edge => nestNodeIds.has(edge.source) || nestNodeIds.has(edge.target));
    this.tagNodesWithPerspectives(nestNodes, nestEdges, perspectives);
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
            node.perspectives = {};
          }
          if (!node.perspectives[perspective.id]) {
            node.perspectives[perspective.id] = {
              hierarchy: [perspective.id],
              level: node.level || 1,
              priority: 1
            };
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

  private extractDocumentation(node: any, content: string): CASDocumentation | undefined {
    const lines = content.split('\n');

    if (!node.loc?.start?.line) return undefined;

    let lineIndex = node.loc.start.line - 2;

    while (lineIndex >= 0) {
      const line = lines[lineIndex]?.trim();
      if (!line) {
        lineIndex--;
        continue;
      }

      if (line.includes('*/')) {

        let docStart = lineIndex;
        while (docStart >= 0 && !lines[docStart]?.trim().includes('/**')) {
          docStart--;
        }

        if (docStart >= 0) {
          const docLines = lines.slice(docStart, lineIndex + 1);
          const raw = docLines.join('\n');
          return this.parseJSDoc(raw, docStart + 1, lineIndex + 1);
        }
      }

      if (line && !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*')) {
        break;
      }

      lineIndex--;
    }

    return undefined;
  }

  private parseJSDoc(raw: string, startLine: number, endLine: number): CASDocumentation {
    const doc: CASDocumentation = {
      type: 'jsdoc',
      raw,
      location: { start_line: startLine, end_line: endLine }
    };

    const lines = raw.split('\n');
    for (const line of lines) {
      const cleaned = line.replace(/^\s*\*\s?/, '').trim();
      if (cleaned && !cleaned.startsWith('@') && !cleaned.includes('/**') && !cleaned.includes('*/')) {
        doc.summary = cleaned;
        break;
      }
    }

    const apiOpMatch = raw.match(/@ApiOperation\s*\(\s*{[^}]*summary:\s*['"`]([^'"`]+)['"`]/);
    if (apiOpMatch) {
      doc.framework_docs = {
        swagger: {
          summary: apiOpMatch[1],
          description: doc.summary
        }
      };
    }

    const apiResponseMatches = raw.matchAll(/@ApiResponse\s*\(\s*{[^}]*description:\s*['"`]([^'"`]+)['"`]/g);
    if (apiResponseMatches) {
      doc.framework_docs = doc.framework_docs || { swagger: {} };
    }

    const paramMatches = raw.matchAll(/@param\s+(?:{([^}]+)}\s+)?(\w+)(?:\s+(.+))?/g);
    if (paramMatches) {
      doc.parameters = [];
      for (const match of paramMatches) {
        doc.parameters.push({
          name: match[2],
          type: match[1],
          description: match[3]?.trim()
        });
      }
    }

    const returnMatch = raw.match(/@returns?\s+(?:{([^}]+)}\s+)?(.+)/);
    if (returnMatch) {
      doc.returns = {
        type: returnMatch[1],
        description: returnMatch[2]?.trim()
      };
    }

    const deprecatedMatch = raw.match(/@deprecated\s+(.+)/);
    if (deprecatedMatch) {
      doc.tags = doc.tags || [];
      doc.tags.push({
        tag: '@deprecated',
        value: deprecatedMatch[1].trim()
      });
    }

    return doc;
  }

  private extractComments(node: any, content: string, filePath: string): CASComment[] {
    const comments: CASComment[] = [];
    const lines = content.split('\n');

    if (!node.loc?.start?.line || !node.loc?.end?.line) return comments;

    for (let i = node.loc.start.line - 1; i < node.loc.end.line; i++) {
      const line = lines[i];
      if (!line) continue;

      const singleLineMatch = line.match(/\/\/\s*(.+)/);
      if (singleLineMatch) {
        const text = singleLineMatch[1].trim();
        const comment: CASComment = {

          id: `comment_${filePath}_${i + 1}`,
          type: 'single-line',
          style: '//',
          text,
          purpose: this.classifyCommentPurpose(text),
          location: {
            file: filePath,
            line: i + 1
          },
          markers: {
            is_todo: text.toUpperCase().includes('TODO'),
            is_fixme: text.toUpperCase().includes('FIXME'),
            is_hack: text.toUpperCase().includes('HACK'),
            is_warning: text.toUpperCase().includes('WARNING'),
            is_note: text.toUpperCase().includes('NOTE')
          }
        };
        comments.push(comment);
      }
    }

    return comments;
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

  private findModuleClassNode(ast: TSESTree.Program): any {
    const aliases = this.buildImportAliasMap(ast);
    let moduleNode: any = null;

    const walk = (node: any) => {
      if (!node || typeof node !== 'object') return;

      if (node.type === 'ClassDeclaration' && node.decorators) {
        const hasModuleDecorator = node.decorators.some((dec: any) =>
          this.isDecorator(dec, 'Module', aliases)
        );
        if (hasModuleDecorator) {
          moduleNode = node;
          return;
        }
      }

      for (const key in node) {
        if (key === 'parent') continue;
        if (Array.isArray(node[key])) {
          node[key].forEach(walk);
        } else if (typeof node[key] === 'object' && node[key]) {
          walk(node[key]);
        }
      }
    };

    walk(ast);
    return moduleNode;
  }

  private findNestClassNode(nodes: CASNode[], className: string, filePath: string, allowedTypes: string[]): CASNode | undefined {
    const expectedId = `class_${filePath}_${className}_0`;
    const exact = nodes.find(n => n.id === expectedId);
    if (exact) return exact;

    return nodes.find(n =>
      n.name === className &&
      allowedTypes.includes(n.type) &&
      this.sourceMatches(n.source?.file, filePath)
    );
  }

  private sourceMatches(sourceFile: string | undefined, expectedFile: string): boolean {
    if (!sourceFile) return false;
    if (sourceFile === expectedFile) return true;
    return sourceFile.endsWith(expectedFile) || expectedFile.endsWith(sourceFile);
  }

  private findControllerHandlerMethod(ast: TSESTree.Program, handlerName: string): any {
    let handlerNode: any = null;

    const walk = (node: any) => {
      if (!node || typeof node !== 'object') return;

      if (node.type === 'MethodDefinition' && node.key?.name === handlerName) {
        handlerNode = node;
        return;
      }

      for (const key in node) {
        if (key === 'parent') continue;
        if (Array.isArray(node[key])) {
          node[key].forEach(walk);
        } else if (typeof node[key] === 'object' && node[key]) {
          walk(node[key]);
        }
      }
    };

    walk(ast);
    return handlerNode;
  }

  private detectImplementationStatus(node: any, content: string): CASImplementationStatus | undefined {
    if (!node) return undefined;

    const lines = content.split('\n');
    const startLine = node.loc?.start?.line || 1;
    const endLine = node.loc?.end?.line || lines.length;

    const codeLines = lines.slice(startLine - 1, endLine);
    const codeContent = codeLines.join('\n');

    const indicators = {
      has_todo_markers: /\b(TODO|FIXME|HACK)\b/i.test(codeContent),
      has_not_implemented_exceptions: /throw\s+.*(NotImplemented|Unsupported|TODO)/i.test(codeContent),
      has_stub_returns: /return\s+(null|undefined|false|0|''|""|\[\]|\{\})\s*;?\s*$/m.test(codeContent),
      has_placeholder_code: /console\.(log|warn|error)\s*\(['"].*TODO/i.test(codeContent),
      has_hardcoded_values: /const\s+\w+\s*=\s*['"]PLACEHOLDER|TEMP|TODO/i.test(codeContent),
      has_commented_out_code: /\/\/.*\w+\s*\(|^\/\*[\s\S]*?\*\//m.test(codeContent)
    };

    let status: CASImplementationStatus['status'] = 'complete';

    const isEmpty = codeContent.trim().length < 20 || /^\{\s*\}$/.test(codeContent.trim());
    if (isEmpty) {
      status = 'stub';
    } else if (indicators.has_not_implemented_exceptions) {
      status = 'not-implemented';
    } else if (indicators.has_todo_markers || indicators.has_stub_returns) {
      status = 'partial';
    }

    if (/@deprecated/i.test(codeContent) || codeContent.includes('@Deprecated')) {
      status = 'deprecated';
    }
    if (/@experimental|@beta/i.test(codeContent)) {
      status = 'experimental';
    }

    return {
      status,
      indicators,
      completeness: {
        estimated_percentage: status === 'complete' ? 100 :
                             status === 'partial' ? 50 :
                             status === 'stub' ? 10 : 0
      }
    };
  }
}
