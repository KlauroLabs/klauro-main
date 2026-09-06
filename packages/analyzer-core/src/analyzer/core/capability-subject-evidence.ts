import type { SystemCapability } from '../../types/cas.types';
import { outcomeIdentityTokens } from './capability-evidence-language';

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
  const apiEntryIds = new Set((candidate.operations || [])
    .filter(operation => operation.entry_point_type === 'api' || operation.entry_point_type === 'rpc')
    .map(operation => operation.entry_point_id));
  const examples = candidate.operation_evidence
    ? candidate.operation_evidence
      .filter(evidence => evidence.source_node_id && apiEntryIds.has(evidence.entry_point_id))
      .map(evidence => evidence.text)
    : candidate.evidence_examples || [];
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
