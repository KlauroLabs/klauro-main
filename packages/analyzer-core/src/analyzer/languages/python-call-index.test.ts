import assert from 'node:assert/strict';
import test from 'node:test';
import type { CASNode } from '../../types/cas.types';
import { addPythonCallNodes, buildPythonCallIndex, selectPythonCallTarget, selectPythonSelfCallTarget } from './python-call-index';

function node(id: string, name: string, type: CASNode['type'], file: string, parent?: string): CASNode {
  return { id, name, type, level: 3, parent, source: { file, line: 1 } } as CASNode;
}

test('Python call index resolves same-file and self calls without scanning the graph', () => {
  const first = node('first', 'run', 'function', 'first.py');
  const second = node('second', 'run', 'function', 'second.py');
  const method = node('method', 'save', 'method', 'second.py', 'class');
  const index = buildPythonCallIndex([first, second, method], [], []);

  assert.equal(selectPythonCallTarget(index, 'run', 'second.py').target?.id, 'second');
  assert.equal(selectPythonCallTarget(index, 'run', 'missing.py').target?.id, 'first');
  assert.equal(selectPythonCallTarget(index, 'run', 'second.py').candidates, 2);
  assert.equal(selectPythonSelfCallTarget(index, 'class', 'save')?.id, 'method');
  const later = node('later', 'load', 'function', 'later.py');
  addPythonCallNodes(index, [later]);
  assert.equal(selectPythonCallTarget(index, 'load', 'later.py').target?.id, 'later');
});
