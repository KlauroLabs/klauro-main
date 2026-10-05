import assert from 'node:assert/strict';
import test from 'node:test';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { findRoutes } from './route-query';

interface Edge { 0: string; 1: string; via?: 'name' | 'rule' }

function graph(edges: Edge[], flows: unknown[] = [], entries: unknown[] = []): CASOutput {
  const ids = [...new Set(edges.flatMap(edge => [edge[0], edge[1]]))];
  return {
    cas_version: '3.0.0', analysis_id: 'route', analysis_timestamp: '2026-10-04T00:00:00.000Z',
    system: { name: 'route', type: 'library' }, analyzer_contributions: [],
    nodes: ids.map((id, at) => ({ id, name: id, type: 'function', primaryAnalyzer: 'tier-stack', source: { file: `${id}.ts`, line: at + 1 }, metadata: {} })),
    edges: edges.map((edge, at) => ({
      id: `e${at}`, source: edge[0], target: edge[1], type: 'calls',
      ...(edge.via === undefined ? {} : { metadata: { attributes: { via: edge.via } } }),
    })),
    flows, entry_points: entries,
  } as unknown as CASOutput;
}

const e = (source: string, target: string, via?: 'name' | 'rule'): Edge => ({ 0: source, 1: target, via });

test('a path is found with the evidence on each hop', () => {
  const cas = graph([e('a', 'b'), e('b', 'c', 'name'), e('c', 'd', 'rule')]);
  const result = findRoutes(cas, 'a', 'd') as any;
  assert.equal(result.found, true);
  assert.equal(result.paths.length, 1);
  assert.deepEqual(result.paths[0].hops.map((hop: any) => [hop.from.id, hop.to.id, hop.edge, hop.via]),
    [['a', 'b', 'calls', 'structure'], ['b', 'c', 'calls', 'name'], ['c', 'd', 'calls', 'rule']]);
  assert.equal(result.paths[0].hops[0].from.file, 'a.ts');
  assert.equal(result.bound.max_depth, 8);
  assert.equal(result.bound.truncated, false);
  assert.match(result.bound.statement, /all the paths within 8 hops/);
});

test('two distinct paths are returned shortest first', () => {
  const cas = graph([e('a', 'x'), e('x', 'z'), e('a', 'p'), e('p', 'q'), e('q', 'z')]);
  const result = findRoutes(cas, 'a', 'z', { maxPaths: 5 }) as any;
  assert.deepEqual(result.paths.map((held: any) => held.length), [2, 3]);
  assert.equal(result.bound.truncated, false);
});

test('more paths than max_paths is reported as truncated', () => {
  const cas = graph([e('a', 'x'), e('x', 'z'), e('a', 'y'), e('y', 'z'), e('a', 'w'), e('w', 'z')]);
  const result = findRoutes(cas, 'a', 'z', { maxPaths: 2 }) as any;
  assert.equal(result.paths.length, 2);
  assert.equal(result.bound.truncated, true);
  assert.match(result.bound.statement, /more paths exist/);
});

test('a path longer than the depth bound is reported as beyond the bound', () => {
  const cas = graph([e('a', 'b'), e('b', 'c'), e('c', 'd'), e('d', 'e')]);
  const result = findRoutes(cas, 'a', 'e', { maxDepth: 2 }) as any;
  assert.equal(result.found, false);
  assert.equal(result.no_path.reason, 'beyond_depth_bound');
  assert.equal(result.bound.max_depth, 2);
});

test('no path and nothing unresolved means disconnected in the analysis', () => {
  const cas = graph([e('a', 'b'), e('x', 'y')]);
  const result = findRoutes(cas, 'a', 'y') as any;
  assert.equal(result.found, false);
  assert.equal(result.no_path.reason, 'disconnected_within_analysis');
  assert.deepEqual(result.no_path.open_flows, []);
});

test('no path through code that an open flow runs through is an open end, not disconnected', () => {
  const cas = graph([e('a', 'b'), e('x', 'y')], [{
    flow_id: 'flow:1', name: 'Handle a', entry_point: 'entry:1', standing: 'open', open: 2, cut: false,
    steps: [{ step_id: 'flow:1:s1', name: 'step', functions: [{ function_id: 'b' }] }],
  }], [{ id: 'entry:1', source_node: 'a' }]);
  const result = findRoutes(cas, 'a', 'y') as any;
  assert.equal(result.no_path.reason, 'open_end');
  assert.equal(result.no_path.open_flows[0].flow_id, 'flow:1');
  assert.equal(result.no_path.open_flows[0].open, 2);
});

test('a cut flow also keeps the answer open', () => {
  const cas = graph([e('a', 'b'), e('x', 'y')], [{
    flow_id: 'flow:2', name: 'Cut', entry_point: 'a', standing: 'reading', cut: true,
    steps: [{ step_id: 'flow:2:s1', name: 'step', functions: [{ function_id: 'a' }] }],
  }]);
  assert.equal((findRoutes(cas, 'a', 'y') as any).no_path.reason, 'open_end');
});

test('a step resolves to its functions and a path that only runs backwards is reported as reverse', () => {
  const cas = graph([e('a', 'b'), e('b', 'c')], [{
    flow_id: 'flow:3', name: 'F', entry_point: 'a', standing: 'terminal',
    steps: [{ step_id: 'flow:3:s9', name: 'Last', functions: [{ function_id: 'c' }] }],
  }]);
  const forward = findRoutes(cas, 'a', 'flow:3:s9') as any;
  assert.equal(forward.found, true);
  assert.equal(forward.to.kind, 'step');
  const reverse = findRoutes(cas, 'c', 'a') as any;
  assert.equal(reverse.direction, 'reverse');
  assert.match(reverse.bound.statement, /run from the second to the first/);
});

test('an ambiguous name asks for a node id and lists candidates', () => {
  const cas = graph([e('one', 'g'), e('two', 'g')]);
  cas.nodes.forEach(node => { if (node.id === 'one' || node.id === 'two') node.name = 'dup'; });
  const ambiguous = findRoutes(cas, 'dup', 'g') as any;
  assert.equal(ambiguous.found, false);
  assert.equal(ambiguous.side, 'from');
  assert.deepEqual(ambiguous.candidates.map((held: any) => held.id), ['one', 'two']);
  assert.equal((findRoutes(cas, 'one', 'g') as any).found, true);
});
