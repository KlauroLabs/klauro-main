import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint,
  CASPerspective, FileAnalysisResult
} from '../../../types/cas.types';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';

const ROUTE_GLOBS = ['app/routes/**/*.{tsx,jsx,ts,js}'];
const ROOT_GLOBS = ['app/root.{tsx,jsx,ts,js}'];

// Remix data/mutation export names.
const LOADER_EXPORTS = new Set(['loader', 'clientLoader']);
const ACTION_EXPORTS = new Set(['action', 'clientAction']);
// Other recognized Remix route module exports we tag.
const TAGGED_EXPORTS = new Set(['ErrorBoundary', 'meta', 'links', 'headers', 'handle', 'shouldRevalidate', 'HydrateFallback']);

interface RouteModuleInfo {
  relativePath: string;
  routePath: string;
  isIndex: boolean;
  isLayout: boolean;
  parentPath?: string;
  exports: Set<string>;
  loaders: string[];
  actions: string[];
  tags: string[];
}

export class RemixAnalyzer extends BaseAnalyzer {
  constructor() {
    super('remix', 'Remix Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const packageJsonPath = path.join(projectPath, 'package.json');
      if (await fs.pathExists(packageJsonPath)) {
        const packageJson = await fs.readJson(packageJsonPath);
        const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
        if (Object.keys(deps).some(d => d.startsWith('@remix-run/'))) return true;
        // react-router v7 framework mode reuses Remix conventions.
        if (deps['react-router'] || deps['@react-router/dev'] || deps['@react-router/node']) return true;
      }

      const configFiles = ['remix.config.js', 'remix.config.mjs', 'remix.config.cjs', 'remix.config.ts'];
      for (const configFile of configFiles) {
        if (await fs.pathExists(path.join(projectPath, configFile))) return true;
      }

      // A conventional app/routes dir is a strong signal.
      const routesDir = path.join(projectPath, 'app', 'routes');
      if (await fs.pathExists(routesDir)) {
        const root = ['root.tsx', 'root.jsx', 'root.ts', 'root.js'];
        for (const r of root) {
          if (await fs.pathExists(path.join(projectPath, 'app', r))) return true;
        }
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
    const files = await glob([...ROUTE_GLOBS, ...ROOT_GLOBS], {
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

    const info = this.parseRouteModule(file, content);
    if (info) {
      this.emitRouteNodes(info, file, nodes, entryPoints);
    }

    const exportedNames = this.getExportedNames(content);

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
      exportedNames
    );
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    const routeFiles = await glob(ROUTE_GLOBS, {
      cwd: context.projectPath,
      ignore: [
        ...this.getIgnorePatterns(context),
        '**/*.test.*', '**/*.spec.*', '**/__tests__/**'
      ],
      nodir: true
    });

    const modules: RouteModuleInfo[] = [];
    const byRoutePath = new Map<string, RouteModuleInfo>();

    for (const file of routeFiles) {
      const fullPath = path.join(context.projectPath, file);
      let content: string;
      try {
        content = await fs.readFile(fullPath, 'utf-8');
      } catch {
        continue;
      }
      const info = this.parseRouteModule(file, content);
      if (!info) continue;
      modules.push(info);
      byRoutePath.set(info.relativePath, info);
    }

    // Detect root.tsx as a top-level layout/entry.
    await this.detectRoot(context, nodes, entryPoints);

    for (const info of modules) {
      this.emitRouteNodes(info, info.relativePath, nodes, entryPoints);
    }

    // Nested-route composition edges from dotted/folder nesting.
    this.emitNestingEdges(modules, context, nodes, edges);

    const perspectives: CASPerspective[] = [];
    this.createPerspectives(perspectives);
    this.tagNodesWithPerspectives(nodes, edges);

    const contribution = this.createContribution(nodes, edges, entryPoints, exitPoints, {
      framework_specific: {
        routes_detected: nodes.filter(n => n.type === 'route' || n.type === 'page').length,
        loaders_detected: entryPoints.filter(ep => ep.metadata?.kind === 'loader').length,
        actions_detected: entryPoints.filter(ep => ep.metadata?.kind === 'action').length,
        nested_route_edges: edges.filter(e => e.type === 'contains').length,
        nodes_created: nodes.length
      }
    });

    contribution.perspectives = perspectives;
    contribution.provided_perspectives = perspectives.map(p => p.id);

    return contribution;
  }

  private async detectRoot(
    context: AnalysisContext,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[]
  ): Promise<void> {
    const candidates = ['app/root.tsx', 'app/root.jsx', 'app/root.ts', 'app/root.js'];
    for (const file of candidates) {
      const fullPath = path.join(context.projectPath, file);
      if (!await fs.pathExists(fullPath)) continue;
      const content = await fs.readFile(fullPath, 'utf-8');
      const exports = this.getExportedNames(content);

      const nodeId = this.findFileNodeId(file, context.existingAnalysis)
        || `remix_root_${this.sanitizeId(file)}`;

      if (!this.findFileNodeId(file, context.existingAnalysis)) {
        nodes.push(this.createNode(nodeId, 'Root Layout', 'layout', 2, file, undefined, undefined, {
          framework: 'remix',
          attributes: { routePath: '/', isRoot: true, tags: exports.filter(e => TAGGED_EXPORTS.has(e)) }
        }));
      }
      break;
    }
  }

  private parseRouteModule(file: string, content: string): RouteModuleInfo | null {
    const exports = new Set(this.getExportedNames(content));
    const { routePath, isIndex, isLayout, parentPath } = this.deriveRouteFromFile(file);

    const loaders = [...exports].filter(e => LOADER_EXPORTS.has(e));
    const actions = [...exports].filter(e => ACTION_EXPORTS.has(e));
    const tags = [...exports].filter(e => TAGGED_EXPORTS.has(e));

    return {
      relativePath: file,
      routePath,
      isIndex,
      isLayout,
      parentPath,
      exports,
      loaders,
      actions,
      tags
    };
  }

  private emitRouteNodes(
    info: RouteModuleInfo,
    file: string,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[]
  ): void {
    const nodeId = `remix_route_${this.sanitizeId(file)}`;
    const nodeType = info.isLayout ? 'layout' : 'route';
    const label = info.isLayout
      ? `Layout ${info.routePath}`
      : `Route ${info.routePath}`;

    nodes.push(this.createNode(nodeId, label, nodeType, 3, file, undefined, undefined, {
      framework: 'remix',
      attributes: {
        routePath: info.routePath,
        isIndex: info.isIndex,
        isLayout: info.isLayout,
        hasLoader: info.loaders.length > 0,
        hasAction: info.actions.length > 0,
        tags: info.tags
      }
    }));

    // The route component itself is a page entry point (GET render).
    if (!info.isLayout) {
      const pageEntryId = `entry_remix_page_${this.sanitizeId(file)}`;
      entryPoints.push({
        id: pageEntryId,
        source_node: nodeId,
        source_analyzer: this.analyzerId,
        type: 'page',
        name: `PAGE ${info.routePath}`,
        trigger: { method: 'GET', path: info.routePath },
        metadata: { framework: 'remix', kind: 'page', routeFile: file }
      });
    }

    // Loaders -> data entry points.
    for (const loader of info.loaders) {
      const entryId = `entry_remix_loader_${this.sanitizeId(file)}_${loader}`;
      entryPoints.push({
        id: entryId,
        source_node: nodeId,
        source_analyzer: this.analyzerId,
        type: 'http',
        name: `LOADER ${info.routePath}`,
        trigger: { method: 'GET', path: info.routePath },
        handler: { node_id: nodeId, method_name: loader, file },
        metadata: { framework: 'remix', kind: 'loader', export: loader, routeFile: file }
      });
    }

    // Actions -> mutation entry points.
    for (const action of info.actions) {
      const entryId = `entry_remix_action_${this.sanitizeId(file)}_${action}`;
      entryPoints.push({
        id: entryId,
        source_node: nodeId,
        source_analyzer: this.analyzerId,
        type: 'http',
        name: `ACTION ${info.routePath}`,
        trigger: { method: 'POST', path: info.routePath },
        handler: { node_id: nodeId, method_name: action, file },
        metadata: { framework: 'remix', kind: 'action', export: action, routeFile: file }
      });
    }
  }

  private emitNestingEdges(
    modules: RouteModuleInfo[],
    context: AnalysisContext,
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    const byRelative = new Map(modules.map(m => [m.relativePath, m]));
    const byRouteSegments = new Map<string, RouteModuleInfo>();
    for (const m of modules) {
      byRouteSegments.set(this.routeKey(m), m);
    }

    for (const child of modules) {
      const parent = this.findParentModule(child, modules);
      if (!parent) continue;

      const parentNodeId = `remix_route_${this.sanitizeId(parent.relativePath)}`;
      const childNodeId = `remix_route_${this.sanitizeId(child.relativePath)}`;
      if (parentNodeId === childNodeId) continue;

      const edgeId = this.generateEdgeId(parentNodeId, childNodeId, 'contains');
      edges.push(this.createEdge(edgeId, parentNodeId, childNodeId, 'contains', 'nested-route', {
        framework: 'remix'
      }));
    }
  }

  /**
   * Find the closest ancestor route module by route-segment containment.
   * Remix nests by dotted segments (users.$id <- users) and by _layout pathless routes.
   */
  private findParentModule(child: RouteModuleInfo, modules: RouteModuleInfo[]): RouteModuleInfo | undefined {
    const childSegs = this.routeSegments(child.relativePath);
    if (childSegs.length === 0) return undefined;

    let best: RouteModuleInfo | undefined;
    let bestLen = -1;
    for (const candidate of modules) {
      if (candidate.relativePath === child.relativePath) continue;
      const segs = this.routeSegments(candidate.relativePath);
      if (segs.length >= childSegs.length) continue;
      const isPrefix = segs.every((s, i) => s === childSegs[i]);
      if (isPrefix && segs.length > bestLen) {
        best = candidate;
        bestLen = segs.length;
      }
    }
    return best;
  }

  private routeKey(m: RouteModuleInfo): string {
    return this.routeSegments(m.relativePath).join('.');
  }

  /**
   * Convert a route file path into its Remix conventional segment list,
   * stripping the app/routes prefix, extension, _index, and route.tsx folder files.
   */
  private routeSegments(file: string): string[] {
    let rel = file.replace(/\\/g, '/');
    rel = rel.replace(/^app\/routes\//, '');
    // Folder form: foo.bar/route.tsx -> foo.bar
    rel = rel.replace(/\/route\.\w+$/, '');
    // Strip a remaining extension (flat file form).
    rel = rel.replace(/\.\w+$/, '');
    // Drop trailing _index marker; it shares its parent's segment set.
    const raw = rel.split('.').filter(seg => seg.length > 0);
    return raw.filter(seg => seg !== '_index');
  }

  /**
   * Map a Remix route filename to its URL path.
   * Conventions: _index, dotted segments, $param dynamic, ($optional), _layout pathless, route.tsx folders.
   */
  private deriveRouteFromFile(file: string): { routePath: string; isIndex: boolean; isLayout: boolean; parentPath?: string } {
    let rel = file.replace(/\\/g, '/').replace(/^app\/routes\//, '');
    rel = rel.replace(/\/route\.\w+$/, '');
    rel = rel.replace(/\.\w+$/, '');

    const segments = rel.split('.').filter(s => s.length > 0);

    let isIndex = false;
    let isLayout = false;
    const pathParts: string[] = [];

    for (const seg of segments) {
      if (seg === '_index') {
        isIndex = true;
        continue;
      }
      // Pathless layout segment: starts with _ (e.g. _layout, _auth).
      if (seg.startsWith('_')) {
        isLayout = true;
        continue;
      }
      // Optional segment: ($lang) -> :lang? ; (foo) -> foo?
      const optional = seg.match(/^\((.+)\)$/);
      if (optional) {
        const inner = optional[1];
        if (inner.startsWith('$')) {
          pathParts.push(`:${inner.slice(1)}?`);
        } else {
          pathParts.push(`${inner}?`);
        }
        continue;
      }
      // Splat.
      if (seg === '$') {
        pathParts.push('*');
        continue;
      }
      // Dynamic param: $id -> :id
      if (seg.startsWith('$')) {
        pathParts.push(`:${seg.slice(1)}`);
        continue;
      }
      // Escaped literal dot: [.] etc — keep inner.
      const escaped = seg.match(/^\[(.+)\]$/);
      if (escaped) {
        pathParts.push(escaped[1]);
        continue;
      }
      pathParts.push(seg);
    }

    let routePath = '/' + pathParts.join('/');
    if (routePath === '/' && !isIndex && pathParts.length === 0) {
      // Pure pathless layout maps to '/'.
      routePath = '/';
    }
    routePath = routePath.replace(/\/+/g, '/');
    if (routePath.length > 1 && routePath.endsWith('/')) {
      routePath = routePath.slice(0, -1);
    }

    return { routePath, isIndex, isLayout };
  }

  private getExportedNames(content: string): string[] {
    const names: string[] = [];

    const funcPattern = /export\s+(?:async\s+)?function\s+(\w+)/g;
    let match: RegExpExecArray | null;
    while ((match = funcPattern.exec(content)) !== null) {
      names.push(match[1]);
    }

    const constPattern = /export\s+(?:async\s+)?(?:const|let|var)\s+(\w+)/g;
    while ((match = constPattern.exec(content)) !== null) {
      names.push(match[1]);
    }

    // export { loader, action } and `export { foo as loader }`
    const namedPattern = /export\s*\{([^}]+)\}/g;
    while ((match = namedPattern.exec(content)) !== null) {
      const inner = match[1];
      for (const part of inner.split(',')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const asMatch = trimmed.match(/\bas\s+(\w+)/);
        if (asMatch) {
          names.push(asMatch[1]);
        } else {
          const id = trimmed.match(/^(\w+)/);
          if (id) names.push(id[1]);
        }
      }
    }

    // export class ErrorBoundary {}
    const classPattern = /export\s+(?:default\s+)?class\s+(\w+)/g;
    while ((match = classPattern.exec(content)) !== null) {
      names.push(match[1]);
    }

    if (/export\s+default/.test(content)) {
      names.push('default');
    }

    return Array.from(new Set(names));
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

  protected getCapabilities(): string[] {
    return [
      'remix-routes',
      'remix-loaders',
      'remix-actions',
      'remix-nested-routes'
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
      id: 'remix-routes',
      name: 'Remix Routing',
      description: 'File-based routes, loaders, and actions showing request and data flow',
      analyzer_id: this.analyzerId,
      type: 'flow',
      connection_rules: {
        visible_node_types: ['route', 'page', 'layout', 'endpoint', 'function', 'component'],
        relevant_edge_types: ['contains', 'calls', 'uses', 'renders'],
        node_connections: [
          {
            from_type: 'layout',
            to_types: ['route', 'page'],
            edge_type: 'contains'
          },
          {
            from_type: 'route',
            to_types: ['route'],
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
      id: 'remix-architecture',
      name: 'Remix Application Architecture',
      description: 'Application layers: Routes -> Loaders/Actions -> Services -> Data',
      analyzer_id: this.analyzerId,
      type: 'structure',
      connection_rules: {
        visible_node_types: ['route', 'page', 'layout', 'component', 'function', 'class', 'module', 'file'],
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

      const isRoute = node.type === 'route' || node.type === 'page' || node.type === 'endpoint';
      const isLayout = node.type === 'layout';

      if (isRoute || isLayout) {
        node.perspectives['remix-routes'] = {
          hierarchy: ['routing', node.type, node.name],
          level: node.level || 2,
          priority: isRoute ? 90 : 70
        };
      }

      if (node.type !== 'import') {
        node.perspectives['remix-architecture'] = {
          hierarchy: ['architecture', node.category || node.type, node.name],
          level: node.level || 2,
          priority: isRoute ? 80 : 50
        };
      }
    }

    for (const edge of edges) {
      edge.perspectives = [];
      if (edge.type === 'contains' || edge.type === 'renders' || edge.type === 'calls') {
        edge.perspectives.push('remix-routes');
      }
      if (edge.type === 'imports' || edge.type === 'contains') {
        edge.perspectives.push('remix-architecture');
      }
    }
  }
}
