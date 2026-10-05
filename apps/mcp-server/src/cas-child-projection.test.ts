import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compactCasSourceInputIdentities } from '../../../packages/analyzer-core/src/analyzer/core/cas-source-input-identities';
import { sourceInputObservation } from '../../../packages/analyzer-core/src/analyzer/core/analyzer-source-inputs';
import { buildAgentContextFreshness } from './agent-context-freshness';
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
    causal_journeys: [],
    data_lineage: [],
    flow_graph: undefined,
    runtime_static_links: [],
    analysis_facts: [],
    deployable_evidence: [],
    idiom_violations: [],
    principle_violations: [],
    module_health: undefined,
    communication_seams: undefined,
      units: undefined,
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

test('child and grandchild references keep their original source namespace', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-source-child-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const childRoot = path.join(root, 'apps', 'child');
  const grandRoot = path.join(childRoot, 'grand');
  fs.mkdirSync(grandRoot, { recursive: true });
  const parent = parentCas();
  parent.system.root_path = root;
  const observations = [['shared.ts', 'parent'], ['apps/child/shared.ts', 'child'], ['apps/child/grand/shared.ts', 'grand']];
  for (const [file, content] of observations) fs.writeFileSync(path.join(root, file), content);
  parent.analyzer_contributions[0].source_inputs = {
    version: 1, coverage: 'observed-reads', digest_algorithm: 'sha256', outside_root_reads: 0,
    files: observations.map(([file, content]) => ({ path: file, ...sourceInputObservation(content, 'utf8') })),
  };
  compactCasSourceInputIdentities(parent);
  const child = projectCasChild(parent, {
    id: 'child', parent_id: 'root', label: 'child', analysis_id: 'analysis:child',
    system: { ...parent.system, root_path: 'apps/child' },
  }, projectedValues());
  const grandchild = projectCasChild(child, {
    id: 'grand', parent_id: 'child', label: 'grand', analysis_id: 'analysis:grand',
    system: { ...child.system, root_path: 'apps/child/grand' },
  }, projectedValues());
  for (const [cas, workspace] of [[child, childRoot], [grandchild, grandRoot]] as const) {
    assert.equal(cas.source_input_identities, parent.source_input_identities);
    assert.equal(cas.source_input_root, root);
    const context = { table: cas.source_input_identities, root_path: cas.source_input_root, current_root: cas.system.root_path };
    const before = buildAgentContextFreshness(parent.analysis_timestamp, workspace, ['shared.ts'], 'shared.ts',
      cas.analyzer_contributions, context);
    assert.equal(before.summary.source_input_comparison.matched.count, 1);
    fs.writeFileSync(path.join(workspace, 'shared.ts'), 'parent');
    const after = buildAgentContextFreshness(parent.analysis_timestamp, workspace, ['shared.ts'], 'shared.ts',
      cas.analyzer_contributions, context);
    assert.equal(after.summary.source_input_comparison.mismatched.count, 1);
  }
});

test('a legacy raw child gets an explicit origin without rewriting its parent evidence', () => {
  const parent = parentCas();
  parent.analyzer_contributions[0].source_inputs = {
    version: 1, coverage: 'observed-reads', digest_algorithm: 'sha256', outside_root_reads: 0,
    files: [{ path: 'apps/child/file.ts', ...sourceInputObservation('child', 'utf8') }],
  };
  const child = projectCasChild(parent, {
    id: 'child', parent_id: 'root', label: 'child', analysis_id: 'analysis:child',
    system: { ...parent.system, root_path: 'apps/child' },
  }, projectedValues());
  assert.equal(child.source_input_root, '.');
  assert.equal(parent.source_input_root, undefined);
  assert.equal(child.analyzer_contributions, parent.analyzer_contributions);
});

test('partial legacy projections without contribution metadata remain queryable', () => {
  const parent = parentCas();
  delete (parent as Partial<CASOutput>).analyzer_contributions;
  const child = projectCasChild(parent, {
    id: 'child', parent_id: 'root', label: 'child', analysis_id: 'analysis:child',
    system: { ...parent.system, root_path: 'apps/child' },
  }, projectedValues());
  assert.equal(child.source_input_root, undefined);
  assert.equal(child.analyzer_contributions, undefined);
  assert.deepEqual(child.nodes, []);
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
