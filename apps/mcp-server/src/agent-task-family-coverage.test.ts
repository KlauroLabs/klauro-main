import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { buildAgentTaskFamilyCoverage, formatTaskFamilyCoverageMarkdown } from './agent-task-family-coverage';

test('task family coverage separates proven creation from unproven engineering task gaps', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-task-family-coverage-'));
  await writeReport(root, '.klauro-agent-benchmark/latest-report.json', {
    status: 'pass',
    summary: {
      task_count: 48,
      with_klauro_success_rate: 1,
      average_token_reduction_vs_search: 88,
    },
    targets: [{
      tasks: [
        { task: { task_type: 'orient' } },
        { task: { task_type: 'debug' } },
        { task: { task_type: 'modify' } },
        { task: { task_type: 'trace' } },
      ],
    }],
  });
  await writeReport(root, '.klauro-agent-quality-benchmark/latest-report.json', {
    status: 'pass',
    summary: {},
    trials: [
      ...Array.from({ length: 6 }, () => ({ task: { task_type: 'debug' } })),
      ...Array.from({ length: 12 }, () => ({ task: { task_type: 'modify' } })),
    ],
  });
  await writeReport(root, '.klauro-agent-idiom-benchmark/latest-report.json', {
    status: 'pass',
    summary: { average_idiom_conformance_delta: 38 },
    trials: [
      ...Array.from({ length: 3 }, () => ({ task: { instructions: 'auth-tenant-scope' } })),
    ],
  });
  await writeReport(root, '.klauro-from-zero-build-context-proof/latest-report.json', {
    status: 'pass',
    summary: {
      scenario_count: 3,
      growth_iteration_count: 15,
      quality_delta: 96,
      duplicate_class_delta: 18,
      with_klauro_duplicate_classes: 0,
      without_klauro_duplicate_classes: 18,
    },
  });
  await writeReport(root, '.klauro-agent-proof-machine/latest-report.json', {
    status: 'pass',
    discovery: { eligible_repos: 102 },
  });
  await writeReport(root, '.klauro-existing-task-benchmark/latest-report.json', {
    status: 'pass',
    score: 90,
    scenarios: [
      seeded('tenant-leak-diagnosis', 'bug-diagnosis-root-cause'),
      seeded('task-title-validation-fix', 'bug-fix-live-edits'),
      seeded('controller-repository-refactor', 'architectural-change-refactor'),
      seeded('n-plus-one-task-summary', 'performance-fixes'),
      seeded('producer-consumer-contract-change', 'cross-repo-contract-changes'),
    ],
  });
  for (const [relative, id] of [
    ['.klauro-agent-scratch-build-benchmark/live-work-intake-multi-wave-strict-rescored-codex.json', 'work-intake-backend'],
    ['.klauro-agent-scratch-build-benchmark/live-operations-ui-multi-wave-strict-codex.json', 'operations-command-center-ui'],
    ['.klauro-agent-scratch-build-benchmark/live-compliance-evidence-multi-wave-growth-control-codex.json', 'compliance-evidence-backend'],
  ] as const) {
    await writeReport(root, relative, scratchReport(id));
  }
  await writeReport(root, '.klauro-agent-scratch-build-benchmark/live-compliance-continuation-read-budget-codex.json', {
    status: 'pass',
    score: 75,
    continuation_pair: {
      with_klauro: { validation_passed: true },
      without_klauro: { validation_passed: true },
    },
    with_klauro: { tests: 2 },
    without_klauro: { tests: 3 },
  });
  await writeReport(root, '.klauro-existing-task-benchmark/live-product-enhancement-report.json', liveExisting('task-label-product-enhancement', 'real-product-enhancements', 93, 83, 'pass'));
  await writeReport(root, '.klauro-existing-task-benchmark/live-auth-tenant-report.json', liveExisting('workspace-role-policy-hardening', 'auth-tenant-boundary-changes', 99, 82, 'pass'));
  await writeReport(root, '.klauro-existing-task-benchmark/live-test-coverage-report.json', liveExisting('missing-coverage-task-archive', 'test-addition-coverage', 99, 74, 'pass'));
  await writeReport(root, '.klauro-existing-task-benchmark/live-refactor-report.json', liveExisting('controller-repository-refactor', 'architectural-change-refactor', 96, 88, 'pass', -20));
  await writeReport(root, '.klauro-existing-task-benchmark/live-contract-report.json', liveExisting('producer-consumer-contract-change', 'cross-repo-contract-changes', 85, 85, 'warn'));

  const report = await buildAgentTaskFamilyCoverage(root);
  const byId = new Map(report.families.map(family => [family.id, family]));

  assert.equal(byId.get('greenfield-real-system-creation')?.status, 'strong');
  assert.equal(byId.get('existing-project-orientation-targeting')?.status, 'strong');
  assert.equal(byId.get('bug-diagnosis-root-cause')?.status, 'partial');
  assert.equal(byId.get('real-product-enhancements')?.status, 'strong');
  assert.equal(byId.get('auth-tenant-boundary-changes')?.status, 'strong');
  assert.equal(byId.get('test-addition-coverage')?.status, 'strong');
  assert.equal(byId.get('architectural-change-refactor')?.status, 'partial');
  assert.match(byId.get('architectural-change-refactor')?.missing.join('\n') || '', /used more tokens/);
  assert.equal(byId.get('performance-fixes')?.status, 'partial');
  assert.equal(byId.get('cross-repo-contract-changes')?.status, 'partial');
  assert.equal(report.status, 'warn');

  const markdown = formatTaskFamilyCoverageMarkdown(report);
  assert.match(markdown, /Real From-Scratch System Creation/);
  assert.match(markdown, /Bug Diagnosis And Root Cause/);
  assert.match(markdown, /Performance Fixes/);
});

test('greenfield creation is not strong when live builds save tokens but do not improve quality', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-task-family-coverage-flat-quality-'));
  await writeReport(root, '.klauro-from-zero-build-context-proof/latest-report.json', {
    status: 'pass',
    summary: {
      scenario_count: 3,
      growth_iteration_count: 15,
      quality_delta: 96,
      duplicate_class_delta: 18,
      with_klauro_duplicate_classes: 0,
      without_klauro_duplicate_classes: 18,
    },
  });
  for (const [relative, id] of [
    ['.klauro-agent-scratch-build-benchmark/live-work-intake-multi-wave-strict-rescored-codex.json', 'work-intake-backend'],
    ['.klauro-agent-scratch-build-benchmark/live-operations-ui-multi-wave-strict-codex.json', 'operations-command-center-ui'],
    ['.klauro-agent-scratch-build-benchmark/live-compliance-evidence-multi-wave-growth-control-codex.json', 'compliance-evidence-backend'],
  ] as const) {
    await writeReport(root, relative, scratchReport(id, 0));
  }

  const report = await buildAgentTaskFamilyCoverage(root);
  const family = report.families.find(item => item.id === 'greenfield-real-system-creation');

  assert.equal(family?.status, 'partial');
  assert.match(family?.missing.join('\n') || '', /positive initial quality deltas/);
});

test('greenfield creation is not strong while unacceptable token tradeoff reports are still included as evidence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-task-family-coverage-tradeoff-'));
  await writeReport(root, '.klauro-from-zero-build-context-proof/latest-report.json', {
    status: 'pass',
    summary: {
      scenario_count: 3,
      growth_iteration_count: 15,
      quality_delta: 96,
      duplicate_class_delta: 18,
      with_klauro_duplicate_classes: 0,
      without_klauro_duplicate_classes: 18,
    },
  });
  for (const [relative, id] of [
    ['.klauro-agent-scratch-build-benchmark/live-work-intake-multi-wave-strict-rescored-codex.json', 'work-intake-backend'],
    ['.klauro-agent-scratch-build-benchmark/live-operations-ui-multi-wave-strict-codex.json', 'operations-command-center-ui'],
    ['.klauro-agent-scratch-build-benchmark/live-compliance-evidence-multi-wave-growth-control-codex.json', 'compliance-evidence-backend'],
  ] as const) {
    await writeReport(root, relative, scratchReport(id, 6));
  }
  await writeReport(root, '.klauro-agent-scratch-build-benchmark/live-compliance-evidence-goal-codex-rescored.json', {
    status: 'warn',
    score: 86,
    task: { id: 'compliance-evidence' },
    comparison: {
      token_reduction_percentage: -29,
      live_quality_delta: 8,
      quality_delta: 0,
      quality_token_tradeoff_status: 'quality-win-token-regression-too-large',
    },
  });

  const report = await buildAgentTaskFamilyCoverage(root);
  const family = report.families.find(item => item.id === 'greenfield-real-system-creation');

  assert.equal(family?.status, 'partial');
  assert.match(family?.missing.join('\n') || '', /unacceptable quality\/token tradeoff/);
  assert.equal(report.status, 'warn');
});

test('greenfield creation treats older unacceptable tradeoffs as superseded when a newer same-task clear win exists', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-task-family-coverage-superseded-tradeoff-'));
  await writeReport(root, '.klauro-from-zero-build-context-proof/latest-report.json', {
    status: 'pass',
    summary: {
      scenario_count: 3,
      growth_iteration_count: 15,
      quality_delta: 96,
      duplicate_class_delta: 18,
      with_klauro_duplicate_classes: 0,
      without_klauro_duplicate_classes: 18,
    },
  });
  for (const [relative, id] of [
    ['.klauro-agent-scratch-build-benchmark/live-work-intake-multi-wave-strict-rescored-codex.json', 'work-intake-backend'],
    ['.klauro-agent-scratch-build-benchmark/live-operations-ui-multi-wave-strict-codex.json', 'operations-command-center-ui'],
    ['.klauro-agent-scratch-build-benchmark/live-compliance-evidence-multi-wave-growth-control-codex.json', 'compliance-evidence-backend'],
  ] as const) {
    await writeReport(root, relative, {
      ...(scratchReport(id, 6) as Record<string, unknown>),
      generated_at: '2026-06-10T00:36:58.980Z',
    });
  }
  await writeReport(root, '.klauro-agent-scratch-build-benchmark/live-compliance-evidence-goal-codex-rescored.json', {
    status: 'warn',
    score: 86,
    generated_at: '2026-06-09T23:50:45.351Z',
    task: { id: 'compliance-evidence-backend' },
    comparison: {
      token_reduction_percentage: -29,
      live_quality_delta: 8,
      quality_delta: 0,
      quality_token_tradeoff_status: 'quality-win-token-regression-too-large',
    },
  });

  const report = await buildAgentTaskFamilyCoverage(root);
  const family = report.families.find(item => item.id === 'greenfield-real-system-creation');

  assert.equal(family?.status, 'strong');
  assert.doesNotMatch(family?.missing.join('\n') || '', /unacceptable quality\/token tradeoff/);
  assert.match(family?.evidence.map(item => item.summary).join('\n') || '', /superseded quality-win-token-regression-too-large/);
});

async function writeReport(root: string, relative: string, data: unknown): Promise<void> {
  const absolute = path.join(root, relative);
  await fs.ensureDir(path.dirname(absolute));
  await fs.writeJson(absolute, data, { spaces: 2 });
}

function seeded(id: string, family: string): unknown {
  return {
    id,
    family,
    status: 'pass',
    score: 90,
    deltas: { score_delta: 25 },
  };
}

function scratchReport(id: string, qualityDelta = 4): unknown {
  return {
    status: 'pass',
    score: 94,
    task: { id, title: `Build ${id}` },
    with_klauro: { score: 100 },
    without_klauro: { score: 92 },
    comparison: {
      quality_delta: qualityDelta,
      token_reduction_percentage: 40,
    },
    continuation_waves: [
      {
        task_id: `${id}-wave-1`,
        title: 'Continue without rebuilding concepts',
        with_klauro: { score: 100 },
        live_quality_delta: 5,
        changed_file_precision_delta: 60,
        token_reduction_percentage: 25,
      },
      {
        task_id: `${id}-wave-2`,
        title: 'Add scale behavior without forking ownership',
        with_klauro: { score: 100 },
        live_quality_delta: 5,
        changed_file_precision_delta: 60,
        token_reduction_percentage: 25,
      },
    ],
  };
}

function liveExisting(id: string, family: string, withScore: number, withoutScore: number, status: string, tokenReduction = 40): unknown {
  return {
    status: 'pass',
    score: 98,
    scenarios: [{
      id,
      family,
      live_summary: {
        status,
        with_score: withScore,
        without_score: withoutScore,
        quality_delta: withScore - withoutScore,
        token_reduction_percentage: tokenReduction,
        time_reduction_percentage: 20,
      },
    }],
  };
}
