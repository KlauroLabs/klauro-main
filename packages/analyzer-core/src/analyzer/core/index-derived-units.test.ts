import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CASEdge, CASEntryPoint, CASNode } from '../../types/cas.types';
import { deriveIndexUnits } from './index-derived-units';

// Step two of the analysis identifies the units a repository ships, and
// everything after it is scoped to one of them. It used to be answered by
// scanning for Dockerfiles and manifests, which on a real repository reported
// fourteen units: six smoke-test containers, a Dockerfile fragment with one
// FROM line, a markdown runbook read as an installer, and three applications.
// It also missed an entire iOS application, because its Xcode project is
// generated rather than committed.
//
// Units now come from the index: entry points grouped by the code they reach.
// A unit is a set of ways in that land on the same body of code. Nothing here
// reads a Dockerfile.

const ROOT = '/repo';

function node(id: string, file: string): CASNode {
  return { id, name: id, type: 'function', source: { file: `${ROOT}/${file}` } } as unknown as CASNode;
}

function edge(source: string, target: string, type = 'calls'): CASEdge {
  return { id: `${source}-${target}`, source, target, type } as unknown as CASEdge;
}

function entry(id: string, type: string, nodeId: string, file: string): CASEntryPoint {
  return { id, name: id, type, handler: { node_id: nodeId, file } } as unknown as CASEntryPoint;
}

test('entry points landing on the same code become one unit', () => {
  const nodes = [node('a', 'src/a.ts'), node('b', 'src/b.ts'), node('c', 'src/c.ts')];
  const edges = [edge('a', 'b'), edge('b', 'c')];
  const entries = [entry('ep1', 'cli', 'a', 'src/a.ts'), entry('ep2', 'http', 'c', 'src/c.ts')];
  const units = deriveIndexUnits(nodes, edges, entries, ROOT);
  assert.equal(units.length, 1);
  assert.deepEqual(units[0].entry_point_ids, ['ep1', 'ep2']);
  assert.deepEqual(units[0].entry_point_kinds, { cli: 1, http: 1 });
  assert.equal(units[0].reached_nodes, 3);
});

test('entry points landing on separate code become separate units', () => {
  const nodes = [node('a', 'apps/ios/a.swift'), node('b', 'apps/android/b.kt')];
  const entries = [entry('ep1', 'lifecycle', 'a', 'apps/ios/a.swift'), entry('ep2', 'lifecycle', 'b', 'apps/android/b.kt')];
  const units = deriveIndexUnits(nodes, [edge('a', 'a'), edge('b', 'b')], entries, ROOT);
  assert.equal(units.length, 2);
  assert.deepEqual(units.map(u => u.name).sort(), ['apps/android', 'apps/ios']);
});

test('units are ordered by how much code they reach', () => {
  const nodes = [node('big1', 'src/a.ts'), node('big2', 'src/b.ts'), node('big3', 'src/c.ts'), node('small', 'scripts/s.ts')];
  const edges = [edge('big1', 'big2'), edge('big2', 'big3'), edge('small', 'small')];
  const entries = [entry('small_ep', 'cli', 'small', 'scripts/s.ts'), entry('big_ep', 'cli', 'big1', 'src/a.ts')];
  const units = deriveIndexUnits(nodes, edges, entries, ROOT);
  assert.deepEqual(units.map(u => u.name), ['src', 'scripts'], 'the larger unit comes first regardless of input order');
});

test('a unit is named for where most of its entry points live', () => {
  const nodes = [node('a', 'apps/macos/a.swift'), node('b', 'apps/macos/b.swift'), node('c', 'apps/ios/c.swift')];
  const edges = [edge('a', 'b'), edge('b', 'c')];
  const entries = [
    entry('e1', 'cli', 'a', 'apps/macos/a.swift'),
    entry('e2', 'event', 'b', 'apps/macos/b.swift'),
    entry('e3', 'lifecycle', 'c', 'apps/ios/c.swift')
  ];
  const units = deriveIndexUnits(nodes, edges, entries, ROOT);
  assert.equal(units[0].name, 'apps/macos');
  assert.deepEqual(units[0].root_paths, ['apps/ios', 'apps/macos'], 'every root is still recorded');
});

test('two units that would share a name get distinct ids', () => {
  const nodes = [node('a', 'scripts/a.ts'), node('b', 'scripts/b.ts')];
  const entries = [entry('e1', 'cli', 'a', 'scripts/a.ts'), entry('e2', 'cli', 'b', 'scripts/b.ts')];
  const units = deriveIndexUnits(nodes, [edge('a', 'a'), edge('b', 'b')], entries, ROOT);
  assert.equal(units.length, 2);
  assert.equal(new Set(units.map(u => u.id)).size, 2, 'ids are identifiers, so they must be unique');
});

test('absolute node paths do not leak into unit names', () => {
  // Node source paths are absolute at the point this runs. Taking the first
  // segment of one names every unit after the home directory.
  const nodes = [node('a', 'src/a.ts')];
  const entries = [{ id: 'e1', name: 'e1', type: 'cli', handler: { node_id: 'a' } } as unknown as CASEntryPoint];
  const units = deriveIndexUnits(nodes, [edge('a', 'a')], entries, ROOT);
  assert.equal(units[0].name, 'src');
});

test('an entry point that reaches no code produces no unit', () => {
  const nodes = [node('a', 'src/a.ts')];
  const entries = [entry('orphan', 'cli', 'missing', 'src/missing.ts')];
  assert.deepEqual(deriveIndexUnits(nodes, [edge('a', 'a')], entries, ROOT), []);
});

test('no entry points means no units, rather than one unit for everything', () => {
  assert.deepEqual(deriveIndexUnits([node('a', 'src/a.ts')], [edge('a', 'a')], [], ROOT), []);
});
