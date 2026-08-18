jest.unmock('fs');
jest.unmock('fs-extra');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { GenericTreeSitterLanguageAnalyzer } from '../../../analyzer/languages/generic-tree-sitter-language-analyzer';

describe('generic PowerShell analysis', () => {
  it('exposes executable scripts as command entry points', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-powershell-'));
    try {
      await fs.writeFile(path.join(projectPath, 'configure.ps1'), "$ErrorActionPreference = 'Stop'\nWrite-Host 'configured'\n");
      const result = await new GenericTreeSitterLanguageAnalyzer().analyze({ projectPath });
      const file = result.nodes?.find(node => node.source?.file?.endsWith('configure.ps1'));

      expect(file).toBeDefined();
      expect(result.entry_points).toEqual(expect.arrayContaining([
        expect.objectContaining({ source_node: file!.id, type: 'command', name: 'PowerShell script: configure.ps1' }),
      ]));
    } finally {
      await fs.remove(projectPath);
    }
  });
});
