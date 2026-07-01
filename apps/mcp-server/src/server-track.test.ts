/**
 * Track-aware config + MCP-surface tests (three-analysis-tracks slices 4 & 5).
 *
 * Covers: (a) .klaurorc parses project.mainBranch; (b) revisionToTrack respects
 * the configured mainBranch; (c) resolveCurrentTrack wires config + revision;
 * (d) the track selector routes loadAnalysis to the in-flight track while
 * omitting it preserves the default view; (e) list_analyses filtering/projection
 * surfaces each entry's track and filters by track, backward compatibly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'node:child_process';
import { saveAnalysis, loadAnalysis } from './storage';
import { revisionToTrack, resolveCurrentTrack } from './track';
import { loadKlauroConfig, writeDefaultKlauroConfig } from './klauro-config';
import { listAnalysesFiltered } from './analysis-listing';
import type { RepoRevision } from './revision';
import type { AnalysisEntry } from './storage';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';

async function withStoragePath<T>(fn: (storagePath: string) => Promise<T>): Promise<T> {
  const previous = process.env.KLAURO_STORAGE_PATH;
  const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-server-track-'));
  process.env.KLAURO_STORAGE_PATH = storagePath;
  try {
    return await fn(storagePath);
  } finally {
    if (previous === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previous;
    await fs.remove(storagePath);
  }
}

function makeCas(name: string): CASOutput {
  return {
    cas_version: '1.10.0',
    analysis_timestamp: '2026-07-01T00:00:00.000Z',
    analysis_id: `id-${name}`,
    system: { name, type: 'library' } as any,
    nodes: [],
    edges: [],
    analyzer_contributions: [],
    progressive_levels: {} as any,
  } as CASOutput;
}

// (a) + (b): configured mainBranch flips classification for a non-main default.
test('klauro-config parses project.mainBranch and revisionToTrack respects it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-mainbranch-'));
  try {
    await writeDefaultKlauroConfig(root, { force: true });
    const rc = path.join(root, '.klaurorc');
    const raw = JSON.parse(await fs.readFile(rc, 'utf8'));
    raw.project.mainBranch = 'develop';
    await fs.writeFile(rc, `${JSON.stringify(raw, null, 2)}\n`);

    const loaded = await loadKlauroConfig(root);
    assert.equal(loaded.config.project.mainBranch, 'develop');

    // develop is the configured default → 'main'; main is now just another branch.
    const onDevelop: RepoRevision = { branch: 'develop', head_sha: 'a', dirty: false, dirty_hash: null };
    const onMain: RepoRevision = { branch: 'main', head_sha: 'a', dirty: false, dirty_hash: null };
    assert.equal(revisionToTrack(onDevelop, loaded.config.project.mainBranch), 'main');
    assert.equal(revisionToTrack(onMain, loaded.config.project.mainBranch), 'other-branch');

    // Backward compatible: omitted mainBranch keeps main/master as default.
    assert.equal(revisionToTrack(onMain), 'main');
    assert.equal(revisionToTrack(onDevelop), 'other-branch');
  } finally {
    await fs.remove(root);
  }
});

// (c): resolveCurrentTrack reads the configured mainBranch + live git revision.
test('resolveCurrentTrack classifies the current branch using the configured mainBranch', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-resolve-track-'));
  try {
    const opts = { cwd: root, encoding: 'utf8' as const };
    spawnSync('git', ['init'], opts);
    spawnSync('git', ['config', 'user.email', 't@t.test'], opts);
    spawnSync('git', ['config', 'user.name', 'Test'], opts);
    spawnSync('git', ['checkout', '-b', 'develop'], opts);
    await fs.writeFile(path.join(root, 'a.txt'), 'hello\n');

    await writeDefaultKlauroConfig(root, { force: true });
    const rc = path.join(root, '.klaurorc');
    const raw = JSON.parse(await fs.readFile(rc, 'utf8'));
    raw.project.mainBranch = 'develop';
    await fs.writeFile(rc, `${JSON.stringify(raw, null, 2)}\n`);

    // Commit everything (incl. .klaurorc) so the working tree is clean.
    spawnSync('git', ['add', '-A'], opts);
    spawnSync('git', ['commit', '-m', 'init'], opts);

    // Clean tree on the configured default branch → 'main'.
    assert.equal(await resolveCurrentTrack(root), 'main');

    // Dirty tree → 'in-flight' regardless of branch.
    await fs.appendFile(path.join(root, 'a.txt'), 'edit\n');
    assert.equal(await resolveCurrentTrack(root), 'in-flight');

    // Non-git path → null (nothing to classify).
    const notGit = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-notgit-'));
    try {
      assert.equal(await resolveCurrentTrack(notGit), null);
    } finally {
      await fs.remove(notGit);
    }
  } finally {
    await fs.remove(root);
  }
});

// (d): the track selector (as threaded by getAnalysis/get_summary/get_analysis_facts)
// routes loadAnalysis to in-flight; omitting it preserves the default view.
test('track selector routes loadAnalysis to in-flight; omitting preserves default', async () => {
  await withStoragePath(async () => {
    const projectPath = '/tmp/track-select-project';
    await saveAnalysis(projectPath, makeCas('committed-main'), 'main');
    await saveAnalysis(projectPath, makeCas('dirty-wip'), 'in-flight');

    // Explicit in-flight track → in-flight analysis.
    const inflight = await loadAnalysis(projectPath, { track: 'in-flight' });
    assert.equal(inflight?.system.name, 'dirty-wip');

    // Explicit main track → committed baseline, never clobbered by the WIP.
    const main = await loadAnalysis(projectPath, { track: 'main' });
    assert.equal(main?.system.name, 'committed-main');

    // Omitted → default view surfaces in-flight when present.
    const def = await loadAnalysis(projectPath);
    assert.equal(def?.system.name, 'dirty-wip');
  });
});

// (e): list projection surfaces track and the optional filter is backward compatible.
test('listAnalysesFiltered surfaces track and filters by track without hiding defaults', () => {
  const base = {
    name: 'x', path: '/p', system_type: 'library', frameworks: [],
    node_count: 1, edge_count: 0, analyzed_at: '2026-07-01T00:00:00.000Z',
    file: 'f', cas_version: '1.10.0',
  };
  const entries: AnalysisEntry[] = [
    { ...base, name: 'legacy', track: undefined } as any, // legacy → treated as 'main'
    { ...base, name: 'branch', track: 'other-branch' } as any,
    { ...base, name: 'wip', track: 'in-flight' } as any,
  ];

  // No track filter → nothing hidden; every entry carries a resolved track.
  const all = listAnalysesFiltered(entries, {});
  assert.equal(all.matched, 3);
  const legacy = all.analyses.find((a: any) => a.name === 'legacy') as any;
  assert.equal(legacy.track, 'main');

  // Filter by in-flight → only the WIP entry.
  const wipOnly = listAnalysesFiltered(entries, { track: 'in-flight' });
  assert.equal(wipOnly.matched, 1);
  assert.equal((wipOnly.analyses[0] as any).name, 'wip');

  // Legacy (undefined track) entries match a 'main' filter.
  const mainOnly = listAnalysesFiltered(entries, { track: 'main' });
  assert.equal(mainOnly.matched, 1);
  assert.equal((mainOnly.analyses[0] as any).name, 'legacy');
});
