import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint,
  CASDocumentation, CASComment, CASTodo, CASImplementationStatus, CASPerspective
} from "../../../types/cas.types";
import { AnalyzerError } from '../../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';
import { cachedEstreeParse as parse } from '../../core/estree-parse-cache';

interface VueApplication {
  name: string;
  entryPoint: string;
  type: 'vue2' | 'vue3' | 'nuxt' | 'quasar' | 'custom';
  typescript: boolean;
  router: string | null;
  stateManagement: string[];
  testing: string[];
  buildTool: string;
}

interface VueComponent {
  name: string;
  filePath: string;
  type: 'sfc' | 'class' | 'functional';
  hasTemplate: boolean;
  hasScript: boolean;
  hasStyle: boolean;
  props: Array<{ name: string; type: string; required: boolean; defaultValue?: string }>;
  data: Array<{ name: string; type: string; initialValue?: string }>;
  computed: Array<{ name: string; dependencies: string[] }>;
  methods: Array<{ name: string; parameters: any[]; returnType?: string }>;
  watchers: Array<{ name: string; watched: string; deep?: boolean }>;
  lifecycle: string[];
  mixins: string[];
  imports: string[];
  exports: string[];
  slots: string[];
  emits: string[];
  /** Child components used in this component's <template> (the render tree). */
  childComponents: string[];
  /** `@click="handler"` / `v-on:click="handler(...)"` bindings in the <template>. */
  eventHandlers: Array<{ event: string; handlerName?: string }>;
}

interface VueComposable {
  name: string;
  filePath: string;
  type: 'composable';
  parameters: Array<{ name: string; type: string; defaultValue?: string }>;
  returnType: string;
  dependencies: string[];
  reactive: string[];
  refs: string[];
}

interface VueStore {
  name: string;
  filePath: string;
  type: 'vuex' | 'pinia' | 'custom';
  state: Array<{ name: string; type: string; initialValue?: any }>;
  getters: Array<{ name: string; returnType: string }>;
  mutations: Array<{ name: string; payload?: string }>;
  actions: Array<{ name: string; payload?: string; async: boolean }>;
  modules: string[];
}

interface VueRoute {
  path: string;
  name?: string;
  component: string;
  children?: VueRoute[];
  meta?: Record<string, any>;
  beforeEnter?: string;
  props?: boolean | Record<string, any>;
}

interface VueDirective {
  name: string;
  filePath: string;
  bind?: boolean;
  inserted?: boolean;
  update?: boolean;
  componentUpdated?: boolean;
  unbind?: boolean;
}

interface VuePlugin {
  name: string;
  filePath: string;
  install: boolean;
  dependencies: string[];
}

export class VueAnalyzer extends BaseAnalyzer {

  constructor() {
    super(
      'vue',
      'Vue.js Framework Analyzer',
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

      if (Object.keys(deps).some(dep => dep === 'vue' || dep === '@vue/cli' || dep === 'nuxt')) {
        return true;
      }

      const vueFiles = await glob(['**/*.vue', '**/*.js', '**/*.ts'], {
        cwd: projectPath,
        ignore: [...this.getIgnorePatterns({ projectPath }), '**/src/analyzer/**', '**/analyzer/**', '**/analyzers/**'],
        nodir: true
      });

      for (const file of vueFiles) {
        const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
        if (content.includes('from vue') || content.includes('import Vue') || content.includes('<template>')) {
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
      const ignorePatterns = this.getIgnorePatterns(context);
      const vueFiles = this.capAndPrioritizeSourceFiles(await glob(['**/*.{vue,ts,js}'], {
        cwd: context.projectPath,
        ignore: [...ignorePatterns, '**/*.test.*', '**/*.spec.*'],
        nodir: true
      }), 'Vue source files');

      const application = await this.analyzeApplication(context.projectPath, nodes);
      const components = await this.analyzeComponents(vueFiles, context.projectPath, nodes, edges, entryPoints);
      const composables = await this.analyzeComposables(vueFiles, context.projectPath, nodes, edges);
      const stores = await this.analyzeStores(vueFiles, context.projectPath, nodes, edges);
      const routes = await this.analyzeRoutes(vueFiles, context.projectPath, nodes, edges, entryPoints);
      const directives = await this.analyzeDirectives(vueFiles, context.projectPath, nodes, edges);
      const plugins = await this.analyzePlugins(vueFiles, context.projectPath, nodes, edges);

      this.buildVueRelationships(components, composables, stores, routes, directives, plugins, nodes, edges);
      this.identifyAPIConnections(components, composables, exitPoints);

      this.tagNodesWithPerspectives(nodes, edges);
      this.createPerspectives(perspectives);

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework_specific: {
          vue_version: await this.detectVueVersion(context.projectPath),
          typescript: application?.typescript || false,
          application_type: application?.type || 'custom',
          router: application?.router || null,
          state_management: application?.stateManagement || [],
          components_detected: components.length,
          composables_detected: composables.length,
          stores_detected: stores.length,
          routes_detected: routes.length,
          directives_detected: directives.length,
          plugins_detected: plugins.length
        },
        perspectives,
        provided_perspectives: perspectives.map(p => p.id)
      });

    } catch (error) {
      throw new AnalyzerError(
        `Vue analysis failed: ${(error as Error).message}`,
        'VUE_ANALYSIS_ERROR'
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
      'sfc-analysis',
      'composition-api-detection',
      'template-parsing',
      'reactive-tracking',
      'router-mapping',
      'state-management-detection',
      'directive-analysis',
      'plugin-detection'
    ];
  }

  private async analyzeApplication(projectPath: string, nodes: CASNode[]): Promise<VueApplication | null> {
    try {
      const packageJson = await fs.readJson(path.join(projectPath, 'package.json'));
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };

      const typescript = Object.keys(deps).includes('typescript') ||
                        await fs.pathExists(path.join(projectPath, 'tsconfig.json'));

      let type: 'vue2' | 'vue3' | 'nuxt' | 'quasar' | 'custom' = 'custom';
      if (Object.keys(deps).includes('nuxt')) type = 'nuxt';
      else if (Object.keys(deps).includes('quasar')) type = 'quasar';
      else if (deps.vue?.startsWith('3') || deps.vue?.startsWith('^3')) type = 'vue3';
      else if (deps.vue?.startsWith('2') || deps.vue?.startsWith('^2')) type = 'vue2';

      const router = this.detectRouter(deps);
      const stateManagement = this.detectStateManagement(deps);
      const testing = this.detectTestingFrameworks(deps);
      const buildTool = this.detectBuildTool(deps, projectPath);

      const entryPoint = await this.findEntryPoint(projectPath, type);

      const application: VueApplication = {
        name: packageJson.name || 'vue-app',
        entryPoint,
        type,
        typescript,
        router,
        stateManagement,
        testing,
        buildTool
      };

      const appId = this.generateId('app', path.join(projectPath, 'package.json'), application.name);
      const documentation = this.extractDocumentation('', path.join(projectPath, 'package.json'));
      const comments = this.extractComments('', path.join(projectPath, 'package.json'));
      const todos = this.extractTodos(comments);
      const implementationStatus = this.determineImplementationStatus('', comments);

      const appNode = this.createNodeBuilder(appId, application.name, 'vue_app')
        .withLevel(1, 'system')
        .withCategory('frontend', ['vue', 'application'])
        .withSource({ file: path.join(projectPath, 'package.json'), line: 1, end_line: 1 })
        .withDescription(`Vue.js application: ${application.name}`)
        .withDocumentation(documentation)
        .withComments(comments)
        .withTodos(todos)
        .withImplementationStatus(implementationStatus)
        .withMetadata({
          framework: 'vue',
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
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): Promise<VueComponent[]> {
    const components: VueComponent[] = [];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (this.isVueComponent(content, file)) {
        try {
          const component = this.extractVueComponent(content, file);
          if (component) {
            components.push(component);

            const componentId = this.generateId('component', component.filePath, component.name);
            const componentNode = this.createNodeBuilder(componentId, component.name, 'vue_component')
              .withLevel(2, 'architectural')
              .withCategory('component', ['vue', component.type])
              .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
              .withDescription(`Vue ${component.type} component: ${component.name}`)
              .withMetadata({
                framework: 'vue',
                attributes: {
                  component_type: component.type,
                  has_template: component.hasTemplate,
                  has_script: component.hasScript,
                  has_style: component.hasStyle,
                  props_count: component.props.length,
                  data_count: component.data.length,
                  computed_count: component.computed.length,
                  methods_count: component.methods.length,
                  watchers_count: component.watchers.length,
                  lifecycle_count: component.lifecycle.length,
                  mixins_count: component.mixins.length,
                  slots_count: component.slots.length,
                  emits_count: component.emits.length
                }
              })
              .build();
            nodes.push(componentNode);

            component.methods.forEach((method, index) => {
              const methodId = this.generateId('method', component.filePath, `${component.name}_${method.name}`);
              const methodNode = this.createNodeBuilder(methodId, method.name, 'method')
                .withLevel(4, 'member')
                .withCategory('method', ['vue', 'function'])
                .withSource({ file: fullPath, line: 1, end_line: 1 })
                .withDescription(`Method in ${component.name}: ${method.name}`)
                .withParent(componentId)
                .withSignature({
                  parameters: method.parameters.map(p => ({ name: p.name || 'param', type: p.type || 'any' })),
                  return_type: method.returnType
                })
                .withMetadata({
                  framework: 'vue'
                })
                .build();
              nodes.push(methodNode);

              edges.push(this.createEdge(
                this.generateEdgeId(componentId, methodId, 'contains'),
                componentId,
                methodId,
                'contains',
                'structural'
              ));
            });

            component.computed.forEach((computed, index) => {
              const computedId = this.generateId('computed', component.filePath, `${component.name}_${computed.name}`);
              const computedNode = this.createNodeBuilder(computedId, computed.name, 'computed')
                .withLevel(4, 'member')
                .withCategory('computed', ['vue', 'reactive'])
                .withSource({ file: fullPath, line: 1, end_line: 1 })
                .withDescription(`Computed property in ${component.name}: ${computed.name}`)
                .withParent(componentId)
                .withMetadata({
                  framework: 'vue',
                  attributes: {
                    dependencies: computed.dependencies
                  }
                })
                .build();
              nodes.push(computedNode);

              edges.push(this.createEdge(
                this.generateEdgeId(componentId, computedId, 'contains'),
                componentId,
                computedId,
                'contains',
                'structural'
              ));
            });

            // Template event bindings are real flow roots for a frontend app —
            // a user event triggers a method, the same way an HTTP route
            // triggers a controller. Emit an `event` entry point per binding;
            // resolve a `triggers` edge only when the handler name matches a
            // method already declared on this component (evidence-based).
            const methodNames = new Set(component.methods.map(m => m.name));
            component.eventHandlers.forEach((handler, index) => {
              const eventNodeId = this.generateId('event_binding', component.filePath, `${component.name}_${handler.event}_${index}`);
              entryPoints.push(this.createEntryPoint(
                `entry_${eventNodeId}`,
                componentId,
                'event',
                `${component.name} ${handler.event}`,
                `User ${handler.event} event on ${component.name}${handler.handlerName ? `, handled by ${handler.handlerName}` : ''}`,
                { pattern: handler.event },
                undefined,
                { component: component.name, event: handler.event, handler_name: handler.handlerName }
              ));

              if (handler.handlerName && methodNames.has(handler.handlerName)) {
                const methodId = this.generateId('method', component.filePath, `${component.name}_${handler.handlerName}`);
                edges.push(this.createEdge(
                  this.generateEdgeId(eventNodeId, methodId, 'triggers'),
                  eventNodeId,
                  methodId,
                  'triggers',
                  'behavioral',
                  { event: handler.event }
                ));
              }
            });
          }
        } catch (error) {
          console.warn(`Failed to parse Vue component ${file}:`, error);
        }
      }
    }

    // Render tree: link each component to the child components it uses in its
    // <template> (the Camp-C fact that import/structural graphs cannot express —
    // App IMPORTS UserCard, but only Klauro says App RENDERS UserCard).
    const idByName = new Map(
      components.map(c => [c.name, this.generateId('component', c.filePath, c.name)])
    );
    for (const parent of components) {
      const parentId = this.generateId('component', parent.filePath, parent.name);
      for (const child of new Set(parent.childComponents)) {
        const childId = idByName.get(child);
        if (!childId || childId === parentId) continue;
        edges.push(this.createEdge(
          this.generateEdgeId(parentId, childId, 'renders'),
          parentId,
          childId,
          'renders',
          'structural'
        ));
      }
    }

    return components;
  }

  private async analyzeComposables(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<VueComposable[]> {
    const composables: VueComposable[] = [];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (this.isComposable(content)) {
        try {
          const extractedComposables = this.extractComposables(content, file);
          composables.push(...extractedComposables);

          extractedComposables.forEach(composable => {
            const composableId = this.generateId('composable', composable.filePath, composable.name);
            const composableNode = this.createNodeBuilder(composableId, composable.name, 'composable')
              .withLevel(3, 'code')
              .withCategory('composable', ['vue', 'composition-api'])
              .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
              .withDescription(`Vue composable: ${composable.name}`)
              .withSignature({
                parameters: composable.parameters.map(p => ({ name: p.name, type: p.type })),
                return_type: composable.returnType
              })
              .withMetadata({
                framework: 'vue',
                attributes: {
                  parameters_count: composable.parameters.length,
                  dependencies_count: composable.dependencies.length,
                  reactive_count: composable.reactive.length,
                  refs_count: composable.refs.length
                }
              })
              .build();
            nodes.push(composableNode);
          });
        } catch (error) {
          console.warn(`Failed to parse Vue composable ${file}:`, error);
        }
      }
    }

    return composables;
  }

  private async analyzeStores(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<VueStore[]> {
    const stores: VueStore[] = [];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (this.isStoreFile(content)) {
        try {
          const extractedStores = this.extractStores(content, file);
          stores.push(...extractedStores);

          extractedStores.forEach(store => {
            const storeId = this.generateId('store', store.filePath, store.name);
            const storeNode = this.createNodeBuilder(storeId, store.name, `${store.type}_store`)
              .withLevel(3, 'code')
              .withCategory('store', ['vue', store.type, 'state'])
              .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
              .withDescription(`${store.type.charAt(0).toUpperCase() + store.type.slice(1)} store: ${store.name}`)
              .withMetadata({
                framework: 'vue',
                attributes: {
                  store_type: store.type,
                  state_count: store.state.length,
                  getters_count: store.getters.length,
                  mutations_count: store.mutations.length,
                  actions_count: store.actions.length,
                  modules_count: store.modules.length
                }
              })
              .build();
            nodes.push(storeNode);
          });
        } catch (error) {
          console.warn(`Failed to parse Vue store ${file}:`, error);
        }
      }
    }

    return stores;
  }

  private async analyzeRoutes(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): Promise<VueRoute[]> {
    const routes: VueRoute[] = [];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('VueRouter') || content.includes('createRouter') || file.includes('router')) {
        try {
          const extractedRoutes = this.extractRoutes(content, file);
          routes.push(...extractedRoutes);

          extractedRoutes.forEach((route, index) => {
            const routeId = this.generateId('route', file, `${route.path}_${index}`);
            const routeNode = this.createNodeBuilder(routeId, route.path, 'vue_route')
              .withLevel(3, 'code')
              .withCategory('route', ['vue', 'navigation'])
              .withSource({ file: fullPath, line: 1, end_line: 1 })
              .withDescription(`Vue route: ${route.path}`)
              .withMetadata({
                framework: 'vue',
                attributes: {
                  path: route.path,
                  name: route.name,
                  component: route.component,
                  has_children: (route.children?.length || 0) > 0,
                  meta: route.meta,
                  before_enter: route.beforeEnter,
                  props: route.props
                }
              })
              .build();
            nodes.push(routeNode);

            entryPoints.push(this.createEntryPoint(
              `entry_${routeId}`,
              routeId,
              'route',
              `Route ${route.path}`,
              `Vue route mapping to component ${route.component}`,
              {
                path: route.path,
                method: 'GET'
              },
              {
                authenticated: route.meta?.requiresAuth || false,
                authorized_roles: route.meta?.roles || []
              },
              {
                component: route.component,
                name: route.name,
                meta: route.meta
              }
            ));
          });
        } catch (error) {
          console.warn(`Failed to parse Vue routes ${file}:`, error);
        }
      }
    }

    return routes;
  }

  private async analyzeDirectives(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<VueDirective[]> {
    const directives: VueDirective[] = [];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('directive') || content.includes('v-')) {
        try {
          const extractedDirectives = this.extractDirectives(content, file);
          directives.push(...extractedDirectives);

          extractedDirectives.forEach(directive => {
            const directiveId = this.generateId('directive', directive.filePath, directive.name);
            const directiveNode = this.createNodeBuilder(directiveId, directive.name, 'vue_directive')
              .withLevel(3, 'code')
              .withCategory('directive', ['vue', 'dom'])
              .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
              .withDescription(`Vue directive: ${directive.name}`)
              .withMetadata({
                framework: 'vue',
                attributes: {
                  has_bind: directive.bind,
                  has_inserted: directive.inserted,
                  has_update: directive.update,
                  has_component_updated: directive.componentUpdated,
                  has_unbind: directive.unbind
                }
              })
              .build();
            nodes.push(directiveNode);
          });
        } catch (error) {
          console.warn(`Failed to parse Vue directive ${file}:`, error);
        }
      }
    }

    return directives;
  }

  private async analyzePlugins(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<VuePlugin[]> {
    const plugins: VuePlugin[] = [];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('install') && (content.includes('Vue.use') || content.includes('app.use'))) {
        try {
          const extractedPlugins = this.extractPlugins(content, file);
          plugins.push(...extractedPlugins);

          extractedPlugins.forEach(plugin => {
            const pluginId = this.generateId('plugin', plugin.filePath, plugin.name);
            const pluginNode = this.createNodeBuilder(pluginId, plugin.name, 'vue_plugin')
              .withLevel(3, 'code')
              .withCategory('plugin', ['vue', 'extension'])
              .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
              .withDescription(`Vue plugin: ${plugin.name}`)
              .withMetadata({
                framework: 'vue',
                attributes: {
                  has_install: plugin.install,
                  dependencies_count: plugin.dependencies.length
                }
              })
              .build();
            nodes.push(pluginNode);
          });
        } catch (error) {
          console.warn(`Failed to parse Vue plugin ${file}:`, error);
        }
      }
    }

    return plugins;
  }

  private isVueComponent(content: string, filePath: string): boolean {
    return filePath.endsWith('.vue') ||
           content.includes('Vue.component') ||
           content.includes('defineComponent') ||
           content.includes('export default {') && (content.includes('template:') || content.includes('render'));
  }

  private isComposable(content: string): boolean {
    return /function\s+use[A-Z]\w*\s*\(/.test(content) ||
           /const\s+use[A-Z]\w*\s*=/.test(content) ||
           /export.*use[A-Z]\w*/.test(content);
  }

  private isStoreFile(content: string): boolean {
    return content.includes('createStore') ||
           content.includes('new Vuex.Store') ||
           content.includes('defineStore') ||
           content.includes('acceptHMRUpdate');
  }

  private detectRouter(deps: Record<string, any>): string | null {
    if (deps['vue-router']) return 'vue-router';
    if (deps['@nuxt/router']) return 'nuxt-router';
    return null;
  }

  private detectStateManagement(deps: Record<string, any>): string[] {
    const stateManagement: string[] = [];
    if (deps['vuex']) stateManagement.push('vuex');
    if (deps['pinia']) stateManagement.push('pinia');
    if (deps['@pinia/nuxt']) stateManagement.push('pinia');
    return stateManagement;
  }

  private detectTestingFrameworks(deps: Record<string, any>): string[] {
    const testing: string[] = [];
    if (deps['@vue/test-utils']) testing.push('@vue/test-utils');
    if (deps['jest']) testing.push('jest');
    if (deps['cypress']) testing.push('cypress');
    if (deps['playwright']) testing.push('playwright');
    if (deps['vitest']) testing.push('vitest');
    return testing;
  }

  private detectBuildTool(deps: Record<string, any>, projectPath: string): string {
    if (deps['vite']) return 'vite';
    if (deps['@vue/cli']) return 'vue-cli';
    if (deps['nuxt']) return 'nuxt';
    if (deps['quasar']) return 'quasar';
    if (deps['webpack']) return 'webpack';
    return 'unknown';
  }

  private async findEntryPoint(projectPath: string, type: string): Promise<string> {
    const possibleEntryPoints = [
      'src/main.ts',
      'src/main.js',
      'src/index.ts',
      'src/index.js',
      'nuxt.config.ts',
      'nuxt.config.js',
      'quasar.conf.js',
      'index.html'
    ];

    for (const entry of possibleEntryPoints) {
      if (await fs.pathExists(path.join(projectPath, entry))) {
        return entry;
      }
    }

    return 'src/main.js';
  }

  private extractVueComponent(content: string, filePath: string): VueComponent | null {
    const componentName = this.extractComponentName(content, filePath);
    if (!componentName) return null;

    return {
      name: componentName,
      filePath,
      type: filePath.endsWith('.vue') ? 'sfc' : 'functional',
      hasTemplate: content.includes('<template>') || content.includes('template:'),
      hasScript: content.includes('<script>') || content.includes('<script setup>'),
      hasStyle: content.includes('<style>'),
      props: this.extractProps(content),
      data: this.extractData(content),
      computed: this.extractComputed(content),
      methods: this.extractMethods(content),
      watchers: this.extractWatchers(content),
      lifecycle: this.extractLifecycle(content),
      mixins: this.extractMixins(content),
      imports: this.extractImports(content),
      exports: this.extractExports(content),
      slots: this.extractSlots(content),
      emits: this.extractEmits(content),
      childComponents: this.extractChildComponents(content),
      eventHandlers: this.extractTemplateEventHandlers(content)
    };
  }

  /**
   * Vue event bindings (`@click="handler"`, `v-on:click="handler(...)"`,
   * `@click="handler($event)"`) in the <template>. A bare identifier or a bare
   * `methodName(...)` call resolves `handlerName`; a full inline expression is
   * still captured as an event without a fabricated handler target.
   */
  private extractTemplateEventHandlers(content: string): Array<{ event: string; handlerName?: string }> {
    const tpl = /<template>([\s\S]*?)<\/template>/.exec(content);
    if (!tpl) return [];
    const template = tpl[1];
    const handlers: Array<{ event: string; handlerName?: string }> = [];

    const shorthandPattern = /@([\w-]+)(?:\.[\w.]+)?=["']([^"']*)["']/g;
    const longformPattern = /v-on:([\w-]+)(?:\.[\w.]+)?=["']([^"']*)["']/g;

    const collect = (pattern: RegExp) => {
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(template)) !== null) {
        const event = m[1];
        const expr = m[2].trim();
        const bareIdentifier = /^(\w+)$/.exec(expr);
        const call = /^(\w+)\s*\(/.exec(expr);
        const handlerName = bareIdentifier ? bareIdentifier[1] : call ? call[1] : undefined;
        handlers.push({ event, handlerName });
      }
    };
    collect(shorthandPattern);
    collect(longformPattern);

    return handlers;
  }

  /** Child components rendered in the <template>: PascalCase tags (the Vue
   *  convention for components) — distinct from native lowercase HTML elements. */
  private extractChildComponents(content: string): string[] {
    const tpl = /<template>([\s\S]*?)<\/template>/.exec(content);
    if (!tpl) return [];
    const found = new Set<string>();
    for (const m of tpl[1].matchAll(/<([A-Z][A-Za-z0-9_]*)[\s/>]/g)) found.add(m[1]);
    return [...found];
  }

  private extractComposables(content: string, filePath: string): VueComposable[] {
    const composables: VueComposable[] = [];
    const composablePattern = /(?:function|const)\s+(use[A-Z]\w*)/g;

    let match;
    while ((match = composablePattern.exec(content)) !== null) {
      const name = match[1];
      composables.push({
        name,
        filePath,
        type: 'composable',
        parameters: [],
        returnType: 'unknown',
        dependencies: [],
        reactive: this.extractReactive(content),
        refs: this.extractRefs(content)
      });
    }

    return composables;
  }

  private extractStores(content: string, filePath: string): VueStore[] {
    const stores: VueStore[] = [];

    if (content.includes('defineStore') || content.includes('createStore')) {
      const storeName = this.extractStoreName(content, filePath);
      const storeType = content.includes('defineStore') ? 'pinia' : 'vuex';

      stores.push({
        name: storeName,
        filePath,
        type: storeType,
        state: this.extractStoreState(content),
        getters: this.extractStoreGetters(content),
        mutations: this.extractStoreMutations(content),
        actions: this.extractStoreActions(content),
        modules: this.extractStoreModules(content)
      });
    }

    return stores;
  }

  private extractRoutes(content: string, filePath: string): VueRoute[] {
    const routes: VueRoute[] = [];
    const routePattern = /{\s*path:\s*['"`]([^'"`]+)['"`][^}]*component:\s*([^,\s}]+)[^}]*}/g;

    let match;
    while ((match = routePattern.exec(content)) !== null) {
      const path = match[1];
      const component = match[2];

      routes.push({
        path,
        component,
        name: this.extractRouteName(content, path),
        meta: this.extractRouteMeta(content, path)
      });
    }

    return routes;
  }

  private extractDirectives(content: string, filePath: string): VueDirective[] {
    const directives: VueDirective[] = [];
    const directivePattern = /Vue\.directive\(['"`]([^'"`]+)['"`]/g;

    let match;
    while ((match = directivePattern.exec(content)) !== null) {
      const name = match[1];
      directives.push({
        name,
        filePath,
        bind: content.includes('bind:'),
        inserted: content.includes('inserted:'),
        update: content.includes('update:'),
        componentUpdated: content.includes('componentUpdated:'),
        unbind: content.includes('unbind:')
      });
    }

    return directives;
  }

  private extractPlugins(content: string, filePath: string): VuePlugin[] {
    const plugins: VuePlugin[] = [];
    const pluginName = this.extractPluginName(content, filePath);

    if (pluginName) {
      plugins.push({
        name: pluginName,
        filePath,
        install: content.includes('install'),
        dependencies: []
      });
    }

    return plugins;
  }

  private extractComponentName(content: string, filePath: string): string | null {
    const fileName = path.basename(filePath, path.extname(filePath));

    // Only an EXPLICIT component-name option counts — a bare `name:` regex also
    // matches data properties like `const user = { name: 'Ada' }`, so scope it to
    // `defineOptions({ name })` / `export default { name }`. Otherwise the SFC is
    // referenced by its filename (the Vue convention), so default to that.
    const explicit =
      /defineOptions\s*\(\s*\{[^}]*?\bname:\s*['"`]([^'"`]+)['"`]/.exec(content) ||
      /export\s+default\s*\{[^]*?\bname:\s*['"`]([^'"`]+)['"`]/.exec(content);
    return explicit ? explicit[1] : fileName;
  }

  private extractProps(content: string): Array<{ name: string; type: string; required: boolean; defaultValue?: string }> {
    const props: Array<{ name: string; type: string; required: boolean; defaultValue?: string }> = [];
    const propsPattern = /props:\s*\{([^}]+)\}/;
    const match = propsPattern.exec(content);

    if (match) {
      const propsContent = match[1];
      const propPattern = /(\w+):\s*\{[^}]*\}/g;
      let propMatch;

      while ((propMatch = propPattern.exec(propsContent)) !== null) {
        props.push({
          name: propMatch[1],
          type: 'unknown',
          required: propsContent.includes('required: true')
        });
      }
    }

    return props;
  }

  private extractData(content: string): Array<{ name: string; type: string; initialValue?: string }> {
    const data: Array<{ name: string; type: string; initialValue?: string }> = [];

    const dataFunctionPattern = /data\s*\(\s*\)\s*\{?\s*return\s*\{([\s\S]*?)\}\s*;?\s*\}/;
    const dataArrowPattern = /data\s*:\s*\(\s*\)\s*=>\s*\(\s*\{([\s\S]*?)\}\s*\)/;
    const dataObjectPattern = /data\s*:\s*\{([\s\S]*?)\}/;

    let dataContent: string | null = null;
    const fnMatch = dataFunctionPattern.exec(content);
    if (fnMatch) {
      dataContent = fnMatch[1];
    } else {
      const arrowMatch = dataArrowPattern.exec(content);
      if (arrowMatch) {
        dataContent = arrowMatch[1];
      } else {
        const objMatch = dataObjectPattern.exec(content);
        if (objMatch) {
          dataContent = objMatch[1];
        }
      }
    }

    if (dataContent) {
      const propertyPattern = /(\w+)\s*:\s*([^,\n]+)/g;
      let propMatch;
      while ((propMatch = propertyPattern.exec(dataContent)) !== null) {
        const name = propMatch[1].trim();
        const rawValue = propMatch[2].trim();

        if (['return', 'function', 'if', 'else', 'for', 'while'].includes(name)) continue;

        const type = this.inferTypeFromValue(rawValue);
        data.push({ name, type, initialValue: rawValue });
      }
    }

    return data;
  }

  private inferTypeFromValue(value: string): string {
    const trimmed = value.replace(/,\s*$/, '').trim();
    if (trimmed === 'null' || trimmed === 'undefined') return 'any';
    if (trimmed === 'true' || trimmed === 'false') return 'boolean';
    if (/^['"`]/.test(trimmed)) return 'string';
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return 'number';
    if (trimmed.startsWith('[')) return 'array';
    if (trimmed.startsWith('{')) return 'object';
    if (trimmed === 'new Date()' || trimmed.startsWith('new Date(')) return 'Date';
    if (trimmed === 'new Map()' || trimmed.startsWith('new Map(')) return 'Map';
    if (trimmed === 'new Set()' || trimmed.startsWith('new Set(')) return 'Set';
    return 'any';
  }

  private extractComputed(content: string): Array<{ name: string; dependencies: string[] }> {
    const computed: Array<{ name: string; dependencies: string[] }> = [];
    const computedPattern = /computed:\s*\{([^}]+)\}/;
    const match = computedPattern.exec(content);

    if (match) {
      const computedContent = match[1];
      const propPattern = /(\w+)\s*[:()]/g;
      let propMatch;

      while ((propMatch = propPattern.exec(computedContent)) !== null) {
        computed.push({
          name: propMatch[1],
          dependencies: []
        });
      }
    }

    return computed;
  }

  private extractMethods(content: string): Array<{ name: string; parameters: any[]; returnType?: string }> {
    const methods: Array<{ name: string; parameters: any[]; returnType?: string }> = [];
    const methodsPattern = /methods:\s*\{([^}]+)\}/;
    const match = methodsPattern.exec(content);

    if (match) {
      const methodsContent = match[1];
      const methodPattern = /(\w+)\s*\(/g;
      let methodMatch;

      while ((methodMatch = methodPattern.exec(methodsContent)) !== null) {
        methods.push({
          name: methodMatch[1],
          parameters: []
        });
      }
    }

    return methods;
  }

  private extractWatchers(content: string): Array<{ name: string; watched: string; deep?: boolean }> {
    const watchers: Array<{ name: string; watched: string; deep?: boolean }> = [];

    const watchBlockPattern = /watch\s*:\s*\{([\s\S]*?)\n\s*\}/;
    const watchBlockMatch = watchBlockPattern.exec(content);
    if (watchBlockMatch) {
      const watchContent = watchBlockMatch[1];

      const stringWatcherPattern = /['"`]([^'"`]+)['"`]\s*(?::\s*\{|[\(:])/g;
      let strMatch;
      while ((strMatch = stringWatcherPattern.exec(watchContent)) !== null) {
        const watched = strMatch[1];
        const surroundingBlock = watchContent.substring(strMatch.index, strMatch.index + 200);
        const deep = /deep\s*:\s*true/.test(surroundingBlock);
        watchers.push({ name: watched.replace(/\./g, '_'), watched, deep });
      }

      const identifierWatcherPattern = /(\w+)\s*(?:\(|:\s*\{|:\s*function)/g;
      let idMatch;
      while ((idMatch = identifierWatcherPattern.exec(watchContent)) !== null) {
        const watched = idMatch[1];
        if (['handler', 'deep', 'immediate', 'flush'].includes(watched)) continue;
        if (watchers.some(w => w.watched === watched)) continue;
        const surroundingBlock = watchContent.substring(idMatch.index, idMatch.index + 200);
        const deep = /deep\s*:\s*true/.test(surroundingBlock);
        watchers.push({ name: watched, watched, deep });
      }
    }

    const compositionWatchPattern = /watch\s*\(\s*(?:(?:\(\s*\)\s*=>)?\s*)?(\w+)/g;
    let compMatch;
    while ((compMatch = compositionWatchPattern.exec(content)) !== null) {
      const watched = compMatch[1];
      if (['function', 'const', 'let', 'var', 'async'].includes(watched)) continue;
      const surroundingBlock = content.substring(compMatch.index, compMatch.index + 300);
      const deep = /deep\s*:\s*true/.test(surroundingBlock);
      if (!watchers.some(w => w.watched === watched)) {
        watchers.push({ name: watched, watched, deep });
      }
    }

    return watchers;
  }

  private extractLifecycle(content: string): string[] {
    const lifecycle: string[] = [];
    const lifecycleMethods = [
      'beforeCreate', 'created', 'beforeMount', 'mounted',
      'beforeUpdate', 'updated', 'beforeDestroy', 'destroyed',
      'beforeUnmount', 'unmounted', 'activated', 'deactivated'
    ];

    lifecycleMethods.forEach(method => {
      if (content.includes(method)) {
        lifecycle.push(method);
      }
    });

    return lifecycle;
  }

  private extractMixins(content: string): string[] {
    const mixins: string[] = [];

    const mixinsArrayPattern = /mixins\s*:\s*\[([^\]]+)\]/;
    const match = mixinsArrayPattern.exec(content);
    if (match) {
      const mixinsContent = match[1];
      const mixinPattern = /(\w+)/g;
      let mixinMatch;
      while ((mixinMatch = mixinPattern.exec(mixinsContent)) !== null) {
        mixins.push(mixinMatch[1]);
      }
    }

    return mixins;
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

  private extractSlots(content: string): string[] {
    const slots: string[] = [];
    const seen = new Set<string>();

    const namedSlotPattern = /<slot\s+[^>]*name\s*=\s*['"`]([^'"`]+)['"`]/g;
    let slotMatch;
    while ((slotMatch = namedSlotPattern.exec(content)) !== null) {
      const name = slotMatch[1];
      if (!seen.has(name)) {
        seen.add(name);
        slots.push(name);
      }
    }

    const defaultSlotPattern = /<slot\s*(?:\s[^>]*)?\/?>/g;
    while ((slotMatch = defaultSlotPattern.exec(content)) !== null) {
      const fullTag = slotMatch[0];
      if (!fullTag.includes('name=') && !seen.has('default')) {
        seen.add('default');
        slots.push('default');
      }
    }

    const defineSlotsPattern = /defineSlots\s*<\s*\{([^}]*)\}/;
    const defineSlotsMatch = defineSlotsPattern.exec(content);
    if (defineSlotsMatch) {
      const slotsContent = defineSlotsMatch[1];
      const slotNamePattern = /(\w+)\s*[\?]?\s*:/g;
      let nameMatch;
      while ((nameMatch = slotNamePattern.exec(slotsContent)) !== null) {
        const name = nameMatch[1];
        if (!seen.has(name)) {
          seen.add(name);
          slots.push(name);
        }
      }
    }

    const slotsOptionPattern = /slots\s*:\s*\[([^\]]+)\]/;
    const slotsOptionMatch = slotsOptionPattern.exec(content);
    if (slotsOptionMatch) {
      const slotsContent = slotsOptionMatch[1];
      const slotStringPattern = /['"`]([^'"`]+)['"`]/g;
      let strMatch;
      while ((strMatch = slotStringPattern.exec(slotsContent)) !== null) {
        const name = strMatch[1];
        if (!seen.has(name)) {
          seen.add(name);
          slots.push(name);
        }
      }
    }

    return slots;
  }

  private extractEmits(content: string): string[] {
    const emits: string[] = [];
    const seen = new Set<string>();

    const emitsArrayPattern = /emits\s*:\s*\[([^\]]+)\]/;
    const emitsArrayMatch = emitsArrayPattern.exec(content);
    if (emitsArrayMatch) {
      const emitsContent = emitsArrayMatch[1];
      const emitStringPattern = /['"`]([^'"`]+)['"`]/g;
      let strMatch;
      while ((strMatch = emitStringPattern.exec(emitsContent)) !== null) {
        const name = strMatch[1];
        if (!seen.has(name)) {
          seen.add(name);
          emits.push(name);
        }
      }
    }

    const emitsObjectPattern = /emits\s*:\s*\{([^}]+)\}/;
    const emitsObjectMatch = emitsObjectPattern.exec(content);
    if (emitsObjectMatch) {
      const emitsContent = emitsObjectMatch[1];
      const emitNamePattern = /(\w+)\s*:/g;
      let nameMatch;
      while ((nameMatch = emitNamePattern.exec(emitsContent)) !== null) {
        const name = nameMatch[1];
        if (!seen.has(name)) {
          seen.add(name);
          emits.push(name);
        }
      }
    }

    const defineEmitsArrayPattern = /defineEmits\s*\(\s*\[([^\]]+)\]/;
    const defineEmitsArrayMatch = defineEmitsArrayPattern.exec(content);
    if (defineEmitsArrayMatch) {
      const emitsContent = defineEmitsArrayMatch[1];
      const emitStringPattern = /['"`]([^'"`]+)['"`]/g;
      let strMatch;
      while ((strMatch = emitStringPattern.exec(emitsContent)) !== null) {
        const name = strMatch[1];
        if (!seen.has(name)) {
          seen.add(name);
          emits.push(name);
        }
      }
    }

    const defineEmitsTypePattern = /defineEmits\s*<\s*\{([^}]*)\}/;
    const defineEmitsTypeMatch = defineEmitsTypePattern.exec(content);
    if (defineEmitsTypeMatch) {
      const emitsContent = defineEmitsTypeMatch[1];
      const eventPattern = /\(\s*e\s*:\s*['"`]([^'"`]+)['"`]/g;
      let eventMatch;
      while ((eventMatch = eventPattern.exec(emitsContent)) !== null) {
        const name = eventMatch[1];
        if (!seen.has(name)) {
          seen.add(name);
          emits.push(name);
        }
      }
    }

    return emits;
  }

  private extractReactive(content: string): string[] {
    const reactive: string[] = [];
    const reactivePattern = /reactive\(\s*\{/g;
    const matches = content.match(reactivePattern);
    return matches ? [String(matches.length)] : [];
  }

  private extractRefs(content: string): string[] {
    const refs: string[] = [];
    const refPattern = /ref\(/g;
    const matches = content.match(refPattern);
    return matches ? [String(matches.length)] : [];
  }

  private extractStoreName(content: string, filePath: string): string {
    const storePattern = /defineStore\(['"`]([^'"`]+)['"`]/;
    const match = storePattern.exec(content);
    return match ? match[1] : path.basename(filePath, path.extname(filePath));
  }

  private extractStoreState(content: string): Array<{ name: string; type: string; initialValue?: any }> {
    const state: Array<{ name: string; type: string; initialValue?: any }> = [];

    const stateFunctionPattern = /state\s*:\s*\(\s*\)\s*(?:=>)?\s*\(\s*\{([\s\S]*?)\}\s*\)/;
    const stateReturnPattern = /state\s*\(\s*\)\s*\{[\s\S]*?return\s*\{([\s\S]*?)\}\s*;?\s*\}/;
    const stateObjectPattern = /state\s*:\s*\{([\s\S]*?)\}/;

    let stateContent: string | null = null;
    const fnMatch = stateFunctionPattern.exec(content);
    if (fnMatch) {
      stateContent = fnMatch[1];
    } else {
      const returnMatch = stateReturnPattern.exec(content);
      if (returnMatch) {
        stateContent = returnMatch[1];
      } else {
        const objMatch = stateObjectPattern.exec(content);
        if (objMatch) {
          stateContent = objMatch[1];
        }
      }
    }

    if (stateContent) {
      const propertyPattern = /(\w+)\s*:\s*([^,\n]+)/g;
      let propMatch;
      while ((propMatch = propertyPattern.exec(stateContent)) !== null) {
        const name = propMatch[1].trim();
        const rawValue = propMatch[2].trim();
        if (['return', 'function', 'if', 'else', 'for', 'while'].includes(name)) continue;
        const type = this.inferTypeFromValue(rawValue);
        state.push({ name, type, initialValue: rawValue.replace(/,\s*$/, '') });
      }
    }

    return state;
  }

  private extractStoreGetters(content: string): Array<{ name: string; returnType: string }> {
    const getters: Array<{ name: string; returnType: string }> = [];

    const gettersBlockPattern = /getters\s*:\s*\{([\s\S]*?)\n\s*\}/;
    const match = gettersBlockPattern.exec(content);
    if (match) {
      const gettersContent = match[1];
      const getterPattern = /(\w+)\s*\(/g;
      let getterMatch;
      while ((getterMatch = getterPattern.exec(gettersContent)) !== null) {
        const name = getterMatch[1];
        if (['function', 'return', 'if', 'else'].includes(name)) continue;
        getters.push({ name, returnType: 'unknown' });
      }

      const getterPropPattern = /(\w+)\s*:/g;
      let propMatch;
      while ((propMatch = getterPropPattern.exec(gettersContent)) !== null) {
        const name = propMatch[1];
        if (['function', 'return', 'if', 'else'].includes(name)) continue;
        if (getters.some(g => g.name === name)) continue;
        getters.push({ name, returnType: 'unknown' });
      }
    }

    return getters;
  }

  private extractStoreMutations(content: string): Array<{ name: string; payload?: string }> {
    const mutations: Array<{ name: string; payload?: string }> = [];

    const mutationsBlockPattern = /mutations\s*:\s*\{([\s\S]*?)\n\s*\}/;
    const match = mutationsBlockPattern.exec(content);
    if (match) {
      const mutationsContent = match[1];
      const mutationPattern = /(\w+)\s*\(\s*state\s*(?:,\s*(\w+))?\s*\)/g;
      let mutationMatch;
      while ((mutationMatch = mutationPattern.exec(mutationsContent)) !== null) {
        const name = mutationMatch[1];
        const payload = mutationMatch[2] || undefined;
        if (['function', 'return', 'if', 'else'].includes(name)) continue;
        mutations.push({ name, payload });
      }

      const mutationPropPattern = /(\w+)\s*:/g;
      let propMatch;
      while ((propMatch = mutationPropPattern.exec(mutationsContent)) !== null) {
        const name = propMatch[1];
        if (['function', 'return', 'if', 'else'].includes(name)) continue;
        if (mutations.some(m => m.name === name)) continue;
        mutations.push({ name });
      }
    }

    return mutations;
  }

  private extractStoreActions(content: string): Array<{ name: string; payload?: string; async: boolean }> {
    const actions: Array<{ name: string; payload?: string; async: boolean }> = [];

    const actionsBlockPattern = /actions\s*:\s*\{([\s\S]*?)\n\s*\}/;
    const match = actionsBlockPattern.exec(content);
    if (match) {
      const actionsContent = match[1];

      const asyncActionPattern = /async\s+(\w+)\s*\(\s*(?:\{[^}]*\}|\w+)\s*(?:,\s*(\w+))?\s*\)/g;
      let asyncMatch;
      while ((asyncMatch = asyncActionPattern.exec(actionsContent)) !== null) {
        const name = asyncMatch[1];
        const payload = asyncMatch[2] || undefined;
        if (['function', 'return', 'if', 'else'].includes(name)) continue;
        actions.push({ name, payload, async: true });
      }

      const syncActionPattern = /(\w+)\s*\(\s*(?:\{[^}]*\}|\w+)\s*(?:,\s*(\w+))?\s*\)/g;
      let syncMatch;
      while ((syncMatch = syncActionPattern.exec(actionsContent)) !== null) {
        const name = syncMatch[1];
        const payload = syncMatch[2] || undefined;
        if (['function', 'return', 'if', 'else', 'async'].includes(name)) continue;
        if (actions.some(a => a.name === name)) continue;
        actions.push({ name, payload, async: false });
      }

      const actionPropPattern = /(\w+)\s*:/g;
      let propMatch;
      while ((propMatch = actionPropPattern.exec(actionsContent)) !== null) {
        const name = propMatch[1];
        if (['function', 'return', 'if', 'else', 'async'].includes(name)) continue;
        if (actions.some(a => a.name === name)) continue;
        const followingText = actionsContent.substring(propMatch.index);
        const isAsync = /:\s*async/.test(followingText.substring(0, 30));
        actions.push({ name, async: isAsync });
      }
    }

    return actions;
  }

  private extractStoreModules(content: string): string[] {
    const modules: string[] = [];

    const modulesBlockPattern = /modules\s*:\s*\{([\s\S]*?)\}/;
    const match = modulesBlockPattern.exec(content);
    if (match) {
      const modulesContent = match[1];
      const modulePattern = /(\w+)\s*(?::|,)/g;
      let moduleMatch;
      while ((moduleMatch = modulePattern.exec(modulesContent)) !== null) {
        const name = moduleMatch[1];
        if (['namespaced', 'state', 'getters', 'mutations', 'actions'].includes(name)) continue;
        modules.push(name);
      }
    }

    return modules;
  }

  private extractRouteName(content: string, routePath: string): string | undefined {
    const escapedPath = routePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const routeBlockPattern = new RegExp(
      `\\{[^}]*path\\s*:\\s*['"\`]${escapedPath}['"\`][^}]*\\}`,
      's'
    );
    const routeBlock = routeBlockPattern.exec(content);
    if (routeBlock) {
      const namePattern = /name\s*:\s*['"`]([^'"`]+)['"`]/;
      const nameMatch = namePattern.exec(routeBlock[0]);
      if (nameMatch) return nameMatch[1];
    }

    return undefined;
  }

  private extractRouteMeta(content: string, routePath: string): Record<string, any> | undefined {
    const escapedPath = routePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const routeBlockPattern = new RegExp(
      `\\{[^}]*path\\s*:\\s*['"\`]${escapedPath}['"\`][\\s\\S]*?meta\\s*:\\s*\\{([^}]*)\\}`,
      ''
    );
    const routeBlock = routeBlockPattern.exec(content);
    if (!routeBlock) return undefined;

    const metaContent = routeBlock[1];
    const meta: Record<string, any> = {};
    const metaPropPattern = /(\w+)\s*:\s*([^,\n]+)/g;
    let propMatch;
    while ((propMatch = metaPropPattern.exec(metaContent)) !== null) {
      const key = propMatch[1].trim();
      const rawValue = propMatch[2].trim().replace(/,\s*$/, '');

      if (rawValue === 'true') meta[key] = true;
      else if (rawValue === 'false') meta[key] = false;
      else if (/^-?\d+(\.\d+)?$/.test(rawValue)) meta[key] = Number(rawValue);
      else if (/^['"`]([^'"`]*)['"`]$/.test(rawValue)) {
        const strMatch = /^['"`]([^'"`]*)['"`]$/.exec(rawValue);
        meta[key] = strMatch ? strMatch[1] : rawValue;
      } else if (rawValue.startsWith('[')) {
        const arrayItemsPattern = /['"`]([^'"`]+)['"`]/g;
        const items: string[] = [];
        let itemMatch;
        while ((itemMatch = arrayItemsPattern.exec(rawValue)) !== null) {
          items.push(itemMatch[1]);
        }
        meta[key] = items;
      } else {
        meta[key] = rawValue;
      }
    }

    return Object.keys(meta).length > 0 ? meta : undefined;
  }

  private extractPluginName(content: string, filePath: string): string | null {
    return path.basename(filePath, path.extname(filePath));
  }

  private async detectVueVersion(projectPath: string): Promise<string> {
    try {
      const packageJson = await fs.readJson(path.join(projectPath, 'package.json'));
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      return deps.vue || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private buildVueRelationships(
    components: VueComponent[],
    composables: VueComposable[],
    stores: VueStore[],
    routes: VueRoute[],
    directives: VueDirective[],
    plugins: VuePlugin[],
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    components.forEach(component => {
      const componentId = this.generateId('component', component.filePath, component.name);

      component.imports.forEach(importPath => {
        if (importPath.startsWith('./') || importPath.startsWith('../')) {
          const importedComponentId = this.generateId('component', '', path.basename(importPath));
          edges.push(this.createEdge(
            this.generateEdgeId(componentId, importedComponentId, 'imports'),
            componentId,
            importedComponentId,
            'imports',
            'dependency',
            { import_path: importPath }
          ));
        }
      });
    });

    routes.forEach((route, index) => {
      const routeId = this.generateId('route', '', `${route.path}_${index}`);
      const componentId = this.generateId('component', '', route.component);

      edges.push(this.createEdge(
        this.generateEdgeId(routeId, componentId, 'renders'),
        routeId,
        componentId,
        'renders',
        'structural',
        { route_path: route.path }
      ));
    });
  }

  private identifyAPIConnections(components: VueComponent[], composables: VueComposable[], exitPoints: CASExitPoint[]): void {
    const hasAPIConnection = components.some(c =>
      c.imports.some(imp => imp.includes('axios') || imp.includes('fetch'))
    ) || composables.some(c =>
      c.name.includes('fetch') || c.name.includes('api')
    );

    if (hasAPIConnection) {
      exitPoints.push(this.createExitPoint(
        'exit_vue_api',
        'vue_app',
        'api',
        'API Connection',
        'External API connections from Vue components',
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
      id: 'vue-components',
      name: 'Vue Component Hierarchy',
      description: 'Component hierarchy showing parent-child relationships and component structure',
      analyzer_id: this.analyzerId,
      type: 'structure',
      connection_rules: {
        visible_node_types: ['vue_app', 'vue_component', 'vue_sfc'],
        relevant_edge_types: ['contains', 'imports', 'uses'],
        node_connections: [
          {
            from_type: 'vue_app',
            to_types: ['vue_component', 'vue_sfc'],
            edge_type: 'contains'
          },
          {
            from_type: 'vue_component',
            to_types: ['vue_component', 'vue_sfc'],
            edge_type: 'imports'
          }
        ]
      },
      layout_hints: {
        style: 'hierarchical',
        direction: 'TB',
        group_by: 'component_type'
      },
      metadata: {
        show_props: true,
        show_slots: true,
        show_emits: true
      }
    });

    perspectives.push({
      id: 'vue-composition',
      name: 'Vue Composition API Usage',
      description: 'Composition API usage showing composables, refs, and reactive state',
      analyzer_id: this.analyzerId,
      type: 'flow',
      connection_rules: {
        visible_node_types: ['vue_composable', 'vue_component', 'vue_store'],
        relevant_edge_types: ['uses', 'provides', 'consumes'],
        node_connections: [
          {
            from_type: 'vue_component',
            to_types: ['vue_composable'],
            edge_type: 'uses'
          },
          {
            from_type: 'vue_composable',
            to_types: ['vue_store'],
            edge_type: 'consumes'
          }
        ]
      },
      layout_hints: {
        style: 'force',
        group_by: 'composition_type'
      },
      metadata: {
        show_reactivity: true,
        show_lifecycle: true
      }
    });

    perspectives.push({
      id: 'vue-routing',
      name: 'Vue Router Structure',
      description: 'Router structure showing routes, navigation guards, and lazy loading',
      analyzer_id: this.analyzerId,
      type: 'structure',
      connection_rules: {
        visible_node_types: ['vue_route', 'vue_component', 'vue_guard'],
        relevant_edge_types: ['renders', 'guards', 'navigates_to'],
        node_connections: [
          {
            from_type: 'vue_route',
            to_types: ['vue_component'],
            edge_type: 'renders'
          },
          {
            from_type: 'vue_route',
            to_types: ['vue_guard'],
            edge_type: 'guards'
          }
        ]
      },
      layout_hints: {
        style: 'hierarchical',
        direction: 'LR',
        group_by: 'route_level'
      },
      metadata: {
        show_route_meta: true,
        show_lazy_loading: true,
        show_guards: true
      }
    });
  }

  private tagNodesWithPerspectives(nodes: CASNode[], edges: CASEdge[]): void {
    nodes.forEach(node => {
      if (!node || typeof node !== 'object') return;

      if (!node.perspectives) {
        node.perspectives = {};
      }

      if (node.type === 'vue_app' || node.type === 'vue_component' || node.type === 'vue_sfc') {
        node.perspectives['vue-components'] = {
          hierarchy: ['vue', 'components'],
          level: node.level || 1,
          priority: 1
        };
      }

      if (node.type === 'vue_composable' || node.type === 'vue_component' || node.type === 'vue_store') {
        node.perspectives['vue-composition'] = {
          hierarchy: ['vue', 'composition'],
          level: node.level || 1,
          priority: 2
        };
      }

      if (node.type === 'vue_route' || node.type === 'vue_component' || node.type === 'vue_guard') {
        node.perspectives['vue-routing'] = {
          hierarchy: ['vue', 'routing'],
          level: node.level || 1,
          priority: 3
        };
      }

      if (!node.metadata) {
        node.metadata = {};
      }
      node.metadata.perspective_data = {
        'vue-components': {
          component_type: node.type,
          is_sfc: node.type === 'vue_sfc',
          has_template: node.metadata?.attributes?.hasTemplate || false
        },
        'vue-composition': {
          composition_type: this.getCompositionType(node.type),
          uses_composition_api: node.metadata?.attributes?.composition || false
        },
        'vue-routing': {
          route_type: node.type === 'vue_route' ? 'route' : 'component',
          is_lazy: node.metadata?.attributes?.lazy || false
        }
      };
    });

    edges.forEach(edge => {
      edge.perspectives = [];

      if (edge.type === 'contains' || edge.type === 'imports' || edge.type === 'uses') {
        edge.perspectives.push('vue-components');
      }

      if (edge.type === 'uses' || edge.type === 'provides' || edge.type === 'consumes') {
        edge.perspectives.push('vue-composition');
      }

      if (edge.type === 'renders' || edge.type === 'guards' || edge.type === 'navigates_to') {
        edge.perspectives.push('vue-routing');
      }

      if (!edge.metadata) {
        edge.metadata = {};
      }
      edge.metadata.perspective_data = {
        'vue-components': {
          relationship_type: edge.type,
          is_component_relationship: true
        },
        'vue-composition': {
          composition_relationship: edge.type,
          is_reactive: edge.metadata?.attributes?.reactive || false
        },
        'vue-routing': {
          navigation_type: edge.type,
          route_relationship: edge.type === 'renders'
        }
      };
    });
  }

  private getCompositionType(nodeType: string): string {
    switch (nodeType) {
      case 'vue_composable': return 'composable';
      case 'vue_store': return 'store';
      case 'vue_component': return 'consumer';
      default: return 'unknown';
    }
  }

  // CAS v1.4.0 Documentation and Comment extraction methods

  private extractDocumentation(content: string, filePath: string): CASDocumentation | undefined {
    if (!content || content.trim().length === 0) return undefined;

    const lines = content.split('\n');

    // Look for Vue-specific documentation patterns

    // 1. Component prop documentation
    const propDocMatches = content.matchAll(/\/\*\*\s*\n[^*]*\*\s*([^@\n][^\n]*)\n[^*]*\*\/[^{]*\n[^{]*props:\s*{/g);
    const propDocs = [];
    for (const match of propDocMatches) {
      propDocs.push(match[1].trim());
    }

    // 2. Computed property docs
    const computedDocMatches = content.matchAll(/\/\*\*\s*\n[^*]*\*\s*([^@\n][^\n]*)\n[^*]*\*\/[^{]*\n[^{]*computed:\s*{/g);
    const computedDocs = [];
    for (const match of computedDocMatches) {
      computedDocs.push(match[1].trim());
    }

    // 3. Method documentation
    const methodDocMatches = content.matchAll(/\/\*\*\s*\n[^*]*\*\s*([^@\n][^\n]*)\n[^*]*\*\/[^{]*\n[^{]*methods:\s*{/g);
    const methodDocs = [];
    for (const match of methodDocMatches) {
      methodDocs.push(match[1].trim());
    }

    // 4. Lifecycle hook comments
    const lifecycleDocMatches = content.matchAll(/\/\/\s*(mounted|created|beforeDestroy|destroyed|beforeMount|updated|beforeUpdate):\s*([^\n]*)/g);
    const lifecycleDocs = [];
    for (const match of lifecycleDocMatches) {
      lifecycleDocs.push(`${match[1]}: ${match[2]}`);
    }

    if (propDocs.length > 0 || computedDocs.length > 0 || methodDocs.length > 0 || lifecycleDocs.length > 0) {
      const doc: CASDocumentation = {
        type: 'other',
        raw: content,
        location: { start_line: 1, end_line: lines.length }
      };

      if (propDocs.length > 0) {
        doc.summary = propDocs[0].split('\n')[0].trim();
        doc.description = propDocs[0].trim();
      } else if (methodDocs.length > 0) {
        doc.summary = methodDocs[0].split('\n')[0].trim();
      }

      doc.framework_docs = {};

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

      // JavaScript/TypeScript single-line comments
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

      // Multi-line comments /* */
      if (trimmedLine.includes('/*') && !trimmedLine.includes('/**')) {
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

        i = j - 1; // Skip processed lines
      }

      // Vue template comments <!-- -->
      const templateCommentMatch = line.match(/<!--\s*([^-]*?)\s*-->/);
      if (templateCommentMatch) {
        const commentText = templateCommentMatch[1].trim();
        if (commentText.length > 0) {
          const comment: CASComment = {
            id: `comment_${filePath}_${++commentSeq}`,
            type: 'multi-line',
            style: '<!-- -->',
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
      has_not_implemented_exceptions: content.includes('throw new Error("Not implemented")') || content.includes('// TODO: implement'),
      has_stub_returns: content.includes('return null') || content.includes('return undefined') || content.includes('return {}'),
      has_placeholder_code: content.includes('// TODO') || content.includes('// FIXME') || content.includes('// PLACEHOLDER'),
      has_hardcoded_values: /['\"](localhost|127\.0\.0\.1|test|example|demo|placeholder)['\"]/. test(content),
      has_commented_out_code: comments.some(c => c.text.includes('function ') || c.text.includes('const ') || c.text.includes('import '))
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
