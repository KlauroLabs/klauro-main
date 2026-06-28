import { AnalysisContext, BaseAnalyzer } from '../../core/base-analyzer';
import { CASContribution, CASEntryPoint, CASNode, CASEdge } from '../../../types/cas.types';
import { parseWasm } from '../../core/wasm-tree-sitter';
import * as fs from 'fs-extra';
import * as path from 'path';
import { glob } from 'glob';

/**
 * http4s (Scala FP HTTP library) framework analyzer.
 *
 * http4s declares routes with a pattern-matching DSL on `HttpRoutes.of[IO] { ... }`:
 *
 *   val routes = HttpRoutes.of[IO] {
 *     case GET    -> Root / "users"               => Ok(...)   // GET /users
 *     case GET    -> Root / "users" / IntVar(id)  => Ok(...)   // GET /users/:id
 *     case POST   -> Root / "login"               => Ok(...)   // POST /login
 *     case DELETE -> Root / "users" / IntVar(id)  => Ok(...)   // DELETE /users/:id
 *   }
 *
 * Each `case METHOD -> Root / seg / seg ...` clause is one route. The method is the
 * leftmost identifier (GET/POST/PUT/DELETE/PATCH/HEAD/OPTIONS); the path is `Root`
 * followed by `/ "literal"` (a string segment -> /literal) and `/ IntVar(id)` /
 * `/ LongVar(x)` / `/ UUIDVar(x)` extractors or a bound var -> a `:name` path param
 * (the bound variable name is used: `IntVar(id)` -> `:id`).
 *
 * Auth: http4s protects routes by wrapping them in `AuthMiddleware` / `AuthedRoutes`.
 * Routes inside an `AuthedRoutes.of[User, IO] { ... }` block (the val is typed
 * `AuthedRoutes[..]` and/or built with `AuthedRoutes.of`, and each clause ends with
 * `... as user`) are authenticated. We mark a route auth:true when its enclosing
 * builder/val is an AuthedRoutes (honest, structural signal); plain `HttpRoutes.of`
 * routes are auth:false.
 *
 * Node types grounded on the real tree-sitter-scala grammar (see artifact):
 *   val_definition
 *     identifier            // val name
 *     generic_type          // declared type:  HttpRoutes[IO] / AuthedRoutes[User, IO]
 *       type_identifier
 *     ERROR                 // the `HttpRoutes.of[IO]` head parses as an ERROR node
 *       generic_function > field_expression(identifier "HttpRoutes", identifier "of")
 *     case_block
 *       case_clause
 *         infix_pattern     // the route pattern (nested; see parsePattern)
 *           ... identifier "GET" / operator_identifier "->" / identifier "Root"
 *           ... operator_identifier "/" + string | case_class_pattern(IntVar, id)
 *           ... identifier "as" identifier "user"   (AuthedRoutes only)
 */

const HTTP_METHODS = new Set([
  'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS',
]);

interface Http4sRoute {
  method: string;
  fullPath: string;
  authed: boolean;
  line: number;
}

export class Http4sAnalyzer extends BaseAnalyzer {
  constructor() {
    super('http4s', 'http4s Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      // Manifest signal: build.sbt depending on http4s.
      const sbt = path.join(projectPath, 'build.sbt');
      if (await fs.pathExists(sbt)) {
        const content = await fs.readFile(sbt, 'utf-8');
        if (/http4s/i.test(content)) return true;
      }
      // Source signal: http4s imports / DSL usage in any .scala file.
      for (const file of await this.findScalaFiles(projectPath)) {
        const content = await fs.readFile(file, 'utf-8');
        if (/org\.http4s|HttpRoutes\.of|AuthedRoutes\.of/.test(content)) return true;
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
      const files = await this.findScalaFiles(context.projectPath);
      for (const file of files) {
        const content = await fs.readFile(file, 'utf-8');
        if (!/HttpRoutes\.of|AuthedRoutes\.of|org\.http4s/.test(content)) continue;
        const relativePath = path.relative(context.projectPath, file);
        await this.extractRoutes(content, relativePath, entryPoints);
      }

      return this.createContribution(nodes, edges, entryPoints, [], {
        framework_specific: {
          framework: 'http4s',
          route_count: entryPoints.filter(ep => ep.metadata?.framework === 'http4s').length,
          authenticated_route_count: entryPoints.filter(
            ep => ep.metadata?.framework === 'http4s' && ep.security?.authenticated
          ).length,
        },
      });
    } catch (error) {
      throw new Error(`http4s analysis failed: ${(error as Error).message}`);
    }
  }

  protected getCapabilities(): string[] {
    return ['route-detection', 'path-param-extraction', 'authed-routes-detection'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'http4s-framework';
      case 2: return 'routes-blocks';
      case 3: return 'route-clauses';
      case 4: return 'auth-middleware';
      default: return `http4s-level-${level}`;
    }
  }

  /**
   * Parse one Scala source and emit an http entry point per http4s route clause.
   *
   * We walk to every `case_block`, decide whether the block's enclosing `val_definition`
   * (or builder head) is an AuthedRoutes (-> authed), then parse each `case_clause`'s
   * left-hand pattern into a method + path.
   */
  private async extractRoutes(content: string, relativePath: string, entryPoints: CASEntryPoint[]): Promise<void> {
    const tree = await parseWasm('scala', content);
    const root = tree.rootNode;

    const seen = new Set<string>();

    const visit = (node: any): void => {
      if (!node) return;

      if (node.type === 'case_block') {
        const authed = this.blockIsAuthed(node);
        for (let i = 0; i < node.namedChildCount; i++) {
          const clause = node.namedChild(i);
          if (clause.type !== 'case_clause') continue;
          const route = this.parseCaseClause(clause, authed);
          if (!route) continue;
          const dedupe = `${route.method}:${route.fullPath}`;
          if (seen.has(dedupe)) continue;
          seen.add(dedupe);
          this.emitRoute(route, relativePath, entryPoints);
        }
      }

      for (let i = 0; i < node.namedChildCount; i++) {
        visit(node.namedChild(i));
      }
    };

    visit(root);
  }

  /**
   * A case_block sits inside a val_definition whose declared type and builder head
   * tell us whether these routes are authenticated. We climb to the nearest
   * val_definition / function and inspect its text for AuthedRoutes. We also treat any
   * per-clause `as <user>` binding as an auth signal at parse time.
   */
  private blockIsAuthed(caseBlock: any): boolean {
    let cur = caseBlock.parent;
    let depth = 0;
    while (cur && depth < 6) {
      if (cur.type === 'val_definition' || cur.type === 'var_definition' ||
          cur.type === 'function_definition' || cur.type === 'call_expression') {
        // Inspect only the head of the definition (type ascription + builder), not the
        // whole body, by scanning siblings of the case_block within this definition.
        if (this.definitionUsesAuthedRoutes(cur, caseBlock)) return true;
        // val/function are the natural binding scope; stop after the first one.
        if (cur.type === 'val_definition' || cur.type === 'var_definition' ||
            cur.type === 'function_definition') {
          return false;
        }
      }
      cur = cur.parent;
      depth++;
    }
    return false;
  }

  /** True if the definition's declared type or builder uses AuthedRoutes (not the body). */
  private definitionUsesAuthedRoutes(def: any, caseBlock: any): boolean {
    for (let i = 0; i < def.namedChildCount; i++) {
      const child = def.namedChild(i);
      if (child.id === caseBlock.id) continue;        // skip the routes body itself
      if (child.type === 'case_block') continue;
      const text = this.nodeText(child);
      if (/AuthedRoutes/.test(text)) return true;
    }
    return false;
  }

  /**
   * Parse one `case METHOD -> Root / seg / seg ... (as user)? => body` clause.
   * The clause's first named child is the pattern (a nested infix_pattern).
   */
  private parseCaseClause(clause: any, blockAuthed: boolean): Http4sRoute | null {
    const pattern = clause.namedChild(0);
    if (!pattern) return null;

    const collected = { method: undefined as string | undefined, segments: [] as string[], authed: blockAuthed };
    this.collectPattern(pattern, collected);

    if (!collected.method || !HTTP_METHODS.has(collected.method)) return null;

    const fullPath = collected.segments.length ? '/' + collected.segments.join('/') : '/';
    return {
      method: collected.method,
      fullPath,
      authed: collected.authed,
      line: clause.startPosition.row + 1,
    };
  }

  /**
   * Recursively flatten the nested infix_pattern that encodes `METHOD -> Root / a / b`.
   *
   * Shape (left-associative, so deepest = leftmost):
   *   infix_pattern( infix_pattern( infix_pattern( id"GET" "->" id"Root" ) "/" str"users" ) "/" case_class_pattern )
   *
   * We do an in-order walk: descend the left operand first, then read the operator +
   * right operand. The leftmost `identifier` is the method; `Root` is dropped; each
   * `/`-joined right operand is a path segment.
   */
  private collectPattern(node: any, out: { method?: string; segments: string[]; authed: boolean }): void {
    if (!node) return;

    if (node.type === 'infix_pattern') {
      // infix_pattern children (named): left, operator_identifier, right
      const left = node.namedChild(0);
      const op = this.childOfType(node, 'operator_identifier');
      const opText = op ? this.nodeText(op).trim() : '';
      // right operand = last named child (after operator).
      const right = node.namedChild(node.namedChildCount - 1);

      this.collectPattern(left, out);

      if (opText === '->') {
        // left was the METHOD identifier (captured below as identifier), right is Root.
        // Root is just the path origin; nothing to add.
        return;
      }
      if (opText === '/') {
        this.appendSegment(right, out);
        return;
      }
      // `as` (AuthedRoutes binder) or other infix: the right side is a binder, not a path.
      if (this.nodeText(op || node).includes('as') || (op == null && this.hasAsBinder(node))) {
        out.authed = true;
        return;
      }
      // Unknown operator: still recurse right defensively but don't treat as segment.
      return;
    }

    if (node.type === 'identifier') {
      const text = this.nodeText(node).trim();
      if (HTTP_METHODS.has(text)) {
        out.method = text;
      }
      // `Root` and other bare identifiers are ignored.
      return;
    }

    // Any other leaf at the head position: nothing.
  }

  /** True when an infix_pattern uses the `as` binder (AuthedRoutes `... as user`). */
  private hasAsBinder(node: any): boolean {
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c.type === 'identifier' && this.nodeText(c).trim() === 'as') return true;
    }
    return false;
  }

  /**
   * Append one path segment from a `/ <right>` operand:
   *  - string literal "users"          -> users
   *  - case_class_pattern IntVar(id)    -> :id   (the bound var name)
   *  - identifier  IntVar / a bound var -> :<name>
   */
  private appendSegment(right: any, out: { segments: string[] }): void {
    if (!right) return;

    if (right.type === 'string') {
      const v = this.stringValue(right);
      for (const part of v.split('/').filter(Boolean)) out.segments.push(part);
      return;
    }

    if (right.type === 'case_class_pattern') {
      // type_identifier (IntVar/LongVar/UUIDVar/...) + identifier(s) (bound var name).
      const boundVar = this.lastIdentifier(right);
      out.segments.push(':' + (boundVar || this.varExtractorName(right)));
      return;
    }

    if (right.type === 'identifier' || right.type === 'capture_pattern' || right.type === 'typed_pattern') {
      // a bound var pattern in path position -> :<name>
      const name = this.lastIdentifier(right);
      if (name) out.segments.push(':' + name);
      return;
    }

    // Fallback: any other extractor -> :param
    const name = this.lastIdentifier(right);
    out.segments.push(':' + (name || 'param'));
  }

  private emitRoute(route: Http4sRoute, relativePath: string, entryPoints: CASEntryPoint[]): void {
    const handler = `${route.method.toLowerCase()}_${route.fullPath.replace(/[/:]/g, '_').replace(/^_+|_+$/g, '') || 'root'}`;
    const nodeId = `function:${relativePath}:${handler}`;
    entryPoints.push(
      this.createEntryPoint(
        `entry:http:${relativePath}:${handler}:${route.method}:${route.fullPath}`,
        nodeId,
        'http',
        `${route.method} ${route.fullPath}`,
        `HTTP route ${route.method} ${route.fullPath}`,
        { method: route.method, path: route.fullPath },
        { authenticated: route.authed },
        {
          framework: 'http4s',
          method: route.method,
          path: route.fullPath,
          handler,
          controller: undefined,
        },
        { node_id: nodeId, method_name: handler, file: relativePath, line: route.line }
      )
    );
  }

  // ---- AST helpers (grounded on tree-sitter-scala) ------------------------------

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

  /** Clean text of a `string` node (strip quotes / interpolation noise). */
  private stringValue(node: any): string {
    return this.nodeText(node).replace(/^s?"""?|"""?$/g, '').replace(/^"|"$/g, '');
  }

  /** The last `identifier` anywhere under a node (the bound var of an extractor). */
  private lastIdentifier(node: any): string | undefined {
    let found: string | undefined;
    const walk = (n: any): void => {
      if (!n) return;
      if (n.type === 'identifier') found = this.nodeText(n).trim();
      for (let i = 0; i < n.namedChildCount; i++) walk(n.namedChild(i));
    };
    walk(node);
    return found;
  }

  /** The extractor type name lowercased to a param hint (IntVar -> int) when no var bound. */
  private varExtractorName(node: any): string {
    const t = this.childOfType(node, 'type_identifier');
    const name = t ? this.nodeText(t).trim() : 'param';
    return name.replace(/Var$/, '').toLowerCase() || 'param';
  }

  private async findScalaFiles(projectPath: string): Promise<string[]> {
    const files = await glob('**/*.{scala,sc}', {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath } as AnalysisContext),
      nodir: true,
    });
    return files.map(file => path.join(projectPath, file));
  }
}
