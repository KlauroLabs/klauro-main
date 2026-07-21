import test from 'node:test';
import assert from 'node:assert/strict';
import { binTargetsProvider } from './bin-targets';
import type { EvidenceCollectionContext } from '../types';
import type { CASEntryPoint } from '../../../../types/cas.types';

function httpEntry(handlerFile: string, routeName: string, line = 1): CASEntryPoint {
  return {
    id: `entry_${routeName}_${handlerFile}`,
    source_node: `node_${routeName}`,
    type: 'http',
    name: routeName,
    trigger: { method: 'GET', path: routeName.replace(/^GET /, '') },
    handler: { node_id: `node_${routeName}`, method_name: 'handler', file: handlerFile, line },
  };
}

function makeContext(entryPoints: CASEntryPoint[], displayName?: string): EvidenceCollectionContext {
  return {
    cas: { entry_points: entryPoints },
    projectPath: '/repo',
    nodes: [],
    exitPoints: [],
    displayName,
  };
}

// Real defect: collectServerEntries() names a server-entry deployable after
// `path.basename(rootPath)` — when the route handler's path collapses to a
// generic structural directory (no named app/service segment survives
// serverEntryRoot's app-parent/route-root walk), this used to ship bare-noun
// junk deployables like "src" or "scripts" instead of a real service name.
// The fix walks the root path inward past generic segments to the nearest
// real identity-bearing one ("analyzer-core") — proven here by using a
// DIFFERENT displayName, so the assertion can't be satisfied by a blind
// fallback to displayName.
test('collectServerEntries walks past a bare-noun "src" root segment to the real package name', () => {
  const ctx = makeContext(
    [httpEntry('packages/analyzer-core/src/routes/health.ts', 'GET /health')],
    'some-other-repo-name'
  );
  const result = binTargetsProvider.collect(ctx);
  const serverEntry = result.find(d => d.kind === 'server-entry');
  assert.ok(serverEntry, 'expected a server-entry deployable');
  assert.notEqual(serverEntry!.name, 'src', 'must not name the deployable after the bare structural directory "src"');
  assert.equal(serverEntry!.name, 'analyzer-core', 'must use the nearest real identity-bearing ancestor segment');
});

test('collectServerEntries falls back to the display name instead of a bare-noun "scripts" deployable', () => {
  const ctx = makeContext(
    [httpEntry('scripts/webhook.ts', 'GET /webhook')],
    'marketing-site'
  );
  const result = binTargetsProvider.collect(ctx);
  const serverEntry = result.find(d => d.kind === 'server-entry');
  assert.ok(serverEntry, 'expected a server-entry deployable');
  assert.notEqual(serverEntry!.name, 'scripts', 'must not name the deployable after the bare structural directory "scripts"');
  assert.equal(serverEntry!.name, 'marketing-site', 'must fall back to the display name');
});

test('collectServerEntries keeps a real named app-root directory as the deployable name', () => {
  const ctx = makeContext(
    [httpEntry('apps/orders-api/src/routes/orders.ts', 'GET /orders')],
    'monorepo'
  );
  const result = binTargetsProvider.collect(ctx);
  const serverEntry = result.find(d => d.kind === 'server-entry');
  assert.ok(serverEntry, 'expected a server-entry deployable');
  // "apps" is an app-parent segment; the named app under it ("orders-api")
  // is a real identity and must be preserved, not treated as generic.
  assert.equal(serverEntry!.name, 'orders-api');
});
