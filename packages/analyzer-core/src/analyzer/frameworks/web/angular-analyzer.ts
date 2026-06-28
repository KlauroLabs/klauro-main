import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint,
  CASDocumentation, CASComment, CASTodo, CASImplementationStatus, CASPerspective
} from "../../../types/cas.types";
import { AnalyzerError } from '../../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';
import { glob } from 'glob';
import { parse } from '@typescript-eslint/typescript-estree';
import { AngularRouteResolver, ResolvedAngularRoute } from './angular-route-resolver';

interface AngularApplication {
  name: string;
  entryPoint: string;
  type: 'cli' | 'standalone' | 'universal' | 'custom';
  typescript: boolean;
  router: boolean;
  stateManagement: string[];
  testing: string[];
  buildTool: string;
  angularVersion: string;
}

interface AngularComponent {
  name: string;
  filePath: string;
  selector: string;
  templateUrl?: string;
  styleUrls: string[];
  inputs: Array<{ name: string; type: string; alias?: string }>;
  outputs: Array<{ name: string; type: string; alias?: string }>;
  providers: string[];
  viewChild: string[];
  contentChild: string[];
  lifecycle: string[];
  imports: string[];
  exports: string[];
  standalone: boolean;
  /** Custom-element selectors used inside this component's inline template. */
  childSelectors: string[];
  /** Constructor-injected collaborator types (Angular DI). */
  dependencies: string[];
}

interface AngularService {
  name: string;
  filePath: string;
  providedIn: string;
  injectable: boolean;
  dependencies: string[];
  methods: Array<{ name: string; parameters: any[]; returnType?: string }>;
  properties: Array<{ name: string; type: string; access: string }>;
}

interface AngularModule {
  name: string;
  filePath: string;
  declarations: string[];
  imports: string[];
  exports: string[];
  providers: string[];
  bootstrap: string[];
  entryComponents: string[];
  schemas: string[];
}

interface AngularDirective {
  name: string;
  filePath: string;
  selector: string;
  exportAs?: string;
  inputs: Array<{ name: string; type: string; alias?: string }>;
  outputs: Array<{ name: string; type: string; alias?: string }>;
  host: Record<string, string>;
  lifecycle: string[];
}

interface AngularPipe {
  name: string;
  filePath: string;
  pipeName: string;
  pure: boolean;
  transform: { parameters: any[]; returnType?: string };
}

interface AngularGuard {
  name: string;
  filePath: string;
  type: 'CanActivate' | 'CanActivateChild' | 'CanDeactivate' | 'CanLoad' | 'CanMatch' | 'Resolve';
  functional: boolean;
  methods: string[];
  dependencies: string[];
}

interface AngularRoute {
  path: string;
  component?: string;
  loadChildren?: string;
  redirectTo?: string;
  canActivate?: string[];
  canDeactivate?: string[];
  resolve?: Record<string, string>;
  data?: Record<string, any>;
  children?: AngularRoute[];
}

export class AngularAnalyzer extends BaseAnalyzer {
  private todoCounter = 0;
  private commentCounter = 0;

  constructor() {
    super(
      'angular',
      'Angular Framework Analyzer',
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

      // First check if this is a NestJS project - if so, skip Angular analysis
      const isNestJS = Object.keys(deps).some(dep =>
        dep === '@nestjs/core' ||
        dep === '@nestjs/common' ||
        dep === '@nestjs/platform-express'
      );

      if (isNestJS) {
        return false; // Don't analyze NestJS projects with Angular analyzer
      }

      // Check for explicit Angular dependencies
      if (Object.keys(deps).some(dep => dep.startsWith('@angular/') || dep === 'angular')) {
        return true;
      }

      // Check for Angular configuration files
      const angularConfigExists = await fs.pathExists(path.join(projectPath, 'angular.json'));
      if (angularConfigExists) return true;

      // As a last resort, check file contents but be more specific about Angular imports
      const tsFiles = await glob(['**/*.ts'], {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true
      });

      for (const file of tsFiles) {
        const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
        // More specific checks for Angular - look for @angular/ imports and Angular-specific decorators
        if (content.includes('@angular/') ||
            (content.includes('@Component') && content.includes('@angular/core')) ||
            (content.includes('@NgModule') && content.includes('@angular/core'))) {
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
      const angularFiles = await glob(['**/*.ts'], {
        cwd: context.projectPath,
        ignore: [...this.getIgnorePatterns(context), '**/*.spec.ts', '**/*.test.ts'],
        nodir: true
      });

      const application = await this.analyzeApplication(context.projectPath, nodes);
      const components = await this.analyzeComponents(angularFiles, context.projectPath, nodes, edges);
      const services = await this.analyzeServices(angularFiles, context.projectPath, nodes, edges);
      this.buildInjectionEdges(components, services, edges);
      const modules = await this.analyzeModules(angularFiles, context.projectPath, nodes, edges);
      const directives = await this.analyzeDirectives(angularFiles, context.projectPath, nodes, edges);
      const pipes = await this.analyzePipes(angularFiles, context.projectPath, nodes, edges);
      const guards = await this.analyzeGuards(angularFiles, context.projectPath, nodes, edges);
      const routes = await this.analyzeRoutes(angularFiles, context.projectPath, nodes, edges, entryPoints, components, guards);

      this.buildAngularRelationships(components, services, modules, directives, pipes, guards, routes, nodes, edges);
      this.identifyAPIConnections(services, components, exitPoints);

      this.tagNodesWithPerspectives(nodes, edges);
      this.createPerspectives(perspectives);

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework_specific: {
          angular_version: await this.detectAngularVersion(context.projectPath),
          typescript: application?.typescript || false,
          application_type: application?.type || 'custom',
          router: application?.router || false,
          state_management: application?.stateManagement || [],
          components_detected: components.length,
          services_detected: services.length,
          modules_detected: modules.length,
          directives_detected: directives.length,
          pipes_detected: pipes.length,
          guards_detected: guards.length,
          routes_detected: routes.length
        },
        perspectives,
        provided_perspectives: perspectives.map(p => p.id)
      });

    } catch (error) {
      throw new AnalyzerError(
        `Angular analysis failed: ${(error as Error).message}`,
        'ANGULAR_ANALYSIS_ERROR'
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
      'component-analysis',
      'service-detection',
      'module-mapping',
      'directive-analysis',
      'pipe-detection',
      'guard-analysis',
      'dependency-injection',
      'lifecycle-tracking',
      'decorator-parsing'
    ];
  }

  private async analyzeApplication(projectPath: string, nodes: CASNode[]): Promise<AngularApplication | null> {
    try {
      const packageJson = await fs.readJson(path.join(projectPath, 'package.json'));
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };

      const typescript = Object.keys(deps).includes('typescript') ||
                        await fs.pathExists(path.join(projectPath, 'tsconfig.json'));

      let type: 'cli' | 'standalone' | 'universal' | 'custom' = 'custom';
      if (Object.keys(deps).includes('@angular/cli')) type = 'cli';
      else if (Object.keys(deps).includes('@nguniversal/express-engine')) type = 'universal';

      const router = Object.keys(deps).includes('@angular/router');
      const stateManagement = this.detectStateManagement(deps);
      const testing = this.detectTestingFrameworks(deps);
      const buildTool = this.detectBuildTool(deps, projectPath);
      const angularVersion = deps['@angular/core'] || 'unknown';

      const entryPoint = await this.findEntryPoint(projectPath);

      const application: AngularApplication = {
        name: packageJson.name || 'angular-app',
        entryPoint,
        type,
        typescript,
        router,
        stateManagement,
        testing,
        buildTool,
        angularVersion
      };

      const appId = this.generateId('app', path.join(projectPath, 'package.json'), application.name);
      const appNode = this.createNodeBuilder(appId, application.name, 'angular_app')
        .withLevel(1, 'system')
        .withCategory('frontend', ['angular', 'application'])
        .withSource({ file: path.join(projectPath, 'package.json'), line: 1, end_line: 1 })
        .withDescription(`Angular application: ${application.name}`)
        .withMetadata({
          framework: 'angular',
          attributes: {
            type,
            typescript,
            router,
            state_management: stateManagement,
            testing,
            build_tool: buildTool,
            angular_version: angularVersion,
            entry_point: entryPoint
          }
        })
        .build();
      nodes.push(appNode);

      return application;
    } catch {
      return null;
    }
  }

  private async analyzeComponents(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<AngularComponent[]> {
    const components: AngularComponent[] = [];
    // selector -> component node id, to resolve template child tags to components.
    const selectorToId = new Map<string, string>();
    const componentIdByName = new Map<string, string>();

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('@Component')) {
        try {
          const ast = parse(content, { loc: true, jsx: false });
          const component = this.extractAngularComponent(ast, content, file);

          if (component) {
            components.push(component);

            const componentId = this.generateId('component', component.filePath, component.name);
            if (component.selector) selectorToId.set(component.selector.toLowerCase(), componentId);
            componentIdByName.set(component.name, componentId);
            const componentNode = this.createNodeBuilder(componentId, component.name, 'angular_component')
              .withLevel(2, 'architectural')
              .withCategory('component', ['angular', 'ui'])
              .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
              .withDescription(`Angular component: ${component.name}`)
              .withMetadata({
                framework: 'angular',
                attributes: {
                  selector: component.selector,
                  template_url: component.templateUrl,
                  style_urls: component.styleUrls,
                  inputs_count: component.inputs.length,
                  outputs_count: component.outputs.length,
                  providers_count: component.providers.length,
                  view_child_count: component.viewChild.length,
                  content_child_count: component.contentChild.length,
                  lifecycle_count: component.lifecycle.length,
                  standalone: component.standalone
                }
              })
              .build();
            nodes.push(componentNode);
          }
        } catch (error) {
          console.warn(`Failed to parse Angular component ${file}:`, error);
        }
      }
    }

    // Post-pass: parent renders child — resolve each template's child selectors
    // to the component that declares that selector, emit a `renders` edge.
    for (const component of components) {
      const parentId = componentIdByName.get(component.name);
      if (!parentId) continue;
      for (const sel of component.childSelectors) {
        const childId = selectorToId.get(sel);
        if (!childId || childId === parentId) continue;
        edges.push({
          id: this.generateEdgeId(parentId, childId, 'renders'),
          source: parentId,
          target: childId,
          type: 'renders',
          metadata: { framework: 'angular', via_selector: sel }
        } as CASEdge);
      }
    }

    return components;
  }

  /**
   * Angular DI graph: a component/service's constructor params are the
   * collaborators its injector supplies. Emit a `depends_on` edge tagged
   * dependency_type:injection per resolved collaborator — the Camp-C fact
   * structural indexers can't see (they read imports/usages, not injection).
   */
  private buildInjectionEdges(
    components: AngularComponent[],
    services: AngularService[],
    edges: CASEdge[]
  ): void {
    const idByType = new Map<string, string>();
    for (const c of components) idByType.set(c.name, this.generateId('component', c.filePath, c.name));
    for (const s of services) idByType.set(s.name, this.generateId('service', s.filePath, s.name));

    const link = (ownerId: string, deps: string[]): void => {
      for (const dep of deps) {
        const targetId = idByType.get(dep);
        if (!targetId || targetId === ownerId) continue;
        edges.push({
          id: this.generateEdgeId(ownerId, targetId, 'depends_on'),
          source: ownerId,
          target: targetId,
          type: 'depends_on',
          metadata: { framework: 'angular', dependency_type: 'injection' }
        } as CASEdge);
      }
    };

    for (const c of components) link(this.generateId('component', c.filePath, c.name), c.dependencies);
    for (const s of services) link(this.generateId('service', s.filePath, s.name), s.dependencies);
  }

  private async analyzeServices(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<AngularService[]> {
    const services: AngularService[] = [];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('@Injectable')) {
        try {
          const ast = parse(content, { loc: true, jsx: false });
          const service = this.extractAngularService(ast, content, file);

          if (service) {
            services.push(service);

            const serviceId = this.generateId('service', service.filePath, service.name);
            const serviceNode = this.createNodeBuilder(serviceId, service.name, 'angular_service')
              .withLevel(2, 'architectural')
              .withCategory('service', ['angular', 'injectable'])
              .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
              .withDescription(`Angular service: ${service.name}`)
              .withMetadata({
                framework: 'angular',
                attributes: {
                  provided_in: service.providedIn,
                  injectable: service.injectable,
                  dependencies_count: service.dependencies.length,
                  methods_count: service.methods.length,
                  properties_count: service.properties.length
                }
              })
              .build();
            nodes.push(serviceNode);

            service.methods.forEach((method, index) => {
              const methodId = this.generateId('method', service.filePath, `${service.name}_${method.name}`);
              const methodNode = this.createNodeBuilder(methodId, method.name, 'method')
                .withLevel(4, 'member')
                .withCategory('method', ['angular', 'function'])
                .withSource({ file: fullPath, line: 1, end_line: 1 })
                .withDescription(`Method in ${service.name}: ${method.name}`)
                .withParent(serviceId)
                .withSignature({
                  parameters: method.parameters.map(p => ({ name: p.name || 'param', type: p.type || 'any' })),
                  return_type: method.returnType
                })
                .withMetadata({
                  framework: 'angular'
                })
                .build();
              nodes.push(methodNode);

              edges.push(this.createEdge(
                this.generateEdgeId(serviceId, methodId, 'contains'),
                serviceId,
                methodId,
                'contains',
                'structural'
              ));
            });
          }
        } catch (error) {
          console.warn(`Failed to parse Angular service ${file}:`, error);
        }
      }
    }

    return services;
  }

  private async analyzeModules(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<AngularModule[]> {
    const modules: AngularModule[] = [];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('@NgModule')) {
        try {
          const ast = parse(content, { loc: true, jsx: false });
          const module = this.extractAngularModule(ast, content, file);

          if (module) {
            modules.push(module);

            const moduleId = this.generateId('module', module.filePath, module.name);
            const moduleNode = this.createNodeBuilder(moduleId, module.name, 'angular_module')
              .withLevel(1, 'system')
              .withCategory('module', ['angular', 'organizational'])
              .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
              .withDescription(`Angular module: ${module.name}`)
              .withMetadata({
                framework: 'angular',
                attributes: {
                  declarations_count: module.declarations.length,
                  imports_count: module.imports.length,
                  exports_count: module.exports.length,
                  providers_count: module.providers.length,
                  bootstrap_count: module.bootstrap.length,
                  entry_components_count: module.entryComponents.length
                }
              })
              .build();
            nodes.push(moduleNode);
          }
        } catch (error) {
          console.warn(`Failed to parse Angular module ${file}:`, error);
        }
      }
    }

    return modules;
  }

  private async analyzeDirectives(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<AngularDirective[]> {
    const directives: AngularDirective[] = [];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('@Directive')) {
        try {
          const ast = parse(content, { loc: true, jsx: false });
          const directive = this.extractAngularDirective(ast, content, file);

          if (directive) {
            directives.push(directive);

            const directiveId = this.generateId('directive', directive.filePath, directive.name);
            const directiveNode = this.createNodeBuilder(directiveId, directive.name, 'angular_directive')
              .withLevel(3, 'code')
              .withCategory('directive', ['angular', 'dom'])
              .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
              .withDescription(`Angular directive: ${directive.name}`)
              .withMetadata({
                framework: 'angular',
                attributes: {
                  selector: directive.selector,
                  export_as: directive.exportAs,
                  inputs_count: directive.inputs.length,
                  outputs_count: directive.outputs.length,
                  host: directive.host,
                  lifecycle_count: directive.lifecycle.length
                }
              })
              .build();
            nodes.push(directiveNode);
          }
        } catch (error) {
          console.warn(`Failed to parse Angular directive ${file}:`, error);
        }
      }
    }

    return directives;
  }

  private async analyzePipes(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<AngularPipe[]> {
    const pipes: AngularPipe[] = [];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('@Pipe')) {
        try {
          const ast = parse(content, { loc: true, jsx: false });
          const pipe = this.extractAngularPipe(ast, content, file);

          if (pipe) {
            pipes.push(pipe);

            const pipeId = this.generateId('pipe', pipe.filePath, pipe.name);
            const pipeNode = this.createNodeBuilder(pipeId, pipe.name, 'angular_pipe')
              .withLevel(3, 'code')
              .withCategory('pipe', ['angular', 'transform'])
              .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
              .withDescription(`Angular pipe: ${pipe.name}`)
              .withMetadata({
                framework: 'angular',
                attributes: {
                  pipe_name: pipe.pipeName,
                  pure: pipe.pure,
                  transform: pipe.transform
                }
              })
              .build();
            nodes.push(pipeNode);
          }
        } catch (error) {
          console.warn(`Failed to parse Angular pipe ${file}:`, error);
        }
      }
    }

    return pipes;
  }

  private async analyzeGuards(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<AngularGuard[]> {
    const guards: AngularGuard[] = [];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('CanActivate') || content.includes('CanDeactivate') || content.includes('CanLoad') || content.includes('CanMatch') || content.includes('Resolve')) {
        try {
          const extractedGuards = this.extractAngularGuards(content, file);

          for (const guard of extractedGuards) {
            guards.push(guard);

            const guardId = this.generateId('guard', guard.filePath, guard.name);
            const guardNode = this.createNodeBuilder(guardId, guard.name, 'angular_guard')
              .withLevel(3, 'code')
              .withCategory('guard', ['angular', 'security'])
              .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
              .withDescription(`Angular guard: ${guard.name}`)
              .withMetadata({
                framework: 'angular',
                attributes: {
                  guard_type: guard.type,
                  functional: guard.functional,
                  methods: guard.methods,
                  dependencies_count: guard.dependencies.length
                }
              })
              .build();
            nodes.push(guardNode);
          }
        } catch (error) {
          console.warn(`Failed to parse Angular guard ${file}:`, error);
        }
      }
    }

    return guards;
  }

  private async analyzeRoutes(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    components: AngularComponent[],
    guards: AngularGuard[]
  ): Promise<AngularRoute[]> {
    let resolvedRoutes: ResolvedAngularRoute[] = [];
    try {
      const resolver = new AngularRouteResolver(projectPath);
      resolvedRoutes = (await resolver.resolve(files)).routes;
    } catch (error) {
      console.warn('Angular route resolution failed:', error);
    }

    if (resolvedRoutes.length > 0) {
      return this.emitResolvedRoutes(resolvedRoutes, projectPath, nodes, edges, entryPoints, components, guards);
    }

    return this.analyzeRoutesByPattern(files, projectPath, nodes, entryPoints);
  }

  private emitResolvedRoutes(
    resolvedRoutes: ResolvedAngularRoute[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    components: AngularComponent[],
    guards: AngularGuard[]
  ): AngularRoute[] {
    const componentIdsByName = new Map<string, Array<{ id: string; filePath: string }>>();
    for (const component of components) {
      const list = componentIdsByName.get(component.name) || [];
      list.push({ id: this.generateId('component', component.filePath, component.name), filePath: component.filePath });
      componentIdsByName.set(component.name, list);
    }
    const guardIdsByName = new Map<string, string>();
    for (const guard of guards) {
      guardIdsByName.set(guard.name, this.generateId('guard', guard.filePath, guard.name));
    }

    const routes: AngularRoute[] = [];
    const seenRouteIds = new Set<string>();

    for (const route of resolvedRoutes) {
      const displayPath = `/${route.fullPath}`;
      const allGuards = [...new Set([...route.inheritedGuards, ...route.guards])];
      const routeId = this.generateId('route', route.sourceFile, `${displayPath}_${route.line}`);
      if (seenRouteIds.has(routeId)) continue;
      seenRouteIds.add(routeId);

      const routeNode = this.createNodeBuilder(routeId, displayPath, 'angular_route')
        .withLevel(3, 'code')
        .withCategory('route', ['angular', 'navigation'])
        .withSource({ file: path.join(projectPath, route.sourceFile), line: route.line, end_line: route.line })
        .withDescription(route.component
          ? `Angular route ${displayPath} rendering ${route.component}`
          : route.redirectTo !== undefined
            ? `Angular route ${displayPath} redirecting to ${route.redirectTo || '/'}`
            : `Angular route ${displayPath}`)
        .withMetadata({
          framework: 'angular',
          attributes: {
            path: displayPath,
            segment: route.segment,
            path_resolved: route.pathResolved,
            component: route.component,
            component_file: route.componentFile,
            lazy: route.lazyComponent || route.lazyChildren,
            load_children: route.loadChildrenFile,
            redirect_to: route.redirectTo,
            guards: allGuards.length > 0 ? allGuards : undefined,
            guard_kinds: Object.keys(route.guardKinds).length > 0 ? route.guardKinds : undefined,
            resolve: route.resolve,
            data: route.data
          }
        })
        .build();
      nodes.push(routeNode);

      if (route.component) {
        const candidates = componentIdsByName.get(route.component) || [];
        const matched = route.componentFile
          ? candidates.find(candidate => candidate.filePath === route.componentFile) || candidates[0]
          : candidates[0];
        const componentId = matched?.id
          || this.generateId('component', route.componentFile || '', route.component);
        edges.push(this.createEdge(
          this.generateEdgeId(routeId, componentId, 'renders'),
          routeId,
          componentId,
          'renders',
          'structural',
          { route_path: displayPath }
        ));
        edges.push(this.createEdge(
          this.generateEdgeId(routeId, componentId, 'routes_to'),
          routeId,
          componentId,
          'routes_to',
          'dependency',
          { route_path: displayPath }
        ));
      }

      for (const guardName of allGuards) {
        const guardId = guardIdsByName.get(guardName);
        if (!guardId) continue;
        edges.push(this.createEdge(
          this.generateEdgeId(routeId, guardId, 'guarded_by'),
          routeId,
          guardId,
          'guarded_by',
          'dependency',
          { route_path: displayPath, guard: guardName }
        ));
      }

      if (route.component && route.pathResolved && route.segment !== '**') {
        entryPoints.push(this.createEntryPoint(
          `entry_${routeId}`,
          routeId,
          'route',
          `Route ${displayPath}`,
          `Angular route ${displayPath} rendering ${route.component}`,
          {
            path: displayPath,
            method: 'GET'
          },
          {
            authenticated: allGuards.length > 0,
            authorized_roles: allGuards
          },
          {
            component: route.component,
            component_file: route.componentFile,
            guards: allGuards,
            lazy: route.lazyComponent || route.lazyChildren,
            data: route.data,
            route_file: route.sourceFile
          }
        ));
      }

      routes.push({
        path: displayPath,
        component: route.component,
        loadChildren: route.loadChildrenFile,
        redirectTo: route.redirectTo,
        canActivate: allGuards.length > 0 ? allGuards : undefined,
        data: route.data
      });
    }

    return routes;
  }

  private async analyzeRoutesByPattern(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[]
  ): Promise<AngularRoute[]> {
    const routes: AngularRoute[] = [];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('RouterModule') || content.includes('Routes') || file.includes('routing')) {
        try {
          const extractedRoutes = this.extractRoutes(content, file);
          routes.push(...extractedRoutes);

          extractedRoutes.forEach((route, index) => {
            const routeId = this.generateId('route', file, `${route.path}_${index}`);
            const routeNode = this.createNodeBuilder(routeId, route.path, 'angular_route')
              .withLevel(3, 'code')
              .withCategory('route', ['angular', 'navigation'])
              .withSource({ file: fullPath, line: 1, end_line: 1 })
              .withDescription(`Angular route: ${route.path}`)
              .withMetadata({
                framework: 'angular',
                attributes: {
                  path: route.path,
                  component: route.component,
                  load_children: route.loadChildren,
                  redirect_to: route.redirectTo,
                  can_activate: route.canActivate,
                  can_deactivate: route.canDeactivate,
                  resolve: route.resolve,
                  data: route.data,
                  has_children: (route.children?.length || 0) > 0
                }
              })
              .build();
            nodes.push(routeNode);

            entryPoints.push(this.createEntryPoint(
              `entry_${routeId}`,
              routeId,
              'route',
              `Route ${route.path}`,
              `Angular route mapping to component ${route.component || 'lazy-loaded'}`,
              {
                path: route.path,
                method: 'GET'
              },
              {
                authenticated: (route.canActivate?.length || 0) > 0,
                authorized_roles: route.canActivate || []
              },
              {
                component: route.component,
                load_children: route.loadChildren,
                data: route.data
              }
            ));
          });
        } catch (error) {
          console.warn(`Failed to parse Angular routes ${file}:`, error);
        }
      }
    }

    return routes;
  }

  private detectStateManagement(deps: Record<string, any>): string[] {
    const stateManagement: string[] = [];
    if (deps['@ngrx/store']) stateManagement.push('ngrx');
    if (deps['@ngxs/store']) stateManagement.push('ngxs');
    if (deps['akita']) stateManagement.push('akita');
    return stateManagement;
  }

  private detectTestingFrameworks(deps: Record<string, any>): string[] {
    const testing: string[] = [];
    if (deps['@angular/testing']) testing.push('angular-testing');
    if (deps['jasmine']) testing.push('jasmine');
    if (deps['karma']) testing.push('karma');
    if (deps['protractor']) testing.push('protractor');
    if (deps['cypress']) testing.push('cypress');
    if (deps['jest']) testing.push('jest');
    return testing;
  }

  private detectBuildTool(deps: Record<string, any>, projectPath: string): string {
    if (deps['@angular/cli']) return 'angular-cli';
    if (deps['webpack']) return 'webpack';
    if (deps['vite']) return 'vite';
    return 'unknown';
  }

  private async findEntryPoint(projectPath: string): Promise<string> {
    const possibleEntryPoints = [
      'src/main.ts',
      'src/main.js',
      'src/index.ts',
      'src/index.js'
    ];

    for (const entry of possibleEntryPoints) {
      if (await fs.pathExists(path.join(projectPath, entry))) {
        return entry;
      }
    }

    return 'src/main.ts';
  }

  private extractAngularComponent(ast: any, content: string, filePath: string): AngularComponent | null {
    const componentName = this.extractClassName(ast);
    if (!componentName) return null;

    return {
      name: componentName,
      filePath,
      selector: this.extractSelector(content),
      templateUrl: this.extractTemplateUrl(content),
      styleUrls: this.extractStyleUrls(content),
      inputs: this.extractInputs(content),
      outputs: this.extractOutputs(content),
      providers: this.extractProviders(content),
      viewChild: this.extractViewChild(content),
      contentChild: this.extractContentChild(content),
      lifecycle: this.extractLifecycle(content),
      imports: this.extractImports(content),
      exports: this.extractExports(content),
      standalone: content.includes('standalone: true'),
      childSelectors: this.extractChildSelectors(content),
      dependencies: this.extractDependencies(content)
    };
  }

  /**
   * Custom-element tags used inside the component's inline template are its
   * rendered children. We resolve each tag back to the component whose
   * `selector` matches, building the component tree (the Camp-C fact embeddings
   * and structural indexers can't produce — they see imports, not renders).
   */
  private extractChildSelectors(content: string): string[] {
    const tplMatch = content.match(/template:\s*([`'"])([\s\S]*?)\1/);
    if (!tplMatch) return [];
    const template = tplMatch[2];
    const selectors = new Set<string>();
    const tagRe = /<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)\b/gi;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(template)) !== null) {
      selectors.add(m[1].toLowerCase());
    }
    return [...selectors];
  }

  private extractAngularService(ast: any, content: string, filePath: string): AngularService | null {
    const serviceName = this.extractClassName(ast);
    if (!serviceName) return null;

    return {
      name: serviceName,
      filePath,
      providedIn: this.extractProvidedIn(content),
      injectable: true,
      dependencies: this.extractDependencies(content),
      methods: this.extractMethods(content),
      properties: this.extractProperties(content)
    };
  }

  private extractAngularModule(ast: any, content: string, filePath: string): AngularModule | null {
    const moduleName = this.extractClassName(ast);
    if (!moduleName) return null;

    return {
      name: moduleName,
      filePath,
      declarations: this.extractDeclarations(content),
      imports: this.extractModuleImports(content),
      exports: this.extractModuleExports(content),
      providers: this.extractProviders(content),
      bootstrap: this.extractBootstrap(content),
      entryComponents: this.extractEntryComponents(content),
      schemas: this.extractSchemas(content)
    };
  }

  private extractAngularDirective(ast: any, content: string, filePath: string): AngularDirective | null {
    const directiveName = this.extractClassName(ast);
    if (!directiveName) return null;

    return {
      name: directiveName,
      filePath,
      selector: this.extractSelector(content),
      exportAs: this.extractExportAs(content),
      inputs: this.extractInputs(content),
      outputs: this.extractOutputs(content),
      host: this.extractHost(content),
      lifecycle: this.extractLifecycle(content)
    };
  }

  private extractAngularPipe(ast: any, content: string, filePath: string): AngularPipe | null {
    const pipeName = this.extractClassName(ast);
    if (!pipeName) return null;

    return {
      name: pipeName,
      filePath,
      pipeName: this.extractPipeName(content),
      pure: this.extractPipePure(content),
      transform: this.extractTransform(content)
    };
  }

  private extractAngularGuards(content: string, filePath: string): AngularGuard[] {
    const guards: AngularGuard[] = [];
    const seen = new Set<string>();

    const functionalPattern = /export\s+const\s+(\w+)\s*:\s*(CanActivateChildFn|CanActivateFn|CanDeactivateFn|CanMatchFn|CanLoadFn|ResolveFn)\b/g;
    let match: RegExpExecArray | null;
    while ((match = functionalPattern.exec(content)) !== null) {
      const name = match[1];
      if (seen.has(name)) continue;
      seen.add(name);
      guards.push({
        name,
        filePath,
        type: match[2].replace(/Fn$/, '') as AngularGuard['type'],
        functional: true,
        methods: [],
        dependencies: this.extractDependencies(content)
      });
    }

    const classPattern = /export\s+class\s+(\w+)[^{]*\bimplements\b([^{]+)\{/g;
    while ((match = classPattern.exec(content)) !== null) {
      const interfaces = match[2];
      const guardInterface = interfaces.match(/\b(CanActivateChild|CanActivate|CanDeactivate|CanMatch|CanLoad|Resolve)\b/);
      if (!guardInterface) continue;
      const name = match[1];
      if (seen.has(name)) continue;
      seen.add(name);
      guards.push({
        name,
        filePath,
        type: guardInterface[1] as AngularGuard['type'],
        functional: false,
        methods: this.extractGuardMethods(content),
        dependencies: this.extractDependencies(content)
      });
    }

    if (guards.length === 0 && this.extractGuardMethods(content).length > 0) {
      const guardName = this.extractGuardName(content, filePath);
      if (guardName) {
        guards.push({
          name: guardName,
          filePath,
          type: this.extractGuardType(content),
          functional: false,
          methods: this.extractGuardMethods(content),
          dependencies: this.extractDependencies(content)
        });
      }
    }

    return guards;
  }

  private extractRoutes(content: string, filePath: string): AngularRoute[] {
    const routes: AngularRoute[] = [];
    const routePattern = /{\s*path:\s*['"`]([^'"`]+)['"`][^}]*}/g;

    let match;
    while ((match = routePattern.exec(content)) !== null) {
      const path = match[1];
      routes.push({
        path,
        component: this.extractRouteComponent(content, path),
        loadChildren: this.extractLoadChildren(content, path),
        redirectTo: this.extractRedirectTo(content, path),
        canActivate: this.extractCanActivate(content, path),
        canDeactivate: this.extractCanDeactivate(content, path),
        resolve: this.extractResolve(content, path),
        data: this.extractRouteData(content, path)
      });
    }

    return routes;
  }

  private extractClassName(ast: any): string | null {
    let className: string | null = null;

    const walk = (node: any) => {
      if (!node || typeof node !== 'object') return;

      if (node.type === 'ClassDeclaration' && node.id && node.decorators) {
        className = node.id.name;
        return;
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
    return className;
  }

  private extractSelector(content: string): string {
    const selectorMatch = content.match(/selector:\s*['"`]([^'"`]+)['"`]/);
    return selectorMatch ? selectorMatch[1] : '';
  }

  private extractTemplateUrl(content: string): string | undefined {
    const templateUrlMatch = content.match(/templateUrl:\s*['"`]([^'"`]+)['"`]/);
    return templateUrlMatch ? templateUrlMatch[1] : undefined;
  }

  private extractStyleUrls(content: string): string[] {
    const styleUrlsMatch = content.match(/styleUrls:\s*\[([^\]]+)\]/);
    if (!styleUrlsMatch) return [];

    const urlsContent = styleUrlsMatch[1];
    const urls = urlsContent.match(/['"`]([^'"`]+)['"`]/g);
    return urls ? urls.map(url => url.slice(1, -1)) : [];
  }

  private extractInputs(content: string): Array<{ name: string; type: string; alias?: string }> {
    const inputs: Array<{ name: string; type: string; alias?: string }> = [];

    const decoratorPattern = /@Input\(\s*(?:['"`]([^'"`]+)['"`])?\s*\)\s*(?:set\s+)?(\w+)\s*(?:[?!]?\s*:\s*([^;=\n]+?))?(?:\s*[;=\n])/g;
    let match: RegExpExecArray | null;
    while ((match = decoratorPattern.exec(content)) !== null) {
      inputs.push({
        name: match[2],
        type: (match[3] || 'any').trim(),
        ...(match[1] ? { alias: match[1] } : {})
      });
    }

    const inputObjPattern = /@Input\(\s*\{[^}]*alias\s*:\s*['"`]([^'"`]+)['"`][^}]*\}\s*\)\s*(?:set\s+)?(\w+)\s*(?:[?!]?\s*:\s*([^;=\n]+?))?(?:\s*[;=\n])/g;
    while ((match = inputObjPattern.exec(content)) !== null) {
      const name = match[2];
      const existing = inputs.find(i => i.name === name);
      if (!existing) {
        inputs.push({
          name,
          type: (match[3] || 'any').trim(),
          alias: match[1]
        });
      }
    }

    const signalPattern = /(\w+)\s*=\s*input(?:<([^>]+)>)?\s*\(/g;
    while ((match = signalPattern.exec(content)) !== null) {
      const name = match[1];
      const existing = inputs.find(i => i.name === name);
      if (!existing) {
        inputs.push({
          name,
          type: (match[2] || 'any').trim()
        });
      }
    }

    const requiredSignalPattern = /(\w+)\s*=\s*input\.required(?:<([^>]+)>)?\s*\(/g;
    while ((match = requiredSignalPattern.exec(content)) !== null) {
      const name = match[1];
      const existing = inputs.find(i => i.name === name);
      if (!existing) {
        inputs.push({
          name,
          type: (match[2] || 'any').trim()
        });
      }
    }

    return inputs;
  }

  private extractOutputs(content: string): Array<{ name: string; type: string; alias?: string }> {
    const outputs: Array<{ name: string; type: string; alias?: string }> = [];

    const decoratorPattern = /@Output\(\s*(?:['"`]([^'"`]+)['"`])?\s*\)\s*(\w+)\s*(?:[?!]?\s*(?::\s*([^;=\n]+?))?\s*=\s*new\s+EventEmitter(?:<([^>]+)>)?\s*\()?/g;
    let match: RegExpExecArray | null;
    while ((match = decoratorPattern.exec(content)) !== null) {
      outputs.push({
        name: match[2],
        type: match[4] || match[3] || 'void',
        ...(match[1] ? { alias: match[1] } : {})
      });
    }

    const signalPattern = /(\w+)\s*=\s*output(?:<([^>]+)>)?\s*\(/g;
    while ((match = signalPattern.exec(content)) !== null) {
      const name = match[1];
      const existing = outputs.find(o => o.name === name);
      if (!existing) {
        outputs.push({
          name,
          type: (match[2] || 'void').trim()
        });
      }
    }

    return outputs;
  }

  private extractProviders(content: string): string[] {
    const providersMatch = content.match(/providers\s*:\s*\[([^\]]*)\]/s);
    if (!providersMatch) return [];

    const providersContent = providersMatch[1];
    const providers: string[] = [];

    const tokenPattern = /\b([A-Z]\w+)\b/g;
    let match: RegExpExecArray | null;
    while ((match = tokenPattern.exec(providersContent)) !== null) {
      const token = match[1];
      if (!['provide', 'useClass', 'useValue', 'useFactory', 'useExisting', 'deps', 'multi'].includes(token)) {
        providers.push(token);
      }
    }

    return [...new Set(providers)];
  }

  private extractViewChild(content: string): string[] {
    const selectors: string[] = [];

    const viewChildPattern = /@ViewChild(?:ren)?\(\s*(?:['"`]([^'"`]+)['"`]|(\w+))/g;
    let match: RegExpExecArray | null;
    while ((match = viewChildPattern.exec(content)) !== null) {
      selectors.push(match[1] || match[2]);
    }

    return selectors;
  }

  private extractContentChild(content: string): string[] {
    const selectors: string[] = [];

    const contentChildPattern = /@ContentChild(?:ren)?\(\s*(?:['"`]([^'"`]+)['"`]|(\w+))/g;
    let match: RegExpExecArray | null;
    while ((match = contentChildPattern.exec(content)) !== null) {
      selectors.push(match[1] || match[2]);
    }

    return selectors;
  }

  private extractLifecycle(content: string): string[] {
    const lifecycle: string[] = [];
    const lifecycleMethods = [
      'ngOnInit', 'ngOnDestroy', 'ngOnChanges', 'ngDoCheck',
      'ngAfterContentInit', 'ngAfterContentChecked',
      'ngAfterViewInit', 'ngAfterViewChecked'
    ];

    lifecycleMethods.forEach(method => {
      if (content.includes(method)) {
        lifecycle.push(method);
      }
    });

    return lifecycle;
  }

  private extractImports(content: string): string[] {
    const imports: string[] = [];
    const importPattern = /import\s+(?:\{[^}]*\}|\w+|\*\s+as\s+\w+)\s+from\s+['"]([^'"]+)['"]/g;

    let match;
    while ((match = importPattern.exec(content)) !== null) {
      imports.push(match[1]);
    }

    return imports;
  }

  private extractExports(content: string): string[] {
    const exports: string[] = [];
    const exportPattern = /export\s+(?:default\s+)?(?:const|function|class)?\s*(\w+)/g;

    let match;
    while ((match = exportPattern.exec(content)) !== null) {
      exports.push(match[1]);
    }

    return exports;
  }

  private extractProvidedIn(content: string): string {
    const providedInMatch = content.match(/providedIn:\s*['"`]([^'"`]+)['"`]/);
    return providedInMatch ? providedInMatch[1] : 'root';
  }

  private extractDependencies(content: string): string[] {
    const deps: string[] = [];

    const constructorMatch = content.match(/constructor\s*\(([^)]*)\)/s);
    if (!constructorMatch) return deps;

    const params = constructorMatch[1];

    const paramPattern = /(?:@Inject\(\s*(\w+)\s*\)\s*)?(?:(?:private|protected|public|readonly)\s+)*\w+\s*[?]?\s*:\s*(\w+)/g;
    let match: RegExpExecArray | null;
    while ((match = paramPattern.exec(params)) !== null) {
      const token = match[1] || match[2];
      if (token && !['string', 'number', 'boolean', 'any', 'void', 'undefined', 'null', 'object', 'never', 'unknown'].includes(token.toLowerCase())) {
        deps.push(token);
      }
    }

    return deps;
  }

  private extractMethods(content: string): Array<{ name: string; parameters: any[]; returnType?: string }> {
    const methods: Array<{ name: string; parameters: any[]; returnType?: string }> = [];

    const methodPattern = /(?:(?:private|protected|public)\s+)?(?:static\s+)?(?:async\s+)?(\w+)\s*\(([^)]*)\)\s*(?::\s*([^{]+?))?\s*\{/g;
    let match: RegExpExecArray | null;
    while ((match = methodPattern.exec(content)) !== null) {
      const name = match[1];
      if (name === 'constructor' || name === 'class' || name === 'if' || name === 'for' || name === 'while' || name === 'switch' || name === 'catch') continue;

      const params = match[2].trim();
      const parameters: Array<{ name: string; type: string }> = [];
      if (params) {
        const paramParts = params.split(',');
        for (const part of paramParts) {
          const paramMatch = part.trim().match(/(?:(?:private|protected|public|readonly)\s+)*(\w+)\s*[?]?\s*(?::\s*(.+))?/);
          if (paramMatch) {
            parameters.push({
              name: paramMatch[1],
              type: (paramMatch[2] || 'any').trim()
            });
          }
        }
      }

      const returnType = match[3] ? match[3].trim() : undefined;

      methods.push({ name, parameters, returnType });
    }

    return methods;
  }

  private extractProperties(content: string): Array<{ name: string; type: string; access: string }> {
    const properties: Array<{ name: string; type: string; access: string }> = [];

    const propertyPattern = /(?:@\w+\([^)]*\)\s*)*\b(private|protected|public)\s+(?:(?:static|readonly|override)\s+)*(\w+)\s*[?!]?\s*(?::\s*([^;=\n]+?))?(?:\s*[;=])/g;
    let match: RegExpExecArray | null;
    while ((match = propertyPattern.exec(content)) !== null) {
      const name = match[2];
      if (name === 'constructor') continue;
      properties.push({
        name,
        type: (match[3] || 'any').trim(),
        access: match[1]
      });
    }

    const implicitPublicPattern = /^\s+(?:readonly\s+)?(\w+)\s*[?!]?\s*:\s*([^;=\n]+?)\s*[;=]/gm;
    while ((match = implicitPublicPattern.exec(content)) !== null) {
      const name = match[1];
      if (['private', 'protected', 'public', 'static', 'readonly', 'constructor', 'return', 'const', 'let', 'var', 'class', 'import', 'export', 'if', 'for', 'while'].includes(name)) continue;
      const alreadyFound = properties.find(p => p.name === name);
      if (!alreadyFound) {
        properties.push({
          name,
          type: (match[2] || 'any').trim(),
          access: 'public'
        });
      }
    }

    return properties;
  }

  private extractNgModuleArrayProperty(content: string, property: string): string[] {
    const pattern = new RegExp(`${property}\\s*:\\s*\\[([^\\]]*)]`, 's');
    const match = content.match(pattern);
    if (!match) return [];

    const items: string[] = [];
    const identifierPattern = /\b([A-Z]\w+)\b/g;
    let identifierMatch;
    while ((identifierMatch = identifierPattern.exec(match[1])) !== null) {
      items.push(identifierMatch[1]);
    }

    return items;
  }

  private extractDeclarations(content: string): string[] {
    return this.extractNgModuleArrayProperty(content, 'declarations');
  }

  private extractModuleImports(content: string): string[] {
    const ngModuleMatch = content.match(/@NgModule\s*\(\s*\{([\s\S]*?)\}\s*\)/);
    if (!ngModuleMatch) return [];

    const metadataBlock = ngModuleMatch[1];
    const importsMatch = metadataBlock.match(/imports\s*:\s*\[([^\]]*)\]/s);
    if (!importsMatch) return [];

    const items: string[] = [];
    const identifierPattern = /\b([A-Z]\w+)\b/g;
    let match: RegExpExecArray | null;
    while ((match = identifierPattern.exec(importsMatch[1])) !== null) {
      items.push(match[1]);
    }

    return items;
  }

  private extractModuleExports(content: string): string[] {
    const ngModuleMatch = content.match(/@NgModule\s*\(\s*\{([\s\S]*?)\}\s*\)/);
    if (!ngModuleMatch) return [];

    const metadataBlock = ngModuleMatch[1];
    const exportsMatch = metadataBlock.match(/exports\s*:\s*\[([^\]]*)\]/s);
    if (!exportsMatch) return [];

    const items: string[] = [];
    const identifierPattern = /\b([A-Z]\w+)\b/g;
    let match: RegExpExecArray | null;
    while ((match = identifierPattern.exec(exportsMatch[1])) !== null) {
      items.push(match[1]);
    }

    return items;
  }

  private extractBootstrap(content: string): string[] {
    return this.extractNgModuleArrayProperty(content, 'bootstrap');
  }

  private extractEntryComponents(content: string): string[] {
    return this.extractNgModuleArrayProperty(content, 'entryComponents');
  }

  private extractSchemas(content: string): string[] {
    return this.extractNgModuleArrayProperty(content, 'schemas');
  }

  private extractExportAs(content: string): string | undefined {
    const exportAsMatch = content.match(/exportAs:\s*['"`]([^'"`]+)['"`]/);
    return exportAsMatch ? exportAsMatch[1] : undefined;
  }

  private extractHost(content: string): Record<string, string> {
    const hostMatch = content.match(/host\s*:\s*\{([^}]*)\}/s);
    if (!hostMatch) return {};

    const host: Record<string, string> = {};
    const entryPattern = /['"`]([^'"`]+)['"`]\s*:\s*['"`]([^'"`]+)['"`]/g;
    let match: RegExpExecArray | null;
    while ((match = entryPattern.exec(hostMatch[1])) !== null) {
      host[match[1]] = match[2];
    }

    return host;
  }

  private extractPipeName(content: string): string {
    const pipeNameMatch = content.match(/name:\s*['"`]([^'"`]+)['"`]/);
    return pipeNameMatch ? pipeNameMatch[1] : '';
  }

  private extractPipePure(content: string): boolean {
    const pureMatch = content.match(/pure:\s*(true|false)/);
    return pureMatch ? pureMatch[1] === 'true' : true;
  }

  private extractTransform(content: string): { parameters: any[]; returnType?: string } {
    const transformMatch = content.match(/transform\s*\(([^)]*)\)\s*(?::\s*([^{]+?))?\s*\{/);
    if (!transformMatch) return { parameters: [] };

    const params = transformMatch[1].trim();
    const parameters: Array<{ name: string; type: string }> = [];

    if (params) {
      const paramParts = params.split(',');
      for (const part of paramParts) {
        const paramMatch = part.trim().match(/(\w+)\s*[?]?\s*(?::\s*(.+))?/);
        if (paramMatch) {
          parameters.push({
            name: paramMatch[1],
            type: (paramMatch[2] || 'any').trim()
          });
        }
      }
    }

    const returnType = transformMatch[2] ? transformMatch[2].trim() : undefined;

    return { parameters, returnType };
  }

  private extractGuardName(content: string, filePath: string): string | null {
    const classMatch = content.match(/export\s+class\s+(\w+)/);
    return classMatch ? classMatch[1] : path.basename(filePath, path.extname(filePath));
  }

  private extractGuardType(content: string): 'CanActivate' | 'CanDeactivate' | 'CanLoad' | 'Resolve' {
    if (content.includes('CanActivate')) return 'CanActivate';
    if (content.includes('CanDeactivate')) return 'CanDeactivate';
    if (content.includes('CanLoad')) return 'CanLoad';
    if (content.includes('Resolve')) return 'Resolve';
    return 'CanActivate';
  }

  private extractGuardMethods(content: string): string[] {
    const guardMethodNames = ['canActivate', 'canDeactivate', 'canLoad', 'canMatch', 'resolve'];
    const found: string[] = [];

    for (const methodName of guardMethodNames) {
      const pattern = new RegExp(`\\b${methodName}\\s*\\(`);
      if (pattern.test(content)) {
        found.push(methodName);
      }
    }

    return found;
  }

  private extractRouteBlock(content: string, routePath: string): string | null {
    const escapedPath = routePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\{[^{}]*path\\s*:\\s*['"\`]${escapedPath}['"\`][^}]*\\}`, 's');
    const match = content.match(pattern);
    return match ? match[0] : null;
  }

  private extractRouteComponent(content: string, path: string): string | undefined {
    const block = this.extractRouteBlock(content, path);
    if (!block) return undefined;

    const componentMatch = block.match(/component\s*:\s*(\w+)/);
    return componentMatch ? componentMatch[1] : undefined;
  }

  private extractLoadChildren(content: string, path: string): string | undefined {
    const block = this.extractRouteBlock(content, path);
    if (!block) return undefined;

    const stringMatch = block.match(/loadChildren\s*:\s*['"`]([^'"`]+)['"`]/);
    if (stringMatch) return stringMatch[1];

    const arrowMatch = block.match(/loadChildren\s*:\s*\(\)\s*=>\s*import\(\s*['"`]([^'"`]+)['"`]\s*\)/);
    if (arrowMatch) return arrowMatch[1];

    const generalArrowMatch = block.match(/loadChildren\s*:\s*\(\)\s*=>\s*(.+?)(?:,|\})/s);
    if (generalArrowMatch) return generalArrowMatch[1].trim();

    return undefined;
  }

  private extractRedirectTo(content: string, path: string): string | undefined {
    const block = this.extractRouteBlock(content, path);
    if (!block) return undefined;

    const redirectMatch = block.match(/redirectTo\s*:\s*['"`]([^'"`]+)['"`]/);
    return redirectMatch ? redirectMatch[1] : undefined;
  }

  private extractCanActivate(content: string, path: string): string[] | undefined {
    const block = this.extractRouteBlock(content, path);
    if (!block) return undefined;

    const guardMatch = block.match(/canActivate\s*:\s*\[([^\]]*)\]/);
    if (!guardMatch) return undefined;

    const guards: string[] = [];
    const identifierPattern = /\b([A-Z]\w+)\b/g;
    let match: RegExpExecArray | null;
    while ((match = identifierPattern.exec(guardMatch[1])) !== null) {
      guards.push(match[1]);
    }

    return guards.length > 0 ? guards : undefined;
  }

  private extractCanDeactivate(content: string, path: string): string[] | undefined {
    const block = this.extractRouteBlock(content, path);
    if (!block) return undefined;

    const deactivateMatch = block.match(/canDeactivate\s*:\s*\[([^\]]*)\]/);
    if (!deactivateMatch) return undefined;

    const guards: string[] = [];
    const identifierPattern = /\b([A-Z]\w+)\b/g;
    let match: RegExpExecArray | null;
    while ((match = identifierPattern.exec(deactivateMatch[1])) !== null) {
      guards.push(match[1]);
    }

    return guards.length > 0 ? guards : undefined;
  }

  private extractResolve(content: string, path: string): Record<string, string> | undefined {
    const block = this.extractRouteBlock(content, path);
    if (!block) return undefined;

    const resolveMatch = block.match(/resolve\s*:\s*\{([^}]*)\}/);
    if (!resolveMatch) return undefined;

    const resolvers: Record<string, string> = {};
    const entryPattern = /(\w+)\s*:\s*(\w+)/g;
    let match: RegExpExecArray | null;
    while ((match = entryPattern.exec(resolveMatch[1])) !== null) {
      resolvers[match[1]] = match[2];
    }

    return Object.keys(resolvers).length > 0 ? resolvers : undefined;
  }

  private extractRouteData(content: string, path: string): Record<string, any> | undefined {
    const block = this.extractRouteBlock(content, path);
    if (!block) return undefined;

    const dataMatch = block.match(/data\s*:\s*\{([^}]*)\}/);
    if (!dataMatch) return undefined;

    const data: Record<string, any> = {};
    const stringEntryPattern = /(\w+)\s*:\s*['"`]([^'"`]+)['"`]/g;
    let match: RegExpExecArray | null;
    while ((match = stringEntryPattern.exec(dataMatch[1])) !== null) {
      data[match[1]] = match[2];
    }

    const boolEntryPattern = /(\w+)\s*:\s*(true|false)/g;
    while ((match = boolEntryPattern.exec(dataMatch[1])) !== null) {
      data[match[1]] = match[2] === 'true';
    }

    const numEntryPattern = /(\w+)\s*:\s*(\d+(?:\.\d+)?)\b/g;
    while ((match = numEntryPattern.exec(dataMatch[1])) !== null) {
      if (!(match[1] in data)) {
        data[match[1]] = parseFloat(match[2]);
      }
    }

    return Object.keys(data).length > 0 ? data : undefined;
  }

  private async detectAngularVersion(projectPath: string): Promise<string> {
    try {
      const packageJson = await fs.readJson(path.join(projectPath, 'package.json'));
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      return deps['@angular/core'] || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private buildAngularRelationships(
    components: AngularComponent[],
    services: AngularService[],
    modules: AngularModule[],
    directives: AngularDirective[],
    pipes: AngularPipe[],
    guards: AngularGuard[],
    routes: AngularRoute[],
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    modules.forEach(module => {
      const moduleId = this.generateId('module', module.filePath, module.name);

      module.declarations.forEach(declaration => {
        const declarationId = this.generateId('component', '', declaration);
        edges.push(this.createEdge(
          this.generateEdgeId(moduleId, declarationId, 'declares'),
          moduleId,
          declarationId,
          'declares',
          'structural',
          { declaration }
        ));
      });

      module.providers.forEach(provider => {
        const providerId = this.generateId('service', '', provider);
        edges.push(this.createEdge(
          this.generateEdgeId(moduleId, providerId, 'provides'),
          moduleId,
          providerId,
          'provides',
          'dependency',
          { provider }
        ));
      });
    });

  }

  private identifyAPIConnections(services: AngularService[], components: AngularComponent[], exitPoints: CASExitPoint[]): void {
    const hasAPIConnection = services.some(s =>
      s.dependencies.some(dep => dep.includes('Http') || dep.includes('http'))
    ) || components.some(c =>
      c.imports.some(imp => imp.includes('@angular/common/http'))
    );

    if (hasAPIConnection) {
      exitPoints.push(this.createExitPoint(
        'exit_angular_api',
        'angular_app',
        'api',
        'HTTP API Connection',
        'External API connections from Angular services',
        {
          service_id: 'external-api',
          endpoint: 'various'
        },
        {
          action: 'read-write',
          async: true
        },
        {
          type: 'REST/GraphQL API',
          services: services.filter(s =>
            s.dependencies.some(dep => dep.includes('Http'))
          ).map(s => s.name)
        }
      ));
    }
  }

  private createPerspectives(perspectives: CASPerspective[]): void {
    perspectives.push({
      id: 'angular-components',
      name: 'Angular Component Tree',
      description: 'Component hierarchy showing parent-child relationships and component structure',
      analyzer_id: this.analyzerId,
      type: 'structure',
      connection_rules: {
        visible_node_types: ['angular_app', 'angular_module', 'angular_component'],
        relevant_edge_types: ['contains', 'declares', 'imports'],
        node_connections: [
          {
            from_type: 'angular_app',
            to_types: ['angular_module'],
            edge_type: 'contains'
          },
          {
            from_type: 'angular_module',
            to_types: ['angular_component'],
            edge_type: 'declares'
          }
        ]
      },
      layout_hints: {
        style: 'hierarchical',
        direction: 'TB',
        group_by: 'module'
      },
      metadata: {
        show_selectors: true,
        show_inputs_outputs: true
      }
    });

    perspectives.push({
      id: 'angular-modules',
      name: 'Angular Module Dependencies',
      description: 'Module dependency graph showing imports, exports, and providers',
      analyzer_id: this.analyzerId,
      type: 'structure',
      connection_rules: {
        visible_node_types: ['angular_module', 'angular_service'],
        relevant_edge_types: ['imports', 'exports', 'provides'],
        node_connections: [
          {
            from_type: 'angular_module',
            to_types: ['angular_module'],
            edge_type: 'imports'
          },
          {
            from_type: 'angular_module',
            to_types: ['angular_service'],
            edge_type: 'provides'
          }
        ]
      },
      layout_hints: {
        style: 'force',
        group_by: 'module_type'
      },
      metadata: {
        show_lazy_modules: true,
        highlight_circular: true
      }
    });

    perspectives.push({
      id: 'angular-services',
      name: 'Angular Service Injection Hierarchy',
      description: 'Service dependencies and injection patterns throughout the application',
      analyzer_id: this.analyzerId,
      type: 'flow',
      connection_rules: {
        visible_node_types: ['angular_service', 'angular_component'],
        relevant_edge_types: ['injects', 'provides'],
        node_connections: [
          {
            from_type: 'angular_component',
            to_types: ['angular_service'],
            edge_type: 'injects'
          },
          {
            from_type: 'angular_service',
            to_types: ['angular_service'],
            edge_type: 'injects'
          }
        ]
      },
      layout_hints: {
        style: 'hierarchical',
        direction: 'BT'
      },
      metadata: {
        show_injection_scope: true,
        highlight_singletons: true
      }
    });
  }

  private tagNodesWithPerspectives(nodes: CASNode[], edges: CASEdge[]): void {
    nodes.forEach(node => {
      if (!node || typeof node !== 'object') return;

      if (!node.perspectives) {
        node.perspectives = {};
      }

      if (node.type === 'angular_app' || node.type === 'angular_module' ||
          node.type === 'angular_component') {
        node.perspectives['angular-components'] = {
          hierarchy: ['angular', 'components'],
          level: node.level || 1,
          priority: 1
        };
      }

      if (node.type === 'angular_module' || node.type === 'angular_service') {
        node.perspectives['angular-modules'] = {
          hierarchy: ['angular', 'modules'],
          level: node.level || 1,
          priority: 2
        };
      }

      if (node.type === 'angular_service' || node.type === 'angular_component') {
        node.perspectives['angular-services'] = {
          hierarchy: ['angular', 'services'],
          level: node.level || 1,
          priority: 3
        };
      }

      if (!node.metadata) {
        node.metadata = {};
      }
      node.metadata.perspective_data = {
        'angular-components': {
          component_type: node.type,
          selector: node.metadata?.attributes?.selector,
          standalone: node.metadata?.attributes?.standalone || false
        },
        'angular-modules': {
          module_type: node.type === 'angular_module' ? 'feature' : 'provider',
          provides_count: node.metadata?.attributes?.providers?.length || 0
        },
        'angular-services': {
          injection_scope: node.metadata?.attributes?.providedIn || 'root',
          injectable: node.metadata?.attributes?.injectable || false
        }
      };
    });

    edges.forEach(edge => {
      edge.perspectives = [];

      if (edge.type === 'contains' || edge.type === 'declares' || edge.type === 'imports') {
        edge.perspectives.push('angular-components');
      }

      if (edge.type === 'imports' || edge.type === 'exports' || edge.type === 'provides') {
        edge.perspectives.push('angular-modules');
      }

      if (edge.type === 'injects' || edge.type === 'provides') {
        edge.perspectives.push('angular-services');
      }

      if (!edge.metadata) {
        edge.metadata = {};
      }
      edge.metadata.perspective_data = {
        'angular-components': {
          relationship_type: edge.type,
          is_declaration: edge.type === 'declares'
        },
        'angular-modules': {
          dependency_type: edge.type,
          is_lazy: edge.metadata?.attributes?.lazy || false
        },
        'angular-services': {
          injection_type: edge.type,
          scope: 'component'
        }
      };
    });
  }

  private extractCommentsFromFile(content: string, filePath: string): CASComment[] {
    const comments: CASComment[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      const singleLineMatch = line.match(/\/\/(.*)$/);
      if (singleLineMatch) {
        const text = singleLineMatch[1].trim();
        const purpose = this.classifyCommentPurpose(text);
        comments.push({
          id: `comment_${++this.commentCounter}`,
          type: 'single-line',
          style: '//',
          text,
          purpose,
          location: {
            file: filePath,
            line: i + 1,
            relative_to: 'inline'
          },
          markers: this.extractCommentMarkers(text)
        });
      }

      if (line.includes('/*')) {
        let multiLineText = '';
        let endLine = i;
        let foundEnd = false;

        for (let j = i; j < lines.length; j++) {
          const currentLine = lines[j];
          if (j === i) {
            const startMatch = currentLine.match(/\/\*(.*)/);
            if (startMatch) {
              multiLineText = startMatch[1];
              if (currentLine.includes('*/')) {
                multiLineText = multiLineText.replace(/\*\/.*$/, '').trim();
                foundEnd = true;
                endLine = j;
              }
            }
          } else {
            if (currentLine.includes('*/')) {
              multiLineText += '\n' + currentLine.replace(/\*\/.*$/, '').replace(/^\s*\*/, '').trim();
              foundEnd = true;
              endLine = j;
              break;
            } else {
              multiLineText += '\n' + currentLine.replace(/^\s*\*/, '').trim();
            }
          }
        }

        if (foundEnd) {
          const purpose = this.classifyCommentPurpose(multiLineText);
          comments.push({
            id: `comment_${++this.commentCounter}`,
            type: 'multi-line',
            style: '/* */',
            text: multiLineText.trim(),
            purpose,
            location: {
              file: filePath,
              line: i + 1,
              end_line: endLine + 1,
              relative_to: 'above'
            },
            markers: this.extractCommentMarkers(multiLineText)
          });
          i = endLine;
        }
      }
    }

    return comments;
  }

  private classifyCommentPurpose(text: string): CASComment['purpose'] {
    const lowerText = text.toLowerCase();

    if (/\b(todo|fixme|hack|warning|note|xxx|optimize|refactor)\b/.test(lowerText)) {
      return 'todo';
    }
    if (/\b(warning|warn|caution|danger|important)\b/.test(lowerText)) {
      return 'warning';
    }
    if (/\b(note|info|tip|hint)\b/.test(lowerText)) {
      return 'note';
    }
    if (/\b(hack|temp|temporary|quick|dirty)\b/.test(lowerText)) {
      return 'hack';
    }

    return 'explanation';
  }

  private extractCommentMarkers(text: string): CASComment['markers'] {
    const markers: CASComment['markers'] = {};
    const lowerText = text.toLowerCase();

    markers.is_todo = /\btodo\b/.test(lowerText);
    markers.is_fixme = /\bfixme\b/.test(lowerText);
    markers.is_hack = /\bhack\b/.test(lowerText);
    markers.is_warning = /\b(warning|warn)\b/.test(lowerText);
    markers.is_note = /\b(note|info)\b/.test(lowerText);
    markers.is_important = /\b(important|critical|urgent)\b/.test(lowerText);
    markers.is_deprecated = /\b(deprecated|obsolete)\b/.test(lowerText);

    return markers;
  }

  private extractTodosFromComments(comments: CASComment[], context: string): CASTodo[] {
    const todos: CASTodo[] = [];

    comments.forEach(comment => {
      if (comment.markers?.is_todo || comment.markers?.is_fixme || comment.markers?.is_hack) {
        const typeMatch = comment.text.match(/\b(TODO|FIXME|HACK|NOTE|WARNING|XXX|OPTIMIZE|REFACTOR)\b/i);
        const type = typeMatch ? typeMatch[0].toUpperCase() as CASTodo['type'] : 'TODO';

        const assigneeMatch = comment.text.match(/\b(?:TODO|FIXME|HACK)\s*\(([^)]+)\)/);
        const assignee = assigneeMatch ? assigneeMatch[1] : undefined;

        const priority = comment.markers?.is_important ? 'high' :
                        comment.markers?.is_fixme ? 'medium' : 'low';

        const category = this.categorizeTodo(comment.text);

        todos.push({
          id: `todo_${++this.todoCounter}`,
          type,
          text: comment.text,
          priority,
          assignee,
          category,
          location: {
            file: comment.location.file,
            line: comment.location.line,
            context
          },
          metadata: {
            source: 'comment',
            comment_type: comment.type
          }
        });
      }
    });

    return todos;
  }

  private categorizeTodo(text: string): CASTodo['category'] {
    const lowerText = text.toLowerCase();

    if (/\b(fix|bug|error|issue|broken)\b/.test(lowerText)) return 'bug';
    if (/\b(feature|add|implement|new)\b/.test(lowerText)) return 'feature';
    if (/\b(refactor|clean|improve|restructure)\b/.test(lowerText)) return 'refactor';
    if (/\b(performance|optimize|speed|slow)\b/.test(lowerText)) return 'performance';
    if (/\b(security|secure|auth|permission)\b/.test(lowerText)) return 'security';

    return 'general';
  }

  private extractDocumentationFromJSDoc(content: string, startLine: number): CASDocumentation | undefined {
    const lines = content.split('\n');
    let documentation = '';
    let hasDoc = false;

    for (let i = startLine - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith('/**') || line.includes('/**')) {
        let docText = line.replace(/\/\*\*/, '').replace(/\*\/.*/, '').replace(/^\s*\*/, '').trim();
        if (docText) {
          documentation = docText + (documentation ? '\n' + documentation : '');
          hasDoc = true;
        }

        if (line.includes('*/')) break;

        for (let j = i + 1; j < lines.length; j++) {
          const docLine = lines[j].trim();
          if (docLine.includes('*/')) {
            const finalDoc = docLine.replace(/\*\/.*/, '').replace(/^\s*\*/, '').trim();
            if (finalDoc) {
              documentation = documentation + '\n' + finalDoc;
            }
            break;
          } else if (docLine.startsWith('*')) {
            const lineDoc = docLine.replace(/^\s*\*/, '').trim();
            if (lineDoc) {
              documentation = documentation + '\n' + lineDoc;
              hasDoc = true;
            }
          }
        }
        break;
      } else if (!line.startsWith('//') && line !== '') {
        break;
      }
    }

    if (hasDoc) {
      const docs: CASDocumentation = {
        type: 'jsdoc',
        raw: documentation,
        location: { start_line: startLine - documentation.split('\n').length, end_line: startLine }
      };

      docs.summary = documentation.split('.')[0] + (documentation.includes('.') ? '.' : '');
      docs.description = documentation;

      const paramMatches = documentation.match(/@param\s+\{([^}]+)\}\s+(\w+)\s+(.*)/g);
      if (paramMatches) {
        docs.parameters = paramMatches.map(match => {
          const parts = match.match(/@param\s+\{([^}]+)\}\s+(\w+)\s+(.*)/);
          return {
            name: parts?.[2] || '',
            type: parts?.[1] || '',
            description: parts?.[3] || ''
          };
        });
      }

      const returnMatch = documentation.match(/@returns?\s+\{([^}]+)\}\s+(.*)/);
      if (returnMatch) {
        docs.return_info = {
          type: returnMatch[1],
          description: returnMatch[2]
        };
      }

      const exampleMatch = documentation.match(/@example\s*(.*?)(?=@|$)/s);
      if (exampleMatch) {
        docs.examples = [{ code: exampleMatch[1].trim(), language: 'typescript' }];
      }

      return docs;
    }

    return undefined;
  }

  private detectImplementationStatus(component: any, content: string): CASImplementationStatus {
    const lowerContent = content.toLowerCase();

    const indicators = {
      has_todo_markers: lowerContent.includes('todo') || lowerContent.includes('fixme'),
      has_not_implemented_exceptions: lowerContent.includes('notimplementederror') || lowerContent.includes('throw new error'),
      has_stub_returns: lowerContent.includes('return null') || lowerContent.includes('return undefined'),
      has_placeholder_code: lowerContent.includes('placeholder') || lowerContent.includes('// TODO'),
      has_hardcoded_values: lowerContent.includes("'localhost'") || lowerContent.includes('"localhost"'),
      has_commented_out_code: lowerContent.includes('//') && lowerContent.includes('function'),
      has_placeholder_template: lowerContent.includes('<p>') && lowerContent.includes('works!'),
      has_empty_methods: lowerContent.includes('{}') || lowerContent.includes('{ }'),
      has_console_logs: lowerContent.includes('console.log'),
      has_mock_data: lowerContent.includes('mock') || lowerContent.includes('dummy'),
      has_deprecated_markers: lowerContent.includes('@deprecated')
    };

    let status: CASImplementationStatus['status'] = 'complete';
    if (indicators.has_deprecated_markers) {
      status = 'deprecated';
    } else if (indicators.has_placeholder_template || indicators.has_empty_methods) {
      status = 'stub';
    } else if (indicators.has_todo_markers || indicators.has_mock_data || indicators.has_console_logs) {
      status = 'partial';
    }

    return {
      status,
      indicators,
      completeness: status === 'complete' ? { estimated_percentage: 100 } :
                   status === 'partial' ? { estimated_percentage: 60 } :
                   status === 'stub' ? { estimated_percentage: 10 } :
                   { estimated_percentage: 0 }
    };
  }
}
