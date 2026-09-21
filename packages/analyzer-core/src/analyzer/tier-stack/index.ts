import type { CASOutput } from '../../types/cas.types';
import { readTierStack } from './read-tier-stack';
import { tierStackToCas } from './tier-stack-to-cas';

export { readTierStack, type TierStackIndex } from './read-tier-stack';
export { tierStackToCas, TIER_STACK_ANALYZER } from './tier-stack-to-cas';

export function tierStackRequested(): boolean {
  return process.env.KLAURO_TIER_STACK === '1';
}

export async function analyzeWithTierStack(
  projectPath: string,
  displayName?: string
): Promise<CASOutput> {
  return tierStackToCas(await readTierStack(projectPath), displayName);
}
