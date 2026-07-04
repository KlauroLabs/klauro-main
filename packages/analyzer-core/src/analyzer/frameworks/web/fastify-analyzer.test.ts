import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import { FastifyAnalyzer } from './fastify-analyzer';

async function makeSimpleFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fastify-analyzer-'));

  await fs.writeJson(path.join(root, 'package.json'), {
    name: 'fastify-fixture',
    dependencies: { fastify: '^4.24.3' },
  });

  await fs.writeFile(
    path.join(root, 'index.ts'),
    `import Fastify from 'fastify'
const server = Fastify()
function handler(request, reply) {
  reply.send({ ok: true })
}
server.get('/x', handler)
server.listen({ port: 3000 })
`
  );

  return root;
}

async function makePluginFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fastify-plugin-analyzer-'));

  await fs.writeJson(path.join(root, 'package.json'), {
    name: 'fastify-plugin-fixture',
    dependencies: { fastify: '^4.24.3', '@fastify/jwt': '^6.7.1' },
  });

  // The main app registers a "sync" wrapper plugin declared IN THE SAME FILE
  // (never exported) — mirrors the real finance-context-ts ext-web-api shape.
  await fs.writeFile(
    path.join(root, 'index.ts'),
    `import Fastify from 'fastify'
import { tradeRoutes } from './trades'

const server = Fastify()

const apiRoutes = async (fastify, options, done) => {
  await fastify.register(tradeRoutes, { prefix: 'trades' })
  done()
}

server.register(apiRoutes, { prefix: 'sync' })
server.listen({ port: 3000 })
`
  );

  await fs.ensureDir(path.join(root, 'trades'));
  await fs.writeFile(
    path.join(root, 'trades', 'index.ts'),
    `import { FastifyPluginCallback } from 'fastify'
import { previewFeeRoute } from './preview-fee-route'

export const tradeRoutes: FastifyPluginCallback = async (fastify, options, done) => {
  await fastify.register(previewFeeRoute)
  done()
}
`
  );

  await fs.writeFile(
    path.join(root, 'trades', 'preview-fee-route.ts'),
    `import { FastifyPluginCallback } from 'fastify'

export const previewFeeRoute: FastifyPluginCallback = (fastify, options, done) => {
  fastify.get<{ Reply: { fee: number } }>(
    '/preview-fee/v1',
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      return { fee: 0 }
    }
  )
  done()
}
`
  );

  return root;
}

test('FastifyAnalyzer canAnalyze detects fastify dependency', async () => {
  const root = await makeSimpleFixture();
  try {
    const analyzer = new FastifyAnalyzer();
    assert.strictEqual(await analyzer.canAnalyze(root), true);
  } finally {
    await fs.remove(root);
  }
});

test('FastifyAnalyzer canAnalyze is false without fastify dependency', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fastify-analyzer-none-'));
  try {
    await fs.writeJson(path.join(root, 'package.json'), { name: 'no-fastify', dependencies: { express: '^4.0.0' } });
    const analyzer = new FastifyAnalyzer();
    assert.strictEqual(await analyzer.canAnalyze(root), false);
  } finally {
    await fs.remove(root);
  }
});

test('FastifyAnalyzer extracts a simple route as an http entry point', async () => {
  const root = await makeSimpleFixture();
  try {
    const analyzer = new FastifyAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: root });

    const routeNodes = contribution.nodes.filter(n => n.type === 'route');
    assert.strictEqual(routeNodes.length, 1);
    assert.strictEqual(routeNodes[0].metadata?.attributes?.path, '/x');

    const entry = contribution.entry_points.find(ep => ep.type === 'http');
    assert.ok(entry, 'should emit an http entry point');
    assert.strictEqual(entry!.trigger?.method, 'GET');
    assert.strictEqual(entry!.trigger?.path, '/x');
    assert.strictEqual(entry!.handler?.method_name, 'handler');
  } finally {
    await fs.remove(root);
  }
});

test('FastifyAnalyzer resolves nested plugin prefixes (register chain + same-file wrapper)', async () => {
  const root = await makePluginFixture();
  try {
    const analyzer = new FastifyAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: root });

    const entry = contribution.entry_points.find(ep => ep.type === 'http');
    assert.ok(entry, 'should emit an http entry point for the nested route');
    // sync (same-file wrapper) + trades (cross-file register) + /preview-fee/v1 (leaf route)
    assert.strictEqual(entry!.trigger?.path, '/sync/trades/preview-fee/v1');
    assert.strictEqual(entry!.trigger?.method, 'GET');
    assert.strictEqual(entry!.security?.authenticated, true);
    assert.ok(entry!.security?.guards?.includes('fastify.authenticate'));
  } finally {
    await fs.remove(root);
  }
});
