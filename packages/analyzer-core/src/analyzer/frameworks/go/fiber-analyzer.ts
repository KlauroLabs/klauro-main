import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, CASPerspective
} from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import { classifyGuardKind, isAuthenticationGuardName } from '../../core/guard-classification';
import {
  GoRoute, describeGoHandler, isGoMiddlewareIdentifier, parseGoCallArgs,
  joinGoPaths, findGoFiles, readGoFiles, lineForIndex
} from './go-route-utils';
import * as fs from 'fs-extra';
import * as path from 'path';

const FIBER_METHODS = ['Get', 'Post', 'Put', 'Patch', 'Delete', 'Head', 'Options', 'All'];









export class FiberAnalyzer extends BaseAnalyzer {
  constructor() {
    super('fiber', 'Fiber Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      if (!(await this.goModRequiresFiber(projectPath))) return false;
      const files = await findGoFiles(projectPath);
      const contents = await readGoFiles(projectPath, files);
      for (const content of contents.values()) {
        if (this.looksLikeFiberUsage(content)) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private async goModRequiresFiber(projectPath: string): Promise<boolean> {
    const goModPath = path.join(projectPath, 'go.mod');
    if (!(await fs.pathExists(goModPath))) return false;
    const content = await fs.readFile(goModPath, 'utf-8');
    return content.includes('github.com/gofiber/fiber');
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
        if (!this.looksLikeFiberUsage(content)) continue;
        allRoutes.push(...this.extractRoutes(content, file));
      }

      if (allRoutes.length === 0) {
        return this.createContribution(nodes, edges, entryPoints, exitPoints, {
          framework: 'fiber',
          routesFound: 0
        });
      }

      const appId = 'app_fiber';
      const appNode = this.createNodeBuilder(appId, 'Fiber Application', 'application')
        .withLevel(1, 'system')
        .withCategory('application', ['framework', 'fiber'])
        .withSource({ file: files[0] || '', line: 1, end_line: 1 })
        .withDescription('Fiber HTTP application')
        .withMetadata({ framework: 'fiber', attributes: { routes: allRoutes.length } })
        .build();
      nodes.push(appNode);

      allRoutes.forEach((route, index) => {
        const routeId = `route_fiber_${this.sanitizeId(route.method)}_${this.sanitizeId(route.path)}_${index}`;

        const routeNode = this.createNodeBuilder(routeId, `${route.method.toUpperCase()} ${route.path}`, 'route')
          .withLevel(3, 'code')
          .withCategory('route', ['http', 'endpoint'])
          .withSource({ file: route.file, line: route.line, end_line: route.line })
          .withDescription(`Fiber HTTP endpoint: ${route.method.toUpperCase()} ${route.path}`)
          .withMetadata({
            framework: 'fiber',
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
          `Fiber HTTP endpoint: ${route.method.toUpperCase()} ${route.path}`,
          { method: route.method.toUpperCase(), path: route.path },
          { authenticated: authGuards.length > 0, guards: route.guards, authorized_roles: [] },
          {
            method: route.method.toUpperCase(),
            path: route.path,
            handler: route.handler,
            handler_file: route.file,
            guards: route.guards,
            framework: 'fiber'
          },
          { node_id: routeId, method_name: route.handler, file: route.file, line: route.line }
        ));
      });

      this.createPerspectives(perspectives);
      this.tagNodesWithPerspectives(nodes);

      const contribution = this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework: 'fiber',
        routesFound: allRoutes.length
      });
      contribution.perspectives = perspectives;
      contribution.provided_perspectives = perspectives.map(p => p.id);
      return contribution;
    } catch (error) {
      throw new AnalyzerError(`Fiber analysis failed: ${(error as Error).message}`, 'FIBER_ANALYSIS_ERROR');
    }
  }

  private looksLikeFiberUsage(content: string): boolean {
    const importsFiber = /"github\.com\/gofiber\/fiber\/v?\d*"/.test(content);
    const constructsInstance = /fiber\.New\s*\(/.test(content);
    const hasRouteCall = /\.(Get|Post|Put|Patch|Delete|Head|Options|All)\s*\(\s*(['"`])/.test(content);
    return importsFiber && (constructsInstance || hasRouteCall);
  }

  private extractRoutes(content: string, file: string): GoRoute[] {
    const routes: GoRoute[] = [];
    const receivers = this.findFiberReceiverNames(content);
    for (const receiver of receivers) {
      this.walkScope(content, file, receiver, '', [], routes, new Set());
    }
    return routes;
  }



  private findFiberReceiverNames(content: string): string[] {
    const names = new Set<string>(['app']);
    const instancePattern = /(?:const|var)?\s*([A-Za-z_][\w]*)\s*:?=\s*fiber\.New\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = instancePattern.exec(content)) !== null) names.add(m[1]);
    return [...names];
  }

  private walkScope(
    content: string,
    file: string,
    receiver: string,
    prefix: string,
    guards: string[],
    routes: GoRoute[],
    visitedGroupStarts: Set<number>
  ): void {
    const escaped = receiver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');


    const usePattern = new RegExp(`\\b${escaped}\\.Use\\s*\\(`, 'g');
    const groupGuards: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = usePattern.exec(content)) !== null) {
      const args = parseGoCallArgs(content, usePattern.lastIndex);
      groupGuards.push(...args.filter(a => isGoMiddlewareIdentifier(a)));
    }


    const methodAlt = FIBER_METHODS.join('|');
    const routeCallPattern = new RegExp(`\\b${escaped}\\.(${methodAlt})\\s*\\(\\s*(['"\`])([^'"\`]*)\\2`, 'g');
    while ((match = routeCallPattern.exec(content)) !== null) {
      const method = match[1];
      const routePath = joinGoPaths(prefix, match[3]);
      const line = lineForIndex(content, match.index);
      const args = parseGoCallArgs(content, routeCallPattern.lastIndex);
      const handlerArg = args[args.length - 1] || 'anonymous';
      const handler = describeGoHandler(handlerArg);
      const inlineGuards = args.slice(0, -1).filter(a => isGoMiddlewareIdentifier(a));
      routes.push({
        method: method === 'All' ? 'ANY' : method.toUpperCase(),
        path: routePath || '/',
        handler,
        guards: [...guards, ...groupGuards, ...inlineGuards],
        file,
        line
      });
    }


    const groupPattern = new RegExp(`(?:([A-Za-z_][\\w]*)\\s*:?=\\s*)?\\b${escaped}\\.Group\\s*\\(\\s*(['"\`])([^'"\`]*)\\2`, 'g');
    while ((match = groupPattern.exec(content)) !== null) {
      if (visitedGroupStarts.has(match.index)) continue;
      visitedGroupStarts.add(match.index);
      const groupVar = match[1];
      const groupPrefix = joinGoPaths(prefix, match[3]);
      const args = parseGoCallArgs(content, groupPattern.lastIndex);
      const groupCallGuards = args.slice(1).filter(a => isGoMiddlewareIdentifier(a));
      const combinedGuards = [...guards, ...groupGuards, ...groupCallGuards];

      if (groupVar) {
        this.walkScope(content, file, groupVar, groupPrefix, combinedGuards, routes, visitedGroupStarts);
      } else {
        this.extractChainedCalls(content, groupPattern.lastIndex, file, groupPrefix, combinedGuards, routes);
      }
    }
  }

  private extractChainedCalls(
    content: string,
    fromIndex: number,
    file: string,
    prefix: string,
    guards: string[],
    routes: GoRoute[]
  ): void {
    const methodAlt = FIBER_METHODS.join('|');
    const chainPattern = new RegExp(`^\\s*\\.(${methodAlt})\\s*\\(\\s*(['"\`])([^'"\`]*)\\2`, 'g');
    let cursor = fromIndex;
    while (true) {
      const remainder = content.slice(cursor, cursor + 500);
      chainPattern.lastIndex = 0;
      const m = chainPattern.exec(remainder);
      if (!m) break;
      const method = m[1];
      const routePath = joinGoPaths(prefix, m[3]);
      const absoluteIndex = cursor + m.index;
      const line = lineForIndex(content, absoluteIndex);
      const argsStart = cursor + chainPattern.lastIndex;
      const args = parseGoCallArgs(content, argsStart);
      const handlerArg = args[args.length - 1] || 'anonymous';
      const handler = describeGoHandler(handlerArg);
      const inlineGuards = args.slice(0, -1).filter(a => isGoMiddlewareIdentifier(a));
      routes.push({
        method: method === 'All' ? 'ANY' : method.toUpperCase(),
        path: routePath || '/',
        handler,
        guards: [...guards, ...inlineGuards],
        file,
        line
      });
      const parenOpen = content.indexOf('(', absoluteIndex);
      const span = parenOpen !== -1 ? this.balancedParenSpan(content, parenOpen) : null;
      cursor = span ? span[1] + 1 : cursor + m[0].length;
    }
  }

  private balancedParenSpan(content: string, openIndex: number): [number, number] | null {
    let depth = 0;
    let inStr: string | null = null;
    for (let i = openIndex; i < content.length; i++) {
      const ch = content[i];
      if (inStr) {
        if (ch === inStr && content[i - 1] !== '\\') inStr = null;
        continue;
      }
      if (ch === '"' || ch === '`' || ch === "'") { inStr = ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) return [openIndex, i]; }
    }
    return null;
  }

  private createPerspectives(perspectives: CASPerspective[]): void {
    perspectives.push({
      id: 'fiber-routes',
      name: 'Fiber API Routes',
      description: 'Fiber HTTP routes registered via app/group method calls',
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
        node.perspectives['fiber-routes'] = { hierarchy: ['fiber', 'routes'], level: node.level || 1, priority: 1 };
      }
    });
  }

  protected getCapabilities(): string[] {
    return ['fiber-analysis', 'route-extraction', 'group-prefix-resolution', 'route-mapping'];
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
