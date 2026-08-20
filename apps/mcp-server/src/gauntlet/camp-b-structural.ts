















































import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

import {
  extractStructure,
  type StructuralExtract,
} from '../../../../packages/analyzer-core/src/analyzer/core/generic-tree-sitter-analyzer';
import { codebaseMemoryPath, runCodebaseMemoryJson, startCodebaseMemoryDaemon } from './real-camp-arms';
import { TOP_LANGS } from './camp-a-langs';



const CBM_LSP_LANGS = new Set([
  'python',
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'php',
  'c_sharp',
  'go',
  'c',
  'cpp',
  'java',
  'kotlin',
  'rust',
]);








const LANG_EXT: Record<string, string> = {
  ada: 'adb',
  apex: 'cls',
  awk: 'awk',
  ballerina: 'bal',
  c: 'c',
  c_sharp: 'cs',
  cairo: 'cairo',
  circom: 'circom',
  clarity: 'clar',
  cpp: 'cpp',
  crystal: 'cr',
  cuda: 'cu',
  d: 'd',
  dart: 'dart',
  elixir: 'ex',
  elm: 'elm',
  erlang: 'erl',
  fennel: 'fnl',
  fish: 'fish',
  fortran: 'f90',
  fsharp: 'fs',
  func: 'fc',
  gdscript: 'gd',
  gdshader: 'gdshader',
  gleam: 'gleam',
  glsl: 'glsl',
  go: 'go',
  grain: 'gr',
  gren: 'gren',
  groovy: 'groovy',
  hack: 'hack',
  hare: 'ha',
  haskell: 'hs',
  haxe: 'hx',
  hlsl: 'hlsl',
  java: 'java',
  javascript: 'js',
  jq: 'jq',
  jsx: 'jsx',
  kotlin: 'kt',
  luau: 'luau',
  move: 'move',
  nim: 'nim',
  noir: 'nr',
  nu: 'nu',
  ocaml: 'ml',
  odin: 'odin',
  opencl: 'cl',
  perl: 'pl',
  php: 'php',
  pony: 'pony',
  powershell: 'ps1',
  purescript: 'purs',
  python: 'py',
  r: 'r',
  reason: 're',
  rescript: 'res',
  ruby: 'rb',
  rust: 'rs',
  scala: 'scala',
  slang: 'slang',
  sml: 'sml',
  solidity: 'sol',
  sourcepawn: 'sp',
  squirrel: 'nut',
  starlark: 'star',
  sway: 'sw',
  swift: 'swift',
  tact: 'tact',
  tcl: 'tcl',
  templ: 'templ',
  tsx: 'tsx',
  typescript: 'ts',
  typst: 'typ',
  vala: 'vala',
  vim: 'vim',
  wgsl: 'wgsl',
  wing: 'w',
  wren: 'wren',
  zig: 'zig',
};

export type CampBVerdict = 'tie-ceiling' | 'win' | 'loss';

export interface CampBSide {
  functions: number;
  classes: number;
  calls: number;
  imports: number;
  tokens: number;
}

export interface CampBCbmSide {
  functions: number;
  classes: number;
  tokens: number;
  available: boolean;
}

export interface CampBStructuralRow {
  lang: string;
  klauro: CampBSide;
  cbm: CampBCbmSide;
  verdict: CampBVerdict;
  note: string;
}

export interface CampBStructuralReport {

  available: boolean;
  perLanguage: CampBStructuralRow[];
  aggregate: {
    languages: number;
    klauroWins: number;
    ceilingTies: number;
    losses: number;

    winRate: number;
    meanKlauroTokens: number;
    meanCbmTokens: number;

    tokenSavingMean: number;
  };
}


function tokensOf(s: string): number {
  return Math.round(Buffer.byteLength(s, 'utf8') / 4);
}





function cbmProjectId(dir: string): string {
  return dir.replace(/^\/+/, '').replace(/[^A-Za-z0-9_]+/g, '-');
}

interface CbmStructuralCounts {
  functions: number;
  classes: number;
  fnNames: Set<string>;
  classNames: Set<string>;
  schemaRaw: string;
  available: boolean;
}
















function cbmStructuralCorpus(bin: string, dir: string): Map<string, CbmStructuralCounts> {
  const project = cbmProjectId(dir);
  runCodebaseMemoryJson(bin, 'index_repository', ['--repo-path', dir, '--name', project]);
  const search: any = runCodebaseMemoryJson(bin, 'search_graph', [
    '--project', project,
    '--format', 'json',
    '--limit', '100000',
  ]);
  const columns: string[] = search.cols || [];
  const nameIndex = columns.indexOf('name');
  const labelIndex = columns.indexOf('label');
  if (nameIndex < 0 || labelIndex < 0) {
    throw new Error(`codebase-memory search_graph omitted required columns: ${columns.join(', ')}`);
  }
  const groupsByFile = new Map<string, any[]>();
  for (const group of search.groups || []) {
    const file = path.basename(String(group.file || ''));
    if (!file) continue;
    const groups = groupsByFile.get(file) || [];
    groups.push(group);
    groupsByFile.set(file, groups);
  }
  const byFile = new Map<string, CbmStructuralCounts>();
  for (const [file, groups] of groupsByFile) {
    const fnNames = new Set<string>();
    const classNames = new Set<string>();
    for (const group of groups) {
      for (const row of group.rows || []) {
        const name = String(row[nameIndex] || '');
        const label = String(row[labelIndex] || '');
        if (!name) continue;
        if (label === 'Function' || label === 'Method') fnNames.add(name);
        else if (label === 'Class' || label === 'Struct' || label === 'Interface') classNames.add(name);
      }
    }
    byFile.set(file, {
      functions: fnNames.size,
      classes: classNames.size,
      fnNames,
      classNames,
      schemaRaw: JSON.stringify({ cols: columns, groups }),
      available: fnNames.size + classNames.size > 0,
    });
  }
  return byFile;
}

interface PendingStructuralComparison {
  lang: string;
  fileName: string;
  klauroExtract: StructuralExtract;
  klauro: CampBSide;
}

function unavailableCbmStructuralCounts(): CbmStructuralCounts {
  return {
    functions: 0,
    classes: 0,
    fnNames: new Set(),
    classNames: new Set(),
    schemaRaw: '',
    available: false,
  };
}

interface SymbolNames {
  klauroFnNames: Set<string>;
  klauroClassNames: Set<string>;
  cbmFnNames: Set<string>;
  cbmClassNames: Set<string>;
}


function missing(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter(n => !b.has(n));
}

















function decideVerdict(
  lang: string,
  klauro: CampBSide,
  cbm: CampBCbmSide,
  names: SymbolNames,
): { verdict: CampBVerdict; note: string } {
  const kSym = klauro.functions + klauro.classes;
  const tokNote =
    klauro.tokens < cbm.tokens ? ` (Klauro ${cbm.tokens - klauro.tokens} fewer tokens)` : '';

  const cbmHasAnyName = names.cbmFnNames.size + names.cbmClassNames.size > 0;



  if (cbmHasAnyName) {
    const missFns = missing(names.cbmFnNames, names.klauroFnNames);
    const missCls = missing(names.cbmClassNames, names.klauroClassNames);
    if (missFns.length || missCls.length) {
      const parts = [
        missFns.length ? `functions [${missFns.join(', ')}]` : '',
        missCls.length ? `classes [${missCls.join(', ')}]` : '',
      ].filter(Boolean).join(' + ');
      return {
        verdict: 'loss',
        note: `codebase-memory extracted source symbols Klauro missed: ${parts} — DEEPEN the Klauro ${lang} analyzer`,
      };
    }
  }


  if (!cbm.available && kSym >= 1) {
    return {
      verdict: 'win',
      note: `out-of-coverage: codebase-memory indexed no symbols for ${lang}; Klauro fn=${klauro.functions} cls=${klauro.classes}${tokNote}`,
    };
  }




  if (cbmHasAnyName) {
    const kExtraFns = missing(names.klauroFnNames, names.cbmFnNames);
    const kExtraCls = missing(names.klauroClassNames, names.cbmClassNames);
    if (kExtraFns.length || kExtraCls.length) {
      return {
        verdict: 'win',
        note: `Klauro saw source symbols cbm missed (klauro-only fns [${kExtraFns.join(', ')}] cls [${kExtraCls.join(', ')}])${tokNote}`,
      };
    }
  }




  if (kSym >= 1) {
    const lsp = CBM_LSP_LANGS.has(lang) ? 'LSP-accurate ' : '';
    return {
      verdict: 'tie-ceiling',
      note: `${lsp}symbol-name parity (klauro fn=${klauro.functions} cls=${klauro.classes})${tokNote || ' (token-neutral)'}`,
    };
  }


  return {
    verdict: 'tie-ceiling',
    note: `neither tool extracted symbols for ${lang} (degenerate); recorded as no-loss tie`,
  };
}

let cached: CampBStructuralReport | null = null;








export async function buildCampBStructuralReport(): Promise<CampBStructuralReport> {
  if (cached) return cached;

  const bin = codebaseMemoryPath();
  if (!bin) {
    cached = {
      available: false,
      perLanguage: [],
      aggregate: {
        languages: 0,
        klauroWins: 0,
        ceilingTies: 0,
        losses: 0,
        winRate: 0,
        meanKlauroTokens: 0,
        meanCbmTokens: 0,
        tokenSavingMean: 0,
      },
    };
    return cached;
  }


  const samples = new Map<string, string>();
  for (const t of TOP_LANGS) {
    if (!samples.has(t.lang)) samples.set(t.lang, t.sample);
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-camp-b-'));
  const daemon = startCodebaseMemoryDaemon(bin);
  const rows: CampBStructuralRow[] = [];

  try {
    const pending: PendingStructuralComparison[] = [];
    for (const [lang, sample] of samples) {
      const ext = LANG_EXT[lang];
      if (!ext) continue;


      let kExtract;
      try {
        kExtract = await extractStructure(lang, sample);
      } catch {
        kExtract = null;
      }
      if (!kExtract) continue;
      const klauroPayload = JSON.stringify({
        functions: kExtract.functions,
        classes: kExtract.classes,
        calls: kExtract.calls,
        imports: kExtract.imports,
      });
      const klauro: CampBSide = {
        functions: kExtract.functions.length,
        classes: kExtract.classes.length,
        calls: kExtract.calls.length,
        imports: kExtract.imports.length,
        tokens: tokensOf(klauroPayload),
      };
      const fileName = `sample-${lang.replace(/[^A-Za-z0-9_-]+/g, '-')}.${ext}`;
      fs.writeFileSync(path.join(root, fileName), sample);
      pending.push({ lang, fileName, klauroExtract: kExtract, klauro });
    }

    const cbmByFile = cbmStructuralCorpus(bin, root);
    for (const comparison of pending) {
      const { lang, fileName, klauroExtract: kExtract, klauro } = comparison;
      const cbmCounts = cbmByFile.get(fileName) || unavailableCbmStructuralCounts();
      const cbm: CampBCbmSide = {
        functions: cbmCounts.functions,
        classes: cbmCounts.classes,
        tokens: cbmCounts.available ? tokensOf(cbmCounts.schemaRaw) : 0,
        available: cbmCounts.available,
      };

      const klauroFnNames = new Set<string>(kExtract.functions.map(f => f.name).filter(Boolean));
      const klauroClassNames = new Set<string>(kExtract.classes.map(c => c.name).filter(Boolean));
      const { verdict, note } = decideVerdict(lang, klauro, cbm, {
        klauroFnNames,
        klauroClassNames,
        cbmFnNames: cbmCounts.fnNames,
        cbmClassNames: cbmCounts.classNames,
      });
      rows.push({ lang, klauro, cbm, verdict, note });
    }
  } finally {
    daemon?.close();
    try {
      fs.removeSync(root);
    } catch {

    }
  }

  const languages = rows.length;
  const klauroWins = rows.filter(r => r.verdict === 'win').length;
  const ceilingTies = rows.filter(r => r.verdict === 'tie-ceiling').length;
  const losses = rows.filter(r => r.verdict === 'loss').length;
  const winRate = languages ? (klauroWins + ceilingTies) / languages : 0;
  const cbmAvail = rows.filter(r => r.cbm.available);
  const meanKlauroTokens = cbmAvail.length
    ? cbmAvail.reduce((a, r) => a + r.klauro.tokens, 0) / cbmAvail.length
    : 0;
  const meanCbmTokens = cbmAvail.length
    ? cbmAvail.reduce((a, r) => a + r.cbm.tokens, 0) / cbmAvail.length
    : 0;

  cached = {
    available: true,
    perLanguage: rows,
    aggregate: {
      languages,
      klauroWins,
      ceilingTies,
      losses,
      winRate,
      meanKlauroTokens,
      meanCbmTokens,
      tokenSavingMean: meanCbmTokens - meanKlauroTokens,
    },
  };
  return cached;
}


export function _resetCampBStructuralCache(): void {
  cached = null;
}
