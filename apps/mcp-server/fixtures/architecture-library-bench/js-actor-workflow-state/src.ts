import { ActorSystem, Props } from 'akkajs';
import { Client } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import { createMachine, interpret, assign } from 'xstate';
import { Container, injectable, inject } from 'inversify';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import OpenAI from 'openai';

async function archiveActivity(id: string) {
  return { archived: id };
}

const TYPES = { Storage: Symbol.for('Storage') };

@injectable()
class StorageGateway {
  private readonly s3 = new S3Client({ region: 'us-east-1' });

  async save(key: string, body: string) {
    return this.s3.send(new PutObjectCommand({ Bucket: 'reports', Key: key, Body: body }));
  }
}

@injectable()
class WorkflowReporter {
  constructor(@inject(TYPES.Storage) private readonly storage: StorageGateway) {}

  async start(workflowId: string) {
    const client = new Client();
    await client.workflow.start('shipReportWorkflow', { taskQueue: 'reports', workflowId, args: [] });
    await this.storage.save(`${workflowId}.json`, '{}');
  }
}

const container = new Container();
container.bind(TYPES.Storage).to(StorageGateway);
container.bind(WorkflowReporter).toSelf();

async function bootRuntime() {
  const system = ActorSystem.create('report-actors');
  const actor = system.actorOf(Props.create(class ReportActor {}), 'reporter');
  actor.tell({ type: 'REPORT_READY' });

  const worker = await Worker.create({ taskQueue: 'reports', workflowsPath: require.resolve('./src') });
  await worker.run();
  await client.workflow.executeActivity(archiveActivity, { taskQueue: 'reports', args: ['report-1'] });

  const machine = createMachine({
    id: 'report',
    initial: 'draft',
    states: {
      draft: { on: { APPROVE: { target: 'approved', actions: assign({ approved: () => true }) } } },
      approved: { on: { SHIP: 'shipped' } },
      shipped: {},
    },
  });
  interpret(machine).start().send({ type: 'APPROVE' });

  const ai = new OpenAI();
  await ai.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'summarize report' }] });
}

void bootRuntime();
