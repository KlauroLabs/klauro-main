import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { runAgentIdiomBenchmark } from './agent-idiom-benchmark';

const repoRoot = path.resolve(__dirname, '..');
const fixturesRoot = path.join(repoRoot, 'fixtures', 'idioms');

test('idiom benchmark uses repo-task-sensitive deterministic baselines', async () => {
  const report = await runAgentIdiomBenchmark({
    repos: [
      { name: 'nestjs-api', path: path.join(fixturesRoot, 'nestjs-api') },
      { name: 'python-api', path: path.join(fixturesRoot, 'python-api') },
      { name: 'react-app', path: path.join(fixturesRoot, 'react-app') },
    ],
    maxTargets: 3,
    maxTasksPerRepo: 3,
    quiet: true,
  });

  const penalties = report.trials.map(trial => trial.without_klauro.baseline_model?.idiom_penalty).filter(Boolean);
  const factors = report.trials.flatMap(trial => trial.without_klauro.baseline_model?.factors || []);

  assert.equal(report.benchmark_type, 'deterministic-agent-idiom-quality-proxy');
  assert.ok(report.trials.length >= 3);
  assert.ok(new Set(penalties).size > 1, 'blind baseline penalties should vary across repo/task shapes');
  assert.ok(report.summary.deterministic_baseline_model);
  assert.ok(report.summary.deterministic_baseline_model.distinct_idiom_penalties > 1);
  assert.ok(factors.some(factor => factor.startsWith('category:')));
  assert.ok(factors.some(factor => factor.startsWith('support_files_missed:')));
});
