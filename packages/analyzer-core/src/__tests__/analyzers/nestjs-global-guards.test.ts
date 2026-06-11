jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NestJSAnalyzer } from '../../analyzer/frameworks/web/nestjs-analyzer';

describe('NestJS globally registered guard detection', () => {
  let root: string;
  const analyzer = () => new NestJSAnalyzer() as any;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-global-guards-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const write = (relative: string, content: string) => {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  it('detects APP_GUARD providers with useClass and useExisting and scopes them to apps', async () => {
    write('libs/auth/src/auth.module.ts', [
      "import { APP_GUARD } from '@nestjs/core';",
      '@Module({',
      '  providers: [',
      '    {',
      '      provide: APP_GUARD,',
      '      useClass: GlobalAuthGuard,',
      '    },',
      '  ],',
      '})',
      'export class AuthModule {}',
    ].join('\n'));
    write('apps/internal-api/src/app/auth/internal-auth.module.ts', [
      "import { APP_GUARD } from '@nestjs/core';",
      '@Module({',
      '  providers: [',
      '    InternalAuthGuard,',
      '    {',
      '      provide: APP_GUARD,',
      '      useExisting: InternalAuthGuard,',
      '    },',
      '  ],',
      '})',
      'export class InternalAuthModule {}',
    ].join('\n'));

    const files = ['libs/auth/src/auth.module.ts', 'apps/internal-api/src/app/auth/internal-auth.module.ts'];
    const registrations = await analyzer().detectGlobalGuardRegistrations(files, root);

    expect(registrations).toEqual(expect.arrayContaining([
      { guardName: 'GlobalAuthGuard', file: 'libs/auth/src/auth.module.ts', appScope: null },
      { guardName: 'InternalAuthGuard', file: 'apps/internal-api/src/app/auth/internal-auth.module.ts', appScope: 'apps/internal-api/' },
    ]));
  });

  it('detects app.useGlobalGuards calls in bootstrap files', async () => {
    write('src/main.ts', [
      'async function bootstrap() {',
      '  const app = await NestFactory.create(AppModule);',
      '  app.useGlobalGuards(new JwtAuthGuard(reflector));',
      '  await app.listen(3000);',
      '}',
    ].join('\n'));

    const registrations = await analyzer().detectGlobalGuardRegistrations(['src/main.ts'], root);
    expect(registrations).toEqual([
      { guardName: 'JwtAuthGuard', file: 'src/main.ts', appScope: null },
    ]);
  });

  it('marks routes authenticated through global guards and honors anonymous opt-outs', async () => {
    write('apps/admin-api/src/app/access/access.controller.ts', [
      "@Controller('access')",
      'export class AccessController {',
      "  @Put(':id/policies')",
      '  addPolicies(@Param() id: string) {}',
      '',
      '  @AllowAnonymous()',
      "  @Get('health')",
      '  health() {}',
      '}',
    ].join('\n'));

    const nest = analyzer();
    const entryPoints: any[] = [];
    const globalGuards = [
      { guardName: 'GlobalAuthGuard', file: 'libs/auth/src/auth.module.ts', appScope: null },
      { guardName: 'OtherAppGuard', file: 'apps/user-api/src/main.ts', appScope: 'apps/user-api/' },
    ];
    await nest.analyzeControllers(
      ['apps/admin-api/src/app/access/access.controller.ts'],
      root, [], [], entryPoints, [], [], globalGuards
    );

    const guarded = entryPoints.find(entry => entry.name.startsWith('PUT'));
    const anonymous = entryPoints.find(entry => entry.name.includes('health'));
    expect(guarded.security.authenticated).toBe(true);
    expect(guarded.security.guards).toContain('GlobalAuthGuard');
    expect(guarded.security.guards).not.toContain('OtherAppGuard');
    expect(guarded.metadata.guards).toContain('GlobalAuthGuard');
    expect(guarded.metadata.guards).not.toContain('OtherAppGuard');
    expect(anonymous.security.authenticated).toBe(false);
    expect(anonymous.security.guards).not.toContain('GlobalAuthGuard');
    expect(anonymous.metadata.guards).not.toContain('GlobalAuthGuard');
  });

  it('leaves routes unguarded when no global guard registration exists', async () => {
    write('src/users/users.controller.ts', [
      "@Controller('users')",
      'export class UsersController {',
      '  @Get()',
      '  list() {}',
      '}',
    ].join('\n'));

    const entryPoints: any[] = [];
    await analyzer().analyzeControllers(['src/users/users.controller.ts'], root, [], [], entryPoints, [], []);
    expect(entryPoints[0].security.authenticated).toBe(false);
    expect(entryPoints[0].security.guards).toEqual([]);
  });
});
