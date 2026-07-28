import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearChangeHistory, getProjectStorageDir, loadChangeHistory, saveAnalysis, saveAnalysisSnapshot, saveChangeHistoryEntry } from './storage';
import { CAS_VERSION, type CASOutput, type ChangeHistoryEntry } from '../../../packages/analyzer-core/src/types/cas.types';

function entry(id: string, timestamp: string): ChangeHistoryEntry {
  return {
    id,
    timestamp,
    source: 'automated',
    changes: { files: [], nodes: [], edges: [], entryPoints: [], exitPoints: [] },
    intent: { type: 'maintenance', confidence: 1, evidence: [] },
    impact: { affectedNodes: [], affectedEntryPoints: [], affectedExitPoints: [], affectedWorkflows: [], riskLevel: 'low', riskFactors: [] },
    suggestedActions: [],
    breakingChanges: [],
    minimumTestSet: [],
  } as unknown as ChangeHistoryEntry;
}

test('change history appends one compressed artifact per revision without rewriting a monolith', async () => {
  const previous = process.env.KLAURO_STORAGE_PATH;
  const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-change-history-'));
  process.env.KLAURO_STORAGE_PATH = storagePath;
  const projectPath = '/tmp/change-history-project';
  try {
    await saveChangeHistoryEntry(projectPath, entry('first', '2026-07-21T00:00:00.000Z'));
    await saveChangeHistoryEntry(projectPath, entry('second', '2026-07-22T00:00:00.000Z'));

    const projectDir = getProjectStorageDir(projectPath);
    const files = await fs.readdir(path.join(projectDir, 'change-history'));
    assert.equal(files.length, 2);
    assert.ok(files.every(file => /\.json\.(?:br|zst)$/.test(file)));
    assert.equal(await fs.pathExists(path.join(projectDir, 'change-history.json')), false);
    assert.deepEqual((await loadChangeHistory(projectPath)).map(item => item.id), ['second', 'first']);

    await clearChangeHistory(projectPath);
    assert.deepEqual(await loadChangeHistory(projectPath), []);
  } finally {
    if (previous === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previous;
    await fs.remove(storagePath);
  }
});

test('the first append compresses legacy history without dropping prior revisions', async () => {
  const previous = process.env.KLAURO_STORAGE_PATH;
  const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-change-history-migration-'));
  process.env.KLAURO_STORAGE_PATH = storagePath;
  const projectPath = '/tmp/change-history-migration-project';
  try {
    const projectDir = getProjectStorageDir(projectPath);
    await fs.ensureDir(projectDir);
    await fs.writeJson(path.join(projectDir, 'change-history.json'), [entry('legacy', '2026-07-20T00:00:00.000Z')]);
    await saveChangeHistoryEntry(projectPath, entry('current', '2026-07-22T00:00:00.000Z'));

    assert.equal(await fs.pathExists(path.join(projectDir, 'change-history.json')), false);
    assert.equal(
      (await Promise.all(['.zst', '.br'].map(suffix => fs.pathExists(path.join(projectDir, `change-history.json${suffix}`))))).some(Boolean),
      true,
    );
    assert.deepEqual((await loadChangeHistory(projectPath)).map(item => item.id), ['current', 'legacy']);
  } finally {
    if (previous === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previous;
    await fs.remove(storagePath);
  }
});

test('analysis snapshots reuse the byte-identical compressed current CAS', async () => {
  const previous = process.env.KLAURO_STORAGE_PATH;
  const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-snapshot-reuse-'));
  process.env.KLAURO_STORAGE_PATH = storagePath;
  const projectPath = '/tmp/snapshot-reuse-project';
  const output: CASOutput = {
    cas_version: CAS_VERSION,
    analysis_timestamp: '2026-07-22T00:00:00.000Z',
    analysis_id: 'snapshot-reuse',
    system: { id: 'system', name: 'snapshot-reuse', type: 'application', root_path: projectPath },
    nodes: [],
    edges: [],
    analyzer_contributions: [],
    progressive_levels: { total_levels: 0 },
  };
  try {
    const current = await saveAnalysis(projectPath, output);
    const snapshotId = await saveAnalysisSnapshot(projectPath, output);
    const snapshotFiles = await fs.readdir(path.join(getProjectStorageDir(projectPath), 'snapshots'));
    const snapshotFile = snapshotFiles.find(file => file.startsWith(snapshotId));
    assert.ok(snapshotFile);
    const [currentBytes, snapshotBytes] = await Promise.all([
      fs.readFile(path.join(storagePath, current.file)),
      fs.readFile(path.join(getProjectStorageDir(projectPath), 'snapshots', snapshotFile)),
    ]);
    assert.deepEqual(snapshotBytes, currentBytes);
  } finally {
    if (previous === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previous;
    await fs.remove(storagePath);
  }
});
