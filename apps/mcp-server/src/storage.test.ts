import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import {
  clearLoadedAnalysisCache,
  getLoadedAnalysisCacheStats,
  listCrossCodebaseSystemGraphs,
  loadAnalysisSectionManifest,
  loadAnalysisSections,
  loadCompleteAnalysisFromSections,
  loadAnalysis,
  loadCrossCodebaseSystemGraph,
  resolveAnalysisExportArtifact,
  saveAnalysis,
  saveCrossCodebaseSystemGraph,
} from './storage';

function casFixture(id: string): CASOutput {
  return {
    cas_version: '1.11.0', analysis_id: id, analysis_timestamp: '2026-07-22T00:00:00.000Z',
    system: { name: id, type: 'service' },
    nodes: [{ id: `${id}-node`, name: 'run', type: 'function', level: 1, file: 'src/run.ts' }],
    edges: [], method_calls: [{ caller_id: `${id}-node`, callee_name: 'run' }],
    analysis_facts: [{ id: `${id}-fact`, subject_id: `${id}-node`, kind: 'test' }],
    analyzer_contributions: [], progressive_levels: [],
  } as unknown as CASOutput;
}

async function withStoragePath<T>(fn: (storagePath: string) => Promise<T>): Promise<T> {
  const previous = process.env.KLAURO_STORAGE_PATH;
  const previousCwd = process.cwd();
  const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-storage-test-'));
  process.env.KLAURO_STORAGE_PATH = storagePath;
  // listCrossCodebaseSystemGraphs applies the workspace-isolation scope
  // resolved from process.cwd() (analysis-scope.ts). Running from inside this
  // repo — which carries a .klaurorc bound to a hosted workspace — would
  // filter out the test graphs (their /tmp member paths have no .klaurorc of
  // their own). chdir to the scratch dir so the scope resolves to the
  // machine-wide (unscoped) view; these tests exercise metadata listing, not
  // scoping (which has its own tests in analysis-scope.test.ts).
  process.chdir(storagePath);
  try {
    return await fn(storagePath);
  } finally {
    process.chdir(previousCwd);
    if (previous === undefined) {
      delete process.env.KLAURO_STORAGE_PATH;
    } else {
      process.env.KLAURO_STORAGE_PATH = previous;
    }
    await fs.remove(storagePath);
  }
}

test('lists workspace analyses from metadata without parsing the full graph file', async () => {
  await withStoragePath(async () => {
    const saved = await saveCrossCodebaseSystemGraph({
      id: 'workspace-large',
      name: 'Workspace Large',
      generated_at: '2026-01-01T00:00:00.000Z',
      codebase_count: 2,
      interfaces: [{ id: 'interface-1' }, { id: 'interface-2' }],
      links: [{ id: 'link-1' }],
      unmatched_interfaces: [{ id: 'unmatched-1' }],
      inputs: [
        { project_id: 'api', repo_path: '/tmp/workspace/api', cas_generated_at: '2026-01-01T00:00:00.000Z' },
        { project_id: 'web', repo_path: '/tmp/workspace/web', cas_generated_at: '2026-01-01T00:00:00.000Z' },
      ],
    } as any);

    await fs.writeFile(saved.file, '{ this is intentionally not json');

    const summaries = await listCrossCodebaseSystemGraphs();
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].id, 'workspace-large');
    assert.equal(summaries[0].name, 'Workspace Large');
    assert.equal(summaries[0].codebase_count, 2);
    assert.equal(summaries[0].interface_count, 2);
    assert.equal(summaries[0].link_count, 1);
    assert.equal(summaries[0].unmatched_interface_count, 1);
    assert.deepEqual(summaries[0].inputs?.map(input => input.repo_path), ['/tmp/workspace/api', '/tmp/workspace/web']);
  });
});

test('loading a legacy workspace analysis backfills metadata for future lightweight listing', async () => {
  await withStoragePath(async (storagePath) => {
    const directory = path.join(storagePath, 'workspace-analyses');
    await fs.ensureDir(directory);
    await fs.writeJson(path.join(directory, 'legacy-workspace.json'), {
      id: 'legacy-workspace',
      name: 'Legacy Workspace',
      generated_at: '2026-01-02T00:00:00.000Z',
      saved_at: '2026-01-02T00:00:01.000Z',
      codebase_count: 1,
      interfaces: [{ id: 'interface-1' }],
      links: [],
      unmatched_interfaces: [],
      inputs: [{ project_id: 'service', repo_path: '/tmp/legacy/service' }],
    });

    const beforeLoad = await listCrossCodebaseSystemGraphs();
    assert.equal(beforeLoad[0].id, 'legacy-workspace');
    assert.equal(beforeLoad[0].inputs, undefined);

    const graph = await loadCrossCodebaseSystemGraph('legacy-workspace');
    assert.equal(graph?.name, 'Legacy Workspace');

    const afterLoad = await listCrossCodebaseSystemGraphs();
    assert.deepEqual(afterLoad[0].inputs?.map(input => input.repo_path), ['/tmp/legacy/service']);
  });
});

test('segmented storage hydrates exact CAS and targeted reads omit unrequested data', async () => {
  await withStoragePath(async () => {
    const project = '/tmp/segmented-project';
    const cas = casFixture('segmented');
    await saveAnalysis(project, cas);
    const manifest = await loadAnalysisSectionManifest(project);
    assert.ok(manifest?.sections.some(section => section.name === 'graph'));
    assert.deepEqual(await loadCompleteAnalysisFromSections(project), cas);

    const graph = await loadAnalysisSections(project, ['graph']);
    assert.deepEqual(graph?.nodes, cas.nodes);
    assert.equal(graph?.method_calls, undefined);
    assert.equal(graph?.analysis_facts, undefined);

    const artifact = await resolveAnalysisExportArtifact(project);
    assert.ok(artifact);
    assert.ok(artifact!.bytes > 0);
  });
});

test('a segmented write failure never invalidates the authoritative analysis', async () => {
  await withStoragePath(async storagePath => {
    const project = '/tmp/segment-failure-project';
    const first = await saveAnalysis(project, casFixture('before-segment-failure'));
    const segmentRoot = path.join(storagePath, `${first.file}.sections`);
    await fs.remove(segmentRoot);
    await fs.writeFile(segmentRoot, 'blocks section directory creation');
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = message => warnings.push(String(message));
    try {
      await saveAnalysis(project, casFixture('after-segment-failure'));
    } finally {
      console.warn = originalWarn;
    }
    clearLoadedAnalysisCache();
    assert.equal((await loadAnalysis(project))?.analysis_id, 'after-segment-failure');
    assert.ok(warnings.some(message => message.includes('segmented analysis write failed')));
  });
});

test('parsed CAS cache evicts by entry budget and refuses an object over the memory budget', async () => {
  const previousEntries = process.env.KLAURO_PARSED_ANALYSIS_CACHE_MAX_ENTRIES;
  const previousBytes = process.env.KLAURO_PARSED_ANALYSIS_CACHE_MAX_BYTES;
  process.env.KLAURO_PARSED_ANALYSIS_CACHE_MAX_ENTRIES = '2';
  process.env.KLAURO_PARSED_ANALYSIS_CACHE_MAX_BYTES = String(16 * 1024 * 1024);
  clearLoadedAnalysisCache();
  try {
    await withStoragePath(async () => {
      await saveAnalysis('/tmp/cache-a', casFixture('a'));
      await saveAnalysis('/tmp/cache-b', casFixture('b'));
      await saveAnalysis('/tmp/cache-c', casFixture('c'));
      assert.equal(getLoadedAnalysisCacheStats().entries, 2);

      process.env.KLAURO_PARSED_ANALYSIS_CACHE_MAX_BYTES = '1024';
      await saveAnalysis('/tmp/cache-too-large', casFixture('too-large'));
      assert.equal(getLoadedAnalysisCacheStats().entries, 2, 'oversized object is not retained');
    });
  } finally {
    clearLoadedAnalysisCache();
    if (previousEntries === undefined) delete process.env.KLAURO_PARSED_ANALYSIS_CACHE_MAX_ENTRIES;
    else process.env.KLAURO_PARSED_ANALYSIS_CACHE_MAX_ENTRIES = previousEntries;
    if (previousBytes === undefined) delete process.env.KLAURO_PARSED_ANALYSIS_CACHE_MAX_BYTES;
    else process.env.KLAURO_PARSED_ANALYSIS_CACHE_MAX_BYTES = previousBytes;
  }
});
