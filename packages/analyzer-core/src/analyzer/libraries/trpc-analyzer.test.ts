import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { TRPCAnalyzer } from './trpc-analyzer';

async function makeProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trpc-analyzer-test-'));
  await fs.writeJson(path.join(dir, 'package.json'), {
    name: 'trpc-fixture',
    dependencies: { '@trpc/server': '^11.0.0', zod: '^3.0.0' }
  });

  const server = path.join(dir, 'src', 'server');
  await fs.ensureDir(server);

  await fs.writeFile(path.join(server, 'trpc.ts'), [
    "import { initTRPC, TRPCError } from '@trpc/server';",
    'const t = initTRPC.create();',
    'export const createTRPCRouter = t.router;',
    'export const publicProcedure = t.procedure;',
    'export const protectedProcedure = t.procedure.use(({ ctx, next }) => {',
    '  return next();',
    '});',
    '',
  ].join('\n'));

  await fs.writeFile(path.join(server, 'router.ts'), [
    "import { z } from 'zod';",
    "import { createTRPCRouter, publicProcedure, protectedProcedure } from './trpc';",
    '',
    'export const appRouter = createTRPCRouter({',
    '  getUser: publicProcedure',
    '    .input(z.object({ id: z.string() }))',
    '    .query(({ input }) => {',
    '      return { id: input.id };',
    '    }),',
    '  createUser: protectedProcedure',
    '    .input(z.object({ name: z.string(), email: z.string().email() }))',
    '    .mutation(({ input }) => {',
    '      return { name: input.name };',
    '    }),',
    '});',
    '',
    'export type AppRouter = typeof appRouter;',
    '',
  ].join('\n'));

  return dir;
}

test('TRPCAnalyzer extracts router, procedures, input contracts, and entry points', async () => {
  const dir = await makeProject();
  try {
    const analyzer = new TRPCAnalyzer();

    assert.equal(await analyzer.canAnalyze(dir), true, 'should detect tRPC');

    const result = await analyzer.analyze({ projectPath: dir });

    // appRouter node, tagged as the cross-repo contract surface.
    const routerNode = result.nodes.find(n => n.type === 'router' && n.name === 'appRouter');
    assert.ok(routerNode, 'appRouter router node exists');
    assert.equal(routerNode!.metadata?.isAppRouter, true);
    assert.equal(routerNode!.metadata?.contractSurface, true);

    // Procedure nodes.
    const procNodes = result.nodes.filter(n => n.type === 'PROCEDURE');
    const procNames = procNodes.map(n => n.name).sort();
    assert.deepEqual(procNames, ['createUser', 'getUser']);

    const getUser = procNodes.find(n => n.name === 'getUser')!;
    assert.equal(getUser.metadata?.kind, 'query');
    assert.ok(/z\.object/.test(getUser.metadata?.inputSchema || ''), 'getUser captures zod input contract');

    const createUser = procNodes.find(n => n.name === 'createUser')!;
    assert.equal(createUser.metadata?.kind, 'mutation');
    assert.equal(createUser.metadata?.authGated, true, 'protectedProcedure marked auth-gated');
    assert.ok(/email/.test(createUser.metadata?.inputSchema || ''), 'createUser captures zod input contract');

    // Both procedures are entry points.
    const epNames = result.entry_points.map(e => e.name).sort();
    assert.deepEqual(epNames, ['createUser', 'getUser']);
    const getUserEp = result.entry_points.find(e => e.name === 'getUser')!;
    assert.ok(getUserEp.input?.schema, 'entry point carries the input contract');
    const createUserEp = result.entry_points.find(e => e.name === 'createUser')!;
    assert.equal(createUserEp.security?.authenticated, true);
  } finally {
    await fs.remove(dir);
  }
});
