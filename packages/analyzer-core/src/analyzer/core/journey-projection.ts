import type {
  CASCallChain,
  CASChangeRisk,
  CASDataEntity,
  CASEdge,
  CASEntryPoint,
  CASExitPoint,
  CASNode,
  CASOutput,
  CASUserJourney,
  CASUserJourneyStep,
  CASUserJourneySummary,
  FlowConcept,
} from '../../types/cas.types';
import { classifyGuardKind } from './guard-classification';
import { isGuardEnforcementEdge } from './guard-relationships';
import { isStructuralExecutableCliEntry } from './entry-point-product-role';
import { buildCronScheduleIndex, findCronSchedule, USER_FACING_ENTRY_TYPES } from './journey-builder';
import { isLanguageBuiltinExitPoint } from './language-builtins';

export interface JourneyProjectionInput {
  nodes: CASNode[];
  edges: CASEdge[];
  entryPoints: CASEntryPoint[];
  exitPoints: CASExitPoint[];
  callChains: CASCallChain[];
  dataEntities?: CASDataEntity[];
  changeRisks?: CASChangeRisk[];
  flows: FlowConcept[];
}

export interface JourneyProjectionResult {
  journeys: CASUserJourney[];
  summary: CASUserJourneySummary;
}

const RISK_ORDER: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const CRITICALITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const ENTRY_LAYER_TYPES = /(^|[_\s])(controller|gateway|resolver|handler|page|route|api_route|view|component|widget|screen|command|subscriber|listener)([_\s]|$)/;
const DATA_LAYER_TYPES = /(^|[_\s])(entity|repository|model|schema|migration|table|store|dao)([_\s]|$)/;
const INFRA_LAYER_TYPES = /(^|[_\s])(config|middleware|guard|interceptor|filter|pipe|decorator|logger|cache|hook)([_\s]|$)/;
const OPERATIONAL_SCRIPT_ENTRY_FILE = /\.(sh|bash|zsh|ps1|bat|cmd)$|(^|\/)(makefile|justfile)$/i;

function flowNodeIds(flow: FlowConcept, entryPoint: CASEntryPoint): Map<string, number> {
  const result = new Map<string, number>();
  const entryNodeId = entryPoint.handler?.node_id || entryPoint.source_node;
  if (entryNodeId) result.set(entryNodeId, 0);
  for (const [index, step] of flow.steps.entries()) {
    for (const fn of step.functions) {
      if (!result.has(fn.function_id)) result.set(fn.function_id, index + 1);
    }
    for (const mapping of step.code_mappings || []) {
      if (!result.has(mapping.code_region.node_id)) result.set(mapping.code_region.node_id, index + 1);
    }
  }
  return result;
}

function journeyLayer(node: CASNode | undefined, entryPoint: CASEntryPoint): CASUserJourneyStep['layer'] {
  if (!node) return 'business';
  const text = `${node.type} ${node.category || ''} ${(node.subcategories || []).join(' ')}`.toLowerCase();
  if (DATA_LAYER_TYPES.test(text)) return 'data';
  if (INFRA_LAYER_TYPES.test(text)) return 'infrastructure';
  if (ENTRY_LAYER_TYPES.test(text) || node.id === entryPoint.source_node || node.id === entryPoint.handler?.node_id) {
    return 'entry';
  }
  return 'business';
}

function journeyKind(
  entryPoint: CASEntryPoint,
  entryNode: CASNode | undefined,
  cronSchedule: string | undefined,
): CASUserJourney['journey_kind'] {
  if (entryPoint.type === 'schedule' || cronSchedule) return 'scheduled';
  const genericCli = entryPoint.type === 'cli' &&
    /^(?:main|application|server|index)(?:\.[a-z0-9]+)?$/i.test(String(entryPoint.name || entryPoint.handler?.method_name || '').trim());
  const external = entryPoint.interaction_reach === 'external' ||
    (entryPoint.interaction_reach !== 'internal' && USER_FACING_ENTRY_TYPES.has(entryPoint.type));
  const operationalScript = OPERATIONAL_SCRIPT_ENTRY_FILE.test(String(entryPoint.handler?.file || entryNode?.source?.file || ''));
  return external && !genericCli && !operationalScript && !isStructuralExecutableCliEntry(entryPoint)
    ? 'user-facing'
    : 'system';
}

function accessForEntity(entity: CASDataEntity, stateChanges: string[]): 'created' | 'updated' | 'deleted' | 'read' {
  const matching = stateChanges.find(change => change.toLowerCase().includes(entity.name.toLowerCase()));
  if (/\b(?:create|created|insert|inserted|add|added)\b/i.test(matching || '')) return 'created';
  if (/\b(?:delete|deleted|remove|removed)\b/i.test(matching || '')) return 'deleted';
  if (/\b(?:update|updated|write|written|persist|persisted|save|saved|change|changed)\b/i.test(matching || '')) return 'updated';
  return 'read';
}

function relatedChains(
  flow: FlowConcept,
  entryPoint: CASEntryPoint,
  nodeIds: ReadonlySet<string>,
  chains: CASCallChain[],
): CASCallChain[] {
  return chains.filter(chain => {
    const sameEntry = chain.entry_point.entry_point_id === entryPoint.id ||
      chain.entry_point.node_id === entryPoint.source_node ||
      chain.entry_point.node_id === entryPoint.handler?.node_id;
    if (!sameEntry) return false;
    if (flow.terminus?.exit_point_id) return chain.exit_point?.exit_point_id === flow.terminus.exit_point_id;
    return chain.call_path.some(call => nodeIds.has(call.node_id));
  });
}

function selectJourneys(journeys: CASUserJourney[], maxJourneys?: number): CASUserJourney[] {
  if (!maxJourneys || maxJourneys <= 0 || journeys.length <= maxJourneys) return journeys;
  const selected: CASUserJourney[] = [];
  const ids = new Set<string>();
  for (const kind of ['user-facing', 'system', 'scheduled'] as const) {
    const journey = journeys.find(candidate => candidate.journey_kind === kind);
    if (journey && selected.length < maxJourneys) {
      selected.push(journey);
      ids.add(journey.id);
    }
  }
  for (const journey of journeys) {
    if (selected.length >= maxJourneys) break;
    if (!ids.has(journey.id)) selected.push(journey);
  }
  return selected;
}

export function projectUserJourneysFromFlows(
  input: JourneyProjectionInput,
  options: { maxJourneys?: number } = {},
): JourneyProjectionResult {
  const nodesById = new Map(input.nodes.map(node => [node.id, node]));
  const entriesByKey = new Map<string, CASEntryPoint>();
  for (const entryPoint of input.entryPoints) {
    entriesByKey.set(entryPoint.id, entryPoint);
    if (entryPoint.source_node) entriesByKey.set(entryPoint.source_node, entryPoint);
    if (entryPoint.handler?.node_id) entriesByKey.set(entryPoint.handler.node_id, entryPoint);
  }
  const risksByNode = new Map((input.changeRisks || []).map(risk => [risk.node_id, risk.risk_level]));
  const cronSchedules = buildCronScheduleIndex(input.nodes);
  const journeys: CASUserJourney[] = [];

  for (const flow of input.flows) {
    const entryPoint = entriesByKey.get(flow.entry_point);
    if (!entryPoint || entryPoint.type === 'test') continue;
    const nodeDepths = flowNodeIds(flow, entryPoint);
    const nodeIds = new Set(nodeDepths.keys());
    const stateChanges = flow.contract.side_effects.state_changes || [];
    const entityEvidence = [...stateChanges, ...flow.contract.output, flow.terminus?.produces || '']
      .join(' ').toLowerCase();
    const participants = [...new Map((input.dataEntities || [])
      .filter(entity => flow.entities.includes(entity.id) || entityEvidence.includes(entity.name.toLowerCase()))
      .map(entity => [entity.id, entity])).values()];
    const terminalEntities = participants
      .filter(entity => entityEvidence.includes(entity.name.toLowerCase()))
      .map(entity => ({
        entity_id: entity.id,
        name: entity.name,
        access: accessForEntity(entity, stateChanges),
        terminal_kind: 'entity' as const,
      }));
    const participantAccess = participants.map(entity => ({ entity, access: accessForEntity(entity, stateChanges) }));
    const entitiesWritten = participantAccess.filter(item => item.access !== 'read').map(item => item.entity.name);
    const entitiesRead = participantAccess.filter(item => item.access === 'read').map(item => item.entity.name);
    const exits = input.exitPoints.filter(exitPoint =>
      exitPoint.id === flow.terminus?.exit_point_id ||
      (!flow.terminus && nodeIds.has(exitPoint.source_node)));
    const externalServices = new Set(flow.contract.side_effects.external_integrations || []);
    const messagesEmitted = new Set<string>();
    for (const exitPoint of exits) {
      if (exitPoint.type === 'message' || exitPoint.type === 'event') messagesEmitted.add(exitPoint.name);
      else if ((exitPoint.target?.service_id || exitPoint.target?.sdk) && !isLanguageBuiltinExitPoint(exitPoint)) {
        externalServices.add(exitPoint.target?.service_id || exitPoint.target?.sdk || '');
      }
    }
    const securityBoundaries = new Map<string, CASUserJourney['security_boundaries'][number]>();
    for (const guard of entryPoint.security?.guards || []) {
      securityBoundaries.set(guard, { name: guard, mechanism: 'entry-guard', kind: classifyGuardKind(guard) });
    }
    for (const edge of input.edges) {
      if (!isGuardEnforcementEdge(edge) || (!nodeIds.has(edge.source) && !nodeIds.has(edge.target))) continue;
      const guardId = nodeIds.has(edge.source) ? edge.target : edge.source;
      const guard = nodesById.get(guardId);
      if (guard) securityBoundaries.set(guard.id, {
        node_id: guard.id, name: guard.name, mechanism: edge.type, kind: classifyGuardKind(guard.name),
      });
    }
    const tests = new Set<string>();
    for (const edge of input.edges) {
      if ((edge.type === 'tests' || edge.type === 'covers') && nodeIds.has(edge.target)) tests.add(edge.source);
    }
    for (const nodeId of nodeIds) {
      for (const testId of nodesById.get(nodeId)?.testing?.tested_by || []) tests.add(testId);
    }
    const chains = relatedChains(flow, entryPoint, nodeIds, input.callChains);
    let risk: CASUserJourney['risk'];
    for (const nodeId of nodeIds) {
      const candidate = risksByNode.get(nodeId);
      if (candidate && (!risk || RISK_ORDER[candidate] > RISK_ORDER[risk])) risk = candidate;
    }
    const commandName = String((entryPoint.metadata as any)?.commandName || '').trim();
    const cronSchedule = entryPoint.type === 'cli' && commandName ? findCronSchedule(commandName, cronSchedules) : undefined;
    const kind = journeyKind(entryPoint, nodesById.get(entryPoint.handler?.node_id || entryPoint.source_node), cronSchedule);
    const steps = flow.steps.map((step, index) => {
      const nodeId = step.code_mappings?.[0]?.code_region.node_id || step.functions[0]?.function_id ||
        entryPoint.handler?.node_id || entryPoint.source_node;
      return { node_id: nodeId, name: step.name, layer: journeyLayer(nodesById.get(nodeId), entryPoint), depth: index };
    });
    const boundaries = [...securityBoundaries.values()].sort((left, right) => left.name.localeCompare(right.name));
    journeys.push({
      id: `journey_${flow.flow_id}`,
      name: flow.name,
      journey_kind: kind,
      entry_point_id: entryPoint.id,
      entry: {
        type: entryPoint.type, name: entryPoint.name, method: entryPoint.trigger?.method,
        path_or_trigger: cronSchedule || entryPoint.trigger?.path || entryPoint.trigger?.pattern ||
          entryPoint.trigger?.event || entryPoint.trigger?.schedule,
        handler_node_id: entryPoint.handler?.node_id,
      },
      steps,
      terminal_effects: {
        entities_written: entitiesWritten, entities_read: entitiesRead,
        external_services: [...externalServices].filter(Boolean).sort(),
        messages_emitted: [...messagesEmitted].sort(),
      },
      terminal_entities: terminalEntities,
      security_boundaries: boundaries,
      tests_covering: [...tests].sort(),
      risk,
      criticality: flow.criticality || (entitiesWritten.length > 0 || exits.length > 0 ? 'high' : kind === 'user-facing' ? 'medium' : 'low'),
      call_chain_ids: chains.map(chain => chain.id),
      exit_point_ids: exits.map(exitPoint => exitPoint.id),
      derived_from_flow_id: flow.flow_id,
      ...(flow.capability_relationships?.length ? { capability_relationships: flow.capability_relationships } : {}),
    });
  }
  journeys.sort((left, right) =>
    CRITICALITY_ORDER[left.criticality] - CRITICALITY_ORDER[right.criticality] || left.id.localeCompare(right.id));
  const byKind: CASUserJourneySummary['by_kind'] = { 'user-facing': 0, system: 0, scheduled: 0 };
  for (const journey of journeys) byKind[journey.journey_kind] += 1;
  const included = selectJourneys(journeys, options.maxJourneys);
  return { journeys: included, summary: { total_discovered: journeys.length, included: included.length, by_kind: byKind } };
}

export function projectUserJourneysFromCas(cas: CASOutput): JourneyProjectionResult {
  if (cas.flows) return projectUserJourneysFromFlows({
    nodes: cas.nodes || [],
    edges: cas.edges || [],
    entryPoints: cas.entry_points || [],
    exitPoints: cas.exit_points || [],
    callChains: cas.call_chains || [],
    dataEntities: cas.entities || [],
    changeRisks: cas.change_risks || [],
    flows: cas.flows,
  });
  const journeys = cas.user_journeys || [];
  const byKind: CASUserJourneySummary['by_kind'] = { 'user-facing': 0, system: 0, scheduled: 0 };
  for (const journey of journeys) byKind[journey.journey_kind] += 1;
  return { journeys, summary: cas.user_journey_summary || {
    total_discovered: journeys.length, included: journeys.length, by_kind: byKind,
  } };
}
