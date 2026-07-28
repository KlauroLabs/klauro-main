import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { AnalyzerOrchestrator } from '../../../packages/analyzer-core/src/analyzer/core/orchestrator';
import { ChangeDetector } from '../../../packages/analyzer-core/src/analyzer/core/change-detector';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';

test('incremental state tracks node-less env.py source files without including env directories', () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-incremental-state-'));
  try {
    fs.mkdirSync(path.join(projectPath, 'app', 'settings'), { recursive: true });
    fs.mkdirSync(path.join(projectPath, 'app', 'android'), { recursive: true });
    fs.mkdirSync(path.join(projectPath, 'env', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, 'app', 'settings', 'env.py'), 'DEBUG = False\n');
    fs.writeFileSync(path.join(projectPath, 'app', 'android', 'MainActivity.kt'), 'class MainActivity\n');
    fs.writeFileSync(path.join(projectPath, 'env', 'lib', 'ignored.py'), 'SHOULD_NOT_TRACK = True\n');

    const orchestrator = new AnalyzerOrchestrator() as any;
    const sourceFiles = orchestrator.getIncrementalSourceFiles(projectPath) as string[];
    assert.ok(sourceFiles.includes('app/settings/env.py'));
    assert.ok(sourceFiles.includes('app/android/MainActivity.kt'));
    assert.ok(!sourceFiles.includes('env/lib/ignored.py'));

    const output: CASOutput = {
      cas_version: '1.9.0',
      analysis_timestamp: new Date('2026-01-01T00:00:00.000Z').toISOString(),
      analysis_id: 'incremental-state-test',
      system: {
        id: 'incremental-state-test',
        name: 'incremental-state-test',
        type: 'application',
        root_path: projectPath,
      },
      nodes: [],
      edges: [],
      analyzer_contributions: [],
      progressive_levels: { total_levels: 1 },
    };

    const state = orchestrator.buildIncrementalState(projectPath, output, new ChangeDetector(projectPath));
    assert.ok(state.files['app/settings/env.py']);
    assert.equal(state.files['app/settings/env.py'].nodeIds.length, 0);
    assert.equal(state.files['app/settings/env.py'].analyzerId, 'python');
    assert.ok(state.files['app/android/MainActivity.kt']);
    assert.equal(state.files['app/android/MainActivity.kt'].nodeIds.length, 0);
    assert.equal(state.files['app/android/MainActivity.kt'].analyzerId, 'kotlin');
    assert.equal(state.files['env/lib/ignored.py'], undefined);
  } finally {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});

test('change detector does not repeatedly full rebuild for already-analyzed dirty package config', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-incremental-dirty-config-'));
  try {
    execFileSync('git', ['init'], { cwd: projectPath, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectPath });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'package.json'), '{"name":"dirty-config","scripts":{"test":"node test.js"}}\n');
    fs.writeFileSync(path.join(projectPath, 'index.ts'), 'export const value = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: projectPath });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: projectPath, stdio: 'ignore' });

    fs.writeFileSync(path.join(projectPath, 'package.json'), '{"name":"dirty-config","scripts":{"test":"node test.js","lint":"eslint ."}}\n');

    const orchestrator = new AnalyzerOrchestrator() as any;
    const output: CASOutput = {
      cas_version: '1.10.0',
      analysis_timestamp: new Date().toISOString(),
      analysis_id: 'dirty-config-test',
      system: {
        id: 'dirty-config-test',
        name: 'dirty-config-test',
        type: 'application',
        root_path: projectPath,
      },
      nodes: [],
      edges: [],
      analyzer_contributions: [],
      progressive_levels: { total_levels: 1 },
    };
    const detector = new ChangeDetector(projectPath);
    const state = orchestrator.buildIncrementalState(projectPath, output, detector);

    const changes = await detector.detectChanges(state);
    assert.equal(changes.requiresFullRebuild, false);
    assert.deepEqual(changes.modified, []);
    assert.deepEqual(changes.added, []);
    assert.deepEqual(changes.deleted, []);
  } finally {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});

test('agent-fast rebuilds complete project semantics when a package manifest changes', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-incremental-agent-fast-config-'));
  const previousFocus = process.env.KLAURO_ANALYSIS_FOCUS;
  const previousFullRebuild = process.env.KLAURO_FULL_REBUILD_ON_CONFIG_CHANGE;
  try {
    process.env.KLAURO_ANALYSIS_FOCUS = 'agent-fast';
    delete process.env.KLAURO_FULL_REBUILD_ON_CONFIG_CHANGE;

    execFileSync('git', ['init'], { cwd: projectPath, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectPath });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'package.json'), '{"name":"agent-fast-config","scripts":{"test":"node test.js"}}\n');
    fs.writeFileSync(path.join(projectPath, 'index.ts'), 'export const value = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: projectPath });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: projectPath, stdio: 'ignore' });

    const orchestrator = new AnalyzerOrchestrator() as any;
    const output: CASOutput = {
      cas_version: '1.10.0',
      analysis_timestamp: new Date().toISOString(),
      analysis_id: 'agent-fast-config-test',
      system: {
        id: 'agent-fast-config-test',
        name: 'agent-fast-config-test',
        type: 'application',
        root_path: projectPath,
      },
      nodes: [],
      edges: [],
      analyzer_contributions: [],
      progressive_levels: { total_levels: 1 },
    };
    const detector = new ChangeDetector(projectPath);
    const state = orchestrator.buildIncrementalState(projectPath, output, detector);

    fs.writeFileSync(path.join(projectPath, 'package.json'), '{"name":"agent-fast-config","scripts":{"test":"node test.js","lint":"eslint ."}}\n');

    const changes = await detector.detectChanges(state);
    assert.equal(changes.requiresFullRebuild, true);
    assert.match(changes.reason || '', /project-scope trigger changed: package\.json/);
  } finally {
    if (previousFocus === undefined) delete process.env.KLAURO_ANALYSIS_FOCUS;
    else process.env.KLAURO_ANALYSIS_FOCUS = previousFocus;
    if (previousFullRebuild === undefined) delete process.env.KLAURO_FULL_REBUILD_ON_CONFIG_CHANGE;
    else process.env.KLAURO_FULL_REBUILD_ON_CONFIG_CHANGE = previousFullRebuild;
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});

test('full analysis still full rebuilds when core package config changes', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-incremental-full-config-'));
  const previousFocus = process.env.KLAURO_ANALYSIS_FOCUS;
  const previousFullRebuild = process.env.KLAURO_FULL_REBUILD_ON_CONFIG_CHANGE;
  try {
    process.env.KLAURO_ANALYSIS_FOCUS = 'full';
    delete process.env.KLAURO_FULL_REBUILD_ON_CONFIG_CHANGE;

    execFileSync('git', ['init'], { cwd: projectPath, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectPath });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'package.json'), '{"name":"full-config","scripts":{"test":"node test.js"}}\n');
    fs.writeFileSync(path.join(projectPath, 'index.ts'), 'export const value = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: projectPath });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: projectPath, stdio: 'ignore' });

    const orchestrator = new AnalyzerOrchestrator() as any;
    const output: CASOutput = {
      cas_version: '1.10.0',
      analysis_timestamp: new Date().toISOString(),
      analysis_id: 'full-config-test',
      system: {
        id: 'full-config-test',
        name: 'full-config-test',
        type: 'application',
        root_path: projectPath,
      },
      nodes: [],
      edges: [],
      analyzer_contributions: [],
      progressive_levels: { total_levels: 1 },
    };
    const detector = new ChangeDetector(projectPath);
    const state = orchestrator.buildIncrementalState(projectPath, output, detector);

    fs.writeFileSync(path.join(projectPath, 'package.json'), '{"name":"full-config","scripts":{"test":"node test.js","lint":"eslint ."}}\n');

    const changes = await detector.detectChanges(state);
    assert.equal(changes.requiresFullRebuild, true);
    assert.match(changes.reason || '', /Core configuration changed: package\.json/);
  } finally {
    if (previousFocus === undefined) delete process.env.KLAURO_ANALYSIS_FOCUS;
    else process.env.KLAURO_ANALYSIS_FOCUS = previousFocus;
    if (previousFullRebuild === undefined) delete process.env.KLAURO_FULL_REBUILD_ON_CONFIG_CHANGE;
    else process.env.KLAURO_FULL_REBUILD_ON_CONFIG_CHANGE = previousFullRebuild;
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});

test('incremental source tracking excludes Klauro scratch and generated proof folders', () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-incremental-ignore-scratch-'));
  try {
    fs.mkdirSync(path.join(projectPath, 'src'), { recursive: true });
    fs.mkdirSync(path.join(projectPath, '.klauro-scratch-live', 'src'), { recursive: true });
    fs.mkdirSync(path.join(projectPath, 'apps', 'mcp-server', 'fixtures', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, 'src', 'real.ts'), 'export const real = true;\n');
    fs.writeFileSync(path.join(projectPath, '.klauro-scratch-live', 'src', 'copy.ts'), 'export const generated = true;\n');
    fs.writeFileSync(path.join(projectPath, 'apps', 'mcp-server', 'fixtures', 'demo', 'fixture.ts'), 'export const fixture = true;\n');

    const orchestrator = new AnalyzerOrchestrator() as any;
    const sourceFiles = orchestrator.getIncrementalSourceFiles(projectPath) as string[];

    assert.ok(sourceFiles.includes('src/real.ts'));
    assert.ok(!sourceFiles.includes('.klauro-scratch-live/src/copy.ts'));
    assert.ok(!sourceFiles.includes('apps/mcp-server/fixtures/demo/fixture.ts'));
  } finally {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});

test('change detector normalizes parent-repo git paths for subproject incremental state', async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-incremental-monorepo-'));
  const projectPath = path.join(repoRoot, 'apps', 'mcp-server');
  try {
    fs.mkdirSync(projectPath, { recursive: true });
    execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoRoot });
    fs.writeFileSync(path.join(projectPath, 'package.json'), '{"name":"subproject","scripts":{"test":"node test.js"}}\n');
    fs.writeFileSync(path.join(projectPath, 'index.ts'), 'export const value = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoRoot, stdio: 'ignore' });

    fs.writeFileSync(path.join(projectPath, 'package.json'), '{"name":"subproject","scripts":{"test":"node test.js","lint":"eslint ."}}\n');

    const orchestrator = new AnalyzerOrchestrator() as any;
    const output: CASOutput = {
      cas_version: '1.10.0',
      analysis_timestamp: new Date().toISOString(),
      analysis_id: 'monorepo-dirty-config-test',
      system: {
        id: 'monorepo-dirty-config-test',
        name: 'monorepo-dirty-config-test',
        type: 'application',
        root_path: projectPath,
      },
      nodes: [],
      edges: [],
      analyzer_contributions: [],
      progressive_levels: { total_levels: 1 },
    };
    const detector = new ChangeDetector(projectPath);
    const state = orchestrator.buildIncrementalState(projectPath, output, detector);

    assert.ok(state.files['package.json']);

    const changes = await detector.detectChanges(state);
    assert.equal(changes.requiresFullRebuild, false);
    assert.deepEqual(changes.modified, []);
    assert.deepEqual(changes.added, []);
    assert.deepEqual(changes.deleted, []);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
