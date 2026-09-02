import { CASCapability, CASOperation, SystemCapability } from '../../types/cas.types';

function dependencyKey(dependency: NonNullable<SystemCapability['depends_on']>[number]): string {
  return `${dependency.from_capability}\u0000${dependency.to_capability}\u0000${dependency.dependency_type}`;
}

function normalizedEntityName(value: string): string {
  return value
    .replace(/^entity[_:-]?/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/s$/, '');
}

function operationKey(operation: SystemCapability['operations'][number]): string {
  return `${operation.entry_point_id}\u0000${operation.action}\u0000${operation.path_or_command || ''}`;
}

function mapOperation(operation: CASOperation): SystemCapability['operations'][number] {
  const pathOrCommand = operation.trigger?.path || operation.trigger?.command;
  const pageAction = operation.trigger?.type === 'page'
    ? /\b(?:auth(?:enticate)?|log[ _-]?in|sign[ _-]?in)\b/i.test(operation.name) ? 'Authenticate' : 'View'
    : undefined;
  return {
    entry_point_id: operation.entry_point_id || operation.id,
    entry_point_type: operation.trigger?.type || (operation.trigger?.method ? 'http' : 'internal'),
    action: pageAction || operation.pattern,
    ...(pathOrCommand ? { path_or_command: pathOrCommand } : {}),
    ...(operation.trigger ? { trigger: { method: operation.trigger.method, path: operation.trigger.path } } : {}),
  };
}

function mapFlowCapability(capability: CASCapability): SystemCapability {
  return {
    id: capability.id,
    name: capability.name,
    structural_label: capability.name,
    description: capability.description,
    evidence_kind: 'behavior-surface',
    category: capability.classification === 'primary'
      ? 'core'
      : capability.classification === 'infrastructure'
        ? 'internal'
        : 'supporting',
    operations: capability.operations.map(mapOperation),
    related_entities: [...(capability.entities_touched || [])],
    related_domains: [],
    criticality: capability.criticality,
    criticality_factors: [`flow-graph:${capability.classification}`],
    evidence_examples: capability.operations.map(operation => operation.name).filter(Boolean),
    depends_on: capability.depends_on,
  };
}

export function mergeCapabilityCatalogFlowEvidence(
  candidates: SystemCapability[],
  flowCandidates: CASCapability[],
): SystemCapability[] {
  const structuralCandidateIds = new Set(candidates.map(candidate => candidate.id));
  const merged = new Map<string, SystemCapability>(candidates.map(candidate => [candidate.id, {
    ...candidate,
    operations: [...(candidate.operations || [])],
    related_entities: [...(candidate.related_entities || [])],
    related_domains: [...(candidate.related_domains || [])],
    criticality_factors: [...(candidate.criticality_factors || [])],
    evidence_examples: [...(candidate.evidence_examples || [])],
    depends_on: [...(candidate.depends_on || [])],
  }] as [string, SystemCapability]));
  const mappedFlowCandidates = flowCandidates.map(mapFlowCapability);
  for (const mapped of mappedFlowCandidates) {
    const existing = merged.get(mapped.id);
    if (!existing) {
      merged.set(mapped.id, mapped);
      continue;
    }
    const operations = new Map(existing.operations.map(operation => [operationKey(operation), operation]));
    for (const operation of mapped.operations) operations.set(operationKey(operation), operation);
    merged.set(mapped.id, {
      ...existing,
      structural_label: existing.structural_label || mapped.structural_label,
      evidence_kind: existing.evidence_kind || mapped.evidence_kind,
      description: existing.description || mapped.description,
      operations: [...operations.values()],
      related_entities: [...new Set([...existing.related_entities, ...mapped.related_entities])],
      criticality_factors: [...new Set([...existing.criticality_factors, ...mapped.criticality_factors])],
      evidence_examples: [...new Set([...(existing.evidence_examples || []), ...(mapped.evidence_examples || [])])],
      depends_on: [...new Map([...(existing.depends_on || []), ...(mapped.depends_on || [])]
        .map(dependency => [dependencyKey(dependency), dependency])).values()],
    });
  }
  const relationshipDependencies = (flow: SystemCapability) => (flow.depends_on || [])
    .filter(dependency => (dependency.evidence.shared_entities || []).length > 0);
  const dependencyPair = (dependency: NonNullable<SystemCapability['depends_on']>[number]) =>
    [...new Set((dependency.evidence.shared_entities || []).map(normalizedEntityName).filter(Boolean))]
      .sort()
      .join('\u0000');
  const flowOwnsEntity = (flow: SystemCapability, entity: string) => {
    const observableLabels = [flow.id, flow.name, ...(flow.operations || []).flatMap(operation => [
      operation.path_or_command || '', operation.action || '',
    ])];
    if (observableLabels.some(label => normalizedEntityName(label).split(' ').includes(entity))) return true;
    if ((flow.operations || []).length > 4) return false;
    const touchesEntity = (flow.related_entities || []).map(normalizedEntityName).includes(entity);
    return touchesEntity && relationshipDependencies(flow).some(dependency =>
      (dependency.evidence.shared_entities || []).map(normalizedEntityName).includes(entity));
  };
  const isSingleSubjectFanout = (dependencies: NonNullable<SystemCapability['depends_on']>) => {
    if (dependencies.length < 4) return false;
    const entitySets = dependencies.map(dependency => new Set(
      (dependency.evidence.shared_entities || []).map(normalizedEntityName).filter(Boolean),
    ));
    const [first, ...rest] = entitySets;
    return [...(first || [])].some(entity => rest.every(entities => entities.has(entity)));
  };
  for (const [candidateId, candidate] of merged) {
    if (!structuralCandidateIds.has(candidateId)) continue;
    const candidateEntities = new Set((candidate.related_entities || []).map(normalizedEntityName).filter(Boolean));
    if (candidateEntities.size === 0) continue;
    const ownedFlows = mappedFlowCandidates.filter(flow =>
      [...candidateEntities].some(entity => flowOwnsEntity(flow, entity)));
    const ownedDependencies = ownedFlows.flatMap(relationshipDependencies);
    const ownedPairs = new Set(ownedDependencies.map(dependencyPair).filter(Boolean));
    const bridgedDependencies = mappedFlowCandidates
      .filter(flow => !ownedFlows.includes(flow))
      .flatMap(flow => {
        const dependencies = relationshipDependencies(flow);
        if (isSingleSubjectFanout(dependencies) || (flow.operations || []).length > 4) return [];
        return dependencies.some(dependency => ownedPairs.has(dependencyPair(dependency))) ? dependencies : [];
      });
    const connectedDependencies = [...ownedDependencies, ...bridgedDependencies];
    if (connectedDependencies.length === 0) continue;
    merged.set(candidateId, {
      ...candidate,
      depends_on: [...new Map([...(candidate.depends_on || []), ...connectedDependencies]
        .map(dependency => [dependencyKey(dependency), dependency])).values()],
    });
  }
  return [...merged.values()];
}
