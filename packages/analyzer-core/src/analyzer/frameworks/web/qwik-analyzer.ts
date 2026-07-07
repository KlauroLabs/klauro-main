import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint,
  CASPerspective, FileAnalysisResult
} from '../../../types/cas.types';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';

// Qwik City routes live as index.tsx files inside src/routes folders; layout.tsx are layouts.
const ROUTE_GLOBS = ['src/routes/**/*.{tsx,jsx,ts,js}'];
// Reusable components live outside src/routes (commonly src/components); we scan
// them too so the component tree (parent renders child) spans the whole app.
const COMPONENT_GLOBS = ['src/components/**/*.{tsx,jsx}', 'src/**/*.{tsx,jsx}'];

const ENDPOINT_HANDLERS: Array<{ name: string; method: string }> = [
  { name: 'onRequest', method: 'ALL' },
  { name: 'onGet', method: 'GET' },
  { name: 'onPost', method: 'POST' },
  { name: 'onPut', method: 'PUT' },
  { name: 'onDelete', method: 'DELETE' },
  { name: 'onPatch', method: 'PATCH' },
  { name: 'onHead', method: 'HEAD' },
  { name: 'onOptions', method: 'OPTIONS' }
];

interface QwikRouteInfo {
  relativePath: string;
  routePath: string;
  isIndex: boolean;
  isLayout: boolean;
  loaders: string[];
  actions: string[];
  serverFns: string[];
  endpoints: Array<{ name: string; method: string }>;
  components: string[];
}

interface QwikFileExtraction {
  route?: QwikRouteInfo;
  components: string[];
}

export class QwikAnalyzer extends BaseAnalyzer {
  constructor() {
    super('qwik', 'Qwik Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const packageJsonPath = path.join(projectPath, 'package.json');
      if (await fs.pathExists(packageJsonPath)) {
        const packageJson = await fs.readJson(packageJsonPath);
        const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
        if (deps['@builder.io/qwik'] || deps['@builder.io/qwik-city']) return true;
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
    const files = await glob(ROUTE_GLOBS, {
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
    this.emitFromExtraction(extraction, file, nodes, edges, entryPoints);

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

    const routeFiles = await glob([...ROUTE_GLOBS, ...COMPONENT_GLOBS], {
      cwd: context.projectPath,
      ignore: [
        ...this.getIgnorePatterns(context),
        '**/*.test.*', '**/*.spec.*', '**/__tests__/**'
      ],
      nodir: true
    });

    // Collect each component's child JSX tags so a post-pass can resolve them to
    // the component that defines them and emit the parent->child `renders` edges.
    const renderSites: Array<{ owner: string; ownerFile: string; children: string[] }> = [];

    for (const file of [...new Set(routeFiles)]) {
      const fullPath = path.join(context.projectPath, file);
      let content: string;
      try {
        content = await fs.readFile(fullPath, 'utf-8');
      } catch {
        continue;
      }
      const extraction = this.extractFromFile(file, content);
      this.emitFromExtraction(extraction, file, nodes, edges, entryPoints);
      const children = this.extractChildComponentTags(content);
      for (const owner of extraction.components) {
        renderSites.push({ owner, ownerFile: file, children });
      }
    }

    this.emitRendersEdges(renderSites, nodes, edges);

    const perspectives: CASPerspective[] = [];
    this.createPerspectives(perspectives);
    this.tagNodesWithPerspectives(nodes, edges);

    const contribution = this.createContribution(nodes, edges, entryPoints, exitPoints, {
      framework_specific: {
        routes_detected: nodes.filter(n => n.type === 'route' || n.type === 'page').length,
        layouts_detected: nodes.filter(n => n.type === 'layout').length,
        loaders_detected: entryPoints.filter(ep => ep.metadata?.kind === 'loader').length,
        actions_detected: entryPoints.filter(ep => ep.metadata?.kind === 'action').length,
        endpoints_detected: entryPoints.filter(ep => ep.metadata?.kind === 'endpoint').length,
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
  private extractFromFile(file: string, content: string): QwikFileExtraction {
    const normalized = file.replace(/\\/g, '/');
    const components = this.findComponents(content);

    const basename = path.basename(normalized);
    const isIndex = /^index\.(tsx|jsx|ts|js)$/.test(basename);
    const isLayout = /^layout(-[\w-]+)?\.(tsx|jsx|ts|js)$/.test(basename);

    if (isIndex || isLayout) {
      const route = this.parseRouteModule(normalized, content, isIndex, isLayout, components);
      return { route, components };
    }

    return { components };
  }

  private emitFromExtraction(
    extraction: QwikFileExtraction,
    file: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): void {
    let routeNodeId: string | undefined;
    if (extraction.route) {
      routeNodeId = this.emitRouteNodes(extraction.route, file, nodes, entryPoints);
    }
    // Components -> component nodes, linked to the route they live in.
    for (const name of extraction.components) {
      this.emitComponentNode(name, file, nodes, edges, routeNodeId);
    }
  }

  private parseRouteModule(
    file: string,
    content: string,
    isIndex: boolean,
    isLayout: boolean,
    components: string[]
  ): QwikRouteInfo {
    const routePath = this.deriveRouteFromFile(file);

    const loaders = this.findAssignedCalls(content, 'routeLoader$');
    const actions = this.findAssignedCalls(content, 'routeAction$');
    const serverFns = this.findAssignedCalls(content, 'server$');

    const endpoints: Array<{ name: string; method: string }> = [];
    for (const handler of ENDPOINT_HANDLERS) {
      const re = new RegExp(`export\\s+(?:const|async\\s+function|function)\\s+${handler.name}\\b`);
      if (re.test(content)) {
        endpoints.push(handler);
      }
    }

    return {
      relativePath: file,
      routePath,
      isIndex,
      isLayout,
      loaders,
      actions,
      serverFns,
      endpoints,
      components
    };
  }

  private emitRouteNodes(
    info: QwikRouteInfo,
    file: string,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[]
  ): string {
    const nodeId = `qwik_route_${this.sanitizeId(file)}`;
    const nodeType = info.isLayout ? 'layout' : 'route';
    const label = info.isLayout ? `Layout ${info.routePath}` : `Route ${info.routePath}`;

    nodes.push(this.createNode(nodeId, label, nodeType, 3, file, undefined, undefined, {
      framework: 'qwik',
      attributes: {
        routePath: info.routePath,
        isIndex: info.isIndex,
        isLayout: info.isLayout,
        hasLoader: info.loaders.length > 0,
        hasAction: info.actions.length > 0,
        hasServerFn: info.serverFns.length > 0,
        endpointMethods: info.endpoints.map(e => e.method)
      }
    }));

    // Route component itself is a page entry point (GET render). Layouts don't render a page.
    if (!info.isLayout) {
      const pageEntryId = `entry_qwik_page_${this.sanitizeId(file)}`;
      entryPoints.push({
        id: pageEntryId,
        source_node: nodeId,
        source_analyzer: this.analyzerId,
        type: 'page',
        name: `PAGE ${info.routePath}`,
        trigger: { method: 'GET', path: info.routePath },
        metadata: { framework: 'qwik', kind: 'page', routeFile: file }
      });
    }

    // routeLoader$ -> data entry points.
    for (const loader of info.loaders) {
      const entryId = `entry_qwik_loader_${this.sanitizeId(file)}_${loader}`;
      entryPoints.push({
        id: entryId,
        source_node: nodeId,
        source_analyzer: this.analyzerId,
        type: 'http',
        name: `LOADER ${info.routePath}`,
        trigger: { method: 'GET', path: info.routePath },
        handler: { node_id: nodeId, method_name: loader, file },
        metadata: { framework: 'qwik', kind: 'loader', export: loader, routeFile: file }
      });
    }

    // routeAction$ -> mutation entry points.
    for (const action of info.actions) {
      const entryId = `entry_qwik_action_${this.sanitizeId(file)}_${action}`;
      entryPoints.push({
        id: entryId,
        source_node: nodeId,
        source_analyzer: this.analyzerId,
        type: 'http',
        name: `ACTION ${info.routePath}`,
        trigger: { method: 'POST', path: info.routePath },
        handler: { node_id: nodeId, method_name: action, file },
        metadata: { framework: 'qwik', kind: 'action', export: action, routeFile: file }
      });
    }

    // server$ -> server function entry points.
    for (const fn of info.serverFns) {
      const entryId = `entry_qwik_server_${this.sanitizeId(file)}_${fn}`;
      entryPoints.push({
        id: entryId,
        source_node: nodeId,
        source_analyzer: this.analyzerId,
        type: 'http',
        name: `SERVER-FN ${info.routePath}`,
        trigger: { method: 'POST', path: info.routePath },
        handler: { node_id: nodeId, method_name: fn, file },
        metadata: { framework: 'qwik', kind: 'server-fn', export: fn, routeFile: file }
      });
    }

    // onRequest/onGet/onPost/... -> endpoint entry points.
    for (const endpoint of info.endpoints) {
      const entryId = `entry_qwik_endpoint_${this.sanitizeId(file)}_${endpoint.name}`;
      entryPoints.push({
        id: entryId,
        source_node: nodeId,
        source_analyzer: this.analyzerId,
        type: 'http',
        name: `${endpoint.method} ${info.routePath}`,
        trigger: { method: endpoint.method, path: info.routePath },
        handler: { node_id: nodeId, method_name: endpoint.name, file },
        metadata: { framework: 'qwik', kind: 'endpoint', export: endpoint.name, routeFile: file }
      });
    }

    return nodeId;
  }

  private emitComponentNode(
    name: string,
    file: string,
    nodes: CASNode[],
    edges: CASEdge[],
    routeNodeId?: string
  ): void {
    const nodeId = `qwik_component_${this.sanitizeId(file)}_${name}`;
    if (nodes.some(n => n.id === nodeId)) return;

    nodes.push(this.createNode(nodeId, name, 'component', 3, file, undefined, undefined, {
      framework: 'qwik',
      attributes: { tag: 'qwik-component' }
    }));

    if (routeNodeId) {
      const edgeId = this.generateEdgeId(routeNodeId, nodeId, 'contains');
      edges.push(this.createEdge(edgeId, routeNodeId, nodeId, 'contains', 'route-component', {
        framework: 'qwik'
      }));
    }
  }

  /**
   * PascalCase JSX tags rendered inside a component are its child components
   * (the Camp-C component-tree fact). We exclude lowercase host elements.
   */
  private extractChildComponentTags(content: string): string[] {
    const tags = new Set<string>();
    const re = /<([A-Z][A-Za-z0-9]*)\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) tags.add(m[1]);
    return [...tags];
  }

  /**
   * Resolve each component's child tags to the component that defines them and
   * emit a `renders` edge — structural indexers see the import, not the render.
   */
  private emitRendersEdges(
    renderSites: Array<{ owner: string; ownerFile: string; children: string[] }>,
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    const idByName = new Map<string, string>();
    for (const node of nodes) {
      if (node.type === 'component') idByName.set(node.name, node.id);
    }
    for (const site of renderSites) {
      const parentId = `qwik_component_${this.sanitizeId(site.ownerFile)}_${site.owner}`;
      for (const child of site.children) {
        const childId = idByName.get(child);
        if (!childId || childId === parentId) continue;
        const edgeId = this.generateEdgeId(parentId, childId, 'renders');
        if (edges.some(e => e.id === edgeId)) continue;
        edges.push(this.createEdge(edgeId, parentId, childId, 'renders', 'component-tree', {
          framework: 'qwik'
        }));
      }
    }
  }

  /**
   * Find `export const Foo = component$(...)` and bare `component$(...)` default exports.
   */
  private findComponents(content: string): string[] {
    const names: string[] = [];

    // Allow an optional generic on component$ — `component$<Props>(...)` is the
    // typed idiom and must still be recognised as a component definition.
    const namedPattern = /(?:export\s+)?const\s+(\w+)\s*=\s*component\$\s*(?:<[^>]*>)?\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = namedPattern.exec(content)) !== null) {
      names.push(match[1]);
    }

    // export default component$(...) with no binding.
    if (/export\s+default\s+component\$\s*(?:<[^>]*>)?\s*\(/.test(content) && names.length === 0) {
      names.push('default');
    }

    return Array.from(new Set(names));
  }

  /**
   * Find `export const foo = routeLoader$(...)` style bindings for a given primitive.
   */
  private findAssignedCalls(content: string, primitive: string): string[] {
    const names: string[] = [];
    const escaped = primitive.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?:export\\s+)?const\\s+(\\w+)\\s*=\\s*${escaped}\\s*\\(`, 'g');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      names.push(match[1]);
    }
    return Array.from(new Set(names));
  }

  /**
   * Map a Qwik City route file path to its URL path. The folder structure under
   * src/routes is the route; the index.tsx/layout.tsx basename is dropped.
   * Conventions: [param] dynamic, [...slug] splat, (group) pathless groups.
   */
  private deriveRouteFromFile(file: string): string {
    let rel = file.replace(/\\/g, '/').replace(/^.*?src\/routes\//, '');
    // Drop the index/layout basename; the folder path is the route.
    rel = rel.replace(/\/?(index|layout(?:-[\w-]+)?)\.(tsx|jsx|ts|js)$/, '');

    const segments = rel.split('/').filter(s => s.length > 0);
    const pathParts: string[] = [];

    for (const seg of segments) {
      // Pathless group: (auth) etc.
      if (/^\(.+\)$/.test(seg)) {
        continue;
      }
      // Splat: [...slug] -> *
      if (/^\[\.\.\..+\]$/.test(seg)) {
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
    return routePath;
  }

  protected getCapabilities(): string[] {
    return [
      'qwik-routes',
      'qwik-loaders',
      'qwik-actions',
      'qwik-components'
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
      id: 'qwik-routes',
      name: 'Qwik City Routing',
      description: 'Folder-based routes, loaders, actions, and endpoint handlers showing request and data flow',
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
            to_types: ['component'],
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
      id: 'qwik-architecture',
      name: 'Qwik Application Architecture',
      description: 'Application layers: Routes -> Loaders/Actions -> Components -> Data',
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
        node.perspectives['qwik-routes'] = {
          hierarchy: ['routing', node.type, node.name],
          level: node.level || 2,
          priority: isRoute ? 90 : 70
        };
      }

      if (node.type !== 'import') {
        node.perspectives['qwik-architecture'] = {
          hierarchy: ['architecture', node.category || node.type, node.name],
          level: node.level || 2,
          priority: isRoute ? 80 : 50
        };
      }
    }

    for (const edge of edges) {
      edge.perspectives = [];
      if (edge.type === 'contains' || edge.type === 'renders' || edge.type === 'calls') {
        edge.perspectives.push('qwik-routes');
      }
      if (edge.type === 'imports' || edge.type === 'contains') {
        edge.perspectives.push('qwik-architecture');
      }
    }
  }
}
