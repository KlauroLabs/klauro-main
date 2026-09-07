import test from 'node:test';
import assert from 'node:assert/strict';
import type { CASOutput, CASNode, CASChangeRisk } from '../../../packages/analyzer-core/src/types/cas.types';
import { attachAgentRiskSource, buildRiskContextForAgent, type AgentRiskIndex } from './agent-risk-context';
import { rankChangeRisks } from './change-risk-rank';
import { attachCasProjection } from './cas-projection';
import { getSystemOverview } from './query';
import { evaluateAgentReadiness } from './agent-adoption';

function risk(id: string, level: CASChangeRisk['risk_level'] = 'high'): CASChangeRisk {
  return {
    node_id: id, risk_level: level, risk_factors: [],
    downstream_impact: { direct_callers: [], transitive_callers: [], affected_call_chains: [], affected_entry_points: [] },
    test_protection: { has_direct_tests: true, has_integration_tests: false },
    stability_context: { recent_churn: false, commit_count_30d: 0, bug_fix_density: 0 },
    recommendations: [id + ':' + level],
  };
}

function fixture(count = 100): CASOutput {
  return {
    cas_version: '3.0.0', analysis_id: 'risk-context', analysis_timestamp: '2026-09-07T00:00:00Z',
    system: { id: 'risk-context', name: 'Risk context', type: 'service', root_path: '/repo' },
    nodes: Array.from({ length: count }, (_, i) => ({
      id: 'n' + i, name: 'Node' + i, type: 'function',
      source: { file: i < 60 ? 'src/selected.ts' : 'src/other.ts', line: i + 1 },
    } as CASNode)), edges: [], analyzer_contributions: [],
    change_risks: [...Array.from({ length: count }, (_, i) => risk('n' + i)), risk('ghost', 'critical')],
    change_risk_summary: { high_risk_nodes: ['n95', 'n99'], untested_critical_paths: [], recent_hotspots: [] },
  } as unknown as CASOutput;
}

function indexed(cas: CASOutput) {
  const risks = cas.change_risks || [];
  const projected = { ...cas, change_risks: [] };
  const reads: number[][] = [];
  const index: AgentRiskIndex = {
    total: risks.length,
    highOrCritical: risks.filter(row => row.risk_level === 'high' || row.risk_level === 'critical').length,
    records: rankChangeRisks(risks),
  };
  attachAgentRiskSource(projected, {
    getIndex: async () => index,
    read: async ordinals => {
      reads.push([...ordinals]);
      return new Map([...ordinals].reverse().map(ordinal => [ordinal, risks[ordinal]]));
    },
  });
  return { projected, reads, index };
}

test('indexed risk context excludes the exact file scope past 32 rows and retains global and missing-node risks', async () => {
  const cas = fixture();
  const before = JSON.stringify(cas);
  const { projected, reads } = indexed(cas);
  const options = { targetNode: cas.nodes[0], files: ['/repo/src/selected.ts'], limit: 6 };
  const result = await buildRiskContextForAgent(projected, options);
  assert.deepEqual(result, await buildRiskContextForAgent(cas, options));
  assert.deepEqual(result.top_risks.map(row => row.node_id), ['n0', 'n1', 'n2', 'n3', 'n4', 'n5']);
  assert.deepEqual(result.repo_top_risks.map(row => row.node_id), ['ghost', 'n95', 'n99', 'n60', 'n61', 'n62']);
  assert.equal(result.repo_top_risks[0].name, 'ghost');
  assert.equal(result.repo_top_risks[0].file, null);
  assert.equal(result.summary.total_high_risk_nodes, 2);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].length, 12);
  assert.equal(projected.change_risks.length, 0);
  assert.equal(JSON.stringify(cas), before);
});

test('risk selection preserves summary tie precedence and duplicate-node first/last semantics', async () => {
  const cas = fixture(2);
  cas.change_risks = [risk('n0', 'low'), risk('n1', 'medium'), risk('n0', 'critical')];
  cas.change_risk_summary = undefined;
  const background = await buildRiskContextForAgent(indexed(cas).projected);
  assert.deepEqual(background.repo_top_risks.map(row => row.recommendations[0]), ['n1:medium', 'n0:low']);
  const target = await buildRiskContextForAgent(indexed(cas).projected, { targetNode: cas.nodes[0] });
  assert.deepEqual(target.target_risk?.recommendations, ['n0:critical']);
  cas.change_risk_summary = { high_risk_nodes: ['n0'], untested_critical_paths: [], recent_hotspots: [] };
  const priority = await buildRiskContextForAgent(indexed(cas).projected);
  assert.deepEqual(priority.repo_top_risks.map(row => row.recommendations[0]), ['n0:critical', 'n1:medium']);
});

test('target text retains first original ordinal rather than the highest ranked match', async () => {
  const cas = fixture(2);
  cas.change_risks = [risk('n0', 'low'), risk('n0', 'critical')];
  const result = await buildRiskContextForAgent(indexed(cas).projected, { target: 'Node0' });
  assert.deepEqual(result.target_risk?.recommendations, ['n0:low']);
});

test('indexed totals remain complete and query-local even with no loaded risk rows', async () => {
  const one = fixture(1), two = fixture(5);
  one.change_risk_summary = undefined;
  two.change_risk_summary = undefined;
  const [a, b] = await Promise.all([
    buildRiskContextForAgent(indexed(one).projected),
    buildRiskContextForAgent(indexed(two).projected),
  ]);
  assert.equal(a.summary.total_high_risk_nodes, 2);
  assert.equal(b.summary.total_high_risk_nodes, 6);
  assert.equal(a.status, 'ready');
  assert.equal((await buildRiskContextForAgent({ ...one, change_risks: [] })).status, 'unavailable');
});

test('incomplete indexes, duplicate ordinals and missing requested evidence fail explicitly', async () => {
  for (const defect of ['partial', 'duplicate', 'missing', 'mismatched'] as const) {
    const cas = fixture(3);
    const { projected, index } = indexed(cas);
    if (defect === 'partial') index.total++;
    if (defect === 'duplicate') index.records = index.records.map((row, i) => i ? row : { ...row, ordinal: index.records[1].ordinal });
    if (defect === 'missing' || defect === 'mismatched') attachAgentRiskSource(projected, {
      getIndex: async () => index,
      read: async ordinals => defect === 'missing' ? new Map() : new Map(ordinals.map(ordinal => [ordinal, risk('wrong')])),
    });
    await assert.rejects(buildRiskContextForAgent(projected), /Agent risk (index|source)/, defect);
  }
});

test('facts and runtime-link counts use pinned totals without fabricating loaded rows', () => {
  const cas = fixture(3);
  const projected = attachCasProjection({ ...cas, analysis_facts: [], runtime_static_links: [] }, {
    loaded_sections: ['graph', 'tests', 'quality', 'comprehension', 'runtime', 'supplemental'],
    node_count: cas.nodes.length, edge_count: 0,
    collection_totals: { analysis_facts: 41234, runtime_static_links: 17890 },
  });
  const summary = getSystemOverview(projected);
  assert.equal(summary.analysis_facts_count, 41234);
  assert.equal(summary.runtime_static_links_count, 17890);
  const readiness = evaluateAgentReadiness(projected, '/repo');
  assert.equal(readiness.gates.find(row => row.id === 'evidence')?.detail, '41234 analysis facts');
  assert.match(readiness.gates.find(row => row.id === 'runtime-correlation')!.detail, /(?:^|observed )17890 runtime static links$/);
  assert.equal(projected.analysis_facts!.length, 0);
  assert.equal(projected.runtime_static_links!.length, 0);
});
