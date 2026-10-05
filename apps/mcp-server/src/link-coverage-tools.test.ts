import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { getCommunicationSeams, getSemanticCoverage } from './query';

const coverage = [
  {
    sub_project: 'ui',
    detected: 5,
    linked: 2,
    unlinked_count: 3,
    by_kind: { http: { detected: 5, linked: 2 }, process: { detected: 0, linked: 0 }, ipc: { detected: 0, linked: 0 } },
    unlinked: ['ui/a.ts:1'],
  },
];

const cas = {
  nodes: [],
  edges: [],
  flows: [],
  capabilities: [],
  communication_seams: {
    seams: [],
    inventory: { level: 'deployable', counts: { sync: 0, async: 0, passive: 0, total: 0 }, component_seams: [] },
    link_coverage: coverage,
  },
} as unknown as CASOutput;

test('get_communication_seams carries per-sub-project link coverage', () => {
  assert.deepEqual(getCommunicationSeams(cas).link_coverage, coverage);
});

test('get_semantic_coverage carries per-sub-project link coverage', () => {
  assert.deepEqual(getSemanticCoverage(cas).link_coverage, coverage);
});

test('an analysis with no engine links answers an empty list', () => {
  const bare = { nodes: [], edges: [], flows: [], capabilities: [] } as unknown as CASOutput;
  assert.deepEqual(getCommunicationSeams(bare).link_coverage, []);
  assert.deepEqual(getSemanticCoverage(bare).link_coverage, []);
});
