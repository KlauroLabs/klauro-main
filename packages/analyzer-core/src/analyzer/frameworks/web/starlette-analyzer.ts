import { BaseAnalyzer, CASAnalysisResult, CASNode, CASEdge, CASEntryPoint, CASExitPoint, AnalysisContext, FileAnalysisContext, FileAnalysisResult } from '../../core/base-analyzer';
import { AnalyzerError } from '../../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';

interface StarletteApplication {
  name: string;
  filePath: string;
  appVariable: string;
}

interface StarletteRoute {
  methods: string[];
  pattern: string;
  handlerName: string;
  handlerLine: number;
  source: 'routes_list' | 'decorator';
}

/**
 * Starlette Framework Analyzer.
 *
 * Covers `Starlette(routes=[Route('/path', endpoint), ...])` construction (route
 * -> endpoint function resolution) and the decorator-style `@app.route('/path')`
 * form used directly against a `Starlette()` instance.
 */
export class StarletteAnalyzer extends BaseAnalyzer {
  constructor() {
    super('starlette', 'Starlette Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const requirementsPath = path.join(projectPath, 'requirements.txt');
      const pyprojectPath = path.join(projectPath, 'pyproject.toml');
      const pipfilePath = path.join(projectPath, 'Pipfile');

      if (await fs.pathExists(requirementsPath)) {
        const requirements = await fs.readFile(requirementsPath, 'utf-8');
        if (/\bstarlette\b/i.test(requirements)) return true;
      }

      if (await fs.pathExists(pyprojectPath)) {
        const pyproject = await fs.readFile(pyprojectPath, 'utf-8');
        // Real-dependency-only: a pyproject.toml [project.optional-dependencies]
        // extras group naming "starlette" (an integration target the package
        // can instrument, e.g. via a "fastapi" extra pulling in starlette) is
        // not evidence the project itself is built with Starlette.
        if (this.pyprojectHasRealDependency(pyproject, 'starlette')) return true;
      }

      if (await fs.pathExists(pipfilePath)) {
        const pipfile = await fs.readFile(pipfilePath, 'utf-8');
        if (/\bstarlette\b/i.test(pipfile)) return true;
      }

      const pythonFiles = await glob(['**/*.py'], {
        cwd: projectPath,
        ignore: [...this.getIgnorePatterns({ projectPath }), '**/venv/**', '**/.venv/**', '**/env/**', '**/__pycache__/**'],
        nodir: true
      });

      for (const file of pythonFiles) {
        const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
        // FastAPI is built on Starlette and re-exports its symbols; only claim
        // files that reference the starlette package directly so this analyzer
        // does not double-count plain FastAPI apps that never touch Starlette API.
        // Also require the reference be an actual application/routing shape,
        // not a bare import — a framework-agnostic integration helper can
        // mention "Starlette/FastAPI" in a comment or duck-type around it
        // without the analyzed repo itself being a Starlette application.
        if (
          (content.includes('from starlette') || content.includes('import starlette')) &&
          (/\bStarlette\s*\(/.test(content) || /\bRoute\s*\(/.test(content) || /\bMount\s*\(/.test(content))
        ) {
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
    await this.analyzeRoutes([file], context.projectPath, nodes, edges, entryPoints, application);

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
      const routes = await this.analyzeRoutes(pythonFiles, context.projectPath, nodes, edges, entryPoints, application);

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework: 'starlette',
        version: await this.detectVersion(context.projectPath),
        applicationFound: application !== null,
        routesFound: routes.length
      });
    } catch (error) {
      throw new AnalyzerError(
        `Starlette analysis failed: ${(error as Error).message}`,
        'STARLETTE_ANALYSIS_ERROR'
      );
    }
  }

  private async analyzeApplication(
    files: string[],
    projectPath: string,
    nodes: CASNode[]
  ): Promise<StarletteApplication | null> {
    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      const appMatch = /(\w+)\s*=\s*Starlette\s*\(/.exec(content);
      if (appMatch) {
        const appVariable = appMatch[1];
        const application: StarletteApplication = {
          name: path.basename(file, '.py'),
          filePath: file,
          appVariable
        };

        const appId = `app_${this.sanitizeId(application.name)}_${this.sanitizeId(file)}`;
        const appNode = this.createNodeBuilder(appId, application.name, 'application')
          .withLevel(1, 'system')
          .withCategory('application', ['framework', 'starlette'])
          .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
          .withDescription(`Starlette application: ${application.name}`)
          .withMetadata({
            framework: 'starlette',
            attributes: { appVariable }
          })
          .build();
        nodes.push(appNode);

        return application;
      }
    }
    return null;
  }

  private async analyzeRoutes(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[],
    application: StarletteApplication | null
  ): Promise<StarletteRoute[]> {
    const allRoutes: StarletteRoute[] = [];
    const appId = application ? `app_${this.sanitizeId(application.name)}_${this.sanitizeId(application.filePath)}` : undefined;

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');
      const lines = content.split('\n');

      const routes = [
        ...this.extractRoutesListEntries(content, lines),
        ...this.extractDecoratorRoutes(content, lines, application)
      ];
      if (routes.length === 0) continue;
      allRoutes.push(...routes);

      routes.forEach((route, index) => {
        const routeId = `route_${this.sanitizeId(file)}_${index}`;
        const handlerId = `handler_${this.sanitizeId(file)}_${this.sanitizeId(route.handlerName)}`;

        const routeNode = this.createNodeBuilder(routeId, `${route.methods.join('|').toUpperCase()} ${route.pattern}`, 'route')
          .withLevel(3, 'code')
          .withCategory('route', ['http', 'endpoint'])
          .withSource({ file: fullPath, line: route.handlerLine || 1, end_line: route.handlerLine || 1 })
          .withDescription(`Starlette route: ${route.pattern} -> ${route.handlerName}`)
          .withMetadata({
            framework: 'starlette',
            attributes: { methods: route.methods, pattern: route.pattern, handlerName: route.handlerName, source: route.source }
          })
          .build();
        nodes.push(routeNode);

        const handlerNode = this.createNodeBuilder(handlerId, route.handlerName, 'function')
          .withLevel(3, 'code')
          .withCategory('function', ['handler', 'endpoint'])
          .withSource({ file: fullPath, line: route.handlerLine || 1 })
          .withDescription(`Starlette endpoint: ${route.handlerName}`)
          .withMetadata({ framework: 'starlette', attributes: { route_methods: route.methods, route_path: route.pattern } })
          .build();
        nodes.push(handlerNode);

        edges.push(this.createEdge(`${routeId}_calls_${handlerId}`, routeId, handlerId, 'calls'));
        if (appId) {
          edges.push(this.createEdge(`${appId}_exposes_${routeId}`, appId, routeId, 'exposes'));
        }

        route.methods.forEach(method => {
          entryPoints.push(this.createEntryPoint(
            `entry_${routeId}_${method}`,
            routeId,
            'http',
            `${method.toUpperCase()} ${route.pattern}`,
            `Starlette route: ${method.toUpperCase()} ${route.pattern}`,
            { method: method.toUpperCase(), path: route.pattern },
            { authenticated: false, guards: [] },
            { method: method.toUpperCase(), path: route.pattern, handler: route.handlerName, framework: 'starlette' },
            { node_id: handlerId, method_name: route.handlerName, file, line: route.handlerLine || 1 }
          ));
        });
      });
    }

    return allRoutes;
  }

  /** `Starlette(routes=[Route('/path', endpoint, methods=['GET'])])` */
  private extractRoutesListEntries(content: string, lines: string[]): StarletteRoute[] {
    const routes: StarletteRoute[] = [];
    const routesArgMatch = /routes\s*=\s*\[/.exec(content);
    if (!routesArgMatch) return routes;

    const listStart = routesArgMatch.index + routesArgMatch[0].length - 1;
    const listEnd = this.findMatchingBracket(content, listStart);
    const listContent = content.substring(listStart, listEnd);

    const routeEntryPattern = /Route\s*\(\s*["']([^"']+)["']\s*,\s*(\w+)([^)]*)\)/g;
    let match;
    while ((match = routeEntryPattern.exec(listContent)) !== null) {
      const pattern = match[1];
      const handlerName = match[2];
      const args = match[3] || '';

      const methodsMatch = args.match(/methods\s*=\s*\[([^\]]+)\]/);
      const methods = methodsMatch
        ? methodsMatch[1].split(',').map(m => m.trim().replace(/["']/g, '').toLowerCase())
        : ['get'];

      routes.push({
        methods,
        pattern,
        handlerName,
        handlerLine: this.findFunctionDefLine(lines, handlerName),
        source: 'routes_list'
      });
    }

    return routes;
  }

  /** `@app.route('/path', methods=['GET'])` directly on a Starlette() instance */
  private extractDecoratorRoutes(content: string, lines: string[], application: StarletteApplication | null): StarletteRoute[] {
    const routes: StarletteRoute[] = [];
    if (!application) return routes;

    const owner = application.appVariable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const decoratorPattern = new RegExp(`@${owner}\\.route\\s*\\(\\s*["']([^"']+)["']([^)]*)\\)`, 'g');

    let match;
    while ((match = decoratorPattern.exec(content)) !== null) {
      const pattern = match[1];
      const args = match[2] || '';
      const methodsMatch = args.match(/methods\s*=\s*\[([^\]]+)\]/);
      const methods = methodsMatch
        ? methodsMatch[1].split(',').map(m => m.trim().replace(/["']/g, '').toLowerCase())
        : ['get'];

      const decoratorLine = content.substring(0, match.index).split('\n').length;
      const handlerInfo = this.findNextFunctionDef(lines, decoratorLine - 1);
      if (!handlerInfo) continue;

      routes.push({
        methods,
        pattern,
        handlerName: handlerInfo.name,
        handlerLine: handlerInfo.line,
        source: 'decorator'
      });
    }

    return routes;
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

  private findFunctionDefLine(lines: string[], handlerName: string): number {
    const pattern = new RegExp(`^\\s*(async\\s+)?def\\s+${handlerName}\\s*\\(`);
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i])) return i + 1;
    }
    return 1;
  }

  private findNextFunctionDef(lines: string[], fromLineIndex: number): { name: string; line: number } | null {
    for (let i = fromLineIndex; i < Math.min(lines.length, fromLineIndex + 10); i++) {
      const trimmed = lines[i].trim();
      const match = trimmed.match(/^(?:async\s+)?def\s+(\w+)\s*\(/);
      if (match) {
        return { name: match[1], line: i + 1 };
      }
      if (trimmed.startsWith('@') || trimmed.length === 0) continue;
      break;
    }
    return null;
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
        const versionMatch = requirements.match(/starlette==([^\s\n]+)/i);
        if (versionMatch) return versionMatch[1];
      }
    } catch {
      // Continue
    }
    return 'unknown';
  }

  protected getCapabilities(): string[] {
    return ['starlette-analysis', 'route-extraction', 'endpoint-resolution', 'application-detection'];
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
