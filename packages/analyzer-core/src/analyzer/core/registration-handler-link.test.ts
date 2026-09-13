import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CASEdge, CASEntryPoint, CASNode } from '../../types/cas.types';
import { resolveRegistrationHandlerByLine } from './registration-handler-link';

// An entry point is only useful if it reaches the code it runs. Analyzers that
// see a registration but not its body point the handler at something that
// stands in for the code: the file, or a synthetic route node. Those carry a
// file and a line, and the function registered there is now in the index, so
// the handler is rebound to it and a calls edge is added for reachability.
//
// Measured effect on a real repository: entry points whose handler sits in the
// call graph went from 322 of 471 to 438, and HTTP entry points reaching the
// main body of the system went from 14 to 51.

function fn(id: string, name: string, file: string, line: number, endLine: number): CASNode {
  return { id, name, type: 'function', source: { file, line, end_line: endLine } } as unknown as CASNode;
}

function stub(id: string, type: string, file?: string, line?: number): CASNode {
  return { id, name: id, type, source: file ? { file, line } : undefined } as unknown as CASNode;
}

function entry(type: string, handler: Record<string, unknown>, metadata?: Record<string, unknown>): CASEntryPoint {
  return { id: `ep_${type}`, name: type, type, handler, metadata } as unknown as CASEntryPoint;
}

function run(entryPoint: CASEntryPoint, nodes: CASNode[]): { linked: boolean; edges: CASEdge[] } {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const byFile = new Map<string, CASNode[]>();
  for (const n of nodes) {
    if (n.type !== 'function' && n.type !== 'method') continue;
    const file = n.source?.file || '';
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file)!.push(n);
  }
  const edges: CASEdge[] = [];
  const linked = resolveRegistrationHandlerByLine(entryPoint, byId, byFile, edges, new Set());
  return { linked, edges };
}

test('a command whose handler is the file is rebound to the function at its line', () => {
  const nodes = [
    stub('file_cli', 'file', 'src/cli.ts', 1),
    fn('cb_69', 'action_69_12', 'src/cli.ts', 69, 85),
    fn('cb_97', 'action_97_12', 'src/cli.ts', 97, 109)
  ];
  const ep = entry('cli', { node_id: 'file_cli', file: 'src/cli.ts', line: 1 }, { line: 97 });
  const { linked, edges } = run(ep, nodes);
  assert.ok(linked);
  assert.equal(ep.handler?.node_id, 'cb_97');
  assert.equal(ep.handler?.method_name, 'action_97_12');
  assert.equal(edges.length, 1);
  assert.equal(edges[0].type, 'calls');
  assert.equal(edges[0].source, 'file_cli');
  assert.equal(edges[0].target, 'cb_97');
});

test('a route node carries its own line when the entry point has no metadata line', () => {
  const nodes = [
    stub('route_act', 'route', 'src/routes/act.ts', 29),
    fn('cb_29', 'post_29_10', 'src/routes/act.ts', 29, 60)
  ];
  const ep = entry('http', { node_id: 'route_act' });
  const { linked, edges } = run(ep, nodes);
  assert.ok(linked, 'the route node supplies both file and line');
  assert.equal(ep.handler?.node_id, 'cb_29');
  assert.equal(edges[0].target, 'cb_29');
});

test('registration a line or two above its handler still matches', () => {
  const nodes = [stub('file_a', 'file', 'src/a.ts', 1), fn('cb', 'on_42_8', 'src/a.ts', 42, 50)];
  const ep = entry('event', { node_id: 'file_a', file: 'src/a.ts' }, { line: 40 });
  assert.ok(run(ep, nodes).linked);
});

test('a handler far from the registration is not claimed', () => {
  const nodes = [stub('file_a', 'file', 'src/a.ts', 1), fn('cb', 'on_80_8', 'src/a.ts', 80, 90)];
  const ep = entry('cli', { node_id: 'file_a', file: 'src/a.ts' }, { line: 40 });
  assert.equal(run(ep, nodes).linked, false, 'a 40-line gap is not a registration');
});

test('the innermost handler wins when two start on the same line', () => {
  const nodes = [
    stub('file_a', 'file', 'src/a.ts', 1),
    fn('outer', 'command_10_2', 'src/a.ts', 10, 200),
    fn('inner', 'action_10_40', 'src/a.ts', 10, 30)
  ];
  const ep = entry('cli', { node_id: 'file_a', file: 'src/a.ts' }, { line: 10 });
  run(ep, nodes);
  assert.equal(ep.handler?.node_id, 'inner', 'the tighter span is the handler');
});

test('an absolute node path still matches a relative handler path', () => {
  // Node source paths are absolute at the point this runs; entry points are relative.
  const nodes = [
    stub('file_a', 'file', 'src/a.ts', 1),
    fn('cb', 'action_12_4', '/repo/src/a.ts', 12, 20)
  ];
  const ep = entry('cli', { node_id: 'file_a', file: 'src/a.ts' }, { line: 12 });
  assert.ok(run(ep, nodes).linked, 'suffix matching bridges absolute and relative');
  assert.equal(ep.handler?.node_id, 'cb');
});

test('a handler that already points at a function is left alone', () => {
  const nodes = [fn('real', 'handleThing', 'src/a.ts', 12, 20), fn('other', 'action_12_4', 'src/a.ts', 12, 18)];
  const ep = entry('cli', { node_id: 'real', file: 'src/a.ts' }, { line: 12 });
  const { linked, edges } = run(ep, nodes);
  assert.equal(linked, false);
  assert.equal(ep.handler?.node_id, 'real');
  assert.equal(edges.length, 0);
});

test('nothing is invented when no function sits at the line', () => {
  const nodes = [stub('file_a', 'file', 'src/a.ts', 1)];
  const ep = entry('cli', { node_id: 'file_a', file: 'src/a.ts' }, { line: 40 });
  const { linked, edges } = run(ep, nodes);
  assert.equal(linked, false);
  assert.equal(ep.handler?.node_id, 'file_a', 'the honest answer is the one it already had');
  assert.equal(edges.length, 0);
});

test('a Dockerfile or installer handler is not dragged into the call graph', () => {
  const nodes = [
    stub('img', 'container_image_definition', 'Dockerfile', 1),
    fn('cb', 'run_1_0', 'Dockerfile', 1, 5)
  ];
  const ep = entry('lifecycle', { node_id: 'img', file: 'Dockerfile' }, { line: 1 });
  assert.equal(run(ep, nodes).linked, false, 'artifact kinds need their own linkage, not this one');
});
