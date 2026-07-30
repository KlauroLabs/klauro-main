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

test('CronAnalyzer finds scheduler decorators imported under an alias', async () => {
  // `import { Cron as Scheduled }` is ordinary — matching the exported name
  // alone dropped every job in the file with no indication anything was skipped.
  const root = await makeFixture(
    { '@nestjs/schedule': '^4.0.0' },
    {
      'jobs.service.ts': `import { Injectable } from '@nestjs/common'
import { Cron as Scheduled, Interval as Every, Timeout as After } from '@nestjs/schedule'

@Injectable()
export class JobsService {
  @Scheduled('0 * * * *')
  async hourly() {}

  @Every(5000)
  async poll() {}

  @After(1000)
  async warmup() {}
}
`,
    }
  );
  try {
    const contribution = await new CronAnalyzer().analyze({ projectPath: root });
    const schedules = contribution.entry_points.filter(ep => ep.type === 'schedule');

    assert.strictEqual(schedules.length, 3, 'all three aliased decorators are jobs');
    const byHandler = new Map(schedules.map(ep => [ep.handler?.method_name, ep]));
    // Schedules are preserved verbatim, so the alias must not change them.
    assert.strictEqual(byHandler.get('hourly')!.trigger?.schedule, '0 * * * *');
    assert.strictEqual(byHandler.get('poll')!.trigger?.schedule, '5000');
    assert.strictEqual(byHandler.get('warmup')!.trigger?.schedule, '1000');
    // The alias resolves back to the decorator it really is, so an @Interval
    // written as @Every is not recorded as a cron expression.
    const kindOf = (handler: string) => {
      const node = contribution.nodes.find(
        n => n.type === 'scheduled_job' && n.name === handler
      );
      return (node?.metadata as any)?.attributes?.decoratorKind;
    };
    assert.strictEqual(kindOf('hourly'), 'Cron');
    assert.strictEqual(kindOf('poll'), 'Interval');
    assert.strictEqual(kindOf('warmup'), 'Timeout');
  } finally {
    await fs.remove(root);
  }
});

test('CronAnalyzer still matches an unaliased scheduler import', async () => {
  const root = await makeFixture(
    { '@nestjs/schedule': '^4.0.0' },
    {
      'plain.service.ts': `import { Cron } from '@nestjs/schedule'

export class PlainService {
  @Cron('0 0 * * *')
  async nightly() {}
}
`,
    }
  );
  try {
    const contribution = await new CronAnalyzer().analyze({ projectPath: root });
    const schedules = contribution.entry_points.filter(ep => ep.type === 'schedule');
    assert.strictEqual(schedules.length, 1);
    assert.strictEqual(schedules[0].handler?.method_name, 'nightly');
  } finally {
    await fs.remove(root);
  }
});
