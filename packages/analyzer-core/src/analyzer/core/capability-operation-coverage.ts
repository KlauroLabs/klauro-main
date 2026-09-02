import { createHash } from 'node:crypto';
import type { CASEdge, CASEntryPoint, CASExitPoint, CASNode, SystemCapability } from '../../types/cas.types';
import { declarationOperationSemantics, endpointParts, endpointSignature, isTransportScaffoldingExit, semanticActions, semanticSubjects } from './capability-operation-language';
import { isStructuralExecutableCliEntry } from './entry-point-product-role';
export interface CapabilityOperationObligationScope {
  id: string;
  parentCandidateId: string;
  entryPointIds: string[];
  terminalKeysByEntryPoint: ReadonlyMap<string, ReadonlySet<string>>;
}
export interface CapabilityOperationObligationViews {
  candidates: SystemCapability[];
  scopes: ReadonlyMap<string, CapabilityOperationObligationScope>;
}
export interface CapabilityOperationCoverageContext {
  edges: readonly CASEdge[];
  entryPoints: readonly CASEntryPoint[];
  exitPoints: readonly CASExitPoint[];
  nodes: readonly CASNode[];
  obligationScopes?: ReadonlyMap<string, CapabilityOperationObligationScope>;
}
export interface CapabilityOperationEffect {
  entryPointId: string;
  kind: 'required' | 'support';
  actions: string[];
  signatures: string[];
  subjects: string[];
  terminalObligations: CapabilityTerminalObligation[];
}
interface CapabilityTerminalObligation {
  actions: string[];
  signatures: string[];
  subjects: string[];
  outcomeLabels?: string[];
}
const sortedUnique = (values: readonly string[]): string[] => [...new Set(values.filter(Boolean))].sort();
function terminalObligationKey(obligation: CapabilityTerminalObligation): string {
  return JSON.stringify({
    actions: sortedUnique(obligation.actions),
    subjects: sortedUnique(obligation.subjects),
    signatures: sortedUnique(obligation.signatures),
  });
}
const normalizedFile = (value: unknown): string => String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
function terminalEffectActions(exit: CASExitPoint): string[] {
  const targetActions = semanticActions([exit.target?.endpoint, exit.target?.resource].filter(Boolean).join(' '));
  if (targetActions.length > 0) return targetActions;
  const operationActions = semanticActions([exit.operation?.action, exit.operation?.method].filter(Boolean).join(' '));
  return operationActions.length > 0 ? operationActions : semanticActions(exit.name);
}
function capabilityTitleActionIntent(value: unknown): { actions: string[]; broadManage: boolean } {
  const normalized = String(value || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  const actions = semanticActions(normalized);
  const broadManage = /\bmanage(?:s|d|ment|ing)?\b/.test(normalized) && actions.length === 1 && actions[0] === 'update';
  return { actions: broadManage ? [] : actions, broadManage };
}
function railsResourceOperation(entryPoint: CASEntryPoint | undefined): { action: string; resource: string; role: string } | undefined {
  const metadata = entryPoint?.metadata;
  if (entryPoint?.type !== 'http' || (metadata?.route_source !== 'resources' && metadata?.route_source !== 'resource')) return undefined;
  const resource = String(metadata.route_resource || '').trim();
  const action = String(metadata.rest_action || '').trim();
  const role = String(metadata.route_role || '').trim();
  if (!resource || !action || !role) return undefined;
  return { action, resource, role };
}
function signatureMatches(left: string, right: string): boolean {
  const [leftMethod, leftPath, leftEntities] = left.split('|');
  const [rightMethod, rightPath, rightEntities] = right.split('|');
  if (leftMethod !== rightMethod || !leftPath || !rightPath) return false;
  const leftEntitySet = new Set((leftEntities || '').split(',').filter(Boolean));
  if (!(rightEntities || '').split(',').filter(Boolean).some(entity => leftEntitySet.has(entity))) return false;
  const leftSegments = leftPath.split('/');
  const rightSegments = rightPath.split('/');
  const shorter = leftSegments.length <= rightSegments.length ? leftSegments : rightSegments;
  const longer = leftSegments.length <= rightSegments.length ? rightSegments : leftSegments;
  if (shorter.length === 0 || !shorter.every((segment, index) => segment === longer[longer.length - shorter.length + index])) return false;
  if (leftSegments.length === rightSegments.length) return true;
  const rightEntitySet = new Set((rightEntities || "").split(",").filter(Boolean));
  const commonEntityTokens = [...leftEntitySet].filter(entity => rightEntitySet.has(entity)).flatMap(entity => endpointParts(entity.replace(/^entity_/, "")));
  return longer.slice(0, longer.length - shorter.length).some(segment => commonEntityTokens.includes(segment));
}
function nodeFile(node: CASNode): string {
  return normalizedFile(node.source?.file || node.metadata?.perspective_data?.['typescript-structure']?.module_path);
}

interface CapabilityExitRecord {
  exit: CASExitPoint;
  index: number;
  exactNode?: CASNode;
  file: string;
  line: number;
}

interface CapabilityOperationCoverageIndexes {
  sourceNodes: readonly CASNode[];
  sourceEdges: readonly CASEdge[];
  sourceEntryPoints: readonly CASEntryPoint[];
  sourceExitPoints: readonly CASExitPoint[];
  nodeCount: number;
  edgeCount: number;
  entryPointCount: number;
  exitPointCount: number;
  entryPointById: ReadonlyMap<string, CASEntryPoint>;
  nodesById: ReadonlyMap<string, readonly CASNode[]>;
  nodesByName: ReadonlyMap<string, readonly CASNode[]>;
  nodeOrderByIdentity: ReadonlyMap<CASNode, number>;
  outgoingNodeIds: ReadonlyMap<string, readonly string[]>;
  exitsByExactOwnerId: ReadonlyMap<string, readonly CapabilityExitRecord[]>;
  exitsByFile: ReadonlyMap<string, readonly CapabilityExitRecord[]>;
  reachableByScope: Map<string, readonly CASNode[]>;
  exitsByScope: Map<string, readonly { exit: CASExitPoint; owner: CASNode }[]>;
}

const coverageIndexesByContext = new WeakMap<object, CapabilityOperationCoverageIndexes>();

function coverageIndexes(context: CapabilityOperationCoverageContext): CapabilityOperationCoverageIndexes {
  const cached = coverageIndexesByContext.get(context as object);
  const nodes = context.nodes || [];
  const edges = context.edges || [];
  const entryPoints = context.entryPoints || [];
  const exitPoints = context.exitPoints || [];
  if (cached && cached.sourceNodes === nodes && cached.sourceEdges === edges &&
      cached.sourceEntryPoints === entryPoints && cached.sourceExitPoints === exitPoints &&
      cached.nodeCount === nodes.length && cached.edgeCount === edges.length &&
      cached.entryPointCount === entryPoints.length && cached.exitPointCount === exitPoints.length) return cached;
  const nodesById = new Map<string, CASNode[]>();
  const nodesByName = new Map<string, CASNode[]>();
  const nodeOrderByIdentity = new Map<CASNode, number>();
  for (const [index, node] of nodes.entries()) {
    nodeOrderByIdentity.set(node, index);
    const sameId = nodesById.get(node.id);
    if (sameId) sameId.push(node);
    else nodesById.set(node.id, [node]);
    const sameName = nodesByName.get(node.name);
    if (sameName) sameName.push(node);
    else nodesByName.set(node.name, [node]);
  }
  const outgoingNodeIds = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.type !== 'calls' && edge.type !== 'triggers') continue;
    const outgoing = outgoingNodeIds.get(edge.source);
    if (outgoing) outgoing.push(edge.target);
    else outgoingNodeIds.set(edge.source, [edge.target]);
  }
  const exitsByExactOwnerId = new Map<string, CapabilityExitRecord[]>();
  const exitsByFile = new Map<string, CapabilityExitRecord[]>();
  for (const [index, exit] of exitPoints.entries()) {
    const metadata = exit.metadata as Record<string, any> | undefined;
    const record = { exit, index, exactNode: nodesById.get(exit.source_node)?.[0], file: normalizedFile(metadata?.sourceFile || metadata?.file), line: Number(metadata?.line) };
    const ownerExits = exitsByExactOwnerId.get(exit.source_node);
    if (ownerExits) ownerExits.push(record);
    else exitsByExactOwnerId.set(exit.source_node, [record]);
    if (record.file) {
      const fileExits = exitsByFile.get(record.file);
      if (fileExits) fileExits.push(record);
      else exitsByFile.set(record.file, [record]);
    }
  }
  const entryPointById = new Map<string, CASEntryPoint>();
  for (const entryPoint of entryPoints) {
    if (!entryPointById.has(entryPoint.id)) entryPointById.set(entryPoint.id, entryPoint);
  }
  const indexes: CapabilityOperationCoverageIndexes = {
    sourceNodes: nodes,
    sourceEdges: edges,
    sourceEntryPoints: entryPoints,
    sourceExitPoints: exitPoints,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    entryPointCount: entryPoints.length,
    exitPointCount: exitPoints.length,
    entryPointById,
    nodesById,
    nodesByName,
    nodeOrderByIdentity,
    outgoingNodeIds,
    exitsByExactOwnerId,
    exitsByFile,
    reachableByScope: new Map(),
    exitsByScope: new Map(),
  };
  coverageIndexesByContext.set(context as object, indexes);
  return indexes;
}

function resolvedHandlerNodes(entry: CASEntryPoint, context: CapabilityOperationCoverageContext): CASNode[] {
  const indexes = coverageIndexes(context);
  if (entry.source_analyzer === 'react' || entry.metadata?.source_analyzer === 'react') {
    const bindingIds = Array.isArray(entry.metadata?.handler_binding_node_ids) ? entry.metadata.handler_binding_node_ids.map(value => String(value)) : [];
    if (bindingIds.length === 0) return [];
    const allowed = new Set(bindingIds);
    return [...allowed].flatMap(id => indexes.nodesById.get(id) || [])
      .sort((left, right) => (indexes.nodeOrderByIdentity.get(left) || 0) - (indexes.nodeOrderByIdentity.get(right) || 0));
  }
  const handlerName = String(entry.metadata?.handler_name || entry.handler?.method_name || '').trim();
  const handlerFile = normalizedFile(entry.handler?.file);
  if (!handlerName) return [];
  return (indexes.nodesByName.get(handlerName) || []).filter(node => !handlerFile || nodeFile(node) === handlerFile);
}

function reachableNodes(initial: readonly CASNode[], context: CapabilityOperationCoverageContext): CASNode[] {
  const indexes = coverageIndexes(context);
  const seen = new Set(initial.map(node => node.id));
  const scopeKey = JSON.stringify([...seen]);
  const cached = indexes.reachableByScope.get(scopeKey);
  if (cached) return [...cached];
  const queue = [...seen];
  while (queue.length > 0) {
    const source = queue.shift()!;
    for (const target of indexes.outgoingNodeIds.get(source) || []) {
      if (seen.has(target) || !indexes.nodesById.has(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  const reachable = [...seen].map(id => indexes.nodesById.get(id)?.[0]).filter((node): node is CASNode => Boolean(node));
  indexes.reachableByScope.set(scopeKey, reachable);
  return [...reachable];
}

function exitsForNodes(nodes: readonly CASNode[], context: CapabilityOperationCoverageContext): Array<{ exit: CASExitPoint; owner: CASNode }> {
  const indexes = coverageIndexes(context);
  const reachableIds = new Set(nodes.map(node => node.id));
  const scopeKey = JSON.stringify([...reachableIds]);
  const cached = indexes.exitsByScope.get(scopeKey);
  if (cached) return [...cached];
  const reachableByFile = new Map<string, CASNode[]>();
  for (const node of nodes) {
    if (node.type === 'file' || node.type === 'module') continue;
    const file = nodeFile(node);
    if (!file) continue;
    const sameFile = reachableByFile.get(file);
    if (sameFile) sameFile.push(node);
    else reachableByFile.set(file, [node]);
  }
  const callableOwner = (record: CapabilityExitRecord): CASNode | undefined => {
    const exact = record.exactNode;
    if (exact && reachableIds.has(exact.id) && exact.type !== 'file' && exact.type !== 'module') return exact;
    const { file, line } = record;
    if (!file || !Number.isFinite(line)) return undefined;
    const containing = (reachableByFile.get(file) || []).filter(node => {
      const start = Number(node.source?.line);
      const end = Number(node.source?.end_line ?? node.source?.line);
      return Number.isFinite(start) && Number.isFinite(end) && start <= line && line <= end;
    }).sort((left, right) =>
      (Number(left.source?.end_line ?? left.source?.line) - Number(left.source?.line)) -
      (Number(right.source?.end_line ?? right.source?.line) - Number(right.source?.line)));
    if (containing.length === 0) return undefined;
    const smallestSpan = Number(containing[0].source?.end_line ?? containing[0].source?.line) - Number(containing[0].source?.line);
    const smallest = containing.filter(node =>
      Number(node.source?.end_line ?? node.source?.line) - Number(node.source?.line) === smallestSpan);
    return smallest.length === 1 ? smallest[0] : undefined;
  };
  const candidateRecords = new Map<number, CapabilityExitRecord>();
  for (const node of nodes) {
    for (const record of indexes.exitsByExactOwnerId.get(node.id) || []) candidateRecords.set(record.index, record);
  }
  for (const file of reachableByFile.keys()) {
    for (const record of indexes.exitsByFile.get(file) || []) candidateRecords.set(record.index, record);
  }
  const attributed = [...candidateRecords.values()].sort((left, right) => left.index - right.index).map(record => ({ exit: record.exit, owner: callableOwner(record) })).filter((item): item is { exit: CASExitPoint; owner: CASNode } => Boolean(item.owner));
  const descendantsBySource = new Map<string, ReadonlySet<string>>();
  const reaches = (source: string, target: string): boolean => {
    const cachedDescendants = descendantsBySource.get(source);
    if (cachedDescendants) return cachedDescendants.has(target);
    const seen = new Set([source]);
    const queue = [source];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const next of indexes.outgoingNodeIds.get(current) || []) {
        if (!reachableIds.has(next)) continue;
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    seen.delete(source);
    descendantsBySource.set(source, seen);
    return seen.has(target);
  };
  const terminal = attributed.filter(item => !attributed.some(other => other.owner.id !== item.owner.id && reaches(item.owner.id, other.owner.id)));
  indexes.exitsByScope.set(scopeKey, terminal);
  return [...terminal];
}

function isReactHookBinding(node: CASNode | undefined, referenceName: string): boolean {
  if (!node || node.type !== 'react_handler_binding' || node.primaryAnalyzer !== 'react') return false;
  const attributes = (node.metadata as any)?.attributes;
  return (attributes?.binding_kind === 'state-setter' || attributes?.binding_kind === 'disclosure-controller') &&
    Array.isArray(attributes?.binding_names) && attributes.binding_names.includes(referenceName) &&
    declarationBindingNames(node).includes(referenceName);
}

function hasExactComponentPath(pathIds: readonly string[], context: CapabilityOperationCoverageContext): boolean {
  if (pathIds.length < 2 || !pathIds.every(id => context.nodes.some(node => node.id === id && (node.type === 'functional_component' || node.type === 'class_component')))) return false;
  return pathIds.slice(0, -1).every((childId, index) =>
    context.edges.some(edge => edge.type === 'renders' && edge.source === pathIds[index + 1] && edge.target === childId));
}

function allReactReferencesAreProvenHookSupport(entry: CASEntryPoint, context: CapabilityOperationCoverageContext): boolean {
  if (entry.source_analyzer !== 'react' && entry.metadata?.source_analyzer !== 'react') return false;
  const references = Array.isArray(entry.metadata?.handler_references) ? entry.metadata.handler_references : [];
  const bindingIds = Array.isArray(entry.metadata?.handler_binding_node_ids) ? entry.metadata.handler_binding_node_ids.map(String) : [];
  if (references.length === 0 || bindingIds.length !== references.length) return false;
  const nodeById = new Map(context.nodes.map(node => [node.id, node]));
  const childId = String(entry.metadata?.handler_component_id || entry.source_node || '');
  return references.every((reference: any) => {
    const bindingId = String(reference?.binding_node_id || '');
    const rawReferenceName = String(reference?.binding_reference_name || reference?.name || '');
    const binding = nodeById.get(bindingId);
    const memberParts = rawReferenceName.split('.').filter(Boolean);
    if (memberParts.length > 1) {
      const attributes = (binding?.metadata as any)?.attributes;
      if (memberParts.length !== 2 || !['onOpen', 'onClose'].includes(memberParts[1]) ||
          attributes?.binding_kind !== 'disclosure-controller') return false;
    }
    const referenceName = memberParts[0] || '';
    if (!bindingIds.includes(bindingId) || !isReactHookBinding(binding, referenceName)) return false;
    const referencePath = Array.isArray(reference?.binding_component_path) ? reference.binding_component_path : undefined;
    const entryPath = Array.isArray(entry.metadata?.callback_component_path) &&
      String(reference?.binding_origin_component_id || '') === String(entry.metadata?.callback_origin_component_id || '')
      ? entry.metadata.callback_component_path
      : undefined;
    const pathIds = (referencePath || entryPath || []).map(String);
    if (pathIds.length > 0) return pathIds[0] === childId && pathIds[pathIds.length - 1] === binding!.parent && hasExactComponentPath(pathIds, context);
    return binding!.parent === childId && nodeFile(binding!) === normalizedFile(entry.metadata?.handler_file);
  });
}

function hasProvenLocalSupportChain(entry: CASEntryPoint, context: CapabilityOperationCoverageContext): boolean {
  const supportIds = Array.isArray(entry.metadata?.local_support_binding_node_ids) ? entry.metadata.local_support_binding_node_ids.map(String) : [];
  const supportNames = Array.isArray(entry.metadata?.local_support_callee_names) ? entry.metadata.local_support_callee_names.map(String) : [];
  const handlerIds = Array.isArray(entry.metadata?.handler_binding_node_ids) ? entry.metadata.handler_binding_node_ids.map(String) : [];
  if (supportIds.length === 0 || supportIds.length !== supportNames.length || handlerIds.length !== 1) return false;
  const nodeById = new Map(context.nodes.map(node => [node.id, node]));
  if (!supportIds.every((bindingId, index) => isReactHookBinding(nodeById.get(bindingId), supportNames[index]) &&
    context.edges.some(edge => edge.type === 'calls' && edge.source === handlerIds[0] && edge.target === bindingId))) return false;
  const reachable = reachableNodes(handlerIds.map(id => nodeById.get(id)).filter((node): node is CASNode => Boolean(node)), context);
  const reachableIds = new Set(reachable.map(node => node.id));
  const leaves = reachable.filter(node => !(context.edges || []).some(edge =>
    (edge.type === 'calls' || edge.type === 'triggers') && edge.source === node.id && reachableIds.has(edge.target)));
  return leaves.length > 0 && leaves.every(node => supportIds.includes(node.id));
}

function declarationBindingNames(node: CASNode): string[] {
  const name = String(node.name || '').trim();
  if (!name) return [];
  if (/^[A-Za-z_$][\w$]*$/.test(name)) return [name];
  if ((name.startsWith('[') && name.endsWith(']')) || (name.startsWith('{') && name.endsWith('}'))) {
    return [...name.matchAll(/[A-Za-z_$][\w$]*/g)].map(match => match[0]);
  }
  return [];
}

function declarationInitializer(node: CASNode): string {
  const metadata = node.metadata as Record<string, any> | undefined;
  return String((metadata?.attributes as Record<string, unknown> | undefined)?.value || metadata?.value || '');
}

function hasExactLocalHandlerBindings(entry: CASEntryPoint, context: CapabilityOperationCoverageContext, kind: 'state-setter' | 'disclosure-controller'): boolean {
  const references = Array.isArray(entry.metadata?.handler_references) ? entry.metadata.handler_references : [];
  const bindingIds = Array.isArray(entry.metadata?.handler_binding_node_ids)
    ? entry.metadata.handler_binding_node_ids.map(value => String(value))
    : [];
  if (references.length === 0 || bindingIds.length !== references.length || bindingIds.some(id => !id)) return false;
  const nodeById = new Map(context.nodes.map(node => [node.id, node]));
  const handlerFile = normalizedFile(entry.metadata?.handler_file);
  return references.every((reference: any) => {
    const bindingId = String(reference?.binding_node_id || '');
    const binding = nodeById.get(bindingId);
    if (!binding || !bindingIds.includes(bindingId) || nodeFile(binding) !== handlerFile) return false;
    if (binding.type !== 'react_handler_binding' || binding.primaryAnalyzer !== 'react') return false;
    if (binding.parent !== String(entry.metadata?.handler_component_id || entry.source_node || '')) return false;
    const referenceName = String(reference?.name || '');
    const memberParts = referenceName.split('.').filter(Boolean);
    const bindingName = memberParts[0] || '';
    if (memberParts.length > 1 && (kind !== 'disclosure-controller' || memberParts.length !== 2 || !['onOpen', 'onClose'].includes(memberParts[1]))) return false;
    const attributes = (binding.metadata as any)?.attributes;
    if (attributes?.binding_kind !== kind || !Array.isArray(attributes?.binding_names) || !attributes.binding_names.includes(bindingName)) return false;
    if (!declarationBindingNames(binding).includes(bindingName)) return false;
    const initializer = declarationInitializer(binding);
    return kind === 'state-setter'
      ? /(?:^|\.)useState(?:<[^>]+>)?\s*\(/.test(initializer)
      : /(?:^|\.)use(?:Disclosure|Modal|Dialog|Popover|Drawer)\s*\(/.test(initializer);
  });
}

function isProvenLocalEventHandler(entry: CASEntryPoint, context: CapabilityOperationCoverageContext): boolean {
  if (entry.source_analyzer !== 'react' && entry.metadata?.source_analyzer !== 'react') return false;
  if (entry.metadata?.local_handler_kind === 'state-setter') {
    return hasExactLocalHandlerBindings(entry, context, 'state-setter') || hasProvenLocalSupportChain(entry, context);
  }
  if (entry.metadata?.local_handler_kind === 'disclosure-controller') {
    return hasExactLocalHandlerBindings(entry, context, 'disclosure-controller') || hasProvenLocalSupportChain(entry, context);
  }
  return allReactReferencesAreProvenHookSupport(entry, context) || hasProvenLocalSupportChain(entry, context);
}

export function classifyCapabilityOperationEffect(candidate: SystemCapability, operation: SystemCapability['operations'][number], context: CapabilityOperationCoverageContext): CapabilityOperationEffect {
  if (!context.edges || !context.entryPoints || !context.exitPoints || !context.nodes) {
    context = { ...context, edges: context.edges || [], entryPoints: context.entryPoints || [], exitPoints: context.exitPoints || [], nodes: context.nodes || [] };
  }
  const entry = coverageIndexes(context).entryPointById.get(operation.entry_point_id);
  if (isStructuralExecutableCliEntry(entry)) return { entryPointId: operation.entry_point_id, kind: 'support', actions: [], signatures: [], subjects: [], terminalObligations: [] };
  const railsResource = railsResourceOperation(entry);
  if (railsResource?.role === 'create-form' || railsResource?.role === 'update-form') return { entryPointId: operation.entry_point_id, kind: 'support', actions: [], signatures: [], subjects: semanticSubjects(railsResource.resource), terminalObligations: [] };
  const entities = candidate.related_entities || [];
  const directSignature = endpointSignature(operation.trigger?.method || entry?.trigger?.method, operation.trigger?.path || operation.path_or_command || entry?.trigger?.path, entities);
  const declarationEntry = entry?.metadata?.execution_role === 'declaration';
  const declarationSemantics = declarationOperationSemantics(entry);
  const handlers = entry && !declarationEntry ? resolvedHandlerNodes(entry, context) : [];
  const terminalEffects = declarationEntry ? [] : exitsForNodes(reachableNodes(handlers, context), context).filter(({ exit }) => !isTransportScaffoldingExit(exit));
  const reactEntry = entry?.source_analyzer === 'react' || entry?.metadata?.source_analyzer === 'react';
  const resolvedHandlerIds = new Set(handlers.map(node => node.id));
  const exactHandlerText = reactEntry
    ? [...(Array.isArray(entry?.metadata?.handler_references) ? entry.metadata.handler_references.filter((reference: any) => resolvedHandlerIds.has(String(reference?.binding_node_id || ''))).map((reference: any) => reference.name) : []), ...handlers.map(node => node.name)].filter(Boolean).join(' ')
    : [entry?.handler?.method_name, entry?.metadata?.handler_name, ...handlers.map(node => node.name)].filter(Boolean).join(' ');
  const fallbackOperationText = [operation.action, operation.path_or_command, operation.trigger?.path, entry?.name].filter(Boolean).join(' ');
  const railsOperationText = railsResource?.role === 'collection-read' ? `list ${railsResource.resource}`
    : railsResource?.role === 'member-read' ? `view ${railsResource.resource}`
      : undefined;
  const railsResourceLabel = railsResource?.resource.replace(/[_-]+/g, ' ');
  const railsOutcomeLabel = railsResource?.role === 'collection-read' ? `List ${railsResourceLabel}`
    : railsResource?.role === 'member-read' ? `View ${railsResourceLabel?.replace(/s$/, '')}`
      : undefined;
  const operationText = railsOperationText || exactHandlerText || fallbackOperationText;
  const method = String(operation.trigger?.method || entry?.trigger?.method || '').toUpperCase();
  const operationActions = [...new Set([
    ...(declarationSemantics?.actions || semanticActions(operationText)),
    ...(terminalEffects.length === 0 && directSignature && method === 'GET' ? ['read'] : []),
  ])];
  const operationSubjects = (declarationSemantics?.subjects || semanticSubjects(operationText))
    .filter(subject => !(reactEntry && entry?.type === 'page' && subject === 'page'));
  const routeParts = endpointParts(operation.trigger?.path);
  const routeFallbackActions = semanticActions(operation.action);
  const exactRouteSubjects = entry?.type === 'http' && operation.trigger?.path && operation.trigger.path === operation.path_or_command
    ? semanticSubjects(routeParts[routeParts.length - 1] || '') : [];
  const attributionFor = (specificText: unknown, allowOperationFallback = true): { entityIds: string[]; subjects: string[] } => {
    const specificSubjects = semanticSubjects(specificText)
      .filter(subject => !(reactEntry && entry?.type === 'page' && subject === 'page'));
    const localSubjects = specificSubjects.length > 0 || !allowOperationFallback ? specificSubjects : operationSubjects;
    const attributableEntityIds = entities.filter(entity => semanticSubjects(entity).some(subject => localSubjects.includes(subject)));
    const entityIds = attributableEntityIds.length > 0 ? attributableEntityIds : entities.length === 1 ? [...entities] : [];
    const subjects = [...new Set([...semanticSubjects(entityIds.join(' ')), ...localSubjects])];
    return { entityIds, subjects };
  };
  const interactionOutcomeLabel = (() => {
    if (!reactEntry || terminalEffects.length === 0) return undefined;
    const label = String(entry?.metadata?.interaction_label || '').replace(/\s+/g, ' ').trim();
    if (!/\b(?:fetch|import|load|retrieve)\b/i.test(label)) return undefined;
    const stateTargets = Array.isArray(entry?.metadata?.handler_state_target_names)
      ? entry.metadata.handler_state_target_names.map(String) : [];
    const stateBindingIds = Array.isArray(entry?.metadata?.handler_state_target_binding_node_ids)
      ? entry.metadata.handler_state_target_binding_node_ids.map(String) : [];
    const exactStateTargets = stateTargets.filter(target => stateBindingIds.some(bindingId => {
      const binding = context.nodes.find(node => node.id === bindingId);
      const attributes = (binding?.metadata as any)?.attributes;
      return binding?.type === 'react_handler_binding' && binding.primaryAnalyzer === 'react' &&
        Array.isArray(attributes?.binding_names) && attributes.binding_names.includes(target) &&
        resolvedHandlerIds.size === 1 && context.edges.some(edge => edge.type === 'calls' &&
          resolvedHandlerIds.has(edge.source) && edge.target === bindingId && (edge.metadata as any)?.resolution === 'exact-handler-state-write');
    }));
    const entitySubjects = semanticSubjects(entities.join(' '));
    const matchedTarget = exactStateTargets.find(target =>
      semanticSubjects(target).some(subject => entitySubjects.includes(subject)));
    if (!matchedTarget) return undefined;
    const componentId = String(entry?.metadata?.handler_component_id || entry?.source_node || '');
    const hasSiblingMutation = (candidate.operations || []).some(other => {
      if (other.entry_point_id === operation.entry_point_id) return false;
      const sibling = context.entryPoints.find(item => item.id === other.entry_point_id);
      if (!sibling || String(sibling.metadata?.handler_component_id || sibling.source_node || '') !== componentId) return false;
      const siblingEffects = exitsForNodes(reachableNodes(resolvedHandlerNodes(sibling, context), context), context);
      return siblingEffects.some(({ exit }) => terminalEffectActions(exit).some(action => action === 'create' || action === 'update'));
    });
    if (!hasSiblingMutation) return undefined;
    const verb = label.match(/\b(fetch|import|load|retrieve)\b/i)?.[1];
    const target = String(matchedTarget).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
    return verb && target ? `${verb[0].toUpperCase()}${verb.slice(1).toLowerCase()} ${target}` : undefined;
  })();
  const rawTerminalObligations: CapabilityTerminalObligation[] = terminalEffects.length > 0
    ? terminalEffects.map(({ exit, owner }) => {
      const terminalText = [exit.target?.endpoint, exit.target?.resource].filter(Boolean).join(' ');
      const directTerminalActions = terminalEffectActions(exit);
      const ownerActions = semanticActions(owner.name);
      const terminalActions = sortedUnique([
        ...directTerminalActions, ...ownerActions, ...(directSignature ? routeFallbackActions : []),
      ]);
      const terminalAttribution = attributionFor(terminalText, false);
      const signature = endpointSignature(exit.operation?.method, exit.target?.endpoint || exit.target?.resource, terminalAttribution.entityIds);
      return {
        actions: terminalActions,
        signatures: signature ? [signature] : [],
        subjects: terminalAttribution.subjects,
        outcomeLabels: interactionOutcomeLabel ? [interactionOutcomeLabel] : [],
      };
    })
    : [{ actions: operationActions, signatures: directSignature ? [directSignature] : [], subjects: declarationSemantics?.subjects || (exactRouteSubjects.length > 0 ? exactRouteSubjects : attributionFor(operationText).subjects), outcomeLabels: railsOutcomeLabel ? [railsOutcomeLabel] : [] }];
  const terminalObligations = (terminalEffects.length > 0 && rawTerminalObligations.every(obligation => obligation.subjects.length === 0) && exactRouteSubjects.length > 0
    ? [{ actions: routeFallbackActions.length > 0 ? routeFallbackActions : operationActions, signatures: directSignature ? [directSignature] : [], subjects: exactRouteSubjects }]
    : rawTerminalObligations).map(obligation =>
      obligation.actions.length === 0 && directSignature && routeFallbackActions.length > 0
        ? { ...obligation, actions: routeFallbackActions } : obligation);
  const actions = [...new Set(terminalObligations.flatMap(obligation => obligation.actions))];
  const signatures = [...new Set(terminalObligations.flatMap(obligation => obligation.signatures))];
  const subjects = [...new Set(terminalObligations.flatMap(obligation => obligation.subjects))];
  if (signatures.length > 0 || terminalEffects.length > 0) return { entryPointId: operation.entry_point_id, kind: 'required', actions, signatures, subjects, terminalObligations };
  if (entry && isProvenLocalEventHandler(entry, context)) return { entryPointId: operation.entry_point_id, kind: 'support', actions: [], signatures: [], subjects, terminalObligations: [] };
  return { entryPointId: operation.entry_point_id, kind: 'required', actions, signatures: [], subjects, terminalObligations };
}

function scopedRequiredEffects(candidate: SystemCapability, context: CapabilityOperationCoverageContext): CapabilityOperationEffect[] {
  const scope = context.obligationScopes?.get(candidate.id);
  return (candidate.operations || []).map(operation => classifyCapabilityOperationEffect(candidate, operation, context)).flatMap(effect => {
    if (effect.kind !== 'required') return [];
    const terminalKeys = scope?.terminalKeysByEntryPoint.get(effect.entryPointId);
    if (!terminalKeys) return [effect];
    const terminalObligations = effect.terminalObligations.filter(obligation => terminalKeys.has(terminalObligationKey(obligation)));
    if (terminalObligations.length === 0) return [];
    return [{
      ...effect,
      actions: sortedUnique(terminalObligations.flatMap(obligation => obligation.actions)),
      signatures: sortedUnique(terminalObligations.flatMap(obligation => obligation.signatures)),
      subjects: sortedUnique(terminalObligations.flatMap(obligation => obligation.subjects)),
      terminalObligations,
    }];
  });
}

export function hasAuthoritativeCapabilityOperationSubjectLineage(
  candidate: SystemCapability,
  context: CapabilityOperationCoverageContext,
): boolean {
  const effects = scopedRequiredEffects(candidate, context);
  if (effects.length === 0) return false;
  return effects.every(effect => effect.terminalObligations.length > 0 && effect.terminalObligations.every(obligation => {
    if (obligation.actions.length === 0 || obligation.subjects.length === 0) return false;
    if (obligation.signatures.length > 0) return true;
    const entry = context.entryPoints.find(item => item.id === effect.entryPointId);
    if (!entry || (entry.source_analyzer !== 'react' && entry.metadata?.source_analyzer !== 'react')) return false;
    const sourceNode = context.nodes.find(node => node.id === entry.source_node);
    const sourceFile = sourceNode ? nodeFile(sourceNode) : '';
    const pageHandlerFile = normalizedFile(entry.handler?.file);
    const exactPageComponent = entry.type === 'page' && entry.metadata?.trigger_kind === 'page-component' &&
      Boolean(sourceNode && sourceFile && pageHandlerFile && entry.handler?.node_id === entry.source_node &&
        (sourceFile === pageHandlerFile || sourceFile.endsWith(`/${pageHandlerFile}`) || pageHandlerFile.endsWith(`/${sourceFile}`)) &&
        String(entry.metadata?.component || '') === String(entry.handler?.method_name || ''));
    if (exactPageComponent) return true;
    const bindingIds = Array.isArray(entry.metadata?.handler_binding_node_ids)
      ? entry.metadata.handler_binding_node_ids.map(String) : [];
    if (bindingIds.length === 0) return false;
    const bindings = resolvedHandlerNodes(entry, context);
    if (bindings.length !== bindingIds.length) return false;
    const handlerFile = normalizedFile(entry.metadata?.handler_file || entry.handler?.file);
    if (!handlerFile) return false;
    const componentId = String(entry.metadata?.handler_component_id || entry.source_node || '');
    const callbackOriginId = String(entry.metadata?.callback_origin_component_id || '');
    const componentPath = Array.isArray(entry.metadata?.callback_component_path)
      ? entry.metadata.callback_component_path.map(String) : [];
    const hasExactRenderPath = callbackOriginId && componentId &&
      componentPath[0] === componentId && componentPath[componentPath.length - 1] === callbackOriginId &&
      componentPath.slice(0, -1).every((childId, index) => context.edges.some(edge =>
        edge.type === 'renders' && edge.source === componentPath[index + 1] && edge.target === childId));
    const references = Array.isArray(entry.metadata?.handler_references) ? entry.metadata.handler_references : [];
    const bindingIsLocalOrProvenProp = bindings.every(binding => {
      if (nodeFile(binding) === handlerFile) return true;
      if (!hasExactRenderPath) return false;
      const reference = references.find((item: any) => String(item?.binding_node_id || '') === binding.id);
      if (!reference || String(reference.binding_origin_component_id || '') !== callbackOriginId) return false;
      const origin = context.nodes.find(node => node.id === callbackOriginId);
      return Boolean(origin && nodeFile(origin) === nodeFile(binding));
    });
    if (!bindingIsLocalOrProvenProp) return false;
    const triggerTargets = new Set((context.edges || [])
      .filter(edge => edge.type === 'triggers' && edge.source === entry.id)
      .map(edge => edge.target));
    return bindingIds.every(bindingId => triggerTargets.has(bindingId));
  }));
}

export function buildCapabilityOperationObligationViews(
  candidates: readonly SystemCapability[],
  context: CapabilityOperationCoverageContext,
  options: { includeStructuralAggregates?: boolean } = {},
): CapabilityOperationObligationViews {
  const scopes = new Map<string, CapabilityOperationObligationScope>();
  const views = candidates.flatMap(candidate => {
    const behaviorSurface = candidate.evidence_kind === 'behavior-surface' && candidate.evidence_role === 'product-outcome';
    const structuralAggregate = options.includeStructuralAggregates === true && candidate.evidence_kind !== 'behavior-surface';
    if (!behaviorSurface && !structuralAggregate) return [candidate];
    const operationByEntryPoint = new Map((candidate.operations || []).map(operation => [operation.entry_point_id, operation]));
    const groups = new Map<string, { entryPointIds: Set<string>; terminalKeysByEntryPoint: Map<string, Set<string>>; obligations: CapabilityTerminalObligation[] }>();
    for (const effect of scopedRequiredEffects(candidate, context)) {
      for (const obligation of effect.terminalObligations) {
        const terminalKey = terminalObligationKey(obligation);
        const groundedKey = obligation.actions.length > 0 && obligation.subjects.length > 0
          ? terminalKey
          : `${terminalKey}|entry:${effect.entryPointId}`;
        const group = groups.get(groundedKey) || { entryPointIds: new Set<string>(), terminalKeysByEntryPoint: new Map<string, Set<string>>(), obligations: [] };
        group.entryPointIds.add(effect.entryPointId);
        group.terminalKeysByEntryPoint.set(effect.entryPointId, new Set([...(group.terminalKeysByEntryPoint.get(effect.entryPointId) || []), terminalKey]));
        group.obligations.push(obligation);
        groups.set(groundedKey, group);
      }
    }
    if (groups.size <= 1) return [candidate];
    return [...groups.values()].map(group => {
      const entryPointIds = [...group.entryPointIds].sort();
      const actions = sortedUnique(group.obligations.flatMap(obligation => obligation.actions));
      const subjects = sortedUnique(group.obligations.flatMap(obligation => obligation.subjects));
      const outcomeLabels = sortedUnique(group.obligations.flatMap(obligation => obligation.outcomeLabels || []));
      const canonical = JSON.stringify({
        actions,
        entryPointIds,
        signatures: sortedUnique(group.obligations.flatMap(obligation => obligation.signatures)),
        subjects,
      });
      const id = `operation-obligation:${candidate.id}:${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`;
      const relatedEntities = (candidate.related_entities || []).filter(entity =>
        semanticSubjects(entity).some(subject => subjects.includes(subject)));
      const exactEntities = relatedEntities.length > 0
        ? relatedEntities
        : (candidate.related_entities || []).length === 1 ? [...candidate.related_entities] : [];
      const operations = entryPointIds.map(entryPointId => {
        const operation = operationByEntryPoint.get(entryPointId);
        if (!operation) return undefined;
        const terminalKeys = group.terminalKeysByEntryPoint.get(entryPointId) || new Set<string>();
        const operationActions = sortedUnique(group.obligations
          .filter(obligation => terminalKeys.has(terminalObligationKey(obligation)))
          .flatMap(obligation => obligation.actions));
        return { ...operation, ...(operationActions.length > 0 ? { action: operationActions.join(' and ') } : {}) };
      }).filter((operation): operation is SystemCapability['operations'][number] => Boolean(operation));
      const entryPointEvidence = entryPointIds.flatMap(entryPointId => {
        const entryPoint = context.entryPoints.find(item => item.id === entryPointId);
        const interactionLabel = String(entryPoint?.metadata?.interaction_label || '').trim();
        const stateTargets = Array.isArray(entryPoint?.metadata?.handler_state_target_names)
          ? entryPoint.metadata.handler_state_target_names.map(String) : [];
        return [entryPoint?.description || '', interactionLabel, ...stateTargets].filter(Boolean);
      });
      const actionLabel = actions.join(' and ') || 'resolve';
      const subjectLabel = subjects.join(' and ') || semanticSubjects(candidate.structural_label || candidate.name).join(' ') || 'operation';
      const scopedLabel = outcomeLabels.length === 1 ? outcomeLabels[0] : `${actionLabel} ${subjectLabel}`;
      const view: SystemCapability = {
        ...candidate,
        id,
        name: scopedLabel,
        structural_label: scopedLabel,
        operations,
        related_entities: exactEntities,
        evidence_examples: sortedUnique([...(candidate.evidence_examples || []), ...entryPointEvidence]),
        criticality_factors: [...new Set([
          ...(candidate.criticality_factors || []),
          `catalog-parent-candidate:${candidate.id}`,
          `catalog-operation-obligation:${id}`,
          ...(structuralAggregate ? ['catalog-aggregate-operation-view'] : []),
        ])],
      };
      scopes.set(id, { id, parentCandidateId: candidate.id, entryPointIds, terminalKeysByEntryPoint: group.terminalKeysByEntryPoint });
      return view;
    }).sort((left, right) => left.id.localeCompare(right.id));
  });
  return { candidates: views, scopes };
}

export function uncoveredAggregateOperationObligationIds(
  candidates: readonly SystemCapability[],
  published: readonly SystemCapability[],
  scopes: ReadonlyMap<string, CapabilityOperationObligationScope>,
  context: CapabilityOperationCoverageContext,
): Map<string, string[]> {
  const candidateById = new Map(candidates.map(candidate => [candidate.id, candidate]));
  const idsByParent = new Map<string, string[]>();
  for (const scope of scopes.values()) {
    const parent = candidateById.get(scope.parentCandidateId);
    if (!parent || parent.evidence_kind === 'behavior-surface') continue;
    const obligation = candidateById.get(scope.id) || {
      ...parent,
      id: scope.id,
      operations: (parent.operations || []).filter(operation => scope.entryPointIds.includes(operation.entry_point_id)),
      criticality_factors: [...new Set([
        ...(parent.criticality_factors || []),
        `catalog-parent-candidate:${parent.id}`,
        `catalog-operation-obligation:${scope.id}`,
      ])],
    };
    const requiredActions = sortedUnique(scopedRequiredEffects(obligation, context)
      .flatMap(effect => effect.terminalObligations.flatMap(item => item.actions)));
    const actionCompatiblePublished = published.filter(capability => {
      const titleIntent = capabilityTitleActionIntent(capability.name);
      const textActions = semanticActions(`${capability.name} ${capability.description || ''}`);
      const coversFullAggregate = titleIntent.broadManage && uncoveredRequiredCapabilityOperations(parent, [capability], context).length === 0;
      return requiredActions.length > 0 && (coversFullAggregate || requiredActions.every(action => textActions.includes(action)));
    });
    if (obligation && uncoveredRequiredCapabilityOperations(obligation, actionCompatiblePublished, context).length === 0) continue;
    idsByParent.set(parent.id, [...(idsByParent.get(parent.id) || []), scope.id].sort());
  }
  return idsByParent;
}

export function normalizeCapabilityOperationObligationEvidence(
  capabilities: readonly SystemCapability[],
  scopes: ReadonlyMap<string, CapabilityOperationObligationScope>,
  authoritativeCandidates: ReadonlyMap<string, SystemCapability>,
): { capabilities: SystemCapability[]; errors: string[] } {
  const errors: string[] = [];
  const splitParentIds = new Set([...scopes.values()].map(scope => scope.parentCandidateId));
  const normalized = capabilities.map(capability => {
    const factors = capability.criticality_factors || [];
    const obligationIds = factors.filter(factor => factor.startsWith('catalog-operation-obligation:')).map(factor => factor.slice('catalog-operation-obligation:'.length));
    for (const obligationId of obligationIds) if (!scopes.has(obligationId)) errors.push(`operation-obligation-unresolved:${obligationId}`);
    const citedIds = factors.filter(factor => factor.startsWith('catalog-candidate:')).map(factor => factor.slice('catalog-candidate:'.length));
    for (const citedId of citedIds) {
      if (citedId.startsWith('operation-obligation:') && !scopes.has(citedId)) errors.push(`operation-obligation-unresolved:${citedId}`);
      else if (!scopes.has(citedId) && !authoritativeCandidates.has(citedId)) errors.push(`catalog-candidate-unresolved:${citedId}`);
    }
    const citedScopes = citedIds.map(id => scopes.get(id)).filter((scope): scope is CapabilityOperationObligationScope => Boolean(scope));
    const factorScopes = obligationIds.map(id => scopes.get(id)).filter((scope): scope is CapabilityOperationObligationScope => Boolean(scope));
    const resolvedScopes = [...new Map([...citedScopes, ...factorScopes].map(scope => [scope.id, scope])).values()];
    const directCandidates = citedIds
      .filter(id => !scopes.has(id) && !splitParentIds.has(id))
      .map(id => authoritativeCandidates.get(id))
      .filter((candidate): candidate is SystemCapability => Boolean(candidate));
    if (resolvedScopes.length === 0) return capability;
    const obligationFactorIds = new Set(obligationIds);
    for (const scope of citedScopes) if (!obligationFactorIds.has(scope.id)) errors.push(`operation-obligation-missing-factor:${scope.id}`);
    const authoritativeOperations = [
      ...resolvedScopes.flatMap(scope => authoritativeCandidates.get(scope.id)?.operations || []),
      ...directCandidates.flatMap(candidate => candidate.operations || []),
    ];
    const authoritativeByEntryPoint = new Map<string, SystemCapability['operations'][number]>();
    for (const operation of [...authoritativeOperations].sort((left, right) =>
      left.entry_point_id.localeCompare(right.entry_point_id) || JSON.stringify(left).localeCompare(JSON.stringify(right)))) {
      if (!authoritativeByEntryPoint.has(operation.entry_point_id)) authoritativeByEntryPoint.set(operation.entry_point_id, operation);
    }
    const actualEntryPoints = new Set((capability.operations || []).map(operation => operation.entry_point_id));
    for (const scope of resolvedScopes) {
      for (const entryPointId of scope.entryPointIds) {
        if (!actualEntryPoints.has(entryPointId)) errors.push(`operation-obligation-missing-operation:${scope.id}:${entryPointId}`);
      }
      const citesScopeOrParent = citedIds.includes(scope.id) || citedIds.includes(scope.parentCandidateId);
      if (!citesScopeOrParent) errors.push(`operation-obligation-missing-parent:${scope.id}`);
    }
    const operations = [...actualEntryPoints].sort().flatMap(entryPointId => {
      const operation = authoritativeByEntryPoint.get(entryPointId);
      return operation ? [operation] : [];
    });
    const relatedEntities = [...new Set([...resolvedScopes.flatMap(scope => authoritativeCandidates.get(scope.id)?.related_entities || []), ...directCandidates.flatMap(candidate => candidate.related_entities || [])])];
    const relatedDomains = [...new Set([...resolvedScopes.flatMap(scope => authoritativeCandidates.get(scope.id)?.related_domains || []), ...directCandidates.flatMap(candidate => candidate.related_domains || [])])];
    const syntheticIds = new Set(resolvedScopes.map(scope => scope.id));
    return {
      ...capability,
      operations,
      related_entities: relatedEntities,
      related_domains: relatedDomains,
      criticality_factors: [...new Set([
        ...(capability.criticality_factors || []).filter(factor =>
          !factor.startsWith('catalog-parent-candidate:') &&
          !factor.startsWith('catalog-operation-obligation:') &&
          (!factor.startsWith('catalog-candidate:') || !syntheticIds.has(factor.slice('catalog-candidate:'.length)))),
        ...resolvedScopes.map(scope => `catalog-candidate:${scope.parentCandidateId}`),
        ...resolvedScopes.map(scope => `catalog-operation-obligation:${scope.id}`),
      ])],
    };
  });
  return { capabilities: normalized, errors };
}

export function uncoveredRequiredCapabilityOperations(candidate: SystemCapability, published: readonly SystemCapability[], context: CapabilityOperationCoverageContext): CapabilityOperationEffect[] {
  const required = scopedRequiredEffects(candidate, context);
  const entryPointById = coverageIndexes(context).entryPointById;
  const obligationParentCandidateId = context.obligationScopes?.get(candidate.id)?.parentCandidateId;
  const publishedEffects = published.flatMap(capability => (capability.operations || []).map(operation => ({
    effect: classifyCapabilityOperationEffect(capability, operation, context),
    capabilityActionIntent: capabilityTitleActionIntent(capability.name),
    capabilitySubjects: semanticSubjects(capability.name),
    declarationAlias: declaredContractOperationAlias(entryPointById.get(operation.entry_point_id)),
    citesCandidate: (capability.criticality_factors || []).includes(`catalog-candidate:${candidate.id}`) ||
      (capability.criticality_factors || []).includes(`catalog-operation-obligation:${candidate.id}`) ||
      Boolean(obligationParentCandidateId &&
        (capability.criticality_factors || []).includes(`catalog-candidate:${obligationParentCandidateId}`)),
  })));
  const requiresExactObligationCitation = context.obligationScopes?.has(candidate.id) || false;
  return required.filter(requiredEffect => requiredEffect.terminalObligations.length === 0 ||
    requiredEffect.terminalObligations.some(requiredObligation => requiredObligation.actions.length === 0 || requiredObligation.subjects.length === 0 ||
      requiredObligation.actions.some(requiredAction => !publishedEffects.some(({ effect, capabilityActionIntent, capabilitySubjects, declarationAlias, citesCandidate }) =>
        effect.terminalObligations.some(publishedObligation => {
          const requiredAlias = declaredContractOperationAlias(entryPointById.get(requiredEffect.entryPointId));
          const exactDeclarationAlias = Boolean(requiredAlias && declarationAlias === requiredAlias);
          if (requiresExactObligationCitation && !citesCandidate && !exactDeclarationAlias) return false;
          if (citesCandidate && effect.entryPointId === requiredEffect.entryPointId &&
              publishedObligation.actions.includes(requiredAction) &&
              requiredObligation.subjects.some(subject => publishedObligation.subjects.includes(subject))) return true;
          const actionCompatible = publishedObligation.actions.includes(requiredAction) &&
            (capabilityActionIntent.broadManage || capabilityActionIntent.actions.includes(requiredAction));
          const subjectCompatible = requiredObligation.subjects.some(subject => capabilitySubjects.includes(subject)) ||
            (exactDeclarationAlias && requiredObligation.subjects.some(subject => publishedObligation.subjects.includes(subject))) ||
            (citesCandidate && requiredObligation.subjects.some(subject => publishedObligation.subjects.includes(subject)));
          if (!actionCompatible || !subjectCompatible) return false;
          if (effect.entryPointId === requiredEffect.entryPointId) return true;
          if (exactDeclarationAlias) return true;
          return requiredObligation.signatures.length > 0 && publishedObligation.signatures.some(publishedSignature =>
            requiredObligation.signatures.some(requiredSignature => signatureMatches(requiredSignature, publishedSignature)));
        })))));
}

function declaredContractOperationAlias(entry: CASEntryPoint | undefined): string | undefined {
  if (entry?.metadata?.execution_role !== 'declaration') return undefined;
  const metadata = entry.metadata as Record<string, unknown>;
  const service = String(metadata.service || (Array.isArray(metadata.tags) ? metadata.tags[0] : '') || '').trim();
  const rpc = String(metadata.rpc || metadata.operationId || '').trim();
  if (!service || !rpc) return undefined;
  const operation = rpc.replace(new RegExp('^' + service.replace(/[^a-z0-9]/gi, '') + '[_-]?', 'i'), '');
  const normalize = (value: string): string => value.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return operation ? normalize(service) + '|' + normalize(operation) : undefined;
}

export function fullyCoveredAggregateCapabilityCandidateIds(
  candidates: readonly SystemCapability[],
  published: readonly SystemCapability[],
  context: CapabilityOperationCoverageContext,
): Set<string> {
  const covered = new Set<string>();
  const completeContext: CapabilityOperationCoverageContext = {
    ...context,
    edges: context.edges || [],
    entryPoints: context.entryPoints || [],
    exitPoints: context.exitPoints || [],
    nodes: context.nodes || [],
  };
  const scopedParentIds = new Set([...(completeContext.obligationScopes?.values() || [])]
    .map(scope => scope.parentCandidateId));
  const uncoveredAggregateIds = uncoveredAggregateOperationObligationIds(
    candidates, published, completeContext.obligationScopes || new Map(), completeContext,
  );
  for (const candidate of candidates) {
    if (candidate.id.startsWith('operation-obligation:')) continue;
    const requiredEffects = scopedRequiredEffects(candidate, completeContext);
    if (requiredEffects.length === 0 || (scopedParentIds.has(candidate.id)
      ? uncoveredAggregateIds.has(candidate.id)
      : uncoveredRequiredCapabilityOperations(candidate, published, completeContext).length > 0)) continue;
    const declarationOnly = requiredEffects.every(effect => completeContext.entryPoints.find(entryPoint => entryPoint.id === effect.entryPointId)?.metadata?.execution_role === 'declaration');
    if (declarationOnly) { covered.add(candidate.id); continue; }
  const entitySubjectMatches = (entitySubjects: readonly string[], effectSubjects: readonly string[]): boolean =>
    entitySubjects.some(entitySubject => effectSubjects.includes(entitySubject) || (() => {
      const contained = effectSubjects.filter(subject => entitySubject.includes(subject));
      return contained.length > 1 &&
        [...new Set(contained)].reduce((length, subject) => length + subject.length, 0) === entitySubject.length;
    })());

    const productEntities = [...new Set(candidate.related_entities || [])];
    const parentScopes = [...(completeContext.obligationScopes?.values() || [])]
      .filter(scope => scope.parentCandidateId === candidate.id);
    const entitiesCoveredByExactScopes = parentScopes.length > 0 && productEntities.every(entityId => {
      const entitySubjects = semanticSubjects(entityId);
      if (entitySubjects.length === 0) return false;
      return parentScopes.some(scope => scope.entryPointIds.some(entryPointId => {
        const operation = (candidate.operations || []).find(item => item.entry_point_id === entryPointId);
        if (!operation) return false;
        const effect = classifyCapabilityOperationEffect(candidate, operation, completeContext);
        return effect.kind === 'required' && effect.actions.length > 0 &&
          entitySubjectMatches(entitySubjects, effect.subjects);
      }));
    });
    const entitiesCovered = entitiesCoveredByExactScopes || productEntities.every(entityId => {
      const entitySubjects = semanticSubjects(entityId);
      if (entitySubjects.length === 0) return false;
      return published.some(capability => {
        if (!(capability.related_entities || []).includes(entityId) || (capability.operations || []).length === 0) return false;
        const capabilitySubjects = semanticSubjects(capability.name);
        if (!entitySubjects.some(subject => capabilitySubjects.includes(subject))) return false;
        return (capability.operations || []).some(operation => {
          const effect = classifyCapabilityOperationEffect(capability, operation, completeContext);
          return effect.kind === 'required' && effect.actions.length > 0 &&
            entitySubjectMatches(entitySubjects, effect.subjects);
        });
      });
    });
    if (entitiesCovered) covered.add(candidate.id);
  }
  return covered;
}

export function retireFullyCoveredPendingAggregateCapabilities(
  capabilities: readonly SystemCapability[],
  evidenceCandidates: readonly SystemCapability[],
  context: CapabilityOperationCoverageContext,
  isPublishable: (capability: SystemCapability) => boolean,
): SystemCapability[] {
  const publishable = capabilities.filter(isPublishable);
  const evidenceById = new Map(evidenceCandidates.map(candidate => [candidate.id, candidate]));
  const coveredAggregates = fullyCoveredAggregateCapabilityCandidateIds(evidenceCandidates, publishable, context);
  return capabilities.filter(capability => {
    if (isPublishable(capability)) return true;
    const candidateIds = [...new Set((capability.criticality_factors || [])
      .filter(factor => factor.startsWith('catalog-candidate:'))
      .map(factor => factor.slice('catalog-candidate:'.length)))];
    if (candidateIds.length === 0) return true;
    const scopesByParent = new Map<string, CapabilityOperationObligationScope[]>();
    for (const scope of context.obligationScopes?.values() || []) {
      scopesByParent.set(scope.parentCandidateId, [...(scopesByParent.get(scope.parentCandidateId) || []), scope]);
    }
    const citedScopes = candidateIds.flatMap(candidateId => {
      const exactScope = context.obligationScopes?.get(candidateId);
      return exactScope ? [exactScope] : scopesByParent.get(candidateId) || [];
    });
    const scopedActions = new Set(candidateIds.flatMap(candidateId => {
      const candidate = evidenceById.get(candidateId);
      return candidate ? scopedRequiredEffects(candidate, context)
        .flatMap(effect => effect.terminalObligations.flatMap(obligation => obligation.actions)) : [];
    }));
    const isBroad = new Set(citedScopes.map(scope => scope.id)).size > 1 || scopedActions.size > 1;
    if (!isBroad) return true;
    return !candidateIds.every(candidateId => {
      const candidate = evidenceById.get(candidateId);
      if (!candidate) return false;
      const parentScopes = scopesByParent.get(candidateId) || [];
      if (parentScopes.length > 1) return coveredAggregates.has(candidateId);
      return uncoveredRequiredCapabilityOperations(candidate, publishable, context).length === 0;
    });
  });
}

export interface CapabilityCatalogOperationCoverageResult {
  capabilities: SystemCapability[];
  publishableCapabilities: SystemCapability[];
  uncoveredCandidateIds: string[];
  fullyCoveredAggregateCandidateIds: Set<string>;
}

export function evaluateCapabilityCatalogOperationCoverage(
  capabilities: readonly SystemCapability[],
  evidenceCandidates: readonly SystemCapability[],
  context: CapabilityOperationCoverageContext,
  isPublishable: (capability: SystemCapability) => boolean,
): CapabilityCatalogOperationCoverageResult {
  const publishableCapabilities = capabilities.filter(isPublishable);
  const retainedCapabilities = retireFullyCoveredPendingAggregateCapabilities(
    capabilities,
    evidenceCandidates,
    context,
    isPublishable,
  );
  return {
    capabilities: retainedCapabilities,
    publishableCapabilities,
    uncoveredCandidateIds: uncoveredRequiredBehaviorCandidateIds(
      evidenceCandidates,
      publishableCapabilities,
      context,
    ),
    fullyCoveredAggregateCandidateIds: fullyCoveredAggregateCapabilityCandidateIds(
      evidenceCandidates,
      publishableCapabilities,
      context,
    ),
  };
}

export function scopeRequiredCapabilityOperations(
  candidates: readonly SystemCapability[],
  context: CapabilityOperationCoverageContext,
): SystemCapability[] {
  const completeContext: CapabilityOperationCoverageContext = {
    ...context,
    edges: context.edges || [], entryPoints: context.entryPoints || [],
    exitPoints: context.exitPoints || [], nodes: context.nodes || [],
  };
  const knownEntryPointIds = new Set(completeContext.entryPoints.map(entryPoint => entryPoint.id));
  return candidates.map(candidate => {
    if (candidate.evidence_role !== 'product-outcome') return candidate;
    if (candidate.evidence_kind !== 'behavior-surface' &&
        !(candidate.operations || []).some(operation => knownEntryPointIds.has(operation.entry_point_id))) return candidate;
    const requiredEffects = uncoveredRequiredCapabilityOperations(candidate, [], completeContext);
    if (requiredEffects.length === 0) return {
      ...candidate,
      operations: [],
      evidence_role: 'supporting-mechanism',
      evidence_role_reasons: [...new Set([...(candidate.evidence_role_reasons || []), 'only-proven-local-support-operations'])],
    };
    const requiredIds = new Set(requiredEffects.map(effect => effect.entryPointId));
    const actions = [...new Set(requiredEffects.flatMap(effect => effect.actions))];
    const subjects = [...new Set(requiredEffects.flatMap(effect => effect.subjects))];
    const actionLabel = actions.length > 0 ? actions.join(' and ') : 'handle';
    const subjectLabel = subjects.length > 0 ? subjects.join(' and ') : semanticSubjects(candidate.name).join(' ') || 'operation';
    return {
      ...candidate,
      name: `${actionLabel} ${subjectLabel}`,
      operations: (candidate.operations || []).filter(operation => requiredIds.has(operation.entry_point_id)).map(operation => {
        const effect = requiredEffects.find(item => item.entryPointId === operation.entry_point_id);
        return { ...operation, ...(effect?.actions.length ? { action: effect.actions.join(' and ') } : {}) };
      }),
    };
  });
}

export function uncoveredRequiredBehaviorCandidateIds(candidates: readonly SystemCapability[], published: readonly SystemCapability[], context: CapabilityOperationCoverageContext): string[] {
  return candidates.filter(candidate => candidate.evidence_kind === 'behavior-surface' && candidate.evidence_role === 'product-outcome' &&
    uncoveredRequiredCapabilityOperations(candidate, published, context).length > 0).map(candidate => candidate.id);
}
