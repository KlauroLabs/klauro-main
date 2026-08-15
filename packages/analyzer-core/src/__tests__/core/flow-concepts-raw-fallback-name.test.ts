import { computeFlowConcepts } from '../../analyzer/core/flow-concepts';
import type { CASOutput, CASNode, CASCallChain } from '../../types/cas.types';

/**
 * flow-quality lane regression: raw-token flow names ("Handles
 * entry_apps_app_src_main_tsx_App_addMember_10_91766548") reported live.
 * buildTerminalFlows names a flow from the resolved entry_point (verb-headed,
 * see flow-concepts-event-entry-triggers.test.ts) whenever `entry_point_id`
 * resolves against cas.entry_points — but a terminal call_chain can reference
 * an entry_point_id the current entry_points array no longer carries (a stale
 * chain snapshot, or an entry that was pruned/renamed since the chain was
 * computed). The ONLY previous fallback for that case was
 * `titleize(chain.entry_point.method_name)`, a bare title-case with no
 * cleanup — so if that raw method_name is itself an analyzer-generated,
 * path-and-id-shaped token (rather than a plain function name), it leaked
 * straight into the UI verbatim. This asserts the fallback now runs through
 * `cleanRawFallbackName`: path prefix and trailing index/hash noise stripped,
 * remaining real words title-cased — never the raw token, never empty.
 */
function node(overrides: Partial<CASNode> & { id: string; name: string; type: string }): CASNode {
  return { qualified_name: overrides.name, ...overrides } as CASNode;
}

function buildStaleChainCas(): CASOutput {
  const nodes: CASNode[] = [
    node({ id: 'n_addMember', name: 'addMember', type: 'function', category: 'business' }),
  ];

  // No entry_points at all: entry_point_id below cannot resolve, forcing the
  // titleize/cleanRawFallbackName fallback branch in buildTerminalFlows.
  const call_chains: CASCallChain[] = [
    {
      id: 'chain:entry_event_entry_apps_app_src_main_tsx_App_addMember_10_91766548',
      chain_type: 'entry-to-exit',
      entry_point: {
        node_id: 'n_addMember',
        // The raw, analyzer-generated, path-and-id-shaped token as reported live.
        method_name: 'entry_apps_app_src_main_tsx_App_addMember_10_91766548',
        entry_point_id: 'entry_event_entry_apps_app_src_main_tsx_App_addMember_10_91766548',
      },
      exit_point: { node_id: 'n_addMember', method_name: 'save', exit_point_id: 'xp_save' },
      call_path: [
        { call_id: 'entry:x', node_id: 'n_addMember', method_name: 'addMember', depth: 0 },
      ],
      characteristics: {
        total_calls: 0,
        max_depth: 0,
        has_external_calls: false,
        has_database_calls: false,
        has_async_calls: false,
        is_circular: false,
        is_recursive: false,
        complexity_score: 0,
      },
    } as CASCallChain,
  ];

  return {
    cas_version: '1.0.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'test',
    system: { name: 'test-system' } as any,
    nodes,
    edges: [],
    entry_points: [],
    exit_points: [
      { id: 'xp_save', source_node: 'n_addMember', type: 'database', name: 'save', target: { resource: 'members_table' } },
    ],
    data_lineage: [],
    entities: [],
    capabilities: [],
    analyzer_contributions: [],
    call_chains,
  } as unknown as CASOutput;
}

describe('raw-token fallback name cleanup', () => {
  test('cleans path/id noise instead of surfacing the raw token verbatim', () => {
    const flows = computeFlowConcepts(buildStaleChainCas());
    expect(flows.length).toBe(1);
    const name = flows[0].name;
    expect(name).not.toMatch(/entry_apps_app_src_main_tsx/);
    expect(name).not.toMatch(/91766548/);
    expect(name).not.toMatch(/^entry_/);
    expect(name).not.toMatch(/_/); // no leftover underscore-joined raw segments
    // real word tokens survive, title-cased (component + handler name)
    expect(name).toBe('App Add Member');
  });
});
