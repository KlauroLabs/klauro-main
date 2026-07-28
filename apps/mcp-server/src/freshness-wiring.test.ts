import { strict as assert } from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

// Regression guard for the freshness-on-read wiring introduced in 58ac5b69
// (Freshness-on-read fix) and preserved through 3eea5a3a (response-size
// compact-by-default), which added a `detail` param on top of the same
// handlers.
//
// The gap the earlier freshness-onboarding-invariant.test.ts left open: it
// reimplements getFreshAnalysisForAgent locally and calls query.* directly,
// so it cannot detect a future edit that rewrites a server.ts handler and
// drops the getFreshAnalysisForAgent call while touching unrelated response
// shaping (exactly the kind of edit 3eea5a3a made, which happened to
// preserve the call this time). This test instead goes through the actual
// registered MCP tool handlers via createServer(), the same pattern used in
// response-budget.test.ts and tool-profile.test.ts.
//
// It must FAIL if a handler is changed to call getAnalysis(path) directly
// instead of getFreshAnalysisForAgent(path) (or, for resolve_agent_analysis,
// if the staleness-triggered incremental refresh is dropped).

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

function withTempDir(prefix: string, run: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return run(dir).finally(() => fs.removeSync(dir));
}

test('onboarding tool handlers (get_summary, search_nodes, get_coding_context) see a new file/function without a manual re-analyze', { timeout: 120000 }, async () => {
  const previousStorage = process.env.KLAURO_STORAGE_PATH;
  await withTempDir('klauro-freshness-wiring-', async root => {
    const storage = path.join(root, 'storage');
    process.env.KLAURO_STORAGE_PATH = storage;
    try {
      const { analyzeProjectIncremental } = await import('./analyzer');
      const { createServer } = await import('./server');
      const { clearFreshnessSummaryCache } = await import('./freshness');

      const project = path.join(root, 'project');
      initRepo(project);

      // Establish the baseline analysis exactly as a first-ever agent call would.
      await analyzeProjectIncremental(project);

      // Add a brand-new file with a brand-new function, uncommitted (the
      // common in-flight agent workflow), WITHOUT calling analyze again.
      fs.mkdirSync(path.join(project, 'src', 'newmodule'), { recursive: true });
      fs.writeFileSync(
        path.join(project, 'src', 'newmodule', 'index.ts'),
        'export function newModuleFn() { return 42; }\n',
      );

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

      // --- resolve_agent_analysis: must act on staleness (refreshed: true
      // when the pre-refresh candidate was stale), not just report it. ---
      // Force a fresh staleness signal by touching another file after the
      // handlers above already refreshed the CAS to current, and clear the
      // (5s-TTL) freshness memo cache so the new write is actually observed
      // rather than a stale cache hit.
      fs.writeFileSync(path.join(project, 'src', 'newmodule', 'index.ts'), 'export function newModuleFn() { return 43; }\nexport function anotherFn() { return 1; }\n');
      clearFreshnessSummaryCache();
      const resolved = await invoke('resolve_agent_analysis', { path: project });
      assert.equal(
        resolved.refreshed,
        true,
        `resolve_agent_analysis should act on staleness (refreshed: true) not just report analysis_freshness, got: ${JSON.stringify(resolved)}`,
      );

      const contextAfterEdit = await invoke('get_coding_context', { path: project, target: 'anotherFn' });
      assert.ok(
        !('error' in contextAfterEdit),
        `get_coding_context should resolve anotherFn after resolve_agent_analysis refreshed, got: ${JSON.stringify(contextAfterEdit)}`,
      );
    } finally {
      if (previousStorage === undefined) delete process.env.KLAURO_STORAGE_PATH;
      else process.env.KLAURO_STORAGE_PATH = previousStorage;
    }
  });
});
