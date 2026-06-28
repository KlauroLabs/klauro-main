import { AnalysisContext, BaseAnalyzer } from '../../core/base-analyzer';
import { CASContribution, CASEntryPoint, CASNode, CASEdge } from '../../../types/cas.types';
import { parseWasm } from '../../core/wasm-tree-sitter';
import * as fs from 'fs-extra';
import * as path from 'path';
import { glob } from 'glob';

/**
 * GoRouter (Flutter) framework analyzer.
 *
 * GoRouter declares navigation as a route tree on the router instance:
 *
 *   final router = GoRouter(
 *     redirect: (context, state) { if (!loggedIn) return '/login'; return null; },
 *     routes: [
 *       GoRoute(path: '/', builder: ...),
 *       GoRoute(path: '/users/:id', builder: ..., routes: [
 *         GoRoute(path: 'edit', builder: ...),          // -> /users/:id/edit
 *       ]),
 *       ShellRoute(builder: ..., routes: [
 *         GoRoute(path: '/dashboard', builder: ...),
 *       ]),
 *     ],
 *   );
 *
 * Nested GoRoutes inherit the parent path prefix. A child whose `path` begins with
 * '/' is absolute; otherwise it is appended to the parent's resolved path. GoRouter
 * is GET-style navigation (no HTTP verbs), so every GoRoute is emitted as method
 * 'GET' with its fully resolved path.
 *
 * Auth: GoRouter guards with a top-level `redirect:` callback. When such a redirect
 * references auth/login (e.g. returns '/login' for unauthenticated users), the
 * routes it governs are protected. We mark routes auth:true only when the router has
 * a redirect that classifies as an auth guard AND the route itself is not the public
 * login/auth target. This is best-effort and honest: with no detectable auth-redirect
 * every route is auth:false.
 *
 * AST grounding (real tree-sitter-dart): a constructor call `Foo(args)` appears as
 * two adjacent named siblings: `identifier "Foo"` then `selector > argument_part >
 * arguments`. Named args are `named_argument(label(identifier "name"), <value>)`.
 * String literals keep their surrounding quotes and have no named children. List
 * values are `list_literal` whose children are the flattened identifier/selector
 * pairs of each constructor element.
 */

/** Constructor names that contribute a path segment (a real GoRoute). */
const ROUTE_CTORS = new Set(['GoRoute']);
/** Container route constructors that hold nested routes but contribute no path. */
const SHELL_CTORS = new Set(['ShellRoute', 'StatefulShellRoute', 'StatefulShellBranch']);

interface RouteCtx {
  parentPath: string; // resolved parent path (no trailing slash, '' at root)
  authed: boolean;    // governed by an auth redirect
}

export class GoRouterAnalyzer extends BaseAnalyzer {
  constructor() {
    super('gorouter', 'GoRouter Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const pubspec = path.join(projectPath, 'pubspec.yaml');
      if (await fs.pathExists(pubspec)) {
        const content = await fs.readFile(pubspec, 'utf-8');
        if (/\bgo_router\b/i.test(content)) return true;
      }
      for (const file of await this.findDartFiles(projectPath)) {
        const content = await fs.readFile(file, 'utf-8');
        if (/\bGoRouter\b/.test(content) || /package:go_router/.test(content)) return true;
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
      const files = await this.findDartFiles(context.projectPath);
      for (const file of files) {
        const content = await fs.readFile(file, 'utf-8');
        if (!/\bGoRoute\b/.test(content) && !/\bGoRouter\b/.test(content)) continue;
        const relativePath = path.relative(context.projectPath, file);
        await this.extractRoutes(content, relativePath, entryPoints);
      }

      return this.createContribution(nodes, edges, entryPoints, [], {
        framework_specific: {
          framework: 'gorouter',
          route_count: entryPoints.filter(ep => ep.metadata?.framework === 'gorouter').length,
          authenticated_route_count: entryPoints.filter(
            ep => ep.metadata?.framework === 'gorouter' && ep.security?.authenticated
          ).length,
        },
      });
    } catch (error) {
      throw new Error(`GoRouter analysis failed: ${(error as Error).message}`);
    }
  }

  protected getCapabilities(): string[] {
    return ['route-detection', 'nested-route-prefix-resolution', 'redirect-auth-detection'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'gorouter-framework';
      case 2: return 'route-tree';
      case 3: return 'handlers';
      case 4: return 'redirect-guards';
      default: return `gorouter-level-${level}`;
    }
  }

  /**
   * Parse one Dart source and emit a GET http entry point per GoRoute. We locate
   * each `GoRouter(...)` constructor, decide whether its `redirect:` is an auth
   * guard, then descend its `routes:` list recursively, resolving nested path
   * prefixes.
   */
  private async extractRoutes(content: string, relativePath: string, entryPoints: CASEntryPoint[]): Promise<void> {
    const tree = await parseWasm('dart', content);
    const root = tree.rootNode;
    const seen = new Set<string>();

    // Find each GoRouter(...) constructor (identifier "GoRouter" + sibling selector).
    const routers: Array<{ args: any; authed: boolean }> = [];
    const visit = (node: any): void => {
      if (node.type === 'identifier' && node.text === 'GoRouter') {
        const sel = node.nextNamedSibling;
        if (sel && sel.type === 'selector') {
          const authed = this.routerHasAuthRedirect(sel);
          routers.push({ args: sel, authed });
        }
      }
      for (let i = 0; i < node.namedChildCount; i++) visit(node.namedChild(i));
    };
    visit(root);

    if (routers.length === 0) {
      // No GoRouter wrapper found (routes declared standalone). Walk any top-level
      // GoRoute trees as a best-effort fallback with no auth context.
      const topRoutes = this.collectCtorElements(root, new Set(['GoRoute', ...SHELL_CTORS]));
      for (const el of topRoutes) {
        this.descendRoute(el, { parentPath: '', authed: false }, relativePath, entryPoints, seen);
      }
      return;
    }

    for (const router of routers) {
      const routesList = this.namedArgValue(router.args, 'routes');
      if (!routesList || routesList.type !== 'list_literal') continue;
      for (const el of this.listElements(routesList)) {
        this.descendRoute(el, { parentPath: '', authed: router.authed }, relativePath, entryPoints, seen);
      }
    }
  }

  /**
   * Recursively process one route-tree element. A GoRoute contributes a path
   * segment and (if it has a builder/handler) emits a route; a ShellRoute-family
   * container contributes nothing to the path but passes children through.
   */
  private descendRoute(
    el: { ctor: string; selector: any },
    ctx: RouteCtx,
    relativePath: string,
    entryPoints: CASEntryPoint[],
    seen: Set<string>
  ): void {
    const sel = el.selector;
    if (ROUTE_CTORS.has(el.ctor)) {
      const rawPath = this.stringArg(sel, 'path');
      const resolvedPath = this.resolvePath(ctx.parentPath, rawPath ?? '');
      // A redirect that guards unauthenticated users sends them to /login, so the
      // login/auth route itself stays public even under an authed router.
      const isAuthTarget = /(^|\/)(login|signin|sign-in|auth|register|signup)(\/|$)/i.test(resolvedPath);
      const authed = ctx.authed && !isAuthTarget;

      // Emit only when this GoRoute actually renders something (builder /
      // pageBuilder / redirect). Pure pass-through GoRoutes (only nested routes)
      // contribute their prefix but no endpoint of their own.
      const handler = this.routeHandlerName(sel);
      if (handler) {
        const dedupe = `GET:${resolvedPath}`;
        if (!seen.has(dedupe)) {
          seen.add(dedupe);
          this.emitRoute(
            { method: 'GET', fullPath: resolvedPath, handler, authed, line: sel.startPosition.row + 1 },
            relativePath,
            entryPoints
          );
        }
      }

      // Descend nested routes under the resolved path.
      const nested = this.namedArgValue(sel, 'routes');
      if (nested && nested.type === 'list_literal') {
        for (const child of this.listElements(nested)) {
          this.descendRoute(child, { parentPath: resolvedPath, authed }, relativePath, entryPoints, seen);
        }
      }
    } else if (SHELL_CTORS.has(el.ctor)) {
      // Shell containers keep the parent prefix and auth, passing children through.
      const nested = this.namedArgValue(sel, 'routes');
      if (nested && nested.type === 'list_literal') {
        for (const child of this.listElements(nested)) {
          this.descendRoute(child, ctx, relativePath, entryPoints, seen);
        }
      }
      // StatefulShellRoute uses `branches:` of StatefulShellBranch(routes:).
      const branches = this.namedArgValue(sel, 'branches');
      if (branches && branches.type === 'list_literal') {
        for (const child of this.listElements(branches)) {
          this.descendRoute(child, ctx, relativePath, entryPoints, seen);
        }
      }
    }
  }

  /** Resolve a child `path` against its parent's resolved path. */
  private resolvePath(parentPath: string, rawPath: string): string {
    const child = rawPath.trim();
    if (child.startsWith('/')) {
      // Absolute path. Normalize duplicate slashes; keep root '/'.
      return this.normalize(child);
    }
    // Relative child appended to parent.
    const base = parentPath === '' ? '' : parentPath;
    const joined = base.replace(/\/$/, '') + '/' + child;
    return this.normalize(joined.startsWith('/') ? joined : '/' + joined);
  }

  private normalize(p: string): string {
    const collapsed = p.replace(/\/+/g, '/');
    if (collapsed === '') return '/';
    if (collapsed.length > 1) return collapsed.replace(/\/$/, '');
    return collapsed;
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
        `Navigation route rendered by ${route.handler}`,
        { method: route.method, path: route.fullPath },
        { authenticated: route.authed },
        {
          framework: 'gorouter',
          method: route.method,
          path: route.fullPath,
          handler: route.handler,
          controller: undefined,
        },
        { node_id: nodeId, method_name: route.handler, file: relativePath, line: route.line }
      )
    );
  }

  // ---- AST helpers (grounded on tree-sitter-dart) -------------------------------

  /** Find every `<Ctor>(...)` element directly produced in the tree (identifier +
   *  sibling selector pairs). Used for the no-router fallback. */
  private collectCtorElements(root: any, ctors: Set<string>): Array<{ ctor: string; selector: any }> {
    const out: Array<{ ctor: string; selector: any }> = [];
    const visit = (node: any): void => {
      if (node.type === 'identifier' && ctors.has(node.text)) {
        const sel = node.nextNamedSibling;
        if (sel && sel.type === 'selector') out.push({ ctor: node.text, selector: sel });
      }
      for (let i = 0; i < node.namedChildCount; i++) visit(node.namedChild(i));
    };
    visit(root);
    return out;
  }

  /** Elements of a `list_literal` of constructor calls: pair each `identifier`
   *  with its following `selector` sibling. */
  private listElements(list: any): Array<{ ctor: string; selector: any }> {
    const out: Array<{ ctor: string; selector: any }> = [];
    for (let i = 0; i < list.namedChildCount; i++) {
      const child = list.namedChild(i);
      if (child.type === 'identifier') {
        const sel = child.nextNamedSibling;
        if (sel && sel.type === 'selector') out.push({ ctor: child.text, selector: sel });
      }
    }
    return out;
  }

  /** The `arguments` node inside a `selector > argument_part > arguments`. */
  private argumentsNode(selector: any): any {
    const argPart = this.childOfType(selector, 'argument_part');
    if (!argPart) return undefined;
    return this.childOfType(argPart, 'arguments');
  }

  /** Value node of a named argument by name (e.g. 'path', 'routes', 'redirect'). */
  private namedArgValue(selector: any, name: string): any {
    const args = this.argumentsNode(selector);
    if (!args) return undefined;
    for (let i = 0; i < args.namedChildCount; i++) {
      const arg = args.namedChild(i);
      if (arg.type !== 'named_argument') continue;
      if (this.argLabelName(arg) === name) {
        // Value is the last named child after the label.
        for (let j = arg.namedChildCount - 1; j >= 0; j--) {
          const v = arg.namedChild(j);
          if (v.type !== 'label') return v;
        }
      }
    }
    return undefined;
  }

  /** The name carried by a named_argument's `label` (its identifier child). */
  private argLabelName(arg: any): string | undefined {
    const label = this.childOfType(arg, 'label');
    if (!label) return undefined;
    const id = this.childOfType(label, 'identifier');
    if (id) return this.nodeText(id).trim();
    return this.nodeText(label).replace(/:$/, '').trim();
  }

  /** Clean string value of a named string-literal argument (quotes stripped). */
  private stringArg(selector: any, name: string): string | undefined {
    const val = this.namedArgValue(selector, name);
    if (!val || val.type !== 'string_literal') return undefined;
    return this.stripQuotes(this.nodeText(val));
  }

  /** Handler name for a route: prefer the widget produced by `builder:`/`pageBuilder:`,
   *  else a `redirect:` (pure-redirect route). Returns undefined when neither exists. */
  private routeHandlerName(selector: any): string | undefined {
    for (const key of ['builder', 'pageBuilder']) {
      const val = this.namedArgValue(selector, key);
      if (val) {
        const widget = this.firstConstructorName(val);
        return widget ?? key;
      }
    }
    if (this.namedArgValue(selector, 'redirect')) return 'redirect';
    return undefined;
  }

  /** First constructor/identifier invoked inside a builder body (the rendered widget). */
  private firstConstructorName(node: any): string | undefined {
    let found: string | undefined;
    const visit = (n: any): void => {
      if (found) return;
      // `const Foo()` / `new Foo()` -> const_object_expression/new_expression with a
      // `type_identifier` naming the widget.
      if (n.type === 'const_object_expression' || n.type === 'new_expression') {
        const ti = this.childOfType(n, 'type_identifier');
        if (ti) {
          found = this.nodeText(ti).trim();
          return;
        }
      }
      // A plain `Foo(...)` shows as identifier followed by a selector sibling.
      if (n.type === 'identifier') {
        const sib = n.nextNamedSibling;
        if (sib && sib.type === 'selector' && /^[A-Z]/.test(n.text)) {
          found = n.text;
          return;
        }
      }
      for (let i = 0; i < n.namedChildCount && !found; i++) visit(n.namedChild(i));
    };
    visit(node);
    return found;
  }

  /** True if the GoRouter's `redirect:` references auth/login (an auth guard). */
  private routerHasAuthRedirect(selector: any): boolean {
    const redirect = this.namedArgValue(selector, 'redirect');
    if (!redirect) return false;
    const text = this.nodeText(redirect);
    return /\b(login|signin|auth|isLoggedIn|loggedIn|authenticated|isAuth|currentUser|unauthenticated)\b/i.test(text)
      || /['"]\/(login|signin|auth|sign-in)\b/i.test(text);
  }

  private stripQuotes(s: string): string {
    return s.replace(/^['"]|['"]$/g, '');
  }

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

  private async findDartFiles(projectPath: string): Promise<string[]> {
    const files = await glob('**/*.dart', {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath } as AnalysisContext),
      nodir: true,
    });
    return files.map(file => path.join(projectPath, file));
  }
}
