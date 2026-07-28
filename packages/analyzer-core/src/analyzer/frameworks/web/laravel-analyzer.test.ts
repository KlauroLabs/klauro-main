import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import { LaravelAnalyzer } from './laravel-analyzer';

test('LaravelAnalyzer discovers routes in nested manifest-owned applications', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'laravel-monorepo-'));
  try {
    await fs.ensureDir(path.join(root, 'apps', 'orders', 'routes'));
    await fs.writeJson(path.join(root, 'apps', 'orders', 'composer.json'), {
      name: 'example/orders',
      require: { 'laravel/framework': '^11.0' },
    });
    await fs.writeFile(
      path.join(root, 'apps', 'orders', 'routes', 'web.php'),
      `<?php
use Illuminate\Support\Facades\Route;
Route::get('/orders/{id}', fn (string $id) => ['id' => $id]);
`,
    );

    const analyzer = new LaravelAnalyzer();
    assert.equal(await analyzer.canAnalyze(root), true);
    const contribution = await analyzer.analyze({ projectPath: root } as any);
    const route = contribution.entry_points.find(entry => entry.trigger?.path === '/orders/{id}');
    assert.ok(route);
    assert.equal(route.trigger?.method, 'GET');
  } finally {
    await fs.remove(root);
  }
});
