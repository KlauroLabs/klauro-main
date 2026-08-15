import { AnalysisContext, BaseAnalyzer } from '../../core/base-analyzer';
import { CASContribution, CASEntryPoint, CASNode, CASEdge } from '../../../types/cas.types';
import { parseWasm } from '../../core/wasm-tree-sitter';
import * as fs from 'fs-extra';
import * as path from 'path';
import { cachedGlob as glob } from '../../core/glob-cache';








































const HTTP_METHODS = new Set([
  'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'ANY',
]);


interface CompojureRoute {
  method: string;
  fullPath: string;
  handler: string;
  line: number;
}

export class CompojureAnalyzer extends BaseAnalyzer {
  constructor() {
    super('compojure', 'Compojure Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {

      for (const manifest of ['deps.edn', 'project.clj']) {
        const p = path.join(projectPath, manifest);
        if (await fs.pathExists(p)) {
          const content = await fs.readFile(p, 'utf-8');
          if (/compojure/i.test(content)) return true;
        }
      }

      for (const file of await this.findClojureFiles(projectPath)) {
        const content = await fs.readFile(file, 'utf-8');
        if (/compojure\.core|\(defroutes\b|\(context\b/.test(content)) return true;
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
      const files = await this.findClojureFiles(context.projectPath);
      for (const file of files) {
        const content = await fs.readFile(file, 'utf-8');
        if (!/compojure|\(defroutes\b|\(context\b|\(GET\b|\(POST\b|\(PUT\b|\(DELETE\b/.test(content)) {
          continue;
        }
        const relativePath = path.relative(context.projectPath, file);
        await this.extractRoutes(content, relativePath, entryPoints);
      }

      return this.createContribution(nodes, edges, entryPoints, [], {
        framework_specific: {
          framework: 'compojure',
          route_count: entryPoints.filter(ep => ep.metadata?.framework === 'compojure').length,
          authenticated_route_count: entryPoints.filter(
            ep => ep.metadata?.framework === 'compojure' && ep.security?.authenticated
          ).length,
        },
      });
    } catch (error) {
      throw new Error(`Compojure analysis failed: ${(error as Error).message}`);
    }
  }

  protected getCapabilities(): string[] {
    return ['route-detection', 'context-prefix-resolution', 'path-param-extraction'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'compojure-framework';
      case 2: return 'route-forms';
      case 3: return 'context-nesting';
      case 4: return 'handlers';
      default: return `compojure-level-${level}`;
    }
  }











  private async extractRoutes(content: string, relativePath: string, entryPoints: CASEntryPoint[]): Promise<void> {
    const tree = await parseWasm('clojure', content);
    const root = tree.rootNode;
    const seen = new Set<string>();

    const walk = (node: any, prefix: string): void => {
      if (!node) return;

      if (node.type === 'list_lit') {
        const head = this.headSymbol(node);

        if (head && HTTP_METHODS.has(head)) {
          const route = this.parseRouteForm(node, head, prefix);
          if (route) {
            const dedupe = `${route.method}:${route.fullPath}`;
            if (!seen.has(dedupe)) {
              seen.add(dedupe);
              this.emitRoute(route, relativePath, entryPoints);
            }
          }



          this.walkChildren(node, prefix, walk);
          return;
        }

        if (head === 'context') {
          const seg = this.firstStringSegment(node);
          const childPrefix = seg ? this.joinPrefix(prefix, seg) : prefix;
          this.walkChildren(node, childPrefix, walk);
          return;
        }


        this.walkChildren(node, prefix, walk);
        return;
      }

      this.walkChildren(node, prefix, walk);
    };

    try {
      walk(root, '');
    } finally {
      tree.delete?.();
    }
  }

  private walkChildren(node: any, prefix: string, walk: (n: any, p: string) => void): void {
    for (let i = 0; i < node.namedChildCount; i++) {
      walk(node.namedChild(i), prefix);
    }
  }







  private parseRouteForm(node: any, head: string, prefix: string): CompojureRoute | null {
    const rawPath = this.firstStringSegment(node);
    if (rawPath === null) return null;

    const method = head === 'ANY' ? 'GET' : head;
    const fullPath = this.joinPrefix(prefix, rawPath);
    const handler = this.routeHandlerName(node) ??
      `${method.toLowerCase()}_${fullPath.replace(/[/:]/g, '_').replace(/^_+|_+$/g, '') || 'root'}`;

    return {
      method,
      fullPath,
      handler,
      line: node.startPosition.row + 1,
    };
  }







  private routeHandlerName(node: any): string | undefined {


    const children: any[] = [];
    for (let i = 0; i < node.namedChildCount; i++) children.push(node.namedChild(i));

    let sawPath = false;
    let sawBindings = false;
    for (let i = 1; i < children.length; i++) {
      const c = children[i];
      if (!sawPath && c.type === 'str_lit') { sawPath = true; continue; }
      if (sawPath && !sawBindings && (c.type === 'vec_lit' || c.type === 'sym_lit' || c.type === 'map_lit')) {

        sawBindings = true;
        continue;
      }
      if (sawPath && sawBindings) {

        if (c.type === 'sym_lit') return this.symbolName(c);
        if (c.type === 'list_lit') {
          const h = this.headSymbol(c);
          if (h) return h;
        }
        return undefined;
      }
    }
    return undefined;
  }

  private emitRoute(route: CompojureRoute, relativePath: string, entryPoints: CASEntryPoint[]): void {
    const nodeId = `function:${relativePath}:${route.handler}`;
    entryPoints.push(
      this.createEntryPoint(
        `entry:http:${relativePath}:${route.handler}:${route.method}:${route.fullPath}`,
        nodeId,
        'http',
        `${route.method} ${route.fullPath}`,
        `HTTP route handled by ${route.handler}`,
        { method: route.method, path: route.fullPath },

        { authenticated: false },
        {
          framework: 'compojure',
          method: route.method,
          path: route.fullPath,
          handler: route.handler,
          controller: undefined,
        },
        { node_id: nodeId, method_name: route.handler, file: relativePath, line: route.line }
      )
    );
  }




  private headSymbol(listNode: any): string | undefined {
    for (let i = 0; i < listNode.namedChildCount; i++) {
      const c = listNode.namedChild(i);
      if (c.type === 'sym_lit') return this.symbolName(c);

      return undefined;
    }
    return undefined;
  }


  private symbolName(symNode: any): string | undefined {
    const name = this.childOfType(symNode, 'sym_name');
    const text = (name ? name.text : symNode.text) ?? '';
    return text.trim() || undefined;
  }






  private firstStringSegment(listNode: any): string | null {
    for (let i = 0; i < listNode.namedChildCount; i++) {
      const c = listNode.namedChild(i);
      if (c.type === 'str_lit') {
        return this.stringValue(c);
      }
    }
    return null;
  }


  private stringValue(strNode: any): string {
    const raw = (strNode.text ?? '').trim();
    return raw.replace(/^"|"$/g, '');
  }





  private joinPrefix(prefix: string, segment: string): string {
    const a = prefix.replace(/\/+$/, '');
    const b = segment.startsWith('/') ? segment : '/' + segment;
    let joined = (a + b).replace(/\/+/g, '/');
    if (joined === '') joined = '/';
    if (joined.length > 1) joined = joined.replace(/\/$/, '');
    return joined;
  }

  private childOfType(node: any, type: string): any {
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c.type === type) return c;
    }
    return undefined;
  }

  private async findClojureFiles(projectPath: string): Promise<string[]> {
    const files = await glob('**/*.{clj,cljs,cljc}', {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath } as AnalysisContext),
      nodir: true,
    });
    return files.map(file => path.join(projectPath, file));
  }
}
