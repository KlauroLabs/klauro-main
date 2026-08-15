import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, CASPerspective
} from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import { classifyGuardKind, isAuthenticationGuardName } from '../../core/guard-classification';
import {
  GoRoute, describeGoHandler, isGoMiddlewareIdentifier, parseGoCallArgs,
  balancedSpan, joinGoPaths, findGoFiles, readGoFiles, goModRequires, lineForIndex
} from './go-route-utils';

const CHI_METHODS = ['Get', 'Post', 'Put', 'Patch', 'Delete', 'Head', 'Options', 'Connect', 'Trace', 'HandleFunc', 'Handle'];













export class ChiAnalyzer extends BaseAnalyzer {
  constructor() {
    super('chi', 'Chi Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      if (!(await goModRequires(projectPath, 'github.com/go-chi/chi'))) return false;
      const files = await findGoFiles(projectPath);
      const contents = await readGoFiles(projectPath, files);
      for (const content of contents.values()) {
        if (this.looksLikeChiUsage(content)) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const perspectives: CASPerspective[] = [];

    try {
      const files = await findGoFiles(context.projectPath);
      const fileContents = await readGoFiles(context.projectPath, files);

      const allRoutes: GoRoute[] = [];
      for (const [file, content] of fileContents) {
        if (!this.looksLikeChiUsage(content)) continue;
        allRoutes.push(...this.extractRoutes(content, file));
      }

      if (allRoutes.length === 0) {
        return this.createContribution(nodes, edges, entryPoints, exitPoints, {
          framework: 'chi',
          routesFound: 0
        });
      }

      const appId = 'app_chi';
      const appNode = this.createNodeBuilder(appId, 'Chi Application', 'application')
        .withLevel(1, 'system')
        .withCategory('application', ['framework', 'chi'])
        .withSource({ file: files[0] || '', line: 1, end_line: 1 })
        .withDescription('Chi HTTP application')
        .withMetadata({ framework: 'chi', attributes: { routes: allRoutes.length } })
        .build();
      nodes.push(appNode);

      allRoutes.forEach((route, index) => {
        const routeId = `route_chi_${this.sanitizeId(route.method)}_${this.sanitizeId(route.path)}_${index}`;

        const routeNode = this.createNodeBuilder(routeId, `${route.method.toUpperCase()} ${route.path}`, 'route')
          .withLevel(3, 'code')
          .withCategory('route', ['http', 'endpoint'])
          .withSource({ file: route.file, line: route.line, end_line: route.line })
          .withDescription(`Chi HTTP endpoint: ${route.method.toUpperCase()} ${route.path}`)
          .withMetadata({
            framework: 'chi',
            attributes: { method: route.method, path: route.path, handler: route.handler, guards: route.guards }
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
          `Chi HTTP endpoint: ${route.method.toUpperCase()} ${route.path}`,
          { method: route.method.toUpperCase(), path: route.path },
          { authenticated: authGuards.length > 0, guards: route.guards, authorized_roles: [] },
          {
            method: route.method.toUpperCase(),
            path: route.path,
            handler: route.handler,
            handler_file: route.file,
            guards: route.guards,
            framework: 'chi'
          },
          { node_id: routeId, method_name: route.handler, file: route.file, line: route.line }
        ));
      });

      this.createPerspectives(perspectives);
      this.tagNodesWithPerspectives(nodes);

      const contribution = this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework: 'chi',
        routesFound: allRoutes.length
      });
      contribution.perspectives = perspectives;
      contribution.provided_perspectives = perspectives.map(p => p.id);
      return contribution;
    } catch (error) {
      throw new AnalyzerError(`Chi analysis failed: ${(error as Error).message}`, 'CHI_ANALYSIS_ERROR');
    }
  }

  private looksLikeChiUsage(content: string): boolean {
    const importsChi = /"github\.com\/go-chi\/chi(\/v\d+)?"/.test(content);
    const constructsRouter = /chi\.NewRouter\s*\(\s*\)/.test(content);
    const hasRouteCall = /\.(Get|Post|Put|Patch|Delete|Head|Options|Connect|Trace)\s*\(\s*(['"`])/.test(content);
    return importsChi && (constructsRouter || hasRouteCall);
  }

  private extractRoutes(content: string, file: string): GoRoute[] {
    const routes: GoRoute[] = [];
    const receivers = this.findChiReceiverNames(content);
    for (const receiver of receivers) {
      this.walkScope(content, file, receiver, 0, content.length, '', [], routes);
    }
    return routes;
  }





  private findChiReceiverNames(content: string): string[] {
    const names = new Set<string>(['r', 'router']);
    const instancePattern = /(?:const|var)?\s*([A-Za-z_][\w]*)\s*:?=\s*chi\.NewRouter\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = instancePattern.exec(content)) !== null) names.add(m[1]);
    return [...names];
  }








  private walkScope(
    content: string,
    file: string,
    receiver: string,
    scopeStart: number,
    scopeEnd: number,
    prefix: string,
    guards: string[],
    routes: GoRoute[]
  ): void {
    const scope = content.slice(scopeStart, scopeEnd);
    const escaped = receiver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');





    const nestedRanges = this.findNestedScopeRanges(scope, escaped);
    const inNestedRange = (idx: number) => nestedRanges.some(([s, e]) => idx >= s && idx < e);


    const usePattern = new RegExp(`\\b${escaped}\\.Use\\s*\\(`, 'g');
    const scopeGuards: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = usePattern.exec(scope)) !== null) {
      if (inNestedRange(match.index)) continue;
      const args = parseGoCallArgs(scope, usePattern.lastIndex);
      scopeGuards.push(...args.filter(a => isGoMiddlewareIdentifier(a)));
    }
    const combinedGuards = [...guards, ...scopeGuards];



    const methodAlt = CHI_METHODS.join('|');
    const routeCallPattern = new RegExp(`\\b${escaped}\\.(${methodAlt})\\s*\\(\\s*(['"\`])([^'"\`]*)\\2`, 'g');
    while ((match = routeCallPattern.exec(scope)) !== null) {
      if (inNestedRange(match.index)) continue;
      const method = match[1];
      const routePath = joinGoPaths(prefix, match[3]);
      const absoluteIndex = scopeStart + match.index;
      const line = lineForIndex(content, absoluteIndex);
      const args = parseGoCallArgs(scope, routeCallPattern.lastIndex);
      const handlerArg = args[args.length - 1] || 'anonymous';
      const handler = describeGoHandler(handlerArg);
      const inlineGuards = args.slice(0, -1).filter(a => isGoMiddlewareIdentifier(a));
      const httpMethod = method === 'HandleFunc' || method === 'Handle' ? 'ANY' : method.toUpperCase();
      routes.push({
        method: httpMethod,
        path: routePath || '/',
        handler,
        guards: [...combinedGuards, ...inlineGuards],
        file,
        line
      });
    }


    for (const nested of this.findChiNestedCalls(scope, escaped)) {
      const absStart = scopeStart + nested.bodyStart;
      const absEnd = scopeStart + nested.bodyEnd;
      const nestedPrefix = nested.prefix !== undefined ? joinGoPaths(prefix, nested.prefix) : prefix;
      this.walkScope(content, file, nested.paramName, absStart, absEnd, nestedPrefix, combinedGuards, routes);
    }
  }



  private findNestedScopeRanges(scope: string, escaped: string): Array<[number, number]> {
    return this.findChiNestedCalls(scope, escaped).map(n => [n.bodyStart, n.bodyEnd] as [number, number]);
  }

















  private findChiNestedCalls(
    scope: string,
    escaped: string
  ): Array<{ paramName: string; prefix?: string; bodyStart: number; bodyEnd: number }> {
    interface Candidate { matchIndex: number; paramName: string; prefix?: string; bodyStart: number; bodyEnd: number }
    const candidates: Candidate[] = [];


    const routePattern = new RegExp(
      `\\b${escaped}\\.Route\\s*\\(\\s*(['"\`])([^'"\`]*)\\1\\s*,\\s*func\\s*\\(\\s*([A-Za-z_][\\w]*)`,
      'g'
    );
    let m: RegExpExecArray | null;
    while ((m = routePattern.exec(scope)) !== null) {
      const prefix = m[2];
      const paramName = m[3];
      const braceOpen = scope.indexOf('{', routePattern.lastIndex);
      if (braceOpen === -1) continue;
      const span = balancedSpan(scope, braceOpen);
      if (!span) continue;
      candidates.push({ matchIndex: m.index, paramName, prefix, bodyStart: span[0] + 1, bodyEnd: span[1] });
    }


    const groupPattern = new RegExp(
      `\\b${escaped}\\.Group\\s*\\(\\s*func\\s*\\(\\s*([A-Za-z_][\\w]*)`,
      'g'
    );
    while ((m = groupPattern.exec(scope)) !== null) {
      const paramName = m[1];
      const braceOpen = scope.indexOf('{', groupPattern.lastIndex);
      if (braceOpen === -1) continue;
      const span = balancedSpan(scope, braceOpen);
      if (!span) continue;
      candidates.push({ matchIndex: m.index, paramName, bodyStart: span[0] + 1, bodyEnd: span[1] });
    }

    candidates.sort((a, b) => a.matchIndex - b.matchIndex);
    const results: Candidate[] = [];
    for (const c of candidates) {
      const insideAccepted = results.some(r => c.matchIndex >= r.bodyStart && c.matchIndex < r.bodyEnd);
      if (!insideAccepted) results.push(c);
    }
    return results;
  }

  private createPerspectives(perspectives: CASPerspective[]): void {
    perspectives.push({
      id: 'chi-routes',
      name: 'Chi API Routes',
      description: 'Chi HTTP routes registered via router Route/Group nesting',
      analyzer_id: this.analyzerId,
      type: 'flow',
      connection_rules: {
        visible_node_types: ['application', 'route'],
        relevant_edge_types: ['exposes'],
        node_connections: [
          { from_type: 'application', to_types: ['route'], edge_type: 'exposes' }
        ]
      },
      layout_hints: { style: 'hierarchical', direction: 'TB', group_by: 'http_method' },
      metadata: { show_http_methods: true }
    });
  }

  private tagNodesWithPerspectives(nodes: CASNode[]): void {
    nodes.forEach(node => {
      if (!node || typeof node !== 'object') return;
      if (!node.perspectives) node.perspectives = {};
      if (node.type === 'application' || node.type === 'route') {
        node.perspectives['chi-routes'] = { hierarchy: ['chi', 'routes'], level: node.level || 1, priority: 1 };
      }
    });
  }

  protected getCapabilities(): string[] {
    return ['chi-analysis', 'route-extraction', 'nested-scope-prefix-resolution', 'route-mapping'];
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
