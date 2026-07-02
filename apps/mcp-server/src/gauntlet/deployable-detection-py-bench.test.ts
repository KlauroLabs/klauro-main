/**
 * Deployable-detection bench for Python / Ruby / PHP — disjoint from
 * deployable-detection-bench.test.ts (Rust/Node/Go/Next fixtures owned by
 * other agents in the same breadth fan-out). Runs through the SAME product
 * path (analyzeForBench + buildCrossCodebaseSystemGraph), blackbox, no engine
 * internals, no AI/model env — see deployable-detection-bench.ts header.
 *
 * FIXTURE MATRIX (apps/mcp-server/fixtures/deployable-detection/):
 *   1. python-service — FastAPI app (app/main.py `app = FastAPI()`) + a
 *      console_scripts CLI entry + a single Dockerfile. EXPECT 1 deployable.
 *   2. rails-app — Rails app (config.ru + bin/rails) + a single Dockerfile.
 *      EXPECT 1 deployable.
 *   3. laravel-app — Laravel app (artisan + public/index.php front
 *      controller) + a single Dockerfile. EXPECT 1 deployable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { analyzeForBench } from './product-analysis';
import { buildCrossCodebaseSystemGraph, type CrossCodebaseInput } from '../cross-codebase-analysis';

const FIXTURES_ROOT = path.resolve(__dirname, '..', '..', 'fixtures', 'deployable-detection');

async function analyzeFixture(name: string, workspaceName: string) {
  const dir = path.join(FIXTURES_ROOT, name);
  const cas = await analyzeForBench(dir);
  const repository: CrossCodebaseInput = { path: dir, name: workspaceName, cas };
  const graph = buildCrossCodebaseSystemGraph(workspaceName, [repository]);
  return graph.applications;
}

function topLevel(applications: any[]): any[] {
  return applications.filter(app => app.deployable !== false && !app.bundled_into);
}

test('python-service: FastAPI app with a Dockerfile is 1 deployable', async () => {
  const applications = await analyzeFixture('python-service', 'python-service-fixture');

  const top = topLevel(applications);
  assert.equal(
    top.length,
    1,
    `expected 1 deployable for python-service, got ${top.length}: ${top.map(a => a.name).join(', ')}`,
  );

  const deployableFlagged = applications.filter(app => app.deployable === true);
  assert.ok(deployableFlagged.length >= 1, 'expected at least one application flagged deployable:true');
});

test('rails-app: Rails app (config.ru + bin/rails) with a Dockerfile is 1 deployable', async () => {
  const applications = await analyzeFixture('rails-app', 'rails-app-fixture');

  const top = topLevel(applications);
  assert.equal(
    top.length,
    1,
    `expected 1 deployable for rails-app, got ${top.length}: ${top.map(a => a.name).join(', ')}`,
  );

  const deployableFlagged = applications.filter(app => app.deployable === true);
  assert.ok(deployableFlagged.length >= 1, 'expected at least one application flagged deployable:true');
});

test('laravel-app: Laravel app (artisan + public/index.php) with a Dockerfile is 1 deployable', async () => {
  const applications = await analyzeFixture('laravel-app', 'laravel-app-fixture');

  const top = topLevel(applications);
  assert.equal(
    top.length,
    1,
    `expected 1 deployable for laravel-app, got ${top.length}: ${top.map(a => a.name).join(', ')}`,
  );

  const deployableFlagged = applications.filter(app => app.deployable === true);
  assert.ok(deployableFlagged.length >= 1, 'expected at least one application flagged deployable:true');
});
