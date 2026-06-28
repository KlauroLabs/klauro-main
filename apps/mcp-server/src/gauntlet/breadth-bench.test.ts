import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractStructure } from '../../../../packages/analyzer-core/src/analyzer/core/generic-tree-sitter-analyzer';
import { hasWasmGrammar } from '../../../../packages/analyzer-core/src/analyzer/core/wasm-tree-sitter';

// The breadth engine: a generic tree-sitter walker + per-language spec gives
// structural coverage (functions/calls/imports) for any grammar we ship — the
// same mechanism behind codebase-memory-mcp's 158 languages. Verified on Lua (no
// deep Klauro analyzer) and measured at parity with codebase-memory, which
// extracts the same 2 functions from this source (defs_total=2).

const LUA = [
  'local M = {}',
  'function M.save(x)',
  '  return store(x)',
  'end',
  'local function helper(a) return a+1 end',
  'local json = require("json")',
  'M.save(helper(5))',
  'return M',
].join('\n');

test('breadth engine extracts Lua structure with no bespoke analyzer (parity with codebase-memory)', {
  skip: (hasWasmGrammar('lua') || hasNativeGrammar('lua')) ? false : 'lua grammar not shipped',
}, async () => {
  const r = await extractStructure('lua', LUA);
  assert.ok(r, 'lua must be extractable via the generic walker');

  const fns = r!.functions.map(f => f.name).sort();
  assert.deepEqual(fns, ['M.save', 'helper'], `functions, got ${JSON.stringify(fns)}`);

  const callees = r!.calls.map(c => c.callee);
  assert.ok(callees.includes('store'), 'must capture the store() call');
  assert.ok(!callees.includes('require'), 'require must not be a plain call');
  assert.ok(r!.imports.some(i => i.module.includes('require')), 'require must be an import');
});

const SCALA = [
  'class UserService(repo: Repo) {',
  '  def save(x: Int): Int = repo.store(x)',
  '}',
  'object Main { def run() = new UserService(null).save(5) }',
].join('\n');

test('breadth engine extracts Scala structure (second verified grammar)', {
  skip: (hasWasmGrammar('scala') || hasNativeGrammar('scala')) ? false : 'scala grammar not shipped',
}, async () => {
  const r = await extractStructure('scala', SCALA);
  assert.ok(r, 'scala must be extractable via the generic walker');
  const fns = r!.functions.map(f => f.name).sort();
  assert.deepEqual(fns, ['run', 'save'], `functions, got ${JSON.stringify(fns)}`);
  const classes = r!.classes.map(c => c.name);
  assert.ok(classes.includes('UserService'), `must capture UserService class, got ${JSON.stringify(classes)}`);
  assert.ok(r!.calls.some(c => c.callee.includes('store')), 'must capture repo.store call');
});

const RESCRIPT = 'let save = x => store(x)\nlet helper = a => a + 1\nsave(helper(5))';

test('breadth engine extracts ReScript structure (third verified grammar)', {
  skip: hasWasmGrammar('rescript') ? false : 'rescript grammar not shipped',
}, async () => {
  const r = await extractStructure('rescript', RESCRIPT);
  assert.ok(r, 'rescript must be extractable via the generic walker');
  const fns = r!.functions.map(f => f.name).sort();
  assert.deepEqual(fns, ['helper', 'save'], `functions, got ${JSON.stringify(fns)}`);
  assert.ok(r!.calls.some(c => c.callee === 'store'), 'must capture the store() call');
});

const ZIG = [
  'const std = @import("std");',
  'fn save(x: i32) i32 {',
  '    return store(x);',
  '}',
  'fn helper(a: i32) i32 { return a + 1; }',
  'pub fn main() void {',
  '    _ = save(helper(5));',
  '}',
].join('\n');

// Zig is NOT shipped by tree-sitter-wasms — it is VENDORED (prebuilt .wasm from
// @tree-sitter-grammars/* in vendored-grammars/). This proves the equalization
// path: vendor a wasm + ground a spec, no emscripten build. The route to 158.
test('breadth engine extracts a VENDORED grammar (Zig) — the equalization path', {
  skip: hasWasmGrammar('zig') ? false : 'zig grammar not vendored',
}, async () => {
  const r = await extractStructure('zig', ZIG);
  assert.ok(r, 'zig must be extractable from the vendored grammar');
  const fns = r!.functions.map(f => f.name).sort();
  assert.deepEqual(fns, ['helper', 'main', 'save'], `functions, got ${JSON.stringify(fns)}`);
  assert.ok(r!.calls.some(c => c.callee === 'store'), 'must capture the store() call');
});

const HASKELL = 'module M where\nsave x = store x\nhelper a = a + 1';

// Haskell is also VENDORED (prebuilt wasm from tree-sitter-haskell). A functional
// grammar that nonetheless grounds cleanly — second vendored language.
test('breadth engine extracts a VENDORED grammar (Haskell)', {
  skip: hasWasmGrammar('haskell') ? false : 'haskell grammar not vendored',
}, async () => {
  const r = await extractStructure('haskell', HASKELL);
  assert.ok(r, 'haskell must be extractable from the vendored grammar');
  const fns = r!.functions.map(f => f.name).sort();
  assert.deepEqual(fns, ['helper', 'save'], `functions, got ${JSON.stringify(fns)}`);
  assert.ok(r!.calls.some(c => c.callee === 'store'), 'must capture the store call');
});

test('breadth engine returns null for a grammar with no spec (graceful fallback)', async () => {
  const r = await extractStructure('definitely-not-a-language', 'x');
  assert.equal(r, null);
});

import { hasNativeGrammar } from '../../../../packages/analyzer-core/src/analyzer/core/native-parse';

// NATIVE parse stage (klauro-parse Rust binary) — breadth for grammars with no
// wasm. Erlang + Gleam have NO compatible wasm; they extract via the native
// binary through the same generic walker. Gated on the binary being built.
test('breadth engine extracts Erlang via the NATIVE parse stage (no wasm)', {
  skip: hasNativeGrammar('erlang') ? false : 'klauro-parse binary not built',
}, async () => {
  const r = await extractStructure('erlang', '-module(account).\nsave(X) -> store(X).\nhelper(A) -> A + 1.');
  assert.ok(r, 'erlang must extract via native');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
  assert.ok(r!.calls.some(c => c.callee === 'store'), 'must capture store() call');
});

test('breadth engine extracts Gleam via the NATIVE parse stage (no wasm)', {
  skip: hasNativeGrammar('gleam') ? false : 'klauro-parse binary not built',
}, async () => {
  const r = await extractStructure('gleam', 'pub fn save(x) { store(x) }\nfn helper(a) { a + 1 }');
  assert.ok(r, 'gleam must extract via native');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
  assert.ok(r!.calls.some(c => c.callee === 'store'), 'must capture store() call');
});

test('breadth engine extracts Fortran via NATIVE (name in subroutine_statement header)', {
  skip: hasNativeGrammar('fortran') ? false : 'klauro-parse binary not built',
}, async () => {
  const r = await extractStructure('fortran', 'subroutine save(x)\n  call store(x)\nend subroutine\nfunction helper(a)\nend function');
  assert.ok(r);
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

test('breadth engine extracts Elm via NATIVE fallback (wasm grammar broken)', {
  skip: hasNativeGrammar('elm') ? false : 'klauro-parse binary not built',
}, async () => {
  const r = await extractStructure('elm', 'module M exposing (..)\nsave x = store x\nhelper a = a + 1');
  assert.ok(r);
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
});

test('breadth engine extracts Ada via NATIVE parse stage', {
  skip: hasNativeGrammar('ada') ? false : 'klauro-parse binary not built',
}, async () => {
  const r = await extractStructure('ada', 'procedure Save (X : Integer) is\nbegin\n   Store (X);\nend Save;');
  assert.ok(r);
  assert.ok(r!.functions.some(f => f.name === 'Save'));
  assert.ok(r!.calls.some(c => c.callee === 'Store'));
});

// Second native batch — grammar crates compiled into klauro-parse, grounded
// specs. Proves the add-a-language loop scales: cargo add + match arm + spec.
test('breadth engine extracts Objective-C via NATIVE parse stage', {
  skip: hasNativeGrammar('objc') ? false : 'klauro-parse binary not built',
}, async () => {
  const r = await extractStructure('objc', '@implementation Foo\n- (void)save:(int)x { [self store:x]; }\n@end');
  assert.ok(r);
  assert.ok(r!.functions.some(f => f.name === 'save'), `fns ${JSON.stringify(r!.functions.map(f => f.name))}`);
  assert.ok(r!.classes.some(c => c.name === 'Foo'));
});

test('breadth engine extracts Perl via NATIVE parse stage', {
  skip: hasNativeGrammar('perl') ? false : 'klauro-parse binary not built',
}, async () => {
  const r = await extractStructure('perl', 'sub save { store($_[0]); }\nsub helper { return 1; }');
  assert.ok(r);
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

test('breadth engine extracts Odin via NATIVE parse stage', {
  skip: hasNativeGrammar('odin') ? false : 'klauro-parse binary not built',
}, async () => {
  const r = await extractStructure('odin', 'save :: proc(x: int) { store(x) }\nhelper :: proc(a: int) -> int { return a+1 }');
  assert.ok(r);
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

test('breadth engine extracts Pascal via NATIVE parse stage', {
  skip: hasNativeGrammar('pascal') ? false : 'klauro-parse binary not built',
}, async () => {
  const r = await extractStructure('pascal', 'procedure Save(x: Integer);\nbegin\n  Store(x);\nend;');
  assert.ok(r);
  assert.ok(r!.functions.some(f => f.name === 'Save'));
  assert.ok(r!.calls.some(c => c.callee === 'Store'));
});

test('breadth engine extracts Protobuf (service/rpc/message) via NATIVE parse stage', {
  skip: hasNativeGrammar('proto') ? false : 'klauro-parse binary not built',
}, async () => {
  const r = await extractStructure('proto', 'service S { rpc Save(Req) returns (Resp); }\nmessage Req { int32 x = 1; }');
  assert.ok(r);
  assert.ok(r!.functions.some(f => f.name === 'Save'), 'rpc Save is a function');
  assert.deepEqual(r!.classes.map(c => c.name).sort(), ['Req', 'S']);
});

// Third native batch — shader + shell + systems languages.
test('breadth engine extracts GLSL (shader) via NATIVE parse stage', {
  skip: hasNativeGrammar('glsl') ? false : 'klauro-parse binary not built',
}, async () => {
  const r = await extractStructure('glsl', 'void save(int x) { store(x); }\nint helper(int a) { return a+1; }');
  assert.ok(r);
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

test('breadth engine extracts HLSL (shader) via NATIVE parse stage', {
  skip: hasNativeGrammar('hlsl') ? false : 'klauro-parse binary not built',
}, async () => {
  const r = await extractStructure('hlsl', 'void save(int x) { store(x); }\nfloat helper(float a) { return a+1; }');
  assert.ok(r);
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

test('breadth engine extracts PowerShell via NATIVE parse stage', {
  skip: hasNativeGrammar('powershell') ? false : 'klauro-parse binary not built',
}, async () => {
  const r = await extractStructure('powershell', 'function Save { param($x) Store $x }\nfunction Helper { return 1 }');
  assert.ok(r);
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['Helper', 'Save']);
});

test('breadth engine extracts D via NATIVE parse stage', {
  skip: hasNativeGrammar('d') ? false : 'klauro-parse binary not built',
}, async () => {
  const r = await extractStructure('d', 'void save(int x) { store(x); }\nclass Svc { void run() {} }');
  assert.ok(r);
  assert.ok(r!.functions.some(f => f.name === 'save'));
  assert.ok(r!.classes.some(c => c.name === 'Svc'));
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

// LISP FAMILY via the per-grammar name-resolver hook (resolveName/declFilter) —
// the categorical unlock for homoiconic grammars where every form is a list.
test('breadth engine extracts Common Lisp via resolveName (defun_header)', {
  skip: hasNativeGrammar('commonlisp') ? false : 'klauro-parse binary not built',
}, async () => {
  const r = await extractStructure('commonlisp', '(defun save (x) (store x))\n(defmethod run ((a int)) 1)');
  assert.ok(r);
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['run', 'save']);
});

test('breadth engine extracts Scheme via declFilter+resolveName (list head = definer)', {
  skip: hasNativeGrammar('scheme') ? false : 'klauro-parse binary not built',
}, async () => {
  const r = await extractStructure('scheme', '(define (save x) (store x))\n(define (helper a) (+ a 1))');
  assert.ok(r);
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
});

test('breadth engine extracts Racket via declFilter+resolveName', {
  skip: hasNativeGrammar('racket') ? false : 'klauro-parse binary not built',
}, async () => {
  const r = await extractStructure('racket', '(define (save x) (store x))\n(define (helper a) (+ a 1))');
  assert.ok(r);
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
});

// Reclaimed via firstDescByType resolvers — wrapper-name grammars that defeated
// the generic descent are now grounded (verilog task/module, cmake function,
// groovy method). Proves the resolver hook generalizes beyond Lisp.
test('breadth engine extracts Verilog via resolveName (task/module names)', {
  skip: hasNativeGrammar('verilog') ? false : 'klauro-parse binary not built',
}, async () => {
  const r = await extractStructure('verilog', 'module top;\n  task save; endtask\n  function helper; endfunction\nendmodule');
  assert.ok(r);
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
  assert.ok(r!.classes.some(c => c.name === 'top'));
});

test('breadth engine extracts CMake via resolveName (function/macro names)', {
  skip: hasNativeGrammar('cmake') ? false : 'klauro-parse binary not built',
}, async () => {
  const r = await extractStructure('cmake', 'function(save x)\n  store(${x})\nendfunction()\nmacro(helper a)\nendmacro()');
  assert.ok(r);
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

test('breadth engine extracts Groovy via resolveName (identifier, not type_identifier)', {
  skip: hasNativeGrammar('groovy') ? false : 'klauro-parse binary not built',
}, async () => {
  const r = await extractStructure('groovy', 'class Svc { def save(x) { store(x) } }');
  assert.ok(r);
  assert.ok(r!.functions.some(f => f.name === 'save'));
  assert.ok(r!.classes.some(c => c.name === 'Svc'));
});

// Final in-binary grammars grounded — every grammar compiled into klauro-parse
// now has a verified spec. R (name <- function) and VHDL (process labels).
test('breadth engine extracts R via declFilter (name <- function) + library import', {
  skip: hasNativeGrammar('r') ? false : 'klauro-parse binary not built',
}, async () => {
  const r = await extractStructure('r', 'save <- function(x) store(x)\nhelper <- function(a) a+1\nlibrary(dplyr)');
  assert.ok(r);
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
  assert.ok(r!.calls.some(c => c.callee === 'store'));
  assert.ok(r!.imports.some(i => i.module.includes('library')));
});

test('breadth engine extracts VHDL via resolveName (architecture + labeled process)', {
  skip: hasNativeGrammar('vhdl') ? false : 'klauro-parse binary not built',
}, async () => {
  const r = await extractStructure('vhdl', 'architecture rtl of e is\nbegin\n  proc_save: process begin\n  end process;\nend;');
  assert.ok(r);
  assert.ok(r!.classes.some(c => c.name === 'rtl'));
  assert.ok(r!.functions.some(f => f.name === 'proc_save'), `fns ${JSON.stringify(r!.functions.map(f => f.name))}`);
});

test('breadth engine extracts Nix via NATIVE parse stage', {
  skip: hasNativeGrammar('nix') ? false : 'klauro-parse binary not built',
}, async () => {
  const r = await extractStructure('nix', '{ save = x: store x; helper = a: a + 1; }');
  assert.ok(r);
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

test('breadth engine extracts Jsonnet via NATIVE parse stage', {
  skip: hasNativeGrammar('jsonnet') ? false : 'klauro-parse binary not built',
}, async () => {
  const r = await extractStructure('jsonnet', '{\n  save(x): store(x),\n  helper(a): a + 1,\n}');
  assert.ok(r);
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
});

for (const [lang, src] of [
  ['gdscript', 'func save(x):\n  store(x)\nfunc helper(a):\n  return a + 1'],
  ['starlark', 'def save(x):\n    store(x)\ndef helper(a):\n    return a + 1'],
  ['slang', 'void save(int x) { store(x); }\nint helper(int a) { return a+1; }'],
] as [string, string][]) {
  test(`breadth engine extracts ${lang} via NATIVE parse stage`, {
    skip: hasNativeGrammar(lang) ? false : 'klauro-parse binary not built',
  }, async () => {
    const r = await extractStructure(lang, src);
    assert.ok(r);
    assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
    assert.ok(r!.calls.some(c => c.callee === 'store'));
  });
}

test('breadth engine extracts OCaml via NATIVE parse stage (let_binding, not value_definition)', {
  skip: hasNativeGrammar('ocaml') ? false : 'klauro-parse binary not built',
}, async () => {
  const r = await extractStructure('ocaml', 'let save x = store x\nlet helper a = a + 1');
  assert.ok(r);
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

test('breadth engine extracts Nickel via NATIVE parse stage (functions only)', {
  skip: hasNativeGrammar('nickel') ? false : 'klauro-parse binary not built',
}, async () => {
  const r = await extractStructure('nickel', 'let save = fun x => store x in\nlet helper = fun a => a + 1 in\nsave 5');
  assert.ok(r);
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
});

// CONFIG / MARKUP grammars (wasm) — declaration/block structure, not a call graph.
// Camp-B parity: codebase-memory indexes config/IaC/markup as graph nodes too.
const JSON_SRC = '{"name": "myapp", "save": {"retries": 3}, "list": [1,2]}';
test('breadth engine extracts JSON object keys', {
  skip: hasWasmGrammar('json') ? false : 'json grammar not shipped',
}, async () => {
  const r = await extractStructure('json', JSON_SRC);
  assert.ok(r, 'json must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['list', 'name', 'retries', 'save']);
});

const TOML_SRC = ['name = "myapp"', '', '[server]', 'port = 8080', '', '[db.pool]', 'size = 5'].join('\n');
test('breadth engine extracts TOML tables + keys', {
  skip: hasWasmGrammar('toml') ? false : 'toml grammar not shipped',
}, async () => {
  const r = await extractStructure('toml', TOML_SRC);
  assert.ok(r, 'toml must be extractable via the generic walker');
  assert.deepEqual(r!.classes.map(c => c.name).sort(), ['db.pool', 'server']);
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['name', 'port', 'size']);
});

const CSS_SRC = ['.foo { color: red; }', '#bar, .baz > a { margin: 0; }'].join('\n');
test('breadth engine extracts CSS rule selectors', {
  skip: hasWasmGrammar('css') ? false : 'css grammar not shipped',
}, async () => {
  const r = await extractStructure('css', CSS_SRC);
  assert.ok(r, 'css must be extractable via the generic walker');
  const rules = r!.classes.map(c => c.name);
  assert.ok(rules.includes('.foo'), `rules ${JSON.stringify(rules)}`);
  assert.ok(rules.some(s => s.includes('#bar')), `rules ${JSON.stringify(rules)}`);
});

const HTML_SRC = '<div class="x"><span>hi</span><a href="#">link</a></div>';
test('breadth engine extracts HTML element tags', {
  skip: hasWasmGrammar('html') ? false : 'html grammar not shipped',
}, async () => {
  const r = await extractStructure('html', HTML_SRC);
  assert.ok(r, 'html must be extractable via the generic walker');
  assert.deepEqual(r!.classes.map(c => c.name).sort(), ['a', 'div', 'span']);
});

// IaC / build / markup grammars (vendored wasm — the breadth path to 158).
const HCL_SRC = ['resource "aws_s3_bucket" "save" {', '  bucket = "store"', '}', 'variable "helper" {', '  default = "x"', '}'].join('\n');
test('breadth engine extracts HCL/Terraform blocks + attributes', {
  skip: hasWasmGrammar('hcl') ? false : 'hcl grammar not vendored',
}, async () => {
  const r = await extractStructure('hcl', HCL_SRC);
  assert.ok(r, 'hcl must be extractable via the generic walker');
  assert.deepEqual(r!.classes.map(c => c.name).sort(), ['helper', 'save']);
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['bucket', 'default']);
});

const MAKE_SRC = 'save: store\n\techo hi\nhelper:\n\techo bye';
test('breadth engine extracts Makefile targets', {
  skip: hasWasmGrammar('make') ? false : 'make grammar not vendored',
}, async () => {
  const r = await extractStructure('make', MAKE_SRC);
  assert.ok(r, 'make must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
});

const DOCKERFILE_SRC = 'FROM node:20 AS save\nRUN echo store\nCOPY . /app\nENTRYPOINT ["node"]';
test('breadth engine extracts Dockerfile stages + instructions', {
  skip: hasWasmGrammar('dockerfile') ? false : 'dockerfile grammar not vendored',
}, async () => {
  const r = await extractStructure('dockerfile', DOCKERFILE_SRC);
  assert.ok(r, 'dockerfile must be extractable via the generic walker');
  assert.deepEqual(r!.classes.map(c => c.name).sort(), ['save']);
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['COPY', 'ENTRYPOINT', 'RUN']);
});

const LATEX_SRC = '\\documentclass{article}\n\\newcommand{\\save}{store}\n\\newcommand{\\helper}{x}\n\\section{Intro}';
test('breadth engine extracts LaTeX commands + sections', {
  skip: hasWasmGrammar('latex') ? false : 'latex grammar not vendored',
}, async () => {
  const r = await extractStructure('latex', LATEX_SRC);
  assert.ok(r, 'latex must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
  assert.deepEqual(r!.classes.map(c => c.name).sort(), ['Intro']);
});

// Programming languages with real call graphs (vendored wasm; ABI-14 builds where
// no compatible prebuilt existed). The breadth path to 158 — parallel-sourced.
const JULIA_SRC = 'using Foo\nfunction save(x)\n    store(x)\nend\nfunction helper()\n    return 1\nend\nstruct Point\n    x::Int\nend';
test('breadth engine extracts Julia functions + struct', {
  skip: hasWasmGrammar('julia') ? false : 'julia grammar not vendored',
}, async () => {
  const r = await extractStructure('julia', JULIA_SRC);
  assert.ok(r, 'julia must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
  assert.ok(r!.classes.some(c => c.name === 'Point'), `classes ${JSON.stringify(r!.classes.map(c => c.name))}`);
});

const CLOJURE_SRC = '(ns my.app)\n(defn save [x]\n  (store x))\n(defn helper []\n  1)';
test('breadth engine extracts Clojure defn names', {
  skip: hasWasmGrammar('clojure') ? false : 'clojure grammar not vendored',
}, async () => {
  const r = await extractStructure('clojure', CLOJURE_SRC);
  assert.ok(r, 'clojure must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
});

const NIM_SRC = 'import os\nproc save(x: int) =\n  store(x)\nproc helper(): int =\n  1\ntype Point = object\n  x: int';
test('breadth engine extracts Nim procs + type + call', {
  skip: hasWasmGrammar('nim') ? false : 'nim grammar not vendored',
}, async () => {
  const r = await extractStructure('nim', NIM_SRC);
  assert.ok(r, 'nim must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
  assert.ok(r!.calls.some(c => c.callee === 'store'), 'must capture store() call');
});

const FSHARP_SRC = 'module M\nopen System\nlet save x =\n    store x\nlet helper () =\n    1\ntype Point = { x: int }';
test('breadth engine extracts F# bindings + call', {
  skip: hasWasmGrammar('fsharp') ? false : 'fsharp grammar not vendored',
}, async () => {
  const r = await extractStructure('fsharp', FSHARP_SRC);
  assert.ok(r, 'fsharp must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
  assert.ok(r!.calls.some(c => c.callee.includes('store')), 'must capture store call');
});

const CRYSTAL_SRC = 'require "json"\ndef save(x)\n  store(x)\nend\ndef helper\n  1\nend\nclass Point\n  def initialize(@x : Int32)\n  end\nend';
test('breadth engine extracts Crystal methods + class + call', {
  skip: hasWasmGrammar('crystal') ? false : 'crystal grammar not vendored',
}, async () => {
  const r = await extractStructure('crystal', CRYSTAL_SRC);
  assert.ok(r, 'crystal must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'initialize', 'save']);
  assert.ok(r!.calls.some(c => c.callee === 'store'), 'must capture store() call');
});

// More programming languages (vendored ABI-14 wasm, built from source — no CDN prebuilt).
const PURESCRIPT_SRC = 'module Main where\n\nimport Data.Maybe (Maybe(..))\n\ndata Item = Item String Int\n\nsave :: Item -> Effect Unit\nsave item = store item\n\nhelper :: Int -> Int\nhelper x = x + 1\n';
test('breadth engine extracts PureScript functions + data', {
  skip: hasWasmGrammar('purescript') ? false : 'purescript grammar not vendored',
}, async () => {
  const r = await extractStructure('purescript', PURESCRIPT_SRC);
  assert.ok(r, 'purescript must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
  assert.ok(r!.classes.some(c => c.name === 'Item'), `classes ${JSON.stringify(r!.classes.map(c => c.name))}`);
  assert.ok(r!.calls.some(c => c.callee === 'store'), 'must capture store call');
});

const REASON_SRC = 'type item = { name: string };\n\nlet save = (item) => {\n  store(item);\n};\n\nlet helper = (x) => x + 1;\n';
test('breadth engine extracts ReasonML bindings + type', {
  skip: hasWasmGrammar('reason') ? false : 'reason grammar not vendored',
}, async () => {
  const r = await extractStructure('reason', REASON_SRC);
  assert.ok(r, 'reason must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
  assert.ok(r!.classes.some(c => c.name === 'item'), `classes ${JSON.stringify(r!.classes.map(c => c.name))}`);
  assert.ok(r!.calls.some(c => c.callee === 'store'), 'must capture store call');
});

const PONY_SRC = 'class Item\n  let name: String\n\n  new create(n: String) =>\n    name = n\n\nactor Main\n  fun save(item: Item) =>\n    store(item)\n\n  fun helper(x: I32): I32 =>\n    x + 1\n';
test('breadth engine extracts Pony methods + class/actor + call', {
  skip: hasWasmGrammar('pony') ? false : 'pony grammar not vendored',
}, async () => {
  const r = await extractStructure('pony', PONY_SRC);
  assert.ok(r, 'pony must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['create', 'helper', 'save']);
  assert.deepEqual(r!.classes.map(c => c.name).sort(), ['Item', 'Main']);
  assert.ok(r!.calls.some(c => c.callee === 'store'), 'must capture store() call');
});

const TCL_SRC = 'proc save {item} {\n    store $item\n}\n\nproc helper {x} {\n    return [expr {$x + 1}]\n}\n';
test('breadth engine extracts Tcl procs + command call', {
  skip: hasWasmGrammar('tcl') ? false : 'tcl grammar not vendored',
}, async () => {
  const r = await extractStructure('tcl', TCL_SRC);
  assert.ok(r, 'tcl must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
  assert.ok(r!.calls.some(c => c.callee === 'store'), 'must capture store command');
});

const WREN_SRC = 'class Item {\n  construct new(name) {\n    _name = name\n  }\n\n  save(item) {\n    store.call(item)\n  }\n\n  helper(x) {\n    return x + 1\n  }\n}\n';
test('breadth engine extracts Wren methods + class', {
  skip: hasWasmGrammar('wren') ? false : 'wren grammar not vendored',
}, async () => {
  const r = await extractStructure('wren', WREN_SRC);
  assert.ok(r, 'wren must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'new', 'save']);
  assert.ok(r!.classes.some(c => c.name === 'Item'), `classes ${JSON.stringify(r!.classes.map(c => c.name))}`);
});

// Codex-sourced batch (vendored ABI-14 wasm, built from source).
const SQL_SRC = 'CREATE FUNCTION save(x integer) RETURNS integer AS $$\n  SELECT store(x);\n$$ LANGUAGE SQL;\nCREATE FUNCTION helper(a integer) RETURNS integer AS $$\n  SELECT a + 1;\n$$ LANGUAGE SQL;\nCREATE TABLE account (id integer);';
test('breadth engine extracts SQL functions + tables + calls', {
  skip: hasWasmGrammar('sql') ? false : 'sql grammar not vendored',
}, async () => {
  const r = await extractStructure('sql', SQL_SRC);
  assert.ok(r, 'sql must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
  assert.ok(r!.classes.some(c => c.name === 'account'), `classes ${JSON.stringify(r!.classes.map(c => c.name))}`);
  assert.ok(r!.calls.some(c => c.callee === 'store'), 'must capture store() invocation');
});

const GRAPHQL_SRC = 'type Account { id: ID }\nmutation save($x: ID!) { store(id: $x) { id } }\nquery helper { account { id } }';
test('breadth engine extracts GraphQL operations + types', {
  skip: hasWasmGrammar('graphql') ? false : 'graphql grammar not vendored',
}, async () => {
  const r = await extractStructure('graphql', GRAPHQL_SRC);
  assert.ok(r, 'graphql must be extractable via the generic walker');
  assert.ok(r!.functions.some(f => f.name === 'save') && r!.functions.some(f => f.name === 'helper'), `fns ${JSON.stringify(r!.functions.map(f => f.name))}`);
  assert.ok(r!.classes.some(c => c.name === 'Account'));
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

const XML_SRC = '<service>\n  <save><store id="x"/></save>\n  <helper><value>1</value></helper>\n</service>';
test('breadth engine extracts XML element names', {
  skip: hasWasmGrammar('xml') ? false : 'xml grammar not vendored',
}, async () => {
  const r = await extractStructure('xml', XML_SRC);
  assert.ok(r, 'xml must be extractable via the generic walker');
  assert.ok(r!.functions.some(f => f.name === 'save') && r!.functions.some(f => f.name === 'helper'), `els ${JSON.stringify(r!.functions.map(f => f.name))}`);
  assert.ok(r!.calls.some(c => c.callee === 'store'), 'empty-element <store/> is a call');
});

const VALA_SRC = 'class Service {\n  public int save(int x) { return store(x); }\n  public int helper(int a) { return a + 1; }\n  private int store(int x) { return x; }\n}';
test('breadth engine extracts Vala methods + class + call', {
  skip: hasWasmGrammar('vala') ? false : 'vala grammar not vendored',
}, async () => {
  const r = await extractStructure('vala', VALA_SRC);
  assert.ok(r, 'vala must be extractable via the generic walker');
  assert.ok(r!.functions.some(f => f.name === 'save') && r!.functions.some(f => f.name === 'helper'), `fns ${JSON.stringify(r!.functions.map(f => f.name))}`);
  assert.ok(r!.classes.some(c => c.name === 'Service'));
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

const HAXE_SRC = 'class Service {\n  public function save(x:Int):Int { store(x); }\n  public function helper(a:Int):Int { a; }\n  function store(x:Int):Int { x; }\n}';
test('breadth engine extracts Haxe functions + class + call', {
  skip: hasWasmGrammar('haxe') ? false : 'haxe grammar not vendored',
}, async () => {
  const r = await extractStructure('haxe', HAXE_SRC);
  assert.ok(r, 'haxe must be extractable via the generic walker');
  assert.ok(r!.functions.some(f => f.name === 'save') && r!.functions.some(f => f.name === 'helper'), `fns ${JSON.stringify(r!.functions.map(f => f.name))}`);
  assert.ok(r!.classes.some(c => c.name === 'Service'));
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

// Shader / GPU / query / web / legacy batch (vendored ABI-14 wasm, mostly built from source).
const WGSL_SRC = 'struct Light { pos: vec3<f32> }\nfn save(x: f32) -> f32 { return store(x); }\nfn helper() -> f32 { return 1.0; }';
test('breadth engine extracts WGSL functions + struct', {
  skip: hasWasmGrammar('wgsl') ? false : 'wgsl grammar not vendored',
}, async () => {
  const r = await extractStructure('wgsl', WGSL_SRC);
  assert.ok(r, 'wgsl must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
  assert.ok(r!.classes.some(c => c.name === 'Light'));
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

const CUDA_SRC = '#include <cstdio>\nstruct Mat { int n; };\n__global__ void save(int x) { store(x); }\n__device__ void helper() { }';
test('breadth engine extracts CUDA functions + struct + call', {
  skip: hasWasmGrammar('cuda') ? false : 'cuda grammar not vendored',
}, async () => {
  const r = await extractStructure('cuda', CUDA_SRC);
  assert.ok(r, 'cuda must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
  assert.ok(r!.classes.some(c => c.name === 'Mat'));
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

const PRQL_SRC = 'let save temp -> (temp - 32) / 1.8\n\nlet helper temp -> temp + 1\n\nfrom cities\nderive x = (store temp)';
test('breadth engine extracts PRQL function definitions', {
  skip: hasWasmGrammar('prql') ? false : 'prql grammar not vendored',
}, async () => {
  const r = await extractStructure('prql', PRQL_SRC);
  assert.ok(r, 'prql must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

const HACK_SRC = 'class Mat { public function m(): void {} }\nfunction save(int $x): void { store($x); }\nfunction helper(): void {}';
test('breadth engine extracts Hack functions + class + call', {
  skip: hasWasmGrammar('hack') ? false : 'hack grammar not vendored',
}, async () => {
  const r = await extractStructure('hack', HACK_SRC);
  assert.ok(r, 'hack must be extractable via the generic walker');
  assert.ok(r!.functions.some(f => f.name === 'save') && r!.functions.some(f => f.name === 'helper'), `fns ${JSON.stringify(r!.functions.map(f => f.name))}`);
  assert.ok(r!.classes.some(c => c.name === 'Mat'));
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

const COBOL_SRC = [
  '       IDENTIFICATION DIVISION.',
  '       PROGRAM-ID. SAVE.',
  '       PROCEDURE DIVISION.',
  '       SAVE-PARA.',
  '           CALL "STORE".',
  '       HELPER-PARA.',
  '           DISPLAY "HI".',
].join('\n');
test('breadth engine extracts COBOL paragraphs + program', {
  skip: hasWasmGrammar('cobol') ? false : 'cobol grammar not vendored',
}, async () => {
  const r = await extractStructure('cobol', COBOL_SRC);
  assert.ok(r, 'cobol must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['HELPER-PARA', 'SAVE-PARA']);
  assert.ok(r!.classes.some(c => c.name === 'SAVE'));
  assert.ok(r!.calls.some(c => c.callee.includes('STORE')), `calls ${JSON.stringify(r!.calls.map(c => c.callee))}`);
});

// IDL / schema / config grammars (vendored ABI-14 wasm, built from source).
const CAPNP_SRC = 'struct Account { id @0 :UInt64; }\ninterface Store { save @0 () -> (); helper @1 () -> (); }';
test('breadth engine extracts Cap\'n Proto structs + methods', {
  skip: hasWasmGrammar('capnp') ? false : 'capnp grammar not vendored',
}, async () => {
  const r = await extractStructure('capnp', CAPNP_SRC);
  assert.ok(r, 'capnp must be extractable via the generic walker');
  assert.ok(r!.classes.some(c => c.name === 'Account') && r!.classes.some(c => c.name === 'Store'), `classes ${JSON.stringify(r!.classes.map(c => c.name))}`);
  assert.ok(r!.functions.some(f => f.name === 'save') && r!.functions.some(f => f.name === 'helper'), `fns ${JSON.stringify(r!.functions.map(f => f.name))}`);
});

const THRIFT_SRC = 'struct Account { 1: i64 id }\nservice Store { bool save(1: Account a), void helper() }';
test('breadth engine extracts Thrift structs + service functions', {
  skip: hasWasmGrammar('thrift') ? false : 'thrift grammar not vendored',
}, async () => {
  const r = await extractStructure('thrift', THRIFT_SRC);
  assert.ok(r, 'thrift must be extractable via the generic walker');
  assert.ok(r!.classes.some(c => c.name === 'Account') && r!.classes.some(c => c.name === 'Store'), `classes ${JSON.stringify(r!.classes.map(c => c.name))}`);
  assert.ok(r!.functions.some(f => f.name === 'save') && r!.functions.some(f => f.name === 'helper'), `fns ${JSON.stringify(r!.functions.map(f => f.name))}`);
});

const SMITHY_SRC = '$version: "2.0"\nnamespace com.example\nstructure Account { id: Long }\nservice Store { operations: [Save] }\noperation Save { input: Account }\noperation Helper {}';
test('breadth engine extracts Smithy shapes + operations', {
  skip: hasWasmGrammar('smithy') ? false : 'smithy grammar not vendored',
}, async () => {
  const r = await extractStructure('smithy', SMITHY_SRC);
  assert.ok(r, 'smithy must be extractable via the generic walker');
  assert.ok(r!.classes.some(c => c.name === 'Account') && r!.classes.some(c => c.name === 'Store'), `classes ${JSON.stringify(r!.classes.map(c => c.name))}`);
  assert.ok(r!.functions.some(f => f.name === 'Save') && r!.functions.some(f => f.name === 'Helper'), `fns ${JSON.stringify(r!.functions.map(f => f.name))}`);
});

const HOCON_SRC = 'account { id = 1 }\nstore { save = true, helper = false }';
test('breadth engine extracts HOCON keys', {
  skip: hasWasmGrammar('hocon') ? false : 'hocon grammar not vendored',
}, async () => {
  const r = await extractStructure('hocon', HOCON_SRC);
  assert.ok(r, 'hocon must be extractable via the generic walker');
  const keys = r!.functions.map(f => f.name);
  assert.ok(['account', 'store', 'save', 'helper'].every(k => keys.includes(k)), `keys ${JSON.stringify(keys)}`);
});

const DHALL_SRC = 'let Account = 1\nlet save = 2\nlet helper = 3\nin save';
test('breadth engine extracts Dhall let bindings', {
  skip: hasWasmGrammar('dhall') ? false : 'dhall grammar not vendored',
}, async () => {
  const r = await extractStructure('dhall', DHALL_SRC);
  assert.ok(r, 'dhall must be extractable via the generic walker');
  const names = r!.functions.map(f => f.name);
  assert.ok(['Account', 'save', 'helper'].every(n => names.includes(n)), `names ${JSON.stringify(names)}`);
});

// Config grammars (vendored ABI-14 wasm; yaml is a REPAIRED rebuild over the broken shipped one).
const YAML_SRC = 'name: x\nsave: y\nport: 8080';
test('breadth engine extracts YAML mapping keys', {
  skip: hasWasmGrammar('yaml') ? false : 'yaml grammar not vendored',
}, async () => {
  const r = await extractStructure('yaml', YAML_SRC);
  assert.ok(r, 'yaml must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['name', 'port', 'save']);
});

const KDL_SRC = 'server host="localhost" {\n  route "/api" method="GET"\n}\n';
test('breadth engine extracts KDL nodes', {
  skip: hasWasmGrammar('kdl') ? false : 'kdl grammar not vendored',
}, async () => {
  const r = await extractStructure('kdl', KDL_SRC);
  assert.ok(r, 'kdl must be extractable via the generic walker');
  assert.deepEqual(r!.classes.map(c => c.name).sort(), ['route', 'server']);
});

const CUE_SRC = 'package app\n\nserver: {\n  port: 8080\n  host: "localhost"\n}\n';
test('breadth engine extracts CUE fields', {
  skip: hasWasmGrammar('cue') ? false : 'cue grammar not vendored',
}, async () => {
  const r = await extractStructure('cue', CUE_SRC);
  assert.ok(r, 'cue must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['host', 'port', 'server']);
});

const NGINX_SRC = 'http {\n  server {\n    listen 80;\n    location /api {\n      proxy_pass http://backend;\n    }\n  }\n}\n';
test('breadth engine extracts NGINX directives and locations', {
  skip: hasWasmGrammar('nginx') ? false : 'nginx grammar not vendored',
}, async () => {
  const r = await extractStructure('nginx', NGINX_SRC);
  assert.ok(r, 'nginx must be extractable via the generic walker');
  assert.deepEqual(r!.classes.map(c => c.name).sort(), ['http', 'listen', 'location /api', 'proxy_pass', 'server']);
});

const INI_SRC = 'name=x\n[server]\nport=8080\nhost=localhost\n';
test('breadth engine extracts INI sections and settings', {
  skip: hasWasmGrammar('ini') ? false : 'ini grammar not vendored',
}, async () => {
  const r = await extractStructure('ini', INI_SRC);
  assert.ok(r, 'ini must be extractable via the generic walker');
  assert.deepEqual(r!.classes.map(c => c.name).sort(), ['server']);
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['host', 'name', 'port']);
});

// More programming languages (vendored ABI-14 wasm, built from source).
const SML_SRC = 'structure Store = struct\n  fun save x = store x\n  fun helper a = a + 1\nend';
test('breadth engine extracts Standard ML structure', {
  skip: hasWasmGrammar('sml') ? false : 'sml grammar not vendored',
}, async () => {
  const r = await extractStructure('sml', SML_SRC);
  assert.ok(r, 'sml must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
  assert.ok(r!.classes.some(c => c.name === 'Store'));
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

const HARE_SRC = 'use os;\nfn save(x: int) int = store(x);\nfn helper(a: int) int = a + 1;\ntype point = struct { x: int, y: int };';
test('breadth engine extracts Hare structure', {
  skip: hasWasmGrammar('hare') ? false : 'hare grammar not vendored',
}, async () => {
  const r = await extractStructure('hare', HARE_SRC);
  assert.ok(r, 'hare must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
  assert.ok(r!.classes.some(c => c.name === 'point'));
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

const GREN_SRC = 'module Main exposing (..)\n\nimport Json.Decode\n\nsave x =\n    store x\n\nhelper a =\n    a + 1\n\ntype Point = Point Int Int';
test('breadth engine extracts Gren structure', {
  skip: hasWasmGrammar('gren') ? false : 'gren grammar not vendored',
}, async () => {
  const r = await extractStructure('gren', GREN_SRC);
  assert.ok(r, 'gren must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
  assert.ok(r!.classes.some(c => c.name === 'Point'));
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

const BALLERINA_SRC = 'import ballerina/io;\n\nfunction save(int x) returns int {\n    return store(x);\n}\n\nfunction helper(int a) returns int {\n    return a + 1;\n}\n\nclass Point {\n    int x = 0;\n}';
test('breadth engine extracts Ballerina structure', {
  skip: hasWasmGrammar('ballerina') ? false : 'ballerina grammar not vendored',
}, async () => {
  const r = await extractStructure('ballerina', BALLERINA_SRC);
  assert.ok(r, 'ballerina must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
  assert.ok(r!.classes.some(c => c.name === 'Point'));
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

const GRAIN_SRC = 'module Main\n\nfrom "list" include List\n\nlet save = (x) => store(x)\n\nlet helper = (a) => a + 1\n\nrecord Point { x: Number, y: Number }';
test('breadth engine extracts Grain structure', {
  skip: hasWasmGrammar('grain') ? false : 'grain grammar not vendored',
}, async () => {
  const r = await extractStructure('grain', GRAIN_SRC);
  assert.ok(r, 'grain must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
  assert.ok(r!.classes.some(c => c.name === 'Point'));
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

// Scripting / query / config (vendored wasm; most built from source at ABI 14).
const AWK_SRC = 'function save(x) { store(x) }\nfunction helper() { print "hi" }\n';
test('breadth engine extracts AWK functions + calls', {
  skip: hasWasmGrammar('awk') ? false : 'awk grammar not vendored',
}, async () => {
  const r = await extractStructure('awk', AWK_SRC);
  assert.ok(r, 'awk must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

const FISH_SRC = 'function save\n  store $argv\nend\nfunction helper\n  echo hi\nend\n';
test('breadth engine extracts Fish functions + commands', {
  skip: hasWasmGrammar('fish') ? false : 'fish grammar not vendored',
}, async () => {
  const r = await extractStructure('fish', FISH_SRC);
  assert.ok(r, 'fish must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

const JQ_SRC = 'def save(x): store(x);\ndef helper: save(.y);\n';
test('breadth engine extracts jq definitions + calls', {
  skip: hasWasmGrammar('jq') ? false : 'jq grammar not vendored',
}, async () => {
  const r = await extractStructure('jq', JQ_SRC);
  assert.ok(r, 'jq must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

const JUST_SRC = 'save:\n    store\n\nhelper:\n    echo hi\n';
test('breadth engine extracts just recipes', {
  skip: hasWasmGrammar('just') ? false : 'just grammar not vendored',
}, async () => {
  const r = await extractStructure('just', JUST_SRC);
  assert.ok(r, 'just must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
});

const PKL_SRC = 'import "foo.pkl"\nclass Save {\n  store: String\n}\nfunction helper() = 1\nname = "x"\n';
test('breadth engine extracts Pkl class + method + property', {
  skip: hasWasmGrammar('pkl') ? false : 'pkl grammar not vendored',
}, async () => {
  const r = await extractStructure('pkl', PKL_SRC);
  assert.ok(r, 'pkl must be extractable via the generic walker');
  assert.ok(r!.classes.some(c => c.name === 'Save'), `classes ${JSON.stringify(r!.classes.map(c => c.name))}`);
  assert.ok(r!.functions.some(f => f.name === 'helper'), `fns ${JSON.stringify(r!.functions.map(f => f.name))}`);
});

// Markup / Lisp / shell-DSL (vendored ABI-14 wasm, built from source).
const TYPST_SRC = '#let thing = 5\n#let save(x) = {\n  store(x)\n}\n#let helper(a) = a + 1\n= Heading One\n#save(helper(5))\n#import "utils.typ": foo';
test('breadth engine extracts Typst structure', {
  skip: hasWasmGrammar('typst') ? false : 'typst grammar not vendored',
}, async () => {
  const r = await extractStructure('typst', TYPST_SRC);
  assert.ok(r, 'typst must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
  assert.ok(r!.classes.some(c => c.name === 'Heading One'));
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

const JANET_SRC = '(import json)\n(defn save [x]\n  (store x))\n(defn helper [a] (+ a 1))\n(def thing 5)\n(save (helper 5))';
test('breadth engine extracts Janet structure', {
  skip: hasWasmGrammar('janet') ? false : 'janet grammar not vendored',
}, async () => {
  const r = await extractStructure('janet', JANET_SRC);
  assert.ok(r, 'janet must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
});

const FENNEL_SRC = '(local json (require :json))\n(fn save [x]\n  (store x))\n(fn helper [a] (+ a 1))\n(save (helper 5))';
test('breadth engine extracts Fennel structure', {
  skip: hasWasmGrammar('fennel') ? false : 'fennel grammar not vendored',
}, async () => {
  const r = await extractStructure('fennel', FENNEL_SRC);
  assert.ok(r, 'fennel must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

const NU_SRC = 'def save [x] {\n  store $x\n}\ndef helper [a] { $a + 1 }\nuse utils.nu foo\nsave (helper 5)';
test('breadth engine extracts Nushell structure', {
  skip: hasWasmGrammar('nu') ? false : 'nu grammar not vendored',
}, async () => {
  const r = await extractStructure('nu', NU_SRC);
  assert.ok(r, 'nu must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

const ORG_SRC = '* Heading One\nsome text\n** Subheading Two\nmore text';
test('breadth engine extracts Org-mode outline', {
  skip: hasWasmGrammar('org') ? false : 'org grammar not vendored',
}, async () => {
  const r = await extractStructure('org', ORG_SRC);
  assert.ok(r, 'org must be extractable via the generic walker');
  assert.deepEqual(r!.classes.map(c => c.name).sort(), ['Heading One', 'Subheading Two']);
});

// Editor/CRM/IaC/policy languages (vendored ABI-14 wasm, Codex-sourced).
const VIM_SRC = 'function! save(x)\n  call store(a:x)\nendfunction\nfunction! helper(a)\n  return a:a\nendfunction';
test('breadth engine extracts Vimscript functions', {
  skip: hasWasmGrammar('vim') ? false : 'vim grammar not vendored',
}, async () => {
  const r = await extractStructure('vim', VIM_SRC);
  assert.ok(r, 'vim must be extractable via the generic walker');
  assert.ok(r!.functions.some(f => f.name === 'save') && r!.functions.some(f => f.name === 'helper'), `fns ${JSON.stringify(r!.functions.map(f => f.name))}`);
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

const APEX_SRC = 'public class SaveService {\n  public void save(Integer x) { store(x); }\n  private Integer helper(Integer a) { return a + 1; }\n}';
test('breadth engine extracts Apex class + methods', {
  skip: hasWasmGrammar('apex') ? false : 'apex grammar not vendored',
}, async () => {
  const r = await extractStructure('apex', APEX_SRC);
  assert.ok(r, 'apex must be extractable via the generic walker');
  assert.ok(r!.functions.some(f => f.name === 'save') && r!.functions.some(f => f.name === 'helper'), `fns ${JSON.stringify(r!.functions.map(f => f.name))}`);
  assert.ok(r!.classes.some(c => c.name === 'SaveService'));
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

const BICEP_SRC = "resource store 'T@1' = { name: 'x' }\noutput save string = store('x')\nmodule helper './h.bicep' = { name: 'helper' }";
test('breadth engine extracts Bicep declarations', {
  skip: hasWasmGrammar('bicep') ? false : 'bicep grammar not vendored',
}, async () => {
  const r = await extractStructure('bicep', BICEP_SRC);
  assert.ok(r, 'bicep must be extractable via the generic walker');
  assert.ok(r!.functions.some(f => f.name === 'save') && r!.functions.some(f => f.name === 'helper'), `fns ${JSON.stringify(r!.functions.map(f => f.name))}`);
  assert.ok(r!.classes.some(c => c.name === 'store'));
});

const PUPPET_SRC = 'function save($x) { store($x) }\nfunction helper($a) { $a }\nclass box {}';
test('breadth engine extracts Puppet functions + class', {
  skip: hasWasmGrammar('puppet') ? false : 'puppet grammar not vendored',
}, async () => {
  const r = await extractStructure('puppet', PUPPET_SRC);
  assert.ok(r, 'puppet must be extractable via the generic walker');
  assert.ok(r!.functions.some(f => f.name === 'save') && r!.functions.some(f => f.name === 'helper'), `fns ${JSON.stringify(r!.functions.map(f => f.name))}`);
  assert.ok(r!.classes.some(c => c.name === 'box'));
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

const REGO_SRC = 'package example\nimport data.store\nsave if { store.allow }\nhelper := 1';
test('breadth engine extracts Rego rules', {
  skip: hasWasmGrammar('rego') ? false : 'rego grammar not vendored',
}, async () => {
  const r = await extractStructure('rego', REGO_SRC);
  assert.ok(r, 'rego must be extractable via the generic walker');
  assert.ok(r!.functions.some(f => f.name === 'save') && r!.functions.some(f => f.name === 'helper'), `fns ${JSON.stringify(r!.functions.map(f => f.name))}`);
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

// DSL / data / markup (vendored ABI-14 wasm, built from source).
test('breadth engine extracts regex named groups', {
  skip: hasWasmGrammar('regex') ? false : 'regex grammar not vendored',
}, async () => {
  const r = await extractStructure('regex', '(?<year>\\d{4})-(?<month>\\d{2})(foo)(?:bar)');
  assert.ok(r, 'regex must be extractable via the generic walker');
  assert.ok(r!.functions.some(f => f.name === 'year') && r!.functions.some(f => f.name === 'month'), `fns ${JSON.stringify(r!.functions.map(f => f.name))}`);
});

test('breadth engine extracts Mermaid flowchart', {
  skip: hasWasmGrammar('mermaid') ? false : 'mermaid grammar not vendored',
}, async () => {
  const r = await extractStructure('mermaid', 'flowchart TD\n  A[Start] --> B{Decision}\n  C[End]');
  assert.ok(r, 'mermaid must be extractable via the generic walker');
  assert.ok(r!.classes.length >= 1);
  assert.ok(r!.functions.some(f => f.name === 'A'), `verts ${JSON.stringify(r!.functions.map(f => f.name))}`);
});

test('breadth engine extracts YARA rule', {
  skip: hasWasmGrammar('yara') ? false : 'yara grammar not vendored',
}, async () => {
  const r = await extractStructure('yara', 'import "pe"\nrule SilentBanker : banker {\n strings:\n  $a = "abc"\n condition:\n  $a\n}');
  assert.ok(r, 'yara must be extractable via the generic walker');
  assert.ok(r!.classes.some(c => c.name === 'SilentBanker'), `classes ${JSON.stringify(r!.classes.map(c => c.name))}`);
});

test('breadth engine extracts JSON5 keys', {
  skip: hasWasmGrammar('json5') ? false : 'json5 grammar not vendored',
}, async () => {
  const r = await extractStructure('json5', '{\n  name: "klauro",\n  version: 1.5,\n  nested: { key: true },\n}');
  assert.ok(r, 'json5 must be extractable via the generic walker');
  assert.ok(r!.functions.some(f => f.name === 'name') && r!.functions.some(f => f.name === 'version'), `keys ${JSON.stringify(r!.functions.map(f => f.name))}`);
});

test('breadth engine extracts RON structs', {
  skip: hasWasmGrammar('ron') ? false : 'ron grammar not vendored',
}, async () => {
  const r = await extractStructure('ron', 'Scene(\n  materials: {\n    "metal": (reflectivity: 1.0),\n  },\n  hero: Entity(name: "x"),\n)');
  assert.ok(r, 'ron must be extractable via the generic walker');
  assert.ok(r!.classes.some(c => c.name === 'Scene') && r!.classes.some(c => c.name === 'Entity'), `classes ${JSON.stringify(r!.classes.map(c => c.name))}`);
});

// Hardware / bibliography / templates (vendored ABI-14 wasm, built from source).
const SYSTEMVERILOG_SRC = ['module save;', '  function int helper(int a);', '    return a + 1;', '  endfunction', '  task store(input int x);', '  endtask', 'endmodule'].join('\n');
test('breadth engine extracts SystemVerilog structure', {
  skip: hasWasmGrammar('systemverilog') ? false : 'systemverilog grammar not vendored',
}, async () => {
  const r = await extractStructure('systemverilog', SYSTEMVERILOG_SRC);
  assert.ok(r, 'systemverilog must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'store']);
  assert.ok(r!.classes.some(c => c.name === 'save'));
});

const BIBTEX_SRC = ['@article{save,', '  author = {Store, A},', '  title = {Hello}', '}', '@book{helper, title = {World}}'].join('\n');
test('breadth engine extracts BibTeX entries', {
  skip: hasWasmGrammar('bibtex') ? false : 'bibtex grammar not vendored',
}, async () => {
  const r = await extractStructure('bibtex', BIBTEX_SRC);
  assert.ok(r, 'bibtex must be extractable via the generic walker');
  assert.deepEqual(r!.classes.map(c => c.name).sort(), ['helper', 'save']);
  assert.ok(r!.functions.length >= 2);
});

const TWIG_SRC = ['{% block save %}', '  {{ store(x) }}', '{% endblock %}', '{% macro helper(a) %}{{ a }}{% endmacro %}', "{% include 'foo.html' %}"].join('\n');
test('breadth engine extracts Twig structure', {
  skip: hasWasmGrammar('twig') ? false : 'twig grammar not vendored',
}, async () => {
  const r = await extractStructure('twig', TWIG_SRC);
  assert.ok(r, 'twig must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
  assert.ok(r!.calls.some(c => c.callee === 'store'));
  assert.ok(r!.imports.length >= 1);
});

const BLADE_SRC = ['@section("save")', '  {{ store($x) }}', '@endsection', '@php function helper($a) { return $a; } @endphp', "@include('foo')"].join('\n');
test('breadth engine extracts Blade sections', {
  skip: hasWasmGrammar('blade') ? false : 'blade grammar not vendored',
}, async () => {
  const r = await extractStructure('blade', BLADE_SRC);
  assert.ok(r, 'blade must be extractable via the generic walker');
  assert.ok(r!.classes.some(c => c.name === 'save'), `classes ${JSON.stringify(r!.classes.map(c => c.name))}`);
});

const LIQUID_SRC = ['{% if save %}{{ store }}{% endif %}', '{% assign helper = 1 %}', '{% render "foo" %}', '{{ x | upcase }}'].join('\n');
test('breadth engine extracts Liquid structure', {
  skip: hasWasmGrammar('liquid') ? false : 'liquid grammar not vendored',
}, async () => {
  const r = await extractStructure('liquid', LIQUID_SRC);
  assert.ok(r, 'liquid must be extractable via the generic walker');
  assert.ok(r!.functions.some(f => f.name === 'helper'), `fns ${JSON.stringify(r!.functions.map(f => f.name))}`);
  assert.ok(r!.imports.length >= 1);
});

// Network/hardware/IDL configs (vendored ABI-14 wasm, Codex-sourced; specs grounded here).
const YANG_SRC = 'module save {\n  container store {\n    leaf helper { type string; }\n  }\n}';
test('breadth engine extracts YANG modules + leaves', {
  skip: hasWasmGrammar('yang') ? false : 'yang grammar not vendored',
}, async () => {
  const r = await extractStructure('yang', YANG_SRC);
  assert.ok(r, 'yang must be extractable via the generic walker');
  const names = r!.classes.map(c => c.name);
  assert.ok(['save', 'store', 'helper'].every(n => names.includes(n)), `nodes ${JSON.stringify(names)}`);
});

const P4_SRC = 'control save() {\n  action store() {}\n  apply {}\n}';
test('breadth engine extracts P4 controls + actions', {
  skip: hasWasmGrammar('p4') ? false : 'p4 grammar not vendored',
}, async () => {
  const r = await extractStructure('p4', P4_SRC);
  assert.ok(r, 'p4 must be extractable via the generic walker');
  assert.ok(r!.classes.some(c => c.name === 'save'), `classes ${JSON.stringify(r!.classes.map(c => c.name))}`);
  assert.ok(r!.functions.some(f => f.name === 'store'), `fns ${JSON.stringify(r!.functions.map(f => f.name))}`);
});

const DTS_SRC = '/ {\n  soc {\n    uart0: serial { };\n  };\n};';
test('breadth engine extracts Devicetree nodes', {
  skip: hasWasmGrammar('devicetree') ? false : 'devicetree grammar not vendored',
}, async () => {
  const r = await extractStructure('devicetree', DTS_SRC);
  assert.ok(r, 'devicetree must be extractable via the generic walker');
  assert.ok(r!.classes.some(c => c.name === 'soc') && r!.classes.some(c => c.name === 'uart0'), `nodes ${JSON.stringify(r!.classes.map(c => c.name))}`);
});

const KCONFIG_SRC = 'config SAVE\n\tbool "x"\nmenu "store"\nendmenu';
test('breadth engine extracts Kconfig configs + menus', {
  skip: hasWasmGrammar('kconfig') ? false : 'kconfig grammar not vendored',
}, async () => {
  const r = await extractStructure('kconfig', KCONFIG_SRC);
  assert.ok(r, 'kconfig must be extractable via the generic walker');
  assert.ok(r!.functions.some(f => f.name === 'SAVE'), `fns ${JSON.stringify(r!.functions.map(f => f.name))}`);
  assert.ok(r!.classes.some(c => c.name === 'store'), `classes ${JSON.stringify(r!.classes.map(c => c.name))}`);
});

const MLIR_SRC = 'func.func @save() {\n  return\n}\nfunc.func @helper() { return }';
test('breadth engine extracts MLIR operations', {
  skip: hasWasmGrammar('mlir') ? false : 'mlir grammar not vendored',
}, async () => {
  const r = await extractStructure('mlir', MLIR_SRC);
  assert.ok(r, 'mlir must be extractable via the generic walker');
  assert.ok(r!.functions.some(f => f.name === 'save') && r!.functions.some(f => f.name === 'helper'), `fns ${JSON.stringify(r!.functions.map(f => f.name))}`);
});

// Query / spec / register / accounting DSLs (vendored or on-disk wasm).
const QL_SRC = 'import javascript\nclass EmptyBlock extends BlockStmt { predicate isReported() { any() } }\npredicate isSmall(int x) { x < 10 }\n';
test('breadth engine extracts CodeQL predicates + classes', {
  skip: hasWasmGrammar('ql') ? false : 'ql grammar not vendored',
}, async () => {
  const r = await extractStructure('ql', QL_SRC);
  assert.ok(r, 'ql must be extractable via the generic walker');
  assert.ok(r!.functions.some(f => f.name === 'isSmall'), `fns ${JSON.stringify(r!.functions.map(f => f.name))}`);
  assert.ok(r!.classes.some(c => c.name === 'EmptyBlock'));
});

const TLAPLUS_SRC = '---- MODULE Counter ----\nEXTENDS Naturals\nVARIABLE count\nInit == count = 0\nNext == count\' = count + 1\n====\n';
test('breadth engine extracts TLA+ operators + module', {
  skip: hasWasmGrammar('tlaplus') ? false : 'tlaplus grammar not vendored',
}, async () => {
  const r = await extractStructure('tlaplus', TLAPLUS_SRC);
  assert.ok(r, 'tlaplus must be extractable via the generic walker');
  assert.ok(r!.functions.some(f => f.name === 'Init'), `fns ${JSON.stringify(r!.functions.map(f => f.name))}`);
  assert.ok(r!.classes.some(c => c.name === 'Counter'));
});

const SYSTEMRDL_SRC = 'addrmap my_map {\n  reg ctrl_reg { field { sw=rw; } data[31:0]; } ctrl @ 0x0;\n};\n';
test('breadth engine extracts SystemRDL components', {
  skip: hasWasmGrammar('systemrdl') ? false : 'systemrdl grammar not vendored',
}, async () => {
  const r = await extractStructure('systemrdl', SYSTEMRDL_SRC);
  assert.ok(r, 'systemrdl must be extractable via the generic walker');
  assert.ok(r!.classes.some(c => c.name === 'my_map'), `classes ${JSON.stringify(r!.classes.map(c => c.name))}`);
  assert.ok(r!.functions.some(f => f.name === 'ctrl'), `fns ${JSON.stringify(r!.functions.map(f => f.name))}`);
});

const BEANCOUNT_SRC = '2014-01-01 open Assets:Checking USD\n2014-05-05 * "Cafe" "Coffee"\n  Expenses:Food 5.00 USD\n  Assets:Checking\n';
test('breadth engine extracts Beancount transactions + accounts', {
  skip: hasWasmGrammar('beancount') ? false : 'beancount grammar not vendored',
}, async () => {
  const r = await extractStructure('beancount', BEANCOUNT_SRC);
  assert.ok(r, 'beancount must be extractable via the generic walker');
  assert.ok(r!.functions.some(f => f.name === 'Cafe'), `fns ${JSON.stringify(r!.functions.map(f => f.name))}`);
  assert.ok(r!.classes.some(c => c.name === 'Assets:Checking'));
});

const LEDGER_SRC = '2024-01-15 * Grocery Store\n    Expenses:Food  $50.00\n    Assets:Checking\n\naccount Assets:Checking\n';
test('breadth engine extracts Ledger transactions + accounts', {
  skip: hasWasmGrammar('ledger') ? false : 'ledger grammar not vendored',
}, async () => {
  const r = await extractStructure('ledger', LEDGER_SRC);
  assert.ok(r, 'ledger must be extractable via the generic walker');
  assert.ok(r!.functions.some(f => f.name === 'Grocery Store'), `fns ${JSON.stringify(r!.functions.map(f => f.name))}`);
  assert.ok(r!.classes.some(c => c.name === 'Assets:Checking'));
});

// Blockchain languages (vendored ABI-14 wasm) — full call graphs.
const MOVE_SRC = `module 0x1::save_module {\n  use 0x1::vector;\n  struct Store has key { value: u64 }\n  public entry fun save(value: u64) { store(value); }\n  fun store(value: u64) { helper(value); }\n  fun helper(value: u64): u64 { value }\n}`;
test('breadth engine extracts Move modules + structs + functions', {
  skip: hasWasmGrammar('move') ? false : 'move grammar not vendored',
}, async () => {
  const r = await extractStructure('move', MOVE_SRC);
  assert.ok(r, 'move must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save', 'store']);
  assert.ok(r!.classes.some(c => c.name === 'save_module') && r!.classes.some(c => c.name === 'Store'));
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

const CAIRO_SRC = `mod save_module {\n  use starknet::ContractAddress;\n  struct Store { value: felt252, }\n  fn save(value: felt252) { store(value); }\n  fn store(value: felt252) { helper(value); }\n  fn helper(value: felt252) -> felt252 { value }\n}`;
test('breadth engine extracts Cairo modules + structs + functions', {
  skip: hasWasmGrammar('cairo') ? false : 'cairo grammar not vendored',
}, async () => {
  const r = await extractStructure('cairo', CAIRO_SRC);
  assert.ok(r, 'cairo must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save', 'store']);
  assert.ok(r!.classes.some(c => c.name === 'save_module') && r!.classes.some(c => c.name === 'Store'));
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

const SWAY_SRC = `contract;\nuse std::logging::log;\nabi SaveAbi { fn save(value: u64); }\nimpl SaveAbi for Contract { fn save(value: u64) { store(value); } }\nstruct Store { value: u64, }\nfn store(value: u64) { helper(value); }\nfn helper(value: u64) -> u64 { value }`;
test('breadth engine extracts Sway ABI + structs + functions', {
  skip: hasWasmGrammar('sway') ? false : 'sway grammar not vendored',
}, async () => {
  const r = await extractStructure('sway', SWAY_SRC);
  assert.ok(r, 'sway must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save', 'store']);
  assert.ok(r!.classes.some(c => c.name === 'SaveAbi') && r!.classes.some(c => c.name === 'Store'));
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

const NOIR_SRC = `use dep::foo;\nstruct Store { value: Field, }\nfn save(value: Field) { store(value); }\nfn store(value: Field) { helper(value); }\nfn helper(value: Field) -> Field { value }`;
test('breadth engine extracts Noir structs + functions', {
  skip: hasWasmGrammar('noir') ? false : 'noir grammar not vendored',
}, async () => {
  const r = await extractStructure('noir', NOIR_SRC);
  assert.ok(r, 'noir must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save', 'store']);
  assert.ok(r!.classes.some(c => c.name === 'Store'));
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

const CLARITY_SRC = `(use-trait token-trait .sip-010-trait.sip-010-trait)\n(define-trait saver ((save (uint) (response uint uint))))\n(define-map Store { owner: principal } { value: uint })\n(define-public (save (value uint))\n  (begin\n    (store value)\n    (ok value)))\n(define-private (store (value uint))\n  (helper value))\n(define-read-only (helper (value uint))\n  value)`;
test('breadth engine extracts Clarity traits + maps + functions', {
  skip: hasWasmGrammar('clarity') ? false : 'clarity grammar not vendored',
}, async () => {
  const r = await extractStructure('clarity', CLARITY_SRC);
  assert.ok(r, 'clarity must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save', 'store']);
  assert.ok(r!.classes.some(c => c.name === 'Store') && r!.classes.some(c => c.name === 'saver'));
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

// Android / test-automation / game-script / RDF (vendored wasm).
const SOURCEPAWN_SRC = '#include <sourcemod>\nenum struct Vec { int x; }\nvoid save(int x) {\n  store(x);\n}\nint helper() { return 1; }\n';
test('breadth engine extracts SourcePawn functions', {
  skip: hasWasmGrammar('sourcepawn') ? false : 'sourcepawn grammar not vendored',
}, async () => {
  const r = await extractStructure('sourcepawn', SOURCEPAWN_SRC);
  assert.ok(r, 'sourcepawn must be extractable via the generic walker');
  assert.ok(r!.functions.some(f => f.name === 'save') && r!.functions.some(f => f.name === 'helper'), `fns ${JSON.stringify(r!.functions.map(f => f.name))}`);
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

const ROBOT_SRC = '*** Keywords ***\nSave\n    Store    ${x}\n\nHelper\n    Log    hi\n';
test('breadth engine extracts Robot Framework keywords', {
  skip: hasWasmGrammar('robot') ? false : 'robot grammar not vendored',
}, async () => {
  const r = await extractStructure('robot', ROBOT_SRC);
  assert.ok(r, 'robot must be extractable via the generic walker');
  assert.ok(r!.functions.some(f => f.name === 'Save') && r!.functions.some(f => f.name === 'Helper'), `fns ${JSON.stringify(r!.functions.map(f => f.name))}`);
  assert.ok(r!.calls.some(c => c.callee === 'Store'));
});

const SMALI_SRC = '.class public Lcom/example/Foo;\n.super Ljava/lang/Object;\n\n.method public save(I)V\n    .registers 2\n    invoke-static {p1}, Lcom/example/Foo;->store(I)V\n    return-void\n.end method\n\n.method public helper()I\n    .registers 1\n    return-void\n.end method\n';
test('breadth engine extracts Smali methods + class', {
  skip: hasWasmGrammar('smali') ? false : 'smali grammar not vendored',
}, async () => {
  const r = await extractStructure('smali', SMALI_SRC);
  assert.ok(r, 'smali must be extractable via the generic walker');
  assert.ok(r!.functions.some(f => f.name === 'save') && r!.functions.some(f => f.name === 'helper'), `fns ${JSON.stringify(r!.functions.map(f => f.name))}`);
  assert.ok(r!.classes.some(c => c.name === 'Lcom/example/Foo;'));
});

const SQUIRREL_SRC = 'function save(x) {\n  store(x);\n}\nfunction helper() { return 1; }\n';
test('breadth engine extracts Squirrel functions', {
  skip: hasWasmGrammar('squirrel') ? false : 'squirrel grammar not vendored',
}, async () => {
  const r = await extractStructure('squirrel', SQUIRREL_SRC);
  assert.ok(r, 'squirrel must be extractable via the generic walker');
  assert.ok(r!.functions.some(f => f.name === 'save') && r!.functions.some(f => f.name === 'helper'), `fns ${JSON.stringify(r!.functions.map(f => f.name))}`);
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

const TURTLE_SRC = '@prefix ex: <http://example.org/> .\nex:save ex:store ex:thing .\nex:helper a ex:Thing .\n';
test('breadth engine extracts Turtle RDF triples', {
  skip: hasWasmGrammar('turtle') ? false : 'turtle grammar not vendored',
}, async () => {
  const r = await extractStructure('turtle', TURTLE_SRC);
  assert.ok(r, 'turtle must be extractable via the generic walker');
  assert.ok(r!.functions.some(f => f.name === 'ex:save') && r!.functions.some(f => f.name === 'ex:helper'), `subjects ${JSON.stringify(r!.functions.map(f => f.name))}`);
});

// Web3 (TON/Wing) + recipe/HTTP DSLs (vendored ABI-14 wasm).
const FUNC_SRC = `#include "stdlib.fc";\nglobal int stored;\n() save(int value) impure {\n  store(value);\n}\n() store(int value) impure {\n  stored = value;\n}\nint helper(int value) {\n  return value + 1;\n}`;
test('breadth engine extracts FunC functions + globals', {
  skip: hasWasmGrammar('func') ? false : 'func grammar not vendored',
}, async () => {
  const r = await extractStructure('func', FUNC_SRC);
  assert.ok(r, 'func must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save', 'store']);
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

const TACT_SRC = `import "./store";\nstruct Store {\n  value: Int;\n}\nfun save(value: Int) {\n  store(value);\n}\nfun store(value: Int) {\n  helper(value);\n}\nfun helper(value: Int): Int {\n  return value;\n}\ncontract Vault {\n  get fun getValue(): Int {\n    return helper(1);\n  }\n}`;
test('breadth engine extracts Tact functions + contracts', {
  skip: hasWasmGrammar('tact') ? false : 'tact grammar not vendored',
}, async () => {
  const r = await extractStructure('tact', TACT_SRC);
  assert.ok(r, 'tact must be extractable via the generic walker');
  assert.ok(r!.functions.some(f => f.name === 'save') && r!.functions.some(f => f.name === 'helper'), `fns ${JSON.stringify(r!.functions.map(f => f.name))}`);
  assert.ok(r!.classes.some(c => c.name === 'Store') && r!.classes.some(c => c.name === 'Vault'));
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

const WING_SRC = `bring cloud;\nstruct Store {\n  value: num;\n}\nclass Vault {\n  pub save(value: num) {\n    store(value);\n  }\n  pub store(value: num) {\n    helper(value);\n  }\n  pub helper(value: num): num {\n    return value;\n  }\n}`;
test('breadth engine extracts Wing methods + classes', {
  skip: hasWasmGrammar('wing') ? false : 'wing grammar not vendored',
}, async () => {
  const r = await extractStructure('wing', WING_SRC);
  assert.ok(r, 'wing must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save', 'store']);
  assert.ok(r!.classes.some(c => c.name === 'Store') && r!.classes.some(c => c.name === 'Vault'));
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

const COOKLANG_SRC = `>> title: Vault\nUse @save{} with @store{1%cup} in #pan{}.\n\nUse @helper{} with ~{5%minutes}.`;
test('breadth engine extracts Cooklang recipe steps', {
  skip: hasWasmGrammar('cooklang') ? false : 'cooklang grammar not vendored',
}, async () => {
  const r = await extractStructure('cooklang', COOKLANG_SRC);
  assert.ok(r, 'cooklang must be extractable via the generic walker');
  assert.ok(r!.classes.some(c => c.name === 'Vault'), `recipes ${JSON.stringify(r!.classes.map(c => c.name))}`);
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

const HURL_SRC = `GET https://example.org/save\nHTTP 200\n[Captures]\nstore: jsonpath "$.store"\n\nGET https://example.org/helper\nHTTP 200\n`;
test('breadth engine extracts Hurl request entries', {
  skip: hasWasmGrammar('hurl') ? false : 'hurl grammar not vendored',
}, async () => {
  const r = await extractStructure('hurl', HURL_SRC);
  assert.ok(r, 'hurl must be extractable via the generic walker');
  assert.ok(r!.functions.some(f => f.name === 'save') && r!.functions.some(f => f.name === 'helper'), `entries ${JSON.stringify(r!.functions.map(f => f.name))}`);
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

// Config / template / data DSLs (vendored ABI-14 wasm).
const PROPERTIES_SRC = ['db.host=localhost', 'db.port=5432', '# comment', 'app.name = MyApp', 'logging.level: DEBUG'].join('\n');
test('breadth engine extracts .properties keys', {
  skip: hasWasmGrammar('properties') ? false : 'properties grammar not vendored',
}, async () => {
  const r = await extractStructure('properties', PROPERTIES_SRC);
  assert.ok(r, 'properties must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['app.name', 'db.host', 'db.port', 'logging.level']);
});

const GLIMMER_SRC = ['{{#each items as |item|}}', '  <MyComponent @name={{item.name}} />', '  {{format-date item.date}}', '{{/each}}', '{{my-helper foo=bar}}'].join('\n');
test('breadth engine extracts Glimmer blocks + components', {
  skip: hasWasmGrammar('glimmer') ? false : 'glimmer grammar not vendored',
}, async () => {
  const r = await extractStructure('glimmer', GLIMMER_SRC);
  assert.ok(r, 'glimmer must be extractable via the generic walker');
  assert.ok(r!.functions.some(f => f.name === 'each'), `fns ${JSON.stringify(r!.functions.map(f => f.name))}`);
  assert.ok(r!.classes.some(c => c.name === 'MyComponent'));
  assert.ok(r!.calls.some(c => c.callee === 'format-date'));
});

const TODOTXT_SRC = ['(A) 2026-01-01 Call mom @phone +family', 'x done task @work', 'Buy milk +groceries @store'].join('\n');
test('breadth engine extracts todo.txt tasks + projects', {
  skip: hasWasmGrammar('todotxt') ? false : 'todotxt grammar not vendored',
}, async () => {
  const r = await extractStructure('todotxt', TODOTXT_SRC);
  assert.ok(r, 'todotxt must be extractable via the generic walker');
  assert.equal(r!.functions.length, 3, `3 task lines, got ${r!.functions.length}`);
  assert.deepEqual(r!.classes.map(c => c.name).sort(), ['+family', '+groceries']);
});

const MESON_SRC = ["project('myapp', 'c')", "executable('main', 'main.c')", "mylib = library('util', 'util.c')", "subdir('tests')"].join('\n');
test('breadth engine extracts Meson commands', {
  skip: hasWasmGrammar('meson') ? false : 'meson grammar not vendored',
}, async () => {
  const r = await extractStructure('meson', MESON_SRC);
  assert.ok(r, 'meson must be extractable via the generic walker');
  const calls = r!.calls.map(c => c.callee).sort();
  assert.ok(['executable', 'library', 'project'].every(c => calls.includes(c)), `commands ${JSON.stringify(calls)}`);
});

const SSHCONFIG_SRC = ['Host myserver', '  HostName example.com', '  User admin', '  Port 2222', 'Host *', '  ForwardAgent yes'].join('\n');
test('breadth engine extracts ssh_config Host blocks', {
  skip: hasWasmGrammar('sshconfig') ? false : 'sshconfig grammar not vendored',
}, async () => {
  const r = await extractStructure('sshconfig', SSHCONFIG_SRC);
  assert.ok(r, 'sshconfig must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['*', 'myserver']);
});

// Query / audio / Go-template / build DSLs (vendored ABI-14 wasm).
const PROMQL_SRC = 'histogram_quantile(0.9, sum by (le) (rate(http_request_duration_bucket{job="api"}[5m])))';
test('breadth engine extracts PromQL function calls', {
  skip: hasWasmGrammar('promql') ? false : 'promql grammar not vendored',
}, async () => {
  const r = await extractStructure('promql', PROMQL_SRC);
  assert.ok(r, 'promql must be extractable via the generic walker');
  const callees = r!.calls.map(c => c.callee);
  assert.ok(['histogram_quantile', 'rate', 'sum'].every(c => callees.includes(c)), `calls ${JSON.stringify(callees)}`);
});

const SPARQL_SRC = 'PREFIX foaf: <http://xmlns.com/foaf/0.1/>\nPREFIX ex: <http://example.org/>\nSELECT ?name WHERE { ?p foaf:name ?name . }';
test('breadth engine extracts SPARQL prefix imports', {
  skip: hasWasmGrammar('sparql') ? false : 'sparql grammar not vendored',
}, async () => {
  const r = await extractStructure('sparql', SPARQL_SRC);
  assert.ok(r, 'sparql must be extractable via the generic walker');
  assert.equal(r!.imports.length, 2);
  assert.ok(r!.imports.some(i => i.module.includes('foaf')));
});

const SC_SRC = 'MyClass : SuperClass {\n\t*new { |freq| ^super.new.init(freq) }\n\tinit { |freq| ^this }\n\tplay { SinOsc.ar(440).play }\n}';
test('breadth engine extracts SuperCollider class + methods', {
  skip: hasWasmGrammar('supercollider') ? false : 'supercollider grammar not vendored',
}, async () => {
  const r = await extractStructure('supercollider', SC_SRC);
  assert.ok(r, 'supercollider must be extractable via the generic walker');
  assert.ok(r!.classes.some(c => c.name === 'MyClass'));
  const fns = r!.functions.map(f => f.name);
  assert.ok(['new', 'init', 'play'].every(f => fns.includes(f)), `fns ${JSON.stringify(fns)}`);
});

const TEMPL_SRC = 'package main\nimport "fmt"\n\ntempl greeting(name string) {\n\t<div>Hello { name }</div>\n}\ntempl page() {\n\t@greeting("world")\n}\nfunc helper() string {\n\treturn fmt.Sprintf("x")\n}';
test('breadth engine extracts templ components + Go funcs', {
  skip: hasWasmGrammar('templ') ? false : 'templ grammar not vendored',
}, async () => {
  const r = await extractStructure('templ', TEMPL_SRC);
  assert.ok(r, 'templ must be extractable via the generic walker');
  const fns = r!.functions.map(f => f.name);
  assert.ok(['greeting', 'page', 'helper'].every(f => fns.includes(f)), `fns ${JSON.stringify(fns)}`);
  assert.ok(r!.imports.length >= 1);
});

const GN_SRC = 'import("//build/config.gni")\nexecutable("my_app") { sources = [ "main.cc" ] }\nstatic_library("lib") { sources = [ "lib.cc" ] }\ntemplate("my_template") { action(target_name) { script = "x.py" } }';
test('breadth engine extracts GN target declarations', {
  skip: hasWasmGrammar('gn') ? false : 'gn grammar not vendored',
}, async () => {
  const r = await extractStructure('gn', GN_SRC);
  assert.ok(r, 'gn must be extractable via the generic walker');
  const callees = r!.calls.map(c => c.callee);
  assert.ok(['executable', 'static_library', 'template'].every(c => callees.includes(c)), `calls ${JSON.stringify(callees)}`);
  assert.equal(r!.imports.length, 1);
});

// i18n / theme / widget / record DSLs (vendored ABI-14 wasm).
const PO_SRC = 'msgid ""\nmsgstr "hdr"\n\nmsgid "Hello"\nmsgstr "Bonjour"\n\nmsgctxt "menu"\nmsgid "Open"\nmsgstr "Ouvrir"\n';
test('breadth engine extracts gettext .po messages', {
  skip: hasWasmGrammar('po') ? false : 'po grammar not vendored',
}, async () => {
  const r = await extractStructure('po', PO_SRC);
  assert.ok(r, 'po must be extractable via the generic walker');
  assert.deepEqual(r!.classes.map(c => c.name).sort(), ['Hello', 'Open']);
});

const RASI_SRC = '* {\n  background: #000;\n}\nwindow {\n  width: 50%;\n}\n#mainbox {\n  padding: 10px;\n}\n';
test('breadth engine extracts rasi rule sets', {
  skip: hasWasmGrammar('rasi') ? false : 'rasi grammar not vendored',
}, async () => {
  const r = await extractStructure('rasi', RASI_SRC);
  assert.ok(r, 'rasi must be extractable via the generic walker');
  const names = r!.classes.map(c => c.name);
  assert.ok(['*', 'window', '#mainbox'].every(s => names.includes(s)), `selectors ${JSON.stringify(names)}`);
});

const YUCK_SRC = '(defwidget bar [] (box))\n(defwindow main :monitor 0 (bar))\n(defvar foo "x")\n(defpoll time :interval "1s" "date")\n';
test('breadth engine extracts yuck definitions', {
  skip: hasWasmGrammar('yuck') ? false : 'yuck grammar not vendored',
}, async () => {
  const r = await extractStructure('yuck', YUCK_SRC);
  assert.ok(r, 'yuck must be extractable via the generic walker');
  assert.deepEqual(r!.classes.map(c => c.name).sort(), ['bar', 'foo', 'main', 'time']);
});

const TABLEGEN_SRC = 'class Foo<int x> { int y = x; }\ndef BAR : Foo<1>;\ndef BAZ : Foo<2>;\nmulticlass Pair<int z> { def _A : Foo<z>; }\n';
test('breadth engine extracts TableGen records', {
  skip: hasWasmGrammar('tablegen') ? false : 'tablegen grammar not vendored',
}, async () => {
  const r = await extractStructure('tablegen', TABLEGEN_SRC);
  assert.ok(r, 'tablegen must be extractable via the generic walker');
  const names = r!.classes.map(c => c.name);
  assert.ok(['Foo', 'BAR', 'BAZ', 'Pair'].every(n => names.includes(n)), `records ${JSON.stringify(names)}`);
});

const UNGRAMMAR_SRC = "Name = 'ident'\nPath =\n  (qualifier:Path '::')? segment:PathSegment\nPathSegment =\n  'ident'\n| 'self'\n";
test('breadth engine extracts Ungrammar rules', {
  skip: hasWasmGrammar('ungrammar') ? false : 'ungrammar grammar not vendored',
}, async () => {
  const r = await extractStructure('ungrammar', UNGRAMMAR_SRC);
  assert.ok(r, 'ungrammar must be extractable via the generic walker');
  assert.deepEqual(r!.classes.map(c => c.name).sort(), ['Name', 'Path', 'PathSegment']);
});

// ZK / GPU / data / resource (vendored ABI-14 wasm, Codex-sourced; specs grounded here).
const CIRCOM_SRC = 'pragma circom 2.0.0;\ntemplate Save() {\n  signal input x;\n  store(x);\n}\nfunction helper(a) { return a + 1; }';
test('breadth engine extracts Circom templates + functions', {
  skip: hasWasmGrammar('circom') ? false : 'circom grammar not vendored',
}, async () => {
  const r = await extractStructure('circom', CIRCOM_SRC);
  assert.ok(r, 'circom must be extractable via the generic walker');
  assert.ok(r!.classes.some(c => c.name === 'Save'), `classes ${JSON.stringify(r!.classes.map(c => c.name))}`);
  assert.ok(r!.functions.some(f => f.name === 'helper'), `fns ${JSON.stringify(r!.functions.map(f => f.name))}`);
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

const OPENCL_SRC = '#include <x.h>\n__kernel void save(int x) { store(x); }\nint helper(int a) { return a+1; }';
test('breadth engine extracts OpenCL kernels + functions', {
  skip: hasWasmGrammar('opencl') ? false : 'opencl grammar not vendored',
}, async () => {
  const r = await extractStructure('opencl', OPENCL_SRC);
  assert.ok(r, 'opencl must be extractable via the generic walker');
  assert.deepEqual(r!.functions.map(f => f.name).sort(), ['helper', 'save']);
  assert.ok(r!.calls.some(c => c.callee === 'store'));
});

const CPON_SRC = '{ "save": 1, "store": {"helper": 2} }';
test('breadth engine extracts CPON keys', {
  skip: hasWasmGrammar('cpon') ? false : 'cpon grammar not vendored',
}, async () => {
  const r = await extractStructure('cpon', CPON_SRC);
  assert.ok(r, 'cpon must be extractable via the generic walker');
  assert.ok(['save', 'store', 'helper'].every(k => r!.functions.map(f => f.name).includes(k)), `keys ${JSON.stringify(r!.functions.map(f => f.name))}`);
});

const GDRES_SRC = '[gd_resource type="Resource" load_steps=2 format=3]\n[ext_resource path="res://x.gd" id=1]\n[resource]\nscript = ExtResource(1)';
test('breadth engine extracts Godot resource sections', {
  skip: hasWasmGrammar('gdscript-resource') ? false : 'gdscript-resource grammar not vendored',
}, async () => {
  const r = await extractStructure('gdscript-resource', GDRES_SRC);
  assert.ok(r, 'gdscript-resource must be extractable via the generic walker');
  assert.ok(['gd_resource', 'ext_resource', 'resource'].every(s => r!.classes.map(c => c.name).includes(s)), `sections ${JSON.stringify(r!.classes.map(c => c.name))}`);
});

// Assembly / wasm-text / IDL / IR / HTTP (vendored ABI-14 wasm).
const NASM_SRC = 'section .text\nglobal _start\n_start:\n  mov rax, 1\n  call print\n  ret\nprint:\n  ret\nhelper:\n  ret\n';
test('breadth engine extracts NASM labels', {
  skip: hasWasmGrammar('nasm') ? false : 'nasm grammar not vendored',
}, async () => {
  const r = await extractStructure('nasm', NASM_SRC);
  assert.ok(r, 'nasm must be extractable via the generic walker');
  const fns = r!.functions.map(f => f.name);
  assert.ok(['_start', 'print', 'helper'].every(n => fns.includes(n)), `labels ${JSON.stringify(fns)}`);
});

const WAT_SRC = '(module\n  (import "env" "log" (func $log (param i32)))\n  (func $add (param $a i32) (result i32) local.get $a)\n  (func $sub (result i32) i32.const 0)\n  (export "add" (func $add)))\n';
test('breadth engine extracts WAT funcs + module', {
  skip: hasWasmGrammar('wat') ? false : 'wat grammar not vendored',
}, async () => {
  const r = await extractStructure('wat', WAT_SRC);
  assert.ok(r, 'wat must be extractable via the generic walker');
  assert.ok(r!.functions.some(f => f.name === '$add') && r!.functions.some(f => f.name === '$sub'), `fns ${JSON.stringify(r!.functions.map(f => f.name))}`);
  assert.equal(r!.classes.length, 1);
  assert.ok(r!.imports.length >= 1);
});

const FIDL_SRC = 'library fuchsia.example;\nusing fuchsia.mem;\nconst MAX uint32 = 100;\ntype Color = strict enum : uint8 { RED = 1; };\ntype Point = struct { x int32; y int32; };\nprotocol Calculator {\n  Add(struct { a int32; }) -> (struct { sum int32; });\n  flexible Reset();\n};\n';
test('breadth engine extracts FIDL protocols + types', {
  skip: hasWasmGrammar('fidl') ? false : 'fidl grammar not vendored',
}, async () => {
  const r = await extractStructure('fidl', FIDL_SRC);
  assert.ok(r, 'fidl must be extractable via the generic walker');
  const cls = r!.classes.map(c => c.name);
  assert.ok(['Color', 'Point', 'Calculator'].every(n => cls.includes(n)), `classes ${JSON.stringify(cls)}`);
  assert.ok(r!.functions.some(f => f.name === 'Add'));
});

const HTTP_SRC = 'GET https://api.example.com/users HTTP/1.1\nAccept: application/json\n\n###\n\nPOST https://api.example.com/users\nContent-Type: application/json\n\n{"name":"x"}\n';
test('breadth engine extracts HTTP requests', {
  skip: hasWasmGrammar('http') ? false : 'http grammar not vendored',
}, async () => {
  const r = await extractStructure('http', HTTP_SRC);
  assert.ok(r, 'http must be extractable via the generic walker');
  const fns = r!.functions.map(f => f.name);
  assert.ok(fns.some(n => n.startsWith('GET ')) && fns.some(n => n.startsWith('POST ')), `reqs ${JSON.stringify(fns)}`);
});

const LLVM_SRC = "; ModuleID = 'm'\n%struct.Point = type { i32, i32 }\n@g = global i32 0\ndeclare i32 @puts(i8*)\ndefine i32 @add(i32 %a, i32 %b) {\n  %r = add i32 %a, %b\n  ret i32 %r\n}\ndefine void @main() {\n  call i32 @add(i32 1, i32 2)\n  ret void\n}\n";
test('breadth engine extracts LLVM IR defines + globals', {
  skip: hasWasmGrammar('llvm') ? false : 'llvm grammar not vendored',
}, async () => {
  const r = await extractStructure('llvm', LLVM_SRC);
  assert.ok(r, 'llvm must be extractable via the generic walker');
  const fns = r!.functions.map(f => f.name);
  assert.ok(['@add', '@main', '@puts'].every(n => fns.includes(n)), `fns ${JSON.stringify(fns)}`);
  assert.ok(r!.classes.some(c => c.name === '%struct.Point'));
});

// Wave 9 — git / build / config / data formats (vendored ABI-14 wasm).
const GITCOMMIT_SRC = [
  'Add user authentication module',
  '',
  'Implements login and signup flows.',
  '',
  'Co-authored-by: Jane Doe <jane@example.com>',
  'Signed-off-by: John Smith <john@example.com>',
  '#\tmodified:   src/auth.ts',
].join('\n');
test('breadth engine extracts gitcommit subject + trailers + file mentions', {
  skip: hasWasmGrammar('gitcommit') ? false : 'gitcommit grammar not vendored',
}, async () => {
  const r = await extractStructure('gitcommit', GITCOMMIT_SRC);
  assert.ok(r, 'gitcommit must be extractable');
  const fns = r!.functions.map(f => f.name);
  assert.ok(fns.includes('Add user authentication module'), `subject, got ${JSON.stringify(fns)}`);
  assert.ok(fns.includes('Co-authored-by'), `trailer, got ${JSON.stringify(fns)}`);
  assert.ok(fns.includes('Signed-off-by'), `trailer, got ${JSON.stringify(fns)}`);
  assert.ok(r!.imports.some(i => i.module.includes('src/auth.ts')), 'changed-file mention captured');
});

const GIT_REBASE_SRC = [
  'pick a1b2c3d Add login form',
  'reword d4e5f6a Fix typo',
  'squash 7890abc Merge helper',
  'exec make test',
].join('\n');
test('breadth engine extracts one entry per git_rebase operation', {
  skip: hasWasmGrammar('git_rebase') ? false : 'git_rebase grammar not vendored',
}, async () => {
  const r = await extractStructure('git_rebase', GIT_REBASE_SRC);
  assert.ok(r, 'git_rebase must be extractable');
  const fns = r!.functions.map(f => f.name);
  assert.equal(fns.length, 4, `4 operations, got ${JSON.stringify(fns)}`);
  assert.ok(fns.includes('pick a1b2c3d'), `pick op, got ${JSON.stringify(fns)}`);
  assert.ok(fns.some(f => f.startsWith('exec')), `exec op, got ${JSON.stringify(fns)}`);
});

const GITATTRS_SRC = ['*.txt text', '*.png binary', 'docs/** linguist-documentation'].join('\n');
test('breadth engine extracts one class per gitattributes pattern', {
  skip: hasWasmGrammar('gitattributes') ? false : 'gitattributes grammar not vendored',
}, async () => {
  const r = await extractStructure('gitattributes', GITATTRS_SRC);
  assert.ok(r, 'gitattributes must be extractable');
  const classes = r!.classes.map(c => c.name).sort();
  assert.deepEqual(classes, ['*.png', '*.txt', 'docs/**'], `patterns, got ${JSON.stringify(classes)}`);
});

const DIFF_SRC = [
  'diff --git a/src/auth.ts b/src/auth.ts',
  '--- a/src/auth.ts',
  '+++ b/src/auth.ts',
  '@@ -1,3 +1,4 @@',
  ' const x = 1;',
  '-const y = 2;',
  '+const y = 3;',
  'diff --git a/README.md b/README.md',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -10,2 +10,2 @@',
  '-old line',
  '+new line',
].join('\n');
test('breadth engine extracts one class per changed file in a diff, hunks as functions', {
  skip: hasWasmGrammar('diff') ? false : 'diff grammar not vendored',
}, async () => {
  const r = await extractStructure('diff', DIFF_SRC);
  assert.ok(r, 'diff must be extractable');
  const classes = r!.classes.map(c => c.name).sort();
  assert.deepEqual(classes, ['b/README.md', 'b/src/auth.ts'], `file blocks, got ${JSON.stringify(classes)}`);
  assert.ok(r!.functions.length >= 2, `>=2 hunks, got ${r!.functions.length}`);
  assert.ok(r!.functions.every(f => f.name.startsWith('@@')), `hunk names, got ${JSON.stringify(r!.functions.map(f => f.name))}`);
});

const JSONC_SRC = [
  '{',
  '  // app config',
  '  "name": "klauro",',
  '  /* nested */',
  '  "server": { "port": 8080, "host": "localhost" }',
  '}',
].join('\n');
test('breadth engine extracts jsonc object keys (json with comments)', {
  skip: hasWasmGrammar('jsonc') ? false : 'jsonc grammar not vendored',
}, async () => {
  const r = await extractStructure('jsonc', JSONC_SRC);
  assert.ok(r, 'jsonc must be extractable');
  const fns = r!.functions.map(f => f.name).sort();
  assert.deepEqual(fns, ['host', 'name', 'port', 'server'], `keys, got ${JSON.stringify(fns)}`);
});

const COMMENT_SRC = [
  '// TODO: refactor',
  '// FIXME(alice): bug',
  '/* NOTE: x */',
  '// HACK: y',
  '// XXX: z',
  '// WARNING: w',
].join('\n');
test('breadth engine extracts comment tags (TODO/FIXME/…)', {
  skip: hasWasmGrammar('comment') ? false : 'comment grammar not vendored',
}, async () => {
  const r = await extractStructure('comment', COMMENT_SRC);
  assert.ok(r, 'comment must be extractable');
  const tags = r!.functions.map(f => f.name);
  assert.deepEqual(tags, ['TODO', 'FIXME', 'NOTE', 'HACK', 'XXX', 'WARNING'], `tags, got ${JSON.stringify(tags)}`);
});

const QUERY_SRC = [
  '(function_definition name: (identifier) @function.name) @function',
  '(call_expression function: (identifier) @call)',
  '((comment) @doc (#match? @doc "^///"))',
].join('\n');
test('breadth engine extracts tree-sitter query (.scm) structure', {
  skip: hasWasmGrammar('query') ? false : 'query grammar not vendored',
}, async () => {
  const r = await extractStructure('query', QUERY_SRC);
  assert.ok(r, 'query must be extractable');
  const caps = r!.functions.map(f => f.name);
  assert.deepEqual(caps, ['function.name', 'function', 'call', 'doc', 'doc'], `captures, got ${JSON.stringify(caps)}`);
  assert.ok(r!.calls.map(c => c.callee).includes('match'), 'predicate #match? → call');
});

const EDITORCONFIG_SRC = [
  'root = true',
  '[*]',
  'indent_style = space',
  '[*.{js,ts}]',
  'indent_size = 2',
  '[Makefile]',
  'indent_style = tab',
].join('\n');
test('breadth engine extracts editorconfig [section] globs', {
  skip: hasWasmGrammar('editorconfig') ? false : 'editorconfig grammar not vendored',
}, async () => {
  const r = await extractStructure('editorconfig', EDITORCONFIG_SRC);
  assert.ok(r, 'editorconfig must be extractable');
  const globs = r!.classes.map(c => c.name);
  assert.deepEqual(globs, ['*', '*.{js,ts}', 'Makefile'], `section globs, got ${JSON.stringify(globs)}`);
});

const REQUIREMENTS_SRC = [
  'Django>=3.2,<4.0',
  'requests==2.28.1',
  'numpy',
  'flask[async]>=2.0',
].join('\n');
test('breadth engine extracts pip requirements packages', {
  skip: hasWasmGrammar('requirements') ? false : 'requirements grammar not vendored',
}, async () => {
  const r = await extractStructure('requirements', REQUIREMENTS_SRC);
  assert.ok(r, 'requirements must be extractable');
  const pkgs = r!.functions.map(f => f.name);
  assert.deepEqual(pkgs, ['Django', 'requests', 'numpy', 'flask'], `packages, got ${JSON.stringify(pkgs)}`);
});

const CSV_SRC = [
  'name,age,city,active',
  'alice,30,NYC,true',
  'bob,25,LA,false',
].join('\n');
test('breadth engine extracts csv header fields (declFilter on first row)', {
  skip: hasWasmGrammar('csv') ? false : 'csv grammar not vendored',
}, async () => {
  const r = await extractStructure('csv', CSV_SRC);
  assert.ok(r, 'csv must be extractable');
  const cols = r!.functions.map(f => f.name);
  assert.deepEqual(cols, ['name', 'age', 'city', 'active'], `header fields, got ${JSON.stringify(cols)}`);
});

// Wave 9 (Go module ecosystem + Luau + Godot shader) — vendored ABI-14 wasm.
const GOMOD_SRC = [
  'module github.com/foo/bar',
  '',
  'go 1.21',
  '',
  'require (',
  '\tgithub.com/pkg/errors v0.9.1',
  '\tgolang.org/x/sync v0.5.0',
  ')',
  '',
  'require github.com/x/y v1.2.3',
].join('\n');
test('breadth engine extracts go.mod module + require specs', {
  skip: hasWasmGrammar('gomod') ? false : 'gomod grammar not vendored',
}, async () => {
  const r = await extractStructure('gomod', GOMOD_SRC);
  assert.ok(r, 'gomod must be extractable');
  const deps = r!.functions.map(f => f.name);
  assert.ok(['github.com/pkg/errors', 'golang.org/x/sync', 'github.com/x/y'].every(d => deps.includes(d)),
    `require specs, got ${JSON.stringify(deps)}`);
  assert.ok(r!.classes.some(c => c.name === 'github.com/foo/bar'), 'module directive');
});

const GOSUM_SRC = [
  'github.com/pkg/errors v0.9.1 h1:abc=',
  'github.com/pkg/errors v0.9.1/go.mod h1:def=',
  'golang.org/x/sync v0.5.0 h1:ghi=',
].join('\n');
test('breadth engine extracts go.sum checksum module paths', {
  skip: hasWasmGrammar('gosum') ? false : 'gosum grammar not vendored',
}, async () => {
  const r = await extractStructure('gosum', GOSUM_SRC);
  assert.ok(r, 'gosum must be extractable');
  const mods = r!.functions.map(f => f.name);
  assert.ok(mods.includes('github.com/pkg/errors'), `got ${JSON.stringify(mods)}`);
  assert.ok(mods.includes('golang.org/x/sync'), `got ${JSON.stringify(mods)}`);
});

const GOWORK_SRC = [
  'go 1.21',
  '',
  'use (',
  '\t./foo',
  '\t./bar',
  ')',
  '',
  'use ./baz',
].join('\n');
test('breadth engine extracts go.work use directives', {
  skip: hasWasmGrammar('gowork') ? false : 'gowork grammar not vendored',
}, async () => {
  const r = await extractStructure('gowork', GOWORK_SRC);
  assert.ok(r, 'gowork must be extractable');
  const uses = r!.functions.map(f => f.name).sort();
  assert.deepEqual(uses, ['./bar', './baz', './foo'], `use specs, got ${JSON.stringify(uses)}`);
});

const LUAU_SRC = [
  'local function add(a, b)',
  '\treturn a + b',
  'end',
  '',
  'function Greeter.greet(self)',
  '\treturn "hi"',
  'end',
  '',
  'type Point = { x: number, y: number }',
  '',
  'local x = add(1, 2)',
].join('\n');
test('breadth engine extracts Luau functions + type', {
  skip: hasWasmGrammar('luau') ? false : 'luau grammar not vendored',
}, async () => {
  const r = await extractStructure('luau', LUAU_SRC);
  assert.ok(r, 'luau must be extractable');
  const fns = r!.functions.map(f => f.name);
  assert.ok(fns.includes('add'), `got ${JSON.stringify(fns)}`);
  assert.ok(fns.includes('Greeter.greet'), `dotted method, got ${JSON.stringify(fns)}`);
  assert.ok(r!.classes.some(c => c.name === 'Point'), 'type alias as class');
});

const GDSHADER_SRC = [
  'shader_type canvas_item;',
  '',
  'uniform float speed;',
  '',
  'struct Light {',
  '\tvec3 color;',
  '};',
  '',
  'void fragment() {',
  '\tCOLOR = vec4(1.0);',
  '}',
  '',
  'float helper(float a) {',
  '\treturn a * speed;',
  '}',
].join('\n');
test('breadth engine extracts Godot shader functions + struct', {
  skip: hasWasmGrammar('gdshader') ? false : 'gdshader grammar not vendored',
}, async () => {
  const r = await extractStructure('gdshader', GDSHADER_SRC);
  assert.ok(r, 'gdshader must be extractable');
  const fns = r!.functions.map(f => f.name).sort();
  assert.deepEqual(fns, ['fragment', 'helper'], `functions, got ${JSON.stringify(fns)}`);
  assert.ok(r!.classes.some(c => c.name === 'Light'), 'struct as class');
});
