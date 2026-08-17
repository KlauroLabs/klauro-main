import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { classifyComprehensionOutcome, createRemoteAnalyzerHttpServer, requestConsumesMutationRateLimit, resolveHostedReleaseNodeRange, revisionMatchesSnapshot, stampRepoFacts, stampRepoFactsFromLastKnownOrMarkAbsent } from './remote-analyzer-service';
import { analysisJobMetadata } from './analysis-job-metadata';
import { REMOTE_ANALYSIS_PROTOCOL_VERSION, type RemoteAnalyzeRequest, type RemoteProjectRevision } from './remote-analyzer-protocol';
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

test('hosted release manifest advertises no fabricated Node ceiling', () => {
  // A genuinely-published, valid max_node is honored as-is.
  assert.deepEqual(resolveHostedReleaseNodeRange({ min_node: 18, max_node: 24 }), { minNode: 18, maxNode: 24 });
  // No max_node in the manifest (the normal case — write-release-manifest.mjs
  // never sets one, since the customer tarball has no native addon to bound)
  // means no ceiling, not a fabricated 24: the client path is verified to run
  // on Node 24 and Node 26 unmodified.
  assert.deepEqual(resolveHostedReleaseNodeRange({ min_node: 18 }), { minNode: 18, maxNode: null });
  // An invalid max (below min, or absurdly high) is dropped, not repaired to 24.
  assert.deepEqual(resolveHostedReleaseNodeRange({ min_node: 24, max_node: 18 }), { minNode: 24, maxNode: null });
  assert.deepEqual(resolveHostedReleaseNodeRange({ min_node: 18, max_node: 999 }), { minNode: 18, maxNode: null });
});

test('status polling and other reads do not consume the hosted mutation rate limit', () => {
  assert.equal(requestConsumesMutationRateLimit('GET'), false);
  assert.equal(requestConsumesMutationRateLimit('HEAD'), false);
  assert.equal(requestConsumesMutationRateLimit('OPTIONS'), false);
  assert.equal(requestConsumesMutationRateLimit('POST'), true);
  assert.equal(requestConsumesMutationRateLimit('PATCH'), true);
  assert.equal(requestConsumesMutationRateLimit('DELETE'), true);
});

test('public release artifacts answer HEAD without authentication or a response body', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-public-artifact-'));
  const downloads = path.join(root, 'downloads');
  fs.mkdirSync(downloads);
  fs.writeFileSync(path.join(downloads, 'klauro-latest.tgz'), 'artifact');
  const previousDownloads = process.env.KLAURO_DOWNLOADS_DIR;
  const previousCoordination = process.env.KLAURO_COORD_DIR;
  process.env.KLAURO_DOWNLOADS_DIR = downloads;
  process.env.KLAURO_COORD_DIR = path.join(root, 'data', 'coordination');
  const server = createRemoteAnalyzerHttpServer({ dataDir: path.join(root, 'data') });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.equal(typeof address, 'object');
    const response = await fetch(`http://127.0.0.1:${address && typeof address === 'object' ? address.port : 0}/dist/klauro-latest.tgz`, { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-length'), '8');
    assert.equal(await response.text(), '');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousDownloads === undefined) delete process.env.KLAURO_DOWNLOADS_DIR;
    else process.env.KLAURO_DOWNLOADS_DIR = previousDownloads;
    if (previousCoordination === undefined) delete process.env.KLAURO_COORD_DIR;
    else process.env.KLAURO_COORD_DIR = previousCoordination;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('background analysis metadata does not retain uploaded source files', () => {
  const manifest: SourceManifest = {
    generated_at: new Date().toISOString(),
    root: '/repo',
    file_count: 1,
    total_bytes: 18,
    excluded_directories: [],
  };
  const request: RemoteAnalyzeRequest = {
    protocol_version: REMOTE_ANALYSIS_PROTOCOL_VERSION,
    project_path: '/repo',
    snapshot: {
      project_name: 'large-project',
      snapshot_source: 'committed-head',
      files: [{ path: 'src/index.ts', content: 'export const x = 1', hash: 'source-hash' }],
      manifest,
    },
  };

  const metadata = analysisJobMetadata(request);

  assert.equal(metadata.displayName, 'large-project');
  assert.equal(metadata.manifest, manifest);
  assert.equal('snapshot' in metadata, false);
  assert.equal('files' in metadata, false);
});

test('committed snapshot reuse requires the exact source digest when both sides provide one', () => {
  const revision: RemoteProjectRevision = {
    analysis_id: 'analysis',
    analysis_revision: 1,
    branch: 'main',
    commit: 'abc123',
    source: 'local_commit_submission',
    generated_at: new Date().toISOString(),
    files: 2,
    bytes: 20,
    nodes: 10,
    edges: 12,
    snapshot_digest: 'digest-a',
  };
  const manifest: SourceManifest = {
    generated_at: new Date().toISOString(),
    root: '/repo',
    branch: 'main',
    base_commit: 'abc123',
    file_count: 2,
    total_bytes: 20,
    snapshot_digest: 'digest-a',
    excluded_directories: [],
  };

  assert.equal(revisionMatchesSnapshot(revision, manifest, 'abc123'), true);
  assert.equal(revisionMatchesSnapshot(revision, { ...manifest, snapshot_digest: 'digest-b' }, 'abc123'), false);
  assert.equal(revisionMatchesSnapshot(revision, manifest, 'different-commit'), false);
  assert.equal(revisionMatchesSnapshot({ ...revision, analysis_focus: 'agent-fast' }, manifest, 'abc123', 'agent-fast'), true);
  assert.equal(revisionMatchesSnapshot({ ...revision, analysis_focus: 'agent-fast' }, manifest, 'abc123', 'full'), false);
  assert.equal(revisionMatchesSnapshot(revision, manifest, 'abc123', 'agent-fast'), false);
});

test('legacy revisions without a digest reuse only matching commit, branch, file count, and bytes', () => {
  const revision: RemoteProjectRevision = {
    analysis_id: 'analysis',
    analysis_revision: 1,
    branch: 'main',
    commit: 'abc123',
    source: 'local_commit_submission',
    generated_at: new Date().toISOString(),
    files: 2,
    bytes: 20,
    nodes: 10,
    edges: 12,
  };
  const manifest: SourceManifest = {
    generated_at: new Date().toISOString(),
    root: '/repo',
    branch: 'main',
    file_count: 2,
    total_bytes: 20,
    excluded_directories: [],
  };

  assert.equal(revisionMatchesSnapshot(revision, manifest, 'abc123'), true);
  assert.equal(revisionMatchesSnapshot(revision, { ...manifest, total_bytes: 21 }, 'abc123'), false);
  assert.equal(revisionMatchesSnapshot(revision, { ...manifest, branch: 'release' }, 'abc123'), false);
});

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

/**
 * v1.0.124 repo_facts regression: server-side reanalyzes (`/api/projects/:id/
 * reanalyze`, `/api/workspaces/:id/reanalyze`) re-run against the STORED
 * snapshot with no client `.git` in reach, so `manifest.repo_facts` is never
 * available on those paths and a fresh CAS shipped with the keys silently
 * omitted — not just absent-with-a-reason, gone with no explanation at all.
 * `stampRepoFactsFromLastKnownOrMarkAbsent` is the fix: fall back to the
 * project's last-known repo_facts (persisted from an earlier /v1/analyze or
 * /v1/sync push), or stamp an honest absence marker when there is no
 * last-known value either — never fabricate, never silently omit.
 */
test('stampRepoFacts: client-derived manifest.repo_facts always wins, even over a pre-existing (e.g. snapshot/synthetic-derived) system.repo_facts value', async () => {
  await withTempWorkspace(async workspace => {
    const cas = minimalCas(workspace);
    // Simulate some other, non-client-manifest source having already stamped
    // a value onto the CAS before stampRepoFacts runs — analyzer-core has no
    // git access of its own (see this file's header comment), so in
    // production this slot should only ever be filled by a real client
    // manifest, but the precedence must hold even if something else got here
    // first: the real, client-derived facts must never be shadowed by a
    // stale or synthetic value already sitting on `system`.
    cas.system.repo_facts = { contributor_count: 1, first_commit_at: '2026-07-21T03:13:45Z', last_commit_at: '2026-07-21T03:13:45Z' };

    const manifest: SourceManifest = {
      generated_at: new Date().toISOString(),
      root: workspace,
      file_count: 0,
      total_bytes: 0,
      excluded_directories: [],
      repo_facts: {
        contributor_count: 5,
        first_commit_at: '2019-03-14T00:00:00Z',
        last_commit_at: '2026-07-20T00:00:00Z',
      },
    };

    await stampRepoFacts(workspace, cas, manifest);
    assert.deepEqual(cas.system.repo_facts, manifest.repo_facts, 'real client-derived facts must overwrite whatever was there before');
  });
});

test('stampRepoFactsFromLastKnownOrMarkAbsent: falls back to the project\'s last-known repo_facts and persists it', async () => {
  await withTempWorkspace(async workspace => {
    const cas = minimalCas(workspace);
    const lastKnown = {
      contributor_count: 5,
      first_commit_at: '2019-03-01T00:00:00Z',
      last_commit_at: '2026-07-20T00:00:00Z',
    };

    await stampRepoFactsFromLastKnownOrMarkAbsent(workspace, cas, lastKnown);
    assert.deepEqual(cas.system.repo_facts, lastKnown);
    assert.equal(cas.system.repo_facts_status, undefined, 'a real value must not also carry an absence marker');

    const reloaded = await getAnalysis(workspace);
    assert.deepEqual(reloaded.system.repo_facts, lastKnown, 'persisted analysis should carry the fallback repo_facts on reload');
  });
});

test('stampRepoFactsFromLastKnownOrMarkAbsent: no last-known value stamps an honest absence reason, never a fabricated value', async () => {
  await withTempWorkspace(async workspace => {
    const cas = minimalCas(workspace);

    await stampRepoFactsFromLastKnownOrMarkAbsent(workspace, cas, undefined);
    assert.equal(cas.system.repo_facts, undefined, 'must never fabricate a repo_facts value');
    assert.equal(cas.system.repo_facts_status?.available, false);
    assert.ok(cas.system.repo_facts_status?.reason && cas.system.repo_facts_status.reason.length > 0);

    const reloaded = await getAnalysis(workspace);
    assert.equal(reloaded.system.repo_facts, undefined);
    assert.equal(reloaded.system.repo_facts_status?.available, false);
  });
});

test('stampRepoFactsFromLastKnownOrMarkAbsent: does not overwrite an already-stamped repo_facts on the CAS itself', async () => {
  await withTempWorkspace(async workspace => {
    const cas = minimalCas(workspace);
    cas.system.repo_facts = { contributor_count: 1, first_commit_at: '2021-01-01T00:00:00Z', last_commit_at: '2021-06-01T00:00:00Z' };

    // Even with no last-known project value, an already-present repo_facts on
    // the CAS (e.g. this exact rebuild's own worker already carried one
    // forward) must never be clobbered with an absence marker.
    await stampRepoFactsFromLastKnownOrMarkAbsent(workspace, cas, undefined);
    assert.deepEqual(cas.system.repo_facts, { contributor_count: 1, first_commit_at: '2021-01-01T00:00:00Z', last_commit_at: '2021-06-01T00:00:00Z' });
    assert.equal(cas.system.repo_facts_status, undefined);
  });
});

/**
 * TASK #143: the beta-blocking defect measured on a real 4,810-file/85,652-
 * node client repo was `status: 'degraded'` with 2 of 12 capabilities
 * shipped without AI enrichment — an honest-but-terminal-sounding label that
 * read identically to a fully-failed AI comprehension pass. These cases must
 * stay distinguishable: only a genuine AI-pass failure (aiDegraded) may ever
 * produce comprehensionFailed (the only input the `/analysis` route's status
 * computation uses to select the terminal 'degraded' status); a partial
 * shortfall must always classify as comprehensionPartial instead, which the
 * route reports as 'ready' with the gap named.
 */
test('classifyComprehensionOutcome: a real AI-pass failure is comprehensionFailed, never comprehensionPartial', () => {
  const result = classifyComprehensionOutcome({
    aiDegraded: true,
    comprehensionAttempted: true,
    namingTotal: 12,
    namingAuthored: 0,
    nameDegradationCount: 0,
    descriptionDegradationCount: 0,
  });
  assert.equal(result.comprehensionFailed, true);
  assert.equal(result.comprehensionPartial, false);
});

test('classifyComprehensionOutcome: 2 of 12 capabilities un-enriched is a partial shortfall, never the terminal failure', () => {
  const result = classifyComprehensionOutcome({
    aiDegraded: false,
    comprehensionAttempted: true,
    namingTotal: 12,
    namingAuthored: 10,
    nameDegradationCount: 0,
    descriptionDegradationCount: 0,
  });
  assert.equal(result.comprehensionFailed, false);
  assert.equal(result.comprehensionPartial, true);
});

test('classifyComprehensionOutcome: a comprehension pass that ran and authored NOTHING is still the audited full failure shape (partial, not silently "ready")', () => {
  const result = classifyComprehensionOutcome({
    aiDegraded: false,
    comprehensionAttempted: true,
    namingTotal: 12,
    namingAuthored: 0,
    nameDegradationCount: 0,
    descriptionDegradationCount: 0,
  });
  assert.equal(result.comprehensionFailed, false);
  assert.equal(result.comprehensionPartial, true);
});

test('classifyComprehensionOutcome: structure-only mode (comprehension never attempted) degrades neither flag', () => {
  const result = classifyComprehensionOutcome({
    aiDegraded: false,
    comprehensionAttempted: false,
    namingTotal: undefined,
    namingAuthored: undefined,
    nameDegradationCount: 0,
    descriptionDegradationCount: 0,
  });
  assert.equal(result.comprehensionFailed, false);
  assert.equal(result.comprehensionPartial, false);
});

test('classifyComprehensionOutcome: fully healthy comprehension (no degradations) is neither failed nor partial', () => {
  const result = classifyComprehensionOutcome({
    aiDegraded: false,
    comprehensionAttempted: true,
    namingTotal: 12,
    namingAuthored: 12,
    nameDegradationCount: 0,
    descriptionDegradationCount: 0,
  });
  assert.equal(result.comprehensionFailed, false);
  assert.equal(result.comprehensionPartial, false);
});
