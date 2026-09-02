import type { CASEntryPoint, SystemCapability } from '../../types/cas.types';
import { USER_FACING_ENTRY_TYPES } from './journey-builder';

export function capabilityHasReversibleUserActionLifecycle(
  capability: SystemCapability,
  entryPointById: ReadonlyMap<string, CASEntryPoint>,
): boolean {
  const methodsByPath = new Map<string, Set<string>>();
  for (const operation of capability.operations || []) {
    const entryPoint = entryPointById.get(operation.entry_point_id);
    const external = entryPoint?.interaction_reach === 'external' ||
      (entryPoint?.interaction_reach !== 'internal' &&
        USER_FACING_ENTRY_TYPES.has((entryPoint?.type || operation.entry_point_type) as never));
    if (!external) continue;
    const method = String(entryPoint?.trigger?.method || operation.trigger?.method || '').toUpperCase();
    if (!/^(?:POST|PUT|PATCH|DELETE)$/.test(method)) continue;
    const rawPath = String(entryPoint?.trigger?.path || operation.trigger?.path || operation.path_or_command || '')
      .split(/[?#]/, 1)[0]
      .replace(/\/+$/, '');
    const segments = rawPath.split('/').filter(Boolean);
    if (segments.length < 2) continue;
    const actionSegment = segments[segments.length - 1];
    const subjectSegment = segments[segments.length - 2];
    const actionIsStatic = !/^[:{[]/.test(actionSegment);
    const subjectIsDynamic = /^:/.test(subjectSegment) ||
      /^\{[^}]+\}$/.test(subjectSegment) ||
      /^\[[^\]]+\]$/.test(subjectSegment);
    if (!actionIsStatic || !subjectIsDynamic) continue;
    const normalizedPath = rawPath.replace(/\{[^}]+\}|:[^/]+|\[[^\]]+\]/g, ':parameter');
    const methods = methodsByPath.get(normalizedPath) || new Set<string>();
    methods.add(method);
    methodsByPath.set(normalizedPath, methods);
  }
  return [...methodsByPath.values()].some(methods =>
    methods.has('DELETE') && (methods.has('POST') || methods.has('PUT') || methods.has('PATCH')));
}
