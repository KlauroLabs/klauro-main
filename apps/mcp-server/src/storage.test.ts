import { strict as assert } from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import {
  getProjectStorageDir,
  getStorageHealth,
  listAgenticBenchmarkReports,
  listAnalysisSnapshots,
  loadAnalysis,
  saveAgenticBenchmarkReport,
  saveAnalysis,
  saveAnalysisSnapshot,
} from './storage';

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

test('analysis snapshot retention is count and byte bounded', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-storage-test-'));
  const projectPath = path.join(root, 'repo');
  const storagePath = path.join(root, 'storage');
  const previousStoragePath = process.env.KLAURO_STORAGE_PATH;
  const previousMaxSnapshots = process.env.KLAURO_MAX_SNAPSHOTS;
  const previousMaxBytes = process.env.KLAURO_MAX_SNAPSHOT_BYTES;
  const previousCompression = process.env.KLAURO_ANALYSIS_COMPRESSION;

  process.env.KLAURO_STORAGE_PATH = storagePath;
  process.env.KLAURO_MAX_SNAPSHOTS = '2';
  process.env.KLAURO_MAX_SNAPSHOT_BYTES = '900';
  process.env.KLAURO_ANALYSIS_COMPRESSION = 'none';

  try {
    await fs.ensureDir(projectPath);

    for (let index = 0; index < 4; index++) {
      await saveAnalysisSnapshot(projectPath, {
        analysis_timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        nodes: [{ id: `node-${index}`, kind: 'function', name: 'Example', file_path: 'src/example.ts', payload: 'x'.repeat(700) }],
        edges: [],
        system: { name: 'repo', type: 'application', technologies: { languages: [], frameworks: [], databases: [], external_services: [] } },
      } as unknown as CASOutput);
    }

    const snapshots = await listAnalysisSnapshots(projectPath);
    const snapshotFiles = await fs.readdir(path.join(getProjectStorageDir(projectPath), 'snapshots'));

    assert.equal(snapshots.length, 1);
    assert.equal(snapshotFiles.filter(file => file.endsWith('.json') || file.endsWith('.json.br') || file.endsWith('.json.zst')).length, 1);
    assert.equal(snapshots[0].timestamp, '2026-01-01T00:00:03.000Z');
  } finally {
    restoreEnv('KLAURO_STORAGE_PATH', previousStoragePath);
    restoreEnv('KLAURO_MAX_SNAPSHOTS', previousMaxSnapshots);
    restoreEnv('KLAURO_MAX_SNAPSHOT_BYTES', previousMaxBytes);
    restoreEnv('KLAURO_ANALYSIS_COMPRESSION', previousCompression);
    await fs.remove(root);
  }
});

test('analysis storage writes compressed CAS and reads legacy json fallback', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-compressed-analysis-test-'));
  const projectPath = path.join(root, 'repo');
  const storagePath = path.join(root, 'storage');
  const previousStoragePath = process.env.KLAURO_STORAGE_PATH;
  const previousCompression = process.env.KLAURO_ANALYSIS_COMPRESSION;

  process.env.KLAURO_STORAGE_PATH = storagePath;
  process.env.KLAURO_ANALYSIS_COMPRESSION = 'brotli';

  try {
    await fs.ensureDir(projectPath);
    const cas = {
      analysis_timestamp: '2026-01-01T00:00:00.000Z',
      nodes: [{ id: 'node-1', kind: 'function', name: 'Example', file_path: 'src/example.ts' }],
      edges: [],
      system: { name: 'repo', type: 'application', technologies: { languages: [], frameworks: [], databases: [], external_services: [] } },
    } as unknown as CASOutput;

    const entry = await saveAnalysis(projectPath, cas);
    assert.equal(entry.file.endsWith('.json.br'), true);
    assert.equal(await fs.pathExists(path.join(storagePath, entry.file)), true);
    assert.deepEqual((await loadAnalysis(projectPath))?.nodes.map(node => node.id), ['node-1']);

    const legacyFile = entry.file.replace(/\.br$/, '');
    await fs.remove(path.join(storagePath, entry.file));
    await fs.writeJson(path.join(storagePath, legacyFile), {
      ...cas,
      nodes: [{ id: 'legacy-node', kind: 'function', name: 'Legacy', file_path: 'src/legacy.ts' }],
    });
    const indexPath = path.join(storagePath, 'index.json');
    const index = await fs.readJson(indexPath);
    index.analyses[projectPath].file = entry.file;
    await fs.writeJson(indexPath, index);

    assert.deepEqual((await loadAnalysis(projectPath))?.nodes.map(node => node.id), ['legacy-node']);
  } finally {
    restoreEnv('KLAURO_STORAGE_PATH', previousStoragePath);
    restoreEnv('KLAURO_ANALYSIS_COMPRESSION', previousCompression);
    await fs.remove(root);
  }
});

test('storage health reports generated artifact storage separately from durable analyses', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-storage-health-test-'));
  const storagePath = path.join(root, 'analyses');
  const previousStoragePath = process.env.KLAURO_STORAGE_PATH;

  process.env.KLAURO_STORAGE_PATH = storagePath;

  try {
    await fs.ensureDir(path.join(root, 'incremental-benchmark-workspaces', 'trial'));
    await fs.writeFile(path.join(root, 'incremental-benchmark-workspaces', 'trial', 'artifact.txt'), 'x'.repeat(10));

    const health = await getStorageHealth();

    assert.equal(health.generated_storage_root, root);
    assert.equal(health.generated_artifacts.total_bytes >= 10, true);
    assert.equal(
      health.generated_artifacts.categories.some(category => category.category === 'incremental-benchmark-workspaces' && category.exists),
      true
    );
  } finally {
    if (previousStoragePath === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previousStoragePath;
    await fs.remove(root);
  }
});

test('agentic benchmark report retention is count bounded', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-benchmark-storage-test-'));
  const storagePath = path.join(root, 'storage');
  const previousStoragePath = process.env.KLAURO_STORAGE_PATH;
  const previousMaxReports = process.env.KLAURO_MAX_AGENTIC_BENCHMARK_REPORTS;
  const previousMaxBytes = process.env.KLAURO_MAX_AGENTIC_BENCHMARK_BYTES;

  process.env.KLAURO_STORAGE_PATH = storagePath;
  process.env.KLAURO_MAX_AGENTIC_BENCHMARK_REPORTS = '2';
  process.env.KLAURO_MAX_AGENTIC_BENCHMARK_BYTES = String(10 * 1024 * 1024);

  try {
    for (let index = 0; index < 4; index++) {
      await saveAgenticBenchmarkReport({
        id: `benchmark-${index}`,
        generated_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      });
    }

    const reports = await listAgenticBenchmarkReports();
    assert.deepEqual(reports.map(report => report.id), ['benchmark-3', 'benchmark-2']);
    assert.equal(await fs.pathExists(path.join(storagePath, 'agentic-benchmarks', 'latest.json')), true);
  } finally {
    if (previousStoragePath === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previousStoragePath;
    if (previousMaxReports === undefined) delete process.env.KLAURO_MAX_AGENTIC_BENCHMARK_REPORTS;
    else process.env.KLAURO_MAX_AGENTIC_BENCHMARK_REPORTS = previousMaxReports;
    if (previousMaxBytes === undefined) delete process.env.KLAURO_MAX_AGENTIC_BENCHMARK_BYTES;
    else process.env.KLAURO_MAX_AGENTIC_BENCHMARK_BYTES = previousMaxBytes;
    await fs.remove(root);
  }
});
