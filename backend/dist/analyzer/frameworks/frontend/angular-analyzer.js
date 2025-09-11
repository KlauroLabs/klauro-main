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
exports.AngularAnalyzer = void 0;
const typescript_javascript_analyzer_1 = require("../../languages/typescript-javascript-analyzer");
const telemetry_schema_1 = require("../../../telemetry/telemetry-schema");
const path = __importStar(require("path"));
const fs = __importStar(require("fs-extra"));
class AngularAnalyzer extends typescript_javascript_analyzer_1.TypeScriptJavaScriptAnalyzer {
    constructor() {
        super(...arguments);
        this.angularVersion = '';
        this.components = new Map();
        this.modules = new Map();
        this.services = new Map();
        this.routes = [];
        this.isStandalone = false;
        this.hasNgRx = false;
        this.hasUniversal = false;
        this.hasPWA = false;
    }
    getAnalyzerName() {
        return 'Angular Framework Analyzer';
    }
    getSupportedFrameworks() {
        return ['angular', 'ionic'];
    }
    async detectLanguageAndFramework() {
        const baseDetection = await super.detectLanguageAndFramework();
        const angularJsonPath = path.join(this.projectPath, 'angular.json');
        if (await fs.pathExists(angularJsonPath)) {
            const angularJson = await fs.readJson(angularJsonPath);
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
    async discoverComponents() {
        const span = telemetry_schema_1.telemetry.createSpan('angular-analyzer.discoverComponents');
        const baseDiscovery = await super.discoverComponents();
        await this.discoverAngularComponents();
        await this.discoverAngularModules();
        await this.discoverAngularServices();
        await this.discoverAngularRoutes();
        const components = new Map();
        for (const [id, angularComp] of this.components) {
            const node = {
                id,
                name: angularComp.name,
                type: this.mapAngularType(angularComp.type),
                path: angularComp.filePath,
                language: 'typescript',
                framework: 'angular',
                dependencies: angularComp.dependencies,
                dependents: [],
                metrics: {
                    linesOfCode: await this.countLinesOfCode(angularComp.filePath),
                    complexity: this.calculateAngularComplexity(angularComp),
                    maintainability: this.calculateMaintainability(angularComp),
                    testCoverage: 0,
                    duplicateCode: 0,
                    technicalDebt: this.calculateTechnicalDebt(angularComp)
                },
                metadata: {
                    lineCount: 0,
                    complexity: angularComp.inputs.length + angularComp.outputs.length,
                    lastModified: new Date(),
                    exports: [angularComp.name],
                    imports: angularComp.dependencies,
                    layer: 'presentation',
                    responsibilities: [`Angular ${angularComp.type} component`],
                    angularType: angularComp.type,
                    selector: angularComp.selector,
                }
            };
            components.set(id, node);
        }
        for (const [id, service] of this.services) {
            const node = {
                id,
                name: service.name,
                type: 'service',
                path: service.filePath,
                language: 'typescript',
                framework: 'angular',
                dependencies: service.dependencies,
                dependents: [],
                metrics: {
                    linesOfCode: await this.countLinesOfCode(service.filePath),
                    complexity: service.methods.length + service.observables.length,
                    maintainability: 100 - (service.methods.length * 2),
                    testCoverage: 0,
                    duplicateCode: 0,
                    technicalDebt: 0
                },
                metadata: {
                    lineCount: 0,
                    complexity: service.methods.length + service.observables.length,
                    lastModified: new Date(),
                    exports: [service.name],
                    imports: service.dependencies,
                    layer: 'business',
                    responsibilities: [`Angular service providing ${service.providedIn} functionality`],
                    angularType: 'service',
                    providedIn: service.providedIn,
                    methods: service.methods
                }
            };
            components.set(id, node);
        }
        const connections = await this.buildAngularConnections();
        telemetry_schema_1.telemetry.emit({
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
    async discoverAngularComponents() {
        const componentFiles = await this.findFiles(['**/*.component.ts'], this.options.excludePatterns);
        const directiveFiles = await this.findFiles(['**/*.directive.ts'], this.options.excludePatterns);
        const pipeFiles = await this.findFiles(['**/*.pipe.ts'], this.options.excludePatterns);
        for (const file of componentFiles) {
            const content = await fs.readFile(file, 'utf-8');
            const component = this.parseAngularComponent(content, file);
            if (component) {
                this.components.set(component.name, component);
            }
        }
        for (const file of directiveFiles) {
            const content = await fs.readFile(file, 'utf-8');
            const directive = this.parseAngularDirective(content, file);
            if (directive) {
                this.components.set(directive.name, directive);
            }
        }
        for (const file of pipeFiles) {
            const content = await fs.readFile(file, 'utf-8');
            const pipe = this.parseAngularPipe(content, file);
            if (pipe) {
                this.components.set(pipe.name, pipe);
            }
        }
    }
    parseAngularComponent(content, filePath) {
        const componentMatch = content.match(/@Component\s*\(\s*{([^}]+)}\s*\)/s);
        if (!componentMatch)
            return null;
        const metadata = componentMatch[1];
        const classMatch = content.match(/export\s+class\s+(\w+)/);
        if (!classMatch)
            return null;
        const name = classMatch[1];
        const selector = this.extractMetadataValue(metadata, 'selector');
        let templatePath;
        const templateUrl = this.extractMetadataValue(metadata, 'templateUrl');
        if (templateUrl) {
            templatePath = path.join(path.dirname(filePath), templateUrl);
        }
        const styleUrls = this.extractMetadataArray(metadata, 'styleUrls');
        const stylePaths = styleUrls.map(url => path.join(path.dirname(filePath), url));
        const standalone = metadata.includes('standalone: true');
        const inputs = this.parseInputs(content);
        const outputs = this.parseOutputs(content);
        const lifecycle = this.parseLifecycleHooks(content);
        const changeDetection = this.extractChangeDetection(metadata);
        const encapsulation = this.extractEncapsulation(metadata);
        const providers = this.extractMetadataArray(metadata, 'providers');
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
    parseAngularDirective(content, filePath) {
        const directiveMatch = content.match(/@Directive\s*\(\s*{([^}]+)}\s*\)/s);
        if (!directiveMatch)
            return null;
        const metadata = directiveMatch[1];
        const classMatch = content.match(/export\s+class\s+(\w+)/);
        if (!classMatch)
            return null;
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
    parseAngularPipe(content, filePath) {
        const pipeMatch = content.match(/@Pipe\s*\(\s*{([^}]+)}\s*\)/s);
        if (!pipeMatch)
            return null;
        const metadata = pipeMatch[1];
        const classMatch = content.match(/export\s+class\s+(\w+)/);
        if (!classMatch)
            return null;
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
    async discoverAngularModules() {
        const moduleFiles = await this.findFiles(['**/*.module.ts'], this.options.excludePatterns);
        for (const file of moduleFiles) {
            const content = await fs.readFile(file, 'utf-8');
            const module = this.parseAngularModule(content, file);
            if (module) {
                this.modules.set(module.name, module);
            }
        }
    }
    parseAngularModule(content, filePath) {
        const moduleMatch = content.match(/@NgModule\s*\(\s*{([^}]+)}\s*\)/s);
        if (!moduleMatch)
            return null;
        const metadata = moduleMatch[1];
        const classMatch = content.match(/export\s+class\s+(\w+)/);
        if (!classMatch)
            return null;
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
    async discoverAngularServices() {
        const serviceFiles = await this.findFiles(['**/*.service.ts'], this.options.excludePatterns);
        for (const file of serviceFiles) {
            const content = await fs.readFile(file, 'utf-8');
            const service = this.parseAngularService(content, file);
            if (service) {
                this.services.set(service.name, service);
            }
        }
    }
    parseAngularService(content, filePath) {
        const injectableMatch = content.match(/@Injectable\s*\(\s*({[^}]*})?\s*\)/s);
        if (!injectableMatch)
            return null;
        const metadata = injectableMatch[1] || '{}';
        const classMatch = content.match(/export\s+class\s+(\w+)/);
        if (!classMatch)
            return null;
        const name = classMatch[1];
        let providedIn = 'root';
        const providedInMatch = metadata.match(/providedIn:\s*['"]([^'"]+)['"]/);
        if (providedInMatch) {
            providedIn = providedInMatch[1];
        }
        const dependencies = this.parseConstructorDependencies(content);
        const methods = this.parseMethods(content);
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
    async discoverAngularRoutes() {
        const routingFiles = await this.findFiles(['**/*-routing.module.ts', '**/app.routes.ts'], this.options.excludePatterns);
        for (const file of routingFiles) {
            const content = await fs.readFile(file, 'utf-8');
            const routes = this.parseAngularRoutes(content);
            this.routes.push(...routes);
        }
    }
    parseAngularRoutes(content) {
        const routes = [];
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
    parseRoute(routeStr) {
        const pathMatch = routeStr.match(/path:\s*['"]([^'"]*)['"]/);
        if (!pathMatch)
            return null;
        const path = pathMatch[1];
        const componentMatch = routeStr.match(/component:\s*(\w+)/);
        const loadChildrenMatch = routeStr.match(/loadChildren:\s*\(\)\s*=>\s*import\(['"]([^'"]+)['"]\)/);
        const route = {
            path,
            component: componentMatch ? componentMatch[1] : undefined,
            loadChildren: loadChildrenMatch ? loadChildrenMatch[1] : undefined,
            children: []
        };
        const canActivateMatch = routeStr.match(/canActivate:\s*\[([^\]]+)\]/);
        if (canActivateMatch) {
            route.canActivate = canActivateMatch[1].split(',').map(g => g.trim());
        }
        return route;
    }
    extractMetadataValue(metadata, key) {
        const regex = new RegExp(`${key}:\\s*['"]([^'"]+)['"]`);
        const match = metadata.match(regex);
        return match ? match[1] : null;
    }
    extractMetadataArray(metadata, key) {
        const regex = new RegExp(`${key}:\\s*\\[([^\\]]+)\\]`, 's');
        const match = metadata.match(regex);
        if (!match)
            return [];
        const content = match[1];
        const items = [];
        const itemRegex = /(\w+)(?:\s*,)?/g;
        let itemMatch;
        while ((itemMatch = itemRegex.exec(content)) !== null) {
            items.push(itemMatch[1]);
        }
        return items;
    }
    extractChangeDetection(metadata) {
        if (metadata.includes('ChangeDetectionStrategy.OnPush')) {
            return 'OnPush';
        }
        return 'Default';
    }
    extractEncapsulation(metadata) {
        if (metadata.includes('ViewEncapsulation.None')) {
            return 'None';
        }
        if (metadata.includes('ViewEncapsulation.ShadowDom')) {
            return 'ShadowDom';
        }
        return 'Emulated';
    }
    parseInputs(content) {
        const inputs = [];
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
    parseOutputs(content) {
        const outputs = [];
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
    parseLifecycleHooks(content) {
        const lifecycle = [];
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
    parseConstructorDependencies(content) {
        const dependencies = [];
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
    parseMethods(content) {
        const methods = [];
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
    parseObservables(content) {
        const observables = [];
        const observableRegex = /(\w+)\$?\s*:\s*Observable<[^>]+>/g;
        let match;
        while ((match = observableRegex.exec(content)) !== null) {
            observables.push(match[1]);
        }
        return observables;
    }
    parseSubjects(content) {
        const subjects = [];
        const subjectRegex = /(\w+)\s*=\s*new\s+(?:Subject|BehaviorSubject|ReplaySubject|AsyncSubject)/g;
        let match;
        while ((match = subjectRegex.exec(content)) !== null) {
            subjects.push(match[1]);
        }
        return subjects;
    }
    mapAngularType(type) {
        switch (type) {
            case 'component':
                return 'utility';
            case 'service':
                return 'service';
            case 'module':
                return 'utility';
            case 'directive':
            case 'pipe':
                return 'utility';
            case 'guard':
            case 'interceptor':
                return 'middleware';
            default:
                return 'utility';
        }
    }
    calculateAngularComplexity(component) {
        let complexity = 1;
        complexity += component.inputs.length * 2;
        complexity += component.outputs.length * 2;
        complexity += component.providers.length;
        complexity += component.dependencies.length;
        complexity += component.lifecycle.length;
        if (component.changeDetection === 'OnPush')
            complexity -= 2;
        if (!component.standalone)
            complexity += 3;
        return Math.max(complexity, 1);
    }
    calculateMaintainability(component) {
        let score = 100;
        const complexity = this.calculateAngularComplexity(component);
        score -= Math.min(complexity * 3, 40);
        if (component.inputs.length > 10)
            score -= 15;
        if (component.outputs.length > 5)
            score -= 10;
        if (component.dependencies.length > 8)
            score -= 10;
        if (component.changeDetection === 'OnPush')
            score += 5;
        if (component.standalone)
            score += 5;
        return Math.max(score, 0);
    }
    calculateTechnicalDebt(component) {
        let debt = 0;
        if (this.angularVersion.startsWith('^14') || this.angularVersion.startsWith('^15') ||
            this.angularVersion.startsWith('^16') || this.angularVersion.startsWith('^17')) {
            if (!component.standalone && component.type === 'component') {
                debt += 5;
            }
        }
        if (component.changeDetection === 'Default') {
            debt += 3;
        }
        if (component.inputs.length > 10) {
            debt += 5;
        }
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
    async buildAngularConnections() {
        const connections = [];
        for (const [moduleName, module] of this.modules) {
            for (const declaration of module.declarations) {
                connections.push({
                    from: moduleName,
                    to: declaration,
                    type: 'contains',
                    protocol: 'angular-module',
                    metadata: {
                        callSites: 1,
                        relationship: 'declares'
                    }
                });
            }
            for (const importName of module.imports) {
                connections.push({
                    from: moduleName,
                    to: importName,
                    type: 'dependency',
                    protocol: 'angular-module',
                    metadata: {
                        callSites: 1,
                        relationship: 'imports'
                    }
                });
            }
        }
        for (const [name, component] of this.components) {
            for (const dep of component.dependencies) {
                connections.push({
                    from: name,
                    to: dep,
                    type: 'dependency',
                    protocol: 'angular-di',
                    metadata: {
                        callSites: 1,
                        relationship: 'injects'
                    }
                });
            }
        }
        for (const [name, service] of this.services) {
            for (const dep of service.dependencies) {
                connections.push({
                    from: name,
                    to: dep,
                    type: 'dependency',
                    protocol: 'angular-di',
                    metadata: {
                        callSites: 1,
                        relationship: 'injects'
                    }
                });
            }
        }
        for (const route of this.routes) {
            if (route.component) {
                connections.push({
                    from: 'router',
                    to: route.component,
                    type: 'navigation',
                    protocol: 'angular-router',
                    metadata: {
                        callSites: 1,
                        path: route.path
                    }
                });
            }
            if (route.canActivate) {
                for (const guard of route.canActivate) {
                    connections.push({
                        from: guard,
                        to: route.component || route.path,
                        type: 'guards',
                        protocol: 'angular-router',
                        metadata: {
                            callSites: 1,
                            guardType: 'canActivate'
                        }
                    });
                }
            }
        }
        return connections;
    }
    findAngularEntryPoints() {
        const entryPoints = [];
        for (const module of this.modules.values()) {
            entryPoints.push(...module.bootstrap);
        }
        entryPoints.push('AppModule', 'AppComponent');
        if (this.isStandalone) {
            entryPoints.push('main');
        }
        return entryPoints;
    }
    buildAngularLayers() {
        const layers = {
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
    async analyzePerformance() {
        return {
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
    calculateAverageInputs() {
        const components = Array.from(this.components.values()).filter(c => c.type === 'component');
        if (components.length === 0)
            return 0;
        const totalInputs = components.reduce((sum, c) => sum + c.inputs.length, 0);
        return totalInputs / components.length;
    }
    calculateAverageOutputs() {
        const components = Array.from(this.components.values()).filter(c => c.type === 'component');
        if (components.length === 0)
            return 0;
        const totalOutputs = components.reduce((sum, c) => sum + c.outputs.length, 0);
        return totalOutputs / components.length;
    }
}
exports.AngularAnalyzer = AngularAnalyzer;
