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

test('installer-script-only-bundle: client-service bundles into client via .sh installer script alone (no Dockerfile)', async () => {
  _resetDeployableDetectionBenchCache();
  const { applications } = await runDeployableDetectionBench('installer-script-only-bundle');

  const client = applications.find(a => a.name === 'client' || a.path_hint?.endsWith('bin/client'));
  const clientService = applications.find(a => a.name === 'client-service' || a.path_hint?.endsWith('bin/client-service'));
  const shared = applications.find(a => a.name === 'shared' || a.path_hint?.includes('crates/shared'));

  assert.ok(client, 'expected a client application surface to be detected');
  assert.ok(clientService, 'expected a client-service application surface to be detected');
  if (shared) {
    assert.notEqual(shared.deployable, true, 'crates/shared should not be its own deployable (it rolls up)');
  }

  // Regression lock: this fixture has NO Dockerfile — the only bundling
  // evidence is build-installer.sh (a .sh file). If .sh ever stops being a
  // registered source extension (or is otherwise excluded from the product
  // source snapshot), this evidence never reaches the installer provider and
  // client-service silently stops bundling into client.
  assert.equal(
    (clientService as any)?.bundled_into,
    client?.id,
    'expected client-service.bundled_into === client.id via build-installer.sh alone',
  );

  const topLevel = topLevelDeployables(applications);
  const topLevelNames = topLevel.map(a => a.name).sort();
  assert.equal(topLevel.length, 1, `expected 1 top-level deployable (client), got ${topLevel.length}: ${topLevelNames.join(', ')}`);
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

test('rust-messy-workspace: shipped-gate collapses unshipped bins, client+client-service bundle, gateway+server separate', async () => {
  _resetDeployableDetectionBenchCache();
  const { applications } = await runDeployableDetectionBench('rust-messy-workspace');

  const client = applications.find(a => a.name === 'client' || a.path_hint?.endsWith('bin/client'));
  const clientService = applications.find(a => a.name === 'client-service' || a.path_hint?.endsWith('bin/client-service'));
  const gateway = applications.find(a => a.name === 'gateway' || a.path_hint?.endsWith('bin/gateway'));
  const server = applications.find(a => a.name === 'server' || a.path_hint?.endsWith('bin/server'));
  const shared = applications.find(a => a.name === 'shared' || a.path_hint?.includes('crates/shared'));
  const unshippedNames = ['smoke-test', 'demo-cast', 'bench-tool', 'scratch'];
  const unshipped = unshippedNames.map(name => applications.find(a => a.name === name || a.path_hint?.endsWith(`bin/${name}`)));

  // BASELINE: all 8 bins should be discovered as application surfaces.
  assert.ok(client, 'expected a client application surface to be detected');
  assert.ok(clientService, 'expected a client-service application surface to be detected');
  assert.ok(gateway, 'expected a gateway application surface to be detected');
  assert.ok(server, 'expected a server application surface to be detected');
  for (const [i, app] of unshipped.entries()) {
    assert.ok(app, `expected ${unshippedNames[i]} application surface to be detected`);
  }

  // BASELINE: crates/shared is a library, not a deployable ship unit.
  if (shared) {
    assert.notEqual(shared.deployable, true, 'crates/shared should not be its own deployable (it rolls up)');
  }

  // BOUNDARY: client-service is bundled into client (top-level Dockerfile +
  // build-installer.sh, ENTRYPOINT=client).
  assert.equal(
    (clientService as any)?.bundled_into,
    client?.id,
    'expected client-service.bundled_into === client.id (top-level Dockerfile ENTRYPOINT=client bundles both)',
  );

  // BOUNDARY: gateway and server each have their own Dockerfile — independent
  // ship units, not bundled into client or each other.
  assert.equal((gateway as any)?.bundled_into, undefined, 'gateway should not be bundled into anything (own Dockerfile)');
  assert.equal((server as any)?.bundled_into, undefined, 'server should not be bundled into anything (own Dockerfile)');
  assert.equal(gateway?.deployable, true, 'gateway should be deployable (own Dockerfile)');
  assert.equal(server?.deployable, true, 'server should be deployable (own Dockerfile)');

  // SHIPPED-GATE (the core assertion of this fixture): the 4 unshipped bins
  // are RUNNABLE (Cargo [[bin]]) but appear in NO ship artifact anywhere —
  // they must be deployable:false, not silently counted as ship units.
  for (const [i, app] of unshipped.entries()) {
    if (!app) continue;
    assert.notEqual(app.deployable, true, `${unshippedNames[i]} is runnable-only (no ship artifact references it) and must not be deployable:true`);
    assert.ok(
      (app.boundary_evidence || []).some((line: string) => line.startsWith('runnable-not-shipped:')),
      `${unshippedNames[i]} should carry runnable-not-shipped boundary_evidence, got: ${JSON.stringify(app.boundary_evidence)}`,
    );
  }

  // BOUNDARY: exactly 3 top-level deployables — client (with client-service
  // folded in), gateway, server. The 4 unshipped bins must not inflate the count.
  const topLevel = topLevelDeployables(applications);
  const topLevelNames = topLevel.map(a => a.name).sort();
  assert.equal(topLevel.length, 3, `expected 3 top-level deployables, got ${topLevel.length}: ${topLevelNames.join(', ')}`);
});

test('docker-shared-dir-entrypoint-fixture: per-service Dockerfile entrypoint wins primary over a shared generic Dockerfile; a same-named [[bin]]/lib-crate pair does not collide and the bin is shipped-gated out', async () => {
  _resetDeployableDetectionBenchCache();
  const { applications } = await runDeployableDetectionBench('docker-shared-dir-entrypoint-fixture');

  const bina = applications.find(a => a.name === 'bina' || a.path_hint?.endsWith('bin/bina'));
  const binb = applications.find(a => a.name === 'binb' || a.path_hint?.endsWith('bin/binb'));

  // BASELINE: both real services are discovered as application surfaces.
  assert.ok(bina, 'expected a bina application surface to be detected');
  assert.ok(binb, 'expected a binb application surface to be detected');

  // BOUNDARY (entrypoint-as-primary): bina's own per-service Dockerfile
  // (docker/BinA.Dockerfile) has NO CMD and an ENTRYPOINT that is a generic
  // wrapper script, not the binary — the sole-build-output-binary fallback
  // must recover "bina" as its entrypoint member, and that dedicated
  // Dockerfile must win primary attribution over the shared top-level
  // Dockerfile (which also names bina+binb generically for a dev/test
  // image). Neither bina nor binb should be bundled into the other or into
  // a phantom third application from the generic Dockerfile.
  assert.equal((bina as any)?.bundled_into, undefined, 'bina should not be bundled into anything — it has its own dedicated Dockerfile');
  assert.equal((binb as any)?.bundled_into, undefined, 'binb should not be bundled into anything — it has its own dedicated Dockerfile');
  assert.equal(bina?.deployable, true, 'bina should be deployable (own Dockerfile, entrypoint-resolved)');
  assert.equal(binb?.deployable, true, 'binb should be deployable (own Dockerfile)');

  const topLevel = topLevelDeployables(applications);
  const topLevelNames = topLevel.map(a => a.name).sort();
  assert.equal(
    topLevelNames.filter(name => name === 'bina' || name === 'binb').length,
    2,
    `expected both bina and binb present as top-level deployables, got: ${topLevelNames.join(', ')}`,
  );

  // BOUNDARY (identity collision + shipped-gate): a Cargo [[bin]] target
  // named "version" at the repo root (src/bin/version.rs) shares its bare
  // name with an unrelated crates/version LIBRARY crate. They must resolve
  // to two DIFFERENT SystemApplications (not merge into one via the shared
  // applicationId-by-name), and the bin target itself — a real RUNNABLE with
  // no Tier-1 ship artifact referencing it — must be shipped-gated to
  // deployable:false, never surviving as a phantom top-level deployable.
  const versionApps = applications.filter(a => a.name === 'version');
  assert.ok(versionApps.length >= 2, `expected the version lib crate and the version [[bin]] target to be two distinct applications, got ${versionApps.length}`);
  for (const versionApp of versionApps) {
    assert.notEqual(versionApp.deployable, true, `version app at path_hint=${versionApp.path_hint} must not be deployable:true`);
  }
  assert.ok(
    !topLevelNames.includes('version'),
    `"version" must not appear as a top-level deployable, got: ${topLevelNames.join(', ')}`,
  );
});
