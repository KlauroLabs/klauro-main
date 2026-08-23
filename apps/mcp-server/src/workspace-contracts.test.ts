import assert from 'node:assert/strict';
import test from 'node:test';
import type { CrossCodebaseSystemGraph } from './cross-codebase-analysis';
import { selectWorkspaceCrossRepoContracts } from './workspace-contracts';

test('workspace contract projection preserves normalized provider/consumer evidence and pagination', () => {
  const graph = {
    id: 'workspace-1', name: 'Checkout', generated_at: '2026-08-23T00:00:00.000Z', codebase_count: 2,
    codebases: [
      { id: 'web', name: 'Web', path: '/web' },
      { id: 'api', name: 'API', path: '/api' },
    ],
    applications: [
      { id: 'web-app', name: 'Web app' },
      { id: 'api-app', name: 'API app' },
    ],
    interfaces: [
      { id: 'request', codebase_id: 'web', application_id: 'web-app', kind: 'http-api', role: 'consumer', mode: 'sync', name: 'GET /orders', key: 'GET /orders', refs: [], evidence: [{ kind: 'exit_point', id: 'exit-1', confidence: 1 }] },
      { id: 'route', codebase_id: 'api', application_id: 'api-app', kind: 'http-api', role: 'provider', mode: 'sync', name: 'GET /orders', key: 'GET /orders', refs: [], evidence: [{ kind: 'entry_point', id: 'entry-1', confidence: 1 }] },
    ],
    links: [{ id: 'link-1', kind: 'http-call', mode: 'sync', source_interface_id: 'request', target_interface_id: 'route', source_codebase_id: 'web', target_codebase_id: 'api', source_application_id: 'web-app', target_application_id: 'api-app', confidence: 1, evidence_quality: 'source-backed', evidence: ['route match'] }],
    workspace_workflows: [{ id: 'flow-1' }, { id: 'flow-2' }],
    unmatched_interfaces: [{ interface_id: 'unknown' }],
    validation: { known_unknowns: ['one unresolved interface'] },
    quality_flags: [],
  } as unknown as CrossCodebaseSystemGraph;

  const result = selectWorkspaceCrossRepoContracts(graph, { limit: 1, journey_limit: 1 });
  assert.equal(result.repository_count, 2);
  assert.equal(result.repositories[0].consumes[0].id, 'request');
  assert.equal(result.repositories[1].provides[0].id, 'route');
  assert.equal(result.contract_table[0].consumer_repository, 'Web');
  assert.equal(result.contract_table[0].provider_repository, 'API');
  assert.equal(result.contract_table[0].consumer_interface?.evidence[0].id, 'exit-1');
  assert.equal(result.journeys.length, 1);
  assert.equal(result.pagination.journeys_total, 2);
  assert.equal(result.pagination.next_offset, 1);
});
