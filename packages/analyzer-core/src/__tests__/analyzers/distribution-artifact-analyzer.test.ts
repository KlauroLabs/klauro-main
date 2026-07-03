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
    const productName = (node!.metadata as any).product_name as string | undefined;
    expect(productName).toBe('MyApp 2.0');
  });
});
