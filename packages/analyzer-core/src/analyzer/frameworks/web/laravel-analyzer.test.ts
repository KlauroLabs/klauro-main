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

test('LaravelAnalyzer resolves Eloquent relation edges to analyzed model nodes and omits unresolved targets', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'laravel-eloquent-relations-'));
  try {
    await fs.ensureDir(path.join(root, 'app', 'Models'));
    await fs.writeJson(path.join(root, 'composer.json'), {
      name: 'example/relations',
      require: { 'laravel/framework': '^11.0' },
    });
    await fs.writeFile(path.join(root, 'app', 'Models', 'User.php'), `<?php
namespace App\\Models;
use Illuminate\\Database\\Eloquent\\Model;
class User extends Model {
  public function posts() { return $this->hasMany(Post::class); }
}`);
    await fs.writeFile(path.join(root, 'app', 'Models', 'Post.php'), `<?php
namespace App\\Models;
use Illuminate\\Database\\Eloquent\\Model;
class Post extends Model {
  public function user() { return $this->belongsTo(\\App\\Models\\User::class); }
  public function externalOwner() { return $this->belongsTo(ExternalOwner::class); }
}`);

    const contribution = await new LaravelAnalyzer().analyze({ projectPath: root } as any);
    const modelNodes = contribution.nodes.filter(node => node.type === 'laravel_model');
    const user = modelNodes.find(node => node.name === 'User');
    const post = modelNodes.find(node => node.name === 'Post');
    assert.ok(user);
    assert.ok(post);
    const relations = contribution.edges.filter(edge => edge.type === 'relates_to');
    assert.ok(relations.some(edge => edge.source === user.id && edge.target === post.id));
    assert.ok(relations.some(edge => edge.source === post.id && edge.target === user.id));
    const nodeIds = new Set(contribution.nodes.map(node => node.id));
    assert.equal(relations.every(edge => nodeIds.has(edge.source) && nodeIds.has(edge.target)), true);
    assert.equal(relations.some(edge => edge.target.includes('ExternalOwner')), false);
    assert.ok(contribution.nodes.some(node =>
      node.type === 'eloquent_relation' && node.metadata?.attributes?.related_model === 'ExternalOwner'));
  } finally {
    await fs.remove(root);
  }
});
