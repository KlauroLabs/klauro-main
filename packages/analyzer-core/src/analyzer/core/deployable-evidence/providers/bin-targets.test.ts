import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
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

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bin-targets-test-'));
  try {
    fn(dir);
  } finally {
    fs.removeSync(dir);
  }
}

function makeFsContext(projectPath: string, displayName?: string): EvidenceCollectionContext {
  return {
    cas: {},
    projectPath,
    nodes: [],
    exitPoints: [],
    displayName,
  };
}

// Real hosted gap (2026-08 non-container multi-deployable audit, subject
// "claudius"): a vscode-extension/ package.json with engines.vscode +
// activationEvents + main produced ZERO deployable evidence — no provider
// read engines.vscode at all, so a monorepo with a real VS Code extension
// deployable never promoted it to a sub-CAS node.
test('a package.json with engines.vscode + a main entry registers as Tier-2 bin evidence', () => {
  withTempDir(dir => {
    fs.writeJsonSync(path.join(dir, 'package.json'), {
      name: 'my-vscode-extension',
      main: './out/extension.js',
      engines: { vscode: '^1.80.0' },
      activationEvents: ['onStartupFinished'],
    });
    const result = binTargetsProvider.collect(makeFsContext(dir));
    const ext = result.find(d => d.evidence.some(e => e.includes('VS Code extension')));
    assert.ok(ext, 'expected a VS Code extension bin deployable');
    assert.equal(ext!.tier, 2);
    assert.equal(ext!.kind, 'bin');
    assert.equal(ext!.name, 'my-vscode-extension');
  });
});

test('a package.json with no engines.vscode does not register VS Code extension evidence', () => {
  withTempDir(dir => {
    fs.writeJsonSync(path.join(dir, 'package.json'), { name: 'plain-app', main: './index.js' });
    const result = binTargetsProvider.collect(makeFsContext(dir));
    assert.ok(!result.some(d => d.evidence.some(e => e.includes('VS Code extension'))));
  });
});

// Same audit, same subject: a tray-app/ Electron main with no
// electron-builder/electron-forge config produced zero evidence either —
// desktop-packaging.ts only recognizes packaging-TOOL config, not the bare
// `main` + `electron` dependency runtime convention `electron .` itself
// loads and runs.
test('a package.json with main + electron dependency (no packaging config) registers as Tier-2 bin evidence', () => {
  withTempDir(dir => {
    fs.writeJsonSync(path.join(dir, 'package.json'), {
      name: 'tray-app',
      main: './main.js',
      dependencies: { electron: '^28.0.0' },
    });
    const result = binTargetsProvider.collect(makeFsContext(dir));
    const electronEntry = result.find(d => d.evidence.some(e => e.includes('Electron app entry')));
    assert.ok(electronEntry, 'expected an Electron app bin deployable');
    assert.equal(electronEntry!.tier, 2);
    assert.equal(electronEntry!.kind, 'bin');
    assert.equal(electronEntry!.name, 'tray-app');
  });
});

// Negative guard: when a REAL packaging-tool config already exists
// (desktop-packaging.ts's Tier-1 territory), this Tier-2 fallback must not
// also fire — that would double-count the same app the way the container +
// compose-service + bin trio double-counted before this session's fix.
test('a package.json with electron-builder configured does not ALSO register the bare-electron Tier-2 fallback', () => {
  withTempDir(dir => {
    fs.writeJsonSync(path.join(dir, 'package.json'), {
      name: 'my-desktop-app',
      main: './main.js',
      devDependencies: { 'electron-builder': '^24.0.0', electron: '^28.0.0' },
      build: { appId: 'com.example.myapp' },
    });
    const result = binTargetsProvider.collect(makeFsContext(dir));
    assert.ok(!result.some(d => d.evidence.some(e => e.includes('Electron app entry'))));
  });
});
