import { isKnownKind, type EntryKind } from '@/shared/components/entryPointKinds';
import type { FlowConcept, FlowStep } from '@/shared/api/index';

export function entryKindFromFlow(flow: FlowConcept): EntryKind | undefined {
  const match = /^entry_([a-z-]+)_/.exec(flow.entry_point);
  const candidate = match?.[1];
  return candidate && isKnownKind(candidate) ? candidate : undefined;
}

export function roleLabel(role: FlowConcept['role']): string {
  if (role === 'core') return 'Core';
  if (role === 'supporting') return 'Supporting';
  if (role === 'infrastructure') return 'Infrastructure';
  return 'Unclassified';
}

export function stepSideEffectCount(step: FlowStep): number {
  return step.contract.side_effects.state_changes.length + step.contract.side_effects.external_integrations.length;
}

export function linkedCapabilityCount(flow: FlowConcept): number {
  return flow.capability_relationships?.length ?? 0;
}
