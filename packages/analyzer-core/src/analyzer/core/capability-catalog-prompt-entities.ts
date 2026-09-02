import type { CASDataEntity, SystemCapability } from '../../types/cas.types';

export interface CapabilityCatalogEntityFact {
  fields: string[];
  name: string;
}

export function catalogPromptEntities(
  dataEntities: CASDataEntity[],
  candidates: SystemCapability[],
  limit = 18,
): CapabilityCatalogEntityFact[] {
  const candidateEntityIds = new Set(candidates.flatMap(candidate => candidate.related_entities || []));
  return dataEntities.filter(entity => entity.kind === 'persisted-entity' || entity.kind === 'api-response' || candidateEntityIds.has(entity.id))
    .sort((left, right) => (right.fields?.length || 0) - (left.fields?.length || 0) || left.name.localeCompare(right.name))
    .slice(0, limit).map(entity => ({ name: entity.name, fields: (entity.fields || []).slice(0, 6).map(field => field.name) }));
}
