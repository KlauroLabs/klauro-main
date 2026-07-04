import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import { CronAnalyzer } from './cron-analyzer';

async function makeFixture(deps: Record<string, string>, files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cron-analyzer-'));
  await fs.writeJson(path.join(root, 'package.json'), { name: 'cron-fixture', dependencies: deps });
  for (const [file, content] of Object.entries(files)) {
    await fs.ensureFile(path.join(root, file));
    await fs.writeFile(path.join(root, file), content);
  }
  return root;
}

test('CronAnalyzer canAnalyze detects cron/node-cron/@nestjs/schedule deps', async () => {
  const root = await makeFixture({ cron: '^2.4.3' }, {});
  try {
    const analyzer = new CronAnalyzer();
    assert.strictEqual(await analyzer.canAnalyze(root), true);
  } finally {
    await fs.remove(root);
  }
});

test('CronAnalyzer canAnalyze is false without a scheduling dependency', async () => {
  const root = await makeFixture({ express: '^4.0.0' }, {});
  try {
    const analyzer = new CronAnalyzer();
    assert.strictEqual(await analyzer.canAnalyze(root), false);
  } finally {
    await fs.remove(root);
  }
});

test('CronAnalyzer extracts `new CronJob(...)` as a scheduled entry point', async () => {
  const root = await makeFixture(
    { cron: '^2.4.3' },
    {
      'index.ts': `import cron from 'cron'

async function liquidateFromSpendingHandler() {}

new cron.CronJob(
  '0 0 * * * *',
  async () => {
    await liquidateFromSpendingHandler()
  },
  null,
  true,
  'America/Denver'
)
`,
    }
  );
  try {
    const analyzer = new CronAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: root });

    const jobNodes = contribution.nodes.filter(n => n.type === 'scheduled_job');
    assert.strictEqual(jobNodes.length, 1);

    const entry = contribution.entry_points.find(ep => ep.type === 'schedule');
    assert.ok(entry, 'should emit a schedule-type entry point');
    assert.strictEqual(entry!.trigger?.schedule, '0 0 * * * *');
    assert.strictEqual(entry!.metadata?.library, 'cron');
  } finally {
    await fs.remove(root);
  }
});

test('CronAnalyzer extracts a named `new CronJob(schedule, handlerRef, ...)` handler by name', async () => {
  const root = await makeFixture(
    { cron: '^2.4.3' },
    {
      'jobs.ts': `import { CronJob } from 'cron'

function runBackup() {}

new CronJob('0 0 0 * * *', runBackup, null, true)
`,
    }
  );
  try {
    const analyzer = new CronAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: root });
    const entry = contribution.entry_points.find(ep => ep.type === 'schedule');
    assert.ok(entry);
    assert.strictEqual(entry!.handler?.method_name, 'runBackup');
  } finally {
    await fs.remove(root);
  }
});

test('CronAnalyzer extracts node-cron `cron.schedule(...)` as a scheduled entry point', async () => {
  const root = await makeFixture(
    { 'node-cron': '^3.0.3' },
    {
      'scheduler.ts': `import cron from 'node-cron'

function syncInventory() {}

cron.schedule('*/5 * * * *', syncInventory)
`,
    }
  );
  try {
    const analyzer = new CronAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: root });

    const entry = contribution.entry_points.find(ep => ep.type === 'schedule');
    assert.ok(entry, 'should emit a schedule-type entry point for node-cron');
    assert.strictEqual(entry!.trigger?.schedule, '*/5 * * * *');
    assert.strictEqual(entry!.metadata?.library, 'node-cron');
    assert.strictEqual(entry!.handler?.method_name, 'syncInventory');
  } finally {
    await fs.remove(root);
  }
});

test('CronAnalyzer extracts @nestjs/schedule @Cron decorator on a class method', async () => {
  const root = await makeFixture(
    { '@nestjs/schedule': '^4.0.0' },
    {
      'reports.service.ts': `import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'

@Injectable()
export class ReportsService {
  @Cron('0 0 * * *')
  async generateDailyReport() {
    // ...
  }
}
`,
    }
  );
  try {
    const analyzer = new CronAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: root });

    const entry = contribution.entry_points.find(ep => ep.type === 'schedule');
    assert.ok(entry, 'should emit a schedule-type entry point for @nestjs/schedule');
    assert.strictEqual(entry!.trigger?.schedule, '0 0 * * *');
    assert.strictEqual(entry!.handler?.method_name, 'generateDailyReport');
    assert.strictEqual(entry!.metadata?.library, 'nestjs-schedule');
  } finally {
    await fs.remove(root);
  }
});
