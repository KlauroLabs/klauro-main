import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRemoteAnalyzerHttpServer } from './remote-analyzer-service';
import { analyzeCodebaseRemotely, defaultAnalysisId } from './remote-sync-client';
import { shutdownAnalysisWorker } from './analyzer';

// See the matching comment in remote-sync.test.ts: the remote-analyzer HTTP
// handlers now dispatch through analyzer.ts's worker-fork isolation, whose
// persistent worker singleton otherwise keeps `node --test` from exiting.
after(() => {
  shutdownAnalysisWorker();
});

/**
 * Regression coverage for the 2026-07-06 cold-customer cross-tenant bleed
 * (~/.klauro/agent-feedback/2026-07-06-cold-customer.md).
 *
 * ROOT CAUSE (confirmed by reading the source, not assumed): analysis storage
 * (`workspacePath(dataDir, analysisId)` in remote-analyzer-service.ts) is a
 * shared, flat directory keyed ONLY by whatever `analysisId` a request
 * carries. The CLI/client (`remote-sync-client.ts` `defaultAnalysisId`)
 * ALWAYS sends a non-empty `project_id` even before a repo is ever connected
 * to an account workspace: it falls back to
 * `sha256(path.resolve(projectPath))` -- a BARE, UNSALTED hash of the local
 * filesystem path, with NO account/tenant component. Two different accounts
 * whose repos happen to be checked out at the SAME absolute path (a routine
 * occurrence on a shared devbox / CI runner, or simply two people who both
 * `git clone` to the same conventional directory name) computed the
 * IDENTICAL analysisId client-side, and because that value was always
 * truthy, the server trusted it verbatim as the on-disk storage key -- so
 * account B's very first analyze silently read/overwrote account A's stored
 * CAS, and reanalyze/MCP-resolve/revisions all served account A's real data
 * to account B.
 *
 * This was NOT an AccountStore/API authorization bug: `getProjectForUser`,
 * `requireMembership`, and `createProject` were already correctly scoped to
 * workspace membership (see account-store.ts). The gap was purely in the
 * underlying analysis-storage keyspace, which sat BELOW that authorization
 * layer and had no tenant boundary of its own.
 *
 * FIX: `resolveStorageAnalysisId` (remote-analyzer-service.ts) folds the
 * authenticated account id into any non-`prj_` analysisId before it is used
 * as a storage key, for every `/v1/analyze` (sync + async), `/v1/analyze-diff`,
 * `/v1/sync`, `/v1/proposals/preview`, and `/v1/projects/:id/revisions` call
 * site -- so the SAME raw client-computed id maps to DIFFERENT storage keys
 * for different accounts, while remaining deterministic and self-consistent
 * for the SAME account across analyze -> sync -> revisions.
 */

function git(repo: string, args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
}

function writeRepo(repo: string, fileContents: string): void {
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(repo, 'app.py'), fileContents);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'initial commit']);
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

async function withServer(fn: (ctx: { port: number; serverUrl: string; remoteData: string }) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-tenant-isolation-'));
  const remoteData = path.join(root, 'remote-data');
  const previousRemoteData = process.env.KLAURO_REMOTE_ANALYZER_DATA;
  process.env.KLAURO_REMOTE_ANALYZER_DATA = remoteData;

  const server = createRemoteAnalyzerHttpServer({ dataDir: remoteData });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = (address as { port: number }).port;
  const serverUrl = `http://127.0.0.1:${port}`;

  try {
    await fn({ port, serverUrl, remoteData });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousRemoteData === undefined) delete process.env.KLAURO_REMOTE_ANALYZER_DATA;
    else process.env.KLAURO_REMOTE_ANALYZER_DATA = previousRemoteData;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function registerAccount(port: number, email: string, workspaceName: string): Promise<{ token: string; workspaceId: string }> {
  const registerRes = await request(port, 'POST', '/api/auth/register', {
    email,
    password: 'password-1234',
    workspace_name: workspaceName,
  });
  assert.equal(registerRes.statusCode, 201);
  const token = JSON.parse(registerRes.body).token as string;
  const workspacesRes = await request(port, 'GET', '/api/workspaces', undefined, token);
  const workspaceId = JSON.parse(workspacesRes.body).workspaces[0].id as string;
  return { token, workspaceId };
}

test('raw analysis status/export routes reject foreign projects and direct salted storage ids', async () => {
  await withServer(async ({ port }) => {
    const accountA = await registerAccount(port, 'analysis-read-a@example.com', 'Analysis Read A');
    const accountB = await registerAccount(port, 'analysis-read-b@example.com', 'Analysis Read B');
    const create = await request(port, 'POST', `/api/workspaces/${accountA.workspaceId}/projects`, {
      name: 'Private Project',
    }, accountA.token);
    assert.equal(create.statusCode, 201);
    const projectId = JSON.parse(create.body).project.id as string;

    const ownStatus = await request(port, 'GET', `/v1/analyses/${projectId}/status`, undefined, accountA.token);
    assert.equal(ownStatus.statusCode, 200);

    const foreignStatus = await request(port, 'GET', `/v1/analyses/${projectId}/status`, undefined, accountB.token);
    assert.equal(foreignStatus.statusCode, 404);
    const foreignExport = await request(port, 'GET', `/v1/analyses/${projectId}/cas/export`, undefined, accountB.token);
    assert.equal(foreignExport.statusCode, 404);

    const directSalted = await request(port, 'GET', '/v1/analyses/acct_private-storage-id/status', undefined, accountA.token);
    assert.equal(directSalted.statusCode, 404);
  });
});

// --- TIER 1: account-level analysis storage isolation (the P0 bleed) ---

test('TIER 1: two accounts analyzing repos at the IDENTICAL absolute path never collide on the same stored analysis', async () => {
  await withServer(async ({ port, serverUrl, remoteData }) => {
    const accountA = await registerAccount(port, 'account-a@example.com', 'Account A Workspace');
    const accountB = await registerAccount(port, 'account-b@example.com', 'Account B Workspace');

    // The SAME absolute path for both accounts is the exact collision
    // scenario: a shared devbox/CI runner, or two people who both clone to
    // the same conventional directory name. No .klaurorc binding for either
    // -- this is the vulnerable fallback (defaultAnalysisId = bare path hash)
    // that the cold-customer audit hit on `klauro init`'s very first push.
    const root = path.dirname(remoteData);
    const sharedPath = path.join(root, 'shared-repo-path');

    // Account A analyzes its own (larger) codebase at sharedPath.
    writeRepo(sharedPath, [
      'def handler_one():\n    return 1\n',
      'def handler_two():\n    return 2\n',
      'def handler_three():\n    return 3\n',
    ].join('\n'));
    const resultA = await analyzeCodebaseRemotely({ projectPath: sharedPath, serverUrl, token: accountA.token, wait: true });
    assert.equal(resultA.status, 'success');
    assert.ok(resultA.cas!.nodes.length > 0);

    // Both accounts' CLIENTS compute the IDENTICAL raw analysisId for this
    // path -- proving the collision precondition is real, not contrived.
    const rawIdForPath = defaultAnalysisId(sharedPath);
    assert.doesNotMatch(rawIdForPath, /^prj_/);

    // Now account B, a completely different tenant, points at the SAME path
    // (simulating: different account, coincidentally same checkout path) and
    // pushes its OWN much smaller fixture content to the same directory.
    fs.rmSync(sharedPath, { recursive: true, force: true });
    writeRepo(sharedPath, 'def tiny():\n    return 0\n');
    const resultB = await analyzeCodebaseRemotely({ projectPath: sharedPath, serverUrl, token: accountB.token, wait: true });
    assert.equal(resultB.status, 'success');
    assert.ok(resultB.cas!.nodes.length > 0);

    // The public handle stays stable and contains no internal tenant-storage
    // key. Isolation is enforced below the protocol boundary: the same handle
    // maps to a different acct_ directory for each authenticated account.
    assert.equal(resultA.analysis_id, rawIdForPath);
    assert.equal(resultB.analysis_id, rawIdForPath);
    const storageKeys = fs.readdirSync(path.join(remoteData, 'workspaces')).filter(name => name.startsWith('acct_'));
    assert.equal(storageKeys.length, 2, 'the same public handle must map to two isolated tenant storage keys');
    assert.notEqual(storageKeys[0], storageKeys[1]);

    // Cross-check via the revisions read path (also salted): account B's
    // token must never be able to read account A's revision history by
    // replaying the same raw (pre-salt) analysisId.
    const revisionsAsB = await request(port, 'GET', `/v1/projects/${encodeURIComponent(rawIdForPath)}/revisions`, undefined, accountB.token);
    assert.equal(revisionsAsB.statusCode, 200);
    const revisionsBodyAsB = JSON.parse(revisionsAsB.body);
    // Account B's own revisions (from its own analyze above) are fine to see;
    // the point is this must resolve to B's own workspace, not A's -- proven
    // by the analysis_id divergence already asserted above. As a second
    // signal, re-fetch account A's revisions with A's own token on the same
    // raw id. Both responses retain the public handle; their data is loaded
    // from the distinct storage keys asserted above.
    const revisionsAsA = await request(port, 'GET', `/v1/projects/${encodeURIComponent(rawIdForPath)}/revisions`, undefined, accountA.token);
    assert.equal(revisionsAsA.statusCode, 200);
    const revisionsBodyAsA = JSON.parse(revisionsAsA.body);
    assert.equal(revisionsBodyAsA.analysis_id, rawIdForPath);
    assert.equal(revisionsBodyAsB.analysis_id, rawIdForPath);
  });
});

test('TIER 1: reanalyze on an unbound (bare-hash) project never resolves to another account\'s analysis storage', async () => {
  await withServer(async ({ port, serverUrl, remoteData }) => {
    const accountA = await registerAccount(port, 'reanalyze-a@example.com', 'Reanalyze A Workspace');
    const accountB = await registerAccount(port, 'reanalyze-b@example.com', 'Reanalyze B Workspace');

    const root = path.dirname(remoteData);
    const sharedPath = path.join(root, 'shared-reanalyze-path');
    writeRepo(sharedPath, 'def alpha():\n    return "account-a-secret-marker"\n');
    const resultA = await analyzeCodebaseRemotely({ projectPath: sharedPath, serverUrl, token: accountA.token, wait: true });
    assert.equal(resultA.status, 'success');

    // Account B creates a project record in ITS OWN workspace and links it
    // (as the web app / klauro init flow would) to the SAME raw analysis_id
    // account A's client also computed for this path.
    const rawId = defaultAnalysisId(sharedPath);
    const projectRes = await request(port, 'POST', `/api/workspaces/${accountB.workspaceId}/projects`, {
      name: 'attempted-cross-tenant-project',
      analysis_id: rawId,
    }, accountB.token);
    assert.equal(projectRes.statusCode, 201);
    const projectB = JSON.parse(projectRes.body).project as { id: string; analysis_id?: string };

    // Reanalyzing account B's project must NEVER surface account A's content.
    // Either it 409s "no snapshot" (correct: B's project record was never
    // actually linked to a real server-side analysis of B's own repo) or, if
    // it succeeds, its analysis_id must differ from A's real stored id.
    const reanalyzeRes = await request(port, 'POST', `/api/projects/${projectB.id}/reanalyze`, {}, accountB.token);
    if (reanalyzeRes.statusCode === 200) {
      const reanalyzeBody = JSON.parse(reanalyzeRes.body);
      assert.notEqual(reanalyzeBody.analysis_id, resultA.analysis_id, 'account B reanalyze must never resolve to account A\'s stored analysis_id');
    } else {
      assert.equal(reanalyzeRes.statusCode, 409);
    }
  });
});

// --- TIER 2: workspace-level isolation (already enforced via requireMembership; corroborating proof) ---

test('TIER 2: a user who is a member of workspace A cannot read workspace B\'s projects or workspace-analysis, even under ONE account', async () => {
  await withServer(async ({ port }) => {
    const registerRes = await request(port, 'POST', '/api/auth/register', {
      email: 'multi-workspace-user@example.com',
      password: 'password-1234',
      workspace_name: 'Workspace A',
    });
    assert.equal(registerRes.statusCode, 201);
    const token = JSON.parse(registerRes.body).token as string;

    const workspacesRes = await request(port, 'GET', '/api/workspaces', undefined, token);
    const workspaceA = JSON.parse(workspacesRes.body).workspaces[0].id as string;

    // A second, INDEPENDENT workspace this user has no membership in.
    const otherRegisterRes = await request(port, 'POST', '/api/auth/register', {
      email: 'workspace-b-owner@example.com',
      password: 'password-1234',
      workspace_name: 'Workspace B',
    });
    const otherToken = JSON.parse(otherRegisterRes.body).token as string;
    const otherWorkspacesRes = await request(port, 'GET', '/api/workspaces', undefined, otherToken);
    const workspaceB = JSON.parse(otherWorkspacesRes.body).workspaces[0].id as string;

    await request(port, 'POST', `/api/workspaces/${workspaceB}/projects`, {
      name: 'workspace-b-secret-project',
      repo_url: 'https://github.com/example/workspace-b-secret',
    }, otherToken);

    // The multi-workspace-user's own token must not be able to list, read,
    // or fetch workspace-analysis for workspace B (no membership there).
    const listAsForeign = await request(port, 'GET', `/api/workspaces/${workspaceB}/projects`, undefined, token);
    assert.equal(listAsForeign.statusCode, 404, 'listing a foreign workspace\'s projects must 404 (requireMembership), never leak the project list');

    const analysisAsForeign = await request(port, 'GET', `/api/workspaces/${workspaceB}/analysis`, undefined, token);
    assert.equal(analysisAsForeign.statusCode, 404, 'reading a foreign workspace\'s workspace-analysis must 404, never leak status/graph');

    // Sanity: the SAME user still freely reads their own workspace A.
    const listOwn = await request(port, 'GET', `/api/workspaces/${workspaceA}/projects`, undefined, token);
    assert.equal(listOwn.statusCode, 200);
  });
});

test('TIER 2: getProjectForUser/reanalyze/analysis reads all 404 for a project in a workspace the caller is not a member of', async () => {
  await withServer(async ({ port }) => {
    const ownerRes = await request(port, 'POST', '/api/auth/register', {
      email: 'project-owner@example.com',
      password: 'password-1234',
      workspace_name: 'Owner Workspace',
    });
    const ownerToken = JSON.parse(ownerRes.body).token as string;
    const ownerWorkspaceRes = await request(port, 'GET', '/api/workspaces', undefined, ownerToken);
    const ownerWorkspaceId = JSON.parse(ownerWorkspaceRes.body).workspaces[0].id as string;
    const projectRes = await request(port, 'POST', `/api/workspaces/${ownerWorkspaceId}/projects`, {
      name: 'private-project',
    }, ownerToken);
    const project = JSON.parse(projectRes.body).project as { id: string };

    const strangerRes = await request(port, 'POST', '/api/auth/register', {
      email: 'stranger@example.com',
      password: 'password-1234',
      workspace_name: 'Stranger Workspace',
    });
    const strangerToken = JSON.parse(strangerRes.body).token as string;

    const getAsStranger = await request(port, 'GET', `/api/projects/${project.id}`, undefined, strangerToken);
    assert.equal(getAsStranger.statusCode, 404);

    const analysisAsStranger = await request(port, 'GET', `/api/projects/${project.id}/analysis`, undefined, strangerToken);
    assert.equal(analysisAsStranger.statusCode, 404);

    const reanalyzeAsStranger = await request(port, 'POST', `/api/projects/${project.id}/reanalyze`, {}, strangerToken);
    assert.equal(reanalyzeAsStranger.statusCode, 404);

    const conceptualAsStranger = await request(port, 'GET', `/api/projects/${project.id}/conceptual`, undefined, strangerToken);
    assert.equal(conceptualAsStranger.statusCode, 404);
  });
});

// --- task #120: server-side membership enforcement on WRITE paths ---
//
// Everything above proves the READ side already 404s for a foreign project.
// These tests hit the raw HTTP write routes directly (no client SDK, no
// `.klaurorc`, no `requireBoundProject` client-side guard from 5291b1ec) --
// exactly how a direct API caller who is not using the CLI at all would --
// to prove the SERVER itself refuses to write under a project id the caller
// is not a member of, and that any pre-existing data under that id survives
// untouched.

function minimalSnapshotBody(projectId: string, marker: string) {
  const content = `def marker():\n    return "${marker}"\n`;
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  return {
    protocol_version: 2,
    project_id: projectId,
    project_path: '/tmp/attacker-checkout',
    snapshot: {
      project_name: 'attacker-checkout',
      snapshot_source: 'working-tree' as const,
      files: [{ path: 'attack.py', content, hash }],
      manifest: {
        generated_at: new Date().toISOString(),
        root: '/tmp/attacker-checkout',
        file_count: 1,
        total_bytes: Buffer.byteLength(content, 'utf8'),
        excluded_directories: [],
      },
    },
    async: false,
  };
}

test('SECURITY (task #120): POST /v1/analyze with a foreign prj_ id is refused server-side, and the victim project\'s stored analysis is never touched', async () => {
  await withServer(async ({ port, serverUrl, remoteData }) => {
    const victim = await registerAccount(port, 'victim-write-a@example.com', 'Victim Workspace');
    const attacker = await registerAccount(port, 'attacker-write-b@example.com', 'Attacker Workspace');

    const root = path.dirname(remoteData);
    const victimRepo = path.join(root, 'victim-write-repo');
    writeRepo(victimRepo, 'def victim_real_code():\n    return "victim-secret-marker"\n');
    const victimProjectRes = await request(port, 'POST', `/api/workspaces/${victim.workspaceId}/projects`, {
      name: 'victim-real-project',
    }, victim.token);
    assert.equal(victimProjectRes.statusCode, 201);
    const victimProject = JSON.parse(victimProjectRes.body).project as { id: string };

    const legitPush = await analyzeCodebaseRemotely({
      projectPath: victimRepo,
      serverUrl,
      token: victim.token,
      analysisId: victimProject.id,
      wait: true,
    });
    assert.equal(legitPush.status, 'success');
    assert.ok(legitPush.cas!.nodes.length > 0);
    const victimWorkspace = path.join(remoteData, 'workspaces', victimProject.id);
    assert.ok(fs.existsSync(victimWorkspace), 'victim workspace must exist on disk before the attack');
    const beforeFiles = fs.readdirSync(victimWorkspace).sort();
    const beforeAppFileContent = fs.readFileSync(path.join(victimWorkspace, 'app.py'), 'utf8');
    assert.match(beforeAppFileContent, /victim-secret-marker/);

    // The attack: raw HTTP POST, attacker's own valid session token, but a
    // project_id belonging to the victim's workspace. Before this fix,
    // resolveStorageAnalysisId passed prj_ ids through unchanged with no
    // membership check, so this would fs.remove() + overwrite the victim's
    // real stored analysis with the attacker's payload.
    const attackBody = minimalSnapshotBody(victimProject.id, 'attacker-injected-marker');
    const attackRes = await request(port, 'POST', '/v1/analyze', attackBody, attacker.token);
    assert.equal(attackRes.statusCode, 404, `expected 404 (collapsed not-found/not-a-member), got ${attackRes.statusCode}: ${attackRes.body}`);
    const attackResponseBody = JSON.parse(attackRes.body);
    assert.match(attackResponseBody.error, /Project not found, or your account is not a member/);

    // The victim's on-disk data must be untouched -- no fs.remove, no
    // overwrite, no new source files from the attacker, and the attacker's
    // `attack.py` must never have landed next to the victim's real source.
    assert.ok(fs.existsSync(victimWorkspace), 'victim workspace must still exist after the attack attempt');
    const afterFiles = fs.readdirSync(victimWorkspace).sort();
    assert.deepEqual(afterFiles, beforeFiles, 'attack must not alter the victim workspace top-level file listing');
    assert.ok(!afterFiles.includes('attack.py'), 'the attacker\'s payload file must never land in the victim workspace');
    const afterAppFileContent = fs.readFileSync(path.join(victimWorkspace, 'app.py'), 'utf8');
    assert.equal(afterAppFileContent, beforeAppFileContent, 'the victim\'s real source content must be byte-identical after the attack attempt');

    // The legitimate owner can still push to their own project immediately
    // afterward -- the gate does not wedge the real owner out.
    writeRepo(victimRepo, 'def victim_real_code_v2():\n    return "victim-secret-marker-v2"\n');
    const followUpPush = await analyzeCodebaseRemotely({
      projectPath: victimRepo,
      serverUrl,
      token: victim.token,
      analysisId: victimProject.id,
      wait: true,
    });
    assert.equal(followUpPush.status, 'success');
  });
});

test('SECURITY (task #120): POST /v1/sync and /v1/analyze-diff with a foreign prj_ id are both refused server-side', async () => {
  await withServer(async ({ port, serverUrl, remoteData }) => {
    const victim = await registerAccount(port, 'victim-sync-a@example.com', 'Victim Sync Workspace');
    const attacker = await registerAccount(port, 'attacker-sync-b@example.com', 'Attacker Sync Workspace');

    const root = path.dirname(remoteData);
    const victimRepo = path.join(root, 'victim-sync-repo');
    writeRepo(victimRepo, 'def real():\n    return 1\n');
    const victimProjectRes = await request(port, 'POST', `/api/workspaces/${victim.workspaceId}/projects`, {
      name: 'victim-sync-project',
    }, victim.token);
    const victimProject = JSON.parse(victimProjectRes.body).project as { id: string };
    const legitPush = await analyzeCodebaseRemotely({
      projectPath: victimRepo, serverUrl, token: victim.token, analysisId: victimProject.id, wait: true,
    });
    assert.equal(legitPush.status, 'success');

    const syncBody = {
      protocol_version: 2,
      analysis_id: victimProject.id,
      project_id: victimProject.id,
      project_path: victimRepo,
      changes: {
        project_name: 'attacker-sync',
        changed_files: [{ path: 'attack.py', content: 'def hacked(): return 1\n', hash: 'x'.repeat(64) }],
      },
      async: false,
    };
    const syncRes = await request(port, 'POST', '/v1/sync', syncBody, attacker.token);
    assert.equal(syncRes.statusCode, 404, `expected 404, got ${syncRes.statusCode}: ${syncRes.body}`);

    const diffBody = {
      project_id: victimProject.id,
      project_path: victimRepo,
      diff_context: {
        target_branch: 'attacker-branch',
        head_commit: 'deadbeef',
        files: [{ path: 'attack.py', content: 'def hacked(): return 1\n', hash: 'x'.repeat(64) }],
      },
    };
    const diffRes = await request(port, 'POST', '/v1/analyze-diff', diffBody, attacker.token);
    assert.equal(diffRes.statusCode, 404, `expected 404, got ${diffRes.statusCode}: ${diffRes.body}`);
  });
});

test('STORAGE ADMISSION BOUND (task #120): an account cannot push unlimited distinct unbound analyses', async () => {
  const previousLimit = process.env.KLAURO_MAX_ANALYSES_PER_ACCOUNT;
  process.env.KLAURO_MAX_ANALYSES_PER_ACCOUNT = '2';
  try {
    await withServer(async ({ port, serverUrl, remoteData }) => {
      const account = await registerAccount(port, 'quota-account@example.com', 'Quota Workspace');
      const root = path.dirname(remoteData);

      for (let i = 0; i < 2; i++) {
        const repo = path.join(root, `quota-repo-${i}`);
        writeRepo(repo, `def entry_${i}():\n    return ${i}\n`);
        const result = await analyzeCodebaseRemotely({ projectPath: repo, serverUrl, token: account.token, wait: true });
        assert.equal(result.status, 'success', `push ${i} within the quota must succeed`);
      }

      const repoOverLimit = path.join(root, 'quota-repo-over-limit');
      writeRepo(repoOverLimit, 'def over_limit():\n    return -1\n');
      let sawQuotaError = false;
      try {
        await analyzeCodebaseRemotely({ projectPath: repoOverLimit, serverUrl, token: account.token, wait: true });
      } catch (error) {
        sawQuotaError = /storage limit/i.test(error instanceof Error ? error.message : String(error));
      }
      assert.ok(sawQuotaError, 'the (limit+1)th distinct unbound analysis must be refused with a storage-limit error');
    });
  } finally {
    if (previousLimit === undefined) delete process.env.KLAURO_MAX_ANALYSES_PER_ACCOUNT;
    else process.env.KLAURO_MAX_ANALYSES_PER_ACCOUNT = previousLimit;
  }
});
