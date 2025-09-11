// Next.js Framework Analyzer - Specialized analysis for Next.js applications
// Phase 3: Framework Sub-Analyzers - Production-ready Next.js analyzer

import { ReactAnalyzer } from './react-analyzer';
import { ComponentNode, ComponentType, Connection, APIEndpoint } from '../../../types';
import { telemetry } from '../../../telemetry/telemetry-schema';
import * as path from 'path';
import * as fs from 'fs-extra';

export interface NextJSPage {
  name: string;
  path: string;
  filePath: string;
  type: 'page' | 'api' | 'middleware' | 'layout' | 'loading' | 'error' | 'not-found';
  isServerComponent: boolean;
  isClientComponent: boolean;
  isDynamic: boolean;
  hasGetServerSideProps: boolean;
  hasGetStaticProps: boolean;
  hasGetStaticPaths: boolean;
  dataFetching: NextJSDataFetching[];
  metadata?: NextJSMetadata;
  exports: string[];
}

export interface NextJSDataFetching {
  type: 'getServerSideProps' | 'getStaticProps' | 'getStaticPaths' | 'generateMetadata' | 'generateStaticParams' | 'fetch';
  isAsync: boolean;
  revalidate?: number;
  dependencies: string[];
}

export interface NextJSMetadata {
  title?: string;
  description?: string;
  openGraph?: Record<string, any>;
  viewport?: string;
  icons?: any;
}

export interface NextJSAPIRoute {
  path: string;
  filePath: string;
  methods: string[];
  middleware: string[];
  isEdgeRuntime: boolean;
  handlers: NextJSAPIHandler[];
}

export interface NextJSAPIHandler {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  isAsync: boolean;
  parameters: string[];
  responses: string[];
}

export interface NextJSConfig {
  reactStrictMode: boolean;
  swcMinify: boolean;
  experimental: Record<string, any>;
  images: Record<string, any>;
  i18n?: Record<string, any>;
  redirects?: any[];
  rewrites?: any[];
  headers?: any[];
}

export class NextJSAnalyzer extends ReactAnalyzer {
  private nextVersion: string = '';
  private pages: Map<string, NextJSPage> = new Map();
  private apiRoutes: Map<string, NextJSAPIRoute> = new Map();
  private isAppRouter: boolean = false;
  private isPagesRouter: boolean = false;
  private hasI18n: boolean = false;
  private hasMiddleware: boolean = false;
  private config: NextJSConfig | null = null;
  private publicAssets: string[] = [];
  
  getAnalyzerName(): string {
    return 'Next.js Framework Analyzer';
  }

  getSupportedFrameworks(): string[] {
    return ['next', 'nextjs'];
  }

  protected async detectLanguageAndFramework(): Promise<any> {
    const baseDetection = await super.detectLanguageAndFramework();
    
    // Check for Next.js specific configuration
    const packageJsonPath = path.join(this.projectPath, 'package.json');
    if (await fs.pathExists(packageJsonPath)) {
      const packageJson = await fs.readJson(packageJsonPath);
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      
      this.nextVersion = deps.next || '';
      
      // Detect router type
      const appDir = path.join(this.projectPath, 'app');
      const pagesDir = path.join(this.projectPath, 'pages');
      const srcAppDir = path.join(this.projectPath, 'src', 'app');
      const srcPagesDir = path.join(this.projectPath, 'src', 'pages');
      
      this.isAppRouter = await fs.pathExists(appDir) || await fs.pathExists(srcAppDir);
      this.isPagesRouter = await fs.pathExists(pagesDir) || await fs.pathExists(srcPagesDir);
      
      // Check for middleware
      this.hasMiddleware = await fs.pathExists(path.join(this.projectPath, 'middleware.ts')) ||
                          await fs.pathExists(path.join(this.projectPath, 'middleware.js'));
    }
    
    // Load Next.js config
    await this.loadNextConfig();
    
    return {
      ...baseDetection,
      frameworks: [...baseDetection.frameworks.filter((f: any) => f.name !== 'react'), {
        name: 'next',
        version: this.nextVersion,
        confidence: 0.98,
        patterns: ['Next.js app detected'],
        configFiles: ['next.config.js', 'next.config.mjs', 'next.config.ts'],
        dependencies: ['next', 'react', 'react-dom']
      }]
    };
  }

  protected async discoverComponents(): Promise<any> {
    const span = telemetry.createSpan('nextjs-analyzer.discoverComponents');
    
    // Get base React components discovery
    const baseDiscovery = await super.discoverComponents();
    
    // Discover Next.js specific components
    await this.discoverNextJSPages();
    await this.discoverAPIRoutes();
    await this.discoverPublicAssets();
    
    // Enhance components with Next.js metadata
    const components = new Map<string, ComponentNode>();
    
    // Add base React components
    for (const component of baseDiscovery.components) {
      components.set(component.id, component);
    }
    
    // Add Next.js pages as components
    for (const [id, page] of this.pages) {
      const node: ComponentNode = {
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
          // isDynamic property moved to tags
          tags: page.isDynamic ? ['dynamic'] : []
        }
      };
      components.set(id, node);
    }
    
    // Build Next.js specific connections
    const connections = await this.buildNextJSConnections([]);
    
    // Extract API endpoints
    const apiEndpoints = await this.extractAPIEndpoints();
    
    telemetry.emit({
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

  private async loadNextConfig(): Promise<void> {
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
        } catch (error) {
          console.warn(`Failed to parse Next.js config: ${error}`);
        }
      }
    }
  }

  private parseNextConfig(content: string): NextJSConfig {
    const config: NextJSConfig = {
      reactStrictMode: content.includes('reactStrictMode: true'),
      swcMinify: content.includes('swcMinify: true'),
      experimental: {},
      images: {}
    };
    
    // Parse i18n config
    const i18nMatch = content.match(/i18n:\s*{([^}]+)}/s);
    if (i18nMatch) {
      config.i18n = {};
    }
    
    // Parse redirects
    if (content.includes('redirects')) {
      config.redirects = [];
    }
    
    // Parse rewrites
    if (content.includes('rewrites')) {
      config.rewrites = [];
    }
    
    // Parse headers
    if (content.includes('headers')) {
      config.headers = [];
    }
    
    return config;
  }

  private async discoverNextJSPages(): Promise<void> {
    if (this.isAppRouter) {
      await this.discoverAppRouterPages();
    }
    
    if (this.isPagesRouter) {
      await this.discoverPagesRouterPages();
    }
  }

  private async discoverAppRouterPages(): Promise<void> {
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

  private async scanAppDirectory(dir: string, routePath: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory()) {
        // Handle route groups (folders in parentheses)
        const isRouteGroup = entry.name.startsWith('(') && entry.name.endsWith(')');
        const newRoutePath = isRouteGroup ? routePath : `${routePath}/${entry.name}`;
        
        await this.scanAppDirectory(fullPath, newRoutePath);
      } else if (entry.isFile()) {
        const page = await this.parseAppRouterFile(fullPath, routePath, entry.name);
        if (page) {
          this.pages.set(page.name, page);
        }
      }
    }
  }

  private async parseAppRouterFile(filePath: string, routePath: string, fileName: string): Promise<NextJSPage | null> {
    const baseName = path.basename(fileName, path.extname(fileName));
    
    // Check if it's a special Next.js file
    const specialFiles = ['page', 'layout', 'loading', 'error', 'not-found', 'template'];
    if (!specialFiles.includes(baseName)) {
      return null;
    }
    
    const content = await fs.readFile(filePath, 'utf-8');
    
    // Determine component type
    const isClientComponent = content.includes("'use client'") || content.includes('"use client"');
    const isServerComponent = !isClientComponent;
    
    // Parse exports
    const exports = this.parseExports(content);
    
    // Parse data fetching
    const dataFetching = this.parseAppRouterDataFetching(content);
    
    // Parse metadata
    const metadata = this.parseMetadata(content);
    
    // Handle dynamic segments
    const isDynamic = routePath.includes('[') && routePath.includes(']');
    
    return {
      name: `${routePath || '/'}/${baseName}`,
      path: routePath || '/',
      filePath,
      type: baseName as NextJSPage['type'],
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

  private async discoverPagesRouterPages(): Promise<void> {
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

  private async scanPagesDirectory(dir: string, routePath: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('_') && entry.name !== 'api') {
          const newRoutePath = `${routePath}/${entry.name}`;
          await this.scanPagesDirectory(fullPath, newRoutePath);
        } else if (entry.name === 'api') {
          await this.scanAPIDirectory(fullPath, '/api');
        }
      } else if (entry.isFile() && (entry.name.endsWith('.tsx') || entry.name.endsWith('.jsx') || 
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

  private async parsePagesRouterFile(filePath: string, routePath: string, fileName: string): Promise<NextJSPage | null> {
    const baseName = path.basename(fileName, path.extname(fileName));
    const content = await fs.readFile(filePath, 'utf-8');
    
    // Determine route path
    let pagePath = routePath;
    if (baseName === 'index') {
      pagePath = routePath || '/';
    } else {
      pagePath = `${routePath}/${baseName}`;
    }
    
    // Handle dynamic routes
    const isDynamic = baseName.includes('[') && baseName.includes(']');
    
    // Parse data fetching methods
    const hasGetServerSideProps = content.includes('getServerSideProps');
    const hasGetStaticProps = content.includes('getStaticProps');
    const hasGetStaticPaths = content.includes('getStaticPaths');
    
    const dataFetching: NextJSDataFetching[] = [];
    
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
    
    // Parse exports
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

  private async discoverAPIRoutes(): Promise<void> {
    // Discover App Router API routes
    if (this.isAppRouter) {
      await this.discoverAppRouterAPIRoutes();
    }
    
    // Discover Pages Router API routes
    if (this.isPagesRouter) {
      await this.discoverPagesRouterAPIRoutes();
    }
  }

  private async discoverAppRouterAPIRoutes(): Promise<void> {
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

  private async scanAppRouterForAPIRoutes(dir: string, routePath: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory()) {
        const isRouteGroup = entry.name.startsWith('(') && entry.name.endsWith(')');
        const newRoutePath = isRouteGroup ? routePath : `${routePath}/${entry.name}`;
        await this.scanAppRouterForAPIRoutes(fullPath, newRoutePath);
      } else if (entry.isFile() && entry.name === 'route.ts' || entry.name === 'route.js') {
        const apiRoute = await this.parseAppRouterAPIRoute(fullPath, routePath);
        if (apiRoute) {
          this.apiRoutes.set(apiRoute.path, apiRoute);
        }
      }
    }
  }

  private async parseAppRouterAPIRoute(filePath: string, routePath: string): Promise<NextJSAPIRoute | null> {
    const content = await fs.readFile(filePath, 'utf-8');
    
    // Parse exported HTTP methods
    const methods: string[] = [];
    const handlers: NextJSAPIHandler[] = [];
    
    const httpMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
    for (const method of httpMethods) {
      if (content.includes(`export async function ${method}`) || 
          content.includes(`export function ${method}`)) {
        methods.push(method);
        
        handlers.push({
          method: method as NextJSAPIHandler['method'],
          isAsync: content.includes(`export async function ${method}`),
          parameters: this.parseHandlerParameters(content, method),
          responses: this.parseHandlerResponses(content, method)
        });
      }
    }
    
    // Check for edge runtime
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

  private async discoverPagesRouterAPIRoutes(): Promise<void> {
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

  private async scanAPIDirectory(dir: string, routePath: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory()) {
        const newRoutePath = `${routePath}/${entry.name}`;
        await this.scanAPIDirectory(fullPath, newRoutePath);
      } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
        const apiRoute = await this.parsePagesRouterAPIRoute(fullPath, routePath, entry.name);
        if (apiRoute) {
          this.apiRoutes.set(apiRoute.path, apiRoute);
        }
      }
    }
  }

  private async parsePagesRouterAPIRoute(filePath: string, routePath: string, fileName: string): Promise<NextJSAPIRoute | null> {
    const baseName = path.basename(fileName, path.extname(fileName));
    const content = await fs.readFile(filePath, 'utf-8');
    
    // Determine route path
    let apiPath = routePath;
    if (baseName !== 'index') {
      apiPath = `${routePath}/${baseName}`;
    }
    
    // Parse handler
    const handlers: NextJSAPIHandler[] = [];
    const methods: string[] = [];
    
    // Check for method-specific handling
    const methodCheckRegex = /req\.method\s*===?\s*['"](\w+)['"]/g;
    let match;
    
    while ((match = methodCheckRegex.exec(content)) !== null) {
      const method = match[1];
      if (!methods.includes(method)) {
        methods.push(method);
        handlers.push({
          method: method as NextJSAPIHandler['method'],
          isAsync: content.includes('async'),
          parameters: [],
          responses: []
        });
      }
    }
    
    // If no specific methods found, assume it handles all
    if (methods.length === 0) {
      methods.push('GET', 'POST');
    }
    
    // Check for edge runtime
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

  private async discoverPublicAssets(): Promise<void> {
    const publicDir = path.join(this.projectPath, 'public');
    
    if (await fs.pathExists(publicDir)) {
      const { glob } = await import('glob');
      const files = await glob('**/*', { cwd: publicDir, absolute: true });
      this.publicAssets = files.map(file => path.relative(publicDir, file));
    }
  }

  private parseExports(content: string): string[] {
    const exports: string[] = [];
    
    // Parse named exports
    const namedExportRegex = /export\s+(?:const|let|var|function|class)\s+(\w+)/g;
    let match;
    
    while ((match = namedExportRegex.exec(content)) !== null) {
      exports.push(match[1]);
    }
    
    // Check for default export
    if (content.includes('export default')) {
      exports.push('default');
    }
    
    return exports;
  }

  private parseAppRouterDataFetching(content: string): NextJSDataFetching[] {
    const dataFetching: NextJSDataFetching[] = [];
    
    // Check for fetch calls
    const fetchRegex = /fetch\s*\([^)]+\)/g;
    const fetchMatches = content.match(fetchRegex);
    
    if (fetchMatches) {
      for (const fetchCall of fetchMatches) {
        // Check for revalidate option
        const revalidateMatch = fetchCall.match(/revalidate:\s*(\d+)/);
        
        dataFetching.push({
          type: 'fetch',
          isAsync: true,
          revalidate: revalidateMatch ? parseInt(revalidateMatch[1]) : undefined,
          dependencies: []
        });
      }
    }
    
    // Check for generateMetadata
    if (content.includes('generateMetadata')) {
      dataFetching.push({
        type: 'generateMetadata',
        isAsync: true,
        dependencies: []
      });
    }
    
    // Check for generateStaticParams
    if (content.includes('generateStaticParams')) {
      dataFetching.push({
        type: 'generateStaticParams',
        isAsync: true,
        dependencies: []
      });
    }
    
    return dataFetching;
  }

  private parseMetadata(content: string): NextJSMetadata | undefined {
    const metadataMatch = content.match(/export\s+const\s+metadata\s*(?::\s*Metadata\s*)?=\s*{([^}]+)}/s);
    
    if (metadataMatch) {
      const metadata: NextJSMetadata = {};
      const metadataContent = metadataMatch[1];
      
      // Parse title
      const titleMatch = metadataContent.match(/title:\s*['"`]([^'"`]+)['"`]/);
      if (titleMatch) {
        metadata.title = titleMatch[1];
      }
      
      // Parse description
      const descMatch = metadataContent.match(/description:\s*['"`]([^'"`]+)['"`]/);
      if (descMatch) {
        metadata.description = descMatch[1];
      }
      
      return metadata;
    }
    
    return undefined;
  }

  private parseDataFetchingDependencies(content: string, methodName: string): string[] {
    const dependencies: string[] = [];
    
    // Find the method definition
    const methodRegex = new RegExp(`export\\s+(?:async\\s+)?function\\s+${methodName}\\s*\\([^)]*\\)\\s*{([^}]+)}`, 's');
    const methodMatch = content.match(methodRegex);
    
    if (methodMatch) {
      const methodContent = methodMatch[1];
      
      // Look for imports used within the method
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

  private parseRevalidate(content: string): number | undefined {
    const revalidateMatch = content.match(/revalidate:\s*(\d+)/);
    return revalidateMatch ? parseInt(revalidateMatch[1]) : undefined;
  }

  private parseHandlerParameters(content: string, method: string): string[] {
    const parameters: string[] = [];
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

  private parseHandlerResponses(content: string, method: string): string[] {
    const responses: string[] = [];
    
    // Look for NextResponse usage
    if (content.includes('NextResponse')) {
      if (content.includes('NextResponse.json')) responses.push('json');
      if (content.includes('NextResponse.redirect')) responses.push('redirect');
      if (content.includes('NextResponse.rewrite')) responses.push('rewrite');
      if (content.includes('NextResponse.next')) responses.push('next');
    }
    
    // Look for Response usage
    if (content.includes('new Response')) {
      responses.push('response');
    }
    
    return responses;
  }

  private mapNextJSPageType(type: NextJSPage['type']): ComponentType {
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

  private calculatePageComplexity(page: NextJSPage): number {
    let complexity = 1;
    
    complexity += page.dataFetching.length * 3;
    
    if (page.isDynamic) complexity += 2;
    if (page.hasGetServerSideProps) complexity += 3;
    if (page.hasGetStaticProps) complexity += 2;
    if (page.hasGetStaticPaths) complexity += 3;
    if (page.isServerComponent) complexity += 1;
    
    return complexity;
  }

  private calculatePageMaintainability(page: NextJSPage): number {
    let score = 100;
    
    const complexity = this.calculatePageComplexity(page);
    score -= Math.min(complexity * 3, 40);
    
    // Bonus for modern patterns
    if (page.isServerComponent && this.isAppRouter) score += 5;
    if (page.type === 'layout') score += 3;
    
    return Math.max(score, 0);
  }

  private calculatePageTechnicalDebt(page: NextJSPage): number {
    let debt = 0;
    
    // Debt for using Pages Router in newer Next.js versions
    if (this.nextVersion.startsWith('13') || this.nextVersion.startsWith('14')) {
      if (!this.isAppRouter && page.type === 'page') {
        debt += 3;
      }
    }
    
    // Debt for mixing data fetching methods
    if (page.hasGetServerSideProps && page.hasGetStaticProps) {
      debt += 10;
    }
    
    return debt;
  }


  private async buildNextJSConnections(baseConnections: Connection[]): Promise<Connection[]> {
    const connections: Connection[] = [...baseConnections];
    
    // Add page hierarchy connections
    for (const [name, page] of this.pages) {
      if (page.type === 'layout') {
        // Connect layout to child pages
        const childPages = Array.from(this.pages.values()).filter(p => 
          p.path.startsWith(page.path) && p.path !== page.path
        );
        
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
    
    // Add API route connections
    for (const [path, apiRoute] of this.apiRoutes) {
      // Connect pages that might call these API routes
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
    
    // Add middleware connections
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

  private async extractAPIEndpoints(): Promise<APIEndpoint[]> {
    const endpoints: APIEndpoint[] = [];
    
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
            type: 'query' as 'query' | 'path' | 'body' | 'header',
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

  private findNextJSEntryPoints(): string[] {
    const entryPoints: string[] = [];
    
    // App Router entry points
    if (this.isAppRouter) {
      entryPoints.push('app/layout', 'app/page');
    }
    
    // Pages Router entry points
    if (this.isPagesRouter) {
      entryPoints.push('pages/_app', 'pages/_document', 'pages/index');
    }
    
    // Middleware
    if (this.hasMiddleware) {
      entryPoints.push('middleware');
    }
    
    // API routes
    entryPoints.push(...Array.from(this.apiRoutes.keys()));
    
    return entryPoints;
  }

  private buildNextJSLayers(): Record<string, string[]> {
    const layers = super.buildReactLayers();
    
    // Add Next.js specific layers
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

  async analyzePerformance(): Promise<any> {
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