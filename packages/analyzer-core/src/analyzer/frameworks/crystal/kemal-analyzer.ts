import { AnalysisContext, BaseAnalyzer } from '../../core/base-analyzer';
import { CASContribution, CASEntryPoint, CASNode, CASEdge } from '../../../types/cas.types';
import { parseWasm } from '../../core/wasm-tree-sitter';
import * as fs from 'fs-extra';
import * as path from 'path';
import { glob } from 'glob';

/**
 * Kemal (Crystal, Sinatra-style web framework) route analyzer.
 *
 * Kemal registers routes with top-level macro calls that take a path string and a
 * block:
 *
 *   get  "/"            do ... end        // GET /
 *   post "/users"       do |env| ... end  // POST /users
 *   put  "/users/:id"   do |env| ... end  // PUT /users/:id
 *   delete "/users/:id" do |env| ... end  // DELETE /users/:id
 *   ws   "/socket"      do |sock| ... end  // websocket (mapped to GET, see below)
 *
 * Crystal/Kemal already uses Sinatra-style `:id` path params, so paths are emitted
 * verbatim (no rewriting).
 *
 * AUTH — honest limitation: Kemal applies cross-cutting auth via `before_all` /
 * middleware (`add_handler ...`), which is NOT attributable to an individual route
 * by static structure. There is no per-route guard in idiomatic Kemal. We therefore
 * emit `auth:false` for every route unless a clear per-route guard is present (none
 * exists in the macro form), and document the limitation rather than guessing.
 *
 * `ws "/path"` (websocket) is mapped to a GET route, because a websocket upgrade is
 * served over an HTTP GET and that is how Kemal mounts it. This keeps it in the HTTP
 * route table; the metadata records the original `ws` macro.
 *
 * Node types grounded on the real vendored tree-sitter-crystal grammar:
 *   expressions                       # file root
 *     call                            # the macro invocation `get "/" do ... end`
 *       identifier        "get"       # method macro name (first named child)
 *       argument_list                 # the args `( "/" )`
 *         string                      # the path literal
 *           literal_content "/"       #   CLEAN path text (empty "" has no child)
 *       block                         # the `do ... end` handler body
 * `Kemal.run` parses as a call whose first child is a `constant` (not `identifier`),
 * and `before_all do ... end` is a call with an `identifier` but NO `argument_list`,
 * so both are naturally excluded by requiring identifier-head + a string path arg.
 */

// Kemal route macros. `ws` is handled specially (mapped to GET).
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);

interface KemalRoute {
  method: string;
  fullPath: string;
  handler: string;
  macro: string; // original macro name (get/post/.../ws)
  line: number;
}

export class KemalAnalyzer extends BaseAnalyzer {
  constructor() {
    super('kemal', 'Kemal Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      // Manifest signal: shard.yml depending on kemal.
      const shard = path.join(projectPath, 'shard.yml');
      if (await fs.pathExists(shard)) {
        const content = await fs.readFile(shard, 'utf-8');
        if (/\bkemal\b/i.test(content)) return true;
      }
      // Source signal: `require "kemal"` in any .cr file.
      for (const file of await this.findCrystalFiles(projectPath)) {
        const content = await fs.readFile(file, 'utf-8');
        if (/require\s+"kemal"/.test(content)) return true;
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
      const files = await this.findCrystalFiles(context.projectPath);
      for (const file of files) {
        const content = await fs.readFile(file, 'utf-8');
        if (!/require\s+"kemal"/.test(content) &&
            !/^\s*(get|post|put|patch|delete|options|head|ws)\s+"/m.test(content)) {
          continue;
        }
        const relativePath = path.relative(context.projectPath, file);
        await this.extractRoutes(content, relativePath, entryPoints);
      }

      return this.createContribution(nodes, edges, entryPoints, [], {
        framework_specific: {
          framework: 'kemal',
          route_count: entryPoints.filter(ep => ep.metadata?.framework === 'kemal').length,
          authenticated_route_count: entryPoints.filter(
            ep => ep.metadata?.framework === 'kemal' && ep.security?.authenticated
          ).length,
        },
      });
    } catch (error) {
      throw new Error(`Kemal analysis failed: ${(error as Error).message}`);
    }
  }

  protected getCapabilities(): string[] {
    return ['route-detection', 'websocket-route-detection'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'kemal-framework';
      case 2: return 'route-macros';
      case 3: return 'handlers';
      default: return `kemal-level-${level}`;
    }
  }

  /**
   * Parse one Crystal source and emit an http entry point per Kemal route macro.
   *
   * Walk every `call`; a route macro is a `call` whose first named child is an
   * `identifier` naming an HTTP method (or `ws`) and that carries an `argument_list`
   * with a leading string path literal. `before_all` (no arg list) and `Kemal.run`
   * (constant receiver) are excluded by construction.
   */
  private async extractRoutes(content: string, relativePath: string, entryPoints: CASEntryPoint[]): Promise<void> {
    const tree = await parseWasm('crystal', content);
    const root = tree.rootNode;

    const seen = new Set<string>();

    const visit = (node: any): void => {
      if (!node) return;

      if (node.type === 'call') {
        const route = this.parseRouteCall(node);
        if (route) {
          const dedupe = `${route.method}:${route.fullPath}`;
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

  /** Parse a `<macro> "<path>" do ... end` call into a route, or null. */
  private parseRouteCall(call: any): KemalRoute | null {
    const head = call.namedChild(0);
    if (!head || head.type !== 'identifier') return null;
    const macro = this.nodeText(head).trim();

    const isWs = macro === 'ws';
    if (!HTTP_METHODS.has(macro) && !isWs) return null;

    const argList = this.childOfType(call, 'argument_list');
    if (!argList) return null;

    const pathArg = argList.namedChild(0);
    if (!pathArg || pathArg.type !== 'string') return null;
    const rawPath = this.stringLiteralValue(pathArg);
    if (rawPath === null) return null;

    // A route must carry a `do ... end` block handler.
    if (!this.childOfType(call, 'block')) return null;

    const fullPath = this.normalizePath(rawPath);
    const method = isWs ? 'GET' : macro.toUpperCase();
    const handler = this.handlerName(macro, fullPath);

    return {
      method,
      fullPath,
      handler,
      macro,
      line: call.startPosition.row + 1,
    };
  }

  private emitRoute(route: KemalRoute, relativePath: string, entryPoints: CASEntryPoint[]): void {
    const nodeId = `function:${relativePath}:${route.handler}`;
    entryPoints.push(
      this.createEntryPoint(
        `entry:http:${relativePath}:${route.handler}:${route.method}:${route.fullPath}`,
        nodeId,
        'http',
        `${route.method} ${route.fullPath}`,
        `HTTP route ${route.method} ${route.fullPath} (Kemal ${route.macro} macro)`,
        { method: route.method, path: route.fullPath },
        // Honest: Kemal auth is cross-cutting (before_all/middleware), not per-route.
        { authenticated: false },
        {
          framework: 'kemal',
          method: route.method,
          path: route.fullPath,
          handler: route.handler,
          controller: undefined,
          macro: route.macro,
          websocket: route.macro === 'ws' || undefined,
        },
        { node_id: nodeId, method_name: route.handler, file: relativePath, line: route.line }
      )
    );
  }

  // ---- AST helpers (grounded on vendored tree-sitter-crystal) --------------------

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

  /** Clean text of a `string` node via its `literal_content` child (empty "" -> ''). */
  private stringLiteralValue(node: any): string | null {
    if (node.type !== 'string') return null;
    const content = this.childOfType(node, 'literal_content');
    if (content) return this.nodeText(content);
    // Empty string literal "" has no literal_content child.
    return this.nodeText(node).replace(/^"|"$/g, '');
  }

  /** Normalize a Kemal path: ensure a single leading slash, collapse duplicate slashes. */
  private normalizePath(raw: string): string {
    let p = raw.trim();
    if (!p.startsWith('/')) p = '/' + p;
    p = p.replace(/\/+/g, '/');
    if (p.length > 1) p = p.replace(/\/$/, '');
    return p;
  }

  /** Stable handler name derived from method + path (Kemal handlers are anonymous blocks). */
  private handlerName(macro: string, fullPath: string): string {
    const slug = fullPath.replace(/[/:]/g, '_').replace(/^_+|_+$/g, '') || 'root';
    return `${macro}_${slug}`;
  }

  private async findCrystalFiles(projectPath: string): Promise<string[]> {
    const files = await glob('**/*.cr', {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath } as AnalysisContext),
      nodir: true,
    });
    return files.map(file => path.join(projectPath, file));
  }
}
