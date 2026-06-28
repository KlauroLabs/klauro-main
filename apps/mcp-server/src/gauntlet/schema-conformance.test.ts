/**
 * Structural conformance of a fully-assembled GauntletReport — the invariants
 * the UI relies on. Reports are built by hand (validateWin + summarize populate
 * verdicts/summary) so we assert the contract the real runner must also satisfy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWin, summarize } from './win-validator';
import {
  ARMS,
  type ArmResult,
  type ScenarioResult,
  type GauntletReport,
  type GauntletProgress,
} from './report-schema';

const ARM_IDS = new Set(ARMS.map(a => a.id));

function arm(arm_id: string, metrics: ArmResult['metrics']): ArmResult {
  return { arm_id, mode: 'projected', attempted: true, metrics };
}

function doneScenario(id: string, armResults: ArmResult[], won = true): ScenarioResult {
  return {
    scenario_id: id,
    label: id,
    group: 'single-repo',
    status: 'done',
    execution: 'projected',
    arms: armResults,
    verdict: validateWin(armResults, 'edge'),
  };
}

function winningArms(): ArmResult[] {
  return [
    arm('klauro', { quality: 90, time_ms: 1000, tokens: 1000 }),
    arm('no-tools', { quality: 60, time_ms: 9000, tokens: 9000 }),
  ];
}

function losingArms(): ArmResult[] {
  return [
    arm('klauro', { quality: 50, time_ms: 9000, tokens: 9000 }),
    arm('ctags', { quality: 80, time_ms: 1000, tokens: 1000 }),
  ];
}

function buildReport(scenarios: ScenarioResult[]): GauntletReport {
  const completed = scenarios.filter(s => s.status === 'done').length;
  const running = scenarios.filter(s => s.status === 'running').length;
  const pending = scenarios.filter(s => s.status === 'pending').length;
  const errored = scenarios.filter(s => s.status === 'error').length;
  const progress: GauntletProgress = {
    total_scenarios: scenarios.length,
    completed,
    running,
    pending,
    errored,
  };
  return {
    schema_version: 1,
    run_id: 'test-run',
    generated_at: new Date().toISOString(),
    mode: 'projected',
    status: 'done',
    progress,
    arms: ARMS,
    scenarios,
    summary: summarize(scenarios),
  };
}

test('progress counts sum to total_scenarios', () => {
  const report = buildReport([
    doneScenario('a', winningArms()),
    doneScenario('b', losingArms()),
    { scenario_id: 'c', label: 'c', group: 'workspace', status: 'pending', execution: 'projected', arms: [] },
    { scenario_id: 'd', label: 'd', group: 'workspace', status: 'running', execution: 'projected', arms: [] },
    { scenario_id: 'e', label: 'e', group: 'workspace', status: 'error', execution: 'projected', arms: [], error: 'boom' },
  ]);
  const p = report.progress;
  assert.equal(p.completed + p.running + p.pending + p.errored, p.total_scenarios);
});

test('summary scenarios_won + scenarios_lost <= number judged (done w/ verdict)', () => {
  const scenarios = [doneScenario('a', winningArms()), doneScenario('b', losingArms())];
  const report = buildReport(scenarios);
  const judged = scenarios.filter(s => s.status === 'done' && s.verdict).length;
  assert.ok(report.summary.scenarios_won + report.summary.scenarios_lost <= judged);
  assert.equal(report.summary.scenarios_won + report.summary.scenarios_lost, judged, 'all done scenarios here are judged');
});

test('every ScenarioResult arm references an arm_id that exists in ARMS', () => {
  const report = buildReport([doneScenario('a', winningArms()), doneScenario('b', losingArms())]);
  for (const s of report.scenarios) {
    for (const a of s.arms) assert.ok(ARM_IDS.has(a.arm_id), `${s.scenario_id}: unknown arm ${a.arm_id}`);
  }
});

test('contested verdict comparisons cover quality, time and tokens', () => {
  const v = doneScenario('a', winningArms()).verdict!;
  const metrics = v.comparisons.map(c => c.metric);
  assert.deepEqual(new Set(metrics), new Set(['quality', 'time', 'tokens']));
});

test('a done scenario always carries a verdict', () => {
  const report = buildReport([doneScenario('a', winningArms()), doneScenario('b', losingArms())]);
  for (const s of report.scenarios) {
    if (s.status === 'done') assert.ok(s.verdict, `${s.scenario_id} done without verdict`);
  }
});

test('a losing scenario carries a verdict.violation', () => {
  const loss = doneScenario('l', losingArms());
  assert.equal(loss.verdict!.klauro_wins, false);
  assert.ok(loss.verdict!.violation, 'losses must point at a suspected capability');
});

test('a winning scenario has no violation', () => {
  const win = doneScenario('w', winningArms());
  assert.equal(win.verdict!.klauro_wins, true);
  assert.equal(win.verdict!.violation, undefined);
});

test('summary.losses entries reference real scenario ids that lost', () => {
  const scenarios = [doneScenario('w', winningArms()), doneScenario('l', losingArms())];
  const report = buildReport(scenarios);
  const lostIds = new Set(scenarios.filter(s => !s.verdict!.klauro_wins).map(s => s.scenario_id));
  for (const loss of report.summary.losses) {
    assert.ok(lostIds.has(loss.scenario_id), `${loss.scenario_id} not actually a loss`);
  }
});

test('klauro_wins_all is true exactly when there are judged scenarios and zero losses', () => {
  const allWin = buildReport([doneScenario('a', winningArms()), doneScenario('b', winningArms())]);
  assert.equal(allWin.summary.klauro_wins_all, true);
  const mixed = buildReport([doneScenario('a', winningArms()), doneScenario('b', losingArms())]);
  assert.equal(mixed.summary.klauro_wins_all, false);
});

test('pending/running scenarios are excluded from the judged summary counts', () => {
  const scenarios: ScenarioResult[] = [
    doneScenario('a', winningArms()),
    { scenario_id: 'p', label: 'p', group: 'single-repo', status: 'pending', execution: 'projected', arms: [] },
  ];
  const report = buildReport(scenarios);
  assert.equal(report.summary.scenarios_won, 1);
  assert.equal(report.summary.scenarios_lost, 0);
});

test('report progress total equals the scenarios array length', () => {
  const scenarios = [doneScenario('a', winningArms()), doneScenario('b', losingArms())];
  const report = buildReport(scenarios);
  assert.equal(report.progress.total_scenarios, report.scenarios.length);
});

test('schema_version is the pinned constant 1', () => {
  const report = buildReport([doneScenario('a', winningArms())]);
  assert.equal(report.schema_version, 1);
});
