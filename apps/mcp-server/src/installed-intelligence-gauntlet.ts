#!/usr/bin/env tsx
import * as fs from 'fs-extra';
import * as path from 'path';
import { buildCampsReport, resetCampsReportCache } from './gauntlet/camps-bench';
import { buildCampBStructuralReport } from './gauntlet/camp-b-structural';
import { buildCampCRoutesVsCbmReport } from './gauntlet/camp-c-routes-cbm';
import { buildCampCComprehensionReport } from './gauntlet/camp-c-comprehension';
import { buildCampWASReport } from './gauntlet/camp-was-bench';
import { buildDepthBehavioralDiffReport } from './gauntlet/depth-behavioral-diff-bench';
import { buildDepthContractDriftReport } from './gauntlet/depth-contract-drift-bench';
import { buildDepthDispatchReport } from './gauntlet/depth-dispatch-bench';
import { buildDepthTaintReport } from './gauntlet/depth-taint-bench';
import { runTelemetryOverlaySuite } from './gauntlet/telemetry-overlay-bench';
import { isDirectCliInvocation } from './cli-invocation';

type GateStatus = 'pass' | 'warn' | 'fail';

interface Gate {
  id: string;
  status: GateStatus;
  detail: string;
}

interface Args {
  liveReportPath: string;
  outputPath: string;
  markdownPath: string;
}

interface InstalledIntelligenceGauntletReport {
  generated_at: string;
  benchmark_type: 'installed-intelligence-gauntlet';
  status: GateStatus;
  score: number;
  summary: {
    claim_limit: string;
    live_agent_trials: number;
    live_agent_quality_delta: number | null;
    live_agent_token_reduction_percentage: number | null;
    live_agent_time_reduction_percentage: number | null;
    structural_languages_measured: number | null;
    structural_losses_vs_codebase_memory: number | null;
    camp_c_head_to_head_dimensions: number;
    workspace_dimensions: number;
    workspace_dimensions_emitted: number;
  };
  gates: Gate[];
  live_agent: unknown;
  language_and_depth: unknown;
  workspace_analysis: unknown;
}

export async function buildInstalledIntelligenceGauntlet(args: Args): Promise<InstalledIntelligenceGauntletReport> {
  const generatedAt = new Date().toISOString();
  const liveReport = await readOptionalJson(args.liveReportPath);
  resetCampsReportCache();
  const [
    camps,
    campBStructuralReport,
    campCRoutesVsCbmReport,
    campCFullReport,
    campWASReport,
    depthTaintReport,
    depthDispatchReport,
    depthContractDriftReport,
    depthBehavioralDiffReport,
    telemetryOverlayReport,
  ] = await Promise.all([
    buildCampsReport(generatedAt),
    buildCampBStructuralReport(),
    buildCampCRoutesVsCbmReport(),
    buildCampCComprehensionReport(),
    buildCampWASReport(),
    buildDepthTaintReport(),
    buildDepthDispatchReport(),
    buildDepthContractDriftReport(),
    buildDepthBehavioralDiffReport(),
    runTelemetryOverlaySuite(path.join(__dirname, '../fixtures/telemetry-overlay'), { withCbm: true }),
  ]);

  const liveSummary = liveReport?.summary || {};
  const campBStructural = campBStructuralReport.available ? campBStructuralReport.aggregate : null;
  const campCRoutes = campCRoutesVsCbmReport.available ? campCRoutesVsCbmReport.aggregate : null;
  const depthTaint = depthTaintReport.available ? depthTaintReport.aggregate : null;
  const depthDispatch = depthDispatchReport.available ? depthDispatchReport.aggregate : null;
  const depthContractDrift = depthContractDriftReport.available ? depthContractDriftReport.aggregate : null;
  const depthBehavioralDiff = depthBehavioralDiffReport.available ? depthBehavioralDiffReport.aggregate : null;
  const telemetryOverlay = telemetryOverlayReport;
  const workspaceEmitted = campWASReport.dimensions.filter((dimension: any) => Number(dimension.emitted || 0) > 0).length;
  const campCHeadToHead = campCFullReport.dimensions.filter((dimension: any) => dimension.mode === 'head-to-head');

  const gates: Gate[] = [
    gate('installed-intelligence:live-report-present', Boolean(liveReport), args.liveReportPath),
    gate('installed-intelligence:live-agent-quality', numberOrNegInf(liveSummary.average_quality_delta) >= 0, `${liveSummary.average_quality_delta ?? 'n/a'} average live quality delta`),
    gate('installed-intelligence:live-agent-token-discipline', numberOrNegInf(liveSummary.average_token_reduction_percentage) >= 0, `${liveSummary.average_token_reduction_percentage ?? 'n/a'}% average live token reduction`),
    gate('installed-intelligence:live-agent-speed', numberOrNegInf(liveSummary.average_time_reduction_percentage) >= 0, `${liveSummary.average_time_reduction_percentage ?? 'n/a'}% average live speed improvement`),
    gate('installed-intelligence:camp-b-structural-no-losses', !campBStructural || campBStructural.losses === 0, `${campBStructural?.losses ?? 'unavailable'} structural losses vs codebase-memory`),
    gate('installed-intelligence:camp-c-routes-no-losses', !campCRoutes || campCRoutes.losses === 0, `${campCRoutes?.losses ?? 'unavailable'} route losses vs codebase-memory`),
    gate('installed-intelligence:depth-taint-no-losses', !depthTaint || depthTaint.losses === 0, `${depthTaint?.losses ?? 'unavailable'} taint/data-flow losses vs codebase-memory`),
    gate('installed-intelligence:depth-dispatch-no-losses', !depthDispatch || depthDispatch.losses === 0, `${depthDispatch?.losses ?? 'unavailable'} dispatch losses vs codebase-memory`),
    gate('installed-intelligence:depth-contract-drift-no-losses', !depthContractDrift || depthContractDrift.losses === 0, `${depthContractDrift?.losses ?? 'unavailable'} contract-drift losses vs codebase-memory`),
    gate('installed-intelligence:depth-behavioral-diff-no-losses', !depthBehavioralDiff || depthBehavioralDiff.losses === 0, `${depthBehavioralDiff?.losses ?? 'unavailable'} behavioral-diff losses vs codebase-memory`),
    gate('installed-intelligence:telemetry-overlay-no-losses', telemetryOverlay.losses === 0, `${telemetryOverlay.losses} telemetry overlay losses`),
    gate('installed-intelligence:workspace-emits-cross-repo-facts', workspaceEmitted >= 6, `${workspaceEmitted}/${campWASReport.dimensions.length} WAS dimensions emitted`),
    gate('installed-intelligence:camp-c-full-never-loses', campCFullReport.aggregate.headToHead.allWin === true, `${campCHeadToHead.length} Camp C head-to-head dimensions`),
  ];

  const passed = gates.filter(item => item.status === 'pass').length;
  const report: InstalledIntelligenceGauntletReport = {
    generated_at: generatedAt,
    benchmark_type: 'installed-intelligence-gauntlet',
    status: gates.some(item => item.status === 'fail') ? 'fail' : gates.some(item => item.status === 'warn') ? 'warn' : 'pass',
    score: Math.round((passed / Math.max(1, gates.length)) * 100),
    summary: {
      claim_limit: 'Combines true live agent A/B results against installed codebase-memory context with language/framework/depth/WAS intelligence gauntlets. Live edits run only in copied workspaces. Structural/depth/WAS results are analyzer-intelligence comparisons, not autonomous coding tasks.',
      live_agent_trials: Number(liveSummary.total_live_trials || 0),
      live_agent_quality_delta: nullableNumber(liveSummary.average_quality_delta),
      live_agent_token_reduction_percentage: nullableNumber(liveSummary.average_token_reduction_percentage),
      live_agent_time_reduction_percentage: nullableNumber(liveSummary.average_time_reduction_percentage),
      structural_languages_measured: nullableNumber(campBStructural?.languages),
      structural_losses_vs_codebase_memory: nullableNumber(campBStructural?.losses),
      camp_c_head_to_head_dimensions: campCHeadToHead.length,
      workspace_dimensions: campWASReport.dimensions.length,
      workspace_dimensions_emitted: workspaceEmitted,
    },
    gates,
    live_agent: summarizeLiveReport(liveReport),
    language_and_depth: {
      breadth_supported_languages: camps.breadth.supportedLanguageCount,
      camp_b_structural_vs_codebase_memory: campBStructural,
      camp_c_routes_vs_codebase_memory: campCRoutes,
      camp_c_full: campCFullReport.aggregate,
      depth_taint_vs_codebase_memory: depthTaint,
      depth_dispatch_vs_codebase_memory: depthDispatch,
      depth_contract_drift_vs_codebase_memory: depthContractDrift,
      depth_behavioral_diff_vs_codebase_memory: depthBehavioralDiff,
      telemetry_overlay_vs_codebase_memory: telemetryOverlay,
    },
    workspace_analysis: {
      repos: campWASReport.repos,
      aggregate: campWASReport.aggregate,
      dimensions: campWASReport.dimensions.map((dimension: any) => ({
        group: dimension.group,
        key: dimension.key,
        label: dimension.label,
        emitted: dimension.emitted,
        examples: dimension.examples,
      })),
    },
  };

  await fs.ensureDir(path.dirname(args.outputPath));
  await fs.writeJson(args.outputPath, report, { spaces: 2 });
  await fs.ensureDir(path.dirname(args.markdownPath));
  await fs.writeFile(args.markdownPath, renderMarkdown(report), 'utf8');
  return report;
}

function summarizeLiveReport(liveReport: any): unknown {
  if (!liveReport) return { available: false };
  const competitor = liveReport.competitors?.[0];
  return {
    available: true,
    benchmark_type: liveReport.benchmark_type,
    status: liveReport.status,
    summary: liveReport.summary,
    competitor: competitor ? {
      id: competitor.id,
      label: competitor.label,
      status: competitor.status,
      summary: competitor.summary,
      scenarios: (competitor.scenarios || []).map((scenario: any) => ({
        id: scenario.id,
        family: scenario.family,
        status: scenario.status,
        quality_delta: scenario.quality_delta,
        token_reduction_percentage: scenario.token_reduction_percentage,
        time_reduction_percentage: scenario.time_reduction_percentage,
        with_klauro_quality_score: scenario.with_klauro_quality_score,
        competitor_quality_score: scenario.competitor_quality_score,
      })),
    } : null,
  };
}

function renderMarkdown(report: InstalledIntelligenceGauntletReport): string {
  const lines = [
    '# Klauro Installed Intelligence Gauntlet',
    '',
    `Generated: ${report.generated_at}`,
    `Status: **${report.status.toUpperCase()}** (${report.score}/100)`,
    '',
    report.summary.claim_limit,
    '',
    '## Summary',
    '',
    `- Live agent trials: ${report.summary.live_agent_trials}.`,
    `- Live quality delta: ${signed(report.summary.live_agent_quality_delta)}.`,
    `- Live token reduction: ${signed(report.summary.live_agent_token_reduction_percentage)}%.`,
    `- Live speed improvement: ${signed(report.summary.live_agent_time_reduction_percentage)}%.`,
    `- Structural languages measured vs codebase-memory: ${report.summary.structural_languages_measured ?? 'n/a'}.`,
    `- Structural losses vs codebase-memory: ${report.summary.structural_losses_vs_codebase_memory ?? 'n/a'}.`,
    `- Camp C head-to-head dimensions: ${report.summary.camp_c_head_to_head_dimensions}.`,
    `- WAS dimensions emitted: ${report.summary.workspace_dimensions_emitted}/${report.summary.workspace_dimensions}.`,
    '',
    '## Gates',
    '',
    ...report.gates.map(item => `- ${item.status.toUpperCase()} ${item.id}: ${item.detail}`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

async function readOptionalJson(file: string): Promise<any | undefined> {
  try {
    return await fs.readJson(file);
  } catch {
    return undefined;
  }
}

function gate(id: string, ok: boolean, detail: string): Gate {
  return { id, status: ok ? 'pass' : 'fail', detail };
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function numberOrNegInf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function signed(value: number | null): string {
  if (value === null) return 'n/a';
  return value >= 0 ? `+${value}` : String(value);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    liveReportPath: path.resolve('.klauro-true-competitor-benchmark/all-seeded-families-codex-vs-codebase-memory.json'),
    outputPath: path.resolve('.klauro-installed-intelligence-gauntlet/latest-report.json'),
    markdownPath: path.resolve('.klauro-installed-intelligence-gauntlet/latest-report.md'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--live-report') args.liveReportPath = path.resolve(argv[++index]);
    else if (arg === '--output') args.outputPath = path.resolve(argv[++index]);
    else if (arg === '--markdown') args.markdownPath = path.resolve(argv[++index]);
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: npm run installed-intelligence-gauntlet -- [--live-report report.json] [--output report.json] [--markdown report.md]');
      process.exit(0);
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option ${arg}`);
    }
  }
  return args;
}

if (isDirectCliInvocation('installed-intelligence-gauntlet')) {
  buildInstalledIntelligenceGauntlet(parseArgs(process.argv.slice(2))).then(report => {
    console.log(JSON.stringify(report, null, 2));
    if (report.status === 'fail') process.exitCode = 1;
  }).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
