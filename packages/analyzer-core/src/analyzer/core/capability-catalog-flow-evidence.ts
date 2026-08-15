import { CASCapability, CASOperation, SystemCapability } from '../../types/cas.types';

function operationKey(operation: SystemCapability['operations'][number]): string {
  return `${operation.entry_point_id}\u0000${operation.action}\u0000${operation.path_or_command || ''}`;
}

function mapOperation(operation: CASOperation): SystemCapability['operations'][number] {
  const pathOrCommand = operation.trigger?.path || operation.trigger?.command;
  return {
    entry_point_id: operation.entry_point_id || operation.id,
    entry_point_type: operation.trigger?.type || (operation.trigger?.method ? 'http' : 'internal'),
    action: operation.pattern,
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
  const merged = new Map<string, SystemCapability>(candidates.map(candidate => [candidate.id, {
    ...candidate,
    operations: [...(candidate.operations || [])],
    related_entities: [...(candidate.related_entities || [])],
    related_domains: [...(candidate.related_domains || [])],
    criticality_factors: [...(candidate.criticality_factors || [])],
    evidence_examples: [...(candidate.evidence_examples || [])],
    depends_on: [...(candidate.depends_on || [])],
  }] as [string, SystemCapability]));
  for (const flowCandidate of flowCandidates) {
    const mapped = mapFlowCapability(flowCandidate);
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
      description: existing.description || mapped.description,
      operations: [...operations.values()],
      related_entities: [...new Set([...existing.related_entities, ...mapped.related_entities])],
      criticality_factors: [...new Set([...existing.criticality_factors, ...mapped.criticality_factors])],
      evidence_examples: [...new Set([...(existing.evidence_examples || []), ...(mapped.evidence_examples || [])])],
      depends_on: [...new Map([...(existing.depends_on || []), ...(mapped.depends_on || [])]
        .map(dependency => [`${dependency.from_capability}\u0000${dependency.to_capability}\u0000${dependency.dependency_type}`, dependency])).values()],
    });
  }
  return [...merged.values()];
}
