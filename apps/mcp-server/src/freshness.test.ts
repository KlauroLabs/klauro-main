import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { execFileSync } from 'node:child_process';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { clearFreshnessSummaryCache, summarizeAnalysisFreshness } from './freshness';
import { getAgentStartContext, getAgentContext } from './agent-adoption';
import { resolveAgentAnalysis } from './agent-project-map';
import { saveAnalysis } from './storage';

const HOUR_MS = 60 * 60 * 1000;

function withTempDir(prefix: string, run: (dir: string) => void | Promise<void>): Promise<void> | void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const result = run(dir);
  if (result && typeof (result as Promise<void>).finally === 'function') {
    return (result as Promise<void>).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

function writeSourceFixture(root: string): string[] {
  fs.mkdirSync(path.join(root, 'src', 'users'), { recursive: true });
  const files = [
    path.join(root, 'package.json'),
    path.join(root, 'src', 'users', 'users.service.ts'),
    path.join(root, 'src', 'users', 'users.controller.ts'),
    path.join(root, 'src', 'index.ts'),
  ];
  fs.writeFileSync(files[0], JSON.stringify({ name: 'fixture', scripts: { test: 'jest' } }));
  fs.writeFileSync(files[1], 'export class UsersService {}\n');
  fs.writeFileSync(files[2], 'export class UsersController {}\n');
  fs.writeFileSync(files[3], 'export const app = true;\n');
  return files;
}

function initGitRepo(root: string): void {
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git(['init']);
  git(['-c', 'user.email=test@klauro.dev', '-c', 'user.name=Klauro Test', '-c', 'commit.gpgsign=false', 'add', '.']);
  git(['-c', 'user.email=test@klauro.dev', '-c', 'user.name=Klauro Test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture']);
}

function setMtime(file: string, whenMs: number): void {
  fs.utimesSync(file, new Date(whenMs), new Date(whenMs));
}

function freshnessFixtureCas(root: string, analyzedAt: string): CASOutput {
  return {
    cas_version: '1.11.0',
    analysis_timestamp: analyzedAt,
    analysis_id: 'analysis_freshness_test',
    system: {
      name: 'Freshness Fixture',
      type: 'api',
      description: 'Fixture service for freshness tests',
      root_path: root,
      technologies: {
        languages: [{ name: 'TypeScript', percentage: 100 }],
        frameworks: [{ name: 'NestJS' }],
        databases: [],
      },
    },
    nodes: [
      {
        id: 'users-service',
        name: 'UsersService',
        type: 'service',
        source: { file: 'src/users/users.service.ts', line: 1 },
      },
      {
        id: 'users-controller',
        name: 'UsersController',
        type: 'controller',
        source: { file: 'src/users/users.controller.ts', line: 1 },
      },
    ],
    edges: [
      { id: 'edge-controller-service', source: 'users-controller', target: 'users-service', type: 'calls' },
    ],
    entry_points: [
      { id: 'entry-users', name: 'POST /users', type: 'http', source_node: 'users-controller', handler: { node_id: 'users-service', name: 'create' } },
    ],
    exit_points: [],
    analyzer_contributions: [{ analyzer_name: 'fixture', nodes_created: 2, edges_created: 1 }],
  } as unknown as CASOutput;
}

async function startFreshnessSyncServer(getCas: () => CASOutput): Promise<{ url: string; syncs: () => number; close: () => Promise<void> }> {
  let syncCount = 0;
  const server = http.createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/v1/sync') {
      request.resume();
      request.on('end', () => {
        syncCount += 1;
        const cas = { ...getCas(), analysis_timestamp: new Date(Date.now() + 1_000).toISOString() };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          status: 'success',
          analysis_id: 'prj_freshness_test',
          analysis_type: 'incremental',
          cas,
        }));
      });
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'error', error: 'unknown fixture route' }));
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

test('git repo with no changes since analysis reports fresh', () => {
  withTempDir('klauro-freshness-fresh-', root => {
    const files = writeSourceFixture(root);
    initGitRepo(root);
    const past = Date.now() - 2 * HOUR_MS;
    for (const file of files) setMtime(file, past);

    clearFreshnessSummaryCache();
    const summary = summarizeAnalysisFreshness(root, new Date(Date.now() - HOUR_MS).toISOString());

    assert.ok(summary);
    assert.equal(summary!.staleness, 'fresh');
    assert.equal(summary!.files_changed_since_analysis.count, 0);
    assert.equal(summary!.files_deleted_since_analysis.count, 0);
    assert.equal(summary!.scan.method, 'git');
    assert.match(summary!.recommendation, /current|trustworthy/i);
    assert.match(summary!.age, /\d+(m|h|d)/);
  });
});

test('files touched after analysis surface counts, examples, and deletion makes it stale', () => {
  withTempDir('klauro-freshness-stale-', root => {
    const files = writeSourceFixture(root);
    initGitRepo(root);
    const analyzedAt = new Date(Date.now() - HOUR_MS).toISOString();
    for (const file of files) setMtime(file, Date.now() - 2 * HOUR_MS);

    fs.appendFileSync(files[1], '// changed after analysis\n');
    fs.appendFileSync(files[2], '// changed after analysis\n');
    clearFreshnessSummaryCache();
    const aging = summarizeAnalysisFreshness(root, analyzedAt);
    assert.ok(aging);
    assert.equal(aging!.staleness, 'aging');
    assert.equal(aging!.files_changed_since_analysis.count, 2);
    assert.ok(aging!.files_changed_since_analysis.examples.includes('src/users/users.service.ts'));
    assert.ok(aging!.files_changed_since_analysis.examples.length <= 5);
    assert.match(aging!.recommendation, /analyze_codebase/);

    fs.rmSync(files[3]);
    clearFreshnessSummaryCache();
    const stale = summarizeAnalysisFreshness(root, analyzedAt);
    assert.ok(stale);
    assert.equal(stale!.staleness, 'stale');
    assert.equal(stale!.files_deleted_since_analysis.count, 1);
    assert.ok(stale!.files_deleted_since_analysis.examples.includes('src/index.ts'));
    assert.match(stale!.recommendation, /Re-run analyze_codebase/);
  });
});

test('non-git directory falls back to a bounded walk and still detects changes', () => {
  withTempDir('klauro-freshness-walk-', root => {
    const files = writeSourceFixture(root);
    const analyzedAt = new Date(Date.now() - HOUR_MS).toISOString();
    for (const file of files) setMtime(file, Date.now() - 2 * HOUR_MS);

    clearFreshnessSummaryCache();
    const fresh = summarizeAnalysisFreshness(root, analyzedAt);
    assert.ok(fresh);
    assert.equal(fresh!.scan.method, 'walk');
    assert.equal(fresh!.staleness, 'fresh');
    assert.match(fresh!.scan.note || '', /deletions since analysis are not detectable/i);

    fs.appendFileSync(files[1], '// changed after analysis\n');
    clearFreshnessSummaryCache();
    const changed = summarizeAnalysisFreshness(root, analyzedAt);
    assert.ok(changed);
    assert.equal(changed!.scan.method, 'walk');
    assert.equal(changed!.staleness, 'aging');
    assert.equal(changed!.files_changed_since_analysis.count, 1);
    assert.ok(changed!.files_changed_since_analysis.examples[0].endsWith('users.service.ts'));
  });
});

test('agent start context leads with the analysis freshness summary', () => {
  withTempDir('klauro-freshness-start-', root => {
    const files = writeSourceFixture(root);
    initGitRepo(root);
    const analyzedAt = new Date(Date.now() - HOUR_MS).toISOString();
    for (const file of files) setMtime(file, Date.now() - 2 * HOUR_MS);
    fs.appendFileSync(files[1], '// changed after analysis\n');

    clearFreshnessSummaryCache();
    const context = getAgentStartContext(freshnessFixtureCas(root, analyzedAt), root) as Record<string, any>;

    assert.ok(context.analysis_freshness);
    assert.equal(context.analysis_freshness.staleness, 'aging');
    assert.equal(context.analysis_freshness.files_changed_since_analysis.count, 1);
    const keys = Object.keys(context);
    assert.ok(keys.indexOf('analysis_freshness') < keys.indexOf('readiness'));
  });
});

test('agent context reports a missing citation without inventing deletion timing', async () => {
  await withTempDir('klauro-freshness-context-', async root => {
    const files = writeSourceFixture(root);
    initGitRepo(root);
    const analyzedAt = new Date(Date.now() - HOUR_MS).toISOString();
    for (const file of files) setMtime(file, Date.now() - 2 * HOUR_MS);
    fs.rmSync(files[1]);

    clearFreshnessSummaryCache();
    const context = await getAgentContext(freshnessFixtureCas(root, analyzedAt), root, {
      task_type: 'modify',
      target: 'UsersService',
    }) as Record<string, any>;

    const freshness = context.analysis_freshness;
    assert.ok(freshness, 'agent context must carry analysis_freshness');
    assert.equal(freshness.staleness, 'stale');
    assert.ok(freshness.files_missing_now.examples.includes('src/users/users.service.ts'));
    assert.equal(freshness.files_deleted_since_analysis.count, null);
    assert.match(freshness.warning, /missing/i);
    assert.equal(context.agent_context_ready, false);

    const risk = context.work_context?.risk;
    assert.match(risk?.citation_verification_note, /missing.*deletion timing is unknown/i);
    assert.equal(risk?.target_file_changed_since_analysis, undefined);
  });
});

test('agent context treats a newer target timestamp as a hint, not a content comparison', async () => {
  await withTempDir('klauro-freshness-target-', async root => {
    const files = writeSourceFixture(root);
    initGitRepo(root);
    const analyzedAt = new Date(Date.now() - HOUR_MS).toISOString();
    for (const file of files) setMtime(file, Date.now() - 2 * HOUR_MS);
    fs.appendFileSync(files[1], '// changed after analysis\n');

    clearFreshnessSummaryCache();
    const context = await getAgentContext(freshnessFixtureCas(root, analyzedAt), root, {
      task_type: 'modify',
      target: 'UsersService',
    }) as Record<string, any>;

    assert.equal(context.analysis_freshness.staleness, 'unknown');
    assert.equal(context.analysis_freshness.files_changed_since_analysis.count, null);
    assert.ok(context.analysis_freshness.newer_mtime_hints.examples.includes('src/users/users.service.ts'));
    assert.match(context.work_context.risk.citation_verification_note, /identity.*unavailable/i);
    assert.equal(context.work_context.risk.target_file_changed_since_analysis, undefined);
    assert.equal(context.agent_context_ready, false);
  });
});

test('first-turn agent context preserves unverified freshness without a reanalysis loop', async () => {
  await withTempDir('klauro-freshness-first-turn-', async root => {
    const files = writeSourceFixture(root);
    initGitRepo(root);
    const analyzedAt = new Date(Date.now() - HOUR_MS).toISOString();
    for (const file of files) setMtime(file, Date.now() - 2 * HOUR_MS);
    fs.appendFileSync(files[1], '// changed after analysis\n');

    clearFreshnessSummaryCache();
    const context = await getAgentContext(freshnessFixtureCas(root, analyzedAt), root, {
      task_type: 'modify',
      target: 'UsersService',
      response_profile: 'first-turn',
    }) as Record<string, any>;

    assert.equal(context.context_profile, 'first-turn');
    assert.equal(context.analysis_freshness.staleness, 'unknown');
    assert.equal(context.analysis_freshness.citation_verification, 'unverified');
    assert.match(context.rule, /UNVERIFIED.*inspect cited source/i);
    assert.doesNotMatch(context.rule, /STALE: re-run analyze_codebase/i);
  });
});

test('agent context does not prove unchanged content from old timestamps', async () => {
  await withTempDir('klauro-freshness-clean-context-', async root => {
    const files = writeSourceFixture(root);
    initGitRepo(root);
    const analyzedAt = new Date(Date.now() - HOUR_MS).toISOString();
    for (const file of files) setMtime(file, Date.now() - 2 * HOUR_MS);

    clearFreshnessSummaryCache();
    const context = await getAgentContext(freshnessFixtureCas(root, analyzedAt), root, {
      task_type: 'modify',
      target: 'UsersService',
    }) as Record<string, any>;

    assert.equal(context.analysis_freshness.staleness, 'unknown');
    assert.equal(context.analysis_freshness.citation_verification, 'unverified');
    assert.equal(context.analysis_freshness.files_changed_since_analysis.count, null);
    assert.equal(context.analysis_freshness.newer_mtime_hints.count, 0);
    assert.match(context.analysis_freshness.warning, /identity.*unavailable/i);
    assert.equal(context.work_context.risk?.target_file_changed_since_analysis, undefined);
    assert.equal(context.agent_context_ready, false);
  });
});

test('resolve_agent_analysis refreshes stale customer analysis through hosted in-flight sync', async () => {
  const previousStorage = process.env.KLAURO_STORAGE_PATH;
  const previousToken = process.env.KLAURO_ACCOUNT_TOKEN;
  const previousAuthDisabled = process.env.KLAURO_CONNECTOR_AUTH_DISABLED;
  await withTempDir('klauro-freshness-resolve-', async root => {
    const storage = path.join(root, 'storage');
    process.env.KLAURO_STORAGE_PATH = storage;
    process.env.KLAURO_ACCOUNT_TOKEN = 'freshness-test-token';
    process.env.KLAURO_CONNECTOR_AUTH_DISABLED = '1';
    let hosted: Awaited<ReturnType<typeof startFreshnessSyncServer>> | undefined;
    try {
      const project = path.join(root, 'project');
      fs.mkdirSync(project, { recursive: true });
      const files = writeSourceFixture(project);
      initGitRepo(project);
      let hostedCas = freshnessFixtureCas(project, new Date().toISOString());
      hosted = await startFreshnessSyncServer(() => hostedCas);
      fs.writeFileSync(path.join(project, '.klaurorc'), JSON.stringify({
        version: 1,
        kind: 'project',
        project: { name: 'freshness-test', id: 'prj_freshness_test', workspaceId: 'wsp_freshness' },
        analyzer: { serverUrl: hosted.url, selfHosted: true },
        policy: { allowRemoteAnalyzer: true, allowedAnalyzerHosts: [hosted.url] },
      }));
      const analyzedAt = new Date(Date.now() - HOUR_MS).toISOString();
      await saveAnalysis(project, freshnessFixtureCas(project, analyzedAt));
      for (const file of files) setMtime(file, Date.now() - 2 * HOUR_MS);
      fs.appendFileSync(files[2], '// changed after analysis\n');
      hostedCas = freshnessFixtureCas(project, new Date().toISOString());

      clearFreshnessSummaryCache();
      const resolution = await resolveAgentAnalysis({ path: project });

      assert.equal(resolution.selected_path, project);
      assert.equal(resolution.refreshed, true);
      assert.ok(resolution.analysis_freshness);
      assert.equal(resolution.analysis_freshness!.staleness, 'fresh');
      assert.equal(resolution.analysis_freshness!.files_changed_since_analysis.count, 0);
      assert.match(resolution.recommendation, /best matching analysis/);
      assert.equal(hosted.syncs(), 1);

      const warmResolution = await resolveAgentAnalysis({ path: project });
      assert.equal(warmResolution.refreshed, false, 'an unchanged warm orientation must not submit another hosted analysis');
      assert.equal(warmResolution.analysis_freshness?.staleness, 'fresh');
      assert.equal(hosted.syncs(), 1, 'an unchanged repeat must reuse the completed CAS');
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
