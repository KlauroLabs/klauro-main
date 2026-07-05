import { AnalysisContext, BaseAnalyzer } from '../../core/base-analyzer';
import { CASContribution, CASEntryPoint, CASNode, CASEdge } from '../../../types/cas.types';
import { parseWasm } from '../../core/wasm-tree-sitter';
import * as fs from 'fs-extra';
import * as path from 'path';
import { glob } from 'glob';

/**
 * Shelf / shelf_router (Dart server) framework analyzer.
 *
 * shelf_router builds a route table by calling HTTP-verb methods on a `Router`
 * instance, either as a cascade or as ordinary statements:
 *
 *   final router = Router()
 *     ..get('/users', _listUsers)
 *     ..get('/users/<id>', _getUser)
 *     ..post('/users', _createUser);
 *
 *   // or:
 *   final router = Router();
 *   router.get('/health', _health);
 *   router.mount('/api/', apiRouter.call);   // sub-router mount (prefix)
 *
 * AST grounding (real tree-sitter-dart):
 *  - `Router()` construction: `identifier "Router"` followed by a sibling
 *    `selector > argument_part > arguments` (empty).
 *  - Cascade calls (`..get(...)`) appear as `cascade_section` nodes hanging off
 *    the `initialized_variable_definition` that declared the router, each with a
 *    `cascade_selector > identifier` (method name) and an `argument_part >
 *    arguments` with the path (string_literal) then handler (identifier,
 *    optionally with a `.method` selector for `obj.method` tear-offs).
 *  - Plain statements (`router.get(...)`) appear as `expression_statement`
 *    nodes: `identifier "router"`, `selector(unconditional_assignable_selector
 *    (identifier "get"))`, `selector(argument_part(arguments(...)))`.
 *
 * `mount(prefix, subRouterRef)` contributes a path prefix applied to every route
 * declared on the sub-router; sub-router refs are resolved by variable name
 * within the same file (cross-file mount resolution is a possible future
 * extension, not attempted here — evidence-based scope).
 */

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options']);

interface ShelfRoute {
  method: string;
  path: string;
  handler: string;
  file: string;
  line: number;
}

interface MountCall {
  prefix: string;
  routerVar: string;
}

export class ShelfAnalyzer extends BaseAnalyzer {
  constructor() {
    super('shelf', 'Shelf/shelf_router Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const pubspec = path.join(projectPath, 'pubspec.yaml');
      if (!(await fs.pathExists(pubspec))) return false;
      const content = await fs.readFile(pubspec, 'utf-8');
      if (!/\bshelf(_router)?\s*:/m.test(content) && !/package:shelf(_router)?\//.test(content)) {
        // Fall back to content scan: some pubspecs pin shelf transitively only,
        // so also accept direct `package:shelf_router` imports in source.
        for (const file of await this.findDartFiles(projectPath)) {
          const src = await fs.readFile(file, 'utf-8');
          if (/package:shelf_router\//.test(src) || /package:shelf\//.test(src)) return true;
        }
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];

    try {
      const files = await this.findDartFiles(context.projectPath);
      let routeCount = 0;
      for (const file of files) {
        const content = await fs.readFile(file, 'utf-8');
        if (!/\bRouter\s*\(/.test(content) && !this.hasVerbCall(content)) continue;
        const relativePath = path.relative(context.projectPath, file);
        const routes = await this.extractRoutes(content, relativePath);
        for (const route of routes) {
          this.emitRoute(route, entryPoints);
          routeCount += 1;
        }
      }

      return this.createContribution(nodes, edges, entryPoints, [], {
        framework_specific: {
          framework: 'shelf',
          route_count: routeCount,
        },
      });
    } catch (error) {
      throw new Error(`Shelf analysis failed: ${(error as Error).message}`);
    }
  }

  protected getCapabilities(): string[] {
    return ['route-detection', 'router-mount-prefix-resolution'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'shelf-framework';
      case 2: return 'routers';
      case 3: return 'routes';
      case 4: return 'handlers';
      default: return `shelf-level-${level}`;
    }
  }

  /** Parse one Dart source and collect every verb call reachable from a Router,
   *  resolving `mount()` prefixes against same-file router variables. */
  private async extractRoutes(content: string, relativePath: string): Promise<ShelfRoute[]> {
    const tree = await parseWasm('dart', content);
    const root = tree.rootNode;

    // routerVar -> raw (unprefixed) routes declared directly on it in this file.
    const routesByVar = new Map<string, ShelfRoute[]>();
    // routerVar -> mount() calls made on it (prefix, target sub-router var).
    const mountsByVar = new Map<string, MountCall[]>();
    const routerVarNames = new Set<string>();

    const recordCall = (routerVar: string, method: string, args: any, line: number): void => {
      if (method === 'mount') {
        const prefix = this.firstStringArg(args);
        // The mount target is a sub-router reference, most commonly a tear-off
        // (`subRouter.call`) but the reference itself is the router variable —
        // strip a trailing `.call`/`.<anything>` member access to recover it.
        const targetRaw = this.secondArgHandlerName(args);
        const target = targetRaw?.split('.')[0];
        if (prefix !== undefined && target) {
          const list = mountsByVar.get(routerVar) ?? [];
          list.push({ prefix, routerVar: target });
          mountsByVar.set(routerVar, list);
        }
        return;
      }
      if (!HTTP_METHODS.has(method)) return;
      const routePath = this.firstStringArg(args);
      const handler = this.secondArgHandlerName(args);
      if (routePath === undefined || !handler) return;
      const list = routesByVar.get(routerVar) ?? [];
      list.push({ method: method.toUpperCase(), path: routePath, handler, file: relativePath, line });
      routesByVar.set(routerVar, list);
    };

    // 1) Cascade form: `final router = Router()..get(...)..post(...)`. Inside a
    //    function body this is an `initialized_variable_definition`
    //    (`local_variable_declaration`); at the top level of a file (or as a
    //    class field) it's a `static_final_declaration` instead — same relative
    //    child shape (name identifier, ctor identifier, selector/cascade_section
    //    siblings), different wrapper node type.
    const DECL_TYPES = new Set(['initialized_variable_definition', 'static_final_declaration']);
    const visitCascades = (node: any): void => {
      if (DECL_TYPES.has(node.type)) {
        const namedChildren: any[] = [];
        for (let i = 0; i < node.namedChildCount; i++) namedChildren.push(node.namedChild(i));
        const identifiers = namedChildren.filter(c => c.type === 'identifier');
        const name = identifiers[0];
        // `value:` children: first identifier is the ctor name (e.g. "Router"),
        // remaining are selector/cascade_section siblings.
        const ctorIdx = namedChildren.findIndex(c => c.type === 'identifier' && c.text === 'Router');
        if (name && ctorIdx !== -1 && namedChildren[ctorIdx] !== name) {
          const varName = this.nodeText(name);
          routerVarNames.add(varName);
          for (let i = ctorIdx + 1; i < namedChildren.length; i++) {
            const child = namedChildren[i];
            if (child.type !== 'cascade_section') continue;
            const sel = this.childOfType(child, 'cascade_selector');
            const methodId = sel ? this.childOfType(sel, 'identifier') : undefined;
            const argPart = this.childOfType(child, 'argument_part');
            const args = argPart ? this.childOfType(argPart, 'arguments') : undefined;
            if (methodId && args) {
              recordCall(varName, this.nodeText(methodId), args, child.startPosition.row + 1);
            }
          }
        }
      }
      for (let i = 0; i < node.namedChildCount; i++) visitCascades(node.namedChild(i));
    };
    visitCascades(root);

    // 2) Plain statement form: `router.get('/path', handler);` /
    //    `router.mount('/api/', sub.call);`.
    const visitStatements = (node: any): void => {
      if (node.type === 'expression_statement' || node.type === 'return_statement') {
        const children: any[] = [];
        for (let i = 0; i < node.namedChildCount; i++) children.push(node.namedChild(i));
        const recv = children[0];
        if (recv && recv.type === 'identifier' && routerVarNames.has(recv.text)) {
          const methodSel = children[1];
          const argsSel = children[2];
          if (methodSel && methodSel.type === 'selector' && argsSel && argsSel.type === 'selector') {
            const assignable = this.childOfType(methodSel, 'unconditional_assignable_selector');
            const methodId = assignable ? this.childOfType(assignable, 'identifier') : undefined;
            const argPart = this.childOfType(argsSel, 'argument_part');
            const args = argPart ? this.childOfType(argPart, 'arguments') : undefined;
            if (methodId && args) {
              recordCall(recv.text, this.nodeText(methodId), args, node.startPosition.row + 1);
            }
          }
        }
      }
      for (let i = 0; i < node.namedChildCount; i++) visitStatements(node.namedChild(i));
    };
    visitStatements(root);

    // Resolve mount() prefixes: for each router var with mounts, prepend the
    // mount prefix to every route declared on the mounted sub-router var. Only
    // walk from "root" vars — those never targeted by another var's mount() —
    // so a sub-router mounted under a prefix contributes routes ONLY at that
    // prefix, not also unprefixed at its own declaration site.
    const mountedTargets = new Set<string>();
    for (const mounts of mountsByVar.values()) {
      for (const mount of mounts) mountedTargets.add(mount.routerVar);
    }
    const resolved: ShelfRoute[] = [];
    const emittedVars = new Set<string>();
    const emitVar = (varName: string, prefix: string): void => {
      const key = `${varName}@${prefix}`;
      if (emittedVars.has(key)) return;
      emittedVars.add(key);
      for (const route of routesByVar.get(varName) ?? []) {
        resolved.push({ ...route, path: this.joinPrefix(prefix, route.path) });
      }
      for (const mount of mountsByVar.get(varName) ?? []) {
        emitVar(mount.routerVar, this.joinPrefix(prefix, mount.prefix));
      }
    };
    for (const varName of routerVarNames) {
      if (!mountedTargets.has(varName)) emitVar(varName, '');
    }

    return resolved;
  }

  private emitRoute(route: ShelfRoute, entryPoints: CASEntryPoint[]): void {
    const nodeId = `function:${route.file}:${route.handler}`;
    entryPoints.push(
      this.createEntryPoint(
        `entry:http:${route.file}:${route.handler}:${route.method}:${route.path}:${route.line}`,
        nodeId,
        'http',
        `${route.method} ${route.path}`,
        `Shelf route handled by ${route.handler}`,
        { method: route.method, path: route.path },
        undefined,
        {
          framework: 'shelf',
          method: route.method,
          path: route.path,
          handler: route.handler,
        },
        { node_id: nodeId, method_name: route.handler, file: route.file, line: route.line }
      )
    );
  }

  private joinPrefix(prefix: string, routePath: string): string {
    const p = prefix.replace(/\/+$/, '');
    const r = routePath.startsWith('/') ? routePath : `/${routePath}`;
    const joined = `${p}${r}`.replace(/\/+/g, '/');
    return joined === '' ? '/' : joined;
  }

  /** First positional string_literal argument (the route path / mount prefix). */
  private firstStringArg(args: any): string | undefined {
    for (let i = 0; i < args.namedChildCount; i++) {
      const arg = args.namedChild(i);
      const val = arg.type === 'argument' ? arg.namedChild(0) : arg;
      if (val && val.type === 'string_literal') return this.stripQuotes(this.nodeText(val));
    }
    return undefined;
  }

  /** Second positional argument's handler identifier name (a bare function ref
   *  `_handler`, or a `obj.method` tear-off — reported as `obj.method`). */
  private secondArgHandlerName(args: any): string | undefined {
    const positional: any[] = [];
    for (let i = 0; i < args.namedChildCount; i++) {
      const arg = args.namedChild(i);
      const val = arg.type === 'argument' ? arg.namedChild(0) : arg;
      if (val && val.type !== 'string_literal') positional.push(val);
    }
    const handlerNode = positional[0];
    if (!handlerNode) return undefined;
    if (handlerNode.type === 'identifier') {
      const sel = this.childOfType(handlerNode, 'selector') ?? handlerNode.nextNamedSibling;
      // Tear-off form `sub.call` inside the same argument node: identifier +
      // sibling selector(unconditional_assignable_selector(identifier)).
      if (sel && sel.type === 'selector') {
        const assignable = this.childOfType(sel, 'unconditional_assignable_selector');
        const member = assignable ? this.childOfType(assignable, 'identifier') : undefined;
        if (member) return `${this.nodeText(handlerNode)}.${this.nodeText(member)}`;
      }
      return this.nodeText(handlerNode);
    }
    return undefined;
  }

  private stripQuotes(s: string): string {
    return s.replace(/^r?['"]|['"]$/g, '');
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

  /** Cheap pre-filter: does this file plausibly contain a shelf verb call? */
  private hasVerbCall(content: string): boolean {
    return /\.(get|post|put|delete|patch|head|options|mount)\s*\(/.test(content);
  }
}
