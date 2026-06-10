import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { runSeededExistingTaskBenchmark } from './agent-existing-task-benchmark';

test('seeded existing-task benchmark covers non-greenfield engineering families', async () => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-existing-task-proof-'));
  const report = await runSeededExistingTaskBenchmark({
    outputRoot,
    reportPath: null,
    markdownPath: null,
    live: false,
    liveConfig: {},
    withoutArmRetrieval: false,
    realRepoPath: null,
    realTaskId: null,
  });

  assert.equal(report.status, 'pass');
  assert.equal(report.summary.scenario_count, 14);
  assert.equal(report.summary.family_count, 13);
  assert.equal(report.summary.passing_scenarios, 14);
  assert.equal(report.summary.proof_strength, 'deterministic-proxy');
  assert.match(report.summary.claim_limit, /not final live-agent quality/);
  assert.ok(report.summary.average_score_delta > 0);
  assert.ok(report.summary.average_file_reduction_percentage > 0);
  assert.ok(report.summary.average_token_reduction_percentage > 0);
  assert.equal(report.summary.live_scenarios, 0);
  assert.deepEqual(
    new Set(report.scenarios.map(scenario => scenario.family)),
    new Set([
      'bug-diagnosis-root-cause',
      'bug-fix-live-edits',
      'real-product-enhancements',
      'architectural-change-refactor',
      'monolith-decomposition',
      'schema-migration-changes',
      'auth-tenant-boundary-changes',
      'auth-system-replacement',
      'mfa-security-enhancement',
      'test-addition-coverage',
      'performance-fixes',
      'cross-repo-contract-changes',
      'large-feature-integration',
    ])
  );
});
