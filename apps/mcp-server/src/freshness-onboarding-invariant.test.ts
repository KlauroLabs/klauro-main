import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

// This test proves the core invariant from docs/SPEC-FRESHNESS.md end to end,
// through the actual onboarding tool paths (not internals):
//
//   1. New-file pickup: adding a NEW file with a NEW function after the initial
//      analysis is visible via get_coding_context (the onboarding "call this
//      before writing ANY code" tool) WITHOUT a manual re-analyze call — the
//      freshness gate wired into getFreshAnalysisForAgent triggers the refresh.
//   2. Changed-file-only cost: once fresh, a repeat call over an UNCHANGED repo
//      does not re-parse everything — it costs roughly a git-diff scan, not a
//      full re-analysis. We assert this via wall-clock: the unchanged-call is
//      dramatically cheaper than the initial full analysis, and the analysis
//      output identity for cheap (get_summary/search_nodes) calls proves the
//      incremental early-return-on-no-changes path (analyzer.ts) is exercised,
//      not a fresh full rebuild.
//
// Uses process functions directly (not spawning the MCP transport) since that
// is how the existing incremental test suite in this file's directory verifies
// analyzer.ts / agent-project-map.ts behavior.

function withTempDir(prefix: string, run: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return run(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function initRepo(root: string): void {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export function alpha() { return 1; }\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture' }));
  git(root, ['init']);
  git(root, ['-c', 'user.email=test@klauro.dev', '-c', 'user.name=Klauro Test', '-c', 'commit.gpgsign=false', 'add', '.']);
  git(root, ['-c', 'user.email=test@klauro.dev', '-c', 'user.name=Klauro Test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'init']);
}

test('freshness-on-read: a new file with a new function is visible via onboarding tools without a manual re-analyze, and an unchanged repeat call is cheap', { timeout: 120000 }, async () => {
  const previousStorage = process.env.KLAURO_STORAGE_PATH;
  await withTempDir('klauro-freshness-invariant-', async root => {
    const storage = path.join(root, 'storage');
    process.env.KLAURO_STORAGE_PATH = storage;
    try {
      // Import after KLAURO_STORAGE_PATH is set so storage.ts's module-level
      // resolution (if any is memoized at import time) sees the temp path.
      const { analyzeProjectIncremental, getAnalysis } = await import('./analyzer');
      const query = await import('./query');
      const { summarizeAnalysisFreshness, clearFreshnessSummaryCache } = await import('./freshness');

      const project = path.join(root, 'project');
      initRepo(project);

      // Mirror the onboarding-tool freshness gate exactly (server.ts
      // getFreshAnalysisForAgent): cheap staleness check, refresh only if
      // stale, else return cached CAS untouched.
      async function getFreshAnalysisForAgent(projectPath: string) {
        const cas = await getAnalysis(projectPath);
        const summary = summarizeAnalysisFreshness(projectPath, cas.analysis_timestamp);
        if (!summary || summary.staleness === 'fresh') return cas;
        return (await analyzeProjectIncremental(projectPath)).output;
      }

      // --- Step 1: initial analysis (first-ever call establishes the baseline). ---
      const initialStart = Date.now();
      await analyzeProjectIncremental(project);
      const initialDurationMs = Date.now() - initialStart;

      const initialCas = await getFreshAnalysisForAgent(project);
      assert.equal(initialCas.layers_ready?.complete, false, 'disabled AI must remain visible as incomplete');
      assert.deepEqual(
        initialCas.layers_ready?.layers.map(layer => [layer.layer, layer.status]),
        [['L0', 'ready'], ['L1', 'ready'], ['L2', 'ready'], ['L3', 'ready'], ['L4', 'error'], ['L5', 'error']],
        'structural freshness must be ready while unavailable AI comprehension remains fail-closed',
      );
      assert.ok(
        (initialCas.nodes || []).some(n => n.name === 'alpha'),
        'initial analysis should see the original alpha() function',
      );
      assert.ok(
        !(initialCas.nodes || []).some(n => n.name === 'newModuleFn'),
        'the new module has not been created yet',
      );

      // --- Step 2: add a brand-new file with a brand-new function (the exact
      // gap this spec targets: a new coordination/-style module being
      // invisible until a manual re-analyze). Simulate the common uncommitted
      // agent workflow (write file, don't commit yet). ---
      fs.mkdirSync(path.join(project, 'src', 'newmodule'), { recursive: true });
      fs.writeFileSync(
        path.join(project, 'src', 'newmodule', 'index.ts'),
        'export function newModuleFn() { return 42; }\n',
      );

      // --- Step 3: call the onboarding path (get_coding_context equivalent)
      // WITHOUT any manual re-analyze call in between. ---
      clearFreshnessSummaryCache();
      const preRefreshSummary = summarizeAnalysisFreshness(project, initialCas.analysis_timestamp);
      assert.ok(preRefreshSummary, 'freshness summary should be computable');
      assert.notEqual(preRefreshSummary!.staleness, 'fresh', 'adding a new file must be detected as staleness');

      const refreshedCas = await getFreshAnalysisForAgent(project);
      assert.deepEqual(
        refreshedCas.layers_ready?.layers.map(layer => [layer.layer, layer.status]),
        [['L0', 'ready'], ['L1', 'ready'], ['L2', 'ready'], ['L3', 'ready'], ['L4', 'error'], ['L5', 'error']],
        'changed-file refresh must preserve structural readiness without concealing disabled AI comprehension',
      );
      const codingContext = query.getCodingContext(refreshedCas, 'newModuleFn', {});
      assert.ok(
        !('error' in codingContext),
        `get_coding_context should resolve the brand-new function without a manual re-analyze, got: ${JSON.stringify(codingContext)}`,
      );
      assert.equal((codingContext as any).target_node?.name, 'newModuleFn');

      const summaryAfterAdd = query.buildSummary(refreshedCas);
      assert.ok(summaryAfterAdd, 'get_summary equivalent should succeed after the freshness-gated refresh');

      // --- Step 4: changed-file-only cost. A second onboarding call over an
      // UNCHANGED repo must not re-parse everything: it should early-return
      // via analyzer.ts's "zero changes -> previous output untouched" path,
      // which is dramatically cheaper than the initial full analysis. ---
      clearFreshnessSummaryCache();
      const unchangedStart = Date.now();
      const unchangedCas = await getFreshAnalysisForAgent(project);
      const unchangedDurationMs = Date.now() - unchangedStart;

      assert.ok(
        (unchangedCas.nodes || []).some(n => n.name === 'newModuleFn'),
        'the previously-added function must still be visible on the unchanged repeat call',
      );
      assert.ok(
        unchangedDurationMs < initialDurationMs,
        `unchanged-repeat call (${unchangedDurationMs}ms) should cost meaningfully less than the initial full analysis (${initialDurationMs}ms) -- changed-file-only cost model`,
      );
      // The unchanged call is expected to be a cheap git-diff/staleness check
      // (tens of ms), not a re-parse of the whole fixture; bound it well under
      // the initial analysis to make the "not re-parsing everything" claim
      // concrete rather than just "somewhat faster".
      assert.ok(
        unchangedDurationMs < 500,
        `unchanged-repeat call took ${unchangedDurationMs}ms -- expected a bounded, cheap staleness check, not a re-parse`,
      );
    } finally {
      if (previousStorage === undefined) delete process.env.KLAURO_STORAGE_PATH;
      else process.env.KLAURO_STORAGE_PATH = previousStorage;
    }
  });
});
