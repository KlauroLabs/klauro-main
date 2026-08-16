import type {
  CASCapabilityDependency,
  CASDataEntity,
  FlowConcept,
  SystemCapability,
} from '../../types/cas.types';

type DependencyFlow = Pick<FlowConcept, 'flow_id' | 'capability_id' | 'capability_relationships'>;

interface DependencyPair {
  from: string;
  to: string;
  count: number;
  prerequisite: boolean;
}

export function rollupSystemCapabilityDependencies(
  flows: DependencyFlow[],
  capabilities: SystemCapability[],
  dataEntities: CASDataEntity[] = [],
): void {
  for (const capability of capabilities) {
    delete capability.depends_on;
    delete capability.depended_by;
  }
  const dependencyPairs = collectDependencyPairs(flows);
  if (dependencyPairs.size === 0) return;

  const capabilitiesById = new Map(capabilities.map(capability => [capability.id, capability]));
  const entitiesById = new Map(dataEntities.map(entity => [entity.id, entity]));
  const nodeIdsByCapability = capabilityNodeIds(capabilities);
  const dependenciesByCapability = new Map<string, CASCapabilityDependency[]>();
  const dependentsByCapability = new Map<string, Set<string>>();

  for (const pair of dependencyPairs.values()) {
    const dependency = resolveDependency(pair, capabilitiesById, entitiesById, nodeIdsByCapability);
    if (!dependency) continue;
    const outgoing = dependenciesByCapability.get(dependency.from_capability) || [];
    outgoing.push(dependency);
    dependenciesByCapability.set(dependency.from_capability, outgoing);
    const dependents = dependentsByCapability.get(dependency.to_capability) || new Set<string>();
    dependents.add(dependency.from_capability);
    dependentsByCapability.set(dependency.to_capability, dependents);
  }

  for (const capability of capabilities) {
    const dependencies = dependenciesByCapability.get(capability.id);
    if (dependencies?.length) capability.depends_on = dependencies;
    const dependents = dependentsByCapability.get(capability.id);
    if (dependents?.size) capability.depended_by = [...dependents];
  }
}

function collectDependencyPairs(flows: DependencyFlow[]): Map<string, DependencyPair> {
  const pairs = new Map<string, DependencyPair>();
  for (const flow of flows) {
    const relationships = flow.capability_relationships || [];
    const primary = relationships.find(relationship => relationship.role === 'primary')?.capability_id || flow.capability_id;
    if (!primary) continue;
    for (const relationship of relationships) {
      if (relationship.role === 'primary' || relationship.capability_id === primary) continue;
      const key = `${primary}\u0000${relationship.capability_id}`;
      const existing = pairs.get(key);
      if (existing) {
        existing.count += 1;
        existing.prerequisite ||= relationship.role === 'prerequisite';
      } else {
        pairs.set(key, {
          from: primary,
          to: relationship.capability_id,
          count: 1,
          prerequisite: relationship.role === 'prerequisite',
        });
      }
    }
  }
  return pairs;
}

function capabilityNodeIds(capabilities: SystemCapability[]): Map<string, Set<string>> {
  return new Map(capabilities.map(capability => [
    capability.id,
    new Set((capability.operations || [])
      .map(operation => operation.entry_point_id)
      .filter((id): id is string => Boolean(id?.startsWith('node:')))
      .map(id => id.slice('node:'.length))),
  ]));
}

function resolveDependency(
  pair: DependencyPair,
  capabilitiesById: Map<string, SystemCapability>,
  entitiesById: Map<string, CASDataEntity>,
  nodeIdsByCapability: Map<string, Set<string>>,
): CASCapabilityDependency | undefined {
  const fromCapability = capabilitiesById.get(pair.from);
  const toCapability = capabilitiesById.get(pair.to);
  if (!fromCapability || !toCapability) return undefined;
  const sharedEntities = (fromCapability.related_entities || [])
    .filter(entityId => (toCapability.related_entities || []).includes(entityId));
  const direction = pair.prerequisite
    ? { from: fromCapability, to: toCapability }
    : entityDependencyDirection(fromCapability, toCapability, sharedEntities, entitiesById, nodeIdsByCapability);
  if (!direction) return undefined;
  return {
    from_capability: direction.from.id,
    to_capability: direction.to.id,
    dependency_type: pair.prerequisite ? 'requires' : 'shares-data',
    strength: pair.prerequisite ? 'required' : pair.count > 2 ? 'common' : 'optional',
    evidence: {
      shared_services: [],
      shared_entities: sharedEntities.length ? sharedEntities : undefined,
      shared_nodes: [],
      call_count: pair.count,
    },
    description: `${pair.count} shared flow${pair.count > 1 ? 's' : ''} between "${direction.from.name}" and "${direction.to.name}"`,
  };
}

function entityDependencyDirection(
  from: SystemCapability,
  to: SystemCapability,
  sharedEntityIds: string[],
  entitiesById: Map<string, CASDataEntity>,
  nodeIdsByCapability: Map<string, Set<string>>,
): { from: SystemCapability; to: SystemCapability } | undefined {
  if (sharedEntityIds.some(entityId => writesForReads(from.id, to.id, entitiesById.get(entityId), nodeIdsByCapability))) {
    return { from: to, to: from };
  }
  if (sharedEntityIds.some(entityId => writesForReads(to.id, from.id, entitiesById.get(entityId), nodeIdsByCapability))) {
    return { from, to };
  }
  return undefined;
}

function writesForReads(
  producerId: string,
  consumerId: string,
  entity: CASDataEntity | undefined,
  nodeIdsByCapability: Map<string, Set<string>>,
): boolean {
  if (!entity) return false;
  const producerNodes = nodeIdsByCapability.get(producerId);
  const consumerNodes = nodeIdsByCapability.get(consumerId);
  if (!producerNodes?.size || !consumerNodes?.size) return false;
  const writers = [
    ...(entity.lifecycle?.created_by || []),
    ...(entity.lifecycle?.updated_by || []),
    ...(entity.lifecycle?.deleted_by || []),
  ];
  const producerWrites = writers.some(nodeId => producerNodes.has(nodeId));
  const consumerWrites = writers.some(nodeId => consumerNodes.has(nodeId));
  const consumerReads = (entity.lifecycle?.read_by || []).some(nodeId => consumerNodes.has(nodeId));
  return producerWrites && consumerReads && !consumerWrites;
}
