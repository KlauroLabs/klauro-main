/**
 * PERIODIC scale-survivability gate (production readiness item #4).
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT PART OF DEPLOY SMOKE:
 * The deploy smoke (infrastructure/vps/analysis-smoke.mjs) deliberately
 * analyzes a tiny fixture so every deploy stays fast — that trade is correct
 * and this gate does not change it. But a tiny fixture never exercises the
 * recursive/whole-graph passes or the memory-heavy phases (full-source
 * preload, whole-CAS retention across 25-38 concurrent analyzers) that only
 * show up at real-repo scale. A 3,856-file repository once crashed outright
 * with `RangeError: Maximum call stack size exceeded` (edges.push(...deduped)
 * past the engine's per-call argument limit) and NO gate caught it, because
 * no gate ever analyzed anything that big. graph-scale-limits.test.ts now
 * catches a reintroduction of that specific bug by building an oversized
 * graph directly (fast, no repo parse) — but it cannot catch a NEW unbounded
 * spread in an untested pass, a memory-pressure failure, or a latency
 * regression, because it never runs the real pipeline against real files.
 * This gate is the periodic tier that does: scheduled (not per-deploy),
 * against real repositories of ordinary size (several thousand files, mixed
 * languages), asserting completion + sane counts + a latency budget + a
 * memory budget.
 *
 * BLACKBOX DOCTRINE: the completion/count/latency assertions below drive the
 * analysis ONLY through the `klauro` CLI (a real customer-path client) —
 * never by importing the analyzer engine. The memory-budget assertion is the
 * one deliberate exception: peak RSS is not something the customer-facing
 * API exposes, so it is sampled operationally (container memory, via the
 * VPS SSH credentials this gate's runner script already has) alongside the
 * blackbox trigger, not in place of it. See runScaleSurvivabilityGate below.
 *
 * RED MEANS SOMEONE ACTS (checked BEFORE building, per standing doctrine):
 *   Owner: whoever holds the production-survivability rotation for Klauro
 *   (the same rotation this task — #104 + the memory-ceiling defect — was
 *   filed under). Failure surface: the runner script
 *   (apps/mcp-server/scripts/scale-survivability-gate.sh) exits non-zero on
 *   ANY budget miss and appends a FAILING row to
 *   docs/mcp/SCALE-SURVIVABILITY-LOG.md (mirrors nightly-eval's SCORECARD.md
 *   trend pattern); the VPS-side systemd timer
 *   (infrastructure/vps/klauro-scale-gate.timer, prepared but NOT installed
 *   by this change — see its header) runs it weekly and a non-zero exit
 *   triggers systemd's OnFailure= unit, which is wired to the SAME alert
 *   path production incidents already use. A red run is therefore never a
 *   number nobody reads: it either blocks the rotation's next action item or
 *   pages on-call, the same two outcomes every other gate in this codebase
 *   produces.
 */

export interface ScaleGateBudgets {
  /** Wall-clock ceiling for the whole analysis, in milliseconds. */
  maxWallMs: number;
  /** Peak container/worker RSS ceiling, in megabytes. */
  maxPeakRssMb: number;
  /** A completed analysis with fewer nodes than this is treated as a
   *  silent-truncation failure, not a pass — mirrors the "completeness is
   *  never met by delivering an incomplete analysis" doctrine: an analysis
   *  that finishes fast by producing too little is not a pass either. */
  minNodes: number;
  /**
   * task #118 (latency PREDICTABILITY, not just latency): ceiling, in
   * milliseconds, on how long the DETERMINISTIC layers (L0-L4 — index,
   * nodes/routes, call graph, entities, flows/capabilities; see
   * layered-analysis.ts) take to become ready, measured from analysis
   * accept to the L4 layer's completed_at on the analysis-status endpoint.
   * This is deliberately a MUCH tighter budget than maxWallMs: deterministic
   * work is CPU/memory-bound and now runs on its own lane pool
   * (deterministicLanePool in analyzer.ts), fully decoupled from the
   * AI-enrichment pool (aiEnrichmentLanePool) — so it must never inherit
   * the unpredictable duration of another project's AI tail. maxWallMs alone
   * cannot catch a queueing regression that reintroduces that coupling: a
   * run can finish inside a generous overall budget while still having
   * spent most of it queued behind someone else's AI call before its own
   * deterministic work even started (exactly the measured production
   * symptom this task exists to fix). Optional so existing callers/budgets
   * that don't sample it (peakRssMb-style "not sampled" is a pass, not a
   * fail) keep working; omit to skip this check entirely.
   */
  maxDeterministicReadyMs?: number;
}

export interface ScaleGateObservation {
  repoLabel: string;
  sourceFiles: number;
  exitCode: number | null;
  timedOut: boolean;
  wallMs: number;
  peakRssMb: number | null;
  nodes: number | null;
  edges: number | null;
  stderrTail: string;
  /** task #118: milliseconds from analysis accept to the L4 (last
   *  deterministic) layer's completed_at, sampled from the analysis-status
   *  endpoint alongside the blackbox trigger (same operational-sampling
   *  exception as peakRssMb — see the module doc above). `null` means "not
   *  sampled", which — like peakRssMb — is never treated as a failure on
   *  its own; only evaluated when maxDeterministicReadyMs is set. */
  deterministicReadyMs: number | null;
}

export type ScaleGateFindingReason =
  | 'process-failed'
  | 'timed-out'
  | 'over-latency-budget'
  | 'over-memory-budget'
  | 'node-count-too-low'
  | 'no-count-reported'
  | 'over-deterministic-latency-budget';

export interface ScaleGateFinding {
  status: 'pass' | 'fail';
  reasons: ScaleGateFindingReason[];
  detail: string;
}

/**
 * Pure evaluation of one observation against budgets — kept separate from
 * the CLI-spawning/SSH-sampling runner below so the pass/fail LOGIC has a
 * fast, deterministic unit test that runs in every normal CI pass, even
 * though the full live gate (which actually spawns `klauro analyze` against
 * a multi-thousand-file repo and samples a remote container's RSS) is a
 * separate, scheduled, non-CI concern.
 */
export function evaluateScaleGateObservation(
  observation: ScaleGateObservation,
  budgets: ScaleGateBudgets,
): ScaleGateFinding {
  const reasons: ScaleGateFindingReason[] = [];

  if (observation.timedOut) reasons.push('timed-out');
  if (!observation.timedOut && observation.exitCode !== 0) reasons.push('process-failed');
  if (observation.wallMs > budgets.maxWallMs) reasons.push('over-latency-budget');
  if (observation.peakRssMb !== null && observation.peakRssMb > budgets.maxPeakRssMb) {
    reasons.push('over-memory-budget');
  }
  if (observation.nodes === null || observation.edges === null) {
    reasons.push('no-count-reported');
  } else if (observation.nodes < budgets.minNodes) {
    reasons.push('node-count-too-low');
  }
  if (
    budgets.maxDeterministicReadyMs !== undefined &&
    observation.deterministicReadyMs !== null &&
    observation.deterministicReadyMs > budgets.maxDeterministicReadyMs
  ) {
    reasons.push('over-deterministic-latency-budget');
  }

  if (reasons.length === 0) {
    return {
      status: 'pass',
      reasons: [],
      detail: `${observation.repoLabel}: ${observation.nodes} nodes / ${observation.edges} edges in ` +
        `${(observation.wallMs / 1000).toFixed(1)}s (deterministic layers ready in ` +
        `${observation.deterministicReadyMs === null ? 'not sampled' : `${(observation.deterministicReadyMs / 1000).toFixed(1)}s`}), ` +
        `peak RSS ${observation.peakRssMb === null ? 'not sampled' : `${observation.peakRssMb}MB`} — within budget.`,
    };
  }

  return {
    status: 'fail',
    reasons,
    detail: `${observation.repoLabel}: FAILED (${reasons.join(', ')}). ` +
      `wallMs=${observation.wallMs}/${budgets.maxWallMs}, ` +
      `deterministicReadyMs=${observation.deterministicReadyMs ?? 'n/a'}/${budgets.maxDeterministicReadyMs ?? 'n/a'}, ` +
      `peakRssMb=${observation.peakRssMb ?? 'n/a'}/${budgets.maxPeakRssMb}, ` +
      `nodes=${observation.nodes ?? 'n/a'} (min ${budgets.minNodes}), ` +
      `exitCode=${observation.exitCode}, timedOut=${observation.timedOut}. ` +
      `stderr tail: ${observation.stderrTail.slice(-500)}`,
  };
}

/**
 * Default budgets for the "ordinary size" tier this gate targets — several
 * thousand files, mixed languages. Sourced from the Aug 2026 production
 * peak-RSS probes (see infrastructure/vps/docker-compose.yml's mem_limit
 * comment): observed 1.5-2.4GB peak RSS across 775-3355 source files on this
 * host's 4096MB worker heap cap; maxPeakRssMb leaves margin above the
 * extrapolated ~3-3.5GB whale case and BELOW the container's 6144MB cap, so
 * a gate failure fires before the container-level cgroup OOM would.
 * maxWallMs mirrors the measured ~160-180s full-analysis time at this scale
 * with real headroom for host contention from a peer analysis (this box
 * runs at most one full analysis worker at a time — see
 * deriveAnalysisLaneCountFromHost in analyzer.ts).
 *
 * maxDeterministicReadyMs (task #118): 90s. Deliberately far tighter than
 * maxWallMs. Deterministic work at THIS gate's scale (several thousand
 * files) was directly measured at low-single-digit seconds of actual phase
 * work (KLAURO_DEBUG_ANALYZER_PHASES phase log, a 94-file/132-file repo:
 * ~1.5s of summed pp_-prefixed and language_-prefixed phases); 90s leaves generous headroom for
 * legitimate deterministic cost at this gate's larger scale while still
 * being an order of magnitude under maxWallMs — tight enough that a
 * regression which re-couples the deterministic and AI-enrichment lane
 * pools (making deterministic work wait behind another project's AI tail,
 * the exact production symptom measured for task #118) trips this budget
 * long before it would ever threaten maxWallMs.
 */
export const DEFAULT_SCALE_GATE_BUDGETS: ScaleGateBudgets = {
  maxWallMs: 10 * 60_000, // 10 minutes
  maxPeakRssMb: 4500,
  minNodes: 1000,
  maxDeterministicReadyMs: 90_000,
};
