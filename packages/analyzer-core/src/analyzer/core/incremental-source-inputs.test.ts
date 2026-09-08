import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CASAnalyzerContribution, CASOutput } from '../../types/cas.types';
import { IncrementalSourceInputRefresh } from './incremental-source-inputs';
import { compactCasSourceInputIdentities } from './cas-source-input-identities';
import { sourceInputObservation } from './analyzer-source-inputs';
import { refreshProjectScopedContributions } from './incremental-contribution-refresh';
import { withAnalyzerFileReadCache } from './analyzer-file-read-cache';
import { buildAnalyzerContributionSummary } from './analyzer-contribution-summary';

function contribution(id: string, file: string, text = file): CASAnalyzerContribution {
  return { analyzer_id: id, analyzer_name: id, contribution_type: 'pattern',
    source_inputs: { version: 1, coverage: 'observed-reads', digest_algorithm: 'sha256', outside_root_reads: 0,
      files: [{ path: file, ...sourceInputObservation(text, 'utf8') }] } };
}

function fixture(contributors: CASAnalyzerContribution[]): CASOutput {
  return { analysis_id: 'old', nodes: [], edges: [], system: { root_path: '/project' },
    analyzer_contributions: contributors } as CASOutput;
}


test('unchanged observed envelopes survive incremental compaction and root relocation', () => {
  for (const shared of [false, true]) {
    const previous = fixture([contribution('changed', 'member/src/a.ts'), contribution('untouched', 'shared/config.json')]);
    previous.system.root_path = '/old/project/member';
    previous.source_input_root = '/old/project';
    previous.children = [fixture([contribution('child', 'child.ts')])];
    if (shared) compactCasSourceInputIdentities(previous);
    const before = structuredClone(previous);
    const result = new IncrementalSourceInputRefresh('/new/member', previous, ['src/a.ts']).apply(previous);
    assert.equal(result.source_input_root, '/new');
    assert.equal(result.analyzer_contributions[1].source_inputs?.coverage, 'observed-reads');
    const inputs = result.analyzer_contributions[1].source_inputs;
    assert.ok(inputs?.version === 2);
    assert.deepEqual(inputs.identity_indices.map(index => result.source_input_identities![index]),
      [{ path: 'shared/config.json', ...sourceInputObservation('shared/config.json', 'utf8') }]);
    assert.equal(result.analyzer_contributions[0].source_inputs?.coverage, 'unavailable');
    assert.deepEqual(previous, before);
    assert.equal(result.children, previous.children);
  }
});

test('file refresh captures actual reads and retains unchanged inputs across generations', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-file-observations-'));
  try {
    const file = path.join(root, 'source.ts');
    await fs.writeFile(file, 'observed');
    const previous = fixture([contribution('reader', 'source.ts', 'old')]);
    previous.system.root_path = root;
    previous.analyzer_contributions[0].source_inputs = {
      ...previous.analyzer_contributions[0].source_inputs!,
      version: 1, files: [
        { path: 'source.ts', ...sourceInputObservation('old', 'utf8') },
        { path: 'config.json', ...sourceInputObservation('unchanged', 'utf8') },
      ],
    };
    compactCasSourceInputIdentities(previous);
    const refresh = new IncrementalSourceInputRefresh(root, previous, ['source.ts']);
    await withAnalyzerFileReadCache(() => refresh.analyzeFile('reader', file, async () => {
      assert.equal(await fs.readFile(file, 'utf8'), 'observed');
      await fs.writeFile(file, 'newer on disk');
      return true;
    }));
    const result = refresh.apply(previous);
    const inputs = result.analyzer_contributions[0].source_inputs;
    assert.ok(inputs?.version === 2);
    assert.equal(inputs.coverage, 'observed-reads');
    assert.deepEqual(inputs.identity_indices.map(index => result.source_input_identities![index]), [
      { path: 'config.json', ...sourceInputObservation('unchanged', 'utf8') },
      { path: 'source.ts', ...sourceInputObservation('observed', 'utf8') },
    ]);
    assert.equal(new IncrementalSourceInputRefresh(root, result, ['unrelated.ts']).affectedAnalyzerIds.size, 0);
  } finally {
    await fs.remove(root);
  }
});

test('unobserved cache results and new inputs require project refresh rather than invented provenance', async () => {
  const previous = fixture([contribution('reader', 'src/a.ts')]);
  const registration = { id: 'reader', analyzer: {
    incrementalContributionScope: () => 'file' as const, supportsIncrementalAnalysis: () => true,
    analyzeFileSingle: async () => ({}), getRelevantFiles: async () => ['src/a.ts', 'src/new.ts'],
  } };
  for (const file of ['src/a.ts', 'src/new.ts']) {
    const refresh = await new IncrementalSourceInputRefresh('/project', previous, [file]).resolveFileEligibility([registration]);
    await refresh.analyzeFile('reader', file, async () => ({ cached: true }));
    const selected = new Set<string>();
    refresh.finalizeFileAnalysis([registration], selected);
    assert.deepEqual([...selected], ['reader']);
    assert.equal(refresh.apply(previous).analyzer_contributions[0].source_inputs?.coverage, 'unavailable');
  }
});

test('cache bookkeeping is not attributed as analyzer source evidence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-input-cache-'));
  try {
    await fs.outputFile(path.join(root, 'source.ts'), 'source');
    await fs.outputFile(path.join(root, 'cache.json'), '{"value":1}');
    const previous = fixture([contribution('reader', 'source.ts', 'source')]);
    previous.system.root_path = root;
    for (const hit of [true, false]) {
      const refresh = new IncrementalSourceInputRefresh(root, previous, []);
      await withAnalyzerFileReadCache(() => refresh.analyzeFile('reader', 'source.ts', async () => {
        await fs.readFile(path.join(root, 'source.ts'), 'utf8');
        return { value: 1 };
      }, {
        key: 'cache',
        load: async () => { await fs.readFile(path.join(root, 'cache.json'), 'utf8'); return hit ? { value: 1 } : null; },
        save: async () => { await fs.readFile(path.join(root, 'cache.json'), 'utf8'); },
      }));
      const result = refresh.apply(previous);
      assert.deepEqual(result.source_input_identities, [{ path: 'source.ts', ...sourceInputObservation('source', 'utf8') }]);
    }
  } finally {
    await fs.remove(root);
  }
});

test('project observations are rebased into a retained enclosing source root', () => {
  const previous = fixture([contribution('reader', 'member/source.ts', 'old')]);
  previous.system.root_path = '/old/member';
  previous.source_input_root = '/old';
  const refresh = new IncrementalSourceInputRefresh('/new/member', previous, ['source.ts']);
  refresh.record(contribution('reader', 'source.ts', 'new'));
  const result = refresh.apply(previous);
  assert.equal(result.source_input_root, '/new');
  assert.deepEqual(result.source_input_identities, [{ path: 'member/source.ts', ...sourceInputObservation('new', 'utf8') }]);
});

test('conflicting reads across file executions request refresh rather than selecting the last digest', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-input-conflicts-'));
  try {
    const file = path.join(root, 'source.ts');
    const previous = fixture([contribution('reader', 'source.ts', 'old')]);
    previous.system.root_path = root;
    const registration = { id: 'reader', analyzer: {
      incrementalContributionScope: () => 'file' as const, supportsIncrementalAnalysis: () => true,
      analyzeFileSingle: async () => ({}), getRelevantFiles: async () => [file],
    } };
    const refresh = await new IncrementalSourceInputRefresh(root, previous, ['source.ts']).resolveFileEligibility([registration]);
    for (const value of ['first', 'second']) {
      await fs.outputFile(file, value);
      await withAnalyzerFileReadCache(() => refresh.analyzeFile('reader', file, () => fs.readFile(file, 'utf8')));
    }
    const selected = new Set<string>();
    refresh.finalizeFileAnalysis([registration], selected);
    assert.deepEqual([...selected], ['reader']);
    assert.equal(refresh.apply(previous).analyzer_contributions[0].source_inputs?.coverage, 'unavailable');
  } finally {
    await fs.remove(root);
  }
});

test('newly consumed files extend an observed footprint without forcing a project rerun', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-new-input-'));
  try {
    const file = path.join(root, 'new.ts');
    await fs.outputFile(file, 'new');
    const previous = fixture([contribution('reader', 'old.ts', 'old')]);
    previous.system.root_path = root;
    const registration = { id: 'reader', analyzer: {
      incrementalContributionScope: () => 'file' as const, supportsIncrementalAnalysis: () => true,
      analyzeFileSingle: async () => ({}), getRelevantFiles: async () => [file],
    } };
    const refresh = await new IncrementalSourceInputRefresh(root, previous, ['new.ts']).resolveFileEligibility([registration]);
    await withAnalyzerFileReadCache(() => refresh.analyzeFile('reader', file, () => fs.readFile(file, 'utf8')));
    const selected = new Set<string>();
    refresh.finalizeFileAnalysis([registration], selected);
    assert.deepEqual([...selected], []);
    const result = refresh.apply(previous);
    assert.equal(result.analyzer_contributions[0].source_inputs?.coverage, 'observed-reads');
    assert.deepEqual(result.source_input_identities?.map(input => input.path).sort(), ['new.ts', 'old.ts']);
  } finally {
    await fs.remove(root);
  }
});
test('contribution summaries expose category identifiers and preserve unknown versions', () => {
  const summary = buildAnalyzerContributionSummary({
    registration: { id: 'reader', name: 'Reader', type: 'pattern' }, executionTime: 0, filesCreated: 0,
    result: { analyzer_metadata: { analyzer_id: 'reader', analyzer_name: 'Reader', contribution_type: 'pattern' },
      categories: { level_1: { functions: {}, classes: {} }, level_2: { functions: {} }, level_3: undefined } },
  });
  assert.deepEqual(summary.contributed_categories, ['classes', 'functions']);
  assert.equal(summary.analyzer_version, undefined);
});

test('observed input changes select contributors even when their graph contribution was empty', () => {
  for (const shared of [false, true]) {
    const cas = fixture([contribution('reader', 'src/a.ts'), contribution('unrelated', 'src/b.ts')]);
    if (shared) compactCasSourceInputIdentities(cas);
    assert.deepEqual([...new IncrementalSourceInputRefresh('/project', cas, ['src/a.ts']).affectedAnalyzerIds], ['reader']);
    assert.deepEqual([...new IncrementalSourceInputRefresh('/project', cas, []).affectedAnalyzerIds], []);
  }
});

test('affected file analyzers use single-file refresh, while project and unsupported analyzers stay conservative', () => {
  const cas = fixture(['file', 'project', 'unsupported', 'missing'].map(id => contribution(id, 'src/a.ts')));
  const refresh = new IncrementalSourceInputRefresh('/project', cas, ['src/a.ts']);
  const registration = (id: string, scope: 'file' | 'project', supported: boolean) => ({
    id, analyzer: { incrementalContributionScope: () => scope, supportsIncrementalAnalysis: () => supported,
      analyzeFileSingle: async () => ({}) },
  });
  assert.deepEqual([...refresh.projectAnalyzerIds([
    registration('file', 'file', true), registration('project', 'project', true),
    registration('unsupported', 'file', false),
  ])], ['project', 'unsupported', 'missing']);
  assert.equal(refresh.affectedAnalyzerIds.has('file'), true);
});

test('affected file analyzers follow their own file discovery even without previous facts', async () => {
  const cas = fixture([contribution('manifest-reader', 'src/a.ts'), contribution('new-framework', 'src/a.ts')]);
  const registrations = ['manifest-reader', 'new-framework'].map(id => ({ id, analyzer: {
    incrementalContributionScope: () => 'file' as const,
    supportsIncrementalAnalysis: () => true,
    analyzeFileSingle: async () => ({}),
    getRelevantFiles: async () => id === 'manifest-reader' ? ['BuildSpec'] : ['src/a.ts'],
  } }));
  const refresh = await new IncrementalSourceInputRefresh('/project', cas, ['src/a.ts']).resolveFileEligibility(registrations);
  assert.deepEqual(refresh.matchingAnalyzerIds('src/a.ts'), ['new-framework']);
  assert.deepEqual(refresh.matchingAnalyzerIds('BuildSpec'), ['manifest-reader']);
  assert.deepEqual(refresh.matchingAnalyzerIds('src/unrelated.ts'), []);
  assert.deepEqual([...refresh.projectAnalyzerIds(registrations)], ['manifest-reader']);
  assert.equal(refresh.affectedAnalyzerIds.has('manifest-reader'), true);
});

test('affected analyzer file discovery resolves paths within its monorepo root', async () => {
  const cas = fixture([contribution('reader', 'packages/library/src/a.ts')]);
  const roots: string[] = [];
  const registration = { id: 'reader', analyzer: {
    incrementalContributionScope: () => 'file' as const,
    supportsIncrementalAnalysis: () => true,
    analyzeFileSingle: async () => ({}),
    getRelevantFiles: async (root: string) => { roots.push(root); return ['src/a.ts']; },
  } };
  const refresh = await new IncrementalSourceInputRefresh('/project', cas, ['packages/library/src/a.ts'])
    .resolveFileEligibility([registration], new Map([['reader', '/project/packages/library']]));
  assert.deepEqual(roots, ['/project/packages/library']);
  assert.deepEqual(refresh.matchingAnalyzerIds('packages/library/src/a.ts'), ['reader']);
  assert.deepEqual(refresh.matchingAnalyzerIds('src/a.ts'), []);
});

test('affected analyzers without single-file execution are never matched onto source files', async () => {
  const cas = fixture([contribution('reader', 'src/a.ts')]);
  const registration = { id: 'reader', analyzer: {
    incrementalContributionScope: () => 'file' as const,
    supportsIncrementalAnalysis: () => true,
    getRelevantFiles: async () => ['src/a.ts'],
  } };
  const refresh = await new IncrementalSourceInputRefresh('/project', cas, ['src/a.ts']).resolveFileEligibility([registration]);
  assert.deepEqual(refresh.matchingAnalyzerIds('src/a.ts'), []);
  assert.deepEqual([...refresh.projectAnalyzerIds([registration])], ['reader']);
});

test('unknown file eligibility requests a conservative refresh instead of running on arbitrary files', async () => {
  const cas = fixture([contribution('reader', 'src/a.ts')]);
  const registration = { id: 'reader', analyzer: {
    incrementalContributionScope: () => 'file' as const,
    supportsIncrementalAnalysis: () => true,
    analyzeFileSingle: async () => ({}),
  } };
  const refresh = await new IncrementalSourceInputRefresh('/project', cas, ['src/a.ts']).resolveFileEligibility([registration]);
  assert.deepEqual(refresh.matchingAnalyzerIds('src/a.ts'), []);
  assert.deepEqual([...refresh.projectAnalyzerIds([registration])], ['reader']);
});

test('changed dependencies outside file eligibility and deleted inputs require project refresh', async () => {
  for (const relevant of [['src/consumer.py'], []]) {
    const cas = fixture([contribution('reader', 'src/shared.ts')]);
    const registration = { id: 'reader', analyzer: {
      incrementalContributionScope: () => 'file' as const, supportsIncrementalAnalysis: () => true,
      analyzeFileSingle: async () => ({}), getRelevantFiles: async () => relevant,
    } };
    const refresh = await new IncrementalSourceInputRefresh('/project', cas, ['src/shared.ts']).resolveFileEligibility([registration]);
    assert.deepEqual(refresh.matchingAnalyzerIds('src/shared.ts'), []);
    assert.deepEqual([...refresh.projectAnalyzerIds([registration])], ['reader']);
    assert.equal(refresh.apply(cas).analyzer_contributions[0].source_inputs?.coverage, 'unavailable');
  }
});

test('unavailable observations require project refresh even when single-file execution exists', () => {
  const cas = fixture([contribution('file', 'src/a.ts')]);
  cas.analyzer_contributions[0].source_inputs!.coverage = 'unavailable';
  const refresh = new IncrementalSourceInputRefresh('/project', cas, ['src/b.ts']);
  assert.equal(refresh.affectedAnalyzerIds.has('file'), true);
  assert.deepEqual([...refresh.projectAnalyzerIds([{ id: 'file', analyzer: {
    incrementalContributionScope: () => 'file', supportsIncrementalAnalysis: () => true,
    analyzeFileSingle: async () => ({}),
  } }])], ['file']);
  const result = refresh.apply(cas);
  assert.equal(result.analyzer_contributions[0].source_inputs?.coverage, 'unavailable');
  assert.deepEqual(result.source_input_identities, []);
});

test('source identities resolve in their owning root, not just by basename', () => {
  const cas = fixture([contribution('reader', 'src/a.ts')]);
  cas.source_input_root = '/project/member';
  assert.equal(new IncrementalSourceInputRefresh('/project', cas, ['src/a.ts']).affectedAnalyzerIds.size, 0);
  assert.deepEqual([...new IncrementalSourceInputRefresh('/project', cas, ['member/src/a.ts']).affectedAnalyzerIds], ['reader']);
});

test('moving a project preserves relative input ownership without confusing a nested source root', () => {
  const cas = fixture([contribution('reader', 'member/src/a.ts')]);
  cas.system.root_path = '/old/project/member';
  cas.source_input_root = '/old/project';
  assert.deepEqual([...new IncrementalSourceInputRefresh('/new/member', cas, ['src/a.ts']).affectedAnalyzerIds], ['reader']);
  assert.equal(new IncrementalSourceInputRefresh('/new/member', cas, ['member/src/a.ts']).affectedAnalyzerIds.size, 0);
});

test('invalid references or unavailable observations require refresh instead of looking unrelated', () => {
  const cas = fixture([contribution('reader', 'src/a.ts')]);
  compactCasSourceInputIdentities(cas);
  const inputs = cas.analyzer_contributions[0].source_inputs;
  assert.ok(inputs?.version === 2);
  inputs.identity_indices = [99];
  assert.deepEqual([...new IncrementalSourceInputRefresh('/project', cas, ['src/b.ts']).affectedAnalyzerIds], ['reader']);
  inputs.identity_indices = [];
  inputs.coverage = 'unavailable';
  assert.deepEqual([...new IncrementalSourceInputRefresh('/project', cas, ['src/b.ts']).affectedAnalyzerIds], ['reader']);
});

test('a new generation compacts fresh observations without modifying old or nested identity tables', () => {
  const previous = fixture([contribution('reader', 'src/a.ts', 'old')]);
  compactCasSourceInputIdentities(previous);
  const child = fixture([contribution('child', 'src/a.ts', 'child')]);
  compactCasSourceInputIdentities(child);
  previous.children = [child];
  const before = structuredClone(previous);
  const refresh = new IncrementalSourceInputRefresh('/project', previous, ['src/a.ts']);
  refresh.record(contribution('reader', 'src/a.ts', 'new'));
  const result = refresh.apply(previous);
  const expected = fixture([contribution('reader', 'src/a.ts', 'new')]);
  compactCasSourceInputIdentities(expected);
  assert.deepEqual(result.source_input_identities, expected.source_input_identities);
  assert.deepEqual(result.analyzer_contributions, expected.analyzer_contributions);
  assert.deepEqual(previous, before);
  assert.equal(result.children, previous.children);
  assert.deepEqual(result.children, before.children);
});

test('unrefreshed or legacy contributors never acquire invented observations', () => {
  const previous = fixture([contribution('reader', 'src/a.ts'), { analyzer_id: 'legacy', analyzer_name: 'legacy', contribution_type: 'pattern' }]);
  compactCasSourceInputIdentities(previous);
  const result = new IncrementalSourceInputRefresh('/project', previous, ['src/a.ts']).apply(previous);
  assert.equal(result.analyzer_contributions[0].source_inputs?.coverage, 'unavailable');
  assert.equal(result.analyzer_contributions[0].source_inputs?.reason, 'incremental-input-identities-not-refreshed');
  assert.equal(result.analyzer_contributions[1].source_inputs, undefined);
  assert.deepEqual(result.source_input_identities, []);
});

test('project refresh records bytes actually read, not bytes written later before the analyzer returns', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-refresh-observations-'));
  try {
    const file = path.join(root, 'source.ts');
    await fs.writeFile(file, 'observed');
    const collected: CASAnalyzerContribution[] = [];
    const graph = { nodes: [], edges: [], entryPoints: [], exitPoints: [] };
    const result = await withAnalyzerFileReadCache(() => refreshProjectScopedContributions({
      projectPath: root, analyzerIds: new Set(['reader']), graph, ownershipGraph: graph,
      registrations: [{ id: 'reader', type: 'pattern', analyzer: {
        async analyze() {
          assert.equal(await fs.readFile(file, 'utf8'), 'observed');
          await fs.writeFile(file, 'newer on disk');
          return { nodes: [], edges: [], analyzer_metadata: {
            analyzer_id: 'reader', analyzer_name: 'Reader', version: '1.0.0', contribution_type: 'pattern',
            nodes_contributed: 0, edges_contributed: 0, contributed_entry_points: 0, contributed_exit_points: 0,
          } };
        },
      } }],
      analyzerRoot: () => root, analysisFilters: [], scopeFilters: () => [],
      normalizeContribution: () => {}, mergeContribution: async current => current,
      onContribution: value => collected.push(value),
    }));
    assert.ok(result);
    const inputs = collected[0].source_inputs;
    assert.ok(inputs?.version === 1);
    assert.deepEqual(inputs.files, [{ path: 'source.ts', ...sourceInputObservation('observed', 'utf8') }]);
    assert.equal(await fs.readFile(file, 'utf8'), 'newer on disk');
  } finally {
    await fs.remove(root);
  }
});
