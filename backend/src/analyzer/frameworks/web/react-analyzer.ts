import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, CASPerspective } from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';
import { glob } from 'glob';
import { parse } from '@typescript-eslint/typescript-estree';

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

interface ReactComponent {
  name: string;
  filePath: string;
  type: 'functional' | 'class';
  isDefaultExport: boolean;
  props: Array<{ name: string; type: string; required: boolean; defaultValue?: string }>;
  state: Array<{ name: string; type: string; initialValue?: string }>;
  hooks: Array<{ name: string; type: string; dependencies?: string[] }>;
  lifecycle: string[];
  children: string[];
  imports: string[];
  exports: string[];
  jsx: boolean;
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
  exact?: boolean;
  guards?: string[];
  children?: ReactRoute[];
  lazy?: boolean;
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
  constructor() {
    super(
      'react-analyzer',
      'React Framework Analyzer',
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

      if (Object.keys(deps).some(dep => dep === 'react' || dep === 'react-dom')) {
        return true;
      }

      const tsFiles = await glob(['**/*.{ts,tsx,js,jsx}'], {
        cwd: projectPath,
        ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**', '**/coverage/**', '**/.nyc_output/**']
      });

      for (const file of tsFiles) {
        const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
        if (content.includes('from react') || content.includes('import React') || content.includes('React.')) {
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
      const reactFiles = await glob(['**/*.{ts,tsx,js,jsx}'], {
        cwd: context.projectPath,
        ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**', '**/coverage/**', '**/.nyc_output/**', '**/*.test.*', '**/*.spec.*']
      });

      const application = await this.analyzeApplication(context.projectPath, nodes);
      const components = await this.analyzeComponents(reactFiles, context.projectPath, nodes, edges);
      const hooks = await this.analyzeHooks(reactFiles, context.projectPath, nodes, edges);
      const contexts = await this.analyzeContexts(reactFiles, context.projectPath, nodes, edges);
      const routes = await this.analyzeRoutes(reactFiles, context.projectPath, nodes, edges, entryPoints);
      const stores = await this.analyzeStores(reactFiles, context.projectPath, nodes, edges);
      const pages = await this.analyzePages(reactFiles, context.projectPath, nodes, edges, entryPoints);
      const utils = await this.analyzeUtils(reactFiles, context.projectPath, nodes, edges);

      this.buildReactRelationships(components, hooks, contexts, routes, stores, pages, nodes, edges);
      this.identifyAPIConnections(components, hooks, exitPoints);

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

  private async analyzeApplication(projectPath: string, nodes: CASNode[]): Promise<ReactApplication | null> {
    try {
      const packageJson = await fs.readJson(path.join(projectPath, 'package.json'));
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

      const appId = this.generateId('app', path.join(projectPath, 'package.json'), application.name);
      const appNode = this.createNodeBuilder(appId, application.name, 'react_app')
        .withLevel(1, 'system')
        .withCategory('frontend', ['react', 'application'])
        .withSource({ file: path.join(projectPath, 'package.json'), line: 1, end_line: 1 })
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
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<ReactComponent[]> {
    const components: ReactComponent[] = [];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (this.isReactComponent(content)) {
        try {
          const ast = parse(content, {
            loc: true,
            jsx: true,
            ecmaVersion: 2020,
            sourceType: 'module'
          });

          const extractedComponents = this.extractComponents(ast, content, file);
          components.push(...extractedComponents);

          extractedComponents.forEach(component => {
            const componentId = this.generateId('component', component.filePath, component.name);
            const componentNode = this.createNodeBuilder(componentId, component.name, component.type === 'functional' ? 'functional_component' : 'class_component')
              .withLevel(2, 'architectural')
              .withCategory('component', ['react', component.type])
              .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
              .withDescription(`React ${component.type} component: ${component.name}`)
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

            component.hooks.forEach((hook, index) => {
              const hookUsageId = this.generateId('hook_usage', component.filePath, `${component.name}_${hook.name}_${index}`);
              const hookUsageNode = this.createNodeBuilder(hookUsageId, `${hook.name} usage`, 'hook_usage')
                .withLevel(4, 'member')
                .withCategory('hook_usage', ['react', 'hook'])
                .withSource({ file: fullPath, line: 1, end_line: 1 })
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
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<ReactHook[]> {
    const hooks: ReactHook[] = [];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (this.isCustomHook(content)) {
        try {
          const ast = parse(content, {
            loc: true,
            jsx: true,
            ecmaVersion: 2020,
            sourceType: 'module'
          });

          const extractedHooks = this.extractHooks(ast, content, file);
          hooks.push(...extractedHooks);

          extractedHooks.forEach(hook => {
            const hookId = this.generateId('hook', hook.filePath, hook.name);
            const hookNode = this.createNodeBuilder(hookId, hook.name, 'custom_hook')
              .withLevel(3, 'code')
              .withCategory('hook', ['react', 'custom'])
              .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
              .withDescription(`Custom React hook: ${hook.name}`)
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
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<ReactContext[]> {
    const contexts: ReactContext[] = [];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('createContext') || content.includes('Context')) {
        try {
          const ast = parse(content, {
            loc: true,
            jsx: true,
            ecmaVersion: 2020,
            sourceType: 'module'
          });

          const extractedContexts = this.extractContexts(ast, content, file);
          contexts.push(...extractedContexts);

          extractedContexts.forEach(context => {
            const contextId = this.generateId('context', context.filePath, context.name);
            const contextNode = this.createNodeBuilder(contextId, context.name, 'react_context')
              .withLevel(3, 'code')
              .withCategory('context', ['react', 'state'])
              .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
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
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): Promise<ReactRoute[]> {
    const routes: ReactRoute[] = [];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('Route') || content.includes('Router') || content.includes('routing')) {
        try {
          const extractedRoutes = this.extractRoutes(content, file);
          routes.push(...extractedRoutes);

          extractedRoutes.forEach((route, index) => {
            const routeId = this.generateId('route', file, `${route.path}_${index}`);
            const routeNode = this.createNodeBuilder(routeId, route.path, 'react_route')
              .withLevel(3, 'code')
              .withCategory('route', ['react', 'navigation'])
              .withSource({ file: fullPath, line: 1, end_line: 1 })
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
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<ReactStore[]> {
    const stores: ReactStore[] = [];

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
              .withCategory('store', ['react', store.type, 'state'])
              .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
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
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): Promise<ReactPage[]> {
    const pages: ReactPage[] = [];

    const pageFiles = files.filter(f =>
      f.includes('/pages/') ||
      f.includes('/views/') ||
      f.includes('/screens/') ||
      f.includes('Page.') ||
      f.includes('View.') ||
      f.includes('Screen.')
    );

    for (const file of pageFiles) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

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
          .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
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

        entryPoints.push(this.createEntryPoint(
          `entry_${pageId}`,
          pageId,
          'page',
          `Page ${pageName}`,
          `React page component accessible at ${route}`,
          {
            path: route,
            method: 'GET'
          },
          {
            authenticated: false
          },
          {
            component: page.component,
            name: pageName
          }
        ));
      }
    }

    return pages;
  }

  private async analyzeUtils(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<ReactUtil[]> {
    const utils: ReactUtil[] = [];

    const utilFiles = files.filter(f =>
      f.includes('/utils/') ||
      f.includes('/helpers/') ||
      f.includes('/lib/') ||
      f.includes('util.') ||
      f.includes('helper.') ||
      f.includes('lib.')
    );

    for (const file of utilFiles) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (!this.isReactComponent(content)) {
        try {
          const ast = parse(content, {
            loc: true,
            jsx: false,
            ecmaVersion: 2020,
            sourceType: 'module'
          });

          const extractedUtils = this.extractUtils(ast, content, file);
          utils.push(...extractedUtils);

          extractedUtils.forEach(util => {
            const utilId = this.generateId('util', util.filePath, util.name);
            const utilNode = this.createNodeBuilder(utilId, util.name, `${util.type}_util`)
              .withLevel(4, 'member')
              .withCategory('util', ['helper', util.type])
              .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
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
    return (content.includes('React') || content.includes('jsx') || content.includes('tsx')) &&
           (content.includes('export') || content.includes('function') || content.includes('class')) &&
           (content.includes('return') && (content.includes('<') || content.includes('createElement')));
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

    const walk = (node: any) => {
      if (node.type === 'FunctionDeclaration' || node.type === 'ArrowFunctionExpression') {
        const name = this.getComponentName(node, content);
        if (name && this.looksLikeComponent(node, content)) {
          const component = this.buildComponentInfo(node, content, filePath, name, 'functional');
          components.push(component);
        }
      } else if (node.type === 'ClassDeclaration') {
        if (this.extendsReactComponent(node)) {
          const name = node.id?.name;
          if (name) {
            const component = this.buildComponentInfo(node, content, filePath, name, 'class');
            components.push(component);
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

    const routePattern = /<Route[^>]*path=["']([^"']+)["'][^>]*component=\{?([^}\s>]+)\}?[^>]*\/?>/g;
    let match;

    while ((match = routePattern.exec(content)) !== null) {
      const path = match[1];
      const component = match[2];

      routes.push({
        path,
        component,
        exact: content.includes('exact')
      });
    }

    return routes;
  }

  private extractStores(content: string, filePath: string): ReactStore[] {
    const stores: ReactStore[] = [];

    if (content.includes('createStore') || content.includes('configureStore')) {
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
    }

    if (content.includes('create(') && content.includes('zustand')) {
      const storeName = this.extractStoreName(content, filePath);
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

    return stores;
  }

  private extractUtils(ast: any, content: string, filePath: string): ReactUtil[] {
    const utils: ReactUtil[] = [];

    const walk = (node: any) => {
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

  private getComponentName(node: any, content: string): string | null {
    if (node.type === 'FunctionDeclaration') {
      return node.id?.name || null;
    }
    if (node.type === 'ArrowFunctionExpression') {
      const declaration = this.findVariableDeclarator(node);
      return declaration?.id?.name || null;
    }
    return null;
  }

  private getHookName(node: any, content: string): string | null {
    if (node.type === 'FunctionDeclaration') {
      return node.id?.name || null;
    }
    if (node.type === 'ArrowFunctionExpression') {
      const declaration = this.findVariableDeclarator(node);
      return declaration?.id?.name || null;
    }
    return null;
  }

  private looksLikeComponent(node: any, content: string): boolean {
    const nodeContent = content.substring(node.range?.[0] || 0, node.range?.[1] || content.length);
    return nodeContent.includes('return') &&
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
      isDefaultExport: this.isDefaultExport(node, content),
      props: this.extractProps(node, content),
      state: this.extractState(node, content),
      hooks: this.extractComponentHooks(node, content),
      lifecycle: this.extractLifecycleMethods(node, content),
      children: [],
      imports: this.extractImports(content),
      exports: this.extractExports(content),
      jsx: content.includes('jsx') || content.includes('<')
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
    return null;
  }

  private isDefaultExport(node: any, content: string): boolean {
    return content.includes(`export default ${node.id?.name}`);
  }

  private extractProps(node: any, content: string): Array<{ name: string; type: string; required: boolean; defaultValue?: string }> {
    return [];
  }

  private extractState(node: any, content: string): Array<{ name: string; type: string; initialValue?: string }> {
    return [];
  }

  private extractComponentHooks(node: any, content: string): Array<{ name: string; type: string; dependencies?: string[] }> {
    const hooks: Array<{ name: string; type: string; dependencies?: string[] }> = [];
    const hookPattern = /(use\w+)\s*\(/g;

    let match;
    while ((match = hookPattern.exec(content)) !== null) {
      hooks.push({
        name: match[1],
        type: match[1].startsWith('use') && match[1].length > 3 ? 'custom' : 'built-in'
      });
    }

    return hooks;
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
    return [];
  }

  private extractPageName(filePath: string): string {
    const fileName = path.basename(filePath, path.extname(filePath));
    return fileName.replace(/Page$|View$|Screen$/, '') || fileName;
  }

  private inferRoute(filePath: string): string {
    const segments = filePath.split('/');
    const fileName = path.basename(filePath, path.extname(filePath));

    if (segments.includes('pages')) {
      const pageIndex = segments.indexOf('pages');
      const routeSegments = segments.slice(pageIndex + 1);
      if (routeSegments.length > 0) {
        const route = '/' + routeSegments.join('/').replace(/index$/, '');
        return route === '/' ? '/' : route.replace(/\/$/, '');
      }
    }

    return '/' + fileName.toLowerCase().replace(/page$|view$|screen$/, '');
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
    return [];
  }

  private extractSelectors(content: string): Array<{ name: string; returnType: string }> {
    return [];
  }

  private async detectReactVersion(projectPath: string): Promise<string> {
    try {
      const packageJson = await fs.readJson(path.join(projectPath, 'package.json'));
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      return deps.react || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private buildReactRelationships(
    components: ReactComponent[],
    hooks: ReactHook[],
    contexts: ReactContext[],
    routes: ReactRoute[],
    stores: ReactStore[],
    pages: ReactPage[],
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

      component.hooks.forEach(hook => {
        if (hook.type === 'custom') {
          const hookId = this.generateId('hook', '', hook.name);
          edges.push(this.createEdge(
            this.generateEdgeId(componentId, hookId, 'uses'),
            componentId,
            hookId,
            'uses',
            'behavioral',
            { hook_name: hook.name }
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

    pages.forEach(page => {
      const pageId = this.generateId('page', page.filePath, page.name);
      const componentId = this.generateId('component', '', page.component);

      edges.push(this.createEdge(
        this.generateEdgeId(pageId, componentId, 'implements'),
        pageId,
        componentId,
        'implements',
        'structural',
        { page_route: page.route }
      ));
    });
  }

  private identifyAPIConnections(components: ReactComponent[], hooks: ReactHook[], exitPoints: CASExitPoint[]): void {
    const hasAPIConnection = components.some(c =>
      c.imports.some(imp => imp.includes('axios') || imp.includes('fetch')) ||
      c.hooks.some(h => h.name.includes('fetch') || h.name.includes('api'))
    ) || hooks.some(h =>
      h.name.includes('fetch') || h.name.includes('api') || h.name.includes('query')
    );

    if (hasAPIConnection) {
      exitPoints.push(this.createExitPoint(
        'exit_react_api',
        'react_app',
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
      node.perspectives = [];

      if (node.type === 'react_app' || node.type === 'react_page' ||
          node.type === 'functional_component' || node.type === 'class_component') {
        node.perspectives.push('react-components');
      }

      if (node.type === 'redux_store' || node.type === 'zustand_store' ||
          node.type === 'react_context' || node.type === 'custom_hook' ||
          node.type === 'functional_component' || node.type === 'class_component') {
        node.perspectives.push('react-data');
      }

      if (node.type === 'react_route' || node.type === 'react_page' ||
          node.type === 'functional_component') {
        node.perspectives.push('react-routing');
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
}