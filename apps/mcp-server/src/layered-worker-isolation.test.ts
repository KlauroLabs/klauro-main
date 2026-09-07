import { test, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as fsExtra from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  analyzeProjectIncremental,
  checkDoomedVersionRebuild,
  AnalysisLoopBreakerError,
  getAnalysis,
  runLayeredAnalysis,
  shutdownAnalysisWorker,
  type LayeredJobPhaseEvent,
} from './analyzer';
import { saveAnalysis, loadAnalysis, getAnalysisVersionInfo } from './storage';

// Task: layered-worker-isolation (2026-07-18). analyzeProjectLayered's L0 ->
// L1-4 -> L5 pipeline used to run entirely inside the API/MCP server process
// via the two setImmediate() continuations in remote-analyzer-service.ts
// (async /v1/analyze and /reanalyze) — the ONE analysis path 275e9dc7 did NOT
// route through the heap-capped forked worker. A huge monorepo's full rebuild
// there could still balloon the SAME process serving live traffic past the
// host's RAM and get kernel-OOM-killed, and — because the version mismatch
// that forced the rebuild never got resolved by a killed run — the very next
// request would re-trigger the identical doomed rebuild, forever. This suite
// covers: (1) the layered job completing through the worker with phase
// messages and a small summary, never the full CAS over IPC; (2) a mid-run
// child crash surfacing as a clean, phase-attributed failure instead of a
// hang; (3) the enrichment tail's honest terminal state; (4) the loop-breaker
// that turns the crash-loop into a fail-fast instead of an infinite retry.

let workspaceRoot: string;
let fixtureProject: string;

function writeFixtureProject(root: string, name: string): string {
  const projectDir = path.join(root, name);
  fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({
    name: `layered-worker-${name}`,
    version: '1.0.0',
    main: 'src/index.js',
  }, null, 2));
  fs.writeFileSync(path.join(projectDir, 'src', 'index.js'), [
    'function greet(name) {',
    '  return `Hello, ${name}`;',
    '}',
    '',
    'module.exports = { greet };',
    '',
  ].join('\n'));
  return projectDir;
}

// Mirrors remote-analyzer-service.ts's projectAttemptRecordPath /
// analyzer.ts's internalRebuildAttemptPath — deliberately the SAME on-disk
// convention (`<projectPath>/.reanalyze-attempt.json`), so a test can plant a
// record exactly as either real writer would.
function attemptRecordPath(projectPath: string): string {
  return path.join(projectPath, '.reanalyze-attempt.json');
}

before(() => {
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-layered-worker-'));
  fixtureProject = writeFixtureProject(workspaceRoot, 'fixture-project');
  process.env.KLAURO_STORAGE_PATH = path.join(workspaceRoot, 'storage');
  process.env.KLAURO_LOG_DIR = path.join(workspaceRoot, 'logs');
  process.env.KLAURO_EMBEDDING_ENABLED = 'false';
  process.env.KLAURO_AI_INTERPRETATION = 'false';
  process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS = 'false';
  delete process.env.KLAURO_ANALYSIS_IN_PROCESS;
  delete process.env.KLAURO_ANALYSIS_HEAP_MB;
  delete process.env.KLAURO_TEST_ANALYSIS_WORKER_CRASH;
  delete process.env.KLAURO_TEST_ANALYSIS_WORKER_STALL;
  delete process.env.KLAURO_ANALYSIS_STALL_MS;
});

after(() => {
  shutdownAnalysisWorker();
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

test('layered job persists structural layers and reports disabled comprehension honestly', async () => {
  const events: LayeredJobPhaseEvent[] = [];
  const summary = await runLayeredAnalysis(fixtureProject, {
    analysisFocus: 'full',
    repoFacts: { contributor_count: 7, first_commit_at: '2020-01-01T00:00:00.000Z' },
    onPhase: (event) => { events.push(event); },
  });

  assert.deepEqual(events.map(e => e.phase), ['l0', 'rest', 'enrichment']);
  assert.deepEqual(events.map(event => event.status), ['succeeded', 'succeeded', 'failed']);
  assert.ok(events[2].error);

  // The function's own resolved value is a small counts summary, never the
  // CASOutput itself.
  assert.ok(summary.nodes > 0, `expected nodes > 0, got ${summary.nodes}`);
  assert.ok('aiEnrichment' in summary);
  assert.notEqual(summary.aiEnrichment, 'pending', 'enrichment must have settled to a terminal state, never stay pending');

  // The parent never held the CAS — it reloads from storage, exactly as the
  // 275e9dc7-era sync routes do.
  const landed = await getAnalysis(fixtureProject);
  assert.ok(landed.nodes.length > 0);
  assert.equal(landed.layers_ready?.complete, false);
  assert.deepEqual(
    landed.layers_ready?.layers.filter(layer => layer.status === 'error').map(layer => layer.layer),
    ['L5'],
  );
  assert.ok(
    landed.layers_ready?.layers
      .filter(layer => layer.layer !== 'L5')
      .every(layer => layer.status === 'ready'),
  );
  assert.equal(landed.system.analysis_focus, 'full');
  assert.equal(landed.system.repo_facts?.contributor_count, 7);
});

test('in-process layered analysis also reports rejected enrichment as failed', async () => {
  const previous = process.env.KLAURO_ANALYSIS_IN_PROCESS;
  process.env.KLAURO_ANALYSIS_IN_PROCESS = '1';
  try {
    const events: LayeredJobPhaseEvent[] = [];
    const summary = await runLayeredAnalysis(fixtureProject, { analysisFocus: 'full', onPhase: event => { events.push(event); } });
    assert.ok(summary.failedLayers.some(layer => layer.layer === 'L5'));
    assert.deepEqual(events.map(event => event.status), ['succeeded', 'succeeded', 'failed']);
    assert.match(events[2].error!, /L5:/);
  } finally {
    if (previous === undefined) delete process.env.KLAURO_ANALYSIS_IN_PROCESS;
    else process.env.KLAURO_ANALYSIS_IN_PROCESS = previous;
  }
});

test('a child crash after L1-4 lands is a clean, phase-attributed failure — not a hang — and the worker recovers for the next call', async () => {
  const projectDir = writeFixtureProject(workspaceRoot, 'fixture-project-crash');
  process.env.KLAURO_TEST_ANALYSIS_WORKER_CRASH = 'sigkill-after-rest';
  const events: LayeredJobPhaseEvent[] = [];
  try {
    await assert.rejects(
      () => runLayeredAnalysis(projectDir, { onPhase: (event) => { events.push(event); } }),
      (error: Error) => {
        assert.match(error.message, /killed by signal SIGKILL/);
        assert.match(error.message, /without heap-exhaustion evidence/);
        return true;
      },
    );
  } finally {
    delete process.env.KLAURO_TEST_ANALYSIS_WORKER_CRASH;
  }

  // The child got far enough to report L0 and the L1-4 ("rest") phase as
  // succeeded — CAS is really on disk for those layers — before it died, so
  // the caller (e.g. remote-analyzer-service.ts's attempt-record writer) has
  // an honest, phase-attributed picture of exactly how far the run got,
  // rather than a bare "it failed" with no phase context.
  assert.deepEqual(events.map(e => e.phase), ['l0', 'rest']);
  assert.ok(events.every(e => e.status === 'succeeded'));

  const landedAfterCrash = await getAnalysis(projectDir);
  assert.ok(landedAfterCrash.nodes.length > 0, 'the L1-4 CAS the crashed run itself saved before dying must still be readable');

  // The worker respawns a fresh child for the NEXT job — a crash never
  // wedges the shared worker permanently.
  const recovered = await runLayeredAnalysis(projectDir);
  assert.ok(recovered.nodes > 0);
});

test('a live worker with a stopped progress counter is recycled and the next job recovers', async () => {
  const projectDir = writeFixtureProject(workspaceRoot, 'fixture-project-stall');
  process.env.KLAURO_ANALYSIS_STALL_MS = '100';
  process.env.KLAURO_TEST_ANALYSIS_WORKER_STALL = 'before-start';
  try {
    await assert.rejects(
      () => runLayeredAnalysis(projectDir),
      (error: Error) => {
        assert.match(error.message, /analysis-stalled/);
        assert.match(error.message, /stopped progress counter/);
        return true;
      },
    );
  } finally {
    delete process.env.KLAURO_TEST_ANALYSIS_WORKER_STALL;
    delete process.env.KLAURO_ANALYSIS_STALL_MS;
  }

  const recovered = await runLayeredAnalysis(projectDir);
  assert.ok(recovered.nodes > 0);
});

test('checkDoomedVersionRebuild refuses a version-rebuild that already failed with a worker-oom/watchdog reason for the SAME version pair, but not a different one', async () => {
  const projectDir = writeFixtureProject(workspaceRoot, 'fixture-project-loopbreak');

  // Establish a real stored analysis, then simulate the exact incident shape:
  // a deploy bumped cas_version, and the resulting rebuild attempt already
  // died from a worker OOM (recorded exactly as
  // analyzer.ts's writeInternalRebuildAttempt / dispatchWorkerJob's crash
  // message would).
  await analyzeProjectIncremental(projectDir);
  const stored = await loadAnalysis(projectDir);
  assert.ok(stored);
  (stored as any).cas_version = '0.0.1';
  await saveAnalysis(projectDir, stored as any);
  const currentVersion = getAnalysisVersionInfo(stored as any).current_version;

  await fsExtra.writeJson(attemptRecordPath(projectDir), {
    state: 'failed',
    trigger: 'version-rebuild',
    started_at: new Date(Date.now() - 60_000).toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: 60_000,
    reason: 'Analysis worker for ' + projectDir + ' killed by signal SIGKILL after exhausting its heap.',
    stored_version: '0.0.1',
    current_version: currentVersion,
  });

  const refusal = await checkDoomedVersionRebuild(projectDir);
  assert.ok(refusal, 'expected the loop-breaker to refuse a repeat of the exact doomed rebuild');
  assert.match(refusal!, /loop-breaker/);
  assert.match(refusal!, /0\.0\.1/);

  // The guard is exercised end-to-end through analyzeProjectIncremental too
  // (the path runLayeredAnalysis's warm branch and the plain worker 'analyze'
  // job both go through) — it must reject with AnalysisLoopBreakerError
  // rather than silently retrying the identical rebuild.
  await assert.rejects(
    () => analyzeProjectIncremental(projectDir),
    (error: unknown) => error instanceof AnalysisLoopBreakerError,
  );

  // A DIFFERENT current_version (e.g. a subsequent deploy) is a genuinely new
  // rebuild target, not a repeat — must NOT be blocked by the old record.
  await fsExtra.writeJson(attemptRecordPath(projectDir), {
    state: 'failed',
    trigger: 'version-rebuild',
    started_at: new Date(Date.now() - 60_000).toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: 60_000,
    reason: 'Analysis worker for ' + projectDir + ' killed by signal SIGKILL after exhausting its heap.',
    stored_version: '0.0.1',
    current_version: 'some-other-version-9.9.9',
  });
  const noRefusal = await checkDoomedVersionRebuild(projectDir);
  assert.equal(noRefusal, null, 'a different (stored, current) version pair must not be blocked by an unrelated prior failure');

  // A failure for a NON-memory/watchdog reason (a real code bug, say) must
  // never trip the guard — only the memory/hang signature that caused the
  // original incident.
  await fsExtra.writeJson(attemptRecordPath(projectDir), {
    state: 'failed',
    trigger: 'version-rebuild',
    started_at: new Date(Date.now() - 60_000).toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: 1000,
    reason: 'TypeError: cannot read properties of undefined',
    stored_version: '0.0.1',
    current_version: currentVersion,
  });
  const noRefusalForOrdinaryBug = await checkDoomedVersionRebuild(projectDir);
  assert.equal(noRefusalForOrdinaryBug, null, 'an ordinary (non-memory/watchdog) failure reason must not trip the loop-breaker');
});
