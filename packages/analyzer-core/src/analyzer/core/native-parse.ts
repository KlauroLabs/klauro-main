









import { execFileSync } from 'child_process';
import { accessSync, closeSync, constants, openSync, readSync } from 'fs';
import * as path from 'path';







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

export function hasCompatibleNativeParserBinary(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    const descriptor = openSync(filePath, 'r');
    try {
      const header = Buffer.alloc(32);
      let offset = 0;
      while (offset < header.length) {
        const bytes = readSync(descriptor, header, offset, header.length - offset, offset);
        if (!bytes) return false;
        offset += bytes;
      }
      return binaryMatchesRuntime(header);
    } finally {
      closeSync(descriptor);
    }
  } catch {
    return false;
  }
}

export function resolveNativeParserBinary(directory = __dirname): string | null {
  const candidates = [
    path.join(directory, 'native', 'klauro-parse'),
    path.join(directory, '..', '..', '..', 'native', 'klauro-parse', 'target', 'release', 'klauro-parse'),
  ];
  return candidates.find(hasCompatibleNativeParserBinary) || null;
}

let nativeBinary: string | null | undefined;
function binaryPath(): string | null {
  if (nativeBinary === undefined) nativeBinary = resolveNativeParserBinary();
  return nativeBinary;
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
  return NATIVE_LANGS.has(lang) && binaryPath() !== null;
}

interface RawNode { t: string; s: number; e: number; sr: number; n: boolean; c: RawNode[] }



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


  childForFieldName(_name: string): null { return null; }
}



export function parseNativeRoot(lang: string, source: string): NativeNode | null {
  const binary = NATIVE_LANGS.has(lang) ? binaryPath() : null;
  if (!binary) return null;
  let out: string;
  try {
    out = execFileSync(binary, [lang], { input: source, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
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
