import type { SystemCapability } from '../../types/cas.types';
import { canonicalCapabilityLifecycleAction } from './capability-lifecycle-actions';
import { retainedCapabilityOperationEvidence } from './capability-subject-evidence';

export function resolveCapabilityOperationCitations(
  entryPointIds: unknown,
  candidates: readonly SystemCapability[],
): { ok: true; candidates: SystemCapability[]; explicit: boolean } | { ok: false; reason: string } {
  if (entryPointIds === undefined) {
    return candidates.some(candidate => new Set(candidate.operations.map(operation => operation.entry_point_id)).size > 1)
      ? { ok: false, reason: 'missing-operation-citation' }
      : { ok: true, candidates: [...candidates], explicit: false };
  }
  if (!Array.isArray(entryPointIds) || entryPointIds.some(id => typeof id !== 'string' || !id)) {
    return { ok: false, reason: 'invalid-operation-citation' };
  }
  const selected = new Set<string>(entryPointIds);
  const available = new Set(candidates.flatMap(candidate => candidate.operations.map(operation => operation.entry_point_id)));
  if ([...selected].some(id => !available.has(id))) return { ok: false, reason: 'unknown-operation-citation' };
  if (candidates.some(candidate => candidate.operations.length > 0 &&
      !candidate.operations.some(operation => selected.has(operation.entry_point_id)))) {
    return { ok: false, reason: 'candidate-operation-citation-missing' };
  }
  return {
    ok: true, explicit: true,
    candidates: candidates.map(candidate => {
      const operations = candidate.operations.filter(operation => selected.has(operation.entry_point_id));
      return {
        ...candidate, operations,
        ...(candidate.operation_evidence !== undefined
          ? { operation_evidence: retainedCapabilityOperationEvidence({ operations, operation_evidence: candidate.operation_evidence }) }
          : {}),
      };
    }),
  };
}

type CapabilityOperation = SystemCapability['operations'][number];

export function capabilityOperationCitationIds(factors: readonly string[]): Set<string> {
  return new Set(factors.filter(factor => factor.startsWith('catalog-operation-entry:'))
    .map(factor => factor.slice('catalog-operation-entry:'.length)));
}

export function hasExactCapabilityOperationCitations(capability: SystemCapability): boolean {
  const selected = capabilityOperationCitationIds(capability.criticality_factors || []);
  const observed = new Set(capability.operations.map(operation => operation.entry_point_id));
  return selected.size > 0 && selected.size === observed.size && [...selected].every(id => observed.has(id));
}

export function preserveCapabilityOperationCitations(capability: SystemCapability): SystemCapability {
  const selected = capabilityOperationCitationIds(capability.criticality_factors || []);
  if (selected.size === 0) return capability;
  const operations = capability.operations.filter(operation => selected.has(operation.entry_point_id));
  return {
    ...capability, operations,
    ...(capability.operation_evidence !== undefined
      ? { operation_evidence: retainedCapabilityOperationEvidence({ operations, operation_evidence: capability.operation_evidence }) }
      : {}),
  };
}

export function isReadOnlyCapabilityOutcomeName(name: string): boolean {
  return /^(?:browse|get|list|read|retrieve|show|view)\b/i.test(String(name || '').trim());
}

function requestedOutcomeActions(name: string): string[] {
  const actions = String(name || '').trim().toLowerCase().split(/[^a-z]+/).flatMap(token => {
    if (/^(?:create|add|attach|publish|post|submit|register)$/.test(token)) return token === 'attach' ? ['create', 'update'] : ['create'];
    if (isReadOnlyCapabilityOutcomeName(token) || /^(?:search|find|filter)$/.test(token)) return ['read'];
    if (/^(?:update|edit|change|categorize|assign)$/.test(token)) return ['update'];
    if (/^(?:delete|remove|archive)$/.test(token)) return ['delete'];
    if (/^(?:comment|favorite|follow|unfavorite|unfollow)$/.test(token)) return [token];
    return [];
  });
  return [...new Set(actions)];
}

function operationMatchesRequestedAction(operation: CapabilityOperation, requested: string): boolean {
  const observed = canonicalCapabilityLifecycleAction(operation);
  const method = String(operation.trigger?.method || '').toUpperCase();
  const path = String(operation.trigger?.path || operation.path_or_command || '').toLowerCase();
  if (requested === 'create') return observed === 'create' || (method === 'POST' && !/(?:auth|login|sign[ _-]?in|token)/.test(path));
  if (requested === 'read') return observed === 'read' || /^(?:GET|HEAD|OPTIONS)$/.test(method);
  if (requested === 'update') return observed === 'update' || /^(?:PUT|PATCH)$/.test(method);
  if (requested === 'delete') return observed === 'delete' || method === 'DELETE';
  if (requested === 'comment') return method === 'POST' && /(?:^|\/)comments?(?:\/|$)/.test(path);
  if (requested === 'favorite') return method === 'POST' && /(?:^|\/)favou?rite(?:\/|$)/.test(path);
  if (requested === 'follow') return method === 'POST' && /(?:^|\/)follow(?:\/|$)/.test(path);
  if (requested === 'unfavorite') return method === 'DELETE' && /(?:^|\/)favou?rite(?:\/|$)/.test(path);
  if (requested === 'unfollow') return method === 'DELETE' && /(?:^|\/)follow(?:\/|$)/.test(path);
  return false;
}

export function isReversibleCapabilityOutcomeName(name: string): boolean {
  return /\b(?:favou?rite|unfavou?rite|follow|unfollow)\b/i.test(name);
}

export function scopeCapabilityOperationsToOutcomeName(
  name: string,
  operations: readonly CapabilityOperation[],
): CapabilityOperation[] {
  const requested = requestedOutcomeActions(name);
  if (requested.length === 0) return [...operations];
  const matching = operations.filter(operation =>
    requested.some(action => operationMatchesRequestedAction(operation, action)));
  return matching.length > 0 ? matching : [...operations];
}

export function scopeCapabilityObligationFactors(
  name: string,
  factors: readonly string[],
): string[] {
  if (!isReversibleCapabilityOutcomeName(name)) return [...factors];
  return factors.filter(factor =>
    !factor.startsWith('catalog-operation-obligation:') &&
    !factor.startsWith('catalog-candidate:operation-obligation:'));
}

export function projectReversibleCapabilityEvidence(
  name: string,
  operations: readonly CapabilityOperation[],
  criticalityFactors: readonly string[],
): { operations: CapabilityOperation[]; criticalityFactors: string[] } {
  const selected = capabilityOperationCitationIds(criticalityFactors);
  return {
    operations: selected.size > 0 ? operations.filter(operation => selected.has(operation.entry_point_id)) : isReversibleCapabilityOutcomeName(name)
      ? scopeCapabilityOperationsToOutcomeName(name, operations)
      : [...operations],
    criticalityFactors: scopeCapabilityObligationFactors(name, criticalityFactors),
  };
}
