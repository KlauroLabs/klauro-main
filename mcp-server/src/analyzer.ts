import { AnalyzerOrchestrator } from '../../backend/src/analyzer/core/orchestrator';
import type { CASOutput, IncrementalState, ChangeReport } from '../../backend/src/types/cas.types';
import { TypeScriptJavaScriptAnalyzer } from '../../backend/src/analyzer/languages/typescript-javascript-analyzer';
import { PythonAnalyzer } from '../../backend/src/analyzer/languages/python-analyzer';
import { JavaAnalyzer } from '../../backend/src/analyzer/languages/java-analyzer';
import { CSharpAnalyzer } from '../../backend/src/analyzer/languages/csharp-analyzer';
import { GoAnalyzer } from '../../backend/src/analyzer/languages/go-analyzer';
import { RustAnalyzer } from '../../backend/src/analyzer/languages/rust-analyzer';
import { PHPAnalyzer } from '../../backend/src/analyzer/languages/php-analyzer';
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
  NextJSAnalyzer,
} from '../../backend/src/analyzer/frameworks/web';
import { JestAnalyzer, CypressAnalyzer } from '../../backend/src/analyzer/frameworks/testing';
import { WPFAnalyzer, AspNetCoreAnalyzer } from '../../backend/src/analyzer/frameworks/dotnet';
import { PrismaAnalyzer, SocketIOAnalyzer } from '../../backend/src/analyzer/libraries';
import type { AnalyzerRegistration } from '../../backend/src/analyzer/core/orchestrator';
import * as fs from 'fs-extra';
import {
  saveAnalysis,
  loadAnalysis,
  saveIncrementalState,
  loadIncrementalState,
  saveChangeHistoryEntry,
  saveAnalysisSnapshot,
  saveFileCache,
  loadFileCache
} from './storage';

let orchestrator: AnalyzerOrchestrator | null = null;

function getOrchestrator(): AnalyzerOrchestrator {
  if (orchestrator) return orchestrator;

  orchestrator = new AnalyzerOrchestrator();

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
  ];

  const frameworkRegistrations: AnalyzerRegistration[] = [
    { id: 'nestjs', name: 'NestJS Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['@nestjs/core', '@nestjs/common'] }, requires: ['typescript-javascript'], analyzer: new NestJSAnalyzer() },
    { id: 'spring-boot', name: 'Spring Boot Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['spring-boot-starter', 'org.springframework.boot'], files: ['pom.xml', 'build.gradle'] }, requires: ['java'], analyzer: new SpringBootAnalyzer() },
    { id: 'django', name: 'Django Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['Django', 'django'], files: ['manage.py', 'requirements.txt'] }, requires: ['python'], analyzer: new DjangoAnalyzer() },
    { id: 'flask', name: 'Flask Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['Flask', 'flask'], files: ['requirements.txt'] }, requires: ['python'], analyzer: new FlaskAnalyzer() },
    { id: 'fastapi', name: 'FastAPI Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['fastapi', 'FastAPI'], files: ['requirements.txt'] }, requires: ['python'], analyzer: new FastAPIAnalyzer() },
    { id: 'laravel', name: 'Laravel Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['artisan', 'composer.json'], dependencies: ['laravel/framework'] }, requires: ['php'], analyzer: new LaravelAnalyzer() },
    { id: 'symfony', name: 'Symfony Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['bin/console', 'composer.json'], dependencies: ['symfony/framework-bundle'] }, requires: ['php'], analyzer: new SymfonyAnalyzer() },
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
  ];

  for (const reg of [...languageRegistrations, ...frameworkRegistrations, ...libraryRegistrations]) {
    orchestrator.registerAnalyzer(reg);
  }

  return orchestrator;
}

export async function analyzeProject(projectPath: string): Promise<CASOutput> {
  if (!(await fs.pathExists(projectPath))) {
    throw new Error(`Project path does not exist: ${projectPath}`);
  }

  const orch = getOrchestrator();
  const result = await orch.orchestrateAnalysis(projectPath);

  await saveAnalysis(projectPath, result);

  return result;
}

export async function getAnalysis(projectPath: string): Promise<CASOutput> {
  const cached = await loadAnalysis(projectPath);
  if (cached) return cached;
  throw new Error(`No analysis found for: ${projectPath}. Run analyze_codebase first.`);
}

export interface IncrementalAnalysisResult {
  output: CASOutput;
  state: IncrementalState;
  changeReport: ChangeReport;
  wasFullRebuild: boolean;
}

export async function analyzeProjectIncremental(projectPath: string): Promise<IncrementalAnalysisResult> {
  if (!(await fs.pathExists(projectPath))) {
    throw new Error(`Project path does not exist: ${projectPath}`);
  }

  const orch = getOrchestrator();

  const previousOutput = await loadAnalysis(projectPath);
  const previousState = await loadIncrementalState(projectPath);

  if (!previousOutput) {
    const result = await orch.orchestrateAnalysis(projectPath);
    await saveAnalysis(projectPath, result);

    const freshResult = await orch.orchestrateIncrementalAnalysis(
      projectPath,
      result,
      null,
      {
        loadCache: (hash) => loadFileCache(projectPath, hash),
        saveCache: (hash, fileResult) => saveFileCache(projectPath, hash, fileResult)
      }
    );

    await saveIncrementalState(projectPath, freshResult.state);
    await saveAnalysisSnapshot(projectPath, freshResult.output);

    return freshResult;
  }

  const result = await orch.orchestrateIncrementalAnalysis(
    projectPath,
    previousOutput,
    previousState,
    {
      loadCache: (hash) => loadFileCache(projectPath, hash),
      saveCache: (hash, fileResult) => saveFileCache(projectPath, hash, fileResult)
    }
  );

  await saveAnalysis(projectPath, result.output);
  await saveIncrementalState(projectPath, result.state);

  if (result.changeReport.summary.nodesAdded > 0 ||
      result.changeReport.summary.nodesModified > 0 ||
      result.changeReport.summary.nodesDeleted > 0) {
    await saveChangeHistoryEntry(projectPath, {
      id: `change_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: result.changeReport.timestamp,
      gitCommitHash: result.state.gitCommitHash,
      source: 'unknown',
      changes: {
        files: result.changeReport.summary.filesAdded +
               result.changeReport.summary.filesModified +
               result.changeReport.summary.filesDeleted > 0
          ? [{
              path: 'multiple',
              type: 'modified' as const,
              linesAdded: 0,
              linesRemoved: 0
            }]
          : [],
        nodes: [],
        edges: [],
        entryPoints: [],
        exitPoints: []
      },
      semanticSummary: result.wasFullRebuild
        ? 'Full rebuild triggered'
        : `${result.changeReport.summary.nodesAdded} nodes added, ${result.changeReport.summary.nodesModified} modified, ${result.changeReport.summary.nodesDeleted} deleted`,
      intent: {
        type: 'unknown' as const,
        confidence: 0,
        evidence: []
      },
      impact: result.changeReport.impact,
      suggestedActions: [],
      breakingChanges: [],
      minimumTestSet: []
    });

    await saveAnalysisSnapshot(projectPath, result.output);
  }

  return result;
}

export async function getIncrementalState(projectPath: string): Promise<IncrementalState | null> {
  return loadIncrementalState(projectPath);
}
