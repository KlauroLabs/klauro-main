/**
 * Generic tree-sitter LANGUAGE analyzer — the breadth engine, wired into the real
 * orchestrator pipeline (not just benchmarks).
 *
 * Any grammar that has a `LanguageSpec` and a vendored tree-sitter grammar gets
 * structural coverage — file, function, class, import nodes + contains/imports/calls
 * edges — the moment its extension is registered, with NO bespoke analyzer. The deep
 * analyzers (typescript, python, go, rust, c/cpp, swift, …) keep ownership of their
 * languages; this is the FALLBACK for everything else (zig, haskell, lua, ocaml,
 * erlang, clojure, julia, nim, fortran, …). Breadth parity; the deterministic layer
 * (capabilities/domains/call-chains) then runs on the graph it produces, so "deep"
 * is universal once a graph exists.
 */

import { BaseAnalyzer, AnalysisContext } from '../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint } from '../../types/cas.types';
import { extractStructure } from '../core/generic-tree-sitter-analyzer';
import { LANGUAGE_SPECS } from '../core/language-spec';
import { LANGUAGE_REGISTRY } from '../core/language-registry';
import { LanguageAnalyzers } from './index';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../core/glob-cache';
import * as path from 'path';

/**
 * Map of file extension (with leading dot, lowercase) -> grammar id, for every
 * registered language that (a) has a tree-sitter LanguageSpec and (b) is NOT owned
 * by a deep analyzer. Built lazily from the single source of truth (the registry +
 * the spec table), so adding a grammar/spec or a deep analyzer needs no edit here.
 * Lazy so the `LanguageAnalyzers` live binding is resolved (circular import safe).
 */
let extToGrammar: Map<string, string> | null = null;
function extensionToGrammar(): Map<string, string> {
  if (extToGrammar) return extToGrammar;
  const deepLangIds = new Set<string>(Object.keys(LanguageAnalyzers));
  const map = new Map<string, string>();
  for (const entry of LANGUAGE_REGISTRY) {
    const grammar = entry.id;
    if (deepLangIds.has(grammar)) continue;          // deep analyzer owns it
    if (!LANGUAGE_SPECS[grammar]) continue;          // no breadth spec -> can't walk it
    for (const ext of entry.extensions) {
      map.set(`.${ext.toLowerCase()}`, grammar);
    }
  }
  extToGrammar = map;
  return map;
}

interface BreadthFile {
  relativePath: string;
  fullPath: string;
  grammar: string;
}

interface FuncDecl {
  name: string;
  line: number;
  id: string;
  relativePath: string;
}

// Hard ceiling on files walked per analysis (the walker parses each file).
const MAX_BREADTH_FILES = 4000;

export class GenericTreeSitterLanguageAnalyzer extends BaseAnalyzer {
  constructor() {
    super('generic-tree-sitter', 'Generic Tree-sitter Analyzer', '1.0.0', 'language');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const files = await this.findBreadthFiles(projectPath, { projectPath }, true);
      return files.length > 0;
    } catch {
      return false;
    }
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    this.resetAnalysisWarnings();
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    let files = await this.findBreadthFiles(context.projectPath, context, false);
    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    files = this.capAndPrioritizeBreadthFiles(files);

    // Pass 1: emit file/function/class/import nodes + structural edges; collect
    // every function declaration so calls can resolve to a target node (pass 2).
    const declaredFunctions = new Map<string, FuncDecl[]>(); // name -> decls (repo-wide)
    const perFile: Array<{ file: BreadthFile; funcs: FuncDecl[]; calls: { callee: string; line: number }[] }> = [];
    const languagesSeen = new Set<string>();

    for (const file of files) {
      let source = '';
      try {
        source = await fs.readFile(file.fullPath, 'utf-8');
      } catch {
        continue;
      }
      let extract;
      try {
        extract = await extractStructure(file.grammar, source);
      } catch (error) {
        this.addAnalysisWarning(`${file.relativePath}: ${file.grammar} walk failed: ${(error as Error).message}`);
        continue;
      }
      if (!extract) continue;
      languagesSeen.add(file.grammar);

      const lineCount = source.split('\n').length;
      const fileId = this.fileId(file.relativePath);
      nodes.push(this.createNodeBuilder(fileId, file.relativePath.split('/').pop() || file.relativePath, 'file')
        .withLevel(1, 'File/Module')
        .withCategory('modules', [`${file.grammar}-files`])
        .withSource({ file: file.fullPath, line: 1, end_line: lineCount })
        .withMetadata({
          language: file.grammar,
          attributes: {
            extension: path.extname(file.relativePath) || '(none)',
            functionCount: extract.functions.length,
            classCount: extract.classes.length,
            importCount: extract.imports.length,
          },
        })
        .build());

      const funcs: FuncDecl[] = [];
      for (const fn of extract.functions) {
        const id = this.declId('function', file.relativePath, fn.name, fn.line);
        const node = this.createNodeBuilder(id, fn.name, 'function')
          .withLevel(3, 'Function')
          .withCategory('functions', [`${file.grammar}-functions`])
          .withSource({ file: file.fullPath, line: fn.line })
          .withMetadata({ language: file.grammar, attributes: { file: file.relativePath } })
          .build();
        node.qualified_name = `${file.relativePath}:${fn.name}`;
        nodes.push(node);
        edges.push(this.createEdge(`${fileId}_contains_${id}`, fileId, id, 'contains'));
        const decl: FuncDecl = { name: fn.name, line: fn.line, id, relativePath: file.relativePath };
        funcs.push(decl);
        const list = declaredFunctions.get(fn.name) || [];
        list.push(decl);
        declaredFunctions.set(fn.name, list);
      }

      // The emitted node TYPE honors the spec's classNodeLabel: markup/style
      // grammars (css rule_sets, html elements) are "class-like" for coverage
      // but are NOT semantic classes — labeling them 'class' let ONE bundled
      // stylesheet outnumber a repo's real classes 40:1 (a benchmarked Spring Boot repo's stylesheet: 2543
      // selector "classes" vs 62 Java files) and skew every type==='class'
      // consumer. Nodes stay in the graph; only the label is honest.
      const classLabel = LANGUAGE_SPECS[file.grammar]?.classNodeLabel || 'class';
      for (const cls of extract.classes) {
        const id = this.declId('class', file.relativePath, cls.name, cls.line);
        const node = this.createNodeBuilder(id, cls.name, classLabel)
          .withLevel(3, 'Class/Type')
          .withCategory('types', [`${file.grammar}-types`])
          .withSource({ file: file.fullPath, line: cls.line })
          .withMetadata({ language: file.grammar, attributes: { file: file.relativePath } })
          .build();
        node.qualified_name = `${file.relativePath}:${cls.name}`;
        nodes.push(node);
        edges.push(this.createEdge(`${fileId}_contains_${id}`, fileId, id, 'contains'));
      }

      const seenImport = new Set<string>();
      for (const imp of extract.imports) {
        const moduleName = imp.module.trim().slice(0, 100) || 'import';
        const key = `${moduleName}:${imp.line}`;
        if (seenImport.has(key)) continue;
        seenImport.add(key);
        const id = `import_${fileId}_${this.sanitizeId(moduleName)}_${imp.line}`;
        nodes.push(this.createNodeBuilder(id, moduleName, 'import')
          .withLevel(2, 'Import/Dependency')
          .withCategory('imports', [`${file.grammar}-imports`])
          .withSource({ file: file.fullPath, line: imp.line })
          .withMetadata({ language: file.grammar })
          .build());
        edges.push(this.createEdge(`${fileId}_imports_${id}`, fileId, id, 'imports', 'dependency',
          { line: imp.line, module: moduleName, language: file.grammar }));
      }

      perFile.push({ file, funcs, calls: extract.calls });
    }

    // Pass 2: resolve calls to a target function node. Attribute each call to the
    // nearest preceding function declaration in the same file (no end-lines from the
    // walker), and link to a defined function of that name — same-file first, else a
    // unique repo-wide match. Unresolved calls are dropped (no phantom nodes).
    const edgeIds = new Set(edges.map(e => e.id));
    for (const { file, funcs, calls } of perFile) {
      const byStart = [...funcs].sort((a, b) => a.line - b.line);
      for (const call of calls) {
        const caller = this.enclosingFunction(byStart, call.line);
        if (!caller) continue;
        const target = this.resolveCallTarget(call.callee, file.relativePath, declaredFunctions);
        if (!target || target.id === caller.id) continue;
        const edgeId = `call_${caller.id}_to_${target.id}_${call.line}`;
        if (edgeIds.has(edgeId)) continue;
        edgeIds.add(edgeId);
        edges.push(this.createEdge(edgeId, caller.id, target.id, 'calls', 'behavior',
          { line: call.line, callType: 'function', language: file.grammar }));
      }
    }

    const warnings = this.collectAnalysisWarnings();
    return this.createContribution(nodes, edges, entryPoints, exitPoints, {
      ...(warnings.length > 0 ? { warnings } : {}),
      framework_specific: {
        language: 'multi',
        languages: [...languagesSeen].sort(),
        packageManager: 'unknown',
        filesAnalyzed: perFile.length,
        functionsFound: nodes.filter(n => n.type === 'function').length,
      },
    });
  }

  private resolveCallTarget(
    callee: string,
    relativePath: string,
    declared: Map<string, FuncDecl[]>
  ): FuncDecl | undefined {
    const name = callee.replace(/\s*\(.*$/, '').split(/[.:]/).pop() || callee;
    const candidates = declared.get(name) || declared.get(callee);
    if (!candidates || candidates.length === 0) return undefined;
    const sameFile = candidates.filter(c => c.relativePath === relativePath);
    if (sameFile.length === 1) return sameFile[0];
    if (sameFile.length > 1) return sameFile[0];
    if (candidates.length === 1) return candidates[0]; // unambiguous repo-wide match
    return undefined; // ambiguous cross-file name — don't guess
  }

  private enclosingFunction(byStart: FuncDecl[], line: number): FuncDecl | undefined {
    let chosen: FuncDecl | undefined;
    for (const fn of byStart) {
      if (fn.line <= line) chosen = fn;
      else break;
    }
    return chosen;
  }

  private async findBreadthFiles(
    projectPath: string,
    context: AnalysisContext,
    stopEarly: boolean
  ): Promise<BreadthFile[]> {
    const map = extensionToGrammar();
    if (map.size === 0) return [];
    const ignore = this.getIgnorePatterns(context);
    const extGlobs = [...new Set([...map.keys()].map(ext => `**/*${ext}`))];
    const matched = await glob(extGlobs, { cwd: projectPath, ignore, nodir: true });
    const out: BreadthFile[] = [];
    for (const rel of matched) {
      const ext = path.extname(rel).toLowerCase();
      const grammar = map.get(ext);
      if (!grammar) continue;
      out.push({ relativePath: rel, fullPath: path.join(projectPath, rel), grammar });
      if (stopEarly) return out;
    }
    return out;
  }

  private capAndPrioritizeBreadthFiles(files: BreadthFile[]): BreadthFile[] {
    if (files.length <= MAX_BREADTH_FILES) return files;
    this.addAnalysisWarning(
      `Generic tree-sitter analyzer walked ${MAX_BREADTH_FILES} of ${files.length} breadth-language files; run full analysis for exhaustive coverage`
    );
    return files.slice(0, MAX_BREADTH_FILES);
  }

  private fileId(relativePath: string): string {
    return `file_${this.sanitizeId(relativePath)}`;
  }

  private declId(kind: 'function' | 'class', relativePath: string, name: string, line: number): string {
    return `${kind}_${this.sanitizeId(relativePath)}_${this.sanitizeId(name)}_${line}`;
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

  protected getCapabilities(): string[] {
    return [
      'breadth-language-detection',
      'tree-sitter-structural-extraction',
      'function-extraction',
      'class-extraction',
      'import-extraction',
      'call-graph-analysis',
    ];
  }
}
