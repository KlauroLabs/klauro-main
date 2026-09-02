import assert from 'node:assert/strict';
import test from 'node:test';
import { agentStartingPointCount } from './analysis-mastery';

test('agent task proof counts structured orientation starting points', () => {
  assert.equal(agentStartingPointCount({
    entry_points: [{ id: 'entry' }],
    exit_points: [{ id: 'exit' }],
    connected_nodes: [{ id: 'node' }],
    runtime_static_links: [],
  }), 3);
  assert.equal(agentStartingPointCount([]), 0);
  assert.equal(agentStartingPointCount(undefined), 0);
});
