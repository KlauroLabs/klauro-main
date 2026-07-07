import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint,
  CASPerspective, FileAnalysisResult
} from '../../../types/cas.types';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';

const ROUTE_GLOBS = ['src/routes/**/*.{tsx,jsx,ts,js}'];
const COMPONENT_GLOBS = ['src/components/**/*.{tsx,jsx,ts,js}'];

// SolidStart / Solid server-data + action primitives.
const SERVER_DATA_FNS = ['createServerData$', 'createRouteData', 'cache'];
const ACTION_FNS = ['action', 'createAction'];
// Solid reactive state primitives (light touch).
const STATE_FNS = ['createSignal', 'createStore'];

interface SolidRouteInfo {
  relativePath: string;
  routePath: string;
  isIndex: boolean;
  isApi: boolean;
  isLayout: boolean;
  hasUseServer: boolean;
  serverDataFns: string[];
  actionFns: string[];
  httpMethods: string[];
}

interface SolidFileExtraction {
  route?: SolidRouteInfo;
  component?: { name: string };
  signals: string[];
}

export class SolidStartAnalyzer extends BaseAnalyzer {
  constructor() {
    super('solidstart', 'SolidStart Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const packageJsonPath = path.join(projectPath, 'package.json');
      if (await fs.pathExists(packageJsonPath)) {
        const packageJson = await fs.readJson(packageJsonPath);
        const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
        if (deps['solid-start'] || deps['@solidjs/start']) return true;
      }

      // app.config.ts referencing solid is a strong SolidStart signal.
      const appConfig = path.join(projectPath, 'app.config.ts');
      if (await fs.pathExists(appConfig)) {
        try {
          const content = await fs.readFile(appConfig, 'utf-8');
          if (/solid/i.test(content)) return true;
        } catch {
          // ignore
        }
      }

      // A src/routes dir with Solid conventions (index.tsx / [param]).
      const routesDir = path.join(projectPath, 'src', 'routes');
      if (await fs.pathExists(routesDir)) {
        const hasSolidDep = await this.getPackageVersion(projectPath, 'solid-js');
        if (hasSolidDep) return true;
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
    const files = await glob([...ROUTE_GLOBS, ...COMPONENT_GLOBS], {
      cwd: projectPath,
      ignore: ['**/node_modules/**', '**/*.test.*', '**/*.spec.*', '**/__tests__/**'],
      nodir: true
    });
    return files.sort();
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    const content = await fs.readFile(context.filePath, 'utf-8');
    const stat = await fs.stat(context.filePath);
    const file = context.relativePath;

    const extraction = this.extractFromFile(file, content);
    this.emitFromExtraction(extraction, file, nodes, entryPoints);

    return this.createFileAnalysisResult(
      context.filePath,
      file,
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
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    const sourceFiles = await glob([...ROUTE_GLOBS, ...COMPONENT_GLOBS], {
      cwd: context.projectPath,
      ignore: [
        ...this.getIgnorePatterns(context),
        '**/*.test.*', '**/*.spec.*', '**/__tests__/**'
      ],
      nodir: true
    });

    for (const file of sourceFiles) {
      const fullPath = path.join(context.projectPath, file);
      let content: string;
      try {
        content = await fs.readFile(fullPath, 'utf-8');
      } catch {
        continue;
      }
      const extraction = this.extractFromFile(file, content);
      this.emitFromExtraction(extraction, file, nodes, entryPoints);
    }

    const perspectives: CASPerspective[] = [];
    this.createPerspectives(perspectives);
    this.tagNodesWithPerspectives(nodes, edges);

    const contribution = this.createContribution(nodes, edges, entryPoints, exitPoints, {
      framework_specific: {
        routes_detected: nodes.filter(n => n.type === 'route' || n.type === 'page').length,
        api_routes_detected: nodes.filter(n => n.type === 'api-route').length,
        server_fns_detected: entryPoints.filter(ep => ep.metadata?.kind === 'server-data' || ep.metadata?.kind === 'action').length,
        components_detected: nodes.filter(n => n.type === 'component').length,
        nodes_created: nodes.length
      }
    });

    contribution.perspectives = perspectives;
    contribution.provided_perspectives = perspectives.map(p => p.id);

    return contribution;
  }

  /**
   * Shared per-file extraction used by both the full and incremental paths.
   */
  private extractFromFile(file: string, content: string): SolidFileExtraction {
    const normalized = file.replace(/\\/g, '/');
    const signals = this.findStateFns(content);

    const isRouteFile = /(^|\/)src\/routes\//.test(normalized);
    if (isRouteFile) {
      const route = this.parseRouteModule(normalized, content);
      return { route, signals };
    }

    const isComponentFile = /(^|\/)src\/components\//.test(normalized);
    if (isComponentFile) {
      const component = this.parseComponent(normalized, content);
      if (component) return { component, signals };
    }

    return { signals };
  }

  private emitFromExtraction(
    extraction: SolidFileExtraction,
    file: string,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[]
  ): void {
    if (extraction.route) {
      this.emitRouteNodes(extraction.route, file, nodes, entryPoints);
    }
    if (extraction.component) {
      this.emitComponentNode(extraction.component, file, nodes, extraction.signals);
    }
  }

  private parseRouteModule(file: string, content: string): SolidRouteInfo {
    const { routePath, isIndex } = this.deriveRouteFromFile(file);
    const isApi = /(^|\/)src\/routes\/api\//.test(file);
    const isLayout = /(^|\/)(layout)\.(tsx|jsx|ts|js)$/.test(file);
    const hasUseServer = /["']use server["']/.test(content);

    const serverDataFns = SERVER_DATA_FNS.filter(fn =>
      new RegExp(`\\b${this.escapeRegex(fn)}\\s*\\(`).test(content)
    );
    const actionFns = ACTION_FNS.filter(fn =>
      new RegExp(`\\b${this.escapeRegex(fn)}\\s*\\(`).test(content)
    );

    // API route HTTP method exports (GET/POST/...).
    const httpMethods: string[] = [];
    const methodPattern = /export\s+(?:async\s+)?(?:function\s+|const\s+)(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/g;
    let m: RegExpExecArray | null;
    while ((m = methodPattern.exec(content)) !== null) {
      httpMethods.push(m[1].toUpperCase());
    }

    return {
      relativePath: file,
      routePath,
      isIndex,
      isApi,
      isLayout,
      hasUseServer,
      serverDataFns,
      actionFns,
      httpMethods: Array.from(new Set(httpMethods))
    };
  }

  private parseComponent(file: string, content: string): { name: string } | null {
    // A Solid component is a function returning JSX. Use the file basename as the
    // component name, but require JSX/component-like content to avoid plain modules.
    const looksLikeComponent =
      /return\s*\(?\s*</.test(content) ||
      /=>\s*\(?\s*</.test(content) ||
      /\.tsx$|\.jsx$/.test(file);
    if (!looksLikeComponent) return null;
    const base = path.basename(file).replace(/\.(tsx|jsx|ts|js)$/, '');
    return { name: base };
  }

  private findStateFns(content: string): string[] {
    return STATE_FNS.filter(fn =>
      new RegExp(`\\b${this.escapeRegex(fn)}\\s*[<(]`).test(content)
    );
  }

  private emitRouteNodes(
    info: SolidRouteInfo,
    file: string,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[]
  ): void {
    if (info.isApi) {
      const nodeId = `solidstart_api_${this.sanitizeId(file)}`;
      nodes.push(this.createNode(nodeId, `API Route ${info.routePath}`, 'api-route', 3, file, undefined, undefined, {
        framework: 'solidstart',
        attributes: { routePath: info.routePath, isApi: true, httpMethods: info.httpMethods }
      }));

      const methods = info.httpMethods.length > 0 ? info.httpMethods : ['ALL'];
      for (const method of methods) {
        const entryId = `entry_solidstart_api_${this.sanitizeId(file)}_${method}`;
        entryPoints.push({
          id: entryId,
          source_node: nodeId,
          source_analyzer: this.analyzerId,
          type: 'http',
          name: `${method} ${info.routePath}`,
          trigger: { method, path: info.routePath },
          metadata: { framework: 'solidstart', kind: 'api', routeFile: file }
        });
      }
      return;
    }

    const nodeId = `solidstart_route_${this.sanitizeId(file)}`;
    const nodeType = info.isLayout ? 'layout' : 'route';
    const label = info.isLayout ? `Layout ${info.routePath}` : `Route ${info.routePath}`;

    nodes.push(this.createNode(nodeId, label, nodeType, 3, file, undefined, undefined, {
      framework: 'solidstart',
      attributes: {
        routePath: info.routePath,
        isIndex: info.isIndex,
        isLayout: info.isLayout,
        hasServerData: info.serverDataFns.length > 0,
        hasAction: info.actionFns.length > 0,
        hasUseServer: info.hasUseServer
      }
    }));

    // Route component itself is a page entry point (GET render).
    if (!info.isLayout) {
      const pageEntryId = `entry_solidstart_page_${this.sanitizeId(file)}`;
      entryPoints.push({
        id: pageEntryId,
        source_node: nodeId,
        source_analyzer: this.analyzerId,
        type: 'page',
        name: `PAGE ${info.routePath}`,
        trigger: { method: 'GET', path: info.routePath },
        metadata: { framework: 'solidstart', kind: 'page', routeFile: file }
      });
    }

    // Server data functions -> data entry points.
    for (const fn of info.serverDataFns) {
      const entryId = `entry_solidstart_serverdata_${this.sanitizeId(file)}_${fn.replace(/[^a-zA-Z0-9]/g, '_')}`;
      entryPoints.push({
        id: entryId,
        source_node: nodeId,
        source_analyzer: this.analyzerId,
        type: 'http',
        name: `SERVER-DATA ${info.routePath}`,
        trigger: { method: 'GET', path: info.routePath },
        handler: { node_id: nodeId, method_name: fn, file },
        metadata: { framework: 'solidstart', kind: 'server-data', primitive: fn, routeFile: file }
      });
    }

    // Action functions -> mutation entry points.
    for (const fn of info.actionFns) {
      const entryId = `entry_solidstart_action_${this.sanitizeId(file)}_${fn.replace(/[^a-zA-Z0-9]/g, '_')}`;
      entryPoints.push({
        id: entryId,
        source_node: nodeId,
        source_analyzer: this.analyzerId,
        type: 'http',
        name: `ACTION ${info.routePath}`,
        trigger: { method: 'POST', path: info.routePath },
        handler: { node_id: nodeId, method_name: fn, file },
        metadata: { framework: 'solidstart', kind: 'action', primitive: fn, routeFile: file }
      });
    }

    // "use server" directive -> server function entry point.
    if (info.hasUseServer) {
      const entryId = `entry_solidstart_useserver_${this.sanitizeId(file)}`;
      entryPoints.push({
        id: entryId,
        source_node: nodeId,
        source_analyzer: this.analyzerId,
        type: 'http',
        name: `SERVER-FN ${info.routePath}`,
        trigger: { method: 'POST', path: info.routePath },
        metadata: { framework: 'solidstart', kind: 'server-fn', routeFile: file }
      });
    }
  }

  private emitComponentNode(
    component: { name: string },
    file: string,
    nodes: CASNode[],
    signals: string[]
  ): void {
    const nodeId = `solidstart_component_${this.sanitizeId(file)}`;
    nodes.push(this.createNode(nodeId, component.name, 'component', 3, file, undefined, undefined, {
      framework: 'solidstart',
      attributes: {
        tag: 'solid-component',
        hasState: signals.length > 0,
        stateFns: signals
      }
    }));
  }

  /**
   * Map a SolidStart route file path to its URL path.
   * Conventions: index, [param] dynamic, [...slug] splat, (group) pathless groups.
   */
  private deriveRouteFromFile(file: string): { routePath: string; isIndex: boolean } {
    let rel = file.replace(/\\/g, '/').replace(/^.*?src\/routes\//, '');
    rel = rel.replace(/\.(tsx|jsx|ts|js)$/, '');

    const segments = rel.split('/').filter(s => s.length > 0);
    const pathParts: string[] = [];
    let isIndex = false;

    for (const seg of segments) {
      if (seg === 'index') {
        isIndex = true;
        continue;
      }
      // Pathless group: (marketing) etc.
      if (/^\(.+\)$/.test(seg)) {
        continue;
      }
      // Splat: [...slug] -> *
      const splat = seg.match(/^\[\.\.\.(.+)\]$/);
      if (splat) {
        pathParts.push('*');
        continue;
      }
      // Dynamic param: [id] -> :id
      const param = seg.match(/^\[(.+)\]$/);
      if (param) {
        pathParts.push(`:${param[1]}`);
        continue;
      }
      pathParts.push(seg);
    }

    let routePath = '/' + pathParts.join('/');
    routePath = routePath.replace(/\/+/g, '/');
    if (routePath.length > 1 && routePath.endsWith('/')) {
      routePath = routePath.slice(0, -1);
    }
    return { routePath, isIndex };
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  protected getCapabilities(): string[] {
    return [
      'solidstart-routes',
      'solidstart-server-fns',
      'solidstart-components'
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
      id: 'solidstart-routes',
      name: 'SolidStart Routing',
      description: 'File-based routes, server data, and actions showing request and data flow',
      analyzer_id: this.analyzerId,
      type: 'flow',
      connection_rules: {
        visible_node_types: ['route', 'page', 'layout', 'api-route', 'endpoint', 'function', 'component'],
        relevant_edge_types: ['contains', 'calls', 'uses', 'renders'],
        node_connections: [
          {
            from_type: 'layout',
            to_types: ['route', 'page'],
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
      id: 'solidstart-architecture',
      name: 'SolidStart Application Architecture',
      description: 'Application layers: Routes -> Server Data/Actions -> Components -> Data',
      analyzer_id: this.analyzerId,
      type: 'structure',
      connection_rules: {
        visible_node_types: ['route', 'page', 'layout', 'api-route', 'component', 'function', 'class', 'module', 'file'],
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

      const isRoute = node.type === 'route' || node.type === 'page' ||
        node.type === 'api-route' || node.type === 'endpoint';
      const isLayout = node.type === 'layout';

      if (isRoute || isLayout) {
        node.perspectives['solidstart-routes'] = {
          hierarchy: ['routing', node.type, node.name],
          level: node.level || 2,
          priority: isRoute ? 90 : 70
        };
      }

      if (node.type !== 'import') {
        node.perspectives['solidstart-architecture'] = {
          hierarchy: ['architecture', node.category || node.type, node.name],
          level: node.level || 2,
          priority: isRoute ? 80 : 50
        };
      }
    }

    for (const edge of edges) {
      edge.perspectives = [];
      if (edge.type === 'contains' || edge.type === 'renders' || edge.type === 'calls') {
        edge.perspectives.push('solidstart-routes');
      }
      if (edge.type === 'imports' || edge.type === 'contains') {
        edge.perspectives.push('solidstart-architecture');
      }
    }
  }
}
