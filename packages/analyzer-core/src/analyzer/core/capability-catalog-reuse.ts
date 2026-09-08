import { isDeepStrictEqual } from 'node:util';
import type { CASEntryPoint, SystemCapability } from '../../types/cas.types';

export interface CapabilityReuseEntryContext {
  previousEntryPoints: readonly CASEntryPoint[];
  currentEntryPoints: readonly CASEntryPoint[];
}

function entryContract(entry: CASEntryPoint | undefined): unknown {
  if (!entry) return undefined;
  const { capabilities: _capabilities, ...contract } = entry;
  return contract;
}

type Operation = SystemCapability['operations'][number];

function operationIdentity(operation: Operation): string {
  return JSON.stringify([
    operation.entry_point_id, operation.entry_point_type,
    String(operation.action || '').trim().toLowerCase(),
    operation.path_or_command || '', operation.trigger?.method?.toUpperCase() || '',
    operation.trigger?.path || '',
  ]);
}

export function reuseCapabilityCatalog(
  previousCapabilities: readonly SystemCapability[],
  currentCandidates: readonly SystemCapability[],
  options: {
    subjectsMatch: (previous: SystemCapability, current: SystemCapability) => boolean;
    isPublishable: (capability: SystemCapability) => boolean;
    entryContext?: CapabilityReuseEntryContext;
  },
): SystemCapability[] {
  const previousEntries = new Map(options.entryContext?.previousEntryPoints.map(entry => [entry.id, entry]));
  const currentEntries = new Map(options.entryContext?.currentEntryPoints.map(entry => [entry.id, entry]));
  const unchangedEntries = new Set([...previousEntries].filter(([id, entry]) =>
    currentEntries.has(id) && isDeepStrictEqual(entryContract(entry), entryContract(currentEntries.get(id)))).map(([id]) => id));
  const byEntryPoint = new Map<string, Set<SystemCapability>>();
  const byOperation = new Map<string, Set<SystemCapability>>();
  const byEntity = new Map<string, Set<SystemCapability>>();
  const byId = new Map(currentCandidates.map(candidate => [candidate.id, candidate]));
  const index = (map: Map<string, Set<SystemCapability>>, key: string, candidate: SystemCapability): void => {
    const values = map.get(key) || new Set<SystemCapability>();
    values.add(candidate);
    map.set(key, values);
  };
  for (const candidate of currentCandidates) {
    for (const operation of candidate.operations || []) {
      index(byOperation, operationIdentity(operation), candidate);
      index(byEntryPoint, operation.entry_point_id, candidate);
    }
    for (const entity of candidate.related_entities || []) index(byEntity, entity, candidate);
  }
  const reused: SystemCapability[] = [];
  for (const previous of previousCapabilities) {
    if (!options.isPublishable(previous) || !previous.description ||
      !['ai', 'manual', 'deterministic', 'reused'].includes(String(previous.description_source || ''))) continue;
    const previousOperations = previous.operations || [];
    const matching = new Set<SystemCapability>();
    const canonicalEvidence = Boolean(options.entryContext && previousOperations.length > 0);
    if (previousOperations.length > 0) {
      if (previousOperations.some(operation => canonicalEvidence
        ? !unchangedEntries.has(operation.entry_point_id) : !byOperation.has(operationIdentity(operation)))) continue;
      for (const operation of previousOperations) {
        const candidates = canonicalEvidence ? byEntryPoint.get(operation.entry_point_id) : byOperation.get(operationIdentity(operation));
        for (const candidate of candidates || []) matching.add(candidate);
      }
    } else {
      const identical = byId.get(previous.id);
      if (identical) matching.add(identical);
      for (const entity of previous.related_entities || []) {
        for (const candidate of byEntity.get(entity) || []) matching.add(candidate);
      }
      for (const candidate of currentCandidates) {
        if (options.subjectsMatch(previous, candidate)) matching.add(candidate);
      }
    }
    if (matching.size === 0 && !canonicalEvidence) continue;
    const candidates = [...matching];
    const previousOperationKeys = new Set(previousOperations.map(operationIdentity));
    const operations = canonicalEvidence ? previousOperations.map(operation => ({ ...operation })) : [...new Map(candidates.flatMap(candidate => candidate.operations || [])
      .filter(operation => previousOperations.length === 0 || previousOperationKeys.has(operationIdentity(operation)))
      .map(operation => [operationIdentity(operation), operation])).values()];
    const operationIds = new Set(operations.map(operation => operation.entry_point_id));
    const currentEntities = new Set(candidates.flatMap(candidate => candidate.related_entities || []));
    reused.push({
      ...previous,
      description_source: 'reused',
      description_generation: {
        status: 'reused_previous',
        attempted: false,
        reason: previous.description_generation?.status,
        generated_at: new Date().toISOString(),
        validation_version: previous.description_generation?.validation_version,
        origin_source: previous.description_generation?.origin_source
          || (previous.description_source === 'ai' ? 'ai'
            : previous.description_source === 'manual' ? 'manual'
              : previous.description_source === 'deterministic' ? 'deterministic'
                : previous.description_generation?.reason === 'ai_applied' ? 'ai' : undefined),
      },
      related_domains: canonicalEvidence ? [...previous.related_domains] : [...new Set(candidates.flatMap(candidate => candidate.related_domains || []))],
      related_entities: canonicalEvidence ? [...previous.related_entities] : previous.related_entities?.length
        ? previous.related_entities.filter(entity => currentEntities.has(entity)) : [...currentEntities],
      operations,
      operation_evidence: (canonicalEvidence ? previous.operation_evidence || [] : candidates.flatMap(candidate => candidate.operation_evidence || []))
        .filter(evidence => operationIds.has(evidence.entry_point_id)),
      related_flows: canonicalEvidence ? [...(previous.related_flows || [])] : candidates.flatMap(candidate => candidate.related_flows || []),
      criticality_factors: [
        ...(previous.criticality_factors || []).filter(factor => !factor.startsWith('catalog-candidate:')),
        ...candidates.map(candidate => 'catalog-candidate:' + candidate.id),
      ],
    });
  }
  return reused;
}
