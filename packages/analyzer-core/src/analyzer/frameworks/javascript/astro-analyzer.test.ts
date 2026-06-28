import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { AstroAnalyzer } from './astro-analyzer';

async function makeProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astro-analyzer-test-'));

  await fs.writeJson(path.join(dir, 'package.json'), {
    name: 'astro-test',
    dependencies: { astro: '^4.0.0' },
  });

  const pages = path.join(dir, 'src', 'pages');
  const blog = path.join(pages, 'blog');
  const api = path.join(pages, 'api');
  const components = path.join(dir, 'src', 'components');
  await fs.ensureDir(blog);
  await fs.ensureDir(api);
  await fs.ensureDir(components);

  await fs.writeFile(path.join(pages, 'index.astro'), `---
import Card from '../components/Card.astro';
interface Props {
  title: string;
}
const { title } = Astro.props;
---
<html>
  <body>
    <h1>{title}</h1>
    <Card client:visible />
  </body>
</html>
`, 'utf-8');

  await fs.writeFile(path.join(blog, '[slug].astro'), `---
const { slug } = Astro.params;
---
<article>{slug}</article>
`, 'utf-8');

  await fs.writeFile(path.join(api, 'posts.ts'), `export function GET() {
  return new Response(JSON.stringify({ ok: true }));
}
`, 'utf-8');

  await fs.writeFile(path.join(components, 'Card.astro'), `---
interface Props {
  href: string;
}
const { href } = Astro.props;
---
<a href={href}><slot /></a>
`, 'utf-8');

  return dir;
}

test('AstroAnalyzer extracts components, pages/routes, endpoints and dynamic segments', async () => {
  const projectPath = await makeProject();
  try {
    const analyzer = new AstroAnalyzer();

    assert.strictEqual(await analyzer.canAnalyze(projectPath), true, 'canAnalyze should be true');

    const cas = await analyzer.analyze({ projectPath });
    const nodes = cas.nodes || [];
    const entryPoints = cas.entry_points || [];

    // Component nodes
    const components = nodes.filter(n => n.type === 'astro-component');
    assert.ok(components.length >= 3, `expected >=3 astro-component nodes, got ${components.length}`);
    assert.ok(components.some(n => n.name === 'Card'), 'Card component node should exist');
    assert.ok(components.some(n => n.name === 'index'), 'index component node should exist');

    // index page is a route + entry point
    const indexRoute = nodes.find(n => n.type === 'route' && n.name === '/');
    assert.ok(indexRoute, 'index page should produce a "/" route node');
    const indexEntry = entryPoints.find(ep => ep.type === 'page' && ep.trigger?.path === '/');
    assert.ok(indexEntry, 'index page should be an entry point');

    // [slug] dynamic route + entry point, dynamic segment captured
    const slugRoute = nodes.find(n => n.type === 'route' && n.name === '/blog/[slug]');
    assert.ok(slugRoute, 'blog/[slug] should produce a dynamic route node');
    assert.strictEqual(slugRoute!.metadata?.attributes?.dynamic, true, 'slug route should be marked dynamic');
    const slugEntry = entryPoints.find(ep => ep.type === 'page' && ep.trigger?.path === '/blog/[slug]');
    assert.ok(slugEntry, 'blog/[slug] should be an entry point');
    assert.strictEqual(slugEntry!.metadata?.dynamic, true, 'slug entry point should be marked dynamic');

    // /api/posts GET endpoint
    const apiEntry = entryPoints.find(ep => ep.type === 'http' && ep.trigger?.path === '/api/posts');
    assert.ok(apiEntry, 'api/posts should be an http entry point');
    assert.strictEqual(apiEntry!.trigger?.method, 'GET', 'api/posts should expose GET');

    // props captured on index
    const indexComponent = components.find(n => n.name === 'index');
    assert.ok(
      (indexComponent!.metadata?.attributes?.props || []).includes('title'),
      'index should capture the title prop'
    );
  } finally {
    await fs.remove(projectPath);
  }
});
