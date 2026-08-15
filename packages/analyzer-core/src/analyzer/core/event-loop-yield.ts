


















export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>(resolve => setImmediate(resolve));
}





export const ANALYSIS_YIELD_BUDGET_MS = 50;







export function createYieldBudget(budgetMs: number = ANALYSIS_YIELD_BUDGET_MS): () => Promise<void> {
  let lastYieldAt = Date.now();
  return async () => {
    if (Date.now() - lastYieldAt < budgetMs) return;
    await yieldToEventLoop();
    lastYieldAt = Date.now();
  };
}
