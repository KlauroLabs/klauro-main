import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRemoteAnalyzerHttpServer } from './remote-analyzer-service';
import { analyzeBranchDiffRemotely } from './remote-sync-client';
import { buildBranchDiffContext } from './remote-source';
import { loadAnalysis } from './storage';
import { shutdownAnalysisWorker } from './analyzer';

// See the matching comment in remote-sync.test.ts: the remote-analyzer HTTP
// handlers now dispatch through analyzer.ts's worker-fork isolation, whose
// persistent worker singleton otherwise keeps `node --test` from exiting.
after(() => {
  shutdownAnalysisWorker();
});

function git(repo: string, args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
}

test('buildBranchDiffContext returns only the branch-changed files with correct commits', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-diff-ctx-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  try {
    git(repo, ['init', '-b', 'main']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'base.py'), 'def base():\n    return 1\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'main commit']);

    git(repo, ['checkout', '-b', 'feature']);
    fs.writeFileSync(path.join(repo, 'feature.py'), 'def feature():\n    return 2\n');
    fs.appendFileSync(path.join(repo, 'base.py'), '\ndef also_base():\n    return 3\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'feature commit']);
    // Return to main so the branch is NOT checked out — proves git show works.
    git(repo, ['checkout', 'main']);

    const ctx = await buildBranchDiffContext(repo, 'feature');
    assert.equal(ctx.base_branch, 'main');
    assert.equal(ctx.target_branch, 'feature');
    const mergeBase = execFileSync('git', ['merge-base', 'main', 'feature'], { cwd: repo, encoding: 'utf8' }).trim();
    const head = execFileSync('git', ['rev-parse', 'feature'], { cwd: repo, encoding: 'utf8' }).trim();
    assert.equal(ctx.base_commit, mergeBase);
    assert.equal(ctx.head_commit, head);

    assert.deepEqual(ctx.changed_files.sort(), ['base.py', 'feature.py']);
    const featureEntry = ctx.files.find(file => file.path === 'feature.py');
    assert.ok(featureEntry, 'feature.py should be present in diff files');
    assert.match(featureEntry!.content, /def feature/);
    // base.py content must be read at the feature branch (includes the branch edit).
    const baseEntry = ctx.files.find(file => file.path === 'base.py');
    assert.ok(baseEntry);
    assert.match(baseEntry!.content, /also_base/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('POST /v1/analyze-diff analyzes the branch diff and saves under the other-branch track', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-diff-svc-'));
  const repo = path.join(root, 'repo');
  const storage = path.join(root, 'storage');
  const remoteData = path.join(root, 'remote-data');
  const previousStorage = process.env.KLAURO_STORAGE_PATH;
  const previousRemoteData = process.env.KLAURO_REMOTE_ANALYZER_DATA;
  process.env.KLAURO_STORAGE_PATH = storage;
  process.env.KLAURO_REMOTE_ANALYZER_DATA = remoteData;
  fs.mkdirSync(repo, { recursive: true });

  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(repo, 'base.py'), 'def base():\n    return 1\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'main commit']);
  git(repo, ['checkout', '-b', 'feature']);
  fs.writeFileSync(path.join(repo, 'feature_module.py'), 'def feature_endpoint():\n    return "branch-only"\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'feature commit']);
  git(repo, ['checkout', 'main']);

  // Open (no-token) in-process server, mirroring remote-sync.test.ts.
  const server = createRemoteAnalyzerHttpServer({ dataDir: remoteData });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const serverUrl = `http://127.0.0.1:${address.port}`;

  try {
    const account = await postJson(address.port, '/api/auth/register', {
      email: 'owner@example.com',
      password: 'password-1234',
      workspace_name: 'Branch Diff Workspace',
    });
    assert.equal(account.statusCode, 201);
    const token = JSON.parse(account.body).token as string;

    const response = await analyzeBranchDiffRemotely({ projectPath: repo, serverUrl, targetBranch: 'feature', token });
    assert.equal(response.status, 'success');
    assert.equal(response.cas.analyzed_track, 'other-branch');
    assert.equal(response.cas.diff_only, true);
    assert.ok(response.cas.nodes.length > 0, 'diff CAS should contain nodes');
    // The changed branch file must be represented in the analysis.
    const casJson = JSON.stringify(response.cas);
    assert.ok(casJson.includes('feature_module') || casJson.includes('feature_endpoint'),
      'CAS should reference the branch-changed file');

    // Saved under the other-branch track and readable back.
    const branchLoaded = await loadAnalysis(repo, { track: 'other-branch' });
    assert.ok(branchLoaded, 'other-branch analysis should be persisted');
    assert.equal(branchLoaded!.analyzed_track, 'other-branch');
    assert.equal(branchLoaded!.diff_only, true);

    // The main/default analysis is unaffected (nothing was written to 'main').
    const mainLoaded = await loadAnalysis(repo, { track: 'main' });
    assert.equal(mainLoaded, null, 'main track should remain untouched by a diff-only analysis');

    const auditLog = path.join(remoteData, 'audit', 'events.jsonl');
    assert.ok(fs.existsSync(auditLog));
    const auditEvents = fs.readFileSync(auditLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(auditEvents.some(event => event.event === 'analyze_diff'));
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousStorage === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previousStorage;
    if (previousRemoteData === undefined) delete process.env.KLAURO_REMOTE_ANALYZER_DATA;
    else process.env.KLAURO_REMOTE_ANALYZER_DATA = previousRemoteData;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function postJson(port: number, route: string, body: unknown): Promise<{ statusCode: number; body: string }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: route,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, response => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        responseBody += chunk;
      });
      response.on('end', () => resolve({ statusCode: response.statusCode || 0, body: responseBody }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}
