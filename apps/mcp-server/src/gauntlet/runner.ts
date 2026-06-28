/**
 * Gauntlet runner — orchestrates SCENARIOS x ARMS into one GauntletReport.
 *
 * Modes:
 *  - projected (default): fast, populates the whole matrix from the grounded
 *    projection model so the UI and win-validator have real structure to work
 *    with. Every projected number is flagged so it is never mistaken for a
 *    measurement.
 *  - engine: the analysis-readiness scenario is measured directly from the
 *    stored analysis (no agent, no projection) — real numbers today.
 *  - live (--live): replaces projected agent scenarios with real agent runs via
 *    agent-live-trial's runLiveAgentPair. Wired as the escalation path; this is
 *    what actually *proves* "Klauro always wins".
 *
 * The runner streams progress (onProgress) so the UI can show scenarios moving
 * pending -> running -> done in real time, and writes the report to
 * ~/.klauro/gauntlet/latest.json (+ a timestamped copy) after every update.
 */

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { listAnalyses, type AnalysisEntry } from '../storage';
import { getAnalysis } from '../analyzer';
import { evaluateAgentReadiness } from '../agent-adoption';
import {
  ARMS,
  SCENARIOS,
  armsForScenario,
  type ArmResult,
  type GauntletReport,
  type ScenarioResult,
  type ScenarioSpec,
} from './report-schema';
import { validateWin, summarize } from './win-validator';
import { projectArm, type RepoFact } from './projection-model';
import { discoverCorpus, type Corpus, type WorkspaceFact } from './corpus';
import type { ArmMetrics } from './report-schema';
import { resolveLiveCommands, liveAvailable, runLiveScenario, liveTargetFor, type LiveCommandConfig, type LiveTarget } from './live-driver';
import { listUserScenarios } from './proposals';

export interface RunOptions {
  /** Run real agents for agent scenarios. Costly; the only true proof. */
  live?: boolean;
  /** Limit how many discovered repos feed the projections. */
  maxRepos?: number;
  /** Only run scenarios whose id is in this set. */
  scenarioIds?: string[];
  /** Live agent command templates (else read from env). */
  liveCommands?: LiveCommandConfig;
  /** Target a specific repo for live runs (by analysis name). */
  targetRepo?: string;
  /** Target a specific workspace for live runs (by name). */
  targetWorkspace?: string;
  /** Called after every scenario state change, for the UI. */
  onProgress?: (report: GauntletReport) => void;
}

export function gauntletHomeDir(): string {
  return path.join(os.homedir(), '.klauro', 'gauntlet');
}

/** Mean of a set of ArmMetrics (used to aggregate per-workspace projections). */
function meanMetrics(list: ArmMetrics[]): ArmMetrics | undefined {
  const valid = list.filter(Boolean);
  if (!valid.length) return undefined;
  const avg = (get: (m: ArmMetrics) => number | undefined) => {
    const xs = valid.map(get).filter((x): x is number => typeof x === 'number');
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined;
  };
  return {
    quality: round(avg(m => m.quality)),
    tokens: round(avg(m => m.tokens)),
    time_ms: round(avg(m => m.time_ms)),
    token_source: 'estimated-work',
  };
}

function round(v?: number): number | undefined {
  return typeof v === 'number' ? Math.round(v) : undefined;
}

function newReport(runId: string, scenarioSpecs: ScenarioSpec[], mode: GauntletReport['mode']): GauntletReport {
  const scenarios: ScenarioResult[] = scenarioSpecs.map(s => ({
    scenario_id: s.id,
    label: s.label,
    group: s.group,
    status: 'pending',
    execution: s.execution,
    arms: [],
  }));
  return {
    schema_version: 1,
    run_id: runId,
    generated_at: new Date().toISOString(),
    mode,
    status: 'running',
    progress: { total_scenarios: scenarios.length, completed: 0, running: 0, pending: scenarios.length, errored: 0 },
    arms: ARMS,
    scenarios,
    summary: { klauro_wins_all: false, scenarios_won: 0, scenarios_lost: 0, losses: [] },
  };
}

function recomputeProgress(report: GauntletReport): void {
  const p = report.progress;
  p.completed = report.scenarios.filter(s => s.status === 'done').length;
  p.running = report.scenarios.filter(s => s.status === 'running').length;
  p.pending = report.scenarios.filter(s => s.status === 'pending').length;
  p.errored = report.scenarios.filter(s => s.status === 'error').length;
  report.summary = summarize(report.scenarios);
  report.status = p.pending === 0 && p.running === 0 ? 'done' : 'running';
}

async function persist(report: GauntletReport): Promise<void> {
  const dir = gauntletHomeDir();
  await fs.ensureDir(dir);
  report.generated_at = new Date().toISOString();
  await fs.writeJson(path.join(dir, 'latest.json'), report, { spaces: 2 });
  await fs.writeJson(path.join(dir, `gauntlet-${report.run_id}.json`), report, { spaces: 2 });
}

// ---------------------------------------------------------------------------
// Drivers — produce ArmResult[] for one scenario.
// ---------------------------------------------------------------------------

/** Objective readiness: measured directly from each stored analysis. */
async function driveReadiness(repos: RepoFact[]): Promise<{ arms: ArmResult[]; target: string }> {
  const entries = await listAnalyses();
  const byName = new Map(entries.map(e => [e.name, e] as const));
  const scores: number[] = [];
  let measured = 0;
  for (const repo of repos) {
    const entry = byName.get(repo.name);
    if (!entry) continue;
    try {
      const cas = await getAnalysis(entry.path);
      const readiness = evaluateAgentReadiness(cas, entry.path);
      scores.push(readiness.score);
      measured++;
    } catch {
      /* skip unreadable */
    }
  }
  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  return {
    target: `${measured} repos`,
    arms: [{
      arm_id: 'klauro',
      mode: 'engine',
      attempted: true,
      metrics: { quality: Math.round(avg), completion: Math.round(avg) },
      source: `evaluate_agent_readiness over ${measured} stored analyses`,
    }],
  };
}

/**
 * Projected agent scenario, grounded in the real corpus.
 *  - single-repo / incremental: project against a diverse sample of real repos.
 *  - workspace / cross-repo: project against each REAL workspace (summed member
 *    sizes) and average across workspaces, so the numbers reflect soon/zerac/…
 *    rather than a flat repo blob.
 */
function driveProjected(spec: ScenarioSpec, corpus: Corpus): { arms: ArmResult[]; target: string } {
  const arms = armsForScenario(spec);
  const isMulti = spec.group === 'workspace' || spec.group === 'cross-repo';

  const usableWorkspaces = corpus.workspaces.filter(w => w.repos.length >= 2);
  const target = isMulti
    ? usableWorkspaces.map(w => `${w.name} (${w.repos.length})`).join(', ') || 'no multi-repo workspaces'
    : `${corpus.repos.length}-repo sample of ${corpus.total_unique_repos}`;

  const armResults = arms.map(arm => {
    let metrics: ArmMetrics | undefined;
    let grounding: string;
    if (isMulti) {
      // One projection per workspace, averaged.
      const perWs = usableWorkspaces
        .map(w => projectArm(spec.group, arm.id, w.repos))
        .filter((m): m is ArmMetrics => !!m);
      metrics = meanMetrics(perWs);
      grounding = `${usableWorkspaces.length} real workspaces (${usableWorkspaces.map(w => w.name).join(', ')})`;
    } else {
      metrics = projectArm(spec.group, arm.id, corpus.repos);
      grounding = `${corpus.repos.length} sampled repos`;
    }
    if (!metrics) {
      return { arm_id: arm.id, mode: 'projected' as const, attempted: false, metrics: {}, note: 'No calibration for this arm in this scenario group.' };
    }
    return {
      arm_id: arm.id,
      mode: 'projected' as const,
      attempted: true,
      metrics,
      source: `projection grounded in ${grounding}; live numbers via npm run ${spec.backedBy}`,
    };
  });

  return { arms: armResults, target };
}

// ---------------------------------------------------------------------------
// Main entry.
// ---------------------------------------------------------------------------

export async function runGauntlet(opts: RunOptions = {}): Promise<GauntletReport> {
  const runId = makeRunId();
  // User-proposed scenarios run alongside the built-in catalog — proposing one
  // and then running the gauntlet actually executes it.
  const userScenarios = await listUserScenarios();
  const allScenarios: ScenarioSpec[] = [
    ...SCENARIOS,
    ...userScenarios.map(u => ({
      id: u.id, label: u.label, group: u.group, task: u.task,
      klauroEdge: u.klauroEdge, arms: u.arms, execution: 'projected' as const,
      backedBy: 'user-proposed',
    })),
  ];
  const specs = opts.scenarioIds
    ? allScenarios.filter(s => opts.scenarioIds!.includes(s.id))
    : allScenarios;
  const mode: GauntletReport['mode'] = opts.live ? 'mixed' : 'projected';
  const report = newReport(runId, specs, mode);

  const corpus = await discoverCorpus({ maxRepos: opts.maxRepos ?? 24 });
  const repos = corpus.repos;

  const liveCommands = resolveLiveCommands(opts.liveCommands);
  const canLive = opts.live === true && liveAvailable(liveCommands);
  if (opts.live && !canLive) {
    report.mode = 'projected';
  }

  // Resolve real on-disk paths for live targets (name -> path). Live runs copy
  // the repo, so a target whose path no longer exists is useless — in live mode
  // gate the map on existence so liveTargetFor never picks a ghost analysis.
  const entries = await listAnalyses();
  const pathByName = new Map<string, string>();
  for (const e of entries) {
    if (pathByName.has(e.name)) continue;
    if (canLive && !(await fs.pathExists(e.path))) continue;
    pathByName.set(e.name, e.path);
  }

  const emit = async () => {
    recomputeProgress(report);
    await persist(report);
    opts.onProgress?.(report);
  };
  await emit();

  for (const spec of specs) {
    const result = report.scenarios.find(s => s.scenario_id === spec.id)!;
    result.status = 'running';
    result.started_at = new Date().toISOString();
    await emit();

    try {
      if (spec.execution === 'engine' && spec.id === 'analysis-readiness') {
        const { arms, target } = await driveReadiness(repos);
        result.arms = arms;
        result.target = target;
      } else if (canLive && spec.execution === 'projected') {
        // Live escalation: measure klauro + no-tools with real agents, and keep
        // competitor arms projected-and-labeled (no live backend yet). Honest
        // mixed mode — measured arms say mode:'live', the rest say 'projected'.
        const projected = driveProjected(spec, corpus);
        result.target = projected.target;
        const liveTarget = explicitTarget(spec, opts, pathByName)
          || liveTargetFor(spec, corpus.repos, corpus.workspaces, pathByName);
        if (!liveTarget) {
          result.arms = projected.arms.map(a => ({ ...a, note: 'no resolvable on-disk target; projected' }));
        } else {
          const measured = await runLiveScenario(spec, liveTarget, liveCommands);
          const measuredById = new Map(measured.map(m => [m.arm_id, m] as const));
          result.target = `${liveTarget.name} (live) · ${projected.target}`;
          result.arms = projected.arms.map(p =>
            measuredById.get(p.arm_id) ?? { ...p, note: 'no live backend for this arm; projected' }
          );
        }
      } else {
        const projected = driveProjected(spec, corpus);
        result.arms = projected.arms;
        result.target = projected.target;
      }

      const klauroEdge = spec.klauroEdge;
      result.verdict = validateWin(result.arms, klauroEdge);
      result.status = 'done';
      result.finished_at = new Date().toISOString();
    } catch (err) {
      result.status = 'error';
      result.error = err instanceof Error ? err.message : String(err);
    }
    await emit();
  }

  report.status = 'done';
  await emit();
  return report;
}

/** Resolve an explicit per-entity live target from run options, when on disk. */
function explicitTarget(spec: ScenarioSpec, opts: RunOptions, pathByName: Map<string, string>): LiveTarget | null {
  const multi = spec.group === 'workspace' || spec.group === 'cross-repo';
  const name = multi ? opts.targetWorkspace : opts.targetRepo;
  if (!name) return null;
  const p = pathByName.get(name);
  return p ? { name, repoPath: p } : null;
}

function makeRunId(): string {
  // Date.now is available here (Node, not the workflow sandbox).
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 7);
  return `${ts}-${rand}`;
}
