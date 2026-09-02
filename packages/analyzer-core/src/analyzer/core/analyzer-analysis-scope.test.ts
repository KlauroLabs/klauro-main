import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { BaseAnalyzer, type AnalysisContext } from './base-analyzer';
import { analyzeWithCompleteScope } from './analyzer-analysis-scope';
import { withAnalyzerFileReadCache } from './analyzer-file-read-cache';
import { ShellAnalyzer } from '../languages/shell-analyzer';
import { TestFrameworkAnalyzer } from '../frameworks/testing/test-framework-analyzer';

async function scoped(analyzer: BaseAnalyzer, context: AnalysisContext) {
  return analyzeWithCompleteScope(
    { id: analyzer.id, analyzer },
    context,
    () => analyzer.analyze(context)
  );
}

test('real language and framework analyzers report complete exact source scopes', async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-analysis-scope-'));
  try {
    await fs.outputFile(path.join(projectPath, 'bin/run.sh'), '#!/bin/sh\necho ready\n');
    await fs.outputFile(path.join(projectPath, 'src/service.test.ts'), [
      "import test from 'node:test';",
      "test('works', () => {});",
    ].join('\n'));
    const context: AnalysisContext = { projectPath, analysisRootPath: projectPath, existingAnalysis: [] };

    const [language, framework] = await withAnalyzerFileReadCache(async () => [
      await scoped(new ShellAnalyzer(), context),
      await scoped(new TestFrameworkAnalyzer(), context),
    ]);

    for (const contribution of [language, framework]) {
      const scope = contribution.analyzer_metadata.analysis_scope;
      assert.equal(scope?.applicability, 'file-coverage');
      assert.equal(scope?.complete, true);
      assert.ok((scope?.files_eligible || 0) > 0);
      assert.equal(scope?.files_analyzed, scope?.files_eligible);
      assert.equal(scope?.files_skipped, 0);
    }
  } finally {
    await fs.remove(projectPath);
  }
});

test('fact-only analyzers report source scope as explicitly not applicable', async () => {
  class FactOnlyAnalyzer extends BaseAnalyzer {
    constructor() {
      super('fact-only', 'Fact Only', '1.0.0', 'pattern');
    }

    async canAnalyze(): Promise<boolean> {
      return true;
    }

    getCapabilities(): string[] {
      return [];
    }

    async analyze(): Promise<any> {
      return this.createContribution([], [], [], []);
    }
  }

  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-analysis-scope-facts-'));
  try {
    const context: AnalysisContext = { projectPath, analysisRootPath: projectPath, existingAnalysis: [] };
    const contribution = await withAnalyzerFileReadCache(() => scoped(new FactOnlyAnalyzer(), context));
    assert.deepEqual(contribution.analyzer_metadata.analysis_scope, {
      applicability: 'not-applicable',
      files_eligible: 0,
      files_analyzed: 0,
      files_skipped: 0,
      complete: true,
    });
  } finally {
    await fs.remove(projectPath);
  }
});

test('eligible files omitted by an analyzer remain exact and make its scope incomplete', async () => {
  class PartialAnalyzer extends BaseAnalyzer {
    constructor() {
      super('partial', 'Partial', '1.0.0', 'language');
    }

    async canAnalyze(): Promise<boolean> {
      return true;
    }

    getCapabilities(): string[] {
      return [];
    }

    async getRelevantFiles(): Promise<string[]> {
      return ['src/analyzed.lang', 'src/omitted.lang'];
    }

    async analyze(context: AnalysisContext): Promise<any> {
      await fs.readFile(path.join(context.projectPath, 'src/analyzed.lang'), 'utf8');
      return this.createContribution([{
        id: 'analyzed-node',
        name: 'analyzed',
        type: 'function',
        category: 'code',
        source: { file: 'src/analyzed.lang', line: 1 },
      } as any], [], [], []);
    }
  }

  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-analysis-scope-partial-'));
  try {
    await fs.outputFile(path.join(projectPath, 'src/analyzed.lang'), 'analyzed');
    await fs.outputFile(path.join(projectPath, 'src/omitted.lang'), 'omitted');
    const context: AnalysisContext = { projectPath, analysisRootPath: projectPath, existingAnalysis: [] };
    const contribution = await withAnalyzerFileReadCache(() => scoped(new PartialAnalyzer(), context));
    assert.deepEqual(contribution.analyzer_metadata.analysis_scope, {
      applicability: 'file-coverage',
      files_eligible: 2,
      files_analyzed: 1,
      files_skipped: 1,
      complete: false,
      omitted_paths: ['src/omitted.lang'],
      incomplete_reason: '1 eligible source file(s) were not read or represented in analyzer output',
    });
  } finally {
    await fs.remove(projectPath);
  }
});

test('scope discovery receives the same analysis context as execution', async () => {
  let receivedContext: AnalysisContext | undefined;
  class ContextualAnalyzer extends BaseAnalyzer {
    constructor() {
      super('contextual', 'Contextual', '1.0.0', 'library');
    }

    async canAnalyze(): Promise<boolean> {
      return true;
    }

    getCapabilities(): string[] {
      return [];
    }

    async getRelevantFiles(_projectPath: string, context?: AnalysisContext): Promise<string[]> {
      receivedContext = context;
      return [];
    }

    async analyze(): Promise<any> {
      return this.createContribution([], [], [], []);
    }
  }

  const context: AnalysisContext = { projectPath: '/tmp/contextual', existingAnalysis: [] };
  await withAnalyzerFileReadCache(() => scoped(new ContextualAnalyzer(), context));
  assert.equal(receivedContext, context);
});
