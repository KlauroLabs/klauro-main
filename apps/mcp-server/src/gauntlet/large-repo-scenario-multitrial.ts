/**
 * #96 MULTI-TRIAL wrapper around large-repo-scenario.ts / autonomous-mcp-trial.ts /
 * deepinfra-agent.ts.
 *
 * WHY THIS EXISTS: a single-trial #96 run is not credible evidence. Across 3
 * back-to-back single-trial runs on this exact scenario, the Klauro arm's
 * task_success flipped TRUE -> FALSE while its own token usage stayed in a
 * tight band (207k-212k), and the BASELINE arm's tokens swung wildly on an
 * IDENTICAL setup (857 / 34,658 / 4,027). That is model non-determinism
 * (Llama-3.3-70B-Instruct-Turbo via DeepInfra), not signal. A single trial
 * cannot distinguish "Klauro helped" from "the model got a lucky/unlucky
 * rollout." This file runs N trials per arm and reports a DISTRIBUTION
 * (success rate, median + p25/p75 tokens, median quality, median duration)
 * instead of a single noisy number.
 *
 * This file does NOT modify large-repo-scenario.ts, autonomous-mcp-trial.ts,
 * or deepinfra-agent.ts — it composes their exported functions.
 *
 * CLI:
 *   tsx src/gauntlet/large-repo-scenario-multitrial.ts [--trials N] [--projected]
 *       [--max-iters N] [--model id] [--out dir]
 *
 * Without DEEPINFRA_API_KEY (checked in process.env AND in the repo-root
 * `.env`, since `.env` is not auto-loaded into the shell — see
 * large-repo-scenario.ts) this auto-falls-back to PROJECTED mode: it runs the
 * full harness wiring (materialize, task construction) with a FAKE runner
 * that produces a synthetic-but-labeled-as-projected distribution, so the
 * multi-trial code path and report shape are exercised with NO live LLM
 * calls and NO network, and the test suite can assert on it offline.
 */
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import {
  materializeLargeRepoTask,
  largeRepoTask,
  createDeepInfraDirectRunner,
  LARGE_REPO_SOURCE,
  LARGE_REPO_TIMEOUT_MS,
  LARGE_REPO_MAX_ITERS,
} from './large-repo-scenario';
import {
  runAutonomousMcpTrial,
  resolveDeployedAnalyzer,
  type AutonomousArmId,
  type AutonomousMcpTrialResult,
  type AgentRunner,
} from './autonomous-mcp-trial';

// ---------------------------------------------------------------------------
// .env fallback (repo root `.env` is not auto-loaded into the shell — same
// caveat large-repo-scenario.ts documents). Only used to DETECT the key for
// the live/projected decision; never overwrites an already-set env var.
// ---------------------------------------------------------------------------

function loadDotEnvKey(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  const candidates = [
    path.resolve(__dirname, '..', '..', '..', '..', '.env'),
    path.resolve(__dirname, '..', '..', '..', '.env'),
    path.resolve(process.cwd(), '.env'),
  ];
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const raw = fs.readFileSync(candidate, 'utf8');
      for (const line of raw.split('\n')) {
        const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
        if (match && match[1] === key) {
          const value = match[2].replace(/^["']|["']$/g, '');
          if (value) return value;
        }
      }
    } catch {
      // ignore unreadable .env candidates
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Stats helpers — small, dependency-free, honest (no interpolation tricks).
// ---------------------------------------------------------------------------

function sorted(nums: number[]): number[] {
  return [...nums].sort((a, b) => a - b);
}

/** Nearest-rank percentile (simple, no interpolation) — fine for N in the 3-20 range. */
function percentile(nums: number[], p: number): number {
  if (nums.length === 0) return 0;
  const xs = sorted(nums);
  const rank = Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1));
  return xs[rank];
}

function median(nums: number[]): number {
  return percentile(nums, 50);
}

export interface ArmDistribution {
  arm_id: AutonomousArmId;
  n: number;
  successes: number;
  success_rate: number;
  quality_median: number;
  quality_p25: number;
  quality_p75: number;
  tokens_median: number;
  tokens_p25: number;
  tokens_p75: number;
  duration_ms_median: number;
  klauro_tool_calls_median: number;
  errors: number;
  raw: AutonomousMcpTrialResult['autonomous_klauro'][];
}

export interface MultiTrialReport {
  mode: 'live' | 'projected';
  reason?: string;
  trials_requested: number;
  trials_completed: number;
  trials_capped?: boolean;
  cap_reason?: string;
  temperature: number | 'unsupported';
  model: string;
  repo_source: string;
  server_url: string;
  klauro: ArmDistribution;
  baseline: ArmDistribution;
  deltas: {
    success_rate_delta: number;
    tokens_median_multiple: number | null;
    quality_median_delta: number;
    duration_median_delta_ms: number;
  };
  trial_results: AutonomousMcpTrialResult[];
  report_file: string;
}

function summarizeArm(
  armId: AutonomousArmId,
  measurements: AutonomousMcpTrialResult['autonomous_klauro'][]
): ArmDistribution {
  const n = measurements.length;
  const successes = measurements.filter((m) => m.task_success === true).length;
  const qualities = measurements.map((m) => m.quality);
  const tokens = measurements.map((m) => m.tokens).filter((t) => Number.isFinite(t) && t < Number.MAX_SAFE_INTEGER);
  const durations = measurements.map((m) => m.duration_ms);
  const toolCalls = measurements.map((m) => m.klauro_tool_calls);
  const errors = measurements.filter((m) => !!m.error).length;
  return {
    arm_id: armId,
    n,
    successes,
    success_rate: n > 0 ? Math.round((successes / n) * 1000) / 1000 : 0,
    quality_median: median(qualities),
    quality_p25: percentile(qualities, 25),
    quality_p75: percentile(qualities, 75),
    tokens_median: median(tokens),
    tokens_p25: percentile(tokens, 25),
    tokens_p75: percentile(tokens, 75),
    duration_ms_median: median(durations),
    klauro_tool_calls_median: median(toolCalls),
    errors,
    raw: measurements,
  };
}

// ---------------------------------------------------------------------------
// Projected-mode synthetic runner. Deterministic (seeded by trial index) and
// clearly out-of-band from real token magnitudes so it can never be mistaken
// for a live result — the report's `mode: 'projected'` field is authoritative.
// ---------------------------------------------------------------------------

function createProjectedRunner(): AgentRunner {
  let call = 0;
  return async (context) => {
    call++;
    const isKlauro = context.arm === 'autonomous-klauro';
    return {
      command_passed: true,
      task_success: true,
      self_reported_quality: isKlauro ? 8 : 6,
      files_changed: 1,
      files_read: isKlauro ? 3 : 6,
      klauro_tool_calls: isKlauro ? 4 : 0,
      provider_total_tokens: isKlauro ? 1000 + call * 7 : 1400 + call * 11,
      duration_ms: 100 + call,
      stdout_tail: `[projected] arm=${context.arm} call=${call}`,
    };
  };
}

// ---------------------------------------------------------------------------
// Orchestration.
// ---------------------------------------------------------------------------

export interface RunMultiTrialOptions {
  trials?: number;
  forceProjected?: boolean;
  model?: string;
  maxIters?: number;
  /** Temperature to request from the model (default 0 for determinism). */
  temperature?: number;
  keepWorkspaces?: boolean;
  outDir?: string;
  /** Hard cap on trials actually executed live, independent of `trials` (cost/time guard). */
  maxLiveTrials?: number;
}

const DEFAULT_TRIALS = 5;
/** Hard safety cap regardless of what the caller asks for — live LLM calls cost money/time. */
const HARD_TRIAL_CAP = 10;

export async function runLargeRepoMultiTrial(opts?: RunMultiTrialOptions): Promise<MultiTrialReport> {
  const trialsRequested = Math.max(1, opts?.trials ?? DEFAULT_TRIALS);
  const apiKey = loadDotEnvKey('DEEPINFRA_API_KEY');
  const hasKey = !!apiKey;
  const forceProjected = !!opts?.forceProjected;
  const model = opts?.model || process.env.DEEPINFRA_AGENT_MODEL || 'meta-llama/Llama-3.3-70B-Instruct-Turbo';
  const maxIters = opts?.maxIters ?? LARGE_REPO_MAX_ITERS;
  const temperature = opts?.temperature ?? 0;

  // Pass the resolved key through to the child process env for the live runner,
  // since we only found it via .env, not the ambient shell.
  if (apiKey && !process.env.DEEPINFRA_API_KEY) process.env.DEEPINFRA_API_KEY = apiKey;

  const serverUrl = resolveDeployedAnalyzer().serverUrl;
  const outDir = opts?.outDir || path.join(os.tmpdir(), 'klauro-large-repo-multitrial');
  await fs.ensureDir(outDir);

  let trialsCapped = false;
  let capReason: string | undefined;
  let effectiveTrials = trialsRequested;
  if (hasKey && !forceProjected && effectiveTrials > HARD_TRIAL_CAP) {
    trialsCapped = true;
    capReason = `requested ${effectiveTrials} live trials, capped to ${HARD_TRIAL_CAP} (cost/time guard)`;
    effectiveTrials = HARD_TRIAL_CAP;
  }
  if (hasKey && !forceProjected && opts?.maxLiveTrials && effectiveTrials > opts.maxLiveTrials) {
    trialsCapped = true;
    capReason = `capped to --max-live-trials=${opts.maxLiveTrials}`;
    effectiveTrials = opts.maxLiveTrials;
  }

  const mode: 'live' | 'projected' = hasKey && !forceProjected ? 'live' : 'projected';
  const reason = mode === 'projected'
    ? (forceProjected
        ? 'forced by caller'
        : 'DEEPINFRA_API_KEY not found in process.env or .env — no live LLM calls were made.')
    : undefined;

  const runner: AgentRunner | undefined = mode === 'projected'
    ? createProjectedRunner()
    : createDeepInfraDirectRunner({ model, maxIters });

  // temperature pass-through: deepinfra-agent.ts's runAgentLoop hardcodes
  // temperature: 0.2 in its chat request and does not expose a pass-through
  // option. We do NOT modify deepinfra-agent.ts (out of scope / owned by
  // another surface of this same task, and the instruction says without
  // changing default behavior). Recorded honestly below instead of silently
  // claiming determinism we can't deliver.
  const temperatureApplied: number | 'unsupported' = mode === 'live' ? 'unsupported' : temperature;

  const materialized = await materializeLargeRepoTask();

  const trialResults: AutonomousMcpTrialResult[] = [];
  for (let i = 0; i < effectiveTrials; i++) {
    const task = largeRepoTask(materialized);
    const result = await runAutonomousMcpTrial({
      task: { ...task, taskId: `${task.taskId}-trial-${i + 1}` },
      agentRunner: runner,
      timeoutMs: LARGE_REPO_TIMEOUT_MS,
      keepWorkspaces: opts?.keepWorkspaces ?? false,
      workRoot: path.join(outDir, 'trials'),
    });
    trialResults.push(result);
  }

  await fs.remove(materialized).catch(() => undefined);

  const klauroMeasurements = trialResults.map((r) => r.autonomous_klauro);
  const baselineMeasurements = trialResults.map((r) => r.baseline);
  const klauro = summarizeArm('autonomous-klauro', klauroMeasurements);
  const baseline = summarizeArm('baseline', baselineMeasurements);

  const tokensMedianMultiple =
    baseline.tokens_median > 0 ? Math.round((klauro.tokens_median / baseline.tokens_median) * 100) / 100 : null;

  const reportFile = path.join(outDir, `report-${Date.now()}.json`);
  const report: MultiTrialReport = {
    mode,
    reason,
    trials_requested: trialsRequested,
    trials_completed: trialResults.length,
    trials_capped: trialsCapped || undefined,
    cap_reason: capReason,
    temperature: temperatureApplied,
    model,
    repo_source: LARGE_REPO_SOURCE,
    server_url: serverUrl,
    klauro,
    baseline,
    deltas: {
      success_rate_delta: Math.round((klauro.success_rate - baseline.success_rate) * 1000) / 1000,
      tokens_median_multiple: tokensMedianMultiple,
      quality_median_delta: klauro.quality_median - baseline.quality_median,
      duration_median_delta_ms: baseline.duration_ms_median - klauro.duration_ms_median,
    },
    trial_results: trialResults,
    report_file: reportFile,
  };

  await fs.writeJson(reportFile, report, { spaces: 2 });
  return report;
}

// ---------------------------------------------------------------------------
// Reporting / CLI.
// ---------------------------------------------------------------------------

function fmtDist(d: ArmDistribution): string {
  return [
    `  ${d.arm_id}: success ${d.successes}/${d.n} (${(d.success_rate * 100).toFixed(0)}%)`,
    `    quality median=${d.quality_median} [p25=${d.quality_p25} p75=${d.quality_p75}]`,
    `    tokens  median=${d.tokens_median} [p25=${d.tokens_p25} p75=${d.tokens_p75}]`,
    `    duration median=${d.duration_ms_median}ms, klauro_tool_calls median=${d.klauro_tool_calls_median}, errors=${d.errors}`,
  ].join('\n');
}

function printReport(report: MultiTrialReport): void {
  console.log(`Mode: ${report.mode.toUpperCase()}${report.reason ? ` (${report.reason})` : ''}`);
  console.log(`Model: ${report.model}, temperature requested=${report.temperature}`);
  console.log(`Trials: requested=${report.trials_requested}, completed=${report.trials_completed}${report.trials_capped ? ` (CAPPED: ${report.cap_reason})` : ''}`);
  console.log(`Deployed analyzer: ${report.server_url}`);
  console.log('');
  console.log('DISTRIBUTION (per-arm, N trials):');
  console.log(fmtDist(report.klauro));
  console.log(fmtDist(report.baseline));
  console.log('');
  console.log('DELTAS (Klauro vs baseline, on medians/rates):');
  console.log(`  success-rate delta: ${(report.deltas.success_rate_delta * 100).toFixed(0)}pp`);
  console.log(`  quality median delta: ${report.deltas.quality_median_delta >= 0 ? '+' : ''}${report.deltas.quality_median_delta}`);
  console.log(
    `  tokens median multiple (klauro/baseline): ${report.deltas.tokens_median_multiple === null ? 'n/a' : `${report.deltas.tokens_median_multiple}x`}`
  );
  console.log(`  duration median delta: ${report.deltas.duration_median_delta_ms}ms`);
  console.log('');
  console.log(`Raw per-trial results persisted to: ${report.report_file}`);
}

function parseCliArgs(argv: string[]) {
  const out: { trials?: number; forceProjected?: boolean; maxIters?: number; model?: string; outDir?: string; maxLiveTrials?: number } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--trials') out.trials = Number(argv[++i]);
    else if (arg === '--projected') out.forceProjected = true;
    else if (arg === '--max-iters') out.maxIters = Number(argv[++i]);
    else if (arg === '--model') out.model = argv[++i];
    else if (arg === '--out') out.outDir = argv[++i];
    else if (arg === '--max-live-trials') out.maxLiveTrials = Number(argv[++i]);
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const envTrials = process.env.LARGE_REPO_TRIALS ? Number(process.env.LARGE_REPO_TRIALS) : undefined;
  const report = await runLargeRepoMultiTrial({
    trials: args.trials ?? envTrials,
    forceProjected: args.forceProjected,
    maxIters: args.maxIters,
    model: args.model,
    outDir: args.outDir,
    maxLiveTrials: args.maxLiveTrials,
  });
  printReport(report);
}

const invokedName = process.argv[1]
  ? path.basename(process.argv[1]).replace(/\.(mts|cts|tsx|ts|mjs|cjs|jsx|js)$/, '')
  : '';
if (invokedName === 'large-repo-scenario-multitrial') {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
