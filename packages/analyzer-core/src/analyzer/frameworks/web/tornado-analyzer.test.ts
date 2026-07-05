import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import { TornadoAnalyzer } from './tornado-analyzer';

async function makeFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tornado-analyzer-'));
  await fs.writeFile(path.join(root, 'requirements.txt'), 'tornado==6.4\n');
  await fs.writeFile(
    path.join(root, 'server.py'),
    `import tornado.web
import tornado.ioloop


class MainHandler(tornado.web.RequestHandler):
    def get(self):
        self.write({"status": "ok"})


class ItemsHandler(tornado.web.RequestHandler):
    def get(self):
        self.write({"items": []})

    def post(self):
        self.write({"created": True})


def make_app():
    return tornado.web.Application([
        (r"/health", MainHandler),
        (r"/items", ItemsHandler),
    ])


if __name__ == '__main__':
    app = make_app()
    app.listen(8888)
    tornado.ioloop.IOLoop.current().start()
`
  );
  return root;
}

test('TornadoAnalyzer.canAnalyze detects a tornado dependency + import', async () => {
  const root = await makeFixture();
  const analyzer = new TornadoAnalyzer();
  assert.equal(await analyzer.canAnalyze(root), true);
  await fs.remove(root);
});

test('TornadoAnalyzer.canAnalyze rejects a project without tornado', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tornado-analyzer-neg-'));
  await fs.writeFile(path.join(root, 'requirements.txt'), 'flask==3.0.0\n');
  const analyzer = new TornadoAnalyzer();
  assert.equal(await analyzer.canAnalyze(root), false);
  await fs.remove(root);
});

test('TornadoAnalyzer resolves route tuples to RequestHandler classes and per-verb methods', async () => {
  const root = await makeFixture();
  const analyzer = new TornadoAnalyzer();
  const contribution = await analyzer.analyze({ projectPath: root, filters: [] } as any);

  const routes = (contribution.entry_points || []).map(ep => ({
    method: ep.metadata?.method,
    path: ep.metadata?.path,
    handler: ep.metadata?.handler,
  }));

  assert.equal(routes.length, 3);
  assert.ok(routes.some(r => r.method === 'GET' && r.path === '/health' && r.handler === 'MainHandler'));
  assert.ok(routes.some(r => r.method === 'GET' && r.path === '/items' && r.handler === 'ItemsHandler'));
  assert.ok(routes.some(r => r.method === 'POST' && r.path === '/items' && r.handler === 'ItemsHandler'));

  const appNodes = (contribution.nodes || []).filter(n => n.type === 'application');
  assert.equal(appNodes.length, 1);

  const controllerNodes = (contribution.nodes || []).filter(n => n.type === 'controller');
  assert.equal(controllerNodes.length, 2);

  await fs.remove(root);
});

test('TornadoAnalyzer returns an empty-but-valid contribution when no routes are found', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tornado-analyzer-empty-'));
  await fs.writeFile(path.join(root, 'requirements.txt'), 'tornado==6.4\n');
  await fs.writeFile(path.join(root, 'app.py'), 'import tornado\n');
  const analyzer = new TornadoAnalyzer();
  const contribution = await analyzer.analyze({ projectPath: root, filters: [] } as any);
  assert.equal((contribution.entry_points || []).length, 0);
  await fs.remove(root);
});
