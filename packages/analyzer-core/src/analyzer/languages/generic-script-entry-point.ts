import * as path from 'node:path';
import type { CASEntryPoint } from '../../types/cas.types';

export function genericScriptEntryPoint(fileId: string, relativePath: string, grammar: string): CASEntryPoint | undefined {
  const extension = path.extname(relativePath).toLowerCase();
  if (grammar !== 'powershell' || extension !== '.ps1') return undefined;
  const name = path.basename(relativePath);
  return {
    id: `entry_${fileId}`,
    source_node: fileId,
    source_analyzer: 'generic-tree-sitter',
    type: 'command',
    name: `PowerShell script: ${name}`,
    description: `${name} is an executable PowerShell command surface.`,
    trigger: { event: 'powershell-script-execution' },
    metadata: { file: relativePath, language: grammar },
    handler: { node_id: fileId, method_name: name, file: relativePath, line: 1 },
  };
}
