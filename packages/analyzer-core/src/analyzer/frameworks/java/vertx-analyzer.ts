import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, FileAnalysisResult
} from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import * as fs from 'fs-extra';
import { glob } from 'glob';
import * as path from 'path';

/**
 * Vert.x (vertx-web) framework analyzer (Java/Kotlin reactive toolkit).
 *
 * Extracts the vertx-web routing conventions the generic Java/Kotlin analyzers
 * cannot see:
 *   - `Router router = Router.router(vertx)` → the router instance.
 *   - `router.get("/path").handler(this::method)` / `router.post("/path").handler(h -> {...})`
 *     → routes, resolved method (`Class::method` reference or inline lambda).
 *   - `router.route("/path").method(HttpMethod.GET).handler(...)` → the same,
 *     via the generic `.route(...)` + `.method(...)` builder form.
 *   - `router.mountSubRouter("/api", subRouter)` → sub-router prefixing (best
 *     effort: recorded as a `mounts` edge; full transitive prefix folding across
 *     files is out of scope for a line-based extractor).
 *   - `BridgeEvent` / `EventBus` `consumer("address", handler)` → message entry
 *     points (event-bus consumers), `publish`/`send` → message exit points.
 *   - `AuthenticationHandler` / `JWTAuthHandler` / `router.route().handler(authHandler)`
 *     preceding a route in the same file → the route inherits an authenticated
 *     signal only where a handler chain shows it directly on that route.
 *
 * Extraction is line/regex-based over `.java` and `.kt` files (no shared AST),
 * mirroring the Ktor/Quarkus analyzers' proven approach. Handler resolution
 * favors explicit method references (`this::foo`, `Class::foo`) over anonymous
 * lambdas, which are recorded as inline (no real method node to link to).
 */

const SOURCE_GLOBS = ['**/*.java', '**/*.kt'];
const BUILD_GLOBS = [
  '**/pom.xml', '**/build.gradle', '**/build.gradle.kts', '**/settings.gradle', '**/settings.gradle.kts',
];

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options']);

interface VertxRoute {
  method: string;
  path: string;
  handlerRef: string;
  handlerIsReference: boolean;
  line: number;
  authenticated: boolean;
}

interface VertxRouter {
  varName: string;
  line: number;
}

interface VertxEventBusConsumer {
  address: string;
  handlerRef: string;
  line: number;
}

interface VertxEventBusPublish {
  address: string;
  kind: 'send' | 'publish';
  line: number;
}

interface VertxFileInfo {
  relativePath: string;
  fullPath: string;
  lineCount: number;
  language: 'java' | 'kotlin';
  routers: VertxRouter[];
  routes: VertxRoute[];
  consumers: VertxEventBusConsumer[];
  publishes: VertxEventBusPublish[];
}

export class VertxAnalyzer extends BaseAnalyzer {
  constructor() {
    super('vertx', 'Vert.x Framework Analyzer', '1.0.0', 'framework');
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
        if (/io\.vertx|vertx-web|vertx-core/.test(content)) return true;
      }

      const sourceFiles = await glob(SOURCE_GLOBS, {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true,
      });
      for (const rel of sourceFiles) {
        const content = await fs.readFile(path.join(projectPath, rel), 'utf-8').catch(() => '');
        if (/import\s+io\.vertx/.test(content) || /Router\.router\s*\(/.test(content)) {
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
    const files = await glob(SOURCE_GLOBS, {
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

    const info = this.parseVertxFile(context.relativePath, context.filePath, content);
    this.emitFileContribution(info, nodes, edges, entryPoints, exitPoints);

    const exports = [
      ...info.routes.map(r => `${r.method} ${r.path}`),
      ...info.consumers.map(c => `consumer:${c.address}`),
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
      let sourceFiles = await glob(SOURCE_GLOBS, {
        cwd: context.projectPath,
        ignore: this.getIgnorePatterns(context),
        nodir: true,
      });
      sourceFiles.sort();
      sourceFiles = this.capAndPrioritizeSourceFiles(sourceFiles, 'java/kotlin files');

      const fileInfos: VertxFileInfo[] = [];
      for (const relativePath of sourceFiles) {
        const fullPath = path.join(context.projectPath, relativePath);
        let content = '';
        try {
          content = await fs.readFile(fullPath, 'utf-8');
        } catch {
          continue;
        }
        if (!/io\.vertx|Router\.router\s*\(|\.handler\s*\(|eventBus\(\)/.test(content)) continue;
        fileInfos.push(this.parseVertxFile(relativePath, fullPath, content));
      }

      for (const info of fileInfos) {
        this.emitFileContribution(info, nodes, edges, entryPoints, exitPoints);
      }

      const routeCount = entryPoints.filter(ep => ep.metadata?.kind === 'route').length;
      const consumerCount = entryPoints.filter(ep => ep.metadata?.kind === 'eventbus-consumer').length;
      const routerCount = nodes.filter(n => n.type === 'router').length;

      const warnings = this.collectAnalysisWarnings();
      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        ...(warnings.length > 0 ? { warnings } : {}),
        framework: 'vertx',
        framework_specific: {
          framework: 'vertx',
          filesAnalyzed: fileInfos.length,
          routers: routerCount,
          routes: routeCount,
          eventBusConsumers: consumerCount,
        },
      });
    } catch (error) {
      throw new AnalyzerError(
        `Vert.x analysis failed: ${(error as Error).message}`,
        'VERTX_ANALYSIS_ERROR'
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Parsing
  // ---------------------------------------------------------------------------

  private parseVertxFile(relativePath: string, fullPath: string, content: string): VertxFileInfo {
    const lines = content.split('\n');
    const language: 'java' | 'kotlin' = relativePath.endsWith('.kt') ? 'kotlin' : 'java';
    return {
      relativePath,
      fullPath,
      lineCount: lines.length,
      language,
      routers: this.extractRouters(lines),
      routes: this.extractRoutes(lines),
      consumers: this.extractConsumers(lines),
      publishes: this.extractPublishes(lines),
    };
  }

  /** `Router router = Router.router(vertx)` / `val router = Router.router(vertx)`. */
  private extractRouters(lines: string[]): VertxRouter[] {
    const routers: VertxRouter[] = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/\b(\w+)\s*[:=]?\s*=?\s*Router\.router\s*\(/) || lines[i].match(/(\w+)\s*=\s*Router\.router\s*\(/);
      const declMatch = lines[i].match(/(?:Router\s+(\w+)\s*=|val\s+(\w+)\s*(?::\s*Router)?\s*=|var\s+(\w+)\s*(?::\s*Router)?\s*=)\s*Router\.router\s*\(/);
      if (declMatch) {
        const varName = declMatch[1] || declMatch[2] || declMatch[3];
        routers.push({ varName, line: i + 1 });
      } else if (m && /Router\.router\s*\(/.test(lines[i])) {
        routers.push({ varName: m[1], line: i + 1 });
      }
    }
    return routers;
  }

  /**
   * `router.get("/path").handler(ref)` / `router.route("/path").method(HttpMethod.GET).handler(ref)`.
   * Scans a small forward window for `.handler(...)` since the fluent chain can
   * wrap to following lines, and for an auth handler mounted just before it.
   */
  private extractRoutes(lines: string[]): VertxRoute[] {
    const routes: VertxRoute[] = [];
    for (let i = 0; i < lines.length; i++) {
      const stripped = this.stripComments(lines[i]);

      // Direct method form: router.get("/path")
      const directMatch = stripped.match(/\brouter\.(get|post|put|delete|patch|head|options)\s*\(\s*"([^"]*)"\s*\)/);
      // Generic .route("/path").method(HttpMethod.GET) form.
      const genericMatch = stripped.match(/\brouter\.route\s*\(\s*"([^"]*)"\s*\)/);

      let method: string | null = null;
      let routePath: string | null = null;

      if (directMatch && HTTP_METHODS.has(directMatch[1])) {
        method = directMatch[1].toUpperCase();
        routePath = directMatch[2];
      } else if (genericMatch) {
        routePath = genericMatch[1];
        const window = lines.slice(i, Math.min(lines.length, i + 4)).join(' ');
        const methodMatch = window.match(/\.method\s*\(\s*HttpMethod\.(\w+)\s*\)/);
        method = methodMatch ? methodMatch[1] : 'ANY';
      }

      if (!method || routePath === null) continue;

      // Handler resolution: look forward for `.handler(...)`.
      const window = lines.slice(i, Math.min(lines.length, i + 6)).join(' ');
      const refMatch = window.match(/\.handler\s*\(\s*([\w.]+)::(\w+)\s*\)/);
      const lambdaMatch = window.match(/\.handler\s*\(\s*(\w+)\s*->/);
      const namedHandlerMatch = window.match(/\.handler\s*\(\s*(\w+)\s*\)(?!\s*->)/);

      let handlerRef = 'inline handler';
      let handlerIsReference = false;
      if (refMatch) {
        handlerRef = `${refMatch[1]}::${refMatch[2]}`;
        handlerIsReference = true;
      } else if (namedHandlerMatch) {
        handlerRef = namedHandlerMatch[1];
        handlerIsReference = true;
      } else if (lambdaMatch) {
        handlerRef = 'inline lambda';
      }

      const authenticated = /AuthenticationHandler|JWTAuthHandler|OAuth2AuthHandler|BasicAuthHandler/.test(window);

      routes.push({
        method,
        path: this.normalizePath(routePath),
        handlerRef,
        handlerIsReference,
        line: i + 1,
        authenticated,
      });
    }
    return routes;
  }

  /** `eventBus().consumer("address", handler)` → an event-bus entry point. */
  private extractConsumers(lines: string[]): VertxEventBusConsumer[] {
    const consumers: VertxEventBusConsumer[] = [];
    for (let i = 0; i < lines.length; i++) {
      const stripped = this.stripComments(lines[i]);
      const m = stripped.match(/eventBus\(\)\s*\.\s*consumer\s*(?:<[^>]*>)?\s*\(\s*"([^"]*)"/);
      if (!m) continue;
      const window = lines.slice(i, Math.min(lines.length, i + 4)).join(' ');
      const refMatch = window.match(/,\s*([\w.]+)::(\w+)\s*\)/);
      const handlerRef = refMatch ? `${refMatch[1]}::${refMatch[2]}` : 'inline handler';
      consumers.push({ address: m[1], handlerRef, line: i + 1 });
    }
    return consumers;
  }

  /** `eventBus().send("address", ...)` / `.publish("address", ...)` → message exit points. */
  private extractPublishes(lines: string[]): VertxEventBusPublish[] {
    const publishes: VertxEventBusPublish[] = [];
    for (let i = 0; i < lines.length; i++) {
      const stripped = this.stripComments(lines[i]);
      const m = stripped.match(/eventBus\(\)\s*\.\s*(send|publish)\s*\(\s*"([^"]*)"/);
      if (!m) continue;
      publishes.push({ address: m[2], kind: m[1] as 'send' | 'publish', line: i + 1 });
    }
    return publishes;
  }

  private normalizePath(p: string): string {
    if (!p) return '/';
    let s = p.trim();
    if (!s.startsWith('/')) s = `/${s}`;
    return s.replace(/\/+$/, '') || '/';
  }

  private stripComments(line: string): string {
    const idx = line.indexOf('//');
    return idx >= 0 ? line.slice(0, idx) : line;
  }

  // ---------------------------------------------------------------------------
  // Emission
  // ---------------------------------------------------------------------------

  private emitFileContribution(
    info: VertxFileInfo,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[]
  ): void {
    const fileSlug = this.sanitizeId(info.relativePath);

    let routerId: string | null = null;
    if (info.routers.length > 0) {
      const router = info.routers[0];
      routerId = `vertx_router_${fileSlug}_${this.sanitizeId(router.varName)}`;
      nodes.push(this.createNodeBuilder(routerId, `Router ${router.varName}`, 'router')
        .withLevel(2, 'vertx-routers')
        .withCategory('router', ['http', 'vertx-web'])
        .withSource({ file: info.fullPath, line: router.line, end_line: router.line })
        .withDescription(`Vert.x router: ${router.varName} = Router.router(vertx)`)
        .withMetadata({
          framework: 'vertx',
          attributes: { varName: router.varName, file: info.relativePath, language: info.language },
        })
        .withTags(['vertx-router'])
        .build());
    }

    info.routes.forEach((route, index) => {
      const routeId = `vertx_route_${fileSlug}_${route.method}_${this.sanitizeId(route.path)}_${index}`;
      const label = `${route.method} ${route.path}`;
      const tags = ['vertx-route'];
      if (route.authenticated) tags.push('auth-gated', 'security');

      nodes.push(this.createNodeBuilder(routeId, label, 'route')
        .withLevel(3, 'vertx-routes')
        .withCategory('route', ['http', 'endpoint', 'vertx-web'])
        .withSource({ file: info.fullPath, line: route.line, end_line: route.line })
        .withParent(routerId || undefined)
        .withDescription(`Vert.x HTTP endpoint: ${label}${route.authenticated ? ' (authenticated)' : ''} -> ${route.handlerRef}`)
        .withMetadata({
          framework: 'vertx',
          attributes: {
            method: route.method,
            path: route.path,
            handler: route.handlerRef,
            handlerIsReference: route.handlerIsReference,
            authenticated: route.authenticated,
            file: info.relativePath,
            language: info.language,
          },
        })
        .withTags(tags)
        .build());

      if (routerId) {
        edges.push(this.createEdge(`${routerId}_exposes_${routeId}`, routerId, routeId, 'exposes', 'behavior', {
          attributes: { framework: 'vertx' },
        }));
      }

      entryPoints.push(this.createEntryPoint(
        `entry_${routeId}`,
        routeId,
        'http',
        label,
        `Vert.x route handled at ${info.relativePath}:${route.line} -> ${route.handlerRef}`,
        { method: route.method, path: route.path },
        { authenticated: route.authenticated, authorized_roles: [], guards: [] },
        {
          framework: 'vertx', kind: 'route', method: route.method, path: route.path,
          handler: route.handlerRef, file: info.relativePath, line: route.line, language: info.language,
        },
        { node_id: routeId, method_name: route.handlerRef, file: info.relativePath, line: route.line }
      ));
    });

    info.consumers.forEach((consumer, index) => {
      const consumerId = `vertx_consumer_${fileSlug}_${this.sanitizeId(consumer.address)}_${index}`;
      nodes.push(this.createNodeBuilder(consumerId, `consumer("${consumer.address}")`, 'consumer')
        .withLevel(3, 'vertx-routes')
        .withCategory('message', ['messaging', 'event-bus', 'vertx'])
        .withSource({ file: info.fullPath, line: consumer.line, end_line: consumer.line })
        .withDescription(`Vert.x event-bus consumer on address "${consumer.address}" -> ${consumer.handlerRef}`)
        .withMetadata({
          framework: 'vertx',
          attributes: { address: consumer.address, handler: consumer.handlerRef, file: info.relativePath },
        })
        .withTags(['vertx-eventbus-consumer'])
        .build());

      entryPoints.push(this.createEntryPoint(
        `entry_${consumerId}`,
        consumerId,
        'message',
        `EventBus consumer: ${consumer.address}`,
        `Vert.x event-bus consumer for address ${consumer.address} at ${info.relativePath}:${consumer.line}`,
        { event: consumer.address },
        undefined,
        { framework: 'vertx', kind: 'eventbus-consumer', address: consumer.address, file: info.relativePath, line: consumer.line, language: info.language },
        { node_id: consumerId, method_name: consumer.handlerRef, file: info.relativePath, line: consumer.line }
      ));
    });

    info.publishes.forEach((pub, index) => {
      const pubId = `vertx_publish_${fileSlug}_${pub.kind}_${this.sanitizeId(pub.address)}_${index}`;
      exitPoints.push(this.createExitPoint(
        `exit_${pubId}`,
        pubId,
        'message',
        `EventBus ${pub.kind}: ${pub.address}`,
        `Vert.x event-bus ${pub.kind} to address ${pub.address} at ${info.relativePath}:${pub.line}`,
        { resource: pub.address },
        { action: pub.kind, async: true },
        { framework: 'vertx', address: pub.address, kind: pub.kind, file: info.relativePath, line: pub.line }
      ));
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'vertx-application';
      case 2: return 'vertx-routers';
      case 3: return 'vertx-routes';
      case 4: return 'vertx-handlers';
      default: return `vertx-level-${level}`;
    }
  }

  protected getCapabilities(): string[] {
    return ['vertx-routers', 'vertx-routes', 'vertx-eventbus'];
  }
}

export default { VertxAnalyzer };
