jest.unmock('fs-extra');
jest.unmock('fs');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveManifestProjectName } from '../../analyzer/core/deployable-evidence/util';

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-manifest-name-'));
}

describe('resolveManifestProjectName', () => {
  let projectPath: string;

  afterEach(() => {
    if (projectPath) fs.rmSync(projectPath, { recursive: true, force: true });
  });

  test('prefers package.json "name" over a mismatched directory basename', () => {
    projectPath = tempProject();
    fs.writeFileSync(path.join(projectPath, 'package.json'), JSON.stringify({ name: '@acme/real-project-name' }));
    const resolved = resolveManifestProjectName(projectPath, path.basename(projectPath));
    expect(resolved).toBe('@acme/real-project-name');
    expect(resolved).not.toBe(path.basename(projectPath));
  });

  test('falls back to the provided fallback when package.json has no name field', () => {
    projectPath = tempProject();
    fs.writeFileSync(path.join(projectPath, 'package.json'), JSON.stringify({ version: '1.0.0' }));
    const fallback = path.basename(projectPath);
    expect(resolveManifestProjectName(projectPath, fallback)).toBe(fallback);
  });

  test('falls back to the provided fallback when package.json is invalid JSON', () => {
    projectPath = tempProject();
    fs.writeFileSync(path.join(projectPath, 'package.json'), '{ not valid json');
    const fallback = path.basename(projectPath);
    expect(resolveManifestProjectName(projectPath, fallback)).toBe(fallback);
  });

  test('falls back to pyproject.toml [project] name when there is no package.json', () => {
    projectPath = tempProject();
    fs.writeFileSync(
      path.join(projectPath, 'pyproject.toml'),
      '[project]\nname = "acme-py-service"\nversion = "0.1.0"\n'
    );
    expect(resolveManifestProjectName(projectPath, path.basename(projectPath))).toBe('acme-py-service');
  });

  test('falls back to Cargo.toml [package] name when there is no package.json/pyproject.toml', () => {
    projectPath = tempProject();
    fs.writeFileSync(
      path.join(projectPath, 'Cargo.toml'),
      '[package]\nname = "acme-rust-crate"\nversion = "0.1.0"\n'
    );
    expect(resolveManifestProjectName(projectPath, path.basename(projectPath))).toBe('acme-rust-crate');
  });

  test('falls back to go.mod module name when no other manifest exists', () => {
    projectPath = tempProject();
    fs.writeFileSync(path.join(projectPath, 'go.mod'), 'module github.com/acme/goservice\n\ngo 1.21\n');
    expect(resolveManifestProjectName(projectPath, path.basename(projectPath))).toBe('github.com/acme/goservice');
  });

  test('falls back to the directory basename when no manifest declares a name', () => {
    projectPath = tempProject();
    const fallback = path.basename(projectPath);
    expect(resolveManifestProjectName(projectPath, fallback)).toBe(fallback);
  });

  test('package.json takes priority over Cargo.toml when both exist', () => {
    projectPath = tempProject();
    fs.writeFileSync(path.join(projectPath, 'package.json'), JSON.stringify({ name: 'js-name-wins' }));
    fs.writeFileSync(path.join(projectPath, 'Cargo.toml'), '[package]\nname = "rust-name-loses"\n');
    expect(resolveManifestProjectName(projectPath, path.basename(projectPath))).toBe('js-name-wins');
  });
});
