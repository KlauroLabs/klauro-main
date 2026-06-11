import { BaseAnalyzer, CASAnalysisResult, CASNode, CASEdge, AnalysisContext, FileAnalysisContext } from './base-analyzer';
import {
  CASOutput,
  CASNestedRepository,
  CASAnalysisPhase,
  CASContribution,
  CASProgressiveLevels,
  CASCategories,
  CASPattern,
  CASBehavior,
  CASTag,
  CASIndex,
  CASPerspective,
  CASArchitectureSummary,
  CASRouteTableEntry,
  CASDatabaseSchema,
  CASDatabaseEntity,
  CASExternalService,
  CASEntryPoint,
  CASExitPoint,
  CASIntent,
  CASFlowSummary,
  CASChangeRisk,
  ChangeRiskFactor,
  CASChangeRiskSummary,
  CASDataEntity,
  CASDescriptionGeneration,
  CASDataSummary,
  CASBehavioralInvariant,
  CASBehavioralInvariantSummary,
  CASSecurityBoundary,
  CASSecuritySummary,
  CASFlowCoverage,
  CASTestGap,
  CASTemporalStability,
  CASStabilitySummary,
  CASCallChain,
  SystemCapability,
  SystemPurpose,
  CASWorkflow,
  CASWorkflowGraph,
  CASDomainConcept,
  EnhancedSystemPurpose,
  CASFlowGraph,
  CASTestSuite,
  CASTestCase,
  CASMock,
  CASFixture,
  CASTestSummary,
  CASAnalysisError,
  CASValidation,
  CASConfiguration,
  CASRuntime,
  CASRuntimeStaticLink,
  CASAnalysisFact,
  CASCrossRepositoryLink,
  CASMethodCall,
  CASDecorator,
  CASDocumentationSummary,
  CASTodoSummary,
  CASImplementationHealth,
  CASSystemHealth,
  CASSecurityContext,
  CASCallGraph,
  CASNodePerspective,
  CASLibrary,
  IncrementalState,
  ChangeSet,
  FileAnalysisRecord,
  ChangeReport,
  ChangeSemanticImpact,
  FileAnalysisResult,
  CAS_VERSION,
  INCREMENTAL_STATE_VERSION
} from '../../types/cas.types';
import { ChangeDetector } from './change-detector';
import { buildUserJourneys } from './journey-builder';
import { buildParadigmConformance } from './paradigm-conformance';
import { buildDataLineage } from './data-lineage';
import { isLanguageBuiltinName, isLanguageBuiltinExitPoint } from './language-builtins';
import { buildProductMap } from './product-map';
import { relativizeProjectPaths } from './relativize-project-paths';
import { CallGraphBuilder } from './call-graph-builder';
import { DomainExtractor } from './domain-extractor';
import { WorkflowDetector } from './workflow-detector';
import { CapabilityDetector } from './capability-detector';
import { CallChainAnalyzer } from './call-chain-analyzer';
import { CapabilityDependencyBuilder } from './capability-dependency-builder';
import { FlowScorer } from './flow-scorer';
import { FlowGraphBuilder } from './flow-graph-builder';
import { GitAnalyzer } from './git-analyzer';
import { detectCodebaseIdioms } from './idiom-detector';
import { AnalysisRunLog } from './run-log';
import { EmbeddingPhase, type EmbeddingPhaseConfig } from '../embedding/embedding-phase';
import { aiService } from '../../ai/ai-service';
import { aiConfig, getAIConfig } from '../../config/ai.config';

export type { CASOutput } from '../../types/cas.types';
import * as fs from 'fs-extra';
import { glob, globSync } from 'glob';
import * as path from 'path';

export interface AnalyzerRegistration {
  id: string;
  name: string;
  type: 'language' | 'framework' | 'library' | 'pattern';
  version: string;
  detectPatterns: {
    files?: string[];
    dependencies?: string[];
    imports?: string[];
    content?: RegExp[];
  };
  requires?: string[];
  enhances?: string[];
  analyzer: BaseAnalyzer;
}

export interface IncrementalAnalysisOptions {
  loadCache?: (contentHash: string) => Promise<FileAnalysisResult | null>;
  saveCache?: (contentHash: string, result: FileAnalysisResult) => Promise<void>;
}

export const KLAURO_SELF_CAPABILITY_NAMES: Readonly<Record<string, string>> = {
  agent: 'Agent Work Packets',
  analysis: 'Codebase Analysis',
  architecture: 'Architecture Mapping',
  answer: 'Answer Packs',
  cas: 'CAS Contract Validation',
  change: 'Change Impact Analysis',
  continuation: 'Agent Continuation',
  contract: 'Contract Impact Analysis',
  description: 'AI Description Enrichment',
  evidence: 'Evidence Validation',
  greenfield: 'Greenfield Planning',
  idiom: 'Codebase Idiom Guidance',
  incremental: 'Incremental Analysis',
  invariant: 'Behavioral Invariant Validation',
  klauro: 'Klauro CLI',
  machine: 'Machine Repo Gauntlet',
  project: 'Project Resolution',
  proposal: 'Proposal Preview',
  runtime: 'Runtime Telemetry',
  storage: 'Analysis Storage',
  task: 'Agent Task Proof',
  workspace: 'Workspace Mapping',
};

export const KLAURO_SELF_CAPABILITY_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'codebase analysis': 'Codebase Analysis builds a CAS relationship graph from repository structure so agents can understand entry points, data, tests, risks, and dependencies before editing.',
  'architecture mapping': 'Architecture Mapping identifies local patterns, ownership layers, and inventories so agents can place changes in the right architectural boundary.',
  'greenfield planning': 'Greenfield Planning compares a proposed product slice against existing capability memory so new projects avoid duplicate concepts and start with coherent architecture.',
  'proposal preview': 'Proposal Preview analyzes a proposed codebase iteration as a temporary CAS graph so reviewers can inspect changed contracts, risks, idioms, and test impact before the real repo changes.',
  'agent work packets': 'Agent Work Packets turns CAS graph matches, risks, idioms, and tests into a compact coding brief before an AI agent edits a repository.',
  'codebase idiom guidance': 'Codebase Idiom Guidance identifies local conventions and validates proposed changes against the patterns already used in the repository.',
  'analysis storage': 'Analysis Storage persists CAS outputs, snapshots, incremental state, and compressed artifacts so later MCP calls can reuse prior analysis.',
};

interface DetectedAnalyzerCacheEntry {
  expiresAt: number;
  projectRoots: string[];
  analyzerRootEntries: Array<[string, string]>;
  analyzers: AnalyzerRegistration[];
}

interface SourceFileInventory {
  expiresAt: number;
  files: string[];
  basenames: Map<string, string[]>;
  extensions: Map<string, string[]>;
}

interface ProjectTextSignal {
  primaryDomain?: string;
  concepts: string[];
  summary?: string;
  evidence: string[];
}

type DescriptionTargetKind = 'capability' | 'entity';

interface DescriptionTarget {
  id: string;
  name: string;
  kind: DescriptionTargetKind;
  currentDescription?: string;
  category?: string;
  source?: string;
  fields?: string[];
  operations?: string[];
  relatedEntities?: string[];
  relatedDomains?: string[];
  lifecycle?: {
    creates: number;
    reads: number;
    updates: number;
    deletes: number;
  };
}

interface EntityPropertyIndex {
  byParent: Map<string, Array<{ node: CASNode; position: number }>>;
  byFileBasename: Map<string, Array<{ node: CASNode; position: number; normalizedFile: string }>>;
}

interface DiscoveredEntryPointCandidate {
  file: string;
  type: CASEntryPoint['type'];
  name: string;
  description: string;
  trigger?: CASEntryPoint['trigger'];
}

export class AnalyzerOrchestrator {
  private analyzers: Map<string, AnalyzerRegistration> = new Map();
  private projectRoots: string[] = [];
  private analyzerRootMap: Map<string, string> = new Map();
  private manifestFileCache: Map<string, string[]> = new Map();
  private nestedRepoIgnoreCache: Map<string, string[]> = new Map();
  private detectedAnalyzerCache: Map<string, DetectedAnalyzerCacheEntry> = new Map();
  private sourceFileInventoryCache: Map<string, SourceFileInventory> = new Map();
  private nodeLookupSource: CASNode[] | null = null;
  private nodeLookupById: Map<string, CASNode> = new Map();
  private embeddingPhaseConfig: EmbeddingPhaseConfig | null = null;
  private activeAnalysisProjectPath?: string;
  private klauroSelfProjectCache: Map<string, boolean> = new Map();
  private static aiInterpretationTimeouts = 0;
  private static aiInterpretationDisabledUntil = 0;

  registerAnalyzer(registration: AnalyzerRegistration): void {
    this.analyzers.set(registration.id, registration);
    this.detectedAnalyzerCache.clear();
  }

  configureEmbedding(config: EmbeddingPhaseConfig | null): void {
    this.embeddingPhaseConfig = config;
  }

  private async applyEmbeddingPhase(output: CASOutput, projectPath: string): Promise<void> {
    if (this.embeddingPhaseConfig) {
      const phase = new EmbeddingPhase(this.embeddingPhaseConfig);
      await phase.run(output, projectPath);
    }
    this.compactSourceRaw(output);
    relativizeProjectPaths(output, projectPath);
  }

  private compactSourceRaw(output: CASOutput): void {
    const omitRaw = output.nodes.length > 10_000;
    const maxRawChars = 2_000;
    for (const node of output.nodes) {
      if (!node.source?.raw) continue;
      if (omitRaw) {
        const { raw: _raw, ...source } = node.source;
        node.source = source;
        continue;
      }
      if (node.source.raw.length <= maxRawChars) continue;
      node.source = {
        ...node.source,
        raw: `${node.source.raw.slice(0, maxRawChars)}\n...`,
      };
    }
  }

  private async discoverProjectRoots(projectPath: string): Promise<string[]> {
    const rootSet = new Set<string>();
    rootSet.add(projectPath);

    try {
      const matches = await this.getManifestFiles(projectPath);
      for (const match of matches) {
        const absolutePath = path.join(projectPath, path.dirname(match));
        rootSet.add(absolutePath);
      }
    } catch {
    }

    return Array.from(rootSet).sort((a, b) => a.length - b.length);
  }

  private getManifestPatterns(): string[] {
    return [
      '**/package.json',
      '**/requirements*.txt',
      '**/setup.py',
      '**/pyproject.toml',
      '**/Pipfile',
      '**/pom.xml',
      '**/build.gradle',
      '**/build.gradle.kts',
      '**/Cargo.toml',
      '**/composer.json',
      '**/*.csproj',
      '**/*.fsproj',
      '**/*.vbproj',
      '**/*.sln',
      '**/go.mod',
      '**/pubspec.yaml'
    ];
  }

  private async getManifestFiles(projectPath: string): Promise<string[]> {
    const cached = this.manifestFileCache.get(projectPath);
    if (cached) return cached;
    const inventory = await this.getSourceFileInventory(projectPath);
    const matches = inventory.files.filter(file => this.isManifestFile(file));
    this.manifestFileCache.set(projectPath, matches);
    return matches;
  }

  private async getSourceFileInventory(projectPath: string): Promise<SourceFileInventory> {
    const cacheKey = path.resolve(projectPath);
    const cached = this.sourceFileInventoryCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached;

    const nestedRepoIgnores = await this.getNestedRepoIgnorePatterns(projectPath);
    const nestedIgnoredDirectories = new Set(nestedRepoIgnores
      .map(pattern => pattern.replace(/\/\*\*$/, ''))
      .filter(Boolean));
    const normalized = this.collectSourceInventoryFiles(projectPath, nestedIgnoredDirectories);
    const basenames = new Map<string, string[]>();
    const extensions = new Map<string, string[]>();

    for (const file of normalized) {
      const basename = path.basename(file).toLowerCase();
      const extension = path.extname(file).toLowerCase();
      const basenameMatches = basenames.get(basename) || [];
      basenameMatches.push(file);
      basenames.set(basename, basenameMatches);

      if (extension) {
        const extensionMatches = extensions.get(extension) || [];
        extensionMatches.push(file);
        extensions.set(extension, extensionMatches);
      }
    }

    const inventory = {
      expiresAt: Date.now() + 60_000,
      files: normalized,
      basenames,
      extensions
    };
    this.sourceFileInventoryCache.set(cacheKey, inventory);
    return inventory;
  }

  private collectSourceInventoryFiles(projectPath: string, nestedIgnoredDirectories: Set<string>): string[] {
    const files: string[] = [];
    const walk = (absoluteDirectory: string, relativeDirectory: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(absoluteDirectory, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
        const normalizedRelativePath = relativePath.replace(/\\/g, '/');

        if (entry.isDirectory()) {
          if (this.isIgnoredInventoryDirectory(entry.name, normalizedRelativePath, nestedIgnoredDirectories)) {
            continue;
          }
          walk(path.join(absoluteDirectory, entry.name), normalizedRelativePath);
          continue;
        }

        if (
          entry.isFile() &&
          !this.isIgnoredInventoryFile(normalizedRelativePath) &&
          this.isSourceInventoryCandidate(normalizedRelativePath)
        ) {
          files.push(normalizedRelativePath);
        }
      }
    };

    walk(projectPath, '');
    return Array.from(new Set(files)).sort();
  }

  private isIgnoredInventoryDirectory(
    directoryName: string,
    relativePath: string,
    nestedIgnoredDirectories: Set<string>
  ): boolean {
    if (nestedIgnoredDirectories.has(relativePath)) return true;
    if (relativePath === 'bin') return false;
    return new Set([
      'node_modules',
      'dist',
      'build',
      '.git',
      '.claude',
      '.codex',
      '.scannerwork',
      'target',
      'vendor',
      'vendors',
      'site-packages',
      '__pycache__',
      '.venv',
      'venv',
      'env',
      '.tox',
      '.terraform',
      '.pytest_cache',
      '.mypy_cache',
      '.ruff_cache',
      '.dart_tool',
      '.gradle',
      'Pods',
      'bin',
      'obj',
      '.next',
      '.turbo',
      '.cache',
      '.vite',
      '.sourcemaps',
      'out',
      'storybook-static',
      'storybook-build',
      'Generated',
      'generated'
    ]).has(directoryName) || directoryName.startsWith('.klauro');
  }

  private isIgnoredInventoryFile(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/').toLowerCase();
    if (normalized.endsWith('.min.js') || normalized.endsWith('.min.css')) return true;
    return [
      '/lib/waypoints/',
      '/lib/owlcarousel/',
      '/lib/chart/',
      '/lib/easing/',
      '/lib/tempusdominus/',
      '/lib/bootstrap/',
      '/lib/jquery/',
      '/www/build/',
      '/www/assets/',
      '/public/assets/',
      '/static/assets/',
      '/downloads/'
    ].some(fragment => `/${normalized}`.includes(fragment));
  }

  private isSourceInventoryCandidate(filePath: string): boolean {
    const basename = path.basename(filePath).toLowerCase();
    if (this.isManifestFile(filePath)) return true;
    if ([
      'artisan',
      'manage.py',
      'console',
      'angular.json',
      'cypress.json'
    ].includes(basename)) return true;
    if (/^(next|jest|cypress)\.config\.(js|ts|mjs|cjs)$/.test(basename)) return true;
    if (filePath.toLowerCase().endsWith('prisma/schema.prisma')) return true;
    return /\.(js|jsx|ts|tsx|mjs|cjs|py|java|cs|go|rs|php|dart|tf|tfvars|xaml)$/i.test(filePath);
  }

  private isManifestFile(filePath: string): boolean {
    const basename = path.basename(filePath).toLowerCase();
    if (basename === 'package.json') return true;
    if (/^requirements.*\.txt$/.test(basename)) return true;
    if (basename === 'setup.py') return true;
    if (basename === 'pyproject.toml') return true;
    if (basename === 'pipfile') return true;
    if (basename === 'pom.xml') return true;
    if (basename === 'build.gradle') return true;
    if (basename === 'build.gradle.kts') return true;
    if (basename === 'cargo.toml') return true;
    if (basename === 'composer.json') return true;
    if (basename === 'gemfile') return true;
    if (basename === 'gemfile.lock') return true;
    if (basename === 'go.mod') return true;
    if (basename === 'pubspec.yaml') return true;
    return /\.(csproj|fsproj|vbproj|sln)$/i.test(filePath);
  }

  private async getNestedRepoIgnorePatterns(projectPath: string): Promise<string[]> {
    const cached = this.nestedRepoIgnoreCache.get(projectPath);
    if (cached) return cached;

    try {
      const discoveryIgnores = this.getProjectDiscoveryIgnorePatterns()
        .filter(pattern => !pattern.includes('.git'));
      const gitEntries = await glob('**/.git', {
        cwd: projectPath,
        dot: true,
        ignore: discoveryIgnores
      });
      const patterns = Array.from(new Set(gitEntries
        .map(entry => path.dirname(entry).replace(/\\/g, '/'))
        .filter(directory => directory && directory !== '.')
        .map(directory => `${directory}/**`)));
      this.nestedRepoIgnoreCache.set(projectPath, patterns);
      return patterns;
    } catch {
      this.nestedRepoIgnoreCache.set(projectPath, []);
      return [];
    }
  }

  private getProjectDiscoveryIgnorePatterns(): string[] {
    return [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '.git/**',
      '**/.git/**',
      '.claude/**',
      '**/.claude/**',
      '.codex/**',
      '**/.codex/**',
      '.scannerwork/**',
      '**/.scannerwork/**',
      '**/target/**',
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
      'site-packages/**',
      '**/site-packages/**',
      '**/__pycache__/**',
      '.venv/**',
      '**/.venv/**',
      '.venv*/**',
      '**/.venv*/**',
      'venv/**',
      '**/venv/**',
      'venv*/**',
      '**/venv*/**',
      'env/**',
      '**/env/**',
      'env*/**',
      '**/env*/**',
      '.tox/**',
      '**/.tox/**',
      '.pytest_cache/**',
      '**/.pytest_cache/**',
      '.mypy_cache/**',
      '**/.mypy_cache/**',
      '.ruff_cache/**',
      '**/.ruff_cache/**',
      '**/.dart_tool/**',
      '**/.gradle/**',
      '**/Pods/**',
      '**/bin/**',
      '**/obj/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/.cache/**',
      '**/.klauro*/**',
      '**/.vite/**',
      '**/.sourcemaps/**',
      '**/out/**',
      '**/storybook-static/**',
      '**/storybook-build/**',
      '**/www/build/**',
      '**/www/assets/**',
      '**/public/assets/**',
      '**/static/assets/**',
      '**/Downloads/**',
      '**/Generated/**',
      '**/generated/**'
    ];
  }

  async detectAnalyzers(projectPath: string): Promise<AnalyzerRegistration[]> {
    const cacheKey = path.resolve(projectPath);
    const cached = this.detectedAnalyzerCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      this.projectRoots = [...cached.projectRoots];
      this.analyzerRootMap = new Map(cached.analyzerRootEntries);
      return [...cached.analyzers];
    }

    this.projectRoots = await this.discoverProjectRoots(projectPath);
    this.analyzerRootMap.clear();

    const detected: AnalyzerRegistration[] = [];

    for (const registration of this.analyzers.values()) {
      if (await this.shouldUseAnalyzer(projectPath, registration)) {
        detected.push(registration);
      }
    }

    const ordered = this.orderAnalyzers(detected);
    this.detectedAnalyzerCache.set(cacheKey, {
      expiresAt: Date.now() + 60_000,
      projectRoots: [...this.projectRoots],
      analyzerRootEntries: [...this.analyzerRootMap.entries()],
      analyzers: [...ordered],
    });
    return ordered;
  }

  private invalidateProjectDiscovery(projectPath: string): void {
    const cacheKey = path.resolve(projectPath);
    this.detectedAnalyzerCache.delete(cacheKey);
    this.manifestFileCache.delete(projectPath);
    this.nestedRepoIgnoreCache.delete(projectPath);
    this.sourceFileInventoryCache.delete(cacheKey);
  }

  async orchestrateAnalysis(projectPath: string): Promise<CASOutput> {
    this.activeAnalysisProjectPath = projectPath;
    const analysisId = `analysis_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const runLog = new AnalysisRunLog(projectPath, analysisId, CAS_VERSION);
    try {
      return await this.executeAnalysis(projectPath, analysisId, runLog);
    } catch (error) {
      runLog.fail(error);
      throw error;
    }
  }

  private async executeAnalysis(projectPath: string, analysisId: string, runLog: AnalysisRunLog): Promise<CASOutput> {
    const startTime = Date.now();
    const timings: Record<string, number> = {};
    const logTiming = (phase: string, start: number) => {
      timings[phase] = Date.now() - start;
      runLog.recordPhase(phase, start, timings[phase]);
    };

    let phaseStart = Date.now();
    const detectedAnalyzers = await this.detectAnalyzers(projectPath);
    logTiming('detectAnalyzers', phaseStart);
    const context: AnalysisContext = {
      projectPath,
      filters: await this.getNestedRepoIgnorePatterns(projectPath)
    };

    const allNodes: CASNode[] = [];
    const allEdges: CASEdge[] = [];
    const allEntryPoints: any[] = [];
    const allExitPoints: any[] = [];
    const allLibraries: any[] = [];
    const allBehaviors: CASBehavior[] = [];
    const allPatterns: CASPattern[] = [];
    const allTags: CASTag[] = [];
    const allPerspectives: CASPerspective[] = [];
    const categories: CASCategories = {};
    const contributions: any[] = [];
    const analysisErrors: CASAnalysisError[] = [];

    const accumulators = {
      allNodes, allEdges, allEntryPoints, allExitPoints,
      allBehaviors, allPatterns, allTags, allPerspectives,
      allLibraries, categories, contributions, analysisErrors
    };

    this.collectProjectReadabilityWarnings(projectPath, analysisErrors);

    const languageAnalyzers = detectedAnalyzers.filter(r => r.type === 'language');
    const parallelAnalyzers = detectedAnalyzers.filter(r => r.type === 'framework' || r.type === 'library');
    const patternAnalyzers = detectedAnalyzers.filter(r => r.type === 'pattern');

    phaseStart = Date.now();
    for (const registration of languageAnalyzers) {
      try {
        const langStart = Date.now();
        await this.runAnalyzer(registration, context, projectPath, accumulators);
        logTiming(`language_${registration.id}`, langStart);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error running analyzer ${registration.id}:`, error);
        analysisErrors.push({
          severity: 'error',
          code: 'ANALYZER_FAILURE',
          message: `${registration.name} failed: ${message}`,
          analyzer: registration.id,
          recoverable: true
        });
      }
    }
    logTiming('languageAnalyzers', phaseStart);

    phaseStart = Date.now();
    if (parallelAnalyzers.length > 0) {
      const languageSnapshot: CASContribution = {
        nodes: [...allNodes],
        edges: [...allEdges],
        entry_points: [...allEntryPoints],
        exit_points: [...allExitPoints],
        analyzer_metadata: {
          analyzer_id: 'merged',
          analyzer_name: 'Merged Analysis',
          version: '1.0.0',
          contribution_type: 'pattern' as const,
          nodes_contributed: allNodes.length,
          edges_contributed: allEdges.length,
          contributed_entry_points: allEntryPoints.length,
          contributed_exit_points: allExitPoints.length
        }
      };

      const parallelResults = await Promise.allSettled(
        parallelAnalyzers.map(async (registration) => {
          const analyzerStartTime = Date.now();
          const matchedRoot = this.analyzerRootMap.get(registration.id) || projectPath;

          const scopedFilters = this.getAnalyzerScopeFilters(projectPath, matchedRoot, registration);
          const analyzerContext: AnalysisContext = {
            ...context,
            projectPath: matchedRoot,
            filters: [
              ...(context.filters || []),
              ...scopedFilters
            ],
            existingAnalysis: [languageSnapshot]
          };

          const result = await registration.analyzer.analyze(analyzerContext);
          const executionTime = Date.now() - analyzerStartTime;

          if (matchedRoot !== projectPath) {
            const relPrefix = path.relative(projectPath, matchedRoot);
            this.normalizeFilePaths(result, relPrefix);
          }

          return { registration, result, executionTime };
        })
      );

      const successfulResults = parallelResults
        .filter((r): r is PromiseFulfilledResult<{ registration: AnalyzerRegistration; result: CASContribution; executionTime: number }> =>
          r.status === 'fulfilled'
        )
        .map(r => r.value);

      successfulResults.sort((a, b) => a.registration.id.localeCompare(b.registration.id));

      parallelResults.forEach((r, i) => {
        if (r.status === 'rejected') {
          const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
          console.error(`Error running analyzer ${parallelAnalyzers[i].id}:`, r.reason);
          analysisErrors.push({
            severity: 'error',
            code: 'ANALYZER_FAILURE',
            message: `${parallelAnalyzers[i].name} failed: ${message}`,
            analyzer: parallelAnalyzers[i].id,
            recoverable: true
          });
        }
      });

      for (const { registration, result, executionTime } of successfulResults) {
        this.mergeAnalysisResult(
          { allNodes, allEdges, allEntryPoints, allExitPoints },
          result
        );

        if (result.behaviors) allBehaviors.push(...result.behaviors);
        if (result.patterns) allPatterns.push(...result.patterns);
        if (result.categories) this.mergeCategories(categories, result.categories);
        if (result.tags) allTags.push(...result.tags);
        if (result.perspectives) allPerspectives.push(...result.perspectives);

        const analyzerMeta = result.analyzer_metadata || {};
        if (Array.isArray(analyzerMeta.warnings)) {
          for (const warning of analyzerMeta.warnings) {
            analysisErrors.push({
              severity: 'warning',
              code: 'PARTIAL_ANALYSIS',
              message: String(warning),
              analyzer: registration.id,
              recoverable: true
            });
          }
        }
        contributions.push({
          analyzer_id: registration.id,
          analyzer_name: registration.name,
          analyzer_version: registration.version,
          analyzer_type: registration.type,
          contribution_type: registration.type,
          execution_time_ms: executionTime,
          nodes_created: result.nodes?.length || 0,
          edges_created: result.edges?.length || 0,
          confidence: 1.0,
          contributed_categories: result.categories ? Object.keys(result.categories).length : 0,
          provided_perspectives: result.provided_perspectives || [],
          framework_specific: analyzerMeta.frameworks_detected || analyzerMeta.crates || undefined,
          application_type: analyzerMeta.application_type,
          project_name: analyzerMeta.project_name,
          project_version: analyzerMeta.project_version,
          warnings: Array.isArray(analyzerMeta.warnings) && analyzerMeta.warnings.length > 0 ? analyzerMeta.warnings : undefined
        });

        if (result.libraries) {
          allLibraries.push(...result.libraries);
        }
      }
    }

    for (const registration of patternAnalyzers) {
      try {
        await this.runAnalyzer(registration, context, projectPath, accumulators);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error running analyzer ${registration.id}:`, error);
        analysisErrors.push({
          severity: 'error',
          code: 'ANALYZER_FAILURE',
          message: `${registration.name} failed: ${message}`,
          analyzer: registration.id,
          recoverable: true
        });
      }
    }
    logTiming('frameworkAnalyzers', phaseStart);

    phaseStart = Date.now();
    this.applyCanonicalOrdering(allNodes, allEdges, allEntryPoints, allExitPoints, allLibraries);
    this.linkRouteHandlers(allNodes, allEdges, allEntryPoints);
    this.addDiscoveredEntryPoints(projectPath, allNodes, allEntryPoints, allEdges);
    this.normalizeNodeMetrics(allNodes);
    this.applyCanonicalOrdering(allNodes, allEdges, allEntryPoints, allExitPoints, allLibraries);
    logTiming('pp_linkRouteHandlers', phaseStart);

    phaseStart = Date.now();
    const systemName = path.basename(projectPath);
    const progressiveLevels = this.buildProgressiveLevels(allNodes, categories);
    logTiming('pp_progressiveLevels', phaseStart);

    phaseStart = Date.now();
    const index = this.buildIndex(allNodes, allEntryPoints, allExitPoints, allPerspectives);
    logTiming('pp_buildIndex', phaseStart);

    if (allLibraries.length === 0) {
      const detectedLibraries = this.detectLibrariesFromManifests(projectPath);
      allLibraries.push(...detectedLibraries);
    }

    phaseStart = Date.now();
    const architectureSummary = this.buildArchitectureSummary(allNodes, allEntryPoints, allExitPoints, contributions);
    const routeTable = this.buildRouteTable(allEntryPoints);
    const databaseSchema = this.buildDatabaseSchema(allNodes, allLibraries, projectPath);
    const externalServices = this.buildExternalServices(allNodes, allExitPoints, allLibraries);
    logTiming('pp_architecture', phaseStart);

    logTiming('pp_detectPatterns', Date.now());

    phaseStart = Date.now();
    const intents = this.buildIntents(allNodes);
    logTiming('pp_buildIntents', phaseStart);

    phaseStart = Date.now();
    const flowSummary = this.buildFlowSummary(allNodes, allEntryPoints);
    const dataEntities = this.buildDataEntities(allNodes, allEdges, projectPath);
    const dataSummary = this.buildDataSummary(dataEntities, allNodes);
    const securityBoundaries = this.buildSecurityBoundaries(allNodes, allEntryPoints);
    const securitySummary = this.buildSecuritySummary(securityBoundaries, allNodes, allEntryPoints);
    logTiming('pp_dataAndSecurity', phaseStart);

    phaseStart = Date.now();
    const gitAnalyzer = new GitAnalyzer(projectPath);
    let changeRisks: CASChangeRisk[] = [];
    let temporalStability: CASTemporalStability[] = [];

    if (gitAnalyzer.isAvailable()) {
      const filePathsForGit = allNodes
        .filter((n): n is CASNode & { source: { file: string } } => !!n.source?.file)
        .map(n => n.source.file);

      if (filePathsForGit.length <= 500) {
        gitAnalyzer.preloadAllFileMetrics(filePathsForGit);
        changeRisks = this.buildChangeRisks(allNodes, allEdges, allEntryPoints, gitAnalyzer);
        temporalStability = this.buildTemporalStability(allNodes, gitAnalyzer);
      } else {
        changeRisks = this.buildChangeRisks(allNodes, allEdges, allEntryPoints);
      }
    } else {
      changeRisks = this.buildChangeRisks(allNodes, allEdges, allEntryPoints);
    }
    logTiming('pp_gitAnalysis', phaseStart);

    phaseStart = Date.now();
    const changeRiskSummary = this.buildChangeRiskSummary(changeRisks);
    const stabilitySummary = this.buildStabilitySummary(temporalStability);
    const systemCapabilities = this.buildSystemCapabilities(allEntryPoints, dataEntities, allNodes, allEdges, projectPath);
    const systemPurpose = this.inferSystemPurpose(allEntryPoints, dataEntities, systemCapabilities, allNodes);
    logTiming('pp_capabilities', phaseStart);

    phaseStart = Date.now();
    const callGraphBuilder = new CallGraphBuilder(allNodes, allEdges, allExitPoints);
    const callChains = this.buildCallChains(allNodes, allEdges, allEntryPoints, allExitPoints, callGraphBuilder);
    logTiming('pp_callGraph', phaseStart);

    phaseStart = Date.now();
    this.enrichNodeCallGraphs(allNodes, callGraphBuilder, allEntryPoints, allExitPoints);
    this.deriveParentFromContainsEdges(allNodes, allEdges);
    this.enrichNodePerspectives(allNodes, allPerspectives);
    logTiming('pp_enrichNodes', phaseStart);

    phaseStart = Date.now();
    const flowCoverage = this.buildFlowCoverage(allNodes, allEntryPoints, callChains);
    const testGaps = this.buildTestGaps(flowCoverage, allNodes);
    logTiming('pp_flowCoverage', phaseStart);

    phaseStart = Date.now();
    const domainExtractor = new DomainExtractor();
    const domainConcepts = domainExtractor.extract(allNodes, allEntryPoints, dataEntities, allEdges, projectPath);
    logTiming('pp_domainConcepts', phaseStart);

    phaseStart = Date.now();
    const workflowDetector = new WorkflowDetector();
    const workflows = workflowDetector.detectWorkflows(allEntryPoints, callChains, allNodes, allEdges, allExitPoints);
    workflowDetector.classifyWorkflows(workflows, domainConcepts);
    const workflowGraph = workflowDetector.buildDependencyGraph(workflows, callChains, allNodes);
    logTiming('pp_workflows', phaseStart);

    phaseStart = Date.now();
    const flowGraph = this.buildFlowGraph(
      allEntryPoints,
      callChains,
      allNodes,
      allEdges,
      domainConcepts,
      dataEntities,
      databaseSchema,
      systemPurpose
    );
    logTiming('pp_flowGraph', phaseStart);

    phaseStart = Date.now();
    const enhancedChangeRisks = this.enhanceChangeRisks(changeRisks, callGraphBuilder, callChains, allEntryPoints);
    const enhancedFlowSummary = this.buildEnhancedFlowSummary(callChains, allEntryPoints);
    logTiming('pp_enhanceRisks', phaseStart);

    phaseStart = Date.now();
    const userJourneyResult = buildUserJourneys({
      nodes: allNodes,
      edges: allEdges,
      entryPoints: allEntryPoints,
      exitPoints: allExitPoints,
      callChains,
      dataEntities,
      changeRisks: enhancedChangeRisks,
    });
    const paradigmConformance = buildParadigmConformance({
      nodes: allNodes,
      edges: allEdges,
      entryPoints: allEntryPoints,
      exitPoints: allExitPoints,
    });
    const dataLineage = buildDataLineage({
      nodes: allNodes,
      edges: allEdges,
      dataEntities,
      exitPoints: allExitPoints,
      entryPoints: allEntryPoints,
      userJourneys: userJourneyResult.journeys,
    });
    logTiming('pp_userJourneys', phaseStart);

    phaseStart = Date.now();
    const productEntryPointsForPurpose = this.filterPrimaryProductEntryPoints(allEntryPoints, allNodes, projectPath);
    const entryPointSummary = this.summarizeEntryPoints(productEntryPointsForPurpose);
    const projectTextSignal = this.extractProjectTextSignal(projectPath);
    const frameworkNames = this.frameworkNamesForPurpose(contributions, allNodes, projectPath);
    const dbEntityNames = databaseSchema.entities.map(e => e.name);
    const externalServiceNames = externalServices.map(svc => svc.name);

    const enhancedSystemPurpose = this.buildEnhancedSystemPurpose(
      systemPurpose,
      domainConcepts,
      workflows,
      workflowGraph,
      domainExtractor,
      dbEntityNames,
      entryPointSummary,
      frameworkNames,
      externalServiceNames,
      systemCapabilities,
      flowGraph,
      systemName,
      projectTextSignal,
      allNodes,
      projectPath
    );
    logTiming('pp_enhancedPurpose', phaseStart);

    phaseStart = Date.now();
    const unanalyzedLanguages = this.scanUnanalyzedLanguages(projectPath);
    const nestedRepositories = await this.describeNestedRepositories(projectPath);
    await this.applyAIInterpretation(
      enhancedSystemPurpose,
      systemName,
      frameworkNames,
      entryPointSummary,
      dbEntityNames,
      externalServiceNames,
      flowGraph,
      domainConcepts,
      systemCapabilities,
      unanalyzedLanguages,
      this.libraryNamesForInterpretation(allLibraries)
    );
    logTiming('pp_aiInterpretation', phaseStart);

    const aiGeneration = enhancedSystemPurpose.description_generation;
    runLog.recordAi({
      provider_configured: this.hasAIInterpretationProviderConfigured(),
      providers: this.configuredAiInterpretationProviders(),
      attempted: aiGeneration?.attempted ?? false,
      outcome: aiGeneration?.status || 'unknown',
      reason: aiGeneration?.reason,
      duration_ms: timings['pp_aiInterpretation'],
      description_source: enhancedSystemPurpose.description_source,
    });

    phaseStart = Date.now();
    const methodCalls = this.buildMethodCalls(allNodes, allEdges);
    logTiming('pp_methodCalls', phaseStart);

    phaseStart = Date.now();
    const allDecorators = this.buildAllDecorators(allNodes);
    const documentationSummary = this.buildDocumentationSummary(allNodes);
    const todosSummary = this.buildTodosSummary(allNodes);
    const implementationHealth = this.buildImplementationHealth(allNodes);
    const securityContexts = this.buildSecurityContexts(allNodes, allEntryPoints, allEdges);
    const configuration = this.buildAllConfiguration(allNodes, allExitPoints, externalServices, projectPath);
    logTiming('pp_finalMetadata', phaseStart);

    phaseStart = Date.now();
    const testSuites = this.buildTestSuites(allNodes, allEntryPoints, projectPath);
    const mocks = this.buildMocks(allNodes);
    const fixtures = this.buildFixtures(allNodes);
    const testSummary = this.buildTestSummary(allNodes, allEntryPoints);
    const behavioralInvariants = this.buildBehavioralInvariants(allNodes, allEdges, allEntryPoints, databaseSchema, dataEntities, securityBoundaries, testSuites, projectPath);
    const behavioralInvariantSummary = this.buildBehavioralInvariantSummary(behavioralInvariants);
    logTiming('pp_testData', phaseStart);

    phaseStart = Date.now();
    const runtime = this.buildRuntime(projectPath, allEntryPoints, allExitPoints, externalServices, configuration, callChains);
    const repositoryLinks = this.buildRepositoryLinks(projectPath, allNodes, allEntryPoints, allExitPoints, externalServices, allLibraries, databaseSchema, configuration);
    const runtimeStaticLinks = this.buildRuntimeStaticLinks(allNodes, allEntryPoints, allExitPoints, callChains, externalServices);
    const analysisFacts = this.buildAnalysisFacts(
      allNodes,
      allEdges,
      allEntryPoints,
      allExitPoints,
      externalServices,
      workflows,
      systemCapabilities,
      runtimeStaticLinks,
      repositoryLinks,
      contributions
    );
    const idiomDetection = detectCodebaseIdioms({
      projectPath,
      nodes: allNodes,
      edges: allEdges,
      entryPoints: allEntryPoints,
      exitPoints: allExitPoints,
      databaseSchema,
      testSuites,
      behavioralInvariants,
      decorators: allDecorators,
      patterns: allPatterns,
      libraries: allLibraries,
      configuration,
      analysisFacts,
    });
    const systemHealth = this.buildSystemHealth(
      architectureSummary,
      implementationHealth,
      changeRiskSummary,
      idiomDetection,
      allNodes,
      callChains,
      runtime
    );
    const validation = this.buildValidation(allNodes, allEdges, allEntryPoints, allExitPoints, runtimeStaticLinks, analysisFacts);
    logTiming('pp_traceability', phaseStart);

    const totalTime = Date.now() - startTime;
    if (process.env.KLAURO_DEBUG_ANALYSIS_TIMINGS === '1') {
      console.error(`[Klauro] Analysis completed in ${totalTime}ms. Breakdown:`, JSON.stringify(timings, null, 2));
    }

    const output = {
      cas_version: CAS_VERSION,
      analysis_timestamp: new Date().toISOString(),
      analysis_id: analysisId,
      system: {
        id: `system_${systemName}`,
        name: systemName,
        type: this.determineSystemType(allNodes) as 'monorepo' | 'application' | 'library' | 'service' | 'package',
        root_path: projectPath,
        technologies: {
          ...this.extractTechnologies(contributions, allLibraries),
          unanalyzed_languages: unanalyzedLanguages,
          ...(nestedRepositories.length > 0 ? { nested_repositories: nestedRepositories } : {}),
        },
        quality: this.calculateQualityMetrics(allNodes)
      },
      analysis_phases: this.buildAnalysisPhases({
        hasAIProvider: this.hasAIInterpretationProviderConfigured(),
        systemDescriptionSource: enhancedSystemPurpose.description_source,
        capabilityDescriptionSource: systemCapabilities.some(capability => capability.description_source === 'ai') ? 'ai' : 'deterministic',
        embeddingEnabled: Boolean(this.embeddingPhaseConfig),
        runtimeSignals: runtimeStaticLinks.length,
      }),
      architecture_summary: architectureSummary,
      route_table: routeTable.length > 0 ? routeTable : undefined,
      database_schema: databaseSchema.entities.length > 0 ? databaseSchema : undefined,
      nodes: allNodes,
      edges: allEdges,
      entry_points: allEntryPoints,
      exit_points: allExitPoints,
      behaviors: allBehaviors.length > 0 ? allBehaviors : undefined,
      patterns: allPatterns.length > 0 ? allPatterns : undefined,
      categories: Object.keys(categories).length > 0 ? categories : undefined,
      tags: allTags.length > 0 ? allTags : undefined,
      perspectives: allPerspectives.length > 0 ? allPerspectives : undefined,
      index,
      external_services: externalServices.length > 0 ? externalServices : undefined,
      repository_links: repositoryLinks.length > 0 ? repositoryLinks : undefined,
      cross_repository_links: repositoryLinks.length > 0 ? repositoryLinks : undefined,
      libraries: allLibraries.length > 0 ? allLibraries : undefined,
      analyzer_contributions: contributions,
      progressive_levels: progressiveLevels,
      intents: intents.length > 0 ? intents : undefined,
      change_risk_summary: changeRiskSummary,
      data_entities: dataEntities.length > 0 ? dataEntities : undefined,
      data_summary: dataSummary,
      behavioral_invariants: behavioralInvariants.length > 0 ? behavioralInvariants : undefined,
      behavioral_invariant_summary: behavioralInvariants.length > 0 ? behavioralInvariantSummary : undefined,
      security_boundaries: securityBoundaries.length > 0 ? securityBoundaries : undefined,
      security_summary: securitySummary,
      flow_coverage: flowCoverage.length > 0 ? flowCoverage : undefined,
      test_gaps: testGaps.length > 0 ? testGaps : undefined,
      temporal_stability: temporalStability.length > 0 ? temporalStability : undefined,
      stability_summary: stabilitySummary,
      system_capabilities: systemCapabilities.length > 0 ? systemCapabilities : undefined,
      system_purpose: systemPurpose,
      call_chains: callChains.length > 0 ? callChains : undefined,
      workflows: workflows.length > 0 ? workflows : undefined,
      workflow_graph: workflowGraph,
      user_journeys: userJourneyResult.journeys.length > 0 ? userJourneyResult.journeys : undefined,
      user_journey_summary: userJourneyResult.journeys.length > 0 ? userJourneyResult.summary : undefined,
      paradigm_conformance: paradigmConformance.length > 0 ? paradigmConformance : undefined,
      data_lineage: dataLineage.length > 0 ? dataLineage : undefined,
      domain_concepts: domainConcepts.length > 0 ? domainConcepts : undefined,
      enhanced_system_purpose: enhancedSystemPurpose,
      flow_graph: flowGraph,
      flow_summary: enhancedFlowSummary,
      change_risks: enhancedChangeRisks.length > 0 ? enhancedChangeRisks : undefined,
      method_calls: methodCalls.length > 0 ? methodCalls : undefined,
      decorators: allDecorators.length > 0 ? allDecorators : undefined,
      documentation_summary: documentationSummary,
      todos_summary: todosSummary,
      implementation_health: implementationHealth,
      system_health: systemHealth,
      security_contexts: securityContexts.length > 0 ? securityContexts : undefined,
      configuration,
      runtime,
      runtime_static_links: runtimeStaticLinks.length > 0 ? runtimeStaticLinks : undefined,
      analysis_facts: analysisFacts.length > 0 ? analysisFacts : undefined,
      codebase_idioms: idiomDetection.idioms.length > 0 ? idiomDetection.idioms : undefined,
      idiom_summary: idiomDetection.idioms.length > 0 ? idiomDetection.summary : undefined,
      idiom_examples: idiomDetection.examples.length > 0 ? idiomDetection.examples : undefined,
      idiom_violations: idiomDetection.violations.length > 0 ? idiomDetection.violations : undefined,
      analysis_errors: analysisErrors,
      validation,
      test_suites: testSuites,
      mocks: mocks,
      fixtures: fixtures,
      test_summary: testSummary
    } as CASOutput;

    output.product_map = buildProductMap(output);

    phaseStart = Date.now();
    await this.applyEmbeddingPhase(output, projectPath);
    logTiming('pp_embeddingAndFinalize', phaseStart);

    const sourceFiles = new Set<string>();
    for (const node of output.nodes) {
      if (node.source?.file) sourceFiles.add(node.source.file);
    }
    runLog.recordAnalyzers(contributions);
    runLog.recordWarnings(analysisErrors);
    runLog.complete({
      nodes: output.nodes.length,
      edges: output.edges.length,
      entry_points: output.entry_points?.length || 0,
      exit_points: output.exit_points?.length || 0,
      files: sourceFiles.size,
      errors: analysisErrors.filter(issue => issue.severity === 'error').length,
      warnings: analysisErrors.filter(issue => issue.severity === 'warning').length,
    });
    return output;
  }

  async orchestrateIncrementalAnalysis(
    projectPath: string,
    previousOutput: CASOutput,
    previousState: IncrementalState | null,
    options?: IncrementalAnalysisOptions
  ): Promise<{
    output: CASOutput;
    state: IncrementalState;
    changeReport: ChangeReport;
    wasFullRebuild: boolean;
    fullRebuildReason?: string;
  }> {
    this.activeAnalysisProjectPath = projectPath;
    const changeDetector = new ChangeDetector(projectPath);
    const changeSet = await changeDetector.detectChanges(previousState);
    const schemaRebuildReason = this.fullRebuildReasonForPreviousOutput(previousOutput);

    if (schemaRebuildReason) {
      this.invalidateProjectDiscovery(projectPath);
      const output = await this.orchestrateAnalysis(projectPath);
      const state = this.buildIncrementalState(projectPath, output, changeDetector);
      const changeReport = this.buildChangeReport(
        previousOutput,
        output,
        {
          ...changeSet,
          requiresFullRebuild: true,
          reason: schemaRebuildReason
        }
      );
      return { output, state, changeReport, wasFullRebuild: true, fullRebuildReason: schemaRebuildReason };
    }

    if (!previousState) {
      const output = previousOutput?.analysis_id ? previousOutput : await this.orchestrateAnalysis(projectPath);
      const state = this.buildIncrementalState(projectPath, output, changeDetector);
      const changeReport = this.buildChangeReport(previousOutput, output, changeSet);
      return { output, state, changeReport, wasFullRebuild: true, fullRebuildReason: 'No previous analysis state' };
    }

    if (changeSet.requiresFullRebuild) {
      this.invalidateProjectDiscovery(projectPath);
      const output = await this.orchestrateAnalysis(projectPath);
      const state = this.buildIncrementalState(projectPath, output, changeDetector);
      const changeReport = this.buildChangeReport(previousOutput, output, changeSet);
      return { output, state, changeReport, wasFullRebuild: true, fullRebuildReason: changeSet.reason };
    }

    const totalChanges = changeSet.added.length + changeSet.modified.length + changeSet.deleted.length;
    if (totalChanges === 0) {
      const state: IncrementalState = {
        ...previousState,
        lastAnalysisTimestamp: Date.now(),
        gitCommitHash: changeDetector.getCurrentGitCommit()
      };
      const changeReport = this.buildChangeReport(previousOutput, previousOutput, changeSet);
      return { output: previousOutput, state, changeReport, wasFullRebuild: false };
    }

    const incrementalResult = await this.runIncrementalAnalysis(
      projectPath,
      previousOutput,
      previousState,
      changeSet,
      options
    );

    if (incrementalResult.wasFullRebuild) {
      this.invalidateProjectDiscovery(projectPath);
      const updatedState = this.buildIncrementalState(projectPath, incrementalResult.output, changeDetector);
      const changeReport = this.buildChangeReport(
        previousOutput,
        incrementalResult.output,
        {
          ...changeSet,
          requiresFullRebuild: true,
          reason: incrementalResult.fullRebuildReason || changeSet.reason
        }
      );

      return {
        output: incrementalResult.output,
        state: updatedState,
        changeReport,
        wasFullRebuild: true,
        fullRebuildReason: incrementalResult.fullRebuildReason || changeSet.reason
      };
    }

    let finalIncrementalPhaseStartedAt = Date.now();
    const debugFinalIncrementalPhase = (label: string) => {
      if (process.env.KLAURO_DEBUG_INCREMENTAL_PHASES !== '1') return;
      console.error(`[Klauro] incremental final phase ${label}: ${Date.now() - finalIncrementalPhaseStartedAt}ms`);
      finalIncrementalPhaseStartedAt = Date.now();
    };

    const updatedState = this.updateIncrementalState(
      previousState,
      incrementalResult,
      changeSet,
      changeDetector
    );
    debugFinalIncrementalPhase('update-state');

    const changeReport = this.buildIncrementalChangeReport(
      previousOutput,
      incrementalResult.output,
      previousState,
      changeSet,
      incrementalResult.fileResults
    );
    debugFinalIncrementalPhase('build-change-report');

    await this.applyEmbeddingPhase(incrementalResult.output, projectPath);
    debugFinalIncrementalPhase('apply-embedding-phase');

    return {
      output: incrementalResult.output,
      state: updatedState,
      changeReport,
      wasFullRebuild: false
    };
  }

  private fullRebuildReasonForPreviousOutput(previousOutput: CASOutput): string | null {
    if (previousOutput.cas_version !== CAS_VERSION) {
      return `CAS version changed (${previousOutput.cas_version || 'unknown'} -> ${CAS_VERSION})`;
    }
    if (!previousOutput.validation?.graph_integrity) {
      return 'CAS validation graph integrity is missing';
    }
    if ((previousOutput.entry_points?.length || 0) > 0 && !previousOutput.call_chains?.length) {
      return 'CAS call chains are missing for entry points';
    }
    if (!previousOutput.analysis_facts?.length) {
      return 'CAS analysis facts are missing';
    }
    return null;
  }

  private async runIncrementalAnalysis(
    projectPath: string,
    previousOutput: CASOutput,
    previousState: IncrementalState,
    changeSet: ChangeSet,
    options?: IncrementalAnalysisOptions
  ): Promise<{
    output: CASOutput;
    fileResults: Map<string, FileAnalysisResult>;
    wasFullRebuild?: boolean;
    fullRebuildReason?: string;
  }> {
    let incrementalPhaseStartedAt = Date.now();
    const debugIncrementalPhase = (label: string) => {
      if (process.env.KLAURO_DEBUG_INCREMENTAL_PHASES !== '1') return;
      console.error(`[Klauro] incremental phase ${label}: ${Date.now() - incrementalPhaseStartedAt}ms`);
      incrementalPhaseStartedAt = Date.now();
    };
    const detectedAnalyzers = await this.detectAnalyzers(projectPath);
    debugIncrementalPhase('detect-analyzers');
    const incrementalAnalyzers = detectedAnalyzers.filter(
      r => r.analyzer.supportsIncrementalAnalysis?.() && r.analyzer.analyzeFileSingle
    );

    if (incrementalAnalyzers.length === 0) {
      const output = await this.orchestrateAnalysis(projectPath);
      return {
        output,
        fileResults: new Map(),
        wasFullRebuild: true,
        fullRebuildReason: 'No detected analyzer supports single-file incremental analysis'
      };
    }

    const filesToAnalyze = [...changeSet.added, ...changeSet.modified];
    const candidateIncrementalAnalyzers = incrementalAnalyzers.filter(registration =>
      filesToAnalyze.some(filePath => this.analyzerCanHandleFile(registration.id, filePath))
    );
    debugIncrementalPhase('select-candidate-analyzers');
    const previousNodesById = new Map(previousOutput.nodes.map(node => [node.id, node]));
    const matchingAnalyzerPlansByFile = new Map<string, Array<{ registration: AnalyzerRegistration; relevantFiles: Set<string> }>>();
    const filesNeedingRelevanceScan: string[] = [];

    for (const relativePath of filesToAnalyze) {
      const expectedAnalyzerIds = this.expectedIncrementalAnalyzerIdsForFile(
        relativePath,
        previousState,
        previousNodesById
      );
      const directMatches = expectedAnalyzerIds.size > 0
        ? candidateIncrementalAnalyzers.filter(registration =>
          expectedAnalyzerIds.has(registration.id) && this.analyzerCanHandleFile(registration.id, relativePath)
        )
        : [];

      if (directMatches.length > 0) {
        matchingAnalyzerPlansByFile.set(relativePath, directMatches.map(registration => ({
          registration,
          relevantFiles: new Set([relativePath])
        })));
      } else {
        filesNeedingRelevanceScan.push(relativePath);
      }
    }
    debugIncrementalPhase('plan-direct-matches');

    const analyzerPlans = filesNeedingRelevanceScan.length > 0
      ? await Promise.all(
        candidateIncrementalAnalyzers.map(async registration => ({
          registration,
          relevantFiles: new Set(await registration.analyzer.getRelevantFiles?.(projectPath) || [])
        }))
      )
      : [];
    debugIncrementalPhase('relevance-scan');

    const unsupportedFiles = filesToAnalyze.filter(relativePath => {
      const existingPlans = matchingAnalyzerPlansByFile.get(relativePath);
      if (existingPlans?.length) return false;

      const matchingPlans = analyzerPlans.filter(plan => plan.relevantFiles.has(relativePath));
      matchingAnalyzerPlansByFile.set(relativePath, matchingPlans);
      return matchingPlans.length === 0;
    });
    if (unsupportedFiles.length > 0) {
      const output = await this.orchestrateAnalysis(projectPath);
      return {
        output,
        fileResults: new Map(),
        wasFullRebuild: true,
        fullRebuildReason: `Changed files are not supported by single-file incremental analyzers: ${unsupportedFiles.slice(0, 5).join(', ')}`
      };
    }

    const filesWithUnsupportedDerivedFacts = filesToAnalyze.filter(relativePath => {
      const record = previousState.files[relativePath];
      if (!record) return false;

      const coveredAnalyzers = new Set(
        (matchingAnalyzerPlansByFile.get(relativePath) || []).map(plan => plan.registration.id)
      );

      for (const nodeId of record.nodeIds) {
        const node = previousNodesById.get(nodeId);
        if (!node) continue;

        const nodeAnalyzers = new Set([
          ...(node.analyzers || []),
          ...(node.primaryAnalyzer ? [node.primaryAnalyzer] : [])
        ]);

        for (const analyzerId of nodeAnalyzers) {
          if (analyzerId && !coveredAnalyzers.has(analyzerId)) {
            return true;
          }
        }
      }

      return false;
    });
    debugIncrementalPhase('unsupported-derived-fact-check');
    const allNodes = [...previousOutput.nodes];
    const allEdges = [...previousOutput.edges];
    const allEntryPoints = [...(previousOutput.entry_points || [])];
    const allExitPoints = [...(previousOutput.exit_points || [])];

    const deletedNodeIds = new Set<string>();
    const deletedEdgeIds = new Set<string>();
    const deletedEntryPointIds = new Set<string>();
    const deletedExitPointIds = new Set<string>();

    for (const deletedFile of changeSet.deleted) {
      const record = previousState.files[deletedFile];
      if (record) {
        record.nodeIds.forEach(id => deletedNodeIds.add(id));
        record.edgeIds.forEach(id => deletedEdgeIds.add(id));
        record.entryPointIds.forEach(id => deletedEntryPointIds.add(id));
        record.exitPointIds.forEach(id => deletedExitPointIds.add(id));
      }
    }

    for (const modifiedFile of changeSet.modified) {
      const record = previousState.files[modifiedFile];
      if (record) {
        record.nodeIds.forEach(id => deletedNodeIds.add(id));
        record.edgeIds.forEach(id => deletedEdgeIds.add(id));
        record.entryPointIds.forEach(id => deletedEntryPointIds.add(id));
        record.exitPointIds.forEach(id => deletedExitPointIds.add(id));
      }
    }

    const filteredNodes = allNodes.filter(n => !deletedNodeIds.has(n.id));
    const filteredEdges = allEdges.filter(e => !deletedEdgeIds.has(e.id));
    const filteredEntryPoints = allEntryPoints.filter(ep => !deletedEntryPointIds.has(ep.id));
    const filteredExitPoints = allExitPoints.filter(ex => !deletedExitPointIds.has(ex.id));
    debugIncrementalPhase('filter-previous-graph');

    const fileResults = new Map<string, FileAnalysisResult>();
    const failedFiles: string[] = [];
    const BATCH_SIZE = 8;
    const previousSnapshot: CASContribution = {
      nodes: previousOutput.nodes,
      edges: previousOutput.edges,
      entry_points: previousOutput.entry_points || [],
      exit_points: previousOutput.exit_points || [],
      analyzer_metadata: {
        analyzer_id: 'previous-output',
        analyzer_name: 'Previous Output',
        version: previousOutput.cas_version,
        contribution_type: 'pattern',
        nodes_contributed: previousOutput.nodes.length,
        edges_contributed: previousOutput.edges.length,
        contributed_entry_points: previousOutput.entry_points?.length || 0,
        contributed_exit_points: previousOutput.exit_points?.length || 0
      }
    };

    for (let i = 0; i < filesToAnalyze.length; i += BATCH_SIZE) {
      const batch = filesToAnalyze.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (relativePath) => {
          const fullPath = path.join(projectPath, relativePath);
          try {
            const stat = await fs.stat(fullPath);
            const content = await fs.readFile(fullPath, 'utf-8');
            const contentHash = this.computeContentHash(content);

            const matchingPlans = matchingAnalyzerPlansByFile.get(relativePath) || [];
            const combinedResult: FileAnalysisResult = {
              filePath: relativePath,
              contentHash,
              mtimeMs: stat.mtimeMs,
              nodes: [],
              edges: [],
              entryPoints: [],
              exitPoints: [],
              imports: [],
              exports: []
            };

            for (const { registration } of matchingPlans) {
              if (!registration.analyzer.analyzeFileSingle) continue;

              const cacheKey = `${registration.id}_${contentHash}`;
              let result = options?.loadCache ? await options.loadCache(cacheKey) : null;
              if (!result) {
                const context: FileAnalysisContext = {
                  filePath: fullPath,
                  relativePath,
                  projectPath,
                  contentHash,
                  existingAnalysis: [previousSnapshot]
                };
                result = await registration.analyzer.analyzeFileSingle(context);

                if (options?.saveCache && result) {
                  await options.saveCache(cacheKey, result);
                }
              }

              this.mergeFileAnalysisResult(combinedResult, result);
            }

            combinedResult.imports = [...new Set(combinedResult.imports)];
            combinedResult.exports = [...new Set(combinedResult.exports)];

            return { relativePath, result: combinedResult, success: true };
          } catch (error) {
            console.warn(`Failed to analyze file ${relativePath}:`, error);
            return { relativePath, result: null, success: false };
          }
        })
      );

      for (const { relativePath, result, success } of batchResults) {
        if (success && result) {
          fileResults.set(relativePath, result);
          filteredNodes.push(...result.nodes);
          filteredEdges.push(...result.edges);
          filteredEntryPoints.push(...result.entryPoints);
          filteredExitPoints.push(...result.exitPoints);
        } else {
          failedFiles.push(relativePath);
        }
      }
    }
    debugIncrementalPhase('analyze-changed-files');

    if (failedFiles.length > 0 || fileResults.size !== filesToAnalyze.length) {
      const output = await this.orchestrateAnalysis(projectPath);
      const incompleteFiles = filesToAnalyze.filter(file => !fileResults.has(file));
      return {
        output,
        fileResults: new Map(),
        wasFullRebuild: true,
        fullRebuildReason: `Single-file incremental analysis failed or was incomplete for: ${[...failedFiles, ...incompleteFiles].slice(0, 5).join(', ')}`
      };
    }

    this.retainStableMissingFileFacts(
      projectPath,
      previousOutput,
      previousState,
      changeSet,
      fileResults
    );
    debugIncrementalPhase('retain-stable-missing-facts');

    const localizedOutput = this.tryBuildLocalizedIncrementalOutput(
      previousOutput,
      previousState,
      changeSet,
      fileResults
    );
    debugIncrementalPhase('try-localized-output');
    if (localizedOutput) {
      return { output: localizedOutput, fileResults };
    }

    if (filesWithUnsupportedDerivedFacts.length > 0) {
      const output = await this.orchestrateAnalysis(projectPath);
      return {
        output,
        fileResults: new Map(),
        wasFullRebuild: true,
        fullRebuildReason: `Changed files have derived analyzer facts without single-file support: ${filesWithUnsupportedDerivedFacts.slice(0, 5).join(', ')}`
      };
    }

    if (this.isStructuralNoopIncremental(previousOutput, previousState, changeSet, fileResults)) {
      return { output: previousOutput, fileResults };
    }

    const rebuiltOutput = await this.rebuildDerivedData(
      projectPath,
      filteredNodes,
      filteredEdges,
      filteredEntryPoints,
      filteredExitPoints,
      previousOutput
    );

    return { output: rebuiltOutput, fileResults };
  }

  private async rebuildDerivedData(
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[],
    previousOutput: CASOutput
  ): Promise<CASOutput> {
    const gitAnalyzer = new GitAnalyzer(projectPath);
    const filePathsForGit = nodes
      .filter((n): n is CASNode & { source: { file: string } } => !!n.source?.file)
      .map(n => n.source.file);
    gitAnalyzer.preloadAllFileMetrics(filePathsForGit);
    this.addDiscoveredEntryPoints(projectPath, nodes, entryPoints, edges);
    this.normalizeNodeMetrics(nodes);

    const categories = previousOutput.categories || {};
    const progressiveLevels = this.buildProgressiveLevels(nodes, categories);
    const index = this.buildIndex(nodes, entryPoints, exitPoints, previousOutput.perspectives || []);

    const libraries = previousOutput.libraries || [];
    const architectureSummary = this.buildArchitectureSummary(
      nodes, entryPoints, exitPoints, previousOutput.analyzer_contributions
    );
    const routeTable = this.buildRouteTable(entryPoints);
    const databaseSchema = this.buildDatabaseSchema(nodes, libraries, projectPath);
    const externalServices = this.buildExternalServices(nodes, exitPoints, libraries);

    const detectedPatterns = this.detectPatterns(nodes, edges);
    const intents = this.buildIntents(nodes);
    const flowSummary = this.buildFlowSummary(nodes, entryPoints);
    const changeRisks = this.buildChangeRisks(nodes, edges, entryPoints, gitAnalyzer);
    const changeRiskSummary = this.buildChangeRiskSummary(changeRisks);
    const dataEntities = this.buildDataEntities(nodes, edges, projectPath);
    const dataSummary = this.buildDataSummary(dataEntities, nodes);
    const securityBoundaries = this.buildSecurityBoundaries(nodes, entryPoints);
    const securitySummary = this.buildSecuritySummary(securityBoundaries, nodes, entryPoints);
    const temporalStability = this.buildTemporalStability(nodes, gitAnalyzer);
    const stabilitySummary = this.buildStabilitySummary(temporalStability);
    const testSuites = this.buildTestSuites(nodes, entryPoints, projectPath);
    const behavioralInvariants = this.buildBehavioralInvariants(nodes, edges, entryPoints, databaseSchema, dataEntities, securityBoundaries, testSuites, projectPath);
    const behavioralInvariantSummary = this.buildBehavioralInvariantSummary(behavioralInvariants);

    const systemCapabilities = this.buildSystemCapabilities(entryPoints, dataEntities, nodes, edges, projectPath);
    const systemPurpose = this.inferSystemPurpose(entryPoints, dataEntities, systemCapabilities, nodes);

    const callGraphBuilder = new CallGraphBuilder(nodes, edges, exitPoints);
    const callChains = this.buildCallChains(nodes, edges, entryPoints, exitPoints, callGraphBuilder);

    this.enrichNodeCallGraphs(nodes, callGraphBuilder, entryPoints, exitPoints);
    this.deriveParentFromContainsEdges(nodes, edges);
    this.enrichNodePerspectives(nodes, previousOutput.perspectives || []);

    const flowCoverage = this.buildFlowCoverage(nodes, entryPoints, callChains);
    const testGaps = this.buildTestGaps(flowCoverage, nodes);

    const domainExtractor = new DomainExtractor();
    const domainConcepts = domainExtractor.extract(nodes, entryPoints, dataEntities, edges, projectPath);

    const workflowDetector = new WorkflowDetector();
    const workflows = workflowDetector.detectWorkflows(entryPoints, callChains, nodes, edges, exitPoints);
    workflowDetector.classifyWorkflows(workflows, domainConcepts);
    const workflowGraph = workflowDetector.buildDependencyGraph(workflows, callChains, nodes);

    const flowGraph = this.buildFlowGraph(
      entryPoints,
      callChains,
      nodes,
      edges,
      domainConcepts,
      dataEntities,
      databaseSchema,
      systemPurpose
    );

    const enhancedChangeRisks = this.enhanceChangeRisks(changeRisks, callGraphBuilder, callChains, entryPoints);
    const userJourneyResult = buildUserJourneys({
      nodes,
      edges,
      entryPoints,
      exitPoints,
      callChains,
      dataEntities,
      changeRisks: enhancedChangeRisks,
    });
    const paradigmConformance = buildParadigmConformance({
      nodes,
      edges,
      entryPoints,
      exitPoints,
    });
    const dataLineage = buildDataLineage({
      nodes,
      edges,
      dataEntities,
      exitPoints,
      entryPoints,
      userJourneys: userJourneyResult.journeys,
    });
    const enhancedFlowSummary = this.buildEnhancedFlowSummary(callChains, entryPoints);
    const implementationHealth = this.buildImplementationHealth(nodes);
    const configuration = this.buildAllConfiguration(nodes, exitPoints, externalServices, projectPath);
    const runtime = this.buildRuntime(projectPath, entryPoints, exitPoints, externalServices, configuration, callChains);
    const repositoryLinks = this.buildRepositoryLinks(projectPath, nodes, entryPoints, exitPoints, externalServices, libraries, databaseSchema, configuration);
    const runtimeStaticLinks = this.buildRuntimeStaticLinks(nodes, entryPoints, exitPoints, callChains, externalServices);
    const analysisFacts = this.buildAnalysisFacts(
      nodes,
      edges,
      entryPoints,
      exitPoints,
      externalServices,
      workflows,
      systemCapabilities,
      runtimeStaticLinks,
      repositoryLinks,
      previousOutput.analyzer_contributions
    );
    const decorators = this.buildAllDecorators(nodes);
    const idiomDetection = detectCodebaseIdioms({
      projectPath,
      nodes,
      edges,
      entryPoints,
      exitPoints,
      databaseSchema,
      testSuites,
      behavioralInvariants,
      decorators,
      patterns: detectedPatterns,
      libraries,
      configuration,
      analysisFacts,
    });
    const systemHealth = this.buildSystemHealth(
      architectureSummary,
      implementationHealth,
      changeRiskSummary,
      idiomDetection,
      nodes,
      callChains,
      runtime
    );
    const validation = this.buildValidation(nodes, edges, entryPoints, exitPoints, runtimeStaticLinks, analysisFacts);

    const systemName = path.basename(projectPath);
    const analysisId = `analysis_incr_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Rebuild the enhanced system purpose so it stays consistent with the
    // freshly recomputed domain concepts, workflows, and flow graph. Without
    // this it would be carried forward verbatim from previousOutput and drift
    // out of sync with the rest of the analysis on every incremental run.
    const incrFrameworkNames = this.frameworkNamesForPurpose(previousOutput.analyzer_contributions || [], nodes, projectPath);
    const incrDbEntityNames = databaseSchema.entities.map(e => e.name);
    const incrExternalServiceNames = externalServices.map(svc => svc.name);
    const incrEntryPointSummary = this.summarizeEntryPoints(this.filterPrimaryProductEntryPoints(entryPoints, nodes, projectPath));
    const incrProjectTextSignal = this.extractProjectTextSignal(projectPath);
    const enhancedSystemPurpose = this.buildEnhancedSystemPurpose(
      systemPurpose,
      domainConcepts,
      workflows,
      workflowGraph,
      domainExtractor,
      incrDbEntityNames,
      incrEntryPointSummary,
      incrFrameworkNames,
      incrExternalServiceNames,
      systemCapabilities,
      flowGraph,
      previousOutput.system?.name || path.basename(projectPath),
      incrProjectTextSignal,
      nodes,
      projectPath
    );
    if (this.shouldRefreshAIInterpretation(
      previousOutput,
      systemName,
      incrFrameworkNames,
      incrEntryPointSummary,
      incrDbEntityNames,
      incrExternalServiceNames,
      flowGraph,
      domainConcepts,
      systemCapabilities
    )) {
      await this.applyAIInterpretation(
        enhancedSystemPurpose,
        systemName,
        incrFrameworkNames,
        incrEntryPointSummary,
        incrDbEntityNames,
        incrExternalServiceNames,
        flowGraph,
        domainConcepts,
        systemCapabilities,
        previousOutput.system?.technologies?.unanalyzed_languages || [],
        this.libraryNamesForInterpretation(libraries)
      );
    } else if (previousOutput.enhanced_system_purpose?.inferred_description) {
      enhancedSystemPurpose.inferred_description = previousOutput.enhanced_system_purpose.inferred_description;
      enhancedSystemPurpose.description_source = 'reused';
      enhancedSystemPurpose.description_generation = {
        status: 'reused_previous',
        attempted: false,
        reason: previousOutput.enhanced_system_purpose.description_generation?.status,
        generated_at: new Date().toISOString(),
      };
      if (previousOutput.enhanced_system_purpose.domain_source === 'ai' && previousOutput.enhanced_system_purpose.primary_domain) {
        enhancedSystemPurpose.primary_domain = previousOutput.enhanced_system_purpose.primary_domain;
        enhancedSystemPurpose.domain_source = 'reused';
      }
      const previousCapabilities = new Map((previousOutput.system_capabilities || []).map(capability => [capability.id, capability]));
      for (const capability of systemCapabilities) {
        const previous = previousCapabilities.get(capability.id);
        if (previous?.description && (previous.description_source === 'ai' || previous.description_source === 'manual' || previous.description_source === 'reused')) {
          capability.description = previous.description;
          capability.description_source = 'reused';
          capability.description_generation = {
            status: 'reused_previous',
            attempted: false,
            reason: previous.description_generation?.status,
            generated_at: new Date().toISOString(),
          };
        }
      }
    }

    const rebuiltOutput: CASOutput = {
      ...previousOutput,
      analysis_timestamp: new Date().toISOString(),
      analysis_id: analysisId,
      enhanced_system_purpose: enhancedSystemPurpose,
      analysis_phases: this.buildAnalysisPhases({
        hasAIProvider: this.hasAIInterpretationProviderConfigured(),
        systemDescriptionSource: enhancedSystemPurpose.description_source,
        capabilityDescriptionSource: systemCapabilities.some(capability => capability.description_source === 'ai') ? 'ai' : 'deterministic',
        embeddingEnabled: Boolean(this.embeddingPhaseConfig),
        runtimeSignals: runtimeStaticLinks.length,
      }),
      nodes,
      edges,
      entry_points: entryPoints,
      exit_points: exitPoints,
      progressive_levels: progressiveLevels,
      index,
      architecture_summary: architectureSummary,
      route_table: routeTable.length > 0 ? routeTable : undefined,
      database_schema: databaseSchema.entities.length > 0 ? databaseSchema : undefined,
      external_services: externalServices.length > 0 ? externalServices : undefined,
      repository_links: repositoryLinks.length > 0 ? repositoryLinks : undefined,
      cross_repository_links: repositoryLinks.length > 0 ? repositoryLinks : undefined,
      patterns: detectedPatterns.length > 0 ? detectedPatterns : undefined,
      intents: intents.length > 0 ? intents : undefined,
      flow_summary: enhancedFlowSummary,
      change_risks: enhancedChangeRisks.length > 0 ? enhancedChangeRisks : undefined,
      change_risk_summary: changeRiskSummary,
      data_entities: dataEntities.length > 0 ? dataEntities : undefined,
      data_summary: dataSummary,
      behavioral_invariants: behavioralInvariants.length > 0 ? behavioralInvariants : undefined,
      behavioral_invariant_summary: behavioralInvariants.length > 0 ? behavioralInvariantSummary : undefined,
      security_boundaries: securityBoundaries.length > 0 ? securityBoundaries : undefined,
      security_summary: securitySummary,
      temporal_stability: temporalStability.length > 0 ? temporalStability : undefined,
      stability_summary: stabilitySummary,
      system_capabilities: systemCapabilities.length > 0 ? systemCapabilities : undefined,
      system_purpose: systemPurpose,
      call_chains: callChains.length > 0 ? callChains : undefined,
      flow_coverage: flowCoverage.length > 0 ? flowCoverage : undefined,
      test_gaps: testGaps.length > 0 ? testGaps : undefined,
      workflows: workflows.length > 0 ? workflows : undefined,
      workflow_graph: workflowGraph,
      user_journeys: userJourneyResult.journeys.length > 0 ? userJourneyResult.journeys : undefined,
      user_journey_summary: userJourneyResult.journeys.length > 0 ? userJourneyResult.summary : undefined,
      paradigm_conformance: paradigmConformance.length > 0 ? paradigmConformance : undefined,
      data_lineage: dataLineage.length > 0 ? dataLineage : undefined,
      domain_concepts: domainConcepts.length > 0 ? domainConcepts : undefined,
      flow_graph: flowGraph,
      configuration,
      runtime,
      runtime_static_links: runtimeStaticLinks.length > 0 ? runtimeStaticLinks : undefined,
      analysis_facts: analysisFacts.length > 0 ? analysisFacts : undefined,
      decorators: decorators.length > 0 ? decorators : undefined,
      implementation_health: implementationHealth,
      system_health: systemHealth,
      codebase_idioms: idiomDetection.idioms.length > 0 ? idiomDetection.idioms : undefined,
      idiom_summary: idiomDetection.idioms.length > 0 ? idiomDetection.summary : undefined,
      idiom_examples: idiomDetection.examples.length > 0 ? idiomDetection.examples : undefined,
      idiom_violations: idiomDetection.violations.length > 0 ? idiomDetection.violations : undefined,
      validation,
      test_suites: testSuites
    };

    rebuiltOutput.product_map = buildProductMap(rebuiltOutput);
    return rebuiltOutput;
  }

  private buildIncrementalState(
    projectPath: string,
    output: CASOutput,
    changeDetector: ChangeDetector
  ): IncrementalState {
    const files: Record<string, FileAnalysisRecord> = {};

    const nodesByFile = new Map<string, CASNode[]>();
    const edgesByFile = new Map<string, CASEdge[]>();
    const entryPointsByFile = new Map<string, CASEntryPoint[]>();
    const exitPointsByFile = new Map<string, CASExitPoint[]>();
    const nodesById = new Map(output.nodes.map(node => [node.id, node]));

    for (const node of output.nodes) {
      if (node.source?.file) {
        const relativePath = path.isAbsolute(node.source.file)
          ? path.relative(projectPath, node.source.file)
          : node.source.file;
        if (!nodesByFile.has(relativePath)) {
          nodesByFile.set(relativePath, []);
        }
        nodesByFile.get(relativePath)!.push(node);
      }
    }

    for (const edge of output.edges) {
      const sourceNode = nodesById.get(edge.source);
      if (sourceNode?.source?.file) {
        const relativePath = path.isAbsolute(sourceNode.source.file)
          ? path.relative(projectPath, sourceNode.source.file)
          : sourceNode.source.file;
        if (!edgesByFile.has(relativePath)) {
          edgesByFile.set(relativePath, []);
        }
        edgesByFile.get(relativePath)!.push(edge);
      }
    }

    for (const ep of output.entry_points || []) {
      const sourceNode = nodesById.get(ep.source_node);
      if (sourceNode?.source?.file) {
        const relativePath = path.isAbsolute(sourceNode.source.file)
          ? path.relative(projectPath, sourceNode.source.file)
          : sourceNode.source.file;
        if (!entryPointsByFile.has(relativePath)) {
          entryPointsByFile.set(relativePath, []);
        }
        entryPointsByFile.get(relativePath)!.push(ep);
      }
    }

    for (const ex of output.exit_points || []) {
      const sourceNode = nodesById.get(ex.source_node);
      if (sourceNode?.source?.file) {
        const relativePath = path.isAbsolute(sourceNode.source.file)
          ? path.relative(projectPath, sourceNode.source.file)
          : sourceNode.source.file;
        if (!exitPointsByFile.has(relativePath)) {
          exitPointsByFile.set(relativePath, []);
        }
        exitPointsByFile.get(relativePath)!.push(ex);
      }
    }

    for (const [filePath, fileNodes] of nodesByFile) {
      const fullPath = path.join(projectPath, filePath);
      try {
        const stat = fs.statSync(fullPath);
        const content = fs.readFileSync(fullPath, 'utf-8');
        const contentHash = this.computeContentHash(content);

        files[filePath] = {
          filePath,
          contentHash,
          mtimeMs: stat.mtimeMs,
          lastAnalyzed: new Date().toISOString(),
          analyzerId: this.analyzerIdForNodes(fileNodes),
          nodeIds: fileNodes.map(n => n.id),
          edgeIds: (edgesByFile.get(filePath) || []).map(e => e.id),
          entryPointIds: (entryPointsByFile.get(filePath) || []).map(ep => ep.id),
          exitPointIds: (exitPointsByFile.get(filePath) || []).map(ex => ex.id),
          importedFiles: this.extractImportedFiles(fileNodes),
          exportedSymbols: this.extractExportedSymbols(fileNodes)
        };
      } catch {
      }
    }

    for (const filePath of this.getIncrementalSourceFiles(projectPath)) {
      if (files[filePath]) continue;
      const fullPath = path.join(projectPath, filePath);
      try {
        const stat = fs.statSync(fullPath);
        const content = fs.readFileSync(fullPath, 'utf-8');
        files[filePath] = {
          filePath,
          contentHash: this.computeContentHash(content),
          mtimeMs: stat.mtimeMs,
          lastAnalyzed: new Date().toISOString(),
          analyzerId: this.analyzerIdForFilePath(filePath),
          nodeIds: [],
          edgeIds: [],
          entryPointIds: [],
          exitPointIds: [],
          importedFiles: [],
          exportedSymbols: []
        };
      } catch {
      }
    }

    const analyzerVersions: Record<string, string> = {};
    for (const contribution of output.analyzer_contributions || []) {
      analyzerVersions[contribution.analyzer_id] = contribution.analyzer_version || '1.0.0';
    }

    return {
      version: INCREMENTAL_STATE_VERSION,
      projectPath,
      lastFullAnalysis: output.analysis_timestamp,
      lastAnalysisTimestamp: Date.now(),
      gitCommitHash: changeDetector.getCurrentGitCommit(),
      files,
      analyzerVersions
    };
  }

  private updateIncrementalState(
    previousState: IncrementalState,
    result: { output: CASOutput; fileResults: Map<string, FileAnalysisResult> },
    changeSet: ChangeSet,
    changeDetector: ChangeDetector
  ): IncrementalState {
    const files = { ...previousState.files };

    for (const deletedFile of changeSet.deleted) {
      delete files[deletedFile];
    }

    for (const [filePath, fileResult] of result.fileResults) {
        files[filePath] = {
          filePath: fileResult.filePath,
          contentHash: fileResult.contentHash,
          mtimeMs: fileResult.mtimeMs,
          lastAnalyzed: new Date().toISOString(),
          analyzerId: this.analyzerIdForNodes(fileResult.nodes),
          nodeIds: fileResult.nodes.map(n => n.id),
        edgeIds: fileResult.edges.map(e => e.id),
        entryPointIds: fileResult.entryPoints.map(ep => ep.id),
        exitPointIds: fileResult.exitPoints.map(ex => ex.id),
        importedFiles: fileResult.imports,
        exportedSymbols: fileResult.exports
      };
    }

    return {
      ...previousState,
      lastAnalysisTimestamp: Date.now(),
      gitCommitHash: changeDetector.getCurrentGitCommit(),
      files
    };
  }

  private analyzerIdForNodes(nodes: CASNode[]): string {
    return nodes.find(node => node.primaryAnalyzer)?.primaryAnalyzer ||
      nodes.find(node => node.analyzers?.length)?.analyzers?.[0] ||
      'unknown';
  }

  private dedupeById<T extends { id: string }>(items: T[]): T[] {
    const seen = new Set<string>();
    const deduped: T[] = [];

    for (const item of items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      deduped.push(item);
    }

    return deduped;
  }

  private mergeFileAnalysisResult(target: FileAnalysisResult, source: FileAnalysisResult): void {
    const nodeIds = new Set(target.nodes.map(node => node.id));
    const edgeIds = new Set(target.edges.map(edge => edge.id));
    const entryPointIds = new Set(target.entryPoints.map(entryPoint => entryPoint.id));
    const exitPointIds = new Set(target.exitPoints.map(exitPoint => exitPoint.id));

    for (const node of source.nodes) {
      if (!nodeIds.has(node.id)) {
        target.nodes.push(node);
        nodeIds.add(node.id);
        continue;
      }

      const existingNode = target.nodes.find(candidate => candidate.id === node.id);
      if (!existingNode) continue;

      if (node.metadata) {
        existingNode.metadata = {
          ...existingNode.metadata,
          ...node.metadata,
          attributes: {
            ...((existingNode.metadata as any)?.attributes || {}),
            ...((node.metadata as any)?.attributes || {})
          }
        };
      }
      if (node.subcategories?.length) {
        existingNode.subcategories = [...new Set([...(existingNode.subcategories || []), ...node.subcategories])];
      }
      if (node.level !== undefined) existingNode.level = node.level;
      if (node.level_name) existingNode.level_name = node.level_name;
      if (node.description) existingNode.description = node.description;
      if (node.tags?.length) existingNode.tags = [...new Set([...(existingNode.tags || []), ...node.tags])];
      if (node.type) existingNode.type = node.type;
      if (node.analyzers?.length) existingNode.analyzers = [...new Set([...(existingNode.analyzers || []), ...node.analyzers])];
      if (node.primaryAnalyzer) existingNode.primaryAnalyzer = node.primaryAnalyzer;
      if (node.documentation) existingNode.documentation = node.documentation;
      if (node.comments?.length) existingNode.comments = node.comments;
      if (node.todos?.length) existingNode.todos = node.todos;
      if (node.implementation_status) existingNode.implementation_status = node.implementation_status;
      if (node.signature) existingNode.signature = { ...existingNode.signature, ...node.signature };
    }

    for (const edge of source.edges) {
      if (edgeIds.has(edge.id)) continue;
      target.edges.push(edge);
      edgeIds.add(edge.id);
    }

    for (const entryPoint of source.entryPoints) {
      if (entryPointIds.has(entryPoint.id)) continue;
      target.entryPoints.push(entryPoint);
      entryPointIds.add(entryPoint.id);
    }

    for (const exitPoint of source.exitPoints) {
      if (exitPointIds.has(exitPoint.id)) continue;
      target.exitPoints.push(exitPoint);
      exitPointIds.add(exitPoint.id);
    }

    target.imports.push(...source.imports);
    target.exports.push(...source.exports);
  }

  private retainStableMissingFileFacts(
    projectPath: string,
    previousOutput: CASOutput,
    previousState: IncrementalState,
    changeSet: ChangeSet,
    fileResults: Map<string, FileAnalysisResult>
  ): void {
    if (changeSet.added.length > 0 || changeSet.deleted.length > 0) return;

    const previousNodesById = new Map(previousOutput.nodes.map(node => [node.id, node]));
    const previousEdgesById = new Map(previousOutput.edges.map(edge => [edge.id, edge]));
    const previousEntryPointsById = new Map((previousOutput.entry_points || []).map(entryPoint => [entryPoint.id, entryPoint]));
    const previousExitPointsById = new Map((previousOutput.exit_points || []).map(exitPoint => [exitPoint.id, exitPoint]));

    for (const filePath of changeSet.modified) {
      const record = previousState.files[filePath];
      const result = fileResults.get(filePath);
      if (!record || !result) continue;

      let content = '';
      try {
        content = fs.readFileSync(path.join(projectPath, filePath), 'utf8');
      } catch {
        continue;
      }

      const currentNodeIds = new Set(result.nodes.map(node => node.id));
      const retainedNodeIds = new Set<string>();

      for (const nodeId of record.nodeIds) {
        if (currentNodeIds.has(nodeId)) continue;
        const previousNode = previousNodesById.get(nodeId);
        if (!previousNode || !this.canRetainStableMissingNode(previousNode, content)) continue;
        result.nodes.push(previousNode);
        currentNodeIds.add(nodeId);
        retainedNodeIds.add(nodeId);
      }

      if (retainedNodeIds.size === 0) continue;

      const edgeIds = new Set(result.edges.map(edge => edge.id));
      for (const edgeId of record.edgeIds) {
        if (edgeIds.has(edgeId)) continue;
        const edge = previousEdgesById.get(edgeId);
        if (!edge) continue;
        if (currentNodeIds.has(edge.source) || currentNodeIds.has(edge.target)) {
          result.edges.push(edge);
          edgeIds.add(edgeId);
        }
      }

      const entryPointIds = new Set(result.entryPoints.map(entryPoint => entryPoint.id));
      for (const entryPointId of record.entryPointIds) {
        if (entryPointIds.has(entryPointId)) continue;
        const entryPoint = previousEntryPointsById.get(entryPointId);
        if (!entryPoint) continue;
        if (currentNodeIds.has(entryPoint.source_node) || Boolean(entryPoint.handler?.node_id && currentNodeIds.has(entryPoint.handler.node_id))) {
          result.entryPoints.push(entryPoint);
          entryPointIds.add(entryPointId);
        }
      }

      const exitPointIds = new Set(result.exitPoints.map(exitPoint => exitPoint.id));
      for (const exitPointId of record.exitPointIds) {
        if (exitPointIds.has(exitPointId)) continue;
        const exitPoint = previousExitPointsById.get(exitPointId);
        if (!exitPoint) continue;
        if (currentNodeIds.has(exitPoint.source_node)) {
          result.exitPoints.push(exitPoint);
          exitPointIds.add(exitPointId);
        }
      }
    }
  }

  private canRetainStableMissingNode(node: CASNode, currentFileContent: string): boolean {
    const raw = node.source?.raw?.trim();
    if (!raw || raw.includes('\n...')) return false;
    if (raw.length < 20 && this.isBehavioralIncrementalNode(node)) return false;
    return currentFileContent.includes(raw);
  }

  private tryBuildLocalizedIncrementalOutput(
    previousOutput: CASOutput,
    previousState: IncrementalState,
    changeSet: ChangeSet,
    fileResults: Map<string, FileAnalysisResult>
  ): CASOutput | null {
    if (changeSet.added.length > 0 || changeSet.deleted.length > 0 || changeSet.modified.length === 0) {
      return null;
    }

    const localizedEligibility = this.getLocalizedIncrementalMergeEligibility(previousOutput, previousState, changeSet, fileResults);
    if (!localizedEligibility.allowed) {
      this.debugLocalizedIncremental('skipped', localizedEligibility.reason, changeSet, fileResults);
      return null;
    }

    const localizedStartedAt = Date.now();
    let localizedPhaseStartedAt = localizedStartedAt;
    const debugPhase = (label: string) => {
      if (process.env.KLAURO_DEBUG_LOCALIZED_INCREMENTAL !== '1') return;
      console.error(`[Klauro] localized incremental timing ${label}: ${Date.now() - localizedPhaseStartedAt}ms`);
      localizedPhaseStartedAt = Date.now();
    };

    const nodeById = new Map(previousOutput.nodes.map(node => [node.id, node]));
    const edgeById = new Map(previousOutput.edges.map(edge => [edge.id, edge]));
    const entryPointById = new Map((previousOutput.entry_points || []).map(entryPoint => [entryPoint.id, entryPoint]));
    const exitPointById = new Map((previousOutput.exit_points || []).map(exitPoint => [exitPoint.id, exitPoint]));
    debugPhase('build-id-maps');

    for (const filePath of changeSet.modified) {
      const record = previousState.files[filePath];
      if (!record) continue;
      for (const nodeId of record.nodeIds) nodeById.delete(nodeId);
      for (const edgeId of record.edgeIds) edgeById.delete(edgeId);
      for (const entryPointId of record.entryPointIds) entryPointById.delete(entryPointId);
      for (const exitPointId of record.exitPointIds) exitPointById.delete(exitPointId);
    }
    debugPhase('remove-modified-file-facts');

    for (const result of fileResults.values()) {
      for (const node of result.nodes) nodeById.set(node.id, node);
      for (const edge of result.edges) edgeById.set(edge.id, edge);
      for (const entryPoint of result.entryPoints) entryPointById.set(entryPoint.id, entryPoint);
      for (const exitPoint of result.exitPoints) exitPointById.set(exitPoint.id, exitPoint);
    }
    debugPhase('merge-file-results');

    const nodes = [...nodeById.values()];
    const edges = [...edgeById.values()];
    const entryPoints = [...entryPointById.values()];
    const exitPoints = [...exitPointById.values()];
    debugPhase('materialize-arrays');
    const index = this.buildIndex(nodes, entryPoints, exitPoints, previousOutput.perspectives || []);
    debugPhase('build-index');
    const progressiveLevels = this.buildProgressiveLevels(nodes, previousOutput.categories || {});
    debugPhase('build-progressive-levels');
    const validation = this.buildValidation(
      nodes,
      edges,
      entryPoints,
      exitPoints,
      previousOutput.runtime_static_links || [],
      previousOutput.analysis_facts || []
    );
    debugPhase('build-validation');
    if (process.env.KLAURO_DEBUG_LOCALIZED_INCREMENTAL === '1') {
      console.error(`[Klauro] localized incremental timing total: ${Date.now() - localizedStartedAt}ms`);
    }

    return {
      ...previousOutput,
      analysis_timestamp: new Date().toISOString(),
      analysis_id: `analysis_incr_local_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      nodes,
      edges,
      entry_points: entryPoints,
      exit_points: exitPoints,
      progressive_levels: progressiveLevels,
      index,
      validation
    };
  }

  private getLocalizedIncrementalMergeEligibility(
    previousOutput: CASOutput,
    previousState: IncrementalState,
    changeSet: ChangeSet,
    fileResults: Map<string, FileAnalysisResult>
  ): { allowed: boolean; reason: string } {
    const previousNodesById = new Map(previousOutput.nodes.map(node => [node.id, node]));
    const previousEdgesById = new Map(previousOutput.edges.map(edge => [edge.id, edge]));
    const previousEntryPointsById = new Map((previousOutput.entry_points || []).map(entryPoint => [entryPoint.id, entryPoint]));
    const previousExitPointsById = new Map((previousOutput.exit_points || []).map(exitPoint => [exitPoint.id, exitPoint]));

    for (const filePath of changeSet.modified) {
      const record = previousState.files[filePath];
      const result = fileResults.get(filePath);
      if (!record || !result) return { allowed: false, reason: `missing record or file result for ${filePath}` };

      if (!this.sameLocalImportSet(record.importedFiles || [], result.imports || [])) {
        return { allowed: false, reason: `local import set changed for ${filePath}` };
      }

      const previousNodes = record.nodeIds
        .map(id => previousNodesById.get(id))
        .filter((node): node is CASNode => Boolean(node));
      const previousNodeIds = new Set(previousNodes.map(node => node.id));
      const currentNodeIds = new Set(result.nodes.map(node => node.id));
      const missingPreviousNodes = previousNodes.filter(node => !currentNodeIds.has(node.id));
      if (missingPreviousNodes.some(node => this.isBehavioralIncrementalNode(node))) {
        return { allowed: false, reason: `behavioral nodes disappeared for ${filePath}: ${missingPreviousNodes.slice(0, 5).map(node => `${node.type}:${node.name}`).join(', ')}` };
      }

      const addedNodes = result.nodes.filter(node => !previousNodeIds.has(node.id));
      const addedBehavioralNodeNames = new Set(addedNodes
        .filter(node => this.isBehavioralIncrementalNode(node))
        .map(node => node.name));
      if (!this.sameStringSet(record.exportedSymbols || [], result.exports || [])) {
        const exportTouchesAddedNode = (result.exports || []).some(exported => addedBehavioralNodeNames.has(exported));
        if (exportTouchesAddedNode) {
          return { allowed: false, reason: `export set changed with added behavioral node for ${filePath}` };
        }
      }
      const canPreserveDerivedFacts = true;

      const previousEntryPoints = record.entryPointIds
        .map(id => previousEntryPointsById.get(id))
        .filter((entryPoint): entryPoint is CASEntryPoint => Boolean(entryPoint));
      if (!this.sameFingerprint(previousEntryPoints, result.entryPoints, entryPoint => this.entryPointFingerprint(entryPoint))) {
        const entryPointsStayOnExistingNodes = result.entryPoints.every(entryPoint =>
          previousNodeIds.has(entryPoint.source_node) ||
          Boolean(entryPoint.handler?.node_id && previousNodeIds.has(entryPoint.handler.node_id))
        );
        if (!(canPreserveDerivedFacts && entryPointsStayOnExistingNodes)) {
          return { allowed: false, reason: `entry point fingerprint changed for ${filePath}` };
        }
      }

      const previousExitPoints = record.exitPointIds
        .map(id => previousExitPointsById.get(id))
        .filter((exitPoint): exitPoint is CASExitPoint => Boolean(exitPoint));
      if (!this.sameFingerprint(previousExitPoints, result.exitPoints, exitPoint => this.exitPointFingerprint(exitPoint))) {
        const exitPointsStayOnExistingNodes = result.exitPoints.every(exitPoint => previousNodeIds.has(exitPoint.source_node));
        if (!(canPreserveDerivedFacts && exitPointsStayOnExistingNodes)) {
          return { allowed: false, reason: `exit point fingerprint changed for ${filePath}` };
        }
      }

      const previousBehavioralEdges = record.edgeIds
        .map(id => previousEdgesById.get(id))
        .filter((edge): edge is CASEdge => Boolean(edge))
        .filter(edge => this.isBehavioralIncrementalEdge(edge));
      const currentBehavioralEdges = result.edges.filter(edge => this.isBehavioralIncrementalEdge(edge));
      if (!this.sameFingerprint(previousBehavioralEdges, currentBehavioralEdges, edge => this.edgeFingerprint(edge))) {
        const behavioralEdgesStayOnExistingNodes = currentBehavioralEdges.every(edge =>
          previousNodeIds.has(edge.source) && previousNodeIds.has(edge.target)
        );
        if (!(canPreserveDerivedFacts && behavioralEdgesStayOnExistingNodes)) {
          return { allowed: false, reason: `behavioral edge fingerprint changed for ${filePath}` };
        }
      }
    }

    return { allowed: true, reason: 'eligible' };
  }

  private debugLocalizedIncremental(
    status: string,
    reason: string,
    changeSet: ChangeSet,
    fileResults: Map<string, FileAnalysisResult>
  ): void {
    if (process.env.KLAURO_DEBUG_LOCALIZED_INCREMENTAL !== '1') return;
    const files = [...changeSet.modified, ...changeSet.added, ...changeSet.deleted].join(', ');
    const resultSummary = [...fileResults.entries()].map(([file, result]) =>
      `${file}: ${result.nodes.length} nodes, ${result.edges.length} edges, ${result.entryPoints.length} entries, ${result.exitPoints.length} exits`
    ).join('; ');
    console.error(`[Klauro] localized incremental ${status}: ${reason}; files=${files}; results=${resultSummary}`);
  }

  private sameStringSet(previous: string[], current: string[]): boolean {
    if (previous.length !== current.length) return false;
    const left = [...previous].sort();
    const right = [...current].sort();
    return left.every((value, index) => value === right[index]);
  }

  private sameLocalImportSet(previous: string[], current: string[]): boolean {
    return this.sameStringSet(
      previous.filter(imported => this.isLocalImportSpecifier(imported)).map(imported => imported.replace(/\\/g, '/')),
      current.filter(imported => this.isLocalImportSpecifier(imported)).map(imported => imported.replace(/\\/g, '/'))
    );
  }

  private isLocalImportSpecifier(imported: string): boolean {
    return imported.startsWith('.') || imported.startsWith('/') || /\.(ts|tsx|js|jsx|mjs|cjs|py|cs|java|go|rs|php|dart)$/i.test(imported);
  }

  private isBehavioralIncrementalNode(node: CASNode): boolean {
    return [
      'controller',
      'route',
      'handler',
      'service',
      'repository',
      'entity',
      'model',
      'serializer',
      'resolver',
      'mutation',
      'function',
      'method',
      'class',
      'component',
      'hook',
      'middleware',
      'guard',
      'module'
    ].includes(node.type);
  }

  private isBehavioralIncrementalEdge(edge: CASEdge): boolean {
    return [
      'calls',
      'uses',
      'depends_on',
      'imports',
      'exports',
      'data_access',
      'external_call',
      'authenticates',
      'authorizes',
      'validates',
      'handles'
    ].includes(edge.type) || edge.category === 'external' || edge.category === 'data' || edge.category === 'security';
  }

  private isStructuralNoopIncremental(
    previousOutput: CASOutput,
    previousState: IncrementalState,
    changeSet: ChangeSet,
    fileResults: Map<string, FileAnalysisResult>
  ): boolean {
    if (changeSet.added.length > 0 || changeSet.deleted.length > 0) return false;

    const previousNodesById = new Map(previousOutput.nodes.map(node => [node.id, node]));
    const previousEdgesById = new Map(previousOutput.edges.map(edge => [edge.id, edge]));
    const previousEntryPointsById = new Map((previousOutput.entry_points || []).map(entryPoint => [entryPoint.id, entryPoint]));
    const previousExitPointsById = new Map((previousOutput.exit_points || []).map(exitPoint => [exitPoint.id, exitPoint]));

    for (const filePath of changeSet.modified) {
      const record = previousState.files[filePath];
      const result = fileResults.get(filePath);
      if (!record || !result) return false;

      if (!this.sameFingerprint(
        record.nodeIds.map(id => previousNodesById.get(id)).filter((node): node is CASNode => Boolean(node)),
        result.nodes,
        node => this.nodeFingerprint(node)
      )) return false;

      if (!this.sameFingerprint(
        record.edgeIds.map(id => previousEdgesById.get(id)).filter((edge): edge is CASEdge => Boolean(edge)),
        result.edges,
        edge => this.edgeFingerprint(edge)
      )) return false;

      if (!this.sameFingerprint(
        record.entryPointIds.map(id => previousEntryPointsById.get(id)).filter((entryPoint): entryPoint is CASEntryPoint => Boolean(entryPoint)),
        result.entryPoints,
        entryPoint => this.entryPointFingerprint(entryPoint)
      )) return false;

      if (!this.sameFingerprint(
        record.exitPointIds.map(id => previousExitPointsById.get(id)).filter((exitPoint): exitPoint is CASExitPoint => Boolean(exitPoint)),
        result.exitPoints,
        exitPoint => this.exitPointFingerprint(exitPoint)
      )) return false;
    }

    return true;
  }

  private sameFingerprint<T extends { id: string }>(
    previousItems: T[],
    currentItems: T[],
    fingerprint: (item: T) => unknown
  ): boolean {
    if (previousItems.length !== currentItems.length) return false;

    const previous = previousItems
      .map(item => JSON.stringify(fingerprint(item)))
      .sort();
    const current = currentItems
      .map(item => JSON.stringify(fingerprint(item)))
      .sort();

    return previous.every((value, index) => value === current[index]);
  }

  private nodeFingerprint(node: CASNode): unknown {
    return {
      id: node.id,
      name: node.name,
      type: node.type,
      parent: node.parent,
      children: node.children,
      category: node.category,
      subcategories: node.subcategories,
      level: node.level,
      level_name: node.level_name,
      analyzers: node.analyzers,
      primaryAnalyzer: node.primaryAnalyzer,
      source: node.source ? {
        file: node.source.file,
        line: node.source.line,
        column: node.source.column,
        end_column: node.source.end_column
      } : undefined,
      metadata: node.metadata,
      signature: node.signature,
      implementation: node.implementation,
      description: node.description
    };
  }

  private edgeFingerprint(edge: CASEdge): unknown {
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: edge.type,
      category: edge.category,
      metadata: edge.metadata
    };
  }

  private entryPointFingerprint(entryPoint: CASEntryPoint): unknown {
    return {
      id: entryPoint.id,
      source_node: entryPoint.source_node,
      type: entryPoint.type,
      name: entryPoint.name,
      trigger: entryPoint.trigger,
      handler: entryPoint.handler,
      security: entryPoint.security,
      metadata: entryPoint.metadata
    };
  }

  private exitPointFingerprint(exitPoint: CASExitPoint): unknown {
    return {
      id: exitPoint.id,
      source_node: exitPoint.source_node,
      type: exitPoint.type,
      name: exitPoint.name,
      target: exitPoint.target,
      operation: exitPoint.operation,
      metadata: exitPoint.metadata
    };
  }

  private analyzerIdForFilePath(filePath: string): string {
    const extension = path.extname(filePath).toLowerCase();
    if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(extension)) return 'typescript-javascript';
    if (['.py', '.pyw'].includes(extension)) return 'python';
    if (extension === '.java') return 'java';
    if (['.kt', '.kts'].includes(extension)) return 'kotlin';
    if (['.cs', '.vb', '.fs'].includes(extension)) return 'csharp';
    if (extension === '.go') return 'go';
    if (extension === '.rs') return 'rust';
    if (extension === '.php') return 'php';
    if (extension === '.dart') return 'dart';
    return 'unknown';
  }

  private analyzerCanHandleFile(analyzerId: string, filePath: string): boolean {
    const extension = path.extname(filePath).toLowerCase();
    const jsTs = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
    const python = ['.py', '.pyw'];
    const dotnet = ['.cs', '.vb', '.fs'];

    if (analyzerId === 'typescript-javascript') return jsTs.includes(extension);
    if (['react', 'react-router', 'nestjs', 'express', 'jest', 'cypress'].includes(analyzerId)) return jsTs.includes(extension);
    if (analyzerId === 'python') return python.includes(extension);
    if (['flask', 'fastapi', 'django'].includes(analyzerId)) return python.includes(extension);
    if (analyzerId === 'java' || analyzerId === 'spring-boot') return extension === '.java';
    if (analyzerId === 'csharp' || analyzerId === 'aspnet-core' || analyzerId === 'wpf') return dotnet.includes(extension);
    if (analyzerId === 'go') return extension === '.go';
    if (analyzerId === 'rust' || analyzerId === 'actix' || analyzerId === 'rocket') return extension === '.rs';
    if (analyzerId === 'php' || analyzerId === 'laravel' || analyzerId === 'symfony') return extension === '.php';
    if (analyzerId === 'dart') return extension === '.dart';

    return true;
  }

  private expectedIncrementalAnalyzerIdsForFile(
    filePath: string,
    previousState: IncrementalState,
    previousNodesById: Map<string, CASNode>
  ): Set<string> {
    const analyzerIds = new Set<string>();
    const record = previousState.files[filePath];

    if (record?.analyzerId && record.analyzerId !== 'unknown') {
      analyzerIds.add(record.analyzerId);
    }

    for (const nodeId of record?.nodeIds || []) {
      const node = previousNodesById.get(nodeId);
      if (!node) continue;
      for (const analyzerId of node.analyzers || []) {
        if (analyzerId) analyzerIds.add(analyzerId);
      }
      if (node.primaryAnalyzer) analyzerIds.add(node.primaryAnalyzer);
    }

    if (record && analyzerIds.size === 0) {
      const analyzerId = this.analyzerIdForFilePath(filePath);
      if (analyzerId !== 'unknown') analyzerIds.add(analyzerId);
    }

    return analyzerIds;
  }

  private getIncrementalSourceFiles(projectPath: string): string[] {
    const coreConfigPatterns = [
      'package.json',
      'package-lock.json',
      'yarn.lock',
      'pnpm-lock.yaml',
      'tsconfig.json',
      'tsconfig.*.json',
      'angular.json',
      'nest-cli.json',
      'next.config.js',
      'next.config.mjs',
      'vite.config.ts',
      'vite.config.js',
      'webpack.config.js',
      'pyproject.toml',
      'setup.py',
      'requirements.txt',
      'Cargo.toml',
      'Cargo.lock',
      'go.mod',
      'go.sum',
      'pubspec.yaml',
      'pubspec.lock',
      'pom.xml',
      'build.gradle',
      'composer.json',
      'composer.lock'
    ].flatMap(pattern => [pattern, `**/${pattern}`]);

    const patterns = [
      '**/*.{ts,tsx,js,jsx,mjs,cjs}',
      '**/*.{py,pyw}',
      '**/*.java',
      '**/*.{kt,kts}',
      '**/*.{cs,vb,fs}',
      '**/*.go',
      '**/*.rs',
      '**/*.php',
      '**/*.dart',
      '**/*.prisma',
      ...coreConfigPatterns
    ];
    return globSync(patterns, {
      cwd: projectPath,
      ignore: [
        '**/node_modules/**',
        '**/dist/**',
        '**/build/**',
        '**/.git/**',
        '**/coverage/**',
        '**/.nyc_output/**',
        '**/__pycache__/**',
        '**/.pytest_cache/**',
        '**/target/**',
        'vendor/**',
        '**/vendor/**',
        'vendors/**',
        '**/vendors/**',
        'third_party/**',
        '**/third_party/**',
        'third-party/**',
        '**/third-party/**',
        '**/*_extracted/**',
        '**/*-extracted/**',
        'examples/**',
        '**/examples/**',
        'samples/**',
        '**/samples/**',
        'site-packages/**',
        '**/site-packages/**',
        '.venv/**',
        '**/.venv/**',
        '.venv*/**',
        '**/.venv*/**',
        'venv/**',
        '**/venv/**',
        'venv*/**',
        '**/venv*/**',
        'env/**',
        '**/env/**',
        '.tox/**',
        '**/.tox/**',
        '.mypy_cache/**',
        '**/.mypy_cache/**',
        '.ruff_cache/**',
        '**/.ruff_cache/**',
        '**/.dart_tool/**',
        '**/bin/**',
        '**/obj/**'
      ],
      nodir: true
    }).sort();
  }

  private buildSemanticChangeImpact(
    output: CASOutput,
    changedNodeIds: Set<string>,
    affectedEntryPointIds: Set<string>,
    affectedCallChainIds: Set<string>,
    changedEntryPoints: CASEntryPoint[],
    changedExitPoints: CASExitPoint[]
  ) {
    const affected_workflows = (output.workflows || [])
      .filter(workflow =>
        workflow.entry_points.some(id => affectedEntryPointIds.has(id)) ||
        workflow.call_chains.some(id => affectedCallChainIds.has(id)) ||
        workflow.services_used.some(id => changedNodeIds.has(id)) ||
        workflow.entities_touched.some(id => changedNodeIds.has(id))
      )
      .map(workflow => ({
        id: workflow.id,
        name: workflow.name,
        reason: 'Changed nodes or entry points participate in this workflow'
      }));

    const affected_capabilities = (output.system_capabilities || [])
      .filter(capability =>
        capability.operations.some(operation => affectedEntryPointIds.has(operation.entry_point_id)) ||
        capability.related_entities.some(entity => changedNodeIds.has(entity))
      )
      .map(capability => ({
        id: capability.id,
        name: capability.name,
        reason: 'Changed entry points or related entities participate in this capability'
      }));

    const affected_data_entities = (output.data_entities || [])
      .filter(entity => {
        const lifecycleNodes = [
          ...entity.lifecycle.created_by,
          ...entity.lifecycle.read_by,
          ...entity.lifecycle.updated_by,
          ...entity.lifecycle.deleted_by
        ];
        const transformationNodes = (entity.transformations || [])
          .flatMap(transformation => [transformation.from_node, transformation.to_node]);
        return [...lifecycleNodes, ...transformationNodes].some(nodeId => changedNodeIds.has(nodeId));
      })
      .map(entity => ({
        id: entity.id,
        name: entity.name,
        reason: 'Changed nodes participate in this entity lifecycle'
      }));

    const affected_runtime_links = (output.runtime_static_links || [])
      .filter(link =>
        link.instrumentation_points.some(nodeId => changedNodeIds.has(nodeId)) ||
        affectedEntryPointIds.has(link.static_id) ||
        affectedCallChainIds.has(link.static_id)
      )
      .map(link => ({
        id: link.id,
        runtime_signal: link.runtime_signal,
        reason: 'Changed nodes are runtime instrumentation points'
      }));

    const changed_contracts = [
      ...changedEntryPoints.map(entryPoint => ({
        id: entryPoint.id,
        type: 'entry-point' as const,
        name: entryPoint.name
      })),
      ...changedExitPoints.map(exitPoint => ({
        id: exitPoint.id,
        type: 'exit-point' as const,
        name: exitPoint.name
      }))
    ];

    const risk_reasons: string[] = [];
    if (affected_workflows.length > 0) risk_reasons.push(`${affected_workflows.length} workflow(s) affected`);
    if (affected_capabilities.length > 0) risk_reasons.push(`${affected_capabilities.length} capability/capabilities affected`);
    if (affected_data_entities.length > 0) risk_reasons.push(`${affected_data_entities.length} data entity/entities affected`);
    if (affected_runtime_links.length > 0) risk_reasons.push(`${affected_runtime_links.length} runtime signal(s) affected`);
    if (changed_contracts.length > 0) risk_reasons.push(`${changed_contracts.length} externally visible contract(s) changed`);

    return {
      affected_workflows,
      affected_capabilities,
      affected_data_entities,
      affected_runtime_links,
      changed_contracts,
      risk_reasons
    };
  }

  private buildChangeReport(
    previousOutput: CASOutput,
    currentOutput: CASOutput,
    changeSet: ChangeSet
  ): ChangeReport {
    const previousNodeIds = new Set(previousOutput.nodes.map(n => n.id));
    const currentNodeIds = new Set(currentOutput.nodes.map(n => n.id));
    const previousNodesById = new Map(previousOutput.nodes.map(node => [node.id, node]));
    const currentNodesById = new Map(currentOutput.nodes.map(node => [node.id, node]));

    const addedNodes = currentOutput.nodes.filter(n => !previousNodeIds.has(n.id));
    const deletedNodes = previousOutput.nodes.filter(n => !currentNodeIds.has(n.id));

    const modifiedNodes: Array<{ id: string; name: string; type?: string; file?: string; changes: string[] }> = [];
    for (const currentNode of currentOutput.nodes) {
      if (previousNodeIds.has(currentNode.id)) {
        const previousNode = previousNodesById.get(currentNode.id);
        if (previousNode) {
          if (previousNode === currentNode) continue;

          const changes: string[] = [];
          if (JSON.stringify(previousNode.metadata) !== JSON.stringify(currentNode.metadata)) {
            changes.push('metadata');
          }
          if (JSON.stringify(previousNode.signature) !== JSON.stringify(currentNode.signature)) {
            changes.push('signature');
          }
          if (previousNode.source?.line !== currentNode.source?.line) {
            changes.push('location');
          }
          if (changes.length > 0) {
              modifiedNodes.push({
                id: currentNode.id,
                name: currentNode.name,
                type: currentNode.type,
                file: currentNode.source?.file,
                changes
              });
          }
        }
      }
    }

    const previousEdgeIds = new Set(previousOutput.edges.map(e => e.id));
    const currentEdgeIds = new Set(currentOutput.edges.map(e => e.id));

    const addedEdges = currentOutput.edges.filter(e => !previousEdgeIds.has(e.id));
    const deletedEdges = previousOutput.edges.filter(e => !currentEdgeIds.has(e.id));

    const previousEntryPointIds = new Set((previousOutput.entry_points || []).map(ep => ep.id));
    const currentEntryPointIds = new Set((currentOutput.entry_points || []).map(ep => ep.id));
    const addedEntryPoints = (currentOutput.entry_points || []).filter(ep => !previousEntryPointIds.has(ep.id));
    const deletedEntryPoints = (previousOutput.entry_points || []).filter(ep => !currentEntryPointIds.has(ep.id));

    const previousExitPointIds = new Set((previousOutput.exit_points || []).map(ep => ep.id));
    const currentExitPointIds = new Set((currentOutput.exit_points || []).map(ep => ep.id));
    const addedExitPoints = (currentOutput.exit_points || []).filter(ep => !previousExitPointIds.has(ep.id));
    const deletedExitPoints = (previousOutput.exit_points || []).filter(ep => !currentExitPointIds.has(ep.id));

    const files = [
      ...changeSet.added.map(filePath => ({
        path: filePath,
        type: 'added' as const,
        linesAdded: 0,
        linesRemoved: 0
      })),
      ...changeSet.modified.map(filePath => ({
        path: filePath,
        type: 'modified' as const,
        linesAdded: 0,
        linesRemoved: 0
      })),
      ...changeSet.deleted.map(filePath => ({
        path: filePath,
        type: 'deleted' as const,
        linesAdded: 0,
        linesRemoved: 0
      }))
    ];

    const changedFiles = new Set([...changeSet.added, ...changeSet.modified]);
    const changedNodeIds = new Set([
      ...addedNodes.map(n => n.id),
      ...modifiedNodes.map(n => n.id),
      ...deletedNodes.map(n => n.id)
    ]);
    const affectedEntryPoints = (currentOutput.entry_points || [])
      .filter(ep => {
        const sourceNode = currentNodesById.get(ep.source_node);
        if (sourceNode?.source?.file) {
          const relativePath = path.isAbsolute(sourceNode.source.file)
            ? path.relative(currentOutput.system.root_path, sourceNode.source.file)
            : sourceNode.source.file;
          return changedFiles.has(relativePath);
        }
        return false;
      })
      .map(ep => {
        return {
          id: ep.id,
          name: ep.name,
          path: (ep.trigger as any)?.path,
          impactType: 'direct' as const,
          distance: 0
        };
      });
    const affectedEntryPointIds = new Set(affectedEntryPoints.map(ep => ep.id));
    const affectedCallChains = (currentOutput.call_chains || [])
      .filter(chain =>
        affectedEntryPointIds.has(chain.entry_point?.entry_point_id || '') ||
        chain.call_path.some(step => changedNodeIds.has(step.node_id))
      )
      .map(chain => ({
        id: chain.id,
        name: chain.business_context?.business_process || chain.business_context?.feature_area || chain.entry_point?.method_name,
        criticality: chain.criticality,
        affectedNodes: chain.call_path
          .map(step => step.node_id)
          .filter(nodeId => changedNodeIds.has(nodeId))
      }));
    const semanticImpact = this.buildSemanticChangeImpact(
      currentOutput,
      changedNodeIds,
      affectedEntryPointIds,
      new Set(affectedCallChains.map(chain => chain.id)),
      [...addedEntryPoints, ...deletedEntryPoints],
      [...addedExitPoints, ...deletedExitPoints]
    );

    const riskLevel = this.calculateChangeRiskLevel(
      addedNodes.length,
      modifiedNodes.length,
      deletedNodes.length,
      affectedEntryPoints.length + semanticImpact.affected_workflows.length
    );

    return {
      timestamp: new Date().toISOString(),
      previousAnalysis: previousOutput.analysis_timestamp,
      currentAnalysis: currentOutput.analysis_timestamp,
      summary: {
        filesAdded: changeSet.added.length,
        filesModified: changeSet.modified.length,
        filesDeleted: changeSet.deleted.length,
        nodesAdded: addedNodes.length,
        nodesModified: modifiedNodes.length,
        nodesDeleted: deletedNodes.length,
        edgesAdded: addedEdges.length,
        edgesModified: 0,
        edgesDeleted: deletedEdges.length
      },
      impact: {
        riskLevel,
        confidence: 0.8,
        affectedEntryPoints,
        affectedCallChains,
        affectedConsumers: [],
        criticalPathsAffected: affectedEntryPoints.length > 0 || affectedCallChains.some(chain => chain.criticality === 'critical' || chain.criticality === 'high'),
        securitySensitive: currentOutput.security_boundaries?.some(boundary =>
          boundary.enforcement_points.some(point => changedNodeIds.has(point.node_id))
        ) || false,
        dataFlowAffected: semanticImpact.affected_data_entities.length > 0,
        testCoverage: {
          directTests: [],
          integrationTests: [],
          uncoveredChanges: [],
          suggestedTests: []
        },
        documentation: {
          affectedDocs: [],
          outdatedComments: []
        }
      },
      semantic_impact: semanticImpact,
      details: {
        files,
        addedNodes: addedNodes.map(n => ({
          id: n.id,
          name: n.name,
          type: n.type,
          file: n.source?.file || ''
        })),
        modifiedNodes,
        deletedNodes: deletedNodes.map(n => ({
          id: n.id,
          name: n.name,
          type: n.type,
          file: n.source?.file
        })),
        addedEdges: addedEdges.map(e => ({
          id: e.id,
          source: e.source,
          target: e.target,
          type: e.type
        })),
        deletedEdges: deletedEdges.map(e => ({
          id: e.id,
          source: e.source,
          target: e.target,
          type: e.type
        })),
        addedEntryPoints: addedEntryPoints.map(ep => ({
          id: ep.id,
          name: ep.name
        })),
        modifiedEntryPoints: affectedEntryPoints.map(ep => ({
          id: ep.id,
          name: ep.name,
          details: ep.path
        })),
        deletedEntryPoints: deletedEntryPoints.map(ep => ({
          id: ep.id,
          name: ep.name
        })),
        addedExitPoints: addedExitPoints.map(ep => ({
          id: ep.id,
          name: ep.name
        })),
        deletedExitPoints: deletedExitPoints.map(ep => ({
          id: ep.id,
          name: ep.name
        }))
      }
    };
  }

  private buildIncrementalChangeReport(
    previousOutput: CASOutput,
    currentOutput: CASOutput,
    previousState: IncrementalState,
    changeSet: ChangeSet,
    fileResults: Map<string, FileAnalysisResult>
  ): ChangeReport {
    const previousNodesById = new Map(previousOutput.nodes.map(node => [node.id, node]));
    const previousEdgesById = new Map(previousOutput.edges.map(edge => [edge.id, edge]));
    const previousEntryPointsById = new Map((previousOutput.entry_points || []).map(entryPoint => [entryPoint.id, entryPoint]));
    const previousExitPointsById = new Map((previousOutput.exit_points || []).map(exitPoint => [exitPoint.id, exitPoint]));

    const addedNodes: CASNode[] = [];
    const deletedNodes: CASNode[] = [];
    const modifiedNodes: Array<{ id: string; name: string; type?: string; file?: string; changes: string[] }> = [];
    const addedEdges: CASEdge[] = [];
    const deletedEdges: CASEdge[] = [];
    const addedEntryPoints: CASEntryPoint[] = [];
    const deletedEntryPoints: CASEntryPoint[] = [];
    const addedExitPoints: CASExitPoint[] = [];
    const deletedExitPoints: CASExitPoint[] = [];

    for (const filePath of changeSet.added) {
      const result = fileResults.get(filePath);
      if (!result) continue;
      addedNodes.push(...result.nodes);
      addedEdges.push(...result.edges);
      addedEntryPoints.push(...result.entryPoints);
      addedExitPoints.push(...result.exitPoints);
    }

    for (const filePath of changeSet.deleted) {
      const record = previousState.files[filePath];
      if (!record) continue;
      deletedNodes.push(...record.nodeIds.map(id => previousNodesById.get(id)).filter((node): node is CASNode => Boolean(node)));
      deletedEdges.push(...record.edgeIds.map(id => previousEdgesById.get(id)).filter((edge): edge is CASEdge => Boolean(edge)));
      deletedEntryPoints.push(...record.entryPointIds.map(id => previousEntryPointsById.get(id)).filter((entryPoint): entryPoint is CASEntryPoint => Boolean(entryPoint)));
      deletedExitPoints.push(...record.exitPointIds.map(id => previousExitPointsById.get(id)).filter((exitPoint): exitPoint is CASExitPoint => Boolean(exitPoint)));
    }

    for (const filePath of changeSet.modified) {
      const record = previousState.files[filePath];
      const result = fileResults.get(filePath);
      if (!record || !result) continue;

      const previousNodeIds = new Set(record.nodeIds);
      const currentNodeIds = new Set(result.nodes.map(node => node.id));
      for (const node of result.nodes) {
        if (!previousNodeIds.has(node.id)) {
          addedNodes.push(node);
          continue;
        }
        const previousNode = previousNodesById.get(node.id);
        if (!previousNode || previousNode === node) continue;
        const changes = this.nodeChangeFields(previousNode, node);
        if (changes.length > 0) {
          modifiedNodes.push({
            id: node.id,
            name: node.name,
            type: node.type,
            file: node.source?.file,
            changes,
          });
        }
      }
      for (const nodeId of record.nodeIds) {
        if (!currentNodeIds.has(nodeId)) {
          const node = previousNodesById.get(nodeId);
          if (node) deletedNodes.push(node);
        }
      }

      const previousEdgeIds = new Set(record.edgeIds);
      const currentEdgeIds = new Set(result.edges.map(edge => edge.id));
      addedEdges.push(...result.edges.filter(edge => !previousEdgeIds.has(edge.id)));
      deletedEdges.push(...record.edgeIds
        .map(id => previousEdgesById.get(id))
        .filter((edge): edge is CASEdge => Boolean(edge))
        .filter(edge => !currentEdgeIds.has(edge.id)));

      const previousEntryPointIds = new Set(record.entryPointIds);
      const currentEntryPointIds = new Set(result.entryPoints.map(entryPoint => entryPoint.id));
      addedEntryPoints.push(...result.entryPoints.filter(entryPoint => !previousEntryPointIds.has(entryPoint.id)));
      deletedEntryPoints.push(...record.entryPointIds
        .map(id => previousEntryPointsById.get(id))
        .filter((entryPoint): entryPoint is CASEntryPoint => Boolean(entryPoint))
        .filter(entryPoint => !currentEntryPointIds.has(entryPoint.id)));

      const previousExitPointIds = new Set(record.exitPointIds);
      const currentExitPointIds = new Set(result.exitPoints.map(exitPoint => exitPoint.id));
      addedExitPoints.push(...result.exitPoints.filter(exitPoint => !previousExitPointIds.has(exitPoint.id)));
      deletedExitPoints.push(...record.exitPointIds
        .map(id => previousExitPointsById.get(id))
        .filter((exitPoint): exitPoint is CASExitPoint => Boolean(exitPoint))
        .filter(exitPoint => !currentExitPointIds.has(exitPoint.id)));
    }

    const files = [
      ...changeSet.added.map(filePath => ({
        path: filePath,
        type: 'added' as const,
        linesAdded: 0,
        linesRemoved: 0
      })),
      ...changeSet.modified.map(filePath => ({
        path: filePath,
        type: 'modified' as const,
        linesAdded: 0,
        linesRemoved: 0
      })),
      ...changeSet.deleted.map(filePath => ({
        path: filePath,
        type: 'deleted' as const,
        linesAdded: 0,
        linesRemoved: 0
      }))
    ];

    const changedNodeIds = new Set([
      ...addedNodes.map(node => node.id),
      ...modifiedNodes.map(node => node.id),
      ...deletedNodes.map(node => node.id),
    ]);
    const affectedEntryPoints = this.scopedAffectedEntryPoints(currentOutput, changeSet, changedNodeIds);
    const affectedEntryPointIds = new Set(affectedEntryPoints.map(entryPoint => entryPoint.id));
    const affectedCallChains = (currentOutput.call_chains || [])
      .filter(chain =>
        affectedEntryPointIds.has(chain.entry_point?.entry_point_id || '') ||
        chain.call_path.some(step => changedNodeIds.has(step.node_id))
      )
      .slice(0, 20)
      .map(chain => ({
        id: chain.id,
        name: chain.business_context?.business_process || chain.business_context?.feature_area || chain.entry_point?.method_name,
        criticality: chain.criticality,
        affectedNodes: chain.call_path
          .map(step => step.node_id)
          .filter(nodeId => changedNodeIds.has(nodeId))
      }));
    const semanticImpact = this.buildScopedSemanticChangeImpact(
      currentOutput,
      changedNodeIds,
      affectedEntryPointIds,
      new Set(affectedCallChains.map(chain => chain.id)),
      [...addedEntryPoints, ...deletedEntryPoints],
      [...addedExitPoints, ...deletedExitPoints]
    );
    const riskLevel = this.calculateChangeRiskLevel(
      addedNodes.length,
      modifiedNodes.length,
      deletedNodes.length,
      affectedEntryPoints.length + semanticImpact.affected_workflows.length
    );

    return {
      timestamp: new Date().toISOString(),
      previousAnalysis: previousOutput.analysis_timestamp,
      currentAnalysis: currentOutput.analysis_timestamp,
      summary: {
        filesAdded: changeSet.added.length,
        filesModified: changeSet.modified.length,
        filesDeleted: changeSet.deleted.length,
        nodesAdded: addedNodes.length,
        nodesModified: modifiedNodes.length,
        nodesDeleted: deletedNodes.length,
        edgesAdded: addedEdges.length,
        edgesModified: 0,
        edgesDeleted: deletedEdges.length
      },
      impact: {
        riskLevel,
        confidence: 0.82,
        affectedEntryPoints,
        affectedCallChains,
        affectedConsumers: [],
        criticalPathsAffected: affectedEntryPoints.length > 0 || affectedCallChains.some(chain => chain.criticality === 'critical' || chain.criticality === 'high'),
        securitySensitive: currentOutput.security_boundaries?.some(boundary =>
          boundary.enforcement_points.some(point => changedNodeIds.has(point.node_id))
        ) || false,
        dataFlowAffected: semanticImpact.affected_data_entities.length > 0,
        testCoverage: {
          directTests: [],
          integrationTests: [],
          uncoveredChanges: [],
          suggestedTests: []
        },
        documentation: {
          affectedDocs: [],
          outdatedComments: []
        }
      },
      semantic_impact: semanticImpact,
      details: {
        files,
        addedNodes: addedNodes.map(node => ({
          id: node.id,
          name: node.name,
          type: node.type,
          file: node.source?.file || ''
        })),
        modifiedNodes,
        deletedNodes: deletedNodes.map(node => ({
          id: node.id,
          name: node.name,
          type: node.type,
          file: node.source?.file
        })),
        addedEdges: addedEdges.map(edge => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: edge.type
        })),
        deletedEdges: deletedEdges.map(edge => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: edge.type
        })),
        addedEntryPoints: addedEntryPoints.map(entryPoint => ({
          id: entryPoint.id,
          name: entryPoint.name
        })),
        modifiedEntryPoints: affectedEntryPoints.map(entryPoint => ({
          id: entryPoint.id,
          name: entryPoint.name,
          details: entryPoint.path
        })),
        deletedEntryPoints: deletedEntryPoints.map(entryPoint => ({
          id: entryPoint.id,
          name: entryPoint.name
        })),
        addedExitPoints: addedExitPoints.map(exitPoint => ({
          id: exitPoint.id,
          name: exitPoint.name
        })),
        deletedExitPoints: deletedExitPoints.map(exitPoint => ({
          id: exitPoint.id,
          name: exitPoint.name
        }))
      }
    };
  }

  private nodeChangeFields(previousNode: CASNode, currentNode: CASNode): string[] {
    const changes: string[] = [];
    if (JSON.stringify(previousNode.metadata) !== JSON.stringify(currentNode.metadata)) {
      changes.push('metadata');
    }
    if (JSON.stringify(previousNode.signature) !== JSON.stringify(currentNode.signature)) {
      changes.push('signature');
    }
    if (previousNode.source?.line !== currentNode.source?.line) {
      changes.push('location');
    }
    return changes;
  }

  private scopedAffectedEntryPoints(
    currentOutput: CASOutput,
    changeSet: ChangeSet,
    changedNodeIds: Set<string>
  ): Array<{ id: string; name: string; path?: string; impactType: 'direct'; distance: number }> {
    const changedFiles = new Set([...changeSet.added, ...changeSet.modified]);
    const nodesById = new Map(currentOutput.nodes.map(node => [node.id, node]));
    return (currentOutput.entry_points || [])
      .filter(entryPoint => {
        if (changedNodeIds.has(entryPoint.source_node) || Boolean(entryPoint.handler?.node_id && changedNodeIds.has(entryPoint.handler.node_id))) {
          return true;
        }
        const sourceNode = nodesById.get(entryPoint.source_node);
        if (!sourceNode?.source?.file) return false;
        const relativePath = path.isAbsolute(sourceNode.source.file)
          ? path.relative(currentOutput.system.root_path, sourceNode.source.file)
          : sourceNode.source.file;
        return changedFiles.has(relativePath);
      })
      .slice(0, 50)
      .map(entryPoint => ({
        id: entryPoint.id,
        name: entryPoint.name,
        path: (entryPoint.trigger as any)?.path,
        impactType: 'direct' as const,
        distance: 0
      }));
  }

  private buildScopedSemanticChangeImpact(
    currentOutput: CASOutput,
    changedNodeIds: Set<string>,
    affectedEntryPointIds: Set<string>,
    affectedCallChainIds: Set<string>,
    changedEntryPoints: CASEntryPoint[],
    changedExitPoints: CASExitPoint[]
  ): ChangeSemanticImpact {
    const affected_workflows = (currentOutput.workflows || [])
      .filter(workflow =>
        affectedCallChainIds.has(workflow.id) ||
        workflow.entry_points.some(entryPointId => affectedEntryPointIds.has(entryPointId))
      )
      .slice(0, 20)
      .map(workflow => ({
        id: workflow.id,
        name: workflow.name,
        reason: 'Workflow is connected to a changed file or entry point'
      }));
    const affected_capabilities = (currentOutput.system_capabilities || [])
      .filter(capability =>
        capability.operations.some(operation => changedNodeIds.has(operation.entry_point_id.replace(/^node:/, ''))) ||
        capability.related_entities.some(entityId => changedNodeIds.has(entityId))
      )
      .slice(0, 20)
      .map(capability => ({
        id: capability.id,
        name: capability.name,
        reason: 'Capability references changed graph facts'
      }));
    const affected_data_entities = (currentOutput.data_entities || [])
      .filter(entity => [
        ...entity.lifecycle.created_by,
        ...entity.lifecycle.read_by,
        ...entity.lifecycle.updated_by,
        ...entity.lifecycle.deleted_by,
      ].some(nodeId => changedNodeIds.has(nodeId)))
      .slice(0, 20)
      .map(entity => ({
        id: entity.id,
        name: entity.name,
        reason: 'Entity lifecycle references changed node'
      }));
    const affected_runtime_links = (currentOutput.runtime_static_links || [])
      .filter(link => changedNodeIds.has(link.static_id))
      .slice(0, 20)
      .map(link => ({
        id: link.id,
        runtime_signal: link.runtime_signal,
        reason: 'Runtime link is attached to changed node'
      }));
    const changed_contracts = [
      ...changedEntryPoints.map(entryPoint => ({
        id: entryPoint.id,
        type: 'entry-point' as const,
        name: entryPoint.name
      })),
      ...changedExitPoints.map(exitPoint => ({
        id: exitPoint.id,
        type: 'exit-point' as const,
        name: exitPoint.name
      })),
    ];
    const risk_reasons: string[] = [];
    if (affected_workflows.length > 0) risk_reasons.push('Changed nodes are connected to workflow paths');
    if (affected_data_entities.length > 0) risk_reasons.push('Changed nodes participate in data entity lifecycle');
    if (changed_contracts.length > 0) risk_reasons.push('Entry or exit contracts changed');
    return {
      affected_workflows,
      affected_capabilities,
      affected_data_entities,
      affected_runtime_links,
      changed_contracts,
      risk_reasons
    };
  }

  private calculateChangeRiskLevel(
    nodesAdded: number,
    nodesModified: number,
    nodesDeleted: number,
    affectedEntryPoints: number
  ): 'low' | 'medium' | 'high' | 'critical' {
    const totalNodeChanges = nodesAdded + nodesModified + nodesDeleted;

    if (affectedEntryPoints > 5 || totalNodeChanges > 50) {
      return 'critical';
    }
    if (affectedEntryPoints > 2 || totalNodeChanges > 20) {
      return 'high';
    }
    if (affectedEntryPoints > 0 || totalNodeChanges > 5) {
      return 'medium';
    }
    return 'low';
  }

  private extractImportedFiles(nodes: CASNode[]): string[] {
    const imports = new Set<string>();
    for (const node of nodes) {
      const attributes = node.metadata?.attributes as Record<string, any> | undefined;
      if (Array.isArray(attributes?.imports)) {
        for (const imported of attributes.imports) {
          if (typeof imported === 'string' && imported) imports.add(imported);
        }
      }

      if (node.type === 'import' && node.metadata) {
        const metadata = node.metadata as Record<string, any>;
        const moduleName = metadata.module;
        if (typeof moduleName === 'string' && moduleName) {
          imports.add(moduleName);
          continue;
        }

        const source = metadata.source;
        if (typeof source === 'string' && source) {
          imports.add(source);
        }
      }
    }
    return [...imports];
  }

  private extractExportedSymbols(nodes: CASNode[]): string[] {
    const exports: string[] = [];
    for (const node of nodes) {
      if (node.metadata?.is_exported) {
        exports.push(node.name);
      }
    }
    return exports;
  }

  private computeContentHash(content: string): string {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
  }

  queryAnalysis(casOutput: CASOutput, options: {
    level?: number;
    type?: string;
    nameFilter?: string;
    includeEdges?: boolean;
  } = {}): { nodes: CASNode[]; edges?: CASEdge[] } {
    let filteredNodes = casOutput.nodes;

    if (options.level !== undefined) {
      filteredNodes = filteredNodes.filter(node =>
        node.level === undefined || node.level <= options.level!
      );
    }

    if (options.type) {
      filteredNodes = filteredNodes.filter(node => node.type === options.type);
    }

    if (options.nameFilter) {
      const regex = new RegExp(options.nameFilter, 'i');
      filteredNodes = filteredNodes.filter(node => regex.test(node.name));
    }

    const result: { nodes: CASNode[]; edges?: CASEdge[] } = { nodes: filteredNodes };

    if (options.includeEdges !== false) {
      const nodeIds = new Set(filteredNodes.map(node => node.id));
      result.edges = casOutput.edges.filter(edge =>
        nodeIds.has(edge.source) && nodeIds.has(edge.target)
      );
    }

    return result;
  }

  private async shouldUseAnalyzer(
    projectPath: string,
    registration: AnalyzerRegistration
  ): Promise<boolean> {
    try {
      if (registration.type === 'language') {
        if (await this.hasLanguageSignal(projectPath, registration.id)) {
          this.analyzerRootMap.set(registration.id, projectPath);
          return true;
        }
        return false;
      }

      if ((registration.type === 'framework' || registration.type === 'library') && !registration.analyzer.discoversNestedRoots) {
        const nestedRoots = this.projectRoots
          .filter(root => root !== projectPath)
          .sort((a, b) => b.length - a.length);

        for (const root of nestedRoots) {
          try {
            if (await this.hasAnalyzerSignal(root, registration) && await registration.analyzer.canAnalyze(root)) {
              this.analyzerRootMap.set(registration.id, root);
              return true;
            }
          } catch {
          }
        }
      }

      if (
        await this.hasAnalyzerSignal(projectPath, registration) &&
        await registration.analyzer.canAnalyze(projectPath)
      ) {
        this.analyzerRootMap.set(registration.id, projectPath);
        return true;
      }

      for (const root of this.projectRoots) {
        if (root === projectPath) continue;
        try {
          if (await this.hasAnalyzerSignal(root, registration) && await registration.analyzer.canAnalyze(root)) {
            this.analyzerRootMap.set(registration.id, root);
            return true;
          }
        } catch {
        }
      }

      return false;
    } catch (error) {
      return false;
    }
  }

  private async hasLanguageSignal(projectPath: string, analyzerId: string): Promise<boolean> {
    const inventory = await this.getSourceFileInventory(projectPath);
    const hasExtension = (...extensions: string[]) => extensions.some(extension =>
      (inventory.extensions.get(extension.toLowerCase()) || []).length > 0
    );
    const hasBasename = (...basenames: string[]) => basenames.some(basename =>
      (inventory.basenames.get(basename.toLowerCase()) || []).length > 0
    );

    switch (analyzerId) {
      case 'typescript-javascript':
        return hasExtension('.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs');
      case 'python':
        return hasExtension('.py') || hasBasename('requirements.txt', 'setup.py', 'pyproject.toml', 'pipfile');
      case 'java':
        return hasExtension('.java') || hasBasename('pom.xml', 'build.gradle', 'build.gradle.kts');
      case 'csharp':
        return hasExtension('.cs', '.csproj', '.fsproj', '.vbproj', '.sln');
      case 'go':
        return hasExtension('.go') || hasBasename('go.mod', 'go.sum', 'gopkg.toml');
      case 'rust':
        return hasExtension('.rs') || hasBasename('cargo.toml', 'cargo.lock');
      case 'php':
        return hasExtension('.php') || hasBasename('composer.json', 'composer.lock');
      case 'ruby':
        return hasExtension('.rb', '.rake') || hasBasename('gemfile', 'gemfile.lock', 'rakefile');
      case 'dart':
        return hasExtension('.dart') || hasBasename('pubspec.yaml');
      case 'terraform':
        return hasExtension('.tf', '.tfvars');
      default: {
        const registration = this.analyzers.get(analyzerId);
        return registration ? registration.analyzer.canAnalyze(projectPath) : false;
      }
    }
  }

  private async hasAnalyzerSignal(projectPath: string, registration: AnalyzerRegistration): Promise<boolean> {
    if (registration.type === 'language') {
      return true;
    }

    const patterns = registration.detectPatterns || {};
    if (patterns.dependencies?.length && await this.manifestContainsAny(projectPath, patterns.dependencies)) {
      return true;
    }

    if (patterns.files?.length) {
      const fileSignal = await this.hasFileSignal(projectPath, patterns.files, patterns.content || [], Boolean(patterns.dependencies?.length));
      if (fileSignal) return true;
    }

    if (patterns.content?.length) {
      return this.hasContentPathSignal(projectPath, patterns.content);
    }

    return false;
  }

  private async manifestContainsAny(projectPath: string, needles: string[]): Promise<boolean> {
    const loweredNeedles = needles.map(needle => needle.toLowerCase());
    const matches = await this.getManifestFiles(projectPath);

    for (const match of matches.slice(0, 160)) {
        const fullPath = path.join(projectPath, match);
        try {
          if (path.basename(match) === 'package.json') {
            const packageJson = await fs.readJson(fullPath);
            const deps = {
              ...packageJson.dependencies,
              ...packageJson.devDependencies,
              ...packageJson.peerDependencies,
              ...packageJson.optionalDependencies
            };
            const dependencyNames = Object.keys(deps).map(dep => dep.toLowerCase());
            if (loweredNeedles.some(needle => dependencyNames.some(dep => dep.includes(needle) || needle.includes(dep)))) {
              return true;
            }
          }

          const content = await fs.readFile(fullPath, 'utf8');
          const lowerContent = content.toLowerCase();
          if (loweredNeedles.some(needle => lowerContent.includes(needle))) {
            return true;
          }
        } catch {
        }
    }

    return false;
  }

  private async hasFileSignal(
    projectPath: string,
    files: string[],
    contentPatterns: RegExp[],
    hasDependencyPatterns: boolean
  ): Promise<boolean> {
    const genericManifests = new Set([
      'package.json',
      'requirements.txt',
      'composer.json',
      'pom.xml',
      'build.gradle',
      'build.gradle.kts'
    ]);

    for (const filePattern of files) {
      const isGenericManifest = genericManifests.has(filePattern) || /\*\.(?:csproj|sln|vbproj|fsproj)$/.test(filePattern);
      if (isGenericManifest && hasDependencyPatterns && contentPatterns.length === 0) {
        continue;
      }

      const matches = await this.findInventoryMatches(projectPath, filePattern);

      if (matches.length === 0) continue;
      if (contentPatterns.length === 0) {
        return true;
      }

      for (const match of matches.slice(0, 80)) {
        if (contentPatterns.some(pattern => pattern.test(match))) {
          return true;
        }

        try {
          const content = await fs.readFile(path.join(projectPath, match), 'utf8');
          if (contentPatterns.some(pattern => pattern.test(content))) {
            return true;
          }
        } catch {
        }
      }
    }

    return false;
  }

  private async hasContentPathSignal(projectPath: string, patterns: RegExp[]): Promise<boolean> {
    const candidatePatterns = Array.from(new Set(patterns.flatMap(pattern => this.contentPatternToGlob(pattern)).filter(Boolean)));
    if (candidatePatterns.length === 0) {
      return false;
    }

    for (const candidatePattern of candidatePatterns) {
      const matches = await this.findInventoryMatches(projectPath, candidatePattern);
      if (matches.length > 0) return true;
    }

    return false;
  }

  private async findInventoryMatches(projectPath: string, pattern: string): Promise<string[]> {
    const normalizedPattern = pattern.replace(/\\/g, '/');
    const inventory = await this.getSourceFileInventory(projectPath);

    if (!/[{[*?]/.test(normalizedPattern)) {
      const exact = normalizedPattern.toLowerCase();
      return inventory.files.filter(file =>
        file.toLowerCase() === exact || file.toLowerCase().endsWith(`/${exact}`)
      );
    }

    const basenameOnly = normalizedPattern.match(/^(?:\*\*\/)?([^/*?{}]+)$/);
    if (basenameOnly) {
      return inventory.basenames.get(basenameOnly[1].toLowerCase()) || [];
    }

    const extensionOnly = normalizedPattern.match(/^\*\*\/\*\.([a-z0-9]+)$/i);
    if (extensionOnly) {
      return inventory.extensions.get(`.${extensionOnly[1].toLowerCase()}`) || [];
    }

    const braceExtensions = normalizedPattern.match(/^\*\*\/\*\.{([^}]+)}$/);
    if (braceExtensions) {
      return braceExtensions[1]
        .split(',')
        .flatMap(extension => inventory.extensions.get(`.${extension.trim().toLowerCase()}`) || []);
    }

    const basenameBrace = normalizedPattern.match(/^(?:\*\*\/)?([^/{}]+)\.{([^}]+)}$/);
    if (basenameBrace) {
      const [_, prefix, extensions] = basenameBrace;
      return extensions
        .split(',')
        .flatMap(extension => inventory.basenames.get(`${prefix}.${extension.trim()}`.toLowerCase()) || []);
    }

    const suffix = normalizedPattern.replace(/^\*\*\//, '').toLowerCase();
    if (!suffix.includes('*') && !suffix.includes('?') && !suffix.includes('{')) {
      return inventory.files.filter(file => file.toLowerCase().endsWith(suffix));
    }

    return glob(pattern, {
      cwd: projectPath,
      ignore: this.getProjectDiscoveryIgnorePatterns(),
      nodir: true
    });
  }

  private contentPatternToGlob(pattern: RegExp): string[] {
    const source = pattern.source;
    const globs: string[] = [];
    if (source.includes('\\.tsx') || source.includes('tsx')) globs.push('**/*.tsx');
    if (source.includes('\\.jsx') || source.includes('jsx')) globs.push('**/*.jsx');
    if (source.includes('\\.vue') || source.includes('vue')) globs.push('**/*.vue');
    if (source.includes('\\.component\\.ts') || source.includes('component')) globs.push('**/*.component.ts');
    if (source.includes('\\.test') || source.includes('\\.spec') || source.includes('test') || source.includes('spec')) {
      globs.push('**/*.test.{js,ts,jsx,tsx}', '**/*.spec.{js,ts,jsx,tsx}');
    }
    return globs;
  }

  private getAnalyzerScopeFilters(
    projectPath: string,
    matchedRoot: string,
    registration: AnalyzerRegistration
  ): string[] {
    if (registration.type !== 'framework' && registration.type !== 'library') {
      return [];
    }

    return this.projectRoots
      .filter(root => root !== matchedRoot)
      .map(root => path.relative(matchedRoot, root).replace(/\\/g, '/'))
      .filter(relativeRoot =>
        relativeRoot &&
        relativeRoot !== '.' &&
        !relativeRoot.startsWith('..') &&
        !path.isAbsolute(relativeRoot)
      )
      .map(relativeRoot => `${relativeRoot}/**`);
  }

  private async detectPrimaryProjectType(projectPath: string): Promise<string> {
    try {
      const indicators = [
        { type: 'typescript', files: ['**/package.json'], content: ['"typescript"', '"@types/', '"next"', '"ts-node"'] },
        { type: 'javascript', files: ['**/package.json'], content: ['"react"', '"express"', '"vue"', '"next"', '"socket.io"'] },
        { type: 'python', files: ['**/requirements.txt', '**/setup.py', '**/pyproject.toml', '**/Pipfile'] },
        { type: 'java', files: ['**/pom.xml', '**/build.gradle', '**/build.gradle.kts'] },
        { type: 'csharp', files: ['**/*.csproj', '**/*.sln'] },
        { type: 'go', files: ['**/go.mod'] },
        { type: 'rust', files: ['**/Cargo.toml'] },
        { type: 'php', files: ['**/composer.json'] },
        { type: 'dart', files: ['**/pubspec.yaml'], content: ['flutter:', 'sdk: flutter'] }
      ];

      const ignorePatterns = this.getProjectDiscoveryIgnorePatterns();

      for (const indicator of indicators) {
        for (const filePattern of indicator.files) {
          try {
            const files = await glob(filePattern, { cwd: projectPath, ignore: ignorePatterns, nodir: true });
            if (files.length > 0) {
              if (indicator.content && indicator.content.length > 0) {
                for (const f of files) {
                  try {
                    const content = await fs.readFile(path.join(projectPath, f), 'utf-8');
                    if (indicator.content.some(c => content.includes(c))) {
                      return indicator.type;
                    }
                  } catch {
                  }
                }
              } else {
                return indicator.type;
              }
            }
          } catch {
          }
        }
      }

      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private isAnalyzerRelevantForProject(registration: AnalyzerRegistration, projectType: string): boolean {
    if (projectType === 'unknown') {
      return true;
    }

    if (registration.type === 'language') {
      const languageMap: { [key: string]: string[] } = {
        'typescript-javascript': ['typescript', 'javascript'],
        'python': ['python'],
        'java': ['java', 'kotlin', 'scala'],
        'csharp': ['csharp', 'fsharp', 'vb'],
        'go': ['go'],
        'rust': ['rust'],
        'php': ['php'],
        'dart': ['dart']
      };

      return languageMap[registration.id]?.includes(projectType) || false;
    }

    return true;
  }

  private orderAnalyzers(analyzers: AnalyzerRegistration[]): AnalyzerRegistration[] {
    const typeOrder = { language: 0, framework: 1, library: 2, pattern: 3 };

    return analyzers.sort((a, b) => {
      const aOrder = typeOrder[a.type] ?? 999;
      const bOrder = typeOrder[b.type] ?? 999;
      return aOrder - bOrder;
    });
  }

  private async runAnalyzer(
    registration: AnalyzerRegistration,
    context: AnalysisContext,
    projectPath: string,
    accumulators: {
      allNodes: CASNode[];
      allEdges: CASEdge[];
      allEntryPoints: any[];
      allExitPoints: any[];
      allBehaviors: CASBehavior[];
      allPatterns: CASPattern[];
      allTags: CASTag[];
      allPerspectives: CASPerspective[];
      allLibraries: any[];
      categories: CASCategories;
      contributions: any[];
      analysisErrors: CASAnalysisError[];
    }
  ): Promise<void> {
    const analyzerStartTime = Date.now();

    const matchedRoot = this.analyzerRootMap.get(registration.id) || projectPath;
    context.projectPath = matchedRoot;

    context.existingAnalysis = [{
      nodes: accumulators.allNodes,
      edges: accumulators.allEdges,
      entry_points: accumulators.allEntryPoints,
      exit_points: accumulators.allExitPoints,
      analyzer_metadata: {
        analyzer_id: 'merged',
        analyzer_name: 'Merged Analysis',
        version: '1.0.0',
        contribution_type: 'pattern' as const,
        nodes_contributed: accumulators.allNodes.length,
        edges_contributed: accumulators.allEdges.length,
        contributed_entry_points: accumulators.allEntryPoints.length,
        contributed_exit_points: accumulators.allExitPoints.length
      }
    }];

    const result = await registration.analyzer.analyze(context);
    const executionTime = Date.now() - analyzerStartTime;

    if (matchedRoot !== projectPath) {
      const relPrefix = path.relative(projectPath, matchedRoot);
      this.normalizeFilePaths(result, relPrefix);
    }

    this.mergeAnalysisResult(
      { allNodes: accumulators.allNodes, allEdges: accumulators.allEdges, allEntryPoints: accumulators.allEntryPoints, allExitPoints: accumulators.allExitPoints },
      result
    );

    if (result.behaviors) accumulators.allBehaviors.push(...result.behaviors);
    if (result.patterns) accumulators.allPatterns.push(...result.patterns);
    if (result.categories) this.mergeCategories(accumulators.categories, result.categories);
    if (result.tags) accumulators.allTags.push(...result.tags);
    if (result.perspectives) accumulators.allPerspectives.push(...result.perspectives);

    const analyzerMeta = result.analyzer_metadata || {};
    if (Array.isArray(analyzerMeta.warnings)) {
      for (const warning of analyzerMeta.warnings) {
        accumulators.analysisErrors.push({
          severity: 'warning',
          code: 'PARTIAL_ANALYSIS',
          message: String(warning),
          analyzer: registration.id,
          recoverable: true
        });
      }
    }
    accumulators.contributions.push({
      analyzer_id: registration.id,
      analyzer_name: registration.name,
      analyzer_version: registration.version,
      analyzer_type: registration.type,
      contribution_type: registration.type,
      execution_time_ms: executionTime,
      nodes_created: result.nodes?.length || 0,
      edges_created: result.edges?.length || 0,
      confidence: 1.0,
      contributed_categories: result.categories ? Object.keys(result.categories).length : 0,
      provided_perspectives: result.provided_perspectives || [],
      framework_specific: analyzerMeta.frameworks_detected || analyzerMeta.crates || undefined,
      application_type: analyzerMeta.application_type,
      project_name: analyzerMeta.project_name,
      project_version: analyzerMeta.project_version,
      warnings: Array.isArray(analyzerMeta.warnings) && analyzerMeta.warnings.length > 0 ? analyzerMeta.warnings : undefined
    });

    if (result.libraries) {
      accumulators.allLibraries.push(...result.libraries);
    }
  }

  private normalizeFilePaths(result: any, relPrefix: string): void {
    const normalizePath = (filePath: string): string => {
      if (path.isAbsolute(filePath)) return filePath;
      if (filePath === relPrefix || filePath.startsWith(`${relPrefix}${path.sep}`)) return filePath;
      return path.join(relPrefix, filePath);
    };

    for (const node of result.nodes || []) {
      if (node.source?.file && !path.isAbsolute(node.source.file)) {
        node.source.file = normalizePath(node.source.file);
      }
    }
    for (const edge of result.edges || []) {
      if (edge.source_location?.file && !path.isAbsolute(edge.source_location.file)) {
        edge.source_location.file = normalizePath(edge.source_location.file);
      }
    }
    for (const ep of result.entry_points || []) {
      if (ep.source?.file && !path.isAbsolute(ep.source.file)) {
        ep.source.file = normalizePath(ep.source.file);
      }
    }
    for (const ep of result.exit_points || []) {
      if (ep.source?.file && !path.isAbsolute(ep.source.file)) {
        ep.source.file = normalizePath(ep.source.file);
      }
    }
  }

  private applyCanonicalOrdering(
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[],
    exitPoints: any[],
    libraries: any[]
  ): void {
    const compareStrings = (a: string | undefined, b: string | undefined): number => {
      if (a === b) return 0;
      if (a === undefined) return 1;
      if (b === undefined) return -1;
      return a < b ? -1 : a > b ? 1 : 0;
    };

    nodes.sort((a, b) =>
      compareStrings(a.source?.file, b.source?.file) ||
      ((a.source?.line ?? 0) - (b.source?.line ?? 0)) ||
      compareStrings(a.id, b.id)
    );
    edges.sort((a, b) =>
      compareStrings(a.source, b.source) ||
      compareStrings(a.target, b.target) ||
      compareStrings(a.type, b.type) ||
      compareStrings(a.id, b.id)
    );
    entryPoints.sort((a, b) => compareStrings(a.id, b.id));
    exitPoints.sort((a, b) => compareStrings(a.id, b.id));
    libraries.sort((a, b) =>
      compareStrings(a.name, b.name) ||
      compareStrings(a.version, b.version)
    );
  }

  private mergeAnalysisResult(
    target: {
      allNodes: CASNode[];
      allEdges: CASEdge[];
      allEntryPoints: any[];
      allExitPoints: any[];
    },
    source: CASContribution
  ): void {
    const existingNodeIds = new Set(target.allNodes.map(n => n.id));
    const existingEdgeIds = new Set(target.allEdges.map(e => e.id));
    const validEntryPoints = (source.entry_points || []).filter(ep => this.isValidEntryPoint(ep));
    const validExitPoints = (source.exit_points || []).filter(ep => this.isValidExitPoint(ep));
    const invalidEntryPointIds = new Set((source.entry_points || [])
      .filter(ep => !validEntryPoints.some(valid => valid.id === ep.id))
      .map(ep => ep.id));
    const invalidExitPointIds = new Set((source.exit_points || [])
      .filter(ep => !validExitPoints.some(valid => valid.id === ep.id))
      .map(ep => ep.id));

    for (const node of source.nodes || []) {
      if (existingNodeIds.has(node.id)) {
        const existingNode = target.allNodes.find(n => n.id === node.id);
        if (existingNode) {
          // Enhanced merge logic for node collaboration
          if (node.metadata) {
            existingNode.metadata = { ...existingNode.metadata, ...node.metadata };
          }
          if (node.subcategories && node.subcategories.length > 0) {
            // Use the enhanced subcategories from the framework analyzer
            existingNode.subcategories = [...new Set([...(existingNode.subcategories || []), ...node.subcategories])];
          }
          if (node.level !== undefined && node.level !== existingNode.level) {
            existingNode.level = node.level; // Framework analyzers can promote level
          }
          if (node.level_name && node.level_name !== existingNode.level_name) {
            existingNode.level_name = node.level_name;
          }
          if (node.description && node.description !== existingNode.description) {
            existingNode.description = node.description; // Framework-specific descriptions take precedence
          }
          if (node.tags && node.tags.length > 0) {
            existingNode.tags = [...new Set([...(existingNode.tags || []), ...node.tags])];
          }
          if (node.type && node.type !== existingNode.type) {
            existingNode.type = node.type;
          }
          if (node.analyzers && node.analyzers.length > 0) {
            existingNode.analyzers = [...new Set([...(existingNode.analyzers || []), ...node.analyzers])];
          }
        }
      } else {
        target.allNodes.push(node);
        existingNodeIds.add(node.id);
      }
    }

    for (const edge of source.edges || []) {
      if (invalidEntryPointIds.has(edge.source) || invalidEntryPointIds.has(edge.target)) continue;
      if (invalidExitPointIds.has(edge.source) || invalidExitPointIds.has(edge.target)) continue;
      if (!existingEdgeIds.has(edge.id)) {
        target.allEdges.push(edge);
        existingEdgeIds.add(edge.id);
      }
    }

    target.allEntryPoints.push(...validEntryPoints);
    target.allExitPoints.push(...validExitPoints);
  }

  private isValidEntryPoint(ep: CASEntryPoint): boolean {
    const validTypes = new Set([
      'http', 'cli', 'websocket', 'ws_handler', 'message',
      'event', 'scheduled', 'schedule', 'cron', 'queue', 'grpc', 'graphql',
      'page', 'route', 'lifecycle', 'test'
    ]);
    return validTypes.has(ep.type);
  }

  private isValidExitPoint(ep: CASExitPoint): boolean {
    const validTypes = new Set([
      'database', 'http', 'grpc', 'graphql', 'queue', 'cache',
      'file', 'email', 'sms', 'external_api', 'sdk',
      'api', 'navigation', 'client_storage', 'analytics', 'message', 'webhook'
    ]);
    if (!validTypes.has(ep.type)) return false;
    if (this.isNoiseExitPoint(ep)) return false;
    return true;
  }

  /**
   * Exit points are meant to capture genuine external boundaries (real
   * databases, third-party APIs, queues, SDKs). Two sources inflate them:
   *
   *  1. Standard-library calls (Node `path`/`fs`/`os`, Python `os`/`pathlib`/
   *     `sys`) tagged as "file" exit points — path manipulation performs no
   *     I/O at all.
   *  2. Calls into the project's own modules (relative or absolute local
   *     imports) tagged as "sdk" exit points — these are internal function
   *     calls, not an external dependency boundary.
   *
   * Both are filtered here so the external-interactions view stays meaningful.
   */
  private isNoiseExitPoint(ep: CASExitPoint): boolean {
    // (2) "sdk" exit point that is not actually an external dependency.
    if (ep.type === 'sdk') {
      const moduleRefs = [ep.target?.sdk, (ep.metadata as any)?.library]
        .filter((v): v is string => typeof v === 'string' && v.length > 0);

      // 2a. Targets a local module (relative/absolute import path).
      if (moduleRefs.length > 0 && moduleRefs.every(m => this.isLocalModuleSpecifier(m))) {
        return true;
      }

      // 2b. Library resolution failed and fell back to the call target
      // itself (sdk === endpoint). This happens for calls on local objects
      // (`skillRepository.findByName`, `permissionQueue.on`) that were never
      // imported from a package — they are internal calls, not SDK usage.
      const sdk = ep.target?.sdk;
      const endpoint = ep.target?.endpoint;
      if (sdk && endpoint && sdk === endpoint) {
        return true;
      }
    }

    // (1) Stdlib noise.
    const candidates = [
      ep.name,
      ep.target?.resource,
      ep.target?.endpoint,
      ep.target?.sdk,
      ep.operation?.method,
    ]
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
      .map(v => v.toLowerCase().replace(/^node:/, ''));

    if (candidates.length === 0) return false;

    // Pure-computation / process-introspection stdlib modules. These are not
    // external boundaries. Network-capable builtins (http, https, net, dns,
    // tls, dgram) are intentionally NOT listed — those are real exit points.
    const noiseModules = [
      'path', 'fs', 'fs/promises', 'os', 'crypto', 'url', 'util',
      'events', 'stream', 'buffer', 'querystring', 'assert',
      'string_decoder', 'zlib', 'perf_hooks',
      'pathlib', 'sys', 'os.path',
    ];
    const noiseExact = new Set(noiseModules);
    const noisePrefixes = noiseModules.map(m => m + '.');

    return candidates.some(c =>
      noiseExact.has(c) || noisePrefixes.some(p => c.startsWith(p))
    );
  }

  /**
   * True when a module specifier refers to code inside this repository
   * rather than an external package. Relative imports (`./x`, `../x`),
   * absolute filesystem paths, and bare local file names with a source
   * extension are all local; bare package specifiers (`express`,
   * `@scope/pkg`) are external.
   */
  private isLocalModuleSpecifier(specifier: string): boolean {
    const s = specifier.trim();
    if (!s) return false;
    if (s.startsWith('./') || s.startsWith('../') || s === '.' || s === '..') return true;
    if (s.startsWith('/')) return true;
    if (/^[a-zA-Z]:[\\/]/.test(s)) return true; // Windows absolute path
    return false;
  }

  private determineSystemType(nodes: CASNode[]): string {
    const types = nodes.map(n => n.type);

    if (types.includes('controller')) return 'service';
    if (types.includes('component')) return 'application';
    if (types.includes('package')) return 'library';
    if (types.includes('module') && types.includes('controller')) return 'monorepo';

    return 'application';
  }

  private buildProgressiveLevels(nodes: CASNode[], categories: CASCategories): CASProgressiveLevels {
    const levelCounts = new Map<number, number>();
    const levelExamples = new Map<number, string[]>();
    const levelCategories = new Map<number, Set<string>>();

    nodes.forEach(node => {
      const level = node.level || 0;
      levelCounts.set(level, (levelCounts.get(level) || 0) + 1);

      const examples = levelExamples.get(level) || [];
      if (examples.length < 3) {
        examples.push(node.id);
        levelExamples.set(level, examples);
      }

      if (node.category) {
        const cats = levelCategories.get(level) || new Set();
        cats.add(node.category);
        levelCategories.set(level, cats);
      }
    });

    const sortedLevels = Array.from(levelCounts.keys()).sort((a, b) => a - b);
    const maxLevel = sortedLevels[sortedLevels.length - 1] || 3;

    const levelDefinitions = sortedLevels.map(level => ({
      level,
      name: this.getLevelName(level),
      description: this.getLevelDescription(level),
      node_count: levelCounts.get(level) || 0,
      recommended_for: this.getRecommendedFor(level),
      example_nodes: levelExamples.get(level) || [],
      time_to_understand: this.getTimeToUnderstand(level),
      contains: {
        categories: Array.from(levelCategories.get(level) || []),
        entry_points: level <= 1 ? 'included' : 'referenced',
        exit_points: level <= 2 ? 'included' : 'referenced',
        key_connections: level <= 2 ? 'all' : 'primary'
      }
    }));

    return {
      total_levels: maxLevel + 1,
      level_definitions: levelDefinitions,
      query_patterns: {
        level_specific: {
          description: 'Get nodes at a specific level',
          example: 'level=1',
          use_case: 'View high-level architecture'
        },
        level_range: {
          description: 'Get nodes up to a certain level',
          example: 'maxLevel=2',
          use_case: 'Progressive exploration'
        },
        discover_levels: {
          description: 'Discover what levels are available',
          example: 'query=levels',
          response: 'List of level definitions'
        },
        category_with_level: {
          description: 'Get specific category at level',
          example: 'category=controllers&level=1',
          use_case: 'Focused exploration'
        },
        children_progressive: {
          description: 'Get children of node progressively',
          example: 'nodeId=xxx&depth=1',
          use_case: 'Drill-down navigation'
        }
      },
      consumer_recommendations: {
        mcp_servers: {
          initial_load: 'Start with levels 0-1 for context',
          on_demand: 'Request deeper levels as needed',
          benefit: 'Reduces token usage by 10-20x',
          adaptive: 'Adjust based on query complexity'
        },
        ui_visualization: {
          overview_mode: 'Show levels 0-1 initially',
          detail_mode: 'Expand to level 2-3 on interaction',
          debug_mode: 'Show all levels with filtering',
          benefit: 'Progressive disclosure improves UX'
        },
        documentation_tools: {
          architecture_docs: 'Use levels 0-1',
          api_docs: 'Use levels 1-2 for endpoints',
          implementation_docs: 'Use levels 2-4',
          benefit: 'Right detail for right audience'
        }
      },
      level_strategy: {
        flexible_depth: 'Analyzers can define custom levels',
        minimum_levels: 2,
        maximum_levels: 'Unlimited, typically 4-6',
        common_range: '3-5 levels',
        examples: {
          'simple_script': '2 levels',
          'web_application': '4 levels',
          'enterprise_system': '5+ levels'
        }
      }
    };
  }

  private getLevelName(level: number): string {
    const names = [
      'System Overview',
      'Major Components',
      'Implementation Details',
      'Function Level',
      'Code Details',
      'Deep Implementation'
    ];
    return names[level] || `Level ${level}`;
  }

  private getLevelDescription(level: number): string {
    const descriptions = [
      'Top-level system architecture and entry points',
      'Major components, services, and their relationships',
      'Classes, modules, and detailed structure',
      'Functions, methods, and their interactions',
      'Variables, parameters, and low-level details',
      'AST nodes and implementation specifics'
    ];
    return descriptions[level] || `Details at level ${level}`;
  }

  private getRecommendedFor(level: number): string[] {
    const recommendations: Record<number, string[]> = {
      0: ['System overview', 'Architecture review', 'Initial exploration'],
      1: ['Component understanding', 'API discovery', 'Service mapping'],
      2: ['Implementation review', 'Code navigation', 'Refactoring planning'],
      3: ['Debugging', 'Detailed analysis', 'Performance optimization'],
      4: ['Deep debugging', 'Security audit', 'Complete understanding']
    };
    return recommendations[level] || ['Detailed analysis'];
  }

  private getTimeToUnderstand(level: number): string {
    const times = ['30 seconds', '2 minutes', '5 minutes', '10 minutes', '20 minutes', '30+ minutes'];
    return times[level] || '30+ minutes';
  }

  private buildIndex(nodes: CASNode[], entryPoints: any[], exitPoints: any[], perspectives: CASPerspective[]): CASIndex {
    const index: CASIndex = {
      by_type: {},
      by_name: {},
      by_perspective: {},
      entry_points: entryPoints.map(ep => ep.id),
      exit_points: exitPoints.map(ep => ep.id)
    };

    nodes.forEach(node => {
      if (!index.by_type![node.type]) {
        index.by_type![node.type] = [];
      }
      index.by_type![node.type].push(node.id);

      const nameKey = node.name.toLowerCase();
      if (!index.by_name![nameKey]) {
        index.by_name![nameKey] = [];
      }
      if (!Array.isArray(index.by_name![nameKey])) {
        index.by_name![nameKey] = [];
      }
      index.by_name![nameKey].push(node.id);

      if (node.perspectives) {
        Object.keys(node.perspectives).forEach(perspectiveId => {
          if (!index.by_perspective![perspectiveId]) {
            index.by_perspective![perspectiveId] = [];
          }
          index.by_perspective![perspectiveId].push(node.id);
        });
      }
    });

    perspectives.forEach(perspective => {
      if (!index.by_perspective![perspective.id]) {
        index.by_perspective![perspective.id] = [];
      }
    });

    return index;
  }

  private mergeCategories(target: CASCategories, source: Partial<CASCategories>): void {
    for (const [level, levelCategories] of Object.entries(source)) {
      if (!target[level]) {
        target[level] = {};
      }
      for (const [category, categoryData] of Object.entries(levelCategories || {})) {
        if (!target[level][category]) {
          target[level][category] = categoryData;
        } else {
          target[level][category] = {
            ...target[level][category],
            ...categoryData,
            types: [...new Set([...(target[level][category].types || []), ...(categoryData.types || [])])],
            frameworks: [...new Set([...(target[level][category].frameworks || []), ...(categoryData.frameworks || [])])],
            languages: [...new Set([...(target[level][category].languages || []), ...(categoryData.languages || [])])]
          };
        }
      }
    }
  }

  /**
   * Nested git repositories are excluded from this analysis so their code is
   * never silently merged into the host system's graph. Without an explicit
   * record, that exclusion looks like a blind spot ("why is the rust/
   * directory missing?"). Each excluded repository is therefore reported on
   * the system surface with its primary language so readers and agents know
   * the boundary is intentional and where to analyze next.
   */
  private async describeNestedRepositories(projectPath: string): Promise<CASNestedRepository[]> {
    const patterns = await this.getNestedRepoIgnorePatterns(projectPath);
    const directories = Array.from(new Set(patterns
      .map(pattern => pattern.replace(/\/\*\*$/, ''))
      .filter(Boolean)))
      .sort();
    return directories.map(directory => {
      const absolute = path.join(projectPath, directory);
      const scan = this.scanDirectoryLanguageProfile(absolute);
      return {
        path: directory,
        has_git_directory: fs.existsSync(path.join(absolute, '.git')),
        ...(scan.primaryLanguage ? { primary_language: scan.primaryLanguage } : {}),
        source_files: scan.sourceFiles,
        note: 'Nested git repository excluded from this analysis; analyze it as its own codebase and link the two through cross-repository correlation.',
      };
    });
  }

  private scanDirectoryLanguageProfile(directoryPath: string): { primaryLanguage?: string; sourceFiles: number } {
    const counts = new Map<string, number>();
    let sourceFiles = 0;
    const stack: Array<{ directory: string; depth: number }> = [{ directory: directoryPath, depth: 0 }];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current.depth > 6) continue;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current.directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (entry.isDirectory()) {
          if (['node_modules', 'dist', 'build', 'coverage', 'vendor', 'vendors', 'tmp', 'log', 'public', 'target', '__pycache__', 'venv', 'env'].includes(entry.name)) continue;
          stack.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 });
          continue;
        }
        const extension = entry.name.split('.').pop()?.toLowerCase() || '';
        const language = AnalyzerOrchestrator.LANGUAGE_NAMES_BY_EXTENSION[extension];
        if (!language) continue;
        sourceFiles += 1;
        counts.set(language, (counts.get(language) || 0) + 1);
      }
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    return { primaryLanguage: top?.[0], sourceFiles };
  }

  private static readonly LANGUAGE_NAMES_BY_EXTENSION: Record<string, string> = {
    ts: 'TypeScript', tsx: 'TypeScript',
    js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
    py: 'Python', java: 'Java', cs: 'C#', go: 'Go', rs: 'Rust',
    php: 'PHP', dart: 'Dart', rb: 'Ruby', erb: 'Ruby', rake: 'Ruby',
    ex: 'Elixir', exs: 'Elixir', scala: 'Scala', kt: 'Kotlin', kts: 'Kotlin',
    swift: 'Swift', lua: 'Lua', r: 'R', jl: 'Julia', erl: 'Erlang',
    clj: 'Clojure', hs: 'Haskell', ml: 'OCaml', vb: 'Visual Basic',
    fs: 'F#', pl: 'Perl', pm: 'Perl', groovy: 'Groovy',
    c: 'C', h: 'C', cpp: 'C++', cc: 'C++', hpp: 'C++', m: 'Objective-C',
  };

  private scanUnanalyzedLanguages(projectPath: string): Array<{ name: string; files: number; share_of_source: number }> {
    const supported = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'java', 'cs', 'dart', 'go', 'rs', 'php', 'rb', 'erb', 'rake']);
    const unanalyzedNames: Record<string, string> = {
      ex: 'Elixir', exs: 'Elixir',
      scala: 'Scala', kt: 'Kotlin', kts: 'Kotlin', swift: 'Swift',
      lua: 'Lua', r: 'R', jl: 'Julia', erl: 'Erlang', clj: 'Clojure',
      hs: 'Haskell', ml: 'OCaml', vb: 'Visual Basic', fs: 'F#',
      pl: 'Perl', pm: 'Perl', groovy: 'Groovy',
    };
    const counts = new Map<string, number>();
    let supportedCount = 0;
    const stack: Array<{ directory: string; depth: number }> = [{ directory: projectPath, depth: 0 }];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current.depth > 6) continue;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current.directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (entry.isDirectory()) {
          if (['node_modules', 'dist', 'build', 'coverage', 'vendor', 'vendors', 'tmp', 'log', 'public', 'target', '.git'].includes(entry.name)) continue;
          stack.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 });
          continue;
        }
        const extension = entry.name.split('.').pop()?.toLowerCase() || '';
        if (supported.has(extension)) supportedCount += 1;
        else if (unanalyzedNames[extension]) counts.set(unanalyzedNames[extension], (counts.get(unanalyzedNames[extension]) || 0) + 1);
      }
    }
    const totalSource = supportedCount + [...counts.values()].reduce((sum, value) => sum + value, 0);
    if (totalSource === 0) return [];
    return [...counts.entries()]
      .map(([name, files]) => ({ name, files, share_of_source: Math.round((files / totalSource) * 100) }))
      .filter(item => item.files >= 5 || item.share_of_source >= 10)
      .sort((a, b) => b.files - a.files);
  }

  private extractTechnologies(contributions: any[], libraries: any[]): any {
    const languages = new Map<string, { count: number; percentage?: number }>();
    const frameworks = new Map<string, { version?: string; confidence: number }>();

    contributions.forEach(contrib => {
      if (contrib.analyzer_type === 'language') {
        const langName = contrib.analyzer_name.replace(' Analyzer', '');
        languages.set(langName, {
          count: contrib.nodes_created,
          percentage: 0
        });

        if (contrib.framework_specific) {
          this.extractFrameworksFromSpec(contrib.framework_specific, frameworks);
        }
      } else if (contrib.analyzer_type === 'framework') {
        const frameworkName = contrib.analyzer_name.replace(' Analyzer', '');
        frameworks.set(frameworkName, {
          confidence: contrib.confidence || 1.0
        });
      }
    });

    const totalNodes = Array.from(languages.values()).reduce((sum, l) => sum + l.count, 0);
    languages.forEach((value, key) => {
      value.percentage = totalNodes > 0 ? (value.count / totalNodes) * 100 : 0;
    });

    return {
      languages: Array.from(languages.entries()).map(([name, data]) => ({
        name,
        percentage: data.percentage,
        files: data.count
      })),
      frameworks: Array.from(frameworks.entries()).map(([name, data]) => ({
        name,
        confidence: data.confidence
      }))
    };
  }

  private extractFrameworksFromSpec(
    spec: Record<string, any>,
    frameworks: Map<string, { version?: string; confidence: number }>
  ): void {
    const processObject = (obj: Record<string, any>, prefix = ''): void => {
      for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'boolean' && value === true) {
          const frameworkName = prefix ? `${prefix}/${key}` : key;
          frameworks.set(frameworkName, { confidence: 1.0 });
        } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          processObject(value, key);
        }
      }
    };
    processObject(spec);
  }

  /**
   * Consolidates size/complexity metrics into the canonical CAS fields.
   * Language analyzers stash these in inconsistent places (or omit them):
   * complexity may live in `metadata.attributes.complexity` or as a bare
   * number, and lines-of-code is often absent entirely. This single pass
   * backfills `metadata.complexity.cyclomatic` and `metadata.metrics.
   * lines_of_code` so every downstream consumer — quality metrics, the
   * maintainability index, stability/hotspot tooling — sees real numbers.
   */
  private normalizeNodeMetrics(nodes: CASNode[]): void {
    for (const node of nodes) {
      if (!node.metadata) continue;
      const md = node.metadata as any;

      // Lines of code: derive from the source span when not already set.
      if (!md.metrics?.lines_of_code) {
        const start = node.source?.line;
        const end = node.source?.end_line;
        if (typeof start === 'number' && typeof end === 'number' && end >= start) {
          md.metrics = md.metrics || {};
          md.metrics.lines_of_code = end - start + 1;
        }
      }

      // Cyclomatic complexity: consolidate from wherever the analyzer left it.
      const complexityIsObject = md.complexity && typeof md.complexity === 'object';
      const hasCyclomatic = complexityIsObject && typeof md.complexity.cyclomatic === 'number';
      if (!hasCyclomatic) {
        const raw =
          (typeof md.attributes?.complexity === 'number' ? md.attributes.complexity : undefined) ??
          (typeof md.complexity === 'number' ? md.complexity : undefined);
        if (typeof raw === 'number' && raw >= 0) {
          const existing = complexityIsObject ? md.complexity : {};
          md.complexity = { ...existing, cyclomatic: raw };
        }
      }
    }
  }

  private calculateQualityMetrics(nodes: CASNode[]): any {
    const totalNodes = nodes.length;
    const documentedNodes = nodes.filter(n => n.description || n.metadata?.documentation).length;
    const testedNodes = nodes.filter(n => n.metadata?.is_test || n.testing?.tested_by).length;

    const complexitySum = nodes.reduce((sum, node) => {
      return sum + (node.metadata?.complexity?.cyclomatic || 0);
    }, 0);

    return {
      documentation_coverage: totalNodes > 0 ? (documentedNodes / totalNodes) * 100 : 0,
      test_coverage: totalNodes > 0 ? (testedNodes / totalNodes) * 100 : 0,
      complexity_score: totalNodes > 0 ? complexitySum / totalNodes : 0,
      maintainability_index: this.computeMaintainabilityIndex(nodes)
    };
  }

  /**
   * Maintainability index derived from a simplified SEI formula, averaged
   * over the nodes that actually carry size/complexity metrics. Returns
   * undefined when no node has the required data rather than fabricating a
   * value. Halstead volume is used when available; otherwise the volume term
   * is approximated from lines of code.
   */
  private computeMaintainabilityIndex(nodes: CASNode[]): number | undefined {
    const scores: number[] = [];
    // The maintainability index is a per-unit metric; average it over code
    // units (functions/methods/classes), not files or modules whose line
    // spans would dominate and skew the result.
    const unitTypes = new Set(['function', 'method', 'class']);

    for (const node of nodes) {
      if (!unitTypes.has(node.type)) continue;
      const loc = node.metadata?.metrics?.lines_of_code;
      if (!loc || loc <= 0) continue;

      const cc = node.metadata?.complexity?.cyclomatic ?? 1;
      const halsteadVolume = node.metadata?.complexity?.halstead?.volume;
      const volume = halsteadVolume && halsteadVolume > 0
        ? halsteadVolume
        : loc * 4; // rough proxy when Halstead is unavailable

      // SEI maintainability index, normalized to 0-100.
      const raw = 171 - 5.2 * Math.log(volume) - 0.23 * cc - 16.2 * Math.log(loc);
      const normalized = Math.max(0, Math.min(100, (raw * 100) / 171));
      scores.push(normalized);
    }

    if (scores.length === 0) return undefined;
    return scores.reduce((sum, s) => sum + s, 0) / scores.length;
  }

  private buildArchitectureSummary(
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[],
    contributions: any[]
  ): CASArchitectureSummary {
    const productNodes = nodes.filter(node => this.isPrimaryProductNode(node));
    const productNodeIds = new Set(productNodes.map(node => node.id));
    const productEntryPoints = entryPoints.filter(ep =>
      (!ep.source_node || productNodeIds.has(ep.source_node)) &&
      (!ep.handler?.file || this.isPrimaryProductPath(ep.handler.file))
    );
    const fileNodes = productNodes.filter(n => n.type === 'file');
    const httpEntryPoints = productEntryPoints.filter(ep => ep.type === 'http');

    const controllers = productNodes.filter(n => n.type === 'controller' || n.subcategories?.includes('controller'));
    const services = productNodes.filter(n => n.type === 'service' || n.subcategories?.includes('service'));
    const entities = productNodes.filter(n => n.type === 'entity' || n.subcategories?.includes('entity'));
    const repositories = productNodes.filter(n => n.type === 'repository' || n.subcategories?.includes('repository'));
    const guards = productNodes.filter(n => n.type === 'guard' || n.subcategories?.includes('guard'));
    const middleware = productNodes.filter(n => n.type === 'middleware' || n.subcategories?.includes('middleware'));
    const modules = productNodes.filter(n => n.type === 'module');
    const components = productNodes.filter(n => n.type === 'component');
    const pages = productNodes.filter(n => n.type === 'page' || n.subcategories?.includes('page'));
    const migrations = productNodes.filter(n => n.type === 'migration' || n.source?.file?.includes('migration'));
    const architecturalInventory = this.buildArchitecturalInventory(productNodes);
    const architecturalPatterns = this.detectArchitecturalPatterns(productNodes, architecturalInventory, {
      controllers,
      services,
      repositories,
      entities,
      components,
      pages,
      modules,
    });
    const patternBalance = this.assessPatternBalance(architecturalPatterns, productNodes);
    const systemType = this.inferArchitectureSystemType(productNodes, productEntryPoints, contributions, {
      controllers,
      services,
      repositories,
      entities,
      components,
      pages,
      modules,
      architecturalInventory,
    });

    const authenticatedEndpoints = httpEntryPoints.filter(ep => ep.security?.authenticated);
    const publicEndpoints = httpEntryPoints.filter(ep => !ep.security?.authenticated);

    const methodCounts: Record<string, number> = {};
    httpEntryPoints.forEach(ep => {
      const method = ep.trigger?.method?.toUpperCase() || 'UNKNOWN';
      methodCounts[method] = (methodCounts[method] || 0) + 1;
    });

    const uniqueGuards = new Set<string>();
    httpEntryPoints.forEach(ep => {
      const epGuards = ep.metadata?.guards as string[] | undefined;
      if (epGuards) {
        epGuards.forEach(g => uniqueGuards.add(g));
      }
    });

    let authStrategy: string | undefined;
    if (uniqueGuards.has('JwtAuthGuard') || uniqueGuards.has('JwtGuard')) {
      authStrategy = 'JWT';
    } else if (uniqueGuards.has('SessionGuard')) {
      authStrategy = 'Session';
    } else if (uniqueGuards.has('AuthGuard')) {
      authStrategy = 'Custom';
    }

    return {
      system_type: systemType,
      total_files: fileNodes.length,
      architectural_patterns: architecturalPatterns.length > 0 ? architecturalPatterns : undefined,
      architectural_inventory: architecturalInventory,
      pattern_balance: patternBalance,
      layers: {
        presentation: {
          controllers: controllers.length > 0 ? controllers.length : undefined,
          guards: guards.length > 0 ? guards.length : undefined,
          middleware: middleware.length > 0 ? middleware.length : undefined,
          endpoints: httpEntryPoints.length > 0 ? httpEntryPoints.length : undefined,
          components: components.length > 0 ? components.length : undefined,
          pages: pages.length > 0 ? pages.length : undefined
        },
        business: {
          services: services.length > 0 ? services.length : undefined
        },
        data: {
          repositories: repositories.length > 0 ? repositories.length : undefined,
          entities: entities.length > 0 ? entities.length : undefined,
          migrations: migrations.length > 0 ? migrations.length : undefined
        },
        infrastructure: {
          modules: modules.length > 0 ? modules.length : undefined
        }
      },
      api_surface: httpEntryPoints.length > 0 ? {
        total_endpoints: httpEntryPoints.length,
        by_auth: {
          authenticated: authenticatedEndpoints.length,
          public: publicEndpoints.length
        },
        by_method: methodCounts
      } : undefined,
      security: authenticatedEndpoints.length > 0 ? {
        auth_strategy: authStrategy,
        protected_endpoints: authenticatedEndpoints.length,
        guards: Array.from(uniqueGuards)
      } : undefined
    };
  }

  private inferArchitectureSystemType(
    productNodes: CASNode[],
    productEntryPoints: CASEntryPoint[],
    contributions: any[],
    counts: {
      controllers: CASNode[];
      services: CASNode[];
      repositories: CASNode[];
      entities: CASNode[];
      components: CASNode[];
      pages: CASNode[];
      modules: CASNode[];
      architecturalInventory: NonNullable<CASArchitectureSummary['architectural_inventory']>;
    }
  ): string {
    const productFiles = productNodes
      .map(node => node.source?.file || '')
      .filter(Boolean)
      .map(file => file.replace(/\\/g, '/').toLowerCase());
    const uniqueFiles = new Set(productFiles);
    const pathText = [...uniqueFiles].join('\n');
    const httpEntryPoints = productEntryPoints.filter(entryPoint => entryPoint.type === 'http');
    const pageEntryPoints = productEntryPoints.filter(entryPoint => entryPoint.type === 'page');
    const cliEntryPoints = productEntryPoints.filter(entryPoint => entryPoint.type === 'cli');
    const frameworkNames = contributions
      .filter(contribution => contribution.analyzer_type === 'framework')
      .map(contribution => String(contribution.analyzer_name || '').toLowerCase());
    const hasAppsAndPackages = productFiles.some(file => /(^|\/)apps\//.test(file)) &&
      productFiles.some(file => /(^|\/)(packages|libs)\//.test(file));
    const hasInfrastructureSurface = productFiles.some(file => /\.(tf|tfvars|hcl)$/i.test(file) || /(^|\/)(terraform|opentofu|pulumi|helm|k8s|charts)\//.test(file)) ||
      frameworkNames.some(name => /\b(terraform|opentofu|pulumi|helm|kubernetes|cloudformation)\b/.test(name));
    const hasDesktopSurface = frameworkNames.some(name => /\b(wpf|winforms|electron|tauri|desktop)\b/.test(name)) ||
      productFiles.some(file =>
        /\.(xaml|csproj)$/i.test(file) ||
        /(^|\/)(views|windows|viewmodels)\//.test(file) ||
        /(^|\/)(electron\.vite\.config\.[jt]s|src\/(main|preload|renderer)\/|main\/index\.[jt]s|preload\/index\.[jt]s|renderer\/index\.html)/.test(file)
      );
    const hasMobileSurface = frameworkNames.some(name => /\b(flutter|react native|ios|android)\b/.test(name)) ||
      productFiles.some(file => /\.(dart|swift|kt)$/i.test(file) || /(^|\/)(android|ios|lib\/screens)\//.test(file));
    const hasBackendFramework = frameworkNames.some(name =>
      /\b(symfony|laravel|django|fastapi|spring|asp\.?net|nestjs)\b/.test(name)
    );
    const hasMcpSurface = /\bmcp-server\b|modelcontextprotocol|(^|\/)mcp(\/|-)/.test(pathText);
    const hasAnalyzerSurface = /\banalyzer-core\b|(^|\/)analyzers?\//.test(pathText) ||
      productNodes.some(node => /analy[sz]er/i.test(`${node.name} ${node.type}`));
    const hasFrontendFileSurface = productFiles.some(file =>
      /\.(tsx|jsx|vue|svelte)$/.test(file) ||
      /(^|\/)(pages?|components?|views?)\//.test(file) ||
      /(^|\/)(src\/main|src\/app|src\/index)\.(tsx|jsx)$/.test(file)
    );
    const hasFrontendSurface = counts.components.length + counts.pages.length + pageEntryPoints.length > 0 || hasFrontendFileSurface;
    const hasApiSurface = counts.controllers.length + httpEntryPoints.length > 0;
    const hasDataSurface = counts.repositories.length + counts.entities.length > 0;
    const hasScriptEntrySurface = productFiles.some(file =>
      /(^|\/)(main|index|cli|script|bot|runner)\.(cjs|mjs|js|jsx|ts|tsx|py|rb|php|rs|go)$/.test(file) ||
      /(^|\/)(bin|cli|cmd|commands|scripts?|jobs|workers)\//.test(file)
    );

    if (hasMcpSurface && hasAnalyzerSurface && hasAppsAndPackages) {
      return 'MCP analyzer monorepo';
    }
    if (hasMcpSurface && hasAnalyzerSurface) {
      return 'MCP analyzer service';
    }
    if (hasInfrastructureSurface && !hasApiSurface && !hasFrontendSurface) {
      return 'Cloud infrastructure';
    }
    if (hasMobileSurface && hasApiSurface) {
      return 'Mobile + API application';
    }
    if (hasMobileSurface) {
      return 'Mobile application';
    }
    if (hasAppsAndPackages && hasFrontendSurface && hasApiSurface) {
      return 'Full-stack monorepo';
    }
    if (hasAppsAndPackages && hasApiSurface) {
      return 'API monorepo';
    }
    if (hasAppsAndPackages) {
      return 'Monorepo';
    }
    if (hasBackendFramework && hasApiSurface) {
      return hasDataSurface ? 'Backend service' : 'HTTP service';
    }
    if (hasDesktopSurface) {
      return 'Desktop application';
    }
    if (hasMcpSurface) {
      return 'MCP server';
    }
    if (hasFrontendSurface && hasApiSurface && hasDataSurface) {
      return 'Full-stack application';
    }
    if (hasFrontendSurface && !hasApiSurface) {
      return pageEntryPoints.length > 0 || hasFrontendFileSurface ? 'Frontend application' : 'UI application';
    }
    if (hasApiSurface) {
      return hasDataSurface ? 'API service' : 'HTTP service';
    }
    if ((cliEntryPoints.length > 0 || hasScriptEntrySurface) && !hasApiSurface) {
      return 'CLI application';
    }

    const frameworkType = this.inferDominantFrameworkSystemType(contributions);
    if (frameworkType) return frameworkType;

    const languageContribution = contributions.find(c => c.analyzer_type === 'language' && c.application_type);
    return languageContribution?.application_type || 'Application';
  }

  private inferDominantFrameworkSystemType(contributions: any[]): string | undefined {
    const frameworkContributions = contributions
      .filter(contribution => contribution.analyzer_type === 'framework' && !this.isTestingFrameworkContribution(contribution))
      .map(contribution => ({
        name: String(contribution.analyzer_name || '').replace(' Analyzer', ''),
        nodes: Number(contribution.nodes_created || 0),
        confidence: Number(contribution.confidence || 1),
      }))
      .filter(contribution => contribution.name && contribution.nodes > 0)
      .sort((a, b) => (b.nodes * b.confidence) - (a.nodes * a.confidence));

    const [top, second] = frameworkContributions;
    if (!top) return undefined;
    if (top.nodes < 4 && second) return undefined;
    if (second && top.nodes < second.nodes * 1.25 && top.nodes < 10) return undefined;
    return top.name;
  }

  private buildArchitecturalInventory(nodes: CASNode[]): NonNullable<CASArchitectureSummary['architectural_inventory']> {
    const byPredicate = (predicate: (node: CASNode, text: string, file: string) => boolean) => nodes
      .filter(node => !node.metadata?.is_test && !node.metadata?.is_generated)
      .filter(node => this.isArchitecturalInventoryNode(node))
      .filter(node => {
        const text = `${node.type} ${node.name} ${(node.subcategories || []).join(' ')}`.toLowerCase();
        const file = node.source?.file?.toLowerCase() || '';
        return predicate(node, text, file);
      })
      .map(node => node.id);

    return {
      models: byPredicate((node, text, file) =>
        /\b(entity|model|schema)\b/.test(text) || /(^|\/)(models?|entities|schema)(\/|$)/.test(file)
      ),
      views: byPredicate((node, text, file) =>
        /\b(view|page|component|template|screen|window)\b/.test(text) || /(^|\/)(views?|pages?|components?|screens?|templates?)(\/|$)/.test(file)
      ),
      controllers: byPredicate((node, text, file) =>
        /\b(controller|resolver|route|handler)\b/.test(text) || /controller|resolver|routes?\./.test(file)
      ),
      view_models: byPredicate((node, text, file) =>
        /\b(viewmodel|view_model|view-model)\b/.test(text) || /view[-_]?models?/.test(file)
      ),
      services: byPredicate((node, text, file) =>
        /\b(service|usecase|use_case|use-case|interactor|manager)\b/.test(text) || /(^|\/)(services?|use-cases?|use_cases|interactors?)(\/|$)/.test(file)
      ),
      repositories: byPredicate((node, text, file) =>
        /\b(repository|repo|dao|gateway|store)\b/.test(text) || /(^|\/)(repositories?|repos?|dao|gateways?|stores?)(\/|$)/.test(file)
      ),
      clients: byPredicate((node, text, file) =>
        /\b(client|sdk|connector|adapter|integration|apiwrapper|api_wrapper|api-wrapper)\b/.test(text) ||
        /(^|\/)(clients?|sdk|connectors?|adapters?|integrations?)(\/|$)/.test(file) ||
        /(^|\/)[a-z0-9_-]*client\.[a-z0-9]+$/.test(file)
      ),
      mediators: byPredicate((node, text, file) =>
        /\b(mediator|commandhandler|queryhandler|eventhandler|handler|bus|dispatcher)\b/.test(text) || /mediator|command[-_]?handler|query[-_]?handler|event[-_]?handler|dispatcher|\/handlers?\//.test(file)
      ),
      unit_of_work: byPredicate((node, text, file) =>
        /\b(unitofwork|unit_of_work|transactionmanager|transactional)\b/.test(text) || /unit[-_]?of[-_]?work|transaction[-_]?manager/.test(file)
      ),
      singletons: byPredicate((node, text, file) =>
        /\b(singleton|registry)\b/.test(text) || /singleton|registry/.test(file) || node.runtime?.scalability?.singleton === true
      ),
      scripts: byPredicate((node, text, file) =>
        /\b(main|cli|command|job|worker|script|bot|runner)\b/.test(text) ||
        /(^|\/)(bin|cli|cmd|commands|jobs|workers|scripts?)(\/|$)/.test(file) ||
        /(^|\/)(main|index|app|server|worker|bot)\.[a-z0-9]+$/.test(file)
      ),
      packages: byPredicate((node, text, file) =>
        /\b(package|library|module|namespace|export)\b/.test(text) ||
        /(^|\/)(src|lib|include|packages?)(\/|$)/.test(file)
      ),
    };
  }

  private isArchitecturalInventoryNode(node: CASNode): boolean {
    const type = String(node.type || '').toLowerCase();
    if ([
      'import',
      'use',
      'variable',
      'constant',
      'parameter',
      'property',
      'field',
      'attribute',
      'enum_member',
      'literal',
      'comment',
      'using',
    ].includes(type)) {
      return false;
    }

    if (type === 'method') {
      const name = String(node.name || '').toLowerCase();
      return /(handle|execute|process|dispatch|render|validate|authorize|route|action|command|query|event)/.test(name);
    }

    return true;
  }

  private isPrimaryProductNode(node: CASNode): boolean {
    if (node.metadata?.is_test || node.metadata?.is_generated) return false;
    return this.isPrimaryProductPath(node.source?.file || node.name || '');
  }

  private isPrimaryProductNodeForProject(node: CASNode, projectPath: string): boolean {
    if (node.metadata?.is_test || node.metadata?.is_generated) return false;
    return this.isPrimaryProductPathForProject(node.source?.file || node.name || '', projectPath);
  }

  private filterPrimaryProductEntryPoints(entryPoints: CASEntryPoint[], nodes: CASNode[], projectPath: string): CASEntryPoint[] {
    const productNodeIds = new Set(nodes
      .filter(node => this.isPrimaryProductNodeForProject(node, projectPath))
      .map(node => node.id));
    return entryPoints.filter(entryPoint =>
      (!entryPoint.source_node || productNodeIds.has(entryPoint.source_node)) &&
      (!entryPoint.handler?.file || this.isPrimaryProductPathForProject(entryPoint.handler.file, projectPath))
    );
  }

  private frameworkNamesForPurpose(contributions: any[], nodes: CASNode[], projectPath: string): string[] {
    const productFrameworks = new Set<string>();
    for (const node of nodes) {
      if (!node.source?.file) continue;
      if (!this.isPrimaryProductNodeForProject(node, projectPath)) continue;
      const metadata = (node.metadata || {}) as Record<string, unknown>;
      const candidates = [
        metadata.framework,
        metadata.library,
        ...(Array.isArray(metadata.frameworks) ? metadata.frameworks : []),
      ];
      for (const candidate of candidates) {
        const name = String(candidate || '')
          .trim()
          .replace(/\s*analyzer$/i, '')
          .replace(/^enhanced\s+/i, '')
          .trim();
        if (name) productFrameworks.add(name);
      }
    }

    if (productFrameworks.size > 0) {
      return [...productFrameworks]
        .filter(name => !/\b(language|ast|analyzer)\b/i.test(name))
        .slice(0, 8);
    }
    return [];
  }

  private isPrimaryProductPathForProject(filePath: string, projectPath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/');
    if (!normalized) return true;
    if (path.isAbsolute(normalized)) {
      const relative = path.relative(projectPath, normalized).replace(/\\/g, '/');
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        return this.isPrimaryProductPath(relative);
      }
      return false;
    }
    return this.isPrimaryProductPath(normalized);
  }

  private isPrimaryProductPath(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/').toLowerCase();
    if (!normalized) return true;
    if (/^(fixtures?|__fixtures__|tests?|__tests__|spec|e2e|cypress|playwright)[./]/.test(normalized)) return false;
    if (/[./](fixtures?|__fixtures__|tests?|__tests__|spec|e2e|cypress|playwright)[./]/.test(normalized)) return false;
    if (/(^|\/)(node_modules|dist|build|coverage|vendor|vendors|generated|fixtures?|__fixtures__|__mocks__)(\/|$)/.test(normalized)) return false;
    if (/\.(min|bundle)\.(js|css)$/.test(normalized)) return false;
    if (/\/lib\/(waypoints|owlcarousel|chart|easing|tempusdominus|bootstrap|jquery)\//.test(normalized)) return false;
    if (/(^|\/)(__tests__|tests?|spec|e2e|cypress|playwright)(\/|$)/.test(normalized)) return false;
    if (/\.(test|spec|stories|story)\.[a-z0-9]+$/.test(normalized)) return false;
    if (/^legacy\//.test(normalized)) return false;
    return true;
  }

  private detectArchitecturalPatterns(
    nodes: CASNode[],
    inventory: NonNullable<CASArchitectureSummary['architectural_inventory']>,
    counts: {
      controllers: CASNode[];
      services: CASNode[];
      repositories: CASNode[];
      entities: CASNode[];
      components: CASNode[];
      pages: CASNode[];
      modules: CASNode[];
    }
  ): NonNullable<CASArchitectureSummary['architectural_patterns']> {
    const patterns: NonNullable<CASArchitectureSummary['architectural_patterns']> = [];
    const add = (
      name: string,
      category: NonNullable<CASArchitectureSummary['architectural_patterns']>[number]['category'],
      confidence: number,
      evidence: string[],
      nodeIds: string[],
      guidance: string
    ) => {
      if (nodeIds.length === 0 || confidence < 0.35) return;
      patterns.push({
        name,
        category,
        confidence: Number(confidence.toFixed(2)),
        evidence,
        node_ids: Array.from(new Set(nodeIds)).slice(0, 80),
        guidance,
      });
    };

    const mvcEvidence: string[] = [];
    if (inventory.models.length > 0) mvcEvidence.push(`${inventory.models.length} model/entity nodes`);
    if (inventory.views.length > 0) mvcEvidence.push(`${inventory.views.length} view/page/component nodes`);
    if (inventory.controllers.length > 0) mvcEvidence.push(`${inventory.controllers.length} controller/route/handler nodes`);
    const hasMvcInventory = inventory.models.length > 0 && inventory.views.length > 0 && inventory.controllers.length > 0;
    add(
      'MVC',
      'application-architecture',
      hasMvcInventory ? 0.75 + Math.min(0.2, Math.log10(inventory.models.length + inventory.views.length + inventory.controllers.length) / 10) : 0,
      mvcEvidence,
      [...inventory.models, ...inventory.views, ...inventory.controllers],
      'When adding features, keep request handling in controllers/routes, state/data shape in models/entities, and rendering in views/components.'
    );

    add(
      'MVVM',
      'presentation',
      inventory.view_models.length > 0 && inventory.views.length > 0
        ? Math.min(0.95, 0.55 + inventory.view_models.length / Math.max(8, inventory.views.length))
        : 0,
      [`${inventory.view_models.length} view-model nodes`, `${inventory.views.length} view nodes`],
      [...inventory.view_models, ...inventory.views],
      'When adding UI behavior, prefer existing view-model binding/state patterns instead of putting orchestration directly into views.'
    );

    add(
      'Service Layer',
      'business-logic',
      counts.services.length > 0 ? Math.min(0.95, 0.45 + counts.services.length / Math.max(10, nodes.length / 20)) : 0,
      [`${counts.services.length} service/use-case nodes`],
      inventory.services,
      'Put business rules in services/use-cases and keep entry points thin.'
    );

    add(
      'Repository',
      'data-access',
      counts.repositories.length > 0 ? Math.min(0.95, 0.5 + counts.repositories.length / Math.max(8, counts.entities.length || 1)) : 0,
      [`${counts.repositories.length} repository/store nodes`, `${counts.entities.length} model/entity nodes`],
      inventory.repositories,
      'Use the repository/store layer for persistence access instead of reaching into storage from controllers or UI code.'
    );

    add(
      'Mediator / Handler',
      'business-logic',
      inventory.mediators.length > 0 ? Math.min(0.95, 0.45 + inventory.mediators.length / Math.max(10, nodes.length / 30)) : 0,
      [`${inventory.mediators.length} mediator/handler/bus nodes`],
      inventory.mediators,
      'Route commands, queries, and events through the existing handler or bus style when present.'
    );

    add(
      'Unit of Work',
      'data-access',
      inventory.unit_of_work.length > 0 ? 0.8 : 0,
      [`${inventory.unit_of_work.length} unit-of-work/transaction manager nodes`],
      inventory.unit_of_work,
      'Keep multi-entity persistence changes inside the transaction/unit-of-work boundary.'
    );

    add(
      'Singleton / Registry',
      'object-lifecycle',
      inventory.singletons.length > 0 ? Math.min(0.85, 0.45 + inventory.singletons.length / 10) : 0,
      [`${inventory.singletons.length} singleton/registry nodes`],
      inventory.singletons,
      'Reuse existing singleton/registry lifecycle patterns carefully; avoid adding hidden global state without matching local practice.'
    );

    add(
      'Feature Modules',
      'application-architecture',
      counts.modules.length > 1 ? Math.min(0.9, 0.45 + counts.modules.length / 20) : 0,
      [`${counts.modules.length} module nodes`],
      counts.modules.map(node => node.id),
      'Place new behavior in the closest feature module instead of widening root modules.'
    );

    add(
      'Layered Architecture',
      'application-architecture',
      this.layeredArchitectureConfidence(inventory, counts, nodes),
      [
        `${counts.controllers.length} controller/entry nodes`,
        `${counts.services.length} service/use-case nodes`,
        `${counts.repositories.length} repository/store nodes`,
        `${counts.entities.length} model/entity nodes`,
      ],
      [
        ...inventory.controllers,
        ...inventory.services,
        ...inventory.repositories,
        ...inventory.models,
      ],
      'Preserve the existing layer direction: entry/presentation calls business services, business code calls data/integration boundaries, and lower layers do not reach back up.'
    );

    add(
      'Component/Page UI',
      'presentation',
      inventory.views.length > 0
        ? Math.min(0.9, 0.42 + inventory.views.length / Math.max(20, nodes.length / 8))
        : 0,
      [`${inventory.views.length} page/component/template nodes`],
      inventory.views,
      'Place UI changes beside the nearest page/component/template examples and preserve local state, routing, and styling conventions.'
    );

    add(
      'Client SDK / API Wrapper',
      'integration',
      inventory.clients.length > 0
        ? Math.min(0.92, 0.48 + inventory.clients.length / Math.max(10, nodes.length / 25))
        : 0,
      [`${inventory.clients.length} client/sdk/adapter nodes`],
      inventory.clients,
      'Treat client/SDK/adapter classes as integration boundaries; keep protocol concerns there instead of spreading remote-call details into business code.'
    );

    add(
      'Command Script / Automation',
      'application-architecture',
      inventory.scripts.length > 0
        ? Math.min(0.88, 0.43 + inventory.scripts.length / Math.max(8, nodes.length / 20))
        : 0,
      [`${inventory.scripts.length} CLI/script/worker/bot nodes`],
      inventory.scripts,
      'For automation or bot-style repos, preserve the entry script, orchestration loop, and helper-module split instead of introducing unrelated web/service structure.'
    );

    add(
      'Library / Module Package',
      'application-architecture',
      inventory.packages.length >= 8 && inventory.controllers.length === 0 && inventory.views.length === 0
        ? Math.min(0.86, 0.38 + inventory.packages.length / Math.max(30, nodes.length / 8))
        : 0,
      [`${inventory.packages.length} package/library/module nodes`],
      inventory.packages,
      'Treat exported modules and library namespaces as the primary architecture; preserve public API shape and colocate helpers under the existing package layout.'
    );

    const staticSiteNodes = nodes.filter(node => {
      const file = node.source?.file?.replace(/\\/g, '/').toLowerCase() || '';
      return /(^|\/)(public|static|assets|images|styles|css)(\/|$)/.test(file) ||
        /\.(html|css|scss|sass|less|png|jpg|jpeg|webp|svg)$/.test(file);
    });
    add(
      'Static Site / Asset Pipeline',
      'presentation',
      staticSiteNodes.length >= 8 ? Math.min(0.9, 0.45 + staticSiteNodes.length / Math.max(30, nodes.length)) : 0,
      [`${staticSiteNodes.length} static page/asset/style nodes`],
      staticSiteNodes.map(node => node.id),
      'Treat content, styling, and assets as the primary architecture; preserve placement, naming, and build conventions around public/static/assets directories.'
    );

    return patterns.sort((a, b) => b.confidence - a.confidence);
  }

  private layeredArchitectureConfidence(
    inventory: NonNullable<CASArchitectureSummary['architectural_inventory']>,
    counts: {
      controllers: CASNode[];
      services: CASNode[];
      repositories: CASNode[];
      entities: CASNode[];
    },
    nodes: CASNode[]
  ): number {
    const layeredPathSignals = nodes.filter(node => {
      const file = node.source?.file?.replace(/\\/g, '/').toLowerCase() || '';
      return /(^|\/)(domain|application|app|services?|business|infrastructure|infra|presentation|ui|web|data|persistence)(\/|$)/.test(file) ||
        /(^|\/)[1-5]\.(domain|infrastructure|services?|presentation|tests?)(\/|$)/.test(file);
    }).length;

    const presentationLayer = counts.controllers.length > 0 || inventory.controllers.length > 0 || inventory.views.length > 0;
    const businessLayer = counts.services.length > 0 || inventory.services.length > 0 || inventory.mediators.length > 0;
    const dataLayer = counts.repositories.length > 0 || inventory.repositories.length > 0 || counts.entities.length > 0 || inventory.models.length > 0;
    const integrationLayer = inventory.clients.length > 0;
    const explicitLayerCount = [presentationLayer, businessLayer, dataLayer || integrationLayer].filter(Boolean).length;

    if (explicitLayerCount < 2) return 0;
    if (!businessLayer && layeredPathSignals < Math.max(8, nodes.length / 80)) return 0;

    const present = explicitLayerCount;
    return Math.min(0.94, 0.35 + present * 0.16 + layeredPathSignals / Math.max(30, nodes.length / 8));
  }

  private assessPatternBalance(
    patterns: NonNullable<CASArchitectureSummary['architectural_patterns']>,
    nodes: CASNode[]
  ): NonNullable<CASArchitectureSummary['pattern_balance']> {
    const risks: string[] = [];
    const recommendations: string[] = [];
    const highConfidence = patterns.filter(pattern => pattern.confidence >= 0.65);
    const antiPatternCount = patterns.filter(pattern => pattern.category === 'anti-pattern').length;

    let status: NonNullable<CASArchitectureSummary['pattern_balance']>['status'] = 'balanced';
    if (highConfidence.length === 0 && nodes.length > 50) {
      status = 'under-patterned';
      risks.push('Few architectural patterns are visible for the size of the codebase.');
      recommendations.push('Before adding major features, identify the local placement and boundary convention from nearby files.');
    } else if (highConfidence.length > 8) {
      status = 'over-patterned';
      risks.push('Many architectural patterns appear simultaneously; agents may overfit to pattern names without local examples.');
      recommendations.push('Prefer the highest-confidence patterns and concrete examples from the target area.');
    }
    if (antiPatternCount > 0) {
      status = status === 'balanced' ? 'mixed' : status;
      risks.push(`${antiPatternCount} anti-pattern signal(s) appear in the architecture inventory.`);
    }

    if (recommendations.length === 0) {
      recommendations.push('Use detected patterns as placement guidance, then verify against local examples and tests.');
    }

    return {
      status,
      detected_count: patterns.length,
      risks,
      recommendations,
    };
  }

  private buildRouteTable(entryPoints: CASEntryPoint[]): CASRouteTableEntry[] {
    const httpEntryPoints = entryPoints.filter(ep => ep.type === 'http');

    return httpEntryPoints.map(ep => {
      const metadata = ep.metadata || {};
      const controllerName = metadata.controller as string || 'Unknown';
      const handlerName = metadata.handler as string || metadata.method_name as string || ep.name;

      return {
        method: ep.trigger?.method?.toUpperCase() || 'GET',
        path: ep.trigger?.path || '/',
        controller: controllerName,
        handler: handlerName,
        auth: ep.security?.authenticated || false,
        guards: metadata.guards as string[] | undefined,
        source_node: ep.source_node,
        description: ep.description
      };
    }).sort((a, b) => {
      if (a.path !== b.path) return a.path.localeCompare(b.path);
      return a.method.localeCompare(b.method);
    });
  }

  private buildDatabaseSchema(nodes: CASNode[], libraries: any[], projectPath?: string): CASDatabaseSchema {
    const entities: CASDatabaseEntity[] = [];
    const relationships: string[] = [];

    let orm: string | undefined;
    const mikroormLib = libraries.find(l => l.name?.includes('mikro-orm') || l.name?.includes('@mikro-orm'));
    const typeormLib = libraries.find(l => l.name?.includes('typeorm'));
    const prismaLib = libraries.find(l => l.name?.includes('prisma'));

    if (mikroormLib) orm = 'MikroORM';
    else if (typeormLib) orm = 'TypeORM';
    else if (prismaLib) orm = 'Prisma';

    if (!orm) {
      const importNodes = nodes.filter(n => n.type === 'import');
      if (importNodes.some(n => n.name?.includes('@mikro-orm') || n.metadata?.attributes?.source?.includes('@mikro-orm'))) {
        orm = 'MikroORM';
      } else if (importNodes.some(n => n.name?.includes('typeorm') || n.metadata?.attributes?.source?.includes('typeorm'))) {
        orm = 'TypeORM';
      } else if (importNodes.some(n => n.name?.includes('prisma') || n.metadata?.attributes?.source?.includes('prisma'))) {
        orm = 'Prisma';
      }
    }

    const entityNodes = nodes.filter(n =>
      (!projectPath || this.isPrimaryProductNodeForProject(n, projectPath)) &&
      !n.subcategories?.includes('abstract') &&
      (
        n.type === 'entity' ||
        n.type === 'model' ||
        n.subcategories?.includes('entity') ||
        n.metadata?.annotations?.some(a => a.includes('Entity')) ||
        (n.type === 'class' && n.source?.file?.includes('/entities/'))
      )
    );

    const propertyIndex = this.buildEntityPropertyIndex(nodes);
    entityNodes.forEach(entityNode => {
      const fields: CASDatabaseEntity['fields'] = [];
      const entityRelationships: CASDatabaseEntity['relationships'] = [];

      const propertyNodes = this.entityPropertyNodesFromIndex(propertyIndex, entityNode);

      propertyNodes.forEach(prop => {
        const annotations = [
          ...(prop.metadata?.annotations || []),
          ...this.sourceDecoratorsForNode(projectPath, prop),
        ];
        const isPrimary = annotations.some(a => a.includes('PrimaryKey') || a.includes('PrimaryGeneratedColumn'));
        const isUnique = annotations.some(a => a.includes('Unique'));
        const nullable = this.decoratorOptionBoolean(annotations, 'nullable');
        const defaultValue = this.decoratorOptionValue(annotations, 'default');

        let relationType: string | undefined;
        let relTarget: string | undefined;

        for (const ann of annotations) {
          if (ann.includes('OneToMany')) relationType = 'OneToMany';
          else if (ann.includes('ManyToOne')) relationType = 'ManyToOne';
          else if (ann.includes('OneToOne')) relationType = 'OneToOne';
          else if (ann.includes('ManyToMany')) relationType = 'ManyToMany';

          const targetMatch = ann.match(/\(\)\s*=>\s*(\w+)/);
          if (targetMatch) relTarget = targetMatch[1];
        }

        if (relationType && relTarget) {
          entityRelationships.push({
            type: relationType as any,
            target: relTarget,
            field: prop.name
          });

          const cardinality = relationType === 'OneToMany' ? '1:N' :
            relationType === 'ManyToOne' ? 'N:1' :
            relationType === 'ManyToMany' ? 'N:M' : '1:1';
          relationships.push(`${entityNode.name} ${cardinality} ${relTarget} (via ${prop.name})`);
        } else {
          fields.push({
            name: prop.name,
            type: prop.signature?.return_type || 'unknown',
            primary: isPrimary,
            unique: isUnique,
            nullable,
            default: defaultValue
          });
        }
      });

      entities.push({
        name: entityNode.name,
        table: entityNode.metadata?.attributes?.tableName as string,
        source_file: entityNode.source?.file,
        fields,
        relationships: entityRelationships
      });
    });

    return {
      orm,
      entities,
      relationships_summary: [...new Set(relationships)]
    };
  }

  private entityPropertyNodes(nodes: CASNode[], entityNode: CASNode): CASNode[] {
    return this.entityPropertyNodesFromIndex(this.buildEntityPropertyIndex(nodes), entityNode);
  }

  private buildEntityPropertyIndex(nodes: CASNode[]): EntityPropertyIndex {
    const byParent = new Map<string, Array<{ node: CASNode; position: number }>>();
    const byFileBasename = new Map<string, Array<{ node: CASNode; position: number; normalizedFile: string }>>();

    for (let position = 0; position < nodes.length; position++) {
      const node = nodes[position];
      if (node.type !== 'property' && node.type !== 'field' && node.type !== 'attribute' && node.type !== 'variable') {
        continue;
      }
      if (node.parent) {
        let bucket = byParent.get(node.parent);
        if (!bucket) {
          bucket = [];
          byParent.set(node.parent, bucket);
        }
        bucket.push({ node, position });
      }
      if (node.source?.file) {
        const normalizedFile = this.normalizeSourcePath(node.source.file);
        const basename = normalizedFile.slice(normalizedFile.lastIndexOf('/') + 1);
        let bucket = byFileBasename.get(basename);
        if (!bucket) {
          bucket = [];
          byFileBasename.set(basename, bucket);
        }
        bucket.push({ node, position, normalizedFile });
      }
    }

    return { byParent, byFileBasename };
  }

  private entityPropertyNodesFromIndex(index: EntityPropertyIndex, entityNode: CASNode): CASNode[] {
    const matches = new Map<CASNode, number>();

    for (const { node, position } of index.byParent.get(entityNode.id) || []) {
      matches.set(node, position);
    }

    if (entityNode.source?.file) {
      const entityFile = this.normalizeSourcePath(entityNode.source.file);
      const basename = entityFile.slice(entityFile.lastIndexOf('/') + 1);
      for (const { node, position, normalizedFile } of index.byFileBasename.get(basename) || []) {
        if (matches.has(node)) continue;
        if (this.normalizedSourcePathsCompatible(normalizedFile, entityFile) && node.id.includes(entityNode.id)) {
          matches.set(node, position);
        }
      }
    }

    return [...matches.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([node]) => node);
  }

  private normalizeSourcePath(file: string): string {
    return file.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  }

  private normalizedSourcePathsCompatible(left: string, right: string): boolean {
    return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
  }

  private sourceFilesCompatible(left: string, right: string): boolean {
    return this.normalizedSourcePathsCompatible(this.normalizeSourcePath(left), this.normalizeSourcePath(right));
  }

  private sourceDecoratorsForNode(projectPath: string | undefined, node: CASNode): string[] {
    if (!projectPath || !node.source?.file || !node.source.line) return [];
    const filePath = path.isAbsolute(node.source.file)
      ? node.source.file
      : path.join(projectPath, node.source.file);
    if (!fs.existsSync(filePath)) return [];
    try {
      const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
      const decorators: string[] = [];
      const propertyIndex = this.sourceDeclarationLine(lines, node);
      for (let index = Math.max(0, propertyIndex - 1); index >= 0; index--) {
        const line = lines[index]?.trim() || '';
        if (!line) {
          if (decorators.length > 0) break;
          continue;
        }
        if (line.startsWith('@')) {
          decorators.unshift(line);
          continue;
        }
        if (line.startsWith('})') || line.startsWith(')')) {
          decorators.unshift(line);
          continue;
        }
        if (/^[A-Za-z0-9_]+:/.test(line) || line === '{' || line === '})' || line.endsWith(',')) {
          decorators.unshift(line);
          continue;
        }
        break;
      }
      return decorators;
    } catch {
      return [];
    }
  }

  private sourceDeclarationLine(lines: string[], node: CASNode): number {
    const start = Math.max(0, (node.source?.line || 1) - 1);
    const pattern = new RegExp(`\\b${node.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    for (let index = start; index < Math.min(lines.length, start + 12); index++) {
      const line = lines[index] || '';
      if (!line.trim().startsWith('@') && pattern.test(line)) return index;
    }
    return start;
  }

  private decoratorOptionBoolean(annotations: string[], option: string): boolean | undefined {
    const text = annotations.join(' ');
    const match = text.match(new RegExp(`${option}\\s*:\\s*(true|false)`));
    return match ? match[1] === 'true' : undefined;
  }

  private decoratorOptionValue(annotations: string[], option: string): string | undefined {
    const text = annotations.join(' ');
    const match = text.match(new RegExp(`${option}\\s*:\\s*([^,})]+)`));
    return match?.[1]?.trim();
  }

  private buildExternalServices(
    nodes: CASNode[],
    exitPoints: CASExitPoint[],
    libraries: any[]
  ): CASExternalService[] {
    const services: CASExternalService[] = [];
    const serviceMap = new Map<string, CASExternalService>();


    exitPoints.forEach(ep => {
      if (ep.type === 'database') {
        const dbKey = ep.target?.service_id || 'primary_database';
        if (!serviceMap.has(dbKey)) {
          const databaseName = this.isMeaningfulExternalServiceName(ep.name) ? ep.name : 'Database';
          serviceMap.set(dbKey, {
            id: `ext_${dbKey}`,
            name: databaseName || 'Database',
            type: 'database',
            purpose: 'bidirectional',
            connected_nodes: [],
            exit_points: []
          });
        }
        const svc = serviceMap.get(dbKey)!;
        if (ep.source_node && !svc.connected_nodes?.includes(ep.source_node)) {
          svc.connected_nodes?.push(ep.source_node);
        }
        svc.exit_points?.push(ep.id);
      } else if (ep.type === 'cache') {
        const cacheKey = 'redis_cache';
        if (!serviceMap.has(cacheKey)) {
          serviceMap.set(cacheKey, {
            id: `ext_${cacheKey}`,
            name: 'Redis',
            type: 'cache',
            purpose: 'bidirectional',
            usage_pattern: {
              operations: []
            },
            connected_nodes: [],
            exit_points: []
          });
        }
        const svc = serviceMap.get(cacheKey)!;
        if (ep.source_node && !svc.connected_nodes?.includes(ep.source_node)) {
          svc.connected_nodes?.push(ep.source_node);
        }
        svc.exit_points?.push(ep.id);
      } else if (ep.type === 'api' || ep.type === 'sdk') {
        const sdkName = ep.target?.sdk || ep.name || 'External API';

        if (isLanguageBuiltinName(sdkName) || isLanguageBuiltinExitPoint(ep) || !this.isMeaningfulExternalServiceName(sdkName)) {
          return;
        }

        const key = sdkName.toLowerCase().replace(/\s+/g, '_');

        if (!serviceMap.has(key)) {
          serviceMap.set(key, {
            id: `ext_${key}`,
            name: sdkName,
            type: ep.type === 'sdk' ? 'sdk' : 'api',
            purpose: 'consumption',
            connected_nodes: [],
            exit_points: []
          });
        }
        const svc = serviceMap.get(key)!;
        if (ep.source_node && !svc.connected_nodes?.includes(ep.source_node)) {
          svc.connected_nodes?.push(ep.source_node);
        }
        svc.exit_points?.push(ep.id);
      }
    });

    const aiLibraries = libraries.filter(l =>
      l.name?.includes('openai') ||
      l.name?.includes('anthropic') ||
      l.name?.includes('@anthropic-ai')
    );

    aiLibraries.forEach(lib => {
      const key = lib.name?.includes('openai') ? 'openai' : 'anthropic';
      if (!serviceMap.has(key)) {
        serviceMap.set(key, {
          id: `ext_${key}`,
          name: key === 'openai' ? 'OpenAI' : 'Anthropic',
          type: 'ai_provider',
          purpose: 'consumption',
          configuration: {
            library: lib.name,
            version: lib.version
          }
        });
      }
    });

    serviceMap.forEach(svc => services.push(svc));

    return services;
  }

  private isMeaningfulExternalServiceName(name: string | undefined): boolean {
    if (/^(external call|linq operation):/i.test(name || '')) return false;
    const value = (name || '').replace(/^call to\s*/i, '').trim();
    if (!value) return false;
    const lower = value.toLowerCase();
    if (/^(database|request external|shutil|subprocess|re|pathlib|os|sys|typing|datetime|uuid)$/.test(lower)) return false;
    if (value.includes('${')) return false;
    if (/[()[\]{}]|=>/.test(value) || /^_?\w+\./.test(value) && /^_?(ctx|context|db|repository|repo|service|client)\./i.test(value)) return false;
    if (/^(get|post|put|patch|delete|fetch)\s+/i.test(value) && !/^https?:\/\//i.test(value)) return false;
    if (/^(file|directory|path|string|math|console|task|timer|thread|datetime|timespan|guid|uri|regex|stream|streamwriter|streamreader|enumerable|linq)(\.|$)/i.test(value)) return false;
    if (/\.ctor$/i.test(value)) return false;
    if (/^system(\.|$)/i.test(value)) return false;
    if (/^(?:db|[A-Z][A-Za-z0-9_]*(?:Service|Controller|Repository|Repo|Model|Store|Client|DbContext|Context)?)\.[A-Za-z_]\w*$/.test(value)) return false;
    if (/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(value) && !value.includes('/') && !value.startsWith('@')) return false;
    if (/^\w+\.\w+\(/.test(value)) return false;
    if (/^\.?\//.test(value) || lower.startsWith('route') || lower.includes('window.location')) return false;
    if (/^(node:|rxjs(?:\/|$)|protractor(?:\/|$)|@angular(?:\/|$)|@app(?:\/|$)|@shared(?:\/|$)|openclaw\/plugin-sdk(?:\/|$))/.test(lower)) return false;
    if (/^(object|array|string|number|boolean|date|math|json|promise|map|set|error|regexp|function|process|global)(\.|$)/.test(lower)) return false;
    return true;
  }

  private detectPatterns(nodes: CASNode[], edges: CASEdge[]): CASPattern[] {
    const patterns: CASPattern[] = [];

    this.detectRepositoryPattern(nodes, edges, patterns);
    this.detectServiceLayerPattern(nodes, edges, patterns);
    this.detectControllerPattern(nodes, edges, patterns);
    this.detectDependencyInjectionPattern(nodes, edges, patterns);
    this.detectModulePattern(nodes, edges, patterns);
    this.detectGuardPattern(nodes, edges, patterns);
    this.detectGodObjectAntiPattern(nodes, patterns);
    this.detectCircularDependencyAntiPattern(nodes, edges, patterns);

    return patterns;
  }

  private detectRepositoryPattern(nodes: CASNode[], edges: CASEdge[], patterns: CASPattern[]): void {
    const repositories = nodes.filter(n =>
      n.type === 'repository' ||
      n.subcategories?.includes('repository') ||
      n.name.toLowerCase().endsWith('repository') ||
      n.name.toLowerCase().endsWith('repo')
    );

    if (repositories.length === 0) return;

    const diRepositories = repositories.filter(n =>
      n.metadata?.annotations?.some(a => a.includes('Injectable')) ||
      n.subcategories?.includes('injectable')
    );

    const manualRepositories = repositories.filter(n =>
      !n.metadata?.annotations?.some(a => a.includes('Injectable')) &&
      !n.subcategories?.includes('injectable')
    );

    const variations: CASPattern['variations'] = [];
    const deviations: CASPattern['deviations'] = [];

    if (diRepositories.length > 0) {
      variations.push({
        id: 'var-repository-di',
        implementation: 'dependency-injection',
        description: 'Repository managed by DI container with @Injectable decorator',
        instances: diRepositories.map(n => n.id),
        percentage: Math.round((diRepositories.length / repositories.length) * 100)
      });
    }

    if (manualRepositories.length > 0) {
      variations.push({
        id: 'var-repository-manual',
        implementation: 'manual-instantiation',
        description: 'Repository instantiated manually without DI',
        instances: manualRepositories.map(n => n.id),
        percentage: Math.round((manualRepositories.length / repositories.length) * 100)
      });
    }

    if (variations.length > 1) {
      const dominant = variations.reduce((a, b) => a.percentage > b.percentage ? a : b);
      const minority = variations.filter(v => v.id !== dominant.id);

      if (dominant.percentage < 90) {
        deviations.push({
          type: 'mixed-styles',
          severity: 'warning',
          description: `Mixed repository implementation styles: ${variations.map(v => `${v.percentage}% ${v.implementation}`).join(', ')}`,
          affected_instances: minority.flatMap(v => v.instances),
          recommendation: `Consider standardizing on ${dominant.implementation} for consistency`
        });
      }
    }

    patterns.push({
      id: 'repository-pattern',
      name: 'Repository Pattern',
      description: 'Data access abstraction through repository pattern',
      confidence: 0.9,
      instances: repositories.map(n => n.id),
      variations: variations.length > 0 ? variations : undefined,
      deviations: deviations.length > 0 ? deviations : undefined
    });
  }

  private detectServiceLayerPattern(nodes: CASNode[], edges: CASEdge[], patterns: CASPattern[]): void {
    const services = nodes.filter(n =>
      n.type === 'service' ||
      n.subcategories?.includes('service') ||
      (n.name.toLowerCase().endsWith('service') && n.type === 'class')
    );

    if (services.length === 0) return;

    const diServices = services.filter(n =>
      n.metadata?.annotations?.some(a => a.includes('Injectable'))
    );

    const nonDiServices = services.filter(n =>
      !n.metadata?.annotations?.some(a => a.includes('Injectable'))
    );

    const variations: CASPattern['variations'] = [];
    const deviations: CASPattern['deviations'] = [];

    if (diServices.length > 0) {
      variations.push({
        id: 'var-service-di',
        implementation: 'dependency-injection',
        description: 'Service managed by DI container',
        instances: diServices.map(n => n.id),
        percentage: Math.round((diServices.length / services.length) * 100)
      });
    }

    if (nonDiServices.length > 0) {
      variations.push({
        id: 'var-service-standalone',
        implementation: 'standalone',
        description: 'Service without DI management',
        instances: nonDiServices.map(n => n.id),
        percentage: Math.round((nonDiServices.length / services.length) * 100)
      });
    }

    if (nonDiServices.length > 0 && diServices.length > 0) {
      deviations.push({
        type: 'inconsistent-adoption',
        severity: 'info',
        description: `${nonDiServices.length} services are not using dependency injection`,
        affected_instances: nonDiServices.map(n => n.id),
        recommendation: 'Consider using @Injectable for all services for consistent dependency management'
      });
    }

    patterns.push({
      id: 'service-layer-pattern',
      name: 'Service Layer Pattern',
      description: 'Business logic encapsulated in service layer',
      confidence: 0.85,
      instances: services.map(n => n.id),
      variations: variations.length > 0 ? variations : undefined,
      deviations: deviations.length > 0 ? deviations : undefined
    });
  }

  private detectControllerPattern(nodes: CASNode[], edges: CASEdge[], patterns: CASPattern[]): void {
    const controllers = nodes.filter(n =>
      n.type === 'controller' ||
      n.subcategories?.includes('controller') ||
      n.metadata?.annotations?.some(a => a.includes('Controller'))
    );

    if (controllers.length === 0) return;

    const restControllers = controllers.filter(n =>
      n.metadata?.annotations?.some(a =>
        a.includes('Get') || a.includes('Post') || a.includes('Put') ||
        a.includes('Delete') || a.includes('Patch')
      )
    );

    const graphqlResolvers = controllers.filter(n =>
      n.metadata?.annotations?.some(a =>
        a.includes('Resolver') || a.includes('Query') || a.includes('Mutation')
      )
    );

    const variations: CASPattern['variations'] = [];

    if (restControllers.length > 0) {
      variations.push({
        id: 'var-controller-rest',
        implementation: 'rest-api',
        description: 'REST API controllers with HTTP method decorators',
        instances: restControllers.map(n => n.id),
        percentage: Math.round((restControllers.length / controllers.length) * 100)
      });
    }

    if (graphqlResolvers.length > 0) {
      variations.push({
        id: 'var-controller-graphql',
        implementation: 'graphql-resolver',
        description: 'GraphQL resolvers',
        instances: graphqlResolvers.map(n => n.id),
        percentage: Math.round((graphqlResolvers.length / controllers.length) * 100)
      });
    }

    patterns.push({
      id: 'controller-pattern',
      name: 'Controller Pattern',
      description: 'Request handling through controller pattern',
      confidence: 0.9,
      instances: controllers.map(n => n.id),
      variations: variations.length > 0 ? variations : undefined
    });
  }

  private detectDependencyInjectionPattern(nodes: CASNode[], edges: CASEdge[], patterns: CASPattern[]): void {
    const dependsOnEdges = edges.filter(e => e.type === 'depends_on');
    const injectableNodes = nodes.filter(n =>
      n.metadata?.annotations?.some(a => a.includes('Injectable')) ||
      n.subcategories?.includes('injectable')
    );

    if (dependsOnEdges.length === 0 && injectableNodes.length === 0) return;

    const constructorInjected = nodes.filter(n => {
      const incomingDeps = dependsOnEdges.filter(e => e.target === n.id);
      return incomingDeps.length > 0;
    });

    const providedByModules = nodes.filter(n =>
      edges.some(e => e.type === 'provides' && e.target === n.id)
    );

    const variations: CASPattern['variations'] = [];

    if (constructorInjected.length > 0) {
      variations.push({
        id: 'var-di-constructor',
        implementation: 'constructor-injection',
        description: 'Dependencies injected via constructor',
        instances: constructorInjected.map(n => n.id),
        percentage: injectableNodes.length > 0
          ? Math.round((constructorInjected.length / injectableNodes.length) * 100)
          : 100
      });
    }

    patterns.push({
      id: 'dependency-injection-pattern',
      name: 'Dependency Injection Pattern',
      description: 'Dependencies managed through injection container',
      confidence: 0.9,
      instances: injectableNodes.map(n => n.id),
      variations: variations.length > 0 ? variations : undefined
    });
  }

  private detectModulePattern(nodes: CASNode[], edges: CASEdge[], patterns: CASPattern[]): void {
    const modules = nodes.filter(n =>
      n.type === 'module' ||
      n.metadata?.annotations?.some(a => a.includes('Module'))
    );

    if (modules.length === 0) return;

    const featureModules = modules.filter(n =>
      !n.name.toLowerCase().includes('app') &&
      !n.name.toLowerCase().includes('root') &&
      !n.name.toLowerCase().includes('core')
    );

    const coreModules = modules.filter(n =>
      n.name.toLowerCase().includes('app') ||
      n.name.toLowerCase().includes('root') ||
      n.name.toLowerCase().includes('core')
    );

    const variations: CASPattern['variations'] = [];

    if (featureModules.length > 0) {
      variations.push({
        id: 'var-module-feature',
        implementation: 'feature-module',
        description: 'Feature-specific modules for domain separation',
        instances: featureModules.map(n => n.id),
        percentage: Math.round((featureModules.length / modules.length) * 100)
      });
    }

    if (coreModules.length > 0) {
      variations.push({
        id: 'var-module-core',
        implementation: 'core-module',
        description: 'Core/root application modules',
        instances: coreModules.map(n => n.id),
        percentage: Math.round((coreModules.length / modules.length) * 100)
      });
    }

    patterns.push({
      id: 'module-pattern',
      name: 'Module Pattern',
      description: 'Application organized into modules for encapsulation',
      confidence: 0.85,
      instances: modules.map(n => n.id),
      variations: variations.length > 0 ? variations : undefined
    });
  }

  private detectGuardPattern(nodes: CASNode[], edges: CASEdge[], patterns: CASPattern[]): void {
    const guards = nodes.filter(n =>
      n.type === 'guard' ||
      n.subcategories?.includes('guard') ||
      n.name.toLowerCase().includes('guard')
    );

    if (guards.length === 0) return;

    const authGuards = guards.filter(n =>
      n.name.toLowerCase().includes('auth') ||
      n.name.toLowerCase().includes('jwt')
    );

    const roleGuards = guards.filter(n =>
      n.name.toLowerCase().includes('role') ||
      n.name.toLowerCase().includes('permission')
    );

    const otherGuards = guards.filter(n =>
      !authGuards.includes(n) && !roleGuards.includes(n)
    );

    const variations: CASPattern['variations'] = [];

    if (authGuards.length > 0) {
      variations.push({
        id: 'var-guard-auth',
        implementation: 'authentication-guard',
        description: 'Guards for authentication verification',
        instances: authGuards.map(n => n.id),
        percentage: Math.round((authGuards.length / guards.length) * 100)
      });
    }

    if (roleGuards.length > 0) {
      variations.push({
        id: 'var-guard-role',
        implementation: 'role-based-guard',
        description: 'Guards for role/permission verification',
        instances: roleGuards.map(n => n.id),
        percentage: Math.round((roleGuards.length / guards.length) * 100)
      });
    }

    if (otherGuards.length > 0) {
      variations.push({
        id: 'var-guard-custom',
        implementation: 'custom-guard',
        description: 'Custom guards for specific validation',
        instances: otherGuards.map(n => n.id),
        percentage: Math.round((otherGuards.length / guards.length) * 100)
      });
    }

    patterns.push({
      id: 'guard-pattern',
      name: 'Guard Pattern',
      description: 'Authorization and validation through guards',
      confidence: 0.85,
      instances: guards.map(n => n.id),
      variations: variations.length > 0 ? variations : undefined
    });
  }

  private detectGodObjectAntiPattern(nodes: CASNode[], patterns: CASPattern[]): void {
    const godObjects = nodes.filter(n => {
      const lineCount = n.metadata?.metrics?.lines_of_code || 0;
      const complexity = n.metadata?.complexity?.cyclomatic || 0;
      const methodCount = nodes.filter(m => m.parent === n.id && m.type === 'method').length;

      return lineCount > 1000 || complexity > 50 || methodCount > 30;
    });

    if (godObjects.length === 0) return;

    patterns.push({
      id: 'god-object-anti-pattern',
      name: 'God Object Anti-Pattern',
      description: 'Components with excessive complexity or size',
      confidence: 0.7,
      instances: godObjects.map(n => n.id),
      deviations: [{
        type: 'anti-pattern',
        severity: 'warning',
        description: `${godObjects.length} component(s) have excessive complexity or size`,
        affected_instances: godObjects.map(n => n.id),
        recommendation: 'Consider breaking down large components into smaller, focused units'
      }]
    });
  }

  private detectCircularDependencyAntiPattern(nodes: CASNode[], edges: CASEdge[], patterns: CASPattern[]): void {
    const dependencyEdges = edges.filter(e =>
      e.type === 'depends_on' || e.type === 'imports' || e.type === 'uses'
    );

    const adjacency = new Map<string, string[]>();
    dependencyEdges.forEach(edge => {
      if (!adjacency.has(edge.source)) {
        adjacency.set(edge.source, []);
      }
      adjacency.get(edge.source)!.push(edge.target);
    });

    const visited = new Set<string>();
    const visiting = new Set<string>();
    const cycles: string[][] = [];

    const detectCycle = (nodeId: string, path: string[]): boolean => {
      if (visiting.has(nodeId)) {
        const cycleStart = path.indexOf(nodeId);
        if (cycleStart !== -1) {
          cycles.push(path.slice(cycleStart));
        }
        return true;
      }

      if (visited.has(nodeId)) return false;

      visiting.add(nodeId);
      path.push(nodeId);

      const deps = adjacency.get(nodeId) || [];
      for (const dep of deps) {
        detectCycle(dep, [...path]);
      }

      visiting.delete(nodeId);
      visited.add(nodeId);
      return false;
    };

    adjacency.forEach((_, nodeId) => {
      if (!visited.has(nodeId)) {
        detectCycle(nodeId, []);
      }
    });

    if (cycles.length === 0) return;

    const uniqueCycles = cycles.filter((cycle, i) =>
      cycles.findIndex(c => c.join('->') === cycle.join('->')) === i
    );

    patterns.push({
      id: 'circular-dependency-anti-pattern',
      name: 'Circular Dependency Anti-Pattern',
      description: 'Circular dependencies detected in component graph',
      confidence: 0.9,
      instances: [...new Set(uniqueCycles.flat())],
      deviations: uniqueCycles.map((cycle, i) => ({
        type: 'anti-pattern' as const,
        severity: 'error' as const,
        description: `Circular dependency: ${cycle.join(' -> ')} -> ${cycle[0]}`,
        affected_instances: cycle,
        recommendation: 'Break the cycle by introducing an interface or restructuring dependencies'
      }))
    });
  }

  private buildIntents(nodes: CASNode[]): CASIntent[] {
    const intents: CASIntent[] = [];

    for (const node of nodes) {
      const evidence: Array<{
        type: 'commit_message' | 'pr_description' | 'code_comment' | 'pattern_deviation' | 'naming_convention';
        source: string;
        excerpt: string;
        confidence_contribution: number;
      }> = [];

      if (node.comments && node.comments.length > 0) {
        for (const comment of node.comments) {
          if (comment.purpose === 'explanation' || comment.markers?.is_hack || comment.markers?.is_warning) {
            evidence.push({
              type: 'code_comment',
              source: comment.location?.file || node.source?.file || 'unknown',
              excerpt: comment.text.substring(0, 200),
              confidence_contribution: 0.4
            });
          }
        }
      }

      if (node.todos && node.todos.length > 0) {
        for (const todo of node.todos) {
          evidence.push({
            type: 'code_comment',
            source: todo.location?.file || node.source?.file || 'unknown',
            excerpt: `${todo.type}: ${todo.text.substring(0, 150)}`,
            confidence_contribution: 0.3
          });
        }
      }

      const workaroundPatterns = ['hack', 'workaround', 'temporary', 'legacy', 'deprecated', 'temp', 'fixme'];
      const nameLower = node.name.toLowerCase();
      const isWorkaround = workaroundPatterns.some(p => nameLower.includes(p));

      if (isWorkaround) {
        evidence.push({
          type: 'naming_convention',
          source: node.source?.file || 'unknown',
          excerpt: `Name contains workaround indicator: ${node.name}`,
          confidence_contribution: 0.2
        });
      }

      if (evidence.length > 0) {
        const totalConfidence = evidence.reduce((sum, e) => sum + e.confidence_contribution, 0);
        const confidence: 'high' | 'medium' | 'low' =
          totalConfidence >= 0.7 ? 'high' :
          totalConfidence >= 0.4 ? 'medium' : 'low';

        const intent: CASIntent = {
          node_id: node.id,
          inferred_purpose: node.description || node.documentation?.summary,
          confidence,
          workaround_indicator: isWorkaround ? {
            is_workaround: true,
            workaround_for: 'Detected from naming pattern'
          } : undefined
        };

        if (evidence.length > 0) {
          intent.architectural_decision = {
            decision: 'Implementation approach',
            evidence: evidence as any
          };
        }

        intents.push(intent);
      }
    }

    return intents;
  }

  private buildFlowSummary(nodes: CASNode[], entryPoints: CASEntryPoint[]): CASFlowSummary {
    const criticalPatterns = ['auth', 'login', 'password', 'payment', 'checkout', 'billing', 'charge', 'refund', 'token', 'session', 'oauth', 'credential'];
    const highPatterns = ['user', 'account', 'order', 'profile', 'subscription', 'permission', 'role', 'admin', 'delete', 'remove'];
    const mediumPatterns = ['create', 'update', 'modify', 'change', 'setting', 'preference'];

    const classified = {
      critical: [] as string[],
      high: [] as string[],
      medium: [] as string[],
      low: [] as string[]
    };

    for (const ep of entryPoints) {
      if (ep.type === 'test') continue;

      const path = (ep.trigger?.path || ep.name || '').toLowerCase();
      const method = ep.trigger?.method?.toUpperCase() || '';
      const hasAuth = ep.security?.authenticated || (ep as any).security?.authenticated;

      let score = 0;

      if (criticalPatterns.some(p => path.includes(p))) {
        score += 40;
      }
      if (highPatterns.some(p => path.includes(p))) {
        score += 20;
      }
      if (mediumPatterns.some(p => path.includes(p))) {
        score += 10;
      }

      if (method === 'POST' || method === 'PUT' || method === 'DELETE' || method === 'PATCH') {
        score += 15;
      }

      if (hasAuth) {
        score += 10;
      }

      if (ep.type === 'cli') {
        score += 5;
      }

      let criticality: 'critical' | 'high' | 'medium' | 'low';
      if (score >= 50) {
        criticality = 'critical';
      } else if (score >= 30) {
        criticality = 'high';
      } else if (score >= 15) {
        criticality = 'medium';
      } else {
        criticality = 'low';
      }

      classified[criticality].push(ep.id);
    }

    const totalCritical = classified.critical.length + classified.high.length;

    return {
      total_critical_flows: totalCritical,
      by_criticality: {
        critical: classified.critical.length,
        high: classified.high.length,
        medium: classified.medium.length,
        low: classified.low.length
      },
      untested_critical_flows: [],
      high_error_rate_flows: []
    };
  }

  private buildCallChains(
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[],
    _callGraph: CallGraphBuilder
  ): CASCallChain[] {
    const nodeById = new Map(nodes.map(node => [node.id, node]));
    const exitBySource = new Map<string, CASExitPoint[]>();
    for (const exitPoint of exitPoints) {
      if (!exitBySource.has(exitPoint.source_node)) {
        exitBySource.set(exitPoint.source_node, []);
      }
      exitBySource.get(exitPoint.source_node)!.push(exitPoint);
    }

    const relationshipTypes = new Set([
      'calls',
      'uses',
      'depends_on',
      'queries',
      'reads',
      'writes',
      'publishes',
      'subscribes',
      'emits',
      'handles',
      'routes_to',
      'implements',
      'implemented_by'
    ]);
    const adjacency = new Map<string, CASEdge[]>();
    for (const edge of edges) {
      if (!relationshipTypes.has(edge.type)) continue;
      if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) continue;
      if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
      adjacency.get(edge.source)!.push(edge);
    }

    const chains: CASCallChain[] = [];
    const maxDepth = 8;

    for (const entryPoint of entryPoints) {
      const startNodeId = entryPoint.handler?.node_id || entryPoint.source_node;
      const startNode = nodeById.get(startNodeId);
      if (!startNode) continue;

      const selectedPath: Array<{ nodeId: string; edge?: CASEdge }> = [{ nodeId: startNode.id }];
      const visited = new Set<string>([startNode.id]);
      let currentNodeId = startNode.id;
      let matchedExitPoint: CASExitPoint | undefined;

      for (let depth = 0; depth < maxDepth; depth++) {
        const exits = exitBySource.get(currentNodeId);
        if (exits?.length) {
          matchedExitPoint = exits[0];
          break;
        }

        const nextEdge = (adjacency.get(currentNodeId) || [])
          .filter(edge => !visited.has(edge.target))
          .sort((a, b) => this.rankChainEdge(a) - this.rankChainEdge(b))[0];

        if (!nextEdge) break;

        selectedPath.push({ nodeId: nextEdge.target, edge: nextEdge });
        visited.add(nextEdge.target);
        currentNodeId = nextEdge.target;
      }

      matchedExitPoint = matchedExitPoint || exitBySource.get(currentNodeId)?.[0];

      const pathNodes = selectedPath
        .map(step => nodeById.get(step.nodeId))
        .filter((node): node is CASNode => Boolean(node));
      const hasDatabaseCalls = Boolean(matchedExitPoint && matchedExitPoint.type === 'database') ||
        pathNodes.some(node => ['repository', 'entity', 'database', 'model'].includes(node.type));
      const hasExternalCalls = Boolean(matchedExitPoint);
      const hasAsyncCalls = pathNodes.some(node => Boolean(node.metadata?.is_async || node.metadata?.attributes?.isAsync));
      const maxPathDepth = Math.max(1, selectedPath.length - 1);
      const riskLevel = hasDatabaseCalls || hasExternalCalls || entryPoint.type === 'http' ? 'medium' : 'low';

      chains.push({
        id: `chain:${entryPoint.id}`,
        chain_type: matchedExitPoint ? 'entry-to-exit' : selectedPath.length > 1 ? 'dead-end' : 'dead-end',
        entry_point: {
          node_id: startNode.id,
          method_name: entryPoint.handler?.method_name || startNode.name,
          entry_point_id: entryPoint.id
        },
        exit_point: matchedExitPoint ? {
          node_id: matchedExitPoint.source_node,
          method_name: matchedExitPoint.operation?.action || matchedExitPoint.name,
          exit_point_id: matchedExitPoint.id
        } : undefined,
        call_path: selectedPath.map((step, index) => {
          const node = nodeById.get(step.nodeId);
          return {
            call_id: step.edge?.id || `entry:${entryPoint.id}`,
            node_id: step.nodeId,
            method_name: node?.name || step.nodeId,
            depth: index
          };
        }),
        characteristics: {
          total_calls: Math.max(0, selectedPath.length - 1),
          max_depth: maxPathDepth,
          has_external_calls: hasExternalCalls,
          has_database_calls: hasDatabaseCalls,
          has_async_calls: hasAsyncCalls,
          is_circular: false,
          is_recursive: false,
          complexity_score: maxPathDepth + (hasDatabaseCalls ? 2 : 0) + (hasExternalCalls ? 2 : 0)
        },
        risk_analysis: {
          risk_level: riskLevel,
          risk_factors: [
            ...(hasDatabaseCalls ? ['data-access'] : []),
            ...(hasExternalCalls ? ['external-boundary'] : []),
            ...(selectedPath.length === 1 ? ['unexpanded-entry-point'] : [])
          ]
        },
        criticality: entryPoint.type === 'http' ? 'medium' : 'low',
        criticality_factors: [entryPoint.type]
      });
    }

    return chains;
  }

  private rankChainEdge(edge: CASEdge): number {
    const ranks: Record<string, number> = {
      calls: 0,
      routes_to: 1,
      handles: 2,
      queries: 3,
      writes: 4,
      reads: 5,
      publishes: 6,
      emits: 7,
      depends_on: 8,
      uses: 9,
      implements: 10,
      implemented_by: 11,
      subscribes: 12
    };
    return ranks[edge.type] ?? 99;
  }

  private buildEnhancedFlowSummary(
    callChains: CASCallChain[],
    entryPoints: CASEntryPoint[]
  ): CASFlowSummary {
    const byCriticality = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0
    };

    const untestedCritical: string[] = [];
    const highErrorRate: string[] = [];

    for (const chain of callChains) {
      const crit = chain.criticality || 'low';
      byCriticality[crit]++;

      if ((crit === 'critical' || crit === 'high') && !chain.test_coverage?.covered) {
        untestedCritical.push(chain.id);
      }

      if (chain.runtime_stats?.error_rate_percent && chain.runtime_stats.error_rate_percent > 5) {
        highErrorRate.push(chain.id);
      }
    }

    return {
      total_critical_flows: byCriticality.critical + byCriticality.high,
      by_criticality: byCriticality,
      untested_critical_flows: untestedCritical,
      high_error_rate_flows: highErrorRate
    };
  }

  private enhanceChangeRisks(
    changeRisks: CASChangeRisk[],
    callGraph: CallGraphBuilder,
    callChains: CASCallChain[],
    entryPoints: CASEntryPoint[]
  ): CASChangeRisk[] {
    return changeRisks.map(risk => {
      const transitiveCallers = callGraph.getTransitiveCallers(risk.node_id);
      const affectedChains = callGraph.getAffectedCallChains(risk.node_id, callChains);
      const affectedEntries = callGraph.getEntryPointsReachingNode(risk.node_id, entryPoints);

      return {
        ...risk,
        downstream_impact: {
          ...risk.downstream_impact,
          transitive_callers: transitiveCallers,
          affected_call_chains: affectedChains,
          affected_entry_points: affectedEntries.map(e => e.id)
        }
      };
    });
  }

  /**
   * Budgeted, non-fatal AI interpretation pass. Replaces the heuristic
   * `inferred_description` with a model-generated narrative when the AI
   * subsystem is enabled and responds within the wall-clock budget.
   * On timeout, failure, or a low-quality result the heuristic description
   * produced by buildEnhancedSystemPurpose is left untouched.
   */
  private async applyAIInterpretation(
    enhancedSystemPurpose: EnhancedSystemPurpose,
    systemName: string,
    frameworks: string[],
    entryPointSummary: { type: string; count: number }[],
    databaseEntities: string[],
    externalServices: string[],
    flowGraph: CASFlowGraph,
    domainConcepts: CASDomainConcept[],
    systemCapabilities: SystemCapability[] = [],
    unanalyzedLanguages: Array<{ name: string; files: number; share_of_source: number }> = [],
    libraryNames: string[] = []
  ): Promise<void> {
    if (process.env.KLAURO_AI_INTERPRETATION === 'false' || process.env.KLAURO_AI_INTERPRETATION === '0') {
      this.recordDescriptionGeneration(enhancedSystemPurpose, 'deterministic', 'ai_skipped', false, 'disabled-by-env');
      return;
    }
    if (!aiConfig.features.naturalLanguageDescriptions) {
      this.recordDescriptionGeneration(enhancedSystemPurpose, 'deterministic', 'ai_skipped', false, 'feature-disabled');
      return;
    }
    if (!this.hasAIInterpretationProviderConfigured()) {
      this.recordDescriptionGeneration(enhancedSystemPurpose, 'deterministic', 'ai_skipped', false, 'no-ai-provider-configured');
      return;
    }
    if (AnalyzerOrchestrator.aiInterpretationDisabledUntil > Date.now()) {
      this.recordDescriptionGeneration(enhancedSystemPurpose, 'deterministic', 'ai_skipped', false, 'cooldown-active');
      return;
    }
    if (this.shouldKeepDeterministicSystemDescription(enhancedSystemPurpose)) {
      this.recordDescriptionGeneration(enhancedSystemPurpose, 'deterministic', 'deterministic_kept', false, 'deterministic-description-is-useful');
      return;
    }

    const configuredBudget = Number(process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS || '');
    const budgetMs = Number.isFinite(configuredBudget) && configuredBudget > 0
      ? configuredBudget
      : 20000;
    if (budgetMs <= 0) {
      this.recordDescriptionGeneration(enhancedSystemPurpose, 'deterministic', 'ai_skipped', false, 'budget-disabled', budgetMs);
      return;
    }

    const structuralFacts = this.buildAIInterpretationFacts(
      systemName,
      frameworks,
      entryPointSummary,
      databaseEntities,
      externalServices,
      flowGraph,
      domainConcepts,
      systemCapabilities,
      libraryNames
    );

    const elementsEnabled = process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS !== 'false' && process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS !== '0';
    const configuredElementLimit = Number(process.env.KLAURO_AI_ELEMENT_DESCRIPTION_LIMIT || '');
    const elementLimit = Number.isFinite(configuredElementLimit) && configuredElementLimit > 0 ? configuredElementLimit : 8;
    const capabilityTargets = elementsEnabled
      ? systemCapabilities.slice(0, elementLimit).map(capability => this.capabilityDescriptionTarget(capability))
      : [];

    try {
      const aiStartedAt = Date.now();
      let timeoutHandle: NodeJS.Timeout | undefined;
      const raw = await Promise.race([
        aiService.generateComponentDescription({
          additionalContext: {
            task: 'Based only on the structural facts below, return ONLY valid JSON with this shape: {"system_description":"...","domain":"...","descriptions":[{"id":"...","description":"..."}]}. system_description: describe what this software system is and what it does in 2-4 full sentences (at least 150 characters); infer the kind of system from its frameworks, entry points, and capabilities; do not invent features, expand acronyms, or add company names or business domains that are not implied by the facts; mention integrations or external services only by the exact names listed in externalServices, never as unnamed providers. domain: one lowercase kebab-case label of 2 to 4 words naming the primary business domain with concrete product nouns from the facts, never technology or framework names (for example "wedding-venue-booking" or "fleet-compliance-tracking"). descriptions: one entry per item in items, each one grounded sentence answering what that area lets an engineer, operator, user, or AI agent do; translate source areas and operation names into human purpose.',
            style: 'Return only the JSON object. system_description must be a short paragraph, not a list or colon-prefixed facts such as "Key capabilities:", "Data model:", "Entry points:", or "Integrations:"; avoid vague phrases like "interact with data" or "designed to be integrated" and avoid promotional language. Capability descriptions: prefer concrete verbs like centralizes, maintains, tracks, prepares, identifies, evaluates, records, links, validates, or preserves; do not use "operations for", "supports", "coordinates", "handles", "reads", "processes", "internal files", "spans", "insights", "efficient", "compliant", "productivity", "business value", or "streamline"; do not mention files unless the item is literally file storage.',
            primaryDomain: enhancedSystemPurpose.primary_domain,
            coreConcepts: enhancedSystemPurpose.core_concepts,
            deterministicOverview: enhancedSystemPurpose.inferred_description,
            items: capabilityTargets,
            ...structuralFacts,
            ...(unanalyzedLanguages.length > 0 ? {
              unanalyzedLanguages,
              languageCoverageInstruction: `This static analysis covers only the analyzed languages; ${unanalyzedLanguages[0].name} (${unanalyzedLanguages[0].share_of_source}% of source files) was not analyzed. system_description must state that this analysis covers only the analyzed languages and must name ${unanalyzedLanguages[0].name} as the dominant unanalyzed language.`,
            } : {}),
          },
        }),
        new Promise<string>((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error('AI interpretation budget exceeded')), budgetMs);
        }),
      ]);
      if (timeoutHandle) clearTimeout(timeoutHandle);

      const combined = this.parseCombinedInterpretation(raw);
      const interpretationFacts = {
        frameworks,
        libraries: libraryNames,
        databaseEntities,
        externalServices,
        structuralTokens: this.structuralGroundingTokens(systemName, structuralFacts, databaseEntities),
      };
      const domainCandidates: string[] = [];
      if (combined.domain) domainCandidates.push(combined.domain);

      let cleaned = this.cleanGeneratedDescriptionText(combined.systemDescription || '');
      let validation = this.validateAIInterpretation(cleaned, enhancedSystemPurpose, interpretationFacts);
      if (!validation.ok) {
        const sanitized = this.sanitizeAIInterpretation(cleaned, enhancedSystemPurpose, interpretationFacts);
        const sanitizedValidation = this.validateAIInterpretation(sanitized, enhancedSystemPurpose, interpretationFacts);
        if (sanitizedValidation.ok) {
          cleaned = sanitized;
          validation = sanitizedValidation;
        }
      }

      const acceptedElements = new Map<string, string>();
      const rejectedElements = new Map<string, string>();
      for (const target of capabilityTargets) {
        const candidate = combined.elements.get(target.id);
        const elementValidation = candidate
          ? this.validateElementDescription(candidate, target)
          : { ok: false as const, reason: 'missing-description' };
        if (elementValidation.ok && candidate) acceptedElements.set(target.id, candidate);
        else rejectedElements.set(target.id, elementValidation.reason || 'generated-description-failed-quality-gate');
      }

      if ((!validation.ok || rejectedElements.size > 0) && Date.now() - aiStartedAt < budgetMs) {
        try {
        const remainingMs = Math.max(1, budgetMs - (Date.now() - aiStartedAt));
        let repairTimeoutHandle: NodeJS.Timeout | undefined;
        const repairRaw = await Promise.race([
          aiService.generateComponentDescription({
            additionalContext: {
              task: 'Repair the rejected parts of the previous answer. Return ONLY valid JSON with the same shape: {"system_description":"...","domain":"...","descriptions":[{"id":"...","description":"..."}]}. Fix only what was rejected: write a grounded 2-3 full-sentence system_description (at least 150 characters) if it was rejected, and one grounded sentence per rejected item. Mention integrations or external services only by the exact names listed in externalServices; if none are listed, do not mention integrations at all.',
              style: 'No markdown. No marketing language. No raw labels like "Key capabilities:" or "Data model:". Do not invent features, company names, domains, compliance, scale, productivity, or user-experience claims beyond the facts.',
              rejected_system_description: validation.ok ? undefined : cleaned,
              system_description_rejection_reason: validation.ok ? undefined : validation.reason,
              rejected_items: capabilityTargets
                .filter(target => rejectedElements.has(target.id))
                .map(target => ({ ...target, rejection_reason: rejectedElements.get(target.id) })),
              primaryDomain: enhancedSystemPurpose.primary_domain,
              coreConcepts: enhancedSystemPurpose.core_concepts,
              deterministicOverview: enhancedSystemPurpose.inferred_description,
              ...structuralFacts,
            },
          }),
          new Promise<string>((_, reject) => {
            repairTimeoutHandle = setTimeout(() => reject(new Error('AI interpretation repair budget exceeded')), remainingMs);
          }),
        ]);
        if (repairTimeoutHandle) clearTimeout(repairTimeoutHandle);
        const repaired = this.parseCombinedInterpretation(repairRaw);
        if (repaired.domain) domainCandidates.push(repaired.domain);
        if (!validation.ok) {
          let repairedDescription = this.cleanGeneratedDescriptionText(repaired.systemDescription || '');
          let repairedValidation = this.validateAIInterpretation(repairedDescription, enhancedSystemPurpose, interpretationFacts);
          if (!repairedValidation.ok) {
            const sanitizedRepair = this.sanitizeAIInterpretation(repairedDescription, enhancedSystemPurpose, interpretationFacts);
            const sanitizedRepairValidation = this.validateAIInterpretation(sanitizedRepair, enhancedSystemPurpose, interpretationFacts);
            if (sanitizedRepairValidation.ok) {
              repairedDescription = sanitizedRepair;
              repairedValidation = sanitizedRepairValidation;
            }
          }
          if (repairedValidation.ok) {
            cleaned = repairedDescription;
            validation = repairedValidation;
          }
        }
        for (const target of capabilityTargets) {
          if (acceptedElements.has(target.id)) continue;
          const candidate = repaired.elements.get(target.id);
          if (candidate && this.validateElementDescription(candidate, target).ok) {
            acceptedElements.set(target.id, candidate);
            rejectedElements.delete(target.id);
          }
        }
        } catch (repairError) {
          const repairMessage = repairError instanceof Error ? repairError.message : String(repairError);
          console.error(`[Klauro] AI interpretation repair skipped (${repairMessage}); keeping first-pass results`);
        }
      }

      if (validation.ok) {
        enhancedSystemPurpose.inferred_description = cleaned;
        this.recordDescriptionGeneration(enhancedSystemPurpose, 'ai', 'ai_applied', true, undefined, budgetMs);
        AnalyzerOrchestrator.aiInterpretationTimeouts = 0;
        console.error('[Klauro] AI interpretation applied to system description');
      } else {
        this.recordDescriptionGeneration(enhancedSystemPurpose, 'deterministic', 'ai_rejected', true, validation.reason || 'generated-description-failed-quality-gate', budgetMs);
        console.error('[Klauro] AI interpretation result unusable; keeping heuristic description');
      }

      for (const candidate of domainCandidates) {
        const label = this.normalizeAIDomainLabel(candidate);
        if (label && label !== enhancedSystemPurpose.primary_domain && this.isGroundedAIDomainLabel(label, enhancedSystemPurpose)) {
          enhancedSystemPurpose.primary_domain = label;
          enhancedSystemPurpose.domain_source = 'ai';
          console.error(`[Klauro] AI domain label applied: ${label}`);
          break;
        }
      }

      for (const target of capabilityTargets) {
        const accepted = acceptedElements.get(target.id);
        if (accepted) {
          this.applyElementDescription(target.id, accepted, systemCapabilities, [], 'ai', 'ai_applied', true, undefined, budgetMs);
          continue;
        }
        const curated = this.curatedElementDescription(target);
        if (curated) {
          this.applyElementDescription(target.id, curated, systemCapabilities, [], 'manual', 'deterministic_kept', true, 'curated-product-capability-description', budgetMs);
        } else {
          this.applyElementDescription(target.id, undefined, systemCapabilities, [], 'deterministic', 'ai_rejected', true, rejectedElements.get(target.id) || 'generated-description-failed-quality-gate', budgetMs);
        }
      }
      if (elementsEnabled && systemCapabilities.length > capabilityTargets.length) {
        this.recordElementDescriptionGenerationByIds(
          systemCapabilities.slice(elementLimit).map(capability => capability.id),
          systemCapabilities,
          [],
          'deterministic',
          'ai_skipped',
          false,
          'manual-trigger-only',
          budgetMs
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/budget exceeded|timed out|timeout/i.test(message)) {
        AnalyzerOrchestrator.aiInterpretationTimeouts += 1;
        const threshold = Number(process.env.KLAURO_AI_INTERPRETATION_TIMEOUT_THRESHOLD || '3');
        const cooldownMs = Number(process.env.KLAURO_AI_INTERPRETATION_COOLDOWN_MS || '60000');
        if (AnalyzerOrchestrator.aiInterpretationTimeouts >= Math.max(1, threshold)) {
          AnalyzerOrchestrator.aiInterpretationDisabledUntil = Date.now() + Math.max(0, cooldownMs);
          console.error(`[Klauro] AI interpretation cooldown enabled after ${AnalyzerOrchestrator.aiInterpretationTimeouts} timeouts`);
        }
      }
      this.recordDescriptionGeneration(enhancedSystemPurpose, 'deterministic', 'ai_failed', true, message, budgetMs);
      if (capabilityTargets.length > 0) {
        this.recordElementDescriptionGenerationByIds(capabilityTargets.map(target => target.id), systemCapabilities, [], 'deterministic', 'ai_failed', true, message, budgetMs);
      }
      console.error(`[Klauro] AI interpretation skipped (${message}); keeping heuristic description`);
    }
  }

  private structuralGroundingTokens(
    systemName: string,
    structuralFacts: Record<string, unknown>,
    databaseEntities: string[]
  ): string[] {
    const tokens = new Set<string>();
    const sources = [
      systemName,
      ...((structuralFacts.capabilities as string[]) || []),
      ...((structuralFacts.domainConcepts as string[]) || []),
      ...databaseEntities,
    ];
    for (const value of sources) {
      for (const token of String(value || '')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)) {
        if (token.length >= 4 && !this.isGenericCapabilityToken(token)) tokens.add(token);
      }
    }
    return [...tokens];
  }

  private parseCombinedInterpretation(raw: string): { systemDescription?: string; domain?: string; elements: Map<string, string> } {
    const elements = this.parseDescriptionBatch(raw) || new Map<string, string>();
    const text = (raw || '').trim();
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || text;
    const first = fenced.indexOf('{');
    const last = fenced.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        const parsed = JSON.parse(fenced.slice(first, last + 1));
        return {
          systemDescription: typeof parsed?.system_description === 'string' ? parsed.system_description : undefined,
          domain: typeof parsed?.domain === 'string' ? parsed.domain : undefined,
          elements,
        };
      } catch {
        return { systemDescription: text || undefined, domain: undefined, elements };
      }
    }
    return { systemDescription: text || undefined, domain: undefined, elements };
  }

  private normalizeAIDomainLabel(raw: string): string | undefined {
    const cleaned = this.cleanGeneratedDescriptionText(raw)
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .trim();
    const tokens = cleaned.split(/[\s-]+/).filter(Boolean);
    if (tokens.length < 2 || tokens.length > 4) return undefined;
    if (tokens.some(token => token.length < 3 || token.length > 24)) return undefined;
    return tokens.join('-');
  }

  private isGroundedAIDomainLabel(label: string, enhancedSystemPurpose: EnhancedSystemPurpose): boolean {
    const genericTokens = new Set([
      'system', 'software', 'application', 'app', 'platform', 'service', 'services', 'tool', 'tools',
      'portal', 'web', 'site', 'management', 'operations', 'solution', 'solutions', 'product',
      'business', 'data', 'digital', 'online', 'general', 'misc', 'unknown',
    ]);
    const tokens = label.split('-');
    const meaningful = tokens.filter(token => !genericTokens.has(token));
    if (meaningful.length === 0) return false;
    const groundingText = [
      enhancedSystemPurpose.inferred_description,
      enhancedSystemPurpose.primary_domain,
      ...(enhancedSystemPurpose.core_concepts || []),
    ].join(' ').toLowerCase();
    return meaningful.every(token => groundingText.includes(token.slice(0, Math.min(6, token.length))));
  }

  private hasAIInterpretationProviderConfigured(): boolean {
    const freshConfig = getAIConfig();
    return Boolean(
      freshConfig.openai.apiKey ||
      freshConfig.anthropic.apiKey ||
      process.env.AI_LOCAL_ENABLED === 'true'
    );
  }

  private configuredAiInterpretationProviders(): string[] {
    const freshConfig = getAIConfig();
    const providers: string[] = [];
    if (freshConfig.openai.apiKey) providers.push('openai');
    if (freshConfig.anthropic.apiKey) providers.push('anthropic');
    if (process.env.AI_LOCAL_ENABLED === 'true') providers.push('local');
    return providers;
  }

  private async applyAIElementDescriptions(
    capabilities: SystemCapability[],
    entities: CASDataEntity[],
    context: {
      systemName: string;
      enhancedSystemPurpose?: EnhancedSystemPurpose;
      projectTextSignal?: ProjectTextSignal;
      frameworks?: string[];
      includeEntities?: boolean;
    }
  ): Promise<void> {
    const allTargets = [
      ...capabilities.map(capability => this.capabilityDescriptionTarget(capability)),
      ...(context.includeEntities ? entities.map(entity => this.entityDescriptionTarget(entity)) : []),
    ];
    const configuredLimit = Number(process.env.KLAURO_AI_ELEMENT_DESCRIPTION_LIMIT || '');
    const targets = Number.isFinite(configuredLimit) && configuredLimit > 0
      ? allTargets.slice(0, configuredLimit)
      : allTargets;

    if (targets.length === 0) return;

    if (process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS === 'false' || process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS === '0') {
      this.recordElementDescriptionGeneration(capabilities, entities, 'deterministic', 'ai_skipped', false, 'disabled-by-env');
      return;
    }
    if (!aiConfig.features.naturalLanguageDescriptions) {
      this.recordElementDescriptionGeneration(capabilities, entities, 'deterministic', 'ai_skipped', false, 'feature-disabled');
      return;
    }
    if (!this.hasAIInterpretationProviderConfigured()) {
      this.recordElementDescriptionGeneration(capabilities, entities, 'deterministic', 'ai_skipped', false, 'no-ai-provider-configured');
      return;
    }

    const configuredBudget = Number(process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BUDGET_MS || '');
    const budgetMs = Number.isFinite(configuredBudget) && configuredBudget > 0
      ? configuredBudget
      : 15000;
    if (budgetMs <= 0) {
      this.recordElementDescriptionGeneration(capabilities, entities, 'deterministic', 'ai_skipped', false, 'budget-disabled', budgetMs);
      return;
    }

    const startedAt = Date.now();
    const batchSize = Math.max(1, Math.min(12, Number(process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BATCH_SIZE || '4')));
    const byId = new Map<string, DescriptionTarget>(targets.map(target => [target.id, target]));

    for (let i = 0; i < targets.length; i += batchSize) {
      if (Date.now() - startedAt >= budgetMs) {
        this.recordElementDescriptionGenerationByIds(targets.slice(i).map(target => target.id), capabilities, entities, 'deterministic', 'ai_skipped', false, 'budget-exhausted', budgetMs);
        break;
      }

      const batch = targets.slice(i, i + batchSize);
      let timeoutHandle: NodeJS.Timeout | undefined;
      try {
        const timeoutPromise = new Promise<string>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error('AI element description budget exceeded')),
            Math.max(1, budgetMs - (Date.now() - startedAt))
          );
        });
        const raw = await Promise.race([
          aiService.generateComponentDescription({
            additionalContext: {
              task: 'Return ONLY valid JSON with this shape: {"descriptions":[{"id":"...","description":"..."}]}. Write one grounded, useful sentence per item. For capabilities, answer: "What does this area let an engineer, operator, user, or AI agent do?" For entities, answer what concept the entity represents in this codebase. Translate source areas and operation names into human purpose; do not restate source areas, command verbs, or file mechanics. For names like Contact Management, Ticket Management, Provider Management, Partner Management, or Patient Management, use the subject noun and explain the record/workflow it owns. Good examples: Contact Management centralizes contact records and communication details used by customer or account workflows. Ticket Management tracks service requests, status, assignment, and follow-up work across support flows. Provider Management maintains provider records and relationships used by protocol, member, or service coordination. Codebase Analysis builds a CAS relationship graph from repository structure so agents can understand entry points, data, tests, risks, and dependencies before editing. Architecture Mapping identifies local patterns, ownership layers, and inventories so agents can place changes in the right architectural boundary. Greenfield Planning compares a proposed product slice against existing capability memory so new projects avoid duplicate concepts and start with coherent architecture. Agent Work Packets turns CAS graph matches, risks, idioms, and tests into a compact coding brief for an AI agent before it edits a repository. Codebase Idiom Guidance extracts local conventions and validates proposed changes against the patterns already used in the repository. Analysis Storage persists CAS outputs, snapshots, incremental state, and compressed artifacts so later MCP calls can reuse prior analysis.',
              style: 'No markdown. Prefer concrete verbs like centralizes, maintains, tracks, prepares, identifies, evaluates, records, links, validates, or preserves. Do not use the words/phrases "capability", "operations for", "supports", "coordinates", "coordinating operations", "handles", "reads", "processes", "reading", "processing", "internal files", "read behavior", "analyze behavior", "read paths", "process paths", "spans", "insights", "Key capabilities", "Data model", "Entry points", "efficient", "compliant", "productivity", "business value", or "streamline". Do not mention files unless the item is literally file storage/upload. Stay factual and do not invent behavior beyond evidence.',
              system: {
                name: context.systemName,
                domain: context.enhancedSystemPurpose?.primary_domain || context.projectTextSignal?.primaryDomain,
                concepts: context.enhancedSystemPurpose?.core_concepts || context.projectTextSignal?.concepts || [],
                description: context.enhancedSystemPurpose?.inferred_description || context.projectTextSignal?.summary,
                frameworks: context.frameworks || [],
              },
              items: batch,
            },
          }),
          timeoutPromise,
        ]);
        if (timeoutHandle) clearTimeout(timeoutHandle);

        const parsed = this.parseDescriptionBatch(raw);
        if (!parsed || parsed.size === 0) {
          this.recordElementDescriptionGenerationByIds(batch.map(target => target.id), capabilities, entities, 'deterministic', 'ai_rejected', true, 'invalid-json-or-empty', budgetMs);
          continue;
        }

        const failedTargets = batch.filter(target => {
          const description = parsed.get(target.id);
          return !description || !this.validateElementDescription(description, byId.get(target.id) || target).ok;
        });
        let repaired: Map<string, string> | null = null;
        if (failedTargets.length > 0 && Date.now() - startedAt < budgetMs) {
          const remainingMs = Math.max(1, budgetMs - (Date.now() - startedAt));
          let repairTimeoutHandle: NodeJS.Timeout | undefined;
          try {
            const repairTimeoutPromise = new Promise<string>((_, reject) => {
              repairTimeoutHandle = setTimeout(
                () => reject(new Error('AI element description repair budget exceeded')),
                remainingMs
              );
            });
            const repairRaw = await Promise.race([
              aiService.generateComponentDescription({
                additionalContext: {
                  task: 'Repair rejected descriptions. Return ONLY valid JSON with this shape: {"descriptions":[{"id":"...","description":"..."}]}. Rewrite each item as one grounded sentence using only the supplied system and item facts. Translate source areas and operation names into human purpose; do not restate source areas, command verbs, or file mechanics. For names like Contact Management, Ticket Management, Provider Management, Partner Management, or Patient Management, use the subject noun and explain the record/workflow it owns. Good examples: Contact Management centralizes contact records and communication details used by customer or account workflows. Ticket Management tracks service requests, status, assignment, and follow-up work across support flows. Provider Management maintains provider records and relationships used by protocol, member, or service coordination. Codebase Analysis builds a CAS relationship graph from repository structure so agents can understand entry points, data, tests, risks, and dependencies before editing. Architecture Mapping identifies local patterns, ownership layers, and inventories so agents can place changes in the right architectural boundary. Greenfield Planning compares a proposed product slice against existing capability memory so new projects avoid duplicate concepts and start with coherent architecture. Agent Work Packets turns CAS graph matches, risks, idioms, and tests into a compact coding brief for an AI agent before it edits a repository. Codebase Idiom Guidance extracts local conventions and validates proposed changes against the patterns already used in the repository. Analysis Storage persists CAS outputs, snapshots, incremental state, and compressed artifacts so later MCP calls can reuse prior analysis.',
                  style: 'No markdown. Prefer concrete verbs like centralizes, maintains, tracks, prepares, identifies, evaluates, records, links, validates, or preserves. Avoid vague words like "functionality", "module", "component", "various", "robust", "efficient", "business value", "compliant", "insights", or "streamline". Do not use "supports", "coordinates", "coordinating operations", "handles", "reads", "processes", "reading", "processing", "read behavior", "analyze behavior", "read paths", "process paths", "spans", "coordinates internal files", or "supports tasks". Do not invent outcomes or behavior beyond evidence. Name the concrete responsibility implied by the item name, domains, entities, source areas, and operations.',
                  system: {
                    name: context.systemName,
                    domain: context.enhancedSystemPurpose?.primary_domain || context.projectTextSignal?.primaryDomain,
                    concepts: context.enhancedSystemPurpose?.core_concepts || context.projectTextSignal?.concepts || [],
                    description: context.enhancedSystemPurpose?.inferred_description || context.projectTextSignal?.summary,
                    frameworks: context.frameworks || [],
                  },
                  items: failedTargets.map(target => ({
                    ...target,
                    rejected_description: parsed.get(target.id),
                    rejection_reason: this.validateElementDescription(parsed.get(target.id) || '', byId.get(target.id) || target).reason,
                  })),
                },
              }),
              repairTimeoutPromise,
            ]);
            repaired = this.parseDescriptionBatch(repairRaw);
          } catch {
            repaired = null;
          } finally {
            if (repairTimeoutHandle) clearTimeout(repairTimeoutHandle);
          }
        }

        const individualRepairs = new Map<string, string>();
        for (const target of failedTargets) {
          const originalDescription = parsed.get(target.id);
          const repairedDescription = repaired?.get(target.id);
          const repairedValidation = repairedDescription
            ? this.validateElementDescription(repairedDescription, byId.get(target.id) || target)
            : { ok: false, reason: 'no-batch-repair' };
          if (repairedValidation.ok || Date.now() - startedAt >= budgetMs) continue;

          let individualTimeoutHandle: NodeJS.Timeout | undefined;
          try {
            const remainingMs = Math.max(1, budgetMs - (Date.now() - startedAt));
            const individualRaw = await Promise.race([
              aiService.generateComponentDescription({
                additionalContext: {
                  task: 'Return ONLY valid JSON with this shape: {"descriptions":[{"id":"...","description":"..."}]}. Rewrite this one rejected item as a grounded sentence. Say what the named area lets an engineer, operator, user, or AI agent do. If the name ends in Management, use the subject noun and describe the record, lifecycle, workflow, or relationship it owns. Do not list operations, source files, command verbs, or implementation mechanics.',
                  style: 'No markdown. Prefer concrete verbs like centralizes, maintains, tracks, prepares, identifies, evaluates, records, links, validates, or preserves. Do not use "supports", "coordinates", "coordinating", "handles", "reads", "processes", "reading", "processing", "spans", "paths", "operations", "functionality", "insights", or marketing language. Use only the supplied facts.',
                  system: {
                    name: context.systemName,
                    domain: context.enhancedSystemPurpose?.primary_domain || context.projectTextSignal?.primaryDomain,
                    concepts: context.enhancedSystemPurpose?.core_concepts || context.projectTextSignal?.concepts || [],
                    description: context.enhancedSystemPurpose?.inferred_description || context.projectTextSignal?.summary,
                    frameworks: context.frameworks || [],
                  },
                  item: target,
                  rejected_description: originalDescription,
                  rejection_reason: this.validateElementDescription(originalDescription || '', byId.get(target.id) || target).reason,
                  bad_examples: [
                    `${target.name} covers read, analyze paths; spans source files.`,
                    `${target.name} handles operations for internal files.`,
                  ],
                  good_examples: [
                    'Contact Management centralizes contact records and communication details used by customer or account workflows.',
                    'Ticket Management tracks service requests, status, assignment, and follow-up work across support flows.',
                    'Provider Management maintains provider records and relationships used by protocol, member, or service coordination.',
                    'Codebase Analysis builds a CAS relationship graph from repository structure so agents can understand entry points, data, tests, risks, and dependencies before editing.',
                    'Architecture Mapping identifies local patterns, ownership layers, and inventories so agents can place changes in the right architectural boundary.',
                    'Greenfield Planning compares a proposed product slice against existing capability memory so new projects avoid duplicate concepts and start with coherent architecture.',
                    'Agent Work Packets turns CAS graph matches, risks, idioms, and tests into a compact coding brief before an AI agent edits a repository.',
                    'Codebase Idiom Guidance identifies local conventions and validates proposed changes against the patterns already used in the repository.',
                  ],
                },
              }),
              new Promise<string>((_, reject) => {
                individualTimeoutHandle = setTimeout(
                  () => reject(new Error('AI element description individual repair budget exceeded')),
                  remainingMs
                );
              }),
            ]);
            const individualParsed = this.parseDescriptionBatch(individualRaw);
            const individualDescription = individualParsed?.get(target.id);
            if (individualDescription && this.validateElementDescription(individualDescription, byId.get(target.id) || target).ok) {
              individualRepairs.set(target.id, individualDescription);
            }
          } catch {
            // Fall through to deterministic retention with the existing rejection reason.
          } finally {
            if (individualTimeoutHandle) clearTimeout(individualTimeoutHandle);
          }
        }

        for (const target of batch) {
          const originalDescription = parsed.get(target.id);
          const originalValidation = originalDescription
            ? this.validateElementDescription(originalDescription, byId.get(target.id) || target)
            : { ok: false, reason: 'missing-description' };
          const repairedDescription = originalValidation.ok ? undefined : repaired?.get(target.id);
          const repairedValidation = repairedDescription
            ? this.validateElementDescription(repairedDescription, byId.get(target.id) || target)
            : { ok: false, reason: originalValidation.reason || 'generated-description-failed-quality-gate' };
          const individualDescription = originalValidation.ok || repairedValidation.ok ? undefined : individualRepairs.get(target.id);
          const curatedDescription = originalValidation.ok || repairedValidation.ok || individualDescription
            ? undefined
            : this.curatedElementDescription(target);
          const description = originalValidation.ok ? originalDescription : repairedValidation.ok ? repairedDescription : individualDescription || curatedDescription;
          if (description) {
            this.applyElementDescription(
              target.id,
              description,
              capabilities,
              entities,
              curatedDescription && description === curatedDescription ? 'manual' : 'ai',
              curatedDescription && description === curatedDescription ? 'deterministic_kept' : 'ai_applied',
              true,
              curatedDescription && description === curatedDescription ? 'curated-product-capability-description' : undefined,
              budgetMs
            );
          } else {
            this.applyElementDescription(target.id, undefined, capabilities, entities, 'deterministic', 'ai_rejected', true, repairedValidation.reason || 'generated-description-failed-quality-gate', budgetMs);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.recordElementDescriptionGenerationByIds(batch.map(target => target.id), capabilities, entities, 'deterministic', 'ai_failed', true, message, budgetMs);
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    }
  }

  private capabilityDescriptionTarget(capability: SystemCapability): DescriptionTarget {
    return {
      id: capability.id,
      name: capability.name,
      kind: 'capability',
      currentDescription: capability.description,
      category: capability.category,
      operations: capability.operations.slice(0, 8).map(operation =>
        [operation.action, operation.entry_point_type, operation.path_or_command].filter(Boolean).join(' ')
      ),
      relatedEntities: capability.related_entities,
      relatedDomains: capability.related_domains,
    };
  }

  private curatedElementDescription(target: DescriptionTarget): string | undefined {
    if (target.kind !== 'capability') return undefined;
    const key = target.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const descriptions: Record<string, string> = {
      'file workflow': 'Infrastructure Definition captures resource files, variables, modules, and provider relationships so agents can understand what cloud resources the stack manages.',
    };
    if (this.isKlauroSelfProject(this.activeAnalysisProjectPath)) {
      Object.assign(descriptions, KLAURO_SELF_CAPABILITY_DESCRIPTIONS);
    }
    if (descriptions[key]) return descriptions[key];

    const managementSubject = key.replace(/\bmanagement\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (managementSubject) {
      const subjectTokens = managementSubject
        .split(/\s+/)
        .map(token => this.normalizeDomainToken(token))
        .filter(token => token && !this.isGenericCapabilityToken(token));
      if (subjectTokens.length > 0) {
        const subject = this.humanizeDomainKey(subjectTokens.join(' ')).toLowerCase();
        const domain = target.relatedDomains?.[0] && !this.isGenericCapabilityToken(target.relatedDomains[0])
          ? this.humanizeDomainKey(target.relatedDomains[0]).toLowerCase()
          : 'the surrounding product';
        return `${this.humanizeDomainKey(subjectTokens.join(' '))} Management maintains ${subject} records, workflows, and relationships used by ${domain} behavior.`;
      }
    }
    return undefined;
  }

  private entityDescriptionTarget(entity: CASDataEntity): DescriptionTarget {
    return {
      id: entity.id,
      name: entity.name,
      kind: 'entity',
      currentDescription: entity.description,
      source: entity.schema_source,
      fields: (entity.fields || []).slice(0, 12).map(field => `${field.name}:${field.type}${field.is_sensitive ? ':sensitive' : ''}`),
      lifecycle: {
        creates: entity.lifecycle.created_by.length,
        reads: entity.lifecycle.read_by.length,
        updates: entity.lifecycle.updated_by.length,
        deletes: entity.lifecycle.deleted_by.length,
      },
    };
  }

  private parseDescriptionBatch(raw: string): Map<string, string> | null {
    const text = (raw || '').trim();
    if (!text) return null;
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || text;
    const first = fenced.indexOf('{');
    const last = fenced.lastIndexOf('}');
    if (first < 0 || last <= first) return null;

    try {
      const parsed = JSON.parse(fenced.slice(first, last + 1));
      const descriptions = Array.isArray(parsed?.descriptions) ? parsed.descriptions : [];
      const result = new Map<string, string>();
      for (const item of descriptions) {
        if (typeof item?.id === 'string' && typeof item?.description === 'string') {
          result.set(item.id, this.cleanGeneratedDescriptionText(item.description));
        }
      }
      return result;
    } catch {
      return null;
    }
  }

  private isUsefulElementDescription(description: string, target: DescriptionTarget): boolean {
    return this.validateElementDescription(description, target).ok;
  }

  private validateElementDescription(description: string, target: DescriptionTarget): { ok: boolean; reason?: string } {
    const cleaned = this.cleanGeneratedDescriptionText(description);
    if (cleaned.length < 50) return { ok: false, reason: 'too-short' };
    if (cleaned.length > 420) return { ok: false, reason: 'too-long' };
    if (/\*\*|`|^#+\s/m.test(cleaned)) return { ok: false, reason: 'markdown-formatting' };
    if (/\b(operations for|functionality|centers on|graph endpoint|graph structure|coordinat(?:e|es|ing) operations|(?:read|process|coordinate|analyze|delete) behavior|(?:read|process|analyze|delete) paths?|coordinates? internal files|internal files|supports? tasks|agent-driven operations|operations and insights|quality of description analysis|review and understanding|Key capabilities|Data model|Entry points|Integrations):?\b/i.test(cleaned) ||
      /\b(?:supports?|coordinates?|reads?|processes?|handles?|spans)\b/i.test(cleaned) ||
      /\bby\s+(?:reading|processing|coordinating|handling)\b/i.test(cleaned)) {
      return { ok: false, reason: 'generic-structural-phrase' };
    }
    if (/\b(seamless(?:ly)?|robust|comprehensive|various|crucial role|plays a key role|efficient(?:ly)?|efficiency|productivity|compliant|compliance|advanced|streamline(?:s|d|ing)?|user-friendly|business value|improving operational|enhanc(?:e|es|ing)|better understanding|insights(?: into)?|structured data and insights|reduces? costs?|best practices|scalable|secure by design|user experience)\b/i.test(cleaned)) {
      return { ok: false, reason: 'unsupported-marketing-language' };
    }
    const groundedTokens = [
      ...target.name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/),
      ...(target.relatedDomains || []),
      ...(target.fields || []).map(field => field.split(':')[0]),
    ]
      .map(token => this.normalizeDomainToken(token.toLowerCase()))
      .filter(token => token.length > 2 && !this.isGenericCapabilityToken(token));
    if (groundedTokens.length === 0) return { ok: true };
    const lower = description.toLowerCase();
    if (!groundedTokens.some(token => lower.includes(token))) return { ok: false, reason: 'target-not-grounded' };
    return { ok: true };
  }

  private cleanGeneratedDescriptionText(description: string): string {
    return (description || '')
      .replace(/^```(?:text|markdown|json)?/i, '')
      .replace(/```$/i, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/^#+\s*/gm, '')
      .replace(/^\s*[-*]\s+/gm, '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/`/g, '')
      .replace(/\banaly[sz]e and interact with (?:the )?data\b/gi, 'analyze and query the resulting graph')
      .replace(/\binteract with (?:the )?data\b/gi, 'query the resulting graph')
      .replace(/\bdesigned to be integrated with\b/gi, 'exposed through')
      .replace(/\s*\n+\s*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^["']|["']$/g, '')
      .trim();
  }

  private recordElementDescriptionGeneration(
    capabilities: SystemCapability[],
    entities: CASDataEntity[],
    source: 'deterministic' | 'ai' | 'manual' | 'reused',
    status: CASDescriptionGeneration['status'],
    attempted: boolean,
    reason?: string,
    budgetMs?: number
  ): void {
    this.recordElementDescriptionGenerationByIds(
      [...capabilities.map(capability => capability.id), ...entities.map(entity => entity.id)],
      capabilities,
      entities,
      source,
      status,
      attempted,
      reason,
      budgetMs
    );
  }

  private recordElementDescriptionGenerationByIds(
    ids: string[],
    capabilities: SystemCapability[],
    entities: CASDataEntity[],
    source: 'deterministic' | 'ai' | 'manual' | 'reused',
    status: CASDescriptionGeneration['status'],
    attempted: boolean,
    reason?: string,
    budgetMs?: number
  ): void {
    for (const id of ids) {
      this.applyElementDescription(id, undefined, capabilities, entities, source, status, attempted, reason, budgetMs);
    }
  }

  private applyElementDescription(
    id: string,
    description: string | undefined,
    capabilities: SystemCapability[],
    entities: CASDataEntity[],
    source: 'deterministic' | 'ai' | 'manual' | 'reused',
    status: CASDescriptionGeneration['status'],
    attempted: boolean,
    reason?: string,
    budgetMs?: number
  ): void {
    const target = capabilities.find(capability => capability.id === id) || entities.find(entity => entity.id === id);
    if (!target) return;
    if (description) {
      target.description = description;
    }
    target.description_source = source;
    target.description_generation = {
      status,
      attempted,
      reason,
      budget_ms: Number.isFinite(budgetMs) ? budgetMs : undefined,
      generated_at: new Date().toISOString(),
    };
  }

  private recordDescriptionGeneration(
    enhancedSystemPurpose: EnhancedSystemPurpose,
    source: NonNullable<EnhancedSystemPurpose['description_source']>,
    status: NonNullable<EnhancedSystemPurpose['description_generation']>['status'],
    attempted: boolean,
    reason?: string,
    budgetMs?: number
  ): void {
    enhancedSystemPurpose.description_source = source;
    enhancedSystemPurpose.description_generation = {
      status,
      attempted,
      reason,
      budget_ms: Number.isFinite(budgetMs) ? budgetMs : undefined,
      generated_at: new Date().toISOString(),
    };
  }

  private buildAnalysisPhases(input: {
    hasAIProvider: boolean;
    systemDescriptionSource?: string;
    capabilityDescriptionSource?: string;
    embeddingEnabled: boolean;
    runtimeSignals: number;
  }): CASAnalysisPhase[] {
    const generatedAt = new Date().toISOString();
    return [
      {
        id: 'core-graph',
        name: 'Core relationship graph',
        priority: 1,
        status: 'complete',
        purpose: 'visualization',
        default_phase: true,
        description: 'Builds the nodes, edges, entry points, exit points, layers, inventory, and system shape needed to see the codebase.',
        outputs: ['nodes', 'edges', 'entry_points', 'exit_points', 'architecture_summary', 'progressive_levels'],
        agent_value: 'Lets agents orient through the graph before reading files.',
        visualization_value: 'Provides the first usable codebase map and drilldown structure.',
        can_run_later: false,
        generated_at: generatedAt,
      },
      {
        id: 'agent-context',
        name: 'Agent work context',
        priority: 2,
        status: 'complete',
        purpose: 'agent-development',
        default_phase: true,
        description: 'Adds capabilities, domains, flows, tests, risks, idioms, and behavioral invariants used to plan and validate edits.',
        outputs: ['system_capabilities', 'domain_concepts', 'flow_graph', 'call_chains', 'test_suites', 'change_risks', 'codebase_idioms', 'behavioral_invariants'],
        agent_value: 'Supplies work packets, risk checks, idiom guidance, and test targeting.',
        visualization_value: 'Shows what the system does and which areas are risky or important.',
        can_run_later: false,
        generated_at: generatedAt,
      },
      {
        id: 'ai-system-narrative',
        name: 'AI system and capability descriptions',
        priority: 3,
        status: input.hasAIProvider
          ? (input.systemDescriptionSource === 'ai' || input.capabilityDescriptionSource === 'ai' ? 'complete' : 'partial')
          : 'deferred',
        purpose: 'ai-enrichment',
        default_phase: true,
        description: 'Uses AI to turn the structural CAS facts into the system overview and primary capability descriptions.',
        outputs: ['enhanced_system_purpose.inferred_description', 'system_capabilities.description'],
        agent_value: 'Gives agents a compact, human-readable summary of what matters without scanning raw graph facts.',
        visualization_value: 'Turns the overview and primary capability cards into explanations rather than labels.',
        can_run_later: true,
        requires_ai: true,
        generated_at: generatedAt,
        notes: input.hasAIProvider ? undefined : ['No AI provider is configured; deterministic descriptions were retained.'],
      },
      {
        id: 'deferred-element-descriptions',
        name: 'Manual element descriptions',
        priority: 4,
        status: 'deferred',
        purpose: 'ai-enrichment',
        default_phase: false,
        description: 'Generates AI descriptions for individual nodes, services, entities, capabilities, entry points, or exit points only when explicitly requested.',
        outputs: ['nodes.description', 'data_entities.description', 'entry_points.description', 'exit_points.description'],
        agent_value: 'Lets agents ask for focused explanations of a target without paying token cost for the whole graph.',
        visualization_value: 'Populates drilldown pages on demand and invalidates stale text when source fingerprints change.',
        can_run_later: true,
        requires_ai: true,
        generated_at: generatedAt,
      },
      {
        id: 'semantic-runtime-context',
        name: 'Semantic and runtime context',
        priority: 5,
        status: input.embeddingEnabled || input.runtimeSignals > 0 ? 'partial' : 'deferred',
        purpose: 'deep-context',
        default_phase: false,
        description: 'Adds heavier retrieval and runtime correlation data after the core graph is already usable.',
        outputs: ['embedding_index', 'runtime', 'runtime_static_links'],
        agent_value: 'Improves retrieval, bug triage, and production-informed prioritization when available.',
        visualization_value: 'Adds runtime heat, traces, and semantic search to deeper views.',
        can_run_later: true,
        generated_at: generatedAt,
      },
    ];
  }

  private shouldKeepDeterministicSystemDescription(enhancedSystemPurpose: EnhancedSystemPurpose): boolean {
    if (process.env.KLAURO_AI_INTERPRETATION_FORCE === 'true' || process.env.KLAURO_AI_INTERPRETATION_FORCE === '1') {
      return false;
    }
    if (process.env.KLAURO_AI_INTERPRETATION_ALLOW_DETERMINISTIC_KEEP !== 'true' &&
      process.env.KLAURO_AI_INTERPRETATION_ALLOW_DETERMINISTIC_KEEP !== '1') {
      return false;
    }
    const description = (enhancedSystemPurpose.inferred_description || '').trim();
    if (description.length < 80 || description.length > 900) return false;
    if (!this.isUsefulAIInterpretation(description, enhancedSystemPurpose)) return false;
    const lower = description.toLowerCase();
    const domain = enhancedSystemPurpose.primary_domain?.toLowerCase();
    const concepts = (enhancedSystemPurpose.core_concepts || [])
      .map(concept => concept.toLowerCase())
      .filter(concept => concept && !this.isGenericDomainToken(concept));
    const mentionedConcepts = concepts.filter(concept => lower.includes(concept)).length;
    const hasDomain = Boolean(domain && domain !== 'unknown' && !this.isGenericDomainToken(domain) &&
      (lower.includes(domain.replace(/-/g, ' ')) || lower.includes(domain)));
    return hasDomain || mentionedConcepts >= 1;
  }

  private isUsefulAIInterpretation(description: string, enhancedSystemPurpose: EnhancedSystemPurpose): boolean {
    return this.validateAIInterpretation(description, enhancedSystemPurpose).ok;
  }

  private validateAIInterpretation(
    description: string,
    enhancedSystemPurpose: EnhancedSystemPurpose,
    facts: { frameworks?: string[]; libraries?: string[]; databaseEntities?: string[]; externalServices?: string[]; structuralTokens?: string[] } = {},
  ): { ok: boolean; reason?: string } {
    const cleaned = this.cleanGeneratedDescriptionText(description);
    if (cleaned.length < 120) return { ok: false, reason: 'too-short' };
    if (cleaned.length > 2000) return { ok: false, reason: 'too-long' };
    if (/AI description generation is disabled/i.test(cleaned)) return { ok: false, reason: 'ai-disabled-message' };
    const lower = cleaned.toLowerCase();
    const domain = enhancedSystemPurpose.primary_domain?.toLowerCase();
    const concepts = (enhancedSystemPurpose.core_concepts || []).map(concept => concept.toLowerCase());
    const groundedTerms = [domain, ...concepts].filter((term): term is string => Boolean(term && term !== 'unknown'));
    if (groundedTerms.length > 0 && !groundedTerms.some(term => lower.includes(term))) {
      const structuralMatches = (facts.structuralTokens || []).filter(token => lower.includes(token)).length;
      if (structuralMatches < 2) {
        return { ok: false, reason: 'not-grounded-in-domain-or-concepts' };
      }
    }
    const marketingLanguagePattern = /\b(seamless(?:ly)?|user experience|entry point for an application|gateway between the frontend and backend|reducing complexity|ecosystem|wide range of clients|robust api|crucial role|scalability|usability|underlying platform|indispensable|unified experience|complex queries|large datasets|high-quality [a-z ]+ experience|regulatory requirements?|best practices|designed for managing|facilitates|various applications|robust [a-z ]*framework|enhanc(?:e|es|ing) (?:the )?[a-z ]*(?:analysis process|security|efficiency|navigation|insights)|allowing developers to focus|complex tasks|structured data and insights|insights(?: into)?|efficient(?:ly)?|efficiency|productivity|compliant|compliance|advanced|streamline(?:s|d|ing)?|user-friendly|business value|improving operational|reduces? costs?|secure by design)\b/gi;
    const marketingMatches = Array.from(new Set(
      (description.match(marketingLanguagePattern) || []).map(match => match.toLowerCase().trim())
    ));
    if (marketingMatches.length > 0) {
      const deterministicOverview = (enhancedSystemPurpose.inferred_description || '').toLowerCase();
      const groundedTokenStems = new Set(
        [...groundedTerms, ...deterministicOverview.split(/[^a-z0-9]+/)]
          .flatMap(term => term.split(/[^a-z0-9]+/))
          .filter(token => token.length >= 4)
          .map(token => token.slice(0, 8))
      );
      const ungroundedMarketing = marketingMatches.filter(match => {
        const tokens = match.split(/\s+/);
        if (tokens.length > 1) {
          return !groundedTerms.some(term => term.includes(match)) && !deterministicOverview.includes(match);
        }
        return !groundedTokenStems.has(tokens[0].slice(0, 8));
      });
      if (ungroundedMarketing.length > 0) {
        return { ok: false, reason: `unsupported-marketing-language: ${ungroundedMarketing.join(', ')}` };
      }
    }
    if (/\*\*|^#+\s/m.test(description)) {
      return { ok: false, reason: 'markdown-formatting' };
    }
    if (/\bprimary interface for interacting with (?:the )?(?:application'?s )?database\b/i.test(description) ||
      /\bintermediary between the frontend ui and the server-side logic\b/i.test(description) ||
      /\binteract(?:s|ing)? with (?:the )?data\b/i.test(description) ||
      /\bdesigned to be integrated with\b/i.test(description)) {
      return { ok: false, reason: 'generic-architecture-cliche' };
    }
    if (/\b(command-line interface|coupons?|discounts?|user data)\b/i.test(description) &&
      !groundedTerms.some(term => /\b(command|cli|coupon|discount|user)\b/i.test(term))) {
      return { ok: false, reason: 'unsupported-domain-claim' };
    }
    if (/\b[A-Z]{2,}\s*\([A-Z][^)]+\)/.test(description)) {
      return { ok: false, reason: 'unsupported-acronym-expansion' };
    }
    if (/\btesting\b/i.test(description) && !groundedTerms.some(term => /test|quality|coverage/.test(term))) {
      return { ok: false, reason: 'unsupported-testing-claim' };
    }
    if (/\b(dapp|decentralized application|miner|mining|mine tokens?)\b/i.test(description) &&
      !groundedTerms.some(term => /\b(dapp|decentralized|miner|mining)\b/i.test(term))) {
      return { ok: false, reason: 'unsupported-crypto-claim' };
    }
    if (/\bwpf\b[^.]{0,140}\bcross[- ]platform\b/i.test(description)) {
      return { ok: false, reason: 'unsupported-runtime-claim' };
    }
    if (/\b(file\.exists|string\.isnullorempty|math\.abs|console\.|system\.)\b/i.test(description)) {
      return { ok: false, reason: 'low-level-api-pollution' };
    }
    if (/\b(Key capabilities|Data model|Entry points|Integrations):/i.test(description)) {
      return { ok: false, reason: 'raw-fact-list-format' };
    }
    const allowedFrameworks = this.frameworkClaimAllowList(facts);
    const mentionedFrameworks = [
      ['nestjs', /\bnest\s*js\b|\bnestjs\b/i],
      ['fastapi', /\bfastapi\b/i],
      ['react', /\breact\b/i],
      ['expressjs', /\bexpress(?:\.js|js)?\b/i],
      ['nextjs', /\bnext(?:\.js|js)?\b/i],
      ['django', /\bdjango\b/i],
      ['flask', /\bflask\b/i],
      ['laravel', /\blaravel\b/i],
      ['symfony', /\bsymfony\b/i],
      ['springboot', /\bspring boot\b|\bspringboot\b/i],
      ['aspnetcore', /\basp\.?net(?: core)?\b/i],
      ['wpf', /\bwpf\b/i],
      ['flutter', /\bflutter\b/i],
      ['electron', /\belectron\b/i],
      ['vue', /\bvue\b/i],
      ['angular', /\bangular\b/i],
    ].filter(([, pattern]) => (pattern as RegExp).test(cleaned));
    if (mentionedFrameworks.some(([key]) => !this.frameworkClaimIsAllowed(String(key), allowedFrameworks))) {
      return { ok: false, reason: 'unsupported-framework-claim' };
    }
    const integrationsPattern = /\b(external services?|integrations?|integrates with)\b/i;
    const overviewClaimsIntegrations = integrationsPattern.test(enhancedSystemPurpose.inferred_description || '');
    if ((facts.externalServices || []).length === 0 && integrationsPattern.test(cleaned) && !overviewClaimsIntegrations) {
      return { ok: false, reason: 'unsupported-external-service-claim' };
    }
    if (integrationsPattern.test(cleaned) &&
      !this.mentionsKnownExternalService(cleaned, facts.externalServices || []) &&
      !overviewClaimsIntegrations) {
      return { ok: false, reason: 'unnamed-external-service-claim' };
    }
    if ((facts.databaseEntities || []).length === 0 && /\b(relational database|database|data store|stores entities)\b/i.test(cleaned)) {
      return { ok: false, reason: 'unsupported-database-claim' };
    }
    return { ok: true };
  }

  private libraryNamesForInterpretation(libraries: Array<{ name?: string }>): string[] {
    return Array.from(new Set(
      (libraries || [])
        .map(library => String(library?.name || '').trim())
        .filter(Boolean)
    ));
  }

  private frameworkClaimAllowList(facts: { frameworks?: string[]; libraries?: string[] }): string[] {
    return [...(facts.frameworks || []), ...(facts.libraries || [])]
      .map(name => name.toLowerCase().replace(/[^a-z0-9]+/g, ''))
      .filter(Boolean);
  }

  private frameworkClaimIsAllowed(claimKey: string, allowList: string[]): boolean {
    return allowList.some(name =>
      name === claimKey ||
      name.startsWith(claimKey) ||
      (name.length >= 4 && claimKey.startsWith(name))
    );
  }

  private sanitizeAIInterpretation(
    description: string,
    enhancedSystemPurpose: EnhancedSystemPurpose,
    facts: { frameworks?: string[]; libraries?: string[]; databaseEntities?: string[]; externalServices?: string[] } = {},
  ): string {
    const cleaned = this.cleanGeneratedDescriptionText(description)
      .replace(/\bfacilitates\b/gi, 'links')
      .replace(/\buser experience\b/gi, 'interface behavior')
      .replace(/\bgateway between the frontend and backend\b/gi, 'interface between users and backend workflows')
      .replace(/\breducing complexity\b/gi, 'organizing code relationships')
      .replace(/\bwide range of clients\b/gi, 'client workflows')
      .replace(/\brobust api\b/gi, 'API')
      .replace(/\bcrucial role\b/gi, 'role')
      .replace(/\bscalability\b/gi, 'runtime growth')
      .replace(/\busability\b/gi, 'operator use')
      .replace(/\bunderlying platform\b/gi, 'system')
      .replace(/\bindispensable\b/gi, 'important')
      .replace(/\bunified experience\b/gi, 'shared workflow')
      .replace(/\bcomplex queries\b/gi, 'queries')
      .replace(/\blarge datasets\b/gi, 'data sets')
      .replace(/\bhigh-quality [a-z ]+ experience\b/gi, 'interface behavior')
      .replace(/\bregulatory requirements?\b/gi, 'rules')
      .replace(/\bbest practices\b/gi, 'local patterns')
      .replace(/\bdesigned for managing\b/gi, 'manages')
      .replace(/\bvarious applications\b/gi, 'the application')
      .replace(/\benhanc(?:e|es|ing) (?:the )?analysis process\b/gi, 'adds analysis')
      .replace(/\benhanc(?:e|es|ing) (?:the )?navigation\b/gi, 'adds navigation')
      .replace(/\benhanc(?:e|es|ing) (?:the )?insights\b/gi, 'adds graph evidence')
      .replace(/\bstructured data and insights\b/gi, 'structured CAS graph data')
      .replace(/\binsights(?: into)?\b/gi, 'graph evidence for')
      .replace(/\bcomplex tasks\b/gi, 'codebase tasks')
      .replace(/\befficient(?:ly)?\b/gi, '')
      .replace(/\befficiency\b/gi, 'speed')
      .replace(/\badvanced\b/gi, '')
      .replace(/\bstreamline(?:s|d|ing)?\b/gi, 'organizes')
      .replace(/\s+/g, ' ')
      .trim();
    const sentences = cleaned
      .split(/(?<=[.!?])\s+/)
      .map(sentence => sentence.trim())
      .filter(Boolean);
    if (sentences.length <= 1) return cleaned;

    const allowedFrameworks = this.frameworkClaimAllowList(facts);
    const groundedTerms = [
      enhancedSystemPurpose.primary_domain,
      ...(enhancedSystemPurpose.core_concepts || []),
    ]
      .filter((term): term is string => Boolean(term && term !== 'unknown'))
      .map(term => term.toLowerCase());

    const unsupportedFrameworkPatterns: RegExp[] = [
      ['nestjs', /\bnest\s*js\b|\bnestjs\b/i],
      ['fastapi', /\bfastapi\b/i],
      ['react', /\breact\b/i],
      ['expressjs', /\bexpress(?:\.js|js)?\b/i],
      ['nextjs', /\bnext(?:\.js|js)?\b/i],
      ['django', /\bdjango\b/i],
      ['flask', /\bflask\b/i],
      ['laravel', /\blaravel\b/i],
      ['symfony', /\bsymfony\b/i],
      ['springboot', /\bspring boot\b|\bspringboot\b/i],
      ['aspnetcore', /\basp\.?net(?: core)?\b/i],
      ['wpf', /\bwpf\b/i],
      ['flutter', /\bflutter\b/i],
      ['electron', /\belectron\b/i],
      ['vue', /\bvue\b/i],
      ['angular', /\bangular\b/i],
    ]
      .filter(([key]) => !this.frameworkClaimIsAllowed(String(key), allowedFrameworks))
      .map(([, pattern]) => pattern as RegExp);

    const keep = sentences.filter(sentence => {
      if (unsupportedFrameworkPatterns.some(pattern => pattern.test(sentence))) return false;
      if (/\b(external services?|integrations?|integrates with)\b/i.test(sentence) &&
        !this.mentionsKnownExternalService(sentence, facts.externalServices || [])) return false;
      if ((facts.databaseEntities || []).length === 0 && /\b(relational database|database|data store|stores entities)\b/i.test(sentence)) return false;
      if (/\buser data\b/i.test(sentence) && !groundedTerms.some(term => /\buser\b/.test(term))) return false;
      if (/\bdesigned to be integrated with\b/i.test(sentence)) return false;
      if (/\binteract(?:s|ing)? with (?:the )?data\b/i.test(sentence)) return false;
      return true;
    });

    return keep.length === sentences.length ? cleaned : keep.join(' ').trim();
  }

  private mentionsKnownExternalService(text: string, externalServices: string[]): boolean {
    const normalizedText = text.toLowerCase();
    return externalServices
      .map(service => service.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim())
      .filter(service => service.length > 2 && !/^(external service|integration|api|sdk|http|database)$/.test(service))
      .some(service => normalizedText.includes(service) || normalizedText.includes(service.replace(/\s+/g, '')));
  }

  private shouldRefreshAIInterpretation(
    previousOutput: CASOutput,
    systemName: string,
    frameworks: string[],
    entryPointSummary: { type: string; count: number }[],
    databaseEntities: string[],
    externalServices: string[],
    flowGraph: CASFlowGraph,
    domainConcepts: CASDomainConcept[],
    systemCapabilities: SystemCapability[] = []
  ): boolean {
    if (!previousOutput.enhanced_system_purpose?.inferred_description) {
      return true;
    }

    const previousFacts = this.buildAIInterpretationFacts(
      systemName,
      (previousOutput.analyzer_contributions || [])
        .filter(c => c.analyzer_type === 'framework')
        .map(c => c.analyzer_name.replace(' Analyzer', '')),
      this.summarizeEntryPoints(previousOutput.entry_points || []),
      (previousOutput.database_schema?.entities || []).map(entity => entity.name),
      (previousOutput.external_services || []).map(service => service.name),
      previousOutput.flow_graph || this.emptyFlowGraph(),
      previousOutput.domain_concepts || [],
      previousOutput.system_capabilities || []
    );
    const nextFacts = this.buildAIInterpretationFacts(
      systemName,
      frameworks,
      entryPointSummary,
      databaseEntities,
      externalServices,
      flowGraph,
      domainConcepts,
      systemCapabilities
    );

    return JSON.stringify(previousFacts) !== JSON.stringify(nextFacts);
  }

  private buildAIInterpretationFacts(
    systemName: string,
    frameworks: string[],
    entryPointSummary: { type: string; count: number }[],
    databaseEntities: string[],
    externalServices: string[],
    flowGraph: CASFlowGraph,
    domainConcepts: CASDomainConcept[],
    systemCapabilities: SystemCapability[] = [],
    libraryNames: string[] = []
  ): Record<string, unknown> {
    const topCapabilities = (systemCapabilities.length > 0
      ? systemCapabilities
        .slice(0, 8)
        .map(c => c.name.replace(/_/g, ' '))
      : [...flowGraph.capabilities]
        .sort((a, b) => b.signals.total_score - a.signals.total_score)
        .slice(0, 8)
        .map(c => c.name.replace(/_/g, ' ')))
      .filter(name => !this.isGenericCapabilityToken(name.toLowerCase()));

    // Rank concepts core-first, then by frequency. Supporting concepts still
    // fill the list, so the model always receives real domain signal even
    // when few or no concepts reached `core` — without this a thin repo
    // hands the model an empty list and it hallucinates a system identity
    // from the project name alone.
    const conceptPool = domainConcepts
      .filter(c => c.classification !== 'infrastructure')
      .sort((a, b) => {
        const ac = a.classification === 'core' ? 0 : 1;
        const bc = b.classification === 'core' ? 0 : 1;
        if (ac !== bc) return ac - bc;
        return b.frequency - a.frequency;
      })
      .slice(0, 12)
      .map(c => c.name);

    // Test harnesses are not part of what the system *is* — drop `test`
    // entry points so they do not pollute the narrative.
    const meaningfulEntryPoints = entryPointSummary.filter(
      e => e.type !== 'test' && e.count > 0
    );

    return {
      systemName,
      frameworks: frameworks.slice(0, 6),
      libraries: libraryNames.slice(0, 12),
      allowedFrameworks: frameworks.length > 0 ? frameworks.slice(0, 6) : ['none detected'],
      forbiddenFrameworkInstruction: frameworks.length > 0
        ? 'Mention only frameworks in allowedFrameworks or packages in libraries.'
        : libraryNames.length > 0
          ? 'No framework was detected in product code; mention only packages listed in libraries.'
          : 'No framework was detected in product code; do not mention any framework.',
      entryPoints: [...meaningfulEntryPoints].sort((a, b) => a.type.localeCompare(b.type)),
      capabilities: topCapabilities,
      domainConcepts: conceptPool,
      databaseEntities: databaseEntities.slice(0, 15),
      externalServices: externalServices.slice(0, 10),
    };
  }

  private emptyFlowGraph(): CASFlowGraph {
    return {
      capabilities: [],
      dependencies: [],
      topology: {
        root_capabilities: [],
        leaf_capabilities: [],
        critical_path: [],
        max_depth: 0,
      },
      primary_flow: {
        core_capability_id: '',
        value_chain: [],
        supporting_capabilities: [],
        infrastructure_capabilities: [],
      },
      layers: [],
      system_insights: {
        detected_patterns: [],
        primary_entry_type: 'unknown',
        data_flow_type: 'unknown',
      },
    };
  }

  private buildEnhancedSystemPurpose(
    basePurpose: SystemPurpose,
    domainConcepts: CASDomainConcept[],
    workflows: CASWorkflow[],
    workflowGraph: CASWorkflowGraph,
    domainExtractor: DomainExtractor,
    databaseEntities: string[],
    entryPointSummary: { type: string; count: number }[],
    frameworks: string[],
    externalServices: string[],
    systemCapabilities: SystemCapability[],
    flowGraph: CASFlowGraph,
    systemName?: string,
    projectTextSignal: ProjectTextSignal = { concepts: [], evidence: [] },
    nodes: CASNode[] = [],
    projectPath = ''
  ): EnhancedSystemPurpose {
    const coreConcepts = domainExtractor.getCoreConcepts(domainConcepts);
    const inferredPrimaryDomain = this.refinePrimaryDomain(
      domainExtractor.inferPrimaryDomain(domainConcepts),
      systemName,
      systemCapabilities,
      coreConcepts,
      projectTextSignal
    );
    const areaDomains = this.classifyTopLevelAreaDomains(nodes, projectPath);
    const areaResolution = this.reconcilePrimaryDomainWithAreas(inferredPrimaryDomain, areaDomains);
    const primaryDomain = this.refinePrimaryDomainForPurpose(areaResolution.primaryDomain, basePurpose);

    const coreConceptNames = [
      ...projectTextSignal.concepts,
      ...coreConcepts.map(c => c.name),
      ...domainConcepts.slice(0, 25).map(c => c.name),
    ];

    const description = projectTextSignal.summary && (
      projectTextSignal.primaryDomain === primaryDomain ||
      this.shouldPreferProjectTextSummary(primaryDomain, systemCapabilities, flowGraph)
    )
      ? projectTextSignal.summary
      : this.buildQuickDescription(
      basePurpose,
      flowGraph,
      databaseEntities,
      entryPointSummary,
      frameworks,
      externalServices,
      systemCapabilities,
      primaryDomain,
      coreConceptNames
    );

    const supportingWorkflows = workflows.filter(w => w.classification === 'supporting');
    const primaryType = this.refinePurposeTypeForDomain(
      basePurpose.primary_type,
      primaryDomain,
      frameworks,
      entryPointSummary
    );

    return {
      ...basePurpose,
      primary_type: primaryType,
      evidence: [...basePurpose.evidence, ...projectTextSignal.evidence].slice(0, 20),
      primary_domain: primaryDomain,
      ...(areaResolution.secondaryDomains.length > 0 ? { secondary_domains: areaResolution.secondaryDomains } : {}),
      core_concepts: Array.from(new Set(coreConceptNames)).slice(0, 10),
      inferred_description: description,
      description_source: 'deterministic',
      description_generation: {
        status: 'deterministic_initial',
        attempted: false,
        generated_at: new Date().toISOString(),
      },
      primary_workflow_id: workflowGraph.primary_workflow_id,
      supporting_workflow_ids: supportingWorkflows.map(w => w.id)
    };
  }

  private refinePurposeTypeForDomain(
    primaryType: string,
    primaryDomain: string,
    frameworks: string[],
    entryPointSummary: { type: string; count: number }[]
  ): string {
    const frameworkText = frameworks.join(' ').toLowerCase();
    const hasServerFramework = /\b(symfony|laravel|django|fastapi|spring|asp\.?net|nestjs|express)\b/.test(frameworkText);
    const hasBackendEntry = entryPointSummary.some(entry =>
      entry.count > 0 && /^(http|message|event|cli|schedule|websocket)$/.test(entry.type)
    );

    if (primaryDomain === 'fleet-management' && (hasServerFramework || hasBackendEntry)) {
      return 'backend-service';
    }
    if (primaryDomain === 'codebase-analysis' && /^(multiplayer-application|gaming-platform|web-application)$/.test(primaryType)) {
      return 'devtools-platform';
    }
    if (primaryDomain === 'cloud-infrastructure') {
      return 'infrastructure-codebase';
    }
    return primaryType;
  }

  private refinePrimaryDomainForPurpose(domain: string, systemPurpose: SystemPurpose): string {
    const normalizedDomain = (domain || '').toLowerCase();
    if (systemPurpose.primary_type === 'clinical-testing-platform') {
      return this.isGenericDomainToken(normalizedDomain) || this.isClinicalOrDeviceDomain(normalizedDomain)
        ? 'clinical-testing'
        : domain;
    }
    if (systemPurpose.primary_type === 'medical-device-software') {
      return this.isGenericDomainToken(normalizedDomain) || this.isClinicalOrDeviceDomain(normalizedDomain)
        ? 'medical-device'
        : domain;
    }
    if (systemPurpose.primary_type === 'hardware-device-software') {
      return this.isGenericDomainToken(normalizedDomain) || this.isHardwareDeviceDomain(normalizedDomain)
        ? 'hardware-device'
        : domain;
    }
    if (systemPurpose.primary_type === 'content-management') {
      return this.isGenericDomainToken(normalizedDomain) || this.isContentManagementDomain(normalizedDomain)
        ? 'content-management'
        : domain;
    }
    return domain;
  }

  private isContentManagementDomain(domain: string): boolean {
    return /\b(content|cms|publishing|page|pages|editorial|revision|workflow)\b/.test(domain);
  }

  private isClinicalOrDeviceDomain(domain: string): boolean {
    return /\b(clinical|medical|patient|muscle|rehab|device|measurement|protocol|hoggan)\b/.test(domain);
  }

  private isHardwareDeviceDomain(domain: string): boolean {
    return /\b(hardware|device|sensor|firmware|serial|bluetooth|calibration|iot)\b/.test(domain);
  }

  private isNonSemanticDomainLabel(label: string, systemName?: string): boolean {
    const normalized = label.toLowerCase().trim();
    const technologyNames = new Set([
      'jenkins', 'terraform', 'opentofu', 'docker', 'kubernetes', 'k8s', 'helm', 'ansible',
      'gradle', 'maven', 'npm', 'yarn', 'pnpm', 'vite', 'webpack', 'babel', 'eslint', 'prettier',
      'jest', 'pytest', 'github', 'gitlab', 'circleci', 'bitbucket', 'nodejs', 'typescript', 'javascript',
    ]);
    if (technologyNames.has(normalized)) return true;
    const nameTokens = (systemName || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    return nameTokens.includes(normalized);
  }

  private refinePrimaryDomain(
    inferredDomain: string,
    systemName: string | undefined,
    systemCapabilities: SystemCapability[],
    coreConcepts: CASDomainConcept[],
    projectTextSignal: ProjectTextSignal = { concepts: [], evidence: [] }
  ): string {
    const capabilityDomain = this.inferPrimaryDomainFromCapabilities(systemCapabilities, coreConcepts);
    if (capabilityDomain && this.isSpecificStructuralDomain(capabilityDomain, systemCapabilities, coreConcepts, systemName)) {
      return capabilityDomain.toLowerCase().replace(/\s+/g, '-');
    }
    if (projectTextSignal.primaryDomain && !this.isGenericDomainToken(projectTextSignal.primaryDomain)) {
      if ((this.isBroadProjectTextDomain(projectTextSignal.primaryDomain) ||
        this.isNonSemanticDomainLabel(projectTextSignal.primaryDomain, systemName)) && capabilityDomain) {
        return capabilityDomain;
      }
      if (!this.isNonSemanticDomainLabel(projectTextSignal.primaryDomain, systemName)) {
        return projectTextSignal.primaryDomain;
      }
    }

    if (inferredDomain && inferredDomain !== 'unknown' && !this.isGenericDomainToken(inferredDomain)) {
      if ((this.isBroadProjectTextDomain(inferredDomain) ||
        this.isNarrowCrossCuttingDomain(inferredDomain) ||
        this.isNonSemanticDomainLabel(inferredDomain, systemName)) && capabilityDomain) {
        return capabilityDomain;
      }
      if (!this.isNonSemanticDomainLabel(inferredDomain, systemName)) {
        return inferredDomain;
      }
    }

    const concept = coreConcepts.find(candidate =>
      !this.isGenericDomainToken(candidate.name) &&
      !this.isNonSemanticDomainLabel(candidate.name, systemName));
    if (concept) return concept.name.toLowerCase().replace(/\s+/g, '-');

    if (capabilityDomain) return capabilityDomain.toLowerCase().replace(/\s+/g, '-');

    return this.domainFromSystemName(systemName) || inferredDomain || 'unknown';
  }

  private classifyTopLevelAreaDomains(
    nodes: CASNode[],
    projectPath: string
  ): Array<{ area: string; domain: string | null; nodeCount: number; share: number }> {
    const excludedPath = /(^|\/)(node_modules|dist|build|out|coverage|vendor|vendors|generated|fixtures?|__fixtures__|__tests__|__mocks__|tests?|spec|e2e|\.git|\.next|\.turbo|\.cache|\.terraform)(\/|$)/;
    const testFile = /\.(test|spec|stories|story)\./;
    const areas = new Map<string, { nodeCount: number; terraformNodes: number; names: string[] }>();
    const root = projectPath.replace(/\\/g, '/').replace(/\/+$/, '');
    let productNodeCount = 0;
    for (const node of nodes) {
      const rawFile = node.source?.file;
      if (!rawFile) continue;
      let file = rawFile.replace(/\\/g, '/');
      if (root && file.startsWith(`${root}/`)) file = file.slice(root.length + 1);
      if (file.startsWith('/')) continue;
      if (excludedPath.test(file) || testFile.test(file)) continue;
      productNodeCount += 1;
      const segments = file.split('/');
      if (segments.length < 2) continue;
      const area = segments[0];
      const entry = areas.get(area) || { nodeCount: 0, terraformNodes: 0, names: [] };
      entry.nodeCount += 1;
      if (/\.(tf|tfvars)$/i.test(file)) entry.terraformNodes += 1;
      if (entry.names.length < 400 && node.name) entry.names.push(node.name);
      areas.set(area, entry);
    }
    if (productNodeCount === 0) return [];
    const results: Array<{ area: string; domain: string | null; nodeCount: number; share: number }> = [];
    for (const [area, entry] of areas) {
      const share = entry.nodeCount / productNodeCount;
      if (share < 0.1 || entry.nodeCount < 3) continue;
      results.push({
        area,
        domain: this.classifyAreaDomain(area, entry),
        nodeCount: entry.nodeCount,
        share,
      });
    }
    return results.sort((a, b) => b.nodeCount - a.nodeCount);
  }

  private classifyAreaDomain(
    area: string,
    entry: { nodeCount: number; terraformNodes: number; names: string[] }
  ): string | null {
    const infrastructureArea = /^(infra|infrastructure|terraform|opentofu|deploy|deployment|ops|devops|ansible|helm|charts?|k8s|kubernetes)$/i.test(area);
    if (infrastructureArea || entry.terraformNodes >= entry.nodeCount * 0.5) {
      return 'cloud-infrastructure';
    }
    const text = entry.names
      .join(' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_\-./]/g, ' ')
      .toLowerCase();
    const ruleDomain = this.structuralDomainFromText(text);
    if (ruleDomain) return ruleDomain;
    const scores = new Map<string, number>();
    for (const token of text.split(/[^a-z0-9]+/)) {
      const normalized = this.normalizeDomainToken(token);
      if (normalized.length <= 2) continue;
      if (this.isGenericDomainToken(normalized) || this.isGenericCapabilityToken(normalized)) continue;
      if (this.isCrossCuttingDomainToken(normalized)) continue;
      scores.set(normalized, (scores.get(normalized) || 0) + 1);
    }
    const [top] = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
    if (!top || top[1] < 3) return null;
    return top[0];
  }

  private reconcilePrimaryDomainWithAreas(
    primaryDomain: string,
    areaDomains: Array<{ area: string; domain: string | null; nodeCount: number; share: number }>
  ): { primaryDomain: string; secondaryDomains: Array<{ domain: string; areas: string[]; node_share: number }> } {
    const classified = areaDomains.filter(area => area.domain);
    if (classified.length === 0) return { primaryDomain, secondaryDomains: [] };

    const groups = new Map<string, { areas: string[]; nodeCount: number; share: number }>();
    for (const area of classified) {
      const group = groups.get(area.domain!) || { areas: [], nodeCount: 0, share: 0 };
      group.areas.push(area.area);
      group.nodeCount += area.nodeCount;
      group.share += area.share;
      groups.set(area.domain!, group);
    }
    const ordered = Array.from(groups.entries()).sort((a, b) => b[1].nodeCount - a[1].nodeCount);

    let resolved = primaryDomain;
    const primaryIsUseful = Boolean(primaryDomain) &&
      primaryDomain !== 'unknown' &&
      !this.isGenericDomainToken(primaryDomain);
    const heaviest = ordered[0];
    if (!primaryIsUseful) {
      resolved = heaviest[0];
    } else if (!this.areDomainsCompatible(primaryDomain, heaviest[0]) && this.isComposedDomainLabel(heaviest[0])) {
      const primaryGroup = ordered.find(([domain]) => this.areDomainsCompatible(primaryDomain, domain));
      if (primaryGroup) resolved = heaviest[0];
    }

    const secondaryDomains = groups.size < 2
      ? []
      : ordered
        .filter(([domain]) => domain !== resolved && !this.areDomainsCompatible(domain, resolved))
        .filter(([domain]) => this.isComposedDomainLabel(domain))
        .map(([domain, group]) => ({
          domain,
          areas: [...group.areas].sort(),
          node_share: Math.round(group.share * 100) / 100,
        }));
    return { primaryDomain: resolved, secondaryDomains };
  }

  private isComposedDomainLabel(domain: string): boolean {
    return domain.includes('-');
  }

  private areDomainsCompatible(a: string, b: string): boolean {
    if (!a || !b) return false;
    if (a === b) return true;
    const tokensOf = (domain: string) => new Set(
      [
        ...domain.toLowerCase().split('-'),
        ...this.structuralDomainVocabulary(domain.toLowerCase()),
      ].filter(token => token.length > 2 && token !== 'management' && !this.isGenericDomainToken(token))
    );
    const tokensA = tokensOf(a);
    const tokensB = tokensOf(b);
    for (const token of tokensA) {
      if (tokensB.has(token)) return true;
    }
    return false;
  }

  private inferPrimaryDomainFromCapabilities(systemCapabilities: SystemCapability[], coreConcepts: CASDomainConcept[]): string | null {
    const text = [
      ...systemCapabilities.map(capability => [
        capability.name,
        capability.description,
        ...(capability.related_domains || []),
        ...(capability.related_entities || []),
        ...(capability.operations || []).map(operation => `${operation.action || ''} ${operation.path_or_command || ''}`),
      ].join(' ')),
      ...coreConcepts.map(concept => concept.name),
    ].join(' ').toLowerCase();

    const ruleDomain = this.structuralDomainFromText(text);
    if (ruleDomain) return ruleDomain;

    const dominantBusinessDomain = this.inferDominantBusinessDomainFromCapabilities(systemCapabilities, coreConcepts);
    if (dominantBusinessDomain) return dominantBusinessDomain;

    const capabilityDomain = systemCapabilities
      .flatMap(capability => capability.related_domains || [])
      .find(domain => domain && !this.isGenericDomainToken(domain));
    return capabilityDomain ? capabilityDomain.toLowerCase().replace(/\s+/g, '-') : null;
  }

  private structuralDomainFromText(text: string): string | null {
    const has = (pattern: RegExp) => pattern.test(text);
    if (has(/\b(cas|mcp|ast|parser|call graph|static analysis)\b/) && has(/\b(codebase|analysis|analyzer|analyses)\b/)) {
      return 'codebase-analysis';
    }
    if (has(/\bcodebase\b/) && has(/\b(analysis|analyzer|analyses)\b/)) {
      return 'codebase-analysis';
    }
    if (has(/\b(fleet|telematics)\b/) && has(/\b(vehicle|vehicles|driver|drivers|dispatch|dispatching|trip|trips)\b/)) {
      return 'fleet-management';
    }
    const networkAccessAnchors = [/\baccess\b/, /\bpolic(y|ies)\b/, /\bnetworks?\b/, /\bposture\b/]
      .filter(pattern => pattern.test(text)).length;
    // Commerce systems also have gateways (payment gateways) and policies
    // (store/legal policies); cart/checkout vocabulary means the gateway
    // evidence is commerce, not network access control.
    const hasCommerceCheckoutAnchor = has(/\b(carts?|checkouts?)\b/);
    if (has(/\b(gateway|gateways)\b/) && !has(/\bpayment gateway\b/) && !hasCommerceCheckoutAnchor && networkAccessAnchors >= 2) {
      return 'network-access-management';
    }
    // Content-management must outrank the order/billing rules: a page-tree
    // CMS exposes ordering vocabulary (page position, ordering parameters)
    // that would otherwise read as commerce. The gate requires versioned
    // content evidence (revision + publishing workflow), which commerce
    // systems do not carry.
    if (
      has(/\b(pages?|contents?|documents?)\b/) &&
      has(/\brevisions?\b/) &&
      has(/\b(publish|published|publishing|unpublish|drafts?|moderation)\b/)
    ) {
      return 'content-management';
    }
    const hasOrderAnchor = has(/\b(orders?|salesorders?|sales orders?)\b/);
    if (hasOrderAnchor && has(/\binvoices?\b/)) {
      return 'order-invoice-management';
    }
    if (hasOrderAnchor && has(/\b(payments?|billing)\b/)) {
      return 'order-payment-management';
    }
    if (has(/\binvoice|invoices|payment|payments|billing\b/)) {
      return 'billing-payments';
    }
    if (has(/\border|orders|fulfillment|salesorder|sales order\b/)) {
      return 'order-management';
    }
    if (has(/\bdocument|documents|file|files\b/) && has(/\breport|reports|pdf|download|print\b/)) {
      return 'document-reporting';
    }
    if (has(/\bcompany|member|members|organization|workspace\b/) && has(/\bdocument|documents|report|reports\b/)) {
      return 'member-document-portal';
    }
    if (
      has(/\bidentity|auth|authentication|authorization\b/) &&
      has(/\buser|users|register|login|password|token|email|claims?\b/)
    ) {
      return 'user-identity-management';
    }
    return null;
  }

  private structuralDomainVocabulary(domain: string): string[] {
    const vocabulary: Record<string, string[]> = {
      'codebase-analysis': ['analysis', 'analyzer', 'analyses', 'codebase', 'cas', 'mcp', 'parser', 'ast'],
      'fleet-management': ['fleet', 'vehicle', 'driver', 'dispatch', 'telematics', 'trip'],
      'network-access-management': ['gateway', 'access', 'policy', 'network', 'posture', 'resource'],
      'order-invoice-management': ['order', 'invoice', 'payment'],
      'order-payment-management': ['order', 'payment', 'billing'],
      'billing-payments': ['invoice', 'payment', 'billing'],
      'order-management': ['order', 'fulfillment'],
      'document-reporting': ['document', 'report', 'pdf'],
      'member-document-portal': ['company', 'member', 'organization', 'workspace', 'document', 'report'],
    };
    return vocabulary[domain] || domain.split('-').filter(token => token.length > 2);
  }

  private isSpecificStructuralDomain(
    domain: string,
    systemCapabilities: SystemCapability[],
    coreConcepts: CASDomainConcept[],
    systemName?: string
  ): boolean {
    const normalized = domain.toLowerCase();
    if (!normalized.includes('-')) return false;
    if (this.isGenericDomainToken(normalized)) return false;
    if (this.isNarrowCrossCuttingDomain(normalized)) return false;
    if (this.isNonSemanticDomainLabel(normalized, systemName)) return false;
    const meaningfulTokens = normalized
      .split('-')
      .filter(token => token.length > 2 && !this.isGenericDomainToken(token) && token !== 'management');
    if (meaningfulTokens.length === 0) return false;
    if (meaningfulTokens.every(token => this.isCrossCuttingDomainToken(token) || this.isNarrowCrossCuttingDomain(token))) {
      return false;
    }
    const vocabulary = this.structuralDomainVocabulary(normalized);
    const sources = [
      ...systemCapabilities.map(capability => [
        capability.name,
        ...(capability.related_domains || []),
        ...(capability.related_entities || []),
      ].join(' ')),
      ...coreConcepts.map(concept => concept.name),
    ];
    const supporting = sources.filter(source => {
      const flattened = source.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
      return vocabulary.some(token => flattened.includes(token));
    });
    return supporting.length >= 2;
  }

  private isNarrowCrossCuttingDomain(domain: string): boolean {
    return /^(auth|authentication|authorization|login|user|users|session|sessions|identity|account|accounts)$/i.test(domain);
  }

  private inferDominantBusinessDomainFromCapabilities(
    systemCapabilities: SystemCapability[],
    coreConcepts: CASDomainConcept[]
  ): string | null {
    const scores = new Map<string, number>();
    const addToken = (token: string, weight: number) => {
      const normalized = this.normalizeDomainToken(token.toLowerCase());
      if (!normalized || normalized.length <= 2) return;
      if (this.isGenericDomainToken(normalized) || this.isGenericCapabilityToken(normalized)) return;
      if (this.isCrossCuttingDomainToken(normalized)) return;
      scores.set(normalized, (scores.get(normalized) || 0) + weight);
    };
    const addText = (text: string, weight: number) => {
      const tokens = text
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_\-./]/g, ' ')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
      for (const token of tokens) addToken(token, weight);
    };

    for (const concept of coreConcepts) addText(concept.name, 4);
    for (const capability of systemCapabilities) {
      for (const domain of capability.related_domains || []) addText(domain, 3);
      for (const entity of capability.related_entities || []) addText(entity, 3);
      addText(capability.name, 1);
      for (const operation of capability.operations || []) addText(operation.path_or_command || operation.action || '', 0.5);
    }

    if (scores.size === 0) return null;
    const score = (token: string) => scores.get(token) || 0;
    if (score('product') > 0 && (score('company') > 0 || score('source') > 0 || score('connection') > 0 || score('record') > 0)) {
      return 'product-data-management';
    }
    if (score('company') > 0 && score('source') > 0) return 'company-source-management';
    if (score('post') > 0 || score('content') > 0) return 'content-management';
    if (score('product') > 0) return 'product-management';

    const [top] = Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1]);
    if (!top || top[1] < 2) return null;
    return top[0];
  }

  private isCrossCuttingDomainToken(token: string): boolean {
    return /^(auth|authentication|authorization|login|logout|session|sessions|token|tokens|jwt|oauth|user|users|account|accounts|admin|permission|permissions|role|roles|serializer|serializers|has)$/.test(token);
  }

  private isBroadProjectTextDomain(domain: string): boolean {
    return /^(customer-relationship-management|business|portal|web-application|frontend|backend|hercules)$/i.test(domain);
  }

  private domainFromSystemName(systemName?: string): string | null {
    if (!systemName) return null;
    const tokens = systemName
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .split(/[^a-zA-Z0-9]+/)
      .map(token => token.toLowerCase())
      .filter(token => token && !this.isGenericDomainToken(token));
    if (tokens.length === 0) return null;
    if (tokens.includes('pumpfun')) return 'pumpfun';
    if (tokens.includes('solana')) return 'solana';
    return tokens[0];
  }

  private shouldPreferProjectTextSummary(
    primaryDomain: string,
    systemCapabilities: SystemCapability[],
    flowGraph: CASFlowGraph
  ): boolean {
    const usefulCapabilities = systemCapabilities.filter(capability => !this.isGenericCapabilityDisplayName(capability.name));
    const flowCapabilities = [...(flowGraph.capabilities || [])].filter(capability => !this.isGenericCapabilityDisplayName(capability.name));
    return !primaryDomain ||
      primaryDomain === 'unknown' ||
      this.isGenericDomainToken(primaryDomain) ||
      usefulCapabilities.length <= 2 ||
      flowCapabilities.length <= 2;
  }

  private stripAgentToolingInstructionText(text: string): string {
    return text
      .split(/\r?\n/)
      .filter(line => !/\b(klauro|unravl|mcp|claude(?:\s+code)?|codex|anthropic|cursor|copilot|coding agents?|agent operating loop|work packets?|analysis-focus|cas graph|codebase intelligence|query the analysis|analyze_codebase|get_summary|get_level|get_node|get_callers|get_callees|find_tests|search_nodes|get_agent_|run_answer_pack|assess_change_risk|get_coding_context)\b/i.test(line))
      .join('\n');
  }

  private extractProjectTextSignal(projectPath: string): ProjectTextSignal {
    const textParts: string[] = [];
    const evidence: string[] = [];

    const packageJson = this.safeReadJson(path.join(projectPath, 'package.json'));
    if (packageJson?.description) {
      textParts.push(String(packageJson.description));
      evidence.push('package.json description');
    }
    if (packageJson?.name) textParts.push(String(packageJson.name));

    for (const readmeName of ['README.md', 'README.mdx', 'readme.md']) {
      const readmePath = path.join(projectPath, readmeName);
      const content = this.safeReadText(readmePath, 12000);
      if (!content) continue;
      const useful = this.stripBoilerplateProjectText(content);
      if (useful.length > 80) {
        textParts.push(useful);
        evidence.push(readmeName);
      }
      break;
    }

    for (const guideName of ['CLAUDE.md', 'AGENTS.md', 'KLAURO.md']) {
      const guidePath = path.join(projectPath, guideName);
      const content = this.safeReadText(guidePath, 30000);
      if (!content) continue;
      const useful = this.stripAgentToolingInstructionText(this.stripBoilerplateProjectText(content));
      if (useful.length > 80) {
        textParts.push(useful);
        evidence.push(guideName);
      }
    }

    let sourceTextFound = false;
    const sourceFiles = (this.safeGlobSync('**/*.{ts,tsx,js,jsx,mjs,cjs,py,rs,go,java,cs,php,dart}', {
      cwd: projectPath,
      nodir: true,
      ignore: this.getProjectTextSourceIgnorePatterns(),
    }).length > 0
      ? this.safeGlobSync('**/*.{ts,tsx,js,jsx,mjs,cjs,py,rs,go,java,cs,php,dart}', {
        cwd: projectPath,
        nodir: true,
        ignore: this.getProjectTextSourceIgnorePatterns(),
      })
      : this.scanProjectTextSourceFiles(projectPath)
    ).slice(0, 80);
    for (const file of sourceFiles) {
      const content = this.safeReadText(path.join(projectPath, file), 20000);
      const extracted = this.extractHumanTextFromSource(content);
      if (extracted) {
        sourceTextFound = true;
        textParts.push(extracted);
      }
    }
    if (sourceTextFound) evidence.push('source text');

    const text = textParts.join('\n').toLowerCase();
    const primaryDomain = this.inferDomainFromProjectText(text, projectPath);
    const concepts = this.inferConceptsFromProjectText(text);
    const summary = this.summaryFromProjectText(primaryDomain, concepts, text, evidence);

    return { primaryDomain, concepts, summary, evidence };
  }

  private safeReadJson(filePath: string): any | null {
    try {
      if (!fs.existsSync(filePath)) return null;
      return fs.readJsonSync(filePath);
    } catch {
      return null;
    }
  }

  private collectProjectReadabilityWarnings(projectPath: string, analysisErrors: CASAnalysisError[]): void {
    const packageJsonPath = path.join(projectPath, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      try {
        fs.readJsonSync(packageJsonPath);
      } catch (error) {
        analysisErrors.push({
          severity: 'warning',
          code: 'MANIFEST_PARSE_ERROR',
          message: `package.json could not be parsed; dependency and script information is unavailable: ${(error as Error).message}`,
          file: 'package.json',
          recoverable: true
        });
      }
    }

    const deniedPaths: string[] = [];
    const maxDeniedReports = 25;
    const maxDirectoriesScanned = 5000;
    let directoriesScanned = 0;
    const stack: Array<{ absolute: string; relative: string; depth: number }> = [
      { absolute: projectPath, relative: '', depth: 0 }
    ];
    while (stack.length > 0 && directoriesScanned < maxDirectoriesScanned) {
      const current = stack.pop()!;
      directoriesScanned += 1;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current.absolute, { withFileTypes: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if ((code === 'EACCES' || code === 'EPERM') && deniedPaths.length < maxDeniedReports) {
          deniedPaths.push(current.relative || '.');
        }
        continue;
      }
      if (current.depth >= 300) continue;
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const relativePath = current.relative ? `${current.relative}/${entry.name}` : entry.name;
        if (this.isIgnoredInventoryDirectory(entry.name, relativePath, new Set())) continue;
        stack.push({
          absolute: path.join(current.absolute, entry.name),
          relative: relativePath,
          depth: current.depth + 1
        });
      }
    }
    for (const deniedPath of deniedPaths) {
      analysisErrors.push({
        severity: 'warning',
        code: 'PERMISSION_DENIED',
        message: `Directory could not be read (permission denied); its contents are missing from the analysis: ${deniedPath}`,
        file: deniedPath,
        recoverable: true
      });
    }
  }

  private safeGlobSync(pattern: string | string[], options: Record<string, any>): string[] {
    try {
      const globModule = require('glob');
      const sync = globSync || globModule.globSync || globModule.sync;
      return typeof sync === 'function' ? sync(pattern as any, options as any) : [];
    } catch {
      return [];
    }
  }

  private scanProjectTextSourceFiles(projectPath: string): string[] {
    const results: string[] = [];
    const sourceExtension = /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|cs|php|dart|tf|tfvars)$/i;
    const ignoredDir = /^(node_modules|dist|build|coverage|vendor|vendors|generated|fixtures?|__fixtures__|__tests__|tests?|spec|e2e|\.git|\.next|\.turbo|\.cache|\.terraform)$/;
    const visit = (directory: string) => {
      if (results.length >= 80) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= 80) break;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!ignoredDir.test(entry.name)) visit(absolute);
        } else if (entry.isFile() && sourceExtension.test(entry.name)) {
          results.push(path.relative(projectPath, absolute).replace(/\\/g, '/'));
        }
      }
    };
    visit(projectPath);
    return results;
  }

  private getProjectTextSourceIgnorePatterns(): string[] {
    return [
      ...this.getProjectDiscoveryIgnorePatterns(),
      '**/__tests__/**',
      '**/test/**',
      '**/tests/**',
      '**/spec/**',
      '**/e2e/**',
      '**/fixtures/**',
      '**/__fixtures__/**',
      '**/__mocks__/**',
      '**/*.test.*',
      '**/*.spec.*',
      '**/*.stories.*',
      '**/*.story.*',
    ];
  }

  private safeReadText(filePath: string, maxBytes: number): string {
    try {
      if (!fs.existsSync(filePath)) return '';
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size > maxBytes * 5) return '';
      return fs.readFileSync(filePath, 'utf8').slice(0, maxBytes);
    } catch {
      return '';
    }
  }

  private stripBoilerplateProjectText(content: string): string {
    const lines = content
      .split(/\r?\n/)
      .filter(line => !/next\.js|create-next-app|vercel platform|learn next|getting started|npm run dev|yarn dev|pnpm dev|bun dev/i.test(line));
    return lines.join('\n');
  }

  private extractHumanTextFromSource(content: string): string {
    if (!content) return '';
    const snippets: string[] = [];
    const stringPattern = /(["'`])((?:\\\1|(?:(?!\1).)){8,160})\1/g;
    let match: RegExpExecArray | null;
    while ((match = stringPattern.exec(content)) && snippets.length < 80) {
      const value = match[2]
        .replace(/\\n/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!/[a-zA-Z]{3,}/.test(value)) continue;
      if (/^https?:|^\/|^[a-z0-9_-]+\.(png|jpg|jpeg|svg|mp4|webm|css)$/i.test(value)) continue;
      if (/^(className|metadata|import|export|const|return)$/i.test(value)) continue;
      snippets.push(value);
    }
    const jsxTextPattern = />\s*([^<>{}][^<>{}]{8,180})\s*</g;
    while ((match = jsxTextPattern.exec(content)) && snippets.length < 120) {
      const value = match[1].replace(/\s+/g, ' ').trim();
      if (!/[a-zA-Z]{3,}/.test(value)) continue;
      if (/^[);,\s]+$/.test(value)) continue;
      snippets.push(value);
    }
    return snippets.join(' ');
  }

  private inferDomainFromProjectText(text: string, projectPath: string): string | undefined {
    const repoName = path.basename(projectPath).toLowerCase();
    // Only the repo basename may contribute location evidence. Parent
    // directories (clone workspaces, /tmp paths, client folders) must never
    // leak into domain inference. The basename is counted twice to preserve
    // the prior weighting where it appeared as both repo name and final path
    // segment, without it dominating real project text.
    const locationText = `${repoName} ${repoName}`;
    const searchableText = `${text}\n${locationText}`;
    const isInfrastructureRepo =
      /\b(infra|infrastructure|terraform|opentofu|aws-infra|system-infra)\b/.test(repoName);
    const isExplicitZeroTrustProduct = /\bzero[-\s]?trust\b/.test(text) && !isInfrastructureRepo;
    if (isInfrastructureRepo) {
      return 'cloud-infrastructure';
    }
    const cryptoTradingScore =
      this.phraseScore(searchableText, ['solana']) * 3 +
      this.phraseScore(searchableText, ['pumpfun']) * 3 +
      this.phraseScore(searchableText, ['jito']) * 3 +
      this.phraseScore(searchableText, ['mev']) * 2 +
      this.phraseScore(searchableText, ['arbitrage']) * 2 +
      this.phraseScore(searchableText, ['sniper']) +
      this.phraseScore(searchableText, ['bundler']) +
      this.phraseScore(searchableText, ['dex']) +
      this.phraseScore(searchableText, ['trading']);
    const cloudInfrastructureScore =
      this.phraseScore(searchableText, ['terraform']) * 3 +
      this.phraseScore(searchableText, ['opentofu']) * 3 +
      this.phraseScore(searchableText, ['aws']) * 2 +
      this.phraseScore(searchableText, ['infrastructure']) * 2 +
      this.phraseScore(searchableText, ['infra']) * 2 +
      this.phraseScore(searchableText, ['ecs']) +
      this.phraseScore(searchableText, ['vpc']) +
      this.phraseScore(searchableText, ['rds']) +
      this.phraseScore(searchableText, ['cloudfront']) +
      this.phraseScore(searchableText, ['route53']);
    const explicitZeroTrustLanguage =
      /\bzero[-\s]?trust\b/.test(text) ||
      /\bcontinuous verification\b/.test(text) ||
      /\bidentity provider\b/.test(text) ||
      /\bprotected resources?\b/.test(text) ||
      /\baccess requests?\b/.test(text);
    const zeroTrustRawScore = (isExplicitZeroTrustProduct ? 8 : 0) +
      this.phraseScore(searchableText, ['zero trust', 'security']) * 3 +
      this.phraseScore(searchableText, ['access request']) * 2 +
      this.phraseScore(searchableText, ['identity provider']) * 2 +
      this.phraseScore(searchableText, ['continuous verification']) * 2 +
      this.phraseScore(searchableText, ['protected resource']) * 2 +
      this.phraseScore(searchableText, ['network', 'access']) +
      this.phraseScore(searchableText, ['gateway']) +
      this.phraseScore(searchableText, ['verification', 'secure']);
    const zeroTrustScore = explicitZeroTrustLanguage
      ? zeroTrustRawScore
      : Math.min(zeroTrustRawScore, 3);
    const hasApplicationFrameworkSignal =
      /\b(rails|django|react|angular|vue|express|nestjs|fastapi|laravel|symfony|spring|flutter|flask|next\.?js)\b/i.test(searchableText);
    const effectiveCloudInfrastructureScore = isExplicitZeroTrustProduct || (hasApplicationFrameworkSignal && !isInfrastructureRepo)
      ? Math.min(cloudInfrastructureScore, 3)
      : cloudInfrastructureScore;
    const fleetManagementScore =
      this.phraseScore(searchableText, ['fleet management']) * 4 +
      this.phraseScore(searchableText, ['commercial vehicle']) * 3 +
      this.phraseScore(searchableText, ['telematics']) * 3 +
      this.phraseScore(searchableText, ['vehicle fleet']) * 3 +
      this.phraseScore(searchableText, ['eld compliance', 'fmcsa']) * 2 +
      this.phraseScore(searchableText, ['driver', 'vehicle', 'fuel', 'maintenance']) +
      this.phraseScore(searchableText, ['safety monitoring', 'drive alerts', 'dispatching', 'ifta']);
    const clinicalAnchorScore =
      this.phraseScore(searchableText, ['patient']) +
      this.phraseScore(searchableText, ['muscle']) +
      this.phraseScore(searchableText, ['clinical']);
    const strongCommerceAnchorScore =
      this.phraseScore(searchableText, ['cart']) +
      this.phraseScore(searchableText, ['checkout']);
    const commerceAnchorScore =
      strongCommerceAnchorScore +
      this.phraseScore(searchableText, ['invoice']) +
      this.phraseScore(searchableText, ['billing']);
    const codebaseAnalysisAnchorScore =
      this.phraseScore(searchableText, ['codebase analysis', 'code analysis', 'static analysis', 'call graph']) +
      this.phraseScore(searchableText, ['analyzer', 'analyzers']) +
      (/\bcodebase\b/.test(searchableText) && /\banaly(sis|ses|ze|zes)\b/.test(searchableText) ? 1 : 0);
    const codebaseAnalysisScore = codebaseAnalysisAnchorScore === 0
      ? 0
      : this.phraseScore(searchableText, ['codebase analysis', 'code analysis', 'static analysis']) * 3 +
      this.phraseScore(searchableText, ['codebase', 'analysis', 'analyzer', 'analyzers']) +
      this.phraseScore(searchableText, ['cas', 'mcp', 'call graph', 'entry points']) * 2;
    const networkAccessAnchorScore =
      this.phraseScore(searchableText, ['gateway']) +
      this.phraseScore(searchableText, ['posture']) +
      this.phraseScore(searchableText, ['access request']) +
      this.phraseScore(searchableText, ['protected resource']);
    const nicheDomainSignal = fleetManagementScore >= 2 || clinicalAnchorScore >= 2 || networkAccessAnchorScore >= 2;
    const commerceOperationsScore = commerceAnchorScore === 0 || (strongCommerceAnchorScore === 0 && nicheDomainSignal)
      ? 0
      : this.phraseScore(searchableText, ['cart']) * 2 +
      this.phraseScore(searchableText, ['checkout']) * 3 +
      this.phraseScore(searchableText, ['order', 'invoice']) * 3 +
      this.phraseScore(searchableText, ['orders']) * 2 +
      this.phraseScore(searchableText, ['invoice']) * 2 +
      this.phraseScore(searchableText, ['billing']) * 2 +
      this.phraseScore(searchableText, ['account', 'cart']) +
      this.phraseScore(searchableText, ['search', 'checkout']) +
      this.phraseScore(searchableText, ['location', 'order']);
    const clinicalTestingScore = clinicalAnchorScore === 0
      ? 0
      : this.phraseScore(searchableText, ['patient']) * 3 +
      this.phraseScore(searchableText, ['muscle']) * 3 +
      this.phraseScore(searchableText, ['measurement']) * 2 +
      this.phraseScore(searchableText, ['force']) +
      this.phraseScore(searchableText, ['device']) +
      this.phraseScore(searchableText, ['protocol']) +
      this.phraseScore(searchableText, ['assessment']) +
      this.phraseScore(searchableText, ['scientific']);
    const phraseScores: Array<[string, number]> = [
      ['codebase-analysis', codebaseAnalysisScore],
      ['personal-ai-assistant', this.phraseScore(searchableText, ['assistant']) === 0
        ? 0
        : this.phraseScore(searchableText, ['personal ai assistant']) * 3 + this.phraseScore(searchableText, ['multi-channel', 'assistant']) + this.phraseScore(searchableText, ['channels', 'gateway'])],
      ['ecommerce-storefront', this.phraseScore(searchableText, ['shopify', 'liquid', 'storefront']) === 0
        ? 0
        : this.phraseScore(searchableText, ['shopify', 'theme']) * 2 + this.phraseScore(searchableText, ['online store']) + this.phraseScore(searchableText, ['storefront', 'merchant'])],
      ['commerce-operations-portal', commerceOperationsScore],
      ['clinical-testing', clinicalTestingScore],
      ['cloud-infrastructure', effectiveCloudInfrastructureScore + (isInfrastructureRepo ? 12 : 0)],
      ['zero-trust-security', zeroTrustScore],
      ['fleet-management', fleetManagementScore],
      ['solana-arbitrage', cryptoTradingScore],
      ['portfolio-management', this.phraseScore(searchableText, ['portfolio', 'asset']) + this.phraseScore(searchableText, ['investment', 'holding'])],
      ['billing-payments', this.phraseScore(searchableText, ['billing', 'payment']) + this.phraseScore(searchableText, ['invoice', 'subscription'])],
      ['customer-relationship-management', this.phraseScore(searchableText, ['customer', 'contact']) + this.phraseScore(searchableText, ['pipeline', 'lead'])],
    ];
    const [domain, score] = phraseScores.sort((a, b) => b[1] - a[1])[0] || [];
    return score >= 4 ? domain : undefined;
  }

  private phraseScore(text: string, terms: string[]): number {
    return terms.reduce((score, term) => {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const count = (text.match(new RegExp(`\\b${escaped}\\b`, 'gi')) || []).length;
      return score + Math.min(count, 6);
    }, 0);
  }

  private inferConceptsFromProjectText(text: string): string[] {
    const candidates = [
      'zero trust',
      'security',
      'network',
      'access',
      'access request',
      'identity provider',
      'verification',
      'gateway',
      'resource',
      'agent',
      'arbitrage',
      'solana',
      'market data',
      'dex',
      'terraform',
      'opentofu',
      'aws',
      'infrastructure',
      'vpc',
      'ecs',
      'rds',
      'cloudfront',
      'route53',
      'risk',
      'commerce operations',
      'cart',
      'checkout',
      'order',
      'orders',
      'invoice',
      'billing',
      'fleet management',
      'commercial vehicle',
      'telematics',
      'vehicle fleet',
      'eld compliance',
      'fmcsa',
      'driver',
      'vehicle',
      'fuel',
      'maintenance',
      'safety monitoring',
      'drive alerts',
      'dispatching',
      'ifta',
      'routing',
      'clinical testing',
      'patient',
      'muscle',
      'measurement',
      'force',
      'device',
      'assessment',
      'portfolio',
      'codebase analysis',
      'analyzer',
      'cas',
      'mcp',
      'billing',
      'payment',
      'customer',
      'assistant',
      'gateway',
      'channels',
      'messaging',
      'shopify',
      'theme',
      'storefront',
      'merchant',
    ];
    return candidates
      .map(candidate => ({ candidate, score: this.phraseScore(text, [candidate]) }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(item => item.candidate)
      .map(candidate => candidate.replace(/\s+/g, '-'))
      .slice(0, 8);
  }

  private summaryFromProjectText(
    primaryDomain: string | undefined,
    concepts: string[],
    text: string,
    evidence: string[]
  ): string | undefined {
    if (!primaryDomain) return undefined;
    if (primaryDomain === 'fleet-management') {
      return 'A fleet management system for commercial vehicle operations. Project documentation describes real-time tracking, compliance management, safety monitoring, dispatch and trip operations, fuel and maintenance reporting, and integrations with telematics and business-service providers.';
    }
    if (primaryDomain === 'zero-trust-security') {
      return 'A zero-trust security codebase for controlling protected access and network trust decisions. Project text and source copy describe continuous verification, secure access gateways, request workflows, infrastructure policy, and operator-facing controls for reviewing and enforcing policy decisions.';
    }
    if (primaryDomain === 'commerce-operations-portal') {
      return 'A commerce operations portal for account, cart, checkout, order, invoice, billing, search, and location workflows. Project text and source copy describe user-facing commerce screens and operational customer flows.';
    }
    if (primaryDomain === 'clinical-testing') {
      return 'A clinical testing and scientific measurement application for patient, protocol, device, muscle, force, and assessment workflows. Project text and source copy describe desktop or service-side support for clinical evaluation and reporting.';
    }
    if (primaryDomain === 'solana-arbitrage') {
      return 'A Solana arbitrage codebase for monitoring decentralized exchanges, computing profitable routes, applying risk controls, and submitting atomic transactions.';
    }
    if (primaryDomain === 'codebase-analysis') {
      return 'A codebase analysis system that turns source repositories into a relationship graph for humans and AI agents. Project text describes CAS/MCP analysis, graph extraction, agent work packets, and proposal or iteration previews.';
    }
    if (primaryDomain === 'cloud-infrastructure') {
      return 'A cloud infrastructure codebase for managing deployment resources and operational boundaries. Project text and infrastructure files describe Terraform/OpenTofu-managed cloud resources, modules, providers, variables, and outputs.';
    }
    if (primaryDomain === 'personal-ai-assistant') {
      return 'A personal AI assistant platform for coordinating local tools, multi-channel messaging, gateway control, and companion apps.';
    }
    if (primaryDomain === 'ecommerce-storefront') {
      if (this.phraseScore(text, ['shopify']) > 0 && this.phraseScore(text, ['liquid']) > 0) {
        return 'An ecommerce storefront theme for merchant-facing online shopping experiences. Project text describes Shopify theme development, server-rendered Liquid, storefront performance, and online store features.';
      }
      return 'An ecommerce storefront for merchant-facing online shopping experiences. Project text describes storefront features and online store workflows.';
    }
    if (primaryDomain === 'portfolio-management') {
      return 'A portfolio management codebase for tracking assets, investment holdings, risk, and portfolio reporting workflows.';
    }
    if (!this.hasDistinctiveProjectTextConcepts(concepts)) {
      return undefined;
    }
    const topConcepts = concepts.length ? concepts.slice(0, 5).join(', ') : primaryDomain.replace(/-/g, ' ');
    return `A ${primaryDomain.replace(/-/g, ' ')} codebase. Project text identifies the main concepts as ${topConcepts}. Evidence: ${evidence.slice(0, 3).join(', ') || 'source text'}.`;
  }

  private hasDistinctiveProjectTextConcepts(concepts: string[]): boolean {
    const generic = new Set([
      'access', 'network', 'data', 'user', 'users', 'page', 'pages', 'component',
      'components', 'route', 'routes', 'service', 'services', 'app', 'application',
    ]);
    return concepts.filter(concept => {
      const tokens = concept.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      return tokens.some(token => token.length > 3 && !generic.has(token));
    }).length >= 3;
  }

  private focusProjectTextConcepts(concepts: string[], preferred: string[]): string[] {
    const selected = preferred.filter(concept => concepts.includes(concept));
    const filled = [...selected, ...preferred.filter(concept => !selected.includes(concept))];
    return filled.slice(0, 5);
  }

  private isGenericDomainToken(token: string): boolean {
    return new Set([
      'app', 'application', 'api', 'service', 'server', 'client', 'web', 'ui',
      'services', 'controllers', 'handlers', 'modules', 'frontend', 'backend',
      'bot', 'worker', 'script', 'test', 'demo', 'poc', 'search',
      'old', 'new', 'main', 'index', 'metadata', 'data', 'core', 'lib', 'library',
      'libs', 'package', 'portal', 'dashboard', 'admin', 'business', 'apps',
      'users', 'michaelshattuck', 'dev', 'clients', 'outcode', 'personal',
      'page', 'pages', 'route', 'routes', 'component', 'components', 'layout',
      'layouts', 'section', 'sections', 'navbar', 'nav', 'footer', 'button',
      'arrow', 'padding', 'total', 'home', 'submit', 'rewrite', 'rewrites',
      'asset', 'assets', 'generated', 'gql', 'graphql', 'document', 'documents',
      'render', 'close', 'focus', 'normalize', 'ensure', 'path', 'clamp', 'install',
      'modal', 'dialog', 'popup', 'screen', 'window', 'view', 'views',
    ]).has(token.toLowerCase());
  }

  private buildQuickDescription(
    systemPurpose: SystemPurpose,
    flowGraph: CASFlowGraph,
    databaseEntities: string[],
    entryPoints: { type: string; count: number }[],
    frameworks: string[],
    externalServices: string[],
    systemCapabilities: SystemCapability[] = [],
    primaryDomain?: string,
    conceptNames: string[] = []
  ): string {
    const typeLabel = systemPurpose.primary_type.replace(/-/g, ' ');
    const domainLabel = primaryDomain && primaryDomain !== 'unknown'
      ? primaryDomain.replace(/-/g, ' ')
      : '';
    const systemLabel = domainLabel || typeLabel;

    const productFrameworks = frameworks.filter(framework => !/\b(jest|vitest|mocha|cypress|playwright)\b/i.test(framework));

    let capabilitySource = systemCapabilities.length > 0
      ? systemCapabilities
        .filter(capability => capability.category !== 'internal')
        .filter(capability => !this.isGenericCapabilityDisplayName(capability.name))
      : [];

    if (primaryDomain && !/^(auth|authentication|login|identity|session|account|accounts|user|users)$/i.test(primaryDomain)) {
      const productCapabilities = capabilitySource.filter(capability => !this.isCrossCuttingCapabilityName(capability.name));
      if (productCapabilities.length >= 2) capabilitySource = productCapabilities;
    }

    const coreCapabilitySource = capabilitySource.filter(capability =>
      capability.category === 'core' ||
      capability.criticality === 'critical' ||
      capability.criticality === 'high'
    );
    if (coreCapabilitySource.length >= 2) capabilitySource = coreCapabilitySource;

    let capabilityNames = capabilitySource.length > 0
      ? capabilitySource
        .sort((a, b) => {
          const order = { critical: 0, high: 1, medium: 2, low: 3 };
          const purposeBias = (capability: SystemCapability) => this.capabilityPurposeBias(primaryDomain, capability);
          const domainBias = (capability: SystemCapability) =>
            primaryDomain && capability.related_domains?.some(domain => domain.includes(primaryDomain) || primaryDomain.includes(domain))
              ? 0
              : 1;
          return purposeBias(a) - purposeBias(b) ||
            domainBias(a) - domainBias(b) ||
            order[a.criticality] - order[b.criticality] ||
            b.operations.length - a.operations.length;
        })
        .map(capability => this.descriptionSafeCapabilityName(capability.name))
        .filter((name): name is string => Boolean(name))
        .filter((name, index, names) => this.isFirstCapabilitySummaryVariant(name, index, names))
        .slice(0, 5)
      : [...flowGraph.capabilities]
        .sort((a, b) => b.signals.total_score - a.signals.total_score)
        .map(c => this.descriptionSafeCapabilityName(c.name))
        .filter((name): name is string => Boolean(name))
        .filter((name, index, names) => this.isFirstCapabilitySummaryVariant(name, index, names))
        .slice(0, 5);
    const purposeCapabilityNames = this.purposeCapabilitySummary(primaryDomain, systemCapabilities, conceptNames);
    if (purposeCapabilityNames.length >= 2) {
      capabilityNames = purposeCapabilityNames;
    }

    const frameworkPhrase = productFrameworks.length > 0
      ? ` built with ${this.joinHumanList(productFrameworks.slice(0, 3))}`
      : '';
    const capabilityPhrase = this.describeCapabilitiesForNarrative(capabilityNames);
    const entityPhrase = this.describeEntitiesForNarrative(databaseEntities);
    const entryPointPhrase = this.describeEntryPointsForNarrative(entryPoints);
    const integrationPhrase = this.describeIntegrationsForNarrative(externalServices);

    const firstSentence = capabilityPhrase
      ? `${this.articleFor(systemLabel)} ${systemLabel} system${frameworkPhrase} that ${capabilityPhrase}.`
      : `${this.articleFor(systemLabel)} ${systemLabel} system${frameworkPhrase} that organizes the codebase around its detected domain workflows and runtime boundaries.`;

    const secondParts = [
      entityPhrase ? `Its model centers on ${entityPhrase}` : '',
      entryPointPhrase,
      integrationPhrase,
    ].filter(Boolean);
    const secondSentence = secondParts.length > 0
      ? `${secondParts.join(', ')}.`
      : 'The CAS graph maps the system structure, relationships, and change surfaces for deeper inspection.';

    return `${firstSentence} ${secondSentence}`;
  }

  private describeCapabilitiesForNarrative(capabilityNames: string[]): string {
    const normalized = capabilityNames
      .map(name => name.toLowerCase().replace(/\bmanagement\b/g, '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 4);
    if (normalized.length === 0) return '';
    if (normalized.length === 1) return `supports ${normalized[0]} workflows`;
    return `coordinates ${this.joinHumanList(normalized)} workflows`;
  }

  private describeEntitiesForNarrative(databaseEntities: string[]): string {
    const entityNames = databaseEntities
      .map(entity => this.humanizePascalName(entity).toLowerCase())
      .filter(entity => entity && !this.isGenericDomainToken(entity))
      .slice(0, 4);
    return this.joinHumanList(entityNames);
  }

  private describeEntryPointsForNarrative(entryPoints: { type: string; count: number }[]): string {
    const meaningfulEntryPoints = entryPoints
      .filter(ep => ep.type !== 'test' && ep.count > 0)
      .sort((a, b) => b.count - a.count);
    if (meaningfulEntryPoints.length === 0) return '';
    const types = meaningfulEntryPoints.slice(0, 3).map(ep => this.entryPointTypeLabel(ep.type));
    return `it is exercised through ${this.joinHumanList(types)}`;
  }

  private describeIntegrationsForNarrative(externalServices: string[]): string {
    const meaningfulExternalServices = externalServices
      .filter(service => this.isMeaningfulExternalServiceName(service))
      .slice(0, 3);
    if (meaningfulExternalServices.length === 0) return '';
    return `and it connects to ${this.joinHumanList(meaningfulExternalServices)}`;
  }

  private entryPointTypeLabel(type: string): string {
    switch (type.toLowerCase()) {
      case 'http':
        return 'HTTP endpoints';
      case 'cli':
        return 'CLI commands';
      case 'message':
        return 'message handlers';
      case 'event':
        return 'event handlers';
      case 'page':
        return 'page routes';
      case 'websocket':
        return 'WebSocket channels';
      default:
        return `${type} entry points`;
    }
  }

  private joinHumanList(values: string[]): string {
    const items = values.map(value => value.trim()).filter(Boolean);
    if (items.length === 0) return '';
    if (items.length === 1) return items[0];
    if (items.length === 2) return `${items[0]} and ${items[1]}`;
    return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
  }

  private humanizePascalName(value: string): string {
    return (value || '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_\-./]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private humanizeDisplayName(value: string): string {
    return this.humanizePascalName(value)
      .split(/\s+/)
      .filter(Boolean)
      .map(word => /^[A-Z0-9]+$/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  private articleFor(phrase: string): string {
    const normalized = (phrase || '').trim().toLowerCase();
    if (/^u([bcfhjkqrstn]|ni|se|ser|til|nit|nit of|ser )/.test(normalized)) return 'A';
    return /^[aeiou]/i.test(normalized) ? 'An' : 'A';
  }

  private purposeCapabilitySummary(primaryDomain: string | undefined, capabilities: SystemCapability[], conceptNames: string[] = []): string[] {
    if (primaryDomain !== 'clinical-testing') return [];
    const text = capabilities
      .map(capability => [
        capability.name,
        ...(capability.related_domains || []),
        ...(capability.related_entities || []),
        ...(capability.operations || []).map(operation => operation.path_or_command || operation.action || ''),
      ].join(' '))
      .join(' ')
      .toLowerCase() + ' ' + conceptNames.join(' ').toLowerCase();
    const summary: string[] = [];
    if (/\bpatient/.test(text)) summary.push('patient records');
    if (/\b(muscle|force|grip|pinch|inclinometry|measurement|assessment)\b/.test(text)) summary.push('clinical measurements');
    if (/\b(device|connection|sensor|calibration)\b/.test(text)) summary.push('device connectivity');
    if (/\b(report|print|cover\s*letter)\b/.test(text)) summary.push('clinical reporting');
    return summary.slice(0, 5);
  }

  private capabilityPurposeBias(primaryDomain: string | undefined, capability: SystemCapability): number {
    const text = [
      capability.name,
      ...(capability.related_domains || []),
      ...(capability.related_entities || []),
    ].join(' ').toLowerCase();
    if (primaryDomain === 'clinical-testing') {
      if (/\b(patient|muscle|measurement|device|force|grip|pinch|inclinometry|report|assessment|test)\b/.test(text)) return 0;
      return 1;
    }
    return 0;
  }

  private descriptionSafeCapabilityName(name: string): string | undefined {
    if (this.isGenericCapabilityDisplayName(name)) return undefined;
    const normalized = name
      .toLowerCase()
      .replace(/_/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!normalized || /[()[\]{}<>'"`:]|\.with\b/i.test(normalized)) return undefined;
    if (/\b(management|capability|commands|handlers|tasks)\b/.test(normalized)) {
      const suffix = normalized.match(/\b(commands|handlers|tasks)\b/)?.[1] || 'management';
      const subject = normalized
        .replace(/\b(management|capability|commands|handlers|tasks)\b/g, ' ')
        .split(/\s+/)
        .map(token => this.normalizeDomainToken(token))
        .filter(token => token && !this.isGenericCapabilityToken(token))
        .join(' ')
        .trim();
      if (!subject || subject.split(/\s+/).every(token => this.isGenericCapabilityToken(this.normalizeDomainToken(token)))) {
        return undefined;
      }
      if (suffix === 'handlers') return `${this.singularizeSummarySubject(subject)} handling`;
      if (suffix === 'tasks') return `${this.singularizeSummarySubject(subject)} tasks`;
      if (suffix === 'commands') return `${this.singularizeSummarySubject(subject)} commands`;
      return `${this.singularizeSummarySubject(subject)} ${suffix}`;
    }
    return normalized;
  }

  private singularizeSummarySubject(subject: string): string {
    return subject
      .split(/\s+/)
      .map(token => {
        if (token.endsWith('ies') && token.length > 5) return token.replace(/ies$/, 'y');
        if (token.length > 4 && !/(ss|ics|us|rs)$/.test(token) && token.endsWith('s')) return token.slice(0, -1);
        return token;
      })
      .join(' ');
  }

  private isFirstCapabilitySummaryVariant(name: string, index: number, names: string[]): boolean {
    const key = name
      .replace(/\b(management|capability|commands|handlers|tasks)\b/g, ' ')
      .replace(/\b([a-z]+)ies\b/g, '$1y')
      .replace(/\b([a-z]+)s\b/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    return names.findIndex(candidate => candidate
      .replace(/\b(management|capability|commands|handlers|tasks)\b/g, ' ')
      .replace(/\b([a-z]+)ies\b/g, '$1y')
      .replace(/\b([a-z]+)s\b/g, '$1')
      .replace(/\s+/g, ' ')
      .trim() === key) === index;
  }

  private isCrossCuttingCapabilityName(name: string): boolean {
    return /\b(auth|authenticate|authentication|authorization|login|logout|session|token|jwt|oauth|permission|role|superuser|admin|user|users)\b/i.test(name);
  }

  private isGenericCapabilityDisplayName(name: string): boolean {
    if (/\b(bin\/console|console commands?|event(s)? handlers?|message handlers?|route handlers?)\b/i.test(name)) return true;
    if (/^(help management|report reporting|jobs? workflow)$/i.test(name)) return true;
    if (/^dismiss[_\s]/i.test(name)) return true;
    if (/^(action[_\s]?text|active[_\s]?storage|action[_\s]?cable|action[_\s]?mailbox)\b/i.test(name)) return true;
    if (/[()[\]{}<>'"`:]|\.with\b/i.test(name)) return true;
    const subject = name
      .toLowerCase()
      .replace(/\b(management|capability|authentication|reporting|commands|handlers|tasks|workflow)\b/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    if (!subject) return true;
    return subject
      .split(/\s+/)
      .map(token => this.normalizeDomainToken(token))
      .every(token => token.length <= 2 || this.isGenericCapabilityToken(token) || /^(toggle|success|failure|misc|root|read|write|use|used|using|item|items|flat|tiered|available|bogus)$/.test(token));
  }


  private summarizeEntryPoints(entryPoints: CASEntryPoint[]): { type: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const ep of entryPoints) {
      counts.set(ep.type, (counts.get(ep.type) || 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count);
  }

  private buildFlowGraph(
    entryPoints: CASEntryPoint[],
    callChains: CASCallChain[],
    nodes: CASNode[],
    edges: CASEdge[],
    domainConcepts: CASDomainConcept[],
    dataEntities: CASDataEntity[],
    databaseSchema: CASDatabaseSchema,
    systemPurpose: SystemPurpose
  ): CASFlowGraph {
    const capabilityDetector = new CapabilityDetector();
    const capabilities = capabilityDetector.detectCapabilities(
      entryPoints,
      callChains,
      nodes,
      edges,
      domainConcepts,
      dataEntities
    );

    const chainAnalyzer = new CallChainAnalyzer();
    for (const cap of capabilities) {
      cap.complexity_profile = chainAnalyzer.analyzeCapabilityChains(cap, callChains, nodes);
    }

    const dependencyBuilder = new CapabilityDependencyBuilder();
    const dependencies = dependencyBuilder.buildDependencies(
      capabilities,
      nodes,
      edges,
      dataEntities,
      databaseSchema
    );

    const capabilitiesById = new Map(capabilities.map(cap => [cap.id, cap]));
    for (const dep of dependencies) {
      const fromCap = capabilitiesById.get(dep.from_capability);
      if (fromCap) {
        fromCap.depends_on.push(dep);
      }

      const toCap = capabilitiesById.get(dep.to_capability);
      if (toCap) {
        toCap.depended_by.push(dep.from_capability);
      }
    }

    const scorer = new FlowScorer();
    scorer.scoreCapabilities(capabilities, domainConcepts, systemPurpose);

    const graphBuilder = new FlowGraphBuilder();
    return graphBuilder.buildFlowGraph(capabilities, dependencies, systemPurpose);
  }

  private buildChangeRisks(nodes: CASNode[], edges: CASEdge[], entryPoints: CASEntryPoint[], gitAnalyzer?: GitAnalyzer): CASChangeRisk[] {
    const changeRisks: CASChangeRisk[] = [];
    const callerCounts = new Map<string, string[]>();
    const gitAvailable = gitAnalyzer?.isAvailable() || false;
    const externalDependencySources = new Set<string>();
    const entryNodeIds = new Set<string>();
    const entryFiles = new Set<string>();
    for (const entryPoint of entryPoints) {
      if (entryPoint.source_node) entryNodeIds.add(entryPoint.source_node);
      if (entryPoint.handler?.node_id) entryNodeIds.add(entryPoint.handler.node_id);
      if (entryPoint.handler?.file) entryFiles.add(entryPoint.handler.file.replace(/\\/g, '/').toLowerCase());
    }

    for (const edge of edges) {
      if (edge.type === 'calls' || edge.type === 'uses' || edge.type === 'depends_on') {
        if (!callerCounts.has(edge.target)) {
          callerCounts.set(edge.target, []);
        }
        callerCounts.get(edge.target)!.push(edge.source);
      }
      if (edge.type === 'external_call' || edge.category === 'external') {
        externalDependencySources.add(edge.source);
      }
    }

    const riskableNodeTypes = [
      'function', 'method', 'service', 'controller', 'serializer',
      'entity', 'model', 'route', 'handler', 'resolver', 'mutation', 'repository'
    ];

    for (const node of nodes.filter(node => this.isPrimaryProductNode(node))) {
      if (!riskableNodeTypes.includes(node.type)) {
        continue;
      }

      const directCallers = callerCounts.get(node.id) || [];
      const file = node.source?.file?.replace(/\\/g, '/').toLowerCase() || '';
      const nameLower = node.name.toLowerCase();
      const isEntryRelated = node.type === 'controller' ||
        node.type === 'route' ||
        node.type === 'handler' ||
        entryNodeIds.has(node.id) ||
        (file && entryFiles.has(file));
      const isDataRelated = node.type === 'entity' || node.type === 'model' || node.type === 'serializer';
      const isRepository = node.type === 'repository' || /repository|repo|dao|gateway|store/.test(`${node.type} ${node.name} ${file}`.toLowerCase());
      const isDomainService = node.type === 'service' || /service|manager|usecase|processor|workflow/.test(`${node.type} ${node.name} ${file}`.toLowerCase());
      const isCriticalDomain = /\b(auth|oauth|token|password|permission|role|security|invoice|billing|payment|charge|subscription|fuel|vehicle|driver|trip|dispatch|maintenance|customer|partner)\b/i.test(`${node.name} ${file}`);
      const isSecuritySensitiveName = /\b(auth|oauth|token|password|permission|role|security|credential)\b/i.test(`${node.name} ${file}`);
      const isDataMutationName = /\b(create|update|delete|remove|save|persist|flush|store|charge|refund|sync|dispatch|send|process|generate|validate)\b/i.test(node.name);
      const isAccessorLikeMethod = node.type === 'method' && /^(get|set|is|has|can|count|add)[A-Z_]/.test(node.name);
      const nodeComplexity = node.metadata?.complexity?.cyclomatic || 0;
      const hasExternalDep = externalDependencySources.has(node.id);

      if (isAccessorLikeMethod && !isSecuritySensitiveName && !isDataMutationName && !hasExternalDep && nodeComplexity < 10) {
        continue;
      }

      if (directCallers.length < 2 && !node.metadata?.is_exported && !isEntryRelated && !isDataRelated && !isRepository && !isDomainService && !isCriticalDomain) {
        continue;
      }

      const filePath = node.source?.file;
      const gitMetrics = filePath && gitAvailable ? gitAnalyzer?.getFileMetrics(filePath) : null;

      const riskFactors: Array<{
        factor: 'many-callers' | 'critical-path' | 'high-traffic' | 'no-tests' | 'recent-bugs' | 'complex-logic' | 'external-dependency' | 'security-sensitive';
        severity: 'high' | 'medium' | 'low';
        details: string;
      }> = [];

      if (directCallers.length > 10) {
        riskFactors.push({
          factor: 'many-callers',
          severity: 'high',
          details: `Called by ${directCallers.length} functions`
        });
      } else if (directCallers.length > 5) {
        riskFactors.push({
          factor: 'many-callers',
          severity: 'medium',
          details: `Called by ${directCallers.length} functions`
        });
      }

      if (isEntryRelated) {
        riskFactors.push({
          factor: 'critical-path',
          severity: isCriticalDomain ? 'high' : 'medium',
          details: 'Entry-point or handler surface; changes can affect externally visible behavior'
        });
      }

      if (isDataRelated || isRepository) {
        riskFactors.push({
          factor: 'critical-path',
          severity: isCriticalDomain ? 'high' : 'medium',
          details: 'Data model or data access surface; changes can affect persistence and downstream consumers'
        });
      }

      const complexity = nodeComplexity;
      if (complexity > 20) {
        riskFactors.push({
          factor: 'complex-logic',
          severity: 'high',
          details: `Cyclomatic complexity: ${complexity}`
        });
      } else if (complexity > 10) {
        riskFactors.push({
          factor: 'complex-logic',
          severity: 'medium',
          details: `Cyclomatic complexity: ${complexity}`
        });
      }

      if (hasExternalDep) {
        riskFactors.push({
          factor: 'external-dependency',
          severity: 'medium',
          details: 'Has external service dependencies'
        });
      }

      if (node.security?.authentication_required ||
        node.security?.authorization_roles ||
        isSecuritySensitiveName) {
        riskFactors.push({
          factor: 'security-sensitive',
          severity: 'high',
          details: 'Handles security-sensitive operations'
        });
      }

      if (isCriticalDomain && !riskFactors.some(factor => factor.factor === 'critical-path')) {
        riskFactors.push({
          factor: 'critical-path',
          severity: 'medium',
          details: 'Domain name suggests business-critical fleet, billing, identity, or operational behavior'
        });
      }

      if (gitMetrics && gitMetrics.bugFixRate > 0.3) {
        riskFactors.push({
          factor: 'recent-bugs',
          severity: 'high',
          details: `Bug fix density: ${Math.round(gitMetrics.bugFixRate * 100)}% of commits are bug fixes`
        });
      }

      if (!node.testing?.tested_by?.length) {
        riskFactors.push({
          factor: 'no-tests',
          severity: 'high',
          details: 'No direct test coverage detected'
        });
      }

      const dedupedRiskFactors = this.dedupeChangeRiskFactors(riskFactors as any);
      if (dedupedRiskFactors.length === 0) continue;

      const highSeverityCount = dedupedRiskFactors.filter(f => f.severity === 'high').length;
      const riskLevel: 'critical' | 'high' | 'medium' | 'low' =
        highSeverityCount >= 2 ? 'critical' :
        highSeverityCount === 1 ? 'high' :
        dedupedRiskFactors.length >= 2 ? 'medium' : 'low';

      changeRisks.push({
        node_id: node.id,
        risk_level: riskLevel,
        risk_factors: dedupedRiskFactors,
        downstream_impact: {
          direct_callers: directCallers,
          transitive_callers: [],
          affected_call_chains: [],
          affected_entry_points: []
        },
        test_protection: {
          has_direct_tests: node.testing?.tested_by?.length ? node.testing.tested_by.length > 0 : false,
          has_integration_tests: false,
          test_ids: node.testing?.tested_by
        },
        stability_context: {
          recent_churn: gitMetrics ? gitMetrics.isHighChurn : false,
          commit_count_30d: gitMetrics?.commits30d || 0,
          bug_fix_density: gitMetrics?.bugFixRate || 0,
          last_refactor: gitMetrics?.lastMajorChange || undefined
        },
        recommendations: this.recommendationsForChangeRisk(node, dedupedRiskFactors)
      });
    }

    return this.collapseChangeRisksByOwner(changeRisks, nodes)
      .sort((a, b) => {
        const order = { critical: 0, high: 1, medium: 2, low: 3 };
        const factorWeight = (risk: CASChangeRisk) => risk.risk_factors.reduce((total, factor) => total + (factor.severity === 'high' ? 3 : factor.severity === 'medium' ? 2 : 1), 0);
        return order[a.risk_level] - order[b.risk_level] ||
          factorWeight(b) - factorWeight(a) ||
          b.downstream_impact.direct_callers.length - a.downstream_impact.direct_callers.length;
      })
      .slice(0, 100);
  }

  private collapseChangeRisksByOwner(changeRisks: CASChangeRisk[], nodes: CASNode[]): CASChangeRisk[] {
    const nodesById = new Map(nodes.map(node => [node.id, node]));
    const grouped = new Map<string, CASChangeRisk[]>();
    for (const risk of changeRisks) {
      const node = nodesById.get(risk.node_id);
      const ownerId = node?.type === 'method' && node.parent ? node.parent : risk.node_id;
      if (!grouped.has(ownerId)) grouped.set(ownerId, []);
      grouped.get(ownerId)!.push(risk);
    }

    const collapsed: CASChangeRisk[] = [];
    for (const [ownerId, risks] of grouped) {
      if (risks.length === 1 && risks[0].node_id === ownerId) {
        collapsed.push(risks[0]);
        continue;
      }

      const ownerNode = nodesById.get(ownerId);
      const riskFactors = this.dedupeChangeRiskFactors(risks.flatMap(risk => risk.risk_factors));
      const directCallers = Array.from(new Set(risks.flatMap(risk => risk.downstream_impact.direct_callers)));
      const transitiveCallers = Array.from(new Set(risks.flatMap(risk => risk.downstream_impact.transitive_callers)));
      const affectedChains = Array.from(new Set(risks.flatMap(risk => risk.downstream_impact.affected_call_chains)));
      const affectedEntries = Array.from(new Set(risks.flatMap(risk => risk.downstream_impact.affected_entry_points)));
      const testIds = Array.from(new Set(risks.flatMap(risk => risk.test_protection.test_ids || [])));
      const highSeverityCount = riskFactors.filter(factor => factor.severity === 'high').length;
      const riskLevel: CASChangeRisk['risk_level'] =
        highSeverityCount >= 2 ? 'critical' :
        highSeverityCount === 1 ? 'high' :
        riskFactors.length >= 2 ? 'medium' : 'low';

      collapsed.push({
        node_id: ownerId,
        risk_level: riskLevel,
        risk_factors: riskFactors,
        downstream_impact: {
          direct_callers: directCallers,
          transitive_callers: transitiveCallers,
          affected_call_chains: affectedChains,
          affected_entry_points: affectedEntries,
        },
        test_protection: {
          has_direct_tests: risks.some(risk => risk.test_protection.has_direct_tests),
          has_integration_tests: risks.some(risk => risk.test_protection.has_integration_tests),
          test_ids: testIds.length > 0 ? testIds : undefined,
        },
        stability_context: {
          recent_churn: risks.some(risk => risk.stability_context.recent_churn),
          commit_count_30d: Math.max(...risks.map(risk => risk.stability_context.commit_count_30d)),
          bug_fix_density: Math.max(...risks.map(risk => risk.stability_context.bug_fix_density)),
          last_refactor: risks.find(risk => risk.stability_context.last_refactor)?.stability_context.last_refactor,
        },
        recommendations: this.recommendationsForChangeRisk(ownerNode || nodesById.get(risks[0].node_id) || ({ id: ownerId, name: ownerId, type: 'node' } as CASNode), riskFactors),
      });
    }
    return collapsed;
  }

  private dedupeChangeRiskFactors(riskFactors: ChangeRiskFactor[]): ChangeRiskFactor[] {
    const severityScore = { high: 3, medium: 2, low: 1 };
    const byFactor = new Map<ChangeRiskFactor['factor'], ChangeRiskFactor>();
    for (const factor of riskFactors) {
      const existing = byFactor.get(factor.factor);
      if (!existing || severityScore[factor.severity] > severityScore[existing.severity]) {
        byFactor.set(factor.factor, factor);
      }
    }
    return Array.from(byFactor.values());
  }

  private recommendationsForChangeRisk(
    node: CASNode,
    riskFactors: Array<{ factor: ChangeRiskFactor['factor']; severity: ChangeRiskFactor['severity']; details: string }>
  ): string[] {
    const recommendations = new Set<string>();
    if (riskFactors.some(factor => factor.factor === 'no-tests')) {
      recommendations.add(`Find or add focused tests around ${node.name} before changing it.`);
    }
    if (riskFactors.some(factor => factor.factor === 'critical-path')) {
      recommendations.add('Inspect entry points, data lifecycle, and downstream callers before editing this node.');
    }
    if (riskFactors.some(factor => factor.factor === 'security-sensitive')) {
      recommendations.add('Preserve authentication, authorization, tenant, and token handling invariants.');
    }
    if (riskFactors.some(factor => factor.factor === 'external-dependency')) {
      recommendations.add('Check integration contracts and failure handling for external calls.');
    }
    if (riskFactors.some(factor => factor.factor === 'complex-logic')) {
      recommendations.add('Prefer small behavior-preserving changes and add regression coverage for branch-heavy paths.');
    }
    return Array.from(recommendations).slice(0, 5);
  }

  private buildChangeRiskSummary(changeRisks: CASChangeRisk[]): CASChangeRiskSummary {
    return {
      high_risk_nodes: changeRisks
        .filter(r => r.risk_level === 'critical' || r.risk_level === 'high')
        .map(r => r.node_id),
      untested_critical_paths: changeRisks
        .filter(r => r.risk_level === 'critical' && !r.test_protection.has_direct_tests)
        .map(r => r.node_id),
      recent_hotspots: changeRisks
        .filter(r => r.stability_context.recent_churn)
        .map(r => r.node_id)
    };
  }

  private buildDataEntities(nodes: CASNode[], edges: CASEdge[], projectPath?: string): CASDataEntity[] {
    const entities: CASDataEntity[] = [];

    const entityNodes = nodes.filter(n =>
      (!projectPath || this.isPrimaryProductNodeForProject(n, projectPath)) &&
      !n.subcategories?.includes('abstract') &&
      (
        n.type === 'entity' ||
        n.type === 'model' ||
        n.subcategories?.includes('entity') ||
        (n.type === 'class' && n.source?.file?.includes('/entities/'))
      )
    );

    const propertyIndex = this.buildEntityPropertyIndex(nodes);
    const nodesById = new Map<string, CASNode>();
    for (const node of nodes) {
      if (!nodesById.has(node.id)) nodesById.set(node.id, node);
    }
    const edgesByNode = new Map<string, CASEdge[]>();
    const addEdgeToBucket = (nodeId: string, edge: CASEdge) => {
      let bucket = edgesByNode.get(nodeId);
      if (!bucket) {
        bucket = [];
        edgesByNode.set(nodeId, bucket);
      }
      bucket.push(edge);
    };
    for (const edge of edges) {
      addEdgeToBucket(edge.source, edge);
      if (edge.target !== edge.source) addEdgeToBucket(edge.target, edge);
    }

    for (const entityNode of entityNodes) {
      const fields: Array<{
        name: string;
        type: string;
        is_sensitive: boolean;
        validation?: string[];
      }> = [];

      const propertyNodes = this.entityPropertyNodesFromIndex(propertyIndex, entityNode);

      const sensitivePatterns = [
        'password', 'secret', 'token', 'key', 'credential',
        'ssn', 'social_security', 'tax_id',
        'email', 'phone', 'address',
        'card', 'cvv', 'account_number'
      ];

      for (const prop of propertyNodes) {
        const nameLower = prop.name.toLowerCase();
        const analyzerFlag = (prop.metadata?.attributes as Record<string, unknown> | undefined)?.sensitive;
        const isSensitive = analyzerFlag === true || sensitivePatterns.some(p => nameLower.includes(p));

        fields.push({
          name: prop.name,
          type: prop.signature?.return_type || 'unknown',
          is_sensitive: isSensitive
        });
      }

      const createdBy: string[] = [];
      const readBy: string[] = [];
      const updatedBy: string[] = [];
      const deletedBy: string[] = [];

      const lifecycleBucketForEdgeType = (edgeType: string): string[] | undefined => {
        if (edgeType === 'creates') return createdBy;
        if (edgeType === 'updates' || edgeType === 'writes' || edgeType === 'persists' || edgeType === 'saves' || edgeType === 'mutates') return updatedBy;
        if (edgeType === 'deletes') return deletedBy;
        if (edgeType === 'reads' || edgeType === 'queries') return readBy;
        return undefined;
      };
      const structuralEdgeTypes = new Set([
        'has_field', 'has_attribute', 'imports', 'inherits', 'exposes', 'maps_to', 'wraps', 'relates_to', 'contains'
      ]);
      const accessFromNodeName = (name: string): string[] | undefined => {
        const words = name
          .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter(Boolean);
        const hasAny = (...verbs: string[]) => words.some(word => verbs.includes(word));
        if (hasAny('create', 'creates', 'created', 'add', 'adds', 'added', 'insert', 'inserts')) return createdBy;
        if (hasAny('get', 'gets', 'find', 'finds', 'read', 'reads', 'fetch', 'fetches', 'list', 'lists', 'show', 'index')) return readBy;
        if (hasAny('update', 'updates', 'set', 'sets', 'modify', 'modifies', 'save', 'saves')) return updatedBy;
        if (hasAny('delete', 'deletes', 'remove', 'removes', 'destroy', 'destroys')) return deletedBy;
        return undefined;
      };

      for (const edge of edgesByNode.get(entityNode.id) || []) {
        {
          if (edge.target === entityNode.id) {
            const bucket = lifecycleBucketForEdgeType(edge.type);
            if (bucket) {
              bucket.push(edge.source);
              continue;
            }
          }
          if (structuralEdgeTypes.has(edge.type)) continue;
          const relatedNode = nodesById.get(edge.target === entityNode.id ? edge.source : edge.target);
          if (relatedNode) {
            const bucket = accessFromNodeName(relatedNode.name);
            if (bucket) bucket.push(relatedNode.id);
          }
        }
      }

      entities.push({
        id: `entity_${entityNode.name.toLowerCase()}`,
        name: entityNode.name,
        schema_source: entityNode.source?.file,
        fields: fields.length > 0 ? fields : undefined,
        lifecycle: {
          created_by: [...new Set(createdBy)],
          read_by: [...new Set(readBy)],
          updated_by: [...new Set(updatedBy)],
          deleted_by: [...new Set(deletedBy)]
        }
      });
    }

    return entities;
  }

  private buildDataSummary(entities: CASDataEntity[], nodes: CASNode[]): CASDataSummary {
    const sensitiveDataNodes: string[] = [];

    for (const entity of entities) {
      if (entity.fields?.some(f => f.is_sensitive)) {
        sensitiveDataNodes.push(
          ...entity.lifecycle.created_by,
          ...entity.lifecycle.read_by,
          ...entity.lifecycle.updated_by
        );
      }
    }

    return {
      entities,
      sensitive_data_nodes: [...new Set(sensitiveDataNodes)],
      validation_gaps: []
    };
  }

  private buildBehavioralInvariants(
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    databaseSchema: CASDatabaseSchema,
    dataEntities: CASDataEntity[],
    securityBoundaries: CASSecurityBoundary[],
    testSuites: CASTestSuite[],
    projectPath: string
  ): CASBehavioralInvariant[] {
    const invariants: CASBehavioralInvariant[] = [];
    const migrationFiles = this.detectMigrationFiles(nodes, projectPath);

    for (const entity of this.scopedEntities(databaseSchema, dataEntities)) {
      const scopeFields = entity.fields.filter(field => this.isScopeField(field.name));
      const uniqueFields = entity.fields.filter(field => field.unique && !this.isScopeField(field.name));
      const relatedNodes = this.nodesRelatedToEntity(nodes, entity.name);
      const scopedCodeNodes = relatedNodes.filter(node => this.nodeText(node).match(/\b(tenant|organization|organisation|org|workspace|account|company)id\b/i));
      const relatedTests = this.testsRelatedToInvariant(testSuites, [
        entity.name,
        ...scopeFields.map(field => field.name),
        ...uniqueFields.map(field => field.name),
      ]);
      const gaps = [
        ...(scopedCodeNodes.length === 0 ? [`No code enforcement found for ${entity.name} tenant/organization scope.`] : []),
        ...uniqueFields.map(field => `Unique field ${field.name} appears on tenant-scoped entity ${entity.name}; verify a composite unique constraint or service preflight includes ${scopeFields.map(scope => scope.name).join(', ')}.`),
        ...(relatedTests.length === 0 ? [`No tests found that mention ${entity.name} scope or uniqueness.`] : []),
      ];

      invariants.push({
        id: `invariant_tenant_scope_${this.slugForId(entity.name)}`,
        name: `${entity.name} tenant/organization scope`,
        invariant_type: 'tenant-scope',
        description: `${entity.name} records appear scoped by ${scopeFields.map(field => field.name).join(', ')}, so reads and uniqueness checks should preserve that scope.`,
        scope: {
          entity_names: [entity.name],
          field_names: [...scopeFields.map(field => field.name), ...uniqueFields.map(field => field.name)],
          node_ids: relatedNodes.map(node => node.id).slice(0, 30),
          file_paths: [...new Set([entity.source_file, ...relatedNodes.map(node => node.source?.file)].filter((file): file is string => Boolean(file)))],
        },
        enforcement: [
          ...scopeFields.map(field => ({
            source: 'database-schema' as const,
            mechanism: `${field.name} scopes ${entity.name}`,
            confidence: 'inferred' as const,
            file: entity.source_file,
          })),
          ...scopedCodeNodes.slice(0, 12).map(node => ({
            source: 'code' as const,
            mechanism: `${node.name} references tenant/organization scope`,
            confidence: 'inferred' as const,
            node_id: node.id,
            file: node.source?.file,
            line: node.source?.line,
          })),
        ],
        evidence: [
          ...scopeFields.map(field => ({
            source: 'database_schema' as const,
            id: `${entity.name}.${field.name}`,
            file: entity.source_file,
          })),
          ...scopedCodeNodes.slice(0, 8).map(node => ({
            source: 'node' as const,
            id: node.id,
            file: node.source?.file,
            line: node.source?.line,
          })),
        ],
        related_tests: relatedTests,
        related_entities: [entity.name],
        gaps,
        confidence: scopedCodeNodes.length > 0 && gaps.length <= uniqueFields.length ? 'medium' : 'low',
      });
    }

    for (const entity of databaseSchema.entities || []) {
      for (const field of entity.fields || []) {
        if (!field.primary && !field.unique && field.nullable === undefined && field.default === undefined) continue;
        const mechanisms = [
          field.primary ? 'primary key' : '',
          field.unique ? 'unique' : '',
          field.nullable === false ? 'not nullable' : '',
          field.default ? `default ${field.default}` : '',
        ].filter(Boolean);
        invariants.push({
          id: `invariant_db_constraint_${this.slugForId(entity.name)}_${this.slugForId(field.name)}`,
          name: `${entity.name}.${field.name} database constraint`,
          invariant_type: 'db-constraint',
          description: `${entity.name}.${field.name} has database/ORM constraint semantics: ${mechanisms.join(', ')}.`,
          scope: {
            entity_names: [entity.name],
            field_names: [field.name],
            file_paths: entity.source_file ? [entity.source_file] : undefined,
          },
          enforcement: [{
            source: 'database-schema',
            mechanism: mechanisms.join(', '),
            confidence: 'enforced',
            file: entity.source_file,
          }],
          evidence: [{
            source: 'database_schema',
            id: `${entity.name}.${field.name}`,
            file: entity.source_file,
          }],
          related_tests: this.testsRelatedToInvariant(testSuites, [entity.name, field.name]),
          related_entities: [entity.name],
          confidence: 'high',
        });
      }
    }

    for (const boundary of securityBoundaries) {
      invariants.push({
        id: `invariant_security_${this.slugForId(boundary.id)}`,
        name: boundary.name,
        invariant_type: boundary.boundary_type === 'authorization' ? 'authorization' :
          boundary.boundary_type === 'tenant-isolation' ? 'tenant-scope' : 'auth-boundary',
        description: `${boundary.name} moves trust from ${boundary.trust_transition.from_trust_level} to ${boundary.trust_transition.to_trust_level}.`,
        scope: {
          node_ids: boundary.enforcement_points.map(point => point.node_id).filter(id => id !== 'entry_point_security'),
          entry_point_ids: entryPoints
            .filter(entry => boundary.sensitive_operations.includes(entry.source_node))
            .map(entry => entry.id),
        },
        enforcement: boundary.enforcement_points.map(point => ({
          source: 'security-boundary',
          mechanism: point.mechanism,
          confidence: point.confidence === 'enforced' ? 'enforced' : point.confidence === 'missing' ? 'missing' : 'inferred',
          node_id: point.node_id === 'entry_point_security' ? undefined : point.node_id,
        })),
        evidence: boundary.enforcement_points.map(point => ({
          source: 'security_boundary' as const,
          id: boundary.id,
          file: this.nodeFile(nodes, point.node_id),
          line: this.nodeLine(nodes, point.node_id),
        })),
        related_boundaries: [boundary.id],
        gaps: boundary.bypass_risks,
        confidence: boundary.enforcement_points.some(point => point.confidence === 'enforced') ? 'high' : 'medium',
      });
    }

    const messageEntryPoints = entryPoints.filter(entry => entry.type === 'message');
    if (messageEntryPoints.length > 0) {
      const messageNodeIds = [...new Set(messageEntryPoints.map(entry => entry.source_node).filter(Boolean))];
      const messageFiles = [...new Set(messageNodeIds.map(nodeId => this.nodeFile(nodes, nodeId)).filter((file): file is string => Boolean(file)))];
      const messageNames = messageEntryPoints.flatMap(entry => [
        entry.name,
        entry.trigger?.event,
        entry.input?.type,
      ]).filter((value): value is string => Boolean(value));
      const relatedTests = this.testsRelatedToInvariant(testSuites, messageNames);

      invariants.push({
        id: 'invariant_message_handler_contracts',
        name: 'Message handlers preserve queue/event contracts',
        invariant_type: 'business-rule',
        description: 'Message entry points should keep their queue/event input contracts, handler semantics, downstream dispatches, and validation behavior aligned.',
        scope: {
          node_ids: messageNodeIds.slice(0, 50),
          entry_point_ids: messageEntryPoints.map(entry => entry.id).slice(0, 50),
          file_paths: messageFiles.slice(0, 50),
        },
        enforcement: messageEntryPoints.slice(0, 30).map(entry => ({
          source: 'code' as const,
          mechanism: `${entry.name} handles ${entry.input?.type || entry.trigger?.event || 'message input'}`,
          confidence: 'inferred' as const,
          node_id: entry.source_node,
          file: this.nodeFile(nodes, entry.source_node),
          line: this.nodeLine(nodes, entry.source_node),
        })),
        evidence: messageEntryPoints.slice(0, 30).map(entry => ({
          source: 'entry_point' as const,
          id: entry.id,
          file: this.nodeFile(nodes, entry.source_node),
          line: this.nodeLine(nodes, entry.source_node),
        })),
        related_tests: relatedTests,
        gaps: relatedTests.length === 0 ? ['No tests found that mention message-handler queue/event contracts.'] : undefined,
        confidence: relatedTests.length > 0 ? 'medium' : 'low',
      });
    }

    const cliEntryPoints = entryPoints.filter(entry => entry.type === 'cli');
    const scriptEntryNodes = cliEntryPoints.length > 0 ? [] : nodes.filter(node => {
      const file = (node.source?.file || '').replace(/\\/g, '/').toLowerCase();
      return !node.metadata?.is_test &&
        !node.metadata?.is_generated &&
        (/(\b|\/)(main|index|cli|script|bot|runner)\.(cjs|mjs|js|jsx|ts|tsx|py|rb|php|rs|go)$/.test(file) ||
          /(^|\/)(bin|cli|cmd|commands|scripts?|jobs|workers)\//.test(file));
    });
    if (cliEntryPoints.length > 0 || scriptEntryNodes.length > 0) {
      const cliNodeIds = [...new Set(cliEntryPoints.map(entry => entry.source_node).filter(Boolean))];
      const cliFiles = [...new Set([
        ...cliNodeIds.map(nodeId => this.nodeFile(nodes, nodeId)),
        ...scriptEntryNodes.map(node => node.source?.file),
      ].filter((file): file is string => Boolean(file)))];
      const cliNames = cliEntryPoints.flatMap(entry => [
        entry.name,
        (entry.trigger as any)?.command,
        entry.input?.type,
      ]).filter((value): value is string => Boolean(value));
      const relatedTests = this.testsRelatedToInvariant(testSuites, cliNames);

      invariants.push({
        id: 'invariant_cli_entrypoint_contracts',
        name: 'CLI entry points preserve command contracts',
        invariant_type: 'business-rule',
        description: 'CLI entry points should keep command names, accepted inputs, orchestration semantics, side effects, and validation behavior aligned.',
        scope: {
          node_ids: [...new Set([...cliNodeIds, ...scriptEntryNodes.map(node => node.id)])].slice(0, 50),
          entry_point_ids: cliEntryPoints.map(entry => entry.id).slice(0, 50),
          file_paths: cliFiles.slice(0, 50),
        },
        enforcement: [
          ...cliEntryPoints.slice(0, 30).map(entry => ({
            source: 'code' as const,
            mechanism: `${entry.name} handles ${(entry.trigger as any)?.command || entry.input?.type || 'CLI invocation'}`,
            confidence: 'inferred' as const,
            node_id: entry.source_node,
            file: this.nodeFile(nodes, entry.source_node),
            line: this.nodeLine(nodes, entry.source_node),
          })),
          ...scriptEntryNodes.slice(0, 30).map(node => ({
            source: 'code' as const,
            mechanism: `${node.source?.file || node.name} appears to be an executable script entry file`,
            confidence: 'inferred' as const,
            node_id: node.id,
            file: node.source?.file,
            line: node.source?.line,
          })),
        ],
        evidence: [
          ...cliEntryPoints.slice(0, 30).map(entry => ({
            source: 'entry_point' as const,
            id: entry.id,
            file: this.nodeFile(nodes, entry.source_node),
            line: this.nodeLine(nodes, entry.source_node),
          })),
          ...scriptEntryNodes.slice(0, 30).map(node => ({
            source: 'node' as const,
            id: node.id,
            file: node.source?.file,
            line: node.source?.line,
          })),
        ],
        related_tests: relatedTests,
        gaps: relatedTests.length === 0 ? ['No tests found that mention CLI command contracts.'] : undefined,
        confidence: relatedTests.length > 0 ? 'medium' : 'low',
      });
    }

    const pageEntryPoints = entryPoints.filter(entry => entry.type === 'page' || entry.type === 'route');
    if (pageEntryPoints.length > 0) {
      const pageNodeIds = [...new Set(pageEntryPoints.map(entry => entry.source_node).filter(Boolean))];
      const pageFiles = [...new Set(pageEntryPoints.flatMap(entry => [
        this.nodeFile(nodes, entry.source_node),
        entry.handler?.file,
        (entry.metadata as any)?.pageFile,
        (entry.metadata as any)?.routeFile,
      ]).filter((file): file is string => Boolean(file)))];
      const pageNames = pageEntryPoints.flatMap(entry => [
        entry.name,
        entry.trigger?.path,
        entry.handler?.method_name,
      ]).filter((value): value is string => Boolean(value));
      const relatedTests = this.testsRelatedToInvariant(testSuites, pageNames);

      invariants.push({
        id: 'invariant_ui_entrypoint_contracts',
        name: 'UI entry points preserve route and rendering contracts',
        invariant_type: 'business-rule',
        description: 'Page and route entry points should preserve route paths, render ownership, data-loading behavior, and user-visible interaction contracts.',
        scope: {
          node_ids: pageNodeIds.slice(0, 50),
          entry_point_ids: pageEntryPoints.map(entry => entry.id).slice(0, 50),
          file_paths: pageFiles.slice(0, 50),
        },
        enforcement: pageEntryPoints.slice(0, 30).map(entry => ({
          source: 'code' as const,
          mechanism: `${entry.name} handles ${entry.trigger?.path || entry.handler?.method_name || 'UI route rendering'}`,
          confidence: 'inferred' as const,
          node_id: entry.source_node,
          file: this.nodeFile(nodes, entry.source_node) || entry.handler?.file || (entry.metadata as any)?.pageFile,
          line: this.nodeLine(nodes, entry.source_node) || entry.handler?.line,
        })),
        evidence: pageEntryPoints.slice(0, 30).map(entry => ({
          source: 'entry_point' as const,
          id: entry.id,
          file: this.nodeFile(nodes, entry.source_node) || entry.handler?.file || (entry.metadata as any)?.pageFile,
          line: this.nodeLine(nodes, entry.source_node) || entry.handler?.line,
        })),
        related_tests: relatedTests,
        gaps: relatedTests.length === 0 ? ['No tests found that mention UI route/page contracts.'] : undefined,
        confidence: relatedTests.length > 0 ? 'medium' : 'low',
      });
    }

    if ((databaseSchema.entities || []).length > 0) {
      invariants.push({
        id: 'invariant_database_migrations',
        name: 'Database schema changes use migrations',
        invariant_type: 'migration-contract',
        description: 'Database shape is represented by ORM schema and should be changed through migration files.',
        scope: {
          entity_names: (databaseSchema.entities || []).map(entity => entity.name),
          file_paths: migrationFiles,
        },
        enforcement: migrationFiles.length > 0
          ? migrationFiles.slice(0, 20).map(file => ({
            source: 'migration' as const,
            mechanism: 'Migration file present',
            confidence: 'enforced' as const,
            file,
          }))
          : [{
            source: 'migration' as const,
            mechanism: 'No migration files detected for database schema',
            confidence: 'missing' as const,
          }],
        evidence: migrationFiles.slice(0, 20).map(file => ({
          source: 'migration_file' as const,
          file,
        })),
        gaps: migrationFiles.length === 0 ? ['Database schema exists but no migration files were detected.'] : undefined,
        confidence: migrationFiles.length > 0 ? 'high' : 'low',
      });
    }

    const coveredNodeIds = new Set<string>();
    for (const suite of testSuites) {
      for (const nodeId of suite.coverage?.nodes_tested || []) coveredNodeIds.add(nodeId);
      for (const test of suite.tests || []) {
        for (const nodeId of test.targets || []) coveredNodeIds.add(nodeId);
      }
    }
    const behaviorNodes = nodes.filter(node => this.isBehaviorNode(node));
    if (behaviorNodes.length > 0 || testSuites.length > 0) {
      const untested = behaviorNodes.filter(node => !coveredNodeIds.has(node.id)).slice(0, 20);
      invariants.push({
        id: 'invariant_behavior_test_coverage',
        name: 'Behavioral code has test coverage evidence',
        invariant_type: 'test-coverage',
        description: 'Controllers, services, repositories, guards, and handlers should have direct or related test evidence.',
        scope: {
          node_ids: behaviorNodes.slice(0, 50).map(node => node.id),
          file_paths: testSuites.slice(0, 20).map(suite => suite.file_path),
        },
        enforcement: testSuites.slice(0, 20).map(suite => ({
          source: 'test' as const,
          mechanism: `${suite.framework} ${suite.test_type} suite ${suite.name}`,
          confidence: 'enforced' as const,
          file: suite.file_path,
        })),
        evidence: testSuites.slice(0, 20).map(suite => ({
          source: 'test_suite' as const,
          id: suite.id,
          file: suite.file_path,
        })),
        related_tests: testSuites.slice(0, 20).map(suite => suite.file_path),
        gaps: untested.length > 0 ? untested.map(node => `${node.name} has no direct test coverage evidence.`) : undefined,
        confidence: testSuites.length > 0 ? 'medium' : 'low',
      });
    }

    return this.dedupeBehavioralInvariants(invariants);
  }

  private buildBehavioralInvariantSummary(invariants: CASBehavioralInvariant[]): CASBehavioralInvariantSummary {
    const byType: Record<string, number> = {};
    const byConfidence: Record<string, number> = {};
    const byGapSeverity: Record<'high' | 'medium' | 'low', number> = { high: 0, medium: 0, low: 0 };
    let enforced = 0;
    let inferred = 0;
    let missing = 0;
    const gaps: CASBehavioralInvariantSummary['gaps'] = [];

    for (const invariant of invariants) {
      byType[invariant.invariant_type] = (byType[invariant.invariant_type] || 0) + 1;
      byConfidence[invariant.confidence] = (byConfidence[invariant.confidence] || 0) + 1;
      for (const enforcement of invariant.enforcement) {
        if (enforcement.confidence === 'enforced') enforced++;
        else if (enforcement.confidence === 'missing') missing++;
        else inferred++;
      }
      for (const gap of invariant.gaps || []) {
        const severity = this.invariantGapSeverity(invariant, gap);
        byGapSeverity[severity]++;
        gaps.push({
          invariant_id: invariant.id,
          gap,
          severity,
        });
      }
    }

    return {
      total: invariants.length,
      by_type: byType,
      by_confidence: byConfidence,
      by_gap_severity: byGapSeverity,
      enforced,
      inferred,
      missing,
      gaps,
    };
  }

  private scopedEntities(databaseSchema: CASDatabaseSchema, dataEntities: CASDataEntity[]) {
    const byName = new Map<string, {
      name: string;
      source_file?: string;
      fields: Array<{ name: string; unique?: boolean; primary?: boolean }>;
    }>();

    for (const entity of databaseSchema.entities || []) {
      byName.set(entity.name, {
        name: entity.name,
        source_file: entity.source_file,
        fields: [
          ...(entity.fields || []).map(field => ({
            name: field.name,
            unique: field.unique,
            primary: field.primary,
          })),
          ...(entity.relationships || []).map(relationship => ({
            name: relationship.field,
          })),
        ],
      });
    }

    for (const entity of dataEntities || []) {
      const existing = byName.get(entity.name) || {
        name: entity.name,
        source_file: entity.schema_source,
        fields: [],
      };
      existing.fields = [
        ...existing.fields,
        ...((entity.fields || []).map(field => ({ name: field.name }))),
      ];
      byName.set(entity.name, existing);
    }

    return [...byName.values()]
      .map(entity => ({
        ...entity,
        fields: this.uniqueFields(entity.fields),
      }))
      .filter(entity => entity.fields.some(field => this.isScopeField(field.name)));
  }

  private uniqueFields(fields: Array<{ name: string; unique?: boolean; primary?: boolean }>) {
    const byName = new Map<string, { name: string; unique?: boolean; primary?: boolean }>();
    for (const field of fields) {
      const key = field.name.toLowerCase();
      const existing = byName.get(key);
      byName.set(key, {
        name: existing?.name || field.name,
        unique: Boolean(existing?.unique || field.unique),
        primary: Boolean(existing?.primary || field.primary),
      });
    }
    return [...byName.values()];
  }

  private isScopeField(name: string): boolean {
    return /^(tenant|tenantid|tenant_id|organization|organizationid|organization_id|organisation|orgid|org_id|workspace|workspaceid|workspace_id|account|accountid|account_id|company|companyid|company_id)$/i.test(name);
  }

  private nodesRelatedToEntity(nodes: CASNode[], entityName: string): CASNode[] {
    const entitySlug = entityName.toLowerCase();
    return nodes.filter(node => {
      const nameText = [
        node.name,
        node.qualified_name,
        node.type,
        ...(node.tags || []),
        ...(node.subcategories || []),
      ].filter(Boolean).join(' ').toLowerCase();
      const file = (node.source?.file || '').replace(/\\/g, '/').toLowerCase();
      const fileBase = file.split('/').pop() || '';
      const fileSegments = file.split('/').filter(Boolean);
      const exactName = new RegExp(`(^|[^a-z0-9])${entitySlug}([^a-z0-9]|$)`).test(nameText);
      const entityDirectory = fileSegments.includes(entitySlug);
      const entityFile = fileBase === `${entitySlug}.ts` ||
        fileBase === `${entitySlug}.js` ||
        fileBase === `${entitySlug}.entity.ts` ||
        fileBase === `${entitySlug}.model.ts` ||
        fileBase.startsWith(`${entitySlug}.`) ||
        fileBase.startsWith(`${entitySlug}-`) ||
        fileBase.startsWith(`${entitySlug}_`);
      const pluralDirectory = entitySlug.length > 4 && fileSegments.includes(`${entitySlug}s`);
      return exactName || entityDirectory || entityFile || pluralDirectory;
    });
  }

  private testsRelatedToInvariant(testSuites: CASTestSuite[], keywords: string[]): string[] {
    const terms = keywords.map(keyword => keyword.toLowerCase()).filter(Boolean);
    return [...new Set(testSuites
      .filter(suite => {
        const text = [
          suite.name,
          suite.file_path,
          ...(suite.tests || []).map(test => test.name),
          ...(suite.tests || []).flatMap(test => test.assertions?.map(assertion => assertion.description || assertion.target || '') || []),
        ].join(' ').toLowerCase();
        return terms.some(term => text.includes(term));
      })
      .map(suite => suite.file_path))];
  }

  private detectMigrationFiles(nodes: CASNode[], projectPath: string): string[] {
    const fromNodes = nodes
      .map(node => node.source?.file)
      .filter((file): file is string => Boolean(file))
      .filter(file => this.isMigrationFile(file));
    const fromDisk = [
      'migrations/**/*',
      'migration/**/*',
      'database/migrations/**/*',
      'prisma/migrations/**/*',
      'db/migrations/**/*',
      'src/migrations/**/*',
    ].flatMap(pattern => {
      try {
        return glob.sync(pattern, {
          cwd: projectPath,
          nodir: true,
          ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**'],
        });
      } catch {
        return [];
      }
    });
    return [...new Set([...fromNodes, ...fromDisk].map(file => file.replace(/\\/g, '/')))].slice(0, 100);
  }

  private isMigrationFile(file: string): boolean {
    const lower = file.toLowerCase();
    return lower.includes('/migrations/') ||
      lower.includes('/migration/') ||
      lower.includes('prisma/migrations') ||
      /(^|\/)\d{8,}.*\.(ts|js|sql|php|py)$/.test(lower);
  }

  private isBehaviorNode(node: CASNode): boolean {
    if (node.source?.file && this.isMigrationFile(node.source.file)) return false;
    if (node.name === 'constructor' || node.name === 'up' || node.name === 'down') return false;
    return ['controller', 'service', 'repository', 'guard', 'middleware', 'handler', 'resolver', 'gateway', 'worker', 'command', 'mobile_screen', 'widget', 'route', 'boundary'].includes(node.type) ||
      Boolean(node.subcategories?.some(category => ['controller', 'service', 'repository', 'guard', 'middleware', 'background-service', 'mobile_screen', 'widget'].includes(category)));
  }

  private nodeText(node: CASNode): string {
    return [
      node.id,
      node.name,
      node.qualified_name,
      node.type,
      node.category,
      node.source?.file,
      node.signature?.return_type,
      ...(node.tags || []),
      ...(node.subcategories || []),
      ...(node.metadata?.annotations || []),
      ...Object.values((node.metadata?.attributes || {}) as Record<string, any>).map(value => String(value)),
    ].filter(Boolean).join(' ').toLowerCase();
  }

  private dedupeBehavioralInvariants(invariants: CASBehavioralInvariant[]): CASBehavioralInvariant[] {
    const seen = new Set<string>();
    const unique: CASBehavioralInvariant[] = [];
    for (const invariant of invariants) {
      if (seen.has(invariant.id)) continue;
      seen.add(invariant.id);
      unique.push(invariant);
    }
    return unique;
  }

  private invariantGapSeverity(invariant: CASBehavioralInvariant, gap: string): 'high' | 'medium' | 'low' {
    if (invariant.invariant_type === 'tenant-scope' && gap.toLowerCase().includes('unique')) return 'medium';
    if (invariant.invariant_type === 'auth-boundary' || invariant.invariant_type === 'authorization') return 'high';
    if (invariant.invariant_type === 'migration-contract') return 'medium';
    return 'low';
  }

  private buildSecurityBoundaries(nodes: CASNode[], entryPoints: CASEntryPoint[]): CASSecurityBoundary[] {
    const boundaries: CASSecurityBoundary[] = [];

    const securityNodes = nodes.filter(n => this.hasSecurityEnforcementSemantics(n));
    const enforcementNameIndex = new Set<string>();
    for (const node of securityNodes) {
      enforcementNameIndex.add(node.name.toLowerCase());
      for (const token of this.signalTokens(node.name)) enforcementNameIndex.add(token);
    }

    const authVocabulary = [
      'auth', 'authentication', 'authenticate', 'authenticated', 'authenticator',
      'jwt', 'login', 'logout', 'session', 'token', 'oauth', 'sso', 'devise', 'warden',
    ];
    const authNodes = securityNodes.filter(n => {
      const tokens = this.signalTokens(n.name);
      return authVocabulary.some(term => tokens.includes(term));
    });

    const authenticatedEntryPoints = entryPoints.filter(ep => ep.security?.authenticated);

    if (authNodes.length > 0 || authenticatedEntryPoints.length > 0) {
      const enforcementPoints: Array<{
        node_id: string;
        mechanism: string;
        confidence: 'enforced' | 'assumed' | 'missing';
      }> = authNodes.map(g => ({
        node_id: g.id,
        mechanism: this.inferAuthMechanism(g),
        confidence: 'enforced' as const
      }));

      const unresolvedGuards = new Map<string, string>();
      for (const ep of authenticatedEntryPoints) {
        for (const guard of ep.security?.guards || []) {
          const guardKey = guard.toLowerCase();
          if (unresolvedGuards.has(guardKey)) continue;
          const guardTokens = this.signalTokens(guard);
          const resolved = enforcementNameIndex.has(guardKey) ||
            guardTokens.some(token => enforcementNameIndex.has(token));
          if (!resolved) unresolvedGuards.set(guardKey, ep.handler?.node_id || ep.source_node);
        }
      }
      for (const [guardName, nodeId] of [...unresolvedGuards.entries()].slice(0, 25)) {
        enforcementPoints.push({
          node_id: nodeId,
          mechanism: `Declared guard "${guardName}" (marker only; no resolved enforcement code)`,
          confidence: 'assumed'
        });
      }

      if (enforcementPoints.length === 0 && authenticatedEntryPoints.length > 0) {
        enforcementPoints.push({
          node_id: 'entry_point_security',
          mechanism: 'Entry point authentication markers',
          confidence: 'assumed'
        });
      }

      const unprotectedSensitive = this.unprotectedSensitiveEntryPoints(entryPoints);
      for (const ep of unprotectedSensitive.slice(0, 25)) {
        enforcementPoints.push({
          node_id: ep.handler?.node_id || ep.source_node,
          mechanism: `No authentication detected on sensitive operation ${ep.trigger?.method || ep.type} ${ep.trigger?.path || ep.name}`,
          confidence: 'missing'
        });
      }

      boundaries.push({
        id: 'boundary_auth',
        name: 'Authentication Boundary',
        boundary_type: 'authentication',
        enforcement_points: enforcementPoints,
        trust_transition: {
          from_trust_level: 'untrusted',
          to_trust_level: 'partially-trusted'
        },
        sensitive_operations: authenticatedEntryPoints.map(ep => ep.source_node),
        bypass_risks: unprotectedSensitive.length > 0
          ? [`${unprotectedSensitive.length} mutating entry point(s) have no detected authentication or guard.`]
          : undefined
      });
    }

    const permissionVocabulary = ['role', 'roles', 'permission', 'permissions', 'crud', 'access', 'pundit', 'cancan', 'cancancan'];
    const permissionNodes = securityNodes.filter(n => {
      const tokens = this.signalTokens(n.name);
      return permissionVocabulary.some(term => tokens.includes(term)) ||
        this.nameTokensIndicateAuthorizationActor(tokens);
    });

    if (permissionNodes.length > 0) {
      boundaries.push({
        id: 'boundary_authz',
        name: 'Authorization Boundary',
        boundary_type: 'authorization',
        enforcement_points: permissionNodes.map(g => ({
          node_id: g.id,
          mechanism: this.inferAuthzMechanism(g),
          confidence: 'enforced' as const
        })),
        trust_transition: {
          from_trust_level: 'partially-trusted',
          to_trust_level: 'trusted'
        },
        sensitive_operations: []
      });
    }

    const tenantNodes = nodes.filter(n => this.hasTenantIsolationSemantics(n));
    if (tenantNodes.length > 0) {
      boundaries.push({
        id: 'boundary_tenant_isolation',
        name: 'Tenant Isolation Boundary',
        boundary_type: 'tenant-isolation',
        enforcement_points: tenantNodes.slice(0, 50).map(n => ({
          node_id: n.id,
          mechanism: `Tenant/organization scoping: ${n.name}`,
          confidence: 'enforced' as const
        })),
        trust_transition: {
          from_trust_level: 'partially-trusted',
          to_trust_level: 'trusted'
        },
        sensitive_operations: []
      });
    }

    const middlewareNodes = nodes.filter(n =>
      n.type === 'middleware' ||
      n.subcategories?.includes('middleware') ||
      n.name.toLowerCase().includes('middleware')
    );

    if (middlewareNodes.length > 0) {
      const securityMiddleware = middlewareNodes.filter(m => {
        const nameLower = m.name.toLowerCase();
        return nameLower.includes('security') ||
               nameLower.includes('cors') ||
               nameLower.includes('csrf') ||
               nameLower.includes('xss') ||
               nameLower.includes('helmet');
      });

      if (securityMiddleware.length > 0) {
        boundaries.push({
          id: 'boundary_security_middleware',
          name: 'Security Middleware Boundary',
          boundary_type: 'input-validation',
          enforcement_points: securityMiddleware.map(m => ({
            node_id: m.id,
            mechanism: `Security middleware: ${m.name}`,
            confidence: 'enforced' as const
          })),
          trust_transition: {
            from_trust_level: 'untrusted',
            to_trust_level: 'partially-trusted'
          },
          sensitive_operations: []
        });
      }
    }

    const rateLimitNodes = nodes.filter(n => this.hasRateLimitingSemantics(n));
    const rateLimitedEntryPoints = entryPoints.filter(ep => ep.security?.rate_limit);
    if (rateLimitNodes.length > 0 || rateLimitedEntryPoints.length > 0) {
      const enforcementPoints: CASSecurityBoundary['enforcement_points'] = rateLimitNodes.slice(0, 50).map(n => ({
        node_id: n.id,
        mechanism: `Rate limiting: ${n.name}`,
        confidence: 'enforced' as const
      }));
      if (enforcementPoints.length === 0) {
        enforcementPoints.push({
          node_id: rateLimitedEntryPoints[0].handler?.node_id || rateLimitedEntryPoints[0].source_node,
          mechanism: 'Entry point rate-limit markers',
          confidence: 'assumed'
        });
      }
      boundaries.push({
        id: 'boundary_rate_limiting',
        name: 'Rate Limiting Boundary',
        boundary_type: 'rate-limiting',
        enforcement_points: enforcementPoints,
        trust_transition: {
          from_trust_level: 'untrusted',
          to_trust_level: 'untrusted'
        },
        sensitive_operations: rateLimitedEntryPoints.map(ep => ep.source_node)
      });
    }

    return boundaries;
  }

  /**
   * Sensitive operations are mutating HTTP entry points. They are unprotected
   * when the analysis found no authentication marker and no guard on them.
   * This is evidence-driven: repos where every route is guarded report zero.
   */
  private unprotectedSensitiveEntryPoints(entryPoints: CASEntryPoint[]): CASEntryPoint[] {
    const mutating = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
    return entryPoints.filter(ep =>
      ep.type === 'http' &&
      mutating.has((ep.trigger?.method || '').toUpperCase()) &&
      !ep.security?.authenticated &&
      (ep.security?.guards || []).length === 0 &&
      (ep.security?.roles || []).length === 0 &&
      (ep.security?.permissions || []).length === 0
    );
  }

  /**
   * Tenant isolation evidence: scoping helpers, multitenancy library hooks,
   * or guard/middleware/scope code whose name binds an organization-like
   * owner to a scope. Domain models named Organization/Account alone are not
   * evidence; the name must express scoping or tenancy.
   */
  private hasTenantIsolationSemantics(node: CASNode): boolean {
    if (node.type === 'entity' || node.type === 'model') return false;
    const tokens = this.signalTokens(`${node.name} ${node.qualified_name || ''}`);
    if (tokens.includes('tenant') || tokens.includes('tenancy') || tokens.includes('multitenant') || tokens.includes('multitenancy')) {
      return true;
    }
    const scopeTokens = ['scope', 'scoped', 'scoping'];
    const ownerTokens = ['organization', 'org', 'account', 'company', 'workspace'];
    return scopeTokens.some(t => tokens.includes(t)) && ownerTokens.some(t => tokens.includes(t));
  }

  private hasRateLimitingSemantics(node: CASNode): boolean {
    if (node.type === 'entity' || node.type === 'model') return false;
    const tokens = this.signalTokens(`${node.name} ${node.qualified_name || ''}`);
    if ((tokens.includes('rate') && (tokens.includes('limit') || tokens.includes('limiter') || tokens.includes('limiting'))) ||
        tokens.includes('ratelimit') || tokens.includes('throttle') || tokens.includes('throttling') || tokens.includes('throttled')) {
      return true;
    }
    const nameLower = node.name.toLowerCase();
    return nameLower.includes('rack::attack') || nameLower.includes('rack_attack');
  }

  /**
   * Security boundaries are anchored on code that ENFORCES access decisions
   * (guards, middleware, policies, before_action filters, devise/warden,
   * permission configuration), never on domain models whose names merely
   * contain auth-looking substrings. `ReturnAuthorization` (RMA) and
   * `PaymentAuthorization` are commerce domain models, not enforcement points.
   */
  private hasSecurityEnforcementSemantics(node: CASNode): boolean {
    const subcategories = (node.subcategories || []).map(s => s.toLowerCase());
    if (node.type === 'guard' || node.type === 'middleware') return true;
    if (['guard', 'middleware', 'permission', 'policy', 'before_action', 'before_filter', 'ability'].some(s => subcategories.includes(s))) {
      return true;
    }
    const qualifiedTokens = this.signalTokens(node.qualified_name || '');
    if (qualifiedTokens.includes('middleware') || qualifiedTokens.includes('permission')) return true;

    const isDomainModel = node.type === 'entity' ||
      node.type === 'model' ||
      subcategories.some(s => ['model', 'entity', 'active_record', 'activerecord', 'aggregate', 'value_object'].includes(s));
    if (isDomainModel) return false;

    const tokens = this.signalTokens(node.name);
    const enforcementVocabulary = [
      'guard', 'guards', 'permission', 'permissions',
      'devise', 'warden', 'cancan', 'cancancan', 'pundit',
      'authentication', 'authenticate', 'authenticated', 'authenticator', 'auth', 'jwt', 'oauth', 'sso',
    ];
    if (enforcementVocabulary.some(term => tokens.includes(term))) return true;
    return this.nameTokensIndicateAuthorizationActor(tokens);
  }

  /**
   * "authorization"/"authorize" only count when the name IS the auth concept
   * (Authorization, Authorizer, authorize_admin), never when the token trails
   * a domain noun in a compound (ReturnAuthorization, PaymentAuthorization,
   * load_return_authorization). "policy"/"ability" follow the pundit/cancan
   * class convention: singular, leading or trailing (OrderPolicy, Ability) —
   * plural resource CRUD like PoliciesController (store legal pages) and
   * route paths like /policies are domain content, not enforcement.
   */
  private nameTokensIndicateAuthorizationActor(tokens: string[]): boolean {
    if (/^authoriz(e|er|es|ed|ation|ations)$/.test(tokens[0] || '')) return true;
    const head = tokens[0];
    const tail = tokens[tokens.length - 1];
    return ['policy', 'ability'].some(term => head === term || tail === term);
  }

  private inferAuthMechanism(node: CASNode): string {
    const nameLower = node.name.toLowerCase();
    if (nameLower.includes('jwt')) return 'JWT validation';
    if (nameLower.includes('session')) return 'Session-based authentication';
    if (nameLower.includes('token')) return 'Token-based authentication';
    if (nameLower.includes('oauth')) return 'OAuth authentication';
    if (nameLower.includes('login')) return 'Login authentication';
    return 'Authentication check';
  }

  private inferAuthzMechanism(node: CASNode): string {
    const nameLower = node.name.toLowerCase();
    if (nameLower.includes('role')) return 'Role-based access control';
    if (nameLower.includes('permission')) return 'Permission-based access control';
    if (nameLower.includes('crud')) return 'CRUD permission enforcement';
    if (nameLower.includes('policy')) return 'Policy-based access control';
    return 'Authorization check';
  }

  private buildSecuritySummary(
    boundaries: CASSecurityBoundary[],
    nodes: CASNode[],
    entryPoints: CASEntryPoint[]
  ): CASSecuritySummary {
    let enforced = 0;
    let assumed = 0;
    let missing = 0;

    for (const boundary of boundaries) {
      for (const point of boundary.enforcement_points) {
        if (point.confidence === 'enforced') enforced++;
        else if (point.confidence === 'assumed') assumed++;
        else missing++;
      }
    }

    const unprotected = this.unprotectedSensitiveEntryPoints(entryPoints);
    missing = Math.max(missing, unprotected.length);

    return {
      boundaries,
      unprotected_sensitive_ops: unprotected.map(ep => ep.source_node),
      assumed_vs_enforced: { enforced, assumed, missing }
    };
  }

  private buildFlowCoverage(
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    callChains: CASCallChain[]
  ): CASFlowCoverage[] {
    const flowCoverage: CASFlowCoverage[] = [];

    const testedNodes = new Set<string>();
    const testNodeIds = new Set<string>();

    for (const ep of entryPoints) {
      if (ep.type === 'test') {
        if (ep.connected_nodes) {
          ep.connected_nodes.forEach(n => testedNodes.add(n));
        }
        testNodeIds.add(ep.source_node);
      }
    }

    for (const node of nodes) {
      if (node.testing?.tested_by && node.testing.tested_by.length > 0) {
        testedNodes.add(node.id);
        for (const testId of node.testing.tested_by) {
          testNodeIds.add(testId);
        }
      }
    }

    for (const chain of callChains) {
      if (!chain.call_path || chain.call_path.length === 0) continue;

      const chainNodeIds = chain.call_path.map(s => s.node_id);
      const testedSegments: CASFlowCoverage['tested_segments'] = [];
      const untestedSegments: CASFlowCoverage['untested_segments'] = [];

      for (const nodeId of chainNodeIds) {
        if (testedNodes.has(nodeId)) {
          testedSegments.push({
            node_id: nodeId,
            test_ids: [],
            assertion_count: 0
          });
        } else {
          const node = nodes.find(n => n.id === nodeId);
          const isSecurityRelated = node?.name?.toLowerCase().includes('auth') ||
            node?.name?.toLowerCase().includes('password');

          untestedSegments.push({
            node_id: nodeId,
            importance: isSecurityRelated ? 'critical' : 'medium',
            reason: `Node ${node?.name || nodeId} lacks test coverage`
          });
        }
      }

      const coveragePct = chainNodeIds.length > 0
        ? testedSegments.length / chainNodeIds.length
        : 0;

      const coverageStatus: CASFlowCoverage['coverage_status'] =
        coveragePct >= 1.0 ? 'fully-covered' :
        coveragePct > 0 ? 'partially-covered' : 'not-covered';

      const hasTestNodes = chainNodeIds.some(id => testNodeIds.has(id));

      flowCoverage.push({
        call_chain_id: chain.id,
        call_chain_name: chain.entry_point?.method_name,
        coverage_status: coverageStatus,
        coverage_percentage: Math.round(coveragePct * 100) / 100,
        tested_segments: testedSegments,
        untested_segments: untestedSegments,
        test_quality: {
          has_unit_tests: hasTestNodes,
          has_integration_tests: false,
          has_e2e_tests: false,
          uses_mocks: false
        }
      });
    }

    return flowCoverage;
  }

  private buildTestGaps(flowCoverage: CASFlowCoverage[], nodes: CASNode[]): CASTestGap[] {
    const gaps: CASTestGap[] = [];
    const testedNodeIds = new Set<string>();

    for (const node of nodes) {
      if (node.testing?.tested_by?.length) {
        testedNodeIds.add(node.id);
      }
    }

    const testableTypes = new Set([
      'function', 'method', 'class', 'controller', 'service',
      'middleware', 'route', 'endpoint', 'viewmodel', 'model'
    ]);

    const untestedNodes = nodes.filter(n =>
      testableTypes.has(n.type) &&
      !testedNodeIds.has(n.id) &&
      !n.name.startsWith('_') &&
      n.type !== 'method' || (n.type === 'method' && !n.name.startsWith('__'))
    ).filter(n =>
      testableTypes.has(n.type) &&
      !testedNodeIds.has(n.id) &&
      (n.metadata?.is_exported ||
       n.type === 'controller' ||
       n.type === 'service' ||
       n.type === 'middleware' ||
       n.type === 'endpoint' ||
       n.category === 'api' ||
       n.category === 'controller' ||
       n.category === 'service' ||
       n.subcategories?.includes('public') ||
       n.metadata?.access_modifier === 'public' ||
       (n.type === 'function' && n.level && n.level <= 2) ||
       (n.type === 'class' && !n.name.includes('Abstract') && !n.name.includes('Base')))
    );

    for (const fn of untestedNodes) {
      const nameLower = fn.name.toLowerCase();
      const isSecurityRelated = nameLower.includes('auth') ||
        nameLower.includes('password') ||
        nameLower.includes('permission') ||
        nameLower.includes('token') ||
        nameLower.includes('encrypt') ||
        nameLower.includes('decrypt');

      const isDataMutation = nameLower.includes('create') ||
        nameLower.includes('update') ||
        nameLower.includes('delete') ||
        nameLower.includes('remove') ||
        nameLower.includes('save');

      const severity: CASTestGap['severity'] =
        isSecurityRelated ? 'critical' :
        isDataMutation ? 'high' :
        fn.type === 'controller' || fn.type === 'endpoint' ? 'high' :
        'medium';

      const displayName = this.humanizeDisplayName(fn.name);
      gaps.push({
        gap_type: 'untested-flow',
        title: `Missing tests for ${displayName}`,
        description: `${displayName} is a public ${fn.type} without detected direct test coverage.`,
        location: {
          node_id: fn.id
        },
        severity,
        recommendation: `Add tests for ${fn.name}`
      });
    }

    return gaps;
  }

  private buildTemporalStability(nodes: CASNode[], gitAnalyzer: GitAnalyzer): CASTemporalStability[] {
    const stability: CASTemporalStability[] = [];
    const gitAvailable = gitAnalyzer.isAvailable();

    for (const node of nodes) {
      if (node.type !== 'file' && node.type !== 'class' && node.type !== 'module') {
        continue;
      }

      const filePath = node.source?.file;
      const gitMetrics = filePath && gitAvailable ? gitAnalyzer.getFileMetrics(filePath) : null;

      const isLegacy = node.name.toLowerCase().includes('legacy') ||
        node.description?.toLowerCase().includes('deprecated') ||
        node.implementation_status?.deprecation?.is_deprecated === true ||
        (gitMetrics && gitMetrics.fileAgeDays > 730 && gitMetrics.commits30d === 0);

      const stabilityClass = this.calculateStabilityClass(gitMetrics, !!isLegacy);
      const stabilityScore = this.calculateStabilityScore(gitMetrics, !!isLegacy);

      const refactorFrequency: 'frequent' | 'occasional' | 'rare' =
        gitMetrics && gitMetrics.commits90d > 15 ? 'frequent' :
        gitMetrics && gitMetrics.commits90d > 5 ? 'occasional' : 'rare';

      stability.push({
        node_id: node.id,
        stability_score: stabilityScore,
        stability_class: stabilityClass,
        churn_metrics: {
          commits_30d: gitMetrics?.commits30d || 0,
          commits_90d: gitMetrics?.commits90d || 0,
          unique_authors_30d: gitMetrics?.uniqueAuthors30d || 0,
          lines_changed_30d: gitMetrics?.linesChanged30d || 0
        },
        quality_signals: {
          bug_fix_rate: gitMetrics?.bugFixRate || 0,
          refactor_frequency: refactorFrequency,
          has_recent_regression: gitMetrics?.hasRecentRegression || false
        },
        age_context: {
          file_age_days: gitMetrics?.fileAgeDays || 0,
          last_major_change: gitMetrics?.lastMajorChange || undefined,
          is_legacy: isLegacy || false
        },
        risk_correlation: gitMetrics ? {
          high_churn_high_bugs: gitMetrics.commits30d > 5 && gitMetrics.bugFixRate > 0.3,
          recent_refactor_unstable: gitMetrics.lastMajorChange !== null && gitMetrics.bugFixRate > 0.2
        } : undefined
      });
    }

    return stability;
  }

  private calculateStabilityClass(
    gitMetrics: { commits30d: number; bugFixRate: number; fileAgeDays: number; isHighChurn: boolean } | null,
    isLegacy: boolean
  ): 'stable' | 'evolving' | 'volatile' | 'fragile' {
    if (!gitMetrics) {
      return isLegacy ? 'stable' : 'evolving';
    }

    if (gitMetrics.bugFixRate > 0.3 || (gitMetrics.isHighChurn && gitMetrics.bugFixRate > 0.2)) {
      return 'fragile';
    }

    if (gitMetrics.commits30d > 10) {
      return 'volatile';
    }

    if (gitMetrics.commits30d <= 2 && gitMetrics.bugFixRate < 0.1 && gitMetrics.fileAgeDays > 180) {
      return 'stable';
    }

    return 'evolving';
  }

  private calculateStabilityScore(
    gitMetrics: { commits30d: number; bugFixRate: number; fileAgeDays: number; hasRecentRegression: boolean } | null,
    isLegacy: boolean
  ): number {
    if (!gitMetrics) {
      return isLegacy ? 90 : 70;
    }

    let score = 100;

    score -= Math.min(gitMetrics.commits30d * 3, 30);

    score -= Math.min(gitMetrics.bugFixRate * 50, 25);

    if (gitMetrics.hasRecentRegression) {
      score -= 15;
    }

    if (gitMetrics.fileAgeDays > 365 && gitMetrics.commits30d <= 2) {
      score += 10;
    }

    return Math.max(0, Math.min(100, Math.round(score)));
  }

  private buildStabilitySummary(stability: CASTemporalStability[]): CASStabilitySummary {
    const byClass: Record<string, number> = {
      stable: 0,
      evolving: 0,
      volatile: 0,
      fragile: 0
    };

    for (const s of stability) {
      byClass[s.stability_class]++;
    }

    return {
      by_stability_class: byClass,
      hotspots: stability
        .filter(s => s.stability_class === 'volatile' || s.stability_class === 'fragile')
        .map(s => ({
          node_id: s.node_id,
          reason: s.stability_class === 'fragile' ? 'High churn with bug fixes' : 'High change frequency'
        })),
      legacy_areas: stability
        .filter(s => s.age_context.is_legacy)
        .map(s => s.node_id)
    };
  }

  private buildSystemCapabilities(
    entryPoints: CASEntryPoint[],
    dataEntities: CASDataEntity[],
    nodes: CASNode[],
    edges: CASEdge[],
    projectPath?: string
  ): SystemCapability[] {
    const capabilities: SystemCapability[] = [];
    const isProductNode = (node: CASNode) => projectPath
      ? this.isPrimaryProductNodeForProject(node, projectPath)
      : this.isPrimaryProductNode(node);
    const isProductPath = (filePath: string) => projectPath
      ? this.isPrimaryProductPathForProject(filePath, projectPath)
      : this.isPrimaryProductPath(filePath);
    const productNodes = nodes.filter(node => isProductNode(node));
    const productNodeIds = new Set(productNodes.map(node => node.id));
    const productEntryPoints = entryPoints.filter(ep =>
      (!ep.source_node || productNodeIds.has(ep.source_node)) &&
      (!ep.handler?.file || isProductPath(ep.handler.file))
    );
    const productDataEntities = dataEntities.filter(entity => {
      if (entity.schema_source && !isProductPath(entity.schema_source)) return false;
      const lifecycleIds = [
        ...entity.lifecycle.created_by,
        ...entity.lifecycle.read_by,
        ...entity.lifecycle.updated_by,
        ...entity.lifecycle.deleted_by,
      ];
      return lifecycleIds.length === 0 || lifecycleIds.some(id => productNodeIds.has(id));
    });
    const productEdges = edges.filter(edge => productNodeIds.has(edge.source) || productNodeIds.has(edge.target));

    const resourceGroups = new Map<string, {
      entryPoints: CASEntryPoint[];
      name: string;
    }>();

    for (const ep of productEntryPoints) {
      if (ep.type === 'test') continue;

      const resourceKey = this.inferResourceKey(ep);
      const resourceName = this.inferResourceName(ep, resourceKey);

      if (!resourceGroups.has(resourceKey)) {
        resourceGroups.set(resourceKey, { entryPoints: [], name: resourceName });
      }
      resourceGroups.get(resourceKey)!.entryPoints.push(ep);
    }

    let capIndex = 0;
    resourceGroups.forEach((group, resourceKey) => {
      const operations = group.entryPoints.map(ep => ({
        entry_point_id: ep.id,
        entry_point_type: ep.type,
        action: this.inferActionFromEntryPoint(ep),
        path_or_command: this.extractPathOrCommand(ep)
      }));

      const relatedNodeIds = new Set<string>();
      group.entryPoints.forEach(ep => {
        if (ep.source_node) relatedNodeIds.add(ep.source_node);
        const epAny = ep as any;
        if (epAny.handler?.node_id) relatedNodeIds.add(epAny.handler.node_id);
      });

      const relatedEntities = productDataEntities.filter(de => {
        const entityNodeIds = [
          ...de.lifecycle.created_by,
          ...de.lifecycle.read_by,
          ...de.lifecycle.updated_by,
          ...de.lifecycle.deleted_by
        ];
        return entityNodeIds.some(id => relatedNodeIds.has(id));
      });

      const { criticality, factors } = this.calculateCriticalityFromSignals(
        group.entryPoints,
        relatedEntities,
        productNodes,
        productEdges
      );

      const category = this.inferCapabilityCategory(group.entryPoints, resourceKey);

      const capabilityName = this.formatDomainCapabilityName(resourceKey, group.name, operations, relatedEntities.length, projectPath);

      capabilities.push({
        id: `cap_${capIndex++}`,
        name: capabilityName,
        description: this.generateCapabilityDescription(capabilityName, operations),
        description_source: 'deterministic',
        description_generation: {
          status: 'deterministic_initial',
          attempted: false,
          generated_at: new Date().toISOString(),
        },
        category,
        operations,
        related_entities: relatedEntities.map(e => e.id),
        related_domains: [resourceKey],
        criticality,
        criticality_factors: factors
      });
    });

    const terminalCapabilities = this.buildTerminalCapabilities(
      productDataEntities,
      productNodes,
      productEdges,
      new Set(capabilities.flatMap(capability => capability.related_domains)),
      projectPath
    );
    for (const capability of terminalCapabilities) {
      capabilities.push({
        ...capability,
        id: `cap_${capIndex++}`,
      });
    }

    const usefulCapabilities = capabilities.filter(capability => !this.isGenericCapabilityDisplayName(capability.name));
    const capabilitiesForAgents = usefulCapabilities.length > 0 ? usefulCapabilities : capabilities;

    return capabilitiesForAgents.sort((a, b) => {
      const critOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      return critOrder[a.criticality] - critOrder[b.criticality];
    });
  }

  private buildTerminalCapabilities(
    dataEntities: CASDataEntity[],
    nodes: CASNode[],
    edges: CASEdge[],
    existingDomains: Set<string>,
    projectPath?: string
  ): SystemCapability[] {
    const nodesById = new Map(nodes.map(node => [node.id, node]));
    const incoming = new Map<string, number>();
    const outgoing = new Map<string, number>();
    for (const edge of edges) {
      outgoing.set(edge.source, (outgoing.get(edge.source) || 0) + 1);
      incoming.set(edge.target, (incoming.get(edge.target) || 0) + 1);
    }

    const groups = new Map<string, {
      label: string;
      labelTokenLists: string[][];
      nodes: CASNode[];
      entities: CASDataEntity[];
      operations: SystemCapability['operations'];
    }>();

    const ensureGroup = (key: string, labelTokens: string[]) => {
      if (!groups.has(key)) {
        groups.set(key, { label: this.humanizeDomainKey(key), labelTokenLists: [], nodes: [], entities: [], operations: [] });
      }
      const group = groups.get(key)!;
      if (labelTokens.length > 0) group.labelTokenLists.push(labelTokens);
      return group;
    };

    for (const entity of dataEntities) {
      const tokens = this.domainTokensFromText(entity.name);
      const key = tokens[0];
      if (!key || existingDomains.has(key)) continue;
      const group = ensureGroup(key, tokens);
      group.entities.push(entity);
      const lifecycleNodes = [
        ...entity.lifecycle.created_by,
        ...entity.lifecycle.read_by,
        ...entity.lifecycle.updated_by,
        ...entity.lifecycle.deleted_by,
      ]
        .map(id => nodesById.get(id))
        .filter((node): node is CASNode => Boolean(node));
      group.nodes.push(...lifecycleNodes);
    }

    for (const node of nodes) {
      if (!this.isCapabilityCandidateNode(node)) continue;
      const hasChildren = (node.children?.length || 0) > 0;
      const isTerminal = !hasChildren && (incoming.get(node.id) || 0) > 0 && (outgoing.get(node.id) || 0) <= 1;
      const isBusinessParent = hasChildren && this.isBusinessOrDomainNode(node);
      const isStandaloneBusinessOwner =
        !hasChildren &&
        (incoming.get(node.id) || 0) === 0 &&
        (outgoing.get(node.id) || 0) === 0 &&
        this.isBusinessOwnerNode(node);
      if (!isTerminal && !isBusinessParent && !isStandaloneBusinessOwner) continue;

      const key = this.domainKeyFromNode(node);
      if (!key || existingDomains.has(key)) continue;
      const group = ensureGroup(key, []);
      group.nodes.push(node);
      group.operations.push({
        entry_point_id: `node:${node.id}`,
        entry_point_type: 'internal',
        action: this.inferActionFromNodeName(node.name),
        path_or_command: node.source?.file,
      });
    }

    const capabilities: SystemCapability[] = [];
    for (const [key, group] of groups) {
      const uniqueNodes = Array.from(new Map(group.nodes.map(node => [node.id, node])).values());
      const uniqueEntities = Array.from(new Map(group.entities.map(entity => [entity.id, entity])).values());
      if (uniqueNodes.length + uniqueEntities.length === 0) continue;

      const labelTokens = [...group.labelTokenLists].sort((a, b) =>
        a.length - b.length || a.join(' ').localeCompare(b.join(' '))
      )[0] || [key];
      const labelKey = labelTokens.join('_');
      if (this.domainVariantInSet(labelKey, existingDomains) || this.domainVariantInSet(key, existingDomains)) continue;
      group.label = this.humanizeDomainKey(labelTokens.join(' '));

      const operations = group.operations.length > 0
        ? group.operations
        : uniqueNodes.slice(0, 6).map(node => ({
          entry_point_id: `node:${node.id}`,
          entry_point_type: 'internal',
          action: this.inferActionFromNodeName(node.name),
          path_or_command: node.source?.file,
        }));

      const category = this.inferTerminalCapabilityCategory(key, uniqueNodes, uniqueEntities);
      const capabilityName = this.formatTerminalCapabilityName(key, group.label, operations, uniqueEntities, projectPath);
      capabilities.push({
        id: 'cap_pending',
        name: capabilityName,
        description: this.generateTerminalCapabilityDescription(capabilityName, uniqueNodes, uniqueEntities, operations),
        description_source: 'deterministic',
        description_generation: {
          status: 'deterministic_initial',
          attempted: false,
          generated_at: new Date().toISOString(),
        },
        category,
        operations: operations.slice(0, 12),
        related_entities: uniqueEntities.map(entity => entity.id),
        related_domains: [key],
        criticality: this.inferTerminalCriticality(key, uniqueNodes, uniqueEntities),
        criticality_factors: this.terminalCriticalityFactors(key, uniqueNodes, uniqueEntities),
      });
    }

    return capabilities
      .filter(capability => capability.category !== 'internal' || capability.operations.length > 0)
      .sort((a, b) =>
        b.related_entities.length - a.related_entities.length ||
        b.operations.length - a.operations.length
      )
      .slice(0, 24);
  }

  private isCapabilityCandidateNode(node: CASNode): boolean {
    if (node.metadata?.is_test || node.metadata?.is_generated) return false;
    const file = node.source?.file?.toLowerCase() || '';
    if (/(^|\/)(node_modules|dist|build|coverage|vendor|vendors|generated|fixtures?)(\/|$)/.test(file)) return false;
    if (/\.(min|bundle)\.(js|css)$/.test(file)) return false;
    if (/\/lib\/(waypoints|owlcarousel|chart|easing|tempusdominus|bootstrap|jquery)\//.test(file)) return false;
    if (/\.(test|spec|stories|story)\.[a-z0-9]+$/i.test(file)) return false;
    return this.isBusinessOrDomainNode(node);
  }

  private isBusinessOrDomainNode(node: CASNode): boolean {
    const text = `${node.type} ${node.name} ${(node.subcategories || []).join(' ')}`.toLowerCase();
    return /\b(entity|model|schema|service|usecase|use_case|use-case|interactor|handler|processor|workflow|flow|function|method|repository|store|controller|resolver)\b/.test(text);
  }

  private isBusinessOwnerNode(node: CASNode): boolean {
    const text = `${node.type} ${node.name} ${(node.subcategories || []).join(' ')}`.toLowerCase();
    return /\b(entity|model|schema|service|usecase|use_case|use-case|interactor|handler|processor|workflow|flow|repository|store|controller|resolver)\b/.test(text);
  }

  private domainKeyFromNode(node: CASNode): string | undefined {
    const nameKey = this.domainKeyFromText(node.name);
    if (nameKey) return nameKey;

    const pathParts = (node.source?.file || '')
      .replace(/\\/g, '/')
      .split('/')
      .filter(Boolean)
      .filter(part => !/^(src|app|apps|packages|lib|libs|server|client|clients|components|controllers|services|repositories|models|entities|routes|pages|api|test|tests|spec|users|michaelshattuck|dev|outcode|personal|backend|frontend|vendor|generated)$/.test(part.toLowerCase()));
    for (const part of pathParts.reverse()) {
      const key = this.domainKeyFromText(part.replace(/\.[^.]+$/, ''));
      if (key) return key;
    }
    return undefined;
  }

  private domainKeyFromText(text: string): string | undefined {
    return this.domainTokensFromText(text)[0];
  }

  private domainTokensFromText(text: string): string[] {
    return text
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_\-./]/g, ' ')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map(token => this.normalizeDomainToken(token))
      .filter(token => token.length > 2)
      .filter(token => !this.isGenericCapabilityToken(token));
  }

  private normalizeDomainToken(token: string): string {
    if (/^ws[a-z]{4,}$/.test(token)) return token.slice(2);
    if (token === 'trans' || token === 'mctrans') return 'transaction';
    if (/^check[a-z]{5,}$/.test(token)) return token.replace(/^check/, '');
    return token;
  }

  private isGenericCapabilityToken(token: string): boolean {
    return new Set([
      'controller', 'service', 'services', 'repository', 'repo', 'model', 'models', 'entity', 'schema', 'module',
      'handler', 'manager', 'processor', 'provider', 'component', 'page', 'view', 'route',
      'pages', 'views', 'routes', 'layout', 'layouts', 'metadata', 'section', 'sections',
      'navbar', 'nav', 'footer', 'button', 'arrow', 'padding', 'total', 'home',
      'index', 'main', 'app', 'application', 'base', 'common', 'shared', 'core', 'file', 'files', 'util',
      'utils', 'helper', 'helpers', 'config', 'client', 'server', 'data', 'store',
      'constructor', 'import', 'export', 'create', 'update', 'delete', 'remove', 'get',
      'set', 'find', 'list', 'validate', 'verify', 'format', 'parse', 'build', 'make', 'run',
      'construct', 'submit', 'initialize', 'init', 'start', 'stop', 'catch', 'try',
      'generate', 'generator', 'generators', 'analyze', 'analyse', 'evaluate', 'calculate', 'compute', 'rebalance',
      'settle', 'settlement', 'sync', 'publish', 'send', 'receive', 'approve', 'reject',
      'schedule', 'cancel', 'resolve', 'assign',
      'major', 'minor', 'next', 'last', 'new', 'check', 'options', 'property', 'point', 'select',
      'window', 'modal', 'dialog', 'popup', 'screen', 'xaml', 'step', 'convert', 'show', 'display',
      'back', 'snack', 'setting', 'load', 'search', 'render', 'close', 'focus',
      'open', 'special', 'toast', 'date', 'dates', 'datepicker', 'ngrx', 'redux',
      'form', 'forms', 'input', 'inputs', 'slide', 'slides',
      'sort', 'sorting', 'sorted', 'filter', 'filters', 'filtering', 'children', 'child',
      'icon', 'icons', 'header', 'headers', 'effects', 'effect', 'provide', 'provides', 'providers',
      'object', 'objects', 'keys', 'toggle', 'tooltip', 'dropdown', 'checkbox', 'pagination',
      'paginator', 'scroll', 'subscribe', 'subscription', 'subscriptions', 'observable', 'observables',
      'dispatch', 'selector', 'selectors', 'reducer', 'reducers',
      'column', 'columns', 'row', 'rows', 'cell', 'cells', 'grid', 'grids', 'table', 'tables',
      'state', 'states', 'status', 'statuses',
      'normalize', 'ensure', 'path', 'clamp', 'install', 'setup', 'configure',
      'execute', 'process', 'handle', 'test', 'spec', 'orchestrator', 'workflow',
      'workflows', 'operation', 'operations', 'command', 'commands', 'cli',
      'bin', 'console', 'event', 'events', 'handler', 'handlers',
      'rewrite', 'rewrites', 'has', 'serializer', 'serializers', 'admin',
      'manage', 'lookup', 'superuser', 'permission', 'permissions', 'queryset', 'querysets',
      'for', 'allow', 'allows', 'domain', 'domains', 'request', 'requests', 'generated',
      'graphql', 'fetch', 'pull', 'authenticated', 'authenticate', 'method', 'methods',
      'put', 'patch', 'connectivity', 'quick', 'external', 'account', 'accounts',
      'str', 'autenticacion', 'authentication', 'authorization', 'link', 'links',
      'foreach', 'all', 'response', 'down', 'apply', 'one', 'add',
      'should', 'when', 'then', 'given', 'describe', 'context', 'before', 'after', 'mock', 'stub',
      'php', 'python', 'java', 'csharp', 'rust', 'dart', 'users', 'michaelshattuck',
      'flutter', 'lifecycle',
      'summarize', 'summary', 'args', 'argument', 'arguments', 'print', 'aggregate', 'average',
      'status', 'file', 'files', 'default', 'target', 'targets', 'unique', 'compact', 'score',
      'estimate', 'live', 'source', 'node', 'nodes',
      'help', 'from', 'count', 'counts', 'slugify', 'with', 'match', 'matches',
      'dev', 'clients', 'outcode', 'personal', 'business', 'apps', 'libs',
      'entry', 'entries', 'first', 'path', 'paths', 'percent', 'percentage',
      'minimal', 'gate', 'gates', 'compatible',
      'forbidden', 'error', 'errors', 'general', 'getting', 'started', 'dismiss',
      'notice', 'notices', 'json', 'preview', 'previews', 'legacy', 'unauthorized', 'denied',
      'change', 'changes',
      'rails', 'rack', 'rake', 'turbo', 'stimulus', 'sprockets', 'hotwire',
      'actiontext', 'activestorage', 'actioncable', 'actionmailer', 'actionpack',
      'activerecord', 'activejob', 'activemodel', 'activesupport', 'actionview',
      'importmap', 'webpacker', 'propshaft', 'sidekiq', 'kaminari', 'ransack',
      'devise', 'warden', 'omniauth', 'pundit', 'cancan', 'cancancan', 'doorkeeper',
      'rspec', 'rubocop', 'erb', 'haml', 'ruby', 'gem', 'gems', 'gemfile', 'bundler',
    ]).has(token);
  }

  private humanizeDomainKey(key: string): string {
    return key
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, char => char.toUpperCase());
  }

  private domainVariantInSet(key: string, domains: Set<string>): boolean {
    const variants = new Set([key]);
    if (key.endsWith('ies')) variants.add(`${key.slice(0, -3)}y`);
    if (key.endsWith('s') && !key.endsWith('ss')) variants.add(key.slice(0, -1));
    if (key.endsWith('s')) variants.add(`${key}es`);
    else {
      variants.add(`${key}s`);
      variants.add(`${key}es`);
      if (key.endsWith('y')) variants.add(`${key.slice(0, -1)}ies`);
    }
    for (const variant of variants) {
      if (domains.has(variant)) return true;
    }
    return false;
  }

  private formatTerminalCapabilityName(
    key: string,
    label: string,
    operations: SystemCapability['operations'],
    entities: CASDataEntity[],
    projectPath?: string
  ): string {
    const namedDomain = this.namedSystemCapabilityForDomain(key, projectPath);
    if (namedDomain) return namedDomain;

    const lower = label.toLowerCase();
    const operationText = operations.map(operation => operation.action).join(' ').toLowerCase();
    if (lower === 'auth') return 'Authentication';
    if (lower === 'login') return 'Login';
    if (/\b(auth|login|session|token|oauth)\b/.test(`${lower} ${operationText}`)) {
      return `${label} Authentication`;
    }
    if (/\b(settle|settlement)\b/.test(operationText)) {
      return `${label} Settlement`;
    }
    if (/\b(rebalance|allocation|allocate|optimize|optimise)\b/.test(operationText)) {
      return `${label} Rebalancing`;
    }
    if (/\b(generate|generation|export)\b/.test(operationText) && /\b(report|document|file|feed)\b/.test(lower)) {
      return `${label} Generation`;
    }
    if (/\b(report|analytics|analysis|metric|insight)\b/.test(`${lower} ${operationText}`)) {
      return `${label} Reporting`;
    }
    if (/\b(payment|billing|invoice|transaction|card|employee|profile|organization|resource)\b/.test(lower) || entities.length > 0 || operations.length > 1) {
      return `${label} Management`;
    }
    return `${label} Capability`;
  }

  private formatDomainCapabilityName(
    key: string,
    fallbackLabel: string,
    operations: SystemCapability['operations'],
    entityCount = 0,
    projectPath?: string
  ): string {
    const namedDomain = this.namedSystemCapabilityForDomain(key, projectPath);
    if (namedDomain) return namedDomain;

    const operationText = [
      key,
      fallbackLabel,
      ...operations.map(operation => `${operation.action} ${operation.path_or_command || ''}`),
    ].join(' ').toLowerCase();
    const label = fallbackLabel
      .replace(/\b(Commands|Handlers|Tasks|Management|Capability)\b/g, '')
      .replace(/\s+/g, ' ')
      .trim() || this.humanizeDomainKey(key);

    if (/\b(auth|login|session|token|oauth)\b/.test(operationText)) return `${label} Authentication`;
    if (/\b(settle|settlement)\b/.test(operationText)) return `${label} Settlement`;
    if (/\b(rebalance|allocation|allocate|optimi[sz]e)\b/.test(operationText)) return `${label} Rebalancing`;
    if (/\b(report|analytics|analysis|metric|insight)\b/.test(operationText)) return `${label} Reporting`;
    if (/\b(generate|export|render)\b/.test(operationText)) return `${label} Generation`;
    if (/\b(sync|replicate|mirror)\b/.test(operationText)) return `${label} Synchronization`;
    if (/\b(validate|verify|check)\b/.test(operationText)) return `${label} Validation`;
    if (/\b(send|publish|notify|message|event)\b/.test(operationText)) return `${label} Messaging`;
    if (entityCount > 0 || operations.length > 1) return `${label} Management`;
    return `${label} Workflow`;
  }

  private isKlauroSelfProject(projectPath?: string): boolean {
    if (!projectPath) return false;
    const resolved = path.resolve(projectPath);
    const cached = this.klauroSelfProjectCache.get(resolved);
    if (cached !== undefined) return cached;
    let isSelf = false;
    try {
      const packageJsonPath = path.join(resolved, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        const name = typeof parsed?.name === 'string' ? parsed.name : '';
        isSelf = /(^|[@/])klauro([-/.]|$)/i.test(name);
      }
    } catch {
      isSelf = false;
    }
    this.klauroSelfProjectCache.set(resolved, isSelf);
    return isSelf;
  }

  private namedSystemCapabilityForDomain(key: string, projectPath?: string): string | undefined {
    if (!this.isKlauroSelfProject(projectPath)) return undefined;
    const normalized = this.normalizeDomainToken((key || '').toLowerCase());
    return KLAURO_SELF_CAPABILITY_NAMES[normalized];
  }

  private inferActionFromNodeName(name: string): string {
    const lower = name
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_\-./]/g, ' ')
      .toLowerCase();
    if (/\b(create|add|insert|register)\b/.test(lower)) return 'Create';
    if (/\b(update|edit|patch|save)\b/.test(lower)) return 'Update';
    if (/\b(delete|remove|destroy)\b/.test(lower)) return 'Delete';
    if (/\b(get|find|list|search|load|fetch|query)\b/.test(lower)) return 'Read';
    if (/\b(generate|export|render)\b/.test(lower)) return 'Generate';
    if (/\b(analyze|analyse|evaluate|calculate|compute|score)\b/.test(lower)) return 'Analyze';
    if (/\b(rebalance|allocate|optimize|optimise)\b/.test(lower)) return 'Rebalance';
    if (/\b(settle|settlement|capture|charge|refund)\b/.test(lower)) return 'Settle';
    if (/\b(validate|verify|authorize|authenticate)\b/.test(lower)) return 'Validate';
    if (/\b(send|publish|emit|notify)\b/.test(lower)) return 'Send';
    if (/\b(sync|process|run|execute|handle)\b/.test(lower)) return 'Process';
    return 'Coordinate';
  }

  private inferTerminalCapabilityCategory(
    key: string,
    nodes: CASNode[],
    entities: CASDataEntity[]
  ): 'core' | 'supporting' | 'admin' | 'internal' {
    if (/(admin|setting|config|system|manage)/.test(key)) return 'admin';
    if (/(health|metric|telemetry|log|debug|cache|queue|worker|infra)/.test(key)) return 'internal';
    if (entities.length > 0 || nodes.some(node => /\b(service|usecase|workflow|entity|model)\b/i.test(`${node.type} ${node.name}`))) {
      return 'core';
    }
    return 'supporting';
  }

  private inferTerminalCriticality(
    key: string,
    nodes: CASNode[],
    entities: CASDataEntity[]
  ): 'critical' | 'high' | 'medium' | 'low' {
    if (/(auth|tenant|permission|payment|billing|invoice|order|security|user|account)/.test(key)) return 'high';
    if (entities.some(entity => entity.fields?.some(field => field.is_sensitive))) return 'high';
    if (entities.length > 0 && nodes.length >= 3) return 'medium';
    return nodes.length >= 5 ? 'medium' : 'low';
  }

  private terminalCriticalityFactors(key: string, nodes: CASNode[], entities: CASDataEntity[]): string[] {
    const factors: string[] = [];
    if (entities.length > 0) factors.push(`Backed by ${entities.length} data entity node(s)`);
    if (nodes.length > 0) factors.push(`Inferred from ${nodes.length} terminal or parent business node(s)`);
    if (/(auth|tenant|permission|payment|billing|invoice|order|security|user|account)/.test(key)) {
      factors.push('Domain name suggests security, identity, financial, or account impact');
    }
    if (factors.length === 0) factors.push('Inferred from graph terminality');
    return factors;
  }

  private generateTerminalCapabilityDescription(
    label: string,
    nodes: CASNode[],
    entities: CASDataEntity[],
    operations: SystemCapability['operations']
  ): string {
    const parts: string[] = [];
    if (entities.length > 0) parts.push(`centers on ${entities.slice(0, 3).map(entity => entity.name).join(', ')}`);
    if (operations.length > 0) {
      const actions = Array.from(new Set(operations.map(operation => operation.action.toLowerCase()).filter(action => action !== 'coordinate'))).slice(0, 4);
      if (actions.length > 0) parts.push(`covers ${actions.join(', ')} paths`);
    }
    const sourceAreas = this.capabilitySourceAreas(nodes, operations);
    if (sourceAreas.length > 0) {
      parts.push(`spans ${this.joinHumanList(sourceAreas)}`);
    }
    return `${label} ${parts.length ? parts.join('; ') : 'is inferred from connected source elements'}.`;
  }

  private capabilitySourceAreas(
    nodes: CASNode[],
    operations: SystemCapability['operations']
  ): string[] {
    const files = [
      ...nodes.map(node => node.source?.file),
      ...operations.map(operation => operation.path_or_command),
    ]
      .filter((file): file is string => Boolean(file))
      .map(file => file.replace(/\\/g, '/'))
      .filter(file => !/\b(test|spec|fixtures?|generated|node_modules|dist|build|coverage)\b/i.test(file));

    const areas = files.map(file => {
      const parts = file.split('/').filter(Boolean);
      const srcIndex = parts.lastIndexOf('src');
      if (srcIndex >= 0 && parts[srcIndex + 1]) {
        return parts[srcIndex + 1].replace(/\.[^.]+$/, '');
      }
      return (parts[parts.length - 2] || parts[parts.length - 1] || '').replace(/\.[^.]+$/, '');
    })
      .map(area => area.replace(/[-_]/g, ' ').trim().toLowerCase())
      .filter(area => area && !area.split(/\s+/).every(token => this.isGenericCapabilityToken(this.normalizeDomainToken(token))));

    return Array.from(new Set(areas)).slice(0, 3);
  }

  private inferResourceKey(ep: CASEntryPoint): string {
    if (ep.type === 'http') {
      const path = ep.trigger?.path || '';
      const cleanPath = path.replace(/^\/api\//, '').replace(/^\//, '');
      const firstSegment = cleanPath.split('/')[0];
      if (firstSegment && !firstSegment.startsWith(':')) {
        return firstSegment.toLowerCase();
      }
      return 'general';
    }

    if (ep.type === 'cli') {
      return this.domainKeyFromEntryPointText(ep.name) ||
        this.domainKeyFromEntryPointText(ep.handler?.method_name || '') ||
        this.domainKeyFromEntryPointText(ep.handler?.file || '') ||
        'commands';
    }

    if (ep.type === 'event' || ep.type === 'message') {
      return this.domainKeyFromEntryPointText(ep.name) ||
        this.domainKeyFromEntryPointText(ep.trigger?.event || '') ||
        this.domainKeyFromEntryPointText(ep.handler?.method_name || '') ||
        this.domainKeyFromEntryPointText(ep.handler?.file || '') ||
        'events';
    }

    if (ep.type === 'schedule') {
      return 'scheduled';
    }

    if (ep.type === 'page' || ep.type === 'route') {
      const file = ep.handler?.file || '';
      const normalized = file.replace(/\\/g, '/');
      const appMatch = normalized.match(/(?:^|\/)(?:app|pages)\/(.+?)\/page\.[tj]sx?$/i);
      if (appMatch?.[1]) {
        const routeSegment = appMatch[1].split('/').filter(Boolean).pop();
        const key = this.domainKeyFromText(routeSegment || '');
        if (key && !this.isGenericCapabilityToken(key)) return key;
      }
      const nameKey = this.domainKeyFromText(ep.name.replace(/Page$/i, ''));
      if (nameKey && !this.isGenericCapabilityToken(nameKey)) return nameKey;
      return 'pages';
    }

    return ep.type;
  }

  private domainKeyFromEntryPointText(text: string): string | undefined {
    const tokens = text
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_\-./:]/g, ' ')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map(token => this.normalizeDomainToken(token))
      .filter(token => token.length > 2)
      .filter(token => !this.isGenericCapabilityToken(token));

    if (tokens.length === 0) return undefined;
    return tokens.find(token => !/^(app|bin|console|command|event|message|handler|handlers)$/.test(token)) || tokens[0];
  }

  private inferResourceName(ep: CASEntryPoint, resourceKey: string): string {
    const name = resourceKey
      .replace(/-/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .split(' ')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');

    if (ep.type === 'cli') {
      return `${name} Commands`;
    }

    if (ep.type === 'event' || ep.type === 'message') {
      return `${name} Handlers`;
    }

    if (ep.type === 'schedule') {
      return 'Scheduled Tasks';
    }

    return `${name} Management`;
  }

  private inferActionFromEntryPoint(ep: CASEntryPoint): string {
    if (ep.type === 'http') {
      const method = ep.trigger?.method?.toLowerCase() || '';
      const path = ep.trigger?.path || '';
      const pathParts = path.split('/').filter(Boolean);
      const lastPart = pathParts[pathParts.length - 1];

      if (lastPart?.startsWith(':')) {
        switch (method) {
          case 'get': return 'View';
          case 'put':
          case 'patch': return 'Update';
          case 'delete': return 'Delete';
          default: return 'Manage';
        }
      }

      switch (method) {
        case 'get': return 'List';
        case 'post': return 'Create';
        case 'put':
        case 'patch': return 'Update';
        case 'delete': return 'Delete';
        default: return 'Access';
      }
    }

    if (ep.type === 'cli') {
      return 'Execute';
    }

    if (ep.type === 'event' || ep.type === 'message') {
      return 'Handle';
    }

    if (ep.type === 'schedule') {
      return 'Run';
    }

    return 'Process';
  }

  private extractPathOrCommand(ep: CASEntryPoint): string | undefined {
    if (ep.type === 'http') {
      return ep.trigger?.path;
    }
    if (ep.type === 'cli') {
      return ep.name;
    }
    return undefined;
  }

  private calculateCriticalityFromSignals(
    entryPoints: CASEntryPoint[],
    relatedEntities: CASDataEntity[],
    nodes: CASNode[],
    edges: CASEdge[]
  ): { criticality: 'critical' | 'high' | 'medium' | 'low'; factors: string[] } {
    let score = 0;
    const factors: string[] = [];

    const touchesSensitiveData = relatedEntities.some(e =>
      e.fields?.some(f => f.is_sensitive)
    );
    if (touchesSensitiveData) {
      score += 25;
      factors.push('Handles sensitive data (PII, credentials)');
    }

    const authPatterns = ['auth', 'login', 'logout', 'password', 'token', 'session', 'oauth'];
    const hasAuthPath = entryPoints.some(ep => {
      const path = ep.trigger?.path?.toLowerCase() || ep.name.toLowerCase();
      return authPatterns.some(p => path.includes(p));
    });
    if (hasAuthPath) {
      score += 20;
      factors.push('Authentication-related endpoint');
    }

    const paymentPatterns = ['payment', 'checkout', 'billing', 'invoice', 'subscription', 'charge', 'refund'];
    const hasPaymentPath = entryPoints.some(ep => {
      const path = ep.trigger?.path?.toLowerCase() || ep.name.toLowerCase();
      return paymentPatterns.some(p => path.includes(p));
    });
    if (hasPaymentPath) {
      score += 30;
      factors.push('Payment/financial operations');
    }

    const hasAuthRequired = entryPoints.some(ep =>
      ep.security?.authenticated ||
      (ep as any).security?.authenticated
    );
    if (hasAuthRequired) {
      score += 5;
      factors.push('Requires authentication');
    }

    const hasMutations = entryPoints.some(ep => {
      const method = ep.trigger?.method?.toUpperCase();
      return method === 'POST' || method === 'PUT' || method === 'DELETE' || method === 'PATCH';
    });
    if (hasMutations) {
      score += 10;
      factors.push('Performs data mutations');
    }

    const nodeIds = new Set<string>();
    entryPoints.forEach(ep => {
      if (ep.source_node) nodeIds.add(ep.source_node);
      const epAny = ep as any;
      if (epAny.handler?.node_id) nodeIds.add(epAny.handler.node_id);
    });

    let callerCount = 0;
    for (const edge of edges) {
      if ((edge.type === 'calls' || edge.type === 'uses') && nodeIds.has(edge.target)) {
        callerCount++;
      }
    }
    if (callerCount > 5) {
      score += Math.min(callerCount, 10);
      factors.push(`Called by ${callerCount} other components`);
    }

    const adminPatterns = ['admin', 'manage', 'delete', 'remove', 'destroy'];
    const hasAdminOps = entryPoints.some(ep => {
      const path = ep.trigger?.path?.toLowerCase() || ep.name.toLowerCase();
      return adminPatterns.some(p => path.includes(p));
    });
    if (hasAdminOps) {
      score += 15;
      factors.push('Administrative operations');
    }

    let criticality: 'critical' | 'high' | 'medium' | 'low';
    if (score >= 70) {
      criticality = 'critical';
    } else if (score >= 50) {
      criticality = 'high';
    } else if (score >= 25) {
      criticality = 'medium';
    } else {
      criticality = 'low';
    }

    return { criticality, factors };
  }

  private inferCapabilityCategory(
    entryPoints: CASEntryPoint[],
    resourceKey: string
  ): 'core' | 'supporting' | 'admin' | 'internal' {
    const adminPatterns = ['admin', 'manage', 'system', 'config', 'setting'];
    if (adminPatterns.some(p => resourceKey.includes(p))) {
      return 'admin';
    }

    const internalPatterns = ['health', 'status', 'metrics', 'internal', 'debug'];
    if (internalPatterns.some(p => resourceKey.includes(p))) {
      return 'internal';
    }

    const hasMutations = entryPoints.some(ep => {
      const method = ep.trigger?.method?.toUpperCase();
      return method === 'POST' || method === 'PUT' || method === 'DELETE';
    });

    if (hasMutations) {
      return 'core';
    }

    return 'supporting';
  }

  private generateCapabilityDescription(name: string, operations: Array<{ action: string }>): string {
    const uniqueActions = [...new Set(operations.map(o => o.action.toLowerCase()).filter(action => action !== 'coordinate'))];
    const entryTypes = [...new Set(operations.map(operation => (operation as any).entry_point_type).filter(Boolean))];
    const entryPhrase = entryTypes.length > 0
      ? ` through ${this.joinHumanList(entryTypes.slice(0, 3).map(type => this.entryPointTypeLabel(String(type)).toLowerCase()))}`
      : '';
    if (uniqueActions.length === 0) {
      return `${name} is represented by ${operations.length} discovered entry point${operations.length === 1 ? '' : 's'}${entryPhrase}.`;
    }
    return `${name} covers ${this.joinHumanList(uniqueActions.slice(0, 4))} paths${entryPhrase}.`;
  }

  private signalTokens(item: string): string[] {
    return item
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
  }

  private singularizeSignalToken(token: string): string {
    if (token.length > 3 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
    if (token.length > 4 && token.endsWith('ses')) return token.slice(0, -2);
    if (token.length > 2 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
    return token;
  }

  /**
   * Compound identifiers whose surrounding tokens change the meaning of an
   * otherwise distinctive signal token. `credit_card`/`gift_card` are commerce
   * vocabulary, not gaming "card" evidence; `dash board`/`key board` style
   * splits must not count as game "board" evidence.
   */
  private isBlockedSignalCompound(tokens: string[], start: number, end: number): boolean {
    if (end - start !== 1) return false;
    const blockers: Record<string, { before: string[]; after: string[] }> = {
      card: {
        before: ['credit', 'gift', 'debit', 'loyalty', 'membership', 'business', 'bank', 'id', 'sim', 'sd', 'key'],
        after: ['reader', 'holder'],
      },
      board: { before: ['dash', 'on', 'key', 'clip', 'leader', 'white'], after: [] },
      turn: { before: ['re'], after: [] },
    };
    const rule = blockers[tokens[start]];
    if (!rule) return false;
    const before = tokens[start - 1];
    const after = tokens[end];
    return (before !== undefined && rule.before.includes(before)) ||
      (after !== undefined && rule.after.includes(after));
  }

  /**
   * Whole-token signal matching. The pattern must appear as a contiguous run
   * of complete identifier tokens (snake_case/camelCase split), never as a
   * substring of a larger token: "card" does not match `credit_card`,
   * "board" does not match `dashboard`, "turn" does not match
   * `return_authorization`. Single-token patterns may also match a join of
   * two or more adjacent tokens ("viewmodel" matches `MuscleTestViewModel`).
   */
  private matchesSignalPattern(rawTokens: string[], pattern: string): boolean {
    const patternTokens = pattern
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .map(token => this.singularizeSignalToken(token));
    if (patternTokens.length === 0) return false;
    const tokens = rawTokens.map(token => this.singularizeSignalToken(token));
    for (let i = 0; i + patternTokens.length <= tokens.length; i++) {
      let matched = true;
      for (let j = 0; j < patternTokens.length; j++) {
        if (tokens[i + j] !== patternTokens[j]) {
          matched = false;
          break;
        }
      }
      if (matched && !this.isBlockedSignalCompound(tokens, i, i + patternTokens.length)) {
        return true;
      }
    }
    if (patternTokens.length === 1) {
      const target = patternTokens[0];
      for (let i = 0; i < tokens.length - 1; i++) {
        let joined = tokens[i];
        for (let j = i + 1; j < tokens.length && joined.length < target.length; j++) {
          joined += tokens[j];
          if (joined === target) return true;
        }
      }
    }
    return false;
  }

  private tokenizeSignalItems(items: string[]): string[][] {
    return items.map(item => this.signalTokens(item));
  }

  private inferSystemPurpose(
    entryPoints: CASEntryPoint[],
    dataEntities: CASDataEntity[],
    capabilities: SystemCapability[],
    nodes: CASNode[]
  ): SystemPurpose {
    interface SystemSignature {
      type: string;
      description: string;
      indicators: {
        pathPatterns?: string[];
        verbPatterns?: string[];
        entityPatterns?: string[];
        nodeTypePatterns?: string[];
        capabilityPatterns?: string[];
      };
      distinctiveness: number;
      weight: number;
    }

    const signatures: SystemSignature[] = [
      {
        type: 'verification-service',
        description: 'Data verification and validation system',
        indicators: {
          pathPatterns: ['verify', 'validate', 'check', 'barcode', 'scan', 'lookup'],
          verbPatterns: ['verify', 'validate', 'check', 'scan'],
          entityPatterns: ['verification', 'validator', 'barcode', 'serial', 'gtin', 'lot'],
          capabilityPatterns: ['verify', 'validate', 'check', 'scan'],
        },
        distinctiveness: 3,
        weight: 0
      },
      {
        type: 'sync-service',
        description: 'Data synchronization and replication system',
        indicators: {
          pathPatterns: ['sync', 'push', 'pull', 'replicate', 'mirror', 'synchronization'],
          verbPatterns: ['sync', 'push', 'pull', 'replicate'],
          entityPatterns: ['sync', 'replication', 'source', 'target', 'connection'],
          capabilityPatterns: ['sync', 'push', 'pull', 'synchronization'],
        },
        distinctiveness: 3,
        weight: 0
      },
      {
        type: 'e-commerce',
        description: 'Online shopping and commerce platform',
        indicators: {
          pathPatterns: ['cart', 'checkout', 'shop', 'store', 'catalog', 'wishlist'],
          verbPatterns: ['purchase', 'buy', 'add-to-cart'],
          entityPatterns: ['product', 'order', 'cart', 'payment', 'customer', 'sku', 'inventory', 'price'],
          capabilityPatterns: ['checkout', 'cart', 'purchase', 'catalog'],
        },
        distinctiveness: 2.5,
        weight: 0
      },
      {
        type: 'messaging-service',
        description: 'Message queue and event processing system',
        indicators: {
          pathPatterns: ['message', 'queue', 'publish', 'subscribe', 'topic', 'channel'],
          verbPatterns: ['publish', 'subscribe', 'send', 'receive', 'broadcast'],
          entityPatterns: ['message', 'queue', 'topic', 'subscriber', 'publisher', 'event'],
          capabilityPatterns: ['publish', 'subscribe', 'message', 'notify'],
        },
        distinctiveness: 3,
        weight: 0
      },
      {
        type: 'workflow-engine',
        description: 'Business process and workflow automation',
        indicators: {
          pathPatterns: ['workflow', 'process', 'task', 'step', 'approval', 'stage'],
          verbPatterns: ['approve', 'reject', 'submit', 'escalate'],
          entityPatterns: ['workflow', 'process', 'task', 'stage', 'approval', 'assignee'],
          capabilityPatterns: ['workflow', 'process', 'task', 'approve'],
        },
        distinctiveness: 3,
        weight: 0
      },
      {
        type: 'scheduling-service',
        description: 'Appointment and scheduling management',
        indicators: {
          pathPatterns: ['schedule', 'appointment', 'booking', 'calendar', 'slot', 'availability'],
          verbPatterns: ['schedule', 'book', 'reserve', 'cancel'],
          entityPatterns: ['schedule', 'appointment', 'booking', 'slot', 'calendar', 'availability'],
          capabilityPatterns: ['schedule', 'book', 'availability'],
        },
        distinctiveness: 3,
        weight: 0
      },
      {
        type: 'notification-service',
        description: 'Notification and alerting system',
        indicators: {
          pathPatterns: ['notification', 'alert', 'email', 'sms', 'push', 'webhook'],
          verbPatterns: ['notify', 'alert', 'send', 'trigger'],
          entityPatterns: ['notification', 'alert', 'template', 'recipient', 'channel'],
          capabilityPatterns: ['notify', 'alert', 'send'],
        },
        distinctiveness: 2.5,
        weight: 0
      },
      {
        type: 'document-management',
        description: 'Document storage and management system',
        indicators: {
          pathPatterns: ['document', 'file', 'upload', 'download', 'attachment', 'storage'],
          verbPatterns: ['upload', 'download', 'attach', 'store'],
          entityPatterns: ['document', 'file', 'attachment', 'folder', 'version'],
          capabilityPatterns: ['upload', 'download', 'document', 'file'],
        },
        distinctiveness: 2.5,
        weight: 0
      },
      {
        type: 'search-service',
        description: 'Search and discovery system',
        indicators: {
          pathPatterns: ['search', 'query', 'find', 'filter', 'index', 'suggest'],
          verbPatterns: ['search', 'query', 'find', 'filter'],
          entityPatterns: ['index', 'query', 'result', 'facet', 'suggestion'],
          capabilityPatterns: ['search', 'query', 'find'],
        },
        distinctiveness: 2,
        weight: 0
      },
      {
        type: 'inventory-management',
        description: 'Inventory and stock management system',
        indicators: {
          pathPatterns: ['inventory', 'stock', 'warehouse', 'shipment', 'transfer'],
          verbPatterns: ['transfer', 'receive', 'ship', 'adjust'],
          entityPatterns: ['inventory', 'stock', 'warehouse', 'location', 'shipment', 'transfer'],
          capabilityPatterns: ['inventory', 'stock', 'warehouse', 'shipment'],
        },
        distinctiveness: 3,
        weight: 0
      },
      {
        type: 'crm-system',
        description: 'Customer relationship management',
        indicators: {
          pathPatterns: ['customer', 'contact', 'lead', 'opportunity', 'account', 'deal'],
          verbPatterns: ['convert', 'qualify', 'assign'],
          entityPatterns: ['customer', 'contact', 'lead', 'opportunity', 'account', 'deal', 'campaign'],
          capabilityPatterns: ['customer', 'lead', 'contact', 'opportunity'],
        },
        distinctiveness: 2.5,
        weight: 0
      },
      {
        type: 'saas-platform',
        description: 'Multi-tenant SaaS application',
        indicators: {
          pathPatterns: ['workspace', 'organization', 'team', 'subscription', 'tenant', 'plan'],
          entityPatterns: ['workspace', 'organization', 'subscription', 'tenant', 'plan', 'billing'],
          capabilityPatterns: ['workspace', 'organization', 'subscription'],
        },
        distinctiveness: 2.5,
        weight: 0
      },
      {
        type: 'content-management',
        description: 'Content management system',
        indicators: {
          pathPatterns: ['post', 'article', 'page', 'blog', 'media', 'category', 'tag'],
          verbPatterns: ['publish', 'draft', 'archive'],
          entityPatterns: ['post', 'article', 'page', 'content', 'media', 'category', 'author'],
          capabilityPatterns: ['publish', 'content', 'article', 'media'],
        },
        distinctiveness: 2,
        weight: 0
      },
      {
        type: 'data-processing',
        description: 'Data processing and ETL pipeline',
        indicators: {
          pathPatterns: ['process', 'transform', 'import', 'export', 'batch', 'pipeline', 'etl'],
          verbPatterns: ['process', 'transform', 'import', 'export', 'extract'],
          entityPatterns: ['job', 'task', 'queue', 'pipeline', 'batch', 'transformation'],
          capabilityPatterns: ['process', 'transform', 'import', 'export', 'batch'],
        },
        distinctiveness: 2,
        weight: 0
      },
      {
        type: 'authentication-service',
        description: 'Authentication and identity management',
        indicators: {
          pathPatterns: ['auth', 'login', 'oauth', 'sso', 'identity', 'token', 'session'],
          verbPatterns: ['login', 'logout', 'authenticate', 'authorize'],
          entityPatterns: ['user', 'session', 'token', 'credential', 'role', 'permission'],
          capabilityPatterns: ['login', 'auth', 'session', 'token'],
        },
        distinctiveness: 2,
        weight: 0
      },
      {
        type: 'analytics-platform',
        description: 'Analytics and reporting platform',
        indicators: {
          pathPatterns: ['analytics', 'report', 'dashboard', 'metric', 'insight', 'chart'],
          verbPatterns: ['aggregate', 'analyze', 'track'],
          entityPatterns: ['metric', 'report', 'event', 'aggregation', 'dimension', 'measure'],
          capabilityPatterns: ['analytics', 'report', 'dashboard', 'metric'],
        },
        distinctiveness: 2.5,
        weight: 0
      },
      {
        type: 'payment-service',
        description: 'Payment processing system',
        indicators: {
          pathPatterns: ['payment', 'charge', 'refund', 'invoice', 'transaction', 'payout'],
          verbPatterns: ['charge', 'refund', 'pay', 'settle'],
          entityPatterns: ['payment', 'transaction', 'invoice', 'refund', 'payout', 'account'],
          capabilityPatterns: ['payment', 'charge', 'refund', 'invoice'],
        },
        distinctiveness: 3,
        weight: 0
      },
      {
        type: 'iot-platform',
        description: 'IoT device management platform',
        indicators: {
          pathPatterns: ['device', 'sensor', 'telemetry', 'firmware', 'provision', 'command'],
          verbPatterns: ['provision', 'register', 'configure'],
          entityPatterns: ['device', 'sensor', 'telemetry', 'firmware', 'reading', 'gateway'],
          capabilityPatterns: ['device', 'sensor', 'telemetry', 'provision'],
        },
        distinctiveness: 3,
        weight: 0
      },
      {
        type: 'desktop-application',
        description: 'Desktop GUI application',
        indicators: {
          nodeTypePatterns: ['window', 'viewmodel', 'ui_component', 'command', 'converter', 'view'],
          entityPatterns: ['settings', 'preferences', 'configuration'],
          capabilityPatterns: ['window', 'dialog', 'form', 'display'],
        },
        distinctiveness: 2,
        weight: 0
      },
      {
        type: 'medical-device-software',
        description: 'Medical device and clinical measurement software',
        indicators: {
          pathPatterns: ['patient', 'device', 'muscle', 'force', 'measurement', 'evaluator', 'protocol'],
          entityPatterns: ['patient', 'evaluator', 'protocol', 'muscle', 'device', 'measurement', 'normvalues', 'sequence'],
          nodeTypePatterns: ['window', 'viewmodel', 'service', 'database_context'],
          capabilityPatterns: ['patient', 'device', 'measurement', 'protocol', 'evaluator', 'report'],
        },
        distinctiveness: 4,
        weight: 0
      },
      {
        type: 'clinical-testing-platform',
        description: 'Clinical testing, assessment, and rehabilitation platform',
        indicators: {
          pathPatterns: ['inclinometry', 'grip', 'pinch', 'muscle', 'rom', 'strength', 'rehabilitation'],
          entityPatterns: ['muscletest', 'testinfo', 'coverletter', 'standardmuscles', 'custommuscles', 'normvalues'],
          capabilityPatterns: ['muscle', 'grip', 'pinch', 'inclinometry', 'test', 'assessment'],
        },
        distinctiveness: 5,
        weight: 0
      },
      {
        type: 'hardware-device-software',
        description: 'Hardware device communication and control software',
        indicators: {
          pathPatterns: ['device', 'sensor', 'serial', 'usb', 'bluetooth', 'calibrate'],
          entityPatterns: ['device', 'sensor', 'reading', 'calibration', 'firmware'],
          nodeTypePatterns: ['service'],
          capabilityPatterns: ['device', 'calibrate', 'sensor', 'reading'],
        },
        distinctiveness: 3.5,
        weight: 0
      },
      {
        type: 'patient-management',
        description: 'Patient data management and records system',
        indicators: {
          pathPatterns: ['patient', 'record', 'history', 'demographic', 'visit', 'chart'],
          entityPatterns: ['patient', 'record', 'evaluator', 'visit', 'chart', 'history', 'coverletter'],
          capabilityPatterns: ['patient', 'record', 'history', 'demographic'],
        },
        distinctiveness: 3.5,
        weight: 0
      },
      {
        type: 'api-gateway',
        description: 'API gateway and routing service',
        indicators: {
          pathPatterns: ['gateway', 'proxy', 'route', 'upstream', 'rate-limit'],
          entityPatterns: ['route', 'upstream', 'service', 'consumer', 'plugin'],
          capabilityPatterns: ['route', 'proxy', 'gateway'],
        },
        distinctiveness: 3,
        weight: 0
      },
      {
        type: 'api-service',
        description: 'REST/GraphQL API backend',
        indicators: {
          pathPatterns: ['api', 'graphql', 'rest', 'resource'],
          nodeTypePatterns: ['controller', 'service', 'repository', 'resolver'],
          capabilityPatterns: ['crud', 'resource'],
        },
        distinctiveness: 1,
        weight: 0
      },
      {
        type: 'cli-tool',
        description: 'Command-line interface tool',
        indicators: {
          capabilityPatterns: ['command', 'execute', 'run'],
          nodeTypePatterns: ['command', 'cli'],
        },
        distinctiveness: 3,
        weight: 0
      },
      {
        type: 'gaming-platform',
        description: 'Gaming, card game, or interactive entertainment platform',
        indicators: {
          pathPatterns: ['game', 'player', 'deck', 'card', 'match', 'lobby', 'turn', 'score', 'commander', 'board'],
          verbPatterns: ['play', 'draw', 'shuffle', 'deal', 'attack', 'defend', 'cast', 'mulligan'],
          entityPatterns: ['game', 'player', 'deck', 'card', 'match', 'lobby', 'turn', 'score', 'hand', 'board', 'commander', 'mana'],
          capabilityPatterns: ['game', 'match', 'lobby', 'player', 'deck'],
        },
        distinctiveness: 4,
        weight: 0
      },
      {
        type: 'multiplayer-application',
        description: 'Real-time multiplayer application with websocket communication',
        indicators: {
          pathPatterns: ['socket', 'lobby', 'room', 'player', 'matchmaking', 'realtime', 'session'],
          verbPatterns: ['join', 'leave', 'broadcast', 'emit', 'connect'],
          entityPatterns: ['socket', 'room', 'lobby', 'player', 'session', 'connection', 'event'],
          capabilityPatterns: ['socket', 'lobby', 'room', 'matchmaking'],
        },
        distinctiveness: 3.5,
        weight: 0
      },
      {
        type: 'web-application',
        description: 'Full-stack web application with frontend and backend',
        indicators: {
          pathPatterns: ['page', 'component', 'layout', 'api', 'route', 'middleware', 'hook', 'context', 'provider'],
          entityPatterns: ['user', 'session', 'page', 'component', 'layout', 'route'],
          nodeTypePatterns: ['controller', 'service', 'middleware'],
          capabilityPatterns: ['page', 'route', 'api', 'component'],
        },
        distinctiveness: 1,
        weight: 0
      },
      {
        type: 'devtools-platform',
        description: 'Developer tools, code analysis, or visualization platform',
        indicators: {
          // Only genuinely distinctive tokens are listed. Generic terms
          // (node, edge, graph, component, token, render, layout, plugin,
          // sdk) were removed: they appear in almost every codebase and
          // previously caused systems like a Claude-agent manager or any
          // React app to be mislabeled a devtools platform.
          pathPatterns: ['analyzer', 'sourcemap', 'transpile', 'transpiler', 'transpilation', 'linter', 'codegen', 'blueprint'],
          verbPatterns: ['transpile', 'instrument', 'profile'],
          entityPatterns: ['analyzer', 'sourcemap', 'blueprint', 'diagnostic', 'codemod'],
          capabilityPatterns: ['static analysis', 'code analysis', 'transpilation', 'instrumentation', 'profiling'],
        },
        distinctiveness: 3,
        weight: 0
      },
      {
        type: 'education-platform',
        description: 'Learning management system or educational platform',
        indicators: {
          pathPatterns: ['course', 'lesson', 'quiz', 'certificate', 'learning', 'curriculum', 'enrollment', 'tutorial', 'assignment', 'student', 'instructor'],
          verbPatterns: ['enroll', 'complete', 'submit', 'grade', 'certify', 'learn', 'study', 'teach'],
          entityPatterns: ['course', 'lesson', 'quiz', 'student', 'instructor', 'enrollment', 'certificate', 'curriculum', 'assignment', 'grade', 'progress', 'achievement', 'leaderboard'],
          capabilityPatterns: ['course', 'lesson', 'quiz', 'certificate', 'learning', 'enrollment'],
        },
        distinctiveness: 4.5,
        weight: 0
      }
    ];

    const productNodes = nodes.filter(node => this.isPrimaryProductNode(node));
    const productNodeIds = new Set(productNodes.map(node => node.id));
    const productEntryPoints = entryPoints.filter(ep =>
      (!ep.source_node || productNodeIds.has(ep.source_node)) &&
      (!ep.handler?.file || this.isPrimaryProductPath(ep.handler.file))
    );
    const productDataEntities = dataEntities.filter(entity => {
      const lifecycleIds = [
        ...entity.lifecycle.created_by,
        ...entity.lifecycle.read_by,
        ...entity.lifecycle.updated_by,
        ...entity.lifecycle.deleted_by,
      ];
      return lifecycleIds.length === 0 || lifecycleIds.some(id => productNodeIds.has(id));
    });
    const productCapabilities = capabilities.filter(capability => capability.category !== 'internal');
    const evidence: string[] = [];
    const signatureEvidence = new Map<string, string[]>();

    const paths = this.tokenizeSignalItems(productEntryPoints.map(ep => ep.trigger?.path || ep.name));
    const nodeNames = this.tokenizeSignalItems(productNodes.map(n => n.name));
    const namespaceNames = this.tokenizeSignalItems(productNodes.filter(n => n.type === 'namespace').map(n => n.name));
    const entityNames = this.tokenizeSignalItems(productDataEntities.map(de => de.name));
    const capabilityNames = this.tokenizeSignalItems(productCapabilities.map(c => c.name));
    const nodeTypeList = this.tokenizeSignalItems(productNodes.map(n => n.type));

    const countMatches = (items: string[][], patterns: string[]): { count: number; matched: string[] } => {
      const matched: string[] = [];
      let count = 0;
      for (const tokens of items) {
        for (const pattern of patterns) {
          if (this.matchesSignalPattern(tokens, pattern)) {
            if (!matched.includes(pattern)) {
              matched.push(pattern);
            }
            count++;
          }
        }
      }
      return { count, matched };
    };

    for (const sig of signatures) {
      let score = 0;
      const typeEvidence: string[] = [];

      if (sig.indicators.pathPatterns) {
        const pathResult = countMatches(paths, sig.indicators.pathPatterns);
        const nodeNameResult = countMatches(nodeNames, sig.indicators.pathPatterns);
        const nsResult = countMatches(namespaceNames, sig.indicators.pathPatterns);
        const allMatched = [...new Set([...pathResult.matched, ...nodeNameResult.matched, ...nsResult.matched])];
        const totalCount = pathResult.count + nodeNameResult.count + nsResult.count;
        const cappedCount = Math.min(totalCount, allMatched.length * 5);
        if (allMatched.length > 0) {
          score += cappedCount * 2 * sig.distinctiveness;
          typeEvidence.push(`Endpoints: ${allMatched.join(', ')}`);
        }
      }

      if (sig.indicators.verbPatterns) {
        const pathResult = countMatches(paths, sig.indicators.verbPatterns);
        const nodeNameResult = countMatches(nodeNames, sig.indicators.verbPatterns);
        const allMatched = [...new Set([...pathResult.matched, ...nodeNameResult.matched])];
        const totalCount = pathResult.count + nodeNameResult.count;
        const cappedCount = Math.min(totalCount, allMatched.length * 5);
        if (allMatched.length > 0) {
          score += cappedCount * 3 * sig.distinctiveness;
          if (!typeEvidence.some(e => e.startsWith('Endpoints:'))) {
            typeEvidence.push(`Actions: ${allMatched.join(', ')}`);
          }
        }
      }

      if (sig.indicators.entityPatterns) {
        const result = countMatches(entityNames, sig.indicators.entityPatterns);
        if (result.count > 0) {
          score += result.count * 4 * sig.distinctiveness;
          typeEvidence.push(`Entities: ${result.matched.join(', ')}`);
        }
      }

      if (sig.indicators.nodeTypePatterns) {
        const result = countMatches(nodeTypeList, sig.indicators.nodeTypePatterns);
        if (result.count > 0) {
          score += result.matched.length * 2;
        }
      }

      if (sig.indicators.capabilityPatterns) {
        const result = countMatches(capabilityNames, sig.indicators.capabilityPatterns);
        const cappedCount = Math.min(result.count, result.matched.length * 5);
        if (result.count > 0) {
          score += cappedCount * 3 * sig.distinctiveness;
          typeEvidence.push(`Capabilities: ${result.matched.join(', ')}`);
        }
      }

      if (sig.type === 'gaming-platform' && score > 0) {
        const gameTokenLists = [...paths, ...nodeNames, ...entityNames, ...capabilityNames];
        const strongGameSignals = ['game', 'deck', 'lobby', 'mana', 'mulligan', 'gameplay', 'matchmaking']
          .filter(signal => gameTokenLists.some(tokens => this.matchesSignalPattern(tokens, signal)));
        if (strongGameSignals.length < 1) {
          score = 0;
          typeEvidence.length = 0;
        }
      }

      sig.weight = score;
      if (typeEvidence.length > 0) {
        signatureEvidence.set(sig.type, typeEvidence);
      }
    }

    signatures.sort((a, b) => b.weight - a.weight);

    const topMatch = signatures[0];
    const secondBest = signatures[1];

    const maxPossibleScore = Math.max(
      paths.length * 5 * 3,
      entityNames.length * 4 * 3,
      50
    );
    let confidence = topMatch.weight / maxPossibleScore;

    if (topMatch.weight > 0 && secondBest.weight > 0) {
      const separation = (topMatch.weight - secondBest.weight) / topMatch.weight;
      confidence = Math.min(confidence + (separation * 0.3), 1.0);
    }

    confidence = Math.max(0.1, Math.min(0.95, confidence));

    const topEvidence = signatureEvidence.get(topMatch.type) || [];
    evidence.push(...topEvidence);

    const secondaryTypes = signatures
      .slice(1, 4)
      .filter(s => s.weight > topMatch.weight * 0.3)
      .map(s => s.type);

    const cliEntryPoints = productEntryPoints.filter(ep => ep.type === 'cli');
    const httpEntryPoints = productEntryPoints.filter(ep => ep.type === 'http');
    const pageEntryPoints = productEntryPoints.filter(ep => ep.type === 'page' || ep.type === 'route');
    const desktopUiSignals = countMatches([...nodeNames, ...paths], ['window', 'viewmodel', 'xaml', 'modal']);
    const nameEntityCapabilityPathTokens = [...nodeNames, ...entityNames, ...capabilityNames, ...paths];
    const hasDominantDesktopUi =
      ['desktop-application', 'medical-device-software', 'clinical-testing-platform', 'hardware-device-software'].includes(topMatch.type) ||
      desktopUiSignals.count >= 5;
    const clinicalSignals = countMatches(
      nameEntityCapabilityPathTokens,
      ['patient', 'muscle', 'device', 'measurement', 'force', 'inclinometry', 'grip', 'pinch', 'rehabilitation']
    );
    const devtoolsSignals = countMatches(
      nameEntityCapabilityPathTokens,
      ['analyzer', 'static analysis', 'code analysis', 'codebase analysis', 'codebase graph', 'codemod']
    );
    if (devtoolsSignals.count >= 3 && devtoolsSignals.matched.some(signal => /analyzer|analysis|codebase/.test(signal)) && topMatch.type !== 'medical-device-software' && topMatch.type !== 'clinical-testing-platform') {
      return {
        primary_type: 'devtools-platform',
        confidence: Math.max(0.82, Math.round(confidence * 100) / 100),
        evidence: [`Developer-tool/code-analysis signals: ${devtoolsSignals.matched.join(', ')}`],
        secondary_types: topMatch.type !== 'devtools-platform' ? [topMatch.type, ...secondaryTypes].slice(0, 3) : secondaryTypes,
      };
    }

    if (hasDominantDesktopUi && clinicalSignals.matched.length >= 3) {
      return {
        primary_type: 'clinical-testing-platform',
        confidence: Math.max(0.86, Math.round(confidence * 100) / 100),
        evidence: [`Clinical desktop signals: ${clinicalSignals.matched.join(', ')}`],
        secondary_types: [topMatch.type, ...secondaryTypes]
          .filter(type => type !== 'clinical-testing-platform')
          .slice(0, 3),
      };
    }

    // Anchor-gated like the clinical and commerce signatures: a CMS verdict
    // requires the revision entity (the load-bearing CMS concept: versioned
    // content) together with page or document entities, broad page-tree
    // entity vocabulary, and publishing-workflow vocabulary on real paths or
    // capabilities. Workflow/task/approval vocabulary alone must keep losing
    // to this gate: a page-tree CMS contains a moderation workflow engine,
    // not the other way around.
    const cmsEntitySignals = countMatches(
      entityNames,
      ['page', 'document', 'revision', 'rendition', 'collection', 'redirect', 'snippet', 'locale', 'site', 'media']
    );
    const cmsPublishingSignals = countMatches(
      nameEntityCapabilityPathTokens,
      ['publish', 'unpublish', 'draft', 'moderation', 'preview', 'revision']
    );
    const hasCmsEntityAnchor =
      cmsEntitySignals.matched.includes('revision') &&
      (cmsEntitySignals.matched.includes('page') || cmsEntitySignals.matched.includes('document'));
    if (hasCmsEntityAnchor && cmsEntitySignals.matched.length >= 4 && cmsPublishingSignals.matched.length >= 2 &&
      topMatch.type !== 'medical-device-software' && topMatch.type !== 'clinical-testing-platform') {
      return {
        primary_type: 'content-management',
        confidence: Math.max(0.8, Math.round(confidence * 100) / 100),
        evidence: [
          `Content entities: ${cmsEntitySignals.matched.join(', ')}`,
          `Publishing vocabulary: ${cmsPublishingSignals.matched.join(', ')}`,
        ],
        secondary_types: [topMatch.type, ...secondaryTypes]
          .filter(type => type !== 'content-management')
          .slice(0, 3),
      };
    }

    if (cliEntryPoints.length > httpEntryPoints.length && cliEntryPoints.length > 0 && !hasDominantDesktopUi) {
      return {
        primary_type: 'cli-tool',
        confidence: 0.9,
        evidence: ['Primary interface is CLI commands'],
        secondary_types: topMatch.type !== 'cli-tool' ? [topMatch.type] : secondaryTypes
      };
    }

    if (pageEntryPoints.length > 0 && httpEntryPoints.length === 0) {
      return {
        primary_type: 'frontend-application',
        confidence: 0.86,
        evidence: [`${pageEntryPoints.length} page/route entry points`],
        secondary_types: topMatch.type !== 'web-application' && topMatch.weight > 0 ? [topMatch.type, ...secondaryTypes].slice(0, 3) : secondaryTypes,
      };
    }

    if (topMatch.weight === 0) {
      const hasHttpEndpoints = httpEntryPoints.length > 0;
      const hasEntities = productDataEntities.length > 0;

      if (hasHttpEndpoints && hasEntities) {
        return {
          primary_type: 'api-service',
          confidence: 0.4,
          evidence: [`${httpEntryPoints.length} HTTP endpoints`, `${productDataEntities.length} data entities`],
          secondary_types: undefined
        };
      }

      return {
        primary_type: 'general-application',
        confidence: 0.2,
        evidence: ['No distinctive patterns detected'],
        secondary_types: undefined
      };
    }

    return {
      primary_type: topMatch.type,
      confidence: Math.round(confidence * 100) / 100,
      evidence: evidence.slice(0, 5),
      secondary_types: secondaryTypes.length > 0 ? secondaryTypes : undefined
    };
  }

  private linkRouteHandlers(
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): void {
    const functionNodesByFile = new Map<string, CASNode[]>();
    for (const node of nodes) {
      if (node.type === 'function' || node.type === 'method') {
        const file = node.source?.file || '';
        if (!functionNodesByFile.has(file)) {
          functionNodesByFile.set(file, []);
        }
        functionNodesByFile.get(file)!.push(node);
      }
    }

    const existingEdgeIds = new Set(edges.map(e => e.id));

    for (const ep of entryPoints) {
      const supportedTypes = ['http', 'websocket', 'message', 'event'];
      if (!supportedTypes.includes(ep.type)) continue;
      if (!ep.handler?.method_name) continue;

      const handlerName = ep.handler.method_name;
      const handlerFile = ep.handler.file || '';
      const routeNodeId = ep.source_node;

      if (!handlerName || handlerName.length === 0) continue;
      const sourceNode = nodes.find(node => node.id === routeNodeId);
      if ((sourceNode?.type === 'function' || sourceNode?.type === 'method') && sourceNode.name === handlerName) {
        ep.handler.node_id = sourceNode.id;
        continue;
      }

      const filesToSearch: string[] = [];
      if (handlerFile) {
        for (const file of functionNodesByFile.keys()) {
          if (file.includes(handlerFile) || handlerFile.includes(file.replace(/^.*?\//, ''))) {
            filesToSearch.push(file);
          }
        }
      }

      if (filesToSearch.length === 0) {
        filesToSearch.push(...functionNodesByFile.keys());
      }

      let matchedFunctionNode: CASNode | null = null;

      for (const file of filesToSearch) {
        const functionsInFile = functionNodesByFile.get(file) || [];
        const exactMatch = functionsInFile.find(n => n.name === handlerName);
        if (exactMatch) {
          matchedFunctionNode = exactMatch;
          break;
        }
      }

      if (!matchedFunctionNode) {
        for (const file of filesToSearch) {
          const functionsInFile = functionNodesByFile.get(file) || [];
          const partialMatch = functionsInFile.find(n =>
            n.name.toLowerCase() === handlerName.toLowerCase() ||
            n.name.includes(handlerName) ||
            handlerName.includes(n.name)
          );
          if (partialMatch) {
            matchedFunctionNode = partialMatch;
            break;
          }
        }
      }

      if (matchedFunctionNode) {
        if (ep.handler) {
          ep.handler.node_id = matchedFunctionNode.id;
        }

        const edgeId = `route_calls_${routeNodeId}_${matchedFunctionNode.id}`;
        if (!existingEdgeIds.has(edgeId)) {
          const framework = ep.metadata?.graphql_operation_type ? 'graphene' :
                           ep.metadata?.task_type === 'celery' ? 'celery' :
                           ep.source_analyzer || 'web';
          const relationship = ep.metadata?.graphql_operation_type ? 'graphql_resolver' :
                              ep.metadata?.task_type === 'celery' ? 'task_handler' :
                              'route_handler';

          edges.push({
            id: edgeId,
            source: routeNodeId,
            target: matchedFunctionNode.id,
            type: 'calls',
            metadata: {
              attributes: {
                framework,
                relationship,
                entry_point_type: ep.type
              }
            }
          });
          existingEdgeIds.add(edgeId);
        }
      }
    }
  }

  private addDiscoveredEntryPoints(
    projectPath: string,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    edges: CASEdge[] = []
  ): void {
    if (nodes.length === 0) return;

    const existingIds = new Set(entryPoints.map(entryPoint => entryPoint.id));
    const existingSourceNodes = new Set(entryPoints.map(entryPoint => entryPoint.source_node));
    const candidates = this.collectEntryPointCandidates(projectPath);
    const startingCount = entryPoints.length;

    for (const candidate of candidates) {
      const sourceNode = this.findNodeForEntryFile(nodes, projectPath, candidate.file);
      if (!sourceNode || existingSourceNodes.has(sourceNode.id)) continue;

      const entryId = `entry_discovered_${candidate.file.replace(/[^a-zA-Z0-9]/g, '_')}`;
      if (existingIds.has(entryId)) continue;

      entryPoints.push({
        id: entryId,
        source_node: sourceNode.id,
        source_analyzer: 'orchestrator',
        type: candidate.type,
        name: candidate.name,
        description: candidate.description,
        trigger: candidate.trigger,
        handler: {
          node_id: sourceNode.id,
          method_name: sourceNode.name || path.basename(candidate.file),
          file: sourceNode.source?.file || candidate.file,
          line: sourceNode.source?.line || 1,
        },
        metadata: {
          discovered: true,
          discovery_source: 'manifest-or-common-entry-file',
          file: candidate.file,
        },
      });
      existingIds.add(entryId);
      existingSourceNodes.add(sourceNode.id);
    }

    if (startingCount === 0 && entryPoints.length === 0) {
      const fallbackNode = this.selectFallbackEntryNode(nodes, edges);
      if (fallbackNode) {
        const file = fallbackNode.source?.file;
        const relativeFile = file && path.isAbsolute(file) ? path.relative(projectPath, file).replace(/\\/g, '/') : file;
        entryPoints.push({
          id: `entry_orientation_${fallbackNode.id.replace(/[^a-zA-Z0-9]/g, '_')}`,
          source_node: fallbackNode.id,
          source_analyzer: 'orchestrator',
          type: 'file',
          name: `Orientation entry ${relativeFile || fallbackNode.name}`,
          description: 'No formal framework, route, CLI, or runtime entry point was detected; this file entry gives agents a concrete CAS starting point for repository orientation.',
          trigger: relativeFile ? { pattern: relativeFile } : undefined,
          handler: {
            node_id: fallbackNode.id,
            method_name: fallbackNode.name,
            file,
            line: fallbackNode.source?.line || 1,
          },
          metadata: {
            discovered: true,
            inferred_orientation_only: true,
            discovery_source: 'representative-source-node',
            file: relativeFile,
          },
        });
      }
    }
  }

  private collectEntryPointCandidates(projectPath: string): DiscoveredEntryPointCandidate[] {
    const candidates: DiscoveredEntryPointCandidate[] = [];
    const add = (candidate: DiscoveredEntryPointCandidate) => {
      const normalized = candidate.file.replace(/\\/g, '/').replace(/^\.\//, '');
      if (!normalized || candidates.some(existing => existing.file === normalized)) return;
      if (fs.existsSync(path.join(projectPath, normalized))) {
        candidates.push({ ...candidate, file: normalized });
      }
    };

    const packageJson = this.readJsonManifest(path.join(projectPath, 'package.json'));
    if (packageJson) {
      const bin = packageJson.bin;
      if (typeof bin === 'string') {
        add({
          file: bin,
          type: 'cli',
          name: `CLI ${packageJson.name || path.basename(projectPath)}`,
          description: `Package bin entry point declared in package.json.`,
          trigger: { pattern: bin },
        });
      } else if (bin && typeof bin === 'object') {
        for (const [command, file] of Object.entries(bin)) {
          if (typeof file !== 'string') continue;
          add({
            file,
            type: 'cli',
            name: `CLI ${command}`,
            description: `Package bin entry point declared in package.json.`,
            trigger: { pattern: command },
          });
        }
      }

      for (const field of ['main', 'module', 'exports']) {
        const value = packageJson[field];
        if (typeof value === 'string') {
          add({
            file: value,
            type: this.packageEntryType(packageJson, value),
            name: `${packageJson.name || path.basename(projectPath)} ${field}`,
            description: `Package ${field} entry declared in package.json.`,
            trigger: { pattern: field },
          });
        }
      }
    }

    const commonEntries: Array<[string, CASEntryPoint['type'], string]> = [
      ['src/main.tsx', 'page', 'React application root'],
      ['src/main.jsx', 'page', 'React application root'],
      ['src/index.tsx', 'page', 'React application root'],
      ['src/index.jsx', 'page', 'React application root'],
      ['src/main.ts', 'lifecycle', 'Application bootstrap'],
      ['src/main.js', 'lifecycle', 'Application bootstrap'],
      ['src/index.ts', 'lifecycle', 'Package entry'],
      ['src/index.js', 'lifecycle', 'Package entry'],
      ['index.ts', 'lifecycle', 'Package entry'],
      ['index.js', 'lifecycle', 'Package entry'],
      ['main.py', 'cli', 'Python application entry'],
      ['app.py', 'lifecycle', 'Python application entry'],
      ['manage.py', 'cli', 'Python management entry'],
      ['__main__.py', 'cli', 'Python module entry'],
      ['src/main.py', 'cli', 'Python application entry'],
      ['src/main.rs', 'cli', 'Rust application entry'],
      ['main.go', 'cli', 'Go application entry'],
      ['cmd/main.go', 'cli', 'Go application entry'],
      ['Program.cs', 'lifecycle', '.NET application entry'],
      ['src/Program.cs', 'lifecycle', '.NET application entry'],
      ['Startup.cs', 'lifecycle', '.NET startup entry'],
      ['lib/main.dart', 'lifecycle', 'Dart application entry'],
    ];

    for (const [file, type, name] of commonEntries) {
      add({
        file,
        type,
        name,
        description: `${name} discovered from conventional entry file location.`,
        trigger: { pattern: file },
      });
    }

    const goCommandEntries = globSync('cmd/*/main.go', {
      cwd: projectPath,
      nodir: true,
      ignore: ['**/.git/**', '**/node_modules/**', '**/dist/**', '**/build/**', '**/target/**', '**/vendor/**'],
    }).slice(0, 10);
    for (const file of goCommandEntries) {
      add({
        file,
        type: 'cli',
        name: `Go command ${path.basename(path.dirname(file))}`,
        description: `Go command entry discovered under cmd/.`,
        trigger: { pattern: file },
      });
    }

    return candidates;
  }

  private readJsonManifest(file: string): any | null {
    try {
      if (!fs.existsSync(file)) return null;
      return fs.readJsonSync(file);
    } catch {
      return null;
    }
  }

  private packageEntryType(packageJson: any, file: string): CASEntryPoint['type'] {
    const deps = JSON.stringify({ ...(packageJson.dependencies || {}), ...(packageJson.devDependencies || {}) }).toLowerCase();
    if (/\.(tsx|jsx)$/i.test(file) || /\b(react|vite|next|vue|angular|svelte)\b/.test(deps)) return 'page';
    if (packageJson.bin) return 'cli';
    return 'lifecycle';
  }

  private findNodeForEntryFile(nodes: CASNode[], projectPath: string, entryFile: string): CASNode | undefined {
    const normalizedEntry = entryFile.replace(/\\/g, '/').replace(/^\.\//, '');
    const candidates = nodes.filter(node => {
      const sourceFile = node.source?.file;
      return Boolean(sourceFile && this.sourcePathMatches(projectPath, sourceFile, normalizedEntry));
    });
    return candidates.find(node => node.type === 'file') ||
      candidates.find(node => /function|method|class|component|module|react_app/i.test(node.type)) ||
      candidates[0];
  }

  private sourcePathMatches(projectPath: string, sourceFile: string, expectedRelativeFile: string): boolean {
    const normalizedSource = sourceFile.replace(/\\/g, '/').replace(/^\.\//, '');
    const relative = path.isAbsolute(sourceFile)
      ? path.relative(projectPath, sourceFile).replace(/\\/g, '/')
      : normalizedSource;
    return relative === expectedRelativeFile || normalizedSource.endsWith(`/${expectedRelativeFile}`);
  }

  private selectFallbackEntryNode(nodes: CASNode[], edges: CASEdge[] = []): CASNode | undefined {
    const candidates = nodes.filter(node =>
      Boolean(node.source?.file) &&
      !/(^|\/)(__tests__|tests?|spec|e2e|cypress)(\/|$)|(\.|_|-)(test|spec|cy)\./i.test(node.source?.file || '') &&
      !['import', 'dependency'].includes(node.type)
    );
    if (candidates.length === 0) return undefined;
    const degree = new Map<string, number>();
    for (const edge of edges) {
      degree.set(edge.source, (degree.get(edge.source) || 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) || 0) + 1);
    }
    return [...candidates].sort((left, right) =>
      this.fallbackEntryScore(right) - this.fallbackEntryScore(left) ||
      (degree.get(right.id) || 0) - (degree.get(left.id) || 0) ||
      (left.source?.file || '').localeCompare(right.source?.file || '') ||
      ((left.source?.line ?? 0) - (right.source?.line ?? 0)) ||
      left.id.localeCompare(right.id)
    )[0];
  }

  private fallbackEntryScore(node: CASNode): number {
    const file = (node.source?.file || '').replace(/\\/g, '/');
    let score = 0;
    if (/\/?(main|index|app|program|startup)\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|cs|dart)$/i.test(file)) score += 80;
    if (/\/src\//i.test(`/${file}`)) score += 25;
    if (/function|method|class|component|module|service|react_app|file/i.test(node.type)) score += 20;
    if (node.level) score += Math.max(0, 10 - node.level);
    if (/config|migration|generated|schema|model|entity/i.test(file)) score -= 35;
    return score;
  }

  private buildTestSuites(nodes: CASNode[], entryPoints: CASEntryPoint[], projectPath: string): CASTestSuite[] {
    const testSuites: CASTestSuite[] = [];
    const addedSuiteIds = new Set<string>();
    const childrenByParent = new Map<string, CASNode[]>();
    const nodesByFile = new Map<string, CASNode[]>();

    for (const node of nodes) {
      if (node.parent) {
        if (!childrenByParent.has(node.parent)) childrenByParent.set(node.parent, []);
        childrenByParent.get(node.parent)!.push(node);
      }
      const file = node.source?.file;
      if (file) {
        if (!nodesByFile.has(file)) nodesByFile.set(file, []);
        nodesByFile.get(file)!.push(node);
      }
    }

    const suiteNodes = nodes.filter(n =>
      n.type === 'test' && n.subcategories?.includes('suite')
    );

    if (suiteNodes.length > 0) {
      for (const suite of suiteNodes) {
        const suiteFile = suite.source?.file || '';
        const fileNodes = nodesByFile.get(suiteFile) || [];
        const suiteChildren = childrenByParent.get(suite.id) || [];
        const testsInSuite = [...suiteChildren, ...fileNodes.filter(t => !t.parent)]
          .filter((t, index, values) => values.findIndex(candidate => candidate.id === t.id) === index)
          .filter(t =>
            t.type === 'test' &&
            !t.subcategories?.includes('suite')
        );

        if (testsInSuite.length > 0) {
          const suiteId = `suite_${suite.id}`;
          addedSuiteIds.add(suiteId);
          testSuites.push({
            id: suiteId,
            name: suite.name,
            file_path: suiteFile,
            test_type: this.inferTestType(suite),
            framework: this.inferTestFramework(suite),
            tests: testsInSuite.map(t => ({
              id: `test_${t.id}`,
              name: t.name,
              description: t.description,
              test_type: this.inferTestType(t),
              status: {
                skipped: false,
                focused: false,
                flaky: false
              },
              source: t.source?.file && t.source?.line ? {
                file: t.source.file,
                line: t.source.line,
                end_line: t.source.end_line
              } : undefined
            }))
          });
        }
      }
    }

    const testModules = nodes.filter(n =>
      n.type === 'module' &&
      (n.name === 'tests' || n.name === 'test' || n.name.endsWith('_tests') || n.name.endsWith('_test')) &&
      !addedSuiteIds.has(`suite_${n.id}`)
    );

    for (const testModule of testModules) {
      const moduleFile = testModule.source?.file || '';
      const moduleChildren = childrenByParent.get(testModule.id) || [];
      const fileNodes = moduleFile ? nodesByFile.get(moduleFile) || [] : [];
      const childFunctions = [...moduleChildren, ...fileNodes.filter(n => !n.parent)]
        .filter((n, index, values) => values.findIndex(candidate => candidate.id === n.id) === index)
        .filter(n =>
        (n.type === 'function' || n.type === 'method') &&
        (n.name.startsWith('test_') || n.name.startsWith('test') || n.metadata?.is_test)
      );

      if (childFunctions.length > 0) {
        const suiteId = `suite_${testModule.id}`;
        addedSuiteIds.add(suiteId);
        testSuites.push({
          id: suiteId,
          name: testModule.name,
          file_path: moduleFile,
          test_type: this.inferTestType(testModule),
          framework: this.inferTestFramework(testModule),
          tests: childFunctions.map(m => ({
            id: `test_${m.id}`,
            name: m.name,
            description: m.description,
            test_type: this.inferTestType(testModule),
            status: {
              skipped: false,
              focused: false,
              flaky: false
            },
            source: m.source?.file && m.source?.line ? {
              file: m.source.file,
              line: m.source.line,
              end_line: m.source.end_line
            } : undefined
          }))
        });
      }
    }

    const testClasses = nodes.filter(n =>
      n.type === 'class' &&
      (n.name.toLowerCase().includes('test') ||
       n.name.startsWith('Test') ||
       n.subcategories?.includes('test')) &&
      !addedSuiteIds.has(`suite_${n.id}`)
    );

    for (const testClass of testClasses) {
      const testMethods = (childrenByParent.get(testClass.id) || []).filter(n =>
        n.type === 'method' &&
        (n.name.startsWith('test_') || n.name.startsWith('test'))
      );

      if (testMethods.length > 0) {
        const suiteId = `suite_${testClass.id}`;
        addedSuiteIds.add(suiteId);
        testSuites.push({
          id: suiteId,
          name: testClass.name,
          file_path: testClass.source?.file || '',
          test_type: this.inferTestType(testClass),
          framework: this.inferTestFramework(testClass),
          tests: testMethods.map(m => ({
            id: `test_${m.id}`,
            name: m.name,
            description: m.description,
            test_type: this.inferTestType(testClass),
            status: {
              skipped: false,
              focused: false,
              flaky: false
            },
            source: m.source?.file && m.source?.line ? {
              file: m.source.file,
              line: m.source.line,
              end_line: m.source.end_line
            } : undefined
          }))
        });
      }
    }

    const describeBlocks = nodes.filter(n =>
      (n.type === 'function' || n.type === 'block' || n.type === 'call_expression') &&
      (n.name.startsWith('describe') || n.name.startsWith('context') || n.name.startsWith('suite')) &&
      !addedSuiteIds.has(`suite_${n.id}`)
    );

    for (const describe of describeBlocks) {
      const itBlocks = (childrenByParent.get(describe.id) || []).filter(n =>
        (n.name.startsWith('it') || n.name.startsWith('test') || n.name.startsWith('specify'))
      );

      if (itBlocks.length > 0) {
        const suiteId = `suite_${describe.id}`;
        addedSuiteIds.add(suiteId);
        testSuites.push({
          id: suiteId,
          name: describe.name,
          file_path: describe.source?.file || '',
          test_type: this.inferTestType(describe),
          framework: this.inferTestFramework(describe),
          tests: itBlocks.map(m => ({
            id: `test_${m.id}`,
            name: m.name,
            description: m.description,
            test_type: this.inferTestType(describe),
            status: {
              skipped: m.name.startsWith('xit') || m.name.startsWith('xtest'),
              focused: m.name.startsWith('fit') || m.name.startsWith('ftest'),
              flaky: false
            },
            source: m.source?.file && m.source?.line ? {
              file: m.source.file,
              line: m.source.line,
              end_line: m.source.end_line
            } : undefined
          }))
        });
      }
    }

    const testFiles = nodes.filter(n => n.type === 'file' && this.isTestFileNode(n));

    const suiteFiles = new Set(testSuites.map(s => s.file_path));

    for (const testFile of testFiles) {
      if (suiteFiles.has(testFile.source?.file || '')) continue;
      const fileId = `suite_file_${testFile.id}`;
      if (addedSuiteIds.has(fileId)) continue;

      const fileNodes = testFile.source?.file ? nodesByFile.get(testFile.source.file) || [] : [];
      const fileChildren = childrenByParent.get(testFile.id) || [];
      const childTests = [...fileChildren, ...fileNodes]
        .filter((n, index, values) => values.findIndex(candidate => candidate.id === n.id) === index)
        .filter(n =>
        (n.type === 'function' || n.type === 'method') &&
        (n.name.startsWith('test') || n.name.startsWith('it') ||
         n.name.startsWith('should') || n.name.startsWith('Test'))
      );
      const inferredTests = childTests.length > 0
        ? childTests.map(m => ({
          id: `test_${m.id}`,
          name: m.name,
          description: m.description,
          test_type: this.inferTestType(testFile),
          status: {
            skipped: false,
            focused: false,
            flaky: false
          },
          source: m.source?.file && m.source?.line ? {
            file: m.source.file,
            line: m.source.line,
            end_line: m.source.end_line
          } : undefined
        }))
        : this.extractTestCasesFromFile(projectPath, testFile);

      if (inferredTests.length > 0) {
        addedSuiteIds.add(fileId);
        testSuites.push({
          id: fileId,
          name: testFile.name,
          file_path: testFile.source?.file || testFile.name,
          test_type: this.inferTestType(testFile),
          framework: this.inferTestFramework(testFile),
          tests: inferredTests
        });
      }
    }

    return testSuites;
  }

  private isTestFileNode(node: CASNode): boolean {
    const file = (node.source?.file || node.name || '').replace(/\\/g, '/');
    const name = path.basename(file);
    return /\.(spec|test)\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(name) ||
      /\.cy\.(ts|tsx|js|jsx)$/i.test(name) ||
      /^test_.*\.py$/i.test(name) ||
      /_test\.py$/i.test(name) ||
      /_test\.(go|rs|dart)$/i.test(name) ||
      /(Test|Tests)\.(java|kt|cs|php)$/i.test(name) ||
      (/\/tests?\//i.test(file) && this.looksLikeExecutableTestFile(file));
  }

  private looksLikeExecutableTestFile(file: string): boolean {
    const name = path.basename(file);
    if (name === '__init__.py' || name.endsWith('.d.ts')) return false;
    if (/\.(spec|test)\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(name)) return true;
    if (/^test_.*\.py$/i.test(name) || /_test\.py$/i.test(name)) return true;
    if (/_test\.(go|rs|dart)$/i.test(name)) return true;
    if (/(Test|Tests)\.(java|kt|cs|php)$/i.test(name)) return true;
    return false;
  }

  private extractTestCasesFromFile(projectPath: string, testFile: CASNode): CASTestCase[] {
    const sourceFile = testFile.source?.file || testFile.name;
    const absolutePath = path.isAbsolute(sourceFile) ? sourceFile : path.join(projectPath, sourceFile);
    if (!fs.existsSync(absolutePath)) return [];
    const content = fs.readFileSync(absolutePath, 'utf8');
    const testType = this.inferTestType(testFile);
    const tests: CASTestCase[] = [];

    const patterns = this.testCasePatternsForFile(sourceFile);
    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.regex.exec(content)) !== null) {
        const name = match[pattern.nameGroup] || match[0].trim();
        const line = this.lineNumberAtOffset(content, match.index);
        tests.push({
          id: this.testCaseId(sourceFile, name, line, tests.length),
          name,
          test_type: testType,
          status: {
            skipped: pattern.skipped(match[0]),
            focused: pattern.focused(match[0]),
            flaky: false
          },
          source: {
            file: sourceFile,
            line
          }
        });
      }
    }

    return this.dedupeTestCases(tests);
  }

  private testCasePatternsForFile(file: string): Array<{
    regex: RegExp;
    nameGroup: number;
    skipped: (raw: string) => boolean;
    focused: (raw: string) => boolean;
  }> {
    const lowerFile = file.toLowerCase();
    const commonStatus = {
      skipped: (raw: string) => /\.skip\b|^x(it|test|describe)\b/.test(raw.trim()),
      focused: (raw: string) => /\.only\b|^f(it|test|describe)\b/.test(raw.trim())
    };

    if (lowerFile.endsWith('.py')) {
      return [
        { regex: /^\s*(?:async\s+)?def\s+(test_[A-Za-z0-9_]+)\s*\(/gm, nameGroup: 1, skipped: () => false, focused: () => false },
        { regex: /^\s*class\s+(Test[A-Za-z0-9_]+)\s*[:(]/gm, nameGroup: 1, skipped: () => false, focused: () => false },
      ];
    }
    if (lowerFile.endsWith('_test.go')) {
      return [
        { regex: /^\s*func\s+(Test[A-Za-z0-9_]+)\s*\(/gm, nameGroup: 1, skipped: () => false, focused: () => false },
      ];
    }
    if (lowerFile.endsWith('_test.rs')) {
      return [
        { regex: /#\[(?:tokio::)?test\][\s\S]{0,160}?\bfn\s+([A-Za-z0-9_]+)/g, nameGroup: 1, skipped: () => false, focused: () => false },
      ];
    }
    if (lowerFile.endsWith('_test.dart')) {
      return [
        { regex: /\b(?:test|testWidgets)\s*\(\s*(['"`])([^'"`]+)\1/g, nameGroup: 2, skipped: () => false, focused: () => false },
      ];
    }
    if (/\.(java|kt|cs|php)$/i.test(lowerFile)) {
      return [
        { regex: /@Test[\s\S]{0,220}?\b(?:fun|void|public\s+\w+|function)\s+([A-Za-z0-9_]+)/g, nameGroup: 1, skipped: () => false, focused: () => false },
      ];
    }
    return [
      {
        regex: /\b(?:describe|context|suite|it|test|specify)(?:\.(?:skip|only))?(?:\.each\s*\([^)]*\))?\s*\(\s*(['"`])([^'"`]+)\1/g,
        nameGroup: 2,
        skipped: commonStatus.skipped,
        focused: commonStatus.focused
      },
      {
        regex: /\b(?:xdescribe|xit|xtest|fdescribe|fit|ftest)\s*\(\s*(['"`])([^'"`]+)\1/g,
        nameGroup: 2,
        skipped: commonStatus.skipped,
        focused: commonStatus.focused
      },
    ];
  }

  private lineNumberAtOffset(content: string, offset: number): number {
    return content.slice(0, offset).split(/\r?\n/).length;
  }

  private testCaseId(file: string, name: string, line: number, index: number): string {
    const slug = `${file}:${line}:${name}:${index}`
      .replace(/\\/g, '/')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase();
    return `test_${slug || `case_${index}`}`;
  }

  private dedupeTestCases(tests: CASTestCase[]): CASTestCase[] {
    const seen = new Set<string>();
    return tests.filter(test => {
      const key = `${test.source?.file}:${test.source?.line}:${test.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private inferTestType(node: CASNode): 'unit' | 'integration' | 'e2e' | 'acceptance' {
    const name = (node.name || '').toLowerCase();
    const file = (node.source?.file || '').toLowerCase();

    if (name.includes('e2e') || file.includes('e2e') || file.includes('cypress')) return 'e2e';
    if (name.includes('integration') || file.includes('integration')) return 'integration';
    if (name.includes('acceptance') || file.includes('acceptance')) return 'acceptance';
    return 'unit';
  }

  private inferTestFramework(node: CASNode): string {
    const file = (node.source?.file || '').toLowerCase();
    const name = (node.name || '').toLowerCase();
    const lang = node.metadata?.language;

    if (file.endsWith('.spec.ts') || file.endsWith('.test.ts') || file.endsWith('.spec.js') || file.endsWith('.test.js')) {
      if (file.includes('cypress')) return 'cypress';
      if (file.includes('vitest')) return 'vitest';
      return 'jest';
    }
    if (file.endsWith('.test.tsx') || file.endsWith('.spec.tsx')) return 'jest';
    if (name.includes('testcase') || file.includes('unittest')) return 'unittest';
    if (file.includes('pytest') || file.includes('conftest')) return 'pytest';
    if (file.includes('django')) return 'django.test';
    if (file.endsWith('.py') && (file.includes('/tests/') || name.startsWith('test') || name.endsWith('tests'))) return 'pytest';
    if (file.endsWith('_test.go')) return 'go-test';
    if (file.endsWith('test.java') || file.endsWith('test.kt')) return 'junit';
    if (file.endsWith('tests.cs') || file.endsWith('test.cs')) return 'xunit';
    if (file.endsWith('_test.rs')) return 'rust-test';
    if (file.endsWith('_test.dart')) return 'flutter-test';
    if (lang === 'python') return 'pytest';
    if (lang === 'typescript' || lang === 'javascript') return 'jest';
    return 'unknown';
  }

  private buildMocks(nodes: CASNode[]): CASMock[] {
    const mocks: CASMock[] = [];

    const mockNodes = nodes.filter(n =>
      n.name.toLowerCase().includes('mock') ||
      n.name.includes('Mock') ||
      n.subcategories?.includes('mock')
    );

    for (const mock of mockNodes) {
      mocks.push({
        id: `mock_${mock.id}`,
        name: mock.name,
        type: this.inferMockType(mock),
        framework: 'unittest.mock'
      });
    }

    return mocks;
  }

  private inferMockType(node: CASNode): 'mock' | 'stub' | 'spy' | 'fake' {
    const name = node.name.toLowerCase();
    if (name.includes('stub')) return 'stub';
    if (name.includes('spy')) return 'spy';
    if (name.includes('fake')) return 'fake';
    return 'mock';
  }

  private buildFixtures(nodes: CASNode[]): CASFixture[] {
    const fixtures: CASFixture[] = [];
    const addedIds = new Set<string>();

    const fixtureNodes = nodes.filter(n =>
      n.name.includes('fixture') ||
      n.subcategories?.includes('fixture')
    );

    for (const fixture of fixtureNodes) {
      const id = `fixture_${fixture.id}`;
      if (addedIds.has(id)) continue;
      addedIds.add(id);
      fixtures.push({
        id,
        name: fixture.name,
        type: 'fixture',
        file_path: fixture.source?.file || ''
      });
    }

    const confTestFiles = nodes.filter(n =>
      n.type === 'file' &&
      (n.name === 'conftest.py' || n.source?.file?.endsWith('conftest.py'))
    );

    for (const conftest of confTestFiles) {
      const fixtureFunctions = nodes.filter(n =>
        n.parent === conftest.id &&
        n.type === 'function'
      );

      for (const fn of fixtureFunctions) {
        const id = `fixture_${fn.id}`;
        if (addedIds.has(id)) continue;
        addedIds.add(id);
        fixtures.push({
          id,
          name: fn.name,
          type: 'fixture',
          file_path: fn.source?.file || conftest.source?.file || ''
        });
      }
    }

    const setupMethods = nodes.filter(n =>
      (n.type === 'method' || n.type === 'function' || n.type === 'hook') &&
      (n.name === 'setUp' || n.name === 'tearDown' ||
       n.name === 'setUpClass' || n.name === 'tearDownClass' ||
       n.name === 'beforeEach' || n.name === 'afterEach' ||
       n.name === 'beforeAll' || n.name === 'afterAll' ||
       n.name === 'before' || n.name === 'after' ||
       n.name === 'setupForTest')
    );

    for (const setup of setupMethods) {
      const id = `fixture_${setup.id}`;
      if (addedIds.has(id)) continue;
      addedIds.add(id);
      fixtures.push({
        id,
        name: setup.name,
        type: 'fixture',
        file_path: setup.source?.file || ''
      });
    }

    const setupFiles = nodes.filter(n =>
      n.type === 'file' &&
      (n.name.startsWith('jest.setup') || n.name.startsWith('vitest.setup') ||
       n.name === 'setup.ts' || n.name === 'setup.js' ||
       n.name === 'test-setup.ts' || n.name === 'test-setup.js' ||
       n.name === 'globalSetup.ts' || n.name === 'globalSetup.js')
    );

    for (const setupFile of setupFiles) {
      const id = `fixture_${setupFile.id}`;
      if (addedIds.has(id)) continue;
      addedIds.add(id);
      fixtures.push({
        id,
        name: setupFile.name,
        type: 'fixture',
        file_path: setupFile.source?.file || setupFile.name
      });
    }

    const factoryNodes = nodes.filter(n =>
      (n.type === 'function' || n.type === 'class') &&
      (n.name.toLowerCase().includes('factory') ||
       n.name.toLowerCase().includes('builder') ||
       n.name.toLowerCase().includes('seed'))
    );

    for (const factory of factoryNodes) {
      const id = `fixture_${factory.id}`;
      if (addedIds.has(id)) continue;
      addedIds.add(id);
      fixtures.push({
        id,
        name: factory.name,
        type: 'factory',
        file_path: factory.source?.file || ''
      });
    }

    return fixtures;
  }

  private buildTestSummary(nodes: CASNode[], entryPoints: CASEntryPoint[]): CASTestSummary {
    const testNodes = nodes.filter(n =>
      (n.type === 'method' || n.type === 'function') &&
      (n.name.startsWith('test_') || n.name.startsWith('test') ||
       n.name.startsWith('it') || n.name.startsWith('should') ||
       n.name.startsWith('specify') || n.subcategories?.includes('test'))
    );

    let unit = 0;
    let integration = 0;
    let e2e = 0;
    let acceptance = 0;

    for (const node of testNodes) {
      const type = this.inferTestType(node);
      switch (type) {
        case 'unit': unit++; break;
        case 'integration': integration++; break;
        case 'e2e': e2e++; break;
        case 'acceptance': acceptance++; break;
      }
    }

    return {
      total_tests: testNodes.length,
      by_type: {
        unit,
        integration,
        e2e,
        acceptance,
        bdd: 0,
        other: 0
      },
      by_status: {
        passing: testNodes.length,
        failing: 0,
        skipped: 0,
        flaky: 0
      },
      coverage: {
        overall_percentage: undefined
      },
      mocks: {
        total: nodes.filter(n => n.name.toLowerCase().includes('mock')).length
      },
      fixtures: {
        total: nodes.filter(n =>
          n.name.includes('fixture') ||
          n.name === 'beforeEach' || n.name === 'afterEach' ||
          n.name === 'beforeAll' || n.name === 'afterAll' ||
          n.name === 'setUp' || n.name === 'tearDown'
        ).length
      }
    };
  }

  private isTestingFrameworkContribution(contribution: any): boolean {
    const name = String(contribution?.analyzer_name || contribution?.analyzer_id || '').toLowerCase();
    return /\b(jest|vitest|mocha|jasmine|cypress|playwright|testing-library|test)\b/.test(name);
  }

  private buildValidation(
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[] = [],
    exitPoints: CASExitPoint[] = [],
    runtimeLinks: CASRuntimeStaticLink[] = [],
    analysisFacts: CASAnalysisFact[] = []
  ): CASValidation {
    const nodeIds = new Set(nodes.map(n => n.id));
    const entryPointIds = new Set(entryPoints.map(entryPoint => entryPoint.id));
    const exitPointIds = new Set(exitPoints.map(exitPoint => exitPoint.id));
    const graphEndpointIds = new Set([...nodeIds, ...entryPointIds, ...exitPointIds]);
    const warnings: Array<{ path?: string; message?: string }> = [];
    let danglingEdges = 0;
    const connectedNodeIds = new Set<string>();

    for (const edge of edges) {
      if (!graphEndpointIds.has(edge.source)) {
        danglingEdges++;
        warnings.push({
          path: `edges[${edge.id}].source`,
          message: `Edge source "${edge.source}" references nonexistent graph endpoint`
        });
      } else if (nodeIds.has(edge.source)) {
        connectedNodeIds.add(edge.source);
      }
      if (!graphEndpointIds.has(edge.target)) {
        danglingEdges++;
        warnings.push({
          path: `edges[${edge.id}].target`,
          message: `Edge target "${edge.target}" references nonexistent graph endpoint`
        });
      } else if (nodeIds.has(edge.target)) {
        connectedNodeIds.add(edge.target);
      }
    }

    const nodesWithLocation = nodes.filter(n => n.source?.file && n.source?.line).length;
    const edgesWithMetadata = edges.filter(e => e.metadata && Object.keys(e.metadata).length > 0).length;
    const documentedNodes = nodes.filter(n => n.documentation).length;
    const entryPointNodeIds = new Set(entryPoints.flatMap(entryPoint => [entryPoint.source_node, entryPoint.handler?.node_id].filter(Boolean) as string[]));
    const exitPointNodeIds = new Set(exitPoints.map(exitPoint => exitPoint.source_node).filter(Boolean));
    const orphanedNodes = nodes.filter(node =>
      !connectedNodeIds.has(node.id) &&
      !entryPointNodeIds.has(node.id) &&
      !exitPointNodeIds.has(node.id) &&
      node.type !== 'system'
    ).length;
    const entryPointsWithHandlers = entryPoints.filter(entryPoint => {
      const handlerNodeId = entryPoint.handler?.node_id || entryPoint.source_node;
      return !!handlerNodeId && nodeIds.has(handlerNodeId);
    }).length;
    const exitPointsWithSources = exitPoints.filter(exitPoint => nodeIds.has(exitPoint.source_node)).length;
    const runtimeLinksWithInstrumentation = runtimeLinks.filter(link => link.instrumentation_points.length > 0).length;
    const factsWithEvidence = analysisFacts.filter(fact => fact.evidence.length > 0).length;
    const coverageParts = [
      nodes.length > 0 ? nodesWithLocation / nodes.length : 1,
      edges.length > 0 ? (edges.length - danglingEdges) / edges.length : 1,
      entryPoints.length > 0 ? entryPointsWithHandlers / entryPoints.length : 1,
      exitPoints.length > 0 ? exitPointsWithSources / exitPoints.length : 1,
      runtimeLinks.length > 0 ? runtimeLinksWithInstrumentation / runtimeLinks.length : 1,
      analysisFacts.length > 0 ? factsWithEvidence / analysisFacts.length : 1
    ];
    const relationshipCoverageScore = Math.round(
      (coverageParts.reduce((sum, value) => sum + value, 0) / coverageParts.length) * 100
    );

    return {
      schema_version: '1.8.0',
      validation_warnings: warnings.length > 0 ? warnings : undefined,
      completeness: {
        nodes_with_location: nodesWithLocation,
        edges_with_metadata: edgesWithMetadata,
        documented_nodes: documentedNodes
      },
      graph_integrity: {
        total_edges: edges.length,
        dangling_edges: danglingEdges,
        connected_nodes: connectedNodeIds.size,
        orphaned_nodes: orphanedNodes,
        entry_points_with_handlers: entryPointsWithHandlers,
        exit_points_with_sources: exitPointsWithSources,
        runtime_links_with_instrumentation: runtimeLinksWithInstrumentation,
        facts_with_evidence: factsWithEvidence,
        relationship_coverage_score: relationshipCoverageScore
      }
    };
  }

  private buildDocumentationSummary(nodes: CASNode[]): CASDocumentationSummary {
    const functionTypes = new Set(['function', 'method', 'constructor']);
    const classTypes = new Set(['class']);
    const interfaceTypes = new Set(['interface', 'type_alias']);
    const moduleTypes = new Set(['module', 'namespace', 'package']);

    const byType = {
      functions: { documented: 0, total: 0, coverage: 0 },
      classes: { documented: 0, total: 0, coverage: 0 },
      interfaces: { documented: 0, total: 0, coverage: 0 },
      modules: { documented: 0, total: 0, coverage: 0 }
    };

    let totalDocumented = 0;
    let totalDescriptionLength = 0;
    let paramsDocumented = 0;
    let returnsDocumented = 0;
    let examplesProvided = 0;
    let deprecatedItems = 0;
    const byDocType: Record<string, number> = {};
    const missingDocs: CASDocumentationSummary['missing_documentation'] = [];

    for (const node of nodes) {
      const hasDoc = !!node.documentation;
      const type = node.type;

      if (functionTypes.has(type)) {
        byType.functions.total++;
        if (hasDoc) byType.functions.documented++;
      } else if (classTypes.has(type)) {
        byType.classes.total++;
        if (hasDoc) byType.classes.documented++;
      } else if (interfaceTypes.has(type)) {
        byType.interfaces.total++;
        if (hasDoc) byType.interfaces.documented++;
      } else if (moduleTypes.has(type)) {
        byType.modules.total++;
        if (hasDoc) byType.modules.documented++;
      }

      if (hasDoc) {
        totalDocumented++;
        const doc = node.documentation!;
        const desc = doc.description || doc.summary || doc.raw || '';
        totalDescriptionLength += desc.length;

        if (doc.parameters && doc.parameters.length > 0) paramsDocumented++;
        if (doc.returns || doc.return_info) returnsDocumented++;
        if (doc.examples && doc.examples.length > 0) examplesProvided++;
        if (doc.tags?.some(t => t.tag === 'deprecated')) deprecatedItems++;

        const format = doc.format || doc.type || 'other';
        byDocType[format] = (byDocType[format] || 0) + 1;
      } else if (node.metadata?.is_exported || node.metadata?.access_modifier === 'public') {
        const importance: 'low' | 'medium' | 'high' =
          classTypes.has(type) || interfaceTypes.has(type) ? 'high' :
          functionTypes.has(type) ? 'medium' : 'low';

        missingDocs.push({
          node_id: node.id,
          node_name: node.name,
          node_type: type,
          importance,
          reason: `Exported ${type} lacks documentation`
        });
      }
    }

    for (const key of Object.keys(byType) as Array<keyof typeof byType>) {
      const entry = byType[key];
      entry.coverage = entry.total > 0 ? entry.documented / entry.total : 0;
    }

    const totalApplicable = byType.functions.total + byType.classes.total +
      byType.interfaces.total + byType.modules.total;

    return {
      total_documented_nodes: totalDocumented,
      documentation_coverage: totalApplicable > 0 ? totalDocumented / totalApplicable : 0,
      by_type: byType,
      by_documentation_type: byDocType,
      quality_metrics: {
        average_description_length: totalDocumented > 0 ? Math.round(totalDescriptionLength / totalDocumented) : 0,
        parameters_documented: paramsDocumented,
        returns_documented: returnsDocumented,
        examples_provided: examplesProvided,
        deprecated_items: deprecatedItems
      },
      missing_documentation: missingDocs.slice(0, 100)
    };
  }

  private buildTodosSummary(nodes: CASNode[]): CASTodoSummary {
    let totalTodos = 0;
    let totalFixmes = 0;
    let totalHacks = 0;
    let totalWarnings = 0;
    const byPriority = { critical: 0, high: 0, medium: 0, low: 0 };
    const byCategory: Record<string, number> = {};
    let technicalDebtItems = 0;
    let blockingItems = 0;
    const fileMap = new Map<string, { count: number; types: Set<string> }>();

    for (const node of nodes) {
      if (!node.todos || node.todos.length === 0) continue;

      for (const todo of node.todos) {
        switch (todo.type) {
          case 'TODO': totalTodos++; break;
          case 'FIXME': totalFixmes++; break;
          case 'HACK': totalHacks++; break;
          case 'WARNING': totalWarnings++; break;
        }

        const priority = todo.priority || 'medium';
        byPriority[priority]++;

        const category = todo.category || todo.classification?.category || 'general';
        byCategory[category] = (byCategory[category] || 0) + 1;

        if (todo.classification?.technical_debt || todo.type === 'HACK' || todo.type === 'REFACTOR' as any) {
          technicalDebtItems++;
        }
        if (todo.classification?.blocking) {
          blockingItems++;
        }

        const file = todo.location?.file || node.source?.file || 'unknown';
        if (!fileMap.has(file)) {
          fileMap.set(file, { count: 0, types: new Set() });
        }
        const entry = fileMap.get(file)!;
        entry.count++;
        entry.types.add(todo.type);
      }
    }

    const hotspots = Array.from(fileMap.entries())
      .map(([file, data]) => ({
        file,
        todo_count: data.count,
        types: Array.from(data.types)
      }))
      .sort((a, b) => b.todo_count - a.todo_count)
      .slice(0, 20);

    return {
      total_todos: totalTodos,
      total_fixmes: totalFixmes,
      total_hacks: totalHacks,
      total_warnings: totalWarnings,
      by_priority: byPriority,
      by_category: byCategory,
      technical_debt_items: technicalDebtItems,
      blocking_items: blockingItems,
      hotspots
    };
  }

  private buildImplementationHealth(nodes: CASNode[]): CASImplementationHealth {
    let complete = 0;
    let partial = 0;
    let stubs = 0;
    let notImplemented = 0;
    let deprecated = 0;
    let experimental = 0;
    const riskAreas: CASImplementationHealth['risk_areas'] = [];
    const deprecationTimeline: CASImplementationHealth['deprecation_timeline'] = [];

    for (const node of nodes) {
      if (!node.implementation_status) continue;

      switch (node.implementation_status.status) {
        case 'complete': complete++; break;
        case 'partial': partial++; break;
        case 'stub': stubs++; break;
        case 'not-implemented': notImplemented++; break;
        case 'deprecated': deprecated++; break;
        case 'experimental': experimental++; break;
      }

      if (node.implementation_status.status === 'stub' || node.implementation_status.status === 'not-implemented') {
        riskAreas.push({
          node_id: node.id,
          node_name: node.name,
          risk_type: 'incomplete',
          risk_level: node.implementation_status.status === 'not-implemented' ? 'high' : 'medium',
          recommendation: `Complete implementation of ${node.name}`
        });
      }

      if (node.implementation_status.status === 'deprecated') {
        riskAreas.push({
          node_id: node.id,
          node_name: node.name,
          risk_type: 'deprecated',
          risk_level: 'medium',
          recommendation: `Migrate away from deprecated ${node.name}`
        });

        if (node.implementation_status.deprecation) {
          deprecationTimeline.push({
            node_id: node.id,
            node_name: node.name,
            deprecated_since: node.implementation_status.deprecation.deprecated_since || 'unknown',
            removal_version: node.implementation_status.deprecation.removal_version
          });
        }
      }

      if (node.implementation_status.status === 'experimental') {
        riskAreas.push({
          node_id: node.id,
          node_name: node.name,
          risk_type: 'unstable',
          risk_level: 'low',
          recommendation: `Monitor stability of experimental ${node.name}`
        });
      }
    }

    const total = complete + partial + stubs + notImplemented + deprecated + experimental;
    const healthScore = total > 0 ? (complete + partial * 0.5) / total : 1.0;

    return {
      complete_implementations: complete,
      partial_implementations: partial,
      stubs,
      not_implemented: notImplemented,
      deprecated,
      experimental,
      health_score: Math.round(healthScore * 100) / 100,
      risk_areas: riskAreas.slice(0, 50),
      deprecation_timeline: deprecationTimeline.length > 0 ? deprecationTimeline : undefined
    };
  }

  private buildSystemHealth(
    architectureSummary: CASArchitectureSummary,
    implementationHealth: CASImplementationHealth,
    changeRiskSummary: CASChangeRiskSummary,
    idiomDetection: ReturnType<typeof detectCodebaseIdioms>,
    nodes: CASNode[],
    callChains: CASCallChain[],
    runtime: CASRuntime
  ): CASSystemHealth {
    const riskAreas: CASSystemHealth['risk_areas'] = [];
    const patternBalance = architectureSummary.pattern_balance;
    const patterns = architectureSummary.architectural_patterns || [];
    const primaryParadigms = patterns
      .filter(pattern => pattern.confidence >= 0.65 && pattern.category !== 'anti-pattern')
      .map(pattern => pattern.name)
      .slice(0, 8);
    const conflictingParadigms = patterns
      .filter(pattern => pattern.category === 'anti-pattern' || /mixed|legacy|god object|circular/i.test(pattern.name))
      .map(pattern => pattern.name)
      .slice(0, 8);
    const idiomViolations = idiomDetection.violations || [];
    const namingViolations = idiomViolations.filter(v => v.category === 'naming').length;
    const diViolations = idiomViolations.filter(v => v.category === 'dependency-injection').length;
    const boundaryViolations = idiomViolations.filter(v => v.category === 'module-boundary').length;
    const duplicateNodes = this.detectDuplicateConceptSignals(nodes);
    const complexNodes = nodes
      .filter(node => (node.metadata?.complexity?.cyclomatic || 0) >= 20)
      .sort((a, b) => (b.metadata?.complexity?.cyclomatic || 0) - (a.metadata?.complexity?.cyclomatic || 0))
      .slice(0, 10);
    const untestedCritical = changeRiskSummary.untested_critical_paths || [];
    const runtimeMissing = runtime.instrumentation?.missing_runtime_coverage || [];

    if (patternBalance && patternBalance.status !== 'balanced') {
      riskAreas.push({
        id: 'pattern-balance',
        type: 'pattern-balance',
        severity: patternBalance.status === 'mixed' ? 'medium' : 'high',
        title: `Architecture pattern balance is ${patternBalance.status}`,
        description: patternBalance.risks.join(' ') || 'Architecture patterns are not evenly represented across the codebase.',
        evidence: patternBalance.risks,
        recommendation: patternBalance.recommendations[0] || 'Prefer the dominant local pattern and use nearby files as examples.',
        agent_guidance: 'Before introducing new architecture, retrieve architecture_summary and codebase_idioms, then extend the dominant local pattern.'
      });
    }

    if (conflictingParadigms.length > 0 || primaryParadigms.length > 6) {
      riskAreas.push({
        id: 'paradigm-drift',
        type: 'paradigm-drift',
        severity: conflictingParadigms.length > 2 ? 'high' : 'medium',
        title: 'Multiple architectural paradigms need explicit alignment',
        description: 'CAS detected several architecture patterns or anti-patterns that can cause agents to mix paradigms across features.',
        evidence: [...primaryParadigms, ...conflictingParadigms].slice(0, 12),
        recommendation: 'Choose the target-area paradigm before editing and avoid copying patterns from unrelated subsystems.',
        agent_guidance: 'Use get_system_health, get_codebase_idioms, and get_agent_work_packet before multi-file work; keep new files inside the selected subsystem paradigm.'
      });
    }

    if (duplicateNodes.length > 0) {
      riskAreas.push({
        id: 'duplication-signals',
        type: 'duplication',
        severity: duplicateNodes.length >= 5 ? 'high' : 'medium',
        title: 'Possible duplicate domain or service concepts',
        description: 'Similar concept names appear in the same architectural role, which can lead agents to create parallel implementations instead of extending the owner.',
        affected_files: this.uniqueHealthStrings(duplicateNodes.flatMap(item => item.files)).slice(0, 20),
        affected_nodes: duplicateNodes.map(item => item.node_ids).flat().slice(0, 20),
        evidence: duplicateNodes.map(item => `${item.concept} (${item.role}): ${item.count} nodes`).slice(0, 10),
        recommendation: 'Merge duplicate concepts or document a clear owner before adding adjacent behavior.',
        agent_guidance: 'Search capability memory and existing domain concepts before creating a new model, service, repository, or capability.'
      });
    }

    if (complexNodes.length > 0) {
      riskAreas.push({
        id: 'complexity-hotspots',
        type: 'complexity',
        severity: complexNodes.some(node => (node.metadata?.complexity?.cyclomatic || 0) >= 50) ? 'high' : 'medium',
        title: 'Complexity hotspots need targeted tests before changes',
        description: 'Several nodes have high cyclomatic complexity and are risky to modify without flow-level tests.',
        affected_files: this.uniqueHealthStrings(complexNodes.map(node => node.source?.file).filter(Boolean) as string[]).slice(0, 10),
        affected_nodes: complexNodes.map(node => node.id),
        evidence: complexNodes.map(node => `${node.name}: cyclomatic ${node.metadata?.complexity?.cyclomatic}`),
        recommendation: 'Refactor behind tests or split complex behavior into existing service/use-case boundaries.',
        agent_guidance: 'Call assess_change_risk and find_tests for complexity hotspots before edits; prefer small behavior-preserving refactors.'
      });
    }

    for (const [category, count, type, title] of [
      ['naming', namingViolations, 'naming-drift', 'Naming convention drift'],
      ['dependency-injection', diViolations, 'dependency-injection-drift', 'Dependency injection convention drift'],
      ['module-boundary', boundaryViolations, 'module-boundary-drift', 'Module boundary convention drift'],
    ] as const) {
      if (count === 0) continue;
      const examples = idiomViolations.filter(v => v.category === category).slice(0, 8);
      riskAreas.push({
        id: type,
        type,
        severity: count >= 5 ? 'high' : 'medium',
        title,
        description: `${count} repo-local idiom violation(s) were detected.`,
        affected_files: this.uniqueHealthStrings(examples.map(v => v.file).filter(Boolean) as string[]),
        affected_nodes: examples.map(v => v.node_id).filter(Boolean) as string[],
        evidence: examples.map(v => v.description),
        recommendation: examples[0]?.recommendation || 'Align new work with the high-confidence local idiom examples.',
        agent_guidance: 'Run validate_codebase_idioms after edits and fix convention drift before finalizing.'
      });
    }

    if (implementationHealth.risk_areas.length > 0) {
      riskAreas.push({
        id: 'implementation-gaps',
        type: 'implementation-gap',
        severity: implementationHealth.risk_areas.some(area => area.risk_level === 'high') ? 'high' : 'medium',
        title: 'Incomplete or unstable implementation areas',
        description: `${implementationHealth.risk_areas.length} implementation health risk(s) were detected.`,
        affected_nodes: implementationHealth.risk_areas.map(area => area.node_id).slice(0, 20),
        evidence: implementationHealth.risk_areas.slice(0, 8).map(area => `${area.node_name}: ${area.risk_type}`),
        recommendation: 'Complete or isolate incomplete behavior before building dependent features.',
        agent_guidance: 'Do not build new features on stubbed or deprecated nodes unless the task explicitly replaces them.'
      });
    }

    if (untestedCritical.length > 0) {
      riskAreas.push({
        id: 'untested-critical-paths',
        type: 'test-gap',
        severity: 'high',
        title: 'Critical paths lack mapped tests',
        description: `${untestedCritical.length} critical path(s) do not have mapped test protection.`,
        affected_nodes: untestedCritical.slice(0, 20),
        evidence: untestedCritical.slice(0, 10),
        recommendation: 'Add or run focused tests before changing these paths.',
        agent_guidance: 'Use find_tests and get_flow_coverage before edits; add regression tests when coverage is missing.'
      });
    }

    if (runtimeMissing.length > 0) {
      riskAreas.push({
        id: 'runtime-coverage-gaps',
        type: 'runtime-coverage-gap',
        severity: runtimeMissing.length >= 10 ? 'medium' : 'low',
        title: 'Runtime telemetry coverage is incomplete',
        description: 'Static CAS can identify instrumentable paths that do not yet have runtime observations.',
        affected_nodes: runtimeMissing.slice(0, 20),
        evidence: runtimeMissing.slice(0, 10),
        recommendation: 'Install or configure the runtime SDK on high-volume entry points and external exits.',
        agent_guidance: 'For production bug triage, combine get_runtime_observations with get_operational_priorities and static risk.'
      });
    }

    // Score calibration rationale:
    // - Every penalty is proportional to the measured extent of the problem
    //   (affected count over its relevant population), capped per category.
    //   The previous flat per-category deduction (high=18, medium=10) meant
    //   any production repo with the usual mix of signals (some duplication,
    //   a few complexity hotspots, thin tests, no telemetry yet) bottomed out
    //   at 26-36 and always read "critical", which carried no signal.
    // - Category caps express how strongly each dimension predicts change
    //   failure: untested critical paths (25) and incomplete implementations
    //   (20) dominate; coherence and convention drift are bounded (5-12);
    //   absent runtime telemetry is informational (3) because it describes
    //   SDK rollout status, not code health.
    // - Status bands: critical < 25 means structurally unsafe to modify;
    //   at-risk < 50; watch < 75; healthy >= 75.
    const extentRatio = (count: number, population: number): number =>
      Math.min(1, count / Math.max(1, population));
    const calibratedPenalties = new Map<string, number>([
      ['pattern-balance', patternBalance?.status === 'mixed' ? 5 : 8],
      ['paradigm-drift', conflictingParadigms.length > 2 ? 8 : 5],
      ['duplication-signals', 12 * extentRatio(duplicateNodes.length, 20)],
      ['complexity-hotspots',
        (complexNodes.some(node => (node.metadata?.complexity?.cyclomatic || 0) >= 50) ? 12 : 8) *
        extentRatio(complexNodes.length, 10)],
      ['naming-drift', 6 * extentRatio(namingViolations, 20)],
      ['dependency-injection-drift', 6 * extentRatio(diViolations, 20)],
      ['module-boundary-drift', 6 * extentRatio(boundaryViolations, 20)],
      ['implementation-gaps', 20 * (1 - Math.max(0, Math.min(1, implementationHealth.health_score)))],
      ['untested-critical-paths',
        25 * extentRatio(untestedCritical.length, Math.max(10, changeRiskSummary.high_risk_nodes.length))],
      ['runtime-coverage-gaps', 3 * extentRatio(runtimeMissing.length, 20)],
    ]);
    const fallbackPenalty = (severity: CASSystemHealth['risk_areas'][number]['severity']): number =>
      severity === 'critical' ? 12 : severity === 'high' ? 8 : severity === 'medium' ? 5 : 2;
    const penalty = riskAreas.reduce((total, area) =>
      total + (calibratedPenalties.get(area.id) ?? fallbackPenalty(area.severity)), 0);
    const score = Math.max(0, Math.min(100, Math.round(100 - penalty)));
    const status: CASSystemHealth['status'] =
      score < 25 ? 'critical' :
      score < 50 ? 'at-risk' :
      score < 75 ? 'watch' : 'healthy';
    const coherenceStatus: CASSystemHealth['coherence']['status'] =
      conflictingParadigms.length > 3 || duplicateNodes.length > 6 ? 'fragmented' :
      conflictingParadigms.length > 0 || patternBalance?.status === 'mixed' ? 'drifting' :
      namingViolations + diViolations + boundaryViolations > 0 ? 'mixed' : 'coherent';

    return {
      score,
      status,
      summary: riskAreas.length === 0
        ? 'No major coherence, complexity, duplication, implementation, test, or runtime-coverage risks were detected.'
        : `${riskAreas.length} system health risk area(s) detected across architecture coherence, implementation health, tests, idioms, and runtime coverage.`,
      risk_areas: riskAreas.slice(0, 25),
      coherence: {
        status: coherenceStatus,
        paradigm_count: primaryParadigms.length,
        primary_paradigms: primaryParadigms,
        conflicting_paradigms: conflictingParadigms,
        naming_convention_violations: namingViolations,
        dependency_injection_violations: diViolations,
        module_boundary_violations: boundaryViolations,
        duplication_signals: duplicateNodes.length
      },
      remediation: {
        immediate: riskAreas.slice(0, 6).map(area => area.recommendation),
        agent_rules: this.uniqueHealthStrings(riskAreas.map(area => area.agent_guidance)).slice(0, 8),
        validation_tools: [
          'get_system_health',
          'get_codebase_idioms',
          'validate_codebase_idioms',
          'assess_change_risk',
          'find_tests',
          'get_runtime_observations',
          'get_operational_priorities'
        ]
      }
    };
  }

  private detectDuplicateConceptSignals(nodes: CASNode[]): Array<{ concept: string; role: string; count: number; node_ids: string[]; files: string[] }> {
    const conceptMap = new Map<string, Map<string, Array<{ id: string; file?: string }>>>();
    for (const node of nodes) {
      if (!['class', 'interface', 'service', 'repository', 'entity', 'model', 'component', 'function'].includes(node.type)) continue;
      const concept = this.normalizedDuplicateConceptName(node);
      if (concept.length < 4) continue;
      if (this.isGenericDuplicateConcept(concept)) continue;
      const role = this.duplicateConceptRole(node);
      const byRole = conceptMap.get(concept) || new Map<string, Array<{ id: string; file?: string }>>();
      const current = byRole.get(role) || [];
      current.push({ id: node.id, file: node.source?.file });
      byRole.set(role, current);
      conceptMap.set(concept, byRole);
    }

    const duplicateSignals: Array<{ concept: string; role: string; count: number; node_ids: string[]; files: string[] }> = [];
    for (const [concept, byRole] of conceptMap.entries()) {
      for (const [role, entries] of byRole.entries()) {
        const uniqueFiles = this.uniqueHealthStrings(entries.map(entry => entry.file).filter(Boolean) as string[]);
        if (entries.length <= 1) continue;
        if (uniqueFiles.length <= 1 && role !== 'business-logic') continue;
        duplicateSignals.push({
          concept,
          role,
          count: entries.length,
          node_ids: entries.map(entry => entry.id),
          files: uniqueFiles
        });
      }
    }

    return duplicateSignals
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);
  }

  private normalizedDuplicateConceptName(node: CASNode): string {
    return node.name
      .replace(/(controller|handler|resolver|route|service|manager|usecase|use_case|repository|repo|dao|gateway|model|entity|component|viewmodel|view|page|dto|schema|module|provider|store|hook)$/i, '')
      .replace(/[^a-zA-Z0-9]/g, '')
      .toLowerCase();
  }

  private duplicateConceptRole(node: CASNode): string {
    const type = node.type.toLowerCase();
    const name = node.name.toLowerCase();
    const file = (node.source?.file || '').toLowerCase();
    if (type === 'controller' || /controller|resolver|route|handler/.test(name) || /controller|routes?|handlers?/.test(file)) return 'entry-adapter';
    if (type === 'repository' || /repository|repo|dao|gateway/.test(name) || /repositories?|repos?|dao|gateways?/.test(file)) return 'data-access';
    if (type === 'entity' || type === 'model' || /entity|model|schema|dto/.test(name) || /entities|models|schemas|dto/.test(file)) return 'data-model';
    if (type === 'component' || /component|page|view|screen/.test(name) || /components?|pages?|views?|screens?/.test(file)) return 'view';
    if (type === 'service' || /service|manager|usecase|use_case/.test(name) || /services?|use-cases?|use_cases?/.test(file)) return 'business-logic';
    if (type === 'function') return 'function';
    return type || 'unknown';
  }

  private isGenericDuplicateConcept(concept: string): boolean {
    return new Set([
      'base',
      'common',
      'config',
      'default',
      'error',
      'handler',
      'helper',
      'index',
      'main',
      'shared',
      'test',
      'types',
      'utils'
    ]).has(concept);
  }

  private uniqueHealthStrings(values: string[]): string[] {
    return [...new Set(values.filter(Boolean))];
  }

  private buildRuntime(
    projectPath: string,
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[],
    externalServices: CASExternalService[],
    configuration: CASConfiguration,
    callChains: CASCallChain[]
  ): CASRuntime {
    const packageJsonPath = path.join(projectPath, 'package.json');
    const dockerfilePath = path.join(projectPath, 'Dockerfile');
    const dockerComposePath = path.join(projectPath, 'docker-compose.yml');
    const composePath = path.join(projectPath, 'compose.yml');
    const packageJson = this.safeReadJson(packageJsonPath) || {};
    const scripts = packageJson.scripts || {};
    const runtimeDependencies = [
      ...Object.keys(packageJson.dependencies || {}),
      ...Object.keys(packageJson.peerDependencies || {})
    ];

    const healthEntryPoint = entryPoints.find(ep => {
      const value = `${ep.name} ${ep.trigger?.path || ''}`.toLowerCase();
      return value.includes('health') || value.includes('ready') || value.includes('live');
    });
    const metricsEntryPoint = entryPoints.find(ep => {
      const value = `${ep.name} ${ep.trigger?.path || ''}`.toLowerCase();
      return value.includes('metrics') || value.includes('prometheus');
    });

    const deployment: CASRuntime['deployment'] = {};
    if (fs.existsSync(dockerfilePath)) {
      deployment.type = 'container';
    }
    if (fs.existsSync(dockerComposePath) || fs.existsSync(composePath)) {
      deployment.orchestration = 'docker-compose';
    } else if (fs.existsSync(path.join(projectPath, 'k8s')) || fs.existsSync(path.join(projectPath, 'kubernetes'))) {
      deployment.orchestration = 'kubernetes';
    } else if (fs.existsSync(path.join(projectPath, 'vercel.json'))) {
      deployment.type = 'vercel';
    } else if (fs.existsSync(path.join(projectPath, 'render.yaml'))) {
      deployment.type = 'render';
    }

    const runtime: CASRuntime = {};
    if (Object.keys(deployment).length > 0) {
      runtime.deployment = deployment;
    }

    const runtimeName = packageJson.engines?.node
      ? `node ${packageJson.engines.node}`
      : packageJson.engines?.python
        ? `python ${packageJson.engines.python}`
        : scripts.start
          ? 'node'
          : undefined;

    runtime.dependencies = {
      runtime: runtimeName,
      system_libraries: runtimeDependencies.slice(0, 50),
      external_services: externalServices.map(service => service.name)
    };

    if (healthEntryPoint || metricsEntryPoint || configuration.environment_variables?.some(env => env.name.toLowerCase().includes('log'))) {
      runtime.monitoring = {
        health_check: healthEntryPoint?.trigger?.path || healthEntryPoint?.name,
        readiness_check: entryPoints.find(ep => `${ep.name} ${ep.trigger?.path || ''}`.toLowerCase().includes('ready'))?.trigger?.path,
        metrics_endpoint: metricsEntryPoint?.trigger?.path || metricsEntryPoint?.name,
        logging: configuration.environment_variables?.some(env => env.name.toLowerCase().includes('log'))
          ? { destinations: ['application'] }
          : undefined
      };
    }

    runtime.instrumentation = {
      instrumentable_entry_points: entryPoints
        .filter(ep => ep.source_node || ep.handler?.node_id)
        .map(ep => ep.id),
      instrumentable_exit_points: exitPoints
        .filter(ep => ep.source_node || (ep.connected_nodes || []).length > 0)
        .map(ep => ep.id),
      observed_call_chains: callChains
        .filter(chain => !!chain.runtime_stats)
        .map(chain => chain.id),
      missing_runtime_coverage: callChains
        .filter(chain => !chain.runtime_stats)
        .slice(0, 100)
        .map(chain => chain.id)
    };

    return runtime;
  }

  private buildRepositoryLinks(
    projectPath: string,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[],
    externalServices: CASExternalService[],
    libraries: CASLibrary[],
    databaseSchema: CASDatabaseSchema,
    configuration: CASConfiguration
  ): CASCrossRepositoryLink[] {
    const sourceRepository = {
      url: this.readGitRemote(projectPath),
      path: projectPath
    };
    const links: CASCrossRepositoryLink[] = [];

    for (const service of externalServices) {
      if (!service.endpoint) continue;
      links.push({
        id: `repo_link_api_${service.id}`,
        type: 'api',
        source_repository: {
          ...sourceRepository,
          node_ids: service.connected_nodes
        },
        target_repository: {
          url: service.endpoint
        },
        connection: {
          protocol: service.endpoint.startsWith('http') ? 'http' : service.type,
          endpoint: service.endpoint
        },
        metadata: {
          verified: false,
          confidence: 0.7,
          evidence: [{
            kind: 'runtime-signal',
            source: service.name,
            confidence: 0.7
          }]
        }
      });
    }

    for (const library of libraries) {
      const name = library.name || '';
      const lower = name.toLowerCase();
      const isContractPackage = name.startsWith('@') ||
        lower.includes('client') ||
        lower.includes('sdk') ||
        lower.includes('schema') ||
        lower.includes('proto') ||
        lower.includes('contract');

      if (!isContractPackage) continue;

      links.push({
        id: `repo_link_library_${this.slugForId(name)}`,
        type: lower.includes('schema') || lower.includes('proto') || lower.includes('contract') ? 'shared-schema' : 'library',
        source_repository: {
          ...sourceRepository,
          node_ids: library.connected_nodes
        },
        connection: {
          package_name: name,
          version: library.version
        },
        metadata: {
          verified: false,
          confidence: name.startsWith('@') ? 0.75 : 0.55,
          evidence: [{
            kind: 'dependency',
            source: name,
            confidence: name.startsWith('@') ? 0.75 : 0.55
          }]
        }
      });
    }

    for (const exitPoint of exitPoints) {
      if (exitPoint.type !== 'message' && exitPoint.type !== 'event') continue;
      links.push({
        id: `repo_link_message_${exitPoint.id}`,
        type: 'message-contract',
        source_repository: {
          ...sourceRepository,
          node_ids: [exitPoint.source_node, ...(exitPoint.connected_nodes || [])].filter(Boolean)
        },
        connection: {
          broker: exitPoint.target?.service_id,
          exchange: exitPoint.target?.resource,
          routing_key: exitPoint.target?.endpoint
        },
        metadata: {
          verified: false,
          confidence: 0.65,
          evidence: [{
            kind: 'graph',
            source: exitPoint.id,
            file: this.nodeFile(nodes, exitPoint.source_node),
            confidence: 0.65
          }]
        }
      });
    }

    if (databaseSchema.entities.length > 0) {
      const configFiles = configuration.config_files?.map(file => file.path).filter((value): value is string => !!value) || [];
      links.push({
        id: `repo_link_database_${this.slugForId(databaseSchema.entities.map(entity => entity.name).slice(0, 5).join('_'))}`,
        type: 'shared-database',
        source_repository: {
          ...sourceRepository,
          node_ids: databaseSchema.entities
            .flatMap(entity => nodes
              .filter(node => entity.source_file && node.source?.file === entity.source_file)
              .map(node => node.id))
            .slice(0, 100)
        },
        connection: {
          contract: databaseSchema.entities.map(entity => entity.name).join(',')
        },
        metadata: {
          verified: false,
          confidence: configFiles.length > 0 ? 0.7 : 0.5,
          evidence: configFiles.length > 0
            ? configFiles.map(file => ({
              kind: 'configuration' as const,
              source: file,
              file,
              confidence: 0.7
            }))
            : [{
              kind: 'graph' as const,
              source: 'database_schema',
              confidence: 0.5
            }]
        }
      });
    }

    return links;
  }

  private buildRuntimeStaticLinks(
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[],
    callChains: CASCallChain[],
    externalServices: CASExternalService[]
  ): CASRuntimeStaticLink[] {
    const links: CASRuntimeStaticLink[] = [];

    for (const entryPoint of entryPoints) {
      const signal = entryPoint.trigger?.path
        ? `${entryPoint.trigger?.method || entryPoint.type} ${entryPoint.trigger.path}`
        : `${entryPoint.type} ${entryPoint.name}`;
      const instrumentationPoints = [entryPoint.source_node, entryPoint.handler?.node_id].filter((value): value is string => !!value);
      links.push({
        id: `runtime_entry_${entryPoint.id}`,
        kind: 'entry-point',
        static_id: entryPoint.id,
        runtime_signal: signal,
        telemetry_status: instrumentationPoints.length > 0 ? 'instrumentable' : 'not-instrumented',
        confidence: instrumentationPoints.length > 0 ? 0.85 : 0.4,
        instrumentation_points: instrumentationPoints,
        evidence: [{
          kind: 'route',
          source: entryPoint.id,
          file: this.nodeFile(nodes, entryPoint.source_node),
          line: this.nodeLine(nodes, entryPoint.source_node),
          confidence: instrumentationPoints.length > 0 ? 0.85 : 0.4
        }]
      });
    }

    for (const exitPoint of exitPoints) {
      const instrumentationPoints = [exitPoint.source_node, ...(exitPoint.connected_nodes || [])].filter(Boolean);
      links.push({
        id: `runtime_exit_${exitPoint.id}`,
        kind: 'exit-point',
        static_id: exitPoint.id,
        runtime_signal: exitPoint.target?.endpoint || exitPoint.target?.resource || exitPoint.name || exitPoint.type,
        telemetry_status: instrumentationPoints.length > 0 ? 'instrumentable' : 'not-instrumented',
        confidence: instrumentationPoints.length > 0 ? 0.8 : 0.4,
        instrumentation_points: instrumentationPoints,
        evidence: [{
          kind: 'graph',
          source: exitPoint.id,
          file: this.nodeFile(nodes, exitPoint.source_node),
          line: this.nodeLine(nodes, exitPoint.source_node),
          confidence: instrumentationPoints.length > 0 ? 0.8 : 0.4
        }]
      });
    }

    for (const chain of callChains) {
      const instrumentationPoints = chain.call_path.map(step => step.node_id);
      links.push({
        id: `runtime_chain_${chain.id}`,
        kind: 'call-chain',
        static_id: chain.id,
        runtime_signal: chain.business_context?.business_process || chain.business_context?.feature_area || chain.entry_point?.method_name || chain.id,
        telemetry_status: chain.runtime_stats ? 'observed' : instrumentationPoints.length > 0 ? 'instrumentable' : 'not-instrumented',
        confidence: chain.runtime_stats ? 0.95 : instrumentationPoints.length > 0 ? 0.75 : 0.35,
        instrumentation_points: instrumentationPoints,
        evidence: [{
          kind: chain.runtime_stats ? 'runtime-signal' : 'graph',
          source: chain.id,
          confidence: chain.runtime_stats ? 0.95 : 0.75
        }]
      });
    }

    for (const service of externalServices) {
      links.push({
        id: `runtime_service_${service.id}`,
        kind: 'external-service',
        static_id: service.id,
        runtime_signal: service.endpoint || service.name,
        telemetry_status: (service.connected_nodes || []).length > 0 ? 'instrumentable' : 'not-instrumented',
        confidence: (service.connected_nodes || []).length > 0 ? 0.75 : 0.45,
        instrumentation_points: service.connected_nodes || [],
        evidence: [{
          kind: 'runtime-signal',
          source: service.name,
          confidence: (service.connected_nodes || []).length > 0 ? 0.75 : 0.45
        }]
      });
    }

    return links;
  }

  private buildAnalysisFacts(
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[],
    externalServices: CASExternalService[],
    workflows: CASWorkflow[],
    capabilities: SystemCapability[],
    runtimeLinks: CASRuntimeStaticLink[],
    repositoryLinks: CASCrossRepositoryLink[],
    contributions: any[]
  ): CASAnalysisFact[] {
    const analyzerName = contributions[0]?.analyzer_name || 'AnalyzerOrchestrator';
    const facts: CASAnalysisFact[] = [];
    const exhaustiveFacts = nodes.length + edges.length <= 50_000;
    const nodesForFacts = exhaustiveFacts ? nodes : this.selectRepresentativeFactNodes(nodes, entryPoints, exitPoints, 10_000);
    const edgesForFacts = exhaustiveFacts ? edges : this.selectRepresentativeFactEdges(edges, nodesForFacts, 10_000);

    for (const node of nodesForFacts) {
      if (!node.source?.file) continue;
      facts.push({
        id: `fact_node_${node.id}`,
        subject_type: 'node',
        subject_id: node.id,
        fact_type: 'definition',
        claim: this.truncateFactText(`${node.name} is a ${node.type}`, 500),
        confidence: 0.9,
        produced_by: node.primaryAnalyzer || analyzerName,
        evidence: [{
          kind: 'source-location',
          source: node.name,
          file: node.source.file,
          line: node.source.line,
          excerpt: this.truncateFactText(node.source.raw, 500),
          confidence: 0.9
        }]
      });
    }

    for (const edge of edgesForFacts) {
      const location = edge.metadata?.locations?.[0];
      facts.push({
        id: `fact_edge_${edge.id}`,
        subject_type: 'edge',
        subject_id: edge.id,
        fact_type: 'relationship',
        claim: this.truncateFactText(`${edge.source} ${edge.type} ${edge.target}`, 500),
        confidence: edge.metadata?.confidence || 0.75,
        produced_by: analyzerName,
        evidence: [{
          kind: location ? 'source-location' : 'graph',
          source: edge.id,
          file: location?.file,
          line: location?.line,
          confidence: edge.metadata?.confidence || 0.75
        }]
      });
    }

    for (const entryPoint of entryPoints) {
      facts.push({
        id: `fact_entry_${entryPoint.id}`,
        subject_type: 'entry_point',
        subject_id: entryPoint.id,
        fact_type: 'entry',
        claim: `${entryPoint.name} exposes ${entryPoint.type}`,
        confidence: 0.85,
        produced_by: entryPoint.source_analyzer || analyzerName,
        evidence: [{
          kind: 'route',
          source: entryPoint.id,
          file: this.nodeFile(nodes, entryPoint.source_node),
          line: this.nodeLine(nodes, entryPoint.source_node),
          confidence: 0.85
        }]
      });
    }

    for (const exitPoint of exitPoints) {
      facts.push({
        id: `fact_exit_${exitPoint.id}`,
        subject_type: 'exit_point',
        subject_id: exitPoint.id,
        fact_type: 'exit',
        claim: `${exitPoint.name || exitPoint.id} leaves the system through ${exitPoint.type}`,
        confidence: 0.8,
        produced_by: analyzerName,
        evidence: [{
          kind: 'graph',
          source: exitPoint.id,
          file: this.nodeFile(nodes, exitPoint.source_node),
          line: this.nodeLine(nodes, exitPoint.source_node),
          confidence: 0.8
        }]
      });
    }

    for (const workflow of workflows) {
      const evidence = workflow.entry_points.length > 0
        ? workflow.entry_points.map(entryPointId => ({
          kind: 'graph' as const,
          source: entryPointId,
          confidence: 0.75
        }))
        : [{
          kind: 'graph' as const,
          source: workflow.id,
          confidence: 0.6
        }];

      facts.push({
        id: `fact_workflow_${workflow.id}`,
        subject_type: 'workflow',
        subject_id: workflow.id,
        fact_type: 'workflow',
        claim: `${workflow.name} is a ${workflow.classification} ${workflow.workflow_type} workflow`,
        confidence: 0.75,
        produced_by: 'WorkflowDetector',
        evidence
      });
    }

    for (const capability of capabilities) {
      const evidence = capability.operations.length > 0
        ? capability.operations.map(operation => ({
          kind: 'route' as const,
          source: operation.entry_point_id,
          confidence: 0.75
        }))
        : [{
          kind: 'graph' as const,
          source: capability.id,
          confidence: 0.6
        }];

      facts.push({
        id: `fact_capability_${capability.id}`,
        subject_type: 'capability',
        subject_id: capability.id,
        fact_type: 'capability',
        claim: `${capability.name} is a ${capability.criticality} ${capability.category} capability`,
        confidence: 0.75,
        produced_by: 'CapabilityDetector',
        evidence
      });
    }

    for (const runtimeLink of runtimeLinks) {
      facts.push({
        id: `fact_runtime_${runtimeLink.id}`,
        subject_type: 'runtime_link',
        subject_id: runtimeLink.id,
        fact_type: 'runtime-correlation',
        claim: `${runtimeLink.static_id} maps to runtime signal ${runtimeLink.runtime_signal}`,
        confidence: runtimeLink.confidence,
        produced_by: 'AnalyzerOrchestrator',
        evidence: runtimeLink.evidence
      });
    }

    for (const repositoryLink of repositoryLinks) {
      const confidence = repositoryLink.metadata?.confidence || 0.5;
      const evidence = repositoryLink.metadata?.evidence?.length
        ? repositoryLink.metadata.evidence
        : [{
          kind: 'graph' as const,
          source: repositoryLink.id,
          confidence
        }];

      facts.push({
        id: `fact_repository_${repositoryLink.id}`,
        subject_type: 'repository_link',
        subject_id: repositoryLink.id,
        fact_type: 'cross-repository',
        claim: `${repositoryLink.id} links this codebase through ${repositoryLink.type}`,
        confidence,
        produced_by: 'AnalyzerOrchestrator',
        evidence
      });
    }

    for (const service of externalServices) {
      facts.push({
        id: `fact_service_${service.id}`,
        subject_type: 'external_service',
        subject_id: service.id,
        fact_type: 'relationship',
        claim: `${service.name} is an external ${service.type} dependency`,
        confidence: 0.7,
        produced_by: analyzerName,
        evidence: [{
          kind: 'graph',
          source: service.id,
          confidence: 0.7
        }]
      });
    }

    return facts;
  }

  private selectRepresentativeFactNodes(
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[],
    limit: number
  ): CASNode[] {
    const byId = this.getNodeLookup(nodes);
    const selected = new Map<string, CASNode>();
    const add = (node?: CASNode) => {
      if (node && !selected.has(node.id) && selected.size < limit) selected.set(node.id, node);
    };

    for (const entryPoint of entryPoints) add(byId.get(entryPoint.source_node));
    for (const exitPoint of exitPoints) add(byId.get(exitPoint.source_node || ''));

    const highSignalType = /(controller|route|handler|service|provider|repository|entity|model|schema|guard|middleware|resolver|component|hook|context|module|class|interface|function|method|api|endpoint|command|job|queue|event|migration|test|spec)/i;
    for (const node of nodes) {
      if (selected.size >= limit) break;
      if (highSignalType.test(node.type) || highSignalType.test(node.name) || node.tags?.length || node.subcategories?.length) {
        add(node);
      }
    }

    for (const node of nodes) {
      if (selected.size >= limit) break;
      add(node);
    }

    return [...selected.values()];
  }

  private selectRepresentativeFactEdges(edges: CASEdge[], nodesForFacts: CASNode[], limit: number): CASEdge[] {
    const selectedNodeIds = new Set(nodesForFacts.map(node => node.id));
    const selected = new Map<string, CASEdge>();
    const add = (edge: CASEdge) => {
      if (!selected.has(edge.id) && selected.size < limit) selected.set(edge.id, edge);
    };

    for (const edge of edges) {
      if (selected.size >= limit) break;
      if (selectedNodeIds.has(edge.source) || selectedNodeIds.has(edge.target)) add(edge);
    }

    for (const edge of edges) {
      if (selected.size >= limit) break;
      add(edge);
    }

    return [...selected.values()];
  }

  private truncateFactText(value: unknown, maxLength: number): string {
    if (value === undefined || value === null) return '';
    const text = String(value);
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
  }

  private readGitRemote(projectPath: string): string | undefined {
    const gitConfigPath = path.join(projectPath, '.git', 'config');
    if (!fs.existsSync(gitConfigPath)) return undefined;

    const config = fs.readFileSync(gitConfigPath, 'utf-8');
    const match = config.match(/\[remote "origin"\][\s\S]*?url = (.+)/);
    return match?.[1]?.trim();
  }

  private slugForId(value: string): string {
    return value.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'unknown';
  }

  private nodeFile(nodes: CASNode[], nodeId?: string): string | undefined {
    if (!nodeId) return undefined;
    return this.getNodeLookup(nodes).get(nodeId)?.source?.file;
  }

  private nodeLine(nodes: CASNode[], nodeId?: string): number | undefined {
    if (!nodeId) return undefined;
    return this.getNodeLookup(nodes).get(nodeId)?.source?.line;
  }

  private getNodeLookup(nodes: CASNode[]): Map<string, CASNode> {
    if (this.nodeLookupSource !== nodes) {
      this.nodeLookupSource = nodes;
      this.nodeLookupById = new Map(nodes.map(node => [node.id, node]));
    }
    return this.nodeLookupById;
  }

  private readonly maxNodeCallGraphReferences = 50;

  private buildMethodCalls(nodes: CASNode[], edges: CASEdge[]): CASMethodCall[] {
    const methodCalls: CASMethodCall[] = [];
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const callEdgeTypes = new Set(['calls', 'invokes', 'method_call', 'delegates_to']);
    const seen = new Set<string>();

    for (const edge of edges) {
      if (!callEdgeTypes.has(edge.type)) continue;

      const sourceNode = nodeMap.get(edge.source);
      const targetNode = nodeMap.get(edge.target);

      if (!sourceNode) continue;

      const attrs: Record<string, any> = { ...(edge.metadata || {}), ...(edge.metadata?.attributes || {}) };
      const locations = edge.metadata?.locations || [];
      const firstLocation = locations[0];

      const methodName = targetNode?.name || attrs.method_name || attrs.target_method || attrs.method || 'unknown';
      const file = firstLocation?.file || sourceNode.source?.file || '';
      const line = firstLocation?.line || attrs.line || sourceNode.source?.line || 0;
      const key = `${edge.source}:${edge.target}:${methodName}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const callType = this.normalizeMethodCallType(attrs.call_type, targetNode);
      const resolutionType = this.normalizeMethodCallResolution(attrs.resolution_type, targetNode, edge.target);

      methodCalls.push({
        id: `mc_${edge.id}_${edge.target}`,
        caller_node: edge.source,
        target_node: targetNode ? edge.target : undefined,
        call_details: {
          method_name: methodName,
          signature: targetNode?.signature ? this.formatSignature(targetNode) : undefined,
          location: { file, line, column: 0 },
          call_type: callType,
          resolution_type: resolutionType
        },
        execution_context: {
          is_async: !!sourceNode.metadata?.is_async || !!edge.metadata?.async || !!attrs.is_async,
          is_conditional: !!edge.metadata?.conditional || !!attrs.is_conditional,
          is_in_loop: !!attrs.is_in_loop,
          is_recursive: edge.source === edge.target,
          call_depth: 0,
          conditional_depth: attrs.is_conditional ? 1 : 0,
          loop_depth: attrs.is_in_loop ? 1 : 0,
          enclosing_function: sourceNode.type === 'function' || sourceNode.type === 'method' ? sourceNode.name : undefined,
          enclosing_class: sourceNode.parent ? nodeMap.get(sourceNode.parent)?.name : undefined
        },
        arguments: Array.isArray(attrs.arguments) ? attrs.arguments.map((arg: any, index: number) => ({
          position: index,
          type: arg.type,
          value: arg.value === undefined ? undefined : String(arg.value),
          is_literal: !!arg.is_literal,
          is_variable: !arg.is_literal
        })) : undefined,
        external_details: this.buildMethodCallExternalDetails(attrs, resolutionType, edge.target),
        performance_hints: {
          is_hot_path: !!sourceNode.call_graph?.is_hot_path,
          is_potential_bottleneck: attrs.target_type === 'database' || attrs.target_type === 'api',
          is_critical_path: attrs.target_type === 'database' || attrs.target_type === 'api'
        }
      });
    }

    return methodCalls;
  }

  private normalizeMethodCallType(rawType: unknown, targetNode?: CASNode): CASMethodCall['call_details']['call_type'] {
    if (targetNode?.type === 'constructor') return 'constructor';
    if (typeof rawType !== 'string') return targetNode?.type === 'method' ? 'method' : 'direct';

    const lower = rawType.toLowerCase();
    if (['direct', 'method', 'constructor', 'abstract', 'interface', 'callback', 'hook', 'dynamic'].includes(lower)) {
      return lower as CASMethodCall['call_details']['call_type'];
    }
    if (lower.includes('constructor')) return 'constructor';
    if (lower.includes('abstract')) return 'abstract';
    if (lower.includes('interface')) return 'interface';
    if (lower.includes('callback')) return 'callback';
    if (lower.includes('hook') || lower.includes('event')) return 'hook';
    if (lower.includes('dynamic')) return 'dynamic';
    if (lower.includes('method') || lower.includes('injection') || lower.includes('library')) return 'method';
    return 'direct';
  }

  private normalizeMethodCallResolution(rawType: unknown, targetNode: CASNode | undefined, targetId: string): CASMethodCall['call_details']['resolution_type'] {
    if (targetNode) return 'static';
    if (typeof rawType === 'string') {
      const lower = rawType.toLowerCase();
      if (['dynamic', 'polymorphic', 'external', 'unresolved'].includes(lower)) {
        return lower as CASMethodCall['call_details']['resolution_type'];
      }
    }
    return targetId.startsWith('exit_') ? 'external' : 'unresolved';
  }

  private buildMethodCallExternalDetails(
    attrs: Record<string, any>,
    resolutionType: CASMethodCall['call_details']['resolution_type'],
    targetId: string
  ): CASMethodCall['external_details'] | undefined {
    if (resolutionType !== 'external') return undefined;

    return {
      library: attrs.library || attrs.target_object || attrs.target_type || 'external',
      module: attrs.module || attrs.endpoint,
      is_builtin: !!attrs.is_builtin,
      is_sdk: attrs.target_type === 'sdk' || attrs.call_type === 'library_call',
      exit_point_id: targetId.startsWith('exit_') ? targetId : undefined
    };
  }

  private formatSignature(node: CASNode): string {
    if (!node.signature?.parameters) return node.name;
    const params = node.signature.parameters
      .map(p => `${p.name}${p.type ? ': ' + p.type : ''}`)
      .join(', ');
    const returnType = node.signature?.return_type ? `: ${node.signature.return_type}` : '';
    return `${node.name}(${params})${returnType}`;
  }

  private buildAllDecorators(nodes: CASNode[]): CASDecorator[] {
    const decorators: CASDecorator[] = [];

    for (const node of nodes) {
      const callGraphDecs = node.call_graph?.decorators || [];
      const attrDecs = (node.metadata?.attributes as any)?.decorators || [];

      for (const dec of callGraphDecs) {
        const name = dec.name;
        const category = this.classifyDecoratorCategory(name);

        decorators.push({
          id: `dec_${node.id}_${name}`,
          target_node: node.id,
          decorator_info: {
            name,
            type: this.inferDecoratorTargetType(node),
            framework: this.inferDecoratorFramework(name),
            source_location: {
              file: node.source?.file || '',
              line: node.source?.line || 0,
              column: node.source?.column || 0
            }
          },
          semantic_meaning: {
            category,
            behavior: this.describeDecoratorBehavior(name, category),
            affects_runtime: category !== 'other'
          },
          parameters: dec.arguments ? Object.entries(dec.arguments).map(([pName, value]) => ({
            name: pName,
            value,
            type: typeof value
          })) : undefined,
          routing_info: category === 'routing' ? this.extractRoutingInfo(dec) : undefined,
          security_info: category === 'security' ? this.extractSecurityInfo(dec) : undefined
        });
      }

      for (const dec of attrDecs) {
        const name = typeof dec === 'string' ? dec : dec.name;
        if (!name) continue;

        const alreadyAdded = decorators.some(d => d.id === `dec_${node.id}_${name}`);
        if (alreadyAdded) continue;

        const category = this.classifyDecoratorCategory(name);

        decorators.push({
          id: `dec_${node.id}_${name}`,
          target_node: node.id,
          decorator_info: {
            name,
            type: this.inferDecoratorTargetType(node),
            framework: this.inferDecoratorFramework(name),
            source_location: {
              file: node.source?.file || '',
              line: node.source?.line || 0,
              column: node.source?.column || 0
            }
          },
          semantic_meaning: {
            category,
            behavior: this.describeDecoratorBehavior(name, category),
            affects_runtime: category !== 'other'
          }
        });
      }
    }

    return decorators;
  }

  private classifyDecoratorCategory(name: string): CASDecorator['semantic_meaning']['category'] {
    const lower = name.toLowerCase();
    const routingDecorators = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'controller', 'route', 'requestmapping', 'getmapping', 'postmapping', 'httpget', 'httppost', 'httpput', 'httpdelete'];
    const validationDecorators = ['validate', 'validationpipe', 'isstring', 'isnumber', 'isnotempty', 'body', 'param', 'query'];
    const securityDecorators = ['guard', 'useguards', 'authorize', 'roles', 'authenticated', 'auth', 'allowedtypes'];
    const lifecycleDecorators = ['oninit', 'ondestroy', 'onmoduleinit', 'beforeeach', 'aftereach', 'setup', 'teardown'];
    const injectionDecorators = ['inject', 'injectable', 'service', 'component', 'module', 'autowired'];
    const configDecorators = ['configurable', 'configuration', 'value', 'property'];

    if (routingDecorators.some(d => lower.includes(d))) return 'routing';
    if (validationDecorators.some(d => lower.includes(d))) return 'validation';
    if (securityDecorators.some(d => lower.includes(d))) return 'security';
    if (lifecycleDecorators.some(d => lower.includes(d))) return 'lifecycle';
    if (injectionDecorators.some(d => lower.includes(d))) return 'injection';
    if (configDecorators.some(d => lower.includes(d))) return 'configuration';
    return 'other';
  }

  private inferDecoratorTargetType(node: CASNode): CASDecorator['decorator_info']['type'] {
    if (node.type === 'class') return 'class';
    if (node.type === 'property' || node.type === 'field') return 'property';
    if (node.type === 'parameter') return 'parameter';
    return 'method';
  }

  private inferDecoratorFramework(name: string): string {
    const lower = name.toLowerCase();
    if (['controller', 'injectable', 'module', 'guard', 'pipe', 'interceptor', 'useguards'].some(d => lower.includes(d))) return 'nestjs';
    if (['component', 'directive', 'ngmodule', 'input', 'output'].some(d => lower.includes(d))) return 'angular';
    if (['requestmapping', 'getmapping', 'postmapping', 'autowired', 'service', 'repository'].some(d => lower.includes(d))) return 'spring';
    if (['httpget', 'httppost', 'httpput', 'httpdelete', 'authorize', 'apicontroller'].some(d => lower.includes(d))) return 'aspnet';
    if (['pytest', 'fixture'].some(d => lower.includes(d))) return 'pytest';
    return 'generic';
  }

  private describeDecoratorBehavior(name: string, category: CASDecorator['semantic_meaning']['category']): string {
    switch (category) {
      case 'routing': return `Defines HTTP route handler via @${name}`;
      case 'validation': return `Validates input data via @${name}`;
      case 'security': return `Enforces security policy via @${name}`;
      case 'lifecycle': return `Hooks into lifecycle event via @${name}`;
      case 'injection': return `Manages dependency injection via @${name}`;
      case 'configuration': return `Configures behavior via @${name}`;
      default: return `Applies @${name} decorator`;
    }
  }

  private extractRoutingInfo(dec: { name: string; arguments?: Record<string, any>; provides?: string[] }): CASDecorator['routing_info'] {
    return {
      method: dec.name.toUpperCase(),
      path: dec.arguments?.path || dec.arguments?.value || '/',
      parameters: dec.arguments?.params || []
    };
  }

  private extractSecurityInfo(dec: { name: string; arguments?: Record<string, any>; provides?: string[] }): CASDecorator['security_info'] {
    return {
      authentication_required: true,
      roles: dec.arguments?.roles || dec.provides || [],
      permissions: dec.arguments?.permissions || []
    };
  }

  private enrichNodeCallGraphs(
    nodes: CASNode[],
    callGraphBuilder: CallGraphBuilder,
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[]
  ): void {
    const entryNodeIds = new Set(entryPoints.map(ep => ep.source_node));
    const exitNodeIds = new Set(exitPoints.map(ep => ep.source_node));
    const nodeMap = new Map(nodes.map(n => [n.id, n]));

    for (const node of nodes) {
      if (node.type === 'file' || node.type === 'directory') continue;

      const callees = callGraphBuilder.getDirectCallees(node.id);
      const callers = callGraphBuilder.getDirectCallers(node.id);

      if (callees.length === 0 && callers.length === 0 && !node.call_graph) continue;

      const existingCallGraph = node.call_graph || {} as CASCallGraph;

      const calls: CASCallGraph['calls'] = callees.slice(0, this.maxNodeCallGraphReferences).map(targetId => {
        const target = nodeMap.get(targetId);
        const targetType: 'function' | 'method' | 'constructor' | 'api' | 'external' =
          exitNodeIds.has(targetId) ? 'external' :
          target?.type === 'constructor' ? 'constructor' :
          target?.type === 'method' ? 'method' : 'function';

        return {
          target_id: targetId,
          target_name: target?.name || targetId,
          target_type: targetType,
          call_type: 'direct' as const,
          location: {
            line: node.source?.line || 0
          }
        };
      });

      const calledBy: CASCallGraph['called_by'] = callers.slice(0, this.maxNodeCallGraphReferences).map(sourceId => {
        const source = nodeMap.get(sourceId);
        return {
          source_id: sourceId,
          source_name: source?.name || sourceId,
          source_type: source?.type || 'unknown',
          location: {
            file: source?.source?.file || '',
            line: source?.source?.line || 0
          }
        };
      });

      node.call_graph = {
        ...existingCallGraph,
        calls: calls.length > 0 ? calls : existingCallGraph.calls,
        called_by: calledBy.length > 0 ? calledBy : existingCallGraph.called_by,
        call_chain_depth: callees.length > 0 ? 1 : 0,
        is_entry_point: entryNodeIds.has(node.id),
        is_exit_point: exitNodeIds.has(node.id),
        total_calls_made: callees.length,
        total_calls_received: callers.length
      };
    }
  }

  private buildSecurityContexts(
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    edges: CASEdge[]
  ): CASSecurityContext[] {
    const contexts: CASSecurityContext[] = [];
    const securityKeywords = ['auth', 'guard', 'middleware', 'permission', 'role', 'token', 'jwt', 'session', 'encrypt', 'decrypt', 'hash', 'password', 'credential', 'security', 'validate', 'sanitize'];

    const securityNodes = nodes.filter(n => {
      const nameLower = n.name.toLowerCase();
      return securityKeywords.some(kw => nameLower.includes(kw));
    });

    const authNodes = securityNodes.filter(n => {
      const name = n.name.toLowerCase();
      return name.includes('auth') || name.includes('login') || name.includes('session') || name.includes('token');
    });

    if (authNodes.length > 0) {
      const methods = new Set<string>();
      for (const node of authNodes) {
        const name = node.name.toLowerCase();
        if (name.includes('jwt') || name.includes('token')) methods.add('jwt');
        if (name.includes('session')) methods.add('session');
        if (name.includes('oauth')) methods.add('oauth');
        if (name.includes('basic')) methods.add('basic');
        if (name.includes('api') && name.includes('key')) methods.add('api_key');
      }
      if (methods.size === 0) methods.add('custom');

      contexts.push({
        id: 'security_ctx_authentication',
        name: 'Authentication',
        type: 'authentication',
        scope: {
          node_ids: authNodes.map(n => n.id),
          entry_points: entryPoints
            .filter(ep => ep.metadata?.requires_auth || ep.metadata?.guards?.length)
            .map(ep => ep.id)
        },
        requirements: {
          authentication: {
            required: true,
            methods: Array.from(methods)
          }
        }
      });
    }

    const authzNodes = securityNodes.filter(n => {
      const name = n.name.toLowerCase();
      return name.includes('role') || name.includes('permission') || name.includes('guard') || name.includes('authorize') || name.includes('policy');
    });

    if (authzNodes.length > 0) {
      const roles = new Set<string>();
      const permissions = new Set<string>();
      for (const node of authzNodes) {
        const attrs = node.metadata?.attributes as Record<string, any> | undefined;
        if (attrs?.roles && Array.isArray(attrs.roles)) {
          (attrs.roles as string[]).forEach(r => roles.add(r));
        }
        if (attrs?.permissions && Array.isArray(attrs.permissions)) {
          (attrs.permissions as string[]).forEach(p => permissions.add(p));
        }
      }

      contexts.push({
        id: 'security_ctx_authorization',
        name: 'Authorization',
        type: 'authorization',
        scope: {
          node_ids: authzNodes.map(n => n.id)
        },
        requirements: {
          authorization: {
            roles: Array.from(roles),
            permissions: Array.from(permissions)
          }
        }
      });
    }

    const encryptionNodes = securityNodes.filter(n => {
      const name = n.name.toLowerCase();
      return name.includes('encrypt') || name.includes('decrypt') || name.includes('hash') || name.includes('cipher');
    });

    if (encryptionNodes.length > 0) {
      contexts.push({
        id: 'security_ctx_encryption',
        name: 'Encryption',
        type: 'encryption',
        scope: {
          node_ids: encryptionNodes.map(n => n.id)
        },
        requirements: {
          data_protection: {
            encryption_at_rest: encryptionNodes.some(n => n.name.toLowerCase().includes('storage') || n.name.toLowerCase().includes('persist')),
            encryption_in_transit: encryptionNodes.some(n => n.name.toLowerCase().includes('transport') || n.name.toLowerCase().includes('tls'))
          }
        }
      });
    }

    return contexts;
  }

  private buildAllConfiguration(
    nodes: CASNode[],
    exitPoints: CASExitPoint[],
    externalServices: CASExternalService[],
    projectPath?: string
  ): CASConfiguration {
    const configFilePatterns = ['.env', 'config', 'tsconfig', 'package.json', 'settings', 'appsettings', 'application.properties', 'application.yml', 'docker-compose', 'dockerfile', 'cargo.toml', 'go.mod', 'composer.json', 'pom.xml', 'build.gradle'];
    const envVars: CASConfiguration['environment_variables'] = [];
    const configFiles: CASConfiguration['config_files'] = [];
    const requiredServices: CASConfiguration['required_services'] = [];

    for (const node of nodes) {
      if (node.type !== 'file' && node.type !== 'config') continue;

      const fileName = (node.source?.file || node.name || '').toLowerCase();
      const baseName = path.basename(fileName);

      if (configFilePatterns.some(p => baseName.includes(p))) {
        const format = this.inferConfigFormat(baseName);
        configFiles.push({
          path: node.source?.file || node.name,
          format,
          environment_specific: baseName.includes('dev') || baseName.includes('prod') || baseName.includes('staging') || baseName.includes('test')
        });
      }

      if (baseName.startsWith('.env') || baseName === 'environment.ts' || baseName === 'settings.py') {
        const attrs = node.metadata?.attributes as Record<string, any> | undefined;
        const envMetadata = attrs?.environment_variables;
        if (Array.isArray(envMetadata)) {
          for (const ev of envMetadata) {
            envVars.push({
              name: ev.name || ev,
              required: ev.required,
              description: ev.description,
              sensitive: ev.sensitive || this.isSensitiveEnvVar(ev.name || ev)
            });
          }
        }
      }
    }

    for (const ep of exitPoints) {
      const serviceName = ep.target?.service_id || ep.target?.endpoint || ep.name;
      if (ep.type === 'database') {
        requiredServices.push({
          service: serviceName || 'database',
          optional: false
        });
      } else if (ep.type === 'api' || ep.type === 'sdk' || ep.type === 'webhook') {
        requiredServices.push({
          service: serviceName || ep.name,
          optional: ep.metadata?.optional === true
        });
      } else if (ep.type === 'message') {
        requiredServices.push({
          service: serviceName || 'message_queue',
          optional: false
        });
      }
    }

    for (const svc of externalServices) {
      const existing = requiredServices.find(r => r.service === svc.name);
      if (!existing) {
        requiredServices.push({
          service: svc.name,
          optional: false
        });
      }
    }

    if (projectPath && configFiles.length === 0) {
      const fsConfigPatterns = [
        'package.json', 'tsconfig.json', 'tsconfig.*.json',
        '.env', '.env.example', '.env.local',
        'docker-compose.yml', 'docker-compose.yaml', 'Dockerfile',
        'jest.config.*', 'vitest.config.*', '.eslintrc.*', '.prettierrc*',
        'webpack.config.*', 'vite.config.*', 'next.config.*',
        'settings.py', 'manage.py', 'requirements.txt', 'setup.py', 'pyproject.toml',
        'Cargo.toml', 'go.mod', 'composer.json', 'pom.xml', 'build.gradle',
        'appsettings.json', 'appsettings.*.json', 'launchSettings.json',
        '*.csproj', '*.sln'
      ];

      for (const pattern of fsConfigPatterns) {
        try {
          const matches = require('glob').globSync(pattern, {
            cwd: projectPath,
            ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**', '**/target/**', '**/vendor/**', '**/__pycache__/**']
          });
          for (const match of matches) {
            const baseName = path.basename(match).toLowerCase();
            const alreadyAdded = configFiles.some(cf => cf.path === match);
            if (!alreadyAdded) {
              configFiles.push({
                path: match,
                format: this.inferConfigFormat(baseName),
                environment_specific: baseName.includes('dev') || baseName.includes('prod') || baseName.includes('staging') || baseName.includes('test') || baseName.includes('local')
              });
            }
          }
        } catch {}
      }
    }

    return {
      environment_variables: envVars.length > 0 ? envVars : undefined,
      config_files: configFiles.length > 0 ? configFiles : undefined,
      required_services: requiredServices.length > 0 ? requiredServices : undefined
    };
  }

  private inferConfigFormat(fileName: string): string {
    if (fileName.endsWith('.json')) return 'json';
    if (fileName.endsWith('.yml') || fileName.endsWith('.yaml')) return 'yaml';
    if (fileName.endsWith('.toml')) return 'toml';
    if (fileName.endsWith('.xml')) return 'xml';
    if (fileName.endsWith('.properties')) return 'properties';
    if (fileName.endsWith('.ini')) return 'ini';
    if (fileName.startsWith('.env')) return 'dotenv';
    if (fileName.endsWith('.ts') || fileName.endsWith('.js')) return 'typescript';
    if (fileName.endsWith('.py')) return 'python';
    return 'other';
  }

  private isSensitiveEnvVar(name: string): boolean {
    const sensitive = ['secret', 'password', 'key', 'token', 'credential', 'auth', 'private'];
    const lower = (name || '').toLowerCase();
    return sensitive.some(s => lower.includes(s));
  }

  private deriveParentFromContainsEdges(nodes: CASNode[], edges: CASEdge[]): void {
    const nodeMap = new Map<string, CASNode>();
    for (const node of nodes) {
      nodeMap.set(node.id, node);
    }

    const containsEdges = edges.filter(e => e.type === 'contains');
    for (const edge of containsEdges) {
      const child = nodeMap.get(edge.target);
      if (child && !child.parent) {
        const parent = nodeMap.get(edge.source);
        if (parent) {
          child.parent = edge.source;
        }
      }
    }
  }

  private enrichNodePerspectives(nodes: CASNode[], perspectives: CASPerspective[]): void {
    const trivialTypes = new Set(['import', 'using']);

    if (perspectives.length > 0) {
      for (const perspective of perspectives) {
        const visibleTypes = perspective.connection_rules?.visible_node_types;

        let matchedCount = 0;
        if (visibleTypes && visibleTypes.length > 0) {
          matchedCount = nodes.filter(n => visibleTypes.includes(n.type)).length;
        }

        const useStrictFilter = visibleTypes && visibleTypes.length > 0 && matchedCount > 0;

        for (const node of nodes) {
          if (trivialTypes.has(node.type)) continue;

          if (useStrictFilter && !this.nodeMatchesPerspective(node, visibleTypes!)) {
            continue;
          }

          if (!node.perspectives) {
            node.perspectives = {};
          }

          const hierarchy = this.buildPerspectiveHierarchy(node, perspective);

          node.perspectives[perspective.id] = {
            hierarchy,
            level: node.level || 1,
            priority: this.calculatePerspectivePriority(node, perspective)
          };
        }
      }
    }

    const uncoveredNodes = nodes.filter(n => !trivialTypes.has(n.type) && (!n.perspectives || Object.keys(n.perspectives).length === 0));
    if (uncoveredNodes.length > 0) {
      const fallbackPerspective: CASPerspective = {
        id: 'code-structure',
        name: 'Code Structure',
        type: 'structure',
        description: 'Structural organization of the codebase',
        analyzer_id: 'orchestrator',
        connection_rules: {
          visible_node_types: []
        }
      };

      for (const node of uncoveredNodes) {
        if (!node.perspectives) {
          node.perspectives = {};
        }
        node.perspectives[fallbackPerspective.id] = {
          hierarchy: ['structure', node.category || node.type, node.name],
          level: node.level || 1,
          priority: this.calculatePerspectivePriority(node, fallbackPerspective)
        };
      }
    }
  }

  private nodeMatchesPerspective(node: CASNode, visibleTypes: string[]): boolean {
    if (visibleTypes.includes(node.type)) return true;

    for (const vt of visibleTypes) {
      const suffix = vt.replace(/^[a-z]+_/, '');
      if (suffix === node.type) return true;
      if (node.category === suffix) return true;
      if (node.subcategories?.includes(suffix)) return true;
      if (node.subcategories?.includes(vt)) return true;
    }

    return false;
  }

  private buildPerspectiveHierarchy(node: CASNode, perspective: CASPerspective): string[] {
    const hierarchy: string[] = [];

    if (perspective.type === 'flow') {
      hierarchy.push('flow');
      if (node.category) hierarchy.push(node.category);
      hierarchy.push(node.type);
    } else if (perspective.type === 'structure') {
      hierarchy.push('structure');
      if (node.category) hierarchy.push(node.category);
      if (node.subcategories?.[0]) hierarchy.push(node.subcategories[0]);
    } else if (perspective.type === 'security') {
      hierarchy.push('security');
      hierarchy.push(node.type);
    } else {
      hierarchy.push(perspective.type);
      if (node.category) hierarchy.push(node.category);
    }

    hierarchy.push(node.name);
    return hierarchy;
  }

  private calculatePerspectivePriority(node: CASNode, perspective: CASPerspective): number {
    let priority = 50;

    if (node.metadata?.is_exported) priority += 20;
    if (node.type === 'class' || node.type === 'module') priority += 10;
    if (node.type === 'function' || node.type === 'method') priority += 5;

    if (perspective.type === 'flow' && (node.type === 'controller' || node.type === 'route' || node.type === 'endpoint')) {
      priority += 30;
    }
    if (perspective.type === 'data' && (node.type === 'entity' || node.type === 'model' || node.type === 'schema')) {
      priority += 30;
    }

    return Math.min(100, priority);
  }

  private detectLibrariesFromManifests(projectPath: string): CASLibrary[] {
    const libraries: CASLibrary[] = [];
    const seen = new Set<string>();

    const packageJsonPath = path.join(projectPath, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        const addDeps = (deps: Record<string, string> | undefined, type: CASLibrary['type']) => {
          if (!deps) return;
          for (const [name, version] of Object.entries(deps)) {
            const key = `${name}@${type}`;
            if (seen.has(key)) continue;
            seen.add(key);
            libraries.push({
              id: `lib_${name.replace(/[^a-zA-Z0-9]/g, '_')}`,
              name,
              version: version.replace(/^[\^~>=<]/, ''),
              type,
              package_manager: 'npm'
            });
          }
        };
        addDeps(pkg.dependencies, 'production');
        addDeps(pkg.devDependencies, 'development');
        addDeps(pkg.peerDependencies, 'peer');
        addDeps(pkg.optionalDependencies, 'optional');
      } catch { }
    }

    const requirementsFiles = ['requirements.txt', 'requirements/base.txt', 'requirements/production.txt'];
    for (const reqFile of requirementsFiles) {
      const reqPath = path.join(projectPath, reqFile);
      if (fs.existsSync(reqPath)) {
        try {
          const rawContent = fs.readFileSync(reqPath);
          const content = rawContent.toString('utf8').replace(/\0/g, '').replace(/\uFEFF/g, '');
          for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
            const match = trimmed.match(/^([a-zA-Z0-9_.-]+)\s*(?:[><=!~]+\s*(.+))?/);
            if (match) {
              const name = match[1];
              const version = match[2]?.split(',')[0]?.trim();
              const key = `py_${name}`;
              if (seen.has(key)) continue;
              seen.add(key);
              libraries.push({
                id: `lib_${name.replace(/[^a-zA-Z0-9]/g, '_')}`,
                name,
                version,
                type: 'production',
                package_manager: 'pip'
              });
            }
          }
        } catch { }
      }
    }

    const pipfilePath = path.join(projectPath, 'Pipfile');
    if (fs.existsSync(pipfilePath) && libraries.filter(l => l.package_manager === 'pip').length === 0) {
      try {
        const content = fs.readFileSync(pipfilePath, 'utf8');
        let section = '';
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.startsWith('[')) {
            section = trimmed.replace(/[\[\]]/g, '').toLowerCase();
            continue;
          }
          if (section === 'packages' || section === 'dev-packages') {
            const match = trimmed.match(/^([a-zA-Z0-9_.-]+)\s*=/);
            if (match) {
              const name = match[1];
              const key = `py_${name}`;
              if (seen.has(key)) continue;
              seen.add(key);
              libraries.push({
                id: `lib_${name.replace(/[^a-zA-Z0-9]/g, '_')}`,
                name,
                type: section === 'dev-packages' ? 'development' : 'production',
                package_manager: 'pipenv'
              });
            }
          }
        }
      } catch { }
    }

    const cargoPath = path.join(projectPath, 'Cargo.toml');
    if (fs.existsSync(cargoPath)) {
      try {
        const content = fs.readFileSync(cargoPath, 'utf8');
        let section = '';
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.startsWith('[')) {
            section = trimmed.replace(/[\[\]]/g, '').toLowerCase();
            continue;
          }
          if (section === 'dependencies' || section === 'dev-dependencies') {
            const match = trimmed.match(/^([a-zA-Z0-9_-]+)\s*=/);
            if (match) {
              const name = match[1];
              const key = `cargo_${name}`;
              if (seen.has(key)) continue;
              seen.add(key);
              const versionMatch = trimmed.match(/"([^"]+)"/);
              libraries.push({
                id: `lib_${name.replace(/[^a-zA-Z0-9]/g, '_')}`,
                name,
                version: versionMatch?.[1],
                type: section === 'dev-dependencies' ? 'development' : 'production',
                package_manager: 'cargo'
              });
            }
          }
        }
      } catch { }
    }

    const pyprojectPath = path.join(projectPath, 'pyproject.toml');
    if (fs.existsSync(pyprojectPath) && libraries.filter(l => l.package_manager === 'pip' || l.package_manager === 'pipenv').length === 0) {
      try {
        const content = fs.readFileSync(pyprojectPath, 'utf8');
        let inDeps = false;
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.match(/^\[.*dependencies.*\]/i)) {
            inDeps = true;
            continue;
          }
          if (trimmed.startsWith('[') && inDeps) {
            inDeps = false;
            continue;
          }
          if (inDeps) {
            const match = trimmed.match(/^"?([a-zA-Z0-9_.-]+)"?\s*(?:[><=!~]+\s*"?([^",\]]+))?/);
            if (match && !match[1].startsWith('#')) {
              const name = match[1];
              const key = `py_${name}`;
              if (seen.has(key)) continue;
              seen.add(key);
              libraries.push({
                id: `lib_${name.replace(/[^a-zA-Z0-9]/g, '_')}`,
                name,
                version: match[2]?.replace(/"/g, ''),
                type: 'production',
                package_manager: 'pip'
              });
            }
          }
        }
      } catch { }
    }

    if (libraries.length === 0) {
      const manifestNames = ['package.json', 'requirements.txt', 'Cargo.toml', 'Pipfile', 'pyproject.toml', 'go.mod', 'Gemfile'];
      try {
        const entries = fs.readdirSync(projectPath, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'build' || entry.name === '__pycache__') continue;
          const subPath = path.join(projectPath, entry.name);
          for (const manifest of manifestNames) {
            const manifestPath = path.join(subPath, manifest);
            if (!fs.existsSync(manifestPath)) continue;
            if (manifest === 'package.json') {
              try {
                const pkg = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                const addDeps = (deps: Record<string, string> | undefined, type: CASLibrary['type']) => {
                  if (!deps) return;
                  for (const [name, version] of Object.entries(deps)) {
                    const key = `${name}@${type}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    libraries.push({
                      id: `lib_${name.replace(/[^a-zA-Z0-9]/g, '_')}`,
                      name,
                      version: version.replace(/^[\^~>=<]/, ''),
                      type,
                      package_manager: 'npm'
                    });
                  }
                };
                addDeps(pkg.dependencies, 'production');
                addDeps(pkg.devDependencies, 'development');
              } catch { }
            } else if (manifest === 'requirements.txt') {
              try {
                const content = fs.readFileSync(manifestPath, 'utf8');
                for (const line of content.split('\n')) {
                  const trimmed = line.trim();
                  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
                  const match = trimmed.match(/^([a-zA-Z0-9_.-]+)\s*(?:[><=!~]+\s*(.+))?/);
                  if (match) {
                    const name = match[1];
                    const key = `py_${name}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    libraries.push({
                      id: `lib_${name.replace(/[^a-zA-Z0-9]/g, '_')}`,
                      name,
                      version: match[2]?.split(',')[0]?.trim(),
                      type: 'production',
                      package_manager: 'pip'
                    });
                  }
                }
              } catch { }
            } else if (manifest === 'Cargo.toml') {
              try {
                const content = fs.readFileSync(manifestPath, 'utf8');
                let section = '';
                for (const line of content.split('\n')) {
                  const trimmed = line.trim();
                  if (trimmed.startsWith('[')) {
                    section = trimmed.replace(/[\[\]]/g, '').toLowerCase();
                    continue;
                  }
                  if (section === 'dependencies' || section === 'dev-dependencies') {
                    const match = trimmed.match(/^([a-zA-Z0-9_-]+)\s*=/);
                    if (match) {
                      const name = match[1];
                      const key = `cargo_${name}`;
                      if (seen.has(key)) continue;
                      seen.add(key);
                      const versionMatch = trimmed.match(/"([^"]+)"/);
                      libraries.push({
                        id: `lib_${name.replace(/[^a-zA-Z0-9]/g, '_')}`,
                        name,
                        version: versionMatch?.[1],
                        type: section === 'dev-dependencies' ? 'development' : 'production',
                        package_manager: 'cargo'
                      });
                    }
                  }
                }
              } catch { }
            }
            if (libraries.length > 0) break;
          }
          if (libraries.length > 0) break;
        }
      } catch { }
    }

    return libraries;
  }
}
