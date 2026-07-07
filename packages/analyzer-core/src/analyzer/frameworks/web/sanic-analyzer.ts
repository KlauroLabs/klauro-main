import { BaseAnalyzer, CASAnalysisResult, CASNode, CASEdge, CASEntryPoint, CASExitPoint, AnalysisContext, FileAnalysisContext, FileAnalysisResult } from '../../core/base-analyzer';
import { AnalyzerError } from '../../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';

interface SanicApplication {
  name: string;
  filePath: string;
  appVariable: string;
}

interface SanicBlueprint {
  name: string;
  filePath: string;
  variableName: string;
  urlPrefix?: string;
}

interface SanicRoute {
  methods: string[];
  pattern: string;
  handlerName: string;
  handlerLine: number;
  ownerVariable: string;
  isBlueprint: boolean;
}

/**
 * Sanic Framework Analyzer.
 *
 * Covers `@app.route('/path')` / `@app.get(...)` / `@app.post(...)` decorated
 * handlers, `app.add_route(handler, '/path', methods=[...])`, and `Blueprint`
 * registration (`bp = Blueprint('name', url_prefix='/x')` + `@bp.get(...)`).
 */
export class SanicAnalyzer extends BaseAnalyzer {
  constructor() {
    super('sanic', 'Sanic Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const requirementsPath = path.join(projectPath, 'requirements.txt');
      const pyprojectPath = path.join(projectPath, 'pyproject.toml');
      const pipfilePath = path.join(projectPath, 'Pipfile');

      if (await fs.pathExists(requirementsPath)) {
        const requirements = await fs.readFile(requirementsPath, 'utf-8');
        if (/\bsanic\b/i.test(requirements)) return true;
      }

      if (await fs.pathExists(pyprojectPath)) {
        const pyproject = await fs.readFile(pyprojectPath, 'utf-8');
        if (/\bsanic\b/i.test(pyproject)) return true;
      }

      if (await fs.pathExists(pipfilePath)) {
        const pipfile = await fs.readFile(pipfilePath, 'utf-8');
        if (/\bsanic\b/i.test(pipfile)) return true;
      }

      const pythonFiles = await glob(['**/*.py'], {
        cwd: projectPath,
        ignore: [...this.getIgnorePatterns({ projectPath }), '**/venv/**', '**/.venv/**', '**/env/**', '**/__pycache__/**'],
        nodir: true
      });

      for (const file of pythonFiles) {
        const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
        if (content.includes('from sanic') || content.includes('import sanic') || content.includes('Sanic(')) {
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
    const blueprints = await this.analyzeBlueprints([file], context.projectPath, nodes);
    await this.analyzeRoutes([file], context.projectPath, nodes, edges, entryPoints, application, blueprints);

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
      const blueprints = await this.analyzeBlueprints(pythonFiles, context.projectPath, nodes);
      const routes = await this.analyzeRoutes(pythonFiles, context.projectPath, nodes, edges, entryPoints, application, blueprints);

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework: 'sanic',
        version: await this.detectVersion(context.projectPath),
        applicationFound: application !== null,
        blueprintsFound: blueprints.length,
        routesFound: routes.length
      });
    } catch (error) {
      throw new AnalyzerError(
        `Sanic analysis failed: ${(error as Error).message}`,
        'SANIC_ANALYSIS_ERROR'
      );
    }
  }

  private async analyzeApplication(
    files: string[],
    projectPath: string,
    nodes: CASNode[]
  ): Promise<SanicApplication | null> {
    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      const appMatch = /(\w+)\s*=\s*Sanic\s*\(/.exec(content);
      if (appMatch) {
        const appVariable = appMatch[1];
        const application: SanicApplication = {
          name: path.basename(file, '.py'),
          filePath: file,
          appVariable
        };

        const appId = `app_${this.sanitizeId(application.name)}_${this.sanitizeId(file)}`;
        const appNode = this.createNodeBuilder(appId, application.name, 'application')
          .withLevel(1, 'system')
          .withCategory('application', ['framework', 'sanic'])
          .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
          .withDescription(`Sanic application: ${application.name}`)
          .withMetadata({
            framework: 'sanic',
            attributes: { appVariable }
          })
          .build();
        nodes.push(appNode);

        return application;
      }
    }
    return null;
  }

  private async analyzeBlueprints(
    files: string[],
    projectPath: string,
    nodes: CASNode[]
  ): Promise<SanicBlueprint[]> {
    const blueprints: SanicBlueprint[] = [];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      const bpPattern = /(\w+)\s*=\s*Blueprint\s*\(\s*["']([^"']+)["'](?:[^)]*url_prefix\s*=\s*["']([^"']+)["'])?/g;
      let match;
      while ((match = bpPattern.exec(content)) !== null) {
        const variableName = match[1];
        const name = match[2];
        const urlPrefix = match[3];

        const blueprint: SanicBlueprint = { name, filePath: file, variableName, urlPrefix };
        blueprints.push(blueprint);

        const bpId = `blueprint_${this.sanitizeId(name)}_${this.sanitizeId(file)}`;
        const bpNode = this.createNodeBuilder(bpId, name, 'module')
          .withLevel(2, 'component')
          .withCategory('module', ['blueprint'])
          .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
          .withDescription(`Sanic blueprint: ${name}`)
          .withMetadata({
            framework: 'sanic',
            attributes: { variableName, urlPrefix: urlPrefix || '/' }
          })
          .build();
        nodes.push(bpNode);
      }
    }

    return blueprints;
  }

  private async analyzeRoutes(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[],
    application: SanicApplication | null,
    blueprints: SanicBlueprint[]
  ): Promise<SanicRoute[]> {
    const allRoutes: SanicRoute[] = [];
    const appId = application ? `app_${this.sanitizeId(application.name)}_${this.sanitizeId(application.filePath)}` : undefined;

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');
      const lines = content.split('\n');

      const ownerVariables = new Set<string>();
      if (application) ownerVariables.add(application.appVariable);
      blueprints.filter(bp => bp.filePath === file).forEach(bp => ownerVariables.add(bp.variableName));
      // Also allow any variable used as a Sanic/Blueprint decorator owner in this file,
      // even if declared elsewhere (shared blueprints imported across files).
      const decoratorOwnerPattern = /@(\w+)\.(route|get|post|put|patch|delete|head|options|websocket)\s*\(/g;
      let ownerMatch;
      while ((ownerMatch = decoratorOwnerPattern.exec(content)) !== null) {
        ownerVariables.add(ownerMatch[1]);
      }

      const routes = this.extractDecoratorRoutes(content, lines, ownerVariables, blueprints, file)
        .concat(this.extractAddRouteRoutes(content, lines, ownerVariables));

      if (routes.length === 0) continue;
      allRoutes.push(...routes);

      routes.forEach((route, index) => {
        const routeId = `route_${this.sanitizeId(file)}_${index}`;
        const handlerId = `handler_${this.sanitizeId(file)}_${this.sanitizeId(route.handlerName)}`;
        const fullPattern = route.isBlueprint
          ? this.joinPrefix(blueprints.find(bp => bp.variableName === route.ownerVariable)?.urlPrefix, route.pattern)
          : route.pattern;

        const routeNode = this.createNodeBuilder(routeId, `${route.methods.join('|').toUpperCase()} ${fullPattern}`, 'route')
          .withLevel(3, 'code')
          .withCategory('route', ['http', 'endpoint'])
          .withSource({ file: fullPath, line: route.handlerLine || 1, end_line: route.handlerLine || 1 })
          .withDescription(`Sanic route: ${route.methods.join('|').toUpperCase()} ${fullPattern}`)
          .withMetadata({
            framework: 'sanic',
            attributes: {
              methods: route.methods,
              pattern: fullPattern,
              handlerName: route.handlerName,
              blueprint: route.isBlueprint ? route.ownerVariable : undefined
            }
          })
          .build();
        nodes.push(routeNode);

        const handlerNode = this.createNodeBuilder(handlerId, route.handlerName, 'function')
          .withLevel(3, 'code')
          .withCategory('function', ['handler', 'endpoint'])
          .withSource({ file: fullPath, line: route.handlerLine || 1 })
          .withDescription(`Sanic route handler: ${route.handlerName}`)
          .withMetadata({ framework: 'sanic', attributes: { route_methods: route.methods, route_path: fullPattern } })
          .build();
        nodes.push(handlerNode);

        edges.push(this.createEdge(`${routeId}_calls_${handlerId}`, routeId, handlerId, 'calls'));

        if (route.isBlueprint) {
          const bp = blueprints.find(b => b.variableName === route.ownerVariable && b.filePath === file);
          if (bp) {
            const bpId = `blueprint_${this.sanitizeId(bp.name)}_${this.sanitizeId(file)}`;
            edges.push(this.createEdge(`${bpId}_exposes_${routeId}`, bpId, routeId, 'exposes'));
          }
        } else if (appId) {
          edges.push(this.createEdge(`${appId}_exposes_${routeId}`, appId, routeId, 'exposes'));
        }

        route.methods.forEach(method => {
          entryPoints.push(this.createEntryPoint(
            `entry_${routeId}_${method}`,
            routeId,
            'http',
            `${method.toUpperCase()} ${fullPattern}`,
            `Sanic route: ${method.toUpperCase()} ${fullPattern}`,
            { method: method.toUpperCase(), path: fullPattern },
            { authenticated: false, guards: [] },
            { method: method.toUpperCase(), path: fullPattern, handler: route.handlerName, framework: 'sanic' },
            { node_id: handlerId, method_name: route.handlerName, file, line: route.handlerLine || 1 }
          ));
        });
      });
    }

    return allRoutes;
  }

  /** `@app.route('/path', methods=[...])` / `@app.get(...)` / `@bp.post(...)` */
  private extractDecoratorRoutes(
    content: string,
    lines: string[],
    ownerVariables: Set<string>,
    blueprints: SanicBlueprint[],
    file: string
  ): SanicRoute[] {
    const routes: SanicRoute[] = [];
    if (ownerVariables.size === 0) return routes;

    const ownerAlternation = [...ownerVariables].map(v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const decoratorPattern = new RegExp(
      `@(${ownerAlternation})\\.(route|get|post|put|patch|delete|head|options|websocket)\\s*\\(\\s*["']([^"']+)["']([^)]*)\\)`,
      'g'
    );

    let match;
    while ((match = decoratorPattern.exec(content)) !== null) {
      const owner = match[1];
      const decoratorMethod = match[2];
      const pattern = match[3];
      const args = match[4] || '';

      let methods: string[];
      if (decoratorMethod === 'route') {
        const methodsMatch = args.match(/methods\s*=\s*\[([^\]]+)\]/);
        methods = methodsMatch
          ? methodsMatch[1].split(',').map(m => m.trim().replace(/["']/g, '').toLowerCase())
          : ['get'];
      } else if (decoratorMethod === 'websocket') {
        methods = ['get'];
      } else {
        methods = [decoratorMethod];
      }

      const decoratorLine = content.substring(0, match.index).split('\n').length;
      const handlerInfo = this.findNextFunctionDef(lines, decoratorLine - 1);
      if (!handlerInfo) continue;

      const isBlueprint = blueprints.some(bp => bp.variableName === owner && bp.filePath === file);

      routes.push({
        methods,
        pattern,
        handlerName: handlerInfo.name,
        handlerLine: handlerInfo.line,
        ownerVariable: owner,
        isBlueprint
      });
    }

    return routes;
  }

  /** `app.add_route(handler, '/path', methods=['GET', 'POST'])` */
  private extractAddRouteRoutes(content: string, lines: string[], ownerVariables: Set<string>): SanicRoute[] {
    const routes: SanicRoute[] = [];
    if (ownerVariables.size === 0) return routes;

    const ownerAlternation = [...ownerVariables].map(v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const addRoutePattern = new RegExp(
      `(${ownerAlternation})\\.add_route\\s*\\(\\s*(\\w+)\\s*,\\s*["']([^"']+)["']([^)]*)\\)`,
      'g'
    );

    let match;
    while ((match = addRoutePattern.exec(content)) !== null) {
      const owner = match[1];
      const handlerName = match[2];
      const pattern = match[3];
      const args = match[4] || '';

      const methodsMatch = args.match(/methods\s*=\s*\[([^\]]+)\]/);
      const methods = methodsMatch
        ? methodsMatch[1].split(',').map(m => m.trim().replace(/["']/g, '').toLowerCase())
        : ['get'];

      routes.push({
        methods,
        pattern,
        handlerName,
        handlerLine: this.findFunctionDefLine(lines, handlerName),
        ownerVariable: owner,
        isBlueprint: false
      });
    }

    return routes;
  }

  private joinPrefix(prefix: string | undefined, pattern: string): string {
    if (!prefix) return pattern;
    return `${prefix}${pattern}`.replace(/\/{2,}/g, '/');
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
        const versionMatch = requirements.match(/sanic==([^\s\n]+)/i);
        if (versionMatch) return versionMatch[1];
      }
    } catch {
      // Continue
    }
    return 'unknown';
  }

  protected getCapabilities(): string[] {
    return ['sanic-analysis', 'route-extraction', 'blueprint-detection', 'application-detection'];
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
