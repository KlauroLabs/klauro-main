jest.unmock('glob');
jest.unmock('fs');
jest.unmock('fs-extra');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { PythonAnalyzer } from '../../../analyzer/languages/python-analyzer';
import type { CASContribution } from '../../../types/cas.types';

describe('PythonAnalyzer incremental call graph', () => {
  let projectPath: string;

  beforeEach(async () => {
    projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'python-incremental-call-'));
  });

  afterEach(async () => {
    await fs.remove(projectPath);
  });

  it('rebuilds the same module containment in full and single-file analysis', async () => {
    const filePath = path.join(projectPath, 'app.py');
    await fs.writeFile(filePath, 'def healthz():\n    return True\n', 'utf8');
    const full = await new PythonAnalyzer().analyze({ projectPath });
    const result = await new PythonAnalyzer().analyzeFileSingle({
      projectPath, filePath, relativePath: 'app.py', existingAnalysis: [full],
    });
    expect(result.nodes.filter(node => node.type === 'module')).toEqual(full.nodes?.filter(node => node.type === 'module'));
    expect(result.edges.filter(edge => edge.source === 'module_app')).toEqual(full.edges?.filter(edge => edge.source === 'module_app'));
    expect(result.edges.some(edge => edge.source === 'module_app' && edge.target === 'file_app_py' && edge.type === 'contains')).toBe(true);
    expect(new Set(result.nodes.map(node => node.id)).size).toBe(result.nodes.length);
  });

  it('rebuilds calls from the analyzed file to retained project nodes', async () => {
    const targetPath = path.join(projectPath, 'domain.py');
    const callerPath = path.join(projectPath, 'test_domain.py');
    await fs.writeFile(targetPath, 'def calculate(value):\n    return value * 2\n', 'utf8');
    await fs.writeFile(callerPath, 'from domain import calculate\n\ndef test_calculate():\n    return calculate(2)\n', 'utf8');

    const analyzer = new PythonAnalyzer();
    const target = await analyzer.analyzeFileSingle({
      projectPath,
      filePath: targetPath,
      relativePath: 'domain.py',
    });
    const existingAnalysis: CASContribution = {
      nodes: target.nodes,
      edges: target.edges,
      entry_points: target.entryPoints,
      exit_points: target.exitPoints,
      analyzer_metadata: {
        analyzer_id: 'python',
        analyzer_name: 'Python Analyzer',
        version: 'test',
        contribution_type: 'language',
        nodes_contributed: target.nodes.length,
        edges_contributed: target.edges.length,
      },
    };
    const caller = await analyzer.analyzeFileSingle({
      projectPath,
      filePath: callerPath,
      relativePath: 'test_domain.py',
      existingAnalysis: [existingAnalysis],
    });

    const calculate = target.nodes.find(node => node.type === 'function' && node.name === 'calculate');
    const test = caller.nodes.find(node => node.type === 'function' && node.name === 'test_calculate');
    expect(calculate).toBeDefined();
    expect(test).toBeDefined();
    expect(caller.edges.some(edge => edge.source === test?.id && edge.target === calculate?.id && edge.type === 'calls')).toBe(true);
  });
});
