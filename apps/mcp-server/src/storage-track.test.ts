import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { saveAnalysis, loadAnalysis } from './storage';
import { revisionToTrack, trackSuffix } from './track';
import type { RepoRevision } from './revision';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';

async function withStoragePath<T>(fn: (storagePath: string) => Promise<T>): Promise<T> {
  const previous = process.env.KLAURO_STORAGE_PATH;
  const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-track-test-'));
  process.env.KLAURO_STORAGE_PATH = storagePath;
  try {
    return await fn(storagePath);
  } finally {
    if (previous === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previous;
    await fs.remove(storagePath);
  }
}

function makeCas(name: string, overrides: Partial<CASOutput> = {}): CASOutput {
  return {
    cas_version: '1.10.0',
    analysis_timestamp: '2026-07-01T00:00:00.000Z',
    analysis_id: `id-${name}`,
    system: { name, type: 'library' } as any,
    nodes: [],
    edges: [],
    analyzer_contributions: [],
    progressive_levels: {} as any,
    ...overrides,
  } as CASOutput;
}

test('revisionToTrack classifies dirty / default / other-branch correctly', () => {
  const dirty: RepoRevision = { branch: 'main', head_sha: 'abc', dirty: true, dirty_hash: 'h' };
  assert.equal(revisionToTrack(dirty), 'in-flight');

  const main: RepoRevision = { branch: 'main', head_sha: 'abc', dirty: false, dirty_hash: null };
  assert.equal(revisionToTrack(main), 'main');

  const master: RepoRevision = { branch: 'master', head_sha: 'abc', dirty: false, dirty_hash: null };
  assert.equal(revisionToTrack(master), 'main');

  const feature: RepoRevision = { branch: 'feature/x', head_sha: 'abc', dirty: false, dirty_hash: null };
  assert.equal(revisionToTrack(feature), 'other-branch');

  // explicit mainBranch overrides the main/master default
  assert.equal(revisionToTrack({ ...main, branch: 'develop' }, 'develop'), 'main');
  assert.equal(revisionToTrack({ ...main, branch: 'main' }, 'develop'), 'other-branch');
});

test('trackSuffix keeps main empty for backward compat', () => {
  assert.equal(trackSuffix('main'), '');
  assert.equal(trackSuffix('other-branch'), '.branch');
  assert.equal(trackSuffix('in-flight'), '.inflight');
});

test('main and in-flight coexist without overwriting each other', async () => {
  await withStoragePath(async (storagePath) => {
    const projectPath = '/tmp/example-project-track';

    await saveAnalysis(projectPath, makeCas('main-analysis'), 'main');
    await saveAnalysis(projectPath, makeCas('inflight-analysis'), 'in-flight');

    // Both on-disk files exist and neither clobbered the other.
    const files = await fs.readdir(storagePath);
    const jsonFiles = files.filter((f) => f.includes('.json'));
    const hasInflight = jsonFiles.some((f) => f.includes('.inflight.json'));
    const hasMain = jsonFiles.some((f) => /\.json/.test(f) && !f.includes('.inflight.') && !f.includes('.branch.'));
    assert.ok(hasInflight, `expected an .inflight file among ${jsonFiles.join(', ')}`);
    assert.ok(hasMain, `expected a main (suffixless) file among ${jsonFiles.join(', ')}`);

    // Default load surfaces the working state (in-flight) when one exists;
    // explicit tracks are honored exactly. Main is preserved and still reachable
    // via {track:'main'} — the whole point of Slice 1 (in-flight never clobbers it).
    const defaultLoaded = await loadAnalysis(projectPath);
    assert.equal(defaultLoaded?.system.name, 'inflight-analysis');

    const mainLoaded = await loadAnalysis(projectPath, { track: 'main' });
    assert.equal(mainLoaded?.system.name, 'main-analysis');

    const inflightLoaded = await loadAnalysis(projectPath, { track: 'in-flight' });
    assert.equal(inflightLoaded?.system.name, 'inflight-analysis');
  });
});

test('backward compat: save with no track arg loads via default main', async () => {
  await withStoragePath(async () => {
    const projectPath = '/tmp/example-project-legacy';
    await saveAnalysis(projectPath, makeCas('legacy-analysis'));
    const loaded = await loadAnalysis(projectPath);
    assert.equal(loaded?.system.name, 'legacy-analysis');
  });
});

test('base_commit and branch propagate onto the AnalysisEntry', async () => {
  await withStoragePath(async () => {
    const projectPath = '/tmp/example-project-meta';
    const entry = await saveAnalysis(
      projectPath,
      makeCas('meta-analysis', { base_commit: 'deadbeef', branch: 'main' }),
      'main'
    );
    assert.equal(entry.track, 'main');
    assert.equal(entry.base_commit, 'deadbeef');
    assert.equal(entry.branch, 'main');
  });
});
