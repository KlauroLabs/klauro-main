import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import { WorkflowAnalyzer } from './workflow-analyzer';

async function makeFixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-analyzer-'));

  await fs.writeJson(path.join(dir, 'package.json'), {
    name: 'wf-fixture',
    dependencies: { bullmq: '^5.0.0' },
  });
  await fs.writeFile(path.join(dir, 'requirements.txt'), 'celery==5.3.0\n');

  // BullMQ: queue + producer add + worker
  await fs.writeFile(
    path.join(dir, 'queue.ts'),
    [
      `import { Queue, Worker } from 'bullmq';`,
      `const q = new Queue('emails');`,
      `q.add('send', {});`,
      `new Worker('emails', async job => {});`,
      '',
    ].join('\n')
  );

  // Celery: task definition + enqueue via .delay()
  await fs.writeFile(
    path.join(dir, 'tasks.py'),
    ['from celery import shared_task', '', '@app.task', 'def send_email():', '    return True', ''].join('\n')
  );
  await fs.writeFile(
    path.join(dir, 'caller.py'),
    ['from tasks import send_email', '', 'def trigger():', '    send_email.delay()', ''].join('\n')
  );

  return dir;
}

test('WorkflowAnalyzer detects BullMQ + Celery flows', async () => {
  const dir = await makeFixture();
  try {
    const analyzer = new WorkflowAnalyzer();

    assert.equal(await analyzer.canAnalyze(dir), true, 'canAnalyze should be true');

    const contribution = await analyzer.analyze({ projectPath: dir });
    const { nodes, edges, entry_points: entryPoints } = contribution;

    // --- BullMQ queue node 'emails' ---
    const queueNode = nodes.find(
      (n) => n.type === 'queue' && n.name === 'emails' && (n.metadata as any)?.system === 'bullmq'
    );
    assert.ok(queueNode, "expected a bullmq queue node named 'emails'");

    // --- BullMQ worker for 'emails' ---
    const workerNode = nodes.find(
      (n) => n.type === 'worker' && (n.metadata as any)?.system === 'bullmq' && (n.metadata as any)?.queue === 'emails'
    );
    assert.ok(workerNode, 'expected a bullmq worker node for queue emails');

    // --- BullMQ job (the .add('send')) + enqueue edge into the queue ---
    const addNode = nodes.find(
      (n) => n.type === 'job' && (n.metadata as any)?.system === 'bullmq' && (n.metadata as any)?.jobName === 'send'
    );
    assert.ok(addNode, "expected a bullmq job node for q.add('send')");
    const addEdge = edges.find((e) => e.source === addNode!.id && e.target === queueNode!.id && e.type === 'enqueues');
    assert.ok(addEdge, 'expected an enqueue edge from the bullmq add site to the emails queue');

    // --- Celery task 'send_email' as a job entry point ---
    const celeryTask = nodes.find(
      (n) => (n.metadata as any)?.system === 'celery' && n.name === 'send_email'
    );
    assert.ok(celeryTask, 'expected a celery task node send_email');
    const celeryEntry = entryPoints.find((ep) => ep.source_node === celeryTask!.id && ep.type === 'event');
    assert.ok(celeryEntry, 'expected send_email to be an async (event) entry point');

    // --- Celery enqueue edge from .delay() ---
    const celeryEnqueueEdge = edges.find((e) => e.target === celeryTask!.id && e.type === 'enqueues');
    assert.ok(celeryEnqueueEdge, 'expected an enqueue edge from send_email.delay() to the task');

    // --- Capabilities ---
    const meta = contribution.analyzer_metadata as any;
    assert.ok(meta.capabilities.includes('async-flows'));
    assert.ok(meta.capabilities.includes('bullmq-queues'));
    assert.ok(meta.capabilities.includes('celery-tasks'));
  } finally {
    await fs.remove(dir);
  }
});
