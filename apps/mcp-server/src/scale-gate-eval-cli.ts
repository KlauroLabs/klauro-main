






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
