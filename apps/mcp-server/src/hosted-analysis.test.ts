import { test, beforeEach, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import {
  clearHostedAnalysisCaches,
  compareHostedFreshness,
  currentAnalysisSourceStamp,
  getHostedSectionCacheStats,
  resolveBoundAnalysis,
  resolveHostedProjectBinding,
} from './hosted-analysis';
import { loadAnalysis, saveAnalysis } from './storage';
import { parseCasSectionNames, selectCasSections } from './cas-sections';
import { buildCompletedAnalysisLayersReady } from './layered-analysis';

/**
 * Resolution-matrix tests for hosted-analysis.ts — the fix for the live
 * 2026-07-14 truckspy audit where MCP read tools served a stale July-4 LOCAL
 * cache (and, with no cache, silently auto-ran a garbage 41-node local
 * analysis) instead of the 20-minute-old HOSTED analysis the repo is bound to.
 *
 * Matrix: bound+cache-fresh / bound+cache-stale / bound+no-cache /
 * bound+offline / unbound, plus preferLocalCache wiring (previously dead
 * config) and the hosted-vs-local freshness comparison.
 */

const HOSTED_TS = '2026-07-14T15:29:00.000Z';
const STALE_TS = '2026-07-04T19:14:18.863Z';
const NEWER_TS = '2026-07-14T18:00:00.000Z';

function minimalCas(timestamp: string, name = 'truckspy-fixture'): CASOutput {
  const output = {
    cas_version: '1.11.0',
    analysis_timestamp: timestamp,
    analysis_id: `analysis_${name}`,
    system: {
      id: `system_${name}`,
      name,
      type: 'application',
      root_path: '/tmp/fixture',
      technologies: { languages: [], frameworks: [] },
      quality: {},
    },
    nodes: [],
    edges: [],
    entry_points: [],
    exit_points: [],
  } as unknown as CASOutput;
  output.layers_ready = buildCompletedAnalysisLayersReady(output);
  return output;
}

interface FakeHostedServer {
  url: string;
  requests: string[];
  urls: string[];
  close: () => Promise<void>;
  state: { status: string; analysis_timestamp?: string };
  casSupported: boolean;
}

async function startFakeHostedServer(options: { analysisTimestamp?: string; status?: string; casSupported?: boolean } = {}): Promise<FakeHostedServer> {
  const fake: FakeHostedServer = {
    url: '',
    requests: [],
    urls: [],
    close: async () => undefined,
    state: {
      status: options.status || 'ready',
      analysis_timestamp: options.analysisTimestamp ?? HOSTED_TS,
    },
    casSupported: options.casSupported !== false,
  };
  const server = http.createServer((req, res) => {
    const route = (req.url || '').split('?')[0];
    fake.requests.push(route);
    fake.urls.push(req.url || '');
    const send = (statusCode: number, body: unknown) => {
      res.writeHead(statusCode, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const stateMatch = route.match(/^\/api\/projects\/([^/]+)\/analysis$/);
    if (stateMatch) {
      if (fake.state.status === 'no_analysis') return send(200, { status: 'no_analysis', project_id: stateMatch[1] });
      return send(200, {
        status: fake.state.status,
        project_id: stateMatch[1],
        analysis_id: 'analysis-1',
        summary: { name: 'truckspy', analysis_timestamp: fake.state.analysis_timestamp, description_source: 'ai' },
      });
    }
    const sectionsMatch = route.match(/^\/api\/projects\/([^/]+)\/cas\/sections$/);
    if (sectionsMatch) {
      if (!fake.casSupported) return send(404, { status: 'error', error: 'not found' });
      const requested = parseCasSectionNames(new URL(req.url || '', 'http://localhost').searchParams.get('sections'));
      const cas = minimalCas(fake.state.analysis_timestamp || HOSTED_TS, 'hosted-truckspy');
      return send(200, {
        status: 'ready',
        project_id: sectionsMatch[1],
        analysis_id: 'analysis-1',
        analysis_timestamp: fake.state.analysis_timestamp,
        sections: requested,
        cas: selectCasSections(cas, requested),
      });
    }
    const exportMatch = route.match(/^\/api\/projects\/([^/]+)\/cas\/export$/);
    if (exportMatch) {
      if (!fake.casSupported) return send(404, { status: 'error', error: 'not found' });
      res.writeHead(200, { 'content-type': 'application/json', 'x-klauro-cas-codec': 'none' });
      return res.end(JSON.stringify(minimalCas(fake.state.analysis_timestamp || HOSTED_TS, 'hosted-truckspy')));
    }
    send(404, { status: 'error', error: 'unknown route' });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  fake.url = `http://127.0.0.1:${address.port}`;
  fake.close = () => new Promise(resolve => server.close(() => resolve()));
  return fake;
}

const tmpRoots: string[] = [];

async function makeBoundRepo(serverUrl: string, options: { projectId?: string; preferLocalCache?: boolean } = {}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-hosted-test-'));
  tmpRoots.push(dir);
  await fs.writeJson(path.join(dir, '.klaurorc'), {
    version: 1,
    kind: 'project',
    project: { name: 'truckspy', id: options.projectId ?? 'prj_test123', workspaceId: 'wsp_test' },
    analyzer: { serverUrl },
    ...(options.preferLocalCache === undefined ? {} : { mcp: { preferLocalCache: options.preferLocalCache } }),
  });
  return dir;
}

beforeEach(async () => {
  clearHostedAnalysisCaches();
  const store = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-hosted-store-'));
  tmpRoots.push(store);
  process.env.KLAURO_STORAGE_PATH = store;
  process.env.KLAURO_ACCOUNT_TOKEN = 'test-token';
  delete process.env.KLAURO_MCP_HOSTED_RESOLUTION;
});

after(async () => {
  for (const dir of tmpRoots) await fs.remove(dir).catch(() => undefined);
});

test('unbound repo (no prj_ id) resolves to no binding — legacy local behavior', async () => {
  const server = await startFakeHostedServer();
  try {
    const dir = await makeBoundRepo(server.url, { projectId: undefined });
    await fs.writeJson(path.join(dir, '.klaurorc'), { version: 1, project: { name: 'unbound' } });
    assert.strictEqual(await resolveHostedProjectBinding(dir), null);

    const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-hosted-bare-'));
    tmpRoots.push(bare);
    assert.strictEqual(await resolveHostedProjectBinding(bare), null, 'no .klaurorc at all = unbound');
  } finally {
    await server.close();
  }
});

test('signed-out session (no token) resolves to no binding', async () => {
  const server = await startFakeHostedServer();
  try {
    const dir = await makeBoundRepo(server.url);
    delete process.env.KLAURO_ACCOUNT_TOKEN;
    // Point auth.json at an empty file so no real stored session leaks in.
    const authDir = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-hosted-auth-'));
    tmpRoots.push(authDir);
    process.env.KLAURO_AUTH_CONFIG_PATH = path.join(authDir, 'auth.json');
    try {
      assert.strictEqual(await resolveHostedProjectBinding(dir), null);
    } finally {
      delete process.env.KLAURO_AUTH_CONFIG_PATH;
      process.env.KLAURO_ACCOUNT_TOKEN = 'test-token';
    }
  } finally {
    await server.close();
  }
});

test('hosted resolution cannot be disabled by a legacy environment kill switch', async () => {
  const server = await startFakeHostedServer();
  try {
    const dir = await makeBoundRepo(server.url);
    process.env.KLAURO_MCP_HOSTED_RESOLUTION = 'off';
    assert.ok(await resolveHostedProjectBinding(dir));
    delete process.env.KLAURO_MCP_HOSTED_RESOLUTION;
    assert.ok(await resolveHostedProjectBinding(dir));
  } finally {
    await server.close();
  }
});

test('bound + no cache: hydrates requested hosted sections without a full download or local mirror', async () => {
  const server = await startFakeHostedServer();
  try {
    const dir = await makeBoundRepo(server.url);
    const binding = await resolveHostedProjectBinding(dir);
    assert.ok(binding);
    const resolution = await resolveBoundAnalysis(binding!, { sections: ['graph'] });
    assert.strictEqual(resolution.source, 'hosted');
    assert.strictEqual(resolution.cas.analysis_timestamp, HOSTED_TS);
    assert.strictEqual(resolution.hosted_timestamp, HOSTED_TS);
    // Customer reads do not mirror the full CAS into the local store.
    const mirrored = await loadAnalysis(dir);
    assert.strictEqual(mirrored, null);
    assert.ok(server.requests.includes(`/api/projects/prj_test123/cas/sections`));
    assert.ok(!server.requests.includes(`/api/projects/prj_test123/cas/export`));
    // Provenance stamp available for tool responses.
    const stamp = currentAnalysisSourceStamp();
    assert.strictEqual(stamp.analysis_source?.origin, 'hosted');
    assert.strictEqual(stamp.analysis_source?.project_id, 'prj_test123');
  } finally {
    await server.close();
  }
});

test('bound section cache reuses one bounded response without downloading full CAS', async () => {
  const server = await startFakeHostedServer();
  try {
    const dir = await makeBoundRepo(server.url);
    const binding = (await resolveHostedProjectBinding(dir))!;
    await resolveBoundAnalysis(binding, { sections: ['graph'] });
    const casDownloads = server.requests.filter(r => r.endsWith('/cas/sections')).length;
    assert.strictEqual(casDownloads, 1);

    const second = await resolveBoundAnalysis(binding, { sections: ['graph'] });
    assert.strictEqual(second.source, 'hosted');
    assert.strictEqual(second.cas.analysis_timestamp, HOSTED_TS);
    assert.strictEqual(server.requests.filter(r => r.endsWith('/cas/sections')).length, casDownloads, 'no second download');
    assert.strictEqual(getHostedSectionCacheStats().entries, 1);
  } finally {
    await server.close();
  }
});

test('hosted child section reads forward the CAS id and isolate cache entries', async () => {
  const server = await startFakeHostedServer();
  try {
    const dir = await makeBoundRepo(server.url);
    const binding = (await resolveHostedProjectBinding(dir))!;
    await resolveBoundAnalysis(binding, { sections: ['graph'], sub_cas_node_id: 'cas:child-a' });
    await resolveBoundAnalysis(binding, { sections: ['graph'], sub_cas_node_id: 'cas:child-b' });
    assert.ok(server.urls.some(url => url.includes('sub_cas_node_id=cas%3Achild-a')));
    assert.ok(server.urls.some(url => url.includes('sub_cas_node_id=cas%3Achild-b')));
    assert.strictEqual(getHostedSectionCacheStats().entries, 2);
  } finally {
    await server.close();
  }
});

test('hosted section cache does not retain a response larger than its byte budget', async () => {
  const previous = process.env.KLAURO_HOSTED_SECTION_CACHE_MAX_BYTES;
  process.env.KLAURO_HOSTED_SECTION_CACHE_MAX_BYTES = '128';
  clearHostedAnalysisCaches();
  const server = await startFakeHostedServer();
  try {
    const dir = await makeBoundRepo(server.url);
    const binding = (await resolveHostedProjectBinding(dir))!;
    await resolveBoundAnalysis(binding, { sections: ['graph'] });
    assert.strictEqual(getHostedSectionCacheStats().entries, 0);
  } finally {
    await server.close();
    if (previous === undefined) delete process.env.KLAURO_HOSTED_SECTION_CACHE_MAX_BYTES;
    else process.env.KLAURO_HOSTED_SECTION_CACHE_MAX_BYTES = previous;
    clearHostedAnalysisCaches();
  }
});

test('bound + stale cache: hosted analysis wins over the July-4 local cache', async () => {
  const server = await startFakeHostedServer();
  try {
    const dir = await makeBoundRepo(server.url);
    await saveAnalysis(dir, minimalCas(STALE_TS, 'stale-local'));
    const binding = (await resolveHostedProjectBinding(dir))!;
    const resolution = await resolveBoundAnalysis(binding);
    assert.strictEqual(resolution.source, 'hosted');
    assert.strictEqual(resolution.cas.analysis_timestamp, HOSTED_TS);
    // The stale local cache remains untouched; hosted reads are hydrated in memory.
    const mirrored = await loadAnalysis(dir);
    assert.strictEqual(mirrored?.analysis_timestamp, STALE_TS);
  } finally {
    await server.close();
  }
});

test('bound + newer local + preferLocalCache=true (default): local analysis served', async () => {
  const server = await startFakeHostedServer();
  try {
    const dir = await makeBoundRepo(server.url);
    await saveAnalysis(dir, minimalCas(NEWER_TS, 'newer-local'));
    const binding = (await resolveHostedProjectBinding(dir))!;
    assert.strictEqual(binding.preferLocalCache, true);
    const resolution = await resolveBoundAnalysis(binding);
    assert.strictEqual(resolution.source, 'local-mirror');
    assert.strictEqual(resolution.cas.analysis_timestamp, NEWER_TS);
    assert.strictEqual(server.requests.filter(r => r.endsWith('/cas/export')).length, 0, 'no download needed');
  } finally {
    await server.close();
  }
});

test('bound + newer local + preferLocalCache=false: hosted source of truth served anyway', async () => {
  const server = await startFakeHostedServer();
  try {
    const dir = await makeBoundRepo(server.url, { preferLocalCache: false });
    await saveAnalysis(dir, minimalCas(NEWER_TS, 'newer-local'));
    const binding = (await resolveHostedProjectBinding(dir))!;
    assert.strictEqual(binding.preferLocalCache, false);
    const resolution = await resolveBoundAnalysis(binding);
    assert.strictEqual(resolution.source, 'hosted');
    assert.strictEqual(resolution.cas.analysis_timestamp, HOSTED_TS);
  } finally {
    await server.close();
  }
});

test('bound + offline + cache: serves local cache with an honest degraded note', async () => {
  const server = await startFakeHostedServer();
  const dir = await makeBoundRepo(server.url);
  await saveAnalysis(dir, minimalCas(STALE_TS, 'stale-local'));
  const binding = (await resolveHostedProjectBinding(dir))!;
  await server.close(); // now offline
  const resolution = await resolveBoundAnalysis(binding);
  assert.strictEqual(resolution.source, 'local-cache-degraded');
  assert.strictEqual(resolution.cas.analysis_timestamp, STALE_TS);
  assert.match(resolution.note || '', /hosted analysis unavailable/);
  assert.match(resolution.note || '', new RegExp(STALE_TS.replace(/[.+]/g, '\\$&')));
  const stamp = currentAnalysisSourceStamp();
  assert.strictEqual(stamp.analysis_source?.origin, 'local-cache-degraded');
});

test('bound + offline + no cache: honest error, never a silent local analysis', async () => {
  const server = await startFakeHostedServer();
  const dir = await makeBoundRepo(server.url);
  const binding = (await resolveHostedProjectBinding(dir))!;
  await server.close();
  await assert.rejects(
    () => resolveBoundAnalysis(binding),
    (error: Error) => /hosted analysis is unavailable/.test(error.message) && /Refusing to silently run a local analysis/.test(error.message),
  );
});

test('bound + old server build without /cas endpoint: degrades honestly', async () => {
  const server = await startFakeHostedServer({ casSupported: false });
  try {
    const dir = await makeBoundRepo(server.url);
    // With a stale cache: served, but with the honest "server cannot serve full CAS" note.
    await saveAnalysis(dir, minimalCas(STALE_TS, 'stale-local'));
    const binding = (await resolveHostedProjectBinding(dir))!;
    const resolution = await resolveBoundAnalysis(binding);
    assert.strictEqual(resolution.source, 'local-cache-degraded');
    assert.match(resolution.note || '', /does not expose full-CAS/);
  } finally {
    await server.close();
  }
});

test('bound + hosted has no analysis + no cache: honest error pointing at analyze', async () => {
  const server = await startFakeHostedServer({ status: 'no_analysis' });
  try {
    const dir = await makeBoundRepo(server.url);
    const binding = (await resolveHostedProjectBinding(dir))!;
    await assert.rejects(
      () => resolveBoundAnalysis(binding),
      (error: Error) => /has no analysis yet/.test(error.message),
    );
  } finally {
    await server.close();
  }
});

test('compareHostedFreshness: stale local vs hosted, fresh mirror, and no-local-cache', async () => {
  const server = await startFakeHostedServer();
  try {
    const dir = await makeBoundRepo(server.url);
    const binding = (await resolveHostedProjectBinding(dir))!;

    // No local cache yet.
    let comparison = await compareHostedFreshness(binding);
    assert.strictEqual(comparison.reachable, true);
    assert.strictEqual(comparison.status, 'no-local-cache');
    assert.strictEqual(comparison.hosted_analysis_timestamp, HOSTED_TS);

    // Stale local cache: freshness is judged against the HOSTED timestamp,
    // not local file mtimes (the truckspy "fresh" lie).
    await saveAnalysis(dir, minimalCas(STALE_TS, 'stale-local'));
    clearHostedAnalysisCaches();
    comparison = await compareHostedFreshness(binding);
    assert.strictEqual(comparison.status, 'stale');
    assert.strictEqual(comparison.local_analysis_timestamp, STALE_TS);

    // Coherent mirror: fresh.
    await saveAnalysis(dir, minimalCas(HOSTED_TS, 'mirror'));
    clearHostedAnalysisCaches();
    comparison = await compareHostedFreshness(binding);
    assert.strictEqual(comparison.status, 'fresh');
  } finally {
    await server.close();
  }
});

test('compareHostedFreshness: offline reports unreachable without inventing freshness', async () => {
  const server = await startFakeHostedServer();
  const dir = await makeBoundRepo(server.url);
  await saveAnalysis(dir, minimalCas(STALE_TS, 'stale-local'));
  const binding = (await resolveHostedProjectBinding(dir))!;
  await server.close();
  const comparison = await compareHostedFreshness(binding);
  assert.strictEqual(comparison.reachable, false);
  assert.strictEqual(comparison.status, undefined);
  assert.ok(comparison.reason);
});
