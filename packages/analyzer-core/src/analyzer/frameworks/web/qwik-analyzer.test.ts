import { test } from 'node:test';
import assert from 'node:assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import { QwikAnalyzer } from './qwik-analyzer';

async function makeProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwik-analyzer-'));

  await fs.writeJson(path.join(root, 'package.json'), {
    name: 'qwik-fixture',
    dependencies: {
      '@builder.io/qwik': '^1.5.0',
      '@builder.io/qwik-city': '^1.5.0',
    },
  });

  await fs.ensureDir(path.join(root, 'src', 'routes', 'users', '[id]'));

  // src/routes/index.tsx — index route with component$, routeLoader$, routeAction$
  await fs.writeFile(
    path.join(root, 'src', 'routes', 'index.tsx'),
    `import { component$ } from '@builder.io/qwik';
import { routeLoader$, routeAction$ } from '@builder.io/qwik-city';

export const useGreeting = routeLoader$(async () => {
  return { hello: 'world' };
});

export const useAddUser = routeAction$(async (data) => {
  return { ok: true };
});

export default component$(() => {
  const greeting = useGreeting();
  return <h1>{greeting.value.hello}</h1>;
});
`
  );

  // src/routes/users/[id]/index.tsx — dynamic route
  await fs.writeFile(
    path.join(root, 'src', 'routes', 'users', '[id]', 'index.tsx'),
    `import { component$ } from '@builder.io/qwik';
import { routeLoader$ } from '@builder.io/qwik-city';

export const useUser = routeLoader$(async ({ params }) => {
  return { id: params.id };
});

export default component$(() => {
  const user = useUser();
  return <div>{user.value.id}</div>;
});
`
  );

  return root;
}

test('QwikAnalyzer canAnalyze detects @builder.io/qwik deps', async () => {
  const root = await makeProject();
  try {
    const analyzer = new QwikAnalyzer();
    assert.strictEqual(await analyzer.canAnalyze(root), true);
  } finally {
    await fs.remove(root);
  }
});

test('QwikAnalyzer extracts routes (incl dynamic), loader/action entry points, and qwik components', async () => {
  const root = await makeProject();
  try {
    const analyzer = new QwikAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: root });

    const routeNodes = contribution.nodes.filter(n => n.type === 'route' || n.type === 'page');
    const routePaths = routeNodes.map(n => n.metadata?.attributes?.routePath);

    // Index route -> '/'
    assert.ok(
      routePaths.includes('/'),
      `expected '/' in ${JSON.stringify(routePaths)}`
    );

    // Dynamic segment captured: /users/:id
    assert.ok(
      routePaths.includes('/users/:id'),
      `expected /users/:id in ${JSON.stringify(routePaths)}`
    );

    // routeLoader$ entry point for /users/:id
    const loaderEntry = contribution.entry_points.find(
      ep => ep.metadata?.kind === 'loader' && ep.trigger?.path === '/users/:id'
    );
    assert.ok(loaderEntry, 'loader should be an entry point for /users/:id');
    assert.strictEqual(loaderEntry!.trigger?.method, 'GET');

    // routeAction$ entry point for /
    const actionEntry = contribution.entry_points.find(
      ep => ep.metadata?.kind === 'action' && ep.trigger?.path === '/'
    );
    assert.ok(actionEntry, 'action should be an entry point for /');
    assert.strictEqual(actionEntry!.trigger?.method, 'POST');

    // Qwik component node.
    const componentNode = contribution.nodes.find(
      n => n.type === 'component' && n.metadata?.attributes?.tag === 'qwik-component'
    );
    assert.ok(componentNode, 'should detect a qwik-component');
  } finally {
    await fs.remove(root);
  }
});

test('QwikAnalyzer supports incremental single-file analysis', async () => {
  const root = await makeProject();
  try {
    const analyzer = new QwikAnalyzer();
    assert.strictEqual(analyzer.supportsIncrementalAnalysis(), true);

    const relevant = await analyzer.getRelevantFiles(root);
    assert.ok(relevant.includes('src/routes/users/[id]/index.tsx'));

    const rel = 'src/routes/users/[id]/index.tsx';
    const result = await analyzer.analyzeFileSingle({
      projectPath: root,
      filePath: path.join(root, rel),
      relativePath: rel,
    });

    const loaderEntry = result.entryPoints.find(ep => ep.metadata?.kind === 'loader');
    assert.ok(loaderEntry, 'single-file analysis emits loader entry point');
    assert.ok(result.nodes.some(n => n.metadata?.attributes?.routePath === '/users/:id'));
    assert.ok(result.nodes.some(n => n.metadata?.attributes?.tag === 'qwik-component'));
  } finally {
    await fs.remove(root);
  }
});
