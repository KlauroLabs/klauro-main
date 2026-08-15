import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, FileAnalysisResult
} from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';
import * as path from 'path';





























const JAVA_GLOBS = ['**/*.java'];
const BUILD_GLOBS = [
  '**/pom.xml', '**/build.gradle', '**/build.gradle.kts', '**/settings.gradle',
];

const JAXRS_HTTP_ANNOTATIONS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);

interface JaxRsRoute {
  method: string;
  path: string;
  handlerName: string;
  line: number;
  produces?: string;
  consumes?: string;
  authenticated: boolean;
  roles: string[];
}

interface JaxRsProvider {
  name: string;
  kind: string;
  line: number;
}

interface JaxRsFileInfo {
  relativePath: string;
  fullPath: string;
  lineCount: number;
  className: string | null;
  isResource: boolean;
  routes: JaxRsRoute[];
  providers: JaxRsProvider[];
}

export class JaxRsAnalyzer extends BaseAnalyzer {
  constructor() {
    super('jaxrs', 'JAX-RS / Jersey Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      let hasJaxRsDependency = false;
      let hasQuarkus = false;
      let hasMicronaut = false;

      const buildFiles = await glob(BUILD_GLOBS, {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true,
      });
      for (const rel of buildFiles) {
        const content = await fs.readFile(path.join(projectPath, rel), 'utf-8').catch(() => '');
        if (/jersey-server|jersey-core|jakarta\.ws\.rs-api|javax\.ws\.rs-api|jaxrs-ri|resteasy/.test(content)) {
          hasJaxRsDependency = true;
        }
        if (/io\.quarkus|quarkus-/.test(content)) hasQuarkus = true;
        if (/io\.micronaut/.test(content)) hasMicronaut = true;
      }


      for (const propRel of ['src/main/resources/application.properties', 'application.properties']) {
        const propPath = path.join(projectPath, propRel);
        if (await fs.pathExists(propPath)) {
          const content = await fs.readFile(propPath, 'utf-8').catch(() => '');
          if (/^\s*quarkus\./m.test(content)) hasQuarkus = true;
        }
      }

      if (hasQuarkus || hasMicronaut) return false;

      if (hasJaxRsDependency) return true;


      const javaFiles = await glob(JAVA_GLOBS, {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true,
      });
      let sawJaxRsImport = false;
      for (const rel of javaFiles) {
        const content = await fs.readFile(path.join(projectPath, rel), 'utf-8').catch(() => '');
        if (/import\s+io\.quarkus/.test(content) || /import\s+io\.micronaut/.test(content)) return false;
        if (/import\s+(?:jakarta|javax)\.ws\.rs/.test(content)) sawJaxRsImport = true;
      }
      return sawJaxRsImport;
    } catch {
      return false;
    }
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    const files = await glob(JAVA_GLOBS, {
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

    const info = this.parseJavaFile(context.relativePath, context.filePath, content);
    this.emitFileContribution(info, nodes, edges, entryPoints, exitPoints);

    const exports = [
      ...(info.className ? [info.className] : []),
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
      let javaFiles = await glob(JAVA_GLOBS, {
        cwd: context.projectPath,
        ignore: [...this.getIgnorePatterns(context), '**/*.class'],
        nodir: true,
      });
      javaFiles.sort();
      javaFiles = this.capAndPrioritizeSourceFiles(javaFiles, 'java files');

      const fileInfos: JaxRsFileInfo[] = [];
      for (const relativePath of javaFiles) {
        const fullPath = path.join(context.projectPath, relativePath);
        let content = '';
        try {
          content = await fs.readFile(fullPath, 'utf-8');
        } catch {
          continue;
        }
        if (!/@Path\b|@(?:GET|POST|PUT|DELETE|PATCH)\b|@Provider\b/.test(content)) continue;
        fileInfos.push(this.parseJavaFile(relativePath, fullPath, content));
      }

      for (const info of fileInfos) {
        this.emitFileContribution(info, nodes, edges, entryPoints, exitPoints);
      }

      const routeCount = entryPoints.filter(ep => ep.metadata?.kind === 'route').length;
      const authRouteCount = entryPoints.filter(ep => ep.security?.authenticated).length;
      const providerCount = nodes.filter(n => n.type === 'provider').length;

      const warnings = this.collectAnalysisWarnings();
      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        ...(warnings.length > 0 ? { warnings } : {}),
        framework: 'jaxrs',
        framework_specific: {
          framework: 'jaxrs',
          filesAnalyzed: fileInfos.length,
          routes: routeCount,
          authenticatedRoutes: authRouteCount,
          providers: providerCount,
        },
      });
    } catch (error) {
      throw new AnalyzerError(
        `JAX-RS analysis failed: ${(error as Error).message}`,
        'JAXRS_ANALYSIS_ERROR'
      );
    }
  }





  private parseJavaFile(relativePath: string, fullPath: string, content: string): JaxRsFileInfo {
    const lines = content.split('\n');
    const className = this.extractClassName(content);
    const classPath = this.extractClassPath(content);
    const isResource = /@Path\b/.test(content) && /class\s+\w+/.test(content);

    return {
      relativePath,
      fullPath,
      lineCount: lines.length,
      className,
      isResource,
      routes: this.extractRoutes(lines, classPath),
      providers: this.extractProviders(lines, className),
    };
  }

  private extractClassName(content: string): string | null {
    const m = content.match(/(?:public\s+)?(?:abstract\s+)?class\s+(\w+)/);
    return m ? m[1] : null;
  }


  private extractClassPath(content: string): string {
    const classPathMatch = content.match(/@Path\s*\(\s*"([^"]*)"\s*\)\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:public\s+)?(?:abstract\s+)?class\b/);
    return classPathMatch ? this.normalizeSegment(classPathMatch[1]) : '';
  }





  private extractRoutes(lines: string[], classPath: string): JaxRsRoute[] {
    const routes: JaxRsRoute[] = [];
    for (let i = 0; i < lines.length; i++) {
      const httpMatch = lines[i].match(/@(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/);
      if (!httpMatch) continue;
      const httpAnn = httpMatch[1];
      if (!JAXRS_HTTP_ANNOTATIONS.has(httpAnn)) continue;

      let subPath = '';
      let produces: string | undefined;
      let consumes: string | undefined;
      let authenticated = false;
      let roles: string[] = [];
      let handlerName = '';
      const windowEnd = Math.min(lines.length, i + 12);
      for (let j = i; j < windowEnd; j++) {
        const line = lines[j];
        const subMatch = line.match(/@Path\s*\(\s*"([^"]*)"\s*\)/);
        if (subMatch) subPath = this.normalizeSegment(subMatch[1]);
        const prodMatch = line.match(/@Produces\s*\(\s*([^)]*)\)/);
        if (prodMatch) produces = this.cleanMediaType(prodMatch[1]);
        const consMatch = line.match(/@Consumes\s*\(\s*([^)]*)\)/);
        if (consMatch) consumes = this.cleanMediaType(consMatch[1]);
        const rolesMatch = line.match(/@RolesAllowed\s*\(\s*([^)]*)\)/);
        if (rolesMatch) {
          authenticated = true;
          roles = [...rolesMatch[1].matchAll(/"([^"]*)"/g)].map(m => m[1]);
        }
        if (/@(Authenticated|DenyAll)\b/.test(line)) authenticated = true;
        if (/@PermitAll\b/.test(line)) authenticated = false;
        const sig = line.match(/\b(?:public|protected|private)?\s*[\w<>\[\],.?\s]+?\s+(\w+)\s*\(/);
        if (sig && !line.includes('@') && !line.trim().startsWith('//')) {
          handlerName = sig[1];
          break;
        }
      }

      const fullPath = this.joinPath(classPath, subPath) || '/';
      routes.push({
        method: httpAnn,
        path: fullPath,
        handlerName: handlerName || `${httpAnn.toLowerCase()}Handler`,
        line: i + 1,
        produces,
        consumes,
        authenticated,
        roles,
      });
    }
    return routes;
  }


  private extractProviders(lines: string[], className: string | null): JaxRsProvider[] {
    if (!className) return [];
    const providers: JaxRsProvider[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!/@Provider\b/.test(lines[i])) continue;
      const block = lines.slice(i, Math.min(lines.length, i + 6)).join(' ');
      let kind = 'provider';
      if (/ExceptionMapper/.test(block)) kind = 'exception-mapper';
      else if (/ContextResolver/.test(block)) kind = 'context-resolver';
      else if (/MessageBodyReader/.test(block)) kind = 'message-body-reader';
      else if (/MessageBodyWriter/.test(block)) kind = 'message-body-writer';
      else if (/ContainerRequestFilter/.test(block)) kind = 'request-filter';
      else if (/ContainerResponseFilter/.test(block)) kind = 'response-filter';
      providers.push({ name: className, kind, line: i + 1 });
      break;
    }
    return providers;
  }

  private normalizeSegment(seg: string): string {
    if (!seg) return '';
    let s = seg.trim();
    if (!s.startsWith('/')) s = `/${s}`;
    return s.replace(/\/+$/, '') || '/';
  }

  private joinPath(a: string, b: string): string {
    const left = a && a !== '/' ? a : '';
    const right = b && b !== '/' ? b : '';
    if (!left && !right) return '/';
    return `${left}${right}`.replace(/\/{2,}/g, '/');
  }

  private cleanMediaType(raw: string): string {
    return raw.replace(/MediaType\./g, '').replace(/["'{}]/g, '').trim();
  }





  private emitFileContribution(
    info: JaxRsFileInfo,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[]
  ): void {
    const fileSlug = this.sanitizeId(info.relativePath);

    let resourceId: string | null = null;
    if (info.isResource && info.className) {
      resourceId = `jaxrs_resource_${fileSlug}_${this.sanitizeId(info.className)}`;
      nodes.push(this.createNodeBuilder(resourceId, info.className, 'controller')
        .withLevel(2, 'jaxrs-resources')
        .withCategory('controller', ['api', 'rest', 'jax-rs'])
        .withSource({ file: info.fullPath, line: 1, end_line: info.lineCount })
        .withDescription(`JAX-RS resource: ${info.className}`)
        .withMetadata({
          framework: 'jaxrs',
          attributes: { className: info.className, routeCount: info.routes.length, file: info.relativePath },
        })
        .withTags(['jaxrs-resource'])
        .build());
    }

    info.routes.forEach((route, index) => {
      const routeId = `jaxrs_route_${fileSlug}_${route.method}_${this.sanitizeId(route.path)}_${index}`;
      const label = `${route.method} ${route.path}`;
      const tags = ['jaxrs-route'];
      if (route.authenticated) tags.push('auth-gated', 'security');

      nodes.push(this.createNodeBuilder(routeId, label, 'route')
        .withLevel(3, 'jaxrs-routes')
        .withCategory('route', ['http', 'endpoint', 'jax-rs'])
        .withSource({ file: info.fullPath, line: route.line, end_line: route.line })
        .withParent(resourceId || undefined)
        .withDescription(`JAX-RS HTTP endpoint: ${label}${route.authenticated ? ' (authenticated)' : ''}`)
        .withMetadata({
          framework: 'jaxrs',
          attributes: {
            method: route.method,
            path: route.path,
            handlerName: route.handlerName,
            produces: route.produces,
            consumes: route.consumes,
            authenticated: route.authenticated,
            roles: route.roles,
            file: info.relativePath,
          },
        })
        .withTags(tags)
        .build());

      if (resourceId) {
        edges.push(this.createEdge(`${resourceId}_exposes_${routeId}`, resourceId, routeId, 'exposes', 'behavior', {
          attributes: { framework: 'jaxrs' },
        }));
      }

      entryPoints.push(this.createEntryPoint(
        `entry_${routeId}`,
        routeId,
        'http',
        label,
        `JAX-RS route handled at ${info.relativePath}:${route.line}`,
        { method: route.method, path: route.path },
        { authenticated: route.authenticated, authorized_roles: route.roles, guards: [] },
        {
          framework: 'jaxrs', kind: 'route', method: route.method, path: route.path,
          handler: route.handlerName, file: info.relativePath, line: route.line, language: 'java',
        },
        { node_id: routeId, method_name: route.handlerName, file: info.relativePath, line: route.line }
      ));
    });

    for (const provider of info.providers) {
      const providerId = `jaxrs_provider_${fileSlug}_${this.sanitizeId(provider.name)}`;
      nodes.push(this.createNodeBuilder(providerId, provider.name, 'provider')
        .withLevel(2, 'jaxrs-resources')
        .withCategory('provider', ['jax-rs', provider.kind])
        .withSource({ file: info.fullPath, line: provider.line, end_line: provider.line })
        .withDescription(`JAX-RS provider (${provider.kind}): ${provider.name}`)
        .withMetadata({
          framework: 'jaxrs',
          attributes: { kind: provider.kind, file: info.relativePath },
        })
        .withTags(['jaxrs-provider', provider.kind])
        .build());

      exitPoints.push(this.createExitPoint(
        `exit_${providerId}`,
        providerId,
        'api',
        `JAX-RS provider: ${provider.name}`,
        `JAX-RS ${provider.kind} registered via @Provider`,
        { resource: provider.name },
        { action: provider.kind },
        { framework: 'jaxrs', kind: provider.kind, name: provider.name }
      ));
    }
  }





  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'jaxrs-application';
      case 2: return 'jaxrs-resources';
      case 3: return 'jaxrs-routes';
      case 4: return 'jaxrs-handlers';
      default: return `jaxrs-level-${level}`;
    }
  }

  protected getCapabilities(): string[] {
    return ['jaxrs-resources', 'jaxrs-routes', 'jaxrs-providers'];
  }
}

export default { JaxRsAnalyzer };
