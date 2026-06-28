import { AnalysisContext, BaseAnalyzer } from '../../core/base-analyzer';
import { CASContribution, CASEntryPoint, CASNode, CASEdge } from '../../../types/cas.types';
import { isAuthenticationGuardName } from '../../core/guard-classification';
import { parseWasm } from '../../core/wasm-tree-sitter';
import * as fs from 'fs-extra';
import * as path from 'path';
import { glob } from 'glob';

/**
 * Vapor (Swift server) framework analyzer.
 *
 * Vapor builds its routes with a builder API on the `Application` (conventionally
 * `app`) and on `RoutesBuilder` group handles:
 *
 *   app.get("users", ":id", use: getUser)        // GET /users/:id  -> getUser
 *   app.post("users") { req in ... }             // POST /users     -> inline closure
 *   let users = app.grouped("users")             // path-prefix group
 *   users.delete(":id", use: deleteUser)         // DELETE /users/:id
 *   let protected = app.grouped(UserAuthenticator())   // middleware group (auth)
 *   protected.get("me", use: me)                 // GET /me  (authenticated)
 *
 * Auth in Vapor is applied with `.grouped(<middleware>)` on a routes builder, not
 * per-route. So which endpoints are protected is a composition fact, resolved by
 * tracking, for each builder variable, (a) its accumulated path prefix and (b)
 * whether any middleware on its `.grouped(...)` chain is an authenticator. A route
 * registered on an authenticated builder is authenticated.
 *
 * Node types are grounded on the real tree-sitter-swift grammar (see the recipe
 * artifact): call_expression -> navigation_expression(receiver + navigation_suffix)
 * + call_suffix(value_arguments [+ lambda_literal]); path segments are
 * value_argument > line_string_literal > line_str_text; the handler is the
 * value_argument whose value_argument_label is `use`; group bindings are
 * property_declaration `let <name> = <chain>`.
 */

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head']);

/** A routes-builder handle: a path prefix + whether it sits behind auth middleware. */
interface Builder {
  prefix: string[];   // accumulated path segments (no leading/trailing slash)
  authed: boolean;
}

export class VaporAnalyzer extends BaseAnalyzer {
  constructor() {
    super('vapor', 'Vapor Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      // Manifest signal: Package.swift depending on vapor.
      const pkg = path.join(projectPath, 'Package.swift');
      if (await fs.pathExists(pkg)) {
        const content = await fs.readFile(pkg, 'utf-8');
        if (/\bvapor\b/i.test(content)) return true;
      }
      // Source signal: `import Vapor` in any .swift file.
      for (const file of await this.findSwiftFiles(projectPath)) {
        const content = await fs.readFile(file, 'utf-8');
        if (/\bimport\s+Vapor\b/.test(content)) return true;
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
      const files = await this.findSwiftFiles(context.projectPath);
      for (const file of files) {
        const content = await fs.readFile(file, 'utf-8');
        if (!/\bimport\s+Vapor\b/.test(content) && !/\.(grouped|get|post|put|delete|patch)\s*\(/.test(content)) {
          continue;
        }
        const relativePath = path.relative(context.projectPath, file);
        await this.extractRoutes(content, relativePath, entryPoints);
      }

      return this.createContribution(nodes, edges, entryPoints, [], {
        framework_specific: {
          framework: 'vapor',
          route_count: entryPoints.filter(ep => ep.metadata?.framework === 'vapor').length,
          authenticated_route_count: entryPoints.filter(
            ep => ep.metadata?.framework === 'vapor' && ep.security?.authenticated
          ).length,
        },
      });
    } catch (error) {
      throw new Error(`Vapor analysis failed: ${(error as Error).message}`);
    }
  }

  protected getCapabilities(): string[] {
    return ['route-detection', 'route-group-prefix-resolution', 'middleware-auth-detection'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'vapor-framework';
      case 2: return 'route-groups';
      case 3: return 'handlers';
      case 4: return 'middleware';
      default: return `vapor-level-${level}`;
    }
  }

  /**
   * Parse one Swift source and emit an http entry point per Vapor route.
   *
   * Strategy: a single AST walk in document order. We maintain a map of builder
   * variables (`app` is the implicit root with an empty prefix and no auth). When we
   * see `let <name> = <chain>` whose chain resolves against a known builder via
   * `.grouped(...)`, we record the new builder with its derived prefix + auth. When
   * we see `<builder>.<method>(...)` for an HTTP method, we emit the route. Because
   * Vapor route files register groups before using them and in lexical order, a
   * forward document walk resolves builders before their routes.
   */
  private async extractRoutes(content: string, relativePath: string, entryPoints: CASEntryPoint[]): Promise<void> {
    const tree = await parseWasm('swift', content);
    const root = tree.rootNode;

    const builders = new Map<string, Builder>();
    // `app` is the implicit root builder. Vapor handlers conventionally take the
    // application as `app`, but the root receiver can be any name; we seed `app`
    // and additionally treat any bare receiver that is never declared as a group as
    // the root (empty prefix, unauthenticated) so `request.` style misuses don't leak.
    builders.set('app', { prefix: [], authed: false });

    const seen = new Set<string>();

    const visit = (node: any): void => {
      if (!node) return;

      if (node.type === 'property_declaration') {
        this.handleGroupBinding(node, builders);
      } else if (node.type === 'call_expression') {
        const route = this.parseRouteCall(node, builders);
        if (route) {
          const dedupe = `${route.method}:${route.fullPath}:${route.handler}`;
          if (!seen.has(dedupe)) {
            seen.add(dedupe);
            this.emitRoute(route, relativePath, entryPoints);
          }
        }
      }

      for (let i = 0; i < node.namedChildCount; i++) {
        visit(node.namedChild(i));
      }
    };

    visit(root);
  }

  /**
   * `let <name> = <expr>` where <expr> is a `.grouped(...)` chain rooted at a known
   * builder. Resolves the new builder's prefix (parent prefix + any string path
   * segment passed to `.grouped("seg")`) and auth (parent auth OR any middleware
   * arg that classifies as authentication).
   */
  private handleGroupBinding(node: any, builders: Map<string, Builder>): void {
    const nameNode = this.childOfType(node, 'pattern');
    const name = nameNode ? this.firstIdentifier(nameNode) : undefined;
    const valueCall = this.childOfType(node, 'call_expression');
    if (!name || !valueCall) return;

    const resolved = this.resolveGroupChain(valueCall, builders);
    if (resolved) builders.set(name, resolved);
  }

  /**
   * Resolve a `.grouped(...)` chain expression (e.g.
   * `app.grouped("v1").grouped(Token.authenticator())`) to a Builder. Returns null
   * if the chain is not rooted at a known builder.
   */
  private resolveGroupChain(callExpr: any, builders: Map<string, Builder>): Builder | null {
    // Collect the chain of (method, args) suffixes from outermost call inward, plus
    // the root receiver identifier.
    const chain: Array<{ method: string; callNode: any }> = [];
    let current: any = callExpr;
    let rootReceiver: string | undefined;

    while (current && current.type === 'call_expression') {
      const nav = this.childOfType(current, 'navigation_expression');
      if (!nav) break;
      const method = this.navigationMethod(nav);
      chain.push({ method: method || '', callNode: current });
      // Descend into the navigation's own object: either a nested call_expression
      // (another link in the chain) or a simple_identifier (the root receiver).
      const inner = nav.namedChild(0);
      if (inner && inner.type === 'call_expression') {
        current = inner;
      } else {
        rootReceiver = inner ? this.nodeText(inner).trim() : undefined;
        current = null;
      }
    }

    if (!rootReceiver) return null;
    const base = builders.get(rootReceiver);
    if (!base) return null;

    // Apply chain links outermost-last: reverse so we fold from the root outward.
    let prefix = [...base.prefix];
    let authed = base.authed;
    for (const link of chain.reverse()) {
      if (link.method !== 'grouped') continue;
      const args = this.callArguments(link.callNode);
      for (const arg of args) {
        const seg = this.stringLiteralValue(arg);
        if (seg !== null) {
          for (const part of seg.split('/').filter(Boolean)) prefix.push(part);
        } else if (this.argIsAuthMiddleware(arg)) {
          authed = true;
        }
      }
    }
    return { prefix, authed };
  }

  /**
   * Parse a `<builder>.<method>(<path...>, use: handler)` route registration.
   * Returns null if it's not an HTTP route call on a known builder.
   */
  private parseRouteCall(
    callExpr: any,
    builders: Map<string, Builder>
  ): { method: string; fullPath: string; handler: string; authed: boolean; line: number } | null {
    const nav = this.childOfType(callExpr, 'navigation_expression');
    if (!nav) return null;
    const method = this.navigationMethod(nav);
    if (!method) return null;

    // Receiver must be a known builder (a simple_identifier, not a nested call —
    // `app.grouped("x").get(...)` inline chains are rare in Vapor; groups are bound
    // to vars first. We still resolve a direct `app.<method>` receiver).
    const receiverNode = nav.namedChild(0);
    if (!receiverNode || receiverNode.type !== 'simple_identifier') return null;
    const receiver = this.nodeText(receiverNode).trim();
    const builder = builders.get(receiver);
    if (!builder) return null;

    const args = this.callArguments(callExpr);

    // `.on(.GET, "path", use:)` — explicit-method form. Method is the first arg's
    // member access (.GET); the path follows.
    let httpMethod: string | undefined;
    let argStart = 0;
    if (method === 'on') {
      const verb = this.memberAccessName(args[0]);
      if (!verb) return null;
      httpMethod = verb.toUpperCase();
      argStart = 1;
    } else if (HTTP_METHODS.has(method)) {
      httpMethod = method.toUpperCase();
    } else {
      return null;
    }

    // Path segments: string-literal args (excluding the `use:` labelled handler).
    const segments: string[] = [];
    let handler: string | undefined;
    for (let i = argStart; i < args.length; i++) {
      const arg = args[i];
      if (this.argumentLabel(arg) === 'use') {
        handler = this.useHandlerName(arg);
        continue;
      }
      const seg = this.stringLiteralValue(arg);
      if (seg !== null) {
        for (const part of seg.split('/').filter(Boolean)) segments.push(part);
      }
    }

    // No `use:` handler -> trailing-closure handler (inline). Name it anonymously.
    if (!handler) {
      const hasClosure = this.hasTrailingClosure(callExpr);
      handler = hasClosure ? 'closure' : '';
    }
    if (!handler) return null;

    const allSegments = [...builder.prefix, ...segments];
    const fullPath = '/' + allSegments.join('/');
    return {
      method: httpMethod,
      fullPath: fullPath === '/' ? '/' : fullPath.replace(/\/+/g, '/'),
      handler,
      authed: builder.authed,
      line: callExpr.startPosition.row + 1,
    };
  }

  private emitRoute(
    route: { method: string; fullPath: string; handler: string; authed: boolean; line: number },
    relativePath: string,
    entryPoints: CASEntryPoint[]
  ): void {
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
          framework: 'vapor',
          method: route.method,
          path: route.fullPath,
          handler: route.handler,
          controller: undefined,
        },
        { node_id: nodeId, method_name: route.handler, file: relativePath, line: route.line }
      )
    );
  }

  // ---- AST helpers (grounded on tree-sitter-swift) ------------------------------

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

  /** The method name on a navigation_expression's navigation_suffix (`.get` -> get). */
  private navigationMethod(nav: any): string | undefined {
    const suffix = this.childOfType(nav, 'navigation_suffix');
    if (!suffix) return undefined;
    const id = this.childOfType(suffix, 'simple_identifier');
    return id ? this.nodeText(id).trim() : this.nodeText(suffix).replace(/^\./, '').trim();
  }

  /** All `value_argument` nodes under a call_expression's call_suffix > value_arguments. */
  private callArguments(callExpr: any): any[] {
    const suffix = this.childOfType(callExpr, 'call_suffix');
    if (!suffix) return [];
    const valueArgs = this.childOfType(suffix, 'value_arguments');
    if (!valueArgs) return [];
    const out: any[] = [];
    for (let i = 0; i < valueArgs.namedChildCount; i++) {
      const c = valueArgs.namedChild(i);
      if (c.type === 'value_argument') out.push(c);
    }
    return out;
  }

  /** True if the call_expression carries a trailing closure (lambda_literal). */
  private hasTrailingClosure(callExpr: any): boolean {
    const suffix = this.childOfType(callExpr, 'call_suffix');
    if (suffix && this.childOfType(suffix, 'lambda_literal')) return true;
    // Some grammars attach the lambda as a child of call_suffix; also check direct.
    return Boolean(this.childOfType(callExpr, 'lambda_literal'));
  }

  /** The label of a value_argument (`use: x` -> "use"), or undefined. */
  private argumentLabel(arg: any): string | undefined {
    const label = this.childOfType(arg, 'value_argument_label');
    if (!label) return undefined;
    const id = this.childOfType(label, 'simple_identifier');
    return id ? this.nodeText(id).trim() : this.nodeText(label).trim();
  }

  /** The clean text of a string-literal argument (no quotes), or null. */
  private stringLiteralValue(arg: any): string | null {
    const lit = this.childOfType(arg, 'line_string_literal');
    if (!lit) return null;
    const text = this.childOfType(lit, 'line_str_text');
    if (text) return this.nodeText(text);
    // Empty string literal "" has no line_str_text child.
    return this.nodeText(lit).replace(/^"|"$/g, '');
  }

  /** For `.on(.GET, ...)`: the member name of a `.GET` prefix_expression. */
  private memberAccessName(arg: any): string | undefined {
    if (!arg) return undefined;
    const prefix = this.childOfType(arg, 'prefix_expression');
    if (prefix) {
      const id = this.childOfType(prefix, 'simple_identifier');
      if (id) return this.nodeText(id).trim();
    }
    return undefined;
  }

  /** The handler identifier in a `use: handler` argument. */
  private useHandlerName(arg: any): string | undefined {
    // value_argument children: value_argument_label("use"), simple_identifier(handler)
    // or navigation_expression (e.g. Controller.handler).
    for (let i = 0; i < arg.namedChildCount; i++) {
      const c = arg.namedChild(i);
      if (c.type === 'value_argument_label') continue;
      if (c.type === 'simple_identifier') return this.nodeText(c).trim();
      if (c.type === 'navigation_expression') {
        // `Controller.method` -> use the trailing member as handler name.
        const m = this.navigationMethod(c);
        if (m) return m;
        return this.nodeText(c).trim();
      }
    }
    return undefined;
  }

  /** First simple_identifier text under a node (e.g. a pattern's bound name). */
  private firstIdentifier(node: any): string | undefined {
    if (node.type === 'simple_identifier') return this.nodeText(node).trim();
    for (let i = 0; i < node.namedChildCount; i++) {
      const found = this.firstIdentifier(node.namedChild(i));
      if (found) return found;
    }
    return undefined;
  }

  /** True when a `.grouped(...)` middleware argument is an authentication middleware. */
  private argIsAuthMiddleware(arg: any): boolean {
    const text = this.nodeText(arg);
    // e.g. `UserAuthenticator()`, `Token.authenticator()`, `User.guardMiddleware()`,
    // `app.sessions.middleware`, `JWTBearerAuthenticator()`.
    if (isAuthenticationGuardName(text)) return true;
    if (/authenticat|guardmiddleware|bearer|\.sessions\b|basicauth/i.test(text)) return true;
    return false;
  }

  private async findSwiftFiles(projectPath: string): Promise<string[]> {
    const files = await glob('**/*.swift', {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath } as AnalysisContext),
      nodir: true,
    });
    return files.map(file => path.join(projectPath, file));
  }
}
