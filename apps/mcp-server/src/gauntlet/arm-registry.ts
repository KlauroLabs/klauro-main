










import type { ArmRunSpec } from './multi-arm-trial';
import type { LiveAgentCommandConfig } from '../agent-live-trial';
import { BACKENDS_BY_ID } from './retrieval';


const COMPETITOR_BACKEND: Record<string, string> = {
  ctags: 'ctags',
  'embeddings-rag': 'embeddings-rag',
  'cursor-proxy': 'cursor-proxy',
};






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


export function liveCapableArmIds(armIds: string[], cfg: LiveAgentCommandConfig): Set<string> {
  return new Set(buildArmSpecs(armIds, cfg).map(s => s.id));
}
