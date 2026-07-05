import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import { AiohttpAnalyzer } from './aiohttp-analyzer';

async function makeFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiohttp-analyzer-'));
  await fs.writeFile(path.join(root, 'requirements.txt'), 'aiohttp==3.9.5\n');
  await fs.writeFile(
    path.join(root, 'server.py'),
    `from aiohttp import web

routes = web.RouteTableDef()


@routes.get('/health')
async def health(request):
    return web.json_response({"status": "ok"})


@routes.post('/items')
async def create_item(request):
    return web.json_response({}, status=201)


async def get_users(request):
    return web.json_response({"users": []})


def create_app() -> web.Application:
    app = web.Application()
    app.add_routes(routes)
    app.router.add_get('/users', get_users)
    return app
`
  );
  return root;
}

test('AiohttpAnalyzer.canAnalyze detects an aiohttp dependency + import', async () => {
  const root = await makeFixture();
  const analyzer = new AiohttpAnalyzer();
  assert.equal(await analyzer.canAnalyze(root), true);
  await fs.remove(root);
});

test('AiohttpAnalyzer.canAnalyze rejects a project without aiohttp', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiohttp-analyzer-neg-'));
  await fs.writeFile(path.join(root, 'requirements.txt'), 'flask==3.0.0\n');
  await fs.writeFile(path.join(root, 'app.py'), 'x = 1\n');
  const analyzer = new AiohttpAnalyzer();
  assert.equal(await analyzer.canAnalyze(root), false);
  await fs.remove(root);
});

test('AiohttpAnalyzer extracts RouteTableDef decorator routes and app.router.add_* routes', async () => {
  const root = await makeFixture();
  const analyzer = new AiohttpAnalyzer();
  const contribution = await analyzer.analyze({ projectPath: root, filters: [] } as any);

  const routes = (contribution.entry_points || []).map(ep => ({
    method: ep.metadata?.method,
    path: ep.metadata?.path,
    handler: ep.metadata?.handler,
  }));

  assert.equal(routes.length, 3);
  assert.ok(routes.some(r => r.method === 'GET' && r.path === '/health' && r.handler === 'health'));
  assert.ok(routes.some(r => r.method === 'POST' && r.path === '/items' && r.handler === 'create_item'));
  assert.ok(routes.some(r => r.method === 'GET' && r.path === '/users' && r.handler === 'get_users'));

  const appNodes = (contribution.nodes || []).filter(n => n.type === 'application');
  assert.equal(appNodes.length, 1);

  await fs.remove(root);
});

test('AiohttpAnalyzer returns an empty-but-valid contribution when no routes are found', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiohttp-analyzer-empty-'));
  await fs.writeFile(path.join(root, 'requirements.txt'), 'aiohttp==3.9.5\n');
  await fs.writeFile(path.join(root, 'app.py'), 'import aiohttp\n');
  const analyzer = new AiohttpAnalyzer();
  const contribution = await analyzer.analyze({ projectPath: root, filters: [] } as any);
  assert.equal((contribution.entry_points || []).length, 0);
  await fs.remove(root);
});
