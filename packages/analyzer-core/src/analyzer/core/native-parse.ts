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
import { accessSync, readFileSync } from 'fs';
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
    accessSync(binaryPath());
    binaryOk = binaryMatchesRuntime(readFileSync(binaryPath(), { encoding: null, flag: 'r' }).subarray(0, 32));
  } catch {
    binaryOk = false;
  }
  return binaryOk;
}

export function binaryMatchesRuntime(header: Uint8Array): boolean {
  if (process.platform === 'linux') {
    if (header[0] !== 0x7f || header[1] !== 0x45 || header[2] !== 0x4c || header[3] !== 0x46) return false;
    const littleEndian = header[5] === 1;
    const machine = littleEndian
      ? header[18] | (header[19] << 8)
      : (header[18] << 8) | header[19];
    return machine === ({ x64: 62, arm64: 183 } as Record<string, number>)[process.arch];
  }
  if (process.platform === 'darwin') {
    const magic = [header[0], header[1], header[2], header[3]].map(byte => byte?.toString(16).padStart(2, '0')).join('');
    if (!['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca'].includes(magic)) return false;
    if (magic === 'cafebabe' || magic === 'bebafeca') return true;
    const littleEndian = magic === 'cefaedfe' || magic === 'cffaedfe';
    const cpu = littleEndian
      ? header[4] | (header[5] << 8) | (header[6] << 16) | (header[7] << 24)
      : (header[4] << 24) | (header[5] << 16) | (header[6] << 8) | header[7];
    return (cpu >>> 0) === ({ x64: 0x01000007, arm64: 0x0100000c } as Record<string, number>)[process.arch];
  }
  if (process.platform === 'win32') return header[0] === 0x4d && header[1] === 0x5a;
  return false;
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
