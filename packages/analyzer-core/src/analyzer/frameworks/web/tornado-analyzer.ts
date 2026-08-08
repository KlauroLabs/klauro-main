import { BaseAnalyzer, CASAnalysisResult, CASNode, CASEdge, CASEntryPoint, CASExitPoint, AnalysisContext, FileAnalysisContext, FileAnalysisResult } from '../../core/base-analyzer';
import { AnalyzerError } from '../../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';

interface TornadoApplication {
  name: string;
  filePath: string;
  appVariable: string;
}

interface TornadoRoute {
  pattern: string;
  handlerClass: string;
  handlerLine: number;
}

interface TornadoHandlerMethod {
  handlerClass: string;
  method: string;
  line: number;
}

/**
 * Tornado Framework Analyzer.
 *
 * Covers `tornado.web.Application([(r"/path", Handler), ...])` route→RequestHandler
 * class wiring, and the HTTP verb methods (`get`/`post`/`put`/`delete`/...) defined
 * on each `tornado.web.RequestHandler` subclass — those methods are the real
 * per-verb entry points, since a single handler class serves multiple methods.
 */
export class TornadoAnalyzer extends BaseAnalyzer {
  constructor() {
    super('tornado', 'Tornado Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const requirementsPath = path.join(projectPath, 'requirements.txt');
      const pyprojectPath = path.join(projectPath, 'pyproject.toml');
      const pipfilePath = path.join(projectPath, 'Pipfile');

      if (await fs.pathExists(requirementsPath)) {
        const requirements = await fs.readFile(requirementsPath, 'utf-8');
        if (/\btornado\b/i.test(requirements)) return true;
      }

      if (await fs.pathExists(pyprojectPath)) {
        const pyproject = await fs.readFile(pyprojectPath, 'utf-8');
        if (/\btornado\b/i.test(pyproject)) return true;
      }

      if (await fs.pathExists(pipfilePath)) {
        const pipfile = await fs.readFile(pipfilePath, 'utf-8');
        if (/\btornado\b/i.test(pipfile)) return true;
      }

      const pythonFiles = await glob(['**/*.py'], {
        cwd: projectPath,
        ignore: [...this.getIgnorePatterns({ projectPath }), '**/venv/**', '**/.venv/**', '**/env/**', '**/__pycache__/**'],
        nodir: true
      });

      for (const file of pythonFiles) {
        const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
        if (content.includes('tornado.web') || content.includes('from tornado') || content.includes('import tornado')) {
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
    return glob(['**/*.py'], {
      cwd: projectPath,
      ignore: [
        ...this.getIgnorePatterns({ projectPath }),
        '**/venv/**', '**/.venv/**', '**/env/**', '**/__pycache__/**'
      ],
      nodir: true
    });
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const file = context.relativePath;
    const content = await fs.readFile(context.filePath, 'utf-8');
    const stat = await fs.stat(context.filePath);

    const application = await this.analyzeApplication([file], context.projectPath, nodes);
    const handlerMethods = this.collectHandlerMethods(content);
    await this.analyzeRoutes([file], context.projectPath, nodes, edges, entryPoints, application, handlerMethods);

    return this.createFileAnalysisResult(
      context.filePath,
      file,
      context.contentHash || this.computeContentHash(content),
      stat.mtimeMs,
      nodes,
      edges,
      entryPoints,
      exitPoints,
      this.extractPythonImports(content),
      [...new Set(nodes.map(node => node.name))]
    );
  }

  async analyze(context: AnalysisContext): Promise<CASAnalysisResult> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: any[] = [];
    const exitPoints: any[] = [];

    try {
      const pythonFiles = await glob(['**/*.py'], {
        cwd: context.projectPath,
        ignore: [...this.getIgnorePatterns(context), '**/venv/**', '**/.venv/**', '**/env/**', '**/__pycache__/**'],
        nodir: true
      });

      const application = await this.analyzeApplication(pythonFiles, context.projectPath, nodes);

      const handlerMethodsByFile = new Map<string, TornadoHandlerMethod[]>();
      for (const file of pythonFiles) {
        const content = await fs.readFile(path.join(context.projectPath, file), 'utf-8');
        handlerMethodsByFile.set(file, this.collectHandlerMethods(content));
      }
      const allHandlerMethods = [...handlerMethodsByFile.values()].flat();

      const routes = await this.analyzeRoutes(pythonFiles, context.projectPath, nodes, edges, entryPoints, application, allHandlerMethods);

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework: 'tornado',
        version: await this.detectVersion(context.projectPath),
        applicationFound: application !== null,
        routesFound: routes.length
      });
    } catch (error) {
      throw new AnalyzerError(
        `Tornado analysis failed: ${(error as Error).message}`,
        'TORNADO_ANALYSIS_ERROR'
      );
    }
  }

  private async analyzeApplication(
    files: string[],
    projectPath: string,
    nodes: CASNode[]
  ): Promise<TornadoApplication | null> {
    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      const hasTornadoSignal = content.includes('tornado') || content.includes('RequestHandler');
      if (!hasTornadoSignal || !/(?:tornado\.web\.)?Application\s*\(/.test(content)) continue;

      // Two real idioms: assigned to a variable (`app = Application([...])`) or
      // constructed and returned/passed directly (`return tornado.web.Application([...])`)
      // from a factory function like `make_app()` — no variable name to anchor on there.
      const assignMatch = /(\w+)\s*=\s*(?:tornado\.web\.)?Application\s*\(/.exec(content);
      const appVariable = assignMatch ? assignMatch[1] : 'app';
      {
        const application: TornadoApplication = {
          name: path.basename(file, '.py'),
          filePath: file,
          appVariable
        };

        const appId = `app_${this.sanitizeId(application.name)}_${this.sanitizeId(file)}`;
        const appNode = this.createNodeBuilder(appId, application.name, 'application')
          .withLevel(1, 'system')
          .withCategory('application', ['framework', 'tornado'])
          .withSource({ file: file, line: 1, end_line: content.split('\n').length })
          .withDescription(`Tornado application: ${application.name}`)
          .withMetadata({
            framework: 'tornado',
            attributes: { appVariable }
          })
          .build();
        nodes.push(appNode);

        return application;
      }
    }
    return null;
  }

  /** All `def get/post/put/patch/delete/head/options(self, ...)` methods per RequestHandler subclass. */
  private collectHandlerMethods(content: string): TornadoHandlerMethod[] {
    const methods: TornadoHandlerMethod[] = [];
    const classPattern = /class\s+(\w+)\s*\(\s*(?:tornado\.web\.)?RequestHandler\s*\)\s*:/g;
    let classMatch;
    while ((classMatch = classPattern.exec(content)) !== null) {
      const handlerClass = classMatch[1];
      const classEnd = this.findClassEnd(content, classMatch.index);
      const classContent = content.substring(classMatch.index, classEnd);
      const classStartLine = content.substring(0, classMatch.index).split('\n').length;

      const methodPattern = /(?:async\s+)?def\s+(get|post|put|patch|delete|head|options)\s*\(\s*self/g;
      let methodMatch;
      while ((methodMatch = methodPattern.exec(classContent)) !== null) {
        const relativeLine = classContent.substring(0, methodMatch.index).split('\n').length - 1;
        methods.push({
          handlerClass,
          method: methodMatch[1],
          line: classStartLine + relativeLine
        });
      }
    }
    return methods;
  }

  private async analyzeRoutes(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[],
    application: TornadoApplication | null,
    handlerMethods: TornadoHandlerMethod[]
  ): Promise<TornadoRoute[]> {
    const allRoutes: TornadoRoute[] = [];
    const appId = application ? `app_${this.sanitizeId(application.name)}_${this.sanitizeId(application.filePath)}` : undefined;

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');
      const lines = content.split('\n');

      const routes = this.extractRouteTuples(content, lines);
      if (routes.length === 0) continue;
      allRoutes.push(...routes);

      routes.forEach((route, index) => {
        const routeId = `route_${this.sanitizeId(file)}_${index}`;
        const handlerId = `handler_${this.sanitizeId(file)}_${this.sanitizeId(route.handlerClass)}`;

        const routeNode = this.createNodeBuilder(routeId, `${route.handlerClass} ${route.pattern}`, 'route')
          .withLevel(3, 'code')
          .withCategory('route', ['http', 'endpoint'])
          .withSource({ file: file, line: route.handlerLine || 1, end_line: route.handlerLine || 1 })
          .withDescription(`Tornado route: ${route.pattern} -> ${route.handlerClass}`)
          .withMetadata({
            framework: 'tornado',
            attributes: { pattern: route.pattern, handlerClass: route.handlerClass }
          })
          .build();
        nodes.push(routeNode);

        const handlerNode = this.createNodeBuilder(handlerId, route.handlerClass, 'controller')
          .withLevel(3, 'code')
          .withCategory('controller', ['api', 'rest'])
          .withSource({ file: file, line: route.handlerLine || 1 })
          .withDescription(`Tornado RequestHandler: ${route.handlerClass}`)
          .withMetadata({ framework: 'tornado', attributes: { route_pattern: route.pattern } })
          .build();
        nodes.push(handlerNode);

        edges.push(this.createEdge(`${routeId}_calls_${handlerId}`, routeId, handlerId, 'calls'));
        if (appId) {
          edges.push(this.createEdge(`${appId}_exposes_${routeId}`, appId, routeId, 'exposes'));
        }

        const methodsForClass = handlerMethods.filter(m => m.handlerClass === route.handlerClass);
        const methodsToEmit = methodsForClass.length > 0 ? methodsForClass : [{ handlerClass: route.handlerClass, method: 'get', line: route.handlerLine || 1 }];

        methodsToEmit.forEach(hm => {
          const methodId = `${handlerId}_${hm.method}`;
          const methodNode = this.createNodeBuilder(methodId, `${route.handlerClass}.${hm.method}`, 'function')
            .withLevel(4, 'member')
            .withCategory('function', ['handler', 'endpoint'])
            .withSource({ file: file, line: hm.line })
            .withDescription(`Tornado handler method: ${route.handlerClass}.${hm.method}`)
            .withMetadata({ framework: 'tornado', attributes: { route_method: hm.method, route_pattern: route.pattern } })
            .build();
          nodes.push(methodNode);
          edges.push(this.createEdge(`${handlerId}_defines_${methodId}`, handlerId, methodId, 'defines'));

          entryPoints.push(this.createEntryPoint(
            `entry_${routeId}_${hm.method}`,
            routeId,
            'http',
            `${hm.method.toUpperCase()} ${route.pattern}`,
            `Tornado route: ${hm.method.toUpperCase()} ${route.pattern}`,
            { method: hm.method.toUpperCase(), path: route.pattern },
            { authenticated: false, guards: [] },
            { method: hm.method.toUpperCase(), path: route.pattern, handler: route.handlerClass, framework: 'tornado' },
            { node_id: methodId, method_name: `${route.handlerClass}.${hm.method}`, file, line: hm.line }
          ));
        });
      });
    }

    return allRoutes;
  }

  /** `tornado.web.Application([(r"/path", Handler), ("/other", Handler2, {kwargs})])` */
  private extractRouteTuples(content: string, lines: string[]): TornadoRoute[] {
    const routes: TornadoRoute[] = [];
    const appCallMatch = /(?:tornado\.web\.)?Application\s*\(\s*\[/.exec(content);
    if (!appCallMatch) return routes;

    const listStart = appCallMatch.index + appCallMatch[0].length - 1;
    const listEnd = this.findMatchingBracket(content, listStart);
    const listContent = content.substring(listStart, listEnd);

    const tuplePattern = /\(\s*r?["']([^"']+)["']\s*,\s*(\w+)/g;
    let match;
    while ((match = tuplePattern.exec(listContent)) !== null) {
      const pattern = match[1];
      const handlerClass = match[2];
      routes.push({
        pattern,
        handlerClass,
        handlerLine: this.findClassDefLine(lines, handlerClass)
      });
    }

    return routes;
  }

  private findClassDefLine(lines: string[], className: string): number {
    const pattern = new RegExp(`^\\s*class\\s+${className}\\s*\\(`);
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i])) return i + 1;
    }
    return 1;
  }

  private findMatchingBracket(content: string, openIndex: number): number {
    let depth = 0;
    for (let i = openIndex; i < content.length; i++) {
      if (content[i] === '[') depth++;
      else if (content[i] === ']') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return content.length;
  }

  private findClassEnd(content: string, classStart: number): number {
    const lines = content.substring(classStart).split('\n');
    let indentLevel = 0;
    let found = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith('class ') && !found) {
        indentLevel = line.length - line.trimStart().length;
        found = true;
        continue;
      }
      if (found && line.trim() && line.length - line.trimStart().length <= indentLevel && !line.trimStart().startsWith('#') && i > 0) {
        return classStart + lines.slice(0, i).join('\n').length;
      }
    }
    return content.length;
  }

  private extractPythonImports(content: string): string[] {
    const imports: string[] = [];
    const importPattern = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm;
    let match;
    while ((match = importPattern.exec(content)) !== null) {
      imports.push(match[1] || match[2]);
    }
    return imports;
  }

  private async detectVersion(projectPath: string): Promise<string> {
    try {
      const requirementsPath = path.join(projectPath, 'requirements.txt');
      if (await fs.pathExists(requirementsPath)) {
        const requirements = await fs.readFile(requirementsPath, 'utf-8');
        const versionMatch = requirements.match(/tornado==([^\s\n]+)/i);
        if (versionMatch) return versionMatch[1];
      }
    } catch {
      // Continue
    }
    return 'unknown';
  }

  protected getCapabilities(): string[] {
    return ['tornado-analysis', 'route-extraction', 'request-handler-detection', 'application-detection'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'system';
      case 2: return 'architectural';
      case 3: return 'code';
      case 4: return 'member';
      case 5: return 'implementation';
      default: return `level_${level}`;
    }
  }
}
