import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, CASPerspective } from '../../../types/cas.types';
import * as path from 'path';
import * as fs from 'fs-extra';
import { glob } from 'glob';

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);

export class NextJSAnalyzer extends BaseAnalyzer {
  constructor() {
    super('nextjs', 'Next.js Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const packageJsonPath = path.join(projectPath, 'package.json');
      if (await fs.pathExists(packageJsonPath)) {
        const packageJson = await fs.readJson(packageJsonPath);
        const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
        if (deps['next']) return true;
      }

      const configFiles = ['next.config.js', 'next.config.mjs', 'next.config.ts'];
      for (const configFile of configFiles) {
        if (await fs.pathExists(path.join(projectPath, configFile))) return true;
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
    const seenEntryPointIds = new Set<string>();

    const ignorePatterns = [
      ...this.getIgnorePatterns(context),
      '**/*.spec.ts',
      '**/*.spec.tsx',
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.spec.js',
      '**/*.spec.jsx',
      '**/*.test.js',
      '**/*.test.jsx',
      '**/__tests__/**'
    ];

    const sourceFiles = await glob(['**/*.{ts,js,tsx,jsx}'], {
      cwd: context.projectPath,
      ignore: ignorePatterns,
      nodir: true
    });

    await this.detectAppRouterApiRoutes(sourceFiles, context, nodes, edges, entryPoints, seenEntryPointIds);
    await this.detectPagesRouterApiRoutes(sourceFiles, context, nodes, edges, entryPoints, seenEntryPointIds);
    await this.detectPageRoutes(sourceFiles, context, nodes, edges, entryPoints, seenEntryPointIds);
    await this.detectMiddleware(context, nodes, edges, entryPoints, seenEntryPointIds);
    await this.detectNavigationCalls(sourceFiles, context, nodes, exitPoints);
    await this.detectLayouts(sourceFiles, context, nodes, edges);
    await this.detectComponentTypes(sourceFiles, context, nodes);

    const perspectives: CASPerspective[] = [];
    this.createPerspectives(perspectives);
    this.tagNodesWithPerspectives(nodes, edges);

    const contribution = this.createContribution(nodes, edges, entryPoints, exitPoints, {
      framework_specific: {
        api_routes_detected: entryPoints.filter(ep => ep.name.startsWith('GET ') || ep.name.startsWith('POST ') || ep.name.startsWith('PUT ') || ep.name.startsWith('DELETE ') || ep.name.startsWith('PATCH ') || ep.name.startsWith('API ')).length,
        page_routes_detected: entryPoints.filter(ep => ep.name.startsWith('PAGE ')).length,
        middleware_detected: nodes.filter(n => n.type === 'middleware').length,
        layouts_detected: nodes.filter(n => n.type === 'layout').length,
        nodes_created: nodes.length
      }
    });

    contribution.perspectives = perspectives;
    contribution.provided_perspectives = perspectives.map(p => p.id);

    return contribution;
  }

  private async detectAppRouterApiRoutes(
    sourceFiles: string[],
    context: AnalysisContext,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    seenEntryPointIds: Set<string>
  ): Promise<void> {
    const appRouteFiles = sourceFiles.filter(f => /\/app\/.*\/route\.(ts|js)$/.test(f) || /^app\/.*\/route\.(ts|js)$/.test(f));

    for (const file of appRouteFiles) {
      const fullPath = path.join(context.projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');
      const exportedNames = this.getExportedFunctionNames(content);
      const routePath = this.deriveRoutePath(file, 'app-api');
      const fileNodeId = this.findFileNodeId(file, context.existingAnalysis);

      const nodeId = fileNodeId || `nextjs_api_route_${file.replace(/[^a-zA-Z0-9]/g, '_')}`;

      if (!fileNodeId) {
        nodes.push(this.createNode(nodeId, `API Route ${routePath}`, 'api-route', 3, file, undefined, undefined, {
          framework: 'nextjs',
          attributes: { routePath, router: 'app' }
        }));
      }

      for (const name of exportedNames) {
        const upperName = name.toUpperCase();
        if (!HTTP_METHODS.has(upperName)) continue;

        const entryId = `entry_nextjs_api_${file.replace(/[^a-zA-Z0-9]/g, '_')}_${upperName}`;
        if (seenEntryPointIds.has(entryId)) continue;
        seenEntryPointIds.add(entryId);

        entryPoints.push({
          id: entryId,
          source_node: nodeId,
          source_analyzer: this.analyzerId,
          type: 'http',
          name: `${upperName} ${routePath}`,
          trigger: { method: upperName, path: routePath },
          metadata: { framework: 'nextjs', routeFile: file }
        });
      }
    }
  }

  private async detectPagesRouterApiRoutes(
    sourceFiles: string[],
    context: AnalysisContext,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    seenEntryPointIds: Set<string>
  ): Promise<void> {
    const pagesApiFiles = sourceFiles.filter(f =>
      /\/pages\/api\/.*\.(ts|js|tsx|jsx)$/.test(f) || /^pages\/api\/.*\.(ts|js|tsx|jsx)$/.test(f)
    );

    for (const file of pagesApiFiles) {
      const fullPath = path.join(context.projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');
      const exportedNames = this.getExportedFunctionNames(content);
      const routePath = this.deriveRoutePath(file, 'pages-api');
      const fileNodeId = this.findFileNodeId(file, context.existingAnalysis);

      const nodeId = fileNodeId || `nextjs_pages_api_${file.replace(/[^a-zA-Z0-9]/g, '_')}`;

      if (!fileNodeId) {
        nodes.push(this.createNode(nodeId, `Pages API ${routePath}`, 'api-route', 3, file, undefined, undefined, {
          framework: 'nextjs',
          attributes: { routePath, router: 'pages' }
        }));
      }

      const hasDefault = exportedNames.includes('default');
      if (hasDefault) {
        const entryId = `entry_nextjs_api_${file.replace(/[^a-zA-Z0-9]/g, '_')}_default`;
        if (!seenEntryPointIds.has(entryId)) {
          seenEntryPointIds.add(entryId);
          entryPoints.push({
            id: entryId,
            source_node: nodeId,
            source_analyzer: this.analyzerId,
            type: 'http',
            name: `API ${routePath}`,
            trigger: { method: 'ALL', path: routePath },
            metadata: { framework: 'nextjs', routeFile: file }
          });
        }
      }

      for (const name of exportedNames) {
        const upperName = name.toUpperCase();
        if (!HTTP_METHODS.has(upperName)) continue;

        const entryId = `entry_nextjs_api_${file.replace(/[^a-zA-Z0-9]/g, '_')}_${upperName}`;
        if (seenEntryPointIds.has(entryId)) continue;
        seenEntryPointIds.add(entryId);

        entryPoints.push({
          id: entryId,
          source_node: nodeId,
          source_analyzer: this.analyzerId,
          type: 'http',
          name: `${upperName} ${routePath}`,
          trigger: { method: upperName, path: routePath },
          metadata: { framework: 'nextjs', routeFile: file }
        });
      }
    }
  }

  private async detectPageRoutes(
    sourceFiles: string[],
    context: AnalysisContext,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    seenEntryPointIds: Set<string>
  ): Promise<void> {
    const appRouterPages = sourceFiles.filter(f =>
      /\/app\/.*\/page\.(tsx|ts|jsx|js)$/.test(f) || /^app\/.*\/page\.(tsx|ts|jsx|js)$/.test(f)
    );

    for (const file of appRouterPages) {
      const routePath = this.deriveRoutePath(file, 'app-page');
      const fileNodeId = this.findFileNodeId(file, context.existingAnalysis);
      const nodeId = fileNodeId || `nextjs_page_${file.replace(/[^a-zA-Z0-9]/g, '_')}`;

      if (!fileNodeId) {
        const fullPath = path.join(context.projectPath, file);
        const content = await fs.readFile(fullPath, 'utf-8');
        const componentType = this.detectComponentType(content);

        nodes.push(this.createNode(nodeId, `Page ${routePath}`, 'page', 3, file, undefined, undefined, {
          framework: 'nextjs',
          attributes: { routePath, router: 'app', componentType }
        }));
      }

      const entryId = `entry_nextjs_page_${file.replace(/[^a-zA-Z0-9]/g, '_')}`;
      if (!seenEntryPointIds.has(entryId)) {
        seenEntryPointIds.add(entryId);
        entryPoints.push({
          id: entryId,
          source_node: nodeId,
          source_analyzer: this.analyzerId,
          type: 'page',
          name: `PAGE ${routePath}`,
          trigger: { method: 'GET', path: routePath },
          metadata: { framework: 'nextjs', pageFile: file }
        });
      }
    }

    const pagesRouterPages = sourceFiles.filter(f => {
      const matchesPagesDir = /\/pages\/.*\.(tsx|jsx)$/.test(f) || /^pages\/.*\.(tsx|jsx)$/.test(f);
      if (!matchesPagesDir) return false;
      const isApi = /\/pages\/api\//.test(f) || /^pages\/api\//.test(f);
      const basename = path.basename(f, path.extname(f));
      const isSpecialFile = basename === '_app' || basename === '_document';
      return !isApi && !isSpecialFile;
    });

    for (const file of pagesRouterPages) {
      const routePath = this.deriveRoutePath(file, 'pages');
      const fileNodeId = this.findFileNodeId(file, context.existingAnalysis);
      const nodeId = fileNodeId || `nextjs_page_${file.replace(/[^a-zA-Z0-9]/g, '_')}`;

      if (!fileNodeId) {
        nodes.push(this.createNode(nodeId, `Page ${routePath}`, 'page', 3, file, undefined, undefined, {
          framework: 'nextjs',
          attributes: { routePath, router: 'pages' }
        }));
      }

      const entryId = `entry_nextjs_page_${file.replace(/[^a-zA-Z0-9]/g, '_')}`;
      if (!seenEntryPointIds.has(entryId)) {
        seenEntryPointIds.add(entryId);
        entryPoints.push({
          id: entryId,
          source_node: nodeId,
          source_analyzer: this.analyzerId,
          type: 'page',
          name: `PAGE ${routePath}`,
          trigger: { method: 'GET', path: routePath },
          metadata: { framework: 'nextjs', pageFile: file }
        });
      }
    }
  }

  private async detectMiddleware(
    context: AnalysisContext,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    seenEntryPointIds: Set<string>
  ): Promise<void> {
    const middlewareExtensions = ['ts', 'js'];

    for (const ext of middlewareExtensions) {
      const middlewarePath = path.join(context.projectPath, `middleware.${ext}`);
      if (await fs.pathExists(middlewarePath)) {
        const file = `middleware.${ext}`;
        const nodeId = `nextjs_middleware_${file.replace(/[^a-zA-Z0-9]/g, '_')}`;

        nodes.push(this.createNode(nodeId, 'Middleware', 'middleware', 2, file, undefined, undefined, {
          framework: 'nextjs'
        }));

        const entryId = `entry_nextjs_middleware_${file.replace(/[^a-zA-Z0-9]/g, '_')}`;
        if (!seenEntryPointIds.has(entryId)) {
          seenEntryPointIds.add(entryId);
          entryPoints.push({
            id: entryId,
            source_node: nodeId,
            source_analyzer: this.analyzerId,
            type: 'http',
            name: 'MIDDLEWARE /',
            trigger: { method: 'ALL', path: '/' },
            metadata: { framework: 'nextjs', middlewareFile: file }
          });
        }

        break;
      }
    }
  }

  private async detectLayouts(
    sourceFiles: string[],
    context: AnalysisContext,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<void> {
    const layoutFiles = sourceFiles.filter(f =>
      /\/app\/.*\/layout\.(tsx|ts|jsx|js)$/.test(f) || /^app\/.*\/layout\.(tsx|ts|jsx|js)$/.test(f)
      || /^app\/layout\.(tsx|ts|jsx|js)$/.test(f)
    );

    for (const file of layoutFiles) {
      const fileNodeId = this.findFileNodeId(file, context.existingAnalysis);
      const nodeId = fileNodeId || `nextjs_layout_${file.replace(/[^a-zA-Z0-9]/g, '_')}`;
      const layoutDir = path.dirname(file);

      if (!fileNodeId) {
        const routePath = this.deriveRoutePath(file, 'layout');
        nodes.push(this.createNode(nodeId, `Layout ${routePath}`, 'layout', 2, file, undefined, undefined, {
          framework: 'nextjs',
          attributes: { layoutDir }
        }));
      }

      const pagesInSameDir = sourceFiles.filter(f => {
        const pageDir = path.dirname(f);
        return pageDir === layoutDir && /\/page\.(tsx|ts|jsx|js)$/.test(f);
      });

      for (const pageFile of pagesInSameDir) {
        const pageNodeId = this.findFileNodeId(pageFile, context.existingAnalysis)
          || `nextjs_page_${pageFile.replace(/[^a-zA-Z0-9]/g, '_')}`;

        const edgeId = this.generateEdgeId(nodeId, pageNodeId, 'contains');
        edges.push(this.createEdge(edgeId, nodeId, pageNodeId, 'contains', 'layout', {
          framework: 'nextjs'
        }));
      }
    }
  }

  private async detectComponentTypes(
    sourceFiles: string[],
    context: AnalysisContext,
    nodes: CASNode[]
  ): Promise<void> {
    const appFiles = sourceFiles.filter(f =>
      (/\/app\//.test(f) || /^app\//.test(f)) && /\.(tsx|ts|jsx|js)$/.test(f)
    );

    for (const file of appFiles) {
      const isPageOrLayout = /\/(page|layout|route)\.(tsx|ts|jsx|js)$/.test(file);
      if (isPageOrLayout) continue;

      const fullPath = path.join(context.projectPath, file);
      try {
        const content = await fs.readFile(fullPath, 'utf-8');
        const componentType = this.detectComponentType(content);
        const fileNodeId = this.findFileNodeId(file, context.existingAnalysis);

        if (fileNodeId) {
          const existingNode = this.findExistingNode(fileNodeId, context.existingAnalysis);
          if (existingNode) {
            existingNode.metadata = {
              ...existingNode.metadata,
              attributes: { ...existingNode.metadata?.attributes, componentType }
            };
          }
        }
      } catch {
        continue;
      }
    }
  }

  private async detectNavigationCalls(
    sourceFiles: string[],
    context: AnalysisContext,
    nodes: CASNode[],
    exitPoints: CASExitPoint[]
  ): Promise<void> {
    const seenExitIds = new Set<string>();
    const routerPushPattern = /router\.push\(\s*['"`]([^'"`]+)['"`]/g;
    const routerReplacePattern = /router\.replace\(\s*['"`]([^'"`]+)['"`]/g;
    const redirectPattern = /redirect\(\s*['"`]([^'"`]+)['"`]/g;

    for (const file of sourceFiles) {
      const fullPath = path.join(context.projectPath, file);
      let content: string;
      try {
        content = await fs.readFile(fullPath, 'utf-8');
      } catch {
        continue;
      }

      const hasRouterUsage = content.includes('useRouter') || content.includes('router.push') || content.includes('router.replace');
      const hasRedirect = content.includes('next/navigation') && content.includes('redirect(');

      if (!hasRouterUsage && !hasRedirect) continue;

      const sourceNode = this.findFileNodeId(file, context.existingAnalysis)
        || this.ensureNavigationSourceNode(file, nodes);

      let match: RegExpExecArray | null;

      routerPushPattern.lastIndex = 0;
      while ((match = routerPushPattern.exec(content)) !== null) {
        const targetPath = match[1];
        const exitId = `exit_nav_push_${file.replace(/[^a-zA-Z0-9]/g, '_')}_${targetPath.replace(/[^a-zA-Z0-9]/g, '_')}`;
        if (seenExitIds.has(exitId)) continue;
        seenExitIds.add(exitId);
        exitPoints.push(this.createExitPoint(
          exitId,
          sourceNode,
          'navigation',
          `NAVIGATE ${targetPath}`,
          undefined,
          { endpoint: targetPath },
          undefined,
          { framework: 'nextjs', sourceFile: file }
        ));
      }

      routerReplacePattern.lastIndex = 0;
      while ((match = routerReplacePattern.exec(content)) !== null) {
        const targetPath = match[1];
        const exitId = `exit_nav_replace_${file.replace(/[^a-zA-Z0-9]/g, '_')}_${targetPath.replace(/[^a-zA-Z0-9]/g, '_')}`;
        if (seenExitIds.has(exitId)) continue;
        seenExitIds.add(exitId);
        exitPoints.push(this.createExitPoint(
          exitId,
          sourceNode,
          'navigation',
          `NAVIGATE ${targetPath}`,
          undefined,
          { endpoint: targetPath },
          undefined,
          { framework: 'nextjs', sourceFile: file }
        ));
      }

      if (hasRedirect) {
        redirectPattern.lastIndex = 0;
        while ((match = redirectPattern.exec(content)) !== null) {
          const targetPath = match[1];
          const exitId = `exit_nav_redirect_${file.replace(/[^a-zA-Z0-9]/g, '_')}_${targetPath.replace(/[^a-zA-Z0-9]/g, '_')}`;
          if (seenExitIds.has(exitId)) continue;
          seenExitIds.add(exitId);
          exitPoints.push(this.createExitPoint(
            exitId,
            sourceNode,
            'navigation',
            `REDIRECT ${targetPath}`,
            undefined,
            { endpoint: targetPath },
            undefined,
            { framework: 'nextjs', sourceFile: file }
          ));
        }
      }
    }
  }

  private detectComponentType(content: string): 'client' | 'server' {
    const trimmed = content.trimStart();
    if (/^['"]use client['"]/.test(trimmed)) return 'client';
    return 'server';
  }

  private deriveRoutePath(file: string, routeType: 'app-api' | 'app-page' | 'pages-api' | 'pages' | 'layout'): string {
    let routePath: string;

    switch (routeType) {
      case 'app-api': {
        const match = file.match(/app\/(.*)\/route\.\w+$/);
        routePath = match ? `/${match[1]}` : '/';
        break;
      }
      case 'app-page': {
        const match = file.match(/app\/(.*)\/page\.\w+$/);
        routePath = match ? `/${match[1]}` : '/';
        break;
      }
      case 'layout': {
        const match = file.match(/app\/(.*)\/layout\.\w+$/);
        if (match) {
          routePath = `/${match[1]}`;
        } else {
          routePath = '/';
        }
        break;
      }
      case 'pages-api': {
        const match = file.match(/pages\/api\/(.+)\.\w+$/);
        if (match) {
          routePath = `/api/${match[1]}`;
        } else {
          routePath = '/api';
        }
        routePath = routePath.replace(/\/index$/, '');
        break;
      }
      case 'pages': {
        const match = file.match(/pages\/(.+)\.\w+$/);
        if (match) {
          routePath = `/${match[1]}`;
        } else {
          routePath = '/';
        }
        routePath = routePath.replace(/\/index$/, '');
        if (routePath === '') routePath = '/';
        break;
      }
      default:
        routePath = '/';
    }

    routePath = routePath.replace(/\[([^\]]+)\]/g, ':$1');

    return routePath;
  }

  private getExportedFunctionNames(content: string): string[] {
    const names: string[] = [];

    const funcPattern = /export\s+(?:async\s+)?function\s+(\w+)/g;
    let match: RegExpExecArray | null;
    while ((match = funcPattern.exec(content)) !== null) {
      names.push(match[1]);
    }

    const constPattern = /export\s+(?:const|let|var)\s+(\w+)/g;
    while ((match = constPattern.exec(content)) !== null) {
      names.push(match[1]);
    }

    if (/export\s+default/.test(content)) {
      names.push('default');
    }

    return names;
  }

  private findFileNodeId(relativePath: string, existingAnalysis?: CASContribution[]): string | undefined {
    const fileId = `file_${relativePath.replace(/[^a-zA-Z0-9]/g, '_')}`;
    if (!existingAnalysis) return undefined;
    for (const contribution of existingAnalysis) {
      const found = contribution.nodes?.find(n => n.id === fileId);
      if (found) return found.id;
      const bySource = contribution.nodes?.find(n =>
        n.type === 'file' &&
        (n.source?.file === relativePath || n.source?.file?.endsWith(relativePath))
      );
      if (bySource) return bySource.id;
    }
    return undefined;
  }

  private ensureNavigationSourceNode(relativePath: string, nodes: CASNode[]): string {
    const nodeId = `nextjs_nav_${relativePath.replace(/[^a-zA-Z0-9]/g, '_')}`;
    if (nodes.some(n => n.id === nodeId)) return nodeId;

    nodes.push(this.createNode(nodeId, `Navigation ${relativePath}`, 'navigation-source', 3, relativePath, undefined, undefined, {
      framework: 'nextjs',
      attributes: { sourceFile: relativePath }
    }));

    return nodeId;
  }

  private findExistingNode(nodeId: string, existingAnalysis?: CASContribution[]): CASNode | undefined {
    if (!existingAnalysis) return undefined;
    for (const contribution of existingAnalysis) {
      const found = contribution.nodes?.find(n => n.id === nodeId);
      if (found) return found;
    }
    return undefined;
  }

  protected getCapabilities(): string[] {
    return [
      'nextjs-routing',
      'api-route-detection',
      'page-detection',
      'server-component-detection',
      'middleware-detection'
    ];
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

  private createPerspectives(perspectives: CASPerspective[]): void {
    perspectives.push({
      id: 'nextjs-routes',
      name: 'Next.js Routing',
      description: 'Page routes, API routes, and middleware showing request routing flow',
      analyzer_id: this.analyzerId,
      type: 'flow',
      connection_rules: {
        visible_node_types: ['page', 'api_route', 'middleware', 'layout', 'route', 'endpoint', 'function', 'class', 'component'],
        relevant_edge_types: ['renders', 'calls', 'uses', 'contains'],
        node_connections: [
          {
            from_type: 'middleware',
            to_types: ['page', 'api_route'],
            edge_type: 'processes'
          },
          {
            from_type: 'layout',
            to_types: ['page'],
            edge_type: 'contains'
          }
        ]
      },
      layout_hints: {
        style: 'hierarchical',
        direction: 'TB',
        group_by: 'route_segment'
      }
    });

    perspectives.push({
      id: 'nextjs-architecture',
      name: 'Next.js Application Architecture',
      description: 'Application layers: Pages -> Components -> Services -> Data',
      analyzer_id: this.analyzerId,
      type: 'structure',
      connection_rules: {
        visible_node_types: ['page', 'api_route', 'component', 'layout', 'middleware', 'function', 'class', 'module', 'file'],
        relevant_edge_types: ['imports', 'calls', 'uses', 'contains', 'renders']
      },
      layout_hints: {
        style: 'hierarchical',
        direction: 'LR'
      }
    });
  }

  private tagNodesWithPerspectives(nodes: CASNode[], edges: CASEdge[]): void {
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      if (!node.perspectives) node.perspectives = {};

      const isRoute = node.type === 'page' || node.type === 'api_route' ||
        node.type === 'route' || node.type === 'endpoint';
      const isLayout = node.type === 'layout';
      const isMiddleware = node.type === 'middleware';

      if (isRoute || isLayout || isMiddleware) {
        node.perspectives['nextjs-routes'] = {
          hierarchy: ['routing', node.type, node.name],
          level: node.level || 2,
          priority: isRoute ? 90 : isMiddleware ? 80 : 70
        };
      }

      if (node.type !== 'import') {
        node.perspectives['nextjs-architecture'] = {
          hierarchy: ['architecture', node.category || node.type, node.name],
          level: node.level || 2,
          priority: isRoute ? 80 : 50
        };
      }
    }

    for (const edge of edges) {
      edge.perspectives = [];
      if (edge.type === 'calls' || edge.type === 'renders' || edge.type === 'uses') {
        edge.perspectives.push('nextjs-routes');
      }
      if (edge.type === 'imports' || edge.type === 'contains') {
        edge.perspectives.push('nextjs-architecture');
      }
    }
  }
}
