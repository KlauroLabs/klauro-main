import test from 'node:test';
import assert from 'node:assert/strict';
import type { CASOutput, FlowConcept } from '../../../packages/analyzer-core/src/types/cas.types';
import { getFlowConcepts } from './query';

/**
 * THE FLOW WINDOW WAS THE PRODUCT (P0).
 *
 * /conceptual defaulted to 20 flows with a hard ceiling of 50 and NO offset —
 * so on a repo with 276/457/169 derivable flows, flow #51+ was unreachable by
 * any parameter, and the endpoint's own truncation hint told callers the
 * remedy was "max_flows (bounded, max 50)": a remedy capped at the same number
 * as the complaint. Worse, the window was filled in derivation order, which
 * correlates with SHALLOW — measured on real stored analyses the first 50
 * flows averaged 1.1-2.2 steps against 2.2-3.5 over the full set, and every
 * flow-quality metric anyone measured was measuring the window, not the
 * product.
 *
 * This suite pins the contract that replaced it: the page is RANKED before it
 * is truncated, `offset` reaches the rest, and the hint names a mechanism that
 * actually works.
 */
function buildPagedCas(flowCount: number): CASOutput {
  const nodes: any[] = [];
  const entry_points: any[] = [];
  const exit_points: any[] = [];
  const call_chains: any[] = [];
  const flows: FlowConcept[] = [];

  for (let i = 0; i < flowCount; i++) {
    // Deliberately inverted: the LOWEST index (which derivation reaches first,
    // since chain ids sort ascending) is the SHALLOWEST flow — derivation
    // order is the worst possible order, which is exactly the defect.
    const stepCount = i + 1;
    const id = String(i).padStart(3, '0');
    nodes.push({ id: `n_${id}`, name: `handler${id}`, type: 'controller', qualified_name: `handler${id}`, category: 'entry', structural_importance: 0.5 });
    entry_points.push({
      id: `ep_${id}`, source_node: `n_${id}`, type: 'http', name: `route${id}`,
      trigger: { method: 'GET', path: `/r/${id}` },
      handler: { node_id: `n_${id}`, method_name: `handler${id}` },
    });
    exit_points.push({ id: `xp_${id}`, source_node: `n_${id}`, type: 'api', name: `respond${id}`, target: { resource: `res_${id}` } });
    call_chains.push({
      id: `chain_${id}`,
      chain_type: 'entry-to-exit',
      entry_point: { node_id: `n_${id}`, method_name: `handler${id}`, entry_point_id: `ep_${id}` },
      exit_point: { node_id: `n_${id}`, method_name: `respond${id}`, exit_point_id: `xp_${id}` },
      call_path: [{ call_id: `c_${id}`, node_id: `n_${id}`, method_name: `handler${id}`, depth: 0 }],
      characteristics: {
        total_calls: 1, max_depth: 1, has_external_calls: false, has_database_calls: false,
        has_async_calls: false, is_circular: false, is_recursive: false, complexity_score: 1,
      },
      risk_analysis: { risk_level: 'low', risk_factors: [] },
    });
    flows.push({
      flow_id: `flow::chain_${id}`,
      name: `Route ${id}`,
      intent: `serve /r/${id}`,
      entry_point: `ep_${id}`,
      criticality: 'low',
      entities: [],
      contract: { input: [], logic: `serve /r/${id}`, side_effects: { state_changes: [], external_integrations: [] }, output: [`res_${id}`], constraints: [] },
      steps: Array.from({ length: stepCount }, (_, stepIndex) => ({
        step_id: `flow::chain_${id}::step${stepIndex}`,
        order: stepIndex,
        name: `Step ${stepIndex}`,
        description: `Executes step ${stepIndex} for route ${id}`,
        description_source: 'deterministic-label',
        contract: { input: [], logic: `step ${stepIndex}`, side_effects: { state_changes: [], external_integrations: [] }, output: [], constraints: [] },
        functions: [{ function_id: `n_${id}` }],
        entities: [],
      })),
      terminus: { exit_point_id: `xp_${id}`, kind: 'api', produces: `res_${id}`, node_id: `n_${id}` },
    });
  }

  return {
    analysis_id: 'test-flow-pagination',
    nodes, edges: [], entry_points, exit_points, call_chains,
    flows,
    flow_graph: {
      capability_candidates: [], dependencies: [],
      topology: { root_capabilities: [], leaf_capabilities: [], critical_path: [], max_depth: 0 },
    },
  } as unknown as CASOutput;
}

test('the default page is ranked, not derivation-ordered — the deepest flows come first', () => {
  // 20 flows so every step_count (1..20) stays distinct under the rank's
  // depth cap — the ranked order is then a strict reversal of derivation order.
  const cas = buildPagedCas(20);
  const page = getFlowConcepts(cas, { maxFlows: 5 }) as any;
  assert.equal(page.returned, 5);
  // Ranked: deepest first. Derivation order would have returned
  // chain_000..chain_004, which are the SHALLOWEST five in this fixture.
  assert.deepEqual(
    page.flows.map((f: any) => f.flow_id),
    ['flow::chain_019', 'flow::chain_018', 'flow::chain_017', 'flow::chain_016', 'flow::chain_015']
  );
  assert.ok(
    page.flows.every((f: any) => f.steps.length >= 1),
    'every returned flow must still derive real steps'
  );
});

test('page 2 returns different flows than page 1 and the union is the total', () => {
  const cas = buildPagedCas(40);
  const page1 = getFlowConcepts(cas, { maxFlows: 20, offset: 0 }) as any;
  const page2 = getFlowConcepts(cas, { maxFlows: 20, offset: page1.next_offset }) as any;

  assert.equal(page1.offset, 0);
  assert.equal(page1.next_offset, 20);
  assert.equal(page1.truncated, true);
  assert.equal(page1.total_available, 40);

  assert.equal(page2.offset, 20);
  assert.equal(page2.truncated, false, 'last page must not claim there is more');
  assert.equal(page2.next_offset, undefined, 'next_offset is omitted on the last page');

  const ids1 = page1.flows.map((f: any) => f.flow_id);
  const ids2 = page2.flows.map((f: any) => f.flow_id);
  assert.equal(ids1.filter((id: string) => ids2.includes(id)).length, 0, 'pages must be disjoint');
  assert.equal(new Set([...ids1, ...ids2]).size, 40, 'the union of all pages must be the whole flow set');
});

test('walking offset to exhaustion reaches every flow — there IS a page 2 (and 3, and 4)', () => {
  const cas = buildPagedCas(40);
  const seen: string[] = [];
  let offset = 0;
  let pages = 0;
  for (;;) {
    const page = getFlowConcepts(cas, { maxFlows: 7, offset }) as any;
    seen.push(...page.flows.map((f: any) => f.flow_id));
    pages++;
    assert.ok(pages <= 20, 'paging must terminate');
    if (page.next_offset === undefined) break;
    offset = page.next_offset;
  }
  assert.equal(new Set(seen).size, 40);
  assert.equal(seen.length, 40, 'no flow is returned twice across pages');
});

test('the truncation hint names a mechanism that actually works', () => {
  const cas = buildPagedCas(40);
  const page1 = getFlowConcepts(cas, { maxFlows: 10, surface: 'http' }) as any;
  const hint = (page1.gaps || []).find((g: string) => g.startsWith('Showing '));
  assert.ok(hint, 'a truncated response must carry a truncation hint');
  // The OLD hint said "max_flows (bounded, max 50)" — a remedy capped at the
  // same number as the complaint, with no page 2 in existence.
  assert.ok(!/max 50/.test(hint), 'the hint must not advertise the old capped remedy');
  assert.ok(hint.includes(`offset=${page1.next_offset}`), 'the hint must name the offset that reaches the next page');

  // And that mechanism must actually work when followed verbatim.
  const next = getFlowConcepts(cas, { maxFlows: 10, offset: page1.next_offset, surface: 'http' }) as any;
  assert.equal(next.returned, 10);
  const ids1 = new Set(page1.flows.map((f: any) => f.flow_id));
  assert.equal(next.flows.filter((f: any) => ids1.has(f.flow_id)).length, 0);
});

test('paging is deterministic — the same page request is byte-identical across runs', () => {
  const cas = buildPagedCas(40);
  const a = JSON.stringify(getFlowConcepts(cas, { maxFlows: 10, offset: 10 }));
  const b = JSON.stringify(getFlowConcepts(buildPagedCas(40), { maxFlows: 10, offset: 10 }));
  assert.equal(a, b);
});

test('an offset the response cannot honor is reported, never silently applied', () => {
  const cas = buildPagedCas(40);
  // A targeted lookup has no stable global rank order to page through.
  const targeted = getFlowConcepts(cas, { target: '/r/003', offset: 10 }) as any;
  assert.equal(targeted.offset, 0);
  assert.ok((targeted.gaps || []).some((g: string) => g.startsWith('offset ignored')));
});

test('total_available is the exact flow count, not an entry-point upper bound', () => {
  const cas = buildPagedCas(40);
  const page = getFlowConcepts(cas, { maxFlows: 5 }) as any;
  assert.equal(page.total_available, 40);
  assert.equal(page.ranking.startsWith('significance:'), true);
});
