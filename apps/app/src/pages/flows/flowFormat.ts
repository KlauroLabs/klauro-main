import { isKnownKind, type EntryKind } from '../../components/entryPointKinds';
import type { FlowConcept, FlowStep } from '../../api';

/**
 * Entry-point kind, derived from `FlowConcept.entry_point`'s own id shape
 * rather than a second fetch of the full CAS. Entry-point ids are minted as
 * `entry_<type>_<...>` (see packages/analyzer-core's entry-point id builder;
 * confirmed live on this repo's own analysis, e.g.
 * `entry_cli_packages_analyzer_core_native_...` and
 * `entry_event_entry_apps_app_src_main_tsx_App_addMember_...`) — the second
 * underscore-delimited segment IS the CASEntryPointType. This keeps the
 * flows list from pulling the whale-sized GET /api/projects/:id/cas payload
 * (which useEntryPoints.ts already warns is unavoidable there) just to
 * label a badge; the tradeoff is honest — see docs/DESIGN-NOTES.md.
 */
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

/** "Side effects" count shown under a step chip in the Figma step chain —
 *  state changes plus external integrations, the same two facets the
 *  System Effects section renders in full. */
export function stepSideEffectCount(step: FlowStep): number {
  return step.contract.side_effects.state_changes.length + step.contract.side_effects.external_integrations.length;
}

/** "N linked" capability badge on the flow list (Figma CAPABILITIES column).
 *  Zero is a real, honest answer — never hidden (LANE-COMMON's "one/many/none
 *  shapes honest"). */
export function linkedCapabilityCount(flow: FlowConcept): number {
  return flow.capability_relationships?.length ?? 0;
}
