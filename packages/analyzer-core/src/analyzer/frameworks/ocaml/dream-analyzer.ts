import { AnalysisContext, BaseAnalyzer } from '../../core/base-analyzer';
import { CASContribution, CASEntryPoint, CASNode, CASEdge } from '../../../types/cas.types';
import { parseWasm } from '../../core/wasm-tree-sitter';
import * as fs from 'fs-extra';
import * as path from 'path';
import { cachedGlob as glob } from '../../core/glob-cache';

/**
 * Dream (OCaml web framework) route analyzer.
 *
 * Dream registers routes inside `Dream.router [ ... ]`, where each element is a
 * `Dream.<method> "<path>" handler` application, and `Dream.scope "/prefix"
 * middlewares routes` prefixes a nested list of routes:
 *
 *   Dream.router [
 *     Dream.get    "/"           home_handler;
 *     Dream.post   "/users"      create_user;
 *     Dream.get    "/users/:id"  show_user;
 *     Dream.delete "/users/:id"  destroy_user;
 *     Dream.scope "/api" [ auth_middleware ] [
 *       Dream.get "/health"      health;
 *       Dream.put "/users/:id"   update_user;
 *     ];
 *   ]
 *
 * Dream uses `:id`-style path params, so paths are emitted verbatim (no rewriting).
 *
 * AUTH — honest limitation: Dream auth is middleware in a `Dream.scope`'s middleware
 * list (the 2nd argument), applied cross-cuttingly to every nested route. It is NOT a
 * per-route guard, so attributing `authenticated:true` to an individual route would be
 * a guess. We therefore emit `auth:false` for every route unless a clear per-route
 * guard is present (none exists in the idiomatic Dream.router form) and document the
 * limitation rather than guessing.
 *
 * Node types grounded on the real vendored tree-sitter-ocaml grammar (dumped):
 *   application_expression                 # `Dream.get "/" home_handler`
 *     value_path        "Dream.get"        #   the function path
 *       module_path     "Dream"            #     receiver module (module_name child)
 *       value_name      "get"              #     the method name
 *     string            "\"/\""            #   first string arg = path
 *       string_content  "/"                #     CLEAN path text (empty "" has no child)
 *     value_path        "home_handler"     #   handler arg (value_name child)
 *   list_expression                        # the `[ ... ]` router / scope route list
 * `Dream.scope "/api" [mw] [routes]` is an application_expression whose args are:
 *   string (prefix), list_expression (middlewares), list_expression (nested routes).
 * `Dream.run`/`Dream.logger`/`Dream.router` appear inside infix_expression (`@@`)
 * chains; they are naturally excluded because their value_name is not an HTTP method.
 */

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);

interface DreamRoute {
  method: string;
  fullPath: string;
  handler: string;
  line: number;
}

export class DreamAnalyzer extends BaseAnalyzer {
  constructor() {
    super('dream', 'Dream Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      // Manifest signal: dune-project / dune depending on dream.
      for (const manifest of ['dune-project', 'dune']) {
        const p = path.join(projectPath, manifest);
        if (await fs.pathExists(p)) {
          const content = await fs.readFile(p, 'utf-8');
          if (/\bdream\b/i.test(content)) return true;
        }
      }
      // Source signal: a Dream.router/Dream.<method> call in any .ml file.
      for (const file of await this.findOCamlFiles(projectPath)) {
        const content = await fs.readFile(file, 'utf-8');
        if (/Dream\.(router|get|post|put|patch|delete|options|head|scope|run)\b/.test(content)) {
          return true;
        }
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
      const files = await this.findOCamlFiles(context.projectPath);
      for (const file of files) {
        const content = await fs.readFile(file, 'utf-8');
        if (!/Dream\.(router|get|post|put|patch|delete|options|head|scope)\b/.test(content)) {
          continue;
        }
        const relativePath = path.relative(context.projectPath, file);
        await this.extractRoutes(content, relativePath, entryPoints);
      }

      return this.createContribution(nodes, edges, entryPoints, [], {
        framework_specific: {
          framework: 'dream',
          route_count: entryPoints.filter(ep => ep.metadata?.framework === 'dream').length,
          authenticated_route_count: entryPoints.filter(
            ep => ep.metadata?.framework === 'dream' && ep.security?.authenticated
          ).length,
        },
      });
    } catch (error) {
      throw new Error(`Dream analysis failed: ${(error as Error).message}`);
    }
  }

  protected getCapabilities(): string[] {
    return ['route-detection', 'scope-prefix-resolution'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'dream-framework';
      case 2: return 'router-and-scopes';
      case 3: return 'handlers';
      default: return `dream-level-${level}`;
    }
  }

  /**
   * Parse one OCaml source and emit an http entry point per Dream route.
   *
   * Walk every `application_expression`; if its function path is `Dream.<method>`
   * with an HTTP method, it is a route (path = first string arg). If it is
   * `Dream.scope`, recurse into its nested route list with the prefix accumulated.
   */
  private async extractRoutes(content: string, relativePath: string, entryPoints: CASEntryPoint[]): Promise<void> {
    const tree = await parseWasm('ocaml', content);
    const root = tree.rootNode;
    const seen = new Set<string>();

    // Walk the tree looking for route applications; for scopes we recurse with the
    // accumulated prefix. We descend the whole tree (so routers nested in let bindings
    // / infix `@@` chains are reached), and at each route/scope application we apply the
    // prefix that the enclosing scopes contributed.
    const visitWithPrefix = (node: any, prefix: string): void => {
      if (!node) return;

      if (node.type === 'application_expression') {
        const fn = this.dreamMethod(node);
        if (fn === 'scope') {
          const { prefix: scopePrefix, routesList } = this.parseScope(node);
          if (routesList) {
            const childPrefix = this.joinPaths(prefix, scopePrefix);
            // Recurse only into the scope's route list with the combined prefix; the
            // middleware list (2nd arg) carries no routes.
            for (let i = 0; i < routesList.namedChildCount; i++) {
              visitWithPrefix(routesList.namedChild(i), childPrefix);
            }
            return; // do not double-walk the scope's children with the parent prefix
          }
        } else if (fn && HTTP_METHODS.has(fn)) {
          const route = this.parseRouteCall(node, fn, prefix);
          if (route) {
            const dedupe = `${route.method}:${route.fullPath}`;
            if (!seen.has(dedupe)) {
              seen.add(dedupe);
              this.emitRoute(route, relativePath, entryPoints);
            }
          }
          // A route's handler arg can't contain further routes; fall through to walk
          // children is harmless but unnecessary. Continue walking for safety.
        }
      }

      for (let i = 0; i < node.namedChildCount; i++) {
        visitWithPrefix(node.namedChild(i), prefix);
      }
    };

    visitWithPrefix(root, '');
  }

  /** If `app` is `Dream.<name> ...`, return `<name>`; else null. */
  private dreamMethod(app: any): string | null {
    const fn = app.namedChild(0);
    if (!fn || fn.type !== 'value_path') return null;
    const moduleName = this.childOfType(fn, 'module_path');
    const valueName = this.childOfType(fn, 'value_name');
    if (!moduleName || !valueName) return null;
    if (this.nodeText(moduleName).trim() !== 'Dream') return null;
    return this.nodeText(valueName).trim();
  }

  /** Parse `Dream.<method> "<path>" handler` into a route. */
  private parseRouteCall(app: any, method: string, prefix: string): DreamRoute | null {
    const pathArg = this.firstStringArg(app);
    if (pathArg === null) return null;

    const fullPath = this.joinPaths(prefix, pathArg);
    const handler = this.handlerArgName(app) || this.handlerName(method, fullPath);

    return {
      method: method.toUpperCase(),
      fullPath,
      handler,
      line: app.startPosition.row + 1,
    };
  }

  /**
   * Parse `Dream.scope "<prefix>" [middlewares] [routes]`.
   * Args after the function path: string (prefix), list_expression (mw), list_expression (routes).
   */
  private parseScope(app: any): { prefix: string; routesList: any | null } {
    let prefix = '';
    const lists: any[] = [];
    // namedChild(0) is the value_path; scan the rest in order.
    for (let i = 1; i < app.namedChildCount; i++) {
      const c = app.namedChild(i);
      if (c.type === 'string' && prefix === '') {
        prefix = this.stringLiteralValue(c) ?? '';
      } else if (c.type === 'list_expression') {
        lists.push(c);
      }
    }
    // The route list is the LAST list_expression (middlewares first, routes last).
    const routesList = lists.length > 0 ? lists[lists.length - 1] : null;
    return { prefix, routesList };
  }

  private emitRoute(route: DreamRoute, relativePath: string, entryPoints: CASEntryPoint[]): void {
    const nodeId = `function:${relativePath}:${route.handler}`;
    entryPoints.push(
      this.createEntryPoint(
        `entry:http:${relativePath}:${route.handler}:${route.method}:${route.fullPath}`,
        nodeId,
        'http',
        `${route.method} ${route.fullPath}`,
        `HTTP route ${route.method} ${route.fullPath} (Dream router)`,
        { method: route.method, path: route.fullPath },
        // Honest: Dream auth is cross-cutting scope middleware, not per-route.
        { authenticated: false },
        {
          framework: 'dream',
          method: route.method,
          path: route.fullPath,
          handler: route.handler,
          controller: undefined,
        },
        { node_id: nodeId, method_name: route.handler, file: relativePath, line: route.line }
      )
    );
  }

  // ---- AST helpers (grounded on vendored tree-sitter-ocaml) ----------------------

  private nodeText(node: any): string {
    return node?.text ?? '';
  }

  private childOfType(node: any, type: string): any {
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c.type === type) return c;
    }
    return undefined;
  }

  /** First `string` arg of an application (the path literal), cleaned, or null. */
  private firstStringArg(app: any): string | null {
    for (let i = 1; i < app.namedChildCount; i++) {
      const c = app.namedChild(i);
      if (c.type === 'string') return this.stringLiteralValue(c);
    }
    return null;
  }

  /** Name of the handler arg: first `value_path` after the path string, else null. */
  private handlerArgName(app: any): string | null {
    let sawString = false;
    for (let i = 1; i < app.namedChildCount; i++) {
      const c = app.namedChild(i);
      if (c.type === 'string') { sawString = true; continue; }
      if (sawString && c.type === 'value_path') {
        const vn = this.childOfType(c, 'value_name');
        return vn ? this.nodeText(vn).trim() : this.nodeText(c).trim();
      }
    }
    return null;
  }

  /** Clean text of a `string` node via its `string_content` child (empty "" -> ''). */
  private stringLiteralValue(node: any): string | null {
    if (node.type !== 'string') return null;
    const content = this.childOfType(node, 'string_content');
    if (content) return this.nodeText(content);
    // Empty string literal "" has no string_content child.
    return this.nodeText(node).replace(/^"|"$/g, '');
  }

  /** Join a scope prefix with a route path, normalizing slashes. */
  private joinPaths(prefix: string, segment: string): string {
    const a = (prefix || '').trim();
    const b = (segment || '').trim();
    let joined = `${a}/${b}`;
    if (!joined.startsWith('/')) joined = '/' + joined;
    joined = joined.replace(/\/+/g, '/');
    if (joined.length > 1) joined = joined.replace(/\/$/, '');
    return joined;
  }

  /** Stable handler name fallback derived from method + path. */
  private handlerName(method: string, fullPath: string): string {
    const slug = fullPath.replace(/[/:]/g, '_').replace(/^_+|_+$/g, '') || 'root';
    return `${method}_${slug}`;
  }

  private async findOCamlFiles(projectPath: string): Promise<string[]> {
    const files = await glob('**/*.{ml,mli}', {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath } as AnalysisContext),
      nodir: true,
    });
    return files.map(file => path.join(projectPath, file));
  }
}
