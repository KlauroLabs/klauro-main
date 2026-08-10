import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, FileAnalysisResult
} from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import { parseWasm, hasWasmGrammar } from '../../core/wasm-tree-sitter';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';
import * as path from 'path';

/**
 * Jetpack Compose framework analyzer (Kotlin UI).
 *
 * Emits the Compose UI component tree as `renders` edges: `Parent renders Child`
 * between two `@Composable fun` declarations, where the parent's body contains a
 * call to the child composable. Each composable becomes one `component` node with
 * a `prop_count` (declared parameter count).
 *
 * A structural graph sees a `@Composable fun` as an ordinary function and a
 * `UserCard(user)` call as, at best, a same-file call edge. It cannot say
 * "App RENDERS UserList" nor that a composable takes N props. This analyzer
 * models exactly that UI fact, mirroring the JS component-tree analyzers
 * (react/vue/svelte/…) but for Kotlin/Compose.
 *
 * Grounded on the real vendored tree-sitter-kotlin AST:
 *   function_declaration
 *     modifiers → annotation → user_type → type_identifier "Composable"
 *     simple_identifier <fn name>
 *     function_value_parameters → parameter*        (prop_count)
 *     function_body → statements → call_expression
 *                                    child(0) simple_identifier <callee>
 *
 * A call is a `renders` edge ONLY when its callee resolves to another declared
 * `@Composable` function across the analyzed sources (two-pass). Built-in-looking
 * Capitalized calls (`Text`, `Row`, `Column`) and control flow (`for`) are NOT
 * calls to declared composables, so they never produce a render edge — precision
 * is preserved.
 */

const KOTLIN_GLOBS = ['**/*.kt'];

interface ComposableFn {
  name: string;
  relativePath: string;
  fullPath: string;
  lineStart: number;   // 1-based
  lineEnd: number;     // 1-based
  propCount: number;
  nodeId: string;
  /** Callee names invoked in this composable's body (raw, unresolved). */
  calls: Array<{ callee: string; line: number }>;
}

export class ComposeAnalyzer extends BaseAnalyzer {
  constructor() {
    super('jetpack-compose', 'Jetpack Compose Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const files = await glob(KOTLIN_GLOBS, {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath } as AnalysisContext),
        nodir: true,
      });
      for (const rel of files) {
        const content = await fs.readFile(path.join(projectPath, rel), 'utf-8').catch(() => '');
        if (/@Composable/.test(content)) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  supportsIncrementalAnalysis(): boolean {
    // Renders edges are cross-file (a parent may render a child declared in
    // another file), so a single-file pass cannot resolve the tree reliably.
    return false;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    const files = await glob(KOTLIN_GLOBS, {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath } as AnalysisContext),
      nodir: true,
    });
    return files.sort();
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    // Compose trees are cross-file; a single-file result can only emit the
    // component nodes it declares (no renders edges resolved here). Kept for
    // interface compatibility.
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const content = await fs.readFile(context.filePath, 'utf-8');
    const stat = await fs.stat(context.filePath);

    if (/@Composable/.test(content)) {
      const fns = await this.parseComposables(context.relativePath, context.filePath, content);
      for (const fn of fns) nodes.push(this.buildComponentNode(fn));
    }

    return this.createFileAnalysisResult(
      context.filePath,
      context.relativePath,
      context.contentHash || this.computeContentHash(content),
      stat.mtimeMs,
      nodes,
      edges,
      entryPoints,
      exitPoints,
      [],
      nodes.map(n => n.name)
    );
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    this.resetAnalysisWarnings();
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    try {
      let kotlinFiles = await glob(KOTLIN_GLOBS, {
        cwd: context.projectPath,
        ignore: this.getIgnorePatterns(context),
        nodir: true,
      });
      kotlinFiles.sort();
      kotlinFiles = this.capAndPrioritizeSourceFiles(kotlinFiles, 'kotlin compose files');

      // Pass 1: collect every declared @Composable function across all files.
      const composables: ComposableFn[] = [];
      for (const relativePath of kotlinFiles) {
        const fullPath = path.join(context.projectPath, relativePath);
        let content = '';
        try {
          content = await fs.readFile(fullPath, 'utf-8');
        } catch {
          continue;
        }
        if (!/@Composable/.test(content)) continue;
        composables.push(...(await this.parseComposables(relativePath, fullPath, content)));
      }

      // Build the resolution table: composable name → node id.
      // (Compose functions are UpperCamelCase and unique by convention; on a
      //  name collision the first declaration wins for resolution.)
      const nameToId = new Map<string, string>();
      for (const fn of composables) {
        if (!nameToId.has(fn.name)) nameToId.set(fn.name, fn.nodeId);
      }

      // Emit one component node per composable.
      for (const fn of composables) {
        nodes.push(this.buildComponentNode(fn));
      }

      // Pass 2: resolve calls → renders edges (only to declared composables).
      const edgeIds = new Set<string>();
      for (const fn of composables) {
        for (const call of fn.calls) {
          const childId = nameToId.get(call.callee);
          if (!childId) continue;               // not a declared composable → skip (Text/Row/for)
          if (childId === fn.nodeId) continue;   // ignore self-recursion
          const edgeId = `compose_renders_${fn.nodeId}_to_${childId}_${call.line}`;
          if (edgeIds.has(edgeId)) continue;
          edgeIds.add(edgeId);
          edges.push(this.createEdge(edgeId, fn.nodeId, childId, 'renders', 'behavior', {
            prop_count: fn.propCount,
            attributes: {
              framework: 'jetpack-compose',
              parent: fn.name,
              child: call.callee,
              line: call.line,
              language: 'kotlin',
            },
          }));
        }
      }

      // Entry points: a composable is a user-reachable screen — not merely an
      // internal building block — when nothing else in the analyzed sources
      // renders it. That is graph topology, not a name/keyword guess: the
      // root(s) of the renders forest are exactly the destinations a user can
      // land on (MainActivity's setContent { Root() }, a NavHost start
      // destination, or any other composable no sibling calls). Without this,
      // a pure-Compose UI has zero outward-face evidence for downstream
      // capability generation to start from.
      const rendered = new Set<string>();
      for (const fn of composables) {
        for (const call of fn.calls) {
          const childId = nameToId.get(call.callee);
          if (childId && childId !== fn.nodeId) rendered.add(childId);
        }
      }
      for (const fn of composables) {
        if (rendered.has(fn.nodeId)) continue;
        entryPoints.push(
          this.createEntryPoint(
            `compose_entry_${fn.nodeId}`,
            fn.nodeId,
            'page',
            fn.name,
            `Jetpack Compose screen: @Composable fun ${fn.name}() is not rendered by any other composable in this codebase, so it is a user-reachable entry into the UI.`,
            { pattern: fn.name },
            undefined,
            { framework: 'jetpack-compose', file: fn.relativePath, line: fn.lineStart }
          )
        );
      }

      const warnings = this.collectAnalysisWarnings();
      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        ...(warnings.length > 0 ? { warnings } : {}),
        framework: 'jetpack-compose',
        framework_specific: {
          framework: 'jetpack-compose',
          composables: composables.length,
          renders: edges.length,
        },
      });
    } catch (error) {
      throw new AnalyzerError(
        `Jetpack Compose analysis failed: ${(error as Error).message}`,
        'COMPOSE_ANALYSIS_ERROR'
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Parsing (tree-sitter-kotlin AST)
  // ---------------------------------------------------------------------------

  /**
   * Walk the Kotlin AST for a file and extract every `@Composable fun` with its
   * declared parameter count and the callee names invoked in its body.
   */
  private async parseComposables(
    relativePath: string,
    fullPath: string,
    content: string
  ): Promise<ComposableFn[]> {
    if (!hasWasmGrammar('kotlin')) {
      this.addAnalysisWarning('kotlin wasm grammar unavailable; skipping Compose analysis');
      return [];
    }
    let tree: any;
    try {
      tree = await parseWasm('kotlin', content);
    } catch (e) {
      this.addAnalysisWarning(`kotlin parse failed for ${relativePath}: ${(e as Error).message}`);
      return [];
    }

    const out: ComposableFn[] = [];
    const walk = (n: any): void => {
      if (n.type === 'function_declaration' && this.isComposable(n)) {
        const name = this.functionName(n);
        if (name) {
          const lineStart = n.startPosition.row + 1;
          const lineEnd = n.endPosition.row + 1;
          out.push({
            name,
            relativePath,
            fullPath,
            lineStart,
            lineEnd,
            propCount: this.parameterCount(n),
            nodeId: this.componentId(relativePath, name, lineStart),
            calls: this.bodyCalls(n),
          });
        }
      }
      for (let i = 0; i < n.childCount; i++) walk(n.child(i));
    };
    walk(tree.rootNode);
    return out;
  }

  /** function_declaration has a @Composable annotation in its `modifiers`. */
  private isComposable(fnNode: any): boolean {
    for (let i = 0; i < fnNode.childCount; i++) {
      const child = fnNode.child(i);
      if (child.type !== 'modifiers') continue;
      for (let j = 0; j < child.childCount; j++) {
        const ann = child.child(j);
        if (ann.type !== 'annotation') continue;
        // annotation → user_type → type_identifier "Composable"
        // (walk descendants to tolerate annotation-use-site targets / nesting)
        let found = false;
        const scan = (n: any): void => {
          if (found) return;
          if (n.type === 'type_identifier' && n.text === 'Composable') { found = true; return; }
          for (let k = 0; k < n.childCount; k++) scan(n.child(k));
        };
        scan(ann);
        if (found) return true;
      }
    }
    return false;
  }

  /** The function name: the `simple_identifier` direct child of function_declaration. */
  private functionName(fnNode: any): string | undefined {
    for (let i = 0; i < fnNode.childCount; i++) {
      const child = fnNode.child(i);
      if (child.type === 'simple_identifier') return child.text;
    }
    return undefined;
  }

  /** Count of declared parameters (function_value_parameters → parameter*). */
  private parameterCount(fnNode: any): number {
    for (let i = 0; i < fnNode.childCount; i++) {
      const child = fnNode.child(i);
      if (child.type !== 'function_value_parameters') continue;
      let count = 0;
      for (let j = 0; j < child.childCount; j++) {
        if (child.child(j).type === 'parameter') count++;
      }
      return count;
    }
    return 0;
  }

  /**
   * All callee names invoked in the function body. The callee is child(0) of a
   * call_expression: a `simple_identifier` for `Child(...)`. Navigation calls
   * (`obj.method()`) are intentionally ignored — a rendered child composable is
   * invoked by bare name, not through a receiver.
   */
  private bodyCalls(fnNode: any): Array<{ callee: string; line: number }> {
    const calls: Array<{ callee: string; line: number }> = [];
    let body: any;
    for (let i = 0; i < fnNode.childCount; i++) {
      if (fnNode.child(i).type === 'function_body') { body = fnNode.child(i); break; }
    }
    if (!body) return calls;

    const walk = (n: any): void => {
      // Do not descend into a nested composable-lambda's own function_declaration;
      // grammar keeps nested lambdas as lambda_literal, not function_declaration,
      // so this is a defensive guard only.
      if (n.type === 'call_expression') {
        const head = n.child(0);
        if (head && head.type === 'simple_identifier') {
          calls.push({ callee: head.text, line: n.startPosition.row + 1 });
        }
      }
      for (let i = 0; i < n.childCount; i++) walk(n.child(i));
    };
    walk(body);
    return calls;
  }

  // ---------------------------------------------------------------------------
  // Emission
  // ---------------------------------------------------------------------------

  private buildComponentNode(fn: ComposableFn): CASNode {
    return this.createNodeBuilder(fn.nodeId, fn.name, 'component')
      .withLevel(1, 'compose-components')
      .withCategory('component', ['ui', 'framework', 'jetpack-compose'])
      .withSource({ file: fn.fullPath, line: fn.lineStart, end_line: fn.lineEnd })
      .withDescription(`Jetpack Compose composable: @Composable fun ${fn.name}() (${fn.propCount} prop${fn.propCount === 1 ? '' : 's'})`)
      .withMetadata({
        framework: 'jetpack-compose',
        attributes: {
          composable: fn.name,
          prop_count: fn.propCount,
          file: fn.relativePath,
        },
      })
      .withTags(['compose-component', 'compose-fn'])
      .build();
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private componentId(relativePath: string, name: string, line: number): string {
    return `compose_component_${this.sanitizeId(relativePath)}_${this.sanitizeId(name)}_${line}`;
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'compose-components';
      default: return `compose-level-${level}`;
    }
  }

  protected getCapabilities(): string[] {
    return ['compose-components', 'compose-render-tree', 'compose-props'];
  }
}

export default { ComposeAnalyzer };
