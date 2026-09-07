import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CAS_VERSION, type CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import {
  applySourceExclusions, mergeSourceExclusions, normalizeSourceExclusions,
  readWorkspaceSourceExclusions, saveAnalysisWithSourceCoverage,
  sourceExclusionReadiness, validateSnapshotSourceCoverage, writeWorkspaceSourceExclusions,
} from './source-coverage';
import { getProjectStorageDir, loadAnalysis, waitForPendingSegmentedWrites } from './storage';
import { stampRepoFacts } from './remote-analyzer-service';
import { applySnapshotChanges, writeSnapshot } from './hosted-source-snapshot';
import { evaluateAgentReadiness } from './agent-adoption';
import { evaluateAnalysisTruth } from './analysis-mastery';
import { getCoverageGaps } from './query';
import { buildLayersReady } from './layered-analysis';

const omitted = [{ path: 'src/large.ts', bytes: 1_272_018 }];

function output(workspace = '/project'): CASOutput {
  return {
    cas_version: CAS_VERSION, analysis_timestamp: new Date().toISOString(), analysis_id: 'source-coverage-test',
    system: { id: 'coverage', name: 'Source coverage test', type: 'application', root_path: workspace },
    nodes: [], edges: [], entry_points: [], analyzer_contributions: [], progressive_levels: { total_levels: 0 },
    layers_ready: buildLayersReady({
      L0: { status: 'ready' }, L1: { status: 'ready' }, L2: { status: 'ready' },
      L3: { status: 'ready' }, L4: { status: 'ready' }, L5: { status: 'ready' },
    }),
  };
}

async function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-source-coverage-'));
  const workspace = path.join(root, 'project');
  await fs.mkdir(workspace);
  const previous = process.env.KLAURO_STORAGE_PATH;
  process.env.KLAURO_STORAGE_PATH = path.join(root, 'storage');
  try {
    await run(workspace);
  } finally {
    await waitForPendingSegmentedWrites();
    if (previous === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('source exclusion validation canonicalizes separators and deduplicates exact records', () => {
  assert.deepEqual(normalizeSourceExclusions([
    { path: 'z.ts', bytes: 0 }, { path: 'src\\large.ts', bytes: 9 }, { path: 'src/large.ts', bytes: 9 },
  ]), [{ path: 'src/large.ts', bytes: 9 }, { path: 'z.ts', bytes: 0 }]);
  assert.deepEqual(normalizeSourceExclusions(undefined), []);
  for (const value of [null, {}, [{ path: '../escape', bytes: 1 }], [{ path: '/absolute', bytes: 1 }],
    [{ path: 'C:\\absolute', bytes: 1 }], [{ path: 'src//x.ts', bytes: 1 }],
    [{ path: './x.ts', bytes: 1 }], [{ path: 'src/../x.ts', bytes: 1 }], [{ path: 'x\n.ts', bytes: 1 }],
    [{ path: 'x.ts', bytes: -1 }], [{ path: 'x.ts', bytes: Number.MAX_SAFE_INTEGER + 1 }],
    [{ path: 'x.ts', bytes: 0.5 }], [{ path: 'x.ts', bytes: '42' }],
    [{ path: 'x.ts', bytes: 1 }, { path: 'x.ts', bytes: 2 }]]) {
    assert.throws(() => normalizeSourceExclusions(value));
  }
  assert.throws(() => validateSnapshotSourceCoverage({ excluded_oversize_files: omitted }, [{ path: 'src/large.ts' }]), /both uploaded and excluded/);
});

test('source gaps preserve graph, layer readiness and unrelated diagnostics; explicit replacement clears only upload gaps', () => {
  const cas = output();
  cas.analysis_errors = [{ code: 'OTHER', message: 'Keep me', severity: 'warning' }];
  cas.coverage_gaps = [{ kind: 'unknown-dependency', evidence: 'Keep dependency', severity: 'low' }];
  const graph = [cas.nodes, cas.edges, cas.entry_points];
  const layers = JSON.stringify(cas.layers_ready);
  applySourceExclusions(cas, omitted);
  applySourceExclusions(cas, omitted);
  assert.equal(cas.analysis_errors?.length, 2);
  assert.equal(cas.coverage_gaps?.length, 2);
  assert.equal(cas.analysis_errors?.[1].severity, 'warning');
  assert.equal(cas.analysis_errors?.[1].file, 'src/large.ts');
  assert.deepEqual(cas.coverage_gaps?.[1].detail, { origin: 'source-upload', reason: 'upload-file-size-limit', bytes: 1_272_018 });
  assert.equal(cas.nodes, graph[0]);
  assert.equal(cas.edges, graph[1]);
  assert.equal(cas.entry_points, graph[2]);
  assert.equal(JSON.stringify(cas.layers_ready), layers);
  assert.equal(getCoverageGaps(cas, { kind: 'source-file-excluded' }).total, 1);
  applySourceExclusions(cas, undefined);
  assert.equal(sourceExclusionReadiness(cas).count, 1);
  applySourceExclusions(cas, []);
  assert.equal(sourceExclusionReadiness(cas).count, 0);
  assert.deepEqual(cas.analysis_errors, [{ code: 'OTHER', message: 'Keep me', severity: 'warning' }]);
  assert.equal(cas.coverage_gaps?.[0].kind, 'unknown-dependency');
});

test('truth and agent readiness disclose source omissions without manufacturing a layer failure', () => {
  const cas = output();
  applySourceExclusions(cas, omitted);
  const truth = evaluateAnalysisTruth(cas, {});
  assert.equal(truth.status, 'warn');
  assert.equal(truth.misses[0].id, 'source-coverage');
  const readiness = evaluateAgentReadiness(cas, '/project');
  assert.equal(readiness.gates.find(gate => gate.id === 'source-coverage')?.status, 'warn');
  assert.equal(readiness.analysis_only_understanding_ready, false);
  assert.equal(readiness.summary.analysis_errors, 0);
  assert.equal(readiness.summary.analysis_warnings, 1);
  assert.equal(cas.layers_ready?.complete, true);
});

test('incremental source coverage keeps untouched gaps and clears only supplied or deleted file paths', () => {
  assert.deepEqual(mergeSourceExclusions([...omitted, { path: 'another.ts', bytes: 99 }], [{ path: 'unrelated.ts' }], []), [
    { path: 'another.ts', bytes: 99 }, ...omitted,
  ]);
  assert.deepEqual(mergeSourceExclusions(omitted, [{ path: 'src/large.ts' }], []), []);
  assert.deepEqual(mergeSourceExclusions(omitted, [], [{ path: 'src/large.ts', bytes: 7 }]), [{ path: 'src/large.ts', bytes: 7 }]);
});

test('snapshot sync preserves unrelated omissions, restores supplied files and refuses directory exclusions', async () => {
  await withWorkspace(async workspace => {
    await writeSnapshot(workspace, [{ path: 'src/small.ts', content: 'export const small = 1;' }], { excluded_oversize_files: omitted });
    await applySnapshotChanges(workspace, [{ path: 'src/small.ts', status: 'modified', content: 'export const small = 2;', hash: 'changed' }]);
    assert.deepEqual(await readWorkspaceSourceExclusions(workspace), omitted);
    await applySnapshotChanges(workspace, [{ path: 'src/large.ts', status: 'added', content: 'export const restored = 1;', hash: 'restored' }]);
    assert.deepEqual(await readWorkspaceSourceExclusions(workspace), []);
    await applySnapshotChanges(workspace, [], { excluded_oversize_files: omitted });
    await assert.rejects(fs.stat(path.join(workspace, 'src/large.ts')), { code: 'ENOENT' });
    assert.deepEqual(await readWorkspaceSourceExclusions(workspace), omitted);
    await assert.rejects(applySnapshotChanges(workspace, [], { excluded_oversize_files: [{ path: 'src', bytes: 100 }] }), /not a directory/);
    assert.equal(await fs.readFile(path.join(workspace, 'src/small.ts'), 'utf8'), 'export const small = 2;');
    await applySnapshotChanges(workspace, [{ path: 'src/large.ts', status: 'deleted' }]);
    assert.deepEqual(await readWorkspaceSourceExclusions(workspace), []);
  });
});

test('uploaded exclusions survive stored-snapshot reload, source-free persistence and replacement upload', async () => {
  await withWorkspace(async workspace => {
    await writeSnapshot(workspace, [{ path: 'src/small.js', content: 'exports.answer = 42;' }], { excluded_oversize_files: omitted });
    assert.deepEqual(await readWorkspaceSourceExclusions(workspace), omitted);
    assert.deepEqual(await fs.readdir(workspace), ['src']);
    const cas = output(workspace);
    await saveAnalysisWithSourceCoverage(workspace, cas);
    const landed = await loadAnalysis(workspace, { preferCache: false });
    assert.ok(landed);
    assert.equal(sourceExclusionReadiness(landed).count, 1);
    assert.equal(getCoverageGaps(landed).gaps[0].file, 'src/large.ts');
    const rebuilt = output(workspace);
    await stampRepoFacts(workspace, rebuilt, undefined);
    assert.equal(sourceExclusionReadiness(rebuilt).count, 1);
    await writeSnapshot(workspace, [{ path: 'src/large.ts', content: 'export const restored = 1;' }]);
    await saveAnalysisWithSourceCoverage(workspace, rebuilt);
    assert.equal(sourceExclusionReadiness(rebuilt).count, 0);
  });
});

test('invalid upload coverage is rejected before any snapshot file is written', async () => {
  await withWorkspace(async workspace => {
    await assert.rejects(writeSnapshot(workspace, [{ path: 'new.ts', content: 'anything' }], {
      excluded_oversize_files: [{ path: '../../escape', bytes: 1 }],
    }), /canonical relative/);
    assert.deepEqual(await fs.readdir(workspace), []);
    assert.equal(await readWorkspaceSourceExclusions(workspace), undefined);
  });
});

test('corrupt or over-budget stored coverage cannot silently become complete coverage', async () => {
  await withWorkspace(async workspace => {
    await writeWorkspaceSourceExclusions(workspace, omitted);
    const metadata = path.join(getProjectStorageDir(workspace), 'source-coverage.json');
    await fs.writeFile(metadata, '{"version":2,"excluded_oversize_files":[]}');
    await assert.rejects(readWorkspaceSourceExclusions(workspace), /Invalid stored/);
    await fs.truncate(metadata, 16 * 1024 * 1024 + 1);
    await assert.rejects(readWorkspaceSourceExclusions(workspace), /byte budget/);
  });
});

test('real layered worker retains upload gaps across a forced stored-snapshot rebuild', { timeout: 90_000 }, async () => {
  await withWorkspace(async workspace => {
    const values: Record<string, string | undefined> = {
      KLAURO_LOG_DIR: path.join(workspace, '..', 'logs'),
      KLAURO_EMBEDDING_ENABLED: 'false', KLAURO_AI_INTERPRETATION: 'false',
      KLAURO_AI_ELEMENT_DESCRIPTIONS: 'false', KLAURO_ANALYSIS_HEAP_MB: '512',
      KLAURO_ANALYSIS_IN_PROCESS: undefined, KLAURO_ANALYSIS_WORKER_SOCKET: undefined,
    };
    const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const { runLayeredAnalysis, shutdownAnalysisWorker } = await import('./analyzer');
    try {
      await writeSnapshot(workspace, [
        { path: 'package.json', content: '{"name":"source-coverage-worker","main":"index.js"}' },
        { path: 'index.js', content: 'exports.answer = function answer() { return 42; };' },
      ], { excluded_oversize_files: omitted });
      for (let run = 0; run < 2; run++) {
        const result = await runLayeredAnalysis(workspace, { forceFullRebuild: true });
        assert.ok(result.nodes > 0);
        assert.equal(result.errors, 0);
        const landed = await loadAnalysis(workspace, { preferCache: false });
        assert.ok(landed);
        assert.equal(sourceExclusionReadiness(landed).count, 1);
        assert.equal(landed.analysis_errors?.filter(error => error.code === 'SOURCE_FILE_EXCLUDED').length, 1);
        assert.ok(landed.layers_ready?.layers.filter(layer => ['L0', 'L1', 'L2', 'L3'].includes(layer.layer)).every(layer => layer.status === 'ready'));
      }
    } finally {
      shutdownAnalysisWorker();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
