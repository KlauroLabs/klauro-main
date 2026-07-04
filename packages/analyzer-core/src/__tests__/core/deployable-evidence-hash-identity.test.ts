jest.unmock('fs-extra');
jest.unmock('fs');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { isHashOrIdShapedToken, safeDeployableName } from '../../analyzer/core/deployable-evidence/util';
import { packageManifestProvider } from '../../analyzer/core/deployable-evidence/providers/package-manifest';
import type { EvidenceCollectionContext } from '../../analyzer/core/deployable-evidence/types';

// A hash-shaped basename mirroring the on-disk snapshot dir name that
// production analyze calls use (analysisId hash from remote-analyzer-service.ts).
const HASH_BASENAME = 'b4d1b9a5fa2fab1c';

function contextFor(projectPath: string, displayName?: string): EvidenceCollectionContext {
  return { cas: {}, projectPath, nodes: [], exitPoints: [], displayName };
}

describe('hash-shaped identity guard (util)', () => {
  test('isHashOrIdShapedToken recognizes hex content-hash-shaped basenames', () => {
    expect(isHashOrIdShapedToken(HASH_BASENAME)).toBe(true);
    expect(isHashOrIdShapedToken('a1b2c3d4e5f6a7b8')).toBe(true);
  });

  test('isHashOrIdShapedToken recognizes canonical UUIDs', () => {
    expect(isHashOrIdShapedToken('3fa85f64-5717-4562-b3fc-2c963f66afa6')).toBe(true);
  });

  test('isHashOrIdShapedToken does not flag legitimate repo names', () => {
    expect(isHashOrIdShapedToken('zerac-ui')).toBe(false);
    expect(isHashOrIdShapedToken('my-service')).toBe(false);
    expect(isHashOrIdShapedToken('proof-of-concept')).toBe(false);
  });

  test('safeDeployableName rejects a hash-shaped basename in favor of a stable placeholder', () => {
    expect(safeDeployableName(HASH_BASENAME)).toBe('unnamed-service');
    expect(safeDeployableName('zerac-ui')).toBe('zerac-ui');
  });
});

describe('package-manifest provider: hash-shaped workspace basename never leaks as deployable name', () => {
  let projectPath: string;

  afterEach(() => {
    if (projectPath) fs.removeSync(projectPath);
  });

  test('unnamed package.json under a hash-named snapshot dir falls back to a non-hash placeholder, never the hash', () => {
    // Simulate the real production shape: source snapshot written to a dir
    // named after the analysisId hash (remote-analyzer-service.ts), analyzing
    // an app whose package.json has no "name" field.
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-hash-identity-'));
    projectPath = path.join(parent, HASH_BASENAME);
    fs.mkdirSync(projectPath);
    fs.writeJsonSync(path.join(projectPath, 'package.json'), { version: '1.0.0', private: true });

    const evidence = packageManifestProvider.collect(contextFor(projectPath));
    expect(evidence).toHaveLength(1);
    expect(evidence[0].name).not.toBe(HASH_BASENAME);
    expect(isHashOrIdShapedToken(evidence[0].name)).toBe(false);
    expect(evidence[0].name).toBe('unnamed-service');

    fs.removeSync(parent);
  });

  test('a real repo name (zerac-ui) is preserved when package.json has no name field', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-hash-identity-'));
    projectPath = path.join(parent, 'zerac-ui');
    fs.mkdirSync(projectPath);
    fs.writeJsonSync(path.join(projectPath, 'package.json'), { version: '1.0.0' });

    const evidence = packageManifestProvider.collect(contextFor(projectPath));
    expect(evidence).toHaveLength(1);
    expect(evidence[0].name).toBe('zerac-ui');

    fs.removeSync(parent);
  });

  test('an explicit package.json name always wins over any basename fallback', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-hash-identity-'));
    projectPath = path.join(parent, HASH_BASENAME);
    fs.mkdirSync(projectPath);
    fs.writeJsonSync(path.join(projectPath, 'package.json'), { name: '@zerac/ui', version: '1.0.0' });

    const evidence = packageManifestProvider.collect(contextFor(projectPath));
    expect(evidence).toHaveLength(1);
    expect(evidence[0].name).toBe('@zerac/ui');

    fs.removeSync(parent);
  });
});

describe('displayName threading: real project identity survives a hash-named workspace dir', () => {
  let projectPath: string;

  afterEach(() => {
    if (projectPath) fs.removeSync(projectPath);
  });

  test('a hash-shaped projectPath basename + a threaded displayName resolves to the displayName, not the hash', () => {
    // Mirrors the real production shape: remote-analyzer-service.ts writes the
    // snapshot to workspacePath(dataDir, analysisId) — a sha256-derived dir —
    // but now threads the real project name through as ctx.displayName.
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-hash-identity-'));
    projectPath = path.join(parent, HASH_BASENAME);
    fs.mkdirSync(projectPath);
    fs.writeJsonSync(path.join(projectPath, 'package.json'), { version: '1.0.0', private: true });

    const evidence = packageManifestProvider.collect(contextFor(projectPath, 'zerac-ui'));
    expect(evidence).toHaveLength(1);
    expect(evidence[0].name).toBe('zerac-ui');
    expect(evidence[0].name).not.toBe(HASH_BASENAME);
    expect(evidence[0].name).not.toBe('unnamed-service');
  });

  test('no displayName + a hash-shaped projectPath basename still falls back to unnamed-service (hash-identity guard intact)', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-hash-identity-'));
    projectPath = path.join(parent, HASH_BASENAME);
    fs.mkdirSync(projectPath);
    fs.writeJsonSync(path.join(projectPath, 'package.json'), { version: '1.0.0', private: true });

    const evidence = packageManifestProvider.collect(contextFor(projectPath));
    expect(evidence).toHaveLength(1);
    expect(evidence[0].name).toBe('unnamed-service');
    expect(evidence[0].name).not.toBe(HASH_BASENAME);
  });

  test('an explicit package.json name still wins over a threaded displayName', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-hash-identity-'));
    projectPath = path.join(parent, HASH_BASENAME);
    fs.mkdirSync(projectPath);
    fs.writeJsonSync(path.join(projectPath, 'package.json'), { name: '@zerac/ui', version: '1.0.0' });

    const evidence = packageManifestProvider.collect(contextFor(projectPath, 'zerac-ui'));
    expect(evidence).toHaveLength(1);
    expect(evidence[0].name).toBe('@zerac/ui');
  });
});
