import assert from 'node:assert/strict';
import test from 'node:test';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { encodeCompactCASGraph } from '../../../packages/analyzer-core/src/analyzer/core/compact-cas-graph';
import { resolveCodingContextTarget } from './coding-target-resolution';
import { resolveCompactTarget } from './hosted-query-scoped-graph';

function fixture(): CASOutput {
  return {
    nodes: [
      { id: 'file', name: 'workspace-member-reference.ts', type: 'file', source: { file: 'src/workspace-member-reference.ts', line: 1 } },
      { id: 'helper', name: 'ReferenceStore', type: 'class', source: { file: 'src/workspace-member-reference.ts', line: 3 } },
      { id: 'symbol', name: 'workspaceMemberReference', type: 'function', source: { file: 'src/workspace-member-reference.ts', line: 20 } },
      { id: 'test-symbol', name: 'workspaceMemberReference', type: 'function', source: { file: 'src/__tests__/workspace-member-reference.test.ts', line: 1 } },
      { id: 'qualified', name: 'create', qualified_name: 'ReferenceStore.create', type: 'method', source: { file: 'src/workspace-member-reference.ts', line: 30 } },
      { id: 'other-create', name: 'create', qualified_name: 'OtherStore.create', type: 'function', source: { file: 'src/create.ts', line: 1 } },
    ],
    edges: [],
  } as unknown as CASOutput;
}

for (const kind of ['whole', 'compact'] as const) {
  const resolve = (cas: CASOutput, target: string) => kind === 'whole'
    ? resolveCodingContextTarget(cas, target, cas.nodes.map(node => node.id))?.id
    : resolveCompactTarget(encodeCompactCASGraph(cas), target, cas.nodes.map(node => node.id))?.id;

  test(`${kind}: exact symbol outranks a file stem and unrelated owner in that file`, () => {
    assert.equal(resolve(fixture(), 'workspaceMemberReference'), 'symbol');
    assert.equal(resolve(fixture(), 'workspaceMemberReference()'), 'symbol');
    assert.equal(resolve(fixture(), 'WORKSPACEMEMBERREFERENCE'), 'symbol');
  });

  test(`${kind}: exact qualified symbol outranks unqualified names and file aliases`, () => {
    assert.equal(resolve(fixture(), 'ReferenceStore.create'), 'qualified');
    assert.equal(resolve(fixture(), 'ReferenceStore.create()'), 'qualified');
  });

  test(`${kind}: explicit paths, stems, tests and IDs preserve their existing selection`, () => {
    assert.equal(resolve(fixture(), 'src/workspace-member-reference.ts'), 'helper');
    assert.equal(resolve(fixture(), 'workspace-member-reference'), 'helper');
    assert.equal(resolve(fixture(), 'workspace-member-reference.test.ts'), 'test-symbol');
    assert.equal(resolve(fixture(), 'file'), 'file');
    assert.equal(resolve(fixture(), 'test-symbol'), 'test-symbol');
  });

  test(`${kind}: missing explicit symbols cannot resolve to fuzzy candidates`, () => {
    assert.equal(resolve(fixture(), 'workspaceMemberReferenc'), undefined);
    assert.equal(resolve(fixture(), 'ReferenceStore.remove()'), undefined);
    assert.equal(resolve(fixture(), 'workspaceMemberReference.remove'), undefined);
  });

  test(`${kind}: exact symbols are not displaced by a window of fuzzy name matches`, () => {
    const cas = fixture();
    cas.nodes.unshift(...Array.from({ length: 500 }, (_, index) => ({
      id: `noise-${index}`, name: `workspaceMemberReferenceExtra${index}`, type: 'class',
      source: { file: `src/extra-${index}.ts`, line: 1 },
    })) as CASOutput['nodes']);
    assert.equal(resolve(cas, 'workspaceMemberReference'), 'symbol');
  });
}
