import * as fs from 'fs-extra';
import * as path from 'path';
import { buildAgentPerformanceProof } from './agent-performance-proof';
import { listAgenticBenchmarkReports, loadAgenticBenchmarkReport } from './storage';

type GateStatus = 'pass' | 'fail';
type JsonObject = Record<string, any>;

const SMALL_TOKEN_OVERHEAD_PERCENT = 3;
const CLEAR_QUALITY_WIN_DELTA = 15;

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
  analysis: '.klauro-analysis-gauntlet/latest-report.json',
  agent: '.klauro-agent-gauntlet/latest-report.json',
  vision: '.klauro-vision-gauntlet/latest-report.json',
  agenticBenchmark: '.klauro-agent-benchmark/latest-report.json',
  qualityBenchmark: '.klauro-agent-quality-benchmark/latest-report.json',
  incrementalBenchmark: '.klauro-incremental-benchmark/latest-report.json',
  idiomBenchmark: '.klauro-agent-idiom-benchmark/latest-report.json',
  machineProof: '.klauro-agent-proof-machine/latest-report.json',
  scratchLiveBackend: '.klauro-agent-scratch-build-benchmark/live-work-intake-codex-rescored.json',
  scratchLiveUi: '.klauro-agent-scratch-build-benchmark/live-operations-ui-compact-codex.json',
  scratchLiveBackendMultiWave: '.klauro-agent-scratch-build-benchmark/live-work-intake-multi-wave-strict-rescored-codex.json',
  scratchLiveUiMultiWave: '.klauro-agent-scratch-build-benchmark/live-operations-ui-multi-wave-strict-codex.json',
  scratchLiveComplianceMultiWave: '.klauro-agent-scratch-build-benchmark/live-compliance-evidence-multi-wave-strict-codex.json',
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
  const scratchLiveBackend = await readReport(REPORTS.scratchLiveBackend);
  const scratchLiveUi = await readReport(REPORTS.scratchLiveUi);
  const scratchLiveBackendMultiWave = await readReport(REPORTS.scratchLiveBackendMultiWave);
  const scratchLiveUiMultiWave = await readReport(REPORTS.scratchLiveUiMultiWave);
  const scratchLiveComplianceMultiWave = await readReport(REPORTS.scratchLiveComplianceMultiWave);

  gates.push(...freshnessGates(options.maxAgeHours, {
    'analysis-gauntlet': analysis,
    'agent-gauntlet': agent,
    'vision-gauntlet': vision,
    'agentic-benchmark': agenticBenchmark,
    'agent-quality-benchmark': qualityBenchmark,
    'incremental-benchmark': incrementalBenchmark,
    'agent-idiom-benchmark': idiomBenchmark,
    'machine-agent-proof': machineProof,
    'scratch-live-backend': scratchLiveBackend,
    'scratch-live-ui': scratchLiveUi,
    'scratch-live-backend-multi-wave': scratchLiveBackendMultiWave,
    'scratch-live-ui-multi-wave': scratchLiveUiMultiWave,
    'scratch-live-compliance-multi-wave': scratchLiveComplianceMultiWave,
  }));

  gates.push(...analysisGates(analysis));
  gates.push(...agentGates(agent));
  gates.push(...visionGates(vision));
  gates.push(...agenticBenchmarkGates(agenticBenchmark));
  gates.push(...qualityBenchmarkGates(qualityBenchmark));
  gates.push(...incrementalBenchmarkGates(incrementalBenchmark));
  gates.push(...idiomBenchmarkGates(idiomBenchmark));
  gates.push(...machineProofGates(machineProof));
  gates.push(...scratchLiveGates([scratchLiveBackend, scratchLiveUi, scratchLiveBackendMultiWave, scratchLiveUiMultiWave, scratchLiveComplianceMultiWave]));
  gates.push(...scratchLiveMultiWaveGates([scratchLiveBackendMultiWave, scratchLiveUiMultiWave, scratchLiveComplianceMultiWave]));
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
  let outputPath: string | null = path.join(process.cwd(), '.klauro-agent-vision-acceptance', 'latest-report.json');

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
    return {
      generated_at: null,
      status: 'missing',
      score: 0,
      missing_report: relativePath,
    };
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
    gate('analysis-gauntlet:truth-targets', targets.length > 0 && targets.every(target => target.status === 'pass' && target.score === 100 && target.truth?.status === 'pass' && target.truth?.score === 100), `${targets.filter(target => target.status === 'pass' && target.score === 100).length}/${targets.length} targets at 100`),
    gate('analysis-gauntlet:no-truth-misses', targets.length > 0 && targets.every(target => array(target.truth?.misses).length === 0), `${targets.reduce((total, target) => total + array(target.truth?.misses).length, 0)} misses`),
  ];
}

function agentGates(report: JsonObject): Gate[] {
  const targets = array(report.targets);
  const defaultUseTargets = targets.filter(target => target.default_use === true);
  return [
    gate('agent-gauntlet:status', ['pass', 'warn'].includes(report.status) && Number(report.score) >= 95, `${report.status || 'unknown'} ${report.score ?? 'unknown'}/100`),
    gate('agent-gauntlet:coverage', targets.length >= 12 && report.defaultUseTargets >= 12, `${report.defaultUseTargets || 0}/${targets.length} default-use targets`),
    gate('agent-gauntlet:default-use', targets.length > 0 && defaultUseTargets.length === targets.length && targets.every(target => target.default_use === true && Number(target.score) >= 95), `${defaultUseTargets.length}/${targets.length} ready by default`),
  ];
}

function visionGates(report: JsonObject): Gate[] {
  const targets = array(report.targets);
  const integrationTargets = targets.filter(target => target.integration_depth?.score === 100);
  const strongIntegrationTargets = targets.filter(target => Number(target.integration_depth?.score || 0) >= 70);
  const workspaceConflicts = Number(report.workspace_graph?.conflicts ?? 0);
  const crossRepoLinks = array(report.cross_repository?.links).length || Number(report.workspace_graph?.link_count || 0);
  return [
    gate('vision-gauntlet:status', ['pass', 'warn'].includes(report.status) && Number(report.score) >= 95, `${report.status || 'unknown'} ${report.score ?? 'unknown'}/100`),
    gate('vision-gauntlet:real-repo-coverage', targets.length >= 12 && Number(report.target_count || targets.length) >= 12, `${targets.length} targets`),
    gate('vision-gauntlet:target-scores', targets.length > 0 && targets.every(target => target.status !== 'fail' && Number(target.score) >= 95), `${targets.filter(target => target.status !== 'fail' && Number(target.score) >= 95).length}/${targets.length} targets at >=95`),
    gate('vision-gauntlet:integration-depth', strongIntegrationTargets.length === targets.length && average(targets.map(target => Number(target.integration_depth?.score || 0))) >= 90, `${integrationTargets.length}/${targets.length} integration-depth reports at 100`),
    gate('vision-gauntlet:cross-repo-links', crossRepoLinks >= 100, `${crossRepoLinks} cross-repo links`),
    gate('vision-gauntlet:no-conflicts', !report.missing_report && workspaceConflicts === 0 && array(report.cross_repository?.conflicts).length === 0, `${workspaceConflicts + array(report.cross_repository?.conflicts).length} conflicts`),
  ];
}

function agenticBenchmarkGates(report: JsonObject): Gate[] {
  const summary = report.summary || {};
  return [
    gate('agentic-benchmark:status', report.status === 'pass' && report.score === 100, `${report.status || 'unknown'} ${report.score ?? 'unknown'}/100`),
    gate('agentic-benchmark:task-count', Number(summary.task_count) >= 48 && Number(summary.target_count) >= 6, `${summary.task_count || 0} tasks across ${summary.target_count || 0} targets`),
    gate('agentic-benchmark:success-lift', Number(summary.with_klauro_success_rate) === 1 && Number(summary.projected_without_klauro_success_rate) <= 0.65, `${percent(summary.with_klauro_success_rate)} with Klauro vs ${percent(summary.projected_without_klauro_success_rate)} projected baseline`),
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
    gate('quality-benchmark:quality-lift', Number(summary.average_quality_score_delta) >= 30 && Number(summary.average_context_completeness) === 100, `+${summary.average_quality_score_delta || 0} quality, ${summary.average_context_completeness || 0}/100 completeness`),
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
  const liveTrials = Number(summary.live_trials_attempted || 0);
  const deterministicMode = liveTrials === 0;
  const baselineModel = summary.deterministic_baseline_model || {};
  return [
    gate('idiom-benchmark:status', report.status === 'pass' && report.score >= 90, `${report.status || 'unknown'} ${report.score ?? 'unknown'}/100`),
    gate('idiom-benchmark:task-count', Number(summary.task_count) >= 6 && Number(summary.target_count) >= 3, `${summary.task_count || 0} tasks across ${summary.target_count || 0} targets`),
    gate('idiom-benchmark:proof-mode', liveTrials > 0 || Number(summary.average_idiom_conformance_delta) > 0, deterministicMode ? `${summary.task_count || 0} deterministic tasks` : `${liveTrials} live trials`),
    gate('idiom-benchmark:deterministic-baseline-varies',
      !deterministicMode || Number(baselineModel.distinct_idiom_penalties || 0) > 1,
      deterministicMode
        ? `${baselineModel.model || 'missing model'}, distinct penalties ${baselineModel.distinct_idiom_penalties || 0}, range ${baselineModel.idiom_penalty_min ?? 'n/a'}-${baselineModel.idiom_penalty_max ?? 'n/a'}`
        : 'live baseline measured from copied-repo agent output'),
    gate('idiom-benchmark:no-correctness-regression', deterministicMode || Number(summary.live_correctness_regressions) === 0, `${summary.live_correctness_regressions || 0} correctness regressions`),
    gate('idiom-benchmark:positive-idiom-delta', deterministicMode
      ? Number(summary.average_idiom_conformance_delta) > 0 && Number(summary.average_total_quality_delta) >= 0
      : Number(summary.live_average_idiom_conformance_delta) > 0 && Number(summary.live_average_total_quality_delta) >= 0,
      deterministicMode
        ? `idiom ${summary.average_idiom_conformance_delta ?? 'missing'}, quality ${summary.average_total_quality_delta ?? 'missing'}`
        : `idiom ${summary.live_average_idiom_conformance_delta ?? 'missing'}, quality ${summary.live_average_total_quality_delta ?? 'missing'}`),
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
    gate('machine-proof:no-silent-omissions', discovered.length > 0 && repoResults.length >= discovered.length, `${repoResults.length}/${discovered.length} repo rows reported`),
    gate('machine-proof:gates-pass', gates.length > 0 && failed.length === 0, `${failed.length} failing machine gates`),
  ];
}

function scratchLiveGates(reports: JsonObject[]): Gate[] {
  const present = reports.filter(report => !report.missing_report);
  const expectedReports = reports.length;
  const initialDeltas = present.map(report => Number(report.comparison?.quality_delta || 0));
  const continuationDeltas = present
    .map(report => report.continuation?.quality_delta)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const tokenDeltas = present
    .map(report => report.comparison?.token_reduction_percentage)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const tokenPolicyViolations = present
    .map(report => ({
      id: String(report.id || report.scenario?.id || report.scenario?.name || 'scratch-live-report'),
      tokenReduction: report.comparison?.token_reduction_percentage,
      qualityDelta: Number(report.comparison?.quality_delta || 0),
    }))
    .filter(item => typeof item.tokenReduction === 'number'
      && Number.isFinite(item.tokenReduction)
      && !passesTokenPolicy(item.tokenReduction, item.qualityDelta));
  const initialScores = present.flatMap(report => [
    Number(report.with_klauro?.score || 0),
    Number(report.without_klauro?.score || 0),
  ]);
  return [
    gate('scratch-live:coverage', present.length >= expectedReports, `${present.length}/${expectedReports} live scratch reports`),
    gate('scratch-live:initial-quality-lift', initialDeltas.some(delta => delta > 0) && initialDeltas.every(delta => delta >= 0), `initial quality deltas ${initialDeltas.join(', ') || 'missing'}`),
    gate('scratch-live:initial-quality-bar', initialScores.length > 0 && initialScores.every(score => score >= 90), `initial arm scores ${initialScores.join(', ') || 'missing'}`),
    gate('scratch-live:continuation-no-regression', continuationDeltas.length >= 2 && continuationDeltas.every(delta => delta >= 0), `continuation quality deltas ${continuationDeltas.join(', ') || 'missing'}`),
    gate('scratch-live:token-policy',
      tokenDeltas.length > 0 && tokenPolicyViolations.length === 0,
      tokenPolicyViolations.length === 0
        ? `initial token reductions ${tokenDeltas.join(', ') || 'missing'}; overhead allowed only <=${SMALL_TOKEN_OVERHEAD_PERCENT}% with +${CLEAR_QUALITY_WIN_DELTA} quality`
        : `token policy violations ${tokenPolicyViolations.map(item => `${item.id}:${item.tokenReduction}% tokens, +${item.qualityDelta} quality`).join('; ')}`),
  ];
}

function scratchLiveMultiWaveGates(reports: JsonObject[]): Gate[] {
  const present = reports.filter(report => !report.missing_report);
  const waves = present.flatMap(report => array(report.continuation_waves));
  const expectedReports = reports.length;
  const expectedWaves = expectedReports * 2;
  const liveQualityDeltas = waves
    .map(wave => wave.live_quality_delta)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const precisionDeltas = waves
    .map(wave => wave.changed_file_precision_delta)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const tokenDeltas = waves
    .map(wave => wave.token_reduction_percentage)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const changedFileDeltas = waves
    .map(wave => wave.changed_file_delta)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const tokenPolicyViolations = waves
    .map((wave, index) => ({
      id: String(wave.id || `wave-${index + 1}`),
      tokenReduction: wave.token_reduction_percentage,
      qualityDelta: Number(wave.live_quality_delta ?? wave.quality_delta ?? 0),
    }))
    .filter(item => typeof item.tokenReduction === 'number'
      && Number.isFinite(item.tokenReduction)
      && !passesTokenPolicy(item.tokenReduction, item.qualityDelta));
  const withScores = waves.map(wave => Number(wave.with_klauro?.score || 0));
  return [
    gate('scratch-live-multi-wave:coverage', present.length >= expectedReports && waves.length >= expectedWaves, `${present.length}/${expectedReports} reports, ${waves.length}/${expectedWaves} continuation waves`),
    gate('scratch-live-multi-wave:status', present.length >= expectedReports && present.every(report => report.status === 'pass' && Number(report.score || 0) >= 90), `${present.map(report => `${report.status || 'unknown'} ${report.score ?? 'unknown'}/100`).join('; ') || 'missing'}`),
    gate('scratch-live-multi-wave:with-klauro-quality', withScores.length >= expectedWaves && withScores.every(score => score >= 90), `with-Klauro wave scores ${withScores.join(', ') || 'missing'}`),
    gate('scratch-live-multi-wave:live-quality-delta', liveQualityDeltas.length >= expectedWaves && liveQualityDeltas.every(delta => delta >= 0) && liveQualityDeltas.some(delta => delta > 0), `live quality deltas ${liveQualityDeltas.join(', ') || 'missing'}`),
    gate('scratch-live-multi-wave:file-targeting-delta', precisionDeltas.length >= expectedWaves && precisionDeltas.every(delta => delta > 0) && average(precisionDeltas) >= 40, `changed-file precision deltas ${precisionDeltas.join(', ') || 'missing'}`),
    gate('scratch-live-multi-wave:token-policy',
      tokenDeltas.length > 0 && tokenPolicyViolations.length === 0,
      tokenPolicyViolations.length === 0
        ? `token reductions ${tokenDeltas.join(', ') || 'missing'}; overhead allowed only <=${SMALL_TOKEN_OVERHEAD_PERCENT}% with +${CLEAR_QUALITY_WIN_DELTA} quality`
        : `token policy violations ${tokenPolicyViolations.map(item => `${item.id}:${item.tokenReduction}% tokens, +${item.qualityDelta} quality`).join('; ')}`),
    gate('scratch-live-multi-wave:agent-value', tokenDeltas.some(delta => delta >= 20) || average(changedFileDeltas) >= 2, `token reductions ${tokenDeltas.join(', ') || 'missing'}, changed-file deltas ${changedFileDeltas.join(', ') || 'missing'}`),
  ];
}

function passesTokenPolicy(tokenReductionPercentage: number, qualityDelta: number): boolean {
  if (tokenReductionPercentage >= 0) return true;
  return Math.abs(tokenReductionPercentage) <= SMALL_TOKEN_OVERHEAD_PERCENT
    && qualityDelta >= CLEAR_QUALITY_WIN_DELTA;
}

async function persistedProofGates(): Promise<Gate[]> {
  const summaries = await listAgenticBenchmarkReports();
  const reports = (await Promise.all(summaries.map(summary => loadAgenticBenchmarkReport(summary.id))))
    .filter((report): report is JsonObject => Boolean(report));
  const proof = buildAgentPerformanceProof(reports, { sinceDays: 7 });
  const liveRollup = proof.rollups.find((rollup: JsonObject) => rollup.benchmark_type === 'live-agent-quality-ab-rollup');
  const existingLiveRollup = proof.rollups.find((rollup: JsonObject) => rollup.benchmark_type === 'existing-project-live-task-rollup');
  const taskFamilyCoverage = proof.rollups.find((rollup: JsonObject) => rollup.benchmark_type === 'agent-task-family-coverage-rollup');
  const idiomReport = reports.find((report: JsonObject) => report.benchmark_type === 'live-agent-idiom-quality-ab')
    || reports.find((report: JsonObject) => report.benchmark_type === 'deterministic-agent-idiom-quality-proxy');
  const fromZeroReport = reports.find((report: JsonObject) => report.benchmark_type === 'from-zero-build-packet-proof');
  const fromZeroScenarioCount = Number(fromZeroReport?.summary?.scenario_count || (fromZeroReport?.scenario ? 1 : 0));
  const fromZeroProductFocusCount = Number(fromZeroReport?.summary?.product_focus_scenario_count || 0);
  const fromZeroGrowthIterations = Number(fromZeroReport?.summary?.growth_iteration_count || fromZeroReport?.summary?.task_count || 0);
  const claims = array(proof.claims);
  const usefulnessClaim = claims.find((claim: JsonObject) => String(claim.claim || '').includes('reduce context'));
  const qualityClaim = claims.find((claim: JsonObject) => String(claim.claim || '').includes('patch quality'));
  const liveTokenReduction = metricPercent(liveRollup?.metrics?.token_reduction);
  const existingLiveTokenReduction = metricPercent(existingLiveRollup?.metrics?.average_token_reduction);
  const deterministicTokenReduction = metricPercent(usefulnessClaim?.evidence?.average_token_reduction_vs_search);
  const liveTimeReduction = metricPercent(liveRollup?.metrics?.time_reduction);
  const existingLiveTimeReduction = metricPercent(existingLiveRollup?.metrics?.average_time_reduction);
  const deterministicTimeReduction = metricPercent(qualityClaim?.evidence?.average_time_reduction_vs_search);
  const liveFileReduction = metricPercent(liveRollup?.metrics?.file_read_reduction);
  const deterministicFileReduction = metricPercent(usefulnessClaim?.evidence?.average_file_reduction);
  const liveWithSuccess = metricPercent(liveRollup?.metrics?.with_klauro_success_rate);
  const existingLiveQualityDelta = signedMetric(existingLiveRollup?.metrics?.average_quality_delta);
  const existingLiveTokenRegressions = Number(existingLiveRollup?.metrics?.token_regressions ?? Number.POSITIVE_INFINITY);
  const existingLiveAcceptedTokenTradeoffs = Number(existingLiveRollup?.metrics?.accepted_token_tradeoffs ?? 0);
  const taskFamilyStrong = Number(taskFamilyCoverage?.metrics?.strong_families || 0);
  const taskFamilyCount = Number(taskFamilyCoverage?.metrics?.families || 0);
  const taskFamilyGaps = Number(taskFamilyCoverage?.metrics?.gap_families || 0);
  const taskFamilyPartial = Number(taskFamilyCoverage?.metrics?.partial_families || 0);
  const deterministicWithSuccess = metricPercent(qualityClaim?.evidence?.with_klauro_success_rate);
  const deterministicQualityDelta = Number(String(qualityClaim?.evidence?.average_quality_score_delta || '').replace('+', ''));

  return [
    gate('mcp-proof:recent-report-coverage', Number(proof.included_report_count) >= 4 && Number(proof.latest_report_count) >= 3, `${proof.included_report_count} recent reports, ${proof.latest_report_count} latest families`),
    gate('mcp-proof:claims', claims.length >= 4, `${claims.length} proof claims`),
    gate('mcp-proof:token-reduction',
      existingLiveTokenReduction >= 0 || liveTokenReduction >= 0.5 || deterministicTokenReduction >= 0.8,
      existingLiveRollup
        ? `${existingLiveRollup.metrics?.average_token_reduction || 'unknown'} existing-task live token reduction, ${existingLiveRollup.metrics?.token_regressions ?? 'unknown'} token regressions`
        : liveTokenReduction > 0
        ? `${liveRollup?.metrics?.token_reduction || 'unknown'} live token reduction (${liveRollup?.metrics?.token_measurement_source || 'unknown'} tokens)`
        : `${usefulnessClaim?.evidence?.average_token_reduction_vs_search || 'unknown'} deterministic token reduction`),
    gate('mcp-proof:time-reduction',
      existingLiveTimeReduction >= 0 || liveTimeReduction >= 0.2 || deterministicTimeReduction >= 0.8,
      existingLiveRollup
        ? `${existingLiveRollup.metrics?.average_time_reduction || 'unknown'} existing-task live time reduction`
        : liveTimeReduction > 0
        ? `${liveRollup?.metrics?.time_reduction || 'unknown'} live time reduction`
        : `${qualityClaim?.evidence?.average_time_reduction_vs_search || 'unknown'} deterministic time reduction`),
    gate('mcp-proof:file-reduction',
      liveFileReduction >= 0.25 || deterministicFileReduction >= 0.95,
      liveFileReduction > 0
        ? `${liveRollup?.metrics?.file_read_reduction || 'unknown'} live file-read reduction`
        : `${usefulnessClaim?.evidence?.average_file_reduction || 'unknown'} deterministic file-read reduction`),
    gate('mcp-proof:quality-preserved',
      (existingLiveRollup
        ? existingLiveRollup.status === 'pass' && existingLiveQualityDelta > 0 && existingLiveTokenRegressions === 0
        : false)
        || (liveRollup ? liveRollup.status !== 'fail' && liveWithSuccess === 1 && metricPercent(liveRollup.metrics?.token_reduction) >= 0 : false)
        || (deterministicWithSuccess === 1 && deterministicQualityDelta > 0),
      existingLiveRollup
        ? `${existingLiveRollup.status || 'unknown'}, ${existingLiveRollup.metrics?.passing_live_tasks || 0}/${existingLiveRollup.metrics?.live_tasks || 0} existing-task live passes, ${existingLiveRollup.metrics?.average_quality_delta || 'unknown'} quality delta, ${existingLiveRollup.metrics?.average_token_reduction || 'unknown'} token reduction, ${existingLiveAcceptedTokenTradeoffs} accepted tiny token tradeoffs, ${existingLiveTokenRegressions} token regressions`
        : liveRollup
        ? `${liveRollup.status || 'unknown'}, ${liveRollup.metrics?.with_klauro_success_rate || 'unknown'} live success, ${liveRollup.metrics?.average_quality_delta || 'unknown'} live quality delta`
        : `${qualityClaim?.evidence?.with_klauro_success_rate || 'unknown'} deterministic success, ${qualityClaim?.evidence?.average_quality_score_delta || 'unknown'} quality delta`),
    gate('mcp-proof:task-family-coverage',
      Boolean(taskFamilyCoverage) && taskFamilyCoverage?.status === 'pass' && taskFamilyStrong === taskFamilyCount && taskFamilyCount >= 17 && taskFamilyPartial === 0 && taskFamilyGaps === 0,
      taskFamilyCoverage
        ? `${taskFamilyCoverage.status || 'unknown'}, ${taskFamilyCoverage.metrics?.coverage || 'unknown'} strong families, ${taskFamilyPartial} partial, ${taskFamilyGaps} gaps`
        : 'missing task-family coverage proof'),
    gate('mcp-proof:idiom-quality', Boolean(idiomReport) && Number(idiomReport?.summary?.average_idiom_conformance_delta || idiomReport?.summary?.live_average_idiom_conformance_delta || 0) > 0 && Number(idiomReport?.summary?.live_correctness_regressions || 0) === 0, idiomReport ? `idiom delta ${idiomReport.summary?.average_idiom_conformance_delta ?? idiomReport.summary?.live_average_idiom_conformance_delta}, correctness regressions ${idiomReport.summary?.live_correctness_regressions}` : 'missing idiom quality report'),
    gate('mcp-proof:from-zero-build-memory',
      Boolean(fromZeroReport) &&
        fromZeroReport?.status === 'pass' &&
        fromZeroScenarioCount >= 3 &&
        Number(fromZeroReport?.summary?.scenarios_passed || 0) === fromZeroScenarioCount &&
        fromZeroProductFocusCount === fromZeroScenarioCount &&
        fromZeroGrowthIterations >= 15 &&
        Number(fromZeroReport?.summary?.quality_delta || 0) > 0 &&
        Number(fromZeroReport?.summary?.duplicate_class_delta || 0) > 0 &&
        Number(fromZeroReport?.summary?.context_char_reduction_percentage || 0) > 0 &&
        Number(fromZeroReport?.summary?.with_klauro_duplicate_classes || 0) === 0,
      fromZeroReport
        ? `${fromZeroReport.summary?.scenarios_passed || 0}/${fromZeroScenarioCount} scenarios, ${fromZeroProductFocusCount}/${fromZeroScenarioCount} product-focus packets, ${fromZeroGrowthIterations} growth iterations, quality delta ${fromZeroReport.summary?.quality_delta}, duplicate-class delta ${fromZeroReport.summary?.duplicate_class_delta}, context reduction ${fromZeroReport.summary?.context_char_reduction_percentage}%, with-Klauro duplicates ${fromZeroReport.summary?.with_klauro_duplicate_classes}`
        : 'missing from-zero build packet proof'),
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

function signedMetric(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace('%', '').replace('+', '').trim());
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function average(values: number[]): number {
  const finite = values.filter(value => Number.isFinite(value));
  if (finite.length === 0) return 0;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
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
