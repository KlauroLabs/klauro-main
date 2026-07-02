/**
 * Deployable-detection bench — asserts the deployable BOUNDARY on 5 fixture
 * repos: what is one deployable, what bundles into another (evidence-gated
 * merge), what rolls up as shared code, and what must NOT be force-merged.
 *
 * Two tiers of assertion, marked inline:
 *   - BASELINE: the resolver contract doesn't matter yet — these should pass
 *     today against any reasonable deployable-surface detection (right COUNT
 *     of top-level ship units, right names present).
 *   - BOUNDARY (bundled_into / boundary_evidence / possible_bundle): these
 *     assert the evidence-gated merge contract agent-B's resolver adds to
 *     SystemApplication. They are expected RED until that resolver lands —
 *     see deployable-detection-bench.ts header for the contract shape.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runDeployableDetectionBench,
  _resetDeployableDetectionBenchCache,
  topLevelDeployables,
  findApplication,
} from './deployable-detection-bench';

test('rust-installer-bundle: client+client-service bundle, gateway separate, shared rolls up', async () => {
  _resetDeployableDetectionBenchCache();
  const { applications } = await runDeployableDetectionBench('rust-installer-bundle');

  const client = findApplication(applications, 'client') && applications.find(a => a.name === 'client' || a.path_hint?.endsWith('bin/client'));
  const clientService = applications.find(a => a.name === 'client-service' || a.path_hint?.endsWith('bin/client-service'));
  const gateway = applications.find(a => a.name === 'gateway' || a.path_hint?.endsWith('bin/gateway'));
  const shared = applications.find(a => a.name === 'shared' || a.path_hint?.includes('crates/shared'));

  // BASELINE: client, client-service, and gateway should all be discovered as
  // application surfaces (even before bundling logic decides which are top-level).
  assert.ok(client, 'expected a client application surface to be detected');
  assert.ok(clientService, 'expected a client-service application surface to be detected');
  assert.ok(gateway, 'expected a gateway application surface to be detected');

  // BASELINE: crates/shared is a library, not a deployable ship unit.
  if (shared) {
    assert.notEqual(shared.deployable, true, 'crates/shared should not be its own deployable (it rolls up)');
  }

  // BOUNDARY (awaits agent-B resolver): client-service is bundled into client
  // because build-installer.sh + the single Dockerfile package both together.
  assert.equal(
    (clientService as any)?.bundled_into,
    client?.id,
    'expected client-service.bundled_into === client.id (installer bundles both under one Dockerfile/build-installer.sh)',
  );

  // BOUNDARY: 2 top-level deployables once bundling is applied: client (with
  // client-service folded in) and gateway (its own Dockerfile).
  const topLevel = topLevelDeployables(applications);
  const topLevelNames = topLevel.map(a => a.name).sort();
  assert.equal(topLevel.length, 2, `expected 2 top-level deployables, got ${topLevel.length}: ${topLevelNames.join(', ')}`);
});

test('turborepo-2apps: web + api are 2 deployables, packages/ui rolls up', async () => {
  _resetDeployableDetectionBenchCache();
  const { applications } = await runDeployableDetectionBench('turborepo-2apps');

  const web = applications.find(a => a.name === 'web' || a.path_hint?.endsWith('apps/web'));
  const api = applications.find(a => a.name === 'api' || a.path_hint?.endsWith('apps/api'));
  const ui = applications.find(a => a.name === 'ui' || a.path_hint?.includes('packages/ui'));

  // BASELINE
  assert.ok(web, 'expected web application surface to be detected');
  assert.ok(api, 'expected api application surface to be detected');
  if (ui) {
    assert.notEqual(ui.deployable, true, 'packages/ui should not be its own deployable (it rolls up)');
  }

  // BOUNDARY: neither web nor api should be bundled into the other or into ui.
  assert.equal((web as any)?.bundled_into, undefined, 'web should not be bundled into anything');
  assert.equal((api as any)?.bundled_into, undefined, 'api should not be bundled into anything');

  const topLevel = topLevelDeployables(applications);
  assert.equal(topLevel.length, 2, `expected 2 top-level deployables, got ${topLevel.length}: ${topLevel.map(a => a.name).join(', ')}`);
});

test('next-fullstack: app/ pages + app/api/ routes are ONE deployable, not split (look-alike trap)', async () => {
  _resetDeployableDetectionBenchCache();
  const { applications } = await runDeployableDetectionBench('next-fullstack');

  // BASELINE + BOUNDARY combined: this is the core assertion of this fixture.
  // Regardless of resolver maturity, the product must not report 2 deployables
  // here just because app/api/ route handlers exist alongside app/ pages.
  const topLevel = topLevelDeployables(applications);
  assert.equal(
    topLevel.length,
    1,
    `expected exactly 1 deployable for a single Next app with pages+API routes, got ${topLevel.length}: ${topLevel.map(a => a.name).join(', ')}`,
  );

  // Also true of the raw (pre-bundling) application list for this fixture:
  // there is no second Dockerfile/build anywhere, so no second deployable
  // candidate should be marked deployable:true at all.
  const deployableFlagged = applications.filter(a => a.deployable === true);
  assert.equal(
    deployableFlagged.length,
    1,
    `expected exactly 1 application flagged deployable, got ${deployableFlagged.length}: ${deployableFlagged.map(a => a.name).join(', ')}`,
  );
});

test('go-cmd-monorepo: server/worker/cli are 3 deployables, internal/* rolls up', async () => {
  _resetDeployableDetectionBenchCache();
  const { applications } = await runDeployableDetectionBench('go-cmd-monorepo');

  const server = applications.find(a => a.name === 'server' || a.path_hint?.endsWith('cmd/server'));
  const worker = applications.find(a => a.name === 'worker' || a.path_hint?.endsWith('cmd/worker'));
  const cli = applications.find(a => a.name === 'cli' || a.path_hint?.endsWith('cmd/cli'));
  const internalLibs = applications.filter(a => a.path_hint?.includes('internal/'));

  // BASELINE
  assert.ok(server, 'expected cmd/server application surface to be detected');
  assert.ok(worker, 'expected cmd/worker application surface to be detected');
  assert.ok(cli, 'expected cmd/cli application surface to be detected');
  for (const lib of internalLibs) {
    assert.notEqual(lib.deployable, true, `internal lib ${lib.name} should not be its own deployable`);
  }

  // BOUNDARY: none of the 3 cmd/* binaries should be bundled into each other —
  // each has its own Dockerfile and is an independent ship unit.
  assert.equal((server as any)?.bundled_into, undefined, 'server should not be bundled into anything');
  assert.equal((worker as any)?.bundled_into, undefined, 'worker should not be bundled into anything');
  assert.equal((cli as any)?.bundled_into, undefined, 'cli should not be bundled into anything');

  const topLevel = topLevelDeployables(applications);
  assert.equal(topLevel.length, 3, `expected 3 top-level deployables, got ${topLevel.length}: ${topLevel.map(a => a.name).join(', ')}`);
});

test('evidence-gated-negative: unshipped sibling stays separate, NOT force-merged into shipped', async () => {
  _resetDeployableDetectionBenchCache();
  const { applications } = await runDeployableDetectionBench('evidence-gated-negative');

  const shipped = applications.find(a => a.name === 'shipped' || a.path_hint?.endsWith('apps/shipped'));
  const unshipped = applications.find(a => a.name === 'unshipped' || a.path_hint?.endsWith('apps/unshipped'));

  // BASELINE
  assert.ok(shipped, 'expected shipped application surface to be detected (has Dockerfile)');

  // BOUNDARY: the core negative assertion. Even if `unshipped` is detected at
  // all (it has no Dockerfile/build artifact and isn't imported by `shipped`),
  // the evidence-gated merge policy must NOT force it into shipped's deployable.
  if (unshipped) {
    assert.notEqual(
      (unshipped as any).bundled_into,
      shipped?.id,
      'unshipped has no ship evidence and is not imported by shipped — must NOT be bundled_into shipped',
    );
    // Acceptable outcomes: stays a separate application (possibly flagged
    // possible_bundle for human review) but never silently merged.
  }
});
