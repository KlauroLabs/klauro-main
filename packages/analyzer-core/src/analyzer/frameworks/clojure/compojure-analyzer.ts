import { AnalysisContext, BaseAnalyzer } from '../../core/base-analyzer';
import { CASContribution, CASEntryPoint, CASNode, CASEdge } from '../../../types/cas.types';
import { parseWasm } from '../../core/wasm-tree-sitter';
import * as fs from 'fs-extra';
import * as path from 'path';
import { glob } from 'glob';

/**
 * Compojure (Clojure routing) framework analyzer.
 *
 * Compojure declares routes as homoiconic s-expressions: every route is a list
 * `(METHOD "path" args body)` whose head symbol is an HTTP verb, grouped under a
 * `defroutes`/`routes` form and optionally nested under `context` forms that prefix
 * their children's paths:
 *
 *   (defroutes app-routes
 *     (GET    "/"          []    home)            ; GET /
 *     (GET    "/users/:id" [id]  (show id))       ; GET /users/:id
 *     (POST   "/users"     req   (create req))    ; POST /users
 *     (DELETE "/users/:id" [id]  (destroy id))    ; DELETE /users/:id
 *     (context "/api" []
 *       (GET  "/health" [] health)               ; GET /api/health
 *       (POST "/items"  req (mk req))))           ; POST /api/items
 *
 * METHOD is one of GET POST PUT DELETE PATCH HEAD OPTIONS ANY. `:id`-style path
 * params are already in the canonical Compojure/route-table form, so they are kept
 * verbatim. `ANY` is emitted as a GET route (it matches all verbs; GET is the
 * representative). `context` accumulates its string prefix onto every descendant
 * route's path.
 *
 * Auth: Compojure applies authentication as Ring middleware
 * (`wrap-authentication`, buddy's `wrap-authorization`, etc.) on the handler/app,
 * NOT per route. That composition is not attributable to individual routes from the
 * route forms alone, so we are honest and emit `authenticated: false` for every
 * route unless a clear per-route guard is present (none in idiomatic Compojure).
 * This limitation is documented rather than guessed.
 *
 * Node types grounded on the real tree-sitter-clojure grammar (see artifact):
 *   list_lit                       ; every s-expression list, incl. each route form
 *     sym_lit > sym_name           ; the head symbol ("GET"/"context"/"defroutes"...)
 *     str_lit                      ; a string literal (text INCLUDES the quotes)
 *     vec_lit                      ; the binding vector e.g. [id]
 *   Clojure is homoiconic: there are no dedicated call/route nodes — routing is just
 *   nested `list_lit`s, so we walk lists and classify by head symbol.
 */

const HTTP_METHODS = new Set([
  'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'ANY',
]);
/** Forms whose children are route forms sharing the parent's accumulated prefix. */
const ROUTE_CONTAINERS = new Set(['defroutes', 'routes']);

interface CompojureRoute {
  method: string;
  fullPath: string;
  handler: string;
  line: number;
}

export class CompojureAnalyzer extends BaseAnalyzer {
  constructor() {
    super('compojure', 'Compojure Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      // Manifest signal: deps.edn / project.clj depending on compojure.
      for (const manifest of ['deps.edn', 'project.clj']) {
        const p = path.join(projectPath, manifest);
        if (await fs.pathExists(p)) {
          const content = await fs.readFile(p, 'utf-8');
          if (/compojure/i.test(content)) return true;
        }
      }
      // Source signal: compojure require / defroutes usage in any clojure file.
      for (const file of await this.findClojureFiles(projectPath)) {
        const content = await fs.readFile(file, 'utf-8');
        if (/compojure\.core|\(defroutes\b|\(context\b/.test(content)) return true;
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
      for (const file of files) {
        const content = await fs.readFile(file, 'utf-8');
        if (!/compojure|\(defroutes\b|\(context\b|\(GET\b|\(POST\b|\(PUT\b|\(DELETE\b/.test(content)) {
          continue;
        }
        const relativePath = path.relative(context.projectPath, file);
        await this.extractRoutes(content, relativePath, entryPoints);
      }

      return this.createContribution(nodes, edges, entryPoints, [], {
        framework_specific: {
          framework: 'compojure',
          route_count: entryPoints.filter(ep => ep.metadata?.framework === 'compojure').length,
          authenticated_route_count: entryPoints.filter(
            ep => ep.metadata?.framework === 'compojure' && ep.security?.authenticated
          ).length,
        },
      });
    } catch (error) {
      throw new Error(`Compojure analysis failed: ${(error as Error).message}`);
    }
  }

  protected getCapabilities(): string[] {
    return ['route-detection', 'context-prefix-resolution', 'path-param-extraction'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'compojure-framework';
      case 2: return 'route-forms';
      case 3: return 'context-nesting';
      case 4: return 'handlers';
      default: return `compojure-level-${level}`;
    }
  }

  /**
   * Parse one Clojure source and emit an http entry point per Compojure route.
   *
   * We walk every `list_lit`. A list whose head symbol is an HTTP method is a route
   * (emit it with the accumulated prefix). A list whose head is `context` carries a
   * string prefix that is pushed onto the prefix for its descendant route forms. A
   * list whose head is `defroutes`/`routes` is a transparent grouping container. We
   * descend with the current prefix; because Compojure nests routes structurally,
   * the AST walk resolves prefixes naturally.
   */
  private async extractRoutes(content: string, relativePath: string, entryPoints: CASEntryPoint[]): Promise<void> {
    const tree = await parseWasm('clojure', content);
    const root = tree.rootNode;
    const seen = new Set<string>();

    const walk = (node: any, prefix: string): void => {
      if (!node) return;

      if (node.type === 'list_lit') {
        const head = this.headSymbol(node);

        if (head && HTTP_METHODS.has(head)) {
          const route = this.parseRouteForm(node, head, prefix);
          if (route) {
            const dedupe = `${route.method}:${route.fullPath}`;
            if (!seen.has(dedupe)) {
              seen.add(dedupe);
              this.emitRoute(route, relativePath, entryPoints);
            }
          }
          // A route form may still nest further route lists in its body
          // (e.g. inline `(context ...)` within a handler) — keep descending with
          // the same accumulated prefix.
          this.walkChildren(node, prefix, walk);
          return;
        }

        if (head === 'context') {
          const seg = this.firstStringSegment(node);
          const childPrefix = seg ? this.joinPrefix(prefix, seg) : prefix;
          this.walkChildren(node, childPrefix, walk);
          return;
        }

        // defroutes / routes / any other list: transparent — descend with same prefix.
        this.walkChildren(node, prefix, walk);
        return;
      }

      this.walkChildren(node, prefix, walk);
    };

    walk(root, '');
  }

  private walkChildren(node: any, prefix: string, walk: (n: any, p: string) => void): void {
    for (let i = 0; i < node.namedChildCount; i++) {
      walk(node.namedChild(i), prefix);
    }
  }

  /**
   * Parse a `(METHOD "path" args body)` route form into method + resolved path +
   * handler. The path is the first `str_lit` in the form; the handler name is the
   * first symbol in the body after the binding vector (best-effort), else a synthetic
   * name derived from method+path.
   */
  private parseRouteForm(node: any, head: string, prefix: string): CompojureRoute | null {
    const rawPath = this.firstStringSegment(node);
    if (rawPath === null) return null; // a METHOD-headed list with no path isn't a route

    const method = head === 'ANY' ? 'GET' : head;
    const fullPath = this.joinPrefix(prefix, rawPath);
    const handler = this.routeHandlerName(node) ??
      `${method.toLowerCase()}_${fullPath.replace(/[/:]/g, '_').replace(/^_+|_+$/g, '') || 'root'}`;

    return {
      method,
      fullPath,
      handler,
      line: node.startPosition.row + 1,
    };
  }

  /**
   * Best-effort handler name: the head symbol of the route body. The route form is
   * `(METHOD path bindings & body)`; the body's leading element is either a symbol
   * (a handler ref like `home`) or a list whose head symbol is the called handler
   * (e.g. `(show id)` -> `show`). Returns undefined when nothing nameable is found.
   */
  private routeHandlerName(node: any): string | undefined {
    // Collect named children in order, skipping the head symbol, the path string,
    // and the binding vector; the next element is the body head.
    const children: any[] = [];
    for (let i = 0; i < node.namedChildCount; i++) children.push(node.namedChild(i));

    let sawPath = false;
    let sawBindings = false;
    for (let i = 1; i < children.length; i++) {
      const c = children[i];
      if (!sawPath && c.type === 'str_lit') { sawPath = true; continue; }
      if (sawPath && !sawBindings && (c.type === 'vec_lit' || c.type === 'sym_lit' || c.type === 'map_lit')) {
        // The request-binding form (a vector `[id]`, a symbol `req`, or a destructure map).
        sawBindings = true;
        continue;
      }
      if (sawPath && sawBindings) {
        // Body head.
        if (c.type === 'sym_lit') return this.symbolName(c);
        if (c.type === 'list_lit') {
          const h = this.headSymbol(c);
          if (h) return h;
        }
        return undefined;
      }
    }
    return undefined;
  }

  private emitRoute(route: CompojureRoute, relativePath: string, entryPoints: CASEntryPoint[]): void {
    const nodeId = `function:${relativePath}:${route.handler}`;
    entryPoints.push(
      this.createEntryPoint(
        `entry:http:${relativePath}:${route.handler}:${route.method}:${route.fullPath}`,
        nodeId,
        'http',
        `${route.method} ${route.fullPath}`,
        `HTTP route handled by ${route.handler}`,
        { method: route.method, path: route.fullPath },
        // Compojure auth is Ring middleware, not per-route attributable. Honest: false.
        { authenticated: false },
        {
          framework: 'compojure',
          method: route.method,
          path: route.fullPath,
          handler: route.handler,
          controller: undefined,
        },
        { node_id: nodeId, method_name: route.handler, file: relativePath, line: route.line }
      )
    );
  }

  // ---- AST helpers (grounded on tree-sitter-clojure) ----------------------------

  /** The head symbol name of a list_lit (`(GET ...)` -> "GET"), or undefined. */
  private headSymbol(listNode: any): string | undefined {
    for (let i = 0; i < listNode.namedChildCount; i++) {
      const c = listNode.namedChild(i);
      if (c.type === 'sym_lit') return this.symbolName(c);
      // Stop at the first named child — the head is the first element.
      return undefined;
    }
    return undefined;
  }

  /** The clean name of a sym_lit (its sym_name child, or its text). */
  private symbolName(symNode: any): string | undefined {
    const name = this.childOfType(symNode, 'sym_name');
    const text = (name ? name.text : symNode.text) ?? '';
    return text.trim() || undefined;
  }

  /**
   * The first string-literal path of a list form, normalized to a clean route
   * segment (quotes stripped, no leading/trailing slash collapse beyond cleanup),
   * or null when the form has no string literal.
   */
  private firstStringSegment(listNode: any): string | null {
    for (let i = 0; i < listNode.namedChildCount; i++) {
      const c = listNode.namedChild(i);
      if (c.type === 'str_lit') {
        return this.stringValue(c);
      }
    }
    return null;
  }

  /** Strip the surrounding quotes from a str_lit's text. */
  private stringValue(strNode: any): string {
    const raw = (strNode.text ?? '').trim();
    return raw.replace(/^"|"$/g, '');
  }

  /**
   * Join a context prefix with a route/sub-context path, collapsing duplicate
   * slashes and guaranteeing a single leading slash. Root '/' stays '/'.
   */
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
