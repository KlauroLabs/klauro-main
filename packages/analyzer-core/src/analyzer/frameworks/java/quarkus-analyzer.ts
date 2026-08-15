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
const CDI_SCOPES = ['ApplicationScoped', 'Singleton', 'RequestScoped', 'SessionScoped', 'Dependent'];

interface QuarkusRoute {
  method: string;
  path: string;
  handlerName: string;
  line: number;
  produces?: string;
  consumes?: string;
  authenticated: boolean;
}

interface QuarkusBean {
  name: string;
  scope: string;
  injects: string[];
  line: number;
}

interface QuarkusEntity {
  name: string;
  kind: 'panache-entity' | 'jpa-entity' | 'panache-repository';
  superType?: string;
  fields: Array<{ name: string; type: string }>;
  line: number;
}

interface QuarkusScheduled {
  handlerName: string;
  cron?: string;
  every?: string;
  line: number;
}

interface QuarkusMessaging {
  handlerName: string;
  direction: 'incoming' | 'outgoing';
  channel: string;
  line: number;
}

interface QuarkusFileInfo {
  relativePath: string;
  fullPath: string;
  lineCount: number;
  className: string | null;
  isResource: boolean;
  routes: QuarkusRoute[];
  beans: QuarkusBean[];
  entities: QuarkusEntity[];
  scheduled: QuarkusScheduled[];
  messaging: QuarkusMessaging[];
}

export class QuarkusAnalyzer extends BaseAnalyzer {
  constructor() {
    super('quarkus', 'Quarkus Framework Analyzer', '1.0.0', 'framework');
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
        if (/io\.quarkus|quarkus-/.test(content)) return true;
      }


      for (const propRel of ['src/main/resources/application.properties', 'application.properties']) {
        const propPath = path.join(projectPath, propRel);
        if (await fs.pathExists(propPath)) {
          const content = await fs.readFile(propPath, 'utf-8').catch(() => '');
          if (/^\s*quarkus\./m.test(content)) return true;
        }
      }


      const javaFiles = await glob(JAVA_GLOBS, {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true,
      });
      for (const rel of javaFiles) {
        const content = await fs.readFile(path.join(projectPath, rel), 'utf-8').catch(() => '');
        if (/import\s+io\.quarkus/.test(content) ||
            /import\s+(?:jakarta|javax)\.ws\.rs/.test(content)) {
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

      const fileInfos: QuarkusFileInfo[] = [];
      for (const relativePath of javaFiles) {
        const fullPath = path.join(context.projectPath, relativePath);
        let content = '';
        try {
          content = await fs.readFile(fullPath, 'utf-8');
        } catch {
          continue;
        }

        if (!/@Path\b|@(?:GET|POST|PUT|DELETE|PATCH)\b|@(?:ApplicationScoped|Singleton|RequestScoped|Dependent)\b|@Inject\b|PanacheEntity|PanacheRepository|@Entity\b|@Scheduled\b|@Incoming\b|@Outgoing\b|io\.quarkus/.test(content)) {
          continue;
        }
        fileInfos.push(this.parseJavaFile(relativePath, fullPath, content));
      }



      const injectableIdByName = new Map<string, string>();
      for (const info of fileInfos) {
        const slug = this.sanitizeId(info.relativePath);
        for (const bean of info.beans) {
          injectableIdByName.set(bean.name, `quarkus_bean_${slug}_${this.sanitizeId(bean.name)}`);
        }
        for (const entity of info.entities) {
          if (entity.kind === 'panache-repository') {
            injectableIdByName.set(entity.name, `quarkus_repository_${slug}_${this.sanitizeId(entity.name)}`);
          }
        }
      }

      for (const info of fileInfos) {
        this.emitFileContribution(info, nodes, edges, entryPoints, exitPoints, injectableIdByName);
      }

      const routeCount = entryPoints.filter(ep => ep.metadata?.kind === 'route').length;
      const beanCount = nodes.filter(n => n.type === 'bean').length;
      const entityCount = nodes.filter(n => n.type === 'model' || n.type === 'repository').length;
      const scheduledCount = entryPoints.filter(ep => ep.metadata?.kind === 'scheduled').length;

      const warnings = this.collectAnalysisWarnings();
      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        ...(warnings.length > 0 ? { warnings } : {}),
        framework: 'quarkus',
        framework_specific: {
          framework: 'quarkus',
          filesAnalyzed: fileInfos.length,
          routes: routeCount,
          beans: beanCount,
          entities: entityCount,
          scheduledJobs: scheduledCount,
        },
      });
    } catch (error) {
      throw new AnalyzerError(
        `Quarkus analysis failed: ${(error as Error).message}`,
        'QUARKUS_ANALYSIS_ERROR'
      );
    }
  }





  private parseJavaFile(relativePath: string, fullPath: string, content: string): QuarkusFileInfo {
    const lines = content.split('\n');
    const className = this.extractClassName(content);
    const classPath = this.extractClassPath(content);
    const isResource = /@Path\b/.test(content);

    return {
      relativePath,
      fullPath,
      lineCount: lines.length,
      className,
      isResource,
      routes: this.extractRoutes(lines, classPath, content),
      beans: this.extractBeans(lines, content),
      entities: this.extractEntities(lines, className, content),
      scheduled: this.extractScheduled(lines),
      messaging: this.extractMessaging(lines),
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





  private extractRoutes(lines: string[], classPath: string, content: string): QuarkusRoute[] {
    const routes: QuarkusRoute[] = [];

    for (let i = 0; i < lines.length; i++) {
      const httpMatch = lines[i].match(/@(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/);
      if (!httpMatch) continue;
      const httpAnn = httpMatch[1];
      if (!JAXRS_HTTP_ANNOTATIONS.has(httpAnn)) continue;


      let subPath = '';
      let produces: string | undefined;
      let consumes: string | undefined;
      let authenticated = false;
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
        if (/@(RolesAllowed|Authenticated|PermitAll\s*\(\s*false)/.test(line)) authenticated = true;

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
      });
    }
    return routes;
  }


  private extractBeans(lines: string[], content: string): QuarkusBean[] {
    const beans: QuarkusBean[] = [];
    const className = this.extractClassName(content);
    if (!className) return beans;

    let scope: string | null = null;
    let scopeLine = 0;
    for (let i = 0; i < lines.length; i++) {
      for (const s of CDI_SCOPES) {
        if (new RegExp(`@${s}\\b`).test(lines[i])) {
          scope = s;
          scopeLine = i + 1;
        }
      }
      if (scope && /class\s+\w+/.test(lines[i])) break;
    }
    if (!scope) return beans;

    const injects = this.extractInjects(content);
    beans.push({ name: className, scope, injects, line: scopeLine || 1 });
    return beans;
  }


  private extractInjects(content: string): string[] {
    const injects: string[] = [];
    const fieldPattern = /@Inject[\s\S]{0,80}?(?:[\w.]+\s+)?(\w+)\s+\w+\s*;/g;
    let m: RegExpExecArray | null;
    while ((m = fieldPattern.exec(content)) !== null) {
      injects.push(m[1]);
    }
    return Array.from(new Set(injects));
  }


  private extractEntities(lines: string[], className: string | null, content: string): QuarkusEntity[] {
    const entities: QuarkusEntity[] = [];
    if (!className) return entities;

    const classLineIdx = lines.findIndex(l => new RegExp(`class\\s+${className}\\b`).test(l));
    const line = classLineIdx >= 0 ? classLineIdx + 1 : 1;

    const repoMatch = content.match(/implements\s+PanacheRepository(?:Base)?\s*<\s*(\w+)/);
    if (repoMatch) {
      entities.push({ name: className, kind: 'panache-repository', superType: repoMatch[1], fields: [], line });
      return entities;
    }

    const panacheMatch = content.match(/extends\s+(PanacheEntity(?:Base)?)/);
    if (panacheMatch) {
      entities.push({
        name: className,
        kind: 'panache-entity',
        superType: panacheMatch[1],
        fields: this.extractEntityFields(content),
        line,
      });
      return entities;
    }

    if (/@Entity\b/.test(content)) {
      entities.push({
        name: className,
        kind: 'jpa-entity',
        fields: this.extractEntityFields(content),
        line,
      });
    }
    return entities;
  }

  private extractEntityFields(content: string): Array<{ name: string; type: string }> {
    const fields: Array<{ name: string; type: string }> = [];

    const pattern = /(?:public|private|protected)\s+(?!class\b|static\s+final\b)([\w<>\[\],.]+)\s+(\w+)\s*;/g;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) {
      fields.push({ type: m[1], name: m[2] });
    }
    return fields;
  }


  private extractScheduled(lines: string[]): QuarkusScheduled[] {
    const jobs: QuarkusScheduled[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!/@Scheduled\b/.test(lines[i])) continue;
      const block = lines.slice(i, Math.min(lines.length, i + 6)).join(' ');
      const cron = block.match(/cron\s*=\s*"([^"]*)"/)?.[1];
      const every = block.match(/every\s*=\s*"([^"]*)"/)?.[1];
      const sig = this.extractMethodName(block);
      jobs.push({
        handlerName: sig || `scheduled${i}`,
        cron,
        every,
        line: i + 1,
      });
    }
    return jobs;
  }


  private extractMessaging(lines: string[]): QuarkusMessaging[] {
    const msgs: QuarkusMessaging[] = [];
    for (let i = 0; i < lines.length; i++) {
      const inc = lines[i].match(/@Incoming\s*\(\s*"([^"]*)"\s*\)/);
      const out = lines[i].match(/@Outgoing\s*\(\s*"([^"]*)"\s*\)/);
      if (!inc && !out) continue;
      const block = lines.slice(i, Math.min(lines.length, i + 4)).join(' ');
      const sig = block.match(/\b[\w<>]+\s+(\w+)\s*\(/);
      const handlerName = sig ? sig[1] : `messaging${i}`;
      if (inc) msgs.push({ handlerName, direction: 'incoming', channel: inc[1], line: i + 1 });
      if (out) msgs.push({ handlerName, direction: 'outgoing', channel: out[1], line: i + 1 });
    }
    return msgs;
  }


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





  private emitFileContribution(
    info: QuarkusFileInfo,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[],
    injectableIdByName?: Map<string, string>
  ): void {
    const fileSlug = this.sanitizeId(info.relativePath);


    let resourceId: string | null = null;
    if (info.isResource && info.className) {
      resourceId = `quarkus_resource_${fileSlug}_${this.sanitizeId(info.className)}`;
      nodes.push(this.createNodeBuilder(resourceId, info.className, 'controller')
        .withLevel(2, 'quarkus-resources')
        .withCategory('controller', ['api', 'rest', 'jax-rs', 'quarkus'])
        .withSource({ file: info.fullPath, line: 1, end_line: info.lineCount })
        .withDescription(`Quarkus JAX-RS resource: ${info.className}`)
        .withMetadata({
          framework: 'quarkus',
          attributes: { className: info.className, routeCount: info.routes.length, file: info.relativePath },
        })
        .withTags(['quarkus-resource'])
        .build());
    }


    info.routes.forEach((route, index) => {
      const routeId = `quarkus_route_${fileSlug}_${route.method}_${this.sanitizeId(route.path)}_${index}`;
      const label = `${route.method} ${route.path}`;
      const tags = ['quarkus-route'];
      if (route.authenticated) tags.push('auth-gated', 'security');

      nodes.push(this.createNodeBuilder(routeId, label, 'route')
        .withLevel(3, 'quarkus-routes')
        .withCategory('route', ['http', 'endpoint', 'jax-rs', 'quarkus'])
        .withSource({ file: info.fullPath, line: route.line, end_line: route.line })
        .withParent(resourceId || undefined)
        .withDescription(`Quarkus HTTP endpoint: ${label}${route.authenticated ? ' (authenticated)' : ''}`)
        .withMetadata({
          framework: 'quarkus',
          attributes: {
            method: route.method,
            path: route.path,
            handlerName: route.handlerName,
            produces: route.produces,
            consumes: route.consumes,
            authenticated: route.authenticated,
            file: info.relativePath,
          },
        })
        .withTags(tags)
        .build());

      if (resourceId) {
        edges.push(this.createEdge(`${resourceId}_exposes_${routeId}`, resourceId, routeId, 'exposes', 'behavior', {
          attributes: { framework: 'quarkus' },
        }));
      }

      entryPoints.push(this.createEntryPoint(
        `entry_${routeId}`,
        routeId,
        'http',
        label,
        `Quarkus JAX-RS route handled at ${info.relativePath}:${route.line}`,
        { method: route.method, path: route.path },
        { authenticated: route.authenticated, authorized_roles: [], guards: [] },
        {
          framework: 'quarkus', kind: 'route', method: route.method, path: route.path,
          handler: route.handlerName, file: info.relativePath, line: route.line, language: 'java',
        },
        { node_id: routeId, method_name: route.handlerName, file: info.relativePath, line: route.line }
      ));
    });


    for (const bean of info.beans) {
      const beanId = `quarkus_bean_${fileSlug}_${this.sanitizeId(bean.name)}`;
      nodes.push(this.createNodeBuilder(beanId, bean.name, 'bean')
        .withLevel(2, 'quarkus-beans')
        .withCategory('bean', ['cdi', 'injectable', 'quarkus'])
        .withSource({ file: info.fullPath, line: bean.line, end_line: bean.line })
        .withDescription(`Quarkus CDI bean (@${bean.scope}): ${bean.name}`)
        .withMetadata({
          framework: 'quarkus',
          attributes: { scope: bean.scope, injects: bean.injects, file: info.relativePath },
        })
        .withTags(['quarkus-bean', 'cdi'])
        .build());

      for (const dep of bean.injects) {
        const targetId = injectableIdByName?.get(dep) || `quarkus_bean_${this.sanitizeId(dep)}`;
        edges.push({
          id: `${beanId}_injects_${this.sanitizeId(dep)}`,
          source: beanId,
          target: targetId,
          type: 'depends_on',
          metadata: { framework: 'quarkus', dependency_type: 'injection', attributes: { injectedType: dep } },
        } as CASEdge);
      }
    }


    for (const entity of info.entities) {
      if (entity.kind === 'panache-repository') {
        const repoId = `quarkus_repository_${fileSlug}_${this.sanitizeId(entity.name)}`;
        nodes.push(this.createNodeBuilder(repoId, entity.name, 'repository')
          .withLevel(2, 'quarkus-beans')
          .withCategory('repository', ['data-access', 'panache', 'quarkus'])
          .withSource({ file: info.fullPath, line: entity.line, end_line: entity.line })
          .withDescription(`Quarkus Panache repository for ${entity.superType}: ${entity.name}`)
          .withMetadata({
            framework: 'quarkus',
            attributes: { entityType: entity.superType, file: info.relativePath },
          })
          .withTags(['quarkus-repository', 'panache'])
          .build());
        if (entity.superType) {
          const entId = `quarkus_entity_${this.sanitizeId(entity.superType)}`;
          edges.push(this.createEdge(`${repoId}_manages_${this.sanitizeId(entity.superType)}`, repoId, entId, 'depends_on', 'data', {
            attributes: { framework: 'quarkus', entity: entity.superType },
          }));
        }
        continue;
      }

      const entityId = `quarkus_entity_${fileSlug}_${this.sanitizeId(entity.name)}`;
      nodes.push(this.createNodeBuilder(entityId, entity.name, 'model')
        .withLevel(3, 'quarkus-entities')
        .withCategory('model', ['data', 'entity', entity.kind, 'quarkus'])
        .withSource({ file: info.fullPath, line: entity.line, end_line: entity.line })
        .withDescription(`Quarkus ${entity.kind === 'panache-entity' ? 'Panache' : 'JPA'} entity: ${entity.name}`)
        .withMetadata({
          framework: 'quarkus',
          attributes: {
            kind: entity.kind,
            superType: entity.superType,
            fields: entity.fields,
            fieldCount: entity.fields.length,
            file: info.relativePath,
          },
        })
        .withTags(['quarkus-entity', entity.kind])
        .build());

      exitPoints.push(this.createExitPoint(
        `exit_db_${entityId}`,
        entityId,
        'database',
        `Persistence: ${entity.name}`,
        `Quarkus ${entity.kind} persisted via Panache/Hibernate ORM`,
        { resource: entity.name.toLowerCase() },
        { action: 'persist' },
        { framework: 'quarkus', entity: entity.name, kind: entity.kind, fields: entity.fields.map(f => f.name) }
      ));
    }


    info.scheduled.forEach((job, index) => {
      const jobId = `quarkus_scheduled_${fileSlug}_${this.sanitizeId(job.handlerName)}_${index}`;
      const schedule = job.cron || (job.every ? `every ${job.every}` : 'scheduled');
      nodes.push(this.createNodeBuilder(jobId, `@Scheduled ${job.handlerName}`, 'job')
        .withLevel(3, 'quarkus-routes')
        .withCategory('job', ['scheduled', 'quarkus'])
        .withSource({ file: info.fullPath, line: job.line, end_line: job.line })
        .withDescription(`Quarkus scheduled job: ${job.handlerName} (${schedule})`)
        .withMetadata({
          framework: 'quarkus',
          attributes: { handlerName: job.handlerName, cron: job.cron, every: job.every, file: info.relativePath },
        })
        .withTags(['quarkus-scheduled'])
        .build());

      entryPoints.push(this.createEntryPoint(
        `entry_${jobId}`,
        jobId,
        'schedule',
        `@Scheduled ${job.handlerName}`,
        `Quarkus scheduled job at ${info.relativePath}:${job.line}`,
        { schedule },
        undefined,
        { framework: 'quarkus', kind: 'scheduled', cron: job.cron, every: job.every, file: info.relativePath, line: job.line, language: 'java' },
        { node_id: jobId, method_name: job.handlerName, file: info.relativePath, line: job.line }
      ));
    });


    info.messaging.forEach((msg, index) => {
      const msgId = `quarkus_messaging_${fileSlug}_${msg.direction}_${this.sanitizeId(msg.channel)}_${index}`;
      nodes.push(this.createNodeBuilder(msgId, `@${msg.direction === 'incoming' ? 'Incoming' : 'Outgoing'}("${msg.channel}")`, 'message')
        .withLevel(3, 'quarkus-routes')
        .withCategory('message', ['messaging', 'smallrye', 'reactive', 'quarkus'])
        .withSource({ file: info.fullPath, line: msg.line, end_line: msg.line })
        .withDescription(`Quarkus reactive messaging ${msg.direction} channel: ${msg.channel}`)
        .withMetadata({
          framework: 'quarkus',
          attributes: { direction: msg.direction, channel: msg.channel, handlerName: msg.handlerName, file: info.relativePath },
        })
        .withTags(['quarkus-messaging', msg.direction])
        .build());

      if (msg.direction === 'incoming') {
        entryPoints.push(this.createEntryPoint(
          `entry_${msgId}`,
          msgId,
          'message',
          `@Incoming ${msg.channel}`,
          `Quarkus reactive messaging consumer for channel ${msg.channel}`,
          { event: msg.channel },
          undefined,
          { framework: 'quarkus', kind: 'messaging', direction: 'incoming', channel: msg.channel, file: info.relativePath, line: msg.line, language: 'java' },
          { node_id: msgId, method_name: msg.handlerName, file: info.relativePath, line: msg.line }
        ));
      } else {
        exitPoints.push(this.createExitPoint(
          `exit_${msgId}`,
          msgId,
          'message',
          `@Outgoing ${msg.channel}`,
          `Quarkus reactive messaging producer for channel ${msg.channel}`,
          { resource: msg.channel },
          { action: 'publish', async: true },
          { framework: 'quarkus', channel: msg.channel, handlerName: msg.handlerName }
        ));
      }
    });
  }





  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'quarkus-application';
      case 2: return 'quarkus-beans';
      case 3: return 'quarkus-routes';
      case 4: return 'quarkus-handlers';
      default: return `quarkus-level-${level}`;
    }
  }

  protected getCapabilities(): string[] {
    return ['quarkus-resources', 'quarkus-cdi', 'quarkus-panache-entities', 'quarkus-scheduled'];
  }
}

export default { QuarkusAnalyzer };
