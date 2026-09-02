import type { SystemCapability } from '../../types/cas.types';
import { observedCapabilityLifecycleActions } from './capability-lifecycle-actions';

export interface CapabilityFamilySemantics {
  isGenericToken: (token: string) => boolean;
  normalizeToken: (token: string) => string;
}

const actionTokens = new Set([
  'view', 'get', 'list', 'read', 'show', 'access', 'manage', 'create', 'update',
  'delete', 'modify', 'write', 'process', 'handle', 'coordinate', 'provide',
  'support', 'execute', 'run', 'perform', 'track', 'monitor',
]);

function operationKeys(capability: SystemCapability): Set<string> {
  return new Set((capability.operations || []).map(operation => [
    operation.entry_point_id, operation.entry_point_type, operation.action,
    operation.path_or_command || '', operation.trigger?.method || '', operation.trigger?.path || '',
  ].join('|')));
}

function operationFamiliesCanMerge(left: SystemCapability, right: SystemCapability): boolean {
  const leftOperations = operationKeys(left);
  const rightOperations = operationKeys(right);
  if (leftOperations.size === 0 || rightOperations.size === 0) return true;
  return [...leftOperations].some(operation => rightOperations.has(operation));
}

const resourceLifecycleActions = new Set([
  'access', 'add', 'archive', 'create', 'delete', 'edit', 'get', 'list', 'modify',
  'read', 'remove', 'show', 'update', 'view', 'write',
]);

function operationsFormResourceLifecycle(left: SystemCapability, right: SystemCapability): boolean {
  const actions = observedCapabilityLifecycleActions([
    ...(left.operations || []),
    ...(right.operations || []),
  ]);
  return actions.length > 0 && actions.every(action => resourceLifecycleActions.has(action));
}

export function groupCapabilityCatalogFamilies(
  candidates: SystemCapability[], semantics: CapabilityFamilySemantics,
): SystemCapability[][] {
  candidates = candidates.filter(candidate => {
    const hasEntityEvidence = (candidate.related_entities?.length || 0) > 0;
    const operations = candidate.operations || [];
    const pageOnly = operations.length > 0 && operations.every(operation =>
      operation.entry_point_type === 'page' || operation.entry_point_type === 'route');
    const externalOnly = operations.length > 0 && operations.every(operation => operation.entry_point_type === 'external');
    return !externalOnly && (!pageOnly || candidate.category === 'core' || hasEntityEvidence);
  });
  if (candidates.length === 0) return [];
  const tokenize = (name: string): string[] => name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/)
    .map(semantics.normalizeToken)
    .filter(token => token.length >= 4 && !actionTokens.has(token) && !semantics.isGenericToken(token));
  const rawTokens = candidates.map(candidate => new Set(tokenize(String(candidate.name || ''))));
  const tokenFrequency = new Map<string, number>();
  for (const candidateTokens of rawTokens) {
    for (const token of candidateTokens) tokenFrequency.set(token, (tokenFrequency.get(token) || 0) + 1);
  }
  const nonDiscriminativeTokens = new Set(candidates.length >= 3
    ? [...tokenFrequency.entries()].filter(([, frequency]) => frequency > candidates.length / 2).map(([token]) => token)
    : []);
  const tokens = rawTokens.map(candidateTokens => new Set([...candidateTokens].filter(token => !nonDiscriminativeTokens.has(token))));
  const entities = candidates.map(candidate => new Set((candidate.related_entities || []).map(value => String(value).toLowerCase())));
  const parent = candidates.map((_, index) => index);
  const find = (index: number): number => parent[index] === index ? index : (parent[index] = find(parent[index]));
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  const tokenSetsOverlap = (left: Set<string>, right: Set<string>): boolean => {
    for (const a of left) {
      for (const b of right) {
        if (a === b || (Math.min(a.length, b.length) >= 5 && (a.includes(b) || b.includes(a)))) return true;
      }
    }
    return false;
  };
  for (let left = 0; left < candidates.length; left++) {
    for (let right = left + 1; right < candidates.length; right++) {
      const operationOverlap = operationFamiliesCanMerge(candidates[left], candidates[right]);
      const subjectOverlap = tokenSetsOverlap(tokens[left], tokens[right]);
      const sharedEntities = [...entities[left]].filter(value => entities[right].has(value));
      const identicalSubjects = tokens[left].size === tokens[right].size &&
        [...tokens[left]].every(token => tokens[right].has(token));
      const distinctiveEntityOverlap = sharedEntities.some(value => value.replace(/^entity[_:-]?/, '')
        .split(/[^a-z0-9]+/).some(token => token.length >= 4 && !semantics.isGenericToken(token)));
      const bothBehaviorSurfaces = candidates[left].evidence_kind === 'behavior-surface' &&
        candidates[right].evidence_kind === 'behavior-surface';
      const sharedResourceLifecycle = !bothBehaviorSurfaces && distinctiveEntityOverlap &&
        operationsFormResourceLifecycle(candidates[left], candidates[right]);
      if ((operationOverlap && (subjectOverlap || (!bothBehaviorSurfaces && sharedEntities.length > 0 &&
        (distinctiveEntityOverlap || tokens[left].size === 0 || tokens[right].size === 0)))) ||
        sharedResourceLifecycle || (subjectOverlap && !identicalSubjects && operationsFormResourceLifecycle(candidates[left], candidates[right]))) union(left, right);
    }
  }
  const roots = new Set<number>();
  for (let index = 0; index < candidates.length; index++) {
    const evidenceAnchoredProductCandidate = candidates[index].evidence_kind !== 'behavior-surface' &&
      (entities[index].size > 0 || (candidates[index].operations || []).length > 0);
    if (tokens[index].size > 0 || evidenceAnchoredProductCandidate) roots.add(find(index));
  }
  return [...roots].map(root => candidates.filter((_, index) => find(index) === root));
}
