import type { CASDataEntity, SystemCapability } from '../../types/cas.types';
import { outcomeIdentityTokens } from './capability-evidence-language';

interface CapabilityCatalogProjectSignal {
  productDocTitle?: string;
  productDocSummary?: string;
  manifestDescription?: string;
  summary?: string;
}

export function catalogCandidateEntityFacts(
  candidate: SystemCapability,
  entityById: Map<string, CASDataEntity>,
): Array<{ name: string; fields: string[] }> {
  return (candidate.related_entities || []).map(id => {
    const entity = entityById.get(id);
    return { name: entity?.name || id, fields: (entity?.fields || []).slice(0, 8).map(field => field.name) };
  });
}

export function catalogCountBounds(
  distinctFamilyCount: number,
  behaviorFamilyCount: number,
  entityFamilyCount: number,
  requiredOutcomeCount = 0,
): { min: number; max: number } {
  const max = Math.max(1, Math.min(20, Math.max(
    distinctFamilyCount,
    behaviorFamilyCount,
    entityFamilyCount,
    requiredOutcomeCount,
  )));
  return { min: 0, max };
}

export function catalogMinimumCapabilityCount(
  distinctFamilyCount: number,
  entityFamilyCount: number,
  requiredOutcomeCount = 0,
): number {
  void distinctFamilyCount; void entityFamilyCount; void requiredOutcomeCount;
  return 0;
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

export function firstPartySupportsIdentityProduct(signal?: CapabilityCatalogProjectSignal): boolean {
  if (!signal) return false;
  const text = [signal.productDocTitle, signal.productDocSummary, signal.manifestDescription, signal.summary]
    .filter(Boolean)
    .join(' ');
  const identity = '(?:identity|authentication|authorization|access[ -]?control)';
  const product = '(?:platform|service|provider|product|system|server|gateway)';
  return new RegExp(`\\b${identity}\\b[^.]{0,60}\\b${product}\\b|\\b${product}\\b[^.]{0,60}\\b${identity}\\b`, 'i').test(text) ||
    new RegExp(`\\b(?:provides?|delivers?|offers?|sells?|issues?|verifies?|authenticates?|authorizes?)\\b[^.]{0,60}\\b${identity}\\b`, 'i').test(text);
}
