jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NestJSAnalyzer } from '../../analyzer/frameworks/web/nestjs-analyzer';

/**
 * Task #115: 34 analyzer files (this one among them) recorded
 * `node.source.file` as an ABSOLUTE path (`fullPath = path.join(projectPath,
 * file)`) instead of the repo-relative `file` that was already in scope at
 * every call site. That absolute path is customer-visible — it leaks the
 * analysis sandbox's local filesystem layout (temp dir, username) into any
 * node or entry point that relies on it, and resolves for no consumer.
 *
 * This is a regression test, not a fixture demo: run the NestJS analyzer
 * standalone (as many callers do — no orchestrator-level path sweep in the
 * way) and assert every `source.file` this analyzer emits is repo-relative.
 */
describe('NestJS analyzer records repo-relative source.file, never absolute', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-repo-relative-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'repo-relative-fixture',
      dependencies: {
        '@nestjs/core': '^10.0.0',
        '@nestjs/common': '^10.0.0',
        '@nestjs/websockets': '^10.0.0',
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

  it('never emits a node whose source.file is an absolute path', async () => {
    write('src/app.module.ts', [
      "import { Module } from '@nestjs/common';",
      '@Module({})',
      'export class AppModule {}',
    ]);
    write('src/users.controller.ts', [
      "import { Controller, Get } from '@nestjs/common';",
      "@Controller('users')",
      'export class UsersController {',
      '  @Get() findAll() {}',
      '}',
    ]);
    write('src/users.service.ts', [
      "import { Injectable } from '@nestjs/common';",
      '@Injectable()',
      'export class UsersService {',
      '  findAll() { return []; }',
      '}',
    ]);
    write('src/auth.guard.ts', [
      "import { Injectable, CanActivate } from '@nestjs/common';",
      '@Injectable()',
      'export class AuthGuard implements CanActivate {',
      '  canActivate() { return true; }',
      '}',
    ]);
    write('src/logger.middleware.ts', [
      "import { Injectable, NestMiddleware } from '@nestjs/common';",
      '@Injectable()',
      'export class LoggerMiddleware implements NestMiddleware {',
      '  use(req: any, res: any, next: any) { next(); }',
      '}',
    ]);
    write('src/chat.gateway.ts', [
      "import { WebSocketGateway, SubscribeMessage } from '@nestjs/websockets';",
      '@WebSocketGateway()',
      'export class ChatGateway {',
      "  @SubscribeMessage('ping')",
      '  handlePing() {}',
      '}',
    ]);
    write('src/main.ts', [
      "import { NestFactory } from '@nestjs/core';",
      "import { AppModule } from './app.module';",
      'async function bootstrap() {',
      '  const app = await NestFactory.create(AppModule);',
      '  await app.listen(3000);',
      '}',
      'bootstrap();',
    ]);

    const contribution: any = await new NestJSAnalyzer().analyze({ projectPath: root } as any);
    const nodes: any[] = contribution.nodes || [];
    const entryPoints: any[] = contribution.entry_points || [];

    expect(nodes.length).toBeGreaterThan(0);

    const absoluteNodes = nodes.filter(n => n.source?.file && path.isAbsolute(n.source.file));
    expect(absoluteNodes.map((n: any) => ({ id: n.id, file: n.source.file }))).toEqual([]);

    const absoluteHandlers = entryPoints.filter(e => e.handler?.file && path.isAbsolute(e.handler.file));
    expect(absoluteHandlers.map((e: any) => ({ id: e.id, file: e.handler.file }))).toEqual([]);

    // Positive check, not just absence: the module/controller/provider/
    // guard/middleware/gateway/bootstrap nodes this analyzer is responsible
    // for all carry the real repo-relative path, not an empty/dropped one.
    const byType = (type: string) => nodes.find(n => n.type === type);
    expect(byType('module')?.source?.file).toBe('src/app.module.ts');
    expect(byType('controller')?.source?.file).toBe('src/users.controller.ts');
    expect(byType('service')?.source?.file).toBe('src/users.service.ts');
    expect(byType('guard')?.source?.file).toBe('src/auth.guard.ts');
    expect(byType('middleware')?.source?.file).toBe('src/logger.middleware.ts');
    expect(byType('gateway')?.source?.file).toBe('src/chat.gateway.ts');
    expect(byType('bootstrap')?.source?.file).toBe('src/main.ts');
  });
});
