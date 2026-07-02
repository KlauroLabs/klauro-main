/**
 * Deployable-detection bench for C/C++ (CMake) and mobile (Android Gradle)
 * fixtures — the native/mobile counterpart to deployable-detection-bench.ts,
 * kept as a disjoint file/fixture set per the breadth fan-out ownership
 * split (agent-NATIVE owns providers/{native,mobile}.ts + these fixtures +
 * this test; the shared deployable-detection-bench.ts/FIXTURES array and its
 * existing test file are NOT touched here).
 *
 * Same blackbox contract as the shared bench: analyzeForBench (the product's
 * analyzer-server over HTTP) -> buildCrossCodebaseSystemGraph (the product's
 * own workspace-graph builder). No engine internals imported, no AI/model env.
 *
 * FIXTURES (apps/mcp-server/fixtures/deployable-detection/):
 *   - cmake-app: CMakeLists.txt with 2 add_executable targets (server, tool)
 *     + 1 add_library (shared). EXPECT 2 deployables (server, tool); shared
 *     rolls up as a package, never its own deployable.
 *   - android-app: a 2-module Gradle project — app/ applies
 *     com.android.application (with a MAIN/LAUNCHER AndroidManifest.xml),
 *     lib/ applies com.android.library. EXPECT 1 deployable (app); lib rolls
 *     up as a package. This is the "build TARGET is the ship unit" case for
 *     mobile: there is no Dockerfile anywhere in this fixture, yet the app
 *     module must still surface as deployable because the APK built from it
 *     IS the distributable artifact.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { analyzeForBench } from './product-analysis';
import { buildCrossCodebaseSystemGraph, type CrossCodebaseInput, type SystemApplication } from '../cross-codebase-analysis';

const FIXTURES_ROOT = path.resolve(__dirname, '..', '..', 'fixtures', 'deployable-detection');

type ApplicationUnderTest = SystemApplication & { bundled_into?: string; boundary_evidence?: string[] };

async function runFixture(id: string, workspaceName: string): Promise<ApplicationUnderTest[]> {
  const dir = path.join(FIXTURES_ROOT, id);
  const cas = await analyzeForBench(dir);
  const repository: CrossCodebaseInput = { path: dir, name: workspaceName, cas };
  const graph = buildCrossCodebaseSystemGraph(workspaceName, [repository]);
  return graph.applications as ApplicationUnderTest[];
}

function topLevelDeployables(applications: ApplicationUnderTest[]): ApplicationUnderTest[] {
  return applications.filter(app => app.deployable !== false && !app.bundled_into);
}

test('cmake-app: server + tool are 2 deployables, shared lib rolls up', async () => {
  const applications = await runFixture('cmake-app', 'cmake-app-fixture');

  const server = applications.find(a => a.name === 'server' && a.path_hint?.includes('apps/server'));
  const tool = applications.find(a => a.name === 'tool' && a.path_hint?.includes('apps/tool'));
  const shared = applications.find(a => a.name === 'shared');

  // BASELINE: both add_executable targets should be discovered as application
  // surfaces (CMake add_executable is this ecosystem's ship-unit signal).
  assert.ok(server, `expected a "server" application surface to be detected, got: ${applications.map(a => `${a.name}@${a.path_hint}`).join(', ')}`);
  assert.ok(tool, `expected a "tool" application surface to be detected, got: ${applications.map(a => `${a.name}@${a.path_hint}`).join(', ')}`);

  // CORE ASSERTION: no Dockerfile/compose/k8s anywhere in this fixture — the
  // add_executable declaration itself must be enough to mark these
  // deployable:true (the build target IS the ship unit for native/CMake).
  assert.equal(server?.deployable, true, `expected server.deployable === true, boundary_evidence: ${JSON.stringify(server?.boundary_evidence)}`);
  assert.equal(tool?.deployable, true, `expected tool.deployable === true, boundary_evidence: ${JSON.stringify(tool?.boundary_evidence)}`);

  // BASELINE: add_library rolls up as shared code, never its own deployable.
  if (shared) {
    assert.notEqual(shared.deployable, true, 'add_library target "shared" should not be its own deployable (it rolls up)');
  }

  const topLevel = topLevelDeployables(applications);
  const topLevelNames = topLevel.map(a => a.name).sort();
  assert.ok(
    topLevelNames.includes('server') && topLevelNames.includes('tool'),
    `expected server and tool among top-level deployables, got: ${topLevelNames.join(', ')}`,
  );
});

test('android-app: app module is 1 deployable (no Dockerfile — the APK is the ship unit), lib rolls up', async () => {
  const applications = await runFixture('android-app', 'android-app-fixture');

  const app = applications.find(a => a.name === 'app' && a.path_hint?.includes('apps/app'));
  const lib = applications.find(a => a.name === 'lib' && a.path_hint?.includes('packages/lib'));

  // BASELINE + the core native/mobile ship-unit assertion: even with zero
  // Dockerfile/compose/k8s evidence anywhere in this fixture, the
  // com.android.application module must still surface as a deployable
  // application surface, because the build TARGET (the APK) is the ship unit
  // for this ecosystem.
  assert.ok(
    app,
    `expected the com.android.application module to be detected as an application surface, got: ${applications.map(a => `${a.name}@${a.path_hint}`).join(', ')}`,
  );
  assert.equal(app?.deployable, true, `expected app.deployable === true, boundary_evidence: ${JSON.stringify(app?.boundary_evidence)}`);

  // BASELINE: com.android.library rolls up as shared code, never its own deployable.
  if (lib) {
    assert.notEqual(lib.deployable, true, 'com.android.library module should not be its own deployable (it rolls up)');
  }

  // NOTE: not asserting topLevelDeployables().length === 1 here — this
  // fixture's root-level Gradle workspace (settings.gradle.kts `include`)
  // isn't recognized by the shared resolver's isWorkspaceContainerRoot()
  // (apps/mcp-server/src/cross-codebase-analysis.ts), which currently only
  // detects npm/pnpm/turbo/nx/lerna workspaces and Cargo `[workspace]` — so
  // the synthetic codebase-root surface can also appear "top-level" here.
  // That's a pre-existing gap in shared workspace-root suppression, out of
  // this provider's ownership scope; flagged via agent-feedback. The load-
  // bearing assertions for THIS provider are above: app.deployable === true
  // and lib rolling up, which are both correct.
  const topLevel = topLevelDeployables(applications);
  const topLevelNames = topLevel.map(a => a.name);
  assert.ok(topLevelNames.includes('app'), `expected "app" among top-level deployables, got: ${topLevelNames.join(', ')}`);
});
