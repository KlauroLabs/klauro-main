import test from 'node:test';
import assert from 'node:assert/strict';
import type { CASOutput, CASNode, CASEdge, CASEntryPoint } from '../../../packages/analyzer-core/src/types/cas.types';
import { getCodingContext, getFlowConcepts, getCallers, assessChangeRisk, getConfiguration, buildSummary, getFlowGraph, getRuntimeStaticLinks, getDataLineage } from './query';
import { attachCasProjection } from './cas-projection';

// Builds a synthetic CAS with a single high-fanout "hub" node that has more
// callers/callees than the default display limit, plus a handful of
// low-fanout nodes for control/comparison.
test('lineage summaries expose unresolved transfer counts and exit references', () => {
  const cas = buildHighFanoutCas({ callerCount: 0, calleeCount: 0 });
  cas.data_lineage = [{
    entity_id: 'entity', entity_name: 'Article', sensitive_fields: [], writers: [], readers: [],
    external_recipients: [], unresolved_exit_point_ids: ['dependency'],
    boundaries_crossed: [], journeys_carrying: [],
    exposure: { unguarded_paths: 0, sensitive: false, external_transfer: false, external_transfer_unresolved: true },
  }];
  const result = getDataLineage(cas, {}) as any;
  assert.equal(result.entities_with_external_transfer, 0);
  assert.equal(result.entities_with_unresolved_transfer, 1);
  assert.deepEqual(result.entities[0].unresolved_exit_point_ids, ['dependency']);
  assert.equal(result.entities[0].exposure.external_transfer_unresolved, true);
});

function buildHighFanoutCas(opts: { callerCount: number; calleeCount: number }): CASOutput {
  const nodes: CASNode[] = [];
  const edges: CASEdge[] = [];

  const hubId = 'class_hub_Hub_0';
  nodes.push({
    id: hubId,
    name: 'Hub',
    type: 'class',
    source: { file: 'src/hub.ts', line: 1 },
    metadata: {},
  } as CASNode);

  for (let i = 0; i < opts.callerCount; i++) {
    const callerId = `class_caller_${i}_Caller${i}_0`;
    nodes.push({
      id: callerId,
      name: `Caller${i}`,
      type: 'class',
      source: { file: `src/caller${i}.ts`, line: 1 },
      metadata: {},
    } as CASNode);
    edges.push({ id: `edge_caller_${i}`, source: callerId, target: hubId, type: 'uses' });
  }

  for (let i = 0; i < opts.calleeCount; i++) {
    const calleeId = `class_callee_${i}_Callee${i}_0`;
    nodes.push({
      id: calleeId,
      name: `Callee${i}`,
      type: 'class',
      source: { file: `src/callee${i}.ts`, line: 1 },
      metadata: {},
    } as CASNode);
    edges.push({ id: `edge_callee_${i}`, source: hubId, target: calleeId, type: 'uses' });
  }

  return {
    cas_version: '1.11.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'analysis-high-fanout-test',
    system: { id: 'system-test', name: 'high-fanout-test', type: 'service', root_path: '/tmp/high-fanout' },
    nodes,
    edges,
    analyzer_contributions: [],
  } as unknown as CASOutput;
}

test('buildSummary reports canonical inventory for a bounded projection without inventing graph rows', () => {
  const cas = attachCasProjection({
    cas_version: '3.0.0',
    analysis_timestamp: '2026-08-22T00:00:00.000Z',
    analysis_id: 'projected',
    system: { name: 'Projected', type: 'service' },
    nodes: [],
    edges: [],
    analyzer_contributions: [],
  } as unknown as CASOutput, {
    loaded_sections: ['identity', 'comprehension', 'quality'],
    node_count: 62_375,
    edge_count: 114_765,
  });

  const summary: any = buildSummary(cas);

  assert.equal(summary.nodes, 62_375);
  assert.equal(summary.edges, 114_765);
  assert.deepEqual(summary.nodes_by_type, {});
  assert.equal(summary.projection.graph_detail_loaded, false);
  assert.equal(summary.projection.counts_source, 'canonical-compact-graph-manifest');
  assert.equal(cas.nodes.length, 0);
  assert.equal(cas.edges.length, 0);
});

test('getCodingContext reports truncated:true with real totals when a node has more callers/callees than the default limit', () => {
  const cas = buildHighFanoutCas({ callerCount: 45, calleeCount: 30 });
  const context: any = getCodingContext(cas, 'class_hub_Hub_0');

  const connected = context.connected_code;
  assert.ok(connected, 'connected_code should be present');

  // Default limit is 10, so only 10 of the 45 real callers / 30 real callees come back.
  assert.equal(connected.callers.length, 10);
  assert.equal(connected.callees.length, 10);

  // Truncation must be signaled, not silent.
  assert.equal(connected.truncated, true);
  assert.equal(connected.callers_total, 45);
  assert.equal(connected.callees_total, 30);
  assert.ok(connected.callers_total > connected.callers.length);
  assert.ok(connected.callees_total > connected.callees.length);
  assert.ok(typeof connected.truncation_hint === 'string' && connected.truncation_hint.length > 0);
});

test('getCodingContext returns the full caller/callee set when given a larger limit, and truncated is false when nothing is cut', () => {
  const cas = buildHighFanoutCas({ callerCount: 45, calleeCount: 30 });
  const context: any = getCodingContext(cas, 'class_hub_Hub_0', { caller_limit: 45, callee_limit: 30 });

  const connected = context.connected_code;
  assert.equal(connected.callers.length, 45);
  assert.equal(connected.callees.length, 30);
  assert.equal(connected.callers_total, 45);
  assert.equal(connected.callees_total, 30);
  assert.equal(connected.truncated, false);
  assert.equal(connected.truncation_hint, undefined);
});

test('getCodingContext does not signal truncation for a low-fanout node under the default limit', () => {
  const cas = buildHighFanoutCas({ callerCount: 3, calleeCount: 2 });
  const context: any = getCodingContext(cas, 'class_hub_Hub_0');

  const connected = context.connected_code;
  assert.equal(connected.callers.length, 3);
  assert.equal(connected.callees.length, 2);
  assert.equal(connected.callers_total, 3);
  assert.equal(connected.callees_total, 2);
  assert.equal(connected.truncated, false);
});

// Builds a CAS where the same callee/caller node is reachable both via a plain
// graph edge AND via a method_call record (a real shape: an analyzer can emit
// a `uses`/`calls` edge for a call site as well as a richer method_call record
// for the same call). Before the dedup fix, getCallees/getCallers (and
// therefore getCodingContext's connected_code) listed such a node twice.
function buildDualPathCas(): CASOutput {
  const callerId = 'function_src/a.ts_caller_0';
  const calleeId = 'function_src/b.ts_callee_0';
  const nodes: CASNode[] = [
    { id: callerId, name: 'caller', type: 'function', source: { file: 'src/a.ts', line: 1 }, metadata: {} } as CASNode,
    { id: calleeId, name: 'callee', type: 'function', source: { file: 'src/b.ts', line: 1 }, metadata: {} } as CASNode,
  ];
  const edges: CASEdge[] = [
    { id: 'edge_1', source: callerId, target: calleeId, type: 'calls' },
  ];
  const method_calls = [
    {
      id: 'mc_1',
      caller_node: callerId,
      target_node: calleeId,
      call_details: { method_name: 'callee' },
    },
  ] as unknown as CASOutput['method_calls'];

  return {
    cas_version: '1.11.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'analysis-dual-path-test',
    system: { id: 'system-test', name: 'dual-path-test', type: 'service', root_path: '/tmp/dual-path' },
    nodes,
    edges,
    method_calls,
    analyzer_contributions: [],
  } as unknown as CASOutput;
}

test('getCodingContext connected_code.callees is deduplicated when a node is reachable via both an edge and a method_call record', () => {
  const cas = buildDualPathCas();
  const context: any = getCodingContext(cas, 'function_src/a.ts_caller_0');

  const calleeIds = context.connected_code.callees.map((c: any) => c.id);
  assert.equal(calleeIds.length, 1, `expected exactly one deduped callee, got: ${JSON.stringify(calleeIds)}`);
  assert.equal(context.connected_code.callees_total, 1);
});

test('getCodingContext connected_code.callers is deduplicated when a node is reachable via both an edge and a method_call record', () => {
  const cas = buildDualPathCas();
  const context: any = getCodingContext(cas, 'function_src/b.ts_callee_0');

  const callerIds = context.connected_code.callers.map((c: any) => c.id);
  assert.equal(callerIds.length, 1, `expected exactly one deduped caller, got: ${JSON.stringify(callerIds)}`);
  assert.equal(context.connected_code.callers_total, 1);
});

test('getCodingContext derives convenience fields from the canonical node contract and overlays runtime on a response copy', () => {
  const cas = buildDualPathCas();
  const node = cas.nodes.find(candidate => candidate.id === 'function_src/a.ts_caller_0')!;
  node.contract = {
    input: ['request: Request'], logic: 'caller calls callee',
    side_effects: { state_changes: [], external_integrations: [] },
    output: ['Response'], constraints: [],
    facet_abstentions: { constraints: 'no-source-evidence', system_effects: 'no-source-evidence', telemetry: 'no-runtime-observation' },
    facet_provenance: [
      { facet: 'input', value: 'request: Request', contributed_by_node_ids: [node.id], source: 'deterministic', evidence: 'signature.parameters' },
      { facet: 'logic', value: 'caller calls callee', contributed_by_node_ids: [node.id], source: 'deterministic', evidence: 'edge edge_1' },
      { facet: 'output', value: 'Response', contributed_by_node_ids: [node.id], source: 'deterministic', evidence: 'signature.return_type' },
    ],
  };
  const before = JSON.stringify(node.contract);
  const context: any = getCodingContext(cas, node.id, {
    runtimeMetrics: [{ static_id: node.id, request_count: 5, error_rate: 0, source: 'ingested' }],
  });
  assert.equal(context.contract.input, context.input);
  assert.equal(context.contract.logic, context.logic);
  assert.equal(context.contract.telemetry.request_count, 5);
  assert.equal(JSON.stringify(node.contract), before);
  assert.equal(node.contract.telemetry, undefined);
});

test('getCodingContext degrades gracefully (never a bare error) when the target is missing from a fresh analysis', () => {
  const cas = buildHighFanoutCas({ callerCount: 1, calleeCount: 1 });
  const context: any = getCodingContext(cas, 'thisSymbolDoesNotExistAnywhere');

  assert.ok(typeof context.error === 'string' && context.error.length > 0);
  assert.equal(context.target, 'thisSymbolDoesNotExistAnywhere');
  assert.ok(Array.isArray(context.near_matches));
  assert.ok(typeof context.analysis_age_hint === 'string' && context.analysis_age_hint.length > 0);
  assert.ok(Array.isArray(context.next_steps) && context.next_steps.length > 0);
  // Must nudge toward the staleness-check tool and (if the tool itself seems
  // broken) get_server_version — never a dead end.
  assert.ok(context.next_steps.some((s: string) => s.includes('get_analysis_freshness')));
  assert.ok(context.next_steps.some((s: string) => s.includes('get_server_version')));
});

test('getCodingContext offers near-name matches for a typo close to a real node name', () => {
  const cas = buildHighFanoutCas({ callerCount: 2, calleeCount: 2 });
  // "Hubb" is a one-character-off typo of the real node name "Hub".
  const context: any = getCodingContext(cas, 'Hubb');

  assert.ok(typeof context.error === 'string');
  assert.ok(context.near_matches.some((m: any) => m.name === 'Hub'), `expected a near match for "Hub", got: ${JSON.stringify(context.near_matches)}`);
});

test('getCodingContext resolves a file-stem target to production code instead of its test', () => {
  const cas = buildHighFanoutCas({ callerCount: 0, calleeCount: 0 });
  cas.nodes.push(
    { id: 'file_store', name: 'participant-in-flight-store.ts', type: 'file', source: { file: 'src/coordination/participant-in-flight-store.ts', line: 1 }, metadata: {} } as CASNode,
    { id: 'function_log_path', name: 'logPath', type: 'function', source: { file: 'src/coordination/participant-in-flight-store.ts', line: 30 }, metadata: {} } as CASNode,
    { id: 'file_store_test', name: 'participant-in-flight-store.test.ts', type: 'file', category: 'test', source: { file: 'src/coordination/participant-in-flight-store.test.ts', line: 1 }, metadata: {} } as CASNode,
  );

  const context: any = getCodingContext(cas, 'participant-in-flight-store');

  assert.equal(context.target_node.id, 'file_store');
  assert.equal(context.target_node.file, 'src/coordination/participant-in-flight-store.ts');
});

// Builds a CAS with `entryPointCount` independent traceable entry points
// (each a small function with its own name/route), so getFlowConcepts has
// one candidate flow per entry point when no `target` filter is given —
// the shape that produced 1,133 flows (~1.87MB / ~467k tokens) on the real
// proof-of-concept repo before the default flow cap was added.
function buildManyEntryPointsCas(entryPointCount: number): CASOutput {
  const nodes: CASNode[] = [];
  const entry_points: CASEntryPoint[] = [];

  for (let i = 0; i < entryPointCount; i++) {
    const nodeId = `function_src/handlers/handler${i}.ts_handler${i}_0`;
    nodes.push({
      id: nodeId,
      name: `handler${i}`,
      type: 'function',
      source: { file: `src/handlers/handler${i}.ts`, line: 1 },
      metadata: {},
    } as CASNode);
    entry_points.push({
      id: `entry_${i}`,
      type: 'http_route',
      name: `handler${i}`,
      source_node: nodeId,
      trigger: { method: 'GET', path: `/handler${i}` },
    } as unknown as CASEntryPoint);
  }

  return {
    cas_version: '1.11.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'analysis-many-entry-points-test',
    system: { id: 'system-test', name: 'many-entry-points-test', type: 'service', root_path: '/tmp/many-entry-points' },
    nodes,
    edges: [],
    entry_points,
    analyzer_contributions: [],
  } as unknown as CASOutput;
}

test('getFlowConcepts defaults to a bounded number of flows (not one per entry point) when no target is given', () => {
  const cas = buildManyEntryPointsCas(200);
  const result: any = getFlowConcepts(cas, {});

  // Default cap (DEFAULT_MAX_FLOWS, raised 15 -> 25 once the window became
  // significance-RANKED rather than derivation-ordered — see query.ts) must
  // kick in, not "all 200 entry points".
  assert.ok(result.flows.length <= 25, `expected <= 25 flows by default, got ${result.flows.length}`);
  assert.equal(result.total, result.flows.length);
  assert.equal(result.truncated, true);
  assert.ok(result.total_available >= 200, `expected total_available to reflect the real entry point count, got ${result.total_available}`);
  assert.ok(
    (result.gaps || []).some((g: string) => g.includes('max_flows')),
    `expected a gap explaining the default cap, got: ${JSON.stringify(result.gaps)}`,
  );
});

test('getFlowConcepts returns every flow when max_flows is explicitly raised past the real count', () => {
  const cas = buildManyEntryPointsCas(20);
  const result: any = getFlowConcepts(cas, { maxFlows: 20 });

  assert.equal(result.flows.length, 20);
  assert.equal(result.total, 20);
  assert.equal(result.truncated, false);
});

test('getFlowConcepts does not apply the default browse-cap when target narrows to a specific entry point', () => {
  const cas = buildManyEntryPointsCas(200);
  const result: any = getFlowConcepts(cas, { target: 'handler5' });

  // A targeted lookup is already narrow (matches only entry points whose
  // id/name/route contains "handler5" — here just one), so it should not
  // additionally get capped/truncated by the all-flows default.
  assert.equal(result.truncated, false);
  assert.ok(result.flows.length >= 1);
});

// --- PACKET B1: capability_relationships (M:N, role on the EDGE) serialized
// through getFlowConcepts, including rule (c): an entity-overlap edge on a
// flow the semantic-role classifier grounds as infrastructure (script entry)
// is 'operational', not 'supporting'.
test('getFlowConcepts serializes capability_relationships and upgrades infrastructure entity-overlap edges to operational', () => {
  const cas = {
    cas_version: '1.11.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'analysis-cap-rel-test',
    system: { id: 'system-test', name: 'cap-rel-test', type: 'service', root_path: '/tmp/cap-rel' },
    nodes: [
      { id: 'n_create', name: 'createOrder', type: 'function', source: { file: 'src/orders/create.ts', line: 1 }, metadata: {} },
      { id: 'n_deploy', name: 'runDeploy', type: 'function', source: { file: 'scripts/deploy.sh', line: 1 }, metadata: {} },
    ],
    edges: [],
    entry_points: [
      { id: 'ep_create', type: 'http', name: 'createOrder', source_node: 'n_create', trigger: { method: 'POST', path: '/orders' }, handler: { node_id: 'n_create', method_name: 'createOrder' } },
      { id: 'ep_deploy', type: 'cli', name: 'deploy', source_node: 'n_deploy', handler: { node_id: 'n_deploy', method_name: 'runDeploy' } },
    ],
    exit_points: [
      { id: 'xp_create', source_node: 'n_create', type: 'database', name: 'saveOrder', target: { resource: 'orders' } },
    ],
    data_lineage: [
      {
        entity_id: 'entity_order', entity_name: 'Order', sensitive_fields: [],
        writers: [{ node_id: 'n_create' }, { node_id: 'n_deploy' }],
        readers: [], external_recipients: [], boundaries_crossed: [], journeys_carrying: [],
        exposure: { unguarded_paths: 0, external_transfer: false, sensitive: false },
      },
    ],
    capabilities: [
      {
        id: 'cap_orders', name: 'Order Management', description: 'Orders', category: 'core',
        operations: [{ entry_point_id: 'ep_create', entry_point_type: 'http', action: 'create' }],
        related_entities: ['Order'], related_domains: [], criticality: 'high', criticality_factors: [],
      },
    ],
    analyzer_contributions: [],
  } as unknown as CASOutput;

  const result: any = getFlowConcepts(cas, {});
  const createFlow = result.flows.find((f: any) => f.entry_point === 'ep_create');
  const deployFlow = result.flows.find((f: any) => f.entry_point === 'ep_deploy');

  // Flow side, both directions of the M:N model serialized per flow.
  assert.ok(createFlow.capability_relationships, 'primary flow must carry capability_relationships');
  assert.equal(createFlow.capability_relationships[0].capability_id, 'cap_orders');
  assert.equal(createFlow.capability_relationships[0].role, 'primary');
  assert.ok(createFlow.capability_relationships[0].rationale.includes('ep_create'));
  assert.equal(createFlow.capability_id, 'cap_orders'); // back-compat primary link

  // Rule (c): deploy.sh-rooted flow is classifier-grounded infrastructure, so
  // its entity-overlap edge to cap_orders is 'operational' (not 'supporting').
  assert.ok(deployFlow, 'deploy flow must exist');
  assert.equal(deployFlow.role, 'infrastructure');
  assert.equal(deployFlow.capability_relationships.length, 1);
  assert.equal(deployFlow.capability_relationships[0].capability_id, 'cap_orders');
  assert.equal(deployFlow.capability_relationships[0].role, 'operational');
  assert.ok(deployFlow.capability_relationships[0].rationale.includes('semantic-role classifier'));
  assert.equal(deployFlow.capability_id, undefined); // no operation ref → no primary
});

// --- 2026-07-04 impact benchmark fixes ------------------------------------
//
// #1 (flagship): get_callers never tracked cross-file reads of exported
// constants/interface properties, only call expressions — this simulates the
// CAS shape the fix produces (a 'references' edge, distinct from 'calls') and
// asserts getCallers surfaces it.
test('getCallers surfaces a "references" edge to an exported constant, not just "contains"', () => {
  const cas: any = {
    cas_version: '1.11.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'analysis-references-test',
    system: { id: 'system-test', name: 'references-test', type: 'service', root_path: '/tmp/references' },
    nodes: [
      { id: 'file_tier_limits_ts', name: 'tier-limits.ts', type: 'file', source: { file: 'tier-limits.ts', line: 1 }, metadata: {} },
      { id: 'variable_TIER_RATE_LIMITS', name: 'TIER_RATE_LIMITS', type: 'variable', source: { file: 'tier-limits.ts', line: 10 }, metadata: {} },
      { id: 'method_RateLimiter_isRateLimited', name: 'isRateLimited', type: 'method', source: { file: 'rate-limiter.ts', line: 50 }, metadata: {} },
    ],
    edges: [
      { id: 'e1', source: 'file_tier_limits_ts', target: 'variable_TIER_RATE_LIMITS', type: 'contains' },
      { id: 'e2', source: 'method_RateLimiter_isRateLimited', target: 'variable_TIER_RATE_LIMITS', type: 'references' },
    ],
    analyzer_contributions: [],
  };

  const result: any = getCallers(cas, 'variable_TIER_RATE_LIMITS', 1, 50);
  assert.equal(result.total, 2);
  const via = result.callers.map((c: any) => c.via);
  assert.ok(via.includes('edge:contains'));
  assert.ok(via.includes('edge:references'), `expected a references-edge caller, got ${JSON.stringify(result.callers)}`);
  const referenceCaller = result.callers.find((c: any) => c.via === 'edge:references');
  assert.equal(referenceCaller.node_id, 'method_RateLimiter_isRateLimited');
});

// #3: assess_change_risk must not silently return risk:null plus the whole-repo
// change_risk_summary for a node type buildChangeRisks never scores (e.g. an
// interface property) — that reads as "assessed, low risk" when it was never
// evaluated at all.
test('assessChangeRisk reports unsupported:true for a node type it never scores, instead of a silent whole-repo dump', () => {
  const cas: any = {
    nodes: [
      { id: 'class_RateLimits', name: 'RateLimits', type: 'interface', metadata: {} },
      { id: 'property_endpoints', name: 'endpoints', type: 'property', metadata: {} },
    ],
    edges: [
      { id: 'e1', source: 'class_RateLimits', target: 'property_endpoints', type: 'contains' },
    ],
    change_risks: [],
    change_risk_summary: {
      high_risk_nodes: ['unrelated_node_1', 'unrelated_node_2'],
      untested_critical_paths: [],
      recent_hotspots: [],
    },
  };

  const result: any = assessChangeRisk(cas, 'property_endpoints');
  assert.equal(result.risk, null);
  assert.equal(result.unsupported, true);
  assert.equal(result.node_type, 'property');
  // The whole-repo summary must NOT leak into an "unsupported" response — that's the
  // exact silent-wrong-answer shape the bug report flagged.
  assert.equal(result.change_risk_context, null);
});

test('assessChangeRisk still returns real risk + summary for a supported node type (no regression)', () => {
  const cas: any = {
    nodes: [
      { id: 'method_x', name: 'doThing', type: 'method', metadata: {} },
    ],
    edges: [],
    change_risks: [
      { node_id: 'method_x', risk_level: 'high', risk_factors: [] },
    ],
    change_risk_summary: { high_risk_nodes: ['method_x'], untested_critical_paths: [], recent_hotspots: [] },
  };

  const result: any = assessChangeRisk(cas, 'method_x');
  assert.equal(result.unsupported, undefined);
  assert.equal(result.risk.risk_level, 'high');
  assert.equal(result.risk_computation, 'precomputed');
  assert.ok(result.change_risk_context);
});

// Defect #1 (2026-08 blackbox demo): assess_change_risk's headline `risk`
// field came back null for a real method, while the reachability engine
// beneath it (transitive_impact) was correct. Root cause: buildChangeRisks
// caps its repo-wide list at the top 100 and pre-filters "boring" nodes
// (few callers, not exported/entry/data/repo/domain/critical) as noise for
// that SUMMARY — neither reason should make a targeted per-node question
// come back empty. assessChangeRisk must compute an answer on demand
// instead of returning risk:null whenever the node's type is riskable.
test('assessChangeRisk computes risk on demand instead of returning null when the node is riskable but missing from cas.change_risks', () => {
  const cas: any = {
    nodes: [
      {
        id: 'method_lonely', name: 'formatLocaleDate', type: 'method', metadata: {},
        source: { file: 'src/i18n/locale-printer.ts' },
      },
    ],
    edges: [],
    change_risks: [], // buildChangeRisks left this node out entirely (capped/filtered)
    change_risk_summary: { high_risk_nodes: [], untested_critical_paths: [], recent_hotspots: [] },
  };

  const result: any = assessChangeRisk(cas, 'method_lonely');
  assert.notEqual(result.risk, null, 'risk must never be null for a riskable node type');
  assert.equal(result.risk.node_id, 'method_lonely');
  assert.equal(result.risk_computation, 'computed_on_demand');
  // Zero direct test coverage and no analyzer-populated tested_by -> honestly flagged.
  assert.ok(result.risk.risk_factors.some((f: any) => f.factor === 'no-tests'));
});

// Defect #2 (2026-08 blackbox demo): a one-method assess_change_risk query
// returned ~100 high_risk_nodes and ~47 untested_critical_paths spanning
// unrelated JS files, locale printers, and config parsers — repo-wide lists
// embedded under a per-change answer, reading as "your change endangers 100
// things". change_risk_context must scope those lists to the change's own
// blast radius; repo-wide totals stay available but only as counts, clearly
// labeled repo-wide.
test('assessChangeRisk scopes high_risk_nodes/untested_critical_paths to the change\'s blast radius, not the whole repo', () => {
  const cas: any = {
    nodes: [
      { id: 'method_target', name: 'chargeCard', type: 'method', metadata: {} },
      { id: 'method_caller', name: 'checkout', type: 'method', metadata: {} },
      { id: 'method_unrelated', name: 'formatLocale', type: 'method', metadata: {} },
    ],
    edges: [
      // method_caller calls method_target -> method_caller is upstream (affected).
      { id: 'e1', source: 'method_caller', target: 'method_target', type: 'calls' },
    ],
    change_risks: [
      { node_id: 'method_target', risk_level: 'critical', risk_factors: [], test_protection: { has_direct_tests: false } },
    ],
    change_risk_summary: {
      high_risk_nodes: ['method_target', 'method_unrelated'],
      untested_critical_paths: ['method_target', 'method_unrelated'],
      recent_hotspots: ['method_unrelated'],
    },
  };

  const result: any = assessChangeRisk(cas, 'method_target');
  const scoped = result.change_risk_context;
  assert.ok(scoped);
  // Scoped lists must be a strict subset of {the node itself, its transitive blast radius}.
  assert.ok(scoped.high_risk_nodes.includes('method_target'));
  assert.ok(!scoped.high_risk_nodes.includes('method_unrelated'), 'unrelated repo-wide node must not appear in the scoped list');
  assert.ok(!scoped.untested_critical_paths.includes('method_unrelated'));
  assert.ok(!scoped.recent_hotspots.includes('method_unrelated'));
  // Repo-wide context still available, but as counts only, and clearly labeled.
  assert.equal(scoped.repo_wide.high_risk_node_count, 2);
  assert.match(scoped.repo_wide.note.toLowerCase(), /not scoped/);
});

// Task #138: scoreChangeRiskOnDemand (the fallback path assessChangeRisk uses
// when a node is missing from cas.change_risks) never had the hardcoded
// business-domain regex buildChangeRisks had, and now both share one
// structural-only implementation (hasStructuralSecurityEvidence in
// orchestrator.ts). Paired regression: a domain-vocabulary name alone must
// not escalate severity or add a security-sensitive factor, but real
// security metadata (node.security) still must.
test('assessChangeRisk (computed on demand) does not escalate from business-domain vocabulary in the name/file alone', () => {
  const cas: any = {
    nodes: [
      {
        id: 'method_chargeCustomer', name: 'chargeCustomerInvoice', type: 'method', metadata: {},
        source: { file: 'src/billing/InvoiceService.ts' },
      },
    ],
    edges: [],
    entry_points: [],
    change_risks: [],
    change_risk_summary: { high_risk_nodes: [], untested_critical_paths: [], recent_hotspots: [] },
  };

  const result: any = assessChangeRisk(cas, 'method_chargeCustomer');
  assert.equal(result.risk_computation, 'computed_on_demand');
  assert.ok(!result.risk.risk_factors.some((f: any) => f.factor === 'security-sensitive'), 'a domain-vocabulary name alone must not trigger security-sensitive');
});

test('assessChangeRisk (computed on demand) still escalates from REAL structural security evidence, even with a domain-neutral name', () => {
  const cas: any = {
    nodes: [
      {
        id: 'method_doThing', name: 'doThing', type: 'method', metadata: {},
        source: { file: 'src/widgets/WidgetService.ts' },
        security: { authentication_required: true },
      },
    ],
    edges: [],
    entry_points: [],
    change_risks: [],
    change_risk_summary: { high_risk_nodes: [], untested_critical_paths: [], recent_hotspots: [] },
  };

  const result: any = assessChangeRisk(cas, 'method_doThing');
  assert.equal(result.risk_computation, 'computed_on_demand');
  assert.ok(result.risk.risk_factors.some((f: any) => f.factor === 'security-sensitive'), 'real node.security evidence must still trigger security-sensitive');
});

// #4: get_configuration(affecting_node_id=...) must surface an env var a node directly
// reads via process.env.X even when cas.configuration.environment_variables never picked
// it up (it's only populated from .env-shaped FILES, not from a plain `export const X =
// process.env.X` in an ordinary source file).
test('getConfiguration(affecting_node_id) discovers a process.env-backed variable reached via a references edge', () => {
  const cas: any = {
    nodes: [
      {
        id: 'variable_ENFORCE_API_QUOTAS', name: 'ENFORCE_API_QUOTAS', type: 'variable',
        source: { file: 'config.ts', line: 5 },
        metadata: { value: "process.env.ENFORCE_API_QUOTAS === 'true'" },
      },
      {
        id: 'method_intercept', name: 'intercept', type: 'method',
        source: { file: 'quota-enforcement.interceptor.ts', line: 30 },
        metadata: {},
      },
    ],
    edges: [
      { id: 'e1', source: 'method_intercept', target: 'variable_ENFORCE_API_QUOTAS', type: 'references' },
    ],
    configuration: {},
  };

  const result: any = getConfiguration(cas, { affecting_node_id: 'method_intercept' });
  assert.equal(result.environment_variables.length, 1);
  assert.equal(result.environment_variables[0].name, 'ENFORCE_API_QUOTAS');
});

test('getConfiguration(affecting_node_id) returns no env vars for a node with no process.env reference (no false positives)', () => {
  const cas: any = {
    nodes: [
      { id: 'method_unrelated', name: 'unrelated', type: 'method', source: { file: 'x.ts', line: 1 }, metadata: {} },
    ],
    edges: [],
    configuration: {},
  };

  const result: any = getConfiguration(cas, { affecting_node_id: 'method_unrelated' });
  assert.equal(result.environment_variables.length, 0);
});

// Regression: buildSummary must surface the RIGHT CAS fields for the two facts
// the summary exists to convey — the primary language and the domain entities.
// The bug this locks out (v1.0.51 blocker): a 99.9%-TypeScript, 202-entity crypto
// codebase was summarized as languages [shell,html,css,glimmer] with 3 entities,
// because buildSummary read node.metadata.language (which the TS analyzer never
// stamps) and cas.database_schema.entities (a narrow ORM/DDL view) instead of the
// byte-ranked system.technologies.languages and the full cas.entities.
function buildTwoSourceCas(): any {
  const nodes: any[] = [];
  // 40 primary TS product nodes that carry isTypeScript/extension but NOT a
  // metadata.language field — exactly how the TS/JS analyzer stamps them.
  for (let i = 0; i < 40; i++) {
    nodes.push({
      id: `fn_${i}`,
      name: `handler${i}`,
      type: 'function',
      source: { file: `src/business/handler${i}.ts`, line: 1 },
      metadata: { isTypeScript: true, extension: '.ts', framework: 'nestjs' },
    });
  }
  // A couple of trailing markup/shell nodes that DO carry metadata.language —
  // the only thing the old node-metadata scan could see.
  nodes.push({ id: 'tpl', name: 't', type: 'template', source: { file: 'views/x.hbs', line: 1 }, metadata: { language: 'glimmer' } });
  nodes.push({ id: 'sh', name: 's', type: 'script', source: { file: 'scripts/run.sh', line: 1 }, metadata: { language: 'shell' } });

  return {
    nodes,
    edges: [],
    entry_points: [],
    cas_version: '1.11.0',
    analyzer_contributions: [],
    system: {
      name: 'soon-lens',
      type: 'service',
      technologies: {
        // Byte-ranked: TypeScript wins by a mile. This is the authoritative source.
        languages: [
          { name: 'TypeScript/JavaScript', percentage: 99.9, files: 742 },
          { name: 'Shell/Bash', percentage: 0.1, files: 2 },
          { name: 'Glimmer', percentage: 0, files: 7 },
        ],
        frameworks: [{ name: 'NestJS' }],
      },
    },
    // Full domain-entity extraction (Camp-B): 202 in production; 5 representative here.
    entities: [
      { id: 'e1', name: 'Macd' }, { id: 'e2', name: 'BollingerBands' },
      { id: 'e3', name: 'RiskMetrics' }, { id: 'e4', name: 'AssetAnalysis' },
      { id: 'e5', name: 'OracleFeedMapping' },
    ],
    // Narrow ORM/DDL view — the field the summary used to (wrongly) read from.
    database_schema: { entities: [{ name: 'Strategy' }, { name: 'StrategyExecution' }, { name: 'StrategyAlert' }] },
  };
}

test('buildSummary reports the byte-ranked primary language, not trailing markup/shell noise', () => {
  const summary: any = buildSummary(buildTwoSourceCas(), { detail: 'compact' });
  assert.equal(summary.languages[0], 'TypeScript/JavaScript',
    `primary language must be TypeScript, got ${JSON.stringify(summary.languages)}`);
  // The historic failure surfaced ONLY the markup/shell files and dropped TS entirely.
  assert.ok(!/^(shell|glimmer|html|css)/i.test(summary.languages[0]),
    `primary language must not be a trailing markup/shell file: ${JSON.stringify(summary.languages)}`);
});

test('buildSummary surfaces the full domain-entity set (entities), not the narrow database_schema view', () => {
  const summary: any = buildSummary(buildTwoSourceCas(), { detail: 'compact' });
  assert.equal(summary.database_entities.length, 5,
    `expected the 5 entities, got ${summary.database_entities.length}: ${JSON.stringify(summary.database_entities)}`);
  assert.ok(summary.database_entities.includes('Macd'),
    'domain entities (Macd, BollingerBands, ...) must be present, not just the 3 ORM entities');
  assert.ok(!summary.database_entities.includes('StrategyAlert') || summary.database_entities.length > 3,
    'must not collapse to the 3-entity database_schema view');
});

test('buildSummary falls back to database_schema entities only when entities is absent', () => {
  const cas = buildTwoSourceCas();
  cas.entities = [];
  const summary: any = buildSummary(cas, { detail: 'compact' });
  assert.deepEqual(summary.database_entities, ['Strategy', 'StrategyExecution', 'StrategyAlert']);
});

// Regression (live prod, Zerac): a Rust + shell + TS repo whose analyzers typed
// real domain entities as entity/model NODES (NotificationModel, DeviceIdentity,
// Identity) but whose data-entity extraction produced nothing reported
// database_entities: [] even though the repo's own AI description named those
// entities. The summary must surface entity-KIND nodes as the last-resort
// source — without inflating plain structs/classes/DTOs in.
test('buildSummary surfaces entity-kind nodes when entities and database_schema are both empty', () => {
  const cas = buildTwoSourceCas();
  cas.entities = [];
  cas.database_schema = { entities: [] };
  cas.nodes.push(
    { id: 'ent1', name: 'NotificationModel', type: 'model', source: { file: 'bin/agent/src/notify.rs', line: 3 } },
    { id: 'ent2', name: 'DeviceIdentity', type: 'entity', source: { file: 'crates/protocol/src/identity.rs', line: 10 } },
    { id: 'ent3', name: 'Identity', type: 'struct', subcategories: ['entity'], source: { file: 'crates/protocol/src/identity.rs', line: 40 } },
    // Must NOT be inflated in: a plain struct, an abstract shape, a DTO-ish class.
    { id: 'plain', name: 'RetryConfig', type: 'struct', source: { file: 'crates/config/src/retry.rs', line: 1 } },
    { id: 'abstract', name: 'BaseRecord', type: 'entity', subcategories: ['abstract'], source: { file: 'src/base.ts', line: 1 } },
    { id: 'dto', name: 'LoginRequestDto', type: 'class', source: { file: 'src/dto/login.ts', line: 1 } },
  );
  const summary: any = buildSummary(cas, { detail: 'compact' });
  assert.deepEqual([...summary.database_entities].sort(), ['DeviceIdentity', 'Identity', 'NotificationModel'],
    `entity-kind nodes must surface (and only those): ${JSON.stringify(summary.database_entities)}`);
});

test('buildSummary falls back to product-node language signals only when technologies.languages is empty', () => {
  const cas = buildTwoSourceCas();
  cas.system.technologies.languages = [];
  const summary: any = buildSummary(cas, { detail: 'compact' });
  // productTechSignals now derives TS from isTypeScript/extension, so TS still wins.
  assert.ok(summary.languages.includes('TypeScript/JavaScript'),
    `product-node fallback must still detect TypeScript: ${JSON.stringify(summary.languages)}`);
});

// Honest L5 status (live prod: electripure/hercules/openclaw): when the AI
// comprehension pass terminally FAILED, the summary must SAY so — surfacing
// ai_enrichment: 'error' + the underlying rejection reason — instead of leaving
// readers to infer forever-pending from description_source: null.
test('buildSummary surfaces a terminal ai_enrichment error with its rejection reason', () => {
  const cas = buildTwoSourceCas();
  cas.ai_enrichment = 'error';
  cas.ai_enrichment_error = 'grounding gate rejection (source-bucket-restatement)';
  const summary: any = buildSummary(cas, { detail: 'compact' });
  assert.equal(summary.ai_enrichment, 'error');
  assert.equal(summary.ai_enrichment_error, 'grounding gate rejection (source-bucket-restatement)');

  // Non-error states surface the marker without the error field; absent marker stays absent.
  cas.ai_enrichment = 'ready';
  delete cas.ai_enrichment_error;
  const readySummary: any = buildSummary(cas, { detail: 'compact' });
  assert.equal(readySummary.ai_enrichment, 'ready');
  assert.equal('ai_enrichment_error' in readySummary, false);

  delete cas.ai_enrichment;
  const legacySummary: any = buildSummary(cas, { detail: 'compact' });
  assert.equal('ai_enrichment' in legacySummary, false);
});

// Regression (live, openclaw): the #1 top capability in get_summary was
// "Deletes Profile data" — supporting plumbing outranked the product's core
// capabilities because the sort keyed on criticality alone. Plumbing must
// never lead: supporting/admin rank strictly below core, internal is excluded.
test('buildSummary top_capabilities is never led by supporting/admin plumbing', () => {
  const cas = buildTwoSourceCas();
  cas.capabilities = [
    {
      id: 'c1', name: 'Deletes Profile data', category: 'supporting', criticality: 'high',
      operations: [{}, {}, {}], related_entities: [], related_domains: ['profile'],
    },
    {
      id: 'c2', name: 'Puzzle Play', category: 'core', criticality: 'medium',
      operations: [{}], related_entities: [], related_domains: ['puzzle'],
    },
    {
      id: 'c3', name: 'Admin Settings', category: 'admin', criticality: 'high',
      operations: [{}, {}], related_entities: [], related_domains: ['settings'],
    },
    {
      id: 'c4', name: 'Health Checks', category: 'internal', criticality: 'low',
      operations: [{}], related_entities: [], related_domains: ['health'],
    },
  ];
  const summary: any = buildSummary(cas, { detail: 'compact' });
  assert.equal(summary.top_capabilities[0], 'Puzzle Play',
    `core capability must lead, got ${JSON.stringify(summary.top_capabilities)}`);
  assert.ok(!summary.top_capabilities.includes('Health Checks'),
    'internal capabilities must not appear in the top list');
  assert.ok(summary.top_capabilities.indexOf('Deletes Profile data') > summary.top_capabilities.indexOf('Puzzle Play'),
    'supporting plumbing ranks strictly below core');
});

test('buildSummary never presents structural candidates as canonical capabilities', () => {
  const cas = buildTwoSourceCas();
  cas.capabilities = [];
  cas.structural_capability_candidates = [{ id: 'candidate', name: 'Analyze Create', operations: [] } as any];
  cas.flow_graph = {
    ...(cas.flow_graph || {} as any),
    capability_candidates: [{ id: 'flow-candidate', name: 'HTTP Request Handler', signals: { total_score: 100 } } as any],
  } as any;

  const summary: any = buildSummary(cas, { detail: 'compact' });

  assert.equal(summary.capabilities, 0);
  assert.equal(summary.structural_capability_candidates, 1);
  assert.deepEqual(summary.top_capabilities, []);
});

test('buildSummary.frameworks reports only real product frameworks, not adapter shims or category labels', () => {
  // Regression for the live dogfood leak: Klauro (a TypeScript monorepo) reported
  // django/fastapi (from Python fixtures + the klauro-sdk-py telemetry SDK's
  // adapter middleware) and library CATEGORY labels ("authentication and
  // authorization") as its frameworks. summary.frameworks is the field the AI
  // description cites, so it must go through the comprehension gate.
  const cas = {
    system: { name: 'proof-of-concept', type: 'monorepo', technologies: { frameworks: [{ name: 'FastAPI' }, { name: 'Django' }] } },
    nodes: [
      { id: 'r1', name: 'App', type: 'react_app', source: { file: 'apps/app/src/App.tsx' }, metadata: { framework: 'react' }, analyzers: ['react'] },
      { id: 'r2', name: 'Panel', type: 'functional_component', source: { file: 'apps/app/src/Panel.tsx' }, metadata: { framework: 'react' }, analyzers: ['react'] },
      { id: 'f1', name: 'KlauroASGIMiddleware', type: 'middleware', source: { file: 'packages/klauro-sdk-py/src/klauro_telemetry/middleware.py' }, metadata: { framework: 'fastapi' }, analyzers: ['fastapi'] },
      { id: 'd1', name: 'klauro_telemetry', type: 'module', source: { file: 'packages/klauro-sdk-py/src/klauro_telemetry' }, metadata: { framework: 'django' }, analyzers: ['django'] },
      { id: 'a1', name: 'login', type: 'route', source: { file: 'src/auth/auth.controller.ts' }, metadata: { framework: 'authentication and authorization' }, analyzers: ['auth'] },
    ],
    edges: [],
    entry_points: [],
    analyzer_contributions: [
      { analyzer_id: 'react', analyzer_type: 'framework', analyzer_name: 'React Analyzer' },
      { analyzer_id: 'fastapi', analyzer_type: 'framework', analyzer_name: 'FastAPI Analyzer' },
      { analyzer_id: 'django', analyzer_type: 'framework', analyzer_name: 'Django Analyzer' },
      { analyzer_id: 'auth', analyzer_type: 'library', analyzer_name: 'Auth Library Analyzer' },
    ],
  } as unknown as CASOutput;

  const summary: any = buildSummary(cas, { detail: 'compact' });
  assert.deepEqual(summary.frameworks, ['react'],
    `summary.frameworks must be only real product frameworks, got ${JSON.stringify(summary.frameworks)}`);
});

test('buildSummary recognizes a framework from its product entry points', () => {
  const cas = buildTwoSourceCas();
  cas.nodes.push({ id: 'dashboard-page', name: 'DashboardPage', type: 'function', source: { file: 'app/dashboard/page.tsx' }, analyzers: ['typescript-javascript'] } as any);
  cas.entry_points = [{
    id: 'next-page', source_node: 'dashboard-page', source_analyzer: 'nextjs', type: 'page', name: 'PAGE /dashboard',
    metadata: { framework: 'nextjs' },
  } as any];
  cas.analyzer_contributions = [
    ...(cas.analyzer_contributions || []),
    { analyzer_id: 'nextjs', analyzer_type: 'framework', contribution_type: 'framework' } as any,
  ];

  const summary: any = buildSummary(cas, { detail: 'compact' });

  assert.ok(summary.frameworks.includes('nextjs'));
});

test('runtime query overlays mark static links and capability evidence observed without mutating CAS', () => {
  const cas = {
    nodes: [],
    edges: [],
    runtime_static_links: [{
      id: 'runtime-entry-orders',
      kind: 'entry-point',
      static_id: 'entry-orders',
      telemetry_status: 'instrumentable',
    }],
    flow_graph: {
      capability_candidates: [{
        id: 'cap-orders',
        name: 'Manage orders',
        description: 'Manage orders',
        entry_points: ['entry-orders'],
        call_chain_ids: [],
        services_used: [],
        exit_points: [],
        operations: [],
        operation_patterns: [],
        entry_point_summary: { types: ['http'], count: 1, primary_type: 'http' },
        complexity_profile: {},
        signals: {},
      }],
      dependencies: [],
      topology: {},
      primary_flow: {},
      layers: [],
    },
  } as unknown as CASOutput;
  const metrics = [{
    static_id: 'runtime-entry-orders',
    request_count: 20,
    error_rate: 0.1,
    latency: { p95_ms: 250 },
  }];

  const links = getRuntimeStaticLinks(cas, { telemetryStatus: 'observed' }, metrics);
  assert.equal(links.total, 1);
  assert.equal(links.links[0].telemetry_status, 'observed');
  assert.equal(cas.runtime_static_links![0].telemetry_status, 'instrumentable');

  const graph: any = getFlowGraph(cas, metrics);
  assert.deepEqual(graph.capabilities[0].telemetry, {
    observed: true,
    matched_signal_count: 1,
    request_count: 20,
    error_rate: 0.1,
    p95_ms: 250,
  });
  assert.equal(graph.flow_count, 0);
  assert.deepEqual(graph.flows, []);
});
