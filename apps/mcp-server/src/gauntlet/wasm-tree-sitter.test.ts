import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initWasm, hasWasmGrammar, parseWasm, queryWasm,
} from '../../../../packages/analyzer-core/src/analyzer/core/wasm-tree-sitter';

test('wasm grammars exist for the languages our new analyzers cover', () => {
  for (const lang of ['cpp', 'swift', 'kotlin', 'solidity', 'elixir', 'c']) {
    assert.equal(hasWasmGrammar(lang), true, `missing wasm grammar for ${lang}`);
  }
  assert.equal(hasWasmGrammar('c-cpp'), true); // mapped to cpp
});

test('parseWasm produces a real AST', async () => {
  await initWasm();
  const tree = await parseWasm('cpp', 'int add(int a){ return a; }');
  assert.equal(tree.rootNode.type, 'translation_unit');
  assert.ok(tree.rootNode.childCount > 0);
});

test('AST resolves an object-method call edge that regex misses', async () => {
  const src = 'struct Calc{ int run(){ return helper(); } int helper(){return 1;} };\nint main(){ Calc c; return c.run(); }';
  const tree = await parseWasm('cpp', src);
  const enclosingFn = (n: any): string => {
    let p = n.parent;
    while (p) {
      if (p.type === 'function_definition') {
        const d = p.childForFieldName('declarator');
        return d ? d.text.replace(/.*[:.]/, '').replace(/\(.*/, '') : '';
      }
      p = p.parent;
    }
    return '';
  };
  const edges: string[] = [];
  (function walk(n: any) {
    if (n.type === 'call_expression') {
      const f = n.childForFieldName('function');
      const callee = f ? (f.type === 'field_expression' ? (f.childForFieldName('field')?.text || '') : f.text) : '';
      const caller = enclosingFn(n);
      if (caller && callee) edges.push(`${caller}→${callee}`);
    }
    for (let i = 0; i < n.childCount; i++) walk(n.child(i));
  })(tree.rootNode);
  // run()->helper() is a bare call; main()->c.run() is the object-method call regex can't resolve
  assert.ok(edges.includes('run→helper'), `expected run→helper in ${edges}`);
  assert.ok(edges.includes('main→run'), `expected main→run (object-method) in ${edges}`);
});

test('queryWasm extracts named captures from a tree-sitter query', async () => {
  const caps = await queryWasm(
    'cpp',
    'int foo(){return 0;} int bar(){return 1;}',
    '(function_definition declarator: (function_declarator declarator: (identifier) @fn))'
  );
  const names = caps.filter(c => c.name === 'fn').map(c => c.text);
  assert.deepEqual(names.sort(), ['bar', 'foo']);
});
