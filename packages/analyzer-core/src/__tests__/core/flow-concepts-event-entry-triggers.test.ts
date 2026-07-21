import { computeFlowConcepts } from '../../analyzer/core/flow-concepts';
import type {
  CASOutput,
  CASNode,
  CASEdge,
  CASEntryPoint,
  CASExitPoint,
} from '../../types/cas.types';

/**
 * flow-quality lane regression (see docs/SPEC-CONCEPTUAL-LAYER.md, Flow/Step):
 * user-reported bug — flows render ONE step each with raw-token names.
 *
 * Root cause reproduced here: a JSX/template event-entry point (onClick={...})
 * is rooted at the ENCLOSING COMPONENT's node (react/vue/angular/svelte-
 * analyzer.ts never set `handler` on these — see react-analyzer.ts's
 * eventHandlers loop), with only a `triggers` edge connecting the entry to the
 * NAMED handler function it resolved. Both call-chain builders (orchestrator.ts
 * buildCallChains' relationshipTypes set and flow-concepts.ts's
 * buildTraversalIndex TRAVERSABLE_EDGE_TYPES) used to omit 'triggers' from the
 * traversable edge set, so this BFS/traceForwardChain walk could never step
 * past the component into the resolved handler — segmentIntoStepsByRole then
 * had exactly one node to segment, producing the reported one-step flow
 * regardless of how much real logic the handler contains.
 *
 * Fixture: AddMemberButton (component, the entry's own node) --[triggers]-->
 * addMember (handler) --[calls]--> validateMember --[calls]--> saveMember
 * --[calls]--> notifyTeam. Three further callees beyond the entry's own node,
 * each grounding a distinct step role (validate/persist/call_external).
 */
function node(overrides: Partial<CASNode> & { id: string; name: string; type: string }): CASNode {
  return {
    qualified_name: overrides.name,
    ...overrides,
  } as CASNode;
}

function buildEventEntryCas(): CASOutput {
  const nodes: CASNode[] = [
    node({ id: 'n_AddMemberButton', name: 'AddMemberButton', type: 'component', category: 'presentation' }),
    node({ id: 'n_addMember', name: 'addMember', type: 'function', category: 'business' }),
    node({ id: 'n_validateMember', name: 'validateMember', type: 'function', category: 'business' }),
    node({ id: 'n_saveMember', name: 'saveMember', type: 'function', category: 'data' }),
    node({ id: 'n_notifyTeam', name: 'notifyTeam', type: 'function', category: 'business' }),
  ];

  const edges: CASEdge[] = [
    { id: 'e_trigger', source: 'n_AddMemberButton', target: 'n_addMember', type: 'triggers' },
    { id: 'e1', source: 'n_addMember', target: 'n_validateMember', type: 'calls' },
    { id: 'e2', source: 'n_validateMember', target: 'n_saveMember', type: 'calls' },
    { id: 'e3', source: 'n_saveMember', target: 'n_notifyTeam', type: 'calls' },
  ];

  const entry_points: CASEntryPoint[] = [
    {
      id: 'ep_addMember_click',
      source_node: 'n_AddMemberButton',
      type: 'event',
      name: 'AddMemberButton click',
      trigger: { pattern: 'click' },
      // No `handler` — mirrors react-analyzer.ts's JSX event-entry creation,
      // which never sets it. metadata.handler_name is the real fact carried
      // instead (component/event/handler_name/jsx_line — see react-analyzer.ts).
      metadata: { component: 'AddMemberButton', event: 'click', handler_name: 'addMember', jsx_line: 42 },
    } as CASEntryPoint,
  ];

  const exit_points: CASExitPoint[] = [
    {
      id: 'xp_saveMember',
      source_node: 'n_saveMember',
      type: 'database',
      name: 'saveMember',
      target: { resource: 'members_table' },
    } as CASExitPoint,
    {
      id: 'xp_notifyTeam',
      source_node: 'n_notifyTeam',
      type: 'webhook',
      name: 'notifyTeam',
      target: { service_id: 'slack-webhook' },
    } as CASExitPoint,
  ];

  return {
    cas_version: '1.0.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'test',
    system: { name: 'test-system' } as any,
    nodes,
    edges,
    entry_points,
    exit_points,
    data_lineage: [],
    data_entities: [],
    system_capabilities: [],
    analyzer_contributions: [],
  } as unknown as CASOutput;
}

describe('event-entry chains traverse resolved handlers via `triggers` edges', () => {
  const cas = buildEventEntryCas();
  const flows = computeFlowConcepts(cas);

  test('produces one flow for the click entry point', () => {
    expect(flows.length).toBe(1);
  });

  test('3+-callee handler yields a multi-step ordered flow, not a single-node chain', () => {
    const flow = flows[0];
    // Before the `triggers` traversal fix, this chain would dead-end at
    // n_AddMemberButton (depth 0, no exit on that node) and yield a single
    // generic 'process' step with no functions past the entry's own node.
    expect(flow.steps.length).toBeGreaterThan(1);
    const allFunctionIds = flow.steps.flatMap(s => s.functions.map(f => f.function_id));
    expect(allFunctionIds).toEqual(
      expect.arrayContaining(['n_addMember', 'n_validateMember', 'n_saveMember', 'n_notifyTeam'])
    );
    const orders = flow.steps.map(s => s.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    // no honest "single step, no role boundary" gap once real segmentation ran
    expect((flow.gaps || []).some(g => /classified as a single step/i.test(g))).toBe(false);
  });

  test('segments by role across the resolved handler chain', () => {
    const flow = flows[0];
    const names = flow.steps.map(s => s.name);
    expect(names.some(n => /validate|member/i.test(n))).toBe(true);
    expect(names.some(n => /persist|member/i.test(n))).toBe(true);
    expect(names.some(n => /call|slack/i.test(n))).toBe(true);
  });

  test('verb-headed name from the purposeful resolved handler, not the component/event scaffolding', () => {
    const flow = flows[0];
    // Purpose-derived from metadata.handler_name ("addMember") via the same
    // deterministic word-splitting every other flow-name branch uses — not
    // "Add Member Button Click" (component+event) and never the raw entry id.
    expect(flow.name).toBe('Add Member');
  });
});
