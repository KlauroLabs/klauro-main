import { test } from 'node:test';
import assert from 'node:assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import { SvelteAnalyzer } from './svelte-analyzer';

async function makeProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'svelte-analyzer-'));

  await fs.writeJson(path.join(root, 'package.json'), {
    name: 'svelte-fixture',
    dependencies: { svelte: '^5.0.0', '@sveltejs/kit': '^2.0.0' },
  });

  // src/routes/+page.svelte — a component with `export let name`
  await fs.ensureDir(path.join(root, 'src', 'routes'));
  await fs.writeFile(
    path.join(root, 'src', 'routes', '+page.svelte'),
    `<script lang="ts">
  export let name: string = 'world';
  let count = $state(0);
</script>

<h1>Hello {name}</h1>
<button on:click={() => count++}>{count}</button>

<style>h1 { color: red; }</style>
`
  );

  // src/routes/api/+server.ts — GET + POST endpoints
  await fs.ensureDir(path.join(root, 'src', 'routes', 'api'));
  await fs.writeFile(
    path.join(root, 'src', 'routes', 'api', '+server.ts'),
    `import { json } from '@sveltejs/kit';

export function GET() {
  return json({ ok: true });
}

export async function POST({ request }) {
  const body = await request.json();
  return json(body);
}
`
  );

  // src/lib/Counter.svelte
  await fs.ensureDir(path.join(root, 'src', 'lib'));
  await fs.writeFile(
    path.join(root, 'src', 'lib', 'Counter.svelte'),
    `<script>
  let count = $state(0);
  function increment() {
    count += 1;
  }
</script>
<button on:click={() => count++}>clicks: {count}</button>
<button on:click={increment}>increment</button>
`
  );

  return root;
}

test('SvelteAnalyzer: canAnalyze true for SvelteKit project', async () => {
  const root = await makeProject();
  try {
    const analyzer = new SvelteAnalyzer();
    assert.strictEqual(await analyzer.canAnalyze(root), true);
  } finally {
    await fs.remove(root);
  }
});

test('SvelteAnalyzer: extracts components, route, endpoints, and prop', async () => {
  const root = await makeProject();
  try {
    const analyzer = new SvelteAnalyzer();
    const cas = await analyzer.analyze({ projectPath: root });

    // Component nodes for +page.svelte and Counter.svelte
    const componentNodes = cas.nodes.filter(n => (n.tags || []).includes('svelte-component'));
    const componentNames = componentNodes.map(n => n.name);
    assert.ok(componentNames.includes('+page'), 'expected +page component node');
    assert.ok(componentNames.includes('Counter'), 'expected Counter component node');

    // The prop `name` captured on +page.svelte
    const pageNode = componentNodes.find(n => n.name === '+page')!;
    assert.ok(pageNode, 'page node exists');
    const pageProps: string[] = pageNode.metadata?.attributes?.props || [];
    assert.ok(pageProps.includes('name'), `expected prop "name", got ${JSON.stringify(pageProps)}`);

    // A route for /api with GET + POST endpoints as entry points
    const entryPoints = cas.entry_points || [];
    const apiMethods = entryPoints
      .filter(ep => ep.type === 'http' && (ep.trigger?.path === '/api'))
      .map(ep => ep.trigger?.method);
    assert.ok(apiMethods.includes('GET'), `expected GET entry point, got ${JSON.stringify(apiMethods)}`);
    assert.ok(apiMethods.includes('POST'), `expected POST entry point, got ${JSON.stringify(apiMethods)}`);

    // The /api route node exists
    const apiRoute = cas.nodes.find(
      n => n.type === 'sveltekit_route' && n.metadata?.attributes?.route_path === '/api'
    );
    assert.ok(apiRoute, 'expected /api route node');
  } finally {
    await fs.remove(root);
  }
});

test('SvelteAnalyzer: extracts on:click event bindings as event entry points, resolving named handlers', async () => {
  const root = await makeProject();
  try {
    const analyzer = new SvelteAnalyzer();
    const cas = await analyzer.analyze({ projectPath: root });

    const clickEntries = (cas.entry_points || []).filter(ep => ep.type === 'event' && ep.trigger?.pattern === 'click');
    assert.ok(clickEntries.length >= 3, `expected at least 3 click entry points, got ${clickEntries.length}`);

    // The named-handler binding on Counter.svelte resolves a handler_name.
    const namedEntry = clickEntries.find(ep => ep.metadata?.handler_name === 'increment');
    assert.ok(namedEntry, `expected a click entry point resolving to 'increment', got ${JSON.stringify(clickEntries.map(e => e.metadata))}`);

    // A `triggers` edge from the event binding to the increment function node exists.
    const handlerFnNode = cas.nodes.find(n => n.type === 'event_handler_function' && n.name === 'increment');
    assert.ok(handlerFnNode, 'expected event_handler_function node for increment');
    const triggersEdge = (cas.edges || []).find(
      e => e.type === 'triggers' && e.target === handlerFnNode!.id
    );
    assert.ok(triggersEdge, 'expected a triggers edge into the increment handler node');

    // The inline `() => count++` binding is still captured as an event (no fabricated handler name).
    const inlineEntry = clickEntries.find(ep => ep.metadata?.handler_name === undefined);
    assert.ok(inlineEntry, 'expected an event entry point for the inline arrow-expression binding');
  } finally {
    await fs.remove(root);
  }
});
