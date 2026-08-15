
























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

  vacuous: boolean;
  passed: boolean;

  margin: number;
}

export interface CoverageGateVerdict {
  passed: boolean;
  checks: CoverageMetricCheck[];
  reasons: string[];
  violation?: {
    summary: string;
    failing_metrics: CoverageMetricKey[];

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
