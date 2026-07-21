import type { EntryPoint } from '../../hooks/useEntryPoints';

/**
 * Capability aggregation for one DAS unit's ALREADY-SCOPED entry points
 * (useDasUnitSlice reads these off the real GET /api/projects/:id/cas
 * ?das_unit_id= endpoint, deployable-analysis.ts's scopeCasToDasUnit —
 * e9490b69). This is the one piece of unit-level shaping that still belongs
 * on the client: an entry point already carries its own `capabilities`
 * array, so the unit's capability set is a pure dedupe over the scoped rows,
 * not a re-derivation of scope itself.
 *
 * (The former client-side scopeEntryPoints/scopeFiles/scopeEntities —
 * directory-prefix approximations of DAS reachability — were removed once
 * the real scoped endpoint shipped; see useDasUnits.ts's useDasUnitSlice.)
 */
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
