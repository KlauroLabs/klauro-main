import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CiPipelineAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/ci/ci-pipeline-analyzer';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { getCicdPipelines, buildOrientCapsule } from './query';

// Build a CASOutput whose nodes/edges/entry_points come straight from the real
// CiPipelineAnalyzer, so getCicdPipelines is verified against actual emitted
// facts (not a hand-rolled fixture) — it must read, never recompute.
async function analyzedCas(): Promise<CASOutput> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'query-cicd-test-'));
  fs.mkdirSync(path.join(dir, '.github/workflows'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.github/workflows/release.yml'),
    [
      'name: Release',
      'on:',
      '  push:',
      '    tags: ["v*"]',
      '  schedule:',
      '    - cron: "0 2 * * *"',
      'jobs:',
      '  build:',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '      - name: Test',
      '        run: npm test',
      '  deploy:',
      '    needs: build',
      '    environment: production',
      '    steps:',
      '      - name: Deploy',
      '        run: kubectl apply -n production -f k8s/',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(dir, '.gitlab-ci.yml'),
    ['stages:', '  - test', 'unit:', '  stage: test', '  script:', '    - npm test', ''].join('\n'),
  );
  const contribution = await new CiPipelineAnalyzer().analyze({ projectPath: dir });
  return {
    nodes: contribution.nodes,
    edges: contribution.edges,
    entry_points: contribution.entry_points,
    exit_points: contribution.exit_points,
  } as unknown as CASOutput;
}

test('getCicdPipelines assembles pipeline -> job -> step -> trigger -> deploy + job DAG from stored facts', async () => {
  const cas = await analyzedCas();
  const result = getCicdPipelines(cas);

  assert.equal(result.total, 2);
  assert.deepEqual(result.providers.sort(), ['github-actions', 'gitlab-ci']);
  assert.equal(result.inventory.pipelines, 2);
  assert.ok(result.inventory.jobs >= 3);
  assert.ok(result.inventory.steps >= 3);
  assert.ok(result.inventory.deploy_targets >= 1);

  const release = result.pipelines.find(p => p.provider === 'github-actions');
  assert.ok(release, 'github-actions pipeline present');
  // Triggers resolved from entry points (push + schedule).
  const events = release!.triggers.map((t: any) => t.event);
  assert.ok(events.some((e: any) => /push|tags|v\*/.test(String(e))) || release!.triggers.some((t: any) => t.type === 'pipeline'));
  assert.ok(release!.triggers.some((t: any) => t.type === 'schedule'), 'schedule trigger surfaced');
  // Job DAG: deploy depends on build.
  assert.ok(release!.job_dag.some((edge: any) => edge.from === 'deploy' && edge.to === 'build'), 'deploy->build DAG edge');
  const deployJob = release!.jobs.find((j: any) => j.name === 'deploy');
  assert.ok(deployJob, 'deploy job present');
  assert.ok(deployJob!.depends_on.some((d: any) => d.job === 'build'), 'deploy.depends_on includes build');
  assert.deepEqual(deployJob!.needs, ['build']);
  // Steps carry command/action + deploy target.
  const buildJob = release!.jobs.find((j: any) => j.name === 'build');
  assert.ok(buildJob!.steps.some((s: any) => s.action === 'actions/checkout@v4'));
  assert.ok(buildJob!.steps.some((s: any) => s.command === 'npm test'));
  assert.ok(release!.deploy_targets.includes('production'), 'deploy target surfaced on pipeline');
});

test('getCicdPipelines provider + deployOnly filters narrow the set', async () => {
  const cas = await analyzedCas();
  assert.equal(getCicdPipelines(cas, { provider: 'gitlab-ci' }).total, 1);
  const deployOnly = getCicdPipelines(cas, { deployOnly: true });
  assert.ok(deployOnly.pipelines.every((p: any) => p.deploy_targets.length > 0));
  assert.ok(deployOnly.total >= 1);
});

test('getCicdPipelines on a repo with no CI returns an empty, honest shape', () => {
  const cas = { nodes: [], edges: [], entry_points: [] } as unknown as CASOutput;
  const result = getCicdPipelines(cas);
  assert.equal(result.total, 0);
  assert.deepEqual(result.pipelines, []);
});

test('buildOrientCapsule is a cheap pullable-dimension index with counts + tools', async () => {
  const cas = await analyzedCas();
  const capsule = buildOrientCapsule(cas);
  assert.equal(capsule.dimensions.cicd_pipelines.available, true);
  assert.equal(capsule.dimensions.cicd_pipelines.count, 2);
  assert.equal(capsule.dimensions.cicd_pipelines.tool, 'get_cicd_pipelines');
  assert.equal(capsule.dimensions.entry_points.tool, 'get_entry_points');
  // Cheap: the whole capsule stays tiny (index only, no heavy content).
  assert.ok(Buffer.byteLength(JSON.stringify(capsule)) < 2000);
});
