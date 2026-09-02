import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { buildSourceSnapshot, buildStreamingSourceSnapshot, buildStreamingWorkingTreeChanges, buildWorkingTreeChangeContext } from './remote-source';
import { createAnalyzeUploadRequest, createIncrementalUploadRequest } from './streaming-source-upload';
import { REMOTE_ANALYSIS_PROTOCOL_VERSION } from './remote-analyzer-protocol';

test('cold working-tree stream preserves every manifest and file fact', async () => {
  const root = fixture();
  try {
    const legacy = await buildSourceSnapshot(root);
    const plan = await buildStreamingSourceSnapshot(root);
    const parsed = await decode(createAnalyzeUploadRequest({ project_id: 'p', project_path: root, snapshot: plan, async: true, analysis_focus: 'agent-fast' }));
    assert.equal(parsed.protocol_version, REMOTE_ANALYSIS_PROTOCOL_VERSION);
    assert.equal(parsed.analysis_focus, 'agent-fast');
    assert.deepEqual(parsed.snapshot.files, legacy.files);
    assert.deepEqual(withoutTime(parsed.snapshot.manifest), withoutTime(legacy.manifest));
    assert.equal(parsed.snapshot.snapshot_source, legacy.snapshot_source);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('dirty committed-head stream excludes in-flight edits with byte parity', async () => {
  const root = fixture(true);
  try {
    fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const changed = "not shared";\n');
    const legacy = await buildSourceSnapshot(root);
    const plan = await buildStreamingSourceSnapshot(root);
    const parsed = await decode(createAnalyzeUploadRequest({ project_id: 'p', project_path: root, snapshot: plan, async: true }));
    assert.equal(parsed.snapshot.snapshot_source, 'committed-head');
    assert.deepEqual(parsed.snapshot.files, legacy.files);
    assert.deepEqual(withoutTime(parsed.snapshot.manifest), withoutTime(legacy.manifest));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('incremental stream preserves added, modified, deleted, diff, hashes, and manifest', async () => {
  const root = fixture(true);
  try {
    fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const changed = "yes";\n');
    fs.writeFileSync(path.join(root, 'new.py'), 'print("new")\n');
    fs.unlinkSync(path.join(root, 'README.md'));
    const legacy = await buildWorkingTreeChangeContext(root);
    const plan = await buildStreamingWorkingTreeChanges(root);
    const parsed = await decode(createIncrementalUploadRequest({ request_id: 'request-1', analysis_id: 'a', project_id: 'p', project_path: root, changes: plan, async: true }));
    assert.equal(parsed.protocol_version, REMOTE_ANALYSIS_PROTOCOL_VERSION);
    assert.equal(parsed.request_id, 'request-1');
    assert.deepEqual(parsed.changes.changed_files, legacy.changed_files);
    assert.equal(parsed.changes.git_diff, legacy.git_diff);
    assert.deepEqual(withoutTime(parsed.changes.manifest), withoutTime(legacy.manifest));
    assert.equal(parsed.changes.manifest.transfer_recommendation.operation, 'prepare_local_working_copy_context');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('source snapshots materialize a root product document symlink only when its target stays inside the repository', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-product-doc-symlink-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-product-doc-outside-'));
  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const app = true;\n');
    fs.writeFileSync(path.join(root, 'docs', 'README.md'), '# Product\n\nRoute requests to handlers.\n');
    fs.symlinkSync('docs/README.md', path.join(root, 'README.md'));

    const working = await buildStreamingSourceSnapshot(root);
    const workingReadme = working.files.find(file => file.path === 'README.md');
    assert.ok(workingReadme);
    assert.match(await workingReadme.readContent(), /Route requests to handlers/);

    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
    fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const app = false;\n');

    const committed = await buildStreamingSourceSnapshot(root);
    assert.equal(committed.snapshot_source, 'committed-head');
    const committedReadme = committed.files.find(file => file.path === 'README.md');
    assert.ok(committedReadme);
    assert.match(await committedReadme.readContent(), /Route requests to handlers/);
    const legacy = await buildSourceSnapshot(root);
    assert.match(legacy.files.find(file => file.path === 'README.md')?.content || '', /Route requests to handlers/);

    fs.unlinkSync(path.join(root, 'README.md'));
    fs.writeFileSync(path.join(outside, 'README.md'), '# Secret outside product\n');
    fs.symlinkSync(path.join(outside, 'README.md'), path.join(root, 'README.md'));
    execFileSync('git', ['add', 'README.md'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'external symlink'], { cwd: root });
    const guarded = await buildStreamingSourceSnapshot(root);
    assert.equal(guarded.files.some(file => file.path === 'README.md'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('packaging rejects a source mutation instead of sending mismatched content and hash', async () => {
  const root = fixture();
  try {
    const plan = await buildStreamingSourceSnapshot(root);
    fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const changedDuringPackaging = true;\n');
    const request = createAnalyzeUploadRequest({ project_id: 'p', project_path: root, snapshot: plan, async: true });
    await assert.rejects(() => request.prepare(), /Source changed while Klauro was packaging src\/app\.ts/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function fixture(commit = false): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-stream-parity-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const greeting = "héllo 🌎";\n');
  fs.writeFileSync(path.join(root, 'worker.rs'), 'fn main() { println!("hello"); }\n');
  fs.writeFileSync(path.join(root, 'service.go'), 'package main\n');
  fs.writeFileSync(path.join(root, 'infra.tf'), 'resource "x" "y" {}\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# Product\n');
  fs.writeFileSync(path.join(root, 'ignored.bin'), 'not source');
  if (commit) {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
  }
  return root;
}

async function decode(request: { prepare(): Promise<void>; createBody(): NodeJS.ReadableStream; dispose(): Promise<void> }): Promise<any> {
  await request.prepare();
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of request.createBody()) chunks.push(Buffer.from(chunk));
    return JSON.parse(gunzipSync(Buffer.concat(chunks)).toString('utf8'));
  } finally {
    await request.dispose();
  }
}

function withoutTime(manifest: object): Record<string, unknown> {
  const { generated_at: _generatedAt, ...stable } = manifest as Record<string, unknown>;
  return JSON.parse(JSON.stringify(stable));
}
