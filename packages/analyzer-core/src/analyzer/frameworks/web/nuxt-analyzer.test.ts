import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import { NuxtAnalyzer } from './nuxt-analyzer';

async function makeFixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nuxt-analyzer-'));

  await fs.writeJson(path.join(dir, 'package.json'), {
    name: 'nuxt-fixture',
    dependencies: { nuxt: '^3.10.0' }
  });
  await fs.writeFile(path.join(dir, 'nuxt.config.ts'),
    `export default defineNuxtConfig({ modules: ['@pinia/nuxt', '@nuxtjs/tailwindcss'] })\n`);

  await fs.ensureDir(path.join(dir, 'pages', 'users'));
  await fs.writeFile(path.join(dir, 'pages', 'index.vue'), `<template><div>Home</div></template>\n`);
  await fs.writeFile(path.join(dir, 'pages', 'users', '[id].vue'), `<template><div>User</div></template>\n`);

  await fs.ensureDir(path.join(dir, 'server', 'api'));
  await fs.writeFile(path.join(dir, 'server', 'api', 'health.get.ts'),
    `export default defineEventHandler(() => ({ status: 'ok' }))\n`);

  await fs.ensureDir(path.join(dir, 'components'));
  await fs.writeFile(path.join(dir, 'components', 'Card.vue'), `<template><div class="card"><slot /></div></template>\n`);

  await fs.ensureDir(path.join(dir, 'composables'));
  await fs.writeFile(path.join(dir, 'composables', 'useAuth.ts'),
    `export const useAuth = () => { const user = useState('user'); return { user }; }\n`);

  return dir;
}

test('canAnalyze: true for nuxt dep + nuxt.config.ts', async () => {
  const dir = await makeFixture();
  try {
    const analyzer = new NuxtAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true);
  } finally {
    await fs.remove(dir);
  }
});

test('canAnalyze: false for non-nuxt project', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nuxt-neg-'));
  try {
    await fs.writeJson(path.join(dir, 'package.json'), { name: 'plain', dependencies: { express: '^4' } });
    const analyzer = new NuxtAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), false);
  } finally {
    await fs.remove(dir);
  }
});

test('page routes including dynamic [id]', async () => {
  const dir = await makeFixture();
  try {
    const result = await new NuxtAnalyzer().analyze({ projectPath: dir });

    const pageEntries = result.entry_points.filter(ep => ep.type === 'page');
    const paths = pageEntries.map(ep => ep.trigger?.path);

    assert.ok(paths.includes('/'), `expected / route, got ${JSON.stringify(paths)}`);
    assert.ok(paths.includes('/users/:id'), `expected /users/:id dynamic route, got ${JSON.stringify(paths)}`);

    const dynamicEntry = pageEntries.find(ep => ep.trigger?.path === '/users/:id');
    assert.equal(dynamicEntry?.metadata?.dynamic, true);

    const pageNodes = result.nodes.filter(n => n.type === 'page');
    assert.equal(pageNodes.length, 2);
  } finally {
    await fs.remove(dir);
  }
});

test('server api/health GET entry point (Nitro)', async () => {
  const dir = await makeFixture();
  try {
    const result = await new NuxtAnalyzer().analyze({ projectPath: dir });

    const health = result.entry_points.find(ep =>
      ep.type === 'http' && ep.trigger?.path === '/api/health');
    assert.ok(health, `expected /api/health entry point, got ${JSON.stringify(result.entry_points.map(e => e.trigger?.path))}`);
    assert.equal(health?.trigger?.method, 'GET');

    const apiNode = result.nodes.find(n => n.type === 'api-route');
    assert.ok(apiNode, 'expected an api-route node');
  } finally {
    await fs.remove(dir);
  }
});

test('component + composable nodes', async () => {
  const dir = await makeFixture();
  try {
    const result = await new NuxtAnalyzer().analyze({ projectPath: dir });

    const component = result.nodes.find(n => n.type === 'component' && n.name === 'Card');
    assert.ok(component, `expected Card component node, got ${JSON.stringify(result.nodes.filter(n => n.type === 'component').map(n => n.name))}`);

    const composable = result.nodes.find(n => n.type === 'composable' && n.name === 'useAuth');
    assert.ok(composable, `expected useAuth composable node, got ${JSON.stringify(result.nodes.filter(n => n.type === 'composable').map(n => n.name))}`);
  } finally {
    await fs.remove(dir);
  }
});

test('capabilities advertised', async () => {
  const dir = await makeFixture();
  try {
    const result = await new NuxtAnalyzer().analyze({ projectPath: dir });
    const caps = result.analyzer_metadata.capabilities || [];
    for (const cap of ['nuxt-pages', 'nuxt-server-routes', 'nuxt-components', 'nuxt-composables']) {
      assert.ok(caps.includes(cap), `missing capability ${cap}`);
    }
  } finally {
    await fs.remove(dir);
  }
});

test('incremental: single-file analysis of a page', async () => {
  const dir = await makeFixture();
  try {
    const analyzer = new NuxtAnalyzer();
    assert.equal(analyzer.supportsIncrementalAnalysis(), true);

    const relevant = await analyzer.getRelevantFiles!(dir);
    assert.ok(relevant.includes('pages/users/[id].vue'),
      `expected dynamic page in relevant files, got ${JSON.stringify(relevant)}`);

    const rel = 'pages/users/[id].vue';
    const single = await analyzer.analyzeFileSingle!({
      projectPath: dir,
      filePath: path.join(dir, rel),
      relativePath: rel
    });

    assert.equal(single.filePath, rel);
    assert.ok(single.nodes.some(n => n.type === 'page'));
    assert.ok(single.entryPoints.some(ep => ep.trigger?.path === '/users/:id'));
  } finally {
    await fs.remove(dir);
  }
});
