import test from 'node:test';
import assert from 'node:assert/strict';
import { WORKSPACE_MEMBER_REFERENCE_FIELDS, workspaceMemberReference } from './workspace-member-reference';

test('a workspace member reference keeps composition identity and drops member bulk', () => {
  const cas: any = {
    id: 'member', composition_mode: 'composed',
    cas_version: '1.11.0', analysis_id: 'member-analysis', analysis_timestamp: '2026-01-01T00:00:00.000Z',
    derived_fingerprint: 'fp', ai_enrichment: 'ready', layers_ready: { complete: true, layers: [] },
    system: { id: 'member', name: 'Member', type: 'service', root_path: '/tmp/member' },
    nodes: [{ id: 'node', name: 'run', type: 'function', level: 1, file: 'src/run.ts' }],
    edges: [],
    dependencies: [{ name: 'express', version: '4' }],
    capabilities: [{ id: 'capability', name: 'Health', operations: [] }],
    entities: [{ id: 'entity', name: 'Order' }],
    analyzer_contributions: [],
    analysis_facts: Array.from({ length: 5 }, (_, index) => ({ id: `fact-${index}` })),
    exit_points: [{ id: 'exit' }],
    entry_points: [{ id: 'entry' }],
    change_risks: [{ id: 'risk' }],
    runtime_static_links: [{ id: 'link' }],
    intents: [{ id: 'intent' }],
    flows: [{ id: 'flow' }],
    steps: [{ id: 'step' }],
    children: [{ id: 'nested', parent_id: 'member', cas_version: '1.11.0', analysis_id: 'nested', analysis_timestamp: '2026-01-01T00:00:00.000Z', system: { name: 'nested' }, nodes: [], edges: [] }],
  };
  const reference: any = workspaceMemberReference({ path: '/tmp/member', name: 'member', cas }, 'codebase-1');
  assert.equal(reference.id, 'workspace:codebase-1');
  assert.equal(reference.analysis_id, 'member-analysis');
  assert.deepEqual(reference.nodes, cas.nodes);
  assert.equal(reference.dependencies, cas.dependencies);
  assert.equal(reference.capabilities?.[0]?.name, 'Health');
  assert.equal(reference.entities?.[0]?.name, 'Order');
  assert.equal(reference.children?.length, 1);
  assert.equal(reference.children?.[0]?.parent_id, reference.id);
  for (const field of ['analysis_facts', 'exit_points', 'entry_points', 'change_risks', 'runtime_static_links', 'intents', 'flows', 'steps']) {
    assert.equal(field in reference, false, `member reference must not carry ${field}`);
  }
  for (const field of ['nodes', 'edges', 'dependencies', 'children', 'capabilities', 'entities', 'system', 'layers_ready']) {
    assert.ok((WORKSPACE_MEMBER_REFERENCE_FIELDS as readonly string[]).includes(field));
  }
});
