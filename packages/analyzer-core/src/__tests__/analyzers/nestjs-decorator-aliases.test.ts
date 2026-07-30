jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NestJSAnalyzer } from '../../analyzer/frameworks/web/nestjs-analyzer';

/**
 * Every decorator family must survive `import { X as Y }`.
 *
 * Decorators were matched against the literal exported name, so an aliased
 * import made the match fail. The failure is silent and total: nothing is
 * reported as skipped, the surface simply is not there. For the class-level
 * decorators it is worse than losing one entry, because the member walk is
 * nested inside the class match — one aliased `@Controller` import costs that
 * controller's entire route set.
 *
 * Aliasing is not exotic: it is what you write when the class and the decorator
 * would otherwise share a name, or when two frameworks export the same symbol.
 */
describe('NestJS decorator import aliases', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-alias-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'alias-fixture',
      dependencies: { '@nestjs/core': '^10.0.0', '@nestjs/common': '^10.0.0' },
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
    return (contribution.entry_points || []) as any[];
  };

  it('CONTROLLER: an aliased @Controller keeps its whole route set', async () => {
    write('src/api/orders.controller.ts', [
      "import { Controller as Ctrl, Get as HttpGet, Post as HttpPost } from '@nestjs/common';",
      '',
      "@Ctrl('orders')",
      'export class OrdersEndpoint {',
      "  @HttpGet(':id')",
      '  findOne() {}',
      '',
      '  @HttpPost()',
      '  create() {}',
      '}',
    ]);

    const http = (await analyze()).filter(e => e.type === 'http');
    expect(http.map(e => `${e.trigger?.method} ${e.trigger?.path}`).sort())
      .toEqual(['GET /orders/:id', 'POST /orders']);
  });

  it('SCHEDULE/EVENT: aliased scheduler and event decorators resolve to their real names', () => {
    // These two families are extracted elsewhere (see the cron analyzer suite for
    // the schedule end-to-end), so what is asserted here is the resolution the
    // decorator matching depends on.
    const analyzer = new NestJSAnalyzer() as any;
    const { parse } = require('@typescript-eslint/typescript-estree');
    const ast = parse([
      "import { Cron as Scheduled, Interval as Every, Timeout as After } from '@nestjs/schedule';",
      "import { OnEvent as Handles } from '@nestjs/event-emitter';",
      "import { Injectable } from '@nestjs/common';",
    ].join('\n'), { loc: true, jsx: false });

    const aliases = analyzer.buildImportAliasMap(ast);
    expect(aliases.get('Scheduled')).toBe('Cron');
    expect(aliases.get('Every')).toBe('Interval');
    expect(aliases.get('After')).toBe('Timeout');
    expect(aliases.get('Handles')).toBe('OnEvent');
    // An unaliased import is not in the map, and resolution falls through to
    // the literal name.
    expect(aliases.has('Injectable')).toBe(false);

    const decoratorOf = (src: string) =>
      parse(src, { loc: true, jsx: false }).body[0].declaration
        ? parse(src, { loc: true, jsx: false }).body[0].declaration.decorators?.[0]
        : parse(src, { loc: true, jsx: false }).body[0].decorators?.[0];

    const dec = decoratorOf('@Scheduled("0 * * * *")\nclass X {}');
    expect(analyzer.resolveDecoratorName(dec, aliases)).toBe('Cron');
    expect(analyzer.isDecorator(dec, 'Cron', aliases)).toBe(true);
    expect(analyzer.isDecorator(dec, 'Interval', aliases)).toBe(false);
  });

  it('QUEUE: an aliased @Processor keeps its @Process handlers', async () => {
    write('src/queue.ts', [
      "import { Processor as Consumer, Process as Handles } from '@nestjs/bull';",
      '',
      "@Consumer('emails')",
      'export class EmailConsumer {',
      "  @Handles('send')",
      '  send() {}',
      '}',
    ]);

    const eps = await analyze();
    expect(eps.some(e => JSON.stringify(e).includes('send'))).toBe(true);
  });

  it('MICROSERVICE: aliased @MessagePattern/@EventPattern still emit', async () => {
    write('src/rpc.ts', [
      "import { Controller } from '@nestjs/common';",
      "import { MessagePattern as OnMessage, EventPattern as OnBroadcast } from '@nestjs/microservices';",
      '',
      '@Controller()',
      'export class RpcHandlers {',
      "  @OnMessage({ cmd: 'sum' })",
      '  sum() {}',
      '',
      "  @OnBroadcast('user.created')",
      '  userCreated() {}',
      '}',
    ]);

    const eps = await analyze();
    const text = JSON.stringify(eps);
    expect(text).toContain('sum');
    expect(text).toContain('user.created');
  });

  it('reports decorator names resolved, so a consumer matching on "Controller" finds an aliased one', async () => {
    write('src/api/things.controller.ts', [
      "import { Controller as Ctrl, Get } from '@nestjs/common';",
      "@Ctrl('things')",
      'export class ThingsEndpoint {',
      '  @Get()',
      '  list() {}',
      '}',
    ]);

    const http = (await analyze()).filter(e => e.type === 'http');
    expect(http.length).toBe(1);
    expect(http[0].trigger?.path).toBe('/things');
  });

  it('an UNALIASED import is unaffected', async () => {
    write('src/api/plain.controller.ts', [
      "import { Controller, Get } from '@nestjs/common';",
      "@Controller('plain')",
      'export class PlainEndpoint {',
      '  @Get()',
      '  list() {}',
      '}',
    ]);

    const http = (await analyze()).filter(e => e.type === 'http');
    expect(http.map(e => `${e.trigger?.method} ${e.trigger?.path}`)).toEqual(['GET /plain']);
  });
});
