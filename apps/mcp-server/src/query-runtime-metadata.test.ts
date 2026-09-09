import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { buildSync } from 'esbuild';
import type { CASOutput, CASChangeRisk } from '../../../packages/analyzer-core/src/types/cas.types';
import { attachAgentRiskSource, buildRiskContextForAgent } from './agent-risk-context';
import { attachScopedReferenceCounts } from './query-call-relationships';
import { rankChangeRisks } from './change-risk-rank';

function separateBundle<T>(name: string): T {
  const output = buildSync({
    stdin: { contents: `export * from ${JSON.stringify(path.join(__dirname, name + '.ts'))};`, resolveDir: __dirname },
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
  });
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', '__dirname', output.outputFiles[0].text)(require, loaded, loaded.exports, __dirname);
  return loaded.exports as T;
}

function risk(id: string, label: string): CASChangeRisk {
  return {
    node_id: id, risk_level: 'critical', risk_factors: [],
    downstream_impact: { direct_callers: [], transitive_callers: [], affected_call_chains: [], affected_entry_points: [] },
    test_protection: { has_direct_tests: true, has_integration_tests: false },
    stability_context: { recent_churn: false, commit_count_30d: 0, bug_fix_density: 0 },
    recommendations: [label],
  };
}

test('separately bundled risk queries retain their own complete ranked source without serializing it', async () => {
  const reader = separateBundle<typeof import('./agent-risk-context')>('agent-risk-context');
  for (const label of ['first-project', 'second-project']) {
    const full = {
      nodes: [{ id: 'n', name: 'Decision', type: 'function', source: { file: 'decision.ts', line: 1 } }],
      edges: [], change_risks: [risk('n', label), risk('outside-slice', label)],
    } as unknown as CASOutput;
    const cas = { ...full, change_risks: [] };
    const before = JSON.stringify(cas);
    attachAgentRiskSource(cas, {
      getIndex: async () => ({ total: full.change_risks!.length, highOrCritical: 2, records: rankChangeRisks(full.change_risks!) }),
      read: async ordinals => new Map(ordinals.map(ordinal => [ordinal, full.change_risks![ordinal]])),
    });
    assert.deepEqual(await reader.buildRiskContextForAgent(cas), await buildRiskContextForAgent(full));
    assert.equal(JSON.stringify(cas), before);
    assert.equal((await reader.buildRiskContextForAgent({ ...cas })).status, 'unavailable');
  }
});

test('separately bundled relationship queries retain target-specific canonical counts', () => {
  const reader = separateBundle<typeof import('./query-call-relationships')>('query-call-relationships');
  const cas = {
    nodes: [{ id: 'n', name: 'Decision', type: 'function' }, { id: 'other', name: 'Other', type: 'function' }],
    edges: [],
  } as unknown as CASOutput;
  const before = JSON.stringify(cas);
  attachScopedReferenceCounts(cas, 'n', { callers: 17, callees: 19, containers: 3, children: 5 });
  assert.deepEqual(reader.getDirectReferenceCounts(cas, 'n'), { callers: 17, callees: 19 });
  const structure = reader.getStructuralContext(cas, 'n');
  assert.equal(structure.containers_total, 3);
  assert.equal(structure.children_total, 5);
  assert.equal(structure.truncated, true);
  assert.deepEqual(reader.getDirectReferenceCounts(cas, 'other'), { callers: 0, callees: 0 });
  assert.deepEqual(reader.getDirectReferenceCounts({ ...cas }, 'n'), { callers: 0, callees: 0 });
  attachScopedReferenceCounts(cas, 'n', { callers: 2, callees: 4, containers: 0, children: 0 });
  assert.deepEqual(reader.getDirectReferenceCounts(cas, 'n'), { callers: 2, callees: 4 });
  assert.equal(JSON.stringify(cas), before);
});
