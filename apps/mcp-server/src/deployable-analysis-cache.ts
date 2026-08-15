import type { BuildDeployableAnalysesResult } from './deployable-analysis';
import { WeightedLruCache } from './weighted-lru-cache';

function referenceBudget(): number {
  const raw = process.env.KLAURO_SUB_CAS_CACHE_REFERENCE_BUDGET;
  if (raw === undefined || raw.trim() === '') return 250_000;
  const configured = Number(raw);
  return Number.isFinite(configured) && configured >= 0 ? Math.floor(configured) : 250_000;
}

function referenceWeight(result: BuildDeployableAnalysesResult): number {
  let weight = result.sub_cas_nodes.units.length + result.sub_cas_nodes.orphan_node_ids.length;
  for (const unit of result.units) {
    for (const value of Object.values(unit.slice)) {
      if (Array.isArray(value)) weight += value.length;
    }
  }
  return weight;
}

export const deployableAnalysisCache = new WeightedLruCache<string, BuildDeployableAnalysesResult>({
  maxEntries: 32,
  weightBudget: referenceBudget,
  weightOf: referenceWeight,
});
