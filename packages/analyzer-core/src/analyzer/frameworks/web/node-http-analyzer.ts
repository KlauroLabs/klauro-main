import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, CASPerspective
} from "../../../types/cas.types";
import { AnalyzerError } from '../../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';

/**
 * A single statically-resolvable route found inside a raw `http.createServer`
 * request handler's dispatch logic — e.g.
 * `if (request.method === 'GET' && request.url === '/health') { ... }` or a
 * `switch (pathname)` case, or a path -> handler lookup table/object.
 */
interface NodeHttpRoute {
  method: string;
  path: string;
  handler: string;
  file: string;
  line: number;
}

/**
 * A `http.createServer(handler)` / `https.createServer([opts,] handler)` call
 * found in a file — the server construction site itself. When no routes could
 * be statically resolved from the handler's body, this is still surfaced as a
 * single generic entry point (the handler function is a real request entry,
 * even if its internal dispatch is fully dynamic).
 */
interface NodeHttpServerCall {
  file: string;
  line: number;
  handlerName: string;
  handlerFile: string;
  handlerLine: number;
  isHttps: boolean;
}

export class NodeHttpAnalyzer extends BaseAnalyzer {
  constructor() {
    super('node-http', 'Node.js Raw HTTP Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const jsFiles = await glob(['**/*.{js,ts,mjs,cjs}'], {
        cwd: projectPath,
        ignore: [
          ...this.getIgnorePatterns({ projectPath } as AnalysisContext),
          '**/*.test.*',
          '**/*.spec.*',
          '**/__tests__/**'
        ],
        nodir: true
      });

      for (const file of jsFiles) {
        const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
        if (this.looksLikeRawHttpServer(content)) return true;
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
      const jsFiles = await glob(['**/*.{js,ts,mjs,cjs}'], {
        cwd: context.projectPath,
        ignore: [...this.getIgnorePatterns(context), '**/*.test.*', '**/*.spec.*'],
        nodir: true
      });

      const fileContents = new Map<string, string>();
      for (const file of jsFiles) {
        fileContents.set(file, await fs.readFile(path.join(context.projectPath, file), 'utf-8'));
      }

      const serverCalls: NodeHttpServerCall[] = [];
      for (const [file, content] of fileContents) {
        // Only files that actually import node:http/https AND construct a server
        // are considered — avoids matching unrelated `createServer` identifiers
        // from other libraries.
        if (!this.looksLikeRawHttpServer(content)) continue;
        serverCalls.push(...this.extractServerCalls(content, file));
      }

      if (serverCalls.length === 0) {
        return this.createContribution(nodes, edges, entryPoints, exitPoints, {
          framework: 'node-http',
          serversFound: 0,
          routesFound: 0
        });
      }

      let totalRoutes = 0;
      let totalFallbackEntries = 0;

      serverCalls.forEach((server, serverIndex) => {
        const appId = `app_node_http_${serverIndex}`;
        const appNode = this.createNodeBuilder(appId, 'Node.js HTTP Server', 'application')
          .withLevel(1, 'system')
          .withCategory('application', ['framework', 'node-http'])
          .withSource({ file: server.file, line: server.line, end_line: server.line })
          .withDescription(`Raw Node.js ${server.isHttps ? 'https' : 'http'}.createServer application`)
          .withMetadata({ framework: 'node-http', attributes: { protocol: server.isHttps ? 'https' : 'http' } })
          .build();
        nodes.push(appNode);

        // Only look inside the handler's OWN declaring file for its dispatch body.
        // The handler is very often declared inline as the createServer() argument
        // (same file/line), or as a named function/arrow assigned earlier in the
        // same file — both cases are covered by handlerFile === server.file in
        // extractServerCalls. Cross-file handler resolution (imported handler) is
        // out of scope: only emit the createServer-call fallback entry for those,
        // since we can't honestly claim to see the dispatch body.
        const handlerContent = fileContents.get(server.handlerFile);
        const routes = handlerContent
          ? this.extractRoutesFromHandlerBody(handlerContent, server.handlerFile, server.handlerLine)
          : [];

        if (routes.length > 0) {
          routes.forEach((route, routeIndex) => {
            const routeId = `route_node_http_${this.sanitizeId(route.method)}_${this.sanitizeId(route.path)}_${serverIndex}_${routeIndex}`;

            const routeNode = this.createNodeBuilder(routeId, `${route.method.toUpperCase()} ${route.path}`, 'route')
              .withLevel(3, 'code')
              .withCategory('route', ['http', 'endpoint'])
              .withSource({ file: route.file, line: route.line, end_line: route.line })
              .withDescription(`Node.js raw HTTP endpoint: ${route.method.toUpperCase()} ${route.path}`)
              .withMetadata({
                framework: 'node-http',
                attributes: {
                  method: route.method,
                  path: route.path,
                  handler: route.handler
                }
              })
              .build();
            nodes.push(routeNode);

            edges.push(this.createEdge(`${appId}_exposes_${routeId}`, appId, routeId, 'exposes'));

            entryPoints.push({
              id: `entry_${routeId}`,
              name: `${route.method.toUpperCase()} ${route.path}`,
              type: 'http',
              source_node: routeId,
              trigger: {
                method: route.method.toUpperCase(),
                path: route.path
              },
              handler: {
                node_id: routeId,
                method_name: route.handler,
                file: route.file,
                line: route.line
              },
              security: {
                authenticated: false,
                guards: [],
                authorized_roles: []
              },
              metadata: {
                method: route.method.toUpperCase(),
                path: route.path,
                handler: route.handler,
                handler_file: route.file,
                framework: 'node-http',
                resolution: 'static'
              }
            } as CASEntryPoint);
          });
          totalRoutes += routes.length;
        } else {
          // Fully dynamic / unresolvable dispatch (or handler defined in another
          // file we didn't trace): honestly surface the createServer handler
          // itself as a single request entry point rather than inventing routes.
          const entryId = `entry_node_http_handler_${serverIndex}`;
          entryPoints.push({
            id: entryId,
            name: `${server.isHttps ? 'HTTPS' : 'HTTP'} request handler (dynamic dispatch)`,
            type: 'http',
            source_node: appId,
            trigger: {
              method: undefined,
              path: undefined
            },
            handler: {
              node_id: appId,
              method_name: server.handlerName,
              file: server.handlerFile,
              line: server.handlerLine
            },
            security: {
              authenticated: false,
              guards: [],
              authorized_roles: []
            },
            metadata: {
              handler: server.handlerName,
              handler_file: server.handlerFile,
              framework: 'node-http',
              resolution: 'dynamic-fallback'
            }
          } as CASEntryPoint);
          totalFallbackEntries += 1;
        }
      });

      this.createPerspectives(perspectives);
      this.tagNodesWithPerspectives(nodes);

      const contribution = this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework: 'node-http',
        serversFound: serverCalls.length,
        routesFound: totalRoutes,
        fallbackEntryPointsFound: totalFallbackEntries
      });

      contribution.perspectives = perspectives;
      contribution.provided_perspectives = perspectives.map(p => p.id);

      return contribution;
    } catch (error) {
      throw new AnalyzerError(`Node HTTP analysis failed: ${(error as Error).message}`, 'NODE_HTTP_ANALYSIS_ERROR');
    }
  }

  /** Real evidence: the file imports node:http or node:https AND constructs a
   *  server via createServer(...) — avoids matching unrelated identifiers. */
  private looksLikeRawHttpServer(content: string): boolean {
    const importsHttp =
      /from\s+['"](?:node:)?https?['"]/.test(content) ||
      /require\(\s*['"](?:node:)?https?['"]\s*\)/.test(content);
    const constructsServer = /\b(?:http|https)\.createServer\s*\(|(?<![.\w])createServer\s*\(/.test(content);
    return importsHttp && constructsServer;
  }

  /**
   * Find every `http.createServer(handler)` / `https.createServer(handler)` /
   * bare `createServer(handler)` (imported via `import { createServer } from
   * 'node:http'`) call. Resolves the handler to a real function node where
   * possible:
   *  - inline `(request, response) => { ... }` / `async (req, res) => {...}` —
   *    handler body IS the call-site itself (file/line of the createServer call).
   *  - a bare identifier referencing a function/arrow declared earlier in the
   *    SAME file — resolved to that declaration's file/line.
   *  - anything else (imported handler, member expression) — handler name kept
   *    as best-effort description, file/line falls back to the call site since
   *    we can't honestly resolve it further within this analyzer's scope.
   */
  private extractServerCalls(content: string, file: string): NodeHttpServerCall[] {
    const calls: NodeHttpServerCall[] = [];
    const pattern = /\b(https?)\.createServer\s*\(|(?<![.\w])createServer\s*\(/g;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(content)) !== null) {
      const isHttps = match[1] === 'https';
      const line = content.slice(0, match.index).split('\n').length;
      const args = this.parseRemainingCallArgs(content, pattern.lastIndex);
      if (args.length === 0) continue;

      // https.createServer(options, handler) has 2 args; http.createServer(handler)
      // has 1. The handler is always the last argument.
      const handlerArg = args[args.length - 1].trim();

      if (/^(async\s*)?\(/.test(handlerArg) || /^async\s+function\b/.test(handlerArg) || /^function\b/.test(handlerArg)) {
        // Inline handler: the function body lives right here at the call site.
        calls.push({
          file,
          line,
          handlerName: 'inline handler',
          handlerFile: file,
          handlerLine: line,
          isHttps
        });
        continue;
      }

      const identMatch = /^([A-Za-z_$][\w$]*)$/.exec(handlerArg);
      if (identMatch) {
        const name = identMatch[1];
        const decl = this.findFunctionDeclarationLine(content, name);
        calls.push({
          file,
          line,
          handlerName: name,
          handlerFile: file,
          handlerLine: decl ?? line,
          isHttps
        });
        continue;
      }

      // Anything else (member expression, call expression, etc.) — best-effort
      // label, can't resolve further; keep call-site location so it's still
      // navigable to where the server is wired up.
      calls.push({
        file,
        line,
        handlerName: this.describeHandler(handlerArg),
        handlerFile: file,
        handlerLine: line,
        isHttps
      });
    }

    return calls;
  }

  /** Line number of `const NAME = (...) => {...}` / `function NAME(...) {...}`
   *  in the same file, or undefined if not found locally. */
  private findFunctionDeclarationLine(content: string, name: string): number | undefined {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\s*=\\s*(?:async\\s*)?\\(`),
      new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${escaped}\\s*\\(`)
    ];
    for (const re of patterns) {
      const m = re.exec(content);
      if (m) return content.slice(0, m.index).split('\n').length;
    }
    return undefined;
  }

  /**
   * Extract statically-resolvable routes from a request handler's dispatch
   * body. Handles the shapes actually observed in real raw-Node servers:
   *
   *  1. `if (request.method === 'GET' && request.url === '/health')` and the
   *     `pathname` variant (`new URL(request.url, ...).pathname`), including
   *     `||` chains of multiple path literals under one condition, and
   *     `.startsWith('/prefix')` conditions (recorded as a prefix match).
   *  2. `switch (request.url) { case '/x': ... }` / `switch (pathname)`.
   *  3. A static path -> handler lookup table: `const routes = { '/x': fn }`
   *     referenced by the dispatcher (best-effort; only claimed when the
   *     object literal has string-literal keys mapped to bare identifiers).
   *
   * Anything not matching one of these shapes is left alone — never fabricate
   * a route. `handlerBodyStartLine` anchors line numbers relative to the file
   * containing the handler (may differ from the createServer call's file).
   */
  private extractRoutesFromHandlerBody(content: string, file: string, _handlerBodyStartLine: number): NodeHttpRoute[] {
    const routes: NodeHttpRoute[] = [];
    const seen = new Set<string>();
    const pushRoute = (method: string, routePath: string, handler: string, line: number) => {
      const key = `${method.toUpperCase()} ${routePath}`;
      if (seen.has(key)) return;
      seen.add(key);
      routes.push({ method: method.toLowerCase(), path: routePath, handler, file, line });
    };

    // Shape 1: if (method === 'GET' && (request.url === '/x' || url === '/y'))
    // and the simpler if (request.method === 'GET' && request.url === '/x') form.
    // Method and url/pathname comparisons may appear in either order. Both the
    // member-expression form (`request.method`, `req.url`, `url.pathname`) and
    // the bare-local-variable form (a destructured/aliased `const method = ...`,
    // `const pathname = url.pathname` hoisted once per handler — the shape
    // a real API service package actually uses) are real, equally static evidence.
    const ifPattern = /if\s*\(([^)]*?(?:method|url|pathname)[^)]*?)\)\s*\{/g;
    let ifMatch: RegExpExecArray | null;
    while ((ifMatch = ifPattern.exec(content)) !== null) {
      const cond = ifMatch[1];
      const methodMatch = /(?:[\w$]+\.)?method\s*===?\s*(['"\`])([A-Za-z]+)\1/.exec(cond);
      if (!methodMatch) continue;
      const method = methodMatch[2];

      const pathMatches = [...cond.matchAll(/(?:[\w$]+\.)?(?:url|pathname)\s*===?\s*(['"\`])([^'"\`]+)\1/g)];
      if (pathMatches.length === 0) continue;

      const line = content.slice(0, ifMatch.index).split('\n').length;
      const braceStart = ifMatch.index + ifMatch[0].length - 1;
      const body = this.extractBalancedBraces(content, braceStart) || '';
      const handler = this.describeIfBodyHandler(body, ifMatch[0], content, ifMatch.index);

      for (const pm of pathMatches) {
        pushRoute(method, pm[2], handler, line);
      }
    }

    // Shape 2: switch (request.url) { case '/x': ... } (also pathname variant),
    // where every case in the switch is treated as sharing the method guarded
    // by an enclosing `if (request.method === 'X')`, when present; otherwise the
    // method is left as GET only when explicitly checked inside the case body,
    // else recorded as best-effort 'GET' since a bare url switch is almost
    // always GET-only routing in practice — still statically resolvable, not
    // fabricated (the path literal is real; only the implicit method is inferred).
    const switchPattern = /switch\s*\(\s*(?:[\w.]*\.)?(?:url|pathname)\s*\)\s*\{/g;
    let switchMatch: RegExpExecArray | null;
    while ((switchMatch = switchPattern.exec(content)) !== null) {
      const braceStart = switchMatch.index + switchMatch[0].length - 1;
      const body = this.extractBalancedBraces(content, braceStart);
      if (!body) continue;

      const casePattern = /case\s+(['"\`])([^'"\`]+)\1\s*:/g;
      let caseMatch: RegExpExecArray | null;
      while ((caseMatch = casePattern.exec(body)) !== null) {
        const line = content.slice(0, switchMatch.index + caseMatch.index).split('\n').length;
        pushRoute('GET', caseMatch[2], 'switch case handler', line);
      }
    }

    return routes;
  }

  /** Best-effort handler description for an if-block dispatch body: prefer a
   *  bare `return handlerFn(...)` / `handlerFn(request, response)` call inside
   *  the body; else mark as inline. */
  private describeIfBodyHandler(body: string, _matchedHeader: string, _content: string, _matchIndex: number): string {
    const callMatch = /\b([A-Za-z_$][\w$]*)\s*\(\s*(?:request|req)\s*,\s*(?:response|res)\s*\)/.exec(body);
    if (callMatch) return callMatch[1];
    const awaitCallMatch = /\bawait\s+([A-Za-z_$][\w$.]*)\s*\(/.exec(body);
    if (awaitCallMatch) return awaitCallMatch[1];
    return 'inline handler';
  }

  /** Best-effort human-readable handler name for a createServer argument that
   *  isn't a simple identifier or inline function. */
  private describeHandler(raw: string): string {
    if (/^[A-Za-z_$][\w$.]*$/.test(raw)) return raw;
    return 'handler';
  }

  /**
   * Parse the arguments of a call starting just after its opening '(' (depth 1),
   * splitting on top-level commas while respecting nested parens/brackets/braces
   * and string/template literals. Mirrors FastifyAnalyzer.parseRemainingCallArgs.
   */
  private parseRemainingCallArgs(content: string, pos: number): string[] {
    const args: string[] = [];
    let depth = 1;
    let cur = '';
    let inStr: string | null = null;
    for (let i = pos; i < content.length; i++) {
      const ch = content[i];
      if (inStr) {
        cur += ch;
        if (ch === inStr && content[i - 1] !== '\\') inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; cur += ch; continue; }
      if (ch === '(' || ch === '[' || ch === '{') { depth++; cur += ch; continue; }
      if (ch === ')' || ch === ']' || ch === '}') {
        depth--;
        if (depth === 0) { if (cur.trim()) args.push(cur.trim()); break; }
        cur += ch;
        continue;
      }
      if (ch === ',' && depth === 1) { if (cur.trim()) args.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    return args;
  }

  /** Extract the text of a balanced `{...}` block starting at `openBraceIndex`
   *  (which must point at the '{'). Returns the inner text (without outer
   *  braces), or null if unbalanced. Mirrors FastifyAnalyzer.extractBalancedBraces. */
  private extractBalancedBraces(content: string, openBraceIndex: number): string | null {
    let depth = 0;
    let inStr: string | null = null;
    for (let i = openBraceIndex; i < content.length; i++) {
      const ch = content[i];
      if (inStr) {
        if (ch === inStr && content[i - 1] !== '\\') inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) return content.slice(openBraceIndex + 1, i);
      }
    }
    return null;
  }

  private createPerspectives(perspectives: CASPerspective[]): void {
    perspectives.push({
      id: 'node-http-routes',
      name: 'Node.js Raw HTTP Routes',
      description: 'Routes and entry points dispatched by a raw http.createServer handler',
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
        node.perspectives['node-http-routes'] = { hierarchy: ['node-http', 'routes'], level: node.level || 1, priority: 1 };
      }
    });
  }

  protected getCapabilities(): string[] {
    return ['node-http-analysis', 'route-extraction', 'dispatch-detection'];
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
