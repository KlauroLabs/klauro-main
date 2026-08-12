/**
 * Per-language tree-sitter node-type specs — the breadth engine.
 *
 * Learned from DeusData/codebase-memory-mcp (MIT), whose 158-language reach comes
 * from a `CBMLangSpec` table (function/class/call/import node-type arrays) driven
 * by a single generic AST walker, with small name-resolvers for niche grammars.
 * We replicate that design on top of our existing `tree-sitter-wasms` grammars +
 * `queryWasm`/`parseWasm`: a language gets structural coverage (functions, calls,
 * classes, imports) the moment it has a grammar + a spec entry — no bespoke
 * analyzer. Our 21 DEEP analyzers + 35 frameworks + 64 libraries then layer the
 * out-of-category comprehension on top. Breadth parity, depth advantage.
 *
 * Node types are GROUNDED in the real grammar (dump the AST, don't guess).
 */

export interface LanguageSpec {
  /** Grammar id as shipped by tree-sitter-wasms (tree-sitter-<id>.wasm). */
  grammar: string;
  /** AST node types that declare a function/method. */
  functionNodeTypes: string[];
  /** AST node types that declare a class/struct/interface/object. */
  classNodeTypes: string[];
  /**
   * Optional: the CAS node TYPE emitted for classNodeTypes matches. Defaults to
   * 'class'. Markup/style grammars whose "class-like" blocks are NOT semantic
   * classes must override this so they never pollute type==='class' consumers
   * (entity gates, inventory class counts, arch heuristics). Measured live:
   * a benchmarked Spring Boot repo's ONE bundled stylesheet produced 2543 'class' nodes (each CSS
   * selector block) — 40x the repo's real Java classes — skewing every
   * class-count signal in the analysis. The nodes stay in the graph (breadth
   * coverage keeps them); only their type label is honest now.
   */
  classNodeLabel?: string;
  /**
   * Optional: when true, classNodeTypes matches for this grammar are NOT emitted
   * as one CAS node per match. Instead the walker emits a single aggregate node
   * per file (type = classNodeLabel, name = the file's basename) carrying
   * metadata.attributes.rule_count (the true total, never truncated) and a
   * capped `sample_selectors` preview for evidence. Exists because a single
   * per-selector `style_rule` node is the wrong granularity for CSS: one bundled
   * stylesheet contributing thousands of graph nodes dwarfs the rest of a real
   * codebase's structure (measured: 2,708 style_rule nodes vs 229 methods on a
   * Java Spring repo, 69% of the entire node graph) while having zero downstream
   * consumers (no reachability walk, capability, or search path reads
   * type==='style_rule'). Aggregating preserves the fact ("this file has 2,708
   * rules") without paying the per-node cost of indexing each selector as if it
   * were a first-class structural unit. Not a truncation: the count is exact and
   * the samples are labeled as a preview, not the full list.
   */
  aggregateClassNodes?: boolean;
  /** AST node types representing a call expression. */
  callNodeTypes: string[];
  /** AST node types representing an import/use/require statement. */
  importNodeTypes: string[];
  /**
   * Optional: callee names that act as imports when called (e.g. Lua `require`,
   * Python has a real import node so doesn't need this). A call to one of these
   * is recorded as an import edge, not a call.
   */
  importCallNames?: string[];
  /** Field name holding a declaration's identifier, if the grammar exposes one. */
  nameField?: string;
  /**
   * Custom name extractor for grammars whose name shape defeats the generic
   * first-identifier descent (homoiconic Lisps, header-wrapped declarations).
   * Receives the matched declaration node (web-tree-sitter / NativeNode surface).
   */
  resolveName?: (node: any) => string;
  /**
   * Optional predicate gating a matched function/class node. When present, a node
   * whose type is in functionNodeTypes/classNodeTypes is only recorded if this
   * returns true — e.g. a Lisp `list` counts as a function only when its head
   * symbol is a definer (`define`/`defun`).
   */
  declFilter?: (node: any) => boolean;
  /**
   * Optional callee extractor for grammars where the callee is NOT the call node's
   * first child — the assembly / IR tier (LLVM `call void @foo`, WAT `call $foo`,
   * NASM `call foo`, MLIR `func.call @foo`), where the callee is a later operand.
   * Receives the matched call node; returns the callee name ('' to skip this node,
   * e.g. a non-call instruction sharing the call node type). Purely additive: a
   * spec without it keeps the generic first-child callee behavior unchanged.
   */
  resolveCallee?: (node: any) => string;
}

/** First named child of `node` (web-tree-sitter / NativeNode surface), or null. */
function firstNamed(node: any): any {
  return node.namedChildCount > 0 ? node.namedChild(0) : null;
}

/** A Lisp `list`/`list_lit` whose head symbol names a definer — used as the
 *  declFilter for homoiconic grammars where every form is a list. */
function lispIsDef(node: any, prefixes: string[]): boolean {
  const head = firstNamed(node);
  const t = head?.type || '';
  if (!/sym|symbol/.test(t)) return false;
  const txt = head.text || '';
  return prefixes.some(p => txt === p || txt.startsWith(p));
}

/** First descendant (DFS, pre-order) whose type exactly matches `type`, or ''.
 *  Source-order-first — the declaration's own identifier precedes body uses. */
function firstDescByType(node: any, type: string, depth = 0): string {
  if (depth > 6) return '';
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (!c) continue;
    if (c.type === type) return c.text;
    const r = firstDescByType(c, type, depth + 1);
    if (r) return r;
  }
  return '';
}

/** Name of a Lisp definition: `(define (f x) …)` → `f` (head of the 2nd form),
 *  `(define f …)` / `(defun f …)` → `f` (the 2nd symbol). */
function lispDefName(node: any): string {
  if (node.namedChildCount < 2) return '';
  const second = node.namedChild(1);
  const t = second?.type || '';
  if (/list/.test(t)) return firstNamed(second)?.text || '';
  return second?.text || '';
}

/** MLIR dialect op keyword for an `operation`/`custom_operation` node:
 *  operation → custom_operation → func_dialect → first child type
 *  (`func.func`, `func.call`, `return`). Returns '' when the shape doesn't match. */
function mlirOpKeyword(node: any): string {
  let co = node;
  if (co?.type === 'operation') co = co.namedChildCount > 0 ? co.namedChild(0) : null;
  const dialect = co && co.type === 'custom_operation' && co.namedChildCount > 0 ? co.namedChild(0) : null;
  if (!dialect || dialect.childCount === 0) return '';
  return dialect.child(0)?.type || '';
}

/**
 * Specs for grammars tree-sitter-wasms ships that we do NOT have a deep analyzer
 * for — instant breadth. (Deeply-analyzed languages keep their rich analyzers.)
 * Extend by dumping a grammar's node types and adding an entry.
 */
export const LANGUAGE_SPECS: Record<string, LanguageSpec> = {
  // VERIFIED against the real grammar (AST dumped, extraction measured). Only
  // grounded specs ship — a guessed spec that double-counts or mis-names is worse
  // than no coverage.
  lua: {
    grammar: 'lua',
    functionNodeTypes: ['function_definition_statement', 'local_function_definition_statement', 'function_definition', 'function_declaration'],
    classNodeTypes: [],
    callNodeTypes: ['call', 'function_call'],
    importNodeTypes: [],
    importCallNames: ['require'],
    // The def name is the first child — a `variable` (dotted `M.save`) or bare
    // `identifier`; take its text (the wasm grammar exposes no `name` field).
    resolveName: (node: any) => node.namedChild?.(0)?.text || '',
  },
  scala: {
    grammar: 'scala',
    functionNodeTypes: ['function_definition', 'function_declaration'],
    classNodeTypes: ['class_definition', 'object_definition', 'trait_definition'],
    callNodeTypes: ['call_expression', 'generic_function'],
    importNodeTypes: ['import_declaration'],
    nameField: 'name',
  },
  rescript: {
    grammar: 'rescript',
    // let_binding only — let_declaration wraps it, `function` nests inside it;
    // binding-level avoids the OCaml-style triple count.
    functionNodeTypes: ['let_binding'],
    classNodeTypes: [],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['open_statement', 'module_declaration'],
    nameField: 'name',
  },
  // VENDORED beyond tree-sitter-wasms (prebuilt .wasm from @tree-sitter-grammars/*
  // in vendored-grammars/). Proof that breadth = vendor a wasm + ground a spec.
  zig: {
    grammar: 'zig',
    functionNodeTypes: ['function_declaration'],
    classNodeTypes: [],
    callNodeTypes: ['call_expression'],
    importNodeTypes: [],
    nameField: 'name',
  },
  // julia DEFERRED (niche): function_definition name = the whole signature
  // "save(x)" and the signature's call-form double-counts as a call. Needs a
  // name resolver. wasm not vendored until grounded.
  // NATIVE (klauro-parse Rust binary, no wasm). Names resolved by descent.
  erlang: {
    grammar: 'erlang',
    functionNodeTypes: ['fun_decl'],
    classNodeTypes: [],
    callNodeTypes: ['call'],
    importNodeTypes: [],
  },
  gleam: {
    grammar: 'gleam',
    functionNodeTypes: ['function'],
    classNodeTypes: ['type_definition'],
    callNodeTypes: ['function_call'],
    importNodeTypes: ['import'],
  },
  fortran: {
    grammar: 'fortran',
    functionNodeTypes: ['subroutine', 'function'],
    classNodeTypes: ['module', 'derived_type_definition'],
    callNodeTypes: ['subroutine_call', 'call_expression'],
    importNodeTypes: ['use_statement'],
  },
  elm: {
    grammar: 'elm',
    functionNodeTypes: ['value_declaration'],
    classNodeTypes: ['type_declaration', 'type_alias_declaration'],
    callNodeTypes: ['function_call_expr'],
    importNodeTypes: ['import_clause'],
  },
  ada: {
    grammar: 'ada',
    functionNodeTypes: ['subprogram_body'],
    classNodeTypes: ['package_declaration', 'package_body'],
    callNodeTypes: ['procedure_call_statement', 'function_call'],
    importNodeTypes: ['with_clause'],
  },
  objc: {
    grammar: 'objc',
    functionNodeTypes: ['method_definition', 'function_definition'],
    classNodeTypes: ['class_implementation', 'class_interface'],
    // message_expression's first child is the RECEIVER (self/obj), not the
    // selector — recording it as a callee would be wrong, so that node stays out.
    // Plain C-style call_expression (`helper(5)`) is unambiguous (callee = first
    // child identifier) and ships.
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['preproc_import', 'module_import'],
  },
  perl: {
    grammar: 'perl',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: [],
    // Bracketed-call only: the bareword variant nests INSIDE the bracketed node
    // (`store(...)` = bareword `store` + bracket args), so listing both double-counts.
    callNodeTypes: ['call_expression_with_args_with_brackets'],
    importNodeTypes: ['use_statement'],
  },
  odin: {
    grammar: 'odin',
    functionNodeTypes: ['procedure_declaration'],
    classNodeTypes: ['struct_declaration'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['import_declaration'],
  },
  pascal: {
    grammar: 'pascal',
    functionNodeTypes: ['defProc'],
    classNodeTypes: ['defType'],
    callNodeTypes: ['exprCall'],
    importNodeTypes: ['declUses'],
  },
  proto: {
    grammar: 'proto',
    functionNodeTypes: ['rpc'],
    classNodeTypes: ['service', 'message'],
    callNodeTypes: [],
    importNodeTypes: ['import'],
  },
  // GLSL/HLSL share C's grammar shape: function_definition → function_declarator
  // → identifier; calls are call_expression.
  glsl: {
    grammar: 'glsl',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: ['struct_specifier'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['preproc_include'],
  },
  hlsl: {
    grammar: 'hlsl',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: ['struct_specifier', 'class_specifier'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['preproc_include'],
  },
  // Reclaimed via firstDescByType resolvers (their names live under nodes the
  // generic descent skips or in a sibling-identifier position).
  cmake: {
    grammar: 'cmake',
    functionNodeTypes: ['function_def', 'macro_def'],
    classNodeTypes: [],
    callNodeTypes: ['normal_command'],
    importNodeTypes: [],
    // function name = first unquoted_argument (precedes the param args in order).
    resolveName: (node: any) => firstDescByType(node, 'unquoted_argument'),
  },
  verilog: {
    grammar: 'verilog',
    functionNodeTypes: ['task_declaration', 'function_declaration'],
    classNodeTypes: ['module_declaration', 'class_declaration'],
    callNodeTypes: [],
    importNodeTypes: ['package_import_declaration'],
    // name = first simple_identifier in the subtree (module/task name precedes body).
    resolveName: (node: any) => firstDescByType(node, 'simple_identifier'),
  },
  groovy: {
    grammar: 'groovy',
    functionNodeTypes: ['method_declaration', 'function_definition'],
    classNodeTypes: ['class_declaration'],
    callNodeTypes: ['method_invocation'],
    importNodeTypes: ['import_declaration'],
    // method name = the `identifier` child (the return-type token is type_identifier).
    resolveName: (node: any) => firstDescByType(node, 'identifier'),
  },
  powershell: {
    grammar: 'powershell',
    functionNodeTypes: ['function_statement'],
    classNodeTypes: ['class_statement'],
    callNodeTypes: ['command'],
    importNodeTypes: [],
  },
  d: {
    grammar: 'd',
    functionNodeTypes: ['function_declaration'],
    classNodeTypes: ['class_declaration', 'struct_declaration'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['import_declaration'],
  },
  // LISP FAMILY — homoiconic, so the generic descent can't find names. Resolved
  // by per-grammar hooks (the same niche-resolver approach codebase-memory ships).
  // Common Lisp exposes a real `defun` node (covers defun/defmethod/defmacro);
  // the name is the first sym_lit inside defun_header.
  commonlisp: {
    grammar: 'commonlisp',
    functionNodeTypes: ['defun'],
    classNodeTypes: [],
    // A definition is a `defun` node; every other `list_lit` is an application.
    // The defun-wrapping outer list_lit also matches, but its head is the defun
    // form (not a distinct query target), so the who-calls resolution is unaffected.
    callNodeTypes: ['list_lit'],
    importNodeTypes: [],
    resolveName: (node: any) => {
      const header = firstNamed(node); // defun_header
      if (!header) return '';
      for (let i = 0; i < header.namedChildCount; i++) {
        const c = header.namedChild(i);
        if (c?.type === 'sym_lit') return c.text;
      }
      return '';
    },
  },
  // Scheme & Racket: every form is a `list` of `symbol`s. A function is a list
  // whose head symbol is a definer; the name follows (bare symbol or head of the
  // signature list). Calls left empty — head-symbol call detection over-counts.
  scheme: {
    grammar: 'scheme',
    functionNodeTypes: ['list'],
    classNodeTypes: [],
    // A `list` is a function only when its head is a definer (declFilter); the
    // fn/class branch is checked first (else-if), so a non-definer list — a real
    // call like `(helper x)` — falls through here. callee = head symbol.
    callNodeTypes: ['list'],
    importNodeTypes: [],
    declFilter: (node: any) => lispIsDef(node, ['define', 'defun']),
    resolveName: lispDefName,
  },
  racket: {
    grammar: 'racket',
    functionNodeTypes: ['list'],
    classNodeTypes: [],
    // Same list-is-call-unless-definer shape as scheme (else-if ordering gates it).
    callNodeTypes: ['list'],
    importNodeTypes: [],
    declFilter: (node: any) => lispIsDef(node, ['define', 'defun']),
    resolveName: lispDefName,
  },
  // R: a function is `name <- function(...) …` — a binary_operator whose RHS is a
  // function_definition; the name is the LHS identifier. library()/require() calls
  // are imports (like Lua's require).
  r: {
    grammar: 'r',
    functionNodeTypes: ['binary_operator'],
    classNodeTypes: [],
    callNodeTypes: ['call'],
    importNodeTypes: [],
    importCallNames: ['library', 'require', 'requireNamespace', 'loadNamespace'],
    declFilter: (node: any) => {
      for (let i = 0; i < node.namedChildCount; i++) {
        if (node.namedChild(i)?.type === 'function_definition') return true;
      }
      return false;
    },
    resolveName: (node: any) => firstDescByType(node, 'identifier'),
  },
  // VHDL: architecture/entity/package are the units; process_statement &
  // subprogram_body are the behavior. Name = first identifier (strips the
  // process label's trailing colon, which label_declaration carries separately).
  vhdl: {
    grammar: 'vhdl',
    functionNodeTypes: ['process_statement', 'subprogram_body', 'subprogram_definition'],
    classNodeTypes: ['architecture_definition', 'entity_declaration', 'package_declaration', 'package_definition'],
    callNodeTypes: ['procedure_call', 'procedure_call_statement'],
    importNodeTypes: ['library_clause', 'use_clause'],
    resolveName: (node: any) => {
      const id = firstDescByType(node, 'identifier');
      if (id) return id;
      // process_statement labels live in a label_declaration that carries the
      // trailing colon as text rather than an identifier child.
      const label = firstDescByType(node, 'label_declaration') ||
        (node.namedChildCount > 0 ? node.namedChild(0)?.text || '' : '');
      return label.replace(/\s*:\s*$/, '').trim();
    },
  },
  haskell: {
    grammar: 'haskell',
    functionNodeTypes: ['function'],
    classNodeTypes: ['data_type', 'class_declaration'],
    callNodeTypes: ['apply'],
    importNodeTypes: ['import'],
    nameField: 'name',
  },
  // Nix: a `binding` (attrpath = value) is the definition unit; `save = x: …`
  // binds a lambda. Calls are `apply_expression` (function application).
  nix: {
    grammar: 'nix',
    functionNodeTypes: ['binding'],
    classNodeTypes: [],
    callNodeTypes: ['apply_expression'],
    importNodeTypes: [],
  },
  // Jsonnet: object `field`s; a field with `params` is a function (`save(x): …`).
  jsonnet: {
    grammar: 'jsonnet',
    functionNodeTypes: ['field'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: ['importstr', 'import'],
  },
  // GDScript (Godot): Python-shaped — func/class with a `name` field, `call` nodes.
  gdscript: {
    grammar: 'gdscript',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: ['class_definition'],
    callNodeTypes: ['call'],
    importNodeTypes: [],
    nameField: 'name',
  },
  // Starlark (Bazel/Buck BUILD): Python-shaped; `load(...)` acts as an import.
  starlark: {
    grammar: 'starlark',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: [],
    callNodeTypes: ['call'],
    importNodeTypes: [],
    importCallNames: ['load'],
    nameField: 'name',
  },
  // Slang (shader language): C-shaped — function_definition → function_declarator.
  slang: {
    grammar: 'slang',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: ['struct_specifier', 'class_specifier'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['preproc_include', 'import_declaration'],
  },
  // OCaml: bind at the `let_binding` level (value_definition WRAPS it — matching
  // both double-counts); calls are `application_expression`.
  ocaml: {
    grammar: 'ocaml',
    functionNodeTypes: ['let_binding'],
    classNodeTypes: ['module_definition', 'type_definition'],
    callNodeTypes: ['application_expression'],
    importNodeTypes: ['open_module'],
  },
  // Nickel (config language): `let_binding` defs. Calls deferred — `applicative`
  // over-matches partial applications + infix operands (noisy callees).
  nickel: {
    grammar: 'nickel',
    functionNodeTypes: ['let_binding'],
    classNodeTypes: [],
    // Application `f x` is a (left-nested) `applicative`; its head operand carries
    // the callee. Nesting yields extra call records but the head name is stable.
    callNodeTypes: ['applicative'],
    importNodeTypes: [],
  },
  // Agda DEFERRED (not in NATIVE_LANGS, spec inert): the type signature `save : Nat`
  // and the clause `save = …` BOTH parse as `function`, double-counting every name.
  // Needs a resolver that keeps only clauses with an rhs before shipping.
  agda: {
    grammar: 'agda',
    functionNodeTypes: ['function'],
    classNodeTypes: ['module'],
    callNodeTypes: [],
    importNodeTypes: ['import'],
  },
  // CONFIG / MARKUP grammars (wasm, on disk) — no function/class call-graph; the
  // meaningful structural unit is the declaration/block. codebase-memory indexes
  // these as nodes too, so this is Camp-B parity. Grounded on real AST dumps.
  // JSON: each object `pair` key → a structural entry. Name = first `string`
  // child's `string_content` (unquoted key); nested pairs captured by the walk.
  json: {
    grammar: 'json',
    functionNodeTypes: ['pair'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => {
      const k = node.namedChild?.(0);
      if (k?.type !== 'string') return '';
      const sc = k.namedChild?.(0);
      return sc?.type === 'string_content' ? sc.text : '';
    },
  },
  // TOML: `[table]`/`[[array]]` headers → classes; `pair` keys → functions.
  // Name = first dotted_key (db.pool) else bare_key.
  toml: {
    grammar: 'toml',
    functionNodeTypes: ['pair'],
    classNodeTypes: ['table', 'table_array_element'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) =>
      firstDescByType(node, 'dotted_key') || firstDescByType(node, 'bare_key'),
  },
  // CSS: each `rule_set` (selector block) → a class named by its `selectors` text.
  css: {
    grammar: 'css',
    functionNodeTypes: [],
    classNodeTypes: ['rule_set'],
    classNodeLabel: 'style_rule',
    aggregateClassNodes: true,
    callNodeTypes: [],
    importNodeTypes: ['import_statement'],
    resolveName: (node: any) => firstDescByType(node, 'selectors').replace(/\s+/g, ' ').trim(),
  },
  // HTML: each `element` (tag) → a class named by its `tag_name`; nested tags
  // captured by the walk. `script_element` is the natural import (inline/external JS).
  html: {
    grammar: 'html',
    functionNodeTypes: [],
    classNodeTypes: ['element'],
    classNodeLabel: 'markup_element',
    callNodeTypes: [],
    importNodeTypes: ['script_element'],
    resolveName: (node: any) => {
      const st = node.namedChild?.(0);
      if (st?.type !== 'start_tag' && st?.type !== 'self_closing_tag') return firstDescByType(node, 'tag_name');
      return firstDescByType(st, 'tag_name');
    },
  },
  // HCL / Terraform: `block`s (resource/variable/module) → classes named by their
  // LAST string label; `attribute` key=value → functions. (vendored wasm)
  hcl: {
    grammar: 'hcl',
    functionNodeTypes: ['attribute'],
    classNodeTypes: ['block'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => {
      if (node.type === 'block') {
        const labels: string[] = [];
        for (let i = 0; i < node.namedChildCount; i++) {
          const c = node.namedChild(i);
          if (c.type === 'string_lit') labels.push(c.text.replace(/^["']|["']$/g, ''));
        }
        if (labels.length) return labels[labels.length - 1];
        return node.namedChild(0)?.text || '';
      }
      if (node.type === 'attribute') {
        const id = node.namedChild(0);
        return id?.type === 'identifier' ? id.text : '';
      }
      return '';
    },
  },
  // Makefile: each `rule` → a target named by its first `targets` word. (vendored wasm)
  make: {
    grammar: 'make',
    functionNodeTypes: ['rule'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: ['include_directive'],
    resolveName: (node: any) => {
      if (node.type !== 'rule') return '';
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (c.type === 'targets') return c.namedChild(0)?.text || '';
      }
      return '';
    },
  },
  // Dockerfile: `from_instruction` → build stage (class, named by AS alias / image);
  // other instructions → functions named by keyword (RUN/COPY/...). (vendored ABI-14 wasm)
  dockerfile: {
    grammar: 'dockerfile',
    functionNodeTypes: ['run_instruction', 'copy_instruction', 'add_instruction', 'cmd_instruction', 'entrypoint_instruction'],
    classNodeTypes: ['from_instruction'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => {
      if (node.type === 'from_instruction') {
        for (let i = 0; i < node.namedChildCount; i++) {
          if (node.namedChild(i).type === 'image_alias') return node.namedChild(i).text;
        }
        for (let i = 0; i < node.namedChildCount; i++) {
          if (node.namedChild(i).type === 'image_spec') return node.namedChild(i).namedChild(0)?.text || '';
        }
        return '';
      }
      return node.type.replace(/_instruction$/, '').toUpperCase();
    },
  },
  // LaTeX: `\newcommand` etc. → functions (command name, backslash stripped);
  // sections → classes named by heading text. (vendored ABI-14 wasm)
  latex: {
    grammar: 'latex',
    functionNodeTypes: ['new_command_definition', 'old_command_definition', 'let_command_definition'],
    classNodeTypes: ['section', 'subsection', 'chapter', 'part'],
    callNodeTypes: [],
    importNodeTypes: ['package_include', 'class_include'],
    resolveName: (node: any) => {
      const findType = (n: any, t: string): string => {
        if (n.type === t) return n.text;
        for (let i = 0; i < n.namedChildCount; i++) { const r = findType(n.namedChild(i), t); if (r) return r; }
        return '';
      };
      if (/command_definition/.test(node.type)) return findType(node, 'command_name').replace(/^\\/, '');
      if (/section|chapter|part/.test(node.type)) return findType(node, 'word');
      return '';
    },
  },
  // Julia: function_definition/short_function_definition; struct_definition is the
  // type. Name via generic findNameLeaf (signature→call_expression→identifier).
  // Calls deferred — the signature re-parses as a call_expression of the fn's own
  // name (self-pollutes). (vendored wasm)
  julia: {
    grammar: 'julia',
    functionNodeTypes: ['function_definition', 'short_function_definition'],
    classNodeTypes: ['struct_definition'],
    // call_expression is the call node; the function's own signature also nests a
    // call_expression (`run(x)`), but that names the function, not a callee for any
    // distinct query target, so the who-calls resolution is unaffected.
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['using_statement', 'import_statement'],
  },
  // Clojure (homoiconic): `(defn name …)` is a list_lit whose head sym_lit is a
  // definer; the name is the 2nd child. One nesting level deeper than scheme/racket
  // (sym_lit→sym_name). Calls/imports deferred (head-symbol calls over-count). (vendored ABI-14 wasm)
  clojure: {
    grammar: 'clojure',
    functionNodeTypes: ['list_lit'],
    classNodeTypes: [],
    // DEEPENED: same homoiconic shape as scheme/racket — every form is a `list_lit`.
    // The declFilter gates def-vs-call (a list whose head is `defn`/`defmacro`/… is
    // a function; any other list is an application). The fn branch is checked first
    // (else-if), so a non-definer list — a real call like `(helper x)` — falls
    // through to the call branch. callee = head symbol (calleeName first child).
    callNodeTypes: ['list_lit'],
    importNodeTypes: [],
    declFilter: (node: any) => {
      const head = node.namedChildCount > 0 ? node.namedChild(0) : null;
      if (head?.type !== 'sym_lit') return false;
      const t = (head.namedChildCount > 0 ? node.namedChild(0).namedChild(0)?.text : head.text) ?? '';
      return ['defn', 'defn-', 'defmacro', 'defmethod', 'defmulti', 'definline'].includes(t);
    },
    resolveName: (node: any) => {
      if (node.namedChildCount < 2) return '';
      const second = node.namedChild(1);
      return (second.namedChildCount > 0 ? second.namedChild(0)?.text : second?.text) ?? '';
    },
  },
  // Nim: proc/func/method/template/macro/iterator/converter declarations; type_declaration
  // is the type; `call` nodes are calls. Clean — no resolver needed. (vendored wasm)
  nim: {
    grammar: 'nim',
    functionNodeTypes: ['proc_declaration', 'func_declaration', 'method_declaration', 'template_declaration', 'macro_declaration', 'iterator_declaration', 'converter_declaration'],
    classNodeTypes: ['type_declaration'],
    callNodeTypes: ['call'],
    importNodeTypes: ['import_statement', 'import_from_statement', 'include_statement'],
  },
  // F#: bind at function_or_value_defn (parent value_declaration wraps it — matching
  // both double-counts); type_definition is the type; application_expression = call. (vendored wasm)
  fsharp: {
    grammar: 'fsharp',
    functionNodeTypes: ['function_or_value_defn'],
    classNodeTypes: ['type_definition'],
    callNodeTypes: ['application_expression'],
    importNodeTypes: ['import_decl'],
  },
  // Crystal: method_def; class/module/struct/enum_def are types; `call` = call.
  // (require double-counts at the import level — harmless for fn/class/call facts.) (vendored ABI-14 wasm)
  crystal: {
    grammar: 'crystal',
    functionNodeTypes: ['method_def'],
    classNodeTypes: ['class_def', 'module_def', 'struct_def', 'enum_def'],
    callNodeTypes: ['call'],
    importNodeTypes: ['require'],
  },
  // PureScript: top-level `function` defs (name = first variable); data/newtype/class
  // are types; exp_apply = call. signature node excluded (no double-count). (vendored ABI-14 wasm)
  purescript: {
    grammar: 'purescript',
    functionNodeTypes: ['function'],
    classNodeTypes: ['data', 'newtype', 'class'],
    callNodeTypes: ['exp_apply'],
    importNodeTypes: ['import', 'foreign_import'],
    resolveName: (node: any) => firstDescByType(node, 'variable') || firstDescByType(node, 'type'),
  },
  // ReasonML (OCaml-shaped): let_binding defs (name = value_name); type_definition
  // name = type_constructor (NOT the record field); application_expression = call. (vendored ABI-14 wasm)
  reason: {
    grammar: 'reason',
    functionNodeTypes: ['let_binding'],
    classNodeTypes: ['type_definition', 'module_definition'],
    callNodeTypes: ['application_expression'],
    importNodeTypes: ['open_statement'],
    resolveName: (node: any) =>
      firstDescByType(node, 'value_name') || firstDescByType(node, 'type_constructor') || firstDescByType(node, 'module_name'),
  },
  // Pony: method/constructor/behavior; class/actor/interface/trait/primitive/struct
  // definitions are types; call_expression = call. Flat (findNameLeaf). (vendored ABI-14 wasm)
  pony: {
    grammar: 'pony',
    functionNodeTypes: ['method', 'constructor', 'behavior'],
    classNodeTypes: ['class_definition', 'actor_definition', 'interface_definition', 'trait_definition', 'primitive_definition', 'struct_definition'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['use_statement'],
  },
  // Tcl: `proc` → procedure (name = first simple_word); `command` = call. No imports
  // (source/package require are commands → surface as call edges). (vendored ABI-14 wasm)
  tcl: {
    grammar: 'tcl',
    functionNodeTypes: ['procedure'],
    classNodeTypes: [],
    callNodeTypes: ['command'],
    importNodeTypes: [],
    resolveName: (node: any) => firstDescByType(node, 'simple_word'),
  },
  // Wren: named_method/constructor_definition (NOT the method_definition wrapper) +
  // class_definition; call_expression = call. Flat (findNameLeaf). (vendored ABI-14 wasm, community fork)
  wren: {
    grammar: 'wren',
    functionNodeTypes: ['named_method', 'constructor_definition'],
    classNodeTypes: ['class_definition'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['import_statement'],
  },
  // SQL: CREATE FUNCTION/PROCEDURE → functions; CREATE TABLE/VIEW/TYPE → classes;
  // `invocation` = call. Name = first identifier. (vendored ABI-14 wasm, Codex-sourced)
  sql: {
    grammar: 'sql',
    functionNodeTypes: ['create_function', 'create_procedure'],
    classNodeTypes: ['create_table', 'create_view', 'create_type'],
    callNodeTypes: ['invocation'],
    importNodeTypes: [],
    resolveName: (node: any) => firstDescByType(node, 'identifier'),
  },
  // GraphQL: operation/fragment definitions → functions; type definitions → classes;
  // selected `field`s → calls (includes leaf fields — honest traversal). (vendored ABI-14 wasm)
  graphql: {
    grammar: 'graphql',
    functionNodeTypes: ['operation_definition', 'fragment_definition'],
    classNodeTypes: ['object_type_definition', 'interface_type_definition', 'input_object_type_definition', 'enum_type_definition', 'union_type_definition', 'scalar_type_definition'],
    callNodeTypes: ['field'],
    importNodeTypes: [],
  },
  // XML (markup): each `element` → a structural name (recursive); `EmptyElemTag`
  // (`<store/>`) → a call-like node. Name = first `Name`. (vendored ABI-14 wasm)
  xml: {
    grammar: 'xml',
    functionNodeTypes: ['element'],
    classNodeTypes: [],
    callNodeTypes: ['EmptyElemTag'],
    importNodeTypes: [],
    resolveName: (node: any) => firstDescByType(node, 'Name'),
  },
  // Vala: method/creation-method/signal/delegate decls → functions (name = `symbol`,
  // since the return type precedes it); class/interface/struct/enum/etc → classes. (vendored ABI-14 wasm)
  vala: {
    grammar: 'vala',
    functionNodeTypes: ['method_declaration', 'creation_method_declaration', 'signal_declaration', 'delegate_declaration', 'local_function_declaration'],
    classNodeTypes: ['class_declaration', 'interface_declaration', 'struct_declaration', 'enum_declaration', 'errordomain_declaration', 'namespace_declaration'],
    callNodeTypes: ['method_call_expression', 'object_creation_expression'],
    importNodeTypes: ['using_directive'],
    resolveName: (node: any) => {
      if (['method_declaration', 'creation_method_declaration', 'signal_declaration', 'delegate_declaration'].includes(node.type)) {
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i);
          if (child?.type === 'symbol') return child.text;
        }
      }
      return firstDescByType(node, 'identifier');
    },
  },
  // Haxe: function_declaration → functions; class/interface/typedef → classes;
  // call_expression = call. nameField:'name' suffices. (vendored ABI-14 wasm)
  haxe: {
    grammar: 'haxe',
    functionNodeTypes: ['function_declaration'],
    classNodeTypes: ['class_declaration', 'interface_declaration', 'typedef_declaration'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['import_statement', 'using_statement'],
    nameField: 'name',
  },
  // WGSL (shader): function_decl (name nested under function_header → ident);
  // struct_decl is the type; `callable` is the only call node (also wraps vecN/matN
  // type constructors → call over-count). (vendored wasm)
  wgsl: {
    grammar: 'wgsl',
    functionNodeTypes: ['function_decl'],
    classNodeTypes: ['struct_decl'],
    callNodeTypes: ['callable'],
    importNodeTypes: [],
    resolveName: (node: any) => firstDescByType(node, 'ident'),
  },
  // CUDA: C/C++ shape — function_definition; struct/class_specifier; call_expression;
  // preproc_include. __global__/__device__ don't change node types. (vendored ABI-14 wasm)
  cuda: {
    grammar: 'cuda',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: ['struct_specifier', 'class_specifier'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['preproc_include'],
  },
  // PRQL: function_definition (`let name params -> body`); no class concept;
  // function_call = call (only parses inside a pipeline/derive). (vendored ABI-14 wasm)
  prql: {
    grammar: 'prql',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: [],
    callNodeTypes: ['function_call'],
    importNodeTypes: [],
  },
  // Hack: function_declaration + method_declaration → functions; class_declaration;
  // call_expression. (vendored ABI-14 wasm)
  hack: {
    grammar: 'hack',
    functionNodeTypes: ['function_declaration', 'method_declaration'],
    classNodeTypes: ['class_declaration'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['use_statement', 'namespace_use_declaration'],
  },
  // COBOL (fixed-format): paragraphs (paragraph_header) → functions (strip trailing
  // period); program_definition → class (name = program_name); call_statement = call
  // (callee arrives quote-wrapped, a shared-calleeName limitation). (vendored ABI-14 wasm)
  cobol: {
    grammar: 'cobol',
    functionNodeTypes: ['paragraph_header'],
    classNodeTypes: ['program_definition'],
    callNodeTypes: ['call_statement', 'perform_procedure'],
    importNodeTypes: [],
    resolveName: (node: any) =>
      node.type === 'program_definition'
        ? firstDescByType(node, 'program_name')
        : (node.text || '').replace(/\.\s*$/, '').trim(),
  },
  // IDL / schema / config grammars (vendored ABI-14 wasm, built from source). The
  // structural unit is the declaration/message/field — no call graph (empty calls).
  // Cap'n Proto: struct/interface/enum → classes; method/field/const/enum_field → functions.
  capnp: {
    grammar: 'capnp',
    functionNodeTypes: ['method', 'field', 'const', 'enum_field'],
    classNodeTypes: ['struct', 'interface', 'enum'],
    callNodeTypes: [],
    importNodeTypes: ['using_statement', 'import_path'],
  },
  // Thrift: struct/service/enum/exception/union → classes; function/field → functions.
  thrift: {
    grammar: 'thrift',
    functionNodeTypes: ['function_definition', 'field'],
    classNodeTypes: ['struct_definition', 'service_definition', 'enum_definition', 'exception_definition', 'union_definition'],
    callNodeTypes: [],
    importNodeTypes: ['include_declaration'],
  },
  // Smithy: shape statements → classes; operation_statement → function.
  smithy: {
    grammar: 'smithy',
    functionNodeTypes: ['operation_statement'],
    classNodeTypes: ['structure_statement', 'service_statement', 'resource_statement', 'enum_statement', 'union_statement', 'list_statement', 'map_statement'],
    callNodeTypes: [],
    importNodeTypes: ['use_statement'],
  },
  // HOCON: each key `pair` → a config entry (name = key path, trailing space trimmed).
  hocon: {
    grammar: 'hocon',
    functionNodeTypes: ['pair'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: ['include'],
    resolveName: (node: any) => (node.namedChild?.(0)?.text || '').trim(),
  },
  // Dhall: `let` keyword node per binding; the label is its NEXT named sibling (flat grammar).
  dhall: {
    grammar: 'dhall',
    functionNodeTypes: ['let'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => node.nextNamedSibling?.text?.trim() || '',
  },
  // YAML: block_mapping_pair keys (REPAIRED — the shipped wasm was broken; this is a
  // rebuilt ABI-14 vendored grammar that wins over node_modules). (vendored ABI-14 wasm)
  yaml: {
    grammar: 'yaml',
    functionNodeTypes: ['block_mapping_pair'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => node.childForFieldName?.('key')?.text || node.namedChild?.(0)?.text || '',
  },
  // KDL: each `node` declaration → a structural unit (name = its `name` field). (vendored ABI-14 wasm)
  kdl: {
    grammar: 'kdl',
    functionNodeTypes: [],
    classNodeTypes: ['node'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => node.childForFieldName?.('name')?.text || firstDescByType(node, 'identifier'),
  },
  // CUE: each `field` → a config unit named by its label identifier. (vendored ABI-14 wasm)
  cue: {
    grammar: 'cue',
    functionNodeTypes: ['field'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: ['package_clause'],
    resolveName: (node: any) => firstDescByType(node, 'identifier') || node.namedChild?.(0)?.text || '',
  },
  // NGINX: directives (`attribute`, name = keyword) + `location` blocks → structural units.
  // declFilter drops the bare `location` token node. (vendored ABI-14 wasm)
  nginx: {
    grammar: 'nginx',
    functionNodeTypes: [],
    classNodeTypes: ['attribute', 'location'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => node.type === 'location'
      ? `location ${(node.text || '').replace(/^location\s+/, '').replace(/\s*\{[\s\S]*$/, '').trim()}`
      : firstDescByType(node, 'keyword'),
    declFilter: (node: any) => node.type !== 'location' || /\{/.test(node.text || ''),
  },
  // INI: `section` → class (name = section_name text), `setting` → function (setting_name). (vendored ABI-14 wasm)
  ini: {
    grammar: 'ini',
    functionNodeTypes: ['setting'],
    classNodeTypes: ['section'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => node.type === 'section'
      ? firstDescByType(node, 'text')
      : firstDescByType(node, 'setting_name'),
  },
  // Standard ML: fun_dec (name = first vid); strbind (structure) → class (strid);
  // app_exp = call. No file imports. (vendored ABI-14 wasm)
  sml: {
    grammar: 'sml',
    functionNodeTypes: ['fun_dec'],
    classNodeTypes: ['strbind'],
    callNodeTypes: ['app_exp'],
    importNodeTypes: [],
    resolveName: (node: any) =>
      node.type === 'strbind' ? firstDescByType(node, 'strid') : firstDescByType(node, 'vid'),
  },
  // Hare: function_declaration; type_declaration; call_expression; use_statement.
  // Flat names (findNameLeaf). (vendored ABI-14 wasm)
  hare: {
    grammar: 'hare',
    functionNodeTypes: ['function_declaration'],
    classNodeTypes: ['type_declaration'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['use_statement'],
  },
  // Gren (Elm-family): value_declaration (NOT function_declaration_left — avoids
  // double-count); type/type_alias declarations; function_call_expr = call. (vendored ABI-14 wasm)
  gren: {
    grammar: 'gren',
    functionNodeTypes: ['value_declaration'],
    classNodeTypes: ['type_declaration', 'type_alias_declaration'],
    callNodeTypes: ['function_call_expr'],
    importNodeTypes: ['import_clause'],
    resolveName: (node: any) =>
      node.type === 'type_declaration'
        ? firstDescByType(node, 'upper_case_identifier')
        : firstDescByType(node, 'lower_case_identifier'),
  },
  // Ballerina: function_defn; class_defn; call = function_call_expr (the inner
  // reference, NOT outer call_expr); import_decl. (vendored ABI-14 wasm)
  ballerina: {
    grammar: 'ballerina',
    functionNodeTypes: ['function_defn'],
    classNodeTypes: ['class_defn'],
    callNodeTypes: ['function_call_expr'],
    importNodeTypes: ['import_decl'],
  },
  // Grain: value_binding whose value is a lambda → function (declFilter); name from
  // the `pattern` field; record/enum declarations → classes; application_expression
  // = call. (vendored ABI-14 wasm)
  grain: {
    grammar: 'grain',
    functionNodeTypes: ['value_binding'],
    classNodeTypes: ['record_type_declaration', 'enum_declaration'],
    callNodeTypes: ['application_expression'],
    importNodeTypes: ['include_declaration', 'use_statement'],
    resolveName: (node: any): string => {
      if (node.type === 'value_binding') {
        const pat = node.childForFieldName?.('pattern');
        if (pat) return firstDescByType(pat, 'identifier') || pat.text;
        return firstDescByType(node, 'identifier');
      }
      return firstDescByType(node, 'upper_identifier');
    },
    declFilter: (node: any): boolean => {
      if (node.type !== 'value_binding') return true;
      const val = node.childForFieldName?.('value');
      return !!val && val.type === 'lambda_expression';
    },
  },
  // AWK: func_def (name field); func_call = call. (vendored wasm)
  awk: {
    grammar: 'awk',
    functionNodeTypes: ['func_def'],
    classNodeTypes: [],
    callNodeTypes: ['func_call'],
    importNodeTypes: [],
    nameField: 'name',
  },
  // Fish (shell): function_definition (name field); `command` = call (builtins included —
  // the honest call surface for a shell). (vendored ABI-14 wasm)
  fish: {
    grammar: 'fish',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: [],
    callNodeTypes: ['command'],
    importNodeTypes: [],
    nameField: 'name',
  },
  // jq: function_definition (name field); call_expression = call (only applied/parenthesized
  // forms — correct jq semantics). (vendored ABI-14 wasm)
  jq: {
    grammar: 'jq',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: [],
    callNodeTypes: ['call_expression'],
    importNodeTypes: [],
    nameField: 'name',
  },
  // just (justfile): recipe → target (name = recipe_header's name field). No call graph
  // (recipe bodies are opaque shell text). (vendored ABI-14 wasm)
  just: {
    grammar: 'just',
    functionNodeTypes: ['recipe'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => {
      const header = node.namedChildCount > 0 ? node.namedChild(0) : null;
      return header?.childForFieldName?.('name')?.text || firstDescByType(node, 'identifier');
    },
  },
  // Pkl (Apple config): clazz → class; classMethod/classProperty → functions; importClause.
  // Calls deferred (unqualifiedAccessExpr conflates calls with bare refs). (vendored ABI-14 wasm)
  pkl: {
    grammar: 'pkl',
    functionNodeTypes: ['classMethod', 'classProperty'],
    classNodeTypes: ['clazz'],
    callNodeTypes: [],
    importNodeTypes: ['importClause'],
    resolveName: (node: any) =>
      node.type === 'classMethod'
        ? node.namedChild?.(0)?.namedChild?.(0)?.text || ''
        : node.namedChild?.(0)?.text || '',
  },
  // Typst: a `let` bound to a call signature `name(...)` → function (declFilter);
  // headings → markup units; `call` = call; `import`. (vendored ABI-14 wasm)
  typst: {
    grammar: 'typst',
    functionNodeTypes: ['let'],
    classNodeTypes: ['heading'],
    callNodeTypes: ['call'],
    importNodeTypes: ['import'],
    declFilter: (node: any) =>
      (node.namedChildCount > 0 ? node.namedChild(0)?.type : null) === 'call' || node.type !== 'let',
    resolveName: (node: any) => {
      if (node.type === 'heading') return firstDescByType(node, 'text').trim();
      const sig = node.namedChildCount > 0 ? node.namedChild(0) : null;
      return sig?.type === 'call' ? firstDescByType(sig, 'ident') : '';
    },
  },
  // Janet (homoiconic Lisp): par_tup_lit whose head is a definer; name = 2nd child. (vendored ABI-14 wasm)
  janet: {
    grammar: 'janet',
    functionNodeTypes: ['par_tup_lit'],
    classNodeTypes: [],
    // par_tup_lit is a function only when its head is a definer (declFilter via the
    // fn-branch else-if); a non-definer `(helper x)` falls through as a call.
    callNodeTypes: ['par_tup_lit'],
    importNodeTypes: [],
    declFilter: (node: any) => lispIsDef(node, ['defn', 'defmacro', 'defn-']),
    resolveName: (node: any) => (node.namedChildCount >= 2 ? node.namedChild(1)?.text || '' : ''),
  },
  // Fennel: fn_form/lambda_form (name = 2nd child symbol); `list` = call; require → import. (vendored ABI-14 wasm)
  fennel: {
    grammar: 'fennel',
    functionNodeTypes: ['fn_form', 'lambda_form'],
    classNodeTypes: [],
    callNodeTypes: ['list'],
    importNodeTypes: [],
    importCallNames: ['require'],
    resolveName: (node: any) => (node.namedChildCount >= 2 ? node.namedChild(1)?.text || '' : ''),
  },
  // Nushell: decl_def → function (name = cmd_identifier); `command` = call; decl_use = import. (vendored ABI-14 wasm)
  nu: {
    grammar: 'nu',
    functionNodeTypes: ['decl_def'],
    classNodeTypes: [],
    callNodeTypes: ['command'],
    importNodeTypes: ['decl_use'],
    resolveName: (node: any) => firstDescByType(node, 'cmd_identifier'),
  },
  // Org-mode (markup): outline `headline`s → structural units (name = item text).
  // No function/call concept; embedded src blocks not parsed. (vendored ABI-14 wasm)
  org: {
    grammar: 'org',
    functionNodeTypes: [],
    classNodeTypes: ['headline'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => firstDescByType(node, 'item').replace(/\s+/g, ' ').trim(),
  },
  // Vimscript: function_definition (name = first identifier); call_expression = call. (vendored ABI-14 wasm)
  vim: {
    grammar: 'vim',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: [],
    callNodeTypes: ['call_expression'],
    importNodeTypes: [],
    resolveName: (node: any) => firstDescByType(node, 'identifier'),
  },
  // Apex (Salesforce, Java-shaped): method/constructor → functions; class/interface/enum
  // → classes; method_invocation = call. nameField:'name' (return type precedes name). (vendored ABI-14 wasm)
  apex: {
    grammar: 'apex',
    functionNodeTypes: ['method_declaration', 'constructor_declaration'],
    classNodeTypes: ['class_declaration', 'interface_declaration', 'enum_declaration'],
    callNodeTypes: ['method_invocation'],
    importNodeTypes: ['import_declaration'],
    nameField: 'name',
  },
  // Bicep (IaC): module/output declarations → structural units; resource_declaration →
  // class-like deployable unit; call_expression = call. (vendored wasm)
  bicep: {
    grammar: 'bicep',
    functionNodeTypes: ['module_declaration', 'output_declaration', 'user_defined_function'],
    classNodeTypes: ['resource_declaration'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: [],
  },
  // Puppet: function_declaration/defined_resource_type → functions; class_definition →
  // class; function_call = call; include_statement = import. (vendored wasm)
  puppet: {
    grammar: 'puppet',
    functionNodeTypes: ['function_declaration', 'defined_resource_type'],
    classNodeTypes: ['class_definition'],
    callNodeTypes: ['function_call'],
    importNodeTypes: ['include_statement'],
  },
  // Rego (OPA): `rule` → function (name = its head `var`); `ref` = call (refs over-count
  // pkg/import refs — store edge is asserted, not exclusive); `import`. (vendored ABI-14 wasm)
  rego: {
    grammar: 'rego',
    functionNodeTypes: ['rule'],
    classNodeTypes: [],
    callNodeTypes: ['ref'],
    importNodeTypes: ['import'],
    resolveName: (node: any) => firstDescByType(node.childForFieldName?.('head') || node, 'var'),
  },
  // Regex: named_capturing_group → named unit (group_name); anon/non-capturing groups
  // → structural units. No call/import. (vendored ABI-14 wasm)
  regex: {
    grammar: 'regex',
    functionNodeTypes: ['named_capturing_group'],
    classNodeTypes: ['anonymous_capturing_group', 'non_capturing_group'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (n: any) => firstDescByType(n, 'group_name') || '',
  },
  // Mermaid: flow vertices → named units; diagram_* roots → classes (labeled by kind).
  // Grammar is keyword-strict (`flowchart`, not `graph`). (vendored ABI-14 wasm)
  mermaid: {
    grammar: 'mermaid',
    functionNodeTypes: ['flow_vertex'],
    classNodeTypes: ['diagram_flow', 'diagram_sequence', 'diagram_class', 'diagram_state', 'diagram_er', 'diagram_pie', 'diagram_gantt', 'diagram_mindmap'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (n: any) =>
      n.type.startsWith('diagram_') ? n.type.replace('diagram_', '') : (firstDescByType(n, 'flow_vertex_id') || ''),
  },
  // YARA: rule_definition → class; string_definition → function ($a); import_statement. (vendored ABI-14 wasm)
  yara: {
    grammar: 'yara',
    functionNodeTypes: ['string_definition'],
    classNodeTypes: ['rule_definition'],
    callNodeTypes: [],
    importNodeTypes: ['import_statement'],
  },
  // JSON5: object → class; member keys (unquoted identifiers) → functions. (vendored ABI-14 wasm)
  json5: {
    grammar: 'json5',
    functionNodeTypes: ['member'],
    classNodeTypes: ['object'],
    callNodeTypes: [],
    importNodeTypes: [],
  },
  // RON: named `struct` → class (declFilter excludes anonymous tuple structs);
  // struct_entry/map_entry keys → functions. (vendored ABI-14 wasm)
  ron: {
    grammar: 'ron',
    functionNodeTypes: ['struct_entry', 'map_entry'],
    classNodeTypes: ['struct'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (n: any) => firstDescByType(n, 'struct_name'),
    declFilter: (n: any) => n.type !== 'struct' || !!firstDescByType(n, 'struct_name'),
  },
  // SystemVerilog (IEEE-1800, distinct from `verilog`): function/task → functions;
  // module/class/interface/package/program → classes. Calls in opaque statement bodies. (vendored ABI-14 wasm)
  systemverilog: {
    grammar: 'systemverilog',
    functionNodeTypes: ['function_declaration', 'task_declaration'],
    classNodeTypes: ['module_declaration', 'class_declaration', 'interface_declaration', 'package_declaration', 'program_declaration'],
    // `f(x)` is a tf_call; its first child (hierarchical_identifier) is the callee.
    callNodeTypes: ['tf_call'],
    importNodeTypes: ['package_import_declaration'],
    resolveName: (node: any) => firstDescByType(node, 'simple_identifier'),
  },
  // BibTeX: `entry` → class (citekey); `field` → function (field name). (vendored ABI-14 wasm)
  bibtex: {
    grammar: 'bibtex',
    functionNodeTypes: ['field'],
    classNodeTypes: ['entry'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) =>
      node.type === 'entry' ? firstDescByType(node, 'key_brace') : firstDescByType(node, 'identifier'),
  },
  // Twig (template): block/macro → functions; call_expression = call; include = import. (vendored wasm)
  twig: {
    grammar: 'twig',
    functionNodeTypes: ['block', 'macro'],
    classNodeTypes: [],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['include'],
    resolveName: (node: any) => firstDescByType(node, 'identifier'),
  },
  // Blade (Laravel template, thin — embedded PHP is opaque): section → class; directive → import. (vendored ABI-14 wasm)
  blade: {
    grammar: 'blade',
    functionNodeTypes: [],
    classNodeTypes: ['section'],
    callNodeTypes: [],
    importNodeTypes: ['directive'],
    resolveName: (node: any) => (firstDescByType(node, 'parameter') || '').replace(/^['"]|['"]$/g, ''),
  },
  // Liquid (template): assignment_statement → function; filter = call; render/include = import. (vendored ABI-14 wasm)
  liquid: {
    grammar: 'liquid',
    functionNodeTypes: ['assignment_statement'],
    classNodeTypes: [],
    callNodeTypes: ['filter'],
    importNodeTypes: ['render_statement', 'include_statement'],
    resolveName: (node: any) => firstDescByType(node, 'identifier'),
  },
  // YANG (network modeling): every construct is a generic `statement` keyed by a
  // statement_keyword (container/leaf/grouping/…), named by its argument's
  // node_identifier; only `module` is a distinct node. Capture all named statements
  // as structural units; value statements (type/config) have no node_identifier and
  // drop out. (vendored ABI-14 wasm)
  yang: {
    grammar: 'yang',
    functionNodeTypes: [],
    classNodeTypes: ['module', 'submodule', 'statement'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => node.type === 'statement'
      ? firstDescByType(node, 'node_identifier')
      : firstDescByType(node, 'identifier'),
    declFilter: (node: any) => node.type !== 'statement' || !!firstDescByType(node, 'node_identifier'),
  },
  // P4 (programmable switches): control/parser/struct/header → classes; action/table/
  // function → functions. Name = `name` node (else identifier). (vendored ABI-14 wasm)
  p4: {
    grammar: 'p4',
    functionNodeTypes: ['action_declaration', 'table_declaration', 'function_declaration'],
    classNodeTypes: ['control_declaration', 'parser_declaration', 'struct_declaration', 'header_type_declaration'],
    // `f(x);` is an assignment_or_method_call_statement; its first child (lvalue)
    // carries the callee name.
    callNodeTypes: ['assignment_or_method_call_statement'],
    importNodeTypes: ['preprocessor_include'],
    resolveName: (node: any) => firstDescByType(node, 'name') || firstDescByType(node, 'identifier'),
  },
  // Devicetree (DTS): each `node` → a tree node (name = identifier; root is `/`). (vendored ABI-14 wasm)
  devicetree: {
    grammar: 'devicetree',
    functionNodeTypes: [],
    classNodeTypes: ['node'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => firstDescByType(node, 'identifier'),
  },
  // Kconfig: config/menuconfig → functions (name = symbol); menu/choice → classes
  // (name = string_content). (vendored ABI-14 wasm)
  kconfig: {
    grammar: 'kconfig',
    functionNodeTypes: ['config', 'menuconfig'],
    classNodeTypes: ['menu', 'choice'],
    callNodeTypes: [],
    importNodeTypes: ['source'],
    resolveName: (node: any) =>
      (node.type === 'menu' || node.type === 'choice')
        ? firstDescByType(node, 'string_content')
        : firstDescByType(node, 'symbol'),
  },
  // MLIR: a func.func `operation` → a function (name = the @symbol). The dialect op
  // keyword lives at custom_operation → func_dialect → first child (`func.func`,
  // `func.call`, `return`). declFilter keeps only def ops (func.func) as functions —
  // otherwise a `func.call @helper` operation would also register as a function
  // named `helper` and corrupt enclosing-scope resolution. The call node is the
  // inner `custom_operation` (distinct from the outer `operation` decl type, so no
  // collision); resolveCallee returns the callee @symbol only for func.call/call
  // ops — NOT the first child (which is the op keyword). Grounded on the real AST. (vendored ABI-14 wasm)
  mlir: {
    grammar: 'mlir',
    functionNodeTypes: ['operation'],
    classNodeTypes: [],
    callNodeTypes: ['custom_operation'],
    importNodeTypes: [],
    declFilter: (node: any) => mlirOpKeyword(node) === 'func.func',
    resolveName: (node: any) => {
      const m = /@([A-Za-z_][\w.$]*)/.exec(node.text || '');
      return m ? m[1] : '';
    },
    resolveCallee: (node: any) => {
      const op = mlirOpKeyword(node);
      if (op !== 'func.call' && op !== 'call') return '';
      const m = /@([A-Za-z_][\w.$]*)/.exec(node.text || '');
      return m ? m[1] : '';
    },
  },
  // CodeQL: classless/member predicates + charpred → functions; dataclass/module →
  // classes; qualifiedRhs = predicate call; importDirective. (vendored ABI-14 wasm — the
  // on-disk npm copy was ABI 10, unusable.)
  ql: {
    grammar: 'ql',
    functionNodeTypes: ['classlessPredicate', 'memberPredicate', 'charpred'],
    classNodeTypes: ['dataclass', 'module'],
    // qualifiedRhs = `recv.pred(..)`; call_or_unqual_agg_expr = unqualified
    // `pred(..)`, whose first child (aritylessPredicateExpr) carries the callee.
    callNodeTypes: ['qualifiedRhs', 'call_or_unqual_agg_expr'],
    importNodeTypes: ['importDirective'],
    resolveName: (n: any) => {
      const want = n.type === 'dataclass' || n.type === 'charpred' ? 'className' : 'predicateName';
      for (let i = 0; i < n.namedChildCount; i++) {
        const c = n.namedChild(i);
        if (c?.type === want) return c.text;
      }
      return firstDescByType(n, want) || firstDescByType(n, 'predicateName') || firstDescByType(n, 'className');
    },
  },
  // TLA+: operator_definition → function; module → class; extends = import. (on-disk wasm)
  tlaplus: {
    grammar: 'tlaplus',
    functionNodeTypes: ['operator_definition'],
    classNodeTypes: ['module'],
    // An application `f(x)` is a bound_op whose first child is the operator ref.
    callNodeTypes: ['bound_op'],
    importNodeTypes: ['extends'],
    resolveName: (n: any) => firstDescByType(n, 'identifier'),
  },
  // SystemRDL: component_named_def (addrmap/reg/…) → classes; component_inst → functions
  // (the register/field instances). (on-disk wasm)
  systemrdl: {
    grammar: 'systemrdl',
    functionNodeTypes: ['component_inst'],
    classNodeTypes: ['component_named_def'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (n: any) => firstDescByType(n, 'id'),
  },
  // Beancount (accounting): transaction → function (payee/narration); open → class
  // (account decl). (vendored ABI-14 wasm)
  beancount: {
    grammar: 'beancount',
    functionNodeTypes: ['transaction'],
    classNodeTypes: ['open'],
    callNodeTypes: [],
    importNodeTypes: ['include'],
    resolveName: (n: any) =>
      n.type === 'transaction'
        ? (firstDescByType(n, 'payee') || firstDescByType(n, 'narration')).replace(/^"|"$/g, '')
        : firstDescByType(n, 'account'),
  },
  // Ledger (accounting): plain_xact → function (payee); account_directive → class. (vendored ABI-14 wasm)
  ledger: {
    grammar: 'ledger',
    functionNodeTypes: ['plain_xact'],
    classNodeTypes: ['account_directive'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (n: any) =>
      n.type === 'plain_xact' ? firstDescByType(n, 'payee') : firstDescByType(n, 'account'),
  },
  // Move (Aptos/Sui): function_definition → functions; module/struct → classes;
  // call_expression = call; use_declaration = import. (vendored ABI-14 wasm)
  move: {
    grammar: 'move',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: ['module_definition', 'struct_definition'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['use_declaration'],
    resolveName: (node: any) => node.type === 'function_definition'
      ? firstDescByType(node, 'function_identifier')
      : node.type === 'struct_definition'
        ? firstDescByType(node, 'struct_identifier')
        : firstDescByType(node, 'module_identifier'),
  },
  // Cairo (StarkNet): function_item → functions; mod/struct → classes; call_expression;
  // use_declaration = import. (vendored ABI-14 wasm)
  cairo: {
    grammar: 'cairo',
    functionNodeTypes: ['function_item'],
    classNodeTypes: ['mod_item', 'struct_item'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['use_declaration'],
    resolveName: (node: any) => node.type === 'struct_item'
      ? firstDescByType(node, 'type_identifier')
      : firstDescByType(node, 'identifier'),
  },
  // Sway (Fuel): function_item → functions; abi/struct → classes; call_expression;
  // use_declaration = import. (vendored ABI-14 wasm)
  sway: {
    grammar: 'sway',
    functionNodeTypes: ['function_item'],
    classNodeTypes: ['abi_item', 'struct_item'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['use_declaration'],
    resolveName: (node: any) => node.type === 'function_item'
      ? firstDescByType(node, 'identifier')
      : firstDescByType(node, 'type_identifier'),
  },
  // Noir (ZK): function_definition → functions; struct_definition → class;
  // function_call = call; import. (vendored ABI-14 wasm)
  noir: {
    grammar: 'noir',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: ['struct_definition'],
    callNodeTypes: ['function_call'],
    importNodeTypes: ['import'],
    resolveName: (node: any) => firstDescByType(node, 'identifier'),
  },
  // Clarity (Stacks): function_definition → functions; map/trait → classes;
  // contract_function_call = call; trait_usage/impl = import. (vendored ABI-14 wasm)
  clarity: {
    grammar: 'clarity',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: ['mapping_definition', 'trait_definition'],
    callNodeTypes: ['contract_function_call'],
    importNodeTypes: ['trait_usage', 'trait_implementation'],
    resolveName: (node: any) => firstDescByType(node, 'identifier'),
  },
  // SourcePawn (SourceMod): function_definition → functions; enum_struct → class;
  // call_expression = call; preproc_include = import. methodmap EXCLUDED (the prebuilt
  // wasm's external scanner crashes on it). (vendored npm ABI-14 wasm)
  sourcepawn: {
    grammar: 'sourcepawn',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: ['enum_struct'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['preproc_include', 'preproc_tryinclude'],
    resolveName: (node: any) => firstDescByType(node, 'identifier'),
  },
  // Robot Framework: keyword/test_case definitions → functions (name field);
  // keyword_invocation = call; setting_statement (Library/Resource) = import. (vendored npm wasm)
  robot: {
    grammar: 'robot',
    functionNodeTypes: ['keyword_definition', 'test_case_definition'],
    classNodeTypes: [],
    callNodeTypes: ['keyword_invocation'],
    importNodeTypes: ['setting_statement'],
    nameField: 'name',
  },
  // Smali (Android dalvik): method_definition → function (method_identifier);
  // class_definition → class (class_identifier, e.g. Lcom/example/Foo;). Calls deferred
  // (invoke targets are class-qualified). (vendored ABI-14 wasm)
  smali: {
    grammar: 'smali',
    functionNodeTypes: ['method_definition'],
    classNodeTypes: ['class_definition'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) =>
      node.type === 'method_definition'
        ? firstDescByType(node, 'method_identifier')
        : firstDescByType(node, 'class_identifier'),
  },
  // Squirrel: function_declaration → functions; class_declaration/enum_statement → classes;
  // call_expression = call. (vendored ABI-14 wasm)
  squirrel: {
    grammar: 'squirrel',
    functionNodeTypes: ['function_declaration'],
    classNodeTypes: ['class_declaration', 'enum_statement'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: [],
  },
  // Turtle (RDF triples): each `triple` → a structural unit named by its subject;
  // `directive` (@prefix/@base) → import. No function/class/call concept. (vendored ABI-14 wasm)
  turtle: {
    grammar: 'turtle',
    functionNodeTypes: ['triple'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: ['directive'],
    resolveName: (node: any) => firstDescByType(node, 'subject'),
  },
  // FunC (TON): function_definition → functions; global_var_declarations → class;
  // function_application = call; include_directive = import. (vendored ABI-14 wasm)
  func: {
    grammar: 'func',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: ['global_var_declarations'],
    callNodeTypes: ['function_application'],
    importNodeTypes: ['include_directive'],
    nameField: 'name',
  },
  // Tact (TON): global/storage functions → functions; contract/struct/message/trait →
  // classes; static/method calls = call; import. (vendored ABI-14 wasm)
  tact: {
    grammar: 'tact',
    functionNodeTypes: ['global_function', 'storage_function'],
    classNodeTypes: ['contract', 'struct', 'message', 'trait'],
    callNodeTypes: ['static_call_expression', 'method_call_expression'],
    importNodeTypes: ['import'],
    nameField: 'name',
  },
  // Wing: method_definition → functions; class/struct/interface/enum → classes;
  // call = call; import_statement. (vendored ABI-14 wasm)
  wing: {
    grammar: 'wing',
    functionNodeTypes: ['method_definition'],
    classNodeTypes: ['class_definition', 'struct_definition', 'interface_definition', 'enum_definition'],
    callNodeTypes: ['call'],
    importNodeTypes: ['import_statement'],
    nameField: 'name',
  },
  // Cooklang (recipe DSL): step → functions; recipe → class (title); ingredient/cookware/
  // timer = call-like deps; metadata = import. (vendored ABI-14 wasm)
  cooklang: {
    grammar: 'cooklang',
    functionNodeTypes: ['step'],
    classNodeTypes: ['recipe'],
    callNodeTypes: ['ingredient', 'cookware', 'timer'],
    importNodeTypes: ['metadata'],
    resolveName: (node: any) => {
      if (node.type === 'recipe') {
        const metadata = firstDescByType(node, 'metadata');
        const match = metadata.match(/^>>\s*title:\s*(.+)$/);
        return match?.[1]?.trim() || 'recipe';
      }
      return firstDescByType(node, 'name');
    },
  },
  // Hurl (HTTP test DSL): each request `entry` → function (named by URL tail); capture =
  // call-like dep. No class concept. (vendored ABI-14 wasm)
  hurl: {
    grammar: 'hurl',
    functionNodeTypes: ['entry'],
    classNodeTypes: [],
    callNodeTypes: ['capture'],
    importNodeTypes: ['variable_definition'],
    resolveName: (node: any) => {
      if (node.type === 'entry') {
        const url = firstDescByType(node, 'value_string').trim();
        const last = url.split(/[/?#]/).filter(Boolean).pop();
        return last || firstDescByType(node, 'method') || 'entry';
      }
      return firstDescByType(node, 'key_string');
    },
  },
  // Java .properties: each `property` key=value → a named entry. (vendored ABI-14 wasm)
  properties: {
    grammar: 'properties',
    functionNodeTypes: ['property'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: [],
    nameField: 'key',
  },
  // Glimmer (.hbs): {{#each}}/{{#if}} block_statement → functions (block name);
  // element_node (components/tags) → classes; helper_invocation = call. (vendored ABI-14 wasm)
  glimmer: {
    grammar: 'glimmer',
    functionNodeTypes: ['block_statement'],
    classNodeTypes: ['element_node'],
    callNodeTypes: ['helper_invocation'],
    importNodeTypes: [],
    resolveName: (node: any) => node.namedChild?.(0)?.namedChild?.(0)?.text || '',
  },
  // todo.txt: each task/done_task line → a unit (its text); +project tags → classes.
  // contexts are leaf tokens (no callee child) so calls stay empty. (vendored ABI-14 wasm)
  todotxt: {
    grammar: 'todotxt',
    functionNodeTypes: ['task', 'done_task'],
    classNodeTypes: ['project'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => node.text.replace(/\s+/g, ' ').trim().slice(0, 80),
  },
  // Meson (build DSL): every normal_command (project/executable/library/…) = a call;
  // subdir() = import. No function-decl concept. (vendored ABI-14 wasm)
  meson: {
    grammar: 'meson',
    functionNodeTypes: [],
    classNodeTypes: [],
    callNodeTypes: ['normal_command'],
    importNodeTypes: [],
    importCallNames: ['subdir'],
  },
  // ssh_config: each `host_declaration` Host block → a named unit (pattern). (vendored ABI-14 wasm)
  sshconfig: {
    grammar: 'sshconfig',
    functionNodeTypes: ['host_declaration'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: [],
    nameField: 'pattern',
  },
  // PromQL (expression lang, no defs): every function_call → a call (metric/fn invocation). (vendored ABI-14 wasm)
  promql: {
    grammar: 'promql',
    functionNodeTypes: [],
    classNodeTypes: [],
    callNodeTypes: ['function_call'],
    importNodeTypes: [],
  },
  // SPARQL (query lang, no named fns/classes): prefix_declaration → imports (which
  // vocabularies a query pulls in — the honest high-signal unit). (vendored ABI-14 wasm)
  sparql: {
    grammar: 'sparql',
    functionNodeTypes: [],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: ['prefix_declaration'],
  },
  // SuperCollider: class_def → class (name child type `class`); method-name leaves →
  // functions; function_call = call. (vendored ABI-14 wasm)
  supercollider: {
    grammar: 'supercollider',
    functionNodeTypes: ['class_method_name', 'instance_method_name'],
    classNodeTypes: ['class_def'],
    callNodeTypes: ['function_call'],
    importNodeTypes: [],
    resolveName: (node: any) => {
      if (node.type === 'class_def') return firstDescByType(node, 'class');
      if (node.type === 'class_method_name' || node.type === 'instance_method_name') return node.text || '';
      return '';
    },
  },
  // templ (Go superset): component/function/method declarations → functions; type → class;
  // call_expression; import_declaration. (vendored ABI-14 wasm, rebuilt)
  templ: {
    grammar: 'templ',
    functionNodeTypes: ['component_declaration', 'function_declaration', 'method_declaration'],
    classNodeTypes: ['type_declaration'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['import_declaration'],
    nameField: 'name',
  },
  // GN (Chromium build): target declarations (executable/library/template/…) are all
  // call_expression → calls; import_statement = import. (vendored ABI-14 wasm)
  gn: {
    grammar: 'gn',
    functionNodeTypes: [],
    classNodeTypes: [],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['import_statement'],
  },
  // gettext .po: each `message` → a unit named by its msgid. declFilter drops the
  // header (empty msgid) — the walker's name fallback would otherwise rescue it as
  // literal `msgid ""`. (vendored ABI-14 wasm)
  po: {
    grammar: 'po',
    functionNodeTypes: [],
    classNodeTypes: ['message'],
    callNodeTypes: [],
    importNodeTypes: [],
    declFilter: (node: any) => {
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (c.type === 'msgid') return !!firstDescByType(c, 'string_fragment');
      }
      return false;
    },
    resolveName: (node: any) => {
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (c.type === 'msgid') return firstDescByType(c, 'string_fragment');
      }
      return '';
    },
  },
  // rasi (rofi theme): each `rule_set` → a unit named by its selectors. (vendored ABI-14 wasm)
  rasi: {
    grammar: 'rasi',
    functionNodeTypes: [],
    classNodeTypes: ['rule_set'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => firstDescByType(node, 'selectors'),
  },
  // yuck (eww, homoiconic): a `list` whose head is a definer (defwidget/defwindow/…) →
  // a unit named by its 2nd symbol. (vendored ABI-14 wasm)
  yuck: {
    grammar: 'yuck',
    functionNodeTypes: [],
    classNodeTypes: ['list'],
    callNodeTypes: [],
    importNodeTypes: [],
    declFilter: (node: any) => {
      const head = node.namedChildCount > 0 ? node.namedChild(0) : null;
      return !!head && head.type === 'symbol' &&
        ['defwidget', 'defwindow', 'defvar', 'defpoll', 'deflisten', 'include'].includes(head.text);
    },
    resolveName: (node: any) => node.namedChild(1)?.text || '',
  },
  // TableGen (LLVM): class/def/multiclass records → units (first named child name). (vendored ABI-14 wasm)
  tablegen: {
    grammar: 'tablegen',
    functionNodeTypes: [],
    classNodeTypes: ['class', 'def', 'multiclass'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => node.namedChild(0)?.text || '',
  },
  // Ungrammar: each `node` → a rule definition (definition child = name). (vendored ABI-14 wasm)
  ungrammar: {
    grammar: 'ungrammar',
    functionNodeTypes: [],
    classNodeTypes: ['node'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => node.namedChild(0)?.text || '',
  },
  // Circom (ZK circuits): template_definition → class; function_definition → function;
  // call_expression = call. (vendored ABI-14 wasm)
  circom: {
    grammar: 'circom',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: ['template_definition'],
    callNodeTypes: ['call_expression', 'call'],
    importNodeTypes: ['include_statement'],
    resolveName: (node: any) => firstDescByType(node, 'identifier').trim(),
  },
  // OpenCL (C-based): function_definition (incl. __kernel) → functions; struct → class;
  // call_expression = call; preproc_include = import. (vendored ABI-14 wasm)
  opencl: {
    grammar: 'opencl',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: ['struct_specifier', 'class_specifier'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['preproc_include'],
  },
  // CPON (ChainPack object notation): each `pair` key → a config entry. (vendored ABI-14 wasm)
  cpon: {
    grammar: 'cpon',
    functionNodeTypes: ['pair'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => {
      const s = node.namedChild?.(0);
      return s?.type === 'string' ? s.text.replace(/^"|"$/g, '') : '';
    },
  },
  // Godot resource (.tres/.tscn): each `section` → a unit (gd_resource/ext_resource/…);
  // each `attribute` key → a property. (vendored ABI-14 wasm)
  'gdscript-resource': {
    grammar: 'gdscript-resource',
    functionNodeTypes: ['attribute'],
    classNodeTypes: ['section'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => firstDescByType(node, 'identifier'),
  },
  // NASM/x86 asm: each `label` (foo:) → a unit (name = ident). No class. The call
  // node is `instruction`, whose first child is the `word` mnemonic and whose
  // callee (for `call foo`) is the `ident` operand — NOT the first child. The
  // resolveCallee hook returns the operand only for a `call`/`jmp`-family mnemonic;
  // every other instruction (mov/ret/…) yields '' and is skipped. Grounded on the
  // real AST. (vendored ABI-14 wasm)
  nasm: {
    grammar: 'nasm',
    functionNodeTypes: ['label'],
    classNodeTypes: [],
    callNodeTypes: ['instruction'],
    importNodeTypes: [],
    resolveName: (node: any) => firstDescByType(node, 'ident'),
    resolveCallee: (node: any) => {
      const mnemonic = (firstDescByType(node, 'word') || '').toLowerCase();
      if (!/^(call|jmp|je|jne|jz|jnz|jg|jl|jge|jle|loop)$/.test(mnemonic)) return '';
      return firstDescByType(node, 'ident');
    },
  },
  // WAT (WebAssembly text): module_field_func → functions ($add, with the `$`
  // sigil); module → class (declFilter keeps only the named module node);
  // module_field_import = import. The call node is `instr_plain` (`call $foo`):
  // its first child is the `op_index` mnemonic and its callee is the `index` →
  // `identifier` operand — NOT the first child. resolveCallee returns the operand
  // only when the op is `call`/`call_indirect` (other instr_plain ops — local.get,
  // i32.const — yield ''). Grounded on the real AST. (vendored ABI-14 wasm)
  wat: {
    grammar: 'wat',
    functionNodeTypes: ['module_field_func'],
    classNodeTypes: ['module'],
    callNodeTypes: ['instr_plain'],
    importNodeTypes: ['module_field_import'],
    declFilter: (node: any) => node.type !== 'module' || node.namedChildCount > 0,
    resolveName: (node: any) =>
      node.type === 'module' ? 'module' : firstDescByType(node, 'identifier'),
    resolveCallee: (node: any) => {
      const op = (firstDescByType(node, 'op_index') || '').trim();
      if (op !== 'call' && op !== 'call_indirect') return '';
      return firstDescByType(node, 'identifier');
    },
  },
  // FIDL (Fuchsia IDL, modern syntax): layout/protocol declarations → classes;
  // protocol_method + const_declaration → functions; `using` = import. (vendored ABI-14 wasm)
  fidl: {
    grammar: 'fidl',
    functionNodeTypes: ['protocol_method', 'const_declaration'],
    classNodeTypes: ['layout_declaration', 'protocol_declaration'],
    callNodeTypes: [],
    importNodeTypes: ['using'],
    resolveName: (node: any) => firstDescByType(node, 'identifier'),
  },
  // HTTP request files (.http/.rest): each `request` → a unit named "<METHOD> <URL>". (vendored ABI-14 wasm)
  http: {
    grammar: 'http',
    functionNodeTypes: ['request'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => {
      const m = firstDescByType(node, 'method');
      const u = firstDescByType(node, 'target_url');
      return [m, u].filter(Boolean).join(' ');
    },
  },
  // LLVM IR: fn_define/declare → functions (@add); global_type → struct class
  // (%struct.Point); global_global → global. Functions are named with the `@`
  // sigil (resolveName → global_var = `@add`), so the callee keeps it too for
  // edge consistency. The call node is `instruction_call` (`call <ty> @foo(..)`),
  // whose callee is the `global_var` under its `value` operand (NOT the first
  // child, which is the `call` keyword/type) — grounded on the real AST. (vendored ABI-14 wasm)
  llvm: {
    grammar: 'llvm',
    functionNodeTypes: ['fn_define', 'declare'],
    classNodeTypes: ['global_type', 'global_global'],
    callNodeTypes: ['instruction_call'],
    importNodeTypes: [],
    resolveName: (node: any) =>
      node.type === 'global_type'
        ? firstDescByType(node, 'local_var')
        : firstDescByType(node, 'global_var'),
    // callee = the @global operand of the call (matches the @-sigil fn names).
    resolveCallee: (node: any) => firstDescByType(node, 'global_var'),
  },
  // gitcommit: subject line + trailers (Co-authored-by/Signed-off-by) → fn units;
  // `# modified:` changed-file mentions → imports. (vendored ABI-14 wasm)
  gitcommit: {
    grammar: 'gitcommit',
    functionNodeTypes: ['subject', 'trailer'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: ['comment'],
    resolveName: (node: any) =>
      node.type === 'trailer'
        ? (firstDescByType(node, 'token') || node.text)
        : node.text.trim(),
  },
  // git_rebase todo: each `operation` line (pick/reword/squash/exec) → one unit named
  // `command + label`. Upstream emits tree-sitter-git_rebase.wasm. (vendored ABI-14 wasm)
  git_rebase: {
    grammar: 'git_rebase',
    functionNodeTypes: ['operation'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => {
      const cmd = firstDescByType(node, 'command');
      const label = firstDescByType(node, 'label');
      return [cmd, label].filter(Boolean).join(' ') || node.text.trim();
    },
  },
  // gitattributes: each `pattern` rule → a class named by the glob (`*.txt`, `docs/**`).
  // (vendored ABI-14 wasm)
  gitattributes: {
    grammar: 'gitattributes',
    functionNodeTypes: [],
    classNodeTypes: ['pattern'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => node.text.trim(),
  },
  // unified diff: each file `block` → class named by the target path (b/src/auth.ts);
  // each `hunk` → fn named by its @@…@@ location line. (vendored ABI-14 wasm)
  diff: {
    grammar: 'diff',
    functionNodeTypes: ['hunk'],
    classNodeTypes: ['block'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => {
      if (node.type === 'block') {
        for (let i = 0; i < node.namedChildCount; i++) {
          const c = node.namedChild(i);
          if (c.type === 'new_file') return firstDescByType(c, 'filename') || c.text;
        }
        for (let i = 0; i < node.namedChildCount; i++) {
          const c = node.namedChild(i);
          if (c.type === 'old_file') return firstDescByType(c, 'filename') || c.text;
        }
        return firstDescByType(node, 'filename') || (node.namedChild?.(0)?.text || '').trim();
      }
      return firstDescByType(node, 'location').trim();
    },
  },
  // jsonc (JSON + comments): the official tree-sitter-json grammar tolerates // and
  // /* */; object `pair` keys → structural entries. Distinct wasm from `json`. (vendored ABI-14)
  jsonc: {
    grammar: 'jsonc',
    functionNodeTypes: ['pair'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => {
      const k = node.namedChild?.(0);
      if (k?.type !== 'string') return '';
      const sc = k.namedChild?.(0);
      return sc?.type === 'string_content' ? sc.text : '';
    },
  },
  // tree-sitter-comment: each recognized tag (TODO/FIXME/NOTE/HACK/XXX/WARNING/…) is a
  // `tag` node carrying a `name` leaf — the high-signal unit. (vendored ABI-14 wasm)
  comment: {
    grammar: 'comment',
    functionNodeTypes: ['tag'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => firstDescByType(node, 'name'),
  },
  // tree-sitter-query (.scm): capture (@name) → fn unit; named_node (matched type) →
  // class; predicate (#match? etc.) → call. (vendored ABI-14 wasm)
  query: {
    grammar: 'query',
    functionNodeTypes: ['capture'],
    classNodeTypes: ['named_node'],
    callNodeTypes: ['predicate'],
    importNodeTypes: [],
    resolveName: (node: any) => firstDescByType(node, 'identifier'),
  },
  // editorconfig: each [section] → a glob scope (class-like). name = the header glob
  // (`*`, `*.{js,ts}`, `Makefile`). (vendored ABI-14 wasm)
  editorconfig: {
    grammar: 'editorconfig',
    functionNodeTypes: [],
    classNodeTypes: ['section'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => firstDescByType(node, 'glob'),
  },
  // requirements (pip): each `requirement` = one declared dependency. name = the
  // `package` leaf (Django, requests, flask), not the version-pinned text. (vendored ABI-14 wasm)
  requirements: {
    grammar: 'requirements',
    functionNodeTypes: ['requirement'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => firstDescByType(node, 'package'),
  },
  // csv: every cell is a `field`; restrict to the header (first) row via declFilter so
  // we extract column names, not all data. name = field text. (vendored ABI-14 wasm)
  csv: {
    grammar: 'csv',
    functionNodeTypes: ['field'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => node.text || '',
    declFilter: (node: any) => node.parent?.previousNamedSibling == null,
  },
  // go.mod: each require_spec/replace_spec → a declared dependency (name = module_path);
  // module_directive → the module itself (class). (vendored ABI-14 wasm)
  gomod: {
    grammar: 'gomod',
    functionNodeTypes: ['require_spec', 'replace_spec'],
    classNodeTypes: ['module_directive'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => firstDescByType(node, 'module_path'),
  },
  // go.sum: each `checksum` line → a pinned module hash entry (name = module_path).
  // (two per module: the zip + the /go.mod hash.) (vendored ABI-14 wasm)
  gosum: {
    grammar: 'gosum',
    functionNodeTypes: ['checksum'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => firstDescByType(node, 'module_path'),
  },
  // go.work: each `use_spec` → a workspace member module path (name = file_path).
  // (vendored ABI-14 wasm)
  gowork: {
    grammar: 'gowork',
    functionNodeTypes: ['use_spec'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => firstDescByType(node, 'file_path'),
  },
  // Luau (Roblox Lua): fn_stmt/local_fn_stmt → functions (dotted name via name + key
  // chain); type_stmt → class; call_stmt → call. (vendored ABI-14 wasm)
  luau: {
    grammar: 'luau',
    functionNodeTypes: ['fn_stmt', 'local_fn_stmt'],
    classNodeTypes: ['type_stmt'],
    callNodeTypes: ['call_stmt'],
    importNodeTypes: [],
    resolveName: (node: any) => {
      if (node.type === 'type_stmt') return firstDescByType(node, 'name');
      const parts: string[] = [];
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (c.type === 'name') parts.push(c.text);
        else if (c.type === 'key') parts.push(firstDescByType(c, 'name'));
        else break;
      }
      return parts.filter(Boolean).join('.');
    },
  },
  // Godot shader (.gdshader): function_declaration → functions (name = ident, after the
  // builtin return type); struct_declaration → class; call_expr → call. (vendored ABI-14 wasm)
  gdshader: {
    grammar: 'gdshader',
    functionNodeTypes: ['function_declaration'],
    classNodeTypes: ['struct_declaration'],
    callNodeTypes: ['call_expr'],
    importNodeTypes: [],
    resolveName: (node: any) => firstDescByType(node, 'ident'),
  },
  // MAINSTREAM grammars (deep analyzers exist, but the breadth walker also covers
  // them so any agent/bench can pull structure from one path). Node types dumped
  // from the real tree-sitter-wasms grammars and verified by extraction. These
  // give the camp-a-langs head-to-head a uniform extractStructure entry for the
  // most-popular languages, alongside the niche grammars below.
  javascript: {
    grammar: 'javascript',
    functionNodeTypes: ['function_declaration', 'method_definition', 'generator_function_declaration'],
    classNodeTypes: ['class_declaration'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['import_statement'],
    nameField: 'name',
  },
  typescript: {
    grammar: 'typescript',
    functionNodeTypes: ['function_declaration', 'method_definition', 'generator_function_declaration'],
    classNodeTypes: ['class_declaration', 'interface_declaration', 'enum_declaration'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['import_statement'],
    nameField: 'name',
  },
  tsx: {
    grammar: 'tsx',
    functionNodeTypes: ['function_declaration', 'method_definition', 'generator_function_declaration'],
    classNodeTypes: ['class_declaration', 'interface_declaration', 'enum_declaration'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['import_statement'],
    nameField: 'name',
  },
  python: {
    grammar: 'python',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: ['class_definition'],
    callNodeTypes: ['call'],
    importNodeTypes: ['import_statement', 'import_from_statement'],
    nameField: 'name',
  },
  java: {
    grammar: 'java',
    functionNodeTypes: ['method_declaration', 'constructor_declaration'],
    classNodeTypes: ['class_declaration', 'interface_declaration', 'enum_declaration', 'record_declaration'],
    callNodeTypes: ['method_invocation'],
    importNodeTypes: ['import_declaration'],
    nameField: 'name',
  },
  go: {
    grammar: 'go',
    functionNodeTypes: ['function_declaration', 'method_declaration'],
    classNodeTypes: ['type_declaration'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['import_declaration'],
    nameField: 'name',
  },
  rust: {
    grammar: 'rust',
    functionNodeTypes: ['function_item'],
    classNodeTypes: ['struct_item', 'trait_item', 'enum_item'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['use_declaration'],
    nameField: 'name',
  },
  ruby: {
    grammar: 'ruby',
    functionNodeTypes: ['method', 'singleton_method'],
    classNodeTypes: ['class', 'module'],
    callNodeTypes: ['call'],
    importNodeTypes: [],
    nameField: 'name',
  },
  php: {
    grammar: 'php',
    functionNodeTypes: ['function_definition', 'method_declaration'],
    classNodeTypes: ['class_declaration', 'interface_declaration', 'trait_declaration'],
    callNodeTypes: ['function_call_expression', 'member_call_expression', 'scoped_call_expression'],
    importNodeTypes: ['namespace_use_declaration'],
    nameField: 'name',
  },
  c: {
    grammar: 'c',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: ['struct_specifier', 'union_specifier', 'enum_specifier'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['preproc_include'],
    // The function name is the identifier inside the (possibly pointer/array)
    // declarator subtree.
    resolveName: (node: any) => {
      const d = node.childForFieldName?.('declarator');
      const find = (x: any): string => {
        if (!x) return '';
        if (x.type === 'identifier') return x.text;
        for (let i = 0; i < x.namedChildCount; i++) {
          const r = find(x.namedChild(i));
          if (r) return r;
        }
        return '';
      };
      return find(d);
    },
  },
  cpp: {
    grammar: 'cpp',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: ['struct_specifier', 'class_specifier', 'union_specifier', 'enum_specifier'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['preproc_include'],
    resolveName: (node: any) => {
      const d = node.childForFieldName?.('declarator');
      const find = (x: any): string => {
        if (!x) return '';
        if (x.type === 'identifier' || x.type === 'field_identifier') return x.text;
        if (x.type === 'qualified_identifier') return firstDescByType(x, 'identifier');
        for (let i = 0; i < x.namedChildCount; i++) {
          const r = find(x.namedChild(i));
          if (r) return r;
        }
        return '';
      };
      return find(d);
    },
  },
  c_sharp: {
    grammar: 'c_sharp',
    functionNodeTypes: ['method_declaration', 'constructor_declaration', 'local_function_statement'],
    classNodeTypes: ['class_declaration', 'interface_declaration', 'struct_declaration', 'record_declaration', 'enum_declaration'],
    callNodeTypes: ['invocation_expression'],
    importNodeTypes: ['using_directive'],
    nameField: 'name',
  },
  kotlin: {
    grammar: 'kotlin',
    functionNodeTypes: ['function_declaration'],
    classNodeTypes: ['class_declaration', 'object_declaration'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['import_header'],
    // function_declaration → first simple_identifier child is the name.
    resolveName: (node: any) => {
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (c.type === 'simple_identifier' || c.type === 'type_identifier') return c.text;
      }
      return '';
    },
  },
  swift: {
    grammar: 'swift',
    functionNodeTypes: ['function_declaration'],
    classNodeTypes: ['class_declaration', 'protocol_declaration'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['import_declaration'],
    resolveName: (node: any) => {
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (c.type === 'simple_identifier' || c.type === 'type_identifier') return c.text;
      }
      return '';
    },
  },
  solidity: {
    grammar: 'solidity',
    functionNodeTypes: ['function_definition', 'modifier_definition', 'constructor_definition'],
    classNodeTypes: ['contract_declaration', 'interface_declaration', 'library_declaration', 'struct_declaration'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['import_directive'],
    nameField: 'name',
  },
  // Elixir is homoiconic: defs/defmodules are `call` nodes whose head is the macro
  // (`def`/`defp`/`defmodule`). Treat a `call` as a function decl only when its head
  // is a definer, and read the defined name from the nested call/alias. Plain calls
  // (head not a definer) are captured as calls.
  elixir: {
    grammar: 'elixir',
    functionNodeTypes: ['call'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: [],
    declFilter: (node: any) => {
      const head = firstNamed(node);
      return /^(def|defp|defmodule|defmacro)$/.test(head?.text || '');
    },
    resolveName: (node: any) => {
      // (call (identifier "def") (arguments (call (identifier "save") ...)))
      // module name lives in an `alias` node.
      const args = node.namedChild?.(1);
      if (!args) return '';
      const inner = args.namedChild?.(0);
      if (!inner) return '';
      if (inner.type === 'alias') return inner.text;
      if (inner.type === 'call') return firstNamed(inner)?.text || '';
      if (/identifier/.test(inner.type)) return inner.text;
      return '';
    },
  },
  // NICHE GRAMMARS — need a per-language name-resolver, not a flat spec (the same
  // languages codebase-memory ships special resolvers for). NOT shipped until
  // grounded + a resolver handles their name shapes:
  //   - ocaml: value_definition CONTAINS let_binding (double-count); the name is a
  //     pattern child, not a `name` field.
  //   - elm: value_declaration name lives under a functionDeclarationLeft field.
  // Tracked on #87.
};

export function specFor(grammar: string): LanguageSpec | undefined {
  return LANGUAGE_SPECS[grammar];
}
