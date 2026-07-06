import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CiPipelineAnalyzer } from './ci-pipeline-analyzer';
import { AnalyzerOrchestrator } from '../../core/orchestrator';

function makeTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-pipeline-analyzer-test-'));
  fs.mkdirSync(path.join(dir, '.github/workflows'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.github/workflows/release.yml'),
    [
      'name: Release',
      'on:',
      '  push:',
      '    tags: ["v*"]',
      '  pull_request:',
      '  schedule:',
      '    - cron: "0 2 * * *"',
      '  workflow_dispatch:',
      'jobs:',
      '  build:',
      '    strategy:',
      '      matrix:',
      '        node: [20, 22]',
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
    ].join('\n')
  );

  fs.writeFileSync(
    path.join(dir, '.gitlab-ci.yml'),
    [
      'stages:',
      '  - test',
      '  - deploy',
      'unit:',
      '  stage: test',
      '  script:',
      '    - npm test',
      'deploy_prod:',
      '  stage: deploy',
      '  needs: ["unit"]',
      '  environment: production',
      '  script:',
      '    - terraform apply -auto-approve',
      '',
    ].join('\n')
  );

  return dir;
}

test('CiPipelineAnalyzer canAnalyze detects checked-in CI config files', async () => {
  const dir = makeTempProject();
  const analyzer = new CiPipelineAnalyzer();
  assert.equal(await analyzer.canAnalyze(dir), true);
});

test('CiPipelineAnalyzer emits pipeline, job, step, trigger, dependency, and deploy-target facts', async () => {
  const dir = makeTempProject();
  const analyzer = new CiPipelineAnalyzer();
  const cas = await analyzer.analyze({ projectPath: dir });

  const pipelines = cas.nodes.filter(node => node.type === 'ci_pipeline');
  const jobs = cas.nodes.filter(node => node.type === 'ci_job');
  const steps = cas.nodes.filter(node => node.type === 'ci_step');
  const deployTargets = cas.nodes.filter(node => node.type === 'deploy_target');

  assert.equal(pipelines.length, 2);
  assert.equal(jobs.length, 4);
  assert.ok(steps.some(step => (step.metadata as any)?.attributes?.command === 'npm test'));
  assert.ok(steps.some(step => (step.metadata as any)?.attributes?.action === 'actions/checkout@v4'));
  assert.ok(deployTargets.some(target => target.name === 'production'));

  const entryTypes = cas.entry_points.map(entry => entry.type);
  assert.ok(entryTypes.includes('pipeline'));
  assert.ok(entryTypes.includes('schedule'));
  assert.ok(cas.entry_points.some(entry => entry.trigger?.schedule === '0 2 * * *'));

  assert.ok(cas.edges.some(edge => edge.type === 'depends_on' && edge.metadata?.dependency === 'build'));
  assert.ok(cas.edges.some(edge => edge.type === 'depends_on' && edge.metadata?.dependency === 'unit'));
  assert.ok(cas.edges.some(edge => edge.type === 'deploys_to'));
  assert.ok(cas.exit_points.some(exit => exit.type === 'sdk' && exit.metadata?.command?.includes('kubectl apply')));

  // The external-service LABEL for a deploy exit point must be the deploy
  // target, never the command-shaped step name (hash-shaped-token-leak class:
  // raw `dotnet pack …` lines must not surface as "connects to <command>").
  const deployExits = cas.exit_points.filter(exit => exit.type === 'sdk' && exit.operation?.action === 'deploy');
  assert.ok(deployExits.length > 0);
  for (const exit of deployExits) {
    assert.equal(exit.target?.sdk, exit.target?.service_id);
    assert.ok(!/\s--?[A-Za-z]|\$[A-Za-z{]/.test(exit.target?.sdk || ''), `command-shaped sdk label: ${exit.target?.sdk}`);
  }
});

test('AnalyzerOrchestrator selection sees hidden CI config files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-pipeline-orchestrator-test-'));
  fs.writeFileSync(
    path.join(dir, '.gitlab-ci.yml'),
    [
      'stages:',
      '  - test',
      'unit:',
      '  stage: test',
      '  script:',
      '    - npm test',
      '',
    ].join('\n')
  );

  const orchestrator = new AnalyzerOrchestrator();
  orchestrator.registerAnalyzer({
    id: 'ci-pipeline',
    name: 'CI/CD Pipeline Analyzer',
    type: 'framework',
    version: '1.0.0',
    detectPatterns: { files: ['.gitlab-ci.yml'] },
    analyzer: new CiPipelineAnalyzer(),
  });

  const output = await orchestrator.orchestrateAnalysis(dir);
  assert.ok(output.nodes.some(node => node.type === 'ci_pipeline'));
  assert.ok(output.analyzer_contributions.some(contribution => contribution.analyzer_id === 'ci-pipeline'));
});
