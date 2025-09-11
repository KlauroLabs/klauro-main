// React Framework Analyzer - Specialized analysis for React applications
// Phase 3: Framework Sub-Analyzers - Production-ready React analyzer

import { TypeScriptJavaScriptAnalyzer } from '../../languages/typescript-javascript-analyzer';
import { ComponentNode, ComponentType, Connection, RiskArea, APIEndpoint } from '../../../types';
import { telemetry } from '../../../telemetry/telemetry-schema';
import { FrameworkDetection } from '../../base-analyzer';
import * as path from 'path';
import * as fs from 'fs-extra';

export interface ReactComponent {
  name: string;
  type: 'functional' | 'class' | 'memo' | 'forwardRef' | 'lazy';
  filePath: string;
  props: ReactProp[];
  hooks: ReactHook[];
  stateVariables: string[];
  contextConsumers: string[];
  children: string[];
  hasEffects: boolean;
  isMemoized: boolean;
  isLazy: boolean;
  dependencies: string[];
}

export interface ReactProp {
  name: string;
  type: string;
  required: boolean;
  defaultValue?: any;
}

export interface ReactHook {
  name: string;
  type: 'state' | 'effect' | 'context' | 'reducer' | 'callback' | 'memo' | 'ref' | 'custom';
  dependencies?: string[];
  customHookName?: string;
}

export interface ReactRoute {
  path: string;
  component: string;
  exact: boolean;
  protected: boolean;
  lazy: boolean;
  preload?: boolean;
  children: ReactRoute[];
}

export interface ReactStateManagement {
  type: 'redux' | 'mobx' | 'zustand' | 'recoil' | 'context' | 'jotai' | 'valtio';
  stores: string[];
  actions: string[];
  selectors: string[];
  providers: string[];
  globalState: boolean;
}

export class ReactAnalyzer extends TypeScriptJavaScriptAnalyzer {
  private reactVersion: string = '';
  private reactComponents: Map<string, ReactComponent> = new Map();
  private componentHierarchy: Map<string, string[]> = new Map();
  private stateManagement: ReactStateManagement | null = null;
  private routes: ReactRoute[] = [];
  private isNextJS: boolean = false;
  private isGatsby: boolean = false;
  private isCreateReactApp: boolean = false;
  private isVite: boolean = false;
  
  getAnalyzerName(): string {
    return 'React Framework Analyzer';
  }

  getSupportedFrameworks(): string[] {
    return ['react', 'react-native', 'next', 'gatsby', 'remix', 'expo'];
  }

  protected async detectLanguageAndFramework(): Promise<any> {
    const baseDetection = await super.detectLanguageAndFramework();
    
    // Enhance with React-specific detection
    const packageJsonPath = path.join(this.projectPath, 'package.json');
    if (await fs.pathExists(packageJsonPath)) {
      const packageJson = await fs.readJson(packageJsonPath);
      
      // Check for React in dependencies
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      this.reactVersion = deps.react || '';
      
      // Detect React meta-frameworks
      this.isNextJS = !!deps.next;
      this.isGatsby = !!deps.gatsby;
      this.isCreateReactApp = !!deps['react-scripts'];
      this.isVite = !!deps.vite && (await fs.pathExists(path.join(this.projectPath, 'vite.config.js')) ||
                                     await fs.pathExists(path.join(this.projectPath, 'vite.config.ts')));
      
      // Detect state management
      if (deps.redux || deps['react-redux']) {
        this.stateManagement = { type: 'redux', stores: [], actions: [], selectors: [], providers: [], globalState: true };
      } else if (deps.mobx || deps['mobx-react']) {
        this.stateManagement = { type: 'mobx', stores: [], actions: [], selectors: [], providers: [], globalState: true };
      } else if (deps.zustand) {
        this.stateManagement = { type: 'zustand', stores: [], actions: [], selectors: [], providers: [], globalState: true };
      } else if (deps.recoil) {
        this.stateManagement = { type: 'recoil', stores: [], actions: [], selectors: [], providers: [], globalState: true };
      } else if (deps.jotai) {
        this.stateManagement = { type: 'jotai', stores: [], actions: [], selectors: [], providers: [], globalState: true };
      } else if (deps.valtio) {
        this.stateManagement = { type: 'valtio', stores: [], actions: [], selectors: [], providers: [], globalState: true };
      }
    }
    
    return {
      ...baseDetection,
      frameworks: [...baseDetection.frameworks, {
        name: 'react',
        version: this.reactVersion,
        confidence: 0.95,
        patterns: ['React components detected'],
        configFiles: this.getReactConfigFiles(),
        dependencies: ['react', 'react-dom']
      }]
    };
  }

  protected async discoverComponents(): Promise<ComponentDiscovery> {
    const span = telemetry.createSpan('react-analyzer.discoverComponents');
    const baseDiscovery = await super.discoverComponents();
    const reactDiscovery = await this.discoverReactComponents();
    
    // Merge discoveries with React-specific enhancements
    const components = new Map<string, ComponentNode>();
    
    // Convert React components to ComponentNodes
    for (const [id, reactComp] of this.reactComponents) {
      const node: ComponentNode = {
        id,
        name: reactComp.name,
        type: this.mapReactComponentType(reactComp.type),
        path: reactComp.filePath,
        language: 'typescript',
        framework: 'react',
        dependencies: reactComp.dependencies,
        metrics: {
          linesOfCode: await this.countLinesOfCode(reactComp.filePath),
          complexity: this.calculateReactComplexity(reactComp),
          maintainability: this.calculateMaintainability(reactComp),
          testCoverage: 0,
          duplicateCode: 0,
          technicalDebt: this.calculateTechnicalDebt(reactComp)
        },
        relationships: [],
        metadata: {
          reactType: reactComp.type,
          hooks: reactComp.hooks,
          props: reactComp.props,
          hasEffects: reactComp.hasEffects,
          isMemoized: reactComp.isMemoized,
          isLazy: reactComp.isLazy,
          stateVariables: reactComp.stateVariables,
          contextConsumers: reactComp.contextConsumers
        }
      };
      components.set(id, node);
    }
    
    // Build component hierarchy and relationships
    const connections = await this.buildReactConnections();
    
    telemetry.emit({
      type: 'component_discovery_completed',
      source: { analyzer: this.getAnalyzerName() },
      data: {
        totalComponents: components.size,
        reactComponents: this.reactComponents.size,
        routes: this.routes.length,
        stateManagement: this.stateManagement?.type || 'none'
      }
    });
    
    span.end();
    return {
      components: Array.from(components.values()),
      entryPoints: this.findReactEntryPoints(),
      connections,
      layers: this.buildReactLayers()
    };
  }

  private async discoverReactComponents(): Promise<void> {
    const files = await this.findFiles(['**/*.{jsx,tsx}'], this.options.excludePatterns);
    
    for (const file of files) {
      const content = await fs.readFile(file, 'utf-8');
      const components = this.parseReactComponents(content, file);
      
      for (const component of components) {
        this.reactComponents.set(component.name, component);
        
        // Track component hierarchy
        if (component.children.length > 0) {
          this.componentHierarchy.set(component.name, component.children);
        }
      }
    }
    
    // Discover routing if applicable
    if (this.isNextJS) {
      await this.discoverNextJSRoutes();
    } else {
      await this.discoverReactRouterRoutes();
    }
  }

  private parseReactComponents(content: string, filePath: string): ReactComponent[] {
    const components: ReactComponent[] = [];
    
    // Parse functional components
    const funcComponentRegex = /(?:export\s+)?(?:const|function)\s+(\w+)\s*(?::\s*React\.FC(?:<.*?>)?|\s*=\s*(?:\([^)]*\)|[^=]*)=>\s*(?:\(|{|<))/g;
    let match;
    
    while ((match = funcComponentRegex.exec(content)) !== null) {
      const componentName = match[1];
      if (componentName && /^[A-Z]/.test(componentName)) {
        components.push({
          name: componentName,
          type: 'functional',
          filePath,
          props: this.parseProps(content, componentName),
          hooks: this.parseHooks(content, componentName),
          stateVariables: this.parseStateVariables(content),
          contextConsumers: this.parseContextConsumers(content),
          children: this.parseChildComponents(content),
          hasEffects: content.includes('useEffect'),
          isMemoized: content.includes('React.memo') || content.includes('useMemo'),
          isLazy: content.includes('React.lazy'),
          dependencies: this.parseImports(content)
        });
      }
    }
    
    // Parse class components
    const classComponentRegex = /class\s+(\w+)\s+extends\s+(?:React\.)?(?:Component|PureComponent)/g;
    
    while ((match = classComponentRegex.exec(content)) !== null) {
      const componentName = match[1];
      components.push({
        name: componentName,
        type: 'class',
        filePath,
        props: this.parseProps(content, componentName),
        hooks: [], // Class components don't use hooks
        stateVariables: this.parseClassState(content),
        contextConsumers: this.parseContextConsumers(content),
        children: this.parseChildComponents(content),
        hasEffects: content.includes('componentDidMount') || content.includes('componentDidUpdate'),
        isMemoized: content.includes('PureComponent'),
        isLazy: false,
        dependencies: this.parseImports(content)
      });
    }
    
    return components;
  }

  private parseProps(content: string, componentName: string): ReactProp[] {
    const props: ReactProp[] = [];
    
    // Parse TypeScript interface/type props
    const propsRegex = new RegExp(`(?:interface|type)\\s+${componentName}Props\\s*(?:=\\s*)?{([^}]+)}`, 's');
    const match = content.match(propsRegex);
    
    if (match) {
      const propsContent = match[1];
      const propRegex = /(\w+)(\?)?:\s*([^;,\n]+)/g;
      let propMatch;
      
      while ((propMatch = propRegex.exec(propsContent)) !== null) {
        props.push({
          name: propMatch[1],
          type: propMatch[3].trim(),
          required: !propMatch[2]
        });
      }
    }
    
    return props;
  }

  private parseHooks(content: string, componentName: string): ReactHook[] {
    const hooks: ReactHook[] = [];
    const hookRegex = /use(\w+)(?:\s*\([^)]*\))?/g;
    let match;
    
    while ((match = hookRegex.exec(content)) !== null) {
      const hookName = `use${match[1]}`;
      let type: ReactHook['type'] = 'custom';
      
      // Categorize built-in hooks
      switch (hookName) {
        case 'useState':
          type = 'state';
          break;
        case 'useEffect':
        case 'useLayoutEffect':
          type = 'effect';
          break;
        case 'useContext':
          type = 'context';
          break;
        case 'useReducer':
          type = 'reducer';
          break;
        case 'useCallback':
          type = 'callback';
          break;
        case 'useMemo':
          type = 'memo';
          break;
        case 'useRef':
          type = 'ref';
          break;
      }
      
      hooks.push({
        name: hookName,
        type,
        customHookName: type === 'custom' ? hookName : undefined
      });
    }
    
    return hooks;
  }

  private parseStateVariables(content: string): string[] {
    const stateVars: string[] = [];
    const stateRegex = /const\s+\[(\w+),\s*set\w+\]\s*=\s*useState/g;
    let match;
    
    while ((match = stateRegex.exec(content)) !== null) {
      stateVars.push(match[1]);
    }
    
    return stateVars;
  }

  private parseClassState(content: string): string[] {
    const stateVars: string[] = [];
    const stateRegex = /this\.state\s*=\s*{([^}]+)}/s;
    const match = content.match(stateRegex);
    
    if (match) {
      const stateContent = match[1];
      const varRegex = /(\w+)\s*:/g;
      let varMatch;
      
      while ((varMatch = varRegex.exec(stateContent)) !== null) {
        stateVars.push(varMatch[1]);
      }
    }
    
    return stateVars;
  }

  private parseContextConsumers(content: string): string[] {
    const contexts: string[] = [];
    const contextRegex = /useContext\((\w+)\)/g;
    let match;
    
    while ((match = contextRegex.exec(content)) !== null) {
      contexts.push(match[1]);
    }
    
    return contexts;
  }

  private parseChildComponents(content: string): string[] {
    const children: string[] = [];
    const componentRegex = /<(\w+)(?:\s|>|\/)/g;
    let match;
    
    while ((match = componentRegex.exec(content)) !== null) {
      const name = match[1];
      if (/^[A-Z]/.test(name) && !['React', 'Fragment'].includes(name)) {
        if (!children.includes(name)) {
          children.push(name);
        }
      }
    }
    
    return children;
  }

  private parseImports(content: string): string[] {
    const imports: string[] = [];
    const importRegex = /import\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/g;
    let match;
    
    while ((match = importRegex.exec(content)) !== null) {
      imports.push(match[1]);
    }
    
    return imports;
  }

  private async discoverNextJSRoutes(): Promise<void> {
    // Check for app directory (Next.js 13+)
    const appDir = path.join(this.projectPath, 'app');
    if (await fs.pathExists(appDir)) {
      this.routes = await this.parseNextJSAppRoutes(appDir);
    } else {
      // Check for pages directory (traditional Next.js)
      const pagesDir = path.join(this.projectPath, 'pages');
      if (await fs.pathExists(pagesDir)) {
        this.routes = await this.parseNextJSPagesRoutes(pagesDir);
      }
    }
  }

  private async parseNextJSAppRoutes(dir: string, basePath: string = ''): Promise<ReactRoute[]> {
    const routes: ReactRoute[] = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory()) {
        const routePath = basePath + '/' + entry.name.replace(/\[([^\]]+)\]/g, ':$1');
        const childRoutes = await this.parseNextJSAppRoutes(fullPath, routePath);
        
        if (await fs.pathExists(path.join(fullPath, 'page.tsx')) || 
            await fs.pathExists(path.join(fullPath, 'page.jsx'))) {
          routes.push({
            path: routePath,
            component: entry.name,
            exact: true,
            protected: false,
            lazy: false,
            children: childRoutes
          });
        } else {
          routes.push(...childRoutes);
        }
      }
    }
    
    return routes;
  }

  private async parseNextJSPagesRoutes(dir: string, basePath: string = ''): Promise<ReactRoute[]> {
    const routes: ReactRoute[] = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory() && !entry.name.startsWith('_')) {
        const childRoutes = await this.parseNextJSPagesRoutes(fullPath, basePath + '/' + entry.name);
        routes.push(...childRoutes);
      } else if (entry.isFile() && (entry.name.endsWith('.tsx') || entry.name.endsWith('.jsx'))) {
        if (!entry.name.startsWith('_')) {
          const routeName = entry.name.replace(/\.(tsx|jsx)$/, '');
          const routePath = basePath + '/' + (routeName === 'index' ? '' : routeName);
          
          routes.push({
            path: routePath.replace(/\[([^\]]+)\]/g, ':$1'),
            component: routeName,
            exact: true,
            protected: false,
            lazy: false,
            children: []
          });
        }
      }
    }
    
    return routes;
  }

  private async discoverReactRouterRoutes(): Promise<void> {
    const files = await this.findFiles(['**/*.{jsx,tsx}'], this.options.excludePatterns);
    
    for (const file of files) {
      const content = await fs.readFile(file, 'utf-8');
      
      // Parse React Router routes
      const routeRegex = /<Route\s+(?:[^>]*\s+)?path=["']([^"']+)["'](?:[^>]*\s+)?(?:component={(\w+)}|element={<(\w+))?/g;
      let match;
      
      while ((match = routeRegex.exec(content)) !== null) {
        this.routes.push({
          path: match[1],
          component: match[2] || match[3] || 'Unknown',
          exact: content.includes('exact'),
          protected: content.includes('PrivateRoute') || content.includes('ProtectedRoute'),
          lazy: content.includes('lazy('),
          children: []
        });
      }
    }
  }

  private mapReactComponentType(reactType: string): ComponentType {
    switch (reactType) {
      case 'functional':
      case 'class':
        return ComponentType.UI_COMPONENT;
      case 'lazy':
        return ComponentType.LAZY_MODULE;
      default:
        return ComponentType.MODULE;
    }
  }

  private calculateReactComplexity(component: ReactComponent): number {
    let complexity = 1; // Base complexity
    
    // Add complexity for hooks
    complexity += component.hooks.length * 2;
    
    // Add complexity for effects
    if (component.hasEffects) complexity += 3;
    
    // Add complexity for state variables
    complexity += component.stateVariables.length;
    
    // Add complexity for context consumers
    complexity += component.contextConsumers.length * 2;
    
    // Add complexity for props
    complexity += component.props.filter(p => p.required).length;
    
    return complexity;
  }

  private calculateMaintainability(component: ReactComponent): number {
    let score = 100;
    
    // Reduce score for complex components
    const complexity = this.calculateReactComplexity(component);
    score -= Math.min(complexity * 2, 30);
    
    // Reduce score for too many props
    if (component.props.length > 10) score -= 10;
    if (component.props.length > 20) score -= 20;
    
    // Reduce score for too many hooks
    if (component.hooks.length > 5) score -= 10;
    if (component.hooks.length > 10) score -= 20;
    
    // Bonus for memoization
    if (component.isMemoized) score += 5;
    
    return Math.max(score, 0);
  }

  private calculateTechnicalDebt(component: ReactComponent): number {
    let debt = 0;
    
    // Debt for missing TypeScript types
    const untypedProps = component.props.filter(p => p.type === 'any').length;
    debt += untypedProps * 2;
    
    // Debt for too many dependencies
    if (component.dependencies.length > 20) debt += 10;
    
    // Debt for complex effects without proper dependencies
    const effectHooks = component.hooks.filter(h => h.type === 'effect');
    if (effectHooks.length > 3) debt += 5;
    
    return debt;
  }

  private async countLinesOfCode(filePath: string): Promise<number> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return content.split('\n').length;
    } catch {
      return 0;
    }
  }

  private async buildReactConnections(): Promise<Connection[]> {
    const connections: Connection[] = [];
    
    // Build connections from component hierarchy
    for (const [parent, children] of this.componentHierarchy) {
      for (const child of children) {
        connections.push({
          source: parent,
          target: child,
          type: 'composition',
          protocol: 'react-component',
          metadata: {
            relationship: 'parent-child'
          }
        });
      }
    }
    
    // Build connections from routing
    for (const route of this.routes) {
      if (route.children.length > 0) {
        for (const childRoute of route.children) {
          connections.push({
            source: route.component,
            target: childRoute.component,
            type: 'navigation',
            protocol: 'react-router',
            metadata: {
              fromPath: route.path,
              toPath: childRoute.path
            }
          });
        }
      }
    }
    
    // Build connections from state management
    if (this.stateManagement) {
      for (const store of this.stateManagement.stores) {
        for (const [name, component] of this.reactComponents) {
          if (component.contextConsumers.includes(store) || 
              component.dependencies.some(d => d.includes(store))) {
            connections.push({
              source: store,
              target: name,
              type: 'data-flow',
              protocol: this.stateManagement.type,
              metadata: {
                stateType: 'store-consumer'
              }
            });
          }
        }
      }
    }
    
    return connections;
  }

  private findReactEntryPoints(): string[] {
    const entryPoints: string[] = [];
    
    // Main app entry
    if (this.isNextJS) {
      entryPoints.push('_app', 'layout');
    } else if (this.isGatsby) {
      entryPoints.push('gatsby-browser', 'gatsby-ssr');
    } else {
      entryPoints.push('index', 'App', 'main');
    }
    
    // Route entry points
    entryPoints.push(...this.routes.filter(r => r.path === '/' || r.path === '').map(r => r.component));
    
    return entryPoints;
  }

  private buildReactLayers(): Record<string, string[]> {
    const layers: Record<string, string[]> = {
      'presentation': [],
      'containers': [],
      'components': [],
      'hooks': [],
      'state': [],
      'routing': [],
      'utilities': []
    };
    
    for (const [name, component] of this.reactComponents) {
      // Categorize components into layers
      if (name.includes('Page') || name.includes('Screen')) {
        layers.presentation.push(name);
      } else if (name.includes('Container') || component.hooks.some(h => h.type === 'state' || h.type === 'effect')) {
        layers.containers.push(name);
      } else if (component.type === 'functional' && component.hooks.length === 0) {
        layers.components.push(name);
      }
      
      // Track custom hooks
      const customHooks = component.hooks.filter(h => h.type === 'custom');
      if (customHooks.length > 0) {
        layers.hooks.push(...customHooks.map(h => h.customHookName!));
      }
    }
    
    // Add state management layer
    if (this.stateManagement) {
      layers.state.push(...this.stateManagement.stores);
      layers.state.push(...this.stateManagement.actions);
    }
    
    // Add routing layer
    layers.routing.push(...this.routes.map(r => r.component));
    
    return layers;
  }

  private getReactConfigFiles(): string[] {
    const configs = [];
    
    if (this.isNextJS) {
      configs.push('next.config.js', 'next.config.ts');
    } else if (this.isGatsby) {
      configs.push('gatsby-config.js', 'gatsby-node.js');
    } else if (this.isCreateReactApp) {
      configs.push('config-overrides.js');
    } else if (this.isVite) {
      configs.push('vite.config.js', 'vite.config.ts');
    }
    
    configs.push('.babelrc', 'webpack.config.js', 'tsconfig.json');
    
    return configs;
  }

  async analyzePerformance(): Promise<any> {
    const performance = await super.analyzePerformance();
    
    // React-specific performance analysis
    const reactPerf = {
      ...performance,
      react: {
        componentsCount: this.reactComponents.size,
        functionalComponents: Array.from(this.reactComponents.values()).filter(c => c.type === 'functional').length,
        classComponents: Array.from(this.reactComponents.values()).filter(c => c.type === 'class').length,
        memoizedComponents: Array.from(this.reactComponents.values()).filter(c => c.isMemoized).length,
        lazyComponents: Array.from(this.reactComponents.values()).filter(c => c.isLazy).length,
        averagePropsPerComponent: this.calculateAverageProps(),
        averageHooksPerComponent: this.calculateAverageHooks(),
        componentsWithEffects: Array.from(this.reactComponents.values()).filter(c => c.hasEffects).length,
        routesCount: this.routes.length,
        stateManagementType: this.stateManagement?.type || 'none',
        renderingOptimizations: {
          memoization: Array.from(this.reactComponents.values()).filter(c => c.isMemoized).length,
          laziness: Array.from(this.reactComponents.values()).filter(c => c.isLazy).length,
          pureComponents: Array.from(this.reactComponents.values()).filter(c => c.type === 'class' && c.isMemoized).length
        }
      }
    };
    
    return reactPerf;
  }

  private calculateAverageProps(): number {
    const components = Array.from(this.reactComponents.values());
    if (components.length === 0) return 0;
    
    const totalProps = components.reduce((sum, c) => sum + c.props.length, 0);
    return totalProps / components.length;
  }

  private calculateAverageHooks(): number {
    const components = Array.from(this.reactComponents.values()).filter(c => c.type === 'functional');
    if (components.length === 0) return 0;
    
    const totalHooks = components.reduce((sum, c) => sum + c.hooks.length, 0);
    return totalHooks / components.length;
  }
}