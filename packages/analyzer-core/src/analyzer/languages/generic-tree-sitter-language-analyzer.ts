import { BaseAnalyzer, AnalysisContext } from '../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint } from '../../types/cas.types';
import { extractStructure } from '../core/generic-tree-sitter-analyzer';
import { LANGUAGE_SPECS } from '../core/language-spec';
import { LANGUAGE_REGISTRY } from '../core/language-registry';
import { LanguageAnalyzers } from '../core/language-analyzer-catalog';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../core/glob-cache';
import * as path from 'path';
import { genericScriptEntryPoint } from './generic-script-entry-point';








let extToGrammar: Map<string, string> | null = null;
function extensionToGrammar(): Map<string, string> {
  if (extToGrammar) return extToGrammar;
  const deepLangIds = new Set<string>(Object.keys(LanguageAnalyzers));
  const map = new Map<string, string>();
  for (const entry of LANGUAGE_REGISTRY) {
    const grammar = entry.id;
    if (deepLangIds.has(grammar)) continue;
    if (!LANGUAGE_SPECS[grammar]) continue;
    for (const ext of entry.extensions) {
      map.set(`.${ext.toLowerCase()}`, grammar);
    }
  }
  extToGrammar = map;
  return map;
}














const JVM_FAMILY_GRAMMAR_IDS = new Set(['scala', 'groovy']);

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



    const declaredFunctions = new Map<string, FuncDecl[]>();
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
      }
      if (extract) languagesSeen.add(file.grammar);

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
            functionCount: extract?.functions.length || 0,
            classCount: extract?.classes.length || 0,
            importCount: extract?.imports.length || 0,
          },
        })
        .build());
      const scriptEntryPoint = genericScriptEntryPoint(fileId, file.relativePath, file.grammar);
      if (scriptEntryPoint) entryPoints.push(scriptEntryPoint);
      if (!extract) continue;

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







      const spec = LANGUAGE_SPECS[file.grammar];
      const classLabel = spec?.classNodeLabel || 'class';
      if (spec?.aggregateClassNodes && extract.classes.length > 0) {






        const SAMPLE_SIZE = 20;
        const id = this.declId('class', file.relativePath, '(aggregate)', 1);
        const node = this.createNodeBuilder(id, file.relativePath.split('/').pop() || file.relativePath, classLabel)
          .withLevel(3, 'Class/Type')
          .withCategory('types', [`${file.grammar}-types`])
          .withSource({ file: file.fullPath, line: 1 })
          .withMetadata({
            language: file.grammar,
            attributes: {
              file: file.relativePath,
              rule_count: extract.classes.length,
              sample_selectors: extract.classes.slice(0, SAMPLE_SIZE).map(c => c.name),
              sample_is_partial: extract.classes.length > SAMPLE_SIZE,
            },
          })
          .build();
        node.qualified_name = `${file.relativePath}:(aggregate)`;
        nodes.push(node);
        edges.push(this.createEdge(`${fileId}_contains_${id}`, fileId, id, 'contains'));
      } else {
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
    if (candidates.length === 1) return candidates[0];
    return undefined;
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

    const jvmExts: string[] = [];
    const otherExts: string[] = [];
    for (const [ext, grammar] of map) {
      (JVM_FAMILY_GRAMMAR_IDS.has(grammar) ? jvmExts : otherExts).push(ext);
    }

    const out: BreadthFile[] = [];
    const collect = async (exts: string[], ignore: string[]): Promise<boolean> => {
      if (exts.length === 0) return false;
      const extGlobs = [...new Set(exts.map(ext => `**/*${ext}`))];
      const matched = await glob(extGlobs, { cwd: projectPath, ignore, nodir: true });
      for (const rel of matched) {
        const ext = path.extname(rel).toLowerCase();
        const grammar = map.get(ext);
        if (!grammar) continue;
        out.push({ relativePath: rel, fullPath: path.join(projectPath, rel), grammar });
        if (stopEarly) return true;
      }
      return false;
    };



    if (await collect(jvmExts, this.getPackageDirSafeIgnorePatterns(context))) return out;
    if (await collect(otherExts, this.getIgnorePatterns(context))) return out;
    return out;
  }

  private capAndPrioritizeBreadthFiles(files: BreadthFile[]): BreadthFile[] {
    return files;
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
