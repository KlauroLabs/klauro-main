jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NestJSAnalyzer } from '../../analyzer/frameworks/web/nestjs-analyzer';

/**
 * Two extraction paths that could never emit anything, and one that only
 * emitted from a conventionally named file.
 *
 * (1) analyzeScheduledTasks, analyzeEventListeners and the @SubCommand branch
 * of analyzeCliCommands resolved the owning
 * class by walking `node.parent` up to the nearest ClassDeclaration. This
 * parser never populates `node.parent`, so that walk always failed and the
 * class name fell back to the literal string 'UnknownClass' — which never
 * matches a real `class_<file>_<name>_0` id, so the emission-gating lookup
 * always missed and neither path ever produced an entry point. The walk
 * already tracks `activeClass` as it descends; the fix is to use that
 * instead of the broken parent-walk, and to thread it through recursion.
 *
 * (2) @Controller classes were only scanned in files matching the
 * `.controller.` filename convention. A `@Controller` class living in an
 * arbitrarily named file (e.g. src/api/orders.ts) was never parsed at all —
 * filename is not evidence, the decorator is.
 */
describe('NestJS extraction paths that previously emitted nothing', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-emission-gaps-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'emission-gaps-fixture',
      dependencies: {
        '@nestjs/core': '^10.0.0',
        '@nestjs/common': '^10.0.0',
        '@nestjs/schedule': '^4.0.0',
        '@nestjs/event-emitter': '^2.0.0',
        'nest-commander': '^3.0.0',
      },
    }));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const write = (relative: string, lines: string[]) => {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, lines.join('\n'));
  };

  const analyze = async () => {
    const contribution: any = await new NestJSAnalyzer().analyze({ projectPath: root } as any);
    return {
      entryPoints: (contribution.entry_points || []) as any[],
      nodes: (contribution.nodes || []) as any[],
    };
  };

  it('emits a scheduled task entry point anchored to its real owning class', async () => {
    // The @Cron decorator sits in a .service.ts file, which is exactly the
    // condition under which the bug went unnoticed: cron-analyzer.ts covers
    // the surface independently for this filename pattern, masking that the
    // NestJS path itself never emitted anything.
    write('src/reports.service.ts', [
      "import { Injectable } from '@nestjs/common';",
      "import { Cron } from '@nestjs/schedule';",
      '',
      '@Injectable()',
      'export class ReportsService {',
      "  @Cron('0 0 * * *')",
      '  generateDailyReport() {}',
      '}',
    ]);

    const { entryPoints } = await analyze();
    const schedule = entryPoints.filter(e => e.type === 'schedule');
    expect(schedule.length).toBe(1);
    expect(schedule[0].metadata.handler_class).toBe('ReportsService');
    expect(schedule[0].metadata.handler_method).toBe('generateDailyReport');
  });

  it('emits an event listener entry point anchored to its real owning class', async () => {
    write('src/notifications.service.ts', [
      "import { Injectable } from '@nestjs/common';",
      "import { OnEvent } from '@nestjs/event-emitter';",
      '',
      '@Injectable()',
      'export class NotificationsService {',
      "  @OnEvent('order.created')",
      '  handleOrderCreated() {}',
      '}',
    ]);

    const { entryPoints } = await analyze();
    const events = entryPoints.filter(e => e.type === 'event');
    expect(events.length).toBe(1);
    expect(events[0].metadata.handler_class).toBe('NotificationsService');
    expect(events[0].metadata.handler_method).toBe('handleOrderCreated');
  });

  it('emits a @SubCommand entry point anchored to its real owning class', async () => {
    write('src/sync.command.ts', [
      "import { Command, SubCommand, CommandRunner } from 'nest-commander';",
      '',
      "@Command({ name: 'db' })",
      'export class DatabaseCommand extends CommandRunner {',
      "  @SubCommand('sync')",
      '  runSync() {}',
      '}',
    ]);

    const { entryPoints } = await analyze();
    const subCommands = entryPoints.filter(e => e.metadata?.handler_method === 'runSync');
    expect(subCommands.length).toBe(1);
    expect(subCommands[0].type).toBe('cli');
    // The owning class, not the 'UnknownClass' fallback the parent-walk produced.
    expect(subCommands[0].metadata.command_class).toBe('DatabaseCommand');
    // Anchors to the real class node id, which 'UnknownClass' could never match.
    expect(subCommands[0].source_node).toBe('class_src/sync.command.ts_DatabaseCommand_0');
  });

  it('finds a @Controller class in a file that does not follow the *.controller.* naming convention', async () => {
    write('src/api/orders.ts', [
      "import { Controller, Get } from '@nestjs/common';",
      '',
      "@Controller('orders')",
      'export class OrdersController {',
      '  @Get()',
      '  findAll() {}',
      '}',
    ]);

    const { nodes } = await analyze();
    const controllerNode = nodes.find(n => n.name === 'OrdersController' && n.type === 'controller');
    expect(controllerNode).toBeDefined();
    // source.file is repo-relative: it must not carry the analysis sandbox's
    // absolute layout (temp dir, username) into stored output, and it matches
    // the filePath threaded through the analyzer and the `class_<file>_<name>_0`
    // node ids built from it (#114b).
    expect(controllerNode.source.file).toBe('src/api/orders.ts');
  });

  it('still finds a conventionally named controller (no regression from the broadened scan)', async () => {
    write('src/users.controller.ts', [
      "import { Controller, Get } from '@nestjs/common';",
      '',
      '@Controller("users")',
      'export class UsersController {',
      '  @Get()',
      '  findAll() {}',
      '}',
    ]);

    const { nodes } = await analyze();
    const controllerNode = nodes.find(n => n.name === 'UsersController' && n.type === 'controller');
    expect(controllerNode).toBeDefined();
  });
});
