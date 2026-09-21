import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  artifactFor,
  isEnginePlatform,
  laterVersion,
  latestFor,
  released,
  versionsOf,
  type EngineArtifact,
  type EngineManifest,
} from './engine-release';

function built(version: string, platform: EngineArtifact['platform'], at: string): EngineArtifact {
  return {
    version,
    platform,
    path: `engine/${version}/${platform}/klauro-engine.zst`,
    encoding: 'zstd',
    size: 9_480_000,
    sha256: `sha-${version}-${platform}`,
    decompressedSize: 132_187_648,
    decompressedSha256: `raw-${version}-${platform}`,
    publishedAt: at,
  };
}

const MANIFEST: EngineManifest = {
  artifacts: [
    built('1.0.9', 'darwin-arm64', '2026-09-01T00:00:00Z'),
    built('1.0.10', 'darwin-arm64', '2026-09-20T00:00:00Z'),
    built('1.0.10', 'linux-x64', '2026-09-20T00:00:00Z'),
  ],
};

test('a platform gets the newest build published for it', () => {
  assert.equal(latestFor(MANIFEST, 'darwin-arm64')?.version, '1.0.10');
  assert.equal(latestFor(MANIFEST, 'linux-x64')?.version, '1.0.10');
});

test('a platform nothing was built for is answered with nothing, not another platform', () => {
  assert.equal(latestFor(MANIFEST, 'win32-x64'), null);
});

test('versions are ordered by number, not by text', () => {
  assert.ok(laterVersion('1.0.10', '1.0.9') > 0);
  assert.ok(laterVersion('1.2.0', '1.10.0') < 0);
  assert.equal(laterVersion('1.0.1', '1.0.1'), 0);
  assert.deepEqual(versionsOf(MANIFEST).map(held => held.version), ['1.0.10', '1.0.9']);
});

test('a version lists every platform it was built for', () => {
  assert.deepEqual(versionsOf(MANIFEST)[0].platforms, ['darwin-arm64', 'linux-x64']);
  assert.deepEqual(versionsOf(MANIFEST)[1].platforms, ['darwin-arm64']);
});

test('an exact version can be asked for, so a client can pin and roll back', () => {
  assert.equal(artifactFor(MANIFEST, '1.0.9', 'darwin-arm64')?.sha256, 'sha-1.0.9-darwin-arm64');
  assert.equal(artifactFor(MANIFEST, '1.0.9', 'linux-x64'), null);
});

test('a release names both digests, so a client verifies what it downloads and what it runs', () => {
  const release = released(MANIFEST.artifacts[1], 'https://app.klauro.com/');
  assert.equal(release.url, 'https://app.klauro.com/engine/1.0.10/darwin-arm64/klauro-engine.zst');
  assert.equal(release.encoding, 'zstd');
  assert.equal(release.sha256, 'sha-1.0.10-darwin-arm64');
  assert.equal(release.decompressedSha256, 'raw-1.0.10-darwin-arm64');
  assert.equal(release.name, 'klauro-engine');
});

test('only the platforms the engine is built for are accepted', () => {
  assert.ok(isEnginePlatform('darwin-arm64'));
  assert.ok(isEnginePlatform('win32-x64'));
  assert.ok(!isEnginePlatform('win32-arm64'));
  assert.ok(!isEnginePlatform(undefined));
});
