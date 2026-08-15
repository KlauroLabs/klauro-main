import { computeFlowConcepts } from '../../analyzer/core/flow-concepts';
import type {
  CASOutput,
  CASNode,
  CASEdge,
  CASEntryPoint,
  CASExitPoint,
} from '../../types/cas.types';

/**
 * flow-quality lane regression (quality-iter-1 defects #2/#3 — see
 * flow-concepts.ts: groupEventVariantEntryPoints, dedupeAdjacentWords):
 *
 *   #2 — N DOM/UI event bindings (wheel/click/mouseEnter/drag/…) that all
 *   resolve to the SAME handler function used to surface as N near-identical
 *   templated flows ("Handle <event> -> clampZoom" x 6). They should collapse
 *   into ONE flow named for the shared EFFECT, carrying every distinct
 *   trigger in `triggers`.
 *
 *   #3 — a name template's own prefix landing on a resolved token that
 *   already carries the same word ("Schedule" + an entity/verb token that
 *   already reads "Scheduled Scan") used to double up into "Schedule
 *   Scheduled Scan" instead of collapsing the adjacent repeat.
 */
function node(overrides: Partial<CASNode> & { id: string; name: string; type: string }): CASNode {
  return {
    qualified_name: overrides.name,
    ...overrides,
  } as CASNode;
}

describe('event-variant flow collapse (defect #2)', () => {
  function buildGraphCanvasCas(): CASOutput {
    const nodes: CASNode[] = [
      node({ id: 'n_GraphCanvas', name: 'GraphCanvas', type: 'component', category: 'presentation' }),
      node({ id: 'n_clampZoom', name: 'clampZoom', type: 'function', category: 'business' }),
    ];

    const edges: CASEdge[] = [
      { id: 'e_wheel', source: 'n_GraphCanvas', target: 'n_clampZoom', type: 'triggers' },
    ];

    // Six distinct DOM bindings on the SAME component, all resolved (via
    // metadata.handler_name, same as react-analyzer.ts stamps) to the
    // IDENTICAL clampZoom handler — the reported flooding shape.
    const triggerPatterns = ['wheel', 'click', 'mouseEnter', 'mouseLeave', 'drag', 'dblclick'];
    const entry_points: CASEntryPoint[] = triggerPatterns.map((pattern, i) => ({
      id: `ep_canvas_${pattern}`,
      source_node: 'n_GraphCanvas',
      type: 'event',
      name: `GraphCanvas ${pattern}`,
      trigger: { pattern },
      handler: { node_id: 'n_clampZoom', method_name: 'clampZoom' },
      metadata: { component: 'GraphCanvas', event: pattern, handler_name: 'clampZoom', jsx_line: 10 + i },
    } as CASEntryPoint));

    const exit_points: CASExitPoint[] = [];

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
      entities: [],
      capabilities: [],
      analyzer_contributions: [],
    } as unknown as CASOutput;
  }

  const cas = buildGraphCanvasCas();
  const flows = computeFlowConcepts(cas);

  test('collapses 6 event-variant bindings on the same handler into ONE flow', () => {
    expect(flows.length).toBe(1);
  });

  test('the collapsed flow carries every distinct trigger', () => {
    expect(flows[0].triggers).toEqual(
      ['click', 'dblclick', 'drag', 'mouseEnter', 'mouseLeave', 'wheel'].sort()
    );
  });

  test('the flow is named for the effect, not any one DOM event', () => {
    expect(flows[0].name).toBe('Clamp Zoom');
    expect(flows[0].name.toLowerCase()).not.toContain('wheel');
    expect(flows[0].name.toLowerCase()).not.toContain('click');
  });
});

describe('distinct-effect event handlers stay distinct flows', () => {
  function buildCas(): CASOutput {
    const nodes: CASNode[] = [
      node({ id: 'n_Canvas', name: 'Canvas', type: 'component', category: 'presentation' }),
      node({ id: 'n_clampZoom', name: 'clampZoom', type: 'function', category: 'business' }),
      node({ id: 'n_panCanvas', name: 'panCanvas', type: 'function', category: 'business' }),
    ];
    const edges: CASEdge[] = [
      { id: 'e1', source: 'n_Canvas', target: 'n_clampZoom', type: 'triggers' },
      { id: 'e2', source: 'n_Canvas', target: 'n_panCanvas', type: 'triggers' },
    ];
    const entry_points: CASEntryPoint[] = [
      {
        id: 'ep_wheel', source_node: 'n_Canvas', type: 'event', name: 'Canvas wheel',
        trigger: { pattern: 'wheel' },
        handler: { node_id: 'n_clampZoom', method_name: 'clampZoom' },
        metadata: { handler_name: 'clampZoom' },
      } as CASEntryPoint,
      {
        id: 'ep_drag', source_node: 'n_Canvas', type: 'event', name: 'Canvas drag',
        trigger: { pattern: 'drag' },
        handler: { node_id: 'n_panCanvas', method_name: 'panCanvas' },
        metadata: { handler_name: 'panCanvas' },
      } as CASEntryPoint,
    ];
    return {
      cas_version: '1.0.0',
      analysis_timestamp: new Date().toISOString(),
      analysis_id: 'test',
      system: { name: 'test-system' } as any,
      nodes, edges, entry_points, exit_points: [],
      data_lineage: [], entities: [], capabilities: [], analyzer_contributions: [],
    } as unknown as CASOutput;
  }

  test('different handlers (genuinely different effects) never collapse', () => {
    const flows = computeFlowConcepts(buildCas());
    expect(flows.length).toBe(2);
    expect(flows.every(f => !f.triggers)).toBe(true);
  });
});

describe('adjacent repeated-token dedupe in name assembly (defect #3)', () => {
  function buildScheduledCas(): CASOutput {
    // A cron-triggered entry point whose OWN resolved handler name already
    // carries "Scheduled Scan" — the case that used to double up into
    // "Schedule Scheduled Scan" once the schedule-flow prefix combined with
    // the already-descriptive handler token.
    const nodes: CASNode[] = [
      node({ id: 'n_scheduledScan', name: 'scheduledScan', type: 'function', category: 'business' }),
    ];
    const entry_points: CASEntryPoint[] = [
      {
        id: 'ep_cron_scan', source_node: 'n_scheduledScan', type: 'schedule', name: 'scheduled_scheduled_scan',
        trigger: { schedule: '0 * * * *' },
        handler: { node_id: 'n_scheduledScan', method_name: 'scheduledScan' },
        metadata: { handler_name: 'scheduled_scheduled_scan' },
      } as CASEntryPoint,
    ];
    return {
      cas_version: '1.0.0',
      analysis_timestamp: new Date().toISOString(),
      analysis_id: 'test',
      system: { name: 'test-system' } as any,
      nodes, edges: [], entry_points, exit_points: [],
      data_lineage: [], entities: [], capabilities: [], analyzer_contributions: [],
    } as unknown as CASOutput;
  }

  test('adjacent duplicate words collapse to one occurrence in the flow name', () => {
    const flows = computeFlowConcepts(buildScheduledCas());
    expect(flows.length).toBe(1);
    expect(flows[0].name).toBe('Scheduled Scan');
    // never the un-deduped triple/doubled form the raw handler token implied.
    expect(flows[0].name).not.toMatch(/scheduled\s+scheduled/i);
  });

  test('non-adjacent repeats are left alone (only back-to-back dupes collapse)', () => {
    // "Order Order Service" (adjacent) collapses; "Order Service Order"
    // (non-adjacent) must not lose its second, legitimately-placed "Order".
    const nodes: CASNode[] = [
      node({ id: 'n_h', name: 'h', type: 'function', category: 'business' }),
    ];
    const entry_points: CASEntryPoint[] = [
      {
        id: 'ep_x', source_node: 'n_h', type: 'event', name: 'x',
        trigger: {},
        handler: { node_id: 'n_h', method_name: 'h' },
        metadata: { handler_name: 'order_service_order' },
      } as CASEntryPoint,
    ];
    const cas = {
      cas_version: '1.0.0',
      analysis_timestamp: new Date().toISOString(),
      analysis_id: 'test',
      system: { name: 'test-system' } as any,
      nodes, edges: [], entry_points, exit_points: [],
      data_lineage: [], entities: [], capabilities: [], analyzer_contributions: [],
    } as unknown as CASOutput;
    const flows = computeFlowConcepts(cas);
    expect(flows[0].name).toBe('Order Service Order');
  });
});
