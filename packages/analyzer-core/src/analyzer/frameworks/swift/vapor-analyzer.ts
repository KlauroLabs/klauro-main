import { AnalysisContext, BaseAnalyzer } from '../../core/base-analyzer';
import { CASContribution, CASEntryPoint, CASNode, CASEdge } from '../../../types/cas.types';
import { isAuthenticationGuardName } from '../../core/guard-classification';
import { parseWasm } from '../../core/wasm-tree-sitter';
import * as fs from 'fs-extra';
import * as path from 'path';
import { cachedGlob as glob } from '../../core/glob-cache';




























const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head']);


interface Builder {
  prefix: string[];
  authed: boolean;
}

export class VaporAnalyzer extends BaseAnalyzer {
  constructor() {
    super('vapor', 'Vapor Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {

      const pkg = path.join(projectPath, 'Package.swift');
      if (await fs.pathExists(pkg)) {
        const content = await fs.readFile(pkg, 'utf-8');
        if (/\bvapor\b/i.test(content)) return true;
      }

      for (const file of await this.findSwiftFiles(projectPath)) {
        const content = await fs.readFile(file, 'utf-8');
        if (/\bimport\s+Vapor\b/.test(content)) return true;
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
      const files = await this.findSwiftFiles(context.projectPath);
      for (const file of files) {
        const content = await fs.readFile(file, 'utf-8');
        if (!/\bimport\s+Vapor\b/.test(content) && !/\.(grouped|get|post|put|delete|patch)\s*\(/.test(content)) {
          continue;
        }
        const relativePath = path.relative(context.projectPath, file);
        await this.extractRoutes(content, relativePath, entryPoints);
      }

      return this.createContribution(nodes, edges, entryPoints, [], {
        framework_specific: {
          framework: 'vapor',
          route_count: entryPoints.filter(ep => ep.metadata?.framework === 'vapor').length,
          authenticated_route_count: entryPoints.filter(
            ep => ep.metadata?.framework === 'vapor' && ep.security?.authenticated
          ).length,
        },
      });
    } catch (error) {
      throw new Error(`Vapor analysis failed: ${(error as Error).message}`);
    }
  }

  protected getCapabilities(): string[] {
    return ['route-detection', 'route-group-prefix-resolution', 'middleware-auth-detection'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'vapor-framework';
      case 2: return 'route-groups';
      case 3: return 'handlers';
      case 4: return 'middleware';
      default: return `vapor-level-${level}`;
    }
  }












  private async extractRoutes(content: string, relativePath: string, entryPoints: CASEntryPoint[]): Promise<void> {
    const tree = await parseWasm('swift', content);
    const root = tree.rootNode;

    const builders = new Map<string, Builder>();




    builders.set('app', { prefix: [], authed: false });

    const seen = new Set<string>();

    const visit = (node: any): void => {
      if (!node) return;

      if (node.type === 'property_declaration') {
        this.handleGroupBinding(node, builders);
      } else if (node.type === 'call_expression') {
        const route = this.parseRouteCall(node, builders);
        if (route) {
          const dedupe = `${route.method}:${route.fullPath}:${route.handler}`;
          if (!seen.has(dedupe)) {
            seen.add(dedupe);
            this.emitRoute(route, relativePath, entryPoints);
          }
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







  private handleGroupBinding(node: any, builders: Map<string, Builder>): void {
    const nameNode = this.childOfType(node, 'pattern');
    const name = nameNode ? this.firstIdentifier(nameNode) : undefined;
    const valueCall = this.childOfType(node, 'call_expression');
    if (!name || !valueCall) return;

    const resolved = this.resolveGroupChain(valueCall, builders);
    if (resolved) builders.set(name, resolved);
  }






  private resolveGroupChain(callExpr: any, builders: Map<string, Builder>): Builder | null {


    const chain: Array<{ method: string; callNode: any }> = [];
    let current: any = callExpr;
    let rootReceiver: string | undefined;

    while (current && current.type === 'call_expression') {
      const nav = this.childOfType(current, 'navigation_expression');
      if (!nav) break;
      const method = this.navigationMethod(nav);
      chain.push({ method: method || '', callNode: current });


      const inner = nav.namedChild(0);
      if (inner && inner.type === 'call_expression') {
        current = inner;
      } else {
        rootReceiver = inner ? this.nodeText(inner).trim() : undefined;
        current = null;
      }
    }

    if (!rootReceiver) return null;
    const base = builders.get(rootReceiver);
    if (!base) return null;


    let prefix = [...base.prefix];
    let authed = base.authed;
    for (const link of chain.reverse()) {
      if (link.method !== 'grouped') continue;
      const args = this.callArguments(link.callNode);
      for (const arg of args) {
        const seg = this.stringLiteralValue(arg);
        if (seg !== null) {
          for (const part of seg.split('/').filter(Boolean)) prefix.push(part);
        } else if (this.argIsAuthMiddleware(arg)) {
          authed = true;
        }
      }
    }
    return { prefix, authed };
  }





  private parseRouteCall(
    callExpr: any,
    builders: Map<string, Builder>
  ): { method: string; fullPath: string; handler: string; authed: boolean; line: number } | null {
    const nav = this.childOfType(callExpr, 'navigation_expression');
    if (!nav) return null;
    const method = this.navigationMethod(nav);
    if (!method) return null;




    const receiverNode = nav.namedChild(0);
    if (!receiverNode || receiverNode.type !== 'simple_identifier') return null;
    const receiver = this.nodeText(receiverNode).trim();
    const builder = builders.get(receiver);
    if (!builder) return null;

    const args = this.callArguments(callExpr);



    let httpMethod: string | undefined;
    let argStart = 0;
    if (method === 'on') {
      const verb = this.memberAccessName(args[0]);
      if (!verb) return null;
      httpMethod = verb.toUpperCase();
      argStart = 1;
    } else if (HTTP_METHODS.has(method)) {
      httpMethod = method.toUpperCase();
    } else {
      return null;
    }


    const segments: string[] = [];
    let handler: string | undefined;
    for (let i = argStart; i < args.length; i++) {
      const arg = args[i];
      if (this.argumentLabel(arg) === 'use') {
        handler = this.useHandlerName(arg);
        continue;
      }
      const seg = this.stringLiteralValue(arg);
      if (seg !== null) {
        for (const part of seg.split('/').filter(Boolean)) segments.push(part);
      }
    }


    if (!handler) {
      const hasClosure = this.hasTrailingClosure(callExpr);
      handler = hasClosure ? 'closure' : '';
    }
    if (!handler) return null;

    const allSegments = [...builder.prefix, ...segments];
    const fullPath = '/' + allSegments.join('/');
    return {
      method: httpMethod,
      fullPath: fullPath === '/' ? '/' : fullPath.replace(/\/+/g, '/'),
      handler,
      authed: builder.authed,
      line: callExpr.startPosition.row + 1,
    };
  }

  private emitRoute(
    route: { method: string; fullPath: string; handler: string; authed: boolean; line: number },
    relativePath: string,
    entryPoints: CASEntryPoint[]
  ): void {
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
          framework: 'vapor',
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
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c.type === type) return c;
    }
    return undefined;
  }


  private navigationMethod(nav: any): string | undefined {
    const suffix = this.childOfType(nav, 'navigation_suffix');
    if (!suffix) return undefined;
    const id = this.childOfType(suffix, 'simple_identifier');
    return id ? this.nodeText(id).trim() : this.nodeText(suffix).replace(/^\./, '').trim();
  }


  private callArguments(callExpr: any): any[] {
    const suffix = this.childOfType(callExpr, 'call_suffix');
    if (!suffix) return [];
    const valueArgs = this.childOfType(suffix, 'value_arguments');
    if (!valueArgs) return [];
    const out: any[] = [];
    for (let i = 0; i < valueArgs.namedChildCount; i++) {
      const c = valueArgs.namedChild(i);
      if (c.type === 'value_argument') out.push(c);
    }
    return out;
  }


  private hasTrailingClosure(callExpr: any): boolean {
    const suffix = this.childOfType(callExpr, 'call_suffix');
    if (suffix && this.childOfType(suffix, 'lambda_literal')) return true;

    return Boolean(this.childOfType(callExpr, 'lambda_literal'));
  }


  private argumentLabel(arg: any): string | undefined {
    const label = this.childOfType(arg, 'value_argument_label');
    if (!label) return undefined;
    const id = this.childOfType(label, 'simple_identifier');
    return id ? this.nodeText(id).trim() : this.nodeText(label).trim();
  }


  private stringLiteralValue(arg: any): string | null {
    const lit = this.childOfType(arg, 'line_string_literal');
    if (!lit) return null;
    const text = this.childOfType(lit, 'line_str_text');
    if (text) return this.nodeText(text);

    return this.nodeText(lit).replace(/^"|"$/g, '');
  }


  private memberAccessName(arg: any): string | undefined {
    if (!arg) return undefined;
    const prefix = this.childOfType(arg, 'prefix_expression');
    if (prefix) {
      const id = this.childOfType(prefix, 'simple_identifier');
      if (id) return this.nodeText(id).trim();
    }
    return undefined;
  }


  private useHandlerName(arg: any): string | undefined {


    for (let i = 0; i < arg.namedChildCount; i++) {
      const c = arg.namedChild(i);
      if (c.type === 'value_argument_label') continue;
      if (c.type === 'simple_identifier') return this.nodeText(c).trim();
      if (c.type === 'navigation_expression') {

        const m = this.navigationMethod(c);
        if (m) return m;
        return this.nodeText(c).trim();
      }
    }
    return undefined;
  }


  private firstIdentifier(node: any): string | undefined {
    if (node.type === 'simple_identifier') return this.nodeText(node).trim();
    for (let i = 0; i < node.namedChildCount; i++) {
      const found = this.firstIdentifier(node.namedChild(i));
      if (found) return found;
    }
    return undefined;
  }


  private argIsAuthMiddleware(arg: any): boolean {
    const text = this.nodeText(arg);


    if (isAuthenticationGuardName(text)) return true;
    if (/authenticat|guardmiddleware|bearer|\.sessions\b|basicauth/i.test(text)) return true;
    return false;
  }

  private async findSwiftFiles(projectPath: string): Promise<string[]> {
    const files = await glob('**/*.swift', {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath } as AnalysisContext),
      nodir: true,
    });
    return files.map(file => path.join(projectPath, file));
  }
}
