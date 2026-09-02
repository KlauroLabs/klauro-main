import type { SystemCapability } from '../../types/cas.types';

export function applyPreferredAiCapabilityDescription(
  target: SystemCapability,
  candidate: SystemCapability,
): void {
  if (target.description_source === 'ai' || candidate.description_source !== 'ai') return;
  target.description = candidate.description;
  target.description_source = candidate.description_source;
  target.description_generation = candidate.description_generation;
}
