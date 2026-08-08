import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { desktopPackagingProvider } from './desktop-packaging';
import type { EvidenceCollectionContext } from '../types';

function makeContext(projectPath: string, displayName?: string): EvidenceCollectionContext {
  return {
    cas: {},
    projectPath,
    nodes: [],
    exitPoints: [],
    displayName,
  };
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-packaging-test-'));
  try {
    fn(dir);
  } finally {
    fs.removeSync(dir);
  }
}

// Real defect: an Electron app shipping electron-builder.yml — a genuine
// packaging-plugin ship declaration, the desktop equivalent of a Dockerfile
// COPY/ENTRYPOINT or spring-boot-maven-plugin's repackage goal — produced no
// Tier-1 installer evidence at all, so it never promoted to a das_index
// despite plainly shipping a desktop artifact.
test('electron-builder.yml registers as Tier-1 installer evidence', () => {
  withTempDir(dir => {
    fs.writeFileSync(
      path.join(dir, 'electron-builder.yml'),
      'appId: com.example.myapp\nproductName: MyApp\nmac:\n  target: dmg\nwin:\n  target: nsis\n'
    );
    const result = desktopPackagingProvider.collect(makeContext(dir));
    const installer = result.find(d => d.kind === 'installer');
    assert.ok(installer, 'expected a Tier-1 installer deployable from electron-builder.yml');
    assert.equal(installer!.tier, 1);
    assert.equal(installer!.name, 'MyApp');
    assert.ok(installer!.evidence.some(e => e.includes('electron-builder.yml')));
  });
});

test('electron-builder "build" config in package.json registers when electron-builder is a dependency', () => {
  withTempDir(dir => {
    fs.writeJsonSync(path.join(dir, 'package.json'), {
      name: 'my-desktop-app',
      devDependencies: { 'electron-builder': '^24.0.0', electron: '^28.0.0' },
      build: { appId: 'com.example.myapp', productName: 'MyApp' },
    });
    const result = desktopPackagingProvider.collect(makeContext(dir));
    const installer = result.find(d => d.kind === 'installer');
    assert.ok(installer, 'expected a Tier-1 installer deployable from package.json "build" config');
    assert.equal(installer!.name, 'MyApp');
  });
});

// Negative evidence guard: a `build` key in package.json with no
// electron-builder dependency must never mint a phantom installer unit —
// doctrine is "only merge/emit on positive evidence, never on absence".
test('a bare "build" key in package.json with no electron-builder dependency emits nothing', () => {
  withTempDir(dir => {
    fs.writeJsonSync(path.join(dir, 'package.json'), {
      name: 'some-lib',
      build: { target: 'es2020' },
    });
    const result = desktopPackagingProvider.collect(makeContext(dir));
    assert.equal(result.length, 0);
  });
});

test('a repo with no electron-builder/forge config emits nothing', () => {
  withTempDir(dir => {
    fs.writeJsonSync(path.join(dir, 'package.json'), { name: 'plain-node-app' });
    const result = desktopPackagingProvider.collect(makeContext(dir));
    assert.equal(result.length, 0);
  });
});
