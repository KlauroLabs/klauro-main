import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runHostedProjectQueryWorker, resolveHostedQueryHeapMb } from './hosted-project-query-process';
import { withHostedBackgroundPermit } from './hosted-background-queue';

test('hosted query heap is independently bounded with an explicit override', () => {
  assert.equal(resolveHostedQueryHeapMb({ KLAURO_ANALYSIS_HEAP_MB: '4096' }), 3072);
  assert.equal(resolveHostedQueryHeapMb({ KLAURO_HOSTED_QUERY_HEAP_MB: '2048' }), 2048);
  assert.equal(resolveHostedQueryHeapMb({ KLAURO_HOSTED_QUERY_HEAP_MB: '128' }), 3072);
});

test('hosted queries reuse one worker until background analysis requests memory', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-hosted-query-worker-'));
  const worker = path.join(directory, 'worker.cjs');
  fs.writeFileSync(worker, `
let calls = 0;
process.on('message', request => {
  calls += 1;
  process.send({ type: 'result', id: request.id, analysisTimestamp: 'fixture', result: { pid: process.pid, calls } });
});
`);
  const previousEntry = process.env.KLAURO_HOSTED_QUERY_WORKER_ENTRY;
  const previousIdle = process.env.KLAURO_HOSTED_QUERY_IDLE_MS;
  const previousBackgroundGrace = process.env.KLAURO_HOSTED_QUERY_BACKGROUND_GRACE_MS;
  process.env.KLAURO_HOSTED_QUERY_WORKER_ENTRY = worker;
  process.env.KLAURO_HOSTED_QUERY_IDLE_MS = '60000';
  process.env.KLAURO_HOSTED_QUERY_BACKGROUND_GRACE_MS = '0';
  const request = {
    workspace: directory,
    tool: 'search_nodes',
    args: { query: 'fixture' },
    projectId: 'project',
    analysisId: 'analysis',
  };
  try {
    const first = await runHostedProjectQueryWorker(request);
    const second = await runHostedProjectQueryWorker(request);
    assert.deepEqual((second.result as any).calls, 2);
    assert.equal((first.result as any).pid, (second.result as any).pid);

    await withHostedBackgroundPermit(async () => undefined, { releaseForegroundMemory: true });
    const third = await runHostedProjectQueryWorker(request);
    assert.deepEqual((third.result as any).calls, 1);
    assert.notEqual((third.result as any).pid, (second.result as any).pid);
  } finally {
    await withHostedBackgroundPermit(async () => undefined, { releaseForegroundMemory: true });
    if (previousEntry === undefined) delete process.env.KLAURO_HOSTED_QUERY_WORKER_ENTRY;
    else process.env.KLAURO_HOSTED_QUERY_WORKER_ENTRY = previousEntry;
    if (previousIdle === undefined) delete process.env.KLAURO_HOSTED_QUERY_IDLE_MS;
    else process.env.KLAURO_HOSTED_QUERY_IDLE_MS = previousIdle;
    if (previousBackgroundGrace === undefined) delete process.env.KLAURO_HOSTED_QUERY_BACKGROUND_GRACE_MS;
    else process.env.KLAURO_HOSTED_QUERY_BACKGROUND_GRACE_MS = previousBackgroundGrace;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
