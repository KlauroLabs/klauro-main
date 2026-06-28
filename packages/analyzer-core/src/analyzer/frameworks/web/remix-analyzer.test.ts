import { test } from 'node:test';
import assert from 'node:assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import { RemixAnalyzer } from './remix-analyzer';

async function makeProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remix-analyzer-'));

  await fs.writeJson(path.join(root, 'package.json'), {
    name: 'remix-fixture',
    dependencies: {
      '@remix-run/react': '^2.0.0',
      '@remix-run/node': '^2.0.0',
    },
  });

  await fs.ensureDir(path.join(root, 'app', 'routes'));

  // app/root.tsx
  await fs.writeFile(
    path.join(root, 'app', 'root.tsx'),
    `import { Outlet } from '@remix-run/react';
export default function App() {
  return <Outlet />;
}
export function ErrorBoundary() {
  return <div>error</div>;
}
`
  );

  // app/routes/_index.tsx — the index route
  await fs.writeFile(
    path.join(root, 'app', 'routes', '_index.tsx'),
    `export default function Index() {
  return <h1>Home</h1>;
}
`
  );

  // app/routes/users.$id.tsx — /users/:id with loader + action
  await fs.writeFile(
    path.join(root, 'app', 'routes', 'users.$id.tsx'),
    `import { useLoaderData } from '@remix-run/react';

export async function loader({ params }) {
  return { id: params.id };
}

export async function action({ request }) {
  return { ok: true };
}

export default function UserRoute() {
  const data = useLoaderData();
  return <div>{data.id}</div>;
}
`
  );

  return root;
}

test('RemixAnalyzer canAnalyze detects @remix-run deps', async () => {
  const root = await makeProject();
  try {
    const analyzer = new RemixAnalyzer();
    assert.strictEqual(await analyzer.canAnalyze(root), true);
  } finally {
    await fs.remove(root);
  }
});

test('RemixAnalyzer extracts index route, dynamic route, loader + action entry points', async () => {
  const root = await makeProject();
  try {
    const analyzer = new RemixAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: root });

    const routeNodes = contribution.nodes.filter(n => n.type === 'route' || n.type === 'page');
    const routePaths = routeNodes.map(n => n.metadata?.attributes?.routePath);

    // Index route -> '/'
    const indexNode = routeNodes.find(n => n.metadata?.attributes?.isIndex === true);
    assert.ok(indexNode, 'should detect the _index route');
    assert.strictEqual(indexNode!.metadata?.attributes?.routePath, '/');

    // Dynamic segment captured: /users/:id
    assert.ok(
      routePaths.includes('/users/:id'),
      `expected /users/:id in ${JSON.stringify(routePaths)}`
    );

    // Loader entry point for /users/:id
    const loaderEntry = contribution.entry_points.find(
      ep => ep.metadata?.kind === 'loader' && ep.trigger?.path === '/users/:id'
    );
    assert.ok(loaderEntry, 'loader should be an entry point for /users/:id');
    assert.strictEqual(loaderEntry!.trigger?.method, 'GET');

    // Action entry point for /users/:id
    const actionEntry = contribution.entry_points.find(
      ep => ep.metadata?.kind === 'action' && ep.trigger?.path === '/users/:id'
    );
    assert.ok(actionEntry, 'action should be an entry point for /users/:id');
    assert.strictEqual(actionEntry!.trigger?.method, 'POST');
  } finally {
    await fs.remove(root);
  }
});

test('RemixAnalyzer supports incremental single-file analysis', async () => {
  const root = await makeProject();
  try {
    const analyzer = new RemixAnalyzer();
    assert.strictEqual(analyzer.supportsIncrementalAnalysis(), true);

    const relevant = await analyzer.getRelevantFiles(root);
    assert.ok(relevant.includes('app/routes/users.$id.tsx'));

    const rel = 'app/routes/users.$id.tsx';
    const result = await analyzer.analyzeFileSingle({
      projectPath: root,
      filePath: path.join(root, rel),
      relativePath: rel,
    });

    const loaderEntry = result.entryPoints.find(ep => ep.metadata?.kind === 'loader');
    const actionEntry = result.entryPoints.find(ep => ep.metadata?.kind === 'action');
    assert.ok(loaderEntry, 'single-file analysis emits loader entry point');
    assert.ok(actionEntry, 'single-file analysis emits action entry point');
    assert.ok(result.nodes.some(n => n.metadata?.attributes?.routePath === '/users/:id'));
  } finally {
    await fs.remove(root);
  }
});
