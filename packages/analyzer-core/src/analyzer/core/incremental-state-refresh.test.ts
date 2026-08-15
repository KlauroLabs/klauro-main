import assert from 'node:assert/strict';
import test from 'node:test';
import { CASOutput, ChangeSet, FileAnalysisResult, IncrementalState } from '../../types/cas.types';
import { refreshIncrementalStateFromGraph } from './incremental-state-refresh';

test('refreshes graph ownership without rereading unchanged files', () => {
  const previousState = {
    version: '1.0.0',
    projectPath: '/project',
    lastFullAnalysis: '2026-01-01T00:00:00.000Z',
    lastAnalysisTimestamp: 1,
    files: {
      'src/a.ts': {
        filePath: 'src/a.ts',
        contentHash: 'old-a',
        mtimeMs: 1,
        lastAnalyzed: 'old-time',
        analyzerId: 'typescript',
        nodeIds: ['old-node'],
        edgeIds: [],
        entryPointIds: [],
        exitPointIds: [],
        importedFiles: ['./b'],
        exportedSymbols: ['a'],
      },
      'src/b.ts': {
        filePath: 'src/b.ts',
        contentHash: 'stable-b',
        mtimeMs: 2,
        lastAnalyzed: 'stable-time',
        analyzerId: 'typescript',
        nodeIds: ['old-b'],
        edgeIds: [],
        entryPointIds: [],
        exitPointIds: [],
        importedFiles: [],
        exportedSymbols: ['b'],
      },
    },
    analyzerVersions: {},
  } satisfies IncrementalState;
  const output = {
    nodes: [
      { id: 'new-a', type: 'function', name: 'a', source: { file: '/project/src/a.ts' } },
      { id: 'new-b', type: 'function', name: 'b', source: { file: 'src/b.ts' } },
    ],
    edges: [{ id: 'a-calls-b', source: 'new-a', target: 'new-b', type: 'calls' }],
    entry_points: [{ id: 'entry-a', source_node: 'new-a', type: 'function' }],
    exit_points: [],
    analyzer_contributions: [{ analyzer_id: 'typescript', analyzer_version: '2.0.0' }],
  } as CASOutput;
  const changed = {
    filePath: 'src/a.ts',
    contentHash: 'new-a-hash',
    mtimeMs: 3,
    nodes: output.nodes.slice(0, 1),
    edges: [],
    entryPoints: [],
    exitPoints: [],
    imports: ['./b'],
    exports: ['a'],
  } satisfies FileAnalysisResult;
  const changeSet = {
    added: [],
    modified: ['src/a.ts'],
    deleted: [],
    affectedFiles: ['src/b.ts'],
    affectedNodeIds: new Set<string>(),
    requiresFullRebuild: false,
    detectionMethod: 'hybrid',
  } satisfies ChangeSet;
  let fallbackReads = 0;

  const state = refreshIncrementalStateFromGraph({
    projectPath: '/project',
    output,
    previousState,
    fileResults: new Map([['src/a.ts', changed]]),
    changeSet,
    gitCommitHash: 'commit',
    analyzerRegistryFingerprint: 'registry',
    fallbackRecord: () => {
      fallbackReads += 1;
      return undefined;
    },
  });

  assert.equal(fallbackReads, 0);
  assert.equal(state.files['src/a.ts'].contentHash, 'new-a-hash');
  assert.deepEqual(state.files['src/a.ts'].nodeIds, ['new-a']);
  assert.deepEqual(state.files['src/a.ts'].edgeIds, ['a-calls-b']);
  assert.deepEqual(state.files['src/a.ts'].entryPointIds, ['entry-a']);
  assert.equal(state.files['src/b.ts'].contentHash, 'stable-b');
  assert.equal(state.files['src/b.ts'].lastAnalyzed, 'stable-time');
  assert.deepEqual(state.files['src/b.ts'].nodeIds, ['new-b']);
  assert.equal(state.analyzerVersions.typescript, '2.0.0');
  assert.equal(state.lastFullAnalysis, previousState.lastFullAnalysis);
});

test('removes deleted files and falls back only for newly owned graph files', () => {
  const previousState = {
    version: '1.0.0',
    projectPath: '/project',
    lastFullAnalysis: 'full',
    lastAnalysisTimestamp: 1,
    files: {
      'src/deleted.ts': {
        filePath: 'src/deleted.ts', contentHash: 'deleted', mtimeMs: 1, lastAnalyzed: 'old', analyzerId: 'typescript',
        nodeIds: [], edgeIds: [], entryPointIds: [], exitPointIds: [], importedFiles: [], exportedSymbols: [],
      },
    },
    analyzerVersions: {},
  } satisfies IncrementalState;
  const output = {
    nodes: [{ id: 'generated', type: 'file', name: 'generated', source: { file: 'generated.ts' } }],
    edges: [],
    entry_points: [],
    exit_points: [],
  } as CASOutput;
  const fallbackPaths: string[] = [];
  const state = refreshIncrementalStateFromGraph({
    projectPath: '/project',
    output,
    previousState,
    fileResults: new Map(),
    changeSet: {
      added: [], modified: [], deleted: ['src/deleted.ts'], affectedFiles: [], affectedNodeIds: new Set(),
      requiresFullRebuild: false, detectionMethod: 'mtime',
    },
    analyzerRegistryFingerprint: 'registry',
    fallbackRecord: filePath => {
      fallbackPaths.push(filePath);
      return {
        filePath, contentHash: 'generated-hash', mtimeMs: 2, lastAnalyzed: 'new', analyzerId: 'generated',
        nodeIds: [], edgeIds: [], entryPointIds: [], exitPointIds: [], importedFiles: [], exportedSymbols: [],
      };
    },
  });

  assert.deepEqual(fallbackPaths, ['generated.ts']);
  assert.equal(state.files['src/deleted.ts'], undefined);
  assert.deepEqual(state.files['generated.ts'].nodeIds, ['generated']);
});
