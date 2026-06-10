import {
  CASNode,
  CASEdge,
  CASEntryPoint,
  CASExitPoint,
  CASDataEntity,
  CASUserJourney,
  CASEntityLineage,
  CASEntityLineageAccessor,
  CASEntityLineageExternalRecipient,
  CASEntityLineageBoundary
} from '../../types/cas.types';

export interface DataLineageInput {
  nodes: CASNode[];
  edges: CASEdge[];
  dataEntities: CASDataEntity[];
  exitPoints: CASExitPoint[];
  entryPoints: CASEntryPoint[];
  userJourneys: CASUserJourney[];
}

const WRITE_EDGE_TYPES = new Set(['writes', 'creates', 'updates', 'deletes', 'persists', 'saves', 'mutates']);
const READ_EDGE_TYPES = new Set(['reads', 'queries']);
const CONTAINMENT_EDGE_TYPES = new Set(['contains', 'has_method', 'declares']);
const EXTERNAL_EXIT_TYPES = new Set(['api', 'sdk', 'message', 'event', 'webhook', 'analytics']);
const ENTITY_NODE_TYPES = /(^|[_\s])(entity|model)([_\s]|$)/;

interface LineageIndex {
  nodesById: Map<string, CASNode>;
  ownerByChild: Map<string, string>;
  childrenByOwner: Map<string, string[]>;
  writeEdgesByTarget: Map<string, CASEdge[]>;
  readEdgesByTarget: Map<string, CASEdge[]>;
  externalExitsBySource: Map<string, CASExitPoint[]>;
  exitPointsById: Map<string, CASExitPoint>;
  databaseExitsByResourceKey: Map<string, CASExitPoint[]>;
  entityNodeIdsByKey: Map<string, string[]>;
  journeysByEntityKey: Map<string, CASUserJourney[]>;
  journeysByEntityId: Map<string, CASUserJourney[]>;
}

export function buildDataLineage(input: DataLineageInput): CASEntityLineage[] {
  if (input.dataEntities.length === 0) return [];
  const index = buildLineageIndex(input);

  const lineages = input.dataEntities.map(entity => buildEntityLineage(entity, index));

  lineages.sort((a, b) =>
    exposureScore(b) - exposureScore(a) ||
    b.exposure.unguarded_paths - a.exposure.unguarded_paths ||
    (b.writers.length + b.readers.length) - (a.writers.length + a.readers.length) ||
    a.entity_name.localeCompare(b.entity_name)
  );

  return lineages;
}

export function exposureScore(lineage: CASEntityLineage): number {
  let score = 0;
  if (lineage.exposure.sensitive) score += 4;
  if (lineage.exposure.unguarded_paths > 0) score += 2;
  if (lineage.exposure.external_transfer) score += 1;
  return score;
}

function buildLineageIndex(input: DataLineageInput): LineageIndex {
  const nodesById = new Map(input.nodes.map(node => [node.id, node]));

  const ownerByChild = new Map<string, string>();
  const childrenByOwner = new Map<string, string[]>();
  const writeEdgesByTarget = new Map<string, CASEdge[]>();
  const readEdgesByTarget = new Map<string, CASEdge[]>();

  for (const edge of input.edges) {
    if (CONTAINMENT_EDGE_TYPES.has(edge.type)) {
      if (!ownerByChild.has(edge.target)) ownerByChild.set(edge.target, edge.source);
      const children = childrenByOwner.get(edge.source) || [];
      children.push(edge.target);
      childrenByOwner.set(edge.source, children);
    }
    if (WRITE_EDGE_TYPES.has(edge.type)) {
      const list = writeEdgesByTarget.get(edge.target) || [];
      list.push(edge);
      writeEdgesByTarget.set(edge.target, list);
    }
    if (READ_EDGE_TYPES.has(edge.type)) {
      const list = readEdgesByTarget.get(edge.target) || [];
      list.push(edge);
      readEdgesByTarget.set(edge.target, list);
    }
  }

  const externalExitsBySource = new Map<string, CASExitPoint[]>();
  const databaseExitsByResourceKey = new Map<string, CASExitPoint[]>();
  for (const exitPoint of input.exitPoints) {
    if (EXTERNAL_EXIT_TYPES.has(exitPoint.type) && exitPoint.source_node) {
      const list = externalExitsBySource.get(exitPoint.source_node) || [];
      list.push(exitPoint);
      externalExitsBySource.set(exitPoint.source_node, list);
    }
    if (exitPoint.type === 'database') {
      const resource = exitPoint.target?.resource || exitPoint.name;
      for (const key of entityNameKeys(resource)) {
        const list = databaseExitsByResourceKey.get(key) || [];
        list.push(exitPoint);
        databaseExitsByResourceKey.set(key, list);
      }
    }
  }
  const exitPointsById = new Map(input.exitPoints.map(exitPoint => [exitPoint.id, exitPoint]));

  const entityNodeIdsByKey = new Map<string, string[]>();
  for (const node of input.nodes) {
    if (!ENTITY_NODE_TYPES.test(node.type) && node.type !== 'class') continue;
    const key = normalizeEntityKey(node.name);
    if (!key) continue;
    const list = entityNodeIdsByKey.get(key) || [];
    list.push(node.id);
    entityNodeIdsByKey.set(key, list);
  }

  const journeysByEntityKey = new Map<string, CASUserJourney[]>();
  const journeysByEntityId = new Map<string, CASUserJourney[]>();
  const linkJourney = (map: Map<string, CASUserJourney[]>, key: string, journey: CASUserJourney) => {
    const list = map.get(key) || [];
    if (!list.includes(journey)) {
      list.push(journey);
      map.set(key, list);
    }
  };
  for (const journey of input.userJourneys) {
    for (const terminal of journey.terminal_entities || []) {
      if (terminal.entity_id) linkJourney(journeysByEntityId, terminal.entity_id, journey);
      for (const key of entityNameKeys(terminal.name)) linkJourney(journeysByEntityKey, key, journey);
    }
    const effectNames = [
      ...(journey.terminal_effects?.entities_written || []),
      ...(journey.terminal_effects?.entities_read || []),
    ];
    for (const name of effectNames) {
      for (const key of entityNameKeys(name)) linkJourney(journeysByEntityKey, key, journey);
    }
  }

  return {
    nodesById,
    ownerByChild,
    childrenByOwner,
    writeEdgesByTarget,
    readEdgesByTarget,
    externalExitsBySource,
    exitPointsById,
    databaseExitsByResourceKey,
    entityNodeIdsByKey,
    journeysByEntityKey,
    journeysByEntityId,
  };
}

function buildEntityLineage(entity: CASDataEntity, index: LineageIndex): CASEntityLineage {
  const sensitiveFields = (entity.fields || [])
    .filter(field => field.is_sensitive)
    .map(field => field.name)
    .sort();

  const writers = new Map<string, CASEntityLineageAccessor>();
  const readers = new Map<string, CASEntityLineageAccessor>();
  const recordAccessor = (map: Map<string, CASEntityLineageAccessor>, nodeId: string | undefined, via: string) => {
    if (!nodeId || map.has(nodeId)) return;
    const node = index.nodesById.get(nodeId);
    map.set(nodeId, { node_id: nodeId, file: node?.source?.file, via });
  };

  for (const nodeId of entity.lifecycle?.created_by || []) recordAccessor(writers, nodeId, 'lifecycle:created');
  for (const nodeId of entity.lifecycle?.updated_by || []) recordAccessor(writers, nodeId, 'lifecycle:updated');
  for (const nodeId of entity.lifecycle?.deleted_by || []) recordAccessor(writers, nodeId, 'lifecycle:deleted');
  for (const nodeId of entity.lifecycle?.read_by || []) recordAccessor(readers, nodeId, 'lifecycle:read');

  const entityNodeIds = new Set<string>();
  for (const key of entityNameKeys(entity.name)) {
    for (const nodeId of index.entityNodeIdsByKey.get(key) || []) entityNodeIds.add(nodeId);
  }
  for (const entityNodeId of entityNodeIds) {
    for (const edge of index.writeEdgesByTarget.get(entityNodeId) || []) {
      recordAccessor(writers, edge.source, `edge:${edge.type}`);
    }
    for (const edge of index.readEdgesByTarget.get(entityNodeId) || []) {
      recordAccessor(readers, edge.source, `edge:${edge.type}`);
    }
  }

  for (const key of entityNameKeys(entity.name)) {
    for (const exitPoint of index.databaseExitsByResourceKey.get(key) || []) {
      const action = (exitPoint.operation?.action || '').toLowerCase();
      const via = `database:${action || 'unknown'}`;
      if (/insert|create|update|upsert|delete|remove/.test(action)) {
        recordAccessor(writers, exitPoint.source_node, via);
      } else if (action) {
        recordAccessor(readers, exitPoint.source_node, via);
      }
    }
  }

  const journeys = collectJourneys(entity, index);

  const recipients = new Map<string, CASEntityLineageExternalRecipient>();
  const recordRecipient = (exitPoint: CASExitPoint) => {
    if (!EXTERNAL_EXIT_TYPES.has(exitPoint.type) || recipients.has(exitPoint.id)) return;
    recipients.set(exitPoint.id, {
      exit_point_id: exitPoint.id,
      service: exitPoint.target?.service_id || exitPoint.target?.sdk || exitPoint.name,
      via_node: exitPoint.source_node,
    });
  };
  const accessorScope = new Set<string>([...writers.keys(), ...readers.keys()]);
  for (const nodeId of [...accessorScope]) {
    const ownerId = index.ownerByChild.get(nodeId);
    if (ownerId) accessorScope.add(ownerId);
    for (const childId of index.childrenByOwner.get(nodeId) || []) accessorScope.add(childId);
  }
  for (const nodeId of accessorScope) {
    for (const exitPoint of index.externalExitsBySource.get(nodeId) || []) recordRecipient(exitPoint);
  }
  for (const journey of journeys) {
    for (const exitPointId of journey.exit_point_ids || []) {
      const exitPoint = index.exitPointsById.get(exitPointId);
      if (exitPoint) recordRecipient(exitPoint);
    }
  }

  const boundaries = new Map<string, CASEntityLineageBoundary>();
  let unguardedPaths = 0;
  for (const journey of journeys) {
    const guarded = (journey.security_boundaries || []).length > 0;
    if (!guarded) unguardedPaths += 1;
    const label = boundaryLabel(journey);
    const existing = boundaries.get(label);
    if (!existing) {
      boundaries.set(label, { boundary: label, guarded });
    } else if (existing.guarded && !guarded) {
      existing.guarded = false;
    }
  }

  return {
    entity_id: entity.id,
    entity_name: entity.name,
    sensitive_fields: sensitiveFields,
    writers: [...writers.values()].sort((a, b) => a.node_id.localeCompare(b.node_id)),
    readers: [...readers.values()].sort((a, b) => a.node_id.localeCompare(b.node_id)),
    external_recipients: [...recipients.values()].sort((a, b) => a.exit_point_id.localeCompare(b.exit_point_id)),
    boundaries_crossed: [...boundaries.values()].sort((a, b) => a.boundary.localeCompare(b.boundary)),
    journeys_carrying: journeys.map(journey => journey.id).sort(),
    exposure: {
      unguarded_paths: unguardedPaths,
      external_transfer: recipients.size > 0,
      sensitive: sensitiveFields.length > 0,
    },
  };
}

function collectJourneys(entity: CASDataEntity, index: LineageIndex): CASUserJourney[] {
  const journeys = new Set<CASUserJourney>(index.journeysByEntityId.get(entity.id) || []);
  for (const key of entityNameKeys(entity.name)) {
    for (const journey of index.journeysByEntityKey.get(key) || []) journeys.add(journey);
  }
  return [...journeys].sort((a, b) => a.id.localeCompare(b.id));
}

function boundaryLabel(journey: CASUserJourney): string {
  const method = journey.entry?.method?.toUpperCase();
  const pathOrTrigger = journey.entry?.path_or_trigger;
  if (method && pathOrTrigger) return `${method} ${pathOrTrigger}`;
  if (pathOrTrigger) return pathOrTrigger;
  return journey.entry?.name || journey.name;
}

function entityNameKeys(name: string): string[] {
  const base = normalizeEntityKey(name);
  if (!base) return [];
  const keys = new Set([base]);
  if (base.endsWith('ies')) keys.add(`${base.slice(0, -3)}y`);
  if (base.endsWith('es')) keys.add(base.slice(0, -2));
  if (base.endsWith('s')) keys.add(base.slice(0, -1));
  return [...keys];
}

function normalizeEntityKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}
