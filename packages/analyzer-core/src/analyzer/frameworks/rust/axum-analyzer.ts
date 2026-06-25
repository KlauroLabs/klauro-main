import { AnalysisContext, BaseAnalyzer } from '../../core/base-analyzer';
import { CASContribution, CASEntryPoint } from '../../../types/cas.types';
import { RustAnalyzer } from '../../languages/rust-analyzer';
import { isAuthenticationGuardName } from '../../core/guard-classification';
import * as fs from 'fs-extra';
import * as path from 'path';
import { glob } from 'glob';

/**
 * Axum framework analyzer.
 *
 * Route EXTRACTION (the `.route("/path", method(handler))` builder API) is done by
 * the base RustAnalyzer. This analyzer adds the axum-specific intelligence that has
 * no other home: the tower middleware model. In axum, authentication is applied with
 * `.layer(...)` on a router GROUP, not per route — so which endpoints are protected
 * is a composition fact, resolved from how module routers are `.merge()`d into a
 * layered router and `.nest()`ed under a prefix. Without this, every axum route shows
 * `auth: unknown`, which for a zero-trust product is the most damaging possible gap.
 */
export class AxumAnalyzer extends BaseAnalyzer {
  private rustAnalyzer: RustAnalyzer;

  constructor() {
    super('axum', 'Axum Framework Analyzer', '1.0.0', 'framework');
    this.rustAnalyzer = new RustAnalyzer();
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    if (!(await fs.pathExists(path.join(projectPath, 'Cargo.toml')))) return false;
    try {
      const cargo = await fs.readFile(path.join(projectPath, 'Cargo.toml'), 'utf-8');
      if (!/\baxum\b/.test(cargo)) return false;
      for (const file of await this.findRustFiles(projectPath)) {
        const content = await fs.readFile(file, 'utf-8');
        if (/\bRouter::new\s*\(/.test(content) && /\.route\s*\(/.test(content)) return true;
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
      const sources = await Promise.all(files.map(async file => ({
        file,
        relativePath: path.relative(context.projectPath, file),
        stem: path.basename(file, '.rs'),
        content: await fs.readFile(file, 'utf-8'),
      })));
      // Extraction lives here (not in the base Rust analyzer) so axum routes are
      // emitted exactly once — by this analyzer, with auth + prefix resolved.
      for (const src of sources) this.extractAxumRoutes(src.content, src.relativePath, entryPoints);
      const model = this.buildAxumRouterModel(sources);
      this.applyRouterModel(entryPoints, model);

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework_specific: {
          framework: 'axum',
          route_count: entryPoints.filter(ep => ep.metadata?.framework === 'axum').length,
          authenticated_route_count: entryPoints.filter(ep => ep.metadata?.framework === 'axum' && ep.security?.authenticated).length,
          protected_modules: [...model.authedModules],
        },
      });
    } catch (error) {
      throw new Error(`Axum analysis failed: ${(error as Error).message}`);
    }
  }

  protected getCapabilities(): string[] {
    return ['route-detection', 'middleware-auth-detection', 'nest-prefix-resolution'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'axum-framework';
      case 2: return 'routers';
      case 3: return 'handlers';
      case 4: return 'middleware';
      default: return `axum-level-${level}`;
    }
  }

  /** Extract `.route("/path", method(handler))` builder routes into entry points. */
  private extractAxumRoutes(content: string, relativePath: string, entryPoints: CASEntryPoint[]): void {
    if (!/\.route\s*\(/.test(content) || !/\bRouter::|axum/.test(content)) return;
    const lines = content.split('\n');
    const lineStartOffsets: number[] = [];
    let offset = 0;
    for (const line of lines) { lineStartOffsets.push(offset); offset += line.length + 1; }
    const lineForIndex = (index: number): number => {
      let low = 0, high = lineStartOffsets.length - 1, result = 0;
      while (low <= high) { const mid = (low + high) >> 1; if (lineStartOffsets[mid] <= index) { result = mid; low = mid + 1; } else { high = mid - 1; } }
      return result + 1;
    };
    const routeCall = /\.route\(\s*"([^"]+)"\s*,/g;
    const methodHandler = /\b(get|post|put|delete|patch|head|options|trace|any)\s*\(\s*(?:move\s*\|[^|]*\|\s*)?([A-Za-z_][A-Za-z0-9_]*)/g;
    const seen = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = routeCall.exec(content)) !== null) {
      const routePath = match[1];
      const argStart = match.index + match[0].length;
      const nextRoute = content.indexOf('.route(', argStart);
      const argEnd = nextRoute === -1 ? Math.min(content.length, argStart + 240) : nextRoute;
      const argSegment = content.slice(argStart, argEnd);
      const lineNo = lineForIndex(match.index);
      methodHandler.lastIndex = 0;
      let mh: RegExpExecArray | null;
      while ((mh = methodHandler.exec(argSegment)) !== null) {
        const method = mh[1].toUpperCase();
        const handlerFn = mh[2];
        const dedupeKey = `${method}:${routePath}:${handlerFn}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        const nodeId = `function:${relativePath}:${handlerFn}`;
        entryPoints.push(this.createEntryPoint(
          `entry:http:${relativePath}:${handlerFn}:${method}:${routePath}`,
          nodeId,
          'http',
          `${method} ${routePath}`,
          `HTTP route handled by ${handlerFn}`,
          { method, path: routePath },
          undefined,
          { framework: 'axum', method, path: routePath, handler: handlerFn, nested_prefix_unresolved: content.includes('.nest(') },
          { node_id: nodeId, method_name: handlerFn, file: relativePath, line: lineNo }
        ));
      }
    }
  }

  /**
   * Resolve, per route-module, whether it is behind an auth layer and what path
   * prefix it is nested under, by parsing the router-composition expressions.
   */
  private buildAxumRouterModel(sources: Array<{ stem: string; content: string }>): { authedModules: Set<string>; modulePrefix: Map<string, string> } {
    interface RouterVar { directModules: Set<string>; mergedVars: string[]; authed: boolean; nests: Array<{ prefix: string; target: string }> }
    const vars = new Map<string, RouterVar>();

    const parseExpression = (name: string, expr: string) => {
      const directModules = new Set<string>();
      // `merge(<path::>module::router(...))` and a bare `<path::>module::router()` RHS.
      for (const m of expr.matchAll(/(?:merge|nest)\s*\([^)]*?(?:[A-Za-z_]\w*::)*([A-Za-z_]\w*)::router\s*\(/g)) directModules.add(m[1]);
      const bare = expr.match(/^\s*(?:[A-Za-z_]\w*::)*([A-Za-z_]\w*)::router\s*\(/);
      if (bare) directModules.add(bare[1]);
      // `merge(<var>)` / `nest("/p", <var>)` where the arg is a local variable.
      const mergedVars: string[] = [];
      for (const m of expr.matchAll(/merge\s*\(\s*([a-z_]\w*)\s*\)/g)) if (!/::/.test(m[0])) mergedVars.push(m[1]);
      const nests: Array<{ prefix: string; target: string }> = [];
      for (const m of expr.matchAll(/nest\s*\(\s*"([^"]+)"\s*,\s*([a-z_]\w*)\s*\)/g)) nests.push({ prefix: m[1], target: m[2] });
      // Auth layer: a `.layer(...)` whose argument references an auth-classified symbol.
      let authed = false;
      for (const m of expr.matchAll(/\.layer\s*\(([\s\S]*?)\)\s*(?=\.|;|$)/g)) {
        for (const sym of m[1].matchAll(/\b([A-Za-z_]\w*)\b/g)) {
          if (isAuthenticationGuardName(sym[1])) { authed = true; break; }
        }
        if (authed) break;
      }
      vars.set(name, { directModules, mergedVars, authed, nests });
    };

    for (const { content } of sources) {
      // `let <var> = <expr>;`
      for (const m of content.matchAll(/\blet\s+([a-z_]\w*)\s*=\s*([\s\S]*?);/g)) {
        if (/Router::new\s*\(|::router\s*\(/.test(m[2])) parseExpression(m[1], m[2]);
      }
      // Bare returned router chains (no `let`): the function's final `Router::new()...`.
      for (const m of content.matchAll(/\bRouter::new\s*\([\s\S]*?(?=\n\s*\}|;)/g)) {
        if (/\.nest\s*\(|\.merge\s*\(|\.layer\s*\(/.test(m[0])) parseExpression(`__return_${vars.size}__`, m[0]);
      }
    }

    // Resolve each var's full module set by expanding merged vars (fixpoint).
    const resolved = new Map<string, Set<string>>();
    const resolveModules = (name: string, seen = new Set<string>()): Set<string> => {
      if (resolved.has(name)) return resolved.get(name)!;
      if (seen.has(name)) return new Set();
      seen.add(name);
      const info = vars.get(name);
      const out = new Set<string>(info?.directModules || []);
      for (const v of info?.mergedVars || []) for (const mod of resolveModules(v, seen)) out.add(mod);
      resolved.set(name, out);
      return out;
    };
    for (const name of vars.keys()) resolveModules(name);

    // A module is authenticated if it is reachable from any expression carrying an
    // auth layer. A module's prefix is the nest() prefix of any var it is reached
    // through (accumulated outer-to-inner for stacked nests).
    const authedModules = new Set<string>();
    for (const [name, info] of vars) {
      if (info.authed) for (const mod of resolved.get(name) || []) authedModules.add(mod);
    }
    const modulePrefix = new Map<string, string>();
    for (const info of vars.values()) {
      for (const nest of info.nests) {
        for (const mod of resolveModules(nest.target)) {
          modulePrefix.set(mod, `${nest.prefix}${modulePrefix.get(mod) || ''}`);
        }
      }
    }
    return { authedModules, modulePrefix };
  }

  /** Stamp auth + nest prefix onto the axum route entry points the Rust analyzer emitted. */
  private applyRouterModel(entryPoints: CASEntryPoint[], model: { authedModules: Set<string>; modulePrefix: Map<string, string> }): void {
    for (const ep of entryPoints) {
      if (ep.metadata?.framework !== 'axum') continue;
      const file = ep.handler?.file || (ep.metadata?.file as string) || '';
      const moduleName = file ? path.basename(file, '.rs') : '';
      const prefix = model.modulePrefix.get(moduleName);
      if (prefix && ep.metadata?.path && !String(ep.metadata.path).startsWith(prefix)) {
        const fullPath = `${prefix}${ep.metadata.path}`.replace(/\/{2,}/g, '/');
        ep.metadata.path = fullPath;
        if (ep.trigger) ep.trigger.path = fullPath;
        if (ep.metadata.method) ep.name = `${ep.metadata.method} ${fullPath}`;
        ep.metadata.nested_prefix_unresolved = false;
      }
      // Only assert auth for modules that participate in a known composition; leave
      // standalone routers (e.g. a captive portal) as unknown rather than guessing.
      const known = model.authedModules.has(moduleName) || model.modulePrefix.has(moduleName);
      if (known) {
        ep.security = { ...(ep.security || {}), authenticated: model.authedModules.has(moduleName) };
      }
    }
  }

  private async findRustFiles(projectPath: string): Promise<string[]> {
    const files = await glob('**/*.rs', { cwd: projectPath, ignore: this.getIgnorePatterns({ projectPath }), nodir: true });
    return files.map(file => path.join(projectPath, file));
  }
}
