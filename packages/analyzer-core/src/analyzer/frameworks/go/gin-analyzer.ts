import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, CASPerspective
} from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import { classifyGuardKind, isAuthenticationGuardName } from '../../core/guard-classification';
import {
  GoRoute, describeGoHandler, isGoMiddlewareIdentifier, parseGoCallArgs,
  balancedSpan, joinGoPaths, findGoFiles, readGoFiles, goModRequires, lineForIndex
} from './go-route-utils';
import * as path from 'path';

const GIN_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'Any'];

/**
 * Gin framework analyzer (github.com/gin-gonic/gin).
 *
 * Extracts `r.GET("/path", handler)` / `router.Group("/prefix")` route
 * registrations. Groups nest lexically (a `.Group()` call returns a
 * `*gin.RouterGroup` bound to a local variable whose own `.GET/.POST/...`
 * calls are scoped to that block) — prefixes are resolved by walking each
 * `Group(...)` call's brace-delimited body and recursively descending into
 * nested `Group()` calls, accumulating the prefix chain. `.Use(...)` calls
 * inside a group (or chained off a `Group()` return) register guards/middleware
 * that apply to every route within that scope.
 */
export class GinAnalyzer extends BaseAnalyzer {
  constructor() {
    super('gin', 'Gin Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      if (!(await goModRequires(projectPath, 'github.com/gin-gonic/gin'))) return false;
      const files = await findGoFiles(projectPath);
      const contents = await readGoFiles(projectPath, files);
      for (const content of contents.values()) {
        if (this.looksLikeGinUsage(content)) return true;
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
        if (!this.looksLikeGinUsage(content)) continue;
        allRoutes.push(...this.extractRoutes(content, file));
      }

      if (allRoutes.length === 0) {
        return this.createContribution(nodes, edges, entryPoints, exitPoints, {
          framework: 'gin',
          routesFound: 0
        });
      }

      const appId = 'app_gin';
      const appNode = this.createNodeBuilder(appId, 'Gin Application', 'application')
        .withLevel(1, 'system')
        .withCategory('application', ['framework', 'gin'])
        .withSource({ file: path.join(context.projectPath, files[0] || ''), line: 1, end_line: 1 })
        .withDescription('Gin HTTP application')
        .withMetadata({ framework: 'gin', attributes: { routes: allRoutes.length } })
        .build();
      nodes.push(appNode);

      allRoutes.forEach((route, index) => {
        const routeId = `route_gin_${this.sanitizeId(route.method)}_${this.sanitizeId(route.path)}_${index}`;

        const routeNode = this.createNodeBuilder(routeId, `${route.method.toUpperCase()} ${route.path}`, 'route')
          .withLevel(3, 'code')
          .withCategory('route', ['http', 'endpoint'])
          .withSource({ file: path.join(context.projectPath, route.file), line: route.line, end_line: route.line })
          .withDescription(`Gin HTTP endpoint: ${route.method.toUpperCase()} ${route.path}`)
          .withMetadata({
            framework: 'gin',
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
          `Gin HTTP endpoint: ${route.method.toUpperCase()} ${route.path}`,
          { method: route.method.toUpperCase(), path: route.path },
          { authenticated: authGuards.length > 0, guards: route.guards, authorized_roles: [] },
          {
            method: route.method.toUpperCase(),
            path: route.path,
            handler: route.handler,
            handler_file: route.file,
            guards: route.guards,
            framework: 'gin'
          },
          { node_id: routeId, method_name: route.handler, file: route.file, line: route.line }
        ));
      });

      this.createPerspectives(perspectives);
      this.tagNodesWithPerspectives(nodes);

      const contribution = this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework: 'gin',
        routesFound: allRoutes.length
      });
      contribution.perspectives = perspectives;
      contribution.provided_perspectives = perspectives.map(p => p.id);
      return contribution;
    } catch (error) {
      throw new AnalyzerError(`Gin analysis failed: ${(error as Error).message}`, 'GIN_ANALYSIS_ERROR');
    }
  }

  private looksLikeGinUsage(content: string): boolean {
    const importsGin = /"github\.com\/gin-gonic\/gin"/.test(content);
    const constructsEngine = /gin\.(Default|New)\s*\(\s*\)/.test(content);
    const hasRouteCall = /\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Any)\s*\(\s*(['"`])/.test(content);
    return importsGin && (constructsEngine || hasRouteCall);
  }

  /**
   * Extract all routes in a file, resolving Group() nesting by recursively
   * walking each top-level receiver's (r/router/engine) method calls and any
   * `.Group("/prefix")` call's balanced-brace body (or trailing chained calls),
   * accumulating the prefix and any `.Use(...)` guards registered in scope.
   */
  private extractRoutes(content: string, file: string): GoRoute[] {
    const routes: GoRoute[] = [];
    const receivers = this.findEngineReceiverNames(content);
    for (const receiver of receivers) {
      this.walkScope(content, file, receiver, '', [], routes, new Set());
    }
    return routes;
  }

  /** Local var names bound to `gin.Default()`/`gin.New()`, plus the conventional
   *  `r`/`router`/`engine` names used even when the binding isn't found (covers
   *  helper functions receiving `*gin.Engine`/`*gin.RouterGroup` as a parameter). */
  private findEngineReceiverNames(content: string): string[] {
    const names = new Set<string>(['r', 'router', 'engine']);
    const instancePattern = /(?:const|var)?\s*([A-Za-z_][\w]*)\s*:?=\s*gin\.(?:Default|New)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = instancePattern.exec(content)) !== null) names.add(m[1]);
    return [...names];
  }

  /**
   * Walk every `receiver.METHOD("/path", handler)` and `receiver.Group("/prefix")`
   * call at the top level of `content` (not scoped to a specific brace range —
   * regex-based, so it will also match calls inside nested functions using the
   * same receiver name, which is the common Gin pattern of route-registration
   * helper functions taking `r *gin.RouterGroup`).
   */
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

    // Use() calls that add group-scoped middleware: receiver.Use(mw1, mw2).
    // Computed BEFORE the route loop so `receiver.Use(...)` guards apply to every
    // route registered directly on this same receiver, not just to further-nested
    // Group() descendants.
    const usePattern = new RegExp(`\\b${escaped}\\.Use\\s*\\(`, 'g');
    const groupGuards: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = usePattern.exec(content)) !== null) {
      const args = parseGoCallArgs(content, usePattern.lastIndex);
      groupGuards.push(...args.filter(a => isGoMiddlewareIdentifier(a)));
    }

    // Route calls: receiver.GET("/path", handler) / receiver.Any("/path", handler)
    const methodAlt = GIN_METHODS.join('|');
    const routeCallPattern = new RegExp(`\\b${escaped}\\.(${methodAlt})\\s*\\(\\s*(['"\`])([^'"\`]*)\\2`, 'g');
    while ((match = routeCallPattern.exec(content)) !== null) {
      const method = match[1];
      const routePath = joinGoPaths(prefix, match[3]);
      const line = lineForIndex(content, match.index);
      const args = parseGoCallArgs(content, routeCallPattern.lastIndex);
      const handlerArg = args[args.length - 1] || 'anonymous';
      const handler = describeGoHandler(handlerArg);
      const inlineGuards = args.slice(0, -1).filter(a => isGoMiddlewareIdentifier(a));
      routes.push({
        method: method === 'Any' ? 'ANY' : method,
        path: routePath || '/',
        handler,
        guards: [...guards, ...groupGuards, ...inlineGuards],
        file,
        line
      });
    }

    // Group calls: newVar := receiver.Group("/prefix"[, mw...]) { ... } or chained.
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
        // `v1 := r.Group("/v1")` — descend using the new variable name as receiver,
        // scanning the WHOLE file (Gin group vars are commonly used across a
        // function body, sometimes passed to a sibling route-registration func).
        this.walkScope(content, file, groupVar, groupPrefix, combinedGuards, routes, visitedGroupStarts);
      } else {
        // Anonymous group with no var binding: either chained directly
        // (`r.Group("/v1").GET("/x", h)`) or passed a func literal receiver
        // (`r.Group("/v1", func(rg *gin.RouterGroup) { rg.GET(...) })`). Handle the
        // func-literal case by recursing with that param name as the new receiver
        // over the SAME full content (consistent with the var-binding case above —
        // route calls are still matched by receiver name via regex, not brace scope),
        // then also check for a direct chain in case there's no func literal.
        const braceMatch = /^\s*,?\s*func\s*\(\s*([A-Za-z_][\w]*)/.exec(content.slice(match.index, match.index + 400));
        if (braceMatch) {
          this.walkScope(content, file, braceMatch[1], groupPrefix, combinedGuards, routes, visitedGroupStarts);
        } else {
          this.extractChainedCalls(content, groupPattern.lastIndex, file, groupPrefix, combinedGuards, routes);
        }
      }
    }
  }

  /** Extract `.METHOD("/path", handler)` calls chained directly off an anonymous
   *  `Group()` return (`r.Group("/v1").GET("/x", h)`), scanning forward from the
   *  Group() call for immediate `.METHOD(` chains until a non-chain break. */
  private extractChainedCalls(
    content: string,
    fromIndex: number,
    file: string,
    prefix: string,
    guards: string[],
    routes: GoRoute[]
  ): void {
    const methodAlt = GIN_METHODS.join('|');
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
      const handlerArg = args[args.length - 1] || 'anonymous';
      const handler = describeGoHandler(handlerArg);
      const inlineGuards = args.slice(0, -1).filter(a => isGoMiddlewareIdentifier(a));
      routes.push({
        method: method === 'Any' ? 'ANY' : method,
        path: routePath || '/',
        handler,
        guards: [...guards, ...inlineGuards],
        file,
        line
      });
      // Advance cursor past this call's closing paren.
      const parenOpen = content.indexOf('(', absoluteIndex);
      const span = parenOpen !== -1 ? balancedSpan(content, parenOpen) : null;
      cursor = span ? span[1] + 1 : cursor + m[0].length;
    }
  }

  private createPerspectives(perspectives: CASPerspective[]): void {
    perspectives.push({
      id: 'gin-routes',
      name: 'Gin API Routes',
      description: 'Gin HTTP routes registered via engine/group method calls',
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
        node.perspectives['gin-routes'] = { hierarchy: ['gin', 'routes'], level: node.level || 1, priority: 1 };
      }
    });
  }

  protected getCapabilities(): string[] {
    return ['gin-analysis', 'route-extraction', 'group-prefix-resolution', 'route-mapping'];
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
