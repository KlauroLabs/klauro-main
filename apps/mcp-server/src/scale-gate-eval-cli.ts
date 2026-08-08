/**
 * Thin CLI wrapper around evaluateScaleGateObservation() for
 * scale-survivability-gate.sh — takes the observation as a single JSON arg
 * (so the shell runner never has to duplicate the evaluation logic) and
 * prints the finding as JSON on stdout, exiting non-zero on failure.
 * Run via `tsx` directly; no build step required.
 */
import { evaluateScaleGateObservation, DEFAULT_SCALE_GATE_BUDGETS, type ScaleGateObservation, type ScaleGateBudgets } from './scale-survivability-gate';

function main() {
  const raw = process.argv[2];
  if (!raw) {
    console.error('usage: scale-gate-eval-cli.ts \'{"observation":{...},"budgets":{...}}\'');
    process.exit(2);
  }
  const input = JSON.parse(raw) as { observation: ScaleGateObservation; budgets?: Partial<ScaleGateBudgets> };
  const budgets: ScaleGateBudgets = { ...DEFAULT_SCALE_GATE_BUDGETS, ...(input.budgets || {}) };
  const finding = evaluateScaleGateObservation(input.observation, budgets);
  console.log(JSON.stringify(finding));
  process.exit(finding.status === 'pass' ? 0 : 1);
}

main();
