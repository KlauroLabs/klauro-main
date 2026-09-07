import type { SystemCapability } from '../../types/cas.types';

export type CapabilityDescriptionSelection = Pick<SystemCapability, 'description' | 'description_source' | 'description_generation'>;

export function selectCapabilityDescription(args: {
  existing?: CapabilityDescriptionSelection;
  generated?: string;
  preferGenerated: boolean;
  sanitize: (text: string) => string | undefined;
  validate: (text: string) => { ok: boolean };
  budgetMs?: number;
}): CapabilityDescriptionSelection | undefined {
  const fromExisting = (): CapabilityDescriptionSelection | undefined => {
    const description = args.sanitize(args.existing?.description || '');
    if (!description || !args.validate(description).ok) return undefined;
    return {
      description,
      description_source: args.existing?.description_source,
      description_generation: args.existing?.description_generation
        ? { ...args.existing.description_generation } : undefined,
    };
  };
  const fromGenerated = (): CapabilityDescriptionSelection | undefined => {
    const description = args.sanitize(args.generated || '');
    if (!description || !args.validate(description).ok) return undefined;
    return {
      description,
      description_source: 'ai',
      description_generation: {
        status: 'ai_applied',
        attempted: true,
        budget_ms: Number.isFinite(args.budgetMs) ? args.budgetMs : undefined,
        generated_at: new Date().toISOString(),
      },
    };
  };
  return args.preferGenerated ? fromGenerated() || fromExisting() : fromExisting() || fromGenerated();
}


export function applyCapabilityDescriptionSelection(
  capabilities: SystemCapability[], id: string, selection: CapabilityDescriptionSelection,
): void {
  const capability = capabilities.find(item => item.id === id);
  if (capability) Object.assign(capability, selection);
}
