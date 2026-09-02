jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { DistributionArtifactAnalyzer } from '../../analyzer/languages/distribution-artifact-analyzer';

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-distribution-artifact-'));
}

describe('DistributionArtifactAnalyzer', () => {
  let analyzer: DistributionArtifactAnalyzer;
  let projectPath: string;

  beforeEach(() => {
    analyzer = new DistributionArtifactAnalyzer();
  });

  afterEach(() => {
    if (projectPath) fs.removeSync(projectPath);
  });

  test('Uninstall.bat is not corrupted into "Un" by an unanchored "install" strip', async () => {
    projectPath = tempProject();
    fs.writeFileSync(
      path.join(projectPath, 'Uninstall.bat'),
      '@echo off\r\nmsiexec /x {PRODUCT-GUID}\r\nexit /b 0\r\n'
    );

    const contribution = await analyzer.analyze({ projectPath });
    const node = (contribution.nodes ?? []).find(n => (n.metadata as any)?.artifact_kind);
    expect(node).toBeDefined();
    const productName = (node!.metadata as any).product_name as string | undefined;
    expect(productName).not.toBe('Un');
    // Whatever name is derived should retain "Uninstall" as a whole token,
    // not have "install" stripped out of the middle of the word.
    if (productName) expect(productName.toLowerCase()).not.toBe('un');
  });

  test('unresolved NSIS template vars like ${APPNAMEANDVERSION} do not leak into the deployable name', async () => {
    projectPath = tempProject();
    fs.writeFileSync(
      path.join(projectPath, 'installer.nsi'),
      [
        'OutFile "AppSetup.exe"',
        'Name "${APPNAMEANDVERSION}"',
        'InstallDir "$PROGRAMFILES\\\\MyApp"',
        'Section "Install"',
        '  File "build\\\\myapp.exe"',
        'SectionEnd',
      ].join('\n')
    );

    const contribution = await analyzer.analyze({ projectPath });
    const node = (contribution.nodes ?? []).find(n => (n.metadata as any)?.artifact_kind === 'installer');
    expect(node).toBeDefined();
    const productName = (node!.metadata as any).product_name as string | undefined;
    // Unresolved template text is dropped (undefined) rather than leaked verbatim.
    if (productName !== undefined) expect(productName).not.toMatch(/\$\{[A-Za-z0-9_]+\}/);
    const binaryNames = (node!.metadata as any).binary_names as string[];
    expect(binaryNames.some(name => /\$\{[A-Za-z0-9_]+\}/.test(name))).toBe(false);
  });

  test('a defined NSIS template var resolves to its real value instead of being dropped', async () => {
    projectPath = tempProject();
    fs.writeFileSync(
      path.join(projectPath, 'installer.nsi'),
      [
        '!define APPNAMEANDVERSION "MyApp 2.0"',
        'OutFile "AppSetup.exe"',
        'Name "${APPNAMEANDVERSION}"',
        'Section "Install"',
        '  File "build\\\\myapp.exe"',
        'SectionEnd',
      ].join('\n')
    );

    const contribution = await analyzer.analyze({ projectPath });
    const node = (contribution.nodes ?? []).find(n => (n.metadata as any)?.artifact_kind === 'installer');
    expect(node).toBeDefined();
    expect(contribution.entry_points).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_node: node!.id, type: 'command', name: 'Install MyApp 2.0' }),
    ]));
    const productName = (node!.metadata as any).product_name as string | undefined;
    expect(productName).toBe('MyApp 2.0');
  });

  test('an unquoted comparison against APP_NAME ("APP_NAME == ...") does not leak "=" as product_name', async () => {
    // Real-repo defect (2026-07 hosted reanalysis, Rust multi-binary
    // workspace): the old APP_NAME capture regex (`[^"'\n]+` with no
    // required leading letter) matched the trailing `= ` fragment left over
    // from an unquoted `APP_NAME == "windows"` comparison, producing a
    // product_name of literally "=" that then became a standalone phantom
    // installer deployable.
    projectPath = tempProject();
    fs.writeFileSync(
      path.join(projectPath, 'build-installer.sh'),
      [
        '#!/bin/bash',
        'set -e',
        'if [ APP_NAME=="windows" ]; then',
        '  makensis installer.nsi',
        'fi',
      ].join('\n')
    );

    const contribution = await analyzer.analyze({ projectPath });
    const node = (contribution.nodes ?? []).find(n => (n.metadata as any)?.artifact_kind === 'installer');
    expect(node).toBeDefined();
    const productName = (node!.metadata as any).product_name as string | undefined;
    expect(productName).not.toBe('=');
    if (productName) expect(productName.trim()).not.toBe('=');
  });

  test('a bare $VAR embedded in a product-name capture resolves against a nearby assignment', async () => {
    // Live-repo defect: an installer unit captured as "Zerac $BINARY_NAME" — a
    // product-name capture with an UNRESOLVED bare shell variable (no braces)
    // mid-string. The letter-leading capture guard admits it ("Z..." starts
    // with a letter), so resolution must reach into the bare-$VAR case too,
    // not just the braced "${VAR}" shape already handled above.
    projectPath = tempProject();
    fs.writeFileSync(
      path.join(projectPath, 'build-installer.sh'),
      [
        '#!/bin/bash',
        'BINARY_NAME=zeracd',
        'APP_NAME="Zerac $BINARY_NAME"',
        'makensis installer.nsi',
      ].join('\n')
    );

    const contribution = await analyzer.analyze({ projectPath });
    const node = (contribution.nodes ?? []).find(n => (n.metadata as any)?.artifact_kind === 'installer');
    expect(node).toBeDefined();
    const productName = (node!.metadata as any).product_name as string | undefined;
    expect(productName).toBe('Zerac zeracd');
  });

  test('a bare $VAR embedded in a product-name capture with NO resolvable assignment is rejected as an identity', async () => {
    projectPath = tempProject();
    fs.writeFileSync(
      path.join(projectPath, 'build-installer.sh'),
      [
        '#!/bin/bash',
        'APP_NAME="Zerac $BINARY_NAME"',
        'makensis installer.nsi',
      ].join('\n')
    );

    const contribution = await analyzer.analyze({ projectPath });
    const node = (contribution.nodes ?? []).find(n => (n.metadata as any)?.artifact_kind === 'installer');
    expect(node).toBeDefined();
    const productName = (node!.metadata as any).product_name as string | undefined;
    // The unresolved bare-$VAR value must never leak verbatim into product_name.
    if (productName !== undefined) expect(productName).not.toMatch(/\$[A-Za-z_]/);
    // With no resolvable assignment, the raw-template rawName is rejected and the
    // file-basename fallback (both "build" and "installer" being strip-tokens)
    // yields nothing product-shaped either — no identity survives at all.
    expect(productName).toBeUndefined();
  });

  test('analyzes distribution artifacts larger than the former 250 KB cutoff', async () => {
    projectPath = tempProject();
    const content = [
      'Name "Large Product"',
      'OutFile "LargeProductSetup.exe"',
      'Section "Install"',
      'SectionEnd',
      ...Array.from({ length: 30_000 }, () => '; padding'),
    ].join('\n');
    expect(Buffer.byteLength(content)).toBeGreaterThan(250_000);
    fs.writeFileSync(path.join(projectPath, 'installer.nsi'), content);

    const contribution = await analyzer.analyze({ projectPath });
    const installerNodes = (contribution.nodes ?? []).filter(node => (node.metadata as any)?.artifact_kind === 'installer');
    expect(installerNodes).toHaveLength(1);
  });
  test('retains every binary, service, and install path in a distribution artifact', async () => {
    projectPath = tempProject();
    const binaries = Array.from({ length: 55 }, (_, index) => `product-${index}.exe`);
    const services = Array.from({ length: 25 }, (_, index) => `product-${index}`);
    const installPaths = Array.from({ length: 25 }, (_, index) => `/opt/product-${index}`);
    fs.writeFileSync(
      path.join(projectPath, 'installer.nsi'),
      [
        'Name "Complete Product"',
        ...binaries.map(binary => `File "build\\\\${binary}"`),
        ...services.map(service => `DetailPrint "${service}.service"`),
        ...installPaths.map(installPath => `InstallDir "${installPath}"`),
        'Section "Install"',
        'SectionEnd',
      ].join('\n')
    );

    const contribution = await analyzer.analyze({ projectPath });
    const node = (contribution.nodes ?? []).find(candidate => (candidate.metadata as any)?.artifact_kind === 'installer');
    expect(node).toBeDefined();
    const metadata = node!.metadata as any;
    expect(metadata.binary_names).toEqual(binaries.map(binary => binary.replace(/\.exe$/, '')));
    expect(metadata.service_names).toEqual(services);
    expect(metadata.install_paths).toEqual(installPaths);
  });
});
