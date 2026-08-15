













































export interface TopLang {

  lang: string;

  rank: number;

  sample: string;

  query: string;

  truth: string;
}







export const TOP_LANGS: TopLang[] = [

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





  {
    lang: 'ocaml', rank: 48, query: 'helper', truth: 'run',
    sample: `let save x = store x\nlet save2 x = x\nlet run () = helper 5\n`,
  },
  {


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

    lang: 'bicep', rank: 82, query: 'helper', truth: 'run',
    sample: `func save(x int) int => store(x)\nfunc save2(x int) int => x\nfunc run(x int) int => helper(x)\n`,
  },
  {

    lang: 'cobol', rank: 83, query: 'HELPER-PARA', truth: 'RUN-PARA',
    sample: `       IDENTIFICATION DIVISION.\n       PROGRAM-ID. A.\n       PROCEDURE DIVISION.\n       SAVE-PARA.\n           PERFORM STORE-PARA.\n       RUN-PARA.\n           PERFORM HELPER-PARA.\n       STORE-PARA.\n           DISPLAY 'X'.\n       HELPER-PARA.\n           DISPLAY 'Y'.\n`,
  },
  {

    lang: 'julia', rank: 84, query: 'helper', truth: 'run',
    sample: `function save(x)\n  store(x)\nend\nfunction save2(x)\n  x\nend\nfunction run(x)\n  helper(x)\nend\n`,
  },
  {

    lang: 'objc', rank: 85, query: 'helper', truth: 'run',
    sample: `int save(int x) {\n  return store(x);\n}\nint save2(int x) {\n  return x;\n}\nvoid run() {\n  helper(5);\n}\n`,
  },
  {

    lang: 'scheme', rank: 86, query: 'helper', truth: 'run',
    sample: `(define (save x) (store x))\n(define (save2 x) x)\n(define (run x) (helper x))\n`,
  },
  {

    lang: 'racket', rank: 87, query: 'helper', truth: 'run',
    sample: `(define (save x) (store x))\n(define (save2 x) x)\n(define (run x) (helper x))\n`,
  },
  {

    lang: 'commonlisp', rank: 88, query: 'helper', truth: 'run',
    sample: `(defun save (x) (store x))\n(defun save2 (x) x)\n(defun run (x) (helper x))\n`,
  },
  {

    lang: 'janet', rank: 89, query: 'helper', truth: 'run',
    sample: `(defn save [x] (store x))\n(defn save2 [x] x)\n(defn run [x] (helper x))\n`,
  },
  {

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

    lang: 'ql', rank: 95, query: 'helper', truth: 'run',
    sample: `int save(int x) { result = store(x) }\nint save2(int x) { result = x }\nint run() { result = helper(5) }\n`,
  },
  {


    lang: 'vhdl', rank: 96, query: 'helper', truth: 'run',
    sample: `package body p is\n  procedure save(x: integer) is\n  begin\n    store(x);\n  end;\n  procedure save2(x: integer) is\n  begin\n    null;\n  end;\n  procedure run is\n  begin\n    helper(5);\n  end;\nend;\n`,
  },
  {

    lang: 'p4', rank: 97, query: 'helper', truth: 'run',
    sample: `action save(bit x) { store(x); }\naction save2(bit x) { x; }\naction run() { helper(5); }\n`,
  },
  {

    lang: 'nickel', rank: 98, query: 'helper', truth: 'run',
    sample: `let save = fun x => store x in\nlet save2 = fun x => x in\nlet run = fun x => helper x in\nrun 5\n`,
  },
  {

    lang: 'systemverilog', rank: 99, query: 'helper', truth: 'run',
    sample: `module m;\n  function int save(int x); return store(x); endfunction\n  function int save2(int x); return x; endfunction\n  function int run(); return helper(5); endfunction\nendmodule\n`,
  },
  {


    lang: 'cmake', rank: 100, query: 'helper', truth: 'run',
    sample: `function(save x)\n  store(\${x})\nendfunction()\nfunction(save2 x)\n  message(\${x})\nendfunction()\nfunction(run)\n  helper(5)\nendfunction()\n`,
  },







  {


    lang: 'llvm', rank: 101, query: '@helper', truth: '@run',
    sample: `define i32 @save(i32 %x) {\n  %r = call i32 @store(i32 %x)\n  ret i32 %r\n}\ndefine i32 @save2(i32 %x) {\n  ret i32 %x\n}\ndefine void @run() {\n  call void @helper(i32 5)\n  ret void\n}\n`,
  },
  {


    lang: 'wat', rank: 102, query: '$helper', truth: '$run',
    sample: `(module\n  (func $save (param $x i32) (result i32)\n    local.get $x\n    call $store)\n  (func $save2 (param $x i32) (result i32)\n    local.get $x)\n  (func $run\n    i32.const 5\n    call $helper))\n`,
  },
  {


    lang: 'nasm', rank: 103, query: 'helper', truth: 'run',
    sample: `save:\n    call store\n    ret\nsave2:\n    ret\nrun:\n    call helper\n    ret\n`,
  },
  {


    lang: 'mlir', rank: 104, query: 'helper', truth: 'run',
    sample: `func.func @save(%x: i32) -> i32 {\n  %r = func.call @store(%x) : (i32) -> i32\n  return %r : i32\n}\nfunc.func @save2(%x: i32) -> i32 {\n  return %x : i32\n}\nfunc.func @run() {\n  func.call @helper() : () -> ()\n  return\n}\n`,
  },





  {



    lang: 'clojure', rank: 105, query: 'helper', truth: 'run',
    sample: `(defn save [x] (store x))\n(defn save2 [x] x)\n(defn run [x] (helper x))\n`,
  },
  {



    lang: 'graphql', rank: 106, query: 'helper', truth: 'run',
    sample: `query save {\n  store\n}\nquery save2 {\n  field2\n}\nquery run {\n  helper\n}\n`,
  },
  {


    lang: 'sql', rank: 107, query: 'helper', truth: 'run',
    sample: `CREATE FUNCTION save(x int) RETURNS int AS $$ SELECT store(x); $$ LANGUAGE sql;\nCREATE FUNCTION save2(x int) RETURNS int AS $$ SELECT x; $$ LANGUAGE sql;\nCREATE FUNCTION run() RETURNS int AS $$ SELECT helper(5); $$ LANGUAGE sql;\n`,
  },
];
