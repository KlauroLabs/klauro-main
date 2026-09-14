import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FlowConcept } from '../../types/cas.types';
import { mergeFlowsByEntryPoint } from './flow-merge-by-entry';

// A flow was built from one entry-to-exit call chain, so a command became as
// many flows as it had reachable effects. One voice-call command appeared five
// times, identical except for which tunnel command it ended at; a database
// search appeared 48 times. 471 entry points produced 939 flows, 124 names were
// duplicated, and every layer above saw the same behaviour repeatedly.
//
// A flow is now one behaviour with several effects. The most complete chain
// supplies the steps; every chain's terminus becomes an entry in effects.

function effect(id: string, kind = 'sdk', produces = 'spawn'): { exit_point_id: string; kind: string; produces: string; node_id: string } {
  return { exit_point_id: id, kind, produces, node_id: `node_${id}` };
}

function flow(id: string, entryPoint: string, steps: number, terminus?: ReturnType<typeof effect>, extra: Partial<FlowConcept> = {}): FlowConcept {
  return {
    flow_id: id,
    name: id,
    entry_point: entryPoint,
    entities: [],
    steps: Array.from({ length: steps }, (_, index) => ({ step_id: `${id}_${index}`, order: index, functions: [] })),
    terminus,
    ...extra
  } as unknown as FlowConcept;
}

test('chains from one entry point become one flow carrying every effect', () => {
  const merged = mergeFlowsByEntryPoint([
    flow('a', 'ep_call', 2, effect('ngrok')),
    flow('b', 'ep_call', 4, effect('tailscale')),
    flow('c', 'ep_call', 3, effect('stopTailscale'))
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].steps.length, 4, 'the most complete chain supplies the steps');
  assert.deepEqual(merged[0].effects?.map(e => e.exit_point_id), ['ngrok', 'stopTailscale', 'tailscale']);
});

test('different entry points stay different flows', () => {
  const merged = mergeFlowsByEntryPoint([
    flow('a', 'ep_call', 2, effect('one')),
    flow('b', 'ep_speak', 2, effect('two'))
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map(f => f.entry_point), ['ep_call', 'ep_speak']);
});

test('the order entry points first appeared in is preserved', () => {
  const merged = mergeFlowsByEntryPoint([
    flow('a', 'ep_two', 1, effect('x')),
    flow('b', 'ep_one', 1, effect('y')),
    flow('c', 'ep_two', 1, effect('z'))
  ]);
  assert.deepEqual(merged.map(f => f.entry_point), ['ep_two', 'ep_one']);
});

test('identical effects reached by two chains are recorded once', () => {
  const merged = mergeFlowsByEntryPoint([
    flow('a', 'ep', 1, effect('same')),
    flow('b', 'ep', 2, effect('same'))
  ]);
  assert.equal(merged[0].effects?.length, 1);
});

test('entities, triggers and gaps are unioned across the chains', () => {
  const merged = mergeFlowsByEntryPoint([
    flow('a', 'ep', 1, effect('x'), { entities: ['Call', 'Account'], triggers: ['t1'], gaps: ['g1'] }),
    flow('b', 'ep', 2, effect('y'), { entities: ['Account', 'Session'], triggers: ['t2'], gaps: ['g1'] })
  ]);
  assert.deepEqual(merged[0].entities, ['Account', 'Call', 'Session']);
  assert.deepEqual(merged[0].triggers, ['t1', 't2']);
  assert.deepEqual(merged[0].gaps, ['g1']);
});

test('a flow with no terminus contributes no effect and is not lost', () => {
  const merged = mergeFlowsByEntryPoint([flow('a', 'ep', 3, undefined), flow('b', 'ep', 1, effect('x'))]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].steps.length, 3);
  assert.deepEqual(merged[0].effects?.map(e => e.exit_point_id), ['x']);
});

test('a flow that was never merged still records its effect', () => {
  // effects is the trait that says what a behaviour does to the outside world,
  // so it has to be present on every flow that has one, not only on flows that
  // happened to be merged. Populating it only on merges left two thirds of
  // flows carrying a terminus that nothing downstream could read uniformly.
  const merged = mergeFlowsByEntryPoint([flow('a', 'ep', 2, effect('x'))]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].effects?.map(e => e.exit_point_id), ['x']);
});

test('a flow with no effect at all claims none', () => {
  const merged = mergeFlowsByEntryPoint([flow('a', 'ep', 2, undefined)]);
  assert.equal(merged[0].effects, undefined);
  assert.equal(merged[0].terminus, undefined);
});

test('flows with no entry point are kept apart rather than collapsed together', () => {
  const merged = mergeFlowsByEntryPoint([
    flow('a', '', 1, effect('x')),
    flow('b', '', 1, effect('y'))
  ]);
  assert.equal(merged.length, 2, 'a missing entry point is not a shared key');
});

test('ties on step count resolve deterministically', () => {
  const first = mergeFlowsByEntryPoint([flow('b', 'ep', 2, effect('x')), flow('a', 'ep', 2, effect('y'))]);
  const second = mergeFlowsByEntryPoint([flow('a', 'ep', 2, effect('y')), flow('b', 'ep', 2, effect('x'))]);
  assert.equal(first[0].flow_id, 'a');
  assert.equal(second[0].flow_id, 'a');
});

// An effect reached only through shared setup is weaker evidence about a flow
// than one the flow reaches directly. Asked what a voice-call command does, the
// analysis answered with five tunnel spawns belonging to a different command,
// all of them four to seven hops away through a shared runtime helper. The
// effects are still recorded, because they are reachable and that is a fact,
// but the primary effect is now the nearest one the flow reaches on its own.

function reached(id: string, hops: number, viaShared: boolean, kind = 'sdk') {
  return { exit_point_id: id, kind, produces: id, node_id: `node_${id}`, hops, via_shared_helper: viaShared };
}

test('an effect the flow reaches directly outranks one inherited through shared code', () => {
  const merged = mergeFlowsByEntryPoint([
    flow('a', 'ep', 2, reached('tunnel', 5, true)),
    flow('b', 'ep', 1, reached('ownWrite', 2, false, 'file'))
  ]);
  assert.equal(merged[0].terminus?.exit_point_id, 'ownWrite');
  assert.deepEqual(merged[0].effects?.map(e => e.exit_point_id), ['ownWrite', 'tunnel'], 'both kept, own first');
});

test('among effects of equal standing the nearer one comes first', () => {
  const merged = mergeFlowsByEntryPoint([
    flow('a', 'ep', 1, reached('far', 7, true)),
    flow('b', 'ep', 1, reached('near', 3, true))
  ]);
  assert.deepEqual(merged[0].effects?.map(e => e.exit_point_id), ['near', 'far']);
  assert.equal(merged[0].terminus?.exit_point_id, 'near', 'when everything is inherited, the nearest still leads');
});

test('effects with no reach recorded sort last rather than first', () => {
  const merged = mergeFlowsByEntryPoint([
    flow('a', 'ep', 1, effect('unknown')),
    flow('b', 'ep', 1, reached('measured', 4, true))
  ]);
  assert.deepEqual(merged[0].effects?.map(e => e.exit_point_id), ['measured', 'unknown']);
});
