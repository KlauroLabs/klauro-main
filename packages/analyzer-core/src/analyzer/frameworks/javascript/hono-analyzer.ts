import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint,
} from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import { classifyGuardKind, isAuthenticationGuardName } from '../../core/guard-classification';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'options', 'all'];


const BUILTIN_MIDDLEWARE = new Set([
  'cors', 'logger', 'jwt', 'basicAuth', 'bearerAuth', 'secureHeaders', 'csrf',
  'etag', 'compress', 'cache', 'timing', 'prettyJSON', 'requestId', 'trimTrailingSlash',
  'ipRestriction', 'bodyLimit', 'timeout',
]);


const AUTH_MIDDLEWARE = new Set(['jwt', 'basicAuth', 'bearerAuth']);


const RUNTIME_ADAPTERS: Array<{ match: RegExp; runtime: string }> = [
  { match: /hono\/cloudflare-workers/, runtime: 'cloudflare-workers' },
  { match: /hono\/cloudflare-pages/, runtime: 'cloudflare-pages' },
  { match: /hono\/bun/, runtime: 'bun' },
  { match: /hono\/deno/, runtime: 'deno' },
  { match: /@hono\/node-server/, runtime: 'node' },
  { match: /hono\/vercel/, runtime: 'vercel' },
  { match: /hono\/lambda-edge/, runtime: 'lambda-edge' },
  { match: /hono\/aws-lambda/, runtime: 'aws-lambda' },
  { match: /hono\/netlify/, runtime: 'netlify' },
];

interface HonoApp {
  name: string;
  variable: string;
  filePath: string;
}

interface HonoRoute {
  method: string;
  routePath: string;
  filePath: string;
  appVariable: string;
  handler?: string;
  middleware: string[];
  validated: boolean;
  line: number;
}

interface HonoMiddleware {
  name: string;
  appVariable: string;
  routePath: string;
  global: boolean;
  builtin: boolean;
  auth: boolean;
  filePath: string;
  line: number;
}

interface HonoMount {
  prefix: string;
  subApp: string;
  appVariable: string;
  filePath: string;
  line: number;
}

export class HonoAnalyzer extends BaseAnalyzer {
  constructor() {
    super(
      'hono',
      'Hono Framework Analyzer',
      '1.0.0',
      'framework'
    );
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const packageJsonPath = path.join(projectPath, 'package.json');
      if (await fs.pathExists(packageJsonPath)) {
        const packageJson = await fs.readJson(packageJsonPath);
        const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
        if (Object.keys(deps).some(dep => dep === 'hono')) {
          return true;
        }
      }


      const jsFiles = await glob(['**/*.{js,ts,mjs,cjs}'], {
        cwd: projectPath,
        ignore: [
          ...this.getIgnorePatterns({ projectPath }),
          '**/*.test.*',
          '**/*.spec.*',
          '**/__tests__/**',
        ],
        nodir: true,
      });

      for (const file of jsFiles) {
        const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
        if (/\bfrom\s+['"]hono['"]/.test(content) ||
            /\brequire\(\s*['"]hono['"]\s*\)/.test(content)) {
          return true;
        }
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

    try {
      const jsFiles = await glob(['**/*.{js,ts,mjs,cjs}'], {
        cwd: context.projectPath,
        ignore: [...this.getIgnorePatterns(context), '**/*.test.*', '**/*.spec.*'],
        nodir: true,
      });

      const apps: HonoApp[] = [];
      const routes: HonoRoute[] = [];
      const middleware: HonoMiddleware[] = [];
      const mounts: HonoMount[] = [];
      const runtimes = new Set<string>();

      for (const file of jsFiles) {
        const fullPath = path.join(context.projectPath, file);
        const content = await fs.readFile(fullPath, 'utf-8');

        if (!this.looksLikeHonoFile(content)) continue;

        this.detectRuntimes(content, runtimes);
        const fileApps = this.extractApps(content, file);
        apps.push(...fileApps);

        const appVars = new Set(fileApps.map(a => a.variable));
        this.extractRoutes(content, file, appVars, routes);
        this.extractMiddleware(content, file, appVars, middleware);
        this.extractMounts(content, file, appVars, mounts);
      }



      const prefixBySubApp = new Map<string, string>();
      for (const mount of mounts) {
        prefixBySubApp.set(mount.subApp, mount.prefix);
      }


      const appNodeIdByVar = new Map<string, string>();
      for (const app of apps) {
        const appId = `hono_app_${this.sanitizeId(app.filePath)}_${this.sanitizeId(app.variable)}`;
        appNodeIdByVar.set(`${app.filePath}::${app.variable}`, appId);

        const appNode = this.createNodeBuilder(appId, app.variable, 'application')
          .withLevel(1, this.getLevelName(1))
          .withCategory('application', ['framework', 'hono'])
          .withSource({ file: app.filePath, line: 1 })
          .withDescription(`Hono application: ${app.variable}`)
          .withTags([`analyzer:${this.id}`])
          .withMetadata({
            framework: 'hono',
            attributes: {
              appVariable: app.variable,
              runtimes: Array.from(runtimes),
            },
          })
          .build();
        nodes.push(appNode);
      }


      routes.forEach((route, index) => {
        const prefix = prefixBySubApp.get(route.appVariable) || '';
        const fullPath = this.joinPath(prefix, route.routePath);
        const methodLabel = route.method.toUpperCase();
        const routeId = `hono_route_${this.sanitizeId(route.appVariable)}_${route.method}_${this.sanitizeId(fullPath)}_${index}`;

        const allMiddleware = [...new Set(route.middleware)]
          .map(name => name.trim())
          .filter(name => /^[\w$.]+(\(.*\))?$/.test(name));
        const authMiddleware = allMiddleware.filter(name =>
          this.isAuthMiddleware(name) ||
          isAuthenticationGuardName(this.stripCall(name)) ||
          classifyGuardKind(this.stripCall(name)) === 'authorization'
        );

        const routeNode = this.createNodeBuilder(routeId, `${methodLabel} ${fullPath}`, 'route')
          .withLevel(3, this.getLevelName(3))
          .withCategory('route', ['http', 'endpoint'])
          .withSource({ file: route.filePath, line: route.line })
          .withDescription(`Hono HTTP endpoint: ${methodLabel} ${fullPath}`)
          .withTags([`analyzer:${this.id}`])
          .withMetadata({
            framework: 'hono',
            attributes: {
              method: route.method,
              path: fullPath,
              raw_path: route.routePath,
              prefix: prefix || undefined,
              handler: route.handler,
              middleware: allMiddleware,
              validated: route.validated,
              authenticated: authMiddleware.length > 0,
            },
          })
          .build();
        nodes.push(routeNode);


        const appNodeId = appNodeIdByVar.get(`${route.filePath}::${route.appVariable}`);
        if (appNodeId) {
          edges.push(this.createEdge(
            `${appNodeId}_exposes_${routeId}`,
            appNodeId,
            routeId,
            'exposes'
          ));
        }


        entryPoints.push(this.createEntryPoint(
          `entry_${routeId}`,
          routeId,
          'http',
          `${methodLabel} ${fullPath}`,
          `Hono HTTP endpoint: ${methodLabel} ${fullPath}`,
          { method: methodLabel, path: fullPath },
          {
            authenticated: authMiddleware.length > 0,
            guards: allMiddleware,
            authorized_roles: [],
          },
          {
            method: methodLabel,
            path: fullPath,
            handler: route.handler,
            handler_file: route.filePath,
            middleware: allMiddleware,
            validated: route.validated,
          },
          {
            node_id: routeId,
            method_name: route.handler || '',
            file: route.filePath,
          }
        ));
      });


      middleware.forEach((mw, index) => {
        const baseName = this.stripCall(mw.name);
        const mwId = `hono_middleware_${this.sanitizeId(mw.appVariable)}_${this.sanitizeId(baseName)}_${index}`;
        const mwNode = this.createNodeBuilder(mwId, baseName, 'middleware')
          .withLevel(3, this.getLevelName(3))
          .withCategory('middleware', ['framework', 'hono', ...(mw.auth ? ['auth', 'security'] : [])])
          .withSource({ file: mw.filePath, line: mw.line })
          .withDescription(
            mw.auth
              ? `Hono auth middleware (auth boundary): ${baseName}`
              : `Hono middleware: ${baseName}`
          )
          .withTags([
            `analyzer:${this.id}`,
            ...(mw.auth ? ['auth-boundary', 'security'] : []),
            ...(mw.builtin ? ['builtin-middleware'] : []),
          ])
          .withMetadata({
            framework: 'hono',
            attributes: {
              global: mw.global,
              path: mw.routePath,
              builtin: mw.builtin,
              auth: mw.auth,
            },
          })
          .build();
        nodes.push(mwNode);

        const appNodeId = appNodeIdByVar.get(`${mw.filePath}::${mw.appVariable}`);
        if (appNodeId) {
          edges.push(this.createEdge(
            `${appNodeId}_uses_${mwId}`,
            appNodeId,
            mwId,
            'uses'
          ));
        }
      });


      mounts.forEach((mount, index) => {
        const mountId = `hono_mount_${this.sanitizeId(mount.appVariable)}_${this.sanitizeId(mount.prefix)}_${index}`;
        const mountNode = this.createNodeBuilder(mountId, `${mount.prefix} → ${mount.subApp}`, 'route_mount')
          .withLevel(2, this.getLevelName(2))
          .withCategory('mount', ['framework', 'hono', 'composition'])
          .withSource({ file: mount.filePath, line: mount.line })
          .withDescription(`Hono sub-app mount: ${mount.subApp} at prefix ${mount.prefix}`)
          .withTags([`analyzer:${this.id}`])
          .withMetadata({
            framework: 'hono',
            attributes: {
              prefix: mount.prefix,
              subApp: mount.subApp,
            },
          })
          .build();
        nodes.push(mountNode);

        const appNodeId = appNodeIdByVar.get(`${mount.filePath}::${mount.appVariable}`);
        if (appNodeId) {
          edges.push(this.createEdge(
            `${appNodeId}_mounts_${mountId}`,
            appNodeId,
            mountId,
            'mounts'
          ));
        }
      });

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework: 'hono',
        version: await this.getFrameworkVersion(context.projectPath, 'hono'),
        appsFound: apps.length,
        routesFound: routes.length,
        middlewareFound: middleware.length,
        mountsFound: mounts.length,
        runtimes: Array.from(runtimes),
      });
    } catch (error) {
      throw new AnalyzerError(
        `Hono analysis failed: ${(error as Error).message}`,
        'HONO_ANALYSIS_ERROR'
      );
    }
  }

  private looksLikeHonoFile(content: string): boolean {
    return /\bfrom\s+['"]hono(?:['"/])/.test(content) ||
           /\brequire\(\s*['"]hono['"]\s*\)/.test(content) ||
           /\bnew\s+Hono\s*[(<]/.test(content);
  }

  private detectRuntimes(content: string, runtimes: Set<string>): void {
    for (const { match, runtime } of RUNTIME_ADAPTERS) {
      if (match.test(content)) runtimes.add(runtime);
    }
  }


  private extractApps(content: string, filePath: string): HonoApp[] {
    const apps: HonoApp[] = [];
    const pattern = /(?:const|let|var)\s+(\w+)\s*=\s*new\s+(?:OpenAPI)?Hono\s*(?:<[^>]*>)?\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      apps.push({ name: match[1], variable: match[1], filePath });
    }
    return apps;
  }


  private extractRoutes(
    content: string,
    filePath: string,
    appVars: Set<string>,
    routes: HonoRoute[]
  ): void {



    const pattern = /(\w+)\s*\.\s*(get|post|put|delete|patch|options|all)\s*\(\s*(['"`])([^'"`]*)\3([^\n]*)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const appVar = match[1];
      const method = match[2];
      const routePath = match[4];
      const rest = match[5] || '';



      const isKnownApp = appVars.has(appVar);

      const isChained = appVar === undefined;
      if (!isKnownApp && !this.isChainedReceiver(content, match.index)) {
        if (!isChained) continue;
      }

      if (!HTTP_METHODS.includes(method)) continue;

      const line = content.slice(0, match.index).split('\n').length;
      const middleware = this.extractInlineMiddleware(rest);
      const validated = /\b(zValidator|validator)\s*\(/.test(rest);
      const handler = this.extractHandlerRef(rest);

      routes.push({
        method,
        routePath,
        filePath,
        appVariable: isKnownApp ? appVar : this.resolveChainAppVar(content, match.index, appVars) || appVar,
        handler,
        middleware,
        validated,
        line,
      });
    }
  }



  private isChainedReceiver(content: string, methodIndex: number): boolean {

    let i = methodIndex - 1;
    while (i >= 0 && /\s/.test(content[i])) i--;
    return i >= 0 && content[i] === ')';
  }


  private resolveChainAppVar(content: string, methodIndex: number, appVars: Set<string>): string | undefined {

    const head = content.slice(Math.max(0, methodIndex - 400), methodIndex);
    const m = /(\w+)\s*\.\s*(?:get|post|put|delete|patch|options|all)\s*\(/.exec(head);
    if (m && appVars.has(m[1])) return m[1];
    return undefined;
  }


  private extractMiddleware(
    content: string,
    filePath: string,
    appVars: Set<string>,
    middleware: HonoMiddleware[]
  ): void {
    const pattern = /(\w+)\s*\.\s*use\s*\(\s*([^)]*)\)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const appVar = match[1];
      if (!appVars.has(appVar)) continue;
      const argsRaw = match[2];
      const line = content.slice(0, match.index).split('\n').length;

      const args = this.splitArgs(argsRaw);
      let routePath = '*';
      let mwArgs = args;


      const first = args[0]?.trim();
      if (first && /^['"`]/.test(first)) {
        routePath = first.replace(/['"`]/g, '');
        mwArgs = args.slice(1);
      }

      const global = routePath === '*' || routePath === '/' || routePath === '/*';

      for (const arg of mwArgs) {
        const name = this.middlewareName(arg);
        if (!name) continue;
        const base = this.stripCall(name);
        middleware.push({
          name,
          appVariable: appVar,
          routePath,
          global,
          builtin: BUILTIN_MIDDLEWARE.has(base),
          auth: this.isAuthMiddleware(name),
          filePath,
          line,
        });
      }
    }
  }


  private extractMounts(
    content: string,
    filePath: string,
    appVars: Set<string>,
    mounts: HonoMount[]
  ): void {
    const pattern = /(\w+)\s*\.\s*route\s*\(\s*(['"`])([^'"`]+)\2\s*,\s*(\w+)\s*\)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const appVar = match[1];
      if (!appVars.has(appVar)) continue;
      const prefix = match[3];
      const subApp = match[4];
      const line = content.slice(0, match.index).split('\n').length;
      mounts.push({ prefix, subApp, appVariable: appVar, filePath, line });
    }
  }

  private extractInlineMiddleware(rest: string): string[] {
    const out: string[] = [];

    const callPattern = /\b(\w+)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = callPattern.exec(rest)) !== null) {
      const name = m[1];
      if (BUILTIN_MIDDLEWARE.has(name) || AUTH_MIDDLEWARE.has(name) ||
          name === 'zValidator' || name === 'validator') {
        out.push(`${name}()`);
      }
    }
    return out;
  }

  private extractHandlerRef(rest: string): string | undefined {


    if (/=>/.test(rest) || /\bfunction\b/.test(rest)) return 'inline';
    const idMatch = /,\s*(\w+)\s*\)?\s*;?\s*$/.exec(rest);
    return idMatch ? idMatch[1] : undefined;
  }

  private middlewareName(arg: string): string | undefined {
    const trimmed = arg.trim();
    if (!trimmed) return undefined;
    if (/^['"`]/.test(trimmed)) return undefined;
    if (/=>/.test(trimmed) || /^function\b/.test(trimmed) || /^async\b/.test(trimmed)) {
      return 'inlineMiddleware';
    }
    const m = /^([\w$.]+)/.exec(trimmed);
    return m ? (trimmed.includes('(') ? `${m[1]}()` : m[1]) : undefined;
  }

  private isAuthMiddleware(name: string): boolean {
    return AUTH_MIDDLEWARE.has(this.stripCall(name));
  }

  private stripCall(name: string): string {
    return name.replace(/\(.*$/, '').replace(/^.*\./, '').trim();
  }

  private joinPath(prefix: string, routePath: string): string {
    if (!prefix) return routePath || '/';
    const joined = `${prefix.replace(/\/$/, '')}/${routePath.replace(/^\//, '')}`;
    return joined.replace(/\/{2,}/g, '/') || '/';
  }


  private splitArgs(raw: string): string[] {
    const args: string[] = [];
    let depth = 0;
    let current = '';
    for (const ch of raw) {
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
      if (ch === ',' && depth === 0) {
        args.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    if (current.trim()) args.push(current);
    return args;
  }

  protected getCapabilities(): string[] {
    return ['hono-routes', 'hono-middleware', 'hono-auth', 'hono-runtime'];
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
