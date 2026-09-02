import type { SystemCapability } from '../../types/cas.types';

export interface CapabilityCatalogPromptEvidence {
  name: string;
  operations: string[];
  relationships: string[];
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
  const structuralTokens = new Set(
    capability.evidence_kind === 'behavior-surface'
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
    name: capability.evidence_kind === 'behavior-surface' && projectedOperations.length > 0
      ? projectedOperations.join(', ')
      : humanize(capability.name),
    operations: projectedOperations,
    relationships,
  };
}
