import { AnalysisContext, BaseAnalyzer } from '../../core/base-analyzer';
import { CASContribution, CASEntryPoint, CASNode, CASEdge } from '../../../types/cas.types';
import { parseWasm } from '../../core/wasm-tree-sitter';
import * as fs from 'fs-extra';
import * as path from 'path';
import { cachedGlob as glob } from '../../core/glob-cache';

/**
 * Genie.jl (Julia web framework) route analyzer.
 *
 * Genie declares routes with the `route` function and `@get`/`@post`/... macros:
 *
 *   route("/") do            # GET / (inline do-block handler)
 *     "home"
 *   end
 *   route("/users", users_index)                       // GET /users    -> users_index
 *   route("/users/:id", show_user)                     // GET /users/:id -> show_user
 *   route("/users", create_user, method = POST)        // POST /users    -> create_user
 *   route("/users/:id", delete_user, method = DELETE)  // DELETE /users/:id
 *   @get("/about", about)                              // GET /about     -> about
 *   @post("/login", do_login)                          // POST /login    -> do_login
 *
 * Method: a `method = <VERB>` keyword (named_argument) when present, else GET.
 * `@get`/`@post`/`@put`/`@patch`/`@delete` macros carry the verb in the macro name.
 * Path: the first string-literal argument; Genie uses `:id` route params, kept as-is.
 *
 * Auth in Genie is applied via middleware / plugins (Genie.Router middleware, or
 * package-level auth like GenieAuthentication) at the app/route-group level, not as a
 * per-route argument. There is no reliable per-route guard token in a `route(...)`
 * call, so we are HONEST and emit auth:false for every route unless a clear per-route
 * guard is present (none in the standard API). Documented limitation.
 *
 * Node types grounded on the real vendored tree-sitter-julia grammar (see artifact):
 *   call_expression
 *     identifier "route"
 *     argument_list
 *       string_literal > content          // clean path text (no quotes)
 *       identifier                         // handler name (positional)
 *       named_argument(identifier "method", operator "=", identifier "POST")
 *       do_clause                          // inline handler (route("/") do ... end)
 *   macrocall_expression
 *     macro_identifier > identifier "get"  // @get / @post / ...
 *     argument_list ( string_literal, identifier )
 */

/** Macro verb names that map to an HTTP method (`@get` -> GET). */
const MACRO_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

interface GenieRoute {
  method: string;
  fullPath: string;
  handler: string;
  authed: boolean;
  line: number;
}

export class GenieAnalyzer extends BaseAnalyzer {
  constructor() {
    super('genie', 'Genie Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      // Manifest signal: Project.toml depending on Genie (content-gated — Project.toml
      // is a generic Julia manifest, so we only claim it when Genie is referenced).
      const proj = path.join(projectPath, 'Project.toml');
      if (await fs.pathExists(proj)) {
        const content = await fs.readFile(proj, 'utf-8');
        if (/\bGenie\b/.test(content)) return true;
      }
      // Source signal: Genie usage / route DSL in any .jl file.
      for (const file of await this.findJuliaFiles(projectPath)) {
        const content = await fs.readFile(file, 'utf-8');
        if (/\bGenie\b/.test(content) && /\broute\s*\(|@(get|post|put|patch|delete)\s*\(/.test(content)) {
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
      const files = await this.findJuliaFiles(context.projectPath);
      for (const file of files) {
        const content = await fs.readFile(file, 'utf-8');
        if (!/\broute\s*\(/.test(content) && !/@(get|post|put|patch|delete|head|options)\s*\(/.test(content)) {
          continue;
        }
        const relativePath = path.relative(context.projectPath, file);
        await this.extractRoutes(content, relativePath, entryPoints);
      }

      return this.createContribution(nodes, edges, entryPoints, [], {
        framework_specific: {
          framework: 'genie',
          route_count: entryPoints.filter(ep => ep.metadata?.framework === 'genie').length,
          authenticated_route_count: entryPoints.filter(
            ep => ep.metadata?.framework === 'genie' && ep.security?.authenticated
          ).length,
        },
      });
    } catch (error) {
      throw new Error(`Genie analysis failed: ${(error as Error).message}`);
    }
  }

  protected getCapabilities(): string[] {
    return ['route-detection', 'method-keyword-resolution', 'macro-route-detection'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'genie-framework';
      case 2: return 'routes';
      case 3: return 'handlers';
      case 4: return 'middleware';
      default: return `genie-level-${level}`;
    }
  }

  /**
   * Parse one Julia source and emit an http entry point per Genie route. We walk to
   * every `call_expression` whose callee is `route` and every `macrocall_expression`
   * whose macro is an HTTP verb (`@get`/`@post`/...), then read the path + method +
   * handler from the argument list.
   */
  private async extractRoutes(content: string, relativePath: string, entryPoints: CASEntryPoint[]): Promise<void> {
    const tree = await parseWasm('julia', content);
    const root = tree.rootNode;
    const seen = new Set<string>();

    const visit = (node: any): void => {
      if (!node) return;

      let route: GenieRoute | null = null;
      if (node.type === 'call_expression') {
        route = this.parseRouteCall(node);
      } else if (node.type === 'macrocall_expression') {
        route = this.parseMacroCall(node);
      }
      if (route) {
        const dedupe = `${route.method}:${route.fullPath}:${route.handler}`;
        if (!seen.has(dedupe)) {
          seen.add(dedupe);
          this.emitRoute(route, relativePath, entryPoints);
        }
      }

      for (let i = 0; i < node.namedChildCount; i++) visit(node.namedChild(i));
    };

    visit(root);
  }

  /** Parse a `route("/path", handler, method = VERB)` call (or `route("/") do ... end`). */
  private parseRouteCall(callExpr: any): GenieRoute | null {
    const callee = callExpr.namedChild(0);
    if (!callee || callee.type !== 'identifier' || this.nodeText(callee).trim() !== 'route') return null;

    const argList = this.childOfType(callExpr, 'argument_list');
    if (!argList) return null;

    const path = this.firstStringArg(argList);
    if (path === null) return null;

    const method = this.methodKeyword(argList) || 'GET';
    const handler = this.positionalHandler(argList) || (this.childOfType(callExpr, 'do_clause') ? 'closure' : '');
    if (!handler) return null;

    return {
      method,
      fullPath: this.normalizePath(path),
      handler,
      authed: false, // Genie auth is middleware/plugin-level; no per-route guard. Honest.
      line: callExpr.startPosition.row + 1,
    };
  }

  /** Parse a `@get("/path", handler)` / `@post(...)` macro route. */
  private parseMacroCall(macroExpr: any): GenieRoute | null {
    const macroId = this.childOfType(macroExpr, 'macro_identifier');
    if (!macroId) return null;
    // macro_identifier wraps an identifier with the verb name (`@get` -> "get").
    const verbId = this.childOfType(macroId, 'identifier');
    const verb = (verbId ? this.nodeText(verbId) : this.nodeText(macroId).replace(/^@/, '')).trim().toLowerCase();
    if (!MACRO_METHODS.has(verb)) return null;

    const argList = this.childOfType(macroExpr, 'argument_list');
    if (!argList) return null;

    const path = this.firstStringArg(argList);
    if (path === null) return null;

    const handler = this.positionalHandler(argList) || 'closure';

    return {
      method: verb.toUpperCase(),
      fullPath: this.normalizePath(path),
      handler,
      authed: false,
      line: macroExpr.startPosition.row + 1,
    };
  }

  private emitRoute(route: GenieRoute, relativePath: string, entryPoints: CASEntryPoint[]): void {
    const nodeId = `function:${relativePath}:${route.handler}`;
    entryPoints.push(
      this.createEntryPoint(
        `entry:http:${relativePath}:${route.handler}:${route.method}:${route.fullPath}`,
        nodeId,
        'http',
        `${route.method} ${route.fullPath}`,
        `HTTP route handled by ${route.handler}`,
        { method: route.method, path: route.fullPath },
        { authenticated: route.authed },
        {
          framework: 'genie',
          method: route.method,
          path: route.fullPath,
          handler: route.handler,
          controller: undefined,
        },
        { node_id: nodeId, method_name: route.handler, file: relativePath, line: route.line }
      )
    );
  }

  // ---- AST helpers (grounded on vendored tree-sitter-julia) ---------------------

  private nodeText(node: any): string {
    return node?.text ?? '';
  }

  private childOfType(node: any, type: string): any {
    if (!node) return undefined;
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c.type === type) return c;
    }
    return undefined;
  }

  /** Clean text of the first string_literal argument (its `content` child), or null. */
  private firstStringArg(argList: any): string | null {
    for (let i = 0; i < argList.namedChildCount; i++) {
      const c = argList.namedChild(i);
      if (c.type === 'string_literal') return this.stringLiteralValue(c);
    }
    return null;
  }

  /** First positional identifier argument after the path (the handler name), or undefined. */
  private positionalHandler(argList: any): string | undefined {
    let seenString = false;
    for (let i = 0; i < argList.namedChildCount; i++) {
      const c = argList.namedChild(i);
      if (c.type === 'string_literal') { seenString = true; continue; }
      if (!seenString) continue;
      if (c.type === 'named_argument') continue;     // method = VERB, not a handler
      if (c.type === 'do_clause') continue;          // inline closure, handled separately
      if (c.type === 'identifier') return this.nodeText(c).trim();
      // `Controller.action` field expression -> use the full dotted name.
      if (c.type === 'field_expression') return this.nodeText(c).trim();
    }
    return undefined;
  }

  /** The HTTP verb of a `method = VERB` named_argument (uppercased), or undefined. */
  private methodKeyword(argList: any): string | undefined {
    for (let i = 0; i < argList.namedChildCount; i++) {
      const c = argList.namedChild(i);
      if (c.type !== 'named_argument') continue;
      const key = this.childOfType(c, 'identifier');
      if (!key || this.nodeText(key).trim() !== 'method') continue;
      // The value is the identifier after the `=` operator (last identifier child).
      let value: string | undefined;
      for (let j = 0; j < c.namedChildCount; j++) {
        const v = c.namedChild(j);
        if (v.type === 'identifier' && this.nodeText(v).trim() !== 'method') value = this.nodeText(v).trim();
        if (v.type === 'string_literal') value = this.stringLiteralValue(v) ?? value;
      }
      if (value) return value.toUpperCase();
    }
    return undefined;
  }

  /** Clean string value: prefer the `content` child, else strip quotes. */
  private stringLiteralValue(lit: any): string {
    const content = this.childOfType(lit, 'content');
    if (content) return this.nodeText(content);
    return this.nodeText(lit).replace(/^"|"$/g, '');
  }

  private normalizePath(p: string): string {
    const trimmed = p.trim();
    const withSlash = trimmed.startsWith('/') ? trimmed : '/' + trimmed;
    const collapsed = withSlash.replace(/\/+/g, '/');
    if (collapsed.length > 1) return collapsed.replace(/\/$/, '');
    return collapsed;
  }

  private async findJuliaFiles(projectPath: string): Promise<string[]> {
    const files = await glob('**/*.jl', {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath } as AnalysisContext),
      nodir: true,
    });
    return files.map(file => path.join(projectPath, file));
  }
}
