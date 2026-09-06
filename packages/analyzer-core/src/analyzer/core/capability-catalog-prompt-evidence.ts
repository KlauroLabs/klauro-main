import type { SystemCapability } from '../../types/cas.types';

export interface CapabilityCatalogPromptEvidence {
  name: string;
  operations: string[];
  relationships: string[];
}

export function capabilityCatalogStructuralApiLabels(candidates: readonly SystemCapability[]): string[] {
  return candidates.filter(candidate =>
    !candidate.name_source &&
    /\bAPI$/i.test(candidate.name) &&
    candidate.operations.length > 0 &&
    candidate.operations.every(operation => operation.entry_point_type === 'api' || operation.entry_point_type === 'rpc'),
  ).flatMap(candidate => [candidate.name, candidate.structural_label || ''].map(value => value.trim()).filter(Boolean));
}

function words(value: string): string[] {
  return String(value || '')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/s$/, '');
}

function humanize(value: string): string {
  const result = words(value).join(' ');
  return result ? result.charAt(0).toUpperCase() + result.slice(1) : '';
}

export function projectCapabilityCatalogPromptEvidence(
  capability: SystemCapability,
): CapabilityCatalogPromptEvidence {
  const structuralApiGroup = capabilityCatalogStructuralApiLabels([capability]).length > 0;
  const structuralTokens = new Set(
    capability.evidence_kind === 'behavior-surface' || structuralApiGroup
      ? words(capability.structural_label || capability.name).map(normalized)
      : [],
  );
  const operations = Array.from(new Set(
    (capability.evidence_examples || [])
      .map(example => words(example)
        .filter(word => !structuralTokens.has(normalized(word)))
        .join(' '))
      .filter(Boolean)
      .map(humanize),
  )).slice(0, 8);
  const actionFallback = Array.from(new Set(
    (capability.operations || [])
      .map(operation => humanize(operation.action || ''))
      .filter(Boolean),
  )).slice(0, 8);
  const projectedOperations = operations.length > 0 ? operations : actionFallback;
  const relationships = Array.from(new Set((capability.depends_on || []).map(dependency => {
    const sharedEntities = (dependency.evidence.shared_entities || []).map(humanize).filter(Boolean);
    return [humanize(dependency.description), sharedEntities.length > 0 ? `Shared subjects: ${sharedEntities.join(', ')}` : '']
      .filter(Boolean).join('. ');
  }).filter(Boolean))).slice(0, 8);
  return {
    name: (capability.evidence_kind === 'behavior-surface' || structuralApiGroup) && projectedOperations.length > 0
      ? projectedOperations.join(', ')
      : humanize(capability.name),
    operations: projectedOperations,
    relationships,
  };
}
