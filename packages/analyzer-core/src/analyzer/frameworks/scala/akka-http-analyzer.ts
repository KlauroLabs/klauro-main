import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, FileAnalysisResult
} from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';
import * as path from 'path';

/**
 * Akka HTTP / Apache Pekko HTTP framework analyzer (Scala route DSL).
 *
 * Akka HTTP (and its Apache-licensed fork Pekko, same API surface post-rename)
 * declares routes with a nested combinator DSL:
 *
 *   val route =
 *     pathPrefix("api") {
 *       path("users") {
 *         get { complete(...) } ~
 *         post { entity(as[User]) { user => complete(...) } }
 *       } ~
 *       path("users" / IntNumber) { id =>
 *         get { complete(...) } ~
 *         authenticateBasic("realm", auth) { user => delete { complete(...) } }
 *       }
 *     }
 *
 * There is no per-route annotation or file to point at (unlike JAX-RS/Play);
 * the route tree IS the source of truth, so this analyzer walks the DSL
 * brace-nesting the same way KtorAnalyzer walks `routing { }`:
 *   - `pathPrefix("x") { ... }` / `path("x" / "y" / IntNumber) { ... }` push a
 *     path-segment scope (segments joined with `/`; `IntNumber`/`LongNumber`/
 *     `Segment`/a bound extractor become a `:param` placeholder).
 *   - `get { ... }` / `post { ... }` / etc. (the akka.http.scaladsl.server
 *     directives) close a route at the accumulated prefix.
 *   - `authenticate*` / `authorize` directives wrapping a scope mark every
 *     route nested inside as authenticated (structural signal, not inferred).
 *   - `~` (the `Route` concat combinator) is a route-tree sibling separator,
 *     not meaningful to path resolution — ignored.
 *
 * Extraction is line/brace-based over `.scala` files (same approach as Ktor's
 * Kotlin DSL and http4s' pattern-match DSL), since a shared Scala AST is not
 * assumed available for every consumer of this analyzer.
 */

const SCALA_GLOBS = ['**/*.scala'];
const BUILD_GLOBS = ['build.sbt', 'project/plugins.sbt', '**/build.sbt'];

const HTTP_METHOD_DIRECTIVES = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options']);
const AUTH_DIRECTIVES = new Set(['authenticateBasic', 'authenticateOAuth2', 'authenticateBasicAsync', 'authenticateOAuth2Async', 'authorize', 'authorizeAsync']);

interface AkkaRoute {
  method: string;
  path: string;
  line: number;
  authenticated: boolean;
}

// Brace-scope frame for resolving nested path prefixes and auth wrappers.
interface Scope {
  kind: 'path' | 'auth' | 'other';
  segment?: string;
  depthAtOpen: number;
}

interface AkkaFileInfo {
  relativePath: string;
  fullPath: string;
  lineCount: number;
  routes: AkkaRoute[];
}

export class AkkaHttpAnalyzer extends BaseAnalyzer {
  constructor() {
    super('akka-http', 'Akka HTTP / Pekko HTTP Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const buildFiles = await glob(BUILD_GLOBS, {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true,
      });
      for (const rel of buildFiles) {
        const content = await fs.readFile(path.join(projectPath, rel), 'utf-8').catch(() => '');
        if (/akka-http|akka\.http|pekko-http|pekko\.http|org\.apache\.pekko.*http/.test(content)) return true;
      }

      const scalaFiles = await glob(SCALA_GLOBS, {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true,
      });
      for (const rel of scalaFiles) {
        const content = await fs.readFile(path.join(projectPath, rel), 'utf-8').catch(() => '');
        if (/import\s+akka\.http|import\s+org\.apache\.pekko\.http/.test(content)) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    const files = await glob(SCALA_GLOBS, {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true,
    });
    return files.sort();
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const content = await fs.readFile(context.filePath, 'utf-8');
    const stat = await fs.stat(context.filePath);

    const info = this.parseAkkaFile(context.relativePath, context.filePath, content);
    this.emitFileContribution(info, nodes, edges, entryPoints);

    const exports = info.routes.map(r => `${r.method} ${r.path}`);

    return this.createFileAnalysisResult(
      context.filePath,
      context.relativePath,
      context.contentHash || this.computeContentHash(content),
      stat.mtimeMs,
      nodes,
      edges,
      entryPoints,
      exitPoints,
      [],
      exports
    );
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    this.resetAnalysisWarnings();
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    try {
      let scalaFiles = await glob(SCALA_GLOBS, {
        cwd: context.projectPath,
        ignore: this.getIgnorePatterns(context),
        nodir: true,
      });
      scalaFiles.sort();
      scalaFiles = this.capAndPrioritizeSourceFiles(scalaFiles, 'scala files');

      const fileInfos: AkkaFileInfo[] = [];
      for (const relativePath of scalaFiles) {
        const fullPath = path.join(context.projectPath, relativePath);
        let content = '';
        try {
          content = await fs.readFile(fullPath, 'utf-8');
        } catch {
          continue;
        }
        if (!/akka\.http|pekko\.http|\bpathPrefix\s*\(|\bpath\s*\(|\bconcat\s*\(/.test(content)) continue;
        fileInfos.push(this.parseAkkaFile(relativePath, fullPath, content));
      }

      for (const info of fileInfos) {
        this.emitFileContribution(info, nodes, edges, entryPoints);
      }

      const routeCount = entryPoints.filter(ep => ep.metadata?.framework === 'akka-http' && ep.type === 'http').length;
      const authRouteCount = entryPoints.filter(ep => ep.metadata?.framework === 'akka-http' && ep.security?.authenticated).length;

      const warnings = this.collectAnalysisWarnings();
      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        ...(warnings.length > 0 ? { warnings } : {}),
        framework: 'akka-http',
        framework_specific: {
          framework: 'akka-http',
          filesAnalyzed: fileInfos.length,
          routes: routeCount,
          authenticatedRoutes: authRouteCount,
        },
      });
    } catch (error) {
      throw new AnalyzerError(
        `Akka HTTP analysis failed: ${(error as Error).message}`,
        'AKKA_HTTP_ANALYSIS_ERROR'
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Parsing
  // ---------------------------------------------------------------------------

  private parseAkkaFile(relativePath: string, fullPath: string, content: string): AkkaFileInfo {
    const lines = content.split('\n');
    return {
      relativePath,
      fullPath,
      lineCount: lines.length,
      routes: this.extractRoutes(lines),
    };
  }

  /**
   * Walk the file maintaining a brace-depth scope stack so `pathPrefix`/`path`
   * segments and `authenticate*`/`authorize` wrappers accumulate onto the
   * method directives (`get`/`post`/...) nested inside them — the same
   * approach as KtorAnalyzer.extractRoutes for its `route()`/`authenticate()`
   * DSL, adapted to Akka's `path`/`pathPrefix` segment syntax.
   */
  private extractRoutes(lines: string[]): AkkaRoute[] {
    const routes: AkkaRoute[] = [];
    const scopes: Scope[] = [];
    let depth = 0;

    for (let i = 0; i < lines.length; i++) {
      const stripped = this.stripStringsAndComments(lines[i]);
      const raw = lines[i];

      const pathOpen = raw.match(/\b(?:pathPrefix|path)\s*\(([^)]*)\)\s*\{/);
      const authOpen = raw.match(/\b(authenticateBasic|authenticateOAuth2|authenticateBasicAsync|authenticateOAuth2Async|authorize|authorizeAsync)\s*\(/);

      // Method directive: `get { ... }` / `post { ... }` on its own or chained with `~`.
      const methodMatch = raw.match(/\b(get|post|put|delete|patch|head|options)\s*\{/);
      if (methodMatch && HTTP_METHOD_DIRECTIVES.has(methodMatch[1])) {
        const method = methodMatch[1].toUpperCase();
        const fullPath = this.resolvePrefix(scopes) || '/';
        const authenticated = this.hasAuthScope(scopes);
        routes.push({ method, path: fullPath, line: i + 1, authenticated });
      }

      if (pathOpen) {
        const segment = this.parsePathSegment(pathOpen[1]);
        scopes.push({ kind: 'path', segment, depthAtOpen: depth });
      } else if (authOpen) {
        scopes.push({ kind: 'auth', depthAtOpen: depth });
      }

      for (const ch of stripped) {
        if (ch === '{') {
          depth++;
        } else if (ch === '}') {
          depth--;
          while (scopes.length > 0 && scopes[scopes.length - 1].depthAtOpen >= depth) {
            scopes.pop();
          }
        }
      }
    }
    return routes;
  }

  /**
   * Turn a `path(...)`/`pathPrefix(...)` argument list into a `/`-joined
   * segment: string literals become literal segments, `IntNumber`/`LongNumber`/
   * `Segment`/`JavaUUID` extractors (bound or not) become `:param`, and `/` is
   * the Akka path-DSL concatenation operator joining segments in one call.
   */
  private parsePathSegment(argsRaw: string): string {
    const parts = argsRaw.split('/').map(p => p.trim()).filter(Boolean);
    const segments = parts.map(p => {
      const strMatch = p.match(/^"([^"]*)"$/);
      if (strMatch) return strMatch[1];
      if (/^(IntNumber|LongNumber|Segment|JavaUUID|DoubleNumber|HexIntNumber)$/.test(p)) return ':param';
      return ':param';
    });
    return segments.join('/');
  }

  private resolvePrefix(scopes: Scope[]): string {
    const segments = scopes.filter(s => s.kind === 'path' && s.segment).map(s => s.segment as string);
    if (segments.length === 0) return '';
    return `/${segments.join('/')}`.replace(/\/{2,}/g, '/');
  }

  private hasAuthScope(scopes: Scope[]): boolean {
    return scopes.some(s => s.kind === 'auth');
  }

  private stripStringsAndComments(line: string): string {
    let result = '';
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const next = line[i + 1];
      if (!inSingle && !inDouble && ch === '/' && next === '/') break;
      if (ch === "'" && !inDouble) inSingle = !inSingle;
      else if (ch === '"' && !inSingle) inDouble = !inDouble;
      else if (!inSingle && !inDouble) result += ch;
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Emission
  // ---------------------------------------------------------------------------

  private emitFileContribution(
    info: AkkaFileInfo,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): void {
    const fileId = `file_${this.sanitizeId(info.relativePath)}`;

    info.routes.forEach((route, index) => {
      const routeId = `akkahttp_route_${this.sanitizeId(info.relativePath)}_${route.method}_${this.sanitizeId(route.path)}_${index}`;
      const label = `${route.method} ${route.path}`;
      const tags = ['akka-http-route'];
      if (route.authenticated) tags.push('auth-gated', 'security');

      nodes.push(this.createNodeBuilder(routeId, label, 'route')
        .withLevel(3, 'akka-http-routes')
        .withCategory('route', ['http', 'endpoint', 'akka-http'])
        .withSource({ file: info.fullPath, line: route.line, end_line: route.line })
        .withDescription(`Akka HTTP / Pekko HTTP endpoint: ${label}${route.authenticated ? ' (authenticated)' : ''}`)
        .withMetadata({
          framework: 'akka-http',
          attributes: {
            method: route.method,
            path: route.path,
            authenticated: route.authenticated,
            file: info.relativePath,
          },
        })
        .withTags(tags)
        .build());

      edges.push(this.createEdge(`${fileId}_exposes_${routeId}`, fileId, routeId, 'exposes', 'behavior', {
        attributes: { framework: 'akka-http' },
      }));

      entryPoints.push(this.createEntryPoint(
        `entry_${routeId}`,
        routeId,
        'http',
        label,
        `Akka HTTP / Pekko HTTP route handled at ${info.relativePath}:${route.line}`,
        { method: route.method, path: route.path },
        { authenticated: route.authenticated, authorized_roles: [], guards: [] },
        { framework: 'akka-http', kind: 'route', method: route.method, path: route.path, file: info.relativePath, line: route.line, language: 'scala' },
        { node_id: routeId, method_name: `${route.method} ${route.path}`, file: info.relativePath, line: route.line }
      ));
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'akka-http-application';
      case 2: return 'akka-http-directives';
      case 3: return 'akka-http-routes';
      case 4: return 'akka-http-handlers';
      default: return `akka-http-level-${level}`;
    }
  }

  protected getCapabilities(): string[] {
    return ['akka-http-routes', 'akka-http-auth'];
  }
}

export default { AkkaHttpAnalyzer };
