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
  CASUserJourneyTerminalEntity, ENTRY_POINT_TYPES, ENTRY_POINT_TYPE_REACH,
} from '../../types/cas.types';
import { isGuardEnforcementEdge } from './guard-relationships';
import { classifyGuardKind } from './guard-classification';
import { dedupeAdjacentWords } from './flow-entry-naming';
import type { FlowConcept } from './flow-concepts';
import { isLanguageBuiltinExitPoint } from './language-builtins';
import { hasUnresolvedDependencyEffect, type TerminalEffects } from './exit-point-effects';
import { isStructuralExecutableCliEntry } from './entry-point-product-role';

export interface UserJourneyInput {
  nodes: CASNode[]; nodeLookup?: Map<string, CASNode>;
  edges: CASEdge[];
  entryPoints: CASEntryPoint[];
  exitPoints: CASExitPoint[];
  callChains: CASCallChain[];
  dataEntities?: CASDataEntity[];
  changeRisks?: CASChangeRisk[];
  flows?: FlowConcept[];
}

export interface UserJourneyOptions {
  maxJourneys?: number;
}

export interface UserJourneyResult {
  journeys: CASUserJourney[];
  summary: CASUserJourneySummary;
}

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
const REGISTRATION_HANDLER_EDGE_RELATIONSHIPS = new Set([
  'route_handler', 'command_handler', 'graphql_resolver', 'task_handler', 'inline_handler_call'
]);
const JUNK_CALL_TARGET_NAMES = new Set([
  'if', 'else', 'elseif', 'for', 'foreach', 'while', 'do', 'switch', 'match', 'case',
  'try', 'catch', 'finally', 'return', 'throw', 'new', 'clone', 'echo', 'print',
  'list', 'isset', 'unset', 'empty', 'exit', 'die', 'require', 'include', 'function',
  '__construct', '__destruct', '__get', '__set', '__call', '__tostring'
]);
const METHOD_NAME_POPULARITY_LIMIT = 3;
const METHOD_LIKE_TYPES = /(^|[_\s])(method|function|action)([_\s]|$)/;
export const USER_FACING_ENTRY_TYPES = new Set<CASEntryPoint['type']>(ENTRY_POINT_TYPES.filter(type => ENTRY_POINT_TYPE_REACH[type] === 'external'));
const SCHEDULED_ENTRY_TYPES = new Set(['schedule']);
const SKIPPED_ENTRY_TYPES = new Set(['test']);
const CRON_LINKABLE_ENTRY_TYPES = new Set(['cli']);
const EXTERNAL_ENTRY_NODE_TYPES: Partial<Record<CASEntryPoint['type'], RegExp>> = { event: /(^|[_\s])(page|route|api_route|view|component|widget|screen)([_\s]|$)/, message: /(^|[_\s])(tool|tool_endpoint)([_\s]|$)/ };
const OPERATIONAL_SCRIPT_ENTRY_FILE = /\.(sh|bash|zsh|ps1|bat|cmd)$|(^|\/)(makefile|justfile)$/i;
function isOperationalScriptEntry(file: string | undefined): boolean { return OPERATIONAL_SCRIPT_ENTRY_FILE.test(String(file || '')); }
function isUserFacingEntry(entryPoint: CASEntryPoint, graph: JourneyGraph): boolean {
  if (entryPoint.interaction_reach === 'internal') return false;
  if (entryPoint.interaction_reach === 'external') return true;
  if (USER_FACING_ENTRY_TYPES.has(entryPoint.type)) return true;
  const structuralType = EXTERNAL_ENTRY_NODE_TYPES[entryPoint.type];
  if (!structuralType) return false;
  return ([entryPoint.source_node, entryPoint.handler?.node_id].filter(Boolean) as string[]).some(id => {
    const node = graph.nodesById.get(id);
    return !!node && ([node.type, node.category, ...(node.subcategories || [])].filter(Boolean) as string[]).some(value => structuralType.test(value));
  });
}
export function buildCronScheduleIndex(nodes: CASNode[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const node of nodes) {
    if (node.type !== 'kubernetes_cronjob') continue;
    const meta = (node.metadata as any) || {};
    const schedule = meta.schedule ?? meta.attributes?.schedule;
    const command = meta.command ?? meta.attributes?.command;
    if (!schedule || !command || typeof command !== 'string') continue;
    index.set(command, schedule);
  }
  return index;
}

export function findCronSchedule(commandName: string, index: Map<string, string>): string | undefined {
  for (const [commandLine, schedule] of index) {
    if (commandLine.includes(commandName)) return schedule;
  }
  return undefined;
}

const RISK_ORDER: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const CRITICALITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const ENTRY_LAYER_TYPES = /(^|[_\s])(controller|gateway|resolver|handler|page|route|api_route|view|component|widget|screen|command|subscriber|listener)([_\s]|$)/;
const DATA_LAYER_TYPES = /(^|[_\s])(entity|repository|model|schema|migration|table|store|dao)([_\s]|$)/;
const INFRA_LAYER_TYPES = /(^|[_\s])(config|middleware|guard|interceptor|filter|pipe|decorator|logger|cache)([_\s]|$)/;
const ENTITY_NODE_TYPES = /(^|[_\s])(entity|model)([_\s]|$)/;
const FRAMEWORK_TERMINAL_TYPES = /(^|[_\s])(route|middleware|guard|config|module|template|migration)([_\s]|$)/;

const HTTP_VERB_NAME = /^(get|post|put|patch|delete|head|options)$/i;
const FRAMEWORK_LIFECYCLE_NAMES = new Set([
  'build', 'initstate', 'dispose', 'didchangedependencies', 'didupdatewidget',
  'reassemble', 'deactivate', 'activate', 'setstate', 'createstate',
  'render', 'componentdidmount', 'componentdidupdate', 'componentwillunmount',
  'shouldcomponentupdate', 'getderivedstatefromprops', 'componentdidcatch',
  'ngoninit', 'ngondestroy', 'ngonchanges', 'ngafterviewinit', 'ngaftercontentinit', 'ngdocheck',
  'beforecreate', 'beforemount', 'mounted', 'beforeupdate', 'updated',
  'beforeunmount', 'unmounted', 'beforedestroy', 'destroyed',
  'main', 'constructor', '__construct', '__destruct', 'init', 'initialize', 'setup', 'teardown',
  'onmodelcreating', 'onconfiguring', 'configureservices', 'configure', 'onactionexecuting',
]);
const WIDGET_BUILDER_NAME = /^_?build[A-Z_]/;
const HOOK_LIKE_NAME = /^use[A-Z0-9]/;
const HOOK_USAGE_NODE_TYPES = /(^|[_\s])hook(_usage)?([_\s]|$)/;
const UTILITY_CLASS_NAME = /(helper|helpers|extension|extensions|util|utils|utility|utilities)$/i;
const ACCESSOR_METHOD_NAME = /^_?(?:[Gg]et|[Ss]et|[Ii]s|[Hh]as|[Tt]o|[Ff]rom|[Oo]n|[Hh]andle|[Ff]ormat|[Pp]arse|[Ff]ind|[Tt]ry|[Ii]nit)[A-Z_]/;
const STD_TRAIT_METHOD_NAMES = new Set([
  'into', 'from', 'find', 'insert', 'remove', 'push', 'pop', 'write', 'read', 'clone',
  'collect', 'iter', 'iter_mut', 'into_iter', 'map', 'filter', 'fold', 'next', 'take',
  'unwrap', 'expect', 'ok_or', 'and_then', 'or_else', 'as_str', 'as_ref', 'as_mut',
  'to_string', 'to_owned', 'borrow', 'deref', 'default', 'len', 'is_empty', 'contains',
  'extend', 'drain', 'clear', 'replace', 'swap', 'fmt', 'hash', 'eq', 'cmp', 'clamp',
  'as_kebab', 'as_kebab_case', 'as_snake_case', 'to_snake_case', 'serialize', 'deserialize',
]);
const GENERIC_ERROR_TYPE_NAME = /^(?:error|errors|exception|exceptions|err|errs)$/i;

function isFrameworkPlumbingName(rawName: string): boolean {
  const name = (rawName || '').trim();
  if (!name) return true;
  if (HTTP_VERB_NAME.test(name)) return true;
  if (FRAMEWORK_LIFECYCLE_NAMES.has(name.toLowerCase())) return true;
  if (HOOK_LIKE_NAME.test(name)) return true;
  if (WIDGET_BUILDER_NAME.test(name)) return true;
  return false;
}

function isUtilityNodeName(rawName: string): boolean {
  const name = (rawName || '').trim();
  if (!name) return false;
  if (UTILITY_CLASS_NAME.test(name)) return true;
  if (ACCESSOR_METHOD_NAME.test(name)) return true;
  if (STD_TRAIT_METHOD_NAMES.has(name.toLowerCase())) return true;
  return false;
}


function isExcludedTerminalName(name: string): boolean {
  const trimmed = (name || '').trim();
  if (GENERIC_ERROR_TYPE_NAME.test(trimmed)) return true;
  return isFrameworkPlumbingName(name) || isUtilityNodeName(name);
}

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
  initialStatesByOwnerKey: Map<string, string[]>;
}

export function buildUserJourneys(input: UserJourneyInput, options: UserJourneyOptions = {}): UserJourneyResult {
  const maxJourneys = options.maxJourneys;
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

  const cronScheduleIndex = buildCronScheduleIndex(input.nodes);

  const flowsByEntryKey = new Map<string, FlowConcept[]>();
  for (const flow of input.flows || []) {
    const list = flowsByEntryKey.get(flow.entry_point) || [];
    list.push(flow);
    flowsByEntryKey.set(flow.entry_point, list);
  }
  const flowsForEntryPoint = (entryPoint: CASEntryPoint): FlowConcept[] => {
    const matches: FlowConcept[] = [];
    const seen = new Set<string>();
    for (const key of [entryPoint.id, entryPoint.handler?.node_id, entryPoint.source_node]) {
      if (!key) continue;
      for (const flow of flowsByEntryKey.get(key) || []) {
        if (seen.has(flow.flow_id)) continue;
        seen.add(flow.flow_id);
        matches.push(flow);
      }
    }
    return matches;
  };

  const entryPointIsHandlerOrSource = (entryPoint: CASEntryPoint, nodeId: string) =>
    entryPoint.source_node === nodeId || entryPoint.handler?.node_id === nodeId;

  const determineLayer = (node: CASNode, entryPoint: CASEntryPoint): CASUserJourneyStep['layer'] => {
    const text = `${node.type} ${(node.subcategories || []).join(' ')} ${node.category || ''}`.toLowerCase();
    if (DATA_LAYER_TYPES.test(text)) return 'data';
    if (INFRA_LAYER_TYPES.test(text)) return 'infrastructure';
    if (ENTRY_LAYER_TYPES.test(text)) return 'entry';
    if (entryPointIsHandlerOrSource(entryPoint, node.id)) return 'entry';
    if (HTTP_VERB_NAME.test(node.name)) return 'entry';
    if (HOOK_USAGE_NODE_TYPES.test(node.type)) return 'infrastructure';
    if (isFrameworkPlumbingName(node.name)) return 'infrastructure';
    if (isUtilityNodeName(node.name)) return 'infrastructure';
    if (METHOD_LIKE_TYPES.test(node.type) && /^[A-Z]/.test(node.name) && /\.dart$/i.test(node.source?.file || '')) {
      return 'entry';
    }
    return 'business';
  };

  const built: Array<{ journey: CASUserJourney; entryPoint: CASEntryPoint }> = [];

  const sortedEntryPoints = [...input.entryPoints].sort((a, b) => a.id.localeCompare(b.id));

  const seenEntryPointIds = new Set<string>();
  for (const entryPoint of sortedEntryPoints) {
    if (SKIPPED_ENTRY_TYPES.has(entryPoint.type)) continue;
    if (seenEntryPointIds.has(entryPoint.id)) continue;
    seenEntryPointIds.add(entryPoint.id);

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
    if (steps.length < 2 && !effects.hasAnyEffect && effects.unresolvedExitPointIds.length === 0) continue;

    const securityBoundaries = collectSecurityBoundaries(entryPoint, pathNodeIds, graph.guardEdgesByNode, graph.nodesById);
    const testsCovering = collectTestsCovering(pathNodeIds, graph.testEdgesByTarget, graph.nodesById);
    const risk = maxRiskOnPath(pathNodeIds, riskByNode);

    const entryFile = entryPoint.handler?.file
      || graph.nodesById.get(entryPoint.handler?.node_id || '')?.source?.file
      || graph.nodesById.get(entryPoint.source_node || '')?.source?.file;
    const entryCommandName = String((entryPoint.metadata as any)?.commandName || '').trim();
    const cronSchedule = CRON_LINKABLE_ENTRY_TYPES.has(entryPoint.type) && entryCommandName
      ? findCronSchedule(entryCommandName, cronScheduleIndex)
      : undefined;

    const genericBootstrapCli = entryPoint.type === 'cli' &&
      /^(?:main|application|server|index)(?:\.[a-z0-9]+)?$/i.test(String(entryPoint.name || entryPoint.handler?.method_name || '').trim());

    const journeyKind: CASUserJourney['journey_kind'] = (SCHEDULED_ENTRY_TYPES.has(entryPoint.type) || cronSchedule)
      ? 'scheduled'
      : (isUserFacingEntry(entryPoint, graph) && !isOperationalScriptEntry(entryFile) && !genericBootstrapCli && !isStructuralExecutableCliEntry(entryPoint))
        ? 'user-facing'
        : 'system';

    const matchingFlows = input.flows ? flowsForEntryPoint(entryPoint) : undefined;

    const capabilityRelationships = matchingFlows?.length
      ? dedupeCapabilityRelationships(matchingFlows.flatMap(flow => flow.capability_relationships || []))
      : undefined;

    const criticality = scoreCriticality(effects, securityBoundaries.length, journeyKind, chains);

    built.push({
      entryPoint,
      journey: {
        id: `journey_${entryPoint.id}`,
        name: matchingFlows?.length ? matchingFlows[0].name : buildJourneyName(entryPoint, effects),
        journey_kind: journeyKind,
        entry_point_id: entryPoint.id,
        entry: {
          type: entryPoint.type,
          name: entryPoint.name,
          method: entryPoint.trigger?.method,
          path_or_trigger: cronSchedule || entryPoint.trigger?.path || entryPoint.trigger?.pattern
            || entryPoint.trigger?.event || entryPoint.trigger?.schedule,
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
        ...(effects.unresolvedExitPointIds.length > 0 ? { unresolved_exit_point_ids: effects.unresolvedExitPointIds } : {}),
        ...(matchingFlows?.length ? { derived_from_flow_id: matchingFlows[0].flow_id } : {}),
        ...(capabilityRelationships?.length ? { capability_relationships: capabilityRelationships } : {}),
      },
    });
  }

  disambiguateJourneyNames(built);

  const journeys = built.map(item => item.journey);
  journeys.sort((a, b) =>
    CRITICALITY_ORDER[a.criticality] - CRITICALITY_ORDER[b.criticality] ||
    (b.capability_relationships?.length || 0) - (a.capability_relationships?.length || 0) ||
    b.terminal_effects.entities_written.length - a.terminal_effects.entities_written.length ||
    b.terminal_entities.length - a.terminal_entities.length ||
    a.id.localeCompare(b.id)
  );

  const byKind: CASUserJourneySummary['by_kind'] = { 'user-facing': 0, system: 0, scheduled: 0 };
  for (const journey of journeys) {
    byKind[journey.journey_kind] += 1;
  }

  const included = selectIncludedJourneys(journeys, maxJourneys);

  return {
    journeys: included,
    summary: {
      total_discovered: journeys.length,
      included: included.length,
      by_kind: byKind,
    },
  };
}

function selectIncludedJourneys(sortedJourneys: CASUserJourney[], maxJourneys?: number): CASUserJourney[] {
  if (maxJourneys === undefined || maxJourneys <= 0) return sortedJourneys;
  if (sortedJourneys.length <= maxJourneys) return sortedJourneys;

  const rankById = new Map<string, number>();
  sortedJourneys.forEach((journey, index) => rankById.set(journey.id, index));

  const includedIds = new Set<string>();
  const included: CASUserJourney[] = [];
  const include = (journey: CASUserJourney) => {
    if (included.length >= maxJourneys || includedIds.has(journey.id)) return;
    includedIds.add(journey.id);
    included.push(journey);
  };

  const representedKinds = new Set<CASUserJourney['journey_kind']>();
  for (const journey of sortedJourneys) {
    if (representedKinds.has(journey.journey_kind)) continue;
    representedKinds.add(journey.journey_kind);
    include(journey);
  }

  const representedSurfaces = new Set<string>();
  for (const journey of sortedJourneys) {
    const surface = `${journey.journey_kind}:${journey.entry.type}`;
    if (representedSurfaces.has(surface)) continue;
    representedSurfaces.add(surface);
    include(journey);
  }

  for (const journey of sortedJourneys) {
    include(journey);
  }

  included.sort((a, b) => (rankById.get(a.id)! - rankById.get(b.id)!));
  return included.slice(0, maxJourneys);
}

function buildJourneyGraph(input: UserJourneyInput): JourneyGraph {
  const nodesById = input.nodeLookup ?? new Map(input.nodes.map(node => [node.id, node]));

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
    if (isGuardEnforcementEdge(edge)) {
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

  const initialStatesByOwnerKey = new Map<string, string[]>();
  for (const node of input.nodes) {
    if (node.type !== 'state') continue;
    const initial = (node.metadata as any)?.attributes?.initial;
    if (!initial) continue;
    const ownerId = ownerByChild.get(node.id);
    const owner = ownerId ? nodesById.get(ownerId) : undefined;
    if (!owner) continue;
    const key = stateMachineOwnerKey(owner);
    if (!key) continue;
    const list = initialStatesByOwnerKey.get(key) || [];
    list.push(node.id);
    initialStatesByOwnerKey.set(key, list);
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
    initialStatesByOwnerKey,
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

function dedupeCapabilityRelationships(
  relationships: NonNullable<FlowConcept['capability_relationships']>
): NonNullable<CASUserJourney['capability_relationships']> {
  const seen = new Set<string>();
  const out: NonNullable<CASUserJourney['capability_relationships']> = [];
  for (const rel of relationships) {
    if (seen.has(rel.capability_id)) continue;
    seen.add(rel.capability_id);
    out.push({ capability_id: rel.capability_id, role: rel.role, rationale: rel.rationale, evidence: rel.evidence });
  }
  return out;
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


  if (chains.length === 0) {
    const seeds = [...pathNodeIds.keys()];
    for (const seedId of seeds) {
      const seedDepth = pathNodeIds.get(seedId) ?? 0;
      const children = graph.containsBySource.get(seedId) || [];
      for (const childId of children) {
        const child = graph.nodesById.get(childId);
        if (!child) continue;
        if (!/(^|[_\s])(method|function|action)([_\s]|$)/.test(child.type)) continue;
        addNode(childId, seedDepth + 1);
      }
    }
  }

  const queue: Array<{ nodeId: string; depth: number }> = [...pathNodeIds.entries()].map(([nodeId, depth]) => ({ nodeId, depth }));
  const visited = new Set(pathNodeIds.keys());
  let queueIndex = 0;
  while (queueIndex < queue.length) {
    const { nodeId, depth } = queue[queueIndex++]!;
    const outgoing = graph.traversalBySource.get(nodeId) || [];
    for (const edge of outgoing) {
      if (visited.has(edge.target)) continue;
      const relationship = (edge.metadata as any)?.attributes?.relationship;
      if (REGISTRATION_HANDLER_EDGE_RELATIONSHIPS.has(relationship) && edge.target !== entryPoint.handler?.node_id) {
        continue;
      }
      const target = graph.nodesById.get(edge.target);
      if (!target || WALK_EXCLUDED_NODE_TYPES.has(target.type)) continue;
      if (isLowConfidenceTarget(target, graph)) continue;
      visited.add(edge.target);
      addNode(edge.target, depth + 1);
      queue.push({ nodeId: edge.target, depth: depth + 1 });
    }
    for (const stateId of stateMachineEntryStates(nodeId, graph)) {
      if (visited.has(stateId)) continue;
      visited.add(stateId);
      addNode(stateId, depth + 1);
      queue.push({ nodeId: stateId, depth: depth + 1 });
    }
  }
  return pathNodeIds;
}

function stateMachineEntryStates(nodeId: string, graph: JourneyGraph): string[] {
  const node = graph.nodesById.get(nodeId);
  if (!node || !node.name) return [];
  if (!ENTITY_NODE_TYPES.test(node.type) && node.type !== 'class') return [];
  const key = stateMachineOwnerKey(node);
  if (!key) return [];
  return graph.initialStatesByOwnerKey.get(key) || [];
}

function stateMachineOwnerKey(node: CASNode): string | undefined {
  const file = node.source?.file;
  if (!file || !node.name) return undefined;
  return `${file.replace(/\\/g, '/').toLowerCase()}::${node.name.toLowerCase()}`;
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
  const unresolvedExitPointIds = new Set<string>();
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
    if (hasUnresolvedDependencyEffect(exitPoint)) {
      unresolvedExitPointIds.add(exitPoint.id);
      continue;
    }
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
    } else if (
      (exitPoint.target?.service_id || exitPoint.target?.sdk) &&
      !isLanguageBuiltinExitPoint(exitPoint)
    ) {
      externalServices.add(exitPoint.target!.service_id || exitPoint.target!.sdk!);
    }
    if (exitPoint.type === 'api') {
      const resource = apiResourceName(exitPoint.target?.endpoint || exitPoint.target?.resource);
      if (resource) {
        const entity = matchEntityByName(resource, graph.entitiesByKey);
        const name = entity?.name || resource;
        candidates.push({
          entity_id: entity?.id,
          name,
          access: accessFromHttpMethod(exitPoint.operation?.method) ?? defaultAccessFor(name),
          node_id: exitPoint.source_node,
          depth: depth + 1,
          viaRank: 2,
        });
      }
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

    if (isExcludedTerminalName(candidate.name)) continue;
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
    unresolvedExitPointIds: [...unresolvedExitPointIds].sort(),
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
    if (HOOK_USAGE_NODE_TYPES.test(node.type)) continue;
    if (isExcludedTerminalName(node.name)) continue;
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

function accessFromHttpMethod(method?: string): EntityAccessKind | undefined {
  if (!method) return undefined;
  const normalized = method.toUpperCase();
  if (normalized === 'POST') return 'created';
  if (normalized === 'PUT' || normalized === 'PATCH') return 'updated';
  if (normalized === 'DELETE') return 'deleted';
  if (normalized === 'GET' || normalized === 'HEAD') return 'read';
  return undefined;
}

const GENERIC_API_TAIL_SEGMENTS = new Set([
  'config', 'configs', 'data', 'list', 'lists', 'all', 'index', 'detail', 'details',
  'status', 'info', 'search', 'query', 'item', 'items', 'get', 'fetch', 'create',
  'update', 'delete', 'new', 'edit', 'summary',
]);

function apiResourceName(endpoint: string | undefined): string | undefined {
  if (!endpoint) return undefined;
  let path = endpoint.trim();
  if (!path || path === 'various' || path === 'external') return undefined;
  const urlMatch = path.match(/^https?:\/\/[^/]+(\/.*)?$/i);
  if (urlMatch) path = urlMatch[1] || '';
  path = path.split('?')[0].split('#')[0];
  const segments = path
    .split('/')
    .map(segment => segment.trim())
    .filter(Boolean)
    .filter(segment => !/^(api|v\d+)$/i.test(segment))
    .filter(segment => !/[:{[$]/.test(segment))
    .filter(segment => !/^\d+$/.test(segment))
    .filter(segment => !/^[0-9a-f]{8}-[0-9a-f]{4}/i.test(segment));
  if (segments.length === 0) return undefined;
  const tail = segments[segments.length - 1];
  if (GENERIC_API_TAIL_SEGMENTS.has(tail.toLowerCase())) {
    const parent = segments[segments.length - 2];
    if (!parent) return undefined;
    return pascalCaseLabel(`${humanizeLabel(parent)} ${humanizeLabel(tail)}`);
  }
  const label = singularizeLabel(humanizeLabel(tail));
  if (!label || HTTP_VERB_NAME.test(label)) return undefined;
  return pascalCaseLabel(label);
}

function pascalCaseLabel(label: string): string {
  return label
    .split(' ')
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
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

function entryPointGuards(entryPoint: CASEntryPoint): string[] {
  const guards = new Set<string>();
  for (const guard of entryPoint.security?.guards || []) {
    if (typeof guard === 'string' && guard) guards.add(guard);
  }
  const metadataGuards = entryPoint.metadata?.guards;
  if (Array.isArray(metadataGuards)) {
    for (const guard of metadataGuards) {
      if (typeof guard === 'string' && guard) guards.add(guard);
    }
  }
  return [...guards];
}

function collectSecurityBoundaries(
  entryPoint: CASEntryPoint,
  pathNodeIds: Map<string, number>,
  guardEdgesByNode: Map<string, CASEdge[]>,
  nodesById: Map<string, CASNode>
): CASUserJourney['security_boundaries'] {
  const boundaries = new Map<string, CASUserJourney['security_boundaries'][number]>();

  const entryGuards = entryPointGuards(entryPoint);
  for (const guard of entryGuards) {
    boundaries.set(`guard:${guard}`, { name: guard, mechanism: 'entry-guard', kind: classifyGuardKind(guard) });
  }
  const hasNamedAuthenticationGuard = entryGuards.some(guard => classifyGuardKind(guard) === 'authentication');
  if (entryPoint.security?.authenticated && !hasNamedAuthenticationGuard) {
    boundaries.set('guard:authenticated', { name: 'authentication', mechanism: 'entry-guard', kind: 'authentication' });
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
        kind: classifyGuardKind(boundaryNode.name),
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
  const noObservedOutcome = !effects.hasAnyEffect && effects.terminalEntities.length === 0;
  if (score >= 10) return noObservedOutcome ? 'medium' : 'critical';
  if (score >= 6) return noObservedOutcome ? 'medium' : 'high';
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
      const MAX_DEPTH = 3;
      let widened = '';
      for (let depth = 1; depth <= MAX_DEPTH; depth += 1) {
        widened = `${name} (${journeyDiscriminator(item.entryPoint, depth)})`;
        if (!assigned.has(widened)) break;
      }
      name = widened;
    }
    if (assigned.has(name)) {
      name = `${item.journey.name} (${journeyDiscriminator(item.entryPoint)}, ${item.entryPoint.id})`;
    }
    assigned.add(name);
    item.journey.name = name;
  }
}

function journeyDiscriminator(entryPoint: CASEntryPoint, depth = 1): string {
  const method = entryPoint.trigger?.method?.toUpperCase();
  const path = entryPoint.trigger?.path;
  if (method && path) return `${method} ${path}`;
  if (entryPoint.type === 'cli') {
    const metadata = entryPoint.metadata || {};
    const parts = [
      cliMetadataString(metadata.binary) || cliMetadataString(metadata.crate),
      cliMetadataString(metadata.subcommand) || cliMetadataString(metadata.command)
    ].filter(Boolean);
    if (parts.length > 0) return parts.join(' ');
    const derived = cliProgramFromFilePath(entryPoint);
    if (derived) return derived;
  }
  const handler = entryPoint.metadata?.handler
    || entryPoint.metadata?.handler_method
    || entryPoint.metadata?.controller
    || entryPoint.handler?.method_name;
  if (handler) return String(handler);
  return discriminatorLabel(entryPoint.name, depth);
}

export function discriminatorLabel(raw: string | undefined, depth = 1): string {
  const value = String(raw || '').trim();
  if (!value) return value;
  if (!/[\\/]/.test(value) && !/\.\w{1,6}$/.test(value)) return value;
  const segments = value.split(/[\\/]/).filter(Boolean);
  if (segments.length === 0) return value;
  segments[segments.length - 1] = segments[segments.length - 1].replace(/\.\w{1,6}$/, '');
  const kept = segments.slice(Math.max(0, segments.length - Math.max(1, depth)));
  const label = kept.map(segment => humanizeLabel(segment)).filter(Boolean).join(' ').trim();
  return label || value;
}

function buildJourneyName(entryPoint: CASEntryPoint, effects: TerminalEffects): string {
  const action = describeEntryAction(entryPoint, effects);
  const outcome = describeTerminalOutcome(effects);
  const name = (!outcome || outcome === 'main') ? action : `${action} -> ${outcome}`;
  return dedupeAdjacentWords(name);
}

function describeEntryAction(entryPoint: CASEntryPoint, effects: TerminalEffects): string {
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
    const handlerPhrase = describeEntryActionFromHandlerName(entryPoint.handler?.method_name);
    if (handlerPhrase && resource && isHandlerNameEvidenceForResource(handlerPhrase, resource)) {
      return capitalizeLabel(handlerPhrase);
    }
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
  if (entryPoint.type === 'cli') return describeCliEntryAction(entryPoint);
  if (entryPoint.type === 'schedule') return `Scheduled ${humanizeLabel(entryPoint.name)}`;
  if (entryPoint.type === 'event' || entryPoint.type === 'message') {
    const subject = entryPoint.trigger?.event
      || entryPoint.trigger?.pattern
      || (entryPoint.metadata?.message_class ? String(entryPoint.metadata.message_class) : undefined)
      || entryPoint.name;
    return `Handle ${humanizeLabel(subject)}`;
  }
  if (entryPoint.type === 'page' || entryPoint.type === 'route') {
    const frontendAction = describeFrontendEntryAction(entryPoint, effects);
    if (frontendAction) return frontendAction;
    return `Visit ${entryPoint.trigger?.path || entryPoint.trigger?.pattern || humanizeLabel(entryPoint.name)}`;
  }
  return humanizeLabel(entryPoint.name);
}

const GENERIC_CLI_COMMAND_LABELS = new Set([
  '', 'cli', 'args', 'arguments', 'command', 'commands', 'subcommand', 'subcommands',
  'opts', 'options', 'opt', 'app', 'application', 'main', 'parser', 'config'
]);
const CLI_COMMAND_TYPE_SUFFIXES = /(clap|cli|args|arguments|options|opts|command|commands|parser)$/i;
const FILE_PATH_LIKE = /[\\/]|\.(rs|go|py|ts|js|cs|php|java|rb)$/i;

function describeCliEntryAction(entryPoint: CASEntryPoint): string {
  const metadata = entryPoint.metadata || {};
  const crate = cliMetadataString(metadata.crate);
  const program = cliMetadataString(metadata.binary) || crate;

  if (metadata.build_script) {
    const target = program || cliProgramFromFilePath(entryPoint)?.replace(/ build script$/, '');
    return target ? `Build ${target}` : 'Run build script';
  }

  const subcommand = cliMetadataString(metadata.subcommand);
  if (subcommand) {
    const action = humanizeLabel(subcommand).toLowerCase();
    if (!program) return `Run ${action} command`;
    const programLabel = humanizeLabel(program).toLowerCase();
    if (action === programLabel || action.startsWith(`${programLabel} `)) return capitalizeLabel(action);
    return `${capitalizeLabel(program)} ${action}`;
  }

  const command = cliMetadataString(metadata.command);
  if (command) {
    const label = humanizeLabel(command.replace(CLI_COMMAND_TYPE_SUFFIXES, '')).toLowerCase();
    if (!GENERIC_CLI_COMMAND_LABELS.has(label)) return `Run ${label}`;
    if (program) return `Run ${program}`;
  }

  const pattern = entryPoint.trigger?.pattern;
  if (pattern && !FILE_PATH_LIKE.test(pattern)) return `Run ${pattern}`;

  if (program) return `Run ${program}`;

  const name = entryPoint.name;
  if (name && name.toLowerCase() !== 'main' && !FILE_PATH_LIKE.test(name)) return `Run ${name}`;

  const derived = cliProgramFromFilePath(entryPoint);
  if (derived) return `Run ${derived}`;
  return name && name.toLowerCase() !== 'main' ? `Run ${name}` : 'Run program';
}

function cliMetadataString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

const CLI_STRUCTURE_DIRS = new Set(['src', 'bin', 'examples', 'crates', 'apps', 'cmd', 'packages', 'libs']);

function cliProgramFromFilePath(entryPoint: CASEntryPoint): string | undefined {
  const candidates = [
    entryPoint.handler?.file,
    entryPoint.trigger?.path,
    entryPoint.trigger?.pattern,
    entryPoint.source_node,
    entryPoint.id
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const match = candidate.match(/([\w@.~-]+(?:\/[\w@.~-]+)*\.(?:rs|go|py|ts|js|cs))/);
    if (!match) continue;
    const segments = match[1].split('/');
    const stem = segments[segments.length - 1].replace(/\.\w+$/, '');
    if (!/^(main|build|index|mod|lib|program)$/i.test(stem)) return stem;
    for (let i = segments.length - 2; i >= 0; i--) {
      const segment = segments[i];
      if (!CLI_STRUCTURE_DIRS.has(segment.toLowerCase())) {
        return /^build$/i.test(stem) ? `${segment} build script` : segment;
      }
    }
  }
  return undefined;
}

const SOURCE_FILE_EXTENSION = /\.(tsx|jsx|ts|js|mjs|cjs|vue|svelte|html?)$/i;
const FRONTEND_STRUCTURE_SEGMENTS = new Set([
  'src', 'app', 'apps', 'ui', 'lib', 'libs', 'modules', 'views', 'view', 'pages', 'page',
  'components', 'component', 'widgets', 'widget', 'partials', 'sections', 'elements',
  'layouts', 'layout', 'screens', 'screen', 'containers', 'features', 'shared', 'common'
]);
const FRONTEND_CONTEXT_TAIL_LABELS = new Set([
  'settings', 'details', 'detail', 'overview', 'summary', 'list', 'history', 'form', 'status'
]);
const FRONTEND_SUBJECT_VERBS = new Set([
  'create', 'update', 'delete', 'edit', 'add', 'remove', 'manage', 'forgot', 'reset',
  'register', 'login', 'logout', 'signup', 'signin', 'checkout', 'migrate', 'transfer',
  'buy', 'sell', 'search', 'upgrade', 'confirm', 'verify', 'cancel', 'review', 'connect',
  'setup', 'onboard', 'invite', 'share', 'export', 'import', 'upload', 'download', 'send'
]);
const COMPONENT_LABEL_SUFFIXES = /\s+(page|view|screen)$/;

function describeFrontendEntryAction(entryPoint: CASEntryPoint, effects: TerminalEffects): string | undefined {
  const segments = frontendPathSegments(entryPoint.trigger?.path || entryPoint.trigger?.pattern);
  let subject: string | undefined;
  let parent: string | undefined;

  let lastIndex = segments.length - 1;
  if (lastIndex >= 0 && segments[lastIndex].toLowerCase() === 'index') lastIndex -= 1;
  if (lastIndex >= 0) {
    const last = humanizeLabel(segments[lastIndex]);
    parent = lastIndex > 0 ? singularizeLabel(humanizeLabel(segments[lastIndex - 1])) : undefined;
    subject = parent && FRONTEND_CONTEXT_TAIL_LABELS.has(last) ? `${parent} ${last}` : last;
  }
  if (!subject) {
    const component = entryPoint.metadata?.component;
    if (typeof component === 'string' && /^[A-Z]/.test(component)) {
      const label = humanizeLabel(component).replace(COMPONENT_LABEL_SUFFIXES, '');
      if (label) subject = label;
    }
  }
  if (!subject) return undefined;

  const words = subject.split(' ');
  if (FRONTEND_SUBJECT_VERBS.has(words[0])) {
    const phrase = words.length === 1 && parent ? `${subject} ${parent}` : subject;
    return capitalizeLabel(phrase);
  }
  return `${frontendActionVerb(effects)} ${subject}`;
}

function frontendActionVerb(effects: TerminalEffects): string {
  const primary = effects.terminalEntities[0];
  if (primary?.access === 'created') return 'Create';
  if (primary?.access === 'updated') return 'Update';
  if (primary?.access === 'deleted') return 'Delete';
  return 'View';
}

function frontendPathSegments(path: string | undefined): string[] {
  if (!path) return [];
  return path
    .split('/')
    .map(segment => segment.trim())
    .filter(Boolean)
    .map(segment => segment.replace(SOURCE_FILE_EXTENSION, ''))
    .filter(segment => !/^[:{*[]/.test(segment))
    .filter(segment => !FRONTEND_STRUCTURE_SEGMENTS.has(segment.toLowerCase()));
}

function capitalizeLabel(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function flattenLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function describeEntryActionFromHandlerName(handlerName: string | undefined): string | undefined {
  const name = (handlerName || '').trim();
  if (!name) return undefined;
  if (isExcludedTerminalName(name)) return undefined;
  const humanized = humanizeLabel(name);
  if (!humanized || humanized.split(' ').length < 2) return undefined;
  return humanized;
}

function isHandlerNameEvidenceForResource(handlerPhrase: string, resource: string): boolean {
  const flatHandler = flattenLabel(handlerPhrase);
  const flatResource = flattenLabel(resource);
  if (flatResource.length < 3) return false;
  return flatHandler.startsWith(flatResource);
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

function singularizeEnglishWord(word: string): string {
  if (word.length > 4 && /ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (word.length > 5 && /(ses|xes|zes|ches|shes)$/.test(word)) return word.slice(0, -2);
  if (word.length > 4 && /s$/.test(word) && !/ss$/.test(word)) return word.slice(0, -1);
  return word;
}

function singularizeLabel(label: string): string {
  const words = label.split(' ');
  words[words.length - 1] = singularizeEnglishWord(words[words.length - 1]);
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
