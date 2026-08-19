import { AnalysisContext, BaseAnalyzer } from '../../core/base-analyzer';
import { CASContribution, CASEdge, CASEntryPoint, CASExitPoint, CASNode } from '../../../types/cas.types';
import * as fs from 'fs-extra';
import * as path from 'node:path';
import { cachedGlob as glob } from '../../core/glob-cache';
import { extractStaticMemberCalls } from '../../core/javascript-static-call';

interface AngularJsModule {
  id: string;
  name: string;
  dependencies: string[];
}

interface AngularJsRegistration {
  id: string;
  moduleName: string;
  kind: string;
  name: string;
  file: string;
  line: number;
  index: number;
  controllerName?: string;
  templateUrl?: string;
}

export class AngularJsAnalyzer extends BaseAnalyzer {
  constructor() {
    super('angularjs', 'AngularJS Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    const packagePath = path.join(projectPath, 'package.json');
    if (await fs.pathExists(packagePath)) {
      try {
        const manifest = await fs.readJson(packagePath);
        const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
        if (dependencies.angular) return true;
      } catch {}
    }
    const files = await this.sourceFiles({ projectPath });
    for (const file of files) {
      try {
        if (/\bangular\.module\s*\(/.test(await fs.readFile(path.join(projectPath, file), 'utf8'))) return true;
      } catch {}
    }
    return false;
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const modules = new Map<string, AngularJsModule>();
    const registrations: AngularJsRegistration[] = [];
    const contents = new Map<string, string>();

    for (const file of await this.sourceFiles(context)) {
      let content: string;
      try {
        content = await fs.readFile(path.join(context.projectPath, file), 'utf8');
      } catch {
        continue;
      }
      if (!/\bangular\.module\s*\(/.test(content)) continue;
      contents.set(file, content);
      this.extractModules(content, file, modules, nodes);
      registrations.push(...this.extractRegistrations(content, file, nodes));
    }

    this.ensureReferencedModules(modules, registrations, nodes);
    this.buildModuleEdges(modules, registrations, nodes, edges);
    this.buildRegistrationEdges(registrations, edges);
    for (const [file, content] of contents) {
      const fileRegistrations = registrations.filter(registration => registration.file === file);
      this.extractRoutes(content, file, registrations, nodes, edges, entryPoints);
      this.extractHttpExits(content, file, fileRegistrations, exitPoints);
    }

    return this.createContribution(nodes, edges, entryPoints, exitPoints, {
      framework_specific: {
        framework: 'angularjs',
        modules_detected: modules.size,
        registrations_detected: registrations.length,
        routes_detected: entryPoints.length,
        api_calls_detected: exitPoints.length,
      },
    });
  }

  protected getCapabilities(): string[] {
    return ['angularjs-module-graph', 'angularjs-registration-graph', 'angularjs-client-routes', 'angularjs-http-exits'];
  }

  protected getLevelName(level: number): string {
    if (level === 2) return 'AngularJS module';
    if (level === 3) return 'AngularJS registration';
    return 'AngularJS implementation';
  }

  private async sourceFiles(context: AnalysisContext): Promise<string[]> {
    const files = await glob(['**/*.{js,mjs,cjs}'], {
      cwd: context.projectPath,
      ignore: [...this.getIgnorePatterns(context), '**/*.min.js', '**/*.test.js', '**/*.spec.js'],
      nodir: true,
    });
    return this.capAndPrioritizeSourceFiles(files, 'AngularJS candidate files');
  }

  private extractModules(content: string, file: string, modules: Map<string, AngularJsModule>, nodes: CASNode[]): void {
    const pattern = /\bangular\.module\s*\(\s*(['"])([^'"]+)\1(?:\s*,\s*\[([\s\S]*?)\])?\s*\)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      if (match[3] === undefined) continue;
      const name = match[2];
      const dependencies = match[3]
        ? [...match[3].matchAll(/['"]([^'"]+)['"]/g)].map(dependency => dependency[1])
        : [];
      if (modules.has(name)) continue;
      const id = this.generateId('angularjs_module', file, name);
      modules.set(name, { id, name, dependencies });
      nodes.push(this.createNodeBuilder(id, name, 'angularjs_module')
        .withLevel(2, this.getLevelName(2))
        .withSource({ file, line: this.lineAt(content, match.index) })
        .withMetadata({ framework: 'angularjs', attributes: { dependencies } })
        .build());
    }
  }

  private extractRegistrations(content: string, file: string, nodes: CASNode[]): AngularJsRegistration[] {
    const moduleCalls = [...content.matchAll(/\bangular\.module\s*\(\s*(['"])([^'"]+)\1[^)]*\)/g)]
      .map(match => ({ name: match[2], index: match.index || 0 }));
    const pattern = /\.(component|controller|service|factory|directive|filter)\s*\(\s*(['"])([^'"]+)\2/g;
    const registrations: AngularJsRegistration[] = [];
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const moduleCall = [...moduleCalls].reverse().find(candidate => candidate.index <= match!.index);
      if (!moduleCall) continue;
      const kind = match[1];
      const name = match[3];
      const openParen = content.indexOf('(', match.index);
      const closeParen = this.findMatchingParen(content, openParen);
      const registrationBody = closeParen === -1 ? '' : content.slice(openParen + 1, closeParen);
      const controllerName = kind === 'component'
        ? registrationBody.match(/\bcontroller\s*:\s*['"]([^'"]+)['"]/)?.[1]
        : undefined;
      const templateUrl = kind === 'component'
        ? registrationBody.match(/\btemplateUrl\s*:\s*['"]([^'"]+)['"]/)?.[1]
        : undefined;
      const id = this.generateId(`angularjs_${kind}`, file, name);
      if (!nodes.some(node => node.id === id)) {
        nodes.push(this.createNodeBuilder(id, name, `angularjs_${kind}`)
          .withLevel(3, this.getLevelName(3))
          .withSource({ file, line: this.lineAt(content, match.index) })
          .withMetadata({ framework: 'angularjs', attributes: { module: moduleCall.name, registration: kind, controller: controllerName, template_url: templateUrl } })
          .build());
      }
      registrations.push({
        id,
        moduleName: moduleCall.name,
        kind,
        name,
        file,
        line: this.lineAt(content, match.index),
        index: match.index,
        controllerName,
        templateUrl,
      });
    }
    return registrations;
  }

  private ensureReferencedModules(modules: Map<string, AngularJsModule>, registrations: AngularJsRegistration[], nodes: CASNode[]): void {
    for (const registration of registrations) {
      if (modules.has(registration.moduleName)) continue;
      const id = `angularjs_module_reference_${this.sanitizeId(registration.moduleName)}`;
      modules.set(registration.moduleName, { id, name: registration.moduleName, dependencies: [] });
      nodes.push(this.createNode(id, registration.moduleName, 'angularjs_module_reference', 2, registration.file, registration.line, registration.line, {
        framework: 'angularjs',
        resolution: 'referenced',
      }));
    }
  }

  private buildModuleEdges(modules: Map<string, AngularJsModule>, registrations: AngularJsRegistration[], nodes: CASNode[], edges: CASEdge[]): void {
    for (const module of modules.values()) {
      for (const dependencyName of module.dependencies) {
        let dependency = modules.get(dependencyName);
        if (!dependency) {
          const id = `angularjs_module_dependency_${this.sanitizeId(dependencyName)}`;
          dependency = { id, name: dependencyName, dependencies: [] };
          modules.set(dependencyName, dependency);
          nodes.push(this.createNode(id, dependencyName, 'angularjs_module_dependency', 2, undefined, undefined, undefined, {
            framework: 'angularjs',
            resolution: 'external',
          }));
        }
        edges.push(this.createEdge(this.generateEdgeId(module.id, dependency.id, 'depends-on'), module.id, dependency.id, 'depends-on', 'architecture'));
      }
    }
    for (const registration of registrations) {
      const module = modules.get(registration.moduleName)!;
      edges.push(this.createEdge(this.generateEdgeId(module.id, registration.id, 'contains'), module.id, registration.id, 'contains', 'structural'));
    }
  }

  private buildRegistrationEdges(registrations: AngularJsRegistration[], edges: CASEdge[]): void {
    for (const component of registrations.filter(registration => registration.kind === 'component')) {
      const controller = component.controllerName
        ? registrations.find(registration => registration.kind === 'controller' && registration.name === component.controllerName)
        : undefined;
      if (!controller) continue;
      edges.push(this.createEdge(this.generateEdgeId(component.id, controller.id, 'uses-controller'), component.id, controller.id, 'uses-controller', 'behavior'));
    }
  }

  private extractRoutes(
    content: string,
    file: string,
    registrations: AngularJsRegistration[],
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): void {
    const pattern = /\.state\s*\(\s*(['"])([^'"]+)\1\s*,\s*\{([\s\S]*?)\}\s*\)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const stateName = match[2];
      const body = match[3];
      const routePath = body.match(/\burl\s*:\s*['"]([^'"]+)['"]/)?.[1] || stateName;
      const routeId = this.generateId('angularjs_route', file, stateName);
      nodes.push(this.createNodeBuilder(routeId, stateName, 'angularjs_route')
        .withLevel(3, this.getLevelName(3))
        .withSource({ file, line: this.lineAt(content, match.index) })
        .withMetadata({ framework: 'angularjs', attributes: { path: routePath } })
        .build());
      const targetName = body.match(/\b(?:component|controller)\s*:\s*['"]([^'"]+)['"]/)?.[1];
      const target = targetName ? registrations.find(registration => registration.name === targetName) : undefined;
      const moduleName = [...content.slice(0, match.index).matchAll(/\bangular\.module\s*\(\s*(['"])([^'"]+)\1/g)].pop()?.[2];
      const moduleNode = moduleName ? nodes.find(node => node.name === moduleName && node.type.startsWith('angularjs_module')) : undefined;
      if (moduleNode) edges.push(this.createEdge(this.generateEdgeId(moduleNode.id, routeId, 'contains'), moduleNode.id, routeId, 'contains', 'structural'));
      if (target) edges.push(this.createEdge(this.generateEdgeId(routeId, target.id, 'routes-to'), routeId, target.id, 'routes-to', 'behavior'));
      entryPoints.push(this.createEntryPoint(
        `entry_${routeId}`,
        routeId,
        'route',
        stateName,
        `AngularJS client route ${routePath}`,
        { path: routePath },
        undefined,
        { framework: 'angularjs', state: stateName },
        { node_id: target?.id || routeId, method_name: target?.name || stateName, file }
      ));
    }
  }

  private extractHttpExits(content: string, file: string, registrations: AngularJsRegistration[], exitPoints: CASExitPoint[]): void {
    const calls = extractStaticMemberCalls(
      content,
      new Set(['$http']),
      new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'jsonp'])
    );
    for (const call of calls) {
      const owner = [...registrations].reverse().find(registration => registration.index <= call.index);
      if (!owner) continue;
      const method = call.method.toUpperCase();
      const url = call.value;
      exitPoints.push(this.createExitPoint(
        this.generateId('exit', file, `${owner.name}_${method}_${url}_${call.index}`),
        owner.id,
        'api',
        `${method} ${url}`,
        `AngularJS HTTP request to ${url}`,
        { service_id: 'http', resource: url },
        { action: method.toLowerCase(), method },
        { framework: 'angularjs', line: call.line, endpoint_exact: call.exact }
      ));
    }
  }

  private lineAt(content: string, index: number): number {
    return content.slice(0, index).split(/\r?\n/).length;
  }

  private findMatchingParen(content: string, openIndex: number): number {
    if (openIndex < 0 || content[openIndex] !== '(') return -1;
    let depth = 0;
    let quote = '';
    let escaped = false;
    for (let index = openIndex; index < content.length; index++) {
      const character = content[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === quote) quote = '';
        continue;
      }
      if (character === '"' || character === "'" || character === '`') {
        quote = character;
        continue;
      }
      if (character === '(') depth++;
      else if (character === ')' && --depth === 0) return index;
    }
    return -1;
  }

}
