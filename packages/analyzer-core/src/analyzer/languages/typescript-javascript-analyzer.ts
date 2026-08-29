import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint,
  CASCategories, CASPerspective, CASDocumentation, CASComment,
  CASTodo, FileAnalysisResult
} from '../../types/cas.types';
import { AnalyzerError, isNativeAddonUnavailableError } from '../core/errors';
import { ExtractedFunction } from '../enhanced-call-graph-extractor';
import { TreeSitterTSExtractor, TSFileExtraction, TSExtractedFunction, TSExtractedClass, TSDecoratorDetail, UNRESOLVED_RECEIVER } from '../core/tree-sitter-ts-extractor';
import * as path from 'path';
import * as fs from 'fs-extra';
import { TSESTree } from '@typescript-eslint/typescript-estree';
import { cachedGlob as glob } from '../core/glob-cache';
import { yieldToEventLoop, createYieldBudget } from '../core/event-loop-yield';
import { dropEdgesReferencingRemovedEndpoints } from '../core/graph-referential-integrity';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { resolveTreeSitterWorkerPath, treeSitterWorkerExecArgv } from '../core/tree-sitter-worker-runtime';
import {
  readTreeSitterExtractionCache,
  writeTreeSitterExtractionCache,
} from '../core/tree-sitter-ts-extraction-cache';
import { loadPrismaModelIdentities, selectPrismaModelIdentity, type PrismaModelIdentity } from '../libraries/orm/prisma-model-identity';
import { appendInMemoryRecordCollectionNodes } from '../core/javascript-in-memory-data';

interface ParsedAST {
  ast: TSESTree.Program;
  content: string;
  filePath: string;
}

const PARALLEL_BATCH_SIZE = 100;
const MAX_SOURCE_FILE_BYTES = 5 * 1024 * 1024;

export class TypeScriptJavaScriptAnalyzer extends BaseAnalyzer {
  private astCache = new Map<string, ParsedAST>();
  private isTypeScriptProject = false;
  private tsExtractor = new TreeSitterTSExtractor();
  private importSourceMap = new Map<string, string>();
  private importAliasMap = new Map<string, string>();
  private importsByConsumerFile = new Map<string, Map<string, string>>();
  private currentProjectPath = '';
  private classFieldTypes = new Map<string, { typeName: string; library?: string; source?: 'ctor' | 'field'; isCollection?: boolean }>();
  private repositoryPropertyTypes = new Map<string, string>();
  private prismaModelsByName = new Map<string, PrismaModelIdentity[]>();
  private nodeById = new Map<string, CASNode>();
  private nodesByName = new Map<string, CASNode[]>();
  private methodsByParent = new Map<string, CASNode[]>();
  private callEdgeIds = new Set<string>();
  private exitPointIds = new Set<string>();
  private callTargetResolutionCache = new Map<string, string | undefined>();

  constructor() { super('typescript-javascript', 'TypeScript/JavaScript AST Analyzer', '1.0.0', 'language'); }
  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const files = await glob(['**/*.{js,jsx,ts,tsx,mjs,cjs}'], {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true
      });
      return files.length > 0;
    } catch {
      return false;
    }
  }

  supportsIncrementalAnalysis(): boolean { return true; }
  incrementalContributionScope(): 'project' { return 'project'; }
  incrementalSourceInvariantContributionFields(): readonly (keyof CASContribution)[] { return ['categories']; }
  async getRelevantFiles(projectPath: string): Promise<string[]> {
    const files = await glob(['**/*.{js,jsx,ts,tsx,mjs,cjs}'], {
      cwd: projectPath,
      ignore: this.getLanguageIgnorePatterns({ projectPath }),
      nodir: true
    });
    return files.sort();
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const { filePath, relativePath } = context;
    const content = await fs.readFile(filePath, 'utf-8');
    const contentHash = context.contentHash || this.computeContentHash(content);
    const stat = await fs.stat(filePath);

    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const imports: string[] = [];
    const exports: string[] = [];

    try {
      const extraction = this.tsExtractor.extractFromSource(content, filePath);

      const extractedFunctions = this.processTreeSitterExtractionForSingleFile(
        relativePath,
        filePath,
        content,
        extraction,
        nodes,
        edges,
        entryPoints,
        exitPoints,
        imports,
        exports
      );

      const retainedProjectNodes = (context.existingAnalysis || [])
        .flatMap(contribution => contribution.nodes || [])
        .filter(node => {
          const sourceFile = node.source?.file;
          if (!sourceFile) return true;
          const normalizedSource = sourceFile.replace(/\\/g, '/');
          const normalizedRelative = relativePath.replace(/\\/g, '/');
          return normalizedSource !== normalizedRelative && !normalizedSource.endsWith(`/${normalizedRelative}`);
        });
      this.integrateEnhancedCallGraphDataForSingleFile(
        extractedFunctions,
        nodes,
        [...nodes, ...retainedProjectNodes],
        edges,
        entryPoints,
        exitPoints,
        relativePath
      );
      this.enrichNodesWithCallData(nodes, edges);
      this.applyTestSourceBoundary(nodes, entryPoints, exitPoints, edges);
      this.tagNodesWithPerspectives(nodes, edges);

    } catch (error) {

      if (isNativeAddonUnavailableError(error)) throw error;
      console.warn(`Failed to analyze ${relativePath} incrementally:`, error);
    }

    return this.createFileAnalysisResult(
      filePath,
      relativePath,
      contentHash,
      stat.mtimeMs,
      nodes,
      edges,
      entryPoints,
      exitPoints,
      imports,
      exports
    );
  }

  private resolveImportPath(importSource: string, currentFile: string, projectPath: string): string | null {
    const currentDir = path.dirname(currentFile);
    let resolvedPath = path.resolve(currentDir, importSource);

    if (!path.isAbsolute(resolvedPath)) {
      resolvedPath = path.join(projectPath, resolvedPath);
    }

    const relativePath = path.relative(projectPath, resolvedPath);

    const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

    if (extensions.some(ext => relativePath.endsWith(ext))) {
      return relativePath;
    }

    for (const ext of extensions) {
      const withExt = relativePath + ext;
      const indexPath = path.join(relativePath, `index${ext}`);
      if (fs.pathExistsSync(path.join(projectPath, withExt))) {
        return withExt;
      }
      if (fs.pathExistsSync(path.join(projectPath, indexPath))) {
        return indexPath;
      }
    }

    return relativePath;
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const libraries: any[] = [];
    const perspectives: CASPerspective[] = [];

    this.importSourceMap.clear();
    this.importAliasMap.clear();
    this.importsByConsumerFile.clear();
    this.currentProjectPath = context.projectPath;
    this.classFieldTypes.clear();
    this.repositoryPropertyTypes.clear();
    this.prismaModelsByName.clear();
    this.analysisWarnings = [];
    this.suppressedWarningCount = 0;

    try {
      const tsTimings: Record<string, number> = {};
      let tsStart = Date.now();

      const sourceFiles = this.capAndPrioritizeSourceFiles((await glob(['**/*.{js,jsx,ts,tsx,mjs,cjs}'], {
        cwd: context.projectPath,
        ignore: this.getLanguageIgnorePatterns(context),
        nodir: true
      })).sort(), 'TypeScript/JavaScript files');
      tsTimings['glob'] = Date.now() - tsStart;

      tsStart = Date.now();
      this.isTypeScriptProject = sourceFiles.filter(f => f.endsWith('.ts') || f.endsWith('.tsx')).length >
                                 sourceFiles.filter(f => f.endsWith('.js') || f.endsWith('.jsx')).length;

      const packageJsonPath = path.join(context.projectPath, 'package.json');
      if (await fs.pathExists(packageJsonPath)) {
        try {
          const packageJson = await fs.readJson(packageJsonPath);
          this.extractLibraries(packageJson, libraries);
        } catch (error) {
          this.addAnalysisWarning(
            `package.json could not be parsed; dependency information is unavailable: ${(error as Error).message}`
          );
        }
      }
      await this.collectPrismaModels(context, nodes);
      tsTimings['setup'] = Date.now() - tsStart;

      tsStart = Date.now();
      const preloadedFiles = await this.preloadFilesWithTreeSitter(sourceFiles, context.projectPath);
      tsTimings['preload'] = Date.now() - tsStart;

      tsStart = Date.now();
      this.resetProcessTimings();

      const maybeYieldTail = createYieldBudget();
      const deferredCallGraphData: Array<{ extractedFunctions: any[]; relativePath: string }> = [];
      for (const { relativePath, fullPath, content, extraction } of preloadedFiles) {
        const extractedFunctions = this.processTreeSitterExtraction(relativePath, fullPath, content, extraction, nodes, edges, entryPoints, exitPoints);
        if (extractedFunctions.length > 0) {
          deferredCallGraphData.push({ extractedFunctions, relativePath });
        }
        await maybeYieldTail();
      }
      tsTimings['processFiles_phase1'] = Date.now() - tsStart;

      tsStart = Date.now();
      this.buildNodeIndexes(nodes);
      this.callEdgeIds = new Set(edges.map(edge => edge.id));
      this.exitPointIds = new Set(exitPoints.map(exitPoint => exitPoint.id));
      this.callTargetResolutionCache.clear();
      tsTimings['buildIndexes'] = Date.now() - tsStart;

      for (const n of nodes) {
        if (n.type !== 'import') continue;
        const specs = (n.metadata as any)?.specifiers;
        if (!Array.isArray(specs)) continue;
        for (const s of specs) {
          if (s && s.name && s.imported && s.imported !== s.name &&
              s.imported !== 'default' && s.imported !== '*') {
            this.importAliasMap.set(s.name, s.imported);
          }
        }
      }

      tsStart = Date.now();
      for (const { extractedFunctions, relativePath } of deferredCallGraphData) {
        this.integrateEnhancedCallGraphDataIndexed(extractedFunctions, nodes, edges, entryPoints, exitPoints, relativePath);
        await maybeYieldTail();
      }
      tsTimings['processFiles_phase2'] = Date.now() - tsStart;

      tsStart = Date.now();
      this.detectServerEntryPoints(sourceFiles, nodes, entryPoints, context.projectPath);
      this.applyTestSourceBoundary(nodes, entryPoints, exitPoints, edges);
      tsTimings['detectEntryPoints'] = Date.now() - tsStart;
      await yieldToEventLoop();

      tsStart = Date.now();
      this.buildEnhancedCallGraph(nodes, edges, entryPoints, exitPoints);
      tsTimings['buildCallGraph'] = Date.now() - tsStart;
      await yieldToEventLoop();

      tsStart = Date.now();
      const categories = this.buildCategories();

      this.tagNodesWithPerspectives(nodes, edges);
      this.createPerspectives(perspectives);
      tsTimings['categorize'] = Date.now() - tsStart;

      if (process.env.KLAURO_DEBUG_TS_ANALYZER_TIMINGS === '1') {
        console.log(`[Klauro] TypeScript/JavaScript analyzer completed for ${context.projectPath}:`, JSON.stringify({
          ...tsTimings,
          ...this.getProcessTimings(),
          filesAnalyzed: sourceFiles.length,
          nodes: nodes.length,
          edges: edges.length,
        }, null, 2));
      }

      const warnings = this.collectAnalysisWarnings();
      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework_specific: {
          isTypeScriptProject: this.isTypeScriptProject,
          libraries,
          filesAnalyzed: sourceFiles.length
        },
        categories,
        perspectives,
        provided_perspectives: perspectives.map(p => p.id),
        ...(warnings.length > 0 ? { warnings } : {})
      });

    } catch (error) {
      throw new AnalyzerError(
        `TypeScript/JavaScript analysis failed: ${(error as Error).message}`,
        'TYPESCRIPT_ANALYSIS_ERROR'
      );
    } finally {
      this.releaseAnalysisState();
    }
  }

  private releaseAnalysisState(): void {
    const collections = [this.astCache, this.importSourceMap, this.importAliasMap, this.importsByConsumerFile, this.classFieldTypes, this.repositoryPropertyTypes, this.prismaModelsByName, this.nodeById, this.nodesByName, this.methodsByParent, this.callEdgeIds, this.exitPointIds, this.callTargetResolutionCache];
    for (const collection of collections) collection.clear();
    this.currentProjectPath = '';
  }

  private async preloadFilesWithTreeSitter(
    sourceFiles: string[],
    projectPath: string
  ): Promise<Array<{ relativePath: string; fullPath: string; content: string; extraction: TSFileExtraction }>> {
    const results: Array<{ relativePath: string; fullPath: string; content: string; extraction: TSFileExtraction }> = [];
    const loadedFiles: Array<{ relativePath: string; fullPath: string; content: string }> = [];

    for (let i = 0; i < sourceFiles.length; i += PARALLEL_BATCH_SIZE) {
      const batch = sourceFiles.slice(i, i + PARALLEL_BATCH_SIZE);

      const loadedBatch = await Promise.all(
        batch.map(async (file) => {
          const fullPath = path.join(projectPath, file);
          try {
            const stat = await fs.stat(fullPath);
            if (!stat.isFile()) return null;
            if (stat.size > MAX_SOURCE_FILE_BYTES) {
              this.addAnalysisWarning(
                `${file} exceeds the ${Math.round(MAX_SOURCE_FILE_BYTES / (1024 * 1024))}MB source file limit (${Math.round(stat.size / (1024 * 1024))}MB); file skipped`
              );
              return null;
            }
            const content = await fs.readFile(fullPath, 'utf-8');
            return { relativePath: file, fullPath, content };
          } catch (error) {
            this.addAnalysisWarning(`${file} could not be parsed: ${(error as Error).message}`);
            console.warn(`Failed to parse ${file}:`, error);
            return null;
          }
        })
      );

      for (const loaded of loadedBatch) {
        if (loaded === null) continue;
        loadedFiles.push(loaded);
      }
      await yieldToEventLoop();
    }

    const extractions = new Array<TSFileExtraction | Error | undefined>(loadedFiles.length);
    const misses: Array<{ index: number; fullPath: string; content: string }> = [];
    const cached = await Promise.all(loadedFiles.map(file =>
      readTreeSitterExtractionCache(file.content, file.fullPath)
    ));
    for (let index = 0; index < loadedFiles.length; index++) {
      if (cached[index]) extractions[index] = cached[index];
      else misses.push({ index, fullPath: loadedFiles[index].fullPath, content: loadedFiles[index].content });
    }

    if (misses.length > 0) {
      let extractedMisses: Array<TSFileExtraction | Error>;
      try {
        extractedMisses = await this.extractTreeSitterFilesInWorkers(misses);
      } catch (error) {
        console.warn(`Tree-sitter worker pool unavailable; using sequential extraction: ${(error as Error).message}`);
        extractedMisses = await this.extractTreeSitterFilesSequentially(misses);
      }
      await Promise.all(extractedMisses.map(async (extraction, missIndex) => {
        const miss = misses[missIndex];
        extractions[miss.index] = extraction;
        if (!(extraction instanceof Error)) {
          await writeTreeSitterExtractionCache(miss.content, miss.fullPath, extraction);
        }
      }));
    }

    for (let i = 0; i < loadedFiles.length; i++) {
      const loaded = loadedFiles[i];
      const extraction = extractions[i];
      if (!extraction) continue;
      if (extraction instanceof Error) {

        if (isNativeAddonUnavailableError(extraction)) throw extraction;
        this.addAnalysisWarning(`${loaded.relativePath} could not be parsed: ${extraction.message}`);
        continue;
      }
      if (extraction.hasSyntaxErrors) {
        const locations = extraction.syntaxErrorLocations || [];

        const known = locations.filter(l => l.knownLimitation);
        const unknown = locations.filter(l => !l.knownLimitation);
        if (known.length > 0) {
          const detail = known
            .map(l => `line ${l.line} (${l.knownLimitation})`)
            .join('; ');
          this.addAnalysisWarning(
            `${loaded.relativePath}: ${known.length} known parser limitation${known.length > 1 ? 's' : ''} — ${detail}. This is a limitation of our parser, not a defect in this file; the rest of the file was still analyzed.`
          );
        }
        if (unknown.length > 0) {
          const locationSuffix = ` (near line${unknown.length > 1 ? 's' : ''} ${unknown.map(l => l.line).join(', ')}: ${unknown.map(l => JSON.stringify(l.snippet)).join(', ')})`;
          this.addAnalysisWarning(`${loaded.relativePath} contains a construct our parser could not fully recognize; extraction may be partial for that part of the file${locationSuffix}`);
        }
        if (known.length === 0 && unknown.length === 0) {
          this.addAnalysisWarning(`${loaded.relativePath} contains syntax errors; extraction may be partial`);
        }
      }
      results.push({ ...loaded, extraction });
    }

    return results;
  }

  private async extractTreeSitterFilesSequentially(
    files: Array<{ fullPath: string; content: string }>
  ): Promise<Array<TSFileExtraction | Error>> {
    const extracted: Array<TSFileExtraction | Error> = [];
    const maybeYield = createYieldBudget();
    for (const file of files) {
      try {
        extracted.push(this.tsExtractor.extractFromSource(file.content, file.fullPath));
      } catch (error) {

        if (isNativeAddonUnavailableError(error)) throw error;
        extracted.push(error instanceof Error ? error : new Error(String(error)));
      }
      await maybeYield();
    }
    return extracted;
  }

  private async extractTreeSitterFilesInWorkers(
    files: Array<{ fullPath: string; content: string }>
  ): Promise<Array<TSFileExtraction | Error>> {
    const configured = Number(process.env.KLAURO_TS_PARSE_WORKERS || '');
    const workerCount = Math.max(1, Math.min(
      files.length,
      Number.isFinite(configured) && configured > 0
        ? Math.floor(configured)
        : Math.min(2, Math.max(1, availableParallelism() - 1))
    ));
    if (workerCount === 1 || files.length < 40 || process.env.JEST_WORKER_ID) {
      return this.extractTreeSitterFilesSequentially(files);
    }

    const bundledWorkerPath = path.join(__dirname, 'tree-sitter-ts-worker.cjs');
    const compiledWorkerPath = path.join(
      __dirname,
      '..',
      '..',
      '..',
      'dist',
      'analyzer',
      'core',
      'tree-sitter-ts-worker.js'
    );
    const sourceWorkerPath = path.join(__dirname, '..', 'core', 'tree-sitter-ts-worker.ts');
    const workerPath = resolveTreeSitterWorkerPath(bundledWorkerPath, compiledWorkerPath, sourceWorkerPath);
    const results = new Array<TSFileExtraction | Error>(files.length);
    let nextTask = 0;

    const runWorker = (): Promise<void> => new Promise((resolve, reject) => {
      const worker = new Worker(workerPath, {
        execArgv: treeSitterWorkerExecArgv(process.execArgv)
      });
      let activeTask: number | undefined;
      const dispatch = (): void => {
        if (nextTask >= files.length) {
          void worker.terminate().then(() => resolve(), reject);
          return;
        }
        activeTask = nextTask++;
        worker.postMessage({
          id: activeTask,
          content: files[activeTask].content,
          filePath: files[activeTask].fullPath,
        });
      };
      worker.on('message', (message: { id: number; extraction?: TSFileExtraction; error?: string }) => {
        results[message.id] = message.error ? new Error(message.error) : message.extraction!;
        activeTask = undefined;
        dispatch();
      });
      worker.on('error', reject);
      worker.on('exit', code => {
        if (code !== 0 && activeTask !== undefined) reject(new Error(`tree-sitter worker exited with code ${code}`));
      });
      dispatch();
    });

    await Promise.all(Array.from({ length: workerCount }, runWorker));
    return results;
  }

  private processTimings: Record<string, number> = {};

  private processTreeSitterExtraction(
    relativePath: string,
    fullPath: string,
    content: string,
    extraction: TSFileExtraction,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[]
  ): TSExtractedFunction[] {
    try {
      const fileId = `file_${relativePath.replace(/[^a-zA-Z0-9]/g, '_')}`;
      const lineCount = this.sourceLineCount(content);

      const fileTodos: CASTodo[] = [];
      const TODO_RE = /(?:\/\/+|\/\*+|^\s*\*|#|<!--)\s*(TODO|FIXME|HACK|XXX|NOTE|WARNING|OPTIMIZE|REFACTOR)\b\s*:?\s*(.*?)(?:\s*\*\/|\s*-->)?\s*$/i;
      if (/\b(?:TODO|FIXME|HACK|XXX|NOTE|WARNING|OPTIMIZE|REFACTOR)\b/i.test(content)) {
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const m = lines[i].match(TODO_RE);
          if (!m) continue;
          const todoType = m[1].toUpperCase() as CASTodo['type'];
          fileTodos.push({

            id: `todo_${relativePath}_${i + 1}`,
            type: todoType,
            text: (m[2] || '').trim() || lines[i].trim(),
            priority: todoType === 'FIXME' || todoType === 'HACK' ? 'high' : todoType === 'WARNING' ? 'medium' : 'low',
            location: { file: relativePath, line: i + 1 },
          });
        }
      }

      const fileComments: CASComment[] = extraction.comments.map((c, ci) => ({

        id: `comment_${relativePath}_${ci + 1}`,
        type: (c.type === 'block' ? 'block' : c.type === 'jsdoc' ? 'docstring' : 'single-line') as CASComment['type'],
        style: (c.type === 'block' || c.type === 'jsdoc' ? '/* */' : '//') as CASComment['style'],
        text: c.text,
        purpose: (/\btodo\b/i.test(c.text) ? 'todo' : /\b(fixme|hack)\b/i.test(c.text) ? 'hack' : /\bwarning\b/i.test(c.text) ? 'warning' : /\bnote\b/i.test(c.text) ? 'note' : 'explanation') as CASComment['purpose'],
        location: { file: relativePath, line: c.line },
      }));

      const fileNode = this.createNode(
        fileId,
        path.basename(relativePath),
        'file',
        1,
        relativePath,
        1,
        lineCount,
        {
          relativePath,
          extension: path.extname(relativePath),
          isTypeScript: relativePath.endsWith('.ts') || relativePath.endsWith('.tsx'),
          commentCount: fileComments.length,
          todoCount: fileTodos.length,
        }
      );
      if (fileComments.length > 0) fileNode.comments = fileComments;
      if (fileTodos.length > 0) fileNode.todos = fileTodos;
      nodes.push(fileNode);

      this.processTreeSitterImports(extraction, relativePath, fileId, nodes, edges, exitPoints);
      const extractedFunctions = this.processTreeSitterFunctions(extraction, relativePath, fileId, nodes, edges, entryPoints);
      for (const extractedFunction of extractedFunctions) {
        (extractedFunction as any).constructedClassNames =
          this.extractConstructedClassNames(content, fullPath, extractedFunction.lineStart, extractedFunction.lineEnd);
      }
      this.processTreeSitterClasses(extraction, relativePath, fileId, nodes, edges);
      this.processTreeSitterVariables(extraction, relativePath, fileId, nodes, edges);
      appendInMemoryRecordCollectionNodes(content, relativePath, fileId, nodes, edges, this.createNodeBuilder.bind(this), this.createEdge.bind(this));
      this.processTreeSitterExports(extraction, relativePath, entryPoints);

      return extractedFunctions;
    } catch (error) {
      console.warn(`Failed to process ${relativePath}:`, error);
      return [];
    }
  }

  private processTreeSitterExtractionForSingleFile(
    relativePath: string,
    fullPath: string,
    content: string,
    extraction: TSFileExtraction,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[],
    imports: string[],
    exports: string[]
  ): TSExtractedFunction[] {
    try {
      const fileId = `file_${relativePath.replace(/[^a-zA-Z0-9]/g, '_')}`;
      const lines = content.split('\n');

      const fileTodos: CASTodo[] = [];
      const TODO_RE = /(?:\/\/+|\/\*+|^\s*\*|#|<!--)\s*(TODO|FIXME|HACK|XXX|NOTE|WARNING|OPTIMIZE|REFACTOR)\b\s*:?\s*(.*?)(?:\s*\*\/|\s*-->)?\s*$/i;
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(TODO_RE);
        if (!m) continue;
        const todoType = m[1].toUpperCase() as CASTodo['type'];
        fileTodos.push({

          id: `todo_${relativePath}_${i + 1}`,
          type: todoType,
          text: (m[2] || '').trim() || lines[i].trim(),
          priority: todoType === 'FIXME' || todoType === 'HACK' ? 'high' : todoType === 'WARNING' ? 'medium' : 'low',
          location: { file: relativePath, line: i + 1 },
        });
      }

      const fileComments: CASComment[] = extraction.comments.map((c, ci) => ({

        id: `comment_${relativePath}_${ci + 1}`,
        type: (c.type === 'block' ? 'block' : c.type === 'jsdoc' ? 'docstring' : 'single-line') as CASComment['type'],
        style: (c.type === 'block' || c.type === 'jsdoc' ? '/* */' : '//') as CASComment['style'],
        text: c.text,
        purpose: (/\btodo\b/i.test(c.text) ? 'todo' : /\b(fixme|hack)\b/i.test(c.text) ? 'hack' : /\bwarning\b/i.test(c.text) ? 'warning' : /\bnote\b/i.test(c.text) ? 'note' : 'explanation') as CASComment['purpose'],
        location: { file: relativePath, line: c.line },
      }));

      const fileNode = this.createNode(
        fileId,
        path.basename(relativePath),
        'file',
        1,
        relativePath,
        1,
        lines.length,
        {
          relativePath,
          extension: path.extname(relativePath),
          isTypeScript: relativePath.endsWith('.ts') || relativePath.endsWith('.tsx'),
          commentCount: fileComments.length,
          todoCount: fileTodos.length,
        }
      );
      if (fileComments.length > 0) fileNode.comments = fileComments;
      if (fileTodos.length > 0) fileNode.todos = fileTodos;
      nodes.push(fileNode);

      this.processTreeSitterImportsForSingleFile(extraction, relativePath, fileId, nodes, edges, exitPoints, imports);
      const extractedFunctions = this.processTreeSitterFunctions(extraction, relativePath, fileId, nodes, edges, entryPoints);
      this.processTreeSitterClasses(extraction, relativePath, fileId, nodes, edges);
      this.processTreeSitterVariables(extraction, relativePath, fileId, nodes, edges);
      appendInMemoryRecordCollectionNodes(content, relativePath, fileId, nodes, edges, this.createNodeBuilder.bind(this), this.createEdge.bind(this));
      this.processTreeSitterExportsForSingleFile(extraction, relativePath, entryPoints, exports);

      return extractedFunctions;
    } catch (error) {
      console.warn(`Failed to process ${relativePath}:`, error);
      return [];
    }
  }

  private processTreeSitterImportsForSingleFile(
    extraction: TSFileExtraction,
    filePath: string,
    fileId: string,
    nodes: CASNode[],
    edges: CASEdge[],
    _exitPoints: CASExitPoint[],
    imports: string[]
  ): void {
    extraction.imports.forEach((imp, index) => {
      const importId = `import_${filePath}_${index}`;

      const specifiers = imp.specifiers.map(s => ({
        name: s.name,
        imported: s.imported || s.name
      }));

      specifiers.forEach(spec => {
        this.importSourceMap.set(spec.name, imp.source);
      });

      nodes.push(this.createNode(
        importId,
        `import ${imp.source}`,
        'import',
        3,
        filePath,
        imp.line,
        imp.line,
        { source: imp.source, specifiers, isTypeOnly: imp.isTypeOnly }
      ));

      edges.push(this.createEdge(
        `${fileId}_to_${importId}`,
        fileId,
        importId,
        'imports'
      ));

      if (imp.source.startsWith('.') || imp.source.startsWith('/')) {
        imports.push(imp.source);
      }
    });
  }

  private processTreeSitterExportsForSingleFile(
    extraction: TSFileExtraction,
    _filePath: string,
    _entryPoints: CASEntryPoint[],
    exports: string[]
  ): void {
    for (const exp of extraction.exports) {
      exports.push(exp.exportedName || exp.name);
      if (exp.isDefault) {
        this.importSourceMap.set('default', exp.name);
      }
    }
  }

  private integrateEnhancedCallGraphDataForSingleFile(
    extractedFunctions: TSExtractedFunction[],
    localNodes: CASNode[],
    resolutionNodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[],
    filePath: string
  ): void {
    this.buildNodeIndexes(resolutionNodes);
    this.callEdgeIds = new Set(edges.map(edge => edge.id));
    this.exitPointIds = new Set(exitPoints.map(exitPoint => exitPoint.id));
    this.callTargetResolutionCache.clear();
    this.integrateEnhancedCallGraphDataIndexed(
      extractedFunctions,
      localNodes,
      edges,
      entryPoints,
      exitPoints,
      filePath
    );
  }

  private processTreeSitterImports(
    extraction: TSFileExtraction,
    filePath: string,
    fileId: string,
    nodes: CASNode[],
    edges: CASEdge[],
    _exitPoints: CASExitPoint[]
  ): void {
    extraction.imports.forEach((imp, index) => {
      const importId = `import_${filePath}_${index}`;

      const specifiers = imp.specifiers.map(s => ({
        name: s.name,
        imported: s.imported || s.name
      }));

      specifiers.forEach(spec => {
        this.importSourceMap.set(spec.name, imp.source);
      });

      nodes.push(this.createNode(
        importId,
        `import ${imp.source}`,
        'import',
        3,
        filePath,
        imp.line,
        imp.line,
        { source: imp.source, specifiers, isTypeOnly: imp.isTypeOnly }
      ));

      edges.push(this.createEdge(
        `${fileId}_to_${importId}`,
        fileId,
        importId,
        'imports'
      ));
    });
  }

  private buildSignatureThrows(
    extracted: string[] | undefined,
    documentation?: CASDocumentation
  ): string[] | undefined {
    const types = new Set<string>();
    for (const t of extracted || []) {
      if (t) types.add(t);
    }
    for (const d of documentation?.throws || []) {
      if (d?.type) types.add(d.type);
    }
    return types.size > 0 ? Array.from(types) : undefined;
  }

  private processTreeSitterFunctions(
    extraction: TSFileExtraction,
    filePath: string,
    fileId: string,
    nodes: CASNode[],
    edges: CASEdge[],
    _entryPoints: CASEntryPoint[]
  ): TSExtractedFunction[] {
    const testSource = this.isTestSourcePath(filePath);
    const standaloneFunctions = extraction.functions.map(func => {
      if (!testSource || !func.isAnonymousCallback) return func;
      return {
        ...func,
        name: `test_callback_${func.lineStart}_${func.columnStart}`,
        isAnonymousCallback: false,
      };
    });
    const allFunctions: TSExtractedFunction[] = [
      ...standaloneFunctions,
      ...extraction.classes.flatMap(cls => cls.methods)
    ];

    standaloneFunctions.forEach((func, index) => {

      if ((func as any).isAnonymousCallback) return;

      const funcId = `function_${filePath}_${func.name}_${index}`;

      const documentation = func.documentation ? this.parseJSDoc(func.documentation, func.lineStart - 1, func.lineStart) : undefined;

      const node = this.createNodeBuilder(
        funcId,
        func.name,
        'function'
      )
        .withLevel(2, 'Class/Interface')
        .withCategory('functions', ['standalone'])
        .withSource({ file: filePath, line: func.lineStart, end_line: func.lineEnd })
        .withMetadata({
          is_exported: func.isExported,
          is_async: func.isAsync,
          is_generated: func.isGenerator,
          attributes: {
            functionType: func.type,
            hasDocumentation: !!documentation,
            complexity: func.complexity,
            decorators: func.decorators.length > 0 ? func.decorators : undefined,
            decoratorArgs: this.decoratorArgsAttribute(func.decoratorArgs)
          }
        })
        .withSignature({
          parameters: func.parameters.map(p => ({
            name: p.name,
            type: p.type,
            optional: p.optional,
            description: undefined
          })),
          return_type: func.returnType,
          throws: this.buildSignatureThrows((func as any).throws, documentation)
        })
        .withDocumentation(documentation)
        .build();

      nodes.push(node);

      edges.push(this.createEdge(
        `${fileId}_contains_${funcId}`,
        fileId,
        funcId,
        'contains'
      ));
    });

    return allFunctions;
  }

  private processTreeSitterClasses(
    extraction: TSFileExtraction,
    filePath: string,
    fileId: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    extraction.classes.forEach((cls, index) => {
      const classId = `class_${filePath}_${cls.name}_${index}`;
      const classType = this.determineClassTypeFromExtraction(cls, filePath);
      const subcategories = this.determineClassSubcategoriesFromExtraction(cls, filePath);
      const documentation = cls.documentation ? this.parseJSDoc(cls.documentation, cls.lineStart - 1, cls.lineStart) : undefined;
      const constructorMethod = cls.methods.find(method => method.type === 'constructor' || method.name === 'constructor');
      const dependencies = (constructorMethod?.parameters || [])
        .filter(param => param.name && param.type)
        .map(param => {
          const library = this.getLibraryForType(param.type!);
          this.classFieldTypes.set(`${cls.name}.${param.name}`, {
            typeName: param.type!,
            library,
            source: 'ctor',
            isCollection: this.isInMemoryCollectionType(param.type!)
          });
          if (this.isRepositoryLikeType(param.type!)) {
            this.repositoryPropertyTypes.set(param.name, param.type!);
          }
          return param.type!;
        });

      cls.properties.forEach(prop => {
        const key = `${cls.name}.${prop.name}`;
        if (this.classFieldTypes.has(key)) return;
        let rawType = prop.type;
        if (!rawType && prop.defaultValue) {
          const injectMatch = /^inject\s*\(\s*([A-Za-z_$][\w$.]*)/.exec(prop.defaultValue.trim());
          if (injectMatch) rawType = injectMatch[1];
        }
        const typeName = this.tsBaseTypeName(rawType);
        if (!typeName) return;
        const library = this.getLibraryForType(typeName);
        this.classFieldTypes.set(key, { typeName, library, source: 'field', isCollection: this.isInMemoryCollectionType(rawType) });

        if (!this.isInMemoryCollectionType(rawType) && this.isRepositoryLikeType(typeName)) {
          this.repositoryPropertyTypes.set(prop.name, typeName);
        }
      });

      const classNode = this.createNodeBuilder(
        classId,
        cls.name,
        classType
      )
        .withLevel(2, 'Class/Interface')
        .withCategory('structures', subcategories)
        .withSource({ file: filePath, line: cls.lineStart, end_line: cls.lineEnd })
        .withMetadata({
          is_exported: cls.isExported,
          is_abstract: cls.isAbstract,
          attributes: {
            extends: cls.extends,
            implements: cls.implements,
            methodCount: cls.methods.length,
            propertyCount: cls.properties.length,
            hasDocumentation: !!documentation,
            decorators: cls.decorators.length > 0 ? cls.decorators : undefined,
            decoratorArgs: this.decoratorArgsAttribute(cls.decoratorArgs),
            dependencies: dependencies.length > 0 ? dependencies : undefined
          }
        })
        .withDocumentation(documentation)
        .build();

      nodes.push(classNode);

      edges.push(this.createEdge(
        `${fileId}_contains_${classId}`,
        fileId,
        classId,
        'contains'
      ));

      cls.methods.forEach((method, methodIndex) => {
        const methodId = `method_${classId}_${method.name}_${methodIndex}`;
        const methodDoc = method.documentation ? this.parseJSDoc(method.documentation, method.lineStart - 1, method.lineStart) : undefined;

        const methodNode = this.createNodeBuilder(
          methodId,
          method.name,
          'method'
        )
          .withLevel(3, 'Method/Function')
          .withCategory('methods', ['class-methods'])
          .withSource({ file: filePath, line: method.lineStart, end_line: method.lineEnd })
          .withMetadata({
            is_async: method.isAsync,
            is_generated: method.isGenerator,
            is_static: method.isStatic,
            attributes: {
              methodType: method.type,
              hasDocumentation: !!methodDoc,
              complexity: method.complexity,
              decorators: method.decorators.length > 0 ? method.decorators : undefined,
              decoratorArgs: this.decoratorArgsAttribute(method.decoratorArgs)
            }
          })
          .withSignature({
            parameters: method.parameters.map(p => ({
              name: p.name,
              type: p.type,
              optional: p.optional,
              description: undefined
            })),
            return_type: method.returnType,
            throws: this.buildSignatureThrows((method as any).throws, methodDoc)
          })
          .withParent(classId)
          .withDocumentation(methodDoc)
          .build();

        nodes.push(methodNode);

        edges.push(this.createEdge(
          `${classId}_contains_${methodId}`,
          classId,
          methodId,
          'contains'
        ));
      });

      cls.properties.forEach((prop, propIndex) => {
        const propId = `property_${classId}_${prop.name}_${propIndex}`;

        nodes.push(this.createNode(
          propId,
          prop.name,
          'property',
          3,
          filePath,
          prop.lineStart,
          prop.lineEnd,
          {
            type: prop.type,
            isStatic: prop.isStatic,
            isPrivate: prop.isPrivate,
            isReadonly: prop.isReadonly,
            isOptional: prop.isOptional,
            defaultValue: prop.defaultValue,
            decorators: prop.decorators.length > 0 ? prop.decorators : undefined,
            decoratorArgs: this.decoratorArgsAttribute(prop.decoratorArgs)
          }
        ));
      });
    });
  }

  private processTreeSitterVariables(
    extraction: TSFileExtraction,
    filePath: string,
    fileId: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    extraction.variables.forEach((variable, index) => {
      const varId = `variable_${filePath.replace(/[^a-zA-Z0-9]/g, '_')}_${variable.name.replace(/[^a-zA-Z0-9]/g, '_')}_${index}`;

      nodes.push(this.createNode(
        varId,
        variable.name,
        'variable',
        3,
        filePath,
        variable.line,
        variable.line,
        {
          type: variable.type,
          kind: variable.kind,

          is_exported: variable.isExported,
          value: variable.value?.substring(0, 100)
        }
      ));

      edges.push(this.createEdge(
        `${fileId}_contains_${varId}`,
        fileId,
        varId,
        'contains'
      ));
    });
  }

  private processTreeSitterExports(
    extraction: TSFileExtraction,
    _filePath: string,
    _entryPoints: CASEntryPoint[]
  ): void {
    for (const exp of extraction.exports) {
      if (exp.isDefault) {
        this.importSourceMap.set('default', exp.name);
      }
    }
  }

  private decoratorArgsAttribute(decoratorArgs?: TSDecoratorDetail[]): TSDecoratorDetail[] | undefined {
    const withArgs = (decoratorArgs || []).filter(d => d.args.length > 0);
    return withArgs.length > 0 ? withArgs : undefined;
  }

  private determineClassTypeFromExtraction(cls: TSExtractedClass, filePath: string): string {
    const decorators = cls.decorators || [];

    if (decorators.includes('Controller') || decorators.includes('Resolver')) return 'controller';
    if (decorators.includes('Injectable') || decorators.includes('Service')) return 'service';
    if (decorators.includes('Entity') || decorators.includes('Schema')) return 'entity';
    if (decorators.includes('Module')) return 'module';

    if (this.isDtoLikeClass(cls.name, filePath)) return 'dto';
    if (cls.kind === 'interface') return 'interface';
    if (cls.kind === 'type') return 'type';
    if (filePath.includes('/controllers/') || filePath.includes('.controller.')) return 'controller';
    if (filePath.includes('/services/') || filePath.includes('.service.')) return 'service';
    if (filePath.includes('/entities/') || filePath.includes('.entity.')) return 'entity';
    if (filePath.includes('/repositories/') || filePath.includes('.repository.')) return 'repository';

    return 'class';
  }

  private determineClassSubcategoriesFromExtraction(cls: TSExtractedClass, _filePath: string): string[] {
    const subcategories: string[] = [];
    const decorators = cls.decorators || [];

    if (decorators.includes('Controller')) subcategories.push('nestjs-controller');
    if (decorators.includes('Injectable')) subcategories.push('nestjs-injectable');
    if (decorators.includes('Entity')) subcategories.push('orm-entity');
    if (decorators.includes('Module')) subcategories.push('nestjs-module');

    if (cls.isAbstract) subcategories.push('abstract');
    if (cls.extends) subcategories.push('derived');
    if (cls.implements.length > 0) subcategories.push('implements-interface');

    if (subcategories.length === 0) subcategories.push('general');

    return subcategories;
  }

  private buildNodeIndexes(nodes: CASNode[]): void {
    this.nodeById.clear();
    this.nodesByName.clear();
    this.methodsByParent.clear();
    this.importsByConsumerFile.clear();

    for (const node of nodes) {
      this.nodeById.set(node.id, node);

      if (!this.nodesByName.has(node.name)) {
        this.nodesByName.set(node.name, []);
      }
      this.nodesByName.get(node.name)!.push(node);

      if (node.parent && (node.type === 'method' || node.type === 'function')) {
        if (!this.methodsByParent.has(node.parent)) {
          this.methodsByParent.set(node.parent, []);
        }
        this.methodsByParent.get(node.parent)!.push(node);
      }

      if (node.type === 'import') {
        this.indexImportNode(node);
      }
    }
  }

  private indexImportNode(node: CASNode): void {
    const consumerFile = node.source?.file;
    if (!consumerFile) return;
    const meta = node.metadata as { source?: string; specifiers?: Array<{ name?: string }> } | undefined;
    const importSource = meta?.source;
    const specifiers = meta?.specifiers;
    if (!importSource || !Array.isArray(specifiers) || specifiers.length === 0) return;

    let resolvedModule = importSource;
    if (importSource.startsWith('.') || importSource.startsWith('/')) {
      const absConsumer = path.isAbsolute(consumerFile)
        ? consumerFile
        : path.join(this.currentProjectPath, consumerFile);
      const resolved = this.resolveImportPath(importSource, absConsumer, this.currentProjectPath);
      if (resolved) resolvedModule = resolved;
    }

    let fileMap = this.importsByConsumerFile.get(consumerFile);
    if (!fileMap) {
      fileMap = new Map<string, string>();
      this.importsByConsumerFile.set(consumerFile, fileMap);
    }
    for (const spec of specifiers) {
      if (spec?.name) fileMap.set(spec.name, resolvedModule);
    }
  }

  private selectDeclarationCandidate(
    candidates: CASNode[],
    targetName: string,
    sourceFile?: string
  ): CASNode {
    if (candidates.length === 1) return candidates[0];

    if (sourceFile) {
      const inSourceFile = candidates.filter(node => node.source?.file === sourceFile).sort(this.compareNodesStable);
      if (inSourceFile.length > 0) return inSourceFile[0];
      const resolvedModule = this.importsByConsumerFile.get(sourceFile)?.get(targetName);
      if (resolvedModule) {
        const inModule = candidates
          .filter(n => n.source?.file === resolvedModule)
          .sort(this.compareNodesStable);
        if (inModule.length > 0) return inModule[0];
      }
    }

    return [...candidates].sort(this.compareNodesStable)[0];
  }

  private compareNodesStable = (a: CASNode, b: CASNode): number => {
    const fileA = a.source?.file ?? '';
    const fileB = b.source?.file ?? '';
    if (fileA !== fileB) return fileA < fileB ? -1 : 1;
    const lineA = a.source?.line ?? 0;
    const lineB = b.source?.line ?? 0;
    if (lineA !== lineB) return lineA - lineB;
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return 0;
  };

  private isClassLikeNode(node?: CASNode): boolean {
    if (!node) return false;
    return ['class', 'service', 'controller', 'repository', 'guard', 'middleware', 'gateway', 'provider'].includes(node.type);
  }

  private addCallEdge(edges: CASEdge[], edge: CASEdge): void {
    if (this.callEdgeIds.has(edge.id)) return;
    this.callEdgeIds.add(edge.id);
    edges.push(edge);
  }

  private addExitPoint(exitPoints: CASExitPoint[], exitPoint: CASExitPoint): void {
    if (this.exitPointIds.has(exitPoint.id)) return;
    this.exitPointIds.add(exitPoint.id);
    exitPoints.push(exitPoint);
  }

  private isRepositoryLikeType(typeName: string): boolean {
    if (this.isInMemoryCollectionType(typeName)) return false;
    const lower = typeName.toLowerCase();
    return lower.includes('repository') ||
      lower.includes('prismaclient') ||
      lower.includes('entitymanager') ||
      lower.includes('model') ||
      lower.includes('database') ||
      lower.includes('knex');
  }

  private isInMemoryCollectionType(rawType?: string): boolean {
    if (!rawType) return false;
    const type = rawType.trim();
    if (/^readonly\s/i.test(type)) return true;
    if (/\[\s*\]\s*$/.test(type)) return true;
    return /^(Array|ReadonlyArray|Set|ReadonlySet|Map|ReadonlyMap|WeakSet|WeakMap|Record|Iterable|IterableIterator|AsyncIterable|Generator)\s*</.test(type);
  }

  private findNodeIdByNameIndexed(targetName: string, sourceFile?: string, sourceClassName?: string): string | undefined {

    const isThisCall = targetName.startsWith('this.') || targetName.startsWith('self.');
    const isAmbiguousBareName = !isThisCall && (this.nodesByName.get(targetName)?.length ?? 0) > 1;
    const cacheKey = (isThisCall || isAmbiguousBareName)
      ? `${sourceFile}::${sourceClassName}::${targetName}`
      : targetName;
    if (this.callTargetResolutionCache.has(cacheKey)) {
      return this.callTargetResolutionCache.get(cacheKey);
    }
    const resolved = this.findNodeIdByNameIndexedUncached(targetName, sourceFile, sourceClassName);
    this.callTargetResolutionCache.set(cacheKey, resolved);
    return resolved;
  }

  private findNodeIdByNameIndexedUncached(targetName: string, sourceFile?: string, sourceClassName?: string): string | undefined {

    if (this.hasUnresolvedReceiver(targetName)) return undefined;

    const thisMethodMatch = /^(?:this|self)\.([A-Za-z_$][\w$]*)$/.exec(targetName);
    if (thisMethodMatch) {
      const methodName = thisMethodMatch[1];
      const candidates = this.nodesByName.get(methodName)?.filter(n => n.type === 'method') || [];
      if (candidates.length > 0) {
        if (sourceClassName) {
          const inClass = candidates.find(n => {
            const parent = n.parent ? this.nodeById.get(n.parent) : undefined;
            return parent?.name === sourceClassName;
          });
          if (inClass) return inClass.id;
        }
        const inFile = candidates.find(n => n.source?.file === sourceFile);
        if (inFile) return inFile.id;
        return candidates[0].id;
      }
      return undefined;
    }
    if (this.isRepositoryCall(targetName, sourceClassName)) {
      const parts = targetName.split('.');
      if (parts.length >= 3 && parts[0] === 'this') {
        const repositoryProperty = parts[1];
        const methodName = parts.slice(2).join('.');

        const repositoryClassName = this.getRepositoryClassNameFromProperty(repositoryProperty);
        if (repositoryClassName) {
          const classNodes = this.nodesByName.get(repositoryClassName);
          if (classNodes) {
            for (const classNode of classNodes) {
              if (this.isClassLikeNode(classNode)) {
                const methods = this.methodsByParent.get(classNode.id);
                if (methods) {
                  const methodNode = methods.find(m => m.name === methodName);
                  if (methodNode) return methodNode.id;
                }
              }
            }
          }
        }
      }
      return undefined;
    }

    const directMatch = this.nodesByName.get(targetName);
    if (directMatch && directMatch.length > 0) {

      return this.selectDeclarationCandidate(directMatch, targetName, sourceFile).id;
    }

    if (!targetName.includes('.')) {
      if (directMatch) {
        const funcOrMethod = directMatch.find(n => n.type === 'function' || n.type === 'method');
        return funcOrMethod?.id;
      }
      return undefined;
    }

    const parts = targetName.split('.');
    const methodName = parts.pop();
    if (!methodName) return undefined;

    if (parts[0] === 'this' && parts.length >= 2) {
      const propertyName = parts[1];
      const expectedClassName = this.propertyNameToClassName(propertyName);

      const methodNodes = this.nodesByName.get(methodName);
      if (methodNodes) {
        for (const methodNode of methodNodes) {
          if (methodNode.type !== 'method' || !methodNode.parent) continue;
          const parentClass = this.nodeById.get(methodNode.parent);
          if (!parentClass || !this.isClassLikeNode(parentClass)) continue;
          if (parentClass.name.toLowerCase() === expectedClassName.toLowerCase() ||
              parentClass.name.toLowerCase().includes(propertyName.toLowerCase())) {
            return methodNode.id;
          }
        }
      }

      const classNodes = this.nodesByName.get(expectedClassName);
      if (classNodes) {
        for (const classNode of classNodes) {
          if (this.isClassLikeNode(classNode)) {
            const methods = this.methodsByParent.get(classNode.id);
            if (methods) {
              const methodNode = methods.find(m => m.name === methodName);
              if (methodNode) return methodNode.id;
            }
          }
        }
      }
    }

    const objectName = parts.join('.').toLowerCase().replace('this.', '');
    const methodNodes = this.nodesByName.get(methodName);
    if (methodNodes) {
      for (const methodNode of methodNodes) {
        if (methodNode.type !== 'method' || !methodNode.parent) continue;
        const parentClass = this.nodeById.get(methodNode.parent);
        if (!parentClass || !this.isClassLikeNode(parentClass)) continue;
        if (parentClass.name.toLowerCase().includes(objectName)) {
          return methodNode.id;
        }
      }
    }

    return undefined;
  }

  private resolveTypedReceiverCall(target: string, func: any): string | undefined {
    if (!target || typeof target !== 'string') return undefined;
    const dot = target.indexOf('.');
    if (dot <= 0 || target.indexOf('.') !== target.lastIndexOf('.')) return undefined;
    const recv = target.slice(0, dot);
    const methodName = target.slice(dot + 1);
    if (!methodName || recv === 'this' || recv === 'self') return undefined;
    const params = func && func.parameters;
    if (!Array.isArray(params)) return undefined;
    const p = params.find((pp: any) => pp && pp.name === recv);
    if (!p || !p.type) return undefined;
    const m = /^([A-Za-z_$][\w$]*)/.exec(String(p.type).trim());
    if (!m) return undefined;
    const className = this.importAliasMap.get(m[1]) || m[1];
    const classNodes = this.nodesByName.get(className);
    if (!classNodes) return undefined;
    for (const classNode of classNodes) {
      if (!this.isClassLikeNode(classNode)) continue;
      const methodNode = this.methodsByParent.get(classNode.id)?.find(mm => mm.name === methodName);
      if (methodNode) return methodNode.id;
    }
    return undefined;
  }

  private tsBaseTypeName(raw?: string): string | undefined {
    if (!raw) return undefined;
    let t = raw.trim().replace(/^\?/, '').split('|')[0].trim();
    const generic = t.indexOf('<');
    if (generic >= 0) t = t.slice(0, generic);
    t = t.replace(/\[\]$/, '').trim();
    const parts = t.split('.');
    t = parts[parts.length - 1];
    return /^[A-Za-z_$][\w$]*$/.test(t) ? t : undefined;
  }

  private resolveDiFieldCall(target: string, func: any, sourceFile?: string): string[] | undefined {
    if (!target || typeof target !== 'string') return undefined;
    const parts = target.split('.');
    if (parts.length !== 3) return undefined;
    const [recv, field, methodName] = parts;
    if ((recv !== 'this' && recv !== 'self') || !field || !methodName) return undefined;

    const sourceClassName = func?.className;
    if (!sourceClassName) return undefined;

    const fieldInfo = this.classFieldTypes.get(`${sourceClassName}.${field}`);
    if (!fieldInfo || !fieldInfo.typeName) return undefined;

    const m = /^([A-Za-z_$][\w$]*)/.exec(String(fieldInfo.typeName).trim());
    if (!m) return undefined;
    const className = this.importAliasMap.get(m[1]) || m[1];
    if (className === sourceClassName) return undefined;

    const classNodes = this.nodesByName.get(className);
    if (!classNodes) return undefined;

    let candidateClassNodes = classNodes.filter(n => this.isClassLikeNode(n));
    if (candidateClassNodes.length === 0) return undefined;

    if (candidateClassNodes.length > 1 && fieldInfo.source === 'field') {
      const resolvedModule = sourceFile ? this.importsByConsumerFile.get(sourceFile)?.get(m[1]) : undefined;
      if (!resolvedModule) return undefined;
      const narrowed = candidateClassNodes.filter(n => n.source?.file === resolvedModule);
      if (narrowed.length !== 1) return undefined;
      candidateClassNodes = narrowed;
    }

    const resolvedMethodIds: string[] = [];
    for (const classNode of candidateClassNodes) {
      const methodNode = this.methodsByParent.get(classNode.id)?.find(mm => mm.name === methodName);
      if (methodNode) resolvedMethodIds.push(methodNode.id);
    }
    return resolvedMethodIds.length > 0 ? resolvedMethodIds : undefined;
  }

  private resolveAnonymousContainerNodeIdIndexed(
    filePath: string,
    func: ExtractedFunction
  ): string | undefined {
    if (!func || func.name !== 'anonymous') return undefined;
    const fileId = `file_${filePath.replace(/[^a-zA-Z0-9]/g, '_')}`;
    return this.nodeById.has(fileId) ? fileId : undefined;
  }

  private resolveSourceNodeIdIndexed(
    filePath: string,
    func: ExtractedFunction
  ): string | undefined {
    if (func.className) {
      const classId = `class_${filePath}_${func.className}_0`;
      const methods = this.methodsByParent.get(classId);
      if (methods) {
        const methodNode = methods.find(n => n.name === func.name);
        if (methodNode) return methodNode.id;
      }

      const classNode = this.nodeById.get(classId);
      if (classNode) {
        if (methods && methods.length > 0) {
          return methods[0].id;
        }
      }
    }

    const funcId = `function_${filePath}_${func.name}_${func.lineStart}`;
    if (this.nodeById.has(funcId)) {
      return funcId;
    }

    const funcs = this.nodesByName.get(func.name);
    if (funcs) {
      const match = funcs.find(n =>
        (n.type === 'function' || n.type === 'method') &&
        n.source?.file === filePath
      );
      if (match) return match.id;
    }

    return undefined;
  }

  private integrateEnhancedCallGraphDataIndexed(
    extractedFunctions: any[],
    _nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[],
    filePath: string
  ): void {
    let t = Date.now();
    extractedFunctions.forEach(func => {
      const sourceNodeId = this.resolveSourceNodeIdIndexed(filePath, func);
      this.addConstructedEntityPersistEdges(edges, sourceNodeId, func);
      func.calls.forEach((call: any) => {

        const typedTargetId = this.resolveTypedReceiverCall(call.target, func);

        const diTargetIds = typedTargetId ? undefined : this.resolveDiFieldCall(call.target, func, filePath);
        if (call.httpMethod && call.httpPath) {
          if (sourceNodeId) {
            entryPoints.push({
              id: `http_${func.name}_${call.httpMethod}`,
              source_node: sourceNodeId,
              type: 'http',
              name: `${call.httpMethod} ${call.httpPath}`,
              trigger: {
                method: call.httpMethod,
                path: call.httpPath
              },
              metadata: {
                decorators: call.decorators,
                framework: 'nestjs'
              }
            });
          }
        }

        if (call.targetType === 'abstract') {
          const targetNodeId = typedTargetId || this.findNodeIdByNameIndexed(call.target, filePath, func.className);

          if (sourceNodeId && targetNodeId) {
            this.addCallEdge(edges, {
              id: `abstract_call_${sourceNodeId}_${targetNodeId}`,
              source: sourceNodeId,
              target: targetNodeId,
              type: 'calls',
              metadata: {
                attributes: {
                  call_type: 'abstract',
                  is_async: call.isAsync,
                  line: call.line,
                  method_name: call.target.split('.').pop()
                }
              }
            });
          }
        }

        if (call.injectionType) {
          const targetNodeId = typedTargetId || this.findNodeIdByNameIndexed(call.target, filePath, func.className);

          if (sourceNodeId && targetNodeId) {
            this.addCallEdge(edges, {
              id: `injection_${sourceNodeId}_${targetNodeId}`,
              source: sourceNodeId,
              target: targetNodeId,
              type: 'calls',
              metadata: {
                attributes: {
                  call_type: 'injection',
                  injection_type: call.injectionType,
                  line: call.line
                }
              }
            });
          }
        }

        if (call.targetType === 'method' || call.targetType === 'function') {

          const unambiguousDiTargetId = diTargetIds && diTargetIds.length === 1 ? diTargetIds[0] : undefined;
          const targetNodeId = typedTargetId || unambiguousDiTargetId ||
            (diTargetIds ? undefined : this.findNodeIdByNameIndexed(call.target, filePath, func.className));

          if (sourceNodeId && targetNodeId && sourceNodeId !== targetNodeId) {
            this.addCallEdge(edges, {
              id: `call_${sourceNodeId}_${targetNodeId}`,
              source: sourceNodeId,
              target: targetNodeId,
              type: 'calls',
              metadata: {
                attributes: {
                  call_type: call.targetType,
                  resolution_type: unambiguousDiTargetId ? 'di_field' : undefined,
                  is_async: call.isAsync,
                  is_conditional: call.isConditional,
                  is_in_loop: call.isInLoop,
                  line: call.line,
                  method_name: call.target.split('.').pop()
                }
              }
            });
          } else if (sourceNodeId && !targetNodeId && diTargetIds && diTargetIds.length > 1) {
            for (const diTargetId of diTargetIds) {
              if (diTargetId === sourceNodeId) continue;
              this.addCallEdge(edges, {
                id: `di_call_${sourceNodeId}_${diTargetId}`,
                source: sourceNodeId,
                target: diTargetId,
                type: 'calls',
                metadata: {
                  attributes: {
                    call_type: call.targetType,
                    resolution_type: 'di_field',
                    is_async: call.isAsync,
                    is_conditional: call.isConditional,
                    is_in_loop: call.isInLoop,
                    line: call.line,
                    method_name: call.target.split('.').pop(),
                    ambiguous: diTargetIds.length > 1
                  }
                }
              });
            }
          } else if (sourceNodeId && !targetNodeId && this.isRepositoryCall(call.target, func.className)) {
            const repoInfo = this.parseRepositoryCall(call.target);
            if (repoInfo) {
              const library = this.getLibraryForType('EntityRepository')
                || this.getLibraryForType('Repository')
                || this.getLibraryForType('PrismaClient')
                || this.getLibraryForType('Model');
              const exitPointId = `exit_db_${func.name}_${repoInfo.method}_${call.line}`;
              this.addExitPoint(exitPoints, {
                  id: exitPointId,
                  source_node: sourceNodeId,
                  type: 'database',
                  name: `${repoInfo.repository}.${repoInfo.method}`,
                  target: {
                    service_id: 'database',
                    resource: repoInfo.repository
                  },
                  operation: {
                    action: repoInfo.method,
                    async: call.isAsync
                  },
                  metadata: {
                    repository: repoInfo.repository,
                    method: repoInfo.method,
                    line: call.line,
                    call_expression: call.callExpression,
                    library
                  }
                });
              this.addCallEdge(edges, {
                id: `call_${sourceNodeId}_${exitPointId}`,
                source: sourceNodeId,
                target: exitPointId,
                type: 'calls',
                category: 'behavior',
                metadata: {
                  attributes: {
                    call_type: 'method',
                    resolution_type: 'external',
                    target_type: 'database',
                    target_object: repoInfo.repository,
                    method_name: repoInfo.method,
                    library,
                    is_async: call.isAsync,
                    is_conditional: call.isConditional,
                    is_in_loop: call.isInLoop,
                    line: call.line,
                    call_expression: call.callExpression
                  }
                }
              });
            }
          } else if (!targetNodeId && (sourceNodeId || this.resolveAnonymousContainerNodeIdIndexed(filePath, func)) && this.isApiCall(call.target, call.callExpression)) {

            const apiSourceNodeId = sourceNodeId || this.resolveAnonymousContainerNodeIdIndexed(filePath, func)!;
            const apiInfo = this.parseApiCall(call.target, call.callExpression);
            if (apiInfo) {
              const exitPointId = `exit_api_${func.name}_${apiInfo.method}_${call.line}`;
              this.addExitPoint(exitPoints, {
                  id: exitPointId,
                  source_node: apiSourceNodeId,
                  type: 'api',
                  name: `${apiInfo.method.toUpperCase()} ${apiInfo.endpoint || 'external'}`,
                  target: {
                    service_id: 'external_api',
                    endpoint: apiInfo.endpoint
                  },
                  operation: {
                    method: apiInfo.method.toUpperCase(),
                    action: apiInfo.method,
                    async: call.isAsync
                  },
                  metadata: {
                    line: call.line,
                    call_expression: call.callExpression,
                    endpoint: apiInfo.endpoint
                  }
                });
              this.addCallEdge(edges, {
                id: `call_${apiSourceNodeId}_${exitPointId}`,
                source: apiSourceNodeId,
                target: exitPointId,
                type: 'calls',
                category: 'behavior',
                metadata: {
                  attributes: {
                    call_type: 'direct',
                    resolution_type: 'external',
                    target_type: 'api',
                    method_name: apiInfo.method,
                    endpoint: apiInfo.endpoint,
                    is_async: call.isAsync,
                    is_conditional: call.isConditional,
                    is_in_loop: call.isInLoop,
                    line: call.line,
                    call_expression: call.callExpression
                  }
                }
              });
            }
          }
          if (sourceNodeId && !targetNodeId) {
            this.addEntityAccessEdge(edges, sourceNodeId, call, func, filePath);
          }
        } else if (call.targetType === 'property' && call.argumentCount === 0 && !call.httpMethod) {

          const targetNodeId = this.findNodeIdByNameIndexed(call.target, filePath, func.className);
          if (sourceNodeId && targetNodeId && sourceNodeId !== targetNodeId) {
            this.addCallEdge(edges, {
              id: `reference_${sourceNodeId}_${targetNodeId}_${call.line}`,
              source: sourceNodeId,
              target: targetNodeId,
              type: 'references',
              metadata: {
                attributes: {
                  reference_type: 'identifier',
                  is_conditional: call.isConditional,
                  is_in_loop: call.isInLoop,
                  line: call.line
                }
              }
            });
          }
        } else if (sourceNodeId && (call.targetType === 'external' || call.targetType === 'library')) {
          const library = this.getLibraryForType(call.target) || this.importSourceMap.get(call.target) || call.target;
          const exitPointId = `exit_sdk_${func.name}_${call.target}_${call.line}`.replace(/[^a-zA-Z0-9_]/g, '_');
          this.addExitPoint(exitPoints, {
              id: exitPointId,
              source_node: sourceNodeId,
              type: 'sdk',
              name: `Call to ${call.target}`,
              target: {
                sdk: library,
                endpoint: call.target
              },
              operation: {
                action: call.target,
                async: call.isAsync
              },
              metadata: {
                line: call.line,
                library,
                call_expression: call.callExpression
              }
            } as CASExitPoint);
          this.addCallEdge(edges, {
            id: `call_${sourceNodeId}_${exitPointId}`,
            source: sourceNodeId,
            target: exitPointId,
            type: 'calls',
            category: 'behavior',
            metadata: {
              attributes: {
                call_type: call.targetType === 'library' ? 'method' : 'direct',
                resolution_type: 'external',
                target_type: 'sdk',
                method_name: call.target.split('.').pop(),
                library,
                is_async: call.isAsync,
                is_conditional: call.isConditional,
                is_in_loop: call.isInLoop,
                line: call.line,
                call_expression: call.callExpression
              }
            }
          });
        }
      });
    });
    this.processTimings['integrateCallGraph'] = (this.processTimings['integrateCallGraph'] || 0) + (Date.now() - t);
  }

  public getProcessTimings(): Record<string, number> {
    return this.processTimings;
  }

  public resetProcessTimings(): void {
    this.processTimings = {};
  }

  private isDtoLikeClass(className: string, filePath: string): boolean {
    const normalizedName = className.toLowerCase();
    const normalizedPath = filePath.toLowerCase();
    return /(dto|input|output|request|response|payload|params|query|body|schema)$/.test(normalizedName) ||
      /(^|[/._-])(dto|dtos|inputs|outputs|requests|responses|schemas)([/._-]|$)/.test(normalizedPath) ||
      /\.(dto|input|output|request|response|schema)\./.test(normalizedPath);
  }

  private extractLibraries(packageJson: any, libraries: any[]): void {
    const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };

    Object.entries(deps).forEach(([name, version]) => {
      libraries.push({
        name,
        version: version as string,
        type: 'npm_package',
        source: 'package.json',
        metadata: {
          isDev: !!packageJson.devDependencies?.[name],
          isProduction: !!packageJson.dependencies?.[name]
        }
      });
    });
  }

  private buildEnhancedCallGraph(nodes: CASNode[], edges: CASEdge[], entryPoints: CASEntryPoint[], exitPoints: CASExitPoint[]): void {
    this.validateCallGraph(nodes, edges);
    this.enrichNodesWithCallData(nodes, edges);
  }

  private detectServerEntryPoints(sourceFiles: string[], nodes: CASNode[], entryPoints: CASEntryPoint[], projectPath: string): void {
    const existingEntryPointIds = new Set(entryPoints.map(ep => ep.id));
    const serverFilePattern = /^(src\/)?((server|index)\.(ts|js))$/;

    for (const file of sourceFiles) {
      if (!serverFilePattern.test(file)) continue;

      const cached = this.astCache.get(file);
      if (!cached) continue;

      if (!(/\.listen\s*\(/.test(cached.content) || /createServer\s*\(/.test(cached.content))) continue;

      const nodeId = this.findFileNodeId(file, nodes);
      if (!nodeId) continue;

      const entryId = `entry_server_${file.replace(/[^a-zA-Z0-9]/g, '_')}`;
      if (existingEntryPointIds.has(entryId)) continue;

      entryPoints.push({
        id: entryId,
        source_node: nodeId,
        type: 'http',
        name: `SERVER ${path.basename(file)}`,
        trigger: {
          path: '/'
        },
        metadata: {
          serverFile: file
        }
      });
      existingEntryPointIds.add(entryId);
    }
  }

  private findFileNodeId(relativePath: string, nodes: CASNode[]): string | undefined {
    const fileId = `file_${relativePath.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const found = nodes.find(n => n.id === fileId);
    return found?.id;
  }

  private isRepositoryCall(target: string, className?: string): boolean {
    if (!target.includes('.')) return false;

    if (this.hasUnresolvedReceiver(target)) return false;
    const parts = target.split('.');
    const methodName = (parts.pop() || '').toLowerCase();
    const isThisQualified = target.startsWith('this.') || target.startsWith('self.');
    const originalCallerName = parts.join('.').replace('this.', '');
    const callerName = originalCallerName.toLowerCase();

    if (!TypeScriptJavaScriptAnalyzer.PERSISTENCE_OPERATIONS.has(methodName)) return false;

    const lastProperty = originalCallerName.split('.').pop() || originalCallerName;
    const declaredField = className ? this.classFieldTypes.get(`${className}.${lastProperty}`) : undefined;
    if (declaredField?.typeName) {

      if (declaredField.isCollection) return false;
      return this.isRepositoryLikeType(declaredField.typeName);
    }

    if (isThisQualified) {
      const injectedFieldType = this.repositoryPropertyTypes.get(lastProperty);
      if (injectedFieldType) return this.isRepositoryLikeType(injectedFieldType);
    }

    return this.isRepositoryLikeCaller(callerName) || this.isModelLikeCaller(originalCallerName);
  }

  private static readonly PERSISTENCE_OPERATIONS = new Set([

    'findoneorfail', 'findall', 'findandcount',
    'persistandflush', 'removeandflush', 'nativeupdate', 'nativedelete',
    'getreference', 'populate', 'assign', 'flush', 'upsert', 'persist',
    'findunique', 'findfirst', 'findmany', 'createmany', 'updatemany',
    'deletemany', 'aggregate', 'groupby',
    'findbyid', 'findbyidandupdate', 'findbyidanddelete', 'findbyidandremove',
    'findoneandupdate', 'findoneanddelete', 'findoneandremove',
    'updateone', 'deleteone', 'insertmany',

    'prepare', 'exec', 'execute', 'query', 'raw', 'pragma',
    'transaction', 'begintransaction', 'commit', 'rollback',
    'createquerybuilder', 'getrepository', 'getentitymanager',
    'select', 'insertinto', 'deletefrom', 'truncate',
    'connect', 'disconnect', 'close', 'destroy',

    'find', 'findone', 'create', 'save', 'insert',
    'update', 'delete', 'remove', 'count'

  ]);

  private isModelLikeCaller(callerName: string): boolean {
    const lastPart = callerName.split('.').pop() || '';
    if (!/^[A-Z][A-Za-z0-9_]*$/.test(lastPart)) return false;
    if (/^[A-Z0-9_]+$/.test(lastPart)) return false;

    const declarations = this.nodesByName.get(lastPart) || [];
    if (declarations.length > 0 &&
        declarations.every(node => TypeScriptJavaScriptAnalyzer.VALUE_DECLARATION_TYPES.has(node.type))) {
      return false;
    }
    return true;
  }

  private static readonly VALUE_DECLARATION_TYPES = new Set([
    'variable', 'constant', 'property', 'parameter', 'field', 'enum'
  ]);

  private isRepositoryLikeCaller(callerName: string): boolean {

    if (/^wrap\(/.test(callerName)) return true;

    const parts = callerName.split('.');
    const exactMatchPatterns = new Set([
      'em', 'db', 'orm', 'repo', 'model', 'knex', 'table', 'schema', 'query'
    ]);
    const substringPatterns = [
      'repository', 'entity', 'collection', 'prisma', 'manager',
      'connection', 'sequelize', 'drizzle', 'database'
    ];
    for (const part of parts) {
      if (exactMatchPatterns.has(part)) return true;
      if (substringPatterns.some(pattern => part.includes(pattern))) return true;

      if (/repo$/.test(part) && part !== 'repo' && !/forrepo$/.test(part)) return true;
    }
    return false;
  }

  private hasUnresolvedReceiver(target: string): boolean {
    return target.startsWith(`${UNRESOLVED_RECEIVER}.`);
  }

  private isApiCall(target: string, callExpression: string): boolean {

    if (this.hasUnresolvedReceiver(target)) return false;
    const lowerTarget = target.toLowerCase();
    const lowerExpression = callExpression.toLowerCase();

    if (lowerTarget === 'fetch' || lowerExpression.startsWith('fetch(')) return true;

    const httpClientPatterns = ['axios', 'api', 'http', 'apiclient', 'httpclient', 'request'];
    const httpMethods = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'request'];

    if (target.includes('.')) {
      const parts = target.split('.');
      const method = (parts.pop() || '').toLowerCase();
      const caller = parts.pop()?.toLowerCase().replace('this.', '') || '';
      if (httpMethods.includes(method) && httpClientPatterns.some(p => caller.includes(p))) {
        return true;
      }

      const routeRegistrarCallers = new Set(['router', 'app', 'server', 'express', 'fastify', 'koa']);
      if (httpMethods.includes(method) && !routeRegistrarCallers.has(caller)) {
        const endpoint = this.extractEndpointFromExpression(callExpression);
        if (endpoint && /^(https?:\/\/|\/[A-Za-z0-9_\-.:[\]{}$])/.test(endpoint)) {
          return true;
        }
      }
    }

    return false;
  }

  private parseApiCall(target: string, callExpression: string): { method: string; endpoint?: string } | null {
    const lowerTarget = target.toLowerCase();

    if (lowerTarget === 'fetch' || callExpression.toLowerCase().startsWith('fetch(')) {
      const endpoint = this.extractEndpointFromExpression(callExpression);
      return { method: 'fetch', endpoint };
    }

    if (target.includes('.')) {
      const parts = target.split('.');
      const method = parts.pop() || '';

      if (method.toLowerCase() === 'request') {
        const literals = this.extractStringLiteralsFromExpression(callExpression);
        if (literals.length >= 2) return { method: literals[0], endpoint: literals[1] };
        if (literals.length === 1) return { method, endpoint: literals[0] };
      }
      const endpoint = this.extractEndpointFromExpression(callExpression);
      return { method, endpoint };
    }

    return null;
  }

  private extractEndpointFromExpression(callExpression: string): string | undefined {
    const stringMatch = callExpression.match(/['"`]([^'"`]+)['"`]/);
    if (stringMatch) return stringMatch[1];

    const templateMatch = callExpression.match(/`([^`]+)`/);
    if (templateMatch) return templateMatch[1];

    return undefined;
  }

  private extractStringLiteralsFromExpression(callExpression: string): string[] {
    const literals: string[] = [];
    const re = /['"`]([^'"`]*)['"`]/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(callExpression)) !== null) {
      literals.push(match[1]);
    }
    return literals;
  }

  private parseRepositoryCall(target: string): { repository: string; method: string } | null {
    const parts = target.split('.');
    if (parts.length < 2) return null;

    const method = parts.pop()!;
    let repository = parts.pop()!;

    if (repository === 'this' && parts.length > 0) {
      repository = parts.pop()!;
    }

    return {
      repository: this.propertyNameToClassName(repository),
      method
    };
  }

  private getLibraryFromImportSource(importSource: string): string {
    if (importSource.includes('@mikro-orm')) return 'MikroORM';
    if (importSource.includes('typeorm')) return 'TypeORM';
    if (importSource.includes('@prisma')) return 'Prisma';
    if (importSource.includes('sequelize')) return 'Sequelize';
    if (importSource.includes('mongoose')) return 'Mongoose';
    if (importSource.includes('knex')) return 'Knex';
    if (importSource.includes('drizzle')) return 'Drizzle';
    if (importSource.includes('objection')) return 'Objection.js';
    return importSource;
  }

  private getLibraryForType(typeName: string): string | undefined {
    const importSource = this.importSourceMap.get(typeName);
    if (importSource) {
      return this.getLibraryFromImportSource(importSource);
    }

    if (typeName.includes('EntityRepository')) {
      const entityRepoSource = this.importSourceMap.get('EntityRepository');
      if (entityRepoSource) {
        return this.getLibraryFromImportSource(entityRepoSource);
      }
    }

    return undefined;
  }

  private propertyNameToClassName(propertyName: string): string {
    return propertyName.charAt(0).toUpperCase() + propertyName.slice(1);
  }

  private getRepositoryClassNameFromProperty(propertyName: string): string | undefined {
    return this.repositoryPropertyTypes.get(propertyName);
  }

  private static readonly ENTITY_ACCESS_BY_METHOD: Record<string, 'creates' | 'updates' | 'deletes' | 'reads'> = {
    create: 'creates',
    createmany: 'creates',
    createmanyandreturn: 'creates',
    insert: 'creates',
    insertmany: 'creates',
    nativeinsert: 'creates',
    persist: 'creates',
    persistandflush: 'creates',
    save: 'creates',
    upsert: 'creates',
    upsertmany: 'creates',
    update: 'updates',
    updatemany: 'updates',
    updateone: 'updates',
    nativeupdate: 'updates',
    findoneandupdate: 'updates',
    findbyidandupdate: 'updates',
    replaceone: 'updates',
    increment: 'updates',
    decrement: 'updates',
    restore: 'updates',
    assign: 'updates',
    bulkwrite: 'updates',
    delete: 'deletes',
    deletemany: 'deletes',
    deleteone: 'deletes',
    nativedelete: 'deletes',
    remove: 'deletes',
    removeandflush: 'deletes',
    destroy: 'deletes',
    softdelete: 'deletes',
    softremove: 'deletes',
    findbyidanddelete: 'deletes',
    findbyidandremove: 'deletes',
    findoneanddelete: 'deletes',
    findoneandremove: 'deletes',
    find: 'reads',
    findone: 'reads',
    findoneorfail: 'reads',
    findall: 'reads',
    findandcount: 'reads',
    findandcountall: 'reads',
    findmany: 'reads',
    findunique: 'reads',
    finduniqueorthrow: 'reads',
    findfirst: 'reads',
    findfirstorthrow: 'reads',
    findbyid: 'reads',
    findbycursor: 'reads',
    count: 'reads',
    countdocuments: 'reads',
    estimateddocumentcount: 'reads',
    distinct: 'reads',
    exists: 'reads',
    aggregate: 'reads',
    groupby: 'reads',
    getresult: 'reads',
    getresultlist: 'reads',
    getsingleresult: 'reads',
    getresultandcount: 'reads'
  };

  private classifyEntityAccess(method: string): 'creates' | 'updates' | 'deletes' | 'reads' | undefined {
    return TypeScriptJavaScriptAnalyzer.ENTITY_ACCESS_BY_METHOD[method.toLowerCase()];
  }

  private async collectPrismaModels(context: AnalysisContext, nodes: CASNode[]): Promise<void> {
    try {
      const schemaFiles = await glob(['**/prisma/schema.prisma'], {
        cwd: context.projectPath,
        ignore: this.getIgnorePatterns(context),
        nodir: true
      });
      for (const identity of await loadPrismaModelIdentities(context.projectPath, schemaFiles)) {
        const candidates = this.prismaModelsByName.get(identity.name.toLowerCase()) || [];
        candidates.push(identity);
        this.prismaModelsByName.set(identity.name.toLowerCase(), candidates);
        nodes.push(this.createNode(identity.nodeId, identity.name, 'entity', 3, identity.schemaPath, undefined, undefined, {
          orm: 'Prisma', source: 'prisma_schema', schema_path: identity.schemaPath, subcategories: ['entity', 'prisma']
        }));
      }
    } catch {

    }
  }

  private lookupEntityNodeId(entityName: string): string | undefined {
    const candidates = this.nodesByName.get(entityName);
    if (!candidates) return undefined;
    const entityNode = candidates.find(node => node.type === 'entity' || node.type === 'model');
    return entityNode?.id;
  }

  private isEntityManagerCaller(callerProperty: string, className?: string): boolean {
    const lower = callerProperty.toLowerCase();
    if (lower === 'em' || lower === 'entitymanager' || lower === 'manager') return true;
    const fieldType = (className && this.classFieldTypes.get(`${className}.${callerProperty}`)?.typeName)
      || this.repositoryPropertyTypes.get(callerProperty);
    return !!fieldType && fieldType.toLowerCase().includes('entitymanager');
  }

  private resolveEntityAccessTarget(call: any, func: any, filePath: string): string | undefined {
    const callExpression = String(call.callExpression || '');
    const targetParts = String(call.target || '').split('.');
    targetParts.pop();
    const callerParts = targetParts[0] === 'this' ? targetParts.slice(1) : targetParts;
    const callerProperty = callerParts[callerParts.length - 1] || '';

    const queryBuilderEntity = callExpression.match(/createQueryBuilder\s*\(\s*([A-Z][A-Za-z0-9_]*)/);
    if (queryBuilderEntity) return this.lookupEntityNodeId(queryBuilderEntity[1]);

    if (this.isEntityManagerCaller(callerProperty, func?.className)) {
      const firstArgEntity = callExpression.match(/\.\s*\w+\s*(?:<[^(]*>)?\s*\(\s*(?:new\s+)?([A-Z][A-Za-z0-9_]*)\s*[\s,()]/);
      return firstArgEntity ? this.lookupEntityNodeId(firstArgEntity[1]) : undefined;
    }

    const prismaParent = callerParts.length >= 2 ? callerParts[callerParts.length - 2].toLowerCase() : '';
    if (prismaParent.includes('prisma')) {
      const modelKey = callerProperty.toLowerCase();
      return selectPrismaModelIdentity(this.prismaModelsByName.get(modelKey) || [], filePath, call.library)?.nodeId;
    }

    const propertyType = (func?.className && this.classFieldTypes.get(`${func.className}.${callerProperty}`)?.typeName)
      || this.repositoryPropertyTypes.get(callerProperty);
    if (propertyType && this.isRepositoryLikeType(propertyType)) {
      const genericEntity = propertyType.match(/<\s*([A-Z][A-Za-z0-9_]*)\s*[>,]/);
      if (genericEntity) {
        const resolved = this.lookupEntityNodeId(genericEntity[1]);
        if (resolved) return resolved;
      }
    }

    if (/^[A-Z]/.test(callerProperty)) {
      const resolved = this.lookupEntityNodeId(callerProperty);
      if (resolved) return resolved;
    }

    const suffixedProperty = callerProperty.match(/^(.+)(Repository|Repo|Model)$/);
    if (suffixedProperty) {
      return this.lookupEntityNodeId(this.propertyNameToClassName(suffixedProperty[1]));
    }
    return undefined;
  }

  private extractConstructedClassNames(content: string, filePath: string, lineStart?: number, lineEnd?: number): string[] {
    if (!lineStart || !lineEnd || lineEnd < lineStart) return [];
    const corpusEntry = this.sourceCorpus()?.get(filePath);
    const body = corpusEntry
      ? content.slice(corpusEntry.lineStarts[lineStart - 1] ?? 0, corpusEntry.lineStarts[lineEnd] ?? content.length)
      : content.split('\n').slice(lineStart - 1, lineEnd).join('\n');
    const constructed = new Set<string>();
    const constructionPattern = /\bnew\s+([A-Z][A-Za-z0-9_]*)\s*\(/g;
    let constructionMatch;
    while ((constructionMatch = constructionPattern.exec(body)) !== null) {
      constructed.add(constructionMatch[1]);
    }
    return [...constructed];
  }

  private addConstructedEntityPersistEdges(edges: CASEdge[], sourceNodeId: string | undefined, func: any): void {
    if (!sourceNodeId) return;
    const constructedClassNames: string[] = func?.constructedClassNames || [];
    if (constructedClassNames.length === 0) return;
    const calls: any[] = func?.calls || [];
    const hasPersistingCall = calls.some(call => {
      const target = String(call.target || '');
      const method = target.split('.').pop() || '';
      return this.classifyEntityAccess(method) === 'creates' && this.isRepositoryCall(target, func?.className);
    });
    if (!hasPersistingCall) return;

    for (const constructedClassName of constructedClassNames) {
      const entityNodeId = this.lookupEntityNodeId(constructedClassName);
      if (!entityNodeId || entityNodeId === sourceNodeId) continue;
      this.addCallEdge(edges, {
        id: `entity_access_${sourceNodeId}_${entityNodeId}_creates`,
        source: sourceNodeId,
        target: entityNodeId,
        type: 'creates',
        category: 'data',
        metadata: {
          attributes: {
            reason: 'code_level_model_access',
            method: 'constructor_with_persist',
            line: func.lineStart
          }
        }
      });
    }
  }

  private addEntityAccessEdge(
    edges: CASEdge[],
    sourceNodeId: string,
    call: any,
    func: any,
    filePath: string
  ): void {
    const method = String(call.target || '').split('.').pop() || '';
    const access = this.classifyEntityAccess(method);
    if (!access) return;
    const entityNodeId = this.resolveEntityAccessTarget(call, func, filePath);
    if (!entityNodeId || entityNodeId === sourceNodeId) return;
    this.addCallEdge(edges, {
      id: `entity_access_${sourceNodeId}_${entityNodeId}_${access}`,
      source: sourceNodeId,
      target: entityNodeId,
      type: access,
      category: 'data',
      metadata: {
        attributes: {
          reason: 'code_level_model_access',
          method,
          line: call.line
        }
      }
    });
  }

  private validateCallGraph(nodes: CASNode[], edges: CASEdge[]): void {
    const nodeIds = new Set(nodes.map(n => n.id));

    edges.forEach((edge, index) => {
      if (!nodeIds.has(edge.source) && !edge.source.startsWith('exit_') && !edge.source.startsWith('library_')) {
        console.warn(`Edge ${edge.id} has invalid source: ${edge.source}`);
      }
      if (!nodeIds.has(edge.target) && !edge.target.startsWith('exit_') && !edge.target.startsWith('library_') && !edge.target.startsWith('entity_prisma_')) {
        console.warn(`Edge ${edge.id} has invalid target: ${edge.target}`);
      }
    });

    this.createClassLevelEdges(nodes, edges);
  }

  private createClassLevelEdges(nodes: CASNode[], edges: CASEdge[]): void {
    const classLikeTypes = new Set(['class', 'service', 'controller', 'repository', 'guard', 'gateway']);
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const classEdges = new Map<string, { sourceClass: string; targetClass: string; methodEdgeIds: string[] }>();

    edges.forEach(edge => {
      if (edge.type !== 'calls') return;

      const sourceNode = nodeMap.get(edge.source);
      const targetNode = nodeMap.get(edge.target);
      if (!sourceNode || !targetNode) return;

      const sourceClassId = sourceNode.parent;
      const targetClassId = targetNode.parent;
      if (!sourceClassId || !targetClassId) return;
      if (sourceClassId === targetClassId) return;

      const sourceClassNode = nodeMap.get(sourceClassId);
      const targetClassNode = nodeMap.get(targetClassId);
      if (!sourceClassNode || !targetClassNode) return;
      if (!classLikeTypes.has(sourceClassNode.type) || !classLikeTypes.has(targetClassNode.type)) return;

      const edgeKey = `${sourceClassId}_uses_${targetClassId}`;
      const existing = classEdges.get(edgeKey);
      if (existing) {
        existing.methodEdgeIds.push(edge.id);
      } else {
        classEdges.set(edgeKey, {
          sourceClass: sourceClassId,
          targetClass: targetClassId,
          methodEdgeIds: [edge.id]
        });
      }
    });

    classEdges.forEach((data, key) => {
      edges.push({
        id: key,
        source: data.sourceClass,
        target: data.targetClass,
        type: 'uses',
        metadata: {
          attributes: {
            aggregated_from: data.methodEdgeIds,
            call_count: data.methodEdgeIds.length
          }
        }
      });
    });
  }

  private enrichNodesWithCallData(nodes: CASNode[], edges: CASEdge[]): void {

    const callCounts = new Map<string, { incoming: number; outgoing: number }>();

    edges.forEach(edge => {
      if (edge.type === 'calls') {

        const sourceStats = callCounts.get(edge.source) || { incoming: 0, outgoing: 0 };
        sourceStats.outgoing++;
        callCounts.set(edge.source, sourceStats);

        const targetStats = callCounts.get(edge.target) || { incoming: 0, outgoing: 0 };
        targetStats.incoming++;
        callCounts.set(edge.target, targetStats);
      }
    });

    nodes.forEach(node => {
      const stats = callCounts.get(node.id);
      if (stats) {
        if (!node.metadata) node.metadata = {};
        if (!node.metadata.attributes) node.metadata.attributes = {};

        node.metadata.attributes.incoming_calls = stats.incoming;
        node.metadata.attributes.outgoing_calls = stats.outgoing;
        node.metadata.attributes.is_leaf = stats.outgoing === 0;
        node.metadata.attributes.is_entry = stats.incoming === 0;
      }
    });
  }

  private buildCategories(): Partial<CASCategories> {
    const categories: Partial<CASCategories> = {};

    categories['1'] = {
      'modules': {
        name: 'Modules',
        types: ['file', 'module'],
        description: 'Source files and modules',
        languages: ['typescript', 'javascript']
      }
    };

    categories['2'] = {
      'structures': {
        name: 'Structures',
        types: ['class', 'interface', 'type', 'enum'],
        description: 'Classes, interfaces, and type definitions',
        languages: ['typescript', 'javascript']
      },
      'functions': {
        name: 'Functions',
        types: ['function', 'arrow-function'],
        description: 'Standalone functions',
        languages: ['typescript', 'javascript']
      }
    };

    categories['3'] = {
      'methods': {
        name: 'Methods',
        types: ['method', 'constructor', 'getter', 'setter'],
        description: 'Class methods and accessors',
        languages: ['typescript', 'javascript']
      }
    };

    categories['4'] = {
      'data': {
        name: 'Data',
        types: ['variable', 'property', 'parameter'],
        description: 'Variables, properties, and parameters',
        languages: ['typescript', 'javascript']
      }
    };

    return categories;
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

  private getLanguageIgnorePatterns(context: Pick<AnalysisContext, 'projectPath' | 'filters'>): string[] {
    return this.getIgnorePatterns(context as AnalysisContext).filter(pattern =>
      pattern !== '__tests__/**' && pattern !== '**/__tests__/**'
    );
  }

  private applyTestSourceBoundary(
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[],
    edges: CASEdge[]
  ): void {
    const testNodeIds = new Set<string>();
    for (const node of nodes) {
      if (!this.isTestSourcePath(node.source?.file)) continue;
      testNodeIds.add(node.id);
      node.metadata = { ...node.metadata, is_test: true };
      node.category = 'test';
      node.subcategories = [...new Set([...(node.subcategories || []), node.type, 'test-code'])];
      node.tags = [...new Set([...(node.tags || []), 'test-code'])];
    }

    const removedEndpointIds = new Set<string>();
    this.removeItemsOwnedByTestNodes(entryPoints, testNodeIds, removedEndpointIds);
    this.removeItemsOwnedByTestNodes(exitPoints, testNodeIds, removedEndpointIds);

    dropEdgesReferencingRemovedEndpoints(edges, removedEndpointIds);
  }

  private removeItemsOwnedByTestNodes<T extends { id: string; source_node: string }>(
    items: T[],
    testNodeIds: Set<string>,
    removedIds: Set<string>
  ): void {
    let writeIndex = 0;
    for (const item of items) {
      if (testNodeIds.has(item.source_node)) { removedIds.add(item.id); continue; }
      items[writeIndex++] = item;
    }
    items.length = writeIndex;
  }

  private isTestSourcePath(filePath?: string): boolean {
    if (!filePath) return false;
    const normalized = filePath.replace(/\\/g, '/').toLowerCase();
    return /(?:^|\/)(?:__tests__|tests?|spec|e2e)(?:\/|$)/.test(normalized) ||
      /\.(?:test|spec|e2e)\.(?:[cm]?[jt]sx?)$/.test(normalized);
  }

  protected getCapabilities(): string[] {
    return [
      'ast-parsing',
      'function-analysis',
      'class-detection',
      'import-tracking',
      'variable-analysis',
      'typescript-support',
      'call-graph-building'
    ];
  }

  private createPerspectives(perspectives: CASPerspective[]): void {
    perspectives.push({
      id: 'typescript-structure',
      name: 'TypeScript/JavaScript Structure',
      description: 'File and module organization showing files, modules, and their exports/imports',
      analyzer_id: this.analyzerId,
      type: 'structure',
      connection_rules: {
        visible_node_types: ['file', 'module', 'class', 'interface', 'type', 'enum'],
        relevant_edge_types: ['contains', 'imports', 'exports'],
        node_connections: [
          {
            from_type: 'file',
            to_types: ['class', 'interface', 'function', 'variable'],
            edge_type: 'contains'
          },
          {
            from_type: 'file',
            to_types: ['import'],
            edge_type: 'imports'
          }
        ]
      },
      layout_hints: {
        style: 'hierarchical',
        direction: 'TB',
        group_by: 'category'
      },
      metadata: {
        primary_focus: 'modules'
      }
    });

    perspectives.push({
      id: 'typescript-dependencies',
      name: 'TypeScript/JavaScript Dependencies',
      description: 'Dependency graph showing imports, exports, and module relationships',
      analyzer_id: this.analyzerId,
      type: 'flow',
      connection_rules: {
        visible_node_types: ['file', 'module', 'import', 'export'],
        relevant_edge_types: ['imports', 'exports', 'depends_on'],
        node_connections: [
          {
            from_type: 'file',
            to_types: ['file'],
            edge_type: 'imports',
            conditions: { external: false }
          },
          {
            from_type: 'module',
            to_types: ['module'],
            edge_type: 'depends_on'
          }
        ]
      },
      layout_hints: {
        style: 'force',
        group_by: 'module'
      },
      metadata: {
        show_external: true,
        highlight_circular: true
      }
    });

    perspectives.push({
      id: 'typescript-inheritance',
      name: 'TypeScript/JavaScript Inheritance',
      description: 'Class hierarchy and interface implementations',
      analyzer_id: this.analyzerId,
      type: 'structure',
      connection_rules: {
        visible_node_types: ['class', 'interface', 'abstract-class'],
        relevant_edge_types: ['extends', 'implements'],
        node_connections: [
          {
            from_type: 'class',
            to_types: ['class', 'abstract-class'],
            edge_type: 'extends'
          },
          {
            from_type: 'class',
            to_types: ['interface'],
            edge_type: 'implements'
          }
        ]
      },
      layout_hints: {
        style: 'hierarchical',
        direction: 'BT'
      },
      metadata: {
        show_members: false,
        focus: 'inheritance'
      }
    });
  }

  private parseJSDoc(raw: string, startLine: number, endLine: number): CASDocumentation {
    const doc: CASDocumentation = {
      type: 'jsdoc',
      raw,
      location: { start_line: startLine, end_line: endLine }
    };

    const cleanLines = raw
      .split('\n')
      .map(line => line.replace(/^\s*\*\s?/, '').trim())
      .filter(line => line && !line.startsWith('/**') && !line.startsWith('*/'));

    const descriptionLines: string[] = [];
    const params: any[] = [];
    const tags: any[] = [];
    let returns: any = undefined;
    const throws: any[] = [];
    const examples: any[] = [];

    let currentExample: string[] | null = null;

    for (const line of cleanLines) {
      if (line.startsWith('@')) {
        const match = line.match(/^@(\w+)\s*(.*)/);
        if (match) {
          const [, tag, value] = match;

          if (tag === 'param' || tag === 'parameter') {
            const paramMatch = value.match(/^(?:\{([^}]+)\})?\s*(\S+)\s*(?:-\s*)?(.*)/);
            if (paramMatch) {
              const [, type, name, description] = paramMatch;
              params.push({
                name: name.replace(/[\[\]]/g, ''),
                type: type || undefined,
                description: description || undefined,
                optional: name.includes('[') || name.includes('?')
              });
            }
          } else if (tag === 'returns' || tag === 'return') {
            const returnMatch = value.match(/^(?:\{([^}]+)\})?\s*(.*)/);
            if (returnMatch) {
              const [, type, description] = returnMatch;
              returns = { type: type || undefined, description: description || undefined };
            }
          } else if (tag === 'throws' || tag === 'throw') {
            const throwMatch = value.match(/^(?:\{([^}]+)\})?\s*(.*)/);
            if (throwMatch) {
              const [, type, description] = throwMatch;
              throws.push({ type: type || undefined, description: description || undefined });
            }
          } else if (tag === 'example') {
            if (currentExample) {
              examples.push({ code: currentExample.join('\n'), language: 'javascript' });
            }
            currentExample = value ? [value] : [];
          } else if (tag === 'deprecated' || tag === 'since' || tag === 'author' || tag === 'see' || tag === 'link') {
            tags.push({ tag, value, metadata: {} });
          }
        }
      } else if (currentExample) {
        currentExample.push(line);
      } else {
        descriptionLines.push(line);
      }
    }

    if (currentExample) {
      examples.push({ code: currentExample.join('\n'), language: 'javascript' });
    }

    if (descriptionLines.length > 0) {
      const fullDescription = descriptionLines.join(' ');
      const summaryEnd = fullDescription.indexOf('. ');
      if (summaryEnd > 0) {
        doc.summary = fullDescription.substring(0, summaryEnd + 1);
        doc.description = fullDescription;
      } else {
        doc.summary = fullDescription;
        doc.description = fullDescription;
      }
    }

    if (params.length > 0) doc.parameters = params;
    if (returns) doc.returns = returns;
    if (throws.length > 0) doc.throws = throws;
    if (examples.length > 0) doc.examples = examples;
    if (tags.length > 0) doc.tags = tags;

    return doc;
  }

  private tagNodesWithPerspectives(nodes: CASNode[], edges: CASEdge[]): void {
    nodes.forEach(node => {
      if (!node || typeof node !== 'object') return;

      if (!node.perspectives) {
        node.perspectives = {};
      }

      if (node.type === 'file' || node.type === 'module' ||
          node.type === 'class' || node.type === 'interface' ||
          node.type === 'type' || node.type === 'enum') {
        node.perspectives['typescript-structure'] = {
          hierarchy: ['typescript', 'structure'],
          level: node.level || 1,
          priority: 1
        };
      }

      if (node.type === 'file' || node.type === 'module' ||
          node.type === 'import' || node.type === 'export') {
        node.perspectives['typescript-dependencies'] = {
          hierarchy: ['typescript', 'dependencies'],
          level: node.level || 1,
          priority: 2
        };
      }

      if (node.type === 'class' || node.type === 'interface' ||
          node.type === 'abstract-class') {
        node.perspectives['typescript-inheritance'] = {
          hierarchy: ['typescript', 'inheritance'],
          level: node.level || 1,
          priority: 3
        };
      }

      if (!node.metadata) {
        node.metadata = {};
      }
      node.metadata.perspective_data = {
        'typescript-structure': {
          module_path: node.source?.file,
          export_type: node.metadata?.is_exported ? 'exported' : 'internal'
        },
        'typescript-dependencies': {
          dependency_count: 0,
          dependent_count: 0
        },
        'typescript-inheritance': {
          hierarchy_level: 0,
          implements_count: 0,
          extends_from: null
        }
      };
    });

    edges.forEach(edge => {
      edge.perspectives = [];

      if (edge.type === 'contains' || edge.type === 'imports' || edge.type === 'exports') {
        edge.perspectives.push('typescript-structure');
      }

      if (edge.type === 'imports' || edge.type === 'exports' || edge.type === 'depends_on') {
        edge.perspectives.push('typescript-dependencies');
      }

      if (edge.type === 'extends' || edge.type === 'implements') {
        edge.perspectives.push('typescript-inheritance');
      }

      if (!edge.metadata) {
        edge.metadata = {};
      }
      edge.metadata.perspective_data = {
        'typescript-structure': {
          relationship_type: edge.type
        },
        'typescript-dependencies': {
          is_external: edge.metadata?.attributes?.external || false,
          is_circular: false
        },
        'typescript-inheritance': {
          inheritance_type: edge.type
        }
      };
    });
  }

}
