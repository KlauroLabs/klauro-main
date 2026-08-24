import test from 'node:test';
import assert from 'node:assert/strict';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import {
  CAS_CHILD_FIELD_POLICY,
  projectCasChild,
  type CASChildProjectedValues,
} from './cas-child-projection';

function projectedValues(): CASChildProjectedValues {
  return {
    nodes: [],
    edges: [],
    entry_points: [],
    exit_points: [],
    method_calls: [],
    call_chains: [],
    security_contexts: [],
    test_suites: [],
    intents: [],
    change_risks: [],
    change_risk_summary: undefined,
    entities: [],
    behavioral_invariants: [],
    behavioral_invariant_summary: undefined,
    security_boundaries: [],
    security_summary: undefined,
    flow_coverage: [],
    test_gaps: [],
    temporal_stability: [],
    stability_summary: undefined,
    capabilities: [],
    flows: [],
    steps: [],
    terminality: undefined,
    behavior_surfaces: [],
    user_journeys: [],
    data_lineage: [],
    flow_graph: undefined,
    runtime_static_links: [],
    analysis_facts: [],
    deployable_evidence: [],
    idiom_violations: [],
    principle_violations: [],
    module_health: undefined,
    communication_seams: undefined,
  };
}

function parentCas(): CASOutput {
  return {
    cas_version: '3.0.0',
    analyzer_build: 'build-1',
    analysis_timestamp: '2026-08-24T00:00:00.000Z',
    analysis_id: 'analysis-root',
    system: { id: 'system-root', name: 'root', type: 'monorepo', root_path: '.' },
    nodes: [{ id: 'root-node', name: 'root', type: 'function' }],
    edges: [],
    external_services: [{ id: 'external', name: 'external', type: 'api' }],
    dependencies: { manager: 'npm', packages: [{ name: 'dependency', version: '1.0.0', direct: true }] },
    libraries: [{ id: 'library', name: 'library', category: 'utility' }],
    configuration: { environment_variables: [], config_files: [] },
    runtime: {},
    coverage_gaps: [],
    analyzer_contributions: [{
      analyzer_id: 'typescript-javascript',
      analyzer_name: 'TypeScript/JavaScript',
      contribution_type: 'language',
    }],
    progressive_levels: { total_levels: 1 },
  } as CASOutput;
}

test('child projection preserves inherited CAS sections and applies scoped fields', () => {
  const parent = parentCas();
  const child = projectCasChild(parent, {
    id: 'child',
    parent_id: 'root',
    label: 'child',
    analysis_id: 'analysis-root:child',
    system: { ...parent.system, id: 'system-child', name: 'child', root_path: 'apps/child' },
  }, projectedValues());

  assert.equal(child.id, 'child');
  assert.equal(child.analysis_id, 'analysis-root:child');
  assert.deepEqual(child.nodes, []);
  assert.equal(child.external_services, parent.external_services);
  assert.equal(child.dependencies, parent.dependencies);
  assert.equal(child.libraries, parent.libraries);
  assert.equal(child.configuration, parent.configuration);
  assert.equal(child.runtime, parent.runtime);
  assert.equal(child.coverage_gaps, parent.coverage_gaps);
  assert.equal(child.analyzer_contributions, parent.analyzer_contributions);
  assert.equal(child.progressive_levels, parent.progressive_levels);
  assert.ok(Object.values(CAS_CHILD_FIELD_POLICY).every(policy => policy.mode.length > 0));
});

test('child projection rejects runtime fields absent from its exhaustive policy', () => {
  const parent = { ...parentCas(), future_cas_section: { value: true } } as CASOutput;
  assert.throws(
    () => projectCasChild(parent, {
      id: 'child',
      parent_id: 'root',
      label: 'child',
      analysis_id: 'analysis-root:child',
      system: parent.system,
    }, projectedValues()),
    /future_cas_section/,
  );
});
