import * as crypto from 'crypto';
import type {
  CASCallChain,
  CASEdge,
  CASEntryPoint,
  CASMethodCall,
  CASNode,
  CASOutput,
} from '../../../packages/analyzer-core/src/types/cas.types';
import type { RuntimeObservation } from './product';

export type CASContractStatus = 'pass' | 'warn' | 'fail';

export interface CASContractGate {
  id: string;
  status: CASContractStatus;
  score: number;
  detail: string;
}

export interface CASContractReport {
  generated_at: string;
  status: CASContractStatus;
  score: number;
  gates: CASContractGate[];
  summary: {
    nodes: number;
    edges: number;
    entry_points: number;
    exit_points: number;
    method_calls: number;
    call_chains: number;
    runtime_static_links: number;
    facts: number;
    runtime_observations?: number;
  };
  snapshot: CASGoldenSnapshot;
}

export interface CASGoldenSnapshot {
  cas_version: string;
  system_name: string;
  analysis_shape_hash: string;
  counts: Record<string, number>;
  top_level_presence: Record<string, boolean>;
  graph: {
    dangling_edges: number;
    orphaned_nodes: number;
    entry_points_with_handlers: number;
    exit_points_with_sources: number;
    runtime_links_with_targets: number;
    facts_with_evidence: number;
    method_calls_with_nodes: number;
    call_chains_with_nodes: number;
  };
}

export function validateCASContract(cas: CASOutput, observations: RuntimeObservation[] = []): CASContractReport {
  const nodes = cas.nodes || [];
  const edges = cas.edges || [];
  const entryPoints = cas.entry_points || [];
  const exitPoints = cas.exit_points || [];
  const methodCalls = cas.method_calls || [];
  const callChains = cas.call_chains || [];
  const runtimeLinks = cas.runtime_static_links || [];
  const facts = cas.analysis_facts || [];
  const nodeIds = new Set(nodes.map(node => node.id));
  const graphIds = new Set([
    ...nodeIds,
    ...entryPoints.map(entryPoint => entryPoint.id),
    ...exitPoints.map(exitPoint => exitPoint.id),
    ...callChains.map(chain => chain.id),
    ...runtimeLinks.map(link => link.id),
    ...(cas.external_services || []).map(service => service.id),
  ]);

  const danglingEdges = edges.filter(edge => !graphIds.has(edge.source) || !graphIds.has(edge.target));
  const connectedNodeIds = new Set<string>();
  for (const edge of edges) {
    if (nodeIds.has(edge.source)) connectedNodeIds.add(edge.source);
    if (nodeIds.has(edge.target)) connectedNodeIds.add(edge.target);
  }

  const entrySourceIds = new Set(entryPoints.flatMap(entryPoint => [
    entryPoint.source_node,
    entryPoint.handler?.node_id,
  ].filter((value): value is string => Boolean(value))));
  const exitSourceIds = new Set(exitPoints.map(exitPoint => exitPoint.source_node).filter(Boolean));
  const orphanedNodes = nodes.filter(node =>
    node.type !== 'system' &&
    !connectedNodeIds.has(node.id) &&
    !entrySourceIds.has(node.id) &&
    !exitSourceIds.has(node.id)
  );

  const entryPointsWithHandlers = entryPoints.filter(entryPoint => {
    const handlerId = entryPoint.handler?.node_id || entryPoint.source_node;
    return Boolean(handlerId && nodeIds.has(handlerId));
  });
  const exitPointsWithSources = exitPoints.filter(exitPoint => nodeIds.has(exitPoint.source_node));
  const runtimeLinksWithTargets = runtimeLinks.filter(link => graphIds.has(link.static_id));
  const runtimeLinksWithInstrumentation = runtimeLinks.filter(link => link.instrumentation_points.length > 0);
  const factsWithEvidence = facts.filter(fact => fact.evidence.length > 0);
  const methodCallsWithNodes = methodCalls.filter(call =>
    (!call.caller_node || nodeIds.has(call.caller_node)) &&
    (!call.target_node || nodeIds.has(call.target_node))
  );
  const callChainsWithNodes = callChains.filter(chain =>
    chain.call_path.every(step => !step.node_id || nodeIds.has(step.node_id)) &&
    hasValidCallChainEntry(chain, nodeIds, graphIds)
  );
  const matchedRuntimeObservations = observations.filter(observation => observation.correlation.status !== 'unmatched');

  const gates = [
    minimumGate('nodes-present', nodes.length, 1),
    minimumGate('edges-present', edges.length, nodes.length > 1 ? 1 : 0),
    optionalPresenceGate('entry-points-present', entryPoints.length, 'Entry points are absent; data-only and library repos may be valid.'),
    ratioGate('edge-endpoints-valid', edges.length - danglingEdges.length, edges.length, `${danglingEdges.length} dangling edges`),
    ratioGate('entry-handlers-valid', entryPointsWithHandlers.length, entryPoints.length, `${entryPointsWithHandlers.length}/${entryPoints.length}`),
    ratioGate('exit-sources-valid', exitPointsWithSources.length, exitPoints.length, `${exitPointsWithSources.length}/${exitPoints.length}`),
    ratioGate('runtime-links-target-static-objects', runtimeLinksWithTargets.length, runtimeLinks.length, `${runtimeLinksWithTargets.length}/${runtimeLinks.length}`),
    ratioGate('runtime-links-have-instrumentation-points', runtimeLinksWithInstrumentation.length, runtimeLinks.length, `${runtimeLinksWithInstrumentation.length}/${runtimeLinks.length}`),
    ratioGate('analysis-facts-have-evidence', factsWithEvidence.length, facts.length, `${factsWithEvidence.length}/${facts.length}`),
    ratioGate('method-calls-reference-nodes', methodCallsWithNodes.length, methodCalls.length, `${methodCallsWithNodes.length}/${methodCalls.length}`),
    ratioGate('call-chains-reference-nodes', callChainsWithNodes.length, callChains.length, `${callChainsWithNodes.length}/${callChains.length}`),
    gate(
      'relationship-graph-is-queryable',
      nodes.length > 0 && (edges.length > 0 || methodCalls.length > 0 || callChains.length > 0) ? 'pass' : 'fail',
      nodes.length > 0 && (edges.length > 0 || methodCalls.length > 0 || callChains.length > 0) ? 100 : 0,
      `${edges.length} edges, ${methodCalls.length} method calls, ${callChains.length} call chains`
    ),
    gate(
      'analysis-errors-clear',
      (cas.analysis_errors || []).filter(error => error.severity === 'error').length === 0 ? 'pass' : 'fail',
      (cas.analysis_errors || []).filter(error => error.severity === 'error').length === 0 ? 100 : 0,
      `${(cas.analysis_errors || []).filter(error => error.severity === 'error').length} errors`
    ),
    observations.length === 0
      ? gate('runtime-observations-correlate', 'pass', 100, 'No observations supplied')
      : ratioGate('runtime-observations-correlate', matchedRuntimeObservations.length, observations.length, `${matchedRuntimeObservations.length}/${observations.length}`),
    gate(
      'orphaned-node-rate',
      nodes.length === 0 || orphanedNodes.length / nodes.length <= 0.35 ? 'pass' : orphanedNodes.length / nodes.length <= 0.55 ? 'warn' : 'fail',
      nodes.length === 0 ? 100 : Math.round((1 - Math.min(1, orphanedNodes.length / nodes.length)) * 100),
      `${orphanedNodes.length}/${nodes.length}`
    ),
  ];

  return {
    generated_at: new Date().toISOString(),
    status: statusFromGates(gates),
    score: Math.round(average(gates.map(result => result.score))),
    gates,
    summary: {
      nodes: nodes.length,
      edges: edges.length,
      entry_points: entryPoints.length,
      exit_points: exitPoints.length,
      method_calls: methodCalls.length,
      call_chains: callChains.length,
      runtime_static_links: runtimeLinks.length,
      facts: facts.length,
      runtime_observations: observations.length,
    },
    snapshot: buildCASGoldenSnapshot(cas),
  };
}

export function buildCASGoldenSnapshot(cas: CASOutput): CASGoldenSnapshot {
  const nodes = cas.nodes || [];
  const edges = cas.edges || [];
  const entryPoints = cas.entry_points || [];
  const exitPoints = cas.exit_points || [];
  const methodCalls = cas.method_calls || [];
  const callChains = cas.call_chains || [];
  const runtimeLinks = cas.runtime_static_links || [];
  const facts = cas.analysis_facts || [];
  const nodeIds = new Set(nodes.map(node => node.id));
  const graphIds = new Set([
    ...nodeIds,
    ...entryPoints.map(entryPoint => entryPoint.id),
    ...exitPoints.map(exitPoint => exitPoint.id),
    ...callChains.map(chain => chain.id),
    ...runtimeLinks.map(link => link.id),
    ...(cas.external_services || []).map(service => service.id),
  ]);
  const danglingEdges = edges.filter(edge => !graphIds.has(edge.source) || !graphIds.has(edge.target));
  const connectedNodeIds = connectedNodes(nodes, edges);
  const orphanedNodes = nodes.filter(node => node.type !== 'system' && !connectedNodeIds.has(node.id));

  const shape = {
    system: cas.system.name,
    version: cas.cas_version,
    node_ids: stableIds(nodes),
    edge_ids: stableIds(edges),
    entry_point_ids: stableIds(entryPoints),
    exit_point_ids: stableIds(exitPoints),
    method_call_ids: stableIds(methodCalls),
    call_chain_ids: stableIds(callChains),
    runtime_link_ids: stableIds(runtimeLinks),
  };

  return {
    cas_version: cas.cas_version,
    system_name: cas.system.name,
    analysis_shape_hash: crypto.createHash('sha256').update(JSON.stringify(shape)).digest('hex'),
    counts: {
      nodes: nodes.length,
      edges: edges.length,
      entry_points: entryPoints.length,
      exit_points: exitPoints.length,
      method_calls: methodCalls.length,
      call_chains: callChains.length,
      runtime_static_links: runtimeLinks.length,
      facts: facts.length,
      entities: cas.entities?.length || 0,
      behavioral_invariants: cas.behavioral_invariants?.length || 0,
      journeys: cas.flows?.length || 0,
      capabilities: cas.capabilities?.length || 0,
      libraries: cas.libraries?.length || 0,
    },
    top_level_presence: {
      architecture_summary: Boolean(cas.architecture_summary),
      route_table: Boolean(cas.route_table?.length),
      database_schema: Boolean(cas.database_schema?.entities?.length),
      behavioral_invariants: Boolean(cas.behavioral_invariants?.length),
      flow_graph: Boolean(cas.flow_graph),
      runtime: Boolean(cas.runtime),
      configuration: Boolean(cas.configuration),
      validation: Boolean(cas.validation),
    },
    graph: {
      dangling_edges: danglingEdges.length,
      orphaned_nodes: orphanedNodes.length,
      entry_points_with_handlers: entryPoints.filter(hasValidEntryHandler(nodeIds)).length,
      exit_points_with_sources: exitPoints.filter(exitPoint => nodeIds.has(exitPoint.source_node)).length,
      runtime_links_with_targets: runtimeLinks.filter(link => graphIds.has(link.static_id)).length,
      facts_with_evidence: facts.filter(fact => fact.evidence.length > 0).length,
      method_calls_with_nodes: methodCalls.filter(hasValidMethodCallNodes(nodeIds)).length,
      call_chains_with_nodes: callChains.filter(hasValidCallChainNodes(nodeIds, graphIds)).length,
    },
  };
}

export function compareCASGoldenSnapshot(cas: CASOutput, expected: CASGoldenSnapshot): CASContractGate[] {
  const actual = buildCASGoldenSnapshot(cas);
  const gates: CASContractGate[] = [
    gate('snapshot-version', actual.cas_version === expected.cas_version ? 'pass' : 'warn', actual.cas_version === expected.cas_version ? 100 : 80, `${actual.cas_version} vs ${expected.cas_version}`),
    gate('snapshot-shape-hash', actual.analysis_shape_hash === expected.analysis_shape_hash ? 'pass' : 'warn', actual.analysis_shape_hash === expected.analysis_shape_hash ? 100 : 80, `${actual.analysis_shape_hash.slice(0, 12)} vs ${expected.analysis_shape_hash.slice(0, 12)}`),
  ];

  for (const [key, expectedValue] of Object.entries(expected.counts)) {
    gates.push(minimumGate(`snapshot-count:${key}`, actual.counts[key] || 0, expectedValue));
  }

  return gates;
}

function connectedNodes(nodes: CASNode[], edges: CASEdge[]): Set<string> {
  const nodeIds = new Set(nodes.map(node => node.id));
  const connected = new Set<string>();
  for (const edge of edges) {
    if (nodeIds.has(edge.source)) connected.add(edge.source);
    if (nodeIds.has(edge.target)) connected.add(edge.target);
  }
  return connected;
}

function hasValidEntryHandler(nodeIds: Set<string>) {
  return (entryPoint: CASEntryPoint) => {
    const handlerId = entryPoint.handler?.node_id || entryPoint.source_node;
    return Boolean(handlerId && nodeIds.has(handlerId));
  };
}

function hasValidMethodCallNodes(nodeIds: Set<string>) {
  return (call: CASMethodCall) =>
    (!call.caller_node || nodeIds.has(call.caller_node)) &&
    (!call.target_node || nodeIds.has(call.target_node));
}

function hasValidCallChainNodes(nodeIds: Set<string>, graphIds: Set<string>) {
  return (chain: CASCallChain) =>
    chain.call_path.every(step => !step.node_id || nodeIds.has(step.node_id)) &&
    hasValidCallChainEntry(chain, nodeIds, graphIds);
}

function hasValidCallChainEntry(chain: CASCallChain, nodeIds: Set<string>, graphIds: Set<string>): boolean {
  const entryPointId = chain.entry_point.entry_point_id;
  if (!entryPointId) return true;
  if (graphIds.has(entryPointId)) return true;
  return entryPointId.startsWith('synthflow:') && nodeIds.has(chain.entry_point.node_id);
}

function stableIds(items: Array<{ id: string }>): string[] {
  return items.map(item => item.id).sort();
}

function minimumGate(id: string, actual: number, minimum: number): CASContractGate {
  if (minimum === 0) return gate(id, 'pass', 100, `${actual}/${minimum}`);
  const score = Math.round(Math.min(1, actual / minimum) * 100);
  return gate(id, actual >= minimum ? 'pass' : actual >= minimum * 0.7 ? 'warn' : 'fail', score, `${actual}/${minimum}`);
}

function optionalPresenceGate(id: string, actual: number, missingDetail: string): CASContractGate {
  return actual > 0
    ? gate(id, 'pass', 100, `${actual} present`)
    : gate(id, 'warn', 85, missingDetail);
}

function ratioGate(id: string, actual: number, total: number, detail: string): CASContractGate {
  if (total === 0) return gate(id, 'pass', 100, detail);
  const ratio = actual / total;
  return gate(id, ratio >= 0.95 ? 'pass' : ratio >= 0.8 ? 'warn' : 'fail', Math.round(ratio * 100), detail);
}

function gate(id: string, status: CASContractStatus, score: number, detail: string): CASContractGate {
  return { id, status, score: Math.max(0, Math.min(100, score)), detail };
}

function statusFromGates(gates: CASContractGate[]): CASContractStatus {
  if (gates.some(result => result.status === 'fail')) return 'fail';
  if (gates.some(result => result.status === 'warn')) return 'warn';
  return 'pass';
}

function average(values: number[]): number {
  if (values.length === 0) return 100;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
