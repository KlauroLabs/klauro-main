import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stampRepoFacts } from './remote-analyzer-service';
import { getAnalysis } from './analyzer';
import { CAS_VERSION, type CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import type { SourceManifest } from './remote-source';

/**
 * Analyzer-wiring coverage for the repo_facts data path's server side: the
 * client derives contributor_count/first_commit_at/last_commit_at from git
 * (remote-source.ts deriveRepoFacts) and carries them on the upload
 * manifest, but the analysis pipeline itself has no git access into the
 * client's working tree — so remote-analyzer-service.ts stampRepoFacts is
 * the one place that copies manifest.repo_facts onto CASOutput.system after
 * analysis completes, AND re-persists via saveAnalysis so a later plain
 * GET /api/projects/{id}/analysis (a disk read, not a re-analysis) still
 * sees it. This test exercises exactly that: build a minimal CASOutput,
 * stamp it, then reload from storage independently of the in-memory object.
 */

function minimalCas(workspace: string): CASOutput {
  return {
    cas_version: CAS_VERSION,
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'repo-facts-wiring-test',
    system: {
      id: 'system_test',
      name: 'test-system',
      type: 'application',
      root_path: workspace,
    },
    nodes: [],
    edges: [],
    analyzer_contributions: [],
    progressive_levels: { total_levels: 0 },
  };
}

function withTempWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-repo-facts-storage-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-repo-facts-workspace-'));
  const previousStoragePath = process.env.KLAURO_STORAGE_PATH;
  process.env.KLAURO_STORAGE_PATH = storageRoot;
  return run(workspace).finally(() => {
    if (previousStoragePath === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previousStoragePath;
    fs.rmSync(storageRoot, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });
}

test('stampRepoFacts: manifest.repo_facts lands on system.repo_facts AND survives a fresh getAnalysis() reload', async () => {
  await withTempWorkspace(async workspace => {
    const cas = minimalCas(workspace);
    const manifest: SourceManifest = {
      generated_at: new Date().toISOString(),
      root: workspace,
      file_count: 0,
      total_bytes: 0,
      excluded_directories: [],
      repo_facts: {
        contributor_count: 3,
        first_commit_at: '2020-01-01T00:00:00Z',
        last_commit_at: '2026-07-01T00:00:00Z',
      },
    };

    await stampRepoFacts(workspace, cas, manifest);
    assert.deepEqual(cas.system.repo_facts, manifest.repo_facts, 'in-memory CAS should be stamped immediately');

    // Reload independently from storage (simulates a later, unrelated
    // GET /api/projects/{id}/analysis that never sees the in-memory `cas`
    // object above) — proves the stamp was persisted, not just mutated.
    const reloaded = await getAnalysis(workspace);
    assert.deepEqual(reloaded.system.repo_facts, manifest.repo_facts, 'persisted analysis should carry repo_facts on reload');
  });
});

test('stampRepoFacts: no manifest.repo_facts is a no-op (does not fabricate a value, does not force a save)', async () => {
  await withTempWorkspace(async workspace => {
    const cas = minimalCas(workspace);
    const manifest: SourceManifest = {
      generated_at: new Date().toISOString(),
      root: workspace,
      file_count: 0,
      total_bytes: 0,
      excluded_directories: [],
    };

    await stampRepoFacts(workspace, cas, manifest);
    assert.equal(cas.system.repo_facts, undefined);

    // Nothing was ever saved for this workspace, so a reload must fail
    // rather than return a synthesized empty repo_facts.
    await assert.rejects(() => getAnalysis(workspace));
  });
});
