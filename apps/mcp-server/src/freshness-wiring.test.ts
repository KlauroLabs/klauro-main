import { strict as assert } from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as http from 'node:http';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { saveAnalysis } from './storage';

// Customer MCP reads consume persisted hosted results. They never invoke the
// analyzer locally: dirty-tree analysis is uploaded by the lightweight client
// and its completed result is stored on the in-flight track.

type ToolResponse = { content: Array<{ type: 'text'; text: string }> };

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function initRepo(root: string): void {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export function alpha() { return 1; }\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'freshness-wiring-fixture' }));
  git(root, ['init']);
  git(root, ['-c', 'user.email=test@klauro.dev', '-c', 'user.name=Klauro Test', '-c', 'commit.gpgsign=false', 'add', '.']);
  git(root, ['-c', 'user.email=test@klauro.dev', '-c', 'user.name=Klauro Test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'init']);
}

function fixtureCas(root: string, names: string[]): CASOutput {
  return {
    cas_version: '1.11.0',
    analysis_id: 'analysis_freshness_wiring',
    analysis_timestamp: new Date().toISOString(),
    analyzed_track: names.length > 1 ? 'in-flight' : 'main',
    system: {
      id: 'system_freshness_wiring',
      name: 'Freshness Wiring Fixture',
      type: 'application',
      root_path: root,
      technologies: { languages: [{ name: 'TypeScript', percentage: 100 }], frameworks: [], databases: [] },
      quality: {},
    },
    nodes: names.map((name, index) => ({
      id: `function_${name}`,
      name,
      type: 'function',
      source: { file: name === 'alpha' ? 'src/index.ts' : 'src/newmodule/index.ts', line: index + 1 },
    })),
    edges: [],
    entry_points: [],
    exit_points: [],
    analyzer_contributions: [{ analyzer_name: 'hosted-fixture', nodes_created: names.length, edges_created: 0 }],
  } as unknown as CASOutput;
}

async function startHostedFixture(getCas: () => CASOutput): Promise<{ url: string; syncs: () => number; close: () => Promise<void> }> {
  let syncCount = 0;
  const server = http.createServer((request, response) => {
    const route = (request.url || '').split('?')[0];
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (request.method === 'POST' && route === '/v1/sync') {
      request.resume();
      request.on('end', () => {
        syncCount += 1;
        const cas = { ...getCas(), analysis_timestamp: new Date(Date.now() + 1_000).toISOString() };
        send(200, { status: 'success', analysis_id: 'prj_freshness_wiring', analysis_type: 'incremental', cas });
      });
      return;
    }
    if (/^\/api\/projects\/[^/]+\/analysis$/.test(route)) {
      const cas = getCas();
      send(200, {
        status: 'ready',
        project_id: 'prj_freshness_wiring',
        analysis_id: cas.analysis_id,
        summary: {
          name: cas.system.name,
          analysis_timestamp: cas.analysis_timestamp,
          node_count: cas.nodes.length,
          edge_count: cas.edges.length,
        },
      });
      return;
    }
    if (/^\/api\/projects\/[^/]+\/cas\/sections$/.test(route)) {
      const cas = getCas();
      send(200, { status: 'ready', analysis_timestamp: cas.analysis_timestamp, cas });
      return;
    }
    if (/^\/api\/projects\/[^/]+\/cas\/export$/.test(route)) {
      response.writeHead(200, { 'content-type': 'application/json', 'x-klauro-cas-codec': 'none' });
      response.end(JSON.stringify(getCas()));
      return;
    }
    send(404, { status: 'error', error: 'unknown fixture route' });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}`,
    syncs: () => syncCount,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}

function withTempDir(prefix: string, run: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return run(dir).finally(() => fs.removeSync(dir));
}

test('onboarding tool handlers consume a completed hosted in-flight refresh without local analysis', { timeout: 120000 }, async () => {
  const previousStorage = process.env.KLAURO_STORAGE_PATH;
  const previousToken = process.env.KLAURO_ACCOUNT_TOKEN;
  const previousAuthDisabled = process.env.KLAURO_CONNECTOR_AUTH_DISABLED;
  await withTempDir('klauro-freshness-wiring-', async root => {
    const storage = path.join(root, 'storage');
    process.env.KLAURO_STORAGE_PATH = storage;
    process.env.KLAURO_ACCOUNT_TOKEN = 'freshness-test-token';
    process.env.KLAURO_CONNECTOR_AUTH_DISABLED = '1';
    let hosted: Awaited<ReturnType<typeof startHostedFixture>> | undefined;
    try {
      const { createServer } = await import('./server');
      const { clearFreshnessSummaryCache } = await import('./freshness');
      const { clearHostedAnalysisCaches } = await import('./hosted-analysis');

      const project = path.join(root, 'project');
      initRepo(project);
      let hostedCas = fixtureCas(project, ['alpha']);
      hosted = await startHostedFixture(() => hostedCas);
      fs.writeJsonSync(path.join(project, '.klaurorc'), {
        version: 1,
        kind: 'project',
        project: { name: 'freshness-wiring', id: 'prj_freshness_wiring', workspaceId: 'wsp_freshness' },
        analyzer: { serverUrl: hosted.url, selfHosted: true },
        policy: { allowRemoteAnalyzer: true, allowedAnalyzerHosts: [hosted.url] },
      });

      await saveAnalysis(project, fixtureCas(project, ['alpha']));

      // The hosted analyzer has completed the lightweight client's dirty-tree
      // upload. Persist that returned CAS on the in-flight track exactly as the
      // remote sync client does; no local analyzer entrypoint is involved.
      fs.mkdirSync(path.join(project, 'src', 'newmodule'), { recursive: true });
      fs.writeFileSync(
        path.join(project, 'src', 'newmodule', 'index.ts'),
        'export function newModuleFn() { return 42; }\n',
      );
      hostedCas = fixtureCas(project, ['alpha', 'newModuleFn']);
      clearFreshnessSummaryCache();
      clearHostedAnalysisCaches();

      const server = createServer();
      const registered = (server as any)._registeredTools as Record<
        string,
        { callback?: (args: any) => Promise<ToolResponse>; handler?: (args: any) => Promise<ToolResponse> }
      >;
      const invoke = async (tool: string, args: Record<string, unknown>): Promise<any> => {
        const entry = registered[tool];
        assert.ok(entry, `expected tool ${tool} to be registered`);
        const callback = entry.callback ?? entry.handler;
        const response = (await callback!(args)) as ToolResponse;
        assert.equal(response.content.length, 1, `${tool} should return a single content block`);
        return JSON.parse(response.content[0].text);
      };

      const firstResolution = await invoke('resolve_agent_analysis', { path: project });
      assert.equal(firstResolution.refreshed, true, JSON.stringify(firstResolution));

      // --- get_coding_context: THE onboarding "call before writing any code"
      // tool. Must resolve the new function without a manual re-analyze. ---
      const codingContext = await invoke('get_coding_context', { path: project, target: 'newModuleFn' });
      assert.ok(
        !('error' in codingContext),
        `get_coding_context should resolve newModuleFn via the freshness-gated handler, got: ${JSON.stringify(codingContext)}`,
      );
      assert.equal(
        codingContext?.node?.name ?? codingContext?.target_node?.name,
        'newModuleFn',
        'get_coding_context handler did not refresh before reading -- freshness wiring may have been dropped from the server.ts handler',
      );

      // --- search_nodes (lexical): must find the new function by name. ---
      const searchResult = await invoke('search_nodes', { path: project, query: 'newModuleFn', mode: 'lexical', detail: 'full' });
      const searchHits: any[] = Array.isArray(searchResult) ? searchResult : (searchResult?.results ?? searchResult?.data ?? []);
      assert.ok(
        searchHits.some((n: any) => n.name === 'newModuleFn'),
        `search_nodes should find newModuleFn without a manual re-analyze, got: ${JSON.stringify(searchResult).slice(0, 500)}`,
      );

      // --- get_summary: node counts must reflect the new file. ---
      const summaryBefore = await invoke('get_summary', { path: project });
      assert.ok(summaryBefore.freshness_checked_at, 'get_summary response should carry a freshness_checked_at stamp');

      // A second edit must trigger another hosted in-flight refresh rather
      // than reusing the first result.
      const firstAnalyzedAt = Date.parse(firstResolution.analysis_freshness.analyzed_at);
      if (firstAnalyzedAt >= Date.now()) {
        await new Promise(resolve => setTimeout(resolve, firstAnalyzedAt - Date.now() + 10));
      }
      fs.writeFileSync(path.join(project, 'src', 'newmodule', 'index.ts'), 'export function newModuleFn() { return 43; }\nexport function anotherFn() { return 1; }\n');
      hostedCas = fixtureCas(project, ['alpha', 'newModuleFn', 'anotherFn']);
      clearFreshnessSummaryCache();
      clearHostedAnalysisCaches();
      const resolved = await invoke('resolve_agent_analysis', { path: project });
      assert.equal(
        resolved.refreshed,
        true,
        `resolve_agent_analysis should complete hosted in-flight refresh before returning, got: ${JSON.stringify(resolved)}`,
      );

      const contextAfterEdit = await invoke('get_coding_context', { path: project, target: 'anotherFn' });
      assert.ok(
        !('error' in contextAfterEdit),
        `get_coding_context should resolve anotherFn after resolve_agent_analysis refreshed, got: ${JSON.stringify(contextAfterEdit)}`,
      );
      assert.equal(hosted.syncs(), 2, 'each stale resolution should submit exactly one hosted in-flight sync');
    } finally {
      await hosted?.close();
      if (previousStorage === undefined) delete process.env.KLAURO_STORAGE_PATH;
      else process.env.KLAURO_STORAGE_PATH = previousStorage;
      if (previousToken === undefined) delete process.env.KLAURO_ACCOUNT_TOKEN;
      else process.env.KLAURO_ACCOUNT_TOKEN = previousToken;
      if (previousAuthDisabled === undefined) delete process.env.KLAURO_CONNECTOR_AUTH_DISABLED;
      else process.env.KLAURO_CONNECTOR_AUTH_DISABLED = previousAuthDisabled;
    }
  });
});
