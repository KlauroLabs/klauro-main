import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint
} from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import { classifyGuardKind, isAuthenticationGuardName } from '../../core/guard-classification';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';









interface SlimRoute {
  method: string;
  path: string;
  handler: string;
  guards: string[];
  file: string;
  line: number;
  kind: 'slim' | 'codeigniter';
}


const SLIM_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'any'];

export class SlimAnalyzer extends BaseAnalyzer {
  constructor() {
    super('slim', 'Slim/CodeIgniter Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const composerJsonPath = path.join(projectPath, 'composer.json');
      let hasSlimOrCI = false;
      if (await fs.pathExists(composerJsonPath)) {
        const composerJson = await fs.readJson(composerJsonPath);
        const deps = { ...composerJson.require, ...composerJson['require-dev'] };
        hasSlimOrCI = Object.keys(deps).some(dep =>
          dep === 'slim/slim' ||
          dep.startsWith('slim/') ||
          dep === 'codeigniter4/framework' ||
          dep === 'codeigniter/framework'
        );
      }
      if (!hasSlimOrCI) return false;

      const phpFiles = await glob(['**/*.php'], {
        cwd: projectPath,
        ignore: [...this.getIgnorePatterns({ projectPath } as AnalysisContext), '**/vendor/**', '**/tests/**', '**/test/**'],
        nodir: true
      });

      for (const file of phpFiles) {
        const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
        if (this.looksLikeSlimUsage(content) || this.looksLikeCodeIgniterUsage(content)) return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  private looksLikeSlimUsage(content: string): boolean {
    const constructsApp = /AppFactory::create\(\)|new\s+\\?Slim\\App\(/.test(content);
    const hasRouteCall = new RegExp(`\\$app->(${SLIM_METHODS.join('|')})\\s*\\(`).test(content);
    return constructsApp || hasRouteCall;
  }

  private looksLikeCodeIgniterUsage(content: string): boolean {
    return new RegExp(`\\$routes->(${SLIM_METHODS.join('|')})\\s*\\(`).test(content);
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    try {
      const phpFiles = await glob(['**/*.php'], {
        cwd: context.projectPath,
        ignore: [...this.getIgnorePatterns(context), '**/vendor/**', '**/tests/**', '**/test/**'],
        nodir: true
      });

      const allRoutes: SlimRoute[] = [];
      for (const file of phpFiles) {
        const content = await fs.readFile(path.join(context.projectPath, file), 'utf-8');
        allRoutes.push(...this.extractSlimRoutes(content, file));
        allRoutes.push(...this.extractCodeIgniterRoutes(content, file));
      }

      if (allRoutes.length === 0) {
        return this.createContribution(nodes, edges, entryPoints, exitPoints, {
          framework: 'slim',
          routesFound: 0
        });
      }

      let version = 'unknown';
      try {
        const composerJson = await fs.readJson(path.join(context.projectPath, 'composer.json'));
        const deps = { ...composerJson.require, ...composerJson['require-dev'] };
        version = deps['slim/slim'] || deps['codeigniter4/framework'] || deps['codeigniter/framework'] || 'unknown';
      } catch {   }

      const appId = 'app_slim';
      const appNode = this.createNodeBuilder(appId, 'Slim/CodeIgniter Application', 'application')
        .withLevel(1, 'system')
        .withCategory('application', ['framework', 'slim', 'php'])
        .withSource({ file: allRoutes[0].file, line: 1, end_line: 1 })
        .withDescription('Slim (PSR-7) or CodeIgniter HTTP application')
        .withMetadata({ framework: 'slim', attributes: { version, routes: allRoutes.length } })
        .build();
      nodes.push(appNode);

      allRoutes.forEach((route, index) => {
        const routeId = `route_slim_${this.sanitizeId(route.method)}_${this.sanitizeId(route.path)}_${index}`;

        const routeNode = this.createNodeBuilder(routeId, `${route.method.toUpperCase()} ${route.path}`, 'route')
          .withLevel(3, 'code')
          .withCategory('route', ['http', 'endpoint'])
          .withSource({ file: route.file, line: route.line, end_line: route.line })
          .withDescription(`${route.kind === 'codeigniter' ? 'CodeIgniter' : 'Slim'} HTTP endpoint: ${route.method.toUpperCase()} ${route.path}`)
          .withMetadata({
            framework: route.kind === 'codeigniter' ? 'codeigniter' : 'slim',
            attributes: {
              method: route.method,
              path: route.path,
              handler: route.handler,
              guards: route.guards
            }
          })
          .build();
        nodes.push(routeNode);

        edges.push(this.createEdge(`${appId}_exposes_${routeId}`, appId, routeId, 'exposes'));

        const authGuards = route.guards.filter(g => isAuthenticationGuardName(g) || classifyGuardKind(g) === 'authorization');

        entryPoints.push(this.createEntryPoint(
          `entry_${routeId}`,
          routeId,
          'http',
          `${route.method.toUpperCase()} ${route.path}`,
          `${route.kind === 'codeigniter' ? 'CodeIgniter' : 'Slim'} HTTP endpoint: ${route.method.toUpperCase()} ${route.path}`,
          { method: route.method.toUpperCase(), path: route.path },
          {
            authenticated: authGuards.length > 0,
            guards: route.guards,
            authorized_roles: []
          },
          {
            method: route.method.toUpperCase(),
            path: route.path,
            handler: route.handler,
            handler_file: route.file,
            guards: route.guards,
            framework: route.kind === 'codeigniter' ? 'codeigniter' : 'slim'
          },
          { node_id: routeId, method_name: route.handler, file: route.file, line: route.line }
        ));
      });

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework: 'slim',
        version,
        routesFound: allRoutes.length
      });
    } catch (error) {
      throw new AnalyzerError(`Slim analysis failed: ${(error as Error).message}`, 'SLIM_ANALYSIS_ERROR');
    }
  }







  extractSlimRoutes(content: string, file: string): SlimRoute[] {
    const routes: SlimRoute[] = [];
    const groups = this.findGroupRanges(content);





    const headPattern = new RegExp(`\\$(\\w+)->(${SLIM_METHODS.join('|')})\\s*\\(\\s*(['"])([^'"]+)\\3\\s*,`, 'g');
    let match: RegExpExecArray | null;
    while ((match = headPattern.exec(content)) !== null) {
      const receiver = match[1];
      const method = match[2];
      const routePath = match[4];
      const line = content.slice(0, match.index).split('\n').length;







      if (receiver === 'routes') continue;
      const enclosingGroup = this.innermostGroupFor(match.index, groups, receiver);
      const isAppReceiver = receiver === 'app';
      if (!isAppReceiver && !enclosingGroup) continue;

      const openParenIndex = content.indexOf('(', match.index);
      const argsEnd = this.findBalancedParenEnd(content, openParenIndex);
      if (argsEnd === -1) continue;
      const handlerRaw = content.slice(headPattern.lastIndex, argsEnd).trim();

      const prefix = enclosingGroup ? this.resolveGroupPrefix(enclosingGroup, groups) : '';
      const fullPath = this.joinPaths(prefix, routePath);
      const handler = this.describeHandler(handlerRaw);
      const guards = this.extractMiddlewareGuards(content, argsEnd);

      routes.push({ method, path: fullPath, handler, guards, file, line, kind: 'slim' });
    }

    return routes;
  }






  private innermostGroupFor(
    index: number,
    groups: Array<{ start: number; end: number; prefix: string; receiver: string }>,
    receiver: string
  ): { start: number; end: number; prefix: string; receiver: string } | undefined {
    return groups
      .filter(g => index >= g.start && index <= g.end && g.receiver === receiver)
      .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
  }





  private findBalancedParenEnd(content: string, openParenIndex: number): number {
    let depth = 0;
    let inStr: string | null = null;
    for (let i = openParenIndex; i < content.length; i++) {
      const ch = content[i];
      if (inStr) {
        if (ch === inStr && content[i - 1] !== '\\') inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'") { inStr = ch; continue; }
      if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
      if (ch === ')' || ch === ']' || ch === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }




  private findGroupRanges(content: string): Array<{ file?: string; start: number; end: number; prefix: string; receiver: string; parentEnd?: number }> {
    const groups: Array<{ start: number; end: number; prefix: string; receiver: string }> = [];
    const groupHeadPattern = /\$(\w+)->group\s*\(\s*(['"])([^'"]+)\2\s*,\s*function\s*\(([^)]*)\)/g;
    let match: RegExpExecArray | null;
    while ((match = groupHeadPattern.exec(content)) !== null) {


      if (match[1] === 'routes') continue;
      const prefix = match[3];
      const paramsText = match[4];
      const paramMatch = paramsText.match(/\$(\w+)\s*$/) || paramsText.match(/\$(\w+)/);
      const receiver = paramMatch ? paramMatch[1] : 'group';


      const braceIdx = content.indexOf('{', groupHeadPattern.lastIndex - 1);
      if (braceIdx === -1) continue;
      const bodyEnd = this.findBalancedBraceEnd(content, braceIdx);
      if (bodyEnd === -1) continue;

      groups.push({ start: braceIdx, end: bodyEnd, prefix, receiver });
    }
    return groups;
  }



  private resolveGroupPrefix(
    group: { start: number; end: number; prefix: string },
    allGroups: Array<{ start: number; end: number; prefix: string }>
  ): string {
    const ancestors = allGroups
      .filter(g => g !== group && g.start < group.start && g.end > group.end)
      .sort((a, b) => b.start - a.start);
    const parent = ancestors[0];
    const parentPrefix = parent ? this.resolveGroupPrefix(parent, allGroups) : '';
    return this.joinPaths(parentPrefix, group.prefix);
  }

  private findBalancedBraceEnd(content: string, openBraceIndex: number): number {
    let depth = 0;
    let inStr: string | null = null;
    for (let i = openBraceIndex; i < content.length; i++) {
      const ch = content[i];
      if (inStr) {
        if (ch === inStr && content[i - 1] !== '\\') inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'") { inStr = ch; continue; }
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }



  private extractMiddlewareGuards(content: string, fromIndex: number): string[] {
    const semiIdx = content.indexOf(';', fromIndex);
    if (semiIdx === -1) return [];
    const statement = content.slice(fromIndex, semiIdx + 1);
    const guards: string[] = [];
    const addPattern = /->add\s*\(\s*(?:new\s+)?([A-Za-z_\\][\w\\]*)/g;
    let m: RegExpExecArray | null;
    while ((m = addPattern.exec(statement)) !== null) {
      guards.push(m[1].split('\\').pop()!);
    }
    return guards;
  }






  extractCodeIgniterRoutes(content: string, file: string): SlimRoute[] {
    const routes: SlimRoute[] = [];
    if (!/\$routes->/.test(content)) return routes;

    const ciGroups = this.findCodeIgniterGroupRanges(content);
    const methodPattern = new RegExp(`\\$routes->(${SLIM_METHODS.join('|')})\\s*\\(\\s*(['"])([^'"]*)\\2\\s*,\\s*(['"])([^'"]+)\\4`, 'g');
    let match: RegExpExecArray | null;
    while ((match = methodPattern.exec(content)) !== null) {
      const method = match[1];
      const routePath = match[3];
      const handler = match[5].replace(/^\\+/, '').split('\\').pop()!;
      const line = content.slice(0, match.index).split('\n').length;

      const enclosing = ciGroups.filter(g => match!.index >= g.start && match!.index <= g.end)
        .sort((a, b) => b.start - a.start)[0];
      const prefix = enclosing ? this.resolveCodeIgniterPrefix(enclosing, ciGroups) : '';
      const fullPath = this.joinPaths(prefix, routePath);

      routes.push({ method, path: fullPath, handler, guards: [], file, line, kind: 'codeigniter' });
    }

    return routes;
  }

  private findCodeIgniterGroupRanges(content: string): Array<{ start: number; end: number; prefix: string }> {
    const groups: Array<{ start: number; end: number; prefix: string }> = [];
    const groupHeadPattern = /\$routes->group\s*\(\s*(['"])([^'"]*)\1\s*,\s*(?:\[[^\]]*\]\s*,\s*)?function\s*\([^)]*\)/g;
    let match: RegExpExecArray | null;
    while ((match = groupHeadPattern.exec(content)) !== null) {
      const prefix = match[2];
      const braceIdx = content.indexOf('{', groupHeadPattern.lastIndex - 1);
      if (braceIdx === -1) continue;
      const bodyEnd = this.findBalancedBraceEnd(content, braceIdx);
      if (bodyEnd === -1) continue;
      groups.push({ start: braceIdx, end: bodyEnd, prefix });
    }
    return groups;
  }

  private resolveCodeIgniterPrefix(
    group: { start: number; end: number; prefix: string },
    allGroups: Array<{ start: number; end: number; prefix: string }>
  ): string {
    const ancestors = allGroups
      .filter(g => g !== group && g.start < group.start && g.end > group.end)
      .sort((a, b) => b.start - a.start);
    const parent = ancestors[0];
    const parentPrefix = parent ? this.resolveCodeIgniterPrefix(parent, allGroups) : '';
    return this.joinPaths(parentPrefix, group.prefix);
  }




  private describeHandler(raw: string): string {
    const arrayMatch = raw.match(/^\[\s*([A-Za-z_\\][\w\\]*)::class\s*,\s*(['"])([^'"]+)\2\s*\]$/);
    if (arrayMatch) return `${arrayMatch[1].split('\\').pop()}::${arrayMatch[3]}`;
    const classRefMatch = raw.match(/^([A-Za-z_\\][\w\\]*)::class$/);
    if (classRefMatch) return classRefMatch[1].split('\\').pop()!;
    const stringMatch = raw.match(/^(['"])([^'"]+)\1$/);
    if (stringMatch) return stringMatch[2];
    if (/^function\s*\(|^fn\s*\(/.test(raw)) return 'inline handler';
    if (/^[A-Za-z_$][\w$]*$/.test(raw)) return raw;
    return 'inline handler';
  }

  private joinPaths(a: string, b: string): string {
    const left = (a || '').replace(/\/+$/, '');
    const right = (b || '').replace(/^\/+/, '');
    if (!left) return right ? `/${right}` : '/';
    if (!right) return left || '/';
    return `${left}/${right}`;
  }

  protected getCapabilities(): string[] {
    return ['slim-analysis', 'codeigniter-analysis', 'route-extraction', 'group-prefix-resolution', 'route-mapping'];
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
