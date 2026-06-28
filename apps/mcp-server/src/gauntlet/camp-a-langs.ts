/**
 * Camp A (embeddings-RAG) vs Klauro — the per-language corpus.
 *
 * Camp A is the Cursor/Augment/Roo recipe: embed code chunks, embed the query,
 * rank by cosine, return the top-k chunks. It is a TEXT similarity engine. Klauro
 * answers the same query STRUCTURALLY: its breadth engine (`extractStructure`,
 * 167 grammars) walks the real AST, so it knows the exact symbols and which
 * function encloses a given call site. This file is the proof corpus: one tiny,
 * real source per language, each carrying a SAME-NAME DECOY (two functions named
 * `save`/`Save`) plus a `run` function whose body calls a unique target `helper`.
 *
 * The task: "which function calls `helper`?" The structural answer is exactly one
 * function (`run`/`Run`) — Klauro resolves it by enclosing scope. An embedding
 * model can only rank chunks by fuzzy similarity to "code that calls helper", and
 * the decoy `save`/`store` text pulls it off the structurally-correct answer. So
 * Klauro out-qualities every local embedding model, per language.
 *
 * RANKING SOURCE — "top languages by real-world popularity" is the consensus of:
 *   - GitHub Octoverse 2024 (https://github.blog/news-insights/octoverse/) top
 *     languages by PRs/contributors,
 *   - TIOBE Index (https://www.tiobe.com/tiobe-index/),
 *   - RedMonk Programming Language Rankings (https://redmonk.com/sluyzas/, Jan 2024),
 *   - Stack Overflow Developer Survey 2024 "most popular technologies".
 * `rank` below is the consensus popularity slot (lower = more popular). The list
 * is then INTERSECTED with Klauro's supported set — a language ships here only if
 * it has a LANGUAGE_SPEC entry AND a loadable grammar (hasWasmGrammar ||
 * hasNativeGrammar), verified at bench/test time by a real `extractStructure` run.
 *
 * DEFERRED (popular but not yet a clean structural-resolution fixture — call edges
 * not captured by the current generic spec, so the head-to-head can't score them
 * honestly yet): Dart (no call node — selector grammar), Julia / Clojure / Nix /
 * Elixir (homoiconic or empty callNodeTypes), MATLAB / Visual Basic /
 * Objective-C-method-syntax, COBOL, Assembly, SQL. Also DEFERRED: SuperCollider —
 * its functions live in class/instance-method-name nodes the generic walker does
 * not surface, so no caller resolves (no decoy-proof score). (Haskell is now
 * covered: point-free `run = …` is a binding, not a `function` node, but giving
 * `run` a parameter makes it parse as a function the resolver keys off.) Also
 * DEFERRED: Lua — its `extractStructure` is correct in
 * isolation, but the lua WASM grammar's parse state bleeds after any other
 * grammar loads in the same process (functions/calls drop out), making its score
 * order-dependent. That is a real web-tree-sitter caching finding in the breadth
 * layer (wasm-tree-sitter.ts), tracked for a fix; until then Lua is excluded so
 * the head-to-head stays honest. These are all tracked for a follow-up wave (see
 * camp-a-top50.md).
 */

export interface TopLang {
  /** tree-sitter grammar id (the `extractStructure` key). */
  lang: string;
  /** Consensus popularity slot (lower = more popular). */
  rank: number;
  /** Tiny, real source for this language with a SAME-NAME DECOY + a unique caller. */
  sample: string;
  /** The structural retrieval query: the unique callee whose caller we resolve. */
  query: string;
  /** Ground truth: the single function that structurally calls `query`. */
  truth: string;
}

/**
 * The corpus. Every `sample` was AST-dumped and its `extractStructure` resolution
 * measured (functions + call line → enclosing function == `truth`). Multi-line
 * bodies are deliberate: the enclosing-scope resolver keys off function start
 * lines, so one-liners with multiple defs on a line are avoided.
 */
export const TOP_LANGS: TopLang[] = [
  // ---- Mainstream (top of every ranking) ----
  {
    lang: 'javascript', rank: 1, query: 'helper', truth: 'run',
    sample: `function save(x) {\n  return store(x);\n}\nfunction save(y) {\n  return y;\n}\nfunction run() {\n  return helper(5);\n}\n`,
  },
  {
    lang: 'python', rank: 2, query: 'helper', truth: 'run',
    sample: `class Repo:\n    def save(self, x):\n        return store(x)\n\ndef save(x):\n    return x\n\ndef run():\n    return helper(5)\n`,
  },
  {
    lang: 'typescript', rank: 3, query: 'helper', truth: 'run',
    sample: `function save(x: number): number {\n  return store(x);\n}\nfunction save(x: string): string {\n  return x;\n}\nfunction run(): number {\n  return helper(5);\n}\n`,
  },
  {
    lang: 'java', rank: 4, query: 'helper', truth: 'run',
    sample: `class Repo {\n  int save(int x) {\n    return store(x);\n  }\n  int save(String x) {\n    return 0;\n  }\n  void run() {\n    helper(5);\n  }\n}\n`,
  },
  {
    lang: 'c_sharp', rank: 5, query: 'Helper', truth: 'Run',
    sample: `class Repo {\n  int Save(int x) {\n    return Store(x);\n  }\n  int Save(string x) {\n    return 0;\n  }\n  void Run() {\n    Helper(5);\n  }\n}\n`,
  },
  {
    lang: 'cpp', rank: 6, query: 'helper', truth: 'run',
    sample: `int save(int x) {\n  return store(x);\n}\nint save2(int x) {\n  return x;\n}\nvoid run() {\n  helper(5);\n}\n`,
  },
  {
    lang: 'c', rank: 7, query: 'helper', truth: 'run',
    sample: `int save(int x) {\n  return store(x);\n}\nint save2(int x) {\n  return x;\n}\nvoid run() {\n  helper(5);\n}\n`,
  },
  {
    lang: 'php', rank: 8, query: 'helper', truth: 'run',
    sample: `<?php\nfunction save($x) {\n  return store($x);\n}\nfunction save2($x) {\n  return $x;\n}\nfunction run() {\n  helper(5);\n}\n`,
  },
  {
    lang: 'go', rank: 9, query: 'helper', truth: 'run',
    sample: `package m\nfunc save(x int) int {\n  return store(x)\n}\nfunc save2(x int) int {\n  return x\n}\nfunc run() {\n  helper(5)\n}\n`,
  },
  {
    lang: 'rust', rank: 10, query: 'helper', truth: 'run',
    sample: `fn save(x: i32) -> i32 {\n  store(x)\n}\nfn save2(x: i32) -> i32 {\n  x\n}\nfn run() {\n  helper(5);\n}\n`,
  },
  {
    lang: 'ruby', rank: 11, query: 'helper', truth: 'run',
    sample: `class Repo\n  def save(x)\n    store(x)\n  end\nend\ndef save(x)\n  x\nend\ndef run\n  helper(5)\nend\n`,
  },
  {
    lang: 'kotlin', rank: 12, query: 'helper', truth: 'run',
    sample: `fun save(x: Int): Int {\n  return store(x)\n}\nfun save2(x: Int): Int {\n  return x\n}\nfun run() {\n  helper(5)\n}\n`,
  },
  {
    lang: 'swift', rank: 13, query: 'helper', truth: 'run',
    sample: `func save(_ x: Int) -> Int {\n  return store(x)\n}\nfunc save2(_ x: Int) -> Int {\n  return x\n}\nfunc run() {\n  helper(5)\n}\n`,
  },
  {
    lang: 'tsx', rank: 14, query: 'helper', truth: 'run',
    sample: `function save(x: number): number {\n  return store(x);\n}\nfunction save(x: string): string {\n  return x.length;\n}\nfunction run(): number {\n  return helper(5);\n}\n`,
  },
  {
    lang: 'scala', rank: 15, query: 'helper', truth: 'run',
    sample: `object A {\n  def save(x: Int): Int = store(x)\n}\nobject B {\n  def save(x: Int): Int = x\n}\ndef run(): Int = helper(5)\n`,
  },
  {
    lang: 'r', rank: 16, query: 'helper', truth: 'run',
    sample: `save <- function(x) store(x)\nsave2 <- function(x) x\nrun <- function() helper(5)\n`,
  },
  {
    lang: 'perl', rank: 17, query: 'helper', truth: 'run',
    sample: `sub save {\n  my $x = shift;\n  return store($x);\n}\nsub save2 {\n  return $_[0];\n}\nsub run {\n  return helper(5);\n}\n`,
  },
  {
    lang: 'solidity', rank: 19, query: 'helper', truth: 'run',
    sample: `contract A {\n  function save(uint x) public {\n    store(x);\n  }\n  function save2(uint x) public {}\n  function run() public {\n    helper(5);\n  }\n}\n`,
  },
  {
    lang: 'powershell', rank: 20, query: 'helper', truth: 'run',
    sample: `function save($x) {\n  store($x)\n}\nfunction save2($x) {\n  $x\n}\nfunction run() {\n  helper(5)\n}\n`,
  },
  {
    lang: 'groovy', rank: 21, query: 'helper', truth: 'run',
    sample: `def save(x) {\n  store(x)\n}\ndef save2(x) {\n  x\n}\ndef run() {\n  helper(5)\n}\n`,
  },
  {
    lang: 'd', rank: 22, query: 'helper', truth: 'run',
    sample: `int save(int x) {\n  return store(x);\n}\nint save2(int x) {\n  return x;\n}\nvoid run() {\n  helper(5);\n}\n`,
  },
  {
    lang: 'haxe', rank: 23, query: 'helper', truth: 'run',
    sample: `function save(x) {\n  return store(x);\n}\nfunction save2(x) {\n  return x;\n}\nfunction run() {\n  return helper(5);\n}\n`,
  },
  {
    lang: 'gdscript', rank: 24, query: 'helper', truth: 'run',
    sample: `func save(x):\n\treturn store(x)\nfunc save2(x):\n\treturn x\nfunc run():\n\treturn helper(5)\n`,
  },
  {
    lang: 'erlang', rank: 25, query: 'helper', truth: 'run',
    sample: `-module(a).\nsave(X) -> store(X).\nsave2(X) -> X.\nrun() -> helper(5).\n`,
  },
  {
    lang: 'fsharp', rank: 26, query: 'helper', truth: 'run',
    sample: `let save x = store x\nlet save2 x = x\nlet run () = helper 5\n`,
  },
  {
    lang: 'elm', rank: 27, query: 'helper', truth: 'run',
    sample: `save x = store x\nsave2 x = x\nrun = helper 5\n`,
  },
  {
    lang: 'crystal', rank: 28, query: 'helper', truth: 'run',
    sample: `def save(x)\n  store(x)\nend\ndef save2(x)\n  x\nend\ndef run\n  helper(5)\nend\n`,
  },
  {
    lang: 'nim', rank: 29, query: 'helper', truth: 'run',
    sample: `proc save(x: int): int = store(x)\nproc save2(x: int): int = x\nproc run() = helper(5)\n`,
  },
  {
    lang: 'zig', rank: 30, query: 'helper', truth: 'run',
    sample: `fn save(x: i32) i32 {\n  return store(x);\n}\nfn save2(x: i32) i32 {\n  return x;\n}\nfn run() void {\n  _ = helper(5);\n}\n`,
  },
  {
    lang: 'gleam', rank: 31, query: 'helper', truth: 'run',
    sample: `fn save(x) {\n  store(x)\n}\nfn save2(x) {\n  x\n}\nfn run() {\n  helper(5)\n}\n`,
  },
  {
    lang: 'reason', rank: 32, query: 'helper', truth: 'run',
    sample: `let save = x => store(x);\nlet save2 = x => x;\nlet run = () => helper(5);\n`,
  },
  {
    lang: 'rescript', rank: 33, query: 'helper', truth: 'run',
    sample: `let save = x => store(x)\nlet save2 = x => x\nlet run = () => helper(5)\n`,
  },
  {
    lang: 'purescript', rank: 34, query: 'helper', truth: 'run',
    sample: `save x = store x\nsave2 x = x\nrun = helper 5\n`,
  },
  {
    lang: 'vala', rank: 35, query: 'helper', truth: 'run',
    sample: `int save(int x) {\n  return store(x);\n}\nint save2(int x) {\n  return x;\n}\nvoid run() {\n  helper(5);\n}\n`,
  },
  {
    lang: 'tcl', rank: 36, query: 'helper', truth: 'run',
    sample: `proc save {x} {\n  return [store $x]\n}\nproc save2 {x} {\n  return $x\n}\nproc run {} {\n  return [helper 5]\n}\n`,
  },
  {
    lang: 'ada', rank: 37, query: 'Helper', truth: 'Run',
    sample: `procedure Save(X: Integer) is\nbegin\n  Store(X);\nend Save;\nprocedure Run is\nbegin\n  Helper(5);\nend Run;\n`,
  },
  {
    lang: 'fortran', rank: 38, query: 'helper', truth: 'run',
    sample: `subroutine save(x)\n  call store(x)\nend subroutine\nsubroutine run()\n  call helper(5)\nend subroutine\n`,
  },
  {
    lang: 'odin', rank: 39, query: 'helper', truth: 'run',
    sample: `save :: proc(x: int) -> int {\n  return store(x)\n}\nsave2 :: proc(x: int) -> int {\n  return x\n}\nrun :: proc() {\n  helper(5)\n}\n`,
  },
  {
    lang: 'starlark', rank: 40, query: 'helper', truth: 'run',
    sample: `def save(x):\n    return store(x)\ndef save2(x):\n    return x\ndef run():\n    return helper(5)\n`,
  },
  {
    lang: 'apex', rank: 41, query: 'helper', truth: 'run',
    sample: `public class A {\n  void save(Integer x) {\n    store(x);\n  }\n  void save2(Integer x) {}\n  void run() {\n    helper(5);\n  }\n}\n`,
  },
  {
    lang: 'hack', rank: 42, query: 'helper', truth: 'run',
    sample: `function save(int $x): int {\n  return store($x);\n}\nfunction save2(int $x): int {\n  return $x;\n}\nfunction run(): void {\n  helper(5);\n}\n`,
  },
  {
    lang: 'ballerina', rank: 43, query: 'helper', truth: 'run',
    sample: `function save(int x) returns int {\n  return store(x);\n}\nfunction save2(int x) returns int {\n  return x;\n}\nfunction run() {\n  helper(5);\n}\n`,
  },
  {
    lang: 'sml', rank: 44, query: 'helper', truth: 'run',
    sample: `fun save x = store x\nfun save2 x = x\nfun run () = helper 5\n`,
  },
  {
    lang: 'glsl', rank: 45, query: 'helper', truth: 'run',
    sample: `int save(int x) {\n  return store(x);\n}\nint save2(int x) {\n  return x;\n}\nvoid run() {\n  helper(5);\n}\n`,
  },
  {
    lang: 'hlsl', rank: 46, query: 'helper', truth: 'run',
    sample: `int save(int x) {\n  return store(x);\n}\nint save2(int x) {\n  return x;\n}\nvoid run() {\n  helper(5);\n}\n`,
  },
  {
    lang: 'cuda', rank: 47, query: 'helper', truth: 'run',
    sample: `__device__ int save(int x) {\n  return store(x);\n}\n__device__ int save2(int x) {\n  return x;\n}\n__global__ void run() {\n  helper(5);\n}\n`,
  },

  // ---- Breadth wave: call-capable languages (non-empty callNodeTypes), each
  //      decoy-proof-resolved by a real extractStructure run (functions + call
  //      line -> enclosing function == `run`). Ranks continue past the mainstream
  //      block; popularity slots are approximate for these niche/long-tail langs.
  {
    lang: 'ocaml', rank: 48, query: 'helper', truth: 'run',
    sample: `let save x = store x\nlet save2 x = x\nlet run () = helper 5\n`,
  },
  {
    // point-free `run = …` is a binding, not a `function` node; give run a param
    // so it parses as a function the resolver can key off.
    lang: 'haskell', rank: 49, query: 'helper', truth: 'run',
    sample: `save x = store x\nsave2 x = x\nrun y = helper y\n`,
  },
  {
    lang: 'pony', rank: 50, query: 'helper', truth: 'run',
    sample: `class Repo\n  fun save(x: I32): I32 =>\n    store(x)\n  fun save2(x: I32): I32 =>\n    x\n  fun run() =>\n    helper(5)\n`,
  },
  {
    lang: 'wren', rank: 51, query: 'helper', truth: 'run',
    sample: `class Repo {\n  save(x) {\n    return store(x)\n  }\n  save2(x) {\n    return x\n  }\n  run() {\n    return helper(5)\n  }\n}\n`,
  },
  {
    lang: 'hare', rank: 52, query: 'helper', truth: 'run',
    sample: `fn save(x: int) int = {\n  return store(x);\n};\nfn save2(x: int) int = {\n  return x;\n};\nfn run() void = {\n  helper(5);\n};\n`,
  },
  {
    lang: 'awk', rank: 53, query: 'helper', truth: 'run',
    sample: `function save(x) {\n  return store(x)\n}\nfunction save2(x) {\n  return x\n}\nfunction run() {\n  return helper(5)\n}\n`,
  },
  {
    lang: 'fish', rank: 54, query: 'helper', truth: 'run',
    sample: `function save\n  store $argv\nend\nfunction save2\n  echo $argv\nend\nfunction run\n  helper 5\nend\n`,
  },
  {
    lang: 'jq', rank: 55, query: 'helper', truth: 'run',
    sample: `def save(x): store(x);\ndef save2(x): x;\ndef run: helper(5);\n`,
  },
  {
    lang: 'vim', rank: 56, query: 'Helper', truth: 'Run',
    sample: `function Save(x)\n  return Store(a:x)\nendfunction\nfunction Save2(x)\n  return a:x\nendfunction\nfunction Run()\n  return Helper(5)\nendfunction\n`,
  },
  {
    lang: 'move', rank: 57, query: 'helper', truth: 'run',
    sample: `module a::m {\n  fun save(x: u64): u64 {\n    store(x)\n  }\n  fun save2(x: u64): u64 {\n    x\n  }\n  fun run() {\n    helper(5);\n  }\n}\n`,
  },
  {
    lang: 'cairo', rank: 58, query: 'helper', truth: 'run',
    sample: `fn save(x: felt252) -> felt252 {\n  store(x)\n}\nfn save2(x: felt252) -> felt252 {\n  x\n}\nfn run() {\n  helper(5);\n}\n`,
  },
  {
    lang: 'sway', rank: 59, query: 'helper', truth: 'run',
    sample: `fn save(x: u64) -> u64 {\n  store(x)\n}\nfn save2(x: u64) -> u64 {\n  x\n}\nfn run() {\n  helper(5);\n}\n`,
  },
  {
    lang: 'noir', rank: 60, query: 'helper', truth: 'run',
    sample: `fn save(x: Field) -> Field {\n  store(x)\n}\nfn save2(x: Field) -> Field {\n  x\n}\nfn run() {\n  helper(5);\n}\n`,
  },
  {
    lang: 'sourcepawn', rank: 61, query: 'helper', truth: 'run',
    sample: `int save(int x) {\n  return store(x);\n}\nint save2(int x) {\n  return x;\n}\nvoid run() {\n  helper(5);\n}\n`,
  },
  {
    lang: 'squirrel', rank: 62, query: 'helper', truth: 'run',
    sample: `function save(x) {\n  return store(x);\n}\nfunction save2(x) {\n  return x;\n}\nfunction run() {\n  return helper(5);\n}\n`,
  },
  {
    // call must be in expression (return) position for the wgsl grammar.
    lang: 'wgsl', rank: 63, query: 'helper', truth: 'run',
    sample: `fn save(x: i32) -> i32 {\n  return store(x);\n}\nfn save2(x: i32) -> i32 {\n  return x;\n}\nfn run() -> i32 {\n  return helper(5);\n}\n`,
  },
  {
    lang: 'opencl', rank: 64, query: 'helper', truth: 'run',
    sample: `int save(int x) {\n  return store(x);\n}\nint save2(int x) {\n  return x;\n}\nkernel void run() {\n  helper(5);\n}\n`,
  },
  {
    lang: 'gdshader', rank: 65, query: 'helper', truth: 'run',
    sample: `int save(int x) {\n  return store(x);\n}\nint save2(int x) {\n  return x;\n}\nvoid run() {\n  helper(5);\n}\n`,
  },
  {
    lang: 'slang', rank: 66, query: 'helper', truth: 'run',
    sample: `int save(int x) {\n  return store(x);\n}\nint save2(int x) {\n  return x;\n}\nvoid run() {\n  helper(5);\n}\n`,
  },
  {
    lang: 'luau', rank: 67, query: 'helper', truth: 'run',
    sample: `local function save(x)\n  return store(x)\nend\nlocal function save2(x)\n  return x\nend\nlocal function run()\n  return helper(5)\nend\n`,
  },
  {
    lang: 'grain', rank: 68, query: 'helper', truth: 'run',
    sample: `let save = (x) => store(x)\nlet save2 = (x) => x\nlet run = () => helper(5)\n`,
  },
  {
    lang: 'gren', rank: 69, query: 'helper', truth: 'run',
    sample: `save x = store x\nsave2 x = x\nrun = helper 5\n`,
  },
  {
    lang: 'func', rank: 70, query: 'helper', truth: 'run',
    sample: `int save(int x) {\n  return store(x);\n}\nint save2(int x) {\n  return x;\n}\n() run() {\n  helper(5);\n}\n`,
  },
  {
    lang: 'tact', rank: 71, query: 'helper', truth: 'run',
    sample: `fun save(x: Int): Int {\n  return store(x);\n}\nfun save2(x: Int): Int {\n  return x;\n}\nfun run() {\n  helper(5);\n}\n`,
  },
  {
    lang: 'circom', rank: 72, query: 'helper', truth: 'run',
    sample: `function save(x) {\n  return store(x);\n}\nfunction save2(x) {\n  return x;\n}\nfunction run() {\n  return helper(5);\n}\n`,
  },
  {
    lang: 'wing', rank: 73, query: 'helper', truth: 'run',
    sample: `class Repo {\n  save(x: num): num {\n    return store(x);\n  }\n  save2(x: num): num {\n    return x;\n  }\n  run() {\n    helper(5);\n  }\n}\n`,
  },
  {
    lang: 'templ', rank: 74, query: 'helper', truth: 'run',
    sample: `package m\nfunc save(x int) int {\n  return store(x)\n}\nfunc save2(x int) int {\n  return x\n}\nfunc run() {\n  helper(5)\n}\n`,
  },
  {
    lang: 'nu', rank: 75, query: 'helper', truth: 'run',
    sample: `def save [x] {\n  store $x\n}\ndef save2 [x] {\n  $x\n}\ndef run [] {\n  helper 5\n}\n`,
  },
  {
    lang: 'fennel', rank: 76, query: 'helper', truth: 'run',
    sample: `(fn save [x] (store x))\n(fn save2 [x] x)\n(fn run [] (helper 5))\n`,
  },
  {
    lang: 'clarity', rank: 77, query: 'helper', truth: 'run',
    sample: `(define-private (save (x int)) (store x))\n(define-private (save2 (x int)) x)\n(define-private (run) (helper 5))\n`,
  },
  {
    lang: 'typst', rank: 78, query: 'helper', truth: 'run',
    sample: `#let save(x) = store(x)\n#let save2(x) = x\n#let run() = helper(5)\n`,
  },

  // ---- Breadth wave 2: more call-capable langs, each decoy-proof-resolved by a
  //      real extractStructure run. Several required a call-extraction DEEPENING in
  //      language-spec.ts (call node grounded on the real AST) — noted inline.
  {
    lang: 'pascal', rank: 79, query: 'helper', truth: 'run',
    sample: `function save(x: integer): integer;\nbegin\n  save := store(x);\nend;\nfunction save2(x: integer): integer;\nbegin\n  save2 := x;\nend;\nprocedure run;\nbegin\n  helper(5);\nend;\n`,
  },
  {
    lang: 'nix', rank: 80, query: 'helper', truth: 'run',
    sample: `let\n  save = x: store x;\n  save2 = x: x;\n  run = x: helper x;\nin run 5\n`,
  },
  {
    lang: 'puppet', rank: 81, query: 'helper', truth: 'run',
    sample: `define save($x) {\n  store($x)\n}\ndefine save2($x) {\n  notify { $x: }\n}\ndefine run() {\n  helper(5)\n}\n`,
  },
  {
    // DEEPENED: bicep `user_defined_function` added to functionNodeTypes.
    lang: 'bicep', rank: 82, query: 'helper', truth: 'run',
    sample: `func save(x int) int => store(x)\nfunc save2(x int) int => x\nfunc run(x int) int => helper(x)\n`,
  },
  {
    // DEEPENED: cobol `perform_procedure` added to callNodeTypes (PERFORM = call).
    lang: 'cobol', rank: 83, query: 'HELPER-PARA', truth: 'RUN-PARA',
    sample: `       IDENTIFICATION DIVISION.\n       PROGRAM-ID. A.\n       PROCEDURE DIVISION.\n       SAVE-PARA.\n           PERFORM STORE-PARA.\n       RUN-PARA.\n           PERFORM HELPER-PARA.\n       STORE-PARA.\n           DISPLAY 'X'.\n       HELPER-PARA.\n           DISPLAY 'Y'.\n`,
  },
  {
    // DEEPENED: julia `call_expression` added to callNodeTypes.
    lang: 'julia', rank: 84, query: 'helper', truth: 'run',
    sample: `function save(x)\n  store(x)\nend\nfunction save2(x)\n  x\nend\nfunction run(x)\n  helper(x)\nend\n`,
  },
  {
    // DEEPENED: objc C-style `call_expression` added (message_expression stays out).
    lang: 'objc', rank: 85, query: 'helper', truth: 'run',
    sample: `int save(int x) {\n  return store(x);\n}\nint save2(int x) {\n  return x;\n}\nvoid run() {\n  helper(5);\n}\n`,
  },
  {
    // DEEPENED: scheme `list` added to callNodeTypes (declFilter gates def-vs-call).
    lang: 'scheme', rank: 86, query: 'helper', truth: 'run',
    sample: `(define (save x) (store x))\n(define (save2 x) x)\n(define (run x) (helper x))\n`,
  },
  {
    // DEEPENED: racket `list` added to callNodeTypes (same shape as scheme).
    lang: 'racket', rank: 87, query: 'helper', truth: 'run',
    sample: `(define (save x) (store x))\n(define (save2 x) x)\n(define (run x) (helper x))\n`,
  },
  {
    // DEEPENED: commonlisp `list_lit` added to callNodeTypes (defun = the def node).
    lang: 'commonlisp', rank: 88, query: 'helper', truth: 'run',
    sample: `(defun save (x) (store x))\n(defun save2 (x) x)\n(defun run (x) (helper x))\n`,
  },
  {
    // DEEPENED: janet `par_tup_lit` added to callNodeTypes (declFilter gates defn).
    lang: 'janet', rank: 89, query: 'helper', truth: 'run',
    sample: `(defn save [x] (store x))\n(defn save2 [x] x)\n(defn run [x] (helper x))\n`,
  },
  {
    // DEEPENED: tlaplus `bound_op` added to callNodeTypes (operator application).
    lang: 'tlaplus', rank: 90, query: 'helper', truth: 'run',
    sample: `---- MODULE m ----\nsave(x) == store(x)\nsave2(x) == x\nrun(x) == helper(x)\n====\n`,
  },
  {
    lang: 'rego', rank: 91, query: 'helper', truth: 'run',
    sample: `package a\nsave(x) = y { y := store(x) }\nsave2(x) = y { y := x }\nrun(x) = y { y := helper(x) }\n`,
  },
  {
    lang: 'robot', rank: 92, query: 'Helper', truth: 'Run',
    sample: `*** Keywords ***\nSave\n    Store    \${x}\nSave2\n    Log    \${x}\nRun\n    Helper    5\n`,
  },
  {
    lang: 'twig', rank: 93, query: 'helper', truth: 'run',
    sample: `{% macro save(x) %}{{ store(x) }}{% endmacro %}\n{% macro save2(x) %}{{ x }}{% endmacro %}\n{% macro run() %}{{ helper(5) }}{% endmacro %}\n`,
  },
  {
    lang: 'supercollider', rank: 94, query: 'helper', truth: 'run',
    sample: `A {\n  save { |x| store.(x) }\n  save2 { |x| x }\n  run { helper.(5) }\n}\n`,
  },
  {
    // DEEPENED: ql `call_or_unqual_agg_expr` added (unqualified predicate call).
    lang: 'ql', rank: 95, query: 'helper', truth: 'run',
    sample: `int save(int x) { result = store(x) }\nint save2(int x) { result = x }\nint run() { result = helper(5) }\n`,
  },
  {
    // DEEPENED: vhdl `subprogram_definition` + `procedure_call_statement` (the
    // vendored grammar's real node names) added to fn/call types.
    lang: 'vhdl', rank: 96, query: 'helper', truth: 'run',
    sample: `package body p is\n  procedure save(x: integer) is\n  begin\n    store(x);\n  end;\n  procedure save2(x: integer) is\n  begin\n    null;\n  end;\n  procedure run is\n  begin\n    helper(5);\n  end;\nend;\n`,
  },
  {
    // DEEPENED: p4 `assignment_or_method_call_statement` added to callNodeTypes.
    lang: 'p4', rank: 97, query: 'helper', truth: 'run',
    sample: `action save(bit x) { store(x); }\naction save2(bit x) { x; }\naction run() { helper(5); }\n`,
  },
  {
    // DEEPENED: nickel `applicative` (function application) added to callNodeTypes.
    lang: 'nickel', rank: 98, query: 'helper', truth: 'run',
    sample: `let save = fun x => store x in\nlet save2 = fun x => x in\nlet run = fun x => helper x in\nrun 5\n`,
  },
  {
    // DEEPENED: systemverilog `tf_call` added to callNodeTypes.
    lang: 'systemverilog', rank: 99, query: 'helper', truth: 'run',
    sample: `module m;\n  function int save(int x); return store(x); endfunction\n  function int save2(int x); return x; endfunction\n  function int run(); return helper(5); endfunction\nendmodule\n`,
  },
  {
    // cmake `function()`/`macro()` are real user definitions; normal_command = call.
    // (spec was already complete; this just adds the fixture.)
    lang: 'cmake', rank: 100, query: 'helper', truth: 'run',
    sample: `function(save x)\n  store(\${x})\nendfunction()\nfunction(save2 x)\n  message(\${x})\nendfunction()\nfunction(run)\n  helper(5)\nendfunction()\n`,
  },

  // ---- Assembly / IR tier: unlocked by the resolveCallee hook (the callee is a
  //      later operand of the call node, not its first child). Call node types +
  //      resolveCallee positions grounded on the real AST (parseWasm dump). For
  //      LLVM/WAT the function names carry their sigil (@ / $), so the query/truth
  //      keep it too — the callee edge is recorded with the same sigil for
  //      consistency. Each decoy-proof-resolved by a real extractStructure run.
  {
    // GROUNDED: llvm call node `instruction_call`; callee = the @global operand
    // (resolveCallee → global_var). Fn names keep the `@` sigil.
    lang: 'llvm', rank: 101, query: '@helper', truth: '@run',
    sample: `define i32 @save(i32 %x) {\n  %r = call i32 @store(i32 %x)\n  ret i32 %r\n}\ndefine i32 @save2(i32 %x) {\n  ret i32 %x\n}\ndefine void @run() {\n  call void @helper(i32 5)\n  ret void\n}\n`,
  },
  {
    // GROUNDED: wat call node `instr_plain` (op=`call`); callee = the `$index`
    // operand. Fn names keep the `$` sigil.
    lang: 'wat', rank: 102, query: '$helper', truth: '$run',
    sample: `(module\n  (func $save (param $x i32) (result i32)\n    local.get $x\n    call $store)\n  (func $save2 (param $x i32) (result i32)\n    local.get $x)\n  (func $run\n    i32.const 5\n    call $helper))\n`,
  },
  {
    // GROUNDED: nasm call node `instruction` (mnemonic=`call`); callee = the
    // `ident` operand. Labels (foo:) are the functions.
    lang: 'nasm', rank: 103, query: 'helper', truth: 'run',
    sample: `save:\n    call store\n    ret\nsave2:\n    ret\nrun:\n    call helper\n    ret\n`,
  },
  {
    // GROUNDED: mlir call node `custom_operation` (op=`func.call`); callee = the
    // callee @symbol. declFilter keeps only func.func ops as functions.
    lang: 'mlir', rank: 104, query: 'helper', truth: 'run',
    sample: `func.func @save(%x: i32) -> i32 {\n  %r = func.call @store(%x) : (i32) -> i32\n  return %r : i32\n}\nfunc.func @save2(%x: i32) -> i32 {\n  return %x : i32\n}\nfunc.func @run() {\n  func.call @helper() : () -> ()\n  return\n}\n`,
  },

  // ---- Breadth wave 3: the long-tail call-capable ceiling. Each decoy-proof-
  //      resolved by a real extractStructure run (functions + call line ->
  //      enclosing function == `run`). See camp-a-extend3.md for the honest N/A
  //      ceiling (config/markup/data/query/template DSLs with no caller concept).
  {
    // DEEPENED: clojure `list_lit` added to callNodeTypes — same homoiconic shape
    // as scheme/racket/janet. The existing declFilter (head == defn/defmacro/…)
    // gates def-vs-call; non-definer lists fall through to the call branch.
    lang: 'clojure', rank: 105, query: 'helper', truth: 'run',
    sample: `(defn save [x] (store x))\n(defn save2 [x] x)\n(defn run [x] (helper x))\n`,
  },
  {
    // graphql: `operation_definition` (named query) is the function unit; a `field`
    // selection is the call. `run` selects the unique `helper` field; the decoy
    // `save` operations select `store`/`field2`. Resolved by enclosing operation.
    lang: 'graphql', rank: 106, query: 'helper', truth: 'run',
    sample: `query save {\n  store\n}\nquery save2 {\n  field2\n}\nquery run {\n  helper\n}\n`,
  },
  {
    // sql: `create_function` is the function unit; an `invocation` is the call.
    // `run`'s body invokes the unique `helper`; the decoy `save` invokes `store`.
    lang: 'sql', rank: 107, query: 'helper', truth: 'run',
    sample: `CREATE FUNCTION save(x int) RETURNS int AS $$ SELECT store(x); $$ LANGUAGE sql;\nCREATE FUNCTION save2(x int) RETURNS int AS $$ SELECT x; $$ LANGUAGE sql;\nCREATE FUNCTION run() RETURNS int AS $$ SELECT helper(5); $$ LANGUAGE sql;\n`,
  },
];
