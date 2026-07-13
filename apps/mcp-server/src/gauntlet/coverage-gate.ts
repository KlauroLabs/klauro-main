/**
 * The semantic-coverage regression gate — a release gate in the spirit of the
 * latency budgets and the win-validator (docs/SEMANTIC-MODEL.md, "Coverage
 * invariants": *these metrics are a release gate; regressions fail the gauntlet*).
 *
 * The doctrine, verbatim: "everything rolls up" must be MEASURABLE, and a drop
 * like the historical 0.07% flow-coverage era must fail loudly rather than rot
 * silently. This gate takes the DETERMINISTIC semantic_coverage object
 * (computeSemanticCoverage) and asserts each of the three rollup ratios stays at
 * or above a documented FLOOR.
 *
 * The floors are NOT targets — they are regression tripwires. The point is to
 * catch a COLLAPSE (a ratio falling toward zero because a layer broke), not to
 * demand 100%: unmapped code is legitimate (generic infra, dead code, framework-
 * generated, undiscovered flows), so a healthy analysis sits well ABOVE the floor
 * with comfortable headroom. Floors are set conservatively below the values
 * measured across real repos + fixtures so ANY healthy repo passes while a broken
 * extraction fails.
 *
 * Repo-agnostic: the same floors apply to every repo — the ratios are normalized
 * 0..1, and a small/empty repo with `total===0` on a metric passes vacuously
 * (nothing to roll up is never a regression). Pure functions only — unit-testable,
 * no I/O.
 */

import type { SemanticCoverage } from '../../../../packages/analyzer-core/src/analyzer/core/semantic-coverage';

export type CoverageMetricKey =
  | 'reachable_code_to_steps'
  | 'steps_to_flows'
  | 'flows_to_capabilities';

export interface CoverageFloors {
  reachable_code_to_steps: number;
  steps_to_flows: number;
  flows_to_capabilities: number;
}

/**
 * Documented floors. Grounded on measured values (2026-07-13) across the
 * analysis-truth fixtures and the Klauro repo itself (real, computed via the
 * product path — see the gate test):
 *
 *   repo                 reachable_code_to_steps  steps_to_flows  flows_to_capabilities
 *   express-mongoose     0.667 (2/3)              1.0 (2/2)       1.0 (2/2)
 *   nest-react-prisma    1.0   (8/8)              1.0 (6/6)       1.0 (3/3)
 *   nest-event-flow      1.0   (2/2)              1.0 (5/5)       1.0 (5/5)
 *   klauro (poc, full)   0.412 (756/1836)         1.0 (4548/4548) 0.064 (140/2194)
 *
 * Klauro is the stress case: 3,794 entry points but only 11 product capabilities,
 * so most of its 2,194 flows (thousands of MCP-tool / route entries) legitimately
 * relate to no capability — flows_to_capabilities is honestly low there, and the
 * floors must PASS it while still catching a collapse.
 *
 *   - reachable_code_to_steps 0.25 — large repos carry more generic infra / dead
 *     code / framework-generated nodes that legitimately map to no flow step, so
 *     this ratio is naturally the lowest (Klauro 0.412); 0.25 clears Klauro with
 *     headroom while the historical 0.07%-coverage collapse would fail it by ~3.5x.
 *   - steps_to_flows 0.99 — an INVARIANT (~1.0 by construction: steps are nested
 *     in flows; measured 1.0 on every repo). A drop below 0.99 means the flow
 *     builder started detaching steps — a structural bug, caught immediately.
 *   - flows_to_capabilities 0.03 — B1 landed the M:N capability↔flow edges, making
 *     this materially >0 (Klauro 0.064). The floor sits at ~half of Klauro's value
 *     to catch a regression that severs those edges back toward the pre-B1 ~0,
 *     without demanding capability-heavy repos (many flows legitimately relate to
 *     no capability). NOTE: a repo with flows but ZERO detected capabilities scores
 *     0 here and fails — that is an intended signal (the capability layer produced
 *     nothing to roll up to), not a false alarm.
 */
export const SEMANTIC_COVERAGE_FLOORS: CoverageFloors = {
  reachable_code_to_steps: 0.25,
  steps_to_flows: 0.99,
  flows_to_capabilities: 0.03,
};

export interface CoverageMetricCheck {
  metric: CoverageMetricKey;
  value: number;
  floor: number;
  mapped: number;
  total: number;
  /** total===0 → nothing to roll up; passes without being held to the floor. */
  vacuous: boolean;
  passed: boolean;
  /** value - floor: negative is the regression depth, positive is headroom. */
  margin: number;
}

export interface CoverageGateVerdict {
  passed: boolean;
  checks: CoverageMetricCheck[];
  reasons: string[];
  violation?: {
    summary: string;
    failing_metrics: CoverageMetricKey[];
    /** Actionable pointer at the honest unmapped lists behind the failing ratio. */
    unmapped_hint: string;
  };
}

const METRIC_ORDER: CoverageMetricKey[] = [
  'reachable_code_to_steps',
  'steps_to_flows',
  'flows_to_capabilities',
];

function checkMetric(
  metric: CoverageMetricKey,
  coverage: SemanticCoverage,
  floor: number
): CoverageMetricCheck {
  const r = coverage[metric];
  const vacuous = r.total === 0;
  const passed = vacuous || r.ratio >= floor;
  return {
    metric,
    value: r.ratio,
    floor,
    mapped: r.mapped,
    total: r.total,
    vacuous,
    passed,
    margin: Math.round((r.ratio - floor) * 10000) / 10000,
  };
}

/**
 * Validate a semantic_coverage object against the floors. Fails when ANY ratio
 * falls below its floor (with a non-empty denominator). A failure names the
 * failing metrics and points at the unmapped lists that explain the drop.
 */
export function validateSemanticCoverage(
  coverage: SemanticCoverage,
  floors: CoverageFloors = SEMANTIC_COVERAGE_FLOORS
): CoverageGateVerdict {
  const checks = METRIC_ORDER.map(m => checkMetric(m, coverage, floors[m]));
  const failing = checks.filter(c => !c.passed);
  const passed = failing.length === 0;

  const reasons = checks.map(c => {
    if (c.vacuous) {
      return `${c.metric}: vacuous (total=0 — nothing to roll up), passes.`;
    }
    const rel = c.passed ? '>=' : '<';
    const status = c.passed ? 'ok' : 'REGRESSION';
    return `${c.metric}: ${c.value} ${rel} floor ${c.floor} (${c.mapped}/${c.total}) — ${status} (margin ${c.margin >= 0 ? '+' : ''}${c.margin}).`;
  });

  let violation: CoverageGateVerdict['violation'];
  if (!passed) {
    const failingMetrics = failing.map(c => c.metric);
    const unmappedHint = failingMetrics
      .map(m => {
        if (m === 'reachable_code_to_steps') {
          const total = coverage.unmapped.code_units.length + coverage.unmapped.code_units_omitted;
          return `${total} reachable code_units map to no flow step (see unmapped.code_units, each with a reason)`;
        }
        if (m === 'flows_to_capabilities') {
          const total = coverage.unmapped.flows.length + coverage.unmapped.flows_omitted;
          return `${total} flows carry no capability relationship (see unmapped.flows)`;
        }
        const total = coverage.unmapped.steps.length + coverage.unmapped.steps_omitted;
        return `${total} steps are not assigned to a flow (see unmapped.steps) — a structural flow-builder regression`;
      })
      .join('; ');
    violation = {
      summary: `Semantic coverage regressed below floor on: ${failingMetrics.join(', ')}. "Everything rolls up" no longer holds — a semantic layer broke.`,
      failing_metrics: failingMetrics,
      unmapped_hint: unmappedHint,
    };
  }

  return { passed, checks, reasons, ...(violation ? { violation } : {}) };
}
