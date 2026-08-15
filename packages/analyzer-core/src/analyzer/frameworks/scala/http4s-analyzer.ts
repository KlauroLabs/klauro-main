import { AnalysisContext, BaseAnalyzer } from '../../core/base-analyzer';
import { CASContribution, CASEntryPoint, CASNode, CASEdge } from '../../../types/cas.types';
import { parseWasm } from '../../core/wasm-tree-sitter';
import * as fs from 'fs-extra';
import * as path from 'path';
import { cachedGlob as glob } from '../../core/glob-cache';









































const HTTP_METHODS = new Set([
  'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS',
]);

interface Http4sRoute {
  method: string;
  fullPath: string;
  authed: boolean;
  line: number;
}

export class Http4sAnalyzer extends BaseAnalyzer {
  constructor() {
    super('http4s', 'http4s Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {

      const sbt = path.join(projectPath, 'build.sbt');
      if (await fs.pathExists(sbt)) {
        const content = await fs.readFile(sbt, 'utf-8');
        if (/http4s/i.test(content)) return true;
      }

      for (const file of await this.findScalaFiles(projectPath)) {
        const content = await fs.readFile(file, 'utf-8');
        if (/org\.http4s|HttpRoutes\.of|AuthedRoutes\.of/.test(content)) return true;
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
      const files = await this.findScalaFiles(context.projectPath);
      for (const file of files) {
        const content = await fs.readFile(file, 'utf-8');
        if (!/HttpRoutes\.of|AuthedRoutes\.of|org\.http4s/.test(content)) continue;
        const relativePath = path.relative(context.projectPath, file);
        await this.extractRoutes(content, relativePath, entryPoints);
      }

      return this.createContribution(nodes, edges, entryPoints, [], {
        framework_specific: {
          framework: 'http4s',
          route_count: entryPoints.filter(ep => ep.metadata?.framework === 'http4s').length,
          authenticated_route_count: entryPoints.filter(
            ep => ep.metadata?.framework === 'http4s' && ep.security?.authenticated
          ).length,
        },
      });
    } catch (error) {
      throw new Error(`http4s analysis failed: ${(error as Error).message}`);
    }
  }

  protected getCapabilities(): string[] {
    return ['route-detection', 'path-param-extraction', 'authed-routes-detection'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'http4s-framework';
      case 2: return 'routes-blocks';
      case 3: return 'route-clauses';
      case 4: return 'auth-middleware';
      default: return `http4s-level-${level}`;
    }
  }








  private async extractRoutes(content: string, relativePath: string, entryPoints: CASEntryPoint[]): Promise<void> {
    const tree = await parseWasm('scala', content);
    const root = tree.rootNode;

    const seen = new Set<string>();

    const visit = (node: any): void => {
      if (!node) return;

      if (node.type === 'case_block') {
        const authed = this.blockIsAuthed(node);
        for (let i = 0; i < node.namedChildCount; i++) {
          const clause = node.namedChild(i);
          if (clause.type !== 'case_clause') continue;
          const route = this.parseCaseClause(clause, authed);
          if (!route) continue;
          const dedupe = `${route.method}:${route.fullPath}`;
          if (seen.has(dedupe)) continue;
          seen.add(dedupe);
          this.emitRoute(route, relativePath, entryPoints);
        }
      }

      for (let i = 0; i < node.namedChildCount; i++) {
        visit(node.namedChild(i));
      }
    };

    try {
      visit(root);
    } finally {
      tree.delete?.();
    }
  }







  private blockIsAuthed(caseBlock: any): boolean {
    let cur = caseBlock.parent;
    let depth = 0;
    while (cur && depth < 6) {
      if (cur.type === 'val_definition' || cur.type === 'var_definition' ||
          cur.type === 'function_definition' || cur.type === 'call_expression') {


        if (this.definitionUsesAuthedRoutes(cur, caseBlock)) return true;

        if (cur.type === 'val_definition' || cur.type === 'var_definition' ||
            cur.type === 'function_definition') {
          return false;
        }
      }
      cur = cur.parent;
      depth++;
    }
    return false;
  }


  private definitionUsesAuthedRoutes(def: any, caseBlock: any): boolean {
    for (let i = 0; i < def.namedChildCount; i++) {
      const child = def.namedChild(i);
      if (child.id === caseBlock.id) continue;
      if (child.type === 'case_block') continue;
      const text = this.nodeText(child);
      if (/AuthedRoutes/.test(text)) return true;
    }
    return false;
  }





  private parseCaseClause(clause: any, blockAuthed: boolean): Http4sRoute | null {
    const pattern = clause.namedChild(0);
    if (!pattern) return null;

    const collected = { method: undefined as string | undefined, segments: [] as string[], authed: blockAuthed };
    this.collectPattern(pattern, collected);

    if (!collected.method || !HTTP_METHODS.has(collected.method)) return null;

    const fullPath = collected.segments.length ? '/' + collected.segments.join('/') : '/';
    return {
      method: collected.method,
      fullPath,
      authed: collected.authed,
      line: clause.startPosition.row + 1,
    };
  }











  private collectPattern(node: any, out: { method?: string; segments: string[]; authed: boolean }): void {
    if (!node) return;

    if (node.type === 'infix_pattern') {

      const left = node.namedChild(0);
      const op = this.childOfType(node, 'operator_identifier');
      const opText = op ? this.nodeText(op).trim() : '';

      const right = node.namedChild(node.namedChildCount - 1);

      this.collectPattern(left, out);

      if (opText === '->') {


        return;
      }
      if (opText === '/') {
        this.appendSegment(right, out);
        return;
      }

      if (this.nodeText(op || node).includes('as') || (op == null && this.hasAsBinder(node))) {
        out.authed = true;
        return;
      }

      return;
    }

    if (node.type === 'identifier') {
      const text = this.nodeText(node).trim();
      if (HTTP_METHODS.has(text)) {
        out.method = text;
      }

      return;
    }


  }


  private hasAsBinder(node: any): boolean {
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c.type === 'identifier' && this.nodeText(c).trim() === 'as') return true;
    }
    return false;
  }







  private appendSegment(right: any, out: { segments: string[] }): void {
    if (!right) return;

    if (right.type === 'string') {
      const v = this.stringValue(right);
      for (const part of v.split('/').filter(Boolean)) out.segments.push(part);
      return;
    }

    if (right.type === 'case_class_pattern') {

      const boundVar = this.lastIdentifier(right);
      out.segments.push(':' + (boundVar || this.varExtractorName(right)));
      return;
    }

    if (right.type === 'identifier' || right.type === 'capture_pattern' || right.type === 'typed_pattern') {

      const name = this.lastIdentifier(right);
      if (name) out.segments.push(':' + name);
      return;
    }


    const name = this.lastIdentifier(right);
    out.segments.push(':' + (name || 'param'));
  }

  private emitRoute(route: Http4sRoute, relativePath: string, entryPoints: CASEntryPoint[]): void {
    const handler = `${route.method.toLowerCase()}_${route.fullPath.replace(/[/:]/g, '_').replace(/^_+|_+$/g, '') || 'root'}`;
    const nodeId = `function:${relativePath}:${handler}`;
    entryPoints.push(
      this.createEntryPoint(
        `entry:http:${relativePath}:${handler}:${route.method}:${route.fullPath}`,
        nodeId,
        'http',
        `${route.method} ${route.fullPath}`,
        `HTTP route ${route.method} ${route.fullPath}`,
        { method: route.method, path: route.fullPath },
        { authenticated: route.authed },
        {
          framework: 'http4s',
          method: route.method,
          path: route.fullPath,
          handler,
          controller: undefined,
        },
        { node_id: nodeId, method_name: handler, file: relativePath, line: route.line }
      )
    );
  }



  private nodeText(node: any): string {
    return node?.text ?? '';
  }

  private childOfType(node: any, type: string): any {
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c.type === type) return c;
    }
    return undefined;
  }


  private stringValue(node: any): string {
    return this.nodeText(node).replace(/^s?"""?|"""?$/g, '').replace(/^"|"$/g, '');
  }


  private lastIdentifier(node: any): string | undefined {
    let found: string | undefined;
    const walk = (n: any): void => {
      if (!n) return;
      if (n.type === 'identifier') found = this.nodeText(n).trim();
      for (let i = 0; i < n.namedChildCount; i++) walk(n.namedChild(i));
    };
    walk(node);
    return found;
  }


  private varExtractorName(node: any): string {
    const t = this.childOfType(node, 'type_identifier');
    const name = t ? this.nodeText(t).trim() : 'param';
    return name.replace(/Var$/, '').toLowerCase() || 'param';
  }

  private async findScalaFiles(projectPath: string): Promise<string[]> {
    const files = await glob('**/*.{scala,sc}', {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath } as AnalysisContext),
      nodir: true,
    });
    return files.map(file => path.join(projectPath, file));
  }
}
