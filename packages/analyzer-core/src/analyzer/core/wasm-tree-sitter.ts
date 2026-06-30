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

const fs_ = require_('fs');

/**
 * All directories that may hold `tree-sitter-<name>.wasm` grammar files, in
 * priority order. This must work across the THREE layouts that all really happen
 * in production, not just the dev tree:
 *   - source / dev:   packages/analyzer-core/src/analyzer/core/   (__dirname up 3)
 *   - esbuild bundle: apps/mcp-server/dist/server.cjs            (grammars copied to dist/grammars)
 *   - installed dep:  node_modules/@klauro/analyzer-core/...     (grammars shipped in the package)
 * Plus an explicit `KLAURO_GRAMMARS_DIR` override and the `tree-sitter-wasms` npm
 * `out/` dir (the ~34 mainstream grammars). Resolved once + cached.
 */
let grammarDirsCache: string[] | null = null;
function grammarDirs(): string[] {
  if (grammarDirsCache) return grammarDirsCache;
  const dirs: string[] = [];
  const add = (d: string | null | undefined) => {
    if (d && !dirs.includes(d) && fs_.existsSync(d)) dirs.push(d);
  };
  add(process.env.KLAURO_GRAMMARS_DIR);                                  // 1. operator override
  add(path.join(__dirname, 'grammars'));                                 // 2. adjacent to bundle (build copies here)
  add(path.join(__dirname, 'vendored-grammars'));
  add(path.join(__dirname, '..', 'grammars'));
  add(path.join(__dirname, '..', '..', '..', 'vendored-grammars'));      //    source-tree layout
  try {                                                                  // 3. installed-as-a-dep layout
    const pkg = require_.resolve('@klauro/analyzer-core/package.json');
    add(path.join(path.dirname(pkg), 'vendored-grammars'));
    add(path.join(path.dirname(pkg), 'dist', 'grammars'));
  } catch { /* not a named dep — fine */ }
  try {                                                                  // 4. tree-sitter-wasms npm out/
    add(path.join(path.dirname(require_.resolve('tree-sitter-wasms/package.json')), 'out'));
  } catch { /* not installed — vendored dirs still cover breadth */ }
  grammarDirsCache = dirs;
  return dirs;
}

/** Resolve the .wasm path for a grammar name across every known layout. */
function grammarFile(name: string): string | null {
  for (const dir of grammarDirs()) {
    const f = path.join(dir, `tree-sitter-${name}.wasm`);
    if (fs_.existsSync(f)) return f;
  }
  return null;
}

/** Diagnostics: how many distinct grammars resolve, and from where. Used by the
 *  startup self-check + packaging test so a broken install fails loudly. */
export function grammarHealth(): { dirs: string[]; count: number; sample: string[] } {
  const seen = new Set<string>();
  for (const dir of grammarDirs()) {
    try {
      for (const f of fs_.readdirSync(dir)) {
        const m = /^tree-sitter-(.+)\.wasm$/.exec(f);
        if (m) seen.add(m[1]);
      }
    } catch { /* unreadable dir — skip */ }
  }
  return { dirs: grammarDirs(), count: seen.size, sample: [...seen].sort().slice(0, 12) };
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
