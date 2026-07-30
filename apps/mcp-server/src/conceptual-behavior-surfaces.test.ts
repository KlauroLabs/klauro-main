import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRemoteAnalyzerHttpServer } from './remote-analyzer-service';
import { analyzeCodebaseRemotely } from './remote-sync-client';
import { getAnalysis } from './analyzer';
import { saveAnalysis } from './storage';

/**
 * GHOST FIX (klauro-surfaces-exposure, docs/SEMANTIC-MODEL.md): a flow's
 * capability_relationships may legitimately point at a behavior_surfaces
 * entry, not just a system_capabilities one (flow-concepts.ts's
 * buildTerminalFlows derives relationships against system_capabilities ∪
 * behavior_surfaces on purpose — a flow rooted at a registered
 * command/event/mcp-tool handler is genuinely owned by that surface). Before
 * this fix, GET /api/projects/:id/conceptual only serialized `capabilities`
 * from cas.system_capabilities, so a capability_id resolving to a surface was
 * a dangling id no consumer could ever resolve.
 *
 * This test drives the real HTTP path end to end: a small real repo is
 * analyzed (real entry points, real call chains, real derived flows), then a
 * behavior_surfaces entry is injected onto the stored CAS — its one operation
 * anchored on a REAL entry_point_id the analysis produced, exactly the shape
 * buildBehaviorCapabilities emits (see orchestrator.ts) — and the CAS is
 * re-saved through the product's own saveAnalysis storage path (not a
 * fabricated file format). The real /conceptual handler and the real
 * getFlowConcepts derivation then run unmodified: deriveCapabilityRelationships
 * (flow-concepts.ts) sees the surface's operation and links the real flow to
 * it exactly as it would for a real mcp_tool/command/event surface — this
 * test only substitutes WHICH capability the flow's own real entry point
 * happens to be evidenced by, not how the resolution or serialization work.
 */

function git(repo: string, args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
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

test('conceptual endpoint exposes behavior_surfaces so flow capability_relationships resolve', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-surfaces-conceptual-'));
  const repo = path.join(root, 'repo');
  const remoteData = path.join(root, 'remote-data');
  const previousRemoteData = process.env.KLAURO_REMOTE_ANALYZER_DATA;
  process.env.KLAURO_REMOTE_ANALYZER_DATA = remoteData;
  fs.mkdirSync(repo, { recursive: true });

  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(repo, 'app.py'), 'def create_order(order):\n    return save_order(order)\n\n\ndef save_order(order):\n    return order\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'initial commit']);

  const server = createRemoteAnalyzerHttpServer({ dataDir: remoteData });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  const serverUrl = `http://127.0.0.1:${port}`;

  try {
    const registerRes = await request(port, 'POST', '/api/auth/register', {
      email: 'surfaces-owner@example.com',
      password: 'password-1234',
      workspace_name: 'Surfaces Workspace',
    });
    assert.equal(registerRes.statusCode, 201);
    const token = JSON.parse(registerRes.body).token as string;

    const workspacesRes = await request(port, 'GET', '/api/workspaces', undefined, token);
    const workspaceId = JSON.parse(workspacesRes.body).workspaces[0].id as string;

    const analyzeResult = await analyzeCodebaseRemotely({ projectPath: repo, serverUrl, token, wait: true });
    assert.equal(analyzeResult.status, 'success');
    const createRes = await request(port, 'POST', `/api/workspaces/${workspaceId}/projects`, {
      name: 'surfaces-fixture',
      analysis_id: analyzeResult.analysis_id,
    }, token);
    assert.equal(createRes.statusCode, 201);
    const project = JSON.parse(createRes.body).project as { id: string; analysis_id?: string };
    assert.ok(project.analysis_id, 'authenticated project response should expose its attached analysis');

    // Project creation returns the account-scoped storage ID for the authorized attachment.
    const workspace = path.join(remoteData, 'workspaces', project.analysis_id);
    const cas = await getAnalysis(workspace);
    const anchorEntryPoint = cas.entry_points?.find(ep => ep.source_node && cas.nodes.some(n => n.id === ep.source_node));
    assert.ok(anchorEntryPoint, 'fixture analysis must produce at least one real entry point to anchor the fabricated surface on');
    // DEFECT (measured live, three repos): capabilities on this endpoint
    // never carried a `description` at all — 0/N described vs. get_product_map's
    // N/N on the exact same capability ids from the exact same analysis.
    // Stamp a description on a real derived capability (if the fixture
    // analysis produced one) so the regression below proves the endpoint now
    // forwards it, the same way it already forwards a surface's description.
    if (cas.system_capabilities && cas.system_capabilities.length > 0) {
      cas.system_capabilities[0].description = 'Fixture-injected capability description (test-only).';
      cas.system_capabilities[0].description_source = 'ai';
    }
    const surfaceId = 'cap_test_mcp_tool_surface';
    cas.behavior_surfaces = [
      ...(cas.behavior_surfaces || []),
      {
        id: surfaceId,
        name: 'Test Mcp Tool Surface',
        structural_label: 'Test Mcp Tool Surface',
        description: 'Fixture-injected registration surface (test-only) anchored on a real entry point.',
        description_source: 'deterministic',
        category: 'internal',
        operations: [{
          entry_point_id: anchorEntryPoint!.id,
          entry_point_type: anchorEntryPoint!.type,
          action: 'register',
        }],
        related_entities: [],
        related_domains: [],
        criticality: 'low',
        criticality_factors: ['test fixture'],
        evidence_kind: 'behavior-surface',
      },
    ];
    await saveAnalysis(workspace, cas);

    // max_flows high enough to include the flow the fabricated surface anchors on.
    const res = await request(port, 'GET', `/api/projects/${project.id}/conceptual?max_flows=50`, undefined, token);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'ready');

    // The surface must exist and be exposed as its own tier, not folded into
    // `capabilities` and not silently dropped.
    assert.ok(Array.isArray(body.behavior_surfaces), 'behavior_surfaces must be present once the CAS carries one');
    const mcpSurface = body.behavior_surfaces.find((s: any) => s.id === surfaceId);
    assert.ok(mcpSurface, `expected the fixture surface ${surfaceId} among ${JSON.stringify(body.behavior_surfaces.map((s: any) => s.id))}`);
    assert.equal(mcpSurface.name, 'Test Mcp Tool Surface');
    assert.equal(mcpSurface.evidence_kind, 'behavior-surface');

    // DEFECT regression: the conceptual surface must carry the same
    // description/description_source get_product_map already carries for the
    // identical capability id — previously absent (0 keys) on this endpoint.
    assert.equal(mcpSurface.description, 'Fixture-injected registration surface (test-only) anchored on a real entry point.');
    assert.equal(mcpSurface.description_source, 'deterministic');
    if (cas.system_capabilities && cas.system_capabilities.length > 0) {
      const describedCapability = body.capabilities.find((c: any) => c.id === cas.system_capabilities![0].id);
      assert.ok(describedCapability, 'expected the fixture-described capability in the response');
      assert.equal(describedCapability.description, 'Fixture-injected capability description (test-only).');
      assert.equal(describedCapability.description_source, 'ai');
    }

    // No dangling refs: every flow's capability_relationships[].capability_id
    // must resolve against capabilities ∪ behavior_surfaces.
    const knownIds = new Set<string>([
      ...body.capabilities.map((c: any) => c.id),
      ...body.behavior_surfaces.map((s: any) => s.id),
    ]);
    const flows = body.flows?.flows || [];
    assert.ok(flows.length > 0, 'expected at least one derived flow');
    let sawSurfaceRef = false;
    for (const flow of flows) {
      for (const rel of flow.capability_relationships || []) {
        assert.ok(
          knownIds.has(rel.capability_id),
          `flow ${flow.flow_id} references capability_id ${rel.capability_id}, which resolves against neither capabilities nor behavior_surfaces`
        );
        if (rel.capability_id === mcpSurface.id) sawSurfaceRef = true;
      }
    }
    assert.ok(sawSurfaceRef, 'expected at least one flow to relate to the mcp-tool surface directly');

    // And the surface's own related_flows edge is populated (same shape as
    // a capability's), proving the join is real, not a stub empty array.
    assert.ok(mcpSurface.related_flows.length > 0, 'surface must carry the flows that reference it');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousRemoteData === undefined) delete process.env.KLAURO_REMOTE_ANALYZER_DATA;
    else process.env.KLAURO_REMOTE_ANALYZER_DATA = previousRemoteData;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
