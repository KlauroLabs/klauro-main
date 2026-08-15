import { BaseAnalyzer, AnalysisContext, FileAnalysisContext, FileAnalysisResult } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint
} from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';











interface NotebookCell {
  index: number;
  cellType: 'code' | 'markdown' | 'raw';
  source: string;
  imports: string[];
  defs: string[];
  calls: string[];
  executionCount?: number | null;
}

export class JupyterNotebookAnalyzer extends BaseAnalyzer {
  constructor() {
    super('jupyter-notebook', 'Jupyter Notebook Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const notebooks = await glob(['**/*.ipynb'], {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath } as AnalysisContext),
        nodir: true
      });
      return notebooks.length > 0;
    } catch {
      return false;
    }
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    return glob(['**/*.ipynb'], {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath } as AnalysisContext),
      nodir: true
    });
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const file = context.relativePath;
    const raw = await fs.readFile(context.filePath, 'utf-8');
    const stat = await fs.stat(context.filePath);

    this.analyzeNotebookFile(file, raw, context.projectPath, nodes, edges, entryPoints);

    const allImports = new Set<string>();
    const allDefs = new Set<string>();

    try {
      const parsed = JSON.parse(raw);
      for (const cell of parsed.cells || []) {
        if (cell.cell_type !== 'code') continue;
        const source = this.cellSource(cell);
        this.extractImports(source).forEach(i => allImports.add(i));
        this.extractDefs(source).forEach(d => allDefs.add(d));
      }
    } catch {   }

    return this.createFileAnalysisResult(
      context.filePath,
      file,
      context.contentHash || this.computeContentHash(raw),
      stat.mtimeMs,
      nodes,
      edges,
      entryPoints,
      exitPoints,
      [...allImports],
      [...allDefs]
    );
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    try {
      const notebooks = await glob(['**/*.ipynb'], {
        cwd: context.projectPath,
        ignore: this.getIgnorePatterns(context),
        nodir: true
      });

      let notebooksFound = 0;
      let cellsFound = 0;
      let malformedSkipped = 0;

      for (const file of notebooks) {
        const raw = await fs.readFile(path.join(context.projectPath, file), 'utf-8');
        const result = this.analyzeNotebookFile(file, raw, context.projectPath, nodes, edges, entryPoints);
        if (result === null) {
          malformedSkipped++;
          continue;
        }
        notebooksFound++;
        cellsFound += result;
      }

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        format: 'jupyter-notebook',
        notebooksFound,
        cellsFound,
        malformedSkipped
      });
    } catch (error) {
      throw new AnalyzerError(`Jupyter notebook analysis failed: ${(error as Error).message}`, 'JUPYTER_ANALYSIS_ERROR');
    }
  }


  private analyzeNotebookFile(
    file: string,
    raw: string,
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): number | null {
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!Array.isArray(parsed.cells)) return null;

    const notebookId = `notebook_${this.sanitizeId(file)}`;
    const notebookName = path.basename(file, '.ipynb');
    const notebookNode = this.createNodeBuilder(notebookId, notebookName, 'notebook')
      .withLevel(2, 'architectural')
      .withCategory('notebook', ['jupyter', 'ipynb'])
      .withSource({ file: file, line: 1, end_line: 1 })
      .withDescription(`Jupyter notebook: ${notebookName}`)
      .withMetadata({
        framework: 'jupyter-notebook',
        attributes: {
          kernel: parsed.metadata?.kernelspec?.name,
          language: parsed.metadata?.language_info?.name || parsed.metadata?.kernelspec?.language,
          nbformat: parsed.nbformat
        }
      })
      .build();
    nodes.push(notebookNode);

    const codeCells: NotebookCell[] = [];
    let codeCellIndex = 0;
    for (let i = 0; i < parsed.cells.length; i++) {
      const cell = parsed.cells[i];
      if (cell.cell_type !== 'code') continue;
      const source = this.cellSource(cell);
      codeCells.push({
        index: codeCellIndex++,
        cellType: 'code',
        source,
        imports: this.extractImports(source),
        defs: this.extractDefs(source),
        calls: this.extractCalls(source),
        executionCount: cell.execution_count ?? null
      });
    }

    let previousCellId: string | null = null;
    for (const cell of codeCells) {
      const cellId = `${notebookId}_cell_${cell.index}`;
      const label = cell.defs.length > 0
        ? `Cell ${cell.index}: ${cell.defs.slice(0, 2).join(', ')}`
        : `Cell ${cell.index}`;

      const cellNode = this.createNodeBuilder(cellId, label, 'notebook-cell')
        .withLevel(3, 'code')
        .withCategory('notebook-cell', ['jupyter', 'code-cell'])
        .withSource({ file: file, line: cell.index + 1, end_line: cell.index + 1 })
        .withDescription(`Notebook code cell #${cell.index}${cell.executionCount != null ? ` (executed as [${cell.executionCount}])` : ''}`)
        .withMetadata({
          framework: 'jupyter-notebook',
          attributes: {
            cellIndex: cell.index,
            imports: cell.imports,
            defs: cell.defs,
            calls: cell.calls.slice(0, 25),
            executionCount: cell.executionCount
          }
        })
        .build();
      nodes.push(cellNode);

      edges.push(this.createEdge(`${notebookId}_contains_${cellId}`, notebookId, cellId, 'contains'));

      if (previousCellId) {
        edges.push(this.createEdge(`${previousCellId}_precedes_${cellId}`, previousCellId, cellId, 'precedes', 'notebook-sequence'));
      }
      previousCellId = cellId;

      entryPoints.push(this.createEntryPoint(
        `entry_${cellId}`,
        cellId,
        'notebook-cell',
        label,
        `Notebook code cell #${cell.index} in ${notebookName}`,
        undefined,
        undefined,
        { framework: 'jupyter-notebook', notebook: notebookName, cellIndex: cell.index },
        { node_id: cellId, method_name: label, file, line: cell.index + 1 }
      ));
    }

    return codeCells.length;
  }

  private cellSource(cell: any): string {
    const src = cell.source;
    if (Array.isArray(src)) return src.join('');
    if (typeof src === 'string') return src;
    return '';
  }

  private extractImports(source: string): string[] {
    const imports = new Set<string>();
    const importRegex = /^\s*import\s+([A-Za-z_][\w.]*)/gm;
    const fromRegex = /^\s*from\s+([A-Za-z_][\w.]*)\s+import\b/gm;
    let m: RegExpExecArray | null;
    while ((m = importRegex.exec(source)) !== null) imports.add(m[1]);
    while ((m = fromRegex.exec(source)) !== null) imports.add(m[1]);
    return [...imports];
  }

  private extractDefs(source: string): string[] {
    const defs = new Set<string>();
    const defRegex = /^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm;
    const classRegex = /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*[:(]/gm;
    let m: RegExpExecArray | null;
    while ((m = defRegex.exec(source)) !== null) defs.add(m[1]);
    while ((m = classRegex.exec(source)) !== null) defs.add(m[1]);
    return [...defs];
  }

  private extractCalls(source: string): string[] {
    const calls = new Set<string>();
    const callRegex = /\b([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = callRegex.exec(source)) !== null) {
      const name = m[1];
      if (!['if', 'for', 'while', 'print', 'return', 'def', 'class'].includes(name)) {
        calls.add(name);
      }
    }
    return [...calls];
  }

  protected getCapabilities(): string[] {
    return ['jupyter-notebook-parsing', 'cell-extraction', 'cell-sequence-flow', 'cell-import-export-extraction'];
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
}
