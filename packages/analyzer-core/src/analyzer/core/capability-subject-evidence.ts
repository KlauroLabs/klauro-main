import type { SystemCapability } from '../../types/cas.types';
import { outcomeIdentityTokens } from './capability-evidence-language';

export function retainedCapabilityOperationEvidence(
  capability: Pick<SystemCapability, 'operations' | 'operation_evidence'>,
): NonNullable<SystemCapability['operation_evidence']> {
  const retainedEntryIds = new Set(capability.operations.map(operation => operation.entry_point_id));
  return [...new Map((capability.operation_evidence || [])
    .filter(evidence => evidence.source_node_id && retainedEntryIds.has(evidence.entry_point_id))
    .map(evidence => [
      JSON.stringify([evidence.entry_point_id, evidence.source_node_id, evidence.text]), evidence,
    ] as const)).values()];
}

export function capabilityOperationEvidenceTexts(
  capability: Pick<SystemCapability, 'operations' | 'operation_evidence' | 'evidence_examples'>,
): string[] {
  return capability.operation_evidence
    ? retainedCapabilityOperationEvidence(capability).map(evidence => evidence.text)
    : capability.evidence_examples || [];
}

export function capabilityEvidenceSubjectTokens(
  candidate: SystemCapability,
  entityNames: readonly string[] = [],
): string[] {
  const ignored = new Set([
    'analyze', 'api', 'app', 'cap', 'check', 'entry', 'extend', 'fetch', 'get', 'id', 'identifier', 'install', 'internal', 'list', 'load', 'mcp', 'model',
    'preview', 'read', 'record', 'release', 'route', 'router', 'run', 'show', 'slug', 'start', 'stop', 'supporting', 'sync', 'system', 'username', 'validate', 'value',
  ]);
  const tokens = outcomeIdentityTokens([
    candidate.name,
    candidate.structural_label,
    ...(candidate.related_domains || []),
    ...entityNames,
    ...(candidate.evidence_kind === 'behavior-surface' ? [] : (candidate.operations || []).flatMap(operation => [
      operation.path_or_command,
      operation.trigger?.path,
    ])),
    ...(candidate.depends_on || []).flatMap(dependency => [
      dependency.description,
      ...(dependency.evidence.shared_entities || []),
    ]),
  ].filter(Boolean).join(' ')).filter(token => !ignored.has(token));
  const examples = capabilityOperationEvidenceTexts(candidate);
  const minimumOccurrences = candidate.operation_evidence ? 1 : Math.min(2, examples.length || 1);
  const exampleCounts = new Map<string, number>();
  for (const example of examples) {
    for (const token of new Set(outcomeIdentityTokens(example).filter(value => !ignored.has(value)))) {
      exampleCounts.set(token, (exampleCounts.get(token) || 0) + 1);
    }
  }
  const supportedExampleTokens = [...exampleCounts.entries()]
    .filter(([, count]) => count >= minimumOccurrences)
    .map(([token]) => token);
  return [...new Set([...tokens, ...supportedExampleTokens])].sort();
}
