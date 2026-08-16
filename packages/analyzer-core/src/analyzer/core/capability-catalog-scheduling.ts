import type { SystemCapability } from '../../types/cas.types';

export type CapabilityCatalogOutcome =
  | { status: 'fulfilled'; value: SystemCapability[] }
  | { status: 'rejected'; reason: unknown };

export interface ScheduledCapabilityCatalog<TTarget> {
  capabilities: SystemCapability[];
  authoredFacts: Array<Pick<SystemCapability, 'name' | 'description' | 'category'>>;
  targets: TTarget[];
  descriptionPromise?: Promise<void>;
}

export function scheduleCapabilityCatalog<TTarget>(args: {
  outcome: Promise<CapabilityCatalogOutcome>;
  capabilities: SystemCapability[];
  elementsEnabled: boolean;
  elementLimit: number;
  reauthorDescriptions: boolean;
  toTarget: (capability: SystemCapability) => TTarget;
  authorDescriptions: (capabilities: SystemCapability[]) => Promise<void>;
}): Promise<ScheduledCapabilityCatalog<TTarget>> {
  return args.outcome.then(outcome => {
    if (outcome.status === 'rejected') throw outcome.reason;
    const selected = outcome.value.length > 0
      ? outcome.value
      : args.capabilities.filter(capability =>
        capability.name_source === 'ai' ||
        capability.name_source === 'manual' ||
        capability.name_source === 'reused').map(capability => structuredClone(capability));
    const targetCapabilities = args.elementsEnabled
      ? selected.slice(0, args.elementLimit)
      : [];
    const descriptionPromise = args.reauthorDescriptions && targetCapabilities.length > 0
      ? args.authorDescriptions(targetCapabilities)
      : undefined;
    if (descriptionPromise) void descriptionPromise.catch(() => undefined);
    return {
      capabilities: selected,
      authoredFacts: selected.map(capability => ({
        name: capability.name,
        description: capability.description,
        category: capability.category,
      })),
      targets: targetCapabilities.map(args.toTarget),
      descriptionPromise,
    };
  });
}
