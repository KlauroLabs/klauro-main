import type { CASEntryPoint, CASNode, SystemCapability } from '../../types/cas.types';
import { capabilityOperationEvidenceTexts } from './capability-subject-evidence';

export interface CapabilityCatalogPromptEvidence {
  name: string;
  operations: string[];
  relationships: string[];
  unresolved_entry_point_ids?: string[];
  declared_contracts?: Array<{
    entry_point_id: string;
    source_node_id: string;
    text: string;
    example_blocks_omitted: number;
  }>;
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

function declaredContractText(raw: string): { text: string; example_blocks_omitted: number } {
  const lines: string[] = [];
  let fence: string | undefined;
  let exampleBlocks = 0;
  for (const line of raw.split(/\r?\n/)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) { fence = marker[1]; exampleBlocks += 1; }
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined;
      continue;
    }
    if (!fence) lines.push(line);
  }
  return { text: lines.join('\n').trim(), example_blocks_omitted: exampleBlocks };
}

function declaredContracts(
  capability: SystemCapability,
  nodeById: ReadonlyMap<string, CASNode>,
  entryById?: ReadonlyMap<string, CASEntryPoint>,
): NonNullable<CapabilityCatalogPromptEvidence['declared_contracts']> {
  const entryIds = new Set(capability.operations.map(operation => operation.entry_point_id));
  const sources = capability.operation_evidence ?? capability.operations.flatMap(operation => {
    const entry = entryById?.get(operation.entry_point_id);
    return entry?.source_node ? [{ entry_point_id: entry.id, source_node_id: entry.source_node }] : [];
  });
  const contracts = sources.flatMap(evidence => {
    if (!entryIds.has(evidence.entry_point_id)) return [];
    const node = nodeById.get(evidence.source_node_id);
    if (!node) return [];
    const raw = node.documentation?.raw
      || [node.documentation?.summary, node.documentation?.description].filter(Boolean).join('\n\n');
    if (!raw) return [];
    const contract = declaredContractText(raw);
    return contract.text ? [{ entry_point_id: evidence.entry_point_id, source_node_id: node.id, ...contract }] : [];
  });
  return [...new Map(contracts.map(contract => [
    JSON.stringify([contract.entry_point_id, contract.source_node_id, contract.text]), contract,
  ])).values()];
}

export function capabilityCatalogValidationEvidence(
  capability: SystemCapability,
  nodeById: ReadonlyMap<string, CASNode>,
  entryById: ReadonlyMap<string, CASEntryPoint>,
): SystemCapability {
  const contracts = declaredContracts(capability, nodeById, entryById);
  if (contracts.length === 0) return capability;
  const records = [
    ...(capability.operation_evidence || []),
    ...contracts.map(({ entry_point_id, source_node_id, text }) => ({ entry_point_id, source_node_id, text })),
  ];
  return { ...capability, operation_evidence: [...new Map(records.map(record => [
    JSON.stringify([record.entry_point_id, record.source_node_id, record.text]), record,
  ])).values()] };
}

export function projectCapabilityCatalogPromptEvidence(
  capability: SystemCapability,
  nodeById: ReadonlyMap<string, CASNode> = new Map(),
  entryById?: ReadonlyMap<string, CASEntryPoint>,
): CapabilityCatalogPromptEvidence {
  const structuralApiGroup = capabilityCatalogStructuralApiLabels([capability]).length > 0;
  const structuralTokens = new Set(
    capability.evidence_kind === 'behavior-surface' || structuralApiGroup
      ? words(capability.structural_label || capability.name).map(normalized)
      : [],
  );
  const entryEvidence = capability.operation_evidence === undefined && entryById
    ? capability.operations.flatMap(operation => {
      const entry = entryById.get(operation.entry_point_id);
      return entry?.name ? [entry.name] : [];
    }) : [];
  const unresolvedEntryIds = entryById
    ? [...new Set(capability.operations.filter(operation => !entryById.has(operation.entry_point_id))
      .map(operation => operation.entry_point_id))]
    : [];
  const evidenceTexts = [...capabilityOperationEvidenceTexts(capability), ...entryEvidence];
  const operations = Array.from(new Set(
    evidenceTexts
      .map(example => words(example)
        .filter(word => !structuralTokens.has(normalized(word)))
        .join(' '))
      .filter(Boolean)
      .map(humanize),
  ));
  const actionFallback = Array.from(new Set(
    (capability.operations || [])
      .map(operation => humanize(operation.action || ''))
      .filter(Boolean),
  ));
  const projectedOperations = operations.length > 0 ? operations : actionFallback;
  const relationships = Array.from(new Set((capability.depends_on || []).map(dependency => {
    const sharedEntities = (dependency.evidence.shared_entities || []).map(humanize).filter(Boolean);
    return [humanize(dependency.description), sharedEntities.length > 0 ? `Shared subjects: ${sharedEntities.join(', ')}` : '']
      .filter(Boolean).join('. ');
  }).filter(Boolean)));
  const contracts = declaredContracts(capability, nodeById, entryById);
  return {
    name: (capability.evidence_kind === 'behavior-surface' || structuralApiGroup) && projectedOperations.length > 0
      ? projectedOperations.slice(0, 8).join(', ')
      : humanize(capability.name),
    operations: projectedOperations,
    relationships,
    ...(unresolvedEntryIds.length > 0 ? { unresolved_entry_point_ids: unresolvedEntryIds } : {}),
    ...(contracts.length > 0 ? { declared_contracts: contracts } : {}),
  };
}
