import { AnalyzerOrchestrator } from '../../../packages/analyzer-core/src/analyzer/core/orchestrator';
import type { CASOutput, IncrementalState, ChangeReport, ChangeHistoryEntry } from '../../../packages/analyzer-core/src/types/cas.types';
import { TypeScriptJavaScriptAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/typescript-javascript-analyzer';
import { PythonAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/python-analyzer';
import { JavaAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/java-analyzer';
import { CSharpAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/csharp-analyzer';
import { GoAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/go-analyzer';
import { RustAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/rust-analyzer';
import { PHPAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/php-analyzer';
import { RubyAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/ruby-analyzer';
import { DartAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/dart-analyzer';
import { TerraformAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/terraform-analyzer';
import {
  NestJSAnalyzer,
  SpringBootAnalyzer,
  DjangoAnalyzer,
  FlaskAnalyzer,
  FastAPIAnalyzer,
  ExpressAnalyzer,
  ReactAnalyzer,
  VueAnalyzer,
  AngularAnalyzer,
  LaravelAnalyzer,
  SymfonyAnalyzer,
  RailsAnalyzer,
  NextJSAnalyzer,
} from '../../../packages/analyzer-core/src/analyzer/frameworks/web';
import { JestAnalyzer, CypressAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/testing';
import { WPFAnalyzer, AspNetCoreAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/dotnet';
import {
  PrismaAnalyzer,
  SocketIOAnalyzer,
  ReactRouterAnalyzer,
  ReduxAnalyzer,
  ZustandAnalyzer,
  TanStackQueryAnalyzer
} from '../../../packages/analyzer-core/src/analyzer/libraries';
import type { AnalyzerRegistration } from '../../../packages/analyzer-core/src/analyzer/core/orchestrator';
import * as fs from 'fs-extra';
import {
  assertAnalysisVersionSupported,
  getAnalysisVersionInfo,
  saveAnalysis,
  loadAnalysis,
  saveIncrementalState,
  loadIncrementalState,
  saveChangeHistoryEntry,
  saveAnalysisSnapshot,
  listAnalysisSnapshots,
  saveFileCache,
  loadFileCache,
  getProjectStorageDir
} from './storage';
import { loadKlauroConfig, validateEmbeddingConfig } from './klauro-config';
import { createEmbeddingProvider } from '../../../packages/analyzer-core/src/analyzer/embedding/embedding-provider-factory';
import { createVectorStore } from '../../../packages/analyzer-core/src/analyzer/embedding/vector-store-factory';
import type { VectorStoreSetting } from '../../../packages/analyzer-core/src/analyzer/embedding/vector-store-factory';
import type { VectorStore } from '../../../packages/analyzer-core/src/analyzer/embedding/types';
import type { EmbeddingPhaseConfig } from '../../../packages/analyzer-core/src/analyzer/embedding/embedding-phase';
import { getPgPool, resolvePgConnectionString } from './pg-pool';
import { applyStoredElementDescriptions } from './description-enrichment';

let orchestrator: AnalyzerOrchestrator | null = null;

export function createOrchestrator(): AnalyzerOrchestrator {
  const created = new AnalyzerOrchestrator();

  const languageRegistrations: AnalyzerRegistration[] = [
    {
      id: 'typescript-javascript',
      name: 'TypeScript/JavaScript Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['package.json', 'tsconfig.json', 'jsconfig.json'],
        content: [/\.ts$/, /\.js$/, /\.tsx$/, /\.jsx$/],
      },
      analyzer: new TypeScriptJavaScriptAnalyzer(),
    },
    {
      id: 'python',
      name: 'Python Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['requirements.txt', 'setup.py', 'pyproject.toml', 'Pipfile'],
        content: [/\.py$/],
      },
      analyzer: new PythonAnalyzer(),
    },
    {
      id: 'java',
      name: 'Java Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
        content: [/\.java$/],
      },
      analyzer: new JavaAnalyzer(),
    },
    {
      id: 'csharp',
      name: 'C# Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['*.csproj', '*.sln'],
        content: [/\.cs$/],
      },
      analyzer: new CSharpAnalyzer(),
    },
    {
      id: 'go',
      name: 'Go Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['go.mod', 'go.sum'],
        content: [/\.go$/],
      },
      analyzer: new GoAnalyzer(),
    },
    {
      id: 'rust',
      name: 'Rust Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['Cargo.toml', 'Cargo.lock'],
        content: [/\.rs$/],
      },
      analyzer: new RustAnalyzer(),
    },
    {
      id: 'php',
      name: 'PHP Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['composer.json', 'composer.lock'],
        content: [/\.php$/],
      },
      analyzer: new PHPAnalyzer(),
    },
    {
      id: 'ruby',
      name: 'Ruby Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['Gemfile', 'Gemfile.lock', 'Rakefile'],
        content: [/\.rb$/],
      },
      analyzer: new RubyAnalyzer(),
    },
    {
      id: 'dart',
      name: 'Dart/Flutter Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['pubspec.yaml'],
        content: [/\.dart$/],
      },
      analyzer: new DartAnalyzer(),
    },
    {
      id: 'terraform',
      name: 'Terraform/HCL Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['*.tf', '*.tfvars'],
        content: [/\.tf$/, /\.tfvars$/],
      },
      analyzer: new TerraformAnalyzer(),
    },
  ];

  const frameworkRegistrations: AnalyzerRegistration[] = [
    { id: 'nestjs', name: 'NestJS Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['@nestjs/core', '@nestjs/common'] }, requires: ['typescript-javascript'], analyzer: new NestJSAnalyzer() },
    { id: 'spring-boot', name: 'Spring Boot Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['spring-boot-starter', 'org.springframework.boot'], files: ['pom.xml', 'build.gradle'] }, requires: ['java'], analyzer: new SpringBootAnalyzer() },
    { id: 'django', name: 'Django Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['Django', 'django'], files: ['manage.py', 'requirements.txt'] }, requires: ['python'], analyzer: new DjangoAnalyzer() },
    { id: 'flask', name: 'Flask Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['Flask', 'flask'], files: ['requirements.txt'] }, requires: ['python'], analyzer: new FlaskAnalyzer() },
    { id: 'fastapi', name: 'FastAPI Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['fastapi', 'FastAPI'], files: ['requirements.txt'] }, requires: ['python'], analyzer: new FastAPIAnalyzer() },
    { id: 'laravel', name: 'Laravel Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['artisan', 'composer.json'], dependencies: ['laravel/framework'] }, requires: ['php'], analyzer: new LaravelAnalyzer() },
    { id: 'symfony', name: 'Symfony Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['bin/console', 'composer.json'], dependencies: ['symfony/framework-bundle'] }, requires: ['php'], analyzer: new SymfonyAnalyzer() },
    { id: 'rails', name: 'Rails Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['Gemfile', 'config/routes.rb'], dependencies: ['rails'] }, requires: ['ruby'], analyzer: new RailsAnalyzer() },
    { id: 'express', name: 'Express.js Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['express'], files: ['package.json'] }, requires: ['typescript-javascript'], analyzer: new ExpressAnalyzer() },
    { id: 'react', name: 'React Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['react', 'react-dom'], files: ['package.json'], content: [/\.jsx$/, /\.tsx$/] }, requires: ['typescript-javascript'], analyzer: new ReactAnalyzer() },
    { id: 'angular', name: 'Angular Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['@angular/core', '@angular/common'], files: ['angular.json', 'package.json'], content: [/\.component\.ts$/] }, requires: ['typescript-javascript'], analyzer: new AngularAnalyzer() },
    { id: 'vue', name: 'Vue.js Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['vue', 'vue@'], files: ['package.json'], content: [/\.vue$/] }, requires: ['typescript-javascript'], analyzer: new VueAnalyzer() },
    { id: 'jest', name: 'Jest Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['jest', '@jest/core'], files: ['jest.config.js', 'jest.config.ts'], content: [/\.test\.(js|ts|jsx|tsx)$/, /\.spec\.(js|ts|jsx|tsx)$/] }, requires: ['typescript-javascript'], analyzer: new JestAnalyzer() },
    { id: 'cypress', name: 'Cypress Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['cypress'], files: ['cypress.json', 'cypress.config.js', 'cypress.config.ts'], content: [/\.cy\.(js|ts|jsx|tsx)$/] }, requires: ['typescript-javascript'], analyzer: new CypressAnalyzer() },
    { id: 'wpf', name: 'WPF Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['**/*.xaml', '**/*.csproj'], content: [/PresentationFramework/, /System\.Windows/, /<UseWPF>true<\/UseWPF>/] }, requires: ['csharp'], analyzer: new WPFAnalyzer() },
    { id: 'aspnet-core', name: 'ASP.NET Core Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['**/*.csproj'], content: [/Microsoft\.AspNetCore/, /Microsoft\.NET\.Sdk\.Web/] }, requires: ['csharp'], analyzer: new AspNetCoreAnalyzer() },
    { id: 'nextjs', name: 'Next.js Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['next'], files: ['next.config.js', 'next.config.mjs', 'next.config.ts'] }, requires: ['typescript-javascript'], analyzer: new NextJSAnalyzer() },
  ];

  const libraryRegistrations: AnalyzerRegistration[] = [
    { id: 'prisma', name: 'Prisma ORM Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['prisma', '@prisma/client'], files: ['prisma/schema.prisma'] }, requires: ['typescript-javascript'], analyzer: new PrismaAnalyzer() },
    { id: 'socketio', name: 'Socket.io Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['socket.io', 'socket.io-client'] }, requires: ['typescript-javascript'], analyzer: new SocketIOAnalyzer() },
    { id: 'react-router', name: 'React Router Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['react-router-dom', 'react-router'] }, requires: ['typescript-javascript'], analyzer: new ReactRouterAnalyzer() },
    { id: 'redux', name: 'Redux/RTK Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['@reduxjs/toolkit', 'redux'] }, requires: ['typescript-javascript'], analyzer: new ReduxAnalyzer() },
    { id: 'zustand', name: 'Zustand Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['zustand'] }, requires: ['typescript-javascript'], analyzer: new ZustandAnalyzer() },
    { id: 'tanstack-query', name: 'TanStack Query Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['@tanstack/react-query', 'react-query', '@tanstack/vue-query', '@tanstack/svelte-query'] }, requires: ['typescript-javascript'], analyzer: new TanStackQueryAnalyzer() },
  ];

  for (const reg of [...languageRegistrations, ...frameworkRegistrations, ...libraryRegistrations]) {
    created.registerAnalyzer(reg);
  }

  return created;
}

export function getOrchestrator(): AnalyzerOrchestrator {
  if (process.env.KLAURO_FRESH_ORCHESTRATOR_PER_ANALYSIS === '1') {
    return createOrchestrator();
  }

  if (orchestrator) return orchestrator;

  orchestrator = createOrchestrator();
  return orchestrator;
}

async function buildEmbeddingPhaseConfig(projectPath: string): Promise<EmbeddingPhaseConfig | null> {
  if (process.env.KLAURO_EMBEDDING_ENABLED === 'false' || process.env.KLAURO_EMBEDDING_ENABLED === '0') {
    return null;
  }

  const loaded = await loadKlauroConfig(projectPath);
  const embedding = loaded.config.embedding;
  if (!embedding.enabled) return null;

  const validation = validateEmbeddingConfig(loaded.config);
  for (const warning of validation.warnings) {
    console.warn(`[Klauro] embedding config: ${warning}`);
  }
  if (validation.errors.length > 0) {
    console.warn(`[Klauro] embedding disabled: ${validation.errors.join('; ')}`);
    return null;
  }

  try {
    const provider = createEmbeddingProvider(embedding.provider, {
      model: embedding.model,
      dimensions: embedding.dimensions,
      maxBatch: 64,
      maxConcurrency: embedding.maxConcurrency,
      apiKeyEnv: embedding.apiKeyEnv,
    });

    const store = buildVectorStore(
      projectPath,
      embedding.store,
      embedding.databaseUrlEnv,
      embedding.dimensions,
      loaded.config.analyzer.mode,
    );

    return {
      provider,
      store,
      maxDocumentChars: embedding.maxDocumentChars,
      phaseBudgetMs: embedding.phaseBudgetMs,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[Klauro] embedding disabled: ${reason}`);
    return null;
  }
}

function buildVectorStore(
  projectPath: string,
  setting: 'auto' | 'file' | 'pgvector',
  databaseUrlEnv: string,
  dimensions: number,
  analyzerMode: 'local' | 'remote',
): VectorStore {
  const fileBaseDir = getProjectStorageDir(projectPath);
  const fileStore = (): VectorStore =>
    createVectorStore({ store: 'file', fileBaseDir, expectedDimensions: dimensions });

  let resolved: VectorStoreSetting;
  if (setting === 'auto') {
    resolved = analyzerMode === 'remote' ? 'pgvector' : 'file';
  } else {
    resolved = setting;
  }

  if (resolved !== 'pgvector') {
    return fileStore();
  }

  const pgPool = getPgPool(resolvePgConnectionString(databaseUrlEnv));
  if (!pgPool) {
    if (setting === 'pgvector') {
      console.warn(
        '[Klauro] embedding store "pgvector" requested but no Postgres connection is available; falling back to the file store',
      );
    }
    return fileStore();
  }

  return createVectorStore({
    store: 'pgvector',
    fileBaseDir,
    pgPool,
    expectedDimensions: dimensions,
  });
}

export async function analyzeProject(projectPath: string): Promise<CASOutput> {
  if (!(await fs.pathExists(projectPath))) {
    throw new Error(`Project path does not exist: ${projectPath}`);
  }

  const orch = getOrchestrator();
  orch.configureEmbedding(await buildEmbeddingPhaseConfig(projectPath));
  const result = await orch.orchestrateAnalysis(projectPath);

  await saveAnalysis(projectPath, result);
  await saveAnalysisSnapshot(projectPath, result);

  return result;
}

export async function getAnalysis(projectPath: string): Promise<CASOutput> {
  const cached = await loadAnalysis(projectPath);
  if (cached) {
    assertAnalysisVersionSupported(cached, projectPath);
    return applyStoredElementDescriptions(projectPath, cached);
  }
  throw new Error(`No analysis found for: ${projectPath}. Run analyze_codebase first.`);
}

export interface IncrementalAnalysisResult {
  output: CASOutput;
  state: IncrementalState;
  changeReport: ChangeReport;
  wasFullRebuild: boolean;
  fullRebuildReason?: string;
  previousCasVersion?: string;
}

const DEFAULT_INCREMENTAL_SNAPSHOT_INTERVAL_MS = 60_000;

function getIncrementalSnapshotIntervalMs(): number {
  const raw = process.env.KLAURO_INCREMENTAL_SNAPSHOT_INTERVAL_MS;
  if (raw === undefined || raw === '') return DEFAULT_INCREMENTAL_SNAPSHOT_INTERVAL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_INCREMENTAL_SNAPSHOT_INTERVAL_MS;
}

async function shouldSaveIncrementalSnapshot(projectPath: string, result: IncrementalAnalysisResult): Promise<boolean> {
  if (result.wasFullRebuild) return true;
  const intervalMs = getIncrementalSnapshotIntervalMs();
  if (intervalMs === 0) return true;

  try {
    const snapshots = await listAnalysisSnapshots(projectPath);
    const latest = snapshots[0]?.timestamp ? new Date(snapshots[0].timestamp).getTime() : 0;
    if (!latest || Number.isNaN(latest)) return true;
    return Date.now() - latest >= intervalMs;
  } catch {
    return true;
  }
}

function makeEdgeId(edge: { id?: string; source: string; target: string; type: string }): string {
  return edge.id || `edge_${edge.source}_${edge.target}_${edge.type}`;
}

function hasReportChanges(report: ChangeReport): boolean {
  const summary = report.summary;
  return summary.filesAdded > 0 ||
    summary.filesModified > 0 ||
    summary.filesDeleted > 0 ||
    summary.nodesAdded > 0 ||
    summary.nodesModified > 0 ||
    summary.nodesDeleted > 0 ||
    summary.edgesAdded > 0 ||
    summary.edgesModified > 0 ||
    summary.edgesDeleted > 0 ||
    (report.details.addedEntryPoints?.length || 0) > 0 ||
    (report.details.modifiedEntryPoints?.length || 0) > 0 ||
    (report.details.deletedEntryPoints?.length || 0) > 0 ||
    (report.details.addedExitPoints?.length || 0) > 0 ||
    (report.details.deletedExitPoints?.length || 0) > 0;
}

function hasCasReportChanges(report: ChangeReport): boolean {
  const summary = report.summary;
  return summary.nodesAdded > 0 ||
    summary.nodesModified > 0 ||
    summary.nodesDeleted > 0 ||
    summary.edgesAdded > 0 ||
    summary.edgesModified > 0 ||
    summary.edgesDeleted > 0 ||
    (report.details.addedEntryPoints?.length || 0) > 0 ||
    (report.details.modifiedEntryPoints?.length || 0) > 0 ||
    (report.details.deletedEntryPoints?.length || 0) > 0 ||
    (report.details.addedExitPoints?.length || 0) > 0 ||
    (report.details.deletedExitPoints?.length || 0) > 0;
}

function buildChangeHistoryEntry(result: IncrementalAnalysisResult): ChangeHistoryEntry {
  const report = result.changeReport;
  const details = report.details;

  return {
    id: `change_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    timestamp: report.timestamp,
    gitCommitHash: result.state.gitCommitHash,
    source: 'unknown',
    changes: {
      files: details.files || [],
      nodes: [
        ...details.addedNodes.map(node => ({
          nodeId: node.id,
          nodeName: node.name,
          nodeType: node.type,
          file: node.file,
          changeType: 'added' as const,
        })),
        ...details.modifiedNodes.map(node => ({
          nodeId: node.id,
          nodeName: node.name,
          nodeType: node.type || 'unknown',
          file: node.file || 'unknown',
          changeType: 'modified' as const,
          semanticChange: node.changes.join(', '),
        })),
        ...details.deletedNodes.map(node => ({
          nodeId: node.id,
          nodeName: node.name,
          nodeType: node.type,
          file: node.file || 'unknown',
          changeType: 'deleted' as const,
        })),
      ],
      edges: [
        ...details.addedEdges.map(edge => ({
          edgeId: makeEdgeId(edge),
          source: edge.source,
          target: edge.target,
          edgeType: edge.type,
          changeType: 'added' as const,
        })),
        ...details.deletedEdges.map(edge => ({
          edgeId: makeEdgeId(edge),
          source: edge.source,
          target: edge.target,
          edgeType: edge.type,
          changeType: 'deleted' as const,
        })),
      ],
      entryPoints: [
        ...(details.addedEntryPoints || []).map(entryPoint => ({
          entryPointId: entryPoint.id,
          name: entryPoint.name,
          changeType: 'added' as const,
        })),
        ...(details.modifiedEntryPoints || []).map(entryPoint => ({
          entryPointId: entryPoint.id,
          name: entryPoint.name,
          changeType: 'modified' as const,
          details: entryPoint.details,
        })),
        ...(details.deletedEntryPoints || []).map(entryPoint => ({
          entryPointId: entryPoint.id,
          name: entryPoint.name,
          changeType: 'deleted' as const,
        })),
      ],
      exitPoints: [
        ...(details.addedExitPoints || []).map(exitPoint => ({
          exitPointId: exitPoint.id,
          name: exitPoint.name,
          changeType: 'added' as const,
        })),
        ...(details.deletedExitPoints || []).map(exitPoint => ({
          exitPointId: exitPoint.id,
          name: exitPoint.name,
          changeType: 'deleted' as const,
        })),
      ],
    },
    semanticSummary: result.wasFullRebuild
      ? 'Full rebuild triggered'
      : `${report.summary.filesAdded + report.summary.filesModified + report.summary.filesDeleted} files changed; ${report.summary.nodesAdded} nodes added, ${report.summary.nodesModified} modified, ${report.summary.nodesDeleted} deleted`,
    intent: {
      type: 'unknown' as const,
      confidence: 0,
      evidence: [],
    },
    impact: report.impact,
    suggestedActions: [],
    breakingChanges: [],
    minimumTestSet: [],
  };
}

export async function analyzeProjectIncremental(projectPath: string): Promise<IncrementalAnalysisResult> {
  const debugTimings = process.env.KLAURO_DEBUG_INCREMENTAL_TIMINGS === '1';
  const debug = (label: string, startedAt: number) => {
    if (debugTimings) {
      console.error(`[Klauro] incremental timing ${label}: ${Date.now() - startedAt}ms`);
    }
  };
  if (!(await fs.pathExists(projectPath))) {
    throw new Error(`Project path does not exist: ${projectPath}`);
  }

  const orch = getOrchestrator();
  orch.configureEmbedding(await buildEmbeddingPhaseConfig(projectPath));

  const previousOutput = await loadAnalysis(projectPath, { preferCache: true });
  const previousState = await loadIncrementalState(projectPath);
  const previousCasVersion = previousOutput
    ? getAnalysisVersionInfo(previousOutput).stored_version
    : undefined;

  if (!previousOutput) {
    let phaseStartedAt = Date.now();
    const result = await orch.orchestrateAnalysis(projectPath);
    debug('initial-orchestrate-full', phaseStartedAt);
    phaseStartedAt = Date.now();
    await saveAnalysis(projectPath, result);
    debug('initial-save-analysis', phaseStartedAt);

    phaseStartedAt = Date.now();
    const freshResult = await orch.orchestrateIncrementalAnalysis(
      projectPath,
      result,
      null,
      {
        loadCache: (hash) => loadFileCache(projectPath, hash),
        saveCache: (hash, fileResult) => saveFileCache(projectPath, hash, fileResult)
      }
    );
    debug('initial-build-state', phaseStartedAt);

    phaseStartedAt = Date.now();
    await saveIncrementalState(projectPath, freshResult.state);
    debug('initial-save-state', phaseStartedAt);
    phaseStartedAt = Date.now();
    await saveAnalysisSnapshot(projectPath, freshResult.output);
    debug('initial-save-snapshot', phaseStartedAt);

    return freshResult;
  }

  let phaseStartedAt = Date.now();
  const result = await orch.orchestrateIncrementalAnalysis(
    projectPath,
    previousOutput,
    previousState,
    {
      loadCache: (hash) => loadFileCache(projectPath, hash),
      saveCache: (hash, fileResult) => saveFileCache(projectPath, hash, fileResult)
    }
  );
  debug('orchestrate-incremental', phaseStartedAt);

  const casChanged = hasCasReportChanges(result.changeReport);
  const outputChanged = result.output !== previousOutput || casChanged;
  if (outputChanged) {
    phaseStartedAt = Date.now();
    await saveAnalysis(projectPath, result.output);
    debug('save-analysis', phaseStartedAt);
  }
  phaseStartedAt = Date.now();
  await saveIncrementalState(projectPath, result.state);
  debug('save-state', phaseStartedAt);

  if (hasReportChanges(result.changeReport)) {
    phaseStartedAt = Date.now();
    await saveChangeHistoryEntry(projectPath, buildChangeHistoryEntry(result));
    debug('save-change-history', phaseStartedAt);
    if (outputChanged && await shouldSaveIncrementalSnapshot(projectPath, result)) {
      phaseStartedAt = Date.now();
      await saveAnalysisSnapshot(projectPath, result.output);
      debug('save-snapshot', phaseStartedAt);
    } else if (outputChanged) {
      debug('skip-snapshot-throttled', Date.now());
    }
  }

  return { ...result, previousCasVersion };
}

export async function getIncrementalState(projectPath: string): Promise<IncrementalState | null> {
  return loadIncrementalState(projectPath);
}
