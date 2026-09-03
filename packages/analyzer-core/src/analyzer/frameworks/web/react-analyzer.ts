import { ReactBindingResolver, ReactComponentAnalysis, type ReactComponent } from './react-component-analysis';
import { isReactApplicableSource, ReactSourceAnalysis } from './react-source-analysis';
import { BaseAnalyzer, AnalysisContext, FileAnalysisContext, FileAnalysisResult } from '../../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, CASPerspective, CASDocumentation, CASComment, CASTodo, CASImplementationStatus } from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';
import { cachedEstreeParse as parse } from '../../core/estree-parse-cache';

interface ReactApplication {
  name: string;
  entryPoint: string;
  type: 'cra' | 'next' | 'vite' | 'custom';
  typescript: boolean;
  router: string | null;
  stateManagement: string[];
  testing: string[];
  buildTool: string;
}

interface ReactHook {
  name: string;
  filePath: string;
  type: 'custom' | 'built-in';
  parameters: Array<{ name: string; type: string; defaultValue?: string }>;
  returnType: string;
  dependencies: string[];
  effectDependencies: string[];
}

interface ReactContext {
  name: string;
  filePath: string;
  defaultValue: any;
  provider: string;
  consumer: string;
  properties: Array<{ name: string; type: string }>;
}

interface ReactRoute {
  path: string;
  component: string;
  nodeId?: string;
  exact?: boolean;
  guards?: string[];
  children?: ReactRoute[];
  lazy?: boolean;
  index?: boolean;
  filePath?: string;
  componentModule?: string;
}

interface ReactStore {
  name: string;
  filePath: string;
  type: 'redux' | 'zustand' | 'recoil' | 'context' | 'custom';
  actions: Array<{ name: string; type: string; payload?: string }>;
  reducers: Array<{ name: string; cases: string[] }>;
  selectors: Array<{ name: string; returnType: string }>;
  initialState: Record<string, any>;
}

interface ReactPage {
  name: string;
  filePath: string;
  route: string;
  component: string;
  layout?: string;
  guards?: string[];
  meta?: Record<string, any>;
}

interface ReactUtil {
  name: string;
  filePath: string;
  type: 'function' | 'class' | 'constant';
  exports: string[];
  dependencies: string[];
}

export class ReactAnalyzer extends BaseAnalyzer {
  private readonly componentAnalysis = new ReactComponentAnalysis((node, content, name) => this.looksLikeComponent(node, content, name));
  private readonly bindingResolver = new ReactBindingResolver(component => this.generateId('component', component.filePath, component.name));
  private fileRouterCache = new Map<string, boolean>();

  constructor() {
    super(
      'react',
      'React Framework Analyzer',
      '1.0.0',
      'framework'
    );
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const packageJsonPath = path.join(projectPath, 'package.json');
      if (!await fs.pathExists(packageJsonPath)) return false;

      const packageJson = await this.readSourceJson<any>(packageJsonPath);
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };

      if (Object.keys(deps).some(dep => dep === 'react' || dep === 'react-dom')) {
        return true;
      }

      const tsFiles = await glob(['**/*.{ts,tsx,js,jsx}'], {
        cwd: projectPath,
        ignore: [...this.getIgnorePatterns({ projectPath }), '**/src/analyzer/**', '**/analyzer/**', '**/analyzers/**'],
        nodir: true
      });

      for (const file of tsFiles) {
        const content = await this.readTextFileIfExists(path.join(projectPath, file));
        if (content === null) continue;
        if (content.includes('from react') || content.includes('import React') || content.includes('React.')) {
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

  private async readTextFileIfExists(filePath: string): Promise<string | null> {
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    const files = await glob(['**/*.{ts,tsx,js,jsx,cts,mts}'], { cwd: projectPath, ignore: [...this.getIgnorePatterns({ projectPath }), '**/*.test.*', '**/*.spec.*'], nodir: true });
    const applicable = await Promise.all(files.map(async file => {
      const content = await this.readTextFileIfExists(path.join(projectPath, file));
      return content !== null && isReactApplicableSource(file, content) ? file : undefined;
    }));
    return this.capAndPrioritizeSourceFiles(applicable.filter((file): file is string => Boolean(file)).sort(), 'React source files');
  }

  async getClaimedFiles(projectPath: string, context?: AnalysisContext): Promise<string[]> {
    return this.reactSourceFiles(context || { projectPath });
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const file = context.relativePath;
    const content = await this.readTextFileIfExists(context.filePath);
    if (content === null) {
      return this.createFileAnalysisResult(
        context.filePath,
        file,
        context.contentHash || this.computeContentHash(''),
        Date.now(),
        nodes,
        edges,
        entryPoints,
        exitPoints,
        [],
        []
      );
    }
    const stat = await fs.stat(context.filePath);

    const localNodes: CASNode[][] = [[], [], [], [], [], [], []];
    const localEdges: CASEdge[][] = [[], [], [], [], [], [], []];
    const localEntryPoints: CASEntryPoint[][] = [[], []];
    const sources = ReactSourceAnalysis.fromContent(
      file, context.filePath, content, (sourceFile, sourceContent) => this.parseReactSource(sourceFile, sourceContent));

    const [components, hooks, contexts, routes, stores, pages, utils] = await Promise.all([
      this.analyzeComponents(sources, localNodes[0], localEdges[0]),
      this.analyzeHooks(sources, localNodes[1], localEdges[1]),
      this.analyzeContexts(sources, localNodes[2], localEdges[2]),
      this.analyzeRoutes(sources, localNodes[3], localEdges[3], localEntryPoints[0]),
      this.analyzeStores(sources, localNodes[4], localEdges[4]),
      this.analyzePages(sources, localNodes[5], localEdges[5]),
      this.analyzeUtils(sources, localNodes[6], localEdges[6])
    ]);

    this.createPageEntryPoints(pages, routes, localEntryPoints[1], await this.isFileRouterProject(context.projectPath));

    for (const n of localNodes) nodes.push(...n);
    for (const e of localEdges) edges.push(...e);
    for (const ep of localEntryPoints) entryPoints.push(...ep);

    const existingFacts = this.extractExistingReactFacts(context, file);
    this.buildReactRelationships(
      [...components, ...existingFacts.components],
      [...hooks, ...existingFacts.hooks],
      [...contexts, ...existingFacts.contexts],
      routes,
      [...stores, ...existingFacts.stores],
      pages,
      [...utils, ...existingFacts.utils],
      nodes,
      edges,
      entryPoints,
      [...(context.existingAnalysis || []).flatMap(contribution => contribution.nodes || []), ...nodes]
    );
    this.computeComponentMetrics([...components, ...existingFacts.components], nodes, edges);
    this.identifyAPIConnections(components, hooks, nodes, exitPoints);
    this.tagNodesWithPerspectives(nodes, edges);

    return this.createFileAnalysisResult(
      context.filePath,
      file,
      context.contentHash || this.computeContentHash(content),
      stat.mtimeMs,
      nodes,
      edges,
      entryPoints,
      exitPoints,
      this.extractImports(content),
      this.extractExports(content)
    );
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const perspectives: CASPerspective[] = [];
    const timings: Record<string, number> = {};
    let t = Date.now();

    try {
      const reactFiles = await this.reactSourceFiles(context);
      timings['glob'] = Date.now() - t;

      t = Date.now();
      const application = await this.analyzeApplication(context.projectPath, nodes);
      timings['application'] = Date.now() - t;

      t = Date.now();
      const localNodes: CASNode[][] = [[], [], [], [], [], [], []];
      const localEdges: CASEdge[][] = [[], [], [], [], [], [], []];
      const localEntryPoints: CASEntryPoint[][] = [[], []];
      const sources = await this.createSourceAnalysis(reactFiles, context.projectPath);

      const [components, hooks, contexts, routes, stores, pages, utils] = await Promise.all([
        this.analyzeComponents(sources, localNodes[0], localEdges[0]),
        this.analyzeHooks(sources, localNodes[1], localEdges[1]),
        this.analyzeContexts(sources, localNodes[2], localEdges[2]),
        this.analyzeRoutes(sources, localNodes[3], localEdges[3], localEntryPoints[0]),
        this.analyzeStores(sources, localNodes[4], localEdges[4]),
        this.analyzePages(sources, localNodes[5], localEdges[5]),
        this.analyzeUtils(sources, localNodes[6], localEdges[6])
      ]);

      this.createPageEntryPoints(pages, routes, localEntryPoints[1], application?.type === 'next');

      for (const n of localNodes) nodes.push(...n);
      for (const e of localEdges) edges.push(...e);
      for (const ep of localEntryPoints) entryPoints.push(...ep);
      timings['parallelAnalysis'] = Date.now() - t;

      t = Date.now();
      this.buildReactRelationships(
        components, hooks, contexts, routes, stores, pages, utils, nodes, edges, entryPoints,
        [...(context.existingAnalysis || []).flatMap(contribution => contribution.nodes || []), ...nodes]
      );
      this.computeComponentMetrics(components, nodes, edges);
      this.identifyAPIConnections(components, hooks, nodes, exitPoints);
      timings['relationships'] = Date.now() - t;


      this.tagNodesWithPerspectives(nodes, edges);
      this.createPerspectives(perspectives);

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework_specific: {
          react_version: await this.detectReactVersion(context.projectPath),
          typescript: application?.typescript || false,
          application_type: application?.type || 'custom',
          router: application?.router || null,
          state_management: application?.stateManagement || [],
          components_detected: components.length,
          hooks_detected: hooks.length,
          contexts_detected: contexts.length,
          routes_detected: routes.length,
          stores_detected: stores.length,
          pages_detected: pages.length,
          utils_detected: utils.length
        }
      });

    } catch (error) {
      throw new AnalyzerError(
        `React analysis failed: ${(error as Error).message}`,
        'REACT_ANALYSIS_ERROR'
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

  private async reactSourceFiles(context: AnalysisContext): Promise<string[]> {
    const ignore = [...this.getIgnorePatterns(context), '**/*.test.*', '**/*.spec.*'];
    const jsxFiles = await glob(['**/*.{tsx,jsx}'], {
      cwd: context.projectPath,
      ignore,
      nodir: true,
    });
    const importGroundedFiles = this.filesFromExistingAnalysis(
      context,
      source => /^(react(?:-dom)?|next|react-router(?:-dom)?|redux|@reduxjs\/toolkit|zustand|recoil)(?:\/|$)/.test(source),
      true
    );
    const conventionFiles = await glob([
      '**/*{route,router,routes,store,context,hook,hooks,page,screen,component,layout,provider}*.{ts,js}',
      '**/{routes,router,store,stores,context,contexts,hooks,pages,screens,components}/**/*.{ts,js}',
    ], {
      cwd: context.projectPath,
      ignore,
      nodir: true,
    });
    const candidates = [...new Set([...jsxFiles, ...importGroundedFiles, ...conventionFiles])].sort();
    if ((context.existingAnalysis?.length || 0) > 0 && candidates.length > 0) {
      return this.capAndPrioritizeSourceFiles(candidates, 'React source files');
    }
    return this.capAndPrioritizeSourceFiles(await glob(['**/*.{ts,tsx,js,jsx}'], {
      cwd: context.projectPath,
      ignore,
      nodir: true,
    }), 'React source files');
  }

  protected getCapabilities(): string[] {
    return [
      'component-analysis',
      'hook-detection',
      'jsx-parsing',
      'route-mapping',
      'state-management-detection',
      'context-analysis',
      'props-extraction',
      'lifecycle-tracking'
    ];
  }

  protected createSourceAnalysis(files: readonly string[], projectPath: string): Promise<ReactSourceAnalysis> {
    return ReactSourceAnalysis.create({
      files,
      projectPath,
      read: fullPath => this.readTextFileIfExists(fullPath),
      parse: (file, content) => this.parseReactSource(file, content),
    });
  }

  private parseReactSource(file: string, content: string): ReturnType<typeof parse> {
    return parse(content, {
      loc: true,
      range: true,
      jsx: this.shouldParseJsx(file, content),
      ecmaVersion: 2020,
      sourceType: 'module'
    });
  }

  private async analyzeApplication(projectPath: string, nodes: CASNode[]): Promise<ReactApplication | null> {
    try {
      const packageJson = await this.readSourceJson<any>(path.join(projectPath, 'package.json'));
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };

      const typescript = Object.keys(deps).includes('typescript') ||
                        await fs.pathExists(path.join(projectPath, 'tsconfig.json'));

      let type: 'cra' | 'next' | 'vite' | 'custom' = 'custom';
      if (Object.keys(deps).includes('react-scripts')) type = 'cra';
      else if (Object.keys(deps).includes('next')) type = 'next';
      else if (Object.keys(deps).includes('vite')) type = 'vite';

      const router = this.detectRouter(deps);
      const stateManagement = this.detectStateManagement(deps);
      const testing = this.detectTestingFrameworks(deps);
      const buildTool = this.detectBuildTool(deps, projectPath);

      const entryPoint = await this.findEntryPoint(projectPath, type);

      const application: ReactApplication = {
        name: packageJson.name || 'react-app',
        entryPoint,
        type,
        typescript,
        router,
        stateManagement,
        testing,
        buildTool
      };

      const appId = this.generateId('app', 'package.json', application.name);
      const appNode = this.createNodeBuilder(appId, application.name, 'react_app')
        .withLevel(1, 'system')
        .withCategory('frontend', ['react', 'application'])
        .withSource({ file: 'package.json', line: 1, end_line: 1 })
        .withDescription(`React application: ${application.name}`)
        .withMetadata({
          framework: 'react',
          attributes: {
            type,
            typescript,
            router,
            state_management: stateManagement,
            testing,
            build_tool: buildTool,
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
    sources: ReactSourceAnalysis,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<ReactComponent[]> {
    const components: ReactComponent[] = [];

    for (const source of sources.files) {
      const { file, fullPath, content } = source;

      if (this.isReactComponent(content)) {
        try {
          const ast = sources.ast(source);

          const extractedComponents = this.extractComponents(ast, content, file);
          components.push(...extractedComponents);

          extractedComponents.forEach(component => {
            const componentId = this.generateId('component', component.filePath, component.name);
            const documentation = this.extractComponentDocumentation(ast, component.name, content);
            const comments = this.extractCommentsFromContent(content, fullPath);
            const todos = this.extractTodosFromContent(content, fullPath, component.name);
            const implementationStatus = this.detectReactImplementationStatus(ast, component.name, content);

            const componentNode = this.createNodeBuilder(componentId, component.name, component.type === 'functional' ? 'functional_component' : 'class_component')
              .withLevel(2, 'architectural')
              .withCategory('component', ['react', component.type])
              .withSource({ file: file, line: 1, end_line: this.sourceLineCount(content) })
              .withDescription(`React ${component.type} component: ${component.name}`)
              .withDocumentation(documentation)
              .withComments(comments)
              .withTodos(todos)
              .withImplementationStatus(implementationStatus)
              .withMetadata({
                framework: 'react',
                attributes: {
                  component_type: component.type,
                  is_default_export: component.isDefaultExport,
                  props_count: component.props.length,
                  state_count: component.state.length,
                  hooks_count: component.hooks.length,
                  lifecycle_count: component.lifecycle.length,
                  jsx: component.jsx,
                  imports_count: component.imports.length,
                  exports_count: component.exports.length
                }
              })
              .build();
            nodes.push(componentNode);

            component.handlerBindings.forEach(binding => {
              const bindingId = this.generateId('react_handler_binding', component.filePath, component.name + '_' + binding.line);
              nodes.push(this.createNodeBuilder(bindingId, binding.names.length > 1 ? '{ ' + binding.names.join(', ') + ' }' : binding.names[0], 'react_handler_binding')
                .withLevel(4, 'member')
                .withCategory('handler_binding', ['react', binding.kind])
                .withSource({ file: component.filePath, line: binding.line, end_line: binding.line })
                .withDescription('React ' + binding.kind + ' binding in ' + component.name)
                .withParent(componentId)
                .withMetadata({ framework: 'react', attributes: { binding_names: binding.names, binding_kind: binding.kind, value: binding.initializer } })
                .build());
              edges.push(this.createEdge(
                this.generateEdgeId(componentId, bindingId, 'contains'), componentId, bindingId, 'contains', 'structural',
                { binding_kind: binding.kind }
              ));
            });

            component.hooks.forEach((hook, index) => {
              const hookUsageId = this.generateId('hook_usage', component.filePath, `${component.name}_${hook.name}_${index}`);
              (hook as { hookUsageId?: string }).hookUsageId = hookUsageId;
              const hookUsageNode = this.createNodeBuilder(hookUsageId, `${hook.name} usage`, 'hook_usage')
                .withLevel(4, 'member')
                .withCategory('hook_usage', ['react', 'hook'])
                .withSource({ file: file, line: 1, end_line: 1 })
                .withDescription(`Hook usage in ${component.name}: ${hook.name}`)
                .withParent(componentId)
                .withMetadata({
                  framework: 'react',
                  attributes: {
                    hook_name: hook.name,
                    hook_type: hook.type,
                    dependencies: hook.dependencies
                  }
                })
                .build();
              nodes.push(hookUsageNode);

              edges.push(this.createEdge(
                this.generateEdgeId(componentId, hookUsageId, 'uses'),
                componentId,
                hookUsageId,
                'uses',
                'behavioral',
                { hook_name: hook.name }
              ));
            });
          });
        } catch (error) {
          console.warn(`Failed to parse React component ${file}:`, error);
        }
      }
    }

    return components;
  }

  private async analyzeHooks(
    sources: ReactSourceAnalysis,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<ReactHook[]> {
    const hooks: ReactHook[] = [];

    for (const source of sources.files) {
      const { file, fullPath, content } = source;

      if (this.isCustomHook(content)) {
        try {
          const ast = sources.ast(source);

          const extractedHooks = this.extractHooks(ast, content, file);
          hooks.push(...extractedHooks);

          extractedHooks.forEach(hook => {
            const hookId = this.generateId('hook', hook.filePath, hook.name);
            const documentation = this.extractHookDocumentation(ast, hook.name, content);
            const comments = this.extractCommentsFromContent(content, fullPath);
            const todos = this.extractTodosFromContent(content, fullPath, hook.name);
            const implementationStatus = this.detectReactImplementationStatus(ast, hook.name, content);

            const hookNode = this.createNodeBuilder(hookId, hook.name, 'custom_hook')
              .withLevel(3, 'code')
              .withCategory('hook', ['react', 'custom'])
              .withSource({ file: file, line: 1, end_line: this.sourceLineCount(content) })
              .withDescription(`Custom React hook: ${hook.name}`)
              .withDocumentation(documentation)
              .withComments(comments)
              .withTodos(todos)
              .withImplementationStatus(implementationStatus)
              .withSignature({
                parameters: hook.parameters.map(p => ({ name: p.name, type: p.type })),
                return_type: hook.returnType
              })
              .withMetadata({
                framework: 'react',
                attributes: {
                  hook_type: hook.type,
                  parameters_count: hook.parameters.length,
                  dependencies_count: hook.dependencies.length,
                  effect_dependencies_count: hook.effectDependencies.length
                }
              })
              .build();
            nodes.push(hookNode);
          });
        } catch (error) {
          console.warn(`Failed to parse React hook ${file}:`, error);
        }
      }
    }

    return hooks;
  }

  private async analyzeContexts(
    sources: ReactSourceAnalysis,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<ReactContext[]> {
    const contexts: ReactContext[] = [];

    for (const source of sources.files) {
      const { file, content } = source;

      if (content.includes('createContext') || content.includes('Context')) {
        try {
          const ast = sources.ast(source);

          const extractedContexts = this.extractContexts(ast, content, file);
          contexts.push(...extractedContexts);

          extractedContexts.forEach(context => {
            const contextId = this.generateId('context', context.filePath, context.name);
            const contextNode = this.createNodeBuilder(contextId, context.name, 'react_context')
              .withLevel(3, 'code')
              .withCategory('context', ['react', 'state'])
              .withSource({ file: file, line: 1, end_line: this.sourceLineCount(content) })
              .withDescription(`React context: ${context.name}`)
              .withMetadata({
                framework: 'react',
                attributes: {
                  provider: context.provider,
                  consumer: context.consumer,
                  properties_count: context.properties.length,
                  default_value: context.defaultValue
                }
              })
              .build();
            nodes.push(contextNode);
          });
        } catch (error) {
          console.warn(`Failed to parse React context ${file}:`, error);
        }
      }
    }

    return contexts;
  }

  private async analyzeRoutes(
    sources: ReactSourceAnalysis,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): Promise<ReactRoute[]> {
    const routes: ReactRoute[] = [];

    for (const source of sources.files) {
      const { file, content } = source;

      if (content.includes('Route') || content.includes('Router') || content.includes('routing')) {
        try {
          const extractedRoutes = this.extractRoutes(content, file);
          const annotate = (route: ReactRoute): void => {
            route.filePath = file;
            const target = route.component ? sources.componentModule(source, route.component) : undefined;
            if (target) route.componentModule = target;
            for (const child of route.children || []) annotate(child);
          };
          extractedRoutes.forEach(annotate);
          routes.push(...extractedRoutes);
          extractedRoutes.filter(route => route.path).forEach((route, index) => {
            const routeId = this.generateId('route', file, `${route.path}_${index}`);
            route.nodeId = routeId;
            const routeNode = this.createNodeBuilder(routeId, route.path, 'react_route')
              .withLevel(3, 'code')
              .withCategory('route', ['react', 'navigation'])
              .withSource({ file: file, line: 1, end_line: 1 })
              .withDescription(`React route: ${route.path}`)
              .withMetadata({
                framework: 'react',
                attributes: {
                  path: route.path,
                  component: route.component,
                  exact: route.exact,
                  guards: route.guards,
                  lazy: route.lazy
                }
              })
              .build();
            nodes.push(routeNode);

            entryPoints.push(this.createEntryPoint(
              `entry_${routeId}`,
              routeId,
              'route',
              `Route ${route.path}`,
              `React route mapping to component ${route.component}`,
              {
                path: route.path,
                method: 'GET'
              },
              {
                authenticated: (route.guards?.length || 0) > 0,
                authorized_roles: route.guards || []
              },
              {
                component: route.component,
                exact: route.exact,
                guards: route.guards
              }
            ));
          });
        } catch (error) {
          console.warn(`Failed to parse React routes ${file}:`, error);
        }
      }
    }

    return routes;
  }

  private async analyzeStores(
    sources: ReactSourceAnalysis,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<ReactStore[]> {
    const stores: ReactStore[] = [];

    for (const source of sources.files) {
      const { file, content } = source;

      if (this.isStoreFile(content)) {
        try {
          const extractedStores = this.extractStores(content, file);
          stores.push(...extractedStores);

          extractedStores.forEach(store => {
            const storeId = this.generateId('store', store.filePath, store.name);
            const storeNode = this.createNodeBuilder(storeId, store.name, `${store.type}_store`)
              .withLevel(3, 'code')
              .withCategory('store', ['react', store.type, 'state'])
              .withSource({ file: file, line: 1, end_line: this.sourceLineCount(content) })
              .withDescription(`${store.type.charAt(0).toUpperCase() + store.type.slice(1)} store: ${store.name}`)
              .withMetadata({
                framework: 'react',
                attributes: {
                  store_type: store.type,
                  actions_count: store.actions.length,
                  reducers_count: store.reducers.length,
                  selectors_count: store.selectors.length,
                  initial_state_keys: Object.keys(store.initialState).length
                }
              })
              .build();
            nodes.push(storeNode);
          });
        } catch (error) {
          console.warn(`Failed to parse React store ${file}:`, error);
        }
      }
    }

    return stores;
  }

  private async analyzePages(
    sources: ReactSourceAnalysis,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<ReactPage[]> {
    const pages: ReactPage[] = [];

    const pageFiles = sources.files.filter(source =>
      source.file.includes('/pages/') ||
      source.file.includes('/views/') ||
      source.file.includes('/screens/') ||
      source.file.includes('Page.') ||
      source.file.includes('View.') ||
      source.file.includes('Screen.')
    );

    for (const source of pageFiles) {
      const { file, content } = source;

      if (this.isReactComponent(content)) {
        const pageName = this.extractPageName(file);
        const route = this.inferRoute(file);
        const component = this.extractComponentName(content);

        const page: ReactPage = {
          name: pageName,
          filePath: file,
          route,
          component: component || pageName
        };

        pages.push(page);

        const pageId = this.generateId('page', page.filePath, pageName);
        const pageNode = this.createNodeBuilder(pageId, pageName, 'react_page')
          .withLevel(2, 'architectural')
          .withCategory('page', ['react', 'view'])
          .withSource({ file: file, line: 1, end_line: this.sourceLineCount(content) })
          .withDescription(`React page: ${pageName}`)
          .withMetadata({
            framework: 'react',
            attributes: {
              route,
              component: page.component
            }
          })
          .build();
        nodes.push(pageNode);
      }
    }

    return pages;
  }








  private createPageEntryPoints(
    pages: ReactPage[],
    routes: ReactRoute[],
    entryPoints: CASEntryPoint[],
    fileRouter: boolean
  ): void {
    const routedComponents = new Set<string>();
    const routedModules: string[] = [];
    const visit = (route: ReactRoute) => {
      if (route.component) routedComponents.add(route.component);
      if (route.componentModule) routedModules.push(route.componentModule);
      for (const child of route.children || []) visit(child);
    };
    routes.forEach(visit);
    const isRouted = (page: ReactPage): boolean => {
      if (routedComponents.has(page.component) || routedComponents.has(page.name)) return true;
      return routedModules.some(target => this.moduleTargetsAgree(target, page.filePath));
    };

    for (const page of pages) {
      const pageId = this.generateId('page', page.filePath, page.name);
      const isFileRoute = fileRouter && page.filePath.split('/').includes('pages');

      if (isFileRoute) {
        entryPoints.push(this.createEntryPoint(
          `entry_${pageId}`,
          pageId,
          'page',
          `Page ${page.name}`,
          `React page component accessible at ${page.route}`,
          {
            path: page.route,
            method: 'GET'
          },
          {
            authenticated: false
          },
          {
            component: page.component,
            name: page.name
          }
        ));
        continue;
      }

      if (isRouted(page)) continue;
      entryPoints.push(this.createEntryPoint(
        `entry_${pageId}`,
        pageId,
        'page',
        `Page ${page.name}`,
        `React page component ${page.component}, not reachable through any extracted route`,
        undefined,
        {
          authenticated: false
        },
        {
          component: page.component,
          name: page.name,
          trigger_kind: 'page-component',
          has_declared_route: false
        },
        {
          node_id: pageId,
          method_name: page.component,
          file: page.filePath,
          line: 1
        }
      ));
    }
  }

  private async analyzeUtils(
    sources: ReactSourceAnalysis,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<ReactUtil[]> {
    const utils: ReactUtil[] = [];

    const utilFiles = sources.files.filter(source =>
      source.file.includes('/utils/') ||
      source.file.includes('/helpers/') ||
      source.file.includes('/lib/') ||
      source.file.includes('util.') ||
      source.file.includes('helper.') ||
      source.file.includes('lib.') ||





      source.file.includes('/api/') ||
      source.file.includes('/services/') ||
      source.file.includes('api.') ||
      source.file.includes('service.')
    );

    for (const source of utilFiles) {
      const { file, content } = source;

      if (!this.isReactComponent(content)) {
        try {
          const ast = sources.ast(source);

          const extractedUtils = this.extractUtils(ast, content, file);
          utils.push(...extractedUtils);

          extractedUtils.forEach(util => {
            const utilId = this.generateId('util', util.filePath, util.name);
            const utilNode = this.createNodeBuilder(utilId, util.name, `${util.type}_util`)
              .withLevel(4, 'member')
              .withCategory('util', ['helper', util.type])
              .withSource({ file: file, line: 1, end_line: this.sourceLineCount(content) })
              .withDescription(`Utility ${util.type}: ${util.name}`)
              .withMetadata({
                framework: 'react',
                attributes: {
                  util_type: util.type,
                  exports_count: util.exports.length,
                  dependencies_count: util.dependencies.length
                }
              })
              .build();
            nodes.push(utilNode);
          });
        } catch (error) {
          console.warn(`Failed to parse React util ${file}:`, error);
        }
      }
    }

    return utils;
  }

  private isReactComponent(content: string): boolean {
    const hasDeclaration =
      content.includes('export') || content.includes('function') || content.includes('class');
    if (!hasDeclaration) return false;


    if ((content.includes('React') || content.includes('createElement')) && content.includes('return')) {
      return true;
    }




    return this.containsJsxSyntax(content);
  }


  private containsJsxSyntax(content: string): boolean {
    return /<[A-Z][A-Za-z0-9]*(?:\.[A-Z][A-Za-z0-9]*)*(?:\s|>|\/)/.test(content) ||
      /<[a-z][A-Za-z0-9:-]*(?:\s|>|\/)/.test(content) ||
      /<>/.test(content);
  }

  private isCustomHook(content: string): boolean {
    return /function\s+use[A-Z]\w*\s*\(/.test(content) ||
           /const\s+use[A-Z]\w*\s*=/.test(content) ||
           /export.*use[A-Z]\w*/.test(content);
  }

  private isStoreFile(content: string): boolean {
    return content.includes('createStore') ||
           content.includes('configureStore') ||
           content.includes('createSlice') ||
           content.includes('create(') && content.includes('zustand') ||
           content.includes('atom(') && content.includes('recoil');
  }

  private detectRouter(deps: Record<string, any>): string | null {
    if (deps['react-router-dom'] || deps['react-router']) return 'react-router';
    if (deps['@reach/router']) return 'reach-router';
    if (deps['next/router']) return 'next-router';
    if (deps['gatsby']) return 'gatsby-router';
    return null;
  }

  private detectStateManagement(deps: Record<string, any>): string[] {
    const stateManagement: string[] = [];
    if (deps['redux'] || deps['@reduxjs/toolkit']) stateManagement.push('redux');
    if (deps['zustand']) stateManagement.push('zustand');
    if (deps['recoil']) stateManagement.push('recoil');
    if (deps['jotai']) stateManagement.push('jotai');
    if (deps['valtio']) stateManagement.push('valtio');
    if (deps['mobx']) stateManagement.push('mobx');
    return stateManagement;
  }

  private detectTestingFrameworks(deps: Record<string, any>): string[] {
    const testing: string[] = [];
    if (deps['@testing-library/react']) testing.push('react-testing-library');
    if (deps['enzyme']) testing.push('enzyme');
    if (deps['jest']) testing.push('jest');
    if (deps['cypress']) testing.push('cypress');
    if (deps['playwright']) testing.push('playwright');
    return testing;
  }

  private detectBuildTool(deps: Record<string, any>, projectPath: string): string {
    if (deps['vite']) return 'vite';
    if (deps['webpack']) return 'webpack';
    if (deps['parcel']) return 'parcel';
    if (deps['rollup']) return 'rollup';
    if (deps['react-scripts']) return 'create-react-app';
    if (deps['next']) return 'next';
    return 'unknown';
  }

  private async findEntryPoint(projectPath: string, type: string): Promise<string> {
    const possibleEntryPoints = [
      'src/index.tsx',
      'src/index.js',
      'src/main.tsx',
      'src/main.js',
      'pages/index.tsx',
      'pages/index.js',
      'index.tsx',
      'index.js'
    ];

    for (const entry of possibleEntryPoints) {
      if (await fs.pathExists(path.join(projectPath, entry))) {
        return entry;
      }
    }

    return 'src/index.js';
  }

  private extractComponents(ast: any, content: string, filePath: string): ReactComponent[] {
    const components: ReactComponent[] = [];
    const seenNames = new Set<string>();

    const walk = (node: any) => {
      if (!node || typeof node !== 'object') return;

      if (node.type === 'FunctionDeclaration') {
        const name = node.id?.name;
        if (name && !seenNames.has(name) && this.looksLikeComponent(node, content, name)) {
          seenNames.add(name);
          components.push(this.buildComponentInfo(node, content, filePath, name, 'functional'));
        }
      } else if (node.type === 'VariableDeclarator' && node.id?.name) {
        const name = node.id.name;
        if (!seenNames.has(name)) {
          const init = node.init;
          if (init?.type === 'ArrowFunctionExpression' && this.looksLikeComponent(init, content, name)) {
            seenNames.add(name);
            components.push(this.buildComponentInfo(init, content, filePath, name, 'functional'));
          } else if (init?.type === 'CallExpression') {
            const callee = init.callee;
            const isWrapper =
              callee?.name === 'memo' || callee?.name === 'forwardRef' ||
              (callee?.type === 'MemberExpression' &&
               callee?.object?.name === 'React' &&
               (callee?.property?.name === 'memo' || callee?.property?.name === 'forwardRef'));
            if (isWrapper && init.arguments?.length > 0) {
              const innerFn = init.arguments[0];
              if ((innerFn?.type === 'ArrowFunctionExpression' || innerFn?.type === 'FunctionExpression') &&
                  this.looksLikeComponent(innerFn, content, name)) {
                seenNames.add(name);
                components.push(this.buildComponentInfo(innerFn, content, filePath, name, 'functional'));
              }
            }
          }
        }
      } else if (node.type === 'ClassDeclaration') {
        if (this.extendsReactComponent(node)) {
          const name = node.id?.name;
          if (name && !seenNames.has(name)) {
            seenNames.add(name);
            components.push(this.buildComponentInfo(node, content, filePath, name, 'class'));
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
    return components;
  }

  private extractHooks(ast: any, content: string, filePath: string): ReactHook[] {
    const hooks: ReactHook[] = [];

    const walk = (node: any) => {
      if (!node || typeof node !== 'object') return;

      if (node.type === 'FunctionDeclaration' || node.type === 'ArrowFunctionExpression') {
        const name = this.getHookName(node, content);
        if (name && name.startsWith('use') && name.length > 3 && name[3].toUpperCase() === name[3]) {
          const hook = this.buildHookInfo(node, content, filePath, name);
          hooks.push(hook);
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
    return hooks;
  }

  private extractContexts(ast: any, content: string, filePath: string): ReactContext[] {
    const contexts: ReactContext[] = [];

    const walk = (node: any) => {
      if (!node || typeof node !== 'object') return;

      if (node.type === 'VariableDeclarator' &&
          node.init?.type === 'CallExpression' &&
          node.init?.callee?.name === 'createContext') {

        const name = node.id?.name;
        if (name) {
          const context = this.buildContextInfo(node, content, filePath, name);
          contexts.push(context);
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
    return contexts;
  }

  private extractRoutes(content: string, filePath: string): ReactRoute[] {
    const routes: ReactRoute[] = [];
    const seen = new Set<string>();

    const v5Pattern = /<Route[^>]*path=["']([^"']+)["'][^>]*component=\{?([^}\s>]+)\}?[^>]*\/?>/g;
    let match;
    while ((match = v5Pattern.exec(content)) !== null) {
      const routePath = match[1];
      if (!seen.has(routePath)) {
        seen.add(routePath);
        routes.push({
          path: routePath,
          component: match[2],
          exact: content.includes('exact')
        });
      }
    }

    const v6ElementPattern = /<Route[^>]*path=["']([^"']+)["'][^>]*element=\{[^}]*<(\w+)/g;
    while ((match = v6ElementPattern.exec(content)) !== null) {
      const routePath = match[1];
      if (!seen.has(routePath)) {
        seen.add(routePath);
        routes.push({
          path: routePath,
          component: match[2]
        });
      }
    }

    const v6ReversePattern = /<Route[^>]*element=\{[^}]*<(\w+)[^}]*\}[^>]*path=["']([^"']+)["']/g;
    while ((match = v6ReversePattern.exec(content)) !== null) {
      const routePath = match[2];
      if (!seen.has(routePath)) {
        seen.add(routePath);
        routes.push({
          path: routePath,
          component: match[1]
        });
      }
    }








    const indexRouteObjectPattern = /\{\s*index:\s*true\s*,\s*(?:element|component)\s*:\s*(?:<(\w+)|(\w+))/g;
    while ((match = indexRouteObjectPattern.exec(content)) !== null) {
      const component = match[1] || match[2];
      if (component) routes.push({ path: '', component, index: true });
    }

    const indexRouteJsxPattern = /<Route[^>]*\bindex\b[^>]*element=\{[^}]*<(\w+)/g;
    while ((match = indexRouteJsxPattern.exec(content)) !== null) {
      routes.push({ path: '', component: match[1], index: true });
    }

    const objectRoutePattern = /\{\s*path:\s*['"]([^'"]+)['"]\s*,\s*(?:element|component)\s*:\s*(?:<(\w+)|(\w+))/g;
    while ((match = objectRoutePattern.exec(content)) !== null) {
      const routePath = match[1];
      const component = match[2] || match[3];
      if (!seen.has(routePath)) {
        seen.add(routePath);
        const isLazy = content.includes(`lazy`) && content.includes(routePath);
        routes.push({
          path: routePath,
          component,
          lazy: isLazy || undefined
        });
      }
    }

    if (content.includes('createBrowserRouter') || content.includes('createHashRouter') ||
        content.includes('createMemoryRouter')) {
      const routerConfigPattern = /path:\s*['"]([^'"]+)['"]/g;
      while ((match = routerConfigPattern.exec(content)) !== null) {
        const routePath = match[1];
        if (!seen.has(routePath)) {
          seen.add(routePath);
          const componentMatch = content.substring(match.index, match.index + 200)
            .match(/(?:element|Component)\s*:\s*(?:<(\w+)|(\w+))/);
          routes.push({
            path: routePath,
            component: componentMatch?.[1] || componentMatch?.[2] || 'Unknown',
            lazy: content.substring(match.index, match.index + 200).includes('lazy') || undefined
          });
        }
      }
    }

    return routes;
  }

  private extractStores(content: string, filePath: string): ReactStore[] {
    const stores: ReactStore[] = [];

    if (content.includes('configureStore') || content.includes('createStore')) {
      const storeName = this.extractStoreName(content, filePath);
      stores.push({
        name: storeName,
        filePath,
        type: 'redux',
        actions: this.extractActions(content),
        reducers: this.extractReducers(content),
        selectors: this.extractSelectors(content),
        initialState: {}
      });
    } else if (content.includes('createSlice')) {
      const slicePattern = /createSlice\s*\(\s*\{[\s\S]*?name:\s*['"](\w+)['"]/g;
      let sliceMatch;
      while ((sliceMatch = slicePattern.exec(content)) !== null) {
        stores.push({
          name: sliceMatch[1],
          filePath,
          type: 'redux',
          actions: this.extractActions(content),
          reducers: this.extractReducers(content),
          selectors: this.extractSelectors(content),
          initialState: {}
        });
      }
    }

    const hasZustandImport = /import\s+.*\bfrom\s+['"]zustand['"]/g.test(content) ||
      /import\s+.*\bfrom\s+['"][^'"]*zustand[^'"]*['"]/g.test(content);
    const hasCreateCall = /(?:const|export)\s+\w+\s*=\s*create\s*[<(]/g.test(content);

    if (hasZustandImport || (hasCreateCall && this.looksLikeZustandStore(content))) {
      const storeName = this.extractStoreName(content, filePath);
      const isDuplicate = stores.some(s => s.name === storeName);
      if (!isDuplicate) {
        stores.push({
          name: storeName,
          filePath,
          type: 'zustand',
          actions: this.extractActions(content),
          reducers: [],
          selectors: [],
          initialState: {}
        });
      }
    }

    return stores;
  }

  private looksLikeZustandStore(content: string): boolean {
    return /create\s*[<(]\s*\(\s*(?:set|get)\s*[,)]/g.test(content);
  }

  private extractUtils(ast: any, content: string, filePath: string): ReactUtil[] {
    const utils: ReactUtil[] = [];

    const walk = (node: any) => {
      if (!node || typeof node !== 'object') return;

      if (node.type === 'FunctionDeclaration') {
        const name = node.id?.name;
        if (name) {
          utils.push({
            name,
            filePath,
            type: 'function',
            exports: [name],
            dependencies: []
          });
        }
      } else if (node.type === 'VariableDeclarator') {
        const name = node.id?.name;
        if (name) {
          utils.push({
            name,
            filePath,
            type: 'constant',
            exports: [name],
            dependencies: []
          });
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
    return utils;
  }


  private getHookName(node: any, content: string): string | null {
    if (!node || typeof node !== 'object') return null;

    if (node.type === 'FunctionDeclaration') {
      return node.id?.name || null;
    }
    if (node.type === 'ArrowFunctionExpression') {
      const declaration = this.findVariableDeclarator(node);
      return declaration?.id?.name || null;
    }
    return null;
  }

  private looksLikeComponent(node: any, content: string, name?: string): boolean {
    if (name && !/^[A-Z]/.test(name)) {
      return false;
    }
    const nodeContent = content.substring(node.range?.[0] || 0, node.range?.[1] || content.length);
    const returnsJsx = node.body?.type !== 'BlockStatement' &&
      (node.body?.type === 'JSXElement' || node.body?.type === 'JSXFragment' || nodeContent.trimStart().startsWith('<'));
    return (nodeContent.includes('return') || returnsJsx) &&
           (nodeContent.includes('<') || nodeContent.includes('createElement'));
  }

  private extendsReactComponent(node: any): boolean {
    return node.superClass?.name === 'Component' ||
           (node.superClass?.type === 'MemberExpression' &&
            node.superClass?.object?.name === 'React' &&
            node.superClass?.property?.name === 'Component');
  }

  private buildComponentInfo(node: any, content: string, filePath: string, name: string, type: 'functional' | 'class'): ReactComponent {
    return {
      name,
      filePath,
      type,
      sourceStartLine: node.loc?.start?.line || 1,
      sourceEndLine: node.loc?.end?.line || this.sourceLineCount(content),
      isDefaultExport: this.isDefaultExport(node, content, name),
      props: this.extractProps(node, content),
      state: this.extractState(node, content),
      hooks: this.extractComponentHooks(node, content),
      lifecycle: this.extractLifecycleMethods(node, content),
      children: [],
      imports: this.extractImports(content),
      importBindings: this.componentAnalysis.extractImportBindings(content),
      exports: this.extractExports(content),
      jsx: content.includes('jsx') || content.includes('<'),
      renderedComponents: this.componentAnalysis.extractRenderedComponents(node, content),
      eventHandlers: this.componentAnalysis.extractEventHandlers(node, content),
      handlerBindings: this.componentAnalysis.extractLocalHandlerBindings(node, content)
    };
  }





  private buildHookInfo(node: any, content: string, filePath: string, name: string): ReactHook {
    return {
      name,
      filePath,
      type: 'custom',
      parameters: this.extractHookParameters(node),
      returnType: 'unknown',
      dependencies: [],
      effectDependencies: []
    };
  }

  private buildContextInfo(node: any, content: string, filePath: string, name: string): ReactContext {
    return {
      name,
      filePath,
      defaultValue: null,
      provider: `${name}.Provider`,
      consumer: `${name}.Consumer`,
      properties: []
    };
  }

  private findVariableDeclarator(node: any): any {
    if (!node || typeof node !== 'object') return null;
    if (node._parentDeclarator) return node._parentDeclarator;

    const search = (current: any, target: any): any => {
      if (!current || typeof current !== 'object') return null;

      if (current.type === 'VariableDeclarator') {
        if (current.init === target) return current;
        if (current.init?.type === 'CallExpression' &&
            current.init.arguments?.some((arg: any) => arg === target || this.containsNode(arg, target))) {
          return current;
        }
        if (this.containsNode(current.init, target)) return current;
      }

      for (const key in current) {
        if (key === 'type' || key === 'loc' || key === 'range') continue;
        if (typeof current[key] === 'object' && current[key] !== null) {
          if (Array.isArray(current[key])) {
            for (const child of current[key]) {
              const result = search(child, target);
              if (result) return result;
            }
          } else {
            const result = search(current[key], target);
            if (result) return result;
          }
        }
      }
      return null;
    };

    return null;
  }

  private containsNode(parent: any, target: any): boolean {
    if (parent === target) return true;
    if (!parent || typeof parent !== 'object') return false;
    for (const key in parent) {
      if (key === 'type' || key === 'loc' || key === 'range') continue;
      if (typeof parent[key] === 'object' && parent[key] !== null) {
        if (this.containsNode(parent[key], target)) return true;
      }
    }
    return false;
  }

  private isDefaultExport(node: any, content: string, declaredName?: string): boolean {
    const name = String(declaredName || node.id?.name || '').trim();
    if (!name) return false;
    const escaped = name.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
    return new RegExp('\\bexport\\s+default\\s+(?:(?:async\\s+)?function\\s+|class\\s+)?' + escaped + '\\b').test(content);
  }

  private extractProps(node: any, content: string): Array<{ name: string; type: string; required: boolean; defaultValue?: string }> {
    const props: Array<{ name: string; type: string; required: boolean; defaultValue?: string }> = [];

    if (!node || typeof node !== 'object') return props;

    const componentName = node.id?.name || '';

    if (node.type === 'FunctionDeclaration' && node.params && node.params.length > 0) {
      const propsParam = node.params[0];
      if (propsParam.type === 'ObjectPattern') {
        propsParam.properties.forEach((prop: any) => {
          if (prop.type === 'Property' && prop.key?.name) {
            const propType = prop.value?.typeAnnotation?.typeAnnotation?.type || 'any';
            const defaultValue = prop.value?.type === 'AssignmentPattern' ?
              this.extractDefaultValue(prop.value.right) : undefined;

            props.push({
              name: prop.key.name,
              type: this.mapTypeAnnotationToString(propType),
              required: !defaultValue && !prop.value?.optional,
              defaultValue
            });
          }
        });
      } else if (propsParam.typeAnnotation?.typeAnnotation) {
        const typeAnnotation = propsParam.typeAnnotation.typeAnnotation;
        if (typeAnnotation.type === 'TSTypeReference' && typeAnnotation.typeName?.name) {
          const propsTypeName = typeAnnotation.typeName.name;
          this.extractPropsFromInterface(content, propsTypeName, props);
        } else if (typeAnnotation.type === 'TSTypeLiteral') {
          this.extractPropsFromTypeLiteral(typeAnnotation, props);
        }
      }
    }

    if (props.length === 0 && componentName) {
      const propsInterfacePatterns = [
        `${componentName}Props`,
        `I${componentName}Props`,
        `${componentName}Properties`
      ];

      for (const typeName of propsInterfacePatterns) {
        if (this.extractPropsFromInterface(content, typeName, props)) {
          break;
        }
      }
    }

    const propTypesMatch = content.match(new RegExp(`${componentName || 'Component'}\\.propTypes\\s*=\\s*\\{([^}]+)\\}`, 's'));
    if (propTypesMatch) {
      const propTypesContent = propTypesMatch[1];
      const propTypeLines = propTypesContent.split(',').map(line => line.trim()).filter(line => line);

      propTypeLines.forEach(line => {
        const propMatch = line.match(/(\w+):\s*PropTypes\.(\w+)\.?(\w+)?/);
        if (propMatch) {
          const [, name, type, required] = propMatch;
          const isRequired = required === 'isRequired';

          const existingProp = props.find(p => p.name === name);
          if (existingProp) {
            existingProp.type = type;
            existingProp.required = isRequired;
          } else {
            props.push({
              name,
              type,
              required: isRequired
            });
          }
        }
      });
    }

    return props;
  }

  private extractPropsFromInterface(content: string, typeName: string, props: Array<{ name: string; type: string; required: boolean; defaultValue?: string }>): boolean {
    const interfacePattern = new RegExp(`(?:interface|type)\\s+${typeName}\\s*(?:=\\s*)?\\{([^}]+)\\}`, 's');
    const interfaceMatch = content.match(interfacePattern);

    if (interfaceMatch) {
      const interfaceBody = interfaceMatch[1];
      const propLines = interfaceBody.split(/[;\n]/).map(line => line.trim()).filter(line => line && !line.startsWith('//'));

      propLines.forEach(line => {
        const propMatch = line.match(/^(\w+)(\?)?:\s*(.+)$/);
        if (propMatch) {
          const [, name, optional, type] = propMatch;
          const existingProp = props.find(p => p.name === name);
          if (!existingProp) {
            props.push({
              name,
              type: type.trim(),
              required: !optional
            });
          }
        }
      });
      return true;
    }
    return false;
  }

  private extractPropsFromTypeLiteral(typeNode: any, props: Array<{ name: string; type: string; required: boolean; defaultValue?: string }>): void {
    if (!typeNode.members) return;

    typeNode.members.forEach((member: any) => {
      if (member.type === 'TSPropertySignature' && member.key?.name) {
        const propName = member.key.name;
        const propType = this.extractTypeFromAnnotation(member.typeAnnotation?.typeAnnotation);
        const isOptional = member.optional || false;

        props.push({
          name: propName,
          type: propType,
          required: !isOptional
        });
      }
    });
  }

  private extractTypeFromAnnotation(typeNode: any): string {
    if (!typeNode) return 'any';

    switch (typeNode.type) {
      case 'TSStringKeyword':
        return 'string';
      case 'TSNumberKeyword':
        return 'number';
      case 'TSBooleanKeyword':
        return 'boolean';
      case 'TSVoidKeyword':
        return 'void';
      case 'TSAnyKeyword':
        return 'any';
      case 'TSNullKeyword':
        return 'null';
      case 'TSUndefinedKeyword':
        return 'undefined';
      case 'TSArrayType':
        return `${this.extractTypeFromAnnotation(typeNode.elementType)}[]`;
      case 'TSTypeReference':
        if (typeNode.typeName?.name) {
          if (typeNode.typeParameters?.params?.length > 0) {
            const params = typeNode.typeParameters.params.map((p: any) => this.extractTypeFromAnnotation(p)).join(', ');
            return `${typeNode.typeName.name}<${params}>`;
          }
          return typeNode.typeName.name;
        }
        return 'unknown';
      case 'TSUnionType':
        return typeNode.types?.map((t: any) => this.extractTypeFromAnnotation(t)).join(' | ') || 'unknown';
      case 'TSIntersectionType':
        return typeNode.types?.map((t: any) => this.extractTypeFromAnnotation(t)).join(' & ') || 'unknown';
      case 'TSFunctionType':
        return '(...args: any[]) => any';
      case 'TSTypeLiteral':
        return 'object';
      case 'TSLiteralType':
        if (typeNode.literal?.value !== undefined) {
          return typeof typeNode.literal.value === 'string'
            ? `"${typeNode.literal.value}"`
            : String(typeNode.literal.value);
        }
        return 'literal';
      default:
        return 'any';
    }
  }

  private extractState(node: any, content: string): Array<{ name: string; type: string; initialValue?: string }> {
    const state: Array<{ name: string; type: string; initialValue?: string }> = [];
    const useStatePattern = /const\s*\[\s*(\w+)\s*,\s*(\w+)\s*\]\s*=\s*useState(?:<([^>]+)>)?\s*\(([^)]*)\)/g;
    const useReducerPattern = /const\s*\[\s*(\w+)\s*,\s*(\w+)\s*\]\s*=\s*useReducer\s*\(/g;

    let match;
    while ((match = useStatePattern.exec(content)) !== null) {
      const stateName = match[1];
      const typeAnnotation = match[3] || 'unknown';
      const initialValue = match[4]?.trim() || undefined;

      state.push({
        name: stateName,
        type: typeAnnotation,
        initialValue: initialValue || undefined
      });
    }

    while ((match = useReducerPattern.exec(content)) !== null) {
      state.push({
        name: match[1],
        type: 'reducer_state',
        initialValue: undefined
      });
    }

    if (node?.type === 'ClassDeclaration' || node?.type === 'ClassExpression') {
      const classStatePattern = /state\s*[:=]\s*\{([^}]+)\}/;
      const classMatch = classStatePattern.exec(content);
      if (classMatch) {
        const stateBody = classMatch[1];
        const fieldPattern = /(\w+)\s*:/g;
        let fieldMatch;
        while ((fieldMatch = fieldPattern.exec(stateBody)) !== null) {
          state.push({
            name: fieldMatch[1],
            type: 'unknown'
          });
        }
      }
    }

    return state;
  }

  private extractComponentHooks(node: any, content: string): Array<{ name: string; type: string; dependencies?: string[]; hookUsageId?: string }> {
    const hooks: Array<{ name: string; type: string; dependencies?: string[]; hookUsageId?: string }> = [];
    const hookPattern = /(use\w+)\s*\(/g;







    const dataFetchingHooks = new Set(['useQuery', 'useMutation', 'useSWR', 'useSWRMutation', 'useInfiniteQuery']);

    let match;
    while ((match = hookPattern.exec(content)) !== null) {
      const hookName = match[1];
      const hookEntry: { name: string; type: string; dependencies?: string[] } = {
        name: hookName,
        type: hookName.startsWith('use') && hookName.length > 3 ? 'custom' : 'built-in'
      };

      if (dataFetchingHooks.has(hookName)) {
        const argsText = this.extractBalancedCallArgsText(content, match.index + match[0].length - 1);
        const candidates = this.extractFetcherCallCandidates(argsText);
        if (candidates.length > 0) {
          hookEntry.dependencies = candidates;
        }
      }

      hooks.push(hookEntry);
    }

    return hooks;
  }





  private extractBalancedCallArgsText(content: string, openParenIndex: number): string {
    let depth = 0;
    let start = -1;
    for (let i = openParenIndex; i < content.length; i++) {
      const ch = content[i];
      if (ch === '(') {
        depth++;
        if (depth === 1) start = i + 1;
        continue;
      }
      if (ch === ')') {
        depth--;
        if (depth === 0) return start >= 0 ? content.slice(start, i) : '';
      }
    }
    return start >= 0 ? content.slice(start) : '';
  }











  private extractFetcherCallCandidates(argsText: string): string[] {
    if (!argsText) return [];
    const candidates: string[] = [];
    const seen = new Set<string>();
    const add = (name: string) => { if (name && !seen.has(name)) { seen.add(name); candidates.push(name); } };

    const fnKeyPattern = /(?:queryFn|mutationFn)\s*:\s*([A-Za-z_$][\w$.]*)(?=\s*[,}])/g;
    let km;
    while ((km = fnKeyPattern.exec(argsText)) !== null) {
      const ref = km[1];
      add(ref);
      const bare = ref.includes('.') ? ref.split('.').pop()! : ref;
      if (bare !== ref) add(bare);
    }

    const skip = new Set([
      'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'async',
      'await', 'JSON', 'Boolean', 'String', 'Number', 'Array', 'Object',
      'Promise', 'Error', 'new', 'URLSearchParams'
    ]);







    const identifierPattern = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g;
    let im;
    while ((im = identifierPattern.exec(argsText)) !== null) {
      const qualified = im[1];
      const bare = qualified.includes('.') ? qualified.split('.').pop()! : qualified;
      if (skip.has(bare) || skip.has(qualified)) continue;

      let i = identifierPattern.lastIndex;
      while (i < argsText.length && /\s/.test(argsText[i])) i++;
      if (argsText[i] === '<') {
        let depth = 0;
        let j = i;
        for (; j < argsText.length; j++) {
          if (argsText[j] === '<') depth++;
          else if (argsText[j] === '>') { depth--; if (depth === 0) { j++; break; } }
        }
        if (depth !== 0) continue;
        i = j;
        while (i < argsText.length && /\s/.test(argsText[i])) i++;
      }
      if (argsText[i] !== '(') continue;

      add(qualified);
      if (bare !== qualified) add(bare);
    }

    return candidates;
  }

  private extractLifecycleMethods(node: any, content: string): string[] {
    const lifecycle: string[] = [];
    const lifecycleMethods = [
      'componentDidMount', 'componentDidUpdate', 'componentWillUnmount',
      'shouldComponentUpdate', 'getSnapshotBeforeUpdate', 'componentDidCatch'
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

  private extractHookParameters(node: any): Array<{ name: string; type: string; defaultValue?: string }> {
    const params: Array<{ name: string; type: string; defaultValue?: string }> = [];
    if (!node?.params) return params;

    for (const param of node.params) {
      if (param.type === 'Identifier') {
        const type = param.typeAnnotation?.typeAnnotation?.type
          ? this.mapTypeAnnotationToString(param.typeAnnotation.typeAnnotation.type)
          : 'any';
        params.push({ name: param.name, type });
      } else if (param.type === 'AssignmentPattern' && param.left?.type === 'Identifier') {
        const type = param.left.typeAnnotation?.typeAnnotation?.type
          ? this.mapTypeAnnotationToString(param.left.typeAnnotation.typeAnnotation.type)
          : 'any';
        params.push({
          name: param.left.name,
          type,
          defaultValue: this.extractDefaultValue(param.right)
        });
      } else if (param.type === 'ObjectPattern') {
        for (const prop of (param.properties || [])) {
          if (prop.type === 'Property' && prop.key?.name) {
            const defaultValue = prop.value?.type === 'AssignmentPattern'
              ? this.extractDefaultValue(prop.value.right) : undefined;
            const type = prop.value?.typeAnnotation?.typeAnnotation?.type
              ? this.mapTypeAnnotationToString(prop.value.typeAnnotation.typeAnnotation.type)
              : 'any';
            params.push({ name: prop.key.name, type, defaultValue });
          }
        }
      } else if (param.type === 'RestElement' && param.argument?.type === 'Identifier') {
        params.push({ name: `...${param.argument.name}`, type: 'any[]' });
      }
    }

    return params;
  }

  private extractPageName(filePath: string): string {
    const fileName = path.basename(filePath, path.extname(filePath));
    return fileName.replace(/Page$|View$|Screen$/, '') || fileName;
  }



















  private normalizeModuleTarget(target: string): string {
    return target
      .replace(/\\/g, '/')
      .replace(/^[@~]\//, '')
      .replace(/^\.{1,2}\//, '')
      .replace(/\.(tsx|ts|jsx|js|mjs|cjs)$/i, '')
      .replace(/\/index$/, '')
      .replace(/^\/+/, '');
  }


  private moduleTargetsAgree(moduleSpecifier: string, pageFilePath: string): boolean {
    const spec = this.normalizeModuleTarget(moduleSpecifier);
    const file = this.normalizeModuleTarget(pageFilePath);
    if (!spec || !file) return false;




    return file === spec || file.endsWith(`/${spec}`) || spec.endsWith(`/${file}`);
  }

  private inferRoute(filePath: string): string {
    const segments = filePath.split('/');
    const fileName = path.basename(filePath, path.extname(filePath));

    if (segments.includes('pages')) {
      const pageIndex = segments.indexOf('pages');
      const routeSegments = segments
        .slice(pageIndex + 1)
        .map(segment => this.routeSegmentFromFileSegment(segment))
        .filter(Boolean);
      if (routeSegments.length > 0 && routeSegments[routeSegments.length - 1] === 'index') {
        routeSegments.pop();
      }
      return '/' + routeSegments.join('/');
    }

    const baseName = fileName.replace(/Page$|View$|Screen$/, '') || fileName;
    return '/' + this.routeSegmentFromFileSegment(baseName);
  }

  private routeSegmentFromFileSegment(segment: string): string {
    const withoutExtension = segment.replace(/\.(tsx|jsx|ts|js|mjs|cjs)$/i, '');
    const catchAll = withoutExtension.match(/^\[\.\.\..+\]$/);
    if (catchAll) return '*';
    const dynamic = withoutExtension.match(/^\[(.+)\]$/);
    if (dynamic) return `:${dynamic[1]}`;
    return withoutExtension
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .replace(/[_\s]+/g, '-')
      .toLowerCase();
  }

  private extractComponentName(content: string): string | null {
    const componentPattern = /(?:function|const)\s+(\w+)|export\s+default\s+(?:function\s+)?(\w+)/;
    const match = componentPattern.exec(content);
    return match ? (match[1] || match[2]) : null;
  }

  private extractStoreName(content: string, filePath: string): string {
    const storePattern = /(?:const|export)\s+(\w*[Ss]tore\w*)/;
    const match = storePattern.exec(content);
    return match ? match[1] : path.basename(filePath, path.extname(filePath));
  }

  private extractActions(content: string): Array<{ name: string; type: string; payload?: string }> {
    const actions: Array<{ name: string; type: string; payload?: string }> = [];
    const actionPattern = /(\w+):\s*(?:\(.*?\)\s*=>|function)/g;

    let match;
    while ((match = actionPattern.exec(content)) !== null) {
      actions.push({
        name: match[1],
        type: 'action'
      });
    }

    return actions;
  }

  private extractReducers(content: string): Array<{ name: string; cases: string[] }> {
    const reducers: Array<{ name: string; cases: string[] }> = [];

    const slicePattern = /createSlice\s*\(\s*\{[\s\S]*?name:\s*['"](\w+)['"][\s\S]*?reducers:\s*\{([\s\S]*?)\}\s*[,}]/g;
    let sliceMatch;
    while ((sliceMatch = slicePattern.exec(content)) !== null) {
      const sliceName = sliceMatch[1];
      const reducersBody = sliceMatch[2];
      const cases: string[] = [];
      const casePattern = /(\w+)\s*(?::\s*\(|:\s*\{)/g;
      let caseMatch;
      while ((caseMatch = casePattern.exec(reducersBody)) !== null) {
        cases.push(caseMatch[1]);
      }
      reducers.push({ name: sliceName, cases });
    }

    const switchPattern = /(?:function\s+(\w+)|const\s+(\w+)\s*=)[^{]*\{[\s\S]*?switch\s*\([^)]*\)\s*\{([\s\S]*?)\}/g;
    let switchMatch;
    while ((switchMatch = switchPattern.exec(content)) !== null) {
      const name = switchMatch[1] || switchMatch[2];
      const switchBody = switchMatch[3];
      const cases: string[] = [];
      const actionPattern = /case\s+['"]([^'"]+)['"]/g;
      let actionMatch;
      while ((actionMatch = actionPattern.exec(switchBody)) !== null) {
        cases.push(actionMatch[1]);
      }
      const constPattern = /case\s+(\w+)(?:\s*:)/g;
      let constMatch;
      while ((constMatch = constPattern.exec(switchBody)) !== null) {
        if (constMatch[1] !== 'default') {
          cases.push(constMatch[1]);
        }
      }
      if (cases.length > 0) {
        reducers.push({ name, cases });
      }
    }

    return reducers;
  }

  private extractSelectors(content: string): Array<{ name: string; returnType: string }> {
    const selectors: Array<{ name: string; returnType: string }> = [];
    const seen = new Set<string>();

    const createSelectorPattern = /(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*createSelector\s*\(/g;
    let match;
    while ((match = createSelectorPattern.exec(content)) !== null) {
      if (!seen.has(match[1])) {
        seen.add(match[1]);
        selectors.push({ name: match[1], returnType: 'unknown' });
      }
    }

    const selectFnPattern = /(?:export\s+)?(?:const|function)\s+(select\w+)/g;
    while ((match = selectFnPattern.exec(content)) !== null) {
      if (!seen.has(match[1])) {
        seen.add(match[1]);
        selectors.push({ name: match[1], returnType: 'unknown' });
      }
    }

    const useSelectorPattern = /useSelector\s*\(\s*(?:\(\s*(\w+)\s*\)\s*=>|(\w+)(?:\s*,|\s*\)))/g;
    while ((match = useSelectorPattern.exec(content)) !== null) {
      const selectorRef = match[2];
      if (selectorRef && !seen.has(selectorRef)) {
        seen.add(selectorRef);
        selectors.push({ name: selectorRef, returnType: 'unknown' });
      }
    }

    return selectors;
  }

  private async detectReactVersion(projectPath: string): Promise<string> {
    try {
      const packageJson = await this.readSourceJson<any>(path.join(projectPath, 'package.json'));
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      return deps.react || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private async isFileRouterProject(projectPath: string): Promise<boolean> {
    const cached = this.fileRouterCache.get(projectPath);
    if (cached !== undefined) return cached;
    let fileRouter = false;
    try {
      const packageJson = await this.readSourceJson<any>(path.join(projectPath, 'package.json'));
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      fileRouter = Object.keys(deps).includes('next');
    } catch {
      fileRouter = false;
    }
    this.fileRouterCache.set(projectPath, fileRouter);
    return fileRouter;
  }

  private extractExistingReactFacts(context: FileAnalysisContext, excludedFile: string): {
    components: ReactComponent[];
    hooks: ReactHook[];
    contexts: ReactContext[];
    stores: ReactStore[];
    utils: ReactUtil[];
  } {
    const facts = {
      components: [] as ReactComponent[],
      hooks: [] as ReactHook[],
      contexts: [] as ReactContext[],
      stores: [] as ReactStore[],
      utils: [] as ReactUtil[]
    };

    for (const contribution of context.existingAnalysis || []) {
      for (const node of contribution.nodes || []) {
        if (!node.analyzers?.includes(this.analyzerId) && node.primaryAnalyzer !== this.analyzerId) continue;

        const filePath = this.relativeNodeFile(context.projectPath, node.source?.file);
        if (!filePath || filePath === excludedFile) continue;

        if (node.type === 'functional_component' || node.type === 'class_component') {
          facts.components.push({
            name: node.name,
            filePath,
            type: node.type === 'class_component' ? 'class' : 'functional',
            sourceStartLine: node.source?.line || 1,
            sourceEndLine: node.source?.end_line || node.source?.line || 1,
            isDefaultExport: Boolean(node.metadata?.attributes?.is_default_export),
            props: [],
            state: [],
            hooks: [],
            lifecycle: [],
            children: [],
            imports: [],
            importBindings: [],
            exports: [],
            jsx: Boolean(node.metadata?.attributes?.jsx),
            renderedComponents: [],
            eventHandlers: [],
            handlerBindings: []
          });
        } else if (node.type === 'custom_hook') {
          facts.hooks.push({
            name: node.name,
            filePath,
            type: 'custom',
            parameters: [],
            returnType: node.signature?.return_type || 'unknown',
            dependencies: [],
            effectDependencies: []
          });
        } else if (node.type === 'react_context') {
          facts.contexts.push({
            name: node.name,
            filePath,
            defaultValue: node.metadata?.attributes?.default_value,
            provider: node.metadata?.attributes?.provider || `${node.name}.Provider`,
            consumer: node.metadata?.attributes?.consumer || `${node.name}.Consumer`,
            properties: []
          });
        } else if (node.type.endsWith('_store')) {
          const storeType = node.type.replace(/_store$/, '') as ReactStore['type'];
          facts.stores.push({
            name: node.name,
            filePath,
            type: ['redux', 'zustand', 'recoil', 'context', 'custom'].includes(storeType) ? storeType : 'custom',
            actions: [],
            reducers: [],
            selectors: [],
            initialState: {}
          });
        } else if (node.type.endsWith('_util')) {
          const utilType = node.type.replace(/_util$/, '') as ReactUtil['type'];
          facts.utils.push({
            name: node.name,
            filePath,
            type: ['function', 'class', 'constant'].includes(utilType) ? utilType : 'function',
            exports: [node.name],
            dependencies: []
          });
        }
      }
    }

    return facts;
  }

  private relativeNodeFile(projectPath: string, file?: string): string | null {
    if (!file) return null;
    return path.isAbsolute(file) ? path.relative(projectPath, file) : file;
  }

  private buildReactRelationships(
    components: ReactComponent[],
    hooks: ReactHook[],
    contexts: ReactContext[],
    routes: ReactRoute[],
    stores: ReactStore[],
    pages: ReactPage[],
    utils: ReactUtil[],
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    declarationNodes: readonly CASNode[] = []
  ): void {
    const componentNameToId = new Map<string, string>();
    for (const component of components) {
      if (components.filter(candidate => candidate.name === component.name).length === 1) {
        componentNameToId.set(component.name, this.generateId('component', component.filePath, component.name));
      }
    }





    const rendersEdgeOccurrences = new Map<string, number>();
    const rendersEdgeId = (sourceId: string, targetId: string): string => {
      const key = `${sourceId}->${targetId}`;
      const occurrence = rendersEdgeOccurrences.get(key) ?? 0;
      rendersEdgeOccurrences.set(key, occurrence + 1);
      return occurrence === 0
        ? this.generateEdgeId(sourceId, targetId, 'renders')
        : this.generateEdgeId(`${sourceId}#${occurrence}`, targetId, 'renders');
    };
    const hookNameToId = new Map<string, string>();
    hooks.forEach(hook => {
      hookNameToId.set(hook.name, this.generateId('hook', hook.filePath, hook.name));
    });
    const namedTargetIds = new Map<string, string>(componentNameToId);
    hooks.forEach(hook => namedTargetIds.set(hook.name, this.generateId('hook', hook.filePath, hook.name)));
    contexts.forEach(context => {
      const contextId = this.generateId('context', context.filePath, context.name);
      namedTargetIds.set(context.name, contextId);
      namedTargetIds.set(context.provider, contextId);
      namedTargetIds.set(context.consumer, contextId);
    });
    stores.forEach(store => namedTargetIds.set(store.name, this.generateId('store', store.filePath, store.name)));
    pages.forEach(page => namedTargetIds.set(page.name, this.generateId('page', page.filePath, page.name)));
    utils.forEach(util => {
      const utilId = this.generateId('util', util.filePath, util.name);
      namedTargetIds.set(util.name, utilId);
      util.exports.forEach(exportName => namedTargetIds.set(exportName, utilId));
    });







    const AMBIGUOUS = Symbol('ambiguous');
    const fetcherTargetIds = new Map<string, string | typeof AMBIGUOUS>();
    utils.forEach(util => {
      if (util.type !== 'function') return;
      const utilId = this.generateId('util', util.filePath, util.name);
      const names = new Set([util.name, ...util.exports]);
      names.forEach(name => {
        const existing = fetcherTargetIds.get(name);
        if (existing === undefined) {
          fetcherTargetIds.set(name, utilId);
        } else if (existing !== utilId) {
          fetcherTargetIds.set(name, AMBIGUOUS);
        }
      });
    });

    components.forEach(component => {
      const componentId = this.generateId('component', component.filePath, component.name);

      component.imports.forEach(importPath => {
        if (importPath.startsWith('./') || importPath.startsWith('../')) {
          const importName = path.basename(importPath, path.extname(importPath));
          const importedNodeId = namedTargetIds.get(importName);
          if (importedNodeId) {
            edges.push(this.createEdge(
              this.generateEdgeId(componentId, importedNodeId, 'imports'),
              componentId,
              importedNodeId,
              'imports',
              'dependency',
              { import_path: importPath }
            ));
          }
        }
      });

      component.hooks.forEach(hook => {
        if (hook.type === 'custom') {
          const hookId = hookNameToId.get(hook.name);
          if (hookId) {
            edges.push(this.createEdge(
              this.generateEdgeId(componentId, hookId, 'uses'),
              componentId,
              hookId,
              'uses',
              'behavioral',
              { hook_name: hook.name }
            ));
          }
        }








        if (hook.hookUsageId && hook.dependencies && hook.dependencies.length > 0) {
          for (const candidateName of hook.dependencies) {
            const bare = candidateName.includes('.') ? candidateName.split('.').pop()! : candidateName;
            const resolved = fetcherTargetIds.get(candidateName) ?? fetcherTargetIds.get(bare);
            if (resolved && resolved !== AMBIGUOUS) {
              edges.push(this.createEdge(
                this.generateEdgeId(hook.hookUsageId, resolved, 'calls'),
                hook.hookUsageId,
                resolved,
                'calls',
                'behavioral',
                { hook_name: hook.name, resolution: 'fetcher_call_candidate', candidate: candidateName }
              ));
              break;
            }
          }
        }
      });

      component.renderedComponents.forEach(rendered => {
        const childComponent = this.bindingResolver.resolveRenderedComponent(component, rendered, components);
        const childComponentId = childComponent ? this.generateId('component', childComponent.filePath, childComponent.name) : undefined;
        if (childComponentId) {
          edges.push(this.createEdge(
            rendersEdgeId(componentId, childComponentId),
            componentId,
            childComponentId,
            'renders',
            'structural',
            {
              jsx_line: rendered.line,
              props_passed: rendered.props,
              composition_type: 'jsx'
            }
          ));
        }
      });







      const componentEntryIds = new Set<string>();
      (component.eventHandlers || []).forEach(handler => {
        const entryId = this.generateId('event_entry', component.filePath, `${component.name}_${handler.event}_${handler.line}_${handler.column}`);
        if (componentEntryIds.has(entryId)) throw new Error(`Duplicate React JSX event identity: ${entryId}`);
        componentEntryIds.add(entryId);
        const handlerReferences = [...new Set([handler.handlerName, ...handler.handlerCallees].filter((value): value is string => Boolean(value)))]
          .map(name => {
            const localBindingNodeId = this.bindingResolver.resolveReactHandlerBinding(component, name, declarationNodes);
            const propBinding = localBindingNodeId ? undefined : this.bindingResolver.resolveReactPropBinding(component, name, components, declarationNodes);
            return {
              name,
              kind: handler.handlerName === name ? 'direct' : 'inline-callee',
              binding_node_id: localBindingNodeId || propBinding?.bindingNodeId,
              binding_origin_component_id: propBinding?.originComponentId,
              binding_component_path: propBinding?.componentPath,
              binding_reference_name: propBinding?.bindingName || name,
            };
          });
        const handlerBindingNodeIds = handlerReferences.map(reference => reference.binding_node_id).filter((value): value is string => Boolean(value));
        const localSupportBindings = handler.localSupportCallees.map(name => {
          const matching = component.handlerBindings.filter(binding => binding.names.includes(name));
          return matching.length === 1
            ? { name, id: this.generateId('react_handler_binding', component.filePath, component.name + '_' + matching[0].line) }
            : undefined;
        }).filter((value): value is { name: string; id: string } => Boolean(value));
        const localSupportBindingNodeIds = localSupportBindings.length === handler.localSupportCallees.length
          ? localSupportBindings.map(binding => binding.id)
          : [];
        const stateTargetBindings = component.handlerBindings.filter(binding =>
          binding.kind === 'state-setter' && binding.names.some(name => handler.handlerStateTargets.includes(name)))
          .map(binding => ({ names: binding.names, id: this.generateId('react_handler_binding', component.filePath, component.name + '_' + binding.line) }));
        const callbackOrigins = [...new Set(handlerReferences.map(reference => reference.binding_origin_component_id).filter((value): value is string => Boolean(value)))];
        const callbackPaths = handlerReferences.map(reference => reference.binding_component_path).filter((value): value is string[] => Array.isArray(value));
        const callbackOriginComponentId = callbackOrigins.length === 1 ? callbackOrigins[0] : undefined;
        const callbackComponentPath = callbackPaths.length > 0 && callbackPaths.every(path => path.join('>') === callbackPaths[0].join('>')) ? callbackPaths[0] : undefined;
        entryPoints.push(this.createEntryPoint(
          'entry_' + entryId,
          componentId,
          'event',
          component.name + ' ' + handler.event,
          'User ' + handler.event + ' event on ' + component.name + (handler.handlerName ? ', handled by ' + handler.handlerName : ''),
          { pattern: handler.event },
          undefined,
          {
            component: component.name,
            event: handler.event,
            handler_name: handler.handlerName,
            handler_references: handlerReferences,
            handler_binding_node_ids: handlerBindingNodeIds,
            handler_component_id: componentId,
            handler_file: component.filePath,
            local_handler_kind: handler.localHandlerKind,
            local_support_callee_names: localSupportBindingNodeIds.length > 0 ? localSupportBindings.map(binding => binding.name) : undefined,
            local_support_binding_node_ids: localSupportBindingNodeIds.length > 0 ? localSupportBindingNodeIds : undefined,
            callback_origin_component_id: callbackOriginComponentId,
            callback_component_path: callbackComponentPath,
            jsx_element: handler.jsxElement,
            interaction_label: handler.interactionLabel,
            handler_state_target_names: handler.handlerStateTargets.length > 0 ? handler.handlerStateTargets : undefined,
            handler_state_target_binding_node_ids: stateTargetBindings.length > 0 ? stateTargetBindings.map(binding => binding.id) : undefined,
            binding_kind: callbackOriginComponentId ? 'component-callback-prop' : 'event-handler',
            jsx_line: handler.line,
            jsx_column: handler.column,
          }
        ));

        const referencesByBinding = new Map<string, typeof handlerReferences>();
        for (const reference of handlerReferences.filter(reference => Boolean(reference.binding_node_id))) {
          const bindingNodeId = reference.binding_node_id!;
          referencesByBinding.set(bindingNodeId, [...(referencesByBinding.get(bindingNodeId) || []), reference]);
        }
        for (const [bindingNodeId, references] of referencesByBinding) {
          edges.push(this.createEdge(
            this.generateEdgeId(entryId, bindingNodeId, 'triggers'),
            'entry_' + entryId,
            bindingNodeId,
            'triggers',
            'behavioral',
            { event: handler.event, source_component: component.name, handler_reference: references[0].name, handler_references: references.map(reference => reference.name) }
          ));
        }
        if (handlerReferences.length === 1 && handlerReferences[0].binding_node_id) {
          for (const binding of stateTargetBindings) {
            const edgeId = this.generateEdgeId(handlerReferences[0].binding_node_id, binding.id, 'calls');
            if (!edges.some(edge => edge.id === edgeId)) {
              edges.push(this.createEdge(edgeId, handlerReferences[0].binding_node_id, binding.id, 'calls', 'behavioral',
                { resolution: 'exact-handler-state-write', binding_names: binding.names }));
            }
          }
        }
        if (handlerReferences.length === 1 && handlerReferences[0].binding_node_id && localSupportBindingNodeIds.length > 0) {
          for (const binding of localSupportBindings) {
            const edgeId = this.generateEdgeId(handlerReferences[0].binding_node_id, binding.id, 'calls');
            if (!edges.some(edge => edge.id === edgeId)) {
              edges.push(this.createEdge(edgeId, handlerReferences[0].binding_node_id, binding.id, 'calls', 'behavioral',
                { source_component: component.name, handler_reference: binding.name }));
            }
          }
        }
      });
    });

    routes.forEach(route => {
      const routeId = route.nodeId;
      const componentId = componentNameToId.get(route.component);
      if (!routeId || !componentId) return;

      edges.push(this.createEdge(
        rendersEdgeId(routeId, componentId),
        routeId,
        componentId,
        'renders',
        'structural',
        { route_path: route.path }
      ));
    });

    pages.forEach(page => {
      const pageId = this.generateId('page', page.filePath, page.name);
      const componentId = componentNameToId.get(page.component);
      if (!componentId) return;

      edges.push(this.createEdge(
        this.generateEdgeId(pageId, componentId, 'implements'),
        pageId,
        componentId,
        'implements',
        'structural',
        { page_route: page.route }
      ));
    });
    this.linkApplicationRoots(nodes, edges);
  }

  private linkApplicationRoots(nodes: CASNode[], edges: CASEdge[]): void {
    const application = nodes.find(node => node.type === 'react_app');
    if (!application) return;
    const entryFile = String(application.metadata?.attributes?.entry_point || '').replace(/^\.\//, '');
    const entryNodes = entryFile
      ? nodes.filter(node => node.id !== application.id && node.source?.file?.replace(/^\.\//, '') === entryFile)
      : [];
    const pages = nodes.filter(node => node.type === 'react_page');
    const routes = nodes.filter(node => node.type === 'react_route');
    const components = nodes.filter(node => node.type === 'functional_component' || node.type === 'class_component');
    const incoming = new Set(edges.filter(edge => edge.type === 'renders' || edge.type === 'implements').map(edge => edge.target));
    const componentRoots = components.filter(node => !incoming.has(node.id));
    const roots = entryNodes.length ? entryNodes : pages.length ? pages : routes.length ? routes : componentRoots;
    for (const root of roots) {
      if (root.id === application.id || edges.some(edge => edge.source === application.id && edge.target === root.id)) continue;
      edges.push(this.createEdge(
        this.generateEdgeId(application.id, root.id, 'contains'),
        application.id,
        root.id,
        'contains',
        'structural',
        { resolution: entryNodes.length ? 'application-entry-file' : 'application-root' }
      ));
    }
  }

  private computeComponentMetrics(
    components: ReactComponent[],
    nodes: CASNode[],
    _edges: CASEdge[]
  ): void {
    const componentNameToId = new Map<string, string>();
    const componentIdToName = new Map<string, string>();
    components.forEach(component => {
      const componentId = this.generateId('component', component.filePath, component.name);
      componentNameToId.set(component.name, componentId);
      componentIdToName.set(componentId, component.name);
    });

    const usageCount = new Map<string, number>();
    const usageLocations = new Map<string, string[]>();
    const childCount = new Map<string, number>();

    components.forEach(component => {
      const parentId = componentNameToId.get(component.name);
      if (!parentId) return;

      childCount.set(parentId, component.renderedComponents.length);

      component.renderedComponents.forEach(rendered => {
        const childId = componentNameToId.get(rendered.name);
        if (childId) {
          usageCount.set(childId, (usageCount.get(childId) || 0) + 1);
          const locations = usageLocations.get(childId) || [];
          locations.push(component.name);
          usageLocations.set(childId, locations);
        }
      });
    });

    nodes.forEach(node => {
      if (node.type === 'functional_component' || node.type === 'class_component') {
        const count = usageCount.get(node.id) || 0;
        const locations = usageLocations.get(node.id) || [];
        const children = childCount.get(node.id) || 0;

        if (!node.metadata) {
          node.metadata = {};
        }
        if (!node.metadata.attributes) {
          node.metadata.attributes = {};
        }

        node.metadata.attributes.usage_count = count;
        node.metadata.attributes.usage_locations = locations;
        node.metadata.attributes.rendered_components_count = children;
        node.metadata.attributes.is_leaf = children === 0;
        node.metadata.attributes.is_shared = count >= 2;
        node.metadata.attributes.is_highly_shared = count >= 5;
      }
    });
  }

  private identifyAPIConnections(components: ReactComponent[], hooks: ReactHook[], nodes: CASNode[], exitPoints: CASExitPoint[]): void {
    const hasAPIConnection = components.some(c =>
      c.imports.some(imp => imp.includes('axios') || imp.includes('fetch')) ||
      c.hooks.some(h => h.name.includes('fetch') || h.name.includes('api'))
    ) || hooks.some(h =>
      h.name.includes('fetch') || h.name.includes('api') || h.name.includes('query')
    );

    if (hasAPIConnection) {
      const sourceNode = nodes.find(node => node.type === 'react_app')?.id ||
        nodes.find(node => node.type === 'functional_component' || node.type === 'class_component')?.id;
      if (!sourceNode) return;

      exitPoints.push(this.createExitPoint(
        'exit_react_api',
        sourceNode,
        'api',
        'API Connection',
        'External API connections from React components',
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
          components: components.filter(c =>
            c.imports.some(imp => imp.includes('axios') || imp.includes('fetch'))
          ).map(c => c.name)
        }
      ));
    }
  }

  private createPerspectives(perspectives: CASPerspective[]): void {
    perspectives.push({
      id: 'react-components',
      name: 'React Component Hierarchy',
      description: 'Component tree showing App → Pages → Components structure',
      analyzer_id: this.analyzerId,
      type: 'structure',
      connection_rules: {
        visible_node_types: ['react_app', 'react_page', 'functional_component', 'class_component'],
        relevant_edge_types: ['contains', 'renders', 'imports'],
        node_connections: [
          {
            from_type: 'react_app',
            to_types: ['react_page'],
            edge_type: 'contains'
          },
          {
            from_type: 'react_page',
            to_types: ['functional_component', 'class_component'],
            edge_type: 'renders'
          },
          {
            from_type: 'functional_component',
            to_types: ['functional_component', 'class_component'],
            edge_type: 'imports'
          }
        ]
      },
      layout_hints: {
        style: 'hierarchical',
        direction: 'TB',
        group_by: 'category'
      },
      metadata: {
        show_props: true,
        show_state: true
      }
    });

    perspectives.push({
      id: 'react-data',
      name: 'React Data Flow',
      description: 'Data flow showing Stores → Providers → Hooks → Components',
      analyzer_id: this.analyzerId,
      type: 'flow',
      connection_rules: {
        visible_node_types: ['redux_store', 'zustand_store', 'react_context', 'custom_hook', 'functional_component', 'class_component'],
        relevant_edge_types: ['provides', 'consumes', 'uses'],
        node_connections: [
          {
            from_type: 'redux_store',
            to_types: ['functional_component', 'class_component'],
            edge_type: 'provides'
          },
          {
            from_type: 'react_context',
            to_types: ['functional_component', 'class_component'],
            edge_type: 'provides'
          },
          {
            from_type: 'custom_hook',
            to_types: ['functional_component'],
            edge_type: 'provides'
          }
        ]
      },
      layout_hints: {
        style: 'force',
        group_by: 'data_type'
      },
      metadata: {
        highlight_state_flow: true,
        show_data_types: true
      }
    });

    perspectives.push({
      id: 'react-routing',
      name: 'React Navigation Structure',
      description: 'Navigation structure showing Routes → Pages → Layouts',
      analyzer_id: this.analyzerId,
      type: 'structure',
      connection_rules: {
        visible_node_types: ['react_route', 'react_page', 'functional_component'],
        relevant_edge_types: ['renders', 'navigates_to'],
        node_connections: [
          {
            from_type: 'react_route',
            to_types: ['react_page'],
            edge_type: 'renders'
          },
          {
            from_type: 'react_page',
            to_types: ['functional_component'],
            edge_type: 'renders'
          }
        ]
      },
      layout_hints: {
        style: 'hierarchical',
        direction: 'LR',
        group_by: 'route_level'
      },
      metadata: {
        show_route_guards: true,
        show_lazy_loading: true
      }
    });
  }

  private tagNodesWithPerspectives(nodes: CASNode[], edges: CASEdge[]): void {
    nodes.forEach(node => {
      if (!node || typeof node !== 'object') return;

      if (!node.perspectives) {
        node.perspectives = {};
      }

      if (node.type === 'react_app' || node.type === 'react_page' ||
          node.type === 'functional_component' || node.type === 'class_component') {
        node.perspectives['react-components'] = {
          hierarchy: ['react', 'components'],
          level: node.level || 1,
          priority: 1
        };
      }

      if (node.type === 'redux_store' || node.type === 'zustand_store' ||
          node.type === 'react_context' || node.type === 'custom_hook' ||
          node.type === 'functional_component' || node.type === 'class_component') {
        node.perspectives['react-data'] = {
          hierarchy: ['react', 'data'],
          level: node.level || 1,
          priority: 2
        };
      }

      if (node.type === 'react_route' || node.type === 'react_page' ||
          node.type === 'functional_component') {
        node.perspectives['react-routing'] = {
          hierarchy: ['react', 'routing'],
          level: node.level || 1,
          priority: 3
        };
      }

      if (!node.metadata) {
        node.metadata = {};
      }
      node.metadata.perspective_data = {
        'react-components': {
          component_type: node.type,
          hierarchy_level: this.getHierarchyLevel(node.type),
          has_children: node.children && node.children.length > 0
        },
        'react-data': {
          data_role: this.getDataRole(node.type),
          state_management: node.metadata?.attributes?.store_type || 'none'
        },
        'react-routing': {
          route_type: node.type === 'react_route' ? 'route' : 'component',
          accessibility: 'public'
        }
      };
    });

    edges.forEach(edge => {
      edge.perspectives = [];

      if (edge.type === 'contains' || edge.type === 'renders' || edge.type === 'imports') {
        edge.perspectives.push('react-components');
      }

      if (edge.type === 'provides' || edge.type === 'consumes' || edge.type === 'uses') {
        edge.perspectives.push('react-data');
      }

      if (edge.type === 'renders' || edge.type === 'navigates_to') {
        edge.perspectives.push('react-routing');
      }

      if (!edge.metadata) {
        edge.metadata = {};
      }
      edge.metadata.perspective_data = {
        'react-components': {
          relationship_type: edge.type,
          component_relationship: true
        },
        'react-data': {
          data_flow_direction: edge.type === 'provides' ? 'outbound' : 'inbound',
          is_state_related: true
        },
        'react-routing': {
          navigation_type: edge.type,
          route_relationship: edge.type === 'renders'
        }
      };
    });
  }

  private getHierarchyLevel(nodeType: string): number {
    switch (nodeType) {
      case 'react_app': return 1;
      case 'react_page': return 2;
      case 'functional_component':
      case 'class_component': return 3;
      default: return 4;
    }
  }

  private getDataRole(nodeType: string): string {
    switch (nodeType) {
      case 'redux_store':
      case 'zustand_store': return 'store';
      case 'react_context': return 'provider';
      case 'custom_hook': return 'hook';
      case 'functional_component':
      case 'class_component': return 'consumer';
      default: return 'unknown';
    }
  }

  private extractComponentDocumentation(ast: any, componentName: string, content: string): CASDocumentation | undefined {
    const lines = content.split('\n');
    let componentNode: any = null;

    const findComponent = (node: any): any => {
      if (!node || typeof node !== 'object') return null;

      if (node.type === 'FunctionDeclaration' && node.id?.name === componentName) {
        return node;
      }
      if (node.type === 'VariableDeclarator' && node.id?.name === componentName) {
        return node;
      }
      if (node.type === 'ClassDeclaration' && node.id?.name === componentName) {
        return node;
      }

      for (const key in node) {
        if (typeof node[key] === 'object' && node[key] !== null) {
          if (Array.isArray(node[key])) {
            for (const child of node[key]) {
              const result = findComponent(child);
              if (result) return result;
            }
          } else {
            const result = findComponent(node[key]);
            if (result) return result;
          }
        }
      }
      return null;
    };

    componentNode = findComponent(ast);
    if (!componentNode || !componentNode.loc) return undefined;

    return this.extractJSDocFromNode(componentNode, content, lines);
  }

  private extractHookDocumentation(ast: any, hookName: string, content: string): CASDocumentation | undefined {
    const lines = content.split('\n');
    let hookNode: any = null;

    const findHook = (node: any): any => {
      if (!node || typeof node !== 'object') return null;

      if (node.type === 'FunctionDeclaration' && node.id?.name === hookName) {
        return node;
      }
      if (node.type === 'VariableDeclarator' && node.id?.name === hookName) {
        return node;
      }

      for (const key in node) {
        if (typeof node[key] === 'object' && node[key] !== null) {
          if (Array.isArray(node[key])) {
            for (const child of node[key]) {
              const result = findHook(child);
              if (result) return result;
            }
          } else {
            const result = findHook(node[key]);
            if (result) return result;
          }
        }
      }
      return null;
    };

    hookNode = findHook(ast);
    if (!hookNode || !hookNode.loc) return undefined;

    return this.extractJSDocFromNode(hookNode, content, lines);
  }

  private extractJSDocFromNode(node: any, content: string, lines: string[]): CASDocumentation | undefined {
    if (!node.loc) return undefined;

    const startLine = node.loc.start.line;
    if (startLine <= 1) return undefined;

    const previousLine = lines[startLine - 2];
    if (!previousLine) return undefined;

    const trimmed = previousLine.trim();
    if (!trimmed.endsWith('*/')) return undefined;

    let jsdocStart = -1;
    for (let i = startLine - 2; i >= 0; i--) {
      if (lines[i].includes('/**')) {
        jsdocStart = i;
        break;
      }
    }

    if (jsdocStart === -1) return undefined;

    const jsdocLines = lines.slice(jsdocStart, startLine - 1);
    const raw = jsdocLines.join('\n');

    return this.parseJSDoc(raw, jsdocStart + 1, startLine - 1);
  }

  private parseJSDoc(raw: string, startLine: number, endLine: number): CASDocumentation {
    const doc: CASDocumentation = {
      type: 'jsdoc',
      raw,
      location: { start_line: startLine, end_line: endLine }
    };

    const content = raw.replace(/\/\*\*|\*\/|\*\s?/g, '').trim();
    const lines = content.split('\n').map(line => line.trim()).filter(line => line);

    let currentSection = 'description';
    let description = '';
    const parameters: Array<{ name: string; type?: string; description?: string; optional?: boolean }> = [];
    const tags: Array<{ tag: string; value: string }> = [];
    let returns: { type?: string; description?: string } | undefined;

    for (const line of lines) {
      if (line.startsWith('@')) {
        const tagMatch = line.match(/^@(\w+)\s*(.*)/);
        if (tagMatch) {
          const [, tag, value] = tagMatch;

          if (tag === 'param') {
            const paramMatch = value.match(/^\{([^}]+)\}\s*(\[?(\w+)\]?)\s*(.*)/);
            if (paramMatch) {
              const [, type, , name, desc] = paramMatch;
              parameters.push({
                name: name,
                type: type,
                description: desc,
                optional: value.includes('[') && value.includes(']')
              });
            }
          } else if (tag === 'returns' || tag === 'return') {
            const returnMatch = value.match(/^\{([^}]+)\}\s*(.*)/);
            if (returnMatch) {
              const [, type, desc] = returnMatch;
              returns = { type, description: desc };
            }
          } else {
            tags.push({ tag, value });
          }
          currentSection = tag;
        }
      } else if (currentSection === 'description') {
        description += (description ? ' ' : '') + line;
      }
    }

    if (description) {
      const sentences = description.split('.').filter(s => s.trim());
      doc.summary = sentences[0]?.trim();
      doc.description = description;
    }

    if (parameters.length > 0) {
      doc.parameters = parameters;
    }

    if (returns) {
      doc.returns = returns;
    }

    if (tags.length > 0) {
      doc.tags = tags;
    }

    return doc;
  }

  private extractCommentsFromContent(content: string, filePath: string): CASComment[] {
    const comments: CASComment[] = [];
    let commentSeq = 0;
    const lines = content.split('\n');

    lines.forEach((line, index) => {
      const singleLineMatch = line.match(/\/\/(.*)$/);
      if (singleLineMatch) {
        const text = singleLineMatch[1].trim();
        const purpose = this.classifyCommentPurpose(text);

        comments.push({
          id: `comment_${filePath}_${++commentSeq}`,
          type: 'single-line',
          style: '//',
          text,
          purpose,
          location: {
            file: filePath,
            line: index + 1,
            relative_to: 'above'
          },
          markers: this.extractCommentMarkers(text)
        });
      }

      const jsxCommentMatch = line.match(/\{\s*\/\*\s*(.*?)\s*\*\/\s*\}/);
      if (jsxCommentMatch) {
        const text = jsxCommentMatch[1].trim();
        const purpose = this.classifyCommentPurpose(text);

        comments.push({
          id: `comment_${filePath}_${++commentSeq}`,
          type: 'inline',
          style: '/* */',
          text,
          purpose,
          location: {
            file: filePath,
            line: index + 1,
            relative_to: 'inline'
          },
          markers: this.extractCommentMarkers(text)
        });
      }
    });

    const multiLineRegex = /\/\*\*([\s\S]*?)\*\//g;
    let match;
    while ((match = multiLineRegex.exec(content)) !== null) {
      const text = match[1].replace(/^\s*\*\s?/gm, '').trim();
      const startIndex = match.index;
      const lineNumber = this.sourceLineForIndex(content, startIndex);

      if (!text.startsWith('@')) {
        comments.push({
          id: `comment_${filePath}_${++commentSeq}`,
          type: 'multi-line',
          style: '/* */',
          text,
          purpose: this.classifyCommentPurpose(text),
          location: {
            file: filePath,
            line: lineNumber,
            relative_to: 'above'
          },
          markers: this.extractCommentMarkers(text)
        });
      }
    }

    return comments;
  }

  private extractTodosFromContent(content: string, filePath: string, context?: string): CASTodo[] {
    const todos: CASTodo[] = [];
    let todoSeq = 0;
    const lines = content.split('\n');

    lines.forEach((line, index) => {
      const todoMatch = line.match(/\b(TODO|FIXME|HACK|NOTE|WARNING|XXX|OPTIMIZE|REFACTOR)\b[:\s]*(.*)/i);
      if (todoMatch) {
        const [, type, text] = todoMatch;
        const priority = this.determineTodoPriority(type.toUpperCase(), text);

        todos.push({
          id: `todo_${filePath}_${++todoSeq}`,
          type: type.toUpperCase() as CASTodo['type'],
          text: text.trim(),
          priority,
          location: {
            file: filePath,
            line: index + 1
          },
          context: context ? { function_name: context } : undefined,
          classification: {
            category: this.classifyTodoCategory(text),
            technical_debt: type.toUpperCase() === 'FIXME' || type.toUpperCase() === 'HACK'
          }
        });
      }

      if (line.includes('return <div>TODO</div>') || line.includes('return <div>FIXME</div>')) {
        todos.push({
          id: `todo_${filePath}_${++todoSeq}`,
          type: 'TODO',
          text: 'Stub component implementation',
          priority: 'high',
          location: {
            file: filePath,
            line: index + 1
          },
          context: context ? { function_name: context } : undefined,
          classification: {
            category: 'feature',
            technical_debt: true
          }
        });
      }
    });

    return todos;
  }

  private detectReactImplementationStatus(ast: any, componentName: string, content: string): CASImplementationStatus | undefined {
    let componentNode: any = null;

    const findComponent = (node: any): any => {
      if (!node || typeof node !== 'object') return null;

      if (node.type === 'FunctionDeclaration' && node.id?.name === componentName) {
        return node;
      }
      if (node.type === 'VariableDeclarator' && node.id?.name === componentName) {
        return node;
      }
      if (node.type === 'ClassDeclaration' && node.id?.name === componentName) {
        return node;
      }

      for (const key in node) {
        if (typeof node[key] === 'object' && node[key] !== null) {
          if (Array.isArray(node[key])) {
            for (const child of node[key]) {
              const result = findComponent(child);
              if (result) return result;
            }
          } else {
            const result = findComponent(node[key]);
            if (result) return result;
          }
        }
      }
      return null;
    };

    componentNode = findComponent(ast);
    if (!componentNode) return undefined;

    const nodeStart = componentNode.range?.[0] || 0;
    const nodeEnd = componentNode.range?.[1] || content.length;
    const bodyStr = content.substring(nodeStart, nodeEnd);

    const indicators = {
      has_todo_markers: /\b(TODO|FIXME|HACK)\b/i.test(bodyStr),
      has_not_implemented_exceptions: /throw\s+.*(NotImplemented|Unsupported|TODO)/i.test(bodyStr),
      has_stub_returns: /return\s*<div>TODO<\/div>|return\s*<div>FIXME<\/div>|return\s*null\s*;?\s*$/m.test(bodyStr),
      has_placeholder_code: /console\.(log|warn|error)\s*\(['"].*TODO/i.test(bodyStr),
      has_hardcoded_values: /const\s+\w+\s*=\s*['"]PLACEHOLDER|TEMP|TODO/i.test(bodyStr),
      has_commented_out_code: /\/\/.*\w+\s*\(|^\/\*[\s\S]*?\*\//m.test(bodyStr)
    };

    const hasImplementation = bodyStr.trim().length > 50 &&
                            !bodyStr.includes('return <div>TODO</div>') &&
                            !bodyStr.includes('return null;');

    let status: CASImplementationStatus['status'] = 'complete';

    if (!hasImplementation || bodyStr.includes('return <div>TODO</div>')) {
      status = 'stub';
    } else if (indicators.has_not_implemented_exceptions) {
      status = 'not-implemented';
    } else if (indicators.has_todo_markers || indicators.has_placeholder_code) {
      status = 'partial';
    } else if (bodyStr.includes('@deprecated') || content.includes('@deprecated')) {
      status = 'deprecated';
    } else if (bodyStr.includes('@experimental') || content.includes('@experimental')) {
      status = 'experimental';
    }

    return {
      status,
      indicators,
      completeness: {
        estimated_percentage: status === 'complete' ? 100 :
                             status === 'partial' ? 60 :
                             status === 'stub' ? 10 : 0,
        missing_features: indicators.has_not_implemented_exceptions ? ['Not implemented'] : undefined
      }
    };
  }

  private classifyCommentPurpose(text: string): CASComment['purpose'] {
    const lower = text.toLowerCase();

    if (/\b(todo|fixme|hack|xxx)\b/i.test(text)) return 'todo';
    if (/\b(warning|danger|caution|important)\b/i.test(text)) return 'warning';
    if (/\b(note|info|tip)\b/i.test(text)) return 'note';
    if (/eslint-disable|prettier-ignore|@ts-ignore/i.test(text)) return 'disabled-code';
    if (text.includes('?') && text.length < 100) return 'clarification';
    if (lower.includes('hack') || lower.includes('workaround')) return 'hack';

    return 'explanation';
  }

  private extractCommentMarkers(text: string): CASComment['markers'] {
    return {
      is_todo: /\btodo\b/i.test(text),
      is_fixme: /\bfixme\b/i.test(text),
      is_hack: /\bhack\b/i.test(text),
      is_warning: /\b(warning|danger|caution)\b/i.test(text),
      is_note: /\b(note|info|tip)\b/i.test(text),
      is_question: text.includes('?'),
      is_important: /\b(important|critical)\b/i.test(text),
      custom_markers: this.extractCustomMarkers(text)
    };
  }

  private extractCustomMarkers(text: string): string[] {
    const markers: string[] = [];
    const customMarkerRegex = /@(\w+)/g;
    let match;

    while ((match = customMarkerRegex.exec(text)) !== null) {
      markers.push(match[1]);
    }

    return markers;
  }

  private determineTodoPriority(type: string, text: string): CASTodo['priority'] {
    if (type === 'FIXME' || type === 'HACK' || text.toLowerCase().includes('urgent')) {
      return 'high';
    }
    if (type === 'WARNING' || text.toLowerCase().includes('important')) {
      return 'medium';
    }
    return 'low';
  }

  private classifyTodoCategory(text: string): 'bug' | 'feature' | 'refactor' | 'performance' | 'security' | 'documentation' | 'test' {
    const lower = text.toLowerCase();

    if (lower.includes('bug') || lower.includes('fix') || lower.includes('error')) {
      return 'bug';
    }
    if (lower.includes('feature') || lower.includes('implement') || lower.includes('add')) {
      return 'feature';
    }
    if (lower.includes('refactor') || lower.includes('clean') || lower.includes('improve')) {
      return 'refactor';
    }
    if (lower.includes('performance') || lower.includes('optimize') || lower.includes('speed')) {
      return 'performance';
    }
    if (lower.includes('security') || lower.includes('auth') || lower.includes('permission')) {
      return 'security';
    }
    if (lower.includes('doc') || lower.includes('comment') || lower.includes('explain')) {
      return 'documentation';
    }
    if (lower.includes('test') || lower.includes('spec') || lower.includes('coverage')) {
      return 'test';
    }

    return 'refactor';
  }

  private extractDefaultValue(node: any): string | undefined {
    if (!node) return undefined;

    switch (node.type) {
      case 'Literal':
        return String(node.value);
      case 'StringLiteral':
        return `"${node.value}"`;
      case 'NumericLiteral':
        return String(node.value);
      case 'BooleanLiteral':
        return String(node.value);
      case 'NullLiteral':
        return 'null';
      case 'Identifier':
        return node.name;
      case 'ArrayExpression':
        return '[]';
      case 'ObjectExpression':
        return '{}';
      default:
        return undefined;
    }
  }

  private mapTypeAnnotationToString(typeNode: string | any): string {
    if (typeof typeNode === 'string') {
      return typeNode;
    }

    if (!typeNode) return 'any';

    switch (typeNode) {
      case 'TSStringKeyword':
        return 'string';
      case 'TSNumberKeyword':
        return 'number';
      case 'TSBooleanKeyword':
        return 'boolean';
      case 'TSArrayType':
        return 'array';
      case 'TSObjectKeyword':
        return 'object';
      case 'TSFunctionType':
        return 'function';
      default:
        return 'any';
    }
  }

  private shouldParseJsx(filePath: string, content?: string): boolean {
    if (/\.(jsx|tsx)$/i.test(filePath)) return true;
    if (/\.js$/i.test(filePath) && content) {
      return this.containsJsxSyntax(content);
    }
    return false;
  }
}
