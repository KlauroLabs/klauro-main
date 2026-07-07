import { AnalysisContext, BaseAnalyzer } from '../../core/base-analyzer';
import { CASContribution, CASEntryPoint, CASNode, CASEdge } from '../../../types/cas.types';
import { parseWasm } from '../../core/wasm-tree-sitter';
import * as fs from 'fs-extra';
import * as path from 'path';
import { cachedGlob as glob } from '../../core/glob-cache';

/**
 * Reitit + Ring (Clojure) framework analyzer.
 *
 * Reitit declares routes as DATA (a nested vector of `["/path" handler-map]`
 * pairs), unlike Compojure's macro-call routes:
 *
 *   (def routes
 *     ["/api"
 *      ["/users" {:get  {:handler list-users}
 *                 :post {:handler create-user
 *                        :middleware [wrap-auth]}}]
 *      ["/users/:id" {:get {:handler show-user}}]])
 *
 * A route entry is a `vec_lit` whose first element is a `str_lit` path segment.
 * The next sibling is EITHER another vector (nested child routes — the string
 * segment prefixes them) OR a `map_lit` whose keys are HTTP methods (:get,
 * :post, ...), each mapping to a handler map with a `:handler` key (and
 * optionally `:middleware [...]`). Prefixes accumulate down the vector nesting,
 * exactly like Compojure's `context`.
 *
 * Ring: a bare Ring handler is a 1-arity function `(defn handler [request] ...)`
 * that returns a response map (`{:status ... :body ...}`). Ring itself has no
 * routing DSL — it's the request/response contract Reitit (and Compojure)
 * dispatch onto. We surface top-level Ring handler defns only when they are
 * NOT already captured as a Reitit :handler target, so a Ring-only app (no
 * router, just `(run-jetty handler {...})`) still gets its entry points named.
 *
 * Node types grounded on the same tree-sitter-clojure grammar as Compojure
 * (list_lit / vec_lit / map_lit / sym_lit / str_lit / kwd_lit).
 */

const HTTP_METHOD_KEYWORDS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options']);

interface ReititRoute {
  method: string;
  fullPath: string;
  handler: string;
  middleware: string[];
  line: number;
}

interface RingHandler {
  name: string;
  line: number;
}

export class ReititAnalyzer extends BaseAnalyzer {
  constructor() {
    super('reitit', 'Reitit/Ring Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      for (const manifest of ['deps.edn', 'project.clj']) {
        const p = path.join(projectPath, manifest);
        if (await fs.pathExists(p)) {
          const content = await fs.readFile(p, 'utf-8');
          if (/reitit|ring\/ring-core|ring\/ring-jetty-adapter/i.test(content)) return true;
        }
      }
      for (const file of await this.findClojureFiles(projectPath)) {
        const content = await fs.readFile(file, 'utf-8');
        if (/reitit\.(ring|core)|ring\.adapter|defn\s+\S+\s*\[request\]|\(:handler\b/.test(content)) return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];

    try {
      const files = await this.findClojureFiles(context.projectPath);
      let reititRouteCount = 0;
      let ringHandlerCount = 0;

      for (const file of files) {
        const content = await fs.readFile(file, 'utf-8');
        const isRelevant = /reitit|:handler\b|ring\.adapter|defn\s+\S+\s*\[request\]/.test(content);
        if (!isRelevant) continue;

        const relativePath = path.relative(context.projectPath, file);
        const tree = await parseWasm('clojure', content);
        const root = tree.rootNode;

        const routes = this.extractReititRoutes(root);
        const handlerNamesUsed = new Set(routes.map(r => r.handler));
        for (const route of routes) {
          this.emitReititRoute(route, relativePath, entryPoints);
          reititRouteCount++;
        }

        // Bare Ring handlers not already referenced as a Reitit :handler target —
        // covers Ring-only apps with no router (`(run-jetty handler {...})`).
        const ringHandlers = this.extractRingHandlers(root).filter(h => !handlerNamesUsed.has(h.name));
        for (const handler of ringHandlers) {
          this.emitRingHandler(handler, relativePath, entryPoints);
          ringHandlerCount++;
        }
      }

      return this.createContribution(nodes, edges, entryPoints, [], {
        framework_specific: {
          framework: 'reitit',
          reitit_route_count: reititRouteCount,
          ring_handler_count: ringHandlerCount,
        },
      });
    } catch (error) {
      throw new Error(`Reitit/Ring analysis failed: ${(error as Error).message}`);
    }
  }

  protected getCapabilities(): string[] {
    return ['route-data-detection', 'nested-vector-prefix-resolution', 'ring-handler-detection'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'reitit-framework';
      case 2: return 'route-data';
      case 3: return 'nested-vectors';
      case 4: return 'handlers';
      default: return `reitit-level-${level}`;
    }
  }

  /**
   * Walk every top-level `vec_lit` looking for the Reitit route-data shape:
   * `["/path" ...]` where the first element is a str_lit. Descend recursively,
   * accumulating the path prefix; a sibling `map_lit` with HTTP-method keywords
   * is the route's method table, a sibling `vec_lit` (or a vector-of-vectors) is
   * nested child routes.
   */
  private extractReititRoutes(root: any): ReititRoute[] {
    const routes: ReititRoute[] = [];
    const seen = new Set<string>();

    const walk = (node: any, prefix: string): void => {
      if (!node) return;

      if (node.type === 'vec_lit') {
        const first = this.firstNamedChild(node);
        if (first && first.type === 'str_lit') {
          const segment = this.stringValue(first);
          const fullPrefix = this.joinPrefix(prefix, segment);

          // Scan the remaining siblings for a method map and/or nested vectors.
          for (let i = 1; i < node.namedChildCount; i++) {
            const sibling = node.namedChild(i);
            if (sibling.type === 'map_lit') {
              this.extractMethodTable(sibling, fullPrefix).forEach(route => {
                const key = `${route.method}:${route.fullPath}`;
                if (!seen.has(key)) { seen.add(key); routes.push(route); }
              });
            } else if (sibling.type === 'vec_lit') {
              walk(sibling, fullPrefix);
            }
          }
          return;
        }
        // Not a route vector (e.g. the outer `[...]` wrapping a list of route
        // vectors, or a binding vector) — descend into each child at the same prefix.
        this.walkChildren(node, prefix, walk);
        return;
      }

      this.walkChildren(node, prefix, walk);
    };

    walk(root, '');
    return routes;
  }

  private walkChildren(node: any, prefix: string, walk: (n: any, p: string) => void): void {
    for (let i = 0; i < node.namedChildCount; i++) walk(node.namedChild(i), prefix);
  }

  /** A route's method table: `{:get {:handler f} :post {:handler g :middleware [...]}}`. */
  private extractMethodTable(mapNode: any, fullPath: string): ReititRoute[] {
    const routes: ReititRoute[] = [];
    const entries = this.mapEntries(mapNode);
    for (const [keyNode, valNode] of entries) {
      if (keyNode.type !== 'kwd_lit') continue;
      const method = this.keywordName(keyNode);
      if (!method || !HTTP_METHOD_KEYWORDS.has(method)) continue;
      if (valNode.type !== 'map_lit') continue;

      const handlerEntry = this.mapEntries(valNode).find(([k]) => this.keywordName(k) === 'handler');
      const handler = handlerEntry ? this.symbolOrKeywordText(handlerEntry[1]) : undefined;
      if (!handler) continue;

      const middlewareEntry = this.mapEntries(valNode).find(([k]) => this.keywordName(k) === 'middleware');
      const middleware = middlewareEntry ? this.collectSymbolsInVec(middlewareEntry[1]) : [];

      routes.push({
        method: method.toUpperCase(),
        fullPath,
        handler,
        middleware,
        line: keyNode.startPosition.row + 1,
      });
    }
    return routes;
  }

  /** Top-level `(defn name [request] ...)` / `(defn name [req] ...)` 1-arity
   *  handler defns — the Ring handler contract. */
  private extractRingHandlers(root: any): RingHandler[] {
    const handlers: RingHandler[] = [];
    const walk = (node: any): void => {
      if (!node) return;
      if (node.type === 'list_lit') {
        const head = this.headSymbolName(node);
        if (head === 'defn' || head === 'defn-') {
          const nameNode = this.namedChildAt(node, 1);
          const bindingsNode = this.namedChildAt(node, 2);
          if (nameNode?.type === 'sym_lit' && bindingsNode?.type === 'vec_lit' && bindingsNode.namedChildCount === 1) {
            const paramNode = bindingsNode.namedChild(0);
            const paramName = paramNode?.type === 'sym_lit' ? this.symbolName(paramNode) : undefined;
            if (paramName && /^req(uest)?$/.test(paramName)) {
              handlers.push({ name: this.symbolName(nameNode) || '', line: node.startPosition.row + 1 });
            }
          }
        }
      }
      for (let i = 0; i < node.namedChildCount; i++) walk(node.namedChild(i));
    };
    walk(root);
    return handlers.filter(h => h.name);
  }

  private emitReititRoute(route: ReititRoute, relativePath: string, entryPoints: CASEntryPoint[]): void {
    const nodeId = `function:${relativePath}:${route.handler}`;
    const guards = route.middleware;
    // Reitit middleware IS attributable per-route (unlike Compojure's whole-handler
    // Ring middleware) since it's declared inside the route's own method map.
    const authGuards = guards.filter(g => /auth|jwt|session|token/i.test(g));

    entryPoints.push(
      this.createEntryPoint(
        `entry:http:${relativePath}:${route.handler}:${route.method}:${route.fullPath}`,
        nodeId,
        'http',
        `${route.method} ${route.fullPath}`,
        `HTTP route handled by ${route.handler}`,
        { method: route.method, path: route.fullPath },
        { authenticated: authGuards.length > 0, guards, authorized_roles: [] },
        {
          framework: 'reitit',
          method: route.method,
          path: route.fullPath,
          handler: route.handler,
          middleware: guards,
        },
        { node_id: nodeId, method_name: route.handler, file: relativePath, line: route.line }
      )
    );
  }

  private emitRingHandler(handler: RingHandler, relativePath: string, entryPoints: CASEntryPoint[]): void {
    const nodeId = `function:${relativePath}:${handler.name}`;
    entryPoints.push(
      this.createEntryPoint(
        `entry:http:${relativePath}:${handler.name}:ring`,
        nodeId,
        'http',
        `ring:${handler.name}`,
        `Ring HTTP handler: ${handler.name}`,
        { method: 'ANY' },
        { authenticated: false, guards: [], authorized_roles: [] },
        { framework: 'ring', handler: handler.name },
        { node_id: nodeId, method_name: handler.name, file: relativePath, line: handler.line }
      )
    );
  }

  // ---- AST helpers (grounded on tree-sitter-clojure) ----------------------------

  private firstNamedChild(node: any): any {
    return node.namedChildCount > 0 ? node.namedChild(0) : undefined;
  }

  private namedChildAt(node: any, index: number): any {
    return node.namedChildCount > index ? node.namedChild(index) : undefined;
  }

  private headSymbolName(listNode: any): string | undefined {
    const first = this.firstNamedChild(listNode);
    return first?.type === 'sym_lit' ? this.symbolName(first) : undefined;
  }

  private symbolName(symNode: any): string | undefined {
    const name = this.childOfType(symNode, 'sym_name');
    const text = (name ? name.text : symNode.text) ?? '';
    return text.trim() || undefined;
  }

  /** A keyword's clean name (`:get` -> "get"), or undefined if not a kwd_lit. */
  private keywordName(node: any): string | undefined {
    if (node.type !== 'kwd_lit') return undefined;
    const text = (node.text ?? '').trim();
    return text.replace(/^:+/, '') || undefined;
  }

  /** A `:handler` value can be a bare symbol (`list-users`) or, less commonly, a
   *  fully-qualified symbol (`app.core/list-users`) — we keep only the final segment. */
  private symbolOrKeywordText(node: any): string | undefined {
    if (node.type === 'sym_lit') {
      const name = this.symbolName(node);
      return name ? name.split('/').pop() : undefined;
    }
    return undefined;
  }

  /** Every top-level symbol inside a `[a b c]` vector (e.g. a `:middleware` vector). */
  private collectSymbolsInVec(node: any): string[] {
    if (node.type !== 'vec_lit') return [];
    const names: string[] = [];
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c.type === 'sym_lit') {
        const name = this.symbolName(c);
        if (name) names.push(name.split('/').pop()!);
      }
    }
    return names;
  }

  /** Pair up a map_lit's alternating key/value named children:
   *  `{:get {...} :post {...}}` -> [[:get-node, {...}-node], [:post-node, {...}-node]]. */
  private mapEntries(mapNode: any): Array<[any, any]> {
    const entries: Array<[any, any]> = [];
    const children: any[] = [];
    for (let i = 0; i < mapNode.namedChildCount; i++) children.push(mapNode.namedChild(i));
    for (let i = 0; i + 1 < children.length; i += 2) {
      entries.push([children[i], children[i + 1]]);
    }
    return entries;
  }

  private stringValue(strNode: any): string {
    const raw = (strNode.text ?? '').trim();
    return raw.replace(/^"|"$/g, '');
  }

  private joinPrefix(prefix: string, segment: string): string {
    const a = prefix.replace(/\/+$/, '');
    const b = segment.startsWith('/') ? segment : '/' + segment;
    let joined = (a + b).replace(/\/+/g, '/');
    if (joined === '') joined = '/';
    if (joined.length > 1) joined = joined.replace(/\/$/, '');
    return joined;
  }

  private childOfType(node: any, type: string): any {
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c.type === type) return c;
    }
    return undefined;
  }

  private async findClojureFiles(projectPath: string): Promise<string[]> {
    const files = await glob('**/*.{clj,cljs,cljc}', {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath } as AnalysisContext),
      nodir: true,
    });
    return files.map(file => path.join(projectPath, file));
  }
}
