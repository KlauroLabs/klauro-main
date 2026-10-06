import type { CASOutput } from '../../types/cas.types';
import { readTierStack } from './read-tier-stack';
import { tierStackToCas } from './tier-stack-to-cas';
import { getBuildIdentity } from '../core/build-identity';

export { enginePath, readTierStack, resolveEngine, type TierStackIndex } from './read-tier-stack';
export { readInterned } from './read-interned';
export { tierStackToCas, TIER_STACK_ANALYZER } from './tier-stack-to-cas';

export async function analyzeWithTierStack(
  projectPath: string,
  displayName?: string,
  options: { enrich?: boolean } = {}
): Promise<CASOutput> {
  const startedAt = Date.now();
  const index = await readTierStack(projectPath, options);
  const engineMs = Date.now() - startedAt;
  const cas = tierStackToCas(index, displayName);
  cas.timings = { total_ms: Date.now() - startedAt, stages: { engine: engineMs } };
  cas.analyzer_build = getBuildIdentity().version;
  return cas;
}
