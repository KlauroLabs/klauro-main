// Angular Framework Analyzer - Specialized analysis for Angular applications
// Phase 3: Framework Sub-Analyzers - Production-ready Angular analyzer

import { TypeScriptJavaScriptAnalyzer } from '../../languages/typescript-javascript-analyzer';
import { ComponentNode, ComponentType, Connection } from '../../../types';
import { telemetry } from '../../../telemetry/telemetry-schema';
import * as path from 'path';
import * as fs from 'fs-extra';

export interface AngularComponent {
  name: string;
  selector: string;
  filePath: string;
  templatePath?: string;
  stylePaths: string[];
  type: 'component' | 'directive' | 'pipe' | 'service' | 'module' | 'guard' | 'interceptor';
  standalone: boolean;
  inputs: AngularInput[];
  outputs: AngularOutput[];
  providers: string[];
  dependencies: string[];
  lifecycle: string[];
  changeDetection?: 'Default' | 'OnPush';
  encapsulation?: 'Emulated' | 'None' | 'ShadowDom';
}

export interface AngularInput {
  name: string;
  type: string;
  required: boolean;
  alias?: string;
}

export interface AngularOutput {
  name: string;
  type: string;
  alias?: string;
}

export interface AngularModule {
  name: string;
  filePath: string;
  declarations: string[];
  imports: string[];
  exports: string[];
  providers: string[];
  bootstrap: string[];
}

export interface AngularRoute {
  path: string;
  component?: string;
  loadChildren?: string;
  canActivate?: string[];
  canDeactivate?: string[];
  resolve?: string[];
  data?: Record<string, any>;
  children: AngularRoute[];
}

export interface AngularService {
  name: string;
  filePath: string;
  providedIn: 'root' | 'platform' | 'any' | string;
  dependencies: string[];
  methods: string[];
  observables: string[];
  subjects: string[];
}

export class AngularAnalyzer extends TypeScriptJavaScriptAnalyzer {
  private angularVersion: string = '';
  private components: Map<string, AngularComponent> = new Map();
  private modules: Map<string, AngularModule> = new Map();
  private services: Map<string, AngularService> = new Map();
  private routes: AngularRoute[] = [];
  private isStandalone: boolean = false;
  private hasNgRx: boolean = false;
  private hasUniversal: boolean = false;
  private hasPWA: boolean = false;
  
  getAnalyzerName(): string {
    return 'Angular Framework Analyzer';
  }

  getSupportedFrameworks(): string[] {
    return ['angular', 'ionic'];
  }

  protected async detectLanguageAndFramework(): Promise<any> {
    const baseDetection = await super.detectLanguageAndFramework();
    
    // Check for Angular specific files
    const angularJsonPath = path.join(this.projectPath, 'angular.json');
    if (await fs.pathExists(angularJsonPath)) {
      const angularJson = await fs.readJson(angularJsonPath);
      
      // Detect Angular version from package.json
      const packageJsonPath = path.join(this.projectPath, 'package.json');
      if (await fs.pathExists(packageJsonPath)) {
        const packageJson = await fs.readJson(packageJsonPath);
        const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
        
        this.angularVersion = deps['@angular/core'] || '';
        this.isStandalone = this.angularVersion.startsWith('^14') || this.angularVersion.startsWith('^15') || this.angularVersion.startsWith('^16') || this.angularVersion.startsWith('^17');
        this.hasNgRx = !!deps['@ngrx/store'];
        this.hasUniversal = !!deps['@angular/platform-server'];
        this.hasPWA = !!deps['@angular/pwa'];
      }
    }
    
    return {
      ...baseDetection,
      frameworks: [...baseDetection.frameworks, {
        name: 'angular',
        version: this.angularVersion,
        confidence: 0.95,
        patterns: ['Angular components detected'],
        configFiles: ['angular.json', 'tsconfig.json', 'tsconfig.app.json'],
        dependencies: ['@angular/core', '@angular/common']
      }]
    };
  }

  protected async discoverComponents(): Promise<any> {
    const span = telemetry.createSpan('angular-analyzer.discoverComponents');
    const baseDiscovery = await super.discoverComponents();
    
    await this.discoverAngularComponents();
    await this.discoverAngularModules();
    await this.discoverAngularServices();
    await this.discoverAngularRoutes();
    
    // Convert to ComponentNodes
    const components = new Map<string, ComponentNode>();
    
    for (const [id, angularComp] of this.components) {
      const node: ComponentNode = {
        id,
        name: angularComp.name,
        type: this.mapAngularType(angularComp.type),
        path: angularComp.filePath,
        language: 'typescript',
        framework: 'angular',
        dependencies: angularComp.dependencies,
        metrics: {
          linesOfCode: await this.countLinesOfCode(angularComp.filePath),
          complexity: this.calculateAngularComplexity(angularComp),
          maintainability: this.calculateMaintainability(angularComp),
          testCoverage: 0,
          duplicateCode: 0,
          technicalDebt: this.calculateTechnicalDebt(angularComp)
        },
        relationships: [],
        metadata: {
          angularType: angularComp.type,
          selector: angularComp.selector,
          standalone: angularComp.standalone,
          inputs: angularComp.inputs,
          outputs: angularComp.outputs,
          providers: angularComp.providers,
          lifecycle: angularComp.lifecycle,
          changeDetection: angularComp.changeDetection,
          encapsulation: angularComp.encapsulation
        }
      };
      components.set(id, node);
    }
    
    // Add services as components
    for (const [id, service] of this.services) {
      const node: ComponentNode = {
        id,
        name: service.name,
        type: ComponentType.SERVICE,
        path: service.filePath,
        language: 'typescript',
        framework: 'angular',
        dependencies: service.dependencies,
        metrics: {
          linesOfCode: await this.countLinesOfCode(service.filePath),
          complexity: service.methods.length + service.observables.length,
          maintainability: 100 - (service.methods.length * 2),
          testCoverage: 0,
          duplicateCode: 0,
          technicalDebt: 0
        },
        relationships: [],
        metadata: {
          angularType: 'service',
          providedIn: service.providedIn,
          methods: service.methods,
          observables: service.observables,
          subjects: service.subjects
        }
      };
      components.set(id, node);
    }
    
    const connections = await this.buildAngularConnections();
    
    telemetry.emit({
      type: 'component_discovery_completed',
      source: { analyzer: this.getAnalyzerName() },
      data: {
        totalComponents: components.size,
        angularComponents: this.components.size,
        modules: this.modules.size,
        services: this.services.size,
        routes: this.routes.length,
        hasNgRx: this.hasNgRx
      }
    });
    
    span.end();
    return {
      components: Array.from(components.values()),
      entryPoints: this.findAngularEntryPoints(),
      connections,
      layers: this.buildAngularLayers()
    };
  }

  private async discoverAngularComponents(): Promise<void> {
    const componentFiles = await this.findFiles(['**/*.component.ts'], this.options.excludePatterns);
    const directiveFiles = await this.findFiles(['**/*.directive.ts'], this.options.excludePatterns);
    const pipeFiles = await this.findFiles(['**/*.pipe.ts'], this.options.excludePatterns);
    
    // Parse components
    for (const file of componentFiles) {
      const content = await fs.readFile(file, 'utf-8');
      const component = this.parseAngularComponent(content, file);
      if (component) {
        this.components.set(component.name, component);
      }
    }
    
    // Parse directives
    for (const file of directiveFiles) {
      const content = await fs.readFile(file, 'utf-8');
      const directive = this.parseAngularDirective(content, file);
      if (directive) {
        this.components.set(directive.name, directive);
      }
    }
    
    // Parse pipes
    for (const file of pipeFiles) {
      const content = await fs.readFile(file, 'utf-8');
      const pipe = this.parseAngularPipe(content, file);
      if (pipe) {
        this.components.set(pipe.name, pipe);
      }
    }
  }

  private parseAngularComponent(content: string, filePath: string): AngularComponent | null {
    const componentMatch = content.match(/@Component\s*\(\s*{([^}]+)}\s*\)/s);
    if (!componentMatch) return null;
    
    const metadata = componentMatch[1];
    const classMatch = content.match(/export\s+class\s+(\w+)/);
    if (!classMatch) return null;
    
    const name = classMatch[1];
    const selector = this.extractMetadataValue(metadata, 'selector');
    
    // Extract template and style paths
    let templatePath: string | undefined;
    const templateUrl = this.extractMetadataValue(metadata, 'templateUrl');
    if (templateUrl) {
      templatePath = path.join(path.dirname(filePath), templateUrl);
    }
    
    const styleUrls = this.extractMetadataArray(metadata, 'styleUrls');
    const stylePaths = styleUrls.map(url => path.join(path.dirname(filePath), url));
    
    // Check if standalone
    const standalone = metadata.includes('standalone: true');
    
    // Extract inputs and outputs
    const inputs = this.parseInputs(content);
    const outputs = this.parseOutputs(content);
    
    // Extract lifecycle hooks
    const lifecycle = this.parseLifecycleHooks(content);
    
    // Extract change detection and encapsulation
    const changeDetection = this.extractChangeDetection(metadata);
    const encapsulation = this.extractEncapsulation(metadata);
    
    // Extract providers
    const providers = this.extractMetadataArray(metadata, 'providers');
    
    // Extract dependencies from constructor
    const dependencies = this.parseConstructorDependencies(content);
    
    return {
      name,
      selector: selector || '',
      filePath,
      templatePath,
      stylePaths,
      type: 'component',
      standalone,
      inputs,
      outputs,
      providers,
      dependencies,
      lifecycle,
      changeDetection,
      encapsulation
    };
  }

  private parseAngularDirective(content: string, filePath: string): AngularComponent | null {
    const directiveMatch = content.match(/@Directive\s*\(\s*{([^}]+)}\s*\)/s);
    if (!directiveMatch) return null;
    
    const metadata = directiveMatch[1];
    const classMatch = content.match(/export\s+class\s+(\w+)/);
    if (!classMatch) return null;
    
    const name = classMatch[1];
    const selector = this.extractMetadataValue(metadata, 'selector');
    const standalone = metadata.includes('standalone: true');
    
    const inputs = this.parseInputs(content);
    const outputs = this.parseOutputs(content);
    const providers = this.extractMetadataArray(metadata, 'providers');
    const dependencies = this.parseConstructorDependencies(content);
    
    return {
      name,
      selector: selector || '',
      filePath,
      stylePaths: [],
      type: 'directive',
      standalone,
      inputs,
      outputs,
      providers,
      dependencies,
      lifecycle: []
    };
  }

  private parseAngularPipe(content: string, filePath: string): AngularComponent | null {
    const pipeMatch = content.match(/@Pipe\s*\(\s*{([^}]+)}\s*\)/s);
    if (!pipeMatch) return null;
    
    const metadata = pipeMatch[1];
    const classMatch = content.match(/export\s+class\s+(\w+)/);
    if (!classMatch) return null;
    
    const name = classMatch[1];
    const pipeName = this.extractMetadataValue(metadata, 'name');
    const standalone = metadata.includes('standalone: true');
    const pure = !metadata.includes('pure: false');
    
    return {
      name,
      selector: pipeName || '',
      filePath,
      stylePaths: [],
      type: 'pipe',
      standalone,
      inputs: [],
      outputs: [],
      providers: [],
      dependencies: [],
      lifecycle: []
    };
  }

  private async discoverAngularModules(): Promise<void> {
    const moduleFiles = await this.findFiles(['**/*.module.ts'], this.options.excludePatterns);
    
    for (const file of moduleFiles) {
      const content = await fs.readFile(file, 'utf-8');
      const module = this.parseAngularModule(content, file);
      if (module) {
        this.modules.set(module.name, module);
      }
    }
  }

  private parseAngularModule(content: string, filePath: string): AngularModule | null {
    const moduleMatch = content.match(/@NgModule\s*\(\s*{([^}]+)}\s*\)/s);
    if (!moduleMatch) return null;
    
    const metadata = moduleMatch[1];
    const classMatch = content.match(/export\s+class\s+(\w+)/);
    if (!classMatch) return null;
    
    const name = classMatch[1];
    
    return {
      name,
      filePath,
      declarations: this.extractMetadataArray(metadata, 'declarations'),
      imports: this.extractMetadataArray(metadata, 'imports'),
      exports: this.extractMetadataArray(metadata, 'exports'),
      providers: this.extractMetadataArray(metadata, 'providers'),
      bootstrap: this.extractMetadataArray(metadata, 'bootstrap')
    };
  }

  private async discoverAngularServices(): Promise<void> {
    const serviceFiles = await this.findFiles(['**/*.service.ts'], this.options.excludePatterns);
    
    for (const file of serviceFiles) {
      const content = await fs.readFile(file, 'utf-8');
      const service = this.parseAngularService(content, file);
      if (service) {
        this.services.set(service.name, service);
      }
    }
  }

  private parseAngularService(content: string, filePath: string): AngularService | null {
    const injectableMatch = content.match(/@Injectable\s*\(\s*({[^}]*})?\s*\)/s);
    if (!injectableMatch) return null;
    
    const metadata = injectableMatch[1] || '{}';
    const classMatch = content.match(/export\s+class\s+(\w+)/);
    if (!classMatch) return null;
    
    const name = classMatch[1];
    
    // Extract providedIn
    let providedIn: AngularService['providedIn'] = 'root';
    const providedInMatch = metadata.match(/providedIn:\s*['"]([^'"]+)['"]/);
    if (providedInMatch) {
      providedIn = providedInMatch[1] as any;
    }
    
    // Extract dependencies
    const dependencies = this.parseConstructorDependencies(content);
    
    // Extract methods
    const methods = this.parseMethods(content);
    
    // Extract observables and subjects
    const observables = this.parseObservables(content);
    const subjects = this.parseSubjects(content);
    
    return {
      name,
      filePath,
      providedIn,
      dependencies,
      methods,
      observables,
      subjects
    };
  }

  private async discoverAngularRoutes(): Promise<void> {
    const routingFiles = await this.findFiles(['**/*-routing.module.ts', '**/app.routes.ts'], this.options.excludePatterns);
    
    for (const file of routingFiles) {
      const content = await fs.readFile(file, 'utf-8');
      const routes = this.parseAngularRoutes(content);
      this.routes.push(...routes);
    }
  }

  private parseAngularRoutes(content: string): AngularRoute[] {
    const routes: AngularRoute[] = [];
    const routesMatch = content.match(/(?:const\s+routes|Routes)\s*:\s*Routes\s*=\s*\[([^\]]+)\]/s);
    
    if (routesMatch) {
      const routesContent = routesMatch[1];
      const routeRegex = /{([^}]+)}/g;
      let match;
      
      while ((match = routeRegex.exec(routesContent)) !== null) {
        const routeStr = match[1];
        const route = this.parseRoute(routeStr);
        if (route) {
          routes.push(route);
        }
      }
    }
    
    return routes;
  }

  private parseRoute(routeStr: string): AngularRoute | null {
    const pathMatch = routeStr.match(/path:\s*['"]([^'"]*)['"]/);
    if (!pathMatch) return null;
    
    const path = pathMatch[1];
    const componentMatch = routeStr.match(/component:\s*(\w+)/);
    const loadChildrenMatch = routeStr.match(/loadChildren:\s*\(\)\s*=>\s*import\(['"]([^'"]+)['"]\)/);
    
    const route: AngularRoute = {
      path,
      component: componentMatch ? componentMatch[1] : undefined,
      loadChildren: loadChildrenMatch ? loadChildrenMatch[1] : undefined,
      children: []
    };
    
    // Parse guards
    const canActivateMatch = routeStr.match(/canActivate:\s*\[([^\]]+)\]/);
    if (canActivateMatch) {
      route.canActivate = canActivateMatch[1].split(',').map(g => g.trim());
    }
    
    return route;
  }

  private extractMetadataValue(metadata: string, key: string): string | null {
    const regex = new RegExp(`${key}:\\s*['"]([^'"]+)['"]`);
    const match = metadata.match(regex);
    return match ? match[1] : null;
  }

  private extractMetadataArray(metadata: string, key: string): string[] {
    const regex = new RegExp(`${key}:\\s*\\[([^\\]]+)\\]`, 's');
    const match = metadata.match(regex);
    
    if (!match) return [];
    
    const content = match[1];
    const items: string[] = [];
    const itemRegex = /(\w+)(?:\s*,)?/g;
    let itemMatch;
    
    while ((itemMatch = itemRegex.exec(content)) !== null) {
      items.push(itemMatch[1]);
    }
    
    return items;
  }

  private extractChangeDetection(metadata: string): AngularComponent['changeDetection'] {
    if (metadata.includes('ChangeDetectionStrategy.OnPush')) {
      return 'OnPush';
    }
    return 'Default';
  }

  private extractEncapsulation(metadata: string): AngularComponent['encapsulation'] {
    if (metadata.includes('ViewEncapsulation.None')) {
      return 'None';
    }
    if (metadata.includes('ViewEncapsulation.ShadowDom')) {
      return 'ShadowDom';
    }
    return 'Emulated';
  }

  private parseInputs(content: string): AngularInput[] {
    const inputs: AngularInput[] = [];
    
    // Parse @Input() decorators
    const inputRegex = /@Input\s*\(\s*(?:['"]([^'"]+)['"])?\s*\)\s*(\w+)(?:\s*:\s*([^;=]+))?/g;
    let match;
    
    while ((match = inputRegex.exec(content)) !== null) {
      inputs.push({
        name: match[2],
        type: match[3] ? match[3].trim() : 'any',
        required: content.includes(`${match[2]}!`) || content.includes(`required: true`),
        alias: match[1] || undefined
      });
    }
    
    return inputs;
  }

  private parseOutputs(content: string): AngularOutput[] {
    const outputs: AngularOutput[] = [];
    
    // Parse @Output() decorators
    const outputRegex = /@Output\s*\(\s*(?:['"]([^'"]+)['"])?\s*\)\s*(\w+)\s*=\s*new\s+EventEmitter(?:<([^>]+)>)?/g;
    let match;
    
    while ((match = outputRegex.exec(content)) !== null) {
      outputs.push({
        name: match[2],
        type: match[3] || 'any',
        alias: match[1] || undefined
      });
    }
    
    return outputs;
  }

  private parseLifecycleHooks(content: string): string[] {
    const lifecycle: string[] = [];
    const hooks = [
      'ngOnInit', 'ngOnDestroy', 'ngOnChanges', 'ngDoCheck',
      'ngAfterContentInit', 'ngAfterContentChecked',
      'ngAfterViewInit', 'ngAfterViewChecked'
    ];
    
    for (const hook of hooks) {
      if (content.includes(`${hook}(`)) {
        lifecycle.push(hook);
      }
    }
    
    return lifecycle;
  }

  private parseConstructorDependencies(content: string): string[] {
    const dependencies: string[] = [];
    const constructorMatch = content.match(/constructor\s*\(([^)]*)\)/s);
    
    if (constructorMatch) {
      const params = constructorMatch[1];
      const paramRegex = /(?:private|public|protected)?\s*(\w+)\s*:\s*(\w+)/g;
      let match;
      
      while ((match = paramRegex.exec(params)) !== null) {
        dependencies.push(match[2]);
      }
    }
    
    return dependencies;
  }

  private parseMethods(content: string): string[] {
    const methods: string[] = [];
    const methodRegex = /(?:public\s+|private\s+|protected\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*{/g;
    let match;
    
    while ((match = methodRegex.exec(content)) !== null) {
      const methodName = match[1];
      if (!methodName.startsWith('ng') && methodName !== 'constructor') {
        methods.push(methodName);
      }
    }
    
    return methods;
  }

  private parseObservables(content: string): string[] {
    const observables: string[] = [];
    const observableRegex = /(\w+)\$?\s*:\s*Observable<[^>]+>/g;
    let match;
    
    while ((match = observableRegex.exec(content)) !== null) {
      observables.push(match[1]);
    }
    
    return observables;
  }

  private parseSubjects(content: string): string[] {
    const subjects: string[] = [];
    const subjectRegex = /(\w+)\s*=\s*new\s+(?:Subject|BehaviorSubject|ReplaySubject|AsyncSubject)/g;
    let match;
    
    while ((match = subjectRegex.exec(content)) !== null) {
      subjects.push(match[1]);
    }
    
    return subjects;
  }

  private mapAngularType(type: AngularComponent['type']): ComponentType {
    switch (type) {
      case 'component':
        return ComponentType.UI_COMPONENT;
      case 'service':
        return ComponentType.SERVICE;
      case 'module':
        return ComponentType.MODULE;
      case 'directive':
      case 'pipe':
        return ComponentType.UTILITY;
      case 'guard':
      case 'interceptor':
        return ComponentType.MIDDLEWARE;
      default:
        return ComponentType.MODULE;
    }
  }

  private calculateAngularComplexity(component: AngularComponent): number {
    let complexity = 1;
    
    complexity += component.inputs.length * 2;
    complexity += component.outputs.length * 2;
    complexity += component.providers.length;
    complexity += component.dependencies.length;
    complexity += component.lifecycle.length;
    
    if (component.changeDetection === 'OnPush') complexity -= 2;
    if (!component.standalone) complexity += 3;
    
    return Math.max(complexity, 1);
  }

  private calculateMaintainability(component: AngularComponent): number {
    let score = 100;
    
    const complexity = this.calculateAngularComplexity(component);
    score -= Math.min(complexity * 3, 40);
    
    if (component.inputs.length > 10) score -= 15;
    if (component.outputs.length > 5) score -= 10;
    if (component.dependencies.length > 8) score -= 10;
    
    // Bonus for best practices
    if (component.changeDetection === 'OnPush') score += 5;
    if (component.standalone) score += 5;
    
    return Math.max(score, 0);
  }

  private calculateTechnicalDebt(component: AngularComponent): number {
    let debt = 0;
    
    // Debt for not using standalone components in modern Angular
    if (this.angularVersion.startsWith('^14') || this.angularVersion.startsWith('^15') || 
        this.angularVersion.startsWith('^16') || this.angularVersion.startsWith('^17')) {
      if (!component.standalone && component.type === 'component') {
        debt += 5;
      }
    }
    
    // Debt for not using OnPush change detection
    if (component.changeDetection === 'Default') {
      debt += 3;
    }
    
    // Debt for too many inputs
    if (component.inputs.length > 10) {
      debt += 5;
    }
    
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

  private async buildAngularConnections(): Promise<Connection[]> {
    const connections: Connection[] = [];
    
    // Module dependencies
    for (const [moduleName, module] of this.modules) {
      // Connect module to its declarations
      for (const declaration of module.declarations) {
        connections.push({
          source: moduleName,
          target: declaration,
          type: 'contains',
          protocol: 'angular-module',
          metadata: {
            relationship: 'declares'
          }
        });
      }
      
      // Connect module to its imports
      for (const importName of module.imports) {
        connections.push({
          source: moduleName,
          target: importName,
          type: 'dependency',
          protocol: 'angular-module',
          metadata: {
            relationship: 'imports'
          }
        });
      }
    }
    
    // Component dependencies
    for (const [name, component] of this.components) {
      for (const dep of component.dependencies) {
        connections.push({
          source: name,
          target: dep,
          type: 'dependency',
          protocol: 'angular-di',
          metadata: {
            relationship: 'injects'
          }
        });
      }
    }
    
    // Service dependencies
    for (const [name, service] of this.services) {
      for (const dep of service.dependencies) {
        connections.push({
          source: name,
          target: dep,
          type: 'dependency',
          protocol: 'angular-di',
          metadata: {
            relationship: 'injects'
          }
        });
      }
    }
    
    // Route connections
    for (const route of this.routes) {
      if (route.component) {
        connections.push({
          source: 'router',
          target: route.component,
          type: 'navigation',
          protocol: 'angular-router',
          metadata: {
            path: route.path
          }
        });
      }
      
      if (route.canActivate) {
        for (const guard of route.canActivate) {
          connections.push({
            source: guard,
            target: route.component || route.path,
            type: 'guards',
            protocol: 'angular-router',
            metadata: {
              guardType: 'canActivate'
            }
          });
        }
      }
    }
    
    return connections;
  }

  private findAngularEntryPoints(): string[] {
    const entryPoints: string[] = [];
    
    // Bootstrap components
    for (const module of this.modules.values()) {
      entryPoints.push(...module.bootstrap);
    }
    
    // Main module
    entryPoints.push('AppModule', 'AppComponent');
    
    // Standalone app config
    if (this.isStandalone) {
      entryPoints.push('main');
    }
    
    return entryPoints;
  }

  private buildAngularLayers(): Record<string, string[]> {
    const layers: Record<string, string[]> = {
      'components': [],
      'services': [],
      'modules': [],
      'directives': [],
      'pipes': [],
      'guards': [],
      'interceptors': [],
      'routing': []
    };
    
    for (const [name, component] of this.components) {
      switch (component.type) {
        case 'component':
          layers.components.push(name);
          break;
        case 'directive':
          layers.directives.push(name);
          break;
        case 'pipe':
          layers.pipes.push(name);
          break;
        case 'guard':
          layers.guards.push(name);
          break;
        case 'interceptor':
          layers.interceptors.push(name);
          break;
      }
    }
    
    layers.services.push(...Array.from(this.services.keys()));
    layers.modules.push(...Array.from(this.modules.keys()));
    layers.routing.push(...this.routes.map(r => r.component || r.path));
    
    return layers;
  }

  async analyzePerformance(): Promise<any> {
    const performance = await super.analyzePerformance();
    
    return {
      ...performance,
      angular: {
        componentsCount: this.components.size,
        servicesCount: this.services.size,
        modulesCount: this.modules.size,
        routesCount: this.routes.length,
        standaloneComponents: Array.from(this.components.values()).filter(c => c.standalone).length,
        onPushComponents: Array.from(this.components.values()).filter(c => c.changeDetection === 'OnPush').length,
        averageInputsPerComponent: this.calculateAverageInputs(),
        averageOutputsPerComponent: this.calculateAverageOutputs(),
        features: {
          hasNgRx: this.hasNgRx,
          hasUniversal: this.hasUniversal,
          hasPWA: this.hasPWA,
          isStandalone: this.isStandalone
        }
      }
    };
  }

  private calculateAverageInputs(): number {
    const components = Array.from(this.components.values()).filter(c => c.type === 'component');
    if (components.length === 0) return 0;
    
    const totalInputs = components.reduce((sum, c) => sum + c.inputs.length, 0);
    return totalInputs / components.length;
  }

  private calculateAverageOutputs(): number {
    const components = Array.from(this.components.values()).filter(c => c.type === 'component');
    if (components.length === 0) return 0;
    
    const totalOutputs = components.reduce((sum, c) => sum + c.outputs.length, 0);
    return totalOutputs / components.length;
  }
}