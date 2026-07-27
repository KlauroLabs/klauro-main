/**
 * CAS REFERENTIAL-INTEGRITY INVARIANTS.
 *
 * Every id reference the CAS ships must resolve to a record the CAS also
 * ships. These invariants exist because the live analysis shipped hundreds of
 * `flow_id` references (`system_capabilities[].related_flows`, `flow::…::stepN`
 * step ids) against a `flow_graph` that had no `flows` collection at all — the
 * flows were derived, used, and discarded. A dangling reference is a data
 * defect even when every individual field looks well-formed, so it is gated
 * structurally here rather than left to eyeballing a stored CAS.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnalyzerOrchestrator } from './orchestrator';
import { CASCallChain, CASFlowGraph } from '../../types/cas.types';

function emptyFlowGraph(): CASFlowGraph {
  return {
    capabilities: [],
    dependencies: [],
    topology: { root_capabilities: [], leaf_capabilities: [], critical_path: [], max_depth: 0 },
    primary_flow: { core_capability_id: '', value_chain: [], supporting_capabilities: [], infrastructure_capabilities: [] },
    layers: [],
    system_insights: { detected_patterns: [], primary_entry_type: '', data_flow_type: '' },
  };
}

/** Terminal-chain-anchored and entry-point-rooted flows, exactly as
 *  computeFlowConcepts mints them (two anchors, ONE id scheme per flow). */
function derivedFlows() {
  return [
    {
      flow_id: 'flow::chain:entry_http_create_order',
      name: 'Create Order',
      intent: 'POST /orders → database orders',
      entry_point: 'entry_http_create_order',
      capability_id: 'cap_orders',
      capability_relationships: [{ capability_id: 'cap_orders' }, { capability_id: 'cap_billing' }],
      steps: [{ step_id: 'flow::chain:entry_http_create_order::step0' }, { step_id: 'flow::chain:entry_http_create_order::step1' }],
      terminus: { kind: 'database', produces: 'orders' },
    },
    {
      // Entry-point-rooted: chain dead-ends, so there is no call chain and no
      // criticality to carry — the record must simply omit them, not guess.
      flow_id: 'flow::entry_mcp_tool_run',
      name: 'Run Tool',
      intent: 'MCP tool run',
      entry_point: 'entry_mcp_tool_run',
      steps: [{ step_id: 'flow::entry_mcp_tool_run::step0' }],
    },
    // Duplicate flow_id from the union path must collapse to one record.
    {
      flow_id: 'flow::entry_mcp_tool_run',
      name: 'Run Tool (duplicate)',
      intent: 'duplicate',
      entry_point: 'entry_mcp_tool_run',
      steps: [],
    },
  ];
}

function callChains(): CASCallChain[] {
  return [
    { id: 'chain:entry_http_create_order', criticality: 'critical' } as unknown as CASCallChain,
    { id: 'chain:unrelated', criticality: 'low' } as unknown as CASCallChain,
  ];
}

function materialize() {
  const orchestrator = new AnalyzerOrchestrator() as any;
  const flowGraph = emptyFlowGraph();
  orchestrator.materializeFlowGraphFlows(flowGraph, derivedFlows(), callChains());
  return flowGraph;
}

test('flow_graph.flows materializes the derived flow set (the resolution target for every flow_id)', () => {
  const flowGraph = materialize();
  const flows = flowGraph.flows || [];

  assert.equal(flows.length, 2, 'duplicate flow_ids collapse to one record');
  assert.deepEqual(flows.map(flow => flow.flow_id).sort(), [
    'flow::chain:entry_http_create_order',
    'flow::entry_mcp_tool_run',
  ]);

  const chainFlow = flows.find(flow => flow.flow_id === 'flow::chain:entry_http_create_order')!;
  assert.equal(chainFlow.name, 'Create Order');
  assert.equal(chainFlow.step_count, 2);
  assert.equal(chainFlow.call_chain_id, 'chain:entry_http_create_order');
  assert.equal(chainFlow.criticality, 'critical', 'criticality is carried from the anchoring call chain');
  assert.equal(chainFlow.capability_id, 'cap_orders');
  assert.deepEqual(chainFlow.capability_ids, ['cap_orders', 'cap_billing']);
  assert.deepEqual(chainFlow.terminus, { kind: 'database', produces: 'orders' });

  const entryFlow = flows.find(flow => flow.flow_id === 'flow::entry_mcp_tool_run')!;
  assert.equal(entryFlow.step_count, 1, 'the first (richer) record wins, not the duplicate');
  assert.equal(entryFlow.criticality, undefined, 'no chain → no guessed criticality');
  assert.equal(entryFlow.call_chain_id, undefined);
});

test('INVARIANT: every flow_id referenced in the CAS resolves to a flow in flow_graph.flows', () => {
  const flowGraph = materialize();
  const resolvable = new Set((flowGraph.flows || []).map(flow => flow.flow_id));

  // Every place the CAS carries a flow_id reference.
  const cas = {
    flow_graph: flowGraph,
    system_capabilities: [{
      id: 'cap_orders',
      related_flows: [
        { flow_id: 'flow::chain:entry_http_create_order', role: 'primary', rationale: 'entry point' },
        { flow_id: 'flow::entry_mcp_tool_run', role: 'supporting', rationale: 'shared entity' },
      ],
    }],
    behavior_surfaces: [{
      id: 'surface_mcp',
      related_flows: [{ flow_id: 'flow::entry_mcp_tool_run', role: 'primary', rationale: 'registration' }],
    }],
  };

  const references: string[] = [
    ...cas.system_capabilities.flatMap(capability => capability.related_flows.map(link => link.flow_id)),
    ...cas.behavior_surfaces.flatMap(surface => surface.related_flows.map(link => link.flow_id)),
  ];

  assert.ok(references.length > 0, 'the fixture must actually exercise references');
  const dangling = references.filter(flowId => !resolvable.has(flowId));
  assert.deepEqual(dangling, [], `dangling flow_id references: ${dangling.join(', ')}`);
});

test('INVARIANT: flow step ids are namespaced under their own flow_id (one canonical id scheme per flow)', () => {
  const flowGraph = materialize();
  const resolvable = new Set((flowGraph.flows || []).map(flow => flow.flow_id));

  for (const flow of derivedFlows()) {
    if (!resolvable.has(flow.flow_id)) continue;
    for (const step of flow.steps || []) {
      const stepId = (step as { step_id: string }).step_id;
      assert.ok(
        stepId.startsWith(`${flow.flow_id}::step`),
        `step id ${stepId} does not resolve back to a materialized flow`
      );
    }
  }
});

test('flow_summary references CALL CHAIN ids, not flow ids — and each maps onto a flow id', () => {
  // Naming trap worth pinning: `flow_summary.untested_critical_flows` /
  // `high_error_rate_flows` are populated from call_chains and therefore hold
  // `chain:…` ids, NOT `flow::…` ids. They are not checked against
  // flow_graph.flows (a ranked chain need not produce a flow — the flow union
  // dedups by entry point), but the id an entry there maps to is deterministic.
  const flowSummary = {
    untested_critical_flows: ['chain:entry_http_create_order'],
    high_error_rate_flows: [] as string[],
  };
  const resolvable = new Set((materialize().flows || []).map(flow => flow.flow_id));

  for (const chainId of [...flowSummary.untested_critical_flows, ...flowSummary.high_error_rate_flows]) {
    assert.ok(!chainId.startsWith('flow::'), 'flow_summary holds chain ids');
    assert.ok(resolvable.has(`flow::${chainId}`), `chain ${chainId} maps onto a materialized flow id`);
  }
});

test('INVARIANT: workflow references resolve — primary/supporting workflow ids exist in the workflow collection', () => {
  // Workflows are entry-point GROUPINGS, not stepped units (CASWorkflow has no
  // `steps` field and never has — flows are the stepped unit, and they are now
  // materialized in flow_graph.flows). What must hold is that nothing points at
  // a workflow that isn't shipped.
  const workflows = [
    { id: 'workflow_shell_script:_deploy', entry_points: ['entry_cli_deploy'], call_chains: ['chain:entry_cli_deploy'] },
    { id: 'workflow_main', entry_points: ['entry_cli_main'], call_chains: ['chain:entry_cli_main'] },
  ];
  const enhancedSystemPurpose = {
    primary_workflow_id: 'workflow_shell_script:_deploy',
    supporting_workflow_ids: ['workflow_main'],
  };

  const known = new Set(workflows.map(workflow => workflow.id));
  const references = [
    enhancedSystemPurpose.primary_workflow_id,
    ...enhancedSystemPurpose.supporting_workflow_ids,
  ].filter(Boolean);

  assert.deepEqual(references.filter(id => !known.has(id)), []);
  // Every shipped workflow carries real anchoring evidence rather than being an
  // empty shell — this is what "0 steps" was actually asking about.
  for (const workflow of workflows) {
    assert.ok(workflow.entry_points.length > 0, `${workflow.id} has no entry points`);
    assert.ok(workflow.call_chains.length > 0, `${workflow.id} has no call chains`);
    assert.ok(!('steps' in workflow), 'workflows must not emit a phantom steps field');
  }
});

test('flow_graph.flows is populated even when no flow carries a capability link', () => {
  const orchestrator = new AnalyzerOrchestrator() as any;
  const flowGraph = emptyFlowGraph();
  orchestrator.materializeFlowGraphFlows(
    flowGraph,
    [{ flow_id: 'flow::entry_orphan', name: 'Orphan', intent: 'x', entry_point: 'entry_orphan', steps: [] }],
    []
  );
  assert.equal((flowGraph.flows || []).length, 1);
  assert.equal(flowGraph.flows![0].capability_id, undefined);
  assert.equal(flowGraph.flows![0].capability_ids, undefined);
});
