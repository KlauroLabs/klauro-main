import { AnalysisContext, BaseAnalyzer } from '../../core/base-analyzer';
import { CASContribution, CASEntryPoint, CASNode, CASEdge } from '../../../types/cas.types';
import { parseWasm } from '../../core/wasm-tree-sitter';
import * as fs from 'fs-extra';
import * as path from 'path';
import { glob } from 'glob';

/**
 * Salesforce Apex REST framework analyzer.
 *
 * Apex exposes custom REST endpoints by annotating a class with
 * `@RestResource(urlMapping='/users/*')` and its static methods with one of the
 * HTTP-verb annotations:
 *
 *   @RestResource(urlMapping='/users/*')
 *   global with sharing class UserResource {
 *       @HttpGet    global static User    doGet()      { ... }   // GET    /users
 *       @HttpPost   global static void    doPost(...)  { ... }   // POST   /users
 *       @HttpPut    global static void    doPut(...)   { ... }   // PUT    /users
 *       @HttpPatch  global static void    doPatch(...) { ... }   // PATCH  /users
 *       @HttpDelete global static void    doDelete()   { ... }   // DELETE /users
 *   }
 *
 * The route PATH is the class's `urlMapping` with a trailing `/*` wildcard stripped
 * (`/users/*` -> `/users`). Apex routes the *whole* sub-path under that base to the
 * one class; the individual record id comes from `RestContext.request.requestURI`
 * at runtime, NOT from a declared path param, so the declared route path is just the
 * base urlMapping. Multiple verbs on the same class correctly map to the same path
 * (it is a REST *resource*).
 *
 * Auth: Apex REST requires an authenticated Salesforce session (OAuth/session id)
 * enforced by the platform, plus the calling user's profile/permission-set access to
 * the class. That guard is implicit and out-of-band — it is NOT expressed in the
 * source. We therefore emit `authenticated:false` honestly unless an explicit
 * per-method in-source guard is present, and document the platform auth in metadata.
 *
 * Node types grounded on the real vendored tree-sitter-apex grammar:
 *   class_declaration
 *     modifiers
 *       annotation              identifier="RestResource"
 *         annotation_argument_list
 *           annotation_key_value  identifier="urlMapping" string_literal="'/users/*'"
 *     identifier                "UserResource"
 *     class_body
 *       method_declaration
 *         modifiers
 *           annotation          identifier="HttpGet" | "HttpPost" | ...
 *         identifier            "doGet"   (the handler method name)
 */

/** @Http<Verb> annotation identifier -> HTTP method. */
const HTTP_VERB_ANNOTATIONS: Record<string, string> = {
  HttpGet: 'GET',
  HttpPost: 'POST',
  HttpPut: 'PUT',
  HttpPatch: 'PATCH',
  HttpDelete: 'DELETE',
};

export class ApexRestAnalyzer extends BaseAnalyzer {
  constructor() {
    super('apexrest', 'Apex REST Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      for (const file of await this.findApexFiles(projectPath)) {
        const content = await fs.readFile(file, 'utf-8');
        if (/@RestResource\b/.test(content)) return true;
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
      const files = await this.findApexFiles(context.projectPath);
      for (const file of files) {
        const content = await fs.readFile(file, 'utf-8');
        if (!/@RestResource\b/.test(content)) continue;
        const relativePath = path.relative(context.projectPath, file);
        await this.extractRoutes(content, relativePath, entryPoints);
      }

      return this.createContribution(nodes, edges, entryPoints, [], {
        framework_specific: {
          framework: 'apex-rest',
          route_count: entryPoints.filter(ep => ep.metadata?.framework === 'apex-rest').length,
          authenticated_route_count: entryPoints.filter(
            ep => ep.metadata?.framework === 'apex-rest' && ep.security?.authenticated
          ).length,
        },
      });
    } catch (error) {
      throw new Error(`Apex REST analysis failed: ${(error as Error).message}`);
    }
  }

  protected getCapabilities(): string[] {
    return ['route-detection', 'rest-resource-url-mapping', 'http-verb-annotation-detection'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'apex-rest-framework';
      case 2: return 'rest-resources';
      case 3: return 'verb-handlers';
      default: return `apex-rest-level-${level}`;
    }
  }

  /**
   * Parse one Apex source and emit an http entry point per annotated verb method on
   * each `@RestResource` class. Single document-order walk: find class_declarations
   * carrying a `@RestResource(urlMapping=...)`, read the urlMapping-derived base path,
   * then emit a route for each method_declaration carrying an `@Http<Verb>`.
   */
  private async extractRoutes(content: string, relativePath: string, entryPoints: CASEntryPoint[]): Promise<void> {
    const tree = await parseWasm('apex', content);
    const root = tree.rootNode;
    const seen = new Set<string>();

    const visit = (node: any): void => {
      if (!node) return;
      if (node.type === 'class_declaration') {
        this.handleClass(node, relativePath, entryPoints, seen);
      }
      for (let i = 0; i < node.namedChildCount; i++) {
        visit(node.namedChild(i));
      }
    };
    visit(root);
  }

  private handleClass(
    classNode: any,
    relativePath: string,
    entryPoints: CASEntryPoint[],
    seen: Set<string>
  ): void {
    const modifiers = this.childOfType(classNode, 'modifiers');
    if (!modifiers) return;

    const restAnnotation = this.findAnnotation(modifiers, 'RestResource');
    if (!restAnnotation) return;

    const urlMapping = this.readUrlMapping(restAnnotation);
    if (urlMapping === null) return;

    const routePath = this.normalizeUrlMapping(urlMapping);

    const body = this.childOfType(classNode, 'class_body');
    if (!body) return;

    for (let i = 0; i < body.namedChildCount; i++) {
      const member = body.namedChild(i);
      if (member.type !== 'method_declaration') continue;
      const methodMods = this.childOfType(member, 'modifiers');
      if (!methodMods) continue;

      const method = this.httpMethodFromMethodAnnotations(methodMods);
      if (!method) continue;

      const handler = this.methodName(member);
      if (!handler) continue;

      const dedupe = `${method}:${routePath}:${handler}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);

      this.emitRoute(
        { method, path: routePath, handler, line: member.startPosition.row + 1 },
        relativePath,
        entryPoints
      );
    }
  }

  /**
   * Strip a trailing `/*` wildcard from an Apex urlMapping and normalize slashes.
   * `'/users/*'` -> `/users`, `'/accounts'` -> `/accounts`, `'/'` -> `/`.
   */
  private normalizeUrlMapping(urlMapping: string): string {
    let p = urlMapping.trim();
    p = p.replace(/\/\*+$/, '');
    if (!p.startsWith('/')) p = '/' + p;
    p = p.replace(/\/+/g, '/');
    if (p.length > 1) p = p.replace(/\/$/, '');
    return p === '' ? '/' : p;
  }

  private emitRoute(
    route: { method: string; path: string; handler: string; line: number },
    relativePath: string,
    entryPoints: CASEntryPoint[]
  ): void {
    const nodeId = `function:${relativePath}:${route.handler}`;
    entryPoints.push(
      this.createEntryPoint(
        `entry:http:${relativePath}:${route.handler}:${route.method}:${route.path}`,
        nodeId,
        'http',
        `${route.method} ${route.path}`,
        `Apex REST endpoint handled by ${route.handler}`,
        { method: route.method, path: route.path },
        // Apex platform session/OAuth + profile access is implicit & out-of-band, not
        // expressed in source. Honest default: not an in-source per-method guard.
        { authenticated: false },
        {
          framework: 'apex-rest',
          method: route.method,
          path: route.path,
          handler: route.handler,
          platform_auth: 'salesforce-session-implicit',
        },
        { node_id: nodeId, method_name: route.handler, file: relativePath, line: route.line }
      )
    );
  }

  // ---- AST helpers (grounded on tree-sitter-apex) -------------------------------

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

  /** Find an `annotation` child of `modifiers` whose identifier matches `name`. */
  private findAnnotation(modifiers: any, name: string): any {
    for (let i = 0; i < modifiers.namedChildCount; i++) {
      const c = modifiers.namedChild(i);
      if (c.type !== 'annotation') continue;
      const id = this.childOfType(c, 'identifier');
      if (id && this.nodeText(id).trim() === name) return c;
    }
    return undefined;
  }

  /**
   * Read the `urlMapping='...'` value from a `@RestResource(...)` annotation.
   * annotation > annotation_argument_list > annotation_key_value(identifier,string_literal).
   * Returns the unquoted string, or null when absent.
   */
  private readUrlMapping(annotation: any): string | null {
    const argList = this.childOfType(annotation, 'annotation_argument_list');
    if (!argList) return null;
    for (let i = 0; i < argList.namedChildCount; i++) {
      const kv = argList.namedChild(i);
      if (kv.type !== 'annotation_key_value') continue;
      const key = this.childOfType(kv, 'identifier');
      if (!key || this.nodeText(key).trim() !== 'urlMapping') continue;
      const lit = this.childOfType(kv, 'string_literal');
      if (!lit) return null;
      return this.unquote(this.nodeText(lit));
    }
    return null;
  }

  /** Scan a method's `modifiers` for an `@Http<Verb>` annotation -> HTTP method. */
  private httpMethodFromMethodAnnotations(modifiers: any): string | undefined {
    for (let i = 0; i < modifiers.namedChildCount; i++) {
      const c = modifiers.namedChild(i);
      if (c.type !== 'annotation') continue;
      const id = this.childOfType(c, 'identifier');
      if (!id) continue;
      const verb = HTTP_VERB_ANNOTATIONS[this.nodeText(id).trim()];
      if (verb) return verb;
    }
    return undefined;
  }

  /** The method name: the `identifier` child of a method_declaration. */
  private methodName(method: any): string | undefined {
    const id = this.childOfType(method, 'identifier');
    return id ? this.nodeText(id).trim() : undefined;
  }

  /** Strip surrounding single or double quotes from an Apex string literal. */
  private unquote(text: string): string {
    return text.replace(/^['"]|['"]$/g, '');
  }

  private async findApexFiles(projectPath: string): Promise<string[]> {
    const files = await glob('**/*.{cls,trigger}', {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath } as AnalysisContext),
      nodir: true,
    });
    return files.map(file => path.join(projectPath, file));
  }
}
