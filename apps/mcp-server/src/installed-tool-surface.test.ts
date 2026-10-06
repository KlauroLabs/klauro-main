import test from 'node:test';
import assert from 'node:assert/strict';
import { constrainToInstalledTools } from './installed-tool-surface';

test('step lists keep installed tools in order and renumber', () => {
  const steps = [
    { order: 1, tool: 'get_agent_start_context' },
    { order: 2, tool: 'preflight_agent_change' },
    { order: 3, tool: 'assess_change_risk' },
  ];
  assert.deepEqual(constrainToInstalledTools({ steps }).steps, [
    { order: 1, tool: 'get_agent_start_context' },
    { order: 2, tool: 'assess_change_risk' },
  ]);
});

test('tool-name lists, detail tools and suggested tools drop unregistered names', () => {
  const result = constrainToInstalledTools({
    answers: [{ follow_up_tools: ['search_nodes', 'get_callers'] }],
    seams: { detail_tool: 'get_communication_seams', detail_tools: ['get_product_map', 'get_communication_seams'] },
    description: { suggested_tool: { tool: 'generate_element_description', args: {} } },
  });
  assert.deepEqual(result.answers[0].follow_up_tools, ['search_nodes']);
  assert.equal('detail_tool' in result.seams, false);
  assert.deepEqual(result.seams.detail_tools, ['get_product_map']);
  assert.equal(result.description.suggested_tool, null);
});
