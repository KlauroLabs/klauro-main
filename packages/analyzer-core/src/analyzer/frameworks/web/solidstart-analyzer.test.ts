import { test } from 'node:test';
import assert from 'node:assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import { SolidStartAnalyzer } from './solidstart-analyzer';

async function makeProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'solidstart-analyzer-'));

  await fs.writeJson(path.join(root, 'package.json'), {
    name: 'solidstart-fixture',
    dependencies: {
      '@solidjs/start': '^1.0.0',
      'solid-js': '^1.8.0',
    },
  });

  await fs.ensureDir(path.join(root, 'src', 'routes', 'users'));
  await fs.ensureDir(path.join(root, 'src', 'components'));

  // src/routes/index.tsx — index route
  await fs.writeFile(
    path.join(root, 'src', 'routes', 'index.tsx'),
    `export default function Home() {
  return <h1>Home</h1>;
}
`
  );

  // src/routes/users/[id].tsx — dynamic route with server data
  await fs.writeFile(
    path.join(root, 'src', 'routes', 'users', '[id].tsx'),
    `import { createServerData$ } from 'solid-start/server';
import { cache } from '@solidjs/router';

const getUser = cache(async (id: string) => {
  return { id };
}, 'user');

export function routeData({ params }) {
  return createServerData$(([, id]) => getUser(id), { key: () => ['user', params.id] });
}

export default function UserRoute() {
  return <div>user</div>;
}
`
  );

  // src/components/Card.tsx — Solid component with a signal
  await fs.writeFile(
    path.join(root, 'src', 'components', 'Card.tsx'),
    `import { createSignal } from 'solid-js';

export function Card(props) {
  const [count, setCount] = createSignal(0);
  return <div onClick={() => setCount(count() + 1)}>{count()}</div>;
}
`
  );

  return root;
}

test('SolidStartAnalyzer canAnalyze detects @solidjs/start deps', async () => {
  const root = await makeProject();
  try {
    const analyzer = new SolidStartAnalyzer();
    assert.strictEqual(await analyzer.canAnalyze(root), true);
  } finally {
    await fs.remove(root);
  }
});

test('SolidStartAnalyzer extracts routes (incl dynamic), a server fn, and a component', async () => {
  const root = await makeProject();
  try {
    const analyzer = new SolidStartAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: root });

    const routeNodes = contribution.nodes.filter(n => n.type === 'route' || n.type === 'page');
    const routePaths = routeNodes.map(n => n.metadata?.attributes?.routePath);

    // Index route -> '/'
    const indexNode = routeNodes.find(n => n.metadata?.attributes?.isIndex === true);
    assert.ok(indexNode, 'should detect the index route');
    assert.strictEqual(indexNode!.metadata?.attributes?.routePath, '/');

    // Dynamic segment captured: /users/:id
    assert.ok(
      routePaths.includes('/users/:id'),
      `expected /users/:id in ${JSON.stringify(routePaths)}`
    );

    // Server data function entry point for /users/:id (cache / createServerData$).
    const serverEntry = contribution.entry_points.find(
      ep => ep.metadata?.kind === 'server-data' && ep.trigger?.path === '/users/:id'
    );
    assert.ok(serverEntry, 'server data fn should be an entry point for /users/:id');

    // Component node for Card.
    const componentNode = contribution.nodes.find(
      n => n.type === 'component' && n.name === 'Card'
    );
    assert.ok(componentNode, 'should detect the Card component');
    assert.strictEqual(componentNode!.metadata?.attributes?.tag, 'solid-component');
  } finally {
    await fs.remove(root);
  }
});

test('SolidStartAnalyzer supports incremental single-file analysis', async () => {
  const root = await makeProject();
  try {
    const analyzer = new SolidStartAnalyzer();
    assert.strictEqual(analyzer.supportsIncrementalAnalysis(), true);

    const relevant = await analyzer.getRelevantFiles(root);
    assert.ok(relevant.includes('src/routes/users/[id].tsx'));

    const rel = 'src/routes/users/[id].tsx';
    const result = await analyzer.analyzeFileSingle({
      projectPath: root,
      filePath: path.join(root, rel),
      relativePath: rel,
    });

    const serverEntry = result.entryPoints.find(ep => ep.metadata?.kind === 'server-data');
    assert.ok(serverEntry, 'single-file analysis emits server data entry point');
    assert.ok(result.nodes.some(n => n.metadata?.attributes?.routePath === '/users/:id'));
  } finally {
    await fs.remove(root);
  }
});
