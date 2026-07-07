import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, CASPerspective
} from "../../../types/cas.types";
import { AnalyzerError } from '../../core/errors';
import { classifyGuardKind, isAuthenticationGuardName } from '../../core/guard-classification';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';

/**
 * A single `fastify.<method>('/path', ...)` (or `.route({...})`) call found in a file.
 */
interface FastifyRoute {
  method: string;
  path: string;
  handler: string;
  guards: string[];
  file: string;
  line: number;
}

/**
 * A `fastify.register(pluginRef, { prefix })` call found in a file — an edge in the
 * plugin-encapsulation graph. `pluginRef` is the local identifier being registered;
 * it's resolved to the file that exports/defines it via `importsByFile`.
 */
interface RegisterCall {
  file: string;
  pluginRef: string;
  prefix?: string;
}

/** Local name -> the module specifier it was imported from, per file. */
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
      // `fastify` itself, or any `@fastify/*` plugin — some services depend only on
      // plugins (e.g. `@fastify/cors`) while constructing the instance via a thin
      // wrapper; either is real evidence of Fastify usage.
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
      // Which local name(s) each file exports (`export const X = ...` /
      // `export function X(...)`), so register() refs resolve across files.
      const exportsByFile = this.buildExportMap(fileContents);

      const allRoutes: FastifyRoute[] = [];
      const allRegisters: RegisterCall[] = [];

      for (const [file, content] of fileContents) {
        allRoutes.push(...this.extractRoutes(content, file));
        allRegisters.push(...this.extractRegisterCalls(content, file));
      }

      if (allRoutes.length === 0) {
        // Nothing to report; still return an empty-but-valid contribution.
        return this.createContribution(nodes, edges, entryPoints, exitPoints, {
          framework: 'fastify',
          routesFound: 0
        });
      }

      // A register() call may target a plugin that's declared locally in the SAME
      // file (`const apiRoutes = async (fastify, ...) => {...}` used without ever
      // being exported) — common for a file's own top-level wrapper plugin (e.g.
      // `server.register(apiRoutes, { prefix: 'sync' })` wrapping every route this
      // file itself registers). That prefix applies to the whole file, not a
      // cross-file edge, so it's folded in as an extra base prefix per file.
      const localPluginNamesByFile = this.buildLocalDeclarationMap(fileContents);
      const selfPrefixByFile = this.extractSelfWrapperPrefixes(allRegisters, localPluginNamesByFile);

      // Resolve each register() call's plugin ref to the FILE that defines it, by
      // following imports (local name -> module specifier -> file path) and,
      // failing that, matching against exported names across all files.
      const crossFileRegisters = allRegisters.filter(r => !localPluginNamesByFile.get(r.file)?.has(r.pluginRef));
      const registerEdges = this.resolveRegisterEdges(crossFileRegisters, importsByFile, exportsByFile, context.projectPath, jsFiles);

      // Compute the resolved prefix path for every file reachable from a root
      // registration (a file that itself is never the target of any register()
      // edge, or the app's main Fastify() setup file) by walking the graph and
      // concatenating prefixes. Files unreachable from any root keep prefix ''.
      // Self-wrapper prefixes seed the BFS's starting prefix at that root file so
      // they cascade to every file the root transitively registers, not just the
      // root's own leaf routes.
      const prefixByFile = this.computeFilePrefixes(registerEdges, jsFiles, selfPrefixByFile);

      let version = 'unknown';
      try {
        const packageJson = await fs.readJson(path.join(context.projectPath, 'package.json'));
        const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
        version = deps.fastify || 'unknown';
      } catch { /* best effort */ }

      const appId = 'app_fastify';
      const appNode = this.createNodeBuilder(appId, 'Fastify Application', 'application')
        .withLevel(1, 'system')
        .withCategory('application', ['framework', 'fastify'])
        .withSource({ file: path.join(context.projectPath, jsFiles[0] || ''), line: 1, end_line: 1 })
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
          .withSource({ file: path.join(context.projectPath, route.file), line: route.line, end_line: route.line })
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

  /**
   * Extract every `fastify.<method>('/path', ...)` call in a file. Handles the
   * optional TypeScript generic (`fastify.get<{ Reply: X }>('/path', ...)`) that
   * Fastify's typed-route style always uses, plus `fastify.route({ method, url,
   * handler })`. The route object is registered on whatever local identifier
   * the plugin callback receives as its first parameter — usually `fastify`, but
   * some files destructure or rename it, so we detect the receiver name per
   * plugin-callback function rather than hardcoding "fastify".
   */
  private extractRoutes(content: string, file: string): FastifyRoute[] {
    const routes: FastifyRoute[] = [];
    const receivers = this.findFastifyReceiverNames(content);

    for (const receiver of receivers) {
      const escaped = receiver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Method form: receiver.get<...>('/path', opts?, handler) — the generic type
      // argument (if present) is consumed by a balanced-angle-bracket skip so it
      // doesn't interfere with finding the opening '(' of the call.
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

      // Object form: receiver.route({ method: 'GET', url: '/path', handler: fn }).
      const routeObjHead = new RegExp(`\\b${escaped}\\.route\\s*\\(\\s*\\{`, 'g');
      let objMatch: RegExpExecArray | null;
      while ((objMatch = routeObjHead.exec(content)) !== null) {
        const objStart = objMatch.index + objMatch[0].length - 1; // position of '{'
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

  /**
   * Find the local parameter name(s) bound to the FastifyInstance in every
   * plugin-callback / route-registration function in this file — i.e. the
   * first parameter of `(fastify, options, done) => ...` or `async (app) => ...`
   * whose body actually calls a route method. Defaults to ['fastify'] when no
   * plugin-callback signature is found (covers the top-level `const server =
   * Fastify(...)` + `server.get(...)` style).
   */
  private findFastifyReceiverNames(content: string): string[] {
    const names = new Set<string>(['fastify', 'server', 'app']);
    // `(receiver, options, done) =>` / `async (receiver, options, done) =>` — the
    // canonical FastifyPluginCallback signature.
    const pluginSigPattern = /\(\s*([A-Za-z_$][\w$]*)\s*,\s*[A-Za-z_$][\w$]*\s*,\s*(?:done|next)\s*\)\s*(?::\s*[^=]+)?=>/g;
    let m: RegExpExecArray | null;
    while ((m = pluginSigPattern.exec(content)) !== null) {
      names.add(m[1]);
    }
    // `const X = Fastify(...)` / `const X = fastify(...)` instance construction.
    const instancePattern = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*Fastify\s*\(/g;
    while ((m = instancePattern.exec(content)) !== null) {
      names.add(m[1]);
    }
    return [...names];
  }

  /** A middleware/guard reference is a bare identifier or member access — not an
   *  inline function. Mirrors ExpressAnalyzer.isMiddlewareIdentifier. */
  private isMiddlewareIdentifier(arg: string): boolean {
    if (!arg || /=>/.test(arg)) return false;
    if (/^(async\s+)?function\b/.test(arg)) return false;
    return /^[A-Za-z_$][\w$.]*(\s*\([^)]*\))?$/.test(arg);
  }

  /**
   * Given the parsed remaining call args after `('/path'`, figure out the handler
   * (always the last argument) and any guard/middleware identifiers surfaced via
   * an options object's `onRequest`/`preHandler` array, or a bare middleware arg.
   */
  private resolveHandlerAndGuards(args: string[]): { handler: string; guards: string[] } {
    if (args.length === 0) return { handler: 'anonymous', guards: [] };
    const last = args[args.length - 1].trim();
    const handler = this.describeHandler(last);

    const guards: string[] = [];
    for (const arg of args.slice(0, -1)) {
      const trimmed = arg.trim();
      // Options object form: { onRequest: [a, b], preHandler: [c], schema }.
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

  /** Best-effort human-readable handler name: bare identifier as-is; inline
   *  arrow/function marked as inline (still a real, navigable handler via file+line). */
  private describeHandler(raw: string): string {
    if (/^[A-Za-z_$][\w$.]*$/.test(raw)) return raw;
    if (/^async\s+[A-Za-z_$][\w$.]*$/.test(raw)) return raw.replace(/^async\s+/, '');
    return 'inline handler';
  }

  /**
   * Parse the arguments of a call starting just after the path string (depth 1),
   * splitting on top-level commas while respecting nested parens/brackets/braces
   * and string/template literals. Mirrors ExpressAnalyzer.parseRemainingCallArgs.
   */
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

  /** Extract the text of a balanced `{...}` object starting at `openBraceIndex`
   *  (which must point at the '{'). Returns the inner text (without outer braces),
   *  or null if unbalanced. */
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

  /**
   * Extract `X.register(pluginRef, { prefix: '...' })` / `X.register(pluginRef)`
   * calls. `X` is any of the known receiver names in this file (fastify/server/app
   * plus discovered plugin-callback params), matching findFastifyReceiverNames.
   */
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

  /** Local import name -> module specifier, per file (relative imports only —
   *  those are the ones we can resolve to another file in this project). */
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

  /** Exported local names per file: `export const X = ...` / `export function X(...)`. */
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

  /** ALL local top-level declaration names per file (`const X = ...` / `function
   *  X(...)`), exported or not — used to recognize same-file plugin wrappers that
   *  are registered without ever being imported elsewhere. */
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

  /**
   * For register() calls whose plugin ref is a same-file local declaration (see
   * buildLocalDeclarationMap), extract the prefix passed at the call site — this
   * is a same-file "wrapper" prefix that applies to every route this file itself
   * registers (e.g. `server.register(apiRoutes, { prefix: 'sync' })` where
   * `apiRoutes` is a local, non-exported plugin defined further down the file).
   */
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

  /** Resolve a relative import specifier from `fromFile` to a project-relative
   *  file path present in `allFiles`, trying common extensions and index files. */
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
        // Return in the same separator style as allFiles used originally.
        return allFiles.find(f => f.split(path.sep).join('/') === candidate);
      }
    }
    return undefined;
  }

  /**
   * Turn RegisterCall[] into resolved (fromFile -> toFile, prefix) edges by
   * following each file's import map; if the ref isn't imported (e.g. same-file
   * plugin), fall back to a best-effort scan of every file's exports for a match
   * (handles path aliases / barrel re-exports we don't otherwise resolve).
   */
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
        // Fallback: find any file that exports a name matching the plugin ref.
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

  /**
   * BFS from every file that is never a `to` target (a root — typically the
   * app's main setup file) down the register-edge graph, accumulating prefixes.
   * A file reachable via multiple paths keeps the first (shortest/root-first)
   * prefix found; cycles are guarded against via a visited set per traversal.
   */
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
    // Files that are never a register target AND never register anything else
    // still default to '' via the Map default below; only traverse from roots.
    const visited = new Set<string>();

    // A root's own self-wrapper prefix (e.g. `server.register(apiRoutes, {
    // prefix: 'sync' })` where apiRoutes is declared in the same file) seeds the
    // BFS starting prefix so it cascades to everything that root registers, not
    // just routes declared directly in the root file.
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

  /** Join two path segments with exactly one '/' between them, collapsing repeats. */
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
