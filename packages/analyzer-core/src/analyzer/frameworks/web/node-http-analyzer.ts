import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, CASPerspective
} from "../../../types/cas.types";
import { AnalyzerError } from '../../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';







interface NodeHttpRoute {
  method: string;
  path: string;
  handler: string;
  file: string;
  line: number;
}








interface NodeHttpServerCall {
  file: string;
  line: number;
  handlerName: string;
  handlerFile: string;
  handlerLine: number;
  isHttps: boolean;
}

export class NodeHttpAnalyzer extends BaseAnalyzer {
  constructor() {
    super('node-http', 'Node.js Raw HTTP Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const jsFiles = await glob(['**/*.{js,ts,mjs,cjs}'], {
        cwd: projectPath,
        ignore: [
          ...this.getIgnorePatterns({ projectPath } as AnalysisContext),
          '**/*.test.*',
          '**/*.spec.*',
          '**/__tests__/**'
        ],
        nodir: true
      });

      for (const file of jsFiles) {
        const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
        if (this.looksLikeRawHttpServer(content)) return true;
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
      const jsFiles = await glob(['**/*.{js,ts,mjs,cjs}'], {
        cwd: context.projectPath,
        ignore: [...this.getIgnorePatterns(context), '**/*.test.*', '**/*.spec.*'],
        nodir: true
      });

      const fileContents = new Map<string, string>();
      for (const file of jsFiles) {
        fileContents.set(file, await fs.readFile(path.join(context.projectPath, file), 'utf-8'));
      }

      const serverCalls: NodeHttpServerCall[] = [];
      for (const [file, content] of fileContents) {



        if (!this.looksLikeRawHttpServer(content)) continue;
        serverCalls.push(...this.extractServerCalls(content, file));
      }

      if (serverCalls.length === 0) {
        return this.createContribution(nodes, edges, entryPoints, exitPoints, {
          framework: 'node-http',
          serversFound: 0,
          routesFound: 0
        });
      }

      let totalRoutes = 0;
      let totalFallbackEntries = 0;

      serverCalls.forEach((server, serverIndex) => {
        const appId = `app_node_http_${serverIndex}`;
        const appNode = this.createNodeBuilder(appId, 'Node.js HTTP Server', 'application')
          .withLevel(1, 'system')
          .withCategory('application', ['framework', 'node-http'])
          .withSource({ file: server.file, line: server.line, end_line: server.line })
          .withDescription(`Raw Node.js ${server.isHttps ? 'https' : 'http'}.createServer application`)
          .withMetadata({ framework: 'node-http', attributes: { protocol: server.isHttps ? 'https' : 'http' } })
          .build();
        nodes.push(appNode);








        const handlerContent = fileContents.get(server.handlerFile);
        const routes = handlerContent
          ? this.extractRoutesFromHandlerBody(handlerContent, server.handlerFile, server.handlerLine)
          : [];

        if (routes.length > 0) {
          routes.forEach((route, routeIndex) => {
            const routeId = `route_node_http_${this.sanitizeId(route.method)}_${this.sanitizeId(route.path)}_${serverIndex}_${routeIndex}`;

            const routeNode = this.createNodeBuilder(routeId, `${route.method.toUpperCase()} ${route.path}`, 'route')
              .withLevel(3, 'code')
              .withCategory('route', ['http', 'endpoint'])
              .withSource({ file: route.file, line: route.line, end_line: route.line })
              .withDescription(`Node.js raw HTTP endpoint: ${route.method.toUpperCase()} ${route.path}`)
              .withMetadata({
                framework: 'node-http',
                attributes: {
                  method: route.method,
                  path: route.path,
                  handler: route.handler
                }
              })
              .build();
            nodes.push(routeNode);

            edges.push(this.createEdge(`${appId}_exposes_${routeId}`, appId, routeId, 'exposes'));

            entryPoints.push({
              id: `entry_${routeId}`,
              name: `${route.method.toUpperCase()} ${route.path}`,
              type: 'http',
              source_node: routeId,
              trigger: {
                method: route.method.toUpperCase(),
                path: route.path
              },
              handler: {
                node_id: routeId,
                method_name: route.handler,
                file: route.file,
                line: route.line
              },
              security: {
                authenticated: false,
                guards: [],
                authorized_roles: []
              },
              metadata: {
                method: route.method.toUpperCase(),
                path: route.path,
                handler: route.handler,
                handler_file: route.file,
                framework: 'node-http',
                resolution: 'static'
              }
            } as CASEntryPoint);
          });
          totalRoutes += routes.length;
        } else {



          const entryId = `entry_node_http_handler_${serverIndex}`;
          entryPoints.push({
            id: entryId,
            name: `${server.isHttps ? 'HTTPS' : 'HTTP'} request handler (dynamic dispatch)`,
            type: 'http',
            source_node: appId,
            trigger: {
              method: undefined,
              path: undefined
            },
            handler: {
              node_id: appId,
              method_name: server.handlerName,
              file: server.handlerFile,
              line: server.handlerLine
            },
            security: {
              authenticated: false,
              guards: [],
              authorized_roles: []
            },
            metadata: {
              handler: server.handlerName,
              handler_file: server.handlerFile,
              framework: 'node-http',
              resolution: 'dynamic-fallback'
            }
          } as CASEntryPoint);
          totalFallbackEntries += 1;
        }
      });

      this.createPerspectives(perspectives);
      this.tagNodesWithPerspectives(nodes);

      const contribution = this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework: 'node-http',
        serversFound: serverCalls.length,
        routesFound: totalRoutes,
        fallbackEntryPointsFound: totalFallbackEntries
      });

      contribution.perspectives = perspectives;
      contribution.provided_perspectives = perspectives.map(p => p.id);

      return contribution;
    } catch (error) {
      throw new AnalyzerError(`Node HTTP analysis failed: ${(error as Error).message}`, 'NODE_HTTP_ANALYSIS_ERROR');
    }
  }



  private looksLikeRawHttpServer(content: string): boolean {
    const importsHttp =
      /from\s+['"](?:node:)?https?['"]/.test(content) ||
      /require\(\s*['"](?:node:)?https?['"]\s*\)/.test(content);
    const constructsServer = /\b(?:http|https)\.createServer\s*\(|(?<![.\w])createServer\s*\(/.test(content);
    return importsHttp && constructsServer;
  }














  private extractServerCalls(content: string, file: string): NodeHttpServerCall[] {
    const calls: NodeHttpServerCall[] = [];
    const pattern = /\b(https?)\.createServer\s*\(|(?<![.\w])createServer\s*\(/g;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(content)) !== null) {
      const isHttps = match[1] === 'https';
      const line = content.slice(0, match.index).split('\n').length;
      const args = this.parseRemainingCallArgs(content, pattern.lastIndex);
      if (args.length === 0) continue;



      const handlerArg = args[args.length - 1].trim();

      if (/^(async\s*)?\(/.test(handlerArg) || /^async\s+function\b/.test(handlerArg) || /^function\b/.test(handlerArg)) {

        calls.push({
          file,
          line,
          handlerName: 'inline handler',
          handlerFile: file,
          handlerLine: line,
          isHttps
        });
        continue;
      }

      const identMatch = /^([A-Za-z_$][\w$]*)$/.exec(handlerArg);
      if (identMatch) {
        const name = identMatch[1];
        const decl = this.findFunctionDeclarationLine(content, name);
        calls.push({
          file,
          line,
          handlerName: name,
          handlerFile: file,
          handlerLine: decl ?? line,
          isHttps
        });
        continue;
      }




      calls.push({
        file,
        line,
        handlerName: this.describeHandler(handlerArg),
        handlerFile: file,
        handlerLine: line,
        isHttps
      });
    }

    return calls;
  }



  private findFunctionDeclarationLine(content: string, name: string): number | undefined {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\s*=\\s*(?:async\\s*)?\\(`),
      new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${escaped}\\s*\\(`)
    ];
    for (const re of patterns) {
      const m = re.exec(content);
      if (m) return content.slice(0, m.index).split('\n').length;
    }
    return undefined;
  }


















  private extractRoutesFromHandlerBody(content: string, file: string, _handlerBodyStartLine: number): NodeHttpRoute[] {
    const routes: NodeHttpRoute[] = [];
    const seen = new Set<string>();
    const pushRoute = (method: string, routePath: string, handler: string, line: number) => {
      const key = `${method.toUpperCase()} ${routePath}`;
      if (seen.has(key)) return;
      seen.add(key);
      routes.push({ method: method.toLowerCase(), path: routePath, handler, file, line });
    };








    const ifPattern = /if\s*\(([^)]*?(?:method|url|pathname)[^)]*?)\)\s*\{/g;
    let ifMatch: RegExpExecArray | null;
    while ((ifMatch = ifPattern.exec(content)) !== null) {
      const cond = ifMatch[1];
      const methodMatch = /(?:[\w$]+\.)?method\s*===?\s*(['"\`])([A-Za-z]+)\1/.exec(cond);
      if (!methodMatch) continue;
      const method = methodMatch[2];

      const pathMatches = [...cond.matchAll(/(?:[\w$]+\.)?(?:url|pathname)\s*===?\s*(['"\`])([^'"\`]+)\1/g)];
      if (pathMatches.length === 0) continue;

      const line = content.slice(0, ifMatch.index).split('\n').length;
      const braceStart = ifMatch.index + ifMatch[0].length - 1;
      const body = this.extractBalancedBraces(content, braceStart) || '';
      const handler = this.describeIfBodyHandler(body, ifMatch[0], content, ifMatch.index);

      for (const pm of pathMatches) {
        pushRoute(method, pm[2], handler, line);
      }
    }








    const switchPattern = /switch\s*\(\s*(?:[\w.]*\.)?(?:url|pathname)\s*\)\s*\{/g;
    let switchMatch: RegExpExecArray | null;
    while ((switchMatch = switchPattern.exec(content)) !== null) {
      const braceStart = switchMatch.index + switchMatch[0].length - 1;
      const body = this.extractBalancedBraces(content, braceStart);
      if (!body) continue;

      const casePattern = /case\s+(['"\`])([^'"\`]+)\1\s*:/g;
      let caseMatch: RegExpExecArray | null;
      while ((caseMatch = casePattern.exec(body)) !== null) {
        const line = content.slice(0, switchMatch.index + caseMatch.index).split('\n').length;
        pushRoute('GET', caseMatch[2], 'switch case handler', line);
      }
    }

    return routes;
  }




  private describeIfBodyHandler(body: string, _matchedHeader: string, _content: string, _matchIndex: number): string {
    const callMatch = /\b([A-Za-z_$][\w$]*)\s*\(\s*(?:request|req)\s*,\s*(?:response|res)\s*\)/.exec(body);
    if (callMatch) return callMatch[1];
    const awaitCallMatch = /\bawait\s+([A-Za-z_$][\w$.]*)\s*\(/.exec(body);
    if (awaitCallMatch) return awaitCallMatch[1];
    return 'inline handler';
  }



  private describeHandler(raw: string): string {
    if (/^[A-Za-z_$][\w$.]*$/.test(raw)) return raw;
    return 'handler';
  }






  private parseRemainingCallArgs(content: string, pos: number): string[] {
    const args: string[] = [];
    let depth = 1;
    let cur = '';
    let inStr: string | null = null;
    for (let i = pos; i < content.length; i++) {
      const ch = content[i];
      if (inStr) {
        cur += ch;
        if (ch === inStr && content[i - 1] !== '\\') inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; cur += ch; continue; }
      if (ch === '(' || ch === '[' || ch === '{') { depth++; cur += ch; continue; }
      if (ch === ')' || ch === ']' || ch === '}') {
        depth--;
        if (depth === 0) { if (cur.trim()) args.push(cur.trim()); break; }
        cur += ch;
        continue;
      }
      if (ch === ',' && depth === 1) { if (cur.trim()) args.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    return args;
  }




  private extractBalancedBraces(content: string, openBraceIndex: number): string | null {
    let depth = 0;
    let inStr: string | null = null;
    for (let i = openBraceIndex; i < content.length; i++) {
      const ch = content[i];
      if (inStr) {
        if (ch === inStr && content[i - 1] !== '\\') inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) return content.slice(openBraceIndex + 1, i);
      }
    }
    return null;
  }

  private createPerspectives(perspectives: CASPerspective[]): void {
    perspectives.push({
      id: 'node-http-routes',
      name: 'Node.js Raw HTTP Routes',
      description: 'Routes and entry points dispatched by a raw http.createServer handler',
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
        node.perspectives['node-http-routes'] = { hierarchy: ['node-http', 'routes'], level: node.level || 1, priority: 1 };
      }
    });
  }

  protected getCapabilities(): string[] {
    return ['node-http-analysis', 'route-extraction', 'dispatch-detection'];
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
