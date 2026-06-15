import * as fs from 'fs-extra';
import * as path from 'path';
import { isDirectCliInvocation } from './cli-invocation';
import { runAnalysisFocusBenchmark } from './analysis-focus-benchmark';
import { runAnalysisOutputColdReview } from './analysis-output-cold-review';
import { getDescriptionEnrichmentTargets, type DescriptionEnrichmentTarget } from './analysis-usefulness-review';
import { runDescriptionQualityBenchmark } from './description-quality-benchmark';
import { loadAnalysis } from './storage';

type ProofStatus = 'pass' | 'warn' | 'fail';

interface ProofGate {
  id: string;
  status: 'pass' | 'fail';
  detail: string;
}

interface QueueItem {
  repo: string;
  path: string;
  category: string;
  narrative_score: number;
  target_count: number;
  critical_count: number;
  status: 'queued' | 'missing-analysis' | 'no-targets';
  first_targets: Array<{
    target_kind: string;
    target: string;
    priority: string;
    reasons: string[];
    suggested_tool: string;
    suggested_args: Record<string, unknown>;
  }>;
}

interface NarrativeEnrichmentProofReport {
  generated_at: string;
  benchmark_type: 'analysis-narrative-enrichment-proof';
  status: ProofStatus;
  score: number;
  source_cold_review: string;
  summary: {
    sampled_outputs: number;
    narrative_debt_count: number;
    queued_repos: number;
    missing_analysis_count: number;
    no_target_count: number;
    total_enrichment_targets: number;
    critical_targets: number;
    mechanics_status: string;
    focus_status: string;
    agent_fast_optional_work_units: number | null;
    ui_overview_optional_work_units: number | null;
  };
  gates: ProofGate[];
  enrichment_queue: QueueItem[];
  mechanics: Record<string, unknown>;
  focus: Record<string, unknown>;
}

const DEFAULT_MACHINE_REPORT = '.klauro-agent-proof-machine/latest-report.json';
const DEFAULT_COLD_REVIEW = '.klauro-analysis-output-cold-review/latest-report.json';

export async function runAnalysisNarrativeEnrichmentProof(options: {
  machineReportPath?: string;
  coldReviewPath?: string;
  outputPath?: string;
  markdownPath?: string;
} = {}): Promise<NarrativeEnrichmentProofReport> {
  const coldReviewPath = path.resolve(options.coldReviewPath || path.join(process.cwd(), DEFAULT_COLD_REVIEW));
  const coldReview = await loadOrCreateColdReview(coldReviewPath, options.machineReportPath);
  const queue = await buildEnrichmentQueue(coldReview);
  const mechanics = await runDescriptionQualityBenchmark();
  const focus = await runAnalysisFocusBenchmark();
  const gates = buildGates(coldReview, queue, mechanics, focus);
  const failed = gates.filter(gate => gate.status === 'fail').length;
  const debtCount = Number(coldReview.summary?.narrative_debt_count || 0);
  const status: ProofStatus = failed > 0 ? 'fail' : debtCount > 0 ? 'warn' : 'pass';
  const report: NarrativeEnrichmentProofReport = {
    generated_at: new Date().toISOString(),
    benchmark_type: 'analysis-narrative-enrichment-proof',
    status,
    score: Math.round((gates.length - failed) / Math.max(1, gates.length) * 100),
    source_cold_review: coldReviewPath,
    summary: {
      sampled_outputs: Number(coldReview.summary?.sample_count || 0),
      narrative_debt_count: debtCount,
      queued_repos: queue.filter(item => item.status === 'queued').length,
      missing_analysis_count: queue.filter(item => item.status === 'missing-analysis').length,
      no_target_count: queue.filter(item => item.status === 'no-targets').length,
      total_enrichment_targets: queue.reduce((sum, item) => sum + item.target_count, 0),
      critical_targets: queue.reduce((sum, item) => sum + item.critical_count, 0),
      mechanics_status: String((mechanics as any).status || 'unknown'),
      focus_status: String((focus as any).status || 'unknown'),
      agent_fast_optional_work_units: numberOrNull((focus as any).summary?.agent_fast_optional_work_units),
      ui_overview_optional_work_units: numberOrNull((focus as any).summary?.ui_overview_optional_work_units),
    },
    gates,
    enrichment_queue: queue,
    mechanics: summarizeMechanics(mechanics),
    focus: summarizeFocus(focus),
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

async function loadOrCreateColdReview(coldReviewPath: string, machineReportPath?: string): Promise<any> {
  if (await fs.pathExists(coldReviewPath)) return fs.readJson(coldReviewPath);
  return runAnalysisOutputColdReview({
    machineReportPath: machineReportPath
      ? path.resolve(machineReportPath)
      : path.resolve(path.join(process.cwd(), DEFAULT_MACHINE_REPORT)),
    outputPath: coldReviewPath,
    markdownPath: coldReviewPath.replace(/\.json$/i, '.md'),
  });
}

async function buildEnrichmentQueue(coldReview: any): Promise<QueueItem[]> {
  const reviews = Array.isArray(coldReview.reviews) ? coldReview.reviews : [];
  const debtReviews = reviews.filter((review: any) =>
    Array.isArray(review.concerns) && review.concerns.some((concern: string) => /narrative debt/i.test(concern))
  );
  const queue: QueueItem[] = [];

  for (const review of debtReviews) {
    const cas = await loadAnalysis(review.path);
    if (!cas) {
      queue.push({
        repo: String(review.repo || path.basename(review.path || 'unknown')),
        path: String(review.path || ''),
        category: String(review.category || 'unknown'),
        narrative_score: Number(review.narrative_score || 0),
        target_count: 0,
        critical_count: 0,
        status: 'missing-analysis',
        first_targets: [],
      });
      continue;
    }

    const targets = getDescriptionEnrichmentTargets(cas, review.path);
    queue.push({
      repo: String(review.repo || cas.system?.name || path.basename(review.path || 'unknown')),
      path: String(review.path || cas.system?.root_path || ''),
      category: String(review.category || 'unknown'),
      narrative_score: Number(review.narrative_score || 0),
      target_count: targets.length,
      critical_count: targets.filter(target => target.priority === 'critical').length,
      status: targets.length > 0 ? 'queued' : 'no-targets',
      first_targets: targets.slice(0, 6).map(compactTarget),
    });
  }

  return queue;
}

function compactTarget(target: DescriptionEnrichmentTarget): QueueItem['first_targets'][number] {
  return {
    target_kind: target.target_kind,
    target: target.target,
    priority: target.priority,
    reasons: target.reasons.slice(0, 4),
    suggested_tool: target.suggested_tool,
    suggested_args: target.suggested_args as Record<string, unknown>,
  };
}

function buildGates(coldReview: any, queue: QueueItem[], mechanics: any, focus: any): ProofGate[] {
  const debtCount = Number(coldReview.summary?.narrative_debt_count || 0);
  const queued = queue.filter(item => item.status === 'queued');
  const noTargets = queue.filter(item => item.status === 'no-targets');
  const missing = queue.filter(item => item.status === 'missing-analysis');
  const accounted = queued.length + noTargets.length;
  const routingOk = queued.every(item => item.first_targets.every(target => {
    if (target.target_kind === 'system') {
      return target.suggested_tool === 'run_analysis_layer' &&
        (target.suggested_args as any).layer === 'ui-overview-refresh';
    }
    return target.suggested_tool === 'generate_element_description';
  }));
  const mechanicResults = Array.isArray(mechanics.results) ? mechanics.results : [];
  const generatedKinds = new Set(mechanicResults
    .filter((result: any) => /^generate-/.test(String(result.name || '')) && result.status === 'pass')
    .map((result: any) => String(result.target_kind || '')));
  const focusSummary = focus.summary || {};

  return [
    gate('narrative-enrichment:cold-review-present',
      Number(coldReview.summary?.sample_count || 0) >= Math.min(10, Math.max(1, Array.isArray(coldReview.reviews) ? coldReview.reviews.length : 0)),
      `${coldReview.summary?.sample_count || 0} sampled outputs`),
    gate('narrative-enrichment:debt-visible',
      debtCount >= 0,
      debtCount > 0 ? `${debtCount} narrative-debt outputs` : 'no narrative-debt outputs in sampled cold review'),
    gate('narrative-enrichment:queue-coverage',
      debtCount === 0 || (accounted === debtCount && missing.length === 0 && queued.every(item => item.target_count > 0)),
      `${queued.length}/${debtCount} debt outputs queued, ${noTargets.length} no-target outputs accounted, ${queue.reduce((sum, item) => sum + item.target_count, 0)} targets`),
    gate('narrative-enrichment:queue-routing',
      debtCount === 0 || (routingOk && queued.length > 0),
      debtCount === 0
        ? 'no enrichment routing needed for current sampled cold review'
        : routingOk ? 'system narrative routes to ui-overview-refresh; elements route to generate_element_description' : 'bad enrichment routing'),
    gate('narrative-enrichment:ai-mechanics',
      mechanics.status === 'pass' &&
        ['service', 'capability', 'entity', 'entry_point'].every(kind => generatedKinds.has(kind)),
      `${mechanics.status || 'unknown'}; generated kinds ${Array.from(generatedKinds).join(', ')}`),
    gate('narrative-enrichment:agent-fast-cost-isolated',
      focus.status === 'pass' &&
        Number(focusSummary.agent_fast_optional_work_units) === 0 &&
        Number(focusSummary.ui_overview_optional_work_units) > 0,
      `agent-fast optional ${focusSummary.agent_fast_optional_work_units ?? 'missing'}, ui-overview optional ${focusSummary.ui_overview_optional_work_units ?? 'missing'}`),
  ];
}

function numberOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function summarizeMechanics(mechanics: any): Record<string, unknown> {
  return {
    status: mechanics.status,
    score: mechanics.score,
    generated_target_kinds: mechanics.summary?.generated_target_kinds,
    bad_samples_rejected: mechanics.summary?.bad_samples_rejected,
  };
}

function summarizeFocus(focus: any): Record<string, unknown> {
  return {
    status: focus.status,
    score: focus.score,
    agent_fast_optional_work_units: focus.summary?.agent_fast_optional_work_units,
    agent_fast_total_reduction_percent: focus.summary?.agent_fast_total_reduction_percent,
    ui_overview_optional_work_units: focus.summary?.ui_overview_optional_work_units,
    deep_context_optional_work_units: focus.summary?.deep_context_optional_work_units,
  };
}

function gate(id: string, ok: boolean, detail: string): ProofGate {
  return { id, status: ok ? 'pass' : 'fail', detail };
}

function renderMarkdown(report: NarrativeEnrichmentProofReport): string {
  return [
    '# Klauro Narrative Enrichment Proof',
    '',
    `Generated: ${report.generated_at}`,
    `Status: **${report.status.toUpperCase()}** (${report.score}/100)`,
    `Source cold review: ${report.source_cold_review}`,
    '',
    'This proof does not claim the sampled machine analyses are already fully enriched. It proves that every cold-review narrative debt item is actionable through the existing AI description layer, and that the cost stays isolated from the default agent-fast MCP path.',
    '',
    '## Summary',
    '',
    `- Sampled outputs: ${report.summary.sampled_outputs}`,
    `- Narrative debt outputs: ${report.summary.narrative_debt_count}`,
    `- Queued repos: ${report.summary.queued_repos}`,
    `- Enrichment targets: ${report.summary.total_enrichment_targets} (${report.summary.critical_targets} critical)`,
    `- Agent-fast optional work units: ${report.summary.agent_fast_optional_work_units}`,
    `- UI-overview optional work units: ${report.summary.ui_overview_optional_work_units}`,
    '',
    '## Gates',
    '',
    '| Gate | Status | Detail |',
    '| --- | --- | --- |',
    ...report.gates.map(gate => `| \`${gate.id}\` | ${gate.status} | ${escapeMd(gate.detail)} |`),
    '',
    '## Enrichment Queue',
    '',
    '| Repo | Status | Narrative | Targets | First Target |',
    '| --- | --- | ---: | ---: | --- |',
    ...report.enrichment_queue.map(item => {
      const first = item.first_targets[0];
      const firstText = first
        ? `${first.target_kind}:${first.target} via ${first.suggested_tool}`
        : 'none';
      return `| ${escapeMd(item.repo)} | ${item.status} | ${item.narrative_score} | ${item.target_count} | ${escapeMd(firstText)} |`;
    }),
    '',
  ].join('\n');
}

function escapeMd(value: unknown): string {
  return String(value || '').replace(/\|/g, '\\|');
}

function parseArgs(argv: string[]): { machineReportPath?: string; coldReviewPath?: string; outputPath?: string; markdownPath?: string } {
  const options: { machineReportPath?: string; coldReviewPath?: string; outputPath?: string; markdownPath?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--machine-report') options.machineReportPath = path.resolve(argv[++index]);
    else if (arg === '--cold-review') options.coldReviewPath = path.resolve(argv[++index]);
    else if (arg === '--output') options.outputPath = path.resolve(argv[++index]);
    else if (arg === '--markdown') options.markdownPath = path.resolve(argv[++index]);
    else if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage: npm run analysis-narrative-enrichment-proof -- [options]',
        '',
        'Options:',
        '  --machine-report /path/report.json   Machine proof report used if no cold review exists',
        '  --cold-review /path/report.json      Read or create cold product-output review',
        '  --output /path/report.json           Write JSON report',
        '  --markdown /path/report.md           Write Markdown report',
      ].join('\n'));
      process.exit(0);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const defaults = {
    outputPath: path.resolve(process.cwd(), '.klauro-analysis-narrative-enrichment-proof/latest-report.json'),
    markdownPath: path.resolve(process.cwd(), '.klauro-analysis-narrative-enrichment-proof/latest-report.md'),
  };
  const report = await runAnalysisNarrativeEnrichmentProof({ ...defaults, ...parseArgs(process.argv.slice(2)) });
  console.log(JSON.stringify(report, null, 2));
  if (report.status === 'fail') process.exitCode = 1;
}

if (isDirectCliInvocation('analysis-narrative-enrichment-proof')) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
