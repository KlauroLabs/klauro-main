/**
 * Arm registry — maps a gauntlet arm id to a runnable ArmRunSpec for the
 * multi-arm live engine, attaching the real retrieval backend for competitors.
 *
 * The Klauro arm uses the Klauro-enabled launcher (cfg.withKlauro, which wires
 * the Unravl MCP). Every other arm uses the plain launcher (cfg.withoutKlauro)
 * and differs only by what context it injects — nothing for the bare baseline,
 * and ranked candidates from its index for each competitor. That is exactly how
 * these tools help a real agent, so the comparison is apples-to-apples.
 */

import type { ArmRunSpec } from './multi-arm-trial';
import type { LiveAgentCommandConfig } from '../agent-live-trial';
import { BACKENDS_BY_ID } from './retrieval';

/** Competitor arm id -> retrieval backend id. */
const COMPETITOR_BACKEND: Record<string, string> = {
  ctags: 'ctags',
  'embeddings-rag': 'embeddings-rag',
  'cursor-proxy': 'cursor-proxy',
};

/**
 * Build run specs for the given arm ids. Arms whose competitor backend is
 * unknown, or whose launcher command is missing, are omitted (the caller keeps
 * them projected). Returns specs in the same order as armIds.
 */
export function buildArmSpecs(armIds: string[], cfg: LiveAgentCommandConfig): ArmRunSpec[] {
  const specs: ArmRunSpec[] = [];
  for (const id of armIds) {
    if (id === 'klauro') {
      if (cfg.withKlauro) specs.push({ id, kind: 'klauro', command: cfg.withKlauro });
      continue;
    }
    if (id === 'no-tools') {
      if (cfg.withoutKlauro) specs.push({ id, kind: 'no-tools', command: cfg.withoutKlauro });
      continue;
    }
    const backendId = COMPETITOR_BACKEND[id];
    const backend = backendId ? BACKENDS_BY_ID[backendId] : undefined;
    if (backend && cfg.withoutKlauro) {
      specs.push({ id, kind: 'competitor', command: cfg.withoutKlauro, retrieval: backend });
    }
  }
  return specs;
}

/** Which arm ids can run live given the configured commands + known backends. */
export function liveCapableArmIds(armIds: string[], cfg: LiveAgentCommandConfig): Set<string> {
  return new Set(buildArmSpecs(armIds, cfg).map(s => s.id));
}
