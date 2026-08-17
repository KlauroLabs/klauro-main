import assert from 'node:assert/strict';
import test from 'node:test';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { getAgentNodeIdsForFiles, getAgentNodeIndex, getAgentSourceFiles } from './agent-cas-index';

test('agent CAS indexes resolve exact and root-relative source files without rescanning nodes', () => {
  const cas = {
    system: { root_path: '/workspace/repo' },
    nodes: [
      { id: 'first', name: 'First', type: 'function', source: { file: '/workspace/repo/src/first.ts' } },
      { id: 'second', name: 'Second', type: 'method', source: { file: 'src/first.ts' } },
    ],
  } as unknown as CASOutput;

  assert.equal(getAgentNodeIndex(cas), getAgentNodeIndex(cas));
  assert.deepEqual(getAgentSourceFiles(cas), ['/workspace/repo/src/first.ts', 'src/first.ts']);
  assert.deepEqual([...getAgentNodeIdsForFiles(cas, ['src/first.ts'])].sort(), ['first', 'second']);
});
