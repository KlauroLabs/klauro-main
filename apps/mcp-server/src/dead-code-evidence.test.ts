import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CASNode, CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { getDeadCode } from './query';

function node(id: string, dead?: Record<string, unknown>): CASNode {
  return {
    id,
    name: id.split(':').pop() as string,
    type: 'function',
    source: { file: 'src/a.ts', line: 3 },
    metadata: dead === undefined ? {} : { attributes: { dead_code: dead } },
  } as unknown as CASNode;
}

test('a unit the engine found unreached says why, and open ends make it possibly dead', () => {
  const cas = {
    nodes: [
      node('src/a.ts:fn:orphan', { node: 'src/a.ts:fn:orphan', reason: 'no-inbound', callers: 0 }),
      node('src/a.ts:fn:helper', { node: 'src/a.ts:fn:helper', reason: 'only-from-dead-callers', callers: 2 }),
      node('src/a.ts:fn:maybe', { node: 'src/a.ts:fn:maybe', reason: 'no-inbound', callers: 0, open: 'unlinked-calls', unlinked: 3 }),
      node('src/a.ts:fn:live'),
    ],
    edges: [],
  } as unknown as CASOutput;
  const found = getDeadCode(cas);
  assert.equal(found.total, 3);
  assert.equal((found as { dead: number }).dead, 1);
  assert.equal((found as { possibly_dead: number }).possibly_dead, 2);
  const byName = new Map(found.functions.map(held => [held.name, held]));
  assert.equal(byName.get('orphan')?.status, 'dead');
  assert.match(byName.get('orphan')?.evidence[0] ?? '', /no entry point registers it/);
  assert.match(byName.get('helper')?.evidence[0] ?? '', /2 callers call it, and none/);
  assert.equal(byName.get('maybe')?.status, 'possibly-dead');
  assert.match(byName.get('maybe')?.evidence[1] ?? '', /3 calls named 'maybe' did not resolve/);
  assert.equal(byName.get('helper')?.status, 'possibly-dead');
  assert.equal(found.functions[0].name, 'orphan');
});

test('a name found elsewhere keeps a unit possibly dead and cites where', () => {
  const cas = {
    nodes: [
      node('src/a.ts:fn:serde', { node: 'src/a.ts:fn:serde', reason: 'no-inbound', callers: 0, open: 'name-referenced', mention: 'src/b.ts:9' }),
      node('src/a.ts:fn:tested', { node: 'src/a.ts:fn:tested', reason: 'exported-unused', callers: 0, open: 'name-in-tests', mention: 'tests/a.test.ts:4' }),
    ],
    edges: [],
  } as unknown as CASOutput;
  const found = getDeadCode(cas);
  const byName = new Map(found.functions.map(held => [held.name, held]));
  assert.equal(byName.get('serde')?.status, 'possibly-dead');
  assert.match(byName.get('serde')?.evidence[1] ?? '', /src\/b\.ts:9/);
  assert.match(byName.get('tested')?.evidence[1] ?? '', /only in test code at tests\/a\.test\.ts:4/);
});

test('an analysis without engine facts keeps the zero-caller answer and says what it means', () => {
  const cas = { nodes: [node('src/a.ts:fn:orphan')], edges: [], entry_points: [] } as unknown as CASOutput;
  const found = getDeadCode(cas);
  assert.equal(found.total, 1);
  assert.equal(found.functions[0].status, 'dead');
});
