import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import * as os from 'node:os';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as fs from 'fs-extra';
import { createOrchestrator } from './analyzer';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => fs.remove(root)));
});

function orderedGraph(output: CASOutput): Record<string, Array<{ id: string }>> {
  const order = <T extends { id: string }>(values: T[] | undefined): T[] =>
    [...(values || [])].sort((left, right) => left.id.localeCompare(right.id));
  return {
    nodes: order(output.nodes),
    edges: order(output.edges),
    entryPoints: order(output.entry_points),
    exitPoints: order(output.exit_points),
  };
}

function graphDifferences(actual: CASOutput, expected: CASOutput): string[] {
  const actualGraph = orderedGraph(actual);
  const expectedGraph = orderedGraph(expected);
  const differences: string[] = [];
  for (const section of Object.keys(actualGraph)) {
    const actualById = new Map(actualGraph[section].map(item => [item.id, item]));
    const expectedById = new Map(expectedGraph[section].map(item => [item.id, item]));
    for (const id of new Set([...actualById.keys(), ...expectedById.keys()])) {
      if (!isDeepStrictEqual(actualById.get(id), expectedById.get(id))) {
        differences.push(`${section}:${id}\nactual=${JSON.stringify(actualById.get(id))}\nexpected=${JSON.stringify(expectedById.get(id))}`);
      }
    }
  }
  return differences;
}

async function fixtureCopy(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-project-refresh-'));
  temporaryRoots.push(root);
  await fs.copy(
    path.join(process.cwd(), 'fixtures', 'analysis-truth', 'rails-work-orders'),
    root
  );
  return root;
}

async function typescriptFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-typescript-project-refresh-'));
  temporaryRoots.push(root);
  await fs.outputFile(path.join(root, 'package.json'), JSON.stringify({ name: 'typescript-refresh-fixture' }));
  await fs.outputFile(path.join(root, 'src', 'service.ts'), [
    'export function loadAccount(id: string) {',
    '  return { id };',
    '}',
    '',
  ].join('\n'));
  await fs.outputFile(path.join(root, 'src', 'handler.ts'), [
    "import { loadAccount } from './service';",
    'export function handleRequest(id: string) {',
    '  return loadAccount(id);',
    '}',
    '',
  ].join('\n'));
  return root;
}

async function expectIncrementalColdEquivalence(
  root: string,
  previous: CASOutput,
  state: ReturnType<ReturnType<typeof createOrchestrator>['createIncrementalBaseline']>
): Promise<{ output: CASOutput; state: typeof state }> {
  const incremental = await createOrchestrator().orchestrateIncrementalAnalysis(root, previous, state);
  assert.equal(incremental.wasFullRebuild, false);
  assert.equal(incremental.changeReport.locality?.strategy, 'project-contribution-refresh');
  assert.ok((incremental.changeReport.locality?.reusedFiles || 0) > 0);
  assert.ok((incremental.changeReport.locality?.reuseRatio || 0) > 0);
  assert.ok((incremental.changeReport.locality?.refreshedProjectAnalyzers?.length || 0) > 0);
  const cold = await createOrchestrator().orchestrateAnalysis(root);
  assert.deepEqual(graphDifferences(incremental.output, cold), []);
  return { output: incremental.output, state: incremental.state };
}

test('project-scoped framework contributions refresh incrementally with cold graph equivalence', async () => {
  const previousAiEnabled = process.env.KLAURO_AI_ENABLED;
  process.env.KLAURO_AI_ENABLED = 'false';
  try {
    const root = await fixtureCopy();
    const orchestrator = createOrchestrator();
    const baseline = await orchestrator.orchestrateAnalysis(root);
    const state = orchestrator.createIncrementalBaseline(root, baseline);
    const controllerPath = path.join(root, 'app', 'controllers', 'work_orders_controller.rb');
    await fs.appendFile(controllerPath, '\n  def archive\n    head :no_content\n  end\n');
    const controllerRefresh = await expectIncrementalColdEquivalence(root, baseline, state);

    const routesPath = path.join(root, 'config', 'routes.rb');
    await fs.appendFile(routesPath, '\n  post "work_orders/:id/archive", to: "work_orders#archive"\n');
    await expectIncrementalColdEquivalence(root, controllerRefresh.output, controllerRefresh.state);
  } finally {
    if (previousAiEnabled === undefined) delete process.env.KLAURO_AI_ENABLED;
    else process.env.KLAURO_AI_ENABLED = previousAiEnabled;
  }
});

test('TypeScript project contributions refresh with cold graph equivalence after a semantic edit', async () => {
  const previousAiEnabled = process.env.KLAURO_AI_ENABLED;
  process.env.KLAURO_AI_ENABLED = 'false';
  try {
    const root = await typescriptFixture();
    const orchestrator = createOrchestrator();
    const baseline = await orchestrator.orchestrateAnalysis(root);
    const state = orchestrator.createIncrementalBaseline(root, baseline);
    await fs.outputFile(path.join(root, 'src', 'service.ts'), [
      'export function findAccount(id: string) {',
      '  return { id };',
      '}',
      '',
    ].join('\n'));
    const incremental = await createOrchestrator().orchestrateIncrementalAnalysis(root, baseline, state);
    const cold = await createOrchestrator().orchestrateAnalysis(root);
    assert.equal(incremental.wasFullRebuild, false);
    assert.equal(incremental.changeReport.locality?.strategy, 'project-contribution-refresh');
    assert.ok(incremental.changeReport.locality?.refreshedProjectAnalyzers?.includes('typescript-javascript'));
    assert.deepEqual(graphDifferences(incremental.output, cold), []);
  } finally {
    if (previousAiEnabled === undefined) delete process.env.KLAURO_AI_ENABLED;
    else process.env.KLAURO_AI_ENABLED = previousAiEnabled;
  }
});

test('an existing CAS is reused when building its first incremental baseline', async () => {
  const previousAiEnabled = process.env.KLAURO_AI_ENABLED;
  process.env.KLAURO_AI_ENABLED = 'false';
  try {
    const root = await typescriptFixture();
    const orchestrator = createOrchestrator();
    const baseline = await orchestrator.orchestrateAnalysis(root);
    Reflect.deleteProperty(baseline, 'analysis_id');
    const incremental = await orchestrator.orchestrateIncrementalAnalysis(root, baseline, null);
    assert.strictEqual(incremental.output, baseline);
    assert.equal(incremental.wasFullRebuild, true);
    assert.equal(incremental.fullRebuildReason, 'No previous analysis state');
  } finally {
    if (previousAiEnabled === undefined) delete process.env.KLAURO_AI_ENABLED;
    else process.env.KLAURO_AI_ENABLED = previousAiEnabled;
  }
});
