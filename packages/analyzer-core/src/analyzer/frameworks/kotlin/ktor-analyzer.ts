import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, FileAnalysisResult
} from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';
import * as path from 'path';

/**
 * Ktor framework analyzer (Kotlin web framework).
 *
 * Sits on top of the Kotlin language analyzer's conventions but extracts the
 * Ktor-specific routing DSL that the generic Kotlin analyzer cannot see: the
 * `routing { get("/path") { ... } }` builder API, `route("/prefix") { ... }`
 * prefix nesting, `authenticate("name") { ... }` auth gating, `install(Plugin)`
 * server features, and `fun Application.module()` entry modules.
 *
 * Extraction is line/brace-based over `.kt` files (no Kotlin AST available). The
 * DSL is brace-nested, so paths and auth state are resolved from a brace-depth
 * stack of the enclosing `route(...)` / `authenticate(...)` scopes.
 */

const KOTLIN_GLOBS = ['**/*.kt'];
const GRADLE_GLOBS = ['**/build.gradle.kts', '**/build.gradle', '**/settings.gradle.kts', '**/gradle/libs.versions.toml'];

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options']);
// Plugins whose presence is a security fact (auth / CORS / CSRF etc.).
const SECURITY_PLUGINS = new Set([
  'Authentication', 'CORS', 'CSRF', 'Sessions', 'HttpsRedirect', 'HSTS',
  'XForwardedHeaders', 'ForwardedHeaders', 'RateLimit',
]);

interface KtorModule {
  name: string;        // function name, e.g. module / configureRouting
  receiver: string;    // extension receiver, expected `Application`
  lineStart: number;
  lineEnd: number;
}

interface KtorRoute {
  method: string;      // GET/POST/...
  path: string;        // resolved full path including route() prefixes
  line: number;
  authenticated: boolean;
  authNames: string[]; // names from the enclosing authenticate("x") scopes
  respond: boolean;    // body uses call.respond
  receive: boolean;    // body uses call.receive
}

interface KtorPlugin {
  name: string;
  line: number;
  security: boolean;
}

interface KtorFileInfo {
  relativePath: string;
  fullPath: string;
  lineCount: number;
  modules: KtorModule[];
  routes: KtorRoute[];
  plugins: KtorPlugin[];
}

// Brace-scope frame for resolving nested route prefixes and auth wrappers.
interface Scope {
  kind: 'route' | 'authenticate' | 'other';
  prefix?: string;     // route() prefix segment
  authNames?: string[];
  depthAtOpen: number;
}

export class KtorAnalyzer extends BaseAnalyzer {
  constructor() {
    super('ktor', 'Ktor Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      // 1. Gradle dependency signal.
      const gradleFiles = await glob(GRADLE_GLOBS, {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true,
      });
      for (const rel of gradleFiles) {
        const content = await fs.readFile(path.join(projectPath, rel), 'utf-8').catch(() => '');
        if (/io\.ktor|ktor-server/.test(content)) return true;
      }

      // 2. Source-level signal.
      const kotlinFiles = await glob(KOTLIN_GLOBS, {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true,
      });
      for (const rel of kotlinFiles) {
        const content = await fs.readFile(path.join(projectPath, rel), 'utf-8').catch(() => '');
        if (/import\s+io\.ktor/.test(content) || /routing\s*\{/.test(content) || /embeddedServer\s*\(/.test(content)) {
          return true;
        }
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
    const files = await glob(KOTLIN_GLOBS, {
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

    const info = this.parseKtorFile(context.relativePath, context.filePath, content);
    this.emitFileContribution(info, nodes, edges, entryPoints);

    const exports = [
      ...info.modules.map(m => m.name),
      ...info.routes.map(r => `${r.method} ${r.path}`),
    ];

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
      let kotlinFiles = await glob(KOTLIN_GLOBS, {
        cwd: context.projectPath,
        ignore: this.getIgnorePatterns(context),
        nodir: true,
      });
      kotlinFiles.sort();
      kotlinFiles = this.capAndPrioritizeSourceFiles(kotlinFiles, 'kotlin files');

      const fileInfos: KtorFileInfo[] = [];
      for (const relativePath of kotlinFiles) {
        const fullPath = path.join(context.projectPath, relativePath);
        let content = '';
        try {
          content = await fs.readFile(fullPath, 'utf-8');
        } catch {
          continue;
        }
        // Skip files with no Ktor signal to keep the contribution focused.
        if (!/io\.ktor|routing\s*\{|embeddedServer\s*\(|fun\s+Application\./.test(content)) continue;
        fileInfos.push(this.parseKtorFile(relativePath, fullPath, content));
      }

      for (const info of fileInfos) {
        this.emitFileContribution(info, nodes, edges, entryPoints);
      }

      const routeCount = entryPoints.filter(ep => ep.metadata?.framework === 'ktor' && ep.type === 'http').length;
      const authRouteCount = entryPoints.filter(ep => ep.metadata?.framework === 'ktor' && ep.security?.authenticated).length;
      const pluginCount = nodes.filter(n => n.type === 'plugin').length;
      const moduleCount = entryPoints.filter(ep => ep.metadata?.kind === 'module').length;

      const warnings = this.collectAnalysisWarnings();
      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        ...(warnings.length > 0 ? { warnings } : {}),
        framework: 'ktor',
        framework_specific: {
          framework: 'ktor',
          filesAnalyzed: fileInfos.length,
          modules: moduleCount,
          routes: routeCount,
          authenticatedRoutes: authRouteCount,
          plugins: pluginCount,
        },
      });
    } catch (error) {
      throw new AnalyzerError(
        `Ktor analysis failed: ${(error as Error).message}`,
        'KTOR_ANALYSIS_ERROR'
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Parsing
  // ---------------------------------------------------------------------------

  private parseKtorFile(relativePath: string, fullPath: string, content: string): KtorFileInfo {
    const lines = content.split('\n');
    return {
      relativePath,
      fullPath,
      lineCount: lines.length,
      modules: this.extractModules(lines),
      routes: this.extractRoutes(lines),
      plugins: this.extractPlugins(lines),
    };
  }

  /** `fun Application.module()` / `fun Application.configureRouting()` → app entry modules. */
  private extractModules(lines: string[]): KtorModule[] {
    const modules: KtorModule[] = [];
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed.startsWith('fun ') && !/\bfun\s+Application\./.test(trimmed)) continue;
      const m = trimmed.match(/\bfun\s+Application\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
      if (!m) continue;
      modules.push({
        name: m[1],
        receiver: 'Application',
        lineStart: i + 1,
        lineEnd: this.findBlockEnd(lines, i),
      });
    }
    return modules;
  }

  /**
   * Walk the file line by line maintaining a brace-depth scope stack so that
   * `route("/prefix") { ... }` prefixes and `authenticate("x") { ... }` wrappers
   * accumulate onto the routes nested inside them.
   */
  private extractRoutes(lines: string[]): KtorRoute[] {
    const routes: KtorRoute[] = [];
    const scopes: Scope[] = [];
    let depth = 0;

    for (let i = 0; i < lines.length; i++) {
      const stripped = this.stripStringsAndComments(lines[i]);
      const raw = lines[i];

      // Detect a scope opener on this line BEFORE counting braces, so the scope's
      // recorded depth matches the brace it owns.
      const routeOpen = raw.match(/\broute\s*\(\s*"([^"]*)"\s*\)\s*\{/);
      const authOpen = raw.match(/\bauthenticate\s*\(([^)]*)\)\s*\{/);

      // Route method call: get("/p") { , post("/p") { , or get { (no path).
      const methodMatch = raw.match(/\b(get|post|put|delete|patch|head|options)\s*\(\s*"([^"]*)"\s*\)\s*\{/)
        || raw.match(/\b(get|post|put|delete|patch|head|options)\s*\{/);
      if (methodMatch && HTTP_METHODS.has(methodMatch[1])) {
        const method = methodMatch[1].toUpperCase();
        const localPath = methodMatch[2] ?? '';
        const prefix = this.resolvePrefix(scopes);
        const fullPath = this.joinPath(prefix, localPath);
        const authNames = this.resolveAuthNames(scopes);
        const body = this.readHandlerBody(lines, i);
        routes.push({
          method,
          path: fullPath,
          line: i + 1,
          authenticated: authNames.length > 0,
          authNames,
          respond: /call\.respond/.test(body),
          receive: /call\.receive/.test(body),
        });
      }

      // Push scopes (route / authenticate) onto the stack at the current depth.
      if (routeOpen) {
        scopes.push({ kind: 'route', prefix: routeOpen[1], depthAtOpen: depth });
      } else if (authOpen) {
        const names = [...authOpen[1].matchAll(/"([^"]*)"/g)].map(m => m[1]).filter(Boolean);
        scopes.push({ kind: 'authenticate', authNames: names, depthAtOpen: depth });
      }

      // Count braces on this line and pop scopes whose owning brace closed.
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

  /** `install(ContentNegotiation)` / `install(Authentication) { ... }` → plugin facts. */
  private extractPlugins(lines: string[]): KtorPlugin[] {
    const plugins: KtorPlugin[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < lines.length; i++) {
      const stripped = this.stripStringsAndComments(lines[i]);
      for (const m of stripped.matchAll(/\binstall\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)/g)) {
        const name = m[1];
        if (seen.has(name)) continue;
        seen.add(name);
        plugins.push({ name, line: i + 1, security: SECURITY_PLUGINS.has(name) });
      }
    }
    return plugins;
  }

  private resolvePrefix(scopes: Scope[]): string {
    let prefix = '';
    for (const s of scopes) {
      if (s.kind === 'route' && s.prefix) prefix = this.joinPath(prefix, s.prefix);
    }
    return prefix;
  }

  private resolveAuthNames(scopes: Scope[]): string[] {
    const names: string[] = [];
    for (const s of scopes) {
      if (s.kind === 'authenticate') names.push(...(s.authNames || []));
    }
    return Array.from(new Set(names));
  }

  private joinPath(a: string, b: string): string {
    if (!a) return b || '/';
    if (!b) return a;
    return `${a}/${b}`.replace(/\/{2,}/g, '/');
  }

  // Read a small window of the route lambda body for call.respond/receive detection.
  private readHandlerBody(lines: string[], startIndex: number): string {
    const end = Math.min(lines.length, this.findBlockEnd(lines, startIndex));
    return lines.slice(startIndex, end).join('\n');
  }

  // Best-effort brace matching from a declaration line (mirrors KotlinAnalyzer).
  private findBlockEnd(lines: string[], startIndex: number): number {
    let depth = 0;
    let seenOpen = false;
    for (let i = startIndex; i < lines.length; i++) {
      const stripped = this.stripStringsAndComments(lines[i]);
      for (const ch of stripped) {
        if (ch === '{') {
          depth++;
          seenOpen = true;
        } else if (ch === '}') {
          depth--;
          if (seenOpen && depth <= 0) return i + 1;
        }
      }
    }
    return seenOpen ? lines.length : startIndex + 1;
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
    info: KtorFileInfo,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): void {
    const fileId = this.fileId(info.relativePath);
    const baseName = info.relativePath.split('/').pop() || 'unknown.kt';

    // Application module nodes + entry points.
    for (const mod of info.modules) {
      const moduleId = `ktor_module_${this.sanitizeId(info.relativePath)}_${this.sanitizeId(mod.name)}`;
      nodes.push(this.createNodeBuilder(moduleId, `Application.${mod.name}`, 'module')
        .withLevel(1, 'ktor-application')
        .withCategory('application', ['framework', 'ktor'])
        .withSource({ file: info.fullPath, line: mod.lineStart, end_line: mod.lineEnd })
        .withDescription(`Ktor application module: fun Application.${mod.name}()`)
        .withMetadata({
          framework: 'ktor',
          attributes: { receiver: mod.receiver, function: mod.name, file: info.relativePath },
        })
        .withTags(['ktor-module'])
        .build());

      entryPoints.push(this.createEntryPoint(
        `entry_ktor_module_${this.sanitizeId(info.relativePath)}_${this.sanitizeId(mod.name)}`,
        moduleId,
        // The module is the application bootstrap, not an HTTP endpoint. Marking it
        // 'http' (with no trigger) made buildRouteTable synthesize a phantom GET /.
        'lifecycle',
        `Ktor module: ${mod.name}`,
        `Ktor application module (fun Application.${mod.name})`,
        undefined,
        undefined,
        { framework: 'ktor', kind: 'module', function: mod.name, file: info.relativePath, line: mod.lineStart, language: 'kotlin' },
        { node_id: moduleId, method_name: mod.name, file: info.relativePath, line: mod.lineStart }
      ));
    }

    // Plugin nodes.
    for (const plugin of info.plugins) {
      const pluginId = `ktor_plugin_${this.sanitizeId(info.relativePath)}_${this.sanitizeId(plugin.name)}`;
      const tags = ['ktor-plugin'];
      if (plugin.security) tags.push('security');
      nodes.push(this.createNodeBuilder(pluginId, plugin.name, 'plugin')
        .withLevel(2, 'ktor-plugins')
        .withCategory('plugin', ['framework', 'ktor', ...(plugin.security ? ['security'] : [])])
        .withSource({ file: info.fullPath, line: plugin.line, end_line: plugin.line })
        .withDescription(`Ktor plugin installed: ${plugin.name}`)
        .withMetadata({
          framework: 'ktor',
          attributes: { plugin: plugin.name, security: plugin.security, file: info.relativePath },
        })
        .withTags(tags)
        .build());
      edges.push(this.createEdge(`${fileId}_installs_${pluginId}`, fileId, pluginId, 'installs', 'dependency', {
        attributes: { plugin: plugin.name, framework: 'ktor' },
      }));
    }

    // Route nodes + entry points + handler nodes.
    info.routes.forEach((route, index) => {
      const routeId = `ktor_route_${this.sanitizeId(info.relativePath)}_${route.method}_${this.sanitizeId(route.path)}_${index}`;
      const handlerId = `${routeId}_handler`;
      const label = `${route.method} ${route.path}`;
      const tags = ['ktor-route'];
      if (route.authenticated) tags.push('auth-gated', 'security');

      nodes.push(this.createNodeBuilder(routeId, label, 'route')
        .withLevel(3, 'ktor-routes')
        .withCategory('route', ['http', 'endpoint', 'ktor'])
        .withSource({ file: info.fullPath, line: route.line, end_line: route.line })
        .withDescription(`Ktor HTTP endpoint: ${label}${route.authenticated ? ' (authenticated)' : ''}`)
        .withMetadata({
          framework: 'ktor',
          attributes: {
            method: route.method,
            path: route.path,
            authenticated: route.authenticated,
            authNames: route.authNames,
            respond: route.respond,
            receive: route.receive,
            file: info.relativePath,
          },
        })
        .withTags(tags)
        .build());

      // Handler node = the route lambda body, linked entry→handler.
      nodes.push(this.createNodeBuilder(handlerId, `handler ${label}`, 'handler')
        .withLevel(4, 'ktor-handlers')
        .withCategory('handler', ['ktor'])
        .withSource({ file: info.fullPath, line: route.line, end_line: route.line })
        .withParent(routeId)
        .withMetadata({
          framework: 'ktor',
          attributes: { method: route.method, path: route.path, respond: route.respond, receive: route.receive },
        })
        .withTags(['ktor-handler'])
        .build());
      edges.push(this.createEdge(`${routeId}_handles_${handlerId}`, routeId, handlerId, 'handles', 'behavior', {
        attributes: { framework: 'ktor' },
      }));

      entryPoints.push(this.createEntryPoint(
        `entry_${routeId}`,
        routeId,
        'http',
        label,
        `Ktor HTTP route handled at ${info.relativePath}:${route.line}`,
        { method: route.method, path: route.path },
        {
          authenticated: route.authenticated,
          guards: route.authNames,
          authorized_roles: [],
        },
        { framework: 'ktor', kind: 'route', method: route.method, path: route.path, file: info.relativePath, line: route.line, language: 'kotlin' },
        { node_id: handlerId, method_name: `${route.method} ${route.path}`, file: info.relativePath, line: route.line }
      ));
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private fileId(relativePath: string): string {
    return `file_${this.sanitizeId(relativePath)}`;
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'ktor-application';
      case 2: return 'ktor-plugins';
      case 3: return 'ktor-routes';
      case 4: return 'ktor-handlers';
      default: return `ktor-level-${level}`;
    }
  }

  protected getCapabilities(): string[] {
    return ['ktor-routes', 'ktor-plugins', 'ktor-auth', 'ktor-modules'];
  }
}

export default { KtorAnalyzer };
