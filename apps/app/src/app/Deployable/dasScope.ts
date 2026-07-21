import type { EntryPoint } from '@/shared/hooks/useEntryPoints';

export interface UnitCapability {
  capability_id: string;
  capability_name: string;
  role: string;
}

export function scopeCapabilities(scopedEntryPoints: EntryPoint[]): UnitCapability[] {
  const byId = new Map<string, UnitCapability>();
  for (const ep of scopedEntryPoints) {
    for (const cap of ep.capabilities ?? []) {
      if (!byId.has(cap.capability_id)) {
        byId.set(cap.capability_id, { capability_id: cap.capability_id, capability_name: cap.capability_name, role: cap.role });
      }
    }
  }
  return Array.from(byId.values()).sort((a, b) => a.capability_name.localeCompare(b.capability_name));
}
