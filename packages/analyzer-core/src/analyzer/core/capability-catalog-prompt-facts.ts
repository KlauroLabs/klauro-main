import type { CASDataEntity, CASEntryPoint, CASNode, CASTerminalityMember, SystemCapability } from '../../types/cas.types';
import { behaviorSurfaceEntryCount } from './capability-catalog-evidence';
import { catalogCandidateEntityFacts } from './capability-catalog-metrics';
import { capabilityCatalogStructuralApiLabels, projectCapabilityCatalogPromptEvidence } from './capability-catalog-prompt-evidence';

export const capabilityCatalogEvidenceContract = 'Copy requirement_id only from required_outcomes[].requirement_id when proposing that documented outcome; omit it for an independently discovered outcome. Copy candidate_ids only from candidate_route_areas[].candidate_id. These are distinct namespaces: a candidate ID is never a requirement ID. observed_operations rows have the fixed columns [entry_point_id, entry_point_type, name, action, surface]; null means unavailable. For each capability, return entry_point_ids copied from the first column of rows belonging to its cited candidates. Select only the operations that substantiate the complete outcome; citing a candidate does not cite all its operations. An entry-point ID from another candidate or an invented ID is invalid. Preserve qualifications such as without or before when judging the full outcome; shared words alone do not establish support. Operation names identify observed entry points, not proof of the outcome their names suggest. Use behavior, contracts, relationships and qualifications to ground claims; do not invent behavior for unresolved_entry_point_ids. evidence_window gives zero-based offsets and total item counts for partial operation/contract collections. These are evidence subsets of the same candidate, not separate complete capabilities. Do not infer absence from an item missing in a window, or claim behavior outside the supplied evidence. Relationships and contracts retain their own scope; sharing a candidate does not make every contract govern every operation.';

export function projectCapabilityCatalogPromptFacts(
  candidates: readonly SystemCapability[],
  nodeById: ReadonlyMap<string, CASNode>,
  entryById: ReadonlyMap<string, CASEntryPoint>,
  entityById: Map<string, CASDataEntity>,
  terminalityById: ReadonlyMap<string, CASTerminalityMember>,
): Array<Record<string, unknown>> {
  const structuralApiLabels = new Set(capabilityCatalogStructuralApiLabels(candidates));
  return candidates.map(capability => {
    const evidence = projectCapabilityCatalogPromptEvidence(capability, nodeById, entryById);
    const entities = catalogCandidateEntityFacts(capability, entityById);
    const terminality = terminalityById.get(capability.id);
    return {
      candidate_id: capability.id,
      family: structuralApiLabels.has(capability.name) ? undefined : capability.name,
      structural_group_label: capability.structural_label,
      operations: evidence.operations,
      observed_operations: capability.operations.map(operation => [
        operation.entry_point_id, operation.entry_point_type,
        entryById.get(operation.entry_point_id)?.name ?? null,
        operation.action ?? null, operation.path_or_command ?? null,
      ]),
      relationships: evidence.relationships,
      declared_contracts: evidence.declared_contracts,
      unresolved_entry_point_ids: evidence.unresolved_entry_point_ids,
      name: evidence.name,
      entry_points: behaviorSurfaceEntryCount(capability),
      entities: entities.length,
      entity_names: entities.map(entity => entity.name),
      entity_fields: entities,
      terminality: terminality?.terminal ? 'terminal' : terminality?.proximal_terminal ? 'proximal-terminal' : 'upstream',
      distance_to_terminal: terminality?.distance_to_terminal,
      evidence_role: capability.evidence_role,
      evidence_role_reasons: capability.evidence_role_reasons,
    };
  });
}
