import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tierStackToCas } from './tier-stack-to-cas';
import type { TierStackIndex } from './read-tier-stack';
import { linkCoverageOf } from '../core/link-coverage';

const INDEX: TierStackIndex = {
  root: '/tmp/desk',
  files: [{ path: 'ui/app.ts', kind: 'source', language: 'typescript', extracted: true }],
  nodes: [{ id: 'ui/app.ts', name: 'app.ts', kind: 'module', file: 0, span: { line: 1 } }],
  edges: [],
  partition: {
    sub_projects: [
      { id: 'subproject:ui', name: 'ui', root: 'ui' },
      { id: 'subproject:core', name: 'core', root: 'core' },
    ],
  },
  composition: {
    mode: 'derived',
    children: [],
    seams: [],
    links: [
      {
        project: 'subproject:ui',
        http: { detected: 4, linked: 1 },
        process: { detected: 0, linked: 0 },
        ipc: { detected: 3, linked: 3 },
        unlinked: ['ui/a.ts:1', 'ui/a.ts:2', 'ui/a.ts:3', 'ui/a.ts:4', 'ui/a.ts:5', 'ui/a.ts:6'],
      },
    ],
    dependencies: [],
  },
} as unknown as TierStackIndex;

test('a sub-project reports calls detected, linked and the unlinked sites an engine kept', () => {
  const cas = tierStackToCas(INDEX, 'desk');
  const coverage = cas.communication_seams?.link_coverage;
  assert.equal(coverage?.length, 1);
  const ui = coverage![0];
  assert.equal(ui.sub_project, 'ui');
  assert.equal(ui.detected, 7);
  assert.equal(ui.linked, 4);
  assert.equal(ui.unlinked_count, 3);
  assert.deepEqual(ui.by_kind.ipc, { detected: 3, linked: 3 });
  assert.deepEqual(ui.unlinked, ['ui/a.ts:1', 'ui/a.ts:2', 'ui/a.ts:3', 'ui/a.ts:4', 'ui/a.ts:5']);
});

test('no engine links means no link coverage surface', () => {
  assert.equal(linkCoverageOf(undefined, name => name), undefined);
  assert.equal(linkCoverageOf([], name => name), undefined);
});
