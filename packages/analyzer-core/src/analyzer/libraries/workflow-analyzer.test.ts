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

  // Temporal: workflow that dispatches proxied activities -> orchestrator->activity edges.
  await fs.ensureDir(path.join(dir, 'workflows'));
  await fs.writeFile(
    path.join(dir, 'workflows', 'order.workflow.ts'),
    [
      `import { proxyActivities } from '@temporalio/workflow';`,
      `const { chargeCard, sendReceipt } = proxyActivities<typeof activities>({ startToCloseTimeout: '1m' });`,
      `export async function orderWorkflow(id: string) {`,
      `  await chargeCard(id);`,
      `  await sendReceipt(id);`,
      `}`,
      '',
    ].join('\n')
  );
  await fs.ensureDir(path.join(dir, 'activities'));
  await fs.writeFile(
    path.join(dir, 'activities', 'index.ts'),
    [
      `export async function chargeCard(id: string) { return id; }`,
      `export async function sendReceipt(id: string) { return id; }`,
      '',
    ].join('\n')
  );

  // AWS Step Functions ASL state machine (*.asl.json).
  await fs.writeJson(path.join(dir, 'order.asl.json'), {
    Comment: 'Order processing',
    StartAt: 'Charge',
    States: {
      Charge: { Type: 'Task', Resource: 'arn:aws:lambda:us-east-1:0:function:charge', Next: 'Notify' },
      Notify: { Type: 'Task', Resource: 'arn:aws:lambda:us-east-1:0:function:notify', End: true },
    },
  });

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

test('WorkflowAnalyzer detects durable orchestrators + orchestrator->activity dispatch edges', async () => {
  const dir = await makeFixture();
  try {
    const analyzer = new WorkflowAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: dir });
    const { nodes, edges, entry_points: entryPoints } = contribution;

    // --- Temporal workflow + activity dispatch edges ---
    const wf = nodes.find(n => n.type === 'workflow' && n.name === 'orderWorkflow' && (n.metadata as any)?.system === 'temporal');
    assert.ok(wf, 'expected a Temporal orderWorkflow node');
    const chargeActivity = nodes.find(n => n.type === 'activity' && n.name === 'chargeCard');
    assert.ok(chargeActivity, 'expected a chargeCard activity node');
    const dispatchEdge = edges.find(e => e.source === wf!.id && e.type === 'dispatches' && e.target === chargeActivity!.id);
    assert.ok(dispatchEdge, 'expected an orchestrator->activity dispatch edge for chargeCard');
    assert.equal((dispatchEdge!.metadata as any)?.async, true, 'activity dispatch is an async task seam');
    assert.ok(edges.find(e => e.source === wf!.id && e.type === 'dispatches' && (e.metadata as any)?.activity === 'sendReceipt'), 'expected a dispatch edge for sendReceipt too');

    // --- AWS Step Functions ASL state machine + Task states as activity seams ---
    const sfnWorkflow = nodes.find(n => n.type === 'workflow' && (n.metadata as any)?.system === 'step-functions');
    assert.ok(sfnWorkflow, 'expected a Step Functions workflow node');
    assert.equal((sfnWorkflow!.metadata as any)?.startAt, 'Charge', 'ASL StartAt should be captured');
    const chargeState = nodes.find(n => (n.metadata as any)?.system === 'step-functions' && n.name === 'Charge');
    assert.ok(chargeState, 'expected the Charge Task state as a node');
    assert.equal((chargeState!.metadata as any)?.stateType, 'Task');
    assert.ok((chargeState!.metadata as any)?.resource?.includes('function:charge'), 'expected the Task Resource ARN captured');
    const sfnDispatch = edges.find(e => e.source === sfnWorkflow!.id && e.target === chargeState!.id && e.type === 'dispatches');
    assert.ok(sfnDispatch, 'expected an ASL orchestrator->Task dispatch edge');
    assert.ok(entryPoints.find(ep => (ep.metadata as any)?.system === 'step-functions'), 'expected a Step Functions entry point');

    const meta = contribution.analyzer_metadata as any;
    assert.ok(meta.capabilities.includes('step-functions-state-machines'));
    assert.ok(meta.capabilities.includes('orchestrator-activity-dispatch-edges'));
  } finally {
    await fs.remove(dir);
  }
});
