import type { CASDataEntity, CASEntryPoint, SystemCapability } from '../../types/cas.types';

function normalizedEntityTokens(value: string): string[] {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 3)
    .map(token => token.length > 4 && token.endsWith('ies')
      ? `${token.slice(0, -3)}y`
      : token.length > 4 && token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token);
}

function operationMatchesEntryPoint(
  operation: SystemCapability['operations'][number],
  entryPoint: CASEntryPoint,
): boolean {
  if (operation.entry_point_id !== entryPoint.id) return false;
  const operationMethod = String(operation.trigger?.method || '').toUpperCase();
  const entryMethod = String(entryPoint.trigger?.method || '').toUpperCase();
  const operationPath = String(operation.trigger?.path || operation.path_or_command || '');
  const entryPath = String(entryPoint.trigger?.path || '');
  return Boolean(operationPath && entryPath && operationPath === entryPath && operationMethod === entryMethod);
}

function directlyRelated(left: CASDataEntity, right: CASDataEntity): boolean {
  const leftName = normalizedEntityTokens(left.name).join(' ');
  const rightName = normalizedEntityTokens(right.name).join(' ');
  return (left.relations || []).some(relation => normalizedEntityTokens(relation.target_name).join(' ') === rightName) ||
    (right.relations || []).some(relation => normalizedEntityTokens(relation.target_name).join(' ') === leftName);
}

export function capabilityGroundedEntityIds(
  capability: SystemCapability,
  entities: readonly CASDataEntity[],
  entryPoints: readonly CASEntryPoint[],
): Set<string> {
  const owned = new Set(capability.related_entities || []);
  const ownedEntities = entities.filter(entity => owned.has(entity.id));
  const entryPointById = new Map(entryPoints.map(entryPoint => [entryPoint.id, entryPoint]));
  if (ownedEntities.length === 0 || capability.operations.length === 0) return owned;
  const matchedEntries = capability.operations.map(operation => {
    const entryPoint = entryPointById.get(operation.entry_point_id);
    return entryPoint && operationMatchesEntryPoint(operation, entryPoint) ? entryPoint : undefined;
  });
  if (matchedEntries.some(entryPoint => !entryPoint)) return owned;
  for (const candidate of entities) {
    if (owned.has(candidate.id) || !ownedEntities.some(entity => directlyRelated(entity, candidate))) continue;
    const candidateTokens = normalizedEntityTokens(candidate.name);
    if (candidateTokens.length === 0) continue;
    const appearsInEveryRoute = matchedEntries.every(entryPoint => {
      const routeTokens = normalizedEntityTokens(entryPoint?.trigger?.path || '');
      const candidateIndexes = candidateTokens.map(token => routeTokens.indexOf(token));
      if (candidateIndexes.some(index => index < 0)) return false;
      const candidateBoundary = Math.max(...candidateIndexes);
      return ownedEntities.some(entity => {
        const childIndexes = normalizedEntityTokens(entity.name).map(token => routeTokens.indexOf(token));
        return childIndexes.length > 0 &&
          childIndexes.every(index => index > candidateBoundary);
      });
    });
    if (appearsInEveryRoute) owned.add(candidate.id);
  }
  return owned;
}
