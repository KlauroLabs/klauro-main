import { AnalysisContext, BaseAnalyzer } from '../../core/base-analyzer';
import { CASContribution, CASEntryPoint } from '../../../types/cas.types';
import { isAuthenticationGuardName } from '../../core/guard-classification';
import { maskCStyleComments } from '../../core/source-comment-mask';
import * as fs from 'fs-extra';
import * as path from 'path';
import { cachedGlob as glob } from '../../core/glob-cache';
















const LAYER_CALL = /\.layer\s*\(([\s\S]*?)\)\s*(?=[.;}]|$)/g;

export class AxumAnalyzer extends BaseAnalyzer {
  constructor() {
    super('axum', 'Axum Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    if (!(await fs.pathExists(path.join(projectPath, 'Cargo.toml')))) return false;
    try {
      const cargo = await fs.readFile(path.join(projectPath, 'Cargo.toml'), 'utf-8');
      if (!/\baxum\b/.test(cargo)) return false;
      for (const file of await this.findRustFiles(projectPath)) {
        const content = maskCStyleComments(await fs.readFile(file, 'utf-8'), { singleQuotedStrings: false });
        if (/\bRouter::new\s*\(/.test(content) && /\.route\s*\(/.test(content)) return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: NonNullable<CASContribution['nodes']> = [];
    const edges: NonNullable<CASContribution['edges']> = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: NonNullable<CASContribution['exit_points']> = [];

    try {
      const files = await this.findRustFiles(context.projectPath);
      const sources = await Promise.all(files.map(async file => ({
        file,
        relativePath: path.relative(context.projectPath, file),
        stem: path.basename(file, '.rs'),
        content: maskCStyleComments(await fs.readFile(file, 'utf-8'), { singleQuotedStrings: false }),
      })));


      for (const src of sources) this.extractAxumRoutes(src.content, src.relativePath, nodes, entryPoints);
      const model = this.buildAxumRouterModel(sources);
      const routeAuth = this.computeScopeRouteAuth(sources);
      this.applyRouterModel(entryPoints, model, routeAuth);

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








  private static forEachAxumRoute(content: string, cb: (method: string, path: string, handler: string, index: number) => void): void {
    if (!/\.route\s*\(/.test(content) || !/\bRouter::|axum/.test(content)) return;
    const routeCall = /\.route\(\s*"([^"]+)"\s*,/g;
    const methodHandler = /\b(get|post|put|delete|patch|head|options|trace|any)\s*\(\s*(?:move\s*\|[^|]*\|\s*)?([A-Za-z_][A-Za-z0-9_]*)/g;
    let match: RegExpExecArray | null;
    while ((match = routeCall.exec(content)) !== null) {
      const routePath = match[1];
      const argStart = match.index + match[0].length;
      const nextRoute = content.indexOf('.route(', argStart);
      const argEnd = nextRoute === -1 ? Math.min(content.length, argStart + 240) : nextRoute;
      const argSegment = content.slice(argStart, argEnd);
      methodHandler.lastIndex = 0;
      let mh: RegExpExecArray | null;
      while ((mh = methodHandler.exec(argSegment)) !== null) {
        cb(mh[1].toUpperCase(), routePath, mh[2], match.index);
      }
    }
  }


  private static routeKey(file: string, method: string, path: string, handler: string): string {
    return `${file}\0${method}\0${path}\0${handler}`;
  }


  private extractAxumRoutes(
    content: string,
    relativePath: string,
    nodes: NonNullable<CASContribution['nodes']>,
    entryPoints: CASEntryPoint[],
  ): void {
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
    const seen = new Set<string>();
    AxumAnalyzer.forEachAxumRoute(content, (method, routePath, handlerFn, index) => {
      const dedupeKey = `${method}:${routePath}:${handlerFn}`;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      const lineNo = lineForIndex(index);
      const nodeId = this.generateId('route', relativePath, `${method}_${routePath}_${handlerFn}`);
      nodes.push(this.createNodeBuilder(nodeId, `${method} ${routePath}`, 'route')
        .withLevel(3, 'handlers')
        .withCategory('backend', ['axum', 'http', 'route'])
        .withSource({ file: relativePath, line: lineNo, end_line: lineNo })
        .withMetadata({
          framework: 'axum',
          attributes: { method, path: routePath, handler: handlerFn },
        })
        .build());
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
    });
  }





  private buildAxumRouterModel(sources: Array<{ stem: string; content: string }>): { authedModules: Set<string>; modulePrefix: Map<string, string> } {
    interface RouterVar { directModules: Set<string>; mergedVars: string[]; authed: boolean; nests: Array<{ prefix: string; target: string }> }
    const vars = new Map<string, RouterVar>();

    const parseExpression = (name: string, expr: string) => {
      const directModules = new Set<string>();

      for (const m of expr.matchAll(/(?:merge|nest)\s*\([^)]*?(?:[A-Za-z_]\w*::)*([A-Za-z_]\w*)::router\s*\(/g)) directModules.add(m[1]);
      const bare = expr.match(/^\s*(?:[A-Za-z_]\w*::)*([A-Za-z_]\w*)::router\s*\(/);
      if (bare) directModules.add(bare[1]);

      const mergedVars: string[] = [];
      for (const m of expr.matchAll(/merge\s*\(\s*([a-z_]\w*)\s*\)/g)) if (!/::/.test(m[0])) mergedVars.push(m[1]);
      const nests: Array<{ prefix: string; target: string }> = [];
      for (const m of expr.matchAll(/nest\s*\(\s*"([^"]+)"\s*,\s*([a-z_]\w*)\s*\)/g)) nests.push({ prefix: m[1], target: m[2] });

      let authed = false;
      for (const m of expr.matchAll(LAYER_CALL)) {
        for (const sym of m[1].matchAll(/\b([A-Za-z_]\w*)\b/g)) {
          if (isAuthenticationGuardName(sym[1])) { authed = true; break; }
        }
        if (authed) break;
      }
      vars.set(name, { directModules, mergedVars, authed, nests });
    };

    for (const { content } of sources) {

      for (const m of content.matchAll(/\blet\s+([a-z_]\w*)\s*=\s*([\s\S]*?);/g)) {
        if (/Router::new\s*\(|::router\s*\(/.test(m[2])) parseExpression(m[1], m[2]);
      }

      for (const m of content.matchAll(/\bRouter::new\s*\([\s\S]*?(?=\n\s*\}|;)/g)) {
        if (/\.nest\s*\(|\.merge\s*\(|\.layer\s*\(/.test(m[0])) parseExpression(`__return_${vars.size}__`, m[0]);
      }
    }


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


  private applyRouterModel(
    entryPoints: CASEntryPoint[],
    model: { authedModules: Set<string>; modulePrefix: Map<string, string> },
    routeAuth: { authedRoutes: Set<string>; knownRoutes: Set<string> }
  ): void {
    for (const ep of entryPoints) {
      if (ep.metadata?.framework !== 'axum') continue;
      const file = ep.handler?.file || (ep.metadata?.file as string) || '';
      const moduleName = file ? path.basename(file, '.rs') : '';


      const rawPath = String(ep.metadata?.path ?? '');
      const method = String(ep.metadata?.method ?? '');
      const handler = String(ep.metadata?.handler ?? '');
      const rk = AxumAnalyzer.routeKey(file, method, rawPath, handler);
      const prefix = model.modulePrefix.get(moduleName);
      if (prefix && ep.metadata?.path && !String(ep.metadata.path).startsWith(prefix)) {
        const fullPath = `${prefix}${ep.metadata.path}`.replace(/\/{2,}/g, '/');
        ep.metadata.path = fullPath;
        if (ep.trigger) ep.trigger.path = fullPath;
        if (ep.metadata.method) ep.name = `${ep.metadata.method} ${fullPath}`;
        ep.metadata.nested_prefix_unresolved = false;
      }





      const moduleKnown = model.authedModules.has(moduleName) || model.modulePrefix.has(moduleName);
      const known = routeAuth.knownRoutes.has(rk) || moduleKnown;
      if (known) {
        const authenticated = routeAuth.authedRoutes.has(rk) || model.authedModules.has(moduleName);
        ep.security = { ...(ep.security || {}), authenticated };
      }
    }
  }













  private computeScopeRouteAuth(sources: Array<{ relativePath: string; stem: string; content: string }>): { authedRoutes: Set<string>; knownRoutes: Set<string> } {
    interface Scope {
      id: number;
      refNames: string[];
      selfAuthed: boolean;
      composes: string[];
      routeKeys: string[];
      start: number;
      end: number;
    }
    const scopes: Scope[] = [];
    let idCounter = 0;

    for (const src of sources) {
      const { content, relativePath, stem } = src;
      if (!/\.route\s*\(/.test(content) || !/\bRouter::|axum/.test(content)) continue;
      const fileScopes: Scope[] = [];



      for (const m of content.matchAll(/\bfn\s+([A-Za-z_]\w*)/g)) {
        const span = AxumAnalyzer.braceSpan(content, m.index!);
        if (!span) continue;
        const refNames = [m[1]];
        if (m[1] === 'router') refNames.push(stem);
        fileScopes.push({ id: idCounter++, refNames, selfAuthed: false, composes: [], routeKeys: [], start: span[0], end: span[1] });
      }

      for (const m of content.matchAll(/\blet\s+([a-z_]\w*)\s*=\s*([\s\S]*?);/g)) {
        if (!/Router::new\s*\(|::router\s*\(/.test(m[2])) continue;
        fileScopes.push({ id: idCounter++, refNames: [m[1]], selfAuthed: false, composes: [], routeKeys: [], start: m.index!, end: m.index! + m[0].length });
      }
      if (fileScopes.length === 0) continue;

      const innermost = (offset: number): Scope | undefined => {
        let best: Scope | undefined;
        for (const s of fileScopes) {
          if (s.start <= offset && offset < s.end && (!best || (s.end - s.start) < (best.end - best.start))) best = s;
        }
        return best;
      };


      AxumAnalyzer.forEachAxumRoute(content, (method, routePath, handler, index) => {
        innermost(index)?.routeKeys.push(AxumAnalyzer.routeKey(relativePath, method, routePath, handler));
      });

      for (const m of content.matchAll(LAYER_CALL)) {
        let isAuth = false;
        for (const sym of m[1].matchAll(/\b([A-Za-z_]\w*)\b/g)) { if (isAuthenticationGuardName(sym[1])) { isAuth = true; break; } }
        if (isAuth) { const s = innermost(m.index!); if (s) s.selfAuthed = true; }
      }

      const addComposed = (re: RegExp, group: number) => {
        for (const m of content.matchAll(re)) { const s = innermost(m.index!); if (s) s.composes.push(m[group]); }
      };
      addComposed(/(?:merge|nest)\s*\([^)]*?(?:[A-Za-z_]\w*::)*([A-Za-z_]\w*)::router\s*\(/g, 1);
      addComposed(/(?:merge|nest)\s*\(\s*(?:"[^"]+"\s*,\s*)?([a-z_]\w*)\s*\(\s*\)/g, 1);
      addComposed(/merge\s*\(\s*([a-z_]\w*)\s*\)/g, 1);
      addComposed(/nest\s*\(\s*"[^"]+"\s*,\s*([a-z_]\w*)\s*\)/g, 1);

      scopes.push(...fileScopes);
    }


    const byName = new Map<string, Scope[]>();
    for (const s of scopes) for (const n of s.refNames) { (byName.get(n) ?? byName.set(n, []).get(n)!).push(s); }



    const authed = new Set<number>();
    const queue: Scope[] = [];
    for (const s of scopes) if (s.selfAuthed) { authed.add(s.id); queue.push(s); }
    while (queue.length) {
      const c = queue.pop()!;
      for (const ref of c.composes) for (const t of byName.get(ref) ?? []) if (!authed.has(t.id)) { authed.add(t.id); queue.push(t); }
    }




    const composedNames = new Set<string>();
    for (const s of scopes) for (const r of s.composes) composedNames.add(r);
    const authedRoutes = new Set<string>();
    const knownRoutes = new Set<string>();
    for (const s of scopes) {
      const known = s.selfAuthed || s.composes.length > 0 || s.refNames.some(n => composedNames.has(n));
      const isAuthed = authed.has(s.id);
      for (const rk of s.routeKeys) { if (known) knownRoutes.add(rk); if (isAuthed) authedRoutes.add(rk); }
    }
    return { authedRoutes, knownRoutes };
  }


  private static braceSpan(content: string, fromIndex: number): [number, number] | null {
    const open = content.indexOf('{', fromIndex);
    if (open === -1) return null;
    let depth = 0;
    for (let i = open; i < content.length; i++) {
      const ch = content[i];
      if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) return [fromIndex, i];
    }
    return [fromIndex, content.length];
  }

  private async findRustFiles(projectPath: string): Promise<string[]> {
    const files = await glob('**/*.rs', { cwd: projectPath, ignore: this.getIgnorePatterns({ projectPath }), nodir: true });
    return files.map(file => path.join(projectPath, file));
  }
}
