/**
 * WASM tree-sitter — AST parsing for the languages the native grammars don't
 * cover (c, cpp, swift, kotlin, solidity, elixir, …).
 *
 * The native node-tree-sitter path only has grammars pinned to the repo's
 * tree-sitter 0.25 (csharp/go/php/rust/ts). Adding c/cpp/etc natively is blocked
 * by a grammar-release-vs-runtime ABI lag (and node-gyp build friction). WASM
 * (web-tree-sitter + prebuilt tree-sitter-wasms grammars) sidesteps all of that:
 * no native ABI coupling, no node-gyp, works in CI on any Node. It gives true
 * ASTs — so call edges like `obj.method()` and bare same-scope calls resolve,
 * which the regex analyzers miss.
 *
 * Async by nature (WASM init + grammar load). Callers init() once, then parse/
 * query are cheap. Grammars are cached after first load.
 */

import { createRequire } from 'module';
import * as path from 'path';

const require_ = createRequire(__filename);
// web-tree-sitter@0.22 is CJS: the module export IS the Parser class.
const Parser: any = require_('web-tree-sitter');

let initPromise: Promise<void> | null = null;
const languages = new Map<string, any>();

/** tree-sitter-wasms ships grammar files as tree-sitter-<name>.wasm. Map our
 *  analyzer language ids to those file stems where they differ. */
const WASM_NAME: Record<string, string> = {
  'c-cpp': 'cpp',          // one analyzer, parse C++ superset (also handles C)
  'csharp': 'c_sharp',
  'c#': 'c_sharp',
  'typescript-javascript': 'typescript',
};

function wasmDir(): string {
  return path.join(path.dirname(require_.resolve('tree-sitter-wasms/package.json')), 'out');
}

/** Repo-tracked grammars vendored beyond what tree-sitter-wasms ships — the
 *  breadth path. Prebuilt `.wasm` from @tree-sitter-grammars/* (no emscripten
 *  build), checked BEFORE the npm dir so a vendored grammar wins. */
function vendoredDir(): string {
  return path.join(__dirname, '..', '..', '..', 'vendored-grammars');
}

/** Resolve the .wasm path for a grammar name: vendored first, then tree-sitter-wasms. */
function grammarFile(name: string): string | null {
  const fs = require_('fs');
  const vendored = path.join(vendoredDir(), `tree-sitter-${name}.wasm`);
  if (fs.existsSync(vendored)) return vendored;
  const shipped = path.join(wasmDir(), `tree-sitter-${name}.wasm`);
  if (fs.existsSync(shipped)) return shipped;
  return null;
}

/** Initialize the WASM runtime once. Safe to call repeatedly. */
export async function initWasm(): Promise<void> {
  if (!initPromise) initPromise = Parser.init();
  await initPromise;
}

/** True when a prebuilt grammar exists for this language id. */
export function hasWasmGrammar(lang: string): boolean {
  const name = WASM_NAME[lang] || lang;
  return grammarFile(name) !== null;
}

async function loadLanguage(lang: string): Promise<any> {
  const name = WASM_NAME[lang] || lang;
  if (languages.has(name)) return languages.get(name);
  await initWasm();
  const file = grammarFile(name);
  if (!file) throw new Error(`No tree-sitter grammar for "${lang}"`);
  const lib = await Parser.Language.load(file);
  languages.set(name, lib);
  return lib;
}

/** Parse source into a tree-sitter Tree. */
export async function parseWasm(lang: string, source: string): Promise<any> {
  const lib = await loadLanguage(lang);
  const parser = new Parser();
  parser.setLanguage(lib);
  return parser.parse(source);
}

export interface WasmCapture {
  name: string;     // capture name from the query (@name etc.)
  text: string;     // matched source text
  startLine: number;
  endLine: number;
  node: any;
}

/**
 * Run a tree-sitter query against source and return captures. Queries are the
 * clean, grammar-stable way to extract — e.g. function names, call targets,
 * class declarations — far more precise than regex.
 */
export async function queryWasm(lang: string, source: string, queryString: string): Promise<WasmCapture[]> {
  const lib = await loadLanguage(lang);
  const parser = new Parser();
  parser.setLanguage(lib);
  const tree = parser.parse(source);
  const query = lib.query(queryString);
  const captures = query.captures(tree.rootNode);
  return captures.map((c: any) => ({
    name: c.name,
    text: c.node.text,
    startLine: c.node.startPosition.row + 1,
    endLine: c.node.endPosition.row + 1,
    node: c.node,
  }));
}
