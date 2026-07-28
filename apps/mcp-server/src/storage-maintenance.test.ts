import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { pruneKlauroStorage } from './storage-maintenance';

test('storage pruning dry-runs generated benchmark artifacts without deleting analyses by default', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-prune-test-'));
  try {
    const generated = path.join(root, 'incremental-benchmark-workspaces', 'repo-copy');
    const analysisSnapshot = path.join(root, 'analyses', 'repo', 'snapshots', 'snapshot-old.json');
    await fs.ensureDir(generated);
    await fs.writeFile(path.join(generated, 'large.txt'), 'x'.repeat(100));
    await fs.ensureDir(path.dirname(analysisSnapshot));
    await fs.writeFile(analysisSnapshot, 'x'.repeat(100));

    const old = new Date(Date.now() - 10 * 86_400_000);
    await fs.utimes(generated, old, old);
    await fs.utimes(analysisSnapshot, old, old);

    const report = await pruneKlauroStorage({ root, olderThanDays: 7 });

    assert.equal(report.dry_run, true);
    assert.equal(report.candidate_count, 1);
    assert.equal(report.candidates[0].category, 'incremental-benchmark-workspaces');
    assert.equal(await fs.pathExists(generated), true);
    assert.equal(await fs.pathExists(analysisSnapshot), true);
  } finally {
    await fs.remove(root);
  }
});

test('storage pruning deletes only after explicit confirmation and can include repo-local artifacts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-prune-test-'));
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-prune-repo-'));
  try {
    const generated = path.join(root, 'agent-live-trials', 'trial-a');
    const local = path.join(repoRoot, '.klauro-scratch-live');
    await fs.ensureDir(generated);
    await fs.ensureDir(local);
    await fs.writeFile(path.join(generated, 'artifact.txt'), 'x');
    await fs.writeFile(path.join(local, 'artifact.txt'), 'x');

    const report = await pruneKlauroStorage({
      root,
      repoRoot,
      includeLocalArtifacts: true,
      olderThanDays: 0,
      confirm: true,
    });

    assert.equal(report.dry_run, false);
    assert.equal(report.candidate_count, 2);
    assert.equal(report.deleted.length, 2);
    assert.equal(await fs.pathExists(generated), false);
    assert.equal(await fs.pathExists(local), false);
  } finally {
    await fs.remove(root);
    await fs.remove(repoRoot);
  }
});

test('storage pruning can include generated temp proof and preview artifacts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-prune-test-'));
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-prune-temp-'));
  try {
    const tempProof = path.join(tempRoot, 'klauro-machine-proof-workspaces');
    const tempPreview = path.join(tempRoot, 'klauro-greenfield-preview-abc123');
    const unrelated = path.join(tempRoot, 'klauro-user-notes');
    await fs.ensureDir(tempProof);
    await fs.ensureDir(tempPreview);
    await fs.ensureDir(unrelated);
    await fs.writeFile(path.join(tempProof, 'artifact.txt'), 'x'.repeat(25));
    await fs.writeFile(path.join(tempPreview, 'artifact.txt'), 'x'.repeat(25));
    await fs.writeFile(path.join(unrelated, 'keep.txt'), 'x'.repeat(25));

    const report = await pruneKlauroStorage({
      root,
      tempRoot,
      includeTempArtifacts: true,
      olderThanDays: 0,
      confirm: true,
    });

    assert.equal(report.candidate_count, 2);
    assert.deepEqual(new Set(report.candidates.map(candidate => candidate.category)), new Set(['temp-artifacts']));
    assert.equal(await fs.pathExists(tempProof), false);
    assert.equal(await fs.pathExists(tempPreview), false);
    assert.equal(await fs.pathExists(unrelated), true);
  } finally {
    await fs.remove(root);
    await fs.remove(tempRoot);
  }
});

test('storage pruning can remove ephemeral analyses from the index without touching real repos', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-prune-test-'));
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-prune-temp-'));
  try {
    const analysesRoot = path.join(root, 'analyses');
    const tempProject = path.join(tempRoot, 'klauro-existing-task-proof-abc123', 'task-label-product-enhancement');
    const generatedProject = path.join(root, 'machine-proof-workspaces', 'machine-1', 'with-klauro');
    const realProject = path.join(os.homedir(), 'dev', 'real-product', 'api');
    const tempFile = 'task-label-product-enhancement-aaaaaaaaaaaa.json.zst';
    const generatedFile = 'with-klauro-bbbbbbbbbbbb.json.zst';
    const realFile = 'api-cccccccccccc.json.zst';
    const orphanDir = path.join(analysesRoot, 'old-generated-task-eeeeeeeeeeee');

    await fs.ensureDir(analysesRoot);
    await fs.ensureDir(projectStorageDir(analysesRoot, tempProject));
    await fs.ensureDir(projectStorageDir(analysesRoot, generatedProject));
    await fs.ensureDir(projectStorageDir(analysesRoot, realProject));
    await fs.ensureDir(orphanDir);
    await fs.writeFile(path.join(analysesRoot, tempFile), 'temp-analysis');
    await fs.writeFile(path.join(projectStorageDir(analysesRoot, tempProject), 'incremental-state.json'), 'temp-state');
    await fs.writeFile(path.join(analysesRoot, generatedFile), 'generated-analysis');
    await fs.writeFile(path.join(projectStorageDir(analysesRoot, generatedProject), 'incremental-state.json'), 'generated-state');
    await fs.writeFile(path.join(analysesRoot, realFile), 'real-analysis');
    await fs.writeFile(path.join(projectStorageDir(analysesRoot, realProject), 'incremental-state.json'), 'real-state');
    await fs.writeFile(path.join(orphanDir, 'incremental-state.json'), 'orphan-state');
    await fs.writeJson(path.join(analysesRoot, 'index.json'), {
      version: '2.0.0',
      analyses: {
        [tempProject]: { name: 'temp', file: tempFile, analyzed_at: '2026-01-01T00:00:00.000Z' },
        [generatedProject]: { name: 'generated', file: generatedFile, analyzed_at: '2026-01-01T00:00:00.000Z' },
        [realProject]: { name: 'real', file: realFile, analyzed_at: '2026-01-01T00:00:00.000Z' },
      },
    });

    const dryRun = await pruneKlauroStorage({
      root,
      tempRoot,
      includeEphemeralAnalyses: true,
      olderThanDays: 0,
    });

    assert.equal(dryRun.dry_run, true);
    assert.equal(dryRun.candidate_count, 3);
    assert.deepEqual(new Set(dryRun.candidates.map(candidate => candidate.index_path).filter(Boolean)), new Set([tempProject, generatedProject]));
    assert.equal(await fs.pathExists(path.join(analysesRoot, tempFile)), true);
    assert.equal(dryRun.candidates.some(candidate => candidate.category === 'orphan-analysis-storage'), true);

    const report = await pruneKlauroStorage({
      root,
      tempRoot,
      includeEphemeralAnalyses: true,
      olderThanDays: 0,
      confirm: true,
    });

    assert.equal(report.candidate_count, 3);
    assert.equal(await fs.pathExists(path.join(analysesRoot, tempFile)), false);
    assert.equal(await fs.pathExists(projectStorageDir(analysesRoot, tempProject)), false);
    assert.equal(await fs.pathExists(path.join(analysesRoot, generatedFile)), false);
    assert.equal(await fs.pathExists(projectStorageDir(analysesRoot, generatedProject)), false);
    assert.equal(await fs.pathExists(path.join(analysesRoot, realFile)), true);
    assert.equal(await fs.pathExists(projectStorageDir(analysesRoot, realProject)), true);
    assert.equal(await fs.pathExists(orphanDir), false);

    const index = await fs.readJson(path.join(analysesRoot, 'index.json'));
    assert.deepEqual(Object.keys(index.analyses), [realProject]);
  } finally {
    await fs.remove(root);
    await fs.remove(tempRoot);
  }
});

function projectStorageDir(analysesRoot: string, projectPath: string): string {
  const base = path.basename(projectPath)
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .substring(0, 80) || 'project';
  const hash = crypto.createHash('sha256').update(path.resolve(projectPath)).digest('hex').slice(0, 12);
  return path.join(analysesRoot, `${base}-${hash}`);
}
