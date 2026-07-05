import { AnalysisContext, BaseAnalyzer } from '../../core/base-analyzer';
import { CASContribution, CASEntryPoint } from '../../../types/cas.types';
import { RustAnalyzer } from '../../languages/rust-analyzer';
import * as fs from 'fs-extra';
import * as path from 'path';
import { glob } from 'glob';

/**
 * Warp framework analyzer.
 *
 * Warp routes are built as FILTER CHAINS, not method calls with a path string like
 * axum/actix/rocket: `warp::path("users").and(warp::get()).and_then(list_users)` (or
 * `.map(handler)` for a sync handler). There is no single call site carrying both the
 * path and the method — the path comes from one or more `warp::path(...)` /
 * `warp::path!(...)` segments combined with `.and(...)`, the HTTP method from a
 * `warp::get()`/`warp::post()`/etc. filter joined the same way, and the handler from
 * the terminal `.and_then(...)` / `.map(...)` in the chain. This analyzer parses each
 * such filter-chain expression (a `let <var> = ...;` binding or the argument to a
 * `.or(...)`/`warp::serve(...)` call) to recover path + method + handler as a single
 * logical route, mirroring what fastify/axum surface for method+path+handler.
 */
export class WarpAnalyzer extends BaseAnalyzer {
  private rustAnalyzer: RustAnalyzer;

  constructor() {
    super('warp', 'Warp Framework Analyzer', '1.0.0', 'framework');
    this.rustAnalyzer = new RustAnalyzer();
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    if (!(await fs.pathExists(path.join(projectPath, 'Cargo.toml')))) return false;
    try {
      const cargo = await fs.readFile(path.join(projectPath, 'Cargo.toml'), 'utf-8');
      if (!/^\s*warp\s*=/m.test(cargo) && !/^\s*"warp"/m.test(cargo)) return false;
      for (const file of await this.findRustFiles(projectPath)) {
        const content = await fs.readFile(file, 'utf-8');
        if (/\bwarp::path\s*[!(]/.test(content) && /\.and\s*\(/.test(content)) return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const rust = await this.rustAnalyzer.analyze(context);
    const nodes = [...(rust.nodes || [])];
    const edges = [...(rust.edges || [])];
    const entryPoints = [...(rust.entry_points || [])];
    const exitPoints = [...(rust.exit_points || [])];

    try {
      const files = await this.findRustFiles(context.projectPath);
      for (const file of files) {
        const relativePath = path.relative(context.projectPath, file);
        const content = await fs.readFile(file, 'utf-8');
        this.extractWarpRoutes(content, relativePath, entryPoints);
      }

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework_specific: {
          framework: 'warp',
          route_count: entryPoints.filter(ep => ep.metadata?.framework === 'warp').length,
        },
      });
    } catch (error) {
      throw new Error(`Warp analysis failed: ${(error as Error).message}`);
    }
  }

  protected getCapabilities(): string[] {
    return ['filter-chain-route-detection', 'method-filter-resolution', 'handler-resolution'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'warp-framework';
      case 2: return 'filters';
      case 3: return 'handlers';
      default: return `warp-level-${level}`;
    }
  }

  /**
   * Find each top-level filter-chain EXPRESSION in the file — a `let <var> = <expr>;`
   * binding whose RHS references `warp::path`, or a bare statement/return expression
   * doing the same (`app.or(...)` chains, or the terminal expression of a `fn routes()
   * -> impl Filter { ... }`). Each expression is parsed independently for its
   * path segments, method filter, and terminal handler.
   */
  private extractWarpRoutes(content: string, relativePath: string, entryPoints: CASEntryPoint[]): void {
    if (!/\bwarp::path\s*[!(]/.test(content)) return;

    const lineForIndex = this.buildLineIndex(content);
    const seen = new Set<string>();

    // `let <var> = <expr>;` bindings whose RHS mentions warp::path — the common case
    // where each route (or route group) is bound to a name before being `.or()`'d
    // together into the final filter passed to `warp::serve`.
    for (const m of content.matchAll(/\b(?:let\s+(?:mut\s+)?([a-z_][A-Za-z0-9_]*)\s*=\s*)?(warp::path[\s\S]*?);/g)) {
      const exprStart = m.index! + (m[1] ? m[0].indexOf(m[2]) : 0);
      this.parseFilterChainExpression(m[2], relativePath, exprStart, content, lineForIndex, entryPoints, seen);
    }
  }

  /**
   * Parse one filter-chain expression for its route facts. A chain may `.or(...)`
   * multiple independent routes together (e.g. `get_route.or(post_route)`), so this
   * splits on top-level `.or(` boundaries first, then extracts path/method/handler
   * from each independent branch.
   */
  private parseFilterChainExpression(
    expr: string,
    relativePath: string,
    exprOffset: number,
    fullContent: string,
    lineForIndex: (idx: number) => number,
    entryPoints: CASEntryPoint[],
    seen: Set<string>
  ): void {
    for (const branch of this.splitTopLevelOr(expr)) {
      if (!/warp::path/.test(branch)) continue;

      // Path segments: `warp::path("x")` / `warp::path::end()` (no segment) / the
      // `warp::path!("a" / "b" / ..)` macro form (segments joined by `/`).
      const segments: string[] = [];
      for (const pm of branch.matchAll(/warp::path\s*!\s*\(\s*((?:"[^"]*"\s*\/?\s*)+)\)/g)) {
        for (const seg of pm[1].matchAll(/"([^"]*)"/g)) segments.push(seg[1]);
      }
      for (const pm of branch.matchAll(/warp::path\s*\(\s*"([^"]*)"\s*\)/g)) segments.push(pm[1]);
      // `warp::path::param()` — a dynamic path segment (typed extractor); we don't
      // know the param name from the filter alone, so surface it as `:param`.
      const paramCount = (branch.match(/warp::path::param\s*\(\s*\)/g) || []).length;
      for (let i = 0; i < paramCount; i++) segments.push(':param');

      const routePath = segments.length > 0 ? `/${segments.join('/')}` : '/';

      // Method filter: warp::get() / warp::post() / ... anywhere in the chain.
      const methodMatch = branch.match(/\bwarp::(get|post|put|patch|delete|head|options)\s*\(\s*\)/);
      const method = methodMatch ? methodMatch[1].toUpperCase() : 'GET';

      // Handler: the argument of the terminal `.and_then(...)` (async handler) or
      // `.map(...)` (sync handler) — whichever appears LAST in the chain, since a
      // chain may have intermediate `.and(...)` filters (extractors, guards) before
      // reaching its actual handler.
      const handler = this.resolveTerminalHandler(branch);
      if (!handler) continue;

      const dedupeKey = `${relativePath}:${method}:${routePath}:${handler}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const line = lineForIndex(exprOffset);
      const nodeId = `function:${relativePath}:${handler}`;
      entryPoints.push(this.createEntryPoint(
        `entry:http:${relativePath}:${handler}:${method}:${routePath}`,
        nodeId,
        'http',
        `${method} ${routePath}`,
        `Warp filter-chain route handled by ${handler}`,
        { method, path: routePath },
        undefined,
        { framework: 'warp', method, path: routePath, handler, file: relativePath, line },
        { node_id: nodeId, method_name: handler, file: relativePath, line }
      ));
    }
  }

  /** Split an expression on `.or(` boundaries that occur at bracket depth 0 (top level
   *  of the outer expression), returning each `.or()`-joined branch's own sub-expression
   *  text (including its own nested `.and(...)`/`.and_then(...)` chain). */
  private splitTopLevelOr(expr: string): string[] {
    const branches: string[] = [];
    let depth = 0;
    let cur = '';
    for (let i = 0; i < expr.length; i++) {
      const ch = expr[i];
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      if (ch === ')' || ch === ']' || ch === '}') depth--;
      if (depth === 0 && expr.slice(i, i + 4) === '.or(') {
        branches.push(cur);
        cur = '';
        // Skip past ".or(" — the inner content continues accumulating as its own text;
        // we don't try to balance-match here because each branch is still scanned by
        // the same regexes above regardless of enclosing punctuation.
        continue;
      }
      cur += ch;
    }
    branches.push(cur);
    return branches;
  }

  /** The handler bound at the LAST `.and_then(<handler>)` or `.map(<handler>)` call
   *  in a filter-chain branch (bare identifier or member-path only — inline closures
   *  are still real, navigable-by-location handlers so we surface a synthetic name). */
  private resolveTerminalHandler(branch: string): string | undefined {
    let last: string | undefined;
    for (const m of branch.matchAll(/\.(?:and_then|map)\s*\(\s*([^)]*)\)/g)) {
      const raw = m[1].trim();
      last = this.describeHandler(raw);
    }
    return last;
  }

  private describeHandler(raw: string): string {
    if (/^[A-Za-z_][\w:]*$/.test(raw)) return raw;
    if (/^async\s+[A-Za-z_][\w:]*$/.test(raw)) return raw.replace(/^async\s+/, '');
    if (/^move\s*\|/.test(raw) || /^\|/.test(raw) || /^async\s+move\s*\|/.test(raw)) return 'inline handler';
    return 'inline handler';
  }

  private buildLineIndex(content: string): (idx: number) => number {
    const offsets: number[] = [];
    let offset = 0;
    for (const line of content.split('\n')) { offsets.push(offset); offset += line.length + 1; }
    return (idx: number) => {
      let low = 0, high = offsets.length - 1, result = 0;
      while (low <= high) { const mid = (low + high) >> 1; if (offsets[mid] <= idx) { result = mid; low = mid + 1; } else { high = mid - 1; } }
      return result + 1;
    };
  }

  private async findRustFiles(projectPath: string): Promise<string[]> {
    const files = await glob('**/*.rs', { cwd: projectPath, ignore: this.getIgnorePatterns({ projectPath }), nodir: true });
    return files.map(file => path.join(projectPath, file));
  }
}
