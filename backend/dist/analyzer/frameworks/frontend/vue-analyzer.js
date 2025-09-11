"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.VueAnalyzer = void 0;
const typescript_javascript_analyzer_1 = require("../../languages/typescript-javascript-analyzer");
const telemetry_schema_1 = require("../../../telemetry/telemetry-schema");
const path = __importStar(require("path"));
const fs = __importStar(require("fs-extra"));
class VueAnalyzer extends typescript_javascript_analyzer_1.TypeScriptJavaScriptAnalyzer {
    constructor() {
        super(...arguments);
        this.vueVersion = '';
        this.vueComponents = new Map();
        this.componentHierarchy = new Map();
        this.routes = [];
        this.store = null;
        this.isNuxt = false;
        this.isQuasar = false;
        this.isVuetify = false;
        this.isVite = false;
    }
    getAnalyzerName() {
        return 'Vue Framework Analyzer';
    }
    getSupportedFrameworks() {
        return ['vue', 'nuxt', 'quasar', 'vuetify', 'element-ui', 'ant-design-vue'];
    }
    async detectLanguageAndFramework() {
        const baseDetection = await super.detectLanguageAndFramework();
        const packageJsonPath = path.join(this.projectPath, 'package.json');
        if (await fs.pathExists(packageJsonPath)) {
            const packageJson = await fs.readJson(packageJsonPath);
            const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
            this.vueVersion = deps.vue || '';
            this.isNuxt = !!deps.nuxt || !!deps['@nuxt/core'];
            this.isQuasar = !!deps.quasar || !!deps['@quasar/app'];
            this.isVuetify = !!deps.vuetify;
            this.isVite = !!deps.vite && await fs.pathExists(path.join(this.projectPath, 'vite.config.js'));
            if (deps.vuex) {
                this.store = { type: 'vuex', modules: [], state: [], getters: [], actions: [], mutations: [] };
            }
            else if (deps.pinia) {
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
    async discoverComponents() {
        const span = telemetry_schema_1.telemetry.createSpan('vue-analyzer.discoverComponents');
        const baseDiscovery = await super.discoverComponents();
        await this.discoverVueComponents();
        const components = new Map();
        for (const [id, vueComp] of this.vueComponents) {
            const node = {
                id,
                name: vueComp.name,
                type: 'utility',
                path: vueComp.filePath,
                language: 'typescript',
                framework: 'vue',
                dependencies: vueComp.dependencies,
                dependents: [],
                metrics: {
                    linesOfCode: await this.countLinesOfCode(vueComp.filePath),
                    complexity: this.calculateVueComplexity(vueComp),
                    maintainability: this.calculateMaintainability(vueComp),
                    testCoverage: 0,
                    duplicateCode: 0,
                    technicalDebt: this.calculateTechnicalDebt(vueComp)
                },
                metadata: {
                    lineCount: await this.countLinesOfCode(vueComp.filePath),
                    complexity: this.calculateVueComplexity(vueComp),
                    lastModified: new Date(),
                    exports: [],
                    imports: [],
                    layer: 'presentation',
                    responsibilities: [`Vue ${vueComp.type} component`],
                    vueType: vueComp.type,
                    props: vueComp.props.map(p => p.name),
                    fields: [...vueComp.data, ...vueComp.computed],
                    methods: [...vueComp.methods, ...vueComp.watchers],
                    tags: [
                        ...(vueComp.emits.length > 0 ? [`emits-${vueComp.emits.length}`] : []),
                        ...(vueComp.slots.length > 0 ? [`slots-${vueComp.slots.length}`] : []),
                        ...(vueComp.hasSetup ? ['has-setup'] : []),
                        ...(vueComp.hasScriptSetup ? ['script-setup'] : [])
                    ],
                    properties: [...vueComp.lifecycle, ...vueComp.composables]
                }
            };
            components.set(id, node);
        }
        const connections = await this.buildVueConnections();
        telemetry_schema_1.telemetry.emit({
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
    async discoverVueComponents() {
        const sfcFiles = await this.findFiles(['**/*.vue'], this.options.excludePatterns);
        for (const file of sfcFiles) {
            const content = await fs.readFile(file, 'utf-8');
            const component = await this.parseSingleFileComponent(content, file);
            if (component) {
                this.vueComponents.set(component.name, component);
            }
        }
        const jsFiles = await this.findFiles(['**/*.{js,ts}'], this.options.excludePatterns);
        for (const file of jsFiles) {
            const content = await fs.readFile(file, 'utf-8');
            const components = this.parseJavaScriptVueComponents(content, file);
            for (const component of components) {
                this.vueComponents.set(component.name, component);
            }
        }
        if (this.isNuxt) {
            await this.discoverNuxtRoutes();
        }
        else {
            await this.discoverVueRouterRoutes();
        }
        if (this.store) {
            await this.discoverStoreModules();
        }
    }
    async parseSingleFileComponent(content, filePath) {
        const name = path.basename(filePath, '.vue');
        const templateMatch = content.match(/<template[^>]*>([\s\S]*?)<\/template>/);
        const template = {
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
            const directiveRegex = /v-(\w+)(?::|=)/g;
            let match;
            while ((match = directiveRegex.exec(templateContent)) !== null) {
                if (!template.directives.includes(match[1])) {
                    template.directives.push(match[1]);
                }
            }
            const componentRegex = /<([A-Z][A-Za-z0-9-]+)/g;
            while ((match = componentRegex.exec(templateContent)) !== null) {
                if (!template.components.includes(match[1])) {
                    template.components.push(match[1]);
                }
            }
        }
        const scriptMatch = content.match(/<script([^>]*)>([\s\S]*?)<\/script>/);
        let component = null;
        if (scriptMatch) {
            const scriptAttrs = scriptMatch[1];
            const scriptContent = scriptMatch[2];
            const hasSetup = scriptAttrs.includes('setup');
            if (hasSetup) {
                component = this.parseScriptSetup(scriptContent, name, filePath);
            }
            else if (scriptContent.includes('defineComponent') || scriptContent.includes('setup()') || scriptContent.includes('setup:')) {
                component = this.parseCompositionAPI(scriptContent, name, filePath);
            }
            else {
                component = this.parseOptionsAPI(scriptContent, name, filePath);
            }
            if (component) {
                component.template = template;
                component.hasScriptSetup = hasSetup;
            }
        }
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
    parseScriptSetup(content, name, filePath) {
        const component = {
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
    parseCompositionAPI(content, name, filePath) {
        const component = {
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
    parseOptionsAPI(content, name, filePath) {
        const component = {
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
    parseJavaScriptVueComponents(content, filePath) {
        const components = [];
        if (content.includes('Vue.component') || content.includes('defineComponent') || content.includes('export default {')) {
            const name = path.basename(filePath, path.extname(filePath));
            if (content.includes('defineComponent')) {
                components.push(this.parseCompositionAPI(content, name, filePath));
            }
            else {
                components.push(this.parseOptionsAPI(content, name, filePath));
            }
        }
        return components;
    }
    parseComponentName(content) {
        const match = content.match(/name:\s*['"]([^'"]+)['"]/);
        return match ? match[1] : null;
    }
    parsePropsFromScriptSetup(content) {
        const props = [];
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
    parsePropsFromComposition(content) {
        const props = [];
        const propsMatch = content.match(/props:\s*{([^}]+)}/s);
        if (propsMatch) {
            return this.parsePropsObject(propsMatch[1]);
        }
        return props;
    }
    parsePropsFromOptions(content) {
        const propsMatch = content.match(/props:\s*{([^}]+)}/s);
        if (propsMatch) {
            return this.parsePropsObject(propsMatch[1]);
        }
        return [];
    }
    parsePropsObject(propsContent) {
        const props = [];
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
            }
            else {
                props.push({
                    name: propName,
                    type: propDef,
                    required: false
                });
            }
        }
        return props;
    }
    extractPropType(propDef) {
        const typeMatch = propDef.match(/type:\s*(\w+)/);
        return typeMatch ? typeMatch[1] : 'any';
    }
    extractPropDefault(propDef) {
        const defaultMatch = propDef.match(/default:\s*([^,}]+)/);
        if (defaultMatch) {
            const defaultValue = defaultMatch[1].trim();
            try {
                return JSON.parse(defaultValue);
            }
            catch {
                return defaultValue;
            }
        }
        return undefined;
    }
    parseEmitsFromScriptSetup(content) {
        const emits = [];
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
    parseEmitsFromComposition(content) {
        const emitsMatch = content.match(/emits:\s*\[([^\]]+)\]/);
        return this.parseEmitsArray(emitsMatch);
    }
    parseEmitsFromOptions(content) {
        const emitsMatch = content.match(/emits:\s*\[([^\]]+)\]/);
        return this.parseEmitsArray(emitsMatch);
    }
    parseEmitsArray(match) {
        const emits = [];
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
    parseRefsFromScriptSetup(content) {
        const refs = [];
        const refRegex = /const\s+(\w+)\s*=\s*ref(?:<[^>]+>)?\s*\(/g;
        let match;
        while ((match = refRegex.exec(content)) !== null) {
            refs.push(match[1]);
        }
        const reactiveRegex = /const\s+(\w+)\s*=\s*reactive\s*\(/g;
        while ((match = reactiveRegex.exec(content)) !== null) {
            refs.push(match[1]);
        }
        return refs;
    }
    parseDataFromComposition(content) {
        return this.parseRefsFromScriptSetup(content);
    }
    parseDataFromOptions(content) {
        const data = [];
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
    parseComputedFromScriptSetup(content) {
        const computed = [];
        const computedRegex = /const\s+(\w+)\s*=\s*computed\s*\(/g;
        let match;
        while ((match = computedRegex.exec(content)) !== null) {
            computed.push(match[1]);
        }
        return computed;
    }
    parseComputedFromComposition(content) {
        return this.parseComputedFromScriptSetup(content);
    }
    parseComputedFromOptions(content) {
        const computed = [];
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
    parseMethodsFromComposition(content) {
        const methods = [];
        const methodRegex = /(?:const|function)\s+(\w+)\s*=?\s*(?:\([^)]*\)|async\s*\([^)]*\))\s*(?:=>|{)/g;
        let match;
        while ((match = methodRegex.exec(content)) !== null) {
            if (!['setup', 'ref', 'computed', 'watch', 'watchEffect'].includes(match[1])) {
                methods.push(match[1]);
            }
        }
        return methods;
    }
    parseMethodsFromOptions(content) {
        const methods = [];
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
    parseWatchersFromScriptSetup(content) {
        const watchers = [];
        const watchRegex = /watch(?:Effect)?\s*\(\s*(?:\(\)\s*=>)?\s*([^,\s)]+)/g;
        let match;
        while ((match = watchRegex.exec(content)) !== null) {
            watchers.push(match[1]);
        }
        return watchers;
    }
    parseWatchersFromComposition(content) {
        return this.parseWatchersFromScriptSetup(content);
    }
    parseWatchersFromOptions(content) {
        const watchers = [];
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
    parseLifecycleFromScriptSetup(content) {
        const lifecycle = [];
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
    parseLifecycleFromComposition(content) {
        return this.parseLifecycleFromScriptSetup(content);
    }
    parseLifecycleFromOptions(content) {
        const lifecycle = [];
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
    parseComposablesFromScriptSetup(content) {
        const composables = [];
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
    parseComposablesFromComposition(content) {
        return this.parseComposablesFromScriptSetup(content);
    }
    parseImports(content) {
        const imports = [];
        const importRegex = /import\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/g;
        let match;
        while ((match = importRegex.exec(content)) !== null) {
            imports.push(match[1]);
        }
        return imports;
    }
    detectStylePreprocessor(attrs) {
        if (attrs.includes('lang="scss"') || attrs.includes("lang='scss'"))
            return 'scss';
        if (attrs.includes('lang="sass"') || attrs.includes("lang='sass'"))
            return 'sass';
        if (attrs.includes('lang="less"') || attrs.includes("lang='less'"))
            return 'less';
        if (attrs.includes('lang="stylus"') || attrs.includes("lang='stylus'"))
            return 'stylus';
        if (attrs.includes('lang="postcss"') || attrs.includes("lang='postcss'"))
            return 'postcss';
        return 'css';
    }
    async discoverNuxtRoutes() {
        const pagesDir = path.join(this.projectPath, 'pages');
        if (await fs.pathExists(pagesDir)) {
            this.routes = await this.parseNuxtRoutes(pagesDir);
        }
    }
    async parseNuxtRoutes(dir, basePath = '') {
        const routes = [];
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                const routePath = basePath + '/' + entry.name;
                const childRoutes = await this.parseNuxtRoutes(fullPath, routePath);
                routes.push(...childRoutes);
            }
            else if (entry.isFile() && entry.name.endsWith('.vue')) {
                const routeName = entry.name.replace('.vue', '');
                let routePath = basePath + '/';
                if (routeName === 'index') {
                    routePath = basePath || '/';
                }
                else if (routeName.startsWith('_')) {
                    routePath += ':' + routeName.substring(1);
                }
                else {
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
    async discoverVueRouterRoutes() {
        const routerFiles = await this.findFiles(['**/router.{js,ts}', '**/router/index.{js,ts}'], this.options.excludePatterns);
        for (const file of routerFiles) {
            const content = await fs.readFile(file, 'utf-8');
            this.routes.push(...this.parseVueRouterConfig(content));
        }
    }
    parseVueRouterConfig(content) {
        const routes = [];
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
    async discoverStoreModules() {
        if (!this.store)
            return;
        const storeDir = path.join(this.projectPath, 'store');
        if (await fs.pathExists(storeDir)) {
            const files = await this.findFiles([path.join(storeDir, '**/*.{js,ts}')], []);
            for (const file of files) {
                const content = await fs.readFile(file, 'utf-8');
                const moduleName = path.basename(file, path.extname(file));
                this.store.modules.push(moduleName);
                const stateMatch = content.match(/state:\s*(?:\(\)\s*=>)?\s*{([^}]+)}/s);
                if (stateMatch) {
                    const stateContent = stateMatch[1];
                    const propRegex = /(\w+)\s*:/g;
                    let match;
                    while ((match = propRegex.exec(stateContent)) !== null) {
                        this.store.state.push(`${moduleName}.${match[1]}`);
                    }
                }
                const gettersMatch = content.match(/getters:\s*{([^}]+)}/s);
                if (gettersMatch) {
                    const gettersContent = gettersMatch[1];
                    const getterRegex = /(\w+)\s*(?:\([^)]*\))?\s*{/g;
                    let match;
                    while ((match = getterRegex.exec(gettersContent)) !== null) {
                        this.store.getters.push(`${moduleName}/${match[1]}`);
                    }
                }
                const actionsMatch = content.match(/actions:\s*{([^}]+)}/s);
                if (actionsMatch) {
                    const actionsContent = actionsMatch[1];
                    const actionRegex = /(\w+)\s*(?:\([^)]*\))?\s*{/g;
                    let match;
                    while ((match = actionRegex.exec(actionsContent)) !== null) {
                        this.store.actions.push(`${moduleName}/${match[1]}`);
                    }
                }
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
    calculateVueComplexity(component) {
        let complexity = 1;
        complexity += component.props.length;
        complexity += component.data.length * 2;
        complexity += component.computed.length * 2;
        complexity += component.methods.length;
        complexity += component.watchers.length * 3;
        complexity += component.lifecycle.length;
        complexity += component.composables.length * 2;
        if (component.isAsync)
            complexity += 3;
        if (component.hasSetup)
            complexity += 2;
        return complexity;
    }
    calculateMaintainability(component) {
        let score = 100;
        const complexity = this.calculateVueComplexity(component);
        score -= Math.min(complexity * 2, 40);
        if (component.props.length > 10)
            score -= 10;
        if (component.methods.length > 15)
            score -= 10;
        if (component.watchers.length > 5)
            score -= 15;
        if (component.hasScriptSetup)
            score += 5;
        if (component.type === 'composition-api')
            score += 3;
        return Math.max(score, 0);
    }
    calculateTechnicalDebt(component) {
        let debt = 0;
        if (this.vueVersion.startsWith('3') && component.type === 'options-api') {
            debt += 5;
        }
        const propsWithoutValidation = component.props.filter(p => !p.validator && p.type === 'any').length;
        debt += propsWithoutValidation * 2;
        if (component.watchers.length > 5)
            debt += 10;
        if (component.template.directives.length > 10)
            debt += 5;
        return debt;
    }
    async countLinesOfCode(filePath) {
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            return content.split('\n').length;
        }
        catch {
            return 0;
        }
    }
    async buildVueConnections() {
        const connections = [];
        for (const [name, component] of this.vueComponents) {
            for (const child of component.template.components) {
                connections.push({
                    from: name,
                    to: child,
                    type: 'contains',
                    protocol: 'vue-component',
                    metadata: {
                        callSites: 1,
                        relationship: 'parent-child'
                    }
                });
            }
        }
        for (const route of this.routes) {
            if (route.children.length > 0) {
                for (const childRoute of route.children) {
                    connections.push({
                        from: route.component,
                        to: childRoute.component,
                        type: 'function_call',
                        protocol: 'vue-router',
                        metadata: {
                            callSites: 1,
                            path: route.path,
                            routePath: childRoute.path
                        }
                    });
                }
            }
        }
        if (this.store) {
            for (const [name, component] of this.vueComponents) {
                if (component.composables.some(c => c.includes('Store')) ||
                    component.dependencies.some(d => d.includes('store'))) {
                    connections.push({
                        from: 'store',
                        to: name,
                        type: 'data_flow',
                        protocol: this.store.type,
                        metadata: {
                            callSites: 1,
                            dataFlow: this.store.type
                        }
                    });
                }
            }
        }
        return connections;
    }
    findVueEntryPoints() {
        const entryPoints = [];
        if (this.isNuxt) {
            entryPoints.push('app.vue', 'nuxt.config');
        }
        else {
            entryPoints.push('main', 'App');
        }
        entryPoints.push(...this.routes.filter(r => r.path === '/').map(r => r.component));
        return entryPoints;
    }
    buildVueLayers() {
        const layers = {
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
            }
            else if (component.filePath.includes('/layouts/')) {
                layers.layouts.push(name);
            }
            else if (component.filePath.includes('/components/')) {
                layers.components.push(name);
            }
            layers.composables.push(...component.composables);
        }
        if (this.store) {
            layers.store.push(...this.store.modules);
        }
        layers.routing.push(...this.routes.map(r => r.component));
        return layers;
    }
    getVueConfigFiles() {
        const configs = [];
        if (this.isNuxt) {
            configs.push('nuxt.config.js', 'nuxt.config.ts');
        }
        else {
            configs.push('vue.config.js');
        }
        if (this.isVite) {
            configs.push('vite.config.js', 'vite.config.ts');
        }
        configs.push('tsconfig.json', 'jsconfig.json');
        return configs;
    }
    async analyzePerformance() {
        return {
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
    calculateAverageProps() {
        const components = Array.from(this.vueComponents.values());
        if (components.length === 0)
            return 0;
        const totalProps = components.reduce((sum, c) => sum + c.props.length, 0);
        return totalProps / components.length;
    }
    calculateAverageMethods() {
        const components = Array.from(this.vueComponents.values());
        if (components.length === 0)
            return 0;
        const totalMethods = components.reduce((sum, c) => sum + c.methods.length, 0);
        return totalMethods / components.length;
    }
    calculateComposablesUsage() {
        const usage = {};
        for (const component of this.vueComponents.values()) {
            for (const composable of component.composables) {
                usage[composable] = (usage[composable] || 0) + 1;
            }
        }
        return usage;
    }
}
exports.VueAnalyzer = VueAnalyzer;
