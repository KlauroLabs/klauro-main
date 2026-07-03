/**
 * Evidence-first app discovery bench (BUG B): proves applicationSurfaceCandidatesFromCas()'s
 * folder-allowlist (apps/services/cmd/bin/packages/crates/libs) is no longer
 * the ONLY way a real ship-unit module gets discovered as a SystemApplication.
 *
 * FIXTURE (apps/mcp-server/fixtures/deployable-detection/android-flat-layout/):
 *   a 2-module Gradle project laid out at the REPO ROOT (not under apps/) —
 *   app/ applies com.android.application (with a MAIN/LAUNCHER
 *   AndroidManifest.xml), core/ applies com.android.library. Neither app/ nor
 *   core/ matches the folder allowlist, so before the BUG B fix no
 *   SystemApplication was ever created for either module and `app` was
 *   invisible as a deployable. EXPECT `app` to be discovered and deployable;
 *   `core` rolls up as a package (never its own deployable).
 *
 * Same blackbox contract as the shared bench: analyzeForBench (the product's
 * own analysis entry point) -> buildCrossCodebaseSystemGraph (the product's
 * own workspace-graph builder). No engine internals imported, no AI/model env.
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

test('android-flat-layout: app/ (not under apps/) is discovered as a deployable via evidence-root creation, core/ rolls up', async () => {
  const applications = await runFixture('android-flat-layout', 'android-flat-layout-fixture');

  const app = applications.find(a => a.name === 'app' && (a.path_hint || '').includes('app'));
  const core = applications.find(a => a.name === 'core' && (a.path_hint || '').includes('core'));

  // CORE ASSERTION (BUG B): the com.android.application module at the repo
  // ROOT's app/ folder (not apps/app/) must still be discovered as an
  // application surface — Tier-1 deployable_evidence root creation, not the
  // folder allowlist, is what makes this visible.
  assert.ok(
    app,
    `expected the com.android.application module at app/ to be detected as an application surface, got: ${applications.map(a => `${a.name}@${a.path_hint}`).join(', ')}`,
  );
  assert.equal(app?.deployable, true, `expected app.deployable === true, boundary_evidence: ${JSON.stringify(app?.boundary_evidence)}`);

  // BASELINE: com.android.library rolls up as shared code, never its own
  // deployable — Tier-3-only evidence at core/ does not itself over-produce
  // a new app when confirmed only by name (it may exist as a package surface
  // via the Tier-1-anywhere-in-repo strong-signal rule, but must never read deployable:true).
  if (core) {
    assert.notEqual(core.deployable, true, 'com.android.library module at core/ should not be its own deployable (it rolls up)');
  }

  const topLevel = topLevelDeployables(applications);
  const topLevelNames = topLevel.map(a => a.name).sort();
  assert.ok(
    topLevelNames.includes('app'),
    `expected app among top-level deployables, got: ${topLevelNames.join(', ')}`,
  );
});
