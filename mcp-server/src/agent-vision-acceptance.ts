import * as fs from 'fs-extra';
import * as path from 'path';
import { buildAgentPerformanceProof } from './agent-performance-proof';
import { listAgenticBenchmarkReports, loadAgenticBenchmarkReport } from './storage';

type GateStatus = 'pass' | 'fail';
type JsonObject = Record<string, any>;

interface Gate {
  id: string;
  status: GateStatus;
  score: number;
  detail: string;
}

interface AcceptanceReport {
  generated_at: string;
  status: GateStatus;
  score: number;
  max_age_hours: number | null;
  gates: Gate[];
}

interface Options {
  maxAgeHours: number | null;
  outputPath: string | null;
}

const REPORTS = {
  analysis: '.unravl-analysis-gauntlet/latest-report.json',
  agent: '.unravl-agent-gauntlet/latest-report.json',
  vision: '.unravl-vision-gauntlet/latest-report.json',
  agenticBenchmark: '.unravl-agent-benchmark/latest-report.json',
  qualityBenchmark: '.unravl-agent-quality-benchmark/latest-report.json',
  incrementalBenchmark: '.unravl-incremental-benchmark/latest-report.json',
  idiomBenchmark: '.unravl-agent-idiom-benchmark/latest-report.json',
  machineProof: '.unravl-agent-proof-machine/latest-report.json',
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const gates: Gate[] = [];

  const analysis = await readReport(REPORTS.analysis);
  const agent = await readReport(REPORTS.agent);
  const vision = await readReport(REPORTS.vision);
  const agenticBenchmark = await readReport(REPORTS.agenticBenchmark);
  const qualityBenchmark = await readReport(REPORTS.qualityBenchmark);
  const incrementalBenchmark = await readReport(REPORTS.incrementalBenchmark);
  const idiomBenchmark = await readReport(REPORTS.idiomBenchmark);
  const machineProof = await readReport(REPORTS.machineProof);

  gates.push(...freshnessGates(options.maxAgeHours, {
    'analysis-gauntlet': analysis,
    'agent-gauntlet': agent,
    'vision-gauntlet': vision,
    'agentic-benchmark': agenticBenchmark,
    'agent-quality-benchmark': qualityBenchmark,
    'incremental-benchmark': incrementalBenchmark,
    'agent-idiom-benchmark': idiomBenchmark,
    'machine-agent-proof': machineProof,
  }));

  gates.push(...analysisGates(analysis));
  gates.push(...agentGates(agent));
  gates.push(...visionGates(vision));
  gates.push(...agenticBenchmarkGates(agenticBenchmark));
  gates.push(...qualityBenchmarkGates(qualityBenchmark));
  gates.push(...incrementalBenchmarkGates(incrementalBenchmark));
  gates.push(...idiomBenchmarkGates(idiomBenchmark));
  gates.push(...machineProofGates(machineProof));
  gates.push(...await persistedProofGates());

  const report = buildReport(gates, options.maxAgeHours);
  printReport(report);

  if (options.outputPath) {
    await fs.ensureDir(path.dirname(options.outputPath));
    await fs.writeJson(options.outputPath, report, { spaces: 2 });
  }

  if (report.status !== 'pass') {
    process.exitCode = 1;
  }
}

function parseArgs(argv: string[]): Options {
  let maxAgeHours: number | null = 168;
  let outputPath: string | null = path.join(process.cwd(), '.unravl-agent-vision-acceptance', 'latest-report.json');

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--max-age-hours') {
      const value = Number(argv[++i]);
      maxAgeHours = value > 0 ? value : null;
    } else if (arg === '--output') {
      outputPath = path.resolve(argv[++i]);
    } else if (arg === '--no-output') {
      outputPath = null;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return { maxAgeHours, outputPath };
}

function printHelp(): void {
  console.log([
    'Usage: npm run agent-vision-acceptance -- [options]',
    '',
    'Options:',
    '  --max-age-hours n          Require reports to be fresh. Use 0 to disable.',
    '  --output /path/report.json Write JSON report.',
    '  --no-output                Do not write JSON report.',
  ].join('\n'));
}

async function readReport(relativePath: string): Promise<JsonObject> {
  const filePath = path.resolve(process.cwd(), relativePath);
  if (!(await fs.pathExists(filePath))) {
    throw new Error(`Missing required report: ${relativePath}`);
  }
  return fs.readJson(filePath);
}

function freshnessGates(maxAgeHours: number | null, reports: Record<string, JsonObject>): Gate[] {
  if (!maxAgeHours) return [];
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  return Object.entries(reports).map(([id, report]) => {
    const generatedAt = timestamp(report);
    const ageMs = generatedAt ? Date.now() - generatedAt.getTime() : Number.POSITIVE_INFINITY;
    const ageHours = ageMs / (60 * 60 * 1000);
    return gate(
      `${id}:freshness`,
      Boolean(generatedAt) && ageMs >= 0 && ageMs <= maxAgeMs,
      generatedAt
        ? `generated ${hours(ageHours)}h ago, max ${maxAgeHours}h`
        : 'missing generated timestamp'
    );
  });
}

function analysisGates(report: JsonObject): Gate[] {
  const targets = array(report.targets);
  return [
    gate('analysis-gauntlet:status', report.status === 'pass' && report.score === 100, `${report.status || 'unknown'} ${report.score ?? 'unknown'}/100`),
    gate('analysis-gauntlet:target-count', targets.length >= 9, `${targets.length} target fixtures`),
    gate('analysis-gauntlet:truth-targets', targets.every(target => target.status === 'pass' && target.score === 100 && target.truth?.status === 'pass' && target.truth?.score === 100), `${targets.filter(target => target.status === 'pass' && target.score === 100).length}/${targets.length} targets at 100`),
    gate('analysis-gauntlet:no-truth-misses', targets.every(target => array(target.truth?.misses).length === 0), `${targets.reduce((total, target) => total + array(target.truth?.misses).length, 0)} misses`),
  ];
}

function agentGates(report: JsonObject): Gate[] {
  const targets = array(report.targets);
  const defaultUseTargets = targets.filter(target => target.default_use === true);
  return [
    gate('agent-gauntlet:status', report.status === 'pass' && report.score === 100, `${report.status || 'unknown'} ${report.score ?? 'unknown'}/100`),
    gate('agent-gauntlet:coverage', targets.length >= 12 && report.defaultUseTargets >= 12, `${report.defaultUseTargets || 0}/${targets.length} default-use targets`),
    gate('agent-gauntlet:default-use', defaultUseTargets.length === targets.length && targets.every(target => target.status === 'pass' && target.score === 100), `${defaultUseTargets.length}/${targets.length} ready by default`),
  ];
}

function visionGates(report: JsonObject): Gate[] {
  const targets = array(report.targets);
  const integrationTargets = targets.filter(target => target.integration_depth?.score === 100);
  const workspaceConflicts = Number(report.workspace_graph?.conflicts ?? 0);
  const crossRepoLinks = array(report.cross_repository?.links).length || Number(report.workspace_graph?.link_count || 0);
  return [
    gate('vision-gauntlet:status', report.status === 'pass' && report.score === 100, `${report.status || 'unknown'} ${report.score ?? 'unknown'}/100`),
    gate('vision-gauntlet:real-repo-coverage', targets.length >= 12 && Number(report.target_count || targets.length) >= 12, `${targets.length} targets`),
    gate('vision-gauntlet:target-scores', targets.every(target => target.status === 'pass' && target.score === 100), `${targets.filter(target => target.status === 'pass' && target.score === 100).length}/${targets.length} targets at 100`),
    gate('vision-gauntlet:integration-depth', integrationTargets.length === targets.length, `${integrationTargets.length}/${targets.length} integration-depth reports at 100`),
    gate('vision-gauntlet:cross-repo-links', crossRepoLinks >= 100, `${crossRepoLinks} cross-repo links`),
    gate('vision-gauntlet:no-conflicts', workspaceConflicts === 0 && array(report.cross_repository?.conflicts).length === 0, `${workspaceConflicts + array(report.cross_repository?.conflicts).length} conflicts`),
  ];
}

function agenticBenchmarkGates(report: JsonObject): Gate[] {
  const summary = report.summary || {};
  return [
    gate('agentic-benchmark:status', report.status === 'pass' && report.score === 100, `${report.status || 'unknown'} ${report.score ?? 'unknown'}/100`),
    gate('agentic-benchmark:task-count', Number(summary.task_count) >= 48 && Number(summary.target_count) >= 6, `${summary.task_count || 0} tasks across ${summary.target_count || 0} targets`),
    gate('agentic-benchmark:success-lift', Number(summary.with_unravl_success_rate) === 1 && Number(summary.projected_without_unravl_success_rate) <= 0.59, `${percent(summary.with_unravl_success_rate)} with Unravl vs ${percent(summary.projected_without_unravl_success_rate)} projected baseline`),
    gate('agentic-benchmark:token-reduction', Number(summary.average_token_reduction_vs_search) >= 80, `${summary.average_token_reduction_vs_search || 0}% token reduction vs search`),
    gate('agentic-benchmark:speedup', Number(summary.average_speedup_vs_search) >= 50, `${summary.average_speedup_vs_search || 0}x speedup vs search`),
    gate('agentic-benchmark:file-reduction', Number(summary.average_file_reduction) >= 95, `${summary.average_file_reduction || 0}% file reduction`),
  ];
}

function qualityBenchmarkGates(report: JsonObject): Gate[] {
  const summary = report.summary || {};
  return [
    gate('quality-benchmark:status', report.status === 'pass' && report.score === 100, `${report.status || 'unknown'} ${report.score ?? 'unknown'}/100`),
    gate('quality-benchmark:task-count', Number(summary.task_count) >= 48 && Number(summary.target_count) >= 6, `${summary.task_count || 0} tasks across ${summary.target_count || 0} targets`),
    gate('quality-benchmark:quality-lift', Number(summary.average_quality_score_delta) >= 40 && Number(summary.average_context_completeness) === 100, `+${summary.average_quality_score_delta || 0} quality, ${summary.average_context_completeness || 0}/100 completeness`),
    gate('quality-benchmark:token-reduction', Number(summary.average_token_reduction_vs_search) >= 80, `${summary.average_token_reduction_vs_search || 0}% token reduction vs search`),
    gate('quality-benchmark:time-reduction', Number(summary.average_time_reduction_vs_search) >= 80, `${summary.average_time_reduction_vs_search || 0}% time reduction vs search`),
  ];
}

function incrementalBenchmarkGates(report: JsonObject): Gate[] {
  const summary = report.summary || {};
  return [
    gate('incremental-benchmark:status', report.status === 'pass' && report.score === 100, `${report.status || 'unknown'} ${report.score ?? 'unknown'}/100`),
    gate('incremental-benchmark:coverage', Number(summary.target_count) >= 6, `${summary.target_count || 0} targets`),
    gate('incremental-benchmark:success', Number(summary.incremental_success_rate) === 1, `${percent(summary.incremental_success_rate)} incremental success`),
    gate('incremental-benchmark:no-change-speedup', Number(summary.average_no_change_speedup_vs_full) >= 5, `${summary.average_no_change_speedup_vs_full || 0}x no-change speedup`),
    gate('incremental-benchmark:edit-speedup', Number(summary.average_edit_speedup_vs_full) >= 2, `${summary.average_edit_speedup_vs_full || 0}x edit speedup`),
    gate('incremental-benchmark:post-edit-context', Number(summary.average_packet_generation_ms_after_edit) <= 500 && Number(summary.average_file_read_plan_after_edit) <= 3 && Number(summary.average_packet_tokens_after_edit) <= 10000, `${summary.average_packet_generation_ms_after_edit || 0}ms, ${summary.average_file_read_plan_after_edit || 0} files, ${summary.average_packet_tokens_after_edit || 0} tokens`),
    gate('incremental-benchmark:full-verify-parity', Number(summary.average_full_verify_count_similarity) >= 0.98, `${percent(summary.average_full_verify_count_similarity)} count similarity`),
  ];
}

function idiomBenchmarkGates(report: JsonObject): Gate[] {
  const summary = report.summary || {};
  return [
    gate('idiom-benchmark:status', report.status === 'pass' && report.score >= 90, `${report.status || 'unknown'} ${report.score ?? 'unknown'}/100`),
    gate('idiom-benchmark:task-count', Number(summary.task_count) >= 6 && Number(summary.target_count) >= 3, `${summary.task_count || 0} tasks across ${summary.target_count || 0} targets`),
    gate('idiom-benchmark:live-present', Number(summary.live_trials_attempted) > 0, `${summary.live_trials_attempted || 0} live trials`),
    gate('idiom-benchmark:no-correctness-regression', Number(summary.live_correctness_regressions) === 0 && Number(summary.live_trials_attempted) > 0, `${summary.live_correctness_regressions || 0} correctness regressions`),
    gate('idiom-benchmark:positive-idiom-delta', Number(summary.live_average_idiom_conformance_delta) > 0 && Number(summary.live_average_total_quality_delta) >= 0, `idiom ${summary.live_average_idiom_conformance_delta ?? 'missing'}, quality ${summary.live_average_total_quality_delta ?? 'missing'}`),
  ];
}

function machineProofGates(report: JsonObject): Gate[] {
  const discovery = report.discovery || {};
  const gates = array(report.gates);
  const failed = gates.filter(item => item.status !== 'pass');
  const repoResults = array(report.repo_results);
  const discovered = array(discovery.repos);
  const eligible = discovered.filter(repo => repo.status === 'eligible');
  const accountedEligible = eligible.filter(repo => repoResults.some(result => result.path === repo.path));
  return [
    gate('machine-proof:status', report.status === 'pass' && report.score === 100, `${report.status || 'unknown'} ${report.score ?? 'unknown'}/100`),
    gate('machine-proof:discovery-accounting', Number(discovery.total_repos) === discovered.length && discovered.length > 0, `${discovered.length}/${discovery.total_repos || 0} discovered repos accounted`),
    gate('machine-proof:eligible-accounting', accountedEligible.length === eligible.length && eligible.length > 0, `${accountedEligible.length}/${eligible.length} eligible repos accounted`),
    gate('machine-proof:no-silent-omissions', repoResults.length >= discovered.length, `${repoResults.length}/${discovered.length} repo rows reported`),
    gate('machine-proof:gates-pass', failed.length === 0, `${failed.length} failing machine gates`),
  ];
}

async function persistedProofGates(): Promise<Gate[]> {
  const summaries = await listAgenticBenchmarkReports();
  const reports = (await Promise.all(summaries.map(summary => loadAgenticBenchmarkReport(summary.id))))
    .filter((report): report is JsonObject => Boolean(report));
  const proof = buildAgentPerformanceProof(reports, { sinceDays: 7 });
  const liveRollup = proof.rollups.find((rollup: JsonObject) => rollup.benchmark_type === 'live-agent-quality-ab-rollup');
  const idiomReport = reports.find((report: JsonObject) => report.benchmark_type === 'live-agent-idiom-quality-ab');
  const claims = array(proof.claims);

  return [
    gate('mcp-proof:recent-report-coverage', Number(proof.included_report_count) >= 4 && Number(proof.latest_report_count) >= 3, `${proof.included_report_count} recent reports, ${proof.latest_report_count} latest families`),
    gate('mcp-proof:claims', claims.length >= 3, `${claims.length} proof claims`),
    gate('mcp-proof:live-rollup-present', Boolean(liveRollup), liveRollup ? `${liveRollup.metrics?.live_trials || 0} live trials` : 'missing live rollup'),
    gate('mcp-proof:live-token-reduction', metricPercent(liveRollup?.metrics?.token_reduction) >= 0.5, `${liveRollup?.metrics?.token_reduction || 'unknown'} token reduction`),
    gate('mcp-proof:live-time-reduction', metricPercent(liveRollup?.metrics?.time_reduction) >= 0.2, `${liveRollup?.metrics?.time_reduction || 'unknown'} time reduction`),
    gate('mcp-proof:live-file-reduction', metricPercent(liveRollup?.metrics?.file_read_reduction) >= 0.25, `${liveRollup?.metrics?.file_read_reduction || 'unknown'} file-read reduction`),
    gate('mcp-proof:live-quality-preserved', liveRollup?.status === 'pass' && metricPercent(liveRollup?.metrics?.with_unravl_success_rate) === 1, `${liveRollup?.status || 'unknown'}, ${liveRollup?.metrics?.with_unravl_success_rate || 'unknown'} success`),
    gate('mcp-proof:live-idiom-quality', Boolean(idiomReport) && Number(idiomReport?.summary?.live_average_idiom_conformance_delta || 0) > 0 && Number(idiomReport?.summary?.live_correctness_regressions || 0) === 0, idiomReport ? `idiom delta ${idiomReport.summary?.live_average_idiom_conformance_delta}, correctness regressions ${idiomReport.summary?.live_correctness_regressions}` : 'missing live idiom quality report'),
  ];
}

function buildReport(gates: Gate[], maxAgeHours: number | null): AcceptanceReport {
  const score = Math.round(gates.reduce((total, gate) => total + gate.score, 0) / Math.max(1, gates.length));
  return {
    generated_at: new Date().toISOString(),
    status: gates.every(gate => gate.status === 'pass') ? 'pass' : 'fail',
    score,
    max_age_hours: maxAgeHours,
    gates,
  };
}

function printReport(report: AcceptanceReport): void {
  console.log(`Agent vision acceptance: ${report.status.toUpperCase()} (${report.score}/100)`);
  for (const item of report.gates) {
    console.log(`${item.status.toUpperCase().padEnd(4)} ${item.id} - ${item.detail}`);
  }
}

function gate(id: string, condition: boolean, detail: string): Gate {
  return {
    id,
    status: condition ? 'pass' : 'fail',
    score: condition ? 100 : 0,
    detail,
  };
}

function timestamp(report: JsonObject): Date | null {
  const raw = report.generated_at || report.generatedAt || report.saved_at;
  const parsed = Date.parse(String(raw || ''));
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function metricPercent(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1 ? value / 100 : value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace('%', '').trim());
    if (Number.isFinite(parsed)) return parsed > 1 ? parsed / 100 : parsed;
  }
  return 0;
}

function percent(value: unknown): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 'unknown';
  return `${Math.round(parsed * 100)}%`;
}

function hours(value: number): number {
  return Number(value.toFixed(2));
}

function array(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value as JsonObject[] : [];
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
