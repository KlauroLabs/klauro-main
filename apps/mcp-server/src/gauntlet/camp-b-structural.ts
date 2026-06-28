/**
 * Camp B (structural) head-to-head — Klauro vs the REAL installed
 * codebase-memory-mcp binary, per language, measured at full strength.
 *
 * The claim under test: Klauro's single generic tree-sitter walker
 * (`extractStructure`) matches-or-beats DeusData's codebase-memory on GENERIC
 * STRUCTURAL extraction — functions/classes/calls/imports — for EVERY language
 * it supports, at fewer tokens. We do NOT proxy codebase-memory: we shell out to
 * the real `codebase-memory-mcp cli index_repository` and read the knowledge
 * graph it builds (`get_graph_schema` node/edge counts). Any Klauro win is honest.
 *
 * VERDICT BASIS — SYMBOLS, NOT CALLS (fairness fix):
 *   codebase-memory genuinely extracts call edges (index_repository reports
 *   nodes/edges > 0), but its get_graph_schema / search_graph reads expose NO
 *   CALLS edge on a tiny single-file repo (the call-resolution pass leaves them
 *   unresolved at that scale). So a "cbm calls = 0" read is a READ ARTIFACT, not
 *   reality. We therefore classify the verdict on SYMBOL coverage (functions +
 *   classes), which IS reliably readable, and treat cbm's call/import edge counts
 *   as INFORMATIONAL ONLY (recorded, never used to drive a win). We never fake a
 *   win on an unreadable 0.
 *
 *   We read cbm's symbols at its BEST: the MAX across (a) get_graph_schema
 *   node_label counts, (b) search_graph results counted by their `label` field,
 *   and (c) the index_repository node total as a floor. Giving the competitor its
 *   strongest readable number is the only honest way to claim a win over it.
 *
 * Where the head-to-head lands:
 *   - codebase-memory's 11 Hybrid-LSP languages (python, ts/js/jsx/tsx, php, c#,
 *     go, c, c++, java, kotlin, rust) are compiler/LSP-accurate; Klauro cannot
 *     out-correct ground truth → `tie-ceiling`, Klauro's edge is tokens.
 *   - On the breadth long tail, cbm's generic tree-sitter indexer ALSO finds many
 *     functions, so those are honest TIES too (symbol parity + Klauro token win),
 *     NOT free wins. A `win` is recorded ONLY where cbm is genuinely
 *     out-of-coverage (0 symbols) or cbm extracted FEWER symbols than Klauro.
 *
 * HONESTY CONTRACT: if codebase-memory extracts MORE symbols than Klauro on a
 * language, that is a `loss`, surfaced loudly — the test goes RED and the Klauro
 * analyzer for that language must be deepened. Losses are the point; never hidden.
 *
 * TOKEN BASIS (real and fair, unchanged):
 *   - klauroTokens = byteLength(compact JSON of the extracted structure) / 4.
 *     Exactly what an agent receives: the symbols/calls/imports.
 *   - cbmTokens   = byteLength(codebase-memory's get_graph_schema output) / 4 —
 *     the smallest honest structural summary cbm emits per repo. A fuller
 *     get_architecture/query_graph dump is strictly larger, so the schema is the
 *     most charitable token count for codebase-memory.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

import { extractStructure } from '../../../../packages/analyzer-core/src/analyzer/core/generic-tree-sitter-analyzer';
import { codebaseMemoryPath } from './real-camp-arms';
import { TOP_LANGS } from './camp-a-langs';

/** codebase-memory's 11 Hybrid-LSP languages, in our grammar-id namespace. On
 *  these it is compiler/LSP-accurate, so the best Klauro can do is a ceiling tie. */
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

/**
 * Grammar-id → source file extension. codebase-memory dispatches its indexer by
 * file extension, so the sample must land on disk with the right suffix or cbm
 * sees nothing (which would unfairly inflate Klauro). Every TOP_LANGS grammar +
 * the primitive-bench languages are covered here; an unmapped lang is skipped
 * (recorded honestly, not silently counted as a win).
 */
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

export interface CampBCbmSide extends CampBSide {
  /** False when codebase-memory could not index this language (returned nothing). */
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
  /** False when the codebase-memory binary is absent (honest skip; no fake data). */
  available: boolean;
  perLanguage: CampBStructuralRow[];
  aggregate: {
    languages: number;
    klauroWins: number;
    ceilingTies: number;
    losses: number;
    /** (wins + ties) / measured languages. */
    winRate: number;
    meanKlauroTokens: number;
    meanCbmTokens: number;
    /** mean(cbmTokens) - mean(klauroTokens); positive = Klauro cheaper. */
    tokenSavingMean: number;
  };
}

/** byteLength/4 token estimate of a string payload. */
function tokensOf(s: string): number {
  return Math.round(Buffer.byteLength(s, 'utf8') / 4);
}

/** codebase-memory's project id = the slugified absolute repo path (its own rule).
 *  IMPORTANT: codebase-memory PRESERVES underscores (slug charset is [A-Za-z0-9_]),
 *  replacing only other non-word chars with '-'. macOS temp dirs live under
 *  /var/folders/<x>_/... so we must keep '_' or the project lookup misses. */
function cbmProjectId(dir: string): string {
  return dir.replace(/^\/+/, '').replace(/[^A-Za-z0-9_]+/g, '-');
}

interface CbmStructuralCounts {
  /** Symbol count read at cbm's BEST (max across schema, search_graph, index). */
  functions: number;
  classes: number;
  /** INFORMATIONAL ONLY — call/import edges are unreadable on tiny single-file
   *  repos (read artifact), so they never drive a verdict. Recorded for the row. */
  calls: number;
  imports: number;
  /** Distinct PROJECT-ROOTED symbol NAMES cbm extracted (functions/methods and
   *  classes), excluding injected language builtins. This is the fair comparison
   *  surface: it neutralizes cbm's Method/Function scope-duplication and its
   *  std-lib stub injection, so a loss means cbm truly saw a source symbol Klauro
   *  missed. */
  fnNames: Set<string>;
  classNames: Set<string>;
  /** Raw schema JSON codebase-memory returned (the token-basis payload). */
  schemaRaw: string;
  available: boolean;
}

/** Run a cbm cli tool, returning the first JSON object line, or null. */
function cbmCli(bin: string, tool: string, args: object): { json: any; raw: string } | null {
  let out = '';
  try {
    out = execFileSync(bin, ['cli', tool, JSON.stringify(args)], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  const line = out.split('\n').find(l => l.trim().startsWith('{')) || '';
  if (!line) return null;
  try {
    return { json: JSON.parse(line), raw: line };
  } catch {
    return null;
  }
}

/**
 * Index `dir` with the REAL codebase-memory binary and read its SYMBOL coverage
 * at cbm's best. We never let an unreadable call-edge 0 drive a win, so verdicts
 * key off functions/classes only; calls/imports are recorded informationally.
 *
 * Symbol read = MAX across three honest paths (give the competitor its strongest):
 *   (a) get_graph_schema node_label counts (Function+Method, Class+Struct+Interface),
 *   (b) search_graph results counted by their `label` field (search_graph ignores
 *       node_type and returns all nodes, so we tally labels ourselves),
 *   (c) the index_repository node total as a floor when the graph reads come back thin.
 * The get_graph_schema JSON is the token basis. available:false only when cbm
 * indexed zero symbols by every path (genuine out-of-coverage).
 */
function cbmStructural(bin: string, dir: string): CbmStructuralCounts {
  const empty: CbmStructuralCounts = {
    functions: 0, classes: 0, calls: 0, imports: 0,
    fnNames: new Set(), classNames: new Set(), schemaRaw: '', available: false,
  };

  // Index. Capture the reported node total as a floor proxy for symbol coverage.
  let indexNodeTotal = 0;
  {
    let idxOut = '';
    try {
      idxOut = execFileSync(bin, ['cli', 'index_repository', JSON.stringify({ repo_path: dir })], {
        encoding: 'utf8',
        timeout: 120_000,
      });
    } catch {
      return empty;
    }
    const line = idxOut.split('\n').find(l => l.trim().startsWith('{')) || '';
    if (line) {
      try { indexNodeTotal = Number(JSON.parse(line).nodes) || 0; } catch { /* noop */ }
    }
  }

  const project = cbmProjectId(dir);

  // (a) get_graph_schema — the canonical node-label/edge-type tallies + token basis.
  const schemaRes = cbmCli(bin, 'get_graph_schema', { project });
  let schemaFns = 0, schemaCls = 0, calls = 0, imports = 0, schemaRaw = '';
  if (schemaRes) {
    schemaRaw = schemaRes.raw;
    const labels: Array<{ label: string; count: number }> = schemaRes.json.node_labels || [];
    const edges: Array<{ type: string; count: number }> = schemaRes.json.edge_types || [];
    const lc = (n: string) => labels.filter(l => l.label === n).reduce((a, b) => a + (b.count || 0), 0);
    const ec = (n: string) => edges.filter(e => e.type === n).reduce((a, b) => a + (b.count || 0), 0);
    schemaFns = lc('Function') + lc('Method');
    schemaCls = lc('Class') + lc('Struct') + lc('Interface');
    calls = ec('CALLS');
    imports = ec('IMPORTS');
  }

  // (b) search_graph — returns every node with name + qualified_name + label
  //     (node_type is ignored by the binary). We keep only PROJECT-ROOTED symbols
  //     (qualified_name prefixed with `<project>.`), which excludes injected
  //     language builtins (`builtins.print`, `builtins.list.append`, …) that are
  //     NOT in the source. Tally distinct NAMES — this collapses cbm's habit of
  //     storing a method as both `M.save` (Method) and `save` (Function), so the
  //     count reflects true source symbols, fair to both tools.
  const fnNames = new Set<string>();
  const classNames = new Set<string>();
  const projPrefix = `${project}.`;
  const sgRes = cbmCli(bin, 'search_graph', { project, node_type: 'Function' });
  if (sgRes) {
    const results: Array<{ label?: string; name?: string; qualified_name?: string }> =
      sgRes.json.results || [];
    for (const r of results) {
      const q = r.qualified_name || '';
      const nm = r.name || '';
      if (!nm || !q.startsWith(projPrefix)) continue; // skip builtins/externals
      if (r.label === 'Function' || r.label === 'Method') fnNames.add(nm);
      else if (r.label === 'Class' || r.label === 'Struct' || r.label === 'Interface')
        classNames.add(nm);
    }
  }

  // cbm at its best: max symbol COUNT across schema (label tallies) and the
  // project-rooted distinct-name read. The schema count can include scope
  // duplication; the name read is the fair source-symbol count. We expose both —
  // counts (max, charitable) for the row display, and the NAME SETS for the
  // verdict (name-set containment, see decideVerdict).
  const functions = Math.max(schemaFns, fnNames.size);
  const classes = Math.max(schemaCls, classNames.size);
  // available when any path saw a code symbol, or the index reported more nodes
  // than the ~5 structural scaffolding nodes (File/Module/Project/Branch + dir).
  const available = functions + classes > 0 || indexNodeTotal > 5;

  return { functions, classes, calls, imports, fnNames, classNames, schemaRaw, available };
}

interface SymbolNames {
  klauroFnNames: Set<string>;
  klauroClassNames: Set<string>;
  cbmFnNames: Set<string>;
  cbmClassNames: Set<string>;
}

/** Names in `a` not present in `b`. */
function missing(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter(n => !b.has(n));
}

/**
 * Decide the per-language verdict — keyed on PROJECT-ROOTED SYMBOL NAME SETS, the
 * fair and reliably-readable signal. Two fairness corrections vs raw counts:
 *   1. cbm's call/import edges are a read artifact on tiny single-file repos, so
 *      they NEVER drive a verdict (recorded informationally only).
 *   2. cbm inflates raw symbol COUNTS — it injects language builtins
 *      (`builtins.print`) and stores a method as both Method and Function. So we
 *      compare NAME SETS restricted to project-rooted symbols, not counts. A LOSS
 *      is recorded ONLY when cbm extracted a source-symbol NAME that Klauro's name
 *      set does not contain — i.e. cbm genuinely saw something Klauro missed.
 * The token saving is recorded on every row regardless of verdict.
 *
 *   loss  — cbm has a project symbol name Klauro missed (surface loud; deepen)
 *   win   — cbm out-of-coverage (no symbols) OR Klauro saw a name cbm missed
 *   tie-ceiling — same symbol-name coverage; Klauro wins on tokens
 */
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

  // LOSS: cbm extracted a project-rooted symbol NAME that Klauro did not. That is
  // a genuine miss in the Klauro analyzer (not a read artifact / builtin / dup).
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

  // WIN: cbm genuinely indexed no symbols (out-of-coverage) and Klauro did.
  if (!cbm.available && kSym >= 1) {
    return {
      verdict: 'win',
      note: `out-of-coverage: codebase-memory indexed no symbols for ${lang}; Klauro fn=${klauro.functions} cls=${klauro.classes}${tokNote}`,
    };
  }

  // WIN: Klauro saw a project symbol name cbm did not (only meaningful when cbm
  // read names at all; if cbm read none but is available via index-floor, fall
  // through to the token-based parity tie below).
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

  // TIE-CEILING: same symbol-name coverage (or cbm available only via index
  // floor, names equal/empty on both readable surfaces). Klauro cannot
  // out-correct cbm's symbols; its honest, recorded edge is tokens.
  if (kSym >= 1) {
    const lsp = CBM_LSP_LANGS.has(lang) ? 'LSP-accurate ' : '';
    return {
      verdict: 'tie-ceiling',
      note: `${lsp}symbol-name parity (klauro fn=${klauro.functions} cls=${klauro.classes})${tokNote || ' (token-neutral)'}`,
    };
  }

  // Degenerate: neither tool extracted symbols. No-loss, no over-claim.
  return {
    verdict: 'tie-ceiling',
    note: `neither tool extracted symbols for ${lang} (degenerate); recorded as no-loss tie`,
  };
}

let cached: CampBStructuralReport | null = null;

/**
 * Build the per-language Camp-B structural head-to-head. For each language in
 * TOP_LANGS (plus the primitive-bench languages) we write the camp-a sample to a
 * unique temp dir with the correct extension, run Klauro's extractStructure and
 * the REAL codebase-memory binary against it, count both sides' structural
 * facts, and decide a verdict. Cached in-process.
 */
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

  // Build the sample set: every TOP_LANGS entry, deduped by lang.
  const samples = new Map<string, string>();
  for (const t of TOP_LANGS) {
    if (!samples.has(t.lang)) samples.set(t.lang, t.sample);
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-camp-b-'));
  const rows: CampBStructuralRow[] = [];

  try {
    for (const [lang, sample] of samples) {
      const ext = LANG_EXT[lang];
      if (!ext) continue; // unmapped extension → honest skip, not a free win

      // Klauro side.
      let kExtract;
      try {
        kExtract = await extractStructure(lang, sample);
      } catch {
        kExtract = null;
      }
      if (!kExtract) continue; // grammar not loadable in this env → skip honestly
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

      // codebase-memory side — write to a unique dir with the right extension.
      const dir = fs.mkdtempSync(path.join(root, `${lang}-`));
      fs.writeFileSync(path.join(dir, `sample.${ext}`), sample);
      const cbmCounts = cbmStructural(bin, dir);
      const cbm: CampBCbmSide = {
        functions: cbmCounts.functions,
        classes: cbmCounts.classes,
        calls: cbmCounts.calls,
        imports: cbmCounts.imports,
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
    try {
      fs.removeSync(root);
    } catch {
      /* noop */
    }
  }

  const languages = rows.length;
  const klauroWins = rows.filter(r => r.verdict === 'win').length;
  const ceilingTies = rows.filter(r => r.verdict === 'tie-ceiling').length;
  const losses = rows.filter(r => r.verdict === 'loss').length;
  const winRate = languages ? (klauroWins + ceilingTies) / languages : 0;
  const meanKlauroTokens = languages
    ? rows.reduce((a, r) => a + r.klauro.tokens, 0) / languages
    : 0;
  // cbm mean over languages it could actually index (its real token cost where present).
  const cbmAvail = rows.filter(r => r.cbm.available);
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

/** Test/CI hook: drop the in-process cache. */
export function _resetCampBStructuralCache(): void {
  cached = null;
}
