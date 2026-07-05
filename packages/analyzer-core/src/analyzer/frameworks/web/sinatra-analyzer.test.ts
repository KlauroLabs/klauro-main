import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import { SinatraAnalyzer } from './sinatra-analyzer';

async function makeFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sinatra-analyzer-'));

  await fs.writeFile(
    path.join(root, 'Gemfile'),
    `source 'https://rubygems.org'\ngem 'sinatra'\n`
  );

  await fs.writeFile(
    path.join(root, 'app.rb'),
    `require 'sinatra'

before do
  protected!
end

get '/' do
  'home'
end

get '/users/:id' do |id|
  "user #{id}"
end

post '/users' do
  status 201
end

namespace '/api' do
  get '/health' do
    'ok'
  end
end
`
  );

  return root;
}

test('SinatraAnalyzer canAnalyze detects sinatra Gemfile dependency', async () => {
  const root = await makeFixture();
  try {
    const analyzer = new SinatraAnalyzer();
    assert.strictEqual(await analyzer.canAnalyze(root), true);
  } finally {
    await fs.remove(root);
  }
});

test('SinatraAnalyzer canAnalyze is false without sinatra', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sinatra-analyzer-none-'));
  try {
    await fs.writeFile(path.join(root, 'Gemfile'), `source 'https://rubygems.org'\ngem 'rails'\n`);
    const analyzer = new SinatraAnalyzer();
    assert.strictEqual(await analyzer.canAnalyze(root), false);
  } finally {
    await fs.remove(root);
  }
});

test('SinatraAnalyzer extracts top-level and namespaced routes with before-filter guards', async () => {
  const root = await makeFixture();
  try {
    const analyzer = new SinatraAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: root } as any);

    const paths = contribution.entry_points
      .filter(ep => ep.type === 'http')
      .map(ep => `${ep.trigger?.method} ${ep.trigger?.path}`)
      .sort();
    assert.deepEqual(paths, ['GET /', 'GET /api/health', 'GET /users/:id', 'POST /users']);

    const health = contribution.entry_points.find(ep => ep.trigger?.path === '/api/health');
    assert.ok(health, 'namespaced route should carry the /api prefix');
    assert.strictEqual(health!.security?.authenticated, true);
    assert.deepEqual(health!.security?.guards, ['protected!']);
  } finally {
    await fs.remove(root);
  }
});

test('SinatraAnalyzer.extractRoutes handles nested namespace prefixing directly', () => {
  const analyzer = new SinatraAnalyzer();
  const routes = analyzer.extractRoutes(
    `require 'sinatra'

namespace '/api' do
  namespace '/v2' do
    get '/items' do
      'items'
    end
  end
end

get '/ping' do
  'pong'
end
`,
    'app.rb'
  );

  const byPath = new Map(routes.map(r => [r.path, r]));
  assert.ok(byPath.has('/api/v2/items'));
  assert.strictEqual(byPath.get('/api/v2/items')!.method, 'get');
  assert.ok(byPath.has('/ping'));
});
