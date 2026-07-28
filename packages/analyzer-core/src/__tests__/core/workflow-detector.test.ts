import { WorkflowDetector } from '../../analyzer/core/workflow-detector';
import { CASEntryPoint, CASNode } from '../../types/cas.types';

// Regression tests for quality-iter-1 #8: 141/384 workflows shipped with
// generic, purpose-less names ("Thing", "Do Thing", "Claw", "Check") because
// (a) an mcp-tool-registration-analyzer.test.ts / .integration.test.ts
// fixture string like `server.registerTool('do_thing', ...)` was promoted to
// a real business workflow, and (b) the pathless entry-point naming branch
// took only the FIRST meaningful word of a compound name ("check_collision"
// -> "check"), merging unrelated real tools under one junk label.

function mcpEntryPoint(partial: Partial<CASEntryPoint> & { id: string; name: string }): CASEntryPoint {
  return {
    source_node: partial.source_node || `node_${partial.id}`,
    type: partial.type || 'message',
    ...partial,
  } as CASEntryPoint;
}

describe('WorkflowDetector: fixture/test-sourced entry points never become workflows', () => {
  it('does not emit a workflow for an entry point whose handler lives in a *.test.ts file', () => {
    const detector = new WorkflowDetector();
    const entryPoints: CASEntryPoint[] = [
      mcpEntryPoint({
        id: 'entry_mcp_tool_claw',
        name: 'claw',
        handler: {
          node_id: 'node_claw',
          method_name: 'claw',
          file: 'packages/analyzer-core/src/analyzer/libraries/mcp-tool-registration-analyzer.test.ts',
        },
      }),
    ];
    const workflows = detector.detectWorkflows(entryPoints, [], [], []);
    expect(workflows.find(w => w.id === 'workflow_claw')).toBeUndefined();
    expect(workflows.length).toBe(0);
  });

  it('does not emit a workflow for an entry point whose handler lives under a fixtures/ directory', () => {
    const detector = new WorkflowDetector();
    const entryPoints: CASEntryPoint[] = [
      mcpEntryPoint({
        id: 'entry_mcp_tool_describe',
        name: 'describe',
        handler: {
          node_id: 'node_describe',
          method_name: 'describe',
          file: 'apps/mcp-server/fixtures/primitive-bench/callers/kotlin/unrelated.kt',
        },
      }),
    ];
    const workflows = detector.detectWorkflows(entryPoints, [], [], []);
    expect(workflows.length).toBe(0);
  });
});

describe('WorkflowDetector: pathless entry-point naming keeps full specificity', () => {
  it('keeps two distinct compound-named tools in separate, specifically-named workflows instead of merging into one bare-noun group', () => {
    const detector = new WorkflowDetector();
    const entryPoints: CASEntryPoint[] = [
      mcpEntryPoint({
        id: 'entry_check_collision',
        name: 'check_collision',
        handler: { node_id: 'node_check_collision', method_name: 'check_collision', file: 'apps/mcp-server/src/server.ts' },
      }),
      mcpEntryPoint({
        id: 'entry_check_conceptual_conflicts',
        name: 'check_conceptual_conflicts',
        handler: { node_id: 'node_check_conceptual_conflicts', method_name: 'check_conceptual_conflicts', file: 'apps/mcp-server/src/server.ts' },
      }),
    ];
    const workflows = detector.detectWorkflows(entryPoints, [], [], []);

    // Neither tool collapses into a bare "Check" workflow.
    expect(workflows.find(w => w.name === 'Check')).toBeUndefined();
    expect(workflows.find(w => w.id === 'workflow_check')).toBeUndefined();

    const names = workflows.map(w => w.name).sort();
    expect(names).toEqual(['Check Collision', 'Check Conceptual Conflicts']);
  });
});

describe('WorkflowDetector: bare-noun groups with no anchor evidence are dropped, not shipped as junk', () => {
  it('drops a single-word-named group when no call chain touches an entity/service or reaches an exit point', () => {
    const detector = new WorkflowDetector();
    const entryPoints: CASEntryPoint[] = [
      mcpEntryPoint({
        id: 'entry_mystery',
        name: 'mystery',
        handler: { node_id: 'node_mystery', method_name: 'mystery', file: 'src/real-product-file.ts' },
      }),
    ];
    // No call chains at all -> no entities/services/exit points -> no anchor evidence.
    const workflows = detector.detectWorkflows(entryPoints, [], [], []);
    expect(workflows.length).toBe(0);
  });

  it('keeps a single-word-named group when its call chain reaches a real exit point (has anchor evidence)', () => {
    const detector = new WorkflowDetector();
    const entryPoints: CASEntryPoint[] = [
      mcpEntryPoint({
        id: 'entry_orders',
        name: 'orders',
        handler: { node_id: 'node_orders', method_name: 'orders', file: 'src/real-product-file.ts' },
      }),
    ];
    const nodes: CASNode[] = [];
    const callChains = [{
      id: 'chain_orders',
      entry_point: { entry_point_id: 'entry_orders' },
      call_path: [],
      exit_point: { exit_point_id: 'exit_db_orders_save' },
      characteristics: {},
    }] as any;
    const workflows = detector.detectWorkflows(entryPoints, callChains, nodes, []);
    expect(workflows.find(w => w.name === 'Orders')).toBeTruthy();
  });
});
