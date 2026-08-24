import assert from 'node:assert';
import test from 'node:test';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import {
  CAS_SECTION_NAMES,
  createCasSectionManifest,
  hydrateCasSections,
  parseCasSectionNames,
  selectExactCasSection,
  selectCasSections,
  CAS_SECTION_PROFILES,
  validateCasTreeProjection,
} from './cas-sections';
import { getCallers, getFileNodes, getNode, searchNodes } from './query';

function fixtureCas(): CASOutput {
  return {
    cas_version: '1.11.0',
    analysis_id: 'analysis-sections',
    analysis_timestamp: '2026-07-22T00:00:00.000Z',
    system: { name: 'sections', type: 'service' },
    nodes: [{ id: 'n1', name: 'run', type: 'function', level: 1, file: 'src/run.ts' }],
    edges: [{ id: 'e1', source: 'n1', target: 'n1', type: 'calls' }],
    method_calls: [{ caller_id: 'n1', caller_node: 'n1', target_node: 'n1', call_details: { method_name: 'run' } }],
    analysis_facts: [{ id: 'f1', subject_id: 'n1', kind: 'test' }],
    capabilities: [{ id: 'c1', name: 'Run analysis' }],
    test_summary: { total: 1 },
    runtime_static_links: [{ node_id: 'n1' }],
    risks: [{ id: 'r1', title: 'Risk' }],
    analyzer_contributions: [],
    progressive_levels: [],
  } as unknown as CASOutput;
}

test('section hydration preserves the exact logical CAS object', () => {
  const cas = fixtureCas();
  const manifest = createCasSectionManifest(cas);
  const hydrated = hydrateCasSections(
    manifest.sections.map(section => selectExactCasSection(cas, section.name)),
  );
  assert.deepStrictEqual(hydrated, cas);
  assert.deepStrictEqual(manifest.logical_fields, Object.keys(cas).sort());
});

test('targeted graph hydration excludes heavy unrelated sections', () => {
  const selected = selectCasSections(fixtureCas(), ['graph']);
  assert.ok(selected.nodes);
  assert.ok(selected.edges);
  assert.ok(selected.system);
  assert.strictEqual(selected.method_calls, undefined);
  assert.strictEqual(selected.analysis_facts, undefined);
  assert.strictEqual(selected.runtime_static_links, undefined);
});

test('tree hydration carries recursive children without loading the parent graph', () => {
  const child = {
    ...fixtureCas(),
    id: 'cas:child',
    parent_id: 'cas:root',
    label: 'child',
    analysis_id: 'analysis-child',
  };
  const cas = {
    ...fixtureCas(),
    id: 'cas:root',
    parent_id: null,
    label: 'root',
    composition_mode: 'composed' as const,
    children: [child],
  };
  const selected = selectCasSections(cas, CAS_SECTION_PROFILES.tree);
  assert.deepStrictEqual(selected.children, [child]);
  assert.equal(selected.id, 'cas:root');
  assert.equal(selected.nodes, undefined);
});

test('section parser rejects unknown names and deduplicates valid names', () => {
  assert.deepStrictEqual(parseCasSectionNames('graph,calls,graph'), ['graph', 'calls']);
  assert.throws(() => parseCasSectionNames('graph,__proto__'), /Unknown CAS section/);
  assert.deepStrictEqual(parseCasSectionNames(CAS_SECTION_NAMES.join(',')), CAS_SECTION_NAMES);
});

test('recursive section references reject malformed topology before artifact reads', () => {
  const section = { name: 'identity' as const, fields: ['id'], bytes: 1, file: 'identity.json', sha256: 'a' };
  const valid = {
    format: 'recursive-cas-section-references' as const,
    version: 2 as const,
    root_id: 'root',
    nodes: [
      { id: 'root', parent_id: null, child_ids: ['child'], logical_fields: ['children', 'id'], sections: [section] },
      { id: 'child', parent_id: 'root', child_ids: [], logical_fields: ['id'], sections: [section] },
    ],
  };
  assert.doesNotThrow(() => validateCasTreeProjection(valid));
  assert.throws(() => validateCasTreeProjection({ ...valid, nodes: [valid.nodes[0]] }), /missing child/);
  assert.throws(() => validateCasTreeProjection({
    ...valid,
    nodes: [valid.nodes[0], { ...valid.nodes[1], parent_id: 'other' }],
  }), /has parent other instead of root/);
  assert.throws(() => validateCasTreeProjection({
    ...valid,
    nodes: [...valid.nodes, { ...valid.nodes[1] }],
  }), /duplicate id child/);
});

test('section-hydrated MCP query answers equal full-CAS answers', () => {
  const cas = fixtureCas();
  const graph = selectCasSections(cas, CAS_SECTION_PROFILES.graph_search) as CASOutput;
  const detail = selectCasSections(cas, CAS_SECTION_PROFILES.node_detail) as CASOutput;
  const calls = selectCasSections(cas, CAS_SECTION_PROFILES.call_graph) as CASOutput;
  assert.deepStrictEqual(searchNodes(graph, 'run'), searchNodes(cas, 'run'));
  assert.deepStrictEqual(getFileNodes(graph, 'src/run.ts'), getFileNodes(cas, 'src/run.ts'));
  assert.deepStrictEqual(getNode(detail, 'n1'), getNode(cas, 'n1'));
  assert.deepStrictEqual(getCallers(calls, 'n1'), getCallers(cas, 'n1'));
});
