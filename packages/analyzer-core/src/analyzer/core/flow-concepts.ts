import { mergeFlowsByEntryPoint } from './flow-merge-by-entry';
import { flowTargetMatcher } from './flow-target';
import type { CASOutput,
  CASNode,
  CASEdge,
  CASEntryPoint,
  CASExitPoint,
  CASEntityLineage,
  CASCallChain,
  SystemCapability,
  CapabilityFlowRelationship,
  ComputeFlowConceptsOptions,
  ConstraintKind,
  ContractTelemetry,
  FacetConstraint,
  FacetProvenance,
  FlowConcept,
  FlowEdgeKind,
  FlowStep,
  FlowStepEdge,
  FlowStepGraph,
  ICELOTContract,
  ProvenanceFacet,
  StepCodeMapping,
  StepCodeRegion,
  StepCodeRelationship,
} from '../../types/cas.types';
import { hasUnresolvedDependencyEffect } from './exit-point-effects';
import { buildTerminalSignal } from './terminal-signal';
import { buildCronScheduleIndex, findCronSchedule, discriminatorLabel, USER_FACING_ENTRY_TYPES } from './journey-builder';
import { cleanRawFallbackName, dedupeAdjacentWords, flowNameForEntryPoint, titleCaseWords } from './flow-entry-naming';
export { dedupeAdjacentWords } from './flow-entry-naming';
import { guardConstraintKind } from './guard-classification';
import { httpRoutePathsMatch } from './http-route-path';
import { groundCapabilityFlowRelationships } from './capability-flow-evidence';
import {
  aggregateFlowContract,
  buildLifecycleEvidenceByNode,
  BEHAVIORAL_CODE_UNIT_TYPES,
  deriveContractLogic,
  facetAbstentions,
  mergeEvidence,
  mergeNodeContracts,
  sortFacetProvenance,
  type LifecycleContractEvidence,
} from './understanding-contract';
export { CONTRACT_MODEL_NAME, UNDERSTANDING_CONTRACT_FACETS } from '../../types/cas.types';
export { BEHAVIORAL_CODE_UNIT_TYPES as TRACEABLE_NODE_TYPES } from './understanding-contract';
export type {
  CapabilityFlowRelationship,
  ComputeFlowConceptsOptions,
  ConstraintKind,
  ContractTelemetry,
  FacetConstraint,
  FacetProvenance,
  FlowConcept,
  FlowEdgeKind,
  FlowICELOTContract,
  FlowStep,
  FlowStepEdge,
  FlowStepGraph,
  ICELOTContract,
  LogicSummary,
  ProvenanceFacet,
  StepCodeMapping,
  StepCodeRegion,
  StepCodeRelationship,
  StepCodeSubSegment,
  UnderstandingContractFacet,
} from '../../types/cas.types';
export interface ChainNode {
  node: CASNode;
  depth: number;
}
const TRACEABLE_NODE_TYPES = BEHAVIORAL_CODE_UNIT_TYPES;
const VALIDATE_NAME_RE = /\b(validate|guard|check|assert|sanitize|verify|authoriz|authentic)/i;
const RESPOND_NAME_RE = /\b(respond|render|reply|serialize|format|toJson|toResponse|present)/i;
export type StepRole = 'validate' | 'persist' | 'dispatch' | 'call_external' | 'respond' | 'process';
const ROLE_PRIORITY: StepRole[] = ['validate', 'persist', 'dispatch', 'call_external', 'respond', 'process'];

interface RoleOccurrence {
  node: CASNode;
  role: StepRole;
  evidence: string;
}

function deriveNodeRoleOccurrences(
  node: CASNode,
  exitPointsByNode: Map<string, CASExitPoint[]>,
  lineageByNode: Map<string, { writes: CASEntityLineage[]; reads: CASEntityLineage[] }>,
  entryPointsByNode: Map<string, CASEntryPoint[]>,
  terminusNodeId?: string,
  terminusKind?: string
): RoleOccurrence[] {
  const occurrences: RoleOccurrence[] = [];
  const ownExits = exitPointsByNode.get(node.id) || [];
  const lineage = lineageByNode.get(node.id);
  const eps = entryPointsByNode.get(node.id) || [];

  let validateEvidence: string | undefined;
  for (const ep of eps) {
    const hasAuth = Boolean(ep.security?.authenticated)
      || (ep.security?.guards || []).length > 0
      || (ep.security?.authorized_roles || ep.security?.roles || []).length > 0;
    if (hasAuth && !validateEvidence) {
      validateEvidence = `entry point "${ep.name}" security facts (auth guard)`;
    }
    if ((ep.input?.validation || []).length > 0 && !validateEvidence) {
      validateEvidence = `entry point "${ep.name}" input.validation rules`;
    }
  }
  if (!validateEvidence && VALIDATE_NAME_RE.test(node.name)) {
    validateEvidence = `function name "${node.name}" matches validate/guard naming pattern`;
  }
  if (validateEvidence) occurrences.push({ node, role: 'validate', evidence: validateEvidence });

  const dbExit = ownExits.find(e => e.type === 'database' || e.type === 'cache' || e.type === 'file');
  const writesEntity = lineage && lineage.writes.length > 0 ? lineage.writes[0] : undefined;
  if (dbExit || writesEntity) {
    const evidence = dbExit
      ? `exit point ${dbExit.id} (${dbExit.type}) on node "${node.name}"`
      : `data_lineage "${writesEntity!.entity_name}" writers include node "${node.name}"`;
    occurrences.push({ node, role: 'persist', evidence });
  }

  const dispatchExit = ownExits.find(e => e.type === 'message' || e.type === 'event');
  if (dispatchExit) {
    occurrences.push({
      node, role: 'dispatch',
      evidence: `exit point ${dispatchExit.id} (${dispatchExit.type}) on node "${node.name}"`,
    });
  }

  const isResponseTerminus = Boolean(
    terminusNodeId !== undefined && node.id === terminusNodeId
    && terminusKind && ['api', 'navigation'].includes(terminusKind)
  );
  const callExit = ownExits.find(e => ['api', 'webhook', 'sdk'].includes(e.type));
  if (callExit && !isResponseTerminus) {
    occurrences.push({
      node, role: 'call_external',
      evidence: `exit point ${callExit.id} (${callExit.type}) on node "${node.name}"`,
    });
  }

  if (isResponseTerminus) {
    occurrences.push({
      node, role: 'respond',
      evidence: `node resolves the flow's terminus exit point (${terminusKind})`,
    });
  } else if (RESPOND_NAME_RE.test(node.name)) {
    occurrences.push({
      node, role: 'respond',
      evidence: `function name "${node.name}" matches respond/render naming pattern`,
    });
  }

  if (occurrences.length === 0) {
    occurrences.push({
      node, role: 'process',
      evidence: `no validate/persist/dispatch/call/respond facts found for node "${node.name}"`,
    });
  }

  return occurrences.sort((a, b) => ROLE_PRIORITY.indexOf(a.role) - ROLE_PRIORITY.indexOf(b.role));
}

export function sourceFileOf(node: CASNode): string {
  return (node as any).file_path || node.source?.file || '';
}

export function layerOf(node: CASNode): string {
  if (node.category) return node.category;
  if (['controller', 'handler', 'route', 'resolver', 'gateway', 'react_route'].includes(node.type)) return 'entry';
  if (['repository', 'dao', 'model'].includes(node.type)) return 'data';
  if (['service', 'usecase', 'interactor'].includes(node.type)) return 'business';
  if (['component', 'functional_component', 'class_component', 'page', 'view'].includes(node.type)) return 'presentation';
  if (['hook_usage', 'hook'].includes(node.type)) return 'business';
  return 'unknown';
}

export interface TraversalIndex {
  nodesById: Map<string, CASNode>;
  outgoingEdges: Map<string, CASEdge[]>;
  outgoingMethodCalls: Map<string, string[]>;
}

export function buildTraversalIndex(cas: CASOutput): TraversalIndex {
  const nodesById = new Map(cas.nodes.map(n => [n.id, n]));
  const TRAVERSABLE_EDGE_TYPES = new Set(['renders', 'uses', 'triggers']);
  const outgoingEdges = new Map<string, CASEdge[]>();
  for (const edge of cas.edges) {
    const traversable = edge.type === 'calls' || edge.type === 'invokes' || edge.type.includes('call') || TRAVERSABLE_EDGE_TYPES.has(edge.type);
    if (!traversable) continue;
    if (!outgoingEdges.has(edge.source)) outgoingEdges.set(edge.source, []);
    outgoingEdges.get(edge.source)!.push(edge);
  }
  const outgoingMethodCalls = new Map<string, string[]>();
  for (const mc of cas.method_calls || []) {
    if (!mc.caller_node || !mc.target_node) continue;
    if (!outgoingMethodCalls.has(mc.caller_node)) outgoingMethodCalls.set(mc.caller_node, []);
    outgoingMethodCalls.get(mc.caller_node)!.push(mc.target_node);
  }
  return { nodesById, outgoingEdges, outgoingMethodCalls };
}

export function traceForwardChain(
  index: TraversalIndex,
  rootId: string
): ChainNode[] {
  const { nodesById, outgoingEdges, outgoingMethodCalls } = index;

  const visited = new Set<string>([rootId]);
  const chain: ChainNode[] = [];
  const rootNode = nodesById.get(rootId);
  if (rootNode) chain.push({ node: rootNode, depth: 0 });

  let frontier: string[] = [rootId];
  let depth = 0;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      const targets = [...new Set([
        ...(outgoingEdges.get(id) || []).map(e => e.target),
        ...(outgoingMethodCalls.get(id) || []),
      ])].sort();
      for (const targetId of targets) {
        if (visited.has(targetId)) continue;
        const targetNode = nodesById.get(targetId);
        if (!targetNode) continue;
        if (!TRACEABLE_NODE_TYPES.has(targetNode.type)) continue;
        visited.add(targetId);
        next.push(targetId);
        chain.push({ node: targetNode, depth: depth + 1 });
      }
    }
    frontier = next;
    depth++;
  }

  return chain;
}

function segmentIntoStepsByRole(
  chain: ChainNode[],
  exitPointsByNode: Map<string, CASExitPoint[]>,
  lineageByNode: Map<string, { writes: CASEntityLineage[]; reads: CASEntityLineage[] }>,
  entryPointsByNode: Map<string, CASEntryPoint[]>,
  terminusNodeId?: string,
  terminusKind?: string,
  sharedHelperNodeIds: ReadonlySet<string> = new Set(),
): Array<{ role: StepRole; nodes: CASNode[]; evidences: string[] }> {
  const occurrences: RoleOccurrence[] = [];
  for (const { node } of chain) {
    occurrences.push(
      ...deriveNodeRoleOccurrences(node, exitPointsByNode, lineageByNode, entryPointsByNode, terminusNodeId, terminusKind)
    );
  }

  const segments: Array<{ role: StepRole; nodes: CASNode[]; evidences: string[] }> = [];
  let collapsingSharedProcess = false;
  for (const occ of occurrences) {
    const last = segments[segments.length - 1];
    const sameRole = last && last.role === occ.role;
    const sharedProcess = occ.role === 'process'
      && sharedHelperNodeIds.has(occ.node.id)
      && !(entryPointsByNode.get(occ.node.id) || []).length;
    if (last && (sharedProcess || (collapsingSharedProcess && occ.role === 'process'))) {
      last.nodes.push(occ.node);
      last.evidences.push(occ.evidence);
      collapsingSharedProcess = true;
      continue;
    }
    collapsingSharedProcess = sharedProcess;
    const previousNode = last?.nodes[last.nodes.length - 1];
    const crossesErrorBoundary = occ.role === 'process' && Boolean(
      (previousNode?.signature?.throws || []).length || (occ.node.signature?.throws || []).length
    );
    if (last && sameRole && !crossesErrorBoundary) {
      last.nodes.push(occ.node);
      last.evidences.push(occ.evidence);
    } else {
      segments.push({ role: occ.role, nodes: [occ.node], evidences: [occ.evidence] });
    }
  }

  return segments;
}

function sharedHelperNodeIds(cas: CASOutput): Set<string> {
  const callersByNode = new Map<string, Set<string>>();
  for (const edge of cas.edges || []) {
    const traversable = edge.type === 'calls' || edge.type === 'invokes' || edge.type.includes('call');
    if (!traversable || edge.source === edge.target) continue;
    const callers = callersByNode.get(edge.target) || new Set<string>();
    callers.add(edge.source);
    callersByNode.set(edge.target, callers);
  }
  return new Set([...callersByNode.entries()]
    .filter(([, callers]) => callers.size >= 3)
    .map(([nodeId]) => nodeId));
}

function detectSubSections(
  node: CASNode
): Array<{ start_line: number; end_line: number; label: string }> | undefined {
  const raw = node.source?.raw;
  const startLine = node.source?.line;
  const endLine = node.source?.end_line;
  if (!raw || !startLine || !endLine || endLine <= startLine) return undefined;
  if (endLine - startLine < 6) return undefined;

  const lines = raw.split('\n');
  if (lines.length < 6) return undefined;

  let lastGuardLineIdx = -1;
  const GUARD_RE = /\b(if|throw|require|assert)\s*\(/;
  const RETURN_EARLY_RE = /\breturn\b/;
  for (let i = 0; i < Math.min(lines.length, 25); i++) {
    const line = lines[i];
    if (GUARD_RE.test(line) || (RETURN_EARLY_RE.test(line) && i < 15)) {
      lastGuardLineIdx = i;
    } else if (lastGuardLineIdx >= 0 && line.trim() !== '' && !line.trim().startsWith('}') && !line.trim().startsWith('//')) {
      break;
    }
  }
  if (lastGuardLineIdx < 0 || lastGuardLineIdx >= lines.length - 2) return undefined;

  const guardEndLine = startLine + lastGuardLineIdx;
  return [
    { start_line: startLine, end_line: guardEndLine, label: 'guard clauses' },
    { start_line: guardEndLine + 1, end_line: endLine, label: 'body' },
  ];
}

function dominantEntityForNodes(
  nodeIds: Set<string>,
  lineage: CASEntityLineage[]
): string | undefined {
  const counts = new Map<string, number>();
  for (const entry of lineage) {
    const touches = [...entry.writers, ...entry.readers].some(a => nodeIds.has(a.node_id));
    if (touches) counts.set(entry.entity_name, (counts.get(entry.entity_name) || 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

function externalServiceForNodes(nodeIds: Set<string>, exitPointsByNode: Map<string, CASExitPoint[]>): string | undefined {
  for (const id of nodeIds) {
    const eps = exitPointsByNode.get(id) || [];
    const ext = eps.find(ep => ['api', 'webhook', 'sdk'].includes(ep.type));
    if (ext) return ext.target?.service_id || ext.target?.sdk || ext.name;
  }
  return undefined;
}

function externalOperationForNodes(
  nodeIds: Set<string>,
  exitPointsByNode: Map<string, CASExitPoint[]>
): string | undefined {
  for (const id of nodeIds) {
    const ep = (exitPointsByNode.get(id) || []).find(e => ['api', 'webhook', 'sdk'].includes(e.type));
    if (!ep) continue;
    const md: any = ep.metadata || {};
    const candidates = [md.function, ep.target?.endpoint, ep.operation?.action];
    for (const c of candidates) {
      if (typeof c !== 'string') continue;
      if (!/^[A-Za-z_$][\w$]*$/.test(c)) continue;
      if (/^(external_call|call|get|post|put|patch|delete|head|options)$/i.test(c)) continue;
      return c;
    }
  }
  return undefined;
}

function dispatchTargetForNodes(nodeIds: Set<string>, exitPointsByNode: Map<string, CASExitPoint[]>): string | undefined {
  for (const id of nodeIds) {
    const eps = exitPointsByNode.get(id) || [];
    const ev = eps.find(e => e.type === 'message' || e.type === 'event');
    if (ev) return ev.target?.service_id || ev.target?.resource || ev.name;
  }
  return undefined;
}

function apiRouteCallsForNodes(
  nodeIds: Set<string>,
  exitPointsByNode: Map<string, CASExitPoint[]>
): Array<{ method: string; path: string }> {
  const calls: Array<{ method: string; path: string }> = [];
  for (const id of nodeIds) {
    const eps = exitPointsByNode.get(id) || [];
    for (const ep of eps) {
      if (ep.type !== 'api') continue;
      const method = ep.operation?.method;
      const endpoint = ep.target?.endpoint;
      if (!method || !endpoint) continue;
      calls.push({ method: method.toUpperCase(), path: endpoint });
    }
  }
  return calls;
}

const CRUD_VERB_RE = /^(create|update|delete|remove|save|register|reserve|cancel|approve|reject|complete|submit|book|schedule)/i;
const PROCESS_VERB_RE = /^(create|update|delete|remove|save|register|reserve|cancel|approve|reject|complete|submit|book|schedule|process|handle|apply|assign|generate|calculate|build|prepare|charge|refund|transfer|assign)/i;

function verbForNode(node: CASNode, re: RegExp): string | undefined {
  const m = re.exec(node.name);
  return m ? m[1] : undefined;
}

function titleizeWord(w: string): string {
  return w.length ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w;
}

function nameStepForRole(
  role: StepRole,
  nodes: CASNode[],
  exitPointsByNode: Map<string, CASExitPoint[]>,
  lineage: CASEntityLineage[]
): { name: string; description: string; grounded: boolean } {
  const result = nameStepForRoleImpl(role, nodes, exitPointsByNode, lineage);
  return { ...result, name: dedupeAdjacentWords(result.name) };
}

function nameStepForRoleImpl(
  role: StepRole,
  nodes: CASNode[],
  exitPointsByNode: Map<string, CASExitPoint[]>,
  lineage: CASEntityLineage[]
): { name: string; description: string; grounded: boolean } {
  const nodeIds = new Set(nodes.map(n => n.id));
  const fnNames = nodes.map(n => n.name).join(', ');

  if (role === 'validate') {
    const entity = dominantEntityForNodes(nodeIds, lineage);
    const name = entity ? `Validate ${entity}` : 'Validate Request';
    return { name, description: `Guards/validates ${entity ? `${entity} ` : ''}input via ${fnNames}.`, grounded: true };
  }

  if (role === 'persist') {
    const entity = dominantEntityForNodes(nodeIds, lineage);
    const verbNode = nodes.find(n => verbForNode(n, CRUD_VERB_RE));
    const verb = verbNode ? verbForNode(verbNode, CRUD_VERB_RE) : undefined;
    if (verb && entity) {
      return {
        name: `${titleizeWord(verb)} ${entity}`,
        description: `Writes ${entity} to storage via ${fnNames} (verb "${verb}" on "${verbNode!.name}").`,
        grounded: true,
      };
    }
    const name = entity ? `Persist ${entity}` : 'Persist Data';
    return {
      name,
      description: entity ? `Writes ${entity} to storage (${fnNames}).` : `Persists state via ${fnNames}.`,
      grounded: true,
    };
  }

  if (role === 'dispatch') {
    const target = dispatchTargetForNodes(nodeIds, exitPointsByNode);
    const name = target ? `Publish ${target}` : 'Publish Event';
    return {
      name,
      description: `Publishes an async handoff${target ? ` to ${target}` : ''} via ${fnNames}.`,
      grounded: true,
    };
  }

  if (role === 'call_external') {
    const service = externalServiceForNodes(nodeIds, exitPointsByNode);
    const operation = externalOperationForNodes(nodeIds, exitPointsByNode);
    if (operation) {
      const op = titleCaseWords(operation);
      return {
        name: service ? `${op} via ${service}` : op,
        description: service
          ? `Calls ${operation} on external service ${service} via ${fnNames}.`
          : `Calls ${operation} outside the process via ${fnNames}.`,
        grounded: true,
      };
    }
    const name = service ? `Call ${service}` : 'Call External Service';
    return {
      name,
      description: service ? `Calls external service ${service} via ${fnNames}.` : `Reaches outside the process via ${fnNames}.`,
      grounded: true,
    };
  }

  if (role === 'respond') {
    return { name: 'Respond', description: `Formats/returns the result via ${fnNames}.`, grounded: true };
  }


  const entity = dominantEntityForNodes(nodeIds, lineage);
  const verbNodes = nodes.filter(n => verbForNode(n, PROCESS_VERB_RE));
  const specificVerbNode = verbNodes.find(n => {
    const candidate = verbForNode(n, PROCESS_VERB_RE)?.toLowerCase();
    return candidate !== 'handle' && candidate !== 'process';
  });
  const verbNode = specificVerbNode || (nodes.length === 1 ? verbNodes[0] : undefined);
  const verb = verbNode ? verbForNode(verbNode, PROCESS_VERB_RE) : undefined;
  if (verb && entity) {
    return { name: `${titleizeWord(verb)} ${entity}`, description: `Core logic via ${fnNames} (verb "${verb}" on "${verbNode!.name}").`, grounded: true };
  }
  if (entity) {
    return { name: `Process ${entity}`, description: `Core logic touching ${entity} via ${fnNames}.`, grounded: true };
  }
  if (verb) {
    return { name: titleizeWord(verb), description: `Core logic (verb "${verb}" on "${verbNode!.name}") via ${fnNames}.`, grounded: true };
  }
  const representativeNode = nodes.find(node =>
    layerOf(node) !== 'entry' && !/^(handle|process)/i.test(node.name)
  ) || nodes[0];
  const lead = titleCaseWords(representativeNode?.name || '');
  const name = lead || (nodes.length === 1 ? `Process (${nodes[0].name})` : 'Process');
  return {
    name,
    description: `No entity/verb evidence found for this segment; conservative grouping of ${fnNames}.`,
    grounded: false,
  };
}

function entryPointTriggerLabel(ep: CASEntryPoint): string {
  return (
    ep.trigger?.pattern ||
    ep.trigger?.event ||
    (typeof ep.metadata?.event === 'string' ? ep.metadata.event : undefined) ||
    ep.trigger?.schedule ||
    ep.name
  );
}

function groupEventVariantEntryPoints(
  entryPoints: CASEntryPoint[],
  originalIndex: Map<string, number>
): {
  primaryByRoot: Map<string, CASEntryPoint>;
  triggersByPrimaryId: Map<string, string[]>;
  groupedAwayIds: Set<string>;
} {
  const byRoot = new Map<string, CASEntryPoint[]>();
  for (const ep of entryPoints) {
    if (ep.type !== 'event') continue;
    const rootId = ep.handler?.node_id || ep.source_node;
    if (!rootId) continue;
    if (!byRoot.has(rootId)) byRoot.set(rootId, []);
    byRoot.get(rootId)!.push(ep);
  }

  const primaryByRoot = new Map<string, CASEntryPoint>();
  const triggersByPrimaryId = new Map<string, string[]>();
  const groupedAwayIds = new Set<string>();
  for (const [rootId, members] of byRoot) {
    if (members.length < 2) continue;
    const sorted = [...members].sort(
      (a, b) => (originalIndex.get(a.id) ?? 0) - (originalIndex.get(b.id) ?? 0)
    );
    const primary = sorted[0];
    primaryByRoot.set(rootId, primary);
    const triggers = [...new Set(sorted.map(entryPointTriggerLabel).filter(Boolean))].sort();
    triggersByPrimaryId.set(primary.id, triggers);
    for (const ep of sorted.slice(1)) groupedAwayIds.add(ep.id);
  }

  return { primaryByRoot, triggersByPrimaryId, groupedAwayIds };
}

function buildLineageIndex(cas: CASOutput): Map<string, { writes: CASEntityLineage[]; reads: CASEntityLineage[] }> {
  const index = new Map<string, { writes: CASEntityLineage[]; reads: CASEntityLineage[] }>();
  for (const entry of cas.data_lineage || []) {
    for (const w of entry.writers) {
      if (!index.has(w.node_id)) index.set(w.node_id, { writes: [], reads: [] });
      index.get(w.node_id)!.writes.push(entry);
    }
    for (const r of entry.readers) {
      if (!index.has(r.node_id)) index.set(r.node_id, { writes: [], reads: [] });
      index.get(r.node_id)!.reads.push(entry);
    }
  }
  return index;
}

function buildEntryHandlerNodeIdByEpId(cas: CASOutput): Map<string, string> {
  const index = new Map<string, string>();
  for (const ep of cas.entry_points || []) {
    index.set(ep.id, ep.handler?.node_id || ep.source_node);
  }
  return index;
}

function buildExitPointIndex(cas: CASOutput): Map<string, CASExitPoint[]> {
  const index = new Map<string, CASExitPoint[]>();
  for (const ep of cas.exit_points || []) {
    if (!index.has(ep.source_node)) index.set(ep.source_node, []);
    index.get(ep.source_node)!.push(ep);
  }
  return index;
}

interface ContractFactIndex {
  nodesById: Map<string, CASNode>;
  behaviorEdgesBySource: Map<string, CASEdge[]>;
  lifecycleEvidenceByNode: Map<string, LifecycleContractEvidence[]>;
  invariantsByNode: Map<string, Array<{ description: string; entityName: string }>>;
  eventualConsistencyByExitId: Map<string, NonNullable<CASOutput['consistency_model']>['store_consistency'][number]>;
  passiveSeamsByTarget: Map<string, NonNullable<CASOutput['consistency_model']>['passive_seams']>;
  lineageByNode: Map<string, CASEntityLineage[]>;
  lineageOrdinal: Map<CASEntityLineage, number>;
  exitSourceById: Map<string, string>;
  unresolvedExitPointIds: Set<string>;
  entryPointNameById: Map<string, string>;
  tryCatchNodeIds: Set<string>;
  callChains: Array<{
    chain: CASCallChain;
    nodeIds: Set<string>;
    entryKeys: Set<string>;
    entryName: string;
    caught: boolean;
  }>;
}

const contractFactIndexes = new WeakMap<CASOutput, ContractFactIndex>();

function contractFactIndex(cas: CASOutput): ContractFactIndex {
  const cached = contractFactIndexes.get(cas);
  if (cached) return cached;

  const nodesById = new Map((cas.nodes || []).map(node => [node.id, node]));
  const behaviorEdgesBySource = new Map<string, CASEdge[]>();
  for (const edge of cas.edges || []) {
    if (!['calls', 'invokes', 'delegates_to', 'branches_to', 'continues_to'].includes(edge.type)) continue;
    const edges = behaviorEdgesBySource.get(edge.source) || [];
    edges.push(edge);
    behaviorEdgesBySource.set(edge.source, edges);
  }
  const lifecycleEvidenceByNode = buildLifecycleEvidenceByNode(cas.entities || [], normalizeEntityKey);
  const invariantsByNode = new Map<string, Array<{ description: string; entityName: string }>>();
  for (const entity of cas.entities || []) {
    for (const invariant of entity.invariants || []) {
      for (const nodeId of invariant.enforced_by || []) {
        const values = invariantsByNode.get(nodeId) || [];
        values.push({ description: invariant.description, entityName: entity.name });
        invariantsByNode.set(nodeId, values);
      }
    }
  }

  const eventualConsistencyByExitId = new Map<string, NonNullable<CASOutput['consistency_model']>['store_consistency'][number]>();
  for (const consistency of cas.consistency_model?.store_consistency || []) {
    if (consistency.consistency.staleness_risk) eventualConsistencyByExitId.set(consistency.ref_id, consistency);
  }
  const passiveSeamsByTarget = new Map<string, NonNullable<CASOutput['consistency_model']>['passive_seams']>();
  for (const seam of cas.consistency_model?.passive_seams || []) {
    const seams = passiveSeamsByTarget.get(seam.target) || [];
    seams.push(seam);
    passiveSeamsByTarget.set(seam.target, seams);
  }

  const exitSourceById = new Map((cas.exit_points || []).map(exit => [exit.id, exit.source_node]));
  const lineageByNode = new Map<string, CASEntityLineage[]>();
  const lineageOrdinal = new Map<CASEntityLineage, number>();
  for (const [ordinal, lineage] of (cas.data_lineage || []).entries()) {
    lineageOrdinal.set(lineage, ordinal);
    const nodeIds = new Set([
      ...(lineage.writers || []).map(writer => writer.node_id),
      ...(lineage.readers || []).map(reader => reader.node_id),
      ...(lineage.external_recipients || []).flatMap(recipient => {
        const carrier = recipient.via_node ?? exitSourceById.get(recipient.exit_point_id);
        return carrier ? [carrier] : [];
      }),
    ]);
    for (const nodeId of nodeIds) {
      const entries = lineageByNode.get(nodeId) || [];
      entries.push(lineage);
      lineageByNode.set(nodeId, entries);
    }
  }

  const entryPointNameById = new Map<string, string>();
  for (const entryPoint of cas.entry_points || []) {
    entryPointNameById.set(entryPoint.id, entryPoint.name);
    if (!entryPointNameById.has(entryPoint.source_node)) entryPointNameById.set(entryPoint.source_node, entryPoint.name);
  }
  const tryCatchNodeIds = new Set<string>();
  for (const pattern of cas.patterns || []) {
    if (!pattern.name.toLowerCase().includes('try-catch')) continue;
    for (const nodeId of pattern.instances || []) tryCatchNodeIds.add(nodeId);
  }
  const callChains = (cas.call_chains || []).map(chain => {
    const nodeIds = new Set((chain.call_path || []).map(step => step.node_id));
    const entryId = chain.entry_point.entry_point_id || chain.entry_point.node_id;
    return {
      chain,
      nodeIds,
      entryKeys: new Set([entryId, chain.entry_point.node_id].filter(Boolean)),
      entryName: entryPointNameById.get(entryId) || chain.entry_point.method_name || entryId,
      caught: [...nodeIds].some(nodeId => tryCatchNodeIds.has(nodeId)),
    };
  });

  const index: ContractFactIndex = {
    nodesById,
    behaviorEdgesBySource,
    lifecycleEvidenceByNode,
    invariantsByNode,
    eventualConsistencyByExitId,
    passiveSeamsByTarget,
    lineageByNode,
    lineageOrdinal,
    exitSourceById,
    unresolvedExitPointIds: new Set((cas.exit_points || []).filter(hasUnresolvedDependencyEffect).map(exit => exit.id)),
    entryPointNameById,
    tryCatchNodeIds,
    callChains,
  };
  contractFactIndexes.set(cas, index);
  return index;
}

function extractConstraintsFromSource(node: CASNode): FacetConstraint[] {
  const raw = node.source?.raw;
  if (!raw) return [];
  const out: FacetConstraint[] = [];
  const seen = new Set<string>();
  const push = (kind: ConstraintKind, rule: string, evidence: string) => {
    if (seen.has(rule)) return;
    seen.add(rule);
    out.push({ kind, rule, evidence });
  };

  const callGuardRe = /\b(?:require|assert)\s*\(\s*([^,)]+?)\s*(?:,|\))/g;
  let m: RegExpExecArray | null;
  while ((m = callGuardRe.exec(raw))) {
    const expr = m[1].trim();
    if (expr) push('business-rule', `must satisfy: ${expr}`, m[0].trim());
  }

  const negatedThrowRe = /if\s*\(\s*!\s*([^)]+?)\s*\)\s*(?:\{[^}]*)?throw/g;
  while ((m = negatedThrowRe.exec(raw))) {
    const cond = m[1].trim();
    if (cond) push('business-rule', `must hold: ${cond}`, m[0].trim());
  }

  const directThrowRe = /if\s*\(\s*([^)!][^)]*?)\s*\)\s*(?:\{[^}]*)?throw/g;
  while ((m = directThrowRe.exec(raw))) {
    const cond = m[1].trim();
    if (cond) push('business-rule', `must NOT hold: ${cond}`, m[0].trim());
  }

  return out;
}

function extractStructuralConstraints(
  nodeIds: Set<string>,
  cas: CASOutput,
  ownEntryPoints: CASEntryPoint[],
  exitPointsByNode: Map<string, CASExitPoint[]>,
  scopeEntryPointIds?: Set<string>
): FacetConstraint[] {
  const facts = contractFactIndex(cas);
  const out: FacetConstraint[] = [];
  const seen = new Set<string>();
  const push = (kind: ConstraintKind, rule: string, evidence: string) => {
    const key = `${kind}::${rule}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, rule, evidence });
  };

  for (const ep of ownEntryPoints) {
    if (ep.security?.authenticated) {
      push('auth', 'caller must be authenticated', `entry point "${ep.name}" security.authenticated=true`);
    }
    for (const role of ep.security?.authorized_roles || ep.security?.roles || []) {
      push('auth', `caller must have role: ${role}`, `entry point "${ep.name}" security.roles`);
    }
    for (const guard of ep.security?.guards || []) {
      push(guardConstraintKind(guard), `guarded by: ${guard}`, `entry point "${ep.name}" security.guards`);
    }
    for (const rule of ep.input?.validation || []) {
      push('validation', rule, `entry point "${ep.name}" input.validation`);
    }
    const rateLimit = (ep.security as any)?.rate_limit ?? (ep as any)?.rate_limit;
    if (rateLimit) {
      push('rate-limit', `rate limited: ${typeof rateLimit === 'string' ? rateLimit : JSON.stringify(rateLimit)}`,
        `entry point "${ep.name}" rate_limit`);
    }
  }

  for (const nodeId of nodeIds) {
    for (const invariant of facts.invariantsByNode.get(nodeId) || []) {
      push('invariant', invariant.description, `data_entity "${invariant.entityName}" invariant enforced_by a node in this unit`);
    }
  }

  if (cas.consistency_model) {
    const ownExitIds = new Set<string>();
    for (const id of nodeIds) {
      for (const ep of exitPointsByNode.get(id) || []) ownExitIds.add(ep.id);
    }
    for (const exitId of ownExitIds) {
      const sc = facts.eventualConsistencyByExitId.get(exitId);
      if (!sc) continue;
      const cap = sc.consistency.cap_lean ? ` (${sc.consistency.cap_lean})` : '';
      push('consistency', `reads from ${sc.store} are eventually consistent${cap} — may observe stale data`,
        sc.consistency.evidence);
    }
    for (const nodeId of nodeIds) {
      for (const seam of facts.passiveSeamsByTarget.get(nodeId) || []) {
        push('consistency', `reads via ${seam.channel} (${seam.shared_resource}) are eventually consistent — may lag the source`,
          seam.evidence);
      }
    }
  }

  for (const c of extractErrorConstraints(nodeIds, cas, scopeEntryPointIds)) push(c.kind, c.rule, c.evidence);

  return out;
}

function extractErrorConstraints(
  nodeIds: Set<string>,
  cas: CASOutput,
  scopeEntryPointIds?: Set<string>
): FacetConstraint[] {
  const facts = contractFactIndex(cas);
  const out: FacetConstraint[] = [];
  const seen = new Set<string>();
  const push = (rule: string, evidence: string) => {
    if (seen.has(rule)) return;
    seen.add(rule);
    out.push({ kind: 'error', rule, evidence });
  };

  const throwingHere = new Set<string>();
  for (const nodeId of nodeIds) {
    const node = facts.nodesById.get(nodeId);
    if (!node) continue;
    for (const errorType of node.signature?.throws || []) {
      throwingHere.add(node.id);
      push(`throws ${errorType}`, `node "${node.name}" signature.throws includes ${errorType}`);
    }
  }

  if (throwingHere.size > 0) {
    for (const indexedChain of facts.callChains) {
      const { chain } = indexedChain;
      if (scopeEntryPointIds && scopeEntryPointIds.size > 0) {
        if (![...indexedChain.entryKeys].some(key => scopeEntryPointIds.has(key))) continue;
      }
      const throwerOnPath = (chain.call_path || []).find(step => throwingHere.has(step.node_id));
      if (!throwerOnPath) continue;
      if (indexedChain.caught) continue;
      const epName = indexedChain.entryName;
      push(`uncaught path to entry point ${epName}`,
        `call chain ${chain.id} traverses throwing node "${throwerOnPath.method_name}" and reaches entry point ${epName} with no try-catch on the path`);
    }
  }

  const ERROR_CONSTRAINT_CAP = 12;
  if (out.length > ERROR_CONSTRAINT_CAP) {
    const dropped = out.length - ERROR_CONSTRAINT_CAP;
    const capped = out.slice(0, ERROR_CONSTRAINT_CAP);
    capped.push({
      kind: 'error',
      rule: `+${dropped} more uncaught-throw paths (truncated)`,
      evidence: `${dropped} additional error constraints of the same shape were derived; truncated to keep the contract readable`,
    });
    return capped;
  }
  return out;
}

function buildEvidenceContract(
  nodes: CASNode[],
  cas: CASOutput,
  exitPointsByNode: Map<string, CASExitPoint[]>,
  entryPointsByNode: Map<string, CASEntryPoint[]>,
  scopeEntryPointIds?: Set<string>
): ICELOTContract {
  const facts = contractFactIndex(cas);
  const input = new Set<string>();
  const output = new Set<string>();
  const stateChanges = new Set<string>();
  const externalIntegrations = new Set<string>();
  const unresolvedExitPointIds = new Set<string>();
  const constraints: FacetConstraint[] = [];
  const provenanceByKey = new Map<string, FacetProvenance>();
  const recordEvidence = (facet: ProvenanceFacet, value: string, evidence: string, contributedNodeIds: Iterable<string>) => {
    const key = `${facet}\u0000${value}`;
    const existing = provenanceByKey.get(key);
    if (existing) {
      existing.contributed_by_node_ids = [...new Set([
        ...(existing.contributed_by_node_ids || []),
        ...contributedNodeIds,
      ])].sort();
      existing.evidence = mergeEvidence(existing.evidence, evidence);
      return;
    }
    provenanceByKey.set(key, {
      facet,
      value,
      contributed_by_node_ids: [...new Set(contributedNodeIds)].sort(),
      source: 'deterministic',
      evidence,
    });
  };
  const constraintKeys = new Set<string>();
  const addConstraint = (c: FacetConstraint, contributedNodeIds: Iterable<string>) => {
    const key = `${c.kind}::${c.rule}`;
    if (!constraintKeys.has(key)) {
      constraintKeys.add(key);
      constraints.push(c);
    }
    recordEvidence('constraint', c.rule, c.evidence, contributedNodeIds);
  };
  const nodeIds = new Set(nodes.map(n => n.id));
  const sourceConstraintsByNode = new Map<string, FacetConstraint[]>();

  for (const node of nodes) {
    for (const p of node.signature?.parameters || []) {
      const v = p.type ? `${p.name}: ${p.type}` : p.name;
      input.add(v);
      recordEvidence('input', v, `node ${node.id} signature.parameters`, [node.id]);
    }
    if (node.signature?.return_type) {
      output.add(node.signature.return_type);
      recordEvidence('output', node.signature.return_type, `node ${node.id} signature.return_type`, [node.id]);
    }

    for (const ep of exitPointsByNode.get(node.id) || []) {
      if (hasUnresolvedDependencyEffect(ep)) {
        unresolvedExitPointIds.add(ep.id);
        continue;
      }
      const label = ep.target?.service_id || ep.target?.resource || `${ep.type}:${ep.name}`;
      if (ep.type === 'database' || ep.type === 'cache' || ep.type === 'file') {
        stateChanges.add(label);
        recordEvidence('state_change', label, `exit point ${ep.id} (${ep.type}) on node ${node.id}`, [node.id]);
      } else {
        externalIntegrations.add(label);
        recordEvidence('external_integration', label, `exit point ${ep.id} (${ep.type}) on node ${node.id}`, [node.id]);
      }
    }

    const sourceConstraints = extractConstraintsFromSource(node);
    sourceConstraintsByNode.set(node.id, sourceConstraints);
    for (const c of sourceConstraints) addConstraint(c, [node.id]);
  }

  const relevantLineage = new Set<CASEntityLineage>();
  for (const nodeId of nodeIds) {
    for (const lineage of facts.lineageByNode.get(nodeId) || []) relevantLineage.add(lineage);
  }
  const writtenLifecycleEntityKeys = new Set<string>();
  for (const node of nodes) {
    for (const item of facts.lifecycleEvidenceByNode.get(node.id) || []) {
      if (item.facet === 'input') input.add(item.value);
      else stateChanges.add(item.value);
      if (item.facet === 'state_change' && item.entityKey) writtenLifecycleEntityKeys.add(item.entityKey);
      recordEvidence(item.facet, item.value, item.evidence, [node.id]);
    }
  }
  const orderedLineage = [...relevantLineage].sort((left, right) =>
    (facts.lineageOrdinal.get(left) ?? 0) - (facts.lineageOrdinal.get(right) ?? 0));
  for (const entry of orderedLineage) {
    const writesHere = entry.writers.some(w => nodeIds.has(w.node_id));
    const readsHere = entry.readers.some(r => nodeIds.has(r.node_id));
    if (writesHere && !writtenLifecycleEntityKeys.has(normalizeEntityKey(entry.entity_name))) {
      stateChanges.add(`${entry.entity_name} updated`);
      const writerIds = entry.writers.map(writer => writer.node_id).filter(id => nodeIds.has(id));
      recordEvidence('state_change', `${entry.entity_name} updated`,
        `data_lineage "${entry.entity_name}" writers include a node in this unit`, writerIds);
    }
    if (readsHere && !input.has(`reads ${entry.entity_name}`)) {
      input.add(`reads ${entry.entity_name}`);
      const readerIds = entry.readers.map(reader => reader.node_id).filter(id => nodeIds.has(id));
      recordEvidence('input', `reads ${entry.entity_name}`,
        `data_lineage "${entry.entity_name}" readers include a node in this unit`, readerIds);
    }
    for (const recipient of entry.external_recipients) {
      const carrier = recipient.via_node ?? facts.exitSourceById.get(recipient.exit_point_id);
      if (!carrier || !nodeIds.has(carrier)) continue;
      if (facts.unresolvedExitPointIds.has(recipient.exit_point_id)) {
        unresolvedExitPointIds.add(recipient.exit_point_id);
        continue;
      }
      externalIntegrations.add(recipient.service);
      recordEvidence('external_integration', recipient.service,
        `data_lineage "${entry.entity_name}" transfer to ${recipient.service} through node ${carrier} at exit ${recipient.exit_point_id}`,
        [carrier]);
    }
  }

  const ownEntryPoints = nodes.flatMap(n => entryPointsByNode.get(n.id) || []);
  for (const c of extractStructuralConstraints(nodeIds, cas, ownEntryPoints, exitPointsByNode, scopeEntryPointIds)) {
    addConstraint(c, nodeIds);
  }

  const logic = deriveContractLogic(nodes, facts, sourceConstraintsByNode);
  if (logic) recordEvidence('logic', logic.value, logic.evidence, logic.nodeIds);
  const facetProvenance = sortFacetProvenance([...provenanceByKey.values()]);
  const contract: ICELOTContract = {
    input: [...input],
    logic: logic?.value || '',
    side_effects: {
      state_changes: [...stateChanges],
      external_integrations: [...externalIntegrations],
      ...(unresolvedExitPointIds.size > 0 ? { unresolved_exit_point_ids: [...unresolvedExitPointIds].sort() } : {}),
    },
    output: [...output],
    constraints,
    ...(facetProvenance.length > 0 ? { facet_provenance: facetProvenance } : {}),
  };
  contract.facet_abstentions = facetAbstentions(contract);
  return contract;
}

export function deriveNodeUnderstandingContracts(cas: CASOutput): Map<string, ICELOTContract> {
  contractFactIndexes.delete(cas);
  const exitPointsByNode = buildExitPointIndex(cas);
  const entryPointsByNode = new Map<string, CASEntryPoint[]>();
  for (const entryPoint of cas.entry_points || []) {
    const nodeId = entryPoint.handler?.node_id || entryPoint.source_node;
    const entries = entryPointsByNode.get(nodeId) || [];
    entries.push(entryPoint);
    entryPointsByNode.set(nodeId, entries);
  }
  const contracts = new Map<string, ICELOTContract>();
  for (const node of cas.nodes || []) {
    if (TRACEABLE_NODE_TYPES.has(node.type)) {
      contracts.set(node.id, buildEvidenceContract([node], cas, exitPointsByNode, entryPointsByNode));
    }
  }
  contractFactIndexes.delete(cas);
  return contracts;
}
export function materializeNodeUnderstandingContracts(cas: CASOutput): void {
  const contracts = deriveNodeUnderstandingContracts(cas);
  for (const node of cas.nodes || []) {
    const contract = contracts.get(node.id);
    if (contract) node.contract = contract;
    else delete node.contract;
  }
  const nodesById = new Map((cas.nodes || []).map(node => [node.id, node]));
  for (const flow of cas.flows || []) {
    for (const step of flow.steps || []) {
      const nodes = step.functions
        .map(reference => nodesById.get(reference.function_id))
        .filter((node): node is CASNode => Boolean(node));
      step.contract = mergeNodeContracts(nodes);
    }
    flow.contract = aggregateFlowContract(flow.steps || []);
  }
  if (cas.flows) cas.steps = cas.flows.flatMap(flow => flow.steps || []);
  contractFactIndexes.delete(cas);
}

function entitiesForNodes(nodeIds: Set<string>, cas: CASOutput): string[] {
  const names = new Set<string>();
  for (const entry of cas.data_lineage || []) {
    const touches = [...entry.writers, ...entry.readers].some(a => nodeIds.has(a.node_id));
    if (touches) names.add(entry.entity_name);
  }
  for (const entity of cas.entities || []) {
    const touchers = [
      ...(entity.lifecycle?.created_by || []),
      ...(entity.lifecycle?.read_by || []),
      ...(entity.lifecycle?.updated_by || []),
      ...(entity.lifecycle?.deleted_by || []),
    ];
    if (touchers.some(id => nodeIds.has(id))) names.add(entity.name);
  }
  return [...names];
}

const CLI_ONE_HOP_CALLEE_EDGE_TYPES = new Set(['calls', 'invokes', 'delegates_to', 'uses', 'queries']);

function makeCliOneHopEntities(cas: CASOutput): (nodeIds: Set<string>) => string[] {
  const directCalleesBySource = new Map<string, Set<string>>();
  for (const edge of cas.edges || []) {
    if (!CLI_ONE_HOP_CALLEE_EDGE_TYPES.has(edge.type)) continue;
    let callees = directCalleesBySource.get(edge.source);
    if (!callees) { callees = new Set(); directCalleesBySource.set(edge.source, callees); }
    callees.add(edge.target);
  }
  return (nodeIds: Set<string>): string[] => {
    const hopIds = new Set<string>();
    for (const nodeId of nodeIds) {
      for (const callee of directCalleesBySource.get(nodeId) || []) {
        if (!nodeIds.has(callee)) hopIds.add(callee);
      }
    }
    if (hopIds.size === 0) return [];
    return entitiesForNodes(hopIds, cas);
  };
}

export function normalizeEntityKey(ref: string): string {
  return String(ref).toLowerCase().replace(/^entity_/, '').replace(/[^a-z0-9]/g, '');
}

function makeEntryFamilyEntities(
  cas: CASOutput,
  index: TraversalIndex
): (rootId: string | undefined) => string[] {
  const memo = new Map<string, string[]>();
  return (rootId: string | undefined): string[] => {
    if (!rootId) return [];
    const cached = memo.get(rootId);
    if (cached) return cached;
    const family = traceForwardChain(index, rootId);
    const familyIds = new Set(family.map(c => c.node.id));
    familyIds.add(rootId);
    const entities = entitiesForNodes(familyIds, cas);
    memo.set(rootId, entities);
    return entities;
  };
}

function unionEntities(primary: string[], extra: string[]): string[] {
  if (extra.length === 0) return primary;
  const seen = new Set(primary);
  const out = [...primary];
  for (const name of extra) {
    if (!seen.has(name)) { seen.add(name); out.push(name); }
  }
  return out;
}

const TELEMETRY_EXIT_KINDS = new Set(['analytics']);

function telemetryExitDominance(
  nodeIds: Set<string>,
  exitPointsByNode: Map<string, CASExitPoint[]>,
  terminusKind?: string
): { dominated: boolean; evidence?: string } {
  const telemetry: CASExitPoint[] = [];
  let otherCount = 0;
  for (const id of nodeIds) {
    for (const ep of exitPointsByNode.get(id) || []) {
      if (TELEMETRY_EXIT_KINDS.has(ep.type)) telemetry.push(ep);
      else otherCount++;
    }
  }
  if (terminusKind && TELEMETRY_EXIT_KINDS.has(terminusKind)) {
    return { dominated: true, evidence: `flow terminus is a telemetry exit (kind '${terminusKind}')` };
  }
  if (telemetry.length > 0 && telemetry.length > otherCount) {
    const names = telemetry.slice(0, 3).map(e => e.name).join(', ');
    return {
      dominated: true,
      evidence: `${telemetry.length}/${telemetry.length + otherCount} of the flow's exit points are telemetry kinds (${names})`,
    };
  }
  return { dominated: false };
}

function deriveCliCronSchedule(
  entryPoint: CASEntryPoint | undefined,
  cronScheduleIndex: Map<string, string>
): string | undefined {
  if (!entryPoint || entryPoint.type !== 'cli') return undefined;
  const commandName = String((entryPoint.metadata as any)?.commandName || '').trim();
  if (!commandName) return undefined;
  return findCronSchedule(commandName, cronScheduleIndex);
}

function deriveCapabilityRelationships(args: {
  capabilities: SystemCapability[];
  entryPointId?: string;
  rootNodeId?: string;
  entities: string[];
  telemetry: { dominated: boolean; evidence?: string };
  pathNodeIds?: Set<string>;
  entryHandlerNodeIdByEpId?: Map<string, string>;
  cronSchedule?: string;
  entryType?: string;
  apiRouteCalls?: Array<{ method: string; path: string }>;
}): CapabilityFlowRelationship[] {
  const { capabilities, entryPointId, rootNodeId, entities, telemetry, pathNodeIds, entryHandlerNodeIdByEpId, cronSchedule, entryType, apiRouteCalls } = args;
  const out: CapabilityFlowRelationship[] = [];
  const entityKeySet = new Set(entities.map(normalizeEntityKey));

  for (const cap of capabilities) {
    const opMatch = (cap.operations || []).find(op => {
      if (entryPointId !== undefined && op.entry_point_id === entryPointId) return true;
      if (rootNodeId !== undefined && (op.entry_point_id === `node:${rootNodeId}` || op.entry_point_id === rootNodeId)) return true;
      if (rootNodeId !== undefined && entryHandlerNodeIdByEpId) {
        const handlerNodeId = entryHandlerNodeIdByEpId.get(op.entry_point_id);
        if (handlerNodeId !== undefined && handlerNodeId === rootNodeId) return true;
      }
      return false;
    });
    if (opMatch) {
      out.push({
        capability_id: cap.id,
        role: 'primary',
        rationale: `capability operation "${opMatch.action}" (entry_point_id=${opMatch.entry_point_id}) references this flow's entry point`,
        evidence: 'operation',
      });
      continue;
    }

    if (pathNodeIds && entryHandlerNodeIdByEpId) {
      const interiorOp = (cap.operations || []).find(op => {
        const handlerNodeId = entryHandlerNodeIdByEpId.get(op.entry_point_id)
          ?? (op.entry_point_id?.startsWith('node:') ? op.entry_point_id.slice('node:'.length) : undefined);
        return handlerNodeId !== undefined
          && handlerNodeId !== rootNodeId
          && pathNodeIds.has(handlerNodeId);
      });
      if (interiorOp) {
        out.push({
          capability_id: cap.id,
          role: 'supporting',
          rationale: `capability operation "${interiorOp.action}" (entry_point_id=${interiorOp.entry_point_id}) is realized as an interior step on this flow's path`,
          evidence: 'interior-step',
        });
        continue;
      }
    }

    if (apiRouteCalls && apiRouteCalls.length > 0) {
      let routeMatch: { op: SystemCapability['operations'][number]; call: { method: string; path: string } } | undefined;
      for (const op of cap.operations || []) {
        const opMethod = op.trigger?.method;
        const opPath = op.trigger?.path;
        if (!opMethod || !opPath) continue;
        const call = apiRouteCalls.find(c =>
          c.method === opMethod.toUpperCase() &&
          httpRoutePathsMatch(c.path, opPath, { allowPatternSuffix: true })
        );
        if (call) { routeMatch = { op, call }; break; }
      }
      if (routeMatch) {
        out.push({
          capability_id: cap.id,
          role: 'supporting',
          rationale: `flow calls ${routeMatch.call.method} ${routeMatch.call.path}, which matches capability operation "${routeMatch.op.action}"'s route (${routeMatch.op.trigger?.method} ${routeMatch.op.trigger?.path}) — this capability's operation is served by that call`,
          evidence: 'route',
        });
        continue;
      }
    }

    const shared = (cap.related_entities || []).filter(name => entityKeySet.has(normalizeEntityKey(String(name))));
    if (shared.length === 0) continue;
    const sharedList = shared.join(', ');
    if (telemetry.dominated) {
      out.push({
        capability_id: cap.id,
        role: 'observability',
        rationale: `flow touches this capability's related entities (${sharedList}) and ${telemetry.evidence}`,
        evidence: 'entity-overlap',
      });
    } else if (cronSchedule) {
      out.push({
        capability_id: cap.id,
        role: 'operational',
        rationale: `flow touches entities in this capability's related_entities (${sharedList}); its CLI entry point is scheduled by a CronJob (${cronSchedule}) — scheduled operational work for this capability, not a direct operation`,
        evidence: 'entity-overlap',
      });
    } else {
      out.push({
        capability_id: cap.id,
        role: 'supporting',
        rationale: `flow touches entities in this capability's related_entities (${sharedList}) but its entry point is not among the capability's operations`,
        evidence: 'entity-overlap',
      });
    }
  }

  if (out.length === 0 && entryType) {
    for (const cap of capabilities) {
      if ((cap as { evidence_kind?: string }).evidence_kind !== 'behavior-surface') continue;
      const opTypes = new Set((cap.operations || []).map(op => op.entry_point_type));
      if (opTypes.size !== 1 || !opTypes.has(entryType)) continue;
      out.push({
        capability_id: cap.id,
        role: cronSchedule ? 'operational' : 'supporting',
        rationale: cronSchedule
          ? `registered on the "${cap.name}" behavior surface (entry type ${entryType}); scheduled by a CronJob (${cronSchedule}) — operational surface work`
          : `registered on the "${cap.name}" behavior surface (entry type ${entryType}) — no core capability references this flow`,
        evidence: 'surface-membership',
      });
      break;
    }
  }

  return out;
}

export function applyFlowRoleToCapabilityRelationships(
  flow: Pick<FlowConcept, 'capability_relationships'>,
  role: string | undefined,
  roleEvidence?: string[]
): void {
  if (role !== 'infrastructure' || !flow.capability_relationships) return;
  for (const rel of flow.capability_relationships) {
    if (rel.role !== 'supporting') continue;
    rel.role = 'operational';
    rel.rationale += `; flow classified 'infrastructure' by the semantic-role classifier${roleEvidence && roleEvidence.length ? ` (${roleEvidence[0]})` : ''}`;
  }
}

const CAPABILITY_ENTRY_TYPE_MAP: Record<string, CASEntryPoint['type']> = {
  http: 'http', websocket: 'websocket', cli: 'cli', event: 'event',
  schedule: 'schedule', page: 'page', route: 'route', message: 'message',
  file: 'file', test: 'test', lifecycle: 'lifecycle',
};

function deriveCapabilityOperationRoots(
  cas: CASOutput,
  capabilities: SystemCapability[],
  nodesById: Map<string, CASNode>,
  existingRootNodeIds: Set<string>
): Array<{ ep: CASEntryPoint; synthesized: true }> {
  const seen = new Set<string>();
  const roots: Array<{ ep: CASEntryPoint; synthesized: true }> = [];

  for (const cap of capabilities) {
    for (const op of cap.operations || []) {
      if (!op.entry_point_id.startsWith('node:')) continue;
      const nodeId = op.entry_point_id.slice('node:'.length);
      if (existingRootNodeIds.has(nodeId)) continue;
      if (seen.has(nodeId)) continue;
      const node = nodesById.get(nodeId);
      if (!node) continue;
      if (!TRACEABLE_NODE_TYPES.has(node.type) && node.type !== 'method') continue;
      seen.add(nodeId);

      const type = CAPABILITY_ENTRY_TYPE_MAP[op.entry_point_type] || 'message';
      roots.push({
        synthesized: true,
        ep: {
          id: `synthflow:${nodeId}`,
          source_node: nodeId,
          type,
          name: node.name,
          description: `Operation "${op.action}" of capability "${cap.name}" (no dedicated entry_points root — traced directly from the capability's referenced node).`,
          trigger: op.path_or_command ? { pattern: op.path_or_command } : undefined,
          handler: { node_id: nodeId, method_name: node.name },
        },
      });
    }
  }

  return roots;
}


const IMMUTABLE_CONTENT_PARAM = /(checksum|digest|fingerprint|etag)/i;

const STATIC_ASSET_EXTENSION = /\.(?:ico|css|map|woff2?|ttf|eot|manifest|json)$/i;

function isAssetOrProxyPlumbingRoute(ep: CASEntryPoint): boolean {
  const path = ep.trigger?.path;
  if (!path) return false;
  const segments = path.split('/').filter(Boolean);
  if (segments.some(seg => (seg.startsWith(':') || seg.startsWith('{')) && IMMUTABLE_CONTENT_PARAM.test(seg))) {
    return true;
  }
  const last = segments[segments.length - 1];
  if (last && !last.startsWith(':') && !last.startsWith('{') && STATIC_ASSET_EXTENSION.test(last)) {
    return true;
  }
  return false;
}


function flowIntentForEntryPoint(ep: CASEntryPoint): string {
  const method = ep.trigger?.method ? `${ep.trigger.method} ` : '';
  const path = ep.trigger?.path || ep.trigger?.pattern || ep.trigger?.event || ep.trigger?.schedule || '';
  const via = path ? `${method}${path}`.trim() : ep.name;
  return `Handles ${ep.type} entry "${via}"${ep.description ? `: ${ep.description}` : ''}`;
}

function buildConditionalOutIndex(cas: CASOutput): Map<string, string> {
  const index = new Map<string, string>();
  for (const edge of cas.edges || []) {
    if (edge.metadata?.conditional === true && !index.has(edge.source)) {
      index.set(edge.source, `call edge ${edge.id} (${edge.source} -> ${edge.target}) is conditional (edge.metadata.conditional)`);
    }
  }
  for (const mc of cas.method_calls || []) {
    const caller = mc.caller_node;
    if (!caller || index.has(caller)) continue;
    if (mc.execution_context?.is_conditional) {
      const name = mc.call_details?.method_name || mc.target_node || '';
      index.set(caller, `method call ${name} from ${caller} is made in a conditional context (execution_context.is_conditional)`.replace(/\s+/g, ' ').trim());
    }
  }
  return index;
}

function buildDeleterNodeIds(cas: CASOutput): Set<string> {
  const ids = new Set<string>();
  for (const entity of cas.entities || []) {
    for (const id of entity.lifecycle?.deleted_by || []) ids.add(id);
  }
  return ids;
}

const STEP_CODE_MAPPING_CAP = 50;

function buildStepMappingEvidence(cas: CASOutput): {
  tryCatchEvidence: Map<string, string>;
  invariantEvidence: Map<string, string>;
} {
  const tryCatchEvidence = new Map<string, string>();
  for (const p of cas.patterns || []) {
    if (!p.name.toLowerCase().includes('try-catch')) continue;
    for (const id of p.instances || []) {
      if (!tryCatchEvidence.has(id)) {
        tryCatchEvidence.set(id, `node is an instance of pattern "${p.name}" — sits on a catch/failure-handling path`);
      }
    }
  }
  const invariantEvidence = new Map<string, string>();
  for (const entity of cas.entities || []) {
    for (const inv of entity.invariants || []) {
      for (const id of inv.enforced_by || []) {
        if (!invariantEvidence.has(id)) {
          invariantEvidence.set(id, `enforces data_entity "${entity.name}" invariant: ${inv.description}`);
        }
      }
    }
  }
  return { tryCatchEvidence, invariantEvidence };
}

function codeRegionFor(node: CASNode): StepCodeRegion {
  const region: StepCodeRegion = { node_id: node.id };
  if (node.source?.file) region.file = node.source.file;
  const line = node.source?.line;
  const endLine = node.source?.end_line;
  if (typeof line === 'number' && typeof endLine === 'number' && endLine >= line) {
    region.line_range = [line, endLine];
  }
  return region;
}

function deriveStepCodeMappings(args: {
  stepId: string;
  segNodes: CASNode[];
  isFirstStep: boolean;
  isTerminalStep: boolean;
  rootNodeId?: string;
  rootEpRef?: string;
  terminus?: { node_id: string; exit_point_id: string; kind: string };
  prevNodes?: CASNode[];
  nextNodes?: CASNode[];
  exitPointsByNode: Map<string, CASExitPoint[]>;
  lineageByNode: Map<string, { writes: CASEntityLineage[]; reads: CASEntityLineage[] }>;
  entryPointsByNode: Map<string, CASEntryPoint[]>;
  conditionalOut: Map<string, string>;
  tryCatchEvidence: Map<string, string>;
  invariantEvidence: Map<string, string>;
}): { mappings: StepCodeMapping[]; truncated: number } {
  const {
    stepId, segNodes, isFirstStep, isTerminalStep, rootNodeId, rootEpRef, terminus,
    prevNodes, nextNodes, exitPointsByNode, lineageByNode, entryPointsByNode,
    conditionalOut, tryCatchEvidence, invariantEvidence,
  } = args;

  const byKey = new Map<string, StepCodeMapping>();
  const add = (node: CASNode, relationship: StepCodeRelationship, contribution: string) => {
    const key = `${node.id}\u0000${relationship}`;
    if (byKey.has(key)) return;
    byKey.set(key, {
      step_id: stepId,
      code_region: codeRegionFor(node),
      relationship,
      contribution,
      confidence: 1.0,
    });
  };

  const nextReads = new Set<string>();
  for (const n of nextNodes || []) {
    for (const e of lineageByNode.get(n.id)?.reads || []) nextReads.add(e.entity_name);
  }
  const prevWrites = new Set<string>();
  for (const n of prevNodes || []) {
    for (const e of lineageByNode.get(n.id)?.writes || []) prevWrites.add(e.entity_name);
  }

  const multi = segNodes.length > 1;
  for (const node of segNodes) {
    let specific = false;
    const mark = (relationship: StepCodeRelationship, contribution: string) => {
      specific = true;
      add(node, relationship, contribution);
    };

    if (isFirstStep && rootNodeId !== undefined && node.id === rootNodeId) {
      mark('initiates', `bound to the flow's entry point${rootEpRef ? ` ${rootEpRef}` : ''} (root handler node)`);
    }
    if (isTerminalStep && terminus && node.id === terminus.node_id) {
      mark('completes', `resolves the flow's terminus exit point ${terminus.exit_point_id} (${terminus.kind})`);
    }

    const srcGuard = extractConstraintsFromSource(node)[0];
    if (srcGuard) mark('validates', `enforces "${srcGuard.rule}" (guard clause in node source)`);
    for (const ep of entryPointsByNode.get(node.id) || []) {
      const hasAuth = Boolean(ep.security?.authenticated)
        || (ep.security?.guards || []).length > 0
        || (ep.security?.authorized_roles || ep.security?.roles || []).length > 0;
      if (hasAuth) mark('validates', `entry point "${ep.name}" carries auth guards (security facts)`);
      if ((ep.input?.validation || []).length > 0) {
        mark('validates', `entry point "${ep.name}" carries input.validation rules`);
      }
    }
    const invEv = invariantEvidence.get(node.id);
    if (invEv) mark('validates', invEv);

    const tcEv = tryCatchEvidence.get(node.id);
    if (tcEv) mark('handles_failure', tcEv);

    const branchEv = conditionalOut.get(node.id);
    if (branchEv) mark('branches', branchEv);

    const exits = exitPointsByNode.get(node.id) || [];
    const writes = lineageByNode.get(node.id)?.writes || [];
    const effectExit = exits.find(e => !TELEMETRY_EXIT_KINDS.has(e.type));
    if (effectExit) {
      const facet = ['database', 'cache', 'file'].includes(effectExit.type) ? 'state change' : 'external integration';
      mark('causes_effect', `exit point ${effectExit.id} (${effectExit.type}) on this node — ${facet}`);
    } else if (writes.length > 0) {
      mark('causes_effect', `data_lineage "${writes[0].entity_name}" writers include this node — state change`);
    }
    const telemetryExit = exits.find(e => TELEMETRY_EXIT_KINDS.has(e.type));
    if (telemetryExit && !effectExit && writes.length === 0) {
      mark('observes', `all exits on this node are telemetry kinds (exit point ${telemetryExit.id}, ${telemetryExit.type}) and it writes no entity`);
    }

    if (nextReads.size > 0) {
      const provided = writes.find(w => nextReads.has(w.entity_name));
      if (provided) {
        mark('provides_input', `writes "${provided.entity_name}" which the next step's nodes read (data_lineage)`);
      }
    }
    if (prevWrites.size > 0) {
      const reads = lineageByNode.get(node.id)?.reads || [];
      const consumed = reads.find(r => prevWrites.has(r.entity_name));
      if (consumed) {
        mark('consumes_output', `reads "${consumed.entity_name}" which the previous step's nodes wrote (data_lineage)`);
      }
    }

    if (!specific) {
      add(
        node,
        multi ? 'partially_implements' : 'implements',
        multi
          ? `one of ${segNodes.length} nodes realizing this step's segment ("${node.name}")`
          : `sole node of this step's segment ("${node.name}")`
      );
    }
  }

  const sorted = [...byKey.values()].sort((a, b) =>
    a.code_region.node_id.localeCompare(b.code_region.node_id)
    || a.relationship.localeCompare(b.relationship));
  if (sorted.length > STEP_CODE_MAPPING_CAP) {
    return { mappings: sorted.slice(0, STEP_CODE_MAPPING_CAP), truncated: sorted.length - STEP_CODE_MAPPING_CAP };
  }
  return { mappings: sorted, truncated: 0 };
}

const STEP_GRAPH_EDGE_CAP = 250;

function buildStepGraph(
  steps: FlowStep[],
  segmentNodes: CASNode[][],
  conditionalOut: Map<string, string>,
  deleterNodeIds: Set<string>
): FlowStepGraph | undefined {
  if (steps.length < 2) return undefined;
  const edges: FlowStepEdge[] = [];
  const limit = Math.min(steps.length - 1, STEP_GRAPH_EDGE_CAP);
  for (let i = 0; i < limit; i++) {
    const from = steps[i];
    const to = steps[i + 1];
    const fromNodes = segmentNodes[i] || [];
    const toNodes = segmentNodes[i + 1] || [];

    const toErr = to.contract.constraints.find(c => c.kind === 'error');
    let branchEv: string | undefined;
    for (const n of fromNodes) {
      const ev = conditionalOut.get(n.id);
      if (ev) { branchEv = ev; break; }
    }
    const fromIsError = from.contract.constraints.some(c => c.kind === 'error');
    const revertsState = toNodes.some(n => deleterNodeIds.has(n.id));

    let kind: FlowEdgeKind = 'sequence';
    let evidence: string | undefined;
    if (fromIsError && revertsState) {
      kind = 'compensation';
      evidence = `follows an error-carrying step and reverts state (a entities.lifecycle.deleted_by node runs in "${to.name}")`;
    } else if (toErr) {
      kind = 'error';
      evidence = toErr.evidence;
    } else if (branchEv) {
      kind = 'branch';
      evidence = branchEv;
    }
    edges.push(evidence
      ? { from_step_id: from.step_id, to_step_id: to.step_id, kind, evidence }
      : { from_step_id: from.step_id, to_step_id: to.step_id, kind });
  }
  return { edges };
}

function normalizeChannelKey(raw: string | undefined): string {
  if (raw === undefined || raw === null) return '';
  const trimmed = String(raw).trim().toLowerCase().replace(/^['"]+|['"]+$/g, '');
  if (trimmed === 'external' || trimmed === 'channel') return '';
  const key = trimmed.replace(/[^a-z0-9]/g, '');
  return key.length < 2 ? '' : key;
}

function pairPublishConsumeSeams(cas: CASOutput): Array<{ exitId: string; entryId: string; channel: string }> {
  const pairs: Array<{ exitId: string; entryId: string; channel: string }> = [];
  const seen = new Set<string>();
  const add = (exitId: string, entryId: string, channel: string) => {
    if (!exitId || !entryId) return;
    const key = `${exitId}\u0000${entryId}`;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push({ exitId, entryId, channel });
  };

  const seams = cas.communication_seams?.seams;
  if (seams && seams.length > 0) {
    const consumersByChannel = new Map<string, string[]>();
    for (const s of seams) {
      const entryId = (s.metadata as Record<string, unknown> | undefined)?.entry_point;
      if (s.kind !== 'messaging' || typeof entryId !== 'string') continue;
      const channel = normalizeChannelKey(s.source);
      if (!channel) continue;
      if (!consumersByChannel.has(channel)) consumersByChannel.set(channel, []);
      consumersByChannel.get(channel)!.push(entryId);
    }
    if (consumersByChannel.size > 0) {
      for (const s of seams) {
        const exitId = (s.metadata as Record<string, unknown> | undefined)?.exit_point;
        if (s.kind !== 'messaging' || typeof exitId !== 'string') continue;
        const channel = normalizeChannelKey(s.target);
        if (!channel) continue;
        for (const entryId of consumersByChannel.get(channel) || []) add(exitId, entryId, channel);
      }
      if (pairs.length > 0) {
        pairs.sort((a, b) => a.exitId.localeCompare(b.exitId) || a.entryId.localeCompare(b.entryId));
        return pairs;
      }
    }
  }

  const consumersByChannel = new Map<string, string[]>();
  for (const ep of cas.entry_points || []) {
    if (ep.type !== 'message' && ep.type !== 'event') continue;
    const channel = normalizeChannelKey(ep.trigger?.event || ep.name);
    if (!channel) continue;
    if (!consumersByChannel.has(channel)) consumersByChannel.set(channel, []);
    consumersByChannel.get(channel)!.push(ep.id);
  }
  if (consumersByChannel.size === 0) return pairs;
  for (const exit of cas.exit_points || []) {
    if (exit.type !== 'message' && exit.type !== 'event') continue;
    const target = exit.target?.service_id || exit.target?.resource || exit.target?.endpoint || exit.name;
    const channel = normalizeChannelKey(target);
    if (!channel) continue;
    for (const entryId of consumersByChannel.get(channel) || []) add(exit.id, entryId, channel);
  }
  pairs.sort((a, b) => a.exitId.localeCompare(b.exitId) || a.entryId.localeCompare(b.entryId));
  return pairs;
}

export function stitchContinuations(flows: FlowConcept[], cas: CASOutput): FlowConcept[] {
  if (flows.length < 2) return flows;
  const pairs = pairPublishConsumeSeams(cas);
  if (pairs.length === 0) return flows;

  const flowByTerminusExit = new Map<string, FlowConcept>();
  const flowByEntryPoint = new Map<string, FlowConcept>();
  for (const f of flows) {
    if (f.terminus?.exit_point_id && !flowByTerminusExit.has(f.terminus.exit_point_id)) {
      flowByTerminusExit.set(f.terminus.exit_point_id, f);
    }
    if (!flowByEntryPoint.has(f.entry_point)) flowByEntryPoint.set(f.entry_point, f);
  }

  const contByPub = new Map<string, Set<string>>();
  const fromByCon = new Map<string, Set<string>>();
  for (const { exitId, entryId } of pairs) {
    const pub = flowByTerminusExit.get(exitId);
    const con = flowByEntryPoint.get(entryId);
    if (!pub || !con || pub.flow_id === con.flow_id) continue;
    if (!contByPub.has(pub.flow_id)) contByPub.set(pub.flow_id, new Set());
    contByPub.get(pub.flow_id)!.add(con.flow_id);
    if (!fromByCon.has(con.flow_id)) fromByCon.set(con.flow_id, new Set());
    fromByCon.get(con.flow_id)!.add(pub.flow_id);
  }
  if (contByPub.size === 0) return flows;

  for (const f of flows) {
    const cont = contByPub.get(f.flow_id);
    if (cont && cont.size) f.continuations = [...cont].sort();
    const from = fromByCon.get(f.flow_id);
    if (from && from.size) {
      f.continued_from = [...from].sort();
      f.is_subflow = true;
    }
  }
  return flows;
}

function buildTerminalFlows(
  cas: CASOutput,
  opts: ComputeFlowConceptsOptions,
  onlyExitIds?: Set<string>,
  onlyChainIds?: Set<string>
): FlowConcept[] {
  let chains = (cas.call_chains || []).filter(c => c.chain_type === 'entry-to-exit' && c.exit_point);
  if (onlyExitIds && onlyExitIds.size > 0) {
    chains = chains.filter(c => c.exit_point?.exit_point_id && onlyExitIds.has(c.exit_point.exit_point_id));
  }
  if (onlyChainIds && onlyChainIds.size > 0) {
    chains = chains.filter(c => onlyChainIds.has(c.id));
  }
  if (chains.length === 0) return [];

  const nodesById = new Map(cas.nodes.map(n => [n.id, n]));
  const capabilities = [...(cas.capabilities || []), ...(cas.behavior_surfaces || [])];
  const entryHandlerNodeIdByEpId = buildEntryHandlerNodeIdByEpId(cas);
  const exitPointsByNode = buildExitPointIndex(cas);
  const lineageByNode = buildLineageIndex(cas);
  const conditionalOut = buildConditionalOutIndex(cas);
  const deleterNodeIds = buildDeleterNodeIds(cas);
  const mappingEvidence = buildStepMappingEvidence(cas);
  const sharedHelpers = sharedHelperNodeIds(cas);
  const exitById = new Map((cas.exit_points || []).map(e => [e.id, e]));
  const entryById = new Map((cas.entry_points || []).map(e => [e.id, e]));
  const cronScheduleIndex = buildCronScheduleIndex(cas.nodes || []);

  const entryPointsByNode = new Map<string, CASEntryPoint[]>();
  for (const ep of cas.entry_points || []) {
    const nodeId = ep.handler?.node_id || ep.source_node;
    if (!entryPointsByNode.has(nodeId)) entryPointsByNode.set(nodeId, []);
    entryPointsByNode.get(nodeId)!.push(ep);
  }

  const allLineage = [...(cas.data_lineage || [])];

  const traversal = buildTraversalIndex(cas);
  const familyEntities = makeEntryFamilyEntities(cas, traversal);
  const cliOneHopEntities = makeCliOneHopEntities(cas);

  const entryClassRank = (chain: CASCallChain): number => {
    const ep = chain.entry_point.entry_point_id ? entryById.get(chain.entry_point.entry_point_id) : undefined;
    return ep?.type === 'test' ? 1 : 0;
  };
  const sorted = [...chains].sort((a, b) =>
    (entryClassRank(a) - entryClassRank(b)) || a.id.localeCompare(b.id)
  );

  const eventEntryPoints: CASEntryPoint[] = [];
  const seenEventEpIds = new Set<string>();
  for (const c of sorted) {
    const epId = c.entry_point.entry_point_id;
    if (!epId || seenEventEpIds.has(epId)) continue;
    const ep = entryById.get(epId);
    if (!ep || ep.type !== 'event') continue;
    seenEventEpIds.add(epId);
    eventEntryPoints.push(ep);
  }
  const eventEntryOriginalIndex = new Map(eventEntryPoints.map((ep, i) => [ep.id, i]));
  const { triggersByPrimaryId: terminalTriggersByPrimaryId, groupedAwayIds: terminalGroupedAwayEpIds } =
    groupEventVariantEntryPoints(eventEntryPoints, eventEntryOriginalIndex);

  const flows: FlowConcept[] = [];

  for (const chain of sorted) {
    if (
      chain.entry_point.entry_point_id &&
      terminalGroupedAwayEpIds.has(chain.entry_point.entry_point_id)
    ) {
      continue;
    }
    const chainNodes: ChainNode[] = [];
    const seen = new Set<string>();
    for (const step of chain.call_path || []) {
      if (seen.has(step.node_id)) continue;
      const node = nodesById.get(step.node_id);
      if (!node) continue;
      seen.add(step.node_id);
      chainNodes.push({ node, depth: step.depth });
    }
    if (chainNodes.length === 0) continue;

    const rootEp = chain.entry_point.entry_point_id
      ? entryById.get(chain.entry_point.entry_point_id)
      : undefined;
    const rootNode = nodesById.get(chain.entry_point.node_id);

    const exit = chain.exit_point?.exit_point_id ? exitById.get(chain.exit_point.exit_point_id) : undefined;
    const terminusNodeId = chain.exit_point?.node_id
      || exit?.source_node
      || chainNodes[chainNodes.length - 1].node.id;

    if (opts.target) {
      const t = opts.target.toLowerCase();
      const hay = [
        chain.id,
        chain.entry_point.method_name,
        chain.exit_point?.method_name,
        rootEp?.name,
        rootEp?.trigger?.path,
        exit?.target?.service_id,
        exit?.target?.resource,
      ].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(t)) continue;
    }

    const segments = segmentIntoStepsByRole(
      chainNodes, exitPointsByNode, lineageByNode, entryPointsByNode,
      terminusNodeId, exit?.type, sharedHelpers
    );

    const gaps: string[] = [];
    if ((chain.call_path || []).length > chainNodes.length + 1) {
      gaps.push('Some call_path nodes did not resolve in the graph and were skipped from this flow.');
    }
    if (segments.length === 1) {
      gaps.push('Entire terminal chain classified as a single step — no role boundary detected between entry and terminus.');
    }

    let anyStepGrounded = false;
    const steps: FlowStep[] = segments.map((seg, i) => {
      const { name, description, grounded } = nameStepForRole(seg.role, seg.nodes, exitPointsByNode, allLineage);
      if (grounded) anyStepGrounded = true;
      if (!grounded) {
        gaps.push(`Step "${name}" carries no validate/persist/dispatch/call/respond/entity/verb evidence — honest fallback grouping used, not a fabricated role.`);
      }
      const contract = mergeNodeContracts(seg.nodes);

      let functions: FlowStep['functions'];
      if (seg.nodes.length === 1) {
        const sections = detectSubSections(seg.nodes[0]);
        functions = sections
          ? sections.map(s => ({ function_id: seg.nodes[0].id, section: s }))
          : [{ function_id: seg.nodes[0].id }];
      } else {
        functions = seg.nodes.map(n => ({ function_id: n.id }));
      }

      const stepNodeIds = new Set(seg.nodes.map(n => n.id));
      const stepId = `flow::${chain.id}::step${i}`;
      const { mappings: codeMappings, truncated: mappingsTruncated } = deriveStepCodeMappings({
        stepId,
        segNodes: seg.nodes,
        isFirstStep: i === 0,
        isTerminalStep: i === segments.length - 1,
        rootNodeId: chain.entry_point.node_id,
        rootEpRef: rootEp?.id || chain.entry_point.entry_point_id,
        terminus: exit ? { node_id: terminusNodeId, exit_point_id: exit.id, kind: exit.type } : undefined,
        prevNodes: segments[i - 1]?.nodes,
        nextNodes: segments[i + 1]?.nodes,
        exitPointsByNode,
        lineageByNode,
        entryPointsByNode,
        conditionalOut,
        ...mappingEvidence,
      });
      const step: FlowStep = {
        step_id: stepId,
        order: i,
        name,
        description,
        description_source: 'deterministic-label',
        contract,
        functions,
        entities: entitiesForNodes(stepNodeIds, cas),
        ...(codeMappings.length > 0 ? { code_mappings: codeMappings } : {}),
        ...(mappingsTruncated > 0 ? { code_mappings_truncated: mappingsTruncated } : {}),
      };
      if (opts.nameStep && rootEp) {
        const override = opts.nameStep(step, { flowEntryPoint: rootEp });
        if (override?.name) step.name = override.name;
        if (override?.description) step.description = override.description;
        if (override?.name || override?.description) step.description_source = 'ai';
      }
      return step;
    });

    const stepGraph = buildStepGraph(steps, segments.map(s => s.nodes), conditionalOut, deleterNodeIds);

    const allNodeIds = new Set(chainNodes.map(c => c.node.id));

    const contract = aggregateFlowContract(steps);
    let terminus: FlowConcept['terminus'];
    if (exit) {
      const resolvedTarget = exit.target?.service_id || exit.target?.resource || exit.target?.endpoint;
      const hasResolvedDestination = Boolean(resolvedTarget);
      const produces = resolvedTarget
        || (exit.type === 'sdk' && !hasResolvedDestination ? exit.type : exit.name)
        || exit.type;
      const found = chainNodes.findIndex(entry => entry.node.id === terminusNodeId);
      const reach = found >= 0 ? found : chainNodes.length - 1;
      terminus = { exit_point_id: exit.id, kind: exit.type, produces, node_id: terminusNodeId, hops: reach,
        via_shared_helper: chainNodes.slice(1, reach).some(entry => sharedHelpers.has(entry.node.id)) };
      const terminusStep = [...steps].reverse().find(s => s.functions.some(f => f.function_id === terminusNodeId)) || steps[steps.length - 1];
      const terminusEvidence = `terminal chain ${chain.id} resolves exit point ${exit.id} (${exit.type} → ${produces})`;
      const stampTerminus = (facet: ProvenanceFacet, value: string) => {
        const existing = contract.facet_provenance?.find(p => p.facet === facet && p.value === value);
        if (existing) return;
        const entry: FacetProvenance = {
          facet, value, contributed_by_step_ids: [terminusStep.step_id],
          contributed_by_node_ids: terminusStep.functions.map(reference => reference.function_id).sort(),
          source: 'deterministic', evidence: terminusEvidence,
        };
        contract.facet_provenance = sortFacetProvenance([...(contract.facet_provenance || []), entry]);
      };
      const label = `${exit.type}:${produces}`;
      if (exit.type === 'database' || exit.type === 'cache' || exit.type === 'file') {
        if (!contract.side_effects.state_changes.includes(label)) {
          contract.side_effects.state_changes.push(label);
          stampTerminus('state_change', label);
        }
      } else {
        if ((exit.type !== 'sdk' || hasResolvedDestination) && !contract.side_effects.external_integrations.includes(label)) {
          contract.side_effects.external_integrations.push(label);
          stampTerminus('external_integration', label);
        }
        if (['api', 'webhook', 'event', 'navigation'].includes(exit.type)) {
          const out = exit.data?.output_type || `${exit.type} ${produces}`;
          if (!contract.output.includes(out)) {
            contract.output.push(out);
            stampTerminus('output', out);
          }
        }
      }
    }

    const directFlowEntities = unionEntities(entitiesForNodes(allNodeIds, cas), familyEntities(chain.entry_point.node_id));
    const flowEntities = directFlowEntities.length > 0
      ? unionEntities(directFlowEntities, rootEp?.type === 'cli' ? cliOneHopEntities(allNodeIds) : [])
      : cliOneHopEntities(allNodeIds);

    if (rootEp && flowEntities.length === 0 && !anyStepGrounded && isAssetOrProxyPlumbingRoute(rootEp)) {
      continue;
    }

    const capabilityRelationships = deriveCapabilityRelationships({
      capabilities,
      entryPointId: rootEp?.id || chain.entry_point.entry_point_id,
      rootNodeId: rootEp ? (rootEp.handler?.node_id || rootEp.source_node) : chain.entry_point.node_id,
      entities: flowEntities,
      telemetry: telemetryExitDominance(allNodeIds, exitPointsByNode, terminus?.kind),
      pathNodeIds: allNodeIds,
      entryHandlerNodeIdByEpId,
      cronSchedule: deriveCliCronSchedule(rootEp, cronScheduleIndex),
      entryType: rootEp?.type,
      apiRouteCalls: apiRouteCallsForNodes(allNodeIds, exitPointsByNode),
    });
    const capabilityId = capabilityRelationships.find(r => r.role === 'primary')?.capability_id;
    if (capabilityRelationships.length === 0) {
      gaps.push('No capabilities entry references this flow\'s entry point or shares its touched entities — capability_relationships omitted rather than guessed.');
    } else if (!capabilityId) {
      gaps.push('No capabilities operation references this flow\'s entry point — capability_id (primary) omitted rather than guessed; only non-primary relationships derived.');
    }

    const flowName = rootEp
      ? flowNameForEntryPoint(rootEp)
      : cleanRawFallbackName(chain.entry_point.method_name);
    const produced = terminus ? ` → ${terminus.kind} ${terminus.produces}` : '';
    const intent = rootEp
      ? `${flowIntentForEntryPoint(rootEp)}${produced}`
      : `Chain from ${chain.entry_point.method_name}${produced}`;

    flows.push({
      flow_id: `flow::${chain.id}`,
      name: flowName,
      intent,
      entry_point: chain.entry_point.entry_point_id || chain.entry_point.node_id,
      capability_id: capabilityId,
      capability_relationships: capabilityRelationships.length ? capabilityRelationships : undefined,
      entities: flowEntities,
      contract,
      steps,
      terminus,
      step_graph: stepGraph,
      triggers: rootEp ? terminalTriggersByPrimaryId.get(rootEp.id) : undefined,
      gaps: gaps.length ? gaps : undefined,
    });
    void rootNode;

    if (opts.maxFlows && opts.maxFlows > 0 && flows.length >= opts.maxFlows) break;
  }

  return mergeFlowsByEntryPoint(flows);
}

const FLOW_RANK_WEIGHTS = {
  product: 1000,
  stepDepth: 12,
  capability: 120,
  terminus: 80,
  criticality: 40,
  importance: 100,
} as const;

const FLOW_RANK_STEP_CAP = 20;

const FLOW_RANK_CRITICALITY: Record<string, number> = { critical: 3, high: 2, medium: 1, low: 0 };

function scoreMaterializedFlow(
  flow: FlowConcept,
  isTestRooted: boolean,
  rootImportance: number
): number {
  const steps = Math.min(flow.steps.length, FLOW_RANK_STEP_CAP);
  const capabilityLinked = Boolean(flow.capability_id) || Boolean(flow.capability_relationships?.length);
  return (
    (isTestRooted ? 0 : FLOW_RANK_WEIGHTS.product) +
    steps * FLOW_RANK_WEIGHTS.stepDepth +
    (capabilityLinked ? FLOW_RANK_WEIGHTS.capability : 0) +
    (flow.terminus ? FLOW_RANK_WEIGHTS.terminus : 0) +
    (FLOW_RANK_CRITICALITY[flow.criticality || ''] ?? 0) * FLOW_RANK_WEIGHTS.criticality +
    rootImportance * FLOW_RANK_WEIGHTS.importance
  );
}

export function rankMaterializedFlows(cas: CASOutput): FlowConcept[] {
  const flows = cas.flows || [];
  if (flows.length === 0) return [];

  const entryById = new Map((cas.entry_points || []).map(ep => [ep.id, ep]));
  const importanceByNode = new Map<string, number>();
  for (const node of cas.nodes || []) {
    if (typeof node.structural_importance === 'number') importanceByNode.set(node.id, node.structural_importance);
  }

  const rootImportanceFor = (flow: FlowConcept): number => {
    const ep = entryById.get(flow.entry_point);
    const candidates = ep ? [ep.handler?.node_id, ep.source_node] : [flow.entry_point];
    let best = 0;
    for (const candidate of candidates) {
      if (!candidate) continue;
      const score = importanceByNode.get(candidate);
      if (typeof score === 'number' && score > best) best = score;
    }
    return best;
  };

  const scored = flows.map(flow => ({
    flow,
    score: scoreMaterializedFlow(flow, entryById.get(flow.entry_point)?.type === 'test', rootImportanceFor(flow)),
  }));
  scored.sort((a, b) => (b.score - a.score) || a.flow.flow_id.localeCompare(b.flow.flow_id));
  return scored.map(entry => entry.flow);
}

export function computeFlowConcepts(cas: CASOutput, opts: ComputeFlowConceptsOptions = {}): FlowConcept[] {
  if (cas.flows) {
    const target = String(opts.target || '').trim().toLowerCase();
    const matching = target
      ? cas.flows.filter(flowTargetMatcher(cas, target))
      : rankMaterializedFlows(cas);
    const offset = Math.max(0, opts.offset || 0);
    const end = opts.maxFlows && opts.maxFlows > 0 ? offset + opts.maxFlows : undefined;
    return matching.slice(offset, end);
  }
  materializeNodeUnderstandingContracts(cas);
  const terminalFlows = buildTerminalFlows(cas, opts);


  let flows: FlowConcept[];
  if (terminalFlows.length === 0) {
    flows = computeEntryPointFlows(cas, opts);
  } else if (opts.maxFlows && opts.maxFlows > 0 && terminalFlows.length >= opts.maxFlows) {
    flows = terminalFlows;
  } else {
    const coveredEntryKeys = new Set<string>();
    const entryById = new Map((cas.entry_points || []).map(e => [e.id, e]));
    for (const flow of terminalFlows) {
      coveredEntryKeys.add(flow.entry_point);
      const ep = entryById.get(flow.entry_point);
      if (ep) coveredEntryKeys.add(ep.handler?.node_id || ep.source_node);
    }

    const remaining = opts.maxFlows && opts.maxFlows > 0 ? opts.maxFlows - terminalFlows.length : undefined;
    const entryFlows = computeEntryPointFlows(
      cas,
      { ...opts, maxFlows: remaining },
      { excludeEntryKeys: coveredEntryKeys, significantOnly: true }
    );
    flows = [...terminalFlows, ...entryFlows];
  }

  return finalizeFlows(cas, flows, opts);
}

function finalizeFlows(cas: CASOutput, input: FlowConcept[], opts: ComputeFlowConceptsOptions): FlowConcept[] {
  let flows = input;
  const pairs = pairPublishConsumeSeams(cas);
  if (pairs.length > 0) {
    const byExit = new Set(flows.map(f => f.terminus?.exit_point_id).filter(Boolean) as string[]);
    const byEntry = new Set(flows.map(f => f.entry_point));
    const missingConsumerEntryIds = new Set<string>();
    const missingPublisherExitIds = new Set<string>();
    for (const { exitId, entryId } of pairs) {
      if (byExit.has(exitId) && !byEntry.has(entryId)) missingConsumerEntryIds.add(entryId);
      if (byEntry.has(entryId) && !byExit.has(exitId)) missingPublisherExitIds.add(exitId);
    }
    const partnerOpts: ComputeFlowConceptsOptions = { ...opts, maxFlows: undefined };
    if (missingConsumerEntryIds.size > 0) {
      flows = [...flows, ...computeEntryPointFlows(cas, partnerOpts, { onlyEntryKeys: missingConsumerEntryIds })];
    }
    if (missingPublisherExitIds.size > 0) {
      const partnerPublishers = buildTerminalFlows(cas, partnerOpts, missingPublisherExitIds)
        .filter(p => !flows.some(f => f.flow_id === p.flow_id));
      flows = [...flows, ...partnerPublishers];
    }
  }
  const finalized = disambiguateFlowNames(
    cas,
    groundCapabilityFlowRelationships(stitchContinuations(flows, cas), cas).map(collapseDuplicateFunctionSteps)
  );
  return finalized;
}

function dedupeStepEdges<T extends { from_step_id: string; to_step_id: string; kind: string }>(edges: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const e of edges) {
    const key = `${e.from_step_id}->${e.to_step_id}:${e.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

function collapseDuplicateFunctionSteps(flow: FlowConcept): FlowConcept {
  if (flow.steps.length < 2) return flow;
  const keyOf = (s: FlowStep) => s.functions.map(f => f.function_id).sort().join('|');
  const isSectioned = (s: FlowStep) => s.functions.some(f => f.section !== undefined);

  const kept: FlowStep[] = [];
  const absorbedInto = new Map<string, string>();
  let collapsed = 0;
  for (const step of flow.steps) {
    const prev = kept[kept.length - 1];
    if (prev && keyOf(prev) === keyOf(step) && !isSectioned(prev) && !isSectioned(step)) {
      collapsed++;
      absorbedInto.set(step.step_id, prev.step_id);
      if (!prev.name.includes(step.name)) prev.name = `${prev.name} & ${step.name}`;
      prev.description = `${prev.description} Also: ${step.description}`;
      if (step.code_mappings?.length) {
        prev.code_mappings = [...(prev.code_mappings || []), ...step.code_mappings.map(m => ({ ...m, step_id: prev.step_id }))];
      }
      continue;
    }
    kept.push(step);
  }
  if (collapsed === 0) return flow;

  const survivingIds = new Set(kept.map(s => s.step_id));
  kept.forEach((s, i) => { s.order = i; });

  const contract = flow.contract && flow.contract.facet_provenance
    ? {
        ...flow.contract,
        facet_provenance: flow.contract.facet_provenance.map(entry => ({
          ...entry,
          contributed_by_step_ids: entry.contributed_by_step_ids
            ? [...new Set(entry.contributed_by_step_ids.map(id => absorbedInto.get(id) ?? id))].sort()
            : entry.contributed_by_step_ids,
        })),
      }
    : flow.contract;

  return {
    ...flow,
    steps: kept,
    ...(contract ? { contract } : {}),
    ...(flow.step_graph
      ? {
          step_graph: {
            ...flow.step_graph,
            edges: dedupeStepEdges(
              (flow.step_graph.edges || [])
                .map(e => ({
                  ...e,
                  from_step_id: absorbedInto.get(e.from_step_id) ?? e.from_step_id,
                  to_step_id: absorbedInto.get(e.to_step_id) ?? e.to_step_id,
                }))
                .filter(e => e.from_step_id !== e.to_step_id
                  && survivingIds.has(e.from_step_id) && survivingIds.has(e.to_step_id))
            ),
          },
        }
      : {}),
    gaps: [
      ...(flow.gaps || []),
      `${collapsed} step(s) collapsed: adjacent steps resolved to the identical function id set with no distinguishing sub-section.`,
    ],
  };
}

function disambiguateFlowNames(cas: CASOutput, flows: FlowConcept[]): FlowConcept[] {
  if (flows.length < 2) return flows;
  const nodesById = new Map((cas.nodes || []).map(n => [n.id, n]));
  const entryById = new Map((cas.entry_points || []).map(e => [e.id, e]));

  const entryFileOf = (flow: FlowConcept): string | undefined => {
    const ep = entryById.get(flow.entry_point);
    const nodeId = ep?.handler?.node_id || ep?.source_node || flow.entry_point;
    const node = nodesById.get(nodeId);
    const file = node ? sourceFileOf(node) : undefined;
    return file || ((ep as any)?.location?.file as string | undefined) || undefined;
  };

  const qualifiers: Array<(f: FlowConcept) => string | undefined> = [
    f => { const file = entryFileOf(f); if (!file) return undefined; const parts = file.split('/'); return parts.length >= 2 ? parts.slice(0, 2).join('/') : parts[0]; },
    f => { const file = entryFileOf(f); return file ? file.split('/').pop()?.replace(/\.[^.]+$/, '') : undefined; },
    f => f.terminus?.produces || f.terminus?.kind,
  ];

  const groups = new Map<string, FlowConcept[]>();
  for (const f of flows) {
    const g = groups.get(f.name);
    if (g) g.push(f); else groups.set(f.name, [f]);
  }

  for (const [name, group] of groups) {
    if (group.length < 2) continue;
    for (const qualify of qualifiers) {
      const values = group.map(qualify);
      if (values.some(v => !v)) continue;
      if (new Set(values).size < 2) continue;
      group.forEach((f, i) => { f.name = dedupeAdjacentWords(`${name} (${discriminatorLabel(values[i])})`); });
      break;
    }
  }
  return flows;
}

function computeEntryPointFlows(
  cas: CASOutput,
  opts: ComputeFlowConceptsOptions = {},
  unionOpts: { excludeEntryKeys?: Set<string>; significantOnly?: boolean; onlyEntryKeys?: Set<string> } = {}
): FlowConcept[] {
  const nodesById = new Map(cas.nodes.map(n => [n.id, n]));
  const capabilities = [...(cas.capabilities || []), ...(cas.behavior_surfaces || [])];
  const entryHandlerNodeIdByEpId = buildEntryHandlerNodeIdByEpId(cas);
  const cronScheduleIndex = buildCronScheduleIndex(cas.nodes || []);

  const realEntryPoints = cas.entry_points || [];
  const realRootNodeIds = new Set(realEntryPoints.map(ep => ep.handler?.node_id || ep.source_node));
  const synthesizedRoots = deriveCapabilityOperationRoots(cas, capabilities, nodesById, realRootNodeIds);
  const synthesizedRootIds = new Set(synthesizedRoots.map(r => r.ep.id));

  let entryPoints: CASEntryPoint[] = [...realEntryPoints, ...synthesizedRoots.map(r => r.ep)];
  if (unionOpts.onlyEntryKeys && unionOpts.onlyEntryKeys.size > 0) {
    const only = unionOpts.onlyEntryKeys;
    entryPoints = entryPoints.filter(ep => only.has(ep.id) || only.has(ep.handler?.node_id || ep.source_node));
  }
  if (unionOpts.excludeEntryKeys && unionOpts.excludeEntryKeys.size > 0) {
    const covered = unionOpts.excludeEntryKeys;
    entryPoints = entryPoints.filter(ep =>
      !covered.has(ep.id) && !covered.has(ep.handler?.node_id || ep.source_node)
    );
  }
  if (unionOpts.significantOnly) {
    entryPoints = entryPoints.filter(ep => ep.type !== 'test');
  }
  if (opts.target) {
    const t = opts.target.toLowerCase();
    entryPoints = entryPoints.filter(ep =>
      ep.id.toLowerCase() === t ||
      ep.name.toLowerCase().includes(t) ||
      (ep.trigger?.path || '').toLowerCase().includes(t) ||
      ep.source_node.toLowerCase() === t
    );
  }
  const maxEntryFlows = opts.maxFlows && opts.maxFlows > 0 ? opts.maxFlows : undefined;

  const entryClassRank = (ep: CASEntryPoint): number =>
    ep.type === 'test' ? 2 : synthesizedRootIds.has(ep.id) ? 1 : 0;
  const entryOriginalIndex = new Map(entryPoints.map((ep, i) => [ep.id, i]));
  entryPoints = [...entryPoints].sort((a, b) =>
    (entryClassRank(a) - entryClassRank(b)) ||
    (entryOriginalIndex.get(a.id)! - entryOriginalIndex.get(b.id)!)
  );

  const { primaryByRoot, triggersByPrimaryId, groupedAwayIds } =
    groupEventVariantEntryPoints(entryPoints, entryOriginalIndex);
  void primaryByRoot;

  const exitPointsByNode = buildExitPointIndex(cas);
  const lineageByNode = buildLineageIndex(cas);
  const conditionalOut = buildConditionalOutIndex(cas);
  const deleterNodeIds = buildDeleterNodeIds(cas);
  const mappingEvidence = buildStepMappingEvidence(cas);
  const sharedHelpers = sharedHelperNodeIds(cas);
  const cliOneHopEntities = makeCliOneHopEntities(cas);

  const entryPointsByNode = new Map<string, CASEntryPoint[]>();
  for (const ep of cas.entry_points || []) {
    const nodeId = ep.handler?.node_id || ep.source_node;
    if (!entryPointsByNode.has(nodeId)) entryPointsByNode.set(nodeId, []);
    entryPointsByNode.get(nodeId)!.push(ep);
  }

  const allLineage = [...(cas.data_lineage || [])];

  void buildTerminalSignal;

  const traversal = buildTraversalIndex(cas);

  const flows: FlowConcept[] = [];

  for (const ep of entryPoints) {
    if (maxEntryFlows !== undefined && flows.length >= maxEntryFlows) break;
    if (groupedAwayIds.has(ep.id)) continue;
    const rootNode = nodesById.get(ep.handler?.node_id || ep.source_node);
    if (!rootNode) continue;

    const handlerResolved = TRACEABLE_NODE_TYPES.has(rootNode.type);
    const chain = handlerResolved
      ? traceForwardChain(traversal, rootNode.id)
      : [{ node: rootNode, depth: 0 }];
    if (chain.length === 0) continue;

    if (unionOpts.significantOnly && chain.length === 1 && !USER_FACING_ENTRY_TYPES.has(ep.type)) {
      const rootId = rootNode.id;
      const hasExit = (exitPointsByNode.get(rootId) || []).length > 0;
      const hasLineage = Boolean(lineageByNode.get(rootId));
      const hasEntity = entitiesForNodes(new Set([rootId]), cas).length > 0;
      const hasSurface = Boolean(
        ep.security?.authenticated ||
        (ep.security?.guards || []).length > 0 ||
        (ep.input?.validation || []).length > 0
      );
      if (!hasExit && !hasLineage && !hasEntity && !hasSurface) continue;
    }

    const segments = segmentIntoStepsByRole(
      chain, exitPointsByNode, lineageByNode, entryPointsByNode, undefined, undefined, sharedHelpers
    );

    const gaps: string[] = [];
    if (!handlerResolved) {
      gaps.push(`Entry point handler is unresolved: ${rootNode.type} node ${rootNode.id} is evidence for registration location, not an executable handler. Flow expansion stopped at this boundary.`);
    }
    if (synthesizedRootIds.has(ep.id)) {
      gaps.push('Root synthesized from a capabilities operation node reference — this codebase\'s entry-point extraction did not surface a dedicated entry point for this handler.');
    }
    if (segments.length === 1) {
      gaps.push('Entire chain classified as a single step — no role boundary detected; segmentation is coarse for this flow.');
    }

    let anyStepGrounded = false;
    const steps: FlowStep[] = segments.map((seg, i) => {
      const { name, description, grounded } = nameStepForRole(seg.role, seg.nodes, exitPointsByNode, allLineage);
      if (grounded) anyStepGrounded = true;
      if (!grounded) {
        gaps.push(`Step "${name}" carries no validate/persist/dispatch/call/respond/entity/verb evidence — honest fallback grouping used, not a fabricated role.`);
      }
      const contract = mergeNodeContracts(seg.nodes);

      let functions: FlowStep['functions'];
      if (seg.nodes.length === 1) {
        const sections = detectSubSections(seg.nodes[0]);
        functions = sections
          ? sections.map(s => ({ function_id: seg.nodes[0].id, section: s }))
          : [{ function_id: seg.nodes[0].id }];
      } else {
        functions = seg.nodes.map(n => ({ function_id: n.id }));
      }

      const stepNodeIds = new Set(seg.nodes.map(n => n.id));
      const stepId = `${ep.id}::step${i}`;
      const { mappings: codeMappings, truncated: mappingsTruncated } = deriveStepCodeMappings({
        stepId,
        segNodes: seg.nodes,
        isFirstStep: i === 0,
        isTerminalStep: i === segments.length - 1,
        rootNodeId: ep.handler?.node_id || ep.source_node,
        rootEpRef: ep.id,
        prevNodes: segments[i - 1]?.nodes,
        nextNodes: segments[i + 1]?.nodes,
        exitPointsByNode,
        lineageByNode,
        entryPointsByNode,
        conditionalOut,
        ...mappingEvidence,
      });
      const step: FlowStep = {
        step_id: stepId,
        order: i,
        name,
        description,
        description_source: 'deterministic-label',
        contract,
        functions,
        entities: entitiesForNodes(stepNodeIds, cas),
        ...(codeMappings.length > 0 ? { code_mappings: codeMappings } : {}),
        ...(mappingsTruncated > 0 ? { code_mappings_truncated: mappingsTruncated } : {}),
      };
      if (opts.nameStep) {
        const override = opts.nameStep(step, { flowEntryPoint: ep });
        if (override?.name) step.name = override.name;
        if (override?.description) step.description = override.description;
        if (override?.name || override?.description) step.description_source = 'ai';
      }
      return step;
    });

    const stepGraph = buildStepGraph(steps, segments.map(s => s.nodes), conditionalOut, deleterNodeIds);

    const allNodeIds = new Set(chain.map(c => c.node.id));
    const directEntryFlowEntities = entitiesForNodes(allNodeIds, cas);
    const flowEntities = directEntryFlowEntities.length > 0
      ? unionEntities(directEntryFlowEntities, ep.type === 'cli' ? cliOneHopEntities(allNodeIds) : [])
      : cliOneHopEntities(allNodeIds);

    if (flowEntities.length === 0 && !anyStepGrounded && isAssetOrProxyPlumbingRoute(ep)) {
      continue;
    }

    const capabilityRelationships = deriveCapabilityRelationships({
      capabilities,
      entryPointId: ep.id,
      rootNodeId: ep.handler?.node_id || ep.source_node,
      entities: flowEntities,
      telemetry: telemetryExitDominance(allNodeIds, exitPointsByNode),
      pathNodeIds: allNodeIds,
      entryHandlerNodeIdByEpId,
      cronSchedule: deriveCliCronSchedule(ep, cronScheduleIndex),
      entryType: ep.type,
      apiRouteCalls: apiRouteCallsForNodes(allNodeIds, exitPointsByNode),
    });
    const capabilityId = capabilityRelationships.find(r => r.role === 'primary')?.capability_id;
    if (capabilityRelationships.length === 0) {
      gaps.push('No capabilities entry references this entry point or shares its touched entities — capability_relationships omitted rather than guessed.');
    } else if (!capabilityId) {
      gaps.push('No capabilities operation references this entry point — capability_id (primary) omitted rather than guessed; only non-primary relationships derived.');
    }

    flows.push({
      flow_id: `flow::${ep.id}`,
      name: flowNameForEntryPoint(ep, handlerResolved),
      intent: flowIntentForEntryPoint(ep),
      entry_point: ep.id,
      capability_id: capabilityId,
      capability_relationships: capabilityRelationships.length ? capabilityRelationships : undefined,
      entities: flowEntities,
      contract: aggregateFlowContract(steps),
      steps,
      step_graph: stepGraph,
      triggers: triggersByPrimaryId.get(ep.id),
      gaps: gaps.length ? gaps : undefined,
    });
  }

  return flows;
}

export interface RuntimeMetricLike {
  static_id: string;
  node_id?: string;
  entry_point_id?: string;
  route?: string;
  method?: string;
  request_count: number;
  error_rate: number;
  latency?: { p50_ms?: number | null; p95_ms?: number | null; p99_ms?: number | null };
  status_code_distribution?: Record<string, number>;
  source?: string;
  last_seen?: string;
}

function indexRuntimeMetrics(metrics: RuntimeMetricLike[]): Map<string, RuntimeMetricLike> {
  const index = new Map<string, RuntimeMetricLike>();
  for (const m of metrics) {
    const keys = [
      m.static_id,
      m.node_id,
      m.entry_point_id,
      m.route,
      m.method && m.route ? `${m.method.toUpperCase()} ${m.route}` : undefined,
    ].filter((k): k is string => Boolean(k));
    for (const k of keys) if (!index.has(k)) index.set(k, m);
  }
  return index;
}

function toContractTelemetry(m: RuntimeMetricLike): ContractTelemetry {
  const t: ContractTelemetry = {
    static_id: m.static_id,
    request_count: m.request_count,
    error_rate: m.error_rate,
    source: m.source || 'ingested',
  };
  if (m.latency?.p50_ms != null) t.p50_ms = m.latency.p50_ms;
  if (m.latency?.p95_ms != null) t.p95_ms = m.latency.p95_ms;
  if (m.latency?.p99_ms != null) t.p99_ms = m.latency.p99_ms;
  if (m.status_code_distribution && Object.keys(m.status_code_distribution).length > 0) {
    t.status_code_distribution = m.status_code_distribution;
  }
  if (m.last_seen) t.last_seen = m.last_seen;
  return t;
}

function telemetryForUnit(
  index: Map<string, RuntimeMetricLike>,
  nodeIds: Iterable<string>,
  extraKeys: Array<string | undefined> = []
): ContractTelemetry | undefined {
  for (const key of extraKeys) {
    if (key && index.has(key)) return toContractTelemetry(index.get(key)!);
  }
  for (const id of nodeIds) {
    if (index.has(id)) return toContractTelemetry(index.get(id)!);
  }
  return undefined;
}

export function attachTelemetryToFlows(flows: FlowConcept[], metrics: RuntimeMetricLike[]): FlowConcept[] {
  if (!metrics || metrics.length === 0) return flows;
  const index = indexRuntimeMetrics(metrics);
  if (index.size === 0) return flows;

  return flows.map(flow => {
    const flowNodeIds = new Set<string>();
    const telemetryStepIds: string[] = [];
    const steps = flow.steps.map(step => {
      const stepNodeIds = step.functions.map(f => f.function_id);
      for (const id of stepNodeIds) flowNodeIds.add(id);
      const stepTel = telemetryForUnit(index, stepNodeIds);
      if (stepTel) {
        telemetryStepIds.push(step.step_id);
        return { ...step, contract: overlayRuntimeTelemetry(step.contract, stepTel, stepNodeIds) };
      }
      return step;
    });
    const flowTel = telemetryForUnit(index, flowNodeIds, [flow.entry_point]);
    return {
      ...flow,
      steps,
      contract: flowTel
        ? overlayRuntimeTelemetry(flow.contract, flowTel, flowNodeIds, telemetryStepIds)
        : flow.contract,
    };
  });
}

export function overlayRuntimeTelemetry(
  contract: ICELOTContract,
  telemetry: ContractTelemetry,
  nodeIds: Iterable<string>,
  stepIds: Iterable<string> = [],
): ICELOTContract {
  const abstentions = { ...(contract.facet_abstentions || {}) };
  delete abstentions.telemetry;
  const entry: FacetProvenance = {
    facet: 'telemetry',
    value: telemetry.static_id,
    contributed_by_node_ids: [...new Set(nodeIds)].sort(),
    contributed_by_step_ids: [...new Set(stepIds)].sort(),
    source: 'deterministic',
    evidence: `runtime observations (source: ${telemetry.source}) matched this unit`,
  };
  return {
    ...contract,
    telemetry,
    facet_provenance: sortFacetProvenance([
      ...(contract.facet_provenance || []).filter(provenance => provenance.facet !== 'telemetry'),
      entry,
    ]),
    facet_abstentions: Object.keys(abstentions).length > 0 ? abstentions : undefined,
  };
}

export function telemetryForNode(nodeId: string, metrics: RuntimeMetricLike[]): ContractTelemetry | undefined {
  if (!metrics || metrics.length === 0) return undefined;
  const index = indexRuntimeMetrics(metrics);
  return telemetryForUnit(index, [nodeId]);
}

export interface CapabilityTelemetry {
  capability_id: string;
  flows_total: number;
  flows_in_scope: number;
  flows_observed: number;
  coverage: 'full' | 'partial' | 'none';
  exercised?: boolean;
  dormant: boolean;
  request_count: number;
  error_rate: number;
  p95_ms?: number;
  last_seen?: string;
  source?: string;
  contributing_flow_ids: string[];
}

export function computeCapabilityTelemetry(
  capabilities: Array<{ id: string; related_flows?: Array<{ flow_id: string }> }>,
  flows: FlowConcept[],
): CapabilityTelemetry[] {
  const flowById = new Map(flows.map(f => [f.flow_id, f]));
  const results: CapabilityTelemetry[] = [];

  for (const capability of capabilities) {
    const relatedFlowIds = (capability.related_flows || []).map(r => r.flow_id);
    if (relatedFlowIds.length === 0) continue;

    const inScopeIds = relatedFlowIds.filter(id => flowById.has(id));
    const observedFlows = inScopeIds
      .map(id => flowById.get(id)!)
      .filter(f => f.contract.telemetry);

    const coverage: CapabilityTelemetry['coverage'] =
      inScopeIds.length === 0 ? 'none' : inScopeIds.length < relatedFlowIds.length ? 'partial' : 'full';

    let requestCount = 0;
    let weightedErrors = 0;
    let maxP95: number | undefined;
    let lastSeen: string | undefined;
    const sources = new Set<string>();
    for (const flow of observedFlows) {
      const t = flow.contract.telemetry!;
      requestCount += t.request_count;
      weightedErrors += t.request_count * t.error_rate;
      if (t.p95_ms != null) maxP95 = maxP95 == null ? t.p95_ms : Math.max(maxP95, t.p95_ms);
      if (t.last_seen && (!lastSeen || t.last_seen > lastSeen)) lastSeen = t.last_seen;
      sources.add(t.source);
    }

    results.push({
      capability_id: capability.id,
      flows_total: relatedFlowIds.length,
      flows_in_scope: inScopeIds.length,
      flows_observed: observedFlows.length,
      coverage,
      exercised: coverage === 'none' ? undefined : observedFlows.length > 0,
      dormant: coverage === 'full' && observedFlows.length === 0,
      request_count: requestCount,
      error_rate: requestCount > 0 ? weightedErrors / requestCount : 0,
      p95_ms: maxP95,
      last_seen: lastSeen,
      source: sources.size === 0 ? undefined : sources.size === 1 ? [...sources][0] : 'mixed',
      contributing_flow_ids: observedFlows.map(f => f.flow_id),
    });
  }

  return results;
}

export function unexercisedFlows(
  flows: FlowConcept[],
  metrics: RuntimeMetricLike[],
): Array<{ flow_id: string; name: string; entry_point: string }> {
  if (!metrics || metrics.length === 0) return [];
  return flows
    .filter(f => !f.contract.telemetry)
    .map(f => ({ flow_id: f.flow_id, name: f.name, entry_point: f.entry_point }));
}
