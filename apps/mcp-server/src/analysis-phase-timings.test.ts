import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPhaseTimings, hostedAiConcurrency } from './analysis-phase-timings';

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
