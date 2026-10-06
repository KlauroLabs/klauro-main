/**
 * Competitor-scorecard unit test — NO NETWORK, NO analyzeForBench.
 *
 * We inject a stub runner set (opts.runners) so the generator's normalization,
 * camp grouping, verdict mapping, and markdown rendering are exercised with
 * fully deterministic inputs — the same code path the live CLI takes, minus the
 * product calls. Nothing here reaches the analyzer server or a competitor binary.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateCompetitorScorecard,
  renderScorecardMarkdown,
  type ScorecardRow,
  type ScorecardRunners,
} from './competitor-scorecard';

function row(partial: Partial<ScorecardRow> & Pick<ScorecardRow, 'camp' | 'scenario' | 'verdict'>): ScorecardRow {
  return {
    task: 't',
    metric: 'F1',
    klauro_score: 1.0,
    best_competitor: 'x',
    best_competitor_score: 0.0,
    ...partial,
  };
}

/** A stub runner set: Camp A (a win + a tie), Camp B (two wins), Camp C (a win,
 *  out-of-category). No losses anywhere. */
const stubRunners: Partial<ScorecardRunners> = {
  campCRoutes: async () => [
    row({ camp: 'A', scenario: 'camp-c-routes-vs-cbm: express-routes', best_competitor: 'codebase-memory', best_competitor_score: 0.0, verdict: 'win' }),
    row({ camp: 'A', scenario: 'camp-c-routes-vs-cbm: fastapi-routes', best_competitor: 'codebase-memory', best_competitor_score: 1.0, klauro_score: 1.0, verdict: 'tie' }),
  ],
  behavioralDiff: async () => [
    row({ camp: 'A', scenario: 'depth-behavioral-diff-vs-cbm: auth-removed', best_competitor: 'codebase-memory', best_competitor_score: 0.0, verdict: 'win' }),
  ],
  primitiveCallers: async () => [
    row({ camp: 'B', scenario: 'primitive-who-calls: callers-py', best_competitor: 'cursor-proxy', best_competitor_score: 0.5, verdict: 'win' }),
  ],
  wasCrossRepo: async () => [
    row({ camp: 'B', scenario: 'was-cross-repo: ui-api-worker', best_competitor: 'scip-typescript', best_competitor_score: 0.0, verdict: 'win' }),
  ],
  frameworkRoutes: async () => [
    row({ camp: 'C', scenario: 'framework-routes: express-routes', best_competitor: 'none', best_competitor_score: null, verdict: 'win' }),
  ],
  ormRelations: async () => [
    row({ camp: 'C', scenario: 'orm-relations: drizzle', best_competitor: 'none', best_competitor_score: null, verdict: 'win' }),
  ],
  componentTree: async () => [
    row({ camp: 'C', scenario: 'component-tree: react', best_competitor: 'none', best_competitor_score: null, verdict: 'win' }),
  ],
  structuralLanguages: async () => [
    row({ camp: 'B', scenario: 'structural-languages: ts', best_competitor: 'scip-typescript', best_competitor_score: 1, verdict: 'tie' }),
  ],
};

test('normalizes injected runner rows into A/B/C camps with correct counts', async () => {
  const report = await generateCompetitorScorecard({
    runners: stubRunners,
    timestamp: '2026-07-01T00:00:00.000Z',
    endpoint: 'https://mcp.klauro.com',
  });

  const byCamp = Object.fromEntries(report.camps.map(c => [c.camp, c]));
  // Camp A: campCRoutes (1 win + 1 tie) + behavioralDiff (1 win) = 2 wins + 1 tie.
  assert.equal(byCamp.A.rows.length, 3);
  assert.equal(byCamp.A.wins, 2);
  assert.equal(byCamp.A.ties, 1);
  assert.equal(byCamp.A.losses, 0);
  assert.equal(byCamp.B.rows.length, 3);
  assert.equal(byCamp.B.wins, 2);
  assert.equal(byCamp.B.ties, 1);
  assert.equal(byCamp.B.losses, 0);
  assert.equal(byCamp.C.rows.length, 3);
  assert.equal(byCamp.C.wins, 3);

  assert.equal(report.totals.scenarios, 9);
  assert.equal(report.totals.wins, 7);
  assert.equal(report.totals.ties, 2);
  assert.equal(report.totals.losses, 0);
  assert.equal(report.complete, true);
  assert.equal(report.zeroLosses, true);
  assert.equal(report.endpoint, 'https://mcp.klauro.com');
});

test('renderScorecardMarkdown separates measured, proxy, and unopposed evidence', async () => {
  const report = await generateCompetitorScorecard({
    runners: stubRunners,
    timestamp: '2026-07-01T00:00:00.000Z',
    endpoint: 'https://mcp.klauro.com',
  });
  const md = renderScorecardMarkdown(report);

  assert.match(md, /# Klauro Competitor Scorecard/);
  assert.match(md, /Endpoint: `https:\/\/mcp\.klauro\.com`/);
  assert.match(md, /Generated: 2026-07-01T00:00:00\.000Z/);
  // Each camp heading + a table header row.
  assert.match(md, /## Camp A — vs codebase-memory/);
  assert.match(md, /## Camp B — vs structural indexers/);
  assert.match(md, /## Camp C — comprehension/);
  assert.match(md, /\| Scenario \| Metric \| Klauro \| Best competitor \| Evidence \| Verdict \|/);
  // A specific normalized row rendered.
  assert.match(md, /camp-c-routes-vs-cbm: express-routes .* WIN/);
  // Out-of-category competitor rendered as n/a (no score).
  assert.match(md, /none \(n\/a\)/);
  assert.match(md, /none \(n\/a\) \| unopposed \| CAPABILITY/);
  assert.match(md, /cursor-proxy 0\.50 \| proxy \| PROXY WIN/);
  assert.match(md, /\*\*No measured losses\*\*/);
  assert.match(md, /Evidence: 5 named head-to-head \/ 1 proxy \/ 3 unopposed/);
  assert.match(md, /Proxy and unopposed rows .* do not establish competitor wins/);
  assert.match(md, /Raw outcomes across all evidence kinds: 7 win \/ 2 tie \/ 0 loss across 9 scenarios/);
});

test('runner errors make the scorecard incomplete and suppress the zero-loss claim', async () => {
  const report = await generateCompetitorScorecard({
    runners: {
      ...stubRunners,
      campCRoutes: async () => {
        throw new Error('codebase-memory unavailable');
      },
    },
    timestamp: 'x',
  });
  assert.equal(report.complete, false);
  assert.equal(report.zeroLosses, false);
  assert.deepEqual(report.runner_failures, [{ runner: 'campCRoutes', error: 'codebase-memory unavailable' }]);
  assert.match(renderScorecardMarkdown(report), /\*\*Incomplete evidence\*\*/);
});

test('a loss anywhere flips zeroLosses and the summary line', async () => {
  const withLoss: Partial<ScorecardRunners> = {
    ...stubRunners,
    structuralLanguages: async () => [
      row({ camp: 'B', scenario: 'structural-languages: ts [who-calls]', best_competitor: 'scip-typescript', best_competitor_score: 1.0, klauro_score: 0.9, verdict: 'loss' }),
    ],
  };
  const report = await generateCompetitorScorecard({ runners: withLoss, timestamp: 'x' });
  assert.equal(report.zeroLosses, false);
  assert.equal(report.totals.losses, 1);
  const md = renderScorecardMarkdown(report);
  assert.match(md, /\*\*1 loss\(es\)\*\* — a Klauro bug to fix/);
});
