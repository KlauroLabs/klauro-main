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
exports.NextJSAnalyzer = void 0;
const react_analyzer_1 = require("./react-analyzer");
const telemetry_schema_1 = require("../../../telemetry/telemetry-schema");
const path = __importStar(require("path"));
const fs = __importStar(require("fs-extra"));
class NextJSAnalyzer extends react_analyzer_1.ReactAnalyzer {
    constructor() {
        super(...arguments);
        this.nextVersion = '';
        this.pages = new Map();
        this.apiRoutes = new Map();
        this.isAppRouter = false;
        this.isPagesRouter = false;
        this.hasI18n = false;
        this.hasMiddleware = false;
        this.config = null;
        this.publicAssets = [];
    }
    getAnalyzerName() {
        return 'Next.js Framework Analyzer';
    }
    getSupportedFrameworks() {
        return ['next', 'nextjs'];
    }
    async detectLanguageAndFramework() {
        const baseDetection = await super.detectLanguageAndFramework();
        const packageJsonPath = path.join(this.projectPath, 'package.json');
        if (await fs.pathExists(packageJsonPath)) {
            const packageJson = await fs.readJson(packageJsonPath);
            const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
            this.nextVersion = deps.next || '';
            const appDir = path.join(this.projectPath, 'app');
            const pagesDir = path.join(this.projectPath, 'pages');
            const srcAppDir = path.join(this.projectPath, 'src', 'app');
            const srcPagesDir = path.join(this.projectPath, 'src', 'pages');
            this.isAppRouter = await fs.pathExists(appDir) || await fs.pathExists(srcAppDir);
            this.isPagesRouter = await fs.pathExists(pagesDir) || await fs.pathExists(srcPagesDir);
            this.hasMiddleware = await fs.pathExists(path.join(this.projectPath, 'middleware.ts')) ||
                await fs.pathExists(path.join(this.projectPath, 'middleware.js'));
        }
        await this.loadNextConfig();
        return {
            ...baseDetection,
            frameworks: [...baseDetection.frameworks.filter((f) => f.name !== 'react'), {
                    name: 'next',
                    version: this.nextVersion,
                    confidence: 0.98,
                    patterns: ['Next.js app detected'],
                    configFiles: ['next.config.js', 'next.config.mjs', 'next.config.ts'],
                    dependencies: ['next', 'react', 'react-dom']
                }]
        };
    }
    async discoverComponents() {
        const span = telemetry_schema_1.telemetry.createSpan('nextjs-analyzer.discoverComponents');
        const baseDiscovery = await super.discoverComponents();
        await this.discoverNextJSPages();
        await this.discoverAPIRoutes();
        await this.discoverPublicAssets();
        const components = new Map();
        for (const component of baseDiscovery.components) {
            components.set(component.id, component);
        }
        for (const [id, page] of this.pages) {
            const node = {
                id,
                name: page.name,
                type: this.mapNextJSPageType(page.type),
                path: page.filePath,
                language: 'typescript',
                framework: 'nextjs',
                dependencies: [],
                dependents: [],
                metrics: {
                    linesOfCode: await this.countLinesOfCode(page.filePath),
                    complexity: this.calculatePageComplexity(page),
                    maintainability: this.calculatePageMaintainability(page),
                    testCoverage: 0,
                    duplicateCode: 0,
                    technicalDebt: this.calculatePageTechnicalDebt(page)
                },
                metadata: {
                    lineCount: 0,
                    complexity: page.dataFetching.length,
                    lastModified: new Date(),
                    exports: page.exports,
                    imports: [],
                    layer: 'presentation',
                    responsibilities: [`Next.js ${page.type} page`],
                    nextjsType: page.type,
                    path: page.path,
                    tags: page.isDynamic ? ['dynamic'] : []
                }
            };
            components.set(id, node);
        }
        const connections = await this.buildNextJSConnections([]);
        const apiEndpoints = await this.extractAPIEndpoints();
        telemetry_schema_1.telemetry.emit({
            type: 'component_discovery_completed',
            source: { analyzer: this.getAnalyzerName() },
            data: {
                totalComponents: components.size,
                pages: this.pages.size,
                apiRoutes: this.apiRoutes.size,
                isAppRouter: this.isAppRouter,
                isPagesRouter: this.isPagesRouter,
                hasMiddleware: this.hasMiddleware
            }
        });
        span.end();
        return {
            components: Array.from(components.values()),
            entryPoints: this.findNextJSEntryPoints(),
            connections,
            layers: this.buildNextJSLayers(),
            apiEndpoints
        };
    }
    async loadNextConfig() {
        const configPaths = [
            'next.config.js',
            'next.config.mjs',
            'next.config.ts'
        ];
        for (const configFile of configPaths) {
            const configPath = path.join(this.projectPath, configFile);
            if (await fs.pathExists(configPath)) {
                try {
                    const content = await fs.readFile(configPath, 'utf-8');
                    this.config = this.parseNextConfig(content);
                    if (this.config?.i18n) {
                        this.hasI18n = true;
                    }
                    break;
                }
                catch (error) {
                    console.warn(`Failed to parse Next.js config: ${error}`);
                }
            }
        }
    }
    parseNextConfig(content) {
        const config = {
            reactStrictMode: content.includes('reactStrictMode: true'),
            swcMinify: content.includes('swcMinify: true'),
            experimental: {},
            images: {}
        };
        const i18nMatch = content.match(/i18n:\s*{([^}]+)}/s);
        if (i18nMatch) {
            config.i18n = {};
        }
        if (content.includes('redirects')) {
            config.redirects = [];
        }
        if (content.includes('rewrites')) {
            config.rewrites = [];
        }
        if (content.includes('headers')) {
            config.headers = [];
        }
        return config;
    }
    async discoverNextJSPages() {
        if (this.isAppRouter) {
            await this.discoverAppRouterPages();
        }
        if (this.isPagesRouter) {
            await this.discoverPagesRouterPages();
        }
    }
    async discoverAppRouterPages() {
        const appDirs = [
            path.join(this.projectPath, 'app'),
            path.join(this.projectPath, 'src', 'app')
        ];
        for (const appDir of appDirs) {
            if (await fs.pathExists(appDir)) {
                await this.scanAppDirectory(appDir, '');
            }
        }
    }
    async scanAppDirectory(dir, routePath) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                const isRouteGroup = entry.name.startsWith('(') && entry.name.endsWith(')');
                const newRoutePath = isRouteGroup ? routePath : `${routePath}/${entry.name}`;
                await this.scanAppDirectory(fullPath, newRoutePath);
            }
            else if (entry.isFile()) {
                const page = await this.parseAppRouterFile(fullPath, routePath, entry.name);
                if (page) {
                    this.pages.set(page.name, page);
                }
            }
        }
    }
    async parseAppRouterFile(filePath, routePath, fileName) {
        const baseName = path.basename(fileName, path.extname(fileName));
        const specialFiles = ['page', 'layout', 'loading', 'error', 'not-found', 'template'];
        if (!specialFiles.includes(baseName)) {
            return null;
        }
        const content = await fs.readFile(filePath, 'utf-8');
        const isClientComponent = content.includes("'use client'") || content.includes('"use client"');
        const isServerComponent = !isClientComponent;
        const exports = this.parseExports(content);
        const dataFetching = this.parseAppRouterDataFetching(content);
        const metadata = this.parseMetadata(content);
        const isDynamic = routePath.includes('[') && routePath.includes(']');
        return {
            name: `${routePath || '/'}/${baseName}`,
            path: routePath || '/',
            filePath,
            type: baseName,
            isServerComponent,
            isClientComponent,
            isDynamic,
            hasGetServerSideProps: false,
            hasGetStaticProps: false,
            hasGetStaticPaths: false,
            dataFetching,
            metadata,
            exports
        };
    }
    async discoverPagesRouterPages() {
        const pagesDirs = [
            path.join(this.projectPath, 'pages'),
            path.join(this.projectPath, 'src', 'pages')
        ];
        for (const pagesDir of pagesDirs) {
            if (await fs.pathExists(pagesDir)) {
                await this.scanPagesDirectory(pagesDir, '');
            }
        }
    }
    async scanPagesDirectory(dir, routePath) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!entry.name.startsWith('_') && entry.name !== 'api') {
                    const newRoutePath = `${routePath}/${entry.name}`;
                    await this.scanPagesDirectory(fullPath, newRoutePath);
                }
                else if (entry.name === 'api') {
                    await this.scanAPIDirectory(fullPath, '/api');
                }
            }
            else if (entry.isFile() && (entry.name.endsWith('.tsx') || entry.name.endsWith('.jsx') ||
                entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
                if (!entry.name.startsWith('_')) {
                    const page = await this.parsePagesRouterFile(fullPath, routePath, entry.name);
                    if (page) {
                        this.pages.set(page.name, page);
                    }
                }
            }
        }
    }
    async parsePagesRouterFile(filePath, routePath, fileName) {
        const baseName = path.basename(fileName, path.extname(fileName));
        const content = await fs.readFile(filePath, 'utf-8');
        let pagePath = routePath;
        if (baseName === 'index') {
            pagePath = routePath || '/';
        }
        else {
            pagePath = `${routePath}/${baseName}`;
        }
        const isDynamic = baseName.includes('[') && baseName.includes(']');
        const hasGetServerSideProps = content.includes('getServerSideProps');
        const hasGetStaticProps = content.includes('getStaticProps');
        const hasGetStaticPaths = content.includes('getStaticPaths');
        const dataFetching = [];
        if (hasGetServerSideProps) {
            dataFetching.push({
                type: 'getServerSideProps',
                isAsync: true,
                dependencies: this.parseDataFetchingDependencies(content, 'getServerSideProps')
            });
        }
        if (hasGetStaticProps) {
            const revalidate = this.parseRevalidate(content);
            dataFetching.push({
                type: 'getStaticProps',
                isAsync: true,
                revalidate,
                dependencies: this.parseDataFetchingDependencies(content, 'getStaticProps')
            });
        }
        if (hasGetStaticPaths) {
            dataFetching.push({
                type: 'getStaticPaths',
                isAsync: true,
                dependencies: this.parseDataFetchingDependencies(content, 'getStaticPaths')
            });
        }
        const exports = this.parseExports(content);
        return {
            name: pagePath,
            path: pagePath,
            filePath,
            type: 'page',
            isServerComponent: false,
            isClientComponent: true,
            isDynamic,
            hasGetServerSideProps,
            hasGetStaticProps,
            hasGetStaticPaths,
            dataFetching,
            exports
        };
    }
    async discoverAPIRoutes() {
        if (this.isAppRouter) {
            await this.discoverAppRouterAPIRoutes();
        }
        if (this.isPagesRouter) {
            await this.discoverPagesRouterAPIRoutes();
        }
    }
    async discoverAppRouterAPIRoutes() {
        const appDirs = [
            path.join(this.projectPath, 'app'),
            path.join(this.projectPath, 'src', 'app')
        ];
        for (const appDir of appDirs) {
            if (await fs.pathExists(appDir)) {
                await this.scanAppRouterForAPIRoutes(appDir, '');
            }
        }
    }
    async scanAppRouterForAPIRoutes(dir, routePath) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                const isRouteGroup = entry.name.startsWith('(') && entry.name.endsWith(')');
                const newRoutePath = isRouteGroup ? routePath : `${routePath}/${entry.name}`;
                await this.scanAppRouterForAPIRoutes(fullPath, newRoutePath);
            }
            else if (entry.isFile() && entry.name === 'route.ts' || entry.name === 'route.js') {
                const apiRoute = await this.parseAppRouterAPIRoute(fullPath, routePath);
                if (apiRoute) {
                    this.apiRoutes.set(apiRoute.path, apiRoute);
                }
            }
        }
    }
    async parseAppRouterAPIRoute(filePath, routePath) {
        const content = await fs.readFile(filePath, 'utf-8');
        const methods = [];
        const handlers = [];
        const httpMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
        for (const method of httpMethods) {
            if (content.includes(`export async function ${method}`) ||
                content.includes(`export function ${method}`)) {
                methods.push(method);
                handlers.push({
                    method: method,
                    isAsync: content.includes(`export async function ${method}`),
                    parameters: this.parseHandlerParameters(content, method),
                    responses: this.parseHandlerResponses(content, method)
                });
            }
        }
        const isEdgeRuntime = content.includes("runtime = 'edge'") || content.includes('runtime = "edge"');
        return {
            path: routePath || '/',
            filePath,
            methods,
            middleware: [],
            isEdgeRuntime,
            handlers
        };
    }
    async discoverPagesRouterAPIRoutes() {
        const apiDirs = [
            path.join(this.projectPath, 'pages', 'api'),
            path.join(this.projectPath, 'src', 'pages', 'api')
        ];
        for (const apiDir of apiDirs) {
            if (await fs.pathExists(apiDir)) {
                await this.scanAPIDirectory(apiDir, '/api');
            }
        }
    }
    async scanAPIDirectory(dir, routePath) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                const newRoutePath = `${routePath}/${entry.name}`;
                await this.scanAPIDirectory(fullPath, newRoutePath);
            }
            else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
                const apiRoute = await this.parsePagesRouterAPIRoute(fullPath, routePath, entry.name);
                if (apiRoute) {
                    this.apiRoutes.set(apiRoute.path, apiRoute);
                }
            }
        }
    }
    async parsePagesRouterAPIRoute(filePath, routePath, fileName) {
        const baseName = path.basename(fileName, path.extname(fileName));
        const content = await fs.readFile(filePath, 'utf-8');
        let apiPath = routePath;
        if (baseName !== 'index') {
            apiPath = `${routePath}/${baseName}`;
        }
        const handlers = [];
        const methods = [];
        const methodCheckRegex = /req\.method\s*===?\s*['"](\w+)['"]/g;
        let match;
        while ((match = methodCheckRegex.exec(content)) !== null) {
            const method = match[1];
            if (!methods.includes(method)) {
                methods.push(method);
                handlers.push({
                    method: method,
                    isAsync: content.includes('async'),
                    parameters: [],
                    responses: []
                });
            }
        }
        if (methods.length === 0) {
            methods.push('GET', 'POST');
        }
        const isEdgeRuntime = content.includes("runtime: 'edge'") || content.includes('runtime: "edge"');
        return {
            path: apiPath,
            filePath,
            methods,
            middleware: [],
            isEdgeRuntime,
            handlers
        };
    }
    async discoverPublicAssets() {
        const publicDir = path.join(this.projectPath, 'public');
        if (await fs.pathExists(publicDir)) {
            const { glob } = await Promise.resolve().then(() => __importStar(require('glob')));
            const files = await glob('**/*', { cwd: publicDir, absolute: true });
            this.publicAssets = files.map(file => path.relative(publicDir, file));
        }
    }
    parseExports(content) {
        const exports = [];
        const namedExportRegex = /export\s+(?:const|let|var|function|class)\s+(\w+)/g;
        let match;
        while ((match = namedExportRegex.exec(content)) !== null) {
            exports.push(match[1]);
        }
        if (content.includes('export default')) {
            exports.push('default');
        }
        return exports;
    }
    parseAppRouterDataFetching(content) {
        const dataFetching = [];
        const fetchRegex = /fetch\s*\([^)]+\)/g;
        const fetchMatches = content.match(fetchRegex);
        if (fetchMatches) {
            for (const fetchCall of fetchMatches) {
                const revalidateMatch = fetchCall.match(/revalidate:\s*(\d+)/);
                dataFetching.push({
                    type: 'fetch',
                    isAsync: true,
                    revalidate: revalidateMatch ? parseInt(revalidateMatch[1]) : undefined,
                    dependencies: []
                });
            }
        }
        if (content.includes('generateMetadata')) {
            dataFetching.push({
                type: 'generateMetadata',
                isAsync: true,
                dependencies: []
            });
        }
        if (content.includes('generateStaticParams')) {
            dataFetching.push({
                type: 'generateStaticParams',
                isAsync: true,
                dependencies: []
            });
        }
        return dataFetching;
    }
    parseMetadata(content) {
        const metadataMatch = content.match(/export\s+const\s+metadata\s*(?::\s*Metadata\s*)?=\s*{([^}]+)}/s);
        if (metadataMatch) {
            const metadata = {};
            const metadataContent = metadataMatch[1];
            const titleMatch = metadataContent.match(/title:\s*['"`]([^'"`]+)['"`]/);
            if (titleMatch) {
                metadata.title = titleMatch[1];
            }
            const descMatch = metadataContent.match(/description:\s*['"`]([^'"`]+)['"`]/);
            if (descMatch) {
                metadata.description = descMatch[1];
            }
            return metadata;
        }
        return undefined;
    }
    parseDataFetchingDependencies(content, methodName) {
        const dependencies = [];
        const methodRegex = new RegExp(`export\\s+(?:async\\s+)?function\\s+${methodName}\\s*\\([^)]*\\)\\s*{([^}]+)}`, 's');
        const methodMatch = content.match(methodRegex);
        if (methodMatch) {
            const methodContent = methodMatch[1];
            const importRegex = /import\s+(?:{[^}]+}|\w+)\s+from\s+['"]([^'"]+)['"]/g;
            let match;
            while ((match = importRegex.exec(content)) !== null) {
                const importPath = match[1];
                if (methodContent.includes(match[1]) || methodContent.includes(importPath)) {
                    dependencies.push(importPath);
                }
            }
        }
        return dependencies;
    }
    parseRevalidate(content) {
        const revalidateMatch = content.match(/revalidate:\s*(\d+)/);
        return revalidateMatch ? parseInt(revalidateMatch[1]) : undefined;
    }
    parseHandlerParameters(content, method) {
        const parameters = [];
        const handlerRegex = new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\s*\\(([^)]*)\\)`, 's');
        const match = content.match(handlerRegex);
        if (match) {
            const params = match[1];
            const paramRegex = /(\w+)(?:\s*:\s*[^,)]+)?/g;
            let paramMatch;
            while ((paramMatch = paramRegex.exec(params)) !== null) {
                parameters.push(paramMatch[1]);
            }
        }
        return parameters;
    }
    parseHandlerResponses(content, method) {
        const responses = [];
        if (content.includes('NextResponse')) {
            if (content.includes('NextResponse.json'))
                responses.push('json');
            if (content.includes('NextResponse.redirect'))
                responses.push('redirect');
            if (content.includes('NextResponse.rewrite'))
                responses.push('rewrite');
            if (content.includes('NextResponse.next'))
                responses.push('next');
        }
        if (content.includes('new Response')) {
            responses.push('response');
        }
        return responses;
    }
    mapNextJSPageType(type) {
        switch (type) {
            case 'page':
                return 'utility';
            case 'api':
                return 'controller';
            case 'middleware':
                return 'middleware';
            case 'layout':
            case 'loading':
            case 'error':
            case 'not-found':
                return 'utility';
            default:
                return 'utility';
        }
    }
    calculatePageComplexity(page) {
        let complexity = 1;
        complexity += page.dataFetching.length * 3;
        if (page.isDynamic)
            complexity += 2;
        if (page.hasGetServerSideProps)
            complexity += 3;
        if (page.hasGetStaticProps)
            complexity += 2;
        if (page.hasGetStaticPaths)
            complexity += 3;
        if (page.isServerComponent)
            complexity += 1;
        return complexity;
    }
    calculatePageMaintainability(page) {
        let score = 100;
        const complexity = this.calculatePageComplexity(page);
        score -= Math.min(complexity * 3, 40);
        if (page.isServerComponent && this.isAppRouter)
            score += 5;
        if (page.type === 'layout')
            score += 3;
        return Math.max(score, 0);
    }
    calculatePageTechnicalDebt(page) {
        let debt = 0;
        if (this.nextVersion.startsWith('13') || this.nextVersion.startsWith('14')) {
            if (!this.isAppRouter && page.type === 'page') {
                debt += 3;
            }
        }
        if (page.hasGetServerSideProps && page.hasGetStaticProps) {
            debt += 10;
        }
        return debt;
    }
    async buildNextJSConnections(baseConnections) {
        const connections = [...baseConnections];
        for (const [name, page] of this.pages) {
            if (page.type === 'layout') {
                const childPages = Array.from(this.pages.values()).filter(p => p.path.startsWith(page.path) && p.path !== page.path);
                for (const child of childPages) {
                    connections.push({
                        from: name,
                        to: child.name,
                        type: 'contains',
                        protocol: 'nextjs-layout',
                        metadata: {
                            callSites: 1,
                            layoutType: 'layout'
                        }
                    });
                }
            }
        }
        for (const [path, apiRoute] of this.apiRoutes) {
            for (const [pageName, page] of this.pages) {
                if (page.dataFetching.some(df => df.type === 'fetch')) {
                    connections.push({
                        from: pageName,
                        to: path,
                        type: 'api-call',
                        protocol: 'http',
                        metadata: {
                            callSites: 1,
                            methods: apiRoute.methods
                        }
                    });
                }
            }
        }
        if (this.hasMiddleware) {
            for (const [name, page] of this.pages) {
                connections.push({
                    from: 'middleware',
                    to: name,
                    type: 'intercepts',
                    protocol: 'nextjs-middleware',
                    metadata: {
                        callSites: 1,
                        pageType: page.type
                    }
                });
            }
        }
        return connections;
    }
    async extractAPIEndpoints() {
        const endpoints = [];
        for (const [path, apiRoute] of this.apiRoutes) {
            for (const handler of apiRoute.handlers) {
                endpoints.push({
                    id: `nextjs-api-${path.replace(/\//g, '-')}-${handler.method}`,
                    path: path,
                    method: handler.method,
                    description: `${handler.method} ${path}`,
                    handler: path,
                    parameters: handler.parameters.map(p => ({
                        name: p,
                        type: 'query',
                        dataType: 'string',
                        required: false
                    })),
                    responses: handler.responses.map(r => ({
                        code: 200,
                        description: r
                    })),
                    statusCodes: [
                        { code: 200, description: 'Success' },
                        { code: 400, description: 'Bad Request' },
                        { code: 500, description: 'Internal Server Error' }
                    ],
                    middleware: apiRoute.middleware,
                    authentication: {
                        type: 'none',
                        required: false
                    },
                    rateLimit: undefined,
                    deprecated: false,
                    componentId: `nextjs-api-${path.replace(/\//g, '-')}`
                });
            }
        }
        return endpoints;
    }
    findNextJSEntryPoints() {
        const entryPoints = [];
        if (this.isAppRouter) {
            entryPoints.push('app/layout', 'app/page');
        }
        if (this.isPagesRouter) {
            entryPoints.push('pages/_app', 'pages/_document', 'pages/index');
        }
        if (this.hasMiddleware) {
            entryPoints.push('middleware');
        }
        entryPoints.push(...Array.from(this.apiRoutes.keys()));
        return entryPoints;
    }
    buildNextJSLayers() {
        const layers = super.buildReactLayers();
        layers['pages'] = Array.from(this.pages.values())
            .filter(p => p.type === 'page')
            .map(p => p.name);
        layers['layouts'] = Array.from(this.pages.values())
            .filter(p => p.type === 'layout')
            .map(p => p.name);
        layers['api'] = Array.from(this.apiRoutes.keys());
        layers['middleware'] = this.hasMiddleware ? ['middleware'] : [];
        layers['assets'] = this.publicAssets;
        return layers;
    }
    async analyzePerformance() {
        const performance = await super.analyzePerformance();
        return {
            ...performance,
            nextjs: {
                pagesCount: this.pages.size,
                apiRoutesCount: this.apiRoutes.size,
                serverComponents: Array.from(this.pages.values()).filter(p => p.isServerComponent).length,
                clientComponents: Array.from(this.pages.values()).filter(p => p.isClientComponent).length,
                dynamicPages: Array.from(this.pages.values()).filter(p => p.isDynamic).length,
                staticPages: Array.from(this.pages.values()).filter(p => p.hasGetStaticProps).length,
                ssrPages: Array.from(this.pages.values()).filter(p => p.hasGetServerSideProps).length,
                publicAssetsCount: this.publicAssets.length,
                features: {
                    isAppRouter: this.isAppRouter,
                    isPagesRouter: this.isPagesRouter,
                    hasI18n: this.hasI18n,
                    hasMiddleware: this.hasMiddleware,
                    reactStrictMode: this.config?.reactStrictMode || false,
                    swcMinify: this.config?.swcMinify || false
                }
            }
        };
    }
}
exports.NextJSAnalyzer = NextJSAnalyzer;
