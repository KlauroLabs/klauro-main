import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint,
  CASPerspective, FileAnalysisResult
} from '../../../types/cas.types';
import * as path from 'path';
import * as fs from 'fs-extra';
import { glob } from 'glob';

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);
const NUXT_CONFIG_FILES = ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs'];

// Directory kinds Nuxt assigns special meaning to, used both by the full and
// incremental code paths so file -> node attribution stays identical.
type NuxtFileKind =
  | 'page'
  | 'server-api'
  | 'server-route'
  | 'component'
  | 'composable'
  | 'layout'
  | 'middleware'
  | 'plugin';

/**
 * Nuxt (Vue meta-framework) analyzer.
 *
 * Extracts Nuxt's convention-over-configuration semantics with line/regex
 * heuristics (no AST): file-based pages routing, Nitro server routes/api,
 * auto-imported components & composables, layouts, route middleware and plugins.
 *
 * Mirrors the framework-analyzer contract and the Next.js file-based routing
 * reference. Supports single-file incremental analysis because it attributes
 * file-level nodes (pages, endpoints, components, ...) and must not force a full
 * rebuild on every touched file.
 */
export class NuxtAnalyzer extends BaseAnalyzer {
  constructor() {
    super('nuxt', 'Nuxt Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const packageJsonPath = path.join(projectPath, 'package.json');
      if (await fs.pathExists(packageJsonPath)) {
        const packageJson = await fs.readJson(packageJsonPath);
        const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
        if (Object.keys(deps).some(dep => dep === 'nuxt' || dep === 'nuxt3' || dep.startsWith('@nuxt/'))) {
          return true;
        }
      }

      for (const configFile of NUXT_CONFIG_FILES) {
        if (await fs.pathExists(path.join(projectPath, configFile))) return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    const files = await this.findNuxtFiles(projectPath, { projectPath });
    return files.sort();
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    const content = await fs.readFile(context.filePath, 'utf-8');
    const stat = await fs.stat(context.filePath);

    const kind = this.classifyFile(context.relativePath);
    if (kind) {
      this.emitFileNode(kind, context.relativePath, content, nodes, entryPoints);
    }

    return this.createFileAnalysisResult(
      context.filePath,
      context.relativePath,
      context.contentHash || this.computeContentHash(content),
      stat.mtimeMs,
      nodes,
      edges,
      entryPoints,
      exitPoints,
      [],
      []
    );
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    this.resetAnalysisWarnings();
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    const files = this.capAndPrioritizeSourceFiles(
      await this.findNuxtFiles(context.projectPath, context),
      'Nuxt source files'
    ).sort();

    let pageCount = 0;
    let serverRouteCount = 0;
    let componentCount = 0;
    let composableCount = 0;
    let layoutCount = 0;
    let middlewareCount = 0;
    let pluginCount = 0;

    for (const relativePath of files) {
      const kind = this.classifyFile(relativePath);
      if (!kind) continue;

      const fullPath = path.join(context.projectPath, relativePath);
      let content = '';
      try {
        content = await fs.readFile(fullPath, 'utf-8');
      } catch {
        continue;
      }

      this.emitFileNode(kind, relativePath, content, nodes, entryPoints);

      switch (kind) {
        case 'page': pageCount++; break;
        case 'server-api':
        case 'server-route': serverRouteCount++; break;
        case 'component': componentCount++; break;
        case 'composable': composableCount++; break;
        case 'layout': layoutCount++; break;
        case 'middleware': middlewareCount++; break;
        case 'plugin': pluginCount++; break;
      }
    }

    const modules = await this.extractConfigModules(context.projectPath, nodes);

    const perspectives: CASPerspective[] = [];
    this.createPerspectives(perspectives);
    this.tagNodesWithPerspectives(nodes, edges);

    const contribution = this.createContribution(nodes, edges, entryPoints, exitPoints, {
      framework_specific: {
        nuxt_version: await this.getFrameworkVersion(context.projectPath, 'nuxt'),
        pages_detected: pageCount,
        server_routes_detected: serverRouteCount,
        components_detected: componentCount,
        composables_detected: composableCount,
        layouts_detected: layoutCount,
        middleware_detected: middlewareCount,
        plugins_detected: pluginCount,
        modules_detected: modules.length,
        nodes_created: nodes.length
      },
      warnings: this.collectAnalysisWarnings()
    });

    contribution.perspectives = perspectives;
    contribution.provided_perspectives = perspectives.map(p => p.id);

    return contribution;
  }

  // ---------------------------------------------------------------------------
  // File discovery & classification
  // ---------------------------------------------------------------------------

  private async findNuxtFiles(projectPath: string, context: AnalysisContext): Promise<string[]> {
    const ignorePatterns = [
      ...this.getIgnorePatterns(context),
      '**/*.test.*',
      '**/*.spec.*',
      '**/__tests__/**'
    ];

    const files = await glob([
      'pages/**/*.vue',
      'server/api/**/*.{ts,js,mjs}',
      'server/routes/**/*.{ts,js,mjs}',
      'components/**/*.vue',
      'composables/**/*.{ts,js,mjs}',
      'layouts/**/*.vue',
      'middleware/**/*.{ts,js,mjs}',
      'plugins/**/*.{ts,js,mjs}'
    ], {
      cwd: projectPath,
      ignore: ignorePatterns,
      nodir: true
    });

    return files.map(f => f.replace(/\\/g, '/'));
  }

  private classifyFile(relativePath: string): NuxtFileKind | null {
    const p = relativePath.replace(/\\/g, '/');
    if (/(^|\/)pages\/.+\.vue$/.test(p)) return 'page';
    if (/(^|\/)server\/api\/.+\.(ts|js|mjs)$/.test(p)) return 'server-api';
    if (/(^|\/)server\/routes\/.+\.(ts|js|mjs)$/.test(p)) return 'server-route';
    if (/(^|\/)components\/.+\.vue$/.test(p)) return 'component';
    if (/(^|\/)composables\/.+\.(ts|js|mjs)$/.test(p)) return 'composable';
    if (/(^|\/)layouts\/.+\.vue$/.test(p)) return 'layout';
    if (/(^|\/)middleware\/.+\.(ts|js|mjs)$/.test(p)) return 'middleware';
    if (/(^|\/)plugins\/.+\.(ts|js|mjs)$/.test(p)) return 'plugin';
    return null;
  }

  // ---------------------------------------------------------------------------
  // Node / entry-point emission (shared by full + incremental paths)
  // ---------------------------------------------------------------------------

  private emitFileNode(
    kind: NuxtFileKind,
    relativePath: string,
    content: string,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[]
  ): void {
    switch (kind) {
      case 'page':
        this.emitPage(relativePath, nodes, entryPoints);
        break;
      case 'server-api':
        this.emitServerRoute(relativePath, content, nodes, entryPoints, true);
        break;
      case 'server-route':
        this.emitServerRoute(relativePath, content, nodes, entryPoints, false);
        break;
      case 'component':
        this.emitComponent(relativePath, nodes);
        break;
      case 'composable':
        this.emitComposables(relativePath, content, nodes);
        break;
      case 'layout':
        this.emitLayout(relativePath, nodes);
        break;
      case 'middleware':
        this.emitMiddleware(relativePath, nodes, entryPoints);
        break;
      case 'plugin':
        this.emitPlugin(relativePath, nodes);
        break;
    }
  }

  private emitPage(relativePath: string, nodes: CASNode[], entryPoints: CASEntryPoint[]): void {
    const routePath = this.derivePageRoute(relativePath);
    const dynamic = /\[[^\]]+\]/.test(relativePath);
    const nodeId = `nuxt_page_${this.sanitizeId(relativePath)}`;

    nodes.push(this.createNode(nodeId, `Page ${routePath}`, 'page', 3, relativePath, undefined, undefined, {
      framework: 'nuxt',
      attributes: { routePath, dynamic }
    }));

    entryPoints.push({
      id: `entry_nuxt_page_${this.sanitizeId(relativePath)}`,
      source_node: nodeId,
      source_analyzer: this.analyzerId,
      type: 'page',
      name: `PAGE ${routePath}`,
      trigger: { method: 'GET', path: routePath },
      metadata: { framework: 'nuxt', pageFile: relativePath, dynamic }
    });
  }

  private emitServerRoute(
    relativePath: string,
    content: string,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    isApi: boolean
  ): void {
    const { routePath, method } = this.deriveServerRoute(relativePath, content, isApi);
    const nodeId = `nuxt_server_route_${this.sanitizeId(relativePath)}`;

    nodes.push(this.createNode(nodeId, `${isApi ? 'API' : 'Server'} ${method} ${routePath}`, 'api-route', 3, relativePath, undefined, undefined, {
      framework: 'nuxt',
      attributes: { routePath, method, runtime: 'nitro', kind: isApi ? 'api' : 'route' }
    }));

    entryPoints.push({
      id: `entry_nuxt_server_${this.sanitizeId(relativePath)}_${method}`,
      source_node: nodeId,
      source_analyzer: this.analyzerId,
      type: 'http',
      name: `${method} ${routePath}`,
      trigger: { method, path: routePath },
      metadata: { framework: 'nuxt', routeFile: relativePath, runtime: 'nitro' }
    });
  }

  private emitComponent(relativePath: string, nodes: CASNode[]): void {
    const name = this.deriveComponentName(relativePath);
    const nodeId = `nuxt_component_${this.sanitizeId(relativePath)}`;
    nodes.push(this.createNode(nodeId, name, 'component', 2, relativePath, undefined, undefined, {
      framework: 'nuxt',
      attributes: { autoImported: true, componentName: name }
    }));
  }

  private emitComposables(relativePath: string, content: string, nodes: CASNode[]): void {
    const names = this.extractComposableNames(content, relativePath);
    for (const name of names) {
      const nodeId = `nuxt_composable_${this.sanitizeId(relativePath)}_${name}`;
      nodes.push(this.createNode(nodeId, name, 'composable', 3, relativePath, undefined, undefined, {
        framework: 'nuxt',
        attributes: { autoImported: true }
      }));
    }
  }

  private emitLayout(relativePath: string, nodes: CASNode[]): void {
    const name = path.basename(relativePath, '.vue');
    const nodeId = `nuxt_layout_${this.sanitizeId(relativePath)}`;
    nodes.push(this.createNode(nodeId, `Layout ${name}`, 'layout', 2, relativePath, undefined, undefined, {
      framework: 'nuxt',
      attributes: { layoutName: name }
    }));
  }

  private emitMiddleware(relativePath: string, nodes: CASNode[], entryPoints: CASEntryPoint[]): void {
    const name = path.basename(relativePath).replace(/\.global\.(ts|js|mjs)$/, '').replace(/\.(ts|js|mjs)$/, '');
    const isGlobal = /\.global\.(ts|js|mjs)$/.test(relativePath);
    const isAuth = /auth|guard|login|session|protect/i.test(name);
    const nodeId = `nuxt_middleware_${this.sanitizeId(relativePath)}`;

    nodes.push(this.createNode(nodeId, `Middleware ${name}`, 'middleware', 2, relativePath, undefined, undefined, {
      framework: 'nuxt',
      attributes: { middlewareName: name, global: isGlobal, auth: isAuth }
    }));

    entryPoints.push({
      id: `entry_nuxt_middleware_${this.sanitizeId(relativePath)}`,
      source_node: nodeId,
      source_analyzer: this.analyzerId,
      type: 'lifecycle',
      name: `MIDDLEWARE ${name}`,
      trigger: { method: 'ALL', path: isGlobal ? '/*' : `(named: ${name})` },
      security: isAuth ? { authenticated: true } : undefined,
      metadata: { framework: 'nuxt', middlewareFile: relativePath, global: isGlobal, auth: isAuth }
    });
  }

  private emitPlugin(relativePath: string, nodes: CASNode[]): void {
    const name = path.basename(relativePath).replace(/\.(client|server)\.(ts|js|mjs)$/, '').replace(/\.(ts|js|mjs)$/, '');
    const side = /\.client\.(ts|js|mjs)$/.test(relativePath)
      ? 'client'
      : /\.server\.(ts|js|mjs)$/.test(relativePath)
        ? 'server'
        : 'universal';
    const nodeId = `nuxt_plugin_${this.sanitizeId(relativePath)}`;
    nodes.push(this.createNode(nodeId, `Plugin ${name}`, 'plugin', 2, relativePath, undefined, undefined, {
      framework: 'nuxt',
      attributes: { pluginName: name, side }
    }));
  }

  // ---------------------------------------------------------------------------
  // Route derivation
  // ---------------------------------------------------------------------------

  /** pages/users/[id].vue -> /users/:id ; pages/index.vue -> / ; [...slug] -> /:slug* */
  private derivePageRoute(relativePath: string): string {
    const match = relativePath.replace(/\\/g, '/').match(/(?:^|\/)pages\/(.+)\.vue$/);
    let route = match ? match[1] : '';

    route = route
      .replace(/\[\.\.\.([^\]]+)\]/g, ':$1*')   // catch-all [...slug] -> :slug*
      .replace(/\[([^\]]+)\]/g, ':$1');         // dynamic [id] -> :id

    // index segments collapse to their parent path
    route = route.replace(/(^|\/)index$/, '');

    let result = `/${route}`.replace(/\/+/g, '/');
    if (result.length > 1 && result.endsWith('/')) result = result.slice(0, -1);
    return result || '/';
  }

  /**
   * server/api/health.get.ts -> { /api/health, GET }
   * server/api/users/[id].ts -> { /api/users/:id, ALL (or from defineEventHandler) }
   * server/routes/sitemap.xml.ts -> { /sitemap.xml, GET/ALL }
   */
  private deriveServerRoute(
    relativePath: string,
    content: string,
    isApi: boolean
  ): { routePath: string; method: string } {
    const p = relativePath.replace(/\\/g, '/');
    const baseMatch = isApi
      ? p.match(/(?:^|\/)server\/api\/(.+)\.(ts|js|mjs)$/)
      : p.match(/(?:^|\/)server\/routes\/(.+)\.(ts|js|mjs)$/);

    let routeBody = baseMatch ? baseMatch[1] : '';
    let method = 'ALL';

    // Method suffix: foo.get / foo.post / foo.delete ...
    const suffixMatch = routeBody.match(/\.(get|post|put|delete|patch|head|options)$/i);
    if (suffixMatch) {
      method = suffixMatch[1].toUpperCase();
      routeBody = routeBody.slice(0, -(suffixMatch[0].length));
    }

    routeBody = routeBody
      .replace(/\[\.\.\.([^\]]+)\]/g, ':$1*')
      .replace(/\[([^\]]+)\]/g, ':$1')
      .replace(/(^|\/)index$/, '');

    let routePath = isApi ? `/api/${routeBody}` : `/${routeBody}`;
    routePath = routePath.replace(/\/+/g, '/');
    if (routePath.length > 1 && routePath.endsWith('/')) routePath = routePath.slice(0, -1);
    if (routePath === '') routePath = '/';

    // If no filename suffix, try to read the method off defineEventHandler usage.
    if (method === 'ALL') {
      const evMethod = this.detectHandlerMethod(content);
      if (evMethod) method = evMethod;
    }

    return { routePath, method };
  }

  private detectHandlerMethod(content: string): string | null {
    // getMethod(event) === 'POST' / readBody only on writes, or explicit router method.
    const eqMatch = content.match(/getMethod\s*\(\s*\w+\s*\)\s*===?\s*['"`](\w+)['"`]/);
    if (eqMatch && HTTP_METHODS.has(eqMatch[1].toUpperCase())) return eqMatch[1].toUpperCase();
    if (/\breadBody\s*\(/.test(content) || /\breadValidatedBody\s*\(/.test(content)) return 'POST';
    return null;
  }

  private deriveComponentName(relativePath: string): string {
    // Nuxt builds the auto-import name from the path under components/ (PascalCased, dir-prefixed).
    const match = relativePath.replace(/\\/g, '/').match(/(?:^|\/)components\/(.+)\.vue$/);
    const rel = match ? match[1] : path.basename(relativePath, '.vue');
    const segments = rel.split('/');
    const pascal = segments
      .map(seg => seg.replace(/(^|[-_])(\w)/g, (_, __, c) => c.toUpperCase()))
      .join('');
    return pascal || path.basename(relativePath, '.vue');
  }

  private extractComposableNames(content: string, relativePath: string): string[] {
    const names = new Set<string>();
    const patterns = [
      /export\s+(?:default\s+)?(?:async\s+)?function\s+(use[A-Z]\w*)/g,
      /export\s+const\s+(use[A-Z]\w*)\s*=/g,
      /export\s+\{[^}]*\b(use[A-Z]\w*)\b[^}]*\}/g
    ];
    for (const re of patterns) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) names.add(m[1]);
    }
    // Default export composable named after the file (composables/useAuth.ts -> useAuth).
    const base = path.basename(relativePath).replace(/\.(ts|js|mjs)$/, '');
    if (/^use[A-Z]\w*/.test(base) && /export\s+default/.test(content)) names.add(base);
    if (names.size === 0 && /^use[A-Z]\w*/.test(base)) names.add(base);
    return Array.from(names);
  }

  private async extractConfigModules(projectPath: string, nodes: CASNode[]): Promise<string[]> {
    const modules: string[] = [];
    for (const configFile of NUXT_CONFIG_FILES) {
      const configPath = path.join(projectPath, configFile);
      if (!await fs.pathExists(configPath)) continue;
      let content = '';
      try {
        content = await fs.readFile(configPath, 'utf-8');
      } catch {
        continue;
      }
      const blockMatch = content.match(/modules\s*:\s*\[([\s\S]*?)\]/);
      if (blockMatch) {
        const stringPattern = /['"`]([^'"`]+)['"`]/g;
        let m: RegExpExecArray | null;
        while ((m = stringPattern.exec(blockMatch[1])) !== null) modules.push(m[1]);
      }
      for (const mod of modules) {
        const nodeId = `nuxt_module_${this.sanitizeId(configFile)}_${this.sanitizeId(mod)}`;
        nodes.push(this.createNode(nodeId, `Module ${mod}`, 'module', 2, configFile, undefined, undefined, {
          framework: 'nuxt',
          attributes: { moduleName: mod }
        }));
      }
      break;
    }
    return modules;
  }

  // ---------------------------------------------------------------------------
  // Capabilities, levels, perspectives
  // ---------------------------------------------------------------------------

  protected getCapabilities(): string[] {
    return ['nuxt-pages', 'nuxt-server-routes', 'nuxt-components', 'nuxt-composables'];
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
      id: 'nuxt-routes',
      name: 'Nuxt Routing',
      description: 'Pages, Nitro server routes/api and route middleware showing the request routing surface',
      analyzer_id: this.analyzerId,
      type: 'flow',
      connection_rules: {
        visible_node_types: ['page', 'api-route', 'middleware', 'layout', 'route', 'endpoint'],
        relevant_edge_types: ['renders', 'calls', 'uses', 'contains', 'processes'],
        node_connections: [
          { from_type: 'middleware', to_types: ['page'], edge_type: 'processes' },
          { from_type: 'layout', to_types: ['page'], edge_type: 'contains' }
        ]
      },
      layout_hints: { style: 'hierarchical', direction: 'TB', group_by: 'route_segment' }
    });

    perspectives.push({
      id: 'nuxt-architecture',
      name: 'Nuxt Application Architecture',
      description: 'Application layers: Pages -> Components -> Composables -> Server Routes',
      analyzer_id: this.analyzerId,
      type: 'structure',
      connection_rules: {
        visible_node_types: ['page', 'api-route', 'component', 'composable', 'layout', 'middleware', 'plugin', 'module'],
        relevant_edge_types: ['imports', 'calls', 'uses', 'contains', 'renders']
      },
      layout_hints: { style: 'hierarchical', direction: 'LR' }
    });
  }

  private tagNodesWithPerspectives(nodes: CASNode[], edges: CASEdge[]): void {
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      if (!node.perspectives) node.perspectives = {};

      const isRoute = node.type === 'page' || node.type === 'api-route' ||
        node.type === 'route' || node.type === 'endpoint';
      const isLayout = node.type === 'layout';
      const isMiddleware = node.type === 'middleware';

      if (isRoute || isLayout || isMiddleware) {
        node.perspectives['nuxt-routes'] = {
          hierarchy: ['routing', node.type, node.name],
          level: node.level || 2,
          priority: isRoute ? 90 : isMiddleware ? 80 : 70
        };
      }

      node.perspectives['nuxt-architecture'] = {
        hierarchy: ['architecture', node.category || node.type, node.name],
        level: node.level || 2,
        priority: isRoute ? 80 : 50
      };
    }

    for (const edge of edges) {
      edge.perspectives = [];
      if (edge.type === 'calls' || edge.type === 'renders' || edge.type === 'uses' || edge.type === 'processes') {
        edge.perspectives.push('nuxt-routes');
      }
      if (edge.type === 'imports' || edge.type === 'contains') {
        edge.perspectives.push('nuxt-architecture');
      }
    }
  }
}
