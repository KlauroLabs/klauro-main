import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, CASPerspective
} from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import { classifyGuardKind, isAuthenticationGuardName } from '../../core/guard-classification';
import {
  GoRoute, describeGoHandler, isGoMiddlewareIdentifier, parseGoCallArgs,
  joinGoPaths, findGoFiles, readGoFiles, goModRequires, lineForIndex
} from './go-route-utils';
import * as path from 'path';

const ECHO_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE', 'Any'];

/**
 * Echo framework analyzer (github.com/labstack/echo).
 *
 * Extracts `e.GET("/path", handler)` / `g := e.Group("/prefix")` route
 * registrations, mirroring the Gin analyzer's group-nesting resolution
 * (Echo's Group() API is structurally identical to Gin's — a `*echo.Group`
 * bound to a var whose own method calls are scoped to that prefix). `g.Use(...)`
 * calls register middleware guards that apply to every route registered
 * directly on that group.
 */
export class EchoAnalyzer extends BaseAnalyzer {
  constructor() {
    super('echo', 'Echo Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      if (!(await goModRequires(projectPath, 'github.com/labstack/echo'))) return false;
      const files = await findGoFiles(projectPath);
      const contents = await readGoFiles(projectPath, files);
      for (const content of contents.values()) {
        if (this.looksLikeEchoUsage(content)) return true;
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
    const perspectives: CASPerspective[] = [];

    try {
      const files = await findGoFiles(context.projectPath);
      const fileContents = await readGoFiles(context.projectPath, files);

      const allRoutes: GoRoute[] = [];
      for (const [file, content] of fileContents) {
        if (!this.looksLikeEchoUsage(content)) continue;
        allRoutes.push(...this.extractRoutes(content, file));
      }

      if (allRoutes.length === 0) {
        return this.createContribution(nodes, edges, entryPoints, exitPoints, {
          framework: 'echo',
          routesFound: 0
        });
      }

      const appId = 'app_echo';
      const appNode = this.createNodeBuilder(appId, 'Echo Application', 'application')
        .withLevel(1, 'system')
        .withCategory('application', ['framework', 'echo'])
        .withSource({ file: files[0] || '', line: 1, end_line: 1 })
        .withDescription('Echo HTTP application')
        .withMetadata({ framework: 'echo', attributes: { routes: allRoutes.length } })
        .build();
      nodes.push(appNode);

      allRoutes.forEach((route, index) => {
        const routeId = `route_echo_${this.sanitizeId(route.method)}_${this.sanitizeId(route.path)}_${index}`;

        const routeNode = this.createNodeBuilder(routeId, `${route.method.toUpperCase()} ${route.path}`, 'route')
          .withLevel(3, 'code')
          .withCategory('route', ['http', 'endpoint'])
          .withSource({ file: route.file, line: route.line, end_line: route.line })
          .withDescription(`Echo HTTP endpoint: ${route.method.toUpperCase()} ${route.path}`)
          .withMetadata({
            framework: 'echo',
            attributes: { method: route.method, path: route.path, handler: route.handler, guards: route.guards }
          })
          .build();
        nodes.push(routeNode);

        edges.push(this.createEdge(`${appId}_exposes_${routeId}`, appId, routeId, 'exposes'));

        const authGuards = route.guards.filter(g => isAuthenticationGuardName(g) || classifyGuardKind(g) === 'authorization');

        entryPoints.push(this.createEntryPoint(
          `entry_${routeId}`,
          routeId,
          'http',
          `${route.method.toUpperCase()} ${route.path}`,
          `Echo HTTP endpoint: ${route.method.toUpperCase()} ${route.path}`,
          { method: route.method.toUpperCase(), path: route.path },
          { authenticated: authGuards.length > 0, guards: route.guards, authorized_roles: [] },
          {
            method: route.method.toUpperCase(),
            path: route.path,
            handler: route.handler,
            handler_file: route.file,
            guards: route.guards,
            framework: 'echo'
          },
          { node_id: routeId, method_name: route.handler, file: route.file, line: route.line }
        ));
      });

      this.createPerspectives(perspectives);
      this.tagNodesWithPerspectives(nodes);

      const contribution = this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework: 'echo',
        routesFound: allRoutes.length
      });
      contribution.perspectives = perspectives;
      contribution.provided_perspectives = perspectives.map(p => p.id);
      return contribution;
    } catch (error) {
      throw new AnalyzerError(`Echo analysis failed: ${(error as Error).message}`, 'ECHO_ANALYSIS_ERROR');
    }
  }

  private looksLikeEchoUsage(content: string): boolean {
    const importsEcho = /"github\.com\/labstack\/echo(\/v4)?"/.test(content);
    const constructsInstance = /echo\.New\s*\(\s*\)/.test(content);
    const hasRouteCall = /\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT|TRACE|Any)\s*\(\s*(['"`])/.test(content);
    return importsEcho && (constructsInstance || hasRouteCall);
  }

  private extractRoutes(content: string, file: string): GoRoute[] {
    const routes: GoRoute[] = [];
    const receivers = this.findEchoReceiverNames(content);
    for (const receiver of receivers) {
      this.walkScope(content, file, receiver, '', [], routes, new Set());
    }
    return routes;
  }

  /** Local var names bound to `echo.New()`, plus the conventional `e`/`echo` names
   *  used even when the binding isn't found in this file (helper functions taking
   *  `*echo.Echo`/`*echo.Group` as a parameter). */
  private findEchoReceiverNames(content: string): string[] {
    const names = new Set<string>(['e']);
    const instancePattern = /(?:const|var)?\s*([A-Za-z_][\w]*)\s*:?=\s*echo\.New\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = instancePattern.exec(content)) !== null) names.add(m[1]);
    return [...names];
  }

  private walkScope(
    content: string,
    file: string,
    receiver: string,
    prefix: string,
    guards: string[],
    routes: GoRoute[],
    visitedGroupStarts: Set<number>
  ): void {
    const escaped = receiver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // g.Use(mw1, mw2) — applies to every route registered directly on this receiver.
    const usePattern = new RegExp(`\\b${escaped}\\.Use\\s*\\(`, 'g');
    const groupGuards: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = usePattern.exec(content)) !== null) {
      const args = parseGoCallArgs(content, usePattern.lastIndex);
      groupGuards.push(...args.filter(a => isGoMiddlewareIdentifier(a)));
    }

    // Route calls: receiver.GET("/path", handler[, middleware...])
    const methodAlt = ECHO_METHODS.join('|');
    const routeCallPattern = new RegExp(`\\b${escaped}\\.(${methodAlt})\\s*\\(\\s*(['"\`])([^'"\`]*)\\2`, 'g');
    while ((match = routeCallPattern.exec(content)) !== null) {
      const method = match[1];
      const routePath = joinGoPaths(prefix, match[3]);
      const line = lineForIndex(content, match.index);
      const args = parseGoCallArgs(content, routeCallPattern.lastIndex);
      const handlerArg = args[0] || 'anonymous';
      const handler = describeGoHandler(handlerArg);
      // Echo signature is (path, handler, middleware...) — middleware trail after handler.
      const inlineGuards = args.slice(1).filter(a => isGoMiddlewareIdentifier(a));
      routes.push({
        method: method === 'Any' ? 'ANY' : method,
        path: routePath || '/',
        handler,
        guards: [...guards, ...groupGuards, ...inlineGuards],
        file,
        line
      });
    }

    // Group calls: newVar := receiver.Group("/prefix"[, mw...])
    const groupPattern = new RegExp(`(?:([A-Za-z_][\\w]*)\\s*:?=\\s*)?\\b${escaped}\\.Group\\s*\\(\\s*(['"\`])([^'"\`]*)\\2`, 'g');
    while ((match = groupPattern.exec(content)) !== null) {
      if (visitedGroupStarts.has(match.index)) continue;
      visitedGroupStarts.add(match.index);
      const groupVar = match[1];
      const groupPrefix = joinGoPaths(prefix, match[3]);
      const args = parseGoCallArgs(content, groupPattern.lastIndex);
      const groupCallGuards = args.slice(1).filter(a => isGoMiddlewareIdentifier(a));
      const combinedGuards = [...guards, ...groupGuards, ...groupCallGuards];

      if (groupVar) {
        this.walkScope(content, file, groupVar, groupPrefix, combinedGuards, routes, visitedGroupStarts);
      } else {
        this.extractChainedCalls(content, groupPattern.lastIndex, file, groupPrefix, combinedGuards, routes);
      }
    }
  }

  /** Extract `.METHOD("/path", handler)` calls chained directly off an anonymous
   *  `Group()` return, scanning forward for immediate `.METHOD(` chains. */
  private extractChainedCalls(
    content: string,
    fromIndex: number,
    file: string,
    prefix: string,
    guards: string[],
    routes: GoRoute[]
  ): void {
    const methodAlt = ECHO_METHODS.join('|');
    const chainPattern = new RegExp(`^\\s*\\.(${methodAlt})\\s*\\(\\s*(['"\`])([^'"\`]*)\\2`, 'g');
    let cursor = fromIndex;
    while (true) {
      const remainder = content.slice(cursor, cursor + 500);
      chainPattern.lastIndex = 0;
      const m = chainPattern.exec(remainder);
      if (!m) break;
      const method = m[1];
      const routePath = joinGoPaths(prefix, m[3]);
      const absoluteIndex = cursor + m.index;
      const line = lineForIndex(content, absoluteIndex);
      const argsStart = cursor + chainPattern.lastIndex;
      const args = parseGoCallArgs(content, argsStart);
      const handlerArg = args[0] || 'anonymous';
      const handler = describeGoHandler(handlerArg);
      const inlineGuards = args.slice(1).filter(a => isGoMiddlewareIdentifier(a));
      routes.push({
        method: method === 'Any' ? 'ANY' : method,
        path: routePath || '/',
        handler,
        guards: [...guards, ...inlineGuards],
        file,
        line
      });
      const parenOpen = content.indexOf('(', absoluteIndex);
      const span = parenOpen !== -1 ? this.balancedParenSpan(content, parenOpen) : null;
      cursor = span ? span[1] + 1 : cursor + m[0].length;
    }
  }

  private balancedParenSpan(content: string, openIndex: number): [number, number] | null {
    let depth = 0;
    let inStr: string | null = null;
    for (let i = openIndex; i < content.length; i++) {
      const ch = content[i];
      if (inStr) {
        if (ch === inStr && content[i - 1] !== '\\') inStr = null;
        continue;
      }
      if (ch === '"' || ch === '`' || ch === "'") { inStr = ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) return [openIndex, i]; }
    }
    return null;
  }

  private createPerspectives(perspectives: CASPerspective[]): void {
    perspectives.push({
      id: 'echo-routes',
      name: 'Echo API Routes',
      description: 'Echo HTTP routes registered via instance/group method calls',
      analyzer_id: this.analyzerId,
      type: 'flow',
      connection_rules: {
        visible_node_types: ['application', 'route'],
        relevant_edge_types: ['exposes'],
        node_connections: [
          { from_type: 'application', to_types: ['route'], edge_type: 'exposes' }
        ]
      },
      layout_hints: { style: 'hierarchical', direction: 'TB', group_by: 'http_method' },
      metadata: { show_http_methods: true }
    });
  }

  private tagNodesWithPerspectives(nodes: CASNode[]): void {
    nodes.forEach(node => {
      if (!node || typeof node !== 'object') return;
      if (!node.perspectives) node.perspectives = {};
      if (node.type === 'application' || node.type === 'route') {
        node.perspectives['echo-routes'] = { hierarchy: ['echo', 'routes'], level: node.level || 1, priority: 1 };
      }
    });
  }

  protected getCapabilities(): string[] {
    return ['echo-analysis', 'route-extraction', 'group-prefix-resolution', 'route-mapping'];
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
}
