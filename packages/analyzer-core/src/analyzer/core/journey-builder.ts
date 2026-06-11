import {
  CASNode,
  CASEdge,
  CASEntryPoint,
  CASExitPoint,
  CASCallChain,
  CASDataEntity,
  CASChangeRisk,
  CASUserJourney,
  CASUserJourneyStep,
  CASUserJourneySummary,
  CASUserJourneyTerminalEntity
} from '../../types/cas.types';

export interface UserJourneyInput {
  nodes: CASNode[];
  edges: CASEdge[];
  entryPoints: CASEntryPoint[];
  exitPoints: CASExitPoint[];
  callChains: CASCallChain[];
  dataEntities?: CASDataEntity[];
  changeRisks?: CASChangeRisk[];
}

export interface UserJourneyOptions {
  maxJourneys?: number;
}

export interface UserJourneyResult {
  journeys: CASUserJourney[];
  summary: CASUserJourneySummary;
}

const DEFAULT_MAX_JOURNEYS = 50;
const WALK_MAX_DEPTH = 8;
const WALK_MAX_NODES = 30;
const SEED_EXPANSION_LIMIT = 15;

const GUARD_EDGE_TYPES = new Set(['guarded_by', 'protected_by', 'guards', 'middleware', 'intercepts', 'before_action']);
const TEST_EDGE_TYPES = new Set(['tests', 'covers']);
const TRAVERSAL_EDGE_TYPES = new Set([
  'calls', 'invokes', 'executes', 'triggers', 'routes_to', 'handled_by',
  'uses', 'depends_on', 'manages', 'maps_to', 'reads', 'writes', 'queries',
  'creates', 'updates', 'deletes', 'transitions_to'
]);
const CONTAINMENT_EDGE_TYPES = new Set(['contains', 'has_method', 'declares']);
const ENTITY_RELATION_EDGE_TYPES = new Set(['relates_to']);
const WALK_EXCLUDED_NODE_TYPES = new Set([
  'use', 'import', 'namespace', 'file', 'variable', 'property', 'constant',
  'class_constant', 'interface_constant', 'enum_case', 'template', 'module', 'package'
]);
const JUNK_CALL_TARGET_NAMES = new Set([
  'if', 'else', 'elseif', 'for', 'foreach', 'while', 'do', 'switch', 'match', 'case',
  'try', 'catch', 'finally', 'return', 'throw', 'new', 'clone', 'echo', 'print',
  'list', 'isset', 'unset', 'empty', 'exit', 'die', 'require', 'include', 'function',
  '__construct', '__destruct', '__get', '__set', '__call', '__tostring'
]);
const METHOD_NAME_POPULARITY_LIMIT = 3;
const METHOD_LIKE_TYPES = /(^|[_\s])(method|function|action)([_\s]|$)/;

const USER_FACING_ENTRY_TYPES = new Set(['http', 'websocket', 'cli', 'page', 'route']);
const SCHEDULED_ENTRY_TYPES = new Set(['schedule']);
const SKIPPED_ENTRY_TYPES = new Set(['test']);

const RISK_ORDER: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const CRITICALITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const ENTRY_LAYER_TYPES = /(^|[_\s])(controller|gateway|resolver|handler|page|route|api_route|view|component|command|subscriber|listener)([_\s]|$)/;
const DATA_LAYER_TYPES = /(^|[_\s])(entity|repository|model|schema|migration|table|store|dao)([_\s]|$)/;
const INFRA_LAYER_TYPES = /(^|[_\s])(config|middleware|guard|interceptor|filter|pipe|decorator|logger|cache)([_\s]|$)/;
const ENTITY_NODE_TYPES = /(^|[_\s])(entity|model)([_\s]|$)/;
const FRAMEWORK_TERMINAL_TYPES = /(^|[_\s])(route|middleware|guard|config|module|template|migration)([_\s]|$)/;

type EntityAccessKind = 'created' | 'updated' | 'deleted' | 'read';

interface EntityAccess {
  entity: CASDataEntity;
  access: EntityAccessKind;
}

interface JourneyGraph {
  nodesById: Map<string, CASNode>;
  traversalBySource: Map<string, CASEdge[]>;
  containsBySource: Map<string, string[]>;
  ownerByChild: Map<string, string>;
  relationsBySource: Map<string, CASEdge[]>;
  guardEdgesByNode: Map<string, CASEdge[]>;
  testEdgesByTarget: Map<string, CASEdge[]>;
  exitPointsBySourceNode: Map<string, CASExitPoint[]>;
  exitPointsById: Map<string, CASExitPoint>;
  entityAccessByNode: Map<string, EntityAccess[]>;
  entitiesByKey: Map<string, CASDataEntity>;
  aliasIndex: Map<string, CASNode[]>;
  aliasCache: Map<string, string[]>;
  methodNamePopularity: Map<string, number>;
}

export function buildUserJourneys(input: UserJourneyInput, options: UserJourneyOptions = {}): UserJourneyResult {
  const maxJourneys = options.maxJourneys ?? DEFAULT_MAX_JOURNEYS;
  const graph = buildJourneyGraph(input);

  const chainsByEntryPointId = new Map<string, CASCallChain[]>();
  const chainsByEntryNodeId = new Map<string, CASCallChain[]>();
  for (const chain of input.callChains) {
    if (chain.entry_point.entry_point_id) {
      const list = chainsByEntryPointId.get(chain.entry_point.entry_point_id) || [];
      list.push(chain);
      chainsByEntryPointId.set(chain.entry_point.entry_point_id, list);
    }
    if (chain.entry_point.node_id) {
      const list = chainsByEntryNodeId.get(chain.entry_point.node_id) || [];
      list.push(chain);
      chainsByEntryNodeId.set(chain.entry_point.node_id, list);
    }
  }

  const riskByNode = new Map<string, CASChangeRisk>();
  for (const risk of input.changeRisks || []) {
    riskByNode.set(risk.node_id, risk);
  }

  const entryPointIsHandlerOrSource = (entryPoint: CASEntryPoint, nodeId: string) =>
    entryPoint.source_node === nodeId || entryPoint.handler?.node_id === nodeId;

  const determineLayer = (node: CASNode, entryPoint: CASEntryPoint): CASUserJourneyStep['layer'] => {
    const text = `${node.type} ${(node.subcategories || []).join(' ')} ${node.category || ''}`.toLowerCase();
    if (DATA_LAYER_TYPES.test(text)) return 'data';
    if (INFRA_LAYER_TYPES.test(text)) return 'infrastructure';
    if (ENTRY_LAYER_TYPES.test(text)) return 'entry';
    if (entryPointIsHandlerOrSource(entryPoint, node.id)) return 'entry';
    return 'business';
  };

  const built: Array<{ journey: CASUserJourney; entryPoint: CASEntryPoint }> = [];

  const sortedEntryPoints = [...input.entryPoints].sort((a, b) => a.id.localeCompare(b.id));

  for (const entryPoint of sortedEntryPoints) {
    if (SKIPPED_ENTRY_TYPES.has(entryPoint.type)) continue;

    const chains = dedupeChains([
      ...(chainsByEntryPointId.get(entryPoint.id) || []),
      ...(entryPoint.handler?.node_id ? chainsByEntryNodeId.get(entryPoint.handler.node_id) || [] : []),
      ...(entryPoint.source_node ? chainsByEntryNodeId.get(entryPoint.source_node) || [] : []),
    ]);

    const pathNodeIds = collectPathNodeIds(entryPoint, chains, graph);
    if (pathNodeIds.size === 0) continue;

    const steps: CASUserJourneyStep[] = [];
    const seenStepKeys = new Set<string>();
    for (const [nodeId, depth] of pathNodeIds) {
      const node = graph.nodesById.get(nodeId);
      if (!node) continue;
      const stepKey = `${node.name}:${depth}`;
      if (seenStepKeys.has(stepKey)) continue;
      seenStepKeys.add(stepKey);
      steps.push({
        node_id: nodeId,
        name: node.name,
        layer: determineLayer(node, entryPoint),
        depth,
      });
    }
    steps.sort((a, b) => a.depth - b.depth || a.node_id.localeCompare(b.node_id));

    const effects = collectTerminalEffects(entryPoint, pathNodeIds, chains, graph);
    if (steps.length < 2 && !effects.hasAnyEffect) continue;

    const securityBoundaries = collectSecurityBoundaries(entryPoint, pathNodeIds, graph.guardEdgesByNode, graph.nodesById);
    const testsCovering = collectTestsCovering(pathNodeIds, graph.testEdgesByTarget, graph.nodesById);
    const risk = maxRiskOnPath(pathNodeIds, riskByNode);

    const journeyKind: CASUserJourney['journey_kind'] = SCHEDULED_ENTRY_TYPES.has(entryPoint.type)
      ? 'scheduled'
      : USER_FACING_ENTRY_TYPES.has(entryPoint.type)
        ? 'user-facing'
        : 'system';

    const criticality = scoreCriticality(effects, securityBoundaries.length, journeyKind, chains);

    built.push({
      entryPoint,
      journey: {
        id: `journey_${entryPoint.id}`,
        name: buildJourneyName(entryPoint, effects),
        journey_kind: journeyKind,
        entry_point_id: entryPoint.id,
        entry: {
          type: entryPoint.type,
          name: entryPoint.name,
          method: entryPoint.trigger?.method,
          path_or_trigger: entryPoint.trigger?.path || entryPoint.trigger?.pattern || entryPoint.trigger?.event || entryPoint.trigger?.schedule,
          handler_node_id: entryPoint.handler?.node_id,
        },
        steps,
        terminal_effects: {
          entities_written: effects.entitiesWritten,
          entities_read: effects.entitiesRead,
          external_services: effects.externalServices,
          messages_emitted: effects.messagesEmitted,
        },
        terminal_entities: effects.terminalEntities,
        security_boundaries: securityBoundaries,
        tests_covering: testsCovering,
        risk,
        criticality,
        call_chain_ids: chains.map(chain => chain.id),
        exit_point_ids: effects.exitPointIds,
      },
    });
  }

  disambiguateJourneyNames(built);

  const journeys = built.map(item => item.journey);
  journeys.sort((a, b) =>
    CRITICALITY_ORDER[a.criticality] - CRITICALITY_ORDER[b.criticality] ||
    b.terminal_effects.entities_written.length - a.terminal_effects.entities_written.length ||
    b.terminal_entities.length - a.terminal_entities.length ||
    a.id.localeCompare(b.id)
  );

  const included = journeys.slice(0, maxJourneys);
  const byKind: CASUserJourneySummary['by_kind'] = { 'user-facing': 0, system: 0, scheduled: 0 };
  for (const journey of included) {
    byKind[journey.journey_kind] += 1;
  }

  return {
    journeys: included,
    summary: {
      total_discovered: journeys.length,
      included: included.length,
      by_kind: byKind,
    },
  };
}

function buildJourneyGraph(input: UserJourneyInput): JourneyGraph {
  const nodesById = new Map(input.nodes.map(node => [node.id, node]));

  const traversalBySource = new Map<string, CASEdge[]>();
  const containsBySource = new Map<string, string[]>();
  const ownerByChild = new Map<string, string>();
  const relationsBySource = new Map<string, CASEdge[]>();
  const guardEdgesByNode = new Map<string, CASEdge[]>();
  const testEdgesByTarget = new Map<string, CASEdge[]>();

  for (const edge of input.edges) {
    if (TRAVERSAL_EDGE_TYPES.has(edge.type)) {
      const list = traversalBySource.get(edge.source) || [];
      list.push(edge);
      traversalBySource.set(edge.source, list);
    }
    if (CONTAINMENT_EDGE_TYPES.has(edge.type)) {
      const list = containsBySource.get(edge.source) || [];
      list.push(edge.target);
      containsBySource.set(edge.source, list);
      if (!ownerByChild.has(edge.target)) ownerByChild.set(edge.target, edge.source);
    }
    if (ENTITY_RELATION_EDGE_TYPES.has(edge.type)) {
      const list = relationsBySource.get(edge.source) || [];
      list.push(edge);
      relationsBySource.set(edge.source, list);
    }
    if (GUARD_EDGE_TYPES.has(edge.type)) {
      for (const endpoint of [edge.source, edge.target]) {
        const list = guardEdgesByNode.get(endpoint) || [];
        list.push(edge);
        guardEdgesByNode.set(endpoint, list);
      }
    }
    if (TEST_EDGE_TYPES.has(edge.type)) {
      const list = testEdgesByTarget.get(edge.target) || [];
      list.push(edge);
      testEdgesByTarget.set(edge.target, list);
    }
  }

  const exitPointsBySourceNode = new Map<string, CASExitPoint[]>();
  for (const exitPoint of input.exitPoints) {
    if (!exitPoint.source_node) continue;
    const list = exitPointsBySourceNode.get(exitPoint.source_node) || [];
    list.push(exitPoint);
    exitPointsBySourceNode.set(exitPoint.source_node, list);
  }
  const exitPointsById = new Map(input.exitPoints.map(exitPoint => [exitPoint.id, exitPoint]));

  const entityAccessByNode = new Map<string, EntityAccess[]>();
  const recordEntityAccess = (nodeId: string, entity: CASDataEntity, access: EntityAccessKind) => {
    const list = entityAccessByNode.get(nodeId) || [];
    list.push({ entity, access });
    entityAccessByNode.set(nodeId, list);
  };
  const entitiesByKey = new Map<string, CASDataEntity>();
  for (const entity of input.dataEntities || []) {
    for (const key of entityNameKeys(entity.name)) {
      if (!entitiesByKey.has(key)) entitiesByKey.set(key, entity);
    }
    for (const nodeId of entity.lifecycle?.created_by || []) recordEntityAccess(nodeId, entity, 'created');
    for (const nodeId of entity.lifecycle?.updated_by || []) recordEntityAccess(nodeId, entity, 'updated');
    for (const nodeId of entity.lifecycle?.deleted_by || []) recordEntityAccess(nodeId, entity, 'deleted');
    for (const nodeId of entity.lifecycle?.read_by || []) recordEntityAccess(nodeId, entity, 'read');
  }

  const aliasIndex = new Map<string, CASNode[]>();
  const methodNamePopularity = new Map<string, number>();
  for (const node of input.nodes) {
    const key = aliasKey(node);
    if (key) {
      const list = aliasIndex.get(key) || [];
      list.push(node);
      aliasIndex.set(key, list);
    }
    if (METHOD_LIKE_TYPES.test(node.type)) {
      const nameKey = node.name.toLowerCase();
      methodNamePopularity.set(nameKey, (methodNamePopularity.get(nameKey) || 0) + 1);
    }
  }

  return {
    nodesById,
    traversalBySource,
    containsBySource,
    ownerByChild,
    relationsBySource,
    guardEdgesByNode,
    testEdgesByTarget,
    exitPointsBySourceNode,
    exitPointsById,
    entityAccessByNode,
    entitiesByKey,
    aliasIndex,
    aliasCache: new Map(),
    methodNamePopularity,
  };
}

function isLowConfidenceTarget(node: CASNode, graph: JourneyGraph): boolean {
  if (!METHOD_LIKE_TYPES.test(node.type)) return false;
  const nameKey = node.name.toLowerCase();
  if (JUNK_CALL_TARGET_NAMES.has(nameKey)) return true;
  return (graph.methodNamePopularity.get(nameKey) || 0) > METHOD_NAME_POPULARITY_LIMIT;
}

function aliasKey(node: CASNode): string | undefined {
  const file = node.source?.file;
  if (!file || !node.name) return undefined;
  const basename = file.replace(/\\/g, '/').split('/').pop();
  if (!basename) return undefined;
  return `${basename.toLowerCase()}::${node.name.toLowerCase()}`;
}

function nodeAliases(nodeId: string, graph: JourneyGraph): string[] {
  const cached = graph.aliasCache.get(nodeId);
  if (cached) return cached;
  const node = graph.nodesById.get(nodeId);
  const key = node ? aliasKey(node) : undefined;
  if (!node || !key) {
    graph.aliasCache.set(nodeId, []);
    return [];
  }
  const file = node.source!.file!.replace(/\\/g, '/').toLowerCase();
  const aliases: string[] = [];
  for (const candidate of graph.aliasIndex.get(key) || []) {
    if (candidate.id === nodeId) continue;
    const candidateFile = candidate.source?.file?.replace(/\\/g, '/').toLowerCase();
    if (!candidateFile) continue;
    if (!candidateFile.endsWith(file) && !file.endsWith(candidateFile)) continue;
    const lineA = node.source?.line;
    const lineB = candidate.source?.line;
    if (lineA !== undefined && lineB !== undefined && Math.abs(lineA - lineB) > 2) continue;
    aliases.push(candidate.id);
  }
  graph.aliasCache.set(nodeId, aliases);
  return aliases;
}

function dedupeChains(chains: CASCallChain[]): CASCallChain[] {
  const seen = new Set<string>();
  const result: CASCallChain[] = [];
  for (const chain of chains) {
    if (seen.has(chain.id)) continue;
    seen.add(chain.id);
    result.push(chain);
  }
  return result;
}

function collectPathNodeIds(
  entryPoint: CASEntryPoint,
  chains: CASCallChain[],
  graph: JourneyGraph
): Map<string, number> {
  const pathNodeIds = new Map<string, number>();
  const addNode = (nodeId: string | undefined, depth: number) => {
    if (!nodeId) return;
    const existing = pathNodeIds.get(nodeId);
    if (existing === undefined || depth < existing) pathNodeIds.set(nodeId, depth);
  };

  addNode(entryPoint.source_node, 0);
  addNode(entryPoint.handler?.node_id, 0);

  for (const chain of chains) {
    addNode(chain.entry_point.node_id, 0);
    for (const step of chain.call_path) {
      addNode(step.node_id, step.depth);
    }
    if (chain.exit_point?.node_id) {
      const maxDepth = chain.call_path.reduce((max, step) => Math.max(max, step.depth), 0);
      addNode(chain.exit_point.node_id, maxDepth + 1);
    }
  }

  for (const seedId of [...pathNodeIds.keys()]) {
    const seedDepth = pathNodeIds.get(seedId) ?? 0;
    for (const aliasId of nodeAliases(seedId, graph)) {
      addNode(aliasId, seedDepth);
    }
  }

  const seeds = [...pathNodeIds.keys()];
  for (const seedId of seeds) {
    const seedDepth = pathNodeIds.get(seedId) ?? 0;
    const children = graph.containsBySource.get(seedId) || [];
    let expanded = 0;
    for (const childId of children) {
      if (expanded >= SEED_EXPANSION_LIMIT) break;
      const child = graph.nodesById.get(childId);
      if (!child) continue;
      if (!/(^|[_\s])(method|function|action)([_\s]|$)/.test(child.type)) continue;
      addNode(childId, seedDepth + 1);
      expanded += 1;
    }
  }

  const queue: Array<{ nodeId: string; depth: number }> = [...pathNodeIds.entries()].map(([nodeId, depth]) => ({ nodeId, depth }));
  const visited = new Set(pathNodeIds.keys());
  while (queue.length > 0 && pathNodeIds.size < WALK_MAX_NODES) {
    const { nodeId, depth } = queue.shift()!;
    if (depth >= WALK_MAX_DEPTH) continue;
    const outgoing = graph.traversalBySource.get(nodeId) || [];
    for (const edge of outgoing) {
      if (visited.has(edge.target)) continue;
      const target = graph.nodesById.get(edge.target);
      if (!target || WALK_EXCLUDED_NODE_TYPES.has(target.type)) continue;
      if (isLowConfidenceTarget(target, graph)) continue;
      visited.add(edge.target);
      addNode(edge.target, depth + 1);
      queue.push({ nodeId: edge.target, depth: depth + 1 });
      if (pathNodeIds.size >= WALK_MAX_NODES) break;
    }
  }
  return pathNodeIds;
}

interface TerminalEffects {
  entitiesWritten: string[];
  entitiesRead: string[];
  externalServices: string[];
  messagesEmitted: string[];
  terminalEntities: CASUserJourneyTerminalEntity[];
  exitPointIds: string[];
  hasAnyEffect: boolean;
}

interface TerminalCandidate {
  entity_id?: string;
  name: string;
  access: EntityAccessKind;
  node_id?: string;
  depth: number;
  viaRank: number;
}

function collectTerminalEffects(
  entryPoint: CASEntryPoint,
  pathNodeIds: Map<string, number>,
  chains: CASCallChain[],
  graph: JourneyGraph
): TerminalEffects {
  const externalServices = new Set<string>();
  const messagesEmitted = new Set<string>();
  const exitPointIds = new Set<string>();
  const candidates: TerminalCandidate[] = [];
  const entryAccess = inferEntryAccess(entryPoint);
  const routeResourceKeys = routeResourceEntityKeys(entryPoint);
  const isRouteResource = (name: string) =>
    entityNameKeys(name).some(entityKey => {
      if (routeResourceKeys.has(entityKey)) return true;
      for (const routeKey of routeResourceKeys) {
        if (routeKey.length >= 4 && entityKey.startsWith(routeKey)) return true;
      }
      return false;
    });
  const defaultAccessFor = (name: string): EntityAccessKind =>
    isRouteResource(name) ? entryAccess : 'read';

  const reachableExitPoints: Array<{ exitPoint: CASExitPoint; depth: number }> = [];
  for (const [nodeId, depth] of pathNodeIds) {
    for (const exitPoint of graph.exitPointsBySourceNode.get(nodeId) || []) {
      reachableExitPoints.push({ exitPoint, depth });
    }
  }
  for (const chain of chains) {
    const chainExitId = chain.exit_point?.exit_point_id;
    if (!chainExitId) continue;
    const exitPoint = graph.exitPointsById.get(chainExitId);
    if (!exitPoint) continue;
    const maxDepth = chain.call_path.reduce((max, step) => Math.max(max, step.depth), 0);
    reachableExitPoints.push({ exitPoint, depth: maxDepth + 1 });
  }

  for (const { exitPoint, depth } of reachableExitPoints) {
    exitPointIds.add(exitPoint.id);
    if (exitPoint.type === 'database') {
      const resource = exitPoint.target?.resource || exitPoint.name;
      const entity = matchEntityByName(resource, graph.entitiesByKey);
      if (entity) {
        candidates.push({
          entity_id: entity.id,
          name: entity.name,
          access: accessFromOperationAction(exitPoint.operation?.action) ?? defaultAccessFor(entity.name),
          node_id: exitPoint.source_node,
          depth: depth + 1,
          viaRank: 1,
        });
      }
      continue;
    }
    if (exitPoint.type === 'message' || exitPoint.type === 'event') {
      messagesEmitted.add(exitPoint.name);
    } else {
      externalServices.add(exitPoint.target?.service_id || exitPoint.name);
    }
  }

  for (const [nodeId, depth] of pathNodeIds) {
    for (const { entity, access } of graph.entityAccessByNode.get(nodeId) || []) {
      candidates.push({ entity_id: entity.id, name: entity.name, access, node_id: nodeId, depth, viaRank: 0 });
    }
  }

  const entityNodeHits = new Map<string, number>();
  const recordEntityNode = (entityNodeId: string, depth: number, viaRank: number, accessHint?: EntityAccessKind) => {
    const node = graph.nodesById.get(entityNodeId);
    if (!node) return;
    const existing = entityNodeHits.get(entityNodeId);
    if (existing === undefined || depth > existing) entityNodeHits.set(entityNodeId, depth);
    const entity = matchEntityByName(node.name, graph.entitiesByKey);
    const name = entity?.name || node.name;
    candidates.push({
      entity_id: entity?.id,
      name,
      access: accessHint ?? defaultAccessFor(name),
      node_id: entityNodeId,
      depth,
      viaRank,
    });
  };

  for (const [nodeId, depth] of pathNodeIds) {
    const ownEntity = entityNodeFor(nodeId, graph);
    if (ownEntity) recordEntityNode(ownEntity, depth, 1);
    for (const edge of graph.traversalBySource.get(nodeId) || []) {
      const targetNode = graph.nodesById.get(edge.target);
      if (targetNode && isLowConfidenceTarget(targetNode, graph)) continue;
      const targetEntity = entityNodeFor(edge.target, graph);
      if (!targetEntity) continue;
      recordEntityNode(targetEntity, depth + 1, 1, accessFromEdgeType(edge.type));
    }
  }

  for (const [entityNodeId, depth] of [...entityNodeHits]) {
    for (const edge of graph.relationsBySource.get(entityNodeId) || []) {
      const relatedEntity = entityNodeFor(edge.target, graph);
      if (!relatedEntity || entityNodeHits.has(relatedEntity)) continue;
      recordEntityNode(relatedEntity, depth + 1, 3, 'read');
    }
  }

  candidates.sort((a, b) => {
    const aWrite = a.access === 'read' ? 1 : 0;
    const bWrite = b.access === 'read' ? 1 : 0;
    return aWrite - bWrite || a.viaRank - b.viaRank || b.depth - a.depth || a.name.localeCompare(b.name);
  });

  const seenEntities = new Set<string>();
  const terminalEntities: CASUserJourneyTerminalEntity[] = [];
  const entitiesWritten = new Set<string>();
  const entitiesRead = new Set<string>();
  for (const candidate of candidates) {
    if (seenEntities.has(candidate.name)) continue;
    seenEntities.add(candidate.name);
    if (terminalEntities.length < 8) {
      terminalEntities.push({
        entity_id: candidate.entity_id,
        name: candidate.name,
        access: candidate.access,
        node_id: candidate.node_id,
        terminal_kind: 'entity',
      });
    }
    if (candidate.access === 'read') entitiesRead.add(candidate.name);
    else entitiesWritten.add(candidate.name);
  }

  if (terminalEntities.length === 0) {
    const fallback = deepestMeaningfulNode(entryPoint, pathNodeIds, graph);
    if (fallback) {
      terminalEntities.push({
        name: fallback.name,
        access: defaultAccessFor(fallback.name),
        node_id: fallback.id,
        terminal_kind: 'node',
      });
    }
  }

  return {
    entitiesWritten: [...entitiesWritten].sort(),
    entitiesRead: [...entitiesRead].sort(),
    externalServices: [...externalServices].sort(),
    messagesEmitted: [...messagesEmitted].sort(),
    terminalEntities,
    exitPointIds: [...exitPointIds].sort(),
    hasAnyEffect:
      entitiesWritten.size > 0 || entitiesRead.size > 0 ||
      externalServices.size > 0 || messagesEmitted.size > 0,
  };
}

function entityNodeFor(nodeId: string, graph: JourneyGraph): string | undefined {
  const node = graph.nodesById.get(nodeId);
  if (!node) return undefined;
  if (isEntityNode(node, graph)) return nodeId;
  const ownerId = graph.ownerByChild.get(nodeId);
  if (!ownerId) return undefined;
  const owner = graph.nodesById.get(ownerId);
  if (owner && isEntityNode(owner, graph)) return ownerId;
  return undefined;
}

function isEntityNode(node: CASNode, graph: JourneyGraph): boolean {
  if (ENTITY_NODE_TYPES.test(node.type)) return true;
  if (node.type === 'class' && matchEntityByName(node.name, graph.entitiesByKey) !== undefined) return true;
  return false;
}

function deepestMeaningfulNode(
  entryPoint: CASEntryPoint,
  pathNodeIds: Map<string, number>,
  graph: JourneyGraph
): CASNode | undefined {
  let best: { node: CASNode; depth: number } | undefined;
  for (const [nodeId, depth] of pathNodeIds) {
    let node = graph.nodesById.get(nodeId);
    if (!node) continue;
    if (METHOD_LIKE_TYPES.test(node.type)) {
      const ownerId = graph.ownerByChild.get(nodeId);
      const owner = ownerId ? graph.nodesById.get(ownerId) : undefined;
      if (owner && !WALK_EXCLUDED_NODE_TYPES.has(owner.type)) node = owner;
    }
    if (WALK_EXCLUDED_NODE_TYPES.has(node.type)) continue;
    if (FRAMEWORK_TERMINAL_TYPES.test(node.type)) continue;
    if (node.id === entryPoint.source_node || node.id === entryPoint.handler?.node_id) continue;
    if (!best || depth > best.depth || (depth === best.depth && node.id.localeCompare(best.node.id) < 0)) {
      best = { node, depth };
    }
  }
  return best?.node;
}

function inferEntryAccess(entryPoint: CASEntryPoint): EntityAccessKind {
  const method = entryPoint.trigger?.method?.toUpperCase();
  if (method === 'POST') return 'created';
  if (method === 'PUT' || method === 'PATCH') return 'updated';
  if (method === 'DELETE') return 'deleted';
  return 'read';
}

function accessFromOperationAction(action?: string): EntityAccessKind | undefined {
  if (!action) return undefined;
  const normalized = action.toLowerCase();
  if (/insert|create/.test(normalized)) return 'created';
  if (/update|upsert/.test(normalized)) return 'updated';
  if (/delete|remove/.test(normalized)) return 'deleted';
  if (/^(read|select|find|query)$/.test(normalized)) return 'read';
  return undefined;
}

function accessFromEdgeType(edgeType: string): EntityAccessKind | undefined {
  if (edgeType === 'creates') return 'created';
  if (edgeType === 'updates' || edgeType === 'writes') return 'updated';
  if (edgeType === 'deletes') return 'deleted';
  if (edgeType === 'reads' || edgeType === 'queries') return 'read';
  return undefined;
}

function entityNameKeys(name: string): string[] {
  const base = normalizeEntityKey(name);
  const keys = new Set([base]);
  if (base.endsWith('ies')) keys.add(`${base.slice(0, -3)}y`);
  if (base.endsWith('es')) keys.add(base.slice(0, -2));
  if (base.endsWith('s')) keys.add(base.slice(0, -1));
  return [...keys];
}

function matchEntityByName(name: string, entitiesByKey: Map<string, CASDataEntity>): CASDataEntity | undefined {
  for (const key of entityNameKeys(name)) {
    const entity = entitiesByKey.get(key);
    if (entity) return entity;
  }
  return undefined;
}

function normalizeEntityKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function collectSecurityBoundaries(
  entryPoint: CASEntryPoint,
  pathNodeIds: Map<string, number>,
  guardEdgesByNode: Map<string, CASEdge[]>,
  nodesById: Map<string, CASNode>
): CASUserJourney['security_boundaries'] {
  const boundaries = new Map<string, CASUserJourney['security_boundaries'][number]>();

  for (const guard of entryPoint.security?.guards || []) {
    boundaries.set(`guard:${guard}`, { name: guard, mechanism: 'entry-guard' });
  }
  if (entryPoint.security?.authenticated && (entryPoint.security?.guards || []).length === 0) {
    boundaries.set('guard:authenticated', { name: 'authentication', mechanism: 'entry-guard' });
  }

  for (const nodeId of pathNodeIds.keys()) {
    for (const edge of guardEdgesByNode.get(nodeId) || []) {
      const boundaryNodeId = edge.source === nodeId ? edge.target : edge.source;
      const boundaryNode = nodesById.get(boundaryNodeId);
      if (!boundaryNode) continue;
      boundaries.set(`node:${boundaryNodeId}`, {
        node_id: boundaryNodeId,
        name: boundaryNode.name,
        mechanism: edge.type,
      });
    }
  }

  return [...boundaries.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function collectTestsCovering(
  pathNodeIds: Map<string, number>,
  testEdgesByTarget: Map<string, CASEdge[]>,
  nodesById: Map<string, CASNode>
): string[] {
  const testIds = new Set<string>();
  for (const nodeId of pathNodeIds.keys()) {
    for (const edge of testEdgesByTarget.get(nodeId) || []) {
      testIds.add(edge.source);
    }
    const node = nodesById.get(nodeId);
    for (const testId of node?.testing?.tested_by || []) {
      testIds.add(testId);
    }
  }
  return [...testIds].sort();
}

function maxRiskOnPath(
  pathNodeIds: Map<string, number>,
  riskByNode: Map<string, CASChangeRisk>
): CASUserJourney['risk'] {
  let max: CASUserJourney['risk'];
  for (const nodeId of pathNodeIds.keys()) {
    const risk = riskByNode.get(nodeId);
    if (!risk) continue;
    if (max === undefined || RISK_ORDER[risk.risk_level] > RISK_ORDER[max]) {
      max = risk.risk_level;
    }
  }
  return max;
}

function scoreCriticality(
  effects: TerminalEffects,
  boundaryCount: number,
  journeyKind: CASUserJourney['journey_kind'],
  chains: CASCallChain[]
): CASUserJourney['criticality'] {
  let score = 0;
  score += Math.min(effects.entitiesWritten.length, 3) * 3;
  score += Math.min(effects.entitiesRead.length, 3);
  score += Math.min(effects.externalServices.length, 2) * 2;
  score += Math.min(effects.messagesEmitted.length, 2) * 2;
  if (boundaryCount > 0) score += 2;
  if (journeyKind === 'user-facing') score += 1;
  for (const chain of chains) {
    if (chain.criticality === 'critical') score += 3;
    else if (chain.criticality === 'high') score += 2;
  }
  if (score >= 10) return 'critical';
  if (score >= 6) return 'high';
  if (score >= 3) return 'medium';
  return 'low';
}

function disambiguateJourneyNames(built: Array<{ journey: CASUserJourney; entryPoint: CASEntryPoint }>): void {
  const counts = new Map<string, number>();
  for (const { journey } of built) {
    counts.set(journey.name, (counts.get(journey.name) || 0) + 1);
  }

  const assigned = new Set<string>();
  for (const item of built) {
    let name = item.journey.name;
    if ((counts.get(name) || 0) > 1 || assigned.has(name)) {
      name = `${name} (${journeyDiscriminator(item.entryPoint)})`;
    }
    if (assigned.has(name)) {
      name = `${item.journey.name} (${journeyDiscriminator(item.entryPoint)}, ${item.entryPoint.id})`;
    }
    assigned.add(name);
    item.journey.name = name;
  }
}

function journeyDiscriminator(entryPoint: CASEntryPoint): string {
  const method = entryPoint.trigger?.method?.toUpperCase();
  const path = entryPoint.trigger?.path;
  if (method && path) return `${method} ${path}`;
  const handler = entryPoint.metadata?.handler
    || entryPoint.metadata?.handler_method
    || entryPoint.metadata?.controller
    || entryPoint.handler?.method_name;
  if (handler) return String(handler);
  return entryPoint.name;
}

function buildJourneyName(entryPoint: CASEntryPoint, effects: TerminalEffects): string {
  const action = describeEntryAction(entryPoint);
  const outcome = describeTerminalOutcome(effects);
  return outcome ? `${action} -> ${outcome}` : action;
}

function describeEntryAction(entryPoint: CASEntryPoint): string {
  const method = entryPoint.trigger?.method?.toUpperCase();
  const path = entryPoint.trigger?.path;

  if (entryPoint.type === 'http' && method && path) {
    const segments = resourcePathSegments(path);
    const last = segments[segments.length - 1];
    if (method === 'GET' && (last === 'new' || last === 'edit')) {
      const owner = segments[segments.length - 2];
      const resource = owner ? singularizeLabel(humanizeLabel(owner)) : undefined;
      const formKind = last === 'new' ? 'New' : 'Edit';
      return resource ? `${formKind} ${resource} form` : `${formKind} form`;
    }
    const resource = humanizeResource(path);
    const isItemPath = /[:{*]|\[/.test(path.split('/').pop() || '');
    switch (method) {
      case 'POST': return resource ? `Create ${resource}` : entryPoint.name;
      case 'PUT':
      case 'PATCH': return resource ? `Update ${resource}` : entryPoint.name;
      case 'DELETE': return resource ? `Delete ${resource}` : entryPoint.name;
      case 'GET': return resource ? (isItemPath ? `View ${resource}` : `List ${pluralizeLabel(resource)}`) : entryPoint.name;
      default: return entryPoint.name;
    }
  }
  if (entryPoint.type === 'cli') return `Run ${entryPoint.trigger?.pattern || entryPoint.name}`;
  if (entryPoint.type === 'schedule') return `Scheduled ${humanizeLabel(entryPoint.name)}`;
  if (entryPoint.type === 'event' || entryPoint.type === 'message') {
    const subject = entryPoint.trigger?.event
      || entryPoint.trigger?.pattern
      || (entryPoint.metadata?.message_class ? String(entryPoint.metadata.message_class) : undefined)
      || entryPoint.name;
    return `Handle ${humanizeLabel(subject)}`;
  }
  if (entryPoint.type === 'page' || entryPoint.type === 'route') {
    return `Visit ${entryPoint.trigger?.path || humanizeLabel(entryPoint.name)}`;
  }
  return humanizeLabel(entryPoint.name);
}

function describeTerminalOutcome(effects: TerminalEffects): string | undefined {
  const primary = effects.terminalEntities[0];
  if (primary) {
    const extra = effects.terminalEntities.length > 1 ? ` (+${effects.terminalEntities.length - 1} more)` : '';
    if (primary.terminal_kind === 'node') return `${primary.name}${extra}`;
    return `${primary.name} ${primary.access}${extra}`;
  }
  if (effects.messagesEmitted.length > 0) return `emits ${effects.messagesEmitted[0]}`;
  if (effects.externalServices.length > 0) return `calls ${effects.externalServices[0]}`;
  return undefined;
}

function resourcePathSegments(path: string): string[] {
  return path
    .split('/')
    .filter(Boolean)
    .filter(segment => !/^[:{*]|\[/.test(segment))
    .filter(segment => !/^(api|v\d+)$/i.test(segment));
}

function routeResourceEntityKeys(entryPoint: CASEntryPoint): Set<string> {
  const keys = new Set<string>();
  const path = entryPoint.trigger?.path;
  if (entryPoint.type !== 'http' || !path) return keys;
  for (const segment of resourcePathSegments(path)) {
    if (/^(new|edit)$/i.test(segment)) continue;
    for (const key of entityNameKeys(segment)) keys.add(key);
  }
  return keys;
}

function humanizeResource(path: string): string | undefined {
  const segments = resourcePathSegments(path);
  const last = segments[segments.length - 1];
  if (!last) return undefined;
  const label = humanizeLabel(last);
  return singularizeLabel(label);
}

function humanizeLabel(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function singularizeLabel(label: string): string {
  const words = label.split(' ');
  const last = words[words.length - 1];
  let singular = last;
  if (/ies$/.test(last)) singular = last.replace(/ies$/, 'y');
  else if (/(ses|xes|zes|ches|shes)$/.test(last)) singular = last.replace(/es$/, '');
  else if (/s$/.test(last) && !/ss$/.test(last)) singular = last.replace(/s$/, '');
  words[words.length - 1] = singular;
  return words.join(' ');
}

function pluralizeLabel(label: string): string {
  const words = label.split(' ');
  const last = words[words.length - 1];
  let plural = last;
  if (/y$/.test(last) && !/[aeiou]y$/.test(last)) plural = last.replace(/y$/, 'ies');
  else if (/(s|x|z|ch|sh)$/.test(last)) plural = `${last}es`;
  else if (!/s$/.test(last)) plural = `${last}s`;
  words[words.length - 1] = plural;
  return words.join(' ');
}
