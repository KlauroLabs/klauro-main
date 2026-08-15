














































export interface ScaleGateBudgets {

  maxWallMs: number;

  maxPeakRssMb: number;




  minNodes: number;



















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


























export const DEFAULT_SCALE_GATE_BUDGETS: ScaleGateBudgets = {
  maxWallMs: 10 * 60_000,
  maxPeakRssMb: 4500,
  minNodes: 1000,
  maxDeterministicReadyMs: 90_000,
};
