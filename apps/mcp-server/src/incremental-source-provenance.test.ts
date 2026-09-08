import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { createOrchestrator } from './analyzer';
import { sourceInputIdentityAt } from '../../../packages/analyzer-core/src/analyzer/core/cas-source-input-identities';
import { sourceInputObservation } from '../../../packages/analyzer-core/src/analyzer/core/analyzer-source-inputs';
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

test('file-scoped analyzers discover their first route and preserve it across repeated incremental edits', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-file-scope-inputs-'));
  try {
    await fs.outputFile(path.join(root, 'requirements.txt'), 'fastapi\n');
    const file = path.join(root, 'app.py');
    const source = 'from fastapi import FastAPI\napp = FastAPI()\n';
    await fs.outputFile(file, source);
    const orchestrator = createOrchestrator();
    const baseline = await orchestrator.orchestrateAnalysis(root);
    const original = JSON.stringify(sourceInputs(baseline));
    assert.equal(baseline.entry_points?.some(entry => entry.trigger?.path === '/healthz'), false);
    let previous = baseline;
    let state = orchestrator.createIncrementalBaseline(root, baseline);
    for (const value of ['True', 'False']) {
      await fs.outputFile(file, source + '@app.get("/healthz")\ndef healthz():\n    return {"ok": ' + value + '}\n');
      const result = await createOrchestrator().orchestrateIncrementalAnalysis(root, previous, state);
      const cold = await createOrchestrator().orchestrateAnalysis(root);
      assert.equal(result.wasFullRebuild, false, result.fullRebuildReason);
      assert.ok(result.output.entry_points?.some(entry => entry.trigger?.path === '/healthz'));
      const parity = compareCasGraphs(result.output, cold);
      assert.equal(parity.graph_equivalent, true, JSON.stringify({ value, parity,
        actualModule: result.output.nodes.find(node => node.id === 'module_app'),
        coldModule: cold.nodes.find(node => node.id === 'module_app') }));
      for (const id of ['python', 'fastapi']) {
        const inputs = result.output.analyzer_contributions.find(item => item.analyzer_id === id)?.source_inputs;
        assert.ok(inputs);
        assert.equal(inputs.coverage, 'observed-reads', id);
        const identities = inputs.version === 1 ? inputs.files : inputs.identity_indices.map(index =>
          sourceInputIdentityAt(result.output.source_input_identities, index));
        assert.deepEqual(identities.find(identity => identity?.path === 'app.py'), {
          path: 'app.py', ...sourceInputObservation(await fs.readFile(file, 'utf8'), 'utf8'),
        });
      }
      for (const contribution of previous.analyzer_contributions) {
        if (contribution.source_inputs?.coverage !== 'observed-reads') continue;
        assert.equal(result.output.analyzer_contributions.find(item => item.analyzer_id === contribution.analyzer_id)
          ?.source_inputs?.coverage, 'observed-reads', contribution.analyzer_id);
      }
      previous = result.output;
      state = result.state;
    }
    assert.equal(JSON.stringify(sourceInputs(baseline)), original);
  } finally {
    await fs.remove(root);
  }
});

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
