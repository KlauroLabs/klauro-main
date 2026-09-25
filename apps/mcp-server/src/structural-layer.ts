import { analyzeWithTierStack } from '../../../packages/analyzer-core/src/analyzer/tier-stack';
import { saveAnalysisWithSourceCoverage as saveAnalysis } from './source-coverage';
import { loadAnalysis, withProjectAnalysisLockIfAvailable } from './storage';
import { clearFreshnessSummaryCache } from './freshness';
import { buildStructuralLayersReady } from './layered-analysis';

export async function publishStructuralLayer(projectPath: string, displayName?: string): Promise<void> {
  if (process.env.KLAURO_ENRICH === '0') return;
  await withProjectAnalysisLockIfAvailable(projectPath, async () => {
    const stored = await loadAnalysis(projectPath, { preferCache: true }).catch(() => null);
    if ((stored?.nodes?.length ?? 0) > 0) return;
    const structural = await analyzeWithTierStack(projectPath, displayName, { enrich: false });
    structural.layers_ready = buildStructuralLayersReady(structural);
    await saveAnalysis(projectPath, structural);
    clearFreshnessSummaryCache();
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Klauro] structural layer skipped for ${projectPath} (${message}); continuing to full analysis`);
  });
}
