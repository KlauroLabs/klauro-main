import type { SystemCapability } from '../../types/cas.types';
import { canonicalCapabilityLifecycleAction } from './capability-lifecycle-actions';

type CapabilityOperation = SystemCapability['operations'][number];

function requestedOutcomeAction(name: string): string | undefined {
  const head = String(name || '').trim().toLowerCase().split(/\s+/)[0] || '';
  if (/^(?:create|add|publish|post|submit|register)$/.test(head)) return 'create';
  if (/^(?:read|view|list|browse|search|find|get)$/.test(head)) return 'read';
  if (/^(?:update|edit|change)$/.test(head)) return 'update';
  if (/^(?:delete|remove|archive)$/.test(head)) return 'delete';
  if (/^(?:comment|favorite|follow|unfavorite|unfollow)$/.test(head)) return head;
  return undefined;
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

export function scopeCapabilityOperationsToOutcomeName(
  name: string,
  operations: readonly CapabilityOperation[],
): CapabilityOperation[] {
  const requested = requestedOutcomeAction(name);
  if (!requested) return [...operations];
  const matching = operations.filter(operation => operationMatchesRequestedAction(operation, requested));
  return matching.length > 0 ? matching : [...operations];
}
