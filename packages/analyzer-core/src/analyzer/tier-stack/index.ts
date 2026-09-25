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
  const cas = tierStackToCas(await readTierStack(projectPath, options), displayName);
  cas.analyzer_build = getBuildIdentity().version;
  return cas;
}
