import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { buildAgentContextFreshness } from './agent-context-freshness';

const analyzedAt = '2026-09-01T00:00:00.000Z';

function workspace(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-citation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'target.ts'), 'export const value = 1;\n');
  return root;
}

test('captured input comparison detects changed content even when timestamps are old', t => {
  const root = workspace(t);
  const original = fs.readFileSync(path.join(root, 'target.ts'), 'utf8');
  const contributions = capturedContributions('target.ts', original);
  fs.writeFileSync(path.join(root, 'target.ts'), 'export const value = 2;\n');
  fs.utimesSync(path.join(root, 'target.ts'), 1, 1);
  const result = buildAgentContextFreshness(analyzedAt, root, ['target.ts'], 'target.ts', contributions);
  assert.equal(result.summary.source_input_comparison.mismatched.count, 1);
  assert.equal(result.summary.citation_verification, 'invalid');
  assert.equal(result.summary.files_changed_since_analysis.count, null);
  assert.match(result.target_file_note || '', /differs from captured/);
});

test('captured input matches do not certify complete analyzer provenance', t => {
  const root = workspace(t);
  const contributions = capturedContributions('target.ts', fs.readFileSync(path.join(root, 'target.ts'), 'utf8'));
  const result = buildAgentContextFreshness(analyzedAt, root, ['target.ts'], 'target.ts', contributions);
  assert.equal(result.summary.source_input_comparison.matched.count, 1);
  assert.equal(result.summary.newer_mtime_hints.count, 1);
  assert.equal(result.summary.citation_verification, 'unverified');
  assert.equal(result.requires_verification, true);
  assert.match(result.summary.warning, /matched.*captured inputs/i);
});

function capturedContributions(file: string, content: string) {
  return [{
    source_inputs: {
      version: 1, coverage: 'observed-reads', digest_algorithm: 'sha256', outside_root_reads: 0,
      files: [{ path: file, status: 'captured', representation: 'utf8-text',
        sha256: createHash('sha256').update(content).digest('hex'), bytes: Buffer.byteLength(content) }],
    },
  }];
}

test('identical copied content is not called changed because of its timestamp', t => {
  const root = workspace(t);
  fs.mkdirSync(path.join(root, '.git'));
  const result = buildAgentContextFreshness(analyzedAt, root, ['target.ts'], 'target.ts');
  assert.equal(result.summary.staleness, 'unknown');
  assert.equal(result.summary.files_changed_since_analysis.count, null);
  assert.equal(result.summary.files_deleted_since_analysis.count, null);
  assert.equal(result.summary.newer_mtime_hints.count, 1);
  assert.equal(result.summary.scan.method, 'stat');
  assert.equal(result.summary.citation_verification, 'unverified');
  assert.equal(result.requires_verification, true);
  assert.doesNotMatch(result.summary.warning, /changed after|were deleted|trustworthy/);
});

test('changed content with an old timestamp cannot become trusted', t => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, 'target.ts'), 'export const value = 2;\n');
  fs.utimesSync(path.join(root, 'target.ts'), 1, 1);
  const result = buildAgentContextFreshness(analyzedAt, root, ['target.ts'], 'target.ts');
  assert.equal(result.summary.staleness, 'unknown');
  assert.equal(result.summary.newer_mtime_hints.count, 0);
  assert.equal(result.summary.files_changed_since_analysis.count, null);
  assert.match(result.target_file_note || '', /identity.*unavailable/);
});

test('missing source is invalid now, not proof of when deletion happened', t => {
  const root = workspace(t);
  fs.unlinkSync(path.join(root, 'target.ts'));
  const result = buildAgentContextFreshness(analyzedAt, root, [], 'target.ts');
  assert.equal(result.summary.citation_verification, 'invalid');
  assert.equal(result.summary.files_missing_now.count, 1);
  assert.equal(result.summary.files_deleted_since_analysis.count, null);
  assert.match(result.target_file_note || '', /deletion timing is unknown/);
});

test('unavailable workspace does not turn every citation into a deletion', t => {
  const root = path.join(workspace(t), 'unavailable');
  const result = buildAgentContextFreshness(analyzedAt, root, ['one.ts', 'two.ts']);
  assert.equal(result.summary.staleness, 'unknown');
  assert.equal(result.summary.files_missing_now.count, 0);
  assert.equal(result.summary.unverified_files.count, 2);
  assert.equal(result.summary.unverified_files.examples[0].reason, 'workspace-unavailable');
});

test('permission errors remain explicit errors rather than missing files', t => {
  const root = workspace(t);
  const actualStat = fs.statSync;
  t.mock.method(fs, 'statSync', (...args: Parameters<typeof fs.statSync>) => {
    if (args[0] === path.join(root, 'target.ts')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return actualStat(...args);
  });
  const result = buildAgentContextFreshness(analyzedAt, root, ['target.ts']);
  assert.equal(result.summary.files_missing_now.count, 0);
  assert.deepEqual(result.summary.unverified_files.examples, [
    { file: 'target.ts', reason: 'file-check-error', error_code: 'EACCES' },
  ]);
});

test('non-files and symlink errors do not become deletions', t => {
  const root = workspace(t);
  fs.mkdirSync(path.join(root, 'folder'));
  fs.symlinkSync('loop', path.join(root, 'loop'));
  const result = buildAgentContextFreshness(analyzedAt, root, ['folder', 'loop']);
  assert.equal(result.summary.files_missing_now.count, 0);
  assert.deepEqual(result.summary.unverified_files.examples, [
    { file: 'folder', reason: 'not-a-regular-file' },
    { file: 'loop', reason: 'file-check-error', error_code: 'ELOOP' },
  ]);
});

test('paths and symlinks outside the workspace are not inspected as source', t => {
  const root = workspace(t);
  const outside = workspace(t);
  fs.symlinkSync(outside, path.join(root, 'external'));
  const result = buildAgentContextFreshness(analyzedAt, root, [
    '../outside.ts', path.join(outside, 'target.ts'), 'external/target.ts', 'C:\\outside\\target.ts',
  ]);
  assert.equal(result.summary.files_missing_now.count, 0);
  assert.equal(result.summary.unverified_files.count, 4);
  assert.ok(result.summary.unverified_files.examples.every(item => item.reason === 'outside-workspace'));
});

test('bounded checks disclose every citation that was not checked', t => {
  const root = workspace(t);
  const files = Array.from({ length: 25 }, (_, index) => `file-${index}.ts`);
  for (const file of files) fs.writeFileSync(path.join(root, file), 'export {};\n');
  const result = buildAgentContextFreshness(analyzedAt, root, files, files[24]);
  assert.equal(result.summary.scan.cited_files, 25);
  assert.equal(result.summary.scan.check_limit, 20);
  assert.equal(result.summary.unverified_files.count, 25);
  assert.equal(result.summary.unchecked_files.count, 5);
  assert.equal(result.summary.unverified_files.examples[0].file, files[24]);
  assert.equal(result.summary.unverified_files.examples.length, 5);
  assert.equal(result.requires_verification, true);
});

test('unknown analysis time never suppresses freshness uncertainty', t => {
  const root = workspace(t);
  for (const timestamp of [undefined, '', 'invalid']) {
    const result = buildAgentContextFreshness(timestamp, root, ['target.ts']);
    assert.equal(result.summary.age, 'unknown');
    assert.equal(result.summary.staleness, 'unknown');
    assert.equal(result.summary.newer_mtime_hints.count, 0);
    assert.equal(result.requires_verification, true);
  }
});

test('an empty citation set is not a proof of current content', t => {
  const result = buildAgentContextFreshness(analyzedAt, workspace(t), []);
  assert.equal(result.summary.scan.cited_files, 0);
  assert.equal(result.summary.staleness, 'unknown');
  assert.equal(result.requires_verification, true);
});

test('metadata verification never rereads source content as alleged analyzed bytes', t => {
  const root = workspace(t);
  t.mock.method(fs, 'readFileSync', () => { throw new Error('unexpected source read'); });
  const result = buildAgentContextFreshness(analyzedAt, root, ['target.ts']);
  assert.equal(result.summary.unverified_files.examples[0].reason, 'analyzed-content-identity-unavailable');
  assert.ok(result.summary.scan.duration_ms >= 0);
});
