import test from 'node:test';
import assert from 'node:assert/strict';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { buildPhaseTimings, hostedAiConcurrency, recordAnalysisStage, timeAnalysisStage } from './analysis-phase-timings';

test('phase timings split queue wait, structural, AI, engine save and landing from stage timings', () => {
  const timings = buildPhaseTimings({
    queuedAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:10.000Z',
    workerFinishedAtMs: Date.parse('2026-01-01T00:01:10.000Z'),
    finishedAtMs: Date.parse('2026-01-01T00:01:12.000Z'),
    stageTimingsMs: { scan: 100, parse: 2000, graph: 3000, decorators: 900, comprehension: 40000, save: 700 },
  });
  assert.equal(timings.queue_wait_ms, 10_000);
  assert.equal(timings.structural_ms, 6000);
  assert.equal(timings.ai_ms, 40_000);
  assert.equal(timings.engine_save_ms, 700);
  assert.equal(timings.landing_ms, 2000);
  assert.equal(timings.total_ms, 72_000);
});

test('phase timings report the engine run and structural pass of the tier-stack pipeline', () => {
  const timings = buildPhaseTimings({
    queuedAt: '2026-01-01T00:00:00.000Z',
    workerFinishedAtMs: Date.parse('2026-01-01T00:01:00.000Z'),
    finishedAtMs: Date.parse('2026-01-01T00:01:01.000Z'),
    stageTimingsMs: { structural: 1500, engine: 50_000, save: 900 },
  });
  assert.equal(timings.structural_ms, 1500);
  assert.equal(timings.engine_ms, 50_000);
  assert.equal(timings.engine_save_ms, 900);
});

test('phase timings omit engine stages when the worker reported none and never go negative', () => {
  const timings = buildPhaseTimings({
    queuedAt: '2026-01-01T00:00:10.000Z',
    workerFinishedAtMs: 0,
    finishedAtMs: Date.parse('2026-01-01T00:00:05.000Z'),
  });
  assert.equal(timings.structural_ms, undefined);
  assert.equal(timings.queue_wait_ms, 0);
  assert.equal(timings.total_ms, 0);
});

test('hosted AI concurrency follows the environment and defaults to the relay-safe 16', () => {
  const previous = process.env.KLAURO_AI_CONCURRENCY;
  try {
    delete process.env.KLAURO_AI_CONCURRENCY;
    assert.equal(hostedAiConcurrency(), 16);
    process.env.KLAURO_AI_CONCURRENCY = '8';
    assert.equal(hostedAiConcurrency(), 8);
  } finally {
    if (previous === undefined) delete process.env.KLAURO_AI_CONCURRENCY;
    else process.env.KLAURO_AI_CONCURRENCY = previous;
  }
});

test('recording a stage accumulates onto the run timings', () => {
  const output = { timings: { total_ms: 100, stages: { engine: 100 } } } as unknown as CASOutput;
  recordAnalysisStage(output, 'save', 40);
  recordAnalysisStage(output, 'save', 10);
  assert.deepEqual(output.timings, { total_ms: 150, stages: { engine: 100, save: 50 } });
  const bare = {} as unknown as CASOutput;
  recordAnalysisStage(bare, 'structural', 7);
  assert.deepEqual(bare.timings, { total_ms: 7, stages: { structural: 7 } });
});

test('a timed stage records its duration and ignores an unmeasured one', async () => {
  const output = {} as unknown as CASOutput;
  recordAnalysisStage(output, 'structural', undefined);
  const saved = () => output.timings?.stages?.save;
  assert.equal(saved(), undefined);
  await timeAnalysisStage(output, 'save', async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  assert.ok((saved() ?? 0) >= 15);
});
