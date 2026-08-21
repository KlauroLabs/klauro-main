import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetHostedAnalysisSchedulerForTests,
  executeHostedAnalysis,
  reserveHostedAnalysis,
  resolveHostedAnalysisCapacity,
  type HostedAnalysisTicket,
} from './hosted-analysis-admission';

const previousQueueCapacity = process.env.KLAURO_ANALYSIS_QUEUE_CAPACITY;
const previousEstimatedJobMs = process.env.KLAURO_ANALYSIS_ESTIMATED_JOB_MS;
const previousConcurrency = process.env.KLAURO_ANALYSIS_CONCURRENCY;

afterEach(() => {
  __resetHostedAnalysisSchedulerForTests();
  if (previousQueueCapacity === undefined) delete process.env.KLAURO_ANALYSIS_QUEUE_CAPACITY;
  else process.env.KLAURO_ANALYSIS_QUEUE_CAPACITY = previousQueueCapacity;
  if (previousEstimatedJobMs === undefined) delete process.env.KLAURO_ANALYSIS_ESTIMATED_JOB_MS;
  else process.env.KLAURO_ANALYSIS_ESTIMATED_JOB_MS = previousEstimatedJobMs;
  if (previousConcurrency === undefined) delete process.env.KLAURO_ANALYSIS_CONCURRENCY;
  else process.env.KLAURO_ANALYSIS_CONCURRENCY = previousConcurrency;
});

function admittedTicket(): HostedAnalysisTicket {
  const admission = reserveHostedAnalysis();
  assert.equal(admission.admitted, true);
  return admission.ticket;
}

test('hosted capacity remains one active analysis and bounds the waiting queue', () => {
  process.env.KLAURO_ANALYSIS_CONCURRENCY = '8';
  process.env.KLAURO_ANALYSIS_QUEUE_CAPACITY = '2';
  const capacity = resolveHostedAnalysisCapacity();
  assert.equal(capacity.activeLimit, 1);
  assert.equal(capacity.queueLimit, 2);

  const first = reserveHostedAnalysis();
  const second = reserveHostedAnalysis();
  const third = reserveHostedAnalysis();
  const fourth = reserveHostedAnalysis();
  assert.equal(first.admitted, true);
  assert.equal(second.admitted, true);
  assert.equal(third.admitted, true);
  assert.equal(fourth.admitted, false);
  if (!first.admitted || !second.admitted || !third.admitted || fourth.admitted) return;
  assert.equal(first.ticket.metadata.queue_position, 0);
  assert.equal(second.ticket.metadata.queue_position, 1);
  assert.equal(third.ticket.metadata.queue_position, 2);
  assert.deepEqual(fourth.overload, {
    status: 'overloaded',
    code: 'analysis_capacity_exhausted',
    active: 1,
    queued: 2,
    active_limit: 1,
    queue_limit: 2,
    retry_after_ms: 120_000,
  });
});

test('configured queue capacity is hard-capped', () => {
  process.env.KLAURO_ANALYSIS_QUEUE_CAPACITY = '999999';
  assert.equal(resolveHostedAnalysisCapacity().queueLimit, 32);
});

test('accepted work runs FIFO and reports updated queue positions', async () => {
  process.env.KLAURO_ANALYSIS_QUEUE_CAPACITY = '2';
  process.env.KLAURO_ANALYSIS_ESTIMATED_JOB_MS = '1000';
  const first = admittedTicket();
  const second = admittedTicket();
  const third = admittedTicket();
  const order: string[] = [];
  const positions = new Map<number, number[]>();
  let finishFirst!: () => void;

  const run = (ticket: HostedAnalysisTicket, name: string, task: () => Promise<void>) => executeHostedAnalysis(
    ticket,
    async () => {
      order.push(`${name}:start`);
      await task();
      order.push(`${name}:end`);
    },
    metadata => positions.set(ticket.id, [...(positions.get(ticket.id) || []), metadata.queue_position]),
  );

  const firstRun = run(first, 'first', () => new Promise<void>(resolve => { finishFirst = resolve; }));
  const secondRun = run(second, 'second', async () => undefined);
  const thirdRun = run(third, 'third', async () => undefined);
  await Promise.resolve();
  assert.deepEqual(order, ['first:start']);
  finishFirst();
  await Promise.all([firstRun, secondRun, thirdRun]);

  assert.deepEqual(order, ['first:start', 'first:end', 'second:start', 'second:end', 'third:start', 'third:end']);
  assert.equal(positions.get(second.id)?.at(-1), 0);
  assert.equal(positions.get(third.id)?.at(-1), 0);
  assert.ok((positions.get(third.id) || []).includes(1));
});

test('cancelling a reservation immediately frees bounded capacity', () => {
  process.env.KLAURO_ANALYSIS_QUEUE_CAPACITY = '0';
  const first = admittedTicket();
  const rejected = reserveHostedAnalysis();
  assert.equal(rejected.admitted, false);
  first.cancel();
  assert.equal(reserveHostedAnalysis().admitted, true);
});
