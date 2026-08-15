import { AnalysisContext, BaseAnalyzer } from '../../core/base-analyzer';
import { CASContribution, CASEntryPoint, CASNode, CASEdge } from '../../../types/cas.types';
import { parseWasm } from '../../core/wasm-tree-sitter';
import * as fs from 'fs-extra';
import * as path from 'path';
import { cachedGlob as glob } from '../../core/glob-cache';








































const MACRO_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

interface GenieRoute {
  method: string;
  fullPath: string;
  handler: string;
  authed: boolean;
  line: number;
}

export class GenieAnalyzer extends BaseAnalyzer {
  constructor() {
    super('genie', 'Genie Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {


      const proj = path.join(projectPath, 'Project.toml');
      if (await fs.pathExists(proj)) {
        const content = await fs.readFile(proj, 'utf-8');
        if (/\bGenie\b/.test(content)) return true;
      }

      for (const file of await this.findJuliaFiles(projectPath)) {
        const content = await fs.readFile(file, 'utf-8');
        if (/\bGenie\b/.test(content) && /\broute\s*\(|@(get|post|put|patch|delete)\s*\(/.test(content)) {
          return true;
        }
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
      const files = await this.findJuliaFiles(context.projectPath);
      for (const file of files) {
        const content = await fs.readFile(file, 'utf-8');
        if (!/\broute\s*\(/.test(content) && !/@(get|post|put|patch|delete|head|options)\s*\(/.test(content)) {
          continue;
        }
        const relativePath = path.relative(context.projectPath, file);
        await this.extractRoutes(content, relativePath, entryPoints);
      }

      return this.createContribution(nodes, edges, entryPoints, [], {
        framework_specific: {
          framework: 'genie',
          route_count: entryPoints.filter(ep => ep.metadata?.framework === 'genie').length,
          authenticated_route_count: entryPoints.filter(
            ep => ep.metadata?.framework === 'genie' && ep.security?.authenticated
          ).length,
        },
      });
    } catch (error) {
      throw new Error(`Genie analysis failed: ${(error as Error).message}`);
    }
  }

  protected getCapabilities(): string[] {
    return ['route-detection', 'method-keyword-resolution', 'macro-route-detection'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'genie-framework';
      case 2: return 'routes';
      case 3: return 'handlers';
      case 4: return 'middleware';
      default: return `genie-level-${level}`;
    }
  }







  private async extractRoutes(content: string, relativePath: string, entryPoints: CASEntryPoint[]): Promise<void> {
    const tree = await parseWasm('julia', content);
    const root = tree.rootNode;
    const seen = new Set<string>();

    const visit = (node: any): void => {
      if (!node) return;

      let route: GenieRoute | null = null;
      if (node.type === 'call_expression') {
        route = this.parseRouteCall(node);
      } else if (node.type === 'macrocall_expression') {
        route = this.parseMacroCall(node);
      }
      if (route) {
        const dedupe = `${route.method}:${route.fullPath}:${route.handler}`;
        if (!seen.has(dedupe)) {
          seen.add(dedupe);
          this.emitRoute(route, relativePath, entryPoints);
        }
      }

      for (let i = 0; i < node.namedChildCount; i++) visit(node.namedChild(i));
    };

    try {
      visit(root);
    } finally {
      tree.delete?.();
    }
  }


  private parseRouteCall(callExpr: any): GenieRoute | null {
    const callee = callExpr.namedChild(0);
    if (!callee || callee.type !== 'identifier' || this.nodeText(callee).trim() !== 'route') return null;

    const argList = this.childOfType(callExpr, 'argument_list');
    if (!argList) return null;

    const path = this.firstStringArg(argList);
    if (path === null) return null;

    const method = this.methodKeyword(argList) || 'GET';
    const handler = this.positionalHandler(argList) || (this.childOfType(callExpr, 'do_clause') ? 'closure' : '');
    if (!handler) return null;

    return {
      method,
      fullPath: this.normalizePath(path),
      handler,
      authed: false,
      line: callExpr.startPosition.row + 1,
    };
  }


  private parseMacroCall(macroExpr: any): GenieRoute | null {
    const macroId = this.childOfType(macroExpr, 'macro_identifier');
    if (!macroId) return null;

    const verbId = this.childOfType(macroId, 'identifier');
    const verb = (verbId ? this.nodeText(verbId) : this.nodeText(macroId).replace(/^@/, '')).trim().toLowerCase();
    if (!MACRO_METHODS.has(verb)) return null;

    const argList = this.childOfType(macroExpr, 'argument_list');
    if (!argList) return null;

    const path = this.firstStringArg(argList);
    if (path === null) return null;

    const handler = this.positionalHandler(argList) || 'closure';

    return {
      method: verb.toUpperCase(),
      fullPath: this.normalizePath(path),
      handler,
      authed: false,
      line: macroExpr.startPosition.row + 1,
    };
  }

  private emitRoute(route: GenieRoute, relativePath: string, entryPoints: CASEntryPoint[]): void {
    const nodeId = `function:${relativePath}:${route.handler}`;
    entryPoints.push(
      this.createEntryPoint(
        `entry:http:${relativePath}:${route.handler}:${route.method}:${route.fullPath}`,
        nodeId,
        'http',
        `${route.method} ${route.fullPath}`,
        `HTTP route handled by ${route.handler}`,
        { method: route.method, path: route.fullPath },
        { authenticated: route.authed },
        {
          framework: 'genie',
          method: route.method,
          path: route.fullPath,
          handler: route.handler,
          controller: undefined,
        },
        { node_id: nodeId, method_name: route.handler, file: relativePath, line: route.line }
      )
    );
  }



  private nodeText(node: any): string {
    return node?.text ?? '';
  }

  private childOfType(node: any, type: string): any {
    if (!node) return undefined;
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c.type === type) return c;
    }
    return undefined;
  }


  private firstStringArg(argList: any): string | null {
    for (let i = 0; i < argList.namedChildCount; i++) {
      const c = argList.namedChild(i);
      if (c.type === 'string_literal') return this.stringLiteralValue(c);
    }
    return null;
  }


  private positionalHandler(argList: any): string | undefined {
    let seenString = false;
    for (let i = 0; i < argList.namedChildCount; i++) {
      const c = argList.namedChild(i);
      if (c.type === 'string_literal') { seenString = true; continue; }
      if (!seenString) continue;
      if (c.type === 'named_argument') continue;
      if (c.type === 'do_clause') continue;
      if (c.type === 'identifier') return this.nodeText(c).trim();

      if (c.type === 'field_expression') return this.nodeText(c).trim();
    }
    return undefined;
  }


  private methodKeyword(argList: any): string | undefined {
    for (let i = 0; i < argList.namedChildCount; i++) {
      const c = argList.namedChild(i);
      if (c.type !== 'named_argument') continue;
      const key = this.childOfType(c, 'identifier');
      if (!key || this.nodeText(key).trim() !== 'method') continue;

      let value: string | undefined;
      for (let j = 0; j < c.namedChildCount; j++) {
        const v = c.namedChild(j);
        if (v.type === 'identifier' && this.nodeText(v).trim() !== 'method') value = this.nodeText(v).trim();
        if (v.type === 'string_literal') value = this.stringLiteralValue(v) ?? value;
      }
      if (value) return value.toUpperCase();
    }
    return undefined;
  }


  private stringLiteralValue(lit: any): string {
    const content = this.childOfType(lit, 'content');
    if (content) return this.nodeText(content);
    return this.nodeText(lit).replace(/^"|"$/g, '');
  }

  private normalizePath(p: string): string {
    const trimmed = p.trim();
    const withSlash = trimmed.startsWith('/') ? trimmed : '/' + trimmed;
    const collapsed = withSlash.replace(/\/+/g, '/');
    if (collapsed.length > 1) return collapsed.replace(/\/$/, '');
    return collapsed;
  }

  private async findJuliaFiles(projectPath: string): Promise<string[]> {
    const files = await glob('**/*.jl', {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath } as AnalysisContext),
      nodir: true,
    });
    return files.map(file => path.join(projectPath, file));
  }
}
