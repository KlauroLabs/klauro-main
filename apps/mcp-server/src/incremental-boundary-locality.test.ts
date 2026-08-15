import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import { createOrchestrator } from './analyzer';
import { compareCasGraphs } from './incremental-graph-equivalence';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.remove(root)));
});

async function workspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-boundary-locality-'));
  roots.push(root);
  await fs.outputJson(path.join(root, 'package.json'), {
    name: 'boundary-locality',
    private: true,
    workspaces: ['packages/*', 'services/*']
  });
  await fs.outputJson(path.join(root, 'packages', 'core', 'package.json'), {
    name: '@workspace/core',
    version: '1.0.0'
  });
  await fs.outputFile(
    path.join(root, 'packages', 'core', 'src', 'index.ts'),
    'export function formatOrder(id: string): string { return `order:${id}`; }\n'
  );
  await fs.outputJson(path.join(root, 'services', 'api', 'package.json'), {
    name: '@workspace/api',
    version: '1.0.0',
    dependencies: { '@workspace/core': 'workspace:*' }
  });
  await fs.outputFile(path.join(root, 'services', 'api', 'Dockerfile'), 'FROM node:22-alpine\nCOPY . .\nCMD ["node", "dist/server.js"]\n');
  await fs.outputFile(
    path.join(root, 'services', 'api', 'src', 'server.ts'),
    'import { formatOrder } from "@workspace/core";\nexport function orderResponse(id: string): string { return formatOrder(id); }\n'
  );
  return root;
}

test('proves package and deployable edit locality with cold graph equivalence', async () => {
  const root = await workspace();
  const orchestrator = createOrchestrator();
  const baseline = await orchestrator.orchestrateAnalysis(root);
  const baselineState = orchestrator.createIncrementalBaseline(root, baseline);

  await fs.appendFile(path.join(root, 'packages', 'core', 'src', 'index.ts'), 'export const orderPrefix = "order";\n');
  const packageEdit = await createOrchestrator().orchestrateIncrementalAnalysis(root, baseline, baselineState);
  const packageCold = await createOrchestrator().orchestrateAnalysis(root);

  assert.equal(packageEdit.wasFullRebuild, false);
  assert.ok(
    packageEdit.changeReport.locality?.affectedPackageRoots?.includes('packages/core'),
    JSON.stringify(packageEdit.output.deployable_evidence)
  );
  assert.ok((packageEdit.changeReport.locality?.reusedFiles || 0) > 0);
  assert.equal(compareCasGraphs(packageEdit.output, packageCold).graph_equivalent, true);

  await fs.appendFile(path.join(root, 'services', 'api', 'src', 'server.ts'), 'export const apiVersion = "v1";\n');
  const deployableEdit = await createOrchestrator().orchestrateIncrementalAnalysis(root, packageEdit.output, packageEdit.state);
  const deployableCold = await createOrchestrator().orchestrateAnalysis(root);

  assert.equal(deployableEdit.wasFullRebuild, false);
  assert.ok(deployableEdit.changeReport.locality?.affectedDeployableRoots?.includes('services/api'));
  assert.ok((deployableEdit.changeReport.locality?.reusedFiles || 0) > 0);
  const deployableParity = compareCasGraphs(deployableEdit.output, deployableCold);
  const changedNodes = deployableParity.graph_difference_sample.map(item => item.match(/^node:([^[]+)/)?.[1]).filter(Boolean);
  const nodeEvidence = changedNodes.map(id => ({
    id,
    incremental: deployableEdit.output.nodes.find(node => node.id === id),
    cold: deployableCold.nodes.find(node => node.id === id)
  }));
  assert.equal(deployableParity.graph_equivalent, true, JSON.stringify({ deployableParity, nodeEvidence }));
});
