import type { CASDataEntity, SystemCapability } from '../../types/cas.types';
import { outcomeIdentityTokens } from './capability-evidence-language';

export function catalogCandidateEntityFacts(
  candidate: SystemCapability,
  entityById: Map<string, CASDataEntity>,
): Array<{ name: string; fields: string[] }> {
  return (candidate.related_entities || []).map(id => {
    const entity = entityById.get(id);
    return { name: entity?.name || id, fields: (entity?.fields || []).slice(0, 8).map(field => field.name) };
  });
}

export function catalogPromptResponseComplexity(
  evidenceFamilyCount: number,
  behaviorFamilyCount: number,
  entityFamilyCount: number,
  requiredOutcomeCount = 0,
  candidateFactCount = 0,
): number {
  return Math.max(1, Math.max(
    evidenceFamilyCount,
    behaviorFamilyCount,
    entityFamilyCount,
    requiredOutcomeCount,
    candidateFactCount,
  ));
}


export function catalogRelatedEntityIds(
  authoredEntityIds: string[],
  candidateEntityIds: Iterable<string>,
): string[] {
  return [...new Set(authoredEntityIds.length > 0 ? authoredEntityIds : [...candidateEntityIds])];
}

export function uniquelyMatchingCapabilityEntityIds(
  resourceKey: string,
  dataEntities: readonly CASDataEntity[],
): string[] {
  const resourceTokens = outcomeIdentityTokens(resourceKey);
  if (resourceTokens.length === 0) return [];
  const matches = dataEntities.filter(entity => {
    const entityTokens = outcomeIdentityTokens(entity.name);
    return entityTokens.length === resourceTokens.length &&
      entityTokens.every((token, index) => token === resourceTokens[index]);
  });
  return matches.length === 1 ? [matches[0].id] : [];
}
