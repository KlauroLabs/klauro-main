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
exports.ReactAnalyzer = void 0;
const typescript_javascript_analyzer_1 = require("../../languages/typescript-javascript-analyzer");
const telemetry_schema_1 = require("../../../telemetry/telemetry-schema");
const path = __importStar(require("path"));
const fs = __importStar(require("fs-extra"));
class ReactAnalyzer extends typescript_javascript_analyzer_1.TypeScriptJavaScriptAnalyzer {
    constructor() {
        super(...arguments);
        this.reactVersion = '';
        this.reactComponents = new Map();
        this.componentHierarchy = new Map();
        this.stateManagement = null;
        this.routes = [];
        this.isNextJS = false;
        this.isGatsby = false;
        this.isCreateReactApp = false;
        this.isVite = false;
    }
    getAnalyzerName() {
        return 'React Framework Analyzer';
    }
    getSupportedFrameworks() {
        return ['react', 'react-native', 'next', 'gatsby', 'remix', 'expo'];
    }
    async detectLanguageAndFramework() {
        const baseDetection = await super.detectLanguageAndFramework();
        const packageJsonPath = path.join(this.projectPath, 'package.json');
        if (await fs.pathExists(packageJsonPath)) {
            const packageJson = await fs.readJson(packageJsonPath);
            const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
            this.reactVersion = deps.react || '';
            this.isNextJS = !!deps.next;
            this.isGatsby = !!deps.gatsby;
            this.isCreateReactApp = !!deps['react-scripts'];
            this.isVite = !!deps.vite && (await fs.pathExists(path.join(this.projectPath, 'vite.config.js')) ||
                await fs.pathExists(path.join(this.projectPath, 'vite.config.ts')));
            if (deps.redux || deps['react-redux']) {
                this.stateManagement = { type: 'redux', stores: [], actions: [], selectors: [], providers: [], globalState: true };
            }
            else if (deps.mobx || deps['mobx-react']) {
                this.stateManagement = { type: 'mobx', stores: [], actions: [], selectors: [], providers: [], globalState: true };
            }
            else if (deps.zustand) {
                this.stateManagement = { type: 'zustand', stores: [], actions: [], selectors: [], providers: [], globalState: true };
            }
            else if (deps.recoil) {
                this.stateManagement = { type: 'recoil', stores: [], actions: [], selectors: [], providers: [], globalState: true };
            }
            else if (deps.jotai) {
                this.stateManagement = { type: 'jotai', stores: [], actions: [], selectors: [], providers: [], globalState: true };
            }
            else if (deps.valtio) {
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
    async discoverComponents() {
        const span = telemetry_schema_1.telemetry.createSpan('react-analyzer.discoverComponents');
        const baseDiscovery = await super.discoverComponents();
        const reactDiscovery = await this.discoverReactComponents();
        const components = new Map();
        for (const [id, reactComp] of this.reactComponents) {
            const node = {
                id,
                name: reactComp.name,
                type: this.mapReactComponentType(reactComp.type),
                path: reactComp.filePath,
                language: 'typescript',
                framework: 'react',
                dependencies: reactComp.dependencies,
                dependents: [],
                metrics: {
                    linesOfCode: await this.countLinesOfCode(reactComp.filePath),
                    complexity: this.calculateReactComplexity(reactComp),
                    maintainability: this.calculateMaintainability(reactComp),
                    testCoverage: 0,
                    duplicateCode: 0,
                    technicalDebt: this.calculateTechnicalDebt(reactComp)
                },
                metadata: {
                    lineCount: await this.countLinesOfCode(reactComp.filePath),
                    complexity: this.calculateReactComplexity(reactComp),
                    lastModified: new Date(),
                    exports: [],
                    imports: [],
                    layer: 'presentation',
                    responsibilities: [`React ${reactComp.type} component`],
                    reactType: reactComp.type,
                    hooks: reactComp.hooks.map(h => h.name),
                    props: reactComp.props.map(p => p.name),
                    tags: [
                        ...(reactComp.hasEffects ? ['has-effects'] : []),
                        ...(reactComp.isMemoized ? ['memoized'] : []),
                        ...(reactComp.isLazy ? ['lazy'] : [])
                    ],
                    fields: [...reactComp.stateVariables, ...reactComp.contextConsumers]
                }
            };
            components.set(id, node);
        }
        const connections = await this.buildReactConnections();
        telemetry_schema_1.telemetry.emit({
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
            totalFiles: baseDiscovery.totalFiles,
            analyzedFiles: components.size,
            skippedFiles: baseDiscovery.totalFiles - components.size,
            components: Array.from(components.values())
        };
    }
    async discoverReactComponents() {
        const files = await this.findFiles(['**/*.{jsx,tsx}'], this.options.excludePatterns);
        for (const file of files) {
            const content = await fs.readFile(file, 'utf-8');
            const components = this.parseReactComponents(content, file);
            for (const component of components) {
                this.reactComponents.set(component.name, component);
                if (component.children.length > 0) {
                    this.componentHierarchy.set(component.name, component.children);
                }
            }
        }
        if (this.isNextJS) {
            await this.discoverNextJSRoutes();
        }
        else {
            await this.discoverReactRouterRoutes();
        }
    }
    parseReactComponents(content, filePath) {
        const components = [];
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
        const classComponentRegex = /class\s+(\w+)\s+extends\s+(?:React\.)?(?:Component|PureComponent)/g;
        while ((match = classComponentRegex.exec(content)) !== null) {
            const componentName = match[1];
            components.push({
                name: componentName,
                type: 'class',
                filePath,
                props: this.parseProps(content, componentName),
                hooks: [],
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
    parseProps(content, componentName) {
        const props = [];
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
    parseHooks(content, componentName) {
        const hooks = [];
        const hookRegex = /use(\w+)(?:\s*\([^)]*\))?/g;
        let match;
        while ((match = hookRegex.exec(content)) !== null) {
            const hookName = `use${match[1]}`;
            let type = 'custom';
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
    parseStateVariables(content) {
        const stateVars = [];
        const stateRegex = /const\s+\[(\w+),\s*set\w+\]\s*=\s*useState/g;
        let match;
        while ((match = stateRegex.exec(content)) !== null) {
            stateVars.push(match[1]);
        }
        return stateVars;
    }
    parseClassState(content) {
        const stateVars = [];
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
    parseContextConsumers(content) {
        const contexts = [];
        const contextRegex = /useContext\((\w+)\)/g;
        let match;
        while ((match = contextRegex.exec(content)) !== null) {
            contexts.push(match[1]);
        }
        return contexts;
    }
    parseChildComponents(content) {
        const children = [];
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
    parseImports(content) {
        const imports = [];
        const importRegex = /import\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/g;
        let match;
        while ((match = importRegex.exec(content)) !== null) {
            imports.push(match[1]);
        }
        return imports;
    }
    async discoverNextJSRoutes() {
        const appDir = path.join(this.projectPath, 'app');
        if (await fs.pathExists(appDir)) {
            this.routes = await this.parseNextJSAppRoutes(appDir);
        }
        else {
            const pagesDir = path.join(this.projectPath, 'pages');
            if (await fs.pathExists(pagesDir)) {
                this.routes = await this.parseNextJSPagesRoutes(pagesDir);
            }
        }
    }
    async parseNextJSAppRoutes(dir, basePath = '') {
        const routes = [];
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
                }
                else {
                    routes.push(...childRoutes);
                }
            }
        }
        return routes;
    }
    async parseNextJSPagesRoutes(dir, basePath = '') {
        const routes = [];
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory() && !entry.name.startsWith('_')) {
                const childRoutes = await this.parseNextJSPagesRoutes(fullPath, basePath + '/' + entry.name);
                routes.push(...childRoutes);
            }
            else if (entry.isFile() && (entry.name.endsWith('.tsx') || entry.name.endsWith('.jsx'))) {
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
    async discoverReactRouterRoutes() {
        const files = await this.findFiles(['**/*.{jsx,tsx}'], this.options.excludePatterns);
        for (const file of files) {
            const content = await fs.readFile(file, 'utf-8');
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
    mapReactComponentType(reactType) {
        switch (reactType) {
            case 'functional':
            case 'class':
                return 'utility';
            case 'lazy':
                return 'utility';
            default:
                return 'utility';
        }
    }
    calculateReactComplexity(component) {
        let complexity = 1;
        complexity += component.hooks.length * 2;
        if (component.hasEffects)
            complexity += 3;
        complexity += component.stateVariables.length;
        complexity += component.contextConsumers.length * 2;
        complexity += component.props.filter(p => p.required).length;
        return complexity;
    }
    calculateMaintainability(component) {
        let score = 100;
        const complexity = this.calculateReactComplexity(component);
        score -= Math.min(complexity * 2, 30);
        if (component.props.length > 10)
            score -= 10;
        if (component.props.length > 20)
            score -= 20;
        if (component.hooks.length > 5)
            score -= 10;
        if (component.hooks.length > 10)
            score -= 20;
        if (component.isMemoized)
            score += 5;
        return Math.max(score, 0);
    }
    calculateTechnicalDebt(component) {
        let debt = 0;
        const untypedProps = component.props.filter(p => p.type === 'any').length;
        debt += untypedProps * 2;
        if (component.dependencies.length > 20)
            debt += 10;
        const effectHooks = component.hooks.filter(h => h.type === 'effect');
        if (effectHooks.length > 3)
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
    async buildReactConnections() {
        const connections = [];
        for (const [parent, children] of this.componentHierarchy) {
            for (const child of children) {
                connections.push({
                    from: parent,
                    to: child,
                    type: 'contains',
                    protocol: 'react-component',
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
                        protocol: 'react-router',
                        metadata: {
                            callSites: 1,
                            path: route.path,
                            routePath: childRoute.path
                        }
                    });
                }
            }
        }
        if (this.stateManagement) {
            for (const store of this.stateManagement.stores) {
                for (const [name, component] of this.reactComponents) {
                    if (component.contextConsumers.includes(store) ||
                        component.dependencies.some(d => d.includes(store))) {
                        connections.push({
                            from: store,
                            to: name,
                            type: 'data_flow',
                            protocol: this.stateManagement.type,
                            metadata: {
                                callSites: 1,
                                dataFlow: 'store-consumer'
                            }
                        });
                    }
                }
            }
        }
        return connections;
    }
    findReactEntryPoints() {
        const entryPoints = [];
        if (this.isNextJS) {
            entryPoints.push('_app', 'layout');
        }
        else if (this.isGatsby) {
            entryPoints.push('gatsby-browser', 'gatsby-ssr');
        }
        else {
            entryPoints.push('index', 'App', 'main');
        }
        entryPoints.push(...this.routes.filter(r => r.path === '/' || r.path === '').map(r => r.component));
        return entryPoints;
    }
    buildReactLayers() {
        const layers = {
            'presentation': [],
            'containers': [],
            'components': [],
            'hooks': [],
            'state': [],
            'routing': [],
            'utilities': []
        };
        for (const [name, component] of this.reactComponents) {
            if (name.includes('Page') || name.includes('Screen')) {
                layers.presentation.push(name);
            }
            else if (name.includes('Container') || component.hooks.some(h => h.type === 'state' || h.type === 'effect')) {
                layers.containers.push(name);
            }
            else if (component.type === 'functional' && component.hooks.length === 0) {
                layers.components.push(name);
            }
            const customHooks = component.hooks.filter(h => h.type === 'custom');
            if (customHooks.length > 0) {
                layers.hooks.push(...customHooks.map(h => h.customHookName));
            }
        }
        if (this.stateManagement) {
            layers.state.push(...this.stateManagement.stores);
            layers.state.push(...this.stateManagement.actions);
        }
        layers.routing.push(...this.routes.map(r => r.component));
        return layers;
    }
    getReactConfigFiles() {
        const configs = [];
        if (this.isNextJS) {
            configs.push('next.config.js', 'next.config.ts');
        }
        else if (this.isGatsby) {
            configs.push('gatsby-config.js', 'gatsby-node.js');
        }
        else if (this.isCreateReactApp) {
            configs.push('config-overrides.js');
        }
        else if (this.isVite) {
            configs.push('vite.config.js', 'vite.config.ts');
        }
        configs.push('.babelrc', 'webpack.config.js', 'tsconfig.json');
        return configs;
    }
    async analyzePerformance() {
        const reactPerf = {
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
    calculateAverageProps() {
        const components = Array.from(this.reactComponents.values());
        if (components.length === 0)
            return 0;
        const totalProps = components.reduce((sum, c) => sum + c.props.length, 0);
        return totalProps / components.length;
    }
    calculateAverageHooks() {
        const components = Array.from(this.reactComponents.values()).filter(c => c.type === 'functional');
        if (components.length === 0)
            return 0;
        const totalHooks = components.reduce((sum, c) => sum + c.hooks.length, 0);
        return totalHooks / components.length;
    }
}
exports.ReactAnalyzer = ReactAnalyzer;
