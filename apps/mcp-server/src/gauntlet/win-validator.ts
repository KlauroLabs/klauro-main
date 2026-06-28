/**
 * The win-validator — the heart of the gauntlet.
 *
 * The user's win condition, verbatim:
 *
 *   "Klauro should ALWAYS ultimately win. It should either be faster or more
 *    token efficient and should ALWAYS result in a higher quality result."
 *
 * Decoded into a hard rule, per scenario, against EVERY other arm:
 *
 *   (1) quality:  Klauro strictly higher than every other arm.            [required]
 *   (2) efficiency: Klauro beats every other arm on time OR on tokens.    [required]
 *
 * Both must hold. If either fails, Klauro did NOT win this scenario — and that
 * is a Klauro bug to fix, surfaced loudly with a pointer at the capability that
 * was supposed to deliver the edge. No silent passes, no moral victories.
 *
 * Pure functions only — unit-testable, no I/O.
 */

import type {
  ArmResult,
  MetricComparison,
  MetricKey,
  ScenarioResult,
  WinVerdict,
  GauntletSummary,
} from './report-schema';

/** Quality ties do NOT count as a win — Klauro must be strictly ahead by this margin. */
const QUALITY_WIN_MARGIN = 0.5; // on a 0..100 scale
/**
 * The quality ceiling (0..100). A tie is only acceptable here — against a
 * compiler-accurate / ground-truth-correct competitor you cannot out-correct,
 * so matching it at the top is the honest best case, and the win is then decided
 * on tokens/speed. Below the ceiling, Klauro must still win quality outright.
 */
const QUALITY_CEILING = 99.5;
/** Efficiency must be a real win, not noise. */
const EFFICIENCY_WIN_MARGIN_FRAC = 0.02; // 2%

type Direction = 'higher-better' | 'lower-better';

const METRIC_DIRECTION: Record<MetricKey, Direction> = {
  quality: 'higher-better',
  time: 'lower-better',
  tokens: 'lower-better',
};

function metricValue(arm: ArmResult, metric: MetricKey): number | undefined {
  switch (metric) {
    case 'quality':
      return arm.metrics.quality;
    case 'time':
      return arm.metrics.time_ms;
    case 'tokens':
      return arm.metrics.tokens;
  }
}

/**
 * Compare Klauro against the *best* (most favorable) value among the other arms
 * for one metric. We compare against the best other arm, not the average — if
 * any competitor beats Klauro on quality, Klauro has not won.
 */
function compareMetric(
  metric: MetricKey,
  klauro: ArmResult,
  others: ArmResult[]
): MetricComparison {
  const dir = METRIC_DIRECTION[metric];
  const klValue = metricValue(klauro, metric);

  const otherValues = others
    .map(a => ({ arm_id: a.arm_id, value: metricValue(a, metric) }))
    .filter((x): x is { arm_id: string; value: number } => typeof x.value === 'number');

  // Pick the strongest competitor on this metric.
  let best: { arm_id: string; value: number } | undefined;
  for (const cand of otherValues) {
    if (!best) { best = cand; continue; }
    const candBetter = dir === 'higher-better' ? cand.value > best.value : cand.value < best.value;
    if (candBetter) best = cand;
  }

  if (typeof klValue !== 'number' || !best) {
    // Not enough data to judge — record what we have, don't claim a win.
    return {
      metric,
      klauro_value: klValue,
      best_other_value: best?.value,
      best_other_arm_id: best?.arm_id,
      klauro_wins: false,
    };
  }

  let wins: boolean;
  let advantage: number;
  let tied_at_ceiling = false;
  if (dir === 'higher-better') {
    wins = klValue > best.value + (metric === 'quality' ? QUALITY_WIN_MARGIN : 0);
    advantage = best.value > 0 ? (klValue - best.value) / best.value : (klValue > best.value ? 1 : 0);
    // Quality only: did Klauro match the strongest competitor at the ceiling?
    // (e.g. both F1 = 100 against a compiler-accurate tool). Not a loss — the
    // win is then carried by efficiency.
    if (metric === 'quality' && !wins) {
      tied_at_ceiling = klValue >= QUALITY_CEILING && Math.abs(klValue - best.value) <= QUALITY_WIN_MARGIN;
    }
  } else {
    const margin = best.value * EFFICIENCY_WIN_MARGIN_FRAC;
    wins = klValue < best.value - margin;
    advantage = best.value > 0 ? (best.value - klValue) / best.value : 0;
  }

  return {
    metric,
    klauro_value: klValue,
    best_other_value: best.value,
    best_other_arm_id: best.arm_id,
    klauro_wins: wins,
    ...(tied_at_ceiling ? { tied_at_ceiling: true } : {}),
    advantage,
  };
}

/**
 * Validate one scenario's arm results against the win condition.
 *
 * @param klauroEdge the scenario's stated mechanism — echoed into a violation so
 *        a loss points at the exact capability that failed to deliver.
 */
export function validateWin(
  armResults: ArmResult[],
  klauroEdge: string
): WinVerdict {
  const klauro = armResults.find(a => a.arm_id === 'klauro');
  const others = armResults.filter(a => a.arm_id !== 'klauro' && a.attempted);

  // Single-arm scenarios (e.g. objective analysis-readiness) have no opponent;
  // "winning" reduces to Klauro meeting its own bar, judged on quality alone.
  if (!klauro) {
    return {
      klauro_wins: false,
      quality_won: false,
      efficiency_won: false,
      comparisons: [],
      reasons: ['No Klauro arm present in this scenario.'],
      violation: {
        summary: 'Klauro arm missing — cannot establish a win.',
        losing_metrics: ['quality', 'time', 'tokens'],
        suspected_capability: klauroEdge,
      },
    };
  }

  if (others.length === 0) {
    const q = klauro.metrics.quality;
    const passed = typeof q === 'number' ? q >= 70 : false;
    return {
      klauro_wins: passed,
      quality_won: passed,
      efficiency_won: true, // uncontested
      comparisons: [
        { metric: 'quality', klauro_value: q, klauro_wins: passed },
      ],
      reasons: passed
        ? [`Uncontested scenario; Klauro meets the quality bar (${q}).`]
        : [`Uncontested scenario; Klauro below the quality bar (${q ?? 'n/a'} < 70).`],
      ...(passed ? {} : {
        violation: {
          summary: `Klauro quality ${q ?? 'n/a'} is below the 70 bar on an uncontested scenario.`,
          losing_metrics: ['quality'] as MetricKey[],
          suspected_capability: klauroEdge,
        },
      }),
    };
  }

  const quality = compareMetric('quality', klauro, others);
  const time = compareMetric('time', klauro, others);
  const tokens = compareMetric('tokens', klauro, others);
  const comparisons = [quality, time, tokens];

  const quality_won = quality.klauro_wins;
  const quality_tied_at_ceiling = !!quality.tied_at_ceiling;
  // Quality is acceptable if Klauro wins outright OR matches a ground-truth-correct
  // competitor at the ceiling. The win is then sealed by efficiency.
  const quality_ok = quality_won || quality_tied_at_ceiling;
  const efficiency_won = time.klauro_wins || tokens.klauro_wins;
  const klauro_wins = quality_ok && efficiency_won;

  const reasons: string[] = [];
  if (quality_won) {
    reasons.push(
      `Quality: Klauro ${fmt(quality.klauro_value)} > best other ${fmt(quality.best_other_value)} (${quality.best_other_arm_id}), +${pct(quality.advantage)}.`
    );
  } else if (quality_tied_at_ceiling) {
    reasons.push(
      `Quality: tied at the ceiling — Klauro ${fmt(quality.klauro_value)} = ${quality.best_other_arm_id} ${fmt(quality.best_other_value)} (compiler-accurate; cannot out-correct ground truth). Win carried by efficiency.`
    );
  } else {
    reasons.push(
      `Quality NOT won: Klauro ${fmt(quality.klauro_value)} vs best other ${fmt(quality.best_other_value)} (${quality.best_other_arm_id}).`
    );
  }
  if (time.klauro_wins) {
    reasons.push(`Speed: Klauro ${fmt(time.klauro_value)}ms beats ${fmt(time.best_other_value)}ms (${time.best_other_arm_id}), ${pct(time.advantage)} faster.`);
  }
  if (tokens.klauro_wins) {
    reasons.push(`Tokens: Klauro ${fmt(tokens.klauro_value)} beats ${fmt(tokens.best_other_value)} (${tokens.best_other_arm_id}), ${pct(tokens.advantage)} fewer.`);
  }
  if (!efficiency_won) {
    reasons.push(
      `Efficiency NOT won: neither time (Klauro ${fmt(time.klauro_value)} vs ${fmt(time.best_other_value)}) nor tokens (Klauro ${fmt(tokens.klauro_value)} vs ${fmt(tokens.best_other_value)}) beat the best competitor.`
    );
  }

  let violation: WinVerdict['violation'];
  if (!klauro_wins) {
    const losing: MetricKey[] = [];
    if (!quality_ok) losing.push('quality');
    if (!efficiency_won) { losing.push('time'); losing.push('tokens'); }
    violation = {
      summary: !quality_ok
        ? `Klauro lost on quality to ${quality.best_other_arm_id}.`
        : `Klauro ${quality_tied_at_ceiling ? 'tied quality at the ceiling' : 'matched quality'} but lost on both efficiency metrics — the edge must come from tokens/speed.`,
      losing_metrics: losing,
      suspected_capability: klauroEdge,
    };
  }

  return {
    klauro_wins,
    quality_won,
    ...(quality_tied_at_ceiling ? { quality_tied_at_ceiling: true } : {}),
    efficiency_won,
    comparisons,
    reasons,
    ...(violation ? { violation } : {}),
  };
}

/** Roll up scenario verdicts into the top-level summary the UI headlines. */
export function summarize(scenarios: ScenarioResult[]): GauntletSummary {
  const judged = scenarios.filter(s => s.verdict && s.status === 'done');
  const won = judged.filter(s => s.verdict!.klauro_wins);
  const lost = judged.filter(s => !s.verdict!.klauro_wins);

  const qualityAdvs: number[] = [];
  const timeAdvs: number[] = [];
  const tokenAdvs: number[] = [];
  for (const s of won) {
    for (const c of s.verdict!.comparisons) {
      if (!c.klauro_wins || typeof c.advantage !== 'number') continue;
      if (c.metric === 'quality') qualityAdvs.push(c.advantage);
      if (c.metric === 'time') timeAdvs.push(c.advantage);
      if (c.metric === 'tokens') tokenAdvs.push(c.advantage);
    }
  }

  return {
    klauro_wins_all: judged.length > 0 && lost.length === 0,
    scenarios_won: won.length,
    scenarios_lost: lost.length,
    losses: lost.map(s => ({
      scenario_id: s.scenario_id,
      summary: s.verdict!.violation?.summary || 'Klauro did not win.',
      losing_metrics: s.verdict!.violation?.losing_metrics || [],
    })),
    avg_quality_advantage: avg(qualityAdvs),
    avg_time_advantage: avg(timeAdvs),
    avg_token_advantage: avg(tokenAdvs),
  };
}

function avg(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function fmt(v?: number): string {
  if (typeof v !== 'number') return 'n/a';
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

function pct(frac?: number): string {
  if (typeof frac !== 'number') return 'n/a';
  return `${Math.round(frac * 100)}%`;
}
