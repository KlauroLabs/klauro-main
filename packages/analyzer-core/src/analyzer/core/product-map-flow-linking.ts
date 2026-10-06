import { CASEntryPointFlow, SystemCapability } from '../../types/cas.types';

export function normalizeProductMapEntityName(name: string): string {
  return name.toLowerCase().replace(/^entity_/, '').replace(/[^a-z0-9]/g, '');
}

export function entryPointFlowPrimaryEntityNames(entryPointFlow: CASEntryPointFlow): Set<string> {
  const written = new Set<string>();
  for (const terminal of entryPointFlow.terminal_entities || []) {
    if (terminal.access !== 'read') written.add(normalizeProductMapEntityName(terminal.name));
  }
  for (const name of entryPointFlow.terminal_effects?.entities_written || []) {
    written.add(normalizeProductMapEntityName(name));
  }
  if (written.size > 0) return written;

  const read = new Set<string>();
  for (const terminal of entryPointFlow.terminal_entities || []) {
    read.add(normalizeProductMapEntityName(terminal.name));
  }
  for (const name of entryPointFlow.terminal_effects?.entities_read || []) {
    read.add(normalizeProductMapEntityName(name));
  }
  return read;
}

export function linkEntryPointFlowsToCapability(
  capability: SystemCapability,
  capabilityEntityNames: string[],
  exclusivelyOwnedEntityNames: ReadonlySet<string>,
  entryPointFlows: CASEntryPointFlow[],
  primaryNamesByEntryPointFlow: Map<string, Set<string>>,
): CASEntryPointFlow[] {
  const entryPointIds = new Set(capability.operations.map(operation => operation.entry_point_id));
  const capabilityEntities = new Set(capabilityEntityNames.map(normalizeProductMapEntityName));
  const linkedByComprehension = entryPointFlows.some(entryPointFlow => (entryPointFlow.capability_relationships?.length ?? 0) > 0);

  return entryPointFlows.filter(entryPointFlow => {
    if (entryPointFlow.capability_relationships?.some(rel =>
      rel.capability_id === capability.id &&
      (rel.role === 'primary' || rel.evidence === 'operation' || rel.evidence === 'route')
    )) return true;
    if (entryPointIds.has(entryPointFlow.entry_point_id)) return true;
    if (linkedByComprehension || exclusivelyOwnedEntityNames.size === 0) return false;
    const primaryNames = primaryNamesByEntryPointFlow.get(entryPointFlow.id);
    return Boolean(primaryNames && [...primaryNames].some(name =>
      capabilityEntities.has(name) && exclusivelyOwnedEntityNames.has(name)));
  });
}
