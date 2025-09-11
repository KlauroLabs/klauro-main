// Vue Framework Analyzer - Specialized analysis for Vue.js applications
// Phase 3: Framework Sub-Analyzers - Production-ready Vue analyzer

import { TypeScriptJavaScriptAnalyzer } from '../../languages/typescript-javascript-analyzer';
import { ComponentNode, ComponentType, Connection, RiskArea } from '../../../types';
import { telemetry } from '../../../telemetry/telemetry-schema';
import { FrameworkDetection } from '../../base-analyzer';
import * as path from 'path';
import * as fs from 'fs-extra';

export interface VueComponent {
  name: string;
  type: 'sfc' | 'options-api' | 'composition-api' | 'class-component';
  filePath: string;
  props: VueProp[];
  emits: string[];
  slots: string[];
  data: string[];
  computed: string[];
  methods: string[];
  watchers: string[];
  lifecycle: string[];
  composables: string[];
  dependencies: string[];
  isAsync: boolean;
  hasSetup: boolean;
  hasScriptSetup: boolean;
  template: VueTemplate;
  style: VueStyle;
}

export interface VueProp {
  name: string;
  type: string;
  required: boolean;
  default?: any;
  validator?: boolean;
}

export interface VueTemplate {
  hasSlots: boolean;
  hasScoped: boolean;
  directives: string[];
  components: string[];
  bindings: string[];
}

export interface VueStyle {
  scoped: boolean;
  module: boolean;
  preprocessor: 'css' | 'scss' | 'sass' | 'less' | 'stylus' | 'postcss';
}

export interface VueRoute {
  path: string;
  name: string;
  component: string;
  meta?: Record<string, any>;
  children: VueRoute[];
  beforeEnter?: boolean;
  props?: boolean | Record<string, any>;
}

export interface VueStore {
  type: 'vuex' | 'pinia';
  modules: string[];
  state: string[];
  getters: string[];
  actions: string[];
  mutations?: string[]; // Vuex only
}

export class VueAnalyzer extends TypeScriptJavaScriptAnalyzer {
  private vueVersion: string = '';
  private vueComponents: Map<string, VueComponent> = new Map();
  private componentHierarchy: Map<string, string[]> = new Map();
  private routes: VueRoute[] = [];
  private store: VueStore | null = null;
  private isNuxt: boolean = false;
  private isQuasar: boolean = false;
  private isVuetify: boolean = false;
  private isVite: boolean = false;
  
  getAnalyzerName(): string {
    return 'Vue Framework Analyzer';
  }

  getSupportedFrameworks(): string[] {
    return ['vue', 'nuxt', 'quasar', 'vuetify', 'element-ui', 'ant-design-vue'];
  }

  protected async detectLanguageAndFramework(): Promise<any> {
    const baseDetection = await super.detectLanguageAndFramework();
    
    // Enhance with Vue-specific detection
    const packageJsonPath = path.join(this.projectPath, 'package.json');
    if (await fs.pathExists(packageJsonPath)) {
      const packageJson = await fs.readJson(packageJsonPath);
      
      // Check for Vue in dependencies
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      this.vueVersion = deps.vue || '';
      
      // Detect Vue meta-frameworks
      this.isNuxt = !!deps.nuxt || !!deps['@nuxt/core'];
      this.isQuasar = !!deps.quasar || !!deps['@quasar/app'];
      this.isVuetify = !!deps.vuetify;
      this.isVite = !!deps.vite && await fs.pathExists(path.join(this.projectPath, 'vite.config.js'));
      
      // Detect store
      if (deps.vuex) {
        this.store = { type: 'vuex', modules: [], state: [], getters: [], actions: [], mutations: [] };
      } else if (deps.pinia) {
        this.store = { type: 'pinia', modules: [], state: [], getters: [], actions: [] };
      }
    }
    
    return {
      ...baseDetection,
      frameworks: [...baseDetection.frameworks, {
        name: 'vue',
        version: this.vueVersion,
        confidence: 0.95,
        patterns: ['Vue components detected'],
        configFiles: this.getVueConfigFiles(),
        dependencies: ['vue']
      }]
    };
  }

  protected async discoverComponents(): Promise<any> {
    const span = telemetry.createSpan('vue-analyzer.discoverComponents');
    const baseDiscovery = await super.discoverComponents();
    await this.discoverVueComponents();
    
    // Convert Vue components to ComponentNodes
    const components = new Map<string, ComponentNode>();
    
    for (const [id, vueComp] of this.vueComponents) {
      const node: ComponentNode = {
        id,
        name: vueComp.name,
        type: ComponentType.UI_COMPONENT,
        path: vueComp.filePath,
        language: 'typescript',
        framework: 'vue',
        dependencies: vueComp.dependencies,
        metrics: {
          linesOfCode: await this.countLinesOfCode(vueComp.filePath),
          complexity: this.calculateVueComplexity(vueComp),
          maintainability: this.calculateMaintainability(vueComp),
          testCoverage: 0,
          duplicateCode: 0,
          technicalDebt: this.calculateTechnicalDebt(vueComp)
        },
        relationships: [],
        metadata: {
          vueType: vueComp.type,
          props: vueComp.props,
          emits: vueComp.emits,
          slots: vueComp.slots,
          data: vueComp.data,
          computed: vueComp.computed,
          methods: vueComp.methods,
          watchers: vueComp.watchers,
          lifecycle: vueComp.lifecycle,
          composables: vueComp.composables,
          hasSetup: vueComp.hasSetup,
          hasScriptSetup: vueComp.hasScriptSetup,
          template: vueComp.template,
          style: vueComp.style
        }
      };
      components.set(id, node);
    }
    
    // Build connections
    const connections = await this.buildVueConnections();
    
    telemetry.emit({
      type: 'component_discovery_completed',
      source: { analyzer: this.getAnalyzerName() },
      data: {
        totalComponents: components.size,
        vueComponents: this.vueComponents.size,
        routes: this.routes.length,
        storeType: this.store?.type || 'none'
      }
    });
    
    span.end();
    return {
      components: Array.from(components.values()),
      entryPoints: this.findVueEntryPoints(),
      connections,
      layers: this.buildVueLayers()
    };
  }

  private async discoverVueComponents(): Promise<void> {
    // Discover Single File Components
    const sfcFiles = await this.findFiles(['**/*.vue'], this.options.excludePatterns);
    
    for (const file of sfcFiles) {
      const content = await fs.readFile(file, 'utf-8');
      const component = await this.parseSingleFileComponent(content, file);
      if (component) {
        this.vueComponents.set(component.name, component);
      }
    }
    
    // Discover JS/TS Vue components
    const jsFiles = await this.findFiles(['**/*.{js,ts}'], this.options.excludePatterns);
    
    for (const file of jsFiles) {
      const content = await fs.readFile(file, 'utf-8');
      const components = this.parseJavaScriptVueComponents(content, file);
      
      for (const component of components) {
        this.vueComponents.set(component.name, component);
      }
    }
    
    // Discover routing
    if (this.isNuxt) {
      await this.discoverNuxtRoutes();
    } else {
      await this.discoverVueRouterRoutes();
    }
    
    // Discover store modules
    if (this.store) {
      await this.discoverStoreModules();
    }
  }

  private async parseSingleFileComponent(content: string, filePath: string): Promise<VueComponent | null> {
    const name = path.basename(filePath, '.vue');
    
    // Parse template section
    const templateMatch = content.match(/<template[^>]*>([\s\S]*?)<\/template>/);
    const template: VueTemplate = {
      hasSlots: false,
      hasScoped: false,
      directives: [],
      components: [],
      bindings: []
    };
    
    if (templateMatch) {
      const templateContent = templateMatch[1];
      template.hasSlots = templateContent.includes('<slot');
      template.hasScoped = templateContent.includes('v-slot') || templateContent.includes('#');
      
      // Parse directives
      const directiveRegex = /v-(\w+)(?::|=)/g;
      let match;
      while ((match = directiveRegex.exec(templateContent)) !== null) {
        if (!template.directives.includes(match[1])) {
          template.directives.push(match[1]);
        }
      }
      
      // Parse component usage
      const componentRegex = /<([A-Z][A-Za-z0-9-]+)/g;
      while ((match = componentRegex.exec(templateContent)) !== null) {
        if (!template.components.includes(match[1])) {
          template.components.push(match[1]);
        }
      }
    }
    
    // Parse script section
    const scriptMatch = content.match(/<script([^>]*)>([\s\S]*?)<\/script>/);
    let component: VueComponent | null = null;
    
    if (scriptMatch) {
      const scriptAttrs = scriptMatch[1];
      const scriptContent = scriptMatch[2];
      const hasSetup = scriptAttrs.includes('setup');
      
      if (hasSetup) {
        // Composition API with script setup
        component = this.parseScriptSetup(scriptContent, name, filePath);
      } else if (scriptContent.includes('defineComponent') || scriptContent.includes('setup()') || scriptContent.includes('setup:')) {
        // Composition API
        component = this.parseCompositionAPI(scriptContent, name, filePath);
      } else {
        // Options API
        component = this.parseOptionsAPI(scriptContent, name, filePath);
      }
      
      if (component) {
        component.template = template;
        component.hasScriptSetup = hasSetup;
      }
    }
    
    // Parse style section
    const styleMatch = content.match(/<style([^>]*)>/);
    if (styleMatch && component) {
      const styleAttrs = styleMatch[1];
      component.style = {
        scoped: styleAttrs.includes('scoped'),
        module: styleAttrs.includes('module'),
        preprocessor: this.detectStylePreprocessor(styleAttrs)
      };
    }
    
    return component;
  }

  private parseScriptSetup(content: string, name: string, filePath: string): VueComponent {
    const component: VueComponent = {
      name,
      type: 'composition-api',
      filePath,
      props: this.parsePropsFromScriptSetup(content),
      emits: this.parseEmitsFromScriptSetup(content),
      slots: [],
      data: this.parseRefsFromScriptSetup(content),
      computed: this.parseComputedFromScriptSetup(content),
      methods: [],
      watchers: this.parseWatchersFromScriptSetup(content),
      lifecycle: this.parseLifecycleFromScriptSetup(content),
      composables: this.parseComposablesFromScriptSetup(content),
      dependencies: this.parseImports(content),
      isAsync: content.includes('await '),
      hasSetup: true,
      hasScriptSetup: true,
      template: { hasSlots: false, hasScoped: false, directives: [], components: [], bindings: [] },
      style: { scoped: false, module: false, preprocessor: 'css' }
    };
    
    return component;
  }

  private parseCompositionAPI(content: string, name: string, filePath: string): VueComponent {
    const component: VueComponent = {
      name,
      type: 'composition-api',
      filePath,
      props: this.parsePropsFromComposition(content),
      emits: this.parseEmitsFromComposition(content),
      slots: [],
      data: this.parseDataFromComposition(content),
      computed: this.parseComputedFromComposition(content),
      methods: this.parseMethodsFromComposition(content),
      watchers: this.parseWatchersFromComposition(content),
      lifecycle: this.parseLifecycleFromComposition(content),
      composables: this.parseComposablesFromComposition(content),
      dependencies: this.parseImports(content),
      isAsync: content.includes('async setup'),
      hasSetup: true,
      hasScriptSetup: false,
      template: { hasSlots: false, hasScoped: false, directives: [], components: [], bindings: [] },
      style: { scoped: false, module: false, preprocessor: 'css' }
    };
    
    return component;
  }

  private parseOptionsAPI(content: string, name: string, filePath: string): VueComponent {
    const component: VueComponent = {
      name: this.parseComponentName(content) || name,
      type: 'options-api',
      filePath,
      props: this.parsePropsFromOptions(content),
      emits: this.parseEmitsFromOptions(content),
      slots: [],
      data: this.parseDataFromOptions(content),
      computed: this.parseComputedFromOptions(content),
      methods: this.parseMethodsFromOptions(content),
      watchers: this.parseWatchersFromOptions(content),
      lifecycle: this.parseLifecycleFromOptions(content),
      composables: [],
      dependencies: this.parseImports(content),
      isAsync: false,
      hasSetup: false,
      hasScriptSetup: false,
      template: { hasSlots: false, hasScoped: false, directives: [], components: [], bindings: [] },
      style: { scoped: false, module: false, preprocessor: 'css' }
    };
    
    return component;
  }

  private parseJavaScriptVueComponents(content: string, filePath: string): VueComponent[] {
    const components: VueComponent[] = [];
    
    // Check for Vue component definitions
    if (content.includes('Vue.component') || content.includes('defineComponent') || content.includes('export default {')) {
      const name = path.basename(filePath, path.extname(filePath));
      
      if (content.includes('defineComponent')) {
        components.push(this.parseCompositionAPI(content, name, filePath));
      } else {
        components.push(this.parseOptionsAPI(content, name, filePath));
      }
    }
    
    return components;
  }

  private parseComponentName(content: string): string | null {
    const match = content.match(/name:\s*['"]([^'"]+)['"]/);
    return match ? match[1] : null;
  }

  private parsePropsFromScriptSetup(content: string): VueProp[] {
    const props: VueProp[] = [];
    const propsMatch = content.match(/(?:const\s+props\s*=\s*)?defineProps(?:<[^>]+>)?\s*\(([^)]+)\)/s);
    
    if (propsMatch) {
      const propsContent = propsMatch[1];
      const propRegex = /(\w+):\s*{([^}]+)}/g;
      let match;
      
      while ((match = propRegex.exec(propsContent)) !== null) {
        const propName = match[1];
        const propDef = match[2];
        
        props.push({
          name: propName,
          type: this.extractPropType(propDef),
          required: propDef.includes('required: true'),
          default: this.extractPropDefault(propDef),
          validator: propDef.includes('validator')
        });
      }
    }
    
    return props;
  }

  private parsePropsFromComposition(content: string): VueProp[] {
    const props: VueProp[] = [];
    const propsMatch = content.match(/props:\s*{([^}]+)}/s);
    
    if (propsMatch) {
      return this.parsePropsObject(propsMatch[1]);
    }
    
    return props;
  }

  private parsePropsFromOptions(content: string): VueProp[] {
    const propsMatch = content.match(/props:\s*{([^}]+)}/s);
    
    if (propsMatch) {
      return this.parsePropsObject(propsMatch[1]);
    }
    
    return [];
  }

  private parsePropsObject(propsContent: string): VueProp[] {
    const props: VueProp[] = [];
    const propRegex = /(\w+):\s*({[^}]+}|\w+)/g;
    let match;
    
    while ((match = propRegex.exec(propsContent)) !== null) {
      const propName = match[1];
      const propDef = match[2];
      
      if (propDef.startsWith('{')) {
        props.push({
          name: propName,
          type: this.extractPropType(propDef),
          required: propDef.includes('required: true'),
          default: this.extractPropDefault(propDef),
          validator: propDef.includes('validator')
        });
      } else {
        props.push({
          name: propName,
          type: propDef,
          required: false
        });
      }
    }
    
    return props;
  }

  private extractPropType(propDef: string): string {
    const typeMatch = propDef.match(/type:\s*(\w+)/);
    return typeMatch ? typeMatch[1] : 'any';
  }

  private extractPropDefault(propDef: string): any {
    const defaultMatch = propDef.match(/default:\s*([^,}]+)/);
    if (defaultMatch) {
      const defaultValue = defaultMatch[1].trim();
      try {
        return JSON.parse(defaultValue);
      } catch {
        return defaultValue;
      }
    }
    return undefined;
  }

  private parseEmitsFromScriptSetup(content: string): string[] {
    const emits: string[] = [];
    const emitsMatch = content.match(/defineEmits\s*\(\s*\[([^\]]+)\]/);
    
    if (emitsMatch) {
      const emitsContent = emitsMatch[1];
      const emitRegex = /['"]([^'"]+)['"]/g;
      let match;
      
      while ((match = emitRegex.exec(emitsContent)) !== null) {
        emits.push(match[1]);
      }
    }
    
    return emits;
  }

  private parseEmitsFromComposition(content: string): string[] {
    const emitsMatch = content.match(/emits:\s*\[([^\]]+)\]/);
    return this.parseEmitsArray(emitsMatch);
  }

  private parseEmitsFromOptions(content: string): string[] {
    const emitsMatch = content.match(/emits:\s*\[([^\]]+)\]/);
    return this.parseEmitsArray(emitsMatch);
  }

  private parseEmitsArray(match: RegExpMatchArray | null): string[] {
    const emits: string[] = [];
    
    if (match) {
      const emitsContent = match[1];
      const emitRegex = /['"]([^'"]+)['"]/g;
      let emitMatch;
      
      while ((emitMatch = emitRegex.exec(emitsContent)) !== null) {
        emits.push(emitMatch[1]);
      }
    }
    
    return emits;
  }

  private parseRefsFromScriptSetup(content: string): string[] {
    const refs: string[] = [];
    const refRegex = /const\s+(\w+)\s*=\s*ref(?:<[^>]+>)?\s*\(/g;
    let match;
    
    while ((match = refRegex.exec(content)) !== null) {
      refs.push(match[1]);
    }
    
    // Also parse reactive
    const reactiveRegex = /const\s+(\w+)\s*=\s*reactive\s*\(/g;
    while ((match = reactiveRegex.exec(content)) !== null) {
      refs.push(match[1]);
    }
    
    return refs;
  }

  private parseDataFromComposition(content: string): string[] {
    return this.parseRefsFromScriptSetup(content);
  }

  private parseDataFromOptions(content: string): string[] {
    const data: string[] = [];
    const dataMatch = content.match(/data\s*\(\s*\)\s*{\s*return\s*{([^}]+)}/s);
    
    if (dataMatch) {
      const dataContent = dataMatch[1];
      const propRegex = /(\w+)\s*:/g;
      let match;
      
      while ((match = propRegex.exec(dataContent)) !== null) {
        data.push(match[1]);
      }
    }
    
    return data;
  }

  private parseComputedFromScriptSetup(content: string): string[] {
    const computed: string[] = [];
    const computedRegex = /const\s+(\w+)\s*=\s*computed\s*\(/g;
    let match;
    
    while ((match = computedRegex.exec(content)) !== null) {
      computed.push(match[1]);
    }
    
    return computed;
  }

  private parseComputedFromComposition(content: string): string[] {
    return this.parseComputedFromScriptSetup(content);
  }

  private parseComputedFromOptions(content: string): string[] {
    const computed: string[] = [];
    const computedMatch = content.match(/computed:\s*{([^}]+)}/s);
    
    if (computedMatch) {
      const computedContent = computedMatch[1];
      const propRegex = /(\w+)\s*(?:\([^)]*\))?\s*{/g;
      let match;
      
      while ((match = propRegex.exec(computedContent)) !== null) {
        computed.push(match[1]);
      }
    }
    
    return computed;
  }

  private parseMethodsFromComposition(content: string): string[] {
    const methods: string[] = [];
    const methodRegex = /(?:const|function)\s+(\w+)\s*=?\s*(?:\([^)]*\)|async\s*\([^)]*\))\s*(?:=>|{)/g;
    let match;
    
    while ((match = methodRegex.exec(content)) !== null) {
      if (!['setup', 'ref', 'computed', 'watch', 'watchEffect'].includes(match[1])) {
        methods.push(match[1]);
      }
    }
    
    return methods;
  }

  private parseMethodsFromOptions(content: string): string[] {
    const methods: string[] = [];
    const methodsMatch = content.match(/methods:\s*{([^}]+)}/s);
    
    if (methodsMatch) {
      const methodsContent = methodsMatch[1];
      const methodRegex = /(\w+)\s*\([^)]*\)\s*{/g;
      let match;
      
      while ((match = methodRegex.exec(methodsContent)) !== null) {
        methods.push(match[1]);
      }
    }
    
    return methods;
  }

  private parseWatchersFromScriptSetup(content: string): string[] {
    const watchers: string[] = [];
    const watchRegex = /watch(?:Effect)?\s*\(\s*(?:\(\)\s*=>)?\s*([^,\s)]+)/g;
    let match;
    
    while ((match = watchRegex.exec(content)) !== null) {
      watchers.push(match[1]);
    }
    
    return watchers;
  }

  private parseWatchersFromComposition(content: string): string[] {
    return this.parseWatchersFromScriptSetup(content);
  }

  private parseWatchersFromOptions(content: string): string[] {
    const watchers: string[] = [];
    const watchMatch = content.match(/watch:\s*{([^}]+)}/s);
    
    if (watchMatch) {
      const watchContent = watchMatch[1];
      const watchRegex = /['"]?(\w+)['"]?\s*(?:\([^)]*\))?\s*{/g;
      let match;
      
      while ((match = watchRegex.exec(watchContent)) !== null) {
        watchers.push(match[1]);
      }
    }
    
    return watchers;
  }

  private parseLifecycleFromScriptSetup(content: string): string[] {
    const lifecycle: string[] = [];
    const hooks = [
      'onBeforeMount', 'onMounted', 'onBeforeUpdate', 'onUpdated',
      'onBeforeUnmount', 'onUnmounted', 'onActivated', 'onDeactivated',
      'onErrorCaptured', 'onRenderTracked', 'onRenderTriggered'
    ];
    
    for (const hook of hooks) {
      if (content.includes(hook)) {
        lifecycle.push(hook);
      }
    }
    
    return lifecycle;
  }

  private parseLifecycleFromComposition(content: string): string[] {
    return this.parseLifecycleFromScriptSetup(content);
  }

  private parseLifecycleFromOptions(content: string): string[] {
    const lifecycle: string[] = [];
    const hooks = [
      'beforeCreate', 'created', 'beforeMount', 'mounted',
      'beforeUpdate', 'updated', 'beforeDestroy', 'destroyed',
      'activated', 'deactivated', 'errorCaptured'
    ];
    
    for (const hook of hooks) {
      const regex = new RegExp(`${hook}\\s*\\(`);
      if (regex.test(content)) {
        lifecycle.push(hook);
      }
    }
    
    return lifecycle;
  }

  private parseComposablesFromScriptSetup(content: string): string[] {
    const composables: string[] = [];
    const useRegex = /(?:const\s+(?:{[^}]+}|\w+)\s*=\s*)?use(\w+)\s*\(/g;
    let match;
    
    while ((match = useRegex.exec(content)) !== null) {
      const composableName = `use${match[1]}`;
      if (!composables.includes(composableName)) {
        composables.push(composableName);
      }
    }
    
    return composables;
  }

  private parseComposablesFromComposition(content: string): string[] {
    return this.parseComposablesFromScriptSetup(content);
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

  private detectStylePreprocessor(attrs: string): VueStyle['preprocessor'] {
    if (attrs.includes('lang="scss"') || attrs.includes("lang='scss'")) return 'scss';
    if (attrs.includes('lang="sass"') || attrs.includes("lang='sass'")) return 'sass';
    if (attrs.includes('lang="less"') || attrs.includes("lang='less'")) return 'less';
    if (attrs.includes('lang="stylus"') || attrs.includes("lang='stylus'")) return 'stylus';
    if (attrs.includes('lang="postcss"') || attrs.includes("lang='postcss'")) return 'postcss';
    return 'css';
  }

  private async discoverNuxtRoutes(): Promise<void> {
    const pagesDir = path.join(this.projectPath, 'pages');
    if (await fs.pathExists(pagesDir)) {
      this.routes = await this.parseNuxtRoutes(pagesDir);
    }
  }

  private async parseNuxtRoutes(dir: string, basePath: string = ''): Promise<VueRoute[]> {
    const routes: VueRoute[] = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory()) {
        const routePath = basePath + '/' + entry.name;
        const childRoutes = await this.parseNuxtRoutes(fullPath, routePath);
        routes.push(...childRoutes);
      } else if (entry.isFile() && entry.name.endsWith('.vue')) {
        const routeName = entry.name.replace('.vue', '');
        let routePath = basePath + '/';
        
        if (routeName === 'index') {
          routePath = basePath || '/';
        } else if (routeName.startsWith('_')) {
          routePath += ':' + routeName.substring(1);
        } else {
          routePath += routeName;
        }
        
        routes.push({
          path: routePath,
          name: routeName,
          component: entry.name,
          children: []
        });
      }
    }
    
    return routes;
  }

  private async discoverVueRouterRoutes(): Promise<void> {
    const routerFiles = await this.findFiles(['**/router.{js,ts}', '**/router/index.{js,ts}'], this.options.excludePatterns);
    
    for (const file of routerFiles) {
      const content = await fs.readFile(file, 'utf-8');
      this.routes.push(...this.parseVueRouterConfig(content));
    }
  }

  private parseVueRouterConfig(content: string): VueRoute[] {
    const routes: VueRoute[] = [];
    const routesMatch = content.match(/routes:\s*\[([^\]]+)\]/s);
    
    if (routesMatch) {
      const routesContent = routesMatch[1];
      const routeRegex = /{[^}]+}/g;
      let match;
      
      while ((match = routeRegex.exec(routesContent)) !== null) {
        const routeStr = match[0];
        const pathMatch = routeStr.match(/path:\s*['"]([^'"]+)['"]/);
        const nameMatch = routeStr.match(/name:\s*['"]([^'"]+)['"]/);
        const componentMatch = routeStr.match(/component:\s*(\w+)/);
        
        if (pathMatch) {
          routes.push({
            path: pathMatch[1],
            name: nameMatch ? nameMatch[1] : '',
            component: componentMatch ? componentMatch[1] : 'Unknown',
            children: []
          });
        }
      }
    }
    
    return routes;
  }

  private async discoverStoreModules(): Promise<void> {
    if (!this.store) return;
    
    const storeDir = path.join(this.projectPath, 'store');
    if (await fs.pathExists(storeDir)) {
      const files = await this.findFiles(['**/*.{js,ts}'], [], storeDir);
      
      for (const file of files) {
        const content = await fs.readFile(file, 'utf-8');
        const moduleName = path.basename(file, path.extname(file));
        
        this.store.modules.push(moduleName);
        
        // Parse state
        const stateMatch = content.match(/state:\s*(?:\(\)\s*=>)?\s*{([^}]+)}/s);
        if (stateMatch) {
          const stateContent = stateMatch[1];
          const propRegex = /(\w+)\s*:/g;
          let match;
          
          while ((match = propRegex.exec(stateContent)) !== null) {
            this.store.state.push(`${moduleName}.${match[1]}`);
          }
        }
        
        // Parse getters
        const gettersMatch = content.match(/getters:\s*{([^}]+)}/s);
        if (gettersMatch) {
          const gettersContent = gettersMatch[1];
          const getterRegex = /(\w+)\s*(?:\([^)]*\))?\s*{/g;
          let match;
          
          while ((match = getterRegex.exec(gettersContent)) !== null) {
            this.store.getters.push(`${moduleName}/${match[1]}`);
          }
        }
        
        // Parse actions
        const actionsMatch = content.match(/actions:\s*{([^}]+)}/s);
        if (actionsMatch) {
          const actionsContent = actionsMatch[1];
          const actionRegex = /(\w+)\s*(?:\([^)]*\))?\s*{/g;
          let match;
          
          while ((match = actionRegex.exec(actionsContent)) !== null) {
            this.store.actions.push(`${moduleName}/${match[1]}`);
          }
        }
        
        // Parse mutations (Vuex only)
        if (this.store.type === 'vuex' && this.store.mutations) {
          const mutationsMatch = content.match(/mutations:\s*{([^}]+)}/s);
          if (mutationsMatch) {
            const mutationsContent = mutationsMatch[1];
            const mutationRegex = /(\w+)\s*(?:\([^)]*\))?\s*{/g;
            let match;
            
            while ((match = mutationRegex.exec(mutationsContent)) !== null) {
              this.store.mutations.push(`${moduleName}/${match[1]}`);
            }
          }
        }
      }
    }
  }

  private calculateVueComplexity(component: VueComponent): number {
    let complexity = 1;
    
    complexity += component.props.length;
    complexity += component.data.length * 2;
    complexity += component.computed.length * 2;
    complexity += component.methods.length;
    complexity += component.watchers.length * 3;
    complexity += component.lifecycle.length;
    complexity += component.composables.length * 2;
    
    if (component.isAsync) complexity += 3;
    if (component.hasSetup) complexity += 2;
    
    return complexity;
  }

  private calculateMaintainability(component: VueComponent): number {
    let score = 100;
    
    const complexity = this.calculateVueComplexity(component);
    score -= Math.min(complexity * 2, 40);
    
    if (component.props.length > 10) score -= 10;
    if (component.methods.length > 15) score -= 10;
    if (component.watchers.length > 5) score -= 15;
    
    // Bonus for modern patterns
    if (component.hasScriptSetup) score += 5;
    if (component.type === 'composition-api') score += 3;
    
    return Math.max(score, 0);
  }

  private calculateTechnicalDebt(component: VueComponent): number {
    let debt = 0;
    
    // Debt for Options API in Vue 3
    if (this.vueVersion.startsWith('3') && component.type === 'options-api') {
      debt += 5;
    }
    
    // Debt for missing prop validation
    const propsWithoutValidation = component.props.filter(p => !p.validator && p.type === 'any').length;
    debt += propsWithoutValidation * 2;
    
    // Debt for too many watchers
    if (component.watchers.length > 5) debt += 10;
    
    // Debt for complex templates
    if (component.template.directives.length > 10) debt += 5;
    
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

  private async buildVueConnections(): Promise<Connection[]> {
    const connections: Connection[] = [];
    
    // Component parent-child relationships
    for (const [name, component] of this.vueComponents) {
      for (const child of component.template.components) {
        connections.push({
          source: name,
          target: child,
          type: 'composition',
          protocol: 'vue-component',
          metadata: {
            relationship: 'parent-child'
          }
        });
      }
    }
    
    // Route connections
    for (const route of this.routes) {
      if (route.children.length > 0) {
        for (const childRoute of route.children) {
          connections.push({
            source: route.component,
            target: childRoute.component,
            type: 'navigation',
            protocol: 'vue-router',
            metadata: {
              fromPath: route.path,
              toPath: childRoute.path
            }
          });
        }
      }
    }
    
    // Store connections
    if (this.store) {
      for (const [name, component] of this.vueComponents) {
        // Check if component uses store
        if (component.composables.some(c => c.includes('Store')) ||
            component.dependencies.some(d => d.includes('store'))) {
          connections.push({
            source: 'store',
            target: name,
            type: 'data-flow',
            protocol: this.store.type,
            metadata: {
              storeType: this.store.type
            }
          });
        }
      }
    }
    
    return connections;
  }

  private findVueEntryPoints(): string[] {
    const entryPoints: string[] = [];
    
    if (this.isNuxt) {
      entryPoints.push('app.vue', 'nuxt.config');
    } else {
      entryPoints.push('main', 'App');
    }
    
    // Add root routes as entry points
    entryPoints.push(...this.routes.filter(r => r.path === '/').map(r => r.component));
    
    return entryPoints;
  }

  private buildVueLayers(): Record<string, string[]> {
    const layers: Record<string, string[]> = {
      'pages': [],
      'components': [],
      'composables': [],
      'store': [],
      'routing': [],
      'layouts': [],
      'plugins': [],
      'middleware': []
    };
    
    for (const [name, component] of this.vueComponents) {
      if (component.filePath.includes('/pages/')) {
        layers.pages.push(name);
      } else if (component.filePath.includes('/layouts/')) {
        layers.layouts.push(name);
      } else if (component.filePath.includes('/components/')) {
        layers.components.push(name);
      }
      
      // Add composables
      layers.composables.push(...component.composables);
    }
    
    // Add store modules
    if (this.store) {
      layers.store.push(...this.store.modules);
    }
    
    // Add routes
    layers.routing.push(...this.routes.map(r => r.component));
    
    return layers;
  }

  private getVueConfigFiles(): string[] {
    const configs = [];
    
    if (this.isNuxt) {
      configs.push('nuxt.config.js', 'nuxt.config.ts');
    } else {
      configs.push('vue.config.js');
    }
    
    if (this.isVite) {
      configs.push('vite.config.js', 'vite.config.ts');
    }
    
    configs.push('tsconfig.json', 'jsconfig.json');
    
    return configs;
  }

  async analyzePerformance(): Promise<any> {
    const performance = await super.analyzePerformance();
    
    return {
      ...performance,
      vue: {
        componentsCount: this.vueComponents.size,
        sfcCount: Array.from(this.vueComponents.values()).filter(c => c.type === 'sfc').length,
        compositionApiCount: Array.from(this.vueComponents.values()).filter(c => c.type === 'composition-api').length,
        optionsApiCount: Array.from(this.vueComponents.values()).filter(c => c.type === 'options-api').length,
        scriptSetupCount: Array.from(this.vueComponents.values()).filter(c => c.hasScriptSetup).length,
        averagePropsPerComponent: this.calculateAverageProps(),
        averageMethodsPerComponent: this.calculateAverageMethods(),
        routesCount: this.routes.length,
        storeModulesCount: this.store?.modules.length || 0,
        composablesUsage: this.calculateComposablesUsage()
      }
    };
  }

  private calculateAverageProps(): number {
    const components = Array.from(this.vueComponents.values());
    if (components.length === 0) return 0;
    
    const totalProps = components.reduce((sum, c) => sum + c.props.length, 0);
    return totalProps / components.length;
  }

  private calculateAverageMethods(): number {
    const components = Array.from(this.vueComponents.values());
    if (components.length === 0) return 0;
    
    const totalMethods = components.reduce((sum, c) => sum + c.methods.length, 0);
    return totalMethods / components.length;
  }

  private calculateComposablesUsage(): Record<string, number> {
    const usage: Record<string, number> = {};
    
    for (const component of this.vueComponents.values()) {
      for (const composable of component.composables) {
        usage[composable] = (usage[composable] || 0) + 1;
      }
    }
    
    return usage;
  }
}