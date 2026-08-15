import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, FileAnalysisResult
} from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';
import * as path from 'path';



































const ROUTES_GLOBS = ['conf/routes', 'conf/*.routes', '**/conf/routes', '**/conf/*.routes'];
const BUILD_GLOBS = ['build.sbt', 'project/plugins.sbt', 'project/build.properties'];
const CONTROLLER_GLOBS = ['app/controllers/**/*.scala', 'app/controllers/**/*.java', '**/app/controllers/**/*.scala', '**/app/controllers/**/*.java'];

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);

interface PlayRoute {
  method: string;
  path: string;
  controllerFqcn: string;
  methodName: string;
  paramsRaw: string;
  line: number;
}

interface PlayInclude {
  prefix: string;
  routerRef: string;
  line: number;
}

interface PlayRoutesFile {
  relativePath: string;
  fullPath: string;
  routes: PlayRoute[];
  includes: PlayInclude[];
}

export class PlayAnalyzer extends BaseAnalyzer {
  constructor() {
    super('play', 'Play Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const routesFiles = await glob(ROUTES_GLOBS, {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true,
        dot: true,
      });
      if (routesFiles.length === 0) return false;



      let looksLikePlayRoutes = false;
      for (const rel of routesFiles) {
        const content = await fs.readFile(path.join(projectPath, rel), 'utf-8').catch(() => '');
        if (/^\s*(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+\/\S*\s+[\w.]+\.\w+\(/m.test(content)) {
          looksLikePlayRoutes = true;
          break;
        }
      }
      if (!looksLikePlayRoutes) return false;




      const buildFiles = await glob(BUILD_GLOBS, {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true,
      });
      for (const rel of buildFiles) {
        const content = await fs.readFile(path.join(projectPath, rel), 'utf-8').catch(() => '');
        if (/play\.sbt\.PlayScala|play\.sbt\.PlayJava|"com\.typesafe\.play"|sbt-plugin.*play/.test(content)) {
          return true;
        }
      }
      const controllerFiles = await glob(CONTROLLER_GLOBS, {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true,
      });
      return controllerFiles.length > 0;
    } catch {
      return false;
    }
  }

  supportsIncrementalAnalysis(): boolean {




    return false;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    const routesFiles = await glob(ROUTES_GLOBS, {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true,
      dot: true,
    });
    const controllerFiles = await glob(CONTROLLER_GLOBS, {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true,
    });
    return [...routesFiles, ...controllerFiles].sort();
  }

  async analyzeFileSingle(_context: FileAnalysisContext): Promise<FileAnalysisResult> {


    return this.createFileAnalysisResult(
      _context.filePath,
      _context.relativePath,
      _context.contentHash || '',
      Date.now(),
      [], [], [], [], [], []
    );
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    this.resetAnalysisWarnings();
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    try {
      const routesFilePaths = await glob(ROUTES_GLOBS, {
        cwd: context.projectPath,
        ignore: this.getIgnorePatterns(context),
        nodir: true,
        dot: true,
      });
      routesFilePaths.sort();

      const routesFiles: PlayRoutesFile[] = [];
      for (const relativePath of routesFilePaths) {
        const fullPath = path.join(context.projectPath, relativePath);
        let content = '';
        try {
          content = await fs.readFile(fullPath, 'utf-8');
        } catch {
          continue;
        }
        routesFiles.push(this.parseRoutesFile(relativePath, fullPath, content));
      }


      const controllerFiles = await glob(CONTROLLER_GLOBS, {
        cwd: context.projectPath,
        ignore: this.getIgnorePatterns(context),
        nodir: true,
      });
      const controllerIndex = new Map<string, string>();
      for (const rel of controllerFiles) {
        const base = path.basename(rel).replace(/\.(scala|java)$/, '');
        controllerIndex.set(base, rel);
      }

      for (const rf of routesFiles) {
        await this.emitRoutesFileContribution(rf, context.projectPath, controllerIndex, nodes, edges, entryPoints, exitPoints);
      }

      const routeCount = entryPoints.filter(ep => ep.metadata?.kind === 'route').length;
      const resolvedCount = entryPoints.filter(ep => ep.metadata?.resolved === true).length;
      const includeCount = edges.filter(e => e.type === 'mounts').length;

      const warnings = this.collectAnalysisWarnings();
      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        ...(warnings.length > 0 ? { warnings } : {}),
        framework: 'play',
        framework_specific: {
          framework: 'play',
          routesFilesAnalyzed: routesFiles.length,
          routes: routeCount,
          resolvedHandlers: resolvedCount,
          includes: includeCount,
        },
      });
    } catch (error) {
      throw new AnalyzerError(
        `Play Framework analysis failed: ${(error as Error).message}`,
        'PLAY_ANALYSIS_ERROR'
      );
    }
  }






  private parseRoutesFile(relativePath: string, fullPath: string, content: string): PlayRoutesFile {
    const lines = content.split('\n');
    const routes: PlayRoute[] = [];
    const includes: PlayInclude[] = [];

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const line = this.stripComment(raw).trim();
      if (!line) continue;


      const includeMatch = line.match(/^->\s+(\/\S*)\s+([\w.]+)/);
      if (includeMatch) {
        includes.push({ prefix: includeMatch[1], routerRef: includeMatch[2], line: i + 1 });
        continue;
      }


      const routeMatch = line.match(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(\/\S*)\s+([\w.]+)\.(\w+)\s*(\([^)]*\))?/);
      if (routeMatch && HTTP_METHODS.has(routeMatch[1])) {
        routes.push({
          method: routeMatch[1],
          path: routeMatch[2],
          controllerFqcn: routeMatch[3],
          methodName: routeMatch[4],
          paramsRaw: routeMatch[5] ? routeMatch[5].slice(1, -1) : '',
          line: i + 1,
        });
      }
    }

    return { relativePath, fullPath, routes, includes };
  }

  private stripComment(line: string): string {


    const idx = line.indexOf('#');
    return idx >= 0 ? line.slice(0, idx) : line;
  }


  private async resolveHandler(
    projectPath: string,
    controllerRelPath: string | undefined,
    methodName: string
  ): Promise<{ file: string; line: number } | null> {
    if (!controllerRelPath) return null;
    const fullPath = path.join(projectPath, controllerRelPath);
    let content: string;
    try {
      content = await fs.readFile(fullPath, 'utf-8');
    } catch {
      return null;
    }
    const lines = content.split('\n');
    const escaped = methodName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const scalaDef = new RegExp(`\\bdef\\s+${escaped}\\s*[(\\[]`);
    const javaDef = new RegExp(`\\b(?:public|protected|private)\\s+[\\w<>\\[\\],.]+\\s+${escaped}\\s*\\(`);
    for (let i = 0; i < lines.length; i++) {
      if (scalaDef.test(lines[i]) || javaDef.test(lines[i])) {
        return { file: controllerRelPath, line: i + 1 };
      }
    }
    return null;
  }





  private async emitRoutesFileContribution(
    rf: PlayRoutesFile,
    projectPath: string,
    controllerIndex: Map<string, string>,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[]
  ): Promise<void> {
    const fileSlug = this.sanitizeId(rf.relativePath);

    const routesFileId = `play_routesfile_${fileSlug}`;
    nodes.push(this.createNodeBuilder(routesFileId, rf.relativePath, 'router')
      .withLevel(2, 'play-routes-file')
      .withCategory('router', ['http', 'play', 'routes-file'])
      .withSource({ file: rf.fullPath, line: 1, end_line: Math.max(1, rf.routes.length + rf.includes.length) })
      .withDescription(`Play routes file: ${rf.relativePath} (the router — routes are declared here, not on the controller)`)
      .withMetadata({
        framework: 'play',
        attributes: { file: rf.relativePath, routeCount: rf.routes.length, includeCount: rf.includes.length },
      })
      .withTags(['play-routes-file'])
      .build());

    for (const [index, route] of rf.routes.entries()) {
      const routeId = `play_route_${fileSlug}_${route.method}_${this.sanitizeId(route.path)}_${index}`;
      const label = `${route.method} ${route.path}`;
      const simpleClassName = route.controllerFqcn.split('.').pop() || route.controllerFqcn;
      const controllerRelPath = controllerIndex.get(simpleClassName);
      const resolved = await this.resolveHandler(projectPath, controllerRelPath, route.methodName);

      nodes.push(this.createNodeBuilder(routeId, label, 'route')
        .withLevel(3, 'play-routes')
        .withCategory('route', ['http', 'endpoint', 'play'])
        .withSource({ file: rf.fullPath, line: route.line, end_line: route.line })
        .withParent(routesFileId)
        .withDescription(`Play HTTP endpoint: ${label} -> ${route.controllerFqcn}.${route.methodName}(${route.paramsRaw})`)
        .withMetadata({
          framework: 'play',
          attributes: {
            method: route.method,
            path: route.path,
            controllerFqcn: route.controllerFqcn,
            methodName: route.methodName,
            params: route.paramsRaw,
            resolved: !!resolved,
            file: rf.relativePath,
          },
        })
        .withTags(['play-route', ...(resolved ? [] : ['unresolved-handler'])])
        .build());

      edges.push(this.createEdge(`${routesFileId}_routes_to_${routeId}`, routesFileId, routeId, 'exposes', 'behavior', {
        attributes: { framework: 'play' },
      }));

      entryPoints.push(this.createEntryPoint(
        `entry_${routeId}`,
        routeId,
        'http',
        label,
        `Play route declared in ${rf.relativePath}:${route.line}, handled by ${route.controllerFqcn}.${route.methodName}`,
        { method: route.method, path: route.path },
        { authenticated: false, authorized_roles: [], guards: [] },
        {
          framework: 'play', kind: 'route', method: route.method, path: route.path,
          handler: `${route.controllerFqcn}.${route.methodName}`, file: rf.relativePath, line: route.line,
          language: controllerRelPath?.endsWith('.java') ? 'java' : 'scala',
          resolved: !!resolved,
        },
        resolved
          ? { node_id: routeId, method_name: route.methodName, file: resolved.file, line: resolved.line }
          : { node_id: routeId, method_name: route.methodName, file: rf.relativePath, line: route.line }
      ));
    }

    for (const [index, inc] of rf.includes.entries()) {
      const incId = `play_include_${fileSlug}_${this.sanitizeId(inc.prefix)}_${index}`;
      nodes.push(this.createNodeBuilder(incId, `-> ${inc.prefix} ${inc.routerRef}`, 'router')
        .withLevel(2, 'play-routes-file')
        .withCategory('router', ['http', 'play', 'sub-router'])
        .withSource({ file: rf.fullPath, line: inc.line, end_line: inc.line })
        .withDescription(`Play sub-router include: ${inc.prefix} -> ${inc.routerRef}`)
        .withMetadata({
          framework: 'play',
          attributes: { prefix: inc.prefix, routerRef: inc.routerRef, file: rf.relativePath },
        })
        .withTags(['play-include'])
        .build());
      edges.push(this.createEdge(`${routesFileId}_mounts_${incId}`, routesFileId, incId, 'mounts', 'structural', {
        attributes: { framework: 'play', prefix: inc.prefix },
      }));
    }
  }





  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'play-application';
      case 2: return 'play-routes-file';
      case 3: return 'play-routes';
      case 4: return 'play-handlers';
      default: return `play-level-${level}`;
    }
  }

  protected getCapabilities(): string[] {
    return ['play-routes-file', 'play-routes', 'play-controller-resolution'];
  }
}

export default { PlayAnalyzer };
