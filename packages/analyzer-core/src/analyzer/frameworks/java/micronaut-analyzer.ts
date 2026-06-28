import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, FileAnalysisResult
} from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import * as fs from 'fs-extra';
import { glob } from 'glob';
import * as path from 'path';

/**
 * Micronaut framework analyzer (Java, compile-time-DI JVM microservices).
 *
 * Extracts the Micronaut-specific conventions the generic Java analyzer cannot see:
 *   - Controllers: `@Controller("/x")` classes + `@Get/@Post/@Put/@Delete("/sub")` → routes.
 *   - Beans: `@Singleton/@Bean/@Factory` + `@Inject` / constructor injection.
 *   - Data: `@Entity` / `@MappedEntity` + `@Repository interface X extends CrudRepository<E,ID>`.
 *   - Scheduling / async: `@Scheduled`, `@Async`.
 *   - Declarative HTTP clients: `@Client("svc")` → external service nodes.
 *
 * Extraction is annotation/line-based over `.java` files. Per-file extraction is
 * factored into {@link parseJavaFile} + {@link emitFileContribution} so both full
 * `analyze()` and incremental `analyzeFileSingle()` share one code path.
 */

const JAVA_GLOBS = ['**/*.java'];
const BUILD_GLOBS = [
  '**/pom.xml', '**/build.gradle', '**/build.gradle.kts', '**/settings.gradle',
];

const HTTP_METHOD_ANNOTATIONS = new Set(['Get', 'Post', 'Put', 'Delete', 'Patch', 'Head', 'Options', 'Trace']);

interface MicronautRoute {
  method: string;        // GET/POST/...
  path: string;          // resolved full path
  handlerName: string;
  line: number;
  produces?: string;
  authenticated: boolean;
}

interface MicronautBean {
  name: string;
  stereotype: 'Singleton' | 'Bean' | 'Factory';
  injects: string[];
  line: number;
}

interface MicronautEntity {
  name: string;
  kind: 'entity' | 'mapped-entity' | 'repository';
  superType?: string;     // CrudRepository<E,ID> element type
  fields: Array<{ name: string; type: string }>;
  line: number;
}

interface MicronautScheduled {
  handlerName: string;
  cron?: string;
  fixedRate?: string;
  line: number;
}

interface MicronautClient {
  name: string;            // interface name
  serviceId: string;       // @Client("...") value
  line: number;
}

interface MicronautFileInfo {
  relativePath: string;
  fullPath: string;
  lineCount: number;
  className: string | null;
  isController: boolean;
  routes: MicronautRoute[];
  beans: MicronautBean[];
  entities: MicronautEntity[];
  scheduled: MicronautScheduled[];
  clients: MicronautClient[];
}

export class MicronautAnalyzer extends BaseAnalyzer {
  constructor() {
    super('micronaut', 'Micronaut Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      // 1. Build-file dependency signal (io.micronaut).
      const buildFiles = await glob(BUILD_GLOBS, {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true,
      });
      for (const rel of buildFiles) {
        const content = await fs.readFile(path.join(projectPath, rel), 'utf-8').catch(() => '');
        if (/io\.micronaut/.test(content)) return true;
      }

      // 2. Source-level signal: io.micronaut imports or @Controller usage.
      const javaFiles = await glob(JAVA_GLOBS, {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true,
      });
      for (const rel of javaFiles) {
        const content = await fs.readFile(path.join(projectPath, rel), 'utf-8').catch(() => '');
        if (/import\s+io\.micronaut/.test(content)) return true;
        // @Controller from micronaut.http.annotation specifically.
        if (/import\s+io\.micronaut\.http\.annotation/.test(content)) return true;
        if (/@Controller\b/.test(content) && /micronaut/.test(content)) return true;
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
      ...info.entities.map(e => e.name),
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

      const fileInfos: MicronautFileInfo[] = [];
      for (const relativePath of javaFiles) {
        const fullPath = path.join(context.projectPath, relativePath);
        let content = '';
        try {
          content = await fs.readFile(fullPath, 'utf-8');
        } catch {
          continue;
        }
        // Skip files with no Micronaut signal to keep the contribution focused.
        if (!/@Controller\b|@(?:Get|Post|Put|Delete|Patch)\b|@Singleton\b|@Factory\b|@Bean\b|@Inject\b|@MappedEntity\b|@Entity\b|@Repository\b|@Scheduled\b|@Client\b|io\.micronaut/.test(content)) {
          continue;
        }
        fileInfos.push(this.parseJavaFile(relativePath, fullPath, content));
      }

      // Resolve injected collaborators across files: a bean's `@Inject`/ctor dep
      // type names to the actual bean/repository node id (which carries a per-file
      // slug). Without this the DI edges dangled (target matched no node).
      const injectableIdByName = new Map<string, string>();
      for (const info of fileInfos) {
        const slug = this.sanitizeId(info.relativePath);
        for (const bean of info.beans) {
          injectableIdByName.set(bean.name, `micronaut_bean_${slug}_${this.sanitizeId(bean.name)}`);
        }
        for (const entity of info.entities) {
          if (entity.kind === 'repository') {
            injectableIdByName.set(entity.name, `micronaut_repository_${slug}_${this.sanitizeId(entity.name)}`);
          }
        }
      }

      for (const info of fileInfos) {
        this.emitFileContribution(info, nodes, edges, entryPoints, exitPoints, injectableIdByName);
      }

      const routeCount = entryPoints.filter(ep => ep.metadata?.kind === 'route').length;
      const beanCount = nodes.filter(n => n.type === 'bean').length;
      const entityCount = nodes.filter(n => n.type === 'model' || n.type === 'repository').length;
      const clientCount = nodes.filter(n => n.type === 'external-service').length;

      const warnings = this.collectAnalysisWarnings();
      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        ...(warnings.length > 0 ? { warnings } : {}),
        framework: 'micronaut',
        framework_specific: {
          framework: 'micronaut',
          filesAnalyzed: fileInfos.length,
          routes: routeCount,
          beans: beanCount,
          entities: entityCount,
          clients: clientCount,
        },
      });
    } catch (error) {
      throw new AnalyzerError(
        `Micronaut analysis failed: ${(error as Error).message}`,
        'MICRONAUT_ANALYSIS_ERROR'
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Parsing
  // ---------------------------------------------------------------------------

  private parseJavaFile(relativePath: string, fullPath: string, content: string): MicronautFileInfo {
    const lines = content.split('\n');
    const className = this.extractTypeName(content);
    const controllerBase = this.extractControllerBase(content);
    const isController = /@Controller\b/.test(content);

    return {
      relativePath,
      fullPath,
      lineCount: lines.length,
      className,
      isController,
      routes: this.extractRoutes(lines, controllerBase),
      beans: this.extractBeans(lines, content, className),
      entities: this.extractEntities(lines, className, content),
      scheduled: this.extractScheduled(lines),
      clients: this.extractClients(content, className),
    };
  }

  private extractTypeName(content: string): string | null {
    const m = content.match(/(?:public\s+)?(?:abstract\s+)?(?:class|interface)\s+(\w+)/);
    return m ? m[1] : null;
  }

  /** Class-level `@Controller("/x")` base path. */
  private extractControllerBase(content: string): string {
    const m = content.match(/@Controller\s*(?:\(\s*"([^"]*)"\s*\))?/);
    if (!m) return '';
    return m[1] ? this.normalizeSegment(m[1]) : '';
  }

  /** `@Get/@Post/...("/sub")` methods resolved against the controller base. */
  private extractRoutes(lines: string[], base: string): MicronautRoute[] {
    const routes: MicronautRoute[] = [];
    for (let i = 0; i < lines.length; i++) {
      const httpMatch = lines[i].match(/@(Get|Post|Put|Delete|Patch|Head|Options|Trace)\b\s*(?:\(\s*(?:value\s*=\s*)?"([^"]*)"\s*[^)]*\)|\(\s*\))?/);
      if (!httpMatch) continue;
      const ann = httpMatch[1];
      if (!HTTP_METHOD_ANNOTATIONS.has(ann)) continue;

      let subPath = httpMatch[2] ? this.normalizeSegment(httpMatch[2]) : '';
      let produces: string | undefined;
      let authenticated = false;
      let handlerName = '';
      const windowEnd = Math.min(lines.length, i + 12);
      for (let j = i; j < windowEnd; j++) {
        const line = lines[j];
        const prodMatch = line.match(/@Produces\s*\(\s*([^)]*)\)/);
        if (prodMatch) produces = this.cleanMediaType(prodMatch[1]);
        if (/@Secured\b|@RolesAllowed\b/.test(line) && !/IS_ANONYMOUS|isAnonymous|"isAnonymous"/.test(line)) {
          authenticated = true;
        }
        const sig = line.match(/\b(?:public|protected|private)?\s*[\w<>\[\],.?\s]+?\s+(\w+)\s*\(/);
        if (sig && !line.includes('@') && !line.trim().startsWith('//')) {
          handlerName = sig[1];
          break;
        }
      }

      const fullPath = this.joinPath(base, subPath) || '/';
      routes.push({
        method: ann.toUpperCase(),
        path: fullPath,
        handlerName: handlerName || `${ann.toLowerCase()}Handler`,
        line: i + 1,
        produces,
        authenticated,
      });
    }
    return routes;
  }

  /** Beans: `@Singleton/@Factory/@Bean` classes + `@Inject`/constructor deps. */
  private extractBeans(lines: string[], content: string, className: string | null): MicronautBean[] {
    const beans: MicronautBean[] = [];
    if (!className) return beans;

    let stereotype: MicronautBean['stereotype'] | null = null;
    let line = 1;
    for (let i = 0; i < lines.length; i++) {
      if (/@Singleton\b/.test(lines[i])) { stereotype = 'Singleton'; line = i + 1; }
      else if (/@Factory\b/.test(lines[i])) { stereotype = 'Factory'; line = i + 1; }
      else if (/@Bean\b/.test(lines[i]) && !stereotype) { stereotype = 'Bean'; line = i + 1; }
      if (stereotype && /(?:class|interface)\s+\w+/.test(lines[i])) break;
    }
    if (!stereotype) return beans;

    const injects = this.extractInjects(content, className);
    beans.push({ name: className, stereotype, injects, line });
    return beans;
  }

  /** `@Inject` fields + constructor-parameter types. */
  private extractInjects(content: string, className: string): string[] {
    const injects: string[] = [];

    // @Inject fields.
    const fieldPattern = /@Inject[\s\S]{0,80}?(?:[\w.]+\s+)?([A-Z]\w+)\s+\w+\s*;/g;
    let m: RegExpExecArray | null;
    while ((m = fieldPattern.exec(content)) !== null) injects.push(m[1]);

    // Constructor injection: `public ClassName(Foo foo, Bar bar) {`.
    const ctorMatch = content.match(new RegExp(`(?:public|protected)\\s+${className}\\s*\\(([^)]*)\\)`));
    if (ctorMatch && ctorMatch[1].trim()) {
      for (const param of ctorMatch[1].split(',')) {
        const pm = param.trim().match(/(?:@\w+(?:\([^)]*\))?\s+)*([A-Z][\w<>]*)\s+\w+/);
        if (pm) injects.push(pm[1].replace(/<.*>/, ''));
      }
    }
    return Array.from(new Set(injects));
  }

  /** `@Entity`/`@MappedEntity` types and `@Repository` interfaces. */
  private extractEntities(lines: string[], className: string | null, content: string): MicronautEntity[] {
    const entities: MicronautEntity[] = [];
    if (!className) return entities;

    const classLineIdx = lines.findIndex(l => new RegExp(`(?:class|interface)\\s+${className}\\b`).test(l));
    const line = classLineIdx >= 0 ? classLineIdx + 1 : 1;

    if (/@Repository\b/.test(content)) {
      const repoMatch = content.match(/extends\s+\w*Repository\w*\s*<\s*(\w+)\s*,/)
        || content.match(/extends\s+\w*Repository\w*\s*<\s*(\w+)\s*>/);
      entities.push({ name: className, kind: 'repository', superType: repoMatch ? repoMatch[1] : undefined, fields: [], line });
      return entities;
    }

    if (/@MappedEntity\b/.test(content)) {
      entities.push({ name: className, kind: 'mapped-entity', fields: this.extractEntityFields(content), line });
      return entities;
    }

    if (/@Entity\b/.test(content)) {
      entities.push({ name: className, kind: 'entity', fields: this.extractEntityFields(content), line });
    }
    return entities;
  }

  private extractEntityFields(content: string): Array<{ name: string; type: string }> {
    const fields: Array<{ name: string; type: string }> = [];
    const pattern = /(?:public|private|protected)\s+(?!class\b|interface\b|static\s+final\b)([\w<>\[\],.]+)\s+(\w+)\s*;/g;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) {
      fields.push({ type: m[1], name: m[2] });
    }
    return fields;
  }

  /** `@Scheduled(cron = "...")` / `@Scheduled(fixedRate = "...")`. */
  private extractScheduled(lines: string[]): MicronautScheduled[] {
    const jobs: MicronautScheduled[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!/@Scheduled\b/.test(lines[i])) continue;
      const block = lines.slice(i, Math.min(lines.length, i + 6)).join(' ');
      const cron = block.match(/cron\s*=\s*"([^"]*)"/)?.[1];
      const fixedRate = block.match(/fixedRate\s*=\s*"([^"]*)"/)?.[1];
      const sig = this.extractMethodName(block);
      jobs.push({ handlerName: sig || `scheduled${i}`, cron, fixedRate, line: i + 1 });
    }
    return jobs;
  }

  /** Declarative HTTP clients: `@Client("svc") interface FooClient`. */
  private extractClients(content: string, className: string | null): MicronautClient[] {
    const clients: MicronautClient[] = [];
    if (!className) return clients;
    const m = content.match(/@Client\s*\(\s*(?:id\s*=\s*)?"([^"]*)"\s*\)/);
    if (m) {
      clients.push({ name: className, serviceId: m[1], line: 1 });
    }
    return clients;
  }

  /** Pull the method identifier (the word immediately before the parameter `(`). */
  private extractMethodName(block: string): string | undefined {
    const cleaned = block.replace(/@\w+\s*\([^)]*\)/g, ' ').replace(/@\w+/g, ' ');
    const m = cleaned.match(/\b([A-Za-z_]\w*)\s*\(/);
    if (!m) return undefined;
    const name = m[1];
    if (['if', 'for', 'while', 'switch', 'catch', 'return', 'new'].includes(name)) return undefined;
    return name;
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

  // ---------------------------------------------------------------------------
  // Emission
  // ---------------------------------------------------------------------------

  private emitFileContribution(
    info: MicronautFileInfo,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[],
    injectableIdByName?: Map<string, string>
  ): void {
    const fileSlug = this.sanitizeId(info.relativePath);

    // Controller node groups its routes.
    let controllerId: string | null = null;
    if (info.isController && info.className) {
      controllerId = `micronaut_controller_${fileSlug}_${this.sanitizeId(info.className)}`;
      nodes.push(this.createNodeBuilder(controllerId, info.className, 'controller')
        .withLevel(2, 'micronaut-controllers')
        .withCategory('controller', ['api', 'rest', 'micronaut'])
        .withSource({ file: info.fullPath, line: 1, end_line: info.lineCount })
        .withDescription(`Micronaut controller: ${info.className}`)
        .withMetadata({
          framework: 'micronaut',
          attributes: { className: info.className, routeCount: info.routes.length, file: info.relativePath },
        })
        .withTags(['micronaut-controller'])
        .build());
    }

    // Routes + entry points.
    info.routes.forEach((route, index) => {
      const routeId = `micronaut_route_${fileSlug}_${route.method}_${this.sanitizeId(route.path)}_${index}`;
      const label = `${route.method} ${route.path}`;
      const tags = ['micronaut-route'];
      if (route.authenticated) tags.push('auth-gated', 'security');

      nodes.push(this.createNodeBuilder(routeId, label, 'route')
        .withLevel(3, 'micronaut-routes')
        .withCategory('route', ['http', 'endpoint', 'micronaut'])
        .withSource({ file: info.fullPath, line: route.line, end_line: route.line })
        .withParent(controllerId || undefined)
        .withDescription(`Micronaut HTTP endpoint: ${label}${route.authenticated ? ' (authenticated)' : ''}`)
        .withMetadata({
          framework: 'micronaut',
          attributes: {
            method: route.method,
            path: route.path,
            handlerName: route.handlerName,
            produces: route.produces,
            authenticated: route.authenticated,
            file: info.relativePath,
          },
        })
        .withTags(tags)
        .build());

      if (controllerId) {
        edges.push(this.createEdge(`${controllerId}_exposes_${routeId}`, controllerId, routeId, 'exposes', 'behavior', {
          attributes: { framework: 'micronaut' },
        }));
      }

      entryPoints.push(this.createEntryPoint(
        `entry_${routeId}`,
        routeId,
        'http',
        label,
        `Micronaut route handled at ${info.relativePath}:${route.line}`,
        { method: route.method, path: route.path },
        { authenticated: route.authenticated, authorized_roles: [], guards: [] },
        {
          framework: 'micronaut', kind: 'route', method: route.method, path: route.path,
          handler: route.handlerName, file: info.relativePath, line: route.line, language: 'java',
        },
        { node_id: routeId, method_name: route.handlerName, file: info.relativePath, line: route.line }
      ));
    });

    // Beans + injection edges.
    for (const bean of info.beans) {
      const beanId = `micronaut_bean_${fileSlug}_${this.sanitizeId(bean.name)}`;
      nodes.push(this.createNodeBuilder(beanId, bean.name, 'bean')
        .withLevel(2, 'micronaut-beans')
        .withCategory('bean', ['injectable', bean.stereotype.toLowerCase(), 'micronaut'])
        .withSource({ file: info.fullPath, line: bean.line, end_line: bean.line })
        .withDescription(`Micronaut bean (@${bean.stereotype}): ${bean.name}`)
        .withMetadata({
          framework: 'micronaut',
          attributes: { stereotype: bean.stereotype, injects: bean.injects, file: info.relativePath },
        })
        .withTags(['micronaut-bean'])
        .build());

      for (const dep of bean.injects) {
        // Resolve the injected type to the real collaborator node id (per-file
        // slug); fall back to the slug-less id only if unresolved.
        const targetId = injectableIdByName?.get(dep) || `micronaut_bean_${this.sanitizeId(dep)}`;
        edges.push({
          id: `${beanId}_injects_${this.sanitizeId(dep)}`,
          source: beanId,
          target: targetId,
          type: 'depends_on',
          metadata: { framework: 'micronaut', dependency_type: 'injection', attributes: { injectedType: dep } },
        } as CASEdge);
      }
    }

    // Entities + repositories.
    for (const entity of info.entities) {
      if (entity.kind === 'repository') {
        const repoId = `micronaut_repository_${fileSlug}_${this.sanitizeId(entity.name)}`;
        nodes.push(this.createNodeBuilder(repoId, entity.name, 'repository')
          .withLevel(2, 'micronaut-beans')
          .withCategory('repository', ['data-access', 'micronaut-data', 'micronaut'])
          .withSource({ file: info.fullPath, line: entity.line, end_line: entity.line })
          .withDescription(`Micronaut Data repository${entity.superType ? ` for ${entity.superType}` : ''}: ${entity.name}`)
          .withMetadata({
            framework: 'micronaut',
            attributes: { entityType: entity.superType, file: info.relativePath },
          })
          .withTags(['micronaut-repository', 'micronaut-data'])
          .build());
        if (entity.superType) {
          const entId = `micronaut_entity_${this.sanitizeId(entity.superType)}`;
          edges.push(this.createEdge(`${repoId}_manages_${this.sanitizeId(entity.superType)}`, repoId, entId, 'depends_on', 'data', {
            attributes: { framework: 'micronaut', entity: entity.superType },
          }));
        }
        continue;
      }

      const entityId = `micronaut_entity_${fileSlug}_${this.sanitizeId(entity.name)}`;
      nodes.push(this.createNodeBuilder(entityId, entity.name, 'model')
        .withLevel(3, 'micronaut-entities')
        .withCategory('model', ['data', 'entity', entity.kind, 'micronaut'])
        .withSource({ file: info.fullPath, line: entity.line, end_line: entity.line })
        .withDescription(`Micronaut ${entity.kind === 'mapped-entity' ? 'Data @MappedEntity' : 'JPA @Entity'}: ${entity.name}`)
        .withMetadata({
          framework: 'micronaut',
          attributes: { kind: entity.kind, fields: entity.fields, fieldCount: entity.fields.length, file: info.relativePath },
        })
        .withTags(['micronaut-entity', entity.kind])
        .build());

      exitPoints.push(this.createExitPoint(
        `exit_db_${entityId}`,
        entityId,
        'database',
        `Persistence: ${entity.name}`,
        `Micronaut ${entity.kind} persisted via Micronaut Data / JPA`,
        { resource: entity.name.toLowerCase() },
        { action: 'persist' },
        { framework: 'micronaut', entity: entity.name, kind: entity.kind, fields: entity.fields.map(f => f.name) }
      ));
    }

    // Scheduled jobs → entry points.
    info.scheduled.forEach((job, index) => {
      const jobId = `micronaut_scheduled_${fileSlug}_${this.sanitizeId(job.handlerName)}_${index}`;
      const schedule = job.cron || (job.fixedRate ? `fixedRate ${job.fixedRate}` : 'scheduled');
      nodes.push(this.createNodeBuilder(jobId, `@Scheduled ${job.handlerName}`, 'job')
        .withLevel(3, 'micronaut-routes')
        .withCategory('job', ['scheduled', 'micronaut'])
        .withSource({ file: info.fullPath, line: job.line, end_line: job.line })
        .withDescription(`Micronaut scheduled job: ${job.handlerName} (${schedule})`)
        .withMetadata({
          framework: 'micronaut',
          attributes: { handlerName: job.handlerName, cron: job.cron, fixedRate: job.fixedRate, file: info.relativePath },
        })
        .withTags(['micronaut-scheduled'])
        .build());

      entryPoints.push(this.createEntryPoint(
        `entry_${jobId}`,
        jobId,
        'schedule',
        `@Scheduled ${job.handlerName}`,
        `Micronaut scheduled job at ${info.relativePath}:${job.line}`,
        { schedule },
        undefined,
        { framework: 'micronaut', kind: 'scheduled', cron: job.cron, fixedRate: job.fixedRate, file: info.relativePath, line: job.line, language: 'java' },
        { node_id: jobId, method_name: job.handlerName, file: info.relativePath, line: job.line }
      ));
    });

    // Declarative HTTP clients → external service nodes + exit points.
    for (const client of info.clients) {
      const clientId = `micronaut_client_${fileSlug}_${this.sanitizeId(client.name)}`;
      nodes.push(this.createNodeBuilder(clientId, client.name, 'external-service')
        .withLevel(2, 'micronaut-beans')
        .withCategory('external-service', ['http-client', 'declarative', 'micronaut'])
        .withSource({ file: info.fullPath, line: client.line, end_line: client.line })
        .withDescription(`Micronaut declarative HTTP client for "${client.serviceId}": ${client.name}`)
        .withMetadata({
          framework: 'micronaut',
          attributes: { serviceId: client.serviceId, file: info.relativePath },
        })
        .withTags(['micronaut-client', 'external-service'])
        .build());

      exitPoints.push(this.createExitPoint(
        `exit_client_${clientId}`,
        clientId,
        'api',
        `HTTP client: ${client.serviceId}`,
        `Micronaut declarative HTTP client calling external service "${client.serviceId}"`,
        { service_id: client.serviceId },
        { action: 'http-call', async: true },
        { framework: 'micronaut', serviceId: client.serviceId, client: client.name }
      ));
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'micronaut-application';
      case 2: return 'micronaut-beans';
      case 3: return 'micronaut-routes';
      case 4: return 'micronaut-handlers';
      default: return `micronaut-level-${level}`;
    }
  }

  protected getCapabilities(): string[] {
    return ['micronaut-controllers', 'micronaut-beans', 'micronaut-data', 'micronaut-clients'];
  }
}

export default { MicronautAnalyzer };
