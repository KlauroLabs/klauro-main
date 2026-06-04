import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRemoteAnalyzerHttpServer } from './remote-analyzer-service';
import { analyzeCodebaseRemotely, syncWorkingTreeRemotely } from './remote-sync-client';
import { getAnalysis } from './analyzer';

const repoRoot = path.resolve(__dirname, '..');
const fixturePath = path.join(repoRoot, 'fixtures', 'analysis-truth', 'fastapi-sqlalchemy');

test('remote analyzer supports full source upload and dirty-tree incremental sync', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-remote-sync-test-'));
  const repo = path.join(root, 'repo');
  const storage = path.join(root, 'storage');
  const remoteData = path.join(root, 'remote-data');
  const previousStorage = process.env.KLAURO_STORAGE_PATH;
  const previousRemoteData = process.env.KLAURO_REMOTE_ANALYZER_DATA;

  process.env.KLAURO_STORAGE_PATH = storage;
  process.env.KLAURO_REMOTE_ANALYZER_DATA = remoteData;
  fs.cpSync(fixturePath, repo, { recursive: true });
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repo, stdio: 'ignore' });

  const server = createRemoteAnalyzerHttpServer({ dataDir: remoteData });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const serverUrl = `http://127.0.0.1:${address.port}`;

  try {
    const full = await analyzeCodebaseRemotely({ projectPath: repo, serverUrl });
    assert.equal(full.status, 'success');
    assert.equal(full.analysis_type, 'full');
    assert.ok(full.cas.nodes.length > 0);
    assert.ok((await getAnalysis(repo)).nodes.length > 0);

    const appFile = path.join(repo, 'app', 'main.py');
    fs.appendFileSync(appFile, '\n\n@app.get("/healthz")\ndef healthz():\n    return {"ok": True}\n');
    const incremental = await syncWorkingTreeRemotely({ projectPath: repo, serverUrl, analysisId: full.analysis_id });

    assert.equal(incremental.status, 'success');
    assert.equal(incremental.analysis_type, 'incremental');
    assert.ok(incremental.change_report);
    assert.ok((incremental.change_report?.summary.filesAdded || 0) + (incremental.change_report?.summary.filesModified || 0) > 0);
    const cached = await getAnalysis(repo);
    assert.ok((cached.entry_points || []).some(entry => JSON.stringify(entry).includes('healthz')));
    const auditLog = path.join(remoteData, 'audit', 'events.jsonl');
    assert.ok(fs.existsSync(auditLog));
    const auditEvents = fs.readFileSync(auditLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(auditEvents.some(event => event.event === 'analyze'));
    assert.ok(auditEvents.some(event => event.event === 'sync'));
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousStorage === undefined) {
      delete process.env.KLAURO_STORAGE_PATH;
    } else {
      process.env.KLAURO_STORAGE_PATH = previousStorage;
    }
    if (previousRemoteData === undefined) {
      delete process.env.KLAURO_REMOTE_ANALYZER_DATA;
    } else {
      process.env.KLAURO_REMOTE_ANALYZER_DATA = previousRemoteData;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
