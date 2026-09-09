import { createHash } from 'node:crypto';
import type { SystemCapability } from '../../types/cas.types';
import { preserveCapabilityOperationCitations } from './capability-operation-attribution';

function uniqueCapabilityOperations(...operationGroups: ReadonlyArray<SystemCapability['operations']>): SystemCapability['operations'] {
  const seen = new Set<string>();
  return operationGroups.flatMap(operations => operations.filter(operation => {
    const key = [operation.entry_point_id, operation.entry_point_type, operation.action, operation.path_or_command].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }));
}

function exactOperationSignature(capability: SystemCapability): string {
  return (capability.operations || [])
    .map(operation => [operation.entry_point_id, operation.entry_point_type, operation.action, operation.path_or_command || ''].join('|'))
    .sort()
    .join('||');
}

function parentCandidateIds(capability: SystemCapability): Set<string> {
  return new Set((capability.criticality_factors || [])
    .filter(factor => factor.startsWith('catalog-candidate:') && !factor.startsWith('catalog-candidate:operation-obligation:'))
    .map(factor => factor.slice('catalog-candidate:'.length)));
}

function mergeSubsumedDeterministicFallbacks(capabilities: SystemCapability[]): SystemCapability[] {
  const retained = [...capabilities];
  for (const fallback of capabilities) {
    if (fallback.name_source !== 'deterministic' ||
        !(fallback.criticality_factors || []).includes('catalog-deterministic-grouped-lifecycle')) continue;
    const signature = exactOperationSignature(fallback);
    if (!signature) continue;
    const fallbackCandidates = parentCandidateIds(fallback);
    const targetIndex = retained.findIndex(candidate => candidate !== fallback &&
      (candidate.name_source === 'ai' || candidate.name_source === 'manual') &&
      exactOperationSignature(candidate) === signature &&
      [...parentCandidateIds(candidate)].some(candidateId => fallbackCandidates.has(candidateId)));
    if (targetIndex < 0) continue;
    const target = retained[targetIndex];
    retained[targetIndex] = {
      ...target,
      operations: uniqueCapabilityOperations(target.operations, fallback.operations),
      related_entities: [...new Set([...(target.related_entities || []), ...(fallback.related_entities || [])])],
      related_domains: [...new Set([...(target.related_domains || []), ...(fallback.related_domains || [])])],
      criticality_factors: [...new Set([...(target.criticality_factors || []), ...(fallback.criticality_factors || [])])],
    };
    const fallbackIndex = retained.indexOf(fallback);
    if (fallbackIndex >= 0) retained.splice(fallbackIndex, 1);
  }
  return retained;
}

export function normalizePublishedCapabilityIds(capabilities: SystemCapability[]): SystemCapability[] {
  const groups = new Map<string, SystemCapability[]>();
  mergeSubsumedDeterministicFallbacks(capabilities).forEach((capability, index) => {
    const key = capability.id || `__anonymous_${index}`;
    const group = groups.get(key);
    if (group) group.push(capability);
    else groups.set(key, [capability]);
  });
  const sourceRank = (capability: SystemCapability): number =>
    ({ ai: 4, manual: 4, reused: 3, deterministic: 1 }[String(capability.name_source || '')] || 0) * 100 +
    (capability.description_source === 'ai' ? 20 : 0) +
    (capability.description_generation?.status === 'ai_rejected' ? -50 : 0);
  const obligationSignature = (capability: SystemCapability): string => (capability.criticality_factors || [])
    .filter(factor => factor.startsWith('catalog-candidate:operation-obligation:') || factor.startsWith('catalog-operation-obligation:'))
    .sort()
    .join('|');
  const operationSignature = (capability: SystemCapability): string => (capability.operations || [])
    .map(operation => [operation.entry_point_id, operation.entry_point_type, operation.action, operation.path_or_command || ''].join('|'))
    .sort()
    .join('||');
  const criticalityRank: Record<SystemCapability['criticality'], number> = {
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
  };
  const published: SystemCapability[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      published.push(group[0]);
      continue;
    }
    const exactSignatures = new Set(group.map(obligationSignature).filter(Boolean));
    if (exactSignatures.size > 1) {
      const distinct = [...group].sort((left, right) =>
        (obligationSignature(left) || operationSignature(left)).localeCompare(obligationSignature(right) || operationSignature(right)));
      for (const capability of distinct) {
        const signature = obligationSignature(capability) || operationSignature(capability) || capability.name;
        const suffix = createHash('sha256').update(signature).digest('hex').slice(0, 12);
        published.push({ ...capability, id: `${capability.id}_${suffix}` });
      }
      continue;
    }
    const preferred = [...group].sort((left, right) =>
      sourceRank(right) - sourceRank(left) || left.name.localeCompare(right.name))[0];
    const others = group.filter(capability => capability !== preferred);
    published.push({
      ...preferred,
      operations: others.reduce(
        (operations, capability) => uniqueCapabilityOperations(operations, capability.operations),
        preferred.operations,
      ),
      related_entities: [...new Set(group.flatMap(capability => capability.related_entities || []))],
      related_domains: [...new Set(group.flatMap(capability => capability.related_domains || []))],
      criticality: group.reduce((current, capability) =>
        criticalityRank[capability.criticality] > criticalityRank[current] ? capability.criticality : current,
      preferred.criticality),
      criticality_factors: [...new Set(group.flatMap(capability => capability.criticality_factors || []))],
      category: group.some(capability => capability.category === 'core') ? 'core' : preferred.category,
    });
  }
  return published.map(preserveCapabilityOperationCitations);
}
