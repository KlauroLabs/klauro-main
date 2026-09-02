import type { SystemCapability } from '../../types/cas.types';
import { isCrudInventoryCapabilityLabel } from './capability-naming';

export function demoteCoveredImplementationAggregates(
  candidates: readonly SystemCapability[],
  subjectTokensFor: (candidate: SystemCapability) => string[],
): SystemCapability[] {
  const isImplementationOperation = (operation: SystemCapability['operations'][number]): boolean =>
    /^(?:internal|task|lifecycle|file)$/i.test(String(operation.entry_point_type || ''));
  const operationKey = (operation: SystemCapability['operations'][number]): string => [
    operation.entry_point_id, operation.entry_point_type, operation.action,
    operation.path_or_command || '', operation.trigger?.method || '', operation.trigger?.path || '',
  ].join('|');
  return candidates.map(candidate => {
    if (candidate.evidence_role !== 'product-outcome') return candidate;
    const candidateSubjects = new Set(subjectTokensFor(candidate));
    const entityBackedOutcome = (candidate.evidence_kind === 'behavior-surface' || isCrudInventoryCapabilityLabel(candidate.name)) &&
      (candidate.related_entities || []).length === 0 &&
      candidates.some(other => other.id !== candidate.id && (other.related_entities || []).length > 0 &&
        subjectTokensFor(other).some(subject => subject.length >= 5 && candidateSubjects.has(subject)));
    if (entityBackedOutcome) return {
      ...candidate, evidence_role: 'supporting-mechanism',
      evidence_role_reasons: [...(candidate.evidence_role_reasons || []), 'entity-free-subflow-covered-by-entity-evidence'],
    };
    const operations = candidate.operations || [];
    const publicOperations = operations.filter(operation => !isImplementationOperation(operation));
    if (publicOperations.length === 0) return candidate;
    const narrowerOperationKeys = new Set(candidates
      .filter(other => other.id !== candidate.id && other.evidence_role === 'product-outcome' &&
        (other.operations || []).length > 0 && (other.operations || []).length < operations.length &&
        (other.operations || []).every(operation => !isImplementationOperation(operation)))
      .flatMap(other => (other.operations || []).map(operationKey)));
    if (!publicOperations.every(operation => narrowerOperationKeys.has(operationKey(operation)))) return candidate;
    return {
      ...candidate, evidence_role: 'supporting-mechanism',
      evidence_role_reasons: [...(candidate.evidence_role_reasons || []), 'public-surface-covered-by-specific-outcomes'],
    };
  });
}
