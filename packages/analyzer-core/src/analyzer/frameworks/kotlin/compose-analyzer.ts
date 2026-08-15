import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, FileAnalysisResult
} from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import { parseWasm, hasWasmGrammar } from '../../core/wasm-tree-sitter';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';
import * as path from 'path';






























const KOTLIN_GLOBS = ['**/*.kt'];

interface ComposableFn {
  name: string;
  relativePath: string;
  fullPath: string;
  lineStart: number;
  lineEnd: number;
  propCount: number;
  nodeId: string;

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




      const nameToId = new Map<string, string>();
      for (const fn of composables) {
        if (!nameToId.has(fn.name)) nameToId.set(fn.name, fn.nodeId);
      }


      for (const fn of composables) {
        nodes.push(this.buildComponentNode(fn));
      }


      const edgeIds = new Set<string>();
      for (const fn of composables) {
        for (const call of fn.calls) {
          const childId = nameToId.get(call.callee);
          if (!childId) continue;
          if (childId === fn.nodeId) continue;
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
    try {
      walk(tree.rootNode);
      return out;
    } finally {
      tree.delete?.();
    }
  }


  private isComposable(fnNode: any): boolean {
    for (let i = 0; i < fnNode.childCount; i++) {
      const child = fnNode.child(i);
      if (child.type !== 'modifiers') continue;
      for (let j = 0; j < child.childCount; j++) {
        const ann = child.child(j);
        if (ann.type !== 'annotation') continue;


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


  private functionName(fnNode: any): string | undefined {
    for (let i = 0; i < fnNode.childCount; i++) {
      const child = fnNode.child(i);
      if (child.type === 'simple_identifier') return child.text;
    }
    return undefined;
  }


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







  private bodyCalls(fnNode: any): Array<{ callee: string; line: number }> {
    const calls: Array<{ callee: string; line: number }> = [];
    let body: any;
    for (let i = 0; i < fnNode.childCount; i++) {
      if (fnNode.child(i).type === 'function_body') { body = fnNode.child(i); break; }
    }
    if (!body) return calls;

    const walk = (n: any): void => {



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
