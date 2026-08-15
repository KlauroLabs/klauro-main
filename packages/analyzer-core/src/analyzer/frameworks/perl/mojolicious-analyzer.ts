import { AnalysisContext, BaseAnalyzer } from '../../core/base-analyzer';
import { CASContribution, CASEntryPoint, CASNode, CASEdge } from '../../../types/cas.types';
import * as fs from 'fs-extra';
import * as path from 'path';
import { cachedGlob as glob } from '../../core/glob-cache';















































const LITE_VERBS: Record<string, string> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  patch: 'PATCH',
  del: 'DELETE',
  options: 'OPTIONS',
  any: 'GET',
};


const ROUTER_VERBS = LITE_VERBS;

const VERB_ALT = Object.keys(LITE_VERBS).join('|');



const LITE_RE = new RegExp(
  String.raw`^\s*(${VERB_ALT})\s+(['"])([^'"]+)\2\s*=>`,
  'gm'
);




const ROUTER_RE = new RegExp(
  String.raw`(\$\w+)\s*->\s*(${VERB_ALT})\s*\(\s*(['"])([^'"]+)\3`,
  'g'
);


const UNDER_RE = /my\s+(\$\w+)\s*=\s*(\$\w+)\s*->\s*([^;]*?\bunder\s*\(\s*['"]([^'"]+)['"][^;]*);/g;

const AUTH_HINT = /authenticat|login|require_|\bcheck\b|is_admin|logged_in|guard|session/i;

const ROOT_INVOCANT = /^\$(r|router|routes|route|self|app|c|me)$/i;

interface MojoRoute {
  method: string;
  fullPath: string;
  handler: string;
  controller?: string;
  authed: boolean;
  verb: string;
  line: number;
}


interface Builder {
  prefix: string;
  authed: boolean;
}

export class MojoliciousAnalyzer extends BaseAnalyzer {
  constructor() {
    super('mojolicious', 'Mojolicious Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {

      for (const manifest of ['cpanfile', 'Makefile.PL']) {
        const file = path.join(projectPath, manifest);
        if (await fs.pathExists(file)) {
          const content = await fs.readFile(file, 'utf-8');
          if (/Mojolicious/i.test(content)) return true;
        }
      }

      for (const file of await this.findPerlFiles(projectPath)) {
        const content = await fs.readFile(file, 'utf-8');
        if (/use\s+Mojolicious/.test(content)) return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];

    try {
      const files = await this.findPerlFiles(context.projectPath);
      for (const file of files) {
        const content = await fs.readFile(file, 'utf-8');
        if (
          !/use\s+Mojolicious/.test(content) &&
          !new RegExp(String.raw`->\s*(?:${VERB_ALT}|under)\s*\(`).test(content) &&
          !new RegExp(String.raw`^\s*(?:${VERB_ALT})\s+['"]`, 'm').test(content)
        ) {
          continue;
        }
        const relativePath = path.relative(context.projectPath, file);
        this.extractRoutes(content, relativePath, nodes, entryPoints);
      }

      return this.createContribution(nodes, edges, entryPoints, [], {
        framework_specific: {
          framework: 'mojolicious',
          route_count: entryPoints.filter(ep => ep.metadata?.framework === 'mojolicious').length,
          authenticated_route_count: entryPoints.filter(
            ep => ep.metadata?.framework === 'mojolicious' && ep.security?.authenticated
          ).length,
        },
      });
    } catch (error) {
      throw new Error(`Mojolicious analysis failed: ${(error as Error).message}`);
    }
  }

  protected getCapabilities(): string[] {
    return ['route-detection', 'under-bridge-prefix-resolution', 'under-bridge-auth-detection'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'mojolicious-framework';
      case 2: return 'route-helpers';
      case 3: return 'handlers';
      case 4: return 'under-bridges';
      default: return `mojolicious-level-${level}`;
    }
  }


  private lineAt(content: string, index: number): number {
    let line = 1;
    for (let i = 0; i < index && i < content.length; i++) {
      if (content.charCodeAt(i) === 10) line++;
    }
    return line;
  }








  private extractRoutes(
    content: string,
    relativePath: string,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[]
  ): void {
    const builders = new Map<string, Builder>();


    UNDER_RE.lastIndex = 0;
    let um: RegExpExecArray | null;
    while ((um = UNDER_RE.exec(content)) !== null) {
      const name = um[1];
      const rootName = um[2];
      const chainTail = um[3] || '';
      const underPath = um[4] || '';
      const base: Builder =
        builders.get(rootName) ||
        (ROOT_INVOCANT.test(rootName) ? { prefix: '', authed: false } : { prefix: '', authed: false });
      const prefix = this.joinPath(base.prefix, underPath);
      const authed = base.authed || AUTH_HINT.test(chainTail);
      builders.set(name, { prefix, authed });
    }

    const seen = new Set<string>();
    const push = (route: MojoRoute) => {
      const key = `${route.method}:${route.fullPath}`;
      if (seen.has(key)) return;
      seen.add(key);
      this.emitRoute(route, relativePath, nodes, entryPoints);
    };


    LITE_RE.lastIndex = 0;
    let lm: RegExpExecArray | null;
    while ((lm = LITE_RE.exec(content)) !== null) {
      const verb = lm[1];
      const rawPath = lm[3];
      const fullPath = this.normalizePath(rawPath);
      const method = LITE_VERBS[verb];
      push({
        method,
        fullPath,
        handler: this.handlerName(verb, fullPath),
        controller: undefined,
        authed: false,
        verb,
        line: this.lineAt(content, lm.index),
      });
    }


    ROUTER_RE.lastIndex = 0;
    let rm: RegExpExecArray | null;
    while ((rm = ROUTER_RE.exec(content)) !== null) {
      const invocant = rm[1];
      const verb = rm[2];
      const rawPath = rm[4];
      const builder =
        builders.get(invocant) ||
        (ROOT_INVOCANT.test(invocant) ? { prefix: '', authed: false } : null);
      if (!builder) continue;

      const fullPath = this.normalizePath(this.joinPath(builder.prefix, rawPath));
      const method = ROUTER_VERBS[verb];


      let controller: string | undefined;
      const tail = content.slice(rm.index, rm.index + 200);
      const toMatch = tail.match(/->\s*to\s*\(\s*['"]([^'"]*#[^'"]*)['"]/);
      if (toMatch) controller = toMatch[1];

      push({
        method,
        fullPath,
        handler: controller ? controller.replace('#', '_') : this.handlerName(verb, fullPath),
        controller,
        authed: builder.authed,
        verb,
        line: this.lineAt(content, rm.index),
      });
    }
  }

  private emitRoute(
    route: MojoRoute,
    relativePath: string,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[]
  ): void {
    const nodeId = `function:${relativePath}:${route.handler}`;
    if (!nodes.some(node => node.id === nodeId)) {
      nodes.push(this.createNodeBuilder(nodeId, route.handler, 'function')
        .withLevel(4, 'member')
        .withCategory('handler', ['mojolicious', 'http'])
        .withSource({ file: relativePath, line: route.line, end_line: route.line })
        .withDescription(`Handles ${route.method} ${route.fullPath}`)
        .withMetadata({
          framework: 'mojolicious',
          attributes: { method: route.method, path: route.fullPath },
        })
        .build());
    }
    entryPoints.push(
      this.createEntryPoint(
        `entry:http:${relativePath}:${route.handler}:${route.method}:${route.fullPath}`,
        nodeId,
        'http',
        `${route.method} ${route.fullPath}`,
        `HTTP route ${route.method} ${route.fullPath} (Mojolicious ${route.verb})`,
        { method: route.method, path: route.fullPath },
        { authenticated: route.authed },
        {
          framework: 'mojolicious',
          method: route.method,
          path: route.fullPath,
          handler: route.handler,
          controller: route.controller,
          verb: route.verb,
        },
        { node_id: nodeId, method_name: route.handler, file: relativePath, line: route.line }
      )
    );
  }




  private normalizePath(raw: string): string {
    let p = (raw || '').trim();
    if (!p.startsWith('/')) p = '/' + p;
    p = p.replace(/\/+/g, '/');
    if (p.length > 1) p = p.replace(/\/$/, '');
    return p;
  }

  private joinPath(prefix: string, seg: string): string {
    const a = (prefix || '').replace(/\/$/, '');
    const b = (seg || '').replace(/^\//, '');
    if (!a) return '/' + b;
    if (!b) return a;
    return a + '/' + b;
  }


  private handlerName(verb: string, fullPath: string): string {
    const slug = fullPath.replace(/[/:*]/g, '_').replace(/^_+|_+$/g, '') || 'root';
    return `${verb}_${slug}`;
  }

  private async findPerlFiles(projectPath: string): Promise<string[]> {
    const files = await glob('**/*.{pl,pm,t}', {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath } as AnalysisContext),
      nodir: true,
    });
    return files.map(file => path.join(projectPath, file));
  }
}
