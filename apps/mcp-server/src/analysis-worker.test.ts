import { test, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_ANALYSIS_HEAP_MB,
  MINIMUM_ANALYSIS_HEAP_MB,
  describeAnalysisHeap,
  resolveAnalysisHeapMb,
} from './analysis-heap';
import {
  __analysisWorkerRunningForTests,
  analysisWorkerExecArgv,
  analysisRunsInProcess,
  prewarmAnalysisWorker,
  resolveAnalysisWorkerIdleMs,
  runAnalysis,
  shutdownAnalysisWorker,
} from './analyzer';
import { getAnalysisRunLogPath } from '../../../packages/analyzer-core/src/analyzer/core/run-log';
import { withHostedBackgroundPermit } from './hosted-background-queue';

const GB = 1024 * 1024 * 1024;

let workspaceRoot: string;
let fixtureProject: string;

function writeFixtureProject(root: string): string {
  const projectDir = path.join(root, 'fixture-project');
  fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({
    name: 'analysis-worker-fixture',
    version: '1.0.0',
    main: 'src/index.js',
  }, null, 2));
  fs.writeFileSync(path.join(projectDir, 'src', 'index.js'), [
    'function greet(name) {',
    '  return `Hello, ${name}`;',
    '}',
    '',
    'function farewell(name) {',
    '  return `Goodbye, ${name}`;',
    '}',
    '',
    'module.exports = { greet, farewell };',
    '',
  ].join('\n'));
  return projectDir;
}

// Polls a condition instead of sleeping a fixed duration — a fixed sleep is
// either a race (too short, flaky under load) or pure wasted wall time on the
// pre-deploy gate (too long, "just in case"). Polls every 5ms up to
// timeoutMs, so the common case resolves almost immediately.
async function pollUntil(condition: () => boolean, timeoutMs = 2000, intervalMs = 5): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`pollUntil: condition not met within ${timeoutMs}ms`);
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

function readRunLogEvents(): Array<{ event: string; project_path: string; run_id: string; error?: { message: string } }> {
  const logPath = getAnalysisRunLogPath();
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line));
}

before(() => {
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-analysis-worker-'));
  fixtureProject = writeFixtureProject(workspaceRoot);
  process.env.KLAURO_STORAGE_PATH = path.join(workspaceRoot, 'storage');
  process.env.KLAURO_LOG_DIR = path.join(workspaceRoot, 'logs');
  process.env.KLAURO_EMBEDDING_ENABLED = 'false';
  process.env.KLAURO_AI_INTERPRETATION = 'false';
  process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS = 'false';
  delete process.env.KLAURO_ANALYSIS_IN_PROCESS;
  delete process.env.KLAURO_ANALYSIS_HEAP_MB;
  delete process.env.KLAURO_TEST_ANALYSIS_WORKER_CRASH;
});

after(() => {
  shutdownAnalysisWorker();
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

test('resolveAnalysisHeapMb uses the default heap on machines with enough RAM', () => {
  const resolution = resolveAnalysisHeapMb({}, 64 * GB);
  assert.strictEqual(resolution.heapMb, DEFAULT_ANALYSIS_HEAP_MB);
  assert.strictEqual(resolution.source, 'default');
});

test('resolveAnalysisHeapMb caps the default to half of total RAM', () => {
  const resolution = resolveAnalysisHeapMb({}, 8 * GB);
  assert.strictEqual(resolution.heapMb, 4096);
  assert.strictEqual(resolution.source, 'default-capped');
  assert.match(describeAnalysisHeap(resolution), /capped/);
});

test('resolveAnalysisHeapMb honors KLAURO_ANALYSIS_HEAP_MB even above the default cap', () => {
  const resolution = resolveAnalysisHeapMb({ KLAURO_ANALYSIS_HEAP_MB: '16384' }, 32 * GB);
  assert.strictEqual(resolution.heapMb, 16384);
  assert.strictEqual(resolution.source, 'env');
});

test('resolveAnalysisHeapMb falls back to the default and flags invalid env values', () => {
  for (const invalid of ['abc', '-5', '12']) {
    const resolution = resolveAnalysisHeapMb({ KLAURO_ANALYSIS_HEAP_MB: invalid }, 64 * GB);
    assert.strictEqual(resolution.heapMb, DEFAULT_ANALYSIS_HEAP_MB);
    assert.strictEqual(resolution.envInvalid, true);
    assert.match(describeAnalysisHeap(resolution), /invalid/);
  }
  assert.strictEqual(MINIMUM_ANALYSIS_HEAP_MB > 12, true);
});

test('analysisRunsInProcess respects the fallback flag', () => {
  assert.strictEqual(analysisRunsInProcess({}), false);
  assert.strictEqual(analysisRunsInProcess({ KLAURO_ANALYSIS_IN_PROCESS: '1' }), true);
  assert.strictEqual(analysisRunsInProcess({ KLAURO_ANALYSIS_IN_PROCESS: 'true' }), true);
  assert.strictEqual(analysisRunsInProcess({ KLAURO_ANALYSIS_IN_PROCESS: '0' }), false);
});

test('prewarmAnalysisWorker starts the isolated worker before the first analysis', () => {
  shutdownAnalysisWorker();
  prewarmAnalysisWorker();
  assert.strictEqual(__analysisWorkerRunningForTests(), true);
});

test('analysis worker idle policy defaults to per-job recycling and permits explicit reuse', () => {
  assert.strictEqual(resolveAnalysisWorkerIdleMs({}), 0);
  assert.strictEqual(resolveAnalysisWorkerIdleMs({ KLAURO_ANALYSIS_WORKER_IDLE_MS: '2500' }), 2500);
  assert.strictEqual(resolveAnalysisWorkerIdleMs({ KLAURO_ANALYSIS_WORKER_IDLE_MS: '-1' }), null);
  assert.strictEqual(resolveAnalysisWorkerIdleMs({ KLAURO_ANALYSIS_WORKER_IDLE_MS: 'invalid' }), 0);
});

test('analysis worker removes parent eval payloads while preserving runtime loaders', () => {
  assert.deepStrictEqual(
    analysisWorkerExecArgv(['--require', 'tsx/preflight.cjs', '-e', 'runBenchmark()', '--max-old-space-size=1024', '--trace-warnings']),
    ['--require', 'tsx/preflight.cjs', '--trace-warnings'],
  );
});

test('worker success path: analysis runs in a child process, stores results, and logs run-complete', async () => {
  const summary = await runAnalysis(fixtureProject, { forceFull: true });

  assert.strictEqual(summary.analysisType, 'full');
  assert.ok(summary.nodes > 0, `expected nodes > 0, got ${summary.nodes}`);
  assert.ok(summary.casVersion, 'expected a cas_version in the worker summary');

  const events = readRunLogEvents().filter(record => record.project_path === fixtureProject);
  assert.ok(events.some(record => record.event === 'run-start'), 'expected a run-start record');
  assert.ok(events.some(record => record.event === 'run-complete'), 'expected a run-complete record');

  const storedAnalyses = fs.readdirSync(process.env.KLAURO_STORAGE_PATH!);
  assert.ok(storedAnalyses.length > 0, 'expected the worker to persist the analysis through the storage path');
});

test('worker incremental path returns a change summary shape', async () => {
  const summary = await runAnalysis(fixtureProject);
  assert.ok(summary.analysisType === 'incremental' || summary.wasFullRebuild);
  assert.ok(summary.changeReport, 'expected a change report from the incremental path');
});

test('idle hosted worker exits after its warm reuse window', async () => {
  process.env.KLAURO_ANALYSIS_WORKER_IDLE_MS = '10';
  try {
    await runAnalysis(fixtureProject);
    assert.strictEqual(__analysisWorkerRunningForTests(), true);
    await pollUntil(() => __analysisWorkerRunningForTests() === false);
    assert.strictEqual(__analysisWorkerRunningForTests(), false);
  } finally {
    delete process.env.KLAURO_ANALYSIS_WORKER_IDLE_MS;
  }
});

test('persistent hosted worker is released before memory-heavy background work', async () => {
  process.env.KLAURO_ANALYSIS_WORKER_IDLE_MS = '-1';
  try {
    await runAnalysis(fixtureProject);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.strictEqual(__analysisWorkerRunningForTests(), true);
    await withHostedBackgroundPermit(async () => {
      assert.strictEqual(__analysisWorkerRunningForTests(), false);
    }, { releaseForegroundMemory: true });
  } finally {
    delete process.env.KLAURO_ANALYSIS_WORKER_IDLE_MS;
    shutdownAnalysisWorker();
  }
});

test('worker crash: server survives, gets a clear error, and a run-failed record is written', async () => {
  process.env.KLAURO_TEST_ANALYSIS_WORKER_CRASH = 'sigkill';
  try {
    await assert.rejects(
      () => runAnalysis(fixtureProject, { forceFull: true }),
      (error: Error) => {
        assert.match(error.message, /Analysis worker for .* killed by signal SIGKILL/);
        assert.match(error.message, /without heap-exhaustion evidence/);
        assert.match(error.message, /run-failed record/);
        return true;
      },
    );
  } finally {
    delete process.env.KLAURO_TEST_ANALYSIS_WORKER_CRASH;
  }

  const failures = readRunLogEvents().filter(record =>
    record.event === 'run-failed' && record.project_path === fixtureProject);
  assert.ok(failures.length > 0, 'expected a run-failed record after the worker died');
  assert.match(failures[failures.length - 1].error?.message || '', /without heap-exhaustion evidence/);

  const starts = readRunLogEvents().filter(record =>
    record.event === 'run-start' && record.project_path === fixtureProject);
  const finalizedIds = new Set(readRunLogEvents()
    .filter(record => record.event === 'run-complete' || record.event === 'run-failed')
    .map(record => record.run_id));
  const orphaned = starts.filter(record => !finalizedIds.has(record.run_id));
  assert.strictEqual(orphaned.length, 0, 'every run-start should be finalized after the crash');

  const recovered = await runAnalysis(fixtureProject, { forceFull: true });
  assert.ok(recovered.nodes > 0, 'a fresh worker should serve the next analysis after a crash');
});

test('in-process fallback flag still runs the analysis', async () => {
  process.env.KLAURO_ANALYSIS_IN_PROCESS = '1';
  try {
    const summary = await runAnalysis(fixtureProject, { forceFull: true });
    assert.ok(summary.nodes > 0);
    assert.strictEqual(summary.analysisType, 'full');
  } finally {
    delete process.env.KLAURO_ANALYSIS_IN_PROCESS;
  }
});

test('heap config plumbing: worker respawns with the configured heap size', async () => {
  process.env.KLAURO_ANALYSIS_HEAP_MB = '512';
  try {
    const summary = await runAnalysis(fixtureProject, { forceFull: true });
    assert.ok(summary.nodes > 0, 'analysis should succeed under an explicit 512 MB heap');
  } finally {
    delete process.env.KLAURO_ANALYSIS_HEAP_MB;
  }
});
