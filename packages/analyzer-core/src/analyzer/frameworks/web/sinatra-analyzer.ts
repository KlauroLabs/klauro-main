import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint
} from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import { classifyGuardKind, isAuthenticationGuardName } from '../../core/guard-classification';
import * as path from 'path';
import * as fs from 'fs-extra';
import { glob } from 'glob';

/**
 * A single Sinatra route: `get '/path' do ... end` (or `get '/path' do |x| ... end`,
 * or the one-liner `get('/path') { ... }` block form).
 */
interface SinatraRoute {
  method: string;
  path: string;
  file: string;
  line: number;
  guards: string[];
}

const SINATRA_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];
const AUTH_HELPER_PATTERN = /protected!|authorize!|authenticate!|require_login|login_required/i;

export class SinatraAnalyzer extends BaseAnalyzer {
  constructor() {
    super('sinatra', 'Sinatra Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const gemfilePath = path.join(projectPath, 'Gemfile');
      if (await fs.pathExists(gemfilePath)) {
        const content = await fs.readFile(gemfilePath, 'utf-8');
        if (/^\s*gem\s+['"]sinatra['"]/m.test(content)) return true;
      }

      const rubyFiles = await glob(['**/*.rb'], {
        cwd: projectPath,
        ignore: [...this.getIgnorePatterns({ projectPath } as AnalysisContext), '**/spec/**', '**/test/**'],
        nodir: true
      });

      for (const file of rubyFiles) {
        const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
        if (this.looksLikeSinatraUsage(content)) return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  private looksLikeSinatraUsage(content: string): boolean {
    const requiresSinatra = /require\s+['"]sinatra['"]|require\s+['"]sinatra\/base['"]/.test(content);
    const extendsSinatraBase = /class\s+\w+\s*<\s*Sinatra::Base/.test(content);
    const hasRouteCall = new RegExp(`^\\s*(${SINATRA_METHODS.join('|')})\\s+['"\`]`, 'm').test(content);
    return (requiresSinatra || extendsSinatraBase) && hasRouteCall;
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    try {
      const rubyFiles = await glob(['**/*.rb'], {
        cwd: context.projectPath,
        ignore: [...this.getIgnorePatterns(context), '**/spec/**', '**/test/**'],
        nodir: true
      });

      const allRoutes: SinatraRoute[] = [];
      for (const file of rubyFiles) {
        const content = await fs.readFile(path.join(context.projectPath, file), 'utf-8');
        allRoutes.push(...this.extractRoutes(content, file));
      }

      if (allRoutes.length === 0) {
        return this.createContribution(nodes, edges, entryPoints, exitPoints, {
          framework: 'sinatra',
          routesFound: 0
        });
      }

      let version = 'unknown';
      try {
        const lockPath = path.join(context.projectPath, 'Gemfile.lock');
        if (await fs.pathExists(lockPath)) {
          const lockContent = await fs.readFile(lockPath, 'utf-8');
          const lockMatch = lockContent.match(/^\s{4}sinatra\s+\(([^)]+)\)/m);
          if (lockMatch) version = lockMatch[1];
        }
      } catch { /* best effort */ }

      const appId = 'app_sinatra';
      const appNode = this.createNodeBuilder(appId, 'Sinatra Application', 'application')
        .withLevel(1, 'system')
        .withCategory('application', ['framework', 'sinatra', 'ruby'])
        .withSource({ file: path.join(context.projectPath, allRoutes[0].file), line: 1, end_line: 1 })
        .withDescription('Sinatra HTTP application')
        .withMetadata({ framework: 'sinatra', attributes: { version, routes: allRoutes.length } })
        .build();
      nodes.push(appNode);

      allRoutes.forEach((route, index) => {
        const routeId = `route_sinatra_${this.sanitizeId(route.method)}_${this.sanitizeId(route.path)}_${index}`;
        const handlerName = `${route.method}_${this.sanitizeId(route.path)}`;

        const routeNode = this.createNodeBuilder(routeId, `${route.method.toUpperCase()} ${route.path}`, 'route')
          .withLevel(3, 'code')
          .withCategory('route', ['http', 'endpoint'])
          .withSource({ file: path.join(context.projectPath, route.file), line: route.line, end_line: route.line })
          .withDescription(`Sinatra HTTP endpoint: ${route.method.toUpperCase()} ${route.path}`)
          .withMetadata({
            framework: 'sinatra',
            attributes: {
              method: route.method,
              path: route.path,
              handler: handlerName,
              guards: route.guards
            }
          })
          .build();
        nodes.push(routeNode);

        edges.push(this.createEdge(`${appId}_exposes_${routeId}`, appId, routeId, 'exposes'));

        const authGuards = route.guards.filter(g => isAuthenticationGuardName(g) || classifyGuardKind(g) === 'authorization' || AUTH_HELPER_PATTERN.test(g));

        entryPoints.push(this.createEntryPoint(
          `entry_${routeId}`,
          routeId,
          'http',
          `${route.method.toUpperCase()} ${route.path}`,
          `Sinatra HTTP endpoint: ${route.method.toUpperCase()} ${route.path}`,
          { method: route.method.toUpperCase(), path: route.path },
          {
            authenticated: authGuards.length > 0,
            guards: route.guards,
            authorized_roles: []
          },
          {
            method: route.method.toUpperCase(),
            path: route.path,
            handler: handlerName,
            handler_file: route.file,
            guards: route.guards,
            framework: 'sinatra'
          },
          { node_id: routeId, method_name: handlerName, file: route.file, line: route.line }
        ));
      });

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework: 'sinatra',
        version,
        routesFound: allRoutes.length
      });
    } catch (error) {
      throw new AnalyzerError(`Sinatra analysis failed: ${(error as Error).message}`, 'SINATRA_ANALYSIS_ERROR');
    }
  }

  /**
   * Extract every `get/post/put/patch/delete/options/head '/path' do ... end`
   * (and the block-form one-liner `get('/path') { ... }`) route in a file,
   * honoring `namespace '/prefix' do ... end` blocks (Sinatra::Namespace) which
   * prefix every route nested inside them.
   */
  extractRoutes(content: string, file: string): SinatraRoute[] {
    const routes: SinatraRoute[] = [];
    const lines = content.split('\n');

    // Track a stack of (kind, prefix) for `do...end` blocks so `namespace` prefixes
    // apply to nested routes and pop correctly when their block closes. We only
    // push a frame for constructs we recognize (namespace / route-with-do); other
    // `do`/`end` pairs (e.g. `helpers do`) are tracked too so the stack stays balanced,
    // but they carry no prefix change.
    const stack: Array<{ prefix: string }> = [{ prefix: '' }];
    let pendingBeforeGuards: string[] = [];

    const routeHeadPattern = new RegExp(
      `^\\s*(${SINATRA_METHODS.join('|')})\\s+(['"\`])([^'"\`]+)\\2\\s*(?:,\\s*[^{]*?)?(do\\b|\\{)?`
    );
    const namespaceHeadPattern = /^\s*namespace\s+(['"`])([^'"`]+)\1\s*do\b/;
    const beforeFilterPattern = /^\s*before\s+(?:(['"`])([^'"`]+)\1\s*)?do\b/;
    const helperGuardCallPattern = /^\s*(protected!|authorize!\([^)]*\)|authenticate!\([^)]*\))\s*$/;

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const trimmed = raw.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;

      const namespaceMatch = trimmed.match(namespaceHeadPattern);
      if (namespaceMatch) {
        const currentPrefix = stack[stack.length - 1].prefix;
        stack.push({ prefix: this.joinPaths(currentPrefix, namespaceMatch[2]) });
        continue;
      }

      const beforeMatch = trimmed.match(beforeFilterPattern);
      if (beforeMatch) {
        // A `before do ... protected! ... end` block: scan ahead for an auth helper
        // call inside it and treat every subsequent route in this scope as guarded.
        // Simpler, honest approximation: record the guard name if present in the
        // immediate block body (best-effort single-line lookahead loop below).
        let j = i + 1;
        let depth = 1;
        while (j < lines.length && depth > 0) {
          const bTrim = lines[j].trim();
          if (/\bdo\b\s*$/.test(bTrim)) depth++;
          if (/^end\b/.test(bTrim)) { depth--; if (depth === 0) break; }
          if (helperGuardCallPattern.test(bTrim)) {
            pendingBeforeGuards.push(bTrim.replace(/\(.*\)$/, ''));
          }
          j++;
        }
        stack.push({ prefix: stack[stack.length - 1].prefix });
        continue;
      }

      const routeMatch = trimmed.match(routeHeadPattern);
      if (routeMatch) {
        const method = routeMatch[1];
        const routePath = routeMatch[3];
        const opener = routeMatch[4];
        const prefix = stack[stack.length - 1].prefix;
        const fullPath = this.joinPaths(prefix, routePath);

        // Guards: an inline `protected!`/`authorize!` on the SAME line as the route
        // header (rare), plus any accumulated `before do ... end` guard helpers.
        const inlineGuards = (trimmed.match(/\b(protected!|authorize!|authenticate!)\b/g) || []);
        const guards = [...new Set([...pendingBeforeGuards, ...inlineGuards])];

        routes.push({ method, path: fullPath, file, line: i + 1, guards });

        if (opener === 'do') stack.push({ prefix });
        // `{ ... }` one-liners don't open a multi-line block we need to track.
        continue;
      }

      if (/\bdo\b\s*$/.test(trimmed) && !routeMatch) {
        // Some other block (helpers do, configure do, etc.) — push a neutral frame
        // so `end` balances the stack without corrupting the active prefix.
        stack.push({ prefix: stack[stack.length - 1].prefix });
        continue;
      }

      if (/^end\b/.test(trimmed)) {
        if (stack.length > 1) stack.pop();
        continue;
      }
    }

    return routes;
  }

  private joinPaths(a: string, b: string): string {
    const left = (a || '').replace(/\/+$/, '');
    const right = (b || '').replace(/^\/+/, '');
    if (!left) return right ? `/${right}` : '/';
    if (!right) return left || '/';
    return `${left}/${right}`;
  }

  protected getCapabilities(): string[] {
    return ['sinatra-analysis', 'route-extraction', 'namespace-prefix-resolution', 'route-mapping'];
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
