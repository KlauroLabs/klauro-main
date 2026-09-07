import type { SystemCapability } from '../../types/cas.types';
import { canonicalCapabilityLifecycleAction } from './capability-lifecycle-actions';

type CapabilityOperation = SystemCapability['operations'][number];

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
  return {
    operations: isReversibleCapabilityOutcomeName(name)
      ? scopeCapabilityOperationsToOutcomeName(name, operations)
      : [...operations],
    criticalityFactors: scopeCapabilityObligationFactors(name, criticalityFactors),
  };
}
