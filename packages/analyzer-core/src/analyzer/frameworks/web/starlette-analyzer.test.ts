import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import { StarletteAnalyzer } from './starlette-analyzer';

async function makeFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'starlette-analyzer-'));
  await fs.writeFile(path.join(root, 'requirements.txt'), 'starlette==0.37.2\n');
  await fs.writeFile(
    path.join(root, 'server.py'),
    `from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route


async def health(request):
    return JSONResponse({"status": "ok"})


async def list_items(request):
    return JSONResponse({"items": []})


app = Starlette(routes=[
    Route('/health', health, methods=['GET']),
    Route('/items', list_items, methods=['GET']),
])


@app.route('/ping')
async def ping(request):
    return JSONResponse({"pong": True})
`
  );
  return root;
}

test('StarletteAnalyzer.canAnalyze detects a starlette dependency + import', async () => {
  const root = await makeFixture();
  const analyzer = new StarletteAnalyzer();
  assert.equal(await analyzer.canAnalyze(root), true);
  await fs.remove(root);
});

test('StarletteAnalyzer.canAnalyze rejects a project without starlette', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'starlette-analyzer-neg-'));
  await fs.writeFile(path.join(root, 'requirements.txt'), 'flask==3.0.0\n');
  const analyzer = new StarletteAnalyzer();
  assert.equal(await analyzer.canAnalyze(root), false);
  await fs.remove(root);
});

test('StarletteAnalyzer resolves routes= list entries and @app.route decorator to endpoint functions', async () => {
  const root = await makeFixture();
  const analyzer = new StarletteAnalyzer();
  const contribution = await analyzer.analyze({ projectPath: root, filters: [] } as any);

  const routes = (contribution.entry_points || []).map(ep => ({
    method: ep.metadata?.method,
    path: ep.metadata?.path,
    handler: ep.metadata?.handler,
  }));

  assert.equal(routes.length, 3);
  assert.ok(routes.some(r => r.method === 'GET' && r.path === '/health' && r.handler === 'health'));
  assert.ok(routes.some(r => r.method === 'GET' && r.path === '/items' && r.handler === 'list_items'));
  assert.ok(routes.some(r => r.method === 'GET' && r.path === '/ping' && r.handler === 'ping'));

  const appNodes = (contribution.nodes || []).filter(n => n.type === 'application');
  assert.equal(appNodes.length, 1);

  await fs.remove(root);
});

test('StarletteAnalyzer returns an empty-but-valid contribution when no routes are found', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'starlette-analyzer-empty-'));
  await fs.writeFile(path.join(root, 'requirements.txt'), 'starlette==0.37.2\n');
  await fs.writeFile(path.join(root, 'app.py'), 'import starlette\n');
  const analyzer = new StarletteAnalyzer();
  const contribution = await analyzer.analyze({ projectPath: root, filters: [] } as any);
  assert.equal((contribution.entry_points || []).length, 0);
  await fs.remove(root);
});
