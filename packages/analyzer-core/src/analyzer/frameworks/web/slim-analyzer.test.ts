import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import { SlimAnalyzer } from './slim-analyzer';

async function makeSlimFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'slim-analyzer-'));

  await fs.writeJson(path.join(root, 'composer.json'), {
    name: 'example/slim-fixture',
    require: { 'slim/slim': '^4.11' }
  });

  await fs.ensureDir(path.join(root, 'public'));
  await fs.writeFile(
    path.join(root, 'public', 'index.php'),
    `<?php

use Slim\\Factory\\AppFactory;
use App\\Controller\\UserController;
use App\\Middleware\\AuthMiddleware;

$app = AppFactory::create();

$app->get('/users', [UserController::class, 'index']);
$app->post('/users', [UserController::class, 'create'])->add(new AuthMiddleware());

$app->group('/api', function ($group) {
    $group->get('/items', [UserController::class, 'items']);
    $group->group('/v2', function ($group) {
        $group->get('/items', [UserController::class, 'itemsV2']);
    });
});

$app->run();
`
  );

  return root;
}

async function makeCodeIgniterFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codeigniter-analyzer-'));

  await fs.writeJson(path.join(root, 'composer.json'), {
    name: 'example/ci-fixture',
    require: { 'codeigniter4/framework': '^4.4' }
  });

  await fs.ensureDir(path.join(root, 'app', 'Config'));
  await fs.writeFile(
    path.join(root, 'app', 'Config', 'Routes.php'),
    `<?php

$routes->get('/', 'Home::index');
$routes->get('users', 'UserController::index');

$routes->group('api', function ($routes) {
    $routes->get('items', 'ItemController::index');
});
`
  );

  return root;
}

test('SlimAnalyzer canAnalyze detects slim/slim composer dependency', async () => {
  const root = await makeSlimFixture();
  try {
    const analyzer = new SlimAnalyzer();
    assert.strictEqual(await analyzer.canAnalyze(root), true);
  } finally {
    await fs.remove(root);
  }
});

test('SlimAnalyzer canAnalyze detects codeigniter4/framework composer dependency', async () => {
  const root = await makeCodeIgniterFixture();
  try {
    const analyzer = new SlimAnalyzer();
    assert.strictEqual(await analyzer.canAnalyze(root), true);
  } finally {
    await fs.remove(root);
  }
});

test('SlimAnalyzer canAnalyze is false without slim or codeigniter', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'slim-analyzer-none-'));
  try {
    await fs.writeJson(path.join(root, 'composer.json'), { name: 'x', require: { 'laravel/framework': '^10.0' } });
    const analyzer = new SlimAnalyzer();
    assert.strictEqual(await analyzer.canAnalyze(root), false);
  } finally {
    await fs.remove(root);
  }
});

test('SlimAnalyzer extracts routes with nested group prefixing and chained middleware', async () => {
  const root = await makeSlimFixture();
  try {
    const analyzer = new SlimAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: root } as any);

    const paths = contribution.entry_points
      .filter(ep => ep.type === 'http')
      .map(ep => `${ep.trigger?.method} ${ep.trigger?.path}`)
      .sort();
    assert.deepEqual(paths, ['GET /api/items', 'GET /api/v2/items', 'GET /users', 'POST /users']);

    const create = contribution.entry_points.find(ep => ep.trigger?.method === 'POST' && ep.trigger?.path === '/users');
    assert.ok(create);
    assert.strictEqual(create!.security?.authenticated, true);
    assert.deepEqual(create!.security?.guards, ['AuthMiddleware']);
    assert.strictEqual(create!.metadata?.handler, 'UserController::create');

    const v2 = contribution.entry_points.find(ep => ep.trigger?.path === '/api/v2/items');
    assert.ok(v2, 'nested group prefix should compose to /api/v2/items, not /api/items');
    assert.strictEqual(v2!.metadata?.handler, 'UserController::itemsV2');
  } finally {
    await fs.remove(root);
  }
});

test('SlimAnalyzer extracts CodeIgniter routes with group prefixing', async () => {
  const root = await makeCodeIgniterFixture();
  try {
    const analyzer = new SlimAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: root } as any);

    const paths = contribution.entry_points
      .filter(ep => ep.type === 'http')
      .map(ep => `${ep.trigger?.method} ${ep.trigger?.path}`)
      .sort();
    assert.deepEqual(paths, ['GET /', 'GET /api/items', 'GET /users']);
  } finally {
    await fs.remove(root);
  }
});
