import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import { NodeHttpAnalyzer } from './node-http-analyzer';

async function makeIfChainFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'node-http-analyzer-ifchain-'));

  await fs.writeJson(path.join(root, 'package.json'), { name: 'node-http-fixture', dependencies: {} });

  await fs.writeFile(
    path.join(root, 'server.ts'),
    `import http from 'node:http';

const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200).end('ok');
    return;
  }

  if (request.method === 'POST' && request.url === '/auth/login') {
    handleLogin(request, response);
    return;
  }

  response.writeHead(404).end();
});

function handleLogin(request, response) {
  response.writeHead(200).end('{}');
}

server.listen(3000);
`
  );

  return root;
}

async function makeSwitchFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'node-http-analyzer-switch-'));
  await fs.writeJson(path.join(root, 'package.json'), { name: 'node-http-switch-fixture', dependencies: {} });

  await fs.writeFile(
    path.join(root, 'server.ts'),
    `import { createServer } from 'node:http';

const server = createServer((request, response) => {
  switch (request.url) {
    case '/health':
      response.end('ok');
      break;
    case '/status':
      response.end('status');
      break;
    default:
      response.writeHead(404).end();
  }
});

server.listen(4000);
`
  );

  return root;
}

async function makeDynamicFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'node-http-analyzer-dynamic-'));
  await fs.writeJson(path.join(root, 'package.json'), { name: 'node-http-dynamic-fixture', dependencies: {} });

  await fs.writeFile(
    path.join(root, 'server.ts'),
    `import http from 'node:http';
import { router } from './router';

const server = http.createServer(router);
server.listen(5000);
`
  );

  await fs.writeFile(
    path.join(root, 'router.ts'),
    `export function router(request, response) {
  const handler = lookupHandler(request.url);
  handler(request, response);
}

function lookupHandler(url) {
  return (req, res) => res.end('dynamic');
}
`
  );

  return root;
}

test('NodeHttpAnalyzer canAnalyze detects raw http.createServer usage', async () => {
  const root = await makeIfChainFixture();
  try {
    const analyzer = new NodeHttpAnalyzer();
    assert.strictEqual(await analyzer.canAnalyze(root), true);
  } finally {
    await fs.remove(root);
  }
});

test('NodeHttpAnalyzer canAnalyze is false without a createServer call', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'node-http-analyzer-none-'));
  try {
    await fs.writeJson(path.join(root, 'package.json'), { name: 'no-http', dependencies: { express: '^4.0.0' } });
    await fs.writeFile(
      path.join(root, 'index.ts'),
      `import express from 'express';
const app = express();
app.get('/x', (req, res) => res.send('ok'));
app.listen(3000);
`
    );
    const analyzer = new NodeHttpAnalyzer();
    assert.strictEqual(await analyzer.canAnalyze(root), false);
  } finally {
    await fs.remove(root);
  }
});

test('NodeHttpAnalyzer extracts statically-resolvable routes from an if-chain dispatch', async () => {
  const root = await makeIfChainFixture();
  try {
    const analyzer = new NodeHttpAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: root });

    const routeNodes = contribution.nodes.filter(n => n.type === 'route');
    assert.strictEqual(routeNodes.length, 2);

    const paths = contribution.entry_points.map(ep => `${ep.trigger?.method} ${ep.trigger?.path}`).sort();
    assert.deepEqual(paths, ['GET /health', 'POST /auth/login']);

    const login = contribution.entry_points.find(ep => ep.trigger?.path === '/auth/login');
    assert.ok(login, 'should emit an entry point for /auth/login');
    assert.strictEqual(login!.type, 'http');
    assert.strictEqual(login!.handler?.method_name, 'handleLogin');
    assert.strictEqual(login!.metadata?.resolution, 'static');
  } finally {
    await fs.remove(root);
  }
});

test('NodeHttpAnalyzer extracts routes from a switch(request.url) dispatch', async () => {
  const root = await makeSwitchFixture();
  try {
    const analyzer = new NodeHttpAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: root });

    const paths = contribution.entry_points.map(ep => ep.trigger?.path).sort();
    assert.deepEqual(paths, ['/health', '/status']);
  } finally {
    await fs.remove(root);
  }
});

test('NodeHttpAnalyzer falls back to a single handler entry point when dispatch is fully dynamic', async () => {
  const root = await makeDynamicFixture();
  try {
    const analyzer = new NodeHttpAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: root });

    // No routes should be fabricated — the dispatch table is fully dynamic.
    const routeNodes = contribution.nodes.filter(n => n.type === 'route');
    assert.strictEqual(routeNodes.length, 0);

    assert.strictEqual(contribution.entry_points.length, 1);
    const entry = contribution.entry_points[0];
    assert.strictEqual(entry.type, 'http');
    assert.strictEqual(entry.metadata?.resolution, 'dynamic-fallback');
    assert.strictEqual(entry.handler?.method_name, 'router');
    // No fabricated path/method on the honest fallback entry.
    assert.strictEqual(entry.trigger?.path, undefined);
  } finally {
    await fs.remove(root);
  }
});
