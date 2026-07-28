import * as crypto from 'crypto';
import {
  AnalyzerSourceCorpus,
  getActiveSourceCorpus,
  sourceImports,
  sourceJson,
  sourceLines,
  sourceManifestKind,
  sourcePathCategories,
  sourceLineCount,
  sourceLineForIndex,
  type SourceManifestKind,
  type SourceImportFlavor,
  type SourcePathCategory,
} from './source-corpus';
import {
  CASNode,
  CASEdge,
  CASContribution,
  CASEntryPoint,
  CASExitPoint,
  CASAnalyzerContribution,
  CASNodeBuilder,
  CASEdgeBuilder,
  CASCategories,
  generateNodeId,
  generateEdgeId,
  FileAnalysisResult,
} from '../../types/cas.types';

export type {
  CASNode,
  CASEdge,
  CASContribution,
  CASEntryPoint,
  CASExitPoint,
  CASAnalyzerContribution,
  CASNodeBuilder,
  CASEdgeBuilder,
  FileAnalysisResult,
} from '../../types/cas.types';

export {
  generateNodeId,
  generateEdgeId,
} from '../../types/cas.types';

export type CASAnalysisResult = CASContribution;

/**
 * True only for a well-formed CASCategories tree: a plain object whose every
 * value is a plain object of category descriptors (`{ name?, types?, ... }`).
 * Arrays and strings are REJECTED — a flat tag list is not a categories tree,
 * and letting one through is what produced the character-indexed
 * `categories: {"0":{"0":"v",...}}` corruption in every stored CAS (a string
 * reaching mergeCategories' object spread). Descriptor values are only
 * shape-checked, never invented.
 */
export function isCASCategoriesShape(value: unknown): value is CASCategories {
  if (!isPlainRecord(value)) return false;
  const levels = Object.values(value);
  if (levels.length === 0) return false;
  return levels.every(level =>
    isPlainRecord(level) &&
    Object.values(level).every(descriptor => isPlainRecord(descriptor))
  );
}

/** A flat `categories: ['validation', ...]` tag list, normalized to unique
 *  non-empty strings. Anything else (including a malformed nested object)
 *  yields an empty list rather than a fabricated tag. */
export function normalizeCategoryTags(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? [value]
      : [];
  return Array.from(new Set(
    raw.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
      .map(tag => tag.trim())
  ));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export interface AnalysisContext {
  projectPath: string;
  analysisRootPath?: string;
  includeTests?: boolean;
  maxDepth?: number;
  filters?: string[];
  existingAnalysis?: CASContribution[];
  targetLevel?: number;
  sourceCorpus?: AnalyzerSourceCorpus;
}

export interface FileAnalysisContext extends AnalysisContext {
  filePath: string;
  relativePath: string;
  contentHash?: string;
}

import * as path from 'path';
import * as fs from 'fs-extra';
import { SCAFFOLD_GLOBS } from './scaffold-paths';

const MAX_REPORTED_FILE_WARNINGS = 25;

interface ExistingAnalysisEvidenceIndex {
  imports: Array<{ file: string; source: string }>;
  relativeDependentsByTarget: Map<string, string[]>;
  sourceFilesByNode: Map<string, string>;
}

const existingAnalysisEvidenceIndexes = new WeakMap<CASContribution, Map<string, ExistingAnalysisEvidenceIndex>>();

function moduleKey(filePath: string): string {
  return filePath
    .replace(/\\/g, '/')
    .replace(/\.(?:[cm]?[jt]sx?|py|rb|java|cs|go)$/i, '')
    .replace(/\/index$/i, '');
}

function evidenceIndexFor(contribution: CASContribution, analysisRoot: string): ExistingAnalysisEvidenceIndex {
  let byRoot = existingAnalysisEvidenceIndexes.get(contribution);
  if (!byRoot) {
    byRoot = new Map();
    existingAnalysisEvidenceIndexes.set(contribution, byRoot);
  }
  const normalizedRoot = path.resolve(analysisRoot);
  const cached = byRoot.get(normalizedRoot);
  if (cached) return cached;

  const imports: Array<{ file: string; source: string }> = [];
  const relativeDependentsByTarget = new Map<string, string[]>();
  const sourceFilesByNode = new Map<string, string>();
  for (const node of contribution.nodes || []) {
    const sourceFile = node.source?.file;
    if (sourceFile) sourceFilesByNode.set(node.id, sourceFile);
    if (node.type !== 'import' || !sourceFile) continue;
    const metadata = node.metadata as Record<string, unknown> | undefined;
    const importSource = String(metadata?.source || '');
    if (!importSource) continue;
    const absoluteFile = path.normalize(path.isAbsolute(sourceFile)
      ? sourceFile
      : path.join(normalizedRoot, sourceFile));
    imports.push({ file: absoluteFile, source: importSource });
    if (importSource.startsWith('.')) {
      const target = moduleKey(path.resolve(path.dirname(absoluteFile), importSource));
      const dependents = relativeDependentsByTarget.get(target);
      if (dependents) dependents.push(absoluteFile);
      else relativeDependentsByTarget.set(target, [absoluteFile]);
    }
  }

  const index = { imports, relativeDependentsByTarget, sourceFilesByNode };
  byRoot.set(normalizedRoot, index);
  return index;
}

export abstract class BaseAnalyzer {
  readonly discoversNestedRoots: boolean = false;

  protected analyzerId: string;
  protected analyzerName: string;
  protected analyzerVersion: string;
  protected analyzerType: 'language' | 'framework' | 'library' | 'pattern';
  protected analysisWarnings: string[] = [];
  protected suppressedWarningCount = 0;

  constructor(
    id: string,
    name: string,
    version: string,
    type: 'language' | 'framework' | 'library' | 'pattern'
  ) {
    this.analyzerId = id;
    this.analyzerName = name;
    this.analyzerVersion = version;
    this.analyzerType = type;
  }

  get id(): string {
    return this.analyzerId;
  }

  get name(): string {
    return this.analyzerName;
  }

  get version(): string {
    return this.analyzerVersion;
  }

  get type(): 'language' | 'framework' | 'library' | 'pattern' {
    return this.analyzerType;
  }

  abstract canAnalyze(projectPath: string): Promise<boolean>;

  abstract analyze(context: AnalysisContext): Promise<CASContribution>;

  supportsIncrementalAnalysis(): boolean {
    return false;
  }

  protected sourceLineForIndex(content: string, index: number): number {
    return sourceLineForIndex(content, index);
  }

  protected sourceLineCount(content: string): number {
    return sourceLineCount(content);
  }

  protected sourceCorpus(context?: AnalysisContext): AnalyzerSourceCorpus | undefined {
    return context?.sourceCorpus ?? getActiveSourceCorpus();
  }

  protected sourceImports(content: string, flavor: SourceImportFlavor = 'all'): readonly string[] | undefined {
    return sourceImports(content, flavor);
  }

  protected sourceImportFlavor(filePath: string): SourceImportFlavor | undefined {
    const extension = path.extname(filePath).toLowerCase();
    if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(extension)) return 'ecmascript';
    if (extension === '.py') return 'python';
    if (extension === '.rb') return 'ruby';
    if (extension === '.java' || extension === '.kt' || extension === '.kts') return 'java';
    if (extension === '.go') return 'go';
    if (extension === '.cs' || extension === '.fs') return 'dotnet';
    if (extension === '.rs') return 'rust';
    if (extension === '.php') return 'php';
    if (extension === '.dart') return 'dart';
    return undefined;
  }

  protected sourceLines(content: string): readonly string[] {
    return sourceLines(content) ?? content.split(/\r?\n/);
  }

  protected sourcePathCategories(filePath: string): readonly SourcePathCategory[] {
    return sourcePathCategories(filePath);
  }

  protected sourceManifestKind(filePath: string): SourceManifestKind | undefined {
    return sourceManifestKind(filePath);
  }

  protected sourceJson<T>(content: string): T {
    return sourceJson<T>(content);
  }

  protected async readSourceJson<T>(filePath: string): Promise<T> {
    const content = await fs.readFile(filePath, 'utf8');
    return this.sourceJson<T>(content);
  }

  async analyzeFileSingle?(context: FileAnalysisContext): Promise<FileAnalysisResult>;

  async getRelevantFiles?(projectPath: string): Promise<string[]>;

  protected resetAnalysisWarnings(): void {
    this.analysisWarnings = [];
    this.suppressedWarningCount = 0;
  }

  protected addAnalysisWarning(warning: string): void {
    if (this.analysisWarnings.length >= MAX_REPORTED_FILE_WARNINGS) {
      this.suppressedWarningCount += 1;
      return;
    }
    this.analysisWarnings.push(warning);
  }

  protected collectAnalysisWarnings(): string[] {
    if (this.suppressedWarningCount > 0) {
      return [...this.analysisWarnings, `${this.suppressedWarningCount} additional file warnings suppressed`];
    }
    return [...this.analysisWarnings];
  }

  protected filesFromExistingAnalysis(
    context: AnalysisContext,
    matchesImportSource: (source: string) => boolean,
    includeLocalDependents = false
  ): string[] {
    const absoluteFiles = new Set<string>();
    const analysisRoot = context.analysisRootPath || context.projectPath;
    const indexes = (context.existingAnalysis || []).map(contribution => evidenceIndexFor(contribution, analysisRoot));

    for (const index of indexes) {
      for (const candidate of index.imports) {
        if (matchesImportSource(candidate.source)) absoluteFiles.add(candidate.file);
      }
    }

    if (includeLocalDependents && absoluteFiles.size > 0) {
      const queue = [...absoluteFiles];
      while (queue.length > 0) {
        const target = moduleKey(queue.shift()!);
        for (const index of indexes) {
          for (const dependent of index.relativeDependentsByTarget.get(target) || []) {
            if (absoluteFiles.has(dependent)) continue;
            absoluteFiles.add(dependent);
            queue.push(dependent);
          }
        }
      }
    }

    return [...absoluteFiles]
      .map(absoluteFile => path.relative(context.projectPath, absoluteFile).replace(/\\/g, '/'))
      .filter(relativeFile => Boolean(relativeFile) && !relativeFile.startsWith('../') && !path.isAbsolute(relativeFile))
      .sort();
  }

  protected filesFromExistingAnalysisExitPoints(
    context: AnalysisContext,
    matchesExitPoint: (exitPoint: CASExitPoint) => boolean
  ): string[] {
    const analysisRoot = context.analysisRootPath || context.projectPath;
    const sourceFilesByNode = new Map<string, string>();
    for (const contribution of context.existingAnalysis || []) {
      for (const [nodeId, sourceFile] of evidenceIndexFor(contribution, analysisRoot).sourceFilesByNode) {
        sourceFilesByNode.set(nodeId, sourceFile);
      }
    }

    const files = new Set<string>();
    for (const contribution of context.existingAnalysis || []) {
      for (const exitPoint of contribution.exit_points || []) {
        if (!matchesExitPoint(exitPoint)) continue;
        const sourceFile = sourceFilesByNode.get(exitPoint.source_node);
        if (!sourceFile) continue;
        const absoluteFile = path.isAbsolute(sourceFile) ? sourceFile : path.join(analysisRoot, sourceFile);
        const relativeFile = path.relative(context.projectPath, absoluteFile).replace(/\\/g, '/');
        if (relativeFile && !relativeFile.startsWith('../') && !path.isAbsolute(relativeFile)) files.add(relativeFile);
      }
    }
    return [...files].sort();
  }

  protected capAndPrioritizeSourceFiles(files: string[], purpose = 'source files'): string[] {
    const configuredLimit = Number(process.env.KLAURO_MAX_FILES_PER_ANALYZER || '');
    if (!Number.isFinite(configuredLimit) || configuredLimit <= 0 || files.length <= configuredLimit) {
      return files;
    }

    const ranked = [...files].sort((left, right) => {
      const scoreDelta = this.analysisFilePriorityScore(left) - this.analysisFilePriorityScore(right);
      return scoreDelta || left.localeCompare(right);
    });
    this.addAnalysisWarning(
      `${this.analyzerName} analyzed ${configuredLimit} of ${files.length} ${purpose} for ${process.env.KLAURO_ANALYSIS_FOCUS || 'default'} focus; run deep-context/full analysis for exhaustive per-file detail`
    );
    return ranked.slice(0, configuredLimit).sort();
  }

  private analysisFilePriorityScore(relativePath: string): number {
    const normalized = relativePath.replace(/\\/g, '/').toLowerCase();
    let score = 0;

    if (/(^|\/)(src|app|apps|packages|products|server|frontend|backend|api|web|services|lib)\//.test(normalized)) score -= 8;
    if (/(^|\/)(controllers?|routes?|pages?|app|models?|entities|schemas?|services?|repositories?|workers?|jobs?|consumers?|commands?|views?|components?|hooks|stores?|state|domains?)\//.test(normalized)) score -= 6;
    if (/(^|\/)(posthog|saleor|medusa|supabase|appwrite|ghost|immich|mastodon|nocodb|budibase|outline|cal\.com)\//.test(normalized)) score -= 4;
    if (/(\b|\/)(index|main|app|server|bootstrap|router|routes?|schema|models?|entities|controller|service|repository)\.[^.]+$/.test(normalized)) score -= 5;

    if (/(^|\/)(docs?|documentation|examples?|samples?|fixtures?|__fixtures__|testdata|benchmark|benchmarks|storybook|playwright|cypress)(\/|$)/.test(normalized)) score += 25;
    if (/(^|\/)(tests?|__tests__|spec|e2e)(\/|$)|\.(test|spec|stories|story|cy|e2e)\./.test(normalized)) score += 18;
    if (/(^|\/)(generated|dist|build|coverage|vendor|vendors|public|static|assets?)(\/|$)|\.(generated|gen)\./.test(normalized)) score += 40;
    if (/\.(min|bundle)\.(js|css)$/.test(normalized)) score += 50;

    return score;
  }

  protected getFrameworkVersion(projectPath: string, frameworkName: string): Promise<string | undefined> {
    return this.getPackageVersion(projectPath, frameworkName);
  }

  protected async getPackageVersion(projectPath: string, packageName: string): Promise<string | undefined> {
    try {
      const packageJsonPath = path.join(projectPath, 'package.json');
      if (!await fs.pathExists(packageJsonPath)) return undefined;

      const packageJson = await fs.readJson(packageJsonPath);
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };

      return deps[packageName];
    } catch {
      return undefined;
    }
  }

  /**
   * True when `needle` (a package name, matched case-insensitively as a
   * substring) appears as a REAL dependency inside pyproject.toml content —
   * `[project]`'s top-level `dependencies = [...]` array, `[tool.poetry.
   * dependencies]`, or a `[tool.poetry.group.<name>.dependencies]` table.
   *
   * Deliberately excludes `[project.optional-dependencies]` (PEP 621 extras)
   * and `[tool.poetry.extras]`: those sections name OTHER packages/frameworks
   * a library can optionally integrate with, not what the project itself is
   * built with or depends on. Self-detection defect this fixes: Klauro ships
   * packages/klauro-sdk-py/pyproject.toml, a telemetry SDK whose own
   * `dependencies = []` is empty but whose `[project.optional-dependencies]`
   * lists integration-target extras (`django = ["django>=3.2"]`, `flask =
   * ["flask>=2.0"]`, `fastapi = ["starlette>=0.27"]`) — packages a customer's
   * app might use, wired up so the SDK can instrument THEIR Django/Flask/
   * FastAPI/Starlette app, not evidence that Klauro itself is a Django/Flask/
   * FastAPI/Starlette product. The naive `pyproject.includes(needle)`
   * substring check every web-framework analyzer used previously (django-
   * analyzer.ts, flask-analyzer.ts, fastapi-analyzer.ts, starlette-analyzer.ts)
   * matched those extras-table lines directly and reported confidence-1
   * framework detections for all four on Klauro's own ~99% TypeScript repo.
   */
  protected pyprojectHasRealDependency(pyprojectContent: string, needle: string): boolean {
    const lowerNeedle = needle.toLowerCase();
    let inRealDependencyTable = false;
    let inTopLevelDependenciesArray = false;

    for (const rawLine of pyprojectContent.split('\n')) {
      const line = rawLine.trim();
      const sectionMatch = line.match(/^\[(.+)\]$/);
      if (sectionMatch) {
        const section = sectionMatch[1].trim().toLowerCase();
        inRealDependencyTable =
          section === 'tool.poetry.dependencies' ||
          /^tool\.poetry\.group\.[^.]+\.dependencies$/.test(section);
        inTopLevelDependenciesArray = false;
        continue;
      }

      if (/^dependencies\s*=\s*\[/.test(line)) {
        inTopLevelDependenciesArray = true;
      }

      if (inTopLevelDependenciesArray) {
        if (line.toLowerCase().includes(lowerNeedle)) return true;
        if (line.includes(']')) inTopLevelDependenciesArray = false;
        continue;
      }

      if (inRealDependencyTable && line.toLowerCase().includes(lowerNeedle)) {
        return true;
      }
    }

    return false;
  }

  protected createContribution(
    nodes: CASNode[] = [],
    edges: CASEdge[] = [],
    entryPoints: CASEntryPoint[] = [],
    exitPoints: CASExitPoint[] = [],
    additionalMetadata: Record<string, any> = {}
  ): CASContribution {
    this.backfillEntryPointHandlers(nodes, entryPoints);
    const { categories, ...metadataWithoutCategories } = additionalMetadata;
    // `categories` is lifted out of the metadata bag ONLY when it is a real
    // CASCategories tree (level -> category -> descriptor object). Most callers
    // pass a flat tag list (`categories: ['validation','contracts']`) as plain
    // analyzer metadata; lifting that array into `contribution.categories` fed
    // a string where an object was expected into the orchestrator's
    // mergeCategories spread, which then spread the STRING character by
    // character and produced the character-indexed `{"0":{"0":"v",...}}` shape
    // that shipped in every stored CAS. A tag list stays in analyzer_metadata,
    // where it belongs, instead of corrupting the CAS categories tree.
    const casCategories = isCASCategoriesShape(categories) ? categories : undefined;
    const categoryTags = casCategories ? undefined : normalizeCategoryTags(categories);

    const analyzerMetadata: CASAnalyzerContribution = {
      analyzer_id: this.analyzerId,
      analyzer_name: this.analyzerName,
      version: this.analyzerVersion,
      contribution_type: this.analyzerType,
      nodes_contributed: nodes.length,
      edges_contributed: edges.length,
      contributed_entry_points: entryPoints.length,
      contributed_exit_points: exitPoints.length,
      capabilities: this.getCapabilities(),
      ...metadataWithoutCategories,
      ...(categoryTags && categoryTags.length > 0 ? { category_tags: categoryTags } : {})
    };

    const contribution: CASContribution = {
      nodes,
      edges,
      entry_points: entryPoints,
      exit_points: exitPoints,
      analyzer_metadata: analyzerMetadata
    };

    if (casCategories) {
      contribution.categories = casCategories;
    }

    return contribution;
  }

  /**
   * Generic, evidence-gated handler backfill: an entry point's `source_node`
   * already points at the real node it was derived from (a route, a page, an
   * event binding's owning component, a message consumer, ...). When that
   * node carries a real `source.file` (from `createNode`/`withSource`, never
   * fabricated), mirror it onto `entry_point.handler` so "jump to the code"
   * and deployable-path attribution (which resolves handler.file against
   * deployable roots) work without every analyzer having to pass `handler`
   * explicitly. Applies to ANY analyzer via createContribution/
   * createFileAnalysisResult — not hardcoded to a specific framework/library.
   * Never invents a path: an entry point whose backing node has no source
   * location is left with `handler` unset.
   */
  private backfillEntryPointHandlers(nodes: CASNode[], entryPoints: CASEntryPoint[]): void {
    if (!entryPoints?.length || !nodes?.length) return;

    let nodeById: Map<string, CASNode> | null = null;
    for (const entryPoint of entryPoints) {
      if (entryPoint.handler) continue; // analyzer already set an explicit handler — respect it

      nodeById ??= new Map(nodes.map(node => [node.id, node] as const));
      const node = nodeById.get(entryPoint.source_node);
      if (!node?.source?.file) continue; // no real backing source — never fabricate one

      entryPoint.handler = {
        node_id: node.id,
        method_name: node.name || entryPoint.name,
        file: node.source.file,
        ...(node.source.line !== undefined ? { line: node.source.line } : {})
      };
    }
  }

  protected abstract getCapabilities(): string[];

  protected getIgnorePatterns(context: AnalysisContext): string[] {
    const defaultIgnore = [
      'node_modules/**',
      '**/node_modules/**',
      'dist/**',
      '**/dist/**',
      'build/**',
      '**/build/**',
      'target/**',
      '**/target/**',
      'build-out/**',
      '**/build-out/**',
      'build_out/**',
      '**/build_out/**',
      'cmake-build-debug/**',
      '**/cmake-build-debug/**',
      'cmake-build-release/**',
      '**/cmake-build-release/**',
      'vendor/**',
      '**/vendor/**',
      'vendors/**',
      '**/vendors/**',
      '**/*.min.js',
      '**/*.min.css',
      '**/lib/waypoints/**',
      '**/lib/owlcarousel/**',
      '**/lib/chart/**',
      '**/lib/easing/**',
      '**/lib/tempusdominus/**',
      '**/lib/bootstrap/**',
      '**/lib/jquery/**',
      'third_party/**',
      '**/third_party/**',
      'third-party/**',
      '**/third-party/**',
      '*_extracted/**',
      '**/*_extracted/**',
      '*-extracted/**',
      '**/*-extracted/**',
      'examples/**',
      '**/examples/**',
      'samples/**',
      '**/samples/**',
      // fixtures/__fixtures__/testdata/cas-tests/__tests__ — see
      // scaffold-paths.ts (the single shared exclusion list; previously
      // __tests__ was missing here entirely).
      ...SCAFFOLD_GLOBS,
      'venv/**',
      '**/venv/**',
      'venv*/**',
      '**/venv*/**',
      '.venv/**',
      '**/.venv/**',
      '.venv*/**',
      '**/.venv*/**',
      'env/**',
      '**/env/**',
      'env[0-9]*/**',
      '**/env[0-9]*/**',
      'site-packages/**',
      '**/site-packages/**',
      '.tox/**',
      '**/.tox/**',
      '.terraform/**',
      '**/.terraform/**',
      '.pytest_cache/**',
      '**/.pytest_cache/**',
      '.mypy_cache/**',
      '**/.mypy_cache/**',
      '.ruff_cache/**',
      '**/.ruff_cache/**',
      '*.egg-info/**',
      '**/*.egg-info/**',
      '.git/**',
      '**/.git/**',
      '.claude/**',
      '**/.claude/**',
      '.codex/**',
      '**/.codex/**',
      '.scannerwork/**',
      '**/.scannerwork/**',
      'coverage/**',
      '**/coverage/**',
      '.nyc_output/**',
      '**/.nyc_output/**',
      '.pnpm/**',
      '**/.pnpm/**',
      '.yarn/**',
      '**/.yarn/**',
      '.dart_tool/**',
      '**/.dart_tool/**',
      '__pycache__/**',
      '**/__pycache__/**',
      '.next/**',
      '**/.next/**',
      '.turbo/**',
      '**/.turbo/**',
      '.cache/**',
      '**/.cache/**',
      '.klauro*/**',
      '**/.klauro*/**',
      '.vite/**',
      '**/.vite/**',
      '.sourcemaps/**',
      '**/.sourcemaps/**',
      'out/**',
      '**/out/**',
      'storybook-static/**',
      '**/storybook-static/**',
      'storybook-build/**',
      '**/storybook-build/**',
      '**/www/build/**',
      '**/www/assets/**',
      '**/src/assets/**',
      '**/web/assets/**',
      '**/public/assets/**',
      '**/static/assets/**',
      '**/Downloads/**',
      '**/Generated/**',
      '**/generated/**'
    ];

    if (process.env.KLAURO_AGENT_FAST_EXCLUDE_LEGACY === 'true' ||
      process.env.KLAURO_AGENT_FAST_EXCLUDE_LEGACY === '1') {
      defaultIgnore.push('legacy/**', 'legacy/**/*', '**/legacy/**', '**/legacy/**/*');
    }

    if (context.filters && Array.isArray(context.filters)) {
      return [...defaultIgnore, ...context.filters];
    }

    return defaultIgnore;
  }

  /**
   * getIgnorePatterns() carries a generic "documentation and example scaffolding"
   * denylist (directories literally named samples, examples, fixtures, testdata)
   * tuned for JS/Python-style repos where those words only ever name vendored
   * sample code. JVM-family languages (Java, Kotlin, Scala, Groovy, ...) use a
   * package-to-directory convention that turns those same words into common REAL
   * package segments instead: a package like org.springframework.samples.<app>
   * physically lives under a directory path containing org, springframework,
   * samples, <app> in turn, so a blanket "any samples directory" exclusion
   * silently drops 100 percent of that codebase's real source (every
   * controller, entity, and service — not a corner case, the entire app).
   *
   * Any analyzer whose files can be laid out under a JVM-style reversed-domain
   * package path should glob against this set instead of getIgnorePatterns()
   * directly. It strips only the four directory-name patterns that collide with
   * package segments; the rest of the shared denylist (target, vendor,
   * node_modules, ...) still applies since those never collide with a package
   * name. Non-JVM callers must keep using getIgnorePatterns() unfiltered — a
   * JS repo's samples/ directory should stay excluded.
   */
  protected getPackageDirSafeIgnorePatterns(context: AnalysisContext): string[] {
    // Only samples/examples collide with a real JVM reversed-domain package
    // segment (org.springframework.samples.<app>) — fixtures/testdata/
    // cas-tests/__tests__/__fixtures__ (see scaffold-paths.ts) are never a
    // plausible real package name, so they must stay excluded even for
    // package-dir-safe callers. Previously this regex also stripped
    // "fixtures", letting KotlinAnalyzer walk
    // apps/mcp-server/fixtures/component-bench/compose-tree/App.kt and mint a
    // duplicate "Android Activity: MainActivity" entry point from Klauro's
    // own test fixture.
    const unsafeForPackageDirs = /^(\*\*\/)?(samples|examples)\/\*\*$/;
    return this.getIgnorePatterns(context).filter(p => !unsafeForPackageDirs.test(p));
  }

  protected createNodeBuilder(id: string, name: string, type: string): CASNodeBuilder {
    return new CASNodeBuilder(id, name, type).withAnalyzers([this.analyzerId]);
  }

  protected createNode(
    id: string,
    name: string,
    type: string,
    level?: number,
    filePath?: string,
    lineStart?: number,
    lineEnd?: number,
    metadata?: Record<string, any>
  ): CASNode {
    const builder = this.createNodeBuilder(id, name, type);

    if (level !== undefined) {
      builder.withLevel(level, this.getLevelName(level));
    }

    if (filePath) {
      builder.withSource({ file: filePath, line: lineStart, end_line: lineEnd });
    }

    if (metadata || this.analyzerName) {
      builder.withMetadata({
        framework: this.analyzerName.toLowerCase().replace(' analyzer', ''),
        ...metadata
      });
    }

    // Add analyzer tag for filtering
    builder.withTags([`analyzer:${this.analyzerId}`]);

    return builder.build();
  }

  protected abstract getLevelName(level: number): string;

  protected createEdgeBuilder(id: string, source: string, target: string, type: string): CASEdgeBuilder {
    return new CASEdgeBuilder(id, source, target, type);
  }

  protected createEdge(
    id: string,
    source: string,
    target: string,
    type: string,
    category?: string,
    metadata?: Record<string, any>
  ): CASEdge {
    const builder = this.createEdgeBuilder(id, source, target, type);

    if (category) {
      builder.withCategory(category);
    }

    if (metadata) {
      builder.withMetadata(metadata);
    }

    return builder.build();
  }

  protected getQueriableResults(
    analysis: CASContribution,
    levelFilter?: number,
    typeFilter?: string,
    nameFilter?: string
  ): { nodes: CASNode[]; edges: CASEdge[] } {
    let filteredNodes = analysis.nodes || [];
    let filteredEdges = analysis.edges || [];

    if (levelFilter !== undefined) {
      filteredNodes = filteredNodes.filter(node =>
        node.level === undefined || node.level <= levelFilter
      );
    }

    if (typeFilter) {
      filteredNodes = filteredNodes.filter(node => node.type === typeFilter);
    }

    if (nameFilter) {
      const regex = new RegExp(nameFilter, 'i');
      filteredNodes = filteredNodes.filter(node => regex.test(node.name));
    }

    const nodeIds = new Set(filteredNodes.map(node => node.id));
    filteredEdges = filteredEdges.filter(edge =>
      nodeIds.has(edge.source) && nodeIds.has(edge.target)
    );

    return { nodes: filteredNodes, edges: filteredEdges };
  }

  protected createEntryPoint(
    id: string,
    sourceNode: string,
    type: CASEntryPoint['type'],
    name: string,
    description?: string,
    trigger?: CASEntryPoint['trigger'],
    security?: CASEntryPoint['security'],
    metadata?: Record<string, any>,
    handler?: CASEntryPoint['handler']
  ): CASEntryPoint {
    return {
      id,
      source_node: sourceNode,
      source_analyzer: this.analyzerId,
      type,
      name,
      description,
      trigger,
      security,
      metadata,
      handler
    };
  }

  protected createExitPoint(
    id: string,
    sourceNode: string,
    type: CASExitPoint['type'],
    name: string,
    description?: string,
    target?: CASExitPoint['target'],
    operation?: CASExitPoint['operation'],
    metadata?: Record<string, any>
  ): CASExitPoint {
    return {
      id,
      source_node: sourceNode,
      source_analyzer: this.analyzerId,
      type,
      name,
      description,
      target,
      operation,
      metadata
    };
  }

  protected generateId = generateNodeId;
  protected generateEdgeId = generateEdgeId;

  protected sanitizeId(name: string): string {
    return name.replace(/[^a-zA-Z0-9]/g, '_');
  }

  protected computeContentHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
  }

  /**
   * Replace line-comment (`//...`) and block-comment (`/* ... *­/`) characters
   * with spaces (newlines and string/template contents are never touched), so
   * a plain-text regex scan cannot mistake a documentation example for real
   * code. Shared by any regex-based library analyzer that walks raw source
   * text for call-site patterns (mcp-tool-registration-analyzer.ts,
   * ai-stack-analyzer.ts): a JSDoc/line-comment illustrating the exact call
   * shape being detected (e.g. this analyzer's own header documenting
   * `server.tool('do_thing', schema, handler)`) reads identically to a real
   * call site and was previously extracted as one in EACH analyzer
   * independently — mcp-tool-registration-analyzer.ts fixed its own copy of
   * this (quality-iter-1 #8 / #2) but ai-stack-analyzer.ts ran the same
   * `.registerTool`/`.tool(` detection unblanked, so the doc-comment example
   * kept leaking through that second, independent pass. Centralizing here so
   * a future regex-based detector gets comment-safety by default rather than
   * needing its own copy-pasted fix. Tracks string/template state
   * char-by-char so a `//` or `/*` appearing inside a string literal is left
   * alone. Byte offsets and line numbers computed against the returned string
   * are identical to those against the original content.
   */
  protected blankComments(content: string): string {
    let out = '';
    let i = 0;
    const n = content.length;
    let inLineComment = false;
    let inBlockComment = false;
    let inString: '"' | "'" | '`' | null = null;
    while (i < n) {
      const ch = content[i];
      const next = content[i + 1];
      if (inLineComment) {
        if (ch === '\n') { inLineComment = false; out += ch; } else { out += ' '; }
        i++;
        continue;
      }
      if (inBlockComment) {
        if (ch === '*' && next === '/') { inBlockComment = false; out += '  '; i += 2; continue; }
        out += ch === '\n' ? '\n' : ' ';
        i++;
        continue;
      }
      if (inString) {
        out += ch;
        if (ch === '\\') { out += next ?? ''; i += 2; continue; }
        if (ch === inString) inString = null;
        i++;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { inString = ch; out += ch; i++; continue; }
      if (ch === '/' && next === '/') { inLineComment = true; out += '  '; i += 2; continue; }
      if (ch === '/' && next === '*') { inBlockComment = true; out += '  '; i += 2; continue; }
      out += ch;
      i++;
    }
    return out;
  }

  protected createFileAnalysisResult(
    filePath: string,
    relativePath: string,
    contentHash: string,
    mtimeMs: number,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[],
    imports: string[],
    exports: string[]
  ): FileAnalysisResult {
    this.backfillEntryPointHandlers(nodes, entryPoints);
    return {
      filePath: relativePath,
      contentHash,
      mtimeMs,
      nodes,
      edges,
      entryPoints,
      exitPoints,
      imports,
      exports,
    };
  }
}
