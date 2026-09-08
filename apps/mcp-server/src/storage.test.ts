import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'node:crypto';
import * as zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { CAS_VERSION, type CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import {
  clearLoadedAnalysisCache,
  getLoadedAnalysisCacheStats,
  listCrossCodebaseSystemGraphs,
  loadCompactAnalysisGraph,
  loadCompactAnalysisSearch,
  loadAnalysisSectionManifest,
  loadAnalysisProjection,
  loadAnalysisSections,
  loadCompleteAnalysisFromSections,
  loadAnalysis,
  loadCrossCodebaseSystemGraph,
  resolveAnalysisExportArtifact,
  saveAnalysis,
  saveCrossCodebaseSystemGraph,
  waitForPendingSegmentedWrites,
  writeJsonAtomic,
} from './storage';
import { segmentedReadFailureFallback, segmentedStorageAccessError, SegmentedStorageAccessError } from './segmented-storage-access';
import { getCachedDeployableAnalyses, materializeDeployableCasTree } from './deployable-analysis';
import { compactCASPostingShard, searchCompactCAS } from '../../../packages/analyzer-core/src/analyzer/core/compact-cas-search';
import { writeSegmentedLegacyExport } from './segmented-analysis-storage';
import { writeCompressedJsonAtomic } from './json-storage-writer';

function casFixture(id: string): CASOutput {
  return {
    cas_version: '1.11.0', analysis_id: id, analysis_timestamp: '2026-07-22T00:00:00.000Z',
    system: { name: id, type: 'service' },
    nodes: [{ id: `${id}-node`, name: 'run', type: 'function', level: 1, file: 'src/run.ts' }],
    edges: [], method_calls: [{ caller_id: `${id}-node`, callee_name: 'run' }],
    analysis_facts: [{ id: `${id}-fact`, subject_id: `${id}-node`, kind: 'test' }],
    analyzer_contributions: [], progressive_levels: [],
    layers_ready: {
      complete: true,
      generated_at: '2026-07-22T00:00:00.000Z',
      layers: ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'].map(layer =>
        ({ layer, name: layer, status: 'ready', fields: [] })),
    },
  } as unknown as CASOutput;
}

function recursiveCasFixture(): CASOutput {
  const root = { ...casFixture('recursive-root'), id: 'cas:root', parent_id: null, label: 'root', composition_mode: 'composed' as const };
  const child = { ...casFixture('recursive-child'), id: 'cas:child', parent_id: root.id, label: 'child', composition_mode: 'composed' as const };
  const grandchild = { ...casFixture('recursive-grandchild'), id: 'cas:grandchild', parent_id: child.id, label: 'grandchild' };
  const sibling = { ...casFixture('recursive-sibling'), id: 'cas:sibling', parent_id: root.id, label: 'sibling' };
  child.children = [grandchild];
  root.children = [child, sibling];
  return root;
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

async function readExportArtifact(filePath: string): Promise<CASOutput> {
  if (filePath.endsWith('.zst')) return JSON.parse(execFileSync('zstd', ['-q', '-d', '-c', filePath], { encoding: 'utf8' }));
  if (filePath.endsWith('.br')) return JSON.parse(zlib.brotliDecompressSync(await fs.readFile(filePath)).toString('utf8'));
  return fs.readJson(filePath) as Promise<CASOutput>;
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
    assert.deepEqual(await loadCompleteAnalysisFromSections(project), materializeDeployableCasTree(cas));

    const graph = await loadAnalysisSections(project, ['graph']);
    assert.deepEqual(graph?.nodes, cas.nodes);
    assert.equal(graph?.method_calls, undefined);
    assert.equal(graph?.analysis_facts, undefined);

    const artifact = await resolveAnalysisExportArtifact(project);
    assert.ok(artifact);
    assert.ok(artifact!.bytes > 0);
    await fs.writeFile(artifact!.filePath, 'invalid authoritative payload');
    clearLoadedAnalysisCache();
    assert.deepEqual(await loadAnalysis(project), materializeDeployableCasTree(cas));
  });
});

test('segmented storage publishes a checksummed compact graph alongside authoritative sections', async () => {
  await withStoragePath(async storagePath => {
    const project = '/tmp/compact-graph-project';
    const cas = casFixture('compact-graph');
    cas.nodes[0].description = 'Executes xy transitions';
    cas.nodes[0].documentation = {
      raw: 'Retention policy coordinator '.repeat(2_000),
      location: { start_line: 1, end_line: 1 },
    };
    await saveAnalysis(project, cas);
    const graph = await loadCompactAnalysisGraph(project);
    assert.ok(graph);
    assert.equal(graph.nodeCount, 1);
    assert.equal(graph.nodeAt(0).id, 'compact-graph-node');
    assert.equal(new TextDecoder().decode(graph.dictionary.bytes).includes('Executes xy transitions'), false);

    const search = await loadCompactAnalysisSearch(project);
    assert.ok(search);
    assert.deepEqual((await searchCompactCAS(
      search.graph,
      search.index,
      'xy',
      search.readPostings,
      search.readSearchText,
    )).map(node => node.id), ['compact-graph-node']);
    assert.deepEqual((await searchCompactCAS(
      search.graph,
      search.index,
      'retention',
      search.readPostings,
      search.readSearchText,
    )).map(node => node.id), ['compact-graph-node']);

    const manifest = await loadAnalysisSectionManifest(project);
    assert.ok(manifest!.compact_search);
    assert.equal(manifest!.compact_search!.version, 3);
    assert.equal(Object.keys(manifest!.compact_search!.columns).some(name => name.startsWith('auxiliaryText.')), false);
    const firstColumn = Object.values(manifest!.compact_graph!.columns)[0];
    const sectionRoot = (await fs.readdir(storagePath)).find(name => name.endsWith('.sections'))!;
    const pointer = await fs.readJson(path.join(storagePath, sectionRoot, 'current.json'));
    await fs.writeFile(path.join(storagePath, sectionRoot, pointer.current || pointer.revision, firstColumn.file), 'corrupt');
    await assert.rejects(loadCompactAnalysisGraph(project), /checksum mismatch|invalid byte length|byte length .* does not match/);
  });
});

test('compact search rejects internally corrupt checksummed postings and supports migration without a sidecar', async () => {
  await withStoragePath(async storagePath => {
    const project = '/tmp/compact-search-corruption-project';
    await saveAnalysis(project, casFixture('compact-search-corruption'));
    const sectionRoot = path.join(storagePath, (await fs.readdir(storagePath)).find(name => name.endsWith('.sections'))!);
    const pointer = await fs.readJson(path.join(sectionRoot, 'current.json'));
    await fs.writeJson(path.join(sectionRoot, 'current.json'), { manifest_version: 1, revision: pointer.current || pointer.revision });
    const manifestPath = path.join(sectionRoot, pointer.current || pointer.revision, 'manifest.json');
    const manifest = await fs.readJson(manifestPath);
    const generationPath = path.dirname(manifestPath);
    const auxiliaryText = Buffer.from('legacy auxiliary documentation');
    const auxiliaryOffsets = Buffer.alloc(8);
    auxiliaryOffsets.writeUInt32LE(0, 0);
    auxiliaryOffsets.writeUInt32LE(auxiliaryText.byteLength, 4);
    await fs.writeFile(path.join(generationPath, 'search.auxiliaryText.offsets.bin'), auxiliaryOffsets);
    await fs.writeFile(path.join(generationPath, 'search.auxiliaryText.chunks.0.bin'), auxiliaryText);
    manifest.compact_search.version = 2;
    manifest.compact_search.columns['auxiliaryText.offsets'] = {
      file: 'search.auxiliaryText.offsets.bin', encoding: 'uint32-le', length: 2, bytes: 8,
      sha256: crypto.createHash('sha256').update(auxiliaryOffsets).digest('hex'),
    };
    manifest.compact_search.columns['auxiliaryText.chunks.0'] = {
      file: 'search.auxiliaryText.chunks.0.bin', encoding: 'uint8', length: auxiliaryText.byteLength, bytes: auxiliaryText.byteLength,
      sha256: crypto.createHash('sha256').update(auxiliaryText).digest('hex'),
    };
    await fs.writeJson(manifestPath, manifest);
    const legacySearch = await loadCompactAnalysisSearch(project);
    assert.ok(legacySearch);
    assert.deepEqual((await searchCompactCAS(
      legacySearch.graph,
      legacySearch.index,
      'run',
      legacySearch.readPostings,
      legacySearch.readSearchText,
    )).map(node => node.id), ['compact-search-corruption-node']);
    manifest.compact_search.version = 999;
    await fs.writeJson(manifestPath, manifest);
    await assert.rejects(loadCompactAnalysisSearch(project), /format or version is unsupported|checksum-valid generation|pointer or generation is unreadable/);
    manifest.compact_search.version = 2;
    await fs.writeJson(manifestPath, manifest);
    const shard = manifest.compact_search.nonempty_shards[0];
    const column = manifest.compact_search.columns[`postings.shard.${shard}`];
    const columnPath = path.join(sectionRoot, pointer.current || pointer.revision, column.file);
    const bytes = await fs.readFile(columnPath);
    bytes[0] ^= 0xff;
    column.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    await fs.writeFile(columnPath, bytes);
    await fs.writeJson(manifestPath, manifest);
    const search = await loadCompactAnalysisSearch(project);
    assert.ok(search);
    let requestedKey = 't:corrupt';
    for (let index = 0; compactCASPostingShard(requestedKey, manifest.compact_search.shard_count) !== shard; index += 1) requestedKey = `t:corrupt${index}`;
    await assert.rejects(search.readPostings([requestedKey]), /invalid format or version/);

    delete manifest.compact_search;
    await fs.writeJson(manifestPath, manifest);
    assert.equal(await loadCompactAnalysisSearch(project), null);
    const graph = await loadAnalysisSections(project, ['graph']);
    assert.ok(graph?.nodes && graph.nodes.length > 0);
  });
});

test('queries use an existing read-only default analysis store', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-readonly-home-'));
  const storagePath = path.join(home, '.klauro', 'analyses');
  const project = '/tmp/read-only-project';
  const cas = casFixture('read-only');
  await fs.ensureDir(storagePath);
  await fs.writeJson(path.join(storagePath, 'analysis.json'), cas);
  await fs.writeJson(path.join(storagePath, 'index.json'), {
    analyses: {
      [project]: {
        name: cas.system.name,
        path: project,
        file: 'analysis.json',
        analyzed_at: cas.analysis_timestamp,
        system_type: cas.system.type,
        frameworks: [],
        node_count: cas.nodes.length,
        edge_count: cas.edges.length,
        cas_version: cas.cas_version,
        track: 'main',
        layers_ready: cas.layers_ready,
      },
    },
  });
  await fs.chmod(storagePath, 0o555);
  try {
    const stdout = execFileSync(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      `const module = await import('./src/storage.ts'); const value = await (module.loadAnalysis || module.default.loadAnalysis)(${JSON.stringify(project)}); process.stdout.write(value?.analysis_id || 'missing');`,
    ], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, HOME: home, KLAURO_STORAGE_PATH: '' },
      encoding: 'utf8',
    });
    assert.equal(stdout, 'read-only');
  } finally {
    await fs.chmod(storagePath, 0o755);
    await fs.remove(home);
  }
});

test('a missing/corrupt segmented section file fails loudly, naming the section, instead of returning a silently partial CAS', async () => {
  await withStoragePath(async storagePath => {
    const project = '/tmp/segmented-corrupt-project';
    const cas = casFixture('segmented-corrupt');
    const entry = await saveAnalysis(project, cas, 'main', { canonicalSegmented: false });
    const manifest = await loadAnalysisSectionManifest(project);
    const graphDescriptor = manifest?.sections.find(section => section.name === 'graph');
    assert.ok(graphDescriptor?.file);

    // Find the on-disk revision directory (writeSegmentedAnalysis's
    // `<file>.sections/<revision>/`) and corrupt the graph section's file.
    const sectionsRoot = path.join(storagePath, `${entry.file}.sections`);
    const pointer = await fs.readJson(path.join(sectionsRoot, 'current.json'));
    const sectionPath = path.join(sectionsRoot, pointer.current || pointer.revision, graphDescriptor!.file!);
    await fs.writeFile(sectionPath, 'not valid json{{{');
    clearLoadedAnalysisCache();

    await assert.rejects(
      () => loadAnalysisSections(project, ['graph']),
      /section 'graph'/,
    );
    assert.deepEqual(
      await loadAnalysis(project, { preferAuthoritative: true }),
      materializeDeployableCasTree(cas),
    );
  });
});

test('section reads project a valid parsed CAS cache without reopening segmented files', async () => {
  await withStoragePath(async storagePath => {
    const project = '/tmp/segmented-cached-project';
    const cas = casFixture('segmented-cached');
    const entry = await saveAnalysis(project, cas, 'main', { canonicalSegmented: false });
    const manifest = await loadAnalysisSectionManifest(project);
    const graphDescriptor = manifest?.sections.find(section => section.name === 'graph');
    assert.ok(graphDescriptor?.file);

    const sectionsRoot = path.join(storagePath, `${entry.file}.sections`);
    const pointer = await fs.readJson(path.join(sectionsRoot, 'current.json'));
    const sectionPath = path.join(sectionsRoot, pointer.current || pointer.revision, graphDescriptor.file);
    await fs.writeFile(sectionPath, 'not valid json{{{');

    const graph = await loadAnalysisSections(project, ['graph']);
    assert.deepEqual(graph?.nodes, cas.nodes);
    assert.equal(graph?.method_calls, undefined);

    clearLoadedAnalysisCache();
    await assert.rejects(
      () => loadAnalysisSections(project, ['graph']),
      /section 'graph'/,
    );
  });
});

test('a deferred segmented write preserves immediate cache reads and durable cold section reads', async () => {
  await withStoragePath(async () => {
    const project = '/tmp/deferred-segmented-project';
    const first = casFixture('deferred-first');
    const second = casFixture('deferred-second');
    await saveAnalysis(project, first);
    await saveAnalysis(project, second, 'main', { deferSegmentedWrite: true, segmentedWriteDelayMs: 0 });

    assert.equal((await loadAnalysisSections(project, ['graph']))?.analysis_id, 'deferred-second');
    await waitForPendingSegmentedWrites();
    clearLoadedAnalysisCache();
    assert.equal((await loadAnalysisSections(project, ['graph']))?.analysis_id, 'deferred-second');
  });
});

test('a segmented write failure never invalidates the authoritative analysis', async () => {
  await withStoragePath(async storagePath => {
    const project = '/tmp/segment-failure-project';
    const first = await saveAnalysis(project, casFixture('before-segment-failure'), 'main', { canonicalSegmented: false });
    const segmentRoot = path.join(storagePath, `${first.file}.sections`);
    await fs.remove(segmentRoot);
    await fs.writeFile(segmentRoot, 'blocks section directory creation');
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = message => warnings.push(String(message));
    try {
      await saveAnalysis(project, casFixture('after-segment-failure'), 'main', { canonicalSegmented: false });
    } finally {
      console.warn = originalWarn;
    }
    clearLoadedAnalysisCache();
    assert.equal((await loadAnalysis(project))?.analysis_id, 'after-segment-failure');
    assert.ok(warnings.some(message => message.includes('segmented analysis write failed')));
  });
});

test('atomic storage writes remain valid under same-process concurrency', async () => {
  await withStoragePath(async storagePath => {
    const jsonPath = path.join(storagePath, 'concurrent.json');
    await Promise.all(Array.from({ length: 64 }, (_, index) => writeJsonAtomic(jsonPath, { index })));
    const stored = await fs.readJson(jsonPath);
    assert.equal(typeof stored.index, 'number');
    assert.ok(stored.index >= 0 && stored.index < 64);

    const project = '/tmp/concurrent-segmented-project';
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = message => warnings.push(String(message));
    try {
      await Promise.all(Array.from({ length: 16 }, (_, index) => saveAnalysis(project, casFixture(`concurrent-${index}`))));
    } finally {
      console.warn = originalWarn;
    }
    clearLoadedAnalysisCache();
    assert.match((await loadAnalysis(project))?.analysis_id || '', /^concurrent-\d+$/);
    assert.equal(warnings.filter(message => message.includes('segmented analysis write failed')).length, 0);
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
      await saveAnalysis('/tmp/cache-a', casFixture('a'), 'main', { canonicalSegmented: false });
      await saveAnalysis('/tmp/cache-b', casFixture('b'), 'main', { canonicalSegmented: false });
      await saveAnalysis('/tmp/cache-c', casFixture('c'), 'main', { canonicalSegmented: false });
      assert.equal(getLoadedAnalysisCacheStats().entries, 2);

      process.env.KLAURO_PARSED_ANALYSIS_CACHE_MAX_BYTES = '1024';
      await saveAnalysis('/tmp/cache-too-large', casFixture('too-large'), 'main', { canonicalSegmented: false });
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

test('default parsed CAS cache cannot retain a multi-gigabyte fraction of the API heap', async () => {
  const { defaultParsedAnalysisCacheMaxBytes } = await import('./storage');
  assert.equal(defaultParsedAnalysisCacheMaxBytes(4 * 1024 * 1024 * 1024), 256 * 1024 * 1024);
  assert.equal(defaultParsedAnalysisCacheMaxBytes(1024 * 1024 * 1024), 128 * 1024 * 1024);
});

// Measured on prod (2026-08-11, 92,586 nodes / 135,974 edges): FIVE saveAnalysis
// calls per analysis, each rebuilding the segmented sidecar from scratch —
// 34.9s of the run's 68.2s total serialization, where only the final rebuild is
// ever read. The progressive saves themselves are a feature (early queryability,
// crash durability); rebuilding a DERIVED sidecar on each one is not.
//
// These pin the gate in all three states, because getting it wrong in either
// direction is silent: skip too eagerly and queries lose section-narrowing
// forever, skip never and a whale pays 35s of waste per run.
async function savedSectionsExist(storagePath: string, projectPath: string): Promise<boolean> {
  const entries = await fs.readdir(storagePath);
  const sections = entries.filter(name => name.endsWith('.sections'));
  return sections.length > 0;
}

test('a COMPLETE layered CAS writes the segmented sidecar', async () => {
  await withStoragePath(async storagePath => {
    const cas = casFixture('complete-cas');
    await saveAnalysis('/tmp/complete-project', cas);
    assert.equal(await savedSectionsExist(storagePath, '/tmp/complete-project'), true);
  });
});

test('an INCOMPLETE layered CAS skips the sidecar but stays fully readable', async () => {
  await withStoragePath(async storagePath => {
    const cas = casFixture('partial-cas');
    (cas as unknown as { layers_ready: unknown }).layers_ready = {
      complete: false,
      layers: [{ layer: 'L0', status: 'pending' }],
    };
    await saveAnalysis('/tmp/partial-project', cas);
    assert.equal(
      await savedSectionsExist(storagePath, '/tmp/partial-project'),
      false,
      'an intermediate progressive save must not pay to rebuild a sidecar that will be superseded',
    );
    // The whole compressed file is authoritative and always written, so the
    // analysis must still load in full — that is what makes skipping safe.
    clearLoadedAnalysisCache();
    const loaded = await loadAnalysis('/tmp/partial-project');
    assert.ok(loaded, 'the analysis must still be readable without a sidecar');
    assert.equal((loaded!.nodes || []).length, 1);
  });
});

test('a structurally queryable CAS writes sections and remains loadable when comprehension fails', async () => {
  await withStoragePath(async storagePath => {
    const cas = casFixture('structurally-queryable-cas');
    (cas as unknown as { layers_ready: unknown }).layers_ready = {
      complete: false,
      layers: [
        { layer: 'L0', status: 'ready' },
        { layer: 'L1', status: 'ready' },
        { layer: 'L2', status: 'ready' },
        { layer: 'L3', status: 'ready' },
        { layer: 'L4', status: 'error' },
        { layer: 'L5', status: 'error' },
      ],
    };
    await saveAnalysis('/tmp/structurally-queryable-project', cas);
    assert.equal(await savedSectionsExist(storagePath, '/tmp/structurally-queryable-project'), true);
    clearLoadedAnalysisCache();
    assert.equal((await loadAnalysis('/tmp/structurally-queryable-project'))?.analysis_id, 'structurally-queryable-cas');
  });
});

test('authoritative-only persistence stays readable without writing segmented sections', async () => {
  await withStoragePath(async storagePath => {
    const project = '/tmp/authoritative-only-project';
    const cas = casFixture('authoritative-only');
    await saveAnalysis(project, cas, 'main', { writeSegmentedAnalysis: false });
    assert.equal(await savedSectionsExist(storagePath, project), false);
    clearLoadedAnalysisCache();
    assert.equal((await loadAnalysis(project))?.analysis_id, 'authoritative-only');
  });
});

test('a CAS with no layers_ready is persisted for diagnosis but cannot be loaded as ready', async () => {
  await withStoragePath(async storagePath => {
    const project = '/tmp/unstamped-project';
    const cas = casFixture('unstamped-cas');
    cas.cas_version = CAS_VERSION;
    delete cas.layers_ready;

    await saveAnalysis(project, cas);

    assert.equal(await savedSectionsExist(storagePath, project), false);
    clearLoadedAnalysisCache();
    assert.equal(await loadAnalysis(project), null);
  });
});

test('canonical segmented storage publishes a hashed generation without a whole-CAS write and materializes legacy export on demand', async () => {
  await withStoragePath(async storagePath => {
    const project = '/tmp/canonical-segmented-project';
    const cas = casFixture('canonical-segmented');
    (cas as unknown as { capabilities?: unknown }).capabilities = undefined;
    const entry = await saveAnalysis(project, cas, 'main', { canonicalSegmented: true });
    const wholePath = path.join(storagePath, entry.file);
    assert.equal(entry.storage_format, 'segmented-v2');
    assert.equal(await fs.pathExists(wholePath), false);
    const pointer = await fs.readJson(`${wholePath}.sections/current.json`);
    assert.equal(pointer.manifest_version, 2);
    assert.match(pointer.current, /^gen-[a-f0-9]{64}$/);
    const manifest = await loadAnalysisSectionManifest(project);
    assert.equal(manifest?.tree_projection?.format, 'recursive-cas-section-references');
    if (manifest?.tree_projection?.format !== 'recursive-cas-section-references') throw new Error('expected recursive projection');
    assert.equal(manifest.tree_projection.root_id, 'cas:canonical-segmented');
    assert.equal(manifest.tree_projection.nodes.length, 1);
    assert.equal((await loadAnalysisSections(project, ['tree']))?.children, undefined);
    clearLoadedAnalysisCache();
    const expectedExport = JSON.parse(JSON.stringify(materializeDeployableCasTree(cas)));
    assert.deepEqual(await loadAnalysis(project), expectedExport);

    await fs.writeFile(wholePath, 'stale legacy bytes that must never be served');
    const previousReserve = process.env.KLAURO_ANALYSIS_EXPORT_RESERVE_MB;
    process.env.KLAURO_ANALYSIS_EXPORT_RESERVE_MB = '128';
    const exportArtifact = await resolveAnalysisExportArtifact(project).finally(() => {
      if (previousReserve === undefined) delete process.env.KLAURO_ANALYSIS_EXPORT_RESERVE_MB;
      else process.env.KLAURO_ANALYSIS_EXPORT_RESERVE_MB = previousReserve;
    });
    assert.match(exportArtifact?.filePath || '', /\.export-gen-[a-f0-9]{64}\.json(?:\.zst|\.br)?$/);
    assert.notEqual(exportArtifact?.filePath, wholePath);
    assert.deepEqual(await readExportArtifact(exportArtifact!.filePath), expectedExport);
  });
});

test('bounded section loads return inventory from the same pinned canonical generation', async () => {
  await withStoragePath(async () => {
    const project = '/tmp/canonical-projection-project';
    const cas = casFixture('canonical-projection');
    cas.edges = [{ id: 'self', source: cas.nodes[0].id, target: cas.nodes[0].id, type: 'calls' }];
    await saveAnalysis(project, cas, 'main', { canonicalSegmented: true });

    const loaded = await loadAnalysisProjection(project, ['comprehension', 'quality'], { require_sub_cas_index: true });

    assert.ok(loaded);
    assert.equal(loaded.cas.analysis_id, 'canonical-projection');
    assert.equal(loaded.cas.nodes, undefined);
    assert.equal(loaded.cas.edges, undefined);
    assert.equal(loaded.manifest.analysis_id, loaded.cas.analysis_id);
    assert.equal(loaded.manifest.analysis_timestamp, loaded.cas.analysis_timestamp);
    assert.equal(loaded.manifest.compact_graph?.node_count, 1);
    assert.equal(loaded.manifest.tree_projection?.format, 'recursive-cas-section-references');
    assert.equal(loaded.manifest.compact_graph?.edge_count, 1);
    assert.deepEqual(loaded.inventory, { node_count: 1, edge_count: 1 });
  });
});

test('canonical legacy export reconstructs multiple referenced deployable children exactly', async () => {
  await withStoragePath(async storagePath => {
    const project = '/tmp/canonical-child-export-project';
    const cas = casFixture('canonical-child-export');
    cas.system = { ...cas.system, type: 'monorepo', root_path: '.' };
    cas.nodes = [
      { id: 'api', name: 'api', type: 'function', source: { file: 'apps/api/main.ts', line: 1 } },
      { id: 'worker', name: 'worker', type: 'function', source: { file: 'apps/worker/main.ts', line: 1 } },
      { id: 'shared', name: 'shared', type: 'function', source: { file: 'libs/shared.ts', line: 1 } },
    ];
    cas.edges = [
      { id: 'api-shared', source: 'api', target: 'shared', type: 'calls' },
      { id: 'worker-shared', source: 'worker', target: 'shared', type: 'calls' },
    ];
    cas.entry_points = [
      { id: 'api-entry', name: 'api', type: 'http', source_node: 'api', handler: { node_id: 'api', method_name: 'api', file: 'apps/api/main.ts' } },
      { id: 'worker-entry', name: 'worker', type: 'event', source_node: 'worker', handler: { node_id: 'worker', method_name: 'worker', file: 'apps/worker/main.ts' } },
    ] as any;
    cas.deployable_evidence = [
      { root_path: 'apps/api', name: 'api', tier: 1, kind: 'compose-service', evidence: ['compose:api'] },
      { root_path: 'apps/worker', name: 'worker', tier: 1, kind: 'compose-service', evidence: ['compose:worker'] },
    ];
    const entry = await saveAnalysis(project, cas, 'main', { canonicalSegmented: true });
    const expected = materializeDeployableCasTree(cas);
    assert.equal(expected.children?.length, 2);
    const manifest = await loadAnalysisSectionManifest(project);
    assert.equal(manifest?.tree_projection?.format, 'recursive-cas-section-references');
    if (manifest?.tree_projection?.format !== 'recursive-cas-section-references') throw new Error('expected recursive projection');
    assert.equal(manifest.tree_projection.nodes.length, 3);
    assert.deepEqual(manifest.tree_projection.sub_cas_nodes, getCachedDeployableAnalyses(expected).sub_cas_nodes);
    assert.ok(manifest.tree_projection.nodes.slice(1).flatMap(node => node.sections).every(section => /^tree\.[a-f0-9]{64}\.json/.test(section.file || '')));
    assert.equal(await fs.pathExists(path.join(storagePath, entry.file)), false);
    const previousReserve = process.env.KLAURO_ANALYSIS_EXPORT_RESERVE_MB;
    process.env.KLAURO_ANALYSIS_EXPORT_RESERVE_MB = '128';
    const artifact = await resolveAnalysisExportArtifact(project).finally(() => {
      if (previousReserve === undefined) delete process.env.KLAURO_ANALYSIS_EXPORT_RESERVE_MB;
      else process.env.KLAURO_ANALYSIS_EXPORT_RESERVE_MB = previousReserve;
    });
    assert.deepEqual(await readExportArtifact(artifact!.filePath), expected);
  });
});

test('recursive canonical storage hydrates exact descendants and bounded child reads avoid siblings', async () => {
  await withStoragePath(async storagePath => {
    const project = '/tmp/recursive-canonical-project';
    const cas = recursiveCasFixture();
    const entry = await saveAnalysis(project, cas, 'main', { canonicalSegmented: true });
    const expected = materializeDeployableCasTree(cas);
    const manifest = await loadAnalysisSectionManifest(project);
    assert.equal(manifest?.tree_projection?.format, 'recursive-cas-section-references');
    if (manifest?.tree_projection?.format !== 'recursive-cas-section-references') throw new Error('expected recursive projection');
    assert.deepEqual(manifest.tree_projection.nodes.map(node => [node.id, node.parent_id, node.child_ids]), [
      ['cas:root', null, ['cas:child', 'cas:sibling']],
      ['cas:child', 'cas:root', ['cas:grandchild']],
      ['cas:grandchild', 'cas:child', []],
      ['cas:sibling', 'cas:root', []],
    ]);
    assert.deepEqual(await loadCompleteAnalysisFromSections(project), expected);
    assert.deepEqual(
      await loadCompleteAnalysisFromSections(project, { cas_id: 'cas:child' }),
      expected.children![0],
    );
    const artifact = await resolveAnalysisExportArtifact(project);
    assert.deepEqual(await readExportArtifact(artifact!.filePath), expected);

    const sibling = manifest.tree_projection.nodes.find(node => node.id === 'cas:sibling')!;
    const siblingGraph = sibling.sections.find(section => section.name === 'graph')!;
    await fs.writeFile(path.join(storagePath, `${entry.file}.sections`, (await fs.readJson(path.join(storagePath, `${entry.file}.sections`, 'current.json'))).current, siblingGraph.file!), 'corrupt sibling');
    const grandchild = await loadAnalysisSections(project, ['graph'], { cas_id: 'cas:grandchild' });
    assert.deepEqual(grandchild?.nodes, cas.children![0].children![0].nodes);
    assert.equal(grandchild?.children, undefined);
    await assert.rejects(loadCompleteAnalysisFromSections(project), /byte length mismatch|checksum mismatch/);
  });
});

test('child hydration scopes authoritative trees when a legacy sidecar has no projection', async () => {
  await withStoragePath(async () => {
    const project = '/tmp/legacy-sidecar-child-project';
    const cas = recursiveCasFixture();
    await saveAnalysis(project, cas);
    assert.deepEqual(
      await loadCompleteAnalysisFromSections(project, { cas_id: 'cas:child' }),
      materializeDeployableCasTree(cas).children![0],
    );
  });
});

test('canonical readers and export remain compatible with version one child artifacts', async () => {
  await withStoragePath(async storagePath => {
    const project = '/tmp/version-one-tree-project';
    const cas = recursiveCasFixture();
    const expected = materializeDeployableCasTree(cas);
    const entry = await saveAnalysis(project, cas, 'main', { canonicalSegmented: true });
    const root = path.join(storagePath, `${entry.file}.sections`);
    const pointer = await fs.readJson(path.join(root, 'current.json'));
    const originalDirectory = path.join(root, pointer.current);
    const manifest = await fs.readJson(path.join(originalDirectory, 'manifest.json'));
    const childFile = `legacy-child.json${entry.file.endsWith('.zst') ? '.zst' : entry.file.endsWith('.br') ? '.br' : ''}`;
    const childPath = path.join(originalDirectory, childFile);
    await writeCompressedJsonAtomic(childPath, expected.children![0]);
    const bytes = (await fs.stat(childPath)).size;
    const sha256 = crypto.createHash('sha256').update(await fs.readFile(childPath)).digest('hex');
    manifest.tree_projection = {
      format: 'derived-deployable-references',
      version: 1,
      children: [{ id: expected.children![0].id, file: childFile, bytes, sha256 }],
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    const generation = `gen-${crypto.createHash('sha256').update(manifestBytes).digest('hex')}`;
    await fs.writeFile(path.join(originalDirectory, 'manifest.json'), manifestBytes);
    await fs.rename(originalDirectory, path.join(root, generation));
    await fs.writeJson(path.join(root, 'current.json'), { manifest_version: 2, current: generation });

    const legacyProjection = await loadAnalysisProjection(project, ['comprehension'], { require_sub_cas_index: true });
    assert.deepEqual(legacyProjection?.cas.nodes, expected.nodes);
    const grandchild = await loadAnalysisSections(project, ['graph'], { cas_id: 'cas:grandchild' });
    assert.deepEqual(grandchild?.nodes, expected.children![0].children![0].nodes);
    assert.equal(grandchild?.children, undefined);
    assert.deepEqual(await loadCompleteAnalysisFromSections(project, { cas_id: 'cas:child' }), expected.children![0]);
    assert.deepEqual(await loadCompleteAnalysisFromSections(project), { ...expected, children: [expected.children![0]] });
    const artifact = await resolveAnalysisExportArtifact(project);
    assert.deepEqual(await readExportArtifact(artifact!.filePath), { ...expected, children: [expected.children![0]] });
  });
});

test('canonical segmented storage never exposes the previous generation as current', async () => {
  await withStoragePath(async storagePath => {
    const project = '/tmp/canonical-recovery-project';
    const first = casFixture('canonical-first');
    await saveAnalysis(project, first, 'main', { canonicalSegmented: true });
    const second = casFixture('canonical-second');
    second.analysis_timestamp = '2026-07-23T00:00:00.000Z';
    const entry = await saveAnalysis(project, second, 'main', { canonicalSegmented: true });
    await saveAnalysis(project, second, 'main', { canonicalSegmented: true });
    const root = path.join(storagePath, `${entry.file}.sections`);
    const pointer = await fs.readJson(path.join(root, 'current.json'));
    assert.match(pointer.previous, /^gen-[a-f0-9]{64}$/);
    await writeCompressedJsonAtomic(path.join(storagePath, entry.file), first);
    await fs.writeFile(path.join(root, pointer.current, 'manifest.json'), '{"corrupt":true}\n');
    clearLoadedAnalysisCache();
    await assert.rejects(loadAnalysis(project), /does not match the analysis index/);
    await assert.rejects(loadAnalysis(project, { preferAuthoritative: true }), /does not match the analysis index/);
    await assert.rejects(loadCompleteAnalysisFromSections(project), /does not match the analysis index/);
  });
});

test('a failed whole analysis never falls through to an older canonical generation', async () => {
  await withStoragePath(async storagePath => {
    const project = '/tmp/canonical-failed-current-project';
    const prior = casFixture('prior-canonical');
    await saveAnalysis(project, prior, 'main', { canonicalSegmented: true });
    const failed = casFixture('failed-current');
    failed.analysis_timestamp = '2026-07-24T00:00:00.000Z';
    failed.layers_ready = {
      complete: false,
      layers: [
        { layer: 'L0', status: 'ready' },
        { layer: 'L1', status: 'ready' },
        { layer: 'L2', status: 'error', error: 'graph construction failed' },
        { layer: 'L3', status: 'ready' },
        { layer: 'L4', status: 'ready' },
      ],
    } as CASOutput['layers_ready'];
    const failedEntry = await saveAnalysis(project, failed, 'main', { canonicalSegmented: true });
    assert.equal(failedEntry.storage_format, 'whole-json');
    assert.equal(await fs.pathExists(path.join(storagePath, `${failedEntry.file}.sections`, 'current.json')), true);
    clearLoadedAnalysisCache();
    assert.equal(await loadAnalysisSectionManifest(project), null);
    assert.equal(await loadAnalysisSections(project, ['graph']), null);
    assert.equal(await loadCompleteAnalysisFromSections(project), null);
    assert.equal(await loadAnalysis(project), null);
    assert.equal(await resolveAnalysisExportArtifact(project), null);
    assert.equal(await loadCompactAnalysisGraph(project), null);
    assert.equal(await loadCompactAnalysisSearch(project), null);
  });
});

test('a newer valid whole analysis wins over an older corrupt canonical pointer', async () => {
  await withStoragePath(async storagePath => {
    const project = '/tmp/canonical-newer-whole-project';
    const priorEntry = await saveAnalysis(project, casFixture('prior-canonical'), 'main', { canonicalSegmented: true });
    const current = casFixture('current-whole');
    current.analysis_timestamp = '2026-07-25T00:00:00.000Z';
    await saveAnalysis(project, current, 'main', { writeSegmentedAnalysis: false });
    const sectionRoot = path.join(storagePath, `${priorEntry.file}.sections`);
    const pointer = await fs.readJson(path.join(sectionRoot, 'current.json'));
    await fs.writeFile(path.join(sectionRoot, pointer.current, 'manifest.json'), '{"corrupt":true}\n');
    clearLoadedAnalysisCache();
    assert.equal((await loadAnalysisSectionManifest(project))?.analysis_id, current.analysis_id);
    assert.equal((await loadAnalysisSections(project, ['graph']))?.analysis_id, current.analysis_id);
    assert.equal((await loadCompleteAnalysisFromSections(project))?.analysis_id, current.analysis_id);
    assert.equal((await loadAnalysis(project))?.analysis_id, current.analysis_id);
    assert.match((await resolveAnalysisExportArtifact(project))?.filePath || '', /\.json(?:\.zst|\.br)?$/);
    assert.equal(await loadCompactAnalysisGraph(project), null);
    assert.equal(await loadCompactAnalysisSearch(project), null);
  });
});

test('canonical generations retain a reader grace window and concurrent publishers leave a valid lineage', async () => {
  await withStoragePath(async storagePath => {
    const project = '/tmp/canonical-concurrent-project';
    for (const id of ['grace-first', 'grace-second', 'grace-third']) {
      const cas = casFixture(id);
      cas.analysis_timestamp = `2026-07-2${id === 'grace-first' ? 1 : id === 'grace-second' ? 2 : 3}T00:00:00.000Z`;
      await saveAnalysis(project, cas, 'main', { canonicalSegmented: true });
    }
    const entry = JSON.parse(await fs.readFile(path.join(storagePath, 'index.json'), 'utf8')).analyses[project];
    const root = path.join(storagePath, `${entry.file}.sections`);
    assert.equal((await fs.readdir(root)).filter(name => name.startsWith('gen-')).length, 3);

    await Promise.all(['concurrent-a', 'concurrent-b'].map(async id => {
      const cas = casFixture(id);
      cas.analysis_timestamp = id === 'concurrent-a' ? '2026-07-24T00:00:00.000Z' : '2026-07-25T00:00:00.000Z';
      await saveAnalysis(project, cas, 'main', { canonicalSegmented: true });
    }));
    const pointer = await fs.readJson(path.join(root, 'current.json'));
    assert.match(pointer.current, /^gen-[a-f0-9]{64}$/);
    if (pointer.previous) assert.notEqual(pointer.previous, pointer.current);
    assert.ok(['concurrent-a', 'concurrent-b'].includes((await loadAnalysis(project))!.analysis_id));
  });
});

test('legacy export stays on one immutable generation across concurrent pointer flips', async () => {
  await withStoragePath(async storagePath => {
    const project = '/tmp/canonical-pinned-export-project';
    const first = casFixture('pinned-first');
    first.nodes[0].description = 'x'.repeat(2 * 1024 * 1024);
    const entry = await saveAnalysis(project, first, 'main', { canonicalSegmented: true });
    const wholePath = path.join(storagePath, entry.file);
    const exportPath = path.join(storagePath, 'pinned-export.json');

    const exporting = writeSegmentedLegacyExport(wholePath, exportPath);
    await Promise.all(['pinned-second', 'pinned-third'].map(async (id, index) => {
      const cas = casFixture(id);
      cas.analysis_timestamp = `2026-07-${24 + index}T00:00:00.000Z`;
      await saveAnalysis(project, cas, 'main', { canonicalSegmented: true });
    }));
    await exporting;

    const exported = await fs.readJson(exportPath) as CASOutput;
    assert.equal(exported.analysis_id, 'pinned-first');
    assert.equal(exported.nodes[0].id, 'pinned-first-node');
    const root = `${wholePath}.sections`;
    assert.ok((await fs.readdir(root)).filter(name => name.startsWith('gen-')).length >= 2);
  });
});

test('storage access failures are classified explicitly and never read as a missing segmented index', () => {
  for (const code of ['EROFS', 'EACCES', 'EPERM']) {
    const classified = segmentedStorageAccessError('/tmp/project', Object.assign(new Error(code), { code }));
    assert.ok(classified instanceof SegmentedStorageAccessError);
    assert.equal(classified?.code, code);
    assert.match(classified?.message || '', /not accessible/);
  }
  assert.equal(segmentedStorageAccessError('/tmp/project', Object.assign(new Error('missing'), { code: 'ENOENT' })), null);
  assert.equal(segmentedStorageAccessError('/tmp/project', new Error('plain')), null);
});

test('a read-only segmented index fails explicitly instead of falling back to the whole-CAS path, even for a legacy index entry without storage_format', { skip: typeof process.getuid === 'function' && process.getuid() === 0 ? 'permission bits do not bind root' : false }, async () => {
  await withStoragePath(async storagePath => {
    const project = '/tmp/read-only-segmented-project';
    const cas = casFixture('read-only-segmented');
    (cas as unknown as { capabilities?: unknown }).capabilities = undefined;
    const entry = await saveAnalysis(project, cas, 'main', { canonicalSegmented: true });
    await waitForPendingSegmentedWrites();
    const sectionsRoot = `${path.join(storagePath, entry.file)}.sections`;
    const indexPath = path.join(storagePath, 'index.json');
    const index = await fs.readJson(indexPath);
    let downgraded = 0;
    for (const item of Object.values(index.analyses || {}) as Array<Record<string, unknown>>) {
      if (item && typeof item === 'object' && item.file === entry.file) {
        delete item.storage_format;
        downgraded += 1;
      }
    }
    assert.equal(downgraded, 1);
    await fs.writeJson(indexPath, index);
    await fs.chmod(sectionsRoot, 0o555);
    try {
      clearLoadedAnalysisCache();
      await assert.rejects(loadAnalysis(project), (error: unknown) => error instanceof SegmentedStorageAccessError && /EACCES|EPERM|EROFS/.test(String((error as SegmentedStorageAccessError).code)));
    } finally {
      await fs.chmod(sectionsRoot, 0o755);
    }
  });
});

test('an inaccessible segmented index pointer is never read as absent, independent of process privileges', async () => {
  const errno = (code: string) => Object.assign(new Error(code), { code });
  const legacyEntry = { path: '/tmp/legacy-project' };
  const absent = await segmentedReadFailureFallback(legacyEntry, '/tmp/store/legacy.json', errno('EROFS'), async () => { throw errno('ENOENT'); });
  assert.equal(absent, null);
  await assert.rejects(
    segmentedReadFailureFallback(legacyEntry, '/tmp/store/legacy.json', errno('EROFS'), async () => ({ size: 1 })),
    (error: unknown) => error instanceof SegmentedStorageAccessError && error.code === 'EROFS',
  );
  await assert.rejects(
    segmentedReadFailureFallback(legacyEntry, '/tmp/store/legacy.json', errno('EACCES'), async () => { throw errno('EACCES'); }),
    (error: unknown) => error instanceof SegmentedStorageAccessError && error.code === 'EACCES',
  );
  await assert.rejects(
    segmentedReadFailureFallback(legacyEntry, '/tmp/store/legacy.json', errno('EROFS'), async () => { throw errno('EIO'); }),
    (error: unknown) => error instanceof SegmentedStorageAccessError && error.code === 'EROFS',
  );
  assert.equal(await segmentedReadFailureFallback(legacyEntry, '/tmp/store/legacy.json', errno('ENOENT'), async () => ({ size: 1 })), null);
  await assert.rejects(segmentedReadFailureFallback({ path: '/p', storage_format: 'segmented-v2' }, '/tmp/store/x.json', errno('ENOENT'), async () => ({ size: 1 })), /ENOENT/);
});

test('canonical segmented saves record collection bytes measured from the section writes, equal to native JSON byte lengths', async () => {
  await withStoragePath(async () => {
    const project = '/tmp/collection-bytes-project';
    const cas = casFixture('collection-bytes');
    await saveAnalysis(project, cas, 'main', { canonicalSegmented: true });
    await waitForPendingSegmentedWrites();
    const manifest = (await loadAnalysisSectionManifest(project))!;
    const bytes = manifest.collection_bytes!;
    clearLoadedAnalysisCache();
    const persisted = (await loadCompleteAnalysisFromSections(project))! as unknown as Record<string, unknown>;
    assert.deepEqual(Object.keys(bytes), manifest.logical_fields.filter(field => field in bytes));
    assert.ok(Object.keys(bytes).length >= 8);
    for (const field of Object.keys(bytes)) {
      assert.equal(bytes[field], Buffer.byteLength(JSON.stringify(persisted[field]), 'utf8'), field);
    }
    assert.equal(manifest.collection_totals!.nodes, cas.nodes.length);
  });
});

test('canonical segmented storage is the default save path; the env opt-out and the explicit option decide otherwise', async () => {
  await withStoragePath(async storagePath => {
    const previous = process.env.KLAURO_CANONICAL_SEGMENTED_STORAGE;
    const restore = () => { if (previous === undefined) delete process.env.KLAURO_CANONICAL_SEGMENTED_STORAGE; else process.env.KLAURO_CANONICAL_SEGMENTED_STORAGE = previous; };
    try {
      delete process.env.KLAURO_CANONICAL_SEGMENTED_STORAGE;
      const unset = await saveAnalysis('/tmp/default-canonical-unset', casFixture('default-unset'));
      assert.equal(unset.storage_format, 'segmented-v2');
      assert.equal(await fs.pathExists(path.join(storagePath, unset.file)), false, 'no whole-CAS file when the variable is unset');
      assert.equal(await fs.pathExists(path.join(storagePath, `${unset.file}.sections`, 'current.json')), true);

      process.env.KLAURO_CANONICAL_SEGMENTED_STORAGE = '0';
      const optedOut = await saveAnalysis('/tmp/default-canonical-opt-out', casFixture('default-opt-out'));
      assert.notEqual(optedOut.storage_format, 'segmented-v2');
      assert.equal(await fs.pathExists(path.join(storagePath, optedOut.file)), true, 'the legacy opt-out still writes the whole-CAS file');

      const explicit = await saveAnalysis('/tmp/default-canonical-explicit', casFixture('default-explicit'), 'main', { canonicalSegmented: true });
      assert.equal(explicit.storage_format, 'segmented-v2', 'the explicit option wins over the env opt-out');
      assert.equal(await fs.pathExists(path.join(storagePath, explicit.file)), false);

      process.env.KLAURO_CANONICAL_SEGMENTED_STORAGE = '1';
      const legacyByOption = await saveAnalysis('/tmp/default-canonical-legacy-option', casFixture('default-legacy-option'), 'main', { canonicalSegmented: false });
      assert.notEqual(legacyByOption.storage_format, 'segmented-v2', 'the explicit option wins over the env opt-in');
    } finally {
      restore();
    }
  });
});
