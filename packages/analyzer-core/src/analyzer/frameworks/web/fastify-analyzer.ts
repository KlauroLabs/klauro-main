import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, CASPerspective
} from "../../../types/cas.types";
import { AnalyzerError } from '../../core/errors';
import { classifyGuardKind, isAuthenticationGuardName } from '../../core/guard-classification';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';




interface FastifyRoute {
  method: string;
  path: string;
  handler: string;
  guards: string[];
  file: string;
  line: number;
}






interface RegisterCall {
  file: string;
  pluginRef: string;
  prefix?: string;
}


type ImportMap = Map<string, Map<string, string>>;

export class FastifyAnalyzer extends BaseAnalyzer {
  constructor() {
    super('fastify', 'Fastify Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const packageJsonPath = path.join(projectPath, 'package.json');
      if (!await fs.pathExists(packageJsonPath)) return false;

      const packageJson = await fs.readJson(packageJsonPath);
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };



      const hasFastify = Object.keys(deps).some(dep => dep === 'fastify' || dep.startsWith('@fastify/'));
      if (!hasFastify) return false;

      const jsFiles = await glob(['**/*.{js,ts}'], {
        cwd: projectPath,
        ignore: [
          ...this.getIgnorePatterns({ projectPath }),
          '**/*.test.*',
          '**/*.spec.*',
          '**/__tests__/**'
        ],
        nodir: true
      });

      for (const file of jsFiles) {
        const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
        if (this.looksLikeFastifyUsage(content)) return true;
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
      const jsFiles = await glob(['**/*.{js,ts}'], {
        cwd: context.projectPath,
        ignore: [...this.getIgnorePatterns(context), '**/*.test.*', '**/*.spec.*'],
        nodir: true
      });

      const fileContents = new Map<string, string>();
      for (const file of jsFiles) {
        fileContents.set(file, await fs.readFile(path.join(context.projectPath, file), 'utf-8'));
      }

      const importsByFile = this.buildImportMap(fileContents);


      const exportsByFile = this.buildExportMap(fileContents);

      const allRoutes: FastifyRoute[] = [];
      const allRegisters: RegisterCall[] = [];

      for (const [file, content] of fileContents) {
        allRoutes.push(...this.extractRoutes(content, file));
        allRegisters.push(...this.extractRegisterCalls(content, file));
      }

      if (allRoutes.length === 0) {

        return this.createContribution(nodes, edges, entryPoints, exitPoints, {
          framework: 'fastify',
          routesFound: 0
        });
      }







      const localPluginNamesByFile = this.buildLocalDeclarationMap(fileContents);
      const selfPrefixByFile = this.extractSelfWrapperPrefixes(allRegisters, localPluginNamesByFile);




      const crossFileRegisters = allRegisters.filter(r => !localPluginNamesByFile.get(r.file)?.has(r.pluginRef));
      const registerEdges = this.resolveRegisterEdges(crossFileRegisters, importsByFile, exportsByFile, context.projectPath, jsFiles);








      const prefixByFile = this.computeFilePrefixes(registerEdges, jsFiles, selfPrefixByFile);

      let version = 'unknown';
      try {
        const packageJson = await fs.readJson(path.join(context.projectPath, 'package.json'));
        const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
        version = deps.fastify || 'unknown';
      } catch {   }

      const appId = 'app_fastify';
      const appNode = this.createNodeBuilder(appId, 'Fastify Application', 'application')
        .withLevel(1, 'system')
        .withCategory('application', ['framework', 'fastify'])
        .withSource({ file: jsFiles[0] || '', line: 1, end_line: 1 })
        .withDescription('Fastify HTTP application')
        .withMetadata({ framework: 'fastify', attributes: { version, routes: allRoutes.length } })
        .build();
      nodes.push(appNode);

      allRoutes.forEach((route, index) => {
        const prefix = prefixByFile.get(route.file) || '';
        const fullPath = this.joinPaths(prefix, route.path);
        const routeId = `route_fastify_${this.sanitizeId(route.method)}_${this.sanitizeId(fullPath)}_${index}`;

        const routeNode = this.createNodeBuilder(routeId, `${route.method.toUpperCase()} ${fullPath}`, 'route')
          .withLevel(3, 'code')
          .withCategory('route', ['http', 'endpoint'])
          .withSource({ file: route.file, line: route.line, end_line: route.line })
          .withDescription(`Fastify HTTP endpoint: ${route.method.toUpperCase()} ${fullPath}`)
          .withMetadata({
            framework: 'fastify',
            attributes: {
              method: route.method,
              path: fullPath,
              handler: route.handler,
              guards: route.guards
            }
          })
          .build();
        nodes.push(routeNode);

        edges.push(this.createEdge(`${appId}_exposes_${routeId}`, appId, routeId, 'exposes'));

        const authGuards = route.guards.filter(g => isAuthenticationGuardName(g) || classifyGuardKind(g) === 'authorization');

        entryPoints.push({
          id: `entry_${routeId}`,
          name: `${route.method.toUpperCase()} ${fullPath}`,
          type: 'http',
          source_node: routeId,
          trigger: {
            method: route.method.toUpperCase(),
            path: fullPath
          },
          handler: {
            node_id: routeId,
            method_name: route.handler,
            file: route.file,
            line: route.line
          },
          security: {
            authenticated: authGuards.length > 0,
            guards: route.guards,
            authorized_roles: []
          },
          metadata: {
            method: route.method.toUpperCase(),
            path: fullPath,
            handler: route.handler,
            handler_file: route.file,
            guards: route.guards,
            framework: 'fastify'
          }
        } as CASEntryPoint);
      });

      this.createPerspectives(perspectives);
      this.tagNodesWithPerspectives(nodes);

      const contribution = this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework: 'fastify',
        version,
        routesFound: allRoutes.length
      });

      contribution.perspectives = perspectives;
      contribution.provided_perspectives = perspectives.map(p => p.id);

      return contribution;
    } catch (error) {
      throw new AnalyzerError(`Fastify analysis failed: ${(error as Error).message}`, 'FASTIFY_ANALYSIS_ERROR');
    }
  }

  private looksLikeFastifyUsage(content: string): boolean {
    const importsFastify =
      /from\s+['"]fastify['"]/.test(content) ||
      /require\(\s*['"]fastify['"]\s*\)/.test(content);
    const constructsInstance = /\bFastify\s*\(|\bfastify\s*\(\s*\)/.test(content);
    const hasRouteCall = /\bfastify\.(get|post|put|patch|delete|head|options|route)\s*[(<]/.test(content) ||
      /\.(get|post|put|patch|delete|head|options|route)\s*[(<].*FastifyPluginCallback/.test(content);
    const isPlugin = /FastifyPluginCallback|FastifyPluginAsync/.test(content) && /\.(get|post|put|patch|delete|head|options|route)\s*[(<]/.test(content);
    return importsFastify && (constructsInstance || hasRouteCall || isPlugin);
  }










  private extractRoutes(content: string, file: string): FastifyRoute[] {
    const routes: FastifyRoute[] = [];
    const receivers = this.findFastifyReceiverNames(content);

    for (const receiver of receivers) {
      const escaped = receiver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');



      const head = new RegExp(`\\b${escaped}\\.(get|post|put|patch|delete|head|options)\\s*(<[^(]*>)?\\s*\\(\\s*(['"\`])([^'"\`]+)\\3`, 'g');
      let match: RegExpExecArray | null;
      while ((match = head.exec(content)) !== null) {
        const method = match[1];
        const routePath = match[4];
        const line = content.slice(0, match.index).split('\n').length;
        const args = this.parseRemainingCallArgs(content, head.lastIndex);
        const { handler, guards } = this.resolveHandlerAndGuards(args);
        routes.push({ method, path: routePath, handler, guards, file, line });
      }


      const routeObjHead = new RegExp(`\\b${escaped}\\.route\\s*\\(\\s*\\{`, 'g');
      let objMatch: RegExpExecArray | null;
      while ((objMatch = routeObjHead.exec(content)) !== null) {
        const objStart = objMatch.index + objMatch[0].length - 1;
        const objText = this.extractBalancedBraces(content, objStart);
        if (!objText) continue;
        const methodMatch = /method\s*:\s*(['"\`])([^'"\`]+)\1/.exec(objText);
        const urlMatch = /url\s*:\s*(['"\`])([^'"\`]+)\1/.exec(objText);
        const handlerMatch = /handler\s*:\s*([A-Za-z_$][\w$.]*)/.exec(objText);
        const onRequestMatch = /onRequest\s*:\s*\[([^\]]*)\]/.exec(objText);
        if (!methodMatch || !urlMatch) continue;
        const line = content.slice(0, objMatch.index).split('\n').length;
        const guards = onRequestMatch
          ? onRequestMatch[1].split(',').map(g => g.trim()).filter(g => this.isMiddlewareIdentifier(g))
          : [];
        routes.push({
          method: methodMatch[2].toLowerCase(),
          path: urlMatch[2],
          handler: handlerMatch ? handlerMatch[1] : 'anonymous',
          guards,
          file,
          line
        });
      }
    }

    return routes;
  }









  private findFastifyReceiverNames(content: string): string[] {
    const names = new Set<string>(['fastify', 'server', 'app']);


    const pluginSigPattern = /\(\s*([A-Za-z_$][\w$]*)\s*,\s*[A-Za-z_$][\w$]*\s*,\s*(?:done|next)\s*\)\s*(?::\s*[^=]+)?=>/g;
    let m: RegExpExecArray | null;
    while ((m = pluginSigPattern.exec(content)) !== null) {
      names.add(m[1]);
    }

    const instancePattern = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*Fastify\s*\(/g;
    while ((m = instancePattern.exec(content)) !== null) {
      names.add(m[1]);
    }
    return [...names];
  }



  private isMiddlewareIdentifier(arg: string): boolean {
    if (!arg || /=>/.test(arg)) return false;
    if (/^(async\s+)?function\b/.test(arg)) return false;
    return /^[A-Za-z_$][\w$.]*(\s*\([^)]*\))?$/.test(arg);
  }






  private resolveHandlerAndGuards(args: string[]): { handler: string; guards: string[] } {
    if (args.length === 0) return { handler: 'anonymous', guards: [] };
    const last = args[args.length - 1].trim();
    const handler = this.describeHandler(last);

    const guards: string[] = [];
    for (const arg of args.slice(0, -1)) {
      const trimmed = arg.trim();

      const onRequestMatch = /onRequest\s*:\s*\[([^\]]*)\]/.exec(trimmed);
      const preHandlerMatch = /preHandler\s*:\s*\[([^\]]*)\]/.exec(trimmed);
      if (onRequestMatch) {
        guards.push(...onRequestMatch[1].split(',').map(g => g.trim()).filter(g => this.isMiddlewareIdentifier(g)));
      }
      if (preHandlerMatch) {
        guards.push(...preHandlerMatch[1].split(',').map(g => g.trim()).filter(g => this.isMiddlewareIdentifier(g)));
      }
      if (!onRequestMatch && !preHandlerMatch && this.isMiddlewareIdentifier(trimmed)) {
        guards.push(trimmed);
      }
    }
    return { handler, guards };
  }



  private describeHandler(raw: string): string {
    if (/^[A-Za-z_$][\w$.]*$/.test(raw)) return raw;
    if (/^async\s+[A-Za-z_$][\w$.]*$/.test(raw)) return raw.replace(/^async\s+/, '');
    return 'inline handler';
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






  private extractRegisterCalls(content: string, file: string): RegisterCall[] {
    const calls: RegisterCall[] = [];
    const receivers = this.findFastifyReceiverNames(content);
    for (const receiver of receivers) {
      const escaped = receiver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`\\b${escaped}\\.register\\s*\\(\\s*([A-Za-z_$][\\w$]*)\\s*(?:,\\s*\\{([^}]*)\\})?\\s*\\)`, 'g');
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(content)) !== null) {
        const pluginRef = m[1];
        const optsText = m[2] || '';
        const prefixMatch = /prefix\s*:\s*(['"\`])([^'"\`]+)\1/.exec(optsText);
        calls.push({ file, pluginRef, prefix: prefixMatch ? prefixMatch[2] : undefined });
      }
    }
    return calls;
  }



  private buildImportMap(fileContents: Map<string, string>): ImportMap {
    const result: ImportMap = new Map();
    for (const [file, content] of fileContents) {
      const map = new Map<string, string>();
      const importPattern = /import\s+(?:\{([^}]+)\}|([A-Za-z_$][\w$]*))\s+from\s+['"](\.[^'"]+)['"]/g;
      let m: RegExpExecArray | null;
      while ((m = importPattern.exec(content)) !== null) {
        const specifier = m[3];
        if (m[1]) {
          for (const raw of m[1].split(',')) {
            const name = raw.trim().split(/\s+as\s+/).pop()?.trim();
            if (name) map.set(name, specifier);
          }
        } else if (m[2]) {
          map.set(m[2], specifier);
        }
      }
      result.set(file, map);
    }
    return result;
  }


  private buildExportMap(fileContents: Map<string, string>): Map<string, Set<string>> {
    const result = new Map<string, Set<string>>();
    for (const [file, content] of fileContents) {
      const names = new Set<string>();
      const constPattern = /export\s+const\s+([A-Za-z_$][\w$]*)/g;
      let m: RegExpExecArray | null;
      while ((m = constPattern.exec(content)) !== null) names.add(m[1]);
      const fnPattern = /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g;
      while ((m = fnPattern.exec(content)) !== null) names.add(m[1]);
      result.set(file, names);
    }
    return result;
  }




  private buildLocalDeclarationMap(fileContents: Map<string, string>): Map<string, Set<string>> {
    const result = new Map<string, Set<string>>();
    for (const [file, content] of fileContents) {
      const names = new Set<string>();
      const constPattern = /(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)/g;
      let m: RegExpExecArray | null;
      while ((m = constPattern.exec(content)) !== null) names.add(m[1]);
      const fnPattern = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g;
      while ((m = fnPattern.exec(content)) !== null) names.add(m[1]);
      result.set(file, names);
    }
    return result;
  }








  private extractSelfWrapperPrefixes(
    registers: RegisterCall[],
    localDeclsByFile: Map<string, Set<string>>
  ): Map<string, string> {
    const result = new Map<string, string>();
    for (const reg of registers) {
      if (!reg.prefix) continue;
      if (localDeclsByFile.get(reg.file)?.has(reg.pluginRef)) {
        const existing = result.get(reg.file);
        result.set(reg.file, existing ? this.joinPaths(existing, `/${reg.prefix}`) : `/${reg.prefix}`);
      }
    }
    return result;
  }



  private resolveSpecifierToFile(fromFile: string, specifier: string, allFiles: string[]): string | undefined {
    const baseDir = path.posix.dirname(fromFile.split(path.sep).join('/'));
    const resolved = path.posix.normalize(path.posix.join(baseDir, specifier));
    const candidates = [
      resolved,
      `${resolved}.ts`,
      `${resolved}.js`,
      `${resolved}/index.ts`,
      `${resolved}/index.js`
    ];
    const normalizedFiles = new Set(allFiles.map(f => f.split(path.sep).join('/')));
    for (const candidate of candidates) {
      if (normalizedFiles.has(candidate)) {

        return allFiles.find(f => f.split(path.sep).join('/') === candidate);
      }
    }
    return undefined;
  }







  private resolveRegisterEdges(
    registers: RegisterCall[],
    importsByFile: ImportMap,
    exportsByFile: Map<string, Set<string>>,
    _projectPath: string,
    allFiles: string[]
  ): Array<{ from: string; to: string; prefix?: string }> {
    const edges: Array<{ from: string; to: string; prefix?: string }> = [];
    for (const reg of registers) {
      const imports = importsByFile.get(reg.file);
      const specifier = imports?.get(reg.pluginRef);
      let targetFile: string | undefined;
      if (specifier) {
        targetFile = this.resolveSpecifierToFile(reg.file, specifier, allFiles);
      }
      if (!targetFile) {

        for (const [file, names] of exportsByFile) {
          if (names.has(reg.pluginRef)) { targetFile = file; break; }
        }
      }
      if (targetFile && targetFile !== reg.file) {
        edges.push({ from: reg.file, to: targetFile, prefix: reg.prefix });
      }
    }
    return edges;
  }







  private computeFilePrefixes(
    edges: Array<{ from: string; to: string; prefix?: string }>,
    allFiles: string[],
    selfPrefixByFile: Map<string, string> = new Map()
  ): Map<string, string> {
    const prefixByFile = new Map<string, string>();
    const outgoing = new Map<string, Array<{ to: string; prefix?: string }>>();
    const targets = new Set<string>();
    for (const e of edges) {
      if (!outgoing.has(e.from)) outgoing.set(e.from, []);
      outgoing.get(e.from)!.push({ to: e.to, prefix: e.prefix });
      targets.add(e.to);
    }

    const roots = allFiles.filter(f => outgoing.has(f) && !targets.has(f));


    const visited = new Set<string>();





    const queue: Array<{ file: string; prefix: string }> = roots.map(f => ({ file: f, prefix: selfPrefixByFile.get(f) || '' }));
    for (const root of roots) {
      if (!prefixByFile.has(root)) prefixByFile.set(root, selfPrefixByFile.get(root) || '');
    }

    while (queue.length > 0) {
      const { file, prefix } = queue.shift()!;
      const key = `${file}:${prefix}`;
      if (visited.has(key)) continue;
      visited.add(key);

      for (const edge of outgoing.get(file) || []) {
        const childPrefix = this.joinPaths(prefix, edge.prefix ? `/${edge.prefix}` : '');
        if (!prefixByFile.has(edge.to)) {
          prefixByFile.set(edge.to, childPrefix);
        }
        queue.push({ file: edge.to, prefix: childPrefix });
      }
    }

    return prefixByFile;
  }


  private joinPaths(a: string, b: string): string {
    const left = (a || '').replace(/\/+$/, '');
    const right = (b || '').replace(/^\/+/, '');
    if (!left) return right ? `/${right}` : '/';
    if (!right) return left;
    return `${left}/${right}`;
  }

  private createPerspectives(perspectives: CASPerspective[]): void {
    perspectives.push({
      id: 'fastify-routes',
      name: 'Fastify API Routes',
      description: 'Fastify HTTP routes registered via plugin encapsulation',
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
        node.perspectives['fastify-routes'] = { hierarchy: ['fastify', 'routes'], level: node.level || 1, priority: 1 };
      }
    });
  }

  protected getCapabilities(): string[] {
    return ['fastify-analysis', 'route-extraction', 'plugin-prefix-resolution', 'route-mapping'];
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
