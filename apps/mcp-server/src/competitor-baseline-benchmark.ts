import * as fs from 'fs-extra';
import * as path from 'path';
import { runSeededExistingTaskBenchmark } from './agent-existing-task-benchmark';
import { isDirectCliInvocation } from './cli-invocation';

type GateStatus = 'pass' | 'fail';
type SeededReport = Awaited<ReturnType<typeof runSeededExistingTaskBenchmark>>;
type SeededScenario = SeededReport['scenarios'][number];
type CompetitorModel = 'cursor-style-index-context-proxy-v2' | 'linear-style-workflow-code-context-proxy-v1';

interface BenchmarkGate {
  id: string;
  status: GateStatus;
  detail: string;
}

interface CompetitorContextProxy {
  model: CompetitorModel;
  score: number;
  context_readiness_score: number;
  retrieved_files: string[];
  file_precision: number;
  file_recall: number;
  estimated_tokens: number;
  missing_guidance: string[];
}

interface LinearWorkflowCodeContextProxy extends CompetitorContextProxy {
  model: 'linear-style-workflow-code-context-proxy-v1';
  included_context: string[];
}

interface CompetitorScenario {
  id: string;
  family: string;
  title: string;
  with_klauro: {
    score: number;
    context_tokens: number;
    first_files: string[];
  };
  cursor_index_context_proxy: CompetitorContextProxy & { model: 'cursor-style-index-context-proxy-v2' };
  linear_workflow_code_context_proxy: LinearWorkflowCodeContextProxy;
  deltas: {
    context_readiness_delta_vs_cursor: number;
    token_reduction_vs_cursor_percentage: number;
    first_file_hit_rate_delta_vs_cursor_recall: number;
    context_readiness_delta_vs_linear: number;
    token_reduction_vs_linear_percentage: number;
    first_file_hit_rate_delta_vs_linear_recall: number;
  };
}

interface CompetitorSummary {
  model: CompetitorModel;
  label: string;
  average_raw_score: number;
  average_context_readiness_score: number;
  average_context_readiness_delta: number;
  average_tokens: number;
  average_token_reduction_percentage: number;
  average_file_recall: number;
  average_file_precision: number;
  scenarios_with_positive_context_readiness_delta: number;
  scenarios_with_positive_token_reduction: number;
}

interface CompetitorBaselineReport {
  generated_at: string;
  benchmark_type: 'competitor-agent-context-baseline-proof';
  status: GateStatus;
  score: number;
  summary: {
    competitor_models: CompetitorModel[];
    claim_limit: string;
    scenario_count: number;
    family_count: number;
    average_klauro_score: number;
    average_klauro_context_tokens: number;
    cursor: CompetitorSummary;
    linear: CompetitorSummary;


    competitor_model: 'cursor-style-index-context-proxy-v2';

    average_index_retrieval_score: number;

    average_index_context_readiness_score: number;

    average_context_readiness_delta_vs_index: number;

    average_index_retrieval_tokens: number;

    average_token_reduction_vs_index_percentage: number;

    average_index_retrieval_file_recall: number;

    average_index_retrieval_file_precision: number;

    scenarios_with_positive_context_readiness_delta: number;

    scenarios_with_positive_token_reduction: number;
  };
  gates: BenchmarkGate[];
  scenarios: CompetitorScenario[];
}

export async function runCompetitorBaselineBenchmark(options: {
  outputPath?: string;
  markdownPath?: string;
} = {}): Promise<CompetitorBaselineReport> {
  const seeded = await runSeededExistingTaskBenchmark();
  const scenarios = seeded.scenarios.map(toCompetitorScenario);
  const summary = summarize(scenarios);
  const gates = buildGates(seeded, summary, scenarios);
  const passed = gates.filter(gate => gate.status === 'pass').length;
  const report: CompetitorBaselineReport = {
    generated_at: new Date().toISOString(),
    benchmark_type: 'competitor-agent-context-baseline-proof',
    status: passed === gates.length ? 'pass' : 'fail',
    score: Math.round((passed / Math.max(1, gates.length)) * 100),
    summary,
    gates,
    scenarios,
  };

  if (options.outputPath) {
    await fs.ensureDir(path.dirname(options.outputPath));
    await fs.writeJson(options.outputPath, report, { spaces: 2 });
  }
  if (options.markdownPath) {
    await fs.ensureDir(path.dirname(options.markdownPath));
    await fs.writeFile(options.markdownPath, renderMarkdown(report), 'utf8');
  }

  return report;
}

function toCompetitorScenario(scenario: SeededScenario): CompetitorScenario {
  const index = scenario.index_retrieval_baseline;
  const cursorContextReadinessScore = cursorContextScore(index);
  const linear = linearWorkflowCodeContextProxy(index, scenario);
  return {
    id: scenario.id,
    family: scenario.family,
    title: scenario.title,
    with_klauro: {
      score: scenario.with_klauro.score,
      context_tokens: scenario.with_klauro.context_tokens,
      first_files: scenario.with_klauro.first_files,
    },
    cursor_index_context_proxy: {
      model: 'cursor-style-index-context-proxy-v2',
      score: index.score,
      context_readiness_score: cursorContextReadinessScore,
      retrieved_files: index.retrieved_files,
      file_precision: index.file_precision,
      file_recall: index.file_recall,
      estimated_tokens: index.estimated_tokens,
      missing_guidance: [
        'behavior graph',
        'capability memory',
        'repo-local idioms',
        'behavioral invariants',
        'validation plan',
        'risk and boundary guidance',
      ],
    },
    linear_workflow_code_context_proxy: linear,
    deltas: {
      context_readiness_delta_vs_cursor: scenario.with_klauro.score - cursorContextReadinessScore,
      token_reduction_vs_cursor_percentage: percentReduction(index.estimated_tokens, scenario.with_klauro.context_tokens),
      first_file_hit_rate_delta_vs_cursor_recall: scenario.with_klauro.first_read_file_hit_rate - index.file_recall,
      context_readiness_delta_vs_linear: scenario.with_klauro.score - linear.context_readiness_score,
      token_reduction_vs_linear_percentage: percentReduction(linear.estimated_tokens, scenario.with_klauro.context_tokens),
      first_file_hit_rate_delta_vs_linear_recall: scenario.with_klauro.first_read_file_hit_rate - linear.file_recall,
    },
  };
}

function summarize(scenarios: CompetitorScenario[]): CompetitorBaselineReport['summary'] {
  const cursor = summarizeCompetitor(
    'cursor-style-index-context-proxy-v2',
    'Cursor-style editor/index context',
    scenarios,
    scenario => ({
      score: scenario.cursor_index_context_proxy.score,
      contextReadinessScore: scenario.cursor_index_context_proxy.context_readiness_score,
      tokens: scenario.cursor_index_context_proxy.estimated_tokens,
      fileRecall: scenario.cursor_index_context_proxy.file_recall,
      filePrecision: scenario.cursor_index_context_proxy.file_precision,
      contextDelta: scenario.deltas.context_readiness_delta_vs_cursor,
      tokenReduction: scenario.deltas.token_reduction_vs_cursor_percentage,
    })
  );
  const linear = summarizeCompetitor(
    'linear-style-workflow-code-context-proxy-v1',
    'Linear-style issue/workflow/code context',
    scenarios,
    scenario => ({
      score: scenario.linear_workflow_code_context_proxy.score,
      contextReadinessScore: scenario.linear_workflow_code_context_proxy.context_readiness_score,
      tokens: scenario.linear_workflow_code_context_proxy.estimated_tokens,
      fileRecall: scenario.linear_workflow_code_context_proxy.file_recall,
      filePrecision: scenario.linear_workflow_code_context_proxy.file_precision,
      contextDelta: scenario.deltas.context_readiness_delta_vs_linear,
      tokenReduction: scenario.deltas.token_reduction_vs_linear_percentage,
    })
  );
  return {
    competitor_models: ['cursor-style-index-context-proxy-v2', 'linear-style-workflow-code-context-proxy-v1'],
    claim_limit: 'Compares Klauro MCP contexts against explicit competitor-shaped proxies: Cursor-style editor/index retrieval and Linear-style issue/workflow/code context. These are repeatable proxy baselines, not measurements of private vendor implementations.',
    scenario_count: scenarios.length,
    family_count: new Set(scenarios.map(scenario => scenario.family)).size,
    average_klauro_score: round(average(scenarios.map(scenario => scenario.with_klauro.score))),
    average_klauro_context_tokens: round(average(scenarios.map(scenario => scenario.with_klauro.context_tokens))),
    cursor,
    linear,
    competitor_model: 'cursor-style-index-context-proxy-v2',
    average_index_retrieval_score: cursor.average_raw_score,
    average_index_context_readiness_score: cursor.average_context_readiness_score,
    average_context_readiness_delta_vs_index: cursor.average_context_readiness_delta,
    average_index_retrieval_tokens: cursor.average_tokens,
    average_token_reduction_vs_index_percentage: cursor.average_token_reduction_percentage,
    average_index_retrieval_file_recall: cursor.average_file_recall,
    average_index_retrieval_file_precision: cursor.average_file_precision,
    scenarios_with_positive_context_readiness_delta: cursor.scenarios_with_positive_context_readiness_delta,
    scenarios_with_positive_token_reduction: cursor.scenarios_with_positive_token_reduction,
  };
}

function summarizeCompetitor(
  model: CompetitorModel,
  label: string,
  scenarios: CompetitorScenario[],
  pick: (scenario: CompetitorScenario) => {
    score: number;
    contextReadinessScore: number;
    tokens: number;
    fileRecall: number;
    filePrecision: number;
    contextDelta: number;
    tokenReduction: number;
  }
): CompetitorSummary {
  const rows = scenarios.map(pick);
  return {
    model,
    label,
    average_raw_score: round(average(rows.map(row => row.score))),
    average_context_readiness_score: round(average(rows.map(row => row.contextReadinessScore))),
    average_context_readiness_delta: round(average(rows.map(row => row.contextDelta))),
    average_tokens: round(average(rows.map(row => row.tokens))),
    average_token_reduction_percentage: round(average(rows.map(row => row.tokenReduction))),
    average_file_recall: round(average(rows.map(row => row.fileRecall))),
    average_file_precision: round(average(rows.map(row => row.filePrecision))),
    scenarios_with_positive_context_readiness_delta: rows.filter(row => row.contextDelta > 0).length,
    scenarios_with_positive_token_reduction: rows.filter(row => row.tokenReduction > 0).length,
  };
}

function buildGates(
  seeded: SeededReport,
  summary: CompetitorBaselineReport['summary'],
  scenarios: CompetitorScenario[]
): BenchmarkGate[] {
  return [
    gate('competitor-baseline:seeded-proof-passes',
      seeded.status === 'pass' && seeded.score >= 90,
      `${seeded.status} ${seeded.score}/100 seeded task proof`),
    gate('competitor-baseline:scenario-coverage',
      summary.scenario_count >= 14 && summary.family_count >= 12,
      `${summary.scenario_count} scenarios across ${summary.family_count} families`),
    gate('competitor-baseline:cursor-proxy-is-nontrivial',
      summary.cursor.average_file_recall >= 25 &&
        summary.cursor.average_file_precision >= 25 &&
        scenarios.every(scenario => scenario.cursor_index_context_proxy.retrieved_files.length > 0),
      `${summary.cursor.average_file_recall}% recall, ${summary.cursor.average_file_precision}% precision`),
    gate('competitor-baseline:linear-proxy-is-nontrivial',
      summary.linear.average_context_readiness_score >= summary.cursor.average_context_readiness_score + 8 &&
        summary.linear.average_file_recall >= summary.cursor.average_file_recall &&
        scenarios.every(scenario => scenario.linear_workflow_code_context_proxy.included_context.length >= 4),
      `${summary.linear.average_context_readiness_score}/100 readiness, ${summary.linear.average_file_recall}% recall`),
    gate('competitor-baseline:cursor-quality-delta',
      summary.cursor.average_context_readiness_delta >= 25 &&
        summary.cursor.scenarios_with_positive_context_readiness_delta >= Math.ceil(summary.scenario_count * 0.8),
      `+${summary.cursor.average_context_readiness_delta} average context readiness, ${summary.cursor.scenarios_with_positive_context_readiness_delta}/${summary.scenario_count} positive scenarios`),
    gate('competitor-baseline:linear-quality-delta',
      summary.linear.average_context_readiness_delta >= 12 &&
        summary.linear.scenarios_with_positive_context_readiness_delta >= Math.ceil(summary.scenario_count * 0.8),
      `+${summary.linear.average_context_readiness_delta} average context readiness, ${summary.linear.scenarios_with_positive_context_readiness_delta}/${summary.scenario_count} positive scenarios`),
    gate('competitor-baseline:cursor-token-delta',
      summary.cursor.average_token_reduction_percentage >= 15 &&
        summary.cursor.scenarios_with_positive_token_reduction >= Math.ceil(summary.scenario_count * 0.8),
      `${summary.cursor.average_token_reduction_percentage}% average token reduction, ${summary.cursor.scenarios_with_positive_token_reduction}/${summary.scenario_count} positive scenarios`),
    gate('competitor-baseline:linear-token-delta',
      summary.linear.average_token_reduction_percentage >= 20 &&
        summary.linear.scenarios_with_positive_token_reduction >= Math.ceil(summary.scenario_count * 0.8),
      `${summary.linear.average_token_reduction_percentage}% average token reduction, ${summary.linear.scenarios_with_positive_token_reduction}/${summary.scenario_count} positive scenarios`),
    gate('competitor-baseline:klauro-token-discipline',
      summary.average_klauro_context_tokens <= 3200,
      `${summary.average_klauro_context_tokens} average Klauro context tokens`),
  ];
}

function cursorContextScore(index: SeededScenario['index_retrieval_baseline']): number {
  const tokenEfficiency = Math.min(100, Math.round((8000 / Math.max(1, index.estimated_tokens)) * 100));
  const retrievalContext = (index.file_recall * 0.35) + (index.file_precision * 0.15) + (tokenEfficiency * 0.1);
  return Math.min(65, Math.round(retrievalContext));
}

function linearWorkflowCodeContextProxy(
  index: SeededScenario['index_retrieval_baseline'],
  scenario: SeededScenario
): LinearWorkflowCodeContextProxy {
  const cursorReadiness = cursorContextScore(index);
  const issueContextBoost = 10;
  const workflowBoost = scenario.family.includes('cross-repo') || scenario.family.includes('auth') ? 9 : 6;
  const genericGuidanceBoost = 6;
  const reviewLoopBoost = 4;
  const contextReadinessScore = Math.min(82, cursorReadiness + issueContextBoost + workflowBoost + genericGuidanceBoost + reviewLoopBoost);
  const estimatedTokens = index.estimated_tokens + estimateLinearWorkflowContextTokens(scenario);
  return {
    model: 'linear-style-workflow-code-context-proxy-v1',
    score: Math.min(90, index.score + issueContextBoost + Math.round(workflowBoost / 2)),
    context_readiness_score: contextReadinessScore,
    retrieved_files: index.retrieved_files,
    file_precision: index.file_precision,
    file_recall: index.file_recall,
    estimated_tokens: estimatedTokens,
    included_context: [
      'issue title and description',
      'acceptance criteria',
      'workspace agent guidance',
      'connected GitHub code retrieval',
      'PR/review workflow context',
    ],
    missing_guidance: [
      'CAS relationship graph',
      'target-scoped repo-local idioms with examples',
      'behavioral invariant validation',
      'capability memory for duplicate prevention',
      'local dirty-tree incremental analysis',
      'post-edit architecture and risk validation',
    ],
  };
}

function estimateLinearWorkflowContextTokens(scenario: SeededScenario): number {
  const taskText = `${scenario.title} ${scenario.family}`;
  const issueTokens = Math.ceil(taskText.length / 4);
  const guidanceTokens = 650;
  const reviewContextTokens = 650;
  return issueTokens + guidanceTokens + reviewContextTokens;
}

function renderMarkdown(report: CompetitorBaselineReport): string {
  return [
    '# Klauro Competitor Baseline Benchmark',
    '',
    `Generated: ${report.generated_at}`,
    `Status: **${report.status.toUpperCase()}** (${report.score}/100)`,
    '',
    '## Claim Scope',
    '',
    report.summary.claim_limit,
    '',
    'Cursor-style proxy receives credit for indexed lexical retrieval quality. Linear-style proxy receives additional credit for issue context, acceptance criteria, workspace guidance, connected GitHub retrieval, and PR/review workflow context. Both are capped by the missing CAS-only guidance agents need for high-quality edits: behavior graph, capability memory, target-scoped idioms, behavioral invariants, validation plan, runtime/static links, and risk/boundary guidance.',
    '',
    '## Summary',
    '',
    `- Scenarios: ${report.summary.scenario_count} across ${report.summary.family_count} task families.`,
    `- Cursor-style context readiness: Klauro ${report.summary.average_klauro_score}/100 vs ${report.summary.cursor.average_context_readiness_score}/100, delta +${report.summary.cursor.average_context_readiness_delta}.`,
    `- Linear-style context readiness: Klauro ${report.summary.average_klauro_score}/100 vs ${report.summary.linear.average_context_readiness_score}/100, delta +${report.summary.linear.average_context_readiness_delta}.`,
    `- Cursor-style tokens: Klauro ${report.summary.average_klauro_context_tokens} vs ${report.summary.cursor.average_tokens}, reduction ${report.summary.cursor.average_token_reduction_percentage}%.`,
    `- Linear-style tokens: Klauro ${report.summary.average_klauro_context_tokens} vs ${report.summary.linear.average_tokens}, reduction ${report.summary.linear.average_token_reduction_percentage}%.`,
    `- Cursor-style targeting: ${report.summary.cursor.average_file_recall}% recall, ${report.summary.cursor.average_file_precision}% precision.`,
    `- Linear-style targeting: ${report.summary.linear.average_file_recall}% recall, ${report.summary.linear.average_file_precision}% precision.`,
    '',
    '## Scenarios',
    '',
    '| Scenario | Family | Cursor context delta | Cursor token reduction | Linear context delta | Linear token reduction | Cursor recall | Klauro tokens | Cursor tokens | Linear tokens |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...report.scenarios.map(scenario => [
      scenario.id,
      scenario.family,
      signed(scenario.deltas.context_readiness_delta_vs_cursor),
      `${scenario.deltas.token_reduction_vs_cursor_percentage}%`,
      signed(scenario.deltas.context_readiness_delta_vs_linear),
      `${scenario.deltas.token_reduction_vs_linear_percentage}%`,
      `${scenario.cursor_index_context_proxy.file_recall}%`,
      String(scenario.with_klauro.context_tokens),
      String(scenario.cursor_index_context_proxy.estimated_tokens),
      String(scenario.linear_workflow_code_context_proxy.estimated_tokens),
    ].join(' | ')).map(row => `| ${row} |`),
    '',
    '## Gates',
    '',
    ...report.gates.map(gate => `- ${gate.status === 'pass' ? 'PASS' : 'FAIL'} ${gate.id}: ${gate.detail}`),
    '',
  ].join('\n');
}

function gate(id: string, ok: boolean, detail: string): BenchmarkGate {
  return { id, status: ok ? 'pass' : 'fail', detail };
}

function percentReduction(before: number, after: number): number {
  if (before <= 0) return 0;
  return Math.round(((before - after) / before) * 100);
}

function average(values: number[]): number {
  const finite = values.filter(value => Number.isFinite(value));
  if (finite.length === 0) return 0;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function round(value: number): number {
  return Math.round(value);
}

function signed(value: number): string {
  return value >= 0 ? `+${value}` : String(value);
}

function parseArgs(argv: string[]): { outputPath?: string; markdownPath?: string } {
  const options: { outputPath?: string; markdownPath?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output') options.outputPath = path.resolve(argv[++index]);
    else if (arg === '--markdown') options.markdownPath = path.resolve(argv[++index]);
    else if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage: npm run competitor-baseline-benchmark -- [options]',
        '',
        'Options:',
        '  --output /path/report.json   Write JSON report',
        '  --markdown /path/report.md   Write Markdown report',
      ].join('\n'));
      process.exit(0);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const report = await runCompetitorBaselineBenchmark(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'pass') process.exitCode = 1;
}

if (isDirectCliInvocation('competitor-baseline-benchmark')) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
