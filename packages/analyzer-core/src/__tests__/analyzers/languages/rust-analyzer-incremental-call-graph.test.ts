jest.unmock('glob');
jest.unmock('fs');
jest.unmock('fs-extra');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { RustAnalyzer } from '../../../analyzer/languages/rust-analyzer';
import type { CASContribution, CASNode } from '../../../types/cas.types';

describe('RustAnalyzer incremental call graph', () => {
  let projectPath: string;

  beforeEach(async () => {
    projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'rust-incremental-call-'));
    await fs.writeFile(path.join(projectPath, 'Cargo.toml'), '[package]\nname = "fixture"\nversion = "0.1.0"\n', 'utf8');
  });

  afterEach(async () => {
    await fs.remove(projectPath);
  });

  it('resolves calls only against retained Rust language nodes', async () => {
    const targetPath = path.join(projectPath, 'target.rs');
    const callerPath = path.join(projectPath, 'caller.rs');
    await fs.writeFile(targetPath, 'pub fn clone() -> usize { 1 }\n', 'utf8');
    await fs.writeFile(callerPath, 'pub fn run() -> usize { clone() }\n', 'utf8');
    const analyzer = new RustAnalyzer();
    const target = await analyzer.analyzeFileSingle({ projectPath, filePath: targetPath, relativePath: 'target.rs' });
    const decoy: CASNode = {
      id: 'typescript-clone',
      name: 'clone',
      type: 'function',
      source: { file: 'ui/store.ts' },
      analyzers: ['typescript-javascript'],
      primaryAnalyzer: 'typescript-javascript',
    };
    const existingAnalysis: CASContribution = {
      nodes: [decoy, ...target.nodes],
      edges: target.edges,
      entry_points: target.entryPoints,
      exit_points: target.exitPoints,
      analyzer_metadata: {
        analyzer_id: 'merged',
        analyzer_name: 'Merged Analysis',
        version: 'test',
        contribution_type: 'pattern',
        nodes_contributed: target.nodes.length + 1,
        edges_contributed: target.edges.length,
      },
    };
    const caller = await analyzer.analyzeFileSingle({
      projectPath,
      filePath: callerPath,
      relativePath: 'caller.rs',
      existingAnalysis: [existingAnalysis],
    });
    const run = caller.nodes.find(node => node.name === 'run');
    const rustClone = target.nodes.find(node => node.name === 'clone');

    expect(caller.edges.some(edge => edge.source === run?.id && edge.target === rustClone?.id)).toBe(true);
    expect(caller.edges.some(edge => edge.target === decoy.id)).toBe(false);
  });
});
