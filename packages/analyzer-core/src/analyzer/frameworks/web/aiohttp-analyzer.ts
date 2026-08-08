import { BaseAnalyzer, CASAnalysisResult, CASNode, CASEdge, CASEntryPoint, CASExitPoint, AnalysisContext, FileAnalysisContext, FileAnalysisResult } from '../../core/base-analyzer';
import { AnalyzerError } from '../../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';

interface AiohttpApplication {
  name: string;
  filePath: string;
  appVariable: string;
}

interface AiohttpRoute {
  method: string;
  pattern: string;
  handlerName: string;
  handlerLine: number;
  registrationStyle: 'add_route' | 'route_table_def';
  routeTableName?: string;
}

/**
 * aiohttp Framework Analyzer.
 *
 * Covers the two real-world route registration idioms:
 *  - imperative: `app.router.add_get('/path', handler)` / `add_post` / `add_route(method, path, handler)`
 *  - declarative: `routes = web.RouteTableDef()` + `@routes.get('/path')` decorated handlers,
 *    later wired in with `app.add_routes(routes)`.
 * `web.Application()` construction is the application-boundary signal.
 */
export class AiohttpAnalyzer extends BaseAnalyzer {
  constructor() {
    super('aiohttp', 'aiohttp Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const requirementsPath = path.join(projectPath, 'requirements.txt');
      const pyprojectPath = path.join(projectPath, 'pyproject.toml');
      const pipfilePath = path.join(projectPath, 'Pipfile');

      if (await fs.pathExists(requirementsPath)) {
        const requirements = await fs.readFile(requirementsPath, 'utf-8');
        if (/\baiohttp\b/i.test(requirements)) return true;
      }

      if (await fs.pathExists(pyprojectPath)) {
        const pyproject = await fs.readFile(pyprojectPath, 'utf-8');
        if (/\baiohttp\b/i.test(pyproject)) return true;
      }

      if (await fs.pathExists(pipfilePath)) {
        const pipfile = await fs.readFile(pipfilePath, 'utf-8');
        if (/\baiohttp\b/i.test(pipfile)) return true;
      }

      const pythonFiles = await glob(['**/*.py'], {
        cwd: projectPath,
        ignore: [...this.getIgnorePatterns({ projectPath }), '**/venv/**', '**/.venv/**', '**/env/**', '**/__pycache__/**'],
        nodir: true
      });

      for (const file of pythonFiles) {
        const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
        if (content.includes('from aiohttp') || content.includes('import aiohttp')) {
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
        framework: 'aiohttp',
        version: await this.detectVersion(context.projectPath),
        applicationFound: application !== null,
        routesFound: routes.length
      });
    } catch (error) {
      throw new AnalyzerError(
        `aiohttp analysis failed: ${(error as Error).message}`,
        'AIOHTTP_ANALYSIS_ERROR'
      );
    }
  }

  private async analyzeApplication(
    files: string[],
    projectPath: string,
    nodes: CASNode[]
  ): Promise<AiohttpApplication | null> {
    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      const appMatch = /(\w+)\s*=\s*web\.Application\s*\(/.exec(content);
      if (appMatch) {
        const appVariable = appMatch[1];
        const application: AiohttpApplication = {
          name: path.basename(file, '.py'),
          filePath: file,
          appVariable
        };

        const appId = `app_${this.sanitizeId(application.name)}_${this.sanitizeId(file)}`;
        const appNode = this.createNodeBuilder(appId, application.name, 'application')
          .withLevel(1, 'system')
          .withCategory('application', ['framework', 'aiohttp'])
          .withSource({ file: file, line: 1, end_line: content.split('\n').length })
          .withDescription(`aiohttp application: ${application.name}`)
          .withMetadata({
            framework: 'aiohttp',
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
    application: AiohttpApplication | null
  ): Promise<AiohttpRoute[]> {
    const allRoutes: AiohttpRoute[] = [];
    const appId = application ? `app_${this.sanitizeId(application.name)}_${this.sanitizeId(application.filePath)}` : undefined;

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      const routes = [
        ...this.extractImperativeRoutes(content),
        ...this.extractRouteTableRoutes(content)
      ];
      if (routes.length === 0) continue;

      allRoutes.push(...routes);

      routes.forEach((route, index) => {
        const routeId = `route_${this.sanitizeId(file)}_${index}`;
        const handlerId = `handler_${this.sanitizeId(file)}_${this.sanitizeId(route.handlerName)}`;

        const routeNode = this.createNodeBuilder(routeId, `${route.method.toUpperCase()} ${route.pattern}`, 'route')
          .withLevel(3, 'code')
          .withCategory('route', ['http', 'endpoint'])
          .withSource({ file: file, line: route.handlerLine || 1, end_line: route.handlerLine || 1 })
          .withDescription(`aiohttp route: ${route.method.toUpperCase()} ${route.pattern}`)
          .withMetadata({
            framework: 'aiohttp',
            attributes: {
              method: route.method,
              pattern: route.pattern,
              handlerName: route.handlerName,
              registrationStyle: route.registrationStyle,
              routeTableName: route.routeTableName
            }
          })
          .build();
        nodes.push(routeNode);

        const handlerNode = this.createNodeBuilder(handlerId, route.handlerName, 'function')
          .withLevel(3, 'code')
          .withCategory('function', ['handler', 'endpoint'])
          .withSource({ file: file, line: route.handlerLine || 1 })
          .withDescription(`aiohttp route handler: ${route.handlerName}`)
          .withMetadata({
            framework: 'aiohttp',
            attributes: { route_method: route.method, route_path: route.pattern }
          })
          .build();
        nodes.push(handlerNode);

        edges.push(this.createEdge(`${routeId}_calls_${handlerId}`, routeId, handlerId, 'calls'));

        if (appId) {
          edges.push(this.createEdge(`${appId}_exposes_${routeId}`, appId, routeId, 'exposes'));
        }

        entryPoints.push(this.createEntryPoint(
          `entry_${routeId}`,
          routeId,
          'http',
          `${route.method.toUpperCase()} ${route.pattern}`,
          `aiohttp route: ${route.method.toUpperCase()} ${route.pattern}`,
          { method: route.method.toUpperCase(), path: route.pattern },
          { authenticated: false, guards: [] },
          { method: route.method.toUpperCase(), path: route.pattern, handler: route.handlerName, framework: 'aiohttp' },
          { node_id: handlerId, method_name: route.handlerName, file, line: route.handlerLine || 1 }
        ));
      });
    }

    return allRoutes;
  }

  /** `app.router.add_get('/path', handler)` / add_post / add_route(method, path, handler) */
  private extractImperativeRoutes(content: string): AiohttpRoute[] {
    const routes: AiohttpRoute[] = [];
    const lines = content.split('\n');

    const methodPattern = /\.router\.add_(get|post|put|patch|delete|head|options|view)\s*\(\s*["']([^"']+)["']\s*,\s*(\w+)/g;
    let match;
    while ((match = methodPattern.exec(content)) !== null) {
      const method = match[1] === 'view' ? 'get' : match[1];
      const pattern = match[2];
      const handlerName = match[3];
      const line = content.substring(0, match.index).split('\n').length;
      routes.push({
        method,
        pattern,
        handlerName,
        handlerLine: this.findFunctionDefLine(lines, handlerName),
        registrationStyle: 'add_route'
      });
    }

    const addRoutePattern = /\.router\.add_route\s*\(\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']\s*,\s*(\w+)/g;
    while ((match = addRoutePattern.exec(content)) !== null) {
      const method = match[1].toLowerCase();
      const pattern = match[2];
      const handlerName = match[3];
      routes.push({
        method,
        pattern,
        handlerName,
        handlerLine: this.findFunctionDefLine(lines, handlerName),
        registrationStyle: 'add_route'
      });
    }

    return routes;
  }

  /** `routes = web.RouteTableDef()` + `@routes.get('/path')` decorated handlers */
  private extractRouteTableRoutes(content: string): AiohttpRoute[] {
    const routes: AiohttpRoute[] = [];
    const tableNamePattern = /(\w+)\s*=\s*web\.RouteTableDef\s*\(\s*\)/g;
    const tableNames: string[] = [];
    let tableMatch;
    while ((tableMatch = tableNamePattern.exec(content)) !== null) {
      tableNames.push(tableMatch[1]);
    }
    if (tableNames.length === 0) return routes;

    const lines = content.split('\n');
    for (const tableName of tableNames) {
      const decoratorPattern = new RegExp(
        `@${tableName}\\.(get|post|put|patch|delete|head|options|view)\\s*\\(\\s*["']([^"']+)["']`,
        'g'
      );
      let match;
      while ((match = decoratorPattern.exec(content)) !== null) {
        const method = match[1] === 'view' ? 'get' : match[1];
        const pattern = match[2];
        const decoratorLine = content.substring(0, match.index).split('\n').length;
        const handlerInfo = this.findNextFunctionDef(lines, decoratorLine - 1);
        if (!handlerInfo) continue;

        routes.push({
          method,
          pattern,
          handlerName: handlerInfo.name,
          handlerLine: handlerInfo.line,
          registrationStyle: 'route_table_def',
          routeTableName: tableName
        });
      }
    }

    return routes;
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
        const versionMatch = requirements.match(/aiohttp==([^\s\n]+)/i);
        if (versionMatch) return versionMatch[1];
      }
    } catch {
      // Continue
    }
    return 'unknown';
  }

  protected getCapabilities(): string[] {
    return ['aiohttp-analysis', 'route-extraction', 'route-table-def-detection', 'application-detection'];
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
