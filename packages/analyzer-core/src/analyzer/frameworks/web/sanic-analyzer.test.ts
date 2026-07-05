import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import { SanicAnalyzer } from './sanic-analyzer';

async function makeFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sanic-analyzer-'));
  await fs.writeFile(path.join(root, 'requirements.txt'), 'sanic==23.12.1\n');
  await fs.writeFile(
    path.join(root, 'server.py'),
    `from sanic import Sanic
from sanic.blueprints import Blueprint
from sanic.response import json

app = Sanic("MyApp")
bp = Blueprint("orders", url_prefix="/orders")


@app.route('/health', methods=['GET'])
async def health(request):
    return json({"status": "ok"})


@app.get('/items')
async def list_items(request):
    return json({"items": []})


@bp.post('/')
async def create_order(request):
    return json({}, status=201)


async def cancel_order(request, order_id):
    return json({"cancelled": order_id})


app.add_route(cancel_order, '/orders/<order_id>/cancel', methods=['POST'])
app.blueprint(bp)
`
  );
  return root;
}

test('SanicAnalyzer.canAnalyze detects a sanic dependency + import', async () => {
  const root = await makeFixture();
  const analyzer = new SanicAnalyzer();
  assert.equal(await analyzer.canAnalyze(root), true);
  await fs.remove(root);
});

test('SanicAnalyzer.canAnalyze rejects a project without sanic', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sanic-analyzer-neg-'));
  await fs.writeFile(path.join(root, 'requirements.txt'), 'flask==3.0.0\n');
  const analyzer = new SanicAnalyzer();
  assert.equal(await analyzer.canAnalyze(root), false);
  await fs.remove(root);
});

test('SanicAnalyzer extracts app decorator routes, add_route, and Blueprint routes with prefix', async () => {
  const root = await makeFixture();
  const analyzer = new SanicAnalyzer();
  const contribution = await analyzer.analyze({ projectPath: root, filters: [] } as any);

  const routes = (contribution.entry_points || []).map(ep => ({
    method: ep.metadata?.method,
    path: ep.metadata?.path,
    handler: ep.metadata?.handler,
  }));

  assert.equal(routes.length, 4);
  assert.ok(routes.some(r => r.method === 'GET' && r.path === '/health' && r.handler === 'health'));
  assert.ok(routes.some(r => r.method === 'GET' && r.path === '/items' && r.handler === 'list_items'));
  assert.ok(routes.some(r => r.method === 'POST' && r.path === '/orders/' && r.handler === 'create_order'));
  assert.ok(routes.some(r => r.method === 'POST' && r.path === '/orders/<order_id>/cancel' && r.handler === 'cancel_order'));

  const blueprintNodes = (contribution.nodes || []).filter(n => n.type === 'module' && n.category === 'blueprint' as any);
  assert.ok((contribution.nodes || []).some(n => n.name === 'orders'));

  await fs.remove(root);
});

test('SanicAnalyzer returns an empty-but-valid contribution when no routes are found', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sanic-analyzer-empty-'));
  await fs.writeFile(path.join(root, 'requirements.txt'), 'sanic==23.12.1\n');
  await fs.writeFile(path.join(root, 'app.py'), 'import sanic\n');
  const analyzer = new SanicAnalyzer();
  const contribution = await analyzer.analyze({ projectPath: root, filters: [] } as any);
  assert.equal((contribution.entry_points || []).length, 0);
  await fs.remove(root);
});
