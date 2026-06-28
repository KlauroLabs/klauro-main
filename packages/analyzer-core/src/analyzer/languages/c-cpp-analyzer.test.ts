import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CCppAnalyzer } from './c-cpp-analyzer';

function makeTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-cpp-analyzer-test-'));

  // math.h: declares add()
  const header = [
    '#ifndef MATH_H',
    '#define MATH_H',
    'int add(int a, int b);',
    '#endif',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'math.h'), header);

  // main.c: defines add() and main(); main calls add() and includes the header
  const mainC = [
    '#include "math.h"',
    '#include <stdio.h>',
    '',
    'int add(int a, int b) {',
    '  return a + b;',
    '}',
    '',
    'int main(int argc, char **argv) {',
    '  int x = add(2, 3);',
    '  printf("%d\\n", x);',
    '  return 0;',
    '}',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'main.c'), mainC);

  // widget.cpp: class Foo with method bar() that calls a free function helper()
  const cpp = [
    'int helper() {',
    '  return 42;',
    '}',
    '',
    'class Foo : public Base {',
    'public:',
    '  int bar() {',
    '    return helper();',
    '  }',
    '};',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'widget.cpp'), cpp);

  return dir;
}

test('CCppAnalyzer canAnalyze detects C/C++ files', async () => {
  const dir = makeTempProject();
  const analyzer = new CCppAnalyzer();
  assert.equal(await analyzer.canAnalyze(dir), true);
});

test('CCppAnalyzer extracts functions, classes, includes, calls, and entry points', async () => {
  const dir = makeTempProject();
  const analyzer = new CCppAnalyzer();
  const cas = await analyzer.analyze({ projectPath: dir });

  const nodes = cas.nodes || [];
  const edges = cas.edges || [];
  const entryPoints = cas.entry_points || [];

  const byName = (type: string, name: string) =>
    nodes.find(n => n.type === type && n.name === name);

  // Function nodes: add, main, helper
  assert.ok(byName('function', 'add'), 'expected function node "add"');
  assert.ok(byName('function', 'main'), 'expected function node "main"');
  assert.ok(byName('function', 'helper'), 'expected function node "helper"');

  // Method node: bar
  assert.ok(byName('method', 'bar'), 'expected method node "bar"');

  // Class node: Foo
  assert.ok(byName('class', 'Foo'), 'expected class node "Foo"');

  // #include edge from main.c -> math.h
  const mainFileId = nodes.find(n => n.type === 'file' && n.name === 'main.c')?.id;
  const headerFileId = nodes.find(n => n.type === 'file' && n.name === 'math.h')?.id;
  assert.ok(mainFileId && headerFileId, 'expected file nodes for main.c and math.h');
  const includeEdge = edges.find(
    e => e.type === 'imports' && e.source === mainFileId && e.target === headerFileId
  );
  assert.ok(includeEdge, 'expected #include edge main.c -> math.h');

  // calls edge: main -> add
  const mainNodeId = byName('function', 'main')!.id;
  const addNodeId = byName('function', 'add')!.id;
  const callEdge = edges.find(
    e => e.type === 'calls' && e.source === mainNodeId && e.target === addNodeId
  );
  assert.ok(callEdge, 'expected calls edge main -> add');

  // main is an entry point
  const mainEntry = entryPoints.find(ep => ep.source_node === mainNodeId);
  assert.ok(mainEntry, 'expected main() to be an entry point');
});
