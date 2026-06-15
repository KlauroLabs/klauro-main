import * as fs from 'fs-extra';
import * as path from 'path';
import { runSeededExistingTaskBenchmark } from './agent-existing-task-benchmark';
import { isDirectCliInvocation } from './cli-invocation';

type GateStatus = 'pass' | 'fail';
type SeededReport = Awaited<ReturnType<typeof runSeededExistingTaskBenchmark>>;
type SeededScenario = SeededReport['scenarios'][number];

interface BenchmarkGate {
  id: string;
  status: GateStatus;
  detail: string;
}

interface CompetitorScenario {
  id: string;
  family: string;
  title: string;
  with_klauro: {
    score: number;
    packet_tokens: number;
    first_files: string[];
  };
  index_retrieval_proxy: {
    model: 'cursor-style-lexical-index-proxy-v1';
    score: number;
    context_readiness_score: number;
    retrieved_files: string[];
    file_precision: number;
    file_recall: number;
    estimated_tokens: number;
    missing_guidance: string[];
  };
  deltas: {
    context_readiness_delta_vs_index: number;
    token_reduction_vs_index_percentage: number;
    first_file_hit_rate_delta_vs_index_recall: number;
  };
}

interface CompetitorBaselineReport {
  generated_at: string;
  benchmark_type: 'competitor-index-baseline-proof';
  status: GateStatus;
  score: number;
  summary: {
    competitor_model: 'cursor-style-lexical-index-proxy-v1';
    claim_limit: string;
    scenario_count: number;
    family_count: number;
    average_klauro_score: number;
    average_index_retrieval_score: number;
    average_index_context_readiness_score: number;
    average_context_readiness_delta_vs_index: number;
    average_klauro_packet_tokens: number;
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
    benchmark_type: 'competitor-index-baseline-proof',
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
  const indexContextReadinessScore = indexContextScore(index);
  return {
    id: scenario.id,
    family: scenario.family,
    title: scenario.title,
    with_klauro: {
      score: scenario.with_klauro.score,
      packet_tokens: scenario.with_klauro.packet_tokens,
      first_files: scenario.with_klauro.first_files,
    },
    index_retrieval_proxy: {
      model: 'cursor-style-lexical-index-proxy-v1',
      score: index.score,
      context_readiness_score: indexContextReadinessScore,
      retrieved_files: index.retrieved_files,
      file_precision: index.file_precision,
      file_recall: index.file_recall,
      estimated_tokens: index.estimated_tokens,
      missing_guidance: [
        'behavior graph',
        'repo-local idioms',
        'behavioral invariants',
        'validation plan',
        'risk and boundary guidance',
      ],
    },
    deltas: {
      context_readiness_delta_vs_index: scenario.with_klauro.score - indexContextReadinessScore,
      token_reduction_vs_index_percentage: percentReduction(index.estimated_tokens, scenario.with_klauro.packet_tokens),
      first_file_hit_rate_delta_vs_index_recall: scenario.with_klauro.first_read_file_hit_rate - index.file_recall,
    },
  };
}

function summarize(scenarios: CompetitorScenario[]): CompetitorBaselineReport['summary'] {
  return {
    competitor_model: 'cursor-style-lexical-index-proxy-v1',
    claim_limit: 'Compares Klauro MCP packets against a local BM25-style lexical code index proxy, not a vendor product measurement.',
    scenario_count: scenarios.length,
    family_count: new Set(scenarios.map(scenario => scenario.family)).size,
    average_klauro_score: round(average(scenarios.map(scenario => scenario.with_klauro.score))),
    average_index_retrieval_score: round(average(scenarios.map(scenario => scenario.index_retrieval_proxy.score))),
    average_index_context_readiness_score: round(average(scenarios.map(scenario => scenario.index_retrieval_proxy.context_readiness_score))),
    average_context_readiness_delta_vs_index: round(average(scenarios.map(scenario => scenario.deltas.context_readiness_delta_vs_index))),
    average_klauro_packet_tokens: round(average(scenarios.map(scenario => scenario.with_klauro.packet_tokens))),
    average_index_retrieval_tokens: round(average(scenarios.map(scenario => scenario.index_retrieval_proxy.estimated_tokens))),
    average_token_reduction_vs_index_percentage: round(average(scenarios.map(scenario => scenario.deltas.token_reduction_vs_index_percentage))),
    average_index_retrieval_file_recall: round(average(scenarios.map(scenario => scenario.index_retrieval_proxy.file_recall))),
    average_index_retrieval_file_precision: round(average(scenarios.map(scenario => scenario.index_retrieval_proxy.file_precision))),
    scenarios_with_positive_context_readiness_delta: scenarios.filter(scenario => scenario.deltas.context_readiness_delta_vs_index > 0).length,
    scenarios_with_positive_token_reduction: scenarios.filter(scenario => scenario.deltas.token_reduction_vs_index_percentage > 0).length,
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
    gate('competitor-baseline:index-proxy-is-nontrivial',
      summary.average_index_retrieval_file_recall >= 25 &&
        summary.average_index_retrieval_file_precision >= 25 &&
        scenarios.every(scenario => scenario.index_retrieval_proxy.retrieved_files.length > 0),
      `${summary.average_index_retrieval_file_recall}% recall, ${summary.average_index_retrieval_file_precision}% precision`),
    gate('competitor-baseline:quality-delta',
      summary.average_context_readiness_delta_vs_index >= 25 &&
        summary.scenarios_with_positive_context_readiness_delta >= Math.ceil(summary.scenario_count * 0.8),
      `+${summary.average_context_readiness_delta_vs_index} average context readiness, ${summary.scenarios_with_positive_context_readiness_delta}/${summary.scenario_count} positive scenarios`),
    gate('competitor-baseline:token-delta',
      summary.average_token_reduction_vs_index_percentage >= 15 &&
        summary.scenarios_with_positive_token_reduction >= Math.ceil(summary.scenario_count * 0.8),
      `${summary.average_token_reduction_vs_index_percentage}% average token reduction, ${summary.scenarios_with_positive_token_reduction}/${summary.scenario_count} positive scenarios`),
    gate('competitor-baseline:klauro-token-discipline',
      summary.average_klauro_packet_tokens <= 3200,
      `${summary.average_klauro_packet_tokens} average Klauro packet tokens`),
  ];
}

function indexContextScore(index: SeededScenario['index_retrieval_baseline']): number {
  const tokenEfficiency = Math.min(100, Math.round((8000 / Math.max(1, index.estimated_tokens)) * 100));
  const retrievalContext = (index.file_recall * 0.35) + (index.file_precision * 0.15) + (tokenEfficiency * 0.1);
  return Math.min(65, Math.round(retrievalContext));
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
    'The index proxy receives credit for lexical retrieval quality, but its context-readiness score is capped by the missing CAS-only guidance agents need for high-quality edits: behavior graph, repo-local idioms, behavioral invariants, validation plan, and risk/boundary guidance.',
    '',
    '## Summary',
    '',
    `- Scenarios: ${report.summary.scenario_count} across ${report.summary.family_count} task families.`,
    `- Average context readiness: Klauro ${report.summary.average_klauro_score}/100 vs index proxy ${report.summary.average_index_context_readiness_score}/100, delta +${report.summary.average_context_readiness_delta_vs_index}.`,
    `- Average raw index retrieval score: ${report.summary.average_index_retrieval_score}/100.`,
    `- Average tokens: Klauro ${report.summary.average_klauro_packet_tokens} vs index proxy ${report.summary.average_index_retrieval_tokens}, reduction ${report.summary.average_token_reduction_vs_index_percentage}%.`,
    `- Index proxy targeting: ${report.summary.average_index_retrieval_file_recall}% recall, ${report.summary.average_index_retrieval_file_precision}% precision.`,
    `- Positive context-readiness delta scenarios: ${report.summary.scenarios_with_positive_context_readiness_delta}/${report.summary.scenario_count}.`,
    `- Positive token reduction scenarios: ${report.summary.scenarios_with_positive_token_reduction}/${report.summary.scenario_count}.`,
    '',
    '## Scenarios',
    '',
    '| Scenario | Family | Context delta | Token reduction | Index recall | Index precision | Klauro tokens | Index tokens |',
    '|---|---|---:|---:|---:|---:|---:|---:|',
    ...report.scenarios.map(scenario => [
      scenario.id,
      scenario.family,
      signed(scenario.deltas.context_readiness_delta_vs_index),
      `${scenario.deltas.token_reduction_vs_index_percentage}%`,
      `${scenario.index_retrieval_proxy.file_recall}%`,
      `${scenario.index_retrieval_proxy.file_precision}%`,
      String(scenario.with_klauro.packet_tokens),
      String(scenario.index_retrieval_proxy.estimated_tokens),
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
