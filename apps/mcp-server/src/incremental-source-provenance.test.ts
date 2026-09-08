import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { createOrchestrator } from './analyzer';
import { compareCasGraphs } from './incremental-graph-equivalence';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';

function sourceInputs(cas: CASOutput) {
  return {
    identities: cas.source_input_identities,
    catalog: cas.source_input_catalog,
    root: cas.source_input_root,
    contributors: cas.analyzer_contributions.map(contribution => ({
      id: contribution.analyzer_id, source_inputs: contribution.source_inputs,
    })),
  };
}

test('incremental refresh preserves fresh observed identities instead of old shared rows', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-source-provenance-'));
  try {
    await fs.outputJson(path.join(root, 'package.json'), { name: 'source-provenance', version: '1.0.0' });
    const file = path.join(root, 'src/index.ts');
    await fs.outputFile(file, 'export function produce(value: string): string { return value; }\n');
    const orchestrator = createOrchestrator();
    const baseline = await orchestrator.orchestrateAnalysis(root);
    const original = JSON.stringify(sourceInputs(baseline));
    const state = orchestrator.createIncrementalBaseline(root, baseline);
    await fs.outputFile(file, 'export function produce(value: string): string { return value.trim(); }\n');
    const incremental = await createOrchestrator().orchestrateIncrementalAnalysis(root, baseline, state);
    const cold = await createOrchestrator().orchestrateAnalysis(root);
    assert.equal(incremental.wasFullRebuild, false);
    const parity = compareCasGraphs(incremental.output, cold);
    assert.equal(parity.graph_equivalent, true, JSON.stringify(parity));
    assert.deepEqual(sourceInputs(incremental.output), sourceInputs(cold));
    assert.equal(JSON.stringify(sourceInputs(baseline)), original);
  } finally {
    await fs.remove(root);
  }
});

test('an analyzer with observed inputs but no previous facts discovers newly added behavior', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-source-dependency-'));
  try {
    await fs.outputJson(path.join(root, 'package.json'), {
      name: 'source-dependency', dependencies: { koa: '^2.14.0', '@koa/router': '^12.0.0' },
    });
    const file = path.join(root, 'routes.ts');
    const source = "import Router from '@koa/router';\nconst router = new Router();\nfunction listItems() {}\n";
    await fs.outputFile(file, source);
    const orchestrator = createOrchestrator();
    const baseline = await orchestrator.orchestrateAnalysis(root);
    assert.equal(baseline.entry_points?.some(entry => entry.trigger?.path === '/items'), false);
    const state = orchestrator.createIncrementalBaseline(root, baseline);
    await fs.outputFile(file, source + "router.get('/items', listItems);\n");
    const incremental = await createOrchestrator().orchestrateIncrementalAnalysis(root, baseline, state);
    const cold = await createOrchestrator().orchestrateAnalysis(root);
    const routes = (cas: CASOutput) => (cas.entry_points || [])
      .filter(entry => entry.type === 'http')
      .map(entry => ({ method: entry.trigger?.method, path: entry.trigger?.path })).sort((a, b) => String(a.path).localeCompare(String(b.path)));
    assert.equal(incremental.wasFullRebuild, false);
    assert.deepEqual(routes(cold), [{ method: 'get', path: '/items' }]);
    assert.deepEqual(routes(incremental.output), routes(cold));
    const parity = compareCasGraphs(incremental.output, cold);
    assert.equal(parity.graph_equivalent, true, JSON.stringify(parity));
    assert.deepEqual(sourceInputs(incremental.output), sourceInputs(cold));
  } finally {
    await fs.remove(root);
  }
});
