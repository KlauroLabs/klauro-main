import test from 'node:test';
import assert from 'node:assert/strict';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { getAgentStartContext } from './agent-adoption';
import { resolveStartFocus } from './agent-start-focus';

function fixture(): CASOutput {
  return {
    cas_version: '1.11.0',
    analysis_timestamp: '2026-01-01T00:00:00.000Z',
    analysis_id: 'focus',
    system: { name: 'Studio', type: 'application', description: 'Design studio', root_path: '/repo/studio', technologies: { languages: [{ name: 'TypeScript', percentage: 100 }], frameworks: [], databases: [] } },
    nodes: [
      { id: 'app', name: 'App', type: 'component', source: { file: 'app/src/App.tsx', line: 1 } },
      { id: 'view', name: 'DesignView', type: 'component', source: { file: 'app/src/components/DesignView.tsx', line: 3 } },
      { id: 'edit', name: 'applyEdit', type: 'function', source: { file: 'app/src/components/DesignEdit.tsx', line: 9 } },
      { id: 'store', name: 'saveDesign', type: 'function', source: { file: 'app/src/store.ts', line: 4 } },
    ],
    edges: [
      { id: 'e1', source: 'view', target: 'edit', type: 'calls' },
      { id: 'e2', source: 'edit', target: 'store', type: 'calls' },
      { id: 'e3', source: 'app', target: 'view', type: 'calls' },
    ],
    entry_points: [
      { id: 'entry:app', name: 'App', type: 'ui', source_node: 'app', trigger: {} },
      { id: 'entry:edit', name: 'edit design', type: 'ui', source_node: 'view', trigger: {} },
    ],
    exit_points: [
      { id: 'exit:ls', name: 'localStorage', type: 'client_storage', source_node: 'app' },
      { id: 'exit:save', name: 'design.json', type: 'file', source_node: 'store' },
    ],
    capabilities: [
      { id: 'cap:design', name: 'Edit designs', description: 'Design mode edit capabilities for canvases', category: 'core', criticality: 'high', operations: [] },
      { id: 'cap:chat', name: 'Chat with agents', description: 'Converse', category: 'core', criticality: 'high', operations: [] },
    ],
    flows: [
      { flow_id: 'flow:edit', name: 'Edit a design', intent: 'apply an edit in design mode', entry_point: 'entry:edit', entities: [], contract: {}, steps: [{ step_id: 's1', order: 1, name: 'apply', description: '', description_source: 'ai', contract: {}, functions: [{ function_id: 'edit' }], entities: [] }] },
    ],
    analyzer_contributions: [],
  } as unknown as CASOutput;
}

test('related paths resolve to their nodes and unknown paths are reported as not in the analysis', () => {
  const focus = resolveStartFocus(fixture(), { related_paths: ['app/src/components/DesignView.tsx', 'packages/design-harness/src/edit/engine.mjs'] });
  assert.ok(focus);
  const [held, absent] = focus.related_paths;
  assert.equal(held.status, 'in-analysis');
  assert.deepEqual(held.nodes.map(node => node.id), ['view']);
  assert.equal(absent.status, 'not-in-analysis');
  assert.match(absent.note || '', /committed snapshot/);
  assert.equal(focus.status, 'partially-resolved');
  assert.ok(focus.gaps.some(gap => gap.startsWith('packages/design-harness/src/edit/engine.mjs')));
});

test('absolute related paths and directories resolve against the analyzed root', () => {
  const focus = resolveStartFocus(fixture(), { related_paths: ['/repo/studio/app/src/components'] });
  assert.equal(focus?.related_paths[0].node_count, 2);
});

test('the target resolves against capabilities, flows, and nodes and narrows entries, exits, and connections', () => {
  const focus = resolveStartFocus(fixture(), { target: 'Design Mode edit capabilities' });
  assert.ok(focus?.target);
  assert.deepEqual(focus.target.capabilities.map(capability => capability.id), ['cap:design']);
  assert.deepEqual(focus.target.flows.map(flow => flow.flow_id), ['flow:edit']);
  assert.ok(focus.entry_points.some(entry => entry.id === 'entry:edit'));
  assert.ok(focus.exit_points.some(exit => exit.id === 'exit:save'));
  assert.ok(focus.connected_nodes.some(node => node.id === 'app'));
  assert.equal(focus.exit_points.some(exit => exit.id === 'exit:ls'), false);
});

test('a task with neither target nor paths has no focus and an unmatched target is unresolved with a gap', () => {
  assert.equal(resolveStartFocus(fixture(), {}), null);
  const focus = resolveStartFocus(fixture(), { target: 'zzzz qqqq' });
  assert.equal(focus?.status, 'unresolved');
  assert.equal(focus?.gaps.length, 1);
});

test('start context replaces system-wide starting points with the focused ones in every profile', () => {
  for (const response_profile of ['standard', 'minimal', 'first-turn', 'capsule-only'] as const) {
    const withoutFlows = { ...fixture(), flows: undefined } as unknown as CASOutput;
    const context: any = getAgentStartContext(withoutFlows, '/repo/studio', {
      task_type: 'modify',
      target: 'Design Mode edit capabilities',
      related_paths: ['app/src/components/DesignView.tsx', 'packages/design-harness/src/edit/engine.mjs'],
      response_profile,
    });
    assert.equal(context.starting_points.scope, 'task-focused', response_profile);
    assert.ok(context.starting_points.entry_points.some((entry: any) => entry.id === 'entry:edit'), response_profile);
    assert.equal(context.focus.related_paths[1].status, 'not-in-analysis', response_profile);
  }
});
