import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRemoteAnalyzerHttpServer } from './remote-analyzer-service';
import { analyzeCodebaseRemotely, syncWorkingTreeRemotely } from './remote-sync-client';
import { aiService } from '../../../packages/analyzer-core/src/ai/ai-service';
import { AccountWorkspaceAnalysisScheduler, isCasComprehensionSettled, workspaceInputSignature } from './account-workspace-analysis';

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

function makeRepo(root: string, name: string, fileContents: string): string {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(repo, 'app.py'), fileContents);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'initial commit']);
  return repo;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000, intervalMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitFor timed out');
}

test('workspace comprehension waits for a pending L5 member and treats ready or failed L5 as terminal', () => {
  assert.equal(isCasComprehensionSettled({ ai_enrichment: 'pending' }), false);
  assert.equal(isCasComprehensionSettled({ layers_ready: { layers: [{ layer: 'L0', status: 'ready' }] } }), false);
  assert.equal(isCasComprehensionSettled({ layers_ready: { layers: [{ layer: 'L5', status: 'pending' }] } }), false);
  assert.equal(isCasComprehensionSettled({ ai_enrichment: 'ready', layers_ready: { layers: [{ layer: 'L5', status: 'ready' }] } }), true);
  assert.equal(isCasComprehensionSettled({ ai_enrichment: 'error', layers_ready: { layers: [{ layer: 'L5', status: 'error' }] } }), true);
  assert.equal(isCasComprehensionSettled({ analysis_timestamp: 'legacy-synchronous' }), true);
});

test('workspace input signature is order-independent and changes when a member comprehension layer settles', () => {
  const pending = {
    analysis_id: 'analysis-a', analysis_timestamp: '2026-07-22T00:00:00.000Z', ai_enrichment: 'pending',
    layers_ready: { layers: [{ layer: 'L5', status: 'pending' }] }, nodes: [], edges: [], system: { primary_capabilities: [] },
  } as any;
  const ready = {
    ...pending, ai_enrichment: 'ready',
    layers_ready: { layers: [{ layer: 'L5', status: 'ready', completed_at: '2026-07-22T00:00:05.000Z' }] },
    system: { description: 'AI description', primary_capabilities: [{ name: 'Manage orders', description: 'Processes orders.', description_source: 'ai' }] },
  } as any;
  const other = { ...ready, analysis_id: 'analysis-b', analysis_timestamp: '2026-07-22T00:00:01.000Z' } as any;
  const a = workspaceInputSignature([{ path: 'a', name: 'A', cas: pending }, { path: 'b', name: 'B', cas: other }], ['project-a', 'project-b']);
  const reordered = workspaceInputSignature([{ path: 'b', name: 'B', cas: other }, { path: 'a', name: 'A', cas: pending }], ['project-b', 'project-a']);
  const settled = workspaceInputSignature([{ path: 'a', name: 'A', cas: ready }, { path: 'b', name: 'B', cas: other }], ['project-a', 'project-b']);
  assert.equal(a, reordered);
  assert.notEqual(a, settled);
});

test('workspace scheduler drains a project notification that arrives during an in-flight rebuild', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-was-dirty-drain-'));
  try {
    const scheduler = new AccountWorkspaceAnalysisScheduler(root, {} as any, { debounceMs: 10 });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let rebuilds = 0;
    (scheduler as any).doRebuild = async () => {
      rebuilds += 1;
      if (rebuilds === 1) await firstGate;
    };

    const first = scheduler.rebuild('workspace-race');
    scheduler.notifyProjectAnalysisLanded('workspace-race');
    // The condition under test IS isPending('workspace-race') — poll for it
    // directly rather than sleeping a fixed 30ms and hoping the notification
    // had settled by then.
    await waitFor(async () => scheduler.isPending('workspace-race'));
    assert.equal(scheduler.isPending('workspace-race'), true, 'the concurrent notification must remain visible while the first rebuild runs');

    releaseFirst();
    await first;
    await waitFor(async () => !scheduler.isPending('workspace-race'));

    assert.equal(rebuilds, 2, 'the change that arrived in flight must be consumed by exactly one coalesced follow-up rebuild');
    assert.equal(scheduler.isPending('workspace-race'), false, 'no dirty or pending state may remain after both runs complete');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace scheduler close cancels pending and follow-up rebuilds', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-was-close-'));
  try {
    const debounceMs = 10;
    const scheduler = new AccountWorkspaceAnalysisScheduler(root, {} as any, { debounceMs });
    let rebuilds = 0;
    (scheduler as any).doRebuild = async () => { rebuilds += 1; };

    scheduler.notifyProjectAnalysisLanded('workspace-closing');
    assert.equal(scheduler.isPending('workspace-closing'), true);
    scheduler.close();
    assert.equal(scheduler.isPending('workspace-closing'), false);

    await new Promise(resolve => setTimeout(resolve, debounceMs * 3));
    assert.equal(rebuilds, 0);
    assert.equal(await scheduler.rebuild('workspace-closing'), null);

    const inFlightScheduler = new AccountWorkspaceAnalysisScheduler(root, {} as any, { debounceMs });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    (inFlightScheduler as any).doRebuild = async () => {
      rebuilds += 1;
      await gate;
    };
    const inFlight = inFlightScheduler.rebuild('workspace-in-flight');
    inFlightScheduler.notifyProjectAnalysisLanded('workspace-in-flight');
    inFlightScheduler.close();
    release();
    await inFlight;
    assert.equal(rebuilds, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Server-side auto-refreshed workspace-level CAS: pushing member project
 * analyses for an account workspace should automatically (re)build a
 * workspace analysis from the STORED member CAS analyses — no separate
 * "run workspace analysis" call needed, matching the user's expectation that
 * "those should be automatic whenever a sub-project changes." Multiple
 * pushes in quick succession must debounce/coalesce into a single rebuild,
 * and the rebuild must never block or fail the analyze response itself.
 */
test('workspace analysis auto-builds once from stored member analyses after a debounced batch push, and GET is honest', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-auto-was-'));
  const remoteData = path.join(root, 'remote-data');
  const previousRemoteData = process.env.KLAURO_REMOTE_ANALYZER_DATA;
  const previousDebounce = process.env.KLAURO_WORKSPACE_ANALYSIS_DEBOUNCE_MS;
  const previousInterpretation = process.env.KLAURO_AI_INTERPRETATION;
  const previousWorkspaceAi = process.env.KLAURO_WORKSPACE_AI_ENRICHMENT;
  process.env.KLAURO_REMOTE_ANALYZER_DATA = remoteData;
  process.env.KLAURO_WORKSPACE_ANALYSIS_DEBOUNCE_MS = '150';
  // Comprehension is AI-only and THROWS without a provider. This test exercises
  // workspace auto-build orchestration on Camp-B STRUCTURE, not comprehension, so
  // run it structure-only (no AI provider is configured in CI).
  process.env.KLAURO_AI_INTERPRETATION = 'false';
  process.env.KLAURO_WORKSPACE_AI_ENRICHMENT = 'false';

  const server = createRemoteAnalyzerHttpServer({ dataDir: remoteData });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  const serverUrl = `http://127.0.0.1:${port}`;

  try {
    const registerRes = await request(port, 'POST', '/api/auth/register', {
      email: 'owner@example.com',
      password: 'password-1234',
      workspace_name: 'Auto WAS Workspace',
    });
    assert.equal(registerRes.statusCode, 201);
    const token = JSON.parse(registerRes.body).token as string;

    const workspacesRes = await request(port, 'GET', '/api/workspaces', undefined, token);
    const workspaceId = JSON.parse(workspacesRes.body).workspaces[0].id as string;

    // GET before anything exists must be honest: 'none', never a crash or empty-but-lying 200.
    const beforeRes = await request(port, 'GET', `/api/workspaces/${workspaceId}/analysis`, undefined, token);
    assert.equal(beforeRes.statusCode, 200);
    assert.equal(JSON.parse(beforeRes.body).status, 'none');

    // Push 2 member project analyses in quick succession (a "batch push").
    const repoA = makeRepo(root, 'repo-a', 'def handler_a():\n    return 1\n');
    const repoB = makeRepo(root, 'repo-b', 'def handler_b():\n    return 2\n');

    const analyzeA = await analyzeCodebaseRemotely({ projectPath: repoA, serverUrl, token, wait: true, readinessRequirement: 'structural' });
    const analyzeB = await analyzeCodebaseRemotely({ projectPath: repoB, serverUrl, token, wait: true, readinessRequirement: 'structural' });

    // Link both analyses to account projects in this workspace (the
    // `klauro init` reconnect shape: project.analysis_id set at creation).
    const projectARes = await request(port, 'POST', `/api/workspaces/${workspaceId}/projects`, {
      name: 'repo-a',
      analysis_id: analyzeA.analysis_id,
    }, token);
    assert.equal(projectARes.statusCode, 201);
    const projectA = JSON.parse(projectARes.body).project as { id: string };

    const projectBRes = await request(port, 'POST', `/api/workspaces/${workspaceId}/projects`, {
      name: 'repo-b',
      analysis_id: analyzeB.analysis_id,
    }, token);
    assert.equal(projectBRes.statusCode, 201);
    const projectB = JSON.parse(projectBRes.body).project as { id: string };

    // Re-push both analyses (simulating a second analyze pass on each repo,
    // now that they're linked) within the debounce window — this is the
    // "5-repo batch push -> ~1 rebuild" scenario, scaled to 2 repos x 2 pushes.
    await analyzeCodebaseRemotely({ projectPath: repoA, serverUrl, token, analysisId: analyzeA.analysis_id, wait: true, readinessRequirement: 'structural' });
    await analyzeCodebaseRemotely({ projectPath: repoB, serverUrl, token, analysisId: analyzeB.analysis_id, wait: true, readinessRequirement: 'structural' });

    // Immediately after landing, before the debounce timer fires, the GET
    // must report 'pending' rather than silently serving nothing.
    const pendingRes = await request(port, 'GET', `/api/workspaces/${workspaceId}/analysis`, undefined, token);
    assert.equal(pendingRes.statusCode, 200);
    assert.ok(['pending', 'ready'].includes(JSON.parse(pendingRes.body).status));

    await waitFor(async () => {
      const res = await request(port, 'GET', `/api/workspaces/${workspaceId}/analysis`, undefined, token);
      return JSON.parse(res.body).status === 'ready';
    });

    const readyRes = await request(port, 'GET', `/api/workspaces/${workspaceId}/analysis`, undefined, token);
    assert.equal(readyRes.statusCode, 200);
    const readyBody = JSON.parse(readyRes.body);
    assert.equal(readyBody.status, 'ready');
    assert.equal(readyBody.workspace_id, workspaceId);
    // Membership must match EXACTLY the workspace's analyzed (linked) projects.
    const memberIds = [...readyBody.member_project_ids].sort();
    assert.deepEqual(memberIds, [projectA.id, projectB.id].sort());
    assert.equal(readyBody.analysis.codebase_count, 2);
    assert.ok(readyBody.analysis.nodes || readyBody.analysis.codebases?.length === 2);

    // A brand-new, unrelated workspace (no linked/analyzed projects) must
    // never see this workspace's data — evidence-gated membership only.
    const otherRegisterRes = await request(port, 'POST', '/api/auth/register', {
      email: 'other@example.com',
      password: 'password-1234',
      workspace_name: 'Other Workspace',
    });
    const otherToken = JSON.parse(otherRegisterRes.body).token as string;
    const otherWorkspacesRes = await request(port, 'GET', '/api/workspaces', undefined, otherToken);
    const otherWorkspaceId = JSON.parse(otherWorkspacesRes.body).workspaces[0].id as string;
    const otherRes = await request(port, 'GET', `/api/workspaces/${otherWorkspaceId}/analysis`, undefined, otherToken);
    assert.equal(otherRes.statusCode, 200);
    assert.equal(JSON.parse(otherRes.body).status, 'none');

    // Cross-workspace access must be denied (404), not leak data.
    const crossRes = await request(port, 'GET', `/api/workspaces/${workspaceId}/analysis`, undefined, otherToken);
    assert.equal(crossRes.statusCode, 404);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousRemoteData === undefined) delete process.env.KLAURO_REMOTE_ANALYZER_DATA;
    else process.env.KLAURO_REMOTE_ANALYZER_DATA = previousRemoteData;
    if (previousDebounce === undefined) delete process.env.KLAURO_WORKSPACE_ANALYSIS_DEBOUNCE_MS;
    else process.env.KLAURO_WORKSPACE_ANALYSIS_DEBOUNCE_MS = previousDebounce;
    if (previousInterpretation === undefined) delete process.env.KLAURO_AI_INTERPRETATION;
    else process.env.KLAURO_AI_INTERPRETATION = previousInterpretation;
    if (previousWorkspaceAi === undefined) delete process.env.KLAURO_WORKSPACE_AI_ENRICHMENT;
    else process.env.KLAURO_WORKSPACE_AI_ENRICHMENT = previousWorkspaceAi;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * POST /api/workspaces/{id}/reanalyze — the product surface for refreshing a
 * server-side workspace-level CAS WITH AI narrative enrichment. The live-prod gap this guards
 * against: auto-built workspace-level-CAS records shipped with workspace_narrative.source =
 * 'ai-required-degraded' (empty description) and there was NO endpoint to
 * re-run the workspace with enrichment attached. Asserts: (1) 202 accepted
 * immediately, (2) the rebuild runs in the background and persists a record
 * whose narrative source is 'ai' when the AI enrichment pass succeeds,
 * (3) workspace isolation — a non-member gets 404, never a scheduled rebuild.
 */
test('workspace reanalyze returns 202, background-persists an AI-enriched narrative, and is workspace-isolated', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-was-reanalyze-'));
  const remoteData = path.join(root, 'remote-data');
  const previousRemoteData = process.env.KLAURO_REMOTE_ANALYZER_DATA;
  const previousDebounce = process.env.KLAURO_WORKSPACE_ANALYSIS_DEBOUNCE_MS;
  const previousInterpretation = process.env.KLAURO_AI_INTERPRETATION;
  const previousWorkspaceAi = process.env.KLAURO_WORKSPACE_AI_ENRICHMENT;
  const previousAutoConfig = process.env.KLAURO_WORKSPACE_AI_AUTO_CONFIG;
  const previousOllamaBaseUrl = process.env.OLLAMA_BASE_URL;
  const previousOllamaAuto = process.env.KLAURO_OLLAMA_AUTO;
  process.env.KLAURO_REMOTE_ANALYZER_DATA = remoteData;
  process.env.KLAURO_WORKSPACE_ANALYSIS_DEBOUNCE_MS = '150';
  // Enrichment must be ENABLED for this test: the scheduler's env gate decides
  // whether the AI pass is even attempted. The model call itself is mocked at
  // the aiService seam (same pattern as cross-codebase-analysis.test.ts), so
  // this asserts the server-side WIRING: attach -> background -> persist 'ai'.
  process.env.KLAURO_AI_INTERPRETATION = 'true';
  process.env.KLAURO_WORKSPACE_AI_ENRICHMENT = 'true';
  process.env.KLAURO_WORKSPACE_AI_AUTO_CONFIG = 'false';
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.KLAURO_OLLAMA_AUTO;

  // Grounded-narrative mock: long enough (>=180 chars), concrete surfaces
  // (http/api/service/server/client/route), behavior verbs (routes/records/
  // returns/handles/provides/supports), and none of the ungrounded product
  // frames the workspace-level-CAS quality gate rejects — so the real
  // enrichWorkspaceAnalysisNarrative pass accepts it and stamps source 'ai'.
  const enrichedDescription = 'Repo-reanalyze calculates totals through its observed application behavior and returns the resulting values. The workspace presents that total-calculation behavior, preserves its ownership by repo-reanalyze, and explains how callers retrieve the calculated result through the analyzed capability.';
  const originalGenerate = aiService.generateComponentDescription;
  let delayedWorkspaceCall = false;
  aiService.generateComponentDescription = async (request: any) => {
    const context = request?.additionalContext || {};
    if (/cataloging the/i.test(String(context.task || ''))) {
      const entities: Array<{ name?: string }> = Array.isArray(context.facts?.entities) ? context.facts.entities : [];
      const candidateAreas: Array<{ name?: string }> = Array.isArray(context.facts?.candidate_route_areas) ? context.facts.candidate_route_areas : [];
      const subjects = entities.length > 0 ? entities : candidateAreas;
      return JSON.stringify({
        capabilities: subjects.slice(0, 8).map(subject => ({
          name: `Retrieve ${String(subject.name || 'calculated totals').replace(/([a-z])([A-Z])/g, '$1 $2')}`,
          description: `Returns ${subject.name || 'calculated totals'} for the observed application workflow.`,
          category: 'core',
          entities: subject.name && entities.length > 0 ? [subject.name] : [],
          journeys: [],
        })),
      });
    }
    const domainNames = Array.isArray(context.required_domain_names) ? context.required_domain_names : [];
    const capabilityNames = Array.isArray(context.required_capability_names) ? context.required_capability_names : [];
    if (Array.isArray(context.items) || /system_description/.test(String(context.task || ''))) {
      const items: Array<{ id: string; name?: string }> = Array.isArray(context.items) ? context.items : [];
      const grounding = [
        ...(Array.isArray(context.structuralTokens) ? context.structuralTokens : []),
        ...(Array.isArray(context.frameworks) ? context.frameworks : []),
      ].slice(0, 6).join(', ') || 'registered application behavior';
      return JSON.stringify({
        system_description: `This system retrieves calculated totals through an observed application entry and returns them to callers. It connects each supported calculation to analyzed handler behavior grounded in ${grounding}. It executes the evidenced total calculation and returns the resulting value without inventing additional product behavior. The implementation exposes that calculation through its registered application behavior.`,
        domain: 'total-calculation',
        descriptions: items.map(item => ({ id: item.id, description: `${item.name || item.id} retrieves the calculated total and returns the result to callers.` })),
        quality_check: { used_facts: [], unsupported_claims: [] },
      });
    }
    const targetDomains: Array<{ name?: string; grounding_terms?: string[] }> = Array.isArray(context.target_domains) ? context.target_domains : [];
    const targetCapabilities: Array<{ name?: string; grounding_terms?: string[] }> = Array.isArray(context.target_capabilities) ? context.target_capabilities : [];
    if (targetDomains.length > 0 || targetCapabilities.length > 0) {
      const describe = (target: { name?: string; grounding_terms?: string[] }) => {
        const name = String(target.name || 'Totals');
        return `${name} describes how repo-reanalyze retrieves calculated totals and returns those values to callers through its observed behavior.`;
      };
      return JSON.stringify({
        domain_items: targetDomains.map(target => ({ name: target.name, description: describe(target) })),
        capability_items: targetCapabilities.map(target => ({ name: target.name, description: describe(target) })),
      });
    }
    // Keep the manual rebuild in flight past the attach-triggered debounce.
    // This reproduces the production race where the debounce joined an
    // existing rebuild and left its dirty bit stranded forever.
    //
    // NOT a condition poll: by design the debounced attempt JOINS the
    // in-flight rebuild rather than re-invoking this mock, so there is no
    // second, observable event to poll for here — the race only reproduces
    // if this mock's own elapsed time outlasts the debounce window itself.
    // Tied explicitly to KLAURO_WORKSPACE_ANALYSIS_DEBOUNCE_MS (set to '150'
    // above) with margin, rather than an unexplained magic number.
    if (!delayedWorkspaceCall) {
      delayedWorkspaceCall = true;
      const debounceMs = Number(process.env.KLAURO_WORKSPACE_ANALYSIS_DEBOUNCE_MS) || 150;
      await new Promise(resolve => setTimeout(resolve, debounceMs * 2));
    }
    return JSON.stringify({
      description: enrichedDescription,
      product_value_summary: 'Totals from repo-reanalyze.',
      value_drivers: ['Calculated total retrieval'],
      relationship_summary: [],
      domain_items: domainNames.map((name: string) => ({
        name,
        description: `${name} describes how repo-reanalyze retrieves calculated totals and returns those values to callers through its observed behavior.`,
      })),
      capability_items: capabilityNames.map((name: string) => ({
        name,
        description: `${name} describes how repo-reanalyze retrieves calculated totals and returns those values to callers through its observed behavior.`,
      })),
    });
  };

  const server = createRemoteAnalyzerHttpServer({ dataDir: remoteData });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  const serverUrl = `http://127.0.0.1:${port}`;

  try {
    const registerRes = await request(port, 'POST', '/api/auth/register', {
      email: 'owner@example.com',
      password: 'password-1234',
      workspace_name: 'Reanalyze WAS Workspace',
    });
    assert.equal(registerRes.statusCode, 201);
    const token = JSON.parse(registerRes.body).token as string;

    const workspacesRes = await request(port, 'GET', '/api/workspaces', undefined, token);
    const workspaceId = JSON.parse(workspacesRes.body).workspaces[0].id as string;

    const repo = makeRepo(root, 'repo-reanalyze', "from fastapi import FastAPI\n\napp = FastAPI()\n\n@app.get('/totals')\ndef calculate_total():\n    return {'total': 1}\n");
    fs.writeFileSync(path.join(repo, 'requirements.txt'), 'fastapi==0.116.1\n');
    const analyzed = await analyzeCodebaseRemotely({ projectPath: repo, serverUrl, token, wait: true, readinessRequirement: 'structural' });
    const projectRes = await request(port, 'POST', `/api/workspaces/${workspaceId}/projects`, {
      name: 'repo-reanalyze',
      analysis_id: analyzed.analysis_id,
    }, token);
    assert.equal(projectRes.statusCode, 201);

    // The refresh surface: 202 immediately, never blocking on the rebuild.
    const reanalyzeRes = await request(port, 'POST', `/api/workspaces/${workspaceId}/reanalyze`, {}, token);
    assert.equal(reanalyzeRes.statusCode, 202, 'workspace reanalyze must accept immediately, never block on the WAS rebuild');
    const reanalyzeBody = JSON.parse(reanalyzeRes.body);
    assert.equal(reanalyzeBody.status, 'accepted');
    assert.equal(reanalyzeBody.workspace_id, workspaceId);

    // Background rebuild + enrichment persist: poll until the record is ready
    // AND the narrative is AI-written (the deterministic first persist may be
    // observed as ready with enrichment still pending — progressive availability).
    let lastWorkspaceBody: any;
    try {
      await waitFor(async () => {
        const res = await request(port, 'GET', `/api/workspaces/${workspaceId}/analysis`, undefined, token);
        const body = JSON.parse(res.body);
        lastWorkspaceBody = body;
        return body.status === 'ready' && body.analysis?.workspace_narrative?.source === 'ai';
      });
    } catch (error) {
      assert.fail(`${error instanceof Error ? error.message : String(error)}: ${JSON.stringify(lastWorkspaceBody)}`);
    }
    const readyRes = await request(port, 'GET', `/api/workspaces/${workspaceId}/analysis`, undefined, token);
    const readyBody = JSON.parse(readyRes.body);
    assert.equal(readyBody.analysis.workspace_narrative.source, 'ai');
    // The enrichment pass may normalize punctuation (e.g. hyphens) in the
    // accepted description — match on content, not byte equality.
    assert.match(readyBody.analysis.workspace_narrative.description, /calculates totals through its observed application behavior/);
    assert.equal(readyBody.analysis.workspace_narrative.degraded_reason, undefined);
    assert.equal(readyBody.enrichment?.status, 'ai', JSON.stringify({ enrichment: readyBody.enrichment, domains: readyBody.analysis.workspace_domains, capabilities: readyBody.analysis.workspace_capabilities }));
    assert.ok(readyBody.enrichment?.completed_at);
    assert.equal(readyBody.status, 'ready', 'a debounce that joins an in-flight rebuild must not strand the workspace in pending');

    // Workspace isolation: a non-member must get 404, and no rebuild may be
    // scheduled on their behalf.
    const otherRegisterRes = await request(port, 'POST', '/api/auth/register', {
      email: 'other@example.com',
      password: 'password-1234',
      workspace_name: 'Other Workspace',
    });
    const otherToken = JSON.parse(otherRegisterRes.body).token as string;
    const crossRes = await request(port, 'POST', `/api/workspaces/${workspaceId}/reanalyze`, {}, otherToken);
    assert.equal(crossRes.statusCode, 404);
  } finally {
    aiService.generateComponentDescription = originalGenerate;
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousRemoteData === undefined) delete process.env.KLAURO_REMOTE_ANALYZER_DATA;
    else process.env.KLAURO_REMOTE_ANALYZER_DATA = previousRemoteData;
    if (previousDebounce === undefined) delete process.env.KLAURO_WORKSPACE_ANALYSIS_DEBOUNCE_MS;
    else process.env.KLAURO_WORKSPACE_ANALYSIS_DEBOUNCE_MS = previousDebounce;
    if (previousInterpretation === undefined) delete process.env.KLAURO_AI_INTERPRETATION;
    else process.env.KLAURO_AI_INTERPRETATION = previousInterpretation;
    if (previousWorkspaceAi === undefined) delete process.env.KLAURO_WORKSPACE_AI_ENRICHMENT;
    else process.env.KLAURO_WORKSPACE_AI_ENRICHMENT = previousWorkspaceAi;
    if (previousAutoConfig === undefined) delete process.env.KLAURO_WORKSPACE_AI_AUTO_CONFIG;
    else process.env.KLAURO_WORKSPACE_AI_AUTO_CONFIG = previousAutoConfig;
    if (previousOllamaBaseUrl === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = previousOllamaBaseUrl;
    if (previousOllamaAuto === undefined) delete process.env.KLAURO_OLLAMA_AUTO;
    else process.env.KLAURO_OLLAMA_AUTO = previousOllamaAuto;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * WORKSPACE-LEVEL-CAS AUTO-REBUILD REGRESSION (fresh v1.0.126 self-analysis): a member CAS
 * landed via `/v1/sync` (the incremental "dirty tree" push `sync_
 * codebase_remote` uses once a project already has an analysis_id — the
 * common case after the FIRST `/v1/analyze`) — but `notifyProjectAnalysisLanded`
 * was only ever wired into `/v1/analyze` and `/api/projects/:id/reanalyze`.
 * A workspace whose member is refreshed exclusively via `/v1/sync` after its
 * initial push therefore never got marked dirty, and the server-side workspace-level CAS sat
 * stale until someone manually called POST /api/workspaces/{id}/reanalyze.
 * This pins that `/v1/sync` ALSO triggers the debounced auto-rebuild, with no
 * manual reanalyze call anywhere in the test.
 */
test('a member CAS landed via /v1/sync (not just /v1/analyze) still triggers the debounced WAS auto-rebuild', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-was-sync-trigger-'));
  const remoteData = path.join(root, 'remote-data');
  const previousRemoteData = process.env.KLAURO_REMOTE_ANALYZER_DATA;
  const previousDebounce = process.env.KLAURO_WORKSPACE_ANALYSIS_DEBOUNCE_MS;
  const previousInterpretation = process.env.KLAURO_AI_INTERPRETATION;
  const previousWorkspaceAi = process.env.KLAURO_WORKSPACE_AI_ENRICHMENT;
  process.env.KLAURO_REMOTE_ANALYZER_DATA = remoteData;
  process.env.KLAURO_WORKSPACE_ANALYSIS_DEBOUNCE_MS = '150';
  process.env.KLAURO_AI_INTERPRETATION = 'false';
  process.env.KLAURO_WORKSPACE_AI_ENRICHMENT = 'false';

  const server = createRemoteAnalyzerHttpServer({ dataDir: remoteData });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  const serverUrl = `http://127.0.0.1:${port}`;

  try {
    const registerRes = await request(port, 'POST', '/api/auth/register', {
      email: 'owner@example.com',
      password: 'password-1234',
      workspace_name: 'Sync Trigger Workspace',
    });
    assert.equal(registerRes.statusCode, 201);
    const token = JSON.parse(registerRes.body).token as string;

    const workspacesRes = await request(port, 'GET', '/api/workspaces', undefined, token);
    const workspaceId = JSON.parse(workspacesRes.body).workspaces[0].id as string;

    const repo = makeRepo(root, 'repo-sync-trigger', 'def handler():\n    return 1\n');
    const analyzed = await analyzeCodebaseRemotely({ projectPath: repo, serverUrl, token, wait: true, readinessRequirement: 'structural' });
    const projectRes = await request(port, 'POST', `/api/workspaces/${workspaceId}/projects`, {
      name: 'repo-sync-trigger',
      analysis_id: analyzed.analysis_id,
    }, token);
    assert.equal(projectRes.statusCode, 201);

    // Attaching an already-analyzed project is itself a workspace-level-CAS input change and
    // now builds the initial workspace automatically.
    await waitFor(async () => {
      const res = await request(port, 'GET', `/api/workspaces/${workspaceId}/analysis`, undefined, token);
      return JSON.parse(res.body).status === 'ready';
    });
    const beforeRes = await request(port, 'GET', `/api/workspaces/${workspaceId}/analysis`, undefined, token);
    const beforeGeneratedAt = JSON.parse(beforeRes.body).generated_at as string;
    assert.ok(beforeGeneratedAt);

    // A real dirty-tree change, then an INCREMENTAL /v1/sync push — never a
    // second /v1/analyze and never a manual /api/workspaces/:id/reanalyze
    // call anywhere in this test.
    fs.writeFileSync(path.join(repo, 'app.py'), 'def handler():\n    return 2\n');
    await syncWorkingTreeRemotely({ projectPath: repo, serverUrl, token, analysisId: analyzed.analysis_id });

    // The debounced auto-rebuild must fire on its own from the /v1/sync push alone.
    await waitFor(async () => {
      const res = await request(port, 'GET', `/api/workspaces/${workspaceId}/analysis`, undefined, token);
      const body = JSON.parse(res.body);
      return body.status === 'ready' && body.generated_at !== beforeGeneratedAt;
    });
    const readyRes = await request(port, 'GET', `/api/workspaces/${workspaceId}/analysis`, undefined, token);
    const readyBody = JSON.parse(readyRes.body);
    assert.equal(readyBody.status, 'ready');
    assert.equal(readyBody.workspace_id, workspaceId);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousRemoteData === undefined) delete process.env.KLAURO_REMOTE_ANALYZER_DATA;
    else process.env.KLAURO_REMOTE_ANALYZER_DATA = previousRemoteData;
    if (previousDebounce === undefined) delete process.env.KLAURO_WORKSPACE_ANALYSIS_DEBOUNCE_MS;
    else process.env.KLAURO_WORKSPACE_ANALYSIS_DEBOUNCE_MS = previousDebounce;
    if (previousInterpretation === undefined) delete process.env.KLAURO_AI_INTERPRETATION;
    else process.env.KLAURO_AI_INTERPRETATION = previousInterpretation;
    if (previousWorkspaceAi === undefined) delete process.env.KLAURO_WORKSPACE_AI_ENRICHMENT;
    else process.env.KLAURO_WORKSPACE_AI_ENRICHMENT = previousWorkspaceAi;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Instant-degrade honesty (live "Clients" workspace regression): when the AI
 * layer short-circuits without a real model round-trip (feature-disabled canned
 * string / empty response), the workspace-level-CAS record must land in enrichment status
 * 'error' with the real cause — never a fake "rejected by the workspace-level-CAS quality gate"
 * degrade produced in milliseconds without an attempt.
 */
test('a short-circuited AI attempt persists an honest enrichment error, not a fake quality-gate degrade', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-was-honest-error-'));
  const remoteData = path.join(root, 'remote-data');
  const previousRemoteData = process.env.KLAURO_REMOTE_ANALYZER_DATA;
  const previousDebounce = process.env.KLAURO_WORKSPACE_ANALYSIS_DEBOUNCE_MS;
  const previousInterpretation = process.env.KLAURO_AI_INTERPRETATION;
  const previousWorkspaceAi = process.env.KLAURO_WORKSPACE_AI_ENRICHMENT;
  const previousAutoConfig = process.env.KLAURO_WORKSPACE_AI_AUTO_CONFIG;
  const previousOllamaBaseUrl = process.env.OLLAMA_BASE_URL;
  const previousOllamaAuto = process.env.KLAURO_OLLAMA_AUTO;
  process.env.KLAURO_REMOTE_ANALYZER_DATA = remoteData;
  process.env.KLAURO_WORKSPACE_ANALYSIS_DEBOUNCE_MS = '150';
  process.env.KLAURO_AI_INTERPRETATION = 'true';
  process.env.KLAURO_WORKSPACE_AI_ENRICHMENT = 'true';
  process.env.KLAURO_WORKSPACE_AI_AUTO_CONFIG = 'false';
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.KLAURO_OLLAMA_AUTO;

  // The ai-service returns its feature-disabled canned string instantly —
  // exactly the no-attempt short-circuit class behind the 104ms live degrade.
  const originalGenerate = aiService.generateComponentDescription;
  aiService.generateComponentDescription = async () => 'AI description generation is disabled';

  const server = createRemoteAnalyzerHttpServer({ dataDir: remoteData });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  const serverUrl = `http://127.0.0.1:${port}`;

  try {
    const registerRes = await request(port, 'POST', '/api/auth/register', {
      email: 'owner@example.com',
      password: 'password-1234',
      workspace_name: 'Honest Error WAS Workspace',
    });
    assert.equal(registerRes.statusCode, 201);
    const token = JSON.parse(registerRes.body).token as string;

    const workspacesRes = await request(port, 'GET', '/api/workspaces', undefined, token);
    const workspaceId = JSON.parse(workspacesRes.body).workspaces[0].id as string;

    const repo = makeRepo(root, 'repo-honest-error', 'def handler():\n    return 1\n');
    const analyzed = await analyzeCodebaseRemotely({ projectPath: repo, serverUrl, token, wait: true, readinessRequirement: 'structural' });
    const projectRes = await request(port, 'POST', `/api/workspaces/${workspaceId}/projects`, {
      name: 'repo-honest-error',
      analysis_id: analyzed.analysis_id,
    }, token);
    assert.equal(projectRes.statusCode, 201);

    const reanalyzeRes = await request(port, 'POST', `/api/workspaces/${workspaceId}/reanalyze`, {}, token);
    assert.equal(reanalyzeRes.statusCode, 202);

    await waitFor(async () => {
      const res = await request(port, 'GET', `/api/workspaces/${workspaceId}/analysis`, undefined, token);
      const body = JSON.parse(res.body);
      return body.status === 'ready' && ['error', 'degraded', 'ai'].includes(body.enrichment?.status);
    });
    const readyRes = await request(port, 'GET', `/api/workspaces/${workspaceId}/analysis`, undefined, token);
    const readyBody = JSON.parse(readyRes.body);
    // The terminal state must be an honest ERROR naming the no-attempt cause...
    assert.equal(readyBody.enrichment?.status, 'error');
    assert.match(String(readyBody.enrichment?.error || ''), /no real attempt/i);
    // ...and the narrative must never claim a quality-gate rejection happened.
    assert.ok(!/rejected by the workspace narrative quality gate/i.test(String(readyBody.analysis?.workspace_narrative?.degraded_reason || '')),
      `no fake gate rejection allowed: ${readyBody.analysis?.workspace_narrative?.degraded_reason}`);
  } finally {
    aiService.generateComponentDescription = originalGenerate;
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousRemoteData === undefined) delete process.env.KLAURO_REMOTE_ANALYZER_DATA;
    else process.env.KLAURO_REMOTE_ANALYZER_DATA = previousRemoteData;
    if (previousDebounce === undefined) delete process.env.KLAURO_WORKSPACE_ANALYSIS_DEBOUNCE_MS;
    else process.env.KLAURO_WORKSPACE_ANALYSIS_DEBOUNCE_MS = previousDebounce;
    if (previousInterpretation === undefined) delete process.env.KLAURO_AI_INTERPRETATION;
    else process.env.KLAURO_AI_INTERPRETATION = previousInterpretation;
    if (previousWorkspaceAi === undefined) delete process.env.KLAURO_WORKSPACE_AI_ENRICHMENT;
    else process.env.KLAURO_WORKSPACE_AI_ENRICHMENT = previousWorkspaceAi;
    if (previousAutoConfig === undefined) delete process.env.KLAURO_WORKSPACE_AI_AUTO_CONFIG;
    else process.env.KLAURO_WORKSPACE_AI_AUTO_CONFIG = previousAutoConfig;
    if (previousOllamaBaseUrl === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = previousOllamaBaseUrl;
    if (previousOllamaAuto === undefined) delete process.env.KLAURO_OLLAMA_AUTO;
    else process.env.KLAURO_OLLAMA_AUTO = previousOllamaAuto;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
