jest.unmock('fs-extra');
jest.unmock('fs');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import {
  findUnknownDependencyGaps,
  findLowExtractionRatioGaps,
  findZeroEntryPointGap,
  findUnhandledNodeTypeGaps,
  collectCoverageGaps,
} from '../../analyzer/core/coverage-gaps';
import type { CASLibrary, CASNode } from '../../types/cas.types';

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-coverage-gaps-'));
}

describe('findUnknownDependencyGaps', () => {
  test('a dependency matching no known analyzer is recorded as a gap', () => {
    const libraries: CASLibrary[] = [
      { id: 'lib_totally_unknown_framework', name: 'totally-unknown-framework', version: '1.0.0', type: 'production', package_manager: 'npm' },
    ];
    const gaps = findUnknownDependencyGaps({ libraries, recognizedDependencyNames: ['express', 'react'] });
    expect(gaps).toHaveLength(1);
    expect(gaps[0].kind).toBe('unknown-dependency');
    expect(gaps[0].key).toBe('totally-unknown-framework');
    expect(gaps[0].severity).toBe('medium');
  });

  test('a recognized dependency produces no gap', () => {
    const libraries: CASLibrary[] = [
      { id: 'lib_express', name: 'express', version: '4.0.0', type: 'production', package_manager: 'npm' },
    ];
    const gaps = findUnknownDependencyGaps({ libraries, recognizedDependencyNames: ['express'] });
    expect(gaps).toHaveLength(0);
  });

  test('build-tooling / type-only deps are ignored by default', () => {
    const libraries: CASLibrary[] = [
      { id: 'lib_typescript', name: 'typescript', version: '5.0.0', type: 'development', package_manager: 'npm' },
      { id: 'lib_types_node', name: '@types/node', version: '20.0.0', type: 'development', package_manager: 'npm' },
    ];
    const gaps = findUnknownDependencyGaps({ libraries, recognizedDependencyNames: [] });
    expect(gaps).toHaveLength(0);
  });
});

describe('findLowExtractionRatioGaps', () => {
  let projectPath: string;

  afterEach(() => {
    if (projectPath) fs.removeSync(projectPath);
  });

  test('a large file with almost no extracted nodes is flagged', () => {
    projectPath = tempProject();
    const filePath = path.join(projectPath, 'weird.ts');
    fs.writeFileSync(filePath, Array.from({ length: 200 }, (_, i) => `// line ${i}`).join('\n'));

    const nodes: CASNode[] = [
      { id: 'n1', name: 'weird', type: 'file', source: { file: 'weird.ts', line: 1 } } as CASNode,
    ];
    const gaps = findLowExtractionRatioGaps({ nodes, projectPath });
    expect(gaps).toHaveLength(1);
    expect(gaps[0].kind).toBe('low-extraction-ratio');
    expect(gaps[0].file).toBe('weird.ts');
  });

  test('a small file is not flagged even with few nodes', () => {
    projectPath = tempProject();
    const filePath = path.join(projectPath, 'tiny.ts');
    fs.writeFileSync(filePath, 'export const x = 1;\n');

    const nodes: CASNode[] = [
      { id: 'n1', name: 'tiny', type: 'file', source: { file: 'tiny.ts', line: 1 } } as CASNode,
    ];
    const gaps = findLowExtractionRatioGaps({ nodes, projectPath });
    expect(gaps).toHaveLength(0);
  });

  test('a well-extracted file (healthy node/line ratio) is not flagged', () => {
    projectPath = tempProject();
    const filePath = path.join(projectPath, 'healthy.ts');
    fs.writeFileSync(filePath, Array.from({ length: 60 }, (_, i) => `function f${i}() {}`).join('\n'));

    const nodes: CASNode[] = Array.from({ length: 60 }, (_, i) => ({
      id: `n${i}`, name: `f${i}`, type: 'function', source: { file: 'healthy.ts', line: i + 1 },
    } as CASNode));
    const gaps = findLowExtractionRatioGaps({ nodes, projectPath });
    expect(gaps).toHaveLength(0);
  });
});

describe('findZeroEntryPointGap', () => {
  test('a root with source but zero entry points is flagged', () => {
    const gaps = findZeroEntryPointGap({
      projectPath: '/tmp/whatever',
      entryPoints: [],
      nodeCount: 42,
      codebaseType: 'web-backend',
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0].kind).toBe('zero-entry-points');
    expect(gaps[0].key).toBe('web-backend');
  });

  test('a root with entry points produces no gap', () => {
    const gaps = findZeroEntryPointGap({
      projectPath: '/tmp/whatever',
      entryPoints: [{ id: 'ep1', source_node: 'n1', type: 'http', name: 'GET /' }] as any,
      nodeCount: 42,
    });
    expect(gaps).toHaveLength(0);
  });

  test('an empty root (no nodes at all) produces no gap', () => {
    const gaps = findZeroEntryPointGap({ projectPath: '/tmp/whatever', entryPoints: [], nodeCount: 0 });
    expect(gaps).toHaveLength(0);
  });
});

describe('findUnhandledNodeTypeGaps', () => {
  test('a frequently-encountered but unhandled node type is flagged', () => {
    const gaps = findUnhandledNodeTypeGaps({
      encounteredNodeTypeCounts: { function_declaration: 100, weird_macro_invocation: 15 },
      handledNodeTypes: ['function_declaration'],
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0].key).toBe('weird_macro_invocation');
  });

  test('a rare node type below the occurrence threshold is not flagged', () => {
    const gaps = findUnhandledNodeTypeGaps({
      encounteredNodeTypeCounts: { rare_thing: 1 },
      handledNodeTypes: [],
    });
    expect(gaps).toHaveLength(0);
  });
});

describe('collectCoverageGaps', () => {
  let projectPath: string;

  afterEach(() => {
    if (projectPath) fs.removeSync(projectPath);
  });

  test('aggregates all gap kinds for a repo with an unknown dep and zero entry points', () => {
    projectPath = tempProject();
    const libraries: CASLibrary[] = [
      { id: 'lib_mystery', name: 'mystery-framework', version: '1.0.0', type: 'production', package_manager: 'npm' },
    ];
    const nodes: CASNode[] = [
      { id: 'n1', name: 'x', type: 'function', source: { file: 'index.js', line: 1 } } as CASNode,
    ];
    const gaps = collectCoverageGaps({
      projectPath,
      nodes,
      entryPoints: [],
      libraries,
      recognizedDependencyNames: [],
      codebaseType: 'library',
    });
    expect(gaps.some(g => g.kind === 'unknown-dependency')).toBe(true);
    expect(gaps.some(g => g.kind === 'zero-entry-points')).toBe(true);
  });
});
