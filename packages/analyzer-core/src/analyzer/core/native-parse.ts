/**
 * Native tree-sitter parse stage — the breadth engine for grammars that have no
 * (ABI-compatible) wasm. A self-contained Rust binary (native/klauro-parse) owns
 * the grammars as cargo crates and emits a compact JSON AST (byte offsets, no
 * text). This module shells to it and wraps the JSON in a node adapter exposing
 * the same surface as web-tree-sitter, so the generic walker works unchanged.
 *
 * Decoupled from our Node runtime's tree-sitter version entirely: the binary is
 * its own world. This is how breadth reaches the long tail without wasm ABI pain.
 */
import { execFileSync } from 'child_process';
import * as path from 'path';

/** Languages compiled into the klauro-parse binary (extend as grammars are added). */
// Grammars compiled into klauro-parse AND grounded with a verified spec. Niche
// name shapes (Lisp homoiconic lists, verilog/cmake/groovy wrappers, R's `name <-
// function` assignment, VHDL process labels) are handled by per-grammar
// resolveName/declFilter hooks in language-spec.ts. Every grammar in the binary
// is now grounded.
const NATIVE_LANGS = new Set([
  'erlang', 'gleam', 'fortran', 'elm', 'ada',
  'objc', 'perl', 'odin', 'pascal', 'proto',
  'glsl', 'hlsl', 'powershell', 'd',
  'commonlisp', 'scheme', 'racket',
  'cmake', 'verilog', 'groovy', 'r', 'vhdl',
  'nix', 'jsonnet',
  'gdscript', 'starlark', 'slang',
  'ocaml', 'nickel',
  'lua', 'scala',
]);

function binaryPath(): string {
  return path.join(__dirname, '..', '..', '..', 'native', 'klauro-parse', 'target', 'release', 'klauro-parse');
}

let binaryOk: boolean | null = null;
function binaryAvailable(): boolean {
  if (binaryOk !== null) return binaryOk;
  try {
    require('fs').accessSync(binaryPath());
    binaryOk = true;
  } catch {
    binaryOk = false;
  }
  return binaryOk;
}

export function hasNativeGrammar(lang: string): boolean {
  return NATIVE_LANGS.has(lang) && binaryAvailable();
}

interface RawNode { t: string; s: number; e: number; sr: number; n: boolean; c: RawNode[] }

/** Adapter over the JSON AST exposing the web-tree-sitter node surface the
 *  generic walker relies on (type, text, startPosition, child/namedChild, …). */
export class NativeNode {
  constructor(private raw: RawNode, private src: string) {}
  get type(): string { return this.raw.t; }
  get text(): string { return this.src.slice(this.raw.s, this.raw.e); }
  get isNamed(): boolean { return this.raw.n; }
  get startPosition(): { row: number } { return { row: this.raw.sr }; }
  get childCount(): number { return this.raw.c.length; }
  child(i: number): NativeNode | null {
    return i >= 0 && i < this.raw.c.length ? new NativeNode(this.raw.c[i], this.src) : null;
  }
  get namedChildCount(): number { return this.raw.c.filter(c => c.n).length; }
  namedChild(i: number): NativeNode | null {
    const named = this.raw.c.filter(c => c.n);
    return i >= 0 && i < named.length ? new NativeNode(named[i], this.src) : null;
  }
  // The JSON AST carries no field info; returning null forces the walker's
  // first-identifier-descendant fallback (works across grammars).
  childForFieldName(_name: string): null { return null; }
}

/** Parse `source` of `lang` with the native binary; returns the root NativeNode
 *  or null if unavailable/failed. */
export function parseNativeRoot(lang: string, source: string): NativeNode | null {
  if (!hasNativeGrammar(lang)) return null;
  let out: string;
  try {
    out = execFileSync(binaryPath(), [lang], { input: source, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  } catch {
    return null;
  }
  let raw: RawNode;
  try {
    raw = JSON.parse(out);
  } catch {
    return null;
  }
  if ((raw as any).error) return null;
  return new NativeNode(raw, source);
}
