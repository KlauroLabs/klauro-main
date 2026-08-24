import { CASUserJourney, SystemCapability } from '../../types/cas.types';

export function normalizeProductMapEntityName(name: string): string {
  return name.toLowerCase().replace(/^entity_/, '').replace(/[^a-z0-9]/g, '');
}

export function journeyPrimaryEntityNames(journey: CASUserJourney): Set<string> {
  const written = new Set<string>();
  for (const terminal of journey.terminal_entities || []) {
    if (terminal.access !== 'read') written.add(normalizeProductMapEntityName(terminal.name));
  }
  for (const name of journey.terminal_effects?.entities_written || []) {
    written.add(normalizeProductMapEntityName(name));
  }
  if (written.size > 0) return written;

  const read = new Set<string>();
  for (const terminal of journey.terminal_entities || []) {
    read.add(normalizeProductMapEntityName(terminal.name));
  }
  for (const name of journey.terminal_effects?.entities_read || []) {
    read.add(normalizeProductMapEntityName(name));
  }
  return read;
}

export function linkJourneysToCapability(
  capability: SystemCapability,
  capabilityEntityNames: string[],
  exclusivelyOwnedEntityNames: ReadonlySet<string>,
  journeys: CASUserJourney[],
  primaryNamesByJourney: Map<string, Set<string>>,
): CASUserJourney[] {
  const entryPointIds = new Set(capability.operations.map(operation => operation.entry_point_id));
  const capabilityEntities = new Set(capabilityEntityNames.map(normalizeProductMapEntityName));

  return journeys.filter(journey => {
    if (journey.capability_relationships?.some(rel =>
      rel.capability_id === capability.id &&
      (rel.role === 'primary' || rel.evidence === 'operation' || rel.evidence === 'route')
    )) return true;
    if (entryPointIds.has(journey.entry_point_id)) return true;
    if (exclusivelyOwnedEntityNames.size === 0) return false;
    const primaryNames = primaryNamesByJourney.get(journey.id);
    return Boolean(primaryNames && [...primaryNames].some(name =>
      capabilityEntities.has(name) && exclusivelyOwnedEntityNames.has(name)));
  });
}
