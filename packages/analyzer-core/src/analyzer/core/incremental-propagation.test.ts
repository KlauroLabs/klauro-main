import assert from 'node:assert/strict';
import test from 'node:test';
import type { CASEdge, CASNode, IncrementalState } from '../../types/cas.types';
import {
  createIncrementalPropagationWorklist,
  incrementalPropagationNodeFingerprint,
  incrementalSurfacesMatch,
} from './incremental-propagation';

function state(imports: Record<string, string[]>): IncrementalState['files'] {
  return Object.fromEntries(Object.entries(imports).map(([filePath, importedFiles]) => [filePath, {
    filePath,
    contentHash: filePath,
    mtimeMs: 1,
    lastAnalyzed: 'now',
    analyzerId: 'language',
    nodeIds: [],
    edgeIds: [],
    entryPointIds: [],
    exitPointIds: [],
    importedFiles,
    exportedSymbols: [],
  }]));
}

test('propagation fingerprints ignore implementation bodies but retain exported signatures', () => {
  const original = {
    id: 'function_value', name: 'value', type: 'function',
    source: { file: 'value.ts', line: 1, raw: 'return 1;' },
    implementation: { code: 'return 1;' },
    signature: { parameters: [], return_type: 'number' },
  } as CASNode;
  const bodyEdit = {
    ...original,
    source: { ...original.source!, raw: 'return 2;' },
    implementation: { code: 'return 2;' },
  } as CASNode;
  const signatureEdit = {
    ...bodyEdit,
    signature: { parameters: [{ name: 'factor', type: 'number' }], return_type: 'number' },
  } as CASNode;

  assert.deepEqual(incrementalPropagationNodeFingerprint(bodyEdit), incrementalPropagationNodeFingerprint(original));
  assert.notDeepEqual(incrementalPropagationNodeFingerprint(signatureEdit), incrementalPropagationNodeFingerprint(original));
});

test('green files stop propagation while red files advance the dependent worklist', () => {
  const worklist = createIncrementalPropagationWorklist({
    projectPath: '/repo',
    files: state({ 'a.ts': [], 'b.ts': ['a.ts'], 'c.ts': ['b.ts'] }),
    nodes: [],
    edges: [],
    changedFiles: ['a.ts'],
    maxDepth: 4,
  });
  assert.deepEqual(worklist.takeBatch(8), [{ filePath: 'a.ts', depth: 0 }]);
  worklist.complete('a.ts', true);
  assert.deepEqual(worklist.takeBatch(8), [{ filePath: 'b.ts', depth: 1 }]);
  worklist.complete('b.ts', false);
  assert.deepEqual(worklist.takeBatch(8), []);
  assert.deepEqual(worklist.changedSurfaceFiles(), ['a.ts']);
});

test('graph dependencies propagate without an explicit import record', () => {
  const nodes = [
    { id: 'a', name: 'a', type: 'function', source: { file: 'a.ts' } },
    { id: 'b', name: 'b', type: 'function', source: { file: 'b.ts' } },
  ] as CASNode[];
  const edges = [{ id: 'call', source: 'b', target: 'a', type: 'calls' }] as CASEdge[];
  const worklist = createIncrementalPropagationWorklist({
    projectPath: '/repo', files: state({ 'a.ts': [], 'b.ts': [] }), nodes, edges,
    changedFiles: ['a.ts'], maxDepth: 2,
  });
  worklist.takeBatch(1);
  worklist.complete('a.ts', true);
  assert.deepEqual(worklist.takeBatch(1), [{ filePath: 'b.ts', depth: 1 }]);
});

test('deleting a dependency schedules its tracked dependents', () => {
  const worklist = createIncrementalPropagationWorklist({
    projectPath: '/repo', files: state({ 'a.ts': [], 'b.ts': ['a.ts'] }), nodes: [], edges: [],
    changedFiles: [], deletedFiles: ['a.ts'], maxDepth: 2,
  });
  assert.deepEqual(worklist.takeBatch(1), [{ filePath: 'b.ts', depth: 1 }]);
  assert.deepEqual(worklist.changedSurfaceFiles(), ['a.ts']);
});

test('propagation fails closed when a changed surface exceeds the configured depth', () => {
  const worklist = createIncrementalPropagationWorklist({
    projectPath: '/repo',
    files: state({ 'a.ts': [], 'b.ts': ['a.ts'], 'c.ts': ['b.ts'] }),
    nodes: [], edges: [], changedFiles: ['a.ts'], maxDepth: 1,
  });
  worklist.takeBatch(1);
  worklist.complete('a.ts', true);
  worklist.takeBatch(1);
  worklist.complete('b.ts', true);
  assert.match(worklist.fallbackReason() || '', /exceeded depth 1/);
});

test('surface comparison is symmetric for additions and removals', () => {
  const base = {
    imports: ['dependency.ts'], exports: ['run'], nodes: [{ id: 'run' }],
    edges: [{ id: 'call' }], entryPoints: [{ id: 'entry' }], exitPoints: [],
  };
  const changed = { ...base, edges: [] };
  assert.equal(incrementalSurfacesMatch(base, changed), false);
  assert.equal(incrementalSurfacesMatch(changed, base), false);
  assert.equal(incrementalSurfacesMatch(base, { ...base }), true);
});

test('red-green propagation produces the same file surfaces as a cold rebuild', () => {
  const files = state({ 'a.ts': [], 'b.ts': ['a.ts'], 'c.ts': ['b.ts'] });
  const previous = new Map([
    ['a.ts', { exports: ['old'] }],
    ['b.ts', { exports: ['stable'] }],
    ['c.ts', { exports: ['leaf'] }],
  ]);
  const cold = new Map([
    ['a.ts', { exports: ['new'] }],
    ['b.ts', { exports: ['stable'] }],
    ['c.ts', { exports: ['leaf'] }],
  ]);
  const incremental = new Map(previous);
  const worklist = createIncrementalPropagationWorklist({
    projectPath: '/repo', files, nodes: [], edges: [], changedFiles: ['a.ts'], maxDepth: 4,
  });
  while (true) {
    const next = worklist.takeBatch(1)[0];
    if (!next) break;
    const before = incremental.get(next.filePath)!;
    const after = cold.get(next.filePath)!;
    incremental.set(next.filePath, after);
    worklist.complete(next.filePath, JSON.stringify(before) !== JSON.stringify(after));
  }
  assert.deepEqual(incremental, cold);
  assert.deepEqual(worklist.scheduledFiles(), ['a.ts', 'b.ts']);
});

test('untracked changed files require the existing safe full-rebuild fallback', () => {
  const worklist = createIncrementalPropagationWorklist({
    projectPath: '/repo', files: state({ 'known.ts': [] }), nodes: [], edges: [],
    changedFiles: ['added.ts'], maxDepth: 4,
  });
  assert.match(worklist.fallbackReason() || '', /cannot prove ownership/);
});

test('cyclic dependencies converge after every changed surface reaches a fixed point', () => {
  const worklist = createIncrementalPropagationWorklist({
    projectPath: '/repo', files: state({ 'a.ts': ['b.ts'], 'b.ts': ['a.ts'] }), nodes: [], edges: [],
    changedFiles: ['a.ts'], maxDepth: 6,
  });
  assert.deepEqual(worklist.takeBatch(1), [{ filePath: 'a.ts', depth: 0 }]);
  worklist.complete('a.ts', true, 'a-v2');
  assert.deepEqual(worklist.takeBatch(1), [{ filePath: 'b.ts', depth: 1 }]);
  worklist.complete('b.ts', true, 'b-v2');
  assert.deepEqual(worklist.takeBatch(1), [{ filePath: 'a.ts', depth: 2 }]);
  worklist.complete('a.ts', true, 'a-v2');
  assert.deepEqual(worklist.takeBatch(1), []);
  assert.equal(worklist.fallbackReason(), undefined);
});

test('cyclic propagation fails closed when surfaces do not converge within the depth budget', () => {
  const worklist = createIncrementalPropagationWorklist({
    projectPath: '/repo', files: state({ 'a.ts': ['b.ts'], 'b.ts': ['a.ts'] }), nodes: [], edges: [],
    changedFiles: ['a.ts'], maxDepth: 2,
  });
  worklist.takeBatch(1);
  worklist.complete('a.ts', true, 'a-v2');
  worklist.takeBatch(1);
  worklist.complete('b.ts', true, 'b-v2');
  worklist.takeBatch(1);
  worklist.complete('a.ts', true, 'a-v3');
  assert.match(worklist.fallbackReason() || '', /exceeded depth 2/);
});

test('rename pairs fail closed while deletion still propagates to tracked dependents', () => {
  const worklist = createIncrementalPropagationWorklist({
    projectPath: '/repo', files: state({ 'old.ts': [], 'consumer.ts': ['old.ts'] }), nodes: [], edges: [],
    changedFiles: ['new.ts'], deletedFiles: ['old.ts'], maxDepth: 4,
  });
  assert.deepEqual(worklist.scheduledFiles(), ['consumer.ts', 'new.ts']);
  assert.match(worklist.fallbackReason() || '', /cannot prove ownership for new.ts/);
});

test('duplicate file ownership fails closed before propagation begins', () => {
  const files = state({ 'a.ts': [], 'b.ts': [] });
  files['a.ts'].nodeIds = ['shared'];
  files['b.ts'].nodeIds = ['shared'];
  const worklist = createIncrementalPropagationWorklist({
    projectPath: '/repo', files, nodes: [], edges: [], changedFiles: ['a.ts'], maxDepth: 4,
  });
  assert.match(worklist.fallbackReason() || '', /ambiguous incremental ownership for node shared/);
});
