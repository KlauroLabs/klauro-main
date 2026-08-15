















import { createRequire } from 'module';
import * as path from 'path';
import { sanitizeForTreeSitterParse } from './tree-sitter-ts-extractor';

const require_ = createRequire(__filename);

const Parser: any = require_('web-tree-sitter');

let initPromise: Promise<void> | null = null;
const languages = new Map<string, any>();






const queries = new Map<string, any>();



const WASM_NAME: Record<string, string> = {
  'c-cpp': 'cpp',
  'csharp': 'c_sharp',
  'c#': 'c_sharp',
  'typescript-javascript': 'typescript',
};

const fs_ = require_('fs');











let grammarDirsCache: string[] | null = null;
function grammarDirs(): string[] {
  if (grammarDirsCache) return grammarDirsCache;
  const dirs: string[] = [];
  const add = (d: string | null | undefined) => {
    if (d && !dirs.includes(d) && fs_.existsSync(d)) dirs.push(d);
  };
  add(process.env.KLAURO_GRAMMARS_DIR);
  add(path.join(__dirname, 'grammars'));
  add(path.join(__dirname, 'vendored-grammars'));
  add(path.join(__dirname, '..', 'grammars'));
  add(path.join(__dirname, '..', '..', '..', 'vendored-grammars'));
  try {
    const pkg = require_.resolve('@klauro/analyzer-core/package.json');
    add(path.join(path.dirname(pkg), 'vendored-grammars'));
    add(path.join(path.dirname(pkg), 'dist', 'grammars'));
  } catch {   }
  try {
    add(path.join(path.dirname(require_.resolve('tree-sitter-wasms/package.json')), 'out'));
  } catch {   }
  grammarDirsCache = dirs;
  return dirs;
}


function grammarFile(name: string): string | null {
  for (const dir of grammarDirs()) {
    const f = path.join(dir, `tree-sitter-${name}.wasm`);
    if (fs_.existsSync(f)) return f;
  }
  return null;
}



export function grammarHealth(): { dirs: string[]; count: number; sample: string[] } {
  const seen = new Set<string>();
  for (const dir of grammarDirs()) {
    try {
      for (const f of fs_.readdirSync(dir)) {
        const m = /^tree-sitter-(.+)\.wasm$/.exec(f);
        if (m) seen.add(m[1]);
      }
    } catch {   }
  }
  return { dirs: grammarDirs(), count: seen.size, sample: [...seen].sort().slice(0, 12) };
}


export async function initWasm(): Promise<void> {
  if (!initPromise) initPromise = Parser.init();
  await initPromise;
}


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


export async function parseWasm(lang: string, source: string): Promise<any> {
  const lib = await loadLanguage(lang);
  const parser = new Parser();
  try {
    parser.setLanguage(lib);
    return parser.parse(sanitizeForTreeSitterParse(source));
  } finally {
    parser.delete?.();
  }
}

export interface WasmCapture {
  name: string;
  text: string;
  startLine: number;
  endLine: number;
}






export async function queryWasm(lang: string, source: string, queryString: string): Promise<WasmCapture[]> {
  const lib = await loadLanguage(lang);
  const parser = new Parser();
  let tree: any;
  try {
    parser.setLanguage(lib);
    tree = parser.parse(sanitizeForTreeSitterParse(source));
    const queryKey = `${lang}\0${queryString}`;
    let query = queries.get(queryKey);
    if (!query) {
      query = lib.query(queryString);
      queries.set(queryKey, query);
    }
    return query.captures(tree.rootNode).map((capture: any) => ({
      name: capture.name,
      text: capture.node.text,
      startLine: capture.node.startPosition.row + 1,
      endLine: capture.node.endPosition.row + 1,
    }));
  } finally {
    tree?.delete?.();
    parser.delete?.();
  }
}
