import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { createRemoteAnalyzerHttpServer, getCasReadResponseCacheStats } from './remote-analyzer-service';
import { saveAnalysis } from './storage';
import { compactSubCasNodes } from './hosted-summary-compaction';
import { buildLayersReady } from './layered-analysis';
import type { CASNode, CASEdge, CASEntryPoint, CASOutput, DeployableEvidence } from '../../../packages/analyzer-core/src/types/cas.types';

/**
 * TASK (backend lane, sub-CAS nodes over HTTP): the web UI's deployable page was
 * approximating deployable-analysis.ts's phase-2 scoping
 * (getCachedDeployableAnalyses / scopeCasToSubCasNode — already wired into 5 MCP
 * tools) client-side, because the real scoped surface was never exposed over
 * HTTP. This proves the two new routes:
 *
 *  - GET /api/projects/:id/das — the sub_cas_nodes summary (units + counts +
 *    orphan accounting) WITHOUT the multi-MB `cas` body.
 *  - GET /api/projects/:id/cas?sub_cas_node_id=<id> — the unit's CAS-shaped
 *    slice, membership-gated + LRU-cached like the sibling /conceptual and
 *    /semantic-coverage routes, with the SAME caller-facing errors
 *    scopeCasToSubCasNode already throws for MCP callers (unknown id /
 *    non-promoted) surfaced as 4xx JSON instead of a 200 body.
 *
 * Setup mirrors sub-cas-node-scope.test.ts's fixture-building approach (a 2-unit
 * promoted CAS: api + worker compose services sharing nothing) and
 * conceptual-conflict-wiring.test.ts's saveAnalysis-direct pattern (write
 * the stored analysis file the real HTTP handler reads via getAnalysis, the
 * SAME code path under test) — deliberately NOT a real analyzeCodebaseRemotely
 * run, which would exercise the full layered/AI analysis pipeline this test
 * has no need of and which is slow/flaky under concurrent-agent VPS load.
 * The project<->analysis_id link is created via the ordinary account API
 * (POST /api/workspaces/:id/projects with an explicit analysis_id), which the
 * product never validates against a real stored analysis at creation time
 * (remote-analyzer-service.ts's own comment: "it is NEVER verified to" exist
 * up front) — exactly the same looseness a real hosted analysis relies on.
 */

function node(id: string, file: string): CASNode {
  return { id, name: id, type: 'function', source: { file, line: 1 } } as CASNode;
}

function callEdge(source: string, target: string): CASEdge {
  return { id: `edge_${source}_${target}`, source, target, type: 'calls' };
}
function completedFixture(cas: CASOutput): CASOutput {
  const completedAt = cas.analysis_timestamp;
  const ready = { status: 'ready' as const, completedAt };
  cas.layers_ready = buildLayersReady({
    L0: ready,
    L1: ready,
    L2: ready,
    L3: ready,
    L4: ready,
    L5: ready,
  }, { generatedAt: completedAt });
  return cas;
}


function entryPoint(id: string, file: string, handlerNodeId: string): CASEntryPoint {
  return {
    id,
    source_node: handlerNodeId,
    type: 'http',
    name: id,
    handler: { node_id: handlerNodeId, method_name: handlerNodeId, file },
  } as CASEntryPoint;
}

/** Same 2-unit promoted shape as sub-cas-node-scope.test.ts's fixture (api + worker
 *  compose services sharing libs/shared, plus 2 ungated bins) — kept local so
 *  this file exercises the HTTP surface without depending on another test
 *  file's internals. */
function buildPromotedCas(analysisId: string): CASOutput {
  const nodes: CASNode[] = [
    node('A1', 'apps/api/handler.ts'),
    node('A2', 'apps/api/other.ts'),
    node('W1', 'apps/worker/worker.ts'),
    node('S1', 'libs/shared/util.ts'),
    node('B1', 'bin/tool1/index.ts'),
    node('B2', 'bin/tool2/index.ts'),
  ];
  const edges: CASEdge[] = [
    callEdge('A1', 'A2'),
    callEdge('A1', 'S1'),
    callEdge('W1', 'S1'),
  ];
  const entry_points: CASEntryPoint[] = [
    entryPoint('ep_api', 'apps/api/handler.ts', 'A1'),
    entryPoint('ep_worker', 'apps/worker/worker.ts', 'W1'),
  ];
  const deployable_evidence: DeployableEvidence[] = [
    { root_path: 'apps/api', name: 'api', tier: 1, kind: 'compose-service', evidence: ['compose:api'] },
    { root_path: 'apps/worker', name: 'worker', tier: 1, kind: 'compose-service', evidence: ['compose:worker'] },
    { root_path: 'bin/tool1', name: 'tool1', tier: 2, kind: 'bin', evidence: ['bin:tool1'] },
    { root_path: 'bin/tool2', name: 'tool2', tier: 2, kind: 'bin', evidence: ['bin:tool2'] },
  ];

  return {
    cas_version: '1.11.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: analysisId,
    system: { id: 'sys1', name: 'test-system', type: 'monorepo', root_path: '.' },
    nodes,
    edges,
    entry_points,
    exit_points: [],
    analyzer_contributions: [],
    progressive_levels: { total_levels: 1 },
    deployable_evidence,
  } as unknown as CASOutput;
}

function buildNonPromotedCas(analysisId: string): CASOutput {
  const nodes: CASNode[] = [node('N1', 'src/app.ts')];
  const deployable_evidence: DeployableEvidence[] = [
    { root_path: '.', name: 'app', tier: 1, kind: 'container', evidence: ['docker:app'] },
  ];
  return {
    cas_version: '1.11.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: analysisId,
    system: { id: 'sys2', name: 'single-app', type: 'monorepo', root_path: '.' },
    nodes,
    edges: [],
    entry_points: [],
    exit_points: [],
    analyzer_contributions: [],
    progressive_levels: { total_levels: 1 },
    deployable_evidence,
  } as unknown as CASOutput;
}

function request(port: number, method: string, route: string, body?: unknown, token?: string): Promise<{ statusCode: number; body: string }> {
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  const headers: Record<string, string> = {};
  if (payload !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  if (token) headers.authorization = `Bearer ${token}`;
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers }, response => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { responseBody += chunk; });
      response.on('end', () => resolve({ statusCode: response.statusCode || 0, body: responseBody }));
    });
    req.on('error', reject);
    if (payload !== undefined) req.end(payload);
    else req.end();
  });
}

function requestBuffer(port: number, route: string, token: string): Promise<{ statusCode: number; body: Buffer; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method: 'GET', headers: { authorization: `Bearer ${token}` } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({ statusCode: response.statusCode || 0, body: Buffer.concat(chunks), headers: response.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('DAS routes: index shape, scoped slice smaller than full, LRU keying, unknown-id + non-promoted honesty', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-das-http-'));
  const remoteData = path.join(root, 'remote-data');
  const previousRemoteData = process.env.KLAURO_REMOTE_ANALYZER_DATA;
  process.env.KLAURO_REMOTE_ANALYZER_DATA = remoteData;

  const server = createRemoteAnalyzerHttpServer({ dataDir: remoteData });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;

  try {
    const registerRes = await request(port, 'POST', '/api/auth/register', {
      email: 'das-http-owner@example.com',
      password: 'password-1234',
      workspace_name: 'DAS HTTP Workspace',
    });
    assert.equal(registerRes.statusCode, 201);
    const token = JSON.parse(registerRes.body).token as string;

    const workspacesRes = await request(port, 'GET', '/api/workspaces', undefined, token);
    const workspaceId = JSON.parse(workspacesRes.body).workspaces[0].id as string;

    const promotedAnalysisHandle = 'das-http-promoted';
    const createRes = await request(port, 'POST', `/api/workspaces/${workspaceId}/projects`, {
      name: 'das-http-promoted-fixture',
      analysis_id: promotedAnalysisHandle,
    }, token);
    assert.equal(createRes.statusCode, 201);
    const project = JSON.parse(createRes.body).project as { id: string; analysis_id?: string };
    assert.ok(project.analysis_id, 'authenticated project response should expose its attached analysis');

    const promotedWorkspace = path.join(remoteData, 'workspaces', project.analysis_id);
    await fs.promises.mkdir(promotedWorkspace, { recursive: true });
    const promotedCas = buildPromotedCas(project.analysis_id);
    await saveAnalysis(promotedWorkspace, completedFixture(promotedCas));

    // --- /das index shape: units + counts, no `cas` body ---
    const dasRes = await request(port, 'GET', `/api/projects/${project.id}/das`, undefined, token);
    assert.equal(dasRes.statusCode, 200);
    const dasBody = JSON.parse(dasRes.body);
    assert.equal(dasBody.status, 'ready');
    assert.equal(dasBody.project_id, project.id);
    assert.equal(dasBody.analysis_id, project.analysis_id);
    assert.equal(dasBody.sub_cas_nodes.promoted, true);
    assert.equal(dasBody.sub_cas_nodes.units.length, 4);
    assert.deepEqual(dasBody.sub_cas_nodes.units.map((u: any) => u.name).sort(), ['api', 'tool1', 'tool2', 'worker']);
    // Honest coverage accounting travels with the index over HTTP too.
    assert.equal(dasBody.sub_cas_nodes.graph_node_count, 6);
    assert.equal(
      dasBody.sub_cas_nodes.exclusive_node_count + dasBody.sub_cas_nodes.shared_node_count + dasBody.sub_cas_nodes.orphan_node_count,
      dasBody.sub_cas_nodes.graph_node_count,
    );
    assert.ok(dasBody.sub_cas_nodes.sum_of_unit_node_counts >= dasBody.sub_cas_nodes.covered_node_count);
    assert.equal(dasBody.cas, undefined, '/das must never carry the multi-MB cas body');
    for (const unit of dasBody.sub_cas_nodes.units) {
      assert.ok(typeof unit.id === 'string' && unit.id.length > 0);
      assert.ok(typeof unit.node_count === 'number' && unit.node_count > 0);
    }
    assert.ok(typeof dasBody.sub_cas_nodes.orphan_node_count === 'number');

    const apiUnit = dasBody.sub_cas_nodes.units.find((u: any) => u.name === 'api');
    const workerUnit = dasBody.sub_cas_nodes.units.find((u: any) => u.name === 'worker');
    assert.ok(apiUnit, 'expected the api unit in sub_cas_nodes');
    assert.ok(workerUnit, 'expected the worker unit in sub_cas_nodes');

    // --- get_summary's FAST hosted path (GET /api/projects/:id/analysis)
    // must carry sub_cas_nodes too. This is the endpoint hostedSummaryPayload
    // (hosted-analysis.ts) hits by default — before this fix it never
    // attached sub_cas_nodes, so a promoted repo queried the ordinary way (no
    // scope/detail=full/runtime/exclude_sections) reported no sub-CAS-node units at
    // all despite /das and the full-CAS path both having them. ---
    const analysisRes = await request(port, 'GET', `/api/projects/${project.id}/analysis`, undefined, token);
    assert.equal(analysisRes.statusCode, 200);
    const analysisBody = JSON.parse(analysisRes.body);
    assert.equal(analysisBody.status, 'ready');
    assert.ok(analysisBody.summary, 'expected a summary object on the fast hosted path');
    assert.equal(analysisBody.summary.sub_cas_nodes.promoted, true);
    assert.deepEqual(
      analysisBody.summary.sub_cas_nodes.units.map((u: any) => u.name).sort(),
      ['api', 'tool1', 'tool2', 'worker'],
    );
    assert.deepEqual(analysisBody.summary.sub_cas_nodes, compactSubCasNodes(dasBody.sub_cas_nodes), 'the fast hosted path must report the dedicated /das index in its compact form');

    // --- scoped slice: strictly smaller than the full CAS (api's closure is
    // A1, A2, S1 = 3 of the 6 fixture nodes, same as sub-cas-node-scope.test.ts's
    // in-process assertion), membership-gated response shape ---
    const statsBeforeSlice = getCasReadResponseCacheStats();
    const apiSlice = await request(port, 'GET', `/api/projects/${project.id}/cas?sub_cas_node_id=${apiUnit.id}`, undefined, token);
    assert.equal(apiSlice.statusCode, 200);
    const apiSliceBody = JSON.parse(apiSlice.body);
    assert.equal(apiSliceBody.status, 'ready');
    assert.equal(apiSliceBody.sub_cas_node_id, apiUnit.id);
    assert.equal(apiSliceBody.project_id, project.id);
    assert.equal(apiSliceBody.cas.nodes.length, 3, 'api slice must be exactly A1, A2, S1');
    assert.ok(apiSliceBody.cas.nodes.length < promotedCas.nodes.length, `scoped slice (${apiSliceBody.cas.nodes.length}) must be smaller than the full CAS (${promotedCas.nodes.length})`);

    // --- LRU keys correctly for repeated slice requests: same id -> hit,
    // byte-identical; different id -> miss, distinct body ---
    const apiSliceRepeat = await request(port, 'GET', `/api/projects/${project.id}/cas?sub_cas_node_id=${apiUnit.id}`, undefined, token);
    assert.equal(apiSliceRepeat.body, apiSlice.body, 'repeat scoped request must be byte-identical to the cached compute');
    const statsAfterRepeat = getCasReadResponseCacheStats();
    assert.equal(statsAfterRepeat.hits - statsBeforeSlice.hits, 1, 'second identical scoped GET must be served from the LRU');

    const workerSlice = await request(port, 'GET', `/api/projects/${project.id}/cas?sub_cas_node_id=${workerUnit.id}`, undefined, token);
    assert.equal(workerSlice.statusCode, 200);
    const workerSliceBody = JSON.parse(workerSlice.body);
    assert.notEqual(workerSlice.body, apiSlice.body, 'distinct sub_cas_node_id must not share a cache entry');
    assert.equal(workerSliceBody.cas.nodes.length, 2, 'worker slice must be exactly W1, S1');
    const statsAfterWorker = getCasReadResponseCacheStats();
    assert.equal(statsAfterWorker.hits, statsAfterRepeat.hits, 'a NEW sub_cas_node_id must be a cache MISS, not accidentally served from the api slice entry');

    // --- unknown id: the existing caller-facing error listing available
    // units, as 4xx JSON ---
    const unknownScope = await request(port, 'GET', `/api/projects/${project.id}/cas?sub_cas_node_id=does-not-exist`, undefined, token);
    assert.ok(unknownScope.statusCode >= 400 && unknownScope.statusCode < 500, `expected a 4xx for an unknown sub_cas_node_id, got ${unknownScope.statusCode}`);
    const unknownScopeBody = JSON.parse(unknownScope.body);
    assert.match(unknownScopeBody.error, /Unknown scope\.sub_cas_node_id/);
    assert.match(unknownScopeBody.error, /api/);
    assert.match(unknownScopeBody.error, /worker/);

    // --- unscoped JSON cannot return the full CAS; callers must use named
    // sections or the authenticated compressed export stream ---
    const fullCas = await request(port, 'GET', `/api/projects/${project.id}/cas`, undefined, token);
    assert.equal(fullCas.statusCode, 410);
    const fullCasBody = JSON.parse(fullCas.body);
    assert.match(fullCasBody.export_url, /\/cas\/export$/);
    assert.match(fullCasBody.sections_url, /\/cas\/sections$/);

    const manifestResponse = await request(port, 'GET', `/api/projects/${project.id}/cas/manifest`, undefined, token);
    assert.equal(manifestResponse.statusCode, 200);
    const manifestBody = JSON.parse(manifestResponse.body);
    assert.equal(manifestBody.cas, undefined);
    assert.ok(manifestBody.manifest.sections.some((section: { name: string }) => section.name === 'graph'));

    const graphResponse = await request(port, 'GET', `/api/projects/${project.id}/cas/sections?sections=graph`, undefined, token);
    assert.equal(graphResponse.statusCode, 200);
    const graphBody = JSON.parse(graphResponse.body);
    assert.equal(graphBody.cas.nodes.length, promotedCas.nodes.length);
    assert.equal(graphBody.cas.method_calls, undefined);

    // --- sections honor sub_cas_node_id: the scope used to be accepted and
    // ignored, returning the whole repo's graph/comprehension under a scoped
    // URL. A scoped sections read must carry ONLY this unit's slice, and only
    // the requested sections. ---
    const scopedSections = await request(
      port, 'GET', `/api/projects/${project.id}/cas/sections?sections=graph&sub_cas_node_id=${apiUnit.id}`, undefined, token);
    assert.equal(scopedSections.statusCode, 200);
    const scopedSectionsBody = JSON.parse(scopedSections.body);
    assert.equal(scopedSectionsBody.sub_cas_node_id, apiUnit.id);
    assert.equal(scopedSectionsBody.cas.nodes.length, 3, 'scoped sections must carry the unit slice, not the repo');
    assert.equal(scopedSectionsBody.cas.method_calls, undefined, 'unrequested sections stay out of a scoped read');
    assert.equal(scopedSectionsBody.cas.capabilities, undefined, 'comprehension was not requested');
    const scopedSectionsRepeat = await request(
      port, 'GET', `/api/projects/${project.id}/cas/sections?sections=graph&sub_cas_node_id=${apiUnit.id}`, undefined, token);
    assert.equal(scopedSectionsRepeat.body, scopedSections.body, 'repeat scoped sections read is served byte-identically');
    const unknownScopedSections = await request(
      port, 'GET', `/api/projects/${project.id}/cas/sections?sections=graph&sub_cas_node_id=nope`, undefined, token);
    assert.equal(unknownScopedSections.statusCode, 404);
    assert.match(JSON.parse(unknownScopedSections.body).error, /Unknown scope\.sub_cas_node_id/);

    const exportResponse = await requestBuffer(port, `/api/projects/${project.id}/cas/export`, token);
    assert.equal(exportResponse.statusCode, 200);
    assert.ok(exportResponse.body.length > 0);
    assert.ok(['brotli', 'zstd', 'none'].includes(String(exportResponse.headers['x-klauro-cas-codec'])));
    assert.match(String(exportResponse.headers['content-disposition']), /attachment/);

    // --- non-promoted honesty: a SEPARATE project pointing at a single-
    // deployable analysis must report promoted:false with no units, and
    // scoping it must be a 4xx request error, never a 200 no_analysis body ---
    const nonPromotedAnalysisHandle = 'das-http-non-promoted';
    const createNonPromotedRes = await request(port, 'POST', `/api/workspaces/${workspaceId}/projects`, {
      name: 'das-http-non-promoted-fixture',
      analysis_id: nonPromotedAnalysisHandle,
    }, token);
    assert.equal(createNonPromotedRes.statusCode, 201);
    const nonPromotedProject = JSON.parse(createNonPromotedRes.body).project as { id: string; analysis_id?: string };
    assert.ok(nonPromotedProject.analysis_id, 'authenticated project response should expose its attached analysis');

    const nonPromotedWorkspace = path.join(remoteData, 'workspaces', nonPromotedProject.analysis_id);
    await fs.promises.mkdir(nonPromotedWorkspace, { recursive: true });
    await saveAnalysis(nonPromotedWorkspace, completedFixture(buildNonPromotedCas(nonPromotedProject.analysis_id)));

    const dasNonPromoted = await request(port, 'GET', `/api/projects/${nonPromotedProject.id}/das`, undefined, token);
    assert.equal(dasNonPromoted.statusCode, 200);
    const dasNonPromotedBody = JSON.parse(dasNonPromoted.body);
    assert.equal(dasNonPromotedBody.status, 'ready');
    assert.equal(dasNonPromotedBody.sub_cas_nodes.promoted, false);
    assert.deepEqual(dasNonPromotedBody.sub_cas_nodes.units, []);
    // "1 found, below the threshold" must be legible over HTTP, not just an
    // empty list a caller has to read as "found nothing".
    assert.equal(dasNonPromotedBody.sub_cas_nodes.qualified_unit_count, 1);
    assert.equal(dasNonPromotedBody.sub_cas_nodes.promotion_threshold, 2);
    assert.match(dasNonPromotedBody.sub_cas_nodes.reason, /below the promotion threshold/);

    const scopeNonPromoted = await request(port, 'GET', `/api/projects/${nonPromotedProject.id}/cas?sub_cas_node_id=anything`, undefined, token);
    assert.equal(scopeNonPromoted.statusCode, 400, 'scoping a non-promoted repo must be a 4xx request error, not a 200 no_analysis body');
    const scopeNonPromotedBody = JSON.parse(scopeNonPromoted.body);
    assert.match(scopeNonPromotedBody.error, /has not promoted/);

    // --- membership gating: a project belonging to a DIFFERENT account must
    // 404, same as every sibling /api/projects/:id/* route ---
    const otherRegisterRes = await request(port, 'POST', '/api/auth/register', {
      email: 'das-http-other@example.com',
      password: 'password-1234',
      workspace_name: 'Other Workspace',
    });
    assert.equal(otherRegisterRes.statusCode, 201);
    const otherToken = JSON.parse(otherRegisterRes.body).token as string;
    const otherDas = await request(port, 'GET', `/api/projects/${project.id}/das`, undefined, otherToken);
    assert.equal(otherDas.statusCode, 404);
    const otherCas = await request(port, 'GET', `/api/projects/${project.id}/cas?sub_cas_node_id=${apiUnit.id}`, undefined, otherToken);
    assert.equal(otherCas.statusCode, 404);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousRemoteData === undefined) delete process.env.KLAURO_REMOTE_ANALYZER_DATA;
    else process.env.KLAURO_REMOTE_ANALYZER_DATA = previousRemoteData;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
